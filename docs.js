/* docs.js: invoices, the shared estimate/proposal/invoice layout inside the CRM, invoice settings and how each account
   takes payments (its own Stripe through Connect, or a pasted payment link). Decisions: BACKLOG.md "Waiting on Chris"
   (layout, emails, pay button) and "Oct 30 morning voice decisions" (payments). Plugs into app.js through init(ctx). */
import * as FLD from './field.js?v=20261116t';
import { docHtml, totals, money, DOC_CSS } from './doc/layout.js?v=20261116t';
import * as MEA from './measure.js?v=20261116t';

let C = null, sb, S, esc, $, $$;
export function init(ctx) { C = ctx; ({ sb, S, esc, $, $$ } = ctx); }
const can = (a, l = 1) => FLD.can(a, l);
const STATUS = { draft: 'Draft', sent: 'Sent', partial: 'Partly paid', paid: 'Paid', void: 'Void' };
const BADGE = { draft: '', sent: 'gold', partial: 'gold', paid: 'ok', void: 'due' };
const FREQ = { once: 'One time', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly', custom: 'Custom' };
const UNITS = [['each', 'Each'], ['month', 'Per month'], ['year', 'Per year'], ['week', 'Per week'], ['day', 'Per day'], ['hour', 'Per hour'], ['visit', 'Per visit'], ['user', 'Per user'], ['sq_ft', 'Per sq ft'], ['ln_ft', 'Per linear ft']];
const METHODS = [['check', 'Check'], ['cash', 'Cash'], ['link', 'Payment link'], ['card', 'Card (taken somewhere else)'], ['bank', 'Bank transfer'], ['other', 'Other']];
const badge = (s, overdue) => `<span class="badge ${overdue ? 'due' : BADGE[s] || ''}">${overdue ? 'Overdue' : esc(STATUS[s] || s)}</span>`;
const isOverdue = (i) => ['sent', 'partial'].includes(i.status) && i.due_date && i.due_date < C.today();
const docLink = (token) => `${S.pub()}${location.pathname.replace(/[^/]*$/, '')}doc/?t=${encodeURIComponent(token)}`;
export const canSetup = () => C.isAdmin() || can('settings', 4) || can('invoices', 4);
let SET = null;   // doc settings for this account, loaded once per screen
async function settings(force) {
  if (SET && !force) return SET;
  const { data } = await sb.rpc('doc_settings_get');
  SET = data || { show_item_code: false, show_tax: false, default_tax_rate: 0, due_days: 30, company: {} };
  return SET;
}
function dlg(id, html) {
  let d = $('#' + id);
  if (!d) { d = document.createElement('dialog'); d.id = id; d.className = 'vdlg'; document.body.appendChild(d); }
  d.innerHTML = html;
  // closes only on a real click outside the box: press and release both outside, so a drag out of a text box or a
  // click in the box's padding never closes it
  const outside = (e) => { const r = d.getBoundingClientRect(); return e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom); };
  let downOut = false;
  d.onpointerdown = (e) => { downOut = outside(e); };
  d.onclick = (e) => { if (downOut && outside(e)) d.close(); downOut = false; };
  addEventListener('hashchange', () => d.open && d.close(), { once: true });
  d.showModal();
  return d;
}
let cssOn = false;
const css = () => { if (cssOn) return; cssOn = true; const s = document.createElement('style'); s.textContent = DOC_CSS + '.docprev{background:#eef1f6;border-radius:12px;padding:14px;margin-top:10px;overflow:auto}.invlines input{min-width:0}.invlines .ln{display:grid;gap:6px;align-items:start;padding:8px 0;border-bottom:1px solid var(--line)}.invlines textarea{min-height:38px}.invlines .lnover{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-size:13px;color:var(--muted)}.invlines .lnover input{flex:1;min-width:200px}.invlines .lnover s{color:var(--muted)}.invlines .lnover .low{color:#1f7a3a;font-weight:600}@media (max-width:640px){.invlines .ln{grid-template-columns:1fr 1fr 1fr!important}.invlines .ln>div:first-child{grid-column:1/-1}.lnhead{display:none!important}}'; document.head.appendChild(s); };

/* ================= navigation pieces ================= */
export const drawerItems = () => ({
  admin: [{ id: 'docsetup', label: 'Invoices and payments', match: ['docsetup'], what: 'Invoice numbers, tax, your company info and how customers pay', when: () => canSetup() },
    { id: 'products', label: 'Products/services', match: ['products'], what: 'What you sell: prices, costs and margins', when: () => canSetup() }],
});
export const views = () => ({ invoices: viewInvoices, invoice: viewInvoice, docsetup: viewSetup, products: viewProducts });
export const parents = { invoices: 'sales', invoice: 'invoices', docsetup: 'tools', products: 'tools' };
export const guards = { invoices: () => can('invoices', 1), invoice: () => can('invoices', 1), docsetup: () => canSetup(), products: () => canSetup() };
export const divider = { id: 'invoices', label: 'Invoices', match: ['invoices', 'invoice'], when: () => can('invoices', 1) };

/* ================= the list ================= */
let NEW = null;   // a new invoice waiting to be saved: { company_id, company_name }; only set by newFor or by picking in the search
let FILTER = 'open';
async function viewInvoices(main) {
  NEW = null;   // never carry an organization picked earlier into a new invoice
  const { data, error } = await sb.from('invoices').select('id,number,status,total,balance,due_date,issue_date,company_id,schedule_id,companies(name)').order('number', { ascending: false }).limit(500);
  if (error) { main.innerHTML = '<h1>Invoices</h1><p class="empty">Invoices need the October 30 database update. Once it\'s applied, this works.</p>'; return; }
  const set = await settings(true);
  const all = data || [];
  const pick = { all: () => true, draft: (i) => i.status === 'draft', open: (i) => ['sent', 'partial'].includes(i.status), overdue: isOverdue, paid: (i) => i.status === 'paid', void: (i) => i.status === 'void' };
  const rows = all.filter(pick[FILTER] || pick.all);
  const open = all.filter(pick.open).reduce((a, i) => a + Number(i.balance || 0), 0);
  const late = all.filter(isOverdue).reduce((a, i) => a + Number(i.balance || 0), 0);
  const jobsOn = FLD.feat('jobs');
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Invoices</h1>
      ${can('invoices', 2) ? `${jobsOn ? '<button class="btn secondary small" id="iJobs">Bill approved jobs</button>' : ''}<button class="btn small" id="iNew">New invoice</button>` : ''}</div>
    <div class="dtiles"><div class="dtile"><b>${esc(money(open))}</b><span>Open, not paid yet</span></div><div class="dtile ${late ? 'hot' : ''}"><b>${esc(money(late))}</b><span>Past due</span></div></div>
    <div class="chips" style="margin:12px 0">${[['open', 'Open'], ['overdue', 'Overdue'], ['draft', 'Drafts'], ['paid', 'Paid'], ['void', 'Void'], ['all', 'All']].map(([k, n]) =>
      `<button type="button" class="chip ${FILTER === k ? 'on' : ''}" data-f="${k}">${n} (${all.filter(pick[k]).length})</button>`).join('')}</div>
    <div class="list">${rows.map((i) => `<button class="item" data-inv="${i.id}"><b>${esc((set.prefix || '') + i.number)} · ${esc(i.companies?.name || '')}</b> ${badge(i.status, isOverdue(i))}
      <small>${i.schedule_id ? 'Repeating · ' : ''}${esc(money(i.total))}${['sent', 'partial'].includes(i.status) ? ' · ' + esc(money(i.balance)) + ' due' : ''}${i.due_date && i.status !== 'paid' && i.status !== 'void' ? ' · due ' + esc(C.fmtDate(i.due_date)) : ''}</small></button>`).join('')
      || '<p class="empty">Nothing here. New invoices start as drafts; make one by hand, from an accepted proposal or from approved jobs.</p>'}</div>`;
  $$('[data-f]', main).forEach((b) => (b.onclick = () => { FILTER = b.dataset.f; viewInvoices(main); }));
  $$('[data-inv]', main).forEach((b) => (b.onclick = () => C.go('invoice', b.dataset.inv)));
  if ($('#iNew')) $('#iNew').onclick = () => { NEW = null; C.go('invoice', 'new'); };
  if ($('#iJobs')) $('#iJobs').onclick = () => jobsPicker();
}

// approved jobs not billed yet, grouped by who gets the bill
async function jobsPicker(companyId) {
  let q = sb.from('jobs').select('id,number,title,price,company_id,completed_at,scheduled_start,companies(name,parent_company_id,bill_to)').in('approval', ['approved', 'auto']).is('billed_at', null).is('archived_at', null).limit(300);
  if (companyId) q = q.eq('company_id', companyId);
  const { data, error } = await q;
  if (error) return C.fail(error);
  const groups = {};
  (data || []).forEach((j) => { const bill = j.companies?.bill_to === 'parent' && j.companies?.parent_company_id ? j.companies.parent_company_id : j.company_id; (groups[bill] ||= []).push(j); });
  const names = Object.fromEntries((await sb.from('companies').select('id,name').in('id', Object.keys(groups).length ? Object.keys(groups) : ['00000000-0000-0000-0000-000000000000'])).data?.map((c) => [c.id, c.name]) || []);
  const d = dlg('invJobs', `<div class="vhead"><h2 style="margin:0">Bill approved ${esc(FLD.l('job', true))}</h2><button class="btn ghost small" data-x>Close</button></div>
    ${Object.keys(groups).length ? Object.entries(groups).map(([bill, js]) => `<h3>${esc(names[bill] || 'Organization')}</h3>
      ${js.map((j) => `<label class="featrow"><input type="checkbox" data-j="${j.id}" data-bill="${bill}" checked> #${esc(j.number)} ${esc(j.title)} · ${esc(money(j.price || 0))}${j.company_id !== bill ? ' · ' + esc(j.companies?.name || '') : ''}</label>`).join('')}
      <div class="actions"><button class="btn small" data-mk="${bill}">Make the invoice</button></div>`).join('') : `<p class="empty">No approved ${esc(FLD.l('job', true))} waiting to be billed.</p>`}`);
  $('[data-x]', d).onclick = () => d.close();
  $$('[data-mk]', d).forEach((b) => (b.onclick = async () => {
    const ids = $$(`[data-bill="${b.dataset.mk}"]`, d).filter((x) => x.checked).map((x) => x.dataset.j);
    if (!ids.length) return C.toast('Tick at least one');
    const { data: id, error: e } = await sb.rpc('invoice_from_jobs', { p_jobs: ids });
    if (e) return C.fail(e);
    d.close(); C.toast('Invoice made. Check it, then send it.'); C.go('invoice', id);
  }));
}

/* ================= one invoice ================= */

export function newFor(company) { NEW = { company_id: company.id, company_name: company.name }; C.go('invoice', 'new'); }
export async function fromProposal(id) {
  const { data, error } = await sb.rpc('invoice_from_proposal', { p_proposal: id });
  if (error) return C.fail(error);
  C.toast('Invoice made from the proposal. Check it, then send it.'); C.go('invoice', data);
}

async function viewInvoice(main) {
  css();
  const set = await settings(true);
  const isNew = S.param === 'new';
  let inv, pays = [], co = null;
  const [{ data: prodRows }, { data: savDef }] = await Promise.all([
    sb.from('products').select('*').is('archived_at', null).order('sort').order('name'), sb.rpc('invoice_savings_default')]);
  const PRODS = prodRows || [], SAV_DEFAULT = savDef !== false;
  if (isNew) {
    inv = { status: 'draft', company_id: NEW?.company_id || null, lines: [{ code: '', name: '', desc: '', qty: 1, price: '', tax: set.default_tax_rate || 0 }], discount: 0, deposit: 0,
      issue_date: C.today(), due_date: '', po: '', bill_to: NEW?.email ? { email: NEW.email } : {}, notes: set.notes || '', terms: set.terms || '', paid_total: 0, pictures: [] };
    co = NEW?.company_id ? { id: NEW.company_id, name: NEW.company_name } : null;
  } else {
    const { data, error } = await sb.from('invoices').select('*').eq('id', S.param).maybeSingle();
    if (error) return C.fail(error);
    if (!data) { main.innerHTML = '<p class="empty">That invoice isn\'t here, or your role can\'t see it.</p>'; return; }
    inv = data;
    const [{ data: c }, { data: p }] = await Promise.all([sb.from('companies').select('id,name,address,city,state,zip,main_email,main_phone').eq('id', inv.company_id).maybeSingle(),
      sb.from('invoice_payments').select('*').eq('invoice_id', inv.id).order('created_at')]);
    co = c; pays = p || [];
  }
  const SER = !isNew && inv.schedule_id ? (await sb.rpc('invoice_schedule_get', { p_invoice: inv.id })).data : null;
  const locked = ['paid', 'void'].includes(inv.status) || !can('invoices', 2);
  const code = !!set.show_item_code, tax = !!set.show_tax;
  const cols = ['1fr', code ? '90px' : '', '70px', '110px', tax ? '70px' : '', '34px'].filter(Boolean).join(' ');
  const lineRow = (l, i) => `<div class="ln" style="grid-template-columns:${cols}" data-ln="${i}">
      <div><input type="text" data-k="name" value="${esc(l.name || '')}" placeholder="What it is" ${locked ? 'disabled' : ''}><textarea data-k="desc" placeholder="Description (optional)" ${locked ? 'disabled' : ''}>${esc(l.desc || '')}</textarea></div>
      ${code ? `<input type="text" data-k="code" value="${esc(l.code || '')}" placeholder="Code" ${locked ? 'disabled' : ''}>` : ''}
      <input type="text" data-k="qty" inputmode="decimal" value="${esc(l.qty ?? 1)}" aria-label="Quantity" ${locked ? 'disabled' : ''}>
      <input type="text" data-k="price" inputmode="decimal" value="${esc(l.price ?? '')}" placeholder="0.00" aria-label="Unit price" ${locked ? 'disabled' : ''}>
      ${tax ? `<input type="text" data-k="tax" inputmode="decimal" value="${esc(l.tax ?? 0)}" aria-label="Tax percent" ${locked ? 'disabled' : ''}>` : ''}
      ${locked ? '<span></span>' : `<button type="button" class="btn ghost small" data-rm="${i}" aria-label="Remove line">✕</button>`}
      ${Number(l.retail) > 0 ? `<div class="lnover" data-over="${i}"><span>Retail <b>${esc(money(l.retail))}</b>${l.unit ? ' / ' + esc(l.unit) : ''}</span><span class="low" data-low></span>
        <input type="text" data-k="reason" value="${esc(l.reason || '')}" maxlength="300" placeholder="Why lower? Only your team sees this" ${locked ? 'disabled' : ''}></div>` : ''}</div>`;
  const posted = pays.filter((p) => p.status === 'posted'), pending = pays.filter((p) => p.status === 'pending');
  main.innerHTML = `<div class="toolbar"><button class="btn ghost small" id="iBack">← Invoices</button><div style="flex:1"></div>
      ${!isNew ? `<button class="btn ghost small" id="iLink">Copy customer link</button><a class="btn ghost small" href="${esc(docLink(inv.share_token))}" target="_blank" rel="noopener">Printable / PDF</a>` : ''}</div>
    <h1>${isNew ? 'New invoice' : `Invoice ${esc((set.prefix || '') + inv.number)}`} ${isNew ? '' : badge(inv.status, isOverdue(inv))}</h1>
    <div class="card"><h2>Customer</h2>
      ${co ? `<p style="margin:0"><b>${esc(co.name)}</b>${!isNew ? ' <button type="button" class="btn ghost small" id="iOrg">Open</button>' : ' <button type="button" class="btn ghost small" id="iOrgX">Change</button>'}</p>`
        : `<label class="label" for="iOrgQ">Customer</label><input id="iOrgQ" type="search" placeholder="Search businesses and people" autocomplete="off"><div id="iOrgRes" class="list"></div>`}
      <div class="row"><div><label class="label" for="bName">Bill to name</label><input type="text" id="bName" value="${esc(inv.bill_to?.name || '')}" placeholder="${esc(co?.name || '')}" ${locked ? 'disabled' : ''}></div>
        <div><label class="label" for="bEmail">Email</label><input id="bEmail" type="email" value="${esc(inv.bill_to?.email || '')}" placeholder="${esc(co?.main_email || '')}" ${locked ? 'disabled' : ''}></div></div>
      <label class="label" for="bAddr">Billing address</label><input type="text" id="bAddr" value="${esc(inv.bill_to?.address || '')}" placeholder="${esc([co?.address, co?.city, co?.state].filter(Boolean).join(', '))}" ${locked ? 'disabled' : ''}>
      <div class="row"><div><label class="label" for="iDate">Date</label><input id="iDate" type="date" value="${esc(inv.issue_date || '')}" ${locked ? 'disabled' : ''}></div>
        <div><label class="label" for="iDue">Due</label><input id="iDue" type="date" value="${esc(inv.due_date || '')}" placeholder="${set.due_days} days" ${locked ? 'disabled' : ''}></div>
        <div><label class="label" for="iPo">PO</label><input type="text" id="iPo" value="${esc(inv.po || '')}" maxlength="60" ${locked ? 'disabled' : ''}></div></div></div>
    <div class="card"><h2>Lines</h2>
      <div class="ln lnhead" style="display:grid;gap:6px;grid-template-columns:${cols};font-size:12px;color:var(--muted)"><span>Item</span>${code ? '<span>Code</span>' : ''}<span>Qty</span><span>Unit price</span>${tax ? '<span>Tax %</span>' : ''}<span></span></div>
      <div class="invlines" id="iLines">${(inv.lines || []).map(lineRow).join('')}</div>
      ${locked ? '' : `<div class="actions">${PRODS.length ? '<button type="button" class="btn secondary small" id="iProd">+ Add a product/service</button>' : ''}<button type="button" class="btn secondary small" id="iAdd">+ Add a line</button>${MEA.canMeasure() ? '<button type="button" class="btn secondary small" id="iMeasure">Measure and price</button>' : ''}</div>`}
      <div class="row"><div><label class="label" for="iDisc">Discount ($)</label><input type="text" id="iDisc" inputmode="decimal" value="${esc(Number(inv.discount) || '')}" placeholder="0" ${locked ? 'disabled' : ''}></div>
        <div><label class="label" for="iDep">Deposit already paid ($)</label><input type="text" id="iDep" inputmode="decimal" value="${esc(Number(inv.deposit) || '')}" placeholder="0" ${locked ? 'disabled' : ''}></div></div>
      <label class="check" style="margin-top:8px"><input type="checkbox" id="iSav" ${(inv.show_savings ?? SAV_DEFAULT) ? 'checked' : ''} ${locked ? 'disabled' : ''}> Show the customer what they saved (crossed out retail prices and a "You saved" total)</label>
      <div id="iTot" class="doc-totals" style="margin-top:10px"></div></div>
    ${inv.autopay_failed_at && ['sent', 'partial'].includes(inv.status) ? `<p class="banner warn">Autopay didn't go through on ${esc(C.fmtDate(inv.autopay_failed_at))}: ${esc(inv.autopay_error || 'declined')}. Try ${esc(inv.payment_attempts)} of 3.${inv.payment_attempts < 3 ? ' It tries again in 3 days.' : ''} The customer was emailed a pay link.</p>` : ''}
    ${!isNew && inv.status !== 'void' ? `<div class="card" id="iRep"><h2>Repeat</h2><div id="iRepBody"></div></div>` : ''}
    <div class="card" id="iPics" ${(inv.pictures || []).length ? '' : 'hidden'}><h2>Pictures</h2><p class="hint" style="margin-top:-4px">The customer sees these on the invoice, like the measured map.</p><div id="iPicList"></div></div>
    <div class="card"><h2>Notes and terms</h2><label class="label" for="iNotes">Notes (the customer sees these)</label><textarea id="iNotes" ${locked ? 'disabled' : ''}>${esc(inv.notes || '')}</textarea>
      <label class="label" for="iTerms">Terms</label><textarea id="iTerms" ${locked ? 'disabled' : ''}>${esc(inv.terms || '')}</textarea></div>
    ${!isNew ? `<div class="card"><h2>Payments</h2>
      ${posted.length ? posted.map((p) => `<div class="listrow"><span style="flex:1">${esc(C.fmtDate(p.paid_on))} · ${esc((METHODS.find((m) => m[0] === p.method) || [0, p.method])[1])}${p.reference ? ' · ' + esc(p.reference) : ''}${p.source === 'stripe' ? ' · online' : ''}</span><b>${esc(money(p.amount))}</b>
        ${p.source === 'manual' && can('invoices', 4) && inv.status !== 'void' ? `<button class="btn ghost small" data-unpay="${p.id}">Remove</button>` : ''}</div>`).join('') : '<p class="empty" style="margin:0">No payments yet.</p>'}
      ${pending.map((p) => `<div class="listrow"><span style="flex:1">${esc(money(p.amount))} by ${esc((METHODS.find((m) => m[0] === p.method) || [0, p.method])[1].toLowerCase())}${p.reference ? ' (' + esc(p.reference) + ')' : ''}</span><span class="badge gold">Waiting in Review</span></div>`).join('')}
      ${['sent', 'partial', 'draft'].includes(inv.status) && can('invoices', 2) && Number(inv.balance) > 0 ? '<div class="actions"><button class="btn secondary small" id="iPay">Record a payment</button></div>' : ''}</div>` : ''}
    <div class="actions">${locked ? '' : `<button class="btn" id="iSave">${isNew ? 'Save draft' : 'Save'}</button>`}
      ${!isNew && inv.status !== 'void' && can('invoices', 2) && inv.status !== 'paid' ? `<button class="btn secondary" id="iSend">${inv.sent_at ? 'Email it again' : 'Email it'}</button>${inv.status === 'draft' ? '<button class="btn ghost" id="iMark">Mark as sent</button>' : ''}` : ''}
      ${!isNew && inv.status !== 'void' && inv.status !== 'paid' && can('invoices', 3) ? '<button class="btn ghost danger" id="iVoid">Void</button>' : ''}</div>
    ${!isNew && inv.last_emailed_to ? `<p class="hint">Last emailed to ${esc(inv.last_emailed_to)}${inv.sent_at ? ' on ' + esc(C.fmtDate(inv.sent_at)) : ''}.</p>` : ''}
    <h2 class="section">What the customer sees</h2><div class="docprev" id="iPrev"></div>`;

  const read = () => {
    $$('#iLines [data-ln]').forEach((r) => { const l = inv.lines[r.dataset.ln]; $$('[data-k]', r).forEach((x) => (l[x.dataset.k] = x.value)); });
    inv.discount = $('#iDisc').value; inv.deposit = $('#iDep').value;
    inv.bill_to = { name: $('#bName').value.trim(), email: $('#bEmail').value.trim(), address: $('#bAddr').value.trim() };
    inv.issue_date = $('#iDate').value || C.today(); inv.due_date = $('#iDue').value || null; inv.po = $('#iPo').value.trim() || null;
    inv.notes = $('#iNotes').value.trim() || null; inv.terms = $('#iTerms').value.trim() || null;
    if ($('#iSav')) inv.show_savings = $('#iSav').checked === SAV_DEFAULT ? null : $('#iSav').checked;   // null follows the account setting
  };
  const savingsOf = (t) => r2((t.lines || []).reduce((a, l) => a + (Number(l.retail) > l.price ? (Number(l.retail) - l.price) * l.qty : 0), 0) + (t.discount || 0));
  const r2 = (n) => Math.round(n * 100) / 100;
  const brand = async () => {
    if (S._docBrand) return S._docBrand;
    const { data: bk } = await sb.from('brand_kits').select('logos,colors').maybeSingle();
    const l = bk?.logos || {}, cs = bk?.colors || [];
    const pc = cs.find((c) => /^primary/i.test(c.name || '')) || cs[0];
    S._docBrand = { name: set.company?.name || S.acct?.name || '', address: set.company?.address, phone: set.company?.phone, email: set.company?.email,
      logo: l.wide || (/^https?:/.test(l.default || '') ? l.default : l[l.default]) || null, color: pc?.hex || '#1A2A52' };
    return S._docBrand;
  };
  const draw = async () => {
    read();
    const t = totals(inv.lines.filter((l) => String(l.name || '').trim()), inv.discount, inv.deposit, inv.paid_total);
    const row = (k, v, b) => `<div class="doc-trow ${b ? 'big' : ''}"><span>${k}</span><span>${esc(money(v))}</span></div>`;
    const saved = savingsOf(t), showSav = inv.show_savings ?? SAV_DEFAULT;
    $$('#iLines [data-over]').forEach((r) => { const l = inv.lines[r.dataset.over], low = Number(l.retail) - Number(l.price || 0);
      const lowered = low > 0.004; $('[data-low]', r).textContent = lowered ? `Lowered ${money(low)} each` : 'At retail';
      $('[data-k="reason"]', r).hidden = !lowered; });
    $('#iTot').innerHTML = row('Subtotal', t.subtotal) + (t.discount ? row('Discount', -t.discount) : '') + row('Tax', t.tax_total) + row('Total', t.total, 1)
      + (t.deposit ? row('Deposit paid', -t.deposit) : '') + (t.paid_total ? row('Payments received', -t.paid_total) : '') + (t.deposit || t.paid_total ? row('Balance due', t.balance, 1) : '')
      + (saved > 0 ? `<div class="doc-trow save"><span>Savings given${showSav ? '' : ' (hidden from the customer)'}</span><span>${esc(money(saved))}</span></div>` : '');
    const b = await brand();
    $('#iPrev').innerHTML = docHtml({ kind: 'invoice', number: isNew ? '(next number)' : (set.prefix || '') + inv.number, issue_date: inv.issue_date, due_date: inv.due_date || null, po: inv.po,
      customer: { name: inv.bill_to.name || co?.name || '', org: co?.name, email: inv.bill_to.email || co?.main_email, address: inv.bill_to.address || [co?.address, co?.city, [co?.state, co?.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') },
      show_code: code, show_tax: tax, ...t, lines: showSav ? t.lines : t.lines.map(({ retail, ...l }) => l), savings: showSav ? saved : 0, payments: posted, pictures: inv.pictures || [], notes: inv.notes, terms: inv.terms, pay_instructions: set.pay_instructions, brand: b },
      { payButton: set.pay_method && t.balance > 0 && inv.status !== 'void' ? `<span class="doc-paybtn">Pay ${esc(money(t.balance))}</span>` : '' });
  };
  const bind = () => {
    $$('#iLines input, #iLines textarea, #iDisc, #iDep, #bName, #bEmail, #bAddr, #iDate, #iDue, #iPo, #iNotes, #iTerms').forEach((x) => (x.oninput = () => draw()));
    if ($('#iSav')) $('#iSav').onchange = () => draw();
    $$('[data-rm]').forEach((b) => (b.onclick = () => { read(); inv.lines.splice(Number(b.dataset.rm), 1); if (!inv.lines.length) inv.lines.push({ qty: 1, tax: set.default_tax_rate || 0 }); $('#iLines').innerHTML = inv.lines.map(lineRow).join(''); bind(); draw(); }));
  };
  let MEASURED = null;   // the measurement the lines came from, marked used once saved
  const pics = () => {
    const list = inv.pictures || [];
    $('#iPics').hidden = !list.length;
    $('#iPicList').innerHTML = list.map((p, i) => `<div class="listrow"><img class="mthumb" src="${esc(p.url)}" alt="" style="width:64px;height:48px;object-fit:cover;border-radius:6px"><span style="flex:1">${esc(p.title || 'Picture')}</span>
      ${locked ? '' : `<button type="button" class="btn ghost small danger" data-picrm="${i}">Take off</button>`}</div>`).join('');
    $$('[data-picrm]', main).forEach((b) => (b.onclick = () => { inv.pictures.splice(Number(b.dataset.picrm), 1); pics(); draw(); }));
  };
  bind(); draw(); pics();
  // ---- Repeat: a series made from this invoice (083a). Saving the series copies this invoice's lines for the next ones.
  const addPeriod = (d, f, n, u) => { const x = new Date(d + 'T12:00:00Z');
    const add = { weekly: ['d', 7], biweekly: ['d', 14], monthly: ['m', 1], quarterly: ['m', 3], yearly: ['m', 12] }[f] || (u === 'day' ? ['d', n] : u === 'week' ? ['d', 7 * n] : u === 'month' ? ['m', n] : ['m', 12 * n]);
    if (add[0] === 'd') x.setUTCDate(x.getUTCDate() + add[1]); else x.setUTCMonth(x.getUTCMonth() + add[1]);
    return x.toISOString().slice(0, 10); };
  const freqText = (r) => r.frequency === 'custom' ? `every ${r.custom_every} ${r.custom_unit}${r.custom_every > 1 ? 's' : ''}` : FREQ[r.frequency].toLowerCase();
  const payOk = ['stripe', 'platform'].includes(set.pay_method);
  const repDraw = () => {
    const box = $('#iRepBody'); if (!box) return;
    const live = SER && SER.status !== 'ended';
    box.innerHTML = live ? `<p style="margin:0 0 6px"><b>Repeats ${esc(freqText(SER))}.</b> Next invoice ${esc(C.fmtDate(SER.next_run_date))}${SER.status === 'paused' ? ' (paused)' : ''}.</p>
      <p class="hint" style="margin:0 0 4px">${SER.auto_send ? 'Each one is emailed to the customer on its own.' : 'Each one waits in Review as a draft so you can check it (like a quantity that changes), then you send it.'}
        ${SER.end_type === 'count' ? ` Stops after ${esc(SER.end_count)} invoices (${esc(SER.runs_completed)} made so far).` : SER.end_type === 'date' ? ` Stops after ${esc(C.fmtDate(SER.end_date))}.` : ' Keeps going until you stop it.'}</p>
      ${SER.autopay ? `<p class="hint" style="margin:0">${SER.card_saved ? `Autopay: charged to the customer's <b>${esc(SER.pm_label || 'saved card')}</b>.` : 'Autopay is on, but the customer hasn\'t saved a card or bank yet. They\'re asked to when they pay this invoice online.'}</p>` : ''}
      ${can('invoices', 2) ? `<div class="actions"><button class="btn secondary small" id="repEdit">Change</button><button class="btn ghost small danger" id="repStop">Stop repeating</button></div>
        <p class="hint">"Change" also copies this invoice's lines, customer and notes to the next invoices.</p>` : ''}`
      : `<p class="hint" style="margin:0">${SER?.status === 'ended' ? 'This series has ended. You can start it again.' : 'Bill this customer on a schedule: weekly, monthly, yearly or your own, like every 10 days.'}</p>
        ${can('invoices', 2) ? `<div class="actions"><button class="btn secondary small" id="repEdit">${SER ? 'Start it again' : 'Make this repeat'}</button></div>` : ''}`;
    if ($('#repEdit')) $('#repEdit').onclick = repEdit;
    if ($('#repStop')) $('#repStop').onclick = async () => {
      if (!confirm('Stop this series? No more invoices are made. The ones already made stay as they are.')) return;
      const { error } = await sb.rpc('invoice_schedule_save', { p_invoice: inv.id, p: { status: 'ended' } }); if (error) return C.fail(error);
      C.toast('Stopped'); viewInvoice(main);
    };
  };
  const repEdit = () => {
    const r = SER && SER.status !== 'ended' ? SER : { frequency: 'monthly', custom_every: 10, custom_unit: 'day', auto_send: true, end_type: 'never', autopay: false };
    const nextDefault = r.next_run_date || (() => { let d = addPeriod(inv.issue_date || C.today(), r.frequency, 10, 'day'); while (d < C.today()) d = addPeriod(d, r.frequency, 10, 'day'); return d; })();
    const d = dlg('invRep', `<div class="vhead"><h2 style="margin:0">Repeat this invoice</h2><button class="btn ghost small" data-x>Close</button></div>
      <div class="row"><div><label class="label" for="rFreq">How often</label><select id="rFreq">${Object.entries(FREQ).filter(([k]) => k !== 'once').map(([k, n]) => `<option value="${k}" ${r.frequency === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div id="rCustom" ${r.frequency === 'custom' ? '' : 'hidden'}><label class="label" for="rEvery">Every</label><div style="display:flex;gap:6px"><input type="number" id="rEvery" min="1" max="365" value="${esc(r.custom_every || 10)}" style="width:80px">
          <select id="rUnit">${['day', 'week', 'month', 'year'].map((u) => `<option value="${u}" ${r.custom_unit === u ? 'selected' : ''}>${u}s</option>`).join('')}</select></div></div>
        <div><label class="label" for="rNext">Next invoice on</label><input type="date" id="rNext" min="${C.today()}" value="${esc(nextDefault)}"></div></div>
      <label class="label">When each one is made</label>
      <label class="featrow"><input type="radio" name="rSend" value="1" ${r.auto_send ? 'checked' : ''}> <span><b>Email it to the customer on its own</b></span></label>
      <label class="featrow"><input type="radio" name="rSend" value="0" ${r.auto_send ? '' : 'checked'}> <span><b>Make a draft and put it in Review</b><small class="hint" style="display:block;margin:0">For amounts that change, like a physician count. You check it and send it.</small></span></label>
      <div class="row"><div><label class="label" for="rEnd">Ends</label><select id="rEnd"><option value="never" ${r.end_type === 'never' ? 'selected' : ''}>Never, until I stop it</option><option value="count" ${r.end_type === 'count' ? 'selected' : ''}>After a number of invoices</option><option value="date" ${r.end_type === 'date' ? 'selected' : ''}>On a date</option></select></div>
        <div id="rCountBox" ${r.end_type === 'count' ? '' : 'hidden'}><label class="label" for="rCount">Invoices in all (this one counts)</label><input type="number" id="rCount" min="1" max="1000" value="${esc(r.end_count || 12)}"></div>
        <div id="rDateBox" ${r.end_type === 'date' ? '' : 'hidden'}><label class="label" for="rDate">Last one on or before</label><input type="date" id="rDate" value="${esc(r.end_date || '')}"></div></div>
      <label class="featrow"><input type="checkbox" id="rAuto" ${r.autopay ? 'checked' : ''} ${payOk ? '' : 'disabled'}> <span><b>Autopay</b><small class="hint" style="display:block;margin:0">${payOk ? 'Charge the card or bank the customer saves in Stripe. They\'re asked to save it the first time they pay online. A charge that fails is tried twice more, 3 days apart, and the customer and your admins are told.' : 'Needs Stripe connected (Tools, Admin, Invoices and payments).'}</small></span></label>
      <div class="actions"><button class="btn" id="rGo">Save</button></div>`);
    $('[data-x]', d).onclick = () => d.close();
    $('#rFreq', d).onchange = (e) => ($('#rCustom', d).hidden = e.target.value !== 'custom');
    $('#rEnd', d).onchange = (e) => { $('#rCountBox', d).hidden = e.target.value !== 'count'; $('#rDateBox', d).hidden = e.target.value !== 'date'; };
    $('#rGo', d).onclick = async () => {
      if (!locked && !(await save())) return;
      const p = { frequency: $('#rFreq', d).value, custom_every: $('#rEvery', d).value, custom_unit: $('#rUnit', d).value, next_run_date: $('#rNext', d).value,
        auto_send: $('input[name="rSend"]:checked', d).value === '1', end_type: $('#rEnd', d).value, end_count: $('#rCount', d).value, end_date: $('#rDate', d).value, autopay: $('#rAuto', d).checked };
      const { error } = await sb.rpc('invoice_schedule_save', { p_invoice: inv.id, p });
      if (error) return C.fail(error);
      d.close(); C.toast('Saved. The next one is made on ' + C.fmtDate(p.next_run_date) + '.'); viewInvoice(main);
    };
  };
  repDraw();
  if ($('#iMeasure')) $('#iMeasure').onclick = async () => {
    if (!co) return C.toast('Pick the customer first');
    const { data: full } = await sb.from('companies').select('id,name,address,city,state,zip').eq('id', co.id).maybeSingle();
    const r = await MEA.open({ company: full || co, target: 'invoice' });
    if (!r) return;
    read();
    inv.lines = inv.lines.filter((l) => String(l.name || '').trim() || Number(l.price));
    inv.lines.push(...r.lines.map((l) => ({ ...l, tax: set.default_tax_rate || 0 })));
    if (r.picture) (inv.pictures ||= []).push(r.picture);
    MEASURED = r.measurement?.id || MEASURED;
    $('#iLines').innerHTML = inv.lines.map(lineRow).join(''); bind(); draw(); pics();
    C.toast(`${r.lines.length} ${r.lines.length === 1 ? 'line' : 'lines'} added. Save to keep them.`);
  };
  $('#iBack').onclick = () => { NEW = null; C.go('invoices'); };
  if ($('#iOrg')) $('#iOrg').onclick = () => C.go('org', co.id);
  if ($('#iOrgX')) $('#iOrgX').onclick = () => { read(); NEW = null; inv.company_id = null; co = null; viewInvoice(main); };
  if ($('#iOrgQ')) {
    let tm;
    $('#iOrgQ').oninput = (e) => { clearTimeout(tm); tm = setTimeout(async () => {
      const q = e.target.value.trim(); if (q.length < 2) { $('#iOrgRes').innerHTML = ''; return; }
      const w = q.toLowerCase().split(/\s+/).filter(Boolean), w0 = w[0].replace(/[%,()]/g, '');
      const [{ data }, { data: ppl }] = await Promise.all([
        sb.from('companies').select('id,name,city,org_types').ilike('name', `%${q}%`).is('archived_at', null).limit(8),
        sb.from('people').select('id,first_name,last_name,personal_email,company_people(companies(name,archived_at))').or(`first_name.ilike.%${w0}%,last_name.ilike.%${w0}%`).is('archived_at', null).limit(20)]);
      const pname = (x) => [x.first_name, x.last_name].filter(Boolean).join(' ');
      const people = (ppl || []).filter((x) => w.every((v) => pname(x).toLowerCase().includes(v) || (x.personal_email || '').toLowerCase().includes(v))).slice(0, 6);
      $('#iOrgRes').innerHTML = (data || []).map((c) => `<button class="item" data-co="${c.id}" data-name="${esc(c.name)}"><b>${esc(c.name)}</b><small>${esc([(c.org_types || []).includes('Individual') ? 'Individual' : 'Business', c.city].filter(Boolean).join(' · '))}</small></button>`).join('')
        + people.map((x) => { const o = (x.company_people || []).find((cp) => cp.companies && !cp.companies.archived_at); return `<button class="item" data-pe="${x.id}"><b>${esc(pname(x))}</b><small>Person${o && o.companies.name !== pname(x) ? ' · ' + esc(o.companies.name) : ''}</small></button>`; }).join('')
        + `<button class="item" id="iOrgAdd"><b>+ Add "${esc(q)}" as a new customer</b><small>A business or an individual. Quick Add it here and keep going on this invoice</small></button>`;
      $$('[data-co]', main).forEach((b) => (b.onclick = () => { NEW = { company_id: b.dataset.co, company_name: b.dataset.name }; viewInvoice(main); }));
      // a person: bill them through their organization, or make them an Individual customer (customer_for_person)
      $$('[data-pe]', main).forEach((b) => (b.onclick = async () => {
        b.disabled = true;
        const { data: c, error } = await sb.rpc('customer_for_person', { p_person: b.dataset.pe });
        if (error) { b.disabled = false; return C.fail(error); }
        NEW = { company_id: c.id, company_name: c.name }; viewInvoice(main);
      }));
      $('#iOrgAdd').onclick = () => orgQuickAdd(q);
    }, 250); };
  }
  // Quick Add a customer without leaving the invoice: the organization plus who gets the invoice (billing contact)
  const orgQuickAdd = (name) => {
    const f = (k, l, t = 'text', v = '') => `<div><label class="label" for="qa_${k}">${l}</label><input type="${t}" id="qa_${k}" value="${esc(v)}" autocomplete="off"></div>`;
    const [fn, ...ln] = name.split(/\s+/);
    $('#iOrgRes').innerHTML = `<div class="card" style="padding:12px;margin-top:8px"><b>New customer</b>
      <div style="margin:8px 0"><label class="check" style="display:inline-flex;margin-right:16px"><input type="radio" name="qaKind" value="biz" checked> Business</label>
        <label class="check" style="display:inline-flex"><input type="radio" name="qaKind" value="ind"> Individual</label></div>
      <div id="qaBiz"><div class="row">${f('name', 'Business name', 'text', name)}${f('phone', 'Main phone', 'tel')}</div>
        <p class="hint" style="margin:10px 0 4px">Who gets the invoice (optional)</p></div>
      <div class="row">${f('first', 'First name')}${f('last', 'Last name')}</div>
      <div class="row">${f('email', 'Email', 'email')}${f('cell', 'Cell', 'tel')}</div>
      <div class="row">${f('city', 'City')}${f('state', 'State')}</div>
      <div class="actions"><button class="btn ghost small" id="qaX">Cancel</button><button class="btn small" id="qaGo">Add and use</button></div></div>`;
    const ind = () => $('[name=qaKind]:checked').value === 'ind';
    $$('[name=qaKind]').forEach((r) => (r.onchange = () => {
      $('#qaBiz').hidden = ind();
      if (ind() && !$('#qa_first').value && !$('#qa_last').value) { $('#qa_first').value = fn || ''; $('#qa_last').value = ln.join(' '); }
      (ind() ? $('#qa_first') : $('#qa_name')).focus();
    }));
    $('#qa_name').focus();
    $('#qaX').onclick = () => { $('#iOrgRes').innerHTML = ''; };
    $('#qaGo').onclick = async (e) => {
      const v = (k) => $('#qa_' + k).value.trim();
      const person = [v('first'), v('last')].filter(Boolean).join(' ');
      const cname = ind() ? person : v('name');
      if (!cname) return C.toast(ind() ? 'Add their first name' : 'Add the business name', { error: true });
      if (v('email') && !/^\S+@\S+\.\S+$/.test(v('email'))) return C.toast('That email doesn\'t look right', { error: true });
      e.target.disabled = true; e.target.textContent = 'Adding…';
      const first = v('first') || (v('email') ? v('email').split('@')[0] : '');
      const { data: id, error } = await sb.rpc('quick_entry', { p: {
        company_id: null, company: { name: cname, org_types: [ind() ? 'Individual' : (C.lk ? C.lk('org_type')[0] : '') || 'Client'], city: v('city'), state: v('state'), main_phone: ind() ? v('cell') : v('phone') },
        contacts: first ? [{ first_name: first, last_name: v('last'), cell: v('cell'), email: v('email'), work_email: v('email'), is_billing: true, is_primary_contact: true }] : [],
        services: [], lead_source_kind: 'self' } });
      if (error) { e.target.disabled = false; e.target.textContent = 'Add and use'; return C.toast(error.message, { error: true }); }
      NEW = { company_id: id, company_name: cname, email: v('email') };
      C.toast(`Added ${cname}`);
      viewInvoice(main);
    };
  };
  if ($('#iProd')) $('#iProd').onclick = () => {
    const d = dlg('invProd', `<div class="vhead"><h2 style="margin:0">Add a product/service</h2><button class="btn ghost small" data-x>Close</button></div>
      <input type="search" id="ppQ" placeholder="Search products" autocomplete="off"><div class="list" id="ppList" style="margin-top:8px"></div>
      <p class="hint">Added at retail. Lower the price on the line if you need to; you'll be asked why, and only your team sees the reason.</p>`);
    $('[data-x]', d).onclick = () => d.close();
    const list = () => {
      const q = $('#ppQ', d).value.trim().toLowerCase();
      const rows = PRODS.filter((p) => !q || (p.name + ' ' + p.description + ' ' + p.code).toLowerCase().includes(q));
      $('#ppList', d).innerHTML = rows.map((p) => `<button type="button" class="item" data-pp="${p.id}"><b>${esc(p.name)} · ${esc(money(p.price))}${p.unit !== 'each' ? ' / ' + esc(p.unit) : ''}</b>
        <small>${esc([FREQ[p.frequency] && p.frequency !== 'once' ? FREQ[p.frequency] : '', p.description].filter(Boolean).join(' · ').slice(0, 140))}</small></button>`).join('') || '<p class="empty">No match.</p>';
      $$('[data-pp]', d).forEach((b) => (b.onclick = () => {
        const p = PRODS.find((x) => x.id === b.dataset.pp); read();
        inv.lines = inv.lines.filter((l) => String(l.name || '').trim() || Number(l.price));
        inv.lines.push({ product_id: p.id, code: p.code || '', name: p.name, desc: p.description || '', qty: Number(p.default_qty) > 0 ? Number(p.default_qty) : 1, price: Number(p.price), retail: Number(p.price), unit: p.unit !== 'each' ? p.unit : '',
          tax: p.taxable ? set.default_tax_rate || 0 : 0, reason: '' });
        if (Number(p.setup_price) > 0) inv.lines.push({ product_id: p.id, code: p.code || '', name: 'Setup: ' + p.name, desc: '', qty: 1, price: Number(p.setup_price), retail: Number(p.setup_price), unit: '',
          tax: p.taxable ? set.default_tax_rate || 0 : 0, reason: '' });
        $('#iLines').innerHTML = inv.lines.map(lineRow).join(''); bind(); draw(); d.close();
        C.toast(`${p.name} added`);
      }));
    };
    $('#ppQ', d).oninput = list; list(); $('#ppQ', d).focus();
  };
  if ($('#iAdd')) $('#iAdd').onclick = () => { read(); inv.lines.push({ code: '', name: '', desc: '', qty: 1, price: '', tax: set.default_tax_rate || 0 }); $('#iLines').innerHTML = inv.lines.map(lineRow).join(''); bind(); draw(); $(`#iLines [data-ln="${inv.lines.length - 1}"] [data-k="name"]`).focus(); };
  if ($('#iLink')) $('#iLink').onclick = async () => { const u = docLink(inv.share_token); try { await navigator.clipboard.writeText(u); C.toast(inv.status === 'draft' ? 'Copied. It shows once the invoice is sent.' : 'Link copied'); } catch { prompt('Copy this link:', u); } };
  const save = async () => {
    read();
    const lines = inv.lines.filter((l) => String(l.name || '').trim() || Number(l.price));
    if (lines.some((l) => !String(l.name || '').trim())) { C.toast('Every line needs a name'); return null; }
    if (!lines.length) { C.toast('Add at least one line'); return null; }
    if (lines.some((l) => Number(l.retail) > Number(l.price || 0) && !String(l.reason || '').trim())) { C.toast('Add a reason for each price you lowered. Only your team sees it.'); return null; }
    const row = { lines: lines.map((l) => ({ code: l.code || '', name: String(l.name).trim(), desc: l.desc || '', qty: l.qty === '' ? 1 : l.qty, price: l.price === '' ? 0 : l.price, tax: tax ? l.tax || 0 : l.tax ?? set.default_tax_rate ?? 0, job_id: l.job_id || null,
        product_id: l.product_id || null, unit: l.unit || null, retail: Number(l.retail) > 0 ? Number(l.retail) : null, reason: l.reason || null })),
      show_savings: inv.show_savings ?? null,
      discount: Number(inv.discount) || 0, deposit: Number(inv.deposit) || 0, bill_to: inv.bill_to, issue_date: inv.issue_date, due_date: inv.due_date, po: inv.po, notes: inv.notes, terms: inv.terms, pictures: inv.pictures || [] };
    if (isNew) {
      if (!co) { C.toast('Pick the customer first'); return null; }
      const { data, error } = await sb.from('invoices').insert({ ...row, company_id: co.id }).select('id').single();
      if (error) { C.fail(error); return null; }
      NEW = null; MEA.markUsed('invoice', data.id, MEASURED).catch(() => {}); return data.id;
    }
    const { error } = await sb.from('invoices').update(row).eq('id', inv.id);
    if (error) { C.fail(error); return null; }
    if (MEASURED) { MEA.markUsed('invoice', inv.id, MEASURED).catch(() => {}); MEASURED = null; }
    return inv.id;
  };
  if ($('#iSave')) $('#iSave').onclick = async () => { const id = await save(); if (!id) return; C.toast('Saved'); if (isNew) C.go('invoice', id); else viewInvoice(main); };
  if ($('#iMark')) $('#iMark').onclick = async () => { if (!locked && !(await save())) return; const { error } = await sb.rpc('invoice_mark_sent', { p_id: inv.id, p_to: null }); if (error) return C.fail(error); C.toast('Marked as sent'); viewInvoice(main); };
  if ($('#iSend')) $('#iSend').onclick = async () => {
    if (!locked && !(await save())) return;
    const { data: cps } = await sb.from('company_people').select('is_billing,is_primary_contact,work_email,people(first_name,last_name,personal_email,email_opt_out,archived_at)').eq('company_id', inv.company_id);
    const seen = new Map(), add = (email, label, on) => { const e = String(email || '').trim(); if (!/^\S+@\S+\.\S+$/.test(e)) return; const k = e.toLowerCase(); if (seen.has(k)) { if (on) seen.get(k).on = true; return; } seen.set(k, { email: e, label, on: !!on }); };
    const live = (cps || []).filter((c) => c.people && !c.people.archived_at);
    const anyBilling = live.some((c) => c.is_billing && (c.work_email || c.people.personal_email));
    add(inv.bill_to?.email, 'Bill to', true);
    live.sort((a, b) => (b.is_billing - a.is_billing) || (b.is_primary_contact - a.is_primary_contact)).forEach((c) => {
      const nm = [c.people.first_name, c.people.last_name].filter(Boolean).join(' ') || 'Contact';
      const tag = [c.is_billing ? 'Billing' : '', c.is_primary_contact ? 'Primary' : '', c.people.email_opt_out ? 'opted out of marketing' : ''].filter(Boolean).join(', ');
      const pick = c.is_billing || (!anyBilling && !inv.bill_to?.email && c.is_primary_contact);
      add(c.work_email, nm + (tag ? ` (${tag})` : ''), pick); add(c.people.personal_email, nm + ' (personal)' + (tag ? ` (${tag})` : ''), pick && !c.work_email);
    });
    add(co?.main_email, 'Main company email', ![...seen.values()].some((r) => r.on));
    const rows = [...seen.values()];
    const d = dlg('invSend', `<div class="vhead"><h2 style="margin:0">Email invoice ${esc((set.prefix || '') + inv.number)}</h2><button class="btn ghost small" data-x>Close</button></div>
      <span class="label">Send to</span>
      <div id="sList">${rows.length ? rows.map((r, i) => `<label class="check"><input type="checkbox" data-to="${i}" ${r.on ? 'checked' : ''}> ${esc(r.label)} · ${esc(r.email)}</label>`).join('') : '<p class="hint">No emails on file for this customer yet. Add one below.</p>'}</div>
      <label class="label" for="sTo">Add other emails (optional, separate with commas)</label><input id="sTo" type="text" inputmode="email" placeholder="someone@example.com, another@example.com">
      <label class="label" for="sNote">A note at the top (optional)</label><textarea id="sNote" placeholder="Thanks for your business!"></textarea>
      <p class="hint">They get "Your invoice is $X", the details folded under it, ${set.pay_method ? 'a pay button, ' : ''}and a link to the full invoice they can print or save as a PDF.${set.pay_method ? '' : ' No pay button: this account has no payment processor or payment link yet (Tools, Admin, Invoices and payments).'}</p>
      <div class="actions"><button class="btn" id="sGo">Send</button></div>`);
    $('[data-x]', d).onclick = () => d.close();
    $('#sGo', d).onclick = async () => {
      const b = $('#sGo', d); b.disabled = true; b.textContent = 'Sending…';
      const extra = $('#sTo', d).value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
      const bad = extra.filter((x) => !/^\S+@\S+\.\S+$/.test(x));
      const to = [...new Set([...$$('[data-to]', d).filter((x) => x.checked).map((x) => rows[x.dataset.to].email), ...extra.filter((x) => !bad.includes(x))].map((x) => x.toLowerCase()))];
      if (bad.length) { b.disabled = false; b.textContent = 'Send'; return C.toast(`That doesn't look like an email: ${bad[0]}`, { error: true }); }
      if (!to.length) { b.disabled = false; b.textContent = 'Send'; return C.toast('Pick at least one person to email', { error: true }); }
      if (to.length > 10) { b.disabled = false; b.textContent = 'Send'; return C.toast('Ten people at most per send', { error: true }); }
      const { data, error } = await sb.functions.invoke('invoice-email', { body: { id: inv.id, to, note: $('#sNote', d).value.trim() } });
      const msg = error ? (await error.context?.json?.().catch(() => null))?.error || error.message : data?.error;
      if (msg) { b.disabled = false; b.textContent = 'Send'; return C.toast(msg, { error: true }); }
      d.close(); C.toast('Sent'); viewInvoice(main);
    };
  };
  if ($('#iVoid')) $('#iVoid').onclick = async () => {
    if (!confirm('Void this invoice? It stays on record as void, its jobs can be billed again and the customer\'s link says it was voided.')) return;
    const reason = prompt('Why? (optional)', '') ?? '';
    const { error } = await sb.from('invoices').update({ status: 'void', void_reason: reason.trim() || null }).eq('id', inv.id);
    if (error) return C.fail(error); C.toast('Voided'); viewInvoice(main);
  };
  if ($('#iPay')) $('#iPay').onclick = () => {
    const d = dlg('invPay', `<div class="vhead"><h2 style="margin:0">Record a payment</h2><button class="btn ghost small" data-x>Close</button></div>
      <div class="row"><div><label class="label" for="pAmt">Amount</label><input type="text" id="pAmt" inputmode="decimal" value="${esc(Number(inv.balance).toFixed(2))}"></div>
        <div><label class="label" for="pHow">How they paid</label><select id="pHow">${METHODS.map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join('')}</select></div></div>
      <div class="row"><div><label class="label" for="pRef">Check number or reference</label><input type="text" id="pRef" maxlength="120"></div><div><label class="label" for="pOn">Date paid</label><input id="pOn" type="date" value="${C.today()}"></div></div>
      <label class="label" for="pNote">Note (optional)</label><input type="text" id="pNote" maxlength="500">
      <p class="hint">${can('invoices', 3) ? 'This counts right away.' : 'This goes to Review. It counts once someone who approves payments says yes.'}</p>
      <div class="actions"><button class="btn" id="pGo">Record it</button></div>`);
    $('[data-x]', d).onclick = () => d.close();
    $('#pGo', d).onclick = async () => {
      const { data, error } = await sb.rpc('invoice_payment_record', { p_invoice: inv.id, p: { amount: $('#pAmt', d).value, method: $('#pHow', d).value, reference: $('#pRef', d).value, paid_on: $('#pOn', d).value, note: $('#pNote', d).value } });
      if (error) return C.fail(error);
      d.close(); C.toast(data?.status === 'pending' ? 'Sent to Review' : 'Payment recorded'); C.refreshCounts?.(); viewInvoice(main);
    };
  };
  $$('[data-unpay]', main).forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this payment? The balance goes back up.')) return;
    const { error } = await sb.rpc('invoice_payment_decide', { p_id: b.dataset.unpay, p_ok: false }); if (error) return C.fail(error); C.toast('Removed'); viewInvoice(main);
  }));
}

/* ================= on the organization page ================= */
export async function orgBox(box, c) {
  if (!box || !can('invoices', 1)) return;
  const { data, error } = await sb.from('invoices').select('id,number,status,total,balance,due_date').eq('company_id', c.id).order('number', { ascending: false }).limit(20);
  if (error) return;
  const set = await settings();
  const { count } = FLD.feat('jobs') && can('invoices', 2) ? await sb.from('jobs').select('id', { count: 'exact', head: true }).eq('company_id', c.id).in('approval', ['approved', 'auto']).is('billed_at', null).is('archived_at', null) : { count: 0 };
  box.innerHTML = `<div class="card"><div class="toolbar" style="margin:0"><h2 style="flex:1;margin:0">Invoices</h2>
      ${can('invoices', 2) ? `${count ? `<button class="btn secondary small" id="oiJobs">Bill ${count} approved ${esc(FLD.l('job', count !== 1))}</button>` : ''}<button class="btn small" id="oiNew">New invoice</button>` : ''}</div>
    <div class="list" style="margin-top:8px">${(data || []).map((i) => `<button class="item" data-oi="${i.id}"><b>${esc((set.prefix || '') + i.number)}</b> ${badge(i.status, isOverdue(i))}<small>${esc(money(i.total))}${['sent', 'partial'].includes(i.status) ? ' · ' + esc(money(i.balance)) + ' due' : ''}</small></button>`).join('') || '<p class="empty" style="margin:0">No invoices yet.</p>'}</div></div>`;
  $$('[data-oi]', box).forEach((b) => (b.onclick = () => C.go('invoice', b.dataset.oi)));
  if ($('#oiNew', box)) $('#oiNew', box).onclick = () => newFor(c);
  if ($('#oiJobs', box)) $('#oiJobs', box).onclick = () => jobsPicker(c.id);
}

/* ================= Review: manual payments waiting on a yes ================= */
export const reviewOn = () => can('invoices', 3);
const seriesOn = () => can('invoices', 2);
async function seriesReview() {
  if (!seriesOn()) return { drafts: [], failed: [] };
  const { data } = await sb.rpc('invoice_series_review');
  return { drafts: data?.drafts || [], failed: data?.failed || [] };
}
export async function reviewCount() {
  const [{ data }, sr] = await Promise.all([reviewOn() ? sb.rpc('invoice_review_list') : { data: [] }, seriesReview().catch(() => ({ drafts: [], failed: [] }))]);
  return (Array.isArray(data) ? data.length : 0) + sr.drafts.length + sr.failed.length;
}
export async function reviewBox(box) {
  if (!box || (!reviewOn() && !seriesOn())) return;
  const [{ data }, sr] = await Promise.all([reviewOn() ? sb.rpc('invoice_review_list') : { data: [] }, seriesReview().catch(() => ({ drafts: [], failed: [] }))]);
  const rows = Array.isArray(data) ? data : [];
  if (!rows.length && !sr.drafts.length && !sr.failed.length) { box.innerHTML = ''; return; }
  const series = (sr.failed.length ? `<h2 class="section">Autopay that didn't go through (${sr.failed.length})</h2>${sr.failed.map((f) => `<div class="card">
      <div class="toolbar"><b style="flex:1">${esc(money(f.balance))} on invoice ${esc(f.number)} · ${esc(f.org)}</b><small>${esc(C.fmtDate(f.at))}</small></div>
      <p>${esc(f.error || 'The charge was declined.')} Try ${esc(f.attempts)} of 3.${f.attempts < 3 ? ' It tries again in 3 days.' : ' No more tries; the customer needs to pay or update their card.'} The customer was emailed a pay link and a way to update their card.</p>
      <div class="actions"><button class="btn ghost small" data-open="${f.id}">Look at the invoice</button></div></div>`).join('')}` : '')
    + (sr.drafts.length ? `<h2 class="section">Repeating invoices to check and send (${sr.drafts.length})</h2>${sr.drafts.map((d) => `<div class="card">
      <div class="toolbar"><b style="flex:1">Invoice ${esc(d.number)} · ${esc(d.org)} · ${esc(money(d.total))}</b><small>${esc(C.fmtDate(d.issue_date))}</small></div>
      <p>Made from a repeating series that waits for you. Check the quantities, then email it.</p>
      <div class="actions"><button class="btn small" data-open="${d.id}">Check and send</button></div></div>`).join('')}` : '');
  box.innerHTML = (rows.length ? `<h2 class="section">Payments to approve (${rows.length})</h2>` : '') + `${rows.map((p) => `<div class="card" data-rp="${p.id}">
      <div class="toolbar"><b style="flex:1">${esc(money(p.amount))} on invoice ${esc(p.number)} · ${esc(p.org)}</b><small>${esc(C.fmtDate(p.at))}</small></div>
      <p>${esc(p.by || 'Someone')} recorded a ${esc((METHODS.find((m) => m[0] === p.method) || [0, p.method])[1].toLowerCase())} payment${p.reference ? ' (' + esc(p.reference) + ')' : ''} paid ${esc(C.fmtDate(p.paid_on))}.${p.note ? ' “' + esc(p.note) + '”' : ''} Balance before it: ${esc(money(p.balance))}.</p>
      <div class="actions"><button class="btn small" data-ok="1">Approve</button><button class="btn secondary small" data-ok="0">Turn it down</button><button class="btn ghost small" data-open="${p.invoice_id}">Look at the invoice</button></div></div>`).join('')}` + series;
  $$('[data-open]', box).forEach((b) => (b.onclick = () => C.go('invoice', b.dataset.open)));
  $$('[data-rp]', box).forEach((card) => {
    $$('[data-ok]', card).forEach((b) => (b.onclick = async () => {
      const { error } = await sb.rpc('invoice_payment_decide', { p_id: card.dataset.rp, p_ok: b.dataset.ok === '1' });
      if (error) return C.fail(error); C.toast(b.dataset.ok === '1' ? 'Approved' : 'Turned down'); C.refreshCounts?.(); reviewBox(box);
    }));
  });
}

/* ================= Tools > Admin > Invoices and payments ================= */
async function viewSetup(main) {
  const s = await settings(true);
  const edit = !!s.can_edit;
  const back = new URLSearchParams(location.search).get('stripe') === '1';
  const co = s.company || {};
  const sw = (id, on, label, what) => `<label class="featrow"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${edit ? '' : 'disabled'}> <span><b>${label}</b><small class="hint" style="display:block;margin:0">${what}</small></span></label>`;
  main.innerHTML = `<h1>Invoices and payments</h1>
    <div class="card"><h2>How customers pay</h2><div id="sPay"><p class="empty">Checking…</p></div>
      <label class="label" for="sLink">Payment link (Square, PayPal or any checkout page)</label>
      <input id="sLink" type="url" value="${esc(s.pay_link || '')}" placeholder="https://" ${edit ? '' : 'disabled'}>
      <p class="hint">Used when Stripe isn't connected. The customer may need to type in the amount, so mark those invoices paid by hand (it goes through Review unless you can approve payments). With no Stripe and no link, invoices have no pay button at all.</p></div>
    <div class="card"><h2>Your company on documents</h2>
      <p class="hint">Shows at the top right and in the footer of every estimate, proposal and invoice. The logo and line color come from the Brand kit (wide logo first, then your default logo, then this name in bold).</p>
      <div class="row"><div><label class="label" for="sName">Company name</label><input type="text" id="sName" value="${esc(co.name || S.acct?.name || '')}" ${edit ? '' : 'disabled'}></div>
        <div><label class="label" for="sPhone">Phone</label><input type="text" id="sPhone" value="${esc(co.phone || '')}" ${edit ? '' : 'disabled'}></div></div>
      <div class="row"><div><label class="label" for="sAddr">Address</label><input type="text" id="sAddr" value="${esc(co.address || '')}" ${edit ? '' : 'disabled'}></div>
        <div><label class="label" for="sEmail">Email</label><input id="sEmail" type="email" value="${esc(co.email || '')}" ${edit ? '' : 'disabled'}></div></div></div>
    <div class="card"><h2>Invoices</h2>
      <div class="row"><div><label class="label" for="sPre">Number starts with (optional)</label><input type="text" id="sPre" maxlength="10" value="${esc(s.prefix || '')}" placeholder="INV-" ${edit ? '' : 'disabled'}></div>
        <div><label class="label" for="sNext">Next number</label><input id="sNext" type="number" min="1" value="${esc(s.next_number || 1001)}" ${edit ? '' : 'disabled'}></div>
        <div><label class="label" for="sDue">Due after (days)</label><input id="sDue" type="number" min="0" max="365" value="${esc(s.due_days ?? 30)}" ${edit ? '' : 'disabled'}></div></div>
      ${sw('sCode', s.show_item_code, 'Show the item code column', 'For accounts that use part or service codes.')}
      ${sw('sTax', s.show_tax, 'Show the tax column', 'Tax is always figured line by line. Turn this on if your state wants it shown on each line.')}
      <label class="featrow"><input type="checkbox" id="sSav" ${edit ? '' : 'disabled'}> <span><b>Show customers what they saved</b><small class="hint" style="display:block;margin:0">When a line's price is lowered from retail, the customer sees the retail crossed out and a "You saved" total. Each invoice can still turn it off or on. The reason for a lower price is never shown.</small></span></label>
      <label class="label" for="sRate">Default tax on new lines (%)</label><input type="text" id="sRate" inputmode="decimal" value="${esc(s.default_tax_rate ?? 0)}" ${edit ? '' : 'disabled'}>
      <label class="label" for="sNotes">Default notes</label><textarea id="sNotes" ${edit ? '' : 'disabled'}>${esc(s.notes || '')}</textarea>
      <label class="label" for="sTerms">Default terms</label><textarea id="sTerms" ${edit ? '' : 'disabled'}>${esc(s.terms || '')}</textarea>
      <label class="label" for="sHow">How to pay (shows on the invoice, like "Make checks out to...")</label><textarea id="sHow" ${edit ? '' : 'disabled'}>${esc(s.pay_instructions || '')}</textarea></div>
    <div class="card"><h2>Reminders and late fees</h2>
      <label class="featrow"><input type="checkbox" id="sRem" ${edit ? '' : 'disabled'}> <span><b>Email reminders for past due invoices</b><small class="hint" style="display:block;margin:0">3, 10 and 17 days after the due date, with a pay button. Not sent for invoices being paid by autopay.</small></span></label>
      <label class="featrow"><input type="checkbox" id="sLate" ${edit ? '' : 'disabled'}> <span><b>Add a late fee</b><small class="hint" style="display:block;margin:0">Added once, as a line on the invoice, when it's this many days past due.</small></span></label>
      <div class="row" id="sLateBox"><div><label class="label" for="sLateKind">Fee</label><select id="sLateKind" ${edit ? '' : 'disabled'}><option value="flat">Flat amount ($)</option><option value="percent">Percent of the balance</option></select></div>
        <div><label class="label" for="sLateAmt">Amount</label><input type="text" id="sLateAmt" inputmode="decimal" ${edit ? '' : 'disabled'}></div>
        <div><label class="label" for="sLateDays">Days past due</label><input type="number" id="sLateDays" min="1" max="365" ${edit ? '' : 'disabled'}></div></div></div>
    ${edit ? '<div class="actions"><button class="btn" id="sSave">Save</button></div>' : '<p class="hint">Your role can look but not change these.</p>'}`;
  sb.rpc('invoice_savings_default').then(({ data }) => { if ($('#sSav')) $('#sSav').checked = data !== false; });
  sb.rpc('invoice_collect_settings').then(({ data: c }) => { if (!c || !$('#sRem')) return;
    $('#sRem').checked = c.reminders_on !== false; $('#sLate').checked = !!c.late_fees_enabled; $('#sLateKind').value = c.late_fee_kind || 'flat';
    $('#sLateAmt').value = Number(c.late_fee_amount) || ''; $('#sLateDays').value = c.late_fee_days || 15; $('#sLateBox').hidden = !c.late_fees_enabled; });
  if ($('#sLate')) $('#sLate').onchange = (e) => ($('#sLateBox').hidden = !e.target.checked);
  if ($('#sSave')) $('#sSave').onclick = async () => {
    if ($('#sLate').checked && !(Number(String($('#sLateAmt').value).replace(/[$,%\s]/g, '')) > 0)) return C.toast('Add the late fee amount');
    const r = await sb.rpc('invoice_savings_default_set', { p_on: $('#sSav').checked }); if (r.error) return C.fail(r.error);
    const r2 = await sb.rpc('invoice_collect_settings_set', { p: { reminders_on: $('#sRem').checked, late_fees_enabled: $('#sLate').checked, late_fee_kind: $('#sLateKind').value,
      late_fee_amount: Number(String($('#sLateAmt').value).replace(/[$,%\s]/g, '')) || 0, late_fee_days: Number($('#sLateDays').value) || 15 } });
    if (r2.error) return C.fail(r2.error);
    const { data, error } = await sb.rpc('doc_settings_save', { p: { company: { name: $('#sName').value, address: $('#sAddr').value, phone: $('#sPhone').value, email: $('#sEmail').value },
      prefix: $('#sPre').value, next_number: Number($('#sNext').value) || 1001, due_days: Number($('#sDue').value) || 0, show_item_code: $('#sCode').checked, show_tax: $('#sTax').checked,
      default_tax_rate: Number($('#sRate').value) || 0, notes: $('#sNotes').value, terms: $('#sTerms').value, pay_instructions: $('#sHow').value, pay_link: $('#sLink').value.trim() } });
    if (error) return C.fail(error); SET = data; S._docBrand = null; C.toast('Saved'); viewSetup(main);
  };
  payBox($('#sPay'), s, edit, back);
}

/* ================= Tools > Admin > Products ================= */
// Everything the account sells, in one place: price, setup fee, costs and margin. Products pull onto invoices at retail and onto
// proposals as service lines. For accounts with proposals, the proposal price book (the built-in proposal items) is edited here too.
// The rules that price things (hourly rates, hosting formulas, guardrails, commission, payback) stay in Pricing.
const pct = (n) => (n == null ? '' : Math.round(n * 1000) / 10 + '%');
const marginOf = (price, cost) => (Number(price) > 0 ? (Number(price) - Number(cost || 0)) / Number(price) : null);
async function viewProducts(main) {
  const book_on = C.S.acct?.is_gelp !== false && C.isAdmin();
  const [{ data, error }, costs, ps] = await Promise.all([
    sb.from('products').select('*').is('archived_at', null).order('sort').order('name'),
    sb.from('product_costs').select('*'),
    book_on ? sb.rpc('proposal_settings_get') : Promise.resolve({ data: null })]);
  if (error) { main.innerHTML = '<h1>Products/services</h1><p class="empty">Products need the November 3 database update (081a).</p>'; return; }
  const all = data || [];
  const cmap = Object.fromEntries((costs.data || []).map((c) => [c.product_id, c]));
  const costsOn = !costs.error;
  const st = ps.data?.settings || null;
  const book = ps.data?.book ? (Array.isArray(ps.data.book) ? ps.data.book : Object.values(ps.data.book)) : [];
  // margin colors follow the proposal guardrails when the account has them, else 50% and 30%
  const g = st ? Number(st.green) : 0.5, y = st ? Number(st.yellow) : 0.3;
  const mBadge = (m) => m == null ? '<span class="hint">—</span>' : `<span class="mtag ${m >= g ? 'ok' : m >= y ? 'warn' : 'low'}">${pct(m)}</span>`;
  const freqTxt = (p) => p.frequency === 'custom' ? `Every ${p.custom_every} ${p.custom_unit}${p.custom_every > 1 ? 's' : ''}` : FREQ[p.frequency];
  const RULED = ['cSite', 'host', 'ex'];
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Products/services</h1><button class="btn small" id="prNew">+ New product/service</button></div>
    <p class="hint">Everything you sell, with its price, cost and margin. Costs and margins only show to people who manage products. Products and services go onto invoices with "+ Add a product/service"${book_on ? ' and onto proposals with "+ Add from product/service"' : ''}.${book_on ? ' The rules that price things, like hourly rates and hosting, are in <a href="#pricing">Pricing</a>.' : ''}</p>
    <div class="card"><h2>Products and services</h2>
      ${all.length ? `<div class="tablewrap"><table class="prodtable"><thead><tr><th>Name</th><th>Billed</th><th class="num">Setup</th><th class="num">Price</th>${costsOn ? '<th class="num">Cost</th><th class="num">Margin</th>' : ''}</tr></thead><tbody>
        ${all.map((p) => { const c = cmap[p.id] || {}; return `<tr data-pr="${p.id}" tabindex="0"><td><b>${esc(p.name)}</b>${p.code ? ` <small class="hint" style="display:inline">${esc(p.code)}</small>` : ''}${p.description ? `<small class="pdesc">${esc(p.description.slice(0, 120))}</small>` : ''}</td>
          <td>${esc(freqTxt(p) || '')}${p.unit !== 'each' ? ` <small class="hint" style="display:inline">/ ${esc(p.unit)}</small>` : ''}${p.taxable ? ' <small class="hint" style="display:inline">· taxable</small>' : ''}</td>
          <td class="num">${Number(p.setup_price) ? esc(money(p.setup_price)) : '—'}</td><td class="num">${esc(money(p.price))}</td>
          ${costsOn ? `<td class="num">${c.cost != null || c.setup_cost ? esc(money(c.cost || 0)) + (Number(c.setup_cost) ? `<small class="hint">setup ${esc(money(c.setup_cost))}</small>` : '') : '<span class="hint">not set</span>'}</td>
          <td class="num">${c.cost != null ? mBadge(marginOf(p.price, c.cost)) : '<span class="hint">—</span>'}${Number(p.setup_price) && c.setup_cost != null ? `<small class="hint">setup ${pct(marginOf(p.setup_price, c.setup_cost))}</small>` : ''}</td>` : ''}</tr>`; }).join('')}
      </tbody></table></div>` : '<p class="empty">Nothing here yet. Add what you sell with its price and cost.</p>'}</div>
    ${book.length ? `<div class="card"><h2>Proposal price book</h2><small class="hint" style="margin:-4px 0 8px">The built-in items on every proposal. Names and descriptions show to the client; costs are internal.</small>
      <div class="tablewrap"><table class="prodtable"><thead><tr><th>Name</th><th class="num">Setup</th><th class="num">Monthly</th><th class="num">Setup cost</th><th class="num">Monthly cost</th><th class="num">Margin</th></tr></thead><tbody>
        ${book.map((b) => `<tr data-bk="${esc(b.key)}" tabindex="0"><td><b>${esc(b.title)}</b>${b.description ? `<small class="pdesc">${esc(String(b.description).slice(0, 120))}</small>` : ''}</td>
          ${RULED.includes(b.key) ? '<td colspan="5"><small class="hint">Priced by the rules in Pricing</small></td>'
            : `<td class="num">${esc(money(b.setup_price))}</td><td class="num">${esc(money(b.monthly_price))}</td><td class="num">${esc(money(b.setup_cost))}</td><td class="num">${esc(money(b.monthly_cost))}</td>
          <td class="num">${mBadge(marginOf(b.monthly_price, b.monthly_cost))}${Number(b.setup_price) ? `<small class="hint">setup ${pct(marginOf(b.setup_price, b.setup_cost))}</small>` : ''}</td>`}</tr>`).join('')}
      </tbody></table></div></div>` : ''}`;

  const live = (d, priceId, costId, outId) => {
    const go = () => { const m = marginOf(String($(priceId, d).value).replace(/[$,\s]/g, ''), String($(costId, d).value).replace(/[$,\s]/g, '')); $(outId, d).innerHTML = m == null ? '' : 'Margin ' + mBadge(m); };
    $(priceId, d).addEventListener('input', go); $(costId, d).addEventListener('input', go); go();
  };
  const num = (v) => { const t = String(v ?? '').replace(/[$,\s]/g, ''); return t === '' ? 0 : Number(t); };
  const qtyLabel = (u) => u === 'hour' ? 'Default hours' : u === 'each' ? 'Default quantity' : `Default quantity (${(UNITS.find(([v]) => v === u)?.[1] || '').toLowerCase()})`;
  const edit = (p = { name: '', description: '', code: '', price: '', setup_price: 0, unit: 'each', taxable: false, frequency: 'once', custom_every: '', custom_unit: 'day' }) => {
    const c = cmap[p.id] || {};
    const d = dlg('prEdit', `<div class="vhead"><h2 style="margin:0">${p.id ? 'Edit product/service' : 'New product/service'}</h2><button class="btn ghost small" data-x>Close</button></div>
      <label class="label" for="prName">Name</label><input type="text" id="prName" maxlength="200" value="${esc(p.name)}">
      <label class="label" for="prDesc">Description (shows to the customer)</label><textarea id="prDesc">${esc(p.description)}</textarea>
      <div class="row"><div><label class="label" for="prFreq">Billed</label><select id="prFreq">${Object.entries(FREQ).map(([v, n]) => `<option value="${v}" ${p.frequency === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div id="prCustom" ${p.frequency === 'custom' ? '' : 'hidden'}><label class="label" for="prEvery">Every</label><div style="display:flex;gap:6px"><input type="number" id="prEvery" min="1" max="365" value="${esc(p.custom_every || '')}" style="width:80px">
          <select id="prCU">${['day', 'week', 'month', 'year'].map((u) => `<option value="${u}" ${p.custom_unit === u ? 'selected' : ''}>${u}s</option>`).join('')}</select></div></div>
        <div><label class="label" for="prUnit">Priced</label><select id="prUnit">${UNITS.map(([v, n]) => `<option value="${v}" ${p.unit === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div><label class="label" for="prCode">Code (optional)</label><input type="text" id="prCode" maxlength="40" value="${esc(p.code)}"></div>
        <div><label class="label" for="prQty" id="prQtyL">${qtyLabel(p.unit)}</label><input type="number" id="prQty" min="0" step="any" value="${esc(p.default_qty ?? '')}" placeholder="1"></div></div>
      <div class="pgrid2">
        <div class="pbox"><b>Price</b><div class="row"><div><label class="label" for="prPrice">Price</label><input type="text" id="prPrice" inputmode="decimal" value="${esc(p.price)}" placeholder="0.00"></div>
          ${costsOn ? `<div><label class="label" for="prCost">Your cost <small>team only</small></label><input type="text" id="prCost" inputmode="decimal" value="${esc(c.cost ?? '')}" placeholder="0.00"></div>` : ''}</div>
          <small class="hint" id="prM"></small></div>
        <div class="pbox"><b>Setup fee <small class="hint" style="display:inline">optional, one time</small></b><div class="row"><div><label class="label" for="prSetup">Setup price</label><input type="text" id="prSetup" inputmode="decimal" value="${esc(Number(p.setup_price) || '')}" placeholder="0.00"></div>
          ${costsOn ? `<div><label class="label" for="prSetupCost">Setup cost <small>team only</small></label><input type="text" id="prSetupCost" inputmode="decimal" value="${esc(c.setup_cost ?? '')}" placeholder="0.00"></div>` : ''}</div>
          <small class="hint" id="prSM"></small></div></div>
      <label class="check"><input type="checkbox" id="prTax" ${p.taxable ? 'checked' : ''}> Taxable (uses your default tax rate)</label>
      <div class="actions"><button class="btn" id="prSave">Save</button>${p.id ? '<button class="btn ghost danger" id="prArch">Remove</button>' : ''}</div>`);
    $('[data-x]', d).onclick = () => d.close();
    $('#prFreq', d).onchange = (e) => ($('#prCustom', d).hidden = e.target.value !== 'custom');
    $('#prUnit', d).onchange = (e) => ($('#prQtyL', d).textContent = qtyLabel(e.target.value));
    if (costsOn) { live(d, '#prPrice', '#prCost', '#prM'); live(d, '#prSetup', '#prSetupCost', '#prSM'); }
    $('#prSave', d).onclick = async () => {
      const price = num($('#prPrice', d).value), setup = num($('#prSetup', d).value);
      if (!$('#prName', d).value.trim()) return C.toast('Give it a name');
      if ($('#prPrice', d).value.trim() === '' || !(price >= 0)) return C.toast('Add the price');
      if (!(setup >= 0)) return C.toast('Setup price needs to be a number');
      const freq = $('#prFreq', d).value;
      const row = { name: $('#prName', d).value.trim(), description: $('#prDesc', d).value.trim(), code: $('#prCode', d).value.trim(), price, setup_price: setup, unit: $('#prUnit', d).value,
        taxable: $('#prTax', d).checked, frequency: freq, custom_every: freq === 'custom' ? Number($('#prEvery', d).value) || null : null, custom_unit: freq === 'custom' ? $('#prCU', d).value : null };
      if (freq === 'custom' && !row.custom_every) return C.toast('How often? Like every 10 days');
      const dq = $('#prQty', d).value.trim();
      if (dq !== '' && !(Number(dq) > 0)) return C.toast('Default quantity needs to be more than 0');
      if (dq !== '' || p.default_qty != null) row.default_qty = dq === '' ? null : Number(dq);
      let id = p.id;
      if (id) { const { error: e } = await sb.from('products').update(row).eq('id', id); if (e) return C.fail(e); }
      else { const { data: ins, error: e } = await sb.from('products').insert({ ...row, sort: all.length + 1 }).select('id').single(); if (e) return C.fail(e); id = ins.id; }
      if (costsOn) {
        const cost = num($('#prCost', d).value), setup_cost = num($('#prSetupCost', d).value);
        if (!(cost >= 0) || !(setup_cost >= 0)) return C.toast('Costs need to be numbers');
        const { error: e } = await sb.from('product_costs').upsert({ product_id: id, cost, setup_cost, updated_at: new Date().toISOString() }); if (e) return C.fail(e);
      }
      d.close(); C.toast('Saved'); viewProducts(main);
    };
    if ($('#prArch', d)) $('#prArch', d).onclick = async () => {
      if (!confirm(`Remove ${p.name}? Invoices and proposals that already have it keep their lines.`)) return;
      const { error: e } = await sb.from('products').update({ archived_at: new Date().toISOString() }).eq('id', p.id); if (e) return C.fail(e); d.close(); viewProducts(main);
    };
    $('#prName', d).focus();
  };
  const editBook = (b) => {
    const ruled = RULED.includes(b.key);
    const f = (k, label, team) => `<div><label class="label" for="bk_${k}">${label}${team ? ' <small>team only</small>' : ''}</label><input type="text" id="bk_${k}" inputmode="decimal" value="${esc(Number(b[k]) || 0)}"></div>`;
    const d = dlg('bkEdit', `<div class="vhead"><h2 style="margin:0">Proposal item</h2><button class="btn ghost small" data-x>Close</button></div>
      <label class="label" for="bkTitle">Name (shows to the client)</label><input type="text" id="bkTitle" value="${esc(b.title)}">
      <label class="label" for="bkDesc">Description (shows to the client)</label><textarea id="bkDesc" rows="3">${esc(b.description || '')}</textarea>
      ${ruled ? '<p class="hint">This one is priced by the rules in <a href="#pricing">Pricing</a> (hourly rates and hosting).</p>' : `<div class="pgrid2">
        <div class="pbox"><b>Setup</b><div class="row">${f('setup_price', 'Price')}${f('setup_cost', 'Cost', true)}</div><small class="hint" id="bkSM"></small></div>
        <div class="pbox"><b>Monthly</b><div class="row">${f('monthly_price', 'Price')}${f('monthly_cost', 'Cost', true)}</div><small class="hint" id="bkMM"></small></div></div>`}
      <p class="hint">Applies to new proposals and drafts. Anything already sent keeps its prices.</p>
      <div class="actions"><button class="btn" id="bkSave">Save</button></div>`);
    $('[data-x]', d).onclick = () => d.close();
    if (!ruled) { live(d, '#bk_setup_price', '#bk_setup_cost', '#bkSM'); live(d, '#bk_monthly_price', '#bk_monthly_cost', '#bkMM'); }
    $('#bkSave', d).onclick = async () => {
      const row = { key: b.key, title: $('#bkTitle', d).value.trim(), description: $('#bkDesc', d).value.trim() };
      if (!row.title) return C.toast('Give it a name');
      if (!ruled) for (const k of ['setup_price', 'setup_cost', 'monthly_price', 'monthly_cost']) { row[k] = num($('#bk_' + k, d).value); if (!(row[k] >= 0)) return C.toast('Prices and costs need to be numbers'); }
      const { error: e } = await sb.rpc('proposal_settings_save', { p: { settings: {}, book: [row] } }); if (e) return C.fail(e);
      C.resetPrices?.(); d.close(); C.toast('Saved'); viewProducts(main);
    };
  };
  $('#prNew').onclick = () => edit();
  $$('[data-pr]', main).forEach((r) => { const o = () => edit(all.find((x) => x.id === r.dataset.pr)); r.onclick = o; r.onkeydown = (e) => e.key === 'Enter' && o(); });
  $$('[data-bk]', main).forEach((r) => { const o = () => editBook(book.find((x) => x.key === r.dataset.bk)); r.onclick = o; r.onkeydown = (e) => e.key === 'Enter' && o(); });
}

async function payBox(box, s, edit, back) {
  const call = async (action) => {
    const { data, error } = await sb.functions.invoke('payments-connect', { body: { action } });
    if (error) return { error: (await error.context?.json?.().catch(() => null))?.error || error.message };
    return data || { error: 'No answer from the payment service' };
  };
  // back from "I already have Stripe": finish the link while signed in, then tidy the address bar
  const q = new URLSearchParams(location.search);
  let done = null;
  if (q.get('so_state')) {
    const { data, error } = await sb.functions.invoke('payments-connect', { body: { action: 'login_finish', code: q.get('so_code'), state: q.get('so_state'), error: q.get('so_error'), error_description: q.get('so_error_description') } });
    done = error ? { error: (await error.context?.json?.().catch(() => null))?.error || error.message } : data;
    history.replaceState(null, '', location.pathname + location.hash);
    if (!done?.error) { SET = null; s = await settings(true); C.toast('Stripe connected'); }
  }
  const st0 = s.stripe?.account || back || edit ? await call('status') : { connected: false };
  const st = done?.error ? { ...st0, error: done.error } : st0;
  const now = st.connected ? (st.ready ? 'stripe' : null) : null;
  const house = !!st.house && !st.connected, gelp = !house && s.pay_method === 'platform' && !st.connected;
  box.innerHTML = `${st.error ? `<p class="banner warn">${esc(st.error)}</p>` : ''}
    ${st.connected ? (st.ready ? `<p><span class="badge ok">Stripe connected</span> ${esc(st.name || '')}. Customers pay you straight into your own Stripe account. No platform fee.</p>`
      : `<p><span class="badge gold">Stripe not finished</span> Stripe still needs a few details before you can take payments.</p>`)
      : house ? '<p><span class="badge ok">Platform Stripe</span> This account takes payments straight into the platform\'s own Stripe, so invoices get a pay button for the exact balance. Connect your own Stripe below whenever you\'re ready; once it\'s connected, payments go there instead.</p>'
      : gelp ? '<p><span class="badge ok">GELP\'s Stripe</span> This account collects through GELP\'s own Stripe (the online payment switch in Pricing).</p>'
      : '<p>Connect Stripe so customers can pay invoices by card or bank. Already have Stripe? Sign in with it. No Stripe yet? Apply right here, it takes about 10 minutes. Money goes straight to you, and you handle refunds and disputes in Stripe.</p>'}
    ${edit ? `<div class="actions">${!st.connected && st.login ? '<button class="btn small" id="spIn">I already have Stripe</button>' : ''}${!st.connected || !st.ready ? `<button class="btn ${!st.connected && st.login ? 'secondary' : ''} small" id="spGo">${st.connected ? 'Finish Stripe setup' : st.login ? 'Apply for Stripe' : 'Connect Stripe'}</button>` : ''}
      ${st.connected ? '<button class="btn ghost small" id="spChk">Check again</button><button class="btn ghost small danger" id="spOff">Disconnect</button>' : ''}</div><div id="spMsg"></div>` : ''}
    <p class="hint">Pay button right now: <b>${esc({ stripe: 'your Stripe', platform: house ? 'the platform Stripe' : gelp ? 'GELP\'s Stripe' : 'the platform Stripe', link: 'your payment link' }[now || s.pay_method] || 'none')}</b>.</p>`;
  if ($('#spGo', box)) $('#spGo', box).onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Opening Stripe…';
    const r = await call('connect');
    if (r.url) { location.href = r.url; return; }
    e.target.disabled = false; e.target.textContent = st.connected ? 'Finish Stripe setup' : 'Connect Stripe';
    $('#spMsg', box).innerHTML = `<p class="banner warn">${esc(r.error || 'Stripe didn\'t answer. Try again in a minute.')}</p>`;
  };
  if ($('#spIn', box)) $('#spIn', box).onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Opening Stripe…';
    const r = await call('login');
    if (r.url) { location.href = r.url; return; }
    e.target.disabled = false; e.target.textContent = 'I already have Stripe';
    $('#spMsg', box).innerHTML = `<p class="banner warn">${esc(r.error || 'Stripe didn\'t answer. Try again in a minute.')}</p>`;
  };
  if ($('#spChk', box)) $('#spChk', box).onclick = async () => { await call('status'); SET = null; payBox(box, await settings(true), edit, true); };
  if ($('#spOff', box)) $('#spOff', box).onclick = async () => {
    if (!confirm('Disconnect Stripe? Invoices lose the pay button (or fall back to your payment link). Your Stripe account itself isn\'t touched.')) return;
    const r = await call('disconnect'); if (r.error) return C.toast(r.error, { error: true }); SET = null; payBox(box, await settings(true), edit, false);
  };
}
