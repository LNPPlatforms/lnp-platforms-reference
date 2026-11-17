// payments-connect: an account connects its own Stripe through Stripe Connect (Standard accounts, no platform fee).
//   { action: 'status' }     -> where the connection stands (and refreshes "ready to take payments" from Stripe)
//   { action: 'connect' }    -> { url } to Stripe's onboarding, making the connected account the first time
//   { action: 'login' }      -> { url } to Stripe's sign-in, for an account that already has Stripe (OAuth, Standard)
//   { action: 'login_finish', code, state } -> links that Stripe (from /auth/stripe/callback)
//   { action: 'disconnect' } -> forgets the connected account here (the account itself stays theirs in Stripe)
// Caller: signed in, and allowed to change invoice settings (admin, Settings manage or Invoices manage).
// Platform: LNP's Stripe (LNP_STRIPE_SECRET_KEY; OAuth client id LNP_STRIPE_CLIENT_ID, the ca_ id from Connect settings).
// Connect has to be turned on in that Stripe dashboard first; until it is, Stripe refuses to make accounts and this says so.
// House accounts (schema/108: LNP, Cognix for now) take payments in LNP's own Stripe and don't connect.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { lnpKey } from '../_shared/stripe_keys.ts';

const APP = Deno.env.get('APP_URL') || 'https://app.gelpstrategies.com';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SB_URL = Deno.env.get('SUPABASE_URL')!;
function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const db = createClient(SB_URL, envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const PUBLIC_KEY = envKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const CONNECT_OFF = 'Connect isn\'t turned on in the platform Stripe yet. Once it\'s on (Stripe dashboard, Settings, Connect), this button works.';

function flatten(obj: any, prefix = '', out: [string, string][] = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') flatten(v, key, out); else out.push([key, String(v)]);
  }
  return out;
}
async function stripe(path: string, method = 'GET', body?: Record<string, unknown>) {
  const key = lnpKey();
  if (!key) throw Object.assign(new Error('Stripe isn\'t set up on the platform yet (no LNP_STRIPE_SECRET_KEY)'), { code: 'not_configured' });
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body ? new URLSearchParams(flatten(body)).toString() : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data?.error?.message || 'Stripe error'), { stripe: data?.error });
  return data;
}
const isConnectOff = (e: any) => /connect/i.test(String(e?.message || '')) && /(sign(ed)? up|enable|activate|platform|not.*(set|turned))/i.test(String(e?.message || ''));
// OAuth state: tenant.user.expiry, signed with the platform key so nobody can link a Stripe to someone else's account
const enc = new TextEncoder();
async function sign(v: string) {
  const k = await crypto.subtle.importKey('raw', enc.encode('stripe-oauth:' + lnpKey()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(v))))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]!));
}
const makeState = async (tenant: string, user: string) => { const v = `${tenant}.${user}.${Date.now() + 30 * 60 * 1000}`; return `${v}.${await sign(v)}`; };
async function readState(st: string) {
  const parts = String(st || '').split('.'); if (parts.length !== 4) return null;
  const v = parts.slice(0, 3).join('.'); if ((await sign(v)) !== parts[3] || Number(parts[2]) < Date.now()) return null;
  return { tenant: parts[0], user: parts[1] };
}
const base = (req: Request) => { const o = req.headers.get('origin') || ''; return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o) ? o : APP; };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  try {
    const asUser = createClient(SB_URL, PUBLIC_KEY, { global: { headers: { Authorization: req.headers.get('Authorization') || '' } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: me, error } = await asUser.rpc('pay_processor_me');
    if (error || !me?.tenant_id) return json({ error: 'Sign in first' }, 401);
    if (!me.can) return json({ error: 'Your role can\'t change how this account takes payments' }, 403);
    const { data: row } = await db.rpc('pay_processor_get', { p_tenant: me.tenant_id });
    const key = lnpKey();
    const mode = /_live_/.test(key) ? 'live' : key ? 'test' : null;
    const clientId = Deno.env.get('LNP_STRIPE_CLIENT_ID') || '';
    const { data: house } = await db.rpc('pay_house', { p_tenant: me.tenant_id });

    if (body.action === 'status') {
      if (!row?.stripe_account_id) return json({ connected: false, key: !!key, mode, login: !!clientId, house: !!house });
      const a = await stripe(`accounts/${row.stripe_account_id}`);
      const name = a.business_profile?.name || a.settings?.dashboard?.display_name || a.email || null;
      await db.rpc('pay_processor_set', { p_tenant: me.tenant_id, p: { stripe_account_id: a.id, stripe_ready: !!a.charges_enabled, stripe_name: name } });
      return json({ connected: true, ready: !!a.charges_enabled, details_submitted: !!a.details_submitted, name, mode });
    }
    if (body.action === 'disconnect') {
      await db.rpc('pay_processor_set', { p_tenant: me.tenant_id, p: { clear: true } });
      return json({ connected: false, key: !!key, mode, login: !!clientId, house: !!house });
    }
    if (body.action === 'login') {
      if (!clientId) return json({ error: 'Signing in with an existing Stripe isn\'t turned on yet' }, 400);
      const q = new URLSearchParams({ response_type: 'code', client_id: clientId, scope: 'read_write', state: await makeState(me.tenant_id, me.user_id),
        redirect_uri: `${base(req)}/auth/stripe/callback`, ...(me.email ? { 'stripe_user[email]': me.email } : {}) });
      return json({ url: `https://connect.stripe.com/oauth/authorize?${q}` });
    }
    if (body.action === 'login_finish') {
      const st = await readState(body.state);
      if (!st || st.tenant !== me.tenant_id || st.user !== me.user_id) return json({ error: 'That sign-in link expired or belongs to another account. Try again from Invoices and payments.' }, 400);
      if (body.error) return json({ error: body.error_description || 'Stripe sign-in was cancelled' }, 400);
      const r = await fetch('https://connect.stripe.com/oauth/token', { method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: String(body.code || '') }).toString() });
      const t = await r.json();
      if (!r.ok || !t.stripe_user_id) return json({ error: t.error_description || 'Stripe didn\'t finish the sign-in' }, 400);
      const a = await stripe(`accounts/${t.stripe_user_id}`);
      const name = a.business_profile?.name || a.settings?.dashboard?.display_name || a.email || null;
      await db.rpc('pay_processor_set', { p_tenant: me.tenant_id, p: { stripe_account_id: a.id, stripe_ready: !!a.charges_enabled, stripe_name: name, by: me.user_id } });
      return json({ connected: true, ready: !!a.charges_enabled, name, mode });
    }
    if (body.action !== 'connect') return json({ error: 'Unknown request' }, 400);

    let acct = row?.stripe_account_id as string | undefined;
    if (!acct) {
      try {
        const a = await stripe('accounts', 'POST', { type: 'standard', email: me.email || undefined, business_profile: { name: me.account || undefined },
          metadata: { tenant_id: me.tenant_id } });
        acct = a.id;
      } catch (e) {
        if (isConnectOff(e)) return json({ connect_off: true, error: CONNECT_OFF });
        throw e;
      }
      await db.rpc('pay_processor_set', { p_tenant: me.tenant_id, p: { stripe_account_id: acct, stripe_ready: false, by: me.user_id } });
    }
    const back = `${base(req)}/?stripe=1#docsetup`;
    const link = await stripe('account_links', 'POST', { account: acct, refresh_url: back, return_url: back, type: 'account_onboarding' });
    return json({ url: link.url });
  } catch (e) {
    const err = e as any;
    if (err.code === 'not_configured') return json({ error: err.message, not_configured: true });
    if (isConnectOff(err)) return json({ connect_off: true, error: CONNECT_OFF });
    console.error('payments-connect', err.message);
    return json({ error: err.message }, 500);
  }
});
