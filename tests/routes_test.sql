-- 104: Routes (Beta). Run with tests/run_db.sh tests/routes_test.sql
\set ON_ERROR_STOP 1
insert into tenants (id, name, slug) values ('a2000000-0000-0000-0000-000000000001', 'Acme', 'acme2');
insert into app_users (id, full_name, email, tenant_id, is_admin) values
  ('b2000000-0000-0000-0000-000000000001', 'Ann Admin', 'ann@x.com', 'a2000000-0000-0000-0000-000000000001', true),
  ('b2000000-0000-0000-0000-000000000002', 'Dee Dispatch', 'dee@x.com', 'a2000000-0000-0000-0000-000000000001', true),
  ('b2000000-0000-0000-0000-000000000003', 'Will Worker', 'will@x.com', 'a2000000-0000-0000-0000-000000000001', false),
  ('b2000000-0000-0000-0000-000000000004', 'Sam Second', 'sam@x.com', 'a2000000-0000-0000-0000-000000000001', false);
select set_config('test.uid', 'b2000000-0000-0000-0000-000000000001', false);
insert into roles (id, tenant_id, name, preset_key, perms) values ('c2000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'Worker', 'worker',
  jsonb_build_object('timeclock', '{"level":2,"scope":"own"}'::jsonb));
update app_users set role_id = 'c2000000-0000-0000-0000-000000000001' where id in ('b2000000-0000-0000-0000-000000000003', 'b2000000-0000-0000-0000-000000000004');

-- off by default: nothing shows
select public.my_routes() = '[]'::jsonb as off_by_default;
insert into account_settings (tenant_id, settings) values ('a2000000-0000-0000-0000-000000000001', '{"features":{"routes":true,"timeclock":true}}')
  on conflict (tenant_id) do update set settings = excluded.settings;

insert into companies (id, tenant_id, name, city, state) values
  ('e2000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'Acme Company', 'Biloxi', 'MS'),
  ('e2000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000001', 'Beta Shop', 'Biloxi', 'MS');
insert into location_pins (company_id, tenant_id, lat, lng, radius_ft, is_primary) values
  ('e2000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 30.396, -88.885, 300, true),
  ('e2000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000001', 30.410, -88.900, 300, true);
insert into people (id, tenant_id, first_name, personal_email) values ('d2000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'Pat', 'pat@acme.com');
insert into company_people (company_id, person_id, tenant_id, is_primary_contact) values ('e2000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', true);

-- a daily route that started an hour ago (so the grace period is over), Dee dispatches, Will runs it
insert into routes (id, name, repeat, start_time, timezone, dispatcher_id, starts_on)
values ('f2000000-0000-0000-0000-000000000001', 'Biloxi loop', 'daily', ((now() at time zone 'America/Chicago') - interval '1 hour')::time, 'America/Chicago',
        'b2000000-0000-0000-0000-000000000002', current_date - 7);
insert into route_assignments (route_id, user_id) values ('f2000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000003');
insert into route_stops (id, route_id, company_id, sort, request) values
  ('a3000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 1, 'Empty the bins'),
  ('a3000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000002', 2, 'Check the lock');

-- schedule rules
select private.route_on(row(r.id, r.tenant_id, r.name, r.start_time, r.timezone, 'weekly', '{1}', '{}', 1, '2026-11-01', null, null, 15, 15, null, true, null, now(), null)::routes, '2026-11-16')
   and not private.route_on(row(r.id, r.tenant_id, r.name, r.start_time, r.timezone, 'weekly', '{1}', '{}', 1, '2026-11-01', null, null, 15, 15, null, true, null, now(), null)::routes, '2026-11-17') as weekly_monday
  from routes r where r.id = 'f2000000-0000-0000-0000-000000000001';
select private.route_on(row(r.id, r.tenant_id, r.name, r.start_time, r.timezone, 'custom', '{1}', '{}', 2, '2026-11-02', null, null, 15, 15, null, true, null, now(), null)::routes, '2026-11-16')
   and not private.route_on(row(r.id, r.tenant_id, r.name, r.start_time, r.timezone, 'custom', '{1}', '{}', 2, '2026-11-02', null, null, 15, 15, null, true, null, now(), null)::routes, '2026-11-09') as every_other_monday
  from routes r where r.id = 'f2000000-0000-0000-0000-000000000001';
select private.route_on(row(r.id, r.tenant_id, r.name, r.start_time, r.timezone, 'monthly', '{}', '{31}', 1, '2026-01-01', null, null, 15, 15, null, true, null, now(), null)::routes, '2026-11-30') as last_day_in_short_month
  from routes r where r.id = 'f2000000-0000-0000-0000-000000000001';

-- nobody clocked in: the tick alerts Dee (not the admins yet)
select private.route_tick();
select count(*) = 1 as dispatcher_alerted from notifications where kind = 'route_late' and user_id = 'b2000000-0000-0000-0000-000000000002' and deliver;
select count(*) = 0 as admins_not_yet from notifications where kind = 'route_late' and user_id = 'b2000000-0000-0000-0000-000000000001';
-- 15 more minutes with no action: every admin
update route_runs set dispatcher_alerted_at = now() - interval '16 minutes';
select private.route_tick();
select count(*) = 1 as admins_alerted from notifications where kind = 'route_late' and user_id = 'b2000000-0000-0000-0000-000000000001';
select private.route_tick();
select count(*) = 3 as alerts_once from notifications where kind = 'route_late';

-- Will sees it in My Day, stops in order
select set_config('test.uid', 'b2000000-0000-0000-0000-000000000003', false);
select jsonb_array_length(public.my_routes()) = 1 and public.my_routes()->0->'stops'->0->>'company' = 'Acme Company' as will_sees_route;
select (public.my_routes()->0->'stops'->0->>'id') as rs1, (public.my_routes()->0->'stops'->1->>'id') as rs2 \gset
-- Arrived at the right spot: fine. At the second stop from far away: a warning
select (public.route_stop_tap(:'rs1', 'arrived', 30.3961, -88.8851, 10)->>'far')::boolean = false as near_ok;
select public.route_stop_tap(:'rs1', 'left', 30.3961, -88.8851, 10) is not null as left_ok;
select (public.route_stop_tap(:'rs2', 'arrived', 30.500, -88.700, 10)->>'far')::boolean as far_warned;
select status = 'started' as run_started from route_runs;
-- he reports the pin is wrong for good; Dee approves and the stop moves
select public.route_location_report(:'rs2', 'permanent', 'Gate moved to the back street', 30.5, -88.7) as exc \gset
select count(*) = 1 as dee_told from notifications where kind = 'route_location' and user_id = 'b2000000-0000-0000-0000-000000000002';
do $$ begin perform public.route_exception_decide((select id from route_exceptions limit 1), true); raise exception 'worker approved'; exception when others then
  if sqlerrm = 'worker approved' then raise; end if; end $$;
select set_config('test.uid', 'b2000000-0000-0000-0000-000000000002', false);
select public.route_exception_decide(:'exc', true);
select lat = 30.5 and lng = -88.7 as stop_moved from route_stops where id = 'a3000000-0000-0000-0000-000000000002';
-- incomplete with a reason and a photo
select set_config('test.uid', 'b2000000-0000-0000-0000-000000000003', false);
select public.route_stop_incomplete(:'rs2', 'Locked out', array['a2000000-0000-0000-0000-000000000001/routes/x.jpg']);
select public.route_stop_tap(:'rs2', 'left', 30.5, -88.7, 5) is not null as left_incomplete;
select status = 'incomplete' as stays_incomplete from route_run_stops where id = :'rs2';
select status = 'done' as run_done from route_runs;
-- Sam isn't on the route
select set_config('test.uid', 'b2000000-0000-0000-0000-000000000004', false);
select public.my_routes() = '[]'::jsonb as sam_sees_none;
do $$ begin perform public.route_stop_tap((select id from route_run_stops limit 1), 'arrived'); raise exception 'sam tapped'; exception when others then
  if sqlerrm = 'sam tapped' then raise; end if; end $$;

-- Dee: tomorrow, split it for the day and push it, then email the customers
select set_config('test.uid', 'b2000000-0000-0000-0000-000000000002', false);
select (public.route_board('f2000000-0000-0000-0000-000000000001', current_date + 1)->'run'->>'id') as run2 \gset
select public.route_run_action(:'run2', 'split', jsonb_build_object('assign', jsonb_build_object(
  (select id from route_run_stops where run_id = :'run2' order by sort limit 1), 'b2000000-0000-0000-0000-000000000004'))) is not null as split_ok;
select count(*) = 1 as sam_told from notifications where kind = 'route_assigned' and user_id = 'b2000000-0000-0000-0000-000000000004';
select public.route_run_action(:'run2', 'push')->'customers'->0->'emails'->0->>'email' = 'pat@acme.com' as push_lists_customers;
select status = 'pushed' as pushed from route_runs where id = :'run2';
select count(*) = 2 as day_after_has_stops from route_run_stops rs join route_runs rr on rr.id = rs.run_id where rr.run_date = current_date + 2;
select public.route_notify_customers(:'run2', 'Your service day moved', 'Hi {company}, we''ll be there tomorrow instead.') = 1 as one_email;
select body = 'Hi Acme Company, we''ll be there tomorrow instead.' as email_filled from email_outbox;

-- GPS: only while on the clock and only if an admin turned it on
select set_config('test.uid', 'b2000000-0000-0000-0000-000000000003', false);
select public.gps_ping(30.1, -88.1) = false as off_no_ping;
do $$ begin perform public.gps_tracking_set('b2000000-0000-0000-0000-000000000003', true); raise exception 'worker set'; exception when others then
  if sqlerrm = 'worker set' then raise; end if; end $$;
select set_config('test.uid', 'b2000000-0000-0000-0000-000000000001', false);
select public.gps_tracking_set('b2000000-0000-0000-0000-000000000003', true);
select set_config('test.uid', 'b2000000-0000-0000-0000-000000000003', false);
select public.gps_ping(30.1, -88.1) = false as not_clocked_in_no_ping;
insert into time_entries (tenant_id, user_id, clock_in) values ('a2000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000003', now() - interval '1 hour');
select public.gps_ping(30.1, -88.1) and public.gps_ping(30.2, -88.2) as pinged;
select count(*) = 1 as hourly_only from gps_pings;
-- 105: a customer can be a person. At an organization: that one. At none: an Individual organization, reused next time.
select set_config('test.uid', 'b2000000-0000-0000-0000-000000000001', false);
select (public.customer_for_person('d2000000-0000-0000-0000-000000000001')->>'id') = 'e2000000-0000-0000-0000-000000000001' as person_at_org;
insert into people (id, tenant_id, first_name, last_name, personal_email) values ('d2000000-0000-0000-0000-000000000009', 'a2000000-0000-0000-0000-000000000001', 'Rita', 'Homeowner', 'rita@home.test');
select public.customer_for_person('d2000000-0000-0000-0000-000000000009')->>'name' = 'Rita Homeowner' as individual_made;
select org_types = '{Individual}' as is_individual from companies where name = 'Rita Homeowner';
select (public.customer_for_person('d2000000-0000-0000-0000-000000000009')->>'id') = (select id::text from companies where name = 'Rita Homeowner') as reused;
select count(*) = 1 as only_one from companies where name = 'Rita Homeowner';
