-- 109: hours and days off belong to the person (Nov 16, 2026).
-- A person sets their weekly hours once (user_hours) and they apply in every account they work in. Any account can
-- override them (cal_hours, as before); the account's version wins there and starts as a copy of the person's.
-- Days off work the same way: user_days apply everywhere, cal_overrides only in that one account. On a given day the
-- account's own entry wins, then the person's, then the week.
-- The person's own hours and days off can be changed by them, or by admins of their home account (app_users.tenant_id).
-- Notes on the person's days off show only to them and their home account; other accounts just see "Off".

create table if not exists public.user_hours (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  weekly jsonb not null default '{"1":[["09:00","17:00"]],"2":[["09:00","17:00"]],"3":[["09:00","17:00"]],"4":[["09:00","17:00"]],"5":[["09:00","17:00"]]}'::jsonb,
  time_zone text not null default 'America/Chicago',
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.user_hours enable row level security;
revoke all on public.user_hours from anon, authenticated;

create table if not exists public.user_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  day date not null,
  ranges jsonb not null default '[]'::jsonb,
  note text check (note is null or length(note) <= 300),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (user_id, day)
);
alter table public.user_days enable row level security;
revoke all on public.user_days from anon, authenticated;

-- move each person's home-account hours up to their own (the home account then just uses them)
insert into public.user_hours (user_id, weekly, time_zone, updated_at, updated_by)
select h.user_id, h.weekly, h.time_zone, h.updated_at, h.updated_by
  from public.cal_hours h join public.app_users u on u.id = h.user_id and u.tenant_id = h.tenant_id
on conflict (user_id) do nothing;
delete from public.cal_hours h using public.app_users u where u.id = h.user_id and u.tenant_id = h.tenant_id;

-- the hours that count for someone in an account: the account's own, else theirs, else the default week
create or replace function private.cal_hours_for(p_tenant uuid, p_user uuid) returns public.cal_hours
language plpgsql stable security definer set search_path = public, private as $$
declare h cal_hours;
begin
  select * into h from cal_hours where tenant_id = p_tenant and user_id = p_user;
  if found then return h; end if;
  select p_tenant, u.user_id, u.weekly, u.time_zone, u.updated_at, u.updated_by into h from user_hours u where u.user_id = p_user;
  return h;   -- all nulls when neither is set: callers fall back to the calendar's zone and the default week
end $$;

create or replace function private.cal_day_ranges(p_tenant uuid, p_user uuid, p_day date, p_weekly jsonb) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce((select o.ranges from cal_overrides o where o.tenant_id = p_tenant and o.user_id = p_user and o.day = p_day),
                  (select d.ranges from user_days d where d.user_id = p_user and d.day = p_day),
                  p_weekly->(extract(dow from p_day)::int::text), '[]'::jsonb)
$$;

-- the slot finder and the two time zone lookups read through cal_hours_for
do $$ declare d text; n text;
begin
  d := pg_get_functiondef('private.cal_person_slots(public.calendars, uuid, timestamptz, timestamptz, int, uuid)'::regprocedure);
  n := replace(d, 'select * into h from cal_hours where tenant_id = c.tenant_id and user_id = p_user;', 'h := private.cal_hours_for(c.tenant_id, p_user);');
  if n = d then raise exception 'cal_person_slots did not match; nothing changed'; end if;
  execute n;

  d := pg_get_functiondef('private.cal_book(public.calendars, timestamptz, int, uuid, jsonb, text, text)'::regprocedure);
  n := replace(d, '(select time_zone from cal_hours where tenant_id = c.tenant_id and user_id = who)', '(private.cal_hours_for(c.tenant_id, who)).time_zone');
  if n = d then raise exception 'cal_book did not match; nothing changed'; end if;
  execute n;

  d := pg_get_functiondef('public.cal_mail_take(uuid, text)'::regprocedure);
  n := replace(d, '(select time_zone from cal_hours where tenant_id = a.tenant_id and user_id = a.user_id)', '(private.cal_hours_for(a.tenant_id, a.user_id)).time_zone');
  if n = d then raise exception 'cal_mail_take did not match; nothing changed'; end if;
  execute n;
end $$;

-- may the signed-in person change this person's own (everywhere) hours: themselves, or an admin of their home account
create or replace function private.user_hours_ok(p_user uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select p_user = auth.uid()
      or (private.is_admin() and exists (select 1 from app_users u where u.id = p_user and u.tenant_id = private.current_tenant()))
$$;

-- everything the Hours and days off screen needs for one person in the current account
create or replace function public.hours_get(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); home uuid; mine boolean; see_notes boolean;
begin
  if not (p_user = auth.uid() or (private.cal_see() and private.on_team(p_user, t))) then raise exception 'Not found'; end if;
  select tenant_id into home from app_users where id = p_user;
  mine := private.user_hours_ok(p_user);
  see_notes := p_user = auth.uid() or home = t;
  return jsonb_build_object(
    'user', (select jsonb_build_object('weekly', weekly, 'time_zone', time_zone) from user_hours where user_id = p_user),
    'account', (select jsonb_build_object('weekly', weekly, 'time_zone', time_zone) from cal_hours where tenant_id = t and user_id = p_user),
    'home', home = t,
    'home_name', (select name from tenants where id = home),
    'can_user', mine,
    'can_account', private.cal_hours_ok(p_user),
    'days', coalesce((select jsonb_agg(x order by x->>'day') from (
        select jsonb_build_object('id', d.id, 'day', d.day, 'ranges', d.ranges, 'note', case when see_notes then d.note end, 'scope', 'user') x
          from user_days d where d.user_id = p_user and d.day >= current_date - 1
        union all
        select jsonb_build_object('id', o.id, 'day', o.day, 'ranges', o.ranges, 'note', o.note, 'scope', 'account')
          from cal_overrides o where o.tenant_id = t and o.user_id = p_user and o.day >= current_date - 1) y), '[]'::jsonb));
end $$;

-- save weekly hours: p_scope 'user' (everywhere) or 'account' (just this account)
create or replace function public.hours_save(p_user uuid, p_scope text, p_weekly jsonb, p_tz text) returns void
language plpgsql security definer set search_path = public, private as $$
declare wk jsonb := '{}'::jsonb; d int;
begin
  if p_scope not in ('user', 'account') then raise exception 'Pick where these hours apply'; end if;
  if p_scope = 'user' and not private.user_hours_ok(p_user) then raise exception 'Only they or their home account''s admins can change their hours everywhere'; end if;
  if p_scope = 'account' and not private.cal_hours_ok(p_user) then raise exception 'You can''t change their hours'; end if;
  if not private.cal_tz_ok(coalesce(p_tz, '')) then raise exception 'That time zone isn''t one we know'; end if;
  for d in 0..6 loop wk := wk || jsonb_build_object(d::text, private.cal_ranges_ok(coalesce(p_weekly->(d::text), '[]'::jsonb))); end loop;
  if p_scope = 'user' then
    insert into user_hours (user_id, weekly, time_zone, updated_at, updated_by) values (p_user, wk, p_tz, now(), auth.uid())
    on conflict (user_id) do update set weekly = excluded.weekly, time_zone = excluded.time_zone, updated_at = now(), updated_by = auth.uid();
  else
    insert into cal_hours (tenant_id, user_id, weekly, time_zone, updated_at, updated_by) values (private.current_tenant(), p_user, wk, p_tz, now(), auth.uid())
    on conflict (tenant_id, user_id) do update set weekly = excluded.weekly, time_zone = excluded.time_zone, updated_at = now(), updated_by = auth.uid();
  end if;
end $$;

-- this account goes back to using the person's own hours
create or replace function public.hours_use_default(p_user uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.cal_hours_ok(p_user) then raise exception 'You can''t change their hours'; end if;
  delete from cal_hours where tenant_id = private.current_tenant() and user_id = p_user;
end $$;

-- a day off or different hours on one day, everywhere ('user') or in this account ('account')
create or replace function public.hours_day_save(p_user uuid, p_scope text, p_day date, p_ranges jsonb, p_note text default null) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare v_id uuid; r jsonb := private.cal_ranges_ok(coalesce(p_ranges, '[]'::jsonb)); nt text := nullif(left(trim(coalesce(p_note, '')), 300), '');
begin
  if p_day is null or p_day < current_date - 1 then raise exception 'Pick a day from today on'; end if;
  if p_scope = 'user' then
    if not private.user_hours_ok(p_user) then raise exception 'Only they or their home account''s admins can add a day off everywhere'; end if;
    insert into user_days (user_id, day, ranges, note) values (p_user, p_day, r, nt)
    on conflict (user_id, day) do update set ranges = excluded.ranges, note = excluded.note returning id into v_id;
  elsif p_scope = 'account' then
    return public.cal_override_save(p_user, p_day, r, nt);
  else raise exception 'Pick where this day applies'; end if;
  return v_id;
end $$;

create or replace function public.hours_day_remove(p_id uuid, p_scope text) returns void
language plpgsql security definer set search_path = public, private as $$
declare u uuid;
begin
  if p_scope = 'account' then perform public.cal_override_remove(p_id); return; end if;
  select user_id into u from user_days where id = p_id;
  if u is null or not private.user_hours_ok(u) then raise exception 'Not found'; end if;
  delete from user_days where id = p_id;
end $$;

revoke execute on function private.cal_hours_for(uuid, uuid), private.user_hours_ok(uuid) from public, anon, authenticated;
revoke execute on function public.hours_get(uuid), public.hours_save(uuid, text, jsonb, text), public.hours_use_default(uuid),
  public.hours_day_save(uuid, text, date, jsonb, text), public.hours_day_remove(uuid, text) from public, anon;
grant execute on function public.hours_get(uuid), public.hours_save(uuid, text, jsonb, text), public.hours_use_default(uuid),
  public.hours_day_save(uuid, text, date, jsonb, text), public.hours_day_remove(uuid, text) to authenticated;
