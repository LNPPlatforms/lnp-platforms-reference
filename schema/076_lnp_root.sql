-- 076: LNP Platforms is the top of the platform (Oct 31, 2026).
-- Before: GELP's account (the 0...1 tenant) sat at the top and pointed at itself, Chris's login lived in GELP, and the
-- CRM's default look was GELP's. Now:
--   * LNP Platforms is its own account (0...2), owned by Chris, with no agency above it. Chris signs in there.
--   * GELP and GCC are agencies (white labels) under LNP, side by side. GELP is nothing more than an agency.
--   * Chris stays on GELP's team as an admin member, so he can still switch in and work GELP.
--   * GELP's admins manage only GELP's own accounts. GCC is no longer under GELP.
-- private.default_tenant() still means "GELP's account" for GELP-only things (GELP proposals, GELP's Stripe,
-- public forms with no account named). It does not mean the top of the platform; private.platform_tenant() does.

create or replace function private.platform_tenant() returns uuid
language sql immutable set search_path = pg_catalog as $$ select '00000000-0000-0000-0000-000000000002'::uuid $$;
grant execute on function private.platform_tenant() to anon, authenticated;

-- the LNP account (seeds its pipeline through the usual trigger)
insert into public.tenants (id, name, slug, is_agency, agency_tenant_id, plan)
values (private.platform_tenant(), 'LNP Platforms', 'lnp', true, null, 'full')
on conflict (id) do update set name = excluded.name, is_agency = true, agency_tenant_id = null;

-- GELP and GCC sit under LNP
update public.tenants set agency_tenant_id = private.platform_tenant()
 where id in (private.default_tenant(), (select id from public.tenants where slug = 'gcc'));

-- brands: LNP's own, and GELP gets a real white label row (it used to be the built-in default)
insert into public.white_labels (agency_tenant_id, name, short_name, domain, email_from_name)
values (private.platform_tenant(), 'LNP Platforms', 'LNP', 'app.lnpplatforms.com', 'LNP Platforms')
on conflict (agency_tenant_id) do nothing;
insert into public.white_labels (agency_tenant_id, name, short_name, domain, email_from_name)
values (private.default_tenant(), 'GELP CRM', 'GELP', 'app.gelpstrategies.com', 'GELP Strategies')
on conflict (agency_tenant_id) do nothing;

-- Chris: move his home to LNP, then give him a GELP admin seat as a member (a member row can't point at a home account)
create temp table lnp_moving on commit drop as
  select u.id, u.role_id, coalesce(u.divisions, '{}') as divisions
    from public.app_users u join private.platform_owners o on o.user_id = u.id where u.tenant_id = private.default_tenant();
update public.app_users u set tenant_id = private.platform_tenant(), acting_tenant_id = null, role_id = null, divisions = '{}'
  from lnp_moving x where x.id = u.id;
insert into public.account_members (tenant_id, user_id, is_admin, role_id, divisions, added_by)
select private.default_tenant(), x.id, true, x.role_id, x.divisions, x.id from lnp_moving x
 where not exists (select 1 from public.account_members m where m.user_id = x.id and m.tenant_id = private.default_tenant());
update public.account_members m set active = true, is_admin = true, removed_at = null, removed_by = null
  from private.platform_owners o where o.user_id = m.user_id and m.tenant_id = private.default_tenant();

-- LNP is the root: it can't be put under anyone or stop being the top agency
create or replace function public.platform_set_account(p_tenant uuid, p_agency uuid, p_is_agency boolean) returns jsonb
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_platform_owner() then raise exception 'Only the platform admin can do that'; end if;
  if p_tenant = private.platform_tenant() then raise exception 'LNP Platforms is the top of the platform'; end if;
  if p_tenant = private.default_tenant() and not coalesce(p_is_agency, true) then raise exception 'GELP stays an agency'; end if;
  if p_agency is not null and not exists (select 1 from tenants where id = p_agency and is_agency) then raise exception 'That account is not an agency'; end if;
  if p_agency = p_tenant then raise exception 'An account cannot sit under itself'; end if;
  update tenants set agency_tenant_id = coalesce(p_agency, agency_tenant_id), is_agency = coalesce(p_is_agency, is_agency) where id = p_tenant;
  return jsonb_build_object('ok', true);
end $$;

-- every account, LNP first, then agencies, then the rest
create or replace function public.platform_accounts() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when not private.is_platform_owner() then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'plan', t.plan, 'is_agency', t.is_agency,
      'is_root', t.id = private.platform_tenant(),
      'agency_id', t.agency_tenant_id, 'agency', a.name, 'created_at', t.created_at,
      'users', (select count(*) from app_users u where u.tenant_id = t.id and u.role not in ('vendor', 'member')),
      'orgs', (select count(*) from companies c where c.tenant_id = t.id and c.archived_at is null))
      order by (t.id = private.platform_tenant()) desc, t.is_agency desc, t.name)
    from tenants t left join tenants a on a.id = t.agency_tenant_id), '[]'::jsonb) end
$$;

-- current_account says which account is the platform root
create or replace function public.current_account() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'home', private.home_tenant(),
    'platform_admin', private.is_platform_admin(), 'platform_owner', private.is_platform_owner(),
    'is_gelp', t.id = private.default_tenant(), 'is_root', t.id = private.platform_tenant(), 'plan', t.plan, 'is_agency', t.is_agency,
    'home_agency', (select h.name from tenants h where h.id = private.home_tenant()),
    'brand', private.brand_of(t.id),
    'member', (select jsonb_build_object('is_admin', m.is_admin, 'role_id', m.role_id, 'divisions', m.divisions, 'customer_facing', m.customer_facing)
                 from private.ctx_member() m limit 1))
  from tenants t where t.id = private.current_tenant()
$$;
