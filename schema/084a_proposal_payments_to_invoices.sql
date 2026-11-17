-- 084a (Nov 3, Chris by voice): a proposal paid online is an invoice paid. When the customer pays at signing, the CRM
-- makes a paid invoice for what was collected (setup plus the first month or week), and every recurring part becomes a
-- repeating invoice series (083a) with autopay on the card or bank they just saved. New checkouts no longer start
-- Stripe subscriptions; proposals paid before this (they have stripe_subscription_id) keep their Stripe subscriptions.
-- Free trials: the series' first invoice is on the day the trial ends. Later phases (ph > 1) aren't billed here; they
-- start when their phase does (still by hand). The "Make an invoice" button opens the invoice that already exists.

alter table public.proposals
  add column if not exists signing_invoice_id uuid references public.invoices(id) on delete set null,
  add column if not exists invoice_series jsonb;

-- what's billed for a proposal version: the setup lines and the recurring groups (cycle and trial), with the same
-- discount math as proposal-checkout
create or replace function private.proposal_billing(p proposals) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare v proposal_versions; ls jsonb; has_trial boolean; off numeric; groups jsonb := '[]'::jsonb; g record;
begin
  select * into v from proposal_versions where proposal_id = p.id and version = p.accepted_version;
  if not found then return null; end if;
  select coalesce(jsonb_agg(l), '[]'::jsonb) into ls from jsonb_array_elements(coalesce(v.quote->'lines', '[]'::jsonb)) l where coalesce((l->>'ph')::int, 1) = 1;
  has_trial := exists (select 1 from jsonb_array_elements(ls) l where coalesce((l->>'trial')::numeric, 0) > 0);
  off := 1 - coalesce((v.quote->'month'->>'pct')::numeric, 0) / 100;
  for g in
    select x.cycle, x.trial, sum(x.amt) gross,
      jsonb_agg(jsonb_build_object('name', x.title, 'desc', x.sub, 'qty', 1, 'price', x.amt, 'tax', 0)) lines
    from (select c.cycle, coalesce((l->>'trial')::int, 0) trial, coalesce(nullif(l->>'title', ''), 'Services') title, coalesce(l->>'sub', '') sub,
                 case c.cycle when 'month' then coalesce((l->>'mo')::numeric, 0) else coalesce((l->>'wk')::numeric, 0) end amt
            from jsonb_array_elements(ls) l cross join (values ('month'), ('week')) c(cycle)) x
    where x.amt > 0 group by x.cycle, x.trial order by x.trial, x.cycle
  loop
    groups := groups || jsonb_build_array(jsonb_build_object('cycle', g.cycle, 'trial', g.trial, 'gross', g.gross, 'lines', g.lines,
      'net', case when has_trial then round(g.gross * off, 2) when g.cycle = 'month' then v.monthly_total else v.weekly_total end));
  end loop;
  return jsonb_build_object('setup_total', v.setup_total,
    'setup_lines', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(nullif(l->>'title', ''), 'Setup'), 'desc', coalesce(l->>'sub', ''), 'qty', 1,
        'price', (l->>'setup')::numeric, 'tax', 0)), '[]'::jsonb) from jsonb_array_elements(ls) l where coalesce((l->>'setup')::numeric, 0) > 0),
    'groups', groups);
end $$;

-- proposal-checkout and stripe-webhook call this once the signing payment is in (or the card is saved). Safe to call twice.
create or replace function public.proposal_paid_to_invoices(p_proposal uuid, p_session text, p_amount numeric, p_method text,
  p_customer text, p_pm text, p_label text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare p proposals; b jsonb; g jsonb; inv_id uuid; lines jsonb := '[]'::jsonb; gross numeric; series jsonb := '[]'::jsonb; sid uuid;
  nxt date; ds private.doc_settings; who text; em text;
begin
  select * into p from proposals where id = p_proposal for update;
  if not found or p.status <> 'accepted' then return null; end if;
  if p.signing_invoice_id is not null or p.invoice_series is not null then
    return jsonb_build_object('invoice', p.signing_invoice_id, 'series', p.invoice_series);
  end if;
  b := private.proposal_billing(p);
  if b is null then return null; end if;
  select * into ds from private.doc_settings where tenant_id = p.tenant_id;
  who := coalesce(p.accepted_name, p.contact_name); em := coalesce(p.accepted_email, p.contact_email);
  perform set_config('app.invoice_rpc', '1', true);

  -- 1. the paid invoice for what was collected at signing
  if coalesce(p_amount, 0) > 0 then
    lines := coalesce(b->'setup_lines', '[]'::jsonb);
    for g in select * from jsonb_array_elements(b->'groups') loop
      if (g->>'trial')::int = 0 then
        lines := lines || (select jsonb_agg(l || jsonb_build_object('name', (l->>'name') || case when g->>'cycle' = 'week' then ', first week' else ', first month' end))
                             from jsonb_array_elements(g->'lines') l);
      end if;
    end loop;
    select coalesce(sum((l->>'price')::numeric), 0) into gross from jsonb_array_elements(lines) l;
    if jsonb_array_length(lines) = 0 then lines := jsonb_build_array(jsonb_build_object('name', 'Paid at signing', 'qty', 1, 'price', p_amount, 'tax', 0)); gross := p_amount; end if;
    insert into invoices (tenant_id, company_id, person_id, proposal_id, owner_id, lines, discount, bill_to, lead_source, status, issue_date, sent_at, notes)
    values (p.tenant_id, p.company_id, p.contact_person_id, p.id, p.owner_id, lines, greatest(gross - p_amount, 0),
      jsonb_build_object('name', who, 'email', em), p.lead_source, 'sent', current_date, now(), 'Paid online when the proposal was accepted.')
    returning id into inv_id;
    insert into invoice_payments (tenant_id, invoice_id, amount, method, reference, status, source, stripe_session_id, note)
    values (p.tenant_id, inv_id, round(p_amount, 2), case when p_method = 'bank' then 'bank' else 'card' end, 'Stripe', 'posted', 'stripe', p_session, 'Paid at signing')
    on conflict (stripe_session_id) do nothing;
  end if;

  -- 2. a repeating series with autopay for each recurring part
  for g in select * from jsonb_array_elements(b->'groups') loop
    nxt := case when (g->>'trial')::int > 0 then current_date + (g->>'trial')::int
                else private.next_run(current_date, case when g->>'cycle' = 'week' then 'weekly' else 'monthly' end, null, null) end;
    insert into invoice_schedules (tenant_id, company_id, person_id, template_invoice_id, frequency, next_run_date, auto_send, end_type, autopay,
      runs_completed, lines, discount, bill_to, notes, terms, owner_id, divisions, due_days, stripe_customer_id, stripe_payment_method_id, pm_label, stripe_account, created_by)
    values (p.tenant_id, p.company_id, p.contact_person_id, inv_id, case when g->>'cycle' = 'week' then 'weekly' else 'monthly' end, nxt, true, 'never',
      true, 0, g->'lines', greatest((g->>'gross')::numeric - (g->>'net')::numeric, 0),
      jsonb_build_object('name', who, 'email', em), null, null, p.owner_id, '{}', coalesce(ds.due_days, 30),
      p_customer, p_pm, left(p_label, 60), null, p.owner_id)
    returning id into sid;
    series := series || jsonb_build_array(jsonb_build_object('id', sid, 'cycle', g->>'cycle', 'amount', g->'net', 'trial', (g->>'trial')::int, 'first', nxt));
  end loop;

  update proposals set signing_invoice_id = inv_id, invoice_series = series where id = p.id;
  perform set_config('app.invoice_rpc', '', true);
  insert into activities (company_id, type, created_by, body)
  values (p.company_id, 'note', p.owner_id, concat_ws(' ',
    case when inv_id is not null then format('Paid at signing: $%s, recorded as an invoice.', to_char(p_amount, 'FM999,999,990.00')) end,
    (select string_agg(format('Repeating invoice set up: $%s %s, first one %s%s.', to_char((s->>'amount')::numeric, 'FM999,999,990.00'),
        case when s->>'cycle' = 'week' then 'weekly' else 'monthly' end, to_char((s->>'first')::date, 'Mon FMDD, YYYY'),
        case when (s->>'trial')::int > 0 then format(' (after a %s day free trial)', s->>'trial') else '' end), ' ') from jsonb_array_elements(series) s),
    case when jsonb_array_length(series) > 0 then case when p_pm is not null then format('Autopay on %s.', coalesce(p_label, 'the saved card')) else 'No card was saved yet, so each one is emailed with a pay button, and paying it saves the card for autopay.' end end));
  return jsonb_build_object('invoice', inv_id, 'series', series);
end $$;
revoke execute on function private.proposal_billing(proposals) from public, anon, authenticated;
revoke execute on function public.proposal_paid_to_invoices(uuid, text, numeric, text, text, text, text) from public, anon, authenticated;
grant execute on function public.proposal_paid_to_invoices(uuid, text, numeric, text, text, text, text) to service_role;

-- "Make an invoice" on an accepted proposal opens the invoice made when it was paid instead of making a second one
create or replace function public.invoice_from_proposal(p_proposal uuid) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare p proposals; q jsonb; ls jsonb; out uuid; rate numeric;
begin
  if not private.can('invoices', 2) then raise exception 'Your role can''t make invoices'; end if;
  select * into p from proposals where id = p_proposal and tenant_id = private.current_tenant();
  if not found then raise exception 'Proposal not found'; end if;
  if p.status <> 'accepted' then raise exception 'Only an accepted proposal can be invoiced'; end if;
  if p.signing_invoice_id is not null and exists (select 1 from invoices where id = p.signing_invoice_id and status <> 'void') then return p.signing_invoice_id; end if;
  select quote into q from proposal_versions where proposal_id = p.id and version = p.accepted_version;
  rate := coalesce((select default_tax_rate from private.doc_settings where tenant_id = p.tenant_id), 0);
  select coalesce(jsonb_agg(jsonb_build_object('name', l->>'title', 'desc', coalesce(l->>'sub', ''), 'qty', 1, 'price', (l->>'setup')::numeric, 'tax', rate)), '[]'::jsonb) into ls
    from jsonb_array_elements(coalesce(q->'lines', '[]'::jsonb)) l where coalesce((l->>'ph')::int, 1) = 1 and coalesce((l->>'setup')::numeric, 0) > 0;
  if jsonb_array_length(ls) = 0 then
    select coalesce(jsonb_agg(jsonb_build_object('name', (l->>'title') || ', first month', 'desc', coalesce(l->>'sub', ''), 'qty', 1, 'price', (l->>'mo')::numeric, 'tax', rate)), '[]'::jsonb) into ls
      from jsonb_array_elements(coalesce(q->'lines', '[]'::jsonb)) l where coalesce((l->>'ph')::int, 1) = 1 and coalesce((l->>'mo')::numeric, 0) > 0;
  end if;
  insert into invoices (company_id, person_id, proposal_id, owner_id, lines, discount, deposit, bill_to, lead_source)
  values (p.company_id, p.contact_person_id, p.id, p.owner_id, ls, coalesce((q->'setup'->>'disc')::numeric, 0),
    case when p.pay_status = 'paid' and p.pay_version = p.accepted_version then coalesce(p.paid_amount, 0) else 0 end,
    jsonb_build_object('name', coalesce(p.accepted_name, p.contact_name), 'email', coalesce(p.accepted_email, p.contact_email)), p.lead_source)
  returning id into out;
  return out;
end $$;
