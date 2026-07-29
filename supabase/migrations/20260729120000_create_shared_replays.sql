create table if not exists public.shared_replays (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  token uuid not null unique default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  gpx_content text not null check (
    octet_length(gpx_content) > 0 and
    octet_length(gpx_content) <= 26214400
  ),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

alter table public.shared_replays enable row level security;

revoke all on table public.shared_replays from anon;
grant select, insert, delete on table public.shared_replays to authenticated;

drop policy if exists "Owners can read shared replays" on public.shared_replays;
create policy "Owners can read shared replays"
on public.shared_replays for select
to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists "Owners can create shared replays" on public.shared_replays;
create policy "Owners can create shared replays"
on public.shared_replays for insert
to authenticated
with check ((select auth.uid()) = owner_id);

drop policy if exists "Owners can revoke shared replays" on public.shared_replays;
create policy "Owners can revoke shared replays"
on public.shared_replays for delete
to authenticated
using ((select auth.uid()) = owner_id);

create index if not exists shared_replays_owner_created_idx
on public.shared_replays (owner_id, created_at desc);

create or replace function public.get_shared_replay(p_token uuid)
returns table (
  name text,
  gpx_content text,
  settings jsonb,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select replay.name, replay.gpx_content, replay.settings, replay.created_at
  from public.shared_replays as replay
  where replay.token = p_token
    and (replay.expires_at is null or replay.expires_at > now())
  limit 1;
$$;

revoke all on function public.get_shared_replay(uuid) from public;
grant execute on function public.get_shared_replay(uuid) to anon, authenticated;
