-- 081a (Nov 3, from the voice planning call): saved products, recurring invoice schedules, and per account
-- switches for showing savings and late fees. Products are their own list per account (each agency and client
-- sells different things); the Measuring price book (price_items) stays separate.

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  description text not null default '',
  code text not null default '',
  price numeric(12,2) not null default 0 check (price >= 0),
  unit text not null default 'each' check (unit = any (array['each','hour','month','year','week','day','sq_ft','ln_ft','visit','user'])),
  taxable boolean not null default false,
  frequency text not null default 'once' check (frequency = any (array['once','weekly','biweekly','monthly','quarterly','yearly','custom'])),
  custom_every integer check (custom_every is null or custom_every between 1 and 365),
  custom_unit text check (custom_unit is null or custom_unit = any (array['day','week','month','year'])),
  sort integer not null default 0,
  archived_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists products_tenant on public.products (tenant_id, sort) where archived_at is null;
alter table public.products enable row level security;
drop policy if exists "see products" on public.products;
drop policy if exists "add products" on public.products;
drop policy if exists "edit products" on public.products;
create policy "see products" on public.products for select using (tenant_id = private.current_tenant() and private.is_internal() and private.can('invoices', 1));
create policy "add products" on public.products for insert with check (tenant_id = private.current_tenant() and private.can_doc_settings());
create policy "edit products" on public.products for update using (tenant_id = private.current_tenant() and private.can_doc_settings())
  with check (tenant_id = private.current_tenant() and private.can_doc_settings());
grant select, insert, update on public.products to authenticated;

create or replace function private.products_touch() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.tenant_id := old.tenant_id; new.created_by := old.created_by; end if;
  if new.frequency <> 'custom' then new.custom_every := null; new.custom_unit := null;
  elsif new.custom_every is null or new.custom_unit is null then raise exception 'A custom schedule needs a number and a unit (every 10 days)';
  end if;
  return new;
end $$;
drop trigger if exists products_touch on public.products;
create trigger products_touch before insert or update on public.products for each row execute function private.products_touch();
revoke execute on function private.products_touch() from public, anon, authenticated;

-- recurring invoices: each schedule copies the lines of its source invoice on a cadence
create table if not exists public.invoice_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant(),
  company_id uuid,
  person_id uuid,
  template_invoice_id uuid references public.invoices(id) on delete set null,
  frequency text not null check (frequency = any (array['weekly','biweekly','monthly','quarterly','yearly','custom'])),
  custom_interval integer,
  custom_unit text check (custom_unit is null or custom_unit = any (array['day','week','month','year'])),
  next_run_date date not null,
  auto_send boolean not null default false,
  hold_for_review boolean not null default false,
  end_type text not null default 'never' check (end_type = any (array['never','count','date'])),
  end_count integer,
  end_date date,
  runs_completed integer not null default 0,
  autopay boolean not null default false,
  stripe_customer_id text,
  stripe_payment_method_id text,
  status text not null default 'active' check (status = any (array['active','paused','ended'])),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.invoice_schedules enable row level security;
drop policy if exists invoice_schedules_tenant on public.invoice_schedules;
create policy invoice_schedules_tenant on public.invoice_schedules
  for all using (tenant_id = private.current_tenant() and private.is_internal() and private.can('invoices', 1))
  with check (tenant_id = private.current_tenant() and private.is_internal() and private.can('invoices', 2));

alter table public.invoices
  add column if not exists schedule_id uuid references public.invoice_schedules(id) on delete set null,
  add column if not exists show_savings boolean,
  add column if not exists payment_attempts integer not null default 0,
  add column if not exists last_reminder_at timestamptz;

alter table public.tenants
  add column if not exists show_savings_default boolean not null default true,
  add column if not exists late_fees_enabled boolean not null default false;
