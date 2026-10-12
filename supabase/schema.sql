-- こえメモ用テーブル
-- Supabase ダッシュボード → SQL Editor にこのファイルの中身を貼り付けて「Run」してください。

create table if not exists public.memos (
  id                uuid primary key,
  user_id           uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text              text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),   -- 端末側の更新時刻（どちらが新しいかの判定用）
  server_updated_at timestamptz not null default now(),   -- サーバー側の更新時刻（差分取得用）
  pinned            boolean not null default false,
  deleted           boolean not null default false,
  ai_status         text not null default 'pending',
  ai_error          text,
  is_question       boolean not null default false,
  answer            text not null default '',
  summary           text not null default '',
  tags              text[] not null default '{}',
  keywords          text[] not null default '{}',
  todos             jsonb not null default '[]'
);

create index if not exists memos_user_server_updated on public.memos (user_id, server_updated_at);

-- 保存のたびにサーバー時刻を記録
create or replace function public.memos_touch() returns trigger
language plpgsql as $$
begin
  new.server_updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists memos_touch on public.memos;
create trigger memos_touch before insert or update on public.memos
for each row execute function public.memos_touch();

-- 行レベルセキュリティ：自分のメモだけ読み書きできる
alter table public.memos enable row level security;

drop policy if exists "own memos" on public.memos;
create policy "own memos" on public.memos
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- リアルタイム同期（PCとiPhoneで即時反映）
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'memos'
  ) then
    alter publication supabase_realtime add table public.memos;
  end if;
end $$;
