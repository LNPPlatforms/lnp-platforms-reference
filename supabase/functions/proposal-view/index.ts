// proposal-view: records that a client opened their proposal link.
// Called once per page load by /proposal/view/. Stores the version they saw, the time, their IP and an approximate
// city, state and country looked up from the IP (ipapi.co, falling back to ipwho.is). IP location is a best guess:
// phones and office networks often show the carrier's or provider's city.
// The page skips the call when the browser is signed in to the CRM, so the team's own views aren't counted.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const db = createClient(Deno.env.get('SUPABASE_URL')!, envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function fetchJson(url: string) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'gelp-crm' } }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(t); }
}
async function geo(ip: string) {
  if (!ip || /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd)/i.test(ip)) return {};
  const a = await fetchJson(`https://ipapi.co/${encodeURIComponent(ip)}/json/`);
  if (a && !a.error && a.city) return { city: a.city, region: a.region_code || a.region, country: a.country_code || a.country_name };
  const b = await fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}`);
  if (b && b.success !== false && b.city) return { city: b.city, region: b.region_code || b.region, country: b.country_code || b.country };
  return {};
}
function device(ua: string) {
  if (!ua) return null;
  const os = /iPhone|iPad/.test(ua) ? (/iPad/.test(ua) ? 'iPad' : 'iPhone') : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, br].filter(Boolean).join(' · ') || null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const token = String(body?.token || '');
  if (token.length < 32) return json({ error: 'Bad request' }, 400);
  try {
    const { data: p } = await db.from('proposals').select('id,tenant_id,status,version,accepted_version').eq('share_token', token).maybeSingle();
    if (!p || p.status === 'draft' || !p.version) return json({ ok: true, skipped: true });
    const version = p.status === 'accepted' ? (p.accepted_version || p.version) : p.version;
    const ip = (req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || '').split(',')[0].trim() || null;
    // one row per visit: skip if the same IP opened the same version in the last 30 minutes
    if (ip) {
      const since = new Date(Date.now() - 30 * 60_000).toISOString();
      const { data: recent } = await db.from('proposal_views').select('id').eq('proposal_id', p.id).eq('version', version).eq('ip', ip).gte('viewed_at', since).limit(1);
      if (recent?.length) return json({ ok: true, skipped: true });
    }
    const g: any = ip ? await geo(ip) : {};
    const { error } = await db.from('proposal_views').insert({ tenant_id: p.tenant_id, proposal_id: p.id, version, ip,
      city: g.city || null, region: g.region || null, country: g.country || null, device: device(req.headers.get('user-agent') || '') });
    if (error) throw error;
    return json({ ok: true });
  } catch (e) {
    console.error('proposal-view', (e as Error).message);
    return json({ error: 'Could not record the view' }, 500);
  }
});
