-- 107: Connect Microsoft 365 (Nov 16, 2026). Each person connects their own Microsoft account (Outlook, Teams) from
-- their profile. First thing it does: their Outlook calendar's busy times block bookings on every account they work in,
-- refreshed every 5 minutes (instant-ish, unlike the secret iCal address). Teams links on bookings, mail, contacts and
-- files build on this same connection later.
-- Only calendar and Teams meeting permissions are asked for at first; more are asked for when someone turns on a
-- feature that needs them (Microsoft lets an app add permissions later without reconnecting from scratch).
-- The long-lived key Microsoft hands back (the refresh token) is kept encrypted in Supabase Vault. Only the ms-graph
-- edge function (service key) can read it; the app never sees it.

create table if not exists public.ms_connections (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  ms_id text,                         -- the person's Microsoft account id
  ms_tenant text,                     -- their company's Microsoft directory (or the consumer one)
  email text,
  name text,
  scopes text,
  token_secret uuid,                  -- vault secret holding the refresh token
  status text not null default 'ok' check (status in ('ok', 'expired', 'error')),
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  busy_count int
);
alter table public.ms_connections enable row level security;
drop policy if exists "own microsoft connection" on public.ms_connections;
create policy "own microsoft connection" on public.ms_connections for select using (user_id = auth.uid());
revoke all on public.ms_connections from anon, authenticated;
grant select (user_id, email, name, scopes, status, connected_at, last_sync_at, last_ok_at, last_error, busy_count) on public.ms_connections to authenticated;

-- a sign-in in progress: the state Microsoft echoes back proves who started it (and the PKCE verifier proves it's us)
create table if not exists public.ms_oauth_states (
  state text primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  verifier text not null,
  redirect_uri text not null,
  return_to text,
  created_at timestamptz not null default now()
);
alter table public.ms_oauth_states enable row level security;
revoke all on public.ms_oauth_states from anon, authenticated;

-- the refresh token, in and out of the vault (service key only)
create or replace function public.ms_token_save(p_user uuid, p_token text) returns void
language plpgsql security definer set search_path = public, private as $$
declare sid uuid;
begin
  select token_secret into sid from ms_connections where user_id = p_user;
  if sid is not null and exists (select 1 from vault.secrets where id = sid) then
    perform vault.update_secret(sid, p_token);
  else
    sid := vault.create_secret(p_token, 'ms_refresh_' || p_user::text || '_' || extract(epoch from now())::bigint, 'Microsoft refresh token');
    update ms_connections set token_secret = sid where user_id = p_user;
  end if;
end $$;
create or replace function public.ms_token_read(p_user uuid) returns text
language sql stable security definer set search_path = public, private as $$
  select d.decrypted_secret from ms_connections c join vault.decrypted_secrets d on d.id = c.token_secret where c.user_id = p_user
$$;
create or replace function public.ms_token_drop(p_user uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare sid uuid;
begin
  select token_secret into sid from ms_connections where user_id = p_user;
  delete from ms_connections where user_id = p_user;
  delete from cal_busy where user_id = p_user and source = 'outlook';
  if sid is not null then delete from vault.secrets where id = sid; end if;
end $$;
revoke execute on function public.ms_token_save(uuid, text), public.ms_token_read(uuid), public.ms_token_drop(uuid) from public, anon, authenticated;
grant execute on function public.ms_token_save(uuid, text), public.ms_token_read(uuid), public.ms_token_drop(uuid) to service_role;

-- every 5 minutes: refresh everyone's Outlook busy times
create or replace function private.ms_sync_kick() returns void
language plpgsql security definer set search_path = public, private, extensions as $$
declare s text;
begin
  delete from ms_oauth_states where created_at < now() - interval '1 hour';
  if not exists (select 1 from ms_connections where status <> 'expired') then return; end if;
  select hook_secret into s from private.push_keys where id = 1;
  if s is null then return; end if;
  perform net.http_post(
    url := 'https://stfnpzqymjlxpainmgoo.supabase.co/functions/v1/ms-graph',
    body := jsonb_build_object('kind', 'sync_all', 'secret', s),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 60000);
end $$;
revoke execute on function private.ms_sync_kick() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('ms-sync') where exists (select 1 from cron.job where jobname = 'ms-sync');
    perform cron.schedule('ms-sync', '*/5 * * * *', $c$select private.ms_sync_kick()$c$);
  end if;
end $$;
