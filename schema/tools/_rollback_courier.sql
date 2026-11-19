-- _rollback_courier.sql  (DESTRUCTIVE: deletes all courier-module data)
-- Removes everything created by 201-204. Leaves 200 (guardrails + adapters) in place;
-- see the bottom to remove those too. Does not delete the 'drop-photos' bucket.
drop policy if exists "dh photos: courier upload"    on storage.objects;
drop policy if exists "dh photos: owner admin read"  on storage.objects;
drop function if exists private.dh_zone_path_ok(text,text);

drop view  if exists public.network_jobs;
drop function if exists public.dh_share_grant(uuid,text,int), public.dh_share_accept(uuid,text),
                        public.dh_share_revoke(uuid,uuid,text);
drop function if exists public.dh_courier_enroll(uuid,float8,float8,int), public.dh_campaign_save(jsonb),
  public.dh_addresses_add(uuid,jsonb), public.dh_zones_build(uuid,int),
  public.dh_campaign_publish(uuid,text,numeric,timestamptz), public.dh_claimable_zones(uuid),
  public.dh_claim_zone(uuid), public.dh_zone_addresses(uuid), public.dh_submit_drops(jsonb),
  public.dh_zone_submit(uuid), public.dh_review_drop(uuid,text,text), public.dh_campaign_approve(uuid);

drop table if exists public.dh_ledger, public.dh_drops, public.dh_addresses, public.dh_zones,
                     public.dh_listings, public.dh_campaigns, public.courier_profiles, public.tenant_shares cascade;
drop function if exists private.dh_job_shared_to_me(uuid), private.dh_is_my_zone(uuid), private.dh_ledger_append_only();

-- Optional: also remove the guardrails and adapters from 200
-- drop function if exists private.install_tenant_immutable(text[]), private.forbid_tenant_change() cascade;
-- drop function if exists private.dh_require_admin(), private.dh_require_enabled(),
--                         private.dh_enabled(), private.dh_is_admin(), private.dh_me();
-- (the per-table triggers named trg_tenant_immutable are dropped by the cascade above)
