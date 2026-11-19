-- 201_courier_core.sql
-- Tables for the door-hanger courier module. Prefixed dh_ so nothing collides with
-- your existing jobs / routes / pay / media objects.
--
-- Follows your conventions:
--   * tenant_id on every table, defaulting to private.current_tenant()
--   * RLS enabled AND forced
--   * policies are SELECT-only and use  private.current_tenant() + feature gate
--   * all writes happen in SECURITY DEFINER functions (203) that re-check
--     feature, admin and tenant themselves, like phone_line_save
-- Extra hardening, new tables only: composite (tenant_id, id) foreign keys so a child
-- row can never point at another account's parent, and an append-only ledger.

create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------------
-- Couriers: a person enrolled as a courier in an account
-- ---------------------------------------------------------------------------
create table public.courier_profiles (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default private.current_tenant() references public.tenants(id),
  user_id          uuid not null references public.app_users(id),
  home_location    geography(Point, 4326),
  service_radius_m int  not null default 16000 check (service_radius_m between 500 and 200000),
  rating           numeric(3,2) not null default 5.00 check (rating between 0 and 5),
  jobs_completed   int  not null default 0,
  status           text not null default 'pending' check (status in ('pending','active','suspended')),
  verified_at      timestamptz,
  created_at       timestamptz not null default now(),
  unique (tenant_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Campaigns (one storm / one door-hanger run). crm_job_id optionally links to your
-- existing Jobs record; no FK because its id type isn't known here (see OPEN_ITEMS).
-- ---------------------------------------------------------------------------
create table public.dh_campaigns (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default private.current_tenant() references public.tenants(id),
  title              text not null,
  trade              text,
  storm_event_date   date,
  target_area        geometry(Polygon, 4326),
  pay_per_drop_cents int  not null check (pay_per_drop_cents between 25 and 5000),
  platform_fee_bps   int  not null default 1500 check (platform_fee_bps between 0 and 5000),
  geofence_radius_m  int  not null default 40  check (geofence_radius_m between 10 and 500),
  max_gps_accuracy_m int  not null default 30  check (max_gps_accuracy_m between 5 and 200),
  status             text not null default 'draft' check (status in
    ('draft','funded','open','in_progress','submitted','approved','disputed','paid','closed','cancelled')),
  crm_job_id         uuid,
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.dh_listings (
  campaign_id    uuid primary key,
  tenant_id      uuid not null default private.current_tenant(),
  visibility     text not null default 'private' check (visibility in ('private','network')),
  min_rating     numeric(3,2) not null default 0 check (min_rating between 0 and 5),
  claim_deadline timestamptz,
  foreign key (tenant_id, campaign_id) references public.dh_campaigns (tenant_id, id) on delete cascade
);

create table public.dh_zones (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default private.current_tenant(),
  campaign_id        uuid not null,
  seq                int  not null,
  polygon            geometry(Polygon, 4326),
  door_count         int  not null default 0,
  courier_id         uuid references public.app_users(id),
  claimed_via_tenant uuid references public.tenants(id),
  claimed_at         timestamptz,
  status             text not null default 'open' check (status in
    ('open','claimed','in_progress','submitted','approved')),
  unique (tenant_id, id),
  unique (campaign_id, seq),
  foreign key (tenant_id, campaign_id) references public.dh_campaigns (tenant_id, id) on delete cascade
);
create index dh_zones_campaign_idx on public.dh_zones (tenant_id, campaign_id);
create index dh_zones_courier_idx  on public.dh_zones (courier_id) where courier_id is not null;

create table public.dh_addresses (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default private.current_tenant(),
  campaign_id uuid not null,
  zone_id     uuid,
  cluster_no  int,
  line1       text not null,
  city        text,
  zip         text,
  location    geography(Point, 4326) not null,
  no_solicit  boolean not null default false,
  unique (tenant_id, id),
  foreign key (tenant_id, campaign_id) references public.dh_campaigns (tenant_id, id) on delete cascade,
  foreign key (tenant_id, zone_id)     references public.dh_zones (tenant_id, id)
);
create index dh_addresses_loc_idx      on public.dh_addresses using gist (location);
create index dh_addresses_zone_idx     on public.dh_addresses (zone_id);
create index dh_addresses_campaign_idx on public.dh_addresses (tenant_id, campaign_id);
create unique index dh_addresses_dedupe on public.dh_addresses (campaign_id, lower(line1), coalesce(zip, ''));

create table public.dh_drops (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,                 -- always the CAMPAIGN OWNER's account
  client_drop_id       uuid not null unique,          -- idempotency key from the device
  campaign_id          uuid not null,
  zone_id              uuid not null,
  address_id           uuid not null,
  courier_id           uuid not null references public.app_users(id),
  outcome              text not null default 'hung' check (outcome in ('hung','skipped')),
  skip_reason          text,
  captured_at          timestamptz not null,
  received_at          timestamptz not null default now(),
  location             geography(Point, 4326),
  accuracy_m           numeric,
  distance_to_target_m numeric,
  photo_key            text,
  status               text not null default 'pending' check (status in
    ('pending','verified','flagged','rejected','approved')),
  flags                text[] not null default '{}',
  device_id            text,
  clock_offset_ms      bigint,
  reviewed_by          uuid,
  reviewed_at          timestamptz,
  review_note          text,
  foreign key (tenant_id, campaign_id) references public.dh_campaigns (tenant_id, id),
  foreign key (tenant_id, zone_id)     references public.dh_zones (tenant_id, id),
  foreign key (tenant_id, address_id)  references public.dh_addresses (tenant_id, id)
);
create index dh_drops_campaign_idx on public.dh_drops (tenant_id, campaign_id, status);
create index dh_drops_courier_idx  on public.dh_drops (courier_id, captured_at);
-- One live (non-rejected) "hung" record per address: no double pay for the same door.
create unique index dh_drops_one_per_address on public.dh_drops (address_id)
  where outcome = 'hung' and status <> 'rejected';

-- Append-only money ledger. Rows are only ever inserted by definer functions (payments phase).
create table public.dh_ledger (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null,                          -- payer (campaign owner)
  campaign_id uuid,
  user_id     uuid references public.app_users(id),   -- payee, when applicable
  type        text not null check (type in ('escrow_in','earning','fee','payout','refund','adjustment')),
  amount_cents bigint not null,
  ref         text,
  created_at  timestamptz not null default now(),
  foreign key (tenant_id) references public.tenants(id)
);
create index dh_ledger_idx on public.dh_ledger (tenant_id, campaign_id);

create or replace function private.dh_ledger_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'dh_ledger is append-only' using errcode = '42501';
end $$;
create trigger trg_dh_ledger_append_only before update or delete on public.dh_ledger
  for each row execute function private.dh_ledger_append_only();
revoke execute on function private.dh_ledger_append_only() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helper used by policies: is this zone currently assigned to the caller?
-- (SECURITY DEFINER so a courier from ANOTHER account can be granted read access to
--  exactly their zone, without widening any tenant_id policy.)
-- ---------------------------------------------------------------------------
create or replace function private.dh_is_my_zone(p_zone uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.dh_zones z
    where z.id = p_zone and z.courier_id = private.dh_me()
      and z.status in ('claimed','in_progress')) $$;
revoke execute on function private.dh_is_my_zone(uuid) from public, anon;
grant  execute on function private.dh_is_my_zone(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS: enabled + forced, SELECT policies only (writes go through 203 functions)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['courier_profiles','dh_campaigns','dh_listings','dh_zones',
                           'dh_addresses','dh_drops','dh_ledger'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

create policy "see courier profiles" on public.courier_profiles for select to authenticated
  using ( (select private.dh_enabled())
          and ( user_id = (select private.dh_me())
                or (tenant_id = (select private.current_tenant()) and (select private.dh_is_admin())) ) );

create policy "see campaigns" on public.dh_campaigns for select to authenticated
  using ( tenant_id = (select private.current_tenant()) and (select private.dh_enabled()) );

create policy "see listings" on public.dh_listings for select to authenticated
  using ( tenant_id = (select private.current_tenant()) and (select private.dh_enabled()) );

-- zones: everyone internal in the owning account, plus the courier assigned to it
create policy "see zones" on public.dh_zones for select to authenticated
  using ( (select private.dh_enabled())
          and ( tenant_id = (select private.current_tenant())
                or (courier_id = (select private.dh_me())
                    and status in ('claimed','in_progress','submitted')) ) );

-- addresses: admins of the owning account, plus the assigned courier while the zone is active
create policy "see addresses" on public.dh_addresses for select to authenticated
  using ( (select private.dh_enabled())
          and ( (tenant_id = (select private.current_tenant()) and (select private.dh_is_admin()))
                or private.dh_is_my_zone(zone_id) ) );

create policy "see drops" on public.dh_drops for select to authenticated
  using ( (select private.dh_enabled())
          and ( (tenant_id = (select private.current_tenant()) and (select private.dh_is_admin()))
                or courier_id = (select private.dh_me()) ) );

create policy "see ledger" on public.dh_ledger for select to authenticated
  using ( (select private.dh_enabled())
          and ( (tenant_id = (select private.current_tenant()) and (select private.dh_is_admin()))
                or user_id = (select private.dh_me()) ) );

-- Re-run the immutability installer so the new tables are covered too.
select private.install_tenant_immutable(array['app_users']) as tables_protected;
