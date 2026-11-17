-- 069b: invoices and their payments. Totals are always figured in the database (069c), never trusted from the screen.
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  number bigint not null,
  company_id uuid not null references public.companies(id),
  person_id uuid references public.people(id),
  proposal_id uuid references public.proposals(id),
  owner_id uuid references public.app_users(id) default auth.uid(),
  divisions uuid[] not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'sent', 'partial', 'paid', 'void')),
  issue_date date not null default current_date,
  due_date date,
  po text check (po is null or length(po) <= 60),
  bill_to jsonb not null default '{}'::jsonb,          -- {name, email, address}
  lines jsonb not null default '[]'::jsonb,            -- [{code, name, desc, qty, price, tax, total, tax_amt, job_id}]
  discount numeric(12,2) not null default 0 check (discount >= 0),
  deposit numeric(12,2) not null default 0 check (deposit >= 0),   -- deposit paid before this invoice (on the proposal, say)
  notes text, terms text,
  subtotal numeric(12,2) not null default 0,
  tax_total numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  paid_total numeric(12,2) not null default 0,
  balance numeric(12,2) not null default 0,
  lead_source text,
  share_token text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  sent_at timestamptz, last_emailed_to text, paid_at timestamptz, voided_at timestamptz, void_reason text,
  stripe_session_id text,
  created_by uuid default auth.uid() references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, number)
);
create index if not exists invoices_company on public.invoices (company_id, issue_date desc);
create index if not exists invoices_tenant on public.invoices (tenant_id, status, issue_date desc);

create table if not exists public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  method text not null check (method in ('card', 'bank', 'check', 'cash', 'link', 'other')),
  reference text check (reference is null or length(reference) <= 120),
  paid_on date not null default current_date,
  note text,
  status text not null default 'posted' check (status in ('pending', 'posted', 'rejected')),   -- pending waits in Review
  source text not null default 'manual' check (source in ('manual', 'stripe')),
  stripe_session_id text unique,
  recorded_by uuid default auth.uid(), decided_by uuid, decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists invoice_payments_invoice on public.invoice_payments (invoice_id);
create index if not exists invoice_payments_pending on public.invoice_payments (tenant_id) where status = 'pending';

alter table public.jobs add column if not exists invoice_id uuid references public.invoices(id);
-- closed deals and accepted proposals carry the lead source they came from
alter table public.opportunities add column if not exists lead_source text;
alter table public.proposals add column if not exists lead_source text;

alter table public.invoices enable row level security;
alter table public.invoice_payments enable row level security;
create policy "see invoices" on public.invoices for select using (
  tenant_id = private.current_tenant() and private.is_internal() and private.can('invoices', 1) and private.in_scope('invoices', owner_id, divisions));
create policy "add invoices" on public.invoices for insert with check (
  tenant_id = private.current_tenant() and private.is_internal() and private.can('invoices', 2));
create policy "edit invoices" on public.invoices for update using (
  tenant_id = private.current_tenant() and private.is_internal() and private.can('invoices', 2) and private.in_scope('invoices', owner_id, divisions))
  with check (tenant_id = private.current_tenant() and private.can('invoices', 2));
create policy "see invoice payments" on public.invoice_payments for select using (
  tenant_id = private.current_tenant() and exists (select 1 from public.invoices i where i.id = invoice_id));
revoke all on public.invoices, public.invoice_payments from anon, authenticated;
grant select, insert, update on public.invoices to authenticated;
grant select on public.invoice_payments to authenticated;   -- payments are added through invoice_payment_record
create trigger audit_invoices after insert or update on public.invoices for each row execute function private.audit();
create trigger audit_invoice_payments after insert or update on public.invoice_payments for each row execute function private.audit();
create trigger stamp_divisions before insert on public.invoices for each row execute function private.stamp_divisions();
