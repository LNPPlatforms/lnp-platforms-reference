-- 074k: client portal, part 11. The CRM side: the Client portal card on an organization (invite, list, admin, remove).

create or replace function public.portal_admin_get(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
begin
  if not private.portal_staff_ok(p_company) then return null; end if;
  return jsonb_build_object('settings', private.portal_settings(private.current_tenant()),
    'users', (select coalesce(jsonb_agg(jsonb_build_object('id', pu.id, 'name', pu.full_name, 'email', pu.email, 'is_admin', pu.is_admin,
        'joined', pu.user_id is not null, 'invited_at', pu.invited_at, 'invite_sent_at', pu.invite_sent_at, 'last_seen_at', pu.last_seen_at,
        'by_client', pu.invited_by_portal is not null) order by pu.is_admin desc, coalesce(pu.full_name, pu.email)), '[]'::jsonb)
      from private.portal_users pu where pu.company_id = p_company and pu.tenant_id = private.current_tenant() and pu.removed_at is null),
    -- a parent organization that already has a portal (its people see this location too)
    'parent_portal', (with recursive up(id, d) as (select parent_company_id, 1 from companies where id = p_company
        union all select c2.parent_company_id, up.d + 1 from companies c2 join up on c2.id = up.id where up.d < 20)
      select jsonb_build_object('id', c.id, 'name', c.name) from up join companies c on c.id = up.id
       where exists (select 1 from private.portal_users p where p.company_id = c.id and p.removed_at is null) order by up.d limit 1));
end $$;

-- the first person invited for an organization is its admin
create or replace function public.portal_admin_invite(p_company uuid, p_email text, p_name text) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare first boolean;
begin
  if not private.portal_staff_ok(p_company) then raise exception 'Your role can''t give clients portal access'; end if;
  first := not exists (select 1 from private.portal_users where company_id = p_company and removed_at is null and is_admin);
  return private.portal_invite_make(private.current_tenant(), p_company, p_email, p_name, first, private.portal_areas(), auth.uid(), null);
end $$;

create or replace function public.portal_admin_set(p_id uuid, p_admin boolean) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare pu private.portal_users;
begin
  select * into pu from private.portal_users where id = p_id and tenant_id = private.current_tenant() and removed_at is null;
  if not found or not private.portal_staff_ok(pu.company_id) then raise exception 'Not found'; end if;
  update private.portal_users set is_admin = coalesce(p_admin, false) where id = pu.id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.portal_admin_remove(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare pu private.portal_users;
begin
  select * into pu from private.portal_users where id = p_id and tenant_id = private.current_tenant() and removed_at is null;
  if not found or not private.portal_staff_ok(pu.company_id) then raise exception 'Not found'; end if;
  update private.portal_users set removed_at = now(), removed_by = auth.uid() where id = pu.id;
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.portal_admin_get(uuid), public.portal_admin_invite(uuid, text, text), public.portal_admin_set(uuid, boolean), public.portal_admin_remove(uuid) from public, anon;
grant execute on function public.portal_admin_get(uuid), public.portal_admin_invite(uuid, text, text), public.portal_admin_set(uuid, boolean), public.portal_admin_remove(uuid) to authenticated;
