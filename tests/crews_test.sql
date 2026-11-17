-- 071: crews on jobs. Run with tests/run_db.sh tests/crews_test.sql
\set ON_ERROR_STOP 1
insert into tenants (id, name) values ('11000000-0000-0000-0000-000000000001', 'Crew Co'), ('22000000-0000-0000-0000-000000000002', 'Other');
insert into app_users (id, full_name, role, is_admin, tenant_id) values
 ('c1000000-0000-0000-0000-000000000001', 'Admin Al', 'staff', true, '11000000-0000-0000-0000-000000000001'),
 ('c1000000-0000-0000-0000-000000000002', 'Bob Foreman', 'staff', false, '11000000-0000-0000-0000-000000000001'),
 ('c1000000-0000-0000-0000-000000000003', 'Joe Member', 'staff', false, '11000000-0000-0000-0000-000000000001'),
 ('c1000000-0000-0000-0000-000000000004', 'Bill Member', 'staff', false, '11000000-0000-0000-0000-000000000001'),
 ('c1000000-0000-0000-0000-000000000005', 'Sam Super', 'staff', false, '11000000-0000-0000-0000-000000000001'),
 ('c1000000-0000-0000-0000-000000000006', 'Dee Dispatch', 'staff', false, '11000000-0000-0000-0000-000000000001'),
 ('c1000000-0000-0000-0000-000000000007', 'Tim Foreman', 'staff', false, '11000000-0000-0000-0000-000000000001'),
 ('c1000000-0000-0000-0000-000000000008', 'Ted Member', 'staff', false, '11000000-0000-0000-0000-000000000001'),
 ('c1000000-0000-0000-0000-000000000009', 'Outsider', 'staff', true, '22000000-0000-0000-0000-000000000002');
insert into companies (id, tenant_id, name) values ('c2000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'Mall Lot');
insert into location_pins (tenant_id, company_id, label, lat, lng) values ('11000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'Gate', 30.4, -89.0);

set role authenticated;
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000001', false);
select account_settings_save('{"features":{"jobs":true,"dispatch":true,"timeclock":true,"pay":true},"crews":{"mode":"standing"}}'::jsonb)->'crews' as crews;
do $$ begin perform account_settings_save('{"crews":{"mode":"sometimes"}}'::jsonb); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'settings check ok: %', sqlerrm; end $$;
select role_save(null, 'Field worker', (role_presets()->'field_worker'->'perms'), 'field_worker') as fw \gset
select role_save(null, 'Manager', (role_presets()->'manager'->'perms'), 'manager') as mg \gset
select role_save(null, 'Dispatcher', '{"jobs":{"level":2,"scope":"all"},"dispatch":{"level":2,"scope":"all"}}'::jsonb) as dp \gset
select user_role_set(u, :'fw') from unnest(array['c1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000004',
  'c1000000-0000-0000-0000-000000000007', 'c1000000-0000-0000-0000-000000000008']::uuid[]) u;
select user_role_set('c1000000-0000-0000-0000-000000000005', :'mg');
select user_role_set('c1000000-0000-0000-0000-000000000006', :'dp');

-- saved crews
select crew_save(null, 'Bob''s crew', 'c1000000-0000-0000-0000-000000000002', array['c1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000004']::uuid[], 'c1000000-0000-0000-0000-000000000005') as crew1 \gset
select crew_save(null, 'Tim''s crew', 'c1000000-0000-0000-0000-000000000007', array['c1000000-0000-0000-0000-000000000008']::uuid[], 'c1000000-0000-0000-0000-000000000005') as crew2 \gset
do $$ begin perform crew_save(null, 'Two bosses', 'c1000000-0000-0000-0000-000000000002', '{}', null); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'one crew per foreman ok: %', sqlerrm; end $$;
do $$ begin perform crew_save(null, 'Outside', 'c1000000-0000-0000-0000-000000000009', '{}', null); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'team check ok: %', sqlerrm; end $$;

insert into jobs (company_id, title, price, scheduled_start, scheduled_end, service_type) values ('c2000000-0000-0000-0000-000000000001', 'Restripe', 900, now() - interval '1 hour', now() + interval '4 hours', 'Paving') returning id as job \gset
select job_crew_set(:'job', :'crew1', null)->>'lead' = 'c1000000-0000-0000-0000-000000000002' as lead_is_bob;
select (select full_name from app_users where id = assigned_to) as assigned, crew_id = :'crew1' as crew_set from jobs where id = :'job';
select count(*) as on_crew from job_crew where job_id = :'job' and removed_at is null;

-- the dispatcher pulls Ted off Tim's crew for this job: goes to Review. The supervisor doing it: no flag.
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000006', false);
select job_crew_set(:'job', :'crew1', array['c1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000008']::uuid[])->>'swaps' as swaps_by_dispatcher;
select summary from crew_flags where kind = 'swap';
select (select array_length(member_ids, 1) from crews where id = :'crew2') as tims_crew_unchanged;
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000005', false);
insert into jobs (company_id, title, scheduled_start) values ('c2000000-0000-0000-0000-000000000001', 'Sweep', now() + interval '1 day') returning id as job2 \gset
select job_crew_set(:'job2', :'crew2', array['c1000000-0000-0000-0000-000000000007', 'c1000000-0000-0000-0000-000000000003']::uuid[])->>'swaps' as swaps_by_supervisor;
select crew_flag_seen(id, 'ok') from crew_flags where kind = 'swap';

-- crew members see the job; the foreman marks arrived; Bill and Ted never clocked in
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000003', false);
select count(*) as joe_sees from jobs where id = :'job';
select clock_in(:'job', null, 30.4, -89.0, 5) is not null as joe_clocked_in;
select job_note(:'job', 'note', 'Joe was here', null) is not null as joe_note;
do $$ begin perform crew_mark((select id from jobs where title = 'Restripe'), 'arrived', 30.4, -89.0, 5); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'steps by foreman ok: %', sqlerrm; end $$;
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000002', false);
select job_step(:'job', 'accepted')->>'status', job_step(:'job', 'en_route')->>'status';
select job_step(:'job', 'arrived', 30.4, -89.0, 5)->>'status';
select count(*) filter (where arrived_at is not null) as crew_arrived from job_crew where job_id = :'job' and removed_at is null;
select u.full_name, f.status from crew_flags f join app_users u on u.id = f.user_id where f.kind = 'missed_clock' order by 1;
-- Ted clocks in late: his flag clears
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000008', false);
select clock_in(:'job', null, 30.4, -89.0, 5) is not null as ted_clocked_in;
select count(*) as ted_open_flags from crew_flags where kind = 'missed_clock' and status = 'open';
-- Bob answers for Bill: was here, 6 hours
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000002', false);
select count(*) as bob_sees_flags from crew_flags where kind = 'missed_clock';
select crew_missed_answer(f.id, true, 6, 'Phone died')->>'status' from crew_flags f where f.kind = 'missed_clock' and f.status = 'open';
do $$ begin perform crew_missed_answer((select id from crew_flags where status = 'was_here'), false); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'answer once ok: %', sqlerrm; end $$;
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000005', false);
select summary, details->>'note' as note, supervisor_id = 'c1000000-0000-0000-0000-000000000005' as to_sam from work_reviews where kind = 'timesheet';
select status, flags, round(extract(epoch from clock_out - clock_in) / 3600) as hrs from time_entries where 'added_by_foreman' = any(flags);
select work_review_decide(id, 'approve') from work_reviews where kind = 'timesheet' and status = 'pending';

-- split pay: 300 across the 4 on the crew; Joe's hours on that job don't pay twice
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000003', false);
select clock_out(30.4, -89.0, 5) is not null;
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000008', false);
select clock_out(30.4, -89.0, 5) is not null;
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000002', false);
select job_step(:'job', 'started')->>'status', job_step(:'job', 'completed')->>'status', job_step(:'job', 'left', 30.4, -89.0, 5)->>'status';
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000001', false);
select account_settings_save('{"crews":{"mode":"standing","pay":"split"}}'::jsonb) is not null;
update jobs set pay_amount = 300 where id = :'job';
select work_review_decide(id, 'approve') from work_reviews where status = 'pending' and kind in ('job_done', 'timesheet');
select pay_rate_save(u, 'hourly', 20, null, current_date - 30, null) is not null from unnest(array['c1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000008']::uuid[]) u;
select pay_batch_build(current_date - 7, current_date + 1, 'w2') as batch \gset
select u.full_name, l.kind, l.amount from pay_lines l join app_users u on u.id = l.user_id where batch_id = :'batch' order by 1, 2;
select total from pay_batches where id = :'batch';
select pay_batch_build(current_date - 7, current_date + 1, 'w2', null, :'batch') = :'batch' as rebuilt;
select total from pay_batches where id = :'batch';

-- unassigning clears the crew; the old one-person move still works
update jobs set assigned_to = null where id = :'job2';
select count(*) as job2_crew_left from job_crew where job_id = :'job2' and removed_at is null;
update jobs set assigned_to = 'c1000000-0000-0000-0000-000000000004' where id = :'job2';
select (select full_name from app_users where id = user_id), role from job_crew where job_id = :'job2' and removed_at is null;

-- foreman clocks the crew for one service type
select account_settings_save('{"crews":{"mode":"standing","by_service":{"Striping":{"clock":"foreman"}}}}'::jsonb) is not null;
insert into jobs (company_id, title, scheduled_start, service_type) values ('c2000000-0000-0000-0000-000000000001', 'Lines', now(), 'Striping') returning id as job3 \gset
select job_crew_set(:'job3', :'crew1', null) is not null;
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000002', false);
select crew_clock(:'job3', 'in', 30.4, -89.0, 5) as clocked_in_crew;
select job_step(:'job3', 'accepted') is not null, job_step(:'job3', 'arrived', 30.4, -89.0, 5) is not null;
select count(*) as no_missed_flags_job3 from crew_flags where job_id = :'job3';
select crew_clock(:'job3', 'out', 30.4, -89.0, 5) as clocked_out_crew;
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000001', false);
select count(*) as crew_timesheets from work_reviews where kind = 'timesheet' and job_id = :'job3';
do $$ begin perform crew_clock((select id from jobs where title = 'Restripe'), 'in'); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'clock mode per service ok: %', sqlerrm; end $$;

-- each person marks their own steps
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000001', false);
select account_settings_save('{"crews":{"mode":"pick","steps":"each"}}'::jsonb) is not null;
do $$ begin perform job_crew_set((select id from jobs where title = 'Lines'), (select id from crews limit 1), null); raise exception 'should have failed'; exception when others then if sqlerrm = 'should have failed' then raise; end if; raise notice 'pick mode ok: %', sqlerrm; end $$;
insert into jobs (company_id, title, scheduled_start) values ('c2000000-0000-0000-0000-000000000001', 'Pick job', now()) returning id as job4 \gset
select job_crew_set(:'job4', null, array['c1000000-0000-0000-0000-000000000007', 'c1000000-0000-0000-0000-000000000004']::uuid[])->>'swaps' as swaps_in_pick_mode;
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000004', false);
select crew_mark(:'job4', 'arrived', 30.4, -89.0, 5)->>'step' as bill_marked;
select arrived_at is not null as bill_arrived from job_crew where job_id = :'job4' and user_id = 'c1000000-0000-0000-0000-000000000004';

-- schedules carry their crew
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000001', false);
insert into job_schedules (company_id, title, crew_id, rule, starts_on) values ('c2000000-0000-0000-0000-000000000001', 'Weekly sweep', :'crew1', '{"freq":"daily","every":1,"start_time":"06:00","duration_min":60}', current_date + 1);
select schedules_generate(3) > 0 as generated;
select bool_and(j.assigned_to = 'c1000000-0000-0000-0000-000000000002') as foreman_leads, min(n) as crew_size from jobs j
  cross join lateral (select count(*) n from job_crew c where c.job_id = j.id and c.removed_at is null) x where j.title = 'Weekly sweep';

-- other accounts see nothing
select set_config('test.uid', 'c1000000-0000-0000-0000-000000000009', false);
select (select count(*) from crews) + (select count(*) from job_crew) + (select count(*) from crew_flags) as outsider_sees;
select 'crews done';
