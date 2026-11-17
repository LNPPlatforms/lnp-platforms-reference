-- 072: the measuring tool. Run with tests/run_db.sh tests/measure_test.sql
\set ON_ERROR_STOP 1
insert into tenants (id, name) values ('31000000-0000-0000-0000-000000000001', 'Pave Co'), ('32000000-0000-0000-0000-000000000002', 'Other');
insert into app_users (id, full_name, role, is_admin, tenant_id) values
 ('d1000000-0000-0000-0000-000000000001', 'Admin Al', 'staff', true, '31000000-0000-0000-0000-000000000001'),
 ('d1000000-0000-0000-0000-000000000002', 'Rita Rep', 'staff', false, '31000000-0000-0000-0000-000000000001'),
 ('d1000000-0000-0000-0000-000000000003', 'Fred Field', 'staff', false, '31000000-0000-0000-0000-000000000001'),
 ('d1000000-0000-0000-0000-000000000009', 'Outsider', 'staff', true, '32000000-0000-0000-0000-000000000002');
insert into companies (id, tenant_id, name) values ('d2000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', 'Mall Lot'),
  ('d2000000-0000-0000-0000-000000000002', '32000000-0000-0000-0000-000000000002', 'Their Lot');

set role authenticated;
select set_config('test.uid', 'd1000000-0000-0000-0000-000000000001', false);
-- off until switched on
select not private.feature_on('measure') as off_by_default;
select count(*) = 0 as hidden_when_off from measure_types;
do $$ begin perform measure_seed(); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; end $$;
select account_settings_save('{"features":{"measure":true}}'::jsonb) is not null as switched_on;
select private.feature_on('measure') as on_now;
select role_save(null, 'Sales rep', (role_presets()->'sales_rep'->'perms'), 'sales_rep') as rep \gset
select role_save(null, 'Field worker', (role_presets()->'field_worker'->'perms'), 'field_worker') as fw \gset
select user_role_set('d1000000-0000-0000-0000-000000000002', :'rep');
select user_role_set('d1000000-0000-0000-0000-000000000003', :'fw');

-- a rep opening the tool gets the plain defaults, prices at 0
select set_config('test.uid', 'd1000000-0000-0000-0000-000000000002', false);
select measure_seed() = 6 as seeded;
select measure_seed() = 0 as seeds_once;
select count(*) = 6 as six_types, count(*) filter (where kind = 'count') = 3 as three_counts from measure_types;
select count(*) = 8 and sum(price) = 0 as eight_items_no_prices from price_items;
select jsonb_array_length(states) = 2 and states->1->>'short' = 'moved' and jsonb_array_length(states->1->'addons') = 2 and not (states->1->>'base')::boolean as pole_states
  from measure_types where name = 'Light pole';
-- reps can't change prices
do $$ begin update price_items set price = 1 where name = 'Paving'; if found then raise exception 'rep changed a price'; end if; end $$;
select sum(price) = 0 as rep_no_price_change from price_items;
do $$ begin insert into price_items (name, unit, price) values ('Nope', 'each', 1); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; end $$;

-- the admin sets prices and a new type with three states
select set_config('test.uid', 'd1000000-0000-0000-0000-000000000001', false);
update price_items set price = 0.25 where name = 'Paving';
update price_items set price = 600 where name = 'Light pole';
update price_items set price = 150 where name = 'Saw cut and patch';
select sum(price) = 750.25 as admin_set_prices from price_items;
insert into measure_types (name, kind, price_item_id, states) values ('Bollard', 'count', (select id from price_items where name = 'Sign'),
  jsonb_build_array(jsonb_build_object('key', 'count', 'name', 'Counted', 'short', '', 'color', '#111111', 'base', true, 'addons', '[]'::jsonb),
    jsonb_build_object('key', 'paint', 'name', 'Repaint', 'short', 'repaint', 'color', '#222222', 'base', false, 'addons', '[]'::jsonb),
    jsonb_build_object('key', 'moved', 'name', 'Move it', 'short', 'moved', 'color', '#333333', 'base', true,
      'addons', jsonb_build_array((select id from price_items where name = 'Saw cut and patch'))))) returning color = '#111111' as color_from_first_state;
-- a count with no states gets one; an area loses any states; bad shapes stop
insert into measure_types (name, kind, color) values ('Wheel stop', 'count', '#444444') returning jsonb_array_length(states) = 1 and states->0->>'color' = '#444444' as default_state;
insert into measure_types (name, kind, states) values ('Patch', 'area', '[{"key":"x"}]') returning states = '[]'::jsonb as area_no_states;
do $$ begin insert into measure_types (name, kind, states) values ('Bad', 'count', '[{"key":"a","name":"A","color":"#000000"},{"key":"a","name":"B","color":"#000000"}]');
  raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; end $$;
do $$ begin insert into measure_types (name, kind, states) values ('Bad', 'count', '[{"key":"a","name":"A","color":"red"}]');
  raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; end $$;
do $$ begin insert into measure_types (name, kind, states) values ('Bad', 'count', '[{"key":"a","name":"A","color":"#000000","addons":["00000000-0000-0000-0000-000000000000"]}]');
  raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; end $$;

-- the rep saves a measurement on the lot and reopens it
select set_config('test.uid', 'd1000000-0000-0000-0000-000000000002', false);
insert into measurements (company_id, name, shapes, totals, summary, view, picture_url)
values ('d2000000-0000-0000-0000-000000000001', 'Front lot',
  '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[-89,30],[-89.001,30],[-89.001,30.001],[-89,30]]]},"properties":{"kind":"area"}}]}',
  '{"types":{}}', '12,400 sq ft paved area', '{"lat":30,"lng":-89,"zoom":19}', 'https://x.supabase.co/storage/v1/object/public/media/a.png') returning id as m1 \gset
select created_by = 'd1000000-0000-0000-0000-000000000002' and tenant_id = '31000000-0000-0000-0000-000000000001' as stamped from measurements where id = :'m1';
update measurements set name = 'Front lot, take 2', tenant_id = '32000000-0000-0000-0000-000000000002', used_on = '[{"kind":"invoice","id":"x"}]' where id = :'m1';
select name = 'Front lot, take 2' and tenant_id = '31000000-0000-0000-0000-000000000001' and jsonb_array_length(used_on) = 1 as edited_tenant_kept from measurements where id = :'m1';
do $$ begin insert into measurements (shapes) values ('{"type":"Point"}'); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; end $$;
do $$ begin insert into measurements (company_id) values ('d2000000-0000-0000-0000-000000000002'); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; end $$;

-- a field worker (no proposals) can't see or save them
select set_config('test.uid', 'd1000000-0000-0000-0000-000000000003', false);
select count(*) = 0 as field_cant_see from measurements;
do $$ begin insert into measurements (name) values ('x'); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; end $$;
do $$ begin perform measure_seed(); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; end $$;

-- another account sees none of it
select set_config('test.uid', 'd1000000-0000-0000-0000-000000000009', false);
select account_settings_save('{"features":{"measure":true}}'::jsonb) is not null as other_on;
select (select count(*) from measurements) = 0 and (select count(*) from price_items) = 0 and (select count(*) from measure_types) = 0 as other_sees_nothing;

-- the map picture rides on the invoice and shows on the customer's document
select set_config('test.uid', 'd1000000-0000-0000-0000-000000000001', false);
insert into invoices (company_id, lines, pictures) values ('d2000000-0000-0000-0000-000000000001', '[{"name":"Paving","desc":"12,400 sq ft measured","qty":12400,"price":0.25}]',
  jsonb_build_array(jsonb_build_object('url', 'https://x.supabase.co/a.png', 'title', 'Front lot', 'measurement_id', :'m1'))) returning id as inv \gset
select total = 3100 as priced_by_the_foot from invoices where id = :'inv';
select public.invoice_mark_sent(:'inv', null);
select d->'pictures'->0->>'title' = 'Front lot' and d->'pictures'->0->>'url' = 'https://x.supabase.co/a.png' and d->'pictures'->0->>'measurement_id' is null as doc_has_picture
  from (select public.doc_view(share_token) d from invoices where id = :'inv') x;
do $$ begin update invoices set pictures = '{"a":1}' where company_id = 'd2000000-0000-0000-0000-000000000001'; raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; end $$;
reset role;
select 'measure tests done' as ok;
