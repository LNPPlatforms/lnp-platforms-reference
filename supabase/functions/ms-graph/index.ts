// ms-graph: the Microsoft 365 connection (Nov 16, 2026).
//   kind "start"      (signed in)  -> the Microsoft sign-in address to send the person to
//   kind "finish"     (state)      -> called by /auth/microsoft/callback with Microsoft's code; saves the connection
//   kind "disconnect" (signed in)  -> forgets the connection, its key and its busy times
//   kind "sync_mine"  (signed in)  -> refresh my Outlook busy times now
//   kind "sync_all"   (hook secret)-> every 5 minutes from the database: everyone's Outlook busy times
//   kind "meeting"    (hook secret)-> a fresh Teams meeting for a video booking (schema/116)
// The refresh token lives in Supabase Vault (ms_token_save / ms_token_read, service key only).
// Secrets: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT (common).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const SB_URL = Deno.env.get('SUPABASE_URL')!;
function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const PUBLIC_KEY = envKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const db = createClient(SB_URL, envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const CLIENT_ID = Deno.env.get('MICROSOFT_CLIENT_ID') || '';
const CLIENT_SECRET = Deno.env.get('MICROSOFT_CLIENT_SECRET') || Deno.env.get('MICROSOFT_SECRET') || Deno.env.get('MS_CLIENT_SECRET') || '';
const TENANT = Deno.env.get('MICROSOFT_TENANT') || 'common';
const AUTH = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
// what we ask for first: who you are, your calendar, and Teams meetings (more later, feature by feature)
const SCOPES = 'offline_access openid profile email User.Read Calendars.ReadWrite OnlineMeetings.ReadWrite';
// the return addresses registered on the Entra app
const CALLBACKS = ['https://app.cognixcrm.com/auth/microsoft/callback', 'https://app.lnpplatforms.com/auth/microsoft/callback'];
const DAY = 86400000, AHEAD = 60 * DAY;

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function challenge(v: string) { return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)))); }

async function signedIn(req: Request) {
  const auth = req.headers.get('Authorization') || '';
  const asUser = createClient(SB_URL, PUBLIC_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data } = await asUser.auth.getUser(auth.replace(/^Bearer\s+/i, ''));
  return data?.user?.id || null;
}
function needSetup() {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Microsoft isn\'t set up on the server yet (MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET missing).');
}
// only send people back to one of our own app addresses
async function safeReturn(u: string) {
  try {
    const x = new URL(u); if (x.protocol !== 'https:') return null;
    const { data } = await db.from('white_labels').select('domain');
    const hosts = new Set(['app.lnpplatforms.com', 'app.gelpstrategies.com', 'app.cognixcrm.com', 'app.getcoastcustomers.com', ...(data || []).map((w: any) => String(w.domain || '').toLowerCase())]);
    const { data: own } = await db.from('tenants').select('custom_domain').not('custom_domain', 'is', null).limit(1000).then((r: any) => r, () => ({ data: [] }));
    (own || []).forEach((t: any) => t.custom_domain && hosts.add(String(t.custom_domain).toLowerCase()));
    return hosts.has(x.hostname.toLowerCase()) ? x.href : null;
  } catch { return null; }
}

async function tokenCall(params: Record<string, string>) {
  const r = await fetch(`${AUTH}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error_description?.split('\r\n')[0] || j.error || `Microsoft answered ${r.status}`); (e as any).code = j.error; throw e; }
  return j;
}
// a fresh access token for a person (Microsoft hands back a new refresh token each time; keep it)
async function accessFor(userId: string) {
  const { data: rt } = await db.rpc('ms_token_read', { p_user: userId });
  if (!rt) throw Object.assign(new Error('Not connected'), { code: 'invalid_grant' });
  const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: rt, scope: SCOPES });
  if (t.refresh_token && t.refresh_token !== rt) await db.rpc('ms_token_save', { p_user: userId, p_token: t.refresh_token });
  return t.access_token as string;
}
async function graph(token: string, path: string, init: RequestInit = {}) {
  const r = await fetch(path.startsWith('http') ? path : `https://graph.microsoft.com/v1.0${path}`, { ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'outlook.timezone="UTC"', ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Microsoft Graph answered ${r.status}`);
  return j;
}

// Outlook busy times for the next 60 days into cal_busy (source outlook). Free and "working elsewhere" don't block.
async function syncOne(userId: string) {
  await db.from('ms_connections').update({ last_sync_at: new Date().toISOString() }).eq('user_id', userId);
  try {
    const token = await accessFor(userId);
    const from = new Date(Date.now() - DAY).toISOString(), to = new Date(Date.now() + AHEAD).toISOString();
    let url = `/me/calendarView?startDateTime=${from}&endDateTime=${to}&$select=id,subject,start,end,showAs,isCancelled,isAllDay&$top=500`;
    const events: any[] = [];
    for (let page = 0; url && page < 10; page++) { const j = await graph(token, url); events.push(...(j.value || [])); url = j['@odata.nextLink'] || ''; }
    const utc = (s: string) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z');
    const rows = events.filter((e) => !e.isCancelled && !['free', 'workingElsewhere'].includes(e.showAs))
      .map((e) => ({ user_id: userId, source: 'outlook', starts_at: utc(e.start.dateTime).toISOString(), ends_at: utc(e.end.dateTime).toISOString(),
        title: String(e.subject || '').slice(0, 200) || null, external_id: `ms:${e.id}:${e.start.dateTime}`.slice(0, 500), synced_at: new Date().toISOString() }))
      .filter((r) => r.ends_at > r.starts_at);
    const { error: de } = await db.from('cal_busy').delete().eq('user_id', userId).eq('source', 'outlook'); if (de) throw new Error(de.message);
    for (let i = 0; i < rows.length; i += 500) { const { error: ie } = await db.from('cal_busy').insert(rows.slice(i, i + 500)); if (ie) throw new Error(ie.message); }
    await db.from('ms_connections').update({ status: 'ok', last_ok_at: new Date().toISOString(), last_error: null, busy_count: rows.length }).eq('user_id', userId);
    return { ok: true, busy: rows.length };
  } catch (e) {
    const expired = (e as any).code === 'invalid_grant' || (e as any).code === 'interaction_required';
    const msg = expired ? 'Microsoft needs you to connect again (the sign-in expired or was removed).' : String((e as Error).message).slice(0, 300);
    await db.from('ms_connections').update({ status: expired ? 'expired' : 'error', last_error: msg }).eq('user_id', userId);
    return { ok: false, error: msg };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  try {
    if (body.kind === 'start') {
      needSetup();
      const uid = await signedIn(req); if (!uid) return json({ error: 'Sign in again' }, 401);
      const back = await safeReturn(String(body.return_to || ''));
      const redirect = String(body.origin || '').startsWith('https://app.cognixcrm.com') ? CALLBACKS[0] : CALLBACKS[1];
      const state = rand(24), verifier = rand(48);
      const { error } = await db.from('ms_oauth_states').insert({ state, user_id: uid, verifier, redirect_uri: redirect, return_to: back });
      if (error) throw new Error(error.message);
      const q = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', redirect_uri: redirect, response_mode: 'query', scope: SCOPES,
        state, code_challenge: await challenge(verifier), code_challenge_method: 'S256', prompt: 'select_account' });
      return json({ url: `${AUTH}/authorize?${q}` });
    }
    if (body.kind === 'finish') {
      needSetup();
      const { data: st } = await db.from('ms_oauth_states').select('*').eq('state', String(body.state || '')).maybeSingle();
      if (!st || Date.now() - new Date(st.created_at).getTime() > 3600000) return json({ error: 'That sign-in link expired. Start again from your profile.' }, 400);
      await db.from('ms_oauth_states').delete().eq('state', st.state);
      if (body.error) return json({ error: body.error_description || 'Microsoft sign-in was cancelled.', return_to: st.return_to }, 400);
      const t = await tokenCall({ grant_type: 'authorization_code', code: String(body.code || ''), redirect_uri: st.redirect_uri, code_verifier: st.verifier, scope: SCOPES });
      const me = await graph(t.access_token, '/me?$select=id,displayName,mail,userPrincipalName');
      let tid = ''; try { tid = JSON.parse(atob(String(t.id_token || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).tid || ''; } catch { /* no id token */ }
      const { error: ue } = await db.from('ms_connections').upsert({ user_id: st.user_id, ms_id: me.id, ms_tenant: tid, email: me.mail || me.userPrincipalName, name: me.displayName,
        scopes: t.scope || SCOPES, status: 'ok', last_error: null, connected_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (ue) throw new Error(ue.message);
      const { error: se } = await db.rpc('ms_token_save', { p_user: st.user_id, p_token: t.refresh_token }); if (se) throw new Error(se.message);
      const r = await syncOne(st.user_id);
      return json({ ok: true, email: me.mail || me.userPrincipalName, busy: r.busy ?? 0, return_to: st.return_to });
    }
    if (body.kind === 'disconnect') {
      const uid = await signedIn(req); if (!uid) return json({ error: 'Sign in again' }, 401);
      const { error } = await db.rpc('ms_token_drop', { p_user: uid }); if (error) throw new Error(error.message);
      return json({ ok: true });
    }
    if (body.kind === 'sync_mine') {
      needSetup();
      const uid = await signedIn(req); if (!uid) return json({ error: 'Sign in again' }, 401);
      const { data: c } = await db.from('ms_connections').select('last_sync_at').eq('user_id', uid).maybeSingle();
      if (!c) return json({ error: 'Microsoft isn\'t connected' }, 400);
      if (c.last_sync_at && Date.now() - new Date(c.last_sync_at).getTime() < 20000) return json({ ok: true, skipped: 'just synced' });
      return json(await syncOne(uid));
    }
    // 116: a fresh Teams meeting for a video booking (the database asks, with the hook secret). Whatever happens, the
    // appointment gets a link or "link to follow" and its waiting emails go out (ms_meeting_done).
    if (body.kind === 'meeting') {
      const { data: v } = await db.rpc('push_vapid');
      if (!v?.hook_secret || body.secret !== v.hook_secret) return json({ error: 'Not allowed' }, 401);
      const { data: info } = await db.rpc('ms_meeting_info', { p_id: body.id });
      if (!info?.id || info.location !== 'Video: Microsoft Teams (link coming)') return json({ ok: true, skipped: true });
      try {
        needSetup();
        const tok = await accessFor(info.user_id);
        const m = await graph(tok, '/me/onlineMeetings', { method: 'POST',
          body: JSON.stringify({ startDateTime: info.starts_at, endDateTime: info.ends_at, subject: String(info.title || 'Meeting').slice(0, 200) }) });
        const url = m.joinWebUrl || m.joinUrl || null;
        await db.rpc('ms_meeting_done', { p_id: info.id, p_url: url, p_error: url ? null : 'Microsoft sent no link' });
        return json({ ok: !!url });
      } catch (e) {
        await db.rpc('ms_meeting_done', { p_id: info.id, p_url: null, p_error: String((e as Error).message).slice(0, 200) });
        return json({ ok: false, error: (e as Error).message });
      }
    }
    if (body.kind === 'sync_all') {
      const { data: v } = await db.rpc('push_vapid');
      if (!v?.hook_secret || body.secret !== v.hook_secret) return json({ error: 'Not allowed' }, 401);
      needSetup();
      const { data: cs } = await db.from('ms_connections').select('user_id').neq('status', 'expired').limit(500);
      const out: any[] = [];
      for (let i = 0; i < (cs || []).length; i += 5) out.push(...await Promise.all(cs!.slice(i, i + 5).map((c: any) => syncOne(c.user_id))));
      return json({ ok: true, synced: out.length, failed: out.filter((x) => !x.ok).length });
    }
    return json({ error: 'Unknown request' }, 400);
  } catch (e) {
    console.error('ms-graph', (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
