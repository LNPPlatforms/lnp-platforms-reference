/* plans.js: packages and client plans for agencies (091, Chris by voice Nov 10).
   - Tools > Admin > Packages: the agency's bundles of features, with a price.
   - planEditor: a client account's plan (a package, a package with changes, or features picked one by one) and how it's billed:
     a repeating invoice in the agency's own CRM, "billing handled" (trades, checks, $0), or off. Trial and grace days.
   - planLabel: what the Accounts list shows, which is what the client is billed for ("Service Pro + Social planner − Time clock").
   - crmClientCard: on an organization in the agency's own CRM, mark it a CRM client, pick the plan and create the account. */
import * as FLD from './field.js?v=20261116t';

let C = null, sb, S, esc, $, $$;
export function init(ctx) { C = ctx; ({ sb, S, esc, $, $$ } = ctx); }
const FEATS = () => FLD.FEATURES;
const fname = (k) => FEATS().find((f) => f.key === k)?.label || k;
const isAgencyHere = () => !!(S.acct?.is_agency && S.acct?.platform_admin);
export const parents = { packages: 'tools' };
export const views = () => ({ packages: viewPackages });
export const guards = { packages: () => isAgencyHere() };

let PK = null;
async function loadPackages(force) {
  if (PK && !force) return PK;
  const { data, error } = await sb.from('packages').select('*').eq('tenant_id', S.acct.id).is('archived_at', null).order('sort').order('name');
  PK = error ? null : data || [];
  return PK;
}

// "Service Pro", "Service Pro + Social planner − Time clock", or with no package the features themselves
export function planLabel(p, pkgs = PK || []) {
  if (!p) return '';
  const allowed = p.allowed || [];
  const pk = p.package_id && (pkgs.find((x) => x.id === p.package_id) || (p.package ? { name: p.package, features: p.package_features || [] } : null));
  if (!pk) return allowed.length ? allowed.map(fname).join(', ') : 'Core CRM only';
  const add = allowed.filter((k) => !(pk.features || []).includes(k)), rem = (pk.features || []).filter((k) => !allowed.includes(k));
  return [pk.name, ...add.map((k) => '+ ' + fname(k)), ...rem.map((k) => '− ' + fname(k))].join(' ');
}
export function billingLabel(p) {
  const b = p?.billing || {};
  if (!p || p.billing_mode === 'off') return '';
  if (p.billing_mode === 'bypass') return '<span class="badge">Billing handled</span>';
  if (!p.billing_schedule_id) return '<span class="badge due">No repeating invoice linked</span>';
  return { ok: '<span class="badge ok">Paid up</span>', trial: `<span class="badge type">Trial to ${esc(C.fmtDate(b.trial_ends))}</span>`, setup: '<span class="badge gold">Waiting on first payment</span>',
    grace: `<span class="badge due">${esc(String(b.days_late))} days late</span>`, locked: '<span class="badge bad">Paused for billing</span>' }[b.state] || '';
}

/* ---------- Tools > Admin > Packages ---------- */
async function viewPackages(main) {
  const list = await loadPackages(true);
  if (list === null) { main.innerHTML = '<h1>Packages</h1><p class="empty">Packages need the November 10 database update (091).</p>'; return; }
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Packages</h1><button class="btn small" id="pkNew">+ New package</button></div>
    <p class="hint">Bundles of features you sell to your client accounts. Put a client on a package from the Accounts list or from their organization. You can still add or take away features for one client; their row shows the changes. Clients can switch their features on and off, but never anything outside their plan.</p>
    <div class="list">${list.map((p) => `<button type="button" class="item" data-pk="${p.id}"><b>${esc(p.name)}</b>${p.price != null ? ` <span class="badge gold">${esc(C.money(p.price))}/mo${p.price_per === 'user' ? ' per user' : ''}</span>` : ''}
      <small>${esc((p.features || []).map(fname).join(', ') || 'Core CRM only')}</small>${p.description ? `<small>${esc(p.description)}</small>` : ''}</button>`).join('')
      || '<p class="empty">No packages yet. Make one for each level you sell, like Basic and Service Pro.</p>'}</div>`;
  $('#pkNew').onclick = () => editPackage(main);
  $$('[data-pk]', main).forEach((b) => (b.onclick = () => editPackage(main, list.find((x) => x.id === b.dataset.pk))));
}
function editPackage(main, p = { name: '', description: '', features: ['sales', 'inbox', 'sites', 'social'], price: '', price_per: 'account' }) {
  const d = document.createElement('dialog'); d.className = 'vdlg'; document.body.appendChild(d);
  d.innerHTML = `<div class="vhead"><h2 style="margin:0">${p.id ? 'Edit package' : 'New package'}</h2><button class="btn ghost small" data-x>Close</button></div>
    <label class="label" for="pkName">Name</label><input type="text" id="pkName" maxlength="60" value="${esc(p.name)}" placeholder="Service Pro">
    <label class="label" for="pkDesc">Description (optional)</label><input type="text" id="pkDesc" maxlength="200" value="${esc(p.description || '')}">
    <div class="row"><div><label class="label" for="pkPrice">Price a month (optional)</label><input type="text" id="pkPrice" inputmode="decimal" value="${esc(p.price ?? '')}" placeholder="0.00"></div>
      <div><label class="label" for="pkPer">Priced</label><select id="pkPer"><option value="account" ${p.price_per !== 'user' ? 'selected' : ''}>Per account</option><option value="user" ${p.price_per === 'user' ? 'selected' : ''}>Per user</option></select></div></div>
    <b class="label" style="display:block;margin-top:10px">Features in it</b><small class="hint">Contacts, organizations, to-dos and the core CRM are always included.</small>
    <div class="featpick">${featBoxes('pkf', p.features || [])}</div>
    <div class="actions"><button class="btn" id="pkSave">Save</button>${p.id ? '<button class="btn ghost danger" id="pkArch">Retire it</button>' : ''}</div>`;
  d.showModal();
  wireFeatBoxes(d, 'pkf');
  const close = () => { d.close(); d.remove(); };
  $('[data-x]', d).onclick = close;
  $('#pkSave', d).onclick = async () => {
    const { error } = await sb.rpc('package_save', { p: { id: p.id || '', agency: S.acct.id, name: $('#pkName', d).value, description: $('#pkDesc', d).value,
      price: String($('#pkPrice', d).value).replace(/[$,\s]/g, ''), price_per: $('#pkPer', d).value, features: picked(d, 'pkf') } });
    if (error) return C.fail(error);
    close(); C.toast('Saved'); viewPackages(main);
  };
  if ($('#pkArch', d)) $('#pkArch', d).onclick = async () => {
    if (!confirm(`Retire ${p.name}? Clients on it keep their features; their row shows the features instead of the package name.`)) return;
    const { error } = await sb.rpc('package_archive', { p_id: p.id }); if (error) return C.fail(error); close(); viewPackages(main);
  };
}
const featBoxes = (pre, on) => FEATS().map((f) => `<label class="check featrow"><input type="checkbox" data-${pre}="${f.key}" ${on.includes(f.key) ? 'checked' : ''}${f.needs ? ` data-needs="${f.needs}"` : ''}>
  <span><b>${esc(f.label)}</b><small class="hint" style="margin:0">${esc(f.what)}</small></span></label>`).join('');
const picked = (root, pre) => $$(`[data-${pre}]`, root).filter((x) => x.checked).map((x) => x.getAttribute(`data-${pre}`));
// a feature that needs another one (Dispatch needs Jobs) can't be on without it
function wireFeatBoxes(root, pre, after) {
  const sync = () => {
    $$(`[data-${pre}][data-needs]`, root).forEach((x) => { const base = $(`[data-${pre}="${x.dataset.needs}"]`, root); x.disabled = !base?.checked; if (x.disabled) x.checked = false; });
    after?.();
  };
  $$(`[data-${pre}]`, root).forEach((x) => (x.onchange = sync)); sync();
}

/* ---------- a client account's plan and billing ---------- */
// opts: { tenant (id, name), plan (current or null), company (id, name) when it's known, onSaved, create: { name, slug, email, owner } for a new account }
export async function planEditor(opts) {
  const pkgs = await loadPackages(true) || [];
  const cur = opts.plan || { package_id: '', allowed: [], billing_mode: 'invoice', grace_days: 7 };
  const companyId = cur.company_id || opts.company?.id || '';
  const [{ data: series }, logins] = await Promise.all([
    companyId ? sb.from('invoice_schedules').select('id,frequency,status,lines,next_run_date').eq('company_id', companyId) : Promise.resolve({ data: [] }),
    opts.tenant?.id ? sb.rpc('account_logins', { p_tenant: opts.tenant.id }).then((r) => r.data || []) : Promise.resolve([])]);
  const sTotal = (x) => (x.lines || []).reduce((n, l) => n + Number(l.qty || 1) * Number(l.price || 0), 0);
  const sLabel = (x) => `${C.money(sTotal(x))} ${x.frequency}${x.status && x.status !== 'active' ? ' (' + x.status + ')' : ''}${x.next_run_date ? ', next ' + C.fmtDate(x.next_run_date) : ''}`;
  const people = (Array.isArray(logins) ? logins : logins.users || []).filter((u) => u.id && u.active !== false);
  const d = document.createElement('dialog'); d.className = 'vdlg'; document.body.appendChild(d);
  const make = !!opts.create;
  d.innerHTML = `<div class="vhead"><h2 style="margin:0">${make ? 'New CRM client account' : `Plan for ${esc(opts.tenant.name)}`}</h2><button class="btn ghost small" data-x>Close</button></div>
    ${make ? `<div class="row"><div><label class="label" for="peName">Account name</label><input type="text" id="peName" value="${esc(opts.create.name || '')}"></div>
        <div><label class="label" for="peSlug">Short name</label><input type="text" id="peSlug" value="${esc(opts.create.slug || '')}"></div></div>
      <div class="row"><div><label class="label" for="peEmail">Their admin's email</label><input type="email" id="peEmail" value="${esc(opts.create.email || '')}"></div>
        <div><label class="label" for="peOwner">Their admin's name</label><input type="text" id="peOwner" value="${esc(opts.create.owner || '')}"></div></div>` : ''}
    <label class="label" for="pePkg">Package</label>
    <select id="pePkg"><option value="">No package (pick features)</option>${pkgs.map((p) => `<option value="${p.id}" ${p.id === cur.package_id ? 'selected' : ''}>${esc(p.name)}${p.price != null ? ` · ${esc(C.money(p.price))}/mo${p.price_per === 'user' ? ' per user' : ''}` : ''}</option>`).join('')}</select>
    ${pkgs.length ? '' : '<small class="hint">No packages yet. Make them in Tools › Admin › Agency › Packages, or just pick features.</small>'}
    <div class="planlabel" id="peLabel"></div>
    <details ${cur.package_id ? '' : 'open'} id="peFeatWrap"><summary>Features they can use</summary><div class="featpick">${featBoxes('pef', cur.allowed || [])}</div></details>
    <h3 style="margin:14px 0 4px">Billing</h3>
    <div class="seg" role="group" aria-label="Billing">${[['invoice', 'Repeating invoice'], ['bypass', 'Billing handled'], ['off', 'Off']].map(([k, l]) => `<button type="button" data-bm="${k}" class="${(cur.billing_mode || 'off') === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <small class="hint" id="peBmHint"></small>
    <div id="peInv">
      ${companyId ? `<label class="label" for="peSeries">Their repeating invoice in your CRM</label>
        <select id="peSeries"><option value="">Pick one</option>${(series || []).map((x) => `<option value="${x.id}" ${x.id === cur.billing_schedule_id ? 'selected' : ''}>${esc(sLabel(x))}</option>`).join('')}</select>
        ${(series || []).length ? '' : `<small class="hint">No repeating invoice on ${esc(opts.company?.name || 'their organization')} yet. Make their first invoice (setup fee plus the first month), then turn on Repeat on it.</small>`}`
        : '<small class="hint">Link their organization in your CRM to pick the repeating invoice. Open the organization and use its CRM client card.</small>'}
      <div class="row"><div><label class="label" for="peTrial">Trial ends (optional)</label><input type="date" id="peTrial" value="${esc(cur.trial_ends || '')}"></div>
        <div><label class="label" for="peGrace">Grace days when late</label><input type="number" id="peGrace" min="0" max="90" value="${esc(cur.grace_days ?? 7)}"></div></div>
    </div>
    ${people.length ? `<label class="label" for="peContact">Billing contact</label><select id="peContact"><option value="">Every admin of the account</option>${people.map((u) => `<option value="${u.id}" ${u.id === cur.billing_contact ? 'selected' : ''}>${esc(u.full_name || u.email)}</option>`).join('')}</select>` : ''}
    <label class="label" for="peNotes">Notes for your team (optional)</label><input type="text" id="peNotes" maxlength="300" value="${esc(cur.notes || '')}" placeholder="Special setup fee, custom price, trade…">
    <div class="actions"><button class="btn" id="peSave">${make ? 'Create account and send invite' : 'Save plan'}</button></div>`;
  d.showModal();
  const close = () => { d.close(); d.remove(); };
  $('[data-x]', d).onclick = close;
  let mode = cur.billing_mode || 'off';
  const hints = { invoice: 'Their account opens once their first invoice is paid, unless you set a trial. Late past the grace days, it pauses until they pay.', bypass: 'No billing checks. For trades, checks and $0 deals.', off: 'No billing checks.' };
  const showMode = () => { $$('[data-bm]', d).forEach((b) => b.classList.toggle('on', b.dataset.bm === mode)); $('#peInv', d).hidden = mode !== 'invoice'; $('#peBmHint', d).textContent = hints[mode]; };
  $$('[data-bm]', d).forEach((b) => (b.onclick = () => { mode = b.dataset.bm; showMode(); })); showMode();
  const label = () => { $('#peLabel', d).textContent = 'Shows as: ' + planLabel({ package_id: $('#pePkg', d).value, allowed: picked(d, 'pef') }, pkgs); };
  wireFeatBoxes(d, 'pef', label);
  $('#pePkg', d).onchange = () => {
    const pk = pkgs.find((x) => x.id === $('#pePkg', d).value);
    if (pk) $$('[data-pef]', d).forEach((x) => (x.checked = (pk.features || []).includes(x.dataset.pef)));
    $('#peFeatWrap', d).open = !pk; wireFeatBoxes(d, 'pef', label);
  };
  label();
  $('#peSave', d).onclick = async () => {
    const plan = { package_id: $('#pePkg', d).value, allowed: picked(d, 'pef'), billing_mode: mode, notes: $('#peNotes', d).value };
    if (companyId) plan.company_id = companyId;
    if (mode === 'invoice') {
      plan.trial_ends = $('#peTrial', d).value; plan.grace_days = $('#peGrace', d).value;
      if ($('#peSeries', d)) plan.billing_schedule_id = $('#peSeries', d).value;
    }
    if ($('#peContact', d)) plan.billing_contact = $('#peContact', d).value;
    const btn = $('#peSave', d); btn.disabled = true;
    let tid = opts.tenant?.id;
    if (make) {
      const email = $('#peEmail', d).value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) { btn.disabled = false; return C.toast('Add their admin\'s email'); }
      const { data, error } = await sb.rpc('create_account', { p_name: $('#peName', d).value, p_slug: $('#peSlug', d).value, p_owner_email: email, p_owner_name: $('#peOwner', d).value, p_agency: S.acct.id });
      if (error) { btn.disabled = false; return C.fail(error); }
      tid = data.id;
    }
    const { error } = await sb.rpc('account_plan_save', { p_tenant: tid, p: plan });
    if (error) { btn.disabled = false; return C.fail(error); }
    if (make) {
      const sent = await C.sendInvite(tid, $('#peEmail', d).value.trim(), true);
      C.toast(sent ? `Account made. Invite emailed to ${$('#peEmail', d).value.trim()}.` : 'Account made, but the invite didn\'t go out. Use Email invite on the Accounts list.', { error: !sent });
      await C.loadAccounts?.();
    } else C.toast('Plan saved');
    close(); opts.onSaved?.(tid);
  };
}

/* ---------- organization page: CRM client card (agency's own CRM) ---------- */
export async function crmClientCard(box, company) {
  if (!box) return;
  if (!isAgencyHere()) { box.innerHTML = ''; return; }
  const { data: plans, error } = await sb.rpc('account_plans_list');
  if (error) { box.innerHTML = ''; return; }
  await loadPackages();
  const mine = (plans || []).filter((p) => p.company_id === company.id);
  const accts = S.accounts || [];
  const isClient = mine.length || (company.org_types || []).includes('CRM client');
  $('#ccMakeMore')?.remove();
  if (!isClient) {
    // not a client yet: no card, just a small option in the page's More menu
    box.innerHTML = '';
    const more = $('#moreBox');
    if (more) more.insertAdjacentHTML('afterbegin', '<button class="btn ghost small" id="ccMakeMore" title="Give them their own account on your CRM, pick their package and invite their admin">Make them a CRM client</button>');
  } else {
    box.innerHTML = `<div class="card crmcard"><h2>CRM client</h2>
      ${mine.map((p) => { const a = accts.find((x) => x.id === p.tenant_id); return `<div class="person-row"><div class="toolbar"><div style="flex:1"><b>${esc(a?.name || 'Their account')}</b><br>
        <small>${esc(planLabel(p))}</small> ${billingLabel(p)}</div><button class="btn small secondary" data-ccplan="${p.tenant_id}">Plan and billing</button></div></div>`; }).join('')}
      <div class="actions"><button class="btn small ${mine.length ? 'ghost' : ''}" id="ccMake">${mine.length ? '+ Another account for them' : 'Create their account'}</button>
      ${!mine.length ? '<button class="btn small ghost" id="ccLink">Link an account that already exists</button>' : ''}</div></div>`;
  }
  const refresh = () => crmClientCard(box, company);
  const primary = async () => {
    const { data } = await sb.from('company_people').select('work_email,is_primary_contact,is_decision_maker,people(first_name,last_name,personal_email)').eq('company_id', company.id);
    const r = (data || []).sort((a, b) => (b.is_primary_contact ? 2 : b.is_decision_maker ? 1 : 0) - (a.is_primary_contact ? 2 : a.is_decision_maker ? 1 : 0))[0];
    return r ? { ...r.people, personal_email: r.work_email || r.people?.personal_email } : {};
  };
  const makeBtn = $('#ccMake', box) || $('#ccMakeMore');
  if (makeBtn) makeBtn.onclick = async () => {
    const pp = await primary();
    planEditor({ company, create: { name: company.name, slug: company.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30),
      email: pp.personal_email || company.main_email || '', owner: [pp.first_name, pp.last_name].filter(Boolean).join(' ') }, onSaved: refresh });
  };
  if ($('#ccLink', box)) $('#ccLink', box).onclick = () => {
    const opts = accts.filter((a) => a.id !== S.acct.id && !(plans || []).some((p) => p.tenant_id === a.id && p.company_id));
    if (!opts.length) return C.toast('No unlinked client accounts');
    const d = document.createElement('dialog'); d.className = 'vdlg'; document.body.appendChild(d);
    d.innerHTML = `<div class="vhead"><h2 style="margin:0">Link an account</h2><button class="btn ghost small" data-x>Close</button></div>
      <div class="list">${opts.map((a) => `<button type="button" class="item" data-la="${a.id}"><b>${esc(a.name)}</b></button>`).join('')}</div>`;
    d.showModal(); $('[data-x]', d).onclick = () => { d.close(); d.remove(); };
    $$('[data-la]', d).forEach((b) => (b.onclick = async () => {
      d.close(); d.remove();
      const a = accts.find((x) => x.id === b.dataset.la), p = (plans || []).find((x) => x.tenant_id === a.id);
      planEditor({ tenant: a, plan: p ? { ...p, company_id: company.id } : { package_id: '', allowed: FEATS().filter((f) => FLD.feat(f.key) || f.def).map((f) => f.key), billing_mode: 'invoice', grace_days: 7, company_id: company.id }, company, onSaved: refresh });
    }));
  };
  $$('[data-ccplan]', box).forEach((b) => (b.onclick = () => {
    const p = mine.find((x) => x.tenant_id === b.dataset.ccplan);
    planEditor({ tenant: accts.find((x) => x.id === p.tenant_id) || { id: p.tenant_id, name: 'Their account' }, plan: p, company, onSaved: refresh });
  }));
}

/* ---------- Accounts list: plan and billing on every row ---------- */
export async function accountsPlans() {
  const { data, error } = await sb.rpc('account_plans_list');
  if (error) return null;
  await loadPackages();
  return data || [];
}
