-- 070b: the account you're working in, and what you can do there, follow membership.

-- switch into an account you manage (as before) or one you're an active member of
create or replace function private.current_tenant() returns uuid
language sql stable security definer set search_path = public, private as $$
  select coalesce((select case when u.acting_tenant_id is not null and u.active and (
                                 private.switch_managed(u.id, u.acting_tenant_id)
                                 or (u.role not in ('vendor', 'member') and exists (select 1 from account_members m
                                       where m.user_id = u.id and m.tenant_id = u.acting_tenant_id and m.active)))
                               then u.acting_tenant_id else u.tenant_id end
                     from app_users u where u.id = private.actor()), private.default_tenant())
$$;

create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select case when m.user_id is not null then m.is_admin else u.is_admin end
                     from app_users u left join private.ctx_member() m on true
                    where u.id = auth.uid() and u.active and u.role not in ('vendor', 'member')), false)
$$;

create or replace function private.my_divisions() returns uuid[]
language sql stable security definer set search_path = public, private as $$
  select coalesce((select case when m.user_id is not null then case when m.is_admin then '{}'::uuid[] else m.divisions end
                               when u.is_admin or u.tenant_id <> private.current_tenant() then '{}'::uuid[] else u.divisions end
                     from app_users u left join private.ctx_member() m on true where u.id = auth.uid()), '{}'::uuid[])
$$;

create or replace function private.perm(area text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case
    when u.id is null or not u.active or u.role in ('vendor', 'member') then '{"level":0,"scope":"own"}'::jsonb
    when (case when m.user_id is not null then m.is_admin else u.is_admin end) then '{"level":4,"scope":"all"}'::jsonb
    when r.id is not null then coalesce(r.perms->area, private.area_default(r.preset_key, area))
    else coalesce(public.role_presets()->'manager'->'perms'->area, private.area_default('manager', area))
  end
  from (select auth.uid() as uid) x
  left join app_users u on u.id = x.uid
  left join private.ctx_member() m on true
  left join roles r on r.archived_at is null
    and r.id = case when m.user_id is not null then m.role_id else u.role_id end
    and r.tenant_id = case when m.user_id is not null then m.tenant_id else u.tenant_id end
$$;

-- switching: home, an account you manage, or one you're a member of
create or replace function public.set_acting_tenant(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
begin
  if p_tenant is not null and p_tenant is distinct from private.home_tenant() then
    if not exists (select 1 from tenants where id = p_tenant) then raise exception 'Account not found'; end if;
    if not (private.manages(p_tenant) or exists (select 1 from account_members m join app_users u on u.id = m.user_id
              where m.user_id = auth.uid() and m.tenant_id = p_tenant and m.active and u.active and u.role not in ('vendor', 'member'))) then
      raise exception 'That account is not one of yours';
    end if;
  end if;
  update app_users set acting_tenant_id = nullif(p_tenant, tenant_id) where id = auth.uid();
  return jsonb_build_object('ok', true, 'tenant', private.current_tenant());
end $$;

-- who am I working as right now; 'member' is set when you're in as a team member of someone else's account
create or replace function public.current_account() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug, 'home', private.home_tenant(),
    'platform_admin', private.is_platform_admin(), 'platform_owner', private.is_platform_owner(),
    'is_gelp', t.id = private.default_tenant(), 'plan', t.plan, 'is_agency', t.is_agency,
    'home_agency', (select h.name from tenants h where h.id = private.home_tenant()),
    'brand', private.brand_of(t.id),
    'member', (select jsonb_build_object('is_admin', m.is_admin, 'role_id', m.role_id, 'divisions', m.divisions, 'customer_facing', m.customer_facing)
                 from private.ctx_member() m limit 1))
  from tenants t where t.id = private.current_tenant()
$$;

-- the account switcher: home, every account you're a member of, and what you manage (managing wins when both)
create or replace function public.my_accounts() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'kind', x.kind) order by case x.kind when 'home' then 0 when 'member' then 1 else 2 end, x.name), '[]'::jsonb) from (
    select distinct on (t.id) t.id, t.name, k.kind, k.k from tenants t
      join (select private.home_tenant() as id, 'home' as kind, 0 as k
            union all select m.tenant_id, 'member', 2 from account_members m where m.user_id = auth.uid() and m.active and private.is_internal()
            union all select t2.id, 'managed', 1 from tenants t2 where private.manages(t2.id)) k on k.id = t.id
     where auth.uid() is not null
     order by t.id, k.k) x
$$;
revoke execute on function public.my_accounts() from public, anon;
grant execute on function public.my_accounts() to authenticated;
