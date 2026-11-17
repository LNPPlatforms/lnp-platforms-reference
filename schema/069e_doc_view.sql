-- 069e: the shared document (estimate, proposal, invoice) as the customer sees it, and what the email and pay functions read.
-- Branding comes from the brand kit: wide logo, else the default logo, else the company name in bold; primary color for the line.
create or replace function private.doc_brand(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object(
    'name', coalesce(nullif(trim(d.company->>'name'), ''), t.name),
    'address', nullif(trim(d.company->>'address'), ''), 'phone', nullif(trim(d.company->>'phone'), ''), 'email', nullif(trim(d.company->>'email'), ''),
    'logo', coalesce(nullif(b.logos->>'wide', ''), case when b.logos->>'default' ~ '^https?://' then b.logos->>'default' else nullif(b.logos->>(b.logos->>'default'), '') end),
    'color', coalesce((select c->>'hex' from jsonb_array_elements(coalesce(b.colors, '[]'::jsonb)) c where lower(c->>'name') like 'primary%' and c->>'hex' ~* '^#[0-9a-f]{6}$' limit 1),
                      case when b.colors->0->>'hex' ~* '^#[0-9a-f]{6}$' then b.colors->0->>'hex' end, '#1A2A52'))
  from tenants t left join private.doc_settings d on d.tenant_id = t.id left join brand_kits b on b.tenant_id = t.id where t.id = p_tenant
$$;

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
    'brand', private.doc_brand(i.tenant_id))
  from companies c left join private.doc_settings d on d.tenant_id = i.tenant_id where c.id = i.company_id
$$;

-- the customer's link (/doc/?t=...): an invoice, or a proposal in the same layout. Drafts show only to the account's own team.
create or replace function public.doc_view(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare i invoices; p proposals; c record; lbl text;
begin
  if p_token is null or length(p_token) < 32 then return null; end if;
  select * into i from invoices where share_token = p_token;
  if found then
    if i.status = 'draft' and not (private.is_internal() and i.tenant_id = private.current_tenant()) then return null; end if;
    return private.invoice_doc(i);
  end if;
  select * into p from proposals where share_token = p_token;
  if not found then return null; end if;
  if p.status = 'draft' and not (private.is_internal() and p.tenant_id = private.current_tenant()) then return null; end if;
  select * into c from companies where id = p.company_id;
  lbl := coalesce(nullif((select settings->'labels'->'proposal'->>'one' from account_settings where tenant_id = p.tenant_id), ''), 'Proposal');
  return jsonb_build_object('kind', 'proposal', 'title', lbl, 'token', p.share_token, 'number', p.version, 'issue_date', coalesce(p.sent_at, p.created_at)::date,
    'expires_at', p.expires_at, 'status', p.status,
    'customer', jsonb_build_object('name', coalesce(p.contact_name, c.name), 'org', c.name, 'email', p.contact_email,
       'address', nullif(concat_ws(', ', nullif(c.address, ''), nullif(c.city, ''), nullif(trim(concat_ws(' ', c.state, c.zip)), '')), '')),
    'view', public.proposal_view(p_token, null), 'brand', private.doc_brand(p.tenant_id));
end $$;
revoke execute on function public.doc_view(text), private.doc_brand(uuid), private.invoice_doc(public.invoices) from public;
grant execute on function public.doc_view(text) to anon, authenticated;

-- invoice-email reads this as the signed-in person: the document plus who it goes to
create or replace function public.invoice_email_data(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare i invoices;
begin
  if not private.can('invoices', 2) then raise exception 'Your role can''t send invoices'; end if;
  select * into i from invoices where id = p_id and tenant_id = private.current_tenant() and private.in_scope('invoices', owner_id, divisions);
  if not found then raise exception 'Invoice not found'; end if;
  if i.status = 'void' then raise exception 'This invoice is void'; end if;
  return private.invoice_doc(i) || jsonb_build_object('to', coalesce(nullif(i.bill_to->>'email', ''), (select personal_email from people where id = i.person_id),
      (select main_email from companies where id = i.company_id)),
    'from_name', (select full_name from app_users where id = auth.uid()), 'reply_to', (select email from app_users where id = auth.uid()),
    'pay_method', private.pay_method(i.tenant_id));
end $$;
revoke execute on function public.invoice_email_data(uuid) from public, anon;
grant execute on function public.invoice_email_data(uuid) to authenticated;
