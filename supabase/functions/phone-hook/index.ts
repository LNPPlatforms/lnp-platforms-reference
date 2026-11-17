// phone-hook: Telnyx call events (Nov 16, 2026, schema/117). The address carries a key (?k=) only Telnyx and the
// database know; everything else is checked against the calls in the database.
// Incoming: answer, play ringing, ring everyone on the line in their browser at once; first to pick up gets the call,
// the rest stop ringing. Nobody in time: the greeting, a beep, and a voicemail (kept in the private "phone" bucket).
// Outgoing (placed in the browser): answered and hung up are noted on the call; the browser also reports, first wins.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { cmd, tx, state, unstate } from '../_shared/telnyx.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const db = createClient(SB_URL, envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const ok = (b: unknown = { ok: true }) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
const RINGBACK = Deno.env.get('PHONE_RINGBACK_URL') || 'https://app.lnpplatforms.com/phone/ringback.wav';
const rpc = async (fn: string, args: Record<string, unknown>) => { const { data, error } = await db.rpc(fn, args); if (error) throw new Error(`${fn}: ${error.message}`); return data; };

let CFG: any = null;
async function cfg() { if (!CFG) CFG = await rpc('phone_cfg_get', {}); return CFG || {}; }

async function voicemail(inbound: string, callId: string) {
  const v = await rpc('phone_to_voicemail', { p_call: callId });
  await cmd(inbound, 'playback_stop', {});
  if (v?.voicemail) await cmd(inbound, 'speak', { payload: v.greeting, voice: 'female', language: 'en-US', client_state: state({ t: 'greet', c: callId }) });
  else await cmd(inbound, 'speak', { payload: 'Sorry, nobody can take your call right now. Please try again later.', voice: 'female', language: 'en-US', client_state: state({ t: 'bye', c: callId }) });
}

async function ringEveryone(p: any, info: any) {
  const inbound = p.call_control_id;
  const members = (info.members || []) as { user_id: string; sip: string }[];
  if (!members.length) return voicemail(inbound, info.call_id);
  await cmd(inbound, 'playback_start', { audio_url: RINGBACK, loop: 'infinity' });
  const c = await cfg();
  const from = /^\+\d{8,15}$/.test(p.from || '') ? p.from : info.number;
  let rang = 0;
  await Promise.all(members.map(async (m) => {
    try {
      const d = await tx('/calls', { body: { connection_id: c.cc_app_id, to: `sip:${m.sip}@sip.telnyx.com`, from, from_display_name: String(info.line || 'Call').replace(/[^A-Za-z0-9 \-_~!.+]/g, '').slice(0, 60),
        timeout_secs: info.ring_secs || 25, link_to: inbound, client_state: state({ t: 'leg', c: info.call_id }) } });
      if (d?.data?.call_control_id) { await rpc('phone_leg_add', { p_call: info.call_id, p_leg: d.data.call_control_id, p_user: m.user_id }); rang++; }
    } catch (e) { console.log('ring', m.user_id, (e as Error).message); }
  }));
  if (!rang) return voicemail(inbound, info.call_id);
}

async function saveRecording(p: any, s: any) {
  const url = p.recording_urls?.mp3 || p.public_recording_urls?.mp3;
  if (!url) return;
  const call = await rpc('phone_call_by_ccid', { p_ccid: p.call_control_id });
  const callId = s.c || call?.call_id; const tenant = call?.tenant_id;
  if (!callId || !tenant) return;
  const vm = s.t === 'vm';
  const r = await fetch(url); if (!r.ok) throw new Error('recording download ' + r.status);
  const path = `${tenant}/${callId}-${vm ? 'voicemail' : 'call'}.mp3`;
  const { error } = await db.storage.from('phone').upload(path, new Uint8Array(await r.arrayBuffer()), { contentType: 'audio/mpeg', upsert: true });
  if (error) throw new Error(error.message);
  await rpc('phone_recording_saved', { p_call: callId, p_path: path, p_voicemail: vm });
  if (vm) await cmd(p.call_control_id, 'hangup', {});
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const c = await cfg();
  if (!c.hook_key || new URL(req.url).searchParams.get('k') !== c.hook_key) return new Response('Not allowed', { status: 401 });
  let ev: any; try { ev = await req.json(); } catch { return new Response('Bad request', { status: 400 }); }
  const type = ev?.data?.event_type, p = ev?.data?.payload || {};
  const s = unstate(p.client_state);
  try {
    if (type === 'call.initiated') {
      if (p.direction === 'incoming' && p.connection_id === c.cc_app_id) {
        const info = await rpc('phone_in_start', { p_ccid: p.call_control_id, p_from: p.from, p_to: p.to });
        if (!info) { await cmd(p.call_control_id, 'reject', { cause: 'CALL_REJECTED' }); return ok({ rejected: true }); }
        await cmd(p.call_control_id, 'answer', { client_state: state({ t: 'in', c: info.call_id }) });
      }
      return ok();
    }
    if (type === 'call.answered') {
      if (s.t === 'in') {
        const info = await rpc('phone_in_start', { p_ccid: p.call_control_id, p_from: p.from, p_to: p.to });
        if (info) await ringEveryone(p, info);
      } else if (s.t === 'leg') {
        const r = await rpc('phone_leg_answered', { p_leg: p.call_control_id });
        if (!r || r.lost) { await cmd(p.call_control_id, 'hangup', {}); return ok({ lost: true }); }
        await cmd(r.inbound, 'playback_stop', {});
        await cmd(r.inbound, 'bridge', { call_control_id: p.call_control_id });
        await Promise.all((r.others || []).map((leg: string) => cmd(leg, 'hangup', {})));
        if (r.record) await cmd(r.inbound, 'record_start', { format: 'mp3', channels: 'dual', client_state: state({ t: 'rec', c: r.call_id }) });
      } else {
        await rpc('phone_call_answered_out', { p_ccid: p.call_control_id });
      }
      return ok();
    }
    if (type === 'call.hangup') {
      const leg = s.t === 'leg' ? await rpc('phone_leg_ended', { p_leg: p.call_control_id }) : null;
      if (leg) {
        if (leg.answered_leg) await cmd(leg.inbound, 'hangup', {});
        else if (leg.nobody) await voicemail(leg.inbound, leg.call_id);
        return ok();
      }
      const r = await rpc('phone_call_ended', { p_ccid: p.call_control_id, p_cause: p.hangup_cause || null });
      if (r) await Promise.all((r.ringing_legs || []).map((l: string) => cmd(l, 'hangup', {})));
      return ok();
    }
    if (type === 'call.speak.ended') {
      if (s.t === 'greet') await cmd(p.call_control_id, 'record_start', { format: 'mp3', channels: 'single', play_beep: true, max_length: 180, timeout_secs: 10, client_state: state({ t: 'vm', c: s.c }) });
      else if (s.t === 'bye') await cmd(p.call_control_id, 'hangup', {});
      return ok();
    }
    if (type === 'call.recording.saved') { await saveRecording(p, s); return ok(); }
    return ok({ ignored: type });
  } catch (e) {
    console.error('phone-hook', type, (e as Error).message);
    return ok({ ok: false, error: (e as Error).message });   // 200 so Telnyx doesn't retry into a loop
  }
});
