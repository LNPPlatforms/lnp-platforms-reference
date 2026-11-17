-- 089: Products becomes the one place people manage what they sell: price, setup fee, costs and margins (Nov 10, 2026).
-- Pricing keeps only the rules (hourly rates, hosting formulas, guardrails, commission, payback).
-- Costs live in their own table so only people who manage products (can_doc_settings) can read them;
-- reps building proposals get costs through products_for_proposals() so margins on proposal lines stay right.

alter table public.products add column if not exists setup_price numeric not null default 0 check (setup_price >= 0);

create table if not exists public.product_costs (
  product_id uuid primary key references public.products(id) on delete cascade,
  tenant_id uuid not null default private.current_tenant(),
  cost numeric not null default 0 check (cost >= 0),
  setup_cost numeric not null default 0 check (setup_cost >= 0),
  updated_at timestamptz not null default now()
);
alter table public.product_costs enable row level security;
drop policy if exists "manage product costs" on public.product_costs;
create policy "manage product costs" on public.product_costs for all
  using (tenant_id = private.current_tenant() and private.can_doc_settings())
  with check (tenant_id = private.current_tenant() and private.can_doc_settings()
    and exists (select 1 from public.products p where p.id = product_id and p.tenant_id = private.current_tenant()));
grant select, insert, update, delete on public.product_costs to authenticated;

-- products with their costs, for pulling a product onto a proposal line (anyone on the team who builds proposals)
create or replace function public.products_for_proposals() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'description', p.description, 'code', p.code, 'price', p.price,
           'setup_price', p.setup_price, 'unit', p.unit, 'frequency', p.frequency, 'cost', coalesce(c.cost, 0), 'setup_cost', coalesce(c.setup_cost, 0))
           order by p.sort, p.name), '[]'::jsonb)
    from products p left join product_costs c on c.product_id = p.id
   where p.tenant_id = private.current_tenant() and p.archived_at is null and private.is_internal()
$$;
revoke execute on function public.products_for_proposals() from public, anon;
grant execute on function public.products_for_proposals() to authenticated;
