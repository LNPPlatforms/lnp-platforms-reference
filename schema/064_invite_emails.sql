-- 064: invites send a real email (Oct 29, 2026).
-- The invite-email function asks this, signed in as the person sending, so the database decides who can send:
-- an admin of the account, or an agency admin (or the platform owner) over it. Returns what the email needs:
-- who's invited, the account, its brand (white label) and who sent it.
create or replace function public.invite_info(p_tenant uuid, p_email text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('email', i.email, 'name', i.full_name, 'is_admin', i.is_admin,
           'account', t.name, 'brand', private.brand_of(t.id),
           'from_name', (select full_name from app_users where id = auth.uid()))
  from invites i join tenants t on t.id = i.tenant_id
  where i.tenant_id = p_tenant and lower(i.email) = lower(trim(p_email)) and i.accepted_at is null and i.revoked_at is null
    and (private.manages(p_tenant) or (private.is_admin() and p_tenant = private.current_tenant()))
  order by i.created_at desc limit 1
$$;
revoke execute on function public.invite_info(uuid, text) from public, anon;
grant execute on function public.invite_info(uuid, text) to authenticated;
