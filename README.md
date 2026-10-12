# こえメモ（音声入力メモ PWA）

iPhone で話した内容を文字にして保存し、質問には AI が裏で回答しておくメモアプリです。
同じメモをパソコンのブラウザからも見たり書いたりできます。

## できること

| 機能 | 内容 |
|---|---|
| 音声 → 文字 | マイクボタンで話すと文字起こしします。止めると自動保存（メニューでオフにできます） |
| AI の回答 | 質問を含むメモには、AI（Claude）が自動で回答を付けます |
| 日付・時刻 | 作成日時を自動で記録し、日付ごとに並べます |
| あいまい検索 | ひらがな/カタカナ、全角/半角、打ち間違いを吸収します。AI が付けた読み仮名や同義語でも見つかります（例: 「かいぎ」で「会議」が見つかる） |
| 同期 | iPhone と PC でリアルタイムに同期します（Supabase） |
| 自動タグ・要約 | AI がタグと 1 行要約を付けます。タグを押すと絞り込めます |
| ToDo 抽出 | 「明日までに〜する」などを ToDo タブに集め、期限も読み取ります |
| オフライン | 電波がなくても記録でき、つながったら同期と AI 解析を行います |
| ピン留め・書き出し | 大事なメモを上に固定。Markdown / CSV / JSON で書き出し |

## 構成

```
index.html / styles.css / app.js   … アプリ本体（ビルド不要）
config.js                          … Supabase の接続情報（ここだけ書き換える）
sw.js / manifest.webmanifest       … オフライン対応・ホーム画面追加用
icons/                             … アイコン
supabase/schema.sql                … データベースの表を作る SQL
supabase/functions/ai-memo/        … AI 解析のサーバー処理（Claude API を呼ぶ）
```

Claude の API キー（利用料の請求につながる秘密の鍵）は Supabase のサーバー側にだけ保存し、アプリには書き込みません。

---

## セットアップ手順

`config.js` が空のままでも「ローカルモード」で動きます（この端末だけに保存、同期・AI なし）。
同期と AI を使うには、以下の 1〜5 を行ってください。

### 1. Supabase のプロジェクトを作る（無料）

1. https://supabase.com でアカウントを作り、「New project」を作成（リージョンは Tokyo がおすすめ）
2. 左メニュー **SQL Editor** を開き、`supabase/schema.sql` の中身を貼り付けて **Run**

### 2. AI 解析の関数を登録する

1. https://console.anthropic.com で API キーを発行
2. Supabase の左メニュー **Edge Functions** → **Secrets** で次を追加
   - `ANTHROPIC_API_KEY` = 発行したキー
   - （任意）`ALLOWED_EMAILS` = 自分のメールアドレス（AI を使える人を限定します）
3. **Edge Functions** → **Deploy a new function** → **Via Editor**
   - 関数名：`ai-memo`
   - `supabase/functions/ai-memo/index.ts` の中身を貼り付けて **Deploy**

> コマンドで行う場合（Node.js が必要）:
> ```bash
> npx supabase login
> npx supabase link --project-ref <プロジェクトID>
> npx supabase secrets set ANTHROPIC_API_KEY=<キー>
> npx supabase functions deploy ai-memo
> ```

### 3. `config.js` を書き換える

Supabase の **Project Settings** → **API**（または **Data API**）にある値を貼り付けます。

```js
export const SUPABASE_URL = "https://xxxxxxxx.supabase.co";
export const SUPABASE_ANON_KEY = "eyJ...（anon / publishable key）";
```

anon key は公開されても問題ない鍵です。データは行レベルセキュリティ（ログインした本人しか自分の行を読み書きできない仕組み）で守られます。
**service_role key は絶対に貼らないでください。**

### 4. インターネットに公開する（GitHub Pages の例）

マイクは HTTPS（暗号化された通信）のページでしか使えないため、公開が必要です。

1. GitHub で新しいリポジトリを作り、このフォルダのファイルをすべてアップロード
2. リポジトリの **Settings** → **Pages** → Branch を `main` / `/(root)` にして保存
3. 数分後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で開けます
4. Supabase の **Authentication** → **URL Configuration** の **Site URL** にこの URL を設定
   （登録確認メールのリンク先になります）

Netlify や Cloudflare Pages に、フォルダをドラッグ＆ドロップして公開することもできます。

### 5. アカウントを作る

1. 公開した URL を開き、右上の「⋯」→ メールアドレスとパスワードで **新規登録**
2. 届いた確認メールのリンクを開き、アプリに戻って **ログイン**
3. 自分のアカウントができたら、Supabase の **Authentication** → **Sign In / Providers** で
   **Allow new users to sign up** をオフにします（他人が登録して AI を使うのを防ぐため）

---

## 使い方

### iPhone
1. Safari で公開 URL を開く → 共有ボタン → **ホーム画面に追加**
2. ホーム画面のアイコンから起動し、「⋯」からログイン
3. マイクボタンを押して話す → もう一度押すと停止して保存
   - 初回はマイクと音声認識の許可を求められます
   - マイクボタンが使えない場合は、入力欄をタップしてキーボードのマイク（音声入力）でも話せます

### パソコン
- Chrome / Edge で同じ URL を開いてログイン
- 入力欄に書いて **保存**（Ctrl + Enter でも保存できます）
- ✏️ で編集・削除。編集すると AI が再解析します

### 検索のコツ
- スペースで区切ると「すべて含む」検索になります（例: `牛乳 卵`）
- 日付でも検索できます（例: `10月12日`）

---

## リマインダー通知とショートカット

### 準備（Supabase）
1. SQL Editor で `supabase/reminders.sql` を実行
2. Edge Functions → Secrets に `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `CRON_SECRET` を追加
   （VAPID 鍵は Node.js の `crypto.createECDH("prime256v1")` などで作成。公開鍵は `config.js` にも書く）
3. `ai-memo` 関数のコードを最新の `index.ts` に差し替えて再デプロイ
4. SQL Editor で次を実行し、5 分おきに期限を確認させる（`<CRON_SECRET>` は 2 と同じ値）
   ```sql
   select cron.schedule('koememo-reminders', '*/5 * * * *', $$
     select net.http_post(
       url := 'https://<プロジェクトID>.supabase.co/functions/v1/ai-memo',
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
       body := '{}'::jsonb);
   $$);
   ```

### 通知をオンにする（iPhone）
ホーム画面のアプリで「⋯」→「この端末で通知をオンにする」→ 許可。「テスト通知」で届くか確認できます。
時刻のある ToDo は 30 分前、日付だけの ToDo は当日朝 8 時に通知されます（`index.ts` の `LEAD_MINUTES` / `DATE_ONLY_TIME` で変更可）。

### ロック画面から話して追加（ショートカット）
1. アプリの「⋯」→「鍵を発行する」で鍵をコピー
2. 「ショートカット」アプリで新規作成し、次のアクションを並べる
   - 「音声入力」（言語: 日本語）
   - 「URLの内容を取得」: URL は `https://<プロジェクトID>.supabase.co/functions/v1/ai-memo`、
     方法 POST、ヘッダ `x-koememo-token` = 鍵、本文 JSON で `text` = 音声入力したテキスト
   - 「結果を表示」
3. ロック画面を長押し →「カスタマイズ」→ 下のボタンに「ショートカット」を設定（iOS 18 以降）
   コントロールセンターやアクションボタンにも置けます

---

## 費用の目安

- Supabase・GitHub Pages：個人利用なら無料枠で収まります
- Claude API：使った分だけの前払い制（月額料金なし）。モデル Claude Haiku 5.5 で、メモ 1 件の解析は約 0.1 円以下
  （1 日 10 件で月 30 円程度）。使いすぎが心配なら、Anthropic Console で月の利用上限を設定してください
- 難しい質問にもっと賢く答えてほしい場合は、`supabase/functions/ai-memo/index.ts` の
  `model` を `"claude-opus-5-5"` に変えて再デプロイします（1 件あたり約 2〜5 円）

## 注意

- メモの本文は AI 解析のため Anthropic（Claude）に送信されます
- 音声認識は端末・ブラウザの機能を使います（iPhone の場合は Apple のサーバーで処理されることがあります）
- 同期は「最後に更新した方が優先」です。2 台で同じメモを同時に編集すると、後の編集が残ります
- アプリを更新したときは `sw.js` の `VERSION` を変えると、各端末に確実に反映されます
