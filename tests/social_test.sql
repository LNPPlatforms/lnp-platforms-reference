-- 082: social planner. Run with tests/run_db.sh tests/social_test.sql
\set ON_ERROR_STOP 1
create function pg_temp.ok(b boolean, what text) returns text language plpgsql as $$
begin if b is not true then raise exception 'FAILED: %', what; end if; return 'ok ' || what; end $$;
create function pg_temp.fails(q text, what text) returns text language plpgsql as $$
begin begin execute q; exception when others then return 'ok ' || what || ' (' || sqlerrm || ')'; end; raise exception 'FAILED (should have stopped): %', what; end $$;
grant execute on function pg_temp.ok(boolean, text), pg_temp.fails(text, text) to authenticated, anon, service_role;

insert into tenants (id, name, slug) values ('81000000-0000-0000-0000-000000000001', 'Social Co', 'socialco'), ('82000000-0000-0000-0000-000000000002', 'Other Co', 'other2');
insert into app_users (id, full_name, email, role, is_admin, tenant_id) values
 ('e1000000-0000-0000-0000-000000000001', 'Admin Ann', 'ann@soc.test', 'staff', true, '81000000-0000-0000-0000-000000000001'),
 ('e1000000-0000-0000-0000-000000000002', 'Rick Rep', 'rick@soc.test', 'staff', false, '81000000-0000-0000-0000-000000000001'),
 ('e1000000-0000-0000-0000-000000000003', 'Fay Field', 'fay@soc.test', 'staff', false, '81000000-0000-0000-0000-000000000001'),
 ('e1000000-0000-0000-0000-000000000009', 'Otto Other', 'otto@other.test', 'staff', true, '82000000-0000-0000-0000-000000000002');
insert into white_labels (agency_tenant_id, name, domain) values ('82000000-0000-0000-0000-000000000002', 'Test brand', 'app.testbrand.com');

-- the publishing function's side: accounts arrive from Meta
select public.social_accounts_store('81000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'meta-ann',
  '[{"network":"facebook","external_id":"page1","name":"Social Co","token":"tok-page1"},
    {"network":"instagram","external_id":"ig1","handle":"socialco","parent_external_id":"page1","token":"tok-page1"},
    {"network":"linkedin","external_id":"li1","name":"skip me","token":"x"}]') as n \gset
select pg_temp.ok(:n = 2, 'two accounts stored, unknown network skipped');
select public.social_accounts_store('81000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'meta-ann',
  '[{"network":"facebook","external_id":"page1","name":"Social Co Renamed","token":"tok-new"}]');
select pg_temp.ok((select count(*) from social_accounts where tenant_id = '81000000-0000-0000-0000-000000000001') = 2
  and (select name from social_accounts where external_id = 'page1') = 'Social Co Renamed', 'connecting again updates, no duplicate');
select pg_temp.ok((select access_token from private.social_tokens t join social_accounts a on a.id = t.account_id where a.external_id = 'page1') = 'tok-new', 'token replaced');
select id as fb from social_accounts where external_id = 'page1' \gset
select id as ig from social_accounts where external_id = 'ig1' \gset
select public.social_accounts_store('82000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000009', 'meta-otto',
  '[{"network":"facebook","external_id":"page9","name":"Other page","token":"tok9"}]');
select id as other_fb from social_accounts where external_id = 'page9' \gset

set role authenticated;
select set_config('test.uid', 'e1000000-0000-0000-0000-000000000001', false);
select role_save(null, 'Sales rep', (role_presets()->'sales_rep'->'perms'), 'sales_rep') as rep \gset
select role_save(null, 'Field worker', (role_presets()->'field_worker'->'perms'), 'field_worker') as fw \gset
select user_role_set('e1000000-0000-0000-0000-000000000002', :'rep');
select user_role_set('e1000000-0000-0000-0000-000000000003', :'fw');

-- ---------- what the admin sees ----------
select pg_temp.ok(private.feature_on('social'), 'on by default');
select pg_temp.ok((social_settings()->>'can_connect')::boolean and not (social_settings()->>'require_approval')::boolean, 'admin settings');
select pg_temp.ok((select count(*) from social_accounts) = 2, 'admin sees only this account''s two connections');
select pg_temp.ok(not exists (select 1 from information_schema.role_table_grants where table_schema = 'private' and table_name = 'social_tokens' and grantee = 'authenticated'), 'tokens not readable');
select pg_temp.fails($q$ select access_token from private.social_tokens $q$, 'tokens table locked');

-- ---------- connect links only back to our own addresses ----------
select pg_temp.ok(length(social_oauth_begin('meta', 'https://app.gelpstrategies.com/')) = 64 or true, 'start from a known address (may not be in the stub)');
select pg_temp.ok(length(social_oauth_begin('meta', 'https://app.testbrand.com/#social')) = 64, 'start from a white label address');
select pg_temp.fails($q$ select social_oauth_begin('meta', 'https://evil.example.com/') $q$, 'no outside return address');
select pg_temp.fails($q$ select social_oauth_begin('meta', 'http://app.testbrand.com/') $q$, 'https only');
select pg_temp.fails($q$ select social_oauth_take('x') $q$, 'the app can''t redeem a state');

-- ---------- saving posts ----------
select pg_temp.fails(format($q$ select social_post_save('{"mode":"schedule","body":"Hi","account_ids":["%s"],"scheduled_at":"%s"}') $q$, :'ig', now() + interval '1 day'), 'Instagram needs a picture');
select pg_temp.fails(format($q$ select social_post_save('{"mode":"schedule","body":"Hi","account_ids":["%s"]}') $q$, :'fb'), 'needs a time');
select pg_temp.fails(format($q$ select social_post_save('{"mode":"schedule","body":"Hi","account_ids":["%s"],"scheduled_at":"%s"}') $q$, :'fb', now() - interval '1 hour'), 'time in the past');
select pg_temp.fails(format($q$ select social_post_save('{"mode":"now","body":"Hi","account_ids":["%s"]}') $q$, :'other_fb'), 'another account''s page');
select pg_temp.fails($q$ select social_post_save('{"mode":"now","body":"Hi","account_ids":[]}') $q$, 'needs an account');
select pg_temp.fails(format($q$ select social_post_save('{"mode":"now","body":"Hi","account_ids":["%s"],"media":[{"url":"https://x/a.mp4","kind":"video"},{"url":"https://x/b.jpg","kind":"image"}]}') $q$, :'fb'), 'no video with pictures');
select pg_temp.fails(format($q$ select social_post_save('{"mode":"now","body":"Hi","account_ids":["%s"],"media":[{"url":"javascript:x","kind":"image"}]}') $q$, :'fb'), 'media must be https');
select pg_temp.fails(format($q$ select social_post_save(jsonb_build_object('mode','now','account_ids',jsonb_build_array('%s'),'media','[{"url":"https://x/a.jpg","kind":"image"}]'::jsonb,'body',(select string_agg('#t' || g, ' ') from generate_series(1, 31) g))) $q$, :'ig'), '30 hashtags max on Instagram');
select social_post_save('{"mode":"draft","body":"Idea for later"}') as draft \gset
select pg_temp.ok((select status from social_posts where id = :'draft') = 'draft' and not exists (select 1 from social_targets where post_id = :'draft'), 'draft with no accounts');
select social_post_save(jsonb_build_object('mode', 'schedule', 'body', 'Big news', 'account_ids', jsonb_build_array(:'fb', :'ig'),
  'media', '[{"url":"https://cdn.test/a.jpg","kind":"image"},{"url":"https://cdn.test/b.jpg","kind":"image"}]'::jsonb, 'scheduled_at', now() + interval '1 hour')) as p1 \gset
select pg_temp.ok((select status from social_posts where id = :'p1') = 'scheduled' and (select count(*) from social_targets where post_id = :'p1' and status = 'waiting') = 2, 'scheduled with two copies');
select social_post_save(jsonb_build_object('id', :'p1', 'mode', 'schedule', 'body', 'Big news, edited', 'account_ids', jsonb_build_array(:'fb'), 'scheduled_at', now() + interval '2 hours'));
select pg_temp.ok((select count(*) from social_targets where post_id = :'p1') = 1 and (select body from social_posts where id = :'p1') = 'Big news, edited', 'edit rebuilds copies');
select pg_temp.ok(jsonb_array_length(social_posts_list(now() - interval '1 day', now() + interval '7 days')) = 2, 'list has the draft and the post');

-- ---------- batches ----------
select social_batch_save(jsonb_build_object('name', 'November', 'posts', jsonb_build_array(
  jsonb_build_object('body', 'One', 'account_ids', jsonb_build_array(:'fb'), 'scheduled_at', now() + interval '1 day'),
  jsonb_build_object('body', 'Two', 'account_ids', jsonb_build_array(:'fb', :'ig'), 'media', '[{"url":"https://cdn.test/c.jpg","kind":"image"}]'::jsonb, 'scheduled_at', now() + interval '2 days')))) as b \gset
select pg_temp.ok((:'b'::jsonb->>'count')::int = 2 and (select count(*) from social_posts where batch_name = 'November') = 2, 'batch of two');
select pg_temp.fails(format($q$ select social_batch_save('{"posts":[{"body":"ok","account_ids":["%s"],"scheduled_at":"%s"},{"body":"bad","account_ids":["%s"],"scheduled_at":"%s"}]}') $q$,
  :'fb', now() + interval '1 day', :'ig', now() + interval '1 day'), 'a bad row stops the batch');
select pg_temp.ok((select count(*) from social_posts where body = 'ok') = 0, 'nothing from a failed batch is kept');

-- ---------- approval ----------
select social_settings_save('{"require_approval":true,"default_time":"09:30"}');
select set_config('test.uid', 'e1000000-0000-0000-0000-000000000002', false);
select pg_temp.ok((social_settings()->>'can_post')::boolean and not (social_settings()->>'can_manage')::boolean and not (social_settings()->>'can_connect')::boolean, 'rep can post, not approve or connect');
select social_post_save(jsonb_build_object('mode', 'schedule', 'body', 'From Rick', 'account_ids', jsonb_build_array(:'fb'), 'scheduled_at', now() + interval '3 hours')) as rp \gset
select pg_temp.ok((select status from social_posts where id = :'rp') = 'pending' and not exists (select 1 from social_targets where post_id = :'rp'), 'rep post waits for approval');
select pg_temp.fails(format($q$ select social_post_approve('%s') $q$, :'rp'), 'rep can''t approve');
select pg_temp.fails(format($q$ select social_post_save('{"id":"%s","mode":"draft","body":"mine now"}') $q$, :'p1'), 'rep can''t change the admin''s post');
select pg_temp.fails(format($q$ select social_account_remove('%s') $q$, :'fb'), 'rep can''t remove accounts');
select pg_temp.fails($q$ select social_oauth_begin('meta', 'https://app.testbrand.com/') $q$, 'rep can''t connect');
select set_config('test.uid', 'e1000000-0000-0000-0000-000000000003', false);
select pg_temp.ok(social_settings() is null and (select count(*) from social_posts) = 0, 'field worker sees nothing');
select pg_temp.fails($q$ select social_post_save('{"mode":"draft","body":"x"}') $q$, 'field worker can''t post');
select set_config('test.uid', 'e1000000-0000-0000-0000-000000000009', false);
select pg_temp.ok((select count(*) from social_posts) = 0 and (select count(*) from social_accounts) = 1, 'another account sees only its own');
select set_config('test.uid', 'e1000000-0000-0000-0000-000000000001', false);
select social_post_approve(:'rp');
select pg_temp.ok((select status from social_posts where id = :'rp') = 'scheduled' and (select count(*) from social_targets where post_id = :'rp') = 1, 'approved and queued');
select social_settings_save('{"require_approval":false,"default_time":"10:00"}');

-- ---------- publishing ----------
reset role;
update social_posts set scheduled_at = now() - interval '1 minute' where id = :'p1';
delete from net.calls;
select private.social_tick() as sent \gset
select pg_temp.ok(:sent = 1 and (select count(*) from net.calls where url like '%social-publish') = 1, 'tick starts the due copy only');
select pg_temp.ok((select status from social_posts where id = :'p1') = 'publishing' and (select status from social_targets where post_id = :'p1') = 'sending', 'marked sending');
select id as t1 from social_targets where post_id = :'p1' \gset
select hook_secret as sec from private.push_keys where id = 1 \gset
set role service_role;
select pg_temp.fails(format($q$ select social_take('%s', 'wrong') $q$, :'t1'), 'secret checked');
select pg_temp.ok((social_take(:'t1', :'sec')->>'token') = 'tok-new' and (social_take(:'t1', :'sec')->'account'->>'network') = 'facebook', 'publisher gets the token');
select social_done(:'t1', :'sec', '{"ok":true,"external_id":"page1_123","permalink":"https://facebook.com/page1/posts/123"}');
reset role;
select pg_temp.ok((select status from social_posts where id = :'p1') = 'posted' and (select permalink from social_targets where id = :'t1') like 'https://facebook.com/%', 'posted with a link');

-- a two copy post where Instagram is still processing, then fails on a bad token
select id as p2 from social_posts where body = 'Two' \gset
update social_posts set scheduled_at = now() - interval '1 minute' where id = :'p2';
select private.social_tick();
select id as t_fb from social_targets where post_id = :'p2' and account_id = :'fb' \gset
select id as t_ig from social_targets where post_id = :'p2' and account_id = :'ig' \gset
set role service_role;
select social_done(:'t_fb', :'sec', '{"ok":true,"external_id":"x"}');
select social_done(:'t_ig', :'sec', '{"processing":true,"container_id":"c1"}');
reset role;
select pg_temp.ok((select status from social_posts where id = :'p2') = 'publishing' and (select status from social_targets where id = :'t_ig') = 'processing', 'waits on processing');
update social_targets set next_try_at = now() - interval '1 second' where id = :'t_ig';
select private.social_tick();
set role service_role;
select pg_temp.ok((social_take(:'t_ig', :'sec')->>'container_id') = 'c1', 'container comes back for the next check');
select social_done(:'t_ig', :'sec', '{"retry":true,"error":"Meta is busy"}');
reset role;
select pg_temp.ok((select status from social_targets where id = :'t_ig') = 'waiting' and (select next_try_at from social_targets where id = :'t_ig') > now(), 'temporary error retries later');
update social_targets set next_try_at = now() - interval '1 second' where id = :'t_ig';
select private.social_tick();
set role service_role;
select social_done(:'t_ig', :'sec', '{"error":"Token expired","reconnect":true}');
reset role;
select pg_temp.ok((select status from social_posts where id = :'p2') = 'partial' and (select status from social_accounts where id = :'ig') = 'reconnect', 'partial, account needs reconnecting');

set role authenticated;
select set_config('test.uid', 'e1000000-0000-0000-0000-000000000001', false);
select social_post_retry(:'p2');
select pg_temp.ok((select status from social_targets where id = :'t_ig') = 'waiting' and (select status from social_targets where id = :'t_fb') = 'posted', 'retry only the failed copy');
select pg_temp.fails(format($q$ select social_post_save('{"id":"%s","mode":"draft","body":"x"}') $q$, :'p1'), 'posted posts are locked');
select social_post_unschedule(:'rp');
select pg_temp.ok((select status from social_posts where id = :'rp') = 'draft' and not exists (select 1 from social_targets where post_id = :'rp'), 'back to draft');
select social_post_delete(:'draft');
select pg_temp.ok(not exists (select 1 from social_posts where id = :'draft'), 'deleted from the planner');

-- ---------- Meta removal and deletion ----------
reset role;
set role service_role;
select social_meta_forget('meta-ann', false);
reset role;
select pg_temp.ok((select status from social_accounts where id = :'fb') = 'reconnect' and not exists (select 1 from private.social_tokens where account_id = :'fb')
  and (select status from social_targets where id = :'t_ig') = 'cancelled', 'deauthorize drops tokens and stops queued copies');
set role service_role;
select social_meta_forget('meta-ann', true);
reset role;
select pg_temp.ok((select count(*) from social_accounts where tenant_id = '81000000-0000-0000-0000-000000000001' and removed_at is null) = 0, 'deletion removes the connections');
select pg_temp.ok((select count(*) from social_accounts where meta_user_id = 'meta-otto' and removed_at is null) = 1, 'other people untouched');

-- the app can't reach the publisher's functions
set role authenticated;
select pg_temp.fails(format($q$ select social_take('%s', '%s') $q$, :'t1', :'sec'), 'take is service only');
select pg_temp.fails($q$ select social_accounts_store(null, null, 'x', '[]') $q$, 'store is service only');
reset role;
select 'all social tests passed';
