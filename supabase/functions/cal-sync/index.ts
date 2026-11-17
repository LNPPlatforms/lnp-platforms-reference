// cal-sync: connected calendars. Reads each person's iCal feeds (Google, Outlook, Apple) and refreshes their busy
// times (cal_busy) for the next 60 days, so bookings skip them on every account they work in.
//   kind "all":  the database every 10 minutes (private.cal_sync_kick), proven by the shared hook secret.
//   kind "mine": the CRM right after someone connects or taps Sync now, as that signed-in person (their feeds only).
// The feed address is a secret: it's read here with the service key and never sent back to the app.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { busyFromIcs } from './ics.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const SB_URL = Deno.env.get('SUPABASE_URL')!;
function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const PUBLIC_KEY = envKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const db = createClient(SB_URL, envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const DAY = 86400000, AHEAD = 60 * DAY, MAX_BYTES = 5_000_000, MAX_EVENTS = 3000;

// only public https addresses (never this server's own network)
function safeUrl(u: string) {
  let x: URL; try { x = new URL(u); } catch { return false; }
  if (x.protocol !== 'https:') return false;
  const h = x.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith('[')) return false;   // bare IPs: calendars always use a name
  return true;
}

async function readFeed(url: string) {
  if (!safeUrl(url)) throw new Error('That address can\'t be used. Paste the calendar\'s https address.');
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { Accept: 'text/calendar, text/plain, */*', 'User-Agent': 'LNP-Platforms-Calendar-Sync/1.0' } });
    if (r.status === 401 || r.status === 403 || r.status === 404 || r.status === 410) throw new Error('The calendar address stopped working (it may have been reset). Paste the new secret address.');
    if (!r.ok) throw new Error(`The calendar service answered ${r.status}. We'll keep trying.`);
    const len = +(r.headers.get('content-length') || 0); if (len > MAX_BYTES) throw new Error('That calendar is too big to read.');
    const text = await r.text();
    if (text.length > MAX_BYTES) throw new Error('That calendar is too big to read.');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That address isn\'t a calendar feed. Use the secret iCal address (it ends in .ics).');
    return text;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('The calendar took too long to answer. We\'ll keep trying.');
    throw e;
  } finally { clearTimeout(t); }
}

async function syncFeed(f: any) {
  const now = Date.now();
  await db.from('cal_feeds').update({ last_try_at: new Date().toISOString(), sync_now: false }).eq('id', f.id);
  try {
    const text = await readFeed(f.url);
    const busy = busyFromIcs(text, now - DAY, now + AHEAD, 'America/Chicago').slice(0, MAX_EVENTS);
    const seen = new Set<string>();
    const rows = busy.map((b: any) => ({ user_id: f.user_id, feed_id: f.id, source: 'ical', starts_at: b.start.toISOString(), ends_at: b.end.toISOString(),
      title: b.title || null, external_id: `${f.id}:${b.uid}:${b.start.getTime()}`.slice(0, 500), synced_at: new Date().toISOString() }))
      .filter((r: any) => !seen.has(r.external_id) && seen.add(r.external_id));
    // replace this feed's busy times with what it says now
    const { error: de } = await db.from('cal_busy').delete().eq('feed_id', f.id); if (de) throw new Error(de.message);
    for (let i = 0; i < rows.length; i += 500) { const { error: ie } = await db.from('cal_busy').insert(rows.slice(i, i + 500)); if (ie) throw new Error(ie.message); }
    await db.from('cal_feeds').update({ last_ok_at: new Date().toISOString(), last_error: null, events: rows.length }).eq('id', f.id);
    return { id: f.id, ok: true, events: rows.length };
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 300);
    await db.from('cal_feeds').update({ last_error: msg }).eq('id', f.id);
    return { id: f.id, ok: false, error: msg };
  }
}

async function syncAll(feeds: any[]) {
  const out: any[] = [];
  for (let i = 0; i < feeds.length; i += 5) out.push(...await Promise.all(feeds.slice(i, i + 5).map(syncFeed)));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  try {
    if (body.kind === 'all') {
      const { data: v } = await db.rpc('push_vapid');
      if (!v?.hook_secret || body.secret !== v.hook_secret) return json({ error: 'Not allowed' }, 401);
      const { data: feeds } = await db.from('cal_feeds').select('id,user_id,url,last_try_at,sync_now')
        .or(`sync_now.eq.true,last_try_at.is.null,last_try_at.lt.${new Date(Date.now() - 9 * 60000).toISOString()}`).limit(500);
      const res = await syncAll(feeds || []);
      return json({ ok: true, feeds: res.length, failed: res.filter((r) => !r.ok).length });
    }
    if (body.kind === 'mine') {
      const auth = req.headers.get('Authorization') || '';
      const asUser = createClient(SB_URL, PUBLIC_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
      const { data: u } = await asUser.auth.getUser(auth.replace(/^Bearer\s+/i, ''));
      if (!u?.user) return json({ error: 'Sign in again' }, 401);
      let q = db.from('cal_feeds').select('id,user_id,url,last_try_at').eq('user_id', u.user.id);
      if (body.feed_id) q = q.eq('id', String(body.feed_id));
      const { data: feeds } = await q;
      // a tap at most every 30 seconds per feed
      const due = (feeds || []).filter((f: any) => !f.last_try_at || Date.now() - new Date(f.last_try_at).getTime() > 30_000);
      return json({ ok: true, results: await syncAll(due) });
    }
    return json({ error: 'Unknown request' }, 400);
  } catch (e) {
    console.error('cal-sync', (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
