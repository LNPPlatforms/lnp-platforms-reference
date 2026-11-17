-- 062: time clock, worker pay, pay periods, payroll export and the accounting connector (Oct 29, 2026).
-- Time clock: clock in and out (with breaks), tied to a job, location and division, GPS on both ends.
--   A manager can fix any entry but must give a reason; the audit log keeps the before and after.
-- Pay: each worker has rates by pay type (hourly, daily, per job), optionally per division, with history
--   (effective dates) so old periods stay right. Whether one person can have mixed pay types is an account setting.
-- Pay periods: daily, twice a week, weekly, every two weeks, twice a month, monthly or fully custom, each with
--   its own cutoff days and payday lag. Accounts save their own.
-- Pay batches: built from approved time and approved jobs only. W-2 and 1099 always build as separate batches.
--   A batch exports through a template (ADP RUN, ADP Workforce Now, Gusto, QuickBooks, generic or the account's own).
--   The CRM never moves money or runs payroll; it hands approved numbers to the payroll or accounting system.
-- Accounting connector: provider-neutral tables (Wave first, QuickBooks and Xero later on the same pattern).
--   Only labor, contractor pay and invoices are ever queued; other job costs never are. The sync itself (the
--   Supabase function that talks to Wave) is built separately; tokens live where only that function can read them.

create table if not exists public.worker_pay_profiles (
  user_id uuid primary key references public.app_users(id),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  worker_class text not null default 'w2' check (worker_class in ('w2', '1099')),
  external_id text,          -- the payroll system's ID for this person (ADP file number, Gusto ID...)
  payroll_code text,         -- company or department code the payroll system wants on the line
  tax_doc text not null default 'missing' check (tax_doc in ('missing', 'requested', 'received')),   -- W-4 for W-2, W-9 for 1099
  tax_doc_at date,
  payout_note text,          -- where pay goes, in words ("Direct deposit set up in ADP"). Never bank numbers.
  updated_at timestamptz not null default now(),
  updated_by uuid references public.app_users(id) default auth.uid()
);

create table if not exists public.pay_rates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  user_id uuid not null references public.app_users(id),
  division_id uuid references public.divisions(id),     -- blank: everywhere else
  kind text not null check (kind in ('hourly', 'daily', 'per_job')),
  rate numeric(12,2) not null check (rate >= 0),
  effective_from date not null default current_date,
  note text,
  created_by uuid references public.app_users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists pay_rates_user on public.pay_rates (user_id, effective_from desc) where archived_at is null;

create table if not exists public.time_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  user_id uuid not null references public.app_users(id) default auth.uid(),
  job_id uuid references public.jobs(id),
  company_id uuid references public.companies(id),
  divisions uuid[] not null default '{}',
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  breaks jsonb not null default '[]'::jsonb,     -- [{start, end}]
  break_min int not null default 0 check (break_min >= 0),
  in_lat double precision, in_lng double precision, in_feet double precision,
  out_lat double precision, out_lng double precision, out_feet double precision,
  flags text[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'pending', 'approved', 'auto', 'returned')),
  note text,
  edited_by uuid references public.app_users(id),
  edit_reason text,
  pay_batch_id uuid,
  created_at timestamptz not null default now(),
  check (clock_out is null or clock_out > clock_in)
);
create index if not exists time_entries_user on public.time_entries (user_id, clock_in desc);
create unique index if not exists time_entries_one_open on public.time_entries (user_id) where clock_out is null;
alter table public.jobs add column if not exists pay_batch_id uuid;

create table if not exists public.pay_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  freq text not null check (freq in ('daily', 'twice_weekly', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'custom')),
  anchor date not null default current_date,         -- a day a period starts on (biweekly counts from here)
  cut_days int[] not null default '{}',              -- weekdays 1-7 (twice weekly, weekly, custom weekly) or month days 1-31 (semimonthly, monthly, custom monthly)
  custom_unit text check (custom_unit in ('week', 'month')),
  payday_lag_days int not null default 5 check (payday_lag_days between 0 and 31),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.pay_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  schedule_id uuid references public.pay_schedules(id),
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  pay_date date,
  worker_class text not null check (worker_class in ('w2', '1099')),
  status text not null default 'draft' check (status in ('draft', 'final', 'exported')),
  total numeric(12,2) not null default 0,
  built_by uuid references public.app_users(id) default auth.uid(),
  built_at timestamptz not null default now(),
  finalized_by uuid references public.app_users(id), finalized_at timestamptz,
  exported_by uuid references public.app_users(id), exported_at timestamptz, export_template text
);

create table if not exists public.pay_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  batch_id uuid not null references public.pay_batches(id) on delete cascade,
  user_id uuid not null references public.app_users(id),
  division_id uuid references public.divisions(id),
  kind text not null check (kind in ('hourly', 'overtime', 'daily', 'per_job', 'adjustment')),
  hours numeric(10,2) not null default 0,
  days int not null default 0,
  jobs int not null default 0,
  rate numeric(12,2) not null default 0,
  amount numeric(12,2) not null default 0,
  time_entry_ids uuid[] not null default '{}',
  job_ids uuid[] not null default '{}',
  note text
);
create index if not exists pay_lines_batch on public.pay_lines (batch_id);

create table if not exists public.export_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  base text,                       -- the built-in template it started from
  fields jsonb not null default '[]'::jsonb,   -- [{key, header}] in column order
  delimiter text not null default ',' check (delimiter in (',', ';', E'\t', '|')),
  header_row boolean not null default true,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

-- accounting connector (Wave first)
create table if not exists public.acct_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  provider text not null check (provider in ('wave', 'quickbooks', 'xero')),
  status text not null default 'disconnected' check (status in ('disconnected', 'connected', 'error')),
  external_business_id text,
  external_business_name text,
  last_error text,
  connected_by uuid references public.app_users(id),
  connected_at timestamptz,
  settings jsonb not null default '{}'::jsonb,   -- push_invoices, push_contractor_bills, push_payroll_journal, pull_paid_status
  unique (tenant_id, provider)
);
-- tokens: no grants to app logins at all; only the sync function (service role) reads and writes them
create table if not exists private.acct_tokens (
  connection_id uuid primary key references public.acct_connections(id) on delete cascade,
  access_token text, refresh_token text, expires_at timestamptz, scope text, updated_at timestamptz not null default now()
);
create table if not exists public.acct_mappings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  provider text not null,
  kind text not null check (kind in ('income', 'labor', 'contractor', 'payroll_clearing', 'contractor_vendor')),
  division_id uuid references public.divisions(id),
  pay_kind text,
  external_id text not null,
  external_name text,
  unique (tenant_id, provider, kind, division_id, pay_kind)
);
create table if not exists public.acct_sync_queue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  provider text not null,
  entity_type text not null check (entity_type in ('invoice', 'payment', 'contractor_bill', 'payroll_journal')),
  entity_id uuid not null,
  idempotency_key text not null,        -- the same thing queued twice never posts twice
  payload jsonb not null default '{}'::jsonb,
  amount numeric(12,2),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts int not null default 0,
  last_error text,
  external_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (tenant_id, provider, idempotency_key)
);

alter table public.worker_pay_profiles enable row level security;
alter table public.pay_rates enable row level security;
alter table public.time_entries enable row level security;
alter table public.pay_schedules enable row level security;
alter table public.pay_batches enable row level security;
alter table public.pay_lines enable row level security;
alter table public.export_templates enable row level security;
alter table public.acct_connections enable row level security;
alter table public.acct_mappings enable row level security;
alter table public.acct_sync_queue enable row level security;
alter table private.acct_tokens enable row level security;

create policy "see pay profile" on public.worker_pay_profiles for select using (tenant_id = private.current_tenant() and (user_id = auth.uid() or private.can('pay', 1)));
create policy "manage pay profile" on public.worker_pay_profiles for all using (tenant_id = private.current_tenant() and private.can('pay', 4))
  with check (tenant_id = private.current_tenant() and private.can('pay', 4) and exists (select 1 from app_users u where u.id = user_id and u.tenant_id = private.current_tenant()));
create policy "see pay rates" on public.pay_rates for select using (tenant_id = private.current_tenant() and (user_id = auth.uid() or private.can('pay', 1)));
create policy "see time" on public.time_entries for select using (tenant_id = private.current_tenant() and private.feature_on('timeclock')
  and (user_id = auth.uid() or (private.can('timeclock', 1) and private.in_scope('timeclock', user_id, divisions))));
create policy "see pay schedules" on public.pay_schedules for select using (tenant_id = private.current_tenant() and private.is_internal());
create policy "manage pay schedules" on public.pay_schedules for all using (tenant_id = private.current_tenant() and private.can('pay', 4)) with check (tenant_id = private.current_tenant() and private.can('pay', 4));
create policy "see pay batches" on public.pay_batches for select using (tenant_id = private.current_tenant() and private.can('pay', 1));
create policy "see pay lines" on public.pay_lines for select using (tenant_id = private.current_tenant() and (user_id = auth.uid() and exists (select 1 from pay_batches b where b.id = batch_id and b.status <> 'draft') or private.can('pay', 1)));
create policy "see export templates" on public.export_templates for select using (tenant_id = private.current_tenant() and private.can('pay', 1));
create policy "manage export templates" on public.export_templates for all using (tenant_id = private.current_tenant() and private.can('pay', 4)) with check (tenant_id = private.current_tenant() and private.can('pay', 4));
create policy "see accounting" on public.acct_connections for select using (tenant_id = private.current_tenant() and (private.can('pay', 1) or private.can('settings', 4)));
create policy "manage accounting settings" on public.acct_connections for update using (tenant_id = private.current_tenant() and private.can('settings', 4)) with check (tenant_id = private.current_tenant() and private.can('settings', 4));
create policy "see mappings" on public.acct_mappings for select using (tenant_id = private.current_tenant() and (private.can('pay', 1) or private.can('settings', 4)));
create policy "manage mappings" on public.acct_mappings for all using (tenant_id = private.current_tenant() and private.can('pay', 4)) with check (tenant_id = private.current_tenant() and private.can('pay', 4));
create policy "see sync queue" on public.acct_sync_queue for select using (tenant_id = private.current_tenant() and private.can('pay', 1));

revoke all on public.worker_pay_profiles, public.pay_rates, public.time_entries, public.pay_schedules, public.pay_batches, public.pay_lines,
  public.export_templates, public.acct_connections, public.acct_mappings, public.acct_sync_queue from anon, authenticated;
revoke all on private.acct_tokens from anon, authenticated;
grant select, insert, update on public.worker_pay_profiles, public.pay_schedules, public.export_templates, public.acct_mappings to authenticated;
grant delete on public.acct_mappings to authenticated;
grant select on public.pay_rates, public.time_entries, public.pay_batches, public.pay_lines, public.acct_sync_queue, public.acct_connections to authenticated;
grant update (settings) on public.acct_connections to authenticated;

create trigger audit_pay_profiles after insert or update on public.worker_pay_profiles for each row execute function private.audit();
create trigger audit_pay_rates after insert or update on public.pay_rates for each row execute function private.audit();
create trigger audit_time_entries after insert or update on public.time_entries for each row execute function private.audit();
create trigger audit_pay_batches after insert or update on public.pay_batches for each row execute function private.audit();
create trigger audit_acct_mappings after insert or update on public.acct_mappings for each row execute function private.audit();
create trigger audit_acct_connections after insert or update on public.acct_connections for each row execute function private.audit();

-- the rate that applied to a person on a day, for a division (a division's own rate beats the general one)
create or replace function private.rate_on(p_user uuid, p_div uuid, p_day date, out kind text, out rate numeric)
language sql stable security definer set search_path = public, private as $$
  select r.kind, r.rate from pay_rates r
  where r.user_id = p_user and r.archived_at is null and r.effective_from <= p_day and (r.division_id = p_div or r.division_id is null)
  order by (r.division_id is not null) desc, r.effective_from desc, r.created_at desc limit 1
$$;

create or replace function public.pay_rate_save(p_user uuid, p_kind text, p_rate numeric, p_division uuid, p_from date, p_note text)
returns uuid language plpgsql security definer set search_path = public, private as $$
declare out uuid;
begin
  if not private.can('pay', 4) then raise exception 'Only someone who manages pay can set rates'; end if;
  if not exists (select 1 from app_users where id = p_user and tenant_id = private.current_tenant()) then raise exception 'Person not found'; end if;
  if not coalesce((private.acct_setting('mixed_pay_types')#>>'{}')::boolean, true)
     and exists (select 1 from pay_rates where user_id = p_user and archived_at is null and kind <> p_kind) then
    raise exception 'This account pays each person one way. Turn on mixed pay types in Settings to add a second.';
  end if;
  insert into pay_rates (user_id, kind, rate, division_id, effective_from, note) values (p_user, p_kind, p_rate, p_division, coalesce(p_from, current_date), p_note) returning id into out;
  return out;
end $$;

-- clock in: one open entry per person
create or replace function public.clock_in(p_job uuid, p_company uuid, p_lat double precision, p_lng double precision, p_accuracy double precision)
returns uuid language plpgsql security definer set search_path = public, private as $$
declare j jobs; cid uuid := p_company; divs uuid[] := '{}'; feet double precision; rad int; pin uuid; fl text[] := '{}'; out uuid;
begin
  if not private.feature_on('timeclock') or not private.can('timeclock', 2) then raise exception 'The time clock isn''t on for you'; end if;
  if exists (select 1 from time_entries where user_id = auth.uid() and clock_out is null) then raise exception 'You''re already clocked in'; end if;
  if p_job is not null then
    select * into j from jobs where id = p_job and tenant_id = private.current_tenant();
    if j.id is null then raise exception 'Job not found'; end if;
    cid := j.company_id; divs := j.divisions;
  elsif cid is not null then
    select divisions into divs from companies where id = cid and tenant_id = private.current_tenant();
  end if;
  if cid is not null and p_lat is not null then
    select n.pin_id, n.feet, n.radius into pin, feet, rad from private.nearest_pin(cid, p_lat, p_lng) n;
    if pin is not null and feet > rad then fl := fl || 'far_in'::text; end if;
  elsif p_lat is null then fl := fl || 'no_gps'::text;
  end if;
  insert into time_entries (job_id, company_id, divisions, in_lat, in_lng, in_feet, flags)
  values (p_job, cid, coalesce(divs, '{}'), p_lat, p_lng, feet, fl) returning id into out;
  return out;
end $$;

create or replace function public.break_toggle() returns text
language plpgsql security definer set search_path = public, private as $$
declare t time_entries; b jsonb;
begin
  select * into t from time_entries where user_id = auth.uid() and clock_out is null for update;
  if t.id is null then raise exception 'You''re not clocked in'; end if;
  b := t.breaks;
  if jsonb_array_length(b) > 0 and (b->-1->>'end') is null then
    b := jsonb_set(b, array[(jsonb_array_length(b) - 1)::text, 'end'], to_jsonb(now()));
    update time_entries set breaks = b, break_min = (select coalesce(sum(extract(epoch from ((x->>'end')::timestamptz - (x->>'start')::timestamptz)) / 60), 0)::int from jsonb_array_elements(b) x where x->>'end' is not null) where id = t.id;
    return 'working';
  end if;
  update time_entries set breaks = b || jsonb_build_array(jsonb_build_object('start', now())) where id = t.id;
  return 'on_break';
end $$;

create or replace function private.time_auto_ok(t time_entries) returns boolean
language plpgsql stable security definer set search_path = public, private as $$
declare r jsonb := coalesce(private.acct_setting('auto_approve')->'timesheets', '{}'::jsonb);
begin
  if not coalesce((r->>'on')::boolean, false) then return false; end if;
  if coalesce((r->>'in_radius')::boolean, true) and t.flags && array['far_in', 'far_out', 'no_gps'] then return false; end if;
  if (r->>'max_hours') is not null and extract(epoch from (t.clock_out - t.clock_in)) / 3600 - t.break_min / 60.0 > (r->>'max_hours')::numeric then return false; end if;
  if t.edited_by is not null then return false; end if;
  return true;
end $$;

create or replace function public.clock_out(p_lat double precision, p_lng double precision, p_accuracy double precision, p_note text default null)
returns uuid language plpgsql security definer set search_path = public, private as $$
declare t time_entries; feet double precision; rad int; pin uuid; fl text[];
begin
  select * into t from time_entries where user_id = auth.uid() and clock_out is null for update;
  if t.id is null then raise exception 'You''re not clocked in'; end if;
  fl := t.flags;
  if t.company_id is not null and p_lat is not null then
    select n.pin_id, n.feet, n.radius into pin, feet, rad from private.nearest_pin(t.company_id, p_lat, p_lng) n;
    if pin is not null and feet > rad then fl := fl || 'far_out'::text; end if;
  elsif p_lat is null and not ('no_gps' = any(fl)) then fl := fl || 'no_gps'::text;
  end if;
  -- an unfinished break ends at clock out
  if jsonb_array_length(t.breaks) > 0 and (t.breaks->-1->>'end') is null then perform public.break_toggle(); select breaks, break_min into t.breaks, t.break_min from time_entries where id = t.id; end if;
  update time_entries set clock_out = greatest(now(), clock_in + interval '1 minute'), out_lat = p_lat, out_lng = p_lng, out_feet = feet, flags = fl, status = 'pending',
         note = coalesce(nullif(trim(coalesce(p_note, '')), ''), note) where id = t.id returning * into t;
  insert into work_reviews (kind, ref_id, job_id, company_id, divisions, worker_id, summary, details)
  values ('timesheet', t.id, t.job_id, t.company_id, t.divisions, t.user_id,
          format('%s hrs', round((extract(epoch from (t.clock_out - t.clock_in)) / 3600 - t.break_min / 60.0)::numeric, 2)),
          jsonb_build_object('flags', t.flags, 'break_min', t.break_min));
  if private.time_auto_ok(t) then
    update time_entries set status = 'auto' where id = t.id;
    update work_reviews set status = 'auto', decided_at = now(), decision_note = 'Passed the auto-approve rules' where kind = 'timesheet' and ref_id = t.id and status = 'pending';
  end if;
  return t.id;
end $$;

-- a manager fixes an entry; a reason is required and the change goes back to pending review
create or replace function public.time_fix(p_id uuid, p_in timestamptz, p_out timestamptz, p_break_min int, p_reason text)
returns void language plpgsql security definer set search_path = public, private as $$
declare t time_entries;
begin
  select * into t from time_entries where id = p_id and tenant_id = private.current_tenant() for update;
  if t.id is null then raise exception 'Entry not found'; end if;
  if not (private.can('timeclock', 3) and private.in_scope('timeclock', t.user_id, t.divisions)) then raise exception 'You can''t change this entry'; end if;
  if t.user_id = auth.uid() and not private.is_admin() then raise exception 'Someone else has to fix your own time'; end if;
  if t.pay_batch_id is not null and exists (select 1 from pay_batches b where b.id = t.pay_batch_id and b.status <> 'draft') then raise exception 'This time is already in a final pay batch'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why you''re changing it'; end if;
  if p_out is not null and p_out <= p_in then raise exception 'Clock out has to be after clock in'; end if;
  update time_entries set clock_in = p_in, clock_out = p_out, break_min = greatest(coalesce(p_break_min, 0), 0), edited_by = auth.uid(), edit_reason = trim(p_reason),
         status = case when p_out is null then 'open' else 'pending' end, flags = case when 'edited' = any(flags) then flags else flags || 'edited'::text end
   where id = t.id;
  update work_reviews set status = 'pending', decided_at = null, decided_by = null, decision_note = 'Changed by ' || (select full_name from app_users where id = auth.uid()) || ': ' || trim(p_reason)
   where kind = 'timesheet' and ref_id = t.id;
end $$;

-- build a pay batch from approved work in the period. Rebuilding a draft replaces its lines.
-- Overtime (W-2 hourly only): pay_settings.overtime = {weekly_over: 40, daily_over: null, mult: 1.5}
create or replace function public.pay_batch_build(p_start date, p_end date, p_class text, p_schedule uuid default null, p_batch uuid default null)
returns uuid language plpgsql security definer set search_path = public, private as $$
declare b uuid := p_batch; ot jsonb := coalesce(private.acct_setting('pay_settings')->'overtime', '{"weekly_over":40,"mult":1.5}'::jsonb);
  r record; wk record; reg numeric; over numeric; lag int;
begin
  if not private.can('pay', 4) then raise exception 'Only someone who manages pay can build a batch'; end if;
  if p_class not in ('w2', '1099') then raise exception 'Pick W-2 or 1099'; end if;
  if p_batch is not null then
    if not exists (select 1 from pay_batches where id = p_batch and tenant_id = private.current_tenant() and status = 'draft') then raise exception 'Only a draft batch can be rebuilt'; end if;
    delete from pay_lines where batch_id = p_batch;
    update time_entries set pay_batch_id = null where pay_batch_id = p_batch;
    update jobs set pay_batch_id = null where pay_batch_id = p_batch;
    update pay_batches set period_start = p_start, period_end = p_end, built_by = auth.uid(), built_at = now() where id = p_batch;
  else
    select payday_lag_days into lag from pay_schedules where id = p_schedule;
    insert into pay_batches (schedule_id, period_start, period_end, pay_date, worker_class) values (p_schedule, p_start, p_end, p_end + coalesce(lag, 5), p_class) returning id into b;
  end if;

  -- approved time, not already in another batch, for people in this class; each entry priced by the rate that applied that day
  create temp table _t on commit drop as
  select t.id, t.user_id, t.divisions[1] as div, (t.clock_in at time zone 'America/Chicago')::date as day,
         greatest(extract(epoch from (t.clock_out - t.clock_in)) / 3600 - t.break_min / 60.0, 0)::numeric(10,2) as hrs,
         (private.rate_on(t.user_id, t.divisions[1], (t.clock_in at time zone 'America/Chicago')::date)).*
  from time_entries t
  left join worker_pay_profiles p on p.user_id = t.user_id
  where t.tenant_id = private.current_tenant() and t.status in ('approved', 'auto') and t.clock_out is not null and t.pay_batch_id is null
    and (t.clock_in at time zone 'America/Chicago')::date between p_start and p_end and coalesce(p.worker_class, 'w2') = p_class;

  -- hourly, with weekly overtime for W-2
  for r in select user_id, div, rate, sum(hrs) hrs, array_agg(id) ids from _t where kind = 'hourly' group by user_id, div, rate loop
    over := 0;
    if p_class = 'w2' and (ot->>'weekly_over') is not null then
      for wk in select date_trunc('week', day) w, sum(hrs) h from _t where kind = 'hourly' and user_id = r.user_id and div is not distinct from r.div group by 1 loop
        over := over + greatest(wk.h - (ot->>'weekly_over')::numeric, 0);
      end loop;
    end if;
    reg := r.hrs - over;
    insert into pay_lines (batch_id, user_id, division_id, kind, hours, rate, amount, time_entry_ids) values (b, r.user_id, r.div, 'hourly', reg, r.rate, round(reg * r.rate, 2), r.ids);
    if over > 0 then
      insert into pay_lines (batch_id, user_id, division_id, kind, hours, rate, amount, time_entry_ids)
      values (b, r.user_id, r.div, 'overtime', over, round(r.rate * coalesce((ot->>'mult')::numeric, 1.5), 2), round(over * r.rate * coalesce((ot->>'mult')::numeric, 1.5), 2), '{}');
    end if;
  end loop;
  -- daily: one day's pay per day worked, whatever the hours (hours still show on the line)
  for r in select user_id, div, rate, count(distinct day)::int days, sum(hrs) hrs, array_agg(id) ids from _t where kind = 'daily' group by user_id, div, rate loop
    insert into pay_lines (batch_id, user_id, division_id, kind, hours, days, rate, amount, time_entry_ids) values (b, r.user_id, r.div, 'daily', r.hrs, r.days, r.rate, round(r.days * r.rate, 2), r.ids);
  end loop;
  update time_entries set pay_batch_id = b where id in (select id from _t where kind in ('hourly', 'daily'));

  -- per job: approved jobs in the period; the job's own pay amount beats the person's rate
  for r in select j.assigned_to user_id, j.divisions[1] div, count(*)::int n,
                  sum(coalesce(j.pay_amount, (private.rate_on(j.assigned_to, j.divisions[1], (coalesce(j.left_at, j.completed_at) at time zone 'America/Chicago')::date)).rate, 0)) amt,
                  array_agg(j.id) ids
           from jobs j left join worker_pay_profiles p on p.user_id = j.assigned_to
           where j.tenant_id = private.current_tenant() and j.approval in ('approved', 'auto') and j.pay_batch_id is null and j.assigned_to is not null
             and (coalesce(j.left_at, j.completed_at) at time zone 'America/Chicago')::date between p_start and p_end and coalesce(p.worker_class, 'w2') = p_class
             and (j.pay_amount is not null or (private.rate_on(j.assigned_to, j.divisions[1], (coalesce(j.left_at, j.completed_at) at time zone 'America/Chicago')::date)).kind = 'per_job')
           group by 1, 2 loop
    insert into pay_lines (batch_id, user_id, division_id, kind, jobs, rate, amount, job_ids) values (b, r.user_id, r.div, 'per_job', r.n, case when r.n > 0 then round(r.amt / r.n, 2) else 0 end, round(r.amt, 2), r.ids);
    update jobs set pay_batch_id = b where id = any(r.ids);
  end loop;

  update pay_batches set total = coalesce((select sum(amount) from pay_lines where batch_id = b), 0) where id = b;
  return b;
end $$;

create or replace function public.pay_batch_set(p_batch uuid, p_action text, p_template text default null)
returns void language plpgsql security definer set search_path = public, private as $$
declare bt pay_batches;
begin
  if not private.can('pay', 4) then raise exception 'Only someone who manages pay can do that'; end if;
  select * into bt from pay_batches where id = p_batch and tenant_id = private.current_tenant() for update;
  if bt.id is null then raise exception 'Batch not found'; end if;
  if p_action = 'finalize' and bt.status = 'draft' then
    update pay_batches set status = 'final', finalized_by = auth.uid(), finalized_at = now() where id = bt.id;
  elsif p_action = 'reopen' and bt.status = 'final' then
    update pay_batches set status = 'draft', finalized_by = null, finalized_at = null where id = bt.id;
  elsif p_action = 'exported' and bt.status in ('final', 'exported') then
    update pay_batches set status = 'exported', exported_by = auth.uid(), exported_at = now(), export_template = p_template where id = bt.id;
    -- 1099 batches queue as contractor bills when the account's accounting connection is on (the sync sends them)
    if bt.worker_class = '1099' and private.feature_on('accounting') then
      insert into acct_sync_queue (provider, entity_type, entity_id, idempotency_key, amount, payload)
      select c.provider, 'contractor_bill', l.id, 'payline:' || l.id, l.amount,
             jsonb_build_object('user_id', l.user_id, 'division_id', l.division_id, 'kind', l.kind, 'period_end', bt.period_end, 'batch_id', bt.id)
      from pay_lines l cross join acct_connections c
      where l.batch_id = bt.id and l.amount > 0 and c.tenant_id = bt.tenant_id and c.status = 'connected' and coalesce((c.settings->>'push_contractor_bills')::boolean, true)
      on conflict (tenant_id, provider, idempotency_key) do nothing;
    end if;
  elsif p_action = 'delete' and bt.status = 'draft' then
    update time_entries set pay_batch_id = null where pay_batch_id = bt.id;
    update jobs set pay_batch_id = null where pay_batch_id = bt.id;
    delete from pay_batches where id = bt.id;
  else raise exception 'Can''t % a % batch', p_action, bt.status;
  end if;
end $$;

-- the daily check: what synced, what failed, and whether the totals match
create or replace function public.acct_sync_summary(p_days int default 7) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when not private.can('pay', 1) then null else jsonb_build_object(
    'queued', count(*) filter (where status in ('queued', 'sending')),
    'sent', count(*) filter (where status = 'sent'),
    'failed', count(*) filter (where status = 'failed'),
    'queued_total', coalesce(sum(amount) filter (where status in ('queued', 'sending', 'failed')), 0),
    'sent_total', coalesce(sum(amount) filter (where status = 'sent'), 0)) end
  from acct_sync_queue where tenant_id = private.current_tenant() and created_at > now() - make_interval(days => p_days)
$$;

-- a failed item goes back in line (the sync function retries it)
create or replace function public.acct_sync_retry(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.can('pay', 4) then raise exception 'Not allowed'; end if;
  update acct_sync_queue set status = 'queued', last_error = null where id = p_id and tenant_id = private.current_tenant() and status = 'failed';
end $$;

revoke execute on function public.pay_rate_save(uuid, text, numeric, uuid, date, text), public.clock_in(uuid, uuid, double precision, double precision, double precision),
  public.break_toggle(), public.clock_out(double precision, double precision, double precision, text), public.time_fix(uuid, timestamptz, timestamptz, int, text),
  public.pay_batch_build(date, date, text, uuid, uuid), public.pay_batch_set(uuid, text, text), public.acct_sync_summary(int), public.acct_sync_retry(uuid) from public, anon;
grant execute on function public.pay_rate_save(uuid, text, numeric, uuid, date, text), public.clock_in(uuid, uuid, double precision, double precision, double precision),
  public.break_toggle(), public.clock_out(double precision, double precision, double precision, text), public.time_fix(uuid, timestamptz, timestamptz, int, text),
  public.pay_batch_build(date, date, text, uuid, uuid), public.pay_batch_set(uuid, text, text), public.acct_sync_summary(int), public.acct_sync_retry(uuid) to authenticated;

-- job profit for a date range: revenue (approved jobs' price), labor (time on the job at the rate that applied,
-- a daily rate split across that person's entries that day, plus per-job pay) and other costs. One row per job.
create or replace function public.job_profit(p_from date, p_to date)
returns table (job_id uuid, division_id uuid, company_id uuid, worker_id uuid, revenue numeric, labor numeric, other_costs numeric)
language sql stable security definer set search_path = public, private as $$
  with j as (
    select j.* from jobs j
    where j.tenant_id = private.current_tenant() and j.archived_at is null and j.approval in ('approved', 'auto')
      and (coalesce(j.left_at, j.completed_at) at time zone 'America/Chicago')::date between p_from and p_to
      and (private.can('reports', 1) and private.in_scope('reports', coalesce(j.assigned_to, j.created_by), j.divisions))
  ), te as (
    select t.*, (t.clock_in at time zone 'America/Chicago')::date as day,
           greatest(extract(epoch from (t.clock_out - t.clock_in)) / 3600 - t.break_min / 60.0, 0) as hrs
    from time_entries t where t.job_id in (select id from j) and t.clock_out is not null and t.status in ('approved', 'auto')
  ), tl as (
    select te.job_id, sum(case r.kind when 'hourly' then te.hrs * r.rate
                                       when 'daily' then r.rate / greatest((select count(*) from time_entries x where x.user_id = te.user_id and (x.clock_in at time zone 'America/Chicago')::date = te.day and x.clock_out is not null), 1)
                                       else 0 end) as amt
    from te cross join lateral private.rate_on(te.user_id, te.divisions[1], te.day) r group by te.job_id
  )
  select j.id, j.divisions[1], j.company_id, j.assigned_to, coalesce(j.price, 0),
         round(coalesce(tl.amt, 0) + coalesce(j.pay_amount, case when (private.rate_on(j.assigned_to, j.divisions[1], (coalesce(j.left_at, j.completed_at) at time zone 'America/Chicago')::date)).kind = 'per_job'
                                                            then (private.rate_on(j.assigned_to, j.divisions[1], (coalesce(j.left_at, j.completed_at) at time zone 'America/Chicago')::date)).rate end, 0), 2),
         coalesce((select sum(c.amount) from job_costs c where c.job_id = j.id and c.archived_at is null), 0)
  from j left join tl on tl.job_id = j.id
$$;
revoke execute on function public.job_profit(date, date) from public, anon;
grant execute on function public.job_profit(date, date) to authenticated;
