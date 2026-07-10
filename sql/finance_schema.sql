-- Finance app schema for NUL Systems.
-- Run this in the Supabase SQL editor (Project → SQL Editor → New query).
--
-- Idempotent: safe to run whether your DB is fresh, partially set up, or
-- already has these tables from an earlier version (including the old
-- 'skipped' status value, which gets migrated to 'cancelled' below).
-- Re-running this script does nothing destructive.
--
-- Assumption: mirrors the existing tables (stations/workouts), which never
-- receive a user_id from client code, implying user_id defaults to
-- auth.uid() with RLS restricting rows to their owner. Check your existing
-- `stations` table definition in the Supabase dashboard if something here
-- doesn't match your actual setup.

create table if not exists finance_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  color text,
  created_at timestamptz not null default now()
);

create table if not exists finance_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  category_id uuid references finance_categories(id) on delete set null,
  name text not null,
  amount numeric(12, 2) not null,
  kind text not null check (kind in ('subscription', 'one_time')),
  recurrence_interval text check (recurrence_interval in ('weekly', 'monthly', 'yearly')),
  next_due_date date not null,
  reminder_days_before integer not null default 3,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists finance_expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  category_id uuid references finance_categories(id) on delete set null,
  amount numeric(12, 2) not null,
  note text,
  occurred_at timestamptz not null default now(),
  source_payment_id uuid references finance_payments(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists finance_payments_next_due_date_idx on finance_payments (next_due_date);
create index if not exists finance_expenses_occurred_at_idx on finance_expenses (occurred_at);
create index if not exists finance_expenses_category_id_idx on finance_expenses (category_id);

-- Row Level Security: every row is only visible/writable by its owner.
alter table finance_categories enable row level security;
alter table finance_payments enable row level security;
alter table finance_expenses enable row level security;

drop policy if exists "finance_categories_select_own" on finance_categories;
drop policy if exists "finance_categories_insert_own" on finance_categories;
drop policy if exists "finance_categories_update_own" on finance_categories;
drop policy if exists "finance_categories_delete_own" on finance_categories;
create policy "finance_categories_select_own" on finance_categories for select using (auth.uid() = user_id);
create policy "finance_categories_insert_own" on finance_categories for insert with check (auth.uid() = user_id);
create policy "finance_categories_update_own" on finance_categories for update using (auth.uid() = user_id);
create policy "finance_categories_delete_own" on finance_categories for delete using (auth.uid() = user_id);

drop policy if exists "finance_payments_select_own" on finance_payments;
drop policy if exists "finance_payments_insert_own" on finance_payments;
drop policy if exists "finance_payments_update_own" on finance_payments;
drop policy if exists "finance_payments_delete_own" on finance_payments;
create policy "finance_payments_select_own" on finance_payments for select using (auth.uid() = user_id);
create policy "finance_payments_insert_own" on finance_payments for insert with check (auth.uid() = user_id);
create policy "finance_payments_update_own" on finance_payments for update using (auth.uid() = user_id);
create policy "finance_payments_delete_own" on finance_payments for delete using (auth.uid() = user_id);

drop policy if exists "finance_expenses_select_own" on finance_expenses;
drop policy if exists "finance_expenses_insert_own" on finance_expenses;
drop policy if exists "finance_expenses_update_own" on finance_expenses;
drop policy if exists "finance_expenses_delete_own" on finance_expenses;
create policy "finance_expenses_select_own" on finance_expenses for select using (auth.uid() = user_id);
create policy "finance_expenses_insert_own" on finance_expenses for insert with check (auth.uid() = user_id);
create policy "finance_expenses_update_own" on finance_expenses for update using (auth.uid() = user_id);
create policy "finance_expenses_delete_own" on finance_expenses for delete using (auth.uid() = user_id);

-- Normalize the status column regardless of prior state: migrate any old
-- 'skipped' rows to 'cancelled', then (re)apply the current check
-- constraint so it always matches what the app expects.
update finance_payments set status = 'cancelled' where status = 'skipped';
alter table finance_payments drop constraint if exists finance_payments_status_check;
alter table finance_payments add constraint finance_payments_status_check
  check (status in ('pending', 'overdue', 'paid', 'cancelled'));
