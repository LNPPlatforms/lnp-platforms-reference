-- 081c: invoice lines remember the saved product they came from and its retail price. When the price on the line is
-- lowered, the retail stays on the line and a reason is kept for the team only. The customer sees the retail crossed
-- out next to the new price and a "You saved" total, unless the account (tenants.show_savings_default) or the invoice
-- (invoices.show_savings) turns that off. The reason never leaves the CRM.

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
  -- a lowered price needs a reason, so the team knows why later
  if exists (select 1 from jsonb_array_elements(new.lines) l
              where private.num_or(l->>'retail', 0) > private.num_or(l->>'price', 0) and length(trim(coalesce(l->>'reason', ''))) = 0) then
    raise exception 'Add a reason for each price you lowered (only your team sees it)';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('code', left(trim(coalesce(l->>'code', '')), 40), 'name', left(trim(l->>'name'), 200), 'desc', left(coalesce(l->>'desc', ''), 2000),
      'qty', q, 'price', pr, 'tax', tx, 'total', round(q * pr, 2), 'tax_amt', round(round(q * pr, 2) * tx / 100, 2), 'job_id', l->'job_id',
      'product_id', case when coalesce(l->>'product_id', '') ~ '^[0-9a-f-]{36}$' then l->'product_id' end,
      'unit', nullif(left(trim(coalesce(l->>'unit', '')), 20), ''),
      'retail', case when rt > pr then rt end,
      'reason', case when rt > pr then nullif(left(trim(coalesce(l->>'reason', '')), 300), '') end) order by o), '[]'::jsonb)
    into new.lines
    from jsonb_array_elements(new.lines) with ordinality x(l, o),
    lateral (select private.num_or(l->>'qty', 1) q, private.num_or(l->>'price', 0) pr, least(100, greatest(0, private.num_or(l->>'tax', 0))) tx,
                    private.num_or(l->>'retail', 0) rt) v;
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

-- whether the customer sees the crossed out retail and the savings total
create or replace function private.invoice_shows_savings(i invoices) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce(i.show_savings, (select show_savings_default from tenants where id = i.tenant_id), true)
$$;
revoke execute on function private.invoice_shows_savings(invoices) from public, anon;

-- what the customer sees: never the reason; the retail and savings only when shown
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
    'brand', private.doc_brand(i.tenant_id),
    'pictures', (select coalesce(jsonb_agg(jsonb_build_object('url', p->>'url', 'title', coalesce(p->>'title', ''))), '[]'::jsonb)
                   from jsonb_array_elements(coalesce(i.pictures, '[]'::jsonb)) p where jsonb_typeof(p) = 'object' and coalesce(p->>'url', '') <> ''))
  from companies c left join private.doc_settings d on d.tenant_id = i.tenant_id where c.id = i.company_id
$$;

-- the account's default for showing savings, for the invoice editor and the settings screen
create or replace function public.invoice_savings_default() returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select show_savings_default from tenants where id = private.current_tenant()), true) where private.is_internal()
$$;
create or replace function public.invoice_savings_default_set(p_on boolean) returns boolean
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.can_doc_settings() then raise exception 'Your role can''t change invoice settings'; end if;
  update tenants set show_savings_default = coalesce(p_on, true) where id = private.current_tenant();
  return coalesce(p_on, true);
end $$;
revoke execute on function public.invoice_savings_default(), public.invoice_savings_default_set(boolean) from public, anon;
grant execute on function public.invoice_savings_default(), public.invoice_savings_default_set(boolean) to authenticated;
