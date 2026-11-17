-- 074e: client portal, part 5. The schedule, the estimate and invoice lists and one document in the shared layout.

create or replace function public.portal_schedule(p_ctx uuid) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare x private.portal_ctx := private.portal_ctx(p_ctx);
begin
  perform private.portal_need(x, 'schedule', 1);
  return (select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'number', j.number, 'title', j.title, 'service', j.service_type,
      'start', j.scheduled_start, 'end', j.scheduled_end, 'status', j.status, 'location', c.name, 'note', j.client_note,
      'done_at', coalesce(j.completed_at, j.left_at)) order by j.scheduled_start), '[]'::jsonb)
    from jobs j join companies c on c.id = j.company_id
   where j.tenant_id = x.tenant_id and j.company_id = any(x.orgs) and not j.portal_hidden and j.archived_at is null
     and j.scheduled_start >= now() - interval '60 days' and j.scheduled_start < now() + interval '400 days');
end $$;

-- p_kind 'invoices' or 'estimates'
create or replace function public.portal_docs(p_ctx uuid, p_kind text) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare x private.portal_ctx := private.portal_ctx(p_ctx); act boolean; lbl text;
begin
  if p_kind = 'invoices' then
    perform private.portal_need(x, 'invoices', 1);
    act := private.portal_lvl(x, 'invoices') >= 2 and not x.preview;
    return (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'number', coalesce(d.prefix, '') || i.number, 'status', i.status, 'issue_date', i.issue_date,
        'due_date', i.due_date, 'total', i.total, 'balance', i.balance, 'location', c.name,
        'overdue', i.status in ('sent', 'partial') and i.due_date < current_date and i.balance > 0,
        'can_pay', act and i.status in ('sent', 'partial') and i.balance > 0 and private.pay_method(i.tenant_id) is not null)
        order by i.issue_date desc, i.number desc), '[]'::jsonb)
      from invoices i join companies c on c.id = i.company_id left join private.doc_settings d on d.tenant_id = i.tenant_id
     where i.tenant_id = x.tenant_id and i.company_id = any(x.orgs) and not i.portal_hidden and i.status in ('sent', 'partial', 'paid'));
  elsif p_kind = 'estimates' then
    perform private.portal_need(x, 'estimates', 1);
    act := private.portal_lvl(x, 'estimates') >= 2 and not x.preview;
    lbl := coalesce(nullif((select settings->'labels'->'proposal'->>'one' from account_settings where tenant_id = x.tenant_id), ''), 'Estimate');
    return (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', lbl, 'version', p.version, 'status', p.status, 'sent_at', p.sent_at,
        'expires_at', p.expires_at, 'accepted_at', p.accepted_at, 'location', c.name,
        'expired', p.status = 'sent' and p.expires_at < now(),
        'can_accept', act and p.status = 'sent' and (p.expires_at is null or p.expires_at > now())) order by coalesce(p.sent_at, p.created_at) desc), '[]'::jsonb)
      from proposals p join companies c on c.id = p.company_id
     where p.tenant_id = x.tenant_id and p.company_id = any(x.orgs) and not p.portal_hidden and p.status in ('sent', 'accepted'));
  end if;
  raise exception 'Unknown list';
end $$;

-- one estimate or invoice in the shared layout. The customer link (to pay or accept) only comes back with "act".
create or replace function public.portal_doc(p_ctx uuid, p_kind text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare x private.portal_ctx := private.portal_ctx(p_ctx); tok text; act boolean; d jsonb;
begin
  if p_kind = 'invoice' then
    perform private.portal_need(x, 'invoices', 1);
    select share_token into tok from invoices where id = p_id and tenant_id = x.tenant_id and company_id = any(x.orgs) and not portal_hidden and status in ('sent', 'partial', 'paid');
    act := private.portal_lvl(x, 'invoices') >= 2 and not x.preview;
  elsif p_kind = 'estimate' then
    perform private.portal_need(x, 'estimates', 1);
    select share_token into tok from proposals where id = p_id and tenant_id = x.tenant_id and company_id = any(x.orgs) and not portal_hidden and status in ('sent', 'accepted');
    act := private.portal_lvl(x, 'estimates') >= 2 and not x.preview;
  end if;
  if tok is null then raise exception 'Not found'; end if;
  d := public.doc_view(tok);
  if d is null then raise exception 'Not found'; end if;
  return (d - 'token') || jsonb_build_object('link', case when act then case when p_kind = 'invoice' then '/doc/?t=' || tok else '/proposal/view/?t=' || tok end end);
end $$;

revoke execute on function public.portal_schedule(uuid), public.portal_docs(uuid, text), public.portal_doc(uuid, text, uuid) from public, anon;
grant execute on function public.portal_schedule(uuid), public.portal_docs(uuid, text), public.portal_doc(uuid, text, uuid) to authenticated;
