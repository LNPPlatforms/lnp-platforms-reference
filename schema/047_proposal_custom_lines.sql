-- 047: custom lines on proposals, billed at signing, weekly or monthly (Oct 20, 2026).
-- items.custom is a list of lines the rep types in: name, description, phase, setup price and cost, and a recurring
-- amount and cost billed every week or every month. Weekly amounts show as their own total ("$200/week"); the
-- margin lights judge them at their monthly equivalent (x 52 / 12). The monthly discount applies to weekly too.
-- Versions store weekly_total next to setup_total and monthly_total. Checkout starts the weekly subscription.

create or replace function private.num0(t text) returns numeric
language sql immutable set search_path = pg_catalog as $$
  select case when trim(coalesce(t, '')) ~ '^\d{1,7}(\.\d{1,2})?$' then trim(t)::numeric else 0 end
$$;

alter table public.proposal_versions add column if not exists weekly_total numeric not null default 0;

do $$
declare d text; b text;
begin
  -- the quote engine
  d := pg_get_functiondef('private.proposal_quote(public.proposals,text,uuid)'::regprocedure); b := d;
  d := replace(d, $q$  lines jsonb := '[]'::jsonb; x jsonb; o int; ln jsonb;$q$,
    $q$  lines jsonb := '[]'::jsonb; x jsonb; o int; ln jsonb;
  cust jsonb := case when jsonb_typeof(it->'custom') = 'array' then it->'custom' else '[]'::jsonb end;
  w_p numeric; wc_p numeric; wc_c numeric; w_alone numeric; plan_w numeric := 0; m1_p numeric := 0; w1_p numeric := 0; every text;$q$);
  d := replace(d, $q$    union all select private.ph_clean(x->'ph') from jsonb_array_elements(cfun) x
    union all select cs_raw where cs_on$q$, $q$    union all select private.ph_clean(x->'ph') from jsonb_array_elements(cfun) x
    union all select private.ph_clean(x->'ph') from jsonb_array_elements(cust) x
    union all select cs_raw where cs_on$q$);
  d := replace(d, $q$  for n in 1 .. k loop
    pages_n :=$q$, $q$  for x, o in select * from jsonb_array_elements(cust) with ordinality loop
    every := case when x->>'every' = 'week' then 'week' else 'month' end;
    lines := lines || jsonb_build_array(jsonb_build_object('key','custom','lk','custom:' || coalesce(x->>'id', (o-1)::text),'ph',array_position(rawph, private.ph_clean(x->'ph')),
      'bucket','added','title',coalesce(nullif(trim(x->>'name'),''),'Service'),'sub',nullif(trim(x->>'desc'),''),'note',nullif(trim(x->>'note'),''),
      'mockups',coalesce(x->'mockups','[]'::jsonb),'every',every,
      'setup',private.num0(x->>'setup'),'setup_cost',private.num0(x->>'setup_cost'),
      'mo',case when every = 'month' then private.num0(x->>'amt') else 0 end,'mo_cost',case when every = 'month' then private.num0(x->>'cost') else 0 end,
      'wk',case when every = 'week' then private.num0(x->>'amt') else 0 end,'wk_cost',case when every = 'week' then private.num0(x->>'cost') else 0 end));
  end loop;

  for n in 1 .. k loop
    pages_n :=$q$);
  d := replace(d, $q$           coalesce(sum((l->>'mo')::numeric),0), coalesce(sum((l->>'mo_cost')::numeric),0)
      into s_p, s_c, m_p, m_c, mc_p, mc_c from$q$, $q$           coalesce(sum((l->>'mo')::numeric),0), coalesce(sum((l->>'mo_cost')::numeric),0),
           coalesce(sum((l->>'wk')::numeric) filter (where (l->>'ph')::int = n),0), coalesce(sum((l->>'wk')::numeric),0), coalesce(sum((l->>'wk_cost')::numeric),0)
      into s_p, s_c, m_p, m_c, mc_p, mc_c, w_p, wc_p, wc_c from$q$);
  d := replace(d, $q$    ev := private.proposal_eval(st, s_p, s_c, mc_p, mc_c, d_s, d_m);
    m_alone := round(m_p*(1-d_m), 2);
    if n = 1 then e1 := ev; end if;$q$, $q$    -- weekly billing is judged at its monthly equivalent
    ev := private.proposal_eval(st, s_p, s_c, mc_p + wc_p*52/12, mc_c + wc_c*52/12, d_s, d_m);
    m_alone := round(m_p*(1-d_m), 2);
    w_alone := round(w_p*(1-d_m), 2);
    if n = 1 then e1 := ev; m1_p := mc_p; w1_p := wc_p; end if;$q$);
  d := replace(d, $q$plan_m := plan_m + m_alone;$q$, $q$plan_m := plan_m + m_alone; plan_w := plan_w + w_alone;$q$);
  d := replace(d, $q$      'month', jsonb_build_object('gross', m_p, 'disc', m_p - m_alone, 'net', m_alone),$q$,
    $q$      'month', jsonb_build_object('gross', m_p, 'disc', m_p - m_alone, 'net', m_alone),
      'week', jsonb_build_object('gross', w_p, 'disc', w_p - w_alone, 'net', w_alone),$q$);
  d := replace(d, $q$    'month', jsonb_build_object('gross', (e1->>'m_p')::numeric, 'disc', (e1->>'m_p')::numeric - (e1->>'m_net')::numeric, 'net', (e1->>'m_net')::numeric, 'pct', d_m*100),$q$,
    $q$    'month', jsonb_build_object('gross', m1_p, 'disc', m1_p - round(m1_p*(1-d_m), 2), 'net', round(m1_p*(1-d_m), 2), 'pct', d_m*100),
    'week', jsonb_build_object('gross', w1_p, 'disc', w1_p - round(w1_p*(1-d_m), 2), 'net', round(w1_p*(1-d_m), 2), 'pct', d_m*100),$q$);
  d := replace(d, $q$'plan', jsonb_build_object('setup', plan_s, 'month', plan_m)$q$, $q$'plan', jsonb_build_object('setup', plan_s, 'month', plan_m, 'week', plan_w)$q$);
  d := replace(d, $q$l - 'setup_cost' - 'mo_cost' - 'qty'$q$, $q$l - 'setup_cost' - 'mo_cost' - 'wk_cost' - 'qty'$q$);
  d := replace(d, $q$else l - 'setup_cost' - 'mo_cost' end$q$, $q$else l - 'setup_cost' - 'mo_cost' - 'wk_cost' end$q$);
  if (select count(*) from unnest(array['cust jsonb', 'jsonb_array_elements(cust) x', '''key'',''custom''', 'w_p, wc_p, wc_c from', 'mc_p + wc_p*52/12',
      'plan_w := plan_w + w_alone', '''week'', jsonb_build_object(''gross'', w_p', '''week'', jsonb_build_object(''gross'', w1_p', '''week'', plan_w',
      '''mo_cost'' - ''wk_cost'' - ''qty''', '''mo_cost'' - ''wk_cost'' end']) s where position(s in d) = 0) > 0 then
    raise exception 'proposal_quote: a change did not match';
  end if;
  execute d;

  -- price changes on custom lines need a fresh override, like any other price change
  d := pg_get_functiondef('private.proposal_price_sig(jsonb)'::regprocedure); b := d;
  d := replace(d, $q$    'disc', it->'disc',$q$, $q$    'disc', it->'disc',
    'custom', (select jsonb_agg(jsonb_build_array(x->'setup', x->'setup_cost', x->'amt', x->'cost', x->'every', x->'ph')) from jsonb_array_elements(case when jsonb_typeof(it->'custom') = 'array' then it->'custom' else '[]'::jsonb end) x),$q$);
  if d = b then raise exception 'proposal_price_sig: no match'; end if;
  execute d;

  -- the client's phase plan can move custom lines too
  d := pg_get_functiondef('private.proposal_apply_plan(jsonb,jsonb)'::regprocedure); b := d;
  d := replace(d, $q$array['pages','tSites','tFunnels','cFunnels']$q$, $q$array['pages','tSites','tFunnels','cFunnels','custom']$q$);
  if d = b then raise exception 'proposal_apply_plan: no match'; end if;
  execute d;

  -- versions keep the weekly total; the activity note mentions it
  d := pg_get_functiondef('public.proposal_send(uuid)'::regprocedure); b := d;
  d := replace(d, $q$setup_total, monthly_total, light,$q$, $q$setup_total, monthly_total, weekly_total, light,$q$);
  d := replace(d, $q$(q->'month'->>'net')::numeric,
          qi->$q$, $q$(q->'month'->>'net')::numeric, coalesce((q->'week'->>'net')::numeric, 0),
          qi->$q$);
  d := replace(d, $q$'Proposal version %s sent: $%s due at signing, $%s/mo.%s', p.version, to_char((q->'setup'->>'net')::numeric,'FM999,999,990'),
      to_char((q->'month'->>'net')::numeric,'FM999,999,990'),$q$, $q$'Proposal version %s sent: $%s due at signing, $%s/mo%s.%s', p.version, to_char((q->'setup'->>'net')::numeric,'FM999,999,990'),
      to_char((q->'month'->>'net')::numeric,'FM999,999,990'),
      case when coalesce((q->'week'->>'net')::numeric, 0) > 0 then format(' and $%s/week', to_char((q->'week'->>'net')::numeric,'FM999,999,990.00')) else '' end,$q$);
  if position('weekly_total, light' in d) = 0 or position('coalesce((q->''week''->>''net'')::numeric, 0),' in d) = 0 or position('/mo%s.%s' in d) = 0 then raise exception 'proposal_send: no match'; end if;
  execute d;

  d := pg_get_functiondef('public.proposal_accept(text,text,text,boolean)'::regprocedure); b := d;
  d := replace(d, $q$setup_total, monthly_total, light,$q$, $q$setup_total, monthly_total, weekly_total, light,$q$);
  d := replace(d, $q$(q->'month'->>'net')::numeric,
          'accepted'$q$, $q$(q->'month'->>'net')::numeric, coalesce((q->'week'->>'net')::numeric, 0),
          'accepted'$q$);
  d := replace(d, $q$'Proposal version %s ACCEPTED by %s on the client link: $%s due at signing, $%s/mo.%s', p.version, p.accepted_name,
      to_char((q->'setup'->>'net')::numeric,'FM999,999,990'), to_char((q->'month'->>'net')::numeric,'FM999,999,990'),$q$,
    $q$'Proposal version %s ACCEPTED by %s on the client link: $%s due at signing, $%s/mo%s.%s', p.version, p.accepted_name,
      to_char((q->'setup'->>'net')::numeric,'FM999,999,990'), to_char((q->'month'->>'net')::numeric,'FM999,999,990'),
      case when coalesce((q->'week'->>'net')::numeric, 0) > 0 then format(' and $%s/week', to_char((q->'week'->>'net')::numeric,'FM999,999,990.00')) else '' end,$q$);
  if position('weekly_total, light' in d) = 0 or position('coalesce((q->''week''->>''net'')::numeric, 0),' in d) = 0 or position('/mo%s.%s' in d) = 0 then raise exception 'proposal_accept: no match'; end if;
  execute d;
end $$;
