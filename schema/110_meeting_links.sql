-- 110: each person's own video meeting link (Nov 16, 2026).
-- A video calendar uses the link of whoever takes the booking: on round robin and pick-a-person calendars always,
-- and on a one-person calendar when the calendar has no link of its own. No link anywhere: "link to follow".
-- meeting_mode is for fresh links later (Teams first): 'fixed' uses meeting_link, 'new' makes one per booking,
-- 'none' means no video link from this person.
alter table public.app_users add column if not exists meeting_link text check (meeting_link is null or (meeting_link ~ '^https://' and length(meeting_link) <= 500));
alter table public.app_users add column if not exists meeting_mode text not null default 'fixed' check (meeting_mode in ('fixed', 'new', 'none'));

create or replace function private.cal_location_for(c public.calendars, p_user uuid, p_phone text, p_address text) returns text
language plpgsql stable security definer set search_path = public, private as $$
declare link text;
begin
  if c.location_kind <> 'video' then return private.cal_location(c, p_phone, p_address); end if;
  select case when meeting_mode = 'fixed' then nullif(trim(meeting_link), '') end into link from app_users where id = p_user;
  if link is not null and (c.kind <> 'one' or nullif(trim(c.location_text), '') is null) then return 'Video: ' || link; end if;
  return private.cal_location(c, p_phone, p_address);
end $$;
revoke execute on function private.cal_location_for(public.calendars, uuid, text, text) from public, anon, authenticated;

do $$ declare d text; n text;
begin
  d := pg_get_functiondef('private.cal_book(public.calendars, timestamptz, int, uuid, jsonb, text, text)'::regprocedure);
  n := replace(d, 'private.cal_location(c, v_phone, v_addr)', 'private.cal_location_for(c, who, v_phone, v_addr)');
  if n = d then raise exception 'cal_book did not match; nothing changed'; end if;
  execute n;
  -- a round robin reschedule can move the booking to someone else: their link goes with it
  d := pg_get_functiondef('public.book_reschedule(text, timestamptz)'::regprocedure);
  n := replace(d, 'user_id = who, status = ''rescheduled''', 'user_id = who, location = case when c.location_kind = ''video'' then private.cal_location_for(c, who, a.phone, null) else a.location end, status = ''rescheduled''');
  if n = d then raise exception 'book_reschedule did not match; nothing changed'; end if;
  execute n;
end $$;

-- your own link and how you like meeting links made
create or replace function public.my_meeting_save(p_link text, p_mode text default 'fixed') returns void
language plpgsql security definer set search_path = public, private as $$
declare l text := nullif(trim(coalesce(p_link, '')), '');
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if l is not null and l !~ '^https://[^\s]+$' then raise exception 'Paste the whole link, starting with https://'; end if;
  if p_mode not in ('fixed', 'new', 'none') then raise exception 'Pick how meeting links are made'; end if;
  update app_users set meeting_link = l, meeting_mode = p_mode where id = auth.uid();
end $$;
revoke execute on function public.my_meeting_save(text, text) from public, anon;
grant execute on function public.my_meeting_save(text, text) to authenticated;

-- calendar setup: which of these people have no video link of their own (on this account's team only)
create or replace function public.cal_link_missing(p_users uuid[]) returns uuid[]
language sql stable security definer set search_path = public, private as $$
  select coalesce(array_agg(u.id), '{}') from app_users u
   where u.id = any(coalesce(p_users, '{}')) and private.on_team(u.id, private.current_tenant())
     and not (u.meeting_mode = 'new' or (u.meeting_mode = 'fixed' and nullif(trim(u.meeting_link), '') is not null))
$$;
revoke execute on function public.cal_link_missing(uuid[]) from public, anon;
grant execute on function public.cal_link_missing(uuid[]) to authenticated;
