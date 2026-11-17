-- 069c: invoice math, numbers, status and guards. Tax is figured per line; a discount lowers the taxed amount evenly.
-- Payments received only count once posted (manual ones by someone who can approve, or after Review; Stripe ones right away).
create or replace function private.num_or(t text, d numeric) returns numeric
language sql immutable set search_path = pg_catalog as $$
  select case when trim(coalesce(t, '')) ~ '^-?\d{1,9}(\.\d{1,4})?$' then trim(t)::numeric else d end
$$;

create or replace function private.invoice_calc() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare rpc boolean := coalesce(current_setting('app.invoice_rpc', true), '') = '1' or auth.uid() is null;
  ds private.doc_settings; n int; sub numeric; disc numeric; tax numeric; paid numeric;
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.tenant_id := private.current_tenant(); end if;
    insert into private.doc_settings (tenant_id) values (new.tenant_id) on conflict do nothing;
    update private.doc_settings set next_number = greatest(next_number, coalesce((select max(number) from invoices where tenant_id = new.tenant_id), 0) + 1) + 1
     where tenant_id = new.tenant_id returning * into ds;
    new.number := ds.next_number - 1;
    new.due_date := coalesce(new.due_date, new.issue_date + ds.due_days);
    new.terms := coalesce(new.terms, ds.terms); new.notes := coalesce(new.notes, ds.notes);
    if not exists (select 1 from companies where id = new.company_id and tenant_id = new.tenant_id) then raise exception 'Organization not found'; end if;
    new.lead_source := coalesce(nullif(new.lead_source, ''), (select lead_source_channel from companies where id = new.company_id),
                                (select lead_source from people where id = new.person_id));
    if not rpc then new.status := 'draft'; new.sent_at := null; new.paid_at := null; new.stripe_session_id := null; new.voided_at := null; end if;
  else
    new.tenant_id := old.tenant_id; new.number := old.number; new.share_token := old.share_token; new.created_by := old.created_by;
    if not rpc then
      new.lead_source := old.lead_source; new.paid_at := old.paid_at; new.stripe_session_id := old.stripe_session_id;
      new.sent_at := old.sent_at; new.last_emailed_to := old.last_emailed_to;
      if old.status in ('paid', 'void') and (new.lines is distinct from old.lines or new.discount <> old.discount or new.deposit <> old.deposit or new.company_id <> old.company_id) then
        raise exception 'This invoice is % and locked', old.status;
      end if;
      if old.status = 'void' and new.status <> 'void' then raise exception 'A void invoice stays void. Make a new one.'; end if;
      if new.status = 'void' and old.status <> 'void' then
        if not private.can('invoices', 3) then raise exception 'Your role can''t void invoices'; end if;
        if exists (select 1 from invoice_payments where invoice_id = new.id and status = 'posted') then raise exception 'Remove the payments on it before voiding it'; end if;
      elsif new.status not in ('draft', 'sent') then new.status := old.status;
      end if;
      if not private.can('invoices', 3) and new.owner_id is distinct from old.owner_id then raise exception 'Your role can''t reassign invoices'; end if;
    end if;
  end if;
  if jsonb_typeof(new.lines) <> 'array' then new.lines := '[]'::jsonb; end if;
  n := jsonb_array_length(new.lines);
  if n > 200 then raise exception 'An invoice can have up to 200 lines'; end if;
  if exists (select 1 from jsonb_array_elements(new.lines) l where length(trim(coalesce(l->>'name', ''))) = 0) then raise exception 'Every line needs a name'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('code', left(trim(coalesce(l->>'code', '')), 40), 'name', left(trim(l->>'name'), 200), 'desc', left(coalesce(l->>'desc', ''), 2000),
      'qty', q, 'price', pr, 'tax', tx, 'total', round(q * pr, 2), 'tax_amt', round(round(q * pr, 2) * tx / 100, 2), 'job_id', l->'job_id') order by o), '[]'::jsonb)
    into new.lines
    from jsonb_array_elements(new.lines) with ordinality x(l, o),
    lateral (select private.num_or(l->>'qty', 1) q, private.num_or(l->>'price', 0) pr, least(100, greatest(0, private.num_or(l->>'tax', 0))) tx) v;
  select coalesce(sum((l->>'total')::numeric), 0), coalesce(sum((l->>'tax_amt')::numeric), 0) into sub, tax from jsonb_array_elements(new.lines) l;
  disc := least(coalesce(new.discount, 0), greatest(sub, 0));
  new.discount := disc;
  new.subtotal := sub;
  new.tax_total := case when sub > 0 then round(tax * (sub - disc) / sub, 2) else round(tax, 2) end;
  new.total := sub - disc + new.tax_total;
  new.deposit := least(greatest(coalesce(new.deposit, 0), 0), greatest(new.total, 0));
  select coalesce(sum(amount), 0) into paid from invoice_payments where invoice_id = new.id and status = 'posted';
  new.paid_total := paid;
  new.balance := new.total - coalesce(new.deposit, 0) - paid;
  if new.status <> 'void' and (new.status <> 'draft' or paid > 0) then
    new.status := case when new.total > 0 and new.balance <= 0 and (paid + new.deposit) > 0 then 'paid'
                       when (paid + new.deposit) > 0 then 'partial'
                       when new.status in ('paid', 'partial') then 'sent' else new.status end;
  end if;
  if new.status = 'paid' then new.paid_at := coalesce(new.paid_at, now()); elsif new.status <> 'void' then new.paid_at := null; end if;
  if new.status = 'void' then new.voided_at := coalesce(new.voided_at, now()); end if;
  return new;
end $$;
create trigger invoice_calc before insert or update on public.invoices for each row execute function private.invoice_calc();

-- after: the timeline hears about payments; voiding frees the jobs on it to be billed again
create or replace function private.invoice_after() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status <> 'paid') then
    perform private.emit(new.tenant_id, 'invoice_paid', format('Invoice %s paid: $%s', new.number, to_char(new.total, 'FM999,999,990.00')),
      new.person_id, new.company_id, jsonb_build_object('invoice_id', new.id, 'number', new.number, 'total', new.total, 'lead_source', new.lead_source));
  end if;
  if tg_op = 'UPDATE' and new.status = 'void' and old.status <> 'void' then
    update jobs set invoice_id = null, billed_at = null where invoice_id = new.id;
  end if;
  return null;
end $$;
create trigger invoice_after after insert or update on public.invoices for each row execute function private.invoice_after();

-- a payment added, approved or removed refigures its invoice
create or replace function private.invoice_payment_after() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  perform set_config('app.invoice_rpc', '1', true);
  update invoices set updated_at = now() where id = new.invoice_id;
  perform set_config('app.invoice_rpc', '', true);
  return null;
end $$;
create trigger invoice_payment_after after insert or update on public.invoice_payments for each row execute function private.invoice_payment_after();

-- deals and accepted proposals keep the lead source of their organization (or person)
create or replace function private.deal_lead_source() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.lead_source is null then new.lead_source := (select lead_source_channel from companies where id = new.company_id); end if;
  return new;
end $$;
create trigger deal_lead_source before insert or update on public.opportunities for each row execute function private.deal_lead_source();

create or replace function private.proposal_lead_source() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' and new.lead_source is null then
    new.lead_source := coalesce((select lead_source_channel from companies where id = new.company_id), (select lead_source from people where id = new.contact_person_id));
  end if;
  return new;
end $$;
create trigger proposal_lead_source before update on public.proposals for each row execute function private.proposal_lead_source();
update public.opportunities o set lead_source = c.lead_source_channel from public.companies c where c.id = o.company_id and o.lead_source is null and c.lead_source_channel is not null;
select set_config('app.proposal_rpc', '1', true);
update public.proposals p set lead_source = c.lead_source_channel from public.companies c where c.id = p.company_id and p.status = 'accepted' and p.lead_source is null and c.lead_source_channel is not null;
revoke execute on function private.invoice_calc(), private.invoice_after(), private.invoice_payment_after(), private.deal_lead_source(), private.proposal_lead_source() from public, anon, authenticated;
