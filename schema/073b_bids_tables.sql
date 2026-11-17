-- 073b: bids, part 2. Each account's bid settings (base address, scorecard, thresholds, intake switches), the bids
-- themselves and the files that came with them. Scoring is in 073c, actions in 073d, intake in 073e.

-- one row per account. metrics: [{key, kind, label, rank 1 to 3, good, poor, yes_good}] (073c explains the kinds)
create table if not exists private.bid_settings (
  tenant_id uuid primary key references public.tenants(id),
  base_address text check (base_address is null or length(base_address) <= 300),
  base_lat double precision check (base_lat is null or base_lat between -90 and 90),
  base_lng double precision check (base_lng is null or base_lng between -180 and 180),
  geocoded_at timestamptz,
  metrics jsonb not null default '[]'::jsonb,
  go_at numeric(5,1) not null default 70 check (go_at between 0 and 100),
  maybe_at numeric(5,1) not null default 45 check (maybe_at between 0 and 100),
  override_review boolean not null default true,       -- overrides wait in Review
  email_on boolean not null default true,              -- the bid email address takes RFPs
  upload_on boolean not null default false,            -- the public upload page works
  upload_token text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  upload_intro text check (upload_intro is null or length(upload_intro) <= 1000),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  check (maybe_at <= go_at)
);
alter table private.bid_settings enable row level security;

-- the email domain bids come in on (set once by the platform owner after the mail provider is set up)
create table if not exists private.bid_intake_config (
  id int primary key default 1 check (id = 1),
  domain text check (domain is null or domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  style text not null default 'plus' check (style in ('plus', 'plain')),   -- plus: bids+slug@domain, plain: slug@domain
  provider text, updated_at timestamptz default now()
);
insert into private.bid_intake_config (id) values (1) on conflict (id) do nothing;
alter table private.bid_intake_config enable row level security;

create table if not exists public.bids (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  title text not null check (length(trim(title)) between 1 and 200),
  client_name text check (client_name is null or length(client_name) <= 200),
  company_id uuid references public.companies(id),
  owner_id uuid references public.app_users(id) default auth.uid(),
  divisions uuid[] not null default '{}',
  status text not null default 'new' check (status in ('new', 'reviewing', 'go', 'no_go', 'bidding', 'submitted', 'won', 'lost', 'withdrawn')),
  source text not null default 'manual' check (source in ('manual', 'upload', 'public', 'email')),
  due_at timestamptz,
  window_start date, window_end date,
  est_value numeric(14,2) check (est_value is null or est_value >= 0),
  est_margin numeric(6,2) check (est_margin is null or est_margin between -100 and 100),
  submitted_amount numeric(14,2) check (submitted_amount is null or submitted_amount >= 0),
  submitted_at timestamptz, closed_at timestamptz,
  competitor_notes text check (competitor_notes is null or length(competitor_notes) <= 5000),
  notes text check (notes is null or length(notes) <= 10000),
  outcome_note text check (outcome_note is null or length(outcome_note) <= 2000),
  site_address text check (site_address is null or length(site_address) <= 300),
  site_lat double precision check (site_lat is null or site_lat between -90 and 90),
  site_lng double precision check (site_lng is null or site_lng between -180 and 180),
  distance_mi numeric(8,1),
  answers jsonb not null default '{}'::jsonb,           -- {metric key: answer} for the questions people answer
  score numeric(5,1), result text check (result is null or result in ('go', 'maybe', 'no_go')),
  score_parts jsonb not null default '[]'::jsonb,
  override_result text check (override_result is null or override_result in ('go', 'maybe', 'no_go')),
  override_note text check (override_note is null or length(override_note) <= 2000),
  override_by uuid, override_at timestamptz,
  review_state text check (review_state is null or review_state in ('pending', 'approved', 'returned')),
  review_by uuid, review_at timestamptz, review_note text check (review_note is null or length(review_note) <= 2000),
  measurement_id uuid references public.measurements(id),
  price_lines jsonb not null default '[]'::jsonb,       -- lines priced with the measuring tool
  proposal_id uuid references public.proposals(id), job_id uuid references public.jobs(id), invoice_id uuid references public.invoices(id),
  from_email text check (from_email is null or length(from_email) <= 320),
  from_name text check (from_name is null or length(from_name) <= 200),
  email_subject text check (email_subject is null or length(email_subject) <= 500),
  email_body text check (email_body is null or length(email_body) <= 100000),
  history jsonb not null default '[]'::jsonb,           -- [{at, by, what}]
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists bids_tenant on public.bids (tenant_id, status, due_at);
create index if not exists bids_review on public.bids (tenant_id) where review_state = 'pending';
create index if not exists bids_company on public.bids (company_id);

