// esign.ts: what both e-sign edge functions share. Emails (Resend, the account's own brand, the white label's sender
// name), who's calling (IP, device, browser) and finishing an envelope (the signed copy, its fingerprint, storing it
// and emailing everyone). The PDF work itself is in esign_pdf.ts.
// Secrets: RESEND_API_KEY. Sending domain: the white label's own (send_domain) when it has one, else SEND_DOMAIN.
// Links: the white label's address, else the page the person is on, else APP_URL.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import * as PDFLib from 'npm:pdf-lib@1.17.1';
import { buildSigned, sha256Hex, uaInfo } from './esign_pdf.ts';

export const BUCKET = 'esign-files';
export const APP = Deno.env.get('APP_URL') || 'https://app.lnpplatforms.com';
const SEND_DOMAIN = Deno.env.get('SEND_DOMAIN') || 'send.gelpstrategies.com';
export const SB_URL = Deno.env.get('SUPABASE_URL')!;
export function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
export const PUBLIC_KEY = envKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
export const admin = () => createClient(SB_URL, envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
export const asUser = (req: Request) => createClient(SB_URL, PUBLIC_KEY, { global: { headers: { Authorization: req.headers.get('Authorization') || '' } }, auth: { persistSession: false, autoRefreshToken: false } });
export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const hex = (v: unknown, d: string) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
const emailOk = (e: unknown) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ''));

// who's calling: the first public address the proxies saw, and what their user agent says
export function meta(req: Request) {
  const ua = (req.headers.get('user-agent') || '').slice(0, 1000);
  const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0] || '').trim().slice(0, 100);
  return { ip, ua, ...uaInfo(ua) };
}

// where links point: the account's white label address (so a signer never sees another agency's), else the page the
// person is on, else APP_URL
export function baseUrl(req: Request, mail?: { domain?: string | null }) {
  if (mail?.domain) return 'https://' + String(mail.domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const o = req.headers.get('origin') || '';
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o) || /^http:\/\/localhost(:\d+)?$/i.test(o)) return o;
  return APP;
}

// the white label's own sending domain, found by its app address
const SENDS = new Map<string, Promise<string>>();
function sendDomainFor(domain?: string | null): Promise<string> {
  const d = String(domain || '').trim().toLowerCase();
  if (!d) return Promise.resolve(SEND_DOMAIN);
  if (!SENDS.has(d)) SENDS.set(d, (async () => {
    try { const { data } = await admin().from('white_labels').select('send_domain').eq('domain', d).maybeSingle();
      return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(data?.send_domain || '') ? data.send_domain : SEND_DOMAIN; } catch { return SEND_DOMAIN; }
  })());
  return SENDS.get(d)!;
}

type Mail = { id: string; title: string; message?: string | null; account?: string; from_name?: string | null; support_email?: string | null; domain?: string | null;
  brand?: { name?: string; logo?: string | null; color?: string | null; email?: string | null; phone?: string | null; address?: string | null };
  sender?: { name?: string; email?: string } | null; expires_at?: string | null };

// the business name only (from_name is the business too, so no "via"; decided Nov 2)
function fromLine(m: Mail, send = SEND_DOMAIN) {
  const acct = String(m.brand?.name || m.account || 'E-sign').replace(/[<>"]/g, '');
  const wl = String(m.from_name || '').replace(/[<>"]/g, '');
  return `${wl && wl !== acct ? `${acct} via ${wl}` : acct} <sign@${send}>`;
}
const replyTo = (m: Mail) => [m.sender?.email, m.brand?.email, m.support_email].find(emailOk);

function shell(m: Mail, inner: string) {
  const b = m.brand || {};
  const color = hex(b.color, '#1A2A52');
  const top = b.logo ? `<img src="${esc(b.logo)}" alt="${esc(b.name)}" style="max-height:44px;max-width:220px">` : `<b style="font-size:18px;color:${color}">${esc(b.name || m.account)}</b>`;
  return `<!doctype html><html><body style="margin:0;background:#F3F5F9;font-family:Arial,Helvetica,sans-serif;color:#1A2A52">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DCE2EC;border-radius:12px">
    <tr><td style="padding:18px 24px;border-bottom:3px solid ${color}">${top}</td></tr>
    <tr><td style="padding:24px;font-size:15px;line-height:1.55">${inner}</td></tr>
    <tr><td style="border-top:1px solid #DCE2EC;padding:14px 24px;font-size:12px;color:#7C8AA6">${[b.name || m.account, b.address, b.phone, b.email].filter(Boolean).map(esc).join(' · ')}</td></tr>
  </table></td></tr></table></body></html>`;
}
const button = (m: Mail, href: string, label: string) =>
  `<p style="margin:22px 0"><a href="${esc(href)}" style="background:${hex(m.brand?.color, '#1A2A52')};color:#FFFFFF;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:8px;display:inline-block">${esc(label)}</a></p>`;

export async function sendMail(m: Mail, to: string, subject: string, html: string, text: string, attachments?: Array<{ filename: string; content: string }>) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new Error('Email is not set up yet (RESEND_API_KEY missing)');
  if (!emailOk(to)) throw new Error(`Bad email address: ${to}`);
  const rt = replyTo(m);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromLine(m, await sendDomainFor(m.domain)), to: [to], subject, html, text, ...(rt ? { reply_to: rt } : {}), ...(attachments?.length ? { attachments } : {}) }),
  });
  if (!r.ok) throw new Error(`Email failed: ${await r.text()}`);
}

// the invite (or a reminder) with the signer's own link
export async function emailInvites(m: Mail, to: Array<{ name: string; email: string; token: string }>, base: string, kind: 'invite' | 'reminder' = 'invite') {
  const sender = m.sender?.name || m.brand?.name || m.account || 'Someone';
  const failed: string[] = [];
  for (const s of to) {
    const link = `${base}/sign/?t=${encodeURIComponent(s.token)}`;
    const first = (s.name || '').split(/\s+/)[0];
    const html = shell(m, `<p style="margin:0 0 4px;color:#7C8AA6;font-size:13px">${kind === 'reminder' ? 'Reminder: waiting on your signature' : 'Document to sign'}</p>
      <h1 style="font-size:22px;margin:0 0 14px">${esc(sender)} sent you ${esc(m.title)} to sign</h1>
      ${first ? `<p>Hi ${esc(first)},</p>` : ''}${m.message ? `<p>${esc(m.message).replace(/\n/g, '<br>')}</p>` : ''}
      ${button(m, link, 'Review and sign')}
      <p style="font-size:13px;color:#5B6B8A">We'll email you a 6 digit code to check it's you before you sign. This link is just for you, so please don't forward it.${m.expires_at ? ` It works until ${esc(new Date(m.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))}.` : ''}<br>Button not working? Open ${esc(link)}</p>`);
    try {
      await sendMail(m, s.email, `${kind === 'reminder' ? 'Reminder: ' : ''}Please sign: ${m.title}`, html,
        `${sender} sent you ${m.title} to sign.\n\n${m.message ? m.message + '\n\n' : ''}Review and sign: ${link}`);
    } catch (e) { failed.push(`${s.email}: ${(e as Error).message}`); }
  }
  return { sent: to.length - failed.length, failed };
}

export async function emailCode(m: Mail, to: string, name: string, code: string, minutes: number) {
  const html = shell(m, `<h1 style="font-size:22px;margin:0 0 14px">Your signing code</h1>
    <p>Use this code to sign ${esc(m.title)}${name ? `, ${esc(name.split(/\s+/)[0])}` : ''}:</p>
    <p style="font-size:34px;font-weight:bold;letter-spacing:8px;margin:18px 0">${esc(code)}</p>
    <p style="font-size:13px;color:#5B6B8A">It works for ${minutes} minutes. If you didn't ask for it, you can ignore this email.</p>`);
  await sendMail(m, to, `${code} is your code to sign ${m.title}`, html, `Your code to sign ${m.title} is ${code}. It works for ${minutes} minutes.`);
}

export async function emailDeclined(m: Mail, who: string, reason: string, base: string) {
  if (!m.sender?.email) return;
  const html = shell(m, `<h1 style="font-size:22px;margin:0 0 14px">${esc(who)} declined ${esc(m.title)}</h1>
    <p><b>Why:</b> ${esc(reason).replace(/\n/g, '<br>')}</p>${button(m, `${base}/#esigndoc/${m.id}`, 'Open it')}`);
  await sendMail(m, m.sender.email, `Declined: ${m.title}`, html, `${who} declined ${m.title}. Why: ${reason}`);
}

const b64 = (bytes: Uint8Array) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

// everyone signed: check the original is untouched, build the signed copy, store it, mark it done and email it out
export async function finish(db: ReturnType<typeof admin>, id: string, base: string) {
  const { data: d, error } = await db.rpc('esign_complete_data', { p_env: id });
  if (error) throw new Error(error.message);
  const { data: file, error: e1 } = await db.storage.from(BUCKET).download(d.file_path);
  if (e1 || !file) throw new Error('Couldn\'t read the original PDF');
  const original = new Uint8Array(await file.arrayBuffer());
  if ((await sha256Hex(original)) !== d.original_sha256) throw new Error('The original PDF changed since it was sent. Nothing was signed into it.');
  const out = await buildSigned(PDFLib, original, d, { verifyUrl: `${base}/sign/?verify=1` });
  const sha = await sha256Hex(out);
  const name = `signed-${String(d.file_name || 'document.pdf').replace(/[^\w.\- ]+/g, '_').replace(/\.pdf$/i, '').slice(0, 80)}.pdf`;
  const path = `${d.tenant_id}/${d.id}/${name}`;
  const { error: e2 } = await db.storage.from(BUCKET).upload(path, out, { contentType: 'application/pdf', upsert: true });
  if (e2) throw new Error(`Couldn't store the signed copy: ${e2.message}`);
  const { data: fin, error: e3 } = await db.rpc('esign_finish', { p_env: id, p_path: path, p_sha: sha });
  if (e3) throw new Error(e3.message);
  const m: Mail = fin.mail;
  const attach = out.length <= 5 * 1024 * 1024 ? [{ filename: name, content: b64(out) }] : undefined;
  const failed: string[] = [];
  const signerEmails = new Set<string>();
  for (const s of fin.to || []) {
    signerEmails.add(String(s.email).toLowerCase());
    const link = `${base}/sign/?t=${encodeURIComponent(s.token)}`;
    const html = shell(m, `<h1 style="font-size:22px;margin:0 0 14px">Everyone signed ${esc(m.title)}</h1>
      <p>${attach ? 'Your signed copy is attached.' : 'Your signed copy is ready.'} It has a signing certificate on the last page.</p>
      ${button(m, link, 'Get the signed copy')}<p style="font-size:13px;color:#5B6B8A">Fingerprint (SHA-256): ${esc(sha)}</p>`);
    try { await sendMail(m, s.email, `Signed: ${m.title}`, html, `Everyone signed ${m.title}. Get your copy: ${link}`, attach); } catch (e) { failed.push((e as Error).message); }
  }
  if (m.sender?.email && !signerEmails.has(m.sender.email.toLowerCase())) {
    const html = shell(m, `<h1 style="font-size:22px;margin:0 0 14px">Everyone signed ${esc(m.title)}</h1>
      <p>The signed copy${attach ? ' is attached and' : ''} is saved with the envelope, with its certificate and event log.</p>
      ${button(m, `${base}/#esigndoc/${m.id}`, 'Open it')}<p style="font-size:13px;color:#5B6B8A">Fingerprint (SHA-256): ${esc(sha)}</p>`);
    try { await sendMail(m, m.sender.email, `Signed: ${m.title}`, html, `Everyone signed ${m.title}.`, attach); } catch (e) { failed.push((e as Error).message); }
  }
  return { ok: true, sha, path, failed };
}
