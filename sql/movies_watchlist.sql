-- Movies/TV watchlist: things to watch, which platform(s) they're on, and
-- whether it's a movie or a TV show. Platforms are a free-text array (not
-- an enum) so custom/less common services can be added from the UI same
-- as the built-in presets.
create table if not exists movies_watchlist (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  media_type text not null default 'movie' check (media_type in ('movie', 'tv')),
  platforms text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- Same blanket "any signed-in user" access as the rest of this single-user
-- app's tables — adjust here if that's not actually the existing policy
-- shape once you check against another table's policy in the dashboard.
alter table movies_watchlist enable row level security;

create policy "Authenticated users can manage movies_watchlist" on movies_watchlist
  for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');
