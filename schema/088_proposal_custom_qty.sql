-- 088: quantity on custom proposal lines (Nov 10, 2026). items.custom[].qty, a whole number, 1 when blank.
-- Setup, recurring price and both costs are per unit and get multiplied by the quantity. Lines with more than one
-- show "Qty 3 · $250 setup + $250/mo each" under the title (the client page already shows a line's qty text).
do $$
declare d text; b text;
begin
  if to_regprocedure('private.proposal_quote(public.proposals,text,uuid)') is null then return; end if;  -- test databases without proposals
  d := pg_get_functiondef('private.proposal_quote(public.proposals,text,uuid)'::regprocedure); b := d;
  if position('cq numeric' in d) > 0 then return; end if;  -- already applied
  d := replace(d, $q$plan_w numeric := 0; m1_p numeric := 0; w1_p numeric := 0; every text;$q$,
                  $q$plan_w numeric := 0; m1_p numeric := 0; w1_p numeric := 0; every text; cq numeric; cs numeric; ca numeric;$q$);
  d := replace(d, $q$    every := case when x->>'every' = 'week' then 'week' else 'month' end;
    lines := lines || jsonb_build_array(jsonb_build_object('key','custom','lk','custom:' || coalesce(x->>'id', (o-1)::text),'ph',array_position(rawph, private.ph_clean(x->'ph')),
      'bucket','added','title',coalesce(nullif(trim(x->>'name'),''),'Service'),'sub',nullif(trim(x->>'desc'),''),'note',nullif(trim(x->>'note'),''),
      'mockups',coalesce(x->'mockups','[]'::jsonb),'every',every,
      'setup',private.num0(x->>'setup'),'setup_cost',private.num0(x->>'setup_cost'),
      'mo',case when every = 'month' then private.num0(x->>'amt') else 0 end,'mo_cost',case when every = 'month' then private.num0(x->>'cost') else 0 end,
      'wk',case when every = 'week' then private.num0(x->>'amt') else 0 end,'wk_cost',case when every = 'week' then private.num0(x->>'cost') else 0 end));$q$,
  $q$    every := case when x->>'every' = 'week' then 'week' else 'month' end;
    cq := greatest(1, least(9999, floor(private.num0(x->>'qty'))));
    cs := private.num0(x->>'setup'); ca := private.num0(x->>'amt');
    lines := lines || jsonb_build_array(jsonb_build_object('key','custom','lk','custom:' || coalesce(x->>'id', (o-1)::text),'ph',array_position(rawph, private.ph_clean(x->'ph')),
      'bucket','added','title',coalesce(nullif(trim(x->>'name'),''),'Service'),'sub',nullif(trim(x->>'desc'),''),'note',nullif(trim(x->>'note'),''),
      'mockups',coalesce(x->'mockups','[]'::jsonb),'every',every,'units',cq,
      'qty',case when cq > 1 then 'Qty ' || cq::text || coalesce(nullif(' · ' || concat_ws(' + ',
          case when cs > 0 then '$' || regexp_replace(to_char(cs, 'FM999,999,990.00'), '\.00$', '') || ' setup' end,
          case when ca > 0 then '$' || regexp_replace(to_char(ca, 'FM999,999,990.00'), '\.00$', '') || '/' || case when every = 'week' then 'week' else 'mo' end end) || ' each', ' ·  each'), '') end,
      'setup',cs*cq,'setup_cost',private.num0(x->>'setup_cost')*cq,
      'mo',case when every = 'month' then ca*cq else 0 end,'mo_cost',case when every = 'month' then private.num0(x->>'cost')*cq else 0 end,
      'wk',case when every = 'week' then ca*cq else 0 end,'wk_cost',case when every = 'week' then private.num0(x->>'cost')*cq else 0 end));$q$);
  if d = b or position('cq numeric' in d) = 0 or position('''units'',cq' in d) = 0 then
    raise exception 'proposal_quote did not match the expected text; nothing changed';
  end if;
  execute d;
end $$;
