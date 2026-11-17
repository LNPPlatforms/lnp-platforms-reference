-- 026: online payment on accept, GELP's own account only, switched on and off from the CRM (Admin > Pricing).
-- The Stripe keys live only in Supabase Edge Function secrets. No other account can turn this on.

create table if not exists private.payment_settings (
  tenant_id uuid primary key references public.tenants(id),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.app_users(id)
);
alter table private.payment_settings enable row level security;
insert into private.payment_settings (tenant_id) values (private.default_tenant()) on conflict do nothing;

create or replace function private.guard_payment_settings() returns trigger
language plpgsql set search_path = public, private as $$
begin
  if new.tenant_id <> private.default_tenant() then raise exception 'Online payment is only available on the GELP account'; end if;
  new.updated_at := now(); new.updated_by := coalesce(auth.uid(), private.actor());
  return new;
end $$;
create trigger guard_payment_settings before insert or update on private.payment_settings for each row execute function private.guard_payment_settings();
create trigger audit_payment_settings after insert or update on private.payment_settings for each row execute function private.audit();
revoke execute on function private.guard_payment_settings() from public, anon, authenticated;

create or replace function private.pay_on(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, private as $$
  select p_tenant = private.default_tenant() and coalesce((select enabled from private.payment_settings where tenant_id = p_tenant), false)
$$;
revoke execute on function private.pay_on(uuid) from public, anon, authenticated;

-- for the edge functions (service role only)
create or replace function public.payments_on_for(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public, private as $$ select private.pay_on(p_tenant) $$;
revoke execute on function public.payments_on_for(uuid) from public, anon, authenticated;
grant execute on function public.payments_on_for(uuid) to service_role;

-- GELP admins: read and flip the switch
create or replace function public.payments_get() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.is_admin() and private.current_tenant() = private.default_tenant() then
    (select jsonb_build_object('enabled', s.enabled, 'updated_at', s.updated_at, 'updated_by', (select full_name from app_users where id = s.updated_by))
       from private.payment_settings s where s.tenant_id = private.default_tenant()) end
$$;
create or replace function public.payments_set(p_on boolean) returns jsonb
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_admin() or private.current_tenant() <> private.default_tenant() then raise exception 'Only a GELP admin can change online payment'; end if;
  update private.payment_settings set enabled = coalesce(p_on, false) where tenant_id = private.default_tenant() and enabled is distinct from coalesce(p_on, false);
  return public.payments_get();
end $$;
revoke execute on function public.payments_get(), public.payments_set(boolean) from public, anon;
grant execute on function public.payments_get(), public.payments_set(boolean) to authenticated;

-- the client page learns whether to offer payment from the proposal itself
do $m$
declare d text;
begin
  d := pg_get_functiondef('public.proposal_view(text,jsonb)'::regprocedure);
  if position('pay_on' in d) = 0 then
    if position($s$'quote', q);$s$ in d) = 0 then raise exception 'proposal_view changed, patch by hand'; end if;
    d := replace(d, $s$'quote', q);$s$, $s$'quote', q, 'pay_on', private.pay_on(p.tenant_id));$s$);
    execute d;
  end if;
end $m$;

-- 026b: an accepted proposal that's already paid says so even if the switch is later turned off
do $m$
declare d text;
begin
  d := pg_get_functiondef('public.proposal_view(text,jsonb)'::regprocedure);
  if position($s$'paid',$s$ in d) = 0 then
    d := replace(d, $s$'pay_on', private.pay_on(p.tenant_id));$s$,
      $s$'pay_on', private.pay_on(p.tenant_id),
    'paid', case when p.status = 'accepted' and p.pay_version = p.accepted_version and p.pay_status in ('paid','processing') then p.pay_status end);$s$);
    if position($s$'paid',$s$ in d) = 0 then raise exception 'patch failed'; end if;
    execute d;
  end if;
end $m$;
