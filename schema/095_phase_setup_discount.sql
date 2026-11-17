-- 095: setup discount per phase (Nov 11, 2026). items.disc.ph_setup = {"2": 25} gives Phase 2 its own setup
-- discount percent; a phase without one uses the proposal's setup discount (items.disc.setup) as before. Each phase's
-- setup is already judged on its own, so the lights follow. The builder also keeps items.disc.ph_setup_amt for a
-- dollar amount and saves the matching percent here. Monthly stays one discount across phases.
do $m$
declare d text; b text;
begin
  if to_regprocedure('private.proposal_quote(public.proposals,text,uuid)') is null then return; end if;
  d := pg_get_functiondef('private.proposal_quote(public.proposals,text,uuid)'::regprocedure); b := d;
  if position('ph_setup' in d) > 0 then return; end if;  -- already applied
  d := replace(d, $q$d_s numeric; d_m numeric;$q$, $q$d_s numeric; d_m numeric; d_sn numeric; d_s1 numeric;$q$);
  d := replace(d, $q$    ev := private.proposal_eval(st, s_p, s_c, mc_p + wc_p*52/12, mc_c + wc_c*52/12, d_s, d_m);$q$,
    $q$    d_sn := case when coalesce(it->'disc'->'ph_setup'->>(n::text), '') ~ '^\d+(\.\d+)?$'
                  then least(100, greatest(0, (it->'disc'->'ph_setup'->>(n::text))::numeric)) / 100 else d_s end;
    ev := private.proposal_eval(st, s_p, s_c, mc_p + wc_p*52/12, mc_c + wc_c*52/12, d_sn, d_m);$q$);
  d := replace(d, $q$    if n = 1 then e1 := ev; m1_p := mc_p; w1_p := wc_p; end if;$q$,
                  $q$    if n = 1 then e1 := ev; m1_p := mc_p; w1_p := wc_p; d_s1 := d_sn; end if;$q$);
  d := replace(d, $q$      'setup', jsonb_build_object('gross', s_p, 'disc', s_p - (ev->>'s_net')::numeric, 'net', (ev->>'s_net')::numeric),$q$,
                  $q$      'setup', jsonb_build_object('gross', s_p, 'disc', s_p - (ev->>'s_net')::numeric, 'net', (ev->>'s_net')::numeric, 'pct', d_sn*100),$q$);
  d := replace(d, $q$'net', (e1->>'s_net')::numeric, 'pct', d_s*100),$q$, $q$'net', (e1->>'s_net')::numeric, 'pct', coalesce(d_s1, d_s)*100),$q$);
  if position('d_sn, d_m);' in d) = 0 or position('d_s1 := d_sn' in d) = 0 or position($q$'pct', d_sn*100$q$ in d) = 0
     or position('coalesce(d_s1, d_s)*100' in d) = 0 then
    raise exception 'proposal_quote did not match; nothing changed';
  end if;
  execute d;
end $m$;
