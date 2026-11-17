-- 070c: adding, changing and removing members of an account.

-- the name shown on their badge: "from GCC" (an agency's short brand name, else the home account's name)
create or replace function private.home_label(p_user uuid) returns text
language sql stable security definer set search_path = public, private as $$
  select case when h.is_agency then coalesce(nullif(private.brand_of(h.id)->>'short_name', ''), nullif(private.brand_of(h.id)->>'name', ''), h.name) else h.name end
    from app_users u join tenants h on h.id = u.tenant_id where u.id = p_user
$$;

-- people the signed-in agency admin can add to an account they manage: their own account's team
-- (the platform owner can also add people from the agency the account sits under)
create or replace function private.may_add_member(p_tenant uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.manages(p_tenant) and exists (select 1 from app_users u where u.id = p_user and u.active and u.role not in ('vendor', 'member')
    and u.tenant_id <> p_tenant
    and (u.tenant_id = private.home_tenant()
         or (private.is_platform_owner() and u.tenant_id = (select agency_tenant_id from tenants where id = p_tenant))))
$$;

create or replace function public.account_member_candidates(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.full_name, 'email', u.email, 'from', private.home_label(u.id),
           'member', exists (select 1 from account_members m where m.user_id = u.id and m.tenant_id = p_tenant and m.active)) order by u.full_name), '[]'::jsonb)
    from app_users u where private.may_add_member(p_tenant, u.id)
$$;

create or replace function public.account_member_add(p_tenant uuid, p_user uuid, p_is_admin boolean default false) returns jsonb
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.manages(p_tenant) then raise exception 'That account is not one of yours'; end if;
  if not private.may_add_member(p_tenant, p_user) then raise exception 'You can add people from your own account only'; end if;
  insert into account_members (tenant_id, user_id, is_admin, added_by)
  values (p_tenant, p_user, coalesce(p_is_admin, false), auth.uid())
  on conflict (tenant_id, user_id) do update set active = true, is_admin = excluded.is_admin, added_by = excluded.added_by, added_at = now(),
    removed_by = null, removed_at = null;
  return jsonb_build_object('ok', true);
end $$;

-- the client account's team: everyone who is a member here but lives in another account
create or replace function public.account_members_list(p_tenant uuid default null) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'full_name', u.full_name, 'email', u.email, 'is_admin', m.is_admin,
           'role_id', m.role_id, 'divisions', m.divisions, 'customer_facing', m.customer_facing, 'from', private.home_label(m.user_id),
           'added_at', m.added_at) order by u.full_name), '[]'::jsonb)
    from account_members m join app_users u on u.id = m.user_id and u.active
   where m.active and m.tenant_id = coalesce(p_tenant, private.current_tenant())
     and ((p_tenant is null and private.is_internal()) or (p_tenant = private.current_tenant() and private.is_internal()) or private.manages(p_tenant))
$$;

-- the client changes admin and divisions for a member (role and customer facing use user_role_set and user_customer_facing_set)
create or replace function public.account_member_set(p_user uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare m account_members; t uuid := private.current_tenant(); d uuid[];
begin
  if not (private.is_admin() or private.can('team', 4)) then raise exception 'Only people who manage the team can change this'; end if;
  if p_user = auth.uid() then raise exception 'You can''t change your own access'; end if;
  select * into m from account_members where user_id = p_user and tenant_id = t and active for update;
  if not found then raise exception 'Person not found'; end if;
  if (m.is_admin or p ? 'is_admin') and not private.is_admin() then raise exception 'Only an admin can change an admin'; end if;
  if p ? 'divisions' then
    select coalesce(array_agg(e.x::uuid), '{}') into d from jsonb_array_elements_text(p->'divisions') e(x)
     where exists (select 1 from divisions v where v.id = e.x::uuid and v.tenant_id = t);
  end if;
  update account_members set is_admin = coalesce((p->>'is_admin')::boolean, is_admin), divisions = coalesce(d, divisions) where id = m.id;
  return jsonb_build_object('ok', true);
end $$;

-- the client (or the agency that manages it) takes someone off the account. Their home account is untouched.
create or replace function public.account_member_remove(p_user uuid, p_tenant uuid default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t uuid := coalesce(p_tenant, private.current_tenant()); m account_members;
begin
  if not ((t = private.current_tenant() and (private.is_admin() or private.can('team', 4))) or private.manages(t)) then
    raise exception 'Only people who manage the team can remove someone';
  end if;
  if p_user = auth.uid() and t = private.current_tenant() then raise exception 'You can''t remove yourself'; end if;
  select * into m from account_members where user_id = p_user and tenant_id = t and active for update;
  if not found then raise exception 'Person not found'; end if;
  if m.is_admin and not (private.manages(t) or (t = private.current_tenant() and private.is_admin())) then raise exception 'Only an admin can remove an admin'; end if;
  update account_members set active = false, removed_by = auth.uid(), removed_at = now() where id = m.id;
  update app_users set acting_tenant_id = null where id = p_user and acting_tenant_id = t;
  -- department rows stay (chat routing checks on_team and cf_in, so they do nothing) and come back if they're added again
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function private.home_label(uuid), private.may_add_member(uuid, uuid) from public, anon;
grant execute on function private.home_label(uuid), private.may_add_member(uuid, uuid) to authenticated;
revoke execute on function public.account_member_candidates(uuid), public.account_member_add(uuid, uuid, boolean), public.account_members_list(uuid),
  public.account_member_set(uuid, jsonb), public.account_member_remove(uuid, uuid) from public, anon;
grant execute on function public.account_member_candidates(uuid), public.account_member_add(uuid, uuid, boolean), public.account_members_list(uuid),
  public.account_member_set(uuid, jsonb), public.account_member_remove(uuid, uuid) to authenticated;
