-- 203_courier_functions.sql
-- All writes to the courier tables happen here. Same pattern as phone_line_save:
-- SECURITY DEFINER, pinned search_path, feature + admin check first, then every row
-- touched is matched against private.current_tenant() inside the function.
-- PostGIS lives in the "extensions" schema on Supabase; it is on the search_path below.
-- (Match search_path to what your existing definer functions use if it differs.)
--
-- NOT in this file (payments phase): funding a campaign, ledger inserts, payouts.
-- Look for TODO(payments).

-- ---------------------------------------------------------------------------
-- Courier enrollment (admin of the acting account)
-- ---------------------------------------------------------------------------
create or replace function public.dh_courier_enroll(
  p_user uuid, p_lat float8 default null, p_lng float8 default null, p_radius_m int default 16000)
returns uuid language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_t uuid := private.current_tenant(); v_id uuid;
begin
  perform private.dh_require_admin();
  -- the person must belong to the acting account (home account or an account membership)
  if not exists (select 1 from public.app_users u where u.id = p_user and u.tenant_id = v_t)
     and not exists (select 1 from public.account_members m where m.tenant_id = v_t and m.user_id = p_user) then
    raise exception 'user is not a member of this account' using errcode = '42501';
  end if;
  insert into public.courier_profiles (tenant_id, user_id, home_location, service_radius_m, status, verified_at)
  values (v_t, p_user,
          case when p_lat is not null and p_lng is not null
               then st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography end,
          coalesce(p_radius_m, 16000), 'active', now())
  on conflict (tenant_id, user_id) do update
    set status = 'active', service_radius_m = excluded.service_radius_m,
        home_location = coalesce(excluded.home_location, public.courier_profiles.home_location)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Campaigns
-- ---------------------------------------------------------------------------
create or replace function public.dh_campaign_save(p jsonb) returns uuid
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_t    uuid := private.current_tenant();
  v_id   uuid := nullif(p->>'id', '')::uuid;
  v_area geometry;
begin
  perform private.dh_require_admin();
  if nullif(p->>'target_area_geojson', '') is not null then
    v_area := st_setsrid(st_geomfromgeojson(p->>'target_area_geojson'), 4326);
    if geometrytype(v_area) <> 'POLYGON' then raise exception 'target_area must be a Polygon'; end if;
  end if;

  if v_id is null then
    insert into public.dh_campaigns
      (tenant_id, title, trade, storm_event_date, target_area, pay_per_drop_cents, geofence_radius_m, max_gps_accuracy_m)
    values
      (v_t, p->>'title', p->>'trade', nullif(p->>'storm_event_date','')::date, v_area,
       (p->>'pay_per_drop_cents')::int,
       coalesce((p->>'geofence_radius_m')::int, 40),
       coalesce((p->>'max_gps_accuracy_m')::int, 30))
    returning id into v_id;
  else
    update public.dh_campaigns set
      title              = coalesce(p->>'title', title),
      trade              = coalesce(p->>'trade', trade),
      storm_event_date   = coalesce(nullif(p->>'storm_event_date','')::date, storm_event_date),
      target_area        = coalesce(v_area, target_area),
      pay_per_drop_cents = coalesce((p->>'pay_per_drop_cents')::int, pay_per_drop_cents),
      geofence_radius_m  = coalesce((p->>'geofence_radius_m')::int, geofence_radius_m),
      max_gps_accuracy_m = coalesce((p->>'max_gps_accuracy_m')::int, max_gps_accuracy_m)
    where id = v_id and tenant_id = v_t and status = 'draft';
    if not found then raise exception 'campaign not found or not editable'; end if;
  end if;
  return v_id;
end $$;

-- rows: [{"line1":"12 Oak St","city":"Baltimore","zip":"21201","lat":39.29,"lng":-76.61,"no_solicit":false}, ...]
create or replace function public.dh_addresses_add(p_campaign uuid, p_rows jsonb) returns int
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_t uuid := private.current_tenant(); v_n int;
begin
  perform private.dh_require_admin();
  perform 1 from public.dh_campaigns where id = p_campaign and tenant_id = v_t and status = 'draft' for update;
  if not found then raise exception 'campaign not found or not editable'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows must be a json array'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'max 5000 addresses per call'; end if;

  insert into public.dh_addresses (tenant_id, campaign_id, line1, city, zip, location, no_solicit)
  select v_t, p_campaign, trim(r.line1), r.city, r.zip,
         st_setsrid(st_makepoint(r.lng, r.lat), 4326)::geography, coalesce(r.no_solicit, false)
  from jsonb_to_recordset(p_rows)
       as r(line1 text, city text, zip text, lat float8, lng float8, no_solicit boolean)
  where nullif(trim(r.line1), '') is not null
    and r.lat between -90 and 90 and r.lng between -180 and 180
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Split deliverable addresses into walkable zones (k-means on coordinates).
create or replace function public.dh_zones_build(p_campaign uuid, p_doors_per_zone int default 150) returns int
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_t uuid := private.current_tenant(); v_n int; v_k int; v_zones int;
begin
  perform private.dh_require_admin();
  perform 1 from public.dh_campaigns where id = p_campaign and tenant_id = v_t and status = 'draft' for update;
  if not found then raise exception 'campaign not found or not editable'; end if;
  if p_doors_per_zone is null or p_doors_per_zone < 10 or p_doors_per_zone > 1000 then
    raise exception 'doors per zone must be between 10 and 1000';
  end if;

  select count(*) into v_n from public.dh_addresses
   where campaign_id = p_campaign and tenant_id = v_t and not no_solicit;
  if v_n = 0 then raise exception 'no deliverable addresses'; end if;
  v_k := greatest(1, ceil(v_n::numeric / p_doors_per_zone)::int);

  update public.dh_addresses set zone_id = null, cluster_no = null
   where campaign_id = p_campaign and tenant_id = v_t;
  delete from public.dh_zones where campaign_id = p_campaign and tenant_id = v_t;

  update public.dh_addresses a set cluster_no = c.cid
  from (select id, st_clusterkmeans(location::geometry, v_k) over () as cid
          from public.dh_addresses
         where campaign_id = p_campaign and tenant_id = v_t and not no_solicit) c
  where a.id = c.id;

  insert into public.dh_zones (tenant_id, campaign_id, seq, polygon, door_count)
  select v_t, p_campaign, a.cluster_no,
         st_buffer(st_convexhull(st_collect(a.location::geometry))::geography, 25)::geometry,
         count(*)
    from public.dh_addresses a
   where a.campaign_id = p_campaign and a.tenant_id = v_t and a.cluster_no is not null
   group by a.cluster_no;
  get diagnostics v_zones = row_count;

  update public.dh_addresses a set zone_id = z.id
    from public.dh_zones z
   where z.campaign_id = a.campaign_id and z.tenant_id = a.tenant_id and z.seq = a.cluster_no
     and a.campaign_id = p_campaign and a.tenant_id = v_t;
  return v_zones;
end $$;

-- TODO(payments): require status = 'funded' (escrow in) before a campaign can open.
create or replace function public.dh_campaign_publish(
  p_campaign uuid, p_visibility text default 'private', p_min_rating numeric default 0,
  p_claim_deadline timestamptz default null)
returns void language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_t uuid := private.current_tenant(); v_status text;
begin
  perform private.dh_require_admin();
  select status into v_status from public.dh_campaigns where id = p_campaign and tenant_id = v_t for update;
  if not found then raise exception 'campaign not found'; end if;
  if v_status <> 'draft' then raise exception 'only draft campaigns can be published'; end if;
  if p_visibility not in ('private','network') then raise exception 'visibility must be private or network'; end if;
  if not exists (select 1 from public.dh_zones where campaign_id = p_campaign and tenant_id = v_t) then
    raise exception 'build zones first';
  end if;
  insert into public.dh_listings (campaign_id, tenant_id, visibility, min_rating, claim_deadline)
  values (p_campaign, v_t, p_visibility, coalesce(p_min_rating, 0), p_claim_deadline)
  on conflict (campaign_id) do update
    set visibility = excluded.visibility, min_rating = excluded.min_rating, claim_deadline = excluded.claim_deadline;
  update public.dh_campaigns set status = 'open' where id = p_campaign and tenant_id = v_t;
end $$;

-- ---------------------------------------------------------------------------
-- Courier side
-- ---------------------------------------------------------------------------
create or replace function public.dh_claimable_zones(p_campaign uuid)
returns table (zone_id uuid, seq int, door_count int, center_lat float8, center_lng float8)
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select z.id, z.seq, z.door_count, st_y(st_centroid(z.polygon)), st_x(st_centroid(z.polygon))
    from public.dh_zones z
    join public.dh_campaigns c on c.id = z.campaign_id and c.tenant_id = z.tenant_id
   where private.dh_enabled()
     and z.campaign_id = p_campaign and z.status = 'open'
     and c.status in ('open','in_progress')
     and (c.tenant_id = private.current_tenant() or private.dh_job_shared_to_me(c.id))
   order by z.seq $$;

-- Atomic: exactly one courier wins a zone. Courier acts from THEIR OWN account;
-- the job must be that account's own, or shared to it with an active job_board share.
create or replace function public.dh_claim_zone(p_zone uuid) returns boolean
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_me uuid := private.dh_me(); v_t uuid := private.current_tenant();
  v_campaign uuid; v_owner uuid; v_rating numeric; v_min numeric;
begin
  perform private.dh_require_enabled();
  select z.campaign_id, z.tenant_id into v_campaign, v_owner from public.dh_zones z where z.id = p_zone;
  if v_campaign is null then return false; end if;

  select p.rating into v_rating from public.courier_profiles p
   where p.tenant_id = v_t and p.user_id = v_me and p.status = 'active';
  if v_rating is null then
    raise exception 'no active courier profile in this account' using errcode = '42501';
  end if;

  if v_owner <> v_t and not private.dh_job_shared_to_me(v_campaign) then return false; end if;

  perform 1 from public.dh_campaigns c where c.id = v_campaign and c.tenant_id = v_owner and c.status in ('open','in_progress');
  if not found then return false; end if;

  select l.min_rating into v_min from public.dh_listings l where l.campaign_id = v_campaign;
  if v_min is not null and v_rating < v_min then
    raise exception 'rating below the minimum for this job' using errcode = '42501';
  end if;

  update public.dh_zones
     set courier_id = v_me, status = 'claimed', claimed_via_tenant = v_t, claimed_at = now()
   where id = p_zone and status = 'open';
  if not found then return false; end if;

  update public.dh_campaigns set status = 'in_progress' where id = v_campaign and status = 'open';
  return true;
end $$;

-- Addresses for MY zone, with coordinates (geography columns aren't PWA-friendly).
create or replace function public.dh_zone_addresses(p_zone uuid)
returns table (address_id uuid, tenant_id uuid, zone_id uuid, line1 text, city text, zip text,
               lat float8, lng float8, done boolean)
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select a.id, a.tenant_id, a.zone_id, a.line1, a.city, a.zip,
         st_y(a.location::geometry), st_x(a.location::geometry),
         exists (select 1 from public.dh_drops d where d.address_id = a.id and d.status <> 'rejected')
    from public.dh_addresses a
   where private.dh_enabled() and a.zone_id = p_zone and private.dh_is_my_zone(p_zone) and not a.no_solicit
   order by a.line1 $$;   -- TODO: order by walking route (nearest-neighbour / routing API)

-- Batch submit (offline queue). Idempotent on client_drop_id. Never trusts the client for
-- ownership: the stored tenant_id is the CAMPAIGN OWNER's, the courier is auth.uid().
create or replace function public.dh_submit_drops(p_drops jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_me uuid := private.dh_me();
  v_out jsonb := '[]'::jsonb;
  d jsonb; v_cdid uuid; a record; ex record; prev record;
  v_flags text[]; v_status text; v_outcome text;
  v_off bigint; v_cap timestamptz; v_lat float8; v_lng float8; v_acc numeric;
  v_pt geography; v_dist numeric; v_secs numeric; v_prefix text; v_key text;
begin
  perform private.dh_require_enabled();
  if jsonb_typeof(p_drops) <> 'array' then raise exception 'p_drops must be a json array'; end if;
  if jsonb_array_length(p_drops) > 200 then raise exception 'max 200 drops per call'; end if;

  for d in select e from jsonb_array_elements(p_drops) as e loop
    begin
      v_cdid    := (d->>'client_drop_id')::uuid;
      v_outcome := coalesce(d->>'outcome', 'hung');
      v_lat := (d->>'lat')::float8;  v_lng := (d->>'lng')::float8;  v_acc := (d->>'accuracy_m')::numeric;
      v_off := coalesce((d->>'clock_offset_ms')::bigint, 0);
      v_cap := (d->>'captured_at')::timestamptz + make_interval(secs => v_off / 1000.0);
      v_key := nullif(d->>'photo_key', '');

      -- idempotency: a replay returns the stored result
      select dd.courier_id, dd.status, dd.flags into ex from public.dh_drops dd where dd.client_drop_id = v_cdid;
      if found then
        if ex.courier_id = v_me then
          v_out := v_out || jsonb_build_object('client_drop_id', v_cdid, 'status', ex.status,
                                               'flags', to_jsonb(ex.flags), 'duplicate', true);
        else
          v_out := v_out || jsonb_build_object('client_drop_id', v_cdid, 'error', 'duplicate_id');
        end if;
        continue;
      end if;

      select ad.id as address_id, ad.tenant_id, ad.campaign_id, ad.zone_id, ad.location,
             c.geofence_radius_m, c.max_gps_accuracy_m
        into a
        from public.dh_addresses ad
        join public.dh_campaigns c on c.id = ad.campaign_id and c.tenant_id = ad.tenant_id
       where ad.id = (d->>'address_id')::uuid;
      if not found or a.zone_id is null or not private.dh_is_my_zone(a.zone_id) then
        v_out := v_out || jsonb_build_object('client_drop_id', v_cdid, 'error', 'not_assigned');
        continue;
      end if;

      if v_outcome not in ('hung','skipped') then raise exception 'bad outcome'; end if;
      if v_outcome = 'skipped' and nullif(d->>'skip_reason','') is null then raise exception 'skip reason required'; end if;
      v_prefix := 't/' || a.tenant_id::text || '/' || a.zone_id::text || '/';
      if (v_outcome = 'hung' and v_key is null) or (v_key is not null and left(v_key, length(v_prefix)) <> v_prefix) then
        v_out := v_out || jsonb_build_object('client_drop_id', v_cdid, 'error', 'bad_photo_key');
        continue;
      end if;

      v_pt   := st_setsrid(st_makepoint(v_lng, v_lat), 4326)::geography;
      v_dist := st_distance(a.location, v_pt);
      v_flags := '{}';
      if v_acc is null or v_acc > a.max_gps_accuracy_m then v_flags := array_append(v_flags, 'low_gps_accuracy'); end if;
      if v_dist > a.geofence_radius_m                  then v_flags := array_append(v_flags, 'out_of_range');     end if;
      if v_cap < now() - interval '36 hours'           then v_flags := array_append(v_flags, 'stale_timestamp');  end if;
      if v_cap > now() + interval '10 minutes'         then v_flags := array_append(v_flags, 'future_timestamp'); end if;
      if abs(v_off) > 48 * 3600 * 1000                 then v_flags := array_append(v_flags, 'clock_drift');      end if;

      select dd.location, dd.captured_at into prev
        from public.dh_drops dd where dd.courier_id = v_me and dd.captured_at < v_cap
       order by dd.captured_at desc limit 1;
      if found and prev.location is not null then
        v_secs := extract(epoch from (v_cap - prev.captured_at));
        if v_secs > 0 and st_distance(prev.location, v_pt) / v_secs > 3.5 then v_flags := array_append(v_flags, 'impossible_speed'); end if;
        if v_secs >= 0 and v_secs < 8 then v_flags := array_append(v_flags, 'burst_too_fast'); end if;
      end if;

      v_status := case when cardinality(v_flags) = 0 then 'verified' else 'flagged' end;

      insert into public.dh_drops
        (tenant_id, client_drop_id, campaign_id, zone_id, address_id, courier_id, outcome, skip_reason,
         captured_at, location, accuracy_m, distance_to_target_m, photo_key, status, flags, device_id, clock_offset_ms)
      values
        (a.tenant_id, v_cdid, a.campaign_id, a.zone_id, a.address_id, v_me, v_outcome, d->>'skip_reason',
         v_cap, v_pt, v_acc, v_dist, v_key, v_status, v_flags, d->>'device_id', v_off);

      update public.dh_zones set status = 'in_progress' where id = a.zone_id and status = 'claimed';
      v_out := v_out || jsonb_build_object('client_drop_id', v_cdid, 'status', v_status, 'flags', to_jsonb(v_flags));
    exception
      when unique_violation then
        v_out := v_out || jsonb_build_object('client_drop_id', d->>'client_drop_id', 'error', 'address_already_done');
      when others then
        -- SQLSTATE only (no message text) so the PWA/support can diagnose without leaking internals
        v_out := v_out || jsonb_build_object('client_drop_id', d->>'client_drop_id', 'error', 'invalid_drop', 'code', sqlstate);
    end;
  end loop;
  return v_out;
end $$;

-- Courier finishes their zone (partial completion is allowed; only completed doors get paid).
create or replace function public.dh_zone_submit(p_zone uuid) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_me uuid := private.dh_me(); v_campaign uuid; v_tenant uuid;
begin
  perform private.dh_require_enabled();
  update public.dh_zones set status = 'submitted'
   where id = p_zone and courier_id = v_me and status = 'in_progress'
  returning campaign_id, tenant_id into v_campaign, v_tenant;
  if not found then raise exception 'zone is not yours or has no drops yet' using errcode = '42501'; end if;

  if not exists (select 1 from public.dh_zones z
                  where z.campaign_id = v_campaign and z.tenant_id = v_tenant
                    and z.status in ('open','claimed','in_progress')) then
    update public.dh_campaigns set status = 'submitted'
     where id = v_campaign and tenant_id = v_tenant and status in ('open','in_progress');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Contractor review (admin of the OWNING account)
-- ---------------------------------------------------------------------------
create or replace function public.dh_review_drop(p_drop uuid, p_decision text, p_note text default null)
returns void language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_t uuid := private.current_tenant(); v_zone uuid;
begin
  perform private.dh_require_admin();
  if p_decision not in ('approve','reject') then raise exception 'decision must be approve or reject'; end if;
  update public.dh_drops
     set status = case p_decision when 'approve' then 'approved' else 'rejected' end,
         reviewed_by = private.dh_me(), reviewed_at = now(), review_note = p_note
   where id = p_drop and tenant_id = v_t and status in ('pending','verified','flagged')
  returning zone_id into v_zone;
  if not found then raise exception 'drop not found or already decided'; end if;
  if p_decision = 'reject' then   -- reopen the zone so the courier can re-hang
    update public.dh_zones set status = 'in_progress' where id = v_zone and tenant_id = v_t and status = 'submitted';
    update public.dh_campaigns c set status = 'in_progress'
     where c.tenant_id = v_t and c.status = 'submitted'
       and c.id = (select campaign_id from public.dh_zones where id = v_zone);
  end if;
end $$;

-- TODO(payments): write 'earning' / 'fee' / revenue-share rows to dh_ledger here.
create or replace function public.dh_campaign_approve(p_campaign uuid) returns void
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_t uuid := private.current_tenant(); v_flagged int;
begin
  perform private.dh_require_admin();
  perform 1 from public.dh_campaigns where id = p_campaign and tenant_id = v_t and status = 'submitted' for update;
  if not found then raise exception 'campaign is not submitted'; end if;
  select count(*) into v_flagged from public.dh_drops
   where campaign_id = p_campaign and tenant_id = v_t and status in ('flagged','pending');
  if v_flagged > 0 then raise exception '% flagged drops still need review', v_flagged; end if;
  update public.dh_drops set status = 'approved', reviewed_by = private.dh_me(), reviewed_at = now()
   where campaign_id = p_campaign and tenant_id = v_t and status = 'verified';
  update public.dh_zones set status = 'approved' where campaign_id = p_campaign and tenant_id = v_t and status = 'submitted';
  update public.dh_campaigns set status = 'approved' where id = p_campaign and tenant_id = v_t;
end $$;

-- ---------------------------------------------------------------------------
-- Grants: callable by signed-in users only; each function self-checks feature/admin/tenant.
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.dh_courier_enroll(uuid,float8,float8,int)',
    'public.dh_campaign_save(jsonb)',
    'public.dh_addresses_add(uuid,jsonb)',
    'public.dh_zones_build(uuid,int)',
    'public.dh_campaign_publish(uuid,text,numeric,timestamptz)',
    'public.dh_claimable_zones(uuid)',
    'public.dh_claim_zone(uuid)',
    'public.dh_zone_addresses(uuid)',
    'public.dh_submit_drops(jsonb)',
    'public.dh_zone_submit(uuid)',
    'public.dh_review_drop(uuid,text,text)',
    'public.dh_campaign_approve(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
