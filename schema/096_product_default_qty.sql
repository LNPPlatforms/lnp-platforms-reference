-- 096: default quantity on a product (Nov 11, 2026). An hourly product can carry its usual number of hours; adding
-- it to an invoice fills that in as the line's quantity (still editable). Blank means 1.
alter table public.products add column if not exists default_qty numeric check (default_qty is null or (default_qty > 0 and default_qty <= 100000));

-- the proposal builder's "+ From products" gets the default quantity too
create or replace function public.products_for_proposals() returns jsonb
language sql stable security definer set search_path = public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'description', p.description, 'code', p.code, 'price', p.price,
           'setup_price', p.setup_price, 'unit', p.unit, 'frequency', p.frequency, 'default_qty', p.default_qty,
           'cost', coalesce(c.cost, 0), 'setup_cost', coalesce(c.setup_cost, 0))
           order by p.sort, p.name), '[]'::jsonb)
    from products p left join product_costs c on c.product_id = p.id
   where p.tenant_id = private.current_tenant() and p.archived_at is null and private.is_internal()
$$;
