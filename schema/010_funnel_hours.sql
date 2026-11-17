-- 010: custom funnels billed by the hour (Oct 16, 2026).
-- Custom funnels are priced like the custom website: hours x rate, at the partner rate only when a Referralogix
-- page is in the same phase or earlier (a page on hold in a later phase doesn't count). New funnels start at
-- proposal_settings.funnel_default_hours (18). The client sees custom builds as one flat price; hours and rate
-- show only inside the CRM.

alter table private.proposal_settings add column if not exists funnel_default_hours int not null default 18;

create or replace function private.proposal_dev_sig(it jsonb) returns text
language sql immutable set search_path = pg_catalog as $$
  select case when coalesce((it->'cs'->>'on')::boolean,false) or jsonb_array_length(coalesce(it->'cFunnels','[]'::jsonb)) > 0
    then md5(jsonb_build_object(
      'cs', case when coalesce((it->'cs'->>'on')::boolean,false) then jsonb_build_object('hrs', it->'cs'->'hrs', 'desc', it->'cs'->'desc') end,
      'cf', (select jsonb_agg(case when x ? 'hrs' then jsonb_build_array(x->'desc', x->'hrs') else x->'desc' end) from jsonb_array_elements(coalesce(it->'cFunnels','[]'::jsonb)) x))::text)
  end
$$;

create or replace function private.proposal_price_sig(it jsonb) returns text
language sql immutable set search_path = pg_catalog as $$
  select md5(jsonb_build_object(
    'lic', coalesce(it->'lic','false'::jsonb),
    'pages', jsonb_array_length(coalesce(it->'pages','[]'::jsonb)),
    'tSites', jsonb_array_length(coalesce(it->'tSites','[]'::jsonb)),
    'tFunnels', jsonb_array_length(coalesce(it->'tFunnels','[]'::jsonb)),
    'cFunnels', jsonb_array_length(coalesce(it->'cFunnels','[]'::jsonb)),
    'cfhrs', (select jsonb_agg(x->'hrs') from jsonb_array_elements(coalesce(it->'cFunnels','[]'::jsonb)) x),
    'cs', case when coalesce((it->'cs'->>'on')::boolean,false) then it->'cs'->'hrs' end,
    'ex', case when coalesce((it->'ex'->>'on')::boolean,false) then it->'ex'->'hrs' end,
    'disc', it->'disc',
    'ph', jsonb_build_array(it->'lic_ph', it->'cs'->'ph', it->'ex'->'ph',
      (select jsonb_agg(x->'ph') from jsonb_array_elements(coalesce(it->'pages','[]'::jsonb)) x),
      (select jsonb_agg(x->'ph') from jsonb_array_elements(coalesce(it->'tSites','[]'::jsonb)) x),
      (select jsonb_agg(x->'ph') from jsonb_array_elements(coalesce(it->'tFunnels','[]'::jsonb)) x),
      (select jsonb_agg(x->'ph') from jsonb_array_elements(coalesce(it->'cFunnels','[]'::jsonb)) x)))::text)
$$;

create or replace function public.proposal_price_list() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.is_internal() then (
    select jsonb_build_object(
      'items', (select jsonb_object_agg(key, jsonb_build_object('title', title, 'setup', setup_price, 'mo', monthly_price)) from private.proposal_price_book where tenant_id = private.current_tenant()),
      'rate_partner', s.rate_partner, 'rate_standard', s.rate_standard, 'host_first', s.host_first, 'host_next', s.host_next,
      'host_partner', s.host_partner, 'site_default_hours', s.site_default_hours, 'funnel_default_hours', s.funnel_default_hours, 'expire_days', s.expire_days)
    from private.proposal_settings s where s.tenant_id = private.current_tenant()) end
$$;

-- pricing engine: funnels by the hour; custom builds show to the client as one price
do $$
declare d text := pg_get_functiondef('private.proposal_quote(public.proposals,text,uuid)'::regprocedure); b text; i int;
  pairs text[][] := array[
   array[$q$  cs_hrs int; ex_hrs int;$q$, $q$  cs_hrs int; ex_hrs int; hrs_n int;$q$],
   array[$q$  for x, o in select * from jsonb_array_elements(cfun) with ordinality loop
    lines := lines || jsonb_build_array(jsonb_build_object('key','cFunnel',$q$,
         $q$  for x, o in select * from jsonb_array_elements(cfun) with ordinality loop
    hrs_n := greatest(1, coalesce(case when x->>'hrs' ~ '^\d{1,4}$' then (x->>'hrs')::int end, st.funnel_default_hours, 18));
    partner_n := exists (select 1 from unnest(page_c) c where c <= array_position(rawph, private.ph_clean(x->'ph')));
    lines := lines || jsonb_build_array(jsonb_build_object('key','cFunnel',$q$],
   array[$q$'desc',pb->'cFunnel'->>'description','est',dev_pending,
      'setup',(pb->'cFunnel'->>'setup_price')::numeric,'mo',0,'setup_cost',(pb->'cFunnel'->>'setup_cost')::numeric,'mo_cost',0));$q$,
         $q$'desc',pb->'cFunnel'->>'description','est',dev_pending,
      'qty',format('%s hrs at $%s/hr', hrs_n, case when partner_n then st.rate_partner else st.rate_standard end),
      'setup',hrs_n*(case when partner_n then st.rate_partner else st.rate_standard end),'mo',0,'setup_cost',hrs_n*st.labor_cost,'mo_cost',0));$q$],
   array[$q$'lines', (select coalesce(jsonb_agg(l - 'setup_cost' - 'mo_cost'), '[]'::jsonb) from jsonb_array_elements(lines) l),$q$,
         $q$'lines', (select coalesce(jsonb_agg(case when p_mode = 'client' and l->>'key' in ('cSite','cFunnel') then l - 'setup_cost' - 'mo_cost' - 'qty'
                                           else l - 'setup_cost' - 'mo_cost' end), '[]'::jsonb) from jsonb_array_elements(lines) l),$q$],
   array[$q$  if p_mode = 'client' then return out; end if;$q$, $q$  if p_mode = 'client' then return out - 'rate' - 'cs_rate' - 'ex_rate'; end if;$q$]];
begin
  d := replace(d, E'\r\n', E'\n');
  if position('hrs_n int' in d) > 0 then return; end if;   -- already applied
  for i in 1 .. array_length(pairs, 1) loop
    b := d; d := replace(d, pairs[i][1], pairs[i][2]);
    if d = b then raise exception 'patch % did not match', i; end if;
  end loop;
  execute d;
end $$;
