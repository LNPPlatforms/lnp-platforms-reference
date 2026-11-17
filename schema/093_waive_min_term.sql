-- 093: admin can waive the payback minimum term (Nov 11, 2026). When setup is red but the monthly earns it back,
-- the proposal gets a minimum term and early termination fee automatically. An admin can now waive that with a
-- reason on record (proposal_waive_term); clearing the reason puts the term back. Only admins can write the columns.
alter table public.proposals add column if not exists waive_term_reason text;
alter table public.proposals add column if not exists waive_term_by uuid references public.app_users(id);

do $m$
declare d text; b text;
begin
  if to_regprocedure('private.proposal_quote(public.proposals,text,uuid)') is null then return; end if;
  d := pg_get_functiondef('private.proposal_quote(public.proposals,text,uuid)'::regprocedure); b := d;
  if position('waive_term_reason' in d) = 0 then
    d := replace(d, $q$payback := case when e1->'payback' = 'null'::jsonb then null else e1->'payback' end;$q$,
                    $q$payback := case when e1->'payback' = 'null'::jsonb or p.waive_term_reason is not null then null else e1->'payback' end;$q$);
    d := replace(d, $q$'payback', ev->'payback'));$q$,
                    $q$'payback', case when p.waive_term_reason is not null then null else ev->'payback' end));$q$);
    if d = b or position('or p.waive_term_reason is not null' in d) = 0 then raise exception 'proposal_quote did not match; nothing changed'; end if;
    execute d;
  end if;

  d := pg_get_functiondef('private.guard_proposal()'::regprocedure); b := d;
  if position('waive_term' in d) = 0 then
    d := replace(d, $q$new.client_plan := null; new.phase_starts := '{}'::jsonb;$q$,
                    $q$new.client_plan := null; new.phase_starts := '{}'::jsonb; new.waive_term_reason := null; new.waive_term_by := null;$q$);
    d := replace(d, $q$  if not adm and new.owner_id <> old.owner_id then raise exception 'Only an admin can reassign a proposal'; end if;$q$,
                    $q$  if not adm and new.owner_id <> old.owner_id then raise exception 'Only an admin can reassign a proposal'; end if;
  if not adm and (new.waive_term_reason is distinct from old.waive_term_reason or new.waive_term_by is distinct from old.waive_term_by) then
    raise exception 'Only an admin can waive the minimum term';
  end if;$q$);
    if position('new.waive_term_reason := null' in d) = 0 or position('Only an admin can waive' in d) = 0 then raise exception 'guard_proposal did not match; nothing changed'; end if;
    execute d;
  end if;
end $m$;

-- admin: waive the minimum term with a reason, or pass an empty reason to put it back
create or replace function public.proposal_waive_term(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_admin() then raise exception 'Only an admin can waive the minimum term'; end if;
  perform set_config('app.proposal_rpc', '1', true);
  update proposals set waive_term_reason = nullif(trim(coalesce(p_reason, '')), ''),
         waive_term_by = case when nullif(trim(coalesce(p_reason, '')), '') is null then null else auth.uid() end
   where id = p_id and tenant_id = private.current_tenant() and status <> 'accepted';
  if not found then raise exception 'Proposal not found, or it was already accepted'; end if;
end $$;
grant execute on function public.proposal_waive_term(uuid, text) to authenticated;
