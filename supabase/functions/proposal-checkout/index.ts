// proposal-checkout: turns an accepted proposal into a Stripe Checkout page (GELP's Stripe account).
//   { token, action: 'start' }  -> { url } for the accepted version, or { paid: true } if already paid
//   { token, action: 'status' } -> { pay_status } after checking Stripe for the latest session
// Called from the public client page; the share token is the credential, same as the page itself.
// Since Nov 3 (084a): one payment at signing (setup plus the first month or week of what isn't on a free trial) that
// also saves the card or bank. The CRM records it as a paid invoice and bills the rest with repeating invoices and
// autopay. Checkouts made before that ran Stripe subscriptions (startExtras); those keep running in Stripe.
// The Stripe key lives only in Supabase secrets (STRIPE_SECRET_KEY). Use a test key until live.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const APP = 'https://app.gelpstrategies.com';
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
const cents = (n: unknown) => Math.round((Number(n) || 0) * 100);

// Stripe takes form-encoded bodies with bracketed keys: line_items[0][price_data][currency]=usd
function flatten(obj: any, prefix = '', out: [string, string][] = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') flatten(v, key, out); else out.push([key, String(v)]);
  }
  return out;
}
async function stripe(path: string, method = 'GET', body?: Record<string, unknown>, idem?: string) {
  const key = Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) throw Object.assign(new Error('Online payment is not set up yet'), { code: 'not_configured' });
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idem ? { 'Idempotency-Key': idem } : {}) },
    body: body ? new URLSearchParams(flatten(body)).toString() : undefined,
  });
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

// 084a: a proposal paid online is an invoice paid. New checkouts (metadata.flow = 'inv') charge setup plus the first
// month or week once and save the card; the CRM then records the paid invoice and starts a repeating invoice series with
// autopay for each recurring part. Older checkouts kept their Stripe subscriptions (startExtras).
async function toInvoices(p: any, s: any) {
  if (s.metadata?.flow !== 'inv' || s.status !== 'complete') return;
  let pmId: string | undefined;
  if (s.payment_intent) pmId = (await stripe(`payment_intents/${typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent.id}`)).payment_method;
  else if (s.setup_intent) pmId = (await stripe(`setup_intents/${typeof s.setup_intent === 'string' ? s.setup_intent : s.setup_intent.id}`)).payment_method;
  let label: string | null = null;
  if (pmId) {
    const pm = await stripe(`payment_methods/${pmId}`);
    label = pm.card ? `${String(pm.card.brand || 'Card').replace(/^\w/, (c: string) => c.toUpperCase())} ending ${pm.card.last4}`
      : pm.us_bank_account ? `${pm.us_bank_account.bank_name || 'Bank'} account ending ${pm.us_bank_account.last4}` : 'Saved payment method';
    if (s.customer) await stripe(`customers/${s.customer}`, 'POST', { invoice_settings: { default_payment_method: pmId } }).catch(() => {});
  }
  const bank = / account ending /.test(label || '');
  const { error } = await db.rpc('proposal_paid_to_invoices', { p_proposal: p.id, p_session: s.id, p_amount: (s.amount_total || 0) / 100,
    p_method: bank ? 'bank' : 'card', p_customer: s.customer || null, p_pm: pmId || null, p_label: label });
  if (error) console.error('proposal to invoices', error.message);
}

async function markFromSession(p: any, s: any) {
  try { await startExtras(p, s); } catch (e) { console.error('extra subscriptions', (e as Error).message); }
  // complete + paid (cards) -> paid; complete + unpaid (bank transfer still clearing) -> processing
  const status = s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') ? 'paid'
    : s.status === 'complete' ? 'processing' : null;
  if (status === 'paid') { try { await toInvoices(p, s); } catch (e) { console.error('proposal to invoices', (e as Error).message); } }
  if (!status || p.pay_status === status || p.pay_status === 'paid') return p.pay_status;
  const patch: Record<string, unknown> = { pay_status: status, stripe_customer_id: s.customer || null, stripe_subscription_id: s.subscription || null };
  if (status === 'paid') { patch.paid_at = new Date().toISOString(); patch.paid_amount = (s.amount_total || 0) / 100; }
  const { data: done } = await db.from('proposals').update(patch).eq('id', p.id).neq('pay_status', 'paid').select('id');
  if (done?.length) await db.from('activities').insert({ company_id: p.company_id, type: 'note', created_by: p.owner_id,
    body: status === 'paid'
      ? (s.mode === 'setup' ? `Card or bank account saved through Stripe for proposal version ${p.pay_version}. Nothing was due at signing.`
        : `Payment received through Stripe for proposal version ${p.pay_version}: $${((s.amount_total || 0) / 100).toLocaleString('en-US')} paid at signing${s.subscription ? ', recurring billing started' : ''}.`)
      : `Bank payment started through Stripe for proposal version ${p.pay_version}. It usually clears in a few business days.` });
  return status;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  // GELP admins: is everything in place to switch payment on?
  if (body.action === 'check') {
    try {
      const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const asUser = createClient(Deno.env.get('SUPABASE_URL')!, envKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY'),
        { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false, autoRefreshToken: false } });
      const { data: sw } = await asUser.rpc('payments_get');
      if (!sw) return json({ error: 'Only a GELP admin can check this' }, 403);
      const key = Deno.env.get('STRIPE_SECRET_KEY') || '';
      const out: Record<string, unknown> = { ...sw, key: !!key, mode: /_live_/.test(key) ? 'live' : key ? 'test' : null,
        restricted: key.startsWith('rk_'), webhook_secret: !!Deno.env.get('STRIPE_WEBHOOK_SECRET'), key_works: false };
      if (key) { try { await stripe('checkout/sessions?limit=1'); out.key_works = true; } catch (e) { out.key_error = (e as Error).message; } }
      return json(out);
    } catch (e) { return json({ error: (e as Error).message }, 500); }
  }
  const token = String(body.token || '');
  if (token.length < 32) return json({ error: 'Bad request' }, 400);
  try {
    const { data: p } = await db.from('proposals').select('*').eq('share_token', token).maybeSingle();
    if (!p) return json({ error: 'Proposal not found' }, 404);
    if (p.status !== 'accepted') return json({ error: 'Accept the proposal first' }, 400);
    const current = p.pay_version === p.accepted_version;

    if (body.action === 'status') {
      if (!current || !p.stripe_session_id) return json({ pay_status: null });
      if (p.pay_status === 'pending' || p.pay_status === 'processing') {
        const s = await stripe(`checkout/sessions/${p.stripe_session_id}`);
        return json({ pay_status: await markFromSession(p, s) });
      }
      // paid already (the webhook got there first): make sure the other subscriptions were started too
      if (p.pay_status === 'paid' && !p.stripe_extra_subs && !p.invoice_series) {
        try { const s = await stripe(`checkout/sessions/${p.stripe_session_id}`); await startExtras(p, s); await toInvoices(p, s); } catch (e) { console.error('after payment', (e as Error).message); }
      }
      return json({ pay_status: p.pay_status });
    }

    if (body.action !== 'start') return json({ error: 'Unknown request' }, 400);
    // only GELP's own account collects online, and only while the switch is on
    const { data: on } = await db.rpc('payments_on_for', { p_tenant: p.tenant_id });
    if (!on) return json({ error: 'Online payment is not set up yet', not_configured: true });
    if (current && (p.pay_status === 'paid' || p.pay_status === 'processing')) return json({ paid: true, pay_status: p.pay_status });

    // reuse an open checkout for this version instead of making a new one
    if (current && p.stripe_session_id && p.pay_status !== 'failed') {
      const s = await stripe(`checkout/sessions/${p.stripe_session_id}`);
      if (s.status === 'open' && s.url) return json({ url: s.url });
      if (s.status === 'complete') { const st = await markFromSession(p, s); return json({ paid: true, pay_status: st }); }
    }

    const [{ data: ver }, { data: co }] = await Promise.all([
      db.from('proposal_versions').select('setup_total,monthly_total,weekly_total,quote').eq('proposal_id', p.id).eq('version', p.accepted_version).maybeSingle(),
      db.from('companies').select('name').eq('id', p.company_id).maybeSingle(),
    ]);
    if (!ver) return json({ error: 'Accepted version not found' }, 500);
    const setup = cents(ver.setup_total);
    const org = co?.name || 'Your organization';
    const lines: any[] = (ver.quote?.lines || []).filter((l: any) => (Number(l.ph) || 1) === 1);
    const list = (pick: (l: any) => boolean) => lines.filter(pick).map((l) => l.title).filter(Boolean).join(', ').slice(0, 480) || undefined;
    // recurring groups by cycle and trial; without trials the version totals are used as they are
    type G = { interval: 'month' | 'week'; trial: number; amount: number; names?: string };
    let groups: G[];
    if (lines.some((l) => Number(l.trial) > 0)) {
      const off = 1 - (Number(ver.quote?.month?.pct) || 0) / 100, m = new Map<string, G>();
      for (const l of lines) for (const [interval, amt] of [['month', Number(l.mo) || 0], ['week', Number(l.wk) || 0]] as const) {
        if (amt <= 0) continue;
        const trial = Number(l.trial) || 0, k = `${interval}:${trial}`;
        const g = m.get(k) || { interval, trial, amount: 0 }; g.amount += amt * off; m.set(k, g);
      }
      groups = [...m.values()].map((g) => ({ ...g, amount: cents(g.amount) }));
    } else {
      groups = [{ interval: 'month' as const, trial: 0, amount: cents(ver.monthly_total) }, { interval: 'week' as const, trial: 0, amount: cents(ver.weekly_total) }];
    }
    groups = groups.filter((g) => g.amount > 0).sort((a, b) => (a.trial - b.trial) || (a.interval === 'month' ? -1 : 1));
    if (setup <= 0 && !groups.length) return json({ nothing: true });
    // due today: setup plus the first month or week of everything not on a free trial. The card or bank is saved so the
    // CRM's repeating invoices (084a) can charge the rest; no Stripe subscription is made.
    const now = groups.filter((g) => g.trial === 0);
    const items: any[] = [];
    if (setup > 0) items.push({ quantity: 1, price_data: { currency: 'usd', unit_amount: setup,
      product_data: { name: `Setup, due at signing (${org})`, description: list((l) => Number(l.setup) > 0) } } });
    for (const g of now) items.push({ quantity: 1, price_data: { currency: 'usd', unit_amount: g.amount,
      product_data: { name: `${g.interval === 'week' ? 'Weekly' : 'Monthly'} services, first ${g.interval} (${org})`,
        description: list((l) => !(Number(l.trial) > 0) && Number(g.interval === 'week' ? l.wk : l.mo) > 0) } } });
    const email = /^\S+@\S+\.\S+$/.test(p.accepted_email || '') ? p.accepted_email : (/^\S+@\S+\.\S+$/.test(p.contact_email || '') ? p.contact_email : undefined);
    const meta: Record<string, string> = { proposal_id: p.id, version: String(p.accepted_version), org, flow: 'inv' };
    const back = `${APP}/proposal/view/?t=${encodeURIComponent(token)}`;
    const common = { payment_method_types: ['card', 'us_bank_account'], client_reference_id: p.id, metadata: meta,
      success_url: `${back}&paid=1`, cancel_url: back };
    let s: any;
    if (items.length) {
      s = await stripe('checkout/sessions', 'POST', { ...common, mode: 'payment', line_items: items, customer_email: email, customer_creation: 'always',
        payment_intent_data: { metadata: meta, description: `GELP Strategies ${groups.length ? 'signing payment' : 'setup'} for ${org}`,
          ...(groups.length ? { setup_future_usage: 'off_session' } : {}) } });
    } else {
      // nothing due today: save the card or bank account only
      const cust = await stripe('customers', 'POST', { email, name: org, metadata: { proposal_id: p.id } }, `cust-${p.id}-v${p.accepted_version}`);
      s = await stripe('checkout/sessions', 'POST', { ...common, mode: 'setup', customer: cust.id,
        setup_intent_data: { metadata: meta, description: `GELP Strategies ${org}: billing starts after the free trial` } });
    }
    await db.from('proposals').update({ stripe_session_id: s.id, pay_status: 'pending', pay_version: p.accepted_version }).eq('id', p.id);
    return json({ url: s.url });
  } catch (e) {
    const err = e as any;
    if (err.code === 'not_configured') return json({ error: err.message, not_configured: true }, 200);
    console.error('proposal-checkout', err.message);
    return json({ error: err.message }, 500);
  }
});
