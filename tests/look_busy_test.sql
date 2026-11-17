-- 111: Look busy hides open times until the day looks N% taken, keeps a minimum, and stays the same on every load
\set ON_ERROR_STOP 1
create function pg_temp.ok(b boolean, what text) returns text language plpgsql as $$
begin if b is not true then raise exception 'FAILED: %', what; end if; return 'ok ' || what; end $$;
insert into tenants (id, name, slug) values ('73000000-0000-0000-0000-000000000001', 'Busy Co', 'busyco');
insert into app_users (id, full_name, email, role, is_admin, tenant_id) values ('f3000000-0000-0000-0000-000000000001', 'Bea Busy', 'bea@b.test', 'staff', true, '73000000-0000-0000-0000-000000000001');
insert into user_hours (user_id, weekly, time_zone) values ('f3000000-0000-0000-0000-000000000001', '{"0":[["09:00","12:00"]],"1":[["09:00","12:00"]],"2":[["09:00","12:00"]],"3":[["09:00","12:00"]],"4":[["09:00","12:00"]],"5":[["09:00","12:00"]],"6":[["09:00","12:00"]]}', 'America/Chicago');
insert into calendars (id, tenant_id, name, slug, kind, user_ids, duration_min, slot_min, notice_min, look_busy_pct, look_busy_min)
values ('f4000000-0000-0000-0000-000000000001', '73000000-0000-0000-0000-000000000001', 'Consult', 'consult', 'one', '{f3000000-0000-0000-0000-000000000001}', 30, 30, 0, 50, 2);
select (current_date + 5)::date as d \gset
do $$ declare c calendars; d date := current_date + 5; tz text := 'America/Chicago'; allx timestamptz[]; a timestamptz[]; b timestamptz[]; begin
  select * into c from calendars where id = 'f4000000-0000-0000-0000-000000000001';
  allx := array(select distinct s.starts_at from private.cal_slots(c, d::timestamp at time zone tz, (d + 1)::timestamp at time zone tz, 30) s);
  perform pg_temp.ok(cardinality(allx) = 6, 'six real open times 9 to noon');
  a := private.cal_look_busy(c, allx, 30); b := private.cal_look_busy(c, allx, 30);
  perform pg_temp.ok(cardinality(a) = 3, '50%: half hidden (' || cardinality(a) || ')');
  perform pg_temp.ok(a = b, 'same times hidden every load');
  c.look_busy_pct := 95; a := private.cal_look_busy(c, allx, 30);
  perform pg_temp.ok(cardinality(a) = 2, '95%: keeps the minimum of 2');
  -- already busy: 4 of 6 taken (2 open) is past 50%, so nothing more is hidden
  c.look_busy_pct := 50; a := private.cal_look_busy(c, allx[1:2], 30);
  perform pg_temp.ok(cardinality(a) = 2, 'already busy enough: nothing hidden');
  c.look_busy_pct := null; a := private.cal_look_busy(c, allx, 30);
  perform pg_temp.ok(cardinality(a) = 6, 'off: everything shows');
  raise notice 'look busy ok';
end $$;
