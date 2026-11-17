-- 106: connected calendars (Nov 16, 2026). Each person pastes the secret iCal address of their Google, Outlook or
-- Apple calendar under the gear menu > Connected calendars. Every 10 minutes the cal-sync function reads each feed and
-- refreshes that person's busy times (cal_busy) for the next 60 days. Busy times belong to the person, not an account,
-- so one feed blocks their time on every account they work in (GELP, Cognix, Essential Services...). Booking already
-- skips cal_busy (078c), so nothing else changes.
-- The address is a secret: it's saved once and never sent back to the app, which only sees a short hint of it.
create table if not exists public.cal_feeds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade default auth.uid(),
  label text not null check (length(trim(label)) between 1 and 60),
  url text not null,
  url_hint text not null,
  last_try_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  events int,
  sync_now boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists cal_feeds_user on public.cal_feeds (user_id);
alter table public.cal_feeds enable row level security;
drop policy if exists "own feeds" on public.cal_feeds;
create policy "own feeds" on public.cal_feeds for select using (user_id = auth.uid());
revoke all on public.cal_feeds from anon, authenticated;
-- everything but the address itself
grant select (id, user_id, label, url_hint, last_try_at, last_ok_at, last_error, events, sync_now, created_at) on public.cal_feeds to authenticated;

-- busy times from a feed go away with the feed
alter table public.cal_busy add column if not exists feed_id uuid references public.cal_feeds(id) on delete cascade;
create index if not exists cal_busy_feed on public.cal_busy (feed_id);

create or replace function public.my_cal_feed_add(p_label text, p_url text) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare u text := trim(coalesce(p_url, '')); h text; v uuid;
begin
  if auth.uid() is null then raise exception 'Sign in again'; end if;
  u := regexp_replace(u, '^webcals?://', 'https://', 'i');
  if u !~* '^https://[a-z0-9.-]+\.[a-z]{2,}(:[0-9]+)?/\S+$' then raise exception 'Paste the full calendar address that starts with https:// (or webcal://)'; end if;
  if length(u) > 2000 then raise exception 'That address is too long'; end if;
  if (select count(*) from cal_feeds where user_id = auth.uid()) >= 10 then raise exception 'Ten calendars at most'; end if;
  if exists (select 1 from cal_feeds where user_id = auth.uid() and url = u) then raise exception 'That calendar is already connected'; end if;
  h := substring(u from '^https://([^/]+)') || '/…' || right(regexp_replace(u, '\?.*$', ''), 12);
  insert into cal_feeds (user_id, label, url, url_hint) values (auth.uid(), trim(coalesce(nullif(trim(p_label), ''), 'My calendar')), u, h) returning id into v;
  return v;
end $$;

create or replace function public.my_cal_feed_remove(p_id uuid) returns void
language sql security definer set search_path = public, private as $$
  delete from cal_feeds where id = p_id and user_id = auth.uid()
$$;

create or replace function public.my_cal_feed_rename(p_id uuid, p_label text) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if length(coalesce(trim(p_label), '')) < 1 then raise exception 'Give it a name'; end if;
  update cal_feeds set label = left(trim(p_label), 60) where id = p_id and user_id = auth.uid();
end $$;

revoke execute on function public.my_cal_feed_add(text, text), public.my_cal_feed_remove(uuid), public.my_cal_feed_rename(uuid, text) from public, anon;
grant execute on function public.my_cal_feed_add(text, text), public.my_cal_feed_remove(uuid), public.my_cal_feed_rename(uuid, text) to authenticated;

-- every 10 minutes: tell cal-sync to read every feed (same secret as the other database hooks)
create or replace function private.cal_sync_kick() returns void
language plpgsql security definer set search_path = public, private, extensions as $$
declare s text;
begin
  if not exists (select 1 from cal_feeds) then return; end if;
  select hook_secret into s from private.push_keys where id = 1;
  if s is null then return; end if;
  perform net.http_post(
    url := 'https://stfnpzqymjlxpainmgoo.supabase.co/functions/v1/cal-sync',
    body := jsonb_build_object('kind', 'all', 'secret', s),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 60000);
end $$;
revoke execute on function private.cal_sync_kick() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('cal-sync') where exists (select 1 from cron.job where jobname = 'cal-sync');
    perform cron.schedule('cal-sync', '*/10 * * * *', $c$select private.cal_sync_kick()$c$);
  end if;
end $$;
