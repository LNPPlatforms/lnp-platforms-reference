-- 069d: making invoices from an accepted proposal or from approved jobs, marking sent, recording payments.
-- A manual payment (check, cash, a pasted link) posts right away for people who can approve invoices (level 3);
-- anyone else's waits in Review.
create or replace function public.invoice_from_proposal(p_proposal uuid) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare p proposals; q jsonb; ls jsonb; out uuid; rate numeric;
begin
  if not private.can('invoices', 2) then raise exception 'Your role can''t make invoices'; end if;
  select * into p from proposals where id = p_proposal and tenant_id = private.current_tenant();
  if not found then raise exception 'Proposal not found'; end if;
  if p.status <> 'accepted' then raise exception 'Only an accepted proposal can be invoiced'; end if;
  select quote into q from proposal_versions where proposal_id = p.id and version = p.accepted_version;
  rate := coalesce((select default_tax_rate from private.doc_settings where tenant_id = p.tenant_id), 0);
  select coalesce(jsonb_agg(jsonb_build_object('name', l->>'title', 'desc', coalesce(l->>'sub', ''), 'qty', 1, 'price', (l->>'setup')::numeric, 'tax', rate)), '[]'::jsonb) into ls
    from jsonb_array_elements(coalesce(q->'lines', '[]'::jsonb)) l where coalesce((l->>'ph')::int, 1) = 1 and coalesce((l->>'setup')::numeric, 0) > 0;
  if jsonb_array_length(ls) = 0 then   -- nothing due at signing: bill the first month
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

-- approved, not yet billed jobs for one billing organization (a location set to bill its parent bills the parent)
create or replace function public.invoice_from_jobs(p_jobs uuid[]) returns uuid
language plpgsql security definer set search_path = public, private as $$
declare bill uuid; n int; nb int; ls jsonb; out uuid; rate numeric; t uuid := private.current_tenant();
begin
  if not private.can('invoices', 2) then raise exception 'Your role can''t make invoices'; end if;
  if coalesce(cardinality(p_jobs), 0) = 0 then raise exception 'Pick at least one job'; end if;
  select count(*), min(b::text)::uuid, count(distinct b) into n, bill, nb
    from (select case when c.bill_to = 'parent' and c.parent_company_id is not null then c.parent_company_id else c.id end b
            from jobs j join companies c on c.id = j.company_id
           where j.id = any(p_jobs) and j.tenant_id = t and j.archived_at is null and j.approval in ('approved', 'auto') and j.billed_at is null and j.invoice_id is null) x;
  if n <> cardinality(p_jobs) then raise exception 'Some of those jobs are already billed or not approved yet'; end if;
  if nb > 1 then raise exception 'Those jobs bill to different organizations. Make one invoice for each.'; end if;
  rate := coalesce((select default_tax_rate from private.doc_settings where tenant_id = t), 0);
  select jsonb_agg(jsonb_build_object('name', j.title, 'desc', concat_ws(' · ', nullif(j.service_type, ''), case when c.id <> bill then c.name end,
      to_char(coalesce(j.completed_at, j.scheduled_start) at time zone 'America/Chicago', 'Mon DD, YYYY')), 'qty', 1, 'price', coalesce(j.price, 0), 'tax', rate, 'job_id', j.id)
      order by coalesce(j.completed_at, j.scheduled_start), j.number) into ls
    from jobs j join companies c on c.id = j.company_id where j.id = any(p_jobs);
  insert into invoices (company_id, person_id, lines) values (bill, (select person_id from jobs where id = p_jobs[1] and company_id = bill), ls) returning id into out;
  update jobs set billed_at = now(), invoice_id = out where id = any(p_jobs);
  return out;
end $$;

create or replace function public.invoice_mark_sent(p_id uuid, p_to text default null) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.can('invoices', 2) then raise exception 'Your role can''t send invoices'; end if;
  perform set_config('app.invoice_rpc', '1', true);
  update invoices set status = case when status = 'draft' then 'sent' else status end, sent_at = now(),
         last_emailed_to = coalesce(nullif(trim(p_to), ''), last_emailed_to)
   where id = p_id and tenant_id = private.current_tenant() and status <> 'void' and private.in_scope('invoices', owner_id, divisions);
  if not found then raise exception 'Invoice not found'; end if;
  perform set_config('app.invoice_rpc', '', true);
end $$;

create or replace function public.invoice_payment_record(p_invoice uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare i invoices; amt numeric := private.num_or(p->>'amount', 0); m text := coalesce(p->>'method', 'check'); st text; out uuid;
begin
  if not private.can('invoices', 2) then raise exception 'Your role can''t record payments'; end if;
  select * into i from invoices where id = p_invoice and tenant_id = private.current_tenant() and private.in_scope('invoices', owner_id, divisions);
  if not found then raise exception 'Invoice not found'; end if;
  if i.status = 'void' then raise exception 'This invoice is void'; end if;
  if amt <= 0 then raise exception 'Enter the amount paid'; end if;
  if amt > i.balance + 0.004 then raise exception 'That''s more than the balance due'; end if;
  if m not in ('check', 'cash', 'link', 'card', 'bank', 'other') then raise exception 'Pick how they paid'; end if;
  st := case when private.can('invoices', 3) then 'posted' else 'pending' end;
  insert into invoice_payments (tenant_id, invoice_id, amount, method, reference, paid_on, note, status, decided_by, decided_at)
  values (i.tenant_id, i.id, round(amt, 2), m, nullif(left(trim(coalesce(p->>'reference', '')), 120), ''), coalesce(nullif(p->>'paid_on', '')::date, current_date),
    nullif(left(trim(coalesce(p->>'note', '')), 500), ''), st, case when st = 'posted' then auth.uid() end, case when st = 'posted' then now() end)
  returning id into out;
  return jsonb_build_object('id', out, 'status', st);
end $$;

-- approve or turn down a payment waiting in Review; level 4 can also remove a posted manual payment
create or replace function public.invoice_payment_decide(p_id uuid, p_ok boolean) returns void
language plpgsql security definer set search_path = public, private as $$
declare x invoice_payments;
begin
  if not private.can('invoices', 3) then raise exception 'Your role can''t approve payments'; end if;
  select * into x from invoice_payments where id = p_id and tenant_id = private.current_tenant() for update;
  if not found or not exists (select 1 from invoices i where i.id = x.invoice_id and private.in_scope('invoices', i.owner_id, i.divisions)) then raise exception 'Payment not found'; end if;
  if x.status = 'pending' then
    update invoice_payments set status = case when p_ok then 'posted' else 'rejected' end, decided_by = auth.uid(), decided_at = now() where id = p_id;
  elsif x.status = 'posted' and not p_ok then
    if x.source <> 'manual' then raise exception 'Online payments are refunded in the payment processor'; end if;
    if not private.can('invoices', 4) then raise exception 'Your role can''t remove payments'; end if;
    update invoice_payments set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = p_id;
  else raise exception 'That payment was already decided';
  end if;
end $$;

create or replace function public.invoice_review_list() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.can('invoices', 3) then coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'invoice_id', i.id, 'number', coalesce(d.prefix, '') || i.number, 'org', c.name,
      'amount', x.amount, 'method', x.method, 'reference', x.reference, 'paid_on', x.paid_on, 'note', x.note, 'balance', i.balance,
      'by', (select full_name from app_users where id = x.recorded_by), 'at', x.created_at) order by x.created_at)
    from invoice_payments x join invoices i on i.id = x.invoice_id join companies c on c.id = i.company_id
    left join private.doc_settings d on d.tenant_id = i.tenant_id
   where x.tenant_id = private.current_tenant() and x.status = 'pending' and private.in_scope('invoices', i.owner_id, i.divisions)), '[]'::jsonb) else '[]'::jsonb end
$$;
revoke execute on function public.invoice_from_proposal(uuid), public.invoice_from_jobs(uuid[]), public.invoice_mark_sent(uuid, text), public.invoice_payment_record(uuid, jsonb),
  public.invoice_payment_decide(uuid, boolean), public.invoice_review_list() from public, anon;
grant execute on function public.invoice_from_proposal(uuid), public.invoice_from_jobs(uuid[]), public.invoice_mark_sent(uuid, text), public.invoice_payment_record(uuid, jsonb),
  public.invoice_payment_decide(uuid, boolean), public.invoice_review_list() to authenticated;
