// invite-email: emails someone their invite to the CRM, in the brand of the account's white label.
// Called by the CRM right after an invite is made (Team, Accounts, Platform) and by "Email it again".
// Body: { tenant_id, email }. The caller's own login is used to look the invite up (invite_info), so only
// people who could make the invite can send it. The Resend key lives only in Supabase secrets (RESEND_API_KEY).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { brandFor, fromLine } from '../_shared/brand.ts';
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
const PUBLIC_KEY = envKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const hex = (v: unknown, d: string) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { tenant_id, email } = await req.json();
    if (!tenant_id || !email) return json({ error: 'Missing the account or email' }, 400);
    const auth = req.headers.get('Authorization') || '';
    const asUser = createClient(SB_URL, PUBLIC_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: inv, error } = await asUser.rpc('invite_info', { p_tenant: tenant_id, p_email: email });
    if (error) return json({ error: error.message }, 400);
    if (!inv) return json({ error: 'No open invite for that email, or you can\'t send it' }, 404);

    const b = inv.brand || {};
    const bb = await brandFor(asUser, tenant_id);
    const brand = b.name || bb.name || 'the CRM';
    const main = hex(b.primary_color, '#1A2A52'), accent = hex(b.accent_color, '#C9A04A');
    const base = bb.app;
    const link = `${base}/#signup/${encodeURIComponent(inv.email)}${inv.token ? '/' + encodeURIComponent(inv.token) : ''}`;
    const first = (inv.name || '').split(/\s+/)[0];
    const top = b.logo_url ? `<img src="${esc(b.logo_url)}" alt="${esc(brand)}" style="max-height:40px;max-width:240px">` : esc(b.short_name || brand);
    const html = `<!doctype html><html><body style="margin:0;background:#F3F5F9;font-family:Arial,Helvetica,sans-serif;color:#1A2A52">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DCE2EC;border-radius:12px">
    <tr><td style="background:${main};border-radius:12px 12px 0 0;padding:18px 24px;color:#FFFFFF;font-size:18px;font-weight:bold">${top}</td></tr>
    <tr><td style="padding:24px;font-size:15px;line-height:1.55">
      <h1 style="font-size:21px;margin:0 0 14px">${first ? esc(first) + ', you' : 'You'}'re invited to ${esc(inv.account)}</h1>
      <p>${esc(inv.from_name || 'Someone')} set up a login for you on ${esc(brand)}${inv.is_admin ? ', as an admin of the account' : ''}.</p>
      <p>Tap the button, pick a password and you're in. Use this email address: <b>${esc(inv.email)}</b></p>
      <p style="margin:22px 0"><a href="${esc(link)}" style="background:${accent};color:#FFFFFF;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:8px;display:inline-block">Create my login</a></p>
      <p style="font-size:13px;color:#5B6B8A">${inv.token ? 'This link is just for you, so please don\'t forward it.' : 'After you sign up you\'ll get one more email to confirm your address. Then sign in.'}<br>Button not working? Open ${esc(link)}</p>
    </td></tr></table></td></tr></table></body></html>`;

    const key = Deno.env.get('RESEND_API_KEY');
    if (!key) return json({ error: 'Email is not set up yet (RESEND_API_KEY missing)' }, 500);
    const fromName = String(b.email_from_name || brand).replace(/[<>"]/g, '');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromLine(fromName, 'invites', bb.send), to: [inv.email], subject: `You're invited to ${inv.account}`, html,
        ...(b.support_email ? { reply_to: b.support_email } : {}) }),
    });
    if (!r.ok) return json({ error: `Email failed: ${await r.text()}` }, 502);
    return json({ ok: true, link });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
