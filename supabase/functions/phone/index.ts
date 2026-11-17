// phone: the CRM's side of the Telnyx phone system for signed-in people (Nov 16, 2026, schema/117).
//   kind "status"  (platform admin)  -> is Telnyx set up, and the balance
//   kind "setup"   (platform admin)  -> makes the outbound profile, the call app (webhooks to phone-hook) and the browser
//                                       phone connection, once. Safe to run again.
//   kind "search"  (can buy)         -> numbers for sale by area code or city and state
//   kind "buy"     (can buy)         -> buys one for the account you're in and makes it a line that rings you
//   kind "release" (can buy)         -> gives a line's number back to Telnyx
//   kind "token"   (team, phone on)  -> a 24 hour login for this person's browser phone (makes their Telnyx login once)
//   kind "record"  (own call)        -> starts recording an outgoing call when its line records
// "can buy" = platform admins, and agency admins in a client account they manage. Numbers cost money every month.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { tx, cmd, state } from '../_shared/telnyx.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const SB_URL = Deno.env.get('SUPABASE_URL')!;
function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const PUBLIC_KEY = envKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const db = createClient(SB_URL, envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const HOOK = `${SB_URL}/functions/v1/phone-hook`;

async function who(req: Request) {
  const auth = req.headers.get('Authorization') || '';
  if (!/^Bearer\s+\S+/.test(auth)) return null;
  const asUser = createClient(SB_URL, PUBLIC_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await asUser.rpc('phone_me');
  if (error || !data?.user_id) return null;
  return data as { user_id: string; tenant_id: string; internal: boolean; on: boolean; admin: boolean; platform: boolean; can_buy: boolean };
}
async function cfg() { const { data } = await db.rpc('phone_cfg_get'); return data || {}; }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  try {
    const me = await who(req);
    if (!me || !me.internal) return json({ error: 'Sign in again' }, 401);

    if (body.kind === 'status' || body.kind === 'setup') {
      if (!me.platform) return json({ error: 'Platform admins only' }, 403);
      let c = await cfg();
      if (body.kind === 'setup') {
        const hook = `${HOOK}?k=${c.hook_key}`;
        if (!c.voice_profile_id) {
          const p = await tx('/outbound_voice_profiles', { body: { name: 'CRM calls', traffic_type: 'conversational', whitelisted_destinations: ['US', 'CA'] } });
          await db.rpc('phone_cfg_set', { p: { voice_profile_id: p.data.id } }); c = await cfg();
        }
        if (!c.cc_app_id) {
          const a = await tx('/call_control_applications', { body: { application_name: 'CRM phone lines', webhook_event_url: hook, webhook_api_version: '2',
            anchorsite_override: 'Latency', outbound: { outbound_voice_profile_id: c.voice_profile_id } } });
          await db.rpc('phone_cfg_set', { p: { cc_app_id: a.data.id } }); c = await cfg();
        }
        if (!c.cred_conn_id) {
          const rnd = crypto.randomUUID().replace(/-/g, '');
          const k = await tx('/credential_connections', { body: { connection_name: 'CRM browser phones', user_name: 'crm' + rnd.slice(0, 20), password: rnd + rnd.slice(0, 8),
            webhook_event_url: hook, webhook_api_version: '2', sip_uri_calling_preference: 'internal', anchorsite_override: 'Latency',
            outbound: { outbound_voice_profile_id: c.voice_profile_id } } });
          await db.rpc('phone_cfg_set', { p: { cred_conn_id: k.data.id } }); c = await cfg();
        }
      }
      let balance: any = null; try { balance = (await tx('/balance')).data; } catch (e) { balance = { error: (e as Error).message }; }
      return json({ ready: !!(c.voice_profile_id && c.cc_app_id && c.cred_conn_id), balance });
    }

    if (body.kind === 'search') {
      if (!me.can_buy) return json({ error: 'Ask your agency to add a phone number' }, 403);
      const q = new URLSearchParams({ 'filter[country_code]': 'US', 'filter[features][]': 'voice', 'filter[limit]': '12' });
      const area = String(body.area_code || '').replace(/\D/g, '');
      if (area) { if (!/^[2-9]\d\d$/.test(area)) return json({ error: 'Use a 3 digit area code' }, 400); q.set('filter[national_destination_code]', area); }
      if (body.city) q.set('filter[locality]', String(body.city).slice(0, 60));
      if (body.state) q.set('filter[administrative_area]', String(body.state).slice(0, 2).toUpperCase());
      if (body.contains) q.set('filter[phone_number][contains]', String(body.contains).replace(/\D/g, '').slice(0, 7));
      const r = await tx('/available_phone_numbers?' + q);
      return json({ numbers: (r.data || []).map((n: any) => ({ number: n.phone_number,
        place: [(n.region_information || []).find((x: any) => x.region_type === 'location')?.region_name, (n.region_information || []).find((x: any) => x.region_type === 'state')?.region_name].filter(Boolean).join(', '),
        monthly: n.cost_information?.monthly_cost, upfront: n.cost_information?.upfront_cost })) });
    }

    if (body.kind === 'buy') {
      if (!me.can_buy) return json({ error: 'Ask your agency to add a phone number' }, 403);
      if (!me.on) return json({ error: 'Turn on Phone for this account first (Settings › Features)' }, 400);
      const num = String(body.number || '');
      if (!/^\+1[2-9]\d{9}$/.test(num)) return json({ error: 'Pick a number from the list' }, 400);
      const c = await cfg(); if (!c.cc_app_id) return json({ error: 'The phone system needs its one-time setup first (Platform › Phone)' }, 400);
      const o = await tx('/number_orders', { body: { phone_numbers: [{ phone_number: num }], connection_id: c.cc_app_id, customer_reference: me.tenant_id } });
      const { data: id, error } = await db.rpc('phone_line_add', { p_tenant: me.tenant_id, p_user: me.user_id, p_number: num, p_name: String(body.name || 'Main line').slice(0, 60), p_order: o.data?.id || null });
      if (error) throw new Error(error.message);
      return json({ ok: true, line_id: id, status: o.data?.status });
    }

    if (body.kind === 'release') {
      if (!me.can_buy) return json({ error: 'Ask your agency to remove a number' }, 403);
      const { data: l } = await db.from('phone_lines').select('id,number,tenant_id').eq('id', body.line_id).eq('tenant_id', me.tenant_id).eq('active', true).maybeSingle();
      if (!l) return json({ error: 'Line not found' }, 404);
      const r = await tx('/phone_numbers?' + new URLSearchParams({ 'filter[phone_number]': l.number }));
      const n = (r.data || [])[0];
      if (n?.id) await tx(`/phone_numbers/${n.id}`, { method: 'DELETE' });
      await db.rpc('phone_line_released', { p_id: l.id });
      return json({ ok: true });
    }

    if (body.kind === 'token') {
      if (!me.on) return json({ error: 'Phone is off for this account' }, 400);
      const c = await cfg(); if (!c.cred_conn_id) return json({ error: 'The phone system isn\'t set up yet' }, 400);
      let { data: cr } = await db.rpc('phone_cred_get', { p_user: me.user_id });
      if (!cr) {
        const t = await tx('/telephony_credentials', { body: { connection_id: c.cred_conn_id, name: me.user_id } });
        await db.rpc('phone_cred_set', { p_user: me.user_id, p_cred: t.data.id, p_sip: t.data.sip_username });
        cr = { cred_id: t.data.id, sip_username: t.data.sip_username };
      }
      let token: string;
      try { token = await tx(`/telephony_credentials/${cr.cred_id}/token`, { method: 'POST', text: true }); }
      catch (e) {   // the login was removed on Telnyx's side: make a fresh one
        if (!/not found|404/i.test((e as Error).message)) throw e;
        const t = await tx('/telephony_credentials', { body: { connection_id: c.cred_conn_id, name: me.user_id } });
        await db.rpc('phone_cred_set', { p_user: me.user_id, p_cred: t.data.id, p_sip: t.data.sip_username });
        token = await tx(`/telephony_credentials/${t.data.id}/token`, { method: 'POST', text: true });
      }
      return json({ token: String(token).trim() });
    }

    if (body.kind === 'record') {
      const { data: call } = await db.from('phone_calls').select('id,ccid,user_id,tenant_id,line_id,phone_lines(record)').eq('id', body.call_id).maybeSingle();
      if (!call || call.user_id !== me.user_id || !call.ccid) return json({ error: 'Call not found' }, 404);
      if (!(call as any).phone_lines?.record) return json({ ok: true, skipped: 'this line doesn\'t record' });
      await cmd(call.ccid, 'record_start', { format: 'mp3', channels: 'dual', client_state: state({ t: 'rec', c: call.id }) });
      return json({ ok: true });
    }
    return json({ error: 'Unknown request' }, 400);
  } catch (e) {
    console.error('phone', (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
