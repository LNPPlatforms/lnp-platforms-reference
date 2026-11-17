-- 116: a fresh Microsoft Teams link for every booking (Nov 16, 2026).
-- Someone who picks "A new Teams meeting for every booking" (meeting_mode 'new') and has Microsoft 365 connected gets a
-- Teams meeting made for each video booking that goes to them. The booking saves right away with "Microsoft Teams
-- (link coming)"; the ms-graph function makes the meeting a moment later, puts the link on the appointment, and only
-- then lets the confirmation and team notice emails go out (so they carry the link). If Microsoft fails, the emails
-- go out anyway with "link to follow" and the person is told.
create or replace function private.cal_location_for(c public.calendars, p_user uuid, p_phone text, p_address text) returns text
language plpgsql stable security definer set search_path = public, private as $$
declare link text; mode text; ms boolean;
begin
  if c.location_kind <> 'video' then return private.cal_location(c, p_phone, p_address); end if;
  select meeting_mode, case when meeting_mode = 'fixed' then nullif(trim(meeting_link), '') end into mode, link from app_users where id = p_user;
  if mode = 'new' then
    ms := exists (select 1 from ms_connections m where m.user_id = p_user and m.status <> 'expired');
    if ms then return 'Video: Microsoft Teams (link coming)'; end if;
  end if;
  if link is not null and (c.kind <> 'one' or nullif(trim(c.location_text), '') is null) then return 'Video: ' || link; end if;
  return private.cal_location(c, p_phone, p_address);
end $$;

-- hold the first emails of a booking whose Teams link is still being made (ms-graph sends them when it's done)
create or replace function private.cal_mail_send() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.kind in ('confirm', 'notice', 'reschedule', 'reschedule_notice')
     and exists (select 1 from appointments a where a.id = new.appointment_id and a.location = 'Video: Microsoft Teams (link coming)') then
    return null;
  end if;
  perform private.cal_mail_hook(new.id);
  return null;
end $$;

-- a booking (or a reschedule to someone else, or a new time) that needs a Teams link: ask ms-graph to make one
create or replace function private.cal_teams_kick() returns trigger
language plpgsql security definer set search_path = public, private, extensions as $$
declare s text;
begin
  if new.status = 'cancelled' then return null; end if;
  -- only while the link is still owed (a new booking, or a reschedule that handed it to someone who makes Teams meetings);
  -- an existing Teams link keeps working after a time change, so it is left alone
  if new.location is distinct from 'Video: Microsoft Teams (link coming)' then return null; end if;
  if tg_op = 'UPDATE' and old.location is not distinct from new.location and new.user_id is not distinct from old.user_id then return null; end if;
  select hook_secret into s from private.push_keys where id = 1;
  if s is null then return null; end if;
  perform net.http_post(url := 'https://stfnpzqymjlxpainmgoo.supabase.co/functions/v1/ms-graph',
    body := jsonb_build_object('kind', 'meeting', 'id', new.id, 'secret', s), headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 20000);
  return null;
exception when others then return null;
end $$;
drop trigger if exists cal_teams_kick on public.appointments;
create trigger cal_teams_kick after insert or update of user_id, starts_at, ends_at, location, status on public.appointments for each row execute function private.cal_teams_kick();

-- for ms-graph: what to make the meeting for (service role only)
create or replace function public.ms_meeting_info(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('id', a.id, 'user_id', a.user_id, 'starts_at', a.starts_at, 'ends_at', a.ends_at, 'title', coalesce(a.title, c.name), 'location', a.location,
    'mode', (select meeting_mode from app_users where id = a.user_id))
    from appointments a left join calendars c on c.id = a.calendar_id where a.id = p_id
$$;

-- for ms-graph: the link (or null when Microsoft failed), then send the emails that were waiting on it
create or replace function public.ms_meeting_done(p_id uuid, p_url text, p_error text default null) returns void
language plpgsql security definer set search_path = public, private as $$
declare m record; a appointments;
begin
  select * into a from appointments where id = p_id;
  if not found then return; end if;
  perform set_config('cal.quiet', '1', true);
  update appointments set location = case when p_url ~ '^https://' then 'Video: ' || p_url else 'Video call (link to follow)' end, updated_at = now() where id = p_id;
  if p_url is null or p_url !~ '^https://' then
    perform private.notify(a.user_id, 'appointment', 'Teams link not made', 'Microsoft didn''t make a Teams meeting for ' || coalesce(a.name, 'a booking')
      || '. Add a link to the appointment, or reconnect Microsoft under My availability.' || coalesce(' (' || left(p_error, 150) || ')', ''), '#calendar');
  end if;
  for m in select id from private.cal_mail where appointment_id = p_id and status = 'queued' and tries = 0 loop
    perform private.cal_mail_hook(m.id);
  end loop;
end $$;
revoke execute on function public.ms_meeting_info(uuid), public.ms_meeting_done(uuid, text, text) from public, anon, authenticated;
grant execute on function public.ms_meeting_info(uuid), public.ms_meeting_done(uuid, text, text) to service_role;
revoke execute on function private.cal_teams_kick(), private.cal_mail_send() from public, anon, authenticated;
