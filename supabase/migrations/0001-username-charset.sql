-- ============================================================
-- Migration 0001 — widen the username charset to include `_` and `@`
-- ============================================================
-- For projects created with an older schema.sql, whose
-- profiles.username_format CHECK only allowed ^[a-z0-9]{3,20}$.
-- Fresh setups that ran the current schema.sql already have the new
-- constraint and can skip this file.
--
-- Paste into Supabase → SQL Editor → Run. Safe to re-run.

alter table public.profiles drop constraint if exists username_format;
alter table public.profiles
  add constraint username_format check (username ~ '^[a-z0-9_@]{3,20}$');
