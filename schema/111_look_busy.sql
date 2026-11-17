-- 111: Look busy (Nov 16, 2026). Per calendar, off by default.
-- "Aim for N% of the day looking taken": if real bookings and busy time already take that much of a day, nothing is
-- hidden; otherwise open times are hidden at random (the same ones all day, so the page doesn't shuffle) until the
-- day looks that full. At least look_busy_min times stay bookable each day. Only the public booking page and the
-- customer's reschedule page hide times; the team always sees real availability. Round robin hides from the combined
-- list of times, not per person.
alter table public.calendars add column if not exists look_busy_pct int check (look_busy_pct is null or look_busy_pct between 1 and 95);
alter table public.calendars add column if not exists look_busy_min int not null default 2 check (look_busy_min between 0 and 20);

-- every start time a day could offer if nobody were busy (working hours of anyone on the calendar, past notice)
create or replace function private.cal_day_grid(c public.calendars, p_day date, p_dur int) returns int
language plpgsql stable security definer set search_path = public, private as $$
declare u uuid; h cal_hours; tz text; r jsonb; rs timestamptz; re timestamptz; s timestamptz;
  earliest timestamptz := now() + make_interval(mins => c.notice_min); step interval := make_interval(mins => c.slot_min);
  dur interval := make_interval(mins => p_dur); starts timestamptz[] := '{}';
begin
  foreach u in array private.cal_people(c) loop
    h := private.cal_hours_for(c.tenant_id, u);
    tz := coalesce(h.time_zone, c.time_zone, 'America/Chicago');
    for r in select * from jsonb_array_elements(private.cal_day_ranges(c.tenant_id, u, p_day, coalesce(h.weekly, private.cal_default_week()))) loop
      begin
        rs := (p_day + (r->>0)::time) at time zone tz;
        re := case when r->>1 in ('24:00', '24:00:00') then ((p_day + 1)::timestamp at time zone tz) else (p_day + (r->>1)::time) at time zone tz end;
      exception when others then continue;
      end;
      s := rs;
      while s + dur <= re loop
        if s >= earliest and not s = any (starts) then starts := starts || s; end if;
        s := s + step;
      end loop;
    end loop;
  end loop;
  return cardinality(starts);
end $$;

-- the open times a customer sees: p_open is every real open time; returns them with the hidden ones taken out
create or replace function private.cal_look_busy(c public.calendars, p_open timestamptz[], p_dur int) returns timestamptz[]
language plpgsql stable security definer set search_path = public, private as $$
declare d date; day_open timestamptz[]; grid int; taken int; target int; hide int; keep int; v_out timestamptz[] := '{}'; tz text := coalesce(c.time_zone, 'America/Chicago');
begin
  if c.look_busy_pct is null or coalesce(cardinality(p_open), 0) = 0 then return coalesce(p_open, '{}'); end if;
  for d in select distinct (x at time zone tz)::date from unnest(p_open) x order by 1 loop
    select array_agg(x order by x) into day_open from unnest(p_open) x where (x at time zone tz)::date = d;
    grid := greatest(private.cal_day_grid(c, d, p_dur), cardinality(day_open));
    taken := grid - cardinality(day_open);
    target := ceil(grid * c.look_busy_pct / 100.0)::int;
    hide := greatest(target - taken, 0);
    keep := greatest(cardinality(day_open) - hide, least(c.look_busy_min, cardinality(day_open)));
    v_out := v_out || array(select x from unnest(day_open) x order by md5(c.id::text || d::text || x::text) limit keep);
  end loop;
  return array(select x from unnest(v_out) x order by x);
end $$;

revoke execute on function private.cal_day_grid(public.calendars, date, int), private.cal_look_busy(public.calendars, timestamptz[], int) from public, anon, authenticated;

-- public booking page and customer reschedules go through it
do $$ declare d text; n text;
begin
  d := pg_get_functiondef('public.book_slots(text, text, timestamptz, timestamptz, int, uuid)'::regprocedure);
  n := replace(d, 'from (select distinct s.starts_at x from private.cal_slots(c, p_from, p_to, dur, p_user) s) d);',
    'from unnest(private.cal_look_busy(c, array(select distinct s.starts_at from private.cal_slots(c, p_from, p_to, dur, p_user) s), dur)) x);');
  if n = d then raise exception 'book_slots did not match; nothing changed'; end if;
  execute n;
  d := pg_get_functiondef('public.book_manage_slots(text, timestamptz, timestamptz)'::regprocedure);
  n := replace(d, 'from (select distinct s.starts_at x from private.cal_slots(c, p_from, p_to, (extract(epoch from a.ends_at - a.starts_at) / 60)::int,
                    case when c.kind = ''round_robin'' then null else a.user_id end, a.id) s) d);',
    'from unnest(private.cal_look_busy(c, array(select distinct s.starts_at from private.cal_slots(c, p_from, p_to, (extract(epoch from a.ends_at - a.starts_at) / 60)::int,
                    case when c.kind = ''round_robin'' then null else a.user_id end, a.id) s), (extract(epoch from a.ends_at - a.starts_at) / 60)::int)) x);');
  if n = d then raise exception 'book_manage_slots did not match; nothing changed'; end if;
  execute n;
  -- calendar_save keeps the two settings
  d := pg_get_functiondef('public.calendar_save(uuid, jsonb)'::regprocedure);
  n := replace(d, 'divisions = coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p->''divisions'') x), divisions), updated_at = now()',
    'divisions = coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(p->''divisions'') x), divisions),
    look_busy_pct = case when coalesce((p->>''look_busy_pct'')::int, 0) between 1 and 95 then (p->>''look_busy_pct'')::int end,
    look_busy_min = coalesce(least(greatest((p->>''look_busy_min'')::int, 0), 20), look_busy_min), updated_at = now()');
  if n = d then raise exception 'calendar_save did not match; nothing changed'; end if;
  execute n;
end $$;

-- calendar setup: what Look busy is doing over the next week (open and hidden times per day), for the team only
create or replace function public.cal_busy_preview(p_cal uuid, p_pct int, p_min int) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare c calendars; d date; v_real timestamptz[]; shown timestamptz[]; res jsonb := '[]'::jsonb; tz text;
begin
  select * into c from calendars where id = p_cal and tenant_id = private.current_tenant() and archived_at is null;
  if c.id is null or not private.cal_see() then raise exception 'Not found'; end if;
  c.look_busy_pct := case when p_pct between 1 and 95 then p_pct end; c.look_busy_min := coalesce(p_min, 2);
  tz := coalesce(c.time_zone, 'America/Chicago');
  for d in select generate_series((now() at time zone tz)::date, (now() at time zone tz)::date + 6, interval '1 day')::date loop
    v_real := array(select distinct s.starts_at from private.cal_slots(c, (d::timestamp at time zone tz), ((d + 1)::timestamp at time zone tz), c.duration_min) s);
    shown := private.cal_look_busy(c, v_real, c.duration_min);
    res := res || jsonb_build_object('day', d, 'open', cardinality(v_real), 'shown', coalesce(cardinality(shown), 0));
  end loop;
  return res;
end $$;
revoke execute on function public.cal_busy_preview(uuid, int, int) from public, anon;
grant execute on function public.cal_busy_preview(uuid, int, int) to authenticated;
