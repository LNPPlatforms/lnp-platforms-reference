// automation-send: sends one queued email from the outbox (automations now, campaigns later).
// The database calls this through pg_net with the outbox id and the shared hook secret, so only the database can trigger it.
// verify_jwt is off; the secret check happens in outbox_take. Resend key: RESEND_API_KEY.
// Sender and links: the account's own name, from its agency's sending domain and address (_shared/brand.ts).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { brandFor, fromLine } from '../_shared/brand.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const SERVICE_KEY = envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// plain text with line breaks and bare links becomes simple HTML; tracked /go/ links get the contact id so clicks land on the timeline
function toHtml(body: string, personId: string | null) {
  const withLinks = esc(body).replace(/(https?:\/\/[^\s<]+)/g, (u) => {
    let href = u;
    if (personId && href.includes('/go/') && !/[?&]p=/.test(href)) href += (href.includes('?') ? '&' : '?') + 'p=' + personId;
    return `<a href="${href}">${u}</a>`;
  });
  return withLinks.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`).join('');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let id = '', secret = '';
  try { const b = await req.json(); id = String(b.id || ''); secret = String(b.secret || ''); } catch { return json({ error: 'Bad request' }, 400); }
  const sb = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: o, error } = await sb.rpc('outbox_take', { p_id: id, p_secret: secret });
  if (error) return json({ error: error.message }, 403);
  if (!o) return json({ ok: true, skipped: true });
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) { await sb.rpc('outbox_done', { p_id: id, p_secret: secret, p_ok: false, p_error: 'Email is not set up (RESEND_API_KEY)' }); return json({ error: 'no key' }, 500); }
  const { data: row } = await sb.from('email_outbox').select('tenant_id').eq('id', id).maybeSingle();
  const bb = await brandFor(sb, row?.tenant_id);
  const unsub = o.person_id ? `${bb.app}/go/?u=${o.person_id}` : '';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:600px">${toHtml(o.body, o.person_id)}
    ${unsub ? `<p style="margin-top:28px;font-size:12px;color:#888">Don't want these emails? <a href="${unsub}" style="color:#888">Unsubscribe</a>.</p>` : ''}</div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromLine(o.account || o.from_name || 'Notifications', 'notify', bb.send),
      to: [o.to], subject: o.subject, html, text: o.body + (unsub ? `\n\nUnsubscribe: ${unsub}` : ''),
      headers: unsub ? { 'List-Unsubscribe': `<${unsub}>` } : undefined,
    }),
  });
  const ok = r.ok;
  const err = ok ? null : (await r.text()).slice(0, 400);
  await sb.rpc('outbox_done', { p_id: id, p_secret: secret, p_ok: ok, p_error: err });
  return json({ ok });
});
