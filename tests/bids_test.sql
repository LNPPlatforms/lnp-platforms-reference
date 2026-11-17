-- 073: bids. Run with tests/run_db.sh tests/bids_test.sql
\set ON_ERROR_STOP 1
create function pg_temp.ok(b boolean, what text) returns text language plpgsql as $$
begin if b is not true then raise exception 'FAILED: %', what; end if; return 'ok ' || what; end $$;
create function pg_temp.fails(q text, what text) returns text language plpgsql as $$
begin begin execute q; exception when others then return 'ok ' || what || ' (' || sqlerrm || ')'; end; raise exception 'FAILED (should have stopped): %', what; end $$;
grant execute on function pg_temp.ok(boolean, text), pg_temp.fails(text, text) to authenticated;

insert into tenants (id, name, slug) values ('41000000-0000-0000-0000-000000000001', 'Bid Co', 'bidco'), ('42000000-0000-0000-0000-000000000002', 'Other', 'other');
insert into app_users (id, full_name, role, is_admin, tenant_id) values
 ('e1000000-0000-0000-0000-000000000001', 'Admin Al', 'staff', true, '41000000-0000-0000-0000-000000000001'),
 ('e1000000-0000-0000-0000-000000000002', 'Rita Rep', 'staff', false, '41000000-0000-0000-0000-000000000001'),
 ('e1000000-0000-0000-0000-000000000003', 'Fred Field', 'staff', false, '41000000-0000-0000-0000-000000000001'),
 ('e1000000-0000-0000-0000-000000000004', 'Andy Accounting', 'staff', false, '41000000-0000-0000-0000-000000000001'),
 ('e1000000-0000-0000-0000-000000000009', 'Outsider', 'staff', true, '42000000-0000-0000-0000-000000000002');
insert into companies (id, tenant_id, name) values ('e2000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001', 'Mall'),
  ('e2000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000002', 'Theirs');

-- the math on its own
select pg_temp.ok(private.bid_points(50000, 50000, 5000) = 5 and private.bid_points(5000, 50000, 5000) = 1 and private.bid_points(27500, 50000, 5000) = 3, 'points line');
select pg_temp.ok(private.bid_points(25, 25, 100) = 5 and private.bid_points(150, 25, 100) = 1 and private.bid_points(62.5, 25, 100) = 3, 'points closer is better');
select pg_temp.ok(private.bid_miles(30.396, -88.8853, 31.3271, -89.2903) between 67 and 70, 'Biloxi to Hattiesburg about 68 miles');
select pg_temp.ok(private.bid_miles(30, -89, 30, -89) = 0 and private.bid_miles(null, 1, 2, 3) is null, 'miles edge cases');

set role authenticated;
select set_config('test.uid', 'e1000000-0000-0000-0000-000000000001', false);
select pg_temp.ok(not private.feature_on('bids'), 'off by default');
select pg_temp.ok(bid_settings_get() is null, 'no settings while off');
select pg_temp.fails($q$ insert into bids (title) values ('x') $q$, 'no bids while off');
select pg_temp.ok(account_settings_save('{"features":{"bids":true}}'::jsonb) is not null, 'switched on');
select pg_temp.ok((bid_settings_get()->>'can_edit')::boolean and not (bid_settings_get()->>'set_up')::boolean, 'admin can set up');
select role_save(null, 'Sales rep', (role_presets()->'sales_rep'->'perms'), 'sales_rep') as rep \gset
select role_save(null, 'Field worker', (role_presets()->'field_worker'->'perms'), 'field_worker') as fw \gset
select role_save(null, 'Accounting', (role_presets()->'accounting'->'perms'), 'accounting') as acc \gset
select user_role_set('e1000000-0000-0000-0000-000000000002', :'rep');
select user_role_set('e1000000-0000-0000-0000-000000000003', :'fw');
select user_role_set('e1000000-0000-0000-0000-000000000004', :'acc');

-- scorecard: value and margin rank 1 (weight 3), distance and crew rank 2 (weight 2), one yes/no rank 3 (weight 1)
select pg_temp.ok(jsonb_array_length(bid_settings_save(jsonb_build_object('base_address', 'Biloxi', 'base_lat', 30.396, 'base_lng', -88.8853, 'go_at', 70, 'maybe_at', 45,
  'metrics', jsonb_build_array(
    jsonb_build_object('kind', 'value', 'label', 'Job size', 'rank', 1, 'good', 50000, 'poor', 5000),
    jsonb_build_object('kind', 'margin', 'label', 'Margin', 'rank', 1, 'good', 30, 'poor', 10),
    jsonb_build_object('kind', 'distance', 'label', 'Distance', 'rank', 2, 'good', 25, 'poor', 100),
    jsonb_build_object('kind', 'crew', 'label', 'Crew free', 'rank', 2),
    jsonb_build_object('kind', 'yesno', 'key', 'q_repeat', 'label', 'Worked for them before', 'rank', 3))))->'metrics') = 5, 'scorecard saved');
select pg_temp.fails($q$ select bid_settings_save('{"metrics":[{"kind":"value","label":"x","rank":4,"good":1,"poor":0}]}') $q$, 'rank must be 1 to 3');
select pg_temp.fails($q$ select bid_settings_save('{"metrics":[{"kind":"crew","label":"a","rank":1},{"kind":"crew","label":"b","rank":1}]}') $q$, 'no doubles');
select pg_temp.fails($q$ select bid_settings_save('{"go_at":40,"maybe_at":60,"metrics":[]}') $q$, 'maybe above go');
select pg_temp.fails($q$ select bid_settings_save('{"metrics":[{"kind":"value","label":"x","rank":1}]}') $q$, 'value needs good and poor');

-- a perfect bid: everything at good, close by, crew free, repeat customer: 100, go
insert into bids (title, company_id, est_value, est_margin, site_lat, site_lng, site_address, answers)
values ('Big lot', 'e2000000-0000-0000-0000-000000000001', 60000, 35, 30.40, -88.89, 'Biloxi', '{"crew":"yes","q_repeat":"yes"}') returning id as b1 \gset
select pg_temp.ok(score = 100 and result = 'go' and distance_mi < 1 and jsonb_array_length(score_parts) = 5, 'perfect bid is go') from bids where id = :'b1';
-- value at the middle (3 points = 0.5), margin poor (0), 68.7 miles ((100 - 68.7) / 75 = 0.417), crew tight (0.5), not repeat (0):
-- (3x0.5 + 3x0 + 2x0.417 + 2x0.5 + 1x0) / 11 = 3.335 / 11 = 30.3: no-go
insert into bids (title, est_value, est_margin, site_lat, site_lng, site_address, answers)
values ('Far job', 27500, 5, 31.3271, -89.2903, 'Hattiesburg', '{"crew":"tight","q_repeat":"no"}') returning id as b2 \gset
select pg_temp.ok(score = 30.3 and result = 'no_go' and distance_mi > 60, 'weighted math, no-go') from bids where id = :'b2';
-- only some answered: value good (1) and margin middle (0.5): (3 + 1.5) / 6 = 75 go; unanswered left out
insert into bids (title, est_value, est_margin) values ('Half known', 50000, 20) returning id as b3 \gset
select pg_temp.ok(score = 75 and result = 'go', 'only answered metrics count') from bids where id = :'b3';
insert into bids (title) values ('Nothing known') returning id as b4 \gset
select pg_temp.ok(score is null and result is null, 'nothing answered, no score') from bids where id = :'b4';
-- moving the thresholds rescores open bids: go at 80 makes Half known a maybe
select pg_temp.ok(bid_settings_save((bid_settings_get() - 'go_at') || '{"go_at":80}') is not null, 'thresholds moved');
select pg_temp.ok(result = 'maybe', 'rescored to maybe') from bids where id = :'b3';
-- a new address with no pin drops the old pin (and the distance)
update bids set site_address = 'Somewhere else' where id = :'b1';
select pg_temp.ok(site_lat is null and distance_mi is null, 'new address, old pin gone') from bids where id = :'b1';
update bids set site_lat = 30.40, site_lng = -88.89 where id = :'b1';
-- scores can't be written by hand, nor overrides
select pg_temp.fails($q$ update bids set score = 99 $q$, 'score not writable');
select pg_temp.fails($q$ update bids set override_result = 'go' $q$, 'override not writable');
-- status dates and history
update bids set status = 'submitted', submitted_amount = 58000 where id = :'b1';
select pg_temp.ok(submitted_at is not null and history->-1->>'to' = 'submitted', 'submitted stamped') from bids where id = :'b1';
update bids set status = 'won' where id = :'b1';
select pg_temp.ok(closed_at is not null, 'won closes it') from bids where id = :'b1';

-- the rep: sees own bids only, overrides go to Review
select set_config('test.uid', 'e1000000-0000-0000-0000-000000000002', false);
select pg_temp.ok((select count(*) from bids) = 0, 'rep sees only their own');
insert into bids (title, est_value, est_margin, answers) values ('Rep bid', 6000, 12, '{"crew":"no"}') returning id as r1 \gset
select pg_temp.ok(result = 'no_go', 'rep bid scored no-go') from bids where id = :'r1';
select pg_temp.fails(format($q$ select bid_override(%L, 'go', '  ') $q$, :'r1'), 'override needs a note');
select pg_temp.ok(bid_override(:'r1', 'go', 'Their GM asked for us by name')->>'review' = 'pending', 'rep override waits in Review');
select pg_temp.ok(override_result = 'go' and review_state = 'pending' and history->-1->>'what' = 'override', 'override stored') from bids where id = :'r1';
select pg_temp.fails(format($q$ select bid_override_decide(%L, true) $q$, :'r1'), 'rep cannot approve');
select pg_temp.fails(format($q$ update bids set owner_id = 'e1000000-0000-0000-0000-000000000001' where id = %L $q$, :'r1'), 'rep cannot hand it off');
select pg_temp.fails($q$ select bid_settings_save('{"metrics":[]}') $q$, 'rep cannot change the scorecard');
select pg_temp.ok(bid_settings_get()->>'upload_token' is null, 'rep does not see the upload token');

-- the admin's Review: the rep's override is there; send it back, then a second one approved
select set_config('test.uid', 'e1000000-0000-0000-0000-000000000001', false);
select pg_temp.ok(jsonb_array_length(bid_review_list()) = 1 and bid_review_list()->0->>'note' = 'Their GM asked for us by name', 'in Review');
select bid_override_decide(:'r1', false, 'Margin is too thin');
select pg_temp.ok(override_result is null and review_state = 'returned' and result = 'no_go', 'sent back, scorecard stands') from bids where id = :'r1';
select pg_temp.ok(jsonb_array_length(bid_review_list()) = 0, 'Review empty');
-- the admin's own override counts right away
select pg_temp.ok(bid_override(:'b2', 'maybe', 'Owner wants the foothold')->>'review' = 'approved', 'approver override counts');
-- with the Review switch off, a rep override needs no Review
select pg_temp.ok(bid_settings_save(bid_settings_get() || '{"override_review":false}') is not null, 'review switch off');
select set_config('test.uid', 'e1000000-0000-0000-0000-000000000002', false);
select pg_temp.ok(bid_override(:'r1', 'go', 'Second try')->>'review' is null, 'no Review when switched off');
select pg_temp.ok(review_state is null and override_result = 'go', 'override straight in') from bids where id = :'r1';

-- files: in the account folder only
insert into bid_files (bid_id, path, name, size, mime) values (:'r1', '41000000-0000-0000-0000-000000000001/' || :'r1' || '/rfp.pdf', 'rfp.pdf', 1000, 'application/pdf');
select pg_temp.fails(format($q$ insert into bid_files (bid_id, path, name) values (%L, '42000000-0000-0000-0000-000000000002/x/rfp.pdf', 'x') $q$, :'r1'), 'wrong folder');

-- accounting views all, can't add; field workers see none
select set_config('test.uid', 'e1000000-0000-0000-0000-000000000004', false);
select pg_temp.ok((select count(*) from bids) = 5, 'accounting sees all');
select pg_temp.fails($q$ insert into bids (title) values ('x') $q$, 'accounting cannot add');
select set_config('test.uid', 'e1000000-0000-0000-0000-000000000003', false);
select pg_temp.ok((select count(*) from bids) = 0 and (select count(*) from bid_files) = 0, 'field worker sees none');

-- another account sees none of it, even switched on, and can't decide ours
select set_config('test.uid', 'e1000000-0000-0000-0000-000000000009', false);
select account_settings_save('{"features":{"bids":true}}'::jsonb);
select pg_temp.ok((select count(*) from bids) = 0 and (select count(*) from bid_files) = 0 and jsonb_array_length(bid_review_list()) = 0, 'other account sees nothing');
select pg_temp.fails(format($q$ select bid_override(%L, 'go', 'mine now') $q$, :'r1'), 'other account cannot override');
select pg_temp.fails($q$ insert into bids (title, company_id) values ('x', 'e2000000-0000-0000-0000-000000000001') $q$, 'other account cannot use our organization');

-- reports: win rate by status
select set_config('test.uid', 'e1000000-0000-0000-0000-000000000001', false);
update bids set status = 'lost' where id = :'b2';
select pg_temp.ok((report_run('{"source":"bids","group":"source","measure":"win_rate","range":"all"}')->'rows'->0->>'value')::numeric = 50, 'win rate 1 of 2');
select pg_temp.ok((select sum((r->>'value')::numeric) from jsonb_array_elements(report_run('{"source":"bids","group":"status","measure":"count","range":"all"}')->'rows') r) = 5, 'count by status');
select pg_temp.ok((report_run('{"source":"bids","group":"month","measure":"won_value","range":"all"}')->'rows'->0->>'value')::numeric = 58000, 'won value by month');
reset role;
select set_config('test.uid', '', false);   -- the service key has nobody signed in

-- intake (the edge function, service key): email to bids+bidco@ makes a bid; unknown address does nothing
select pg_temp.ok(bid_intake_email('{"to":["Bids <bids+bidco@bids.example.com>"],"from_email":"gc@builder.com","from_name":"Gary","subject":"RFP: Mall reseal","text":"See attached"}')->>'tenant_id'
  = '41000000-0000-0000-0000-000000000001', 'email intake by plus address');
select pg_temp.ok(bid_intake_email('{"to":["bidco@bids.example.com"],"subject":"Plain"}') is not null, 'email intake by plain address');
select pg_temp.ok(bid_intake_email('{"to":["nobody@bids.example.com"],"subject":"x"}') is null, 'unknown address ignored');
select pg_temp.ok((select count(*) from bids where source = 'email' and tenant_id = '41000000-0000-0000-0000-000000000001' and owner_id = 'e1000000-0000-0000-0000-000000000001') = 2, 'emailed bids go to the admin');
select pg_temp.ok((select email_subject from bids where source = 'email' and from_email = 'gc@builder.com') = 'RFP: Mall reseal', 'subject kept');
update private.bid_settings set email_on = false where tenant_id = '41000000-0000-0000-0000-000000000001';
select pg_temp.ok(bid_intake_email('{"to":["bids+bidco@x.com"],"subject":"x"}') is null, 'email switch off');
-- public upload page: closed until switched on
select upload_token as tok from private.bid_settings where tenant_id = '41000000-0000-0000-0000-000000000001' \gset
select pg_temp.ok(bid_upload_info(:'tok') is null, 'upload page closed');
update private.bid_settings set upload_on = true where tenant_id = '41000000-0000-0000-0000-000000000001';
select pg_temp.ok(bid_upload_info(:'tok')->>'name' = 'Bid Co', 'upload page open');
select pg_temp.fails(format($q$ select bid_intake_public(%L, '{"title":"x"}') $q$, :'tok'), 'public needs name and email');
select (bid_intake_public(:'tok', '{"title":"School paving","name":"Pat","email":"pat@school.org","phone":"228-555-1212","due":"2026-12-01"}')->>'bid_id') as pb \gset
select pg_temp.ok(source = 'public' and notes like '%228-555-1212%' and due_at::date = '2026-12-01', 'public bid made') from bids where id = :'pb';
select pg_temp.ok(bid_intake_file(:'pb', '41000000-0000-0000-0000-000000000001/' || :'pb' || '/plans.pdf', 'plans.pdf', 5000, 'application/pdf', 'public') is not null, 'public file recorded');
select pg_temp.fails($q$ select bid_intake_public('nope', '{"name":"a","email":"a@b.co"}') $q$, 'bad token');
-- nobody signed in can call intake directly
set role anon;
select pg_temp.fails($q$ select bid_intake_email('{"to":["bids+bidco@x.com"]}') $q$, 'anon cannot call intake');
reset role;
select 'bids tests done' as ok;
