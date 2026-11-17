-- 078: booking calendars. Run with tests/run_db.sh tests/calendars_test.sql
\set ON_ERROR_STOP 1
create function pg_temp.ok(b boolean, what text) returns text language plpgsql as $$
begin if b is not true then raise exception 'FAILED: %', what; end if; return 'ok ' || what; end $$;
create function pg_temp.fails(q text, what text) returns text language plpgsql as $$
begin begin execute q; exception when others then return 'ok ' || what || ' (' || sqlerrm || ')'; end; raise exception 'FAILED (should have stopped): %', what; end $$;
-- a time of day on a date, in Central time
create function pg_temp.at(d text, hm text) returns timestamptz language sql immutable as $$ select (d || ' ' || hm)::timestamp at time zone 'America/Chicago' $$;
-- the open times on a day as 'HH:MI' in Central time
create function pg_temp.times(j jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(to_char((x #>> '{}')::timestamptz at time zone 'America/Chicago', 'HH24:MI'), ',' order by x #>> '{}'), '') from jsonb_array_elements(j) x $$;
grant execute on function pg_temp.ok(boolean, text), pg_temp.fails(text, text), pg_temp.at(text, text), pg_temp.times(jsonb) to authenticated, anon;

insert into tenants (id, name, slug) values ('71000000-0000-0000-0000-000000000001', 'Cal Co', 'calco'), ('72000000-0000-0000-0000-000000000002', 'Other Co', 'other');
insert into app_users (id, full_name, email, role, is_admin, tenant_id) values
 ('f1000000-0000-0000-0000-000000000001', 'Admin Al', 'al@cal.test', 'staff', true, '71000000-0000-0000-0000-000000000001'),
 ('f1000000-0000-0000-0000-000000000002', 'Rita Rep', 'rita@cal.test', 'staff', false, '71000000-0000-0000-0000-000000000001'),
 ('f1000000-0000-0000-0000-000000000003', 'Fred Field', 'fred@cal.test', 'staff', false, '71000000-0000-0000-0000-000000000001'),
 ('f1000000-0000-0000-0000-000000000009', 'Oscar Outsider', 'oscar@other.test', 'staff', true, '72000000-0000-0000-0000-000000000002'),
 ('f1000000-0000-0000-0000-000000000008', 'Mia Member', 'mia@other.test', 'staff', false, '72000000-0000-0000-0000-000000000002');
-- Mia's home is Other Co; she's also on Cal Co's team
insert into account_members (tenant_id, user_id, is_admin) values ('71000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000008', false);
insert into companies (id, tenant_id, name) values ('f2000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'Oak Lot');
-- a Monday 8 to 14 days out
select (current_date + 8 + ((8 - extract(isodow from current_date + 8)::int) % 7))::date::text as d \gset
select (:'d'::date + 1)::text as d2 \gset

set role authenticated;
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);

-- ---------- the switch ----------
select pg_temp.ok(not private.feature_on('calendars'), 'off by default');
select pg_temp.fails($q$ select calendar_save(null, '{"name":"x","user_ids":["f1000000-0000-0000-0000-000000000001"]}') $q$, 'no calendars while off');
select pg_temp.ok(account_settings_save('{"features":{"calendars":true}}'::jsonb) is not null, 'switched on');

-- ---------- roles ----------
select role_save(null, 'Sales rep', (role_presets()->'sales_rep'->'perms'), 'sales_rep') as rep \gset
select role_save(null, 'Field worker', (role_presets()->'field_worker'->'perms'), 'field_worker') as fw \gset
select user_role_set('f1000000-0000-0000-0000-000000000002', :'rep');
select user_role_set('f1000000-0000-0000-0000-000000000003', :'fw');
select pg_temp.ok((role_presets()->'sales_rep'->'perms'->'calendars'->>'level')::int = 2 and (role_presets()->'field_worker'->'perms'->'calendars'->>'level')::int = 1, 'preset levels');

-- ---------- set up: Al and Rita work 9 to 12 on weekdays; a one person calendar for Al ----------
select cal_hours_save('f1000000-0000-0000-0000-000000000001', '{"1":[["09:00","12:00"]],"2":[["09:00","12:00"]],"3":[["09:00","12:00"]],"4":[["09:00","12:00"]],"5":[["09:00","12:00"]]}', 'America/Chicago');
select cal_hours_save('f1000000-0000-0000-0000-000000000002', '{"1":[["09:00","12:00"]],"2":[["09:00","12:00"]]}', 'America/Chicago');
select cal_hours_save('f1000000-0000-0000-0000-000000000008', '{"1":[["09:00","10:00"]]}', 'America/Chicago');
select pg_temp.fails($q$ select cal_hours_save('f1000000-0000-0000-0000-000000000001', '{"1":[["12:00","09:00"]]}', 'America/Chicago') $q$, 'range must end after it starts');
select pg_temp.fails($q$ select cal_hours_save('f1000000-0000-0000-0000-000000000001', '{"1":[["09:00","12:00"],["11:00","13:00"]]}', 'America/Chicago') $q$, 'no overlapping ranges');
select pg_temp.fails($q$ select cal_hours_save('f1000000-0000-0000-0000-000000000001', '{}', 'Mars/Base') $q$, 'unknown time zone');
select pg_temp.fails($q$ select cal_hours_save('f1000000-0000-0000-0000-000000000009', '{}', 'America/Chicago') $q$, 'not on the team');
select calendar_save(null, '{"name":"Consult","slug":"Consult!","kind":"one","user_ids":["f1000000-0000-0000-0000-000000000001"],"duration_min":30,"durations":[60],
  "slot_min":30,"buffer_after":15,"notice_min":0,"ahead_days":60,"location_kind":"phone","ask_company":true,
  "questions":[{"key":"what","label":"What for?","kind":"long","required":true},{"key":"heard","label":"Heard from","kind":"choice","options":["Google","Friend"]}]}') as cal1 \gset
select pg_temp.ok(slug = 'consult' and durations = '{60}' and jsonb_array_length(questions) = 2 and questions->0->>'key' = 'what' and questions->1->>'key' = 'heard', 'calendar saved and cleaned') from calendars where id = :'cal1';
select pg_temp.fails($q$ select calendar_save(null, '{"name":"Again","slug":"consult","user_ids":["f1000000-0000-0000-0000-000000000001"]}') $q$, 'link names are unique');
select pg_temp.fails($q$ select calendar_save(null, '{"name":"Far","user_ids":["f1000000-0000-0000-0000-000000000009"]}') $q$, 'outsiders can''t take bookings');
select pg_temp.fails($q$ select calendar_save(null, '{"name":"Q","user_ids":["f1000000-0000-0000-0000-000000000001"],"questions":[{"label":"Pick","kind":"choice","options":["A"]}]}') $q$, 'choice needs two options');

-- ---------- slot math ----------
select pg_temp.ok(pg_temp.times(book_slots('calco', 'consult', pg_temp.at(:'d', '00:00'), pg_temp.at(:'d', '23:59'))) = '09:00,09:30,10:00,10:30,11:00,11:30', 'open times on an empty morning');
select pg_temp.ok(pg_temp.times(book_slots('calco', 'consult', pg_temp.at(:'d', '00:00'), pg_temp.at(:'d', '23:59'), 60)) = '09:00,09:30,10:00,10:30,11:00', 'a 60 minute length fits inside the hours');
select pg_temp.fails($q$ select book_slots('calco', 'consult', now(), now() + interval '1 day', 45) $q$, 'only offered lengths');
select pg_temp.ok(book_info('calco', 'consult')->>'with' = 'Admin A.' and book_info('calco', 'consult')->'lengths' = '[30, 60]' and book_info('calco', 'nope') is null, 'public info');
select pg_temp.ok(not (book_info('calco', 'consult') ? 'user_ids') and book_info('calco', 'consult')->'team' = 'null', 'public info hides the team');

-- ---------- booking from the public page (as nobody) ----------
reset role; set role anon; select set_config('test.uid', '', false);
select pg_temp.fails(format($q$ select book_make('calco', 'consult', %L, 30, null, '{"name":"Pat Doe","email":"pat@example.com","phone":"2285550101","answers":{"heard":"Google"}}') $q$, pg_temp.at(:'d', '10:00')), 'required question');
select pg_temp.fails(format($q$ select book_make('calco', 'consult', %L, 30, null, '{"name":"Pat Doe","email":"pat@example.com","phone":"2285550101","answers":{"what":"x","heard":"Bing"}}') $q$, pg_temp.at(:'d', '10:00')), 'choice must be offered');
select pg_temp.fails(format($q$ select book_make('calco', 'consult', %L, 30, null, '{"name":"Pat Doe","email":"pat@example.com","answers":{"what":"x"}}') $q$, pg_temp.at(:'d', '10:00')), 'phone calls need a phone');
select pg_temp.fails(format($q$ select book_make('calco', 'consult', %L, 30, null, '{"name":"Pat Doe","email":"pat@example.com","phone":"2285550101","answers":{"what":"x"}}') $q$, pg_temp.at(:'d', '10:10')), 'only open start times');
select book_make('calco', 'consult', pg_temp.at(:'d', '10:00'), 30, null, '{"name":"Pat Doe","email":"Pat@Example.com","phone":"228-555-0101","company":"Pat Co","answers":{"what":"Roof leak","heard":"Google"},"tz":"America/New_York"}') as b1 \gset
select pg_temp.ok((:'b1'::jsonb->>'ok')::boolean and length(:'b1'::jsonb->>'token') = 64 and :'b1'::jsonb->>'with' = 'Admin A.', 'booked, with a manage link');
-- the honeypot: a bot fills the hidden field, gets a thank you and nothing is made
select pg_temp.ok(book_make('calco', 'consult', pg_temp.at(:'d', '11:00'), 30, null, '{"name":"Bot","email":"bot@x.com","phone":"1","website":"http://spam"}') = '{"ok": true}', 'honeypot');
-- the same slot again: taken
select pg_temp.fails(format($q$ select book_make('calco', 'consult', %L, 30, null, '{"name":"Sam Two","email":"sam@example.com","phone":"2285550199","answers":{"what":"x"}}') $q$, pg_temp.at(:'d', '10:00')), 'double booking blocked');
-- anon can't read appointments directly
select pg_temp.fails($q$ select count(*) from appointments $q$, 'anon reads no appointments');
reset role;
select pg_temp.ok(count(*) = 1, 'one appointment, the bot made none') from appointments where tenant_id = '71000000-0000-0000-0000-000000000001';

-- buffers: the 10:00 booking holds 10:00 to 10:30 plus 15 minutes after. 09:30 would run into it with its own 15 after; 10:30 starts inside its buffer.
select pg_temp.ok(pg_temp.times(book_slots('calco', 'consult', pg_temp.at(:'d', '00:00'), pg_temp.at(:'d', '23:59'))) = '09:00,11:00,11:30', 'buffers on both sides');
-- the contact: person and organization made like a form lead, linked, with the timeline entry
select pg_temp.ok(p.personal_email = 'pat@example.com' and p.first_name = 'Pat' and p.last_name = 'Doe' and c.name = 'Pat Co' and a.company_id = c.id and a.status = 'booked'
  and a.answers->0->>'value' = 'Roof leak' and a.visitor_tz = 'America/New_York' and a.location = 'Phone call to 228-555-0101' and a.user_id = 'f1000000-0000-0000-0000-000000000001'
  and exists (select 1 from company_people cp where cp.person_id = p.id and cp.company_id = c.id), 'person and organization made')
  from appointments a join people p on p.id = a.person_id join companies c on c.id = a.company_id where a.tenant_id = '71000000-0000-0000-0000-000000000001';
select pg_temp.ok(exists (select 1 from contact_events e join appointments a on a.person_id = e.person_id where e.kind = 'appointment_booked' and e.data->>'calendar_id' = :'cal1'), 'on the timeline');
select pg_temp.ok((select lead_source from people where personal_email = 'pat@example.com') = 'Booking: Consult', 'lead source from the booking');
select pg_temp.ok((select count(*) from notifications where user_id = 'f1000000-0000-0000-0000-000000000001' and kind = 'appointment') = 1, 'Al was notified');
select pg_temp.ok((select string_agg(kind || ':' || to_email, ',' order by kind) from private.cal_mail) = 'confirm:pat@example.com,notice:al@cal.test', 'confirmation and team notice queued');
select pg_temp.ok((select count(*) from net.calls where url like '%/booking-email') = 2, 'each email calls the function');

-- ---------- notice, booking window, overrides, daily max ----------
update calendars set notice_min = 43200 where id = :'cal1';   -- 30 days: the Monday is too soon
select pg_temp.ok(book_slots('calco', 'consult', pg_temp.at(:'d', '00:00'), pg_temp.at(:'d', '23:59')) = '[]', 'minimum notice');
update calendars set notice_min = 0, ahead_days = 3 where id = :'cal1';
select pg_temp.ok(book_slots('calco', 'consult', pg_temp.at(:'d', '00:00'), pg_temp.at(:'d', '23:59')) = '[]', 'booking window');
update calendars set ahead_days = 60 where id = :'cal1';
set role authenticated; select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
select cal_override_save('f1000000-0000-0000-0000-000000000001', :'d2', '[]', 'Dentist') as ov \gset
select pg_temp.ok(book_slots('calco', 'consult', pg_temp.at(:'d2', '00:00'), pg_temp.at(:'d2', '23:59')) = '[]', 'day off');
select cal_override_save('f1000000-0000-0000-0000-000000000001', :'d2', '[["14:00","15:00"]]', 'Afternoon only');
select pg_temp.ok(pg_temp.times(book_slots('calco', 'consult', pg_temp.at(:'d2', '00:00'), pg_temp.at(:'d2', '23:59'))) = '14:00,14:30', 'other hours that day');
select pg_temp.ok((select count(*) from cal_overrides) = 1, 'saving the same day replaces it');
select calendar_save(:'cal1', (select to_jsonb(c) - 'id' - 'tenant_id' || '{"daily_max":1}' from calendars c where id = :'cal1')) is not null as daily_max_set;
select pg_temp.ok(book_slots('calco', 'consult', pg_temp.at(:'d', '00:00'), pg_temp.at(:'d', '23:59')) = '[]', 'daily max per person');
select calendar_save(:'cal1', (select to_jsonb(c) - 'id' - 'tenant_id' || '{"daily_max":null}' from calendars c where id = :'cal1')) is not null as daily_max_off;

-- jobs with times and outside busy times block too
reset role;
insert into jobs (tenant_id, company_id, title, scheduled_start, scheduled_end, assigned_to) values ('71000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'Visit',
  pg_temp.at(:'d', '11:00'), pg_temp.at(:'d', '11:40'), 'f1000000-0000-0000-0000-000000000001');
insert into cal_busy (user_id, starts_at, ends_at, source, external_id, title) values ('f1000000-0000-0000-0000-000000000001', pg_temp.at(:'d', '09:00'), pg_temp.at(:'d', '09:15'), 'google', 'g1', 'Private');
select pg_temp.ok(book_slots('calco', 'consult', pg_temp.at(:'d', '00:00'), pg_temp.at(:'d', '23:59')) = '[]', 'a job and an outside busy time take the rest of the morning');
delete from cal_busy; delete from jobs where title = 'Visit';

-- ---------- round robin, and a member from another account ----------
set role authenticated; select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
select calendar_save(null, '{"name":"Estimate","kind":"round_robin","user_ids":["f1000000-0000-0000-0000-000000000002","f1000000-0000-0000-0000-000000000008"],
  "duration_min":30,"slot_min":30,"notice_min":0,"location_kind":"customer"}') as cal2 \gset
reset role; set role anon; select set_config('test.uid', '', false);
select pg_temp.ok(pg_temp.times(book_slots('calco', 'estimate', pg_temp.at(:'d', '00:00'), pg_temp.at(:'d', '23:59'))) = '09:00,09:30,10:00,10:30,11:00,11:30', 'round robin offers anyone open');
select pg_temp.fails(format($q$ select book_make('calco', 'estimate', %L, 30, null, '{"name":"Lee","email":"lee@x.com"}') $q$, pg_temp.at(:'d', '09:00')), 'customer address needed');
select book_make('calco', 'estimate', pg_temp.at(:'d', '09:00'), 30, null, '{"name":"Lee One","email":"lee@x.com","address":"1 Beach Blvd"}')->>'with' as rr1 \gset
select book_make('calco', 'estimate', pg_temp.at(:'d', '09:00'), 30, null, '{"name":"Lee Two","email":"lee2@x.com","address":"2 Beach Blvd"}')->>'with' as rr2 \gset
select pg_temp.ok(:'rr1' <> :'rr2' and :'rr1' in ('Rita R.', 'Mia M.') and :'rr2' in ('Rita R.', 'Mia M.'), 'round robin spreads the same time across both');
select pg_temp.fails(format($q$ select book_make('calco', 'estimate', %L, 30, null, '{"name":"Lee Three","email":"lee3@x.com","address":"3 Beach Blvd"}') $q$, pg_temp.at(:'d', '09:00')), 'third at the same time: everyone is taken');
-- the next one goes to whoever was booked least recently (Rita and Mia are both free at 09:30; Rita only works Mondays and Tuesdays till 12)
select book_make('calco', 'estimate', pg_temp.at(:'d', '09:30'), 30, null, '{"name":"Lee Four","email":"lee4@x.com","address":"4 Beach Blvd"}')->>'with' as rr4 \gset
select pg_temp.ok(:'rr4' = :'rr1', 'least recently booked goes next');
reset role;
-- Mia's appointment in her own account blocks her here too
insert into appointments (tenant_id, user_id, starts_at, ends_at, title) values ('72000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000008', pg_temp.at(:'d2', '09:00'), pg_temp.at(:'d2', '10:00'), 'Home thing');
update cal_hours set weekly = '{"2":[["09:00","10:00"]]}' where user_id = 'f1000000-0000-0000-0000-000000000008';
update cal_hours set weekly = '{}' where user_id = 'f1000000-0000-0000-0000-000000000002';
select pg_temp.ok(book_slots('calco', 'estimate', pg_temp.at(:'d2', '00:00'), pg_temp.at(:'d2', '23:59')) = '[]', 'busy in another account means busy here');
-- removed from the team: no longer offered
update account_members set active = false where user_id = 'f1000000-0000-0000-0000-000000000008';
delete from appointments where title = 'Home thing';
select pg_temp.ok(book_slots('calco', 'estimate', pg_temp.at(:'d2', '00:00'), pg_temp.at(:'d2', '23:59')) = '[]' and not ('f1000000-0000-0000-0000-000000000008' = any (private.cal_people(c))), 'removed members drop off')
  from calendars c where id = :'cal2';
update account_members set active = true where user_id = 'f1000000-0000-0000-0000-000000000008';

-- ---------- pick a person ----------
set role authenticated; select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
select calendar_save(null, '{"name":"Pick","kind":"pick","user_ids":["f1000000-0000-0000-0000-000000000001","f1000000-0000-0000-0000-000000000008"],"notice_min":0,"location_kind":"video","location_text":"https://meet.example/x"}') as cal3 \gset
reset role; set role anon; select set_config('test.uid', '', false);
select pg_temp.ok(jsonb_array_length(book_info('calco', 'pick')->'team') = 2 and book_info('calco', 'pick')->'team'->0->>'name' = 'Admin A.', 'pick shows first names only');
select pg_temp.ok(pg_temp.times(book_slots('calco', 'pick', pg_temp.at(:'d2', '00:00'), pg_temp.at(:'d2', '23:59'), null, 'f1000000-0000-0000-0000-000000000008')) = '09:00,09:30', 'pick: only that person''s times');
select pg_temp.fails(format($q$ select book_make('calco', 'pick', %L, 30, null, '{"name":"Ann","email":"ann@x.com"}') $q$, pg_temp.at(:'d2', '09:00')), 'pick needs a person');
select pg_temp.ok(book_make('calco', 'pick', pg_temp.at(:'d2', '09:00'), 30, 'f1000000-0000-0000-0000-000000000008', '{"name":"Ann","email":"ann@x.com"}')->>'with' = 'Mia M.', 'picked person gets it');
reset role;
select pg_temp.ok(location = 'Video: https://meet.example/x', 'video link location') from appointments where email = 'ann@x.com';

-- ---------- the same person comes back: matched, not doubled ----------
set role anon; select set_config('test.uid', '', false);
select book_make('calco', 'consult', pg_temp.at(:'d', '11:00'), 30, null, '{"name":"Patricia Doe","email":"pat@example.com","phone":"2285550101","answers":{"what":"Again"}}') as b2 \gset
reset role;
select pg_temp.ok((select count(*) from people where tenant_id = '71000000-0000-0000-0000-000000000001' and lower(personal_email) = 'pat@example.com') = 1, 'returning customer matched by email');

-- ---------- the manage link: cancel and reschedule within the rules ----------
set role anon; select set_config('test.uid', '', false);
select pg_temp.ok(book_manage(repeat('0', 64)) is null and book_manage('short') is null and book_manage(null) is null, 'unknown links show nothing');
select pg_temp.ok(not (book_manage(:'b1'::jsonb->>'token') ? 'email') and not (book_manage(:'b1'::jsonb->>'token') ? 'phone') and (book_manage(:'b1'::jsonb->>'token')->>'can_cancel')::boolean, 'manage shows the booking, not their contact details');
select pg_temp.ok(pg_temp.times(book_manage_slots(:'b1'::jsonb->>'token', pg_temp.at(:'d', '00:00'), pg_temp.at(:'d', '23:59'))) = '09:00,09:30,10:00', 'reschedule offers times around its own spot');
select pg_temp.ok((book_reschedule(:'b1'::jsonb->>'token', pg_temp.at(:'d', '09:00'))->>'ok')::boolean, 'rescheduled');
reset role;
select pg_temp.ok(status = 'rescheduled' and starts_at = pg_temp.at(:'d', '09:00') and history->-1->>'what' = 'rescheduled', 'moved and marked') from appointments where manage_token = :'b1'::jsonb->>'token';
select pg_temp.ok(exists (select 1 from private.cal_mail where kind = 'reschedule') and exists (select 1 from private.cal_mail where kind = 'reschedule_notice'), 'reschedule emails queued');
-- inside the cutoff (4 hours): no changes online
update appointments set starts_at = now() + interval '2 hours', ends_at = now() + interval '150 minutes' where manage_token = :'b2'::jsonb->>'token';
set role anon; select set_config('test.uid', '', false);
select pg_temp.ok(not (book_manage(:'b2'::jsonb->>'token')->>'can_cancel')::boolean and not (book_manage(:'b2'::jsonb->>'token')->>'can_reschedule')::boolean, 'cutoff shown');
select pg_temp.fails(format($q$ select book_cancel(%L) $q$, :'b2'::jsonb->>'token'), 'no cancel inside the cutoff');
select pg_temp.fails(format($q$ select book_reschedule(%L, %L) $q$, :'b2'::jsonb->>'token', pg_temp.at(:'d', '11:30')), 'no reschedule inside the cutoff');
select pg_temp.ok(book_manage_slots(:'b2'::jsonb->>'token', now(), now() + interval '30 days') = '[]', 'no reschedule times inside the cutoff');
-- outside it: cancel works, once
select pg_temp.ok(book_cancel(:'b1'::jsonb->>'token', 'Fixed it myself')->>'status' = 'cancelled' and book_cancel(:'b1'::jsonb->>'token')->>'status' = 'cancelled', 'cancelled');
select pg_temp.fails(format($q$ select book_reschedule(%L, %L) $q$, :'b1'::jsonb->>'token', pg_temp.at(:'d', '11:30')), 'cancelled can''t move');
reset role;
select pg_temp.ok(cancelled_by = 'customer' and cancel_reason = 'Fixed it myself', 'cancel recorded') from appointments where manage_token = :'b1'::jsonb->>'token';
select pg_temp.ok(exists (select 1 from contact_events where kind = 'appointment_cancelled'), 'cancel on the timeline');
select pg_temp.ok((select count(*) from private.cal_mail where kind in ('cancel', 'cancel_notice')) = 2, 'cancel emails queued');
-- a calendar that doesn't allow changes online
update calendars set allow_cancel = false where id = :'cal3';
select manage_token as ann from appointments where email = 'ann@x.com' \gset
set role anon; select set_config('test.uid', '', false);
select pg_temp.fails(format($q$ select book_cancel(%L) $q$, :'ann'), 'calendar turns off cancelling');
reset role;

-- ---------- reminders ----------
update appointments set starts_at = now() + interval '50 minutes', ends_at = now() + interval '80 minutes', timed_at = now() - interval '3 days', status = 'booked' where email = 'lee@x.com';
update appointments set starts_at = now() + interval '50 minutes', ends_at = now() + interval '80 minutes', timed_at = now() - interval '10 minutes' where email = 'lee2@x.com';
select private.cal_remind() as reminders_queued \gset
select pg_temp.ok((select string_agg(a.email || ':' || m.minutes, ',') from private.cal_mail m join appointments a on a.id = m.appointment_id where m.kind = 'reminder') = 'lee@x.com:60',
  'the 1 hour reminder only, and not for a booking made after that moment');
select private.cal_remind();
select pg_temp.ok((select count(*) from private.cal_mail where kind = 'reminder') = 1, 'reminders go once');
-- the edge function's read: needs the secret, skips what no longer applies
select pg_temp.fails($q$ select cal_mail_take((select id from private.cal_mail limit 1), 'wrong') $q$, 'mail needs the secret');
select pg_temp.ok(cal_mail_take(m.id, 'testsecret')->>'kind' = 'reminder' and cal_mail_take(m.id, 'testsecret')->'appointment'->>'token' is not null, 'mail read')
  from private.cal_mail m where m.kind = 'reminder';
select cal_mail_done(m.id, 'testsecret', true, null) from private.cal_mail m where m.kind = 'reminder';
select pg_temp.ok(status = 'sent', 'mail marked sent') from private.cal_mail where kind = 'reminder';
select m.id as pat_confirm from private.cal_mail m join appointments a on a.id = m.appointment_id where a.manage_token = :'b1'::jsonb->>'token' and m.kind = 'confirm' \gset
select pg_temp.ok(cal_mail_take(:'pat_confirm', 'testsecret') is null, 'nothing to send for a cancelled booking');
select pg_temp.ok(status = 'skipped', 'confirmation for a cancelled booking is skipped') from private.cal_mail where id = :'pat_confirm';

-- ---------- in the app: roles, scope and other accounts ----------
set role authenticated;
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000002', false);   -- Rita, sales rep: level 2, own
select pg_temp.ok((select count(*) from appointments) = (select count(*) from appointments where user_id = 'f1000000-0000-0000-0000-000000000002'), 'rep sees only her own');
select pg_temp.ok((select count(*) from calendars) = 3, 'rep sees the calendars');
select pg_temp.fails($q$ select calendar_save(null, '{"name":"Mine","user_ids":["f1000000-0000-0000-0000-000000000002"]}') $q$, 'rep can''t set up calendars');
select cal_hours_save('f1000000-0000-0000-0000-000000000002', '{"1":[["09:00","12:00"]]}', 'America/Chicago');
select pg_temp.fails($q$ select cal_hours_save('f1000000-0000-0000-0000-000000000001', '{}', 'America/Chicago') $q$, 'rep can''t change someone else''s hours');
select pg_temp.fails(format($q$ select appointment_save(null, '{"user_id":"f1000000-0000-0000-0000-000000000001","starts_at":"%s"}') $q$, pg_temp.at(:'d', '15:00')), 'rep can''t book for others');
select appointment_save(null, jsonb_build_object('user_id', 'f1000000-0000-0000-0000-000000000002', 'starts_at', pg_temp.at(:'d', '15:00'), 'title', 'Call back', 'notify', false)) as man1 \gset
select pg_temp.fails(format($q$ select appointment_save(null, '{"user_id":"f1000000-0000-0000-0000-000000000002","starts_at":"%s","title":"Clash"}') $q$, pg_temp.at(:'d', '15:15')), 'busy warning');
select appointment_save(null, jsonb_build_object('user_id', 'f1000000-0000-0000-0000-000000000002', 'starts_at', pg_temp.at(:'d', '15:15'), 'title', 'Squeeze in', 'force', true)) as man2 \gset
select appointment_status(:'man2', 'completed');
select pg_temp.ok((select status from appointments where id = :'man2') = 'completed', 'status changed');
select pg_temp.fails($q$ select appointment_status((select id from appointments where user_id = 'f1000000-0000-0000-0000-000000000001' limit 1), 'no_show') $q$, 'can''t change Al''s');
select pg_temp.fails($q$ select manage_token from appointments limit 1 $q$, 'the manage token stays on the server');
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000003', false);   -- Fred, field worker: view own
select pg_temp.fails(format($q$ select appointment_save(null, '{"user_id":"f1000000-0000-0000-0000-000000000003","starts_at":"%s"}') $q$, pg_temp.at(:'d', '16:00')), 'view only can''t book');
select pg_temp.fails($q$ select cal_hours_save('f1000000-0000-0000-0000-000000000003', '{}', 'America/Chicago') $q$, 'view only can''t change hours');
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000009', false);   -- the other account
select pg_temp.ok((select count(*) from calendars) = 0 and (select count(*) from appointments) = 0 and (select count(*) from cal_hours) = 0, 'other account sees none of it');
select pg_temp.fails(format($q$ select appointment_status(%L, 'cancelled') $q$, :'man1'), 'other account can''t cancel ours');
select pg_temp.fails($q$ select cal_hours_save('f1000000-0000-0000-0000-000000000001', '{}', 'America/Chicago') $q$, 'other account can''t change our hours');
select pg_temp.fails(format($q$ select calendar_archive(%L) $q$, :'cal1'), 'other account can''t archive ours');
select pg_temp.ok(appointment_mail(:'man1') = '[]', 'other account can''t see our emails');
select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);   -- Al, admin: everything in his account
select pg_temp.ok((select count(*) from appointments) = (select count(*) from appointments a where a.tenant_id = '71000000-0000-0000-0000-000000000001'), 'admin sees the account''s appointments');
select appointment_save(:'man1', jsonb_build_object('user_id', 'f1000000-0000-0000-0000-000000000002', 'starts_at', pg_temp.at(:'d', '16:00')));
select pg_temp.ok(status = 'rescheduled' and history->-1->>'what' = 'moved', 'moved by hand') from appointments where id = :'man1';
reset role;
select id as pat_person from people where lower(personal_email) = 'pat@example.com' \gset
set role authenticated; select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
select appointment_save(null, jsonb_build_object('user_id', 'f1000000-0000-0000-0000-000000000002', 'person_id', :'pat_person', 'starts_at', pg_temp.at(:'d2', '13:00'), 'notify', false)) as quiet1 \gset
select appointment_save(null, jsonb_build_object('user_id', 'f1000000-0000-0000-0000-000000000002', 'person_id', :'pat_person', 'starts_at', pg_temp.at(:'d2', '14:00'))) as loud1 \gset
reset role;
select pg_temp.ok((select string_agg(kind || ':' || to_email, ',') from private.cal_mail where appointment_id = :'quiet1') = 'notice:rita@cal.test'
  and (select string_agg(kind || ':' || to_email, ',' order by kind) from private.cal_mail where appointment_id = :'loud1') = 'confirm:pat@example.com,notice:rita@cal.test'
  and (select email from appointments where id = :'loud1') = 'pat@example.com', 'by hand: the customer is emailed unless told not to, contact details come from the person');
select pg_temp.ok((select string_agg(kind, ',' order by created_at) from private.cal_mail m where m.appointment_id = :'man1') = 'reschedule_notice', 'a team member adding her own: no email to herself; Al moving it tells her');

-- ---------- automations: booked trigger, optionally one calendar ----------
set role authenticated; select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
select automation_save(null, jsonb_build_object('name', 'Booked consult', 'active', true, 'trigger', jsonb_build_object('kind', 'appointment_booked', 'calendar_id', :'cal1'),
  'steps', '[{"type":"task","title":"Prep"}]'::jsonb)) as au1 \gset
select automation_save(null, jsonb_build_object('name', 'Any booking', 'active', true, 'trigger', '{"kind":"appointment_booked"}'::jsonb, 'steps', '[{"type":"task","title":"Prep"}]'::jsonb)) as au2 \gset
reset role; set role anon; select set_config('test.uid', '', false);
select book_make('calco', 'estimate', pg_temp.at(:'d', '11:30'), 30, null, '{"name":"Rob Auto","email":"rob@x.com","address":"5 Beach Blvd"}') is not null as booked_for_auto;
reset role;
select pg_temp.ok((select count(*) from automation_runs where automation_id = :'au2') = 1 and (select count(*) from automation_runs where automation_id = :'au1') = 0, 'automation starts, calendar filter respected');

-- ---------- switching it off closes the public page ----------
set role authenticated; select set_config('test.uid', 'f1000000-0000-0000-0000-000000000001', false);
select account_settings_save('{"features":{"calendars":false}}'::jsonb) is not null as off_again;
reset role; set role anon; select set_config('test.uid', '', false);
select pg_temp.ok(book_info('calco', 'consult') is null and book_slots('calco', 'consult', now(), now() + interval '7 days') is null, 'off: page closed');
select pg_temp.fails(format($q$ select book_make('calco', 'consult', %L, 30, null, '{"name":"Z","email":"z@x.com","phone":"2285550000","answers":{"what":"x"}}') $q$, pg_temp.at(:'d', '11:30')), 'off: no bookings');
reset role;
select 'calendars tests passed';
