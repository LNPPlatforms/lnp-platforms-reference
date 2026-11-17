// booking-email: sends one queued booking email (confirmation with a calendar file, team notice, cancel, moved, reminders).
// The database calls this through pg_net with the email's id and the shared hook secret (schema/078e), so only the
// database can make it send. verify_jwt is off; the secret check happens in cal_mail_take.
// Secrets: RESEND_API_KEY (already set). Links and sending domain: the account's agency (_shared/brand.ts).
// Sender name: the business's own name (decided Nov 2), never the agency's.
// Reply-to on customer emails: the account's own email from its company info, so replies reach the business.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { brandFor, fromLine } from '../_shared/brand.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const SERVICE_KEY = envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const hex = (v: unknown, d: string) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function when(iso: string, tz: string) {
  const d = new Date(iso);
  try {
    return d.toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  } catch { return d.toUTCString(); }
}
function shortWhen(iso: string, tz: string) {
  try { return new Date(iso).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return new Date(iso).toUTCString(); }
}
const mins = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
const lengthText = (m: number) => (m % 60 === 0 ? `${m / 60} ${m === 60 ? 'hour' : 'hours'}` : m > 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} minutes`);
const soon = (m: number | null) => (!m ? 'soon' : m >= 1440 && m % 1440 === 0 ? (m === 1440 ? 'tomorrow' : `in ${m / 1440} days`) : m >= 60 && m % 60 === 0 ? (m === 60 ? 'in 1 hour' : `in ${m / 60} hours`) : `in ${m} minutes`);

// calendar file (RFC 5545). Cancels use the same UID so calendar apps take it off.
const icsText = (s: unknown) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function fold(line: string) {
  const out: string[] = []; let cur = '';
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > (out.length ? 74 : 75)) { out.push(cur); cur = ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}
function ics(o: any, cancel: boolean) {
  const a = o.appointment;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CRM//Booking//EN', 'CALSCALE:GREGORIAN', `METHOD:${cancel ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT', `UID:${a.id}@booking`, `SEQUENCE:${Math.floor(Date.now() / 1000)}`, `DTSTAMP:${icsTime(new Date().toISOString())}`,
    `DTSTART:${icsTime(a.starts_at)}`, `DTEND:${icsTime(a.ends_at)}`,
    `SUMMARY:${icsText(o.for_team ? `${a.title}: ${a.name || ''}` : `${a.title} with ${o.brand?.name || ''}`)}`,
    a.location ? `LOCATION:${icsText(a.location)}` : '',
    `DESCRIPTION:${icsText([a.description, o.manage ? `Change or cancel: ${o.manage}` : ''].filter(Boolean).join('\n'))}`,
    `STATUS:${cancel ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean);
  return lines.map(fold).join('\r\n') + '\r\n';
}
const b64 = (s: string) => { const bytes = new TextEncoder().encode(s); let bin = ''; for (const x of bytes) bin += String.fromCharCode(x); return btoa(bin); };

function build(o: any) {
  const a = o.appointment, b = o.brand || {}, tz = o.time_zone || 'America/Chicago', color = hex(b.color, '#1A2A52');
  const at = when(a.starts_at, tz), at2 = shortWhen(a.starts_at, tz), len = lengthText(mins(a.starts_at, a.ends_at));
  const manage = o.manage;
  const k = o.kind as string;
  const who = a.name || 'Someone';
  const subject = {
    confirm: `You're booked: ${a.title} on ${at2}`, notice: `New booking: ${who}, ${at2}`, cancel: `Cancelled: ${a.title} on ${at2}`,
    cancel_notice: `Cancelled: ${who}, ${at2}`, reschedule: `Moved: ${a.title}, now ${at2}`, reschedule_notice: `Moved: ${who}, now ${at2}`,
    reminder: `Reminder: ${a.title} ${soon(o.minutes)}`,
  }[k] || a.title;
  const head = {
    confirm: "You're booked", notice: `${esc(who)} booked a time with you`, cancel: 'Your booking is cancelled', cancel_notice: `${esc(who)}'s booking is cancelled`,
    reschedule: 'Your booking has moved', reschedule_notice: `${esc(who)}'s booking has moved`, reminder: `See you ${soon(o.minutes)}`,
  }[k] || esc(a.title);
  const rows: [string, string][] = [['When', `${at} (${len})`]];
  if (a.location) rows.push(['Where', a.location]);
  if (o.for_team) {
    rows.push(['Who', [a.name, a.company].filter(Boolean).join(', ')]);
    if (a.email) rows.push(['Email', a.email]);
    if (a.phone) rows.push(['Phone', a.phone]);
    for (const x of a.answers || []) rows.push([x.label, x.value]);
    if (a.cancel_reason && k === 'cancel_notice') rows.push(['Reason', a.cancel_reason]);
  } else if (o.with?.name && k !== 'cancel') rows.push(['With', String(o.with.name).split(' ')[0]]);
  const table = rows.map(([l, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#7C8AA6;vertical-align:top;white-space:nowrap">${esc(l)}</td><td style="padding:6px 0">${esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('');
  const top = b.logo ? `<img src="${esc(b.logo)}" alt="${esc(b.name)}" style="max-height:44px;max-width:220px">` : `<b style="font-size:18px">${esc(b.name)}</b>`;
  const btn = (href: string, label: string) => `<a href="${esc(href)}" style="background:${color};color:#FFFFFF;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px;display:inline-block">${esc(label)}</a>`;
  const action = o.for_team
    ? (o.team_link ? `<p style="margin:20px 0">${btn(o.team_link, 'Open the calendar')}</p>` : '')
    : (k !== 'cancel' && manage && a.allow_changes ? `<p style="margin:20px 0">${btn(manage, 'Change or cancel')}</p>` : '');
  const intro = !o.for_team && k === 'confirm' ? '<p style="margin:0 0 12px">A calendar file is attached so you can add it to your calendar.</p>' : '';
  const html = `<!doctype html><html><body style="margin:0;background:#F3F5F9;font-family:Arial,Helvetica,sans-serif;color:#1A2A52">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DCE2EC;border-radius:12px">
    <tr><td style="padding:18px 24px;border-bottom:3px solid ${color}">${top}</td></tr>
    <tr><td style="padding:24px;font-size:15px;line-height:1.55">
      <p style="margin:0 0 4px;color:#7C8AA6;font-size:13px">${esc(a.title)}</p>
      <h1 style="font-size:22px;margin:0 0 14px">${head}</h1>${intro}
      <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px">${table}</table>
      ${action}
    </td></tr>
    <tr><td style="border-top:1px solid #DCE2EC;padding:14px 24px;font-size:12px;color:#7C8AA6">${[b.name, b.address, b.phone, b.email].filter(Boolean).map(esc).join(' · ')}</td></tr>
  </table></td></tr></table></body></html>`;
  const text = [head.replace(/&#39;/g, "'").replace(/&amp;/g, '&'), '', ...rows.map(([l, v]) => `${l}: ${v}`), '',
    !o.for_team && k !== 'cancel' && manage && a.allow_changes ? `Change or cancel: ${manage}` : '', o.for_team && o.team_link ? `Open the calendar: ${o.team_link}` : ''].filter((x) => x !== undefined).join('\n').trim();
  const attach = ['confirm', 'reschedule', 'cancel', 'notice', 'reschedule_notice', 'cancel_notice'].includes(k)
    ? [{ filename: k.startsWith('cancel') ? 'cancelled.ics' : 'invite.ics', content: b64(ics(o, k.startsWith('cancel'))) }] : [];
  return { subject, html, text, attach };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let id = '', secret = '';
  try { const b = await req.json(); id = String(b.id || ''); secret = String(b.secret || ''); } catch { return json({ error: 'Bad request' }, 400); }
  const sb = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: o, error } = await sb.rpc('cal_mail_take', { p_id: id, p_secret: secret });
  if (error) return json({ error: error.message }, 403);
  if (!o) return json({ ok: true, skipped: true });
  const done = (ok: boolean, err: string | null) => sb.rpc('cal_mail_done', { p_id: id, p_secret: secret, p_ok: ok, p_error: err });
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) { await done(false, 'Email is not set up (RESEND_API_KEY)'); return json({ error: 'no key' }, 500); }
  try {
    const { data: ap } = await sb.from('appointments').select('tenant_id').eq('id', o.appointment.id).maybeSingle();
    const bb = await brandFor(sb, ap?.tenant_id);
    const base = o.app_url || bb.app;
    o.manage = `${base}/book/?m=${encodeURIComponent(o.appointment.token)}`;
    o.team_link = `${base}/#calendar/${o.appointment.date}`;
    const m = build(o);
    const fromName = String(o.from_name || o.brand?.name || 'Bookings').replace(/[<>"\r\n]/g, '');
    const replyTo = o.for_team ? (o.appointment.email || undefined) : (o.brand?.email || undefined);
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromLine(fromName, 'bookings', bb.send), to: [o.to], subject: m.subject, html: m.html, text: m.text,
        ...(replyTo ? { reply_to: replyTo } : {}), ...(m.attach.length ? { attachments: m.attach } : {}) }),
    });
    const ok = r.ok;
    await done(ok, ok ? null : (await r.text()).slice(0, 400));
    return json({ ok });
  } catch (e) {
    await done(false, String((e as Error)?.message || e).slice(0, 400));
    return json({ error: 'send failed' }, 500);
  }
});
