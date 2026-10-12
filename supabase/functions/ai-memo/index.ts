// こえメモのサーバー処理（Supabase Edge Function）
// 1つの関数で次の4つを受け持ちます。
//   1. メモの AI 解析（アプリから。ログイン必須）
//   2. テスト通知（アプリから。ログイン必須）
//   3. ショートカットからのメモ追加（x-koememo-token ヘッダー）
//   4. ToDo 期限の確認と通知送信（pg_cron から。x-cron-secret ヘッダー）
// 必要なシークレット: ANTHROPIC_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, CRON_SECRET
// 任意: ALLOWED_EMAILS（カンマ区切り。AI を使えるメールアドレス）
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

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
const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } });

const APP_URL = "https://shin-shincreate.github.io/koememo/";
// 通知のタイミング：時刻ありは何分前か／日付のみは当日何時か（日本時間）
const LEAD_MINUTES = 30;
const DATE_ONLY_TIME = "08:00";

// シークレットを読む（貼り付け時に入りがちな前後の空白・改行を除く）
const env = (name: string) => (Deno.env.get(name) ?? "").trim();

const admin = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// ---------- AI 解析 ----------
const SYSTEM = `あなたは音声メモアプリのアシスタントです。ユーザーが話した内容（音声認識の誤変換を含むことがあります）を受け取り、次を日本語で作成します。

- is_question: メモの中にユーザーが答えを知りたい質問や調べものが含まれていれば true。単なる記録・予定・感想なら false。
- answer: is_question が true のとき、その質問への回答。結論を先に、簡潔かつ具体的に。確実でない情報や最新情報が必要な内容はその旨を添える。false のときは空文字。
- summary: メモの内容を表す40字以内の1行要約。
- tags: 内容を分類するタグを1〜3個（例: 仕事, 買い物, アイデア, 健康）。短い名詞で。
- keywords: あとで検索しやすくするための語を5〜10個。メモ中の漢字語のひらがな読み、言い換え・同義語、関連語を含める。
- todos: メモから読み取れる「やること」。text は動詞で終わる短い文。期限の日付が分かれば due に YYYY-MM-DD（「明日」「来週月曜」などは記録日時から計算）、分からなければ空文字。時刻が分かれば time に HH:MM（24時間制）、分からなければ空文字。なければ空配列。

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
        properties: { text: { type: "string" }, due: { type: "string" }, time: { type: "string" } },
        required: ["text", "due", "time"],
        additionalProperties: false,
      },
    },
  },
  required: ["is_question", "answer", "summary", "tags", "keywords", "todos"],
  additionalProperties: false,
};

type Todo = { text: string; due: string; time?: string; done?: boolean };
type Analysis = {
  is_question: boolean; answer: string; summary: string;
  tags: string[]; keywords: string[]; todos: Todo[];
};

class UserError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

const anthropic = new Anthropic(); // ANTHROPIC_API_KEY を環境変数から読む

async function analyze(memoText: string, createdAt: string): Promise<Analysis> {
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
        content: `記録日時: ${recordedAt}（日本時間）\n\n<memo>\n${memoText}\n</memo>`,
      }],
    });
    if (response.stop_reason === "refusal") throw new UserError("AIがこの内容への回答を控えました", 422);
    if (response.stop_reason === "max_tokens") throw new UserError("回答が長すぎて途中で切れました", 502);
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new UserError("AIの応答が空でした", 502);
    return JSON.parse(block.text);
  } catch (e) {
    if (e instanceof UserError) throw e;
    if (e instanceof Anthropic.RateLimitError) throw new UserError("混み合っています。しばらくして再試行してください", 429);
    if (e instanceof Anthropic.AuthenticationError) throw new UserError("ANTHROPIC_API_KEY が正しくありません", 500);
    if (e instanceof Anthropic.APIError) throw new UserError(`AI API エラー (${e.status})`, 502);
    console.error(e);
    throw new UserError("AI解析中にエラーが発生しました", 500);
  }
}

function emailAllowed(email: string | undefined) {
  const allowed = env("ALLOWED_EMAILS")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return !allowed.length || allowed.includes((email ?? "").toLowerCase());
}

// ---------- プッシュ通知 ----------
// 鍵に問題があっても関数全体は止めず、通知のときにエラー内容を返す
let vapidError = "";
if (!env("VAPID_PUBLIC_KEY") || !env("VAPID_PRIVATE_KEY")) {
  vapidError = "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY が未設定です";
} else {
  try {
    webpush.setVapidDetails(APP_URL, env("VAPID_PUBLIC_KEY"), env("VAPID_PRIVATE_KEY"));
  } catch (e) {
    vapidError = `VAPID 鍵が正しくありません: ${(e as Error).message}`;
    console.error(vapidError);
  }
}

// ユーザーの全端末に送る。期限切れの登録は削除する。送れた件数を返す
async function pushToUser(userId: string, payload: { title: string; body: string; url?: string }) {
  if (vapidError) throw new UserError(vapidError, 500);
  const db = admin();
  const { data: subs } = await db.from("push_subscriptions").select("*").eq("user_id", userId);
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 6 },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      else console.error("push failed", code, e);
    }
  }
  return sent;
}

// 通知する時刻（UTC ミリ秒）
function reminderAt(t: Todo) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.due)) return null;
  const hasTime = /^\d{2}:\d{2}$/.test(t.time ?? "");
  const at = Date.parse(`${t.due}T${hasTime ? t.time : DATE_ONLY_TIME}:00+09:00`);
  return Number.isNaN(at) ? null : at - (hasTime ? LEAD_MINUTES * 60_000 : 0);
}

async function sendReminders() {
  const db = admin();
  const { data: memos, error } = await db.from("memos")
    .select("id, user_id, todos").eq("deleted", false).limit(10000);
  if (error) throw error;

  const now = Date.now();
  const due: { key: string; userId: string; todo: Todo }[] = [];
  for (const m of memos ?? []) {
    for (const t of (m.todos ?? []) as Todo[]) {
      if (t.done) continue;
      const at = reminderAt(t);
      // 通知時刻を過ぎて 6 時間以内のものだけ（古い ToDo を一斉に通知しない）
      if (at === null || at > now || now - at > 6 * 3600_000) continue;
      due.push({ key: `${m.id}|${t.text}|${t.due}|${t.time ?? ""}`, userId: m.user_id, todo: t });
    }
  }
  if (!due.length) return { checked: memos?.length ?? 0, sent: 0 };

  const { data: already } = await db.from("reminders_sent").select("key").in("key", due.map((d) => d.key));
  const sentKeys = new Set((already ?? []).map((r) => r.key));
  let sent = 0;
  for (const d of due) {
    if (sentKeys.has(d.key)) continue;
    const when = d.todo.time ? `${d.todo.due} ${d.todo.time}` : d.todo.due;
    await pushToUser(d.userId, { title: "⏰ ToDo のお知らせ", body: `${d.todo.text}（${when}）`, url: "./?view=todos" });
    await db.from("reminders_sent").insert({ key: d.key });
    sent++;
  }
  return { checked: memos?.length ?? 0, sent };
}

// ---------- ショートカットからの追加 ----------
async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function quickAdd(req: Request, token: string) {
  const db = admin();
  const { data: row } = await db.from("quick_tokens").select("user_id")
    .eq("token_hash", await sha256Hex(token)).maybeSingle();
  if (!row) return text("鍵が正しくありません。アプリのメニューで発行し直してください", 401);

  const raw = await req.text();
  let memoText = raw;
  try { memoText = JSON.parse(raw).text ?? ""; } catch { /* プレーンテキストとして扱う */ }
  memoText = String(memoText).trim().slice(0, 8000);
  if (!memoText) return text("内容が空でした", 400);

  const now = new Date().toISOString();
  const memo: Record<string, unknown> = {
    id: crypto.randomUUID(), user_id: row.user_id, text: memoText,
    created_at: now, updated_at: now, ai_status: "pending",
  };
  let reply = "📝 保存しました";
  try {
    const a = await analyze(memoText, now);
    Object.assign(memo, {
      ai_status: "done", is_question: a.is_question, answer: a.answer, summary: a.summary,
      tags: a.tags, keywords: a.keywords, todos: a.todos.map((t) => ({ ...t, done: false })),
    });
    if (a.is_question && a.answer) reply += `\n\n🤖 ${a.answer}`;
    if (a.todos.length) {
      reply += "\n\n" + a.todos.map((t) => `☐ ${t.text}${t.due ? `（${t.due}${t.time ? " " + t.time : ""}）` : ""}`).join("\n");
    }
  } catch (e) {
    // AI が失敗しても保存はする（アプリを開いたときに再解析される）
    reply += "（AI解析はあとで行います）";
    console.error(e);
  }
  const { error } = await db.from("memos").insert(memo);
  if (error) {
    console.error(error);
    return text("保存に失敗しました", 500);
  }
  return text(reply);
}

// ---------- 入口 ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // pg_cron からの定期実行
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret !== null) {
    if (!env("CRON_SECRET") || cronSecret.trim() !== env("CRON_SECRET")) return json({ error: "forbidden" }, 403);
    try {
      if (vapidError) return json({ error: vapidError }, 500);
      return json(await sendReminders());
    } catch (e) {
      console.error(e);
      return json({ error: "reminder failed" }, 500);
    }
  }

  // ショートカットからの追加
  const quickToken = req.headers.get("x-koememo-token");
  if (quickToken !== null) return quickAdd(req, quickToken);

  // アプリから（ログイン中のユーザーか確認。anon key だけでは使えない）
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "ログインが必要です" }, 401);
  if (!emailAllowed(user.email)) return json({ error: "このアカウントではAIを使えません" }, 403);

  let body: { action?: string; text?: string; created_at?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "リクエストが不正です" }, 400);
  }

  if (body.action === "test-push") {
    try {
      const sent = await pushToUser(user.id, { title: "🔔 こえメモ", body: "通知のテストです。届いていれば設定完了です。" });
      return sent ? json({ sent }) : json({ error: "通知を送れる端末が登録されていません" }, 404);
    } catch (e) {
      if (e instanceof UserError) return json({ error: e.message }, e.status);
      throw e;
    }
  }

  const memoText = String(body.text ?? "").slice(0, 8000);
  if (!memoText.trim()) return json({ error: "本文が空です" }, 400);
  try {
    return json(await analyze(memoText, String(body.created_at ?? new Date().toISOString())));
  } catch (e) {
    if (e instanceof UserError) return json({ error: e.message }, e.status);
    throw e;
  }
});
