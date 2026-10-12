-- こえメモ：通知とショートカット用のテーブル
-- Supabase ダッシュボード → SQL Editor に貼り付けて「Run」してください（schema.sql の後に実行）。

-- 通知を受け取る端末の登録
create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "own subscriptions" on public.push_subscriptions;
create policy "own subscriptions" on public.push_subscriptions
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ショートカット用の鍵（鍵そのものではなくハッシュ値だけを保存）
create table if not exists public.quick_tokens (
  token_hash text primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.quick_tokens enable row level security;
drop policy if exists "own tokens" on public.quick_tokens;
create policy "own tokens" on public.quick_tokens
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 送信済みの通知（同じ通知を二重に送らないため。サーバーだけが使う）
create table if not exists public.reminders_sent (
  key     text primary key,
  sent_at timestamptz not null default now()
);
alter table public.reminders_sent enable row level security;

-- 定期実行に使う拡張機能
create extension if not exists pg_cron;
create extension if not exists pg_net;
