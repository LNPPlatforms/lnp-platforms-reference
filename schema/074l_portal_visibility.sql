-- 074l: client portal, part 12. Choose what they see: every job, invoice, estimate, document and photo the portal could show, and the switch on each.

-- everything the portal could show for this organization, and whether it does
create or replace function public.portal_vis_list(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); orgs uuid[]; fd text;
begin
  if not private.portal_staff_ok(p_company) then return null; end if;
  orgs := private.portal_orgs(p_company); fd := private.portal_settings(t)->>'files_default';
  return jsonb_build_object('files_default', fd,
    'jobs', (select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'title', j.title, 'at', j.scheduled_start, 'location', c.name, 'shown', not j.portal_hidden, 'note', j.client_note)
        order by j.scheduled_start desc), '[]'::jsonb) from jobs j join companies c on c.id = j.company_id
      where j.tenant_id = t and j.company_id = any(orgs) and j.archived_at is null and j.scheduled_start >= now() - interval '60 days'),
    'invoices', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'title', 'Invoice ' || coalesce(d.prefix, '') || i.number, 'at', i.issue_date, 'location', c.name,
        'shown', not i.portal_hidden, 'status', i.status) order by i.issue_date desc), '[]'::jsonb)
      from invoices i join companies c on c.id = i.company_id left join private.doc_settings d on d.tenant_id = i.tenant_id
      where i.tenant_id = t and i.company_id = any(orgs) and i.status in ('sent', 'partial', 'paid')),
    'estimates', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', 'Version ' || p.version, 'at', coalesce(p.sent_at, p.created_at), 'location', c.name,
        'shown', not p.portal_hidden, 'status', p.status) order by coalesce(p.sent_at, p.created_at) desc), '[]'::jsonb)
      from proposals p join companies c on c.id = p.company_id where p.tenant_id = t and p.company_id = any(orgs) and p.status in ('sent', 'accepted')),
    'files', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'at', a.created_at, 'location', c.name, 'share', a.portal_share,
        'shown', coalesce(a.portal_share = 'shared', fd = 'shared')) order by a.created_at desc), '[]'::jsonb)
      from company_assets a join companies c on c.id = a.company_id where a.tenant_id = t and a.company_id = any(orgs) and a.archived_at is null and a.url ~* '^https://'),
    'photos', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'path', e.photo_path, 'title', j.title, 'at', e.created_at, 'location', c.name, 'share', e.portal_share,
        'shown', not j.portal_hidden and coalesce(e.portal_share = 'shared', fd = 'shared')) order by e.created_at desc), '[]'::jsonb)
      from job_events e join jobs j on j.id = e.job_id join companies c on c.id = j.company_id
      where e.tenant_id = t and j.tenant_id = t and j.company_id = any(orgs) and e.photo_path is not null and j.archived_at is null));
end $$;

-- p_kind: job, invoice, estimate, approval (p_state shown or hidden); file, photo (shared, internal or default)
create or replace function public.portal_vis_set(p_kind text, p_id uuid, p_state text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); co uuid; hide boolean := p_state = 'hidden'; sh text;
begin
  if p_kind in ('job', 'invoice', 'estimate', 'approval') and p_state not in ('shown', 'hidden') then raise exception 'Pick shown or hidden'; end if;
  if p_kind in ('file', 'photo') and p_state not in ('shared', 'internal', 'default') then raise exception 'Pick shared, internal or default'; end if;
  sh := case when p_state = 'default' then null else p_state end;
  co := case p_kind when 'job' then (select company_id from jobs where id = p_id and tenant_id = t)
    when 'invoice' then (select company_id from invoices where id = p_id and tenant_id = t)
    when 'estimate' then (select company_id from proposals where id = p_id and tenant_id = t)
    when 'approval' then (select company_id from portal_approvals where id = p_id and tenant_id = t)
    when 'file' then (select company_id from company_assets where id = p_id and tenant_id = t)
    when 'photo' then (select j.company_id from job_events e join jobs j on j.id = e.job_id where e.id = p_id and e.tenant_id = t) end;
  if co is null or not private.portal_staff_ok(co) then raise exception 'Not found'; end if;
  if p_kind = 'job' then update jobs set portal_hidden = hide, client_note = case when p_note is null then client_note else nullif(left(trim(p_note), 2000), '') end where id = p_id;
  elsif p_kind = 'invoice' then update invoices set portal_hidden = hide where id = p_id;
  elsif p_kind = 'estimate' then update proposals set portal_hidden = hide where id = p_id;
  elsif p_kind = 'approval' then update portal_approvals set portal_hidden = hide where id = p_id;
  elsif p_kind = 'file' then update company_assets set portal_share = sh where id = p_id;
  else update job_events set portal_share = sh where id = p_id; end if;
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.portal_vis_list(uuid), public.portal_vis_set(text, uuid, text, text) from public, anon;
grant execute on function public.portal_vis_list(uuid), public.portal_vis_set(text, uuid, text, text) to authenticated;
