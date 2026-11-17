-- 077: e-sign. Run with tests/run_db.sh tests/esign_test.sql
\set ON_ERROR_STOP 1
create function pg_temp.ok(b boolean, what text) returns text language plpgsql as $$
begin if b is not true then raise exception 'FAILED: %', what; end if; return 'ok ' || what; end $$;
create function pg_temp.fails(q text, what text) returns text language plpgsql as $$
begin begin execute q; exception when others then return 'ok ' || what || ' (' || sqlerrm || ')'; end; raise exception 'FAILED (should have stopped): %', what; end $$;
grant execute on function pg_temp.ok(boolean, text), pg_temp.fails(text, text) to authenticated, anon;
grant select, insert on storage.objects to authenticated;

insert into tenants (id, name, slug) values ('77000000-0000-0000-0000-000000000001', 'Sign Co', 'signco'), ('78000000-0000-0000-0000-000000000002', 'Other Co', 'otherco');
insert into app_users (id, full_name, email, role, is_admin, tenant_id) values
 ('a7000000-0000-0000-0000-000000000001', 'Admin Al', 'al@signco.test', 'staff', true, '77000000-0000-0000-0000-000000000001'),
 ('a7000000-0000-0000-0000-000000000002', 'Rita Rep', 'rita@signco.test', 'staff', false, '77000000-0000-0000-0000-000000000001'),
 ('a7000000-0000-0000-0000-000000000003', 'Fred Field', 'fred@signco.test', 'staff', false, '77000000-0000-0000-0000-000000000001'),
 ('a7000000-0000-0000-0000-000000000004', 'Andy Accounting', 'andy@signco.test', 'staff', false, '77000000-0000-0000-0000-000000000001'),
 ('a7000000-0000-0000-0000-000000000009', 'Outsider', 'out@other.test', 'staff', true, '78000000-0000-0000-0000-000000000002');
insert into companies (id, tenant_id, name) values ('a8000000-0000-0000-0000-000000000001', '77000000-0000-0000-0000-000000000001', 'Oak Apartments'),
  ('a8000000-0000-0000-0000-000000000002', '78000000-0000-0000-0000-000000000002', 'Theirs');
insert into people (id, tenant_id, first_name, last_name) values ('a9000000-0000-0000-0000-000000000001', '77000000-0000-0000-0000-000000000001', 'Pam', 'Smith');

set role authenticated;
select set_config('test.uid', 'a7000000-0000-0000-0000-000000000001', false);
\set fp '\'77000000-0000-0000-0000-000000000001/u/abc-contract.pdf\''

-- ---------- the switch ----------
select pg_temp.ok(not private.feature_on('esign'), 'off by default');
select pg_temp.fails($q$ select esign_envelope_create('{"file_path":"77000000-0000-0000-0000-000000000001/u/a.pdf","signers":[]}') $q$, 'nothing while off');
select pg_temp.ok((select count(*) from esign_envelopes) = 0, 'no envelopes seen while off');
select pg_temp.ok(account_settings_save('{"features":{"esign":true}}'::jsonb) is not null, 'switched on');
select pg_temp.ok((esign_settings_get()->>'can_edit')::boolean and (esign_settings_get()->>'expires_days')::int = 30, 'admin can set up');
select pg_temp.ok((esign_settings_save('{"default_message":"Sign when you can","expires_days":14}')->>'expires_days')::int = 14, 'settings saved');

-- roles from the ready-made presets
select role_save(null, 'Sales rep', (role_presets()->'sales_rep'->'perms'), 'sales_rep') as rep \gset
select role_save(null, 'Field worker', (role_presets()->'field_worker'->'perms'), 'field_worker') as fw \gset
select role_save(null, 'Accounting', (role_presets()->'accounting'->'perms'), 'accounting') as acc \gset
select user_role_set('a7000000-0000-0000-0000-000000000002', :'rep');
select user_role_set('a7000000-0000-0000-0000-000000000003', :'fw');
select user_role_set('a7000000-0000-0000-0000-000000000004', :'acc');
select pg_temp.ok(role_presets()->'sales_rep'->'perms'->'esign' = '{"level":2,"scope":"own"}' and role_presets()->'field_worker'->'perms'->'esign' = '{"level":0,"scope":"own"}'
  and role_presets()->'manager'->'perms'->'esign' = '{"level":4,"scope":"all"}', 'preset levels');

-- ---------- files: own folder only ----------
insert into storage.objects (bucket_id, name) values ('esign-files', '77000000-0000-0000-0000-000000000001/u/abc-contract.pdf');
select pg_temp.fails($q$ insert into storage.objects (bucket_id, name) values ('esign-files', '78000000-0000-0000-0000-000000000002/u/x.pdf') $q$, 'no uploads to another account''s folder');

-- ---------- a draft from an upload ----------
select pg_temp.fails(format($q$ select esign_envelope_create('{"file_path":"78000000-0000-0000-0000-000000000002/u/x.pdf","signers":[]}') $q$), 'file must be in our folder');
select pg_temp.fails(format($q$ select esign_envelope_create(jsonb_build_object('file_path', %L, 'company_id', 'a8000000-0000-0000-0000-000000000002')) $q$, :fp), 'can''t link another account''s organization');
select esign_envelope_create(jsonb_build_object('title', 'Service agreement', 'file_path', :fp, 'file_name', 'contract.pdf', 'pages', '[{"w":612,"h":792},{"w":612,"h":792}]'::jsonb,
  'company_id', 'a8000000-0000-0000-0000-000000000001', 'person_id', 'a9000000-0000-0000-0000-000000000001', 'ordered', true,
  'signers', jsonb_build_array(jsonb_build_object('name', 'Pam Smith', 'email', 'Pam@Oak.test', 'order', 1), jsonb_build_object('name', 'Al Admin', 'email', 'al@signco.test', 'order', 2)),
  'fields', '[{"id":"f1","signer":"s1","type":"signature","page":2,"x":0.1,"y":0.8,"w":0.3,"h":0.06},
              {"id":"f2","signer":"s1","type":"date","page":2,"x":0.5,"y":0.8,"w":0.2,"h":0.04},
              {"id":"f3","signer":"s1","type":"text","page":1,"x":0.1,"y":0.2,"w":0.4,"h":0.04,"required":true,"label":"Unit number"},
              {"id":"f4","signer":"s1","type":"checkbox","page":1,"x":0.1,"y":0.3,"w":0.03,"h":0.03,"required":true,"label":"I read the terms"},
              {"id":"f5","signer":"s1","type":"initials","page":1,"x":0.9,"y":1.2,"w":0.08,"h":0.04},
              {"id":"f6","signer":"s2","type":"name","page":2,"x":0.5,"y":0.9,"w":0.3,"h":0.04}]'::jsonb)) as e1 \gset
select pg_temp.ok(status = 'draft' and message = 'Sign when you can' and jsonb_array_length(fields) = 6 and (fields->4->>'y')::numeric <= 0.96 and (fields->4->>'required')::boolean
  and (select count(*) from esign_signers where envelope_id = e.id) = 2 and (select email from esign_signers where envelope_id = e.id and key = 's1') = 'pam@oak.test', 'draft made, fields kept on the page')
  from esign_envelopes e where id = :'e1';
select pg_temp.fails(format($q$ select esign_envelope_update(%L, '{"fields":[{"signer":"nobody","type":"signature","page":1}]}') $q$, :'e1'), 'fields must point at a signer');
select pg_temp.fails(format($q$ select esign_envelope_update(%L, '{"fields":[{"signer":"s1","type":"signature","page":3}]}') $q$, :'e1'), 'fields must be on a real page');
select pg_temp.fails(format($q$ select esign_envelope_update(%L, '{"fields":[{"signer":"s1","type":"stamp","page":1}]}') $q$, :'e1'), 'only known field types');
select pg_temp.fails(format($q$ select esign_envelope_update(%L, '{"signers":[{"name":"X","email":"nope"}]}') $q$, :'e1'), 'signers need a good email');
-- s2 has no signature yet: can't send
select pg_temp.fails(format($q$ select esign_send_prepare(%L) $q$, :'e1'), 'each signer needs a signature field');
select esign_envelope_update(:'e1', jsonb_build_object('fields', (select fields from esign_envelopes where id = :'e1')
  || '[{"id":"f7","signer":"s2","type":"signature","page":2,"x":0.5,"y":0.85,"w":0.3,"h":0.05}]'::jsonb));
select pg_temp.ok((esign_send_prepare(:'e1')->>'file_path') = '77000000-0000-0000-0000-000000000001/u/abc-contract.pdf', 'ready to send');
select pg_temp.fails(format($q$ select esign_send_commit(%L, %L, 'a7000000-0000-0000-0000-000000000001') $q$, :'e1', repeat('a', 64)), 'only the edge function commits a send');
select pg_temp.fails(format($q$ select esign_sign_view((select token from esign_signers limit 1), '{}') $q$), 'signed in staff can''t call the signer functions');
select pg_temp.fails($q$ select token from esign_signers limit 1 $q$, 'staff can''t read link codes');

-- ---------- templates ----------
select esign_template_save(jsonb_build_object('name', 'Lease', 'file_path', :fp, 'file_name', 'lease.pdf', 'pages', '[{"w":612,"h":792}]'::jsonb,
  'roles', '[{"key":"client","label":"Client","order":1},{"key":"rep","label":"Company rep","order":2}]'::jsonb,
  'fields', '[{"signer":"client","type":"signature","page":1,"x":0.1,"y":0.8,"w":0.3,"h":0.05},{"signer":"rep","type":"signature","page":1,"x":0.5,"y":0.8,"w":0.3,"h":0.05},
              {"signer":"client","type":"date","page":1,"x":0.1,"y":0.9,"w":0.2,"h":0.04}]'::jsonb)) as tp \gset
select pg_temp.fails(format($q$ select esign_template_save(jsonb_build_object('id', %L, 'roles', '[{"key":"client","label":""}]'::jsonb)) $q$, :'tp'), 'roles need names');
select pg_temp.fails(format($q$ select esign_envelope_create(jsonb_build_object('template_id', %L, 'signers', '[{"key":"client","name":"Pam","email":"pam@oak.test"}]'::jsonb)) $q$, :'tp'), 'every role needs a person');
select esign_envelope_create(jsonb_build_object('template_id', :'tp', 'company_id', 'a8000000-0000-0000-0000-000000000001',
  'signers', '[{"key":"client","name":"Pam Smith","email":"pam@oak.test"},{"key":"rep","name":"Admin Al","email":"al@signco.test"}]'::jsonb)) as e2 \gset
select pg_temp.ok(source = 'template' and title = 'Lease' and file_path = :fp and jsonb_array_length(fields) = 3 and not ordered
  and (select role_label from esign_signers where envelope_id = e.id and key = 'rep') = 'Company rep', 'send from template fills the people in')
  from esign_envelopes e where id = :'e2';
-- changing a template's roles drops fields for roles that are gone
select esign_template_save(jsonb_build_object('id', :'tp', 'roles', '[{"key":"client","label":"Client"}]'::jsonb));
select pg_temp.ok(jsonb_array_length(fields) = 2 and jsonb_array_length(roles) = 1, 'template roles trimmed with their fields') from esign_templates where id = :'tp';

-- ---------- who sees what ----------
select set_config('test.uid', 'a7000000-0000-0000-0000-000000000002', false);   -- rep: own only
select pg_temp.ok((select count(*) from esign_envelopes) = 0 and (select count(*) from esign_templates) = 1, 'rep sees templates but not someone else''s envelopes');
select esign_envelope_create(jsonb_build_object('file_path', :fp, 'signers', '[{"name":"Bo","email":"bo@x.test"}]'::jsonb,
  'fields', '[{"signer":"s1","type":"signature","page":1,"x":0.1,"y":0.1,"w":0.2,"h":0.05}]'::jsonb, 'pages', '[{"w":612,"h":792}]'::jsonb)) as e3 \gset
select pg_temp.ok((select count(*) from esign_envelopes) = 1, 'rep sees their own');
select pg_temp.fails(format($q$ select esign_envelope_update(%L, '{"title":"x"}') $q$, :'e1'), 'rep can''t change someone else''s');
select pg_temp.fails(format($q$ select esign_template_archive(%L) $q$, :'tp'), 'rep can''t remove the admin''s template');
select set_config('test.uid', 'a7000000-0000-0000-0000-000000000003', false);   -- field worker: off
select pg_temp.ok((select count(*) from esign_envelopes) = 0 and (select count(*) from esign_templates) = 0, 'field worker sees nothing');
select pg_temp.fails(format($q$ select esign_envelope_create(jsonb_build_object('file_path', %L)) $q$, :fp), 'field worker can''t make one');
select pg_temp.fails($q$ insert into storage.objects (bucket_id, name) values ('esign-files', '77000000-0000-0000-0000-000000000001/u/y.pdf') $q$, 'field worker can''t upload');
select set_config('test.uid', 'a7000000-0000-0000-0000-000000000004', false);   -- accounting: view all
select pg_temp.ok((select count(*) from esign_envelopes) = 3, 'accounting sees them all');
select pg_temp.fails(format($q$ select esign_envelope_update(%L, '{"title":"x"}') $q$, :'e1'), 'accounting can''t change them');
select set_config('test.uid', 'a7000000-0000-0000-0000-000000000009', false);   -- another account
select account_settings_save('{"features":{"esign":true}}'::jsonb);
select pg_temp.ok((select count(*) from esign_envelopes) = 0 and (select count(*) from esign_templates) = 0 and (select count(*) from esign_signers) = 0
  and (select count(*) from esign_events) = 0, 'other accounts see nothing');
select pg_temp.fails(format($q$ select esign_send_prepare(%L) $q$, :'e1'), 'other account can''t send ours');
select pg_temp.fails(format($q$ select esign_envelope_create(jsonb_build_object('template_id', %L, 'signers', '[{"key":"client","name":"a","email":"a@b.co"}]'::jsonb)) $q$, :'tp'), 'other account can''t use our template');
select pg_temp.fails(format($q$ select esign_envelope_create(jsonb_build_object('file_path', %L)) $q$, :fp), 'other account can''t use our file');
select pg_temp.fails($q$ select esign_remind('00000000-0000-0000-0000-000000000000') $q$, 'remind needs a real one');
reset role;
select set_config('test.uid', '', false);   -- the edge function: service key, nobody signed in

-- ---------- send (the edge function hashed the file) ----------
-- the client portal is on with a login for Oak Apartments, so it lands in Needs your approval
update account_settings set settings = jsonb_set(settings, '{features,portal}', 'true') where tenant_id = '77000000-0000-0000-0000-000000000001';
insert into private.portal_users (tenant_id, company_id, email, full_name, is_admin) values ('77000000-0000-0000-0000-000000000001', 'a8000000-0000-0000-0000-000000000001', 'pam@oak.test', 'Pam Smith', true);
\set sha '\'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\''
select esign_send_commit(:'e1', :sha, 'a7000000-0000-0000-0000-000000000001') as sent \gset
select pg_temp.ok(jsonb_array_length((:'sent'::jsonb)->'to') = 1 and (:'sent'::jsonb)->'to'->0->>'email' = 'pam@oak.test' and (:'sent'::jsonb)->'mail'->>'account' = 'Sign Co', 'ordered: only the first signer is emailed');
select pg_temp.ok(status = 'sent' and original_sha256 = repeat('a', 64) and expires_at between now() + interval '13 days' and now() + interval '15 days', 'sent and locked') from esign_envelopes where id = :'e1';
select pg_temp.fails(format($q$ select esign_send_commit(%L, %L, null) $q$, :'e1', :sha), 'can''t send twice');
select pg_temp.ok(exists (select 1 from portal_approvals a join esign_envelopes e on e.portal_approval_id = a.id where e.id = :'e1' and a.kind = 'esign' and a.link like '/sign/?t=%' and a.status = 'pending'), 'portal approval links to the signing page');
select pg_temp.ok(exists (select 1 from contact_events where kind = 'esign_sent' and company_id = 'a8000000-0000-0000-0000-000000000001' and data->>'envelope_id' = :'e1'), 'on the organization''s timeline');
select token as t1 from esign_signers where envelope_id = :'e1' and key = 's1' \gset
select token as t2 from esign_signers where envelope_id = :'e1' and key = 's2' \gset

-- ---------- token scoping ----------
select pg_temp.ok(esign_sign_view(repeat('0', 64), '{}') is null and esign_sign_view('short', '{}') is null, 'bad link shows nothing');
select pg_temp.ok((select token from esign_signers where envelope_id = :'e2' limit 1) is not null and esign_sign_view((select token from esign_signers where envelope_id = :'e2' limit 1), '{}') is null, 'a draft''s links don''t open');
select esign_sign_view(:'t1', '{"ip":"203.0.113.5","ua":"Mozilla/5.0 (iPhone)","device":"iPhone","browser":"Safari 17"}') as v1 \gset
select pg_temp.ok((:'v1'::jsonb)->>'state' = 'open' and jsonb_array_length((:'v1'::jsonb)->'fields') = 5 and not ((:'v1'::jsonb)->'fields' @> '[{"signer":"s2"}]')
  and (:'v1'::jsonb)->'signer'->>'email' = 'pam@oak.test' and (:'v1'::jsonb)->'others'->0->>'name' = 'Al Admin' and not ((:'v1'::jsonb)->'others'->0 ? 'email')
  and not ((:'v1'::jsonb)::text like '%' || :'t2' || '%'), 'a signer sees only their own fields and no one else''s link');
select pg_temp.ok(status = 'viewed' and (select status from esign_signers where token = :'t1') = 'viewed', 'viewed') from esign_envelopes where id = :'e1';
select pg_temp.ok(ip = '203.0.113.5' and device = 'iPhone' and browser = 'Safari 17' and name = 'Pam Smith' and email = 'pam@oak.test' and at is not null, 'the view is logged with IP and device')
  from esign_events where envelope_id = :'e1' and kind = 'viewed';

-- ---------- signing order ----------
select pg_temp.ok(esign_sign_view(:'t2', '{}')->>'state' = 'waiting' and jsonb_array_length(esign_sign_view(:'t2', '{}')->'fields') = 0, 'second signer waits their turn');
select pg_temp.fails(format($q$ select esign_sign_consent(%L, '{}') $q$, :'t2'), 'second signer can''t start early');

-- ---------- consent and the code ----------
select pg_temp.fails(format($q$ select esign_sign_code(%L, '{}') $q$, :'t1'), 'code needs consent first');
select esign_sign_consent(:'t1', '{"ip":"203.0.113.5"}');
select pg_temp.fails(format($q$ select esign_sign_code(%L, '{}', 'sms') $q$, :'t1'), 'texting codes not set up yet');
select (esign_sign_code(:'t1', '{"ip":"203.0.113.5"}')->>'code') as c1 \gset
select pg_temp.ok(:'c1' ~ '^\d{6}$', 'six digit code');
select pg_temp.fails(format($q$ select esign_sign_code(%L, '{}') $q$, :'t1'), 'no new code within 30 seconds');
select pg_temp.fails(format($q$ select esign_sign_submit(%L, 'nosession', '{}', 'data:image/png;base64,AAAA', null, 'drawn', '{}') $q$, :'t1'), 'can''t sign before the code');
-- wrong code counts a try
select pg_temp.ok(not (esign_sign_check(:'t1', '000000', '{}')->>'ok')::boolean or :'c1' = '000000', 'wrong code refused');
select pg_temp.ok((select tries from private.esign_codes c join esign_signers s on s.id = c.signer_id where s.token = :'t1' and c.used_at is null) = 1 or :'c1' = '000000', 'try counted');
-- expired code
update private.esign_codes set expires_at = now() - interval '1 second' where signer_id = (select id from esign_signers where token = :'t1');
select pg_temp.ok((esign_sign_check(:'t1', :'c1', '{}')->>'expired')::boolean, 'expired code refused');
-- a new code; five wrong tries locks it even for the right code
update private.esign_codes set created_at = now() - interval '1 minute' where signer_id = (select id from esign_signers where token = :'t1');
select (esign_sign_code(:'t1', '{}')->>'code') as c2 \gset
select esign_sign_check(:'t1', case when :'c2' = '111111' then '222222' else '111111' end, '{}') from generate_series(1, 5);
select pg_temp.ok(not (esign_sign_check(:'t1', :'c2', '{}')->>'ok')::boolean, 'five wrong tries locks the code');
-- the newest code works and replaces the older ones
update private.esign_codes set created_at = now() - interval '1 minute' where signer_id = (select id from esign_signers where token = :'t1');
select (esign_sign_code(:'t1', '{}')->>'code') as c3 \gset
select pg_temp.ok((select count(*) from private.esign_codes c join esign_signers s on s.id = c.signer_id where s.token = :'t1' and c.used_at is null) = 1, 'only the newest code is live');
select (esign_sign_check(:'t1', :'c3', '{"ip":"203.0.113.5"}')->>'session') as sess \gset
select pg_temp.ok(length(:'sess') = 64 and (select otp_verified_at is not null from esign_signers where token = :'t1'), 'code checks out');
select pg_temp.fails(format($q$ select esign_sign_check(%L, %L, '{}') $q$, :'t2', :'c3'), 'a code is only for its signer');
-- five codes an hour
update private.esign_codes set created_at = now() - interval '1 minute' where signer_id = (select id from esign_signers where token = :'t1');
insert into private.esign_codes (signer_id, code_hash, expires_at, used_at, created_at) select id, 'x', now(), now(), now() - interval '5 minutes' from esign_signers, generate_series(1, 4) where token = :'t1';
select pg_temp.fails(format($q$ select esign_sign_code(%L, '{}') $q$, :'t1'), 'five codes an hour');

-- ---------- sign ----------
\set png '\'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==\''
select pg_temp.fails(format($q$ select esign_sign_submit(%L, 'wrong', '{}', %L, %L, 'drawn', '{}') $q$, :'t1', :png, :png), 'needs the signing session');
select pg_temp.fails(format($q$ select esign_sign_submit(%L, %L, '{"f4":true}', %L, %L, 'drawn', '{}') $q$, :'t1', :'sess', :png, :png), 'required text');
select pg_temp.fails(format($q$ select esign_sign_submit(%L, %L, '{"f3":"12B"}', %L, %L, 'drawn', '{}') $q$, :'t1', :'sess', :png, :png), 'required checkbox');
select pg_temp.fails(format($q$ select esign_sign_submit(%L, %L, '{"f3":"12B","f4":true}', null, %L, 'drawn', '{}') $q$, :'t1', :'sess', :png), 'signature needed');
select pg_temp.fails(format($q$ select esign_sign_submit(%L, %L, '{"f3":"12B","f4":true}', 'javascript:x', %L, 'drawn', '{}') $q$, :'t1', :'sess', :png), 'signature must be a PNG');
select esign_sign_submit(:'t1', :'sess', '{"f3":"12B","f4":true,"f2":"01/01/1999"}', :png, :png, 'typed',
  '{"ip":"203.0.113.5","ua":"Mozilla/5.0 (iPhone)","device":"iPhone","browser":"Safari 17"}') as r1 \gset
select pg_temp.ok(not ((:'r1'::jsonb)->>'all_signed')::boolean and (:'r1'::jsonb)->'next'->0->>'email' = 'al@signco.test', 'next signer is emailed');
select pg_temp.ok(status = 'signed' and vals->>'f3' = '12B' and vals->>'f4' = 'true' and vals->>'f2' = to_char(now() at time zone 'America/Chicago', 'MM/DD/YYYY')
  and sign_ip = '203.0.113.5' and sign_device = 'iPhone' and signature_kind = 'typed' and session_hash is null, 'signed: values, date from the server, IP and device')
  from esign_signers where token = :'t1';
select pg_temp.ok(status = 'partly_signed', 'partly signed') from esign_envelopes where id = :'e1';
select pg_temp.ok(esign_sign_view(:'t1', '{}')->>'state' = 'signed' and esign_sign_view(:'t2', '{}')->>'state' = 'open', 'first done, second''s turn');
select pg_temp.fails(format($q$ select esign_sign_consent(%L, '{}') $q$, :'t1'), 'can''t sign twice');
select pg_temp.fails(format($q$ select esign_complete_data(%L) $q$, :'e1'), 'can''t finish before everyone signs');
-- second signer
select esign_sign_consent(:'t2', '{"ip":"198.51.100.7"}');
select (esign_sign_code(:'t2', '{}')->>'code') as c4 \gset
select (esign_sign_check(:'t2', :'c4', '{}')->>'session') as sess2 \gset
select esign_sign_submit(:'t2', :'sess2', '{}', :png, null, 'drawn', '{"ip":"198.51.100.7","device":"Windows computer","browser":"Chrome 120"}') as r2 \gset
select pg_temp.ok(((:'r2'::jsonb)->>'all_signed')::boolean, 'everyone signed');
select pg_temp.ok((select vals->>'f6' from esign_signers where token = :'t2') = 'Al Admin', 'name field filled by the server');

-- ---------- completion ----------
select esign_complete_data(:'e1') as cd \gset
select pg_temp.ok(jsonb_array_length((:'cd'::jsonb)->'signers') = 2 and (:'cd'::jsonb)->'signers'->0->>'ip' = '203.0.113.5' and (:'cd'::jsonb)->'signers'->0->>'consent_at' is not null
  and (:'cd'::jsonb)->'signers'->0->>'verified_at' is not null and (:'cd'::jsonb)->>'original_sha256' = repeat('a', 64)
  and jsonb_array_length((:'cd'::jsonb)->'events') >= 10, 'certificate data');
select pg_temp.fails(format($q$ select esign_finish(%L, '78000000-0000-0000-0000-000000000002/x.pdf', %L) $q$, :'e1', repeat('b', 64)), 'signed copy must be in the account folder');
select esign_finish(:'e1', '77000000-0000-0000-0000-000000000001/' || :'e1' || '/signed-contract.pdf', repeat('b', 64)) as fin \gset
select pg_temp.ok(jsonb_array_length((:'fin'::jsonb)->'to') = 2, 'everyone gets the copy');
select pg_temp.ok(status = 'completed' and final_sha256 = repeat('b', 64) and completed_at is not null, 'completed') from esign_envelopes where id = :'e1';
select pg_temp.ok((select status from portal_approvals where id = (select portal_approval_id from esign_envelopes where id = :'e1')) = 'approved', 'portal approval marked done');
select pg_temp.ok(exists (select 1 from contact_events where kind = 'esign_completed' and data->>'envelope_id' = :'e1'), 'completed on the timeline');
select pg_temp.ok(exists (select 1 from notifications where user_id = 'a7000000-0000-0000-0000-000000000001' and title like 'Signed by everyone%'), 'sender notified');
select pg_temp.fails(format($q$ select esign_finish(%L, '77000000-0000-0000-0000-000000000001/x.pdf', %L) $q$, :'e1', repeat('c', 64)), 'can''t finish twice');
select pg_temp.ok(esign_sign_view(:'t1', '{}')->>'state' = 'completed' and esign_sign_view(:'t1', '{}')->>'final_path' like '%signed-contract.pdf', 'signers can get the signed copy');

-- ---------- the public check ----------
set role anon;
select pg_temp.ok(esign_verify(repeat('b', 64))->0->>'match' = 'signed' and esign_verify(repeat('b', 64))->0->>'title' = 'Service agreement', 'signed copy found by its fingerprint');
select pg_temp.ok(esign_verify(repeat('a', 64))->0->>'match' = 'original' and jsonb_array_length(esign_verify(repeat('d', 64))) = 0 and jsonb_array_length(esign_verify('nope')) = 0, 'original found, unknown not');
select pg_temp.fails(format($q$ select esign_sign_view(%L, '{}') $q$, :'t1'), 'anon can''t call the signer functions directly');
select pg_temp.fails($q$ select * from esign_envelopes $q$, 'anon can''t read envelopes');
reset role;

-- ---------- decline ----------
select esign_send_commit(:'e2', repeat('e', 64), 'a7000000-0000-0000-0000-000000000001') as s2 \gset
select pg_temp.ok(jsonb_array_length((:'s2'::jsonb)->'to') = 2, 'no signing order: everyone at once');
select token as t3 from esign_signers where envelope_id = :'e2' and key = 'client' \gset
select token as t4 from esign_signers where envelope_id = :'e2' and key = 'rep' \gset
select pg_temp.fails(format($q$ select esign_sign_decline(%L, '  ', '{}') $q$, :'t3'), 'decline needs a reason');
select esign_sign_decline(:'t3', 'Wrong unit number', '{"ip":"203.0.113.9"}');
select pg_temp.ok(status = 'declined' and declined_at is not null, 'declined') from esign_envelopes where id = :'e2';
select pg_temp.ok(esign_sign_view(:'t4', '{}')->>'state' = 'declined', 'others see it was declined');
select pg_temp.ok(exists (select 1 from esign_events where envelope_id = :'e2' and kind = 'declined' and detail->>'reason' = 'Wrong unit number' and ip = '203.0.113.9'), 'decline logged');

-- ---------- void, remind ----------
select esign_send_commit(:'e3', repeat('f', 64), 'a7000000-0000-0000-0000-000000000002');
select token as t5 from esign_signers where envelope_id = :'e3' \gset
set role authenticated;
select set_config('test.uid', 'a7000000-0000-0000-0000-000000000002', false);
select pg_temp.fails(format($q$ select esign_remind(%L) $q$, :'e3'), 'remind waits a minute after sending');
reset role;
update esign_signers set last_sent_at = now() - interval '2 minutes' where envelope_id = :'e3';
set role authenticated;
select pg_temp.ok(jsonb_array_length(esign_remind(:'e3')->'to') = 1, 'reminded');
select pg_temp.ok((select reminders from esign_signers where envelope_id = :'e3') = 1, 'reminder counted');
select pg_temp.fails(format($q$ select esign_void(%L, '') $q$, :'e3'), 'void needs a reason');
select pg_temp.fails(format($q$ select esign_envelope_update(%L, '{"title":"x"}') $q$, :'e3'), 'sent ones can''t be edited');
select pg_temp.ok((esign_void(:'e3', 'Sent the wrong file')->>'ok')::boolean, 'rep voids their own');
select pg_temp.ok(status = 'voided' and void_reason = 'Sent the wrong file', 'voided') from esign_envelopes where id = :'e3';
select pg_temp.fails(format($q$ select esign_void(%L, 'again') $q$, :'e3'), 'can''t void twice');
select pg_temp.fails(format($q$ select esign_remind(%L) $q$, :'e3'), 'no reminders on a void one');
select pg_temp.fails(format($q$ select esign_void(%L, 'no') $q$, :'e1'), 'rep can''t void someone else''s (or a completed one)');
select set_config('test.uid', 'a7000000-0000-0000-0000-000000000001', false);
select pg_temp.fails(format($q$ select esign_void(%L, 'no') $q$, :'e1'), 'completed ones can''t be voided');
select pg_temp.ok((select count(*) from esign_events where envelope_id = :'e1') >= 12, 'team can read the event log');
reset role;
select pg_temp.ok(esign_sign_view(:'t5', '{}')->>'state' = 'voided' and esign_sign_view(:'t5', '{}')->>'void_reason' = 'Sent the wrong file', 'signer sees it was voided');
select pg_temp.fails(format($q$ select esign_sign_consent(%L, '{}') $q$, :'t5'), 'void links are dead');

-- ---------- the switch turned off ----------
set role authenticated;
select set_config('test.uid', 'a7000000-0000-0000-0000-000000000001', false);
select account_settings_save('{"features":{"esign":false}}'::jsonb);
select pg_temp.ok((select count(*) from esign_envelopes) = 0, 'off again: nothing shows');
select pg_temp.fails(format($q$ select esign_envelope_create(jsonb_build_object('file_path', %L)) $q$, :fp), 'off again: can''t make one');
reset role;
select 'esign tests passed' as ok;
