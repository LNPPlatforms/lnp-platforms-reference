-- 083a (Nov 3 voice call): recurring invoices, autopay with a card or bank saved in Stripe, overdue reminders and late fees.
-- A series (invoice_schedules, from 081a) keeps its own copy of the lines, so editing any invoice in the series and
-- saving the series updates the invoices that come next. Each run makes a new invoice on the series' date. It either goes
-- out by email on its own or waits as a draft in Review for someone to check (quantities that change, like LOGIC's
-- physician count). Autopay: the card or bank lives in Stripe; the CRM keeps only Stripe's ids and a label like
-- "Visa ending 4242". A failed charge is tried twice more, 3 days apart; each failure emails the client and shows the
-- account's admins in Review. Invoices not on autopay get reminder emails 3, 10 and 17 days after they're due.
-- Late fees are an account setting, off unless turned on. One daily job does all of it (invoice-cron, 8:07 am Central).

alter table public.invoice_schedules
  add column if not exists lines jsonb not null default '[]'::jsonb,
  add column if not exists discount numeric(12,2) not null default 0,
  add column if not exists bill_to jsonb not null default '{}'::jsonb,
  add column if not exists notes text,
  add column if not exists terms text,
  add column if not exists show_savings boolean,
  add column if not exists due_days integer check (due_days is null or due_days between 0 and 365),
  add column if not exists owner_id uuid,
  add column if not exists divisions uuid[] not null default '{}',
  add column if not exists last_invoice_id uuid,
  add column if not exists last_run_at timestamptz,
  add column if not exists pm_label text,
  add column if not exists stripe_account text;
comment on column public.invoice_schedules.hold_for_review is 'Unused: auto_send false means the new invoice waits in Review as a draft';
alter table public.invoice_schedules drop constraint if exists invoice_schedules_company_fk;
alter table public.invoice_schedules add constraint invoice_schedules_company_fk foreign key (company_id) references public.companies(id) on delete cascade;
create index if not exists invoice_schedules_due on public.invoice_schedules (next_run_date) where status = 'active';

alter table public.invoices
  add column if not exists reminders_sent integer not null default 0,
  add column if not exists autopay_failed_at timestamptz,
  add column if not exists autopay_error text,
  add column if not exists next_charge_at timestamptz,
  add column if not exists late_fee_added_at timestamptz,
  add column if not exists from_schedule_run boolean not null default false;
create index if not exists invoices_schedule on public.invoices (schedule_id) where schedule_id is not null;

alter table public.tenants
  add column if not exists reminders_on boolean not null default true,
  add column if not exists late_fee_kind text not null default 'flat' check (late_fee_kind in ('flat', 'percent')),
  add column if not exists late_fee_amount numeric(12,2) not null default 0 check (late_fee_amount >= 0),
  add column if not exists late_fee_days integer not null default 15 check (late_fee_days between 1 and 365);

-- the next date in a series
create or replace function private.next_run(d date, freq text, every int, unit text) returns date
language sql immutable set search_path = pg_catalog as $$
  select case freq
    when 'weekly' then d + 7
    when 'biweekly' then d + 14
    when 'monthly' then (d + interval '1 month')::date
    when 'quarterly' then (d + interval '3 months')::date
    when 'yearly' then (d + interval '1 year')::date
    when 'custom' then case unit when 'day' then d + greatest(every, 1)
                                 when 'week' then d + 7 * greatest(every, 1)
                                 when 'month' then (d + make_interval(months => greatest(every, 1)))::date
                                 else (d + make_interval(years => greatest(every, 1)))::date end
  end
$$;

-- what the invoice screen shows about a series
create or replace function private.schedule_json(s invoice_schedules) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('id', s.id, 'frequency', s.frequency, 'custom_every', s.custom_interval, 'custom_unit', s.custom_unit,
    'next_run_date', s.next_run_date, 'auto_send', s.auto_send, 'end_type', s.end_type, 'end_count', s.end_count, 'end_date', s.end_date,
    'runs_completed', s.runs_completed, 'autopay', s.autopay, 'card_saved', s.stripe_payment_method_id is not null, 'pm_label', s.pm_label,
    'status', s.status, 'template_invoice_id', s.template_invoice_id, 'last_run_at', s.last_run_at,
    'invoices', (select count(*) from invoices where schedule_id = s.id))
$$;

create or replace function public.invoice_schedule_get(p_invoice uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select private.schedule_json(s) from invoices i join invoice_schedules s on s.id = i.schedule_id
   where i.id = p_invoice and i.tenant_id = private.current_tenant() and private.is_internal() and private.can('invoices', 1)
$$;

-- start, change or stop a series from an invoice. The series takes this invoice's lines, customer, notes and terms.
create or replace function public.invoice_schedule_save(p_invoice uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare i invoices; s invoice_schedules; freq text := p->>'frequency'; nxt date := nullif(p->>'next_run_date', '')::date;
  et text := coalesce(nullif(p->>'end_type', ''), 'never'); ev int := nullif(p->>'custom_every', '')::int; eu text := nullif(p->>'custom_unit', '');
  ec int := nullif(p->>'end_count', '')::int; ed date := nullif(p->>'end_date', '')::date; ds private.doc_settings;
begin
  if not private.can('invoices', 2) then raise exception 'Your role can''t set up repeating invoices'; end if;
  select * into i from invoices where id = p_invoice and tenant_id = private.current_tenant() and private.in_scope('invoices', owner_id, divisions);
  if not found then raise exception 'Invoice not found'; end if;
  if i.status = 'void' then raise exception 'A void invoice can''t start a series'; end if;
  if coalesce(p->>'status', '') = 'ended' then
    update invoice_schedules set status = 'ended', updated_at = now() where id = i.schedule_id and tenant_id = i.tenant_id returning * into s;
    return case when s.id is null then null else private.schedule_json(s) end;
  end if;
  if freq is null or freq not in ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly', 'custom') then raise exception 'Pick how often it repeats'; end if;
  if freq = 'custom' and (ev is null or ev < 1 or ev > 365 or eu not in ('day', 'week', 'month', 'year')) then raise exception 'A custom schedule needs a number and a unit (every 10 days)'; end if;
  if freq <> 'custom' then ev := null; eu := null; end if;
  if nxt is null then raise exception 'Pick the date of the next invoice'; end if;
  if nxt < current_date then raise exception 'The next invoice date can''t be in the past'; end if;
  if et not in ('never', 'count', 'date') then et := 'never'; end if;
  if et = 'count' and (ec is null or ec < 1 or ec > 1000) then raise exception 'How many invoices in all? (1 to 1000)'; end if;
  if et = 'date' and (ed is null or ed < nxt) then raise exception 'The end date has to be on or after the next invoice date'; end if;
  if coalesce((p->>'autopay')::boolean, false) and private.pay_method(i.tenant_id) not in ('stripe', 'platform') then
    raise exception 'Autopay needs Stripe connected (Tools, Admin, Invoices and payments)';
  end if;
  select * into ds from private.doc_settings where tenant_id = i.tenant_id;
  if i.schedule_id is not null then
    update invoice_schedules set frequency = freq, custom_interval = ev, custom_unit = eu, next_run_date = nxt,
      auto_send = coalesce((p->>'auto_send')::boolean, false), end_type = et, end_count = case when et = 'count' then ec end,
      end_date = case when et = 'date' then ed end, autopay = coalesce((p->>'autopay')::boolean, false), status = 'active',
      company_id = i.company_id, person_id = i.person_id, lines = i.lines, discount = i.discount, bill_to = coalesce(i.bill_to, '{}'),
      notes = i.notes, terms = i.terms, show_savings = i.show_savings, owner_id = i.owner_id, divisions = coalesce(i.divisions, '{}'),
      due_days = greatest(0, coalesce(i.due_date - i.issue_date, ds.due_days, 30)), updated_at = now()
     where id = i.schedule_id and tenant_id = i.tenant_id returning * into s;
  end if;
  if s.id is null then
    insert into invoice_schedules (tenant_id, company_id, person_id, template_invoice_id, frequency, custom_interval, custom_unit, next_run_date,
      auto_send, end_type, end_count, end_date, autopay, runs_completed, lines, discount, bill_to, notes, terms, show_savings, owner_id, divisions, due_days)
    values (i.tenant_id, i.company_id, i.person_id, i.id, freq, ev, eu, nxt, coalesce((p->>'auto_send')::boolean, false), et,
      case when et = 'count' then ec end, case when et = 'date' then ed end, coalesce((p->>'autopay')::boolean, false), 1,
      i.lines, i.discount, coalesce(i.bill_to, '{}'), i.notes, i.terms, i.show_savings, i.owner_id, coalesce(i.divisions, '{}'),
      greatest(0, coalesce(i.due_date - i.issue_date, ds.due_days, 30)))
    returning * into s;
    perform set_config('app.invoice_rpc', '1', true);
    update invoices set schedule_id = s.id where id = i.id;
    perform set_config('app.invoice_rpc', '', true);
  end if;
  return private.schedule_json(s);
end $$;

-- make the invoices that are due. Runs inside invoice_cron_take; returns how many were made.
create or replace function private.invoice_schedule_run() returns int
language plpgsql security definer set search_path = public, private as $$
declare s invoice_schedules; n int := 0; new_id uuid; d date;
begin
  perform set_config('app.invoice_rpc', '1', true);
  for s in select * from invoice_schedules where status = 'active' and next_run_date <= current_date for update skip locked loop
    d := s.next_run_date;
    if (s.end_type = 'count' and s.runs_completed >= coalesce(s.end_count, 0)) or (s.end_type = 'date' and d > s.end_date)
       or not exists (select 1 from companies where id = s.company_id and archived_at is null) then
      update invoice_schedules set status = 'ended', updated_at = now() where id = s.id; continue;
    end if;
    if jsonb_array_length(s.lines) = 0 then update invoice_schedules set status = 'paused', updated_at = now() where id = s.id; continue; end if;
    insert into invoices (tenant_id, company_id, person_id, owner_id, divisions, lines, discount, bill_to, notes, terms, show_savings,
      issue_date, due_date, schedule_id, from_schedule_run, created_by)
    values (s.tenant_id, s.company_id, s.person_id, s.owner_id, s.divisions, s.lines, s.discount, s.bill_to, s.notes, s.terms, s.show_savings,
      d, d + coalesce(s.due_days, 30), s.id, true, s.created_by)
    returning id into new_id;
    n := n + 1;
    update invoice_schedules set runs_completed = runs_completed + 1, last_invoice_id = new_id, last_run_at = now(),
      next_run_date = private.next_run(d, s.frequency, s.custom_interval, s.custom_unit),
      status = case when (s.end_type = 'count' and s.runs_completed + 1 >= coalesce(s.end_count, 0))
                      or (s.end_type = 'date' and private.next_run(d, s.frequency, s.custom_interval, s.custom_unit) > s.end_date) then 'ended' else 'active' end,
      updated_at = now()
     where id = s.id;
  end loop;
  perform set_config('app.invoice_rpc', '', true);
  return n;
end $$;

-- late fees: once per invoice, when it's this many days past due and the account has them on
create or replace function private.invoice_late_fees() returns int
language plpgsql security definer set search_path = public, private as $$
declare r record; n int := 0; fee numeric;
begin
  perform set_config('app.invoice_rpc', '1', true);
  for r in select i.*, t.late_fee_kind, t.late_fee_amount from invoices i join tenants t on t.id = i.tenant_id
            where t.late_fees_enabled and t.late_fee_amount > 0 and i.status in ('sent', 'partial') and i.balance > 0
              and i.late_fee_added_at is null and i.due_date + t.late_fee_days <= current_date loop
    fee := case when r.late_fee_kind = 'percent' then round(r.balance * least(r.late_fee_amount, 100) / 100, 2) else r.late_fee_amount end;
    if fee <= 0 then continue; end if;
    update invoices set lines = lines || jsonb_build_array(jsonb_build_object('name', 'Late fee', 'desc',
        case when r.late_fee_kind = 'percent' then trim(to_char(r.late_fee_amount, 'FM990.##')) || '% of the past due balance' else 'Past due' end, 'qty', 1, 'price', fee, 'tax', 0)),
      late_fee_added_at = now() where id = r.id;
    n := n + 1;
  end loop;
  perform set_config('app.invoice_rpc', '', true);
  return n;
end $$;

create or replace function private.cron_secret_ok(p_secret text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select p_secret is not null and p_secret = (select hook_secret from private.push_keys where id = 1)
$$;

-- what invoice-cron does today: makes the due invoices and late fees, then hands back the charges, emails and reminders
create or replace function public.invoice_cron_take(p_secret text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare made int; fees int;
begin
  if not private.cron_secret_ok(p_secret) then raise exception 'Not allowed'; end if;
  made := private.invoice_schedule_run();
  fees := private.invoice_late_fees();
  return jsonb_build_object('made', made, 'late_fees', fees,
    -- autopay: the series has a saved card or bank; the invoice is out (or new and set to go out on its own); 3 tries
    'charges', (select coalesce(jsonb_agg(private.invoice_doc(i) || jsonb_build_object('id', i.id, 'tenant_id', i.tenant_id, 'attempt', i.payment_attempts + 1,
        'to', coalesce(nullif(i.bill_to->>'email', ''), (select main_email from companies where id = i.company_id)),
        'customer', s.stripe_customer_id, 'pm', s.stripe_payment_method_id, 'pm_label', s.pm_label, 'stripe_account', s.stripe_account,
        'method', private.pay_method(i.tenant_id), 'acct', (select stripe_account_id from private.pay_processors where tenant_id = i.tenant_id and stripe_ready))), '[]'::jsonb)
      from invoices i join invoice_schedules s on s.id = i.schedule_id
      where s.autopay and s.stripe_payment_method_id is not null and i.balance > 0 and i.payment_attempts < 3
        and (i.status in ('sent', 'partial') or (i.status = 'draft' and i.from_schedule_run and s.auto_send))
        and coalesce(i.next_charge_at, now()) <= now() and i.issue_date <= current_date
        and not exists (select 1 from invoice_payments x where x.invoice_id = i.id and x.status = 'pending')),
    -- new invoices from a series set to send on their own
    'emails', (select coalesce(jsonb_agg(private.invoice_doc(i) || jsonb_build_object('id', i.id, 'tenant_id', i.tenant_id,
        'to', coalesce(nullif(i.bill_to->>'email', ''), (select personal_email from people where id = i.person_id), (select main_email from companies where id = i.company_id)),
        'pay_method', private.pay_method(i.tenant_id), 'autopay', s.autopay and s.stripe_payment_method_id is not null, 'pm_label', s.pm_label)), '[]'::jsonb)
      from invoices i join invoice_schedules s on s.id = i.schedule_id
      where i.status = 'draft' and i.from_schedule_run and s.auto_send and i.sent_at is null and i.issue_date <= current_date),
    -- reminders: out, not paid, past due 3, 10 and 17 days, not being paid by autopay
    'reminders', (select coalesce(jsonb_agg(private.invoice_doc(i) || jsonb_build_object('id', i.id, 'tenant_id', i.tenant_id, 'days_late', current_date - i.due_date,
        'to', coalesce(nullif(i.bill_to->>'email', ''), nullif(i.last_emailed_to, ''), (select main_email from companies where id = i.company_id)),
        'pay_method', private.pay_method(i.tenant_id))), '[]'::jsonb)
      from invoices i join tenants t on t.id = i.tenant_id left join invoice_schedules s on s.id = i.schedule_id
      where t.reminders_on and i.status in ('sent', 'partial') and i.balance > 0 and i.due_date is not null and i.reminders_sent < 3
        and current_date - i.due_date >= 3 + 7 * i.reminders_sent
        and (i.last_reminder_at is null or i.last_reminder_at < now() - interval '6 days')
        and not (coalesce(s.autopay, false) and s.stripe_payment_method_id is not null and i.payment_attempts < 3)));
end $$;

-- invoice-cron reports back what happened to each item
create or replace function public.invoice_cron_done(p_secret text, p jsonb) returns void
language plpgsql security definer set search_path = public, private as $$
declare inv invoices; k text := p->>'kind';
begin
  if not private.cron_secret_ok(p_secret) then raise exception 'Not allowed'; end if;
  select * into inv from invoices where id = (p->>'id')::uuid;
  if not found then return; end if;
  perform set_config('app.invoice_rpc', '1', true);
  if k = 'charged' then
    insert into invoice_payments (tenant_id, invoice_id, amount, method, reference, status, source, stripe_session_id, note)
    values (inv.tenant_id, inv.id, round((p->>'amount')::numeric, 2), case when p->>'method' = 'bank' then 'bank' else 'card' end,
      coalesce(p->>'label', 'Autopay'), 'posted', 'stripe', p->>'ref', 'Autopay')
    on conflict (stripe_session_id) do nothing;
    update invoices set autopay_failed_at = null, autopay_error = null, next_charge_at = null,
      status = case when status = 'draft' then 'sent' else status end, sent_at = coalesce(sent_at, now()) where id = inv.id;
  elsif k = 'processing' then
    update invoices set payment_attempts = payment_attempts + 1, next_charge_at = now() + interval '10 days',
      status = case when status = 'draft' then 'sent' else status end, sent_at = coalesce(sent_at, now()) where id = inv.id;
  elsif k = 'charge_failed' then
    update invoices set payment_attempts = payment_attempts + 1, autopay_failed_at = now(), autopay_error = left(p->>'error', 300),
      next_charge_at = now() + interval '3 days', status = case when status = 'draft' then 'sent' else status end, sent_at = coalesce(sent_at, now())
     where id = inv.id;
    perform private.emit(inv.tenant_id, 'invoice_autopay_failed', format('Autopay failed on invoice %s: %s', inv.number, left(p->>'error', 200)),
      inv.person_id, inv.company_id, jsonb_build_object('invoice_id', inv.id, 'number', inv.number, 'attempt', inv.payment_attempts + 1));
  elsif k = 'emailed' then
    update invoices set status = case when status = 'draft' then 'sent' else status end, sent_at = now(),
      last_emailed_to = coalesce(nullif(p->>'to', ''), last_emailed_to) where id = inv.id;
  elsif k = 'reminded' then
    update invoices set reminders_sent = reminders_sent + 1, last_reminder_at = now() where id = inv.id;
  end if;
  perform set_config('app.invoice_rpc', '', true);
end $$;

-- a Stripe payment that was still clearing (bank) settled or bounced (stripe-webhook, payment_intent events)
create or replace function public.invoice_autopay_settled(p_invoice uuid, p_ref text, p_ok boolean, p_amount numeric, p_error text) returns void
language plpgsql security definer set search_path = public, private as $$
declare inv invoices;
begin
  select * into inv from invoices where id = p_invoice;
  if not found then return; end if;
  if p_ok then
    perform public.invoice_stripe_paid(p_invoice, p_ref, p_amount, 'bank');
  else
    perform set_config('app.invoice_rpc', '1', true);
    update invoices set autopay_failed_at = now(), autopay_error = left(p_error, 300), next_charge_at = now() + interval '3 days' where id = p_invoice;
    perform set_config('app.invoice_rpc', '', true);
    perform private.emit(inv.tenant_id, 'invoice_autopay_failed', format('Autopay failed on invoice %s: %s', inv.number, left(p_error, 200)),
      inv.person_id, inv.company_id, jsonb_build_object('invoice_id', inv.id, 'number', inv.number));
  end if;
end $$;

-- the customer saved a card or bank for their series (stripe-webhook and invoice-pay, after Stripe Checkout)
create or replace function public.invoice_autopay_card_saved(p_invoice uuid, p_customer text, p_pm text, p_label text, p_account text) returns boolean
language plpgsql security definer set search_path = public, private as $$
declare sid uuid;
begin
  select schedule_id into sid from invoices where id = p_invoice;
  if sid is null or p_customer is null or p_pm is null then return false; end if;
  update invoice_schedules set stripe_customer_id = p_customer, stripe_payment_method_id = p_pm, pm_label = left(p_label, 60),
    stripe_account = p_account, updated_at = now() where id = sid;
  perform set_config('app.invoice_rpc', '1', true);
  update invoices set payment_attempts = 0, autopay_failed_at = null, autopay_error = null, next_charge_at = null
   where schedule_id = sid and status in ('sent', 'partial') and autopay_failed_at is not null;
  perform set_config('app.invoice_rpc', '', true);
  return true;
end $$;

-- invoice-pay: what it needs to know about a series (whether to offer saving the card, and where the customer lives)
create or replace function public.invoice_pay_info(p_token text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('id', i.id, 'tenant_id', i.tenant_id, 'number', coalesce(d.prefix, '') || i.number, 'status', i.status, 'balance', i.balance,
    'org', c.name, 'email', coalesce(nullif(i.bill_to->>'email', ''), c.main_email), 'session', i.stripe_session_id,
    'method', private.pay_method(i.tenant_id), 'link', d.pay_link, 'stripe_account', pp.stripe_account_id, 'account', private.doc_brand(i.tenant_id)->>'name',
    'autopay', coalesce(s.autopay and s.status <> 'ended', false), 'customer', s.stripe_customer_id, 'card_saved', s.stripe_payment_method_id is not null,
    'customer_account', s.stripe_account)
  from invoices i join companies c on c.id = i.company_id left join private.doc_settings d on d.tenant_id = i.tenant_id
  left join private.pay_processors pp on pp.tenant_id = i.tenant_id and pp.stripe_ready
  left join invoice_schedules s on s.id = i.schedule_id
  where i.share_token = p_token and length(p_token) >= 32
$$;

-- the customer's page: whether this invoice is on autopay and with what (never the Stripe ids)
create or replace function private.invoice_autopay_view(i invoices) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when s.id is not null and s.autopay and s.status <> 'ended' and private.pay_method(i.tenant_id) in ('stripe', 'platform') then
    jsonb_build_object('on', true, 'saved', s.stripe_payment_method_id is not null, 'label', s.pm_label,
      'failed', i.autopay_failed_at is not null and i.status in ('sent', 'partial')) end
  from invoice_schedules s where s.id = i.schedule_id
$$;

-- Review: series invoices waiting for someone to check them, and autopay that failed (its own name: invoice_review_list is payments to approve, 069d)
create or replace function public.invoice_series_review() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.is_internal() and private.can('invoices', 2) then jsonb_build_object(
    'drafts', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'number', coalesce(d.prefix, '') || i.number, 'org', c.name, 'total', i.total,
        'issue_date', i.issue_date) order by i.issue_date), '[]'::jsonb)
      from invoices i join invoice_schedules s on s.id = i.schedule_id join companies c on c.id = i.company_id left join private.doc_settings d on d.tenant_id = i.tenant_id
      where i.tenant_id = private.current_tenant() and i.status = 'draft' and i.from_schedule_run and not s.auto_send
        and private.in_scope('invoices', i.owner_id, i.divisions)),
    'failed', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'number', coalesce(d.prefix, '') || i.number, 'org', c.name, 'balance', i.balance,
        'error', i.autopay_error, 'attempts', i.payment_attempts, 'at', i.autopay_failed_at) order by i.autopay_failed_at desc), '[]'::jsonb)
      from invoices i join companies c on c.id = i.company_id left join private.doc_settings d on d.tenant_id = i.tenant_id
      where i.tenant_id = private.current_tenant() and i.autopay_failed_at is not null and i.status in ('sent', 'partial')
        and private.in_scope('invoices', i.owner_id, i.divisions))) end
$$;

-- reminders and late fees (Invoices and payments)
create or replace function public.invoice_collect_settings() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('reminders_on', reminders_on, 'late_fees_enabled', late_fees_enabled, 'late_fee_kind', late_fee_kind,
    'late_fee_amount', late_fee_amount, 'late_fee_days', late_fee_days) from tenants where id = private.current_tenant() and private.is_internal()
$$;
create or replace function public.invoice_collect_settings_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.can_doc_settings() then raise exception 'Your role can''t change invoice settings'; end if;
  if coalesce(p->>'late_fee_kind', 'flat') not in ('flat', 'percent') then raise exception 'Late fee is a flat amount or a percent'; end if;
  if coalesce((p->>'late_fee_amount')::numeric, 0) < 0 or (p->>'late_fee_kind' = 'percent' and coalesce((p->>'late_fee_amount')::numeric, 0) > 100) then raise exception 'Check the late fee amount'; end if;
  update tenants set reminders_on = coalesce((p->>'reminders_on')::boolean, true), late_fees_enabled = coalesce((p->>'late_fees_enabled')::boolean, false),
    late_fee_kind = coalesce(p->>'late_fee_kind', 'flat'), late_fee_amount = coalesce((p->>'late_fee_amount')::numeric, 0),
    late_fee_days = least(365, greatest(1, coalesce((p->>'late_fee_days')::int, 15)))
   where id = private.current_tenant();
  return public.invoice_collect_settings();
end $$;

-- service only: the cron and Stripe paths; the screens get read functions
revoke execute on function public.invoice_cron_take(text), public.invoice_cron_done(text, jsonb), public.invoice_autopay_settled(uuid, text, boolean, numeric, text),
  public.invoice_autopay_card_saved(uuid, text, text, text, text), public.invoice_pay_info(text) from public, anon, authenticated;
revoke execute on function private.next_run(date, text, int, text), private.schedule_json(invoice_schedules), private.invoice_schedule_run(), private.invoice_late_fees(),
  private.cron_secret_ok(text), private.invoice_autopay_view(invoices) from public, anon, authenticated;
revoke execute on function public.invoice_schedule_get(uuid), public.invoice_schedule_save(uuid, jsonb), public.invoice_series_review(),
  public.invoice_collect_settings(), public.invoice_collect_settings_set(jsonb) from public, anon;
grant execute on function public.invoice_schedule_get(uuid), public.invoice_schedule_save(uuid, jsonb), public.invoice_series_review(),
  public.invoice_collect_settings(), public.invoice_collect_settings_set(jsonb) to authenticated;


-- the customer's page, email and portal also learn whether the invoice is on autopay (083a)
create or replace function private.invoice_doc(i invoices) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('kind', 'invoice', 'title', 'Invoice', 'id', i.id, 'token', i.share_token,
    'number', coalesce(d.prefix, '') || i.number, 'status', i.status, 'issue_date', i.issue_date, 'due_date', i.due_date, 'po', i.po,
    'customer', jsonb_build_object('name', coalesce(nullif(i.bill_to->>'name', ''), c.name), 'org', c.name,
       'address', coalesce(nullif(i.bill_to->>'address', ''), nullif(concat_ws(', ', nullif(c.address, ''), nullif(c.city, ''), nullif(trim(concat_ws(' ', c.state, c.zip)), '')), '')),
       'email', coalesce(nullif(i.bill_to->>'email', ''), c.main_email), 'phone', c.main_phone),
    'show_code', coalesce(d.show_item_code, false), 'show_tax', coalesce(d.show_tax, false),
    'lines', (select coalesce(jsonb_agg(l - 'job_id' - 'reason' - 'product_id'
                - case when coalesce(d.show_item_code, false) then 'x' else 'code' end
                - case when private.invoice_shows_savings(i) then 'x' else 'retail' end), '[]'::jsonb) from jsonb_array_elements(i.lines) l),
    'savings', case when private.invoice_shows_savings(i) then
                 (select coalesce(sum(round(((l->>'retail')::numeric - (l->>'price')::numeric) * (l->>'qty')::numeric, 2)), 0)
                    from jsonb_array_elements(i.lines) l where jsonb_typeof(l->'retail') = 'number') + coalesce(i.discount, 0) else 0 end,
    'subtotal', i.subtotal, 'discount', i.discount, 'tax_total', i.tax_total, 'total', i.total, 'deposit', i.deposit, 'paid_total', i.paid_total, 'balance', i.balance,
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('paid_on', x.paid_on, 'method', x.method, 'amount', x.amount, 'reference', x.reference) order by x.paid_on, x.created_at), '[]'::jsonb)
                   from invoice_payments x where x.invoice_id = i.id and x.status = 'posted'),
    'notes', i.notes, 'terms', i.terms, 'pay_instructions', d.pay_instructions,
    'pay', case when i.status in ('sent', 'partial') and i.balance > 0 then jsonb_build_object('method', private.pay_method(i.tenant_id),
             'link', case when private.pay_method(i.tenant_id) = 'link' then d.pay_link end) end,
    'brand', private.doc_brand(i.tenant_id), 'autopay', private.invoice_autopay_view(i),
    'pictures', (select coalesce(jsonb_agg(jsonb_build_object('url', p->>'url', 'title', coalesce(p->>'title', ''))), '[]'::jsonb)
                   from jsonb_array_elements(coalesce(i.pictures, '[]'::jsonb)) p where jsonb_typeof(p) = 'object' and coalesce(p->>'url', '') <> ''))
  from companies c left join private.doc_settings d on d.tenant_id = i.tenant_id where c.id = i.company_id
$$;

-- the daily job: 8:07 am Central (14:07 UTC). invoice-cron does the charges and emails with the shared hook secret.
create or replace function private.invoice_cron_kick() returns void
language plpgsql security definer set search_path = public, private as $$
declare s text;
begin
  select hook_secret into s from private.push_keys where id = 1;
  perform net.http_post(url := 'https://stfnpzqymjlxpainmgoo.supabase.co/functions/v1/invoice-cron',
    body := jsonb_build_object('secret', s), headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 120000);
end $$;
revoke execute on function private.invoice_cron_kick() from public, anon, authenticated;
do $$ begin perform cron.unschedule('invoice-daily'); exception when others then null; end $$;
select cron.schedule('invoice-daily', '7 14 * * *', $$select private.invoice_cron_kick()$$);

-- the server's own key (edge functions) still needs these after the revokes above
grant execute on function public.invoice_cron_take(text), public.invoice_cron_done(text, jsonb), public.invoice_autopay_settled(uuid, text, boolean, numeric, text),
  public.invoice_autopay_card_saved(uuid, text, text, text, text), public.invoice_pay_info(text) to service_role;
