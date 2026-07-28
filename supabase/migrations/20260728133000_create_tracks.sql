create table if not exists public.tracks (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.tracks enable row level security;

revoke all on table public.tracks from anon;
grant select, insert, update, delete on table public.tracks to authenticated;

drop policy if exists "Users can read own tracks" on public.tracks;
create policy "Users can read own tracks"
on public.tracks for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own tracks" on public.tracks;
create policy "Users can insert own tracks"
on public.tracks for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update own tracks" on public.tracks;
create policy "Users can update own tracks"
on public.tracks for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete own tracks" on public.tracks;
create policy "Users can delete own tracks"
on public.tracks for delete
to authenticated
using ((select auth.uid()) = user_id);

create index if not exists tracks_user_updated_idx
on public.tracks (user_id, updated_at desc);
