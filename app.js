import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY } from "./config.js";
import Fuse from "https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.mjs";

// ---------- Supabase（設定があるときだけ有効） ----------
let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  try {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    console.warn("Supabase を読み込めませんでした（オフライン？）", e);
  }
}
let session = null;

// ---------- ローカル保存 ----------
const LS_MEMOS = "koememo.memos.v1";
const LS_CURSOR = "koememo.cursor.v1";
const LS_AUTOSAVE = "koememo.autosave";
const LS_FONT_SCALE = "koememo.fontScale";

// メモの文字の大きさ（端末ごとに保存。0.85 / 1 / 1.2 / 1.4）
function applyFontScale(scale) {
  document.documentElement.style.setProperty("--memo-scale", scale);
  document.querySelectorAll("#fontSizeSeg button").forEach((b) =>
    b.classList.toggle("on", Number(b.dataset.scale) === Number(scale)));
}
applyFontScale(localStorage.getItem(LS_FONT_SCALE) || "1");
document.querySelectorAll("#fontSizeSeg button").forEach((b) => b.addEventListener("click", () => {
  localStorage.setItem(LS_FONT_SCALE, b.dataset.scale);
  applyFontScale(b.dataset.scale);
}));

let memos = loadMemos();

function loadMemos() {
  try { return JSON.parse(localStorage.getItem(LS_MEMOS)) || {}; } catch { return {}; }
}
function persist() {
  localStorage.setItem(LS_MEMOS, JSON.stringify(memos));
}

function newMemo(text) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    text,
    created_at: now,
    updated_at: now,
    pinned: false,
    deleted: false,
    ai_status: "pending",
    ai_error: null,
    is_question: false,
    answer: "",
    summary: "",
    tags: [],
    keywords: [],
    todos: [],
    expenses: null, // null = まだ金額を読み取っていない
    thread: [], // AI との続きの会話 [{ q, a, at }]
    photos: [], // 写真の保存場所（Supabase Storage の photos の中のパス）
    deleted_at: null, // ゴミ箱に入れた日時（deleted が true のとき）
    purged: false, // 完全に削除した
  };
}

// 変更を記録して保存・再描画・同期予約
function touch(m) {
  m.updated_at = new Date().toISOString();
  m._dirty = true;
  memos[m.id] = m;
  persist();
  render();
  scheduleSync();
}

const COLUMNS = ["id", "text", "created_at", "updated_at", "pinned", "deleted", "ai_status", "ai_error",
  "is_question", "answer", "summary", "tags", "keywords", "todos", "expenses", "thread",
  "photos", "deleted_at", "purged"];

// サーバーで「空にしてはいけない」欄の初期値。古い版で作ったメモは、あとから増えた欄の値を持っていないので補う
const ROW_DEFAULTS = {
  text: "", pinned: false, deleted: false, ai_status: "pending", is_question: false,
  answer: "", summary: "", tags: [], keywords: [], todos: [], thread: [], photos: [], purged: false,
};

function toRow(m) {
  const row = {};
  for (const k of COLUMNS) row[k] = m[k] ?? ROW_DEFAULTS[k] ?? null;
  return row;
}
function fromRow(r) {
  const m = {};
  for (const k of COLUMNS) m[k] = r[k];
  m.created_at = new Date(r.created_at).toISOString();
  m.updated_at = new Date(r.updated_at).toISOString();
  m.tags ||= []; m.keywords ||= []; m.todos ||= [];
  m.text ||= ""; m.answer ||= ""; m.summary ||= "";
  m.expenses ??= null;
  m.thread ||= [];
  m.photos ||= [];
  m.deleted_at ??= null;
  m.purged = !!m.purged;
  return m;
}

// サーバー側が新しければ取り込む（最終更新が勝つ方式）
function mergeRemote(row) {
  const local = memos[row.id];
  if (!local || Date.parse(row.updated_at) > Date.parse(local.updated_at)) {
    memos[row.id] = fromRow(row);
    return true;
  }
  return false;
}

// ---------- 同期 ----------
let syncing = false, syncAgain = false, syncTimer = null, realtimeChannel = null, lastSyncError = "";

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, 800);
}

async function sync() {
  if (!supabase || !session || !navigator.onLine) { updateStatus(); return; }
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setStatus("同期中…");
  try {
    // 1) 取得：前回以降にサーバーで更新された行
    let cursor = localStorage.getItem(LS_CURSOR) || "1970-01-01T00:00:00Z";
    let changed = false;
    for (;;) {
      const { data, error } = await supabase.from("memos").select("*")
        .gt("server_updated_at", cursor).order("server_updated_at").limit(500);
      if (error) throw error;
      for (const row of data) changed = mergeRemote(row) || changed;
      if (data.length) cursor = data[data.length - 1].server_updated_at;
      if (data.length < 500) break;
    }
    localStorage.setItem(LS_CURSOR, cursor);

    // 2) 送信：この端末で変更したメモ
    const dirty = Object.values(memos).filter((m) => m._dirty);
    if (dirty.length) {
      const snapshot = dirty.map((m) => [m.id, m.updated_at]);
      const { error } = await supabase.from("memos").upsert(dirty.map(toRow));
      if (error) throw error;
      for (const [id, ts] of snapshot) {
        if (memos[id]?.updated_at === ts) delete memos[id]._dirty; // 送信中に再編集されたものは残す
      }
      changed = true;
    }
    if (changed) { persist(); render(); }
    setStatus("同期済み", "ok");
    lastSyncError = "";
  } catch (e) {
    console.error(e);
    setStatus("同期エラー", "warn");
    // 原因がわかるように、同じエラーは1回だけ画面に出す
    const msg = e?.message || String(e);
    if (msg !== lastSyncError) toast("同期エラー: " + msg, 8000);
    lastSyncError = msg;
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; sync(); }
  }
  processAI();
}

function startRealtime() {
  if (!supabase || realtimeChannel) return;
  realtimeChannel = supabase.channel("memos-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "memos" }, (payload) => {
      if (payload.new?.id && mergeRemote(payload.new)) { persist(); render(); }
    })
    .subscribe();
}
function stopRealtime() {
  if (realtimeChannel) { supabase.removeChannel(realtimeChannel); realtimeChannel = null; }
}

// ---------- AI 解析（質問への回答・要約・タグ・ToDo） ----------
let aiRunning = false;

async function processAI() {
  if (!supabase || !session || !navigator.onLine || aiRunning) return;
  aiRunning = true;
  try {
    const targets = Object.values(memos)
      .filter((m) => !m.deleted && m.ai_status === "pending" && m.text.trim());
    for (const m of targets) {
      const textAtStart = m.text;
      const { data, error } = await supabase.functions.invoke("ai-memo", {
        body: { text: m.text, created_at: m.created_at, photo_path: (m.photos || [])[0] || "" },
      });
      const cur = memos[m.id];
      if (!cur || cur.text !== textAtStart) continue; // 解析中に編集された
      if (error) {
        if (error.name === "FunctionsFetchError") break; // 通信エラーは pending のまま後で再試行
        cur.ai_status = "error";
        cur.ai_error = await errorMessage(error);
      } else {
        cur.ai_status = "done";
        cur.ai_error = null;
        cur.is_question = !!data.is_question;
        cur.answer = data.answer || "";
        cur.summary = data.summary || "";
        cur.tags = data.tags || [];
        cur.keywords = data.keywords || [];
        cur.todos = mergeTodos(cur.todos, data.todos || []);
        cur.expenses = data.expenses || [];
      }
      touch(cur);
    }
  } finally {
    aiRunning = false;
  }
}

async function errorMessage(error) {
  try {
    const body = await error.context?.json?.();
    if (body?.error) return body.error;
  } catch {}
  return error.message || "不明なエラー";
}

// 再解析しても、同じ内容の ToDo の完了状態は引き継ぐ
function mergeTodos(oldTodos, newTodos) {
  const doneSet = new Set(oldTodos.filter((t) => t.done).map((t) => t.text));
  return newTodos.map((t) => ({ text: t.text, due: t.due || "", time: t.time || "", done: doneSet.has(t.text) }));
}

// 「2026-10-13 10:00」のような期限表示
const dueLabel = (t) => [t.due, t.time].filter(Boolean).join(" ");

// ---------- あいまい検索 ----------
// 全角/半角・大文字/小文字・カタカナ/ひらがなの違いを吸収する
function norm(s) {
  return (s || "").normalize("NFKC").toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

const searchTokens = (query) => norm(query).split(/\s+/).filter(Boolean);

// 検索：1) 中身にその文字を含むメモ（確実に見つかる）2) 表記ゆれ・打ち間違いの似ている候補
// スペース区切りの語は、すべて含むもの（AND）
function search(list, query) {
  const tokens = searchTokens(query);
  const docs = list.map((m) => {
    const d = {
      m,
      t: norm(m.text),
      s: norm(m.summary),
      g: norm([...m.tags, ...m.keywords].join(" ")),
      a: norm(m.answer + " " + m.todos.map((t) => t.text).join(" ") + " " +
        (m.expenses || []).map((e) => `${e.item} ${e.shop}`).join(" ") + " " +
        (m.thread || []).map((t) => `${t.q} ${t.a}`).join(" ")),
      d: norm(formatDateTime(m.created_at) + " " + m.created_at.slice(0, 10)),
    };
    d.all = [d.t, d.s, d.g, d.a, d.d].join("\n");
    return d;
  });

  // 1) 完全一致：本文に含むものを先に、次に要約・タグ・回答などに含むもの
  const exact = docs.filter((d) => tokens.every((tok) => d.all.includes(tok)))
    .sort((x, y) => Number(tokens.every((tok) => y.t.includes(tok))) - Number(tokens.every((tok) => x.t.includes(tok))));
  const exactIds = new Set(exact.map((d) => d.m.id));

  // 2) あいまい一致（日付は対象外。1文字の語では行わない）
  let fuzzy = [];
  if (tokens.every((tok) => tok.length >= 2)) {
    const rest = docs.filter((d) => !exactIds.has(d.m.id));
    const fuse = new Fuse(rest, {
      keys: [
        { name: "t", weight: 0.5 },
        { name: "g", weight: 0.25 },
        { name: "s", weight: 0.15 },
        { name: "a", weight: 0.1 },
      ],
      threshold: 0.3,
      ignoreLocation: true,
      includeScore: true,
    });
    let scores = null;
    for (const tok of tokens) {
      const hit = new Map(fuse.search(tok).map((r) => [r.item.m.id, r.score]));
      if (!scores) scores = hit;
      else for (const id of [...scores.keys()]) {
        if (hit.has(id)) scores.set(id, scores.get(id) + hit.get(id)); else scores.delete(id);
      }
    }
    fuzzy = [...(scores || new Map()).entries()].sort((a, b) => a[1] - b[1]).map(([id]) => memos[id]);
  }
  return { exact: exact.map((d) => d.m), fuzzy };
}

// 検索語に一致した部分を <mark> で囲む（表記ゆれを吸収して元の文字に色を付ける）
function highlight(text, tokens) {
  if (!tokens.length) return esc(text);
  const chars = [...text];
  const normChars = chars.map((c) => norm(c));
  const joined = normChars.join("");
  // 正規化後の位置 → 元の文字の番号
  const owner = [];
  normChars.forEach((n, i) => { for (let k = 0; k < n.length; k++) owner.push(i); });
  const marked = new Array(chars.length).fill(false);
  for (const tok of tokens) {
    let from = 0, at;
    while ((at = joined.indexOf(tok, from)) !== -1) {
      for (let p = at; p < at + tok.length; p++) marked[owner[p]] = true;
      from = at + tok.length;
    }
  }
  let html = "", open = false;
  chars.forEach((c, i) => {
    if (marked[i] && !open) { html += "<mark>"; open = true; }
    if (!marked[i] && open) { html += "</mark>"; open = false; }
    html += esc(c);
  });
  return open ? html + "</mark>" : html;
}

// ---------- 表示 ----------
const $ = (sel) => document.querySelector(sel);
const memosView = $("#memosView");
const todosView = $("#todosView");
const searchInput = $("#search");
let currentView = "memos";

const dateFmt = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
const timeFmt = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" });
const formatDay = (iso) => dateFmt.format(new Date(iso));
const formatTime = (iso) => timeFmt.format(new Date(iso));
const formatDateTime = (iso) => `${formatDay(iso)} ${formatTime(iso)}`;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function liveMemos() {
  return Object.values(memos).filter((m) => !m.deleted)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function render() {
  renderMemos();
  renderTodos();
  renderMoney();
  if (document.querySelector("#chatDialog")?.open) renderChat(); // ほかの端末で会話が進んだとき
}

// ---------- 家計 ----------
const moneyView = $("#moneyView");
const yen = (n) => `${Number(n).toLocaleString("ja-JP")}円`;
const thisMonth = () => new Date().toLocaleDateString("sv-SE").slice(0, 7); // YYYY-MM
let moneyMonth = thisMonth();
let backfilling = false;

function shiftMonth(ym, diff) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + diff, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function allExpenses() {
  return liveMemos().flatMap((m) => (m.expenses || []).map((e) => ({ ...e, memo: m })));
}

// まだ金額を読み取っていない過去のメモ
const unreadMemos = () => liveMemos().filter((m) => m.expenses == null && m.ai_status === "done" && m.text.trim());

function sumBy(rows, key) {
  const map = new Map();
  for (const r of rows) map.set(key(r), (map.get(key(r)) || 0) + r.amount);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function renderMoney() {
  const rows = allExpenses().filter((e) => e.date.startsWith(moneyMonth))
    .sort((a, b) => b.date.localeCompare(a.date));
  const total = rows.reduce((s, e) => s + e.amount, 0);
  const prevTotal = allExpenses().filter((e) => e.date.startsWith(shiftMonth(moneyMonth, -1)))
    .reduce((s, e) => s + e.amount, 0);
  const [y, mo] = moneyMonth.split("-").map(Number);
  const unread = unreadMemos().length;

  let html = `
    <div class="money-nav">
      <button type="button" class="icon-btn" data-money="prev" aria-label="前の月">‹</button>
      <h2>${y}年${mo}月</h2>
      <button type="button" class="icon-btn" data-money="next" aria-label="次の月" ${moneyMonth >= thisMonth() ? "disabled" : ""}>›</button>
    </div>
    <div class="money-total">
      <div class="label">支出の合計</div>
      <div class="value">${yen(total)}</div>
      <div class="muted">${rows.length}件${prevTotal ? ` ／ 前月 ${yen(prevTotal)}` : ""}</div>
    </div>`;

  if (unread) {
    html += `<div class="money-note">
      <p>まだ金額を読み取っていない過去のメモが <b>${unread}件</b> あります。</p>
      <button type="button" class="primary-btn" data-money="backfill" ${backfilling || !session ? "disabled" : ""}>
        ${backfilling ? "読み取り中…" : "過去のメモから金額を読み取る"}</button>
      ${session ? "" : `<p class="muted">ログインすると読み取れます。</p>`}
    </div>`;
  }

  if (!rows.length) {
    html += `<p class="empty">この月の支出の記録はありません。<br>「スーパーで牛乳と卵 580円」のように<br>金額入りでメモすると、ここに集まります。</p>`;
    moneyView.innerHTML = html;
    return;
  }

  const max = Math.max(...sumBy(rows, (e) => e.category).map(([, v]) => v));
  html += `<div class="day-head">分類別</div><div class="card">` +
    sumBy(rows, (e) => e.category).map(([k, v]) => `
      <div class="bar-row">
        <span class="bar-label">${esc(k)}</span>
        <span class="bar"><span style="width:${Math.max(2, (v / max) * 100)}%"></span></span>
        <span class="bar-value">${yen(v)}</span>
      </div>`).join("") + `</div>`;

  html += `<div class="day-head">お店別</div><div class="card">` +
    sumBy(rows, (e) => e.shop || "（お店不明）").slice(0, 10).map(([k, v]) =>
      `<div class="kv"><span>${esc(k)}</span><b>${yen(v)}</b></div>`).join("") + `</div>`;

  html += `<div class="day-head">明細</div><div class="card">` +
    rows.map((e) => `
      <button type="button" class="money-item" data-act="edit" data-id="${e.memo.id}">
        <span class="d">${esc(e.date.slice(5).replace("-", "/"))}</span>
        <span class="t">${esc(e.item)}${e.shop ? `<small>${esc(e.shop)}・${esc(e.category)}</small>` : `<small>${esc(e.category)}</small>`}</span>
        <b>${yen(e.amount)}</b>
      </button>`).join("") + `</div>
    <div class="btn-row end"><button type="button" class="ghost-btn" data-money="csv">この月をCSVで書き出す</button></div>
    <p class="muted money-hint">金額がちがうときは、明細を押して元のメモを直すと、AIが読み取り直します。</p>`;
  moneyView.innerHTML = html;
}

moneyView.addEventListener("click", (e) => {
  const b = e.target.closest("[data-money]");
  if (!b) return;
  if (b.dataset.money === "prev") { moneyMonth = shiftMonth(moneyMonth, -1); renderMoney(); }
  if (b.dataset.money === "next") { moneyMonth = shiftMonth(moneyMonth, 1); renderMoney(); }
  if (b.dataset.money === "backfill") backfillExpenses();
  if (b.dataset.money === "csv") exportMoneyCsv();
});

// 過去のメモから金額だけを読み取る（回答や要約は変えない）
async function backfillExpenses() {
  if (backfilling || !supabase || !session) return;
  backfilling = true;
  const targets = unreadMemos();
  let done = 0, found = 0;
  renderMoney();
  try {
    for (const m of targets) {
      const textAtStart = m.text;
      const { data, error } = await supabase.functions.invoke("ai-memo", {
        body: { action: "expenses", text: m.text, created_at: m.created_at },
      });
      if (error) {
        toast("読み取りを中断しました: " + (await errorMessage(error)), 6000);
        break;
      }
      const cur = memos[m.id];
      if (cur && cur.text === textAtStart) {
        cur.expenses = data.expenses || [];
        found += cur.expenses.length;
        touch(cur);
      }
      done++;
      const btn = moneyView.querySelector('[data-money="backfill"]');
      if (btn) btn.textContent = `読み取り中… ${done} / ${targets.length}`;
    }
    if (done === targets.length) toast(`${done}件のメモを読み取り、支出を${found}件見つけました`, 5000);
  } finally {
    backfilling = false;
    renderMoney();
  }
}

function exportMoneyCsv() {
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["日付", "品目", "お店", "分類", "金額"]];
  for (const e of allExpenses().filter((e) => e.date.startsWith(moneyMonth)).sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push([e.date, e.item, e.shop, e.category, e.amount]);
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv" }));
  a.download = `koememo-家計-${moneyMonth}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renderMemos() {
  const q = searchInput.value.trim();
  const list = liveMemos();
  if (!list.length) {
    memosView.innerHTML = `<p class="empty">まだメモがありません。<br>下のマイクボタンを押して話してみましょう。</p>`;
    return;
  }
  let html = "";
  if (q) {
    const { exact, fuzzy } = search(list, q);
    const tokens = searchTokens(q);
    html += `<div class="day-head search-head">「${esc(q)}」を含むメモ ${exact.length}件
      ${exact.length >= 2 ? `<button type="button" class="mini-btn" data-digest="1">✨ AIでまとめる</button>` : ""}</div>`;
    html += exact.map((m) => cardHTML(m, true, tokens)).join("");
    if (fuzzy.length) {
      html += `<div class="day-head">似ている候補 ${fuzzy.length}件（表記ゆれ・打ち間違い）</div>`;
      html += fuzzy.map((m) => cardHTML(m, true, tokens)).join("");
    }
    if (!exact.length && !fuzzy.length) html += `<p class="empty">見つかりませんでした</p>`;
  } else {
    const pinned = list.filter((m) => m.pinned);
    if (pinned.length) {
      html += `<div class="day-head">📌 ピン留め</div>` + pinned.map((m) => cardHTML(m, true)).join("");
    }
    let lastDay = "";
    for (const m of list.filter((m) => !m.pinned)) {
      const day = formatDay(m.created_at);
      if (day !== lastDay) { html += `<div class="day-head">${esc(day)}</div>`; lastDay = day; }
      html += cardHTML(m, false);
    }
  }
  memosView.innerHTML = html;
  hydratePhotos(memosView);
}

function cardHTML(m, showDate, tokens = []) {
  const hl = (s) => highlight(s, tokens);
  const when = showDate ? formatDateTime(m.created_at) : formatTime(m.created_at);
  let ai = "";
  if (m.ai_status === "pending") {
    ai = `<div class="ai-state">🤖 AI解析待ち${session ? "…" : "（ログインすると処理されます）"}</div>`;
  } else if (m.ai_status === "error") {
    ai = `<div class="ai-state">⚠️ AI解析に失敗: ${esc(m.ai_error)} <button class="tag" data-act="retry" data-id="${m.id}">再試行</button></div>`;
  }
  const turns = (m.thread || []).length;
  const answer = m.is_question && m.answer
    ? `<details class="answer" open><summary>🤖 AIの回答</summary>${hl(m.answer)}
        <div class="answer-actions">
          <button type="button" class="mini-btn" data-act="speak" data-id="${m.id}">🔊 読み上げ</button>
          <button type="button" class="mini-btn" data-act="chat" data-id="${m.id}">💬 続けて質問${turns ? `（${turns}件）` : ""}</button>
        </div></details>`
    : turns ? `<button type="button" class="mini-btn chat-link" data-act="chat" data-id="${m.id}">💬 AIとの会話（${turns}件）</button>` : "";
  const summary = m.summary && m.summary !== m.text ? `<div class="summary">${hl(m.summary)}</div>` : "";
  const tags = m.tags.length
    ? `<div class="tags">${m.tags.map((t) => `<button class="tag" data-act="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join("")}</div>` : "";
  const todos = m.todos.length
    ? `<ul class="mini-todos">${m.todos.map((t) => `<li class="${t.done ? "done" : ""}">${hl(t.text)}${t.due ? `（${esc(dueLabel(t))}）` : ""}</li>`).join("")}</ul>` : "";
  const money = (m.expenses || []).length
    ? `<div class="mini-money">💴 ${m.expenses.map((e) => `${hl(e.item)} <b>${yen(e.amount)}</b>`).join("、")}</div>` : "";
  return `
    <article class="card ${m.pinned ? "pinned" : ""}">
      <div class="card-head">
        <span class="time">${esc(when)}${m._dirty && session ? " ・未同期" : ""}</span>
        <button data-act="share" data-id="${m.id}" aria-label="共有">📤</button>
        <button data-act="chat" data-id="${m.id}" aria-label="AIに質問">💬</button>
        <button data-act="pin" data-id="${m.id}" class="${m.pinned ? "on" : ""}" aria-label="ピン留め">📌</button>
        <button data-act="edit" data-id="${m.id}" aria-label="編集">✏️</button>
      </div>
      ${(m.photos || []).length ? `<div class="thumbs">${m.photos.map((p) =>
        `<button type="button" class="thumb" data-act="photo" data-path="${esc(p)}" aria-label="写真を大きく表示"><img data-photo="${esc(p)}" alt="写真"></button>`).join("")}</div>` : ""}
      <div class="card-text">${hl(m.text)}</div>
      ${summary}${answer}${money}${todos}${tags}${ai}
    </article>`;
}

function collectTodos() {
  const out = [];
  for (const m of liveMemos()) m.todos.forEach((t, i) => out.push({ ...t, memo: m, index: i }));
  return out;
}

function renderTodos() {
  const all = collectTodos();
  const open = all.filter((t) => !t.done)
    .sort((a, b) => (a.due ? dueLabel(a) : "9999").localeCompare(b.due ? dueLabel(b) : "9999"));
  const done = all.filter((t) => t.done);
  const badge = $("#todoCount");
  badge.hidden = !open.length;
  badge.textContent = open.length;
  if (!all.length) {
    todosView.innerHTML = `<p class="empty">ToDoはまだありません。<br>「明日までに資料を送る」のように話すと、AIが自動でここに追加します。</p>`;
    return;
  }
  const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
  const item = (t) => `
    <div class="todo ${t.done ? "done" : ""}">
      <input type="checkbox" data-act="todo" data-id="${t.memo.id}" data-index="${t.index}" ${t.done ? "checked" : ""}>
      <div class="body">
        <div class="text">${esc(t.text)}</div>
        ${t.due ? `<div class="due ${!t.done && t.due < today ? "overdue" : ""}">期限: ${esc(dueLabel(t))}</div>` : ""}
        <div class="todo-actions">
          <button class="src" data-act="edit" data-id="${t.memo.id}">元のメモ（${esc(formatDateTime(t.memo.created_at))}）</button>
          ${t.due && !t.done ? `<button type="button" class="mini-btn" data-act="cal" data-id="${t.memo.id}" data-index="${t.index}">📅 カレンダーに追加</button>` : ""}
        </div>
      </div>
    </div>`;
  todosView.innerHTML =
    `<div class="day-head">未完了 ${open.length}件</div>` + open.map(item).join("") +
    (done.length ? `<div class="day-head">完了 ${done.length}件</div>` + done.map(item).join("") : "");
}

// ---------- 状態表示・トースト ----------
function setStatus(text, cls = "") {
  const el = $("#syncStatus");
  el.textContent = text;
  el.className = "sync-status " + cls;
}
function updateStatus() {
  if (!supabase) setStatus("ローカル");
  else if (!session) setStatus("未ログイン", "warn");
  else if (!navigator.onLine) setStatus("オフライン", "warn");
}
let toastTimer;
// action を渡すと、メッセージの横にボタン（「元に戻す」など）を出す
function toast(msg, ms = 3000, action = null) {
  const el = $("#toast");
  // メニューなどのダイアログが開いていると裏に隠れるので、ダイアログの中に移して表示する
  (document.querySelector("dialog[open]") || document.body).appendChild(el);
  el.textContent = msg;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-action";
    b.textContent = action.label;
    b.onclick = () => { el.hidden = true; action.run(); };
    el.append(" ", b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------- 入力・保存 ----------
const compose = $("#compose");
const interimEl = $("#interim");

function autoGrow() {
  compose.style.height = "auto";
  compose.style.height = compose.scrollHeight + "px";
}
compose.addEventListener("input", autoGrow);
compose.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveCompose(); }
});
$("#saveBtn").addEventListener("click", saveCompose);

function saveCompose() {
  const text = compose.value.trim();
  if (!text) return;
  const m = newMemo(text);
  compose.value = "";
  autoGrow();
  touch(m);
  toast(supabase && session ? "保存しました（AIが解析中）" : "保存しました");
  processAI();
}

// ---------- 写真から記録（文字の読み取り・レシート） ----------
const photoBtn = $("#photoBtn");
const photoInput = $("#photoInput");
const photoDialog = $("#photoDialog");
let photoMode = "ocr";

photoBtn.addEventListener("click", () => {
  if (!supabase || !session) return toast("写真からの記録は、ログインすると使えます");
  if (!navigator.onLine) return toast("インターネットにつながっているときに使えます");
  photoDialog.showModal();
});

photoDialog.querySelectorAll("[data-photo]").forEach((b) => b.addEventListener("click", () => {
  photoMode = b.dataset.photo;
  photoDialog.close();
  photoInput.value = "";
  photoInput.click(); // iPhone では「写真を撮る」「写真ライブラリ」などを選べる
}));

// 写真を JPEG に変換し、長い辺を maxSide までに縮めた canvas を返す
async function photoToCanvas(file, maxSide) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// AI が読みやすい大きさ（長い辺 1568px まで）の JPEG（base64）
async function photoToJpegBase64(file) {
  return (await photoToCanvas(file, 1568)).toDataURL("image/jpeg", 0.85).split(",")[1];
}

// ---------- 写真つきメモ ----------
// 写真は長い辺 1280px の JPEG（1枚およそ 200KB）にして、Supabase Storage の「ユーザーID/メモID/」に保存する
const photoMemoDialog = $("#photoMemoDialog");
const photoMemoText = $("#photoMemoText");
let photoMemoBlob = null;

async function openPhotoMemo(file) {
  try {
    const canvas = await photoToCanvas(file, 1280);
    photoMemoBlob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.82));
    $("#photoMemoPreview").src = canvas.toDataURL("image/jpeg", 0.6);
    photoMemoText.value = "";
    photoMemoDialog.showModal();
  } catch (e) {
    console.error(e);
    toast("写真を読み込めませんでした。もう一度お試しください", 6000);
  }
}

async function savePhotoMemo() {
  if (!photoMemoBlob || !session) return;
  const btn = $("#photoMemoSave");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    const m = newMemo(photoMemoText.value.trim() || "📷 写真");
    const path = `${session.user.id}/${m.id}/${crypto.randomUUID()}.jpg`;
    const { error } = await supabase.storage.from("photos").upload(path, photoMemoBlob, { contentType: "image/jpeg" });
    if (error) return toast("写真を保存できませんでした: " + error.message, 7000);
    m.photos = [path];
    touch(m);
    photoMemoDialog.close();
    toast("写真つきメモを保存しました（AIが解析中）", 5000);
    processAI();
  } finally {
    btn.disabled = false;
    btn.textContent = "保存";
  }
}

$("#photoMemoSave").addEventListener("click", savePhotoMemo);
$("#photoMemoMic").addEventListener("click", () => toggleRec({
  textarea: photoMemoText, button: $("#photoMemoMic"),
}));
photoMemoDialog.addEventListener("close", () => { if (recording) stopRec(); });

// 写真の表示：保存場所は非公開なので、1時間だけ使える表示用アドレスをもらって表示する
const photoUrlCache = new Map(); // path → { url, exp }

async function hydratePhotos(root = document) {
  if (!supabase || !session) return;
  const imgs = [...root.querySelectorAll("img[data-photo]")];
  if (!imgs.length) return;
  const now = Date.now();
  const need = [...new Set(imgs.map((i) => i.dataset.photo))]
    .filter((p) => !(photoUrlCache.get(p)?.exp > now));
  if (need.length) {
    const { data } = await supabase.storage.from("photos").createSignedUrls(need, 3600);
    for (const d of data || []) {
      if (d.signedUrl) photoUrlCache.set(d.path, { url: d.signedUrl, exp: now + 3300_000 });
    }
  }
  for (const img of imgs) {
    const c = photoUrlCache.get(img.dataset.photo);
    if (c && img.src !== c.url) img.src = c.url;
  }
}

function openPhotoViewer(path) {
  const c = photoUrlCache.get(path);
  if (!c) return;
  $("#photoViewerImg").src = c.url;
  $("#photoViewer").showModal();
}

photoInput.addEventListener("change", async () => {
  const file = photoInput.files?.[0];
  if (!file) return;
  const mode = photoMode;
  if (mode === "memo") return openPhotoMemo(file);
  photoBtn.disabled = true;
  photoBtn.classList.add("busy");
  toast(mode === "receipt" ? "レシートを読み取っています…" : "写真の文字を読み取っています…", 20000);
  try {
    const image = await photoToJpegBase64(file);
    const { data, error } = await supabase.functions.invoke("ai-memo", {
      body: { action: mode, image, media_type: "image/jpeg", created_at: new Date().toISOString() },
    });
    if (error) return toast("読み取れませんでした: " + (await errorMessage(error)), 7000);

    if (mode === "ocr") {
      // ふつうのメモとして保存し、要約・タグ・ToDo などは AI がいつもどおり解析する
      const m = newMemo(`📷 ${data.text}`);
      touch(m);
      toast("写真の文字をメモにしました（AIが解析中）", 5000);
      processAI();
      return;
    }

    data.items ||= [];
    const lines = data.items.map((i) => `・${i.name} ${yen(i.amount)}`);
    const m = newMemo(`🧾 レシート（${data.shop || "お店不明"}）${data.date}\n合計 ${yen(data.total)}\n${lines.join("\n")}`);
    Object.assign(m, {
      ai_status: "done",
      summary: `${data.shop || "お店"}で${yen(data.total)}の買い物`,
      tags: ["買い物", "レシート"],
      keywords: [data.shop, ...data.items.map((i) => i.name)].filter(Boolean),
      expenses: data.expenses,
    });
    touch(m);
    toast(`記録しました：${data.shop || "お店不明"} ${yen(data.total)}`, 5000);
  } catch (e) {
    console.error(e);
    toast("写真を読み込めませんでした。もう一度お試しください", 6000);
  } finally {
    photoBtn.disabled = false;
    photoBtn.classList.remove("busy");
  }
});

// ---------- 音声入力（メモの入力欄と、会話の入力欄で共用） ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = $("#micBtn");
// 無音で止まったときに自動で聞き直す回数（多いほど、話の途中で考えても止まりにくい）
const MAX_IDLE_RESTARTS = 6;
let rec = null, recording = false, baseText = "", finalText = "", idleRestarts = 0, recTarget = null;

function autoSaveEnabled() {
  return localStorage.getItem(LS_AUTOSAVE) !== "0";
}

function joinText(a, b) {
  return a && b ? a.replace(/\s+$/, "") + "\n" + b : a + b;
}

// target: { textarea, button, interim(表示欄・なくてもよい), onInput, onDone }
function startRec(target) {
  if (!SR) {
    toast("このブラウザは音声認識に未対応です。キーボードのマイクボタンで音声入力できます", 5000);
    target.textarea.focus();
    return;
  }
  recTarget = target;
  rec = new SR();
  rec.lang = "ja-JP";
  rec.continuous = true;
  rec.interimResults = true;
  baseText = target.textarea.value;
  finalText = "";
  idleRestarts = 0;

  rec.onresult = (e) => {
    idleRestarts = 0;
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    target.textarea.value = joinText(baseText, finalText);
    if (target.interim) {
      target.interim.textContent = interim;
      target.interim.hidden = !interim;
    }
    target.onInput?.();
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      recording = false;
      toast("マイク（音声認識）の使用が許可されていません。設定を確認してください", 5000);
    }
  };
  rec.onend = () => {
    // iPhone は無音が続くと自動で止まるので、録音中なら聞き直す（無音が長く続けば終了）
    if (recording && idleRestarts < MAX_IDLE_RESTARTS) {
      idleRestarts++;
      baseText = target.textarea.value;
      finalText = "";
      try { rec.start(); return; } catch {}
    }
    finishRec();
  };

  recording = true;
  target.button.classList.add("rec");
  target.button.setAttribute("aria-label", "録音を停止");
  try { rec.start(); } catch (e) { finishRec(); }
}

function stopRec() {
  recording = false;
  rec?.stop();
}

function finishRec() {
  const target = recTarget;
  recording = false;
  rec = null;
  recTarget = null;
  if (!target) return;
  target.button.classList.remove("rec");
  target.button.setAttribute("aria-label", "音声入力");
  if (target.interim) target.interim.hidden = true;
  target.onDone?.();
}

function toggleRec(target) {
  if (recording) stopRec();
  else startRec(target);
}

const composeRecTarget = {
  textarea: compose, button: micBtn, interim: interimEl, onInput: autoGrow,
  onDone: () => { if (autoSaveEnabled() && compose.value.trim()) saveCompose(); },
};
micBtn.addEventListener("click", () => toggleRec(composeRecTarget));

// ---------- 読み上げ ----------
let speakingBtn = null;

// 絵文字や記号を除いて、読み上げやすい文にする
function speakableText(text) {
  return text.replace(/\p{Extended_Pictographic}/gu, "").replace(/[※・]/g, " ").replace(/\n{2,}/g, "\n");
}

function speak(text, btn) {
  if (!("speechSynthesis" in window)) return toast("この端末は読み上げに対応していません");
  const wasThis = speakingBtn === btn && speechSynthesis.speaking;
  speechSynthesis.cancel();
  if (speakingBtn) speakingBtn.classList.remove("speaking");
  speakingBtn = null;
  if (wasThis) return; // 読み上げ中にもう一度押したら止める
  const u = new SpeechSynthesisUtterance(speakableText(text));
  u.lang = "ja-JP";
  const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith("ja"));
  if (voice) u.voice = voice;
  u.onend = u.onerror = () => {
    btn.classList.remove("speaking");
    if (speakingBtn === btn) speakingBtn = null;
  };
  speakingBtn = btn;
  btn.classList.add("speaking");
  speechSynthesis.speak(u);
}

// ---------- カレンダーに追加 ----------
let calTarget = null;

function addToCalendar(m, todo) {
  calTarget = { m, todo };
  $("#calTitle").textContent = `${todo.text}（${dueLabel(todo)}）`;
  $("#calDialog").showModal();
}

// iPhone のカレンダー：サーバーが返す予定のファイル（.ics）を開く
function openIcs({ m, todo }) {
  if (!supabase) return toast("カレンダー登録は、Supabase の設定後に使えます");
  const q = new URLSearchParams({
    ics: "1", title: todo.text, due: todo.due, time: todo.time || "",
    note: m.text.slice(0, 300),
  });
  const url = `${SUPABASE_URL}/functions/v1/ai-memo?${q}`;
  if (isIOS && isStandalone) {
    // ホーム画面のアプリの中では予定のファイルを開けない（真っ白になる）ので、Safari で直接開く
    location.href = "x-safari-" + url;
  } else {
    window.open(url, "_blank");
  }
}

// Google カレンダー：予定の入力画面を、内容を入れた状態で開く
function openGoogleCalendar({ m, todo }) {
  const ymd = (s) => s.replace(/-/g, "");
  let dates;
  if (todo.time) {
    const start = new Date(`${todo.due}T${todo.time}:00+09:00`);
    const end = new Date(start.getTime() + 3600_000);
    const utc = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    dates = `${utc(start)}/${utc(end)}`;
  } else {
    const next = new Date(Date.parse(`${todo.due}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
    dates = `${ymd(todo.due)}/${ymd(next)}`;
  }
  const q = new URLSearchParams({ action: "TEMPLATE", text: todo.text, dates, details: m.text.slice(0, 500) });
  window.open(`https://calendar.google.com/calendar/render?${q}`, "_blank");
}

document.querySelectorAll("#calDialog [data-cal]").forEach((b) => b.addEventListener("click", () => {
  $("#calDialog").close();
  if (!calTarget) return;
  if (b.dataset.cal === "google") openGoogleCalendar(calTarget);
  else openIcs(calTarget);
}));

// ---------- カード操作 ----------
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn || btn.dataset.act === "todo") return;
  const m = memos[btn.dataset.id];
  switch (btn.dataset.act) {
    case "pin":
      m.pinned = !m.pinned;
      touch(m);
      break;
    case "edit":
      openEditor(m);
      break;
    case "retry":
      m.ai_status = "pending";
      touch(m);
      processAI();
      break;
    case "tag":
      searchInput.value = btn.dataset.tag;
      switchView("memos");
      render();
      break;
    case "speak":
      speak(m.answer, btn);
      break;
    case "chat":
      openChat(m);
      break;
    case "cal":
      addToCalendar(m, m.todos[Number(btn.dataset.index)]);
      break;
    case "share":
      openShare(m);
      break;
    case "photo":
      openPhotoViewer(btn.dataset.path);
      break;
  }
});

document.addEventListener("change", (e) => {
  const cb = e.target.closest('[data-act="todo"]');
  if (!cb) return;
  const m = memos[cb.dataset.id];
  m.todos = m.todos.map((t, i) => (i === Number(cb.dataset.index) ? { ...t, done: cb.checked } : t));
  touch(m);
});

// ---------- AI との会話 ----------
const chatDialog = $("#chatDialog");
const chatLog = $("#chatLog");
const chatText = $("#chatText");
const chatSend = $("#chatSend");
const chatMic = $("#chatMic");
let chatMemoId = null, chatBusy = false, chatPending = "";

function chatGrow() {
  chatText.style.height = "auto";
  chatText.style.height = chatText.scrollHeight + "px";
}

function openChat(m) {
  chatMemoId = m.id;
  chatText.value = "";
  chatGrow();
  renderChat();
  chatDialog.showModal();
  chatLog.scrollTop = chatLog.scrollHeight;
}

function renderChat() {
  const m = memos[chatMemoId];
  if (!m) return;
  const aiBubble = (text, i) => `
    <div class="bubble ai"><span class="meta">🤖 AI</span>${esc(text)}
      <br><button type="button" class="mini-btn" data-chat-speak="${i}">🔊 読み上げ</button></div>`;
  let html = `<div class="bubble memo"><span class="meta">📝 メモ（${esc(formatDateTime(m.created_at))}）</span>${esc(m.text)}</div>`;
  const texts = [];
  if (m.answer) { texts.push(m.answer); html += aiBubble(m.answer, texts.length - 1); }
  for (const t of m.thread || []) {
    html += `<div class="bubble me">${esc(t.q)}</div>`;
    texts.push(t.a);
    html += aiBubble(t.a, texts.length - 1);
  }
  if (chatPending) {
    html += `<div class="bubble me">${esc(chatPending)}</div><div class="bubble ai thinking">🤖 考えています…</div>`;
  }
  if (!m.answer && !(m.thread || []).length && !chatPending) {
    html += `<p class="muted">このメモについて、AIに質問できます（例：「くわしく教えて」「要点を3つにまとめて」）。</p>`;
  }
  chatLog.innerHTML = html;
  chatLog.querySelectorAll("[data-chat-speak]").forEach((b) =>
    b.addEventListener("click", () => speak(texts[Number(b.dataset.chatSpeak)], b)));
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function sendChat() {
  const m = memos[chatMemoId];
  const q = chatText.value.trim();
  if (!m || !q || chatBusy) return;
  if (!supabase || !session) return toast("AIとの会話は、ログインすると使えます");
  if (!navigator.onLine) return toast("インターネットにつながっているときに使えます");
  chatBusy = true;
  chatSend.disabled = true;
  chatPending = q;
  chatText.value = "";
  chatGrow();
  renderChat();
  try {
    const { data, error } = await supabase.functions.invoke("ai-memo", {
      body: {
        action: "followup", text: m.text, created_at: m.created_at,
        answer: m.answer || "", thread: (m.thread || []).slice(-20), question: q,
      },
    });
    if (error) {
      chatText.value = q; // 送れなかった質問は入力欄に戻す
      toast("送れませんでした: " + (await errorMessage(error)), 6000);
      return;
    }
    const cur = memos[chatMemoId];
    cur.thread = [...(cur.thread || []), { q, a: data.answer, at: new Date().toISOString() }];
    touch(cur);
  } finally {
    chatBusy = false;
    chatSend.disabled = false;
    chatPending = "";
    renderChat();
  }
}

chatSend.addEventListener("click", sendChat);
chatText.addEventListener("input", chatGrow);
chatText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(); }
});
chatMic.addEventListener("click", () => toggleRec({
  textarea: chatText, button: chatMic, onInput: chatGrow,
  onDone: () => { if (autoSaveEnabled() && chatText.value.trim()) sendChat(); },
}));
$("#chatClose").addEventListener("click", () => chatDialog.close());
chatDialog.addEventListener("close", () => {
  if (recording) stopRec();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
});

// ---------- 編集ダイアログ ----------
const editDialog = $("#editDialog");
const editText = $("#editText");
let editingId = null;

function openEditor(m) {
  editingId = m.id;
  editText.value = m.text;
  $("#editMeta").textContent = `作成: ${formatDateTime(m.created_at)}` +
    (m.updated_at !== m.created_at ? ` ／ 更新: ${formatDateTime(m.updated_at)}` : "");
  editDialog.showModal();
}
$("#editSave").addEventListener("click", () => {
  const m = memos[editingId];
  const text = editText.value.trim();
  if (m && text && text !== m.text) {
    m.text = text;
    m.ai_status = "pending"; // 内容が変わったので再解析
    touch(m);
    processAI();
  }
  editDialog.close();
});
$("#editDelete").addEventListener("click", () => {
  const m = memos[editingId];
  if (!m) return;
  moveToTrash(m);
  editDialog.close();
});

// ---------- 共有 ----------
let shareMemoId = null;

function openShare(m) {
  shareMemoId = m.id;
  $("#shareDialog").showModal();
}

function shareText(m, full) {
  let s = `📝 ${formatDateTime(m.created_at)}\n${m.text}`;
  if (!full) return s;
  if (m.answer) s += `\n\n🤖 AIの回答\n${m.answer}`;
  for (const t of m.thread || []) s += `\n\n❓ ${t.q}\n🤖 ${t.a}`;
  if ((m.todos || []).length) s += "\n\n" + m.todos.map((t) => `${t.done ? "☑" : "☐"} ${t.text}${t.due ? `（${dueLabel(t)}）` : ""}`).join("\n");
  if ((m.expenses || []).length) s += "\n\n💴 " + m.expenses.map((e) => `${e.item} ${yen(e.amount)}`).join("、");
  return s;
}

document.querySelectorAll("#shareDialog [data-share]").forEach((b) => b.addEventListener("click", async () => {
  const m = memos[shareMemoId];
  $("#shareDialog").close();
  if (!m) return;
  const text = shareText(m, b.dataset.share === "full");
  if (navigator.share) {
    try { await navigator.share({ text }); } catch (e) { if (e.name !== "AbortError") toast("共有できませんでした"); }
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("コピーしました。送りたいアプリに貼り付けてください", 5000);
  } catch {
    toast("この端末では共有できませんでした");
  }
}));

// ---------- テーマ別まとめ ----------
function digestRange(kind) {
  const now = new Date();
  const ym = (d) => d.toLocaleDateString("sv-SE").slice(0, 7);
  if (kind === "month") return { label: `${now.getMonth() + 1}月`, ok: (m) => m.created_at && new Date(m.created_at).toLocaleDateString("sv-SE").startsWith(ym(now)) };
  if (kind === "last") {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { label: `${d.getMonth() + 1}月`, ok: (m) => new Date(m.created_at).toLocaleDateString("sv-SE").startsWith(ym(d)) };
  }
  if (kind === "3m") {
    const from = new Date(now.getFullYear(), now.getMonth() - 2, 1).getTime();
    return { label: "過去3か月", ok: (m) => Date.parse(m.created_at) >= from };
  }
  return { label: "すべて", ok: () => true };
}

function digestTargets() {
  const q = searchInput.value.trim();
  const { exact } = search(liveMemos(), q);
  const range = digestRange($("#digestPeriod").value);
  // まとめのメモ自身は除く
  return { q, range, list: exact.filter((m) => range.ok(m) && !(m.tags || []).includes("まとめ")).slice(0, 80) };
}

function updateDigestCount() {
  const { list } = digestTargets();
  $("#digestCount").textContent = `${list.length}件のメモをまとめます${list.length >= 80 ? "（多いので新しい80件まで）" : ""}`;
  $("#digestRun").disabled = list.length < 1;
}

memosView.addEventListener("click", (e) => {
  if (!e.target.closest("[data-digest]")) return;
  if (!supabase || !session) return toast("AIでまとめるのは、ログインすると使えます");
  $("#digestInfo").textContent = `テーマ：「${searchInput.value.trim()}」`;
  updateDigestCount();
  $("#digestDialog").showModal();
});
$("#digestPeriod").addEventListener("change", updateDigestCount);

$("#digestRun").addEventListener("click", async () => {
  const { q, range, list } = digestTargets();
  if (!list.length) return;
  const btn = $("#digestRun");
  btn.disabled = true;
  btn.textContent = "まとめています…";
  try {
    const memosText = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((m) => {
      const d = new Date(m.created_at);
      const extra = [m.answer && `AIの回答: ${m.answer.slice(0, 300)}`,
        (m.todos || []).length && `ToDo: ${m.todos.map((t) => `${t.text}${t.done ? "[完了]" : ""}`).join("、")}`].filter(Boolean).join(" / ");
      return `[${d.getMonth() + 1}/${d.getDate()}] ${m.text.slice(0, 800)}${extra ? `\n  （${extra}）` : ""}`;
    }).join("\n");
    const { data, error } = await supabase.functions.invoke("ai-memo", {
      body: { action: "digest", theme: q, period: range.label, memos_text: memosText, created_at: new Date().toISOString() },
    });
    if (error) return toast("まとめられませんでした: " + (await errorMessage(error)), 7000);
    const m = newMemo(`✨「${q}」のまとめ（${range.label}・${list.length}件）\n\n${data.text}`);
    Object.assign(m, { ai_status: "done", tags: ["まとめ", q].slice(0, 2), summary: `「${q}」のメモ${list.length}件のまとめ`, keywords: [q, "まとめ"], expenses: [] });
    touch(m);
    $("#digestDialog").close();
    searchInput.value = "";
    lastQuery = "";
    switchView("memos");
    renderMemos();
    $("#main").scrollTop = 0;
    toast("まとめを新しいメモにしました", 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = "まとめる";
  }
});

// ---------- ゴミ箱（30日たつとサーバーが自動で完全に削除） ----------
const TRASH_DAYS = 30;
const trashedMemos = () => Object.values(memos)
  .filter((m) => m.deleted && !m.purged && m.text) // 古い版で削除したメモは中身がないので出さない
  .sort((a, b) => (b.deleted_at || "").localeCompare(a.deleted_at || ""));

function moveToTrash(m) {
  m.deleted = true;
  m.deleted_at = new Date().toISOString();
  touch(m);
  toast("ゴミ箱に移しました", 6000, { label: "元に戻す", run: () => restoreMemo(m.id) });
}

function restoreMemo(id) {
  const m = memos[id];
  if (!m) return;
  m.deleted = false;
  m.deleted_at = null;
  touch(m);
  if ($("#trashDialog").open) renderTrash();
  toast("元に戻しました");
}

async function purgeMemo(m) {
  if ((m.photos || []).length && supabase && session) {
    await supabase.storage.from("photos").remove(m.photos);
  }
  Object.assign(m, {
    purged: true, text: "", answer: "", summary: "", tags: [], keywords: [], todos: [],
    expenses: [], thread: [], photos: [],
  });
  touch(m);
}

function renderTrash() {
  const list = trashedMemos();
  const box = $("#trashList");
  if (!list.length) {
    box.innerHTML = `<p class="empty">ゴミ箱は空です。</p>`;
    $("#emptyTrash").hidden = true;
    return;
  }
  $("#emptyTrash").hidden = false;
  box.innerHTML = list.map((m) => {
    const left = Math.max(0, TRASH_DAYS - Math.floor((Date.now() - Date.parse(m.deleted_at || m.updated_at)) / 86400_000));
    return `<div class="trash-item">
      <div class="trash-text">${esc(m.text.slice(0, 80))}${m.text.length > 80 ? "…" : ""}</div>
      <div class="muted">${esc(formatDateTime(m.created_at))} ／ あと${left}日で完全に削除${(m.photos || []).length ? " ／ 📷写真あり" : ""}</div>
      <div class="btn-row">
        <button type="button" data-trash="restore" data-id="${m.id}">元に戻す</button>
        <button type="button" class="danger" data-trash="purge" data-id="${m.id}">完全に削除</button>
      </div>
    </div>`;
  }).join("");
}

function openTrash() {
  renderTrash();
  $("#trashDialog").showModal();
}

$("#trashList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-trash]");
  if (!b) return;
  const m = memos[b.dataset.id];
  if (!m) return;
  if (b.dataset.trash === "restore") restoreMemo(m.id);
  if (b.dataset.trash === "purge") {
    if (!confirm("このメモを完全に削除しますか？（元に戻せません）")) return;
    await purgeMemo(m);
    renderTrash();
    toast("完全に削除しました");
  }
});
$("#emptyTrash").addEventListener("click", async () => {
  const list = trashedMemos();
  if (!list.length || !confirm(`ゴミ箱の${list.length}件をすべて完全に削除しますか？（元に戻せません）`)) return;
  for (const m of list) await purgeMemo(m);
  renderTrash();
  toast("ゴミ箱を空にしました");
});

// ---------- メニュー（アカウント・エクスポート） ----------
const menuDialog = $("#menuDialog");
$("#menuBtn").addEventListener("click", () => {
  renderAccount();
  $("#autoSaveVoice").checked = autoSaveEnabled();
  const n = trashedMemos().length;
  $("#trashCount").textContent = n ? `${n}件` : "空です";
  menuDialog.showModal();
});
$("#openTrash").addEventListener("click", () => { menuDialog.close(); openTrash(); });
$("#autoSaveVoice").addEventListener("change", (e) => {
  localStorage.setItem(LS_AUTOSAVE, e.target.checked ? "1" : "0");
});

function renderAccount() {
  const box = $("#accountBox");
  if (!supabase) {
    box.innerHTML = `<p class="muted">ローカルモードです（この端末だけに保存）。同期とAIを使うには README の手順で config.js を設定してください。</p>`;
    return;
  }
  if (session) {
    box.innerHTML = `
      <p class="muted">ログイン中: ${esc(session.user.email)}</p>
      <div class="btn-row">
        <button type="button" id="syncNow">今すぐ同期</button>
        <button type="button" id="logout">ログアウト</button>
      </div>
      <h3>ToDo のリマインダー通知</h3>
      <p class="muted">時刻ありは30分前、日付だけなら当日朝8時にお知らせします。</p>
      <div class="btn-row" id="pushBox"><span class="muted">確認中…</span></div>
      <h3>ショートカット（ロック画面から追加）</h3>
      <p class="muted">iPhone の「ショートカット」アプリに設定する鍵を発行します。発行し直すと古い鍵は使えなくなります。</p>
      <div class="btn-row"><button type="button" id="issueToken">鍵を発行する</button></div>
      <div id="tokenBox"></div>`;
    $("#syncNow").onclick = () => { sync(); toast("同期しています"); };
    $("#logout").onclick = logout;
    $("#issueToken").onclick = issueToken;
    renderPushBox();
    return;
  }
  box.innerHTML = `
    <p class="muted">ログインすると、iPhoneとパソコンでメモが同期され、AI解析が有効になります。</p>
    <input type="email" id="email" placeholder="メールアドレス" autocomplete="email">
    <input type="password" id="password" placeholder="パスワード（6文字以上）" autocomplete="current-password">
    <div class="btn-row">
      <button type="button" id="login" class="primary">ログイン</button>
      <button type="button" id="signup">新規登録</button>
    </div>`;
  const creds = () => ({ email: $("#email").value.trim(), password: $("#password").value });
  $("#login").onclick = async () => {
    const { error } = await supabase.auth.signInWithPassword(creds());
    if (error) return toast("ログインできませんでした: " + error.message, 5000);
    menuDialog.close();
    toast("ログインしました");
  };
  $("#signup").onclick = async () => {
    const { error, data } = await supabase.auth.signUp(creds());
    if (error) return toast("登録できませんでした: " + error.message, 5000);
    if (!data.session) toast("確認メールを送りました。メール内のリンクを開いてからログインしてください", 7000);
    else { menuDialog.close(); toast("登録しました"); }
  };
}

// ---------- リマインダー通知 ----------
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "Notification" in window && "PushManager" in window && "serviceWorker" in navigator;

function b64urlToBytes(s) {
  const b64 = (s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function renderPushBox() {
  const box = $("#pushBox");
  if (!box) return;
  if (!pushSupported) {
    box.innerHTML = `<span class="muted">${isIOS && !isStandalone
      ? "ホーム画面に追加したアプリから開くと、通知をオンにできます。"
      : "このブラウザは通知に対応していません。"}</span>`;
    return;
  }
  const sub = await currentSubscription();
  if (sub && Notification.permission === "granted") {
    box.innerHTML = `<span class="muted">この端末: オン</span>
      <button type="button" id="testPush">テスト通知</button>
      <button type="button" id="disablePush">オフにする</button>
      <label class="check full"><input type="checkbox" id="morningPush" disabled> 毎朝7時に、今日のToDoと期限切れを知らせる</label>`;
    $("#testPush").onclick = testPush;
    $("#disablePush").onclick = disablePush;
    // 毎朝のお知らせ（端末ごと）
    const cb = $("#morningPush");
    const { data } = await supabase.from("push_subscriptions").select("morning").eq("endpoint", sub.endpoint).maybeSingle();
    cb.checked = data ? data.morning !== false : true;
    cb.disabled = false;
    cb.onchange = async () => {
      const { error } = await supabase.from("push_subscriptions").update({ morning: cb.checked }).eq("endpoint", sub.endpoint);
      if (error) { cb.checked = !cb.checked; return toast("変更できませんでした: " + error.message, 6000); }
      toast(cb.checked ? "毎朝のお知らせをオンにしました" : "毎朝のお知らせをオフにしました");
    };
  } else {
    box.innerHTML = `<button type="button" id="enablePush" class="primary">この端末で通知をオンにする</button>`;
    $("#enablePush").onclick = enablePush;
  }
}

async function enablePush() {
  // iPhone では、ボタンを押した直後に許可を求める必要がある
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    toast("通知が許可されませんでした。iPhone の「設定」→「通知」→「こえメモ」から許可できます", 6000);
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(VAPID_PUBLIC_KEY) }));
    const j = sub.toJSON();
    const { error } = await supabase.from("push_subscriptions")
      .upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
    if (error) throw error;
    toast("通知をオンにしました");
  } catch (e) {
    console.error(e);
    toast("通知をオンにできませんでした: " + (e.message || e), 6000);
  }
  renderPushBox();
}

async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  }
  toast("この端末の通知をオフにしました");
  renderPushBox();
}

async function testPush() {
  const { error } = await supabase.functions.invoke("ai-memo", { body: { action: "test-push" } });
  toast(error ? "送れませんでした: " + (await errorMessage(error)) : "テスト通知を送りました", 5000);
}

// ---------- ショートカット用の鍵 ----------
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function issueToken() {
  if (!confirm("ショートカット用の鍵を発行しますか？（前に発行した鍵は使えなくなります）")) return;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await supabase.from("quick_tokens").delete().eq("user_id", session.user.id);
  const { error } = await supabase.from("quick_tokens").insert({ token_hash: await sha256Hex(token) });
  if (error) return toast("発行できませんでした: " + error.message, 6000);
  $("#tokenBox").innerHTML = `
    <p class="muted">この鍵はこの画面でしか表示されません。ショートカットの設定に貼り付けてください。</p>
    <input type="text" id="tokenValue" readonly value="${esc(token)}">
    <div class="btn-row"><button type="button" id="copyToken">鍵をコピー</button></div>
    <p class="muted">送信先URL: ${esc(SUPABASE_URL)}/functions/v1/ai-memo</p>`;
  $("#copyToken").onclick = async () => {
    try { await navigator.clipboard.writeText(token); toast("コピーしました"); }
    catch { $("#tokenValue").select(); toast("選択しました。コピーしてください"); }
  };
}

async function logout() {
  if (Object.values(memos).some((m) => m._dirty)) await sync();
  if (Object.values(memos).some((m) => m._dirty) &&
      !confirm("まだ同期されていないメモがあります。ログアウトするとこの端末から消えます。続けますか？")) return;
  await supabase.auth.signOut();
  memos = {};
  localStorage.removeItem(LS_CURSOR);
  persist();
  render();
  menuDialog.close();
  toast("ログアウトしました");
}

// エクスポート
document.querySelectorAll("[data-export]").forEach((b) =>
  b.addEventListener("click", () => exportAs(b.dataset.export)));

function exportAs(kind) {
  const list = liveMemos();
  const stamp = new Date().toLocaleDateString("sv-SE");
  let body, type, ext;
  if (kind === "md") {
    body = `# こえメモ（${stamp} 書き出し）\n\n` + list.map((m) => {
      let s = `## ${formatDateTime(m.created_at)}${m.pinned ? " 📌" : ""}${(m.photos || []).length ? " 📷（写真あり）" : ""}\n\n${m.text}\n`;
      if (m.is_question && m.answer) s += `\n> **AIの回答**\n>\n${m.answer.split("\n").map((l) => "> " + l).join("\n")}\n`;
      for (const t of m.thread || []) {
        s += `\n**質問**：${t.q}\n\n> ${t.a.split("\n").join("\n> ")}\n`;
      }
      if (m.todos.length) s += "\n" + m.todos.map((t) => `- [${t.done ? "x" : " "}] ${t.text}${t.due ? `（期限 ${dueLabel(t)}）` : ""}`).join("\n") + "\n";
      if (m.tags.length) s += `\n${m.tags.map((t) => "#" + t).join(" ")}\n`;
      return s;
    }).join("\n");
    type = "text/markdown"; ext = "md";
  } else if (kind === "csv") {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["日時", "本文", "要約", "タグ", "AIの回答", "ToDo", "ピン留め"]];
    for (const m of list) {
      rows.push([formatDateTime(m.created_at), m.text, m.summary, m.tags.join(" "), m.answer,
        m.todos.map((t) => `${t.done ? "[x]" : "[ ]"} ${t.text}`).join(" / "), m.pinned ? "○" : ""]);
    }
    body = "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n"); // BOM付きでExcelの文字化けを防ぐ
    type = "text/csv"; ext = "csv";
  } else {
    body = JSON.stringify(list.map(toRow), null, 2);
    type = "application/json"; ext = "json";
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = `koememo-${stamp}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- タブ・検索 ----------
function switchView(view) {
  currentView = view;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  memosView.hidden = view !== "memos";
  todosView.hidden = view !== "todos";
  moneyView.hidden = view !== "money";
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));

// 日本語の変換確定・音声入力・検索キーなど、どの入力方法でも検索が動くようにする
let searchTimer, lastQuery = "";
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (searchInput.value === lastQuery) return;
    lastQuery = searchInput.value;
    if (currentView !== "memos") switchView("memos");
    renderMemos();
  }, 150);
}
for (const ev of ["input", "compositionend", "change", "search", "keyup"]) {
  searchInput.addEventListener(ev, onSearch);
}
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) searchInput.blur(); // 検索キーでキーボードを閉じて結果を見やすく
});

// ---------- 起動 ----------
window.addEventListener("online", sync);
window.addEventListener("offline", updateStatus);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync(); });
setInterval(sync, 60_000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW 登録失敗", e));
}

render();
updateStatus();
// 通知から開いたときは ToDo タブを表示
const startView = new URLSearchParams(location.search).get("view");
if (startView === "todos" || startView === "money") switchView(startView);

if (supabase) {
  const { data } = await supabase.auth.getSession();
  session = data.session;
  supabase.auth.onAuthStateChange((_event, s) => {
    const was = !!session;
    session = s;
    if (s && !was) { startRealtime(); sync(); }
    if (!s) { stopRealtime(); updateStatus(); }
    render();
  });
  if (session) { startRealtime(); sync(); }
  updateStatus();
}
