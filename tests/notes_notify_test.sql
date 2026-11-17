-- 100: notify people on a note. Run with tests/run_db.sh tests/notes_notify_test.sql
\set ON_ERROR_STOP 1
insert into tenants (id, name, slug) values ('a1000000-0000-0000-0000-000000000001', 'Acme', 'acme1'), ('a1000000-0000-0000-0000-000000000002', 'Other', 'other1');
insert into app_users (id, full_name, email, tenant_id, is_admin) values
  ('b1000000-0000-0000-0000-000000000001', 'Ann Admin', 'ann@x.com', 'a1000000-0000-0000-0000-000000000001', true),
  ('b1000000-0000-0000-0000-000000000002', 'Ray Rep', 'ray@x.com', 'a1000000-0000-0000-0000-000000000001', true),
  ('b1000000-0000-0000-0000-000000000003', 'Oz Other', 'oz@x.com', 'a1000000-0000-0000-0000-000000000002', true);
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000001', false);
insert into companies (id, tenant_id, name) values ('e1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'Acme Company');
-- Ann notifies Ray, herself and Oz (other account): only Ray gets it
select public.timeline_note(null, 'e1000000-0000-0000-0000-000000000001', 'Call them back @Ray Rep',
  array['b1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000003']::uuid[]) is not null as note_saved;
select count(*) = 1 as one_notification from notifications where kind = 'note';
select user_id = 'b1000000-0000-0000-0000-000000000002' and deliver and link = '#org/e1000000-0000-0000-0000-000000000001'
  and title = 'Ann Admin notified you on Acme Company' as ray_notified from notifications where kind = 'note';
select (data->'notified') = '["b1000000-0000-0000-0000-000000000002"]'::jsonb as timeline_shows_who from contact_events where kind = 'note';
-- no list: plain note, nothing sent
select public.timeline_note(null, 'e1000000-0000-0000-0000-000000000001', 'Plain note') is not null as plain_saved;
select count(*) = 1 as still_one from notifications where kind = 'note';
-- notify method
select set_config('test.uid', 'b1000000-0000-0000-0000-000000000002', false);
select public.my_notify_via_set('both');
select notify_via = 'both' as via_saved from app_users where id = 'b1000000-0000-0000-0000-000000000002';
do $$ begin perform public.my_notify_via_set('carrier pigeon'); raise exception 'bad via'; exception when others then
  if sqlerrm = 'bad via' then raise; end if; end $$;
-- 101: notes touch the organization's last activity
select last_activity_at > now() - interval '1 minute' as activity_touched from companies where id = 'e1000000-0000-0000-0000-000000000001';
-- 102: a brand-new account gets the starter lists, and "Clinic" from old paths becomes its first type
select private.seed_lookups('a1000000-0000-0000-0000-000000000002');
select string_agg(label, ',' order by sort_order) = 'Client,Prospect,Vendor,Partner,Individual' as neutral_types
  from lookup_values where tenant_id = 'a1000000-0000-0000-0000-000000000002' and list_name = 'org_type';
select not exists (select 1 from lookup_values where tenant_id = 'a1000000-0000-0000-0000-000000000002' and label ilike '%physician%') as no_healthcare_roles;
insert into companies (id, tenant_id, name, org_types) values ('e1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000002', 'Acme Two', '{Clinic}');
select org_types = '{Client}' as clinic_became_client from companies where id = 'e1000000-0000-0000-0000-000000000002';
