-- 074f: client portal, part 6. Documents and job photos the team shared, and the approvals list.

create or replace function public.portal_files(p_ctx uuid) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare x private.portal_ctx := private.portal_ctx(p_ctx);
begin
  perform private.portal_need(x, 'files', 1);
  return jsonb_build_object(
    'files', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'kind', a.kind, 'url', a.url, 'location', c.name, 'at', a.created_at,
        'mime', m.mime) order by a.created_at desc), '[]'::jsonb)
      from company_assets a join companies c on c.id = a.company_id left join media m on m.id = a.media_id
     where a.tenant_id = x.tenant_id and a.company_id = any(x.orgs) and a.archived_at is null and a.url ~* '^https://'
       and private.portal_shared(a.portal_share, x)),
    'photos', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'path', e.photo_path, 'at', e.created_at,
        'job', j.title, 'job_id', j.id, 'location', c.name) order by e.created_at desc), '[]'::jsonb)
      from job_events e
      join jobs j on j.id = e.job_id join companies c on c.id = j.company_id
     where e.tenant_id = x.tenant_id and j.tenant_id = x.tenant_id and j.company_id = any(x.orgs) and e.photo_path is not null
       and not j.portal_hidden and j.archived_at is null and private.portal_shared(e.portal_share, x)));
end $$;

-- worker notes on photos never go to the portal, only the picture, the job and the date
-- storage: a signed-in client may open a job photo only when it's shared and on a job for their organization
create or replace function private.portal_photo_ok(p_name text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select auth.uid() is not null and exists (
    select 1 from job_events e join jobs j on j.id = e.job_id
      join private.portal_users pu on pu.user_id = auth.uid() and pu.removed_at is null and pu.tenant_id = j.tenant_id
     where e.photo_path = p_name and e.tenant_id = j.tenant_id and not j.portal_hidden and j.archived_at is null
       and j.company_id = any(private.portal_orgs(pu.company_id))
       and private.feature_on_for(pu.tenant_id, 'portal')
       and coalesce(e.portal_share = 'shared', (private.portal_settings(pu.tenant_id)->>'files_default') = 'shared')
       and coalesce(((private.portal_settings(pu.tenant_id)->'sections')->>'files')::boolean, true)
       and (pu.is_admin or coalesce((pu.perms->>'files')::int, 1) >= 1))
$$;
revoke execute on function private.portal_photo_ok(text) from public, anon;
grant execute on function private.portal_photo_ok(text) to authenticated;

create or replace function public.portal_approvals_list(p_ctx uuid) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare x private.portal_ctx := private.portal_ctx(p_ctx); act boolean;
begin
  perform private.portal_need(x, 'approvals', 1);
  act := private.portal_lvl(x, 'approvals') >= 2 and not x.preview;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'title', a.title, 'summary', a.summary, 'amount', a.amount,
      'link', case when act then a.link end, 'due_at', a.due_at, 'status', a.status, 'location', c.name, 'at', a.created_at,
      'decided_at', a.decided_at, 'decided_name', a.decided_name, 'can_decide', act and a.status = 'pending')
      order by (a.status = 'pending') desc, a.created_at desc), '[]'::jsonb)
    from portal_approvals a join companies c on c.id = a.company_id
   where a.tenant_id = x.tenant_id and a.company_id = any(x.orgs) and not a.portal_hidden and a.status <> 'withdrawn'
     and (a.status = 'pending' or a.decided_at > now() - interval '90 days'));
end $$;

-- approve or decline an item that has no signing page of its own
create or replace function public.portal_approval_decide(p_ctx uuid, p_id uuid, p_ok boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare x private.portal_ctx := private.portal_ctx(p_ctx); a portal_approvals; who text;
begin
  perform private.portal_need(x, 'approvals', 2);
  select * into a from portal_approvals where id = p_id and tenant_id = x.tenant_id and company_id = any(x.orgs) and not portal_hidden for update;
  if not found then raise exception 'Not found'; end if;
  if a.status <> 'pending' then raise exception 'This was already answered'; end if;
  if a.link is not null then raise exception 'Open it to review and sign'; end if;
  select coalesce(nullif(trim(full_name), ''), email) into who from private.portal_users where id = x.portal_user;
  update portal_approvals set status = case when p_ok then 'approved' else 'declined' end, decided_at = now(), decided_by_portal = x.portal_user,
    decided_name = who, decision_note = left(nullif(trim(p_note), ''), 2000) where id = a.id;
  if a.created_by is not null then
    insert into notifications (user_id, kind, title, body, link) values (a.created_by, 'portal',
      who || case when p_ok then ' approved ' else ' declined ' end || a.title, nullif(trim(p_note), ''), '#org/' || a.company_id);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- for the change order build: put something in a client's "Needs your approval" list
create or replace function private.portal_approval_add(p_tenant uuid, p_company uuid, p_kind text, p_ref uuid, p_title text, p_summary text,
  p_amount numeric, p_link text, p_due timestamptz, p_by uuid) returns uuid
language sql security definer set search_path = public, private as $$
  insert into portal_approvals (tenant_id, company_id, kind, ref_id, title, summary, amount, link, due_at, created_by)
  select p_tenant, p_company, coalesce(p_kind, 'change_order'), p_ref, p_title, p_summary, p_amount, p_link, p_due, p_by
   where exists (select 1 from companies where id = p_company and tenant_id = p_tenant)
  returning id
$$;
revoke execute on function private.portal_approval_add(uuid, uuid, text, uuid, text, text, numeric, text, timestamptz, uuid) from public, anon, authenticated;

revoke execute on function public.portal_files(uuid), public.portal_approvals_list(uuid), public.portal_approval_decide(uuid, uuid, boolean, text) from public, anon;
grant execute on function public.portal_files(uuid), public.portal_approvals_list(uuid), public.portal_approval_decide(uuid, uuid, boolean, text) to authenticated;
