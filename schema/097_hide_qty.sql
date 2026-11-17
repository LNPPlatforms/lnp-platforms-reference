-- 097: hide the quantity line on a custom proposal line (Nov 11, 2026). items.custom[].hide_qty = true drops the
-- "Qty 12 · $125 setup each" text under the title; the totals don't change.
do $m$
declare d text; b text;
begin
  if to_regprocedure('private.proposal_quote(public.proposals,text,uuid)') is null then return; end if;
  d := pg_get_functiondef('private.proposal_quote(public.proposals,text,uuid)'::regprocedure); b := d;
  if position('hide_qty' in d) > 0 then return; end if;
  d := replace(d, $q$'qty',case when cq > 1 then$q$, $q$'qty',case when cq > 1 and coalesce(x->>'hide_qty', '') <> 'true' then$q$);
  if d = b then raise exception 'proposal_quote did not match; nothing changed'; end if;
  execute d;
end $m$;
