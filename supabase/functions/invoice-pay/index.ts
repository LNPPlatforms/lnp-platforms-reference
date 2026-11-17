// invoice-pay: the pay button on an invoice (/doc/?t=...). The share token is the credential, same as the page itself.
//   { token, action: 'start' }  -> { url } to Stripe Checkout (or the account's pasted payment link), or { paid: true }
//   { token, action: 'status' } -> { pay_status } after checking Stripe for the latest checkout
//   { token, action: 'card' }   -> { url } to Stripe Checkout in setup mode, to save or replace the card or bank on file
// Autopay (083a): when the invoice is part of a repeating series with autopay on, paying it also saves the card or bank
// in Stripe for the next ones (Stripe shows the customer that it's being saved). Only Stripe's ids and a label like
// "Visa ending 4242" are kept in the CRM.
// Processor per account: its own Stripe through Connect (Standard account, direct charge, no platform fee), GELP's own
// Stripe for GELP's account (same switch as proposals), or a pasted link. No processor: no button, and this says so.
// Keys: _shared/stripe_keys.ts (LNP's for connected and house accounts, GELP's for GELP's own switch).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { keyFor } from '../_shared/stripe_keys.ts';

const APP = Deno.env.get('APP_URL') || 'https://app.gelpstrategies.com';
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

function flatten(obj: any, prefix = '', out: [string, string][] = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') flatten(v, key, out); else out.push([key, String(v)]);
  }
  return out;
}
async function stripe(path: string, method = 'GET', body?: Record<string, unknown>, account?: string, tenant?: string) {
  const key = await keyFor(db, tenant, account);
  if (!key) throw Object.assign(new Error('Online payment is not set up yet'), { code: 'not_configured' });
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(account ? { 'Stripe-Account': account } : {}) },
    body: body ? new URLSearchParams(flatten(body)).toString() : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'Stripe error');
  return data;
}
// back to the page the customer came from (the browser sets Origin; only https)
const base = (req: Request) => { const o = req.headers.get('origin') || ''; return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o) ? o : APP; };

// the card or bank the customer just saved, for the series (also done by stripe-webhook; either one is enough)
async function saveCard(inv: any, s: any, acct?: string) {
  if (s.metadata?.save !== '1' || !s.customer) return false;
  let pmId: string | undefined;
  if (s.setup_intent) pmId = (await stripe(`setup_intents/${typeof s.setup_intent === 'string' ? s.setup_intent : s.setup_intent.id}`, 'GET', undefined, acct, inv.tenant_id)).payment_method;
  else if (s.payment_intent) pmId = (await stripe(`payment_intents/${typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent.id}`, 'GET', undefined, acct, inv.tenant_id)).payment_method;
  if (!pmId) return false;
  const pm = await stripe(`payment_methods/${pmId}`, 'GET', undefined, acct, inv.tenant_id);
  const label = pm.card ? `${String(pm.card.brand || 'Card').replace(/^\w/, (c: string) => c.toUpperCase())} ending ${pm.card.last4}`
    : pm.us_bank_account ? `${pm.us_bank_account.bank_name || 'Bank'} account ending ${pm.us_bank_account.last4}` : 'Saved payment method';
  await stripe(`customers/${s.customer}`, 'POST', { invoice_settings: { default_payment_method: pmId } }, acct, inv.tenant_id).catch(() => {});
  const { data } = await db.rpc('invoice_autopay_card_saved', { p_invoice: inv.id, p_customer: s.customer, p_pm: pmId, p_label: label, p_account: acct || null });
  return !!data;
}

async function markFromSession(inv: any, s: any, acct?: string) {
  if (s.status !== 'complete') return null;
  try { await saveCard(inv, s, acct); } catch (e) { console.error('save card', (e as Error).message); }
  if (s.mode === 'setup') return 'saved';
  if (s.payment_status === 'paid') {
    const method = (s.payment_method_types || []).includes('us_bank_account') && !(s.payment_method_types || []).includes('card') ? 'bank' : 'card';
    await db.rpc('invoice_stripe_paid', { p_invoice: inv.id, p_session: s.id, p_amount: (s.amount_total || 0) / 100, p_method: method });
    return 'paid';
  }
  return 'processing';   // a bank payment still clearing; the webhook posts it when it clears
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const token = String(body.token || '');
  if (token.length < 32) return json({ error: 'Bad request' }, 400);
  try {
    const { data: inv } = await db.rpc('invoice_pay_info', { p_token: token });
    if (!inv) return json({ error: 'Invoice not found' }, 404);
    if (inv.status === 'void' || inv.status === 'draft') return json({ error: 'This invoice isn\'t open for payment' }, 400);
    if (!inv.method) return json({ error: 'Online payment isn\'t set up for this account', not_configured: true });
    if (inv.method === 'link') return json({ url: inv.link });
    const acct = inv.method === 'stripe' ? inv.stripe_account : undefined;
    if (inv.method === 'stripe' && !acct) return json({ error: 'Online payment isn\'t set up for this account', not_configured: true });

    if (body.action === 'status') {
      if (!inv.session) return json({ pay_status: null });
      return json({ pay_status: await markFromSession(inv, await stripe(`checkout/sessions/${inv.session}`, 'GET', undefined, acct, inv.tenant_id), acct) });
    }
    const back = `${base(req)}/doc/?t=${encodeURIComponent(token)}`;
    const meta = { invoice_id: inv.id, kind: 'invoice', number: String(inv.number) };
    const email = /^\S+@\S+\.\S+$/.test(inv.email || '') ? inv.email : undefined;
    // a customer in this account's Stripe for the series (a new one if the series moved to another Stripe account)
    const customerFor = async () => (inv.customer && (inv.customer_account || null) === (acct || null)) ? inv.customer
      : (await stripe('customers', 'POST', { email, name: inv.org || undefined, metadata: { invoice_id: inv.id } }, acct, inv.tenant_id)).id;

    if (body.action === 'card') {
      if (!inv.autopay) return json({ error: 'This invoice isn\'t set up for automatic payments' }, 400);
      const s = await stripe('checkout/sessions', 'POST', { mode: 'setup', currency: 'usd', customer: await customerFor(), client_reference_id: inv.id,
        metadata: { ...meta, save: '1' }, setup_intent_data: { metadata: { ...meta, save: '1' } },
        success_url: `${back}&paid=1`, cancel_url: back }, acct, inv.tenant_id);
      await db.rpc('invoice_session_set', { p_id: inv.id, p_session: s.id });
      return json({ url: s.url });
    }
    if (body.action !== 'start') return json({ error: 'Unknown request' }, 400);
    if (inv.status === 'paid') return json({ paid: true, pay_status: 'paid' });
    if (!['sent', 'partial'].includes(inv.status) || Number(inv.balance) <= 0) return json({ error: 'This invoice isn\'t open for payment' }, 400);

    // reuse an open checkout for the same amount
    if (inv.session) {
      try {
        const s = await stripe(`checkout/sessions/${inv.session}`, 'GET', undefined, acct, inv.tenant_id);
        if (s.status === 'open' && s.url && s.amount_total === Math.round(Number(inv.balance) * 100)) return json({ url: s.url });
        if (s.status === 'complete' && s.mode === 'payment') { const st = await markFromSession(inv, s, acct); if (st) return json({ paid: st === 'paid', pay_status: st }); }
      } catch { /* old session from another account: make a new one */ }
    }
    const save = inv.autopay && !inv.card_saved;   // paying also saves the card or bank for the next invoices in the series
    const s = await stripe('checkout/sessions', 'POST', {
      mode: 'payment', client_reference_id: inv.id, metadata: { ...meta, ...(save ? { save: '1' } : {}) },
      ...(save ? { customer: await customerFor() } : { customer_email: email }),
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(Number(inv.balance) * 100),
        product_data: { name: `Invoice ${inv.number}`, description: `${inv.account || 'Payment'} for ${inv.org || 'your account'}`.slice(0, 480) } } }],
      payment_intent_data: { metadata: meta, description: `Invoice ${inv.number} (${inv.org || ''})`, ...(save ? { setup_future_usage: 'off_session' } : {}) },
      success_url: `${back}&paid=1`, cancel_url: back,
    }, acct, inv.tenant_id);
    await db.rpc('invoice_session_set', { p_id: inv.id, p_session: s.id });
    return json({ url: s.url });
  } catch (e) {
    const err = e as any;
    if (err.code === 'not_configured') return json({ error: err.message, not_configured: true });
    console.error('invoice-pay', err.message);
    return json({ error: err.message }, 500);
  }
});
