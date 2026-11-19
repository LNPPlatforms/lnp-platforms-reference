-- courier_isolation.test.sql
-- Run with psql (it uses \gset):   psql -v ON_ERROR_STOP=1 -d <db> -f tests/courier_isolation.test.sql
-- Everything runs in one transaction and is rolled back at the end. A failed assertion aborts.
--
-- FIXTURES: the block below seeds tenants/users for the local stand-in schema
-- (tests/harness/stub_schema.sql). On your real database REPLACE the fixture block with your
-- own seeding (or existing test accounts) and keep the assertions.
\set ON_ERROR_STOP on
begin;

create schema test;
grant usage on schema test to authenticated;
create function test.as_user(p uuid) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end $$;
create function test.as_super() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', true); end $$;
create function test.ok(c boolean, msg text) returns void language plpgsql as $$
begin
  if c is not true then raise exception 'FAIL: %', msg; end if;
  raise notice 'PASS: %', msg;
end $$;
create function test.throws(q text, msg text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then raise notice 'PASS: % [%]', msg, sqlerrm; return; end;
  raise exception 'FAIL (no error raised): %', msg;
end $$;

-- ------------------------------------------------------------------ fixtures
-- A = contractor account (managed by agency G)   B = courier company
-- C = unrelated account                          G = agency
\set TA 'a0000000-0000-0000-0000-000000000001'
\set TB 'b0000000-0000-0000-0000-000000000001'
\set TC 'c0000000-0000-0000-0000-000000000001'
\set TG '90000000-0000-0000-0000-000000000001'
\set UA_ADMIN   'a1000000-0000-0000-0000-000000000001'
\set UA_STAFF   'a2000000-0000-0000-0000-000000000001'
\set UA_PORTAL  'a9000000-0000-0000-0000-000000000001'
\set UB_ADMIN   'b1000000-0000-0000-0000-000000000001'
\set UB_COURIER 'b2000000-0000-0000-0000-000000000001'
\set UB_COUR2   'b3000000-0000-0000-0000-000000000001'
\set UC_ADMIN   'c1000000-0000-0000-0000-000000000001'
\set UG_ADMIN   '91000000-0000-0000-0000-000000000001'

insert into public.tenants (id, name) values (:'TG', 'Agency G');
insert into public.tenants (id, name, agency_tenant_id) values
  (:'TA', 'Contractor A', :'TG'), (:'TB', 'Courier Co B', null), (:'TC', 'Other C', null);
insert into public.app_users (id, tenant_id, is_admin, is_portal) values
  (:'UA_ADMIN', :'TA', true,  false), (:'UA_STAFF', :'TA', false, false), (:'UA_PORTAL', :'TA', false, true),
  (:'UB_ADMIN', :'TB', true,  false), (:'UB_COURIER', :'TB', false, false), (:'UB_COUR2', :'TB', false, false),
  (:'UC_ADMIN', :'TC', true,  false), (:'UG_ADMIN', :'TG', true,  false);
insert into public.tenant_features (tenant_id, feature)
  select t, 'courier_marketplace' from unnest(array[:'TA', :'TB', :'TC', :'TG']::uuid[]) t;

-- ------------------------------------------------------------ 1. build a campaign (A admin)
select test.as_user(:'UA_ADMIN');
select public.dh_campaign_save(jsonb_build_object(
  'title','Storm Oak Hill','trade','roofing','pay_per_drop_cents',100,'storm_event_date','2026-11-10')) as c1 \gset
select public.dh_addresses_add(:'c1'::uuid, (
  select jsonb_agg(jsonb_build_object('line1', i||' Oak St','city','Baltimore','zip','21201',
         'lat', 39.29 + (i/5)*0.0009, 'lng', -76.61 + (i%5)*0.0012)) from generate_series(1,25) i)) as n_added \gset
select public.dh_addresses_add(:'c1'::uuid,
  '[{"line1":"99 No Soliciting Ln","city":"Baltimore","zip":"21201","lat":39.2905,"lng":-76.6105,"no_solicit":true}]'::jsonb);
select public.dh_zones_build(:'c1'::uuid, 10) as n_zones \gset
select test.ok(:n_added = 25, '25 addresses imported');
select test.ok(:n_zones = 3, '25 doors at 10/zone -> 3 zones');
select test.ok((select count(*) from public.dh_addresses where campaign_id = :'c1' and zone_id is null) = 1,
               'the no-solicit address is excluded from every zone');
select public.dh_campaign_publish(:'c1'::uuid, 'network', 4.5);
select test.ok((select status from public.dh_campaigns where id = :'c1') = 'open', 'campaign is open');
select test.throws($$ select public.dh_campaign_publish('$$ || :'c1' || $$'::uuid) $$, 'cannot publish twice');

select test.as_super();
select id as z1 from public.dh_zones where campaign_id = :'c1' order by seq limit 1 offset 0 \gset
select id as z2 from public.dh_zones where campaign_id = :'c1' order by seq limit 1 offset 1 \gset
select id as z3 from public.dh_zones where campaign_id = :'c1' order by seq limit 1 offset 2 \gset

-- ------------------------------------------------------------ 2. same-account least privilege
select test.as_user(:'UA_STAFF');
select test.ok((select count(*) from public.dh_campaigns) = 1, 'non-admin staff can see campaigns');
select test.ok((select count(*) from public.dh_addresses) = 0, 'non-admin staff cannot see addresses');
select test.throws($$ select public.dh_campaign_save('{"title":"x","pay_per_drop_cents":100}'::jsonb) $$,
                   'non-admin cannot create campaigns');
select test.as_user(:'UA_PORTAL');
select test.ok((select count(*) from public.dh_campaigns) = 0, 'portal user sees nothing');

-- ------------------------------------------------------------ 3. outsiders see nothing
select test.as_user(:'UC_ADMIN');
select test.ok((select count(*) from public.dh_campaigns) = 0 and (select count(*) from public.dh_zones) = 0
           and (select count(*) from public.dh_addresses) = 0 and (select count(*) from public.dh_listings) = 0
           and (select count(*) from public.network_jobs) = 0, 'unrelated account sees nothing');
select test.as_user(:'UB_COURIER');
select test.ok((select count(*) from public.network_jobs) = 0, 'no share yet -> no network jobs');
select test.ok((select count(*) from public.dh_claimable_zones(:'c1'::uuid)) = 0, 'no share yet -> no claimable zones');

-- ------------------------------------------------------------ 4. share handshake
select test.as_user(:'UA_ADMIN');
select public.dh_share_grant(:'TB'::uuid, 'job_board', 500);
select test.as_user(:'UB_COURIER');
select test.ok((select count(*) from public.network_jobs) = 0, 'pending share grants nothing');
select test.throws($$ select public.dh_share_accept('$$ || :'TA' || $$'::uuid, 'job_board') $$, 'non-admin cannot accept a share');
select test.as_user(:'UC_ADMIN');
select test.throws($$ select public.dh_share_accept('$$ || :'TA' || $$'::uuid, 'job_board') $$, 'non-grantee cannot accept a share');
select test.as_user(:'UB_ADMIN');
select public.dh_share_accept(:'TA'::uuid, 'job_board');
select test.as_user(:'UB_COURIER');
select test.ok((select count(*) from public.network_jobs where owner_tenant_id = :'TA' and open_zones = 3) = 1,
               'active share -> curated network job visible');
select test.ok((select count(*) from public.dh_campaigns) = 0, 'courier still cannot read the other account''s campaigns table');
select test.ok((select count(*) from public.dh_addresses) = 0, 'courier cannot see addresses before claiming');
select test.ok((select count(*) from public.dh_claimable_zones(:'c1'::uuid)) = 3, 'three claimable zones');

-- ------------------------------------------------------------ 5. claiming
select test.throws($$ select public.dh_claim_zone('$$ || :'z1' || $$'::uuid) $$, 'no courier profile -> cannot claim');
select test.as_user(:'UB_ADMIN');
select public.dh_courier_enroll(:'UB_COURIER'::uuid);
select public.dh_courier_enroll(:'UB_COUR2'::uuid);
select test.throws($$ select public.dh_courier_enroll('$$ || :'UC_ADMIN' || $$'::uuid) $$, 'cannot enroll someone outside the account');
select test.as_user(:'UB_COURIER');
select test.ok(public.dh_claim_zone(:'z1'::uuid), 'courier B claims zone 1 of account A''s job');
select test.ok(not public.dh_claim_zone(:'z1'::uuid), 'zone cannot be claimed twice');
select test.as_user(:'UB_COUR2');
select test.ok(not public.dh_claim_zone(:'z1'::uuid), 'second courier loses the race');
select test.as_super();
update public.courier_profiles set rating = 3.0 where user_id = :'UB_COUR2';
select test.as_user(:'UB_COUR2');
select test.throws($$ select public.dh_claim_zone('$$ || :'z2' || $$'::uuid) $$, 'rating below minimum cannot claim');

-- ------------------------------------------------------------ 6. assigned-courier access
select test.as_user(:'UB_COURIER');
select test.ok((select count(*) from public.dh_zone_addresses(:'z1'::uuid)) > 0, 'courier sees addresses of own zone');
select test.ok((select count(*) from public.dh_zone_addresses(:'z2'::uuid)) = 0, 'courier sees nothing of other zones');
select test.ok((select count(*) from public.dh_addresses) = (select count(*) from public.dh_zone_addresses(:'z1'::uuid)),
               'RLS exposes exactly the assigned zone''s addresses');
select test.ok((select count(*) from public.dh_zones) = 1, 'courier sees only their own zone row');
select test.as_user(:'UB_COUR2');
select test.ok((select count(*) from public.dh_addresses) = 0, 'other courier sees no addresses');

-- ------------------------------------------------------------ 7. submitting drops
select test.as_super();
select id as a1, st_y(location::geometry) as a1lat, st_x(location::geometry) as a1lng from public.dh_addresses where zone_id = :'z1' order by line1 limit 1 offset 0 \gset
select id as a2, st_y(location::geometry) as a2lat, st_x(location::geometry) as a2lng from public.dh_addresses where zone_id = :'z1' order by line1 limit 1 offset 1 \gset
select id as a3, st_y(location::geometry) as a3lat, st_x(location::geometry) as a3lng from public.dh_addresses where zone_id = :'z1' order by line1 limit 1 offset 2 \gset
select id as ax from public.dh_addresses where zone_id = :'z2' limit 1 \gset
select test.as_user(:'UB_COURIER');
select public.dh_submit_drops(jsonb_build_array(
  jsonb_build_object('client_drop_id','f0000000-0000-0000-0000-000000000001','address_id',:'a1','lat',:a1lat,'lng',:a1lng,
     'accuracy_m',8,'captured_at',now() - interval '10 minutes',
     'photo_key','t/'||:'TA'||'/'||:'z1'||'/f0000000-0000-0000-0000-000000000001.jpg'),
  jsonb_build_object('client_drop_id','f0000000-0000-0000-0000-000000000002','address_id',:'a2','lat',:a2lat + 0.003,'lng',:a2lng,
     'accuracy_m',8,'captured_at',now() - interval '9 minutes',
     'photo_key','t/'||:'TA'||'/'||:'z1'||'/f0000000-0000-0000-0000-000000000002.jpg'),
  jsonb_build_object('client_drop_id','f0000000-0000-0000-0000-000000000003','address_id',:'a3','lat',:a3lat,'lng',:a3lng,
     'accuracy_m',8,'captured_at',now() - interval '5 minutes',
     'photo_key','t/'||:'TA'||'/'||:'z1'||'/f0000000-0000-0000-0000-000000000003.jpg'),
  jsonb_build_object('client_drop_id','f0000000-0000-0000-0000-000000000004','address_id',:'ax','lat',:a1lat,'lng',:a1lng,
     'accuracy_m',8,'captured_at',now() - interval '4 minutes',
     'photo_key','t/'||:'TA'||'/'||:'z1'||'/f0000000-0000-0000-0000-000000000004.jpg'),
  jsonb_build_object('client_drop_id','f0000000-0000-0000-0000-000000000005','address_id',:'a3','lat',:a3lat,'lng',:a3lng,
     'accuracy_m',8,'captured_at',now() - interval '3 minutes',
     'photo_key','t/'||:'TB'||'/'||:'z1'||'/f0000000-0000-0000-0000-000000000005.jpg')
)) as res \gset
select test.ok((:'res'::jsonb)->0->>'status' = 'verified', 'good drop -> verified');
select test.ok((:'res'::jsonb)->1->>'status' = 'flagged'
           and (:'res'::jsonb)->1->'flags' ? 'out_of_range'
           and (:'res'::jsonb)->1->'flags' ? 'impossible_speed', 'far + too-fast drop -> flagged (out_of_range, impossible_speed)');
select test.ok((:'res'::jsonb)->2->>'status' = 'verified', 'later good drop -> verified');
select test.ok((:'res'::jsonb)->3->>'error' = 'not_assigned', 'address in someone else''s zone -> not_assigned');
select test.ok((:'res'::jsonb)->4->>'error' = 'bad_photo_key', 'photo key under the wrong account folder is rejected');

select public.dh_submit_drops(jsonb_build_array(
  jsonb_build_object('client_drop_id','f0000000-0000-0000-0000-000000000001','address_id',:'a1','lat',:a1lat,'lng',:a1lng,
     'accuracy_m',8,'captured_at',now(),'photo_key','t/'||:'TA'||'/'||:'z1'||'/f0000000-0000-0000-0000-000000000001.jpg'),
  jsonb_build_object('client_drop_id','f0000000-0000-0000-0000-000000000009','address_id',:'a1','lat',:a1lat,'lng',:a1lng,
     'accuracy_m',8,'captured_at',now() - interval '2 minutes',
     'photo_key','t/'||:'TA'||'/'||:'z1'||'/f0000000-0000-0000-0000-000000000009.jpg')
)) as res2 \gset
select test.ok((:'res2'::jsonb)->0->>'duplicate' = 'true', 'replaying a client_drop_id is idempotent');
select test.ok((:'res2'::jsonb)->1->>'error' = 'address_already_done', 'second hang record for the same door is refused');
select test.ok((select count(*) from public.dh_drops) = 3, 'courier sees exactly their 3 stored drops');
select test.as_user(:'UB_COUR2');
select test.ok((select count(*) from public.dh_drops) = 0, 'other courier sees none of those drops');
select test.as_user(:'UA_ADMIN');
select test.ok((select count(*) from public.dh_drops) = 3 and (select min(tenant_id::text) from public.dh_drops) = :'TA',
               'owner admin sees the drops, stored under the OWNER''s tenant_id');
select test.as_user(:'UA_STAFF');
select test.ok((select count(*) from public.dh_drops) = 0, 'non-admin staff cannot see drops');

-- ------------------------------------------------------------ 8. direct writes are impossible
select test.as_user(:'UB_COURIER');
select test.throws($$ insert into public.dh_drops (tenant_id, client_drop_id, campaign_id, zone_id, address_id, courier_id, captured_at)
                      values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), now()) $$,
                   'direct INSERT into dh_drops is denied');
select test.throws($$ update public.dh_zones set status = 'approved' $$, 'direct UPDATE of dh_zones is denied');
select test.throws($$ select public.dh_zone_submit('$$ || :'z2' || $$'::uuid) $$, 'cannot submit a zone that is not yours');
select test.as_user(:'UA_ADMIN');
select test.throws($$ delete from public.dh_campaigns $$, 'direct DELETE of campaigns is denied even for admins');
select test.throws($$ update public.dh_campaigns set status = 'paid' $$, 'direct UPDATE of campaigns is denied even for admins');

-- ------------------------------------------------------------ 9. storage policies
select test.as_user(:'UB_COURIER');
insert into storage.objects (bucket_id, name)
  values ('drop-photos', 't/' || :'TA' || '/' || :'z1' || '/f0000000-0000-0000-0000-0000000000aa.jpg');
select test.throws($$ insert into storage.objects (bucket_id, name) values ('drop-photos',
  't/$$ || :'TA' || $$/$$ || :'z2' || $$/x.jpg') $$, 'upload into an unassigned zone is denied');
select test.throws($$ insert into storage.objects (bucket_id, name) values ('drop-photos',
  't/$$ || :'TB' || $$/$$ || :'z1' || $$/x.jpg') $$, 'upload under the wrong account folder is denied');
select test.throws($$ insert into storage.objects (bucket_id, name) values ('drop-photos', 'not/a/path.jpg') $$, 'malformed path is denied');
select test.ok((select count(*) from storage.objects) = 0, 'courier cannot read photos back');
select test.as_user(:'UA_ADMIN');
select test.ok((select count(*) from storage.objects) = 1, 'owner admin can read the evidence photo');
select test.as_user(:'UC_ADMIN');
select test.ok((select count(*) from storage.objects) = 0, 'unrelated admin cannot read it');

-- ------------------------------------------------------------ 10. review + lifecycle
select test.as_user(:'UA_ADMIN');
select id as flagged_id from public.dh_drops where status = 'flagged' \gset
select public.dh_review_drop(:'flagged_id'::uuid, 'reject', 'pin is 300 m away');
select test.ok((select status from public.dh_drops where id = :'flagged_id') = 'rejected', 'contractor rejects the flagged drop');
select test.as_user(:'UB_COURIER');
select public.dh_submit_drops(jsonb_build_array(
  jsonb_build_object('client_drop_id','f0000000-0000-0000-0000-00000000000b','address_id',:'a2','lat',:a2lat,'lng',:a2lng,
     'accuracy_m',8,'captured_at',now() - interval '2 minutes',
     'photo_key','t/'||:'TA'||'/'||:'z1'||'/f0000000-0000-0000-0000-00000000000b.jpg'))) as res3 \gset
select test.ok((:'res3'::jsonb)->0->>'status' = 'verified', 'a rejected door can be re-hung');
select public.dh_zone_submit(:'z1'::uuid);
select test.as_user(:'UA_ADMIN');
select test.throws($$ select public.dh_campaign_approve('$$ || :'c1' || $$'::uuid) $$, 'campaign with unclaimed zones is not submittable/approvable');

-- ------------------------------------------------------------ 11. share revocation
select public.dh_share_revoke(:'TA'::uuid, :'TB'::uuid, 'job_board');
select test.as_user(:'UB_COURIER');
select test.ok((select count(*) from public.network_jobs) = 0, 'revoked share hides the job board');
select test.ok(not public.dh_claim_zone(:'z3'::uuid), 'revoked share blocks new claims');
select test.ok((select count(*) from public.dh_zones) = 1, 'revoking the share does not strip a courier of a zone they already hold');

-- ------------------------------------------------------------ 12. same-account full lifecycle
select test.as_user(:'UA_ADMIN');
select public.dh_courier_enroll(:'UA_STAFF'::uuid);
select public.dh_campaign_save('{"title":"Own crew run","pay_per_drop_cents":150}'::jsonb) as c2 \gset
select public.dh_addresses_add(:'c2'::uuid, (
  select jsonb_agg(jsonb_build_object('line1', i||' Elm St','city','Baltimore','zip','21202',
         'lat', 39.30 + (i/4)*0.0009, 'lng', -76.62 + (i%4)*0.0012)) from generate_series(1,12) i));
select public.dh_zones_build(:'c2'::uuid, 50) as n_zones2 \gset
select test.ok(:n_zones2 = 1, 'small campaign -> single zone');
select public.dh_campaign_publish(:'c2'::uuid, 'private');
select test.as_super();
select id as zz from public.dh_zones where campaign_id = :'c2' \gset
select id as e1, st_y(location::geometry) as e1lat, st_x(location::geometry) as e1lng from public.dh_addresses where zone_id = :'zz' order by line1 limit 1 offset 0 \gset
select id as e2, st_y(location::geometry) as e2lat, st_x(location::geometry) as e2lng from public.dh_addresses where zone_id = :'zz' order by line1 limit 1 offset 1 \gset
select test.as_user(:'UA_STAFF');
select test.ok(public.dh_claim_zone(:'zz'::uuid), 'own-account courier claims own campaign zone');
select public.dh_submit_drops(jsonb_build_array(
  jsonb_build_object('client_drop_id','e0000000-0000-0000-0000-000000000001','address_id',:'e1','lat',:e1lat,'lng',:e1lng,
     'accuracy_m',6,'captured_at',now() - interval '20 minutes',
     'photo_key','t/'||:'TA'||'/'||:'zz'||'/e0000000-0000-0000-0000-000000000001.jpg'),
  jsonb_build_object('client_drop_id','e0000000-0000-0000-0000-000000000002','address_id',:'e2','lat',:e2lat,'lng',:e2lng,
     'accuracy_m',90,'captured_at',now() - interval '15 minutes',
     'photo_key','t/'||:'TA'||'/'||:'zz'||'/e0000000-0000-0000-0000-000000000002.jpg'))) as res4 \gset
select test.ok((:'res4'::jsonb)->1->'flags' ? 'low_gps_accuracy', 'poor GPS accuracy is flagged');
select public.dh_zone_submit(:'zz'::uuid);
select test.as_user(:'UA_ADMIN');
select test.ok((select status from public.dh_campaigns where id = :'c2') = 'submitted', 'campaign is submitted once all zones are');
select test.throws($$ select public.dh_campaign_approve('$$ || :'c2' || $$'::uuid) $$, 'approval blocked while a drop is flagged');
select id as fl from public.dh_drops where campaign_id = :'c2' and status = 'flagged' \gset
select public.dh_review_drop(:'fl'::uuid, 'approve', 'accepted: tall trees, weak GPS');
select public.dh_campaign_approve(:'c2'::uuid);
select test.ok((select status from public.dh_campaigns where id = :'c2') = 'approved'
           and (select count(*) from public.dh_drops where campaign_id = :'c2' and status = 'approved') = 2, 'campaign approved with both drops approved');

-- ------------------------------------------------------------ 13. account switching cannot grant access by itself
select test.as_user(:'UC_ADMIN');
select public.set_acting_tenant(:'TA'::uuid);
select test.ok((select count(*) from public.dh_campaigns) = 0, 'unrelated user "switching" into A still sees nothing');
select test.as_user(:'UG_ADMIN');
select public.set_acting_tenant(:'TA'::uuid);
select test.ok((select count(*) from public.dh_campaigns) = 2, 'agency user switched into a managed account sees its campaigns');

-- ------------------------------------------------------------ 14. guardrail triggers
select test.as_super();
select test.throws($$ update public.dh_campaigns set tenant_id = '$$ || :'TB' || $$' $$, 'tenant_id is immutable (even for superuser sessions)');
insert into public.dh_ledger (tenant_id, type, amount_cents) values (:'TA', 'escrow_in', 10000);
select test.throws($$ update public.dh_ledger set amount_cents = 1 $$, 'ledger rows cannot be updated');
select test.throws($$ delete from public.dh_ledger $$, 'ledger rows cannot be deleted');
select test.as_user(:'UA_ADMIN');
select test.ok((select count(*) from public.dh_ledger) = 1, 'owner admin can read the ledger');
select test.as_user(:'UB_ADMIN');
select test.ok((select count(*) from public.dh_ledger) = 0, 'other account cannot read the ledger');

-- ------------------------------------------------------------ 15. sweep: nothing outside my tenant, per bundle table
select test.as_user(:'UC_ADMIN');
do $$
declare r record; n bigint; bad text := '';
begin
  for r in select unnest(array['courier_profiles','dh_campaigns','dh_listings','dh_zones','dh_addresses',
                               'dh_drops','dh_ledger','tenant_shares']) as t loop
    execute format('select count(*) from public.%I', r.t) into n;
    if n > 0 then bad := bad || r.t || '(' || n || ') '; end if;
  end loop;
  if bad <> '' then raise exception 'FAIL: unrelated account can see rows in: %', bad; end if;
  raise notice 'PASS: sweep - unrelated account sees zero rows in every courier table';
end $$;

select test.as_super();
rollback;
\echo ALL COURIER ISOLATION TESTS PASSED
