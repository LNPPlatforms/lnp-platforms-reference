-- 090: no more emails from Supabase itself (Nov 10, 2026). Every login email goes out in the agency's brand and
-- links to the agency's own address.
--  - Invites carry a secret token in their link. Signing up with it (invite-accept function) makes the login already
--    confirmed, so there's no "confirm your email" message from Supabase. The invite email reached the inbox, which
--    proves the address.
--  - Password resets go through the password-reset function: a branded email with a link to the brand's own address.
--    The log below keeps one address from being sent more than one reset a minute.

alter table public.invites add column if not exists token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
create unique index if not exists invites_token_idx on public.invites (token);

-- invite_info now hands the token to the people who can send the invite (managers of the account or its admins)
create or replace function public.invite_info(p_tenant uuid, p_email text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('email', i.email, 'name', i.full_name, 'is_admin', i.is_admin,
           'account', t.name, 'brand', private.brand_of(t.id), 'token', i.token,
           'from_name', (select full_name from app_users where id = auth.uid()))
  from invites i join tenants t on t.id = i.tenant_id
  where i.tenant_id = p_tenant and lower(i.email) = lower(trim(p_email)) and i.accepted_at is null and i.revoked_at is null
    and (private.manages(p_tenant) or (private.is_admin() and p_tenant = private.current_tenant()))
  order by i.created_at desc limit 1
$$;

-- for the invite-accept function (service role only): the open invite that matches an email and token
create or replace function private.invite_by_token(p_email text, p_token text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('id', i.id, 'tenant_id', i.tenant_id, 'email', i.email, 'name', i.full_name)
    from invites i
   where i.token = p_token and lower(i.email) = lower(trim(p_email)) and i.accepted_at is null and i.revoked_at is null
   limit 1
$$;
revoke all on function private.invite_by_token(text, text) from public, anon, authenticated;

create table if not exists private.password_reset_log (email text not null, at timestamptz not null default now());
create index if not exists password_reset_log_idx on private.password_reset_log (lower(email), at desc);

-- for the password-reset function (service role only): who this login belongs to, so the email carries the right brand.
-- Returns null when the address has no login, or when it got a reset in the last minute (the function says "sent" either way).
create or replace function private.reset_target(p_email text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare e text := lower(trim(p_email)); u record;
begin
  if e is null or e = '' then return null; end if;
  if exists (select 1 from private.password_reset_log where lower(email) = e and at > now() - interval '1 minute') then return null; end if;
  select a.id, a.full_name, a.tenant_id into u from app_users a where lower(a.email) = e and a.active limit 1;
  if u.id is null then return null; end if;
  insert into private.password_reset_log (email) values (e);
  delete from private.password_reset_log where at < now() - interval '1 day';
  return jsonb_build_object('user_id', u.id, 'name', u.full_name, 'tenant_id', u.tenant_id);
end $$;
revoke all on function private.reset_target(text) from public, anon, authenticated;

-- the functions call these through PostgREST, which only exposes public; thin wrappers only the service role can run
create or replace function public.svc_invite_by_token(p_email text, p_token text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select private.invite_by_token(p_email, p_token)
$$;
create or replace function public.svc_reset_target(p_email text) returns jsonb
language sql security definer set search_path = public, private as $$
  select private.reset_target(p_email)
$$;
revoke all on function public.svc_invite_by_token(text, text) from public, anon, authenticated;
revoke all on function public.svc_reset_target(text) from public, anon, authenticated;
grant execute on function public.svc_invite_by_token(text, text) to service_role;
grant execute on function public.svc_reset_target(text) to service_role;
create or replace function public.svc_brand_of(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select private.brand_of(p_tenant)
$$;
revoke all on function public.svc_brand_of(uuid) from public, anon, authenticated;
grant execute on function public.svc_brand_of(uuid) to service_role;
