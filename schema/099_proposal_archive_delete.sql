-- 099: archive and delete proposals (Nov 12, 2026).
-- Archive hides a proposal from the Proposals list (it moves under Archived) and can be undone. The client link keeps working.
-- Delete removes a proposal for good, with its versions and view history, and the client link stops working.
--   Drafts that were never sent: the closer or an admin can delete.
--   Sent proposals: admins only.
--   Accepted proposals, or any proposal with an invoice, job or bid attached: can't be deleted, only archived.
-- Both leave a note on the organization's activity.

alter table public.proposals add column if not exists archived_at timestamptz;
alter table public.proposals add column if not exists archived_by uuid references public.app_users(id);

create or replace function public.proposal_archive(p_id uuid, p_archive boolean default true) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare p proposals;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  select * into p from proposals where id = p_id and tenant_id = private.current_tenant();
  if not found then raise exception 'Proposal not found'; end if;
  if not private.is_admin() and p.owner_id is distinct from auth.uid() then raise exception 'Only the closer or an admin can archive this proposal'; end if;
  perform set_config('app.proposal_rpc', '1', true);
  update proposals set archived_at = case when p_archive then now() end, archived_by = case when p_archive then auth.uid() end where id = p.id;
  perform set_config('app.proposal_rpc', '', true);
  insert into activities (tenant_id, company_id, type, body, created_by)
  values (p.tenant_id, p.company_id, 'note', 'Proposal' || coalesce(' "' || nullif(p.name, '') || '"', '') || case when p_archive then ' archived.' else ' restored from the archive.' end, auth.uid());
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.proposal_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare p proposals;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  select * into p from proposals where id = p_id and tenant_id = private.current_tenant();
  if not found then raise exception 'Proposal not found'; end if;
  if p.status = 'accepted' or p.accepted_at is not null then raise exception 'An accepted proposal can''t be deleted. Archive it instead.'; end if;
  if exists (select 1 from invoices where proposal_id = p.id) or exists (select 1 from jobs where proposal_id = p.id) or exists (select 1 from bids where proposal_id = p.id) then
    raise exception 'This proposal has an invoice, job or bid attached, so it can''t be deleted. Archive it instead.';
  end if;
  if p.status = 'draft' and coalesce(p.version, 0) = 0 then
    if not private.is_admin() and p.owner_id is distinct from auth.uid() then raise exception 'Only the closer or an admin can delete this draft'; end if;
  elsif not private.is_admin() then
    raise exception 'Only an admin can delete a proposal that was sent. You can archive it.';
  end if;
  delete from proposal_versions where proposal_id = p.id;
  delete from proposals where id = p.id;
  insert into activities (tenant_id, company_id, type, body, created_by)
  values (p.tenant_id, p.company_id, 'note', 'Proposal' || coalesce(' "' || nullif(p.name, '') || '"', '')
    || case when coalesce(p.version, 0) = 0 then ' draft deleted.' else ' deleted (it had been sent as version ' || p.version || ').' end, auth.uid());
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.proposal_archive(uuid, boolean), public.proposal_delete(uuid) from public, anon;
grant execute on function public.proposal_archive(uuid, boolean), public.proposal_delete(uuid) to authenticated;
