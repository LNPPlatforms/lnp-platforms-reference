// password-reset: emails a "set a new password" link in the agency's brand, linking to the agency's own address.
// Replaces Supabase's own reset email (unbranded, and it sent people to the default address).
// Body: { email }. No login needed. Always answers "sent" so it can't be used to find out who has a login.
// One reset per address per minute (svc_reset_target). The link opens <brand app>/#recover/<token>, which signs them
// in for a password change only.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { brandFor, fromLine } from '../_shared/brand.ts';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const hex = (v: unknown, d: string) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sent = json({ ok: true });
  try {
    const { email } = await req.json();
    const em = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return json({ error: 'That email address doesn\'t look right' }, 400);
    const { data: who } = await svc.rpc('svc_reset_target', { p_email: em });
    if (!who) return sent;
    const { data: link, error } = await svc.auth.admin.generateLink({ type: 'recovery', email: em });
    const th = link?.properties?.hashed_token;
    if (error || !th) return sent;
    const bb = await brandFor(svc, who.tenant_id);
    const { data: b } = await svc.rpc('svc_brand_of', { p_tenant: who.tenant_id });
    const kit = b || {};
    const brand = kit.name || bb.name || 'your CRM';
    const main = hex(kit.primary_color, '#1A2A52'), accent = hex(kit.accent_color, '#C9A04A');
    const url = `${bb.app}/#recover/${encodeURIComponent(th)}`;
    const first = String(who.name || '').split(/\s+/)[0];
    const top = kit.logo_url ? `<img src="${esc(kit.logo_url)}" alt="${esc(brand)}" style="max-height:40px;max-width:240px">` : esc(kit.short_name || brand);
    const html = `<!doctype html><html><body style="margin:0;background:#F3F5F9;font-family:Arial,Helvetica,sans-serif;color:#1A2A52">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DCE2EC;border-radius:12px">
    <tr><td style="background:${main};border-radius:12px 12px 0 0;padding:18px 24px;color:#FFFFFF;font-size:18px;font-weight:bold">${top}</td></tr>
    <tr><td style="padding:24px;font-size:15px;line-height:1.55">
      <h1 style="font-size:21px;margin:0 0 14px">${first ? esc(first) + ', set' : 'Set'} a new password</h1>
      <p>Someone asked to reset the password for <b>${esc(em)}</b> on ${esc(brand)}. Tap the button to pick a new one.</p>
      <p style="margin:22px 0"><a href="${esc(url)}" style="background:${accent};color:#FFFFFF;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:8px;display:inline-block">Set a new password</a></p>
      <p style="font-size:13px;color:#5B6B8A">The link works once and runs out in an hour. Didn't ask for this? Ignore it. Your password stays the same.</p>
    </td></tr></table></td></tr></table></body></html>`;
    const key = Deno.env.get('RESEND_API_KEY');
    if (!key) return json({ error: 'Email is not set up yet (RESEND_API_KEY missing)' }, 500);
    const fromName = String(kit.email_from_name || brand).replace(/[<>"]/g, '');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromLine(fromName, 'accounts', bb.send), to: [em], subject: `Set a new password for ${brand}`, html,
        ...(kit.support_email || bb.support ? { reply_to: kit.support_email || bb.support } : {}) }),
    });
    if (!r.ok) return json({ error: `Email failed: ${await r.text()}` }, 502);
    return sent;
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
