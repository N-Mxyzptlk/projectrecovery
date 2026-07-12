-- Adds free-text tags to the guitar catalogue (genre, difficulty, tuning,
-- whatever the user wants), on top of the existing is_liked/is_want_to_play
-- flags. Stored as a text array; empty by default so existing rows don't
-- need backfilling.
alter table guitar_songs
  add column if not exists tags text[] not null default '{}';

-- Third independent flag (same pattern as is_liked/is_want_to_play) marking
-- a song as part of the current play-session setlist.
alter table guitar_songs
  add column if not exists in_setlist boolean not null default false;
