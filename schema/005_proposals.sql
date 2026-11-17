-- 005: Proposal Studio. Proposals, version history, public client link, accept flow.
-- Prices, costs and margin rules live in the private schema, which the API never exposes.
-- Every quote is computed in the database: reps get prices and their own commission, admins also get cost and margin,
-- and the public client link gets client-safe lines only.

-- ============================================================
-- COMMISSION RATES
-- ============================================================
alter table public.app_users add column if not exists sales_rate numeric(5,4) not null default 0.10 check (sales_rate between 0 and 1);
alter table public.app_users add column if not exists lead_rate  numeric(5,4) not null default 0.10 check (lead_rate between 0 and 1);
update public.app_users set sales_rate = 0, lead_rate = 0 where is_admin;   -- Chris, David, Julie currently take 0%
-- Lead gen rate paid to a referring organization (referral partner or active client). Null means the 10% default.
alter table public.companies add column if not exists lead_gen_rate numeric(5,4) check (lead_gen_rate between 0 and 1);

-- Only admins may change anyone's commission rates
create or replace function private.guard_rates() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  if auth.uid() is not null and not private.is_admin() then
    if tg_table_name = 'app_users' and (new.sales_rate is distinct from old.sales_rate or new.lead_rate is distinct from old.lead_rate) then
      raise exception 'Only an admin can change commission rates';
    end if;
    if tg_table_name = 'companies' and new.lead_gen_rate is distinct from old.lead_gen_rate then
      raise exception 'Only an admin can change lead gen rates';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_rates_users on public.app_users;
create trigger guard_rates_users before update on public.app_users for each row execute function private.guard_rates();
drop trigger if exists guard_rates_companies on public.companies;
create trigger guard_rates_companies before update on public.companies for each row execute function private.guard_rates();

-- ============================================================
-- PRICE BOOK (private: prices AND costs; never exposed directly)
-- COSTS ARE NOT IN THIS FILE. The real cost figures were entered straight into the database.
-- This repo folder is served as a public website, so cost numbers must never be committed here.
-- ============================================================
create table if not exists private.proposal_settings (
  tenant_id uuid primary key references public.tenants(id),
  rate_partner numeric not null default 85,       -- custom website and extra hours, client has a Referralogix page
  rate_standard numeric not null default 125,     -- same work, no Referralogix page
  labor_cost numeric not null default 0,          -- internal cost per hour (real value set in the database)
  commission_reserve numeric not null default 0.20,
  default_lead_rate numeric not null default 0.10,
  host_first numeric not null default 199,        -- non-partner hosting and care, first site or funnel
  host_next numeric not null default 99,          -- each one after
  host_partner numeric not null default 99,       -- partner, each one not covered by a page
  host_unit_cost numeric not null default 0,      -- 1 hr management + hosting (real value set in the database)
  green numeric not null default 0.40,
  yellow numeric not null default 0.30,
  red numeric not null default 0.25,
  payback_months numeric not null default 4,
  min_term_months int not null default 6,
  expire_days int not null default 14,
  site_default_hours int not null default 20
);
insert into private.proposal_settings (tenant_id) values (private.default_tenant()) on conflict do nothing;

create table if not exists private.proposal_price_book (
  tenant_id uuid not null references public.tenants(id),
  key text not null,
  title text not null,
  description text not null,          -- client-facing, shows under every line
  setup_price numeric not null default 0,
  monthly_price numeric not null default 0,
  setup_cost numeric not null default 0,
  monthly_cost numeric not null default 0,
  primary key (tenant_id, key)
);
insert into private.proposal_price_book (tenant_id, key, title, description, setup_price, monthly_price, setup_cost, monthly_cost) values
 (private.default_tenant(), 'lic', 'Referralogix Professional license',
  'Your listing on the Referralogix network. Providers can find you by name and service in the directory, communicate with you securely, share documents and run referrals through built-in workflows. Includes one internal team chat room.',
  0, 499, 0, 0),
 (private.default_tenant(), 'page', 'Page inside Referralogix',
  'A branded page inside Referralogix that providers see when they log in. GELP designs it, builds it and keeps it current. Each page also covers monthly hosting and care for one of your websites or funnels.',
  599, 599, 0, 0),
 (private.default_tenant(), 'tSite', 'Template website',
  'A complete website built from a proven GELP template and filled with your logo, photos, providers, services and copy. Includes launch on your domain.',
  1750, 0, 0, 0),
 (private.default_tenant(), 'tFunnel', 'Template funnel',
  'A ready-made sales funnel from a proven GELP template: landing page, lead capture, follow-up and booking, tailored to your offer.',
  995, 0, 0, 0),
 (private.default_tenant(), 'cSite', 'Custom website',
  'A website designed and built from scratch around your organization, billed against a bank of hours.',
  0, 0, 0, 0),
 (private.default_tenant(), 'cFunnel', 'Custom funnel',
  'A sales funnel built from scratch for one audience: landing page, lead capture, follow-up sequence and booking.',
  1500, 0, 0, 0),
 (private.default_tenant(), 'host', 'Hosting and care',
  'Hosting, security updates, backups and 1 hour of management each month for each website or funnel.',
  0, 0, 0, 0),
 (private.default_tenant(), 'ex', 'Additional monthly hours',
  'Reserved time each month for updates, changes and new work beyond what''s included.',
  0, 0, 0, 0)
on conflict (tenant_id, key) do nothing;

-- ============================================================
-- PROPOSALS
-- ============================================================
create table if not exists public.proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  company_id uuid not null references public.companies(id),
  contact_person_id uuid references public.people(id),
  contact_name text,
  contact_email text,
  owner_id uuid not null default auth.uid() references public.app_users(id),   -- the closer
  status text not null default 'draft' check (status in ('draft','sent','accepted')),
  share_token text not null unique default (replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')),
  items jsonb not null default '{"lic":false,"pages":[],"tSites":[],"tFunnels":[],"cFunnels":[],"cs":{"on":false,"hrs":20},"ex":{"on":false,"hrs":2},"disc":{"setup":0,"month":0},"note_shared":""}',
  internal_note text,
  override_reason text,          -- admin pushes a blocked deal through
  override_sig text,
  override_by uuid references public.app_users(id),
  dev_sig text,                  -- admin or dev approved the custom estimate
  dev_by uuid references public.app_users(id),
  version int not null default 0,
  sent_at timestamptz,
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_name text,
  accepted_email text,
  accepted_ip text,
  accepted_agent text,
  accepted_version int,
  created_by uuid default auth.uid() references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists proposals_company_idx on public.proposals (company_id, created_at desc);
create index if not exists proposals_owner_idx on public.proposals (owner_id, updated_at desc);

create table if not exists public.proposal_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  proposal_id uuid not null references public.proposals(id),
  company_id uuid not null references public.companies(id),
  version int not null,
  items jsonb not null,
  quote jsonb not null,            -- client-safe snapshot exactly as the client saw it
  setup_total numeric not null,
  monthly_total numeric not null,
  light text not null,
  override_reason text,
  accepted boolean not null default false,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  unique (proposal_id, version)
);

-- ============================================================
-- SIGNATURES: what changes the price, what changes the custom scope
-- ============================================================
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
    'disc', it->'disc')::text)
$$;
create or replace function private.proposal_dev_sig(it jsonb) returns text
language sql immutable set search_path = pg_catalog as $$
  select case when coalesce((it->'cs'->>'on')::boolean,false) or jsonb_array_length(coalesce(it->'cFunnels','[]'::jsonb)) > 0
    then md5(jsonb_build_object(
      'cs', case when coalesce((it->'cs'->>'on')::boolean,false) then jsonb_build_object('hrs', it->'cs'->'hrs', 'desc', it->'cs'->'desc') end,
      'cf', (select jsonb_agg(x->'desc') from jsonb_array_elements(coalesce(it->'cFunnels','[]'::jsonb)) x))::text)
  end
$$;

-- ============================================================
-- THE PRICING ENGINE
-- mode: 'client' (public link), 'rep' (prices + own commission), 'admin' (everything)
-- ============================================================
create or replace function private.proposal_quote(p public.proposals, p_mode text, p_viewer uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
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
  cs_hrs int; ex_on boolean := coalesce((it->'ex'->>'on')::boolean, false); ex_hrs int;
  n_pages int; partner boolean; rate numeric;
  lines jsonb := '[]'::jsonb;
  x jsonb;
  s_p numeric := 0; s_c numeric := 0; m_p numeric := 0; m_c numeric := 0;
  units int; covered int; paid int; host numeric := 0;
  d_s numeric; d_m numeric; s_net numeric; m_net numeric;
  res numeric; s_md numeric; m_md numeric; s_mg numeric; m_mg numeric;
  l_s text; l_m text; l_final text; overall text; blocked boolean;
  shortfall numeric; excess numeric; payback jsonb := null;
  s_hit numeric := 0; m_hit numeric := 0;
  dev_pending boolean; overridden boolean; expired boolean; acceptable boolean;
  co record; lead_user uuid; lead_rate numeric; lead_label text; closer record;
  comm jsonb := null; adm jsonb := null; out jsonb;
  ord constant text[] := array['none','green','yellow','red','blocked'];
begin
  select * into st from private.proposal_settings where tenant_id = p.tenant_id;
  select jsonb_object_agg(key, to_jsonb(b)) into pb from private.proposal_price_book b where tenant_id = p.tenant_id;
  n_pages := case when lic then jsonb_array_length(pages) else 0 end;
  partner := lic and n_pages > 0;
  rate := case when partner then st.rate_partner else st.rate_standard end;
  cs_hrs := greatest(1, coalesce((it->'cs'->>'hrs')::int, st.site_default_hours));
  ex_hrs := greatest(1, coalesce((it->'ex'->>'hrs')::int, 1));
  dev_pending := private.proposal_dev_sig(it) is not null and private.proposal_dev_sig(it) is distinct from p.dev_sig;

  -- lines
  if lic then
    lines := lines || jsonb_build_array(jsonb_build_object('key','lic','bucket','rlx','title',pb->'lic'->>'title','desc',pb->'lic'->>'description',
      'setup',0,'mo',(pb->'lic'->>'monthly_price')::numeric,'setup_cost',0,'mo_cost',(pb->'lic'->>'monthly_cost')::numeric));
    for x in select * from jsonb_array_elements(pages) loop
      lines := lines || jsonb_build_array(jsonb_build_object('key','page','bucket','rlx','title',coalesce(nullif(x->>'name',''),pb->'page'->>'title'),
        'sub',nullif(x->>'desc',''),'desc',pb->'page'->>'description',
        'setup',(pb->'page'->>'setup_price')::numeric,'mo',(pb->'page'->>'monthly_price')::numeric,
        'setup_cost',(pb->'page'->>'setup_cost')::numeric,'mo_cost',(pb->'page'->>'monthly_cost')::numeric));
    end loop;
  end if;
  for x in select * from jsonb_array_elements(tsites) loop
    lines := lines || jsonb_build_array(jsonb_build_object('key','tSite','bucket','template','title',coalesce(nullif(x->>'name',''),pb->'tSite'->>'title'),
      'sub',nullif(x->>'desc',''),'note',nullif(x->>'note',''),'desc',pb->'tSite'->>'description',
      'setup',(pb->'tSite'->>'setup_price')::numeric,'mo',0,'setup_cost',(pb->'tSite'->>'setup_cost')::numeric,'mo_cost',0));
  end loop;
  for x in select * from jsonb_array_elements(tfun) loop
    lines := lines || jsonb_build_array(jsonb_build_object('key','tFunnel','bucket','template','title',coalesce(nullif(x->>'name',''),pb->'tFunnel'->>'title'),
      'sub',nullif(x->>'desc',''),'note',nullif(x->>'note',''),'desc',pb->'tFunnel'->>'description',
      'setup',(pb->'tFunnel'->>'setup_price')::numeric,'mo',0,'setup_cost',(pb->'tFunnel'->>'setup_cost')::numeric,'mo_cost',0));
  end loop;
  if cs_on then
    lines := lines || jsonb_build_array(jsonb_build_object('key','cSite','bucket','custom','title',coalesce(nullif(it->'cs'->>'name',''),pb->'cSite'->>'title'),
      'sub',nullif(it->'cs'->>'desc',''),'note',nullif(it->'cs'->>'note',''),'desc',pb->'cSite'->>'description',
      'qty',format('%s hrs at $%s/hr', cs_hrs, rate),'est',dev_pending,
      'setup',cs_hrs*rate,'mo',0,'setup_cost',cs_hrs*st.labor_cost,'mo_cost',0));
  end if;
  for x in select * from jsonb_array_elements(cfun) loop
    lines := lines || jsonb_build_array(jsonb_build_object('key','cFunnel','bucket','custom','title',coalesce(nullif(x->>'name',''),pb->'cFunnel'->>'title'),
      'sub',nullif(x->>'desc',''),'note',nullif(x->>'note',''),'desc',pb->'cFunnel'->>'description','est',dev_pending,
      'setup',(pb->'cFunnel'->>'setup_price')::numeric,'mo',0,'setup_cost',(pb->'cFunnel'->>'setup_cost')::numeric,'mo_cost',0));
  end loop;
  units := jsonb_array_length(tsites) + jsonb_array_length(tfun) + jsonb_array_length(cfun) + case when cs_on then 1 else 0 end;
  covered := least(n_pages, units); paid := units - covered;
  if paid > 0 then host := case when partner then paid*st.host_partner else st.host_first + (paid-1)*st.host_next end; end if;
  if units > 0 then
    lines := lines || jsonb_build_array(jsonb_build_object('key','host','bucket','ongoing','title',pb->'host'->>'title','desc',pb->'host'->>'description',
      'qty', units::text || case when units > 1 then ' sites or funnels' else ' site or funnel' end
             || case when covered > 0 then format(', %s included with your Referralogix %s', covered, case when covered > 1 then 'pages' else 'page' end) else '' end,
      'setup',0,'mo',host,'setup_cost',0,'mo_cost',units*st.host_unit_cost));
  end if;
  if ex_on then
    lines := lines || jsonb_build_array(jsonb_build_object('key','ex','bucket','ongoing','title',pb->'ex'->>'title','desc',pb->'ex'->>'description',
      'qty',format('%s hrs at $%s/hr', ex_hrs, rate),'setup',0,'mo',ex_hrs*rate,'setup_cost',0,'mo_cost',ex_hrs*st.labor_cost));
  end if;

  select coalesce(sum((l->>'setup')::numeric),0), coalesce(sum((l->>'setup_cost')::numeric),0),
         coalesce(sum((l->>'mo')::numeric),0), coalesce(sum((l->>'mo_cost')::numeric),0)
    into s_p, s_c, m_p, m_c from jsonb_array_elements(lines) l;

  -- discounts and margins (margin always reserves the full commission)
  d_s := least(100, greatest(0, coalesce((it->'disc'->>'setup')::numeric,0))) / 100;
  d_m := least(100, greatest(0, coalesce((it->'disc'->>'month')::numeric,0))) / 100;
  s_net := round(s_p*(1-d_s), 2); m_net := round(m_p*(1-d_m), 2);
  res := st.commission_reserve;
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
  overall := ord[greatest(array_position(ord,l_final), array_position(ord,l_m))];
  blocked := l_final = 'blocked' or l_m = 'blocked';
  overridden := blocked and p.override_reason is not null and p.override_sig = private.proposal_price_sig(it);
  expired := p.status <> 'accepted' and p.expires_at < now();
  acceptable := p.status <> 'accepted' and not expired and not dev_pending and (not blocked or overridden) and jsonb_array_length(lines) > 0;

  out := jsonb_build_object(
    'lines', (select coalesce(jsonb_agg(l - 'setup_cost' - 'mo_cost'), '[]'::jsonb) from jsonb_array_elements(lines) l),
    'partner', partner, 'rate', rate,
    'hosting', jsonb_build_object('units', units, 'covered', covered, 'paid', paid),
    'setup', jsonb_build_object('gross', s_p, 'disc', s_p - s_net, 'net', s_net, 'pct', d_s*100),
    'month', jsonb_build_object('gross', m_p, 'disc', m_p - m_net, 'net', m_net, 'pct', d_m*100),
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
    'sales_setup_rate', case when p_viewer = p.owner_id then greatest(0, closer.sales_rate - s_hit) end,
    'sales_month_rate', case when p_viewer = p.owner_id then greatest(0, closer.sales_rate - m_hit) end,
    'lead', case when lead_rate is null then 'ask' when lead_user is not null and lead_user = p_viewer then 'mine' else 'elsewhere' end,
    'lead_rate', case when lead_user is not null and lead_user = p_viewer then lead_rate end);
  out := out || jsonb_build_object(
    'light', jsonb_build_object('setup', l_final, 'month', l_m, 'overall', overall, 'blocked', blocked, 'overridden', overridden,
                                'setup_hit', s_hit, 'month_hit', m_hit),
    'comm', comm,
    'lead_set', lead_rate is not null);
  if p_mode = 'admin' then
    adm := jsonb_build_object(
      'lines', lines, 'reserve', res,
      'setup', jsonb_build_object('cost', s_c, 'profit', s_md, 'margin', s_mg),
      'month', jsonb_build_object('cost', m_c, 'profit', m_md, 'margin', m_mg),
      'closer', closer.full_name, 'closer_rate', closer.sales_rate,
      'lead_label', lead_label, 'lead_rate', lead_rate,
      'payback_detail', case when payback is not null then jsonb_build_object('shortfall', shortfall, 'excess', excess) end);
    out := out || jsonb_build_object('admin', adm);
  end if;
  return out;
end $$;

-- ============================================================
-- GUARDS: who can change what on a proposal
-- ============================================================
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
     or new.accepted_version is distinct from old.accepted_version or new.accepted_ip is distinct from old.accepted_ip then
    raise exception 'Send and accept go through the proposal buttons';
  end if;
  if new.status <> old.status and not (old.status = 'accepted' and new.status = 'draft') then
    raise exception 'Send and accept go through the proposal buttons';
  end if;
  if old.status = 'accepted' and new.status = 'accepted' and new.items is distinct from old.items then
    raise exception 'This proposal is accepted and locked. Start a revision to change it.';
  end if;
  return new;
end $$;
drop trigger if exists guard_proposal on public.proposals;
create trigger guard_proposal before insert or update on public.proposals for each row execute function private.guard_proposal();
create trigger audit_proposals after insert or update or delete on public.proposals for each row execute function private.audit();
create trigger audit_proposal_versions after insert or update or delete on public.proposal_versions for each row execute function private.audit();

-- ============================================================
-- ROW SECURITY
-- ============================================================
alter table public.proposals enable row level security;
alter table public.proposal_versions enable row level security;
create policy "read proposals" on public.proposals for select
  using (private.is_internal() and tenant_id = private.current_tenant() and (owner_id = auth.uid() or created_by = auth.uid() or private.is_admin()));
create policy "create proposals" on public.proposals for insert
  with check (private.is_internal());
create policy "edit proposals" on public.proposals for update
  using (private.is_internal() and tenant_id = private.current_tenant() and (owner_id = auth.uid() or private.is_admin()))
  with check (private.is_internal() and (owner_id = auth.uid() or private.is_admin()));
create policy "read proposal versions" on public.proposal_versions for select
  using (exists (select 1 from public.proposals p where p.id = proposal_id));   -- inherits the proposal's read rule
grant select, insert, update on public.proposals to authenticated;
grant select on public.proposal_versions to authenticated;

-- ============================================================
-- RPCs
-- ============================================================
-- Internal quote: prices + own commission for reps, plus cost and margin for admins
create or replace function public.proposal_quote(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare p public.proposals;
begin
  if not private.is_internal() then raise exception 'Not allowed'; end if;
  select * into p from proposals where id = p_id and tenant_id = private.current_tenant()
    and (owner_id = auth.uid() or created_by = auth.uid() or private.is_admin());
  if not found then raise exception 'Proposal not found'; end if;
  return private.proposal_quote(p, case when private.is_admin() then 'admin' else 'rep' end, auth.uid())
    || jsonb_build_object('price_sig', private.proposal_price_sig(p.items), 'dev_sig', private.proposal_dev_sig(p.items));
end $$;

-- Public price list for the builder (prices only, never costs)
create or replace function public.proposal_price_list() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select case when private.is_internal() then (
    select jsonb_build_object(
      'items', (select jsonb_object_agg(key, jsonb_build_object('title', title, 'setup', setup_price, 'mo', monthly_price)) from private.proposal_price_book where tenant_id = private.current_tenant()),
      'rate_partner', s.rate_partner, 'rate_standard', s.rate_standard, 'host_first', s.host_first, 'host_next', s.host_next,
      'host_partner', s.host_partner, 'site_default_hours', s.site_default_hours, 'expire_days', s.expire_days)
    from private.proposal_settings s where s.tenant_id = private.current_tenant()) end
$$;

-- Admin: approve the custom estimate (clears the "pending review" asterisk)
create or replace function public.proposal_approve_estimate(p_id uuid) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_admin() then raise exception 'Only an admin can approve estimates'; end if;
  perform set_config('app.proposal_rpc', '1', true);
  update proposals set dev_sig = private.proposal_dev_sig(items), dev_by = auth.uid() where id = p_id and tenant_id = private.current_tenant();
end $$;

-- Admin: push a blocked deal through, with a reason on record
create or replace function public.proposal_override(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_admin() then raise exception 'Only an admin can override'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Give a reason for the override'; end if;
  perform set_config('app.proposal_rpc', '1', true);
  update proposals set override_reason = trim(p_reason), override_sig = private.proposal_price_sig(items), override_by = auth.uid()
   where id = p_id and tenant_id = private.current_tenant();
end $$;

-- Save and send: snapshots a version, refreshes the 14 day pricing window
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
  if (qi->>'blocked')::boolean then raise exception 'This discount is too deep to send. An admin can override it with a reason.'; end if;
  select expire_days into days from private.proposal_settings where tenant_id = p.tenant_id;
  perform set_config('app.proposal_rpc', '1', true);
  update proposals set version = version + 1, status = 'sent', sent_at = now(), expires_at = now() + make_interval(days => days)
   where id = p_id returning * into p;
  q := private.proposal_quote(p, 'client');
  insert into proposal_versions (tenant_id, proposal_id, company_id, version, items, quote, setup_total, monthly_total, light, override_reason, created_by)
  values (p.tenant_id, p.id, p.company_id, p.version, p.items, q, (q->'setup'->>'net')::numeric, (q->'month'->>'net')::numeric,
          qi->'light'->>'overall', case when (qi->'light'->>'overridden')::boolean then p.override_reason end, auth.uid());
  insert into activities (company_id, type, body) values (p.company_id, 'note',
    format('Proposal version %s sent: $%s due at signing, $%s/mo.', p.version, to_char((q->'setup'->>'net')::numeric,'FM999,999,990'), to_char((q->'month'->>'net')::numeric,'FM999,999,990')));
  return jsonb_build_object('version', p.version, 'token', p.share_token, 'expires_at', p.expires_at);
end $$;

-- Public client view (anyone with the link)
create or replace function public.proposal_public(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, private as $$
declare p public.proposals; c record; logo text; acc jsonb;
begin
  if p_token is null or length(p_token) < 32 then return null; end if;
  select * into p from proposals where share_token = p_token;
  if not found then return null; end if;
  select name, logo_media_id into c from companies where id = p.company_id;
  select url into logo from media where id = c.logo_media_id and archived_at is null;
  if p.status = 'accepted' then
    select quote into acc from proposal_versions where proposal_id = p.id and version = p.accepted_version;
  end if;
  return jsonb_build_object(
    'org', c.name, 'logo', logo, 'contact_name', p.contact_name, 'contact_email', p.contact_email,
    'status', p.status, 'version', p.version, 'expires_at', p.expires_at, 'updated_at', p.updated_at,
    'note', nullif(p.items->>'note_shared',''),
    'accepted', case when p.status = 'accepted' then jsonb_build_object('name', p.accepted_name, 'email', p.accepted_email,
       'at', p.accepted_at, 'version', p.accepted_version) end,
    'quote', coalesce(acc, private.proposal_quote(p, 'client')));
end $$;

-- Public accept: checkbox + typed name. Records who, when, IP, browser and the exact version accepted.
create or replace function public.proposal_accept(p_token text, p_name text, p_email text, p_agree boolean) returns jsonb
language plpgsql security definer set search_path = public, private as $$
declare p public.proposals; q jsonb; hdr json; ip text;
begin
  if not coalesce(p_agree, false) then raise exception 'Check the box to agree to the proposal and terms'; end if;
  if length(coalesce(trim(p_name), '')) < 3 then raise exception 'Type your full name to accept'; end if;
  select * into p from proposals where share_token = p_token for update;
  if not found then raise exception 'Proposal not found'; end if;
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
    accepted_agent = left(hdr->>'user-agent', 300), accepted_version = version + 1, sent_at = coalesce(sent_at, now())
   where id = p.id returning * into p;
  q := private.proposal_quote(p, 'client');
  insert into proposal_versions (tenant_id, proposal_id, company_id, version, items, quote, setup_total, monthly_total, light, override_reason, accepted, created_by)
  values (p.tenant_id, p.id, p.company_id, p.version, p.items, q, (q->'setup'->>'net')::numeric, (q->'month'->>'net')::numeric,
          'accepted', p.override_reason, true, null);
  insert into activities (company_id, type, body, created_by) values (p.company_id, 'note',
    format('Proposal version %s ACCEPTED by %s on the client link: $%s due at signing, $%s/mo.', p.version, p.accepted_name,
      to_char((q->'setup'->>'net')::numeric,'FM999,999,990'), to_char((q->'month'->>'net')::numeric,'FM999,999,990')), p.owner_id);
  return jsonb_build_object('ok', true, 'version', p.version);
end $$;

revoke execute on function public.proposal_quote(uuid), public.proposal_price_list(), public.proposal_approve_estimate(uuid),
  public.proposal_override(uuid, text), public.proposal_send(uuid), public.proposal_public(text),
  public.proposal_accept(text, text, text, boolean) from public;
grant execute on function public.proposal_quote(uuid), public.proposal_price_list(), public.proposal_approve_estimate(uuid),
  public.proposal_override(uuid, text), public.proposal_send(uuid) to authenticated;
grant execute on function public.proposal_public(text), public.proposal_accept(text, text, text, boolean) to anon, authenticated;
revoke execute on function private.proposal_quote(public.proposals, text, uuid), private.guard_proposal(), private.guard_rates()
  from public, anon, authenticated;
