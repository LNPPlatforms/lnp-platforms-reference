-- 055: RLX pages no longer need the RLX Vendor License on the same proposal (Oct 26, 2026).
-- A page ($599 setup + $599/mo at today's prices) can be sold on its own. The license phase is its own choice,
-- no longer pulled to the earliest page. A page still earns the partner build rate and still covers hosting.
-- Existing proposals don't change: every one with pages already had the license, in the earliest page phase.
-- Applied as 055_pages_without_license and 055b_pages_without_license_lines.
do $$
declare d text;
begin
  d := pg_get_functiondef('private.proposal_quote(public.proposals,text,uuid)'::regprocedure);
  d := replace(d, $q$  if not lic then pages := '[]'::jsonb; end if;
$q$, '');
  d := replace(d, $q$lic_raw := least(private.ph_clean(it->'lic_ph'), coalesce((select min(private.ph_clean(x->'ph')) from jsonb_array_elements(pages) x), 9));$q$,
    $q$lic_raw := private.ph_clean(it->'lic_ph');$q$);
  d := replace(d, $q$partner_n := lic and pages_n > 0;$q$, $q$partner_n := pages_n > 0;$q$);
  -- page lines no longer sit inside "if lic"
  d := replace(d, $q$'mo_cost',(pb->'lic'->>'monthly_cost')::numeric));
    for x, o in select * from jsonb_array_elements(pages) with ordinality loop$q$,
    $q$'mo_cost',(pb->'lic'->>'monthly_cost')::numeric));
  end if;
    for x, o in select * from jsonb_array_elements(pages) with ordinality loop$q$);
  d := replace(d, $q$    end loop;
  end if;
  for x, o in select * from jsonb_array_elements(tsites) with ordinality loop$q$,
    $q$    end loop;
  for x, o in select * from jsonb_array_elements(tsites) with ordinality loop$q$);
  execute d;
end $$;
