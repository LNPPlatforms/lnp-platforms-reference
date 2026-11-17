/* The one document layout for estimates, proposals and invoices (decided Oct 29, BACKLOG.md).
   Title top left, logo top right (brand kit: wide, else default, else the company name in bold), a full-width line in the
   account's primary color, customer on the left, company plus number, PO and dates on the right, the lines, the totals,
   then notes and terms, and the standard footer. Used by the customer page (/doc/) and the preview inside the CRM.
   Print-to-PDF comes from the print rules at the bottom of DOC_CSS. */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n) => (Number(n) < 0 ? '-$' : '$') + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (s) => (s ? new Date(String(s).length === 10 ? s + 'T12:00:00' : s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? v : '#1A2A52');
const METHOD = { card: 'Card', bank: 'Bank transfer', check: 'Check', cash: 'Cash', link: 'Payment link', other: 'Other' };
const nl = (s) => esc(s).replace(/\n/g, '<br>');

// the same math the database does (069c), for live totals while someone types. The saved numbers always come from the database.
export function totals(lines, discount = 0, deposit = 0, paid = 0) {
  const num = (v, d) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v));
  const r2 = (n) => Math.round(n * 100) / 100;
  let sub = 0, tax = 0;
  const out = (lines || []).map((l) => {
    const qty = num(l.qty, 1), price = num(l.price, 0), rate = Math.min(100, Math.max(0, num(l.tax, 0)));
    const total = r2(qty * price), taxAmt = r2(total * rate / 100);
    sub += total; tax += taxAmt;
    return { ...l, qty, price, tax: rate, total, tax_amt: taxAmt };
  });
  sub = r2(sub);
  const disc = Math.min(Math.max(Number(discount) || 0, 0), Math.max(sub, 0));
  const taxTotal = sub > 0 ? r2(tax * (sub - disc) / sub) : r2(tax);
  const total = r2(sub - disc + taxTotal);
  const dep = Math.min(Math.max(Number(deposit) || 0, 0), Math.max(total, 0));
  return { lines: out, subtotal: sub, discount: disc, tax_total: taxTotal, total, deposit: dep, paid_total: Number(paid) || 0, balance: r2(total - dep - (Number(paid) || 0)) };
}

/* d: what doc_view returns (kind invoice or proposal), or the same shape built in the CRM.
   opts.payButton: html for the pay area (invoices); opts.acceptButton: html for proposals; opts.status: a small banner */
export function docHtml(d, opts = {}) {
  const b = d.brand || {};
  const color = hex(b.color);
  const isInv = d.kind !== 'proposal' && d.kind !== 'estimate';
  const logo = b.logo ? `<img src="${esc(b.logo)}" alt="${esc(b.name || '')}">` : `<b class="doc-name">${esc(b.name || '')}</b>`;
  const c = d.customer || {};
  const meta = [
    [isInv ? 'Invoice' : d.title || 'Proposal', d.number != null && d.number !== '' ? (isInv ? '' : 'Version ') + d.number : ''],
    ['PO', d.po], ['Date', day(d.issue_date)],
    isInv ? ['Due', day(d.due_date)] : ['Good until', day(d.expires_at)],
  ].filter(([, v]) => v);
  const code = !!d.show_code, tax = !!d.show_tax;
  const lines = d.lines || [];
  const head = `<tr>${code ? '<th class="c-code">Item code</th>' : ''}<th class="c-item">Item</th><th class="c-num">Qty</th><th class="c-num">${isInv ? 'Unit price' : 'Price'}</th>${tax ? '<th class="c-num">Tax</th>' : ''}<th class="c-num">${isInv ? 'Total' : 'Due at signing'}</th></tr>`;
  const row = (l) => `<tr${l.optional ? ' class="opt"' : ''}>${code ? `<td class="c-code">${esc(l.code || '')}</td>` : ''}<td class="c-item"><b>${esc(l.name)}</b>${l.desc ? `<div class="doc-desc">${nl(l.desc)}</div>` : ''}${l.recurring ? `<div class="doc-desc">${esc(l.recurring)}</div>` : ''}</td>
    <td class="c-num">${esc(Number(l.qty ?? 1).toLocaleString('en-US'))}</td><td class="c-num">${isInv && Number(l.retail) > Number(l.price) ? `<s class="doc-was">${money(l.retail)}</s> ` : ''}${money(l.price)}</td>${tax ? `<td class="c-num">${Number(l.tax) ? esc(l.tax) + '%' : ''}</td>` : ''}<td class="c-num">${money(l.total)}</td></tr>`;
  const main = lines.filter((l) => !l.optional), optional = lines.filter((l) => l.optional);
  const t = (label, v, cls = '') => `<div class="doc-trow ${cls}"><span>${label}</span><span>${v}</span></div>`;
  const pays = d.payments || [];
  const totalsHtml = isInv ? [
    t('Subtotal', money(d.subtotal)),
    Number(d.discount) > 0 ? t('Discount', money(-d.discount)) : '',
    t('Tax', money(d.tax_total)),
    t('Total', money(d.total), 'big'),
    Number(d.deposit) > 0 ? t('Deposit paid', money(-d.deposit)) : '',
    Number(d.paid_total) > 0 ? `<details class="doc-paid noprint-open"><summary>${t('Payments received', money(-d.paid_total))}</summary>
      ${pays.map((p) => `<div class="doc-trow small"><span>${esc(day(p.paid_on))} · ${esc(METHOD[p.method] || p.method)}${p.reference ? ' · ' + esc(p.reference) : ''}</span><span>${money(p.amount)}</span></div>`).join('')}</details>` : '',
    Number(d.deposit) > 0 || Number(d.paid_total) > 0 ? t('Balance due', money(d.balance), 'big') : '',
    Number(d.savings) > 0 ? t('You saved', money(d.savings), 'save') : '',
  ].join('') : [
    Number(d.discount) > 0 ? t('Before discount', money(d.gross)) + t('Discount', money(-d.discount)) : '',
    t('Due at signing', money(d.total), 'big'),
    Number(d.monthly) > 0 ? t('Then monthly', money(d.monthly) + '/mo') : '',
    Number(d.weekly) > 0 ? t('Then weekly', money(d.weekly) + '/week') : '',
  ].join('');
  const history = isInv && pays.length ? `<section class="doc-hist"><h3>Payment history</h3><table class="doc-lines"><thead><tr><th class="c-item">Date</th><th class="c-item">How</th><th class="c-item">Reference</th><th class="c-num">Amount</th></tr></thead>
    <tbody>${pays.map((p) => `<tr><td>${esc(day(p.paid_on))}</td><td>${esc(METHOD[p.method] || p.method)}</td><td>${esc(p.reference || '')}</td><td class="c-num">${money(p.amount)}</td></tr>`).join('')}</tbody></table></section>` : '';
  const foot = [b.name, b.address, b.phone, b.email].filter(Boolean).map(esc).join(' · ');
  return `<article class="doc" style="--brand:${color}">
    ${opts.status || ''}
    <header class="doc-top"><h1 class="doc-title">${esc(isInv ? 'Invoice' : d.title || 'Proposal')}</h1><div class="doc-logo">${logo}</div></header>
    <div class="doc-rule"></div>
    <section class="doc-parties">
      <div class="doc-cust"><small>${isInv ? 'Bill to' : 'Prepared for'}</small><b>${esc(c.name || '')}</b>${c.org && c.org !== c.name ? `<div>${esc(c.org)}</div>` : ''}
        ${c.address ? `<div>${esc(c.address)}</div>` : ''}${c.email ? `<div>${esc(c.email)}</div>` : ''}${c.phone ? `<div>${esc(c.phone)}</div>` : ''}</div>
      <div class="doc-co"><b>${esc(b.name || '')}</b>${b.address ? `<div>${esc(b.address)}</div>` : ''}${b.phone ? `<div>${esc(b.phone)}</div>` : ''}${b.email ? `<div>${esc(b.email)}</div>` : ''}
        <dl>${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>
    </section>
    <table class="doc-lines"><thead>${head}</thead><tbody>${main.map(row).join('') || `<tr><td colspan="6" class="doc-desc">No lines yet</td></tr>`}</tbody></table>
    ${optional.length ? `<h3 class="doc-opt">Optional items</h3><table class="doc-lines"><tbody>${optional.map(row).join('')}</tbody></table>` : ''}
    <div class="doc-totals">${totalsHtml}</div>
    ${opts.payButton ? `<div class="doc-pay noprint">${opts.payButton}</div>` : ''}
    ${opts.acceptButton ? `<div class="doc-pay noprint">${opts.acceptButton}</div>` : ''}
    ${(d.pictures || []).length ? `<section class="doc-pics">${d.pictures.map((p) => `<figure><img src="${esc(p.url)}" alt="${esc(p.title || 'Picture')}">${p.title ? `<figcaption>${esc(p.title)}</figcaption>` : ''}</figure>`).join('')}</section>` : ''}
    ${history}
    ${d.notes ? `<section class="doc-notes"><h3>Notes</h3><p>${nl(d.notes)}</p></section>` : ''}
    ${d.terms ? `<section class="doc-notes"><h3>Terms</h3><p>${nl(d.terms)}</p></section>` : ''}
    ${d.pay_instructions ? `<section class="doc-notes"><h3>How to pay</h3><p>${nl(d.pay_instructions)}</p></section>` : ''}
    <footer class="doc-foot">${foot}</footer>
  </article>`;
}

// a proposal from proposal_view, in the same shape (lines due at signing; monthly and weekly shown under each line and in the totals)
export function fromProposal(p) {
  const v = p.view || {}, q = v.quote || {};
  const lines = (q.lines || []).filter((l) => (Number(l.ph) || 1) === 1).map((l) => {
    const rec = [Number(l.mo) > 0 ? money(l.mo) + '/mo' : '', Number(l.wk) > 0 ? money(l.wk) + '/week' : ''].filter(Boolean).join(' and ');
    return { name: l.title, desc: l.sub || '', qty: 1, price: Number(l.setup) || 0, total: Number(l.setup) || 0, optional: !!l.optional, recurring: rec ? 'Then ' + rec : '' };
  });
  // due at signing also takes the first month or week of what isn't on a free trial, same as checkout
  const trial = (q.lines || []).some((l) => (Number(l.ph) || 1) === 1 && Number(l.trial) > 0), off = 1 - (Number(q.month?.pct) || 0) / 100;
  const p1 = (q.lines || []).filter((l) => (Number(l.ph) || 1) === 1 && !(Number(l.trial) > 0));
  const mo = Math.max(0, trial ? p1.reduce((a, l) => a + (Number(l.mo) || 0), 0) * off : Number(q.month?.net) || 0);
  const wk = Math.max(0, trial ? p1.reduce((a, l) => a + (Number(l.wk) || 0), 0) * off : Number(q.week?.net) || 0);
  const first = [[mo, 'First month of monthly services'], [wk, 'First week of weekly services']].filter(([x]) => x > 0)
    .map(([x, name]) => ({ name, desc: 'Billed in advance at signing', qty: 1, price: x, total: x, optional: false, recurring: '' }));
  lines.push(...first);
  const firstSum = first.reduce((a, l) => a + l.total, 0);
  return { ...p, lines, gross: q.setup?.gross != null ? q.setup.gross + firstSum : undefined, discount: q.setup?.disc,
    total: q.setup?.net != null ? q.setup.net + firstSum : lines.reduce((a, l) => a + l.total, 0),
    monthly: q.month?.net, weekly: q.week?.net, notes: v.note, terms: v.terms, show_code: false, show_tax: false,
    pictures: (v.mockups || []).filter((m) => m.measure && m.type === 'image').map((m) => ({ url: m.url, title: m.title })) };
}

export const DOC_CSS = `
.doc{--brand:#1A2A52;background:#fff;color:#1d2433;max-width:820px;margin:0 auto;padding:40px 44px;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.doc-top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
.doc-title{font-size:32px;margin:0;letter-spacing:.5px;color:#1d2433;font-weight:700}
.doc-logo img{max-height:64px;max-width:260px;display:block}
.doc-name{font-size:22px}
.doc-rule{height:3px;background:var(--brand);margin:16px 0 22px;border-radius:2px}
.doc-parties{display:flex;justify-content:space-between;gap:24px;margin-bottom:26px}
.doc-parties small{display:block;text-transform:uppercase;font-size:11px;letter-spacing:1px;color:#6b7690;margin-bottom:2px}
.doc-co{text-align:right}
.doc-co dl{display:grid;grid-template-columns:auto auto;gap:2px 12px;justify-content:end;margin:10px 0 0}
.doc-co dt{color:#6b7690}.doc-co dd{margin:0;font-weight:600}
.doc-lines{width:100%;border-collapse:collapse;margin-bottom:10px}
.doc-lines th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:#6b7690;border-bottom:2px solid var(--brand);padding:6px 6px}
.doc-lines td{border-bottom:1px solid #e7eaf0;padding:9px 6px;vertical-align:top}
.doc-lines .c-num{text-align:right;white-space:nowrap}.doc-lines .c-code{width:90px;color:#6b7690}
.doc-desc{color:#6b7690;font-size:13px;margin-top:2px}
.doc-lines tr.opt td{color:#6b7690}
.doc-opt{font-size:13px;margin:16px 0 4px;text-transform:uppercase;letter-spacing:.8px;color:#6b7690}
.doc-totals{margin-left:auto;max-width:320px}
.doc-trow{display:flex;justify-content:space-between;gap:16px;padding:4px 6px}
.doc-trow.big{font-weight:700;font-size:16px;border-top:1px solid #e7eaf0;padding-top:8px}
.doc-trow.save{color:#1f7a3a;font-weight:600}.doc-was{color:#8a93a6;font-weight:400;margin-right:2px}
.doc-trow.small{font-size:12px;color:#6b7690;padding:2px 6px 2px 16px}
.doc-paid summary{list-style:none;cursor:pointer}.doc-paid summary::-webkit-details-marker{display:none}
.doc-paid summary .doc-trow span:first-child:after{content:" ▸";color:#6b7690}.doc-paid[open] summary .doc-trow span:first-child:after{content:" ▾"}
.doc-pay{margin:22px 0 4px;text-align:right}
.doc-pay .btn,.doc-paybtn{display:inline-block;background:var(--brand);color:#fff;border:0;border-radius:8px;padding:12px 26px;font-weight:700;font-size:15px;text-decoration:none;cursor:pointer}
.doc-pics{margin-top:22px}.doc-pics figure{margin:0 0 14px;break-inside:avoid}.doc-pics img{display:block;max-width:100%;border-radius:8px;border:1px solid #e7eaf0}
.doc-pics figcaption{color:#6b7690;font-size:12px;margin-top:4px}
.doc-hist{margin-top:24px}
.doc-hist h3,.doc-notes h3{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b7690;margin:22px 0 4px}
.doc-notes p{margin:0;white-space:normal}
.doc-foot{margin-top:34px;padding-top:12px;border-top:1px solid #e7eaf0;color:#6b7690;font-size:12px;text-align:center}
.doc-status{background:#eef6ee;color:#245c2a;border-radius:8px;padding:10px 14px;margin-bottom:18px;font-weight:600}
.doc-status.warn{background:#fff6e5;color:#7a5200}
@media screen{.doc-hist{display:none}}
@media (max-width:640px){.doc{padding:24px 18px}.doc-parties{flex-direction:column}.doc-co{text-align:left}.doc-co dl{justify-content:start}.doc-title{font-size:26px}.doc-lines .c-code{display:none}}
@media print{body{background:#fff!important}.noprint,.noprint *{display:none!important}.doc{box-shadow:none;max-width:none;padding:0;border-radius:0}.doc-hist{display:block}
  .doc-paid summary .doc-trow span:first-child:after{content:""}.doc-paid > .doc-trow{display:none}.doc-lines tr{break-inside:avoid}@page{margin:16mm}}
`;
