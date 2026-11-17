-- 080: login help across accounts (Nov 2, 2026).
-- Who can see an account's logins and email someone a password reset:
--   anyone active on LNP Platforms (the top) for every account,
--   an agency's admins for their own agency and the accounts under it (private.manages),
--   an account's own admins for their own team.
-- The reset email itself is the standard Supabase link sent to the person's own inbox, so this only controls
-- who gets the list and the button; nobody ever sees or sets someone else's password.

create or replace function private.can_help_logins(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_platform_owner()
    or exists (select 1 from app_users u where u.id = auth.uid() and u.active and u.role not in ('vendor', 'member')
               and u.tenant_id = private.platform_tenant())
    or private.manages(p_tenant)
    or exists (select 1 from app_users u where u.id = auth.uid() and u.active and u.is_admin and u.tenant_id = p_tenant)
$$;

-- The account's logins plus the web address its people sign in at (its white label's domain).
create or replace function public.account_logins(p_tenant uuid)
returns table (id uuid, full_name text, email text, active boolean, is_admin boolean, role text, login_domain text)
language plpgsql stable security definer set search_path = public, private as $$
begin
  if not private.can_help_logins(p_tenant) then raise exception 'You can''t manage logins for that account'; end if;
  return query
    select u.id, u.full_name, u.email, u.active, u.is_admin, u.role::text,
      (select w.domain from tenants t left join white_labels w
          on w.agency_tenant_id = case when t.is_agency then t.id else t.agency_tenant_id end
        where t.id = p_tenant)
    from app_users u
    where u.tenant_id = p_tenant and u.role <> 'member'
    order by u.active desc, u.full_name;
end $$;

revoke all on function public.account_logins(uuid) from public, anon;
grant execute on function public.account_logins(uuid) to authenticated;
