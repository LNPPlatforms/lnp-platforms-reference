-- 057: platform admin above GELP, and white labels (Oct 26, 2026).
-- Before: GELP's admins were the CRM's admins. Now:
--   * Platform owner (Chris only, listed in private.platform_owners): sees and manages every account and every white label.
--   * Agencies: an account marked is_agency (GELP is one) runs a white label. Its admins manage only the accounts under
--     it (tenants.agency_tenant_id = that agency): create them, switch into them, turn on features. This is what GELP's
--     admins already do, so nothing changes for David and Julie inside GELP's accounts.
--   * White labels: one brand per agency (name, logo, colors, domain, email sender) on the same CRM. Accounts under an
--     agency see its brand. The platform owner creates and rebrands them.

create table if not exists private.platform_owners (user_id uuid primary key references public.app_users(id) on delete cascade, added_at timestamptz not null default now());
insert into private.platform_owners (user_id) select id from public.app_users where lower(email) = 'chris@gelpstrategies.com' on conflict do nothing;

alter table public.tenants add column if not exists is_agency boolean not null default false;
update public.tenants set is_agency = true where id = private.default_tenant();

create table if not exists public.white_labels (
  id uuid primary key default gen_random_uuid(),
  agency_tenant_id uuid not null unique references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 60),
  short_name text,
  logo_url text,
  primary_color text not null default '#1A2A52',
  accent_color text not null default '#C9A04A',
  domain text unique,
  email_from_name text,
  support_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.white_labels enable row level security;

create or replace function private.home_tenant() returns uuid
language sql stable security definer set search_path = public, private as $$
  select tenant_id from app_users where id = auth.uid()
$$;
create or replace function private.is_platform_owner() returns boolean
language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from private.platform_owners o join app_users u on u.id = o.user_id where o.user_id = auth.uid() and u.active)
$$;
-- an admin of an agency account (or the platform owner). Same name as before so older checks keep working.
create or replace function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_platform_owner() or coalesce((select u.is_admin and t.is_agency from app_users u join tenants t on t.id = u.tenant_id
    where u.id = auth.uid() and u.active and u.role not in ('vendor', 'member')), false)
$$;
-- can the signed-in person manage this account: the platform owner always; an agency admin for their agency and the accounts under it
create or replace function private.manages(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_platform_owner() or (private.is_platform_admin() and (p_tenant = private.home_tenant()
    or exists (select 1 from tenants where id = p_tenant and agency_tenant_id = private.home_tenant())))
$$;

-- switching accounts follows the same rule
create or replace function private.current_tenant() returns uuid
language sql stable security definer set search_path = public, private as $$
  select coalesce((select case when u.acting_tenant_id is not null and u.is_admin and u.active and (
                                 exists (select 1 from private.platform_owners o where o.user_id = u.id)
                                 or (exists (select 1 from tenants h where h.id = u.tenant_id and h.is_agency)
                                     and exists (select 1 from tenants a where a.id = u.acting_tenant_id and a.agency_tenant_id = u.tenant_id)))
                               then u.acting_tenant_id else u.tenant_id end
                     from app_users u where u.id = private.actor()), private.default_tenant())
$$;

create or replace function public.set_acting_tenant(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_platform_admin() then raise exception 'Only agency admins can switch accounts'; end if;
  if p_tenant is not null and not exists (select 1 from tenants where id = p_tenant) then raise exception 'Account not found'; end if;
  if p_tenant is not null and not private.manages(p_tenant) then raise exception 'That account is not one of yours'; end if;
  update app_users set acting_tenant_id = nullif(p_tenant, tenant_id) where id = auth.uid();
  return jsonb_build_object('ok', true, 'tenant', private.current_tenant());
end $$;

-- the brand an account shows: its own if it is an agency, otherwise its agency's
create or replace function private.brand_of(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select to_jsonb(w) - 'created_at' - 'updated_at' from white_labels w
   where w.agency_tenant_id = (select case when t.is_agency then t.id else t.agency_tenant_id end from tenants t where t.id = p_tenant)
$$;

create or replace function public.current_account() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'home', private.home_tenant(),
    'platform_admin', private.is_platform_admin(), 'platform_owner', private.is_platform_owner(),
    'is_gelp', t.id = private.default_tenant(), 'plan', t.plan, 'is_agency', t.is_agency,
    'home_agency', (select h.name from tenants h where h.id = private.home_tenant()),
    'brand', private.brand_of(t.id))
  from tenants t where t.id = private.current_tenant()
$$;

-- new accounts land under the agency of whoever creates them (the platform owner can pick the agency)
create or replace function public.create_account(p_name text, p_slug text, p_owner_email text, p_owner_name text, p_agency uuid default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare tid uuid; ag uuid; v_slug text := lower(regexp_replace(coalesce(nullif(trim(p_slug), ''), p_name), '[^a-zA-Z0-9]+', '-', 'g'));
begin
  if not private.is_platform_admin() then raise exception 'Only agency admins can create accounts'; end if;
  ag := case when private.is_platform_owner() and p_agency is not null then p_agency else private.home_tenant() end;
  if not exists (select 1 from tenants where id = ag and is_agency) then raise exception 'Pick an agency for this account'; end if;
  if length(coalesce(trim(p_name), '')) < 2 then raise exception 'Name the account'; end if;
  v_slug := trim(both '-' from v_slug);
  if exists (select 1 from tenants where slug = v_slug) then raise exception 'That short name is taken'; end if;
  insert into tenants (name, slug, agency_tenant_id) values (trim(p_name), v_slug, ag) returning id into tid;
  if coalesce(trim(p_owner_email), '') ~ '^\S+@\S+\.\S+$' then
    insert into invites (tenant_id, email, full_name, role, is_admin, invited_by)
    values (tid, lower(trim(p_owner_email)), nullif(trim(p_owner_name), ''), 'staff', true, auth.uid());
  end if;
  return jsonb_build_object('ok', true, 'id', tid, 'slug', v_slug);
end $$;
drop function if exists public.create_account(text, text, text, text);

-- platform owner: every account with its agency, plan and size
create or replace function public.platform_accounts() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when not private.is_platform_owner() then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'plan', t.plan, 'is_agency', t.is_agency,
      'agency_id', t.agency_tenant_id, 'agency', a.name, 'created_at', t.created_at,
      'users', (select count(*) from app_users u where u.tenant_id = t.id and u.role not in ('vendor', 'member')),
      'orgs', (select count(*) from companies c where c.tenant_id = t.id and c.archived_at is null)) order by t.is_agency desc, t.name)
    from tenants t left join tenants a on a.id = t.agency_tenant_id), '[]'::jsonb) end
$$;

-- platform owner: make an account an agency (white label) or move an account under an agency
create or replace function public.platform_set_account(p_tenant uuid, p_agency uuid, p_is_agency boolean) returns jsonb
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_platform_owner() then raise exception 'Only the platform admin can do that'; end if;
  if p_tenant = private.default_tenant() and not coalesce(p_is_agency, true) then raise exception 'GELP stays an agency'; end if;
  if p_agency is not null and not exists (select 1 from tenants where id = p_agency and is_agency) then raise exception 'That account is not an agency'; end if;
  if p_agency = p_tenant then raise exception 'An account cannot sit under itself'; end if;
  update tenants set agency_tenant_id = coalesce(p_agency, agency_tenant_id), is_agency = coalesce(p_is_agency, is_agency) where id = p_tenant;
  return jsonb_build_object('ok', true);
end $$;

-- platform owner: create or rebrand the white label for an agency
create or replace function public.platform_save_white_label(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare w white_labels; ag uuid := (p->>'agency_tenant_id')::uuid; dom text := nullif(lower(trim(coalesce(p->>'domain', ''))), '');
begin
  if not private.is_platform_owner() then raise exception 'Only the platform admin can change white labels'; end if;
  if not exists (select 1 from tenants where id = ag) then raise exception 'Pick the agency account'; end if;
  if dom is not null and dom !~ '^[a-z0-9.-]+\.[a-z]{2,}$' then raise exception 'Domain looks wrong, use something like app.example.com'; end if;
  update tenants set is_agency = true where id = ag;
  insert into white_labels (agency_tenant_id, name, short_name, logo_url, primary_color, accent_color, domain, email_from_name, support_email)
  values (ag, trim(p->>'name'), nullif(trim(coalesce(p->>'short_name', '')), ''), nullif(trim(coalesce(p->>'logo_url', '')), ''),
          coalesce(nullif(p->>'primary_color', ''), '#1A2A52'), coalesce(nullif(p->>'accent_color', ''), '#C9A04A'), dom,
          nullif(trim(coalesce(p->>'email_from_name', '')), ''), nullif(trim(coalesce(p->>'support_email', '')), ''))
  on conflict (agency_tenant_id) do update set name = excluded.name, short_name = excluded.short_name, logo_url = excluded.logo_url,
    primary_color = excluded.primary_color, accent_color = excluded.accent_color, domain = excluded.domain,
    email_from_name = excluded.email_from_name, support_email = excluded.support_email, updated_at = now()
  returning * into w;
  return to_jsonb(w);
end $$;

-- before anyone signs in: the brand for the web address they opened (domain only, nothing private)
create or replace function public.brand_for_host(p_host text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('name', name, 'short_name', short_name, 'logo_url', logo_url, 'primary_color', primary_color, 'accent_color', accent_color)
    from white_labels where domain = lower(trim(p_host))
$$;

-- white labels are read through the functions above; agency admins can read their own row
drop policy if exists "read own white label" on public.white_labels;
create policy "read own white label" on public.white_labels for select using (private.manages(agency_tenant_id));
grant select on public.white_labels to authenticated;

-- account list: agency admins see their own accounts, the platform owner sees all
alter policy "platform admins read accounts" on public.tenants using (private.manages(id));
alter policy "platform admins assign accounts" on public.tenants using (private.manages(id)) with check (private.manages(id));
-- only the platform owner moves accounts between agencies or makes agencies
create or replace function private.guard_tenant_agency() returns trigger
language plpgsql set search_path = public, private as $$
begin
  if (new.agency_tenant_id is distinct from old.agency_tenant_id or new.is_agency is distinct from old.is_agency) and not private.is_platform_owner()
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception 'Only the platform admin can change which agency an account belongs to';
  end if;
  return new;
end $$;
drop trigger if exists guard_tenant_agency on public.tenants;
create trigger guard_tenant_agency before update on public.tenants for each row execute function private.guard_tenant_agency();

revoke execute on function private.home_tenant(), private.is_platform_owner(), private.manages(uuid), private.brand_of(uuid) from public, anon;
grant execute on function private.home_tenant(), private.is_platform_owner(), private.manages(uuid), private.brand_of(uuid) to authenticated;
revoke execute on function public.platform_accounts(), public.platform_set_account(uuid, uuid, boolean), public.platform_save_white_label(jsonb),
  public.create_account(text, text, text, text, uuid) from public, anon;
grant execute on function public.platform_accounts(), public.platform_set_account(uuid, uuid, boolean), public.platform_save_white_label(jsonb),
  public.create_account(text, text, text, text, uuid) to authenticated;
grant execute on function public.brand_for_host(text) to anon, authenticated;

-- older checks that let any GELP admin touch any account now stop at the accounts that admin manages
do $$
declare d text; b text; fixes text[][] := array[
  array['public.set_directories_enabled(uuid,boolean)', 'if not private.is_platform_admin() then', 'if not private.manages(p_tenant) then'],
  array['public.directories_flags()', 'jsonb_object_agg(tenant_id, directories) from private.feature_flags)', 'jsonb_object_agg(tenant_id, directories) from private.feature_flags where private.manages(tenant_id))'],
  array['public.account_invites()', 'where private.is_platform_admin() and', 'where private.manages(tenant_id) and'],
  array['public.site_request(uuid,text)', 'and not private.is_platform_admin())', 'and not private.manages(s.tenant_id))'],
  array['public.form_details(uuid)', 'or private.is_platform_admin())', 'or private.manages(f.tenant_id))'],
  array['private.guard_form()', 'if new.tenant_id is null then', 'if new.tenant_id is null or not private.manages(new.tenant_id) then']];
  i int;
begin
  for i in 1 .. array_length(fixes, 1) loop
    d := replace(pg_get_functiondef(fixes[i][1]::regprocedure), E'\r\n', E'\n');
    if position(fixes[i][3] in d) > 0 then continue; end if;
    b := d; d := replace(d, fixes[i][2], fixes[i][3]);
    if d = b then raise exception 'agency patch % (%) did not match', i, fixes[i][1]; end if;
    execute d;
  end loop;
end $$;
