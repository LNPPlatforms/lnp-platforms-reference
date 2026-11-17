// stripe_keys.ts: which Stripe key a call uses (Nov 16, 2026, schema/108).
//   connected account (Stripe-Account header)  -> LNP's key, the Connect platform
//   house account (LNP, Cognix for now)        -> LNP's key, straight into LNP's Stripe
//   anything else direct (GELP's own switch)   -> GELP's key (STRIPE_SECRET_KEY)
// deno-lint-ignore-file no-explicit-any
export const gelpKey = () => Deno.env.get('STRIPE_SECRET_KEY') || '';
export const lnpKey = () => Deno.env.get('LNP_STRIPE_SECRET_KEY') || '';
const house = new Map<string, Promise<boolean>>();
export async function keyFor(db: any, tenant?: string | null, account?: string | null): Promise<string> {
  if (account) return lnpKey();
  if (tenant) {
    if (!house.has(tenant)) house.set(tenant, db.rpc('pay_house', { p_tenant: tenant }).then((r: any) => !!r.data, () => false));
    if (await house.get(tenant)) return lnpKey();
  }
  return gelpKey();
}
