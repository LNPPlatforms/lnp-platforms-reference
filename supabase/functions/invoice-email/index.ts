// invoice-email: emails a customer their invoice. "Your invoice is $X", the details folded under it, a pay button
// when the account takes payments online (none otherwise), and a link to the full invoice they can print or save as a PDF.
// Body: { id, to?, note? }. The caller's own login looks the invoice up (invoice_email_data), so only people who can
// send that invoice can. Resend key: RESEND_API_KEY. Sender and links: the account's agency (_shared/brand.ts).
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
const money = (n: unknown) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (s: string) => (s ? new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { id, to: toIn, note } = await req.json();
    if (!id) return json({ error: 'Missing the invoice' }, 400);
    const asUser = createClient(SB_URL, PUBLIC_KEY, { global: { headers: { Authorization: req.headers.get('Authorization') || '' } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: d, error } = await asUser.rpc('invoice_email_data', { p_id: id });
    if (error) return json({ error: error.message }, 400);
    // to: one address or a list (up to 10). Everyone picked gets the same email.
    const list = (Array.isArray(toIn) ? toIn : String(toIn || d.to || '').split(/[,;\s]+/)).map((x: unknown) => String(x || '').trim()).filter(Boolean);
    const recips = [...new Set(list.map((x) => x.toLowerCase()))];
    if (!recips.length) return json({ error: 'Add an email address for this customer first' }, 400);
    const badTo = recips.find((x) => !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(x));
    if (badTo) return json({ error: `That doesn't look like an email: ${badTo}` }, 400);
    if (recips.length > 10) return json({ error: 'Ten people at most per send' }, 400);
    const to = recips.join(', ');
    const b = d.brand || {};
    const bb = await brandFor(asUser);   // the account the invoice is in: its agency's address and sending domain
    const color = hex(b.color, '#1A2A52');
    const link = `${bb.app}/doc/?t=${encodeURIComponent(d.token)}`;
    const due = Number(d.balance) > 0 ? Number(d.balance) : Number(d.total);
    const payOn = !!d.pay_method && Number(d.balance) > 0;   // the email marks it sent, so the button works when they tap it
    const top = b.logo ? `<img src="${esc(b.logo)}" alt="${esc(b.name)}" style="max-height:44px;max-width:220px">` : `<b style="font-size:18px">${esc(b.name)}</b>`;
    const rows = (d.lines || []).map((l: any) => `<tr><td style="padding:6px 0;border-bottom:1px solid #EEF1F5">${esc(l.name)}${Number(l.qty) !== 1 ? ` <span style="color:#7C8AA6">x ${esc(l.qty)}</span>` : ''}${l.desc ? `<br><span style="font-size:12px;color:#7C8AA6">${esc(l.desc)}</span>` : ''}</td>
      <td align="right" style="padding:6px 0;border-bottom:1px solid #EEF1F5;white-space:nowrap">${Number(l.retail) > Number(l.price) ? `<s style="color:#9AA5B8">${money(Number(l.retail) * Number(l.qty || 1))}</s> ` : ''}${money(l.total)}</td></tr>`).join('');
    const tot = (label: string, v: unknown, bold = false) => `<tr><td style="padding:4px 0">${bold ? '<b>' : ''}${label}${bold ? '</b>' : ''}</td><td align="right" style="padding:4px 0">${bold ? '<b>' : ''}${money(v)}${bold ? '</b>' : ''}</td></tr>`;
    const totals = [tot('Subtotal', d.subtotal), Number(d.discount) > 0 ? tot('Discount', -Number(d.discount)) : '', Number(d.tax_total) > 0 || d.show_tax ? tot('Tax', d.tax_total) : '',
      tot('Total', d.total, true), Number(d.deposit) > 0 ? tot('Deposit paid', -Number(d.deposit)) : '', Number(d.paid_total) > 0 ? tot('Payments received', -Number(d.paid_total)) : '',
      Number(d.deposit) > 0 || Number(d.paid_total) > 0 ? tot('Balance due', d.balance, true) : '',
      Number(d.savings) > 0 ? `<tr><td style="padding:4px 0;color:#1F7A3A"><b>You saved</b></td><td align="right" style="padding:4px 0;color:#1F7A3A"><b>${money(d.savings)}</b></td></tr>` : ''].join('');
    const html = `<!doctype html><html><body style="margin:0;background:#F3F5F9;font-family:Arial,Helvetica,sans-serif;color:#1A2A52">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DCE2EC;border-radius:12px">
    <tr><td style="padding:18px 24px;border-bottom:3px solid ${color}">${top}</td></tr>
    <tr><td style="padding:24px;font-size:15px;line-height:1.55">
      <p style="margin:0 0 4px;color:#7C8AA6;font-size:13px">Invoice ${esc(d.number)}${d.due_date ? ' · due ' + esc(day(d.due_date)) : ''}</p>
      <h1 style="font-size:24px;margin:0 0 14px">Your invoice is ${money(due)}</h1>
      ${note ? `<p>${esc(note).replace(/\n/g, '<br>')}</p>` : ''}
      ${payOn ? `<p style="margin:20px 0"><a href="${esc(link)}&pay=1" style="background:${color};color:#FFFFFF;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:8px;display:inline-block">Pay ${money(d.balance)}</a></p>` : ''}
      <details style="margin:16px 0"><summary style="cursor:pointer;font-weight:bold">See the details</summary>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:8px">${rows}</table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:8px">${totals}</table></details>
      <p><a href="${esc(link)}" style="color:${color}">View the full invoice</a> (you can print it or save it as a PDF)</p>
      ${d.pay_instructions && !payOn ? `<p style="font-size:13px;color:#5B6B8A">${esc(d.pay_instructions).replace(/\n/g, '<br>')}</p>` : ''}
    </td></tr>
    <tr><td style="border-top:1px solid #DCE2EC;padding:14px 24px;font-size:12px;color:#7C8AA6">${[b.name, b.address, b.phone, b.email].filter(Boolean).map(esc).join(' · ')}</td></tr>
  </table></td></tr></table></body></html>`;
    const key = Deno.env.get('RESEND_API_KEY');
    if (!key) return json({ error: 'Email is not set up yet (RESEND_API_KEY missing)' }, 500);
    const fromName = String(b.name || 'Invoices').replace(/[<>"]/g, '');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromLine(fromName, 'invoices', bb.send), to: recips, subject: `Invoice ${d.number} from ${b.name}: ${money(due)}`, html,
        text: `Your invoice is ${money(due)}.\n\nView it${payOn ? ' and pay' : ''}: ${link}`, ...(b.email || d.reply_to ? { reply_to: b.email || d.reply_to } : {}) }),
    });
    if (!r.ok) return json({ error: `Email failed: ${await r.text()}` }, 502);
    const { error: e2 } = await asUser.rpc('invoice_mark_sent', { p_id: id, p_to: to });
    if (e2) return json({ error: e2.message }, 400);
    return json({ ok: true, to, link });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
