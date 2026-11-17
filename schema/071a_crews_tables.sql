-- 071: crews on jobs (Oct 30, 2026). Decisions: BACKLOG.md "Oct 30 morning voice decisions", Crews bullet.
-- Saved crews: a foreman plus members. Assign the crew to a job and everyone comes along. Or the account skips
--   standing crews and picks people per job. Setting: account_settings.crews.mode = 'standing' or 'pick' (default).
-- job_crew lists everyone on a job. jobs.assigned_to stays the foreman or lead, so everything older keeps working.
-- Anyone can be pulled onto another job's crew without changing their default crew. That swap goes to Review
--   (crew_flags kind 'swap') only when someone other than the default crew's supervisor made it.
-- Clocking: crews.clock = 'self' (default, everyone clocks themselves) or 'foreman' (the foreman clocks the crew).
-- Steps: crews.steps = 'foreman' (default, the foreman marks arrived and left for the crew) or 'each' (each person
--   also marks their own arrived and left). Both can be set per service type in crews.by_service.
-- Missed clock-in: the foreman marks arrived and a crew member has no time running. A crew_flags row goes to the
--   foreman and the supervisor. "Was here" makes a time entry flagged added_by_foreman that waits in Review as a
--   timesheet; "wasn't here" marks them absent on the job.
-- Pay: crews.pay = 'hours' (default, each person by their own hours and rates) or 'split' (the job's pay split
--   across the crew, equal unless a share is set).

alter table public.app_users add column if not exists manager_id uuid references public.app_users(id);

create table if not exists public.crews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  name text not null check (length(trim(name)) between 1 and 60),
  foreman_id uuid not null references public.app_users(id),
  member_ids uuid[] not null default '{}',
  supervisor_id uuid references public.app_users(id),
  divisions uuid[] not null default '{}',
  sort int not null default 0,
  created_by uuid references public.app_users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists crews_tenant on public.crews (tenant_id) where archived_at is null;

create table if not exists public.job_crew (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  job_id uuid not null,               -- no foreign key: schedule_apply clears untouched upcoming jobs; their crew rows just sit unused
  user_id uuid not null references public.app_users(id),
  role text not null default 'member' check (role in ('lead', 'member')),
  from_crew_id uuid references public.crews(id),       -- their default crew when they were added
  share numeric(6,3) check (share is null or share between 0 and 100),   -- percent of the job pay when split; blank = equal
  absent boolean not null default false,
  arrived_at timestamptz, left_at timestamptz,
  arrive_lat double precision, arrive_lng double precision, arrive_feet double precision,
  leave_lat double precision, leave_lng double precision, leave_feet double precision,
  pay_batch_id uuid,
  added_by uuid references public.app_users(id) default auth.uid(),
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (job_id, user_id)
);
create index if not exists job_crew_user on public.job_crew (user_id) where removed_at is null;

alter table public.jobs add column if not exists crew_id uuid references public.crews(id);
alter table public.job_schedules add column if not exists crew_id uuid references public.crews(id);
alter table public.work_reviews add column if not exists supervisor_id uuid references public.app_users(id);

create table if not exists public.crew_flags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  kind text not null check (kind in ('missed_clock', 'swap')),
  job_id uuid not null,               -- no foreign key, same reason as job_crew
  user_id uuid not null references public.app_users(id),        -- the crew member it's about
  foreman_id uuid references public.app_users(id),
  supervisor_id uuid references public.app_users(id),
  divisions uuid[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'was_here', 'not_here', 'clocked_in', 'seen')),
  summary text,
  details jsonb not null default '{}'::jsonb,
  time_entry_id uuid references public.time_entries(id),
  answered_by uuid references public.app_users(id), answered_at timestamptz,
  created_by uuid references public.app_users(id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists crew_flags_open on public.crew_flags (tenant_id, status, created_at);

alter table public.crews enable row level security;
alter table public.job_crew enable row level security;
alter table public.crew_flags enable row level security;
revoke all on public.crews, public.job_crew, public.crew_flags from anon, authenticated;
grant select on public.crews, public.job_crew, public.crew_flags to authenticated;

create trigger audit_crews after insert or update on public.crews for each row execute function private.audit();
create trigger audit_job_crew after insert or update on public.job_crew for each row execute function private.audit();
create trigger audit_crew_flags after insert or update on public.crew_flags for each row execute function private.audit();
create trigger touch_crews before update on public.crews for each row execute function private.touch();

