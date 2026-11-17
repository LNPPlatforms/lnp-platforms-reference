-- 106: connected calendars. Run with tests/run_db.sh tests/cal_feeds_test.sql
\set ON_ERROR_STOP 1
insert into tenants (id, name, slug) values ('a3000000-0000-0000-0000-000000000001', 'Acme', 'acme3');
insert into app_users (id, full_name, email, tenant_id) values ('b3000000-0000-0000-0000-000000000001', 'Ann', 'ann3@x.com', 'a3000000-0000-0000-0000-000000000001'),
  ('b3000000-0000-0000-0000-000000000002', 'Bo', 'bo3@x.com', 'a3000000-0000-0000-0000-000000000001');
select set_config('test.uid', 'b3000000-0000-0000-0000-000000000001', false);
select public.my_cal_feed_add('Work', 'webcal://calendar.google.com/calendar/ical/abc%40group/private-123/basic.ics') as f1 \gset
select url like 'https://calendar.google.com/%' and url_hint = 'calendar.google.com/…' || right('https://calendar.google.com/calendar/ical/abc%40group/private-123/basic.ics', 12) as webcal_becomes_https from cal_feeds;
do $$ begin perform public.my_cal_feed_add('x', 'http://10.0.0.1/a.ics'); raise exception 'took bad url'; exception when others then if sqlerrm = 'took bad url' then raise; end if; end $$;
do $$ begin perform public.my_cal_feed_add('dup', 'https://calendar.google.com/calendar/ical/abc%40group/private-123/basic.ics'); raise exception 'took dup'; exception when others then if sqlerrm = 'took dup' then raise; end if; end $$;
insert into cal_busy (user_id, starts_at, ends_at, source, feed_id, external_id) values ('b3000000-0000-0000-0000-000000000001', now(), now() + interval '1 hour', 'ical', :'f1', 'x');
-- Bo can't remove or rename Ann's feed
select set_config('test.uid', 'b3000000-0000-0000-0000-000000000002', false);
select public.my_cal_feed_remove(:'f1'); select public.my_cal_feed_rename(:'f1', 'Mine now');
select count(*) = 1 and min(label) = 'Work' as others_cant_touch from cal_feeds;
-- Ann removes it: its busy times go too
select set_config('test.uid', 'b3000000-0000-0000-0000-000000000001', false);
select public.my_cal_feed_remove(:'f1');
select not exists (select 1 from cal_feeds) and not exists (select 1 from cal_busy where external_id = 'x') as removed_with_busy;
-- the app can't read the address column
select not has_column_privilege('authenticated', 'public.cal_feeds', 'url', 'select') and has_column_privilege('authenticated', 'public.cal_feeds', 'url_hint', 'select') as url_hidden;
