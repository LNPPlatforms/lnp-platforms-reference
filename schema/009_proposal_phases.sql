-- 009: proposal phases (Oct 16, 2026).
-- Every line sits in a numbered phase (items.lic_ph, items.cs.ph, items.ex.ph, items.<list>[i].ph; default 1).
-- The client accepts and pays for Phase 1. Later phases are price-locked for items.lock_months (default 6)
-- from acceptance and are started one at a time from the CRM. Each phase must pass the margin rules on its own.
-- Pages pull the license into their phase or earlier. Partner rate and hosting coverage count only pages
-- in the same phase or an earlier one, so moving a page later can never make an earlier phase cheaper.
-- The client can rearrange lines on their link; that's saved as a suggestion (client_plan) for the rep to apply.
-- Setup is judged per phase on its own; monthly is judged on the running bill through each phase.

alter table public.proposals add column if not exists client_plan jsonb;
alter table public.proposals add column if not exists client_plan_notified_at timestamptz;
alter table public.proposals add column if not exists phase_starts jsonb not null default '{}'::jsonb;

-- a phase number from any json value (1 to 9, default 1)
create or replace function private.ph_clean(v jsonb) returns int
language sql immutable set search_path = pg_catalog as $$
  select case when jsonb_typeof(v) = 'number' then greatest(1, least(9, floor((v)::text::numeric)::int))
              when jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^\d{1,2}$' then greatest(1, least(9, (v #>> '{}')::int))
              else 1 end
$$;

-- lights for one phase: same rules as before, now reusable per phase
create or replace function private.proposal_eval(st private.proposal_settings, s_p numeric, s_c numeric, m_p numeric, m_c numeric, d_s numeric, d_m numeric)
returns jsonb language plpgsql immutable set search_path = public, private as $$
declare s_net numeric; m_net numeric; res numeric := st.commission_reserve; s_md numeric; m_md numeric; s_mg numeric; m_mg numeric;
  l_s text; l_m text; l_final text; shortfall numeric; excess numeric; payback jsonb := null; s_hit numeric := 0; m_hit numeric := 0;
  ord constant text[] := array['none','green','yellow','red','blocked'];
begin
  s_net := round(s_p*(1-d_s), 2); m_net := round(m_p*(1-d_m), 2);
  s_md := s_net - s_net*res - s_c; m_md := m_net - m_net*res - m_c;
  s_mg := case when s_net > 0 then s_md/s_net end; m_mg := case when m_net > 0 then m_md/m_net end;
  l_s := case when s_mg is null then 'none' when s_mg >= st.green then 'green' when s_mg >= st.yellow then 'yellow' when s_mg >= st.red then 'red' else 'blocked' end;
  l_m := case when m_mg is null then 'none' when m_mg >= st.green then 'green' when m_mg >= st.yellow then 'yellow' when m_mg >= st.red then 'red' else 'blocked' end;
  l_final := l_s;
  if l_s in ('red','blocked') and m_mg is not null then
    shortfall := s_net*st.green - s_md;
    excess := m_md - m_net*st.green;
    if excess > 0 and shortfall/excess <= st.payback_months then
      payback := jsonb_build_object('months', ceil(shortfall/excess), 'fee', round(shortfall*2), 'term', st.min_term_months);
      l_final := 'red';
    end if;
  end if;
  if l_final = 'red' and payback is null then s_hit := (st.yellow - s_mg)/2; end if;
  if l_m = 'red' then m_hit := (st.yellow - m_mg)/2; end if;
  return jsonb_build_object('s_p', s_p, 's_c', s_c, 'm_p', m_p, 'm_c', m_c, 's_net', s_net, 'm_net', m_net,
    's_md', s_md, 'm_md', m_md, 's_mg', s_mg, 'm_mg', m_mg, 'l_s', l_final, 'l_m', l_m,
    'overall', ord[greatest(array_position(ord, l_final), array_position(ord, l_m))],
    'blocked', l_final = 'blocked' or l_m = 'blocked', 'payback', payback, 's_hit', s_hit, 'm_hit', m_hit,
    'shortfall', shortfall, 'excess', excess);
end $$;

-- apply a client's phase plan {"lic":1,"cs":2,"pages:<id>":2,...} to items
create or replace function private.proposal_apply_plan(it jsonb, plan jsonb) returns jsonb
language plpgsql immutable set search_path = public, private as $$
declare out jsonb := coalesce(it, '{}'::jsonb); k text; arr jsonb; i int; key text;
begin
  if plan is null or jsonb_typeof(plan) <> 'object' then return out; end if;
  if plan ? 'lic' then out := jsonb_set(out, '{lic_ph}', to_jsonb(private.ph_clean(plan->'lic'))); end if;
  if plan ? 'cs' and jsonb_typeof(out->'cs') = 'object' then out := jsonb_set(out, '{cs,ph}', to_jsonb(private.ph_clean(plan->'cs'))); end if;
  if plan ? 'ex' and jsonb_typeof(out->'ex') = 'object' then out := jsonb_set(out, '{ex,ph}', to_jsonb(private.ph_clean(plan->'ex'))); end if;
  foreach k in array array['pages','tSites','tFunnels','cFunnels'] loop
    arr := out->k;
    if jsonb_typeof(arr) <> 'array' then continue; end if;
    for i in 0 .. jsonb_array_length(arr) - 1 loop
      key := k || ':' || coalesce(arr->i->>'id', i::text);
      if plan ? key then arr := jsonb_set(arr, array[i::text, 'ph'], to_jsonb(private.ph_clean(plan->key))); end if;
    end loop;
    out := jsonb_set(out, array[k], arr);
  end loop;
  return out;
end $$;

-- the override signature now also covers which phase each line is in
create or replace function private.proposal_price_sig(it jsonb) returns text
language sql immutable set search_path = pg_catalog as $$
  select md5(jsonb_build_object(
    'lic', coalesce(it->'lic','false'::jsonb),
    'pages', jsonb_array_length(coalesce(it->'pages','[]'::jsonb)),
    'tSites', jsonb_array_length(coalesce(it->'tSites','[]'::jsonb)),
    'tFunnels', jsonb_array_length(coalesce(it->'tFunnels','[]'::jsonb)),
    'cFunnels', jsonb_array_length(coalesce(it->'cFunnels','[]'::jsonb)),
    'cs', case when coalesce((it->'cs'->>'on')::boolean,false) then it->'cs'->'hrs' end,
    'ex', case when coalesce((it->'ex'->>'on')::boolean,false) then it->'ex'->'hrs' end,
    'disc', it->'disc',
    'ph', jsonb_build_array(it->'lic_ph', it->'cs'->'ph', it->'ex'->'ph',
      (select jsonb_agg(x->'ph') from jsonb_array_elements(coalesce(it->'pages','[]'::jsonb)) x),
      (select jsonb_agg(x->'ph') from jsonb_array_elements(coalesce(it->'tSites','[]'::jsonb)) x),
      (select jsonb_agg(x->'ph') from jsonb_array_elements(coalesce(it->'tFunnels','[]'::jsonb)) x),
      (select jsonb_agg(x->'ph') from jsonb_array_elements(coalesce(it->'cFunnels','[]'::jsonb)) x)))::text)
$$;

-- the pricing engine, phase aware. With everything in Phase 1 it returns exactly what it did before.
create or replace function private.proposal_quote(p public.proposals, p_mode text, p_viewer uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
#variable_conflict use_column
declare
  st private.proposal_settings;
  pb jsonb;
  it jsonb := coalesce(p.items, '{}'::jsonb);
  lic boolean := coalesce((it->>'lic')::boolean, false);
  pages jsonb := coalesce(it->'pages', '[]'::jsonb);
  tsites jsonb := coalesce(it->'tSites', '[]'::jsonb);
  tfun jsonb := coalesce(it->'tFunnels', '[]'::jsonb);
  cfun jsonb := coalesce(it->'cFunnels', '[]'::jsonb);
  cs_on boolean := coalesce((it->'cs'->>'on')::boolean, false);
  ex_on boolean := coalesce((it->'ex'->>'on')::boolean, false);
  cs_hrs int; ex_hrs int;
  lic_raw int; cs_raw int := private.ph_clean(it->'cs'->'ph'); ex_raw int := private.ph_clean(it->'ex'->'ph');
  rawph int[]; k int; n int;
  lic_c int; cs_c int; ex_c int;
  page_c int[]; unit_c int[];          -- compact phase of each page, and of each site or funnel
  lines jsonb := '[]'::jsonb; x jsonb; o int; ln jsonb;
  pages_n int; units_n int; cov_n int; paid_n int; host_n numeric; partner_n boolean;
  u_prev int := 0; cov_prev int := 0; host_prev numeric := 0;
  units int := 0; covered int := 0; paid int := 0; host numeric := 0;
  d_s numeric; d_m numeric;
  ev jsonb; e1 jsonb; evs jsonb := '[]'::jsonb; phases jsonb := '[]'::jsonb; plights jsonb := '[]'::jsonb; padm jsonb := '[]'::jsonb;
  s_p numeric; s_c numeric; m_p numeric; m_c numeric; mc_p numeric; mc_c numeric; m_alone numeric; plan_s numeric := 0; plan_m numeric := 0;
  overall text := 'none'; blocked boolean := false; payback jsonb;
  dev_pending boolean; overridden boolean; expired boolean; acceptable boolean;
  co record; lead_user uuid; lead_rate numeric; lead_label text; closer record;
  comm jsonb := null; adm jsonb := null; out jsonb; tgt text;
  ord constant text[] := array['none','green','yellow','red','blocked'];
begin
  select * into st from private.proposal_settings where tenant_id = p.tenant_id;
  select jsonb_object_agg(key, to_jsonb(b)) into pb from private.proposal_price_book b where tenant_id = p.tenant_id;
  cs_hrs := greatest(1, coalesce((it->'cs'->>'hrs')::int, st.site_default_hours));
  ex_hrs := greatest(1, coalesce((it->'ex'->>'hrs')::int, 1));
  dev_pending := private.proposal_dev_sig(it) is not null and private.proposal_dev_sig(it) is distinct from p.dev_sig;
  if not lic then pages := '[]'::jsonb; end if;      -- pages need the license
  -- the license sits in its own phase or with the earliest page, whichever is first
  lic_raw := least(private.ph_clean(it->'lic_ph'), coalesce((select min(private.ph_clean(x->'ph')) from jsonb_array_elements(pages) x), 9));

  -- phases in use, numbered 1..k with no gaps
  select array_agg(distinct v order by v) into rawph from (
    select lic_raw v where lic
    union all select private.ph_clean(x->'ph') from jsonb_array_elements(pages) x
    union all select private.ph_clean(x->'ph') from jsonb_array_elements(tsites) x
    union all select private.ph_clean(x->'ph') from jsonb_array_elements(tfun) x
    union all select private.ph_clean(x->'ph') from jsonb_array_elements(cfun) x
    union all select cs_raw where cs_on
    union all select ex_raw where ex_on) s;
  rawph := coalesce(rawph, array[1]);
  k := array_length(rawph, 1);
  lic_c := coalesce(array_position(rawph, lic_raw), 1);
  cs_c := coalesce(array_position(rawph, cs_raw), 1);
  ex_c := coalesce(array_position(rawph, ex_raw), 1);
  select coalesce(array_agg(array_position(rawph, private.ph_clean(x->'ph')) order by o), '{}') into page_c from jsonb_array_elements(pages) with ordinality t(x, o);
  select coalesce(array_agg(c), '{}') into unit_c from (
    select array_position(rawph, private.ph_clean(x->'ph')) c from jsonb_array_elements(tsites) x
    union all select array_position(rawph, private.ph_clean(x->'ph')) from jsonb_array_elements(tfun) x
    union all select array_position(rawph, private.ph_clean(x->'ph')) from jsonb_array_elements(cfun) x
    union all select cs_c where cs_on) u;

  -- lines
  if lic then
    lines := lines || jsonb_build_array(jsonb_build_object('key','lic','lk','lic','ph',lic_c,'bucket','rlx','title',pb->'lic'->>'title','desc',pb->'lic'->>'description',
      'setup',0,'mo',(pb->'lic'->>'monthly_price')::numeric,'setup_cost',0,'mo_cost',(pb->'lic'->>'monthly_cost')::numeric));
    for x, o in select * from jsonb_array_elements(pages) with ordinality loop
      lines := lines || jsonb_build_array(jsonb_build_object('key','page','lk','pages:' || coalesce(x->>'id', (o-1)::text),'ph',page_c[o],'bucket','rlx',
        'title',coalesce(nullif(x->>'name',''),pb->'page'->>'title'),
        'sub',nullif(x->>'desc',''),'mockups',coalesce(x->'mockups','[]'::jsonb),'desc',pb->'page'->>'description',
        'setup',(pb->'page'->>'setup_price')::numeric,'mo',(pb->'page'->>'monthly_price')::numeric,
        'setup_cost',(pb->'page'->>'setup_cost')::numeric,'mo_cost',(pb->'page'->>'monthly_cost')::numeric));
    end loop;
  end if;
  for x, o in select * from jsonb_array_elements(tsites) with ordinality loop
    lines := lines || jsonb_build_array(jsonb_build_object('key','tSite','lk','tSites:' || coalesce(x->>'id', (o-1)::text),'ph',array_position(rawph, private.ph_clean(x->'ph')),
      'bucket','template','title',coalesce(nullif(x->>'name',''),pb->'tSite'->>'title'),
      'sub',nullif(x->>'desc',''),'note',nullif(x->>'note',''),'mockups',coalesce(x->'mockups','[]'::jsonb),'desc',pb->'tSite'->>'description',
      'setup',(pb->'tSite'->>'setup_price')::numeric,'mo',0,'setup_cost',(pb->'tSite'->>'setup_cost')::numeric,'mo_cost',0));
  end loop;
  for x, o in select * from jsonb_array_elements(tfun) with ordinality loop
    lines := lines || jsonb_build_array(jsonb_build_object('key','tFunnel','lk','tFunnels:' || coalesce(x->>'id', (o-1)::text),'ph',array_position(rawph, private.ph_clean(x->'ph')),
      'bucket','template','title',coalesce(nullif(x->>'name',''),pb->'tFunnel'->>'title'),
      'sub',nullif(x->>'desc',''),'note',nullif(x->>'note',''),'mockups',coalesce(x->'mockups','[]'::jsonb),'desc',pb->'tFunnel'->>'description',
      'setup',(pb->'tFunnel'->>'setup_price')::numeric,'mo',0,'setup_cost',(pb->'tFunnel'->>'setup_cost')::numeric,'mo_cost',0));
  end loop;
  if cs_on then
    -- partner rate only when a Referralogix page is in the same phase or earlier
    partner_n := exists (select 1 from unnest(page_c) c where c <= cs_c);
    lines := lines || jsonb_build_array(jsonb_build_object('key','cSite','lk','cs','ph',cs_c,'bucket','custom','title',coalesce(nullif(it->'cs'->>'name',''),pb->'cSite'->>'title'),
      'sub',nullif(it->'cs'->>'desc',''),'note',nullif(it->'cs'->>'note',''),'mockups',coalesce(it->'cs'->'mockups','[]'::jsonb),'desc',pb->'cSite'->>'description',
      'qty',format('%s hrs at $%s/hr', cs_hrs, case when partner_n then st.rate_partner else st.rate_standard end),'est',dev_pending,
      'setup',cs_hrs*(case when partner_n then st.rate_partner else st.rate_standard end),'mo',0,'setup_cost',cs_hrs*st.labor_cost,'mo_cost',0));
  end if;
  for x, o in select * from jsonb_array_elements(cfun) with ordinality loop
    lines := lines || jsonb_build_array(jsonb_build_object('key','cFunnel','lk','cFunnels:' || coalesce(x->>'id', (o-1)::text),'ph',array_position(rawph, private.ph_clean(x->'ph')),
      'bucket','custom','title',coalesce(nullif(x->>'name',''),pb->'cFunnel'->>'title'),
      'sub',nullif(x->>'desc',''),'note',nullif(x->>'note',''),'mockups',coalesce(x->'mockups','[]'::jsonb),'desc',pb->'cFunnel'->>'description','est',dev_pending,
      'setup',(pb->'cFunnel'->>'setup_price')::numeric,'mo',0,'setup_cost',(pb->'cFunnel'->>'setup_cost')::numeric,'mo_cost',0));
  end loop;

  -- hosting, phase by phase: what each phase adds to the running hosting bill
  for n in 1 .. k loop
    pages_n := (select count(*) from unnest(page_c) c where c <= n);
    units_n := (select count(*) from unnest(unit_c) c where c <= n);
    partner_n := lic and pages_n > 0;
    cov_n := least(pages_n, units_n); paid_n := units_n - cov_n;
    host_n := case when paid_n > 0 then case when partner_n then paid_n*st.host_partner else st.host_first + (paid_n-1)*st.host_next end else 0 end;
    if units_n > u_prev or host_n <> host_prev then
      lines := lines || jsonb_build_array(jsonb_build_object('key','host','ph',n,'bucket','ongoing','title',pb->'host'->>'title','desc',pb->'host'->>'description',
        'qty', case when units_n > u_prev then
                 (units_n - u_prev)::text || case when units_n - u_prev > 1 then ' sites or funnels' else ' site or funnel' end
                 || case when cov_n - cov_prev > 0 then format(', %s included with your Referralogix %s', cov_n - cov_prev, case when cov_n - cov_prev > 1 then 'pages' else 'page' end) else '' end
               else 'Adjustment: hosting is now included with your Referralogix pages' end,
        'setup',0,'mo',host_n - host_prev,'setup_cost',0,'mo_cost',(units_n - u_prev)*st.host_unit_cost));
    end if;
    u_prev := units_n; cov_prev := cov_n; host_prev := host_n;
  end loop;
  units := u_prev; covered := cov_prev; host := host_prev; paid := units - covered;
  if ex_on then
    partner_n := exists (select 1 from unnest(page_c) c where c <= ex_c);
    lines := lines || jsonb_build_array(jsonb_build_object('key','ex','lk','ex','ph',ex_c,'bucket','ongoing','title',pb->'ex'->>'title','desc',pb->'ex'->>'description',
      'qty',format('%s hrs at $%s/hr', ex_hrs, case when partner_n then st.rate_partner else st.rate_standard end),'setup',0,
      'mo',ex_hrs*(case when partner_n then st.rate_partner else st.rate_standard end),'setup_cost',0,'mo_cost',ex_hrs*st.labor_cost));
  end if;

  -- each phase is judged on its own
  d_s := least(100, greatest(0, coalesce((it->'disc'->>'setup')::numeric,0))) / 100;
  d_m := least(100, greatest(0, coalesce((it->'disc'->>'month')::numeric,0))) / 100;
  for n in 1 .. k loop
    -- setup is judged on this phase alone; monthly on the running bill through this phase
    select coalesce(sum((l->>'setup')::numeric) filter (where (l->>'ph')::int = n),0), coalesce(sum((l->>'setup_cost')::numeric) filter (where (l->>'ph')::int = n),0),
           coalesce(sum((l->>'mo')::numeric) filter (where (l->>'ph')::int = n),0), coalesce(sum((l->>'mo_cost')::numeric) filter (where (l->>'ph')::int = n),0),
           coalesce(sum((l->>'mo')::numeric),0), coalesce(sum((l->>'mo_cost')::numeric),0)
      into s_p, s_c, m_p, m_c, mc_p, mc_c from jsonb_array_elements(lines) l where (l->>'ph')::int <= n;
    ev := private.proposal_eval(st, s_p, s_c, mc_p, mc_c, d_s, d_m);
    m_alone := round(m_p*(1-d_m), 2);
    if n = 1 then e1 := ev; end if;
    evs := evs || jsonb_build_array(ev);
    plan_s := plan_s + (ev->>'s_net')::numeric; plan_m := plan_m + m_alone;
    overall := ord[greatest(array_position(ord, overall), array_position(ord, ev->>'overall'))];
    blocked := blocked or (ev->>'blocked')::boolean;
    tgt := nullif(trim(it->'phases'->(n-1)->>'target'), '');
    phases := phases || jsonb_build_array(jsonb_build_object('n', n, 'target', tgt,
      'setup', jsonb_build_object('gross', s_p, 'disc', s_p - (ev->>'s_net')::numeric, 'net', (ev->>'s_net')::numeric),
      'month', jsonb_build_object('gross', m_p, 'disc', m_p - m_alone, 'net', m_alone),
      'payback', ev->'payback'));
    plights := plights || jsonb_build_array(jsonb_build_object('n', n, 'setup', ev->>'l_s', 'month', ev->>'l_m', 'overall', ev->>'overall',
      'blocked', (ev->>'blocked')::boolean, 'setup_hit', (ev->>'s_hit')::numeric, 'month_hit', (ev->>'m_hit')::numeric));
    padm := padm || jsonb_build_array(jsonb_build_object('n', n,
      'setup', jsonb_build_object('cost', s_c, 'profit', (ev->>'s_md')::numeric, 'margin', (ev->>'s_mg')::numeric, 'disc', s_p - (ev->>'s_net')::numeric),
      'month', jsonb_build_object('cost', m_c, 'profit', m_alone - m_alone*st.commission_reserve - m_c,
        'margin', case when m_alone > 0 then (m_alone - m_alone*st.commission_reserve - m_c)/m_alone end, 'disc', m_p - m_alone,
        'run_margin', (ev->>'m_mg')::numeric),
      'payback_detail', case when ev->'payback' <> 'null'::jsonb then jsonb_build_object('shortfall', (ev->>'shortfall')::numeric, 'excess', (ev->>'excess')::numeric) end));
  end loop;
  payback := case when e1->'payback' = 'null'::jsonb then null else e1->'payback' end;

  overridden := blocked and p.override_reason is not null and p.override_sig = private.proposal_price_sig(it);
  expired := p.status <> 'accepted' and p.expires_at < now();
  acceptable := p.status <> 'accepted' and not expired and not dev_pending and (not blocked or overridden) and jsonb_array_length(lines) > 0;

  -- Phase 1 is what's signed and paid now. 'plan' is everything once every phase is running.
  out := jsonb_build_object(
    'lines', (select coalesce(jsonb_agg(l - 'setup_cost' - 'mo_cost'), '[]'::jsonb) from jsonb_array_elements(lines) l),
    'partner', lic and cardinality(page_c) > 0,
    'rate', case when lic and cardinality(page_c) > 0 then st.rate_partner else st.rate_standard end,
    'cs_rate', case when exists (select 1 from unnest(page_c) c where c <= cs_c) then st.rate_partner else st.rate_standard end,
    'ex_rate', case when exists (select 1 from unnest(page_c) c where c <= ex_c) then st.rate_partner else st.rate_standard end,
    'hosting', jsonb_build_object('units', units, 'covered', covered, 'paid', paid, 'mo', host),
    'setup', jsonb_build_object('gross', (e1->>'s_p')::numeric, 'disc', (e1->>'s_p')::numeric - (e1->>'s_net')::numeric, 'net', (e1->>'s_net')::numeric, 'pct', d_s*100),
    'month', jsonb_build_object('gross', (e1->>'m_p')::numeric, 'disc', (e1->>'m_p')::numeric - (e1->>'m_net')::numeric, 'net', (e1->>'m_net')::numeric, 'pct', d_m*100),
    'phases', phases, 'plan', jsonb_build_object('setup', plan_s, 'month', plan_m),
    'lock_months', greatest(1, least(24, coalesce(case when it->>'lock_months' ~ '^\d{1,2}$' then (it->>'lock_months')::int end, 6))),
    'payback', payback, 'dev_pending', dev_pending, 'expired', expired, 'acceptable', acceptable,
    'blocked', blocked and not overridden);
  if p_mode = 'client' then return out; end if;

  -- internal: traffic lights, review state, commission for the viewer
  select c.* into co from companies c where c.id = p.company_id;
  select id, full_name, sales_rate into closer from app_users where id = p.owner_id;
  if co.lead_source_partner_id is not null then
    select coalesce(lead_gen_rate, st.default_lead_rate), name || ' (referral)' into lead_rate, lead_label from companies where id = co.lead_source_partner_id;
  elsif co.lead_source_id is not null then
    lead_user := co.lead_source_id;
    select a.lead_rate, a.full_name into lead_rate, lead_label from app_users a where a.id = lead_user;
  elsif co.lead_source_kind is not null then
    lead_rate := st.default_lead_rate; lead_label := 'Automated';
  end if;
  comm := jsonb_build_object(
    'is_closer', p_viewer = p.owner_id,
    'sales_rate', case when p_viewer = p.owner_id then closer.sales_rate end,
    'sales_setup_rate', case when p_viewer = p.owner_id then greatest(0, closer.sales_rate - (e1->>'s_hit')::numeric) end,
    'sales_month_rate', case when p_viewer = p.owner_id then greatest(0, closer.sales_rate - (e1->>'m_hit')::numeric) end,
    'lead', case when lead_rate is null then 'ask' when lead_user is not null and lead_user = p_viewer then 'mine' else 'elsewhere' end,
    'lead_rate', case when lead_user is not null and lead_user = p_viewer then lead_rate end);
  out := out || jsonb_build_object(
    'light', jsonb_build_object('setup', e1->>'l_s', 'month', e1->>'l_m', 'overall', overall, 'blocked', blocked, 'overridden', overridden,
                                'setup_hit', (e1->>'s_hit')::numeric, 'month_hit', (e1->>'m_hit')::numeric),
    'phase_lights', plights,
    'comm', comm,
    'lead_set', lead_rate is not null);
  if p_mode = 'admin' then
    adm := jsonb_build_object(
      'lines', lines, 'reserve', st.commission_reserve,
      'setup', jsonb_build_object('cost', (e1->>'s_c')::numeric, 'profit', (e1->>'s_md')::numeric, 'margin', (e1->>'s_mg')::numeric),
      'month', jsonb_build_object('cost', (e1->>'m_c')::numeric, 'profit', (e1->>'m_md')::numeric, 'margin', (e1->>'m_mg')::numeric),
      'phases', padm,
      'closer', closer.full_name, 'closer_rate', closer.sales_rate,
      'lead_label', lead_label, 'lead_rate', lead_rate,
      'payback_detail', case when payback is not null then jsonb_build_object('shortfall', (e1->>'shortfall')::numeric, 'excess', (e1->>'excess')::numeric) end);
    out := out || jsonb_build_object('admin', adm);
  end if;
  return out;
end $$;
revoke execute on function private.proposal_quote(public.proposals, text, uuid) from public, anon, authenticated;
revoke execute on function private.proposal_eval(private.proposal_settings, numeric, numeric, numeric, numeric, numeric, numeric) from public, anon, authenticated;
revoke execute on function private.proposal_apply_plan(jsonb, jsonb) from public, anon, authenticated;

-- guard: phase starts only through the button
create or replace function private.guard_proposal() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare rpc boolean := coalesce(current_setting('app.proposal_rpc', true), '') = '1';
        adm boolean := private.is_admin();
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.tenant_id := private.current_tenant();
    if not adm then new.owner_id := auth.uid(); end if;
    new.status := 'draft'; new.version := 0; new.override_reason := null; new.override_sig := null; new.override_by := null;
    new.dev_sig := null; new.dev_by := null; new.accepted_at := null; new.accepted_name := null; new.accepted_email := null;
    new.accepted_ip := null; new.accepted_agent := null; new.accepted_version := null; new.sent_at := null;
    new.client_plan := null; new.phase_starts := '{}'::jsonb;
    new.expires_at := now() + make_interval(days => (select expire_days from private.proposal_settings where tenant_id = new.tenant_id));
    return new;
  end if;
  if rpc then return new; end if;
  if new.tenant_id <> old.tenant_id or new.share_token <> old.share_token or new.company_id <> old.company_id then
    raise exception 'That cannot be changed on a proposal';
  end if;
  if not adm and new.owner_id <> old.owner_id then raise exception 'Only an admin can reassign a proposal'; end if;
  if not adm and (new.override_reason is distinct from old.override_reason or new.override_sig is distinct from old.override_sig
                  or new.dev_sig is distinct from old.dev_sig) then
    raise exception 'Only an admin can approve estimates or override a blocked deal';
  end if;
  if new.version <> old.version or new.sent_at is distinct from old.sent_at or new.expires_at is distinct from old.expires_at
     or new.accepted_at is distinct from old.accepted_at or new.accepted_name is distinct from old.accepted_name
     or new.accepted_version is distinct from old.accepted_version or new.accepted_ip is distinct from old.accepted_ip
     or new.phase_starts is distinct from old.phase_starts then
    raise exception 'Send, accept and phase starts go through the proposal buttons';
  end if;
  -- the rep can clear the client's suggestion, never write one
  if new.client_plan is distinct from old.client_plan and new.client_plan is not null then
    raise exception 'Only the client can suggest a phase plan';
  end if;
  if new.status <> old.status and not (old.status = 'accepted' and new.status = 'draft') then
    raise exception 'Send and accept go through the proposal buttons';
  end if;
  if old.status = 'accepted' and new.status = 'accepted' and new.items is distinct from old.items then
    raise exception 'This proposal is accepted and locked. Start a revision to change it.';
  end if;
  return new;
end $$;

-- client link: optional preview plan, the client's saved suggestion, rep name, phase starts
-- proposal_view(token, plan) previews a plan without saving; proposal_public(token) stays as the plain view.
create or replace function public.proposal_view(p_token text, p_plan jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare p public.proposals; c record; logo text; acc jsonb; acc_items jsonb; rep text; plan jsonb; q jsonb;
begin
  if p_token is null or length(p_token) < 32 then return null; end if;
  select * into p from proposals where share_token = p_token;
  if not found then return null; end if;
  select name, logo_media_id into c from companies where id = p.company_id;
  select url into logo from media where id = c.logo_media_id and archived_at is null;
  select split_part(trim(full_name), ' ', 1) into rep from app_users where id = p.owner_id;
  if p.status = 'accepted' then
    select quote, items into acc, acc_items from proposal_versions where proposal_id = p.id and version = p.accepted_version;
    q := acc;
  else
    plan := case when jsonb_typeof(p_plan) = 'object' then p_plan else p.client_plan->'plan' end;
    if plan is not null then p.items := private.proposal_apply_plan(p.items, plan); end if;
    q := private.proposal_quote(p, 'client');
    if plan is not null then q := q || jsonb_build_object('acceptable', false); end if;   -- a changed plan goes to the rep first
  end if;
  return jsonb_build_object(
    'org', c.name, 'logo', logo, 'contact_name', p.contact_name, 'contact_email', p.contact_email, 'rep', nullif(rep, ''),
    'status', p.status, 'version', p.version, 'expires_at', p.expires_at, 'updated_at', p.updated_at,
    'note', nullif(coalesce(acc_items, p.items)->>'note_shared',''),
    'mockups', coalesce(coalesce(acc_items, p.items)->'mockups', '[]'::jsonb),
    'client_plan', case when p.status <> 'accepted' and p.client_plan is not null then p.client_plan end,
    'preview', jsonb_typeof(p_plan) = 'object',
    'accepted', case when p.status = 'accepted' then jsonb_build_object('name', p.accepted_name, 'email', p.accepted_email,
       'at', p.accepted_at, 'version', p.accepted_version) end,
    'phase_starts', case when p.status = 'accepted' then p.phase_starts end,
    'quote', q);
end $$;
revoke execute on function public.proposal_view(text, jsonb) from public;
grant execute on function public.proposal_view(text, jsonb) to anon, authenticated;

create or replace function public.proposal_public(p_token text) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select public.proposal_view(p_token, null)
$$;

-- client: save (or clear) a suggested phase plan. Only keys of lines on the proposal are kept.
create or replace function public.proposal_client_plan(p_token text, p_plan jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare p public.proposals; q jsonb; q2 jsonb; clean jsonb; same boolean;
begin
  if p_token is null or length(p_token) < 32 then raise exception 'Proposal not found'; end if;
  select * into p from proposals where share_token = p_token for update;
  if not found then raise exception 'Proposal not found'; end if;
  if p.status = 'accepted' then raise exception 'This proposal was already accepted'; end if;
  if p.expires_at < now() then raise exception 'This pricing has expired. Ask us for an updated proposal.'; end if;
  q := private.proposal_quote(p, 'client');
  if jsonb_typeof(p_plan) = 'object' then
    select jsonb_object_agg(e.key, private.ph_clean(e.value)) into clean
      from jsonb_each(p_plan) e
     where e.key in (select l->>'lk' from jsonb_array_elements(q->'lines') l where l ? 'lk');
  end if;
  if clean is not null then
    p.items := private.proposal_apply_plan(p.items, clean);
    q2 := private.proposal_quote(p, 'client');
    select bool_and(a.ph = b.ph) into same from
      (select l->>'lk' lk, (l->>'ph')::int ph from jsonb_array_elements(q->'lines') l where l ? 'lk') a
      join (select l->>'lk' lk, (l->>'ph')::int ph from jsonb_array_elements(q2->'lines') l where l ? 'lk') b using (lk);
    if coalesce(same, true) then clean := null; end if;   -- nothing actually moved
  end if;
  perform set_config('app.proposal_rpc', '1', true);
  update proposals set client_plan = case when clean is null then null else jsonb_build_object('plan', clean, 'at', now()) end
   where id = p.id;
  if clean is not null then
    insert into activities (company_id, type, body, created_by) values (p.company_id, 'note',
      format('%s suggested a different phase plan on the proposal link.', coalesce(nullif(p.contact_name, ''), 'The client')), p.owner_id);
  end if;
  return jsonb_build_object('ok', true, 'saved', clean is not null);
end $$;
revoke execute on function public.proposal_client_plan(text, jsonb) from public;
grant execute on function public.proposal_client_plan(text, jsonb) to anon, authenticated;

-- rep: start a later phase of an accepted proposal at the locked price
create or replace function public.proposal_start_phase(p_id uuid, p_phase int) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare p public.proposals; q jsonb; ph jsonb; lock_end timestamptz;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  select * into p from proposals where id = p_id and tenant_id = private.current_tenant() and (owner_id = auth.uid() or private.is_admin()) for update;
  if not found then raise exception 'Proposal not found'; end if;
  if p.status <> 'accepted' then raise exception 'Only an accepted proposal has phases to start'; end if;
  select quote into q from proposal_versions where proposal_id = p.id and version = p.accepted_version;
  ph := q->'phases'->(p_phase - 1);
  if p_phase < 2 or ph is null then raise exception 'That phase is not on the accepted proposal'; end if;
  if coalesce(p.phase_starts, '{}'::jsonb) ? p_phase::text then raise exception 'Phase % already started', p_phase; end if;
  lock_end := p.accepted_at + make_interval(months => coalesce((q->>'lock_months')::int, 6));
  if now() > lock_end and not private.is_admin() then
    raise exception 'The price lock ended on %. Start a revision to re-quote this phase, or ask an admin.', to_char(lock_end at time zone 'America/Chicago', 'FMMonth FMDD, YYYY');
  end if;
  perform set_config('app.proposal_rpc', '1', true);
  update proposals set phase_starts = coalesce(phase_starts, '{}'::jsonb) || jsonb_build_object(p_phase::text, now()) where id = p.id;
  insert into activities (company_id, type, body, created_by) values (p.company_id, 'note',
    format('Phase %s started at the locked price from version %s: $%s setup, $%s/mo added.', p_phase, p.accepted_version,
      to_char((ph->'setup'->>'net')::numeric,'FM999,999,990'), to_char((ph->'month'->>'net')::numeric,'FM999,999,990')), auth.uid());
  return jsonb_build_object('ok', true, 'phase', p_phase, 'setup', ph->'setup'->'net', 'month', ph->'month'->'net');
end $$;
revoke execute on function public.proposal_start_phase(uuid, int) from public, anon;
grant execute on function public.proposal_start_phase(uuid, int) to authenticated;

-- send: a new version replaces any plan the client suggested
create or replace function public.proposal_send(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare p public.proposals; q jsonb; qi jsonb; days int;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  select * into p from proposals where id = p_id and tenant_id = private.current_tenant() and (owner_id = auth.uid() or private.is_admin()) for update;
  if not found then raise exception 'Proposal not found'; end if;
  if p.status = 'accepted' then raise exception 'Already accepted. Start a revision first.'; end if;
  qi := private.proposal_quote(p, 'rep', auth.uid());
  if jsonb_array_length(qi->'lines') = 0 then raise exception 'Add at least one item before sending'; end if;
  if (qi->>'blocked')::boolean then raise exception 'A discount or phase is too deep to send. An admin can override it with a reason.'; end if;
  select expire_days into days from private.proposal_settings where tenant_id = p.tenant_id;
  perform set_config('app.proposal_rpc', '1', true);
  update proposals set version = version + 1, status = 'sent', sent_at = now(), expires_at = now() + make_interval(days => days), client_plan = null
   where id = p_id returning * into p;
  q := private.proposal_quote(p, 'client');
  insert into proposal_versions (tenant_id, proposal_id, company_id, version, items, quote, setup_total, monthly_total, light, override_reason, created_by)
  values (p.tenant_id, p.id, p.company_id, p.version, p.items, q, (q->'setup'->>'net')::numeric, (q->'month'->>'net')::numeric,
          qi->'light'->>'overall', case when (qi->'light'->>'overridden')::boolean then p.override_reason end, auth.uid());
  insert into activities (company_id, type, body) values (p.company_id, 'note',
    format('Proposal version %s sent: $%s due at signing, $%s/mo.%s', p.version, to_char((q->'setup'->>'net')::numeric,'FM999,999,990'),
      to_char((q->'month'->>'net')::numeric,'FM999,999,990'),
      case when jsonb_array_length(q->'phases') > 1 then format(' %s phases; full plan $%s setup, $%s/mo.', jsonb_array_length(q->'phases'),
        to_char((q->'plan'->>'setup')::numeric,'FM999,999,990'), to_char((q->'plan'->>'month')::numeric,'FM999,999,990')) else '' end));
  return jsonb_build_object('version', p.version, 'token', p.share_token, 'expires_at', p.expires_at);
end $$;

-- accept: accepts Phase 1 now; later phases are locked at these prices
create or replace function public.proposal_accept(p_token text, p_name text, p_email text, p_agree boolean) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare p public.proposals; q jsonb; hdr json; ip text; np int;
begin
  if not coalesce(p_agree, false) then raise exception 'Check the box to agree to the proposal and terms'; end if;
  if length(coalesce(trim(p_name), '')) < 3 then raise exception 'Type your full name to accept'; end if;
  select * into p from proposals where share_token = p_token for update;
  if not found then raise exception 'Proposal not found'; end if;
  if p.status <> 'accepted' and p.client_plan is not null then
    raise exception 'Your suggested phase plan is with us for review. Withdraw it to accept the proposal as sent.';
  end if;
  q := private.proposal_quote(p, 'client');
  if not (q->>'acceptable')::boolean then
    raise exception '%', case when p.status = 'accepted' then 'This proposal was already accepted'
      when (q->>'expired')::boolean then 'This pricing has expired. Ask us for an updated proposal.'
      when (q->>'dev_pending')::boolean then 'Our development team is still reviewing the estimate'
      else 'This proposal is still being finalized' end;
  end if;
  hdr := nullif(current_setting('request.headers', true), '')::json;
  ip := trim(split_part(coalesce(hdr->>'x-forwarded-for', hdr->>'x-real-ip', ''), ',', 1));
  perform set_config('app.proposal_rpc', '1', true);
  update proposals set version = version + 1, status = 'accepted', accepted_at = now(), accepted_name = trim(p_name),
    accepted_email = coalesce(nullif(trim(p_email), ''), contact_email), accepted_ip = nullif(ip, ''),
    accepted_agent = left(hdr->>'user-agent', 300), accepted_version = version + 1, sent_at = coalesce(sent_at, now()),
    client_plan = null, phase_starts = '{}'::jsonb
   where id = p.id returning * into p;
  q := private.proposal_quote(p, 'client');
  np := jsonb_array_length(q->'phases');
  insert into proposal_versions (tenant_id, proposal_id, company_id, version, items, quote, setup_total, monthly_total, light, override_reason, accepted, created_by)
  values (p.tenant_id, p.id, p.company_id, p.version, p.items, q, (q->'setup'->>'net')::numeric, (q->'month'->>'net')::numeric,
          'accepted', p.override_reason, true, null);
  insert into activities (company_id, type, body, created_by) values (p.company_id, 'note',
    format('Proposal version %s ACCEPTED by %s on the client link: $%s due at signing, $%s/mo.%s', p.version, p.accepted_name,
      to_char((q->'setup'->>'net')::numeric,'FM999,999,990'), to_char((q->'month'->>'net')::numeric,'FM999,999,990'),
      case when np > 1 then format(' That is Phase 1 of %s. Later phases are price-locked for %s months.', np, q->>'lock_months') else '' end), p.owner_id);
  return jsonb_build_object('ok', true, 'version', p.version);
end $$;
