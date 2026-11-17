-- 092: internal chat follows you across accounts. Run with tests/run_db.sh tests/chat_across_test.sql
\set ON_ERROR_STOP 1

alter table app_users add column if not exists hidden_in_team boolean not null default false, add column if not exists created_at timestamptz not null default now();
create table if not exists team_rooms (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, kind text not null, name text, dm_key text, created_by uuid, created_at timestamptz not null default now(), last_message_at timestamptz);
create unique index if not exists team_rooms_one_team on team_rooms (tenant_id) where kind = 'team';
create table if not exists team_room_members (room_id uuid not null, user_id uuid not null, added_by uuid, added_at timestamptz not null default now(), left_at timestamptz, last_read_at timestamptz, primary key (room_id, user_id));
create table if not exists team_messages (id uuid primary key default gen_random_uuid(), tenant_id uuid not null, room_id uuid not null, sender_id uuid not null, body text not null, picture_path text, recalled_at timestamptz, created_at timestamptz not null default now());
create or replace function private.team_room_for_account() returns uuid language plpgsql security definer set search_path = public, private as $$
declare r uuid; t uuid := private.current_tenant();
begin
  select id into r from team_rooms where tenant_id = t and kind = 'team';
  if r is null then insert into team_rooms (tenant_id, kind, name) values (t, 'team', 'Whole team') returning id into r; end if;
  return r;
end $$;
\i schema/092_chat_follows_you.sql
insert into tenants (id, name, slug, is_agency, agency_tenant_id) values
  ('a2000000-0000-0000-0000-000000000001', 'GELP Strategies', 'gelp-c', true, null),
  ('a2000000-0000-0000-0000-000000000002', 'Essential', 'ess-c', false, 'a2000000-0000-0000-0000-000000000001'),
  ('a2000000-0000-0000-0000-000000000003', 'Stranger Co', 'str-c', false, null);
insert into white_labels (agency_tenant_id, name, short_name) values ('a2000000-0000-0000-0000-000000000001', 'GELP CRM', 'GELP');
insert into app_users (id, full_name, email, tenant_id, is_admin, active, role) values
  ('b2000000-0000-0000-0000-000000000001', 'Chris Vickrey', 'chris@g.com', 'a2000000-0000-0000-0000-000000000001', true, true, 'staff'),
  ('b2000000-0000-0000-0000-000000000002', 'Julie Olivari', 'julie@g.com', 'a2000000-0000-0000-0000-000000000001', true, true, 'staff'),
  ('b2000000-0000-0000-0000-000000000003', 'Essie Owner', 'e@e.com', 'a2000000-0000-0000-0000-000000000002', true, true, 'staff'),
  ('b2000000-0000-0000-0000-000000000004', 'Stan Stranger', 's@s.com', 'a2000000-0000-0000-0000-000000000003', true, true, 'staff');
insert into private.platform_owners (user_id) values ('b2000000-0000-0000-0000-000000000001');
-- GELP rooms: whole team with a message, and a DM between Julie and Chris
insert into team_rooms (id, tenant_id, kind, name, last_message_at) values ('f2000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'team', 'Whole team', now());
insert into team_rooms (id, tenant_id, kind, dm_key, last_message_at) values ('f2000000-0000-0000-0000-000000000002', 'a2000000-0000-0000-0000-000000000001', 'dm', 'x', now());
insert into team_room_members (room_id, user_id) values ('f2000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000001'), ('f2000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000002');
insert into team_messages (tenant_id, room_id, sender_id, body, created_at) values
  ('a2000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000002', 'Team hello', now()),
  ('a2000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000002', 'Chris, call me', now());
grant select on tenants to authenticated;
grant execute on all functions in schema private, public to authenticated;
set role authenticated;
-- Chris switches into Essential: GELP's rooms still show, labeled, with unread counts
select set_config('test.uid', 'b2000000-0000-0000-0000-000000000001', false);
select public.set_acting_tenant('a2000000-0000-0000-0000-000000000002') is not null as switched;
do $$ declare j jsonb := public.team_rooms_list(); dm jsonb; tm jsonb; begin
  select x into dm from jsonb_array_elements(j) x where x->>'id' = 'f2000000-0000-0000-0000-000000000002';
  select x into tm from jsonb_array_elements(j) x where x->>'id' = 'f2000000-0000-0000-0000-000000000001';
  if dm is null or tm is null then raise exception 'GELP rooms missing while in Essential: %', j; end if;
  if dm->>'account' <> 'GELP' or (dm->>'unread')::int <> 1 or dm->'people'->>'b2000000-0000-0000-0000-000000000002' <> 'Julie Olivari' then raise exception 'DM label or unread wrong: %', dm; end if;
  if tm->>'account' <> 'GELP' or (tm->>'here')::boolean then raise exception 'team room label wrong: %', tm; end if;
  if not exists (select 1 from jsonb_array_elements(j) x where (x->>'here')::boolean and x->>'kind' = 'team') then raise exception 'Essential''s own team room should be there too'; end if;
  if public.team_unread() <> 2 then raise exception 'unread should count both GELP messages, got %', public.team_unread(); end if;
end $$;
-- Essential's owner doesn't see GELP's rooms; a stranger doesn't either
select set_config('test.uid', 'b2000000-0000-0000-0000-000000000003', false);
do $$ begin
  if exists (select 1 from jsonb_array_elements(public.team_rooms_list()) x where x->>'tenant_id' = 'a2000000-0000-0000-0000-000000000001') then raise exception 'client sees agency rooms'; end if;
  if private.team_can_see('f2000000-0000-0000-0000-000000000001') then raise exception 'client can read agency team room'; end if;
end $$;
select set_config('test.uid', 'b2000000-0000-0000-0000-000000000004', false);
do $$ begin if private.team_can_see('f2000000-0000-0000-0000-000000000002') then raise exception 'stranger can read the DM'; end if; end $$;
select 'chat across accounts: all good';
