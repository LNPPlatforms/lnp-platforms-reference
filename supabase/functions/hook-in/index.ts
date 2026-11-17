// hook-in: the address outside apps post to. POST https://<project>.supabase.co/functions/v1/hook-in?t=<token> with a JSON body
// (form posts work too). No login: the long random token picks the webhook. verify_jwt is off.
// The work happens in public.hook_receive (finds or adds the contact, maps fields, fires "webhook received").
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const SERVICE_KEY = envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const token = new URL(req.url).searchParams.get('t') || '';
  if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: 'Webhook not found' }, 404);
  const raw = await req.text();
  if (raw.length > 200_000) return json({ error: 'Too big' }, 413);
  let body: unknown = {};
  const type = req.headers.get('content-type') || '';
  try {
    if (type.includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw));
    else body = raw ? JSON.parse(raw) : {};
  } catch { return json({ error: 'Send JSON' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = { items: body };
  const sb = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.rpc('hook_receive', { p_token: token, p_body: body });
  if (error) return json({ error: error.message }, error.message === 'Webhook not found' ? 404 : 400);
  return json(data);
});
