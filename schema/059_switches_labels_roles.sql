-- 059: feature switches, relabeling and roles you build yourself (Oct 29, 2026).
-- Feature switches: each account turns whole features on or off (Settings > Features). Off means the tabs, buttons,
--   widgets and fields for it never show for anyone in that account. Stored in account_settings.settings.features.
-- Relabeling: each account keeps its own word list (Organization, Person, Deal, Job...) in settings.labels, with
--   presets like Clinic and Home Service. Screens read the words from there; the platform default fills any gap.
-- Roles: an account builds its own roles. Every feature area gets on/off, a level (view, edit, approve, manage)
--   and a scope (own records, their division, everything). Ready-made roles come from presets.
--   Nobody can give a role, or a person, more than they have themselves. Admins have everything.
-- MFA: when the account turns on "require two-step sign in", approving, exporting and managing need a session that
--   passed the second step (aal2).

-- the settings the account can save (keeps followup_days as it was and adds the new ones)
create or replace function public.account_settings_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare k text; v jsonb; clean jsonb := '{}'::jsonb; out jsonb;
begin
  if not private.is_admin() then raise exception 'Only an admin can change account settings'; end if;
  for k, v in select * from jsonb_each(coalesce(p, '{}'::jsonb)) loop
    if k = 'followup_days' then
      if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) not between 1 and 8
         or exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'number' or (e::text)::numeric not between 1 and 365 or (e::text)::numeric <> round((e::text)::numeric)) then
        raise exception 'Follow-up buttons need 1 to 8 whole numbers of days between 1 and 365';
      end if;
      clean := clean || jsonb_build_object(k, (select jsonb_agg(d order by d) from (select distinct (e::text)::int d from jsonb_array_elements(v) e) s));
    elsif k = 'features' then
      if jsonb_typeof(v) <> 'object' or exists (select 1 from jsonb_each(v) e where jsonb_typeof(e.value) <> 'boolean') then
        raise exception 'Feature switches are on or off';
      end if;
      clean := clean || jsonb_build_object(k, coalesce((select settings->'features' from account_settings where tenant_id = private.current_tenant()), '{}'::jsonb) || v);
    elsif k = 'labels' then
      if jsonb_typeof(v) <> 'object' or exists (select 1 from jsonb_each(v) e where jsonb_typeof(e.value) <> 'object'
           or length(coalesce(e.value->>'one', '')) not between 1 and 40 or length(coalesce(e.value->>'many', '')) not between 1 and 40) then
        raise exception 'Each label needs a singular and a plural of 1 to 40 characters';
      end if;
      clean := clean || jsonb_build_object(k, v);
    elsif k = 'label_preset' then
      if jsonb_typeof(v) <> 'string' or length(v #>> '{}') > 40 then raise exception 'Unknown label preset'; end if;
      clean := clean || jsonb_build_object(k, v);
    elsif k in ('require_mfa', 'mixed_pay_types') then
      if jsonb_typeof(v) <> 'boolean' then raise exception '% is on or off', k; end if;
      clean := clean || jsonb_build_object(k, v);
    elsif k = 'gps_radius_ft' then
      if jsonb_typeof(v) <> 'number' or (v::text)::numeric not between 50 and 10000 then raise exception 'The check-in distance is 50 to 10,000 feet'; end if;
      clean := clean || jsonb_build_object(k, round((v::text)::numeric));
    elsif k in ('auto_approve', 'dashboard', 'pay_settings') then
      if jsonb_typeof(v) <> 'object' then raise exception '% has the wrong shape', k; end if;
      clean := clean || jsonb_build_object(k, v);
    else raise exception 'Unknown setting %', k;
    end if;
  end loop;
  insert into account_settings (tenant_id, settings, updated_by) values (private.current_tenant(), clean, auth.uid())
  on conflict (tenant_id) do update set settings = account_settings.settings || excluded.settings, updated_at = now(), updated_by = auth.uid()
  returning settings into out;
  return out;
end $$;

-- is a feature switched on for this account (missing = the feature's default)
create or replace function private.feature_on(f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select (settings->'features'->>f)::boolean from account_settings where tenant_id = private.current_tenant()),
                  f not in ('jobs', 'dispatch', 'timeclock', 'pay', 'costs', 'parent_locations', 'location_nesting', 'custom_fields', 'accounting'))
$$;

-- roles
create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  preset_key text,
  perms jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists roles_tenant on public.roles (tenant_id) where archived_at is null;
alter table public.roles enable row level security;
drop policy if exists "read roles" on public.roles;
create policy "read roles" on public.roles for select using (private.is_internal() and tenant_id = private.current_tenant());
revoke all on public.roles from anon, authenticated;
grant select on public.roles to authenticated;   -- writes only through role_save, which checks the no-granting-above-yourself rule
create trigger audit_roles after insert or update on public.roles for each row execute function private.audit();

alter table public.app_users add column if not exists role_id uuid references public.roles(id);

-- feature areas a role can cover, in the order the role screen shows them
create or replace function private.perm_areas() returns text[] language sql immutable as $$
  select array['contacts', 'sales', 'proposals', 'inbox', 'sites', 'jobs', 'dispatch', 'timeclock', 'costs', 'pay', 'review', 'reports', 'settings', 'team']
$$;

-- ready-made roles. level: 0 off, 1 view, 2 edit, 3 approve, 4 manage. scope: own, division, all.
create or replace function public.role_presets() returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'manager', jsonb_build_object('name', 'Manager', 'perms', jsonb_build_object(
      'contacts', '{"level":4,"scope":"all"}'::jsonb, 'sales', '{"level":4,"scope":"all"}'::jsonb, 'proposals', '{"level":3,"scope":"all"}'::jsonb,
      'inbox', '{"level":2,"scope":"all"}'::jsonb, 'sites', '{"level":1,"scope":"all"}'::jsonb, 'jobs', '{"level":4,"scope":"all"}'::jsonb,
      'dispatch', '{"level":4,"scope":"all"}'::jsonb, 'timeclock', '{"level":3,"scope":"all"}'::jsonb, 'costs', '{"level":3,"scope":"all"}'::jsonb,
      'pay', '{"level":1,"scope":"all"}'::jsonb, 'review', '{"level":3,"scope":"all"}'::jsonb, 'reports', '{"level":1,"scope":"all"}'::jsonb,
      'settings', '{"level":0,"scope":"all"}'::jsonb, 'team', '{"level":1,"scope":"all"}'::jsonb)),
    'division_manager', jsonb_build_object('name', 'Division manager', 'perms', jsonb_build_object(
      'contacts', '{"level":2,"scope":"division"}'::jsonb, 'sales', '{"level":2,"scope":"division"}'::jsonb, 'proposals', '{"level":2,"scope":"division"}'::jsonb,
      'inbox', '{"level":2,"scope":"division"}'::jsonb, 'sites', '{"level":0,"scope":"division"}'::jsonb, 'jobs', '{"level":4,"scope":"division"}'::jsonb,
      'dispatch', '{"level":4,"scope":"division"}'::jsonb, 'timeclock', '{"level":3,"scope":"division"}'::jsonb, 'costs', '{"level":3,"scope":"division"}'::jsonb,
      'pay', '{"level":0,"scope":"division"}'::jsonb, 'review', '{"level":3,"scope":"division"}'::jsonb, 'reports', '{"level":1,"scope":"division"}'::jsonb,
      'settings', '{"level":0,"scope":"division"}'::jsonb, 'team', '{"level":1,"scope":"division"}'::jsonb)),
    'sales_rep', jsonb_build_object('name', 'Sales rep', 'perms', jsonb_build_object(
      'contacts', '{"level":2,"scope":"own"}'::jsonb, 'sales', '{"level":2,"scope":"own"}'::jsonb, 'proposals', '{"level":2,"scope":"own"}'::jsonb,
      'inbox', '{"level":2,"scope":"own"}'::jsonb, 'sites', '{"level":0,"scope":"own"}'::jsonb, 'jobs', '{"level":2,"scope":"own"}'::jsonb,
      'dispatch', '{"level":0,"scope":"own"}'::jsonb, 'timeclock', '{"level":2,"scope":"own"}'::jsonb, 'costs', '{"level":0,"scope":"own"}'::jsonb,
      'pay', '{"level":0,"scope":"own"}'::jsonb, 'review', '{"level":0,"scope":"own"}'::jsonb, 'reports', '{"level":1,"scope":"own"}'::jsonb,
      'settings', '{"level":0,"scope":"own"}'::jsonb, 'team', '{"level":0,"scope":"own"}'::jsonb)),
    'field_worker', jsonb_build_object('name', 'Field worker', 'perms', jsonb_build_object(
      'contacts', '{"level":1,"scope":"own"}'::jsonb, 'sales', '{"level":0,"scope":"own"}'::jsonb, 'proposals', '{"level":0,"scope":"own"}'::jsonb,
      'inbox', '{"level":0,"scope":"own"}'::jsonb, 'sites', '{"level":0,"scope":"own"}'::jsonb, 'jobs', '{"level":2,"scope":"own"}'::jsonb,
      'dispatch', '{"level":0,"scope":"own"}'::jsonb, 'timeclock', '{"level":2,"scope":"own"}'::jsonb, 'costs', '{"level":2,"scope":"own"}'::jsonb,
      'pay', '{"level":1,"scope":"own"}'::jsonb, 'review', '{"level":0,"scope":"own"}'::jsonb, 'reports', '{"level":0,"scope":"own"}'::jsonb,
      'settings', '{"level":0,"scope":"own"}'::jsonb, 'team', '{"level":0,"scope":"own"}'::jsonb)),
    'accounting', jsonb_build_object('name', 'Accounting', 'perms', jsonb_build_object(
      'contacts', '{"level":1,"scope":"all"}'::jsonb, 'sales', '{"level":1,"scope":"all"}'::jsonb, 'proposals', '{"level":1,"scope":"all"}'::jsonb,
      'inbox', '{"level":0,"scope":"all"}'::jsonb, 'sites', '{"level":0,"scope":"all"}'::jsonb, 'jobs', '{"level":1,"scope":"all"}'::jsonb,
      'dispatch', '{"level":0,"scope":"all"}'::jsonb, 'timeclock', '{"level":1,"scope":"all"}'::jsonb, 'costs', '{"level":3,"scope":"all"}'::jsonb,
      'pay', '{"level":4,"scope":"all"}'::jsonb, 'review', '{"level":1,"scope":"all"}'::jsonb, 'reports', '{"level":1,"scope":"all"}'::jsonb,
      'settings', '{"level":0,"scope":"all"}'::jsonb, 'team', '{"level":0,"scope":"all"}'::jsonb)))
$$;

-- what the signed-in person can do in one area: {level, scope}
-- admins: everything. A person with a role: that role. Nobody on a role yet: the Manager preset, which covers
-- everything a team member could already do (and keeps pay and settings with admins), so nobody loses access.
create or replace function private.perm(area text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case
    when u.id is null or not u.active or u.role in ('vendor', 'member') then '{"level":0,"scope":"own"}'::jsonb
    when u.is_admin then '{"level":4,"scope":"all"}'::jsonb
    when r.id is not null then coalesce(r.perms->area, '{"level":0,"scope":"own"}'::jsonb)
    else coalesce(public.role_presets()->'manager'->'perms'->area, '{"level":0,"scope":"own"}'::jsonb)
  end
  from (select auth.uid() as uid) x
  left join app_users u on u.id = x.uid
  left join roles r on r.id = u.role_id and r.archived_at is null and r.tenant_id = u.tenant_id
$$;

-- may the signed-in person do this (level 1 view, 2 edit, 3 approve, 4 manage).
-- approve and manage need the second sign-in step when the account requires it.
create or replace function private.can(area text, lvl int) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((private.perm(area)->>'level')::int, 0) >= lvl
     and (lvl < 3 or coalesce((select (settings->>'require_mfa')::boolean from account_settings where tenant_id = private.current_tenant()), false) = false
          or coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2')
$$;

-- can the signed-in person see a row with this owner and these divisions in this area
create or replace function private.in_scope(area text, owner uuid, divs uuid[]) returns boolean
language sql stable security definer set search_path = public, private as $$
  select case coalesce(private.perm(area)->>'scope', 'own')
    when 'all' then true
    when 'division' then owner = auth.uid() or private.div_ok(divs)
    else owner = auth.uid() end
$$;
revoke execute on function private.perm(text), private.can(text, int), private.in_scope(text, uuid, uuid[]), private.feature_on(text) from public, anon;
grant execute on function private.perm(text), private.can(text, int), private.in_scope(text, uuid, uuid[]), private.feature_on(text) to authenticated;
grant execute on function public.role_presets() to authenticated;

-- every area's {level, scope} for the signed-in person, for the app to hide what they can't use
create or replace function public.my_perms() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_object_agg(a, private.perm(a)) || jsonb_build_object('_aal', coalesce(auth.jwt()->>'aal', 'aal1'))
  from unnest(private.perm_areas()) a
$$;
revoke execute on function public.my_perms() from public, anon;
grant execute on function public.my_perms() to authenticated;

-- is perms a within what the signed-in person has (level not higher, scope not wider)
create or replace function private.within_mine(p jsonb) returns boolean
language plpgsql stable security definer set search_path = public, private as $$
declare a text; want jsonb; mine jsonb; rank jsonb := '{"own":1,"division":2,"all":3}'::jsonb;
begin
  for a in select unnest(private.perm_areas()) loop
    want := coalesce(p->a, '{"level":0,"scope":"own"}'::jsonb); mine := private.perm(a);
    if coalesce((want->>'level')::int, 0) > coalesce((mine->>'level')::int, 0) then return false; end if;
    if coalesce((want->>'level')::int, 0) > 0 and coalesce((rank->>(want->>'scope'))::int, 3) > coalesce((rank->>(mine->>'scope'))::int, 1) then return false; end if;
  end loop;
  return true;
end $$;

-- create or change a role. Only people who can manage the team can; nobody can build a role above themselves.
create or replace function public.role_save(p_id uuid, p_name text, p_perms jsonb, p_preset text default null)
returns uuid language plpgsql security definer set search_path = public, private as $$
declare a text; clean jsonb := '{}'::jsonb; v jsonb; out uuid;
begin
  if not private.can('team', 4) then raise exception 'Only someone who can manage the team can change roles'; end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 60 then raise exception 'Give the role a name (up to 60 characters)'; end if;
  for a in select unnest(private.perm_areas()) loop
    v := coalesce(p_perms->a, '{}'::jsonb);
    clean := clean || jsonb_build_object(a, jsonb_build_object(
      'level', greatest(0, least(4, coalesce((v->>'level')::int, 0))),
      'scope', case when v->>'scope' in ('own', 'division', 'all') then v->>'scope' else 'own' end));
  end loop;
  if not private.within_mine(clean) then raise exception 'You can''t give a role more access than you have yourself'; end if;
  if p_id is null then
    insert into roles (name, perms, preset_key) values (trim(p_name), clean, p_preset) returning id into out;
  else
    -- changing a role also changes everyone on it, so the editor must be able to give everything it held before too
    if not private.within_mine((select perms from roles where id = p_id and tenant_id = private.current_tenant())) then
      raise exception 'That role has more access than you do, so you can''t change it';
    end if;
    update roles set name = trim(p_name), perms = clean, updated_at = now() where id = p_id and tenant_id = private.current_tenant() and archived_at is null returning id into out;
    if out is null then raise exception 'Role not found'; end if;
  end if;
  return out;
end $$;

create or replace function public.role_archive(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.can('team', 4) then raise exception 'Only someone who can manage the team can remove roles'; end if;
  if not private.within_mine((select perms from roles where id = p_id and tenant_id = private.current_tenant())) then raise exception 'That role has more access than you do'; end if;
  if exists (select 1 from app_users where role_id = p_id and active) then raise exception 'Move everyone off this role first'; end if;
  update roles set archived_at = now() where id = p_id and tenant_id = private.current_tenant();
end $$;

-- put a person on a role (null = back to the default for their account type)
create or replace function public.user_role_set(p_user uuid, p_role uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.can('team', 4) then raise exception 'Only someone who can manage the team can change roles'; end if;
  if p_user = auth.uid() then raise exception 'You can''t change your own role'; end if;
  if not exists (select 1 from app_users where id = p_user and tenant_id = private.current_tenant()) then raise exception 'Person not found'; end if;
  if (select is_admin from app_users where id = p_user) and not private.is_admin() then raise exception 'Only an admin can change an admin'; end if;
  if p_role is not null and not exists (select 1 from roles where id = p_role and tenant_id = private.current_tenant() and archived_at is null) then raise exception 'Role not found'; end if;
  if p_role is not null and not private.within_mine((select perms from roles where id = p_role)) then raise exception 'You can''t give someone more access than you have yourself'; end if;
  update app_users set role_id = p_role where id = p_user;
end $$;
revoke execute on function public.role_save(uuid, text, jsonb, text), public.role_archive(uuid), public.user_role_set(uuid, uuid) from public, anon;
grant execute on function public.role_save(uuid, text, jsonb, text), public.role_archive(uuid), public.user_role_set(uuid, uuid) to authenticated;
