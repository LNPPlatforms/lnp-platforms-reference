-- 078c: booking calendars, part 3. Open times.
-- A start time is open for a person when:
--   * it sits inside their hours that day (a date override wins over the week; an override with no ranges is a day off),
--     starting at the start of a range and every slot_min minutes after, with the whole length inside the range;
--   * it's at least the calendar's minimum notice from now and no further out than its booking window;
--   * nothing they're already doing overlaps it: appointments in ANY account they work in (their buffers count),
--     jobs and dispatch visits with times that they lead or are on the crew of, and outside busy times (cal_busy);
--     the new appointment's own buffers before and after have to be clear too;
--   * they haven't hit the calendar's daily max that day.
-- Hours, overrides and days are read in the person's time zone (cal_hours.time_zone, else the calendar's).

-- who takes bookings on a calendar: the people on it who are still on the account's team (home or member).
-- One person calendars use the first one only.
create or replace function private.cal_people(c public.calendars) returns uuid[]
language sql stable security definer set search_path = public, private as $$
  select coalesce((select array_agg(u order by o) from unnest(c.user_ids) with ordinality x(u, o)
                    where private.on_team(u, c.tenant_id) and (c.kind <> 'one' or o = (select min(o2) from unnest(c.user_ids) with ordinality y(u2, o2)
                                                                                     where private.on_team(u2, c.tenant_id)))), '{}'::uuid[])
$$;

-- busy times for one person between two moments. pad: appointments grow by their own buffers.
create or replace function private.cal_busy_for(p_user uuid, p_from timestamptz, p_to timestamptz, p_ignore uuid, p_pad boolean) returns tstzrange[]
language sql stable security definer set search_path = public, private as $$
  select coalesce(array_agg(r), '{}'::tstzrange[]) from (
    select case when p_pad then tstzrange(a.starts_at - make_interval(mins => a.buffer_before), a.ends_at + make_interval(mins => a.buffer_after))
                else tstzrange(a.starts_at, a.ends_at) end r
      from appointments a
     where a.user_id = p_user and a.status <> 'cancelled' and a.id is distinct from p_ignore
       and a.starts_at < p_to + interval '1 day' and a.ends_at > p_from - interval '1 day'
    union all
    select tstzrange(j.scheduled_start, greatest(coalesce(j.scheduled_end, j.scheduled_start + interval '1 hour'), j.scheduled_start + interval '1 minute'))
      from jobs j
     where j.scheduled_start is not null and j.archived_at is null and j.status not in ('cancelled', 'no_show')
       and j.scheduled_start < p_to + interval '1 day' and coalesce(j.scheduled_end, j.scheduled_start + interval '1 hour') > p_from - interval '1 day'
       and (j.assigned_to = p_user or exists (select 1 from job_crew jc where jc.job_id = j.id and jc.user_id = p_user and jc.removed_at is null))
    union all
    select tstzrange(b.starts_at, b.ends_at) from cal_busy b
     where b.user_id = p_user and b.starts_at < p_to + interval '1 day' and b.ends_at > p_from - interval '1 day') x
$$;

-- the ranges someone works on a day: [[start, end], ...] as times of day
create or replace function private.cal_day_ranges(p_tenant uuid, p_user uuid, p_day date, p_weekly jsonb) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce((select o.ranges from cal_overrides o where o.tenant_id = p_tenant and o.user_id = p_user and o.day = p_day),
                  p_weekly->(extract(dow from p_day)::int::text), '[]'::jsonb)
$$;

create or replace function private.cal_default_week() returns jsonb language sql immutable set search_path = pg_catalog as $$
  select '{"1":[["09:00","17:00"]],"2":[["09:00","17:00"]],"3":[["09:00","17:00"]],"4":[["09:00","17:00"]],"5":[["09:00","17:00"]]}'::jsonb
$$;

-- open start times for one person on a calendar between two moments
create or replace function private.cal_person_slots(c public.calendars, p_user uuid, p_from timestamptz, p_to timestamptz, p_dur int, p_ignore uuid default null)
returns setof timestamptz
language plpgsql stable security definer set search_path = public, private as $$
declare h cal_hours; tz text; wk jsonb; d date; r jsonb; s timestamptz; e timestamptz; rs timestamptz; re timestamptz;
  earliest timestamptz := now() + make_interval(mins => c.notice_min); latest timestamptz := now() + make_interval(days => c.ahead_days);
  dur interval := make_interval(mins => p_dur); step interval := make_interval(mins => c.slot_min);
  bb interval := make_interval(mins => c.buffer_before); ba interval := make_interval(mins => c.buffer_after);
  raw tstzrange[]; padded tstzrange[]; n int;
begin
  if p_from is null or p_to is null or p_to <= p_from or p_dur is null or p_dur < 5 then return; end if;
  select * into h from cal_hours where tenant_id = c.tenant_id and user_id = p_user;
  tz := coalesce(h.time_zone, c.time_zone, 'America/Chicago');
  wk := coalesce(h.weekly, private.cal_default_week());
  p_from := greatest(p_from, earliest); p_to := least(p_to, latest + interval '1 second');
  if p_to <= p_from then return; end if;
  raw := private.cal_busy_for(p_user, p_from, p_to, p_ignore, false);
  padded := private.cal_busy_for(p_user, p_from, p_to, p_ignore, true);
  for d in select generate_series((p_from at time zone tz)::date, (p_to at time zone tz)::date, interval '1 day')::date loop
    if c.daily_max is not null then
      select count(*) into n from appointments a
       where a.calendar_id = c.id and a.user_id = p_user and a.status <> 'cancelled' and a.id is distinct from p_ignore
         and (a.starts_at at time zone tz)::date = d;
      continue when n >= c.daily_max;
    end if;
    for r in select * from jsonb_array_elements(private.cal_day_ranges(c.tenant_id, p_user, d, wk)) loop
      begin
        rs := (d + (r->>0)::time) at time zone tz;
        re := case when r->>1 in ('24:00', '24:00:00') then ((d + 1)::timestamp at time zone tz) else (d + (r->>1)::time) at time zone tz end;
      exception when others then continue;   -- a bad range never breaks the page
      end;
      s := rs;
      while s + dur <= re loop
        e := s + dur;
        if s >= p_from and s < p_to
           and not exists (select 1 from unnest(raw) x where x && tstzrange(s - bb, e + ba))
           and not exists (select 1 from unnest(padded) x where x && tstzrange(s, e)) then
          return next s;
        end if;
        s := s + step;
      end loop;
    end loop;
  end loop;
end $$;

-- every open start on a calendar, with who could take it. p_user narrows to one person (pick a person, reschedules).
create or replace function private.cal_slots(c public.calendars, p_from timestamptz, p_to timestamptz, p_dur int, p_user uuid default null, p_ignore uuid default null)
returns table (user_id uuid, starts_at timestamptz)
language sql stable security definer set search_path = public, private as $$
  select u, s from unnest(private.cal_people(c)) u, private.cal_person_slots(c, u, p_from, p_to, p_dur, p_ignore) s
   where p_user is null or u = p_user
$$;

-- the lengths a customer may pick
create or replace function private.cal_lengths(c public.calendars) returns int[]
language sql immutable set search_path = pg_catalog as $$
  select array(select distinct x from unnest(array[c.duration_min] || coalesce(c.durations, '{}')) x where x between 5 and 720 order by x)
$$;

revoke execute on function private.cal_people(public.calendars), private.cal_busy_for(uuid, timestamptz, timestamptz, uuid, boolean),
  private.cal_day_ranges(uuid, uuid, date, jsonb), private.cal_person_slots(public.calendars, uuid, timestamptz, timestamptz, int, uuid),
  private.cal_slots(public.calendars, timestamptz, timestamptz, int, uuid, uuid), private.cal_lengths(public.calendars) from public, anon, authenticated;

-- ---------- what the public booking page can read ----------
create or replace function private.cal_public(p_account text, p_cal text) returns public.calendars
language sql stable security definer set search_path = public, private as $$
  select c.* from calendars c join tenants t on t.id = c.tenant_id
   where t.slug = lower(trim(p_account)) and c.slug = lower(trim(p_cal)) and c.active and c.archived_at is null
     and private.feature_on_for(t.id, 'calendars')
$$;
revoke execute on function private.cal_public(text, text) from public, anon, authenticated;

-- a short public name: first name and last initial
create or replace function private.cal_short_name(p_user uuid) returns text
language sql stable security definer set search_path = public, private as $$
  select trim(split_part(trim(full_name), ' ', 1) || coalesce(' ' || nullif(left(split_part(trim(full_name), ' ', 2), 1), '') || '.', '')) from app_users where id = p_user
$$;
revoke execute on function private.cal_short_name(uuid) from public, anon, authenticated;

create or replace function public.book_info(p_account text, p_cal text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('name', c.name, 'description', c.description, 'color', c.color, 'kind', c.kind,
    'duration', c.duration_min, 'lengths', to_jsonb(private.cal_lengths(c)), 'time_zone', c.time_zone, 'ahead_days', c.ahead_days,
    'location_kind', c.location_kind, 'location', case when c.location_kind = 'in_person' then c.location_text end,
    'questions', (select coalesce(jsonb_agg(jsonb_build_object('key', q->>'key', 'label', q->>'label', 'kind', q->>'kind', 'options', coalesce(q->'options', '[]'::jsonb),
                   'required', coalesce((q->>'required')::boolean, false))), '[]'::jsonb) from jsonb_array_elements(c.questions) q),
    'ask_company', c.ask_company,
    'team', case when c.kind = 'pick' then (select coalesce(jsonb_agg(jsonb_build_object('id', u, 'name', private.cal_short_name(u)) order by o), '[]'::jsonb)
                                              from unnest(private.cal_people(c)) with ordinality x(u, o)) end,
    'with', case when c.kind = 'one' then (select private.cal_short_name(u) from unnest(private.cal_people(c)) u limit 1) end,
    'brand', private.doc_brand(c.tenant_id))
  from private.cal_public(p_account, p_cal) c where c.id is not null
$$;

-- open start times (ISO, UTC) between two moments, at most 45 days at a time
create or replace function public.book_slots(p_account text, p_cal text, p_from timestamptz, p_to timestamptz, p_duration int default null, p_user uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare c calendars; dur int;
begin
  c := private.cal_public(p_account, p_cal);
  if c.id is null then return null; end if;
  dur := coalesce(p_duration, c.duration_min);
  if not dur = any (private.cal_lengths(c)) then raise exception 'Pick one of the lengths offered'; end if;
  if p_to - p_from > interval '45 days' then p_to := p_from + interval '45 days'; end if;
  if c.kind <> 'pick' then p_user := null; end if;
  return (select coalesce(jsonb_agg(to_char(x at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') order by x), '[]'::jsonb)
            from (select distinct s.starts_at x from private.cal_slots(c, p_from, p_to, dur, p_user) s) d);
end $$;

revoke execute on function public.book_info(text, text), public.book_slots(text, text, timestamptz, timestamptz, int, uuid) from public;
grant execute on function public.book_info(text, text), public.book_slots(text, text, timestamptz, timestamptz, int, uuid) to anon, authenticated;
