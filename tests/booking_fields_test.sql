-- 112: booking answers fill custom fields; conflicts make a flagged duplicate; side-by-side merge keeps picks and notes the rest
\set ON_ERROR_STOP 1
create function pg_temp.ok(b boolean, what text) returns text language plpgsql as $$
begin if b is not true then raise exception 'FAILED: %', what; end if; return 'ok ' || what; end $$;
grant execute on function pg_temp.ok(boolean, text) to authenticated;
insert into tenants (id, name, slug) values ('74000000-0000-0000-0000-000000000001', 'Field Co', 'fieldco');
insert into app_users (id, full_name, email, role, is_admin, tenant_id) values ('f5000000-0000-0000-0000-000000000001', 'Ann Admin', 'ann@f.test', 'staff', true, '74000000-0000-0000-0000-000000000001');
insert into custom_fields (tenant_id, entity, key, label, type) values ('74000000-0000-0000-0000-000000000001', 'people', 'intake_done', 'Intake done', 'checkbox'),
  ('74000000-0000-0000-0000-000000000001', 'people', 'shirt', 'Shirt size', 'text');
insert into people (id, tenant_id, first_name, last_name, personal_email, personal_cell, custom) values
  ('f6000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-000000000001', 'Pat', 'Lee', 'pat@x.test', '2285550101', '{"shirt":"L"}');
insert into calendars (id, tenant_id, name, slug, kind, user_ids, questions) values ('f7000000-0000-0000-0000-000000000001', '74000000-0000-0000-0000-000000000001', 'Intro', 'intro', 'one',
  '{f5000000-0000-0000-0000-000000000001}', '[{"key":"intake","label":"Intake form done?","kind":"choice","options":["Yes","No"],"field":"people:intake_done"},{"key":"shirt","label":"Shirt size","kind":"short","field":"people:shirt"}]');
do $$ declare c calendars; r record; begin
  select * into c from calendars where id = 'f7000000-0000-0000-0000-000000000001';
  -- blanks fill, matching answers change nothing
  select * into r from private.cal_fill(c, '[{"key":"intake","value":"Yes"},{"key":"shirt","value":"l"}]', 'f6000000-0000-0000-0000-000000000001', null, 'Pat Lee', 'pat@x.test', null);
  perform pg_temp.ok(r.o_person = 'f6000000-0000-0000-0000-000000000001', 'same person when nothing conflicts');
  perform pg_temp.ok((select custom from people where id = r.o_person) = '{"shirt":"L","intake_done":true}', 'blank field filled, existing kept');
  -- a conflicting answer: new person, flagged
  select * into r from private.cal_fill(c, '[{"key":"shirt","value":"XL"}]', 'f6000000-0000-0000-0000-000000000001', null, 'Pat Lee', 'pat@x.test', null);
  perform pg_temp.ok(r.o_person <> 'f6000000-0000-0000-0000-000000000001', 'conflict makes a new person');
  perform pg_temp.ok((select custom->>'shirt' from people where id = 'f6000000-0000-0000-0000-000000000001') = 'L', 'old record untouched');
  perform pg_temp.ok(exists (select 1 from review_items where kind = 'possible_duplicate' and entity_id = r.o_person and related_id = 'f6000000-0000-0000-0000-000000000001' and reason like '%Shirt size%'), 'flagged in Review');
end $$;
-- merge: take the new shirt size, keep the old cell; the note records what lost
update people set personal_cell = '2285550199' where personal_email = 'pat@x.test' and id <> 'f6000000-0000-0000-0000-000000000001';
select id as dup from people where personal_email = 'pat@x.test' and id <> 'f6000000-0000-0000-0000-000000000001' \gset
set role authenticated;
select set_config('test.uid', 'f5000000-0000-0000-0000-000000000001', false);
select public.merge_pick('people', 'f6000000-0000-0000-0000-000000000001', :'dup', '["custom.shirt"]');
reset role;
select pg_temp.ok((select custom->>'shirt' from people where id = 'f6000000-0000-0000-0000-000000000001') = 'XL', 'picked value taken');
select pg_temp.ok((select personal_cell from people where id = 'f6000000-0000-0000-0000-000000000001') = '2285550101', 'unpicked value kept');
select pg_temp.ok((select body from activities where person_id = 'f6000000-0000-0000-0000-000000000001' order by created_at desc limit 1) like '%Shirt size: kept "XL", replaced "L"%Cell: kept "2285550101", replaced "2285550199"%'
  or (select body from activities where person_id = 'f6000000-0000-0000-0000-000000000001' order by created_at desc limit 1) like '%Cell: kept "2285550101", replaced "2285550199"%Shirt size: kept "XL", replaced "L"%', 'note lists what lost');
select pg_temp.ok((select body from activities where person_id = 'f6000000-0000-0000-0000-000000000001' order by created_at desc limit 1) like '%approved by Ann Admin%', 'note says who approved');
select pg_temp.ok((select archived_at is not null from people where id = :'dup'), 'other record archived');
select 'booking fields tests passed';
