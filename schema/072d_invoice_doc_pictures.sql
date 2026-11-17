-- 072d: the customer's document shows the invoice's pictures (the measured map) between the lines and the notes.
create or replace function private.invoice_doc(i public.invoices) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('kind', 'invoice', 'title', 'Invoice', 'id', i.id, 'token', i.share_token,
    'number', coalesce(d.prefix, '') || i.number, 'status', i.status, 'issue_date', i.issue_date, 'due_date', i.due_date, 'po', i.po,
    'customer', jsonb_build_object('name', coalesce(nullif(i.bill_to->>'name', ''), c.name), 'org', c.name,
       'address', coalesce(nullif(i.bill_to->>'address', ''), nullif(concat_ws(', ', nullif(c.address, ''), nullif(c.city, ''), nullif(trim(concat_ws(' ', c.state, c.zip)), '')), '')),
       'email', coalesce(nullif(i.bill_to->>'email', ''), c.main_email), 'phone', c.main_phone),
    'show_code', coalesce(d.show_item_code, false), 'show_tax', coalesce(d.show_tax, false),
    'lines', (select coalesce(jsonb_agg(l - 'job_id' - case when coalesce(d.show_item_code, false) then 'x' else 'code' end), '[]'::jsonb) from jsonb_array_elements(i.lines) l),
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
revoke execute on function private.invoice_doc(public.invoices) from public;
