// social-connect: connects Facebook Pages and their Instagram business accounts to an account's social planner.
//   POST { action: 'start', return_to }  (signed in, Marketing level 4 or admin) -> { url } to Facebook's login dialog
//   GET  ?code&state                       Facebook sends the person back here; we swap the code for long lived Page tokens,
//                                          store every Page they picked plus any Instagram business account on it, then send
//                                          them back to the planner (#socialaccounts/connected-N or #socialaccounts/error-...)
//   POST ?meta=deauth   (signed_request)   Meta's deauthorize callback: tokens dropped, accounts marked to reconnect
//   POST ?meta=deletion (signed_request)   Meta's data deletion callback: tokens and connections removed, returns the status link
// verify_jwt is off because Facebook calls the GET and the two callbacks; 'start' checks the person through the database.
// Secrets: META_APP_ID, META_APP_SECRET. Optional META_CONFIG_ID (Facebook Login for Business), META_GRAPH_VERSION (default v25.0), APP_URL.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const db = createClient(SB_URL, envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const PUBLIC_KEY = envKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const APP = Deno.env.get('APP_URL') || 'https://app.lnpplatforms.com';
const VER = Deno.env.get('META_GRAPH_VERSION') || 'v25.0';
const APP_ID = Deno.env.get('META_APP_ID') || '';
const APP_SECRET = Deno.env.get('META_APP_SECRET') || '';
const SELF = `${SB_URL}/functions/v1/social-connect`;
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management', 'instagram_basic', 'instagram_content_publish'];
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const back = (to: string, frag: string) => new Response(null, { status: 302, headers: { Location: to.replace(/#.*$/, '').replace(/\/?$/, '/') + '#socialaccounts/' + frag } });

async function graph(path: string, params: Record<string, string> = {}) {
  const u = new URL(`https://graph.facebook.com/${VER}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d?.error?.message || `Facebook said ${r.status}`);
  return d;
}

// Meta's signed_request: base64url(signature).base64url(payload), HMAC-SHA256 with the app secret
const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function readSigned(sr: string) {
  const [sig, payload] = String(sr || '').split('.');
  if (!sig || !payload || !APP_SECRET) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('HMAC', key, b64u(sig), new TextEncoder().encode(payload));
  if (!ok) return null;
  try { return JSON.parse(new TextDecoder().decode(b64u(payload))); } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);

  // ---- Meta's callbacks ----
  const meta = url.searchParams.get('meta');
  if (meta === 'deauth' || meta === 'deletion') {
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
    const form = await req.formData().catch(() => null);
    const data = await readSigned(String(form?.get('signed_request') || ''));
    if (!data?.user_id) return json({ error: 'Bad signed_request' }, 400);
    await db.rpc('social_meta_forget', { p_meta_user: String(data.user_id), p_delete: meta === 'deletion' });
    if (meta === 'deauth') return json({ ok: true });
    const code = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    return json({ url: `${APP}/legal/data-deletion/?code=${code}`, confirmation_code: code });
  }

  // ---- back from Facebook's login dialog ----
  if (req.method === 'GET') {
    const state = url.searchParams.get('state') || '';
    const { data: st } = await db.rpc('social_oauth_take', { p_state: state });
    if (!st?.return_to) return new Response('This connect link expired. Go back to the app and press Connect again.', { status: 400 });
    const to = String(st.return_to);
    if (url.searchParams.get('error')) return back(to, 'error-' + encodeURIComponent(url.searchParams.get('error_description') || 'Facebook connect was cancelled'));
    try {
      const short = await graph('oauth/access_token', { client_id: APP_ID, client_secret: APP_SECRET, redirect_uri: SELF, code: url.searchParams.get('code') || '' });
      const long = await graph('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: APP_ID, client_secret: APP_SECRET, fb_exchange_token: short.access_token });
      const me = await graph('me', { fields: 'id,name', access_token: long.access_token });
      const items: Record<string, unknown>[] = [];
      let pages = await graph('me/accounts', { fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}', limit: '100', access_token: long.access_token });
      for (let guard = 0; guard < 10; guard++) {
        for (const p of pages.data || []) {
          if (!p.access_token) continue;
          // Page tokens made from a long lived user token don't expire
          items.push({ network: 'facebook', external_id: p.id, name: p.name, picture_url: p.picture?.data?.url || null, token: p.access_token });
          const ig = p.instagram_business_account;
          if (ig?.id) items.push({ network: 'instagram', external_id: ig.id, name: ig.name || ig.username, handle: ig.username || null,
            picture_url: ig.profile_picture_url || null, parent_external_id: p.id, token: p.access_token });
        }
        const next = pages.paging?.next;
        if (!next) break;
        const r = await fetch(next); pages = await r.json();
      }
      if (!items.length) return back(to, 'error-' + encodeURIComponent('No Facebook Pages came back. Pick at least one Page when Facebook asks.'));
      const { data: n, error } = await db.rpc('social_accounts_store', { p_tenant: st.tenant_id, p_user: st.user_id, p_meta_user: String(me.id), p_items: items });
      if (error) throw new Error(error.message);
      return back(to, 'connected-' + (n || 0));
    } catch (e) {
      return back(to, 'error-' + encodeURIComponent(String((e as Error).message || e).slice(0, 200)));
    }
  }

  // ---- the app starts a connect ----
  if (req.method !== 'POST') return json({ error: 'GET or POST' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (body.action !== 'start') return json({ error: 'Unknown request' }, 400);
  if (!APP_ID || !APP_SECRET) return json({ error: 'Facebook and Instagram aren\'t set up on the platform yet. The Meta app ID and secret still need to be added.', code: 'not_configured' }, 503);
  const asUser = createClient(SB_URL, PUBLIC_KEY, { global: { headers: { Authorization: req.headers.get('Authorization') || '' } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: state, error } = await asUser.rpc('social_oauth_begin', { p_network: 'meta', p_return: String(body.return_to || '') });
  if (error || !state) return json({ error: error?.message || 'Sign in first' }, 403);
  const dlg = new URL(`https://www.facebook.com/${VER}/dialog/oauth`);
  dlg.searchParams.set('client_id', APP_ID);
  dlg.searchParams.set('redirect_uri', SELF);
  dlg.searchParams.set('state', state);
  dlg.searchParams.set('response_type', 'code');
  // Facebook Login for Business apps send a saved configuration instead of a permission list
  const cfg = Deno.env.get('META_CONFIG_ID');
  if (cfg) dlg.searchParams.set('config_id', cfg); else dlg.searchParams.set('scope', SCOPES.join(','));
  return json({ url: dlg.toString() });
});
