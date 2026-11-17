-- 091: packages, account plans and CRM client billing (Chris by voice, Nov 10, 2026). See BACKLOG.md.
--  packages        each agency's bundles of features, with a price
--  account_plans   one per client account: what it's allowed (a package, a package with changes, or picked one by one),
--                  the agency organization it bills through, and how billing works (invoice series, handled, off)
-- A client can switch its allowed features on and off; anything outside its plan is off everywhere (feature_on) and
-- can't be switched on (account_settings_save). Accounts with no plan row keep every feature, like before.

create or replace function private.feature_keys() returns text[] language sql immutable as $$
  select array['sales','inbox','sites','custom_fields','parent_locations','location_nesting','jobs','dispatch','costs','timeclock','pay',
               'accounting','measure','bids','portal','esign','calendars','social']
$$;

create table if not exists public.packages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,   -- the agency
  name text not null check (length(trim(name)) between 1 and 60),
  description text,
  features text[] not null default '{}',
  price numeric check (price is null or price >= 0),
  price_per text not null default 'account' check (price_per in ('account', 'user')),
  sort int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists packages_tenant_idx on public.packages (tenant_id);
alter table public.packages enable row level security;
drop policy if exists "agency reads its packages" on public.packages;
create policy "agency reads its packages" on public.packages for select using (private.manages(tenant_id));
grant select on public.packages to authenticated;

create table if not exists public.account_plans (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,      -- the client account
  agency_tenant_id uuid not null references public.tenants(id),
  package_id uuid references public.packages(id) on delete set null,
  allowed text[] not null default '{}',
  company_id uuid references public.companies(id) on delete set null,             -- the organization in the agency's CRM
  billing_mode text not null default 'off' check (billing_mode in ('off', 'invoice', 'bypass')),
  billing_schedule_id uuid references public.invoice_schedules(id) on delete set null,
  trial_ends date,
  grace_days int not null default 7 check (grace_days between 0 and 90),
  billing_contact uuid references public.app_users(id) on delete set null,
  price numeric check (price is null or price >= 0),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create index if not exists account_plans_company_idx on public.account_plans (company_id);
alter table public.account_plans enable row level security;
drop policy if exists "agency reads client plans" on public.account_plans;
create policy "agency reads client plans" on public.account_plans for select using (private.manages(tenant_id) and tenant_id <> private.current_tenant());
grant select on public.account_plans to authenticated;

-- is feature f inside this account's plan (no plan = everything)
create or replace function private.plan_allows(t uuid, f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select f = any(p.allowed) from account_plans p where p.tenant_id = t), true)
$$;

create or replace function private.feature_on(f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.plan_allows(private.current_tenant(), f) and coalesce((select (settings->'features'->>f)::boolean from account_settings where tenant_id = private.current_tenant()),
                  f not in ('jobs', 'dispatch', 'timeclock', 'pay', 'costs', 'parent_locations', 'location_nesting', 'custom_fields', 'accounting', 'measure', 'bids', 'portal', 'esign', 'calendars'))
$$;
create or replace function private.feature_on_for(t uuid, f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.plan_allows(t, f) and coalesce((select (settings->'features'->>f)::boolean from account_settings where tenant_id = t),
                  f not in ('jobs', 'dispatch', 'timeclock', 'pay', 'costs', 'parent_locations', 'location_nesting', 'custom_fields', 'accounting', 'measure', 'bids', 'portal', 'esign', 'calendars'))
$$;

-- a client's admin can't switch on what isn't in the plan
do $$
declare d text; b text;
begin
  if to_regprocedure('public.account_settings_save(jsonb)') is null then return; end if;
  d := pg_get_functiondef('public.account_settings_save(jsonb)'::regprocedure); b := d;
  if position('plan_allows' in d) > 0 then return; end if;
  d := replace(d, $q$        raise exception 'Feature switches are on or off';
      end if;$q$, $q$        raise exception 'Feature switches are on or off';
      end if;
      if exists (select 1 from jsonb_each(v) e where e.value = 'true'::jsonb and not private.plan_allows(private.current_tenant(), e.key)) then
        raise exception 'That feature isn''t in your plan. Ask % to add it.', coalesce((select a.name from account_plans p join tenants a on a.id = p.agency_tenant_id where p.tenant_id = private.current_tenant()), 'your provider');
      end if;$q$);
  if d = b then raise exception 'account_settings_save did not match; nothing changed'; end if;
  execute d;
end $$;

/* ---------- packages ---------- */
create or replace function public.package_save(p jsonb) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare ag uuid := coalesce(nullif(p->>'agency', '')::uuid, private.current_tenant()); pid uuid := nullif(p->>'id', '')::uuid;
        feats text[] := coalesce((select array_agg(distinct x) from jsonb_array_elements_text(coalesce(p->'features', '[]'::jsonb)) x), '{}');
begin
  if not (private.manages(ag) and exists (select 1 from tenants where id = ag and is_agency)) then raise exception 'Only an agency admin can set up packages'; end if;
  if length(trim(coalesce(p->>'name', ''))) not between 1 and 60 then raise exception 'Name the package'; end if;
  if not feats <@ private.feature_keys() then raise exception 'Unknown feature in the package'; end if;
  if pid is null then
    insert into packages (tenant_id, name, description, features, price, price_per, sort)
    values (ag, trim(p->>'name'), nullif(trim(p->>'description'), ''), feats, nullif(p->>'price', '')::numeric, coalesce(nullif(p->>'price_per', ''), 'account'),
            coalesce((select max(sort) + 1 from packages where tenant_id = ag), 1))
    returning id into pid;
  else
    update packages set name = trim(p->>'name'), description = nullif(trim(p->>'description'), ''), features = feats,
           price = nullif(p->>'price', '')::numeric, price_per = coalesce(nullif(p->>'price_per', ''), 'account'), updated_at = now()
     where id = pid and tenant_id = ag;
    if not found then raise exception 'Package not found'; end if;
  end if;
  return pid;
end $$;

create or replace function public.package_archive(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  update packages set archived_at = now() where id = p_id and private.manages(tenant_id);
  if not found then raise exception 'Package not found'; end if;
end $$;

/* ---------- account plans ---------- */
-- agency side: set a client's plan. p: package_id, allowed[], company_id, billing_mode, billing_schedule_id, trial_ends, grace_days,
-- billing_contact, price, notes. Keys left out stay as they are. Newly allowed features are switched on for the client;
-- features taken away are switched off.
create or replace function public.account_plan_save(p_tenant uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare ag uuid; cur account_plans; old_allowed text[]; new_allowed text[]; feats jsonb; k text; was_new boolean;
begin
  if not private.manages(p_tenant) or p_tenant = private.current_tenant() then raise exception 'Only the agency can change this account''s plan'; end if;
  select agency_tenant_id into ag from tenants where id = p_tenant and not is_agency;
  if ag is null then raise exception 'Plans are for client accounts'; end if;
  select * into cur from account_plans where tenant_id = p_tenant;
  was_new := cur.tenant_id is null;
  old_allowed := case when was_new then null else cur.allowed end;
  new_allowed := case when p ? 'allowed' then coalesce((select array_agg(distinct x) from jsonb_array_elements_text(p->'allowed') x), '{}') else coalesce(cur.allowed, '{}') end;
  if not new_allowed <@ private.feature_keys() then raise exception 'Unknown feature'; end if;
  if p ? 'package_id' and nullif(p->>'package_id', '') is not null
     and not exists (select 1 from packages where id = (p->>'package_id')::uuid and tenant_id = ag and archived_at is null) then raise exception 'Pick one of your packages'; end if;
  if p ? 'company_id' and nullif(p->>'company_id', '') is not null
     and not exists (select 1 from companies where id = (p->>'company_id')::uuid and tenant_id = ag) then raise exception 'That organization isn''t in your CRM'; end if;
  if p ? 'billing_schedule_id' and nullif(p->>'billing_schedule_id', '') is not null
     and not exists (select 1 from invoice_schedules where id = (p->>'billing_schedule_id')::uuid and tenant_id = ag) then raise exception 'That repeating invoice isn''t in your CRM'; end if;
  if p ? 'billing_contact' and nullif(p->>'billing_contact', '') is not null
     and not exists (select 1 from app_users where id = (p->>'billing_contact')::uuid and tenant_id = p_tenant and active) then raise exception 'Pick someone on their team'; end if;
  insert into account_plans as a (tenant_id, agency_tenant_id, package_id, allowed, company_id, billing_mode, billing_schedule_id, trial_ends, grace_days, billing_contact, price, notes, updated_by)
  values (p_tenant, ag,
    nullif(p->>'package_id', '')::uuid, new_allowed, nullif(p->>'company_id', '')::uuid, coalesce(nullif(p->>'billing_mode', ''), 'off'),
    nullif(p->>'billing_schedule_id', '')::uuid, nullif(p->>'trial_ends', '')::date, coalesce(nullif(p->>'grace_days', '')::int, 7),
    nullif(p->>'billing_contact', '')::uuid, nullif(p->>'price', '')::numeric, nullif(trim(p->>'notes'), ''), auth.uid())
  on conflict (tenant_id) do update set
    package_id = case when p ? 'package_id' then nullif(p->>'package_id', '')::uuid else a.package_id end,
    allowed = new_allowed,
    company_id = case when p ? 'company_id' then nullif(p->>'company_id', '')::uuid else a.company_id end,
    billing_mode = case when p ? 'billing_mode' then coalesce(nullif(p->>'billing_mode', ''), 'off') else a.billing_mode end,
    billing_schedule_id = case when p ? 'billing_schedule_id' then nullif(p->>'billing_schedule_id', '')::uuid else a.billing_schedule_id end,
    trial_ends = case when p ? 'trial_ends' then nullif(p->>'trial_ends', '')::date else a.trial_ends end,
    grace_days = case when p ? 'grace_days' then coalesce(nullif(p->>'grace_days', '')::int, 7) else a.grace_days end,
    billing_contact = case when p ? 'billing_contact' then nullif(p->>'billing_contact', '')::uuid else a.billing_contact end,
    price = case when p ? 'price' then nullif(p->>'price', '')::numeric else a.price end,
    notes = case when p ? 'notes' then nullif(trim(p->>'notes'), '') else a.notes end,
    updated_at = now(), updated_by = auth.uid();
  -- switch the client's features to match: new ones on, removed ones off (a brand new plan sets every switch)
  feats := '{}'::jsonb;
  foreach k in array private.feature_keys() loop
    if k = any(new_allowed) and (was_new or not (k = any(old_allowed))) then feats := feats || jsonb_build_object(k, true);
    elsif not (k = any(new_allowed)) then feats := feats || jsonb_build_object(k, false);
    end if;
  end loop;
  insert into account_settings (tenant_id, settings, updated_by) values (p_tenant, jsonb_build_object('features', feats), auth.uid())
  on conflict (tenant_id) do update set settings = account_settings.settings || jsonb_build_object('features', coalesce(account_settings.settings->'features', '{}'::jsonb) || feats),
    updated_at = now(), updated_by = auth.uid();
  -- the organization gets the CRM client type so it's easy to find
  update companies set org_types = array_append(org_types, 'CRM client')
   where id = (select company_id from account_plans where tenant_id = p_tenant) and not ('CRM client' = any(org_types));
  return to_jsonb((select x from account_plans x where x.tenant_id = p_tenant));
end $$;

/* ---------- billing state ---------- */
-- ok | trial | setup (never paid: blocked) | grace (late, still open) | locked (late past the grace days)
create or replace function private.billing_state(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare pl account_plans; tmpl uuid; paid_any boolean; oldest date; late int; open_inv jsonb; st text; ag_name text;
begin
  select * into pl from account_plans where tenant_id = p_tenant;
  if pl.tenant_id is null or pl.billing_mode = 'off' then return jsonb_build_object('state', 'ok', 'mode', coalesce(pl.billing_mode, 'none')); end if;
  select name into ag_name from tenants where id = pl.agency_tenant_id;
  if pl.billing_mode = 'bypass' then return jsonb_build_object('state', 'ok', 'mode', 'bypass', 'agency', ag_name); end if;
  if pl.billing_schedule_id is null then return jsonb_build_object('state', 'ok', 'mode', 'unlinked', 'agency', ag_name); end if;
  select template_invoice_id into tmpl from invoice_schedules where id = pl.billing_schedule_id;
  select bool_or(i.paid_at is not null or coalesce(i.paid_total, 0) > 0),
         min(coalesce(i.due_date, i.issue_date)) filter (where coalesce(i.balance, 0) > 0),
         coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'number', i.number, 'balance', i.balance, 'due_date', coalesce(i.due_date, i.issue_date), 'token', i.share_token)
                  order by coalesce(i.due_date, i.issue_date)) filter (where coalesce(i.balance, 0) > 0), '[]'::jsonb)
    into paid_any, oldest, open_inv
    from invoices i
   where i.tenant_id = pl.agency_tenant_id and (i.schedule_id = pl.billing_schedule_id or i.id = tmpl)
     and i.status <> 'draft' and i.voided_at is null;
  late := case when oldest is null then 0 else current_date - oldest end;
  st := case
    when pl.trial_ends is not null and pl.trial_ends >= current_date then 'trial'
    when oldest is null then 'ok'
    when not coalesce(paid_any, false) then 'setup'
    when late <= 0 then 'ok'
    when late <= pl.grace_days then 'grace'
    else 'locked' end;
  return jsonb_build_object('state', st, 'mode', 'invoice', 'agency', ag_name, 'days_late', greatest(late, 0),
    'grace_left', greatest(pl.grace_days - late, 0), 'trial_ends', pl.trial_ends, 'open', open_inv, 'paid_any', coalesce(paid_any, false));
end $$;
revoke execute on function private.billing_state(uuid) from public, anon, authenticated;

-- is the signed-in person one of this account's billing people (the billing contact, or every admin when none is set)
create or replace function private.is_billing_person() returns boolean
language sql stable security definer set search_path = public, private as $$
  select case when (select billing_contact from account_plans where tenant_id = private.current_tenant()) is not null
              then (select billing_contact from account_plans where tenant_id = private.current_tenant()) = auth.uid()
              else private.is_admin() end
$$;

-- client side, on every load: what the plan allows and where billing stands. Staff only hear about a lock.
create or replace function public.my_plan() returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); pl account_plans; b jsonb; bp boolean; who text;
begin
  if not private.is_internal() then return null; end if;
  select * into pl from account_plans where tenant_id = t;
  if pl.tenant_id is null then return jsonb_build_object('allowed', null, 'billing', jsonb_build_object('state', 'ok')); end if;
  -- agency people working inside a client account aren't blocked
  if private.manages(t) and private.home_tenant() <> t then
    return jsonb_build_object('allowed', to_jsonb(pl.allowed), 'billing', jsonb_build_object('state', 'ok'), 'agency_view', true);
  end if;
  b := private.billing_state(t); bp := private.is_billing_person();
  select coalesce(u.full_name, u.email) into who from app_users u where u.id = pl.billing_contact;
  if not bp then
    b := jsonb_build_object('state', case when b->>'state' in ('locked', 'setup') then 'locked' else 'ok' end, 'agency', b->'agency');
  end if;
  return jsonb_build_object('allowed', to_jsonb(pl.allowed), 'billing', b, 'billing_person', bp, 'billing_contact', who);
end $$;

-- the client's admin can name their own billing contact
create or replace function public.billing_contact_set(p_user uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_admin() then raise exception 'Only an admin can pick the billing contact'; end if;
  if p_user is not null and not exists (select 1 from app_users where id = p_user and tenant_id = private.current_tenant() and active) then raise exception 'Pick someone on your team'; end if;
  update account_plans set billing_contact = p_user, updated_at = now(), updated_by = auth.uid() where tenant_id = private.current_tenant();
end $$;

-- agency side: every client plan it manages, with the package and where billing stands
create or replace function public.account_plans_list() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('tenant_id', a.tenant_id, 'package_id', a.package_id, 'package', k.name, 'package_features', to_jsonb(k.features),
           'allowed', to_jsonb(a.allowed), 'company_id', a.company_id, 'billing_mode', a.billing_mode, 'billing_schedule_id', a.billing_schedule_id,
           'trial_ends', a.trial_ends, 'grace_days', a.grace_days, 'billing_contact', a.billing_contact, 'price', a.price, 'notes', a.notes,
           'billing', private.billing_state(a.tenant_id))), '[]'::jsonb)
    from account_plans a left join packages k on k.id = a.package_id
   where private.manages(a.tenant_id) and a.tenant_id <> private.current_tenant()
$$;

/* ---------- export ---------- */
-- everything the account owns, as one JSON download (the client's data is theirs). Billing people and admins.
create or replace function public.account_export() returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); tbl text; out jsonb := '{}'::jsonb; rows jsonb;
begin
  if not (private.is_billing_person() or private.is_admin()) then raise exception 'Only the account''s billing contact or an admin can export'; end if;
  foreach tbl in array array['companies','people','company_people','activities','contact_events','opportunities','proposals','invoices','invoice_schedules',
    'products','jobs','job_schedules','bids','tasks','appointments','escalations','lookup_values','pipelines','pipeline_stages','form_submissions','time_entries'] loop
    if to_regclass('public.' || tbl) is not null and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = tbl and column_name = 'tenant_id') then
      execute format('select coalesce(jsonb_agg(to_jsonb(x) - ''tenant_id''), ''[]''::jsonb) from (select * from public.%I where tenant_id = $1 limit 50000) x', tbl) into rows using t;
      out := out || jsonb_build_object(tbl, rows);
    end if;
  end loop;
  return jsonb_build_object('account', (select name from tenants where id = t), 'exported_at', now(), 'tables', out);
end $$;

revoke execute on function public.package_save(jsonb), public.package_archive(uuid), public.account_plan_save(uuid, jsonb), public.my_plan(),
  public.billing_contact_set(uuid), public.account_plans_list(), public.account_export() from public, anon;
grant execute on function public.package_save(jsonb), public.package_archive(uuid), public.account_plan_save(uuid, jsonb), public.my_plan(),
  public.billing_contact_set(uuid), public.account_plans_list(), public.account_export() to authenticated;
