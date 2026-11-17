-- 094: turn off the hosting charge on one proposal (Nov 11, 2026). items.no_host = true makes hosting $0/mo on that
-- proposal: the hosting line still shows (as Included on the client's page) and its cost still counts in the margin
-- lights, so a deal that can't carry it still goes yellow or red. The switch is in the proposal builder for admins.
do $m$
declare d text; b text;
begin
  if to_regprocedure('private.proposal_quote(public.proposals,text,uuid)') is null then return; end if;
  d := pg_get_functiondef('private.proposal_quote(public.proposals,text,uuid)'::regprocedure); b := d;
  if position('no_host' in d) > 0 then return; end if;  -- already applied
  d := replace(d, $q$host_n := case when paid_n > 0 then$q$,
                  $q$host_n := case when coalesce((it->>'no_host')::boolean, false) then 0 when paid_n > 0 then$q$);
  if d = b then raise exception 'proposal_quote did not match; nothing changed'; end if;
  execute d;
end $m$;
