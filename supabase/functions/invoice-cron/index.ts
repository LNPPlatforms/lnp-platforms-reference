// invoice-cron: the daily invoice job (schema/083a, pg_cron "invoice-daily" at 8:07 am Central). The database makes the
// invoices that are due from each repeating series and adds late fees, then hands back three lists:
//   charges:   autopay invoices to charge to the card or bank the customer saved in Stripe (off session)
//   emails:    new invoices from a series set to go out on their own
//   reminders: invoices past due 3, 10 and 17 days that aren't being paid by autopay
// A failed charge emails the client (pay link and a way to update the card) and shows the account's admins in Review;
// it's tried again in 3 days, 3 tries in all. Only the database can start this: it sends the shared hook secret, and
// invoice_cron_take refuses anything else. verify_jwt is off. Secrets: RESEND_API_KEY, LNP_STRIPE_SECRET_KEY and STRIPE_SECRET_KEY (_shared/stripe_keys.ts).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { keyFor } from '../_shared/stripe_keys.ts';
import { brandFor, fromLine } from '../_shared/brand.ts';

function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const db = createClient(Deno.env.get('SUPABASE_URL')!, envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const hex = (v: unknown, d: string) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);
const money = (n: unknown) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (s: string) => (s ? new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const okEmail = (s: unknown) => /^\S+@\S+\.\S+$/.test(String(s || ''));

function flatten(obj: any, prefix = '', out: [string, string][] = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') flatten(v, key, out); else out.push([key, String(v)]);
  }
  return out;
}
async function stripe(path: string, body: Record<string, unknown>, account?: string, idem?: string, tenant?: string) {
  const key = await keyFor(db, tenant, account);
  if (!key) throw new Error('Online payment is not set up yet');
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded',
      ...(account ? { 'Stripe-Account': account } : {}), ...(idem ? { 'Idempotency-Key': idem } : {}) },
    body: new URLSearchParams(flatten(body)).toString(),
  });
  const data = await r.json();
  if (!r.ok) { const e: any = new Error(data?.error?.message || 'Stripe error'); e.pi = data?.error?.payment_intent; throw e; }
  return data;
}

// each account's web address: its own white label, or its agency's
async function hostFor(tenant: string) { return (await brandFor(db, tenant)).app; }

async function send(d: any, to: string, subject: string, intro: string, opts: { button?: string; buttonUrl?: string; details?: boolean; footNote?: string } = {}) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new Error('RESEND_API_KEY missing');
  const b = d.brand || {};
  const color = hex(b.color, '#1A2A52');
  const link = `${await hostFor(d.tenant_id)}/doc/?t=${encodeURIComponent(d.token)}`;
  const top = b.logo ? `<img src="${esc(b.logo)}" alt="${esc(b.name)}" style="max-height:44px;max-width:220px">` : `<b style="font-size:18px">${esc(b.name)}</b>`;
  const rows = (d.lines || []).map((l: any) => `<tr><td style="padding:6px 0;border-bottom:1px solid #EEF1F5">${esc(l.name)}${Number(l.qty) !== 1 ? ` <span style="color:#7C8AA6">x ${esc(l.qty)}</span>` : ''}</td>
    <td align="right" style="padding:6px 0;border-bottom:1px solid #EEF1F5;white-space:nowrap">${Number(l.retail) > Number(l.price) ? `<s style="color:#9AA5B8">${money(Number(l.retail) * Number(l.qty || 1))}</s> ` : ''}${money(l.total)}</td></tr>`).join('');
  const tot = (label: string, v: unknown, bold = false) => `<tr><td style="padding:4px 0">${bold ? '<b>' : ''}${label}${bold ? '</b>' : ''}</td><td align="right" style="padding:4px 0">${bold ? '<b>' : ''}${money(v)}${bold ? '</b>' : ''}</td></tr>`;
  const totals = [tot('Total', d.total, true), Number(d.paid_total) > 0 || Number(d.deposit) > 0 ? tot('Balance due', d.balance, true) : '',
    Number(d.savings) > 0 ? `<tr><td style="padding:4px 0;color:#1F7A3A"><b>You saved</b></td><td align="right" style="padding:4px 0;color:#1F7A3A"><b>${money(d.savings)}</b></td></tr>` : ''].join('');
  const btnUrl = opts.buttonUrl ? link + opts.buttonUrl : link;
  const html = `<!doctype html><html><body style="margin:0;background:#F3F5F9;font-family:Arial,Helvetica,sans-serif;color:#1A2A52">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DCE2EC;border-radius:12px">
    <tr><td style="padding:18px 24px;border-bottom:3px solid ${color}">${top}</td></tr>
    <tr><td style="padding:24px;font-size:15px;line-height:1.55">
      <p style="margin:0 0 4px;color:#7C8AA6;font-size:13px">Invoice ${esc(d.number)}${d.due_date ? ' · due ' + esc(day(d.due_date)) : ''}</p>
      ${intro}
      ${opts.button ? `<p style="margin:20px 0"><a href="${esc(btnUrl)}" style="background:${color};color:#FFFFFF;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:8px;display:inline-block">${esc(opts.button)}</a></p>` : ''}
      ${opts.details !== false ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:8px">${rows}</table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:8px">${totals}</table>` : ''}
      <p><a href="${esc(link)}" style="color:${color}">View the full invoice</a> (you can print it or save it as a PDF)</p>
      ${opts.footNote ? `<p style="font-size:13px;color:#5B6B8A">${opts.footNote}</p>` : ''}
    </td></tr>
    <tr><td style="border-top:1px solid #DCE2EC;padding:14px 24px;font-size:12px;color:#7C8AA6">${[b.name, b.address, b.phone, b.email].filter(Boolean).map(esc).join(' · ')}</td></tr>
  </table></td></tr></table></body></html>`;
  const fromName = String(b.name || 'Invoices').replace(/[<>"]/g, '');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromLine(fromName, 'invoices', (await brandFor(db, d.tenant_id)).send), to: [to], subject, html, text: `${subject}\n\nView it: ${link}`, ...(okEmail(b.email) ? { reply_to: b.email } : {}) }),
  });
  if (!r.ok) throw new Error(`Email failed: ${await r.text()}`);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let secret = '';
  try { secret = String((await req.json()).secret || ''); } catch { return json({ error: 'Bad request' }, 400); }
  const { data: work, error } = await db.rpc('invoice_cron_take', { p_secret: secret });
  if (error) return json({ error: error.message }, 403);
  const done = (p: Record<string, unknown>) => db.rpc('invoice_cron_done', { p_secret: secret, p });
  const log: string[] = [`made ${work.made}`, `late fees ${work.late_fees}`];
  const paidNow = new Map<string, string>();   // invoice id -> card label, for the receipt wording
  const failedNow = new Set<string>();          // charged and declined just now: the failure email already went out

  // 1. autopay charges
  for (const c of work.charges || []) {
    const acct = c.method === 'stripe' ? c.acct : undefined;
    const fail = async (msg: string) => {
      await done({ kind: 'charge_failed', id: c.id, error: msg }); failedNow.add(c.id);
      log.push(`charge failed ${c.number}: ${msg}`);
      if (okEmail(c.to)) {
        const last = c.attempt >= 3;
        await send(c, c.to, `Payment didn't go through: invoice ${c.number} (${money(c.balance)})`,
          `<h1 style="font-size:22px;margin:0 0 12px">We couldn't charge ${esc(c.pm_label || 'your saved payment method')}</h1>
           <p>The automatic payment of <b>${money(c.balance)}</b> for invoice ${esc(c.number)} didn't go through${msg ? ` (${esc(msg.replace(/\.$/, ''))})` : ''}.
           ${last ? 'Please pay it from the link below or update your card.' : 'We\'ll try again in 3 days. You can also pay now or update your card.'}</p>`,
          { button: `Pay ${money(c.balance)}`, buttonUrl: '&pay=1', footNote: `Need to use a different card or bank? <a href="${esc(await hostFor(c.tenant_id))}/doc/?t=${encodeURIComponent(c.token)}&card=1">Update it here</a>.` })
          .catch((e) => log.push(`fail email ${c.number}: ${e.message}`));
      }
    };
    if (!c.method || c.method === 'link') { await fail('Online payments are turned off for this account'); continue; }
    if ((c.stripe_account || null) !== (acct || null)) { await fail('The saved card belongs to a different Stripe account. Please save it again.'); continue; }
    try {
      const pi = await stripe('payment_intents', {
        amount: Math.round(Number(c.balance) * 100), currency: 'usd', customer: c.customer, payment_method: c.pm, off_session: true, confirm: true,
        payment_method_types: ['card', 'us_bank_account'],
        description: `Invoice ${c.number} (autopay)`,
        metadata: { kind: 'invoice_autopay', invoice_id: c.id, number: String(c.number), attempt: String(c.attempt) },
      }, acct, `autopay-${c.id}-${c.attempt}`, c.tenant_id);
      if (pi.status === 'succeeded') {
        await done({ kind: 'charged', id: c.id, amount: pi.amount_received / 100, ref: pi.id, label: c.pm_label || 'Autopay', method: 'card' });
        paidNow.set(c.id, c.pm_label || 'your saved payment method');
        log.push(`charged ${c.number} ${money(pi.amount_received / 100)}`);
      } else if (pi.status === 'processing') {
        await done({ kind: 'processing', id: c.id }); log.push(`bank payment started ${c.number}`);
      } else {
        await fail('Your bank needs you to confirm this payment');
      }
    } catch (e) { await fail((e as Error).message); }
  }

  // 2. new invoices from a series that go out on their own (a receipt when autopay just paid it)
  for (const d of work.emails || []) {
    if (!okEmail(d.to)) { log.push(`no email for ${d.number}`); continue; }
    if (failedNow.has(d.id)) { await done({ kind: 'emailed', id: d.id, to: d.to }); continue; }
    try {
      const paid = paidNow.get(d.id);
      if (paid) {
        await send(d, d.to, `Receipt: invoice ${d.number} paid (${money(d.total)})`,
          `<h1 style="font-size:22px;margin:0 0 12px">Paid, thank you</h1><p>We charged <b>${money(d.total)}</b> to ${esc(paid)} for invoice ${esc(d.number)}.</p>`);
      } else {
        const payOn = !!d.pay_method && Number(d.balance) > 0;
        const auto = d.autopay ? `<p style="font-size:14px;color:#5B6B8A">This will be charged to ${esc(d.pm_label || 'your saved payment method')} automatically.</p>` : '';
        await send(d, d.to, `Invoice ${d.number} from ${d.brand?.name || ''}: ${money(d.balance)}`,
          `<h1 style="font-size:24px;margin:0 0 14px">Your invoice is ${money(d.balance)}</h1>${auto}`,
          payOn && !d.autopay ? { button: `Pay ${money(d.balance)}`, buttonUrl: '&pay=1' } : {});
      }
      await done({ kind: 'emailed', id: d.id, to: d.to }); log.push(`emailed ${d.number}`);
    } catch (e) { log.push(`email ${d.number}: ${(e as Error).message}`); }
  }

  // 3. reminders
  for (const d of work.reminders || []) {
    if (!okEmail(d.to)) { log.push(`no email for reminder ${d.number}`); continue; }
    try {
      const payOn = !!d.pay_method;
      await send(d, d.to, `Reminder: invoice ${d.number} is past due (${money(d.balance)})`,
        `<h1 style="font-size:22px;margin:0 0 12px">A friendly reminder</h1><p>Invoice ${esc(d.number)} for <b>${money(d.balance)}</b> was due ${esc(day(d.due_date))}. If you've already paid, thank you, and please ignore this.</p>`,
        payOn ? { button: `Pay ${money(d.balance)}`, buttonUrl: '&pay=1' } : {});
      await done({ kind: 'reminded', id: d.id }); log.push(`reminded ${d.number}`);
    } catch (e) { log.push(`reminder ${d.number}: ${(e as Error).message}`); }
  }
  console.log('invoice-cron', log.join(' | '));
  return json({ ok: true, log });
});
