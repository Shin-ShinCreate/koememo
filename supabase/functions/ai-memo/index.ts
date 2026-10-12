// こえメモの AI 解析（Supabase Edge Function）
// メモ本文を受け取り、質問なら回答を作り、要約・タグ・検索用キーワード・ToDo を返します。
// 必要なシークレット: ANTHROPIC_API_KEY（任意: ALLOWED_EMAILS=カンマ区切りの許可メール）
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const SYSTEM = `あなたは音声メモアプリのアシスタントです。ユーザーが話した内容（音声認識の誤変換を含むことがあります）を受け取り、次を日本語で作成します。

- is_question: メモの中にユーザーが答えを知りたい質問や調べものが含まれていれば true。単なる記録・予定・感想なら false。
- answer: is_question が true のとき、その質問への回答。結論を先に、簡潔かつ具体的に。確実でない情報や最新情報が必要な内容はその旨を添える。false のときは空文字。
- summary: メモの内容を表す40字以内の1行要約。
- tags: 内容を分類するタグを1〜3個（例: 仕事, 買い物, アイデア, 健康）。短い名詞で。
- keywords: あとで検索しやすくするための語を5〜10個。メモ中の漢字語のひらがな読み、言い換え・同義語、関連語を含める。
- todos: メモから読み取れる「やること」。text は動詞で終わる短い文。期限が分かれば due に YYYY-MM-DD（「明日」「来週月曜」などは記録日時から計算）、分からなければ空文字。なければ空配列。

音声認識の誤変換と思われる部分は、文脈から自然に解釈してください。`;

const SCHEMA = {
  type: "object",
  properties: {
    is_question: { type: "boolean" },
    answer: { type: "string" },
    summary: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    keywords: { type: "array", items: { type: "string" } },
    todos: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, due: { type: "string" } },
        required: ["text", "due"],
        additionalProperties: false,
      },
    },
  },
  required: ["is_question", "answer", "summary", "tags", "keywords", "todos"],
  additionalProperties: false,
};

const anthropic = new Anthropic(); // ANTHROPIC_API_KEY を環境変数から読む

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // ログイン中のユーザーか確認（anon key だけでは使えないようにする）
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "ログインが必要です" }, 401);

  const allowed = (Deno.env.get("ALLOWED_EMAILS") ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes((user.email ?? "").toLowerCase())) {
    return json({ error: "このアカウントではAIを使えません" }, 403);
  }

  let text = "", createdAt = "";
  try {
    const body = await req.json();
    text = String(body.text ?? "").slice(0, 8000);
    createdAt = String(body.created_at ?? new Date().toISOString());
  } catch {
    return json({ error: "リクエストが不正です" }, 400);
  }
  if (!text.trim()) return json({ error: "本文が空です" }, 400);

  const recordedAt = new Date(createdAt).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    hour: "2-digit", minute: "2-digit",
  });

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-5-5", // 低コストモデル（より賢い回答が必要なら "claude-opus-5-5"）
      max_tokens: 16000,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: SCHEMA },
      },
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `記録日時: ${recordedAt}（日本時間）\n\n<memo>\n${text}\n</memo>`,
      }],
    });

    if (response.stop_reason === "refusal") {
      return json({ error: "AIがこの内容への回答を控えました" }, 422);
    }
    if (response.stop_reason === "max_tokens") {
      return json({ error: "回答が長すぎて途中で切れました" }, 502);
    }
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return json({ error: "AIの応答が空でした" }, 502);
    return json(JSON.parse(block.text));
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "混み合っています。しばらくして再試行してください" }, 429);
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "ANTHROPIC_API_KEY が正しくありません" }, 500);
    if (e instanceof Anthropic.APIError) return json({ error: `AI API エラー (${e.status})` }, 502);
    console.error(e);
    return json({ error: "AI解析中にエラーが発生しました" }, 500);
  }
});
