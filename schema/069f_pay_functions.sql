-- 069f: what the invoice-pay and payments-connect functions call (service role only, except pay_processor_me).
create or replace function public.invoice_pay_info(p_token text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('id', i.id, 'tenant_id', i.tenant_id, 'number', coalesce(d.prefix, '') || i.number, 'status', i.status, 'balance', i.balance,
    'org', c.name, 'email', coalesce(nullif(i.bill_to->>'email', ''), c.main_email), 'session', i.stripe_session_id,
    'method', private.pay_method(i.tenant_id), 'link', d.pay_link, 'stripe_account', pp.stripe_account_id, 'account', private.doc_brand(i.tenant_id)->>'name')
  from invoices i join companies c on c.id = i.company_id left join private.doc_settings d on d.tenant_id = i.tenant_id
  left join private.pay_processors pp on pp.tenant_id = i.tenant_id and pp.stripe_ready
  where i.share_token = p_token and length(p_token) >= 32
$$;

create or replace function public.invoice_session_set(p_id uuid, p_session text) returns void
language sql security definer set search_path = public, private as $$
  update invoices set stripe_session_id = p_session where id = p_id
$$;

-- a Stripe checkout for an invoice finished: post the payment once per checkout
create or replace function public.invoice_stripe_paid(p_invoice uuid, p_session text, p_amount numeric, p_method text) returns boolean
language plpgsql security definer set search_path = public, private as $$
declare n int;
begin
  insert into invoice_payments (tenant_id, invoice_id, amount, method, reference, status, source, stripe_session_id)
  select tenant_id, id, round(p_amount, 2), case when p_method in ('card', 'bank') then p_method else 'card' end, 'Stripe', 'posted', 'stripe', p_session
    from invoices where id = p_invoice and status <> 'void' and p_amount > 0
  on conflict (stripe_session_id) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;

create or replace function public.pay_processor_get(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce((select to_jsonb(p) from private.pay_processors p where tenant_id = p_tenant), '{}'::jsonb)
$$;
create or replace function public.pay_processor_set(p_tenant uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if coalesce((p->>'clear')::boolean, false) then
    update private.pay_processors set stripe_account_id = null, stripe_ready = false, stripe_name = null, checked_at = now() where tenant_id = p_tenant; return;
  end if;
  insert into private.pay_processors as x (tenant_id, stripe_account_id, stripe_ready, stripe_name, connected_by, connected_at, checked_at)
  values (p_tenant, p->>'stripe_account_id', coalesce((p->>'stripe_ready')::boolean, false), p->>'stripe_name', nullif(p->>'by', '')::uuid, now(), now())
  on conflict (tenant_id) do update set stripe_account_id = coalesce(excluded.stripe_account_id, x.stripe_account_id),
    stripe_ready = excluded.stripe_ready, stripe_name = coalesce(excluded.stripe_name, x.stripe_name), checked_at = now(),
    connected_by = coalesce(x.connected_by, excluded.connected_by);
end $$;
revoke execute on function public.invoice_pay_info(text), public.invoice_session_set(uuid, text), public.invoice_stripe_paid(uuid, text, numeric, text),
  public.pay_processor_get(uuid), public.pay_processor_set(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.invoice_pay_info(text), public.invoice_session_set(uuid, text), public.invoice_stripe_paid(uuid, text, numeric, text),
  public.pay_processor_get(uuid), public.pay_processor_set(uuid, jsonb) to service_role;

-- payments-connect asks this as the signed-in person: which account, and may they connect its processor
create or replace function public.pay_processor_me() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('tenant_id', private.current_tenant(), 'can', private.can_doc_settings(), 'user_id', auth.uid(),
    'email', (select email from app_users where id = auth.uid()), 'account', private.doc_brand(private.current_tenant())->>'name')
  where private.is_internal()
$$;
revoke execute on function public.pay_processor_me() from public, anon;
grant execute on function public.pay_processor_me() to authenticated;
