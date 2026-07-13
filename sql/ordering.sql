-- Manual drag-to-reorder for the Guitar catalogue and Movies watchlist.
-- Nullable + defaulted to 0 so existing rows don't need backfilling; the
-- app treats ties (multiple 0s) as "insertion order" via created_at.
alter table guitar_songs
  add column if not exists sort_order integer not null default 0;

alter table movies_watchlist
  add column if not exists sort_order integer not null default 0;

-- Per-account nav customization (which apps show in the sidebar/drawer,
-- and in what order) — synced across desktop and mobile like
-- auto_logout_minutes already is. Null means "use the built-in default
-- list/order", so existing profiles don't need backfilling either.
alter table profiles
  add column if not exists nav_apps jsonb;
