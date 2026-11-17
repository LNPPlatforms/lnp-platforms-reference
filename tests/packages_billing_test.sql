-- 091: packages, plans, feature limits and the billing gate. Run with tests/run_db.sh tests/packages_billing_test.sql
\set ON_ERROR_STOP 1
insert into tenants (id, name, slug, is_agency, agency_tenant_id) values
  ('a1000000-0000-0000-0000-000000000001', 'Cognix', 'cognix-t', true, null),
  ('a1000000-0000-0000-0000-000000000002', 'Essential', 'essential-t', false, 'a1000000-0000-0000-0000-000000000001'),
  ('a1000000-0000-0000-0000-000000000003', 'Other agency', 'other-t', true, null);
insert into app_users (id, full_name, email, tenant_id, is_admin, active, role) values
  ('b1000000-0000-0000-0000-000000000001', 'Agency Al', 'al@c.com', 'a1000000-0000-0000-0000-000000000001', true, true, 'staff'),
  ('b1000000-0000-0000-0000-000000000002', 'Owner Olive', 'olive@e.com', 'a1000000-0000-0000-0000-000000000002', true, true, 'staff'),
  ('b1000000-0000-0000-0000-000000000003', 'Crew Carl', 'carl@e.com', 'a1000000-0000-0000-0000-000000000002', false, true, 'staff'),
  ('b1000000-0000-0000-0000-000000000004', 'Other Ozzy', 'oz@o.com', 'a1000000-0000-0000-0000-000000000003', true, true, 'staff');
insert into companies (id, tenant_id, name) values ('c1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'Essential Services');
insert into invoice_schedules (id, tenant_id, company_id, frequency, next_run_date) values
  ('d1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'monthly', current_date + 30);
-- the invoice math isn't under test here; set balances by hand
alter table invoices disable trigger user;
grant execute on all functions in schema private, public to authenticated;
set role authenticated;

-- agency admin builds a package and puts Essential on it, plus Social
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000001', false);
select package_save('{"name":"Service Pro","features":["sales","jobs","dispatch","bids","calendars"],"price":60,"price_per":"user"}') as pkg \gset
select account_plan_save('a1000000-0000-0000-0000-000000000002', jsonb_build_object('package_id', :'pkg', 'allowed', '["sales","jobs","dispatch","bids","calendars","social"]'::jsonb,
  'company_id', 'c1000000-0000-0000-0000-000000000001', 'billing_mode', 'invoice', 'billing_schedule_id', 'd1000000-0000-0000-0000-000000000001'));
do $$ begin
  if jsonb_array_length(public.account_plans_list()) <> 1 then raise exception 'agency should see the plan'; end if;
  if not (select 'CRM client' = any(org_types) from companies where id = 'c1000000-0000-0000-0000-000000000001') then raise exception 'org should be typed CRM client'; end if;
end $$;
-- another agency can't touch it
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000004', false);
do $$ begin
  begin perform public.account_plan_save('a1000000-0000-0000-0000-000000000002', '{"allowed":["sales","esign"]}'); raise exception 'leak';
  exception when others then if sqlerrm = 'leak' then raise exception 'another agency changed the plan'; end if; end;
  if jsonb_array_length(public.account_plans_list()) <> 0 then raise exception 'another agency sees the plan'; end if;
end $$;

-- client side: allowed features are on, others off and can't be switched on
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
do $$ begin
  if not private.feature_on('bids') then raise exception 'bids should be on for the client'; end if;
  if private.feature_on('esign') then raise exception 'esign is outside the plan'; end if;
  if private.feature_on('inbox') then raise exception 'inbox (default on) is outside the plan and should be off'; end if;
  begin perform public.account_settings_save('{"features":{"esign":true}}'); raise exception 'leak';
  exception when others then if sqlerrm = 'leak' then raise exception 'client switched on a feature outside the plan'; end if; end;
  perform public.account_settings_save('{"features":{"bids":false}}');
  if private.feature_on('bids') then raise exception 'client should be able to switch an allowed feature off'; end if;
end $$;

-- billing: linked series, nothing invoiced yet = ok; first invoice open and never paid = setup (blocked)
do $$ begin if (public.my_plan()->'billing'->>'state') <> 'ok' then raise exception 'no invoices yet should be ok'; end if; end $$;
reset role;
insert into invoices (id, number, tenant_id, company_id, schedule_id, status, issue_date, due_date, total, balance, paid_total, share_token)
values ('e1000000-0000-0000-0000-000000000001', 1, 'a1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001',
        'sent', current_date, current_date + 7, 3180, 3180, 0, 'tok1');
set role authenticated;
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
do $$ declare b jsonb := public.my_plan(); begin
  if b->'billing'->>'state' <> 'setup' then raise exception 'never paid should block, got %', b; end if;
  if jsonb_array_length(b->'billing'->'open') <> 1 or b->'billing'->'open'->0->>'token' <> 'tok1' then raise exception 'billing person should get the pay link'; end if;
end $$;
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000003', false);
do $$ declare b jsonb := public.my_plan(); begin
  if b->'billing'->>'state' <> 'locked' or b->'billing' ? 'open' then raise exception 'staff should see locked with no pay link, got %', b; end if;
  begin perform public.account_export(); raise exception 'leak';
  exception when others then if sqlerrm = 'leak' then raise exception 'staff exported the account'; end if; end;
end $$;
-- the first invoice gets paid (setup fee plus first month) = ok
reset role;
update invoices set status = 'paid', paid_at = now(), paid_total = 3180, balance = 0 where id = 'e1000000-0000-0000-0000-000000000001';
-- later invoice 3 days late with 7 grace days = grace (billing people only); 10 days late = locked
insert into invoices (id, number, tenant_id, company_id, schedule_id, status, issue_date, due_date, total, balance, paid_total, share_token)
values ('e1000000-0000-0000-0000-000000000002', 2, 'a1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001',
        'sent', current_date - 33, current_date - 3, 180, 180, 0, 'tok2');
set role authenticated;
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
do $$ begin if public.my_plan()->'billing'->>'state' <> 'grace' then raise exception 'should be grace'; end if; end $$;
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000003', false);
do $$ begin if public.my_plan()->'billing'->>'state' <> 'ok' then raise exception 'staff should not see grace'; end if; end $$;
reset role;
update invoices set due_date = current_date - 10 where id = 'e1000000-0000-0000-0000-000000000002';
set role authenticated;
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
do $$ declare x jsonb; begin
  if public.my_plan()->'billing'->>'state' <> 'locked' then raise exception 'should be locked'; end if;
  x := public.account_export();
  if jsonb_typeof(x->'tables'->'companies') <> 'array' then raise exception 'export should include companies'; end if;
end $$;
-- the agency switched into the account isn't blocked; billing handled clears it; a trial waits
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000001', false);
select account_plan_save('a1000000-0000-0000-0000-000000000002', '{"billing_mode":"bypass"}');
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
do $$ begin if public.my_plan()->'billing'->>'state' <> 'ok' then raise exception 'billing handled should clear it'; end if; end $$;
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000001', false);
select account_plan_save('a1000000-0000-0000-0000-000000000002', jsonb_build_object('billing_mode', 'invoice', 'trial_ends', (current_date + 5)::text));
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
do $$ begin if public.my_plan()->'billing'->>'state' <> 'trial' then raise exception 'should be trial'; end if; end $$;
-- billing contact: once Carl is it, Olive (admin) is no longer a billing person
select billing_contact_set('b1000000-0000-0000-0000-000000000003');
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000001', false);
select account_plan_save('a1000000-0000-0000-0000-000000000002', '{"trial_ends":""}');
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
do $$ begin if public.my_plan()->'billing'->>'state' <> 'locked' or public.my_plan()->>'billing_person' <> 'false' then raise exception 'Olive is staff for billing now'; end if; end $$;
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000003', false);
do $$ begin if public.my_plan()->'billing'->>'state' <> 'locked' or public.my_plan()->'billing'->'open' is null then raise exception 'Carl should get the pay link'; end if; end $$;
-- taking a feature away switches it off for the client
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000001', false);
select account_plan_save('a1000000-0000-0000-0000-000000000002', '{"allowed":["sales","jobs"]}');
reset role;
do $$ begin if (select settings->'features'->>'calendars' from account_settings where tenant_id = 'a1000000-0000-0000-0000-000000000002') <> 'false' then raise exception 'removed feature should be off'; end if; end $$;
select 'packages and billing: all good';
