-- 117: lines, an incoming call ringing a group (first to answer wins), voicemail, filing unknown calls, outbound, usage alerts
\set ON_ERROR_STOP 1
create function pg_temp.ok(b boolean, what text) returns text language plpgsql as $$
begin if b is not true then raise exception 'FAILED: %', what; end if; return 'ok ' || what; end $$;
insert into tenants (id, name, slug) values ('77000000-0000-0000-0000-000000000001', 'Ring Co', 'ringco');
insert into app_users (id, full_name, email, role, is_admin, tenant_id) values
  ('f7000000-0000-0000-0000-000000000001', 'Ann Admin', 'ann@r.test', 'staff', true, '77000000-0000-0000-0000-000000000001'),
  ('f7000000-0000-0000-0000-000000000002', 'Bob Desk', 'bob@r.test', 'staff', false, '77000000-0000-0000-0000-000000000001');
insert into account_settings (tenant_id, settings) values ('77000000-0000-0000-0000-000000000001', '{"features":{"phone":true}}')
  on conflict (tenant_id) do update set settings = excluded.settings;
insert into people (id, first_name, last_name, personal_cell, tenant_id) values ('f7100000-0000-0000-0000-000000000001', 'Carla', 'Caller', '(228) 555-0101', '77000000-0000-0000-0000-000000000001');
insert into companies (id, name, main_phone, tenant_id) values ('f7200000-0000-0000-0000-000000000001', 'Acme Company', '228-555-0199', '77000000-0000-0000-0000-000000000001');

select pg_temp.ok(not private.feature_on_for('73000000-0000-0000-0000-000000000099', 'phone'), 'phone is off by default');
select phone_line_add('77000000-0000-0000-0000-000000000001', 'f7000000-0000-0000-0000-000000000001', '+12285550100', 'Main line', 'ord1') as line \gset
select phone_cred_set('f7000000-0000-0000-0000-000000000001', 'cred-a', 'sipann');
select phone_cred_set('f7000000-0000-0000-0000-000000000002', 'cred-b', 'sipbob');

-- an admin puts Bob on the line too
select set_config('test.uid', 'f7000000-0000-0000-0000-000000000001', false);
select phone_line_save(:'line', '{"name":"Main line","kind":"group","members":["f7000000-0000-0000-0000-000000000001","f7000000-0000-0000-0000-000000000002"],"ring_secs":20}');
do $$ begin
  begin perform phone_line_save((select id from phone_lines limit 1), '{"kind":"direct","members":["f7000000-0000-0000-0000-000000000001","f7000000-0000-0000-0000-000000000002"]}');
    raise exception 'FAILED: a direct line took two people'; exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
end $$;
select set_config('test.uid', 'f7000000-0000-0000-0000-000000000002', false);
do $$ begin
  begin perform phone_line_save((select id from phone_lines limit 1), '{"name":"Mine"}'); raise exception 'FAILED: non-admin changed a line';
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
end $$;
select set_config('test.uid', '', false);

-- 1. Carla calls the main line; both ring; Bob answers first, Ann's leg loses
do $$ declare s jsonb; a jsonb; b jsonb; e jsonb; begin
  s := phone_in_start('in-1', '+12285550101', '+12285550100');
  perform pg_temp.ok(jsonb_array_length(s->'members') = 2, 'both people ring');
  perform pg_temp.ok((select person_id from phone_calls where ccid = 'in-1') = 'f7100000-0000-0000-0000-000000000001', 'matched Carla by her cell');
  perform phone_leg_add((s->>'call_id')::uuid, 'leg-a', 'f7000000-0000-0000-0000-000000000001');
  perform phone_leg_add((s->>'call_id')::uuid, 'leg-b', 'f7000000-0000-0000-0000-000000000002');
  b := phone_leg_answered('leg-b');
  perform pg_temp.ok(b->>'inbound' = 'in-1' and b->'others' = '["leg-a"]'::jsonb, 'Bob wins, Ann''s leg to hang up');
  a := phone_leg_answered('leg-a');
  perform pg_temp.ok((a->>'lost')::boolean, 'a second answer loses');
  e := phone_leg_ended('leg-a');
  perform pg_temp.ok(not (e->>'nobody')::boolean, 'no voicemail once someone answered');
  update phone_calls set answered_at = now() - interval '125 seconds' where ccid = 'in-1';
  perform phone_call_ended('in-1', 'normal_clearing');
  perform pg_temp.ok((select status = 'done' and seconds between 124 and 127 and user_id = 'f7000000-0000-0000-0000-000000000002' from phone_calls where ccid = 'in-1'), 'call done, 2 minutes, Bob');
  perform pg_temp.ok((select count(*) = 1 from contact_events where kind = 'call' and person_id = 'f7100000-0000-0000-0000-000000000001'), 'logged on Carla''s timeline');
  perform pg_temp.ok(phone_call_ended('in-1', null) is null, 'ending twice does nothing');
end $$;

-- 2. an unknown number calls, nobody answers: voicemail, then filed to Acme
do $$ declare s jsonb; e jsonb; v jsonb; c uuid; begin
  s := phone_in_start('in-2', '+16015550123', '+12285550100'); c := (s->>'call_id')::uuid;
  perform phone_leg_add(c, 'leg-c', 'f7000000-0000-0000-0000-000000000001');
  perform phone_leg_add(c, 'leg-d', 'f7000000-0000-0000-0000-000000000002');
  e := phone_leg_ended('leg-c'); perform pg_temp.ok(not (e->>'nobody')::boolean, 'one still ringing');
  e := phone_leg_ended('leg-d'); perform pg_temp.ok((e->>'nobody')::boolean, 'nobody answered: voicemail');
  v := phone_to_voicemail(c); perform pg_temp.ok((v->>'voicemail')::boolean and v->>'greeting' like 'Thanks for calling Ring Co%', 'default greeting');
  perform phone_call_ended('in-2', 'normal_clearing');
  perform phone_recording_saved(c, '77000000-0000-0000-0000-000000000001/x-vm.mp3', true);
  perform pg_temp.ok((select status = 'voicemail' and voicemail_path is not null and person_id is null and company_id is null from phone_calls where id = c), 'voicemail kept, unfiled');
  perform pg_temp.ok((select count(*) = 2 from notifications where kind = 'phone' and title like 'New voicemail%'), 'both members told about the voicemail');
  perform set_config('test.uid', 'f7000000-0000-0000-0000-000000000001', false);
  perform phone_call_file(c, null, 'f7200000-0000-0000-0000-000000000001');
  perform pg_temp.ok((select count(*) = 1 from contact_events where kind = 'call' and company_id = 'f7200000-0000-0000-0000-000000000001' and title like 'Voicemail from%'), 'filed to Acme''s timeline');
  perform phone_call_file(c, 'f7100000-0000-0000-0000-000000000001', null);
  perform pg_temp.ok((select count(*) = 1 from contact_events where kind = 'call' and data->>'call_id' = c::text and person_id = 'f7100000-0000-0000-0000-000000000001' and company_id is null), 'moved to Carla, same entry');
  perform phone_call_note(c, 'Wants a quote Friday');
  perform pg_temp.ok((select notes = 'Wants a quote Friday' from phone_calls where id = c), 'note saved');
  perform set_config('test.uid', '', false);
end $$;

-- 3. Bob calls Acme's main number from the browser; the browser reports 61 seconds
select set_config('test.uid', 'f7000000-0000-0000-0000-000000000002', false);
do $$ declare o jsonb; c uuid; begin
  o := phone_out_start((select id from phone_lines limit 1), '228-555-0199'); c := (o->>'call_id')::uuid;
  perform pg_temp.ok(o->>'to' = '+12285550199' and o->>'from' = '+12285550100', 'outbound numbers');
  perform phone_out_ccid(c, 'out-1');
  perform phone_out_end(c, 61);
  perform pg_temp.ok((select status = 'done' and seconds = 61 and company_id = 'f7200000-0000-0000-0000-000000000001' from phone_calls where id = c), 'outbound logged to Acme');
  perform pg_temp.ok(phone_call_ended('out-1', null) is null, 'Telnyx''s hangup after the browser does nothing');
  begin perform phone_out_start((select id from phone_lines limit 1), '555'); raise exception 'FAILED: bad number allowed';
  exception when others then if sqlerrm like 'FAILED%' then raise; end if; end;
end $$;
select pg_temp.ok((phone_usage(null)->'me'->>'calls_out')::int = 1 and jsonb_typeof(phone_usage(null)->'company') = 'null', 'Bob sees his own numbers only');
select set_config('test.uid', 'f7000000-0000-0000-0000-000000000001', false);
select pg_temp.ok((phone_usage(null)->'company'->>'minutes')::int = 5 and (phone_usage(null)->'company'->>'limit')::int = 3000, 'admin sees the company: 3 + 0 + 2 minutes of 3,000');
select pg_temp.ok((phone_who('2285550101')->>'person') = 'Carla Caller', 'who is calling');

-- 4. usage alerts: 1,400 minutes then over
insert into phone_calls (tenant_id, line_id, direction, ccid, status, started_at, answered_at, ended_at, seconds)
values ('77000000-0000-0000-0000-000000000001', :'line', 'in', 'big-1', 'done', now(), now(), now(), 2800 * 60);
select private.phone_usage_check('77000000-0000-0000-0000-000000000001');
select pg_temp.ok((select count(*) from private.phone_alerts where tenant_id = '77000000-0000-0000-0000-000000000001') = 1, 'one alert at 90%');
select set_config('test.uid', 'f7000000-0000-0000-0000-000000000001', false);
select pg_temp.ok(jsonb_array_length(phone_review()) = 1, 'Review notice at 90%');
select set_config('test.uid', '', false);
select private.phone_usage_check('77000000-0000-0000-0000-000000000001');
select pg_temp.ok((select count(*) from private.phone_alerts where tenant_id = '77000000-0000-0000-0000-000000000001') = 1, 'not sent twice');
update phone_calls set seconds = 3100 * 60 where ccid = 'big-1';
select private.phone_usage_check('77000000-0000-0000-0000-000000000001');
select pg_temp.ok((select count(*) from private.phone_alerts where tenant_id = '77000000-0000-0000-0000-000000000001') = 3, '95 and 100 sent');
select pg_temp.ok((select count(*) from notifications where kind = 'phone_usage' and deliver and via_override is null) = 1, 'urgent notice over 100%');
select set_config('test.uid', 'f7000000-0000-0000-0000-000000000001', false);
select phone_review_clear(date_trunc('month', now())::date, 100);
select pg_temp.ok(jsonb_array_length(phone_review()) = 0, 'cleared from Review');
select 'phone ok';
