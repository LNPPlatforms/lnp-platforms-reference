-- 086c (Nov 9, 2026): where an account's emails come from and where their links point, for the edge functions.
-- Its agency's white label: app = https://<domain> (null: the function's APP_URL), send = send_domain (null: SEND_DOMAIN).
-- Called with the service key (any account) or by someone on / managing the account. No account given: the caller's own.
create or replace function public.email_brand(p_tenant uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare t uuid := coalesce(p_tenant, private.current_tenant()); ag uuid; w white_labels;
begin
  if t is null then return null; end if;
  if not (coalesce(auth.role(), '') = 'service_role' or t = private.current_tenant() or private.manages(t)) then raise exception 'Account not found'; end if;
  select case when is_agency then id else agency_tenant_id end into ag from tenants where id = t;
  select * into w from white_labels where agency_tenant_id = ag;
  return jsonb_build_object('tenant', t, 'agency', ag, 'name', w.name, 'support', w.support_email,
    'app', case when coalesce(w.domain, '') ~ '^[a-z0-9.-]+\.[a-z]{2,}$' then 'https://' || w.domain end,
    'send', nullif(w.send_domain, ''));
end $$;
revoke execute on function public.email_brand(uuid) from public, anon;
grant execute on function public.email_brand(uuid) to authenticated, service_role;
