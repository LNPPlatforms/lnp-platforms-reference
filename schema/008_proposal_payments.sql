-- 008: proposal payments through Stripe Checkout (GELP's Stripe account).
-- On accept, the client page asks the proposal-checkout function for a Checkout page built from the accepted
-- version: the setup total as a one-time charge plus the monthly total as a subscription. Stripe collects the
-- card or bank details; the CRM only stores status and Stripe ids. The key lives in Supabase secrets (STRIPE_SECRET_KEY).
alter table public.proposals add column if not exists pay_status text check (pay_status in ('pending','processing','paid','failed'));
alter table public.proposals add column if not exists pay_version int;
alter table public.proposals add column if not exists stripe_session_id text;
alter table public.proposals add column if not exists stripe_customer_id text;
alter table public.proposals add column if not exists stripe_subscription_id text;
alter table public.proposals add column if not exists paid_at timestamptz;
alter table public.proposals add column if not exists paid_amount numeric;

-- Payment fields are written only by the payment functions (service role), never by a signed-in user.
create or replace function private.guard_proposal_payment() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if auth.uid() is not null and (
       new.pay_status is distinct from old.pay_status or new.pay_version is distinct from old.pay_version
    or new.stripe_session_id is distinct from old.stripe_session_id or new.stripe_customer_id is distinct from old.stripe_customer_id
    or new.stripe_subscription_id is distinct from old.stripe_subscription_id
    or new.paid_at is distinct from old.paid_at or new.paid_amount is distinct from old.paid_amount) then
    raise exception 'Payment status is set by Stripe';
  end if;
  return new;
end $$;
create trigger guard_proposal_payment before update on public.proposals
  for each row execute function private.guard_proposal_payment();
revoke execute on function private.guard_proposal_payment() from public, anon, authenticated;
