-- ============================================================
-- ByTune cloud schema — paste into Supabase → SQL Editor → Run
-- ============================================================

-- One row per user. The UNIQUE constraint is what guarantees no two
-- accounts can ever claim the same username (the app checks availability
-- first, but the database is the real gate). Usernames are stored lowercase
-- (case-insensitive uniqueness) and may contain only a-z and 0-9.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  created_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[a-z0-9]{3,20}$')
);

-- One row per (user, local store): library, settings, recent-searches.
-- The app upserts the whole store payload; last write wins by updated_at.
create table if not exists public.user_data (
  user_id uuid not null references auth.users(id) on delete cascade,
  store_name text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, store_name)
);

-- Row-Level Security: the shipped anon key is public by design; these
-- policies are the actual security boundary.
alter table public.profiles enable row level security;
alter table public.user_data enable row level security;

-- Username lookups must work while signed out (availability check +
-- resolving a username to its synthetic auth email at sign-in). Only the
-- id/username columns are sensitive-free; passwords never live here.
create policy "username lookup is public"
  on public.profiles for select using (true);

create policy "insert own profile"
  on public.profiles for insert with check (auth.uid() = id);

-- One-time username claim / rename: a user may only ever edit their own row
-- (and cannot re-point the row at another user id). Username uniqueness is
-- still enforced by the UNIQUE constraint, not here.
create policy "update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- user_data: an account can only ever read/write its own rows.
create policy "read own data"
  on public.user_data for select using (auth.uid() = user_id);

create policy "insert own data"
  on public.user_data for insert with check (auth.uid() = user_id);

create policy "update own data"
  on public.user_data for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
