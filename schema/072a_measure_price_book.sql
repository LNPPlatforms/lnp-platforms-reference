-- 072a: the measuring tool, part 1. The Measuring feature switch (off until an account turns it on), a price book
-- every account can use (per square foot, per linear foot or each). The item types are in 072b.
-- Decisions: BACKLOG.md "Oct 30 morning voice decisions", Measuring bullet.

-- Measuring is off by default like jobs and pay
create or replace function private.feature_on(f text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce((select (settings->'features'->>f)::boolean from account_settings where tenant_id = private.current_tenant()),
                  f not in ('jobs', 'dispatch', 'timeclock', 'pay', 'costs', 'parent_locations', 'location_nesting', 'custom_fields', 'accounting', 'measure'))
$$;

-- who can look at prices and measurements, who can set them up
create or replace function private.measure_see() returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_internal() and private.feature_on('measure') and (private.can('proposals', 1) or private.can('invoices', 1))
$$;
create or replace function private.measure_setup() returns boolean
language sql stable security definer set search_path = public, private as $$
  select private.is_internal() and private.feature_on('measure') and (private.is_admin() or private.can('settings', 4))
$$;
revoke execute on function private.measure_see(), private.measure_setup() from public, anon;
grant execute on function private.measure_see(), private.measure_setup() to authenticated;

-- the price book: one row per thing you sell by the unit
create table if not exists public.price_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default private.current_tenant() references public.tenants(id),
  name text not null check (length(trim(name)) between 1 and 120),
  description text not null default '' check (length(description) <= 2000),
  code text not null default '' check (length(code) <= 40),
  unit text not null default 'each' check (unit in ('sq_ft', 'ln_ft', 'each')),
  price numeric(12,4) not null default 0 check (price >= 0 and price < 100000000),
  sort int not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists price_items_tenant on public.price_items (tenant_id, sort);

create or replace function private.price_item_check() returns trigger
language plpgsql security definer set search_path = public, private as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.tenant_id := old.tenant_id; new.created_at := old.created_at;
  elsif auth.uid() is not null then new.tenant_id := private.current_tenant(); end if;
  new.name := trim(new.name); new.code := trim(coalesce(new.code, '')); new.description := coalesce(new.description, '');
  return new;
end $$;
create trigger price_item_check before insert or update on public.price_items for each row execute function private.price_item_check();

alter table public.price_items enable row level security;
create policy "see price items" on public.price_items for select using (tenant_id = private.current_tenant() and private.measure_see());
create policy "add price items" on public.price_items for insert with check (tenant_id = private.current_tenant() and private.measure_setup());
create policy "edit price items" on public.price_items for update using (tenant_id = private.current_tenant() and private.measure_setup())
  with check (tenant_id = private.current_tenant() and private.measure_setup());
revoke all on public.price_items from anon, authenticated;
grant select, insert, update on public.price_items to authenticated;
create trigger audit_price_items after insert or update on public.price_items for each row execute function private.audit();
