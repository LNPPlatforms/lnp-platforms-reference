-- 104: Routes (Beta), Nov 13, 2026. Off until an account admin turns it on (Settings > Features > Routes).
-- A route is a list of stops (customers) run on a schedule: daily, weekly, monthly or custom (every N weeks on picked
-- days). It's assigned to people and/or crews, permanently or for a date range. Each run day:
--   * if nobody assigned clocks in within the grace period (15 minutes by default) after the start time, the route's
--     dispatcher gets an urgent alert; if nobody acts within 15 more minutes, every admin does.
--   * the dispatcher can split the stops between people for the day, mark someone late, dismiss the day, or push the
--     route to tomorrow (and then email those customers if they want).
--   * workers see the route in My Day with stops in order, and tap Arrived and Left. The phone's location is checked
--     at the tap only; far from the stop gives a warning and lets them report a location mismatch (one time or
--     permanent, with a reason) for the dispatcher to approve. A permanent one moves the stop's location.
--   * a stop that can't be finished is marked incomplete with a reason, photos and videos.
-- No constant tracking. The only background location is an hourly ping while on the clock, and only for people an
-- admin turned it on for (Routes > Settings).
-- Urgent alerts reach each person the way they chose (gear menu: push, email, both, or only in the CRM).

-- routes are off by default, like the other field features
create or replace function private.feature_on(f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.plan_allows(private.current_tenant(), f) and coalesce((select (settings->'features'->>f)::boolean from account_settings where tenant_id = private.current_tenant()),
                  f not in ('jobs', 'dispatch', 'timeclock', 'pay', 'costs', 'parent_locations', 'location_nesting', 'custom_fields', 'accounting', 'measure', 'bids', 'portal', 'esign', 'calendars', 'routes'))
$$;
create or replace function private.feature_on_for(t uuid, f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.plan_allows(t, f) and coalesce((select (settings->'features'->>f)::boolean from account_settings where tenant_id = t),
                  f not in ('jobs', 'dispatch', 'timeclock', 'pay', 'costs', 'parent_locations', 'location_nesting', 'custom_fields', 'accounting', 'measure', 'bids', 'portal', 'esign', 'calendars', 'routes'))
$$;

-- hourly location while on the clock: off for everyone until an admin turns it on per person
alter table public.app_users add column if not exists gps_tracking boolean not null default false;

create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  start_time time not null default '08:00',
  timezone text not null default 'America/Chicago',
  repeat text not null default 'weekly' check (repeat in ('daily', 'weekly', 'monthly', 'custom')),
  days int[] not null default '{1,2,3,4,5}',           -- weekly and custom: ISO weekdays (1 Monday .. 7 Sunday)
  month_days int[] not null default '{}',              -- monthly: days of the month (31 means the last day in short months)
  every_weeks int not null default 1 check (every_weeks between 1 and 12),   -- custom: every N weeks, counted from starts_on
  starts_on date not null default current_date,
  ends_on date,
  dispatcher_id uuid references public.app_users(id),
  grace_min int not null default 15 check (grace_min between 1 and 240),
  escalate_min int not null default 15 check (escalate_min between 1 and 240),
  notes text,
  active boolean not null default true,
  created_by uuid references public.app_users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists routes_tenant on public.routes (tenant_id) where archived_at is null;

-- who runs it: a person or a crew; no dates = permanent, dates = temporary (on those days it replaces the permanent ones)
create table if not exists public.route_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  route_id uuid not null references public.routes(id) on delete cascade,
  user_id uuid references public.app_users(id),
  crew_id uuid references public.crews(id),
  from_date date,
  to_date date,
  created_at timestamptz not null default now(),
  check ((user_id is null) <> (crew_id is null)),
  check (to_date is null or from_date is null or to_date >= from_date)
);
create index if not exists route_assignments_route on public.route_assignments (route_id);

-- stops: a customer (organization) on the route, in order. One customer can be on many routes, more than once.
create table if not exists public.route_stops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  route_id uuid not null references public.routes(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  pin_id uuid references public.location_pins(id),
  label text check (label is null or length(label) <= 80),
  lat double precision check (lat is null or lat between -90 and 90),
  lng double precision check (lng is null or lng between -180 and 180),
  radius_ft int check (radius_ft is null or radius_ft between 50 and 10000),
  request text check (request is null or length(request) <= 2000),   -- what to do there
  sort int not null default 0,
  created_by uuid references public.app_users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists route_stops_route on public.route_stops (route_id, sort) where archived_at is null;
create index if not exists route_stops_company on public.route_stops (company_id) where archived_at is null;

-- one day of a route
create table if not exists public.route_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  route_id uuid not null references public.routes(id) on delete cascade,
  run_date date not null,
  starts_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'started', 'late', 'dismissed', 'pushed', 'done')),
  started_at timestamptz,
  acted_at timestamptz,                  -- the dispatcher or an admin did something (stops the alerts)
  acted_by uuid references public.app_users(id),
  dispatcher_alerted_at timestamptz,
  admins_alerted_at timestamptz,
  late_users uuid[] not null default '{}',
  pushed_to date,
  pushed_from uuid references public.route_runs(id),
  note text,
  created_at timestamptz not null default now(),
  unique (route_id, run_date)
);
create index if not exists route_runs_open on public.route_runs (starts_at) where status in ('scheduled', 'late');

create table if not exists public.route_run_stops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_id uuid not null references public.route_runs(id) on delete cascade,
  stop_id uuid not null references public.route_stops(id) on delete cascade,
  user_id uuid references public.app_users(id),      -- set when the day is split: this stop is theirs
  sort int not null default 0,
  status text not null default 'pending' check (status in ('pending', 'arrived', 'done', 'incomplete', 'skipped')),
  arrived_at timestamptz, arrived_by uuid references public.app_users(id), arrived_lat double precision, arrived_lng double precision, arrived_feet double precision,
  left_at timestamptz, left_by uuid references public.app_users(id), left_lat double precision, left_lng double precision, left_feet double precision,
  far boolean not null default false,
  reason text check (reason is null or length(reason) <= 2000),
  media text[] not null default '{}',                 -- job-photos bucket paths (photos and videos)
  unique (run_id, stop_id)
);

create table if not exists public.route_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  run_stop_id uuid not null references public.route_run_stops(id) on delete cascade,
  stop_id uuid not null references public.route_stops(id) on delete cascade,
  user_id uuid not null references public.app_users(id) default auth.uid(),
  scope text not null check (scope in ('once', 'permanent')),
  reason text not null check (length(trim(reason)) between 2 and 1000),
  lat double precision, lng double precision, feet double precision,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  decided_by uuid references public.app_users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists route_exceptions_pending on public.route_exceptions (tenant_id) where status = 'pending';

create table if not exists public.gps_pings (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  time_entry_id uuid references public.time_entries(id) on delete set null,
  at timestamptz not null default now(),
  lat double precision not null, lng double precision not null, accuracy_m double precision
);
create index if not exists gps_pings_user on public.gps_pings (user_id, at desc);

-- ---------- who can do what ----------
-- see: anyone internal on the account (workers need their routes); manage: dispatch level 3 (managers, admins)
create or replace function private.routes_manage() returns boolean language sql stable security definer set search_path = public, private as $$
  select private.feature_on('routes') and (private.is_admin() or private.can('dispatch', 3))
$$;
revoke execute on function private.routes_manage() from public, anon;
-- the table policies call it as the signed-in person, so they must be able to run it (Nov 16 fix: without this every
-- Routes lookup was "permission denied")
grant execute on function private.routes_manage() to authenticated;

alter table public.routes enable row level security;
alter table public.route_assignments enable row level security;
alter table public.route_stops enable row level security;
alter table public.route_runs enable row level security;
alter table public.route_run_stops enable row level security;
alter table public.route_exceptions enable row level security;
alter table public.gps_pings enable row level security;
do $$
declare t text;
begin
  foreach t in array array['routes', 'route_assignments', 'route_stops', 'route_runs', 'route_run_stops', 'route_exceptions'] loop
    execute format('drop policy if exists "see %1$s" on public.%1$I', t);
    execute format('create policy "see %1$s" on public.%1$I for select using (tenant_id = private.current_tenant() and private.is_internal() and private.feature_on(''routes''))', t);
  end loop;
  foreach t in array array['routes', 'route_assignments', 'route_stops'] loop
    execute format('drop policy if exists "manage %1$s" on public.%1$I', t);
    execute format('create policy "manage %1$s" on public.%1$I for all using (tenant_id = private.current_tenant() and private.routes_manage()) with check (tenant_id = private.current_tenant() and private.routes_manage())', t);
  end loop;
end $$;
drop policy if exists "see pings" on public.gps_pings;
create policy "see pings" on public.gps_pings for select using (tenant_id = private.current_tenant() and (user_id = auth.uid() or private.routes_manage() or private.is_admin()));
revoke all on public.routes, public.route_assignments, public.route_stops, public.route_runs, public.route_run_stops, public.route_exceptions, public.gps_pings from anon, authenticated;
grant select on public.routes, public.route_assignments, public.route_stops, public.route_runs, public.route_run_stops, public.route_exceptions, public.gps_pings to authenticated;
grant insert, update, delete on public.routes, public.route_assignments, public.route_stops to authenticated;
-- a stop's customer must be on this account
create or replace function private.guard_route_stop() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if not exists (select 1 from companies where id = new.company_id and tenant_id = new.tenant_id) then raise exception 'Not found'; end if;
  if not exists (select 1 from routes where id = new.route_id and tenant_id = new.tenant_id) then raise exception 'Not found'; end if;
  if new.pin_id is not null and not exists (select 1 from location_pins where id = new.pin_id and company_id = new.company_id) then raise exception 'That pin is on another location'; end if;
  return new;
end $$;
revoke execute on function private.guard_route_stop() from public, anon, authenticated;
create or replace trigger guard_route_stop before insert or update on public.route_stops for each row execute function private.guard_route_stop();

-- ---------- schedule ----------
create or replace function private.route_on(r routes, d date) returns boolean
language sql stable set search_path = public, private as $$
  select r.active and r.archived_at is null and d >= r.starts_on and (r.ends_on is null or d <= r.ends_on) and case r.repeat
    when 'daily' then true
    when 'weekly' then extract(isodow from d)::int = any(r.days)
    when 'custom' then extract(isodow from d)::int = any(r.days)
      and ((d - (r.starts_on - (extract(isodow from r.starts_on)::int - 1))) / 7) % r.every_weeks = 0
    when 'monthly' then extract(day from d)::int = any(r.month_days)
      or (extract(day from d)::int = extract(day from (date_trunc('month', d) + interval '1 month - 1 day'))::int
          and exists (select 1 from unnest(r.month_days) m where m > extract(day from d)::int))
  end
$$;
revoke execute on function private.route_on(routes, date) from public, anon, authenticated;

-- the people on a route on a day: temporary assignments for that day if there are any, otherwise the permanent ones.
-- Crews count as their foreman and members.
create or replace function private.route_people(p_route uuid, d date) returns uuid[]
language sql stable security definer set search_path = public, private as $$
  with a as (
    select * from route_assignments where route_id = p_route
       and case when exists (select 1 from route_assignments x where x.route_id = p_route and (x.from_date is not null or x.to_date is not null)
                               and d between coalesce(x.from_date, d) and coalesce(x.to_date, d))
                then (from_date is not null or to_date is not null) and d between coalesce(from_date, d) and coalesce(to_date, d)
                else from_date is null and to_date is null end)
  select coalesce(array_agg(distinct u) filter (where u is not null), '{}') from (
    select user_id u from a where user_id is not null
    union all select c.foreman_id from a join crews c on c.id = a.crew_id and c.archived_at is null
    union all select unnest(c.member_ids) from a join crews c on c.id = a.crew_id and c.archived_at is null) z
$$;
revoke execute on function private.route_people(uuid, date) from public, anon, authenticated;

-- make (or find) a route's run for a day, with its stops in order
create or replace function private.route_run_make(p_route uuid, d date) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare r routes; v uuid;
begin
  select * into r from routes where id = p_route;
  if r.id is null then return null; end if;
  select id into v from route_runs where route_id = p_route and run_date = d;
  if v is null then
    insert into route_runs (tenant_id, route_id, run_date, starts_at)
    values (r.tenant_id, r.id, d, (d + r.start_time) at time zone r.timezone)
    on conflict (route_id, run_date) do nothing returning id into v;
    if v is null then select id into v from route_runs where route_id = p_route and run_date = d; end if;
  end if;
  insert into route_run_stops (tenant_id, run_id, stop_id, sort)
  select r.tenant_id, v, s.id, s.sort from route_stops s where s.route_id = r.id and s.archived_at is null
     and not exists (select 1 from route_runs x where x.id = v and x.status in ('done', 'dismissed', 'pushed'))
  on conflict (run_id, stop_id) do nothing;
  return v;
end $$;
revoke execute on function private.route_run_make(uuid, date) from public, anon, authenticated;

-- an urgent alert: a notification that also goes out right away the way each person chose
create or replace function private.urgent(p_tenant uuid, p_users uuid[], p_kind text, p_title text, p_body text, p_link text) returns void
language sql security definer set search_path = public, private as $$
  insert into notifications (user_id, kind, title, body, link, deliver, tenant_id)
  select distinct u, p_kind, left(p_title, 200), left(p_body, 500), p_link, true, p_tenant from unnest(p_users) u where u is not null
$$;
revoke execute on function private.urgent(uuid, uuid[], text, text, text, text) from public, anon, authenticated;

-- every minute: make today's runs, notice clock-ins, and alert when nobody has started
create or replace function private.route_tick() returns void
language plpgsql security definer set search_path = public, private as $$
declare r record; ro_rec routes; d date; ppl uuid[]; admins uuid[];
begin
  -- today's runs (each route in its own time zone), for accounts with Routes on
  for ro_rec in select * from routes ro where ro.active and ro.archived_at is null and private.feature_on_for(ro.tenant_id, 'routes') loop
    d := (now() at time zone ro_rec.timezone)::date;
    if private.route_on(ro_rec, d) and not exists (select 1 from route_runs where route_id = ro_rec.id and run_date = d) then
      perform private.route_run_make(ro_rec.id, d);
    end if;
  end loop;
  for r in select rr.*, ro.name, ro.grace_min, ro.escalate_min, ro.dispatcher_id, ro.timezone
             from route_runs rr join routes ro on ro.id = rr.route_id
            where rr.status in ('scheduled', 'late') and rr.acted_at is null and rr.run_date >= current_date - 1
              and rr.starts_at <= now() - make_interval(mins => ro.grace_min) loop
    ppl := private.route_people(r.route_id, r.run_date);
    -- someone on the route clocked in today (from 3 hours before the start): it's started, no alerts
    if exists (select 1 from time_entries t where t.user_id = any(ppl) and t.clock_in >= r.starts_at - interval '3 hours' and t.clock_in <= now()) then
      update route_runs set status = 'started', started_at = coalesce(started_at, now()) where id = r.id;
      continue;
    end if;
    if r.dispatcher_alerted_at is null then
      if r.dispatcher_id is not null then
        perform private.urgent(r.tenant_id, array[r.dispatcher_id], 'route_late', 'Nobody has started ' || r.name,
          'No one on this route has clocked in, ' || r.grace_min || ' minutes after it was due to start. Open it to split it up, mark someone late, dismiss it or push it to tomorrow.',
          '#routes/' || r.route_id);
        update route_runs set dispatcher_alerted_at = now() where id = r.id;
        continue;
      end if;
      update route_runs set dispatcher_alerted_at = now() where id = r.id;   -- no dispatcher: straight to admins
      r.dispatcher_alerted_at := now() - make_interval(mins => r.escalate_min);
    end if;
    if r.admins_alerted_at is null and r.dispatcher_alerted_at <= now() - make_interval(mins => r.escalate_min) then
      select coalesce(array_agg(id), '{}') into admins from app_users where tenant_id = r.tenant_id and is_admin and active and (role is null or role not in ('vendor', 'member')) and forward_to is null;
      perform private.urgent(r.tenant_id, admins, 'route_late', 'Still nobody on ' || r.name,
        'No one has clocked in for this route and nobody has acted on it yet. Open it to split it up, mark someone late, dismiss it or push it to tomorrow.',
        '#routes/' || r.route_id);
      update route_runs set admins_alerted_at = now() where id = r.id;
    end if;
  end loop;
end $$;
revoke execute on function private.route_tick() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('route-tick') where exists (select 1 from cron.job where jobname = 'route-tick');
    perform cron.schedule('route-tick', '* * * * *', $c$select private.route_tick()$c$);
  end if;
end $$;

-- ---------- what the screens call ----------
-- a run with its stops, for the dispatcher or for the worker (mine = only my stops when the day is split)
create or replace function private.run_json(p_run uuid, p_mine boolean) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('id', rr.id, 'route_id', ro.id, 'name', ro.name, 'run_date', rr.run_date, 'starts_at', rr.starts_at, 'status', rr.status,
    'late_users', rr.late_users, 'pushed_to', rr.pushed_to, 'note', rr.note, 'dispatcher_id', ro.dispatcher_id,
    'people', private.route_people(ro.id, rr.run_date), 'alerted', rr.dispatcher_alerted_at is not null,
    'stops', coalesce((select jsonb_agg(jsonb_build_object('id', rs.id, 'stop_id', s.id, 'company_id', c.id, 'company', c.name, 'label', s.label,
        'address', concat_ws(', ', nullif(c.address, ''), nullif(c.city, ''), nullif(c.state, '')),
        'lat', coalesce(s.lat, p.lat), 'lng', coalesce(s.lng, p.lng), 'request', s.request, 'user_id', rs.user_id, 'status', rs.status,
        'arrived_at', rs.arrived_at, 'left_at', rs.left_at, 'far', rs.far, 'reason', rs.reason, 'media', rs.media,
        'pending_exception', exists (select 1 from route_exceptions e where e.run_stop_id = rs.id and e.status = 'pending')) order by rs.sort, c.name)
      from route_run_stops rs join route_stops s on s.id = rs.stop_id join companies c on c.id = s.company_id
      left join location_pins p on p.id = coalesce(s.pin_id, (select id from location_pins where company_id = c.id and archived_at is null order by is_primary desc, created_at limit 1))
      where rs.run_id = rr.id and (not p_mine or rs.user_id is null or rs.user_id = auth.uid())), '[]'::jsonb))
  from route_runs rr join routes ro on ro.id = rr.route_id where rr.id = p_run
$$;
revoke execute on function private.run_json(uuid, boolean) from public, anon, authenticated;

-- My Day: my routes today (made on the spot if the minute job hasn't yet)
create or replace function public.my_routes() returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare r routes; d date; res jsonb := '[]'::jsonb; v uuid;
begin
  if not private.feature_on('routes') then return res; end if;
  for r in select * from routes where tenant_id = private.current_tenant() and active and archived_at is null order by start_time, name loop
    d := (now() at time zone r.timezone)::date;
    select id into v from route_runs where route_id = r.id and run_date = d;
    if v is null and private.route_on(r, d) then v := private.route_run_make(r.id, d); end if;
    if v is null then continue; end if;
    if auth.uid() = any(private.route_people(r.id, d)) or exists (select 1 from route_run_stops where run_id = v and user_id = auth.uid()) then
      res := res || jsonb_build_array(private.run_json(v, true));
    end if;
  end loop;
  return res;
end $$;

-- the dispatcher's view of one route: runs for a few days around today and the pending location reports
create or replace function public.route_board(p_route uuid, p_date date default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare r routes; d date; v uuid;
begin
  if not private.routes_manage() then raise exception 'Not allowed'; end if;
  select * into r from routes where id = p_route and tenant_id = private.current_tenant();
  if r.id is null then raise exception 'Not found'; end if;
  d := coalesce(p_date, (now() at time zone r.timezone)::date);
  select id into v from route_runs where route_id = r.id and run_date = d;
  if v is null and private.route_on(r, d) then v := private.route_run_make(r.id, d); end if;
  return jsonb_build_object('date', d, 'runs_today', private.route_on(r, d) or v is not null, 'run', case when v is not null then private.run_json(v, false) end,
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'company', c.name, 'scope', e.scope, 'reason', e.reason, 'lat', e.lat, 'lng', e.lng,
        'feet', round(e.feet::numeric), 'user_id', e.user_id, 'at', e.created_at) order by e.created_at)
      from route_exceptions e join route_stops s on s.id = e.stop_id join companies c on c.id = s.company_id
      where s.route_id = r.id and e.status = 'pending'), '[]'::jsonb));
end $$;

-- dispatcher actions on a day: split (p: {"assign": {run_stop_id: user_id or null}}), late (p: {"user": id}), dismiss,
-- push (to tomorrow; returns the customers so the screen can offer to email them), undo (back to scheduled)
create or replace function public.route_run_action(p_run uuid, p_action text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare rr route_runs; r routes; k text; v text; nx uuid; ppl uuid[];
begin
  if not private.routes_manage() then raise exception 'Not allowed'; end if;
  select * into rr from route_runs where id = p_run and tenant_id = private.current_tenant() for update;
  if rr.id is null then raise exception 'Not found'; end if;
  select * into r from routes where id = rr.route_id;
  if p_action = 'split' then
    ppl := private.route_people(r.id, rr.run_date);
    for k, v in select * from jsonb_each_text(coalesce(p->'assign', '{}'::jsonb)) loop
      if v is not null and v <> '' and not exists (select 1 from app_users where id = v::uuid and tenant_id = rr.tenant_id and active) then raise exception 'Pick someone on this account'; end if;
      update route_run_stops set user_id = nullif(v, '')::uuid where id = k::uuid and run_id = rr.id;
    end loop;
    -- anyone given stops who isn't on the route hears about it
    perform private.urgent(rr.tenant_id, array(select distinct user_id from route_run_stops where run_id = rr.id and user_id is not null and user_id <> auth.uid()),
      'route_assigned', 'You have stops on ' || r.name || ' today', 'Open My Day to see them in order.', '#myday');
    update route_runs set acted_at = now(), acted_by = auth.uid() where id = rr.id;
  elsif p_action = 'late' then
    update route_runs set status = 'late', late_users = array(select distinct x from unnest(late_users || (p->>'user')::uuid) x), acted_at = now(), acted_by = auth.uid(), note = coalesce(nullif(p->>'note', ''), note) where id = rr.id;
  elsif p_action = 'dismiss' then
    update route_runs set status = 'dismissed', acted_at = now(), acted_by = auth.uid(), note = coalesce(nullif(p->>'note', ''), note) where id = rr.id;
  elsif p_action = 'push' then
    update route_runs set status = 'pushed', pushed_to = rr.run_date + 1, acted_at = now(), acted_by = auth.uid(), note = coalesce(nullif(p->>'note', ''), note) where id = rr.id;
    -- tomorrow gets this route (it may already be on tomorrow's schedule; then it's the same run)
    select id into nx from route_runs where route_id = r.id and run_date = rr.run_date + 1;
    if nx is null then
      insert into route_runs (tenant_id, route_id, run_date, starts_at, pushed_from)
      values (rr.tenant_id, r.id, rr.run_date + 1, ((rr.run_date + 1) + r.start_time) at time zone r.timezone, rr.id) returning id into nx;
    end if;
    insert into route_run_stops (tenant_id, run_id, stop_id, sort, user_id)
    select tenant_id, nx, stop_id, sort, user_id from route_run_stops where run_id = rr.id and status in ('pending', 'arrived')
    on conflict (run_id, stop_id) do nothing;
    return jsonb_build_object('ok', true, 'customers', private.route_customers(rr.id));
  elsif p_action = 'undo' then
    update route_runs set status = 'scheduled', pushed_to = null, acted_at = now(), acted_by = auth.uid() where id = rr.id;
  else
    raise exception 'Unknown action';
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- the customers on a run and who would get an email (primary contacts and decision makers with an email who haven't opted out)
create or replace function private.route_customers(p_run uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('company_id', c.id, 'company', c.name, 'emails', coalesce(e.emails, '[]'::jsonb)) order by c.name), '[]'::jsonb)
  from (select distinct s.company_id from route_run_stops rs join route_stops s on s.id = rs.stop_id where rs.run_id = p_run) x
  join companies c on c.id = x.company_id
  left join lateral (select jsonb_agg(distinct jsonb_build_object('person_id', pe.id, 'email', lower(coalesce(nullif(cp.work_email, ''), pe.personal_email)),
                       'name', trim(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')))) emails
                       from company_people cp join people pe on pe.id = cp.person_id
                      where cp.company_id = c.id and (cp.is_primary_contact or cp.is_decision_maker) and not coalesce(pe.email_opt_out, false)
                        and pe.archived_at is null and coalesce(nullif(cp.work_email, ''), pe.personal_email) ~ '^\S+@\S+\.\S+$') e on true
$$;
revoke execute on function private.route_customers(uuid) from public, anon, authenticated;

-- after a push: email those customers now (the dispatcher can edit the words first)
create or replace function public.route_notify_customers(p_run uuid, p_subject text, p_body text, p_companies uuid[] default null) returns int
language plpgsql security definer set search_path = public, private as $$
declare rr route_runs; c jsonb; e jsonb; v uuid; n int := 0;
begin
  if not private.routes_manage() then raise exception 'Not allowed'; end if;
  select * into rr from route_runs where id = p_run and tenant_id = private.current_tenant();
  if rr.id is null then raise exception 'Not found'; end if;
  if length(coalesce(trim(p_body), '')) < 5 then raise exception 'Write the message'; end if;
  for c in select * from jsonb_array_elements(private.route_customers(rr.id)) loop
    if p_companies is not null and not ((c->>'company_id')::uuid = any(p_companies)) then continue; end if;
    for e in select * from jsonb_array_elements(c->'emails') loop
      insert into email_outbox (tenant_id, person_id, to_email, subject, body)
      values (rr.tenant_id, (e->>'person_id')::uuid, e->>'email', left(coalesce(nullif(trim(p_subject), ''), 'A change to your service day'), 200),
              replace(p_body, '{company}', c->>'company')) returning id into v;
      perform private.send_email_hook(v);
      n := n + 1;
    end loop;
    perform private.emit(rr.tenant_id, 'note', 'Route moved: customer emailed', null, (c->>'company_id')::uuid,
      jsonb_build_object('body', 'Route visit moved to ' || to_char(rr.run_date + 1, 'Mon DD') || '. Emailed: ' || coalesce((select string_agg(x->>'email', ', ') from jsonb_array_elements(c->'emails') x), 'nobody (no email on file)')));
  end loop;
  return n;
end $$;

-- the worker taps Arrived or Left. The phone's location is checked against the stop at that moment only.
create or replace function public.route_stop_tap(p_run_stop uuid, p_action text, p_lat double precision default null, p_lng double precision default null,
  p_accuracy double precision default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare rs route_run_stops; rr route_runs; s route_stops; slat double precision; slng double precision; rad int; ft double precision; v_far boolean := false;
begin
  if not private.feature_on('routes') then raise exception 'Routes are off'; end if;
  select * into rs from route_run_stops where id = p_run_stop and tenant_id = private.current_tenant() for update;
  if rs.id is null then raise exception 'Not found'; end if;
  select * into rr from route_runs where id = rs.run_id;
  if rr.status in ('dismissed', 'pushed') then raise exception 'This route was % for today', case rr.status when 'pushed' then 'moved to tomorrow' else 'called off' end; end if;
  if not (auth.uid() = any(private.route_people(rr.route_id, rr.run_date)) or rs.user_id is not distinct from auth.uid() or private.routes_manage()) then raise exception 'Not your stop'; end if;
  select * into s from route_stops where id = rs.stop_id;
  select coalesce(s.lat, p.lat), coalesce(s.lng, p.lng), coalesce(s.radius_ft, p.radius_ft, (private.acct_setting('gps_radius_ft')#>>'{}')::int, 500)
    into slat, slng, rad
    from (select 1) one left join location_pins p on p.id = coalesce(s.pin_id, (select id from location_pins where company_id = s.company_id and archived_at is null order by is_primary desc, created_at limit 1));
  -- an approved one-time exception for this stop today counts as being there
  if p_lat is not null and slat is not null then
    ft := private.feet_between(slat, slng, p_lat, p_lng);
    v_far := ft > rad + least(coalesce(p_accuracy, 0) * 3.28084, 300)
           and not exists (select 1 from route_exceptions where run_stop_id = rs.id and status = 'approved');
  end if;
  if p_action = 'arrived' then
    update route_run_stops set status = case when status = 'pending' then 'arrived' else status end, arrived_at = now(), arrived_by = auth.uid(),
      arrived_lat = p_lat, arrived_lng = p_lng, arrived_feet = ft, far = route_run_stops.far or v_far where id = rs.id;
  elsif p_action = 'left' then
    update route_run_stops set status = case when status = 'incomplete' then status else 'done' end, left_at = now(), left_by = auth.uid(),
      left_lat = p_lat, left_lng = p_lng, left_feet = ft, far = route_run_stops.far or v_far,
      arrived_at = coalesce(arrived_at, now()), arrived_by = coalesce(arrived_by, auth.uid()) where id = rs.id;
  else
    raise exception 'Unknown action';
  end if;
  update route_runs set status = 'started', started_at = coalesce(started_at, now()) where id = rr.id and status in ('scheduled', 'late');
  update route_runs set status = 'done' where id = rr.id and not exists (select 1 from route_run_stops where run_id = rr.id and status in ('pending', 'arrived'));
  if p_action = 'left' then
    perform private.emit(rr.tenant_id, 'note', 'Route stop ' || case when rs.status = 'incomplete' then 'left incomplete' else 'done' end, null, s.company_id,
      jsonb_build_object('body', 'Route stop ' || case when rs.status = 'incomplete' then 'not finished: ' || coalesce(rs.reason, '') else 'done' end || ' (' || (select name from routes where id = rr.route_id) || ')'));
  end if;
  return jsonb_build_object('ok', true, 'far', v_far, 'feet', round(ft::numeric), 'radius', rad, 'no_gps', p_lat is null, 'no_pin', slat is null);
end $$;

-- couldn't finish a stop: why, with photos and videos
create or replace function public.route_stop_incomplete(p_run_stop uuid, p_reason text, p_media text[] default '{}') returns void
language plpgsql security definer set search_path = public, private as $$
declare rs route_run_stops; rr route_runs; ro routes;
begin
  select * into rs from route_run_stops where id = p_run_stop and tenant_id = private.current_tenant() for update;
  if rs.id is null then raise exception 'Not found'; end if;
  select * into rr from route_runs where id = rs.run_id;
  select * into ro from routes where id = rr.route_id;
  if not (auth.uid() = any(private.route_people(rr.route_id, rr.run_date)) or rs.user_id is not distinct from auth.uid() or private.routes_manage()) then raise exception 'Not your stop'; end if;
  if length(coalesce(trim(p_reason), '')) < 2 then raise exception 'Say why it couldn''t be finished'; end if;
  if exists (select 1 from unnest(coalesce(p_media, '{}')) m where split_part(m, '/', 1) <> rs.tenant_id::text) then raise exception 'Bad file'; end if;
  update route_run_stops set status = 'incomplete', reason = left(trim(p_reason), 2000), media = media || coalesce(p_media, '{}') where id = rs.id;
  if ro.dispatcher_id is not null and ro.dispatcher_id <> auth.uid() then
    perform private.urgent(rs.tenant_id, array[ro.dispatcher_id], 'route_incomplete', 'Stop not finished on ' || ro.name,
      (select name from companies c join route_stops s on s.company_id = c.id where s.id = rs.stop_id) || ': ' || left(trim(p_reason), 300), '#routes/' || ro.id);
  end if;
end $$;

-- "I'm at the right place, the pin is wrong": one time (just today) or permanent (moves the stop), for the dispatcher to approve
create or replace function public.route_location_report(p_run_stop uuid, p_scope text, p_reason text, p_lat double precision, p_lng double precision) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare rs route_run_stops; rr route_runs; ro routes; v uuid; ft double precision;
begin
  select * into rs from route_run_stops where id = p_run_stop and tenant_id = private.current_tenant();
  if rs.id is null then raise exception 'Not found'; end if;
  select * into rr from route_runs where id = rs.run_id;
  select * into ro from routes where id = rr.route_id;
  if not (auth.uid() = any(private.route_people(rr.route_id, rr.run_date)) or rs.user_id is not distinct from auth.uid() or private.routes_manage()) then raise exception 'Not your stop'; end if;
  if p_scope not in ('once', 'permanent') then raise exception 'One time or permanent?'; end if;
  if p_scope = 'permanent' and (p_lat is null or p_lng is null) then raise exception 'A permanent change needs your location. Turn location on and try again.'; end if;
  ft := coalesce(rs.arrived_feet, rs.left_feet);
  insert into route_exceptions (tenant_id, run_stop_id, stop_id, scope, reason, lat, lng, feet)
  values (rs.tenant_id, rs.id, rs.stop_id, p_scope, trim(p_reason), p_lat, p_lng, ft) returning id into v;
  perform private.urgent(rs.tenant_id, case when ro.dispatcher_id is not null then array[ro.dispatcher_id] else array(select id from app_users where tenant_id = rs.tenant_id and is_admin and active and forward_to is null) end,
    'route_location', 'Location check on ' || ro.name, (select name from companies c join route_stops s on s.company_id = c.id where s.id = rs.stop_id) || ' (' ||
    case p_scope when 'permanent' then 'move the stop for good' else 'just today' end || '): ' || left(trim(p_reason), 300), '#routes/' || ro.id);
  return v;
end $$;

create or replace function public.route_exception_decide(p_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public, private as $$
declare e route_exceptions;
begin
  if not private.routes_manage() then raise exception 'Not allowed'; end if;
  select * into e from route_exceptions where id = p_id and tenant_id = private.current_tenant() and status = 'pending' for update;
  if e.id is null then raise exception 'Already decided'; end if;
  update route_exceptions set status = case when p_approve then 'approved' else 'denied' end, decided_by = auth.uid(), decided_at = now() where id = e.id;
  if p_approve then
    update route_run_stops set far = false where id = e.run_stop_id;
    if e.scope = 'permanent' then update route_stops set lat = e.lat, lng = e.lng, pin_id = null where id = e.stop_id; end if;
  end if;
  perform private.urgent(e.tenant_id, array[e.user_id], 'route_location', 'Location ' || case when p_approve then 'approved' else 'not approved' end,
    case when p_approve and e.scope = 'permanent' then 'The stop now uses the spot you reported.' when p_approve then 'Approved for today.' else 'Check with your dispatcher.' end, '#myday');
end $$;

-- hourly location while on the clock, only for people an admin turned it on for
create or replace function public.gps_ping(p_lat double precision, p_lng double precision, p_accuracy double precision default null) returns boolean
language plpgsql security definer set search_path = public, private as $$
declare te uuid;
begin
  if not exists (select 1 from app_users where id = auth.uid() and gps_tracking) then return false; end if;
  select id into te from time_entries where user_id = auth.uid() and clock_out is null;
  if te is null then return false; end if;
  if exists (select 1 from gps_pings where user_id = auth.uid() and at > now() - interval '50 minutes') then return true; end if;
  insert into gps_pings (tenant_id, user_id, time_entry_id, lat, lng, accuracy_m) values (private.current_tenant(), auth.uid(), te, p_lat, p_lng, p_accuracy);
  return true;
end $$;

create or replace function public.gps_tracking_set(p_user uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_admin() then raise exception 'Only an admin can change location tracking'; end if;
  update app_users set gps_tracking = p_on where id = p_user and tenant_id = private.current_tenant();
end $$;

-- reorder a route's stops in one go
create or replace function public.route_stops_order(p_route uuid, p_ids uuid[]) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.routes_manage() then raise exception 'Not allowed'; end if;
  update route_stops s set sort = x.i from unnest(p_ids) with ordinality x(id, i) where s.id = x.id and s.route_id = p_route and s.tenant_id = private.current_tenant();
  -- today's runs that haven't started follow the new order
  update route_run_stops rs set sort = s.sort from route_stops s, route_runs rr
   where rs.stop_id = s.id and rs.run_id = rr.id and rr.route_id = p_route and rr.status = 'scheduled' and rr.run_date >= current_date;
end $$;

revoke execute on function public.my_routes(), public.route_board(uuid, date), public.route_run_action(uuid, text, jsonb), public.route_notify_customers(uuid, text, text, uuid[]),
  public.route_stop_tap(uuid, text, double precision, double precision, double precision), public.route_stop_incomplete(uuid, text, text[]),
  public.route_location_report(uuid, text, text, double precision, double precision), public.route_exception_decide(uuid, boolean),
  public.gps_ping(double precision, double precision, double precision), public.gps_tracking_set(uuid, boolean), public.route_stops_order(uuid, uuid[]) from public, anon;
grant execute on function public.my_routes(), public.route_board(uuid, date), public.route_run_action(uuid, text, jsonb), public.route_notify_customers(uuid, text, text, uuid[]),
  public.route_stop_tap(uuid, text, double precision, double precision, double precision), public.route_stop_incomplete(uuid, text, text[]),
  public.route_location_report(uuid, text, text, double precision, double precision), public.route_exception_decide(uuid, boolean),
  public.gps_ping(double precision, double precision, double precision), public.gps_tracking_set(uuid, boolean), public.route_stops_order(uuid, uuid[]) to authenticated;
