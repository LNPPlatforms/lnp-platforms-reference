import type { SupabaseClient } from '@supabase/supabase-js';

/** Thin wrappers over the database functions. All authorization is enforced server-side. */
export const courierApi = (s: SupabaseClient) => ({
  networkJobs:   () => s.from('network_jobs').select('*'),                       // other accounts' shared jobs
  claimable:     (campaign: string) => s.rpc('dh_claimable_zones', { p_campaign: campaign }),
  claim:         (zone: string) => s.rpc('dh_claim_zone', { p_zone: zone }),     // returns boolean
  zoneAddresses: (zone: string) => s.rpc('dh_zone_addresses', { p_zone: zone }), // includes tenant_id (owner)
  submitZone:    (zone: string) => s.rpc('dh_zone_submit', { p_zone: zone }),
});
