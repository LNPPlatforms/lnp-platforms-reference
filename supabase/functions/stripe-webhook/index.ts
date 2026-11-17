// stripe-webhook: Stripe tells the CRM when a proposal or invoice checkout is paid (cards right away, bank transfers when they clear).
// Signature checked with STRIPE_WEBHOOK_SECRET (GELP's own Stripe), LNP_STRIPE_WEBHOOK_SECRET (LNP's own Stripe: house
// accounts like Cognix) or STRIPE_CONNECT_WEBHOOK_SECRET (LNP's Connect endpoint, for invoices paid to an account's own
// Stripe). Whichever secret matches says which Stripe the event came from, so follow-up calls use that Stripe's key. Events used:
//   checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed
//   payment_intent.succeeded, payment_intent.payment_failed (autopay on a repeating invoice, 083a: bank payments that
//   clear or bounce days later; card charges are already recorded by invoice-cron, and repeats are ignored)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { AsyncLocalStorage } from 'node:async_hooks';
import { gelpKey, lnpKey } from '../_shared/stripe_keys.ts';
const SRC = new AsyncLocalStorage<'gelp' | 'lnp'>();   // which Stripe sent the event being handled
const keyNow = (account?: string) => (account || SRC.getStore() === 'lnp' ? lnpKey() : gelpKey());

function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const db = createClient(Deno.env.get('SUPABASE_URL')!, envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false, autoRefreshToken: false } });
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

async function verify(raw: string, header: string, secret: string) {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]).filter((kv) => kv.length === 2 && kv[0] !== 'v1'));
  const sigs = header.split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${raw}`)));
  return sigs.some((s) => s.length === mac.length && [...s].every((c, i) => c === mac[i]));
}

// Stripe calls, for startExtras (kept the same as in proposal-checkout)
async function stripe(path: string, method = 'GET', body?: Record<string, unknown>, idem?: string) {
  const flat = (obj: any, prefix = '', out: [string, string][] = []) => {
    for (const [k, v] of Object.entries(obj)) { if (v === undefined || v === null) continue; const key = prefix ? `${prefix}[${k}]` : k;
      if (typeof v === 'object') flat(v, key, out); else out.push([key, String(v)]); }
    return out;
  };
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { method,
    headers: { Authorization: `Bearer ${keyNow()}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idem ? { 'Idempotency-Key': idem } : {}) },
    body: body ? new URLSearchParams(flat(body)).toString() : undefined });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'Stripe error');
  return data;
}
// Recurring billing is split into groups by cycle (month, week) and free trial. Stripe's checkout runs one
// subscription, so the first group that bills right away goes through checkout and every other group is started on
// the same customer and payment method the moment checkout completes (startExtras, also run by stripe-webhook).
// If every recurring group is on a free trial, checkout only takes the setup fee (or just saves the card) and all
// groups start here. Groups ride along in the session metadata as "month:49900:30,week:20000:0".
async function startExtras(p: any, s: any) {
  const x = String(s.metadata?.x || '');
  if (!x || s.status !== 'complete' || !s.customer || p.stripe_extra_subs) return null;
  const groups = x.split(',').map((g) => { const [interval, amt, trial] = g.split(':'); return { interval, amount: parseInt(amt, 10), trial: parseInt(trial, 10) || 0 }; })
    .filter((g) => (g.interval === 'month' || g.interval === 'week') && g.amount > 0);
  if (!groups.length) return null;
  const tag = `${p.id}-v${s.metadata?.version || p.pay_version}`;
  let pm: string | undefined;
  if (s.subscription) pm = (await stripe(`subscriptions/${s.subscription}`)).default_payment_method || undefined;
  else if (s.payment_intent) pm = (await stripe(`payment_intents/${s.payment_intent}`)).payment_method || undefined;
  else if (s.setup_intent) pm = (await stripe(`setup_intents/${s.setup_intent}`)).payment_method || undefined;
  if (pm && !s.subscription) await stripe(`customers/${s.customer}`, 'POST', { invoice_settings: { default_payment_method: pm } });
  const org = s.metadata?.org || 'your organization';
  const out: any[] = [];
  for (const [i, g] of groups.entries()) {
    const meta = { proposal_id: p.id, version: String(s.metadata?.version || p.pay_version), org, kind: `${g.interval}${g.trial ? '-trial' : ''}` };
    const label = g.interval === 'week' ? 'Weekly' : 'Monthly';
    const prod = await stripe('products', 'POST', { name: `${label} services (${org})`, metadata: meta }, `prod-${tag}-${i}`);
    const sub = await stripe('subscriptions', 'POST', { customer: s.customer, default_payment_method: pm,
      items: [{ price_data: { currency: 'usd', product: prod.id, unit_amount: g.amount, recurring: { interval: g.interval } } }],
      ...(g.trial ? { trial_period_days: g.trial } : {}),
      description: `GELP Strategies ${label.toLowerCase()} services for ${org}${g.trial ? ` (${g.trial} day free trial)` : ''}`, metadata: meta }, `sub-${tag}-${i}`);
    out.push({ id: sub.id, interval: g.interval, amount: g.amount / 100, trial: g.trial });
  }
  const { data: done } = await db.from('proposals').update({ stripe_extra_subs: out }).eq('id', p.id).is('stripe_extra_subs', null).select('id');
  if (done?.length) {
    const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const when = (d: number) => new Date(Date.now() + d * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
    await db.from('activities').insert({ company_id: p.company_id, type: 'note', created_by: p.owner_id,
      body: `Recurring billing set up through Stripe for proposal version ${s.metadata?.version || p.pay_version}: ` + out.map((g) =>
        `${money(g.amount)}/${g.interval === 'week' ? 'week' : 'mo'}${g.trial ? `, ${g.trial} day free trial, first charge ${when(g.trial)}` : ', started now'}`).join('; ') + '.' });
  }
  p.stripe_extra_subs = out;
  return out;
}

// GET from a connected account (autopay cards saved on an account's own Stripe)
async function stripeGet(path: string, account?: string) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${keyNow(account)}`, ...(account ? { 'Stripe-Account': account } : {}) } });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'Stripe error');
  return data;
}
// the card or bank a customer saved for a repeating invoice (invoice-pay does the same when they land back on the page)
async function saveCard(invoiceId: string, s: any, account?: string) {
  if (s.metadata?.save !== '1' || !s.customer) return;
  const intent = s.setup_intent ? await stripeGet(`setup_intents/${s.setup_intent}`, account) : s.payment_intent ? await stripeGet(`payment_intents/${s.payment_intent}`, account) : null;
  if (!intent?.payment_method) return;
  const pm = await stripeGet(`payment_methods/${intent.payment_method}`, account);
  const label = pm.card ? `${String(pm.card.brand || 'Card').replace(/^\w/, (c: string) => c.toUpperCase())} ending ${pm.card.last4}`
    : pm.us_bank_account ? `${pm.us_bank_account.bank_name || 'Bank'} account ending ${pm.us_bank_account.last4}` : 'Saved payment method';
  await db.rpc('invoice_autopay_card_saved', { p_invoice: invoiceId, p_customer: s.customer, p_pm: intent.payment_method, p_label: label, p_account: account || null });
}
// 084a: a proposal paid online becomes a paid invoice plus repeating invoices with autopay (same as proposal-checkout;
// whichever sees the payment first does it, the database makes sure it only happens once)
async function proposalToInvoices(p: any, s: any, method: string) {
  if (s.metadata?.flow !== 'inv' || s.status !== 'complete') return;
  const intent = s.payment_intent ? await stripeGet(`payment_intents/${s.payment_intent}`) : s.setup_intent ? await stripeGet(`setup_intents/${s.setup_intent}`) : null;
  const pmId = intent?.payment_method || null;
  let label: string | null = null;
  if (pmId) {
    const pm = await stripeGet(`payment_methods/${pmId}`);
    label = pm.card ? `${String(pm.card.brand || 'Card').replace(/^\w/, (c: string) => c.toUpperCase())} ending ${pm.card.last4}`
      : pm.us_bank_account ? `${pm.us_bank_account.bank_name || 'Bank'} account ending ${pm.us_bank_account.last4}` : 'Saved payment method';
    if (s.customer) await stripe(`customers/${s.customer}`, 'POST', { invoice_settings: { default_payment_method: pmId } }).catch(() => {});
  }
  const { error } = await db.rpc('proposal_paid_to_invoices', { p_proposal: p.id, p_session: s.id, p_amount: (s.amount_total || 0) / 100,
    p_method: method, p_customer: s.customer || null, p_pm: pmId, p_label: label });
  if (error) console.error('proposal to invoices', error.message);
}
async function note(p: any, body: string) {
  await db.from('activities').insert({ company_id: p.company_id, type: 'note', created_by: p.owner_id, body });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const raw = await req.text();
  const sig = req.headers.get('stripe-signature') || '';
  let src: 'gelp' | 'lnp' | null = null;
  for (const [from, secret] of [['gelp', Deno.env.get('STRIPE_WEBHOOK_SECRET')], ['lnp', Deno.env.get('LNP_STRIPE_WEBHOOK_SECRET')], ['lnp', Deno.env.get('STRIPE_CONNECT_WEBHOOK_SECRET')]] as const)
    if (secret && !src && await verify(raw, sig, secret)) src = from;
  if (!src) return new Response('Bad signature', { status: 400 });
  return await SRC.run(src, () => handle(raw));
});

async function handle(raw: string): Promise<Response> {
  const evt = JSON.parse(raw);
  const s = evt.data?.object || {};
  // invoices (069): post the payment once per checkout; the invoice figures its own status
  if (s.metadata?.kind === 'invoice_autopay' && s.metadata?.invoice_id && String(evt.type).startsWith('payment_intent.')) {
    if (evt.type === 'payment_intent.succeeded') {
      // cards are recorded by invoice-cron the moment they go through; this is for bank payments that took days to clear
      const pm = s.payment_method ? await stripeGet(`payment_methods/${s.payment_method}`, evt.account).catch(() => null) : null;
      if (pm?.type === 'us_bank_account') await db.rpc('invoice_autopay_settled', { p_invoice: s.metadata.invoice_id, p_ref: s.id, p_ok: true, p_amount: (s.amount_received || 0) / 100, p_error: null });
    } else if (evt.type === 'payment_intent.payment_failed' && s.last_payment_error?.payment_method?.type === 'us_bank_account') {
      await db.rpc('invoice_autopay_settled', { p_invoice: s.metadata.invoice_id, p_ref: s.id, p_ok: false, p_amount: 0, p_error: s.last_payment_error?.message || 'The bank payment failed' });
    }
    return new Response('ok');
  }
  if (s.metadata?.kind === 'invoice' && s.metadata?.invoice_id && String(evt.type).startsWith('checkout.session.')) {
    if (evt.type === 'checkout.session.completed') { try { await saveCard(s.metadata.invoice_id, s, evt.account); } catch (e) { console.error('save card', (e as Error).message); } }
    if (s.mode === 'setup') return new Response('ok');
    const paid = (evt.type === 'checkout.session.completed' && s.payment_status === 'paid') || evt.type === 'checkout.session.async_payment_succeeded';
    if (paid) await db.rpc('invoice_stripe_paid', { p_invoice: s.metadata.invoice_id, p_session: s.id, p_amount: (s.amount_total || 0) / 100,
      p_method: evt.type === 'checkout.session.async_payment_succeeded' ? 'bank' : 'card' });
    return new Response('ok');
  }
  const pid = s.client_reference_id || s.metadata?.proposal_id;
  if (!pid || !String(evt.type).startsWith('checkout.session.')) return new Response('ignored');
  const { data: p } = await db.from('proposals').select('*').eq('id', pid).maybeSingle();
  if (!p || p.stripe_session_id !== s.id) return new Response('ignored');
  const amount = ((s.amount_total || 0) / 100).toLocaleString('en-US');
  if (evt.type === 'checkout.session.completed') { try { await startExtras(p, s); } catch (e) { console.error('extra subscriptions', (e as Error).message); } }

  if ((evt.type === 'checkout.session.completed' && s.payment_status !== 'unpaid') || evt.type === 'checkout.session.async_payment_succeeded') {
    try { await proposalToInvoices(p, s, evt.type === 'checkout.session.async_payment_succeeded' ? 'bank' : 'card'); } catch (e) { console.error('proposal to invoices', (e as Error).message); }
    const { data: done } = await db.from('proposals').update({ pay_status: 'paid', paid_at: new Date().toISOString(), paid_amount: (s.amount_total || 0) / 100,
      stripe_customer_id: s.customer || null, stripe_subscription_id: s.subscription || null }).eq('id', p.id).neq('pay_status', 'paid').select('id');
    if (done?.length) await note(p, s.mode === 'setup' ? `Card or bank account saved through Stripe for proposal version ${p.pay_version}. Nothing was due at signing.`
      : `Payment received through Stripe for proposal version ${p.pay_version}: $${amount} paid at signing${s.subscription ? ', recurring billing started' : ''}.`);
  } else if (evt.type === 'checkout.session.completed') {
    const { data: done } = await db.from('proposals').update({ pay_status: 'processing', stripe_customer_id: s.customer || null,
      stripe_subscription_id: s.subscription || null }).eq('id', p.id).eq('pay_status', 'pending').select('id');
    if (done?.length) await note(p, `Bank payment started through Stripe for proposal version ${p.pay_version}. It usually clears in a few business days.`);
  } else if (evt.type === 'checkout.session.async_payment_failed') {
    await db.from('proposals').update({ pay_status: 'failed' }).eq('id', p.id).neq('pay_status', 'paid');
    await note(p, `Bank payment FAILED for proposal version ${p.pay_version} ($${amount}). Reach out to the client; they can pay again from their proposal link.`);
  }
  return new Response('ok');
}
