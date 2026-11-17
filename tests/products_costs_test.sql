-- 089: product costs only for people who manage products; proposals get them through products_for_proposals().
\set ON_ERROR_STOP 1
insert into tenants (id, name, slug) values ('a8000000-0000-0000-0000-000000000001', 'Acct', 'acct8'), ('a8000000-0000-0000-0000-000000000002', 'Other', 'other8');
insert into app_users (id, full_name, email, tenant_id, is_admin) values
  ('b8000000-0000-0000-0000-000000000001', 'Ada Admin', 'a8@x.com', 'a8000000-0000-0000-0000-000000000001', true),
  ('b8000000-0000-0000-0000-000000000002', 'Rex Rep', 'r8@x.com', 'a8000000-0000-0000-0000-000000000001', false),
  ('b8000000-0000-0000-0000-000000000003', 'Oz Other', 'o8@x.com', 'a8000000-0000-0000-0000-000000000002', true);
insert into roles (id, tenant_id, name, preset_key, perms) values ('c8000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001', 'Sales rep', 'sales_rep', public.role_presets()->'sales_rep'->'perms');
update app_users set role_id = 'c8000000-0000-0000-0000-000000000001' where id = 'b8000000-0000-0000-0000-000000000002';
insert into products (id, tenant_id, name, price, setup_price) values
  ('d8000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001', 'Physician seat', 250, 250),
  ('d8000000-0000-0000-0000-000000000002', 'a8000000-0000-0000-0000-000000000002', 'Other thing', 10, 0);
grant execute on all functions in schema private, public to authenticated;
set role authenticated;
select set_config('test.uid', 'b8000000-0000-0000-0000-000000000001', false);
insert into product_costs (product_id, cost, setup_cost) values ('d8000000-0000-0000-0000-000000000001', 60, 40);
do $$ begin
  begin insert into product_costs (product_id, cost) values ('d8000000-0000-0000-0000-000000000002', 1); raise exception 'leak';
  exception when others then if sqlerrm = 'leak' then raise exception 'admin could cost another account''s product'; end if; end;
end $$;
select set_config('test.uid', 'b8000000-0000-0000-0000-000000000002', false);
do $$ begin
  if (select count(*) from product_costs) <> 0 then raise exception 'a rep can read product costs directly'; end if;
  if (select (x->>'cost')::numeric from jsonb_array_elements(public.products_for_proposals()) x) <> 60 then raise exception 'proposal builder should get the cost'; end if;
  if jsonb_array_length(public.products_for_proposals()) <> 1 then raise exception 'other account products showed'; end if;
end $$;
select 'product costs: all good';
