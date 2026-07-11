-- Home page schema for NUL Systems: the synced to-do list shown on the
-- new Home dashboard (desktop command center + mobile compact view), plus
-- an RPC the Admin panel uses to show total database size (a plain client
-- with the anon key can't read pg_database_size directly — it has to go
-- through a SECURITY DEFINER function).
--
-- Run this in the Supabase SQL editor (Project → SQL Editor → New query).
-- Idempotent: safe to run whether your DB is fresh or already has these
-- objects from an earlier version of this script.

create table if not exists todos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  text text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists todos_user_id_idx on todos (user_id);

alter table todos enable row level security;

drop policy if exists "todos_select_own" on todos;
drop policy if exists "todos_insert_own" on todos;
drop policy if exists "todos_update_own" on todos;
drop policy if exists "todos_delete_own" on todos;
create policy "todos_select_own" on todos for select using (auth.uid() = user_id);
create policy "todos_insert_own" on todos for insert with check (auth.uid() = user_id);
create policy "todos_update_own" on todos for update using (auth.uid() = user_id);
create policy "todos_delete_own" on todos for delete using (auth.uid() = user_id);

-- Admin panel's "Database size" stat. SECURITY DEFINER so it can read
-- pg_database_size() (a server-level stat, not row data) without granting
-- broader privileges — every authenticated user gets the same whole-
-- database number back, which is fine for a single-user admin panel.
create or replace function public.get_database_size()
returns bigint
language sql
security definer
set search_path = public
as $$
  select pg_database_size(current_database());
$$;

grant execute on function public.get_database_size() to authenticated;
