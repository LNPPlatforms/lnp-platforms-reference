-- 025: internal notes on every proposal line, price snapshot at send, the price editing screen, list_names search_path.

-- 1. Internal line notes live in their own column, never inside items, so nothing the client sees can carry them
--    (proposal_view, proposal_quote, versions and emails only read items).
alter table public.proposals add column if not exists line_notes jsonb not null default '{}'::jsonb;

-- 2. Prices are copied onto a proposal the first time it's sent. From then on it's quoted from that copy,
--    so editing prices later never changes a proposal that's already out (or accepted, or revised).
alter table public.proposals add column if not exists price_snapshot jsonb;
alter table private.proposal_settings add column if not exists lock_min int not null default 1;
alter table private.proposal_settings add column if not exists lock_max int not null default 24;

create or replace function private.price_snapshot_now(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = public, private as $$
  select jsonb_build_object('at', now(),
    'settings', (select to_jsonb(s) - 'tenant_id' from private.proposal_settings s where s.tenant_id = p_tenant),
    'book', (select jsonb_object_agg(key, to_jsonb(b) - 'tenant_id') from private.proposal_price_book b where b.tenant_id = p_tenant))
$$;
revoke execute on function private.price_snapshot_now(uuid) from public, anon, authenticated;

do $m$
declare d text;
begin
  -- quote from the snapshot when there is one
  d := pg_get_functiondef('private.proposal_quote(public.proposals,text,uuid)'::regprocedure);
  if position('price_snapshot' in d) = 0 then
    if position($s$select jsonb_object_agg(key, to_jsonb(b)) into pb from private.proposal_price_book b where tenant_id = p.tenant_id;$s$ in d) = 0
       or position($s$'lock_months', greatest(1, least(24,$s$ in d) = 0 then raise exception 'proposal_quote changed, patch by hand'; end if;
    d := replace(d, $s$select jsonb_object_agg(key, to_jsonb(b)) into pb from private.proposal_price_book b where tenant_id = p.tenant_id;$s$,
      $s$select jsonb_object_agg(key, to_jsonb(b)) into pb from private.proposal_price_book b where tenant_id = p.tenant_id;
  if p.price_snapshot is not null then
    st := jsonb_populate_record(st, coalesce(p.price_snapshot->'settings', '{}'::jsonb));
    pb := coalesce(pb, '{}'::jsonb) || coalesce(p.price_snapshot->'book', '{}'::jsonb);
  end if;$s$);
    d := replace(d, $s$'lock_months', greatest(1, least(24,$s$, $s$'lock_months', greatest(coalesce(st.lock_min, 1), least(coalesce(st.lock_max, 24),$s$);
    execute d;
  end if;

  -- take the snapshot on first send
  d := pg_get_functiondef('public.proposal_send(uuid)'::regprocedure);
  if position('price_snapshot' in d) = 0 then
    if position($s$client_plan = null
   where id = p_id returning * into p;$s$ in d) = 0 then raise exception 'proposal_send changed, patch by hand'; end if;
    d := replace(d, $s$client_plan = null
   where id = p_id returning * into p;$s$, $s$client_plan = null,
       price_snapshot = coalesce(price_snapshot, private.price_snapshot_now(tenant_id))
   where id = p_id returning * into p;$s$);
    execute d;
  end if;

  -- nobody writes the snapshot by hand; new proposals start without one
  d := pg_get_functiondef('private.guard_proposal()'::regprocedure);
  if position('price_snapshot' in d) = 0 then
    d := replace(d, $s$new.client_plan := null; new.phase_starts := '{}'::jsonb;$s$,
                    $s$new.client_plan := null; new.phase_starts := '{}'::jsonb; new.price_snapshot := null;$s$);
    d := replace(d, $s$  if rpc then return new; end if;$s$, $s$  if rpc then return new; end if;
  if new.price_snapshot is distinct from old.price_snapshot then
    raise exception 'Prices on a sent proposal change only through Use current prices';
  end if;$s$);
    if position('new.price_snapshot := null' in d) = 0 or position('Use current prices' in d) = 0 then raise exception 'guard_proposal changed, patch by hand'; end if;
    execute d;
  end if;
end $m$;

-- admin: move a proposal that hasn't been accepted onto today's prices
create or replace function public.proposal_use_current_prices(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
declare p public.proposals;
begin
  if not private.is_admin() then raise exception 'Only an admin can change the prices on a sent proposal'; end if;
  select * into p from proposals where id = p_id and tenant_id = private.current_tenant() for update;
  if not found then raise exception 'Proposal not found'; end if;
  if p.status = 'accepted' then raise exception 'This proposal is accepted. Start a revision first.'; end if;
  perform set_config('app.proposal_rpc', '1', true);
  update proposals set price_snapshot = case when p.version = 0 then null else private.price_snapshot_now(p.tenant_id) end where id = p_id;
end $$;
revoke execute on function public.proposal_use_current_prices(uuid) from public, anon;
grant execute on function public.proposal_use_current_prices(uuid) to authenticated;

-- price list for reps: add the lock range
create or replace function public.proposal_price_list() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.is_internal() then (
    select jsonb_build_object(
      'items', (select jsonb_object_agg(key, jsonb_build_object('title', title, 'setup', setup_price, 'mo', monthly_price)) from private.proposal_price_book where tenant_id = private.current_tenant()),
      'rate_partner', s.rate_partner, 'rate_standard', s.rate_standard, 'host_first', s.host_first, 'host_next', s.host_next,
      'host_partner', s.host_partner, 'site_default_hours', s.site_default_hours, 'funnel_default_hours', s.funnel_default_hours, 'expire_days', s.expire_days,
      'lock_min', s.lock_min, 'lock_max', s.lock_max)
    from private.proposal_settings s where s.tenant_id = private.current_tenant()) end
$$;

-- 3. Price editing screen (admins of the account). Numbers are settings; the pricing logic stays in code.
create or replace function public.proposal_settings_get() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.is_admin() then jsonb_build_object(
    'settings', (select to_jsonb(s) - 'tenant_id' from private.proposal_settings s where s.tenant_id = private.current_tenant()),
    'book', (select coalesce(jsonb_agg(to_jsonb(b) - 'tenant_id' order by array_position(array['lic','page','tSite','tFunnel','cSite','cFunnel','host','ex'], b.key), b.key), '[]'::jsonb)
               from private.proposal_price_book b where b.tenant_id = private.current_tenant())) end
$$;

create or replace function public.proposal_settings_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare t uuid := private.current_tenant(); s jsonb := coalesce(p->'settings', '{}'::jsonb); cur private.proposal_settings; nx private.proposal_settings;
  b jsonb; k text;
  money_cols constant text[] := array['rate_partner','rate_standard','labor_cost','host_first','host_next','host_partner','host_unit_cost'];
  pct_cols constant text[] := array['commission_reserve','default_lead_rate','green','yellow','red'];
  int_cols constant text[] := array['payback_months','min_term_months','expire_days','site_default_hours','funnel_default_hours','lock_min','lock_max'];
begin
  if not private.is_admin() then raise exception 'Only an admin can change prices'; end if;
  select * into cur from private.proposal_settings where tenant_id = t;
  if not found then raise exception 'Proposals are not set up for this account yet'; end if;
  for k in select jsonb_object_keys(s) loop
    if not (k = any(money_cols || pct_cols || int_cols)) then raise exception 'Unknown setting %', k; end if;
    if jsonb_typeof(s->k) <> 'number' then raise exception 'Enter a number for every setting'; end if;
    if (s->>k)::numeric < 0 then raise exception 'Settings can''t be negative'; end if;
    if k = any(pct_cols) and (s->>k)::numeric > 1 then raise exception 'Percentages run from 0 to 100'; end if;
    if k = any(int_cols) and (s->>k)::numeric <> trunc((s->>k)::numeric) then raise exception 'Use whole numbers for hours, days and months'; end if;
  end loop;
  nx := jsonb_populate_record(cur, s);
  if not (nx.green >= nx.yellow and nx.yellow >= nx.red) then raise exception 'Green needs the highest margin, then yellow, then red'; end if;
  if nx.lock_min < 1 or nx.lock_max > 36 or nx.lock_min > nx.lock_max then raise exception 'Price lock runs from 1 to 36 months, shortest first'; end if;
  if nx.expire_days < 1 or nx.expire_days > 180 then raise exception 'Proposals expire after 1 to 180 days'; end if;
  if nx.site_default_hours < 1 or nx.funnel_default_hours < 1 then raise exception 'Default hours must be at least 1'; end if;
  if nx.payback_months > 36 or nx.min_term_months > 60 then raise exception 'That payback or term is longer than allowed'; end if;
  update private.proposal_settings set
    rate_partner = nx.rate_partner, rate_standard = nx.rate_standard, labor_cost = nx.labor_cost,
    commission_reserve = nx.commission_reserve, default_lead_rate = nx.default_lead_rate,
    host_first = nx.host_first, host_next = nx.host_next, host_partner = nx.host_partner, host_unit_cost = nx.host_unit_cost,
    green = nx.green, yellow = nx.yellow, red = nx.red, payback_months = nx.payback_months, min_term_months = nx.min_term_months,
    expire_days = nx.expire_days, site_default_hours = nx.site_default_hours, funnel_default_hours = nx.funnel_default_hours,
    lock_min = nx.lock_min, lock_max = nx.lock_max
  where tenant_id = t and (to_jsonb(proposal_settings) - 'tenant_id') is distinct from (to_jsonb(nx) - 'tenant_id');

  for b in select value from jsonb_array_elements(coalesce(p->'book', '[]'::jsonb)) loop
    if not exists (select 1 from private.proposal_price_book where tenant_id = t and key = b->>'key') then raise exception 'Unknown price line'; end if;
    if length(trim(coalesce(b->>'title', ''))) = 0 then raise exception 'Every line needs a name'; end if;
    if coalesce((b->>'setup_price')::numeric, 0) < 0 or coalesce((b->>'monthly_price')::numeric, 0) < 0
       or coalesce((b->>'setup_cost')::numeric, 0) < 0 or coalesce((b->>'monthly_cost')::numeric, 0) < 0 then raise exception 'Prices and costs can''t be negative'; end if;
    update private.proposal_price_book set
      title = left(trim(b->>'title'), 120), description = left(trim(coalesce(b->>'description', '')), 2000),
      setup_price = coalesce((b->>'setup_price')::numeric, setup_price), monthly_price = coalesce((b->>'monthly_price')::numeric, monthly_price),
      setup_cost = coalesce((b->>'setup_cost')::numeric, setup_cost), monthly_cost = coalesce((b->>'monthly_cost')::numeric, monthly_cost)
    where tenant_id = t and key = b->>'key'
      and (title, description, setup_price, monthly_price, setup_cost, monthly_cost) is distinct from
          (left(trim(b->>'title'), 120), left(trim(coalesce(b->>'description', '')), 2000),
           coalesce((b->>'setup_price')::numeric, setup_price), coalesce((b->>'monthly_price')::numeric, monthly_price),
           coalesce((b->>'setup_cost')::numeric, setup_cost), coalesce((b->>'monthly_cost')::numeric, monthly_cost));
  end loop;
  return public.proposal_settings_get();
end $$;
revoke execute on function public.proposal_settings_get(), public.proposal_settings_save(jsonb) from public, anon;
grant execute on function public.proposal_settings_get(), public.proposal_settings_save(jsonb) to authenticated;

-- every price change shows in History
create trigger audit_proposal_settings after insert or update on private.proposal_settings for each row execute function private.audit();
create trigger audit_proposal_price_book after insert or update on private.proposal_price_book for each row execute function private.audit();

-- 4. search_path pin (advisor warning)
alter function private.list_names(text[]) set search_path = pg_catalog, public, private;
