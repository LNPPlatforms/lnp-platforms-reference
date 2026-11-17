-- 108: LNP is the Stripe platform (Nov 16, 2026).
-- Two Stripe keys in the edge functions:
--   LNP_STRIPE_SECRET_KEY  LNP's Stripe: the Connect platform (every connected account), plus "house" accounts that take
--                          payments straight in LNP's own Stripe (LNP itself, and Cognix until it has its own entity)
--   STRIPE_SECRET_KEY      GELP's own Stripe: GELP's proposals and invoices, as before, until GELP logs in through Connect
-- An account's processor, first match wins: its own connected Stripe, a house account (LNP's Stripe), GELP's switch
-- (GELP only), a pasted payment link.
create table if not exists private.pay_house (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  note text,
  created_at timestamptz not null default now()
);
revoke all on private.pay_house from public, anon, authenticated;

insert into private.pay_house (tenant_id, note)
select id, 'LNP Platforms' from public.tenants where id = private.platform_tenant()
on conflict do nothing;
insert into private.pay_house (tenant_id, note)
select id, 'Cognix, until it has its own entity' from public.tenants where name = 'Cognix CRM'
on conflict do nothing;

create or replace function private.pay_method(p_tenant uuid) returns text
language sql stable security definer set search_path = public, private as $$
  select case
    when exists (select 1 from private.pay_processors where tenant_id = p_tenant and stripe_ready and stripe_account_id is not null) then 'stripe'
    when exists (select 1 from private.pay_house where tenant_id = p_tenant) then 'platform'
    when private.pay_on(p_tenant) then 'platform'
    when exists (select 1 from private.doc_settings where tenant_id = p_tenant and pay_link is not null) then 'link'
  end
$$;
revoke execute on function private.pay_method(uuid) from public, anon, authenticated;

-- edge functions: does this account's direct (non-Connect) Stripe traffic use LNP's key?
create or replace function public.pay_house(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from private.pay_house where tenant_id = p_tenant)
$$;
revoke execute on function public.pay_house(uuid) from public, anon, authenticated;
grant execute on function public.pay_house(uuid) to service_role;

-- the settings screen: tell house accounts where their money goes
create or replace function public.my_pay_house() returns boolean
language sql stable security definer set search_path = public, private as $$
  select exists (select 1 from private.pay_house where tenant_id = private.current_tenant())
$$;
revoke execute on function public.my_pay_house() from public, anon;
grant execute on function public.my_pay_house() to authenticated;
