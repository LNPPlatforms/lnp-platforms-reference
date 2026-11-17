// portal-invite-email: emails someone their client portal invite, in the account's own brand (brand kit logo and
// color, white label domain when there is one). Called by the CRM's Client portal card and by a client's admin on
// the portal's Team tab, right after the invite is made and by "Email it again".
// Body: { id } (the portal user). The caller's own login looks the invite up (portal_invite_info), so only the
// account's team or that client's admin can send it. The Resend key lives only in Supabase secrets (RESEND_API_KEY).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { APP_URL as APP, SEND_DOMAIN, fromLine } from '../_shared/brand.ts';
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
    const { id } = await req.json();
    if (!id) return json({ error: 'Missing the invite' }, 400);
    const auth = req.headers.get('Authorization') || '';
    const asUser = createClient(SB_URL, PUBLIC_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: inv, error } = await asUser.rpc('portal_invite_info', { p_id: id });
    if (error) return json({ error: error.message }, 400);
    if (!inv) return json({ error: 'No open invite there, or you can\'t send it' }, 404);

    const b = inv.brand || {};
    const brand = b.name || inv.account || 'Client portal';
    const main = hex(b.color, '#1A2A52');
    const base = inv.domain ? 'https://' + String(inv.domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : APP;
    const q = inv.slug ? `?a=${encodeURIComponent(inv.slug)}` : '';
    const link = inv.has_login ? `${base}/portal/${q}` : `${base}/portal/${q}#signup/${encodeURIComponent(inv.email)}`;
    const first = (inv.name || '').split(/\s+/)[0];
    const top = b.logo ? `<img src="${esc(b.logo)}" alt="${esc(brand)}" style="max-height:44px;max-width:240px">` : `<span style="color:${main};font-size:20px;font-weight:bold">${esc(brand)}</span>`;
    const what = inv.is_admin ? `You're the admin for ${esc(inv.org)}, so you can invite the rest of your people and choose what each one sees.` : '';
    const html = `<!doctype html><html><body style="margin:0;background:#F3F5F9;font-family:Arial,Helvetica,sans-serif;color:#1d2433">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DCE2EC;border-radius:12px;border-top:4px solid ${main}">
    <tr><td style="padding:20px 24px 0">${top}</td></tr>
    <tr><td style="padding:16px 24px 24px;font-size:15px;line-height:1.55">
      <h1 style="font-size:21px;margin:0 0 14px">${first ? esc(first) + ', your' : 'Your'} ${esc(brand)} client portal is ready</h1>
      <p>${esc(inv.from_name || brand)} gave you a login for ${esc(inv.org)}. See your schedule, estimates and invoices, pay online and message the team in one place.</p>
      ${what ? `<p>${what}</p>` : ''}
      <p>${inv.has_login ? 'Sign in with the login you already have' : 'Tap the button, pick a password and you\'re in. Use this email address'}: <b>${esc(inv.email)}</b></p>
      <p style="margin:22px 0"><a href="${esc(link)}" style="background:${main};color:#FFFFFF;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:8px;display:inline-block">${inv.has_login ? 'Open my portal' : 'Create my login'}</a></p>
      <p style="font-size:13px;color:#5B6B8A">${inv.has_login ? '' : 'After you sign up you\'ll get one more email to confirm your address. Then sign in.<br>'}Button not working? Open ${esc(link)}</p>
    </td></tr></table></td></tr></table></body></html>`;

    const key = Deno.env.get('RESEND_API_KEY');
    if (!key) return json({ error: 'Email is not set up yet (RESEND_API_KEY missing)' }, 500);
    const fromName = String(inv.from_label || brand).replace(/[<>"]/g, '');
    const replyTo = b.email || inv.reply_to;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromLine(fromName, 'invites', /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(inv.send_domain || '') ? inv.send_domain : SEND_DOMAIN), to: [inv.email], subject: `Your ${brand} client portal`, html,
        ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    if (!r.ok) return json({ error: `Email failed: ${await r.text()}` }, 502);
    return json({ ok: true, link });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
