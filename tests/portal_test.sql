-- 074: client portal. Run with tests/run_db.sh tests/portal_test.sql
-- Proves a portal login only ever sees its own organization (and the locations under it) in its own account, never
-- anything the team marked internal, and nothing at all once removed or once the account turns the portal off.
\set ON_ERROR_STOP 1
create function pg_temp.ok(b boolean, what text) returns text language plpgsql as $$
begin if b is not true then raise exception 'FAILED: %', what; end if; return 'ok ' || what; end $$;
create function pg_temp.fails(q text, what text) returns text language plpgsql as $$
begin begin execute q; exception when others then return 'ok ' || what || ' (' || sqlerrm || ')'; end; raise exception 'FAILED (should have stopped): %', what; end $$;
grant execute on function pg_temp.ok(boolean, text), pg_temp.fails(text, text) to authenticated;
grant select on auth.users to authenticated;

-- account A (with the portal), account B (another account)
insert into tenants (id, name, slug) values ('51000000-0000-0000-0000-000000000001', 'Home Co', 'homeco'), ('52000000-0000-0000-0000-000000000002', 'Other Co', 'otherco');
insert into app_users (id, full_name, email, role, is_admin, tenant_id) values
 ('f1000000-0000-0000-0000-000000000001', 'Admin Al', 'al@home.co', 'staff', true, '51000000-0000-0000-0000-000000000001'),
 ('f1000000-0000-0000-0000-000000000002', 'Fred Field', 'fred@home.co', 'staff', false, '51000000-0000-0000-0000-000000000001'),
 ('f1000000-0000-0000-0000-000000000009', 'Bea Other', 'bea@other.co', 'staff', true, '52000000-0000-0000-0000-000000000002');
-- Gulf Mgmt (parent) with Oak Apartments under it, another client Pine Plaza, and account B's own client
insert into companies (id, tenant_id, name, parent_company_id) values
 ('f2000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', 'Gulf Mgmt', null),
 ('f2000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000001', 'Oak Apartments', 'f2000000-0000-0000-0000-000000000001'),
 ('f2000000-0000-0000-0000-000000000003', '51000000-0000-0000-0000-000000000001', 'Pine Plaza', null),
 ('f2000000-0000-0000-0000-000000000009', '52000000-0000-0000-0000-000000000002', 'Theirs', null);
insert into jobs (id, tenant_id, company_id, title, scheduled_start, scheduled_end, price, notes, portal_hidden) values
 ('f3000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000002', 'Oak cleanout', now() + interval '2 days', now() + interval '2 days 2 hours', 500, 'gate code 4321, tenant is difficult', false),
 ('f3000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'Secret walk-through', now() + interval '3 days', null, 0, null, true),
 ('f3000000-0000-0000-0000-000000000003', '51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000003', 'Pine mowing', now() + interval '1 day', null, 90, null, false),
 ('f3000000-0000-0000-0000-000000000009', '52000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000009', 'Their job', now() + interval '1 day', null, 90, null, false);
insert into invoices (id, tenant_id, company_id, status, lines, total, balance, issue_date, due_date, portal_hidden) values
 ('f4000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'sent', '[{"name":"Work","qty":1,"price":500}]', 0, 0, current_date, current_date + 30, false),
 ('f4000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'draft', '[{"name":"Work","qty":1,"price":50}]', 0, 0, current_date, null, false),
 ('f4000000-0000-0000-0000-000000000003', '51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000002', 'sent', '[{"name":"Work","qty":1,"price":70}]', 0, 0, current_date, null, true),
 ('f4000000-0000-0000-0000-000000000004', '51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000003', 'sent', '[{"name":"Work","qty":1,"price":90}]', 0, 0, current_date, null, false),
 ('f4000000-0000-0000-0000-000000000009', '52000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000009', 'sent', '[{"name":"Work","qty":1,"price":90}]', 0, 0, current_date, null, false);
insert into proposals (id, tenant_id, company_id, status, sent_at, expires_at) values
 ('f5000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000002', 'sent', now(), now() + interval '20 days'),
 ('f5000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'draft', null, null),
 ('f5000000-0000-0000-0000-000000000003', '51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000003', 'sent', now(), null);
insert into company_assets (id, tenant_id, company_id, kind, title, url, portal_share) values
 ('f6000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'document', 'Internal pricing sheet', 'https://x.test/a.pdf', null),
 ('f6000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'document', 'Service agreement', 'https://x.test/b.pdf', 'shared'),
 ('f6000000-0000-0000-0000-000000000003', '51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000003', 'document', 'Pine contract', 'https://x.test/c.pdf', 'shared'),
 ('f6000000-0000-0000-0000-000000000004', '51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000002', 'document', 'Marked internal', 'https://x.test/d.pdf', 'internal');
insert into job_events (id, tenant_id, job_id, kind, photo_path, note, portal_share) values
 ('f7000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', 'photo', '51000000-0000-0000-0000-000000000001/jobs/shared.jpg', 'worker only note', 'shared'),
 ('f7000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', 'photo', '51000000-0000-0000-0000-000000000001/jobs/default.jpg', null, null),
 ('f7000000-0000-0000-0000-000000000003', '51000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000003', 'photo', '51000000-0000-0000-0000-000000000001/jobs/pine.jpg', null, 'shared'),
 ('f7000000-0000-0000-0000-000000000004', '51000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000002', 'photo', '51000000-0000-0000-0000-000000000001/jobs/hiddenjob.jpg', null, 'shared');
insert into invites (tenant_id, email, full_name, role) values ('51000000-0000-0000-0000-000000000001', 'newhire@home.co', 'New Hire', 'staff');

set role authenticated;
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
-- the switch
select pg_temp.ok(not private.feature_on('portal'), 'off by default');
select pg_temp.ok(portal_admin_get('f2000000-0000-0000-0000-000000000001') is null, 'nothing while off');
select pg_temp.fails($q$ select portal_admin_invite('f2000000-0000-0000-0000-000000000001', 'pam@gulf.test', 'Pam') $q$, 'no invites while off');
select pg_temp.ok(account_settings_save('{"features":{"portal":true}}'::jsonb) is not null, 'switched on');
select pg_temp.ok((portal_settings_get()->>'files_default') = 'hidden' and (portal_settings_get()->'sections'->>'schedule')::boolean, 'defaults: all sections, files hidden');

-- the first invite is the client's admin; later ones are not
select portal_admin_invite('f2000000-0000-0000-0000-000000000001', 'Pam@Gulf.test', 'Pam Smith') as pam_pu \gset
select portal_admin_invite('f2000000-0000-0000-0000-000000000001', 'bob@gulf.test', 'Bob') as bob_pu \gset
select portal_admin_invite('f2000000-0000-0000-0000-000000000003', 'carl@pine.test', 'Carl') as carl_pu \gset
reset role;
select pg_temp.ok((select is_admin from private.portal_users where id = :'pam_pu') and not (select is_admin from private.portal_users where id = :'bob_pu'), 'first invite is admin');
set role authenticated;
select pg_temp.ok(jsonb_array_length(portal_admin_get('f2000000-0000-0000-0000-000000000001')->'users') = 2, 'card lists both');
select pg_temp.ok(portal_admin_get('f2000000-0000-0000-0000-000000000002')->'parent_portal'->>'name' = 'Gulf Mgmt', 'a location sees its parent has a portal');
select pg_temp.fails($q$ select portal_admin_invite('f2000000-0000-0000-0000-000000000001', 'pam@gulf.test', 'Pam') $q$, 'no double invite');
select pg_temp.fails($q$ select portal_admin_invite('f2000000-0000-0000-0000-000000000001', 'fred@home.co', 'Fred') $q$, 'a CRM login can''t be a portal user');
select pg_temp.fails($q$ select portal_admin_invite('f2000000-0000-0000-0000-000000000001', 'newhire@home.co', 'x') $q$, 'nor someone with an open team invite');
select pg_temp.fails($q$ select portal_admin_invite('f2000000-0000-0000-0000-000000000009', 'z@z.test', 'x') $q$, 'not another account''s organization');
select pg_temp.ok((portal_invite_info(:'pam_pu')->>'org') = 'Gulf Mgmt' and (portal_invite_info(:'bob_pu')->>'is_admin')::boolean = false, 'invite email details for the team');
-- a field worker can't manage portals
select role_save(null, 'Field worker', (role_presets()->'field_worker'->'perms'), 'field_worker') as fw \gset
select user_role_set('f1000000-0000-0000-0000-000000000002', :'fw');
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000002', false);
select pg_temp.ok(portal_admin_get('f2000000-0000-0000-0000-000000000001') is null, 'field worker sees no portal card');
select pg_temp.fails($q$ select portal_admin_invite('f2000000-0000-0000-0000-000000000001', 'q@gulf.test', 'Q') $q$, 'field worker can''t invite');
select pg_temp.ok(portal_invite_info(:'pam_pu') is null, 'field worker can''t send invites');

-- signing up: the invitee becomes a portal user, never staff; someone with no invite is stopped
reset role;
insert into auth.users (id, email, raw_user_meta_data) values ('f8000000-0000-0000-0000-000000000001', 'pam@gulf.test', '{"full_name":"Pam S"}'),
  ('f8000000-0000-0000-0000-000000000002', 'BOB@gulf.test', '{}'), ('f8000000-0000-0000-0000-000000000003', 'carl@pine.test', '{}');
select pg_temp.ok(not exists (select 1 from app_users where id::text like 'f8%'), 'no app_users rows for portal logins');
select pg_temp.ok((select user_id from private.portal_users where id = :'pam_pu') = 'f8000000-0000-0000-0000-000000000001'
  and (select accepted_at is not null from private.portal_users where id = :'bob_pu'), 'logins linked');
select pg_temp.fails($q$ insert into auth.users (email) values ('stranger@x.test') $q$, 'no invite, no login');
select pg_temp.fails($q$ insert into invites (tenant_id, email, role) values ('51000000-0000-0000-0000-000000000001', 'pam@gulf.test', 'staff') $q$, 'a portal login can''t be invited to the team');
insert into auth.users (id, email) values ('f8000000-0000-0000-0000-000000000005', 'newhire@home.co');
select pg_temp.ok((select role::text from app_users where id = 'f8000000-0000-0000-0000-000000000005') = 'staff'
  and not exists (select 1 from private.portal_users where user_id = 'f8000000-0000-0000-0000-000000000005'), 'staff invites still make staff');

-- Pam (client admin of Gulf Mgmt) sees Gulf Mgmt and Oak Apartments, nothing else
set role authenticated;
select set_config('test.uid', 'f8000000-0000-0000-0000-000000000001', false);
select pg_temp.ok(private.current_tenant() = '00000000-0000-0000-0000-000000000000' and not private.is_internal() and not private.is_admin()
  and coalesce((private.perm('invoices')->>'level')::int, 0) = 0, 'a portal login is nobody to the CRM');
select pg_temp.ok((select count(*) from companies) = 0 and (select count(*) from jobs) = 0 and (select count(*) from invoices) = 0
  and (select count(*) from chat_threads) = 0 and (select count(*) from portal_approvals) = 0 and (select count(*) from tenants) = 0
  and (select count(*) from app_users) = 0, 'tables show nothing');
select pg_temp.fails($q$ select count(*) from private.portal_users $q$, 'the portal users table is closed');
select pg_temp.ok(jsonb_array_length(portal_me()->'portals') = 1 and (portal_me()->'portals'->0->>'org') = 'Gulf Mgmt', 'my portals');
select pg_temp.ok((select array_agg(x->>'title' order by x->>'title') from jsonb_array_elements(portal_schedule(:'pam_pu')) x) = array['Oak cleanout'], 'schedule: child location only, hidden job left out');
select pg_temp.ok(not (portal_schedule(:'pam_pu')->0 ? 'price') and not (portal_schedule(:'pam_pu')::text like '%gate code%'), 'no price, no team notes');
select pg_temp.ok((select array_agg(x->>'id') from jsonb_array_elements(portal_docs(:'pam_pu', 'invoices')) x) = array['f4000000-0000-0000-0000-000000000001'], 'invoices: sent, not draft, not hidden, not the other client');
select pg_temp.ok((select array_agg(x->>'id') from jsonb_array_elements(portal_docs(:'pam_pu', 'estimates')) x) = array['f5000000-0000-0000-0000-000000000001'], 'estimates: sent only, own orgs');
select pg_temp.ok((portal_doc(:'pam_pu', 'invoice', 'f4000000-0000-0000-0000-000000000001')->>'link') like '/doc/?t=%'
  and not (portal_doc(:'pam_pu', 'invoice', 'f4000000-0000-0000-0000-000000000001') ? 'token'), 'invoice with the pay link');
select pg_temp.fails($q$ select portal_doc('$q$ || :'pam_pu' || $q$', 'invoice', 'f4000000-0000-0000-0000-000000000003') $q$, 'hidden invoice');
select pg_temp.fails($q$ select portal_doc('$q$ || :'pam_pu' || $q$', 'invoice', 'f4000000-0000-0000-0000-000000000002') $q$, 'draft invoice');
select pg_temp.fails($q$ select portal_doc('$q$ || :'pam_pu' || $q$', 'invoice', 'f4000000-0000-0000-0000-000000000004') $q$, 'other client''s invoice');
select pg_temp.fails($q$ select portal_doc('$q$ || :'pam_pu' || $q$', 'invoice', 'f4000000-0000-0000-0000-000000000009') $q$, 'other account''s invoice');
select pg_temp.fails($q$ select portal_doc('$q$ || :'pam_pu' || $q$', 'estimate', 'f5000000-0000-0000-0000-000000000003') $q$, 'other client''s estimate');
select pg_temp.ok((select array_agg(x->>'title') from jsonb_array_elements(portal_files(:'pam_pu')->'files') x) = array['Service agreement'], 'files: only shared, default hidden');
select pg_temp.ok((select array_agg(x->>'path') from jsonb_array_elements(portal_files(:'pam_pu')->'photos') x) = array['51000000-0000-0000-0000-000000000001/jobs/shared.jpg']
  and not (portal_files(:'pam_pu')::text like '%worker only%'), 'photos: shared ones, no worker notes');
select pg_temp.ok(private.portal_photo_ok('51000000-0000-0000-0000-000000000001/jobs/shared.jpg'), 'shared photo opens');
select pg_temp.ok(not private.portal_photo_ok('51000000-0000-0000-0000-000000000001/jobs/default.jpg') and not private.portal_photo_ok('51000000-0000-0000-0000-000000000001/jobs/pine.jpg')
  and not private.portal_photo_ok('51000000-0000-0000-0000-000000000001/jobs/hiddenjob.jpg'), 'not shared, other client and hidden job photos stay closed');
select pg_temp.ok((portal_home(:'pam_pu')->'counts'->>'upcoming')::int = 1 and (portal_home(:'pam_pu')->'counts'->>'balance')::numeric = 500
  and (portal_home(:'pam_pu')->>'is_admin')::boolean, 'home counts');
-- messages land in the Inbox
select pg_temp.ok((portal_send(:'pam_pu', 'When is the next pickup?')->>'ok')::boolean, 'sent a message');
select pg_temp.ok((portal_messages(:'pam_pu')->'messages'->0->>'from') = 'me', 'my message');
select pg_temp.fails($q$ select portal_send('$q$ || :'pam_pu' || $q$', '   ') $q$, 'empty message');
-- her team
select pg_temp.ok(jsonb_array_length(portal_team(:'pam_pu')) = 2, 'admin sees her people');
select pg_temp.ok((portal_team_set(:'pam_pu', :'bob_pu', false, '{"invoices":1,"messages":0,"files":0,"estimates":9}')->>'ok')::boolean, 'set Bob''s access');
select portal_team_invite(:'pam_pu', 'dana@gulf.test', 'Dana') as dana_pu \gset
select pg_temp.fails($q$ select portal_team_invite('$q$ || :'pam_pu' || $q$', 'al@home.co', 'Al') $q$, 'client admin can''t invite a CRM login');
select pg_temp.fails($q$ select portal_team_remove('$q$ || :'pam_pu' || $q$', '$q$ || :'pam_pu' || $q$') $q$, 'can''t remove yourself');
select pg_temp.fails($q$ select portal_team_set('$q$ || :'pam_pu' || $q$', '$q$ || :'pam_pu' || $q$', false, null) $q$, 'can''t drop own admin');
select pg_temp.fails($q$ select portal_team_remove('$q$ || :'pam_pu' || $q$', '$q$ || :'carl_pu' || $q$') $q$, 'can''t touch another client''s people');
select pg_temp.ok((portal_invite_info(:'dana_pu')->>'from_name') = 'Pam Smith', 'client admin sends her own invites');
select pg_temp.ok(portal_invite_info(:'carl_pu') is null, 'but not other clients''');
select pg_temp.fails($q$ select portal_schedule('f2000000-0000-0000-0000-000000000001') $q$, 'an organization id isn''t a way in for clients');
select pg_temp.fails($q$ select portal_schedule('$q$ || :'carl_pu' || $q$') $q$, 'someone else''s portal id');
select pg_temp.ok((select count(*) from chat_threads) = 0 and (select count(*) from chat_messages) = 0, 'the Inbox tables stay closed to clients');
select pg_temp.ok(portal_admin_get('f2000000-0000-0000-0000-000000000001') is null and portal_vis_list('f2000000-0000-0000-0000-000000000001') is null, 'no CRM functions');
select pg_temp.fails($q$ select portal_vis_set('job', 'f3000000-0000-0000-0000-000000000002', 'shown') $q$, 'can''t unhide things');

-- the team sees the message in the Inbox and answers
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
select pg_temp.ok((select source_ref = 'portal' and company_id = 'f2000000-0000-0000-0000-000000000001' and unread_staff and visitor_email = 'pam@gulf.test' from chat_threads), 'in the Inbox');
reset role;   -- what the Inbox's chat_reply (012) writes
insert into chat_messages (tenant_id, thread_id, sender, staff_id, body) select tenant_id, id, 'staff', 'f1000000-0000-0000-0000-000000000001', 'Tuesday morning' from chat_threads;
insert into chat_messages (tenant_id, thread_id, sender, body) select tenant_id, id, 'system', 'internal: assigned to Al' from chat_threads;
set role authenticated;

-- Bob: invoices view only, no messages or files
select set_config('test.uid', 'f8000000-0000-0000-0000-000000000002', false);
select pg_temp.ok(jsonb_array_length(portal_docs(:'bob_pu', 'invoices')) = 1 and not (portal_docs(:'bob_pu', 'invoices')->0->>'can_pay')::boolean, 'Bob sees invoices, no pay');
select pg_temp.ok(portal_doc(:'bob_pu', 'invoice', 'f4000000-0000-0000-0000-000000000001')->>'link' is null, 'and no pay link');
select pg_temp.fails($q$ select portal_messages('$q$ || :'bob_pu' || $q$') $q$, 'Bob has no messages');
select pg_temp.fails($q$ select portal_send('$q$ || :'bob_pu' || $q$', 'hi') $q$, 'nor sending');
select pg_temp.fails($q$ select portal_files('$q$ || :'bob_pu' || $q$') $q$, 'nor files');
select pg_temp.ok(not private.portal_photo_ok('51000000-0000-0000-0000-000000000001/jobs/shared.jpg'), 'nor photos');
select pg_temp.fails($q$ select portal_team('$q$ || :'bob_pu' || $q$') $q$, 'not an admin');
select pg_temp.fails($q$ select portal_team_invite('$q$ || :'bob_pu' || $q$', 'x@gulf.test', 'x') $q$, 'can''t invite');
select pg_temp.fails($q$ select portal_doc('$q$ || :'pam_pu' || $q$', 'invoice', 'f4000000-0000-0000-0000-000000000001') $q$, 'can''t borrow Pam''s portal id');

-- Carl at Pine Plaza: only Pine Plaza
select set_config('test.uid', 'f8000000-0000-0000-0000-000000000003', false);
select pg_temp.ok((select array_agg(x->>'title') from jsonb_array_elements(portal_schedule(:'carl_pu')) x) = array['Pine mowing'], 'Carl: his own schedule');
select pg_temp.ok((select array_agg(x->>'id') from jsonb_array_elements(portal_docs(:'carl_pu', 'invoices')) x) = array['f4000000-0000-0000-0000-000000000004'], 'his own invoices');
select pg_temp.ok(jsonb_array_length(portal_messages(:'carl_pu')->'messages') = 0, 'not Gulf''s messages');
select pg_temp.ok(private.portal_photo_ok('51000000-0000-0000-0000-000000000001/jobs/pine.jpg') and not private.portal_photo_ok('51000000-0000-0000-0000-000000000001/jobs/shared.jpg'), 'his photo, not Gulf''s');
select pg_temp.fails($q$ select portal_doc('$q$ || :'carl_pu' || $q$', 'invoice', 'f4000000-0000-0000-0000-000000000001') $q$, 'not Gulf''s invoice');

-- Pam sees the team's reply
select set_config('test.uid', 'f8000000-0000-0000-0000-000000000001', false);
select pg_temp.ok((portal_messages(:'pam_pu')->'messages'->1->>'from') = 'team' and (portal_messages(:'pam_pu')->'messages'->1->>'name') = 'Admin', 'team reply shows');
select pg_temp.ok(jsonb_array_length(portal_messages(:'pam_pu')->'messages') = 2, 'system lines stay out');

-- another account's admin gets nowhere
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000009', false);
select pg_temp.ok(portal_admin_get('f2000000-0000-0000-0000-000000000001') is null and portal_vis_list('f2000000-0000-0000-0000-000000000001') is null, 'other account: no card');
select pg_temp.fails($q$ select portal_schedule('f2000000-0000-0000-0000-000000000001') $q$, 'other account: no preview');
select pg_temp.fails($q$ select portal_schedule('$q$ || :'pam_pu' || $q$') $q$, 'other account: not with a portal id either');
select pg_temp.fails($q$ select portal_vis_set('job', 'f3000000-0000-0000-0000-000000000001', 'hidden') $q$, 'other account: can''t hide');
select pg_temp.fails($q$ select portal_admin_remove('$q$ || :'pam_pu' || $q$') $q$, 'other account: can''t remove');
select pg_temp.ok(portal_invite_info(:'pam_pu') is null, 'other account: can''t send');

-- the team: preview, hiding, sharing, settings, approvals
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
select pg_temp.ok(jsonb_array_length(portal_schedule('f2000000-0000-0000-0000-000000000001')) = 1 and (portal_home('f2000000-0000-0000-0000-000000000001')->>'preview')::boolean, 'preview reads like the client');
select pg_temp.ok(portal_doc('f2000000-0000-0000-0000-000000000001', 'invoice', 'f4000000-0000-0000-0000-000000000001')->>'link' is null, 'preview gets no pay link');
select pg_temp.fails($q$ select portal_send('f2000000-0000-0000-0000-000000000001', 'hi') $q$, 'preview can''t send');
select pg_temp.ok(jsonb_array_length(portal_vis_list('f2000000-0000-0000-0000-000000000001')->'jobs') = 2, 'choose what they see lists the jobs');
select portal_vis_set('job', 'f3000000-0000-0000-0000-000000000001', 'hidden');
select portal_vis_set('photo', 'f7000000-0000-0000-0000-000000000002', 'shared');
select portal_vis_set('file', 'f6000000-0000-0000-0000-000000000002', 'internal');
select set_config('test.uid', 'f8000000-0000-0000-0000-000000000001', false);
select pg_temp.ok(jsonb_array_length(portal_schedule(:'pam_pu')) = 0 and jsonb_array_length(portal_files(:'pam_pu')->'photos') = 0, 'hidden job takes its photos with it');
select pg_temp.ok(jsonb_array_length(portal_files(:'pam_pu')->'files') = 0, 'file marked internal');
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
select portal_vis_set('job', 'f3000000-0000-0000-0000-000000000001', 'shown', 'Please unlock the side gate');
select portal_settings_save('{"files_default":"shared","sections":{"estimates":false}}');
select set_config('test.uid', 'f8000000-0000-0000-0000-000000000001', false);
select pg_temp.ok(jsonb_array_length(portal_files(:'pam_pu')->'photos') = 2 and (portal_schedule(:'pam_pu')->0->>'note') = 'Please unlock the side gate', 'shown again with a note');
select pg_temp.ok((select array_agg(x->>'title' order by x->>'title') from jsonb_array_elements(portal_files(:'pam_pu')->'files') x) = array['Internal pricing sheet'], 'default flipped to shared, internal stays internal');
select pg_temp.fails($q$ select portal_docs('$q$ || :'pam_pu' || $q$', 'estimates') $q$, 'section turned off');
select pg_temp.ok((portal_home(:'pam_pu')->'levels'->>'estimates')::int = 0 and portal_home(:'pam_pu')->'counts'->>'estimates' is null, 'and gone from home');
reset role;
select private.portal_approval_add('51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000002', 'change_order', null, 'Add two dumpsters', 'Two more 20 yard', 450, null, null, 'f1000000-0000-0000-0000-000000000001') as ap1 \gset
select private.portal_approval_add('51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000002', 'change_order', null, 'Signed one', null, 100, '/sign/?t=abc', null, null) as ap2 \gset
select pg_temp.ok(private.portal_approval_add('51000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000009', 'change_order', null, 'x', null, 1, null, null, null) is null, 'approvals stay in their account');
set role authenticated;
select set_config('test.uid', 'f8000000-0000-0000-0000-000000000003', false);
select pg_temp.ok(jsonb_array_length(portal_approvals_list(:'carl_pu')) = 0, 'Carl doesn''t see Gulf''s approvals');
select pg_temp.fails($q$ select portal_approval_decide('$q$ || :'carl_pu' || $q$', '$q$ || :'ap1' || $q$', true) $q$, 'nor answer them');
select set_config('test.uid', 'f8000000-0000-0000-0000-000000000001', false);
select pg_temp.ok(jsonb_array_length(portal_approvals_list(:'pam_pu')) = 2 and (portal_home(:'pam_pu')->'counts'->>'approvals')::int = 2, 'Pam needs to approve two');
select pg_temp.fails($q$ select portal_approval_decide('$q$ || :'pam_pu' || $q$', '$q$ || :'ap2' || $q$', true) $q$, 'one with a signing page is signed there');
select pg_temp.ok((portal_approval_decide(:'pam_pu', :'ap1', true, 'Go ahead')->>'ok')::boolean, 'approved');
select pg_temp.fails($q$ select portal_approval_decide('$q$ || :'pam_pu' || $q$', '$q$ || :'ap1' || $q$', false) $q$, 'only once');
reset role;
select pg_temp.ok((select status = 'approved' and decided_name = 'Pam Smith' from portal_approvals where id = :'ap1')
  and exists (select 1 from notifications where user_id = 'f1000000-0000-0000-0000-000000000001' and kind = 'portal'), 'recorded and the team told');
select pg_temp.ok((select perms @> '{"invoices":1,"messages":0,"files":0,"estimates":2,"schedule":1}' from private.portal_users where id = :'bob_pu'), 'levels cleaned and capped');

-- removing access: the CRM removes Bob, Pam removes Dana
set role authenticated;
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
select portal_admin_remove(:'bob_pu');
select set_config('test.uid', 'f8000000-0000-0000-0000-000000000001', false);
select portal_team_remove(:'pam_pu', :'dana_pu');
select set_config('test.uid', 'f8000000-0000-0000-0000-000000000002', false);
select pg_temp.ok(jsonb_array_length(portal_me()->'portals') = 0, 'Bob has no portals now');
select pg_temp.fails($q$ select portal_home('$q$ || :'bob_pu' || $q$') $q$, 'removed: no home');
select pg_temp.fails($q$ select portal_docs('$q$ || :'bob_pu' || $q$', 'invoices') $q$, 'removed: no invoices');
select pg_temp.ok(not private.portal_photo_ok('51000000-0000-0000-0000-000000000001/jobs/shared.jpg'), 'removed: no photos');
-- invited again later, his old login comes straight back
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
select portal_admin_invite('f2000000-0000-0000-0000-000000000001', 'bob@gulf.test', 'Bob') as bob2 \gset
select set_config('test.uid', 'f8000000-0000-0000-0000-000000000002', false);
select pg_temp.ok(jsonb_array_length(portal_me()->'portals') = 1 and jsonb_array_length(portal_schedule(:'bob2')) = 1, 'invited again, back in with the same login');
-- one login, two organizations: Carl added to Gulf too
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
select portal_admin_invite('f2000000-0000-0000-0000-000000000001', 'carl@pine.test', 'Carl') as carl2 \gset
select set_config('test.uid', 'f8000000-0000-0000-0000-000000000003', false);
select pg_temp.ok(jsonb_array_length(portal_me()->'portals') = 2, 'Carl can switch between two');

-- the account turns the portal off: nobody gets in
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
select account_settings_save('{"features":{"portal":false}}'::jsonb);
select set_config('test.uid', 'f8000000-0000-0000-0000-000000000001', false);
select pg_temp.ok(jsonb_array_length(portal_me()->'portals') = 0, 'off: no portals listed');
select pg_temp.fails($q$ select portal_home('$q$ || :'pam_pu' || $q$') $q$, 'off: no home');
select pg_temp.ok(not private.portal_photo_ok('51000000-0000-0000-0000-000000000001/jobs/shared.jpg'), 'off: no photos');
select pg_temp.ok(portal_brand('homeco') is null, 'off: no brand on the sign in page');
-- a CRM login opening the portal page is told so
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
select pg_temp.ok((portal_me()->>'crm')::boolean, 'CRM login is not a portal login');
reset role;
select 'portal tests passed';
