\set ON_ERROR_STOP 1
-- setup as superuser
insert into tenants (id, name) values ('10000000-0000-0000-0000-000000000001', 'Essential Test'), ('20000000-0000-0000-0000-000000000002', 'Other');
insert into divisions (id, tenant_id, name) values ('d0000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', 'Valet'), ('d0000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-000000000001', 'Junk');
insert into app_users (id, full_name, role, is_admin, tenant_id, divisions) values
 ('a0000000-0000-0000-0000-000000000001', 'Admin Al', 'staff', true, '10000000-0000-0000-0000-000000000001', '{}'),
 ('a0000000-0000-0000-0000-000000000002', 'Worker Wes', 'staff', false, '10000000-0000-0000-0000-000000000001', '{d0000000-0000-0000-0000-00000000000a}'),
 ('a0000000-0000-0000-0000-000000000003', 'Manny Mgr', 'staff', false, '10000000-0000-0000-0000-000000000001', '{}'),
 ('a0000000-0000-0000-0000-000000000009', 'Outsider', 'staff', true, '20000000-0000-0000-0000-000000000002', '{}');
insert into companies (id, tenant_id, name, divisions) values ('c0000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Oak Apartments', '{d0000000-0000-0000-0000-00000000000a}'),
  ('c0000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Mgmt Co', '{}');


set role authenticated;
-- admin turns features on, sets rules
select set_config('test.uid', 'a0000000-0000-0000-0000-000000000001', false);
select account_settings_save('{"features":{"jobs":true,"dispatch":true,"timeclock":true,"pay":true,"costs":true},"gps_radius_ft":500,
  "auto_approve":{"jobs":{"on":true,"grace_min":30},"timesheets":{"on":false}},"labels":{"organization":{"one":"Location","many":"Locations"}}}'::jsonb) ->> 'gps_radius_ft' as radius;
-- roles: field worker preset for Wes
select role_save(null, 'Field worker', (role_presets()->'field_worker'->'perms'), 'field_worker') as fw \gset
select user_role_set('a0000000-0000-0000-0000-000000000002', :'fw');
select role_save(null, 'Manager', (role_presets()->'manager'->'perms'), 'manager') as mg \gset
select user_role_set('a0000000-0000-0000-0000-000000000003', :'mg');
-- pin, parent
insert into location_pins (company_id, label, lat, lng) values ('c0000000-0000-0000-0000-000000000001', 'Office', 30.4000, -89.0000);
update companies set parent_company_id = 'c0000000-0000-0000-0000-000000000002' where id = 'c0000000-0000-0000-0000-000000000001';
-- schedule nightly weekdays
insert into job_schedules (company_id, divisions, title, price, assigned_to, rule, starts_on)
values ('c0000000-0000-0000-0000-000000000001', '{d0000000-0000-0000-0000-00000000000a}', 'Nightly valet', 120, 'a0000000-0000-0000-0000-000000000002',
 '{"freq":"weekly","every":1,"days":[1,2,3,4,5],"start_time":"19:00","duration_min":120}', current_date);
select schedules_generate(14) as generated;
select schedules_generate(14) as generated_again;
-- a one-off job now
insert into jobs (company_id, title, price, assigned_to, scheduled_start, scheduled_end, divisions)
values ('c0000000-0000-0000-0000-000000000001', 'Pickup', 200, 'a0000000-0000-0000-0000-000000000002', now() - interval '1 hour', now() + interval '2 hours', '{d0000000-0000-0000-0000-00000000000a}') returning id as job \gset

-- worker flow
select set_config('test.uid', 'a0000000-0000-0000-0000-000000000002', false);
select count(*) as worker_sees_jobs from jobs;
select job_step(:'job', 'accepted');
select job_step(:'job', 'arrived', 30.4001, -89.0001, 10);        -- ~50 ft away, inside
select job_step(:'job', 'started');
select job_cost_add(:'job', null, 'Dumpster roller', 1, 35, 'Front left roller broke');
select job_step(:'job', 'completed');
select job_step(:'job', 'left', 30.4100, -89.0000, 10);          -- ~3600 ft, flagged
select status, approval, flags from jobs where id = :'job';
do $$ begin perform job_step((select id from jobs where title='Pickup'), 'accepted'); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; end $$;
-- worker can't change price
do $$ begin update jobs set price = 1 where title = 'Pickup'; raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'price guard ok: %', sqlerrm; end $$;
-- worker can't edit status directly
do $$ begin update jobs set status = 'left' where title = 'Pickup'; raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'status guard ok: %', sqlerrm; end $$;
-- worker can't make roles
do $$ begin perform role_save(null, 'boss', '{}'::jsonb); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'role guard ok: %', sqlerrm; end $$;
select count(*) as worker_sees_reviews from work_reviews;
-- time clock
select clock_in(:'job', null, 30.4, -89.0, 5) is not null as clocked_in;
select break_toggle(), break_toggle();
do $$ begin update time_entries set clock_in = clock_in - interval '9 hours'; raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'time guard ok: %', sqlerrm; end $$;
select clock_out(30.4, -89.0, 5) is not null as clocked_out;

-- manager (scope all, review approve) decides
select set_config('test.uid', 'a0000000-0000-0000-0000-000000000003', false);
select kind, status, summary from work_reviews order by created_at;
-- manager can't give himself / a role more than he has (manager has settings 0)
do $$ begin perform role_save(null, 'x', '{"settings":{"level":4,"scope":"all"}}'::jsonb); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'no-higher ok: %', sqlerrm; end $$;
select work_review_decide(id, 'approve', null, '{"category":"parts"}') from work_reviews where kind = 'cost_category';
select work_review_decide(id, 'approve') from work_reviews where kind = 'job_done';
select work_review_decide(id, 'approve') from work_reviews where kind = 'timesheet';
select work_review_decide(id, 'approve', null, '{}') from work_reviews where kind = 'gps_flag';
select approval from jobs where id = :'job';

-- admin: rates + pay batch
select set_config('test.uid', 'a0000000-0000-0000-0000-000000000001', false);
select pay_rate_save('a0000000-0000-0000-0000-000000000002', 'daily', 150, 'd0000000-0000-0000-0000-00000000000a', current_date - 30, null) is not null as rate1;
select pay_rate_save('a0000000-0000-0000-0000-000000000002', 'per_job', 60, null, current_date - 30, null) is not null as rate2;
select pay_batch_build(current_date - 7, current_date + 1, 'w2') as batch \gset
select kind, hours, days, jobs, rate, amount from pay_lines where batch_id = :'batch' order by kind;
select total from pay_batches where id = :'batch';
select pay_batch_set(:'batch', 'finalize'); select pay_batch_set(:'batch', 'exported', 'adp_run');
-- MFA requirement blocks approvals at aal1
select account_settings_save('{"require_mfa":true}') is not null;
select private.can('review', 3) as can_approve_aal1;
select set_config('test.aal', 'aal2', false);
select private.can('review', 3) as can_approve_aal2;
-- someone with team manage but no settings can't build a role with settings
select set_config('test.aal', 'aal1', false);
select account_settings_save('{"require_mfa":false}') is not null;
select role_save(null, 'Team boss', '{"team":{"level":4,"scope":"all"},"jobs":{"level":2,"scope":"own"}}'::jsonb) as tb \gset
select user_role_set('a0000000-0000-0000-0000-000000000003', :'tb');
select set_config('test.uid', 'a0000000-0000-0000-0000-000000000003', false);
do $$ begin perform role_save(null, 'x', '{"settings":{"level":4,"scope":"all"}}'::jsonb); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'no-higher ok: %', sqlerrm; end $$;
do $$ begin perform role_save(null, 'x', '{"jobs":{"level":2,"scope":"all"}}'::jsonb); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'no-wider ok: %', sqlerrm; end $$;
select role_save(null, 'ok role', '{"jobs":{"level":1,"scope":"own"}}'::jsonb) is not null as lower_ok;
select set_config('test.uid', 'a0000000-0000-0000-0000-000000000001', false);
-- nesting off: a parent can't have a parent
do $$ begin update companies set parent_company_id = 'c0000000-0000-0000-0000-000000000001' where id = 'c0000000-0000-0000-0000-000000000002'; raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'loop/nesting ok: %', sqlerrm; end $$;
select schedule_apply(id) as reset_jobs from job_schedules;
-- tenant isolation
select set_config('test.uid', 'a0000000-0000-0000-0000-000000000009', false);
select count(*) as outsider_jobs from jobs; select count(*) as outsider_reviews from work_reviews; select count(*) as outsider_time from time_entries;
reset role;
select count(*) filter (where status='scheduled') sched, count(*) total from jobs;
set role authenticated;
select set_config('test.uid', 'a0000000-0000-0000-0000-000000000001', false);
select revenue, labor, other_costs from job_profit(current_date - 7, current_date + 1);
insert into shortcuts (screen, name, filters) values ('review', 'Pins', '{"kind":"pin_change"}');
select count(*) shortcuts from shortcuts;
