-- 078b: booking calendars, part 2. Calendars, each person's weekly hours, date overrides and days off, outside busy
-- times (the seam for Google and Outlook sync later) and appointments. Writes go through the functions in 078d and 078f;
-- the app reads these tables directly under row security.

create table if not exists public.calendars (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  name text not null check (length(trim(name)) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  description text check (description is null or length(description) <= 2000),
  color text not null default '#2563EB' check (color ~* '^#[0-9a-f]{6}$'),
  kind text not null default 'one' check (kind in ('one', 'round_robin', 'pick')),   -- one person, round robin, or the customer picks
  user_ids uuid[] not null default '{}',                                             -- who takes bookings (home team or members)
  duration_min int not null default 30 check (duration_min between 5 and 720),
  durations int[] not null default '{}',                                             -- extra lengths the customer can choose
  slot_min int not null default 30 check (slot_min between 5 and 240),               -- a start time every this many minutes
  buffer_before int not null default 0 check (buffer_before between 0 and 240),
  buffer_after int not null default 0 check (buffer_after between 0 and 240),
  notice_min int not null default 120 check (notice_min between 0 and 43200),         -- minimum notice
  ahead_days int not null default 60 check (ahead_days between 1 and 365),           -- how far ahead people can book
  daily_max int check (daily_max is null or daily_max between 1 and 100),            -- per person per day
  location_kind text not null default 'phone' check (location_kind in ('phone', 'video', 'in_person', 'customer')),
  location_text text check (location_text is null or length(location_text) <= 500),  -- video link or the address
  questions jsonb not null default '[]'::jsonb,                                       -- [{key, label, kind short|long|choice, options, required}]
  ask_company boolean not null default false,
  confirm_text text check (confirm_text is null or length(confirm_text) <= 2000),
  redirect_url text check (redirect_url is null or redirect_url ~ '^https://'),
  time_zone text not null default 'America/Chicago',
  allow_cancel boolean not null default true,
  allow_reschedule boolean not null default true,
  cutoff_hours int not null default 4 check (cutoff_hours between 0 and 720),       -- no changes by the customer this close to the start
  reminders int[] not null default '{1440,60}',                                      -- minutes before the start
  active boolean not null default true,
  divisions uuid[] not null default '{}',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index if not exists calendars_slug on public.calendars (tenant_id, slug) where archived_at is null;
alter table public.calendars enable row level security;
create policy "team sees calendars" on public.calendars for select using (tenant_id = private.current_tenant() and private.cal_see());
revoke all on public.calendars from anon, authenticated;
grant select on public.calendars to authenticated;

-- each person's weekly hours in an account. weekly: {"0": [["09:00","17:00"]], ... "6": []}, 0 is Sunday.
create table if not exists public.cal_hours (
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.app_users(id) on delete cascade,
  weekly jsonb not null default '{"1":[["09:00","17:00"]],"2":[["09:00","17:00"]],"3":[["09:00","17:00"]],"4":[["09:00","17:00"]],"5":[["09:00","17:00"]]}'::jsonb,
  time_zone text not null default 'America/Chicago',
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (tenant_id, user_id)
);
alter table public.cal_hours enable row level security;
create policy "team sees hours" on public.cal_hours for select using (tenant_id = private.current_tenant() and private.cal_see());
revoke all on public.cal_hours from anon, authenticated;
grant select on public.cal_hours to authenticated;

-- one day different from the week: other hours that day, or off ([] ranges)
create table if not exists public.cal_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.app_users(id) on delete cascade,
  day date not null,
  ranges jsonb not null default '[]'::jsonb,
  note text check (note is null or length(note) <= 300),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id, day)
);
alter table public.cal_overrides enable row level security;
create policy "team sees days off" on public.cal_overrides for select using (tenant_id = private.current_tenant() and private.cal_see());
revoke all on public.cal_overrides from anon, authenticated;
grant select on public.cal_overrides to authenticated;

-- busy times from outside calendars (Google, Outlook later). Belongs to the person, not an account: busy is busy
-- everywhere they work. The sync writes here with the service key; nobody writes from the app.
create table if not exists public.cal_busy (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  source text not null default 'manual' check (source in ('google', 'outlook', 'ical', 'manual')),
  external_id text,
  title text,                     -- kept private to the person
  synced_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists cal_busy_user on public.cal_busy (user_id, starts_at);
create unique index if not exists cal_busy_ext on public.cal_busy (user_id, source, external_id) where external_id is not null;
alter table public.cal_busy enable row level security;
create policy "own busy times" on public.cal_busy for select using (user_id = auth.uid());
revoke all on public.cal_busy from anon, authenticated;
grant select on public.cal_busy to authenticated;

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  calendar_id uuid references public.calendars(id),
  user_id uuid references public.app_users(id),             -- the team member it's with
  person_id uuid references public.people(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timed_at timestamptz not null default now(),             -- when this start time was set (booked or last moved), for reminders
  buffer_before int not null default 0,
  buffer_after int not null default 0,
  status text not null default 'booked' check (status in ('booked', 'confirmed', 'cancelled', 'no_show', 'completed', 'rescheduled')),
  title text check (title is null or length(title) <= 200),
  location text check (location is null or length(location) <= 500),
  name text check (name is null or length(name) <= 200),
  email text check (email is null or length(email) <= 320),
  phone text check (phone is null or length(phone) <= 40),
  company_name text check (company_name is null or length(company_name) <= 200),
  answers jsonb not null default '[]'::jsonb,               -- [{label, value}]
  notes text check (notes is null or length(notes) <= 5000),
  visitor_tz text,
  source text not null default 'manual' check (source in ('booking', 'manual')),
  manage_token text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 1000),
  cancelled_at timestamptz,
  cancelled_by text,                                         -- customer or a team member's name
  history jsonb not null default '[]'::jsonb,               -- [{at, by, what, from, to}]
  ip text,
  divisions uuid[] not null default '{}',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists appointments_user on public.appointments (user_id, starts_at) where status <> 'cancelled';
create index if not exists appointments_tenant on public.appointments (tenant_id, starts_at);
create index if not exists appointments_person on public.appointments (person_id);
create index if not exists appointments_company on public.appointments (company_id);
create index if not exists appointments_cal on public.appointments (calendar_id, created_at);
alter table public.appointments enable row level security;
create policy "team sees appointments" on public.appointments for select
  using (tenant_id = private.current_tenant() and private.cal_see() and private.in_scope('calendars', user_id, divisions));
revoke all on public.appointments from anon, authenticated;
grant select (id, tenant_id, calendar_id, user_id, person_id, company_id, starts_at, ends_at, timed_at, buffer_before, buffer_after, status, title, location, name, email, phone,
  company_name, answers, notes, visitor_tz, source, cancel_reason, cancelled_at, cancelled_by, history, divisions, created_by, created_at, updated_at)
  on public.appointments to authenticated;   -- never the manage token or the IP

-- emails waiting to go out (confirmation, team notice, cancel, reschedule, reminders). The booking-email function sends them.
create table if not exists private.cal_mail (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  kind text not null check (kind in ('confirm', 'notice', 'cancel', 'cancel_notice', 'reschedule', 'reschedule_notice', 'reminder')),
  to_email text not null,
  minutes int,                       -- reminders: how long before
  for_start timestamptz,             -- the start it was about (a reschedule sends reminders again)
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  tries int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create unique index if not exists cal_mail_once on private.cal_mail (appointment_id, kind, coalesce(minutes, -1), for_start);
create index if not exists cal_mail_queued on private.cal_mail (created_at) where status = 'queued';
revoke all on private.cal_mail from public, anon, authenticated;

-- team members can see which emails went out for appointments they can see
create or replace function public.appointment_mail(p_id uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('kind', m.kind, 'to', m.to_email, 'minutes', m.minutes, 'status', m.status, 'error', m.error, 'at', coalesce(m.sent_at, m.created_at))
    order by m.created_at), '[]'::jsonb)
  from private.cal_mail m join appointments a on a.id = m.appointment_id
  where a.id = p_id and a.tenant_id = private.current_tenant() and private.cal_see() and private.in_scope('calendars', a.user_id, a.divisions)
$$;
revoke execute on function public.appointment_mail(uuid) from public, anon;
grant execute on function public.appointment_mail(uuid) to authenticated;
