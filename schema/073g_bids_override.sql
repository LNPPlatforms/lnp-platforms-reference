-- 073g: bids, part 5. A person can override the scorecard's go, maybe or no-go with a note. By default the override
-- waits in Review (account switch). Someone who can approve bids (level 3) has their own override count right away.

create or replace function private.bid_mine(p_id uuid) returns public.bids
language sql stable security definer set search_path = public, private as $$
  select b.* from bids b where b.id = p_id and b.tenant_id = private.current_tenant() and private.bids_see() and private.in_scope('bids', b.owner_id, b.divisions)
$$;
revoke execute on function private.bid_mine(uuid) from public, anon, authenticated;

create or replace function public.bid_override(p_id uuid, p_result text, p_note text) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare b bids := private.bid_mine(p_id); rv boolean; st text; note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if b.id is null then raise exception 'Bid not found'; end if;
  if not private.can('bids', 2) then raise exception 'Your role can''t change bids'; end if;
  if p_result is null then
    update bids set override_result = null, override_note = null, override_by = null, override_at = null, review_state = null,
      history = history || jsonb_build_array(jsonb_build_object('at', now(), 'by', auth.uid(), 'what', 'override_cleared'))
    where id = b.id;
    return jsonb_build_object('ok', true, 'review', null);
  end if;
  if p_result not in ('go', 'maybe', 'no_go') then raise exception 'Pick go, maybe or no-go'; end if;
  if note is null then raise exception 'Say why in a note. Overrides need one.'; end if;
  if length(note) > 2000 then raise exception 'Keep the note under 2,000 characters'; end if;
  rv := coalesce((select override_review from private.bid_settings where tenant_id = b.tenant_id), true);
  st := case when not rv then null when private.is_admin() or private.can('bids', 3) then 'approved' else 'pending' end;
  update bids set override_result = p_result, override_note = note, override_by = auth.uid(), override_at = now(),
    review_state = st, review_by = case when st = 'approved' then auth.uid() end, review_at = case when st = 'approved' then now() end, review_note = null,
    history = history || jsonb_build_array(jsonb_build_object('at', now(), 'by', auth.uid(), 'what', 'override', 'from', b.result, 'to', p_result, 'note', note))
  where id = b.id;
  return jsonb_build_object('ok', true, 'review', st);
end $$;

-- Review: approve the override, or send it back (the scorecard's result stands again)
create or replace function public.bid_override_decide(p_id uuid, p_ok boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare b bids := private.bid_mine(p_id); note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if b.id is null then raise exception 'Bid not found'; end if;
  if not (private.is_admin() or private.can('bids', 3)) then raise exception 'Your role can''t approve bid overrides'; end if;
  if b.review_state is distinct from 'pending' then raise exception 'That override isn''t waiting anymore'; end if;
  if p_ok then
    update bids set review_state = 'approved', review_by = auth.uid(), review_at = now(), review_note = note,
      history = history || jsonb_build_array(jsonb_build_object('at', now(), 'by', auth.uid(), 'what', 'override_approved', 'note', note)) where id = b.id;
  else
    update bids set review_state = 'returned', review_by = auth.uid(), review_at = now(), review_note = note, override_result = null,
      history = history || jsonb_build_array(jsonb_build_object('at', now(), 'by', auth.uid(), 'what', 'override_returned', 'was', b.override_result, 'note', note)) where id = b.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.bid_review_list() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'title', b.title, 'client', coalesce(b.client_name, (select name from companies where id = b.company_id)),
      'score', b.score, 'result', b.result, 'override', b.override_result, 'note', b.override_note, 'by', (select full_name from app_users where id = b.override_by),
      'at', b.override_at, 'due_at', b.due_at) order by b.override_at), '[]'::jsonb)
  from bids b
  where (private.is_admin() or private.can('bids', 3)) and private.bids_see() and b.tenant_id = private.current_tenant()
    and b.review_state = 'pending' and b.archived_at is null and private.in_scope('bids', b.owner_id, b.divisions)
$$;

-- link what a won bid turned into (made on screen with the normal job, invoice or proposal rules)
create or replace function public.bid_converted(p_id uuid, p_kind text, p_ref uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare b bids := private.bid_mine(p_id);
begin
  if b.id is null then raise exception 'Bid not found'; end if;
  if not private.can('bids', 2) then raise exception 'Your role can''t change bids'; end if;
  if p_kind = 'job' and exists (select 1 from jobs where id = p_ref and tenant_id = b.tenant_id) then update bids set job_id = p_ref where id = b.id;
  elsif p_kind = 'invoice' and exists (select 1 from invoices where id = p_ref and tenant_id = b.tenant_id) then update bids set invoice_id = p_ref where id = b.id;
  elsif p_kind = 'proposal' and exists (select 1 from proposals where id = p_ref and tenant_id = b.tenant_id) then update bids set proposal_id = p_ref where id = b.id;
  else raise exception 'Couldn''t find what this bid turned into'; end if;
  update bids set status = case when status in ('won') then status else 'won' end,
    history = history || jsonb_build_array(jsonb_build_object('at', now(), 'by', auth.uid(), 'what', 'converted', 'kind', p_kind, 'id', p_ref)) where id = b.id;
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.bid_override(uuid, text, text), public.bid_override_decide(uuid, boolean, text), public.bid_review_list(), public.bid_converted(uuid, text, uuid) from public, anon;
grant execute on function public.bid_override(uuid, text, text), public.bid_override_decide(uuid, boolean, text), public.bid_review_list(), public.bid_converted(uuid, text, uuid) to authenticated;
