-- 074b: client portal, part 2. Logins.
-- A signed-in login with no app_users row (a portal user) gets a tenant that matches nothing, instead of falling
-- back to the platform's own account. Signing up with a portal invite makes a portal user, never staff. A CRM
-- login can't be invited to a portal and a portal login can't be invited to a team.

create or replace function private.current_tenant() returns uuid
language sql stable security definer set search_path = public, private as $$
  select case when auth.uid() is not null and not exists (select 1 from app_users where id = auth.uid())
    then '00000000-0000-0000-0000-000000000000'::uuid
    else coalesce((select case when u.acting_tenant_id is not null and u.active and (
                                 private.switch_managed(u.id, u.acting_tenant_id)
                                 or (u.role not in ('vendor', 'member') and exists (select 1 from account_members m
                                       where m.user_id = u.id and m.tenant_id = u.acting_tenant_id and m.active)))
                               then u.acting_tenant_id else u.tenant_id end
                     from app_users u where u.id = private.actor()), private.default_tenant()) end
$$;

-- is this email someone's CRM login (or about to be)?
create or replace function private.is_crm_email(p_email text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from app_users where lower(email) = lower(trim(p_email)))
      or exists (select 1 from invites where lower(email) = lower(trim(p_email)) and accepted_at is null and revoked_at is null)
$$;
create or replace function private.is_portal_email(p_email text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from private.portal_users where lower(email) = lower(trim(p_email)) and removed_at is null)
$$;
revoke execute on function private.is_crm_email(text), private.is_portal_email(text) from public, anon, authenticated;

create or replace function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare inv invites%rowtype; n int;
begin
  if exists (select 1 from app_users where id = new.id) then return new; end if;
  select * into inv from invites
   where lower(email) = lower(new.email) and accepted_at is null and revoked_at is null
   order by created_at desc limit 1;
  if not found then
    -- a client portal invite: link every open portal invite for this email to the new login, and nothing else
    update private.portal_users set user_id = new.id, accepted_at = now(),
           full_name = coalesce(nullif(trim(full_name), ''), nullif(trim(new.raw_user_meta_data->>'full_name'), ''))
     where lower(email) = lower(new.email) and user_id is null and removed_at is null;
    get diagnostics n = row_count;
    if n > 0 then return new; end if;
    raise exception 'NOT_INVITED: This email has not been invited yet.';
  end if;
  if private.is_portal_email(new.email) then
    raise exception 'PORTAL_EMAIL: This email is a client portal login, so it can''t also be a team login.';
  end if;
  insert into app_users (id, full_name, email, role, active, is_admin, manager_id, vendor_id, tenant_id)
  values (new.id, coalesce(nullif(trim(inv.full_name),''), new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
          lower(new.email), inv.role::user_role, true, inv.is_admin and inv.role = 'staff', inv.manager_id, inv.vendor_id, inv.tenant_id);
  update invites set accepted_at = now(), accepted_user = new.id where id = inv.id;
  return new;
end $$;

-- team invites can't go to a portal login
create or replace function private.invite_not_portal() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if private.is_portal_email(new.email) then
    raise exception 'That email is a client portal login. Use a different email for the team.';
  end if;
  return new;
end $$;
revoke execute on function private.invite_not_portal() from public, anon, authenticated;
create or replace trigger invite_not_portal before insert on public.invites for each row execute function private.invite_not_portal();
