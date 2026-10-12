import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
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
  "is_question", "answer", "summary", "tags", "keywords", "todos"];

function toRow(m) {
  const row = {};
  for (const k of COLUMNS) row[k] = m[k] ?? null;
  return row;
}
function fromRow(r) {
  const m = {};
  for (const k of COLUMNS) m[k] = r[k];
  m.created_at = new Date(r.created_at).toISOString();
  m.updated_at = new Date(r.updated_at).toISOString();
  m.tags ||= []; m.keywords ||= []; m.todos ||= [];
  m.text ||= ""; m.answer ||= ""; m.summary ||= "";
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
let syncing = false, syncAgain = false, syncTimer = null, realtimeChannel = null;

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
  } catch (e) {
    console.error(e);
    setStatus("同期エラー", "warn");
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
        body: { text: m.text, created_at: m.created_at },
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
  return newTodos.map((t) => ({ text: t.text, due: t.due || "", done: doneSet.has(t.text) }));
}

// ---------- あいまい検索 ----------
// 全角/半角・大文字/小文字・カタカナ/ひらがなの違いを吸収する
function norm(s) {
  return (s || "").normalize("NFKC").toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

function search(list, query) {
  const docs = list.map((m) => ({
    m,
    t: norm(m.text),
    s: norm(m.summary),
    g: norm([...m.tags, ...m.keywords].join(" ")),
    a: norm(m.answer),
    d: formatDateTime(m.created_at) + " " + m.created_at.slice(0, 10),
  }));
  const fuse = new Fuse(docs, {
    keys: [
      { name: "t", weight: 0.45 },
      { name: "g", weight: 0.25 },
      { name: "s", weight: 0.15 },
      { name: "a", weight: 0.1 },
      { name: "d", weight: 0.05 },
    ],
    threshold: 0.4,
    ignoreLocation: true,
    includeScore: true,
  });
  // スペース区切りの語はすべて含むもの（AND）
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  let scores = null;
  for (const tok of tokens) {
    const hit = new Map(fuse.search(tok).map((r) => [r.item.m.id, r.score]));
    if (!scores) scores = hit;
    else for (const id of [...scores.keys()]) {
      if (hit.has(id)) scores.set(id, scores.get(id) + hit.get(id)); else scores.delete(id);
    }
  }
  return [...(scores || new Map()).entries()].sort((a, b) => a[1] - b[1]).map(([id]) => memos[id]);
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
    const hits = search(list, q);
    html += `<div class="day-head">検索結果 ${hits.length}件</div>`;
    html += hits.map((m) => cardHTML(m, true)).join("") || `<p class="empty">見つかりませんでした</p>`;
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
}

function cardHTML(m, showDate) {
  const when = showDate ? formatDateTime(m.created_at) : formatTime(m.created_at);
  let ai = "";
  if (m.ai_status === "pending") {
    ai = `<div class="ai-state">🤖 AI解析待ち${session ? "…" : "（ログインすると処理されます）"}</div>`;
  } else if (m.ai_status === "error") {
    ai = `<div class="ai-state">⚠️ AI解析に失敗: ${esc(m.ai_error)} <button class="tag" data-act="retry" data-id="${m.id}">再試行</button></div>`;
  }
  const answer = m.is_question && m.answer
    ? `<details class="answer" open><summary>🤖 AIの回答</summary>${esc(m.answer)}</details>` : "";
  const summary = m.summary && m.summary !== m.text ? `<div class="summary">${esc(m.summary)}</div>` : "";
  const tags = m.tags.length
    ? `<div class="tags">${m.tags.map((t) => `<button class="tag" data-act="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join("")}</div>` : "";
  const todos = m.todos.length
    ? `<ul class="mini-todos">${m.todos.map((t) => `<li class="${t.done ? "done" : ""}">${esc(t.text)}${t.due ? `（${esc(t.due)}）` : ""}</li>`).join("")}</ul>` : "";
  return `
    <article class="card ${m.pinned ? "pinned" : ""}">
      <div class="card-head">
        <span class="time">${esc(when)}${m._dirty && session ? " ・未同期" : ""}</span>
        <button data-act="pin" data-id="${m.id}" class="${m.pinned ? "on" : ""}" aria-label="ピン留め">📌</button>
        <button data-act="edit" data-id="${m.id}" aria-label="編集">✏️</button>
      </div>
      <div class="card-text">${esc(m.text)}</div>
      ${summary}${answer}${todos}${tags}${ai}
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
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
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
        ${t.due ? `<div class="due ${!t.done && t.due < today ? "overdue" : ""}">期限: ${esc(t.due)}</div>` : ""}
        <button class="src" data-act="edit" data-id="${t.memo.id}">元のメモ（${esc(formatDateTime(t.memo.created_at))}）</button>
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
function toast(msg, ms = 3000) {
  const el = $("#toast");
  el.textContent = msg;
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

// ---------- 音声入力 ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = $("#micBtn");
let rec = null, recording = false, baseText = "", finalText = "", idleRestarts = 0;

function autoSaveEnabled() {
  return localStorage.getItem(LS_AUTOSAVE) !== "0";
}

function joinText(a, b) {
  return a && b ? a.replace(/\s+$/, "") + "\n" + b : a + b;
}

function startRec() {
  if (!SR) {
    toast("このブラウザは音声認識に未対応です。キーボードのマイクボタンで音声入力できます", 5000);
    compose.focus();
    return;
  }
  rec = new SR();
  rec.lang = "ja-JP";
  rec.continuous = true;
  rec.interimResults = true;
  baseText = compose.value;
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
    compose.value = joinText(baseText, finalText);
    interimEl.textContent = interim;
    interimEl.hidden = !interim;
    autoGrow();
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      recording = false;
      toast("マイク（音声認識）の使用が許可されていません。設定を確認してください", 5000);
    }
  };
  rec.onend = () => {
    // iPhone は無音が続くと自動で止まるので、録音中なら再開する（無音が続けば終了）
    if (recording && idleRestarts < 3) {
      idleRestarts++;
      baseText = compose.value;
      finalText = "";
      try { rec.start(); return; } catch {}
    }
    finishRec();
  };

  recording = true;
  micBtn.classList.add("rec");
  micBtn.setAttribute("aria-label", "録音を停止");
  try { rec.start(); } catch (e) { finishRec(); }
}

function stopRec() {
  recording = false;
  rec?.stop();
}

function finishRec() {
  recording = false;
  rec = null;
  micBtn.classList.remove("rec");
  micBtn.setAttribute("aria-label", "音声入力");
  interimEl.hidden = true;
  if (autoSaveEnabled() && compose.value.trim()) saveCompose();
}

micBtn.addEventListener("click", () => (recording ? stopRec() : startRec()));

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
  }
});

document.addEventListener("change", (e) => {
  const cb = e.target.closest('[data-act="todo"]');
  if (!cb) return;
  const m = memos[cb.dataset.id];
  m.todos = m.todos.map((t, i) => (i === Number(cb.dataset.index) ? { ...t, done: cb.checked } : t));
  touch(m);
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
  if (!m || !confirm("このメモを削除しますか？")) return;
  Object.assign(m, { deleted: true, text: "", answer: "", summary: "", tags: [], keywords: [], todos: [] });
  touch(m);
  editDialog.close();
  toast("削除しました");
});

// ---------- メニュー（アカウント・エクスポート） ----------
const menuDialog = $("#menuDialog");
$("#menuBtn").addEventListener("click", () => {
  renderAccount();
  $("#autoSaveVoice").checked = autoSaveEnabled();
  menuDialog.showModal();
});
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
      </div>`;
    $("#syncNow").onclick = () => { sync(); toast("同期しています"); };
    $("#logout").onclick = logout;
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
      let s = `## ${formatDateTime(m.created_at)}${m.pinned ? " 📌" : ""}\n\n${m.text}\n`;
      if (m.is_question && m.answer) s += `\n> **AIの回答**\n>\n${m.answer.split("\n").map((l) => "> " + l).join("\n")}\n`;
      if (m.todos.length) s += "\n" + m.todos.map((t) => `- [${t.done ? "x" : " "}] ${t.text}${t.due ? `（期限 ${t.due}）` : ""}`).join("\n") + "\n";
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
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));

let searchTimer;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (currentView !== "memos") switchView("memos");
    renderMemos();
  }, 150);
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
