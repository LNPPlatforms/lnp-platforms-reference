import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import * as FLD from './field.js?v=20261116t';
import * as GRW from './grow.js?v=20261116t';
import * as DOC from './docs.js?v=20261116t';
import * as MEA from './measure.js?v=20261116t';
import * as BID from './bids.js?v=20261116t';
import * as PRT from './portal_admin.js?v=20261116t';
import * as ESN from './esign.js?v=20261116t';
import * as CAL from './calendars.js?v=20261116t';
import * as SOC from './social.js?v=20261116t';
import * as PLN from './plans.js?v=20261116t';
import * as RTE from './routes.js?v=20261116t';
import * as PHN from './phone.js?v=20261116t';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById('app');

const S = {
  session: null,
  me: null,
  users: [],
  lookups: {},
  view: null,
  param: null,
  counts: { review: 0, escalations: 0 },
  // web address for links that leave the app (proposals, invoices, invites, embeds): the account's own white label
  // domain (GELP links say app.gelpstrategies.com even when you're working from app.lnpplatforms.com)
  pub() {
    const d = String(this.acct?.brand?.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/.]+$/, '');
    return d ? `https://${d}` : location.origin.replace(/\.$/, '');
  },
};

/* ================= helpers ================= */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const isWide = () => window.matchMedia('(min-width: 820px)').matches;
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtDate = (s) => s ? new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
const fullName = (p) => [p?.first_name, p?.last_name].filter(Boolean).join(' ');
const userName = (id) => S.users.find((u) => u.id === id)?.full_name || '';
const clean = (q) => (q || '').replace(/[,()%*\\:]/g, ' ').trim();
const digits = (s) => (s || '').replace(/\D/g, '');
const telHref = (s) => 'tel:' + digits(s);
const isAdmin = () => !!S.me?.is_admin;
const USER_COLS = 'id,full_name,role,active,email,is_admin,manager_id,is_developer,tenant_id,title,phone,birthday_month,birthday_day,timezone,about,hidden_in_team';
// people who live in another account but are members of this one: their settings here come from the member row
const MEMBER_KEYS = ['is_admin', 'role_id', 'divisions', 'customer_facing'];
const withMembers = (users, members) => {
  const out = (users || []).map((u) => ({ ...u }));
  (members || []).forEach((m) => {
    let u = out.find((x) => x.id === m.user_id);
    if (!u) out.push((u = { id: m.user_id, full_name: m.full_name, email: m.email, role: 'staff', active: true }));
    MEMBER_KEYS.forEach((k) => (u[k] = m[k])); u.member = true; u.from_account = m.from;
  });
  return out;
};
async function loadUsers() {
  const [us, mem] = await Promise.all([sb.from('app_users').select(USER_COLS), sb.rpc('account_members_list')]);
  if (us.data) S.users = withMembers(us.data, mem.data || []);
  return S.users;
}
async function loadAccounts() { S.accounts = (await sb.rpc('my_accounts')).data || S.accounts || []; }
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
// follow-up date buttons: each account picks its own day counts in Admin > Settings (default Tomorrow, 1 week, 15 days, 30 days)
const FOLLOWUP_DEFAULT = [1, 7, 15, 30];
const followupDays = () => (Array.isArray(S.acctSettings?.followup_days) && S.acctSettings.followup_days.length ? S.acctSettings.followup_days : FOLLOWUP_DEFAULT);
const dayLabel = (d) => d === 1 ? 'Tomorrow' : d % 7 === 0 && d <= 56 ? plural(d / 7, 'week') : plural(d, 'day');
const staff = () => S.users.filter((u) => u.active && u.role !== 'vendor' && u.role !== 'member');
const lk = (list) => S.lookups[list] || [];
// the account's own type names: the first organization type is the default; the partner type is the one with "partner" in it
const defaultOrgType = () => lk('org_type')[0] || 'Client';
const partnerType = () => lk('org_type').find((t) => t === 'Referral Partner') || lk('org_type').find((t) => /partner/i.test(t)) || 'Partner';
// Android: geo: link opens the phone's default maps app (Google Maps, Waze, etc.).
// Apple: no web hook for the default app, so Apple Maps. Computers: Google Maps in the browser.
const appleDevice = () => /iphone|ipad|ipod|macintosh/i.test(navigator.userAgent);
const androidDevice = () => /android/i.test(navigator.userAgent);
const mapHref = (q) => androidDevice() ? 'geo:0,0?q=' + encodeURIComponent(q)
  : appleDevice() ? 'https://maps.apple.com/?q=' + encodeURIComponent(q)
  : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
const options = (list, selected, blank = '') =>
  (blank !== null ? `<option value="">${esc(blank)}</option>` : '') +
  (selected && !lk(list).includes(selected) ? `<option selected>${esc(selected)}</option>` : '') +
  lk(list).map((l) => `<option ${l === selected ? 'selected' : ''}>${esc(l)}</option>`).join('');
const userOptions = (selected, blank = 'Unassigned', exclude = null) => (blank !== null ? `<option value="">${esc(blank)}</option>` : '') +
  staff().filter((u) => u.id !== exclude).map((u) => `<option value="${u.id}" ${u.id === selected ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('');
const typeBadges = (types) => (types || []).map((t) => `<span class="badge type">${esc(t)}</span>`).join('');
// people types (Contact, Client, Vendor by default; each account edits the list in Admin › Company setup › Lists)
const personTypes = () => (lk('person_type').length ? lk('person_type') : ['Contact', 'Client', 'Vendor']);
// types on a record: shows the badges, "Change" opens chips to tap on and off. A record always keeps at least one type.
function typePicker(box, cur, all, editable, save) {
  if (!box) return;
  let have = [...cur], open = false;
  const draw = () => {
    const list = [...new Set([...all, ...have])];
    box.innerHTML = open
      ? list.map((t) => `<button type="button" class="chip ${have.includes(t) ? 'on' : ''}" data-tp="${esc(t)}" aria-pressed="${have.includes(t)}">${esc(t)}</button>`).join('') + '<button type="button" class="linkish small" id="tpDone">Done</button>'
      : typeBadges(have) + (editable ? '<button type="button" class="linkish small" id="tpOpen">Change type</button>' : '');
    const o = $('#tpOpen', box); if (o) o.onclick = () => { open = true; draw(); };
    const d = $('#tpDone', box); if (d) d.onclick = () => { open = false; draw(); };
    $$('[data-tp]', box).forEach((b) => (b.onclick = async () => {
      const t = b.dataset.tp, next = have.includes(t) ? have.filter((x) => x !== t) : [...have, t];
      if (!next.length) return toast('Keep at least one type');
      const prev = have; have = next; draw();
      if ((await save(next)) === false) { have = prev; draw(); }
    }));
  };
  draw();
}
const orgAddr = (c) => [c.address, [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ');

let toastTimer;
// messages at the bottom of the screen. Problems stay up until closed (and file themselves in Review); the rest fade after 5 seconds.
const looksLikeProblem = (m) => !/notification|sound/i.test(m) && /^(couldn.t|could not|something went wrong|edge function|failed)|didn.t (send|upload|work|start|save)|blocked|not found|error/i.test(m);
function toast(msg, opts = {}) {
  const t = $('#toast'); if (!t) return;
  const bad = opts.error ?? looksLikeProblem(String(msg));
  clearTimeout(toastTimer);
  t.classList.toggle('bad', bad);
  t.innerHTML = `<span>${esc(msg)}</span>${opts.action ? `<button type="button" class="toastact">${esc(opts.action.label)}</button>` : ''}${bad ? '<button type="button" class="toastx" aria-label="Close message">✕</button>' : ''}`;
  t.hidden = false;
  if (opts.action) t.querySelector('.toastact').onclick = () => { t.hidden = true; clearTimeout(toastTimer); opts.action.fn(); };
  if (bad) { t.querySelector('.toastx').onclick = () => (t.hidden = true); reportProblem(String(msg), opts.err); }
  else toastTimer = setTimeout(() => (t.hidden = true), opts.action ? 8000 : 5000);
}
function fail(e) {
  console.error(e);
  // server functions: show the reason they sent back instead of "Edge Function returned a non-2xx status code"
  if (e?.context && typeof e.context.json === 'function' && /non-2xx|edge function/i.test(e.message || '')) {
    e.context.clone().json().then((j) => toast(j?.error || e.message, { error: true, err: e })).catch(() => toast(e.message, { error: true, err: e }));
    return;
  }
  toast(e?.message || 'Something went wrong', { error: true, err: e });
}
window.__crm = { toast, fail };   // handy for support and tests

// automatic problem reports: when someone hits an error, it lands in Review (Suggestions) with the screen, device,
// what they were doing and a screenshot, so nobody has to report it. Same problem is sent once per 10 minutes, 6 per session at most.
const sentProblems = new Map(); let problemCount = 0;
async function reportProblem(msg, err) {
  try {
    if (!S.me?.id || S.me.role === 'vendor') return;
    const key = msg.slice(0, 160);
    if (Date.now() - (sentProblems.get(key) || 0) < 10 * 60_000 || problemCount >= 6) return;
    sentProblems.set(key, Date.now()); problemCount++;
    let path = null;
    try {
      if (!window.html2canvas) await new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js'; sc.onload = ok; sc.onerror = no; document.head.appendChild(sc); });
      const canvas = await window.html2canvas(document.body, { useCORS: true, logging: false, scale: 1, x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight });
      const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.75));
      if (blob?.size) { path = `${S.me.id}/auto-${Date.now()}.jpg`; const up = await sb.storage.from('feedback').upload(path, blob, { contentType: 'image/jpeg' }); if (up.error) path = null; }
    } catch { path = null; }
    const detail = [err?.code && `Code: ${err.code}`, err?.details && `Details: ${err.details}`, err?.hint && `Hint: ${err.hint}`, err?.stack && `Where: ${String(err.stack).split('\n').slice(0, 3).join(' | ')}`].filter(Boolean).join('\n');
    await sb.from('suggestions').insert({ body: `⚠ Automatic problem report\nThey saw: "${msg}"${detail ? '\n' + detail : ''}`.slice(0, 4900), view: S.view, record_id: S.param || null,
      page_title: ($('#view h1')?.textContent || '').trim().slice(0, 200) || null, url: location.href.slice(0, 500),
      device: deviceLabel(), screen: `${window.innerWidth}x${window.innerHeight}`, app_version: APP_VERSION, screenshot_path: path });
    if (isSugOwner?.()) refreshCounts();
  } catch (e) { console.error('problem report failed', e); }
}
window.addEventListener('error', (e) => { if (S?.me && e.message && !/ResizeObserver|Script error/i.test(e.message)) reportProblem(`Page error: ${e.message}`, e.error); });
window.addEventListener('unhandledrejection', (e) => { const r = e.reason; if (S?.me && r) reportProblem(`Unexpected problem: ${r.message || String(r)}`.slice(0, 300), r); });
function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function recall(key, fallback) { try { const v = localStorage.getItem(key); return v ? { ...fallback, ...JSON.parse(v) } : fallback; } catch { return fallback; } }

/* ================= divisions: more than one company inside one account (Oct 26) =================
   Records are tagged A, B or both; untagged means shared. Staff limited to divisions only ever get their own plus shared
   (the database enforces it). The switcher at the top narrows what you're looking at; it never hides anything for good. */
const myDivs = () => (S.divisions || []).filter((d) => isAdmin() || !(S.me?.divisions || []).length || S.me.divisions.includes(d.id));
const divName = (id) => (S.divisions || []).find((d) => d.id === id)?.name || '';
const divOn = () => (S.divFilter && myDivs().some((d) => d.id === S.divFilter) ? S.divFilter : '');
// narrow a query on a table with a divisions column to the picked division (shared records always show)
const divQ = (q, col = 'divisions') => (divOn() ? q.or(`${col}.cs.{${divOn()}},${col}.eq.{}`) : q);
const divChips = (ids) => (S.divisions || []).length > 1 ? (ids?.length ? ids : []).map((id) => { const d = S.divisions.find((x) => x.id === id); return d ? `<span class="badge divbadge" style="--dc:${esc(d.color)}">${esc(d.name)}</span>` : ''; }).join('') || '<span class="badge divbadge shared">Shared</span>' : '';
// tag a record: chips you can toggle for the divisions you're allowed to use
function divPicker(box, current, save) {
  const opts = myDivs(); if ((S.divisions || []).length < 2 || !opts.length) { box.innerHTML = ''; return; }
  let cur = [...(current || [])];
  const paint = () => {
    box.innerHTML = `<label class="label">Belongs to</label><div class="chips">${opts.map((d) => `<button type="button" class="chip ${cur.includes(d.id) ? 'on' : ''}" data-dv="${d.id}">${esc(d.name)}</button>`).join('')}</div>
      <small class="hint">${cur.length === 0 || cur.length === S.divisions.length ? 'Shared: everyone in every company sees this.' : `Only people in ${esc(cur.map(divName).join(' and '))} (and admins) see this.`}</small>`;
    $$('[data-dv]', box).forEach((b) => (b.onclick = async () => {
      const id = b.dataset.dv, next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      // someone limited to divisions can't untag a record out of their own reach
      if (!isAdmin() && (S.me.divisions || []).length && next.length && !next.some((x) => S.me.divisions.includes(x))) return toast('Keep at least one of your companies on it, or you would lose access to it', { error: true });
      if (await save(next) !== false) { cur = next; paint(); }
    }));
  };
  paint();
}

/* ================= navigation (folders and dividers) ================= */
// Top row: My Day sits dead center. Left of it Contacts and Quick Add, right of it Inbox and Sales. Dashboard and
// Get started push to the far left, Tools and Review to the far right. Nine tabs at most; new features go inside
// Tools (in a drawer), never as a new tab.
const FOLDERS = [
  { id: 'dashboard', side: 'L', label: 'Dashboard', icon: '◫', views: ['dashboard'] },
  { id: 'start', side: 'L', label: 'Get started', icon: '➜', views: ['start'], when: () => showStart() },
  { id: 'orgs', side: 'CL', label: 'Contacts', icon: '▦', views: ['orgs', 'org', 'people', 'import'],
    dividers: [{ id: 'orgs', label: 'Organizations', match: ['orgs', 'org'] }, { id: 'people', label: 'People', match: ['people'] }, { id: 'import', label: 'Import', match: ['import'] }] },
  { id: 'add', side: 'CL', label: 'Quick Add', icon: '+', views: ['add'] },
  { id: 'myday', side: 'C', label: 'My Day', icon: '✓', views: ['myday'], badge: 'escalations' },
  { id: 'inbox', side: 'CR', label: 'Inbox', icon: '✉', views: ['inbox', 'chat', 'teamdir'], badge: 'inboxAll',
    dividers: [{ id: 'inbox', label: 'Customers', match: ['inbox'], badge: 'chats' }, { id: 'chat', label: 'Internal chat', match: ['chat'], badge: 'teamchat' }, { id: 'teamdir', label: 'Team', match: ['teamdir'] }] },
  { id: 'sales', side: 'CR', label: 'Sales', icon: '$', views: ['sales', 'pipeline', 'proposals', 'proposal', 'bids', 'bid', 'invoices', 'invoice'],
    dividers: [{ id: 'sales', label: 'Overview', match: ['sales'] }, { id: 'pipeline', label: 'Pipeline', match: ['pipeline'] }, { id: 'proposals', label: 'Proposals', match: ['proposals', 'proposal'], gelpOnly: true }, BID.divider, DOC.divider] },
  { id: 'tools', side: 'R', label: 'Tools', icon: '▤', views: ['tools', 'sites', 'directories', 'directory', 'mylisting', 'team', 'settings', 'pricing', 'accounts', 'platform', 'lists', 'archive', 'history', 'roles', 'accounting', 'docsetup', 'measuresetup', 'bidsetup', 'portalsetup', 'whatsnew', 'calendar', 'calsetup', 'calset', 'calhours', ...Object.keys(ESN.parents), ...Object.keys(PHN.parents), ...Object.keys(GRW.parents).filter((v) => v !== 'contactlist')] },
  { id: 'review', side: 'R', label: 'Review', icon: '!', views: ['review'], badge: 'review', alert: true, when: () => isAdmin() || (FLD.fieldReviewOn() && FLD.can('review', 3)) || DOC.reviewOn() || BID.reviewOn() },
];
// Tools: drawers of things you need but not every day. A drawer with nothing in it stays hidden.
const DRAWERS = [
  { id: 'web', label: 'Web', items: [
    { id: 'sites', label: 'Sites', match: ['sites'], what: 'Websites, forms and the live chat for your site', when: () => FLD.feat('sites') && FLD.can('sites', 1) },
    { id: 'directories', label: 'Directories', match: ['directories', 'directory'], what: 'Directories you run and their listings', when: () => S.dirOn },
    { id: 'mylisting', label: 'My listing', match: ['mylisting'], what: 'Your business listing, its views and its chats', when: () => S.hasListings } ] },
  { id: 'calendars', label: 'Calendars', items: [] },
  { id: 'phone', label: 'Phone', items: [] },
  { id: 'marketing', label: 'Marketing', items: [] },
  { id: 'automation', label: 'Automation', items: [] },
  { id: 'documents', label: 'Documents', items: [] },
  { id: 'reports', label: 'Reports', items: [] },
  { id: 'admin', label: 'Admin', when: () => isAdmin(), items: [
    { id: 'team', label: 'Team', match: ['team'], what: 'Logins, roles and invites' },
    { id: 'settings', label: 'Settings', match: ['settings'], what: 'Pipelines, stages and account defaults' },
    { id: 'pricing', label: 'Pricing', match: ['pricing'], what: 'Pricing rules and online payment', gelpOnly: true },
    { id: 'accounts', label: 'Accounts', match: ['accounts'], what: 'The customer accounts under your agency', gelp: true },
    { id: 'packages', label: 'Packages', match: ['packages'], what: 'Bundles of features you sell to client accounts', gelp: true },
    { id: 'platform', label: 'Platform', match: ['platform'], what: 'White labels and every account on the CRM (platform admin only)', when: () => !!S.acct?.platform_owner },
    { id: 'lists', label: 'Lists', match: ['lists'], what: 'Dropdown choices like specialties and lead sources' },
    { id: 'archive', label: 'Archive', match: ['archive'], what: 'Archived organizations and people, ready to restore' },
    { id: 'history', label: 'History', match: ['history'], what: 'Every change, who made it and when' } ] },
];
// an agency admin in their own agency account (GELP's admins in GELP, the platform owner at home)
const atAgencyHome = () => !!(S.acct?.platform_admin && S.acct?.is_agency && (S.acct?.id === S.acct?.home || S.acct?.platform_owner));
const itemOn = (d) => (!d.when || d.when()) && (!d.gelp || atAgencyHome()) && (!d.gelpOnly || S.acct?.is_gelp !== false);
const drawers = () => DRAWERS.map((d) => d.id === 'admin' ? { ...d, when: () => isAdmin() || FLD.can('team', 1) || FLD.can('pay', 1) || FLD.can('inbox', 4) || DOC.canSetup() || MEA.canSetup() || BID.canSetup() || PRT.canSetup() || ESN.canSetup(), items: [...d.items.map((i) => isAdmin() ? i : { ...i, when: () => false }), ...FLD.adminItems().map((i) => ({ ...i, when: () => i.id !== 'roles' || FLD.can('team', 1) })), ...GRW.drawerItems().admin, ...DOC.drawerItems().admin, ...MEA.drawerItems().admin, ...BID.drawerItems().admin, ...PRT.drawerItems().admin, ...ESN.drawerItems().admin, ...PHN.drawerItems().admin] }
  : GRW.drawerItems()[d.id] || ESN.drawerItems()[d.id] || CAL.drawerItems()[d.id] || SOC.drawerItems()[d.id] || PHN.drawerItems()[d.id] ? { ...d, items: [...d.items, ...(GRW.drawerItems()[d.id] || []), ...(SOC.drawerItems()[d.id] || []), ...(ESN.drawerItems()[d.id] || []), ...(CAL.drawerItems()[d.id] || []), ...(PHN.drawerItems()[d.id] || [])] } : d)
  .filter((d) => !d.when || d.when()).map((d) => ({ ...d, items: d.items.filter(itemOn) })).filter((d) => d.items.length);
const drawerFor = (view) => drawers().find((d) => d.items.some((i) => i.match.includes(view)));
// Admin is split into folders (Nov 16, 2026): Admin › Team › Team, Company setup, Sales, Service, Clients, Audit, Agency.
// Each item's folder; anything new without one lands in Company setup.
const ADMIN_GROUPS = ['Team', 'Company setup', 'Sales', 'Service', 'Clients', 'Audit', 'Agency'];
const ADMIN_GROUP = { team: 'Team', roles: 'Team', departments: 'Team', chatsetup: 'Team',
  settings: 'Company setup', lists: 'Company setup', accounting: 'Company setup',
  docsetup: 'Sales', products: 'Sales', measuresetup: 'Service', bidsetup: 'Service', portalsetup: 'Clients', esignsetup: 'Clients',
  archive: 'Audit', history: 'Audit', accounts: 'Agency', packages: 'Agency', pricing: 'Agency', platform: 'Agency' };
const adminGroup = (i) => ADMIN_GROUP[i.id] || 'Company setup';
// a drawer's items in folders (only Admin has them), empty folders left out
const groupsOf = (d) => d.id !== 'admin' ? null : ADMIN_GROUPS.map((g) => ({ label: g, items: d.items.filter((i) => adminGroup(i) === g) })).filter((g) => g.items.length);
// Get started shows for admins until every step is done (or they hide it)
const showStart = () => isAdmin() && !S.startDone && !recall('startHidden', { v: false }).v;
// field-service folders come from field.js when their features are on; Sales, Inbox and Sites follow the account's switches
// and the person's role. Nine tabs at most: Get started gives way first.
const allFolders = () => {
  const salesOk = FLD.feat('sales') && FLD.can('sales', 1);
  const base = FOLDERS.filter((f) => !(f.id === 'sales' && !salesOk && !FLD.can('invoices', 1) && !BID.canSee()) && !(f.id === 'inbox' && (!FLD.feat('inbox') || !FLD.can('inbox', 1)))
    && !(f.id === 'orgs' && !FLD.can('contacts', 1)))
    // no sales: the Sales tab shows only Bids and Invoices (called Invoices when that's all there is)
    .map((f) => f.id === 'sales' && !salesOk ? { ...f, label: BID.canSee() ? 'Sales' : 'Invoices', views: ['bids', 'bid', 'invoices', 'invoice'], dividers: [BID.divider, DOC.divider] } : f);
  const at = base.findIndex((f) => f.id === 'inbox') + 1 || base.findIndex((f) => f.id === 'tools');
  return [...base.slice(0, at), ...FLD.folders(), ...base.slice(at)].map((f) => f.id === 'orgs' ? { ...f, label: FLD.L('contact', true),
    dividers: f.dividers.map((d) => d.id === 'orgs' ? { ...d, label: FLD.L('organization', true) } : d.id === 'people' ? { ...d, label: FLD.L('person', true) } : d) } : f);
};
const navFolders = () => { const f = allFolders().filter((x) => !x.when || x.when()); return f.length > 9 ? f.filter((x) => x.id !== 'start') : f; };
// free accounts (directory businesses): My listing, Organizations and People, Inbox. The rest shows locked.
const isFree = () => S.acct?.plan === 'starter';
const LOCKED_VIEWS = ['sales', 'pipeline', 'proposals', 'proposal', 'myday', 'sites', 'import'];
const lockedFolder = (f) => isFree() && f.views.every((v) => LOCKED_VIEWS.includes(v));
const lockedDivider = (d) => isFree() && d.match.every((v) => LOCKED_VIEWS.includes(v));
const UPGRADE_URL = 'https://gelpstrategies.com';
const LOCKED_INFO = {
  sales: ['Sales', 'Track every deal from first call to closed, with pipelines you set up your way.'],
  pipeline: ['Pipeline', 'See every deal by stage and drag it along as it moves.'],
  proposals: ['Proposals', 'Send clean proposals your customers can accept and pay online.'],
  myday: ['My Day', 'Follow ups, tasks and reminders for today, all in one list.'],
  sites: ['Sites', 'Your website, forms and this same live chat on your own site.'],
  import: ['Import', 'Bring in your customer list from a spreadsheet in a couple of clicks.'],
};
function lockedView(view) {
  const [name, what] = LOCKED_INFO[view === 'proposal' ? 'proposals' : view] || ['This', ''];
  return `<div class="card lockcard"><div class="lockbig" aria-hidden="true">🔒</div><h1>${esc(name)}</h1><p>${esc(what)}</p>
    <p class="hint">Your free account comes with your listing, your organizations and people, and live chat in your Inbox. ${esc(name)} comes with an upgrade.</p>
    <div class="actions" style="justify-content:center"><a class="btn" href="${UPGRADE_URL}" target="_blank" rel="noopener">See what's included</a><button type="button" class="btn ghost" data-nav="inbox">Back to my Inbox</button></div></div>`;
}
const LEGACY = { clinics: 'orgs', clinic: 'org', followups: 'myday' };

/* ================= back: every back goes exactly one screen =================
   history.state = { d: screens deep this visit, sub: a thread opened inside a screen, layer: an open window like a dialog, search or preview }.
   The phone's back gesture, the browser's back and the app's Back button all walk the same list. */
const depth = () => history.state?.d || 0;
const BACK = { layers: [], skip: 0, queued: null };
// open a window that back should close first; returns the function to call when the window closes itself
function pushLayer(close) {
  const entry = { close, done: false };
  BACK.layers.push(entry);
  // a window opened while an earlier one is still closing waits for that back to land first
  const push = () => { if (!entry.done) { entry.pushed = true; history.pushState({ d: depth() + 1, layer: true }, '', location.href); } };
  if (BACK.skip) (BACK.later ||= []).push(push); else push();
  return () => { if (entry.done) return; entry.done = true; BACK.layers = BACK.layers.filter((x) => x !== entry); if (entry.pushed) { BACK.skip++; history.back(); } };
}
// a thread or record opened inside a screen (Inbox, Internal chat): back returns to the list
function pushSub(hash) { if (location.hash === hash) return; history.pushState({ d: depth() + 1, sub: true }, '', hash); }
function leaveSub(hash) { if (history.state?.sub) { BACK.skip++; history.back(); } else history.replaceState({ d: depth() }, '', hash); }
const PARENT = { org: 'orgs', proposal: 'proposals', directory: 'directories', teamdir: 'inbox', chat: 'inbox', pipeline: 'sales', proposals: 'sales', import: 'orgs', people: 'orgs',
  whatsnew: 'tools', sites: 'tools', directories: 'tools', mylisting: 'tools', team: 'tools', settings: 'tools', pricing: 'tools', accounts: 'tools', platform: 'tools', lists: 'tools', archive: 'tools', history: 'tools', ...FLD.parents, ...GRW.parents, ...DOC.parents, ...MEA.parents, ...BID.parents, ...PRT.parents, ...ESN.parents, ...CAL.parents, ...SOC.parents, ...PLN.parents, ...RTE.parents, ...PHN.parents };
function goBack() {
  if (depth() > 0) return history.back();
  if (S.param) return go(S.view);
  go(PARENT[S.view] || (isWide() ? 'dashboard' : 'add'));
}
const canGoBack = () => depth() > 0 || !!S.param || !!PARENT[S.view];

function go(view, param = null) {
  if (BACK.skip) { BACK.queued = [view, param]; return; }
  if (BACK.layers.length) {
    const open = BACK.layers.splice(0), n = open.filter((e) => e.pushed).length;
    open.forEach((e) => { e.done = true; e.close(); });
    if (n) { BACK.skip++; BACK.queued = [view, param]; history.go(-n); return; }
  }
  S.view = view; S.param = param;
  const hash = '#' + view + (param ? '/' + param : '');
  if (location.hash !== hash) history.pushState({ d: depth() + 1 }, '', hash);
  renderShell();
}
window.addEventListener('popstate', () => {
  if (BACK.skip) {
    BACK.skip--;
    if (!BACK.skip) { (BACK.later || []).splice(0).forEach((f) => f()); if (BACK.queued) { const q = BACK.queued; BACK.queued = null; go(...q); } }
    return;
  }
  while (BACK.layers.length) { const e = BACK.layers.pop(); e.done = true; if (e.close() !== false) return; }
  readHash(); if (S.me?.active && S.me.role !== 'vendor' && S.me.role !== 'member') renderShell();
});
// every dialog joins the back list, so back closes it instead of leaving the screen
{
  const show = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () {
    show.call(this);
    const d = this, off = pushLayer(() => { if (!d.isConnected || !d.open) return false; d.close(); });
    d.addEventListener('close', off, { once: true });
  };
}
// previews of our own pages (proposals, site previews, directory pages, forms) open inside the app with a Back bar,
// so an installed app on a phone or computer never strands you on a page with no way out
function openViewer(url, title = '') {
  const ov = document.createElement('div'); ov.className = 'viewer'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', title || 'Preview');
  ov.innerHTML = `<div class="viewbar"><button type="button" class="btn ghost small" data-vback>‹ Back</button><b>${esc(title || 'Preview')}</b>
    <a class="btn ghost small" href="${esc(url)}" target="_blank" rel="noopener" data-vnew>Open in new tab ↗</a></div>
    <iframe src="${esc(url)}" title="${esc(title || 'Preview')}"></iframe>
    <small class="viewnote" hidden>If the page stays blank, that site doesn't allow being shown inside other pages. Use Open in new tab.</small>`;
  document.body.appendChild(ov); document.body.classList.add('noscroll');
  const shut = () => { ov.remove(); if (!$('.viewer')) document.body.classList.remove('noscroll'); };
  const off = pushLayer(shut);
  $('[data-vback]', ov).onclick = () => { shut(); off(); };
  $('[data-vnew]', ov).onclick = () => { shut(); off(); };
  if (!url.startsWith(location.origin) && !url.startsWith(S.pub()) && !url.startsWith('/')) setTimeout(() => { const n = $('.viewnote', ov); if (n) n.hidden = false; }, 2500);
}
const OWN_PAGES = /^\/(proposal|preview|directory|forms|portal|book)\//;
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[target="_blank"]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || a.hasAttribute('data-vnew') || a.closest('.viewer')) return;
  let u; try { u = new URL(a.href, location.href); } catch { return; }
  if ((u.origin !== location.origin && u.origin !== S.pub()) || !OWN_PAGES.test(u.pathname)) return;
  // the brand's web address is this same app, so preview it here (same origin keeps the preview working)
  e.preventDefault(); openViewer(u.pathname + u.search + u.hash, a.dataset.title || a.textContent.replace(/[↗›]/g, '').trim());
});
function readHash() {
  let [v, p] = location.hash.replace('#', '').split('/');
  v = LEGACY[v] || v;
  S.view = v || (isWide() ? 'dashboard' : 'add');
  S.param = p || null;
}
// the tab a screen lights up: its own folder, else its parent's (social planner → Tools), never Dashboard by accident
const folderFor = (view) => {
  for (let v = view, n = 0; v && n < 6; v = PARENT[v], n++) { const f = allFolders().find((x) => x.views.includes(v)); if (f) return f; }
  return FOLDERS[0];
};

/* ================= boot ================= */
async function boot() {
  FLD.init({ sb, S, esc, $, $$, go, goBack, toast, fail, renderShell, refreshCounts, isAdmin, staff, userName, fmtDate, money, plural, today, addDays, store, recall,
    debounce, clean, lk, divQ, divName, divChips, divPicker, myDivs, mapHref, escalatePanel });
  GRW.init({ sb, S, esc, $, $$, go, toast, fail, isAdmin, staff, userName, fmtDate, money, plural, today, divQ, stageLabel: (x) => stageLabel(x), lk: (x) => lk(x), personTypes: () => personTypes(), typeBadges: (x) => typeBadges(x), PHN });
  DOC.init({ sb, S, esc, $, $$, go, toast, fail, isAdmin, staff, userName, fmtDate, money, plural, today, divQ, refreshCounts, lk, resetPrices: () => { PRICES = null; } });
  MEA.init({ sb, S, esc, $, $$, go, toast, fail, isAdmin, fmtDate, money, today });
  RTE.init({ sb, S, esc, $, $$, go, toast, fail, isAdmin, staff, userName, fmtDate, today, FLD });
  BID.init({ sb, S, esc, $, $$, go, toast, fail, isAdmin, staff, userName, fmtDate, money, today, refreshCounts, proposalDraftFor });
  PRT.init({ sb, S, esc, $, $$, go, toast, fail, isAdmin });
  ESN.init({ sb, S, esc, $, $$, go, toast, fail, isAdmin, staff, userName, fmtDate });
  CAL.init({ sb, S, esc, $, $$, go, toast, fail, isAdmin, staff, userName, fmtDate, today, brandCheck: (...a) => brandCheck(...a) });
  SOC.init({ sb, S, esc, $, $$, go, toast, fail, isAdmin, staff, userName, fmtDate, plural, today });
  PHN.init({ sb, S, esc, $, $$, go, toast, fail, isAdmin, staff, userName, fmtDate, debounce, renderShell, FLD });
  PLN.init({ sb, S, esc, $, $$, go, toast, fail, fmtDate, money, sendInvite: (t, e, q) => sendInvite(t, e, q), loadAccounts: () => loadAccounts() });
  brandForHost();
  const rec = location.hash.match(/^#recover\/([^/?#]+)/);
  if (rec) {
    history.replaceState(null, '', '/');
    const { error } = await sb.auth.verifyOtp({ token_hash: decodeURIComponent(rec[1]), type: 'recovery' });
    if (error) { S.session = null; renderAuth('reset'); setTimeout(() => { const er = $('#authErr'); if (er) er.textContent = 'That reset link was already used or ran out. Send yourself a new one.'; }, 0); }
    else { const { data: d0 } = await sb.auth.getSession(); S.session = d0.session; renderReset(); }
    sb.auth.onAuthStateChange((evt, session) => { const had = !!S.session; S.session = session; if (evt === 'PASSWORD_RECOVERY') return; if (!!session !== had) start(); });
    return;
  }
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  sb.auth.onAuthStateChange((evt, session) => {
    const had = !!S.session; S.session = session;
    if (evt === 'PASSWORD_RECOVERY') return renderReset();
    if (!!session !== had) start();
  });
  start();
}

async function loadLookups() {
  const { data } = await sb.from('lookup_values').select('list_name,label').eq('active', true).order('sort_order');
  S.lookups = {};
  (data || []).forEach((r) => (S.lookups[r.list_name] ||= []).push(r.label));
}

// the sign-in frame with any card inside it (used by two-step sign in)
function renderAuthCard(inner) { app.innerHTML = `<div class="auth"><div class="logo">${brandMark()}</div><div class="card">${inner}</div></div>`; }

async function start() {
  if (!S.session) { const m = location.hash.match(/^#signup(?:\/([^/]+))?(?:\/([^/]+))?/); return m ? renderAuth('up', m[1] ? decodeURIComponent(m[1]) : '', m[2] ? decodeURIComponent(m[2]) : '') : renderAuth(); }
  if (await FLD.mfaGate(renderAuthCard)) return;
  const uid = S.session.user.id;
  const { data: me, error } = await sb.from('app_users').select('*').eq('id', uid).maybeSingle();
  if (error) return fail(error);
  S.me = me;
  // a client portal login opened the CRM: send them to their portal
  if (!me) { const { data: pm } = await sb.rpc('portal_me'); if (pm?.portals?.length) { location.replace('/portal/'); return; } }
  if (!me || !me.active) return renderPending();
  if (me.role === 'member') return renderMemberHome();
  if (me.role === 'vendor') return renderVendorHome();
  const [, , acct] = await Promise.all([loadLookups(), loadUsers(), sb.rpc('current_account'), loadAccounts()]);
  S.acct = acct.data || { id: me.tenant_id, name: 'Your account', is_gelp: me.tenant_id === GELP_TENANT };
  // in someone else's account as their team member: what you can do there comes from that account
  if (S.acct.member) { MEMBER_KEYS.forEach((k) => (S.me[k] = S.acct.member[k])); S.me.member = true; }
  S.dirOn = !!(await sb.rpc('directories_flags')).data?.[S.acct.id];
  S.divisions = (await sb.from('divisions').select('id,name,color,sort_order').order('sort_order').order('name')).data || [];
  S.divFilter = recall('divFilter', { id: '' }).id;
  S.acctSettings = (await sb.from('account_settings').select('settings').eq('tenant_id', S.acct.id).maybeSingle()).data?.settings || {};
  S.plan = (await sb.rpc('my_plan')).data || null;  // what the agency's plan allows, and where billing stands (091)
  if (['setup', 'locked'].includes(S.plan?.billing?.state)) return renderBillingGate();
  await FLD.loadPerms();
  if (isAdmin() || FLD.can('team', 1)) await FLD.loadRolesList();
  S.hasListings = !!(await sb.rpc('member_home')).data?.listings?.length;
  if (isAdmin() && !recall('startHidden', { v: false }).v) S.startDone = await startSteps().then((x) => x.every((y) => y.done)).catch(() => true);
  readHash();
  practiceRecover();
  if (!location.hash.replace('#', '') && S.hasListings && isFree()) S.view = 'mylisting';
  renderShell();
  whatsNew().catch(() => {});
  RTE.gpsStart();
  PHN.start().catch(() => {});
}

/* ================= auth screens ================= */
function renderAuth(mode = 'in', email = '', token = '') {
  closeDock(); $('#tcDock')?.remove();
  $('#sugTab')?.remove(); $('#sugPanel')?.remove();
  app.innerHTML = `
  <div class="auth">
    <div class="logo">${brandMark()}</div>
    <div class="card">
      <h2>${mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create your login' : 'Reset password'}</h2>
      <form id="authForm">
        ${mode === 'up' ? `<p class="empty">Use the email address your invite was sent to.</p><label class="label">Full name</label><input type="text" name="name" required autocomplete="name">` : ''}
        <label class="label">Email</label><input type="email" name="email" required autocomplete="email" value="${esc(email)}">
        ${mode !== 'reset' ? `<label class="label">Password</label><input type="password" name="password" required minlength="8" autocomplete="${mode === 'in' ? 'current-password' : 'new-password'}">` : ''}
        <div class="err" id="authErr"></div>
        <div class="actions"><button class="btn block" type="submit">${mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create login' : 'Send reset link'}</button></div>
      </form>
      <div class="actions">
        ${mode !== 'in' ? `<button class="btn ghost small" data-m="in">Back to sign in</button>` : `<button class="btn ghost small" data-m="up">Invited? Create your login</button><button class="btn ghost small" data-m="reset">Forgot password</button>`}
      </div>
    </div>
  </div>`;
  $$('[data-m]').forEach((b) => (b.onclick = () => { if (location.hash.startsWith('#signup')) history.replaceState(null, '', '/'); renderAuth(b.dataset.m); }));
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target); const err = $('#authErr'); err.textContent = '';
    const email = f.get('email').trim().toLowerCase();
    let res;
    if (mode === 'in') res = await sb.auth.signInWithPassword({ email, password: f.get('password') });
    else if (mode === 'up' && token) {
      // invite link with its token: the login is made already confirmed (no Supabase email), then we sign them in
      const r = await sb.functions.invoke('invite-accept', { body: { email, token, password: f.get('password'), full_name: f.get('name').trim() } });
      const msg = r.data?.error || (r.error ? await r.error.context?.json?.().then((j) => j.error).catch(() => '') || r.error.message : '');
      if (msg) return (err.textContent = msg);
      history.replaceState(null, '', '/');
      res = await sb.auth.signInWithPassword({ email, password: f.get('password') });
    }
    else if (mode === 'up') res = await sb.auth.signUp({ email, password: f.get('password'), options: { data: { full_name: f.get('name').trim() }, emailRedirectTo: location.origin } });
    else {
      // branded reset email from the agency, linking to the agency's own address (password-reset function)
      const r = await sb.functions.invoke('password-reset', { body: { email } });
      const msg = r.data?.error || (r.error ? await r.error.context?.json?.().then((j) => j.error).catch(() => '') || r.error.message : '');
      res = { error: msg ? { message: msg } : null };
    }
    if (res.error) return (err.textContent = /database error saving new user|not_invited/i.test(res.error.message)
      ? "That email hasn't been invited yet. Ask your admin to invite you, then sign up with the same email."
      : res.error.message);
    if (mode === 'up' && !res.data.session) { err.style.color = 'var(--ok)'; err.textContent = 'Check your email to confirm, then sign in.'; }
    if (mode === 'reset') { err.style.color = 'var(--ok)'; err.textContent = 'Reset link sent. Check your email.'; }
  };
}

function renderReset() {
  app.innerHTML = `<div class="auth"><div class="logo">${brandMark()}</div><div class="card"><h2>Set a new password</h2>
    <form id="rf"><label class="label">New password</label><input type="password" name="p" minlength="8" required autocomplete="new-password">
    <div class="actions"><button class="btn block">Save password</button></div></form></div></div>`;
  $('#rf').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: new FormData(e.target).get('p') });
    if (error) return fail(error);
    toast('Password updated'); history.replaceState(null, '', '/'); start();
  };
}

/* ================= billing gate (091) =================
   A client account billed by its agency: never paid (setup) or past the grace days (locked) stops here.
   Billing people (the billing contact, or every admin when none is set) get Pay now and, when locked, Export data.
   Everyone else gets a short note. Only a payment that goes through opens it again. */
const payLink = (token) => `${S.pub()}/doc/?t=${encodeURIComponent(token)}`;
async function exportAccount(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Gathering your data…'; }
  const { data, error } = await sb.rpc('account_export');
  if (btn) { btn.disabled = false; btn.textContent = 'Export data'; }
  if (error) return fail(error);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `${(S.acct?.slug || 'account')}-export-${today()}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Downloaded. It has every record in the account.');
}
function renderBillingGate() {
  closeDock(); $('#tcDock')?.remove(); $('#sugTab')?.remove(); $('#sugPanel')?.remove();
  applyBrand(S.acct?.brand);
  const b = S.plan.billing || {}, mine = !!S.plan.billing_person, ag = b.agency || 'your provider';
  const open = b.open || [], first = open[0];
  const total = open.reduce((n, i) => n + Number(i.balance || 0), 0);
  let body;
  if (!mine) {
    body = `<h2>This account is paused for billing</h2><p>Contact ${esc(S.plan.billing_contact || 'your account admin')} to get it going again.</p>`;
  } else if (b.state === 'setup') {
    body = `<h2>One step before you start</h2><p>Your account with ${esc(ag)} is ready. Pay your first invoice${total ? ` of <b>${esc(money(total))}</b>` : ''} to open it.</p>
      ${first ? `<div class="actions"><a class="btn" href="${esc(payLink(first.token))}" target="_blank" rel="noopener">Pay now</a></div>` : `<p class="hint">Your invoice is on its way from ${esc(ag)}.</p>`}`;
  } else {
    body = `<h2>Your account is paused</h2><p>The payment to ${esc(ag)} is ${esc(String(b.days_late || 0))} days late${total ? ` (<b>${esc(money(total))}</b> due)` : ''}. Update your card and pay to open it again right away.</p>
      <div class="actions" style="flex-direction:column;align-items:stretch;max-width:320px">
        ${first ? `<a class="btn" href="${esc(payLink(first.token))}" target="_blank" rel="noopener">Update billing</a>` : ''}
        <button class="btn secondary" id="bgExport">Export data</button></div>`;
  }
  app.innerHTML = `<div class="auth"><div class="logo">${brandMark()}</div><div class="card">${body}
    <p class="empty" style="margin-top:14px">Signed in as ${esc(S.session.user.email)}</p>
    <div class="actions">${mine ? '<button class="btn ghost" id="bgCheck">I paid, check again</button>' : ''}<button class="btn ghost" id="bgOut">Sign out</button></div></div></div>`;
  if ($('#bgExport')) $('#bgExport').onclick = (e) => exportAccount(e.target);
  if ($('#bgCheck')) $('#bgCheck').onclick = start;
  $('#bgOut').onclick = () => sb.auth.signOut();
}

function renderPending() {
  closeDock(); $('#tcDock')?.remove();
  $('#sugTab')?.remove(); $('#sugPanel')?.remove();
  app.innerHTML = `<div class="auth"><div class="logo">${brandMark()}</div><div class="card">
    <h2>Almost there</h2><p>Your login is created. An admin needs to turn on your access before you can see the CRM.</p>
    <p class="empty">Signed in as ${esc(S.session.user.email)}</p>
    <div class="actions"><button class="btn secondary" id="re">Check again</button><button class="btn ghost" id="so">Sign out</button></div></div></div>`;
  $('#re').onclick = start; $('#so').onclick = () => sb.auth.signOut();
}

async function renderVendorHome() {
  closeDock(); $('#tcDock')?.remove();
  const { data } = await sb.from('companies').select('id,name,city,state,specialty').is('archived_at', null).order('name');
  app.innerHTML = `<div class="shell"><div class="topbar"><div class="brand">${brandMark(true)}</div><div class="spacer"></div>
    <button class="linkbtn" id="so">Sign out</button></div><main><h1>Your assigned clinics</h1>
    <div class="list">${(data || []).map((c) => `<div class="item"><b>${esc(c.name)}</b><small>${esc([c.specialty, [c.city, c.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '))}</small></div>`).join('') || '<p class="empty">No clinics assigned yet.</p>'}</div></main></div>`;
  $('#so').onclick = () => sb.auth.signOut();
  mountSuggest();
}

/* ================= shell ================= */
// late or trial, only for the account's billing people; staff never see it
function billingBanner() {
  const b = S.plan?.billing; if (!b || !S.plan.billing_person || S.billingHidden) return '';
  const first = (b.open || [])[0];
  if (b.state === 'grace') return `<div class="actbanner billwarn"><span>Your payment to ${esc(b.agency || 'your provider')} is ${esc(String(b.days_late))} day${b.days_late === 1 ? '' : 's'} late. The account pauses in ${esc(String(b.grace_left))} day${b.grace_left === 1 ? '' : 's'}.</span>
    ${first ? `<a class="btn small" href="${esc(payLink(first.token))}" target="_blank" rel="noopener">Pay now</a>` : ''}<button type="button" class="linkbtn" data-billhide>Later</button></div>`;
  if (b.state === 'trial' && b.trial_ends) {
    const left = Math.max(0, Math.ceil((new Date(b.trial_ends + 'T23:59:59') - Date.now()) / 86400000));
    return `<div class="actbanner"><span>Your trial has ${left} day${left === 1 ? '' : 's'} left.</span>${first ? `<a class="btn small" href="${esc(payLink(first.token))}" target="_blank" rel="noopener">Set up billing</a>` : ''}<button type="button" class="linkbtn" data-billhide>Hide</button></div>`;
  }
  return '';
}
const badge = (key) => `<span class="count" data-count="${key}" ${S.counts[key] ? '' : 'hidden'}>${S.counts[key] || ''}</span>`;

function renderShell() {
  clearInterval(S.inboxTimer);
  startHeartbeat();
  const folder = folderFor(S.view);
  const divShown = (d) => (!d.when || d.when()) && (!d.gelp || atAgencyHome()) && (!d.gelpOnly || S.acct?.is_gelp !== false);
  applyBrand(S.acct?.brand);
  // a folder's menu: its dividers, or for Tools every drawer and what's in it
  const menuOf = (f) => f.id === 'tools'
    // Tools: just the drawer names; hover (or tab onto) one and its items fly out beside it
    ? drawers().map((d) => { const item = (i) => `<button type="button" role="menuitem" data-nav="${i.id}">${esc(i.label)}${lockedDivider(i) ? ' 🔒' : ''}</button>`;
        const sub = (label, inner) => `<div class="ddsub"><button type="button" class="ddsubhead" role="menuitem" aria-haspopup="true">${esc(label)}<span class="ddarrow" aria-hidden="true">›</span></button>
        <div class="ddsubmenu" role="menu" aria-label="${esc(label)}">${inner}</div></div>`;
        const gs = groupsOf(d);
        return sub(d.label, gs ? gs.map((g) => sub(g.label, g.items.map(item).join(''))).join('') : d.items.map(item).join('')); }).join('')
    : (f.dividers || []).filter(divShown).map((d) => `<button type="button" role="menuitem" data-nav="${d.id}">${d.label}${lockedDivider(d) ? ' 🔒' : ''}</button>`).join('');
  const tab = (f) => {
    const btn = `<button class="folder ${f.alert ? 'alert' : ''} ${folder.id === f.id ? 'on' : ''}" data-nav="${f.id}">${f.label}${lockedFolder(f) ? ' 🔒' : ''}${f.badge ? badge(f.badge) : ''}</button>`;
    const m = menuOf(f);
    return m ? `<div class="ddwrap ${f.side === 'R' ? 'ddright' : ''}">${btn}<div class="ddmenu" role="menu">${m}</div></div>` : btn;
  };
  const side = (k) => navFolders().filter((f) => f.side === k).map(tab).join('');
  const tabs = `<div class="navL"><div class="navgrp">${side('L')}</div><div class="navgrp">${side('CL')}</div></div>
    <div class="navC">${side('C')}</div>
    <div class="navR"><div class="navgrp">${side('CR')}</div><div class="navgrp">${side('R')}</div></div>`;
  // the strip under the tabs: the folder's dividers, or the drawer you're in when inside Tools
  const dw = folder.id === 'tools' ? drawerFor(S.view) : null;
  const dwItems = dw && groupsOf(dw) ? dw.items.filter((i) => adminGroup(i) === adminGroup(dw.items.find((x) => x.match.includes(S.view)) || {})) : dw?.items || [];
  const divs = folder.id === 'tools' ? (dw ? [{ id: 'tools', label: '‹ Tools', match: ['tools'] }, ...dwItems] : []) : (folder.dividers || []).filter(divShown);
  const dividers = divs.length ? `<div class="dividers">${divs.map((d) => `<button class="divider ${d.match.includes(S.view) ? 'on' : ''}" data-nav="${d.id}">${d.label}${lockedDivider(d) ? ' 🔒' : ''}${d.badge ? badge(d.badge) : ''}</button>`).join('')}</div>` : '';
  // phones: Contacts, Quick Add, My Day in the middle, Inbox, More
  const PHONE = ['orgs', 'add', 'myday', 'inbox'];
  const phoneBtn = (f) => `<button data-nav="${f.id}" class="${folder.id === f.id ? 'on' : ''}"><b>${f.icon}</b>${f.label}${f.badge ? badge(f.badge) : ''}</button>`;
  const moreList = navFolders().filter((f) => !PHONE.includes(f.id) && !lockedFolder(f));
  const moreOn = moreList.some((f) => f.id === folder.id);
  app.innerHTML = `
  <div class="shell">
    <div class="topbar">
      ${canGoBack() ? '<button type="button" class="backbtn" id="appBack" aria-label="Back" title="Back"><span aria-hidden="true">‹</span><span class="backlabel">Back</span></button>' : ''}
      <div class="brand">${brandMark(true)}${isFree() ? ` <small class="brandacct">${esc(S.acct.name)}</small>` : S.acct && !S.acct.is_agency ? ` <small class="brandacct">${esc(S.acct.name)}</small>` : ''}</div>
      <div class="spacer"></div>
      ${(S.accounts || []).length > 1 ? `<select id="acctSwitch" class="acctswitch${S.acct.id !== S.acct.home ? ' away' : ''}" aria-label="Switch account">${S.accounts.map((a) => `<option value="${a.id}" ${a.id === S.acct.id ? 'selected' : ''}>${esc(a.name)}${a.kind === 'home' && a.id !== S.acct.id ? ' (home)' : ''}</option>`).join('')}</select>` : ''}
      ${myDivs().length > 1 ? `<select id="divSwitch" class="acctswitch" aria-label="Which company"><option value="">All companies</option>${myDivs().map((d) => `<option value="${d.id}" ${d.id === divOn() ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` : ''}
      <button type="button" class="gsbtn" id="gsOpen" aria-label="Search (Ctrl+K)" title="Search everything (Ctrl+K)"><span aria-hidden="true">🔍</span><span class="gslabel">Search</span><kbd>Ctrl K</kbd></button>
      <button type="button" class="iconbtn helpbtn" id="helpBtn" aria-label="Help (F1)" title="Help and walkthroughs (F1)">?</button>
      <div class="gearwrap"><button type="button" class="iconbtn" id="gearBtn" aria-haspopup="true" aria-expanded="false" title="Your account" aria-label="Your account">⚙</button>
        <div class="gearmenu" id="gearMenu" hidden>
          <div class="gearwho"><b>${esc(S.me.full_name)}</b><small>${esc(S.session?.user?.email || '')}</small></div>
          <button type="button" data-nav-me>My profile</button>
          <button type="button" id="gearCal">My availability</button>
          <button type="button" id="gearPw">Change password</button>
          <button type="button" id="gearMfa">Two-step sign in</button>
          <div class="gearalerts" id="gearAlerts"></div>
          <button type="button" id="signout">Sign out</button>
        </div></div>
    </div>
    ${billingBanner()}
    <div class="cabinet"><div class="cabinet-inner">${tabs}</div></div>
    <main id="main">${dividers}<div id="view"></div></main>
    <nav class="bottomnav">${PHONE.map((id) => navFolders().find((f) => f.id === id)).filter((f) => f && !lockedFolder(f)).map(phoneBtn).join('')}
      <button type="button" id="moreBtn" class="${moreOn ? 'on' : ''}" aria-expanded="false"><b>⋯</b>More${S.counts.review && isAdmin() ? badge('review') : ''}</button></nav>
    <div class="moresheet" id="moreSheet" hidden>${moreList.map((f) => `<button data-nav="${f.id}" class="${folder.id === f.id ? 'on' : ''}"><b>${f.icon}</b>${f.label}${f.badge ? badge(f.badge) : ''}</button>`).join('')}</div>
  </div>`;
  $$('[data-nav]').forEach((b) => (b.onclick = () => go(b.dataset.nav)));
  $$('[data-nav-me]').forEach((b) => (b.onclick = () => go('teamdir', S.me.id)));
  if ($('#gsOpen')) $('#gsOpen').onclick = openSearch;
  $('#helpBtn').onclick = () => openHelp();
  $('#signout').onclick = () => sb.auth.signOut();
  // the gear is just you: profile, password, notifications, sign out
  const gm = $('#gearMenu'), gb = $('#gearBtn');
  const gearClose = (e) => { if (!e || !e.target.closest('.gearwrap')) { gm.hidden = true; gb.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', gearClose); } };
  gb.onclick = (e) => { e.stopPropagation(); if (!gm.hidden) return gearClose(); gm.hidden = false; gb.setAttribute('aria-expanded', 'true'); drawAlertBar($('#gearAlerts')); document.addEventListener('click', gearClose); };
  $('#gearPw').onclick = () => { gearClose(); changePassword(); };
  $('#gearCal').onclick = () => { gearClose(); go('teamdir', S.me.id); setTimeout(() => $('#myAvail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 600); };
  $('#gearMfa').onclick = () => { gearClose(); FLD.mfaSetup(); };
  if ($('#appBack')) $('#appBack').onclick = goBack;
  const mb = $('#moreBtn'), ms = $('#moreSheet');
  if (mb) {
    // the More sheet is on the back list too: the phone's back closes it
    let off = null;
    const outside = (ev) => { if (!ev.target.closest('#moreSheet')) closeMore(); };
    const closeMore = (fromBack) => { ms.hidden = true; mb.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', outside); const o = off; off = null; if (o && !fromBack) o(); };
    mb.onclick = (e) => { e.stopPropagation(); if (!ms.hidden) return closeMore(); ms.hidden = false; mb.setAttribute('aria-expanded', 'true'); off = pushLayer(() => closeMore(true)); document.addEventListener('click', outside); };
  }
  const switchTo = async (tid) => {
    const { error } = await sb.rpc('set_acting_tenant', { p_tenant: tid }); if (error) return fail(error);
    S.stagesAt = 0; location.hash = '#orgs'; location.reload();
  };
  if ($('#acctSwitch')) $('#acctSwitch').onchange = (e) => switchTo(e.target.value);
  if ($('#divSwitch')) $('#divSwitch').onchange = (e) => { S.divFilter = e.target.value; store('divFilter', { id: S.divFilter }); renderShell(); };
  $$('[data-billhide]').forEach((b) => (b.onclick = () => { S.billingHidden = true; b.closest('.actbanner').remove(); }));
  const views = { add: viewAdd, orgs: viewOrgs, org: viewOrg, people: viewPeople, myday: viewMyDay, proposals: viewProposals, proposal: viewProposal, inbox: viewInbox, chat: viewChat, teamdir: viewTeamDir, sites: viewSites, sales: viewSales, pipeline: viewPipeline, settings: viewSettings, accounts: viewAccounts, import: viewImport,
    team: viewTeam, review: viewReview, archive: viewArchive, lists: viewLists, history: viewHistory, pricing: viewPricing,
    directories: viewDirectories, directory: viewDirectory, mylisting: (m) => renderMemberHome(m),
    dashboard: viewDashboard, start: viewStart, tools: viewTools, whatsnew: viewWhatsNew, platform: viewPlatform, ...FLD.views(), ...GRW.views(), ...DOC.views(), ...MEA.views(), ...BID.views(), ...PRT.views(), ...ESN.views(), ...CAL.views(), ...SOC.views(), ...PLN.views(), ...RTE.views(), ...PHN.views() };
  const adminOnly = ['team', 'archive', 'lists', 'history', 'settings', 'pricing', 'accounts'];
  if (S.view === 'review' && !isAdmin() && !(FLD.fieldReviewOn() && FLD.can('review', 1)) && !DOC.reviewOn() && !BID.reviewOn()) S.view = 'dashboard';
  if (S.view === 'roles' && !FLD.can('team', 1)) S.view = 'dashboard';
  if (S.view === 'accounting' && !(FLD.feat('accounting') && (FLD.can('pay', 1) || FLD.can('settings', 4)))) S.view = 'dashboard';
  if (['jobs', 'job', 'dispatch', 'schedules'].includes(S.view) && !FLD.feat('jobs')) S.view = 'dashboard';
  if (S.view === 'time' && !FLD.feat('timeclock')) S.view = 'dashboard';
  if (S.view === 'pay' && !(FLD.feat('pay') && FLD.can('pay', 1))) S.view = 'dashboard';
  if (['sales', 'pipeline'].includes(S.view) && !(FLD.feat('sales') && FLD.can('sales', 1))) S.view = 'dashboard';
  if (['inbox', 'chat'].includes(S.view) && !(FLD.feat('inbox') && FLD.can('inbox', 1))) S.view = 'dashboard';
  if (S.view === 'accounts' && !atAgencyHome()) S.view = 'team';
  if (S.view === 'platform' && !S.acct?.platform_owner) S.view = 'dashboard';
  if (GRW.guards[S.view] && !GRW.guards[S.view]()) S.view = 'dashboard';
  if (DOC.guards[S.view] && !DOC.guards[S.view]()) S.view = 'dashboard';
  if (MEA.guards[S.view] && !MEA.guards[S.view]()) S.view = 'dashboard';
  if (BID.guards[S.view] && !BID.guards[S.view]()) S.view = 'dashboard';
  if (PRT.guards[S.view] && !PRT.guards[S.view]()) S.view = 'dashboard';
  if (ESN.guards[S.view] && !ESN.guards[S.view]()) S.view = 'dashboard';
  if (CAL.guards[S.view] && !CAL.guards[S.view]()) S.view = 'dashboard';
  if (SOC.guards[S.view] && !SOC.guards[S.view]()) S.view = 'dashboard';
  if (PLN.guards[S.view] && !PLN.guards[S.view]()) S.view = 'tools';
  if (S.view === 'start' && !isAdmin()) S.view = 'dashboard';
  if (['proposals', 'proposal', 'pricing'].includes(S.view) && S.acct?.is_gelp === false) S.view = 'pipeline';
  if (adminOnly.includes(S.view) && !isAdmin()) S.view = 'dashboard';
  if (['directories', 'directory'].includes(S.view) && !S.dirOn) S.view = 'orgs';
  if (S.view === 'mylisting' && !S.hasListings) S.view = 'orgs';
  if (isFree() && LOCKED_VIEWS.includes(S.view)) { $('#view').innerHTML = lockedView(S.view); $$('#view [data-nav]').forEach((b) => (b.onclick = () => go(b.dataset.nav))); window.scrollTo(0, 0); refreshCounts(); mountSuggest(); mountChatDock(); startChatAlerts(); return; }
  loadStages().then(() => (views[S.view] || viewDashboard)($('#view'))).then(() => setTimeout(offerTour, 600)).catch(fail);
  window.scrollTo(0, 0);
  refreshCounts();
  if (isWide() === false) showInstallBanner();
  mountSuggest();
  mountChatDock();
  startChatAlerts();
}

async function refreshCounts() {
  const jobs = [sb.from('escalations').select('id', { count: 'exact', head: true }).eq('to_user', S.me.id).eq('status', 'open')];
  if (isAdmin()) jobs.push(sb.from('review_items').select('id', { count: 'exact', head: true }).eq('status', 'open'));
  jobs.push(sb.from('chat_threads').select('id', { count: 'exact', head: true }).eq('unread_staff', true).eq('status', 'open'));
  const res = await Promise.all(jobs);
  const [e] = res, r = isAdmin() ? res[1] : null, c = res[res.length - 1];
  const nn = await sb.from('notifications').select('id', { count: 'exact', head: true }).is('done_at', null);
  S.counts.escalations = (e?.count || 0) + (nn?.count || 0);
  S.counts.review = r?.count || 0;
  if (isSugOwner()) { const sg = await sb.from('suggestions').select('id', { count: 'exact', head: true }).eq('status', 'new'); S.counts.review += sg?.count || 0; }
  if (S.dirOn && isAdmin()) S.counts.review += (await sb.rpc('directory_pending_count')).data || 0;
  S.counts.review += await FLD.fieldReviewCount().catch(() => 0);
  if (isAdmin()) S.counts.review += (await sb.from('brand_flags').select('id', { count: 'exact', head: true }).eq('status', 'open').then((r) => r.count || 0, () => 0));
  S.counts.review += await DOC.reviewCount().catch(() => 0);
  S.counts.review += await BID.reviewCount().catch(() => 0);
  S.counts.review += await PHN.reviewCount().catch(() => 0);
  S.counts.chats = c?.count || 0;
  S.counts.teamchat = (await sb.rpc('team_unread')).data || 0;
  S.counts.inboxAll = S.counts.chats + S.counts.teamchat;
  $$('[data-count]').forEach((el) => { const n = S.counts[el.dataset.count]; el.textContent = n || ''; el.hidden = !n; });
}

/* ================= lead source picker ================= */
// state: { kind: 'self'|'internal'|'external', user_id, partner_id, partner_label }
function leadPicker(box, st, { locked = false, lockedLabel = '' } = {}) {
  if (locked) {
    box.innerHTML = `<div class="picked"><div><b>${esc(lockedLabel || '—')}</b><small>Locked. Only an admin can change the lead source.</small></div><span class="lock" aria-hidden="true">🔒</span></div>`;
    return;
  }
  const seg = [...(st.allowNone ? [['none', 'Not set']] : []), ['self', 'Self'], ['internal', 'Team member'], ['external', 'Referral partner']];
  box.innerHTML = `<div class="seg">${seg.map(([k, l]) => `<button type="button" class="${st.kind === k ? 'on' : ''}" data-kind="${k}">${l}</button>`).join('')}</div>
    <div class="seg-body"></div>`;
  const body = $('.seg-body', box);
  $$('[data-kind]', box).forEach((b) => (b.onclick = () => { st.kind = b.dataset.kind; leadPicker(box, st); }));
  if (st.kind === 'none') {
    body.innerHTML = `<small class="hint">No one gets lead credit yet. Once it's set, only an admin can change it.</small>`;
  } else if (st.kind === 'self') {
    body.innerHTML = `<small class="hint">Credit goes to you, ${esc(S.me.full_name)}.</small>`;
  } else if (st.kind === 'internal') {
    body.innerHTML = `<select id="lpUser">${userOptions(st.user_id, 'Pick a team member…')}</select>`;
    $('#lpUser', body).onchange = (e) => (st.user_id = e.target.value);
  } else {
    if (st.partner_id) {
      body.innerHTML = `<div class="picked"><div><b>${esc(st.partner_label)}</b><small>Referral partner</small></div><button type="button" class="btn ghost small" id="lpChg">Change</button></div>`;
      $('#lpChg', body).onclick = () => { st.partner_id = ''; st.partner_label = ''; leadPicker(box, st); };
      return;
    }
    body.innerHTML = `<input type="search" id="lpQ" placeholder="Search referral partners" autocomplete="off"><div id="lpRes"></div>`;
    const q = $('#lpQ', body);
    const run = debounce(async () => {
      const term = clean(q.value); const res = $('#lpRes', body);
      let query = sb.from('companies').select('id,name,city,state').contains('org_types', [partnerType()]).is('archived_at', null).order('name').limit(8);
      if (term) query = query.ilike('name', `%${term}%`);
      const { data } = await query;
      res.innerHTML = `<div class="results">${(data || []).map((p) => `<button type="button" class="result" data-pid="${p.id}" data-name="${esc(p.name)}"><b>${esc(p.name)}</b><small>${esc([p.city, p.state].filter(Boolean).join(', '))}</small></button>`).join('')}
        ${term ? `<button type="button" class="result create" id="lpNew">+ Add new referral partner “${esc(q.value.trim())}”</button>` : ''}</div>`;
      $$('[data-pid]', res).forEach((b) => (b.onclick = () => { st.partner_id = b.dataset.pid; st.partner_label = b.dataset.name; leadPicker(box, st); }));
      const nb = $('#lpNew', res);
      if (nb) nb.onclick = async () => {
        const { data: row, error } = await sb.from('companies').insert({ name: q.value.trim(), org_types: [partnerType()], stage: null }).select('id,name').single();
        if (error) return fail(error);
        st.partner_id = row.id; st.partner_label = row.name; toast('Referral partner added'); leadPicker(box, st);
      };
    });
    q.oninput = run; run();
  }
}
const leadFields = (st) => st.kind === 'none' ? { lead_source_kind: null, lead_source_id: null, lead_source_partner_id: null } : ({
  lead_source_kind: st.kind,
  lead_source_id: st.kind === 'self' ? S.me.id : st.kind === 'internal' ? (st.user_id || null) : null,
  lead_source_partner_id: st.kind === 'external' ? (st.partner_id || null) : null,
});
function leadValid(st) {
  if (st.kind === 'internal' && !st.user_id) return 'Pick the team member who brought in this lead';
  if (st.kind === 'external' && !st.partner_id) return 'Pick or add the referral partner';
  return null;
}
function leadLabel(c, partnerName = '') {
  if (c.lead_source_kind === 'external' || c.lead_source_partner_id) return (partnerName || 'Referral partner') + ' (referral partner)';
  if (c.lead_source_kind === 'self') return userName(c.lead_source_id) + ' (self)';
  if (c.lead_source_id) return userName(c.lead_source_id);
  if (c.lead_source_kind === 'system') return 'Automated';
  return '';
}
const leadIsSet = (c) => !!(c.lead_source_id || c.lead_source_partner_id || c.lead_source_kind);

/* ================= QUICK ADD ================= */
const blankContact = () => ({ person_id: null, first_name: '', last_name: '', title: '', role: '', cell: '', email: '', is_decision_maker: false, is_primary_contact: false, is_billing: false, existing_label: '', open: true });
let QE = null;
function resetQE(org = null) {
  QE = { company_id: org?.id || null, company_label: org ? org.name : '', picked: org || null,
    company: { name: '', org_types: [defaultOrgType()], specialty: '', address: '', city: '', state: '', zip: '', main_phone: '' },
    creating: false, owner_id: S.me?.id || '', ls: { kind: 'self', user_id: '', partner_id: '', partner_label: '' },
    contacts: [blankContact()], services: [], notes: '', next_step: '', follow_up_date: '', lead_source_channel: '' };
}

const ORG_PICK = 'id,name,org_types,stage,pipeline_stage_id,address,city,state,zip,main_phone,specialty,owner_id,divisions,company_people(count)';
const orgCard = (c) => `<b>${esc(c.name)}</b> <span class="meta inline">${typeBadges(c.org_types)}</span>
  ${orgAddr(c) ? `<small>${esc(orgAddr(c))}</small>` : ''}
  <small>${esc([c.main_phone, c.specialty].filter(Boolean).join(' · '))}</small>
  <small>${esc([plural(c.company_people?.[0]?.count || 0, 'contact'), stageLabel(c.pipeline_stage_id), c.owner_id ? 'Owner: ' + userName(c.owner_id) : ''].filter(Boolean).join(' · '))}</small>`;

async function viewAdd(main) {
  if (S.param) {
    const { data } = await sb.from('companies').select(ORG_PICK).eq('id', S.param).maybeSingle();
    resetQE(data);
  } else if (!QE) resetQE();

  // tabs across the top when the account has more than one kind of thing to add (Contact, Job...)
  const qtabs = FLD.quickTabs();
  let qtab = recall('qaTab', { v: '' }).v;
  if (!qtabs.some((t) => t.id === qtab)) qtab = !FLD.can('contacts', 2) && qtabs.some((t) => t.id === 'job') ? 'job' : qtabs[0].id;
  main.innerHTML = `
    <h1>Quick Add</h1>
    ${qtabs.length > 1 ? `<div class="pltabs qatabs" role="tablist">${qtabs.map((t) => `<button type="button" role="tab" class="pltab ${t.id === qtab ? 'on' : ''}" data-qt="${t.id}">${esc(t.label)}${t.id === 'job' && FLD.qjHasContent() ? ' •' : ''}</button>`).join('')}</div>` : ''}
    <div id="qaJob" ${qtab === 'job' ? '' : 'hidden'}></div>
    <div id="qaContact" ${qtab === 'contact' ? '' : 'hidden'}>
    <div class="card"><h2>${esc(FLD.L('organization'))}</h2><div id="qeOrg"></div></div>
    <div class="card"><h2>${esc(FLD.L('person', true))}</h2><div id="qeContacts"></div>
      <div class="actions"><button class="btn secondary small" id="addContact">+ Add another contact</button></div></div>
    <div class="card">
      <h2>Services discussed</h2>
      <div class="chips" id="qeServices">${lk('service').map((s) => `<button type="button" class="chip ${QE.services.includes(s) ? 'on' : ''}" data-svc="${esc(s)}">${esc(s)}</button>`).join('')}</div>
      <label class="label">Notes <span style="font-weight:400">(tap the mic on your keyboard to dictate)</span></label>
      <textarea id="qeNotes" placeholder="What happened, who you met, what they need">${esc(QE.notes)}</textarea>
      <label class="label">Next step</label>
      <input type="text" id="qeNext" value="${esc(QE.next_step)}" placeholder="Send proposal, schedule demo…">
      <label class="label">Follow-up date</label>
      <input type="date" id="qeDate" value="${esc(QE.follow_up_date)}">
      <div class="quick">
        ${followupDays().map((d) => `<button class="btn secondary small" data-days="${d}">${esc(dayLabel(d))}</button>`).join('')}
      </div>
    </div>
    </div>
    <div class="savebar"><button class="btn gold block" id="qeSave">Save</button></div>`;
  if (qtabs.length > 1) {
    FLD.quickJobForm($('#qaJob'), !!(QE.company_id || QE.company.name.trim()));
    $$('[data-qt]').forEach((b) => (b.onclick = () => {
      store('qaTab', { v: b.dataset.qt });
      $$('[data-qt]').forEach((x) => x.classList.toggle('on', x === b));
      $('#qaJob').hidden = b.dataset.qt !== 'job'; $('#qaContact').hidden = b.dataset.qt !== 'contact';
      if (b.dataset.qt === 'job') FLD.quickJobForm($('#qaJob'), !!(QE.company_id || QE.company.name.trim()));
    }));
  }

  renderQEOrg(); renderQEContacts();
  $('#addContact').onclick = () => { QE.contacts.forEach((c) => (c.open = false)); QE.contacts.push(blankContact()); renderQEContacts(); };
  $$('[data-svc]').forEach((b) => (b.onclick = () => {
    const s = b.dataset.svc; const i = QE.services.indexOf(s);
    i >= 0 ? QE.services.splice(i, 1) : QE.services.push(s); b.classList.toggle('on');
  }));
  $('#qeNotes').oninput = (e) => (QE.notes = e.target.value);
  $('#qeNext').oninput = (e) => (QE.next_step = e.target.value);
  $('#qeDate').oninput = (e) => (QE.follow_up_date = e.target.value);
  $$('[data-days]').forEach((b) => (b.onclick = () => { QE.follow_up_date = addDays(+b.dataset.days); $('#qeDate').value = QE.follow_up_date; }));
  $('#qeSave').onclick = saveQE;
}

function renderQEOrg() {
  const box = $('#qeOrg');
  if (QE.company_id) {
    const c = QE.picked || { name: QE.company_label };
    box.innerHTML = `<div class="picked"><div>${orgCard(c)}</div><button class="btn ghost small" id="chg">Change</button></div>`;
    $('#chg').onclick = () => { QE.company_id = null; QE.company_label = ''; QE.picked = null; renderQEOrg(); };
    return;
  }
  if (QE.creating) {
    const c = QE.company;
    box.innerHTML = `
      <div class="picked"><div><b>New organization</b><small>Will be created when you save</small></div><button class="btn ghost small" id="cancelNew">Search instead</button></div>
      <label class="label">Type</label>
      <div class="chips" id="qeTypes">${lk('org_type').map((t) => `<button type="button" class="chip ${c.org_types.includes(t) ? 'on' : ''}" data-type="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      <label class="label" for="qePipe">Pipeline</label><select id="qePipe"><option value="none">Not in a pipeline</option>${stageOptions(QE.pipe_set ? QE.pipe : startsInLead(c.org_types) ? defaultLeadStage() : '')}</select>
      <label class="label">Name</label><input type="text" data-cf="name" value="${esc(c.name)}">
      <label class="label">Street address</label><input type="text" data-cf="address" value="${esc(c.address)}" autocomplete="street-address" placeholder="123 Main St, Suite 4">
      <div class="row3"><div><label class="label">City</label><input type="text" data-cf="city" value="${esc(c.city)}" autocomplete="address-level2"></div>
        <div><label class="label">State</label><input type="text" data-cf="state" maxlength="2" value="${esc(c.state)}" autocomplete="address-level1"></div>
        <div><label class="label">ZIP</label><input type="text" inputmode="numeric" data-cf="zip" maxlength="10" value="${esc(c.zip)}" autocomplete="postal-code"></div></div>
      <div class="row"><div><label class="label">Main phone</label><input type="tel" data-cf="main_phone" value="${esc(c.main_phone)}"></div>
        <div><label class="label">Specialty / category</label><select data-cf="specialty">${options('specialty', c.specialty, 'Choose…')}</select></div></div>
      <div id="dupWarn"></div>
      <label class="label">Lead source (gets lead credit)</label><div id="qeLead"></div>
      <div class="row"><div><label class="label">Owner / closer</label><select id="qeOwner">${userOptions(QE.owner_id)}</select></div>
        <div><label class="label">How did it come in?</label><select id="lsc">${options('lead_channel', QE.lead_source_channel, 'Choose…')}</select></div></div>`;
    leadPicker($('#qeLead'), QE.ls);
    const checkDup = debounce(async () => {
      const ors = []; const n = clean(c.name), ph = digits(c.main_phone), ad = clean(c.address);
      if (n.length >= 4) ors.push(`name.ilike.%${n}%`);
      if (ph.length >= 7) ors.push(`main_phone.ilike.%${ph.slice(-4)}%`);
      const num = ad.match(/^\d+/); if (num && c.city.trim()) ors.push(`and(address.ilike.${num[0]} %,city.ilike.${clean(c.city)})`);
      const w = $('#dupWarn'); if (!w) return;
      if (!ors.length) return (w.innerHTML = '');
      const { data } = await sb.from('companies').select(ORG_PICK).is('archived_at', null).or(ors.join(',')).limit(4);
      w.innerHTML = data?.length ? `<label class="label" style="color:var(--warn)">Possible match already in the CRM</label><div class="results">${data.map((m) => `<button type="button" class="result" data-id="${m.id}">${orgCard(m)}<small style="color:var(--navy-2);font-weight:600">Tap to use this one instead</small></button>`).join('')}</div>` : '';
      $$('.result[data-id]', w).forEach((b) => (b.onclick = () => { const m = data.find((x) => x.id === b.dataset.id); QE.creating = false; QE.company_id = m.id; QE.company_label = m.name; QE.picked = m; renderQEOrg(); }));
    }, 400);
    $$('[data-type]', box).forEach((b) => (b.onclick = () => {
      const t = b.dataset.type; const i = c.org_types.indexOf(t);
      if (i >= 0) { if (c.org_types.length === 1) return toast('Pick at least one type'); c.org_types.splice(i, 1); } else c.org_types.push(t);
      b.classList.toggle('on');
    }));
    $$('[data-cf]', box).forEach((i) => (i.oninput = i.onchange = (e) => { QE.company[i.dataset.cf] = e.target.value; if (['name', 'main_phone', 'address', 'city'].includes(i.dataset.cf)) checkDup(); }));
    $('#lsc').onchange = (e) => (QE.lead_source_channel = e.target.value);
    $('#qeOwner').onchange = (e) => (QE.owner_id = e.target.value);
    $('#qePipe').onchange = (e) => { QE.pipe = e.target.value; QE.pipe_set = true; };
    $('#cancelNew').onclick = () => { QE.creating = false; renderQEOrg(); };
    checkDup();
    return;
  }
  box.innerHTML = `<input type="search" id="orgQ" placeholder="Search by name, city, street or phone" autocomplete="off"><div id="orgRes"></div>`;
  const q = $('#orgQ'); q.focus({ preventScroll: true });
  q.oninput = debounce(async () => {
    const term = clean(q.value); const res = $('#orgRes');
    if (term.length < 2) return (res.innerHTML = '');
    const ors = [`name.ilike.%${term}%`, `city.ilike.%${term}%`, `address.ilike.%${term}%`];
    const d = digits(term); if (d.length >= 4 && d.length === term.replace(/[\s()-]/g, '').length) ors.push(`main_phone.ilike.%${d.slice(-4)}%`);
    const { data } = await sb.from('companies').select(ORG_PICK).is('archived_at', null).or(ors.join(',')).order('name').limit(10);
    res.innerHTML = `<div class="results">${(data || []).map((c) => `<button class="result" data-id="${c.id}">${orgCard(c)}</button>`).join('')}
      <button class="result create" id="createNew">+ Create new organization “${esc(q.value.trim())}”</button></div>`;
    $$('.result[data-id]', res).forEach((b) => (b.onclick = () => { const m = data.find((x) => x.id === b.dataset.id); QE.company_id = m.id; QE.company_label = m.name; QE.picked = m; renderQEOrg(); }));
    $('#createNew').onclick = () => { QE.creating = true; QE.company.name = /\d/.test(q.value) ? '' : q.value.trim(); renderQEOrg(); };
  });
}

function contactSummary(c) {
  const name = c.person_id ? c.existing_label : fullName(c);
  return [name, c.title || c.role, c.is_decision_maker ? 'Decision maker' : '', c.is_billing ? 'Billing' : ''].filter(Boolean).join(' · ');
}

function renderQEContacts() {
  const box = $('#qeContacts');
  box.innerHTML = QE.contacts.map((c, i) => {
    const filled = c.person_id || c.first_name.trim();
    if (!c.open && filled) return `<div class="contact done" data-open="${i}"><div class="contact-head"><span>${esc(contactSummary(c))}</span><button class="btn ghost small" data-rm="${i}">Remove</button></div></div>`;
    return `<div class="contact" data-i="${i}">
      <div class="contact-head"><b>Contact ${i + 1}</b>${QE.contacts.length > 1 ? `<button class="btn ghost small" data-rm="${i}">Remove</button>` : ''}</div>
      ${c.person_id ? `<div class="picked" style="margin-top:8px"><div><b>${esc(c.existing_label)}</b><small>Existing person, linking them here</small></div><button class="btn ghost small" data-unlink="${i}">Change</button></div>` : `
      <div class="row"><div><label class="label">First name</label><input type="text" data-k="first_name" value="${esc(c.first_name)}" autocomplete="off"></div>
        <div><label class="label">Last name</label><input type="text" data-k="last_name" value="${esc(c.last_name)}" autocomplete="off"></div></div>
      <div class="matches"></div>
      <div class="row"><div><label class="label">Cell</label><input type="tel" data-k="cell" value="${esc(c.cell)}"></div>
        <div><label class="label">Email</label><input type="email" data-k="email" value="${esc(c.email)}"></div></div>`}
      <div class="row"><div><label class="label">Title here</label><input type="text" data-k="title" value="${esc(c.title)}" placeholder="Practice Manager"></div>
        <div><label class="label">Role</label><select data-k="role">${options('contact_role', c.role, 'Choose…')}</select></div></div>
      <label class="check"><input type="checkbox" data-k="is_decision_maker" ${c.is_decision_maker ? 'checked' : ''}> Decision maker</label>
      <label class="check"><input type="checkbox" data-k="is_primary_contact" ${c.is_primary_contact ? 'checked' : ''}> Primary contact</label>
      <label class="check"><input type="checkbox" data-k="is_billing" ${c.is_billing ? 'checked' : ''}> Billing contact</label>
      ${QE.contacts.length > 1 || filled ? `<div class="actions"><button class="btn secondary small" data-done="${i}">Done with this contact</button></div>` : ''}
    </div>`;
  }).join('');

  $$('[data-open]', box).forEach((el) => (el.onclick = (e) => { if (e.target.closest('[data-rm]')) return; QE.contacts.forEach((c) => (c.open = false)); QE.contacts[+el.dataset.open].open = true; renderQEContacts(); }));
  $$('[data-rm]', box).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); QE.contacts.splice(+b.dataset.rm, 1); if (!QE.contacts.length) QE.contacts.push(blankContact()); renderQEContacts(); }));
  $$('[data-done]', box).forEach((b) => (b.onclick = () => { QE.contacts[+b.dataset.done].open = false; if (!QE.contacts.some((c) => c.open)) QE.contacts.push(blankContact()); renderQEContacts(); }));
  $$('[data-unlink]', box).forEach((b) => (b.onclick = () => { Object.assign(QE.contacts[+b.dataset.unlink], { person_id: null, existing_label: '' }); renderQEContacts(); }));
  $$('.contact[data-i]', box).forEach((el) => {
    const c = QE.contacts[+el.dataset.i];
    $$('[data-k]', el).forEach((inp) => {
      inp.oninput = inp.onchange = (e) => { c[inp.dataset.k] = inp.type === 'checkbox' ? e.target.checked : e.target.value; };
    });
    const lookFor = debounce(() => findPeople(c, $('.matches', el)), 300);
    $$('[data-k=first_name],[data-k=last_name],[data-k=cell],[data-k=email]', el).forEach((inp) => inp.addEventListener('input', lookFor));
  });
}

async function findPeople(c, box) {
  if (!box) return;
  const fn = clean(c.first_name), ln = clean(c.last_name), cell = digits(c.cell), em = clean(c.email.toLowerCase());
  const ors = [];
  if (fn.length >= 2 && ln.length >= 2) ors.push(`and(first_name.ilike.${fn}%,last_name.ilike.${ln}%)`);
  else if (ln.length >= 3) ors.push(`last_name.ilike.${ln}%`);
  if (cell.length >= 7) ors.push(`personal_cell.ilike.%${cell.slice(-7, -4)}%${cell.slice(-4)}%`);
  if (em.includes('@')) ors.push(`personal_email.eq.${em}`);
  if (!ors.length) return (box.innerHTML = '');
  const { data } = await sb.from('people').select('id,first_name,last_name,personal_cell,company_people(title,companies(name,archived_at))').is('archived_at', null).or(ors.join(',')).limit(5);
  if (!data?.length) return (box.innerHTML = '');
  box.innerHTML = `<div class="results">${data.map((p) => {
    const links = (p.company_people || []).filter((l) => l.companies && !l.companies.archived_at).map((l) => l.companies.name);
    const sub = [p.personal_cell ? 'cell ending ' + digits(p.personal_cell).slice(-4) : '', links.length ? 'linked to ' + links.slice(0, 2).join(', ') + (links.length > 2 ? ` and ${links.length - 2} more` : '') : ''].filter(Boolean).join(', ');
    return `<button class="result" data-pid="${p.id}" data-label="${esc(fullName(p))}"><b>Already in CRM: ${esc(fullName(p))}</b><small>${esc(sub)} · tap to use</small></button>`;
  }).join('')}</div>`;
  $$('[data-pid]', box).forEach((b) => (b.onclick = () => { Object.assign(c, { person_id: b.dataset.pid, existing_label: b.dataset.label }); renderQEContacts(); }));
}

async function saveQE() {
  if (!QE.company_id && !(QE.creating && QE.company.name.trim())) return toast(FLD.qjHasContent() ? `Pick the ${FLD.l('organization')} on the ${FLD.L('contact')} tab first` : `Pick an ${FLD.l('organization')} or create one first`);
  const onlyJob = FLD.qjHasContent() && QE.company_id && !QE.contacts.some((c) => c.person_id || c.first_name.trim()) && !QE.notes.trim() && !QE.services.length && !QE.next_step.trim() && !QE.follow_up_date;
  if (onlyJob) {
    const jid = await FLD.saveQuickJob(QE.company_id, QE.picked?.divisions || []);
    if (jid) { resetQE(); toast(`${FLD.L('job')} added`); go('job', jid); }
    return;
  }
  if (!QE.company_id) { const bad = leadValid(QE.ls); if (bad) return toast(bad); }
  const contacts = QE.contacts.filter((c) => c.person_id || c.first_name.trim()).map(({ open, existing_label, ...c }) => c);
  const btn = $('#qeSave'); btn.disabled = true; btn.textContent = 'Saving…';
  const { data, error } = await sb.rpc('quick_entry', { p: {
    company_id: QE.company_id, company: QE.company, contacts, services: QE.services,
    owner_id: QE.owner_id, ...leadFields(QE.ls),
    notes: QE.notes, next_step: QE.next_step, follow_up_date: QE.follow_up_date, lead_source_channel: QE.lead_source_channel,
  } });
  btn.disabled = false; btn.textContent = 'Save';
  if (error) return fail(error);
  // a new organization lands where the Pipeline picker says (the database only puts listed types in Lead)
  if (!QE.company_id && data) {
    const want = $('#qePipe') ? $('#qePipe').value : (QE.pipe_set ? QE.pipe : null);
    if (want) { const { error: pe } = await sb.from('companies').update({ pipeline_stage_id: want === 'none' ? null : want }).eq('id', data); if (pe) fail(pe); }
  }
  const name = QE.company_id ? QE.company_label : QE.company.name;
  const jobId = FLD.qjHasContent() ? await FLD.saveQuickJob(data, QE.picked?.divisions || []) : null;
  resetQE();
  toast(jobId ? `Saved to ${name}, with the ${FLD.l('job')} linked` : `Saved to ${name}`);
  jobId ? go('job', jobId) : go('org', data);
}

/* ================= ORGANIZATIONS (list + stackable filters) ================= */
const BLANK_FILTER = { q: '', types: [], stage: '', state: '', city: '', specialty: '', owner: '', lead: '', interest: '', act: '', due: false };
const ACT_OPTS = [['7', 'Active in the last 7 days'], ['30', 'Active in the last 30 days'], ['90', 'Active in the last 90 days'], ['q30', 'No activity in 30+ days'], ['q90', 'No activity in 90+ days']];
let OF = { ...BLANK_FILTER, ...recall('orgFilters', {}) };
if (OF.stage && OF.stage !== 'none' && !/^[0-9a-f-]{36}$/i.test(OF.stage)) OF.stage = '';   // older saved filters used stage names
let FACETS = null; let PARTNERS = null;
const PAGE = 100;

async function viewOrgs(main) {
  if (!FACETS) {
    const [f, p] = await Promise.all([
      sb.rpc('company_facets'),
      sb.from('companies').select('id,name').contains('org_types', [partnerType()]).is('archived_at', null).order('name').limit(500),
    ]);
    FACETS = f.data || { states: [], specialties: [] }; PARTNERS = p.data || [];
  }
  const activeCount = () => ['stage', 'state', 'city', 'specialty', 'owner', 'lead', 'interest', 'act'].filter((k) => OF[k]).length + (OF.due ? 1 : 0);
  const { data: qfs } = await sb.from('shortcuts').select('id,name,filters,shared,user_id').eq('screen', 'orgs').order('sort').order('created_at');
  const same = (f) => JSON.stringify({ ...BLANK_FILTER, ...f, types: [...(f.types || [])].sort() }) === JSON.stringify({ ...OF, types: [...OF.types].sort() });
  const onQ = (qfs || []).find((x) => same(x.filters || {}));
  const sel = (id, label, opts, val) => `<div><label class="label">${label}</label><select id="${id}"><option value="">Any</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  const userOpts = [['me', 'Me'], ...staff().map((u) => [u.id, u.full_name]), ['none', 'Unassigned']];
  main.innerHTML = `
    <div class="toolbar"><h1 style="margin:0;flex:1">${esc(FLD.L('organization', true))}</h1><button class="btn small" id="newOrg">+ Quick Add</button></div>
    <div class="toolbar"><input type="search" id="oq" placeholder="Search name, city or specialty" value="${esc(OF.q)}"></div>
    <div class="chips typechips quickrow" role="group" aria-label="Quick filter"><span class="qlabel">Quick filter</span>
      ${lk('org_type').map((t) => `<button type="button" class="chip ${OF.types.includes(t) && !onQ ? 'on' : ''}" data-ft="${esc(t)}">${esc(t)}</button>`).join('')}
      ${(qfs || []).map((x) => `<span class="qchip ${onQ?.id === x.id ? 'on' : ''}"><button type="button" class="chip ${onQ?.id === x.id ? 'on' : ''}" data-qf="${x.id}" title="${x.shared ? 'Shared with the team' : 'Just for you'}">${esc(x.name)}${x.shared ? ' 👥' : ''}</button>${onQ?.id === x.id && (x.user_id === S.me.id || (x.shared && isAdmin())) ? `<button type="button" class="qdel" data-qdel="${x.id}" aria-label="Remove quick filter ${esc(x.name)}">×</button>` : ''}</span>`).join('')}
      <button type="button" class="chip ghostchip" id="qAdd" title="Save the filters you have on now as a quick filter" aria-label="Save current filters as a quick filter">+</button>
      <button type="button" class="chip ghostchip" id="moreF">Filters${activeCount() ? ` (${activeCount()})` : ''}</button></div>
    <div class="card filters" id="fpanel" ${activeCount() ? '' : 'hidden'}>
      <div class="fgrid">
        ${sel('fStage', 'Stage', [...S.stages.map((x) => [x.id, stageLabel(x.id)]), ['none', 'Not in a pipeline']], OF.stage)}
        ${sel('fOwner', 'Owner / closer', userOpts, OF.owner)}
        ${sel('fLead', 'Lead source', [['me', 'Me'], ...staff().map((u) => [u.id, u.full_name]), ['external', 'Any referral partner'], ...PARTNERS.map((p) => ['p:' + p.id, p.name + ' (partner)'])], OF.lead)}
        ${sel('fState', 'State', FACETS.states.map((s) => [s.v, `${s.v} (${s.n})`]), OF.state)}
        <div><label class="label" for="fCity">City</label><input type="text" id="fCity" value="${esc(OF.city)}" placeholder="Any"></div>
        ${sel('fAct', 'Activity', ACT_OPTS, OF.act)}
        ${sel('fSpec', 'Specialty / category', FACETS.specialties.map((s) => [s.v, `${s.v} (${s.n})`]), OF.specialty)}
        ${sel('fInt', 'Interest', lk('interest_level').map((s) => [s, s]), OF.interest)}
      </div>
      <label class="check"><input type="checkbox" id="fDue" ${OF.due ? 'checked' : ''}> Follow-up due</label>
      <div class="actions"><button class="btn ghost small" id="fClear">Clear all filters</button></div>
    </div>
    <p class="empty" id="ocount" style="margin:0 0 8px"></p>
    <div class="list" id="olist"><p class="empty">Loading…</p></div>
    <div class="actions" id="omore"></div>`;
  $('#newOrg').onclick = () => { resetQE(); go('add'); };
  $('#moreF').onclick = () => { const p = $('#fpanel'); p.hidden = !p.hidden; };
  let offset = 0;
  const card = (c) => {
    const due = c.follow_up_date && c.follow_up_date <= today();
    return `<button class="item" data-id="${c.id}"><b>${esc(c.name)}</b>
      <small>${esc([c.specialty, [c.city, c.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '))}</small>
      <div class="meta">${typeBadges(c.org_types)}
        ${c.pipeline_stage_id ? `<span class="badge stage">${esc(stageLabel(c.pipeline_stage_id))}</span>` : ''}
        <span class="badge">${plural(c.company_people?.[0]?.count || 0, 'contact')}</span>
        ${c.owner_id ? `<span class="badge">${esc(userName(c.owner_id))}</span>` : ''}${divOn() ? '' : divChips(c.divisions)}
        ${c.interest_level ? `<span class="badge gold">${esc(c.interest_level)}</span>` : ''}
        ${c.follow_up_date ? `<span class="badge ${due ? 'due' : ''}">Follow up ${esc(fmtDate(c.follow_up_date))}</span>` : ''}
      </div></button>`;
  };
  const load = async (more = false) => {
    store('orgFilters', OF);
    if (!more) offset = 0;
    let q = sb.from('companies').select('id,name,org_types,stage,pipeline_stage_id,city,state,specialty,follow_up_date,owner_id,interest_level,divisions,company_people(count)', { count: 'exact' })
      .is('archived_at', null).order('name').range(offset, offset + PAGE - 1);
    q = divQ(q);
    const term = clean(OF.q);
    if (term) q = q.or(`name.ilike.%${term}%,city.ilike.%${term}%,specialty.ilike.%${term}%`);
    if (OF.types.length) q = q.overlaps('org_types', OF.types);
    if (OF.stage) q = OF.stage === 'none' ? q.is('pipeline_stage_id', null) : q.eq('pipeline_stage_id', OF.stage);
    if (OF.state) q = q.eq('state', OF.state);
    if (clean(OF.city)) q = q.ilike('city', `%${clean(OF.city)}%`);
    if (OF.act) {
      const n = +OF.act.replace('q', ''), since = new Date(Date.now() - n * 864e5).toISOString();
      q = OF.act.startsWith('q') ? q.or(`last_activity_at.is.null,last_activity_at.lt.${since}`) : q.gte('last_activity_at', since);
    }
    if (OF.specialty) q = q.eq('specialty', OF.specialty);
    if (OF.interest) q = q.eq('interest_level', OF.interest);
    if (OF.owner) q = OF.owner === 'none' ? q.is('owner_id', null) : q.eq('owner_id', OF.owner === 'me' ? S.me.id : OF.owner);
    if (OF.lead) {
      if (OF.lead === 'external') q = q.not('lead_source_partner_id', 'is', null);
      else if (OF.lead.startsWith('p:')) q = q.eq('lead_source_partner_id', OF.lead.slice(2));
      else q = q.eq('lead_source_id', OF.lead === 'me' ? S.me.id : OF.lead);
    }
    if (OF.due) q = q.lte('follow_up_date', today());
    const { data, error, count } = await q;
    if (error) return fail(error);
    const list = $('#olist'); if (!list) return;
    const html = (data || []).map(card).join('');
    const filtered = term || OF.types.length || activeCount();
    if (more) list.insertAdjacentHTML('beforeend', html);
    else list.innerHTML = html || `<p class="empty">${filtered ? 'Nothing matches those filters.' : 'Nothing here yet. Tap Quick Add to enter your first one.'}</p>`;
    offset += (data || []).length;
    $('#ocount').textContent = count ? `Showing ${offset} of ${count}` : '';
    $('#omore').innerHTML = offset < (count || 0) ? '<button class="btn secondary block" id="loadMore">Show more</button>' : '';
    if ($('#loadMore')) $('#loadMore').onclick = () => load(true);
    $$('#olist [data-id]').forEach((b) => (b.onclick = () => go('org', b.dataset.id)));
    $('#moreF').textContent = 'Filters' + (activeCount() ? ` (${activeCount()})` : '');
  };
  $('#oq').oninput = debounce((e) => { OF.q = e.target.value; load(); });
  $$('[data-ft]').forEach((b) => (b.onclick = () => {
    const t = b.dataset.ft; const i = OF.types.indexOf(t);
    i >= 0 ? OF.types.splice(i, 1) : OF.types.push(t); b.classList.toggle('on'); load();
  }));
  const bind = (id, key) => ($('#' + id).onchange = (e) => { OF[key] = e.target.value; load(); });
  bind('fStage', 'stage'); bind('fOwner', 'owner'); bind('fLead', 'lead'); bind('fState', 'state'); bind('fSpec', 'specialty'); bind('fInt', 'interest'); bind('fAct', 'act');
  $('#fCity').oninput = debounce((e) => { OF.city = e.target.value; load(); });
  // quick filters: tap to apply (tap again to clear), + saves what's on now, × removes the one that's on
  $$('[data-qf]').forEach((b) => (b.onclick = () => {
    const x = qfs.find((y) => y.id === b.dataset.qf);
    OF = onQ?.id === x.id ? { ...BLANK_FILTER, types: [] } : { ...BLANK_FILTER, ...x.filters, types: [...(x.filters.types || [])] };
    store('orgFilters', OF); renderShell();
  }));
  $('#qAdd').onclick = async () => {
    if (!clean(OF.q) && !OF.types.length && !activeCount()) { toast('Pick some filters first (a type, or open Filters), then tap + to save them.'); $('#fpanel').hidden = false; return; }
    const name = prompt('Name this quick filter (for example "Vendors in Biloxi, active 30 days")'); if (!name || !name.trim()) return;
    const shared = isAdmin() && confirm('Share it with the whole team?\n\nOK shares it. Cancel keeps it just for you.');
    const { error } = await sb.from('shortcuts').insert({ screen: 'orgs', name: name.trim().slice(0, 40), filters: { ...OF, q: clean(OF.q) }, shared });
    if (error) return fail(error);
    toast(shared ? 'Quick filter saved for the team' : 'Quick filter saved'); renderShell();
  };
  $$('[data-qdel]').forEach((b) => (b.onclick = async () => {
    const x = qfs.find((y) => y.id === b.dataset.qdel);
    if (!confirm(`Remove the quick filter "${x.name}"${x.shared ? ' for everyone' : ''}? Your current filters stay on.`)) return;
    const { error } = await sb.from('shortcuts').delete().eq('id', x.id); if (error) return fail(error);
    toast('Removed'); renderShell();
  }));
  $('#fDue').onchange = (e) => { OF.due = e.target.checked; load(); };
  $('#fClear').onclick = () => { OF = { ...BLANK_FILTER, types: [] }; renderShell(); };
  load();
}

/* ================= ORGANIZATION DETAIL ================= */
async function viewOrg(main) {
  const id = S.param;
  const [co, links, opps, tasks, escs, referred] = await Promise.all([
    sb.from('companies').select('*, logo:media!companies_logo_media_id_fkey(url)').eq('id', id).maybeSingle(),
    sb.from('company_people').select('*, people(*)').eq('company_id', id).order('is_decision_maker', { ascending: false }).order('is_primary_contact', { ascending: false }),
    sb.from('opportunities').select('*').eq('company_id', id).order('created_at'),
    sb.from('tasks').select('*').eq('company_id', id).eq('done', false).order('due_date'),
    sb.from('escalations').select('*').eq('company_id', id).eq('status', 'open').order('created_at', { ascending: false }),
    sb.from('companies').select('id,name,stage,pipeline_stage_id,org_types').eq('lead_source_partner_id', id).is('archived_at', null).order('name').limit(200),
  ]);
  const c = co.data;
  if (!c) { main.innerHTML = '<p class="empty">Not found. It may have been deleted.</p>'; return; }
  let partnerName = '';
  if (c.lead_source_partner_id) {
    const { data } = await sb.from('companies').select('name').eq('id', c.lead_source_partner_id).maybeSingle();
    partnerName = data?.name || '';
  }
  const addr = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
  const statuses = lk('opportunity_status');
  const people = (links.data || []).filter((l) => l.people && !l.people.archived_at);

  main.innerHTML = `
    <div class="toolbar"><button class="btn ghost small" id="back">← ${esc(FLD.L('organization', true))}</button><div style="flex:1"></div>
      ${c.archived_at ? '' : `<button class="btn small" id="addPeople">+ Contacts / visit</button>
      ${S.acct?.is_gelp === false ? '' : '<button class="btn gold small" id="propBtn">Proposal</button>'}
      <button class="btn secondary small" id="escBtn">Escalate</button>
      <button class="btn ghost small" id="moreBtn" aria-expanded="false">More ▾</button>`}</div>
    <div class="morebox" id="moreBox" hidden>
      <button class="btn ghost small" id="logoBtn">${c.logo?.url ? 'Change logo' : 'Upload logo'}</button>
      <button class="btn ghost small" id="dupBtn">Flag as duplicate</button>
      <button class="btn ghost small danger" id="delBtn">Delete…</button>
    </div>
    ${c.archived_at ? `<div class="banner warn"><b>${c.archive_status === 'pending' ? 'Delete requested, waiting on admin approval' : 'Archived'}</b>
      <span>${esc(c.archive_reason || '')}${c.archived_by ? ' · ' + esc(userName(c.archived_by)) : ''} · ${esc(fmtDate(c.archived_at))}</span>
      ${isAdmin() ? '<button class="btn small" id="restoreBtn">Restore</button>' : ''}</div>` : ''}
    <div id="panel"></div>
    <div class="titlerow">${c.logo?.url ? `<img class="orglogo" src="${esc(c.logo.url)}" alt="">` : ''}<h1 id="oName">${esc(c.name)}</h1>${!c.archived_at && FLD.can('contacts', 2) ? '<button type="button" class="linkish small" id="oRename">Rename</button>' : ''}<div class="meta typepick" id="oTypes">${typeBadges(c.org_types)}</div></div>
    <div class="stagebar"><label class="label" for="stageSel">Pipeline stage</label><select id="stageSel"><option value="">Not in a pipeline</option>${stageOptions(c.pipeline_stage_id)}</select></div>
    <div class="stagebar divbox" id="divBox"></div>
    <div id="orgTimeline"></div>
    <div id="orgCrm"></div>
    <div id="fieldOrg"></div>
    <div id="orgRoutes"></div>
    <div id="orgAppts"></div>
    ${(escs.data || []).length ? `<div class="card flagcard"><h2>Open escalations</h2>${escs.data.map((e) => `<div class="person-row"><b>${esc(e.reason || 'Escalation')}</b>
      <div><small>${esc(userName(e.from_user))} → ${esc(userName(e.to_user))} · ${esc(fmtDate(e.created_at))}</small></div>${e.note ? `<div>${esc(e.note)}</div>` : ''}</div>`).join('')}</div>` : ''}
    <div class="split">
      <div>
        <div class="card" id="infoCard"></div>
        <div class="card"><div class="toolbar"><h2 style="margin:0;flex:1">People here (${people.length})</h2>${c.archived_at ? '' : '<button type="button" class="btn ghost small" id="linkPerson">+ Link a contact</button>'}</div>
          <div id="linkBox"></div>
          ${people.map((l) => {
            const p = l.people; const phone = l.work_phone || p.personal_cell; const email = l.work_email || p.personal_email;
            return `<div class="person-row"><b>${esc(fullName(p))}</b>
              <div><small>${esc([l.title, l.role].filter(Boolean).join(' · '))}</small></div>
              <div class="meta">${l.is_decision_maker ? '<span class="badge gold">Decision maker</span>' : ''}${l.is_primary_contact ? '<span class="badge">Primary</span>' : ''}${l.is_billing ? '<span class="badge billing">Billing</span>' : ''}${p.preferred_contact_method ? `<span class="badge">Prefers ${esc(p.preferred_contact_method)}</span>` : ''}</div>
              <div class="quick">${phone ? `<a class="btn secondary small" href="${telHref(phone)}">Call</a><a class="btn secondary small" href="sms:${digits(phone)}">Text</a>` : ''}${email ? `<a class="btn secondary small" href="mailto:${esc(email)}">Email</a>` : ''}
                <button class="btn ghost small" data-person="${p.id}">View person</button>${c.archived_at ? '' : `<button class="btn ghost small" data-unlink="${l.id}" data-who="${esc(fullName(p))}">Unlink</button>`}</div></div>`;
          }).join('') || '<p class="empty">No contacts yet.</p>'}
        </div>
        ${(referred.data || []).length ? `<div class="card"><h2>Leads referred (${referred.data.length})</h2>
          <div class="list">${referred.data.map((r) => `<button class="item" data-oid="${r.id}"><b>${esc(r.name)}</b><div class="meta">${typeBadges(r.org_types)}${r.pipeline_stage_id ? `<span class="badge stage">${esc(stageLabel(r.pipeline_stage_id))}</span>` : ''}</div></button>`).join('')}</div></div>` : ''}
        ${isAdmin() ? '<details class="card history" id="orgHist"><summary><h2>History</h2></summary><div id="orgHistBody"><p class="empty">Loading…</p></div></details>' : ''}
      </div>
      <div>
        <div class="card"><h2>Opportunities</h2>
          ${(opps.data || []).map((o) => `<div class="person-row"><b>${esc(o.service)}</b>
            <div class="row" style="margin-top:6px"><select data-opp="${o.id}">${statuses.map((s) => `<option ${s === o.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
            <small style="align-self:center">${o.owner_id ? 'Owner: ' + esc(userName(o.owner_id)) : ''}</small></div></div>`).join('') || '<p class="empty">No services logged yet.</p>'}
        </div>
        <div class="card" id="assetCard"><h2>Assets</h2><p class="empty">Loading…</p></div>
        <div class="card"><h2>Open follow-ups</h2>
          ${(tasks.data || []).map((t) => `<div class="person-row taskrow"><input type="checkbox" data-task="${t.id}" aria-label="Mark done: ${esc(t.title)}"> <button type="button" class="tasktitle" data-topen="${t.id}">${esc(t.title)}</button>
            <div><small class="${t.due_date && t.due_date <= today() ? 'badge due' : ''}">${esc([t.due_date ? 'Due ' + fmtDate(t.due_date) : '', t.assigned_to ? userName(t.assigned_to) : ''].filter(Boolean).join(' · '))}</small></div></div>`).join('') || '<p class="empty">Nothing open.</p>'}
          <details class="donebox" id="orgDone"><summary>Completed follow-ups</summary><div class="donebody"><p class="empty">Loading…</p></div></details>
        </div>
      </div>
    </div>
    <div id="orgMeasure"></div>
    <div id="orgPortal"></div>
    <div id="orgInvoices"></div>`;

  if ($('#linkPerson')) $('#linkPerson').onclick = () => linkPanel($('#linkBox'), { side: 'org', id, have: people.map((l) => l.person_id), done: () => viewOrg(main) });
  $$('[data-unlink]', main).forEach((b) => (b.onclick = () => unlinkContact(b.dataset.unlink, b.dataset.who, c.name, () => viewOrg(main))));
  const locked = leadIsSet(c) && !isAdmin();
  const info = () => {
    $('#infoCard').innerHTML = `<div class="toolbar"><h2 style="margin:0;flex:1">Details</h2>${c.archived_at ? '' : '<button class="btn ghost small" id="edit">Edit</button>'}</div>
      <dl class="kv">
        ${c.specialty ? `<dt>Specialty</dt><dd>${esc(c.specialty)}</dd>` : ''}
        ${addr ? `<dt>Address</dt><dd><a href="${mapHref(c.name + ', ' + addr)}" ${androidDevice() ? '' : 'target="_blank" rel="noopener"'}>${esc(addr)}</a></dd>` : ''}
        ${c.main_phone ? `<dt>Main phone</dt><dd><a href="${telHref(c.main_phone)}">${esc(c.main_phone)}</a></dd>` : ''}
        ${c.fax ? `<dt>Fax</dt><dd>${esc(c.fax)}</dd>` : ''}
        ${c.main_email ? `<dt>Email</dt><dd><a href="mailto:${esc(c.main_email)}">${esc(c.main_email)}</a></dd>` : ''}
        ${c.website ? `<dt>Website</dt><dd><a href="${esc(/^https?:/.test(c.website) ? c.website : 'https://' + c.website)}" target="_blank" rel="noopener">${esc(c.website)}</a></dd>` : ''}
        <dt>Owner (closer)</dt><dd>${esc(userName(c.owner_id)) || 'Unassigned'}</dd>
        <dt>Lead source</dt><dd>${esc(leadLabel(c, partnerName)) || '—'}${leadIsSet(c) ? ' <span class="lock" title="Locked">🔒</span>' : ''}${c.lead_source_channel ? `<br><small>${esc(c.lead_source_channel)}</small>` : ''}</dd>
        ${c.interest_level ? `<dt>Interest</dt><dd>${esc(c.interest_level)}</dd>` : ''}
        ${c.next_step ? `<dt>Next step</dt><dd>${esc(c.next_step)}</dd>` : ''}
        ${c.follow_up_date ? `<dt>Follow up</dt><dd>${esc(fmtDate(c.follow_up_date))}</dd>` : ''}
        ${c.last_contact_date ? `<dt>Last contact</dt><dd>${esc(fmtDate(c.last_contact_date))}</dd>` : ''}
        ${c.current_vendors ? `<dt>Current vendors</dt><dd>${esc(c.current_vendors)}</dd>` : ''}
        ${c.number_of_locations ? `<dt>Locations</dt><dd>${esc(c.number_of_locations)}</dd>` : ''}
        ${c.notes ? `<dt>Notes</dt><dd>${esc(c.notes).replace(/\n/g, '<br>')}</dd>` : ''}
      </dl>`;
    const e = $('#edit'); if (e) e.onclick = editInfo;
  };
  const F = [
    ['name', 'Name'], ['specialty', 'Specialty / category', 'specialty'], ['address', 'Street address'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'],
    ['main_phone', 'Main phone'], ['fax', 'Fax'], ['main_email', 'Main email'], ['website', 'Website'],
    ['interest_level', 'Interest', 'interest_level'], ['next_step', 'Next step'], ['follow_up_date', 'Follow-up date', 'date'],
    ['current_vendors', 'Current vendors / solutions'], ['number_of_locations', 'Number of locations', 'number'], ['notes', 'General notes', 'textarea'],
  ];
  const editInfo = () => {
    const types = [...(c.org_types || [])];
    const ls = { kind: !leadIsSet(c) ? 'none' : c.lead_source_partner_id ? 'external' : (c.lead_source_kind === 'self' && c.lead_source_id === S.me.id) ? 'self' : c.lead_source_id ? 'internal' : 'none',
      user_id: c.lead_source_id || '', partner_id: c.lead_source_partner_id || '', partner_label: partnerName, allowNone: !leadIsSet(c) || isAdmin() };
    $('#infoCard').innerHTML = `<h2>Edit</h2><form id="ef">
      <label class="label">Type</label>
      <div class="chips" id="eTypes">${[...new Set([...lk('org_type'), ...types])].map((t) => `<button type="button" class="chip ${types.includes(t) ? 'on' : ''}" data-type="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      ${F.map(([k, label, t]) => `<label class="label">${label}</label>${
        t === 'textarea' ? `<textarea name="${k}">${esc(c[k])}</textarea>` :
        t === 'date' ? `<input type="date" name="${k}" value="${esc(c[k])}">` :
        t === 'number' ? `<input type="text" inputmode="numeric" name="${k}" value="${esc(c[k])}">` :
        t ? `<select name="${k}">${options(t, c[k], '—')}</select>` :
        `<input type="text" name="${k}" value="${esc(c[k])}">`}`).join('')}
      <label class="label">Owner (closer)</label><select name="owner_id">${userOptions(c.owner_id)}</select>
      <label class="label">Lead source</label><div id="eLead"></div>
      <label class="label">How did it come in?</label><select name="lead_source_channel">${options('lead_channel', c.lead_source_channel, '—')}</select>
      <div class="actions"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" id="cancel">Cancel</button></div></form>`;
    leadPicker($('#eLead'), ls, { locked, lockedLabel: leadLabel(c, partnerName) });
    $$('#eTypes [data-type]').forEach((b) => (b.onclick = () => {
      const t = b.dataset.type; const i = types.indexOf(t);
      if (i >= 0) { if (types.length === 1) return toast('Pick at least one type'); types.splice(i, 1); } else types.push(t);
      b.classList.toggle('on');
    }));
    $('#cancel').onclick = info;
    $('#ef').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      for (const k in f) if (f[k] === '') f[k] = null;
      if (f.number_of_locations) f.number_of_locations = parseInt(f.number_of_locations, 10) || null;
      if (!f.name) return toast('Name is required');
      f.org_types = types;
      if (!locked) {
        const bad = leadValid(ls); if (bad) return toast(bad);
        const lf = leadFields(ls);
        const changed = (lf.lead_source_id || null) !== (c.lead_source_id || null) || (lf.lead_source_partner_id || null) !== (c.lead_source_partner_id || null)
          || (!!lf.lead_source_kind !== !!c.lead_source_kind);
        if (changed) Object.assign(f, lf);
      }
      const ownerChanged = f.owner_id !== c.owner_id;
      const { error } = await sb.from('companies').update(f).eq('id', id);
      if (error) return fail(error);
      if (ownerChanged && f.owner_id) await sb.from('opportunities').update({ owner_id: f.owner_id }).eq('company_id', id);
      // open proposals follow the organization's closer (their name is what the client sees)
      if (ownerChanged && f.owner_id && isAdmin()) await sb.from('proposals').update({ owner_id: f.owner_id }).eq('company_id', id).neq('status', 'accepted');
      FACETS = null;
      toast(ownerChanged ? `Assigned to ${userName(f.owner_id) || 'nobody'}` : 'Saved');
      renderShell();
    };
  };
  info();

  $('#back').onclick = () => go('orgs');
  FLD.orgExtras($('#fieldOrg'), c).catch(fail);
  RTE.orgCard($('#orgRoutes'), c.id).catch(() => {});
  DOC.orgBox($('#orgInvoices'), c).catch(() => {});
  MEA.orgBox($('#orgMeasure'), c).catch(() => {});
  PRT.orgBox($('#orgPortal'), c).catch(() => {});
  CAL.contactBox($('#orgAppts'), { company: c.id }).catch(() => {});
  PLN.crmClientCard($('#orgCrm'), c).catch(() => {});
  // rename right from the title: tap Rename, edit, Enter saves, Esc cancels
  if ($('#oRename')) $('#oRename').onclick = () => {
    const h = $('#oName'), btn = $('#oRename');
    h.innerHTML = `<input type="text" id="oNameIn" value="${esc(c.name)}" aria-label="Organization name" style="font:inherit;width:min(100%,420px)">`;
    btn.hidden = true;
    const inp = $('#oNameIn'); inp.focus(); inp.select();
    let busy = false, closed = false;
    const done = () => { closed = true; h.textContent = c.name; btn.hidden = false; };
    const save = async () => {
      if (busy || closed) return; const v = inp.value.trim();
      if (!v) return toast('Name is required');
      if (v === c.name) return done();
      busy = true;
      const { error } = await sb.from('companies').update({ name: v }).eq('id', id);
      busy = false;
      if (error) return fail(error);
      c.name = v; FACETS = null; done(); toast('Renamed');
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') done(); };
    inp.onblur = () => { if (!busy && !closed) save(); };
  };
  typePicker($('#oTypes'), c.org_types || [], lk('org_type'), !c.archived_at && FLD.can('contacts', 2), async (next) => {
    const { error } = await sb.from('companies').update({ org_types: next }).eq('id', id); if (error) { fail(error); return false; } c.org_types = next; });
  GRW.timelineBox($('#orgTimeline'), { company: c.id, leadSource: c.lead_source_channel, canAdd: !c.archived_at, onNote: () => sb.from('companies').update({ last_contact_date: today() }).eq('id', id) }).catch(() => {});
  divPicker($('#divBox'), c.divisions, async (next) => {
    const { error } = await sb.from('companies').update({ divisions: next }).eq('id', id); if (error) { fail(error); return false; }
    // the people here follow the organization unless they're already shared wider
    await sb.from('people').update({ divisions: next }).in('id', people.map((l) => l.person_id)).eq('divisions', '{}');
    toast(next.length ? 'Saved' : 'Shared with every company');
  });
  renderAssets($('#assetCard'), c);
  const stageSel = $('#stageSel');
  stageSel.disabled = !!c.archived_at;
  stageSel.onchange = async () => {
    const { error } = await sb.from('companies').update({ pipeline_stage_id: stageSel.value || null }).eq('id', id);
    error ? fail(error) : toast('Stage updated');
  };
  $$('[data-person]').forEach((b) => (b.onclick = () => go('people', b.dataset.person)));
  $$('[data-oid]').forEach((b) => (b.onclick = () => go('org', b.dataset.oid)));
  $$('[data-opp]').forEach((s) => (s.onchange = async () => {
    const { error } = await sb.from('opportunities').update({ status: s.value }).eq('id', s.dataset.opp);
    error ? fail(error) : toast('Status updated');
  }));
  wireTasks(main);
  doneList($('#orgDone'), { company: id });
  const hist = $('#orgHist');
  if (hist) hist.ontoggle = async () => {
    if (!hist.open || hist.dataset.loaded) return;
    hist.dataset.loaded = '1';
    const { data, error } = await sb.from('audit_log').select('*').eq('org_id', id).order('at', { ascending: false }).limit(200);
    $('#orgHistBody').innerHTML = error ? `<p class="empty">${esc(error.message)}</p>` : historyList(data, { showRecord: true });
  };
  const rb = $('#restoreBtn');
  if (rb) rb.onclick = async () => { const { error } = await sb.rpc('restore_record', { p_entity: 'companies', p_id: id }); error ? fail(error) : (toast('Restored'), renderShell()); };
  if (c.archived_at) return;
  $('#addPeople').onclick = () => go('add', id);
  if ($('#propBtn')) $('#propBtn').onclick = () => openProposalFor(id);
  $('#moreBtn').onclick = () => { const m = $('#moreBox'); m.hidden = !m.hidden; $('#moreBtn').setAttribute('aria-expanded', String(!m.hidden)); };
  $('#escBtn').onclick = () => escalatePanel($('#panel'), c);
  $('#delBtn').onclick = () => deletePanel($('#panel'), 'companies', id, c.name);
  $('#dupBtn').onclick = () => dupPanel($('#panel'), 'companies', id, c.name);
  $('#logoBtn').onclick = () => uploadLogo(c);
}

/* ---------- assets on an organization: its logo, proposals and listings, plus links and files you add ---------- */
const ASSET_KINDS = { proposal: 'Proposal page', website: 'Website', funnel: 'Funnel', logo: 'Logo', document: 'Document', design: 'Design', link: 'Link' };
async function renderAssets(box, c) {
  if (!box) return;
  const [{ data: rows }, { data: props }, { data: lists }] = await Promise.all([
    sb.from('company_assets').select('*').eq('company_id', c.id).is('archived_at', null).order('created_at', { ascending: false }),
    sb.from('proposals').select('id,name,status,version,share_token,updated_at').eq('company_id', c.id).order('updated_at', { ascending: false }),
    sb.from('directory_listings').select('id,status,directories(name,slug)').eq('company_id', c.id).is('archived_at', null),
  ]);
  const item = (icon, title, sub, links) => `<div class="assetrow"><span class="aicon" aria-hidden="true">${icon}</span><div style="flex:1;min-width:0"><b>${title}</b>${sub ? `<small class="hint" style="margin:0">${sub}</small>` : ''}</div><div class="alinks">${links}</div></div>`;
  const ext = (u) => `<a class="btn ghost small" href="${esc(u)}" target="_blank" rel="noopener">Open</a>`;
  const ICON = { proposal: '📄', website: '🌐', funnel: '🧭', logo: '🖼️', document: '📎', design: '🎨', link: '🔗' };
  const auto = [
    c.logo?.url ? item('🖼️', 'Logo', 'Current logo on file', ext(c.logo.url)) : '',
    ...(props || []).map((p) => item('📄', `${esc(p.name || 'CRM proposal')}${p.version ? ' v' + p.version : ''}`, `${esc(PSTATUS[p.status] || p.status)} · updated ${esc(fmtDate(p.updated_at))}`,
      `<button type="button" class="btn ghost small" data-aprop="${p.id}">Open</button>${p.version ? `<button type="button" class="btn ghost small" data-acopy="${esc(proposalLink(p.share_token))}">Copy client link</button>` : ''}`)),
    ...(lists || []).map((l) => item('☰', `Directory listing: ${esc(l.directories?.name || '')}`, esc(l.status), l.directories?.slug ? ext(`${S.pub()}/directory/?d=${encodeURIComponent(l.directories.slug)}#l=${l.id}`) : '')),
  ].filter(Boolean);
  const mine = (rows || []).map((a) => item(ICON[a.kind] || '🔗', esc(a.title), `${esc(ASSET_KINDS[a.kind] || 'Link')}${a.note ? ' · ' + esc(a.note) : ''} · added ${esc(fmtDate(a.created_at))}${a.created_by ? ' by ' + esc(userName(a.created_by)) : ''}`,
    `${ext(a.url)}<button type="button" class="btn ghost small" data-acopy="${esc(a.url)}">Copy link</button><button type="button" class="btn ghost small danger" data-arm="${a.id}">Remove</button>`));
  box.innerHTML = `<div class="toolbar"><h2 style="margin:0;flex:1">Assets</h2>${c.archived_at ? '' : '<button type="button" class="btn ghost small" id="aAdd">+ Add</button>'}</div>
    <div class="aform" id="aForm" hidden>
      <div class="row"><div><label class="label" for="aKind">Type</label><select id="aKind">${Object.entries(ASSET_KINDS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        <div><label class="label" for="aTitle">Name</label><input type="text" id="aTitle" maxlength="200" placeholder="e.g. First step proposal page"></div></div>
      <label class="label" for="aUrl">Link</label><input type="url" id="aUrl" placeholder="https://…">
      <small class="hint" style="margin:2px 0 6px">Or upload a file instead of a link: <button type="button" class="linkish" id="aFile">choose a file</button> (images and PDFs, under 10 MB)</small>
      <label class="label" for="aNote">Note (optional)</label><input type="text" id="aNote" maxlength="200">
      <div class="actions"><button type="button" class="btn small" id="aSave">Save</button><button type="button" class="btn ghost small" id="aCancel">Cancel</button></div></div>
    ${auto.length || mine.length ? `<div class="assetlist">${[...mine, ...auto].join('')}</div>` : '<p class="empty">No assets yet. Add proposal pages, sites, logos and files so the whole team can find them here.</p>'}`;
  const f = $('#aForm', box);
  if ($('#aAdd', box)) $('#aAdd', box).onclick = () => { f.hidden = !f.hidden; if (!f.hidden) $('#aTitle', box).focus(); };
  if ($('#aCancel', box)) $('#aCancel', box).onclick = () => { f.hidden = true; };
  let uploaded = null;
  if ($('#aFile', box)) $('#aFile', box).onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp,image/gif,application/pdf';
    inp.onchange = async () => {
      const file = inp.files[0]; if (!file) return;
      if (file.size > 10 * 1024 * 1024) return toast('Files must be under 10 MB');
      const pdf = file.type === 'application/pdf', e2 = ((file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'bin';
      const path = `${c.tenant_id}/companies/${c.id}/assets/${Date.now()}.${e2}`;
      toast('Uploading…');
      const up = await sb.storage.from('media').upload(path, file, { contentType: file.type, upsert: false });
      if (up.error) return fail(up.error);
      const url = sb.storage.from('media').getPublicUrl(path).data.publicUrl;
      const { data: m, error } = await sb.from('media').insert({ path, url, kind: pdf ? 'file' : 'photo', entity: 'companies', entity_id: c.id, title: file.name, mime: file.type, bytes: file.size }).select('id').single();
      if (error) return fail(error);
      uploaded = m.id; $('#aUrl', box).value = url;
      if (!$('#aTitle', box).value.trim()) $('#aTitle', box).value = file.name.replace(/\.[^.]+$/, '');
      if (!pdf && $('#aKind', box).value === 'link') $('#aKind', box).value = 'logo';
      if (pdf && $('#aKind', box).value === 'link') $('#aKind', box).value = 'document';
      toast('Uploaded. Save to add it.');
    };
    inp.click();
  };
  if ($('#aSave', box)) $('#aSave', box).onclick = async () => {
    const title = $('#aTitle', box).value.trim(), url = $('#aUrl', box).value.trim();
    if (!title) return toast('Give it a name');
    if (!/^https:\/\/\S+\.\S+/i.test(url)) return toast('Enter a full link starting with https://, or upload a file');
    const { error } = await sb.from('company_assets').insert({ company_id: c.id, tenant_id: c.tenant_id, kind: $('#aKind', box).value, title, url, media_id: uploaded, note: $('#aNote', box).value.trim() || null });
    if (error) return fail(error);
    toast('Added'); renderAssets(box, c);
  };
  $$('[data-arm]', box).forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this from the list? It stays in the history.')) return;
    const { error } = await sb.from('company_assets').update({ archived_at: new Date().toISOString(), archived_by: S.me.id }).eq('id', b.dataset.arm);
    if (error) return fail(error); toast('Removed'); renderAssets(box, c);
  }));
  $$('[data-aprop]', box).forEach((b) => (b.onclick = () => go('proposal', b.dataset.aprop)));
  $$('[data-acopy]', box).forEach((b) => (b.onclick = () => copyText(b.dataset.acopy)));
}

/* ---------- logos (kept forever; a new upload becomes the current logo) ---------- */
function uploadLogo(c) {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp,image/gif';
  input.onchange = async () => {
    const file = input.files[0]; if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast('Logo must be under 5 MB');
    const ext = ((file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'png';
    const path = `${c.tenant_id}/companies/${c.id}/logo-${Date.now()}.${ext}`;
    toast('Uploading…');
    const up = await sb.storage.from('media').upload(path, file, { contentType: file.type, upsert: false });
    if (up.error) return fail(up.error);
    const url = sb.storage.from('media').getPublicUrl(path).data.publicUrl;
    const { data: m, error } = await sb.from('media').insert({ path, url, kind: 'logo', entity: 'companies', entity_id: c.id, title: file.name, mime: file.type, bytes: file.size }).select('id').single();
    if (error) return fail(error);
    const r = await sb.from('companies').update({ logo_media_id: m.id }).eq('id', c.id);
    r.error ? fail(r.error) : (toast('Logo saved'), renderShell());
  };
  input.click();
}

/* ---------- history (audit log) ---------- */
const NOUN = { companies: 'organization', people: 'person', company_people: 'contact link', opportunities: 'opportunity', activities: 'note',
  tasks: 'follow-up', escalations: 'escalation', review_items: 'review item', app_users: 'user', lookup_values: 'list item',
  invites: 'invite', media: 'logo', vendors: 'vendor', vendor_companies: 'vendor assignment', tenants: 'account',
  proposal_settings: 'pricing setting', proposal_price_book: 'price', suggestions: 'suggestion' };
const HIDE_FIELDS = new Set(['id', 'tenant_id', 'created_at', 'updated_at', 'created_by']);
const UUIDRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function histVal(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ') || '—';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  if (UUIDRE.test(s)) return userName(s) || 'a record';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return fmtDate(s);
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}
function historyLine(e, { showRecord = true } = {}) {
  const who = (e.actor_name || (e.via === 'system' ? 'System' : 'Someone')) + (e.via === 'claude' ? ' (via Claude)' : '');
  const verb = { insert: 'added', update: 'changed', delete: 'deleted' }[e.action];
  const what = (NOUN[e.table_name] || e.table_name) + (showRecord && e.label ? ` “${e.label}”` : '');
  let detail = '';
  if (e.action === 'update' && e.changes) {
    detail = Object.entries(e.changes).filter(([k]) => !HIDE_FIELDS.has(k))
      .map(([k, [a, b]]) => `<li>${esc(k.replace(/_/g, ' '))}: ${esc(histVal(a))} → ${esc(histVal(b))}</li>`).join('');
    if (detail) detail = `<ul>${detail}</ul>`;
  }
  return `<div class="entry"><small>${esc(new Date(e.at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }))}</small>
    <div><b>${esc(who)}</b> ${verb} ${esc(what)}</div>${detail}</div>`;
}
const historyList = (rows, opts) => (rows || []).length ? `<div class="timeline">${rows.map((e) => historyLine(e, opts)).join('')}</div>` : '<p class="empty">No history yet.</p>';

/* ---------- panels: escalate, delete, flag duplicate ---------- */
function escalatePanel(box, c) {
  const manager = S.me.manager_id && staff().some((u) => u.id === S.me.manager_id) ? S.me.manager_id : '';
  box.innerHTML = `<div class="card panel"><h2>Escalate ${esc(c.name)}</h2>
    <label class="label">Send to</label><select id="escTo">${userOptions(manager, 'Pick a person…', S.me.id)}</select>
    ${manager ? '<small class="hint">Defaults to your manager. Change it if this needs someone else.</small>' : '<small class="hint">You don\'t have a manager set yet, so pick who should get this.</small>'}
    <label class="label">Reason</label><select id="escReason">${options('escalation_reason', '', 'Choose…')}</select>
    <label class="label">Note</label><textarea id="escNote" placeholder="What's going on and what you need"></textarea>
    <div class="actions"><button class="btn" id="escSend">Send escalation</button><button class="btn ghost" id="escX">Cancel</button></div></div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#escX').onclick = () => (box.innerHTML = '');
  $('#escSend').onclick = async () => {
    const to = $('#escTo').value, reason = $('#escReason').value, note = $('#escNote').value.trim();
    if (!to) return toast('Pick who to send it to');
    if (!reason) return toast('Pick a reason');
    const { error } = await sb.from('escalations').insert({ company_id: c.id, to_user: to, reason, note: [c.notePrefix, note].filter(Boolean).join('\n') || null });
    if (error) return fail(error);
    toast(`Escalated to ${userName(to)}`); renderShell();
  };
}

function deletePanel(box, entity, id, name) {
  box.innerHTML = `<div class="card panel danger"><h2>Delete ${esc(name)}?</h2>
    <p class="empty">${isAdmin() ? 'It moves to the archive. Nothing is ever destroyed, and you can restore it any time.' : 'This goes to an admin for approval. Until then it\'s hidden. Nothing is ever destroyed.'}</p>
    <label class="label">Why are you deleting it?</label><textarea id="delReason" placeholder="Duplicate, closed down, entered by mistake…"></textarea>
    <div class="actions"><button class="btn dangerbtn" id="delGo">${isAdmin() ? 'Archive it' : 'Request delete'}</button><button class="btn ghost" id="delX">Cancel</button></div></div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#delX').onclick = () => (box.innerHTML = '');
  $('#delGo').onclick = async () => {
    const reason = $('#delReason').value.trim(); if (!reason) return toast('A reason is required');
    const { data, error } = await sb.rpc('request_delete', { p_entity: entity, p_id: id, p_reason: reason });
    if (error) return fail(error);
    FACETS = null;
    toast(data === 'pending' ? 'Sent to an admin for approval' : 'Moved to the archive');
    go(entity === 'companies' ? 'orgs' : 'people');
  };
}

function dupPanel(box, entity, id, name) {
  box.innerHTML = `<div class="card panel"><h2>Flag ${esc(name)} as a duplicate</h2>
    <p class="empty">Find the record it duplicates. An admin will review and decide whether to merge them.</p>
    <input type="search" id="dupQ" placeholder="Search ${entity === 'companies' ? 'organizations' : 'people'}" autocomplete="off"><div id="dupRes"></div>
    <label class="label">Note (optional)</label><input type="text" id="dupNote">
    <div class="actions"><button class="btn ghost" id="dupX">Cancel</button></div></div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#dupX').onclick = () => (box.innerHTML = '');
  $('#dupQ').oninput = debounce(async (e) => {
    const term = clean(e.target.value); const res = $('#dupRes');
    if (term.length < 2) return (res.innerHTML = '');
    const q = entity === 'companies'
      ? sb.from('companies').select('id,name,city,state').is('archived_at', null).neq('id', id).ilike('name', `%${term}%`).limit(8)
      : sb.from('people').select('id,first_name,last_name,personal_cell').is('archived_at', null).neq('id', id).or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%`).limit(8);
    const { data } = await q;
    res.innerHTML = `<div class="results">${(data || []).map((r) => `<button class="result" data-did="${r.id}"><b>${esc(r.name || fullName(r))}</b><small>${esc(r.city ? [r.city, r.state].filter(Boolean).join(', ') : r.personal_cell || '')}</small></button>`).join('') || '<p class="empty" style="padding:10px">No matches.</p>'}</div>`;
    $$('[data-did]', res).forEach((b) => (b.onclick = async () => {
      const { error } = await sb.rpc('flag_duplicate', { p_entity: entity, p_id: id, p_other: b.dataset.did, p_note: $('#dupNote').value });
      if (error) return fail(error);
      box.innerHTML = ''; toast('Flagged for admin review'); refreshCounts();
    }));
  });
}

/* ================= PEOPLE ================= */
let peopleQ = '';
// Link an existing person and organization (from either side). opts: { side: 'org' | 'person', id, have: [ids already linked], done }
function linkPanel(box, opts) {
  const org = opts.side === 'org';
  box.innerHTML = `<div class="panel" style="margin:8px 0"><label class="label" for="lkQ">${org ? 'Find a person' : 'Find ' + esc(FLD.l('organization'))}</label>
    <input type="search" id="lkQ" placeholder="${org ? 'Name or email' : 'Name'}" autocomplete="off"><div id="lkRes" class="list" style="margin-top:6px"></div>
    <div id="lkForm"></div><div class="actions"><button type="button" class="btn ghost small" id="lkX">Cancel</button></div></div>`;
  $('#lkX', box).onclick = () => (box.innerHTML = '');
  const pick = (targetId, label) => {
    $('#lkRes', box).innerHTML = ''; $('#lkQ', box).value = label;
    $('#lkForm', box).innerHTML = `<div class="row"><div><label class="label">Title there</label><input type="text" id="lkTitle" placeholder="Practice Manager"></div>
        <div><label class="label">Work email</label><input type="email" id="lkEmail"></div></div>
      <label class="check"><input type="checkbox" id="lkDm"> Decision maker</label>
      <label class="check"><input type="checkbox" id="lkPri"> Primary contact</label>
      <label class="check"><input type="checkbox" id="lkBill"> Billing contact</label>
      <div class="actions"><button type="button" class="btn small" id="lkGo">Link them</button></div>`;
    $('#lkGo', box).onclick = async () => {
      const row = { company_id: org ? opts.id : targetId, person_id: org ? targetId : opts.id, title: $('#lkTitle', box).value.trim() || null,
        work_email: $('#lkEmail', box).value.trim() || null, is_decision_maker: $('#lkDm', box).checked, is_primary_contact: $('#lkPri', box).checked, is_billing: $('#lkBill', box).checked };
      const { error } = await sb.from('company_people').insert(row); if (error) return fail(error);
      toast('Linked'); opts.done();
    };
  };
  const run = debounce(async () => {
    const term = clean($('#lkQ', box).value);
    if (term.length < 2) { $('#lkRes', box).innerHTML = ''; return; }
    const like = `%${term}%`, tok = `%${term.split(/\s+/)[0]}%`;   // "Thomas Kramer": search on Thomas, then match the whole name
    const { data } = org
      ? await sb.from('people').select('id,first_name,last_name,personal_email').is('archived_at', null)
          .or(`first_name.ilike.${tok},last_name.ilike.${tok},personal_email.ilike.${tok}`).limit(40)
      : await sb.from('companies').select('id,name,city,state').is('archived_at', null).ilike('name', like).order('name').limit(10);
    const low = term.toLowerCase();
    const rows = (data || []).filter((r) => !(opts.have || []).includes(r.id) && (!org || `${fullName(r)} ${r.personal_email || ''}`.toLowerCase().includes(low))).slice(0, 10);
    $('#lkRes', box).innerHTML = rows.map((r) => org
      ? `<button type="button" class="item" data-lk="${r.id}" data-lbl="${esc(fullName(r))}"><b>${esc(fullName(r))}</b><small>${esc(r.personal_email || '')}</small></button>`
      : `<button type="button" class="item" data-lk="${r.id}" data-lbl="${esc(r.name)}"><b>${esc(r.name)}</b><small>${esc([r.city, r.state].filter(Boolean).join(', '))}</small></button>`).join('')
      || `<p class="empty">No match${org ? '. Add new people with "+ Contacts / visit".' : '.'}</p>`;
    $$('[data-lk]', box).forEach((b) => (b.onclick = () => pick(b.dataset.lk, b.dataset.lbl)));
  });
  $('#lkQ', box).oninput = run; $('#lkQ', box).focus();
}
async function unlinkContact(linkId, who, where, done) {
  if (!confirm(`Take ${who} off ${where}? Neither record is deleted, only the link between them.`)) return;
  const { error } = await sb.from('company_people').delete().eq('id', linkId); if (error) return fail(error);
  toast('Unlinked'); done();
}

async function viewPeople(main) {
  if (S.param) return viewPerson(main, S.param);
  main.innerHTML = `<h1>${esc(FLD.L('person', true))}</h1>
    <div class="toolbar"><input type="search" id="pq" placeholder="Search name, phone, email or title (try “CEO”)" value="${esc(peopleQ)}"><button type="button" class="btn ghost small" id="pBulk">Filter and bulk</button></div>
    <div class="list" id="plist"></div>`;
  const load = async () => {
    const term = clean(peopleQ); const box = $('#plist');
    if (term.length < 2) return (box.innerHTML = '<p class="empty">Type at least 2 letters. Searching a title like “CEO” or “Office Manager” shows every person with that title, at each organization.</p>');
    const words = term.split(/\s+/);
    const pOr = [`first_name.ilike.%${term}%`, `last_name.ilike.%${term}%`, `personal_email.ilike.%${term}%`];
    if (words.length >= 2) pOr.push(`and(first_name.ilike.${words[0]}%,last_name.ilike.${words.slice(1).join(' ')}%)`);
    if (digits(term).length >= 4) pOr.push(`personal_cell.ilike.%${digits(term).slice(-4)}%`);
    const sel = 'id,title,role,is_decision_maker,company_id,companies(name,archived_at),people!inner(*)';
    const [byLink, byPerson] = await Promise.all([
      sb.from('company_people').select(sel).is('people.archived_at', null).or(`title.ilike.%${term}%,role.ilike.%${term}%,work_email.ilike.%${term}%`).limit(100),
      divQ(sb.from('people').select('*,company_people(id,title,role,is_decision_maker,company_id,companies(name,archived_at))').is('archived_at', null).or(pOr.join(','))).limit(100),
    ]);
    const rows = new Map();
    const liveLink = (l) => l.companies && !l.companies.archived_at;
    (byLink.data || []).filter(liveLink).forEach((l) => rows.set(l.id, { p: l.people, l }));
    (byPerson.data || []).forEach((p) => {
      const ls = (p.company_people || []).filter(liveLink);
      if (!ls.length) rows.set('p' + p.id, { p, l: null });
      ls.forEach((l) => rows.set(l.id, { p, l }));
    });
    const list = [...rows.values()].sort((a, b) => fullName(a.p).localeCompare(fullName(b.p)));
    box.innerHTML = list.map(({ p, l }) => `<button class="item" data-pid="${p.id}"><b>${esc(fullName(p))}</b>
      <small>${esc(l ? [l.title || l.role, l.companies?.name].filter(Boolean).join(' · ') : 'Not linked to an organization')}</small>
      ${(() => { const ty = (p.person_types || []).filter((t) => t !== 'Contact'); return l?.is_decision_maker || ty.length ? `<div class="meta">${typeBadges(ty)}${l?.is_decision_maker ? '<span class="badge gold">Decision maker</span>' : ''}</div>` : ''; })()}</button>`).join('') || '<p class="empty">No one matches.</p>';
    $$('#plist [data-pid]').forEach((b) => (b.onclick = () => go('people', b.dataset.pid)));
  };
  $('#pq').oninput = debounce((e) => { peopleQ = e.target.value; load(); });
  $('#pBulk').onclick = () => go('contactlist');
  load();
}

async function viewPerson(main, pid) {
  const [{ data: p }, { data: allLinks }] = await Promise.all([
    sb.from('people').select('*').eq('id', pid).maybeSingle(),
    sb.from('company_people').select('*, companies(id,name,owner_id,city,state,org_types,archived_at)').eq('person_id', pid),
  ]);
  if (!p) { main.innerHTML = '<p class="empty">Not found. They may have been deleted.</p>'; return; }
  const links = (allLinks || []).filter((l) => l.companies && !l.companies.archived_at);
  const show = () => {
    main.innerHTML = `<div class="toolbar"><button class="btn ghost small" id="back">← ${esc(FLD.L('person', true))}</button><div style="flex:1"></div>
      ${p.archived_at ? '' : '<button class="btn ghost small" id="moreBtn">More ▾</button>'}</div>
    <div class="morebox" id="moreBox" hidden><button class="btn ghost small" id="dupBtn">Flag as duplicate</button><button class="btn ghost small danger" id="delBtn">Delete…</button></div>
    ${p.archived_at ? `<div class="banner warn"><b>${p.archive_status === 'pending' ? 'Delete requested, waiting on admin approval' : 'Archived'}</b><span>${esc(p.archive_reason || '')}</span>
      ${isAdmin() ? '<button class="btn small" id="restoreBtn">Restore</button>' : ''}</div>` : ''}
    <div id="panel"></div>
    <div class="titlerow"><h1>${esc(fullName(p))}</h1>${p.archived_at ? '' : '<button type="button" class="linkish small" id="pRename">Rename</button>'}</div>
    <div class="chips typepick" id="pTypes"></div>
    <div class="stagebar divbox" id="pDivBox"></div>
    <div id="pTimeline"></div>
    <div class="split"><div class="card" id="pcard">
      <div class="toolbar"><h2 style="margin:0;flex:1">Personal info</h2>${p.archived_at ? '' : '<button class="btn ghost small" id="pedit">Edit</button>'}</div>
      <dl class="kv">
        <dt>Cell</dt><dd>${p.personal_cell ? `<a href="${telHref(p.personal_cell)}">${esc(p.personal_cell)}</a>` : '—'}</dd>
        <dt>Email</dt><dd>${p.personal_email ? `<a href="mailto:${esc(p.personal_email)}">${esc(p.personal_email)}</a>` : '—'}</dd>
        <dt>Prefers</dt><dd>${esc(p.preferred_contact_method) || '—'}</dd>
        ${p.notes ? `<dt>Notes</dt><dd>${esc(p.notes)}</dd>` : ''}
      </dl>
      <div class="quick">${p.personal_cell ? `<a class="btn secondary small" href="${telHref(p.personal_cell)}">Call</a><a class="btn secondary small" href="sms:${digits(p.personal_cell)}">Text</a>` : ''}${p.personal_email ? `<a class="btn secondary small" href="mailto:${esc(p.personal_email)}">Email</a>` : ''}</div>
    </div>
    <div class="card" id="pCF" hidden></div>
    <div id="pAppts"></div>
    <div class="card"><div class="toolbar"><h2 style="margin:0;flex:1">${esc(FLD.L('organization', true))} (${links.length})</h2>${p.archived_at ? '' : `<button type="button" class="btn ghost small" id="linkOrg">+ Link to ${esc(FLD.l('organization'))}</button>`}</div>
      <div id="linkBox"></div>
      ${links.map((l) => `<div class="person-row"><b>${esc(l.companies?.name)}</b> <span class="meta inline">${typeBadges(l.companies?.org_types)}</span>
        <div><small>${esc([l.title, l.role].filter(Boolean).join(' · '))}</small></div>
        <div class="meta">${l.is_decision_maker ? '<span class="badge gold">Decision maker</span>' : ''}${l.is_primary_contact ? '<span class="badge">Primary</span>' : ''}${l.is_billing ? '<span class="badge billing">Billing</span>' : ''}${l.companies?.owner_id ? `<span class="badge">Owner: ${esc(userName(l.companies.owner_id))}</span>` : ''}</div>
        <div class="quick"><button class="btn ghost small" data-cid="${l.company_id}">Open</button>${p.archived_at ? '' : `<button class="btn ghost small" data-link="${l.id}">Edit role here</button><button class="btn ghost small" data-unlink="${l.id}" data-where="${esc(l.companies?.name || '')}">Unlink</button>`}</div></div>`).join('') || '<p class="empty">Not linked to an organization.</p>'}
    </div></div>`;
    $('#back').onclick = () => go('people');
    GRW.timelineBox($('#pTimeline'), { person: pid, leadSource: p.lead_source, canAdd: !p.archived_at }).catch(() => {});
    typePicker($('#pTypes'), p.person_types?.length ? p.person_types : ['Contact'], personTypes(), !p.archived_at && FLD.can('contacts', 2), async (next) => {
      const { error } = await sb.from('people').update({ person_types: next }).eq('id', pid); if (error) { fail(error); return false; } p.person_types = next; });
    CAL.contactBox($('#pAppts'), { person: pid }).catch(() => {});
    FLD.customFieldsBox($('#pCF'), 'people', p, async (custom) => { const { error } = await sb.from('people').update({ custom }).eq('id', pid); if (error) { fail(error); return false; } p.custom = custom; }, !p.archived_at).catch(fail);
    divPicker($('#pDivBox'), p.divisions, async (next) => { const { error } = await sb.from('people').update({ divisions: next }).eq('id', pid); if (error) { fail(error); return false; } p.divisions = next; toast('Saved'); });
    $$('[data-cid]').forEach((b) => (b.onclick = () => go('org', b.dataset.cid)));
    $$('[data-link]').forEach((b) => (b.onclick = () => editLink(links.find((l) => l.id === b.dataset.link), b.closest('.person-row'))));
    if ($('#linkOrg')) $('#linkOrg').onclick = () => linkPanel($('#linkBox'), { side: 'person', id: pid, have: (allLinks || []).map((l) => l.company_id), done: () => viewPerson(main, pid) });
    $$('[data-unlink]', main).forEach((b) => (b.onclick = () => unlinkContact(b.dataset.unlink, fullName(p), b.dataset.where, () => viewPerson(main, pid))));
    const rb = $('#restoreBtn');
    if (rb) rb.onclick = async () => { const { error } = await sb.rpc('restore_record', { p_entity: 'people', p_id: pid }); error ? fail(error) : (toast('Restored'), renderShell()); };
    if (p.archived_at) return;
    $('#moreBtn').onclick = () => { const m = $('#moreBox'); m.hidden = !m.hidden; };
    $('#delBtn').onclick = () => deletePanel($('#panel'), 'people', pid, fullName(p));
    $('#dupBtn').onclick = () => dupPanel($('#panel'), 'people', pid, fullName(p));
    // Rename at the top opens the personal info editor with the first name ready
    $('#pRename').onclick = () => { $('#pedit').click(); $('#pcard').scrollIntoView({ block: 'center', behavior: 'smooth' }); };
    $('#pedit').onclick = () => {
      $('#pcard').innerHTML = `<h2>Edit personal info</h2><form id="pf">
        <div class="row"><div><label class="label">First name</label><input type="text" name="first_name" value="${esc(p.first_name)}" required></div>
        <div><label class="label">Last name</label><input type="text" name="last_name" value="${esc(p.last_name)}"></div></div>
        <label class="label">Personal cell</label><input type="tel" name="personal_cell" value="${esc(p.personal_cell)}">
        <label class="label">Personal email</label><input type="email" name="personal_email" value="${esc(p.personal_email)}">
        <label class="label">Preferred contact</label><select name="preferred_contact_method">${options('preferred_contact', p.preferred_contact_method, '—')}</select>
        <label class="label">Notes</label><textarea name="notes">${esc(p.notes)}</textarea>
        <div class="actions"><button class="btn">Save</button><button class="btn ghost" type="button" id="pc">Cancel</button></div></form>`;
      $('#pc').onclick = show;
      const fn = $('#pf [name=first_name]'); fn.focus(); fn.select();
      $('#pf').onsubmit = async (e) => {
        e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); for (const k in f) if (f[k] === '') f[k] = null;
        const { error } = await sb.from('people').update(f).eq('id', pid); if (error) return fail(error);
        Object.assign(p, f); toast('Saved'); show();
      };
    };
  };
  const editLink = (l, row) => {
    row.innerHTML = `<b>${esc(l.companies?.name)}</b><form class="lf">
      <label class="label">Title here</label><input type="text" name="title" value="${esc(l.title)}">
      <label class="label">Role here</label><select name="role">${options('contact_role', l.role, '—')}</select>
      <div class="row"><div><label class="label">Work phone</label><input type="tel" name="work_phone" value="${esc(l.work_phone)}"></div>
      <div><label class="label">Work email</label><input type="email" name="work_email" value="${esc(l.work_email)}"></div></div>
      <label class="check"><input type="checkbox" name="is_decision_maker" ${l.is_decision_maker ? 'checked' : ''}> Decision maker</label>
      <label class="check"><input type="checkbox" name="is_primary_contact" ${l.is_primary_contact ? 'checked' : ''}> Primary contact</label>
      <label class="check"><input type="checkbox" name="is_billing" ${l.is_billing ? 'checked' : ''}> Billing contact</label>
      <div class="actions"><button class="btn small">Save</button></div></form>`;
    $('form', row).onsubmit = async (e) => {
      e.preventDefault(); const fd = new FormData(e.target);
      const f = { title: fd.get('title') || null, role: fd.get('role') || null, work_phone: fd.get('work_phone') || null, work_email: fd.get('work_email') || null,
        is_decision_maker: fd.has('is_decision_maker'), is_primary_contact: fd.has('is_primary_contact'), is_billing: fd.has('is_billing') };
      const { error } = await sb.from('company_people').update(f).eq('id', l.id); if (error) return fail(error);
      Object.assign(l, f); toast('Saved'); show();
    };
  };
  show();
}

/* ================= DASHBOARD, GET STARTED, TOOLS ================= */
const isGelpAcct = () => S.acct?.is_gelp !== false;
// start of today, this week (Monday), month, quarter or year, local time
function periodStart(k) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (k === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (k === 'month') d.setDate(1);
  if (k === 'quarter') { d.setDate(1); d.setMonth(Math.floor(d.getMonth() / 3) * 3); }
  if (k === 'year') { d.setMonth(0, 1); }
  return d;
}
const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['quarter', 'This quarter'], ['year', 'This year']];
let dashPeriod = recall('dashPeriod', { v: 'month' }).v;
async function viewDashboard(main) {
  const t = today(), gelp = isGelpAcct() && !isFree();
  const tq = sb.from('tasks').select('id,due_date', { count: 'exact' }).eq('done', false).eq('assigned_to', S.me.id).lte('due_date', t).limit(500);
  const cq = sb.from('companies').select('id', { count: 'exact', head: true }).is('archived_at', null);
  const pq = isFree() ? Promise.resolve({ data: [] }) : sb.from('companies').select('pipeline_stage_id').is('archived_at', null).not('pipeline_stage_id', 'is', null).limit(10000);
  const prq = gelp ? sb.from('proposals').select('id,status,owner_id,version,accepted_version,accepted_at,companies(name)').in('status', ['sent', 'accepted']).limit(2000) : Promise.resolve({ data: [] });
  const [{ data: due, error }, { count: orgN }, { data: cos }, { data: props }] = await Promise.all([tq, cq, pq, prq]);
  if (error) throw error;
  const overdue = (due || []).filter((x) => x.due_date < t).length, dueToday = (due || []).filter((x) => x.due_date === t).length;
  // proposal values: the version that was sent (or accepted)
  let vers = {};
  if ((props || []).length) {
    const { data: v } = await sb.from('proposal_versions').select('proposal_id,version,setup_total,monthly_total,weekly_total').in('proposal_id', props.map((x) => x.id));
    (v || []).forEach((x) => (vers[x.proposal_id + ':' + x.version] = x));
  }
  if (!main.isConnected) return;   // they moved on while this was loading
  const valOf = (x) => vers[x.id + ':' + (x.status === 'accepted' ? x.accepted_version : x.version)] || {};
  const out = (props || []).filter((x) => x.status === 'sent');
  const outMo = out.reduce((a, x) => a + Number(valOf(x).monthly_total || 0) + Number(valOf(x).weekly_total || 0) * 52 / 12, 0);
  const since = periodStart(dashPeriod);
  const won = (props || []).filter((x) => x.status === 'accepted' && x.accepted_at && new Date(x.accepted_at) >= since && (isAdmin() || x.owner_id === S.me.id));
  const board = {};
  won.forEach((x) => { const b = (board[x.owner_id || ''] ||= { n: 0, setup: 0, mo: 0 }); const v = valOf(x); b.n++; b.setup += Number(v.setup_total || 0); b.mo += Number(v.monthly_total || 0) + Number(v.weekly_total || 0) * 52 / 12; });
  const rows = Object.entries(board).sort((a, b) => b[1].mo - a[1].mo || b[1].n - a[1].n);
  // pipeline: organizations in each open stage of the default pipeline
  const pl = (S.pipelines || []).find((x) => x.is_default) || (S.pipelines || [])[0];
  const cnt = {}; (cos || []).forEach((c) => (cnt[c.pipeline_stage_id] = (cnt[c.pipeline_stage_id] || 0) + 1));
  const stages = pl ? S.stages.filter((x) => x.pipeline_id === pl.id) : [];
  const tile = (n, label, nav, hot) => `<button type="button" class="dtile ${hot && n ? 'hot' : ''}" data-nav="${nav}"><b>${n}</b><span>${esc(label)}</span></button>`;
  // widgets: the built-in pieces plus the field ones, in the order this person (or the account) picked
  const chunk = {
    tiles: `<div class="dtiles">
      ${isFree() ? '' : tile(overdue, 'Overdue follow-ups', 'myday', true) + tile(dueToday, 'Due today', 'myday')}
      ${tile(S.counts.chats || 0, 'Customer chats waiting', 'inbox', true)}
      ${tile(S.counts.teamchat || 0, 'Unread internal chat', 'chat')}
      ${tile(orgN || 0, FLD.L('organization', true), 'orgs')}
      ${gelp ? `<button type="button" class="dtile" data-nav="proposals"><b>${out.length}</b><span>Proposals out${outMo ? ` · ${esc(money(outMo))}/mo` : ''}</span></button>` : ''}
    </div>`,
    closed: `${gelp ? `<div class="card"><div class="toolbar"><h2 style="margin:0;flex:1">Closed deals${isAdmin() ? '' : ' (yours)'}</h2>
        <select id="dPer" aria-label="Period" style="max-width:170px">${PERIODS.map(([k, l]) => `<option value="${k}" ${k === dashPeriod ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${rows.length ? `<div class="tw"><table class="ptable"><thead><tr><th>Who</th><th>Deals</th><th>Setup</th><th>Monthly</th></tr></thead><tbody>
        ${rows.map(([who, b]) => `<tr><td>${esc(userName(who) || 'Unassigned')}</td><td>${b.n}</td><td>${esc(money(b.setup))}</td><td>${esc(money(b.mo))}/mo</td></tr>`).join('')}</tbody></table></div>
        <small class="hint">Accepted proposals. Weekly billing counts at its monthly equivalent.</small>`
        : `<p class="empty">No accepted proposals ${esc(PERIODS.find((x) => x[0] === dashPeriod)[1].toLowerCase())}.</p>`}</div>` : ''}`,
    pipeline: `${stages.length && !isFree() ? `<div class="card"><h2>${esc(pl.name)} pipeline</h2><div class="dstages">
      ${stages.map((x) => `<button type="button" class="dstage ${x.kind}" data-nav="pipeline"><b>${cnt[x.id] || 0}</b><span>${esc(x.name)}</span></button>`).join('')}</div></div>` : ''}`,
  };
  const layout = FLD.dashLayout(), sizes = FLD.dashSizes();
  const extra = await Promise.all(layout.filter((id) => !chunk[id]).map(async (id) => [id, await FLD.widgetHtml(id).catch(() => '')]));
  extra.forEach(([id, h]) => (chunk[id] = h));
  if (!main.isConnected) return;
  main.innerHTML = `<div class="toolbar"><h1 style="margin:0;flex:1">Dashboard</h1><button type="button" class="btn ghost small" id="dashArr">Arrange</button><button type="button" class="btn ghost small" id="dashCust">Add or remove</button></div>
    <p class="hint arrhint" hidden>Drag the ⠿ handle to move a widget. Pick its width, or hide it. Tap Done when it looks right.</p>
    ${S.hasListings && isFree() ? '<div id="dashListing"></div>' : ''}
    <div class="dgrid">${layout.map((id) => chunk[id] ? `<div class="dw dw-${sizes[id] || 'full'}" data-wid="${id}">${chunk[id]}</div>` : '').join('\n')}</div>`;
  $('#dashCust', main).onclick = () => FLD.customizeDash(() => viewDashboard(main));
  $('#dashArr', main).onclick = () => arrangeDash(main, () => viewDashboard(main));
  FLD.bindWidgets(main);
  $$('[data-nav]', main).forEach((b) => (b.onclick = () => go(b.dataset.nav)));
  if ($('#dPer', main)) $('#dPer', main).onchange = (e) => { dashPeriod = e.target.value; store('dashPeriod', { v: dashPeriod }); viewDashboard(main); };
  if ($('#dashListing', main)) renderMemberHome($('#dashListing', main));
}

// Arrange: move widgets by dragging (mouse or finger), set each one's width, hide ones you don't want. Saved for this person.
function arrangeDash(main, onDone) {
  const grid = $('.dgrid', main); if (!grid) return;
  const btn = $('#dashArr', main), hint = $('.arrhint', main);
  // second tap (Done): save the order and widths picked while arranging
  if (grid.classList.contains('arranging')) {
    FLD.saveDash($$('.dw', grid).map((w) => w.dataset.wid), grid._sizes); toast('Dashboard saved'); return onDone();
  }
  grid.classList.add('arranging'); btn.textContent = 'Done'; btn.classList.replace('ghost', 'secondary'); hint.hidden = false;
  const sizes = (grid._sizes = FLD.dashSizes());
  $$('.dw', grid).forEach((w) => {
    const id = w.dataset.wid, bar = document.createElement('div'); bar.className = 'dwbar';
    bar.innerHTML = `<button type="button" class="dwgrip" aria-label="Drag to move">⠿</button>
      <span class="dwsizes" role="group" aria-label="Width">${FLD.SIZES.map(([k, n]) => `<button type="button" data-dsz="${k}" class="${sizes[id] === k ? 'on' : ''}" title="${n}">${{ full: 'Full', half: '½', third: '⅓' }[k]}</button>`).join('')}</span>
      <button type="button" class="dwhide" aria-label="Hide this widget" title="Hide">✕</button>`;
    w.prepend(bar);
    $$('[data-dsz]', bar).forEach((b) => (b.onclick = () => { sizes[id] = b.dataset.dsz; w.className = `dw dw-${b.dataset.dsz}`; $$('[data-dsz]', bar).forEach((x) => x.classList.toggle('on', x === b)); }));
    $('.dwhide', bar).onclick = () => w.remove();
    // drag: pointer events so it works with a mouse and a finger
    $('.dwgrip', bar).onpointerdown = (e) => {
      e.preventDefault();
      w.classList.add('dragging');
      const move = (ev) => {
        const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.dw');
        if (!under || under === w || under.parentElement !== grid) return;
        const r = under.getBoundingClientRect();
        const after = r.width > grid.clientWidth * 0.8 ? ev.clientY > r.top + r.height / 2 : ev.clientX > r.left + r.width / 2;
        grid.insertBefore(w, after ? under.nextSibling : under);
      };
      // listen on the whole page: moving the widget in the page would drop a pointer capture on its handle
      const up = () => { w.classList.remove('dragging'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    };
  });
}

// Get started: the setup steps for a new account. The tab goes away once they're all done or hidden.
async function startSteps() {
  const head = (q) => q.then((r) => r.count || 0);
  const full = !isFree();
  const [orgs, tasks, chats, props] = await Promise.all([
    head(sb.from('companies').select('id', { count: 'exact', head: true }).is('archived_at', null)),
    full ? head(sb.from('tasks').select('id', { count: 'exact', head: true })) : 0,
    full ? head(sb.from('chat_threads').select('id', { count: 'exact', head: true })) : 0,
    full && isGelpAcct() ? head(sb.from('proposals').select('id', { count: 'exact', head: true })) : 0,
  ]);
  const push = await pushState().catch(() => 'unsupported');
  return [
    full && { k: 'team', label: 'Invite your team', why: 'Give everyone their own login so follow-ups and chats go to the right person.', done: staff().length > 1, nav: 'team', go: 'Invite' },
    { k: 'orgs', label: 'Add your first 10 organizations', why: 'Type them in or bring in a spreadsheet.', done: orgs >= 10, nav: 'import', go: 'Import', note: `${Math.min(orgs, 10)} of 10` },
    full && { k: 'task', label: 'Set your first follow-up', why: 'Follow-ups land on My Day on the day they\'re due.', done: tasks > 0, nav: 'add', go: 'Quick Add' },
    full && { k: 'chat', label: 'Put live chat on your website', why: 'Visitors chat with you and the message lands in your Inbox. Done once the first chat comes in.', done: chats > 0, nav: 'sites', go: 'Set it up' },
    full && isGelpAcct() && { k: 'prop', label: 'Send your first proposal', why: 'Clients accept and pay right on the page.', done: props > 0, nav: 'proposals', go: 'Proposals' },
    push !== 'unsupported' && { k: 'push', label: 'Turn on notifications', why: 'Get a ping on this device for new chats and messages.', done: push === 'on', push: true, go: 'Turn on' },
  ].filter(Boolean);
}
async function viewStart(main) {
  const steps = await startSteps();
  if (!main.isConnected) return;   // they moved on while the steps were loading
  const n = steps.filter((x) => x.done).length;
  S.startDone = n === steps.length;
  main.innerHTML = `<h1>Get started</h1>
    <div class="card"><div class="toolbar"><b style="flex:1">${n} of ${steps.length} done</b><button type="button" class="btn ghost small" id="stHide">Hide this tab</button></div>
      <div class="stbar"><span style="width:${Math.round((n / steps.length) * 100)}%"></span></div></div>
    ${steps.map((x) => `<div class="card ststep ${x.done ? 'done' : ''}"><div class="stcheck" aria-hidden="true">${x.done ? '✓' : ''}</div>
      <div style="flex:1"><b>${esc(x.label)}</b>${x.done ? ' <span class="badge ok">Done</span>' : x.note ? ` <span class="badge">${esc(x.note)}</span>` : ''}<small class="hint" style="margin:2px 0 0">${esc(x.why)}</small></div>
      ${x.done ? '' : `<button type="button" class="btn small" ${x.push ? 'data-stpush' : `data-nav="${x.nav}"`}>${esc(x.go)}</button>`}</div>`).join('')}
    ${S.startDone ? '<p class="empty">All set. This tab goes away next time you open the CRM.</p>' : ''}`;
  $$('[data-nav]', main).forEach((b) => (b.onclick = () => go(b.dataset.nav)));
  if ($('[data-stpush]', main)) $('[data-stpush]', main).onclick = async () => { try { await turnOnPush(); } catch (e) { fail(e); } viewStart(main); };
  $('#stHide', main).onclick = () => { store('startHidden', { v: true }); toast('Hidden. Every step is still in its own place.'); go('dashboard'); };
}

// Tools: everything you need but not every day, in drawers
function viewTools(main) {
  const ds = drawers();
  main.innerHTML = `<h1>Tools</h1>
    <div class="drawers">${ds.map((d) => `<div class="card drawer"><h2>${esc(d.label)}</h2>
      ${(groupsOf(d) || [{ label: '', items: d.items }]).map((g) => `${g.label ? `<h3 class="drawgrp">${esc(g.label)}</h3>` : ''}${g.items.map((i) => `<button type="button" class="drawitem" data-nav="${i.id}"><b>${esc(i.label)}${lockedDivider(i) ? ' 🔒' : ''}</b><small>${esc(i.what || '')}</small></button>`).join('')}`).join('')}</div>`).join('')}</div>
    `;
  $$('[data-nav]', main).forEach((b) => (b.onclick = () => go(b.dataset.nav)));
}

function changePassword() {
  let dlg = $('#pwDlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'pwDlg'; dlg.className = 'vdlg'; document.body.appendChild(dlg); }
  dlg.innerHTML = `<div class="vhead"><h2 style="margin:0">Change password</h2><button type="button" class="btn ghost small" id="pwClose">Close</button></div>
    <form id="pwForm"><label class="label" for="pw1">New password</label><input type="password" id="pw1" minlength="8" required autocomplete="new-password">
    <label class="label" for="pw2">Type it again</label><input type="password" id="pw2" minlength="8" required autocomplete="new-password">
    <small class="hint">At least 8 characters.</small>
    <div class="actions"><button class="btn small">Save password</button></div></form>`;
  $('#pwClose').onclick = () => dlg.close();
  $('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    if ($('#pw1').value !== $('#pw2').value) return toast('The two passwords don\'t match', { error: true });
    const { error } = await sb.auth.updateUser({ password: $('#pw1').value });
    if (error) return fail(error);
    dlg.close(); toast('Password changed');
  };
  dlg.showModal();
}

/* ================= TO-DOS (follow-ups) ================= */
// tick a to-do off, with Undo; never deleted, and a finished one can be reopened from Completed
async function setTaskDone(id, done) {
  const { error } = await sb.from('tasks').update({ done }).eq('id', id);
  if (error) { fail(error); return false; }
  return true;
}
function wireTasks(root) {
  $$('[data-task]', root).forEach((b) => (b.onchange = async () => {
    b.disabled = true;
    if (!(await setTaskDone(b.dataset.task, true))) { b.checked = false; b.disabled = false; return; }
    const row = b.closest('.person-row'); row.hidden = true;
    toast('Marked done', { action: { label: 'Undo', fn: async () => { if (await setTaskDone(b.dataset.task, false)) { row.hidden = false; b.checked = false; b.disabled = false; toast('Back on the list'); } } } });
  }));
  $$('[data-topen]', root).forEach((b) => (b.onclick = () => openTask(b.dataset.topen)));
}
// finished to-dos, newest first, loaded when the section is opened
function doneList(box, { company, mine }) {
  if (!box) return;
  const load = async () => {
    let q = sb.from('tasks').select('id,title,due_date,assigned_to,done_at,done_by,companies(id,name)').eq('done', true)
      .order('done_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(50);
    if (company) q = q.eq('company_id', company);
    if (mine) q = q.eq('assigned_to', S.me.id);
    const { data, error } = await q;
    const body = $('.donebody', box);
    if (error) { body.innerHTML = '<p class="empty">Couldn\'t load these.</p>'; return fail(error); }
    body.innerHTML = (data || []).map((t) => `<div class="person-row taskrow done"><button type="button" class="tasktitle" data-topen="${t.id}">${esc(t.title)}</button>
      <div class="meta">${!company && t.companies ? `<button class="badge" data-cid="${t.companies.id}" style="border:0;cursor:pointer">${esc(t.companies.name)}</button>` : ''}
        <span class="badge ok">Done ${t.done_at ? esc(fmtDate(t.done_at)) : 'earlier'}${t.done_by ? ' by ' + esc(userName(t.done_by)) : ''}</span>
        <button type="button" class="btn secondary small" data-treopen="${t.id}">Reopen</button></div></div>`).join('')
      || '<p class="empty">Nothing finished yet.</p>';
    $$('[data-topen]', body).forEach((b) => (b.onclick = () => openTask(b.dataset.topen)));
    $$('[data-cid]', body).forEach((b) => (b.onclick = () => go('org', b.dataset.cid)));
    $$('[data-treopen]', body).forEach((b) => (b.onclick = async () => { b.disabled = true; if (await setTaskDone(b.dataset.treopen, false)) { toast('Reopened'); renderShell(); } else b.disabled = false; }));
  };
  box.ontoggle = () => { if (box.open && !box.dataset.loaded) { box.dataset.loaded = 1; load(); } };
}
// one to-do, opened: edit it, tick it off or reopen it, and jump to its organization or person
async function openTask(id) {
  const { data: t, error } = await sb.from('tasks').select('*, companies(id,name), people(id,first_name,last_name)').eq('id', id).maybeSingle();
  if (error) return fail(error);
  if (!t) return toast('That to-do is no longer here', { error: true });
  const { data: links } = t.company_id ? await sb.from('company_people').select('people(id,first_name,last_name,archived_at)').eq('company_id', t.company_id) : { data: [] };
  const ppl = (links || []).map((l) => l.people).filter((x) => x && !x.archived_at);
  if (t.people && !ppl.some((x) => x.id === t.people.id)) ppl.unshift(t.people);
  const pname = (x) => [x.first_name, x.last_name].filter(Boolean).join(' ') || 'No name';
  const team = staff(); if (t.assigned_to && !team.some((u) => u.id === t.assigned_to)) team.push({ id: t.assigned_to, full_name: userName(t.assigned_to) || 'Former teammate' });
  let dlg = $('#taskDlg');
  if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'taskDlg'; dlg.className = 'vdlg'; document.body.appendChild(dlg); }
  dlg.innerHTML = `<div class="vhead"><h2 style="margin:0">To-do${t.done ? ' <span class="badge ok">Done</span>' : ''}</h2><button type="button" class="btn ghost small" id="tdClose">Close</button></div>
    <label class="label" for="tdTitle">What</label><input type="text" id="tdTitle" value="${esc(t.title)}" maxlength="300">
    <div class="row"><div><label class="label" for="tdDue">Due</label><input type="date" id="tdDue" value="${esc(t.due_date || '')}"></div>
      <div><label class="label" for="tdWho">Assigned to</label><select id="tdWho"><option value="">Nobody</option>${team.map((u) => `<option value="${u.id}" ${u.id === t.assigned_to ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}</select></div></div>
    ${ppl.length ? `<label class="label" for="tdPerson">Person</label><select id="tdPerson"><option value="">Nobody in particular</option>${ppl.map((x) => `<option value="${x.id}" ${x.id === t.person_id ? 'selected' : ''}>${esc(pname(x))}</option>`).join('')}</select>` : ''}
    <label class="label" for="tdNotes">Notes</label><textarea id="tdNotes" rows="4">${esc(t.notes || '')}</textarea>
    <small class="hint">${esc([t.created_by ? 'Added by ' + userName(t.created_by) : 'Added', fmtDate(t.created_at)].join(' '))}${t.done ? ` · done ${t.done_at ? esc(fmtDate(t.done_at)) : 'earlier'}${t.done_by ? ' by ' + esc(userName(t.done_by)) : ''}` : ''}</small>
    <div class="actions" style="flex-wrap:wrap">
      <button class="btn small" id="tdSave">Save</button>
      <button class="btn secondary small" id="tdDone">${t.done ? 'Reopen' : 'Mark done'}</button>
      ${t.companies ? `<button class="btn ghost small" id="tdOrg">Open ${esc(t.companies.name)}</button>` : ''}
      ${t.people ? `<button class="btn ghost small" id="tdPpl">Open ${esc(pname(t.people))}</button>` : ''}
    </div>`;
  const close = (refresh) => { dlg.close(); if (refresh) renderShell(); };
  $('#tdClose').onclick = () => close(false);
  { const out = (e) => { const r = dlg.getBoundingClientRect(); return e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom); };
    let dn = false; dlg.onpointerdown = (e) => { dn = out(e); }; dlg.onclick = (e) => { if (dn && out(e)) close(false); dn = false; }; }
  $('#tdSave').onclick = async () => {
    const title = $('#tdTitle').value.trim(); if (title.length < 2) return toast('Give the to-do a title', { error: true });
    const f = { title, due_date: $('#tdDue').value || null, assigned_to: $('#tdWho').value || null, notes: $('#tdNotes').value.trim() || null };
    if ($('#tdPerson')) f.person_id = $('#tdPerson').value || null;
    const { error: e } = await sb.from('tasks').update(f).eq('id', t.id); if (e) return fail(e);
    toast('Saved'); close(true);
  };
  $('#tdDone').onclick = async () => { if (await setTaskDone(t.id, !t.done)) { toast(t.done ? 'Reopened' : 'Marked done'); close(true); } };
  if ($('#tdOrg')) $('#tdOrg').onclick = () => { dlg.close(); go('org', t.companies.id); };
  if ($('#tdPpl')) $('#tdPpl').onclick = () => { dlg.close(); go('people', t.people.id); };
  addEventListener('hashchange', () => dlg.open && dlg.close(), { once: true });   // moving to another page closes it
  dlg.showModal();
}

/* ================= MY DAY ================= */
let fuAll = false;
async function viewMyDay(main) {
  let tq = sb.from('tasks').select('*, companies(id,name,archived_at)').eq('done', false).order('due_date', { nullsFirst: false }).limit(300);
  if (!fuAll) tq = tq.eq('assigned_to', S.me.id);
  const [{ data: tasks, error }, { data: mine }, { data: sent }, { data: notes }] = await Promise.all([
    tq,
    sb.from('escalations').select('*, companies(id,name)').eq('to_user', S.me.id).eq('status', 'open').order('created_at'),
    sb.from('escalations').select('*, companies(id,name)').eq('from_user', S.me.id).order('created_at', { ascending: false }).limit(10),
    sb.from('notifications').select('*').is('done_at', null).order('created_at', { ascending: false }).limit(50),
  ]);
  if (error) throw error;
  const t = today();
  const groups = { Overdue: [], Today: [], Upcoming: [], 'No date': [] };
  (tasks || []).filter((x) => x.companies && !x.companies.archived_at)
    .forEach((x) => groups[!x.due_date ? 'No date' : x.due_date < t ? 'Overdue' : x.due_date === t ? 'Today' : 'Upcoming'].push(x));
  main.innerHTML = `<div class="toolbar"><h1 style="margin:0;flex:1">My Day</h1>
      <label class="check"><input type="checkbox" id="fall" ${fuAll ? 'checked' : ''}> Everyone's follow-ups</label></div>
    <div id="mdCal"></div>
    <div id="mdRoutes"></div>
    <div id="mdField"></div>
    ${(() => { const b = birthdaysSoon(7); if (!b.length) return '';
      const today = b.filter((x) => !x.inDays), soon = b.filter((x) => x.inDays);
      return `<div class="card bdaycard">${today.map((x) => `<div><b>🎂 Today is ${esc(x.u.id === S.me.id ? 'your' : x.u.full_name + '\'s')} birthday!</b>${x.u.id === S.me.id ? '' : ` <button class="linkish" data-bdm="${x.u.id}">Send a message</button>`}</div>`).join('')}
        ${soon.length ? `<small class="hint" style="margin:${today.length ? '6px' : '0'} 0 0">Coming up: ${soon.map((x) => `${esc(x.u.id === S.me.id ? 'You' : x.u.full_name)} ${x.inDays === 1 ? 'tomorrow' : `in ${x.inDays} days`} (${esc(bdayLabel(x.u))})`).join(' · ')}</small>` : ''}</div>`; })()}
    ${(notes || []).map((n) => `<div class="card flagcard pinned ${n.kind === 'dev_escalated' ? 'hot' : ''}">
      <div class="toolbar"><b style="flex:1">${n.kind === 'dev_escalated' ? '⚑ ' : '◎ '}${esc(n.title)}</b><small>${esc(fmtDate(n.created_at))}</small></div>
      ${n.body ? `<p style="margin:4px 0">${esc(n.body)}</p>` : ''}
      <div class="actions">${n.link ? `<button class="btn small" data-nlink="${esc(n.link)}">Open</button>` : ''}<button class="btn secondary small" data-ndone="${n.id}">Done</button></div></div>`).join('')}
    ${(mine || []).map((e) => `<div class="card flagcard pinned">
      <div class="toolbar"><b style="flex:1">⚑ Escalation from ${esc(userName(e.from_user))}</b><small>${esc(fmtDate(e.created_at))}</small></div>
      <div><button class="linkish" data-cid="${e.companies?.id}">${esc(e.companies?.name || '')}</button> · ${esc(e.reason || '')}</div>
      ${e.note ? `<p>${esc(e.note)}</p>` : ''}
      <textarea class="inote" data-escnote="${e.id}" rows="1" placeholder="My notes (saved as you type)" aria-label="My notes on this escalation">${esc(e.my_notes || '')}</textarea>
      <div class="actions"><button class="btn small" data-cid="${e.companies?.id}">Open</button><button class="btn small gold" data-esctodo="${e.id}">Turn into a to-do</button><button class="btn secondary small" data-clear="${e.id}">Handled, clear it</button></div>
      <div class="esctodo" data-esctodoform="${e.id}" hidden>
        <label class="label">To-do</label><input type="text" data-etitle value="${esc(`${e.reason || 'Follow up'}: ${e.companies?.name || ''}`)}">
        <div class="row"><div><label class="label">Due</label><input type="date" data-edue value="${esc(addDays(1))}"></div><div></div></div>
        <label class="label">Notes</label><textarea data-enotes rows="3">${esc([e.note ? `From ${userName(e.from_user)}: ${e.note}` : '', e.my_notes || ''].filter(Boolean).join('\n'))}</textarea>
        <div class="actions"><button class="btn small" data-esave="${e.id}">Create to-do</button><button class="btn ghost small" data-ecancel="${e.id}">Cancel</button></div>
        <small class="hint">It goes on your follow-ups for this organization, and the escalation is marked handled.</small></div></div>`).join('')}
    ${Object.entries(groups).filter(([, v]) => v.length).map(([g, v]) => `<div class="card"><h2>${g} (${v.length})</h2>
      ${v.map((x) => `<div class="person-row taskrow"><input type="checkbox" data-task="${x.id}" aria-label="Mark done: ${esc(x.title)}"> <button type="button" class="tasktitle" data-topen="${x.id}">${esc(x.title)}</button>
        ${x.notes ? `<small class="hint tasknote" style="margin:2px 0 4px;white-space:pre-wrap">${esc(x.notes)}</small>` : ''}
        <div class="tasknotes" data-tnbox="${x.id}" hidden><textarea class="inote" data-tasknote="${x.id}" rows="2" placeholder="Notes" aria-label="Notes on this to-do">${esc(x.notes || '')}</textarea></div>
        <div class="meta"><button class="badge" data-cid="${x.companies?.id}" style="border:0;cursor:pointer">${esc(x.companies?.name || '')}</button>
        <button type="button" class="badge" data-tnedit="${x.id}" style="border:0;cursor:pointer">${x.notes ? 'Edit notes' : '+ Notes'}</button>
        ${x.due_date ? `<span class="badge ${g === 'Overdue' ? 'due' : ''}">${esc(fmtDate(x.due_date))}</span>` : ''}
        ${fuAll && x.assigned_to ? `<span class="badge">${esc(userName(x.assigned_to))}</span>` : ''}</div></div>`).join('')}</div>`).join('')
      || ((mine || []).length || (notes || []).length ? '' : '<p class="empty">Nothing open. Nice.</p>')}
    <details class="card donebox" id="myDone"><summary><h2 style="display:inline">Completed</h2></summary><div class="donebody"><p class="empty">Loading…</p></div></details>
    ${(sent || []).length ? `<div class="card"><h2>Escalations you sent</h2>${sent.map((e) => `<div class="person-row">
      <b>${esc(e.companies?.name || '')}</b> <span class="badge ${e.status === 'open' ? 'due' : 'ok'}">${e.status === 'open' ? 'Waiting' : 'Handled'}</span>
      <div><small>To ${esc(userName(e.to_user))} · ${esc(e.reason || '')} · ${esc(fmtDate(e.created_at))}</small></div></div>`).join('')}</div>` : ''}`;
  FLD.myDayCards($('#mdField', main)).catch(fail);
  RTE.myDayBox($('#mdRoutes', main)).catch(() => {});
  CAL.myDayBox($('#mdCal', main)).catch(() => {});
  $('#fall').onchange = (e) => { fuAll = e.target.checked; renderShell(); };
  $$('[data-bdm]').forEach((b) => (b.onclick = async () => { const { data, error: e } = await sb.rpc('team_dm_open', { p_user: b.dataset.bdm }); if (e) return fail(e); go('chat', data); }));
  $$('[data-nlink]').forEach((b) => (b.onclick = () => { const [v, p] = b.dataset.nlink.replace('#', '').split('/'); go(v, p || null); }));
  $$('[data-ndone]').forEach((b) => (b.onclick = async () => { const { error: e } = await sb.from('notifications').update({ done_at: new Date().toISOString() }).eq('id', b.dataset.ndone); if (e) return fail(e); renderShell(); }));
  $$('[data-cid]').forEach((b) => (b.onclick = () => go('org', b.dataset.cid)));
  $$('[data-clear]').forEach((b) => (b.onclick = async () => {
    const { error } = await sb.from('escalations').update({ status: 'cleared', cleared_at: new Date().toISOString(), cleared_by: S.me.id }).eq('id', b.dataset.clear);
    error ? fail(error) : (toast('Cleared'), renderShell());
  }));
  wireTasks(main);
  doneList($('#myDone'), { mine: !fuAll });
  // escalations: your own notes, or turn it into a regular to-do
  $$('[data-escnote]').forEach((t) => (t.oninput = debounce(async () => {
    const { error: e } = await sb.from('escalations').update({ my_notes: t.value.trim() || null }).eq('id', t.dataset.escnote);
    if (e) fail(e);
  }, 600)));
  $$('[data-esctodo]').forEach((b) => (b.onclick = () => { const f = $(`[data-esctodoform="${b.dataset.esctodo}"]`); f.hidden = !f.hidden; if (!f.hidden) $('[data-etitle]', f).focus(); }));
  $$('[data-ecancel]').forEach((b) => (b.onclick = () => { $(`[data-esctodoform="${b.dataset.ecancel}"]`).hidden = true; }));
  $$('[data-esave]').forEach((b) => (b.onclick = async () => {
    const f = $(`[data-esctodoform="${b.dataset.esave}"]`); b.disabled = true;
    const { error: e } = await sb.rpc('escalation_to_task', { p_esc: b.dataset.esave, p_title: $('[data-etitle]', f).value, p_due: $('[data-edue]', f).value || null, p_notes: $('[data-enotes]', f).value });
    b.disabled = false; if (e) return fail(e);
    toast('Added to your follow-ups'); renderShell();
  }));
  // notes on any to-do
  $$('[data-tnedit]').forEach((b) => (b.onclick = () => { const bx = $(`[data-tnbox="${b.dataset.tnedit}"]`); bx.hidden = !bx.hidden; if (!bx.hidden) $('textarea', bx).focus(); }));
  $$('[data-tasknote]').forEach((t) => (t.oninput = debounce(async () => {
    const { error: e } = await sb.from('tasks').update({ notes: t.value.trim() || null }).eq('id', t.dataset.tasknote);
    if (e) fail(e);
  }, 600)));
}

/* ================= ADMIN: TEAM ================= */
async function viewTeam(main) {
  const [{ data: users }, { data: vendors }, { data: invites }, { data: members }] = await Promise.all([
    // only people who belong to this account (your own login is always readable, so it would show up in every account you switch into)
    sb.from('app_users').select('*').neq('role', 'member').eq('tenant_id', S.acct?.id || S.me.tenant_id).order('created_at'),
    sb.from('vendors').select('id,name').order('name'),
    sb.from('invites').select('*').neq('role', 'member').is('accepted_at', null).is('revoked_at', null).order('created_at', { ascending: false }),
    sb.rpc('account_members_list'),
  ]);
  // members: people from another account (like the agency) who are on this team too. This account controls their access here.
  const mems = (members || []).map((m) => ({ ...m, id: m.user_id, role: 'staff', active: true }));
  const people = (users || []).filter((u) => u.role !== 'vendor');
  const inviteText = (i) => `You're invited to ${S.acct?.brand?.name || 'the CRM'}. Open ${S.pub()}/#signup/${encodeURIComponent(i.email)}${i.token ? '/' + encodeURIComponent(i.token) : ''} and create your login with ${i.email}.`;
  main.innerHTML = `<h1>Team</h1><p class="empty">Anyone on the team can be an owner or a lead source. Admin is an extra permission on top. Only invited emails can create a login.</p>
    <div class="card"><h2>Invite someone</h2><form id="invF">
      <div class="row"><div><label class="label">Full name</label><input type="text" name="full_name" required></div>
        <div><label class="label">Email</label><input type="email" name="email" required></div></div>
      <div class="row"><div><label class="label">Account type</label><select name="role" id="invRole"><option value="staff">Team member</option>${S.acct?.is_gelp === false ? '' : '<option value="vendor">Vendor login</option>'}</select></div>
        <div id="invWho"></div></div>
      <label class="check" id="invAdminWrap"><input type="checkbox" name="is_admin"> Owner / admin (can manage the team, settings and stages)</label>
      <div class="actions"><button class="btn" type="submit">Create invite</button></div>
      <small class="hint">They get an email with a link that opens sign-up with their address filled in. You can also copy the message and text it.</small>
    </form></div>
    ${(invites || []).length ? `<h2 class="section">Waiting to sign up (${invites.length})</h2>${invites.map((i) => `<div class="card" data-inv="${i.id}">
      <div class="toolbar"><div style="flex:1"><b>${esc(i.full_name || i.email)}</b><br><small>${esc(i.email)} · ${i.role === 'vendor' ? 'Vendor login' : 'Team member'}${i.is_admin ? ' · Admin' : ''} · invited ${esc(fmtDate(i.created_at))}</small></div></div>
      <div class="actions"><button class="btn small" data-resend>Email it again</button><button class="btn secondary small" data-copy>Copy invite message</button><button class="btn ghost small danger" data-revoke>Cancel invite</button></div></div>`).join('')}` : ''}
    <h2 class="section">People with access</h2>${S.acct?.is_gelp === false && S.me.tenant_id !== S.acct?.id && !S.acct?.member ? `<small class="hint" style="display:block;margin:-6px 0 10px">You're in ${esc(S.acct.name)}'s account as the platform admin, so you aren't listed here and don't count as one of their people.</small>` : ''}
    ${(users || []).map((u) => `<div class="card" data-u="${u.id}">
      <div class="toolbar"><div style="flex:1"><b>${esc(u.full_name)}</b><br><small>${esc(u.email)}</small></div>
        ${u.is_admin ? '<span class="badge gold">Admin</span>' : ''}<span class="badge ${u.active ? 'ok' : 'due'}">${u.active ? 'Active' : 'Waiting'}</span></div>
      <div class="row"><div><label class="label" for="un_${u.id}">Name</label><input type="text" id="un_${u.id}" data-f="full_name" value="${esc(u.full_name || '')}" maxlength="120"></div><div></div></div>
      <div class="row">
        <div><label class="label">Account type</label><select data-f="role"><option value="staff" ${u.role !== 'vendor' ? 'selected' : ''}>Team member</option><option value="vendor" ${u.role === 'vendor' ? 'selected' : ''}>Vendor login</option></select></div>
        ${u.role === 'vendor'
          ? `<div><label class="label">Vendor</label><select data-f="vendor_id"><option value="">—</option>${(vendors || []).map((v) => `<option value="${v.id}" ${v.id === u.vendor_id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></div>`
          : `<div><label class="label">Reports to</label><select data-f="manager_id"><option value="">Nobody</option>${people.filter((x) => x.id !== u.id).map((x) => `<option value="${x.id}" ${x.id === u.manager_id ? 'selected' : ''}>${esc(x.full_name)}</option>`).join('')}</select></div>`}
      </div>
      ${u.role !== 'vendor' ? `<label class="check"><input type="checkbox" data-admin ${u.is_admin ? 'checked' : ''} ${u.id === S.me.id ? 'disabled' : ''}> Admin${u.id === S.me.id ? ' (you can\'t remove your own)' : ''}</label>` : ''}
      ${u.role !== 'vendor' && (S.divisions || []).length > 1 ? `<div class="divwho"><span class="label">Works in</span><div class="chips">${S.divisions.map((d) => `<label class="chip ${(u.divisions || []).includes(d.id) ? 'on' : ''}"><input type="checkbox" data-udiv="${d.id}" ${(u.divisions || []).includes(d.id) ? 'checked' : ''} hidden>${esc(d.name)}</label>`).join('')}</div>
        <small class="hint">${u.is_admin ? 'Admins see every company no matter what is picked here.' : (u.divisions || []).length ? 'Sees only these companies plus shared records.' : 'Nothing picked: sees every company.'}</small></div>` : ''}
      <div class="actions">${u.id === S.me.id ? '' : `<button class="btn small ${u.active ? 'secondary' : ''}" data-act>${u.active ? 'Turn off access' : 'Turn on access'}</button>${u.active && u.email ? '<button class="btn ghost small" data-pwreset>Email a password reset</button>' : ''}`}</div>
    </div>`).join('')}
    ${mems.map((u) => `<div class="card" data-m="${u.id}">
      <div class="toolbar"><div style="flex:1"><b>${esc(u.full_name)}</b><br><small>${esc(u.email)}</small></div>
        <span class="badge" title="Their login lives in ${esc(u.from)}. You control what they can do here.">from ${esc(u.from)}</span>${u.is_admin ? '<span class="badge gold">Admin</span>' : ''}<span class="badge ok">Active</span></div>
      <small class="hint">On your team from ${esc(u.from)}. Their own login and account stay theirs; the role, admin and companies here are yours to set, and you can take them off any time.</small>
      <label class="check"><input type="checkbox" data-madmin ${u.is_admin ? 'checked' : ''} ${u.id === S.me.id || !isAdmin() ? 'disabled' : ''}> Admin in this account${u.id === S.me.id ? ' (you can\'t change your own)' : ''}</label>
      ${(S.divisions || []).length > 1 ? `<div class="divwho"><span class="label">Works in</span><div class="chips">${S.divisions.map((d) => `<label class="chip ${(u.divisions || []).includes(d.id) ? 'on' : ''}"><input type="checkbox" data-mdiv="${d.id}" ${(u.divisions || []).includes(d.id) ? 'checked' : ''} ${u.id === S.me.id ? 'disabled' : ''} hidden>${esc(d.name)}</label>`).join('')}</div>
        <small class="hint">${u.is_admin ? 'Admins see every company no matter what is picked here.' : (u.divisions || []).length ? 'Sees only these companies plus shared records.' : 'Nothing picked: sees every company.'}</small></div>` : ''}
      <div class="actions">${u.id === S.me.id ? '' : '<button class="btn small secondary danger" data-mrm>Remove from this account</button>'}</div>
    </div>`).join('')}`;
  const who = () => {
    const vendor = $('#invRole').value === 'vendor';
    $('#invWho').innerHTML = vendor
      ? `<label class="label">Vendor</label><select name="vendor_id" required><option value="">Pick a vendor…</option>${(vendors || []).map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select>`
      : `<label class="label">Reports to</label><select name="manager_id"><option value="">Nobody</option>${people.filter((x) => x.active).map((x) => `<option value="${x.id}" ${x.id === S.me.id ? 'selected' : ''}>${esc(x.full_name)}</option>`).join('')}</select>`;
    $('#invAdminWrap').hidden = vendor;
  };
  who(); $('#invRole').onchange = who;
  $('#invF').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const email = f.email.trim().toLowerCase();
    if ((users || []).some((u) => (u.email || '').toLowerCase() === email)) return toast('That person already has a login');
    const row = { email, full_name: f.full_name.trim(), role: f.role, is_admin: f.role === 'staff' && !!f.is_admin,
      manager_id: f.role === 'staff' ? (f.manager_id || null) : null, vendor_id: f.role === 'vendor' ? (f.vendor_id || null) : null };
    const { data, error } = await sb.from('invites').insert(row).select('*').single();
    if (error) return fail(/duplicate|unique/i.test(error.message) ? { message: 'That email already has an invite waiting' } : error);
    if (await sendInvite(data.tenant_id, data.email, true)) toast(`Invite emailed to ${data.email}`);
    else { try { await navigator.clipboard.writeText(inviteText(data)); toast('Invite created, but the email didn\'t go out. The message is copied, paste it to them.', { error: true }); } catch { toast('Invite created, but the email didn\'t go out. Use Copy invite message.', { error: true }); } }
    renderShell();
  };
  $$('[data-inv]').forEach((card) => {
    const i = invites.find((x) => x.id === card.dataset.inv);
    $('[data-copy]', card).onclick = async () => {
      try { await navigator.clipboard.writeText(inviteText(i)); toast('Copied'); } catch { prompt('Copy this message:', inviteText(i)); }
    };
    $('[data-resend]', card).onclick = async () => { if (await sendInvite(i.tenant_id, i.email)) toast(`Invite emailed to ${i.email}`); };
    $('[data-revoke]', card).onclick = async () => {
      const { error } = await sb.from('invites').update({ revoked_at: new Date().toISOString() }).eq('id', i.id);
      error ? fail(error) : (toast('Invite cancelled'), renderShell());
    };
  });
  $$('[data-u]').forEach((card) => {
    const id = card.dataset.u; const u = users.find((x) => x.id === id);
    FLD.teamRolePicker(card, u);
    const save = async (patch, msg = 'Saved') => {
      const { error } = await sb.from('app_users').update(patch).eq('id', id);
      if (error) return fail(error);
      toast(msg);
      await loadUsers();
    };
    $$('[data-f]', card).forEach((s) => (s.onchange = async () => {
      if (id === S.me.id && s.dataset.f === 'role' && s.value === 'vendor') { s.value = 'staff'; return toast("You can't make yourself a vendor login"); }
      if (s.dataset.f === 'full_name') {
        const nm = s.value.trim().replace(/\s+/g, ' ');
        if (!nm) { s.value = u.full_name || ''; return toast('Name can\'t be blank'); }
        if (nm === u.full_name) return;
        await save({ full_name: nm }, 'Name updated'); u.full_name = nm;
        if (id === S.me.id) S.me.full_name = nm;
        return renderShell();
      }
      await save({ [s.dataset.f]: s.value || null });
      if (s.dataset.f === 'role') renderShell();
    }));
    const a = $('[data-admin]', card);
    if (a) a.onchange = () => save({ is_admin: a.checked }, a.checked ? 'Admin turned on' : 'Admin turned off');
    $$('[data-udiv]', card).forEach((x) => (x.onchange = async () => {
      const next = $$('[data-udiv]', card).filter((y) => y.checked).map((y) => y.dataset.udiv);
      await save({ divisions: next }, next.length ? `Works in ${next.map(divName).join(' and ')}` : 'Sees every company');
      renderShell();
    }));
    const act = $('[data-act]', card);
    if (act) act.onclick = async () => { await save({ active: !u.active }, u.active ? 'Access turned off' : 'Access turned on'); renderShell(); };
    const pw = $('[data-pwreset]', card);
    if (pw) pw.onclick = async () => { pw.disabled = true; await sendPwReset(u.email); pw.disabled = false; };
  });
  $$('[data-m]').forEach((card) => {
    const u = mems.find((x) => x.id === card.dataset.m);
    FLD.teamRolePicker(card, u);
    const set = async (p, msg) => { const { error } = await sb.rpc('account_member_set', { p_user: u.id, p }); if (error) { fail(error); return false; } toast(msg); await loadUsers(); return true; };
    const a = $('[data-madmin]', card);
    if (a) a.onchange = async () => { if (!(await set({ is_admin: a.checked }, a.checked ? 'Admin turned on' : 'Admin turned off'))) a.checked = !a.checked; else renderShell(); };
    $$('[data-mdiv]', card).forEach((x) => (x.onchange = async () => {
      const next = $$('[data-mdiv]', card).filter((y) => y.checked).map((y) => y.dataset.mdiv);
      if (await set({ divisions: next }, next.length ? `Works in ${next.map(divName).join(' and ')}` : 'Sees every company')) renderShell();
    }));
    const rm = $('[data-mrm]', card);
    if (rm) rm.onclick = async () => {
      if (!confirm(`Take ${u.full_name} off this account? They keep their own login and account, they just can't get into this one.`)) return;
      const { error } = await sb.rpc('account_member_remove', { p_user: u.id }); if (error) return fail(error);
      toast(`${u.full_name} removed from this account`); await loadUsers(); renderShell();
    };
  });
}

// Settings > Companies in this account: add, rename, color and remove divisions
async function drawDivCard(box) {
  if (!box) return;
  const ds = S.divisions || [];
  box.innerHTML = `<h2>Companies in this account</h2>
    <small class="hint" style="margin:-4px 0 10px">Run more than one company from this account. Tag organizations, people, deals and chats with the company they belong to, or with more than one to share them. Each team member can be limited to their company on the Team screen. Admins always see everything, and the switcher at the top lets anyone who works in more than one look at one at a time.</small>
    ${ds.map((d) => `<div class="pline divrow" data-d="${d.id}"><input type="color" value="${esc(d.color)}" data-dc aria-label="Color for ${esc(d.name)}"><input type="text" value="${esc(d.name)}" data-dn maxlength="60" aria-label="Company name"><button type="button" class="btn ghost small danger" data-drm>Remove</button></div>`).join('')}
    <div class="pline" style="margin-top:8px"><input type="text" id="divNew" placeholder="${ds.length ? 'Another company' : 'First company, e.g. the one you have now'}" maxlength="60"><button type="button" class="btn small" id="divAdd">Add</button></div>
    ${ds.length === 1 ? '<small class="hint">Add a second company to turn on tagging and the switcher.</small>' : ''}`;
  const reload = async () => { S.divisions = (await sb.from('divisions').select('id,name,color,sort_order').order('sort_order').order('name')).data || []; };
  $('#divAdd').onclick = async () => {
    const name = $('#divNew').value.trim(); if (!name) return $('#divNew').focus();
    const colors = ['#1A2A52', '#C9A04A', '#2E7D6B', '#8A3B5C', '#3A6FB0'];
    const { error } = await sb.from('divisions').insert({ name, color: colors[ds.length % colors.length], sort_order: ds.length }); if (error) return fail(error);
    await reload(); toast(`${name} added`); renderShell();
  };
  $('#divNew').onkeydown = (e) => { if (e.key === 'Enter') $('#divAdd').click(); };
  $$('[data-d]', box).forEach((row) => {
    const id = row.dataset.d;
    $('[data-dn]', row).onchange = async (e) => { const v = e.target.value.trim(); if (!v) return; const { error } = await sb.from('divisions').update({ name: v }).eq('id', id); if (error) return fail(error); await reload(); toast('Renamed'); };
    $('[data-dc]', row).onchange = async (e) => { const { error } = await sb.from('divisions').update({ color: e.target.value }).eq('id', id); if (error) return fail(error); await reload(); };
    $('[data-drm]', row).onclick = async () => {
      if (!confirm('Remove this company? Records tagged only with it become shared, so nobody loses anything.')) return;
      for (const t of ['companies', 'people', 'opportunities', 'chat_threads', 'app_users']) {
        const { data } = await sb.from(t).select('id,divisions').contains('divisions', [id]).limit(5000);
        for (const r of data || []) await sb.from(t).update({ divisions: r.divisions.filter((x) => x !== id) }).eq('id', r.id);
      }
      const { error } = await sb.from('divisions').delete().eq('id', id); if (error) return fail(error);
      await reload(); toast('Removed'); renderShell();
    };
  });
}

/* ================= ADMIN: REVIEW QUEUE ================= */
async function viewReview(main) {
  // people who approve field work but aren't admins only see that part
  if (!isAdmin()) { main.innerHTML = '<h1>Review</h1><div id="docRev"></div><div id="bidRev"></div><div id="fieldRev"></div>'; DOC.reviewBox($('#docRev', main)).catch(fail); BID.reviewBox($('#bidRev', main)).catch(fail); return FLD.fieldReview($('#fieldRev', main)); }
  const { data: items, error } = await sb.from('review_items').select('*').eq('status', 'open').order('created_at');
  if (error) throw error;
  const ids = { companies: new Set(), people: new Set() };
  (items || []).forEach((i) => { ids[i.entity].add(i.entity_id); if (i.related_id) ids[i.entity].add(i.related_id); });
  const [co, pe] = await Promise.all([
    ids.companies.size ? sb.from('companies').select('id,name,org_types,stage,pipeline_stage_id,address,city,state,zip,main_phone,specialty,owner_id,created_at,archived_at,archive_status,company_people(count)').in('id', [...ids.companies]) : { data: [] },
    ids.people.size ? sb.from('people').select('id,first_name,last_name,personal_cell,personal_email,created_at,archived_at,archive_status,company_people(count)').in('id', [...ids.people]) : { data: [] },
  ]);
  const rec = { companies: Object.fromEntries((co.data || []).map((r) => [r.id, r])), people: Object.fromEntries((pe.data || []).map((r) => [r.id, r])) };
  const label = (e, r) => !r ? '(missing record)' : e === 'companies' ? r.name : fullName(r);
  const mini = (e, r) => !r ? '<p class="empty">Record not found</p>' : e === 'companies'
    ? `<b>${esc(r.name)}</b><div class="meta">${typeBadges(r.org_types)}</div><small>${esc(orgAddr(r))}</small><small>${esc([r.main_phone, r.specialty].filter(Boolean).join(' · '))}</small>
       <small>${plural(r.company_people?.[0]?.count || 0, 'contact')} · added ${esc(fmtDate(r.created_at))}${r.archived_at ? ' · <b>archived</b>' : ''}</small>`
    : `<b>${esc(fullName(r))}</b><small>${esc([r.personal_cell, r.personal_email].filter(Boolean).join(' · '))}</small>
       <small>${plural(r.company_people?.[0]?.count || 0, 'organization')} · added ${esc(fmtDate(r.created_at))}${r.archived_at ? ' · <b>archived</b>' : ''}</small>`;
  const dels = (items || []).filter((i) => i.kind === 'delete_request');
  const dups = (items || []).filter((i) => i.kind === 'possible_duplicate');
  const other = (items || []).filter((i) => i.kind === 'import_issue');
  const noun = (e) => (e === 'companies' ? 'Organization' : 'Person');
  const sugOn = isSugOwner();
  main.innerHTML = `<h1>Review</h1><div id="docRev"></div><div id="bidRev"></div><div id="fieldRev"></div><div id="brandRev"></div><div id="phoneRev"></div>${S.dirOn ? '<div id="editReview"></div>' : ''}${sugOn ? '<div id="sugReview"><p class="empty">Loading suggestions…</p></div>' : ''}
    ${!(items || []).length ? '<p class="empty">Nothing waiting on you. The red dot shows up here when something needs a decision.</p>' : ''}
    ${dels.length ? `<h2 class="section">Delete requests (${dels.length})</h2>${dels.map((i) => `<div class="card" data-item="${i.id}">
      <div class="toolbar"><b style="flex:1">${noun(i.entity)}: ${esc(label(i.entity, rec[i.entity][i.entity_id]))}</b><small>${esc(fmtDate(i.created_at))}</small></div>
      <p>Requested by ${esc(userName(i.created_by) || 'someone')}: “${esc(i.reason || '')}”</p>
      <div class="actions"><button class="btn small dangerbtn" data-do="approve">Approve, archive it</button><button class="btn secondary small" data-do="deny">Keep it</button>
        <button class="btn ghost small" data-open="${i.entity}:${i.entity_id}">Look at it</button></div></div>`).join('')}` : ''}
    ${dups.length ? `<h2 class="section">Possible duplicates (${dups.length})</h2>${dups.map((i) => {
      const a = rec[i.entity][i.entity_id], b = rec[i.entity][i.related_id];
      return `<div class="card" data-item="${i.id}" data-entity="${i.entity}" data-a="${i.entity_id}" data-b="${i.related_id || ''}">
        <div class="toolbar"><b style="flex:1">${noun(i.entity)}</b><small>${esc(i.reason || '')}${i.created_by ? ' · ' + esc(userName(i.created_by)) : ''}</small></div>
        <div class="pair"><div class="side">${mini(i.entity, a)}<button class="btn small" data-keep="a" ${!a || !b || a.archived_at ? 'disabled' : ''}>Keep this one</button></div>
          <div class="side">${mini(i.entity, b)}<button class="btn small" data-keep="b" ${!a || !b || b.archived_at ? 'disabled' : ''}>Keep this one</button></div></div>
        <small class="hint">Keeping one moves all contacts, notes and follow-ups onto it and archives the other.</small>
        <div class="actions"><button class="btn small" data-cmp ${!a || !b ? 'disabled' : ''}>Compare side by side</button><button class="btn secondary small" data-do="dismiss">Not a duplicate</button></div></div>`;
    }).join('')}` : ''}
    ${other.length ? `<h2 class="section">Other issues (${other.length})</h2>${other.map((i) => `<div class="card" data-item="${i.id}">
      <b>${noun(i.entity)}: ${esc(label(i.entity, rec[i.entity][i.entity_id]))}</b><p>${esc(i.reason || '')}</p>
      <div class="actions"><button class="btn small" data-do="resolve">Mark resolved</button><button class="btn ghost small" data-open="${i.entity}:${i.entity_id}">Look at it</button></div></div>`).join('')}` : ''}`;
  FLD.fieldReview($('#fieldRev', main)).catch(fail);
  brandReview($('#brandRev', main)).catch(() => {});
  PHN.reviewBox($('#phoneRev', main)).catch(() => {});
  DOC.reviewBox($('#docRev', main)).catch(fail);
  BID.reviewBox($('#bidRev', main)).catch(fail);
  if (sugOn && $('#sugReview')) renderSuggestions($('#sugReview')).catch(fail);
  if (S.dirOn && $('#editReview')) renderListingEdits($('#editReview')).catch(fail);
  $$('[data-open]').forEach((b) => (b.onclick = () => { const [e, id] = b.dataset.open.split(':'); go(e === 'companies' ? 'org' : 'people', id); }));
  $$('[data-item]').forEach((card) => {
    const item = card.dataset.item;
    $$('[data-do]', card).forEach((b) => (b.onclick = async () => {
      const { error } = await sb.rpc('resolve_review', { p_item: item, p_decision: b.dataset.do });
      if (error) return fail(error);
      FACETS = null; toast('Done'); renderShell();
    }));
    if ($('[data-cmp]', card)) $('[data-cmp]', card).onclick = () => compareMerge(card.dataset.entity, card.dataset.b, card.dataset.a);
    $$('[data-keep]', card).forEach((b) => (b.onclick = async () => {
      const keep = b.dataset.keep === 'a' ? card.dataset.a : card.dataset.b;
      const drop = b.dataset.keep === 'a' ? card.dataset.b : card.dataset.a;
      const { error } = await sb.rpc('merge_records', { p_entity: card.dataset.entity, p_keep: keep, p_drop: drop });
      if (error) return fail(error);
      FACETS = null; toast('Merged. The other one is in the archive.'); renderShell();
    }));
  });
}

/* ================= side-by-side merge (Nov 16, schema/112) =================
   Two possible duplicates, field by field. Matching fields and ones where only one side has a value fold away (blanks
   fill from the other record on their own); for each real difference you click the value to keep. Every value that
   loses goes into a note on the kept record, with who approved the merge. */
const MERGE_FIELDS = {
  people: [['first_name', 'First name'], ['last_name', 'Last name'], ['personal_cell', 'Cell'], ['personal_email', 'Email'], ['preferred_contact_method', 'Preferred contact']],
  companies: [['name', 'Name'], ['specialty', 'Specialty'], ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['zip', 'Zip'], ['main_phone', 'Main phone'], ['fax', 'Fax'], ['main_email', 'Main email'], ['website', 'Website']],
};
async function compareMerge(entity, idA, idB) {
  const [{ data: recs, error }, { data: cf }] = await Promise.all([
    sb.from(entity).select('*').in('id', [idA, idB]),
    sb.from('custom_fields').select('key,label').eq('entity', entity).is('archived_at', null)]);
  if (error) return fail(error);
  const A = (recs || []).find((r) => r.id === idA), B = (recs || []).find((r) => r.id === idB);
  if (!A || !B) return toast('One of these records is gone');
  const show = (v) => (v == null || v === '' ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));
  const same = (x, y) => show(x).trim().toLowerCase() === show(y).trim().toLowerCase();
  const cfl = Object.fromEntries((cf || []).map((f) => [f.key, f.label]));
  const keys = [...new Set([...Object.keys(A.custom || {}), ...Object.keys(B.custom || {})])];
  const rows = [...MERGE_FIELDS[entity].map(([k, l]) => ({ f: k, label: l, a: A[k], b: B[k] })),
    ...keys.map((k) => ({ f: 'custom.' + k, label: cfl[k] || k, a: (A.custom || {})[k], b: (B.custom || {})[k] }))]
    .map((r) => ({ ...r, kind: same(r.a, r.b) ? 'same' : !show(r.a) || !show(r.b) ? 'fill' : 'diff' }));
  const name = (r) => (entity === 'people' ? fullName(r) : r.name) || '(no name)';
  let keep = 'a', onlyDiff = true;
  const pick = {};   // field -> 'a' | 'b', for real differences
  const draw = () => {
    rows.filter((r) => r.kind === 'diff').forEach((r) => { if (!pick[r.f]) pick[r.f] = keep; });
    const vis = rows.filter((r) => !onlyDiff || r.kind === 'diff');
    const cell = (r, side) => {
      const v = show(r[side]);
      if (r.kind !== 'diff') return `<td>${v ? esc(v) : '<span class="hint" style="margin:0">blank</span>'}${r.kind === 'fill' && v ? ' <small class="badge">fills in</small>' : ''}</td>`;
      return `<td><label class="check" style="min-height:0;margin:0"><input type="radio" name="mp_${esc(r.f)}" value="${side}" ${pick[r.f] === side ? 'checked' : ''}> ${esc(v)}</label></td>`;
    };
    box.innerHTML = `<div class="toolbar"><h2 style="flex:1;margin:0">Compare and merge</h2><button class="btn ghost small" id="mpX">Close</button></div>
      <p class="hint">Pick the value to keep for each difference. Blank fields fill in from the other record. Every value that isn't kept goes into a note on the record you keep.</p>
      <div class="row"><label class="check"><input type="radio" name="mpKeep" value="a" ${keep === 'a' ? 'checked' : ''}> Keep <b>${esc(name(A))}</b> <small class="hint" style="display:inline;margin:0">added ${esc(fmtDate(A.created_at))}</small></label>
        <label class="check"><input type="radio" name="mpKeep" value="b" ${keep === 'b' ? 'checked' : ''}> Keep <b>${esc(name(B))}</b> <small class="hint" style="display:inline;margin:0">added ${esc(fmtDate(B.created_at))}</small></label></div>
      <label class="check"><input type="checkbox" id="mpOnly" ${onlyDiff ? 'checked' : ''}> Show only what's different (${rows.filter((r) => r.kind === 'diff').length} of ${rows.length} fields)</label>
      <div style="overflow:auto"><table class="tbl" style="width:100%"><thead><tr><th>Field</th><th>${esc(name(A))}</th><th>${esc(name(B))}</th></tr></thead>
        <tbody>${vis.map((r) => `<tr><th style="text-align:left;font-weight:600">${esc(r.label)}</th>${cell(r, 'a')}${cell(r, 'b')}</tr>`).join('') || '<tr><td colspan="3" class="hint">No differences. Merging just fills blanks and keeps one record.</td></tr>'}</tbody></table></div>
      <div class="actions"><button class="btn" id="mpGo">Merge into ${esc(name(keep === 'a' ? A : B))}</button></div>`;
    $('#mpX', box).onclick = () => box.close();
    $$('[name=mpKeep]', box).forEach((x) => (x.onchange = () => { const was = keep; keep = x.value; Object.keys(pick).forEach((f) => { if (pick[f] === was) pick[f] = keep; }); draw(); }));
    $('#mpOnly', box).onchange = (e) => { onlyDiff = e.target.checked; draw(); };
    $$('input[type=radio][name^="mp_"]', box).forEach((x) => (x.onchange = () => { pick[x.name.slice(3)] = x.value; }));
    $('#mpGo', box).onclick = async (e) => {
      const keepId = keep === 'a' ? A.id : B.id, dropId = keep === 'a' ? B.id : A.id;
      const take = Object.entries(pick).filter(([, side]) => side !== keep).map(([f]) => f);
      e.target.disabled = true; e.target.textContent = 'Merging…';
      const { error: er } = await sb.rpc('merge_pick', { p_entity: entity, p_keep: keepId, p_drop: dropId, p_take: take });
      if (er) { e.target.disabled = false; e.target.textContent = 'Merge'; return fail(er); }
      box.close(); FACETS = null; toast('Merged. What wasn\'t kept is in a note on the record.'); renderShell();
    };
  };
  let box = $('#mergeDlg');
  if (!box) { box = document.createElement('dialog'); box.id = 'mergeDlg'; box.className = 'vdlg'; document.body.appendChild(box); }
  draw(); box.showModal();
}

/* ================= SUGGESTIONS (side tab for everyone; only Chris reads them) ================= */
// The database enforces who can read these. This id only decides whether to show the section.
const SUG_OWNER = 'a4643b4e-012b-4b1a-9aac-ac35002048b2';
const isSugOwner = () => S.me?.id === SUG_OWNER;
const APP_VERSION = (() => { try { return new URL(document.querySelector('script[src*="app.js"]').src).searchParams.get('v') || ''; } catch { return ''; } })();
const VIEW_NAMES = { add: 'Quick Add', orgs: 'Organizations', org: 'Organization page', people: 'People', myday: 'My Day', sales: 'Sales overview',
  pipeline: 'Pipeline', proposals: 'Proposals', proposal: 'Proposal builder', inbox: 'Inbox', chat: 'Internal chat', teamdir: 'Team profiles', sites: 'Sites', team: 'Team', review: 'Review',
  archive: 'Archive', lists: 'Lists', history: 'History', settings: 'Settings', pricing: 'Pricing', accounts: 'Accounts', import: 'Import',
  directories: 'Directories', directory: 'Directory', bids: 'Bids', bid: 'Bid', bidsetup: 'Bids setup' };
const sugShot = { blob: null, url: '' }, sugVid = { blob: null, url: '' };

// markup: draw, box or point at things on a screenshot before sending it
// turn any image file into something we can draw on: decode it directly (handles big phone photos), shrink to 2400px max
async function loadForMarkup(blob) {
  let src;
  try { src = await createImageBitmap(blob); }
  catch {
    src = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = r.result; }; r.onerror = no; r.readAsDataURL(blob); });
  }
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight, k = Math.min(1, 2400 / Math.max(w, h));
  if (!w || !h) throw new Error('empty image');
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}
function openMarkup(blob) {
  return new Promise((done) => {
    loadForMarkup(blob).then((img) => {
      const ov = document.createElement('div'); ov.className = 'mkover';
      ov.innerHTML = `<div class="mkbar"><div class="seg" id="mkTool"><button type="button" data-t="pen" class="on">✎ Draw</button><button type="button" data-t="box">▢ Box</button><button type="button" data-t="arrow">➜ Arrow</button></div>
        <div class="mkcolors">${['#E5383B', '#F4C430', '#2E6FD8'].map((c, i) => `<button type="button" data-c="${c}" class="${i ? '' : 'on'}" style="background:${c}" aria-label="Color"></button>`).join('')}</div>
        <button type="button" class="btn ghost small" id="mkUndo">Undo</button><span style="flex:1"></span>
        <button type="button" class="btn ghost small" id="mkX">Cancel</button><button type="button" class="btn gold small" id="mkOk">Done</button></div>
        <div class="mkstage"><canvas id="mkCanvas"></canvas></div>`;
      document.body.appendChild(ov);
      const cv = $('#mkCanvas', ov), g = cv.getContext('2d'); cv.width = img.width; cv.height = img.height;
      const lw = Math.max(3, Math.round(cv.width / 320)), marks = []; let tool = 'pen', color = '#E5383B', cur = null;
      const arrow = (a, b) => { const ang = Math.atan2(b.y - a.y, b.x - a.x), h = lw * 5; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
        g.moveTo(b.x, b.y); g.lineTo(b.x - h * Math.cos(ang - 0.45), b.y - h * Math.sin(ang - 0.45)); g.moveTo(b.x, b.y); g.lineTo(b.x - h * Math.cos(ang + 0.45), b.y - h * Math.sin(ang + 0.45)); g.stroke(); };
      const paint = () => {
        g.drawImage(img, 0, 0);
        [...marks, cur].filter(Boolean).forEach((m) => {
          g.strokeStyle = m.color; g.lineWidth = lw; g.lineCap = g.lineJoin = 'round';
          if (m.t === 'pen') { g.beginPath(); m.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.stroke(); }
          else if (m.t === 'box') { g.strokeRect(m.a.x, m.a.y, m.b.x - m.a.x, m.b.y - m.a.y); }
          else arrow(m.a, m.b);
        });
      };
      const pt = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height }; };
      cv.onpointerdown = (e) => { cv.setPointerCapture(e.pointerId); const p = pt(e); cur = tool === 'pen' ? { t: 'pen', color, pts: [p] } : { t: tool, color, a: p, b: p }; paint(); };
      cv.onpointermove = (e) => { if (!cur) return; const p = pt(e); if (cur.t === 'pen') cur.pts.push(p); else cur.b = p; paint(); };
      cv.onpointerup = cv.onpointercancel = () => { if (cur) marks.push(cur); cur = null; paint(); };
      $$('#mkTool [data-t]', ov).forEach((b) => (b.onclick = () => { tool = b.dataset.t; $$('#mkTool [data-t]', ov).forEach((x) => x.classList.toggle('on', x === b)); }));
      $$('[data-c]', ov).forEach((b) => (b.onclick = () => { color = b.dataset.c; $$('[data-c]', ov).forEach((x) => x.classList.toggle('on', x === b)); }));
      $('#mkUndo', ov).onclick = () => { marks.pop(); paint(); };
      const close = (out) => { ov.remove(); done(out); };
      $('#mkX', ov).onclick = () => close(null);
      $('#mkOk', ov).onclick = () => (marks.length ? cv.toBlob((b) => close(b), 'image/jpeg', 0.88) : close(null));
      paint();
    }).catch((e) => {
      console.error('markup', e, blob?.type, blob?.size);
      toast(`Couldn't open that image to mark up (${blob?.type || 'unknown type'}, ${Math.round((blob?.size || 0) / 1024)} KB). Send it as is, or mark it up in your phone or computer's photo editor and attach it.`);
      done(null);
    });
  });
}

// screen recording: up to 30 seconds, starting on the CRM tab itself (a window or screen still works where the browser offers it)
async function recordScreen(onStart) {
  let stream;
  // Chrome and Edge offer this tab first (preferCurrentTab), so people don't have to hunt through their other tabs
  try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15, displaySurface: 'browser' }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude' }); }
  catch (e) {
    console.error('screen record', e);
    const why = {
      NotAllowedError: 'Recording didn\'t start. Either Cancel was clicked, or the browser blocked it. In the box that pops up, pick a tab, window or screen, then click Share.',
      NotFoundError: 'Your computer didn\'t offer anything to record. Try picking a Chrome tab instead of the whole screen.',
      NotReadableError: 'Another program is blocking screen recording. Close other screen sharing (Zoom, Teams, Meet) and try again.',
      AbortError: 'Recording was interrupted. Try again.',
    }[e?.name] || `Recording couldn't start (${e?.name || 'unknown problem'}). Try a Chrome tab, or attach a phone or Windows screen recording instead.`;
    toast(why); return null;
  }
  const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  let rec; const parts = [];
  try { rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 1_000_000 }); }
  catch (e) { stream.getTracks().forEach((t) => t.stop()); toast(`This browser can't record the screen (${e?.name || 'not supported'}). Attach a recording made with Windows (Win+Shift+R on Windows 11) or your phone instead.`); return null; }
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  onStart?.();
  const pill = document.createElement('div'); pill.className = 'recpill';
  pill.innerHTML = '<span class="dot"></span> Recording <b id="recT">0:00</b> of 0:30 <button type="button" class="btn small" id="recStop">Stop</button>';
  document.body.appendChild(pill);
  const t0 = Date.now();
  return new Promise((done) => {
    const tick = setInterval(() => { const sec = Math.floor((Date.now() - t0) / 1000); $('#recT').textContent = `0:${String(sec).padStart(2, '0')}`; if (sec >= 30) stop(); }, 250);
    const stop = () => { if (rec.state !== 'inactive') rec.stop(); };
    rec.onstop = () => { clearInterval(tick); pill.remove(); stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(parts, { type: (type || 'video/webm').split(';')[0] });
      if (blob.size > 25 * 1024 * 1024) { toast('That recording is too big. Try a shorter one.'); return done(null); }
      if (!blob.size) toast('The recording came out empty. Try again, and pick a Chrome tab if a window or screen doesn\'t work.');
      done(blob.size ? blob : null); };
    stream.getVideoTracks()[0].onended = stop;   // they hit the browser's own "Stop sharing"
    $('#recStop').onclick = stop;
    rec.start(1000);
  });
}
// Chrome and Edge can tell Windows 11 from 10 (platform version 13+ is 11); other browsers just say Windows
let osExact = '';
try { navigator.userAgentData?.getHighEntropyValues(['platformVersion']).then((v) => {
  if (navigator.userAgentData.platform === 'Windows') osExact = parseInt(v.platformVersion, 10) >= 13 ? 'Windows 11' : 'Windows 10';
  else if (navigator.userAgentData.platform === 'macOS') osExact = 'Mac';
}).catch(() => {}); } catch {}
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = osExact || (/android/i.test(ua) ? 'Android' : /iphone|ipad|ipod/i.test(ua) ? 'iPhone/iPad' : /mac/i.test(ua) ? 'Mac' : /windows/i.test(ua) ? 'Windows' : /linux/i.test(ua) ? 'Linux' : 'Other');
  const br = /edg\//i.test(ua) ? 'Edge' : /chrome|crios/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : 'Browser';
  return `${os}, ${br}${matchMedia('(display-mode: standalone)').matches ? ', installed app' : ''}`;
}
function mountSuggest() {
  if (!S.me || $('#sugTab')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <button type="button" id="sugTab" class="sugtab" aria-label="Send a suggestion">Suggest</button>
    <aside id="sugPanel" class="sugpanel" hidden aria-label="Send a suggestion">
      <div class="toolbar"><h2 style="margin:0;flex:1">Got an idea?</h2><button type="button" class="btn ghost small" id="sugX" aria-label="Close">✕</button></div>
      <p class="hint" style="margin:0">Tell us what would make this better, or what got in your way. It goes straight to Chris.</p>
      <textarea id="sugBody" rows="5" placeholder="What would you change here?"></textarea>
      <div class="sugshot"><button type="button" class="btn secondary small" id="sugCap">Capture this screen</button>
        <label class="btn ghost small" style="margin:0">Attach image or video<input type="file" id="sugFile" accept="image/*,video/*" hidden></label>
        ${navigator.mediaDevices?.getDisplayMedia && window.MediaRecorder ? '<button type="button" class="btn ghost small" id="sugRec">Record screen (30 sec)</button>' : ''}</div>
      <div id="sugPrev"></div>
      <small class="hint" id="sugCtx"></small>
      <div class="err" id="sugErr"></div>
      <div class="actions"><button type="button" class="btn" id="sugSend">Send suggestion</button></div>
    </aside>`);
  const panel = $('#sugPanel');
  const ctx = () => { const v = VIEW_NAMES[S.view] || S.view || 'this screen', h = ($('#view h1')?.textContent || '').trim().slice(0, 60);
    return `Sent along with it: Screen: ${v}${h && h.toLowerCase() !== String(v).toLowerCase() ? ` (${h})` : ''} · Device: ${deviceLabel()} · Window: ${window.innerWidth}×${window.innerHeight}`; };
  const showPrev = () => {
    $('#sugPrev').innerHTML = (sugShot.url ? `<div class="sugprev"><img src="${sugShot.url}" alt="Screenshot"><div class="sugprevbtns"><button type="button" class="btn secondary small" id="sugMark">Mark up</button><button type="button" class="btn ghost small" id="sugRm">Remove</button></div></div>` : '')
      + (sugVid.url ? `<div class="sugprev"><video src="${sugVid.url}" controls playsinline></video><div class="sugprevbtns"><button type="button" class="btn ghost small" id="sugVidRm">Remove recording</button></div></div>` : '');
    if ($('#sugRm')) $('#sugRm').onclick = () => { sugShot.blob = null; sugShot.url = ''; showPrev(); };
    if ($('#sugMark')) $('#sugMark').onclick = async () => { const out = await openMarkup(sugShot.blob); if (out) setShot(out); };
    if ($('#sugVidRm')) $('#sugVidRm').onclick = () => { URL.revokeObjectURL(sugVid.url); sugVid.blob = null; sugVid.url = ''; showPrev(); };
  };
  const setShot = (blob) => {
    sugShot.blob = blob; sugShot.url = '';
    if (!blob) return showPrev();
    const r = new FileReader(); r.onload = () => { if (sugShot.blob === blob) { sugShot.url = r.result; showPrev(); } }; r.readAsDataURL(blob);
  };
  $('#sugTab').onclick = () => { panel.hidden = !panel.hidden; if (!panel.hidden) { $('#sugCtx').textContent = ctx(); $('#sugBody').focus(); } };
  $('#sugX').onclick = () => (panel.hidden = true);
  if ($('#sugRec')) $('#sugRec').onclick = async () => {
    const blob = await recordScreen(() => (panel.hidden = true));
    panel.hidden = false;
    if (blob) { if (sugVid.url) URL.revokeObjectURL(sugVid.url); sugVid.blob = blob; sugVid.url = URL.createObjectURL(blob); showPrev(); }
  };
  $('#sugFile').onchange = (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    if (/^video\//.test(f.type)) {   // a clip from the phone's own screen recorder
      if (!/webm|mp4|quicktime/.test(f.type)) return toast('Use an MP4, MOV or WebM video');
      if (f.size > 25 * 1024 * 1024) return toast('Videos must be under 25 MB. Trim it to the part that matters.');
      sugVid.blob = f; sugVid.url = URL.createObjectURL(f); return showPrev();
    }
    if (f.size > 8 * 1024 * 1024) return toast('Images must be under 8 MB');
    setShot(f);
  };
  $('#sugCap').onclick = async () => {
    const btn = $('#sugCap'); btn.disabled = true; btn.textContent = 'Capturing…';
    try {
      if (!window.html2canvas) await new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js'; sc.onload = ok; sc.onerror = no; document.head.appendChild(sc); });
      panel.hidden = true;
      const canvas = await window.html2canvas(document.body, { useCORS: true, logging: false, scale: Math.min(window.devicePixelRatio || 1, 2),
        x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight,
        ignoreElements: (el) => el.id === 'sugPanel' || el.id === 'sugTab' || el.id === 'toast' });
      panel.hidden = false;
      const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.85));
      if (!blob || !blob.size) throw new Error('capture came back empty');
      setShot(blob);
      const marked = await openMarkup(blob); if (marked) setShot(marked);
    } catch (e) { panel.hidden = false; console.error(e); toast("Couldn't capture the screen. Attach a screenshot instead."); }
    btn.disabled = false; btn.textContent = 'Retake';
  };
  $('#sugSend').onclick = async () => {
    const body = $('#sugBody').value.trim(); const err = $('#sugErr'); err.textContent = '';
    if (!body) return (err.textContent = 'Write a few words about your idea first.');
    const btn = $('#sugSend'); btn.disabled = true; btn.textContent = 'Sending…';
    let path = null;
    if (sugShot.blob) {
      const ext = (sugShot.blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      path = `${S.me.id}/${Date.now()}.${ext}`;
      const up = await sb.storage.from('feedback').upload(path, sugShot.blob, { contentType: sugShot.blob.type || 'image/png', upsert: false });
      if (up.error) { console.error(up.error); path = null; }
    }
    let vpath = null;
    if (sugVid.blob) {
      vpath = `${S.me.id}/${Date.now()}.${/mp4|quicktime/.test(sugVid.blob.type) ? 'mp4' : 'webm'}`;
      const up = await sb.storage.from('feedback').upload(vpath, sugVid.blob, { contentType: /quicktime/.test(sugVid.blob.type) ? 'video/mp4' : (sugVid.blob.type.split(';')[0] || 'video/webm'), upsert: false });
      if (up.error) { console.error(up.error); vpath = null; toast(`The recording didn't upload (${up.error.message || 'upload failed'}), so the suggestion went without it.`); }
    }
    const { error } = await sb.from('suggestions').insert({ body, view: S.view, record_id: S.param || null,
      page_title: ($('#view h1')?.textContent || '').trim().slice(0, 200) || null, url: location.href.slice(0, 500),
      device: deviceLabel(), screen: `${window.innerWidth}x${window.innerHeight}`, app_version: APP_VERSION, screenshot_path: path, video_path: vpath });
    btn.disabled = false; btn.textContent = 'Send suggestion';
    if (error) return (err.textContent = error.message);
    $('#sugBody').value = ''; setShot(null); if (sugVid.url) URL.revokeObjectURL(sugVid.url); sugVid.blob = null; sugVid.url = ''; $('#sugCap').textContent = 'Capture this screen';
    panel.hidden = true; toast('Thanks! Your suggestion was sent.');
    if (isSugOwner()) refreshCounts();
  };
}

let sugAll = false;
async function renderSuggestions(box) {
  let q = sb.from('suggestions').select('*').order('created_at', { ascending: false }).limit(200);
  if (!sugAll) q = q.eq('status', 'new');
  const { data, error } = await q; if (error) throw error;
  const rows = data || [];
  const paths = rows.flatMap((r) => [r.screenshot_path, r.video_path]).filter(Boolean);
  const shots = {};
  if (paths.length) ((await sb.storage.from('feedback').createSignedUrls(paths, 3600)).data || []).forEach((x) => { if (x.signedUrl) shots[x.path] = x.signedUrl; });
  const here = S.acct?.id;
  box.innerHTML = `<div class="toolbar" style="margin-top:6px"><h2 class="section" style="margin:0;flex:1">Suggestions${sugAll ? '' : ` (${rows.length} new)`}</h2>
      <label class="check" style="margin:0"><input type="checkbox" id="sugAll" ${sugAll ? 'checked' : ''}> Show handled</label></div>
    <small class="hint" style="display:block;margin:-2px 0 10px">Only you can see these. They come from everyone, in every account.</small>
    ${rows.map((r) => `<div class="card sugcard ${r.status !== 'new' ? 'handled' : ''}" data-sug="${r.id}">
      <div class="toolbar"><div style="flex:1"><b>${esc(r.user_name || 'Someone')}</b>${r.account_name ? ` <span class="badge">${esc(r.account_name)}</span>` : ''}
        <br><small>${esc(new Date(r.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }))}${r.times > 1 ? ` · <b>${r.times} times</b>${r.last_at ? ', last ' + esc(fmtDate(r.last_at)) : ''}` : ''}</small></div>
        ${r.status !== 'new' ? `<span class="badge ${r.status === 'done' ? 'ok' : ''}">${r.status === 'done' ? 'Done' : 'Not doing'}</span>` : ''}</div>
      <p class="sugbody">${esc(r.body).replace(/\n/g, '<br>')}</p>
      ${r.screenshot_path && shots[r.screenshot_path] ? `<a href="${esc(shots[r.screenshot_path])}" target="_blank" rel="noopener" class="sugthumb"><img src="${esc(shots[r.screenshot_path])}" alt="Screenshot from ${esc(r.user_name || '')}"></a>` : ''}
      ${r.video_path && shots[r.video_path] ? `<video class="sugvid" src="${esc(shots[r.video_path])}" controls preload="metadata" playsinline></video>` : ''}
      <small class="hint">${esc([`On ${VIEW_NAMES[r.view] || r.view || 'unknown screen'}${r.page_title ? ` (“${r.page_title}”)` : ''}`, r.device, r.screen, r.app_version ? 'version ' + r.app_version : ''].filter(Boolean).join(' · '))}</small>
      <div class="actions">${r.view ? (r.tenant_id === here ? `<button class="btn ghost small" data-sgo="${esc(r.view)}" data-sparam="${esc(r.record_id || '')}">Go to that screen</button>`
          : `<small class="hint" style="margin:0">Sent from ${esc(r.account_name || 'another account')}. Switch to that account to open the screen.</small>`) : ''}
        ${r.status === 'new' ? `<button class="btn small" data-sset="done">Done</button><button class="btn secondary small" data-sset="not_doing">Not doing</button>`
          : `<button class="btn ghost small" data-sset="new">Reopen</button>`}</div></div>`).join('') || `<p class="empty">${sugAll ? 'No suggestions yet.' : 'No new suggestions.'}</p>`}`;
  $('#sugAll').onchange = (e) => { sugAll = e.target.checked; renderSuggestions(box).catch(fail); };
  $$('[data-sgo]', box).forEach((b) => (b.onclick = () => go(b.dataset.sgo, b.dataset.sparam || null)));
  $$('[data-sug]', box).forEach((card) => $$('[data-sset]', card).forEach((b) => (b.onclick = async () => {
    const { error: e } = await sb.from('suggestions').update({ status: b.dataset.sset }).eq('id', card.dataset.sug);
    if (e) return fail(e);
    toast(b.dataset.sset === 'done' ? 'Marked done' : b.dataset.sset === 'not_doing' ? 'Marked not doing' : 'Reopened');
    refreshCounts(); renderSuggestions(box).catch(fail);
  })));
}

/* ================= ADMIN: ARCHIVE ================= */
let archTab = 'companies';
async function viewArchive(main) {
  const q = archTab === 'companies'
    ? sb.from('companies').select('id,name,org_types,city,state,archived_at,archived_by,archive_reason,archive_status').not('archived_at', 'is', null).order('archived_at', { ascending: false }).limit(500)
    : sb.from('people').select('id,first_name,last_name,personal_cell,archived_at,archived_by,archive_reason,archive_status').not('archived_at', 'is', null).order('archived_at', { ascending: false }).limit(500);
  const { data, error } = await q; if (error) throw error;
  main.innerHTML = `<h1>Archive</h1><p class="empty">Deleted records rest here forever. Restore puts them right back.</p>
    <div class="seg" style="margin-bottom:12px"><button class="${archTab === 'companies' ? 'on' : ''}" data-at="companies">Organizations</button><button class="${archTab === 'people' ? 'on' : ''}" data-at="people">People</button></div>
    <div class="list">${(data || []).map((r) => `<div class="item static"><b>${esc(r.name || fullName(r))}</b>
      <small>${esc(r.archive_reason || '')}</small>
      <div class="meta"><span class="badge ${r.archive_status === 'pending' ? 'due' : ''}">${r.archive_status === 'pending' ? 'Pending approval' : 'Archived'}</span>
        <span class="badge">${esc(fmtDate(r.archived_at))}</span>${r.archived_by ? `<span class="badge">${esc(userName(r.archived_by))}</span>` : ''}</div>
      <div class="quick"><button class="btn small" data-restore="${r.id}">Restore</button><button class="btn ghost small" data-view="${r.id}">View</button></div></div>`).join('') || '<p class="empty">Nothing archived.</p>'}</div>`;
  $$('[data-at]').forEach((b) => (b.onclick = () => { archTab = b.dataset.at; renderShell(); }));
  $$('[data-view]').forEach((b) => (b.onclick = () => go(archTab === 'companies' ? 'org' : 'people', b.dataset.view)));
  $$('[data-restore]').forEach((b) => (b.onclick = async () => {
    const { error } = await sb.rpc('restore_record', { p_entity: archTab, p_id: b.dataset.restore });
    if (error) return fail(error); FACETS = null; toast('Restored'); renderShell();
  }));
}

/* ================= ADMIN: HISTORY ================= */
const histF = { who: '', table: '' };
/* ================= PRICING (admin) ================= */
// Numbers are settings an admin can change here. The pricing logic itself stays in code; changes to it are quoted as dev work.
// Proposals already sent keep the prices they went out with (held on the proposal at first send).
const PRICE_GROUPS = [
  ['Hourly rates', 'Custom websites, custom funnels and extra monthly hours are billed by the hour.', [
    ['rate_partner', 'Rate with a RLX page', '$', '/hr', 'When the client has a page in the same phase or earlier'],
    ['rate_standard', 'Rate without a page', '$', '/hr'],
    ['labor_cost', 'Your cost per hour', '$', '/hr', 'Internal, used for margins. Never shown to reps or clients'],
  ]],
  ['Default hours', 'What a new custom line starts at. Reps can change it on each proposal.', [
    ['funnel_default_hours', 'Custom funnel', '', 'hrs', '', 'int'],
    ['site_default_hours', 'Custom website', '', 'hrs', '', 'int'],
  ]],
  ['Hosting and care', 'Monthly, per website or funnel that isn\'t covered by a RLX page.', [
    ['host_first', 'First one, no page', '$', '/mo'],
    ['host_next', 'Each one after, no page', '$', '/mo'],
    ['host_partner', 'Each one, with a page', '$', '/mo'],
    ['host_unit_cost', 'Your cost per site', '$', '/mo', 'Internal, used for margins'],
  ]],
  ['Discount guardrails', 'The margin a deal needs after discounts and the commission reserve. Below red, the proposal is blocked until an admin overrides it.', [
    ['green', 'Green at or above', '', '%', '', 'pct'],
    ['yellow', 'Yellow at or above', '', '%', 'Red-light deals cut the closer\'s rate', 'pct'],
    ['red', 'Red at or above', '', '%', '', 'pct'],
  ]],
  ['Commission', 'Each person\'s own sales and lead rates are set on Team.', [
    ['commission_reserve', 'Commission reserve', '', '%', 'Held back from revenue before margin is figured', 'pct'],
    ['default_lead_rate', 'Lead rate when no referrer is named', '', '%', '', 'pct'],
  ]],
  ['Payback', 'A deep setup discount can still go out if the monthly profit pays it back in time.', [
    ['payback_months', 'Payback within', '', 'months', '', 'int'],
    ['min_term_months', 'Minimum term on payback deals', '', 'months', '', 'int'],
  ]],
  ['Proposals', '', [
    ['expire_days', 'Proposals expire after', '', 'days', 'Then the deal moves to Closed Lost', 'int'],
    ['lock_min', 'Shortest price lock for later phases', '', 'months', '', 'int'],
    ['lock_max', 'Longest price lock', '', 'months', 'Up to 36', 'int'],
  ]],
];
// Online payment: GELP's own Stripe account only. Keys live in Supabase secrets; this card shows whether they're in and flips the switch.
async function renderPayCard() {
  const box = $('#payCard'); if (!box) return;
  const { data: c, error } = await sb.functions.invoke('proposal-checkout', { body: { action: 'check' } });
  if (!box.isConnected) return;
  if (error || !c || c.error) { box.innerHTML = `<h2>Online payment on accept</h2><p class="empty" style="margin:0">Couldn't check Stripe right now${c?.error ? ': ' + esc(c.error) : ''}. Refresh to try again.</p>`; return; }
  const row = (ok, label, detail) => `<div class="paychk ${ok ? 'ok' : 'no'}"><b>${ok ? '✓' : '✗'}</b><span>${esc(label)}${detail ? `<small>${esc(detail)}</small>` : ''}</span></div>`;
  const ready = c.key && c.key_works && c.webhook_secret;
  box.innerHTML = `<h2>Online payment on accept</h2>
    <small class="hint" style="margin:-4px 0 10px">When it's on, a client who accepts a GELP proposal goes straight to a secure Stripe page to pay the setup and start the monthly billing. Money goes to GELP's Stripe account. Other accounts never get this.</small>
    ${row(c.key, 'Stripe secret key', c.key ? `${c.mode === 'live' ? 'Live' : 'Test'} mode${c.restricted ? ', restricted key' : ''}` : 'Add STRIPE_SECRET_KEY in Supabase Edge Function secrets')}
    ${c.key ? row(c.key_works, 'Key works with Stripe', c.key_works ? '' : (c.key_error || 'Stripe turned the key down')) : ''}
    ${row(c.webhook_secret, 'Webhook signing secret', c.webhook_secret ? '' : 'Add STRIPE_WEBHOOK_SECRET in Supabase Edge Function secrets')}
    <div class="payswitch"><span>Online payment is <b>${c.enabled ? 'ON' : 'OFF'}</b>${c.updated_by ? ` <small class="hint" style="display:inline">(changed by ${esc(c.updated_by)}, ${esc(fmtDate(c.updated_at))})</small>` : ''}${c.enabled && c.mode !== 'live' ? ' <span class="badge gold">Test mode: no real charges</span>' : ''}</span>
      <button type="button" class="btn ${c.enabled ? 'ghost' : ''} small" id="paySw" ${!c.enabled && !ready ? 'disabled title="Finish the steps above first"' : ''}>${c.enabled ? 'Turn off' : 'Turn on'}</button></div>`;
  $('#paySw').onclick = async () => {
    const on = !c.enabled;
    if (on && !confirm(`Turn on online payment${c.mode === 'live' ? ' with LIVE charges' : ' (test mode)'}? Clients who accept a GELP proposal will be sent to Stripe to pay.`)) return;
    const { error: e } = await sb.rpc('payments_set', { p_on: on });
    if (e) return fail(e);
    toast(on ? 'Online payment is on' : 'Online payment is off'); renderPayCard();
  };
}
async function viewPricing(main) {
  const { data, error } = await sb.rpc('proposal_settings_get');
  if (error) throw error;
  if (!data?.settings) { main.innerHTML = '<h1>Pricing</h1><p class="empty">Proposals aren\'t set up for this account yet.</p>'; return; }
  const st = data.settings, book = data.book || [];
  const shown = (k, kind) => kind === 'pct' ? Math.round(Number(st[k]) * 1000) / 10 : Number(st[k]);
  const field = ([k, label, pre, post, hint, kind]) => `<label><span class="label">${esc(label)}</span>
    <span class="inwrap">${pre ? `<span>${pre}</span>` : ''}<input type="number" min="0" step="${kind === 'int' ? 1 : kind === 'pct' ? 0.1 : 1}" data-set="${k}" data-kind="${kind || 'money'}" value="${esc(shown(k, kind))}"><span>${esc(post)}</span></span>
    ${hint ? `<small>${esc(hint)}</small>` : ''}</label>`;
  main.innerHTML = `<div class="pricing">
    <h1>Pricing</h1>
    <div class="card" id="payCard"><h2>Online payment on accept</h2><p class="empty" style="margin:0">Checking Stripe…</p></div>
    <p class="hint" style="margin-top:-6px">The rules that price proposals. What each item sells for, its cost and its margin are in <a href="#products">Products/services</a>. Changes apply to new proposals and drafts. Anything already sent keeps the prices it went out with; an admin can move one onto current prices from the proposal. Every change is in History.</p>
    ${PRICE_GROUPS.map(([title, sub, fields]) => `<div class="card"><h2>${esc(title)}</h2>${sub ? `<small class="hint" style="margin:-4px 0 10px">${esc(sub)}</small>` : ''}<div class="pgrid">${fields.map(field).join('')}</div></div>`).join('')}
    <div class="card askq"><div><h2 style="margin:0">Want custom logic?</h2><small class="hint" style="margin:2px 0 0">New rules, like bundles, tiered discounts or a different commission split, are built by the dev team.</small></div>
      <button type="button" class="btn secondary" id="prAsk">Ask for a quote</button></div>
    <div id="prAskBox"></div>
    <div class="savebar"><small class="hint" id="prState" style="margin:0"></small><button type="button" class="btn ghost" id="prReset">Undo changes</button><button type="button" class="btn" id="prSave">Save prices</button></div>
  </div>`;
  renderPayCard();
  const dirty = () => { $('#prState').textContent = 'Unsaved changes'; };
  $$('[data-set],[data-bk]', main).forEach((el) => (el.oninput = dirty));
  $('#prReset').onclick = () => viewPricing(main);
  $('#prSave').onclick = async () => {
    const settings = {};
    for (const el of $$('[data-set]', main)) {
      if (el.value.trim() === '' || isNaN(Number(el.value))) return toast('Fill in every number');
      let v = Number(el.value);
      if (el.dataset.kind === 'pct') v = Math.round(v * 10) / 1000;
      if (el.dataset.kind === 'int' && !Number.isInteger(v)) return toast('Use whole numbers for hours, days and months');
      if (Number(st[el.dataset.set]) !== v) settings[el.dataset.set] = v;
    }
    const rows = {};
    $$('[data-bk]', main).forEach((el) => { (rows[el.dataset.bk] ||= { key: el.dataset.bk })[el.dataset.bf] = el.dataset.bf === 'title' || el.dataset.bf === 'description' ? el.value : Number(el.value); });
    const changedBook = Object.values(rows).filter((r) => { const b = book.find((x) => x.key === r.key); return Object.keys(r).some((k) => k !== 'key' && String(r[k]) !== String(k === 'title' || k === 'description' ? b[k] : Number(b[k]))); });
    if (!Object.keys(settings).length && !changedBook.length) return toast('Nothing changed');
    const btn = $('#prSave'); btn.disabled = true; btn.textContent = 'Saving…';
    const { error: e } = await sb.rpc('proposal_settings_save', { p: { settings, book: changedBook } });
    btn.disabled = false; btn.textContent = 'Save prices';
    if (e) return fail(e);
    PRICES = null; toast('Prices saved'); viewPricing(main);
  };
  $('#prAsk').onclick = () => {
    const box = $('#prAskBox');
    box.innerHTML = `<div class="card"><h2>Ask for a custom logic quote</h2>
      <label class="label" for="prAskTxt">What should the pricing do?</label>
      <textarea id="prAskTxt" rows="4" placeholder="Example: when a client takes 3 or more template sites, take 10% off the setup, and pay the closer 2% more on those deals."></textarea>
      <div class="actions"><button type="button" class="btn ghost small" id="prAskX">Cancel</button><button type="button" class="btn small" id="prAskGo">Send request</button></div></div>`;
    $('#prAskTxt').focus();
    $('#prAskX').onclick = () => (box.innerHTML = '');
    $('#prAskGo').onclick = async () => {
      const t = $('#prAskTxt').value.trim();
      if (!t) return toast('Describe what you need');
      const { error: e } = await sb.from('suggestions').insert({ body: 'Custom pricing logic, quote requested:\n' + t, view: 'pricing', page_title: 'Pricing',
        url: location.href.slice(0, 500), device: deviceLabel(), screen: `${window.innerWidth}x${window.innerHeight}`, app_version: APP_VERSION });
      if (e) return fail(e);
      box.innerHTML = ''; toast('Request sent. You\'ll get a quote back.');
      if (isSugOwner()) refreshCounts();
    };
  };
}

async function viewHistory(main) {
  main.innerHTML = `<h1>History</h1><p class="empty">Every change anyone makes is recorded here and can't be edited or erased.</p>
    <div class="row" style="margin-bottom:12px">
      <div><label class="label">Who</label><select id="hWho"><option value="">Everyone</option>${S.users.map((u) => `<option value="${u.id}" ${u.id === histF.who ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}</select></div>
      <div><label class="label">What</label><select id="hTable"><option value="">Everything</option>${Object.entries(NOUN).map(([k, v]) => `<option value="${k}" ${k === histF.table ? 'selected' : ''}>${esc(v[0].toUpperCase() + v.slice(1))}</option>`).join('')}</select></div>
    </div>
    <div class="card" id="hList"><p class="empty">Loading…</p></div><div id="hMore"></div>`;
  let rows = [];
  const load = async (more = false) => {
    let q = sb.from('audit_log').select('*').order('id', { ascending: false }).limit(PAGE);
    if (histF.who) q = q.eq('actor', histF.who);
    if (histF.table) q = q.eq('table_name', histF.table);
    if (more && rows.length) q = q.lt('id', rows[rows.length - 1].id);
    const { data, error } = await q; if (error) return fail(error);
    rows = more ? rows.concat(data || []) : (data || []);
    $('#hList').innerHTML = historyList(rows, { showRecord: true });
    $('#hMore').innerHTML = (data || []).length === PAGE ? '<button class="btn secondary block" id="hMoreBtn">Show more</button>' : '';
    if ($('#hMoreBtn')) $('#hMoreBtn').onclick = () => load(true);
  };
  $('#hWho').onchange = (e) => { histF.who = e.target.value; load(); };
  $('#hTable').onchange = (e) => { histF.table = e.target.value; load(); };
  load();
}

/* ================= ADMIN: LISTS ================= */
const LISTS = [
  ['org_type', 'Organization types'], ['person_type', 'Contact types (people)'], ['lead_channel', 'How leads come in'], ['escalation_reason', 'Escalation reasons'],
  ['specialty', 'Specialties / categories'], ['contact_role', 'Contact roles'], ['service', 'Services'], ['opportunity_status', 'Opportunity statuses'],
  ['interest_level', 'Interest levels'], ['preferred_contact', 'Contact methods'],
];
let listSel = 'org_type';
async function viewLists(main) {
  const { data, error } = await sb.from('lookup_values').select('*').eq('list_name', listSel).order('sort_order').order('label');
  if (error) throw error;
  const rows = data || [];
  main.innerHTML = `<h1>Lists</h1><p class="empty">Every dropdown in the CRM comes from these. Renaming a value updates every record that uses it.</p>
    <div class="toolbar"><select id="listPick" style="max-width:360px">${LISTS.map(([k, l]) => `<option value="${k}" ${k === listSel ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="card">${rows.map((r, i) => `<div class="listrow ${r.active ? '' : 'off'}" data-lid="${r.id}">
      <input type="text" value="${esc(r.label)}" data-old="${esc(r.label)}">
      <button class="btn ghost small" data-mv="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
      <button class="btn ghost small" data-mv="1" ${i === rows.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      <button class="btn ghost small" data-tog>${r.active ? 'Hide' : 'Show'}</button></div>`).join('') || '<p class="empty">No values yet.</p>'}
      <div class="listrow add"><input type="text" id="newVal" placeholder="Add a new value"><button class="btn small" id="addVal">Add</button></div>
    </div>`;
  $('#listPick').onchange = (e) => { listSel = e.target.value; renderShell(); };
  const reload = async () => { await loadLookups(); FACETS = null; renderShell(); };
  $$('.listrow[data-lid]').forEach((row) => {
    const id = row.dataset.lid; const r = rows.find((x) => x.id === id); const idx = rows.indexOf(r);
    const inp = $('input', row);
    inp.onchange = async () => {
      const nv = inp.value.trim(); if (!nv || nv === inp.dataset.old) return (inp.value = inp.dataset.old);
      const { error } = await sb.rpc('rename_lookup', { p_list: listSel, p_old: inp.dataset.old, p_new: nv });
      if (error) return fail(error); toast('Renamed everywhere'); reload();
    };
    $$('[data-mv]', row).forEach((b) => (b.onclick = async () => {
      const other = rows[idx + Number(b.dataset.mv)]; if (!other) return;
      const ordered = rows.map((x, n) => ({ id: x.id, sort_order: n + 1 }));
      const a = ordered[idx], c = ordered[idx + Number(b.dataset.mv)]; [a.sort_order, c.sort_order] = [c.sort_order, a.sort_order];
      const results = await Promise.all(ordered.map((o) => sb.from('lookup_values').update({ sort_order: o.sort_order }).eq('id', o.id)));
      const bad = results.find((x) => x.error); if (bad) return fail(bad.error); reload();
    }));
    $('[data-tog]', row).onclick = async () => {
      const { error } = await sb.from('lookup_values').update({ active: !r.active }).eq('id', id);
      if (error) return fail(error); toast(r.active ? 'Hidden from dropdowns' : 'Showing again'); reload();
    };
  });
  $('#addVal').onclick = async () => {
    const v = $('#newVal').value.trim(); if (!v) return;
    const { error } = await sb.from('lookup_values').insert({ list_name: listSel, label: v, sort_order: rows.length + 1 });
    if (error) return fail(error); toast('Added'); reload();
  };
}

/* ================= PROPOSALS ================= */
// Prices, costs and margins are computed in the database (proposal_quote). Reps only ever receive prices and their own
// commission; cost and margin come back only for admins. The client link (/proposal/view/#token) mirrors the live draft.
const money = (n) => (Number(n) < 0 ? '-' : '') + '$' + Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US');
// "$1,000 + $499/mo + $200/week": setup, monthly, and weekly only when there is one
const totalsLabel = (setup, mo, wk) => `${money(setup)} + ${money(mo)}/mo${Number(wk) > 0 ? ` + ${money(wk)}/week` : ''}`;
const pct1 = (n) => n == null || isNaN(n) ? 'n/a' : (Math.round(n * 1000) / 10).toFixed(1) + '%';
const proposalLink = (t) => `${S.pub()}/proposal/view/#${t}`;
const pctShort = (x) => String(Math.round((Number(x) || 0) * 100) / 100);
const PSTATUS = { draft: 'Draft', sent: 'Sent', accepted: 'Accepted' };
// the standard terms, as a starting point when a proposal gets its own (pricing dates and phase locks are added on the client page only when the standard terms are used)
const STD_TERMS = 'Services are month to month and may be cancelled with 30 days written notice. Setup fees are due at signing and are non-refundable once work begins. Monthly fees are billed in advance. RLX services are provided under the RLX user agreement, including the business associate agreement accepted at account creation.';
// Payment on the accepted version (set only by the Stripe functions)
const payBadge = (p) => p.status !== 'accepted' || p.pay_version !== p.accepted_version ? ''
  : p.pay_status === 'paid' ? '<span class="badge ok">Paid</span>'
  : p.pay_status === 'processing' ? '<span class="badge gold">Bank payment clearing</span>'
  : p.pay_status === 'failed' ? '<span class="badge due">Payment failed</span>'
  : '<span class="badge due">Awaiting payment</span>';
const LIGHT = { green: 'Green', yellow: 'Yellow', red: 'Red', blocked: 'Blocked', none: 'No charge' };
const lightPill = (k) => `<span class="light l-${k}">${LIGHT[k] || k}</span>`;
const PLISTS = { pages: 'Page inside RLX', tSites: 'Template website', tFunnels: 'Template funnel', cFunnels: 'Custom funnel', custom: 'Other service' };
let PRICES = null;
async function priceList() {
  if (!PRICES) { const { data, error } = await sb.rpc('proposal_price_list'); if (error) throw error; PRICES = data; }
  return PRICES;
}
const phN = (v) => Math.min(9, Math.max(1, parseInt(v, 10) || 1));
const uid8 = () => Math.random().toString(36).slice(2, 10);
const PH_LISTS = ['pages', 'tSites', 'tFunnels', 'cFunnels', 'custom'];
const lockMin = () => PRICES?.lock_min || 1, lockMax = () => PRICES?.lock_max || 24;
function normItems(it = {}) {
  const L = (a) => (a || []).map((x) => ({ ...x, id: x.id || uid8(), ph: phN(x.ph) }));
  const out = {
    lic: !!it.lic, lic_ph: phN(it.lic_ph), pages: L(it.pages), tSites: L(it.tSites), tFunnels: L(it.tFunnels), cFunnels: L(it.cFunnels),
    custom: L(it.custom).map((x) => ({ name: '', desc: '', note: '', qty: 1, setup: '', setup_cost: '', amt: '', cost: '', ...x, every: x.every === 'week' ? 'week' : 'month' })),
    cs: { on: false, hrs: PRICES?.site_default_hours || 20, name: '', desc: '', note: '', ...(it.cs || {}) },
    ex: { on: false, hrs: 2, ...(it.ex || {}) },
    disc: { setup: 0, month: 0, ...(it.disc || {}) },
    phases: Array.isArray(it.phases) ? it.phases : [],
    lock_months: Math.min(lockMax(), Math.max(lockMin(), parseInt(it.lock_months, 10) || Math.min(lockMax(), Math.max(lockMin(), 6)))),
    note_shared: it.note_shared || '',
    terms_custom: it.terms_custom || '',
    mockups: it.mockups || [],
    trials: it.trials && typeof it.trials === 'object' ? { ...it.trials } : {},
  };
  out.cs.ph = phN(out.cs.ph); out.ex.ph = phN(out.ex.ph);
  out.cFunnels.forEach((x) => { x.hrs = Math.max(1, parseInt(x.hrs, 10) || PRICES?.funnel_default_hours || 18); });
  compactPhases(out);
  return out;
}
// Phases in use are always numbered 1..k with no gaps. Pages and the license are independent (since Oct 26).
function phaseLines(it) {
  const r = [];
  if (it.lic) r.push(['lic', it]);
  PH_LISTS.forEach((k) => it[k].forEach((x) => r.push([k + ':' + x.id, x])));
  if (it.cs.on) r.push(['cs', it.cs]); if (it.ex.on) r.push(['ex', it.ex]);
  return r;   // [key, holder]; the phase lives in holder.ph (holder.lic_ph for the license)
}
const getPh = (key, h) => key === 'lic' ? h.lic_ph : h.ph;
const setPh = (key, h, v) => { if (key === 'lic') h.lic_ph = v; else h.ph = v; };
function compactPhases(it) {
  const lines = phaseLines(it);
  const used = [...new Set(lines.map(([k, h]) => getPh(k, h)))].sort((a, b) => a - b);
  if (!used.length) return 1;
  const map = new Map(used.map((v, i) => [v, i + 1]));
  lines.forEach(([k, h]) => setPh(k, h, map.get(getPh(k, h))));
  it.phases = used.map((v) => it.phases[v - 1] || { target: '' });
  return used.length;
}
const phaseCount = (it) => Math.max(1, ...phaseLines(it).map(([k, h]) => getPh(k, h)));
const plusMonths = (d, m) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };
async function copyText(t, msg = 'Link copied') {
  try { await navigator.clipboard.writeText(t); toast(msg); } catch { prompt('Copy this link:', t); }
}

// a new draft proposal for an organization with extra custom lines (a won bid); returns its id
async function proposalDraftFor(companyId, custom = []) {
  await priceList().catch(() => {});
  const it = normItems(); it.custom = [...(it.custom || []), ...custom];
  const { data, error } = await sb.from('proposals').insert({ company_id: companyId, items: it, ...(await closerFor(companyId)) }).select('id').single();
  if (error) throw error;
  return data.id;
}
// an admin starting a proposal puts the organization's closer on it (their name is what the client sees);
// everyone else is the owner of their own proposals
async function closerFor(companyId) {
  if (!isAdmin()) return {};
  const { data } = await sb.from('companies').select('owner_id').eq('id', companyId).maybeSingle();
  return data?.owner_id ? { owner_id: data.owner_id } : {};
}
// Start (or reopen) a proposal for an organization
async function openProposalFor(companyId, fresh = false) {
  // the client already has open proposals: pick one or start another (a client can have several)
  if (!fresh) {
    let oq = sb.from('proposals').select('*').eq('company_id', companyId).neq('status', 'accepted');
    if (!isAdmin()) oq = oq.eq('owner_id', S.me.id);
    const { data: open } = await oq.order('updated_at', { ascending: false }).limit(20);
    if (open?.length) {
      const box = document.createElement('dialog'); box.className = 'vdlg'; document.body.appendChild(box);
      const shut = () => { box.close(); box.remove(); };
      box.innerHTML = `<div class="vhead"><h2 style="margin:0">Proposals for this client</h2><button type="button" class="btn ghost small" data-x>Close</button></div>
        <div class="list">${open.map((p) => `<button type="button" class="item" data-op="${p.id}"><b>${esc(p.name || 'Untitled proposal')}</b>
          <small>${esc([PSTATUS[p.status], p.version ? 'Version ' + p.version : '', userName(p.owner_id) ? 'Closer: ' + userName(p.owner_id) : '', 'Updated ' + fmtDate(p.updated_at)].filter(Boolean).join(' · '))}</small></button>`).join('')}</div>
        <div class="actions"><button type="button" class="btn" id="opNew">+ Start a new proposal</button></div>`;
      $('[data-x]', box).onclick = shut;
      $$('[data-op]', box).forEach((b) => (b.onclick = () => { shut(); go('proposal', b.dataset.op); }));
      $('#opNew', box).onclick = () => { shut(); openProposalFor(companyId, true); };
      box.showModal();
      return;
    }
  }
  await priceList().catch(() => {});
  const { data: links } = await sb.from('company_people').select('work_email,is_primary_contact,is_decision_maker,people(id,first_name,last_name,personal_email,archived_at)').eq('company_id', companyId);
  const pick = (links || []).filter((l) => l.people && !l.people.archived_at)
    .sort((a, b) => (b.is_decision_maker - a.is_decision_maker) || (b.is_primary_contact - a.is_primary_contact))[0];
  const row = { company_id: companyId, items: normItems(), ...(await closerFor(companyId)) };
  if (pick) Object.assign(row, { contact_person_id: pick.people.id, contact_name: fullName(pick.people), contact_email: pick.work_email || pick.people.personal_email || null });
  const { data, error } = await sb.from('proposals').insert(row).select('id').single();
  if (error) return fail(error);
  go('proposal', data.id);
}

/* ---------- list ---------- */
async function viewProposals(main) {
  const f = recall('propFilter', { status: '', range: '30', from: '', to: '' });
  const RANGES = [['30', '30 days'], ['60', '60 days'], ['90', '90 days'], ['all', 'All time'], ['custom', 'Custom']];
  main.innerHTML = `
    <div class="toolbar"><h1 style="margin:0;flex:1">Proposals</h1><button class="btn small" id="newProp">+ New proposal</button></div>
    <div id="newBox"></div>
    <div class="pfilters">
      <div class="seg" id="pfSeg">${[['', 'All current'], ['draft', 'Draft'], ['sent', 'Sent'], ['accepted', 'Accepted'], ['expired', 'Expired'], ['archived', 'Archived']].map(([k, l]) =>
        `<button type="button" data-st="${k}" class="${f.status === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="seg" id="pfRange" aria-label="Last activity">${RANGES.map(([k, l]) =>
        `<button type="button" data-rg="${k}" class="${f.range === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <input type="search" id="pfQ" value="${esc(f.q || '')}" placeholder="Search customer or contact" aria-label="Search proposals" style="max-width:260px">
      ${f.range === 'custom' ? `<div class="pfdates"><label>From <input type="date" id="pfFrom" value="${esc(f.from)}"></label><label>To <input type="date" id="pfTo" value="${esc(f.to)}"></label></div>` : ''}
    </div>
    <small class="hint" id="pfCount" style="display:block;margin-top:8px"></small>
    <div class="list" id="plist" style="margin-top:8px"><p class="empty">Loading…</p></div>`;
  $$('#pfSeg [data-st]').forEach((b) => (b.onclick = () => { f.status = b.dataset.st; store('propFilter', f); viewProposals(main); }));
  $$('#pfRange [data-rg]').forEach((b) => (b.onclick = () => { f.range = b.dataset.rg; store('propFilter', f); viewProposals(main); }));
  $('#pfQ').oninput = debounce(() => { f.q = $('#pfQ').value.trim(); store('propFilter', f); viewProposals(main).then(() => { const el = $('#pfQ'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }); }, 350);
  ['pfFrom', 'pfTo'].forEach((idn) => { const el = $('#' + idn); if (el) el.onchange = () => { f[idn === 'pfFrom' ? 'from' : 'to'] = el.value; store('propFilter', f); viewProposals(main); }; });
  $('#newProp').onclick = () => {
    const box = $('#newBox');
    box.innerHTML = `<div class="card panel"><h2>Which organization is this for?</h2>
      <input type="search" id="npQ" placeholder="Search organizations" autocomplete="off"><div id="npRes"></div>
      <div class="actions"><button class="btn ghost small" id="npX">Cancel</button></div></div>`;
    $('#npX').onclick = () => (box.innerHTML = '');
    const run = debounce(async () => {
      const term = clean($('#npQ').value);
      if (!term) { $('#npRes').innerHTML = ''; return; }
      const { data } = await sb.from('companies').select('id,name,city,state').is('archived_at', null).ilike('name', `%${term}%`).order('name').limit(8);
      $('#npRes').innerHTML = `<div class="results">${(data || []).map((o) => `<button type="button" class="result" data-oid="${o.id}"><b>${esc(o.name)}</b><small>${esc([o.city, o.state].filter(Boolean).join(', '))}</small></button>`).join('') || '<p class="empty" style="padding:12px 12px 4px">No match.</p>'}
        <button type="button" class="result addnew" id="npAdd"><b>+ Add new organization</b><small>Quick Add it here, then start the proposal</small></button></div>`;
      $$('#npRes [data-oid]').forEach((b) => (b.onclick = () => openProposalFor(b.dataset.oid)));
      $('#npAdd').onclick = () => npQuickAdd($('#npQ').value.trim());
    });
    $('#npQ').oninput = run; $('#npQ').focus();
  };
  // Quick Add in place: save the organization and contact, then open the proposal with that contact filled in
  const npQuickAdd = (name) => {
    const box = $('#newBox');
    const f = (k, l, t = 'text', v = '', ph = '') => `<div><label class="label">${l}</label><input type="${t}" id="np_${k}" value="${esc(v)}" placeholder="${esc(ph)}" autocomplete="off"></div>`;
    box.innerHTML = `<div class="card panel"><h2>Quick Add a new organization</h2>
      <div class="row">${f('name', 'Organization name', 'text', name)}<div><label class="label">Type</label><select id="np_type">${options('org_type', defaultOrgType())}</select></div></div>
      <div class="row">${f('city', 'City')}${f('state', 'State', 'text', '', 'LA')}</div>
      <div class="row">${f('phone', 'Main phone', 'tel')}${f('spec', 'Specialty / category')}</div>
      <h3 style="margin:14px 0 4px">Contact for this proposal</h3>
      <div class="row">${f('first', 'First name')}${f('last', 'Last name')}</div>
      <div class="row">${f('email', 'Email', 'email')}${f('cell', 'Cell', 'tel')}</div>
      <div class="row">${f('title', 'Title', 'text', '', 'Practice Manager')}<div></div></div>
      <label class="check"><input type="checkbox" id="np_dm" checked> Decision maker</label>
      <small class="hint" style="display:block">Lead source is set to you. Change it on the organization's page anytime.</small>
      <div class="actions"><button class="btn ghost small" id="npBack">Back to search</button><button class="btn" id="npSave">Save and start proposal</button></div></div>`;
    $('#npBack').onclick = () => $('#newProp').onclick();
    $('#np_name').focus();
    $('#npSave').onclick = async () => {
      const v = (k) => $('#np_' + k).value.trim();
      if (!v('name')) return toast('Add the organization name');
      if (!v('first') && !v('email')) return toast('Add the contact\'s name or email so the proposal has someone to go to');
      if (v('email') && !/^\S+@\S+\.\S+$/.test(v('email'))) return toast('That email doesn\'t look right');
      const btn = $('#npSave'); btn.disabled = true; btn.textContent = 'Saving…';
      const contact = { ...blankContact(), first_name: v('first') || v('email').split('@')[0], last_name: v('last'), email: v('email'), cell: v('cell'), title: v('title'),
        is_decision_maker: $('#np_dm').checked, is_primary_contact: true };
      const { open, existing_label, ...c } = contact;
      const { data, error } = await sb.rpc('quick_entry', { p: {
        company_id: null, company: { name: v('name'), org_types: [$('#np_type').value || defaultOrgType()], specialty: v('spec'), address: '', city: v('city'), state: v('state').toUpperCase(), zip: '', main_phone: v('phone') },
        contacts: [c], services: [], owner_id: S.me.id, ...leadFields({ kind: 'self' }), notes: '', next_step: '', follow_up_date: '', lead_source_channel: '' } });
      if (error) { btn.disabled = false; btn.textContent = 'Save and start proposal'; return fail(error); }
      FACETS = null; toast(`Saved ${v('name')}`);
      openProposalFor(data);
    };
  };
  let q = sb.from('proposals').select('id,name,status,version,updated_at,expires_at,owner_id,contact_name,accepted_version,pay_status,pay_version,companies(name)').order('updated_at', { ascending: false }).limit(500);
  const nowIso = new Date().toISOString();
  q = f.status === 'archived' ? q.not('archived_at', 'is', null) : q.is('archived_at', null);
  if (f.status === 'archived') {}
  else if (f.status === 'expired') q = q.eq('status', 'sent').lt('expires_at', nowIso);
  else if (f.status === 'sent') q = q.eq('status', 'sent').gte('expires_at', nowIso);
  else if (f.status) q = q.eq('status', f.status);
  if (f.q) {
    const term = f.q.replace(/[%,()*]/g, ' ').trim();
    const { data: hit } = await sb.from('companies').select('id').ilike('name', `%${term}%`).limit(200);
    const cids = (hit || []).map((c) => c.id);
    q = q.or([`contact_name.ilike.%${term}%`, cids.length ? `company_id.in.(${cids.join(',')})` : ''].filter(Boolean).join(','));
  }
  if (['30', '60', '90'].includes(f.range)) q = q.gte('updated_at', new Date(Date.now() - Number(f.range) * 86400000).toISOString());
  if (f.range === 'custom' && f.from) q = q.gte('updated_at', new Date(f.from + 'T00:00:00').toISOString());
  if (f.range === 'custom' && f.to) q = q.lte('updated_at', new Date(f.to + 'T23:59:59').toISOString());
  const { data: raw, error } = await q;
  if (error) throw error;
  // All current leaves out expired proposals; they live (searchable, forever) under Expired
  const data = f.status ? raw : (raw || []).filter((p) => !(p.status === 'sent' && p.expires_at && p.expires_at < nowIso));
  const ids = (data || []).map((p) => p.id);
  const vers = ids.length ? (await sb.from('proposal_versions').select('proposal_id,version,setup_total,monthly_total,weekly_total').in('proposal_id', ids)).data || [] : [];
  const latest = {};
  vers.forEach((v) => { if (!latest[v.proposal_id] || v.version > latest[v.proposal_id].version) latest[v.proposal_id] = v; });
  const seen = {};
  if (ids.length) ((await sb.from('proposal_views').select('proposal_id,viewed_at').in('proposal_id', ids).order('viewed_at', { ascending: false })).data || [])
    .forEach((x) => { seen[x.proposal_id] ||= x.viewed_at; });
  const now = new Date();
  const n = (data || []).length;
  $('#pfCount').textContent = `${n === 500 ? '500+' : n} ${n === 1 ? 'proposal' : 'proposals'}, by last activity${f.range === 'all' ? '' : f.range === 'custom' ? (f.from || f.to ? ` ${f.from ? 'from ' + fmtDate(f.from) : ''}${f.to ? ' to ' + fmtDate(f.to) : ''}` : '') : ` in the last ${f.range} days`}`;
  $('#plist').innerHTML = (data || []).map((p) => {
    const v = latest[p.id]; const expired = p.status !== 'accepted' && new Date(p.expires_at) < now;
    return `<button class="item" data-pid="${p.id}"><b>${esc(p.companies?.name || 'Organization')}</b>
      <small>${esc([p.name, p.contact_name, userName(p.owner_id) ? 'Closer: ' + userName(p.owner_id) : ''].filter(Boolean).join(' · '))}</small>
      <div class="meta"><span class="badge ${p.status === 'accepted' ? 'ok' : p.status === 'sent' ? 'gold' : ''}">${PSTATUS[p.status]}</span>${payBadge(p)}
        ${p.version ? `<span class="badge">Version ${p.version}</span>` : ''}
        ${v ? `<span class="badge">${totalsLabel(v.setup_total, v.monthly_total, v.weekly_total)}</span>` : ''}
        ${expired && p.version ? `<span class="badge due">Expired ${esc(fmtDate(p.expires_at))}</span>` : ''}
        ${p.version ? (seen[p.id] ? `<span class="badge ok">Opened ${esc(fmtDate(seen[p.id]))}</span>` : p.status === 'sent' ? '<span class="badge">Not opened</span>' : '') : ''}
        <span class="badge stage">Updated ${esc(fmtDate(p.updated_at))}</span></div></button>`;
  }).join('') || (f.range === 'all' && !f.status ? '<p class="empty">No proposals yet. Start one here or from an organization\'s page.</p>' : '<p class="empty">Nothing matches these filters. Try a longer date range or All time.</p>');
  $$('#plist [data-pid]').forEach((b) => (b.onclick = () => go('proposal', b.dataset.pid)));
}

/* ---------- builder ---------- */
async function viewProposal(main) {
  const id = S.param;
  const { data: p, error } = await sb.from('proposals').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!p) { main.innerHTML = '<p class="empty">Proposal not found, or it belongs to someone else.</p>'; return; }
  const [co, links] = await Promise.all([
    sb.from('companies').select('*, logo:media!companies_logo_media_id_fkey(url)').eq('id', p.company_id).maybeSingle(),
    sb.from('company_people').select('work_email,people(id,first_name,last_name,personal_email,archived_at)').eq('company_id', p.company_id),
    priceList(),
  ]);
  const c = co.data || { name: 'Organization' };
  const people = (links.data || []).filter((l) => l.people && !l.people.archived_at);
  const accQ = p.status === 'accepted' && p.accepted_version
    ? (await sb.from('proposal_versions').select('quote').eq('proposal_id', id).eq('version', p.accepted_version).maybeSingle()).data?.quote : null;
  const PR = PRICES?.items || {};
  const P = { items: normItems(p.items), owner_id: p.owner_id, name: p.name || '', contact_person_id: p.contact_person_id, contact_name: p.contact_name || '', contact_email: p.contact_email || '', internal_note: p.internal_note || '', line_notes: { ...(p.line_notes || {}) } };
  let status = p.status, Q = null;
  const link = proposalLink(p.share_token);
  const locked = () => status === 'accepted';
  const it = P.items;
  // internal note on any line: team only, stored apart from the items so it can never reach the client
  // free trial on a recurring line: "First 30 days free" (setup still charges at signing)
  const trialCtl = (key) => { const on = Number(it.trials[key]) > 0;
    return `<span class="trialctl"><label class="check"><input type="checkbox" data-trial="${esc(key)}" ${on ? 'checked' : ''}> Free trial</label>${on ? `<input type="number" min="1" max="365" step="1" data-trialdays="${esc(key)}" value="${esc(it.trials[key])}" aria-label="Free trial days"> days` : ''}</span>`; };
  const inote = (key, label) => `<textarea class="inote" data-inote="${esc(key)}" rows="1" placeholder="Internal note (team only, never shown to the client)" aria-label="Internal note for ${esc(label)}">${esc(P.line_notes[key] || '')}</textarea>`;

  main.innerHTML = `
    <div class="toolbar"><button class="btn ghost small" id="pBack">← Proposals</button><div style="flex:1"></div>
      <button class="btn secondary small" id="pPresent">Present</button><button class="btn ghost small" id="pCopy">Copy client link</button>
      ${isAdmin() || p.owner_id === S.me.id ? '<button class="btn ghost small" id="pMore" aria-expanded="false">More ▾</button>' : ''}</div>
    <div class="morebox" id="pMoreBox" hidden>
      <button class="btn ghost small" id="pArchive">${p.archived_at ? 'Restore from archive' : 'Archive'}</button>
      ${p.status !== 'accepted' && !p.accepted_at && ((p.status === 'draft' && !p.version) || isAdmin()) ? '<button class="btn ghost small danger" id="pDelete">Delete…</button>' : ''}
    </div>
    ${p.archived_at ? `<div class="banner warn"><b>Archived</b><span>${esc(fmtDate(p.archived_at))}${p.archived_by ? ' · ' + esc(userName(p.archived_by)) : ''}. It's hidden from the Proposals list. The client link still works.</span></div>` : ''}
    <div id="pLock"></div><div id="pPlan"></div>
    <div class="titlerow">${c.logo?.url ? `<img class="orglogo" src="${esc(c.logo.url)}" alt="">` : ''}<h1>${esc(c.name)}</h1>
      <div class="meta"><span class="badge" id="pStat"></span><button class="linkish" id="pOrg">Open organization</button></div></div>
    <div class="psplit">
      <div class="pbuild">
        <fieldset id="pf" class="pfs">
          <div class="card"><h2>Client</h2>
            <label class="label" for="pTitle">Proposal name <small class="hint" style="display:inline">(shows to the client, e.g. Patient enrollment)</small></label>
            <input type="text" id="pTitle" maxlength="120" value="${esc(P.name)}" placeholder="Untitled proposal">
            ${people.length ? `<label class="label" for="pPerson">Contact</label><select id="pPerson"><option value="">Someone else…</option>${people.map((l) =>
              `<option value="${l.people.id}" ${l.people.id === P.contact_person_id ? 'selected' : ''}>${esc(fullName(l.people))}</option>`).join('')}</select>` : ''}
            ${isAdmin() ? `<label class="label" for="pOwner">Closer (the client sees their name)</label><select id="pOwner" ${locked() ? 'disabled' : ''}>${userOptions(P.owner_id, null)}</select>` : ''}
            <div class="row"><div><label class="label" for="pName">Name on proposal</label><input type="text" id="pName" value="${esc(P.contact_name)}"></div>
              <div><label class="label" for="pEmail">Email</label><input type="email" id="pEmail" value="${esc(P.contact_email)}"></div></div>
            <div class="logorow"><div class="thumb">${c.logo?.url ? `<img src="${esc(c.logo.url)}" alt="">` : 'No logo'}</div>
              <div><b>Client logo</b><small class="hint" style="margin:0">Shows as “Prepared for” on their proposal. Saved on the organization for every future proposal.</small>
              <button type="button" class="btn ghost small" id="pLogo">${c.logo?.url ? 'Change logo' : 'Upload logo'}</button></div></div>
          </div>
          <div class="card" id="pLead"></div>

          <div class="card"><h2>Platform packages</h2><small class="hint" style="margin:-4px 0 6px">The license and pages can be sold together or on their own.</small>
            <div class="pline"><label class="check"><input type="checkbox" id="iLic" ${it.lic ? 'checked' : ''}> RLX Vendor License</label><span class="phslot" data-phslot="lic"></span><span class="pprice">${money(PR.lic?.mo)}/mo</span></div>
            <div class="sub" id="licNote" ${it.lic ? '' : 'hidden'}><span data-trialslot="lic">${trialCtl('lic')}</span>${inote('lic', 'RLX Vendor License')}</div>
            <div class="pline top"><b>Pages inside RLX</b><span class="pprice">${money(PR.page?.setup)} setup + ${money(PR.page?.mo)}/mo each</span></div>
            <div class="sub" id="list-pages"></div><button type="button" class="btn ghost small" data-add="pages">+ Add page</button>
          </div>

          <div class="card"><h2>Templates</h2>
            <div class="pline top"><b>Template website</b><span class="pprice">${money(PR.tSite?.setup)} each</span></div>
            <div class="sub" id="list-tSites"></div><button type="button" class="btn ghost small" data-add="tSites">+ Add template website</button>
            <div class="pline top" style="margin-top:14px"><b>Template funnel</b><span class="pprice">${money(PR.tFunnel?.setup)} each</span></div>
            <div class="sub" id="list-tFunnels"></div><button type="button" class="btn ghost small" data-add="tFunnels">+ Add template funnel</button>
          </div>

          <div class="card"><h2>Custom</h2><small class="hint" style="margin:-4px 0 6px">Custom work shows as an estimate until an admin or the dev team confirms it.</small>
            <div class="pline"><label class="check"><input type="checkbox" id="iCs" ${it.cs.on ? 'checked' : ''}> Custom website</label><span class="phslot" data-phslot="cs"></span><span class="pprice" id="csPrice"></span></div>
            <div class="sub" id="csBox">
              <div class="pline"><label class="label" style="margin:0" for="csHrs">Hours</label><input type="number" id="csHrs" min="1" step="1" value="${esc(it.cs.hrs)}" style="max-width:110px"><small class="hint" id="csRate" style="margin:0"></small></div>
              <input type="text" id="csName" placeholder="Name (optional), e.g. New marketing site" value="${esc(it.cs.name)}">
              <textarea id="csDesc" placeholder="What's included (shows to client)">${esc(it.cs.desc)}</textarea>
              <textarea id="csNote" placeholder="Note to client (shows on both sides)">${esc(it.cs.note)}</textarea>
              ${inote('cs', 'Custom website')}
              <div id="mk-cs"></div>
            </div>
            <div class="pline top" style="margin-top:14px"><b>Custom funnel</b><span class="pprice">By the hour</span></div>
            <small class="hint" style="margin:-4px 0 6px">${money(PRICES.rate_partner)}/hr with a RLX page in the same phase or earlier, ${money(PRICES.rate_standard)}/hr without. Custom builds show to the client as one price.</small>
            <div class="sub" id="list-cFunnels"></div><button type="button" class="btn ghost small" data-add="cFunnels">+ Add custom funnel</button>
          </div>

          <div class="card"><h2>Ongoing</h2>
            <div class="pline"><label class="check"><input type="checkbox" id="iEx" ${it.ex.on ? 'checked' : ''}> Additional monthly hours</label><span class="phslot" data-phslot="ex"></span><span class="pprice" id="exPrice"></span></div>
            <div class="sub" id="exBox"><div class="pline"><label class="label" style="margin:0" for="exHrs">Hours per month</label><input type="number" id="exHrs" min="1" step="1" value="${esc(it.ex.hrs)}" style="max-width:110px"><small class="hint" id="exRate" style="margin:0"></small></div><span data-trialslot="ex">${trialCtl('ex')}</span>${inote('ex', 'Additional monthly hours')}</div>
            <div class="pline top" style="margin-top:12px"><b>Hosting and care</b><span class="pprice" id="hostPrice"></span></div>
            <small class="hint" id="hostHint"></small>
            ${isAdmin() ? `<label class="check" style="margin-top:6px"><input type="checkbox" id="noHost" ${it.no_host ? 'checked' : ''}> No hosting charge on this proposal</label>` : ''}
          </div>

          <div class="card"><h2>Other services</h2><small class="hint" style="margin:-4px 0 6px">Anything that isn't in the catalog, like an ad placement. Set the price and how often it bills, weekly or monthly. Add your cost (team only) so the margin lights stay honest. Weekly lines start billing the moment the client pays.</small>
            <div class="sub" id="list-custom"></div><button type="button" class="btn ghost small" data-add="custom">+ Add custom</button><button type="button" class="btn ghost small" id="pFromProd">+ Add from product/service</button>${MEA.canMeasure() ? '<button type="button" class="btn secondary small" id="pMeasure">Measure and price</button>' : ''}
          </div>

          <div class="card" id="pPhases"></div>

          <div class="card"><h2>Mockups</h2><small class="hint" style="margin:-4px 0 8px">Shown on the client's proposal. You can also attach mockups to any line above. Images and PDFs are saved with every version they're sent and accept.</small>
            <div id="mk-proposal"></div></div>

          <div class="card"><h2>Discounts and notes</h2>
            <div class="row"><div><label class="label" for="dSetup">Setup discount (%)</label><input type="number" id="dSetup" min="0" max="100" step="any" value="${esc(it.disc.setup_amt != null ? '' : it.disc.setup)}"></div>
              <div><label class="label" for="dSetupAmt">or setup discount ($)</label><input type="number" id="dSetupAmt" min="0" step="0.01" value="${esc(it.disc.setup_amt ?? '')}"></div></div>
            <div class="row"><div><label class="label" for="dMonth">Monthly discount (%)</label><input type="number" id="dMonth" min="0" max="100" step="any" value="${esc(it.disc.month_amt != null ? '' : it.disc.month)}"></div>
              <div><label class="label" for="dMonthAmt">or monthly discount ($ per month)</label><input type="number" id="dMonthAmt" min="0" step="0.01" value="${esc(it.disc.month_amt ?? '')}"></div></div>
            <small class="hint" style="margin:2px 0 6px">Use one or the other. A dollar amount stays the same dollar amount when the items change.</small>
            <label class="label" for="nShared">Note to client (shows on their proposal)</label><textarea id="nShared">${esc(it.note_shared)}</textarea>
            <label class="label" for="nInt">Internal note (never shown to the client)</label><textarea id="nInt">${esc(P.internal_note)}</textarea>
          </div>

          <div class="card"><h2>Terms</h2>
            <label class="check"><input type="checkbox" id="tCustom" ${it.terms_custom ? 'checked' : ''}> Custom terms for this proposal</label>
            <small class="hint" style="margin:2px 0 6px">Off: the standard terms. On: the text below replaces them on this client's proposal only, and the accepted version keeps exactly what they agreed to.</small>
            <textarea id="tText" rows="6" ${it.terms_custom ? '' : 'hidden'}>${esc(it.terms_custom || STD_TERMS)}</textarea>
          </div>
        </fieldset>
        <div id="pSnap"></div>
        <div class="card pstatus" id="pStatus"><p class="empty">Pricing…</p></div>
        <div class="card" id="pComm"></div>
        ${isAdmin() ? '<div class="card" id="pAdmin"></div>' : ''}
        <div class="card"><h2>Versions</h2><div id="pVers"><p class="empty">Loading…</p></div></div>
      </div>
      <div class="ppreview"><div class="pframe"><div class="pfbar"><span class="livedot">Client view, live</span><span id="pSaved"></span></div>
        <iframe id="pIframe" title="Client view" src="/proposal/view/#${esc(p.share_token)}"></iframe></div></div>
    </div>`;

  /* lists */
  const renderList = (k) => {
    const box = $('#list-' + k), arr = it[k];
    if (!arr.length) { box.innerHTML = '<p class="empty" style="padding:2px 0">None added.</p>'; return; }
    box.innerHTML = arr.map((x, i) => `<div class="pitem">
      <div class="pline"><span class="idx">${String(i + 1).padStart(2, '0')}</span>
        <input type="text" data-k="${k}" data-i="${i}" data-f="name" value="${esc(x.name)}" placeholder="Name, e.g. ${k === 'pages' ? 'ENT Dashboard' : k === 'custom' ? 'Fax coversheet ads' : 'Spring campaign'}" aria-label="${PLISTS[k]} ${i + 1} name">
        <span class="phslot" data-phslot="${k}:${x.id}"></span>
        <button type="button" class="btn ghost small danger" data-rm="${k}" data-i="${i}">Remove</button></div>
      <textarea data-k="${k}" data-i="${i}" data-f="desc" placeholder="What it is (optional, shows to client)" aria-label="${PLISTS[k]} ${i + 1} description">${esc(x.desc)}</textarea>
      ${k === 'custom' ? `<div class="cgrid">
          <label>Qty<input type="number" min="1" step="1" data-k="${k}" data-i="${i}" data-f="qty" value="${esc(x.qty || 1)}" placeholder="1" aria-label="${PLISTS[k]} ${i + 1} quantity"></label>
          <label>Setup price <small>each</small><input type="number" min="0" step="0.01" data-k="${k}" data-i="${i}" data-f="setup" value="${esc(x.setup)}" placeholder="0"></label>
          <label>Setup cost <small>each, team only</small><input type="number" min="0" step="0.01" data-k="${k}" data-i="${i}" data-f="setup_cost" value="${esc(x.setup_cost)}" placeholder="0"></label>
          <label>Recurring price <small>each</small><input type="number" min="0" step="0.01" data-k="${k}" data-i="${i}" data-f="amt" value="${esc(x.amt)}" placeholder="0"></label>
          <label>Bills every<select data-k="${k}" data-i="${i}" data-f="every"><option value="month" ${x.every !== 'week' ? 'selected' : ''}>Month</option><option value="week" ${x.every === 'week' ? 'selected' : ''}>Week</option></select></label>
          <label>Recurring cost <small>each, team only</small><input type="number" min="0" step="0.01" data-k="${k}" data-i="${i}" data-f="cost" value="${esc(x.cost)}" placeholder="0"></label></div>
        <label class="check"><input type="checkbox" data-hideqty="${i}" ${x.hide_qty ? 'checked' : ''}> Hide the quantity from the client <small class="hint" style="display:inline">(they see the line total only)</small></label>` : ''}
      ${k === 'cFunnels' ? `<div class="pline"><label class="label" style="margin:0" for="cfh-${i}">Hours</label><input type="number" id="cfh-${i}" data-k="${k}" data-i="${i}" data-f="hrs" min="1" step="1" value="${esc(x.hrs)}" style="max-width:110px">
        <small class="hint" style="margin:0" data-cfrate="${esc(x.id)}"></small><span class="pprice" data-cfprice="${esc(x.id)}"></span></div>` : ''}
      ${k !== 'pages' ? `<textarea data-k="${k}" data-i="${i}" data-f="note" placeholder="Note to client (optional)" aria-label="${PLISTS[k]} ${i + 1} note">${esc(x.note)}</textarea>` : ''}
      ${k === 'pages' || k === 'custom' ? `<span data-trialslot="${k}:${x.id}">${trialCtl(`${k}:${x.id}`)}</span>` : ''}
      ${inote(`${k}:${x.id}`, `${PLISTS[k]} ${i + 1}`)}
      ${mockupBox(`${k}:${i}`)}</div>`).join('');
    renderPhSel();
  };

  /* phases: a picker on every line, plus the Phases card */
  const holder = (key) => key === 'lic' ? it : key === 'cs' ? it.cs : key === 'ex' ? it.ex
    : (() => { const [k, ref] = key.split(':'); return (it[k] || []).find((x) => x.id === ref) || (/^\d+$/.test(ref) ? it[k]?.[+ref] : null); })();
  const lineName = (key) => key === 'lic' ? 'RLX Vendor License' : key === 'cs' ? (it.cs.name || 'Custom website') : key === 'ex' ? 'Additional monthly hours'
    : (() => { const k = key.split(':')[0]; return holder(key)?.name || PLISTS[k]; })();
  function renderPhSel() {
    const live = new Set(phaseLines(it).map(([k]) => k)), n = phaseCount(it);
    $$('[data-phslot]').forEach((slot) => {
      const key = slot.dataset.phslot;
      if (!live.has(key)) { slot.innerHTML = ''; return; }
      const cur = getPh(key, holder(key));
      slot.innerHTML = `<select class="phsel" data-phsel="${esc(key)}" aria-label="Phase for ${esc(lineName(key))}">${Array.from({ length: Math.min(9, n + 1) }, (_, j) =>
        `<option value="${j + 1}" ${cur === j + 1 ? 'selected' : ''}>${j + 1 > n ? 'New phase' : 'Phase ' + (j + 1)}</option>`).join('')}</select>`;
    });
  }
  const phDiscAmt = (n) => it.disc.ph_setup_amt?.[n] ?? null;
  const phGross = (n) => Number(Q?.phases?.[n - 1]?.setup?.gross) || 0;
  const phAmtPct = (n) => { const g = phGross(n), a = Number(phDiscAmt(n)) || 0; return g > 0 ? Math.min(100, Math.round(a / g * 1e8) / 1e6) : 0; };
  function renderPhaseCard() {
    const n = phaseCount(it), box = $('#pPhases'); if (!box) return;
    box.innerHTML = n === 1
      ? `<h2>Phases</h2><small class="hint" style="margin:0">Everything is in Phase 1. To split the work, pick a later phase on any line above. The client accepts and pays for Phase 1; later phases are held at these prices and you start each one from here when they're ready. The client can also rearrange phases on their link and send you their plan.</small>`
      : `<h2>Phases</h2><small class="hint" style="margin:-4px 0 8px">The client accepts and pays for Phase 1. Later phases are price-locked and start when you click Start after they accept. Each phase has to pass the margin rules on its own.</small>
        ${Array.from({ length: n }, (_, j) => `<div class="phrow"><div><b>Phase ${j + 1}</b><small class="hint" style="margin:0" data-phsum="${j + 1}"></small></div>
          ${j === 0 ? '<small class="hint" style="margin:0">Starts when they accept</small>'
            : `<input type="text" data-phtarget="${j + 1}" value="${esc(it.phases[j]?.target || '')}" placeholder="Target, e.g. January 2027" aria-label="Phase ${j + 1} target">`}
          <div class="phdisc" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><small class="hint" style="margin:0">Setup discount</small>
            <input type="number" data-phdisc="${j + 1}" min="0" max="100" step="any" style="max-width:90px" placeholder="%" aria-label="Phase ${j + 1} setup discount percent"
              value="${esc(phDiscAmt(j + 1) != null ? '' : (it.disc.ph_setup?.[j + 1] ?? ''))}">
            <input type="number" data-phdiscamt="${j + 1}" min="0" step="0.01" style="max-width:110px" placeholder="or $" aria-label="Phase ${j + 1} setup discount dollars"
              value="${esc(phDiscAmt(j + 1) ?? '')}">
            <small class="hint" style="margin:0">Blank uses the main setup discount</small></div></div>`).join('')}
        <div class="pline" style="margin-top:8px"><label class="label" for="phLock" style="margin:0">Price lock for later phases</label>
          <span style="display:inline-flex;align-items:center;gap:6px"><input type="number" id="phLock" min="${lockMin()}" max="${lockMax()}" step="1" value="${esc(it.lock_months)}" style="max-width:90px" aria-label="Price lock in months"><small class="hint" style="margin:0">months (${lockMin()} to ${lockMax()})</small></span></div>`;
    renderPhSums();
  }
  function renderPhSums() {
    (Q?.phases || []).forEach((ph) => { const el = $(`[data-phsum="${ph.n}"]`); if (el) el.textContent = ` ${money(ph.setup.net)} setup${ph.month.net ? ` · ${ph.n > 1 && ph.month.net > 0 ? 'adds ' : ''}${ph.month.net < 0 ? '-' : ''}${money(Math.abs(ph.month.net))}/mo` : ''}${ph.week?.net > 0 ? ` · ${ph.n > 1 ? 'adds ' : ''}${money(ph.week.net)}/week` : ''}`; });
  }
  const structure = () => { compactPhases(it); renderPhSel(); renderPhaseCard(); };

  /* mockups: images, PDFs and links on the proposal or on any line */
  const mkGet = (path) => path === 'proposal' ? (it.mockups || []) : path === 'cs' ? (it.cs.mockups || [])
    : (() => { const [k, i] = path.split(':'); return it[k][+i]?.mockups || []; })();
  const mkArr = (path) => path === 'proposal' ? (it.mockups ||= []) : path === 'cs' ? (it.cs.mockups ||= [])
    : (() => { const [k, i] = path.split(':'); return (it[k][+i].mockups ||= []); })();
  function mockupBox(path) {
    const arr = mkGet(path);
    return `<div class="mk" data-mk="${path}">
      ${arr.length ? `<div class="mklist">${arr.map((m, j) => `<div class="mkitem">
        ${m.type === 'image' ? `<a href="${esc(m.url)}" target="_blank" rel="noopener" class="mkthumb"><img src="${esc(m.url)}" alt=""></a>`
          : `<a href="${esc(m.url)}" target="_blank" rel="noopener" class="mkthumb mkicon">${m.type === 'pdf' ? 'PDF' : 'Link'}</a>`}
        <input type="text" data-mkt="${path}" data-j="${j}" value="${esc(m.title)}" placeholder="Caption the client sees" aria-label="Mockup caption">
        <button type="button" class="btn ghost small danger" data-mkrm="${path}" data-j="${j}">Remove</button></div>`).join('')}</div>` : ''}
      <div class="mkbtns"><button type="button" class="btn ghost small" data-mkup="${path}">+ Mockup image or PDF</button><button type="button" class="btn ghost small" data-mklink="${path}">+ Mockup link</button></div>
      <div class="mklinkform" hidden><input type="url" data-mkurl placeholder="https://… (live mockup page)" aria-label="Mockup link"><input type="text" data-mklabel placeholder="Label, e.g. Interactive homepage" aria-label="Mockup link label">
        <button type="button" class="btn small" data-mkadd="${path}">Add link</button></div></div>`;
  }
  const refreshMk = (path) => {
    if (path === 'proposal' || path === 'cs') { $('#mk-' + path).innerHTML = mockupBox(path); return; }
    renderList(path.split(':')[0]);
  };
  const uploadMockup = (path) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp,image/gif,application/pdf';
    input.onchange = async () => {
      const file = input.files[0]; if (!file) return;
      const pdf = file.type === 'application/pdf';
      if (!pdf && !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return toast('Use a PNG, JPG, WebP, GIF or PDF');
      if (file.size > 10 * 1024 * 1024) return toast('Mockups must be under 10 MB');
      const ext = pdf ? 'pdf' : file.type.split('/')[1].replace('jpeg', 'jpg');
      const fpath = `${p.tenant_id}/proposals/${id}/mockup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      toast('Uploading mockup…');
      const up = await sb.storage.from('media').upload(fpath, file, { contentType: file.type, upsert: false });
      if (up.error) return fail(up.error);
      const url = sb.storage.from('media').getPublicUrl(fpath).data.publicUrl;
      const { data: m, error: me } = await sb.from('media').insert({ path: fpath, url, kind: pdf ? 'file' : 'photo', entity: 'proposals', entity_id: id,
        title: file.name, mime: file.type, bytes: file.size }).select('id').single();
      if (me) return fail(me);
      mkArr(path).push({ type: pdf ? 'pdf' : 'image', url, media_id: m.id,
        title: file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim().slice(0, 80) });
      refreshMk(path); changed(); toast('Mockup added');
    };
    input.click();
  };
  ['pages', 'tSites', 'tFunnels', 'cFunnels', 'custom'].forEach(renderList);
  refreshMk('cs'); refreshMk('proposal');
  // measure on the satellite map, then the priced lines land here as other services, with the map as a mockup
  if ($('#pMeasure')) $('#pMeasure').onclick = async () => {
    if (locked()) return toast('This proposal was accepted, so it\'s locked.');
    const r = await MEA.open({ company: c, target: 'proposal' });
    if (!r) return;
    it.custom.push(...r.custom);
    if (r.mockup) (it.mockups ||= []).push(r.mockup);
    renderList('custom'); refreshMk('proposal'); changed();
    MEA.markUsed('proposal', id, r.measurement?.id).catch(() => {});
    toast(`${r.custom.length} ${r.custom.length === 1 ? 'line' : 'lines'} added from the measurement`);
  };

  /* save + quote */
  const ping = () => { try { $('#pIframe')?.contentWindow?.postMessage('proposal:refresh', location.origin); } catch {} };
  const savedLbl = (t) => { const s = $('#pSaved'); if (s) s.textContent = t; };
  // a dollar discount is saved as the percent of the full plan's price it comes to (the pricing math runs on percents)
  // (setup: only the phases using the main discount, not ones with their own)
  const grossOf = (k) => { const ph = Q?.phases?.length ? Q.phases : [Q || {}];
    return ph.filter((x) => k !== 'setup' || !x?.n || it.disc.ph_setup?.[x.n] == null).reduce((a, x) => a + (Number(x?.[k]?.gross) || 0), 0); };
  const amtPct = (k) => { const g = grossOf(k), a = Number(it.disc[k + '_amt']) || 0; return g > 0 ? Math.min(100, Math.round(a / g * 1e8) / 1e6) : 0; };
  const requote = async () => {
    const { data, error: e } = await sb.rpc('proposal_quote', { p_id: id });
    if (e) return fail(e);
    Q = data; renderDynamic();
    // items changed under a dollar discount: keep the dollars, move the percent
    const phDrift = Object.keys(it.disc.ph_setup_amt || {}).filter((n) => Math.abs(phAmtPct(n) - (Number(it.disc.ph_setup?.[n]) || 0)) > 1e-6);
    if (!locked() && (phDrift.length || ['setup', 'month'].some((k) => it.disc[k + '_amt'] != null && Math.abs(amtPct(k) - (Number(it.disc[k]) || 0)) > 1e-6))) {
      ['setup', 'month'].forEach((k) => { if (it.disc[k + '_amt'] != null) it.disc[k] = amtPct(k); });
      phDrift.forEach((n) => { it.disc.ph_setup = { ...(it.disc.ph_setup || {}), [n]: phAmtPct(n) }; });
      changed();
    }
  };
  const saveNow = async () => {
    if (locked()) return true;
    const { error: e } = await sb.from('proposals').update({ items: it, name: P.name.trim() || null, contact_person_id: P.contact_person_id || null,
      contact_name: P.contact_name.trim() || null, contact_email: P.contact_email.trim() || null, internal_note: P.internal_note.trim() || null,
      line_notes: Object.fromEntries(Object.entries(P.line_notes).map(([k, v]) => [k, String(v || '').trim()]).filter(([, v]) => v)) }).eq('id', id);
    if (e) { savedLbl('Not saved'); fail(e); return false; }
    savedLbl('Saved'); await requote(); ping(); return true;
  };
  const save = debounce(saveNow, 450);
  const changed = () => { savedLbl('Saving…'); save(); };

  /* prices are held from the first send; an admin can move an unaccepted proposal onto today's prices */
  let snapAt = p.price_snapshot?.at || null;
  const renderSnap = () => {
    const box = $('#pSnap'); if (!box) return;
    if (!snapAt) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="snapnote"><span>Prices on this proposal are held from ${esc(fmtDate(snapAt))}, when it was first sent. Price changes since then don't affect it.</span>
      ${isAdmin() && !locked() ? '<button type="button" class="btn ghost small" id="pReprice">Use current prices</button>' : ''}</div>`;
    const b = $('#pReprice');
    if (b) b.onclick = async () => {
      if (!confirm('Move this proposal onto today\'s prices? The client sees the new prices on their link right away.')) return;
      const { error: e } = await sb.rpc('proposal_use_current_prices', { p_id: id });
      if (e) return fail(e);
      snapAt = new Date().toISOString(); toast('Now using current prices'); renderSnap(); await requote(); ping();
    };
  };
  renderSnap();

  /* lead source */
  const renderLead = async () => {
    const box = $('#pLead');
    const set = leadIsSet(c);
    let partnerName = '';
    if (c.lead_source_partner_id) partnerName = (await sb.from('companies').select('name').eq('id', c.lead_source_partner_id).maybeSingle()).data?.name || '';
    if (set) {
      const label = c.lead_source_kind === 'system' && !c.lead_source_id ? 'No referrer named (10% default)' : leadLabel(c, partnerName);
      box.innerHTML = `<h2>Lead source</h2><div class="picked"><div><b>${esc(label)}</b><small>Set on the organization. Only an admin can change it.</small></div><span class="lock" aria-hidden="true">🔒</span></div>`;
      return;
    }
    box.innerHTML = `<h2>Lead source</h2><p style="margin:0 0 8px">Did you generate this lead yourself?</p>
      <div class="actions" style="margin:0"><button type="button" class="btn small" id="lsYes">Yes</button><button type="button" class="btn secondary small" id="lsNo">No, someone referred it</button></div>
      <div id="lsMore"></div>`;
    const saveLead = async (fields) => {
      const { error: e } = await sb.from('companies').update(fields).eq('id', c.id);
      if (e) return fail(e);
      Object.assign(c, fields); toast('Lead source saved'); renderLead(); requote();
    };
    $('#lsYes').onclick = () => saveLead({ lead_source_kind: 'self', lead_source_id: S.me.id, lead_source_partner_id: null });
    $('#lsNo').onclick = () => {
      const st = { kind: 'external', user_id: '', partner_id: '', partner_label: '' };
      $('#lsMore').innerHTML = `<label class="label">Which active client or referral partner sent it?</label><div id="lsPick"></div>
        <div class="actions"><button type="button" class="btn small" id="lsSave">Save lead source</button><button type="button" class="btn ghost small" id="lsNone">Can't name one (10% default)</button></div>`;
      leadPicker($('#lsPick'), st);
      $('#lsSave').onclick = () => { const bad = leadValid(st); if (bad) return toast(bad); saveLead(leadFields(st)); };
      $('#lsNone').onclick = () => saveLead({ lead_source_kind: 'system', lead_source_id: null, lead_source_partner_id: null });
    };
  };

  /* dynamic panels */
  function renderDynamic() {
    if (!Q) return;
    const L = Q.light, cm = Q.comm, adm = isAdmin(), multi = (Q.phases || []).length > 1;
    renderPhSums();
    $('#pStat').textContent = PSTATUS[status] + (p.version ? ' · v' + p.version : '');
    const csRate = Q.cs_rate ?? Q.rate, exRate = Q.ex_rate ?? Q.rate;
    $('#csPrice').textContent = it.cs.on ? money(Math.max(1, it.cs.hrs | 0) * csRate) : '';
    $('#csRate').textContent = `${money(csRate)}/hr ${csRate === PRICES.rate_partner ? '(partner rate)' : `(standard rate; ${money(PRICES.rate_partner)} with a RLX page in the same phase or earlier)`}. The client sees one price.`;
    Q.lines.filter((l) => l.key === 'cFunnel' && l.lk).forEach((l) => {
      const fid = l.lk.split(':')[1], m = /at \$(\d+)/.exec(l.qty || ''), r = m ? +m[1] : null;
      const pr = $(`[data-cfprice="${fid}"]`), rt = $(`[data-cfrate="${fid}"]`);
      if (pr) pr.textContent = money(l.setup);
      if (rt) rt.textContent = r ? `${money(r)}/hr ${r === PRICES.rate_partner ? '(partner rate)' : '(standard rate, no page in this phase or earlier)'}` : '';
    });
    $('#csBox').hidden = !it.cs.on; $('#exBox').hidden = !it.ex.on;
    $('#exPrice').textContent = it.ex.on ? money(Math.max(1, it.ex.hrs | 0) * exRate) + '/mo' : '';
    $('#exRate').textContent = money(exRate) + '/hr';
    const h = Q.hosting, hostMo = h.mo ?? Q.lines.filter((l) => l.key === 'host').reduce((a, l) => a + Number(l.mo || 0), 0);
    $('#hostPrice').textContent = h.units ? (hostMo ? money(hostMo) + '/mo' : it.no_host ? 'Turned off' : 'Included') : 'None';
    $('#hostHint').textContent = h.units ? `${h.units} site or funnel ${h.units > 1 ? 'units' : 'unit'}. ${h.covered} covered by RLX ${h.covered === 1 ? 'page' : 'pages'}, ${h.paid} paid at ${Q.partner ? money(PRICES.host_partner) + ' each' : money(PRICES.host_first) + ' first, ' + money(PRICES.host_next) + ' each after'}.` : 'Added automatically for each website or funnel.';

    // status
    const msgs = [];
    const sMsg = { yellow: 'Setup is in yellow. It can go out, and admins will see the flag.', red: 'Setup is in red.', blocked: 'The setup discount is too deep to send.' };
    const mMsg = { yellow: 'Monthly is in yellow. It can go out, and admins will see the flag.', red: 'Monthly is in red.', blocked: 'The monthly discount is too deep to send.' };
    if (Q.payback) msgs.push(`<div class="pmsg bad">Setup is red, but the monthly earns it back in about ${Q.payback.months} ${Q.payback.months > 1 ? 'months' : 'month'}. This can be done, but it must come with a <b>${Q.payback.term} month minimum term</b> or an <b>early termination fee of ${money(Q.payback.fee)}</b> if they cancel early. That term is added to the client's proposal automatically.</div>`);
    if (Q.payback && adm && !locked()) msgs.push(`<div class="pmsg warn">As an admin you can waive the minimum term. The setup stays red and the reason is kept on record.
        <textarea id="pWaive" placeholder="Why waive the minimum term?"></textarea><button type="button" class="btn small" id="pWaiveBtn">Waive minimum term</button></div>`);
    if (p.waive_term_reason) msgs.push(`<div class="pmsg warn">Minimum term waived by ${esc(userName(p.waive_term_by) || 'an admin')}: ${esc(p.waive_term_reason)}${adm && !locked() ? ' <button type="button" class="btn ghost small" id="pUnwaive">Put the term back</button>' : ''}</div>`);
    else if (!['green', 'none'].includes(L.setup)) msgs.push(`<div class="pmsg ${L.setup === 'yellow' ? 'warn' : L.setup === 'red' ? 'bad' : 'stop'}">${sMsg[L.setup]}${L.setup_hit > 0 && cm.is_closer ? ` This discount lowers your setup commission by <b>${(L.setup_hit * 100).toFixed(1)} points</b>.` : ''}</div>`);
    if (!['green', 'none'].includes(L.month)) msgs.push(`<div class="pmsg ${L.month === 'yellow' ? 'warn' : L.month === 'red' ? 'bad' : 'stop'}">${mMsg[L.month]}${L.month_hit > 0 && cm.is_closer ? ` This discount lowers your monthly commission by <b>${(L.month_hit * 100).toFixed(1)} points</b>.` : ''}</div>`);
    if (Q.dev_pending) msgs.push(`<div class="pmsg warn">Custom work is marked <b>estimated, pending review</b>. The client can't accept until ${adm ? 'you approve' : 'an admin or the dev team approves'} the hours and scope.${adm ? ' <button type="button" class="btn small" id="pApprove">Approve estimate</button>' : ''}</div>`);
    if (L.blocked && L.overridden) msgs.push('<div class="pmsg warn">Below the floor, but an admin overrode it with a reason.</div>');
    else if (L.blocked) msgs.push(adm ? `<div class="pmsg stop">Blocked. You can override it as an admin, with a reason on record.
        <textarea id="pOvr" placeholder="Why is this worth doing?"></textarea><button type="button" class="btn small" id="pOvrBtn">Override and allow</button></div>`
      : '<div class="pmsg stop">Blocked. Lower the discount, or ask an admin to override it.</div>');
    (Q.phase_lights || []).slice(1).forEach((pl) => {
      const pb = Q.phases[pl.n - 1]?.payback, cls = (k) => k === 'yellow' ? 'warn' : k === 'red' ? 'bad' : 'stop';
      if (pb) msgs.push(`<div class="pmsg bad">Phase ${pl.n} setup is red, but the running monthly earns it back in about ${pb.months} ${pb.months > 1 ? 'months' : 'month'}. It needs a <b>${pb.term} month minimum term</b> or an <b>early termination fee of ${money(pb.fee)}</b> when that phase starts.</div>`);
      else if (!['green', 'none'].includes(pl.setup)) msgs.push(`<div class="pmsg ${cls(pl.setup)}">Phase ${pl.n} setup is ${LIGHT[pl.setup].toLowerCase()}${pl.setup === 'blocked' ? ', so it needs an admin override to send' : ''}.</div>`);
      if (!['green', 'none'].includes(pl.month)) msgs.push(`<div class="pmsg ${cls(pl.month)}">The monthly bill once Phase ${pl.n} starts is ${LIGHT[pl.month].toLowerCase()}${pl.month === 'blocked' ? ', so it needs an admin override to send' : ''}.</div>`);
    });
    const trialLines = Q.lines.filter((l) => l.trial > 0);
    if (trialLines.length) msgs.push(`<div class="pmsg ok">Free trial: ${trialLines.map((l) => `${esc(l.title)} (${l.trial} ${l.trial === 1 ? 'day' : 'days'})`).join(', ')}. The client's card is taken at Accept and those lines start billing when the trial ends. Totals and lights still count their full price.</div>`);
    if (!msgs.length && Q.lines.length) msgs.push('<div class="pmsg ok">Good to send.</div>');
    if (Q.expired && !locked() && p.version) msgs.push('<div class="pmsg warn">The 14 day pricing window has passed. Send a new version to refresh it.</div>');
    const canSend = !locked() && Q.lines.length && !Q.blocked;
    $('#pStatus').innerHTML = `
      <div class="sline"><strong>Deal status</strong>${lightPill(L.overall)}</div>
      <div class="sline"><span>${multi ? 'Phase 1 setup, due at signing' : 'Setup'} ${Q.setup.disc > 0 ? `<small class="hint" style="display:inline">(${it.disc.setup_amt != null ? money(Q.setup.disc) : pctShort(Q.setup.pct) + '%'} off)</small>` : ''}</span><span><b>${money(Q.setup.net)}</b> ${lightPill(L.setup)}</span></div>
      <div class="sline"><span>${multi ? 'Phase 1 monthly' : 'Monthly'} ${Q.month.disc > 0 ? `<small class="hint" style="display:inline">(${it.disc.month_amt != null ? money(Q.month.disc) + '/mo' : pctShort(Q.month.pct) + '%'} off)</small>` : ''}</span><span><b>${money(Q.month.net)}/mo</b> ${lightPill(L.month)}</span></div>
      ${Q.week?.net > 0 ? `<div class="sline"><span>${multi ? 'Phase 1 weekly' : 'Weekly'} <small class="hint" style="display:inline">(lights count it as ${money(Q.week.net * 52 / 12)}/mo)</small></span><span><b>${money(Q.week.net)}/week</b></span></div>` : ''}
      ${multi ? Q.phases.slice(1).map((ph) => { const pl = Q.phase_lights[ph.n - 1]; return `
      <div class="sline phline"><span>Phase ${ph.n}${ph.target ? ` <small class="hint" style="display:inline">(${esc(ph.target)})</small>` : ''}</span>
        <span><b>${money(ph.setup.net)}</b> ${lightPill(pl.setup)} <b>${ph.month.net >= 0 ? '+' : ''}${money(ph.month.net)}/mo</b>${ph.week?.net > 0 ? ` <b>+${money(ph.week.net)}/week</b>` : ''} ${lightPill(pl.month)}</span></div>`; }).join('')
        + `<div class="sline phline"><span>Full plan, every phase running</span><span><b>${money(Q.plan.setup)}</b> setup · <b>${money(Q.plan.month)}/mo</b>${Q.plan.week > 0 ? ` · <b>${money(Q.plan.week)}/week</b>` : ''}</span></div>` : ''}
      ${msgs.join('')}
      <div class="actions">${locked() ? '' : '<button type="button" class="btn secondary" id="pDraft">Save draft</button>'}<button type="button" class="btn gold" id="pSend" ${canSend ? '' : 'disabled'}>${p.version ? 'Send updated version' : 'Save and send'} (v${(p.version || 0) + 1})</button></div>
      <small class="hint">${p.version ? 'Save draft saves without emailing anyone. Heads up: this proposal was already sent, so their link shows your changes as soon as they save.' : 'Save draft keeps your work without sending anything. The client gets nothing until you send. Changes also save as you go.'} Sending saves a version, restarts the 14 day pricing window and emails the client their link, with a copy to you. You'll get an email when they accept.</small>`;
    const ap = $('#pApprove'); if (ap) ap.onclick = async () => { const { error: e } = await sb.rpc('proposal_approve_estimate', { p_id: id }); e ? fail(e) : (toast('Estimate approved'), requote(), ping()); };
    const waive = async (reason) => { const { error: e } = await sb.rpc('proposal_waive_term', { p_id: id, p_reason: reason });
      if (e) return fail(e); p.waive_term_reason = reason || null; p.waive_term_by = reason ? S.me.id : null; toast(reason ? 'Minimum term waived' : 'Minimum term is back'); requote(); ping(); };
    const wb = $('#pWaiveBtn'); if (wb) wb.onclick = () => { const r = $('#pWaive').value.trim(); if (!r) return toast('Give a reason for waiving it'); waive(r); };
    const uw = $('#pUnwaive'); if (uw) uw.onclick = () => waive('');
    const ob = $('#pOvrBtn'); if (ob) ob.onclick = async () => { const { error: e } = await sb.rpc('proposal_override', { p_id: id, p_reason: $('#pOvr').value }); e ? fail(e) : (toast('Override saved'), requote(), ping()); };
    const dr = $('#pDraft');
    if (dr) dr.onclick = async () => {
      dr.disabled = true; savedLbl('Saving…');
      const ok = await saveNow(); dr.disabled = false;
      if (ok) toast(p.version ? 'Saved. No email went out, but their link already shows these changes.' : 'Draft saved. Nothing was sent. Find it anytime under Sales › Proposals.');
    };
    $('#pSend').onclick = async () => {
      const b = $('#pSend'); b.disabled = true;
      const { data, error: e } = await sb.rpc('proposal_send', { p_id: id });
      if (e) { b.disabled = false; return fail(e); }
      p.version = data.version; status = 'sent'; snapAt ||= new Date().toISOString(); renderSnap();
      requote(); ping(); loadVersions();
      if (!/^\S+@\S+\.\S+$/.test(P.contact_email.trim())) return copyText(link, `Version ${data.version} saved. No client email, so the link was copied for you to send.`);
      toast('Emailing the client…');
      const { data: em, error: ee } = await sb.functions.invoke('proposal-email', { body: { kind: 'sent', proposal_id: id } });
      let msg = em?.error;
      if (ee && !msg) { try { msg = (await ee.context.json()).error; } catch { msg = ee.message; } }
      if (msg) return copyText(link, `Version ${data.version} saved, but the email didn't go out (${msg}). Link copied instead.`);
      toast(`Version ${data.version} emailed to ${em.to}`);
    };

    // commission
    const cell = (rate, base) => rate == null ? '' : money(base * rate);
    const leadRow = cm.lead === 'ask' ? '<tr><td>Lead gen</td><td colspan="3" class="hint">Set the lead source above.</td></tr>'
      : cm.lead === 'mine' ? `<tr><td>Lead gen</td><td class="n">${pct1(cm.lead_rate)}</td><td class="n">${cell(cm.lead_rate, Q.setup.net)}</td><td class="n">${cell(cm.lead_rate, Q.month.net)}/mo${Q.week?.net > 0 ? `<br>${cell(cm.lead_rate, Q.week.net)}/week` : ''}</td></tr>`
      : '<tr><td>Lead gen</td><td colspan="3" class="hint">Applies elsewhere</td></tr>';
    const hit = (L.setup_hit || L.month_hit) && cm.is_closer;
    $('#pComm').innerHTML = `<h2>Your commission</h2><div class="tw"><table class="ptable"><thead><tr><th>Type</th><th class="n">Rate</th><th class="n">Setup</th><th class="n">Monthly</th></tr></thead><tbody>
      ${cm.is_closer ? `<tr><td>Sales${hit ? ' <small class="hint" style="display:inline">(after red discount)</small>' : ''}</td><td class="n">${pct1(cm.sales_rate)}${hit ? ' → ' + pct1(Math.min(cm.sales_setup_rate, cm.sales_month_rate)) : ''}</td>
        <td class="n">${cell(cm.sales_setup_rate, Q.setup.net)}</td><td class="n">${cell(cm.sales_month_rate, Q.month.net)}/mo${Q.week?.net > 0 ? `<br>${cell(cm.sales_month_rate, Q.week.net)}/week` : ''}</td></tr>`
        : '<tr><td>Sales</td><td colspan="3" class="hint">Applies elsewhere</td></tr>'}
      ${leadRow}</tbody></table></div>
      <small class="hint">Paid on collected revenue, setups and monthly, for as long as the client stays active.${multi ? ' Shown for Phase 1; later phases pay the same way when they start.' : ''}</small>`;

    // admin margins
    const A = Q.admin, box = $('#pAdmin');
    if (box && A) {
      const res = A.reserve;
      const cells = (price, cost, has) => {
        if (!has) return '<td class="n">-</td><td class="n">-</td><td class="n">-</td><td class="n gap">-</td>';
        const pr = price - price * res - cost;
        return `<td class="n">${money(price)}</td><td class="n">${money(cost)}</td><td class="n ${pr < 0 ? 'neg' : ''}">${money(pr)}</td><td class="n gap">${price > 0 ? pct1(pr / price) : 'n/a'}</td>`;
      };
      const dcell = (d) => d ? `<td class="n">-${money(d)}</td><td class="n">-</td><td class="n neg">-${money(d * (1 - res))}</td><td class="n gap"></td>` : '<td class="n">-</td><td class="n">-</td><td class="n">-</td><td class="n gap"></td>';
      const tcell = (x, net) => `<td class="n">${money(net)}</td><td class="n">${money(x.cost)}</td><td class="n ${x.profit < 0 ? 'neg' : ''}">${money(x.profit)}</td><td class="n gap">${pct1(x.margin)}</td>`;
      // weekly lines sit in the monthly columns at their monthly equivalent, so the totals add up
      const lineRow = (l) => { const wk = Number(l.wk || 0) > 0 || Number(l.wk_cost || 0) > 0, eq = (n) => Number(n || 0) * 52 / 12;
        return `<tr><td>${esc(l.title)}${wk ? ` <small class="hint" style="display:inline">(${money(l.wk)}/week)</small>` : ''}</td>${cells(l.setup || 0, l.setup_cost || 0, !!(l.setup || l.setup_cost))}${wk ? cells(eq(l.wk), eq(l.wk_cost), true) : cells(l.mo || 0, l.mo_cost || 0, !!(l.mo || l.mo_cost) || l.key === 'host')}</tr>`; };
      const moEq = Q.month.net + (Q.week?.net || 0) * 52 / 12;
      let body, foot;
      if (!multi) {
        body = A.lines.map(lineRow).join('') + `<tr><td>Discounts</td>${dcell(Q.setup.disc)}${dcell(Q.month.disc)}</tr>`;
        foot = `<tr><td>Total</td>${tcell(A.setup, Q.setup.net)}${tcell(A.month, moEq)}</tr>`;
      } else {
        body = Q.phases.map((ph) => { const ap = A.phases[ph.n - 1];
          return `<tr class="phhead"><td colspan="9">Phase ${ph.n}${ph.n === 1 ? ' · due at signing' : ph.target ? ' · ' + esc(ph.target) : ''}${ph.n > 1 ? ` <small class="hint" style="display:inline">(monthly bill once it starts runs at ${pct1(ap.month.run_margin)})</small>` : ''}</td></tr>`
            + A.lines.filter((l) => +l.ph === ph.n).map(lineRow).join('')
            + (ap.setup.disc || ap.month.disc ? `<tr><td>Discounts</td>${dcell(ap.setup.disc)}${dcell(ap.month.disc)}</tr>` : '')
            + `<tr class="phsub"><td>Phase ${ph.n}</td>${tcell(ap.setup, ph.setup.net)}${tcell(ap.month, ph.month.net)}</tr>`; }).join('');
        const sum = (f) => A.phases.reduce((a, x) => a + Number(f(x) || 0), 0);
        const tot = (k, net) => ({ cost: sum((x) => x[k].cost), profit: sum((x) => x[k].profit), margin: net > 0 ? sum((x) => x[k].profit) / net : null });
        foot = `<tr><td>Full plan</td>${tcell(tot('setup', Q.plan.setup), Q.plan.setup)}${tcell(tot('month', Q.plan.month), Q.plan.month)}</tr>`;
      }
      box.innerHTML = `<h2>Admin · margin</h2>
        <div class="kpis"><div class="kpi"><span>${multi ? 'Phase 1 setup margin' : 'Setup margin'}</span><b>${pct1(A.setup.margin)}</b><small>${money(A.setup.profit)} on ${money(Q.setup.net)}</small></div>
          <div class="kpi"><span>${multi ? 'Phase 1 monthly margin' : 'Monthly margin'}</span><b>${pct1(A.month.margin)}</b><small>${money(A.month.profit)}/mo on ${money(moEq)}${Q.week?.net > 0 ? ' (weekly counted monthly)' : ''}</small></div></div>
        <div class="tw" style="margin-top:12px"><table class="ptable mt"><thead>
          <tr><th></th><th colspan="4" class="grp">Setup</th><th colspan="4" class="grp">Monthly</th></tr>
          <tr><th>Line</th><th class="n">Price</th><th class="n">Cost</th><th class="n">Profit</th><th class="n gap">%</th><th class="n">Price</th><th class="n">Cost</th><th class="n">Profit</th><th class="n gap">%</th></tr></thead>
          <tbody>${body}</tbody>
          <tfoot>${foot}</tfoot></table></div>
        <small class="hint">Profit is price minus cost minus the ${Math.round(res * 100)}% commission reserve. Closer: ${esc(A.closer || '')} at ${pct1(A.closer_rate)} · Lead gen: ${esc(c.lead_source_kind === 'system' && !c.lead_source_id ? 'No referrer named' : (A.lead_label || 'not set'))}${A.lead_rate != null ? ' at ' + pct1(A.lead_rate) : ''}${A.payback_detail ? ` · Payback: ${money(A.payback_detail.shortfall)} short, ${money(A.payback_detail.excess)}/mo above 40%` : ''}</small>`;
    }
  }

  /* versions: what was sent, when the client opened it, and what changed */
  let VERS = [], VIEWS = [];
  const where = (v) => [v.city, v.region, v.country && v.country !== 'US' ? v.country : ''].filter(Boolean).join(', ') || 'Location unknown';
  const when = (s) => new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const loadVersions = async () => {
    const [{ data: vs }, { data: vw }] = await Promise.all([
      sb.from('proposal_versions').select('version,setup_total,monthly_total,weekly_total,light,accepted,override_reason,created_at,created_by,quote').eq('proposal_id', id).order('version', { ascending: false }),
      sb.from('proposal_views').select('version,viewed_at,ip,city,region,country,device').eq('proposal_id', id).order('viewed_at', { ascending: false }),
    ]);
    VERS = vs || []; VIEWS = vw || [];
    const lastView = VIEWS[0];
    $('#pVers').innerHTML = (VERS.length ? `<small class="hint" style="margin:-4px 0 8px">${lastView ? `Last opened ${esc(when(lastView.viewed_at))} from ${esc(where(lastView))}.` : 'The client hasn\'t opened it yet.'} Click a version to see it, its views, and what changed.</small>` : '')
      + VERS.map((v) => {
        const views = VIEWS.filter((x) => x.version === v.version);
        return `<button type="button" class="vrow" data-ver="${v.version}"><b>Version ${v.version}${v.accepted ? ' · Accepted' : ''}</b>
          <small>${totalsLabel(v.setup_total, v.monthly_total, v.weekly_total)} · ${esc(LIGHT[v.light] || v.light)} · ${esc(fmtDate(v.created_at))}${v.created_by ? ' · ' + esc(userName(v.created_by)) : ''}</small>
          <small class="${views.length ? 'seen' : 'unseen'}">${views.length ? `Opened ${views.length} ${views.length > 1 ? 'times' : 'time'} · last ${esc(when(views[0].viewed_at))} · ${esc(where(views[0]))}` : 'Not opened yet'}</small>
          ${v.override_reason ? `<small class="hint">Override: ${esc(v.override_reason)}</small>` : ''}</button>`;
      }).join('') || '<p class="empty">Nothing sent yet. The client view updates live while you build.</p>';
    $$('#pVers [data-ver]').forEach((b) => (b.onclick = () => openVersion(+b.dataset.ver)));
  };
  const lineKey = (l) => l.lk || (l.key === 'host' ? `host:${l.ph || 1}` : `${l.key}:${l.title}`);
  const linePrice = (l) => ([l.setup > 0 ? money(l.setup) + ' setup' : '', l.mo ? money(l.mo) + '/mo' : '', l.wk > 0 ? money(l.wk) + '/week' : ''].filter(Boolean).join(' + ') || 'Included') + (l.trial > 0 ? `, first ${l.trial} days free` : '');
  function versionHTML(q) {
    const phs = q.phases?.length ? q.phases : [{ n: 1, setup: q.setup, month: q.month }];
    return phs.map((ph) => `<div class="vph">${phs.length > 1 ? `<b>Phase ${ph.n}${ph.target ? ' · ' + esc(ph.target) : ''}</b>` : ''}
      ${q.lines.filter((l) => (+l.ph || 1) === ph.n).map((l) => `<div class="vline"><span>${esc(l.title)}${l.qty ? ` <small class="hint" style="display:inline">${esc(l.qty)}</small>` : ''}</span><span>${linePrice(l)}</span></div>`).join('')}
      <div class="vline vsum"><span>${phs.length > 1 ? `Phase ${ph.n} total` : 'Total'}</span><span>${money(ph.setup.net)} setup · ${money(ph.month.net)}/mo${ph.week?.net > 0 ? ` · ${money(ph.week.net)}/week` : ''}</span></div></div>`).join('')
      + (q.setup.disc > 0 || q.month.disc > 0 ? `<small class="hint">Discounts: ${pctShort(q.setup.pct)}% setup, ${pctShort(q.month.pct)}% monthly.</small>` : '')
      + (phs.length > 1 ? `<div class="vline vsum"><span>Full plan</span><span>${money(q.plan?.setup)} setup · ${money(q.plan?.month)}/mo${q.plan?.week > 0 ? ` · ${money(q.plan.week)}/week` : ''}</span></div>` : '')
      + (q.payback ? `<small class="hint">${q.payback.term} month minimum term or ${money(q.payback.fee)} early termination fee.</small>` : '');
  }
  function diffHTML(a, b) {   // a = older, b = newer
    const A = new Map(a.quote.lines.map((l) => [lineKey(l), l])), B = new Map(b.quote.lines.map((l) => [lineKey(l), l]));
    const rows = [];
    B.forEach((l, k) => {
      const o = A.get(k);
      if (!o) { rows.push(`<li class="add">Added: <b>${esc(l.title)}</b> (${linePrice(l)}${l.ph ? ', Phase ' + l.ph : ''})</li>`); return; }
      const ch = [];
      if (o.title !== l.title) ch.push(`renamed from "${esc(o.title)}"`);
      if (+o.setup !== +l.setup) ch.push(`setup ${money(o.setup)} → ${money(l.setup)}`);
      if (+o.mo !== +l.mo) ch.push(`monthly ${money(o.mo)} → ${money(l.mo)}`);
      if (+(o.wk || 0) !== +(l.wk || 0)) ch.push(`weekly ${money(o.wk)} → ${money(l.wk)}`);
      if (+(o.trial || 0) !== +(l.trial || 0)) ch.push(l.trial ? `free trial ${o.trial ? o.trial + ' → ' : ''}${l.trial} days` : 'free trial removed');
      if ((+o.ph || 1) !== (+l.ph || 1)) ch.push(`Phase ${+o.ph || 1} → Phase ${+l.ph || 1}`);
      if ((o.qty || '') !== (l.qty || '') && l.key !== 'host') ch.push(`${esc(o.qty || 'no hours')} → ${esc(l.qty || 'no hours')}`);
      if ((o.sub || '') !== (l.sub || '') || (o.note || '') !== (l.note || '')) ch.push('wording changed');
      if (ch.length) rows.push(`<li class="chg"><b>${esc(l.title)}</b>: ${ch.join(', ')}</li>`);
    });
    A.forEach((l, k) => { if (!B.has(k)) rows.push(`<li class="del">Removed: <b>${esc(l.title)}</b> (${linePrice(l)})</li>`); });
    const t = (x, y, lbl, mo) => +x !== +y ? `<li class="chg">${lbl}: ${money(x)}${mo ? '/mo' : ''} → ${money(y)}${mo ? '/mo' : ''}</li>` : '';
    rows.push(t(a.setup_total, b.setup_total, 'Due at signing'), t(a.monthly_total, b.monthly_total, 'Monthly', true));
    if (+(a.weekly_total || 0) !== +(b.weekly_total || 0)) rows.push(`<li class="chg">Weekly: ${money(a.weekly_total)}/week → ${money(b.weekly_total)}/week</li>`);
    if (a.quote.plan && b.quote.plan) rows.push(t(a.quote.plan.setup, b.quote.plan.setup, 'Full plan setup'), t(a.quote.plan.month, b.quote.plan.month, 'Full plan monthly', true));
    const pa = a.quote.phases?.length || 1, pb = b.quote.phases?.length || 1;
    if (pa !== pb) rows.push(`<li class="chg">Phases: ${pa} → ${pb}</li>`);
    const out = rows.filter(Boolean);
    return out.length ? `<ul class="vdiff">${out.join('')}</ul>` : '<p class="empty" style="padding:6px 0">No differences in items or prices.</p>';
  }
  function openVersion(n) {
    const v = VERS.find((x) => x.version === n); if (!v) return;
    const views = VIEWS.filter((x) => x.version === n), others = VERS.filter((x) => x.version !== n);
    let dlg = $('#verDlg');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'verDlg'; dlg.className = 'vdlg'; document.body.appendChild(dlg); }
    const prev = others.find((x) => x.version < n);
    dlg.innerHTML = `<div class="vhead"><h2 style="margin:0">Version ${n}${v.accepted ? ' · Accepted' : ''}</h2><button type="button" class="btn ghost small" id="vClose">Close</button></div>
      <small class="hint">${v.accepted ? 'Accepted' : 'Sent'} ${esc(when(v.created_at))}${v.created_by ? ' by ' + esc(userName(v.created_by)) : ''}</small>
      <div class="vrestore">${locked() ? '<small class="hint" style="margin:0">To bring this version back, close this and hit <b>Start a revision</b> first.</small>'
        : `<button type="button" class="btn small gold" id="vRestore">Bring back version ${n}</button>
           <small class="hint" style="margin:0">Puts version ${n}'s items back in the builder. The client's link shows it right away; hit Send to email it as a new version. What's in the builder now stays in History.</small>`}</div>
      <h3>Opened by the client</h3>
      ${views.length ? `<div class="tw"><table class="ptable"><thead><tr><th>When</th><th>Where (approximate)</th><th>Device</th><th>IP</th></tr></thead><tbody>
        ${views.map((x) => `<tr><td>${esc(when(x.viewed_at))}</td><td>${esc(where(x))}</td><td>${esc(x.device || '')}</td><td>${esc(x.ip || '')}</td></tr>`).join('')}</tbody></table></div>
        <small class="hint">Location comes from the IP address and is a best guess. Phones and office networks often show the carrier's or provider's city.</small>`
        : '<p class="empty" style="padding:6px 0">Not opened yet.</p>'}
      <h3>What was ${v.accepted ? 'accepted' : 'sent'}</h3>${versionHTML(v.quote)}
      ${others.length ? `<h3>Compare</h3><div class="pline"><label class="label" for="vCmp" style="margin:0">What changed from</label>
        <select id="vCmp" style="max-width:200px">${others.map((x) => `<option value="${x.version}" ${prev && x.version === prev.version ? 'selected' : ''}>Version ${x.version}</option>`).join('')}</select></div><div id="vDiff"></div>` : ''}`;
    const showDiff = () => {
      const o = VERS.find((x) => x.version === +$('#vCmp').value);
      const [a, b] = o.version < n ? [o, v] : [v, o];
      $('#vDiff').innerHTML = `<small class="hint">Changes from version ${a.version} to version ${b.version}:</small>${diffHTML(a, b)}`;
    };
    if (others.length) { $('#vCmp').onchange = showDiff; showDiff(); }
    $('#vClose').onclick = () => dlg.close();
    const rb = $('#vRestore');
    if (rb) rb.onclick = async () => {
      if (!rb.dataset.armed) { rb.dataset.armed = '1'; rb.textContent = `Yes, replace the builder with version ${n}`; return; }
      rb.disabled = true;
      const { data: row, error: e1 } = await sb.from('proposal_versions').select('items').eq('proposal_id', id).eq('version', n).maybeSingle();
      if (e1 || !row?.items) { rb.disabled = false; return e1 ? fail(e1) : toast('That version has no saved items', { error: true }); }
      const { error: e2 } = await sb.from('proposals').update({ items: row.items, client_plan: null }).eq('id', id);
      if (e2) { rb.disabled = false; return fail(e2); }
      await sb.from('activities').insert({ company_id: p.company_id, type: 'note', body: `Proposal: brought back version ${n}'s items into the builder.` });
      dlg.close(); toast(`Version ${n} is back in the builder. Hit Send to email it as a new version.`); renderShell();
    };
    { const out = (e) => { const r = dlg.getBoundingClientRect(); return e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom); };
      let dn = false; dlg.onpointerdown = (e) => { dn = out(e); }; dlg.onclick = (e) => { if (dn && out(e)) dlg.close(); dn = false; }; }
    dlg.showModal();
  }

  // after acceptance: later phases, their locked prices, and a Start button for each
  const phasePanel = () => {
    const phs = accQ?.phases || [];
    if (phs.length < 2) return '';
    const lockEnd = plusMonths(p.accepted_at, Number(accQ.lock_months) || 6), open = new Date() <= lockEnd;
    const started = p.phase_starts || {};
    return `<div class="card"><h2>Phases</h2><small class="hint" style="margin:-4px 0 8px">Prices for later phases are locked until ${esc(fmtDate(lockEnd.toISOString()))}.</small>
      ${phs.map((ph) => `<div class="phrow"><div><b>Phase ${ph.n}</b>${ph.target ? ` <small class="hint" style="display:inline">${esc(ph.target)}</small>` : ''}
          <small class="hint" style="margin:0">${money(ph.setup.net)} setup${ph.month.net ? ` · ${ph.n > 1 && ph.month.net > 0 ? 'adds ' : ''}${money(ph.month.net)}/mo` : ''}</small></div>
        ${ph.n === 1 ? `<span class="badge ok">Accepted ${esc(fmtDate(p.accepted_at))}</span>`
          : started[ph.n] ? `<span class="badge ok">Started ${esc(fmtDate(started[ph.n]))}</span>`
          : open || isAdmin() ? `<button type="button" class="btn small" data-startph="${ph.n}">Start Phase ${ph.n}</button>`
          : '<span class="badge due">Price lock ended. Start a revision to re-quote.</span>'}</div>`).join('')}</div>`;
  };

  // the client rearranged phases on their link and sent it over
  const renderClientPlan = () => {
    const box = $('#pPlan'); if (!box) return;
    const cp = p.client_plan;
    if (!cp?.plan || locked()) { box.innerHTML = ''; return; }
    const sim = JSON.parse(JSON.stringify(it));
    const hs = (key) => key === 'lic' ? sim : key === 'cs' ? sim.cs : key === 'ex' ? sim.ex
      : (() => { const [k, ref] = key.split(':'); return (sim[k] || []).find((x) => x.id === ref) || (/^\d+$/.test(ref) ? sim[k]?.[+ref] : null); })();
    Object.entries(cp.plan).forEach(([key, v]) => { const h = hs(key); if (h) setPh(key, h, phN(v)); });
    compactPhases(sim);
    const simPh = new Map(phaseLines(sim).map(([k, h]) => [k, getPh(k, h)]));
    const diffs = phaseLines(it).filter(([k, h]) => simPh.has(k) && simPh.get(k) !== getPh(k, h))
      .map(([k, h]) => `<li>${esc(lineName(k))}: Phase ${getPh(k, h)} → Phase ${simPh.get(k)}</li>`);
    const who = esc(P.contact_name || 'The client');
    box.innerHTML = `<div class="banner warn" style="align-items:flex-start"><div style="flex:1"><b>${who} suggested a different phase plan</b>
        <small style="display:block">Sent ${esc(new Date(cp.at).toLocaleString())}. Their link shows their plan until you decide.</small>
        ${diffs.length ? `<ul style="margin:6px 0 0 18px;padding:0">${diffs.join('')}</ul>` : '<small style="display:block">It now matches your plan.</small>'}</div>
      <div class="actions" style="margin:0"><button type="button" class="btn small" id="cpUse">Use their plan</button><button type="button" class="btn ghost small" id="cpNo">Keep mine</button></div></div>`;
    $('#cpUse').onclick = async () => {
      phaseLines(it).forEach(([k, h]) => { if (simPh.has(k)) setPh(k, h, simPh.get(k)); });
      compactPhases(it);
      const { error: e } = await sb.from('proposals').update({ items: it, client_plan: null }).eq('id', id);
      if (e) return fail(e);
      p.client_plan = null; renderClientPlan(); PH_LISTS.forEach(renderList); structure(); await requote(); ping();
      toast('Their plan is in. Send an updated version to email it to them.');
    };
    $('#cpNo').onclick = async () => {
      const { error: e } = await sb.from('proposals').update({ client_plan: null }).eq('id', id);
      if (e) return fail(e);
      p.client_plan = null; renderClientPlan(); ping(); toast('Kept your plan. Their link shows it again.');
    };
  };

  const renderLock = () => {
    $('#pf').disabled = locked();
    $('#pLock').innerHTML = locked() ? `<div class="banner ok"><b>Accepted</b><span>${esc(p.accepted_name || '')}${p.accepted_email ? ' (' + esc(p.accepted_email) + ')' : ''} accepted version ${p.accepted_version} on ${esc(new Date(p.accepted_at).toLocaleString())}${p.accepted_ip ? ' from ' + esc(p.accepted_ip) : ''}. Locked.${p.pay_version === p.accepted_version && p.pay_status === 'paid' ? ` <b>Paid ${money(p.paid_amount)}</b> on ${esc(new Date(p.paid_at).toLocaleString())}.` : ''}</span>${payBadge(p)}
      <button class="btn small secondary" id="pRev">Start a revision</button>${FLD.can('invoices', 2) ? '<button class="btn small secondary" id="pInv">Make an invoice</button>' : ''}<a class="btn small ghost" href="doc/?t=${encodeURIComponent(p.share_token)}" target="_blank" rel="noopener">Printable / PDF</a></div>${phasePanel()}` : '';
    if ($('#pInv')) $('#pInv').onclick = () => DOC.fromProposal(p.id);
    $$('[data-startph]').forEach((b) => (b.onclick = async () => {
      if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = `Confirm: start Phase ${b.dataset.startph}`; return; }
      b.disabled = true;
      const { error: e } = await sb.rpc('proposal_start_phase', { p_id: id, p_phase: +b.dataset.startph });
      if (e) { b.disabled = false; return fail(e); }
      p.phase_starts = { ...(p.phase_starts || {}), [b.dataset.startph]: new Date().toISOString() };
      toast(`Phase ${b.dataset.startph} started. Invoice its setup and add its monthly from the GELP Portal.`); renderLock();
    }));
    const rv = $('#pRev');
    if (rv) rv.onclick = async () => {
      const { error: e } = await sb.from('proposals').update({ status: 'draft' }).eq('id', id);
      if (e) return fail(e);
      status = 'draft'; renderLock(); renderSnap(); requote(); ping(); toast('Revision started. The accepted version stays in history.');
    };
  };

  /* events */
  const pf = $('#pf');
  pf.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.mkt) { const m = mkGet(t.dataset.mkt)[+t.dataset.j]; if (m) { m.title = t.value; changed(); } return; }
    if (t.dataset.inote) { P.line_notes[t.dataset.inote] = t.value; return changed(); }
    if (t.dataset.trialdays) { const v = parseInt(t.value, 10); if (v >= 1 && v <= 365) { it.trials[t.dataset.trialdays] = v; changed(); } return; }
    if (t.dataset.k) { it[t.dataset.k][+t.dataset.i][t.dataset.f] = t.dataset.f === 'hrs' || t.dataset.f === 'qty' ? Math.max(1, parseInt(t.value, 10) || 1) : t.value; return changed(); }
    if (t.dataset.phdisc || t.dataset.phdiscamt) {
      const n = t.dataset.phdisc || t.dataset.phdiscamt, v = parseFloat(t.value), other = $(t.dataset.phdisc ? `[data-phdiscamt="${n}"]` : `[data-phdisc="${n}"]`);
      it.disc.ph_setup = { ...(it.disc.ph_setup || {}) }; it.disc.ph_setup_amt = { ...(it.disc.ph_setup_amt || {}) };
      delete it.disc.ph_setup_amt[n]; if (other) other.value = '';
      if (t.value === '' || !(v >= 0)) delete it.disc.ph_setup[n];
      else if (t.dataset.phdisc) it.disc.ph_setup[n] = Math.min(100, v);
      else { it.disc.ph_setup_amt[n] = Math.round(v * 100) / 100; it.disc.ph_setup[n] = phAmtPct(n); }
      return changed();
    }
    if (t.dataset.phtarget) { const j = +t.dataset.phtarget - 1; it.phases[j] = { ...(it.phases[j] || {}), target: t.value }; return changed(); }
    switch (t.id) {
      case 'pName': P.contact_name = t.value; break;
      case 'pTitle': P.name = t.value; break;
      case 'pEmail': P.contact_email = t.value; break;
      case 'csHrs': it.cs.hrs = Math.max(1, parseInt(t.value, 10) || 1); break;
      case 'csName': it.cs.name = t.value; break;
      case 'csDesc': it.cs.desc = t.value; break;
      case 'csNote': it.cs.note = t.value; break;
      case 'exHrs': it.ex.hrs = Math.max(1, parseInt(t.value, 10) || 1); break;
      case 'dSetup': it.disc.setup = Math.min(100, Math.max(0, parseFloat(t.value) || 0)); delete it.disc.setup_amt; $('#dSetupAmt').value = ''; break;
      case 'dMonth': it.disc.month = Math.min(100, Math.max(0, parseFloat(t.value) || 0)); delete it.disc.month_amt; $('#dMonthAmt').value = ''; break;
      case 'dSetupAmt': case 'dMonthAmt': {
        const k = t.id === 'dSetupAmt' ? 'setup' : 'month', v = parseFloat(t.value);
        if (t.value === '' || !(v >= 0)) { delete it.disc[k + '_amt']; it.disc[k] = 0; }
        else { it.disc[k + '_amt'] = Math.round(v * 100) / 100; it.disc[k] = amtPct(k); }
        $(k === 'setup' ? '#dSetup' : '#dMonth').value = '';
        break;
      }
      case 'nShared': it.note_shared = t.value; break;
      case 'tText': it.terms_custom = t.value; break;
      case 'nInt': P.internal_note = t.value; break;
      default: return;
    }
    changed();
  });
  pf.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.phsel) { const h = holder(t.dataset.phsel); if (!h) return; setPh(t.dataset.phsel, h, +t.value); structure(); return changed(); }
    if (t.dataset.hideqty) { const x = it.custom[+t.dataset.hideqty]; if (x) { if (t.checked) x.hide_qty = true; else delete x.hide_qty; } return changed(); }
    if (t.dataset.trial) { const k = t.dataset.trial; if (t.checked) it.trials[k] = Number(it.trials[k]) > 0 ? it.trials[k] : 30; else delete it.trials[k];
      const slot = $(`[data-trialslot="${CSS.escape(k)}"]`); if (slot) slot.innerHTML = trialCtl(k); return changed(); }
    if (t.id === 'phLock') { it.lock_months = Math.min(lockMax(), Math.max(lockMin(), parseInt(t.value, 10) || lockMin())); t.value = it.lock_months; return changed(); }
    if (t.id === 'iLic') { it.lic = t.checked; $('#licNote').hidden = !t.checked; structure(); }
    else if (t.id === 'iCs') { it.cs.on = t.checked; structure(); }
    else if (t.id === 'noHost') { if (t.checked) it.no_host = true; else delete it.no_host; }
    else if (t.id === 'tCustom') { const ta = $('#tText'); ta.hidden = !t.checked; it.terms_custom = t.checked ? (ta.value.trim() || STD_TERMS) : ''; if (t.checked) { ta.value = it.terms_custom; ta.focus(); } }
    else if (t.id === 'iEx') { it.ex.on = t.checked; structure(); }
    else if (t.id === 'pOwner') {
      const was = P.owner_id; P.owner_id = t.value;
      sb.from('proposals').update({ owner_id: t.value }).eq('id', id).then(({ error: e }) => {
        if (e) { P.owner_id = was; t.value = was; return fail(e); }
        toast(`Closer is now ${userName(t.value)}`); requote(); ping();
      });
      return;
    }
    else if (t.id === 'pPerson') {
      const l = people.find((x) => x.people.id === t.value);
      P.contact_person_id = l ? l.people.id : null;
      if (l) { P.contact_name = fullName(l.people); P.contact_email = l.work_email || l.people.personal_email || ''; $('#pName').value = P.contact_name; $('#pEmail').value = P.contact_email; }
    } else return;
    changed();
  });
  pf.addEventListener('click', (e) => {
    const mk = e.target.closest('[data-mkup],[data-mklink],[data-mkadd],[data-mkrm]');
    if (mk) {
      const d = mk.dataset, box = mk.closest('.mk');
      if (d.mkup) return uploadMockup(d.mkup);
      if (d.mklink) { const f = $('.mklinkform', box); f.hidden = !f.hidden; if (!f.hidden) $('[data-mkurl]', f).focus(); return; }
      if (d.mkadd) {
        const url = $('[data-mkurl]', box).value.trim(), label = $('[data-mklabel]', box).value.trim();
        if (!/^https:\/\/\S+\.\S+/i.test(url)) return toast('Enter a full link starting with https://');
        mkArr(d.mkadd).push({ type: 'link', url, title: label || 'Interactive mockup' });
        refreshMk(d.mkadd); changed(); return;
      }
      if (d.mkrm) { mkArr(d.mkrm).splice(+d.j, 1); refreshMk(d.mkrm); changed(); return; }
    }
    const add = e.target.closest('[data-add]'), rm = e.target.closest('[data-rm]');
    if (add) {
      const k = add.dataset.add; it[k].push({ id: uid8(), ph: 1, name: '', desc: '', note: '', ...(k === 'cFunnels' ? { hrs: PRICES?.funnel_default_hours || 18 } : {}),
        ...(k === 'custom' ? { qty: 1, setup: '', setup_cost: '', amt: '', cost: '', every: 'month' } : {}) });
      compactPhases(it); renderList(k); renderPhaseCard(); changed();
      const ins = $$(`[data-k="${k}"][data-f="name"]`); ins[ins.length - 1]?.focus();
    } else if (rm) { const gone = it[rm.dataset.rm].splice(+rm.dataset.i, 1)[0]; if (gone) delete it.trials[`${rm.dataset.rm}:${gone.id}`];
      compactPhases(it); renderList(rm.dataset.rm); renderPhaseCard(); changed(); }
  });
  $('#pBack').onclick = () => go('proposals');
  if ($('#pMore')) $('#pMore').onclick = () => { const m = $('#pMoreBox'); m.hidden = !m.hidden; $('#pMore').setAttribute('aria-expanded', String(!m.hidden)); };
  if ($('#pArchive')) $('#pArchive').onclick = async () => {
    const { error: e } = await sb.rpc('proposal_archive', { p_id: p.id, p_archive: !p.archived_at });
    if (e) return fail(e);
    toast(p.archived_at ? 'Restored' : 'Archived'); if (p.archived_at) viewProposal(main); else go('proposals');
  };
  if ($('#pDelete')) $('#pDelete').onclick = async (ev) => {
    const b = ev.currentTarget;
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = p.version ? `Delete for good? The client link stops working` : 'Delete this draft for good?'; return; }
    b.disabled = true;
    const { error: e } = await sb.rpc('proposal_delete', { p_id: p.id });
    if (e) { b.disabled = false; return fail(e); }
    toast('Proposal deleted'); go('proposals');
  };
  // pull a saved product onto the proposal as a service line, with its price and cost (edited in Products)
  if ($('#pFromProd')) $('#pFromProd').onclick = async () => {
    const { data: prods, error } = await sb.rpc('products_for_proposals'); if (error) return fail(error);
    if (!(prods || []).length) return toast(isAdmin() ? 'No products or services yet. Add them in Tools › Admin › Sales › Products/services.' : 'No products or services yet. An admin adds them in Products/services.');
    const box = document.createElement('dialog'); box.className = 'vdlg'; document.body.appendChild(box);
    const toLine = (p) => {
      const pr = Number(p.price) || 0, co = Number(p.cost) || 0, f = p.frequency;
      // weekly and every-2-weeks bill weekly; monthly, quarterly and yearly bill monthly (spread out); one time goes into setup
      const per = f === 'weekly' ? ['week', 1] : f === 'biweekly' ? ['week', 0.5] : f === 'monthly' ? ['month', 1] : f === 'quarterly' ? ['month', 1 / 3] : f === 'yearly' ? ['month', 1 / 12] : null;
      const r2 = (n) => String(Math.round(n * 100) / 100);
      // quantity (like default hours) multiplies the whole line, so a setup fee rides on its own line when qty is more than 1
      const qty = Math.max(1, Math.round(Number(p.default_qty) || 1)), sp = Number(p.setup_price) || 0, sc = Number(p.setup_cost) || 0, split = qty > 1 && (sp || sc);
      const main = { id: uid8(), ph: 1, name: p.name, desc: p.description || '', note: '', qty, product_id: p.id,
        setup: r2((split ? 0 : sp) + (per ? 0 : pr)), setup_cost: r2((split ? 0 : sc) + (per ? 0 : co)),
        amt: per ? r2(pr * per[1]) : '', cost: per ? r2(co * per[1]) : '', every: per ? per[0] : 'month' };
      return split ? [main, { id: uid8(), ph: 1, name: 'Setup: ' + p.name, desc: '', note: '', qty: 1, product_id: p.id, setup: r2(sp), setup_cost: r2(sc), amt: '', cost: '', every: 'month' }] : [main];
    };
    const draw = (q = '') => {
      const rows = prods.filter((p) => !q || (p.name + ' ' + (p.description || '') + ' ' + (p.code || '')).toLowerCase().includes(q.toLowerCase()));
      $('#fpList', box).innerHTML = rows.map((p) => `<button type="button" class="item" data-fp="${p.id}"><b>${esc(p.name)}</b>
        <small>${esc([Number(p.setup_price) ? money(p.setup_price) + ' setup' : '', money(p.price) + ({ weekly: '/week', biweekly: ' every 2 weeks', monthly: '/mo', quarterly: '/quarter', yearly: '/year' }[p.frequency] || ' one time'), (p.description || '').slice(0, 90)].filter(Boolean).join(' · '))}</small></button>`).join('') || '<p class="empty">No match.</p>';
      $$('[data-fp]', box).forEach((b) => (b.onclick = () => {
        const p = prods.find((x) => x.id === b.dataset.fp);
        it.custom.push(...toLine(p)); compactPhases(it); renderList('custom'); renderPhaseCard(); changed();
        if (['quarterly', 'yearly', 'biweekly'].includes(p.frequency)) toast(`${p.name} added, spread out to ${p.frequency === 'biweekly' ? 'weekly' : 'monthly'} billing`); else toast(`${p.name} added`);
        box.close(); box.remove();
      }));
    };
    box.innerHTML = `<div class="vhead"><h2 style="margin:0">Add from product/service</h2><button type="button" class="btn ghost small" id="fpX">Close</button></div>
      <input type="search" id="fpQ" placeholder="Search products and services" autocomplete="off"><div class="list" id="fpList" style="margin-top:8px"></div>
      <p class="hint">Comes in at its saved price and cost. Change the quantity or price on the line if you need to.</p>`;
    $('#fpX', box).onclick = () => { box.close(); box.remove(); };
    $('#fpQ', box).oninput = (e) => draw(e.target.value.trim());
    draw(); box.showModal(); $('#fpQ', box).focus();
  };
  $('#pOrg').onclick = () => go('org', c.id);
  $('#pPresent').onclick = () => window.open(link, '_blank', 'noopener');
  $('#pCopy').onclick = () => copyText(link);
  $('#pLogo').onclick = () => uploadLogo(c);

  renderPhaseCard(); renderClientPlan();
  renderLock(); renderLead(); loadVersions(); await requote();
  // items saved before phases existed get stable line ids now, so a client's plan always matches the right line
  const rawIt = p.items || {};
  if (!locked() && PH_LISTS.some((k) => (rawIt[k] || []).some((x) => !x.id))) changed();
}

/* ================= pipeline ================= */
// Stages belong to the account. Built-in: Lead (new organizations start here), Proposal Sent and Closed Won (moved
// automatically by proposals), Closed Lost. All can be renamed in Admin > Settings; admins add their own in between.
S.stages = []; S.stagesAt = 0;
async function loadStages(force = false) {
  if (!force && S.stagesAt && Date.now() - S.stagesAt < 60_000) return S.stages;
  const [{ data }, { data: pls }] = await Promise.all([
    sb.from('pipeline_stages').select('id,name,sort,kind,system_key,archived_at,pipeline_id').order('sort').order('created_at'),
    sb.from('pipelines').select('id,name,sort,is_default,archived_at').order('sort').order('created_at'),
  ]);
  S.pipelines = (pls || []).filter((x) => !x.archived_at).sort((a, b) => (b.is_default - a.is_default) || (a.sort - b.sort));
  const live = new Set(S.pipelines.map((x) => x.id));
  S.allStages = data || []; S.stages = S.allStages.filter((x) => !x.archived_at && live.has(x.pipeline_id)); S.stagesAt = Date.now();
  return S.stages;
}
const stageName = (id) => (S.allStages || []).find((x) => x.id === id)?.name || '';
const pipeOf = (stageId) => (S.allStages || []).find((x) => x.id === stageId)?.pipeline_id;
const pipeName = (pid) => (S.pipelines || []).find((x) => x.id === pid)?.name || '';
// "Stage" or "Pipeline › Stage" once an account has more than one pipeline
const stageLabel = (id) => !id ? '' : (S.pipelines || []).length > 1 ? `${pipeName(pipeOf(id))} › ${stageName(id)}` : stageName(id);
const stageOptions = (cur) => (S.pipelines || []).map((pl) => {
  const opts = S.stages.filter((x) => x.pipeline_id === pl.id).map((x) => `<option value="${x.id}" ${x.id === cur ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  return S.pipelines.length > 1 ? `<optgroup label="${esc(pl.name)}">${opts}</optgroup>` : opts;
}).join('');
const daysSince = (s) => s ? Math.max(0, Math.floor((Date.now() - new Date(s)) / 86400000)) : null;
// which organization types start in Lead when added (Settings > Pipelines). Unset: everything except a lone partner type (Referral Partner, Partner).
const pipeTypes = () => (Array.isArray(S.acctSettings?.pipeline_types) ? S.acctSettings.pipeline_types : null);
const startsInLead = (types = []) => { const l = pipeTypes(); return l ? types.some((t) => l.includes(t)) : !(types.length === 1 && types[0] === partnerType()); };
const defaultLeadStage = () => { const pl = (S.pipelines || []).find((x) => x.is_default) || (S.pipelines || [])[0]; return pl ? S.stages.find((x) => x.pipeline_id === pl.id && x.system_key === 'lead')?.id || '' : ''; };

async function viewSales(main) {
  const gelp = S.acct?.is_gelp !== false;
  const [{ data: cos }, { data: props }] = await Promise.all([
    sb.from('companies').select('pipeline_stage_id').is('archived_at', null).not('pipeline_stage_id', 'is', null).limit(10000),
    gelp ? sb.from('proposals').select('id,status').limit(1000) : { data: [] },
  ]);
  const count = {}; (cos || []).forEach((c) => { count[c.pipeline_stage_id] = (count[c.pipeline_stage_id] || 0) + 1; });
  const max = Math.max(1, ...S.stages.map((x) => count[x.id] || 0));
  const ps = { draft: 0, sent: 0, accepted: 0 }; (props || []).forEach((p) => { ps[p.status] = (ps[p.status] || 0) + 1; });
  main.innerHTML = `<h1>Sales</h1>
    <div class="binder">
      <button type="button" class="card bcard" data-nav="pipeline"><h2>Pipeline${S.pipelines.length > 1 ? 's' : ''}</h2><small class="hint" style="margin:0 0 10px">Every organization by stage. Drag a card to move it.</small>
        ${S.pipelines.map((pl) => `${S.pipelines.length > 1 ? `<b class="bpl">${esc(pl.name)}</b>` : ''}${S.stages.filter((x) => x.pipeline_id === pl.id).map((x) => `<div class="bbar"><span>${esc(x.name)}</span><i style="width:${Math.round((count[x.id] || 0) / max * 100)}%"></i><b>${count[x.id] || 0}</b></div>`).join('')}`).join('')}
        <span class="bopen">Open pipeline →</span></button>
      ${gelp ? `<button type="button" class="card bcard" data-nav="proposals"><h2>Proposals</h2><small class="hint" style="margin:0 0 10px">Build, send and track proposals.</small>
        <div class="bstats"><div><b>${ps.draft}</b><span>Drafts</span></div><div><b>${ps.sent}</b><span>Sent</span></div><div><b>${ps.accepted}</b><span>Accepted</span></div></div>
        <span class="bopen">Open proposals →</span></button>` : ''}
    </div>
    ${isAdmin() ? '<small class="hint">Set up pipelines and stages in Admin › Company setup › Settings. Bring in a spreadsheet from Admin › Import.</small>' : ''}`;
  $$('.binder [data-nav]').forEach((b) => (b.onclick = () => go(b.dataset.nav)));
}

async function viewPipeline(main) {
  const f = recall('pipeFilter', { owner: '', q: '', pipe: '' });
  if (!S.pipelines.find((x) => x.id === f.pipe)) f.pipe = S.pipelines[0]?.id || '';
  const pstages = S.stages.filter((x) => x.pipeline_id === f.pipe);
  main.innerHTML = `<div class="toolbar"><h1 style="margin:0;flex:1">Pipeline</h1>
      ${S.pipelines.length > 1 ? `<select id="ppPipe" style="max-width:220px" aria-label="Pipeline">${S.pipelines.map((pl) => `<option value="${pl.id}" ${pl.id === f.pipe ? 'selected' : ''}>${esc(pl.name)}</option>`).join('')}</select>` : ''}
      <input type="search" id="ppQ" placeholder="Search" value="${esc(f.q)}" style="max-width:200px">
      <select id="ppOwner" style="max-width:160px" aria-label="Owner"><option value="">Everyone</option><option value="${S.me.id}" ${f.owner === S.me.id ? 'selected' : ''}>Mine</option></select>
      <button class="btn small" id="ppAdd">+ Add a lead</button></div>
    ${!pstages.length ? '<p class="empty">No stages yet. An admin can set them up in Admin › Company setup › Settings.</p>' : '<div class="board" id="board"><p class="empty">Loading…</p></div>'}`;
  $('#ppAdd').onclick = () => go('add');
  if ($('#ppPipe')) $('#ppPipe').onchange = () => { f.pipe = $('#ppPipe').value; store('pipeFilter', f); viewPipeline(main); };
  if (!pstages.length) return;
  const gelp = S.acct?.is_gelp !== false;
  const [{ data: cos, error }, { data: props }] = await Promise.all([
    divQ(sb.from('companies').select('id,name,city,state,owner_id,pipeline_stage_id,stage_changed_at')).is('archived_at', null).in('pipeline_stage_id', pstages.map((x) => x.id)).order('stage_changed_at', { ascending: false }).limit(3000),
    gelp ? sb.from('proposals').select('id,company_id,status,version,updated_at').order('updated_at', { ascending: false }).limit(1000) : { data: [] },
  ]);
  if (error) throw error;
  const latest = {}; (props || []).forEach((p) => { latest[p.company_id] ||= p; });
  const pids = Object.values(latest).filter((p) => p.version).map((p) => p.id);
  const vers = pids.length ? (await sb.from('proposal_versions').select('proposal_id,version,setup_total,monthly_total,weekly_total').in('proposal_id', pids)).data || [] : [];
  const tot = {}; vers.forEach((v) => { if (!tot[v.proposal_id] || v.version > tot[v.proposal_id].version) tot[v.proposal_id] = v; });
  const rows = cos || [];
  // phones: stages stack top to bottom; tap a stage header to fold it (remembered on this device)
  const shut = new Set(recall('pipeShut', { ids: [] }).ids || []);
  const draw = () => {
    const q = f.q.trim().toLowerCase();
    const shown = rows.filter((c) => pstages.some((x) => x.id === c.pipeline_stage_id) && (!f.owner || c.owner_id === f.owner) && (!q || c.name.toLowerCase().includes(q) || (c.city || '').toLowerCase().includes(q)));
    $('#board').innerHTML = pstages.map((st) => {
      const list = shown.filter((c) => c.pipeline_stage_id === st.id);
      const sum = list.reduce((a, c) => { const p = latest[c.id], v = p && tot[p.id]; return v ? [a[0] + Number(v.setup_total), a[1] + Number(v.monthly_total)] : a; }, [0, 0]);
      return `<section class="col ${st.kind}${shut.has(st.id) ? ' shut' : ''}" data-stage="${st.id}"><header data-toggle="${st.id}"><b>${esc(st.name)}</b><span class="n">${list.length}</span>
          ${sum[0] || sum[1] ? `<small>${money(sum[0])} + ${money(sum[1])}/mo</small>` : ''}</header>
        <div class="drop">${list.slice(0, 300).map((c) => {
          const p = latest[c.id], v = p && tot[p.id], d = daysSince(c.stage_changed_at);
          return `<article class="deal" draggable="true" data-co="${c.id}" tabindex="0">
            <b>${esc(c.name)}</b><small>${esc([[c.city, c.state].filter(Boolean).join(', '), c.owner_id ? userName(c.owner_id) : ''].filter(Boolean).join(' · '))}</small>
            ${p ? `<span class="badge ${p.status === 'accepted' ? 'ok' : p.status === 'sent' ? 'gold' : ''}">${PSTATUS[p.status]}${v ? ` · ${totalsLabel(v.setup_total, v.monthly_total, v.weekly_total)}` : ''}</span>` : ''}
            <div class="dfoot"><small>${d == null ? '' : d === 0 ? 'Today' : d + (d === 1 ? ' day' : ' days') + ' here'}</small>
              <select class="dmove" data-move="${c.id}" aria-label="Move ${esc(c.name)}">${stageOptions(st.id)}<option value="none">Take out of the pipeline</option></select></div></article>`;
        }).join('') || '<p class="empty" style="padding:8px">Nothing here.</p>'}${list.length > 300 ? `<p class="empty" style="padding:8px">${list.length - 300} more. Use search to find one.</p>` : ''}</div></section>`;
    }).join('');
    $$('#board .deal').forEach((el) => {
      el.ondragstart = (e) => { e.dataTransfer.setData('text/plain', el.dataset.co); el.classList.add('dragging'); };
      el.ondragend = () => el.classList.remove('dragging');
      el.onclick = (e) => { if (!e.target.closest('select')) go('org', el.dataset.co); };
      el.onkeydown = (e) => { if (e.key === 'Enter') go('org', el.dataset.co); };
    });
    $$('#board .col').forEach((col) => {
      col.ondragover = (e) => { e.preventDefault(); col.classList.add('over'); };
      col.ondragleave = () => col.classList.remove('over');
      col.ondrop = (e) => { e.preventDefault(); col.classList.remove('over'); move(e.dataTransfer.getData('text/plain'), col.dataset.stage); };
    });
    $$('#board [data-move]').forEach((sel) => (sel.onchange = () => move(sel.dataset.move, sel.value)));
    $$('#board [data-toggle]').forEach((h) => (h.onclick = () => {
      if (isWide()) return;
      const id = h.dataset.toggle; shut.has(id) ? shut.delete(id) : shut.add(id);
      h.parentElement.classList.toggle('shut', shut.has(id)); store('pipeShut', { ids: [...shut] });
    }));
  };
  const move = async (cid, sid) => {
    const c = rows.find((x) => x.id === cid); if (!c || c.pipeline_stage_id === sid) return;
    if (sid === 'none') {
      const { error: e } = await sb.from('companies').update({ pipeline_stage_id: null }).eq('id', cid);
      if (e) { draw(); return fail(e); }
      rows.splice(rows.indexOf(c), 1); draw();
      return toast(`${c.name} is out of the pipeline. Put it back from its page any time.`);
    }
    const prev = [c.pipeline_stage_id, c.stage_changed_at];
    c.pipeline_stage_id = sid; c.stage_changed_at = new Date().toISOString(); draw();
    const { error: e } = await sb.from('companies').update({ pipeline_stage_id: sid }).eq('id', cid);
    if (e) { [c.pipeline_stage_id, c.stage_changed_at] = prev; draw(); return fail(e); }
    toast(`${c.name} moved to ${stageLabel(sid)}`);
  };
  $('#ppQ').oninput = debounce(() => { f.q = $('#ppQ').value; store('pipeFilter', f); draw(); }, 150);
  $('#ppOwner').onchange = () => { f.owner = $('#ppOwner').value; store('pipeFilter', f); draw(); };
  draw();
}

/* ================= ADMIN: SETTINGS ================= */
let setPipe = '';
async function viewSettings(main) {
  await loadStages(true);
  if (!S.pipelines.find((x) => x.id === setPipe)) setPipe = S.pipelines[0]?.id || '';
  const pl = S.pipelines.find((x) => x.id === setPipe);
  const { data: cos } = await sb.from('companies').select('pipeline_stage_id').is('archived_at', null).not('pipeline_stage_id', 'is', null).limit(10000);
  const count = {}; (cos || []).forEach((c) => { count[c.pipeline_stage_id] = (count[c.pipeline_stage_id] || 0) + 1; });
  const inPipe = (pid) => S.stages.filter((x) => x.pipeline_id === pid).reduce((a, x) => a + (count[x.id] || 0), 0);
  const ROLE = { lead: 'New organizations start here', proposal_sent: 'Sending a proposal moves them here', won: 'An accepted proposal moves them here', lost: 'Closed lost' };
  const stages = S.stages.filter((x) => x.pipeline_id === setPipe), open = stages.filter((x) => x.kind === 'open');
  main.innerHTML = `<h1>Settings</h1>
    <div class="card"><h2>Pipelines</h2>
      <small class="hint" style="margin:-4px 0 10px">Every account starts with one pipeline. Add as many as you need, like one per funnel. New organizations land in the default pipeline. Each pipeline starts with Lead, Proposal Sent, Closed Won and Closed Lost.</small>
      <div class="pltabs">${S.pipelines.map((x) => `<button type="button" class="pltab ${x.id === setPipe ? 'on' : ''}" data-pl="${x.id}">${esc(x.name)}${x.is_default ? ' <span class="badge ok">Default</span>' : ''} <small>${inPipe(x.id)}</small></button>`).join('')}</div>
      <div class="pline" style="margin-top:10px"><input type="text" id="plNew" placeholder="New pipeline, e.g. ENT Referral Funnel" maxlength="80"><button type="button" class="btn small" id="plAdd">Add pipeline</button></div>
    </div>
    ${pl ? `<div class="card"><div class="toolbar"><h2 style="margin:0;flex:1">Stages in</h2>
        <input type="text" id="plName" value="${esc(pl.name)}" maxlength="80" aria-label="Pipeline name" style="max-width:260px">
        ${pl.is_default ? '' : `<button type="button" class="btn ghost small" id="plDefault">Make default</button><button type="button" class="btn ghost small danger" id="plRm">Remove pipeline</button>`}</div>
      <small class="hint" style="margin:4px 0 10px">Rename any stage. The four built-in stages keep their job when renamed. Add your own stages and use the arrows to order them.</small>
      <div id="stList">${stages.map((x) => {
        const i = open.indexOf(x);
        return `<div class="strow" data-id="${x.id}">
          <div class="starrows">${x.kind === 'open' ? `<button type="button" class="btn ghost small" data-up="${x.id}" ${i <= 0 ? 'disabled' : ''} aria-label="Move ${esc(x.name)} up">↑</button><button type="button" class="btn ghost small" data-down="${x.id}" ${i >= open.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(x.name)} down">↓</button>` : ''}</div>
          <div class="stmain"><input type="text" value="${esc(x.name)}" data-name="${x.id}" maxlength="60" aria-label="Stage name">
            <small class="hint" style="margin:0">${x.system_key ? `<span class="badge ${x.kind === 'won' ? 'ok' : x.kind === 'lost' ? 'due' : ''}">Built-in</span> ${ROLE[x.system_key]}` : 'Your stage'} · ${count[x.id] || 0} ${count[x.id] === 1 ? 'organization' : 'organizations'}</small></div>
          ${x.system_key ? '' : `<button type="button" class="btn ghost small danger" data-rm="${x.id}">Remove</button>`}</div>`;
      }).join('')}</div>
      <div class="pline" style="margin-top:12px"><input type="text" id="stNew" placeholder="New stage, e.g. Discovery Call" maxlength="60"><button type="button" class="btn small" id="stAdd">Add stage</button></div>
    </div>` : ''}
    <div class="card"><h2>Who starts in the pipeline</h2>
      <small class="hint" style="margin:-4px 0 10px">New organizations of these types start in Lead in the default pipeline. Everyone else stays out until you pick a stage on their page or in Quick Add.${pipeTypes() ? '' : ' Right now every type except Referral Partner starts in Lead.'}</small>
      <div class="chips" id="ptTypes">${lk('org_type').map((t) => `<label class="chip"><input type="checkbox" data-ptype="${esc(t)}" ${pipeTypes() ? (pipeTypes().includes(t) ? 'checked' : '') : t !== partnerType() ? 'checked' : ''}> ${esc(t)}</label>`).join('')}</div>
      <div class="actions"><button type="button" class="btn small" id="ptSave">Save</button></div>
      <small class="hint">This only decides where new ones land. To take someone out now, use the stage menu on their card in Pipeline and pick Take out of the pipeline.</small>
    </div>
    <div class="card"><h2>Follow-up date buttons</h2>
      <small class="hint" style="margin:-4px 0 10px">The quick buttons under Follow-up date in Quick Add. Type the number of days for each button, separated by commas (up to 8). Default: 1, 7, 15, 30.</small>
      <div class="pline"><input type="text" id="fuDays" value="${esc(followupDays().join(', '))}" inputmode="numeric" aria-label="Follow-up button days"><button type="button" class="btn small" id="fuSave">Save</button><button type="button" class="btn ghost small" id="fuReset">Use default</button></div>
      <div class="quick" id="fuPrev" style="margin-top:8px">${followupDays().map((d) => `<span class="badge">${esc(dayLabel(d))}</span>`).join('')}</div>
    </div>
    <div class="card" id="divCard"></div><div id="fieldSettings"></div>
    <div class="card"><h2>Your data</h2><small class="hint" style="margin:-4px 0 10px">Download every record in this account (organizations, people, notes, deals, proposals, invoices, jobs and more) as one file. It's yours.</small>
      <div class="actions"><button type="button" class="btn small secondary" id="setExport">Export data</button></div></div>`;
  $('#setExport').onclick = (e) => exportAccount(e.target);
  drawDivCard($('#divCard'));
  FLD.settingsCards($('#fieldSettings')).catch(fail);
  const fuParse = () => $('#fuDays').value.split(/[,\s]+/).filter(Boolean).map(Number);
  $('#fuDays').oninput = () => { const v = fuParse().filter((d) => Number.isInteger(d) && d >= 1 && d <= 365); $('#fuPrev').innerHTML = [...new Set(v)].sort((a, b) => a - b).map((d) => `<span class="badge">${esc(dayLabel(d))}</span>`).join(''); };
  const fuSave = async (days) => {
    const { data, error } = await sb.rpc('account_settings_save', { p: { followup_days: days } });
    if (error) return fail(error);
    S.acctSettings = data || {}; toast('Follow-up buttons saved'); $('#fuDays').value = followupDays().join(', '); $('#fuDays').oninput();
  };
  $('#fuSave').onclick = () => { const v = fuParse(); if (!v.length || v.some((d) => !Number.isInteger(d) || d < 1 || d > 365)) return toast('Use whole numbers of days from 1 to 365, separated by commas'); fuSave(v); };
  $('#fuReset').onclick = () => fuSave(FOLLOWUP_DEFAULT);
  $('#ptSave').onclick = async () => {
    const list = $$('[data-ptype]').filter((x) => x.checked).map((x) => x.dataset.ptype);
    const { data, error } = await sb.rpc('account_settings_save', { p: { pipeline_types: list } });
    if (error) return fail(error);
    S.acctSettings = data || {}; toast(list.length ? `New ${list.join(', ')} organizations start in Lead` : 'New organizations stay out of the pipeline until you pick a stage');
  };
  const refresh = async () => { await loadStages(true); viewSettings(main); };
  const leadOf = (pid) => S.stages.find((x) => x.pipeline_id === pid && x.system_key === 'lead');
  $$('[data-pl]').forEach((b) => (b.onclick = () => { setPipe = b.dataset.pl; viewSettings(main); }));
  $('#plAdd').onclick = async () => {
    const name = $('#plNew').value.trim(); if (!name) return toast('Name the pipeline first');
    const { data, error } = await sb.from('pipelines').insert({ name, sort: (S.pipelines.length + 1) * 10 }).select('id').single();
    if (error) return fail(error); setPipe = data.id; toast('Pipeline added'); refresh();
  };
  $('#plNew').onkeydown = (e) => { if (e.key === 'Enter') $('#plAdd').click(); };
  if (!pl) return;
  $('#plName').onchange = async () => {
    const name = $('#plName').value.trim(); if (!name) { $('#plName').value = pl.name; return toast('A pipeline needs a name'); }
    const { error } = await sb.from('pipelines').update({ name }).eq('id', pl.id); if (error) return fail(error); toast('Pipeline renamed'); refresh();
  };
  if ($('#plDefault')) $('#plDefault').onclick = async () => { const { error } = await sb.from('pipelines').update({ is_default: true }).eq('id', pl.id); if (error) return fail(error); toast(`${pl.name} is now the default`); refresh(); };
  if ($('#plRm')) $('#plRm').onclick = async (e) => {
    const b = e.currentTarget, n = inPipe(pl.id), def = S.pipelines.find((x) => x.is_default);
    if (n && !b.dataset.armed) { b.dataset.armed = '1'; b.textContent = `Remove and move ${n} to ${def.name}`; return; }
    if (n) { const { error } = await sb.from('companies').update({ pipeline_stage_id: leadOf(def.id).id }).in('pipeline_stage_id', S.stages.filter((x) => x.pipeline_id === pl.id).map((x) => x.id)); if (error) return fail(error); }
    const { error } = await sb.from('pipelines').update({ archived_at: new Date().toISOString() }).eq('id', pl.id);
    if (error) return fail(error); setPipe = ''; toast('Pipeline removed'); refresh();
  };
  $$('[data-name]').forEach((inp) => (inp.onchange = async () => {
    const name = inp.value.trim(); if (!name) { inp.value = stageName(inp.dataset.name); return toast('A stage needs a name'); }
    const { error } = await sb.from('pipeline_stages').update({ name }).eq('id', inp.dataset.name);
    if (error) return fail(error); await loadStages(true); toast('Stage renamed');
  }));
  const swap = async (id, dir) => {
    const i = open.findIndex((x) => x.id === id), j = i + dir; if (j < 0 || j >= open.length) return;
    const order = open.map((x) => x.id); [order[i], order[j]] = [order[j], order[i]];
    const res = await Promise.all(order.map((sid, k) => sb.from('pipeline_stages').update({ sort: (k + 1) * 10 }).eq('id', sid)));
    const bad = res.find((r) => r.error); if (bad) return fail(bad.error); refresh();
  };
  $$('[data-up]').forEach((b) => (b.onclick = () => swap(b.dataset.up, -1)));
  $$('[data-down]').forEach((b) => (b.onclick = () => swap(b.dataset.down, 1)));
  $$('[data-rm]').forEach((b) => (b.onclick = async () => {
    const id = b.dataset.rm, n = count[id] || 0, lead = leadOf(pl.id);
    if (n && !b.dataset.armed) { b.dataset.armed = '1'; b.textContent = `Remove and move ${n} to ${lead.name}`; return; }
    if (n) { const { error } = await sb.from('companies').update({ pipeline_stage_id: lead.id }).eq('pipeline_stage_id', id); if (error) return fail(error); }
    const { error } = await sb.from('pipeline_stages').update({ archived_at: new Date().toISOString() }).eq('id', id);
    if (error) return fail(error); toast('Stage removed'); refresh();
  }));
  $('#stAdd').onclick = async () => {
    const name = $('#stNew').value.trim(); if (!name) return toast('Name the stage first');
    const maxOpen = Math.max(0, ...open.map((x) => x.sort));
    const { error } = await sb.from('pipeline_stages').insert({ pipeline_id: pl.id, name, sort: Math.min(maxOpen + 10, 890), kind: 'open' });
    if (error) return fail(error); toast('Stage added'); refresh();
  };
  $('#stNew').onkeydown = (e) => { if (e.key === 'Enter') $('#stAdd').click(); };
}

/* ================= ADMIN: ACCOUNTS (GELP admins) ================= */
/* Logins and password resets for another account (Accounts and Platform screens). Who can open it is decided by
   account_logins (080): anyone on LNP for every account, agency admins for their accounts, an account's admins for their team. */
async function sendPwReset(email, domain) {
  if (!confirm(`Email ${email} a link to set a new password? Their current password keeps working until they use it.`)) return false;
  // the reset email goes out in their agency's brand and links to that agency's own address (password-reset function)
  const { data, error } = await sb.functions.invoke('password-reset', { body: { email } });
  if (error || data?.error) { fail(data?.error ? { message: data.error } : error); return false; }
  toast(`Reset link emailed to ${email}`); return true;
}
function wireLoginButtons(root) {
  $$('[data-logins]', root).forEach((b) => (b.onclick = async () => {
    const box = $(`[data-loginsbox="${b.dataset.logins}"]`, root);
    if (box.innerHTML) { box.innerHTML = ''; return; }
    box.innerHTML = '<p class="empty" style="margin:6px 0">Loading…</p>';
    const { data, error } = await sb.rpc('account_logins', { p_tenant: b.dataset.logins });
    if (error) { box.innerHTML = ''; return fail(error); }
    box.innerHTML = (data || []).map((r, i) => `<div class="toolbar" style="padding:6px 0;border-top:1px solid var(--line, #E3E7EF)"><div style="flex:1"><b>${esc(r.full_name || r.email)}</b>${r.is_admin ? ' <span class="badge gold">Admin</span>' : ''}${r.active ? '' : ' <span class="badge due">Off</span>'}<br><small>${esc(r.email || '')}${r.role === 'vendor' ? ' · Vendor login' : ''}</small></div>
        ${r.active && r.email ? `<button class="btn ghost small" data-pwr="${i}">Email a password reset</button>` : ''}</div>`).join('')
      || '<p class="empty" style="margin:6px 0">Nobody has a login in this account yet.</p>';
    $$('[data-pwr]', box).forEach((x) => (x.onclick = async () => { const r = data[+x.dataset.pwr]; x.disabled = true; await sendPwReset(r.email, r.login_domain); x.disabled = false; }));
  }));
}
async function viewAccounts(main) {
  const [{ data: accts }, { data: invs }, { data: flags }, plans] = await Promise.all([
    sb.from('tenants').select('id,name,slug,created_at,agency_tenant_id').order('name'),
    sb.rpc('account_invites'),
    sb.rpc('directories_flags'),
    PLN.accountsPlans(),
  ]);
  const planOf = (id) => (plans || []).find((p) => p.tenant_id === id);
  main.innerHTML = `<h1>Accounts</h1><p class="hint" style="margin:-6px 0 12px">The customer accounts under ${esc(S.acct.name)}. ${S.acct.platform_owner ? 'For white labels and every account on the CRM, use Tools › Admin › Agency › Platform.' : ''}</p>
    <div class="card"><h2>Create an account</h2><small class="hint" style="margin:-4px 0 8px">Each account is fully separate: its own organizations, contacts, pipelines, inbox, sites and team. The owner you invite becomes its admin.</small>
      <div class="row"><div><label class="label" for="acName">Account name</label><input type="text" id="acName" placeholder="Acme Company"></div>
        <div><label class="label" for="acSlug">Short name (for the chat code)</label><input type="text" id="acSlug" placeholder="acme"></div></div>
      <div class="row"><div><label class="label" for="acOwner">Owner's email</label><input type="email" id="acOwner" placeholder="owner@example.com"></div>
        <div><label class="label" for="acOwnerName">Owner's name</label><input type="text" id="acOwnerName"></div></div>
      <div class="actions"><button class="btn" id="acGo">Create account</button></div></div>
    <div class="card"><h2>Your accounts</h2>${(accts || []).filter((a) => a.id === S.acct.id || a.agency_tenant_id === S.acct.id).map((a) => {
      const pend = (invs || []).filter((i) => i.tenant_id === a.id);
      const pl = planOf(a.id);
      return `<div class="person-row"><div class="toolbar"><div style="flex:1"><b>${esc(a.name)}</b>${a.id === S.acct.id ? ' <span class="badge gold">You</span>' : ''}
          ${a.id !== S.acct.id && plans ? `<div class="planrow">${pl ? `<span class="planname">${esc(PLN.planLabel(pl))}</span> ${PLN.billingLabel(pl)}` : '<span class="hint">No plan: every feature, no billing checks</span>'}
            <button class="btn ghost small" data-plan="${a.id}">${pl ? 'Plan and billing' : 'Set a plan'}</button></div>` : ''}
          <small>Short name: ${esc(a.slug || '')} · created ${esc(fmtDate(a.created_at))}${pend.length ? ` · waiting to sign up: ${pend.map((i) => esc(i.email)).join(', ')}` : ''}</small>
          ${pend.map((i) => `<button class="btn ghost small" data-reinv="${a.id}|${esc(i.email)}">Email invite to ${esc(i.email)}</button>`).join('')}</div>
        <label class="check" style="margin:0"><input type="checkbox" data-dirflag="${a.id}" ${flags?.[a.id] ? 'checked' : ''}> Directories</label>
        ${a.id === S.acct.id ? '' : `<button class="btn small secondary" data-into="${a.id}">Switch into this account</button>`}</div>
        <button class="btn ghost small" data-logins="${a.id}">Logins and password resets</button><div data-loginsbox="${a.id}"></div>
        ${a.id === S.acct.id ? '' : `<button class="btn ghost small" data-memadd="${a.id}">Add to this account as a team member</button><div data-membox="${a.id}"></div>`}</div>`;
    }).join('')}</div>
    <small class="hint">The owner gets an email with a link that opens sign-up with their address filled in.</small>`;
  $$('[data-reinv]').forEach((b) => (b.onclick = async () => { const [t, em] = b.dataset.reinv.split('|'); if (await sendInvite(t, em)) toast(`Invite emailed to ${em}`); }));
  $('#acGo').onclick = async () => {
    const b = $('#acGo'); b.disabled = true;
    const owner = $('#acOwner').value.trim();
    const { data, error } = await sb.rpc('create_account', { p_name: $('#acName').value, p_slug: $('#acSlug').value, p_owner_email: owner, p_owner_name: $('#acOwnerName').value, p_agency: S.acct.id });
    b.disabled = false; if (error) return fail(error);
    await loadAccounts();
    const sent = owner ? await sendInvite(data.id, owner, true) : false;
    toast(!owner ? 'Account created' : sent ? `Account created. Invite emailed to ${owner}.` : 'Account created, but the invite email didn\'t go out. Use Email invite on the account.', { error: !!owner && !sent }); renderShell();
  };
  $$('[data-into]').forEach((b) => (b.onclick = async () => { const { error } = await sb.rpc('set_acting_tenant', { p_tenant: b.dataset.into }); if (error) return fail(error); location.hash = '#orgs'; location.reload(); }));
  memberAdderButtons(main, accts || []);
  wireLoginButtons(main);
  $$('[data-plan]', main).forEach((b) => (b.onclick = () => {
    const a = (accts || []).find((x) => x.id === b.dataset.plan), pl = planOf(a.id);
    PLN.planEditor({ tenant: a, plan: pl || { package_id: '', allowed: FLD.FEATURES.map((f) => f.key), billing_mode: 'off', grace_days: 7 }, company: pl?.company_id ? { id: pl.company_id } : null, onSaved: () => viewAccounts(main) });
  }));
  $$('[data-dirflag]').forEach((cb) => (cb.onchange = async () => {
    const { data: on, error } = await sb.rpc('set_directories_enabled', { p_tenant: cb.dataset.dirflag, p_on: cb.checked });
    if (error) { cb.checked = !cb.checked; return fail(error); }
    toast(on ? 'Directories turned on for this account' : 'Directories turned off for this account');
    if (cb.dataset.dirflag === S.acct.id) { S.dirOn = !!on; renderShell(); }
  }));
}

/* ================= brand kit in pickers (Nov 16, schema/113) =================
   Every color picker gets the account's brand kit colors as one-tap swatches (any other color still works). When
   something is saved as finished, brandCheck tells the database what was used; off-brand picks flag admins in Review,
   one flag per item. Drafts and clicking around never flag. No brand kit colors: no swatches and no flags. */
let KIT = null;
async function brandKit() {
  if (KIT && KIT.t === S.acct?.id) return KIT;
  const { data } = await sb.from('brand_kits').select('colors,fonts').maybeSingle();
  KIT = { t: S.acct?.id, colors: (data?.colors || []).filter((c) => /^#[0-9a-f]{6}$/i.test(c?.hex || '')), fonts: data?.fonts || [] };
  return KIT;
}
window.addEventListener('brandkit-saved', () => { KIT = null; });
function brandSwatches() {
  if (!S.me) return;
  $$('input[type=color]:not([data-nobrand]):not([data-bsw])').forEach(async (inp) => {
    inp.dataset.bsw = '1';
    let k = { colors: [] }; try { k = await brandKit(); } catch { /* no kit */ }
    if (!k.colors.length || inp.nextElementSibling?.classList?.contains('bswatch')) return;
    const w = document.createElement('div'); w.className = 'bswatch';
    w.innerHTML = `<small>Brand</small>${k.colors.map((c) => `<button type="button" style="background:${esc(c.hex)}" title="${esc(c.name || c.hex)}" data-hex="${esc(c.hex)}" aria-label="Use brand color ${esc(c.name || c.hex)}"></button>`).join('')}`;
    w.onclick = (e) => {
      const b = e.target.closest('[data-hex]'); if (!b || inp.disabled) return;
      inp.value = b.dataset.hex.toLowerCase(); inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
    };
    inp.after(w);
  });
}
new MutationObserver(() => brandSwatches()).observe(document.documentElement, { childList: true, subtree: true });
async function brandCheck(kind, ref, name, colors = [], fonts = []) {
  let data = null;
  try { ({ data } = await sb.rpc('brand_check', { p_kind: kind, p_ref: String(ref), p_name: name || null, p_colors: colors.filter(Boolean), p_fonts: fonts.filter(Boolean) })); } catch { /* never blocks a save */ }
  const off = data?.off || {}, n = (off.colors?.length || 0) + (off.fonts?.length || 0);
  if (n) toast(`Saved. ${n === 1 ? 'One pick isn\'t' : 'Some picks aren\'t'} in your brand kit, so admins will see it in Review.`);
  if (isAdmin()) refreshCounts().catch(() => {});
  return off;
}
// Review: off-brand picks waiting on an admin
async function brandReview(box) {
  const { data } = await sb.from('brand_flags').select('*').eq('status', 'open').order('created_at', { ascending: false });
  if (!data?.length) { box.innerHTML = ''; return; }
  const KIND = { calendar: ['Booking calendar', (r) => go('calset', r)], directory: ['Directory', (r) => go('directory', r)] };
  box.innerHTML = `<h2 class="section">Off-brand picks (${data.length})</h2>${data.map((f) => `<div class="card" data-bf="${f.id}">
    <div class="toolbar"><b style="flex:1">${esc((KIND[f.kind] || [f.kind])[0])}: ${esc(f.name || '')}</b><small>${esc(fmtDate(f.created_at))}${f.flagged_by ? ' · ' + esc(userName(f.flagged_by)) : ''}</small></div>
    <p>${(f.off?.colors || []).length ? `Colors not in the brand kit: ${f.off.colors.map((c) => `<span class="bswatch" style="display:inline-flex"><button type="button" disabled style="background:${esc(c)}"></button></span> ${esc(c)}`).join(', ')}` : ''}
      ${(f.off?.fonts || []).length ? `<br>Fonts not in the brand kit: ${esc(f.off.fonts.join(', '))}` : ''}</p>
    <div class="actions">${KIND[f.kind] ? '<button class="btn small" data-bfo>Open it</button>' : ''}<button class="btn secondary small" data-bfok>It's fine</button></div></div>`).join('')}`;
  $$('[data-bf]', box).forEach((card) => {
    const f = data.find((x) => x.id === card.dataset.bf);
    if ($('[data-bfo]', card)) $('[data-bfo]', card).onclick = () => KIND[f.kind][1](f.ref);
    $('[data-bfok]', card).onclick = async () => { const { error } = await sb.rpc('brand_flag_ok', { p_id: f.id }); if (error) return fail(error); renderShell(); };
  });
}

/* ================= HELP: walkthroughs, practice mode and the help library (Oct 26) =================
   Every walkthrough points at the real button, grays out the rest of the screen and waits for the person to click it.
   It runs in practice mode: sends and payments don't fire, and anything made during it is deleted at the end.
   F1, "?" or the ? button opens the help library; each article has a Show me button that starts its walkthrough. */
const navEl = (id) => [...document.querySelectorAll(`.cabinet [data-nav="${id}"].folder, .bottomnav [data-nav="${id}"]`)].find(visible) || (isWide() ? null : $('#moreBtn'));
const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const TOURS = {
  nav: { title: 'Getting around', view: 'dashboard', steps: [
    { el: () => navEl('orgs'), text: 'Contacts holds every organization and person. Search, filter and open any record here.' },
    { el: () => navEl('add'), text: 'Quick Add is the fastest way to log a new organization, a contact or a visit.' },
    { el: () => navEl('myday'), text: 'My Day is your list for today: follow-ups, to-dos and anything escalated to you.' },
    { el: () => navEl('inbox'), text: 'Inbox has customer chats from your website and your team\'s internal chat.' },
    { el: () => navEl('sales') || $('#moreBtn'), text: () => (isWide() ? 'Sales has your pipeline and proposals.' : 'More holds Sales, Tools and everything else.') },
    { el: '#gsOpen', text: 'Search finds anything: organizations, people, proposals, notes and screens. Ctrl K opens it from anywhere.' },
    { el: '#helpBtn', text: 'Help is always here. Press F1 or this button to find a how-to or replay a walkthrough.' },
  ] },
  quickadd: { title: 'Add an organization', view: 'add', practice: true, steps: [
    { el: '#orgQ', act: 'type', text: 'Type the organization\'s name. Try "Acme Company". If it\'s already in the CRM, it shows up here so you don\'t make a duplicate.' },
    { el: '#createNew', act: 'click', text: 'Not here yet? Click this to create it.' },
    { el: '[data-cf="city"]', text: 'Address and phone are optional, but they help the CRM catch duplicates.' },
    { el: '#qeLead [data-kind="self"]', act: 'click', text: 'Lead source decides who gets credit for bringing this in. Click Self.' },
    { el: '#qeNotes', act: 'type', text: 'Jot what happened. On a phone, the mic on your keyboard lets you dictate.' },
    { el: () => $('[data-days]'), act: 'click', text: 'Pick when to follow up. It lands on My Day that morning.' },
    { el: '#qeSave', act: 'click', text: 'Click Save. This is practice, so it gets deleted when you finish.' },
    { el: '#stageSel', text: 'This is the organization\'s page. The pipeline stage shows where the deal stands, and everything about them lives below.' },
  ] },
  contacts: { title: 'Find and filter contacts', view: 'orgs', steps: [
    { el: '#oq', act: 'type', text: 'Search by name, city or specialty. Results update as you type.' },
    { el: '.typechips .chip:not(.ghostchip)', act: 'click', text: 'Tap a type to show only those. Tap again to turn it off.' },
    { el: '#moreF', act: 'click', text: 'More filters: stage, owner, lead source, state and follow-ups that are due.' },
    { el: '#fpanel', text: 'Filters stack, and the CRM remembers them next time you come back.' },
    { el: () => $('#olist .item'), text: 'Tap any organization to open everything about it.' },
  ] },
  myday: { title: 'Work your day', view: 'myday', steps: [
    { el: () => $('#view h1'), text: 'My Day collects what needs you today: follow-ups that are due, to-dos and escalations.' },
    { el: '#fall', text: 'Admins can switch this on to see everyone\'s follow-ups, not just their own.' },
    { el: () => $('#view .card'), text: 'Open an item to call, text or log what happened. Done items drop off the list.' },
  ] },
  inbox: { title: 'Answer customer chats', view: 'inbox', steps: [
    { el: '#ibSeg', text: 'Open chats need an answer. Closed ones are finished but stay searchable.' },
    { el: '#ibList', text: 'Every chat from your website, proposals and directory listings lands here. Bold means unread.' },
    { el: () => navEl('inbox'), text: 'The number on Inbox counts unread chats, so you always know when someone is waiting.' },
  ] },
  sales: { title: 'Move deals through the pipeline', view: 'pipeline', steps: [
    { el: () => $('#view h1'), text: 'The pipeline shows every deal by stage.' },
    { el: () => $('#board') || $('#view .card'), text: 'Drag a card to the next column as the deal moves. Proposals move them on their own when you send one or the client accepts.' },
  ] },
};
const HELP = [
  { t: 'Getting around the CRM', w: 'navigation tabs menu more phone', tour: 'nav', b: 'The tabs across the top (or the bar at the bottom on a phone) take you to Contacts, Quick Add, My Day, Inbox and Sales. Tools holds everything else. Back always returns you one screen.' },
  { t: 'Add an organization or a visit', w: 'quick add new organization create contact visit log', tour: 'quickadd', b: 'Open Quick Add, search for the organization, then pick it or create it. Add contacts, notes and a follow-up date, then Save.' },
  { t: 'Find someone or filter your list', w: 'search filter contacts organizations people', tour: 'contacts', b: 'In Contacts, type in the search box or tap a type in the Quick filter row. Filters narrows by stage, owner, lead source, state, city, activity or due follow-ups. Tap + to save what you picked as a quick filter.' },
  { t: 'Work through My Day', w: 'my day follow up todo task escalation today', tour: 'myday', b: 'My Day lists today\'s follow-ups, your to-dos and anything escalated to you. Open an item to act on it.' },
  { t: 'Answer a website chat', w: 'inbox chat customer reply website', tour: 'inbox', b: 'Open Inbox, pick a chat and reply. Link it to an organization so the history follows them.' },
  { t: 'Move a deal along', w: 'pipeline stage deal sales drag', tour: 'sales', b: 'Open Sales, then Pipeline. Drag a card to its new stage, or change the stage on the organization\'s page.' },
  { t: 'Send a proposal', w: 'proposal send price quote client', admin: false, b: 'Open the organization and tap Proposal. Build it, then Save draft to keep working or Send to email the client their link. You\'re told when they accept.' },
  { t: 'See your website', w: 'site website funnel preview link change request', b: 'Tools › Web › Sites. Tap your site to see it right inside the CRM, copy its link to share, or tap Request a change and tell us what you need.' },
  { t: 'Search everything', w: 'search find ctrl k', b: 'Tap Search at the top or press Ctrl K. It finds organizations, people, proposals, notes and screens.' },
  { t: 'Use the CRM for two companies', w: 'company division switch two companies shared', admin: true, b: 'Tools › Admin › Company setup › Settings › Companies in this account. Add each company, then on Team pick who works where. Tag records on their page; untagged means shared.' },
  { t: 'Invite a teammate', w: 'team invite login user admin', admin: true, b: 'Tools › Admin › Team › Team. Enter their email, create the invite and send them the message it copies for you.' },
  { t: 'Notify someone about a note', w: 'note mention @ notify tag teammate alert tell', b: 'In a note on an organization or person, type @ and pick a teammate, or tap Notify and check one or more people. When you add the note, each of them gets it in My Day and the way they chose (push, email or both), with a link back to the record. The note shows who was notified.' },
  { t: 'Choose how notifications reach you', w: 'notification push email alert urgent settings gear how', b: 'Open the gear menu at the top. Under "When someone notifies me or there\'s an urgent alert", pick push to your devices (email if none are on), email, push and email, or only in the CRM. Everything also shows in My Day.' },
  { t: 'Save a quick filter', w: 'quick filter save chip shortcut saved filter organizations list share team', b: 'On Organizations, set the filters you want (tap a type, or open Filters for city, state, owner, activity and more). Tap + in the Quick filter row and name it, like "Vendors in Biloxi, active 30 days". Tap the chip anytime to apply it, tap it again to clear. Quick filters are just for you; admins can share one with the whole team. To remove one, turn it on and tap ×.' },
  { t: 'Find organizations by recent activity', w: 'active activity last 30 days quiet stale no activity city filter', b: 'On Organizations, open Filters and pick Activity: active in the last 7, 30 or 90 days, or no activity in 30+ or 90+ days. Activity is any note, change, form, chat or visit on that organization. City finds any city containing what you type.' },
  { t: "See what's new", w: 'new release update changes features whats new weekly', b: "Updates come out once a week, early Sunday morning. The next time you open the CRM you see what changed that you can use. To see every past update, open Help and tap What's new." },
  { t: 'Connect Microsoft 365', w: 'microsoft outlook teams office 365 m365 connect calendar sync busy', b: 'Gear menu › Connected calendars › Connect Microsoft. Sign in with your work Microsoft account and approve. Your Outlook busy times then block bookings on every account you work in, checked every 5 minutes. If it says your company admin has to approve it, ask your Microsoft 365 admin to approve the app for your organization. Disconnect anytime from the same place.' },
  { t: 'Get help from support', w: 'support help chat urgent routine ticket contact support problem question', b: 'Open the chat box (or Inbox › Team chat) and pick the Support tab. Search help first; most answers are there. Still stuck? Tap Start a chat, say what you need, and pick Urgent (answered within 4 business hours) or Routine (within 1 business day). Replies show in the Support tab and come by email. You can reply right there.' },
  { t: 'Chat in all your accounts', w: 'chat other accounts internal messages switch account notifications inbox customer', b: 'The internal chat box shows this account\'s conversations first. Conversations from the other accounts you work in are under Other accounts, one section for each; you can read and reply without switching. Use Open in (account) to switch over. Pop-ups say where a message is from, like "Julie (Cognix)". Customer chats waiting in another account show there too; tapping one switches to that account\'s Inbox.' },
  { t: 'Brand colors and off-brand flags', w: 'brand kit colors fonts swatch picker off brand flag review', b: 'Every color picker shows your brand kit colors as swatches under it: tap one to use it. Any other color still works. When something is saved as finished (a booking calendar, a directory page) with a color or font that isn\'t in the brand kit, admins see one flag for it in Review, with It\'s fine or Open it. Saving it again on-brand clears the flag. Drafts never flag, and with no brand kit colors there are no flags. Set up your brand kit under Tools › Brand kit.' },
  { t: 'Merge duplicates side by side', w: 'duplicate merge compare side by side review possible duplicate keep fields', b: 'Review › Possible duplicates › Compare side by side. Pick which record to keep, then click the value you want for each field that differs. Matching fields and blanks are folded away (uncheck Show only what\'s different to see them); blanks fill in from the other record on their own. Every value you don\'t keep goes into a note on the kept record with who approved the merge. Contacts, notes, follow-ups and appointments move over and the other record is archived.' },
  { t: 'Save booking answers to fields', w: 'booking questions custom fields save answer contact organization intake duplicate', b: 'Tools › Booking calendars › a calendar › Questions. Under each question, pick a field to save the answer on the contact or organization, or make a new field from the question. Answers fill fields that are blank. If an answer differs from what\'s on file, the record isn\'t changed: a new contact is made with the booking and flagged in Review, so you can compare and merge.' },
  { t: 'Make a calendar look busy', w: 'look busy hide open times booked full calendar busier slots percent', b: 'Tools › Booking calendars › a calendar › Look busy. Turn it on and pick how much of each day should look taken, like 30%. If real bookings already fill that much of a day, nothing is hidden. Otherwise some open times are hidden at random (the same ones all day), always leaving at least the number you set. Only customers see fewer times; your team always sees real availability. The preview shows how many times show and hide over the next week.' },
  { t: 'Turn on Phone', w: 'phone calls voip numbers turn on feature settings telnyx', admin: true, b: 'Tools › Admin › Company setup › Settings › Features: turn on Phone. Your agency adds your phone numbers. Then Tools › Admin › Phone lines sets who each line rings.' },
  { t: 'Make and take calls in the CRM', w: 'phone call dial answer dialer pad browser computer headset mute hold keypad', f: 'phone', b: 'If you\'re on a phone line, the ☎ button sits at the bottom left. Tap it, type a number (or tap Call or a phone number on any contact) and tap Call. When a call comes in, the panel pops up with who\'s calling and Answer and Decline. Keep the CRM open in a tab to get calls. Use a headset for the best sound. The browser asks to use your microphone the first time. The CRM phone can\'t call 911.' },
  { t: 'Phone lines: direct and group', w: 'phone line group ring everyone main line direct who rings voicemail greeting record seconds', f: 'phone', admin: true, b: 'Tools › Admin › Phone lines. A direct line rings one person. A group line (like your main number) rings everyone checked at the same time, and the first to answer gets it. Set how long it rings, voicemail on or off and the greeting. Turn on recording to keep a copy of every call (some states need everyone to agree to being recorded).' },
  { t: 'Voicemail and missed calls', w: 'voicemail missed call message play listen notification', f: 'phone', b: 'When nobody answers in time, the caller hears your greeting and can leave a message. Everyone on the line gets a notice. Play it from Tools › Phone › Calls (Voicemail) or from the contact\'s Activity.' },
  { t: 'Calls on the contact and the phone log', w: 'call log activity timeline file unknown number move notes recording', f: 'phone', b: 'Every call, in or out, lands on the Activity of whoever owns the number: a person\'s own cell goes to that person, an organization\'s main number to the organization. Each entry shows the line, in or out, how long, who took it, a play button if it was recorded, and notes. Calls from numbers the CRM doesn\'t know wait in Tools › Phone › Calls › To file. Tap File it to put one on a person or organization, Move to change where it went, or Not a customer to clear it.' },
  { t: 'Phone minutes and usage', w: 'phone usage minutes pool limit 1500 calls in out dashboard alert 90 percent', f: 'phone', b: 'Tools › Phone › Usage shows your calls and minutes this month. Admins also see the company: calling is unlimited under fair use, which is 3,000 minutes a month for each line, pooled across the company. The bar turns yellow at 75%, orange at 90% and red at 100%. Admins and the billing contact get an email at 90%, 95% and 100%, and a notice in Review. Add the Phone widgets to your dashboard with Add or remove.' },
  { t: 'A new Teams meeting for every booking', w: 'teams microsoft new meeting link every booking video outlook', b: 'Connect Microsoft 365 under Calendars, then go to Gear menu › your profile › My availability and pick A new Teams meeting for every booking. Each video booking gets its own Teams meeting, and the confirmation email waits a moment so it carries the link. If Microsoft can\'t make one, the booking says the link will follow and you get a notice to send it yourself.' },
  { t: 'Add your video meeting link', w: 'video zoom teams meet link meeting room availability profile round robin', b: 'Gear menu › your profile › My availability. Paste your Zoom, Teams or Google Meet link and tap Save video meetings. Video booking calendars use the link of whoever takes the booking, so round robin calendars send each customer the right room. If you use a personal room, turn on the waiting room in Zoom.' },
  { t: 'Set your hours and days off', w: 'hours availability working hours days off vacation time off schedule every account override', b: 'Tools › Hours and days off. Your usual hours and days off apply in every account you work in, so you set them once. An account can use its own hours for you instead: pick Save for that account, and they start as a copy of your usual ones. A day off can count everywhere or in just one account. Notes on days off that count everywhere only show to you and your home account; other accounts just see "Off". Admins of your home account can change your usual hours too.' },
  { t: 'Connect your calendar', w: 'calendar google outlook apple icloud ical ics sync busy connect block bookings', b: 'Gear menu › My availability (your profile). Paste the secret iCal address of your Google, Outlook or Apple calendar and tap Connect. Every 10 minutes the CRM reads it and blocks those times for bookings on every account you work in. Only you see what the events are. If it says the feed isn\'t working, the address was probably reset: paste the new one.' },
  { t: 'Turn on Routes (Beta)', w: 'routes route beta turn on feature settings', admin: true, b: 'Routes need the Time clock. Tools › Admin › Company setup › Settings › Features: turn on Time clock, then Routes (Beta). Routes then shows under Jobs (or Time) for admins and managers, and in My Day for the people on a route.' },
  { t: 'Build a route', w: 'route stops schedule daily weekly monthly custom dispatcher assign crew fill in', f: 'routes', admin: true, b: 'Open Routes and tap New route. Name it, pick how it repeats and the start time, the dispatcher (they get the first alert if nobody starts) and who runs it: people or crews, every time or as a fill-in for some days. Add stops on the route, or from a customer\'s page under Routes. Reorder stops with the arrows.' },
  { t: "When nobody starts a route", w: 'route late alert dispatcher grace split push tomorrow dismiss customers notify', f: 'routes', admin: true, b: "If nobody on a route clocks in within the grace time (15 minutes unless you change it), the dispatcher gets an urgent alert; 15 minutes later, all admins do. On the route's Day board you can split the stops between people for the day, mark someone late, dismiss today, or push it to tomorrow. Pushing asks if you want to email those customers now." },
  { t: 'Run your route', w: 'route my day arrived left stop gps location wrong pin incomplete photo video', f: 'routes', b: "My Day shows your route with stops in order. Tap Arrived when you get there and Left when you go. Your location is checked only when you tap. If you're far from the stop you get a warning and can tell your dispatcher the pin is wrong, just this time or for good. If you can't finish a stop, tap Can't finish, say why and add photos or videos." },
  { t: 'Location while on the clock', w: 'gps tracking location hourly privacy clock', f: 'routes', b: "The CRM never tracks you all day. Arrived, Left and clocking in or out save where your phone is at that moment. An admin can also turn on an hourly location check for a person, which only happens while they're clocked in with the CRM open. Admins: Routes › Hourly location while on the clock." },
];
// help an article applies to: admin-only articles for admins, feature articles only when that feature is on
const helpOk = (h) => (!h.admin || isAdmin()) && (!h.f || FLD.feat(h.f));

/* ================= What's new (weekly releases; release/notes.json) ================= */
// Shows once, on the first visit after a release, with only what this person can use. Missed a few weeks: one banner,
// newest first. Nothing they can use: no banner (it still counts as seen). New logins start from the latest release.
let NOTES = null;
async function releaseNotes() {
  if (NOTES) return NOTES;
  const r = await fetch('/release/notes.json', { cache: 'no-cache' }); NOTES = r.ok ? await r.json() : [];
  return NOTES;
}
const noteOk = (it) => (!it.admin || isAdmin()) && (!it.feature || FLD.feat(it.feature));
const relItems = (rels) => rels.map((r) => ({ ...r, items: (r.items || []).filter(noteOk) })).filter((r) => r.items.length);
const relDate = (id) => new Date(String(id).slice(0, 10) + 'T12:00:00').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
const relHtml = (rels) => rels.map((r) => `<div class="wnrel"><h3>${esc(relDate(r.id))}</h3>${r.items.map((it) => `<div class="wnitem"><b>${esc(it.t)}</b><p>${esc(it.b)}</p>
  ${(it.help || []).length ? `<button type="button" class="linkish" data-wnhelp="${esc(it.help[0])}">How to use it</button>` : ''}</div>`).join('')}</div>`).join('');
const wireRel = (root, before = () => {}) => $$('[data-wnhelp]', root).forEach((b) => (b.onclick = () => { before(); openHelp(b.dataset.wnhelp); }));
async function whatsNew() {
  const notes = await releaseNotes(); if (!notes.length || !S.me) return;
  const latest = notes[0].id, seen = S.me.release_seen;
  const mark = async () => { S.me.release_seen = latest; await sb.rpc('my_release_seen_set', { p_id: latest }); };
  if (!seen) return mark();                       // new here: nothing to catch up on
  if (seen >= latest) return;
  const rels = relItems(notes.filter((r) => r.id > seen));
  if (!rels.length) return mark();
  $('#wnBanner')?.remove();
  const b = document.createElement('div'); b.id = 'wnBanner'; b.className = 'wnbanner'; b.setAttribute('role', 'dialog'); b.setAttribute('aria-label', "What's new");
  b.innerHTML = `<div class="wnhead"><b>What's new${rels.length > 1 ? ` (${rels.length} updates)` : ''}</b><button type="button" class="btn small gold" data-wnok>Got it</button></div>
    <div class="wnbody">${relHtml(rels)}</div><button type="button" class="linkish" data-wnall>See every update</button>`;
  document.body.appendChild(b);
  const close = () => { b.remove(); mark().catch(() => {}); };
  $('[data-wnok]', b).onclick = close;
  $('[data-wnall]', b).onclick = () => { close(); go('whatsnew'); };
  wireRel(b, close);
}
async function viewWhatsNew(main) {
  const rels = relItems(await releaseNotes());
  main.innerHTML = `<h1>What's new</h1><p class="hint">Updates come out once a week, early Sunday morning. You only see what your account and your role can use.</p>
    <div class="card">${relHtml(rels) || '<p class="empty">No updates yet.</p>'}</div>`;
  wireRel(main);
}

const PRACTICE = { on: false, made: 0 };
let TOUR = null;
const PRACTICE_RPCS = { proposal_send: { version: 0 }, chat_reply: {}, team_send: {}, member_reply: {}, site_request: {}, site_request_reply: {}, directory_invite_member: {}, payments_set: {},
  import_rows: {}, merge_records: {}, request_delete: {}, create_account: { id: null }, team_recall: {} };
{
  const rpc = sb.rpc.bind(sb), inv = sb.functions.invoke.bind(sb.functions);
  sb.rpc = (name, args, opts) => PRACTICE.on && name in PRACTICE_RPCS ? (practiceDone(), Promise.resolve({ data: PRACTICE_RPCS[name], error: null })) : rpc(name, args, opts);
  sb.functions.invoke = (name, opts) => PRACTICE.on ? (practiceDone(), Promise.resolve({ data: { practice: true, to: 'nobody (practice)' }, error: null })) : inv(name, opts);
}
const practiceDone = () => toast('Done! In real use, this would have sent. Practice mode kept it from going out.');

function tourWarn(t) {
  return new Promise((res) => {
    const ov = document.createElement('div'); ov.className = 'tourwarn';
    ov.innerHTML = `<div class="card" role="dialog" aria-label="Practice mode"><h2>${esc(t.title)}</h2>
      <p><b>Practice mode.</b> Anything you do during this walkthrough is practice and will be deleted at the end. Nothing gets sent or charged.</p>
      <p class="hint">Click the highlighted button each time to move ahead. Stop anytime with Stop or Esc.</p>
      <div class="actions"><button class="btn ghost" data-x>Not now</button><button class="btn gold" data-go>Start</button></div></div>`;
    document.body.appendChild(ov);
    const done = (v) => { ov.remove(); res(v); };
    $('[data-go]', ov).onclick = () => done(true); $('[data-x]', ov).onclick = () => done(false);
    $('[data-go]', ov).focus();
  });
}

async function startTour(id) {
  const t = TOURS[id]; if (!t) return;
  if (TOUR) await endTour(true);
  closeHelp();
  if (t.practice) {
    if (!(await tourWarn(t))) return;
    const { error } = await sb.rpc('practice_start'); if (error) return fail(error);
    PRACTICE.on = true; document.body.classList.add('practicing');
  }
  const seen = recall('toursSeen', {}); seen[id] = true; store('toursSeen', seen);
  TOUR = { id, t, i: 0, cleanup: [] };
  if (t.view && S.view !== t.view) go(t.view);
  const ui = document.createElement('div'); ui.className = 'tour';
  ui.innerHTML = `${['t', 'r', 'b', 'l'].map((k) => `<div class="tshade" data-s="${k}"></div>`).join('')}<div class="tring"></div>
    <div class="tourcard" role="dialog" aria-live="polite"><div class="tarrow"></div>${PRACTICE.on ? '<div class="tbadge">Practice</div>' : ''}<small class="tstep"></small><p class="ttext"></p>
      <div class="tbtns"><button type="button" class="btn ghost small" data-tstop>Stop</button><button type="button" class="btn small" data-tnext>Next</button></div></div>`;
  document.body.appendChild(ui); TOUR.ui = ui;
  $('[data-tstop]', ui).onclick = () => endTour();
  $('[data-tnext]', ui).onclick = () => nextStep();
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); endTour(); } };
  document.addEventListener('keydown', key, true); TOUR.cleanup.push(() => document.removeEventListener('keydown', key, true));
  const loop = () => { if (!TOUR) return; place(); TOUR.raf = requestAnimationFrame(loop); }; loop();
  showStep();
}
// find the step's element, waiting a moment for the screen to draw it
async function findEl(step) {
  for (let n = 0; n < 40; n++) {
    const el = typeof step.el === 'function' ? step.el() : $(step.el);
    if (el && visible(el)) return el;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
async function showStep() {
  const T = TOUR; if (!T) return;
  const step = T.t.steps[T.i];
  if (!step) return endTour(false, true);
  (T.stepOff || []).forEach((f) => f()); T.stepOff = [];
  const my = T.seq = (T.seq || 0) + 1;
  T.el = null; T.ui.classList.add('twait');
  const el = await findEl(step);
  if (TOUR !== T || T.seq !== my) return;   // a newer step took over while this one was waiting
  if (!el) { T.i++; return showStep(); }   // a screen without that piece (a permission, an empty list): skip it
  T.el = el; T.ui.classList.remove('twait');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('.tstep', T.ui).textContent = `${T.t.title} · ${T.i + 1} of ${T.t.steps.length}`;
  const act = step.act || 'next';
  $('.ttext', T.ui).textContent = (act === 'click' ? 'Click this. ' : '') + (typeof step.text === 'function' ? step.text() : step.text);
  const nb = $('[data-tnext]', T.ui);
  nb.textContent = T.i === T.t.steps.length - 1 ? 'Finish' : 'Next';
  nb.hidden = act === 'click'; nb.disabled = act === 'type';
  if (act === 'click') {
    const on = () => { T.seq++; T.el = null; T.ui.classList.add('twait'); setTimeout(nextStep, 350); };
    el.addEventListener('click', on, { once: true }); T.stepOff.push(() => el.removeEventListener('click', on));
  }
  if (act === 'type') {
    const on = () => { nb.disabled = !(el.value || el.textContent || '').trim(); };
    el.addEventListener('input', on); T.stepOff.push(() => el.removeEventListener('input', on));
    setTimeout(() => el.focus({ preventScroll: true }), 300); on();
  }
}
function nextStep() { if (!TOUR) return; TOUR.i++; showStep(); }
// the gray around the highlighted piece, and the card beside it with its arrow pointing at it
function place() {
  const T = TOUR; if (!T?.ui) return;
  const ui = T.ui, card = $('.tourcard', ui), ring = $('.tring', ui), sh = (k) => $(`[data-s="${k}"]`, ui);
  const W = innerWidth, H = innerHeight;
  if (!T.el || !T.el.isConnected) {
    if (T.el && !T.el.isConnected && !ui.classList.contains('twait')) { T.el = null; showStep(); }
    Object.assign(sh('t').style, { left: 0, top: 0, width: W + 'px', height: H + 'px' }); ['r', 'b', 'l'].forEach((k) => (sh(k).style.width = '0px'));
    ring.style.display = 'none'; card.style.visibility = 'hidden'; return;
  }
  const r = T.el.getBoundingClientRect(), p = 6;
  const x1 = Math.max(0, r.left - p), y1 = Math.max(0, r.top - p), x2 = Math.min(W, r.right + p), y2 = Math.min(H, r.bottom + p);
  Object.assign(sh('t').style, { left: 0, top: 0, width: W + 'px', height: y1 + 'px' });
  Object.assign(sh('b').style, { left: 0, top: y2 + 'px', width: W + 'px', height: Math.max(0, H - y2) + 'px' });
  Object.assign(sh('l').style, { left: 0, top: y1 + 'px', width: x1 + 'px', height: Math.max(0, y2 - y1) + 'px' });
  Object.assign(sh('r').style, { left: x2 + 'px', top: y1 + 'px', width: Math.max(0, W - x2) + 'px', height: Math.max(0, y2 - y1) + 'px' });
  Object.assign(ring.style, { display: 'block', left: x1 + 'px', top: y1 + 'px', width: (x2 - x1) + 'px', height: (y2 - y1) + 'px' });
  // card: below the piece if there's room, else above, else beside; always on screen, never covering it
  card.style.visibility = 'visible';
  const cw = Math.min(320, W - 24), ch = card.offsetHeight, gap = 14;
  card.style.width = cw + 'px';
  let side = H - y2 >= ch + gap + 8 ? 'below' : y1 >= ch + gap + 8 ? 'above' : W - x2 >= cw + gap + 8 ? 'right' : 'left';
  let left, top;
  if (side === 'below' || side === 'above') {
    left = Math.min(Math.max(12, (x1 + x2) / 2 - cw / 2), W - cw - 12);
    top = side === 'below' ? y2 + gap : y1 - gap - ch;
  } else {
    top = Math.min(Math.max(12, (y1 + y2) / 2 - ch / 2), H - ch - 12);
    left = side === 'right' ? x2 + gap : Math.max(12, x1 - gap - cw);
  }
  Object.assign(card.style, { left: left + 'px', top: top + 'px' });
  card.dataset.side = side;
  const arrow = $('.tarrow', card);
  if (side === 'below' || side === 'above') { arrow.style.left = Math.min(cw - 22, Math.max(10, (x1 + x2) / 2 - left - 8)) + 'px'; arrow.style.top = ''; }
  else { arrow.style.top = Math.min(ch - 22, Math.max(10, (y1 + y2) / 2 - top - 8)) + 'px'; arrow.style.left = ''; }
}
async function endTour(silent = false, finished = false) {
  const T = TOUR; if (!T) return;
  TOUR = null; cancelAnimationFrame(T.raf);
  (T.stepOff || []).forEach((f) => f()); T.cleanup.forEach((f) => f()); T.ui?.remove();
  if (PRACTICE.on) {
    PRACTICE.on = false; document.body.classList.remove('practicing');
    const { data, error } = await sb.rpc('practice_end');
    if (error) fail(error);
    else if (!silent) toast(`${finished ? 'Nice work. ' : ''}Practice cleaned up${data?.removed ? `: ${plural(data.removed, 'practice record')} deleted` : ''}.`);
    if (typeof resetQE === 'function') resetQE();
    if (!silent) go(T.t.view || 'dashboard');
  } else if (finished && !silent) toast('That\'s it. Press F1 or the ? button anytime for more.');
}
// a walkthrough left open last time (closed tab): clean up its practice records
async function practiceRecover() {
  try { const { data } = await sb.rpc('practice_status'); if (data?.open) { const { data: d } = await sb.rpc('practice_end'); if (d?.removed) toast(`Cleaned up ${plural(d.removed, 'practice record')} from a walkthrough you didn't finish`); } } catch {}
}

function closeHelp() { $('.helppanel')?.remove(); }
function openHelp(q = '') {
  if ($('.helppanel')) return closeHelp();
  const tourFor = (v) => Object.entries(TOURS).find(([, t]) => t.view === v || (v === 'org' && t.view === 'orgs'))?.[0];
  const here = tourFor(S.view);
  const pn = document.createElement('div'); pn.className = 'helppanel'; pn.setAttribute('role', 'dialog'); pn.setAttribute('aria-label', 'Help');
  pn.innerHTML = `<div class="hphead"><b>Help</b><button type="button" class="btn ghost small" data-hx>Close</button></div>
    <input type="search" id="hpQ" placeholder="How do I…" value="${esc(q)}" autocomplete="off">
    ${here ? `<button type="button" class="btn gold block small" data-tour="${here}">Show me around this screen</button>` : ''}
    <button type="button" class="btn ghost block small" data-wn>What's new</button>
    <div class="hplist" id="hpList"></div>
    <small class="hint">Press F1 or ? anytime to open this. Walkthroughs run in practice mode, so nothing you do in them is kept or sent.</small>`;
  document.body.appendChild(pn);
  const off = pushLayer(() => pn.remove());
  const shut = () => { pn.remove(); off(); };
  $('[data-hx]', pn).onclick = shut;
  $('[data-wn]', pn).onclick = () => { shut(); go('whatsnew'); };
  const paint = () => {
    const words = $('#hpQ').value.toLowerCase().split(/\s+/).filter(Boolean);
    const list = HELP.filter((h) => helpOk(h) && words.every((w) => (h.t + ' ' + h.w + ' ' + h.b).toLowerCase().includes(w)));
    $('#hpList').innerHTML = list.map((h) => `<details class="hpitem"><summary>${esc(h.t)}</summary><p>${esc(h.b)}</p>${h.tour ? `<button type="button" class="btn small" data-tour="${h.tour}">Show me</button>` : ''}</details>`).join('')
      || '<p class="hint">Nothing matches. Try other words, or use Suggest on the right edge to ask the team.</p>';
    bind();
  };
  const bind = () => $$('[data-tour]', pn).forEach((b) => (b.onclick = () => { shut(); setTimeout(() => startTour(b.dataset.tour), 50); }));
  $('#hpQ').oninput = paint; paint();
  if (isWide()) $('#hpQ').focus();
}
// F1 or ? anywhere (not while typing) opens help
document.addEventListener('keydown', (e) => {
  if (!S.me?.active || TOUR) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === 'F1' || (e.key === '?' && !typing)) { e.preventDefault(); openHelp(); }
});
// the first time someone opens a screen that has a walkthrough, offer it (once)
function offerTour() {
  $('.touroffer')?.remove();
  if (TOUR || !S.me?.active) return;
  const seen = recall('toursSeen', {});
  const firstEver = !seen._welcome;
  const id = firstEver ? 'nav' : Object.entries(TOURS).find(([k, t]) => t.view === S.view && !seen[k] && !seen['skip_' + k])?.[0];
  if (!id) return;
  const t = TOURS[id];
  const b = document.createElement('div'); b.className = 'touroffer';
  b.innerHTML = `<span>${firstEver ? '<b>Welcome!</b> Press F1 or the ? button anytime for help. Want a 1 minute tour?' : `New here? Take the quick walkthrough: <b>${esc(t.title)}</b>`}</span>
    <button type="button" class="btn small gold" data-y>Show me</button><button type="button" class="btn ghost small" data-n>Not now</button>`;
  document.body.appendChild(b);
  const mark = (k) => { const s = recall('toursSeen', {}); s[k] = true; s._welcome = true; store('toursSeen', s); };
  $('[data-y]', b).onclick = () => { b.remove(); mark('_welcome'); startTour(id); };
  $('[data-n]', b).onclick = () => { b.remove(); mark('skip_' + id); };
}

/* ================= WHITE LABELS: brand + Platform admin (Oct 26) ================= */
// The brand everyone sees: the white label of the agency their account sits under (LNP Platforms, the top of the platform, when there is none).
let BRAND = null;
const DEFAULT_BRAND = { name: 'LNP Platforms', short_name: 'LNP', primary_color: '#1A2A52', accent_color: '#C9A04A' };
// dark: the navy top bar, so a white label's logo for dark backgrounds wins there (Cognix's navy wordmark vanished on it)
function brandMark(dark = false) {
  const b = BRAND || DEFAULT_BRAND;
  const logo = (dark && b.logo_reverse_url) || b.logo_url;
  if (logo) return `<img class="brandlogo" src="${esc(logo)}" alt="${esc(b.name)}">`;
  if (/platforms?$/i.test(b.name)) return `${esc(b.short_name || b.name.replace(/\s*platforms?$/i, ''))} <span>Platforms</span>`;
  return `${esc(b.short_name || b.name.replace(/\s*CRM$/i, ''))} <span>CRM</span>`;
}
function applyBrand(b) {
  BRAND = b && b.name ? b : null;
  const x = BRAND || DEFAULT_BRAND, r = document.documentElement.style, ok = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
  if (BRAND && ok(x.primary_color)) r.setProperty('--navy', x.primary_color); else r.removeProperty('--navy');
  if (BRAND && ok(x.accent_color)) r.setProperty('--gold', x.accent_color); else r.removeProperty('--gold');
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = ok(x.primary_color) ? x.primary_color : '#1A2A52';
  document.title = brandTitle();
  // the tab icon follows the brand you're in, even at another brand's address (switching into Cognix shows the Cognix C)
  const url = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(u || '') ? u : '');
  const setIcon = (sel, href) => { const l = document.querySelector(sel); if (l && l.getAttribute('href') !== href) l.setAttribute('href', href); };
  setIcon('link[rel="icon"]', (BRAND && url(x.favicon_url)) || 'favicon.png');
  setIcon('link[rel="apple-touch-icon"]', (BRAND && url(x.apple_icon_url)) || 'icon-180.png');
}
// before sign-in: the white label for the web address (custom domains)
async function brandForHost() {
  if (/^localhost$|^127\./.test(location.hostname)) return;
  try { const { data } = await sb.rpc('brand_for_host', { p_host: location.hostname }); if (data) { applyBrand(data); $$('.auth .logo').forEach((el) => (el.innerHTML = brandMark())); $$('.topbar .brand').forEach((el) => (el.innerHTML = brandMark(true))); } } catch {}
}

async function viewPlatform(main) {
  const [{ data: accts, error }, { data: wls }] = await Promise.all([sb.rpc('platform_accounts'), sb.from('white_labels').select('*').order('name')]);
  if (error) throw error;
  const all = accts || [], agencies = all.filter((a) => a.is_agency), wl = (id) => (wls || []).find((w) => w.agency_tenant_id === id);
  const opt = (sel) => agencies.map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(wl(a.id)?.name || a.name)}</option>`).join('');
  const wlForm = (a) => { const w = wl(a.id) || {};
    return `<form class="card wlform" data-wl="${a.id}"><div class="toolbar"><h2 style="margin:0;flex:1">${esc(w.name || a.name)}</h2>
        <span class="wlprev" style="--p:${esc(w.primary_color || '#1A2A52')};--a:${esc(w.accent_color || '#C9A04A')}">${w.logo_url ? `<img src="${esc(w.logo_url)}" alt="">` : `${esc(w.short_name || w.name || a.name)} <b>CRM</b>`}</span></div>
      <small class="hint">Agency account: <b>${esc(a.name)}</b> · ${plural(all.filter((x) => x.agency_id === a.id && x.id !== a.id).length, 'account')} under it. Its admins get their own Accounts panel for these.</small>
      <div class="row"><div><label class="label">Brand name</label><input type="text" name="name" value="${esc(w.name || (a.id === LNP_TENANT ? 'LNP Platforms' : a.id === GELP_TENANT ? 'GELP CRM' : a.name + ' CRM'))}" maxlength="60" required></div>
        <div><label class="label">Short name (top bar)</label><input type="text" name="short_name" value="${esc(w.short_name || '')}" maxlength="24" placeholder="GELP"></div></div>
      <div class="row"><div><label class="label">Logo link (PNG or SVG, wide)</label><input type="text" name="logo_url" value="${esc(w.logo_url || '')}" placeholder="https://…/logo.png"></div>
        <div><label class="label">Web address</label><input type="text" name="domain" value="${esc(w.domain || '')}" placeholder="app.theirbrand.com"></div></div>
      <div class="row"><div class="colorpair"><div><label class="label">Main color</label><input type="color" data-nobrand name="primary_color" value="${esc(w.primary_color || '#1A2A52')}"></div>
          <div><label class="label">Accent color</label><input type="color" data-nobrand name="accent_color" value="${esc(w.accent_color || '#C9A04A')}"></div></div>
        <div><label class="label">Emails come from (name)</label><input type="text" name="email_from_name" value="${esc(w.email_from_name || '')}" placeholder="${esc(w.name || a.name)}"></div></div>
      <div class="row"><div><label class="label">Support email</label><input type="email" name="support_email" value="${esc(w.support_email || '')}"></div>
        <div><label class="label">Emails send from (domain)</label><input type="text" name="send_domain" value="${esc(w.send_domain || '')}" placeholder="send.theirbrand.com" maxlength="120">
          <small class="hint">Add it in Resend first and wait for Verified. Blank: the shared sending domain.</small></div></div>
      <details class="wlicons"><summary>App icons and favicon${w.icon_512_url ? ' (set)' : ' (using LNP\'s for now)'}</summary>
        <small class="hint">What people see on their home screen and browser tab when they install the app from this web address. Paste permanent links from Media (PNG, square).</small>
        <div class="row"><div><label class="label">Favicon (32 x 32)</label><input type="text" name="favicon_url" value="${esc(w.favicon_url || '')}" placeholder="https://…/favicon-32.png"></div>
          <div><label class="label">iPhone home screen (180 x 180)</label><input type="text" name="apple_icon_url" value="${esc(w.apple_icon_url || '')}" placeholder="https://…/apple-touch-icon.png"></div></div>
        <div class="row"><div><label class="label">App icon (192 x 192)</label><input type="text" name="icon_192_url" value="${esc(w.icon_192_url || '')}"></div>
          <div><label class="label">App icon (512 x 512)</label><input type="text" name="icon_512_url" value="${esc(w.icon_512_url || '')}"></div></div>
        <div class="row"><div><label class="label">Android maskable icon (512 x 512, logo in the middle 60%)</label><input type="text" name="icon_maskable_url" value="${esc(w.icon_maskable_url || '')}"></div>
          <div><label class="label">Logo for dark backgrounds (optional)</label><input type="text" name="logo_reverse_url" value="${esc(w.logo_reverse_url || '')}"></div></div></details>
      <div class="actions"><button class="btn small" type="submit">${w.id ? 'Save brand' : 'Create white label'}</button></div></form>`; };
  main.innerHTML = `<h1>Platform</h1>
    <p class="hint" style="margin:-6px 0 12px">Only you see this. Every white label runs on this same CRM. Each one is an agency account with its own brand, and its admins manage the accounts under it from their own Accounts panel. LNP Platforms is the top; GELP and Get Coast Customers are agencies under it.</p>
    <div class="card"><h2>Alerts</h2><small class="hint" style="margin:-4px 0 8px">Every support request, suggestion and automatic error report goes to this person right away, by push and email.</small>
      <div class="row"><div><label class="label" for="paUser">Send alerts to</label><select id="paUser">${staff().map((u) => `<option value="${u.id}">${esc(u.full_name || u.email)}</option>`).join('')}</select></div>
        <div style="align-self:end"><button class="btn small" id="paSave">Save</button></div></div></div>
    <div id="phPlat"></div>
    <h2 class="section">White labels (${agencies.length})</h2>
    ${agencies.map(wlForm).join('')}
    <div class="card"><h2>New white label</h2><small class="hint" style="margin:-4px 0 8px">Creates the agency account for it. Invite its owner and they become that agency's admin.</small>
      <div class="row"><div><label class="label" for="nwName">Agency name</label><input type="text" id="nwName" placeholder="Red White and Blue Marketing"></div>
        <div><label class="label" for="nwSlug">Short name</label><input type="text" id="nwSlug" placeholder="rwb"></div></div>
      <div class="row"><div><label class="label" for="nwOwner">Owner's email</label><input type="email" id="nwOwner"></div><div><label class="label" for="nwOwnerName">Owner's name</label><input type="text" id="nwOwnerName"></div></div>
      <div class="actions"><button class="btn" id="nwGo">Create white label</button></div></div>
    <h2 class="section">Every account (${all.length})</h2>
    <div class="card">${all.map((a) => `<div class="person-row" data-acc="${a.id}"><div class="toolbar"><div style="flex:1"><b>${esc(a.name)}</b> ${a.is_root ? '<span class="badge gold">Platform (top)</span>' : a.is_agency ? '<span class="badge gold">White label</span>' : ''}${a.plan === 'starter' ? ' <span class="badge">Free</span>' : ''}<br>
        <small>${a.users} people · ${a.orgs} organizations · created ${esc(fmtDate(a.created_at))}</small></div>
        ${a.id === S.acct.id ? '' : `<button class="btn small secondary" data-pinto="${a.id}">Switch in</button>`}</div>
        ${a.is_agency ? '' : `<div class="pline"><label class="label" style="margin:0">Under</label><select data-under>${opt(a.agency_id)}</select></div>`}
        <button class="btn ghost small" data-logins="${a.id}">Logins and password resets</button><div data-loginsbox="${a.id}"></div>
        ${a.id === S.acct.home ? '' : `<button class="btn ghost small" data-memadd="${a.id}">Add to this account as a team member</button><div data-membox="${a.id}"></div>`}</div>`).join('')}</div>`;
  sb.rpc('platform_alert_get').then(({ data }) => { if (data?.user_id && $('#paUser')) { if (![...$('#paUser').options].some((o) => o.value === data.user_id)) $('#paUser').insertAdjacentHTML('afterbegin', `<option value="${data.user_id}">${esc(data.name || 'Current')}</option>`); $('#paUser').value = data.user_id; } }, () => {});
  PHN.platformCard($('#phPlat', main)).catch(() => {});
  $('#paSave').onclick = async () => { const { error } = await sb.rpc('platform_alert_set', { p_user: $('#paUser').value }); if (error) return fail(error); toast('Alerts go to ' + ($('#paUser').selectedOptions[0]?.textContent || 'them')); };
  $$('form[data-wl]').forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(f)); d.agency_tenant_id = f.dataset.wl;
    const { error } = await sb.rpc('platform_save_white_label', { p: d }); if (error) return fail(error);
    if (f.dataset.wl === S.acct.id || f.dataset.wl === S.acct.home) S.acct = (await sb.rpc('current_account')).data || S.acct;
    toast('Brand saved'); renderShell();
  }));
  $('#nwGo').onclick = async () => {
    const b = $('#nwGo'); b.disabled = true;
    const { data, error } = await sb.rpc('create_account', { p_name: $('#nwName').value, p_slug: $('#nwSlug').value, p_owner_email: $('#nwOwner').value, p_owner_name: $('#nwOwnerName').value, p_agency: LNP_TENANT });
    if (error) { b.disabled = false; return fail(error); }
    const r1 = await sb.rpc('platform_set_account', { p_tenant: data.id, p_agency: null, p_is_agency: true }); if (r1.error) { b.disabled = false; return fail(r1.error); }
    const r2 = await sb.rpc('platform_save_white_label', { p: { agency_tenant_id: data.id, name: $('#nwName').value.trim() + ' CRM' } }); b.disabled = false; if (r2.error) return fail(r2.error);
    await loadAccounts();
    const owner = $('#nwOwner').value.trim(); const sent = owner ? await sendInvite(data.id, owner, true) : false;
    toast(`White label created${owner ? (sent ? `, invite emailed to ${owner}` : ', but the invite email didn\'t go out (send it from its Accounts panel)') : ''}. Set its colors and logo below.`, { error: !!owner && !sent }); renderShell();
  };
  $$('[data-under]').forEach((sel) => (sel.onchange = async () => {
    const { error } = await sb.rpc('platform_set_account', { p_tenant: sel.closest('[data-acc]').dataset.acc, p_agency: sel.value, p_is_agency: null });
    if (error) return fail(error); toast('Moved');
  }));
  $$('[data-pinto]').forEach((b) => (b.onclick = async () => { const { error } = await sb.rpc('set_acting_tenant', { p_tenant: b.dataset.pinto }); if (error) return fail(error); location.hash = '#orgs'; location.reload(); }));
  memberAdderButtons(main, all);
  wireLoginButtons(main);
}

// Accounts and Platform: put people from your own account on a client account's team (a real member there, not just switching in)
function memberAdderButtons(main, accts) {
  $$('[data-memadd]', main).forEach((b) => (b.onclick = () => {
    const box = $(`[data-membox="${b.dataset.memadd}"]`, main);
    if (box.innerHTML) return (box.innerHTML = '');
    memberAdder(box, accts.find((a) => a.id === b.dataset.memadd) || { id: b.dataset.memadd, name: 'this account' }).catch(fail);
  }));
}
async function memberAdder(box, t) {
  const [{ data: cands, error }, { data: mems }] = await Promise.all([
    sb.rpc('account_member_candidates', { p_tenant: t.id }), sb.rpc('account_members_list', { p_tenant: t.id })]);
  if (error) return fail(error);
  const free = (cands || []).filter((c) => !c.member);
  box.innerHTML = `<div class="memadd"><b>Your people on ${esc(t.name)}'s team</b>
    ${(mems || []).map((m) => `<div class="pline"><span style="flex:1">${esc(m.full_name)} <small>${m.is_admin ? 'Admin' : 'Team member'} · from ${esc(m.from)}</small></span><button type="button" class="btn ghost small danger" data-amrm="${m.user_id}">Remove</button></div>`).join('')
      || '<small class="hint">Nobody from your side is on their team yet.</small>'}
    ${free.length ? `<div class="pline"><select data-amwho aria-label="Who to add">${free.map((c) => `<option value="${c.id}">${esc(c.name || c.email)}</option>`).join('')}</select>
      <label class="check" style="margin:0"><input type="checkbox" data-amadmin> Admin there</label><button type="button" class="btn small" data-amgo>Add to their team</button></div>`
      : '<small class="hint">Everyone on your team is already on theirs.</small>'}
    <small class="hint">They show up on ${esc(t.name)}'s Team screen, calendars and pickers, and get to it from the account menu at the top. ${esc(t.name)} can change their role or take them off. No email goes out; they use the login they already have.</small></div>`;
  const go = $('[data-amgo]', box);
  if (go) go.onclick = async () => {
    const who = $('[data-amwho]', box).value, name = free.find((c) => c.id === who)?.name || 'They';
    const { error: e } = await sb.rpc('account_member_add', { p_tenant: t.id, p_user: who, p_is_admin: $('[data-amadmin]', box).checked });
    if (e) return fail(e);
    toast(`${name} is on ${t.name}'s team now`); memberAdder(box, t);
  };
  $$('[data-amrm]', box).forEach((b) => (b.onclick = async () => {
    const m = (mems || []).find((x) => x.user_id === b.dataset.amrm);
    if (!confirm(`Take ${m?.full_name || 'them'} off ${t.name}'s team?`)) return;
    const { error: e } = await sb.rpc('account_member_remove', { p_user: b.dataset.amrm, p_tenant: t.id });
    if (e) return fail(e);
    toast('Removed'); memberAdder(box, t);
  }));
}

/* ================= BUSINESS PORTAL (directory listing logins) ================= */
// A business login only ever sees its own listings, through member_home(). Edits go to the directory's admins
// for approval unless the directory turns approval off. Visitors never see the business's email.
const LISTING_FIELDS = [
  ['name', 'Business name'], ['address', 'Street address'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'],
  ['main_phone', 'Phone'], ['website', 'Website'], ['tagline', 'Short tagline'], ['description', 'Description'], ['hours', 'Hours'],
  ['services', 'Services'], ['social', 'Social links'], ['photos', 'Photos'], ['categories', 'Categories'],
];
const ORG_KEYS = ['name', 'address', 'city', 'state', 'zip', 'main_phone', 'website'];
const FEATURE_OF = { website: 'website', description: 'description', hours: 'hours', services: 'services', social: 'social', photos: 'photos' };
const listingCurrent = (L) => ({ ...L.org, tagline: L.profile?.tagline || '', description: L.profile?.description || '', hours: L.profile?.hours || '',
  services: L.profile?.services || [], social: L.profile?.social || {}, photos: L.profile?.photos || [], categories: L.chosen || [] });
const showVal = (k, v) => k === 'services' ? (v || []).join(', ') : k === 'social' ? Object.entries(v || {}).map(([a, b]) => `${a}: ${b}`).join(' · ')
  : k === 'photos' ? `${(v || []).length} photo${(v || []).length === 1 ? '' : 's'}` : k === 'categories' ? `${(v || []).length} categor${(v || []).length === 1 ? 'y' : 'ies'}` : String(v ?? '');
async function uploadListingPhoto(tenantId, listingId, file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Use a PNG, JPG, WebP or GIF image');
  if (file.size > 5 * 1024 * 1024) throw new Error('Keep each photo under 5 MB');
  const ext = ((file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'jpg';
  const path = `${tenantId}/listings/${listingId}/photo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const up = await sb.storage.from('media').upload(path, file, { contentType: file.type, upsert: false });
  if (up.error) throw up.error;
  return sb.storage.from('media').getPublicUrl(path).data.publicUrl;
}
function photoEditor(box, photos, onChange, upload) {
  const draw = () => {
    box.innerHTML = `<div class="photogrid">${photos.map((p, i) => `<div class="photo"><img src="${esc(p.url)}" alt="">
        <input type="text" data-cap="${i}" value="${esc(p.caption || '')}" placeholder="Caption (optional)" maxlength="140" aria-label="Photo ${i + 1} caption">
        <div class="photobtns"><button type="button" class="linkish" data-pl="${i}" aria-label="Move left">←</button><button type="button" class="linkish" data-pr="${i}" aria-label="Move right">→</button>
        <button type="button" class="linkish danger" data-px="${i}">Remove</button></div></div>`).join('')}</div>
      ${photos.length < 12 ? '<button type="button" class="btn ghost small" data-padd>+ Add photos</button>' : '<small class="hint">12 photos is the most a listing can have.</small>'}`;
    $$('[data-cap]', box).forEach((inp) => (inp.oninput = () => { photos[+inp.dataset.cap].caption = inp.value; onChange(); }));
    $$('[data-px]', box).forEach((b) => (b.onclick = () => { photos.splice(+b.dataset.px, 1); onChange(); draw(); }));
    $$('[data-pl]', box).forEach((b) => (b.onclick = () => { const i = +b.dataset.pl; if (i > 0) { [photos[i - 1], photos[i]] = [photos[i], photos[i - 1]]; onChange(); draw(); } }));
    $$('[data-pr]', box).forEach((b) => (b.onclick = () => { const i = +b.dataset.pr; if (i < photos.length - 1) { [photos[i + 1], photos[i]] = [photos[i], photos[i + 1]]; onChange(); draw(); } }));
    const add = $('[data-padd]', box);
    if (add) add.onclick = () => {
      const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
      inp.onchange = async () => {
        const files = [...inp.files].slice(0, 12 - photos.length); if (!files.length) return;
        add.disabled = true; add.textContent = 'Uploading…';
        for (const f of files) { try { photos.push({ url: await upload(f), caption: '' }); } catch (e) { fail(e); } }
        onChange(); draw();
      };
      inp.click();
    };
  };
  draw();
}
function threadView(box, threadId, { canReply, onSent }) {
  const load = async () => {
    const { data: t, error } = await sb.rpc('directory_thread_open', { p_thread: threadId });
    if (error) return fail(error);
    if (!t) { box.innerHTML = '<p class="empty">Conversation not found.</p>'; return; }
    box.innerHTML = `<div class="thread"><div class="threadhead"><b>${esc(t.name)}</b><small>${esc([t.email, t.phone].filter(Boolean).join(' · '))} · started ${esc(fmtDate(t.at))}</small></div>
      <div class="msgs">${t.messages.map((m) => `<div class="msg ${m.from === 'business' ? 'mine' : ''}"><small>${esc(m.from === 'business' ? (m.who || 'You') : t.name)} · ${esc(new Date(m.at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}</small><div>${esc(m.body).replace(/\n/g, '<br>')}</div></div>`).join('')}</div>
      ${canReply && t.can_reply ? `<textarea id="thReply" rows="3" placeholder="Write a reply. It's sent from the directory, so your email stays private."></textarea><div class="actions"><button class="btn" id="thSend">Send reply</button></div>`
        : '<small class="hint">Only the business can reply to its messages.</small>'}</div>`;
    const s = $('#thSend', box);
    if (s) s.onclick = async () => {
      const body = $('#thReply', box).value.trim(); if (!body) return toast('Write a reply first');
      s.disabled = true;
      const { error: e } = await sb.rpc('member_reply', { p_thread: threadId, p_body: body });
      s.disabled = false; if (e) return fail(e);
      sb.functions.invoke('directory-email', { body: { kind: 'reply', thread: threadId } }).catch(() => {});
      toast('Reply sent'); load(); onSent?.();
    };
  };
  load();
}

const MH = { tab: {} };
async function renderMemberHome(host) {
  // inside the CRM (free accounts and clients with listings) it draws in the page; a business-only login gets its own page
  if (host !== undefined) MH.host = host;
  if (MH.host && !document.body.contains(MH.host)) MH.host = null;
  const inCrm = !!MH.host;
  if (!inCrm) { closeDock(); $('#tcDock')?.remove(); }
  const { data, error } = await sb.rpc('member_home');
  if (error) return fail(error);
  const ls = data?.listings || [];
  // new customer messages: chime and a note, checked every 15 seconds while the portal is open
  const unreadNow = ls.reduce((a, L) => a + (L.threads || []).filter((t) => t.unread).length, 0);
  if (MH.unread != null && unreadNow > MH.unread) { playChime(); toast('New message from a customer'); }
  MH.unread = unreadNow;
  if (!MH.watch && !inCrm) MH.watch = setInterval(async () => {
    if (document.hidden || S.me?.role !== 'member') return;
    const { data: d2 } = await sb.rpc('member_home'); if (!d2) return;
    const n = (d2.listings || []).reduce((a, L) => a + (L.threads || []).filter((t) => t.unread).length, 0);
    if (n > (MH.unread || 0)) { playChime(); toast('New message from a customer'); if (MH.sel === 'all') { MH.unread = n; return renderMemberHome(); } }
    MH.unread = n;
  }, 15000);
  // everyone lands on the dashboard (how the directory is working for them), then Manage opens a listing.
  // (Room is left in the top bar for the starter CRM, phase 3; that tab only appears once it's turned on.)
  const multi = ls.length > 1;
  if (!MH.sel || (MH.sel !== 'all' && !ls.some((L) => L.id === MH.sel))) MH.sel = 'all';
  const dirNames = [...new Set(ls.map((L) => L.directory?.name).filter(Boolean))];
  const pick = multi ? `<select id="mhPick" class="acctswitch" aria-label="Switch listing"><option value="all" ${MH.sel === 'all' ? 'selected' : ''}>All my listings (dashboard)</option>${ls.map((L) => `<option value="${L.id}" ${MH.sel === L.id ? 'selected' : ''}>${esc(L.org.name)}${dirNames.length > 1 ? ' · ' + esc(L.directory.name) : ''}</option>`).join('')}</select>` : '';
  const empty = !ls.length ? '<h1>Your listing</h1><p class="empty">Your login isn\'t connected to a listing yet. Ask the directory\'s team to send you a new invite.</p>' : '';
  if (inCrm) MH.host.innerHTML = `${pick ? `<div class="toolbar" style="justify-content:flex-end">${pick}</div>` : ''}<div class="memberhome" id="mhMain">${empty}</div>`;
  else {
    app.innerHTML = `<div class="shell"><div class="topbar"><div class="brand">${esc(dirNames.length === 1 ? dirNames[0] : 'Your business portal')}</div><div class="spacer"></div>
      ${pick}<span class="who">${esc(S.me.full_name)}</span><button class="linkbtn" id="so">Sign out</button></div>
    <main class="memberhome" id="mhMain">${empty}</main></div>`;
    $('#so').onclick = () => sb.auth.signOut();
  }
  if ($('#mhPick')) $('#mhPick').onchange = (e) => { MH.sel = e.target.value; renderMemberHome(); };
  if (ls.length) {
    if (MH.sel === 'all') drawMemberDashboard($('#mhMain'), ls);
    else {
      const L = ls.find((x) => x.id === MH.sel);
      $('#mhMain').innerHTML = `<button type="button" class="btn ghost small" id="mhBack">← ${multi ? 'All listings' : 'Dashboard'}</button><h1>${esc(L.org.name)}</h1><section class="card" id="mhOne"></section>`;
      if ($('#mhBack')) $('#mhBack').onclick = () => { MH.sel = 'all'; renderMemberHome(); };
      drawMemberListing($('#mhOne'), L);
    }
  }
  if (!inCrm) mountSuggest();
}
// several businesses: combined numbers for the last 30 days and a sortable table, each row opening that listing
function drawMemberDashboard(main, ls) {
  const K = [['view', 'Views'], ['call', 'Calls'], ['directions', 'Directions'], ['website', 'Website clicks']];
  const rowsOf = ls.map((L) => {
    const d = L.stats?.d30 || {};
    return { L, has: !!L.stats, name: L.org.name, dir: L.directory.name, view: L.stats ? +d.view || 0 : +L.views30 || 0, call: +d.call || 0, directions: +d.directions || 0, website: +d.website || 0,
      msgs: (L.threads || []).length, unread: (L.threads || []).filter((t) => t.unread).length, pending: !!L.pending };
  });
  const tot = Object.fromEntries([...K.map(([k]) => k), 'msgs', 'unread'].map((k) => [k, rowsOf.reduce((a, r) => a + r[k], 0)]));
  MH.sort ||= { k: 'name', dir: 1 };
  const sorted = [...rowsOf].sort((a, b) => { const k = MH.sort.k, x = a[k], y = b[k]; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * MH.sort.dir; });
  const anyStats = rowsOf.some((r) => r.has);
  const head = (k, l) => `<th><button type="button" class="thsort ${MH.sort.k === k ? 'on' : ''}" data-sk="${k}">${esc(l)}${MH.sort.k === k ? (MH.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`;
  const lock = '<span class="mhlock" title="Upgrade your listing to see this">🔒</span>';
  main.innerHTML = `<h1>${ls.length > 1 ? 'Your listings' : 'Your listing'}</h1>
    <div class="mhtiles">${K.map(([k, l]) => `<div class="card mhtile"><b>${k === 'view' || anyStats ? tot[k] : lock}</b><small>${esc(l)}</small></div>`).join('')}
      <div class="card mhtile"><b>${tot.msgs}</b><small>Messages${tot.unread ? ` · <span class="due">${tot.unread} new</span>` : ''}</small></div></div>
    <small class="hint" style="margin:-4px 0 10px">Last 30 days${ls.length > 1 ? `, all ${ls.length} businesses together` : ''}.${rowsOf.some((r) => !r.has) ? ' 🔒 Calls, directions and website clicks come with an upgraded listing. Ask the directory about upgrading.' : ''}</small>
    <div class="card" style="padding:0"><div class="tablewrap"><table class="mhtable"><thead><tr>${head('name', 'Business')}${head('view', 'Views')}${head('call', 'Calls')}${head('directions', 'Directions')}${head('website', 'Website')}${head('msgs', 'Messages')}<th></th></tr></thead>
      <tbody>${sorted.map((r) => `<tr><td><b>${esc(r.name)}</b><br><small class="hint" style="margin:0">${esc(r.dir)}${r.pending ? ' · changes waiting for approval' : ''}</small></td>
        ${K.map(([k]) => `<td>${r.has || k === 'view' ? r[k] : lock}</td>`).join('')}<td>${r.msgs}${r.unread ? ` <span class="badge due">${r.unread} new</span>` : ''}</td>
        <td><button type="button" class="btn small" data-mopen="${r.L.id}">Manage</button></td></tr>`).join('')}</tbody></table></div></div>`;
  $$('[data-sk]', main).forEach((b) => (b.onclick = () => { const k = b.dataset.sk; MH.sort = { k, dir: MH.sort.k === k ? -MH.sort.dir : (k === 'name' ? 1 : -1) }; drawMemberDashboard(main, ls); }));
  $$('[data-mopen]', main).forEach((b) => (b.onclick = () => { MH.sel = b.dataset.mopen; renderMemberHome(); window.scrollTo(0, 0); }));
}
function drawMemberListing(box, L) {
  const f = L.tier?.features || {};
  const tabs = [['details', 'Details'], f.photos ? ['photos', 'Photos'] : null, L.messages ? ['messages', `Messages${(L.threads || []).some((t) => t.unread) ? ` (${L.threads.filter((t) => t.unread).length} new)` : ''}`] : null, f.stats ? ['stats', 'Stats'] : null].filter(Boolean);
  const tab = tabs.some(([k]) => k === MH.tab[L.id]) ? MH.tab[L.id] : 'details';
  const live = L.directory.status === 'live' && L.status === 'live';
  const cur = listingCurrent(L), pend = L.pending?.changes || {}, view = { ...cur, ...pend };
  box.innerHTML = `<div class="toolbar"><div style="flex:1"><h2 style="margin:0">${esc(L.org.name)}</h2>
      <small class="hint" style="margin:0">${esc(L.directory.name)} · ${esc(L.tier?.name || 'Listing')}</small></div>
      ${live ? `<a class="btn ghost small" target="_blank" rel="noopener" href="${esc(`${S.pub()}/directory/?d=${encodeURIComponent(L.directory.slug)}#l=${L.id}`)}">View your listing</a>` : `<span class="badge">${L.status === 'live' ? 'Directory not live yet' : 'Not showing right now'}</span>`}</div>
    ${L.pending ? `<div class="banner gold">Your changes (${esc(Object.keys(pend).map((k) => LISTING_FIELDS.find(([x]) => x === k)?.[1] || k).join(', '))}) are waiting for approval. Sent ${esc(fmtDate(L.pending.at))}. <button class="linkish" data-mwithdraw>Withdraw them</button></div>` : ''}
    ${!L.pending && L.last_review?.status === 'rejected' && L.last_review.note ? `<div class="banner">Your last changes weren't published. Note: ${esc(L.last_review.note)}</div>` : ''}
    <div class="seg" style="margin:8px 0 12px">${tabs.map(([k, l]) => `<button type="button" data-mt="${k}" class="${tab === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
    <div data-mbody></div>`;
  $$('[data-mt]', box).forEach((b) => (b.onclick = () => { MH.tab[L.id] = b.dataset.mt; drawMemberListing(box, L); }));
  const w = $('[data-mwithdraw]', box);
  if (w) w.onclick = async () => { if (!confirm('Withdraw the changes waiting for approval?')) return; const { error } = await sb.rpc('member_cancel_edit', { p_listing: L.id }); if (error) return fail(error); toast('Changes withdrawn'); renderMemberHome(); };
  const body = $('[data-mbody]', box);
  const submit = async (changes, btn) => {
    if (!Object.keys(changes).length) return toast('Nothing changed');
    if (btn) btn.disabled = true;
    const { data, error } = await sb.rpc('member_submit_edit', { p_listing: L.id, p_changes: changes });
    if (btn) btn.disabled = false;
    if (error) return fail(error);
    toast(data?.status === 'applied' ? 'Changes are live.' : 'Changes submitted for approval. You\'ll get an email when they\'re live.');
    renderMemberHome();
  };
  if (tab === 'details') {
    const cats = catTree(L.categories || []), chosen = new Set(view.categories || []);
    const lock = (k) => FEATURE_OF[k] && !f[FEATURE_OF[k]] ? ' <small class="hint" style="display:inline">(shows with an upgraded listing)</small>' : '';
    const v = (k) => esc(view[k] ?? '');
    body.innerHTML = `<div class="row"><div><label class="label">Business name</label><input type="text" data-mf="name" value="${v('name')}"></div><div><label class="label">Phone</label><input type="tel" data-mf="main_phone" value="${v('main_phone')}"></div></div>
      <label class="label">Street address</label><input type="text" data-mf="address" value="${v('address')}">
      <div class="row"><div><label class="label">City</label><input type="text" data-mf="city" value="${v('city')}"></div>
        <div class="row" style="margin:0"><div><label class="label">State</label><input type="text" data-mf="state" maxlength="2" value="${v('state')}"></div><div><label class="label">ZIP</label><input type="text" data-mf="zip" value="${v('zip')}"></div></div></div>
      <label class="label">Website${lock('website')}</label><input type="url" data-mf="website" value="${v('website')}" placeholder="yourbusiness.com">
      <label class="label">Short tagline</label><input type="text" data-mf="tagline" maxlength="120" value="${v('tagline')}">
      <label class="label">Description${lock('description')}</label><textarea data-mf="description" rows="4">${v('description')}</textarea>
      <label class="label">Hours${lock('hours')}</label><div id="mfHours"></div><textarea data-mf="hours" hidden>${v('hours')}</textarea>
      <label class="label">Services, separated by commas${lock('services')}</label><textarea data-mf="services" rows="2">${esc((view.services || []).join(', '))}</textarea>
      <b style="display:block;margin-top:8px">Social links${lock('social')}</b>
      <div class="row"><div><label class="label">Facebook</label><input type="url" data-ms="facebook" value="${esc(view.social?.facebook || '')}"></div><div><label class="label">Instagram</label><input type="url" data-ms="instagram" value="${esc(view.social?.instagram || '')}"></div></div>
      <div class="row"><div><label class="label">LinkedIn</label><input type="url" data-ms="linkedin" value="${esc(view.social?.linkedin || '')}"></div><div></div></div>
      ${cats.length ? `<b style="display:block;margin-top:8px">Categories</b><div class="catpick">${cats.map((c) => `<label class="check" style="padding-left:${c.depth * 18}px"><input type="checkbox" data-mc="${c.id}" ${chosen.has(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('')}</div>` : ''}
      <small class="hint">${L.directory.approval ? 'Changes are reviewed by the directory before they show.' : 'Changes show on your listing right away.'}</small>
      <div class="actions"><button class="btn" data-msave>Submit</button></div>`;
    if ($('#mfHours', body)) hoursEditor($('#mfHours', body), L.profile?.hours_week || null, L.profile?.hours_note || '', (t) => ($('[data-mf="hours"]', body).value = t));
    $('[data-msave]', body).onclick = (e) => {
      const ch = {};
      $$('[data-mf]', body).forEach((inp) => {
        const k = inp.dataset.mf; let val = inp.value.trim();
        if (k === 'services') { const arr = val.split(',').map((x) => x.trim()).filter(Boolean); if (JSON.stringify(arr) !== JSON.stringify(view.services || [])) ch.services = arr; return; }
        if (k === 'state') val = val.toUpperCase();
        if (val !== String(view[k] ?? '')) ch[k] = val;
      });
      const soc = Object.fromEntries($$('[data-ms]', body).map((i) => [i.dataset.ms, i.value.trim()]).filter(([, x]) => x));
      if (JSON.stringify(soc) !== JSON.stringify(Object.fromEntries(Object.entries(view.social || {}).filter(([, x]) => x)))) ch.social = soc;
      const cs = $$('[data-mc]', body).filter((c) => c.checked).map((c) => c.dataset.mc).sort();
      if (cats.length && JSON.stringify(cs) !== JSON.stringify([...(view.categories || [])].sort())) ch.categories = cs;
      if (ch.name === '') return toast('The business name can\'t be blank');
      submit(ch, e.target);
    };
  } else if (tab === 'photos') {
    const photos = (view.photos || []).map((p) => ({ ...p }));
    body.innerHTML = `<small class="hint" style="margin:0 0 8px">Up to 12 photos. The first one shows first.</small><div data-pe></div><div class="actions"><button class="btn" data-psave>Submit</button></div>`;
    photoEditor($('[data-pe]', body), photos, () => {}, (file) => uploadListingPhoto(L.tenant_id || S.me.tenant_id, L.id, file));
    $('[data-psave]', body).onclick = (e) => {
      if (JSON.stringify(photos) === JSON.stringify(view.photos || [])) return toast('Nothing changed');
      submit({ photos }, e.target);
    };
  } else if (tab === 'messages') {
    const th = L.threads || [];
    body.innerHTML = `<div class="list">${th.map((t) => `<button class="item" data-th="${t.id}"><b>${esc(t.name)}${t.unread ? ' <span class="badge due">New</span>' : ''}</b><small>${esc(t.preview || '')}</small><div class="meta"><span class="badge stage">${esc(fmtDate(t.at))}</span></div></button>`).join('')
      || `<p class="empty">${MH.host ? 'No older messages. New chats from your listing come into your Inbox.' : 'No messages yet. When someone writes to you from your listing, it shows here and you get an email.'}</p>`}</div>
      ${MH.host && th.length ? '<small class="hint">These came in before live chat. New chats from your listing come into your Inbox.</small>' : ''}<div data-thv></div>`;
    $$('[data-th]', body).forEach((b) => (b.onclick = () => { threadView($('[data-thv]', body), b.dataset.th, { canReply: true }); b.querySelector('.badge.due')?.remove(); $('[data-thv]', body).scrollIntoView({ behavior: 'smooth' }); }));
  } else if (tab === 'stats') {
    const s = L.stats || {}, K = [['view', 'Listing views'], ['call', 'Call taps'], ['directions', 'Directions taps'], ['website', 'Website visits'], ['message', 'Messages']];
    body.innerHTML = `<div class="kpis">${K.map(([k, l]) => `<div class="kpi"><span>${l}</span><b>${s.d30?.[k] || 0}</b><small>${s.d90?.[k] || 0} in 90 days</small></div>`).join('')}</div>
      <small class="hint" style="display:block;margin-top:8px">Last 30 days. Repeat taps from the same visitor within 10 minutes count once.</small>
      ${(s.places || []).length ? `<h3 style="margin:14px 0 4px">Where people tapped from (90 days, approximate)</h3><div class="list">${s.places.map((p) => `<div class="item"><b>${esc(p.place)}</b><small>${p.n}</small></div>`).join('')}</div>` : ''}`;
  }
}

/* ---------- admin: listing edits waiting for approval ---------- */
async function renderListingEdits(box, { listingId = null, onDone } = {}) {
  let q = sb.from('directory_listing_edits').select('id,listing_id,changes,created_at,updated_at,submitted_by,directory_listings(profile,companies(name,address,city,state,zip,main_phone,website)),directories(name)').eq('status', 'pending').order('updated_at');
  if (listingId) q = q.eq('listing_id', listingId);
  const { data, error } = await q;
  if (error) { box.innerHTML = ''; return; }
  if (!data?.length) { box.innerHTML = ''; return; }
  box.innerHTML = `${listingId ? '' : `<h2 class="section">Listing edits from businesses (${data.length})</h2>`}${data.map((e) => {
    const co = e.directory_listings?.companies || {}, pr = e.directory_listings?.profile || {};
    const was = { ...co, tagline: pr.tagline, description: pr.description, hours: pr.hours, services: pr.services, social: pr.social, photos: pr.photos };
    return `<div class="card editcard" data-eid="${e.id}"><b>${esc(co.name || 'Listing')}</b> <small class="hint" style="display:inline">· ${esc(e.directories?.name || '')} · sent by ${esc(userName(e.submitted_by) || 'the business')} ${esc(fmtDate(e.updated_at))}</small>
      <table class="difftbl"><tbody>${Object.entries(e.changes).map(([k, v]) => `<tr><th>${esc(LISTING_FIELDS.find(([x]) => x === k)?.[1] || k)}</th>
        <td class="was">${k === 'categories' ? '' : esc(showVal(k, was[k]) || '(blank)')}</td><td class="now">${k === 'photos' ? (v || []).map((p) => `<img src="${esc(p.url)}" alt="" class="diffimg">`).join('') || '(none)' : esc(showVal(k, v) || '(blank)')}</td></tr>`).join('')}</tbody></table>
      <input type="text" data-enote placeholder="Note to the business (optional, sent with your decision)">
      <div class="actions"><button class="btn ghost small" data-erej>Turn down</button><button class="btn small" data-eok>Approve and publish</button></div></div>`;
  }).join('')}`;
  $$('.editcard', box).forEach((c) => {
    const go1 = async (ok) => {
      $$('button', c).forEach((b) => (b.disabled = true));
      const { error: e } = await sb.rpc('directory_review_edit', { p_edit: c.dataset.eid, p_approve: ok, p_note: $('[data-enote]', c).value });
      if (e) { $$('button', c).forEach((b) => (b.disabled = false)); return fail(e); }
      sb.functions.invoke('directory-email', { body: { kind: 'edit', edit_id: c.dataset.eid } }).catch(() => {});
      toast(ok ? 'Approved. The listing is updated.' : 'Turned down. The business gets an email.');
      refreshCounts(); onDone ? onDone() : renderListingEdits(box, { listingId, onDone });
    };
    $('[data-eok]', c).onclick = () => go1(true);
    $('[data-erej]', c).onclick = () => go1(false);
  });
}

/* ================= DIRECTORIES ================= */
// One neutral engine. Each listing is a CRM organization (name, address, phone, website and logo come from the org,
// so they stay in sync); the listing adds its tier, categories, profile text and map pin. Everything else is a
// per-directory setting with defaults. Archive, never delete.
const DIR_FEATURES = [
  ['logo', 'Logo'], ['description', 'Description'], ['website', 'Website link'], ['hours', 'Hours'], ['services', 'Services'],
  ['social', 'Social links'], ['photos', 'Photos'], ['featured', 'Featured placement'], ['map', 'Map pin'],
  ['stats', 'Stats for the business'], ['messages', 'Messages through the CRM'],
];
const dirLink = (d) => `${S.pub()}/directory/?d=${encodeURIComponent(d.slug)}`;
const slugify = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42);
// OpenStreetMap's free geocoder: one lookup a second, US addresses
// find a map pin. Pass an organization (address, city, state, zip) or a plain place name. Tries the exact address,
// then the street in that town, then the town, then the ZIP, and says how close it got (level: address, street, town, zip, place).
async function geocode(q) {
  const ask = async (params) => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&${new URLSearchParams(params)}`, { headers: { Accept: 'application/json' } });
      const j = await r.json();
      return j?.[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon) } : null;
    } catch { return null; }
  };
  if (!q) return null;
  if (typeof q === 'string') { if (!q.trim()) return null; const g = await ask({ q }); return g && { ...g, level: 'place' }; }
  const street = (q.address || '').trim(), city = (q.city || '').trim(), state = (q.state || '').trim(), zip = (q.zip || '').trim();
  const tries = [];
  if (street && (city || zip)) tries.push(['address', { street, city, state, postalcode: zip }], ['address', { q: [street, city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') }]);
  const road = street.replace(/^\d+[a-z]?\s+/i, '').replace(/\s*(#|suite|ste\.?|unit|apt\.?)\s*\S+$/i, '');
  if (road && road !== street && city) tries.push(['street', { street: road, city, state }]);
  if (road && zip) tries.push(['street', { street: road, postalcode: zip, state }], ['street', { q: `${road}, ${state} ${zip}` }]);
  if (city) tries.push(['town', { city, state }]);
  if (zip) tries.push(['zip', { postalcode: zip, country: 'us' }]);
  for (const [level, params] of tries) {
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
    const g = await ask(clean); if (g) return { ...g, level };
    await new Promise((r) => setTimeout(r, 1100));   // the free map service asks for about one lookup a second
  }
  return null;
}
// business hours: a row per day with open and close times (pick from the list or type) and a Closed box.
// Saved as hours_week (the rows) plus hours (a plain summary like "Mon to Fri 8:00 AM to 5:00 PM, Sat closed") for the public page.
const HDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HTIMES = Array.from({ length: 48 }, (_, i) => { const h = Math.floor(i / 2), m = i % 2 ? '30' : '00'; return `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`; });
const hoursDefault = () => HDAYS.map((d, i) => ({ d, open: i < 5 ? '8:00 AM' : '', close: i < 5 ? '5:00 PM' : '', closed: i >= 5 }));
function hoursSummary(week, note = '') {
  const label = (r) => (r.closed ? 'closed' : r.open && r.close ? `${r.open} to ${r.close}` : r.open ? `from ${r.open}` : '');
  const groups = [];
  week.forEach((r) => { const l = label(r), g = groups[groups.length - 1]; if (g && g.l === l && g.next === r.d) { g.to = r.d; g.next = HDAYS[HDAYS.indexOf(r.d) + 1]; } else groups.push({ from: r.d, to: r.d, l, next: HDAYS[HDAYS.indexOf(r.d) + 1] }); });
  const txt = groups.filter((g) => g.l).map((g) => `${g.from === g.to ? g.from : `${g.from} to ${g.to}`} ${g.l}`).join(', ');
  return [txt, note.trim()].filter(Boolean).join('. ');
}
function hoursEditor(box, week, note = '', onChange = null) {
  week = HDAYS.map((d) => ({ d, open: '', close: '', closed: false, ...(week || []).find((r) => r.d === d) }));
  let touched = false;   // untouched editors don't overwrite hours that were typed in the old free-text box
  const draw = () => {
    box.innerHTML = `<datalist id="hTimes">${HTIMES.map((t) => `<option value="${t}">`).join('')}</datalist>
      <div class="hgrid">${week.map((r, i) => `<div class="hrow ${r.closed ? 'off' : ''}"><b>${r.d}</b>
        <input type="text" list="hTimes" data-ho="${i}" value="${esc(r.open)}" placeholder="Open" aria-label="${r.d} opens" ${r.closed ? 'disabled' : ''}>
        <span>to</span><input type="text" list="hTimes" data-hc="${i}" value="${esc(r.close)}" placeholder="Close" aria-label="${r.d} closes" ${r.closed ? 'disabled' : ''}>
        <label class="check"><input type="checkbox" data-hx="${i}" ${r.closed ? 'checked' : ''}> Closed</label></div>`).join('')}</div>
      <div class="actions" style="margin:6px 0"><button type="button" class="btn ghost small" id="hCopy">Copy Monday to weekdays</button></div>
      <input type="text" id="hNote" value="${esc(note)}" placeholder="Note (optional), like Closed for lunch 12 to 1" maxlength="160">
      <small class="hint" id="hSum" style="margin:4px 0 0"></small>`;
    const sum = (edit) => { if (edit) touched = true; const t = hoursSummary(week, $('#hNote', box).value); $('#hSum', box).textContent = 'Shows as: ' + (t || 'no hours'); if (touched) onChange?.(t); };
    $$('[data-ho]', box).forEach((el) => (el.oninput = () => { week[+el.dataset.ho].open = el.value.trim(); sum(true); }));
    $$('[data-hc]', box).forEach((el) => (el.oninput = () => { week[+el.dataset.hc].close = el.value.trim(); sum(true); }));
    $$('[data-hx]', box).forEach((el) => (el.onchange = () => { week[+el.dataset.hx].closed = el.checked; note = $('#hNote', box).value; touched = true; draw(); }));
    $('#hCopy', box).onclick = () => { for (let i = 1; i < 5; i++) Object.assign(week[i], { open: week[0].open, close: week[0].close, closed: week[0].closed }); note = $('#hNote', box).value; touched = true; draw(); };
    $('#hNote', box).oninput = () => sum(true); sum(false);
  };
  draw();
  return () => { if (!touched) return {}; const n = $('#hNote', box)?.value.trim() || ''; return { hours_week: week, hours_note: n, hours: hoursSummary(week, n) }; };
}
// a small map to place or drag a listing's pin by hand (for rural addresses the map service can't find exactly)
const loadLeaflet = () => window.L ? Promise.resolve(window.L) : new Promise((ok, no) => {
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(css);
  const sc = document.createElement('script'); sc.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; sc.onload = () => ok(window.L); sc.onerror = no; document.head.appendChild(sc);
});
async function pinPicker(box, start, onPick) {
  const L = await loadLeaflet();
  box.innerHTML = '<div class="pinmap"></div><small class="hint" style="margin:4px 0 0">Click the map or drag the pin to the right spot. Scroll or pinch to zoom.</small>';
  const at = start && start.lat != null ? [start.lat, start.lng] : [39.5, -98.35];
  const map = L.map($('.pinmap', box), { scrollWheelZoom: true }).setView(at, start && start.lat != null ? 15 : 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const icon = L.divIcon({ className: 'pinicon', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11] });
  const mk = L.marker(at, { draggable: true, icon }).addTo(map);
  const set = (ll) => { mk.setLatLng(ll); onPick({ lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) }); };
  mk.on('dragend', () => set(mk.getLatLng()));
  map.on('click', (e) => set(e.latlng));
  setTimeout(() => map.invalidateSize(), 50);
}
const pinNote = (g) => ({ address: 'Pinned at the address', street: 'The exact number isn\'t on the map, so it\'s pinned on that road', town: 'Pinned in the town (the street isn\'t on the map yet)', zip: 'Pinned at the ZIP code area', place: 'Pinned' })[g?.level] || 'Pinned';
const orgAddrLine = (c) => [c.address, c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

async function viewDirectories(main) {
  const { data: dirs, error } = await sb.from('directories').select('id,name,slug,status,visibility,tagline,created_at,directory_listings(count)').is('archived_at', null).order('name');
  if (error) throw error;
  main.innerHTML = `
    <div class="toolbar"><h1 style="margin:0;flex:1">Directories</h1>${isAdmin() ? '<button class="btn small" id="newDir">+ New directory</button>' : ''}</div>
    <p class="hint" style="margin-top:-4px">Each directory lists organizations from this CRM, so names, addresses and phone numbers stay in sync. Tip: add an organization type like Member or Listing under Admin > Lists and use it for the businesses you list.</p>
    <div id="dirNew"></div>
    <div class="list">${(dirs || []).map((d) => `<button class="item" data-did="${d.id}"><b>${esc(d.name)}</b>
      <small>${esc(d.tagline || dirLink(d))}</small>
      <div class="meta"><span class="badge ${d.status === 'live' ? 'ok' : ''}">${d.status === 'live' ? 'Live' : 'Draft'}</span>
        <span class="badge">${d.visibility === 'members' ? 'Members only' : 'Public'}</span>
        <span class="badge">${d.directory_listings?.[0]?.count || 0} listings</span></div></button>`).join('') || '<p class="empty">No directories yet.</p>'}</div>`;
  $$('[data-did]').forEach((b) => (b.onclick = () => go('directory', b.dataset.did)));
  if ($('#newDir')) $('#newDir').onclick = () => {
    $('#dirNew').innerHTML = `<div class="card panel"><h2>New directory</h2>
      <div class="row"><div><label class="label" for="ndName">Name</label><input type="text" id="ndName" placeholder="Your Business Directory"></div>
        <div><label class="label" for="ndSlug">Web address</label><input type="text" id="ndSlug" placeholder="your-directory"><small class="hint" id="ndUrl" style="margin:2px 0 0"></small></div></div>
      <small class="hint">It starts as a draft only your team can see. You can attach your own domain later.</small>
      <div class="actions"><button class="btn ghost small" id="ndX">Cancel</button><button class="btn" id="ndGo">Create directory</button></div></div>`;
    let touched = false;
    const url = () => ($('#ndUrl').textContent = `${S.pub()}/directory/?d=${$('#ndSlug').value || 'your-name'}`);
    $('#ndName').oninput = () => { if (!touched) $('#ndSlug').value = slugify($('#ndName').value); url(); };
    $('#ndSlug').oninput = () => { touched = true; $('#ndSlug').value = slugify($('#ndSlug').value); url(); };
    url(); $('#ndName').focus();
    $('#ndX').onclick = () => ($('#dirNew').innerHTML = '');
    $('#ndGo').onclick = async () => {
      const name = $('#ndName').value.trim(), slug = slugify($('#ndSlug').value);
      if (!name) return toast('Name the directory');
      if (slug.length < 3) return toast('The web address needs at least 3 letters or numbers');
      const { data, error: e } = await sb.from('directories').insert({ name, slug }).select('id').single();
      if (e) return fail(/duplicate|unique/i.test(e.message) ? new Error('That web address is taken. Try another.') : e);
      toast('Directory created'); go('directory', data.id);
    };
  };
}

let DIRTAB = recall('dirTab', { tab: 'listings' });
async function viewDirectory(main) {
  const id = S.param;
  const [{ data: d, error }, { data: cats }, { data: tiers }] = await Promise.all([
    sb.from('directories').select('*').eq('id', id).maybeSingle(),
    sb.from('directory_categories').select('*').eq('directory_id', id).is('archived_at', null).order('sort').order('name'),
    sb.from('directory_tiers').select('*').eq('directory_id', id).is('archived_at', null).order('sort'),
  ]);
  if (error) throw error;
  if (!d) { main.innerHTML = '<p class="empty">Directory not found.</p>'; return; }
  const adm = isAdmin();
  const TABS = [['listings', 'Listings'], ['categories', 'Categories'], ['tiers', 'Tiers'], ['settings', 'Settings']];
  main.innerHTML = `
    <div class="toolbar"><button class="btn ghost small" id="dBack">← Directories</button><div style="flex:1"></div>
      <a class="btn ghost small" href="${esc(dirLink(d))}" target="_blank" rel="noopener">Open ${d.status === 'live' ? 'public page' : 'preview'}</a>
      ${adm ? `<button class="btn small ${d.status === 'live' ? 'ghost' : ''}" id="dLive">${d.status === 'live' ? 'Back to draft' : 'Go live'}</button>` : ''}</div>
    <div class="titlerow"><h1>${esc(d.name)}</h1><div class="meta"><span class="badge ${d.status === 'live' ? 'ok' : ''}">${d.status === 'live' ? 'Live' : 'Draft, only your team can see it'}</span>
      <span class="badge">${d.visibility === 'members' ? 'Members only' : 'Public'}</span></div></div>
    <div class="seg" id="dTabs" style="margin:6px 0 12px">${TABS.map(([k, l]) => `<button type="button" data-dt="${k}" class="${DIRTAB.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="dBody"></div>`;
  $('#dBack').onclick = () => go('directories');
  $$('#dTabs [data-dt]').forEach((b) => (b.onclick = () => { DIRTAB.tab = b.dataset.dt; store('dirTab', DIRTAB); viewDirectory(main); }));
  if ($('#dLive')) $('#dLive').onclick = async () => {
    const to = d.status === 'live' ? 'draft' : 'live';
    if (to === 'live' && !confirm(`Make ${d.name} live? ${d.visibility === 'public' ? 'Anyone with the link can see it.' : 'Members will be able to see it.'}`)) return;
    const { error: e } = await sb.from('directories').update({ status: to }).eq('id', id);
    if (e) return fail(e); toast(to === 'live' ? 'Directory is live' : 'Directory is back to draft'); viewDirectory(main);
  };
  const body = $('#dBody');
  const ctx = { d, cats: cats || [], tiers: tiers || [], adm, reload: () => viewDirectory(main) };
  if (DIRTAB.tab === 'categories') return dirCategories(body, ctx);
  if (DIRTAB.tab === 'tiers') return dirTiers(body, ctx);
  if (DIRTAB.tab === 'settings') return dirSettings(body, ctx);
  return dirListings(body, ctx);
}

// category tree helpers
function catTree(cats) {
  const kids = {}; cats.forEach((c) => (kids[c.parent_id || ''] ||= []).push(c));
  const out = []; const walk = (pid, depth) => (kids[pid || ''] || []).forEach((c) => { out.push({ ...c, depth }); walk(c.id, depth + 1); });
  walk('', 0); return out;
}

function dirCategories(box, { d, cats, adm, reload }) {
  const tree = catTree(cats);
  box.innerHTML = `<div class="card"><h2>Categories</h2>
    <small class="hint" style="margin:-4px 0 10px">Organize by what businesses do (Services, then Plumbers) or by place (a neighborhood or landmark, then Restaurants). Give a category a place to let visitors sort its listings by distance from it.</small>
    <div id="catList">${tree.map((c) => `<div class="catrow" style="padding-left:${c.depth * 22}px" data-cid="${c.id}">
      <span class="catname">${c.depth ? '└ ' : ''}<b>${esc(c.name)}</b>${c.place_label ? ` <small class="hint" style="display:inline">· near ${esc(c.place_label)}${c.lat ? '' : ' (not located)'}</small>` : ''}</span>
      ${adm ? `<span class="catbtns"><button class="linkish" data-csub="${c.id}">+ Sub</button><button class="linkish" data-cedit="${c.id}">Edit</button>
        <button class="linkish" data-cup="${c.id}" aria-label="Move up">↑</button><button class="linkish" data-cdown="${c.id}" aria-label="Move down">↓</button></span>` : ''}</div>
      <div data-cform="${c.id}"></div>`).join('') || '<p class="empty">No categories yet.</p>'}</div>
    ${adm ? `<div class="row" style="margin-top:12px"><div><input type="text" id="catNew" placeholder="New top-level category, e.g. Services"></div><div><button class="btn" id="catAdd">Add category</button></div></div>` : ''}</div>`;
  if (!adm) return;
  const add = async (name, parent) => {
    if (!name.trim()) return toast('Name the category');
    const sibs = cats.filter((c) => (c.parent_id || null) === (parent || null));
    const { error } = await sb.from('directory_categories').insert({ directory_id: d.id, parent_id: parent || null, name: name.trim(), sort: (Math.max(0, ...sibs.map((c) => c.sort)) || 0) + 10 });
    if (error) return fail(error); toast('Category added'); reload();
  };
  $('#catAdd').onclick = () => add($('#catNew').value, null);
  $('#catNew').onkeydown = (e) => { if (e.key === 'Enter') add($('#catNew').value, null); };
  $$('[data-csub]').forEach((b) => (b.onclick = () => {
    const f = $(`[data-cform="${b.dataset.csub}"]`);
    f.innerHTML = `<div class="row catform"><div><input type="text" class="cfName" placeholder="Subcategory name"></div><div><button class="btn small cfGo">Add</button> <button class="btn ghost small cfX">Cancel</button></div></div>`;
    $('.cfName', f).focus(); $('.cfX', f).onclick = () => (f.innerHTML = '');
    $('.cfGo', f).onclick = () => add($('.cfName', f).value, b.dataset.csub);
  }));
  $$('[data-cedit]').forEach((b) => (b.onclick = () => {
    const c = cats.find((x) => x.id === b.dataset.cedit); const f = $(`[data-cform="${c.id}"]`);
    const parents = catTree(cats).filter((x) => x.id !== c.id);
    f.innerHTML = `<div class="card catform"><div class="row"><div><label class="label">Name</label><input type="text" class="ceName" value="${esc(c.name)}"></div>
        <div><label class="label">Inside</label><select class="cePar"><option value="">Top level</option>${parents.map((x) => `<option value="${x.id}" ${x.id === c.parent_id ? 'selected' : ''}>${'– '.repeat(x.depth)}${esc(x.name)}</option>`).join('')}</select></div></div>
      <label class="label">Place (optional, for distance sorting)</label><input type="text" class="cePlace" value="${esc(c.place_label || '')}" placeholder="e.g. 100 Main St, Your Town, ST">
      <div class="actions"><button class="btn ghost small danger ceArch">Archive</button><span style="flex:1"></span><button class="btn ghost small ceX">Cancel</button><button class="btn small ceGo">Save</button></div></div>`;
    $('.ceX', f).onclick = () => (f.innerHTML = '');
    $('.ceArch', f).onclick = async () => {
      if (cats.some((x) => x.parent_id === c.id)) return toast('Move or archive its subcategories first');
      if (!confirm(`Archive ${c.name}? Listings keep their other categories.`)) return;
      const { error } = await sb.from('directory_categories').update({ archived_at: new Date().toISOString() }).eq('id', c.id);
      if (error) return fail(error); toast('Category archived'); reload();
    };
    $('.ceGo', f).onclick = async () => {
      const place = $('.cePlace', f).value.trim();
      const patch = { name: $('.ceName', f).value.trim(), parent_id: $('.cePar', f).value || null, place_label: place || null };
      if (!patch.name) return toast('Name the category');
      if (place && place !== c.place_label) { const g = await geocode(place); Object.assign(patch, g ? { lat: g.lat, lng: g.lng } : { lat: null, lng: null }); if (!g) toast('Saved, but that place wasn\'t found on the map'); }
      if (!place) Object.assign(patch, { lat: null, lng: null });
      const { error } = await sb.from('directory_categories').update(patch).eq('id', c.id);
      if (error) return fail(error); toast('Category saved'); reload();
    };
  }));
  const move = async (cid, dir) => {
    const c = cats.find((x) => x.id === cid);
    const sibs = cats.filter((x) => (x.parent_id || null) === (c.parent_id || null)).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    const i = sibs.findIndex((x) => x.id === cid), j = i + dir;
    if (j < 0 || j >= sibs.length) return;
    [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
    for (let k = 0; k < sibs.length; k++) if (sibs[k].sort !== (k + 1) * 10) await sb.from('directory_categories').update({ sort: (k + 1) * 10 }).eq('id', sibs[k].id);
    reload();
  };
  $$('[data-cup]').forEach((b) => (b.onclick = () => move(b.dataset.cup, -1)));
  $$('[data-cdown]').forEach((b) => (b.onclick = () => move(b.dataset.cdown, 1)));
}

function dirTiers(box, { d, tiers, adm, reload }) {
  box.innerHTML = `<div class="card"><h2>Tiers</h2>
    <small class="hint" style="margin:-4px 0 10px">Each tier decides what a listing shows. Any feature can go in any tier. Prices show to businesses; online checkout comes with the payments phase.</small>
    ${tiers.map((t) => `<div class="tierrow" data-tid="${t.id}">
      <div class="row"><div><label class="label">Name</label><input type="text" data-tf="name" value="${esc(t.name)}" ${adm ? '' : 'disabled'}></div>
        <div class="row" style="margin:0"><div><label class="label">Monthly ($)</label><input type="number" min="0" step="1" data-tf="price_monthly" value="${t.price_monthly ?? ''}" ${adm ? '' : 'disabled'}></div>
          <div><label class="label">Yearly ($)</label><input type="number" min="0" step="1" data-tf="price_yearly" value="${t.price_yearly ?? ''}" ${adm ? '' : 'disabled'}></div></div></div>
      <label class="check"><input type="checkbox" data-tf="is_free" ${t.is_free ? 'checked' : ''} ${adm ? '' : 'disabled'}> Free tier (where lapsed listings can land)</label>
      <div class="featgrid">${DIR_FEATURES.map(([k, l]) => `<label class="check"><input type="checkbox" data-feat="${k}" ${t.features?.[k] ? 'checked' : ''} ${adm ? '' : 'disabled'}> ${l}</label>`).join('')}</div>
      ${adm ? `<div class="actions"><button class="btn ghost small danger" data-tarch>Archive tier</button><span style="flex:1"></span><button class="btn small" data-tsave>Save tier</button></div>` : ''}
    </div>`).join('')}
    ${adm ? '<div class="actions"><button class="btn secondary" id="tierAdd">+ Add tier</button></div>' : ''}</div>`;
  if (!adm) return;
  $('#tierAdd').onclick = async () => {
    const { error } = await sb.from('directory_tiers').insert({ directory_id: d.id, name: 'New tier', sort: (Math.max(0, ...tiers.map((t) => t.sort)) || 0) + 10, features: { map: true, hours: true } });
    if (error) return fail(error); reload();
  };
  $$('.tierrow').forEach((row) => {
    const t = tiers.find((x) => x.id === row.dataset.tid);
    $('[data-tsave]', row).onclick = async () => {
      const num = (k) => { const v = $(`[data-tf="${k}"]`, row).value; return v === '' ? null : Math.max(0, Number(v)); };
      const features = Object.fromEntries($$('[data-feat]', row).map((c) => [c.dataset.feat, c.checked]));
      const patch = { name: $('[data-tf="name"]', row).value.trim(), price_monthly: num('price_monthly'), price_yearly: num('price_yearly'), is_free: $('[data-tf="is_free"]', row).checked, features };
      if (!patch.name) return toast('Name the tier');
      const { error } = await sb.from('directory_tiers').update(patch).eq('id', t.id);
      if (error) return fail(error); toast('Tier saved');
    };
    $('[data-tarch]', row).onclick = async () => {
      const { count } = await sb.from('directory_listings').select('id', { count: 'exact', head: true }).eq('tier_id', t.id).is('archived_at', null);
      if (count) return toast(`${count} listing${count === 1 ? ' is' : 's are'} on this tier. Move them first.`);
      if (!confirm(`Archive the ${t.name} tier?`)) return;
      const { error } = await sb.from('directory_tiers').update({ archived_at: new Date().toISOString() }).eq('id', t.id);
      if (error) return fail(error); toast('Tier archived'); reload();
    };
  });
}

function dirSettings(box, { d, tiers, adm, reload }) {
  const st = d.settings || {}, acc = st.access || {}, col = st.colors || {};
  const dis = adm ? '' : 'disabled';
  box.innerHTML = `<div class="card"><h2>Basics</h2>
      <div class="row"><div><label class="label" for="dsName">Name</label><input type="text" id="dsName" value="${esc(d.name)}" ${dis}></div>
        <div><label class="label" for="dsSlug">Web address</label><input type="text" id="dsSlug" value="${esc(d.slug)}" ${dis}><small class="hint" style="margin:2px 0 0">${esc(dirLink(d))}</small></div></div>
      <label class="label" for="dsTag">Tagline</label><input type="text" id="dsTag" value="${esc(d.tagline || '')}" placeholder="Find local businesses you can trust" ${dis}>
      <div class="row"><div><label class="label" for="dsVis">Who can see it</label><select id="dsVis" ${dis}><option value="public" ${d.visibility === 'public' ? 'selected' : ''}>Public, anyone with the link</option><option value="members" ${d.visibility === 'members' ? 'selected' : ''}>Members only</option></select></div>
        <div><label class="label" for="dsDomain">Your own domain (optional)</label><input type="text" id="dsDomain" value="${esc(d.custom_domain || '')}" placeholder="directory.yoursite.com" ${dis}><small class="hint" style="margin:2px 0 0">GELP connects it for you once it's entered.</small></div></div>
    </div>
    <div class="card"><h2>Look</h2>
      <div class="row"><div><label class="label" for="dsC1">Main color</label><input type="color" id="dsC1" value="${esc(col.primary || '#1A2A52')}" ${dis}></div>
        <div><label class="label" for="dsC2">Accent color</label><input type="color" id="dsC2" value="${esc(col.accent || '#C9A04A')}" ${dis}></div></div>
      <div class="logorow"><div class="thumb" id="dsLogoT">${d.logo_media_id ? '…' : 'No logo'}</div><div><b>Directory logo</b><small class="hint" style="margin:0">Shows at the top of the directory.</small>
        ${adm ? '<button type="button" class="btn ghost small" id="dsLogo">Upload logo</button>' : ''}</div></div>
      <label class="check"><input type="checkbox" id="dsMap" ${st.show_map !== false ? 'checked' : ''} ${dis}> Show a map (OpenStreetMap)</label>
    </div>
    <div class="card"><h2>Rules</h2>
      <label class="check"><input type="checkbox" id="dsAppr" ${st.edits_need_approval !== false ? 'checked' : ''} ${dis}> Business edits to their own listing need admin approval</label>
      <b style="display:block;margin-top:10px">How businesses get in</b>
      <label class="check"><input type="checkbox" id="dsInv" ${acc.invite !== false ? 'checked' : ''} ${dis}> Invite</label>
      <label class="check"><input type="checkbox" id="dsChk" ${acc.checkout ? 'checked' : ''} ${dis}> Buy a membership at checkout <small class="hint" style="display:inline">(payments phase)</small></label>
      <label class="check"><input type="checkbox" id="dsClaim" ${acc.claim ? 'checked' : ''} ${dis}> Claim your business <small class="hint" style="display:inline">(claiming phase)</small></label>
      <label class="check"><input type="checkbox" id="dsRev" ${st.reviews ? 'checked' : ''} ${dis}> Reviews and ratings <small class="hint" style="display:inline">(coming later)</small></label>
      <div class="row" style="margin-top:10px"><div><label class="label" for="dsGrace">Grace period after a missed payment (days)</label><input type="number" id="dsGrace" min="0" max="365" step="1" value="${esc(st.grace_days ?? 30)}" ${dis}></div>
        <div><label class="label" for="dsUnpaid">Then the listing becomes</label><select id="dsUnpaid" ${dis}>
          <option value="free" ${(st.unpaid_level || 'free') === 'free' ? 'selected' : ''}>The free tier</option>
          <option value="unlisted" ${st.unpaid_level === 'unlisted' ? 'selected' : ''}>Unlisted (hidden)</option>
          ${tiers.filter((t) => !t.is_free).map((t) => `<option value="${t.id}" ${st.unpaid_level === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div></div>
      <label class="check"><input type="checkbox" id="dsRepay" ${st.repay_review !== false ? 'checked' : ''} ${dis}> When a lapsed business pays again, an admin reviews it before it's back <small class="hint" style="display:inline">(off: it comes straight back and only edits from the lapse get reviewed)</small></label>
    </div>
    ${adm ? `<div class="actions"><button class="btn ghost danger" id="dsArch">Archive directory</button><span style="flex:1"></span><button class="btn" id="dsSave">Save settings</button></div>` : ''}`;
  if (d.logo_media_id) sb.from('media').select('url').eq('id', d.logo_media_id).maybeSingle().then(({ data }) => { if (data?.url && $('#dsLogoT')) $('#dsLogoT').innerHTML = `<img src="${esc(data.url)}" alt="">`; });
  if (!adm) return;
  let logoId = d.logo_media_id;
  $('#dsLogo').onclick = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp,image/gif';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      if (f.size > 5 * 1024 * 1024) return toast('Keep the logo under 5 MB');
      const ext = ((f.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'png';
      const path = `${d.tenant_id}/directories/${d.id}/logo-${Date.now()}.${ext}`;
      const up = await sb.storage.from('media').upload(path, f, { contentType: f.type, upsert: false });
      if (up.error) return fail(up.error);
      const url = sb.storage.from('media').getPublicUrl(path).data.publicUrl;
      const { data: m, error } = await sb.from('media').insert({ bucket: 'media', path, url, kind: 'logo', entity: 'directories', entity_id: d.id, title: d.name, mime: f.type, bytes: f.size }).select('id').single();
      if (error) return fail(error);
      logoId = m.id; $('#dsLogoT').innerHTML = `<img src="${esc(url)}" alt="">`; toast('Logo uploaded. Save settings to use it.');
    };
    inp.click();
  };
  $('#dsArch').onclick = async () => {
    if (!confirm(`Archive ${d.name}? It comes off the web right away. The organizations stay in the CRM.`)) return;
    const { error } = await sb.from('directories').update({ archived_at: new Date().toISOString(), status: 'draft' }).eq('id', d.id);
    if (error) return fail(error); toast('Directory archived'); go('directories');
  };
  $('#dsSave').onclick = async () => {
    const slug = slugify($('#dsSlug').value);
    if (!$('#dsName').value.trim()) return toast('Name the directory');
    if (slug.length < 3) return toast('The web address needs at least 3 letters or numbers');
    if (slug !== d.slug && d.status === 'live' && !confirm('Changing the web address breaks links people already have. Change it anyway?')) return;
    const settings = { ...st, show_map: $('#dsMap').checked, edits_need_approval: $('#dsAppr').checked, reviews: $('#dsRev').checked,
      access: { invite: $('#dsInv').checked, checkout: $('#dsChk').checked, claim: $('#dsClaim').checked },
      grace_days: Math.min(365, Math.max(0, parseInt($('#dsGrace').value, 10) || 0)), unpaid_level: $('#dsUnpaid').value, repay_review: $('#dsRepay').checked,
      colors: { primary: $('#dsC1').value, accent: $('#dsC2').value } };
    const { error } = await sb.from('directories').update({ name: $('#dsName').value.trim(), slug, tagline: $('#dsTag').value.trim() || null,
      visibility: $('#dsVis').value, custom_domain: $('#dsDomain').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null, logo_media_id: logoId, settings }).eq('id', d.id);
    if (error) return fail(/duplicate|unique/i.test(error.message) ? new Error('That web address is taken. Try another.') : error);
    toast('Settings saved'); brandCheck('directory', d.id, $('#dsName').value.trim(), [settings.colors.primary, settings.colors.accent]); reload();
  };
}

async function dirListings(box, { d, cats, tiers, adm, reload }) {
  const [{ data: ls, error }, { data: stats }] = await Promise.all([
    sb.from('directory_listings').select('*,companies(id,name,address,city,state,zip,main_phone,website,org_types,archived_at),directory_listing_categories(category_id)')
      .eq('directory_id', d.id).is('archived_at', null).limit(2000),
    sb.rpc('directory_stats', { p_directory: d.id, p_days: 30 }),
  ]);
  if (error) throw error;
  const rows = (ls || []).filter((l) => l.companies && !l.companies.archived_at).sort((a, b) => a.companies.name.localeCompare(b.companies.name));
  const tierName = (tid) => tiers.find((t) => t.id === tid)?.name || 'No tier';
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  const freeTier = tiers.find((t) => t.is_free) || tiers[0];
  const st = stats?.listings || {};
  box.innerHTML = `
    <div class="toolbar"><input type="search" id="dlQ" placeholder="Search listings" style="flex:1">
      ${adm ? '<button class="btn small" id="dlAdd">+ Add listing</button><button class="btn ghost small" id="dlBulk">Add by type</button>' : ''}</div>
    <small class="hint" id="dlCount" style="display:block;margin:0 0 8px">${rows.length} listing${rows.length === 1 ? '' : 's'} · ${stats?.directory_views || 0} directory visits in the last 30 days</small>
    <div id="dlPanel"></div>
    <div class="list" id="dlList"></div>
    ${adm && rows.some((l) => l.lat == null) ? `<div class="actions"><button class="btn ghost small" id="dlLocate">Find map pins for ${rows.filter((l) => l.lat == null).length} listing${rows.filter((l) => l.lat == null).length === 1 ? '' : 's'} without one</button></div>` : ''}`;
  const draw = () => {
    const q = clean($('#dlQ').value).toLowerCase();
    const show = rows.filter((l) => !q || [l.companies.name, l.companies.city, ...l.directory_listing_categories.map((c) => catName[c.category_id])].join(' ').toLowerCase().includes(q));
    $('#dlList').innerHTML = show.map((l) => { const s1 = st[l.id] || {};
      return `<button class="item" data-lid="${l.id}"><b>${esc(l.companies.name)}</b>
        <small>${esc([orgAddrLine(l.companies), l.directory_listing_categories.map((c) => catName[c.category_id]).filter(Boolean).join(', ')].filter(Boolean).join(' · ') || 'No categories yet')}</small>
        <div class="meta"><span class="badge ${l.status === 'live' ? 'ok' : l.status === 'pending' ? 'gold' : ''}">${l.status === 'live' ? 'Live' : l.status === 'pending' ? 'Pending' : 'Hidden'}</span>
          <span class="badge">${esc(tierName(l.tier_id))}</span>${l.featured ? '<span class="badge gold">Featured</span>' : ''}${l.lat == null ? '<span class="badge due">No map pin</span>' : ''}
          ${s1.view || s1.call || s1.directions || s1.website ? `<span class="badge stage">30 days: ${s1.view || 0} views · ${s1.call || 0} calls · ${s1.directions || 0} directions · ${s1.website || 0} site</span>` : ''}</div></button>`; }).join('')
      || `<p class="empty">${rows.length ? 'No listings match.' : 'No listings yet. Add organizations from your CRM.'}</p>`;
    $$('#dlList [data-lid]').forEach((b) => (b.onclick = () => editListing(rows.find((l) => l.id === b.dataset.lid))));
  };
  $('#dlQ').oninput = debounce(draw, 150); draw();
  const addOrg = async (co) => {
    const g = await geocode(co);
    const { data, error: e } = await sb.from('directory_listings').insert({ directory_id: d.id, company_id: co.id, tier_id: freeTier?.id || null, status: 'live', lat: g?.lat ?? null, lng: g?.lng ?? null }).select('id').single();
    if (e) { if (/duplicate|unique/i.test(e.message)) { toast(`${co.name} is already listed`); return null; } fail(e); return null; }
    return data.id;
  };
  if (!adm) return;
  $('#dlAdd').onclick = () => {
    $('#dlPanel').innerHTML = `<div class="card panel"><h2>Add a listing</h2><input type="search" id="dlOrgQ" placeholder="Search your organizations" autocomplete="off"><div id="dlOrgRes"></div>
      <div class="actions"><button class="btn ghost small" id="dlX">Close</button></div></div>`;
    $('#dlX').onclick = () => ($('#dlPanel').innerHTML = '');
    const listed = new Set(rows.map((l) => l.company_id));
    $('#dlOrgQ').oninput = debounce(async () => {
      const term = clean($('#dlOrgQ').value);
      if (!term) return ($('#dlOrgRes').innerHTML = '');
      const { data } = await sb.from('companies').select('id,name,address,city,state,zip').is('archived_at', null).ilike('name', `%${term}%`).order('name').limit(10);
      $('#dlOrgRes').innerHTML = `<div class="results">${(data || []).map((o) => `<button type="button" class="result" data-oid="${o.id}" ${listed.has(o.id) ? 'disabled' : ''}><b>${esc(o.name)}</b><small>${esc(orgAddrLine(o))}${listed.has(o.id) ? ' · already listed' : ''}</small></button>`).join('')
        || ''}</div>
        <button type="button" class="btn secondary small" id="dlNewOrg" style="margin-top:8px">+ Create “${esc($('#dlOrgQ').value.trim())}” as a new organization</button><div id="dlNewForm"></div>`;
      $('#dlNewOrg').onclick = () => {
        const types = lk('org_type'), def = types.find((x) => /listing|member/i.test(x)) || types[0] || defaultOrgType();
        $('#dlNewOrg').hidden = true;
        $('#dlNewForm').innerHTML = `<div class="card" style="margin-top:8px"><h3 style="margin-top:0">New organization</h3>
          <label class="label">Name</label><input type="text" id="noName" value="${esc($('#dlOrgQ').value.trim())}" maxlength="200">
          <label class="label">Street address</label><input type="text" id="noAddr">
          <div class="row"><div><label class="label">City</label><input type="text" id="noCity"></div>
            <div class="row" style="margin:0"><div><label class="label">State</label><input type="text" id="noState" maxlength="2"></div><div><label class="label">ZIP</label><input type="text" id="noZip" inputmode="numeric" maxlength="10"></div></div></div>
          <div class="row"><div><label class="label">Phone</label><input type="tel" id="noPhone"></div><div><label class="label">Type</label><select id="noType">${types.map((x) => `<option ${x === def ? 'selected' : ''}>${esc(x)}</option>`).join('') || '<option>Clinic</option>'}</select></div></div>
          <small class="hint">It's saved as a regular organization in the CRM (lead credit to you) and added to ${esc(d.name)}. Add contacts and the rest from its organization page.</small>
          <div class="actions"><button class="btn" id="noSave">Create and add to directory</button><button class="btn ghost small" id="noX">Cancel</button></div></div>`;
        $('#noX').onclick = () => { $('#dlNewForm').innerHTML = ''; $('#dlNewOrg').hidden = false; };
        $('#noSave').onclick = async () => {
          const name = $('#noName').value.trim(); if (!name) return toast('Give it a name');
          const btn = $('#noSave'); btn.disabled = true;
          const row = { name, address: $('#noAddr').value.trim() || null, city: $('#noCity').value.trim() || null, state: $('#noState').value.trim().toUpperCase() || null,
            zip: $('#noZip').value.trim() || null, main_phone: $('#noPhone').value.trim() || null, org_types: [$('#noType').value], owner_id: S.me.id,
            lead_source_kind: 'self', lead_source_id: S.me.id };
          const { data: co, error: e } = await sb.from('companies').insert(row).select('id,name,address,city,state,zip').single();
          if (e) { btn.disabled = false; return fail(e); }
          const lid = await addOrg(co);
          if (lid) { toast(`${co.name} created and added to ${d.name}`); reload(); } else btn.disabled = false;
        };
        $('#noName').focus();
      };
      $$('#dlOrgRes [data-oid]').forEach((b) => (b.onclick = async () => {
        b.disabled = true; const o = data.find((x) => x.id === b.dataset.oid);
        const lid = await addOrg(o); if (lid) { toast(`${o.name} added`); reload(); }
      }));
    });
    $('#dlOrgQ').focus();
  };
  $('#dlBulk').onclick = () => {
    $('#dlPanel').innerHTML = `<div class="card panel"><h2>Add every organization of a type</h2>
      <small class="hint" style="margin:-4px 0 8px">Adds each organization with that type that isn't listed yet, on the ${esc(freeTier?.name || 'first')} tier. Map pins are looked up one a second.</small>
      <div class="row"><div><select id="dlType">${options('org_type', '', 'Choose a type')}</select></div><div><button class="btn" id="dlTypeGo">Add them</button> <button class="btn ghost small" id="dlX">Close</button></div></div>
      <small class="hint" id="dlProg"></small></div>`;
    $('#dlX').onclick = () => ($('#dlPanel').innerHTML = '');
    $('#dlTypeGo').onclick = async () => {
      const ty = $('#dlType').value; if (!ty) return toast('Choose a type');
      const listed = new Set(rows.map((l) => l.company_id));
      const { data } = await sb.from('companies').select('id,name,address,city,state,zip').is('archived_at', null).contains('org_types', [ty]).order('name').limit(1000);
      const todo = (data || []).filter((o) => !listed.has(o.id));
      if (!todo.length) return toast(`Every ${ty} is already listed`);
      if (!confirm(`Add ${todo.length} organization${todo.length === 1 ? '' : 's'} to ${d.name}?`)) return;
      $('#dlTypeGo').disabled = true; let n = 0;
      for (const o of todo) { if (await addOrg(o)) n++; $('#dlProg').textContent = `Added ${n} of ${todo.length}…`; await new Promise((r) => setTimeout(r, 1100)); }
      toast(`Added ${n} listing${n === 1 ? '' : 's'}`); reload();
    };
  };
  if ($('#dlLocate')) $('#dlLocate').onclick = async () => {
    const todo = rows.filter((l) => l.lat == null); const b = $('#dlLocate'); b.disabled = true; let n = 0, i = 0;
    for (const l of todo) { i++; b.textContent = `Looking up ${i} of ${todo.length}…`;
      const g = await geocode(l.companies);
      if (g) { const { error: e } = await sb.from('directory_listings').update({ lat: g.lat, lng: g.lng }).eq('id', l.id); if (!e) n++; }
      await new Promise((r) => setTimeout(r, 1100)); }
    toast(`Found ${n} of ${todo.length} on the map${n < todo.length ? '. Check the addresses on the rest.' : ''}`); reload();
  };

  function editListing(l) {
    const p = l.profile || {}, soc = p.social || {}, mine = new Set(l.directory_listing_categories.map((c) => c.category_id));
    const tree = catTree(cats);
    $('#dlPanel').innerHTML = `<div class="card panel"><div class="toolbar"><h2 style="margin:0;flex:1">${esc(l.companies.name)}</h2><button class="linkish" id="leOrg">Open organization</button></div>
      <small class="hint" style="margin:0 0 10px">Name, address, phone, website and logo come from the organization, so edit them there and the listing follows. ${esc([orgAddrLine(l.companies), l.companies.main_phone, l.companies.website].filter(Boolean).join(' · '))}</small>
      <div class="row"><div><label class="label">Tier</label><select id="leTier">${tiers.map((t) => `<option value="${t.id}" ${t.id === l.tier_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
        <div><label class="label">Status</label><select id="leStatus">${[['live', 'Live'], ['hidden', 'Hidden'], ['pending', 'Pending review']].map(([k, v]) => `<option value="${k}" ${l.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
      <label class="check"><input type="checkbox" id="leFeat" ${l.featured ? 'checked' : ''}> Featured (shows first, if the tier includes featured placement)</label>
      <b style="display:block;margin-top:10px">Categories</b>
      <div class="catpick">${tree.map((c) => `<label class="check" style="padding-left:${c.depth * 18}px"><input type="checkbox" data-lc="${c.id}" ${mine.has(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('') || '<small class="hint">Add categories on the Categories tab first.</small>'}</div>
      <label class="label">Short tagline</label><input type="text" id="leTag" value="${esc(p.tagline || '')}" maxlength="120" placeholder="Family plumbing since 1985">
      <label class="label">Description</label><textarea id="leDesc" rows="4">${esc(p.description || '')}</textarea>
      <label class="label">Hours</label><div id="leHours"></div>${p.hours && !p.hours_week ? `<small class="hint">Currently shows: ${esc(p.hours)}. Fill in the days to replace it.</small>` : ''}
      <label class="label">Services (comma separated)</label><textarea id="leSvc" rows="2">${esc((p.services || []).join(', '))}</textarea>
      <div class="row"><div><label class="label">Facebook</label><input type="url" id="leFb" value="${esc(soc.facebook || '')}"></div><div><label class="label">Instagram</label><input type="url" id="leIg" value="${esc(soc.instagram || '')}"></div></div>
      <div class="row"><div><label class="label">LinkedIn</label><input type="url" id="leLi" value="${esc(soc.linkedin || '')}"></div>
        <div><label class="label">Map pin</label><div class="inwrap" style="display:flex;gap:6px;align-items:center"><small class="hint" id="lePin" style="margin:0;flex:1">${l.lat != null ? `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}` : 'Not on the map yet'}</small><button type="button" class="btn ghost small" id="leLoc">Find from address</button><button type="button" class="btn ghost small" id="leMapBtn">Set on map</button></div><div id="leMap"></div></div></div>
      <b style="display:block;margin-top:12px">Photos</b><div id="lePhotos"></div>
      <small class="hint">What shows publicly depends on the tier. Fields the tier doesn't include are saved but hidden.</small>
      <div class="actions"><button class="btn ghost small danger" id="leArch">Remove from directory</button><span style="flex:1"></span><button class="btn ghost small" id="leX">Close</button><button class="btn" id="leSave">Save listing</button></div></div>`;
    $('#dlPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    let pin = l.lat != null ? { lat: l.lat, lng: l.lng } : null;
    const photos = (p.photos || []).map((x) => ({ ...x }));
    photoEditor($('#lePhotos'), photos, () => {}, (file) => uploadListingPhoto(d.tenant_id, l.id, file));
    const readHours = hoursEditor($('#leHours'), p.hours_week || null, p.hours_note || '');
    $('#dlPanel .panel').insertAdjacentHTML('beforeend', `<div id="leEdits"></div>
      <div class="lesec"><h3>Business logins</h3><small class="hint" style="margin:0 0 6px">People from this business who can update the listing${(d.settings || {}).edits_need_approval !== false ? ' (their changes come to Review for approval)' : ''} and answer messages. Their email is never shown to visitors.</small>
        <div id="leMembers"><p class="empty">Loading…</p></div>
        <div id="lmPick"></div>
        <div class="row"><div><input type="text" id="lmName" placeholder="Their name"></div><div><input type="email" id="lmEmail" placeholder="Their email"></div></div>
        <div class="actions"><button class="btn secondary small" id="lmInvite">Invite to manage this listing</button></div></div>
      <div class="lesec"><h3>Messages</h3><div id="leThreads"><p class="empty">Loading…</p></div><div id="leThread"></div></div>`);
    renderListingEdits($('#leEdits'), { listingId: l.id, onDone: reload });
    const drawMembers = async () => {
      const { data: ms } = await sb.from('directory_members').select('id,email,full_name,user_id,accepted_at,created_at').eq('listing_id', l.id).is('revoked_at', null).order('created_at');
      $('#leMembers').innerHTML = (ms || []).map((m) => `<div class="person-row"><div class="toolbar"><div style="flex:1"><b>${esc(m.full_name || m.email)}</b><br><small>${esc(m.email)} · ${m.accepted_at ? 'has a login' : 'invited ' + esc(fmtDate(m.created_at)) + ', not signed up yet'}</small></div>
        ${m.accepted_at ? '' : `<button class="btn ghost small" data-mresend="${m.id}">Resend invite</button>`}<button class="btn ghost small danger" data-mrevoke="${m.id}">Remove access</button></div></div>`).join('') || '<p class="empty" style="margin:0">Nobody from this business has a login yet.</p>';
      $$('[data-mrevoke]').forEach((b) => (b.onclick = async () => { if (!confirm('Remove this person\'s access to the listing?')) return; const { error: e } = await sb.rpc('directory_revoke_member', { p_member: b.dataset.mrevoke }); if (e) return fail(e); toast('Access removed'); drawMembers(); }));
      $$('[data-mresend]').forEach((b) => (b.onclick = async () => { const { data: r, error: e } = await sb.functions.invoke('directory-email', { body: { kind: 'invite', member_id: b.dataset.mresend } }); if (e || r?.error) return fail(e || new Error(r.error)); toast('Invite sent again'); }));
    };
    drawMembers();
    // one click to invite someone already on this organization in the CRM (decision makers first)
    (async () => {
      if (!l.company_id) return;
      const { data: cs } = await sb.from('company_people').select('work_email,is_decision_maker,is_primary_contact,people(first_name,last_name,personal_email,archived_at)').eq('company_id', l.company_id);
      const opts = (cs || []).filter((c) => c.people && !c.people.archived_at && (c.work_email || c.people.personal_email))
        .sort((a, b) => (b.is_decision_maker - a.is_decision_maker) || (b.is_primary_contact - a.is_primary_contact));
      if (!opts.length) return;
      $('#lmPick').innerHTML = `<small class="hint" style="margin:6px 0 4px">From this organization's contacts:</small><div class="chips" style="margin-bottom:12px">${opts.map((c, i) =>
        `<button type="button" class="chip" data-lmpick="${i}">${esc([c.people.first_name, c.people.last_name].filter(Boolean).join(' '))}${c.is_decision_maker ? ' · Decision maker' : c.is_primary_contact ? ' · Primary' : ''}</button>`).join('')}</div>`;
      $$('[data-lmpick]').forEach((b) => (b.onclick = () => { const c = opts[+b.dataset.lmpick];
        $('#lmName').value = [c.people.first_name, c.people.last_name].filter(Boolean).join(' '); $('#lmEmail').value = c.work_email || c.people.personal_email; $('#lmInvite').focus(); }));
    })();
    $('#lmInvite').onclick = async () => {
      const em = $('#lmEmail').value.trim(); if (!/^\S+@\S+\.\S+$/.test(em)) return toast('Enter their email');
      const b = $('#lmInvite'); b.disabled = true;
      const { data: r, error: e } = await sb.rpc('directory_invite_member', { p_listing: l.id, p_email: em, p_name: $('#lmName').value.trim() || null });
      if (e) { b.disabled = false; return fail(e); }
      const { data: sent, error: e2 } = await sb.functions.invoke('directory-email', { body: { kind: 'invite', member_id: r.id } });
      b.disabled = false; $('#lmEmail').value = ''; $('#lmName').value = '';
      toast(e2 || sent?.error ? `Access added, but the email didn't send. Tell them to sign up at ${S.pub()} with ${r.email}.` : r.status === 'linked' ? 'Added. They already had a login, and we emailed them.' : 'Invite emailed');
      drawMembers();
    };
    (async () => {
      const { data: th } = await sb.from('directory_threads').select('id,visitor_name,last_message_at,unread_business').eq('listing_id', l.id).order('last_message_at', { ascending: false }).limit(20);
      $('#leThreads').innerHTML = (th || []).map((t) => `<button class="item" data-lth="${t.id}"><b>${esc(t.visitor_name)}${t.unread_business ? ' <span class="badge due">Unread by the business</span>' : ''}</b><div class="meta"><span class="badge stage">${esc(fmtDate(t.last_message_at))}</span></div></button>`).join('')
        || '<p class="empty" style="margin:0">No messages yet.</p>';
      $$('[data-lth]').forEach((b) => (b.onclick = () => threadView($('#leThread'), b.dataset.lth, { canReply: false })));
    })();
    $('#leOrg').onclick = () => go('org', l.company_id);
    $('#leX').onclick = () => ($('#dlPanel').innerHTML = '');
    $('#leLoc').onclick = async () => {
      const b = $('#leLoc'); b.disabled = true; b.textContent = 'Looking…';
      const g = await geocode(l.companies);
      b.disabled = false; b.textContent = 'Find from address';
      if (!g) return toast('Couldn\'t find that address, town or ZIP on the map. Check the address on the organization page.');
      pin = { lat: g.lat, lng: g.lng }; $('#lePin').textContent = `${pinNote(g)}. Save to keep it.${g.level !== 'address' ? ' Check it with Set on map.' : ''}`;
      if (g.level !== 'address') $('#leMapBtn').click();
    };
    $('#leMapBtn').onclick = () => pinPicker($('#leMap'), pin, (p2) => { pin = p2; $('#lePin').textContent = `Placed by hand at ${p2.lat.toFixed(5)}, ${p2.lng.toFixed(5)}. Save to keep it.`; }).catch(() => toast('Couldn\'t load the map. Try again.'));
    $('#leArch').onclick = async () => {
      if (!confirm(`Take ${l.companies.name} out of ${d.name}? The organization stays in the CRM.`)) return;
      const { error: e } = await sb.from('directory_listings').update({ archived_at: new Date().toISOString(), status: 'hidden' }).eq('id', l.id);
      if (e) return fail(e); toast('Removed from the directory'); reload();
    };
    $('#leSave').onclick = async () => {
      const profile = { ...p, photos, tagline: $('#leTag').value.trim(), description: $('#leDesc').value.trim(), ...readHours(),
        services: $('#leSvc').value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 40),
        social: Object.fromEntries([['facebook', $('#leFb').value.trim()], ['instagram', $('#leIg').value.trim()], ['linkedin', $('#leLi').value.trim()]].filter(([, v]) => v)) };
      const { error: e } = await sb.from('directory_listings').update({ tier_id: $('#leTier').value || null, status: $('#leStatus').value, featured: $('#leFeat').checked,
        profile, lat: pin?.lat ?? null, lng: pin?.lng ?? null }).eq('id', l.id);
      if (e) return fail(e);
      const want = new Set($$('[data-lc]').filter((c) => c.checked).map((c) => c.dataset.lc));
      const add = [...want].filter((c) => !mine.has(c)), drop = [...mine].filter((c) => !want.has(c));
      if (add.length) { const { error: e2 } = await sb.from('directory_listing_categories').insert(add.map((c) => ({ listing_id: l.id, category_id: c }))); if (e2) return fail(e2); }
      if (drop.length) { const { error: e3 } = await sb.from('directory_listing_categories').delete().eq('listing_id', l.id).in('category_id', drop); if (e3) return fail(e3); }
      toast('Listing saved'); reload();
    };
  }
}

/* ================= sites ================= */
// Sites and funnels GELP hosts for this account. Clients see their own and request changes; GELP admins manage
// every account's sites, account manager and developer from here.
/* ================= ADMIN: IMPORT ================= */
const IMP_FIELDS = [
  ['', 'Skip this column'],
  ['org_name', 'Organization name', /^(organi[sz]ation|org|company|clinic|practice|account|business)( name)?$/],
  ['website', 'Website', /^(website|web|url|site)$/],
  ['main_phone', 'Organization phone', /^(org(anization)? phone|main phone|office phone|company phone|clinic phone)$/],
  ['fax', 'Organization fax'],
  ['main_email', 'Organization email', /^(org(anization)? email|main email|office email|company email|general email)$/],
  ['address', 'Street address', /^(address|street|address ?1|street address)$/],
  ['city', 'City', /^city$/], ['state', 'State', /^(state|st|province)$/], ['zip', 'ZIP', /^(zip|zip ?code|postal( code)?)$/],
  ['specialty', 'Specialty', /^specialty$/], ['org_type', 'Organization type', /^(type|org(anization)? type|category)$/],
  ['first_name', 'Contact first name', /^(first|first name|fname|given name)$/], ['last_name', 'Contact last name', /^(last|last name|lname|surname)$/],
  ['full_name', 'Contact full name', /^(name|contact|contact name|full name)$/],
  ['email', 'Contact email (sorted: Gmail, Yahoo and the like go to personal)', /^(e-?mail|contact email|email address)$/],
  ['work_email', 'Contact company / work email'], ['personal_email', 'Contact personal email'], ['phone', 'Contact phone', /^(phone|cell|mobile|contact phone|direct)$/],
  ['title', 'Contact title', /^(title|job title|position|role)$/],
  ['pipeline', 'Pipeline', /^(pipeline|funnel)$/], ['stage', 'Stage', /^(stage|status|deal stage|pipeline stage)$/],
  ['owner_email', 'Owner (team member email)', /^(owner|rep|owner email|assigned to)$/],
  ['lead_source', 'Lead source (team member email or name, or referral partner)', /^(lead ?source|referred by|referral source|lead credit)$/],
  ['note', 'Note', /^(note|notes|comment|comments)$/],
];
let IMP = null;
// who gets lead credit for organizations this import adds: the person importing unless an admin picks otherwise
const IMP_LEAD = { kind: 'self', user_id: '', partner_id: '', partner_label: '', allowNone: true };
const impLead = () => !isAdmin() ? { kind: 'self' } : { kind: IMP_LEAD.kind, user_id: IMP_LEAD.user_id || null, partner_id: IMP_LEAD.partner_id || null };
const imUpMode = () => { try { return localStorage.getItem('imUpMode') === 'overwrite' ? 'overwrite' : 'fill'; } catch { return 'fill'; } };
const imUpHint = () => imUpMode() === 'overwrite'
  ? 'Spreadsheet values replace what\'s on the record. Blank cells never erase anything. You can undo the whole import for 48 hours.'
  : 'Only empty fields on the existing record get filled in. Nothing already there changes.';
// Smart column matching: reads each header (and peeks at the data) and picks the closest field.
// Anything it isn't reasonably sure about is left as "Skip this column".
const IMP_SYN = {
  org_name: ['organization', 'organization name', 'org', 'org name', 'company', 'company name', 'clinic', 'clinic name', 'practice', 'practice name', 'account', 'account name',
    'business', 'business name', 'facility', 'facility name', 'provider', 'provider name', 'organization provider', 'office name', 'hospital', 'hospital name', 'location name', 'dba', 'group name', 'name of practice'],
  website: ['website', 'web site', 'web', 'url', 'site', 'homepage', 'web address', 'domain'],
  main_phone: ['main phone', 'office phone', 'company phone', 'clinic phone', 'practice phone', 'business phone', 'org phone', 'organization phone', 'front desk', 'main line', 'main number', 'office number'],
  fax: ['fax', 'fax number', 'fax no', 'facsimile', 'office fax', 'clinic fax'],
  main_email: ['main email', 'office email', 'company email', 'general email', 'clinic email', 'practice email', 'info email', 'org email', 'organization email'],
  address: ['address', 'street', 'street address', 'address 1', 'address line 1', 'address1', 'addr', 'mailing address', 'physical address', 'location address'],
  city: ['city', 'town'], state: ['state', 'st', 'province', 'state code'], zip: ['zip', 'zip code', 'zipcode', 'postal', 'postal code', 'postcode'],
  specialty: ['specialty', 'speciality', 'specialty service', 'specialties', 'service', 'services', 'service line', 'practice type', 'department'],
  org_type: ['type', 'org type', 'organization type', 'category', 'account type'],
  first_name: ['first', 'first name', 'fname', 'given name', 'firstname', 'contact first name'],
  last_name: ['last', 'last name', 'lname', 'surname', 'lastname', 'family name', 'contact last name'],
  full_name: ['name', 'contact', 'contact name', 'full name', 'person', 'contact person', 'primary contact', 'decision maker', 'physician', 'doctor'],
  email: ['contact email', 'email address', 'email', 'e mail'],
  work_email: ['work email', 'business email', 'contact work email', 'professional email', 'corporate email'],
  personal_email: ['personal email', 'home email', 'private email', 'contact personal email', 'personal e mail'],
  phone: ['contact phone', 'cell', 'mobile', 'cell phone', 'mobile phone', 'direct', 'direct line', 'direct phone', 'phone', 'phone number', 'telephone', 'tel', 'ph'],
  title: ['title', 'job title', 'position', 'role', 'contact title'],
  pipeline: ['pipeline', 'funnel'], stage: ['stage', 'status', 'deal stage', 'pipeline stage', 'lead status'],
  owner_email: ['owner', 'owner email', 'rep', 'sales rep', 'assigned to', 'assigned', 'account manager'],
  note: ['note', 'notes', 'comment', 'comments', 'remarks', 'description', 'details'],
};
const IMP_GENERIC = { email: ['email', 'e mail', 'email address'], phone: ['phone', 'phone number', 'telephone', 'tel', 'ph'] };
function smartMap(head, body) {
  const norm = (t) => String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/e-mail/g, 'email').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const toks = (t) => t.split(' ').filter(Boolean);
  const cols = head.map((h, i) => {
    const vals = body.slice(0, 50).map((r) => String(r[i] ?? '').trim()).filter(Boolean);
    const share = (re) => vals.length ? vals.filter((v) => re.test(v)).length / vals.length : 0;
    return { h: norm(h), email: share(/^[^@\s]+@[^@\s]+\.[^@\s]+$/), phone: share(/^[^a-z]*\d[^a-z]*$/i) * (vals.length && vals.every((v) => v.replace(/\D/g, '').length >= 10 && v.replace(/\D/g, '').length <= 11) ? 1 : 0),
      zip: share(/^\d{5}(-\d{4})?$/), st: share(/^[A-Za-z]{2}$/), url: share(/^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i) * (1 - share(/@/)) };
  });
  const score = (c, field) => {
    let best = 0; const ht = toks(c.h);
    for (const syn of IMP_SYN[field] || []) {
      if (c.h === syn) { best = 1; break; }
      const st = toks(syn);
      if (st.length && st.every((w) => ht.includes(w))) best = Math.max(best, 0.7 + 0.1 * Math.min(1, st.length / ht.length));
      else if (ht.length && ht.every((w) => st.includes(w)) && ht.join('').length > 2) best = Math.max(best, 0.62);
    }
    if (['email', 'main_email', 'work_email', 'personal_email'].includes(field) && /\b(owner|rep|assigned)\b/.test(c.h)) return 0;
    if (['email', 'main_email', 'work_email', 'personal_email'].includes(field)) best += c.email > 0.5 ? 0.25 : best ? -0.3 : 0;
    if (['phone', 'main_phone', 'fax'].includes(field) && c.phone > 0.5) best += 0.15;
    if (field === 'zip' && c.zip > 0.6) best = Math.max(best, 0.65) + 0.2;
    if (field === 'state' && c.st > 0.8) best += 0.2;
    if (field === 'website' && c.url > 0.6) best = Math.max(best, 0.65) + 0.15;
    if (field === 'email' && !best && c.email > 0.8) best = 0.65;
    return best;
  };
  const fields = Object.keys(IMP_SYN);
  const cand = [];
  cols.forEach((c, i) => fields.forEach((f) => { const sc = score(c, f); if (sc >= 0.6) cand.push([sc, i, f]); }));
  cand.sort((a, b) => b[0] - a[0]);
  const map = head.map(() => ''), conf = head.map(() => 'none'), used = new Set();
  for (const [sc, i, f] of cand) {
    if (map[i] || (used.has(f) && f !== 'note')) continue;
    map[i] = f; conf[i] = sc >= 0.85 ? 'sure' : 'guess'; used.add(f);
  }
  // a bare "Phone" or "Email" column belongs to the organization when the sheet has no contact names
  const hasContact = map.some((f) => ['first_name', 'last_name', 'full_name'].includes(f));
  if (!hasContact) cols.forEach((c, i) => {
    const swap = map[i] === 'phone' && IMP_GENERIC.phone.includes(c.h) ? 'main_phone' : map[i] === 'email' && IMP_GENERIC.email.includes(c.h) ? 'main_email' : '';
    if (swap && !map.includes(swap)) map[i] = swap;
  });
  return { map, conf };
}
const loadXLSX = () => window.XLSX ? Promise.resolve(window.XLSX) : new Promise((ok, no) => {
  const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  sc.onload = () => ok(window.XLSX); sc.onerror = () => no(new Error('Could not load the spreadsheet reader. Check your connection.')); document.head.appendChild(sc);
});
// Import template for this account: column headers the matcher recognizes, two example rows from the account's
// own pipelines, stages, lists and team, plus an Options sheet listing every allowed value.
const IMP_TEMPLATE = [
  ['Organization name', 'org_name'], ['Organization type', 'org_type'], ['Specialty', 'specialty'], ['Website', 'website'],
  ['Organization phone', 'main_phone'], ['Organization fax', 'fax'], ['Organization email', 'main_email'],
  ['Street address', 'address'], ['City', 'city'], ['State', 'state'], ['ZIP', 'zip'],
  ['Contact first name', 'first_name'], ['Contact last name', 'last_name'], ['Contact title', 'title'],
  ['Contact work email', 'work_email'], ['Contact personal email', 'personal_email'], ['Contact phone', 'phone'],
  ['Pipeline', 'pipeline'], ['Stage', 'stage'], ['Owner email', 'owner_email'], ['Lead source', 'lead_source'], ['Notes', 'note'],
];
async function downloadImportTemplate() {
  const X = await loadXLSX();
  await loadStages(true);
  const pipes = S.pipelines || [];
  const stagesOf = (pl) => S.stages.filter((x) => x.pipeline_id === pl.id).sort((a, b) => a.sort - b.sort).map((x) => x.name);
  const p0 = pipes[0], st0 = p0 ? stagesOf(p0) : [];
  const types = lk('org_type'), specs = lk('specialty'), team = staff().map((u) => u.email).filter(Boolean);
  const ex = (a, i, d = '') => a.length ? a[Math.min(i, a.length - 1)] : d;
  const sample = [
    { org_name: 'Acme Company', org_type: ex(types, 0, 'Client'), specialty: ex(specs, 0), website: 'acmecompany.com', main_phone: '(555) 555-0100', fax: '(555) 555-0101',
      main_email: 'office@examplefamilyclinic.com', address: '100 Main St', city: 'Springfield', state: 'IL', zip: '62701', first_name: 'Jane', last_name: 'Smith', title: 'Practice Manager',
      work_email: 'jane@examplefamilyclinic.com', personal_email: '', phone: '(555) 555-0102', pipeline: p0?.name || '', stage: ex(st0, 0), owner_email: ex(team, 0), note: 'Met at a networking event' },
    { org_name: 'Acme Company', org_type: ex(types, 0, 'Client'), specialty: ex(specs, 0), website: '', main_phone: '(555) 555-0100', fax: '',
      main_email: '', address: '100 Main St', city: 'Springfield', state: 'IL', zip: '62701', first_name: 'Robert', last_name: 'Lee', title: 'Physician',
      work_email: '', personal_email: 'drlee@gmail.com', phone: '', pipeline: p0?.name || '', stage: ex(st0, 1), owner_email: ex(team, 1), note: 'Same organization as the row above, so they share one record' },
  ];
  const head = IMP_TEMPLATE.map(([h]) => h);
  const ws = X.utils.aoa_to_sheet([head, ...sample.map((r) => IMP_TEMPLATE.map(([, k]) => r[k] ?? ''))]);
  ws['!cols'] = head.map((h) => ({ wch: Math.max(14, h.length + 2) }));
  const opts = [['What', 'Allowed values (type them exactly; anything new is created for you, except owners)']];
  opts.push(['Organization type', types.join(', ') || 'Client']);
  if (specs.length) opts.push(['Specialty', specs.join(', ')]);
  pipes.forEach((pl) => opts.push([`Stages in "${pl.name}"`, stagesOf(pl).join(', ')]));
  opts.push(['Pipeline', pipes.map((x) => x.name).join(', ')]);
  opts.push(['Owner email', team.join(', ')]);
  opts.push(['Lead source', 'Who gets lead credit for that organization: a team member\'s email or name, or a referral partner\'s name. Leave it blank to use the lead source picked on the Import screen (the person importing, unless an admin picks someone else).']);
  opts.push(['Emails', 'Use Contact work email and Contact personal email when you know which is which. A single column named Email is sorted for you: Gmail, Yahoo, iCloud, Hotmail and similar go to personal, anything else to work.']);
  opts.push(['One row per contact', 'Repeat the organization on each row for its other contacts. Rows with the exact same organization, address, city and phone share one record.']);
  const wo = X.utils.aoa_to_sheet(opts); wo['!cols'] = [{ wch: 26 }, { wch: 110 }];
  const wb = X.utils.book_new(); X.utils.book_append_sheet(wb, ws, 'Import'); X.utils.book_append_sheet(wb, wo, 'Options');
  const slug = String(S.acct?.name || 'crm').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  X.writeFile(wb, `${slug}-import-template.xlsx`);
  toast('Template downloaded');
}
async function viewImport(main) {
  await loadStages(true);
  main.innerHTML = `<h1>Import</h1>
    <div class="card"><h2>1. Choose a spreadsheet</h2>
      <small class="hint" style="margin:-4px 0 10px">Excel (.xlsx) or CSV. The first row should be column names. One row per contact or organization. Add Pipeline and Stage columns to place each row; any pipeline or stage that doesn't exist yet is created for you. Every row is kept. If a row looks like an organization or contact you already have, Import flags it in Review for an admin to merge or dismiss; only Import and Update changes existing records. Rows that repeat the exact same organization for another contact share one organization.</small>
      <div class="imtpl"><input type="file" id="imFile" accept=".csv,.xlsx,.xls,text/csv" style="max-width:100%">
        <button type="button" class="btn ghost small" id="imTpl">Download a template</button></div>
      <small class="hint" style="margin:6px 0 0">The template is built from this account's own setup: your pipelines and stages, organization types, specialties and team emails, with two example rows. Fill it in and every column matches on its own.</small>
      <div class="imupd"><p style="margin:0"><b>If you use Import and Update</b>, matching organizations (same name and city) and contacts (same email) are updated instead of added:</p>
        <div class="seg" id="imUpMode" role="radiogroup" aria-label="How to update existing records">
          <button type="button" data-um="fill" class="${imUpMode() === 'fill' ? 'on' : ''}">Fill in blanks only</button>
          <button type="button" data-um="overwrite" class="${imUpMode() === 'overwrite' ? 'on' : ''}">Overwrite with the spreadsheet</button></div>
        <small class="hint" id="imUpHint">${imUpHint()}</small></div>
      <div class="imupd"><p style="margin:0 0 6px"><b>Lead source</b> for the organizations this import adds. A Lead source column on the spreadsheet wins for its row. Existing records only get one where none is set.</p>
        <div id="imLead"></div></div></div>
    <div id="imStep"></div><div id="imHist"></div>`;
  if (!isAdmin()) IMP_LEAD.kind = 'self';
  if (isAdmin()) leadPicker($('#imLead'), IMP_LEAD);
  else $('#imLead').innerHTML = `<div class="picked"><div><b>${esc(S.me.full_name)} (you)</b><small>Imports you run credit you. Only an admin can credit an import to someone else.</small></div></div>`;
  drawImportHistory();
  $$('#imUpMode [data-um]').forEach((b) => (b.onclick = () => {
    try { localStorage.setItem('imUpMode', b.dataset.um); } catch {}
    $$('#imUpMode [data-um]').forEach((x) => x.classList.toggle('on', x === b)); $('#imUpHint').textContent = imUpHint();
    if (IMP) drawImport();
  }));
  $('#imTpl').onclick = () => downloadImportTemplate().catch(fail);
  $('#imFile').onchange = async () => {
    const f = $('#imFile').files[0]; if (!f) return;
    try {
      const X = await loadXLSX();
      const wb = X.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
      const grid = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
      const at = grid.findIndex((r) => r.some((c) => String(c).trim()));
      if (at < 0) return toast('That sheet is empty');
      const head = grid[at].map((c) => String(c).trim());
      const body = grid.slice(at + 1).filter((r) => r.some((c) => String(c).trim()));
      const { map, conf } = smartMap(head, body);
      IMP = { name: f.name, head, body, map, conf, pipe: '' };
      drawImport();
    } catch (e) { fail(e); }
  };
}
const impRows = () => IMP.body.map((r) => {
  const o = {}; IMP.map.forEach((k, i) => { if (k && String(r[i] ?? '').trim()) o[k] = o[k] ? o[k] + (k === 'note' ? '\n' : ' ') + String(r[i]).trim() : String(r[i]).trim(); });
  if (IMP.pipe && !o.pipeline && o.org_name) o.pipeline = IMP.pipe;
  return o;
});
function drawImport(result) {
  const el = $('#imStep'); if (!el) return;
  const rows = impRows(), sample = rows.slice(0, 5), cols = [...new Set(IMP.map.filter(Boolean))];
  const label = (k) => IMP_FIELDS.find((x) => x[0] === k)?.[1] || k;
  const have = (k) => IMP.map.includes(k);
  const newPipes = [...new Set(rows.map((r) => r.pipeline).filter(Boolean).filter((n) => !S.pipelines.some((p) => p.name.toLowerCase() === n.toLowerCase())).map((n) => n.trim()))];
  const def = S.pipelines.find((p) => p.is_default);
  const newStages = new Set(); rows.forEach((r) => { if (!r.stage) return; const pl = S.pipelines.find((p) => p.name.toLowerCase() === (r.pipeline || def?.name || '').toLowerCase()); if (!pl || !S.stages.some((x) => x.pipeline_id === pl.id && x.name.toLowerCase() === r.stage.toLowerCase())) newStages.add(`${r.pipeline || def?.name} › ${r.stage}`); });
  el.innerHTML = `<div class="card"><h2>2. Match the columns</h2><small class="hint" style="margin:-4px 0 10px">${esc(IMP.name)}: ${IMP.body.length} ${IMP.body.length === 1 ? 'row' : 'rows'}. Tell us what each column holds. We guessed where we could.</small>
      <div class="immap">${IMP.head.map((h, i) => `<div class="imcol"><b>${esc(h || `Column ${i + 1}`)}</b><small>${esc(String(IMP.body[0]?.[i] ?? '').slice(0, 60))}</small>
        <select data-col="${i}" aria-label="What ${esc(h)} holds">${IMP_FIELDS.map((x) => `<option value="${x[0]}" ${IMP.map[i] === x[0] ? 'selected' : ''}>${esc(x[1])}</option>`).join('')}</select>
        <small class="imconf ${IMP.conf?.[i] || ''}">${({ sure: 'Matched automatically', guess: 'Best guess, check this', none: 'Not sure, skipped', manual: 'Set by you' })[IMP.conf?.[i] || (IMP.map[i] ? 'manual' : 'none')]}</small></div>`).join('')}</div>
      ${have('pipeline') ? '' : `<div class="row" style="margin-top:10px"><div><label class="label" for="imPipe">Put these organizations in</label>
        <select id="imPipe"><option value="">${esc(def?.name || 'Default pipeline')} (default)</option>${S.pipelines.filter((p) => !p.is_default).map((p) => `<option ${IMP.pipe === p.name ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div><div></div></div>`}
    </div>
    <div class="card"><h2>3. Check and import</h2>
      ${!have('org_name') && !have('first_name') && !have('full_name') && !have('email') ? '<p class="empty">Match at least an organization name, a contact name or an email.</p>' : `
      <div class="tablewrap"><table class="imprev"><thead><tr>${cols.map((k) => `<th>${esc(label(k))}</th>`).join('')}</tr></thead>
        <tbody>${sample.map((r) => `<tr>${cols.map((k) => `<td>${esc(r[k] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      ${rows.length > 5 ? `<small class="hint">Showing 5 of ${rows.length}.</small>` : ''}
      ${newPipes.length ? `<p><b>New pipelines (${newPipes.length}):</b> ${newPipes.map(esc).join(', ')}</p>` : ''}
      ${newStages.size ? `<p><b>New stages (${newStages.size}):</b> ${[...newStages].slice(0, 30).map(esc).join(', ')}${newStages.size > 30 ? '…' : ''}</p>` : ''}
      <div id="imRes">${result || ''}</div>
      <div class="actions"><button class="btn secondary" id="imCheck">Check first (nothing is saved)</button><button class="btn" id="imGo">Import ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}</button>
        <button class="btn secondary" id="imUpd">Import and Update (${imUpMode() === 'overwrite' ? 'overwrite' : 'fill in blanks'})</button></div>
      <small class="hint">Import adds every row as new and flags look-alikes in Review. Import and Update updates matches instead.</small>`}
    </div>`;
  $$('[data-col]').forEach((sel) => (sel.onchange = () => { const v = sel.value; if (v) IMP.map = IMP.map.map((k, i) => (k === v && i !== +sel.dataset.col ? '' : k)); IMP.map[+sel.dataset.col] = v; if (IMP.conf) IMP.conf[+sel.dataset.col] = v ? 'manual' : 'none'; drawImport(); }));
  if ($('#imPipe')) $('#imPipe').onchange = () => { IMP.pipe = $('#imPipe').value; drawImport(); };
  if ($('#imCheck')) $('#imCheck').onclick = () => { IMP.kind = 'contacts'; runImport(true); };
  if ($('#imGo')) $('#imGo').onclick = () => { IMP.kind = 'contacts'; runImport(true, { scan: true }); };
  if ($('#imUpd')) $('#imUpd').onclick = () => { IMP.kind = 'contacts:' + imUpMode(); runImport(true, { scan: true }); };
  bindDupPanel();
}
async function runImport(dry, opts = {}) {
  // rows the user chose to skip stay out; every result maps back to the spreadsheet row number
  const all = impRows(), keep = all.map((_, i) => i).filter((i) => !IMP.skip?.has(i)), rows = keep.map((i) => all[i]);
  const size = dry ? 1000 : 500, tot = { rows: 0, orgs_new: 0, orgs_matched: 0, orgs_updated: 0, people_new: 0, people_matched: 0, people_updated: 0, pipelines_new: 0, stages_new: 0, notes: 0, flagged: 0 }, errs = [], dupes = [], warns = [];
  const lock = (on) => $$('#imCheck,#imGo,#imUpd,[data-col],#imPipe,#imFile,[data-dskip],#imDupGo,#imDupAll,#imDupX').forEach((b) => (b.disabled = on));
  const leadBad = isAdmin() ? leadValid(IMP_LEAD) : null;
  if (leadBad) { $('#imLead')?.scrollIntoView({ block: 'center' }); return toast(leadBad); }
  lock(true);
  // a real run gets one batch id across all its chunks, so the whole file can be undone for 48 hours
  const batch = dry ? null : crypto.randomUUID();
  try {
    for (let i = 0; i < rows.length; i += size) {
      $('#imRes').innerHTML = `<p class="hint">${opts.scan ? 'Checking for duplicates in' : dry ? 'Checking' : 'Importing'} rows ${i + 1} to ${Math.min(i + size, rows.length)} of ${rows.length}…</p>`;
      const { data, error } = await sb.rpc('import_rows', { p_rows: rows.slice(i, i + size), p_kind: IMP.kind || 'contacts', p_dry: dry, p_lead: impLead(), ...(batch ? { p_batch: batch, p_file: IMP.name || null } : {}) });
      if (error) throw error;
      Object.keys(tot).forEach((k) => (tot[k] += Number(data[k] || 0)));
      (data.errors || []).forEach((e) => errs.push({ sheet: keep[i + e.row - 1] + 2, error: e.error }));
      (data.warnings || []).forEach((w) => warns.push({ sheet: keep[i + w.row - 1] + 2, warning: w.warning }));
      (data.dupes || []).forEach((d) => dupes.push({ idx: keep[i + d.row - 1], sheet: keep[i + d.row - 1] + 2, matches: d.matches || [] }));
    }
  } catch (e) { lock(false); $('#imRes').innerHTML = ''; drawImportHistory(); return fail(e); }
  lock(false);
  if (opts.scan) {
    if (!dupes.length) return runImport(false);
    IMP.dupes = dupes; IMP.dskip = new Set(dupes.map((d) => d.idx));
    return drawImport(dupPanelHTML());
  }
  const pl = (n, a, b) => `${n} ${n === 1 ? a : b}`;
  const skipped = all.length - rows.length;
  const html = `<div class="imsum ${dry ? '' : 'done'}"><b>${dry ? `If you ${(IMP.kind || 'contacts') === 'contacts' ? 'import' : 'import and update with'} this file:` : 'Imported.'}</b>
    <ul><li>${pl(tot.orgs_new, 'new organization', 'new organizations')}${tot.orgs_matched ? `, plus ${pl(tot.orgs_matched, 'row that adds', 'rows that add')} another contact to the same organization` : ''}</li>
    ${tot.orgs_updated ? `<li>${pl(tot.orgs_updated, 'existing organization', 'existing organizations')} ${dry ? 'would be' : ''} updated (${(IMP.kind || '').endsWith('overwrite') ? 'overwrite' : 'blanks filled in'})</li>` : ''}
    <li>${pl(tot.people_new, 'new contact', 'new contacts')}${tot.people_updated ? `, ${pl(tot.people_updated, 'existing contact', 'existing contacts')} ${dry ? 'would be' : ''} updated` : ''}</li>
    ${tot.flagged ? `<li><b>${pl(tot.flagged, 'possible duplicate', 'possible duplicates')}</b> ${dry ? 'would be' : tot.flagged === 1 ? 'was' : 'were'} flagged in Review for an admin to check</li>` : ''}
    ${dry ? '' : `<li>${pl(tot.pipelines_new, 'new pipeline', 'new pipelines')}, ${pl(tot.stages_new, 'new stage', 'new stages')}</li>`}
    ${skipped ? `<li>${pl(skipped, 'row', 'rows')} skipped by you</li>` : ''}
    ${tot.notes ? `<li>${pl(tot.notes, 'note', 'notes')}</li>` : ''}</ul>
    ${warns.length ? `<p><b>${pl(warns.length, 'row', 'rows')} ${dry ? 'would get' : 'got'} the default lead source:</b></p><ul>${warns.slice(0, 50).map((w) => `<li>Spreadsheet row ${w.sheet}: ${esc(w.warning)}</li>`).join('')}</ul>${warns.length > 50 ? `<small class="hint">and ${warns.length - 50} more</small>` : ''}` : ''}
    ${batch ? `<p class="hint" style="margin:6px 0 0">Made a mistake? You can undo this import for 48 hours.</p><div class="actions" style="margin:6px 0 0"><button class="btn secondary small" data-imundo="${batch}">Undo this import</button></div>` : ''}
    ${dry && dupes.length ? `<p><b>Rows that look like duplicates:</b></p><ul>${dupes.slice(0, 50).map((d) => `<li>Spreadsheet row ${d.sheet}: looks like ${esc(d.matches.join('; '))}</li>`).join('')}</ul>` : ''}
    ${errs.length ? `<p><b>${pl(errs.length, 'row', 'rows')} ${dry ? 'would be' : errs.length === 1 ? 'was' : 'were'} skipped:</b></p><ul>${errs.slice(0, 50).map((e) => `<li>Spreadsheet row ${e.sheet}: ${esc(e.error)}</li>`).join('')}</ul>${errs.length > 50 ? `<small class="hint">and ${errs.length - 50} more</small>` : ''}` : ''}</div>`;
  if (!dry) { await loadStages(true); toast('Import finished'); IMP.skip = new Set(); }
  if ($('#imFile')) $('#imFile').disabled = false;
  drawImport(html);
  bindUndo($('#imRes'));
  if (!dry) drawImportHistory();
}
const IMP_KIND = { contacts: 'Import', 'contacts:fill': 'Import and Update (fill in blanks)', 'contacts:overwrite': 'Import and Update (overwrite)' };
function undoSummary(r) {
  if (!r) return '';
  const pl = (n, a, b) => `${n} ${n === 1 ? a : b}`, bits = [];
  if (r.restored) bits.push(`${pl(r.restored, 'record', 'records')} put back`);
  if (r.archived) bits.push(`${pl(r.archived, 'new record', 'new records')} archived`);
  if (r.fields_kept) bits.push(`${pl(r.fields_kept, 'field', 'fields')} kept because someone edited ${r.fields_kept === 1 ? 'it' : 'them'} after the import`);
  if (r.notes_left || r.links_left) bits.push(`${[r.notes_left ? pl(r.notes_left, 'note', 'notes') : '', r.links_left ? pl(r.links_left, 'contact link', 'contact links') : ''].filter(Boolean).join(' and ')} added to existing records ${r.notes_left + r.links_left === 1 ? 'was' : 'were'} left in place`);
  return bits.join(', ') || 'Nothing needed changing';
}
async function drawImportHistory() {
  const el = $('#imHist'); if (!el) return;
  const { data, error } = await sb.rpc('import_history');
  if (error) { el.innerHTML = ''; return; }
  const list = data || [];
  if (!list.length) { el.innerHTML = ''; return; }
  const sum = (s = {}) => { const pl = (n, a, b) => `${n} ${n === 1 ? a : b}`; return [s.orgs_new ? pl(s.orgs_new, 'new organization', 'new organizations') : '', s.people_new ? pl(s.people_new, 'new contact', 'new contacts') : '',
    s.orgs_updated || s.people_updated ? pl((s.orgs_updated || 0) + (s.people_updated || 0), 'record updated', 'records updated') : ''].filter(Boolean).join(', ') || `${s.rows || 0} rows`; };
  el.innerHTML = `<div class="card"><h2>Recent imports</h2><small class="hint" style="margin:-4px 0 10px">The person who ran an import, or an admin, can undo it for 48 hours. Undo puts updated fields back (unless someone changed that field since) and archives the records the import added.</small>
    ${list.map((b) => `<div class="imhist"><div style="flex:1;min-width:0"><b>${esc(b.file || 'Spreadsheet')}</b><br>
        <small>${esc(IMP_KIND[b.kind] || b.kind)} · ${esc(fmtDate(b.at))} by ${esc(b.by || 'someone')} · ${esc(sum(b.summary))}</small>
        ${b.undone_at ? `<br><small><b>Undone</b> ${esc(fmtDate(b.undone_at))}${b.undone_by ? ' by ' + esc(b.undone_by) : ''}: ${esc(undoSummary(b.undo_result))}</small>` : ''}</div>
      ${b.can_undo ? `<button class="btn secondary small" data-imundo="${b.id}">Undo</button>` : b.undone_at ? '<span class="badge">Undone</span>' : new Date(b.undo_until) < new Date() ? '<small class="hint" style="margin:0">Undo window closed</small>' : ''}</div>`).join('')}</div>`;
  bindUndo(el);
}
function bindUndo(root) {
  if (!root) return;
  root.querySelectorAll('[data-imundo]').forEach((btn) => (btn.onclick = async () => {
    if (!confirm('Undo this import? Updated records go back to how they were, unless someone changed a field since, and the records it added are archived. You can restore archived records later.')) return;
    btn.disabled = true;
    const { data, error } = await sb.rpc('import_undo', { p_batch: btn.dataset.imundo });
    if (error) { btn.disabled = false; return fail(error); }
    toast('Import undone: ' + undoSummary(data));
    $$('#imRes [data-imundo]').forEach((b) => b.closest('.actions')?.replaceWith(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'Undone: ' + undoSummary(data) })));
    refreshCounts();
    drawImportHistory();
  }));
}
function dupPanelHTML() {
  const ds = IMP.dupes || [], n = ds.length, picked = ds.filter((d) => IMP.dskip.has(d.idx)).length;
  const label = (d) => { const r = impRows()[d.idx] || {}; return r.org_name || [r.first_name, r.last_name].filter(Boolean).join(' ') || r.full_name || r.email || 'This row'; };
  return `<div class="imsum warn"><b>Heads up: ${n} ${n === 1 ? 'row looks' : 'rows look'} like ${n === 1 ? 'a duplicate' : 'duplicates'}${(IMP.kind || 'contacts') !== 'contacts' ? ' but didn\'t match closely enough to update' : ''}.</b>
    <p class="hint" style="margin:4px 0 8px">Nothing has been saved yet. Ticked rows will be skipped. Untick any you want imported anyway; those get flagged in Review for an admin.</p>
    <label class="check" style="margin:0 0 6px"><input type="checkbox" id="imDupAllBox" ${picked === n ? 'checked' : ''}> Skip all ${n}</label>
    <div class="imduplist">${ds.map((d) => `<label class="check"><input type="checkbox" data-dskip="${d.idx}" ${IMP.dskip.has(d.idx) ? 'checked' : ''}>
      <span><b>Row ${d.sheet}: ${esc(label(d))}</b><br><small>Looks like ${esc(d.matches.join('; '))}</small></span></label>`).join('')}</div>
    <div class="actions"><button class="btn" id="imDupGo">${picked ? `Skip ${picked} and import the rest` : 'Import all rows'}</button>
      ${picked ? '<button class="btn secondary" id="imDupAll">Import everything anyway</button>' : ''}<button class="btn ghost" id="imDupX">Cancel</button></div></div>`;
}
function bindDupPanel() {
  if (!$('#imDupGo')) return;
  const redraw = () => { $('#imRes').innerHTML = dupPanelHTML(); bindDupPanel(); };
  $$('[data-dskip]').forEach((c) => (c.onchange = () => { const i = +c.dataset.dskip; c.checked ? IMP.dskip.add(i) : IMP.dskip.delete(i); redraw(); }));
  $('#imDupAllBox').onchange = (e) => { IMP.dskip = e.target.checked ? new Set(IMP.dupes.map((d) => d.idx)) : new Set(); redraw(); };
  $('#imDupGo').onclick = () => { IMP.skip = new Set([...(IMP.skip || []), ...IMP.dskip]); IMP.dupes = null; runImport(false); };
  if ($('#imDupAll')) $('#imDupAll').onclick = () => { IMP.dupes = null; runImport(false); };
  $('#imDupX').onclick = () => { IMP.dupes = null; drawImport(); };
}

const GELP_TENANT = '00000000-0000-0000-0000-000000000001'; // GELP's agency account (one white label, not the top)
const LNP_TENANT = '00000000-0000-0000-0000-000000000002'; // LNP Platforms, the top of the platform
// email someone their invite (branded by the account's white label). Returns true when it went out.
async function sendInvite(tenantId, email, quiet = false) {
  const { error } = await sb.functions.invoke('invite-email', { body: { tenant_id: tenantId, email } });
  if (error) { if (!quiet) fail(error); return false; }
  return true;
}
const isPlatformAdmin = () => atAgencyHome();
const SITE_STATUS = { planned: 'Planned', in_build: 'In build', review: 'In review', live: 'Live', paused: 'Paused' };
const siteBadge = (st) => `<span class="badge ${st === 'live' ? 'ok' : st === 'paused' ? 'due' : st === 'review' ? 'gold' : ''}">${SITE_STATUS[st] || st}</span>`;
async function viewSites(main) {
  const [{ data: sites, error }, { data: reqs }, { data: forms }] = await Promise.all([
    sb.from('sites').select('*').eq('tenant_id', S.acct?.id || S.me.tenant_id).order('created_at'),
    sb.rpc('site_requests'),
    sb.from('site_forms').select('id,site_id,name,share_tenant_ids,active').eq('tenant_id', S.acct?.id || S.me.tenant_id).order('created_at'),
  ]);
  if (error) throw error;
  main.innerHTML = `<h1>Sites</h1><p class="hint" style="margin:-6px 0 12px">Your websites and funnels. Tap one to see it, copy its link to share, or ask for a change and we'll handle it.</p>
    <div class="sitegrid">${(sites || []).map((x) => `<div class="card site"><div class="toolbar"><b style="flex:1">${esc(x.name)}</b>${siteBadge(x.status)}</div>
        <small class="hint" style="margin:0">${x.kind === 'funnel' ? 'Funnel' : 'Website'}${x.domain ? ' · ' + esc(x.domain) : ''}</small>
        ${x.url && /^https?:\/\//i.test(x.url) ? `<button type="button" class="sitethumb" data-view="${esc(x.url)}" data-vname="${esc(x.name)}" aria-label="View ${esc(x.name)}"><span class="stfall">${esc(x.name)}<br><small>Tap to view</small></span><iframe src="${esc(x.url)}" loading="lazy" tabindex="-1" aria-hidden="true" title=""></iframe></button>
          <div class="quick" style="margin:0"><button type="button" class="btn small" data-view="${esc(x.url)}" data-vname="${esc(x.name)}">View ${x.status === 'live' ? 'site' : 'preview'}</button><a class="btn ghost small" href="${esc(x.url)}" target="_blank" rel="noopener">New tab ↗</a><button type="button" class="btn ghost small" data-copyurl="${esc(x.url)}">Copy link</button></div>`
          : '<small class="hint" style="margin:0">Your site link shows here as soon as we publish a preview.</small>'}
        ${(forms || []).filter((fm) => fm.site_id === x.id).map((fm) => `<div class="sform"><b>${esc(fm.name)}</b>${fm.active ? '' : ' <span class="badge">Off</span>'}
          <small>Leads go to your ${esc(S.acct?.name || 'account')} Lead stage${fm.share_tenant_ids.length ? `. Also shared with ${fm.share_tenant_ids.length === 1 ? 'one other company' : fm.share_tenant_ids.length + ' other companies'}, set by GELP. The form names every company that receives the information` : ''}.</small>
          <details data-wording="${fm.id}"><summary>Fine print and terms wording</summary><div class="wording">Loading…</div></details></div>`).join('')}
        <div class="reqbox" data-req="${x.id}" hidden><textarea placeholder="What would you like changed?" aria-label="Change request for ${esc(x.name)}"></textarea>
          <div class="actions" style="margin:0"><button class="btn small" data-reqsend="${x.id}">Send request</button><button class="btn ghost small" data-reqx="${x.id}">Cancel</button></div></div>
        <button class="btn secondary small" data-reqopen="${x.id}">Request a change</button></div>`).join('')
      || '<div class="card"><p class="empty" style="margin:0">No sites yet. When we build your website or a funnel, it shows up here so you can look at it, copy its link and ask for changes.</p></div>'}</div>
    ${(reqs || []).length ? `<div class="card"><h2>Your change requests</h2>${reqs.map((r) => `<div class="req"><div class="toolbar"><b style="flex:1">${esc(r.site || 'Site')}</b><span class="badge ${r.status === 'open' ? 'gold' : 'ok'}">${r.status === 'open' ? 'Open' : 'Done'}</span></div>
        <small class="hint" style="margin:0">Requested by ${esc(r.by || '')} · ${esc(fmtDate(r.at))}</small>
        <div class="ibmsgs" style="background:none;padding:6px 0;max-height:none">${(r.messages || []).map((m) => `<div class="ibm ${m.from === 'staff' ? 'them' : 'me'}">${esc(m.body).replace(/\n/g, '<br>')}<small>${m.from === 'staff' ? esc(m.name || 'GELP') + ' · ' : ''}${esc(new Date(m.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</small></div>`).join('')}</div>
        <div class="ibcompose" style="padding:0;border:0"><textarea data-rtext="${r.id}" placeholder="Reply" aria-label="Reply"></textarea><button class="btn small" data-rsend="${r.id}">Send</button></div></div>`).join('')}</div>` : ''}
    ${isPlatformAdmin() ? '<div id="siteAdmin"><p class="empty">Loading accounts…</p></div>' : ''}`;
  $$('[data-reqopen]').forEach((b) => (b.onclick = () => { const box = $(`[data-req="${b.dataset.reqopen}"]`); box.hidden = false; b.hidden = true; $('textarea', box).focus(); }));
  $$('[data-reqx]').forEach((b) => (b.onclick = () => { $(`[data-req="${b.dataset.reqx}"]`).hidden = true; $(`[data-reqopen="${b.dataset.reqx}"]`).hidden = false; }));
  $$('[data-reqsend]').forEach((b) => (b.onclick = async () => {
    const body = $('textarea', $(`[data-req="${b.dataset.reqsend}"]`)).value.trim(); if (body.length < 3) return toast('Describe the change you need');
    b.disabled = true;
    const { error: e } = await sb.rpc('site_request', { p_site: b.dataset.reqsend, p_body: body });
    b.disabled = false; if (e) return fail(e);
    toast('Request sent. Your account manager and developer have it.'); viewSites(main);
  }));
  $$('[data-rsend]').forEach((b) => (b.onclick = async () => {
    const ta = $(`[data-rtext="${b.dataset.rsend}"]`), body = ta.value.trim(); if (!body) return;
    b.disabled = true; const { error: e } = await sb.rpc('site_request_reply', { p_thread: b.dataset.rsend, p_body: body }); b.disabled = false;
    if (e) return fail(e); toast('Sent'); viewSites(main);
  }));
  wireWording(main);
  $$('[data-view]', main).forEach((b) => (b.onclick = () => openViewer(b.dataset.view, b.dataset.vname)));
  $$('[data-copyurl]', main).forEach((b) => (b.onclick = () => navigator.clipboard.writeText(b.dataset.copyurl).then(() => toast('Link copied'), () => toast('Select the link to copy it'))));
  if (isPlatformAdmin()) siteAdmin($('#siteAdmin'));
}
// fine print shown under the form + a clause for the site's terms of service (names every company that receives the lead)
function wireWording(root) {
  $$('[data-wording]', root).forEach((d) => (d.ontoggle = async () => {
    if (!d.open || d.dataset.done) return;
    const { data, error } = await sb.rpc('form_details', { p_form: d.dataset.wording });
    const box = $('.wording', d); if (error || !data) { box.textContent = 'Could not load the wording.'; return; }
    d.dataset.done = '1';
    box.innerHTML = `<small class="hint" style="margin:0">Receives the information: ${data.group ? esc(data.group) + ', which is ' : ''}${esc(listNames(data.recipients_with_roles || data.recipients || []))}</small>
      <label class="label">Fine print under the form</label><p class="quote">${esc(data.fine_print)}</p>
      ${data.consent_label ? `<label class="label">Required checkbox</label><p class="quote">☐ ${esc(data.consent_label)}</p>` : ''}
      <label class="label">Add to the site's terms of service</label><p class="quote">${esc(data.terms_clause)}</p>
      <button type="button" class="btn ghost small" data-copyterms>Copy terms wording</button>`;
    $('[data-copyterms]', box).onclick = () => navigator.clipboard.writeText(data.terms_clause).then(() => toast('Copied'), () => toast('Select the text to copy it'));
  }));
}
const listNames = (a) => a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
async function siteAdmin(box) {
  const [{ data: accts }, { data: all }, { data: forms }] = await Promise.all([
    sb.from('tenants').select('id,name,slug,account_manager_id,developer_id').order('name'),
    sb.from('sites').select('*').order('created_at'),
    sb.from('site_forms').select('*').order('created_at'),
  ]);
  const formHTML = (fm, a) => `<div class="sform admin" data-form="${fm.id}">
      <div class="toolbar"><input type="text" data-ff="name" value="${esc(fm.name)}" aria-label="Form name" style="flex:1;max-width:280px">
        <label class="check"><input type="checkbox" data-ff="active" ${fm.active ? 'checked' : ''}> On</label></div>
      <small class="hint" style="margin:4px 0 2px">Leads always go to ${esc(a.name)}. Share the same lead with:</small>
      <div class="chips">${(accts || []).filter((o) => o.id !== a.id).map((o) => `<label class="check"><input type="checkbox" data-share="${o.id}" ${fm.share_tenant_ids.includes(o.id) ? 'checked' : ''}> ${esc(o.name)}</label>`).join('') || '<small class="hint">No other accounts yet.</small>'}</div>
      ${fm.share_tenant_ids.length ? `<small class="hint" style="margin:2px 0"><b>Sharing is on.</b> The form names every company and the visitor has to tick the box. Put the terms wording on the site too.</small>
        <div class="row"><div><label class="label">Group name for the checkbox (optional)</label><input type="text" data-ff="share_group_name" value="${esc(fm.share_group_name || '')}" placeholder="the Acme partner group" maxlength="80"></div><div></div></div>
        <label class="label">Each company's role (shown in the fine print and terms, optional)</label>
        <div class="roles">${[a.id, ...fm.share_tenant_ids].map((tid) => { const o = (accts || []).find((x) => x.id === tid); return o ? `<label class="rolein"><span>${esc(o.name)}</span><input type="text" data-role="${tid}" value="${esc((fm.recipient_roles || {})[tid] || '')}" placeholder="e.g. the manufacturer" maxlength="60"></label>` : ''; }).join('')}</div>` : ''}
      <label class="label">Embed code</label><code class="embed">&lt;script src="${esc(S.pub())}/forms/form.js" data-form="${esc(fm.form_key)}" async&gt;&lt;/script&gt;</code>
      <details data-wording="${fm.id}"><summary>Fine print and terms wording</summary><div class="wording">Loading…</div></details></div>`;
  const team = staff().filter((u) => u.tenant_id === GELP_TENANT || (u.member && S.acct?.is_gelp));
  const pick = (id, field, cur, label) => `<label class="label" style="margin:0">${label}<select data-acct="${id}" data-field="${field}"><option value="">Not assigned</option>${team.map((u) => `<option value="${u.id}" ${u.id === cur ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}</select></label>`;
  box.innerHTML = `<h2 style="margin-top:22px">Manage hosted sites <small class="hint" style="display:inline">GELP admins only</small></h2>
    <div class="card"><b>Developers</b><small class="hint" style="margin:2px 0 6px">Developers get every request when the assigned developer hasn't replied in one business day.</small>
      <div class="chips">${team.map((u) => `<label class="check"><input type="checkbox" data-dev="${u.id}" ${u.is_developer ? 'checked' : ''}> ${esc(u.full_name)}</label>`).join('')}</div></div>
    ${(accts || []).map((a) => `<div class="card"><div class="toolbar"><h2 style="margin:0;flex:1">${esc(a.name)}</h2><button type="button" class="btn ghost small" data-chatcode="${esc(a.slug)}" title="Copies the line to paste into this account's website footer">Copy chat code</button></div>
      <div class="row">${pick(a.id, 'account_manager_id', a.account_manager_id, 'Account manager')}${pick(a.id, 'developer_id', a.developer_id, 'Developer')}</div>
      ${(all || []).filter((x) => x.tenant_id === a.id).map((x) => `<div class="siterow" data-site="${x.id}">
        <input type="text" data-sf="name" value="${esc(x.name)}" aria-label="Site name"><select data-sf="kind" aria-label="Kind"><option value="site" ${x.kind === 'site' ? 'selected' : ''}>Website</option><option value="funnel" ${x.kind === 'funnel' ? 'selected' : ''}>Funnel</option></select>
        <input type="url" data-sf="url" value="${esc(x.url || '')}" placeholder="https://… link" aria-label="Link"><input type="text" data-sf="domain" value="${esc(x.domain || '')}" placeholder="Domain" aria-label="Domain">
        <select data-sf="status" aria-label="Status">${Object.entries(SITE_STATUS).map(([k, l]) => `<option value="${k}" ${x.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="siteforms">${(forms || []).filter((fm) => fm.site_id === x.id).map((fm) => formHTML(fm, a)).join('')}
          <button class="btn ghost small" data-addform="${x.id}">+ Add a form to ${esc(x.name)}</button></div>`).join('') || '<p class="empty" style="padding:6px 0">No sites for this account yet.</p>'}
      <button class="btn ghost small" data-addsite="${a.id}">+ Add site or funnel</button></div>`).join('')}`;
  $$('[data-chatcode]', box).forEach((b) => (b.onclick = async () => {
    const code = `<script src="${S.pub()}/chat/widget.js" data-account="${b.dataset.chatcode}" async></script>`;
    try { await navigator.clipboard.writeText(code); toast('Chat code copied. Paste it into the site\'s footer code.'); } catch { prompt('Copy this into the site\'s footer code:', code); }
  }));
  $$('[data-acct]', box).forEach((s) => (s.onchange = async () => {
    const { error } = await sb.from('tenants').update({ [s.dataset.field]: s.value || null }).eq('id', s.dataset.acct);
    error ? fail(error) : toast('Saved');
  }));
  $$('[data-dev]', box).forEach((c) => (c.onchange = async () => {
    const { error } = await sb.from('app_users').update({ is_developer: c.checked }).eq('id', c.dataset.dev);
    if (error) { c.checked = !c.checked; return fail(error); }
    const u = S.users.find((x) => x.id === c.dataset.dev); if (u) u.is_developer = c.checked; toast('Saved');
  }));
  $$('[data-site] [data-sf]', box).forEach((el) => (el.onchange = async () => {
    const id = el.closest('[data-site]').dataset.site, v = el.value.trim();
    if (el.dataset.sf === 'name' && !v) return toast('A site needs a name');
    if (el.dataset.sf === 'url' && v && !/^https?:\/\//i.test(v)) return toast('Links start with https://');
    const { error } = await sb.from('sites').update({ [el.dataset.sf]: v || null, updated_at: new Date().toISOString() }).eq('id', id);
    error ? fail(error) : toast('Saved');
  }));
  $$('[data-addform]', box).forEach((b) => (b.onclick = async () => {
    const { error } = await sb.from('site_forms').insert({ site_id: b.dataset.addform, name: 'Contact form' });
    if (error) return fail(error); toast('Form added'); siteAdmin(box);
  }));
  $$('[data-form] [data-ff]', box).forEach((el) => (el.onchange = async () => {
    const id = el.closest('[data-form]').dataset.form, v = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (el.dataset.ff === 'name' && !v) return toast('A form needs a name');
    if (el.dataset.ff === 'share_group_name' && v && v.length < 2) return toast('Use at least two letters');
    const { error } = await sb.from('site_forms').update({ [el.dataset.ff]: el.dataset.ff === 'share_group_name' ? v || null : v }).eq('id', id);
    if (error) return fail(error); toast('Saved'); if (el.dataset.ff !== 'active') $$(`[data-form="${id}"] [data-wording]`, box).forEach((d) => { delete d.dataset.done; d.open = false; });
  }));
  $$('[data-form] [data-role]', box).forEach((el) => (el.onchange = async () => {
    const card = el.closest('[data-form]'), roles = {};
    $$('[data-role]', card).forEach((x) => { if (x.value.trim()) roles[x.dataset.role] = x.value.trim(); });
    const { error } = await sb.from('site_forms').update({ recipient_roles: roles }).eq('id', card.dataset.form);
    if (error) return fail(error); toast('Saved'); $$('[data-wording]', card).forEach((d) => { delete d.dataset.done; d.open = false; });
  }));
  $$('[data-form] [data-share]', box).forEach((c) => (c.onchange = async () => {
    const card = c.closest('[data-form]'), ids = $$('[data-share]', card).filter((x) => x.checked).map((x) => x.dataset.share);
    const { error } = await sb.from('site_forms').update({ share_tenant_ids: ids }).eq('id', card.dataset.form);
    if (error) { c.checked = !c.checked; return fail(error); }
    toast(ids.length ? 'Sharing saved. The form now names every company.' : 'Sharing off. Leads go only to this account.'); siteAdmin(box);
  }));
  wireWording(box);
  $$('[data-addsite]', box).forEach((b) => (b.onclick = async () => {
    const { error } = await sb.from('sites').insert({ tenant_id: b.dataset.addsite, name: 'New site', kind: 'site', status: 'in_build' });
    if (error) return fail(error); siteAdmin(box);
  }));
}

/* ================= chat inbox ================= */
// While the CRM is open, a heartbeat every minute marks you online, so chat widgets show "Agent online".
function startHeartbeat() {
  if (S.hb || !S.me?.active || S.me.role === 'vendor' || S.me.role === 'member') return;
  const beat = async () => {
    if (document.hidden) return;
    const [{ data }] = await Promise.all([sb.rpc('chat_heartbeat'), loadPresence()]);
    const n = Number(data?.unread || 0);
    if (n > (S.counts.chats || 0) && S.view !== 'inbox') toast('New chat message. Open the Inbox to reply.');
    const tc = S.counts.teamchat || 0;
    S.counts.chats = n; S.counts.inboxAll = n + tc; setTitleCount(n + tc);
    ['chats', 'teamchat', 'inboxAll'].forEach((k) => $$(`[data-count="${k}"]`).forEach((el) => { el.textContent = S.counts[k] || ''; el.hidden = !S.counts[k]; }));
  };
  S.hb = setInterval(beat, 60_000); beat();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) beat(); });
}
const SRC = { website: 'Website', proposal: 'Proposal page', invoice: 'Invoice', directory: 'Directory listing', other: 'Chat', portal: 'Client portal' };
const srcOf = (t) => (t.source_ref === 'portal' ? 'portal' : t.listing_id ? 'directory' : t.source);
async function viewInbox(main) {
  const f = recall('inboxFilter', { status: 'open' });
  let sel = S.param || null, lastSig = '';
  main.innerHTML = `<div class="toolbar"><h1 style="margin:0;flex:1">Inbox</h1>
      <div class="seg" id="ibSeg">${[['open', 'Open'], ['closed', 'Closed'], ['', 'All']].map(([k, l]) => `<button type="button" data-st="${k}" class="${f.status === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    ${isFree() ? `<div class="banner gold freead"><span>Chats from your directory listing land here. You show as online while this is open, and anything you miss comes to you by email. <b>Want this same live chat on your own website?</b></span> <a class="btn small" href="${UPGRADE_URL}" target="_blank" rel="noopener">Get it for your site</a></div>`
      : '<small class="hint" style="margin:-6px 0 10px">Chats from the website, proposal pages and invoices. You show as "Agent online" while the CRM is open.</small>'}
    <div class="inbox ${sel ? 'has-sel' : ''}"><div class="iblist" id="ibList"><p class="empty">Loading…</p></div><div class="ibthread" id="ibThread"></div></div>`;
  $$('#ibSeg [data-st]').forEach((b) => (b.onclick = () => { f.status = b.dataset.st; store('inboxFilter', f); lastSig = ''; loadList(); $$('#ibSeg [data-st]').forEach((x) => x.classList.toggle('on', x === b)); }));
  const ago = (s) => { const m = Math.round((Date.now() - new Date(s)) / 60000); return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : fmtDate(s); };
  async function loadList() {
    let q = divQ(sb.from('chat_threads').select('id,visitor_name,visitor_email,source,source_ref,listing_id,status,unread_staff,last_message_at,company_id,kind,priority,escalated_at,companies(name),sites(name)')
      ).order('last_message_at', { ascending: false }).limit(100);
    if (f.status) q = q.eq('status', f.status);
    const { data, error } = await q;
    if (error) return fail(error);
    const sig = JSON.stringify(data) + sel; if (sig === lastSig) return; lastSig = sig;
    $('#ibList').innerHTML = (data || []).map((t) => `<button type="button" class="ibitem ${t.id === sel ? 'on' : ''} ${t.unread_staff ? 'unread' : ''}" data-th="${t.id}">
        <b>${esc(t.visitor_name || 'Visitor')}</b><span class="when">${esc(ago(t.last_message_at))}</span>
        <small>${t.kind === 'support' ? `<span class="badge ${t.priority === 'urgent' ? 'warn' : 'gold'}">${t.priority === 'urgent' ? 'Urgent support' : 'Support'}</span> ${esc(t.visitor_name || '')}` : t.kind === 'dev_request' ? `<span class="badge gold">Dev request</span> ${esc(t.sites?.name || '')}${t.escalated_at ? ' · escalated' : ''}` : esc([t.companies?.name, SRC[srcOf(t)]].filter(Boolean).join(' · '))}</small></button>`).join('')
      || `<p class="empty">No ${f.status || ''} chats yet. ${isFree() ? 'When someone chats from your listing, it shows up here.' : 'Add the chat widget to a site to start getting them.'}</p>`;
    $$('#ibList [data-th]').forEach((b) => (b.onclick = () => { const was = sel; sel = b.dataset.th; if (was) history.replaceState({ d: depth(), sub: history.state?.sub }, '', '#inbox/' + sel); else pushSub('#inbox/' + sel); $('.inbox').classList.add('has-sel'); lastSig = ''; loadList(); loadThread(true); }));
  }
  let threadSig = '';
  async function loadThread(fresh) {
    const box = $('#ibThread');
    if (!sel) { box.innerHTML = '<p class="empty" style="padding:30px">Pick a conversation.</p>'; return; }
    const [{ data: t }, { data: msgs }] = await Promise.all([
      sb.from('chat_threads').select('*, companies(name), sites(name,url)').eq('id', sel).maybeSingle(),
      sb.from('chat_messages').select('id,sender,staff_id,body,created_at,emailed_at').eq('thread_id', sel).order('created_at'),
    ]);
    if (!t) { box.innerHTML = '<p class="empty" style="padding:30px">That conversation isn\'t here.</p>'; return; }
    if (t.unread_staff) { await sb.from('chat_threads').update({ unread_staff: false }).eq('id', t.id); refreshCounts(); lastSig = ''; loadList(); }
    const here = t.visitor_seen_at && Date.now() - new Date(t.visitor_seen_at) < 45_000;
    const sig = JSON.stringify([t.status, t.company_id, here, msgs]);
    if (!fresh && sig === threadSig) return; threadSig = sig;
    const draft = $('#ibText')?.value || '', hadFocus = document.activeElement?.id === 'ibText';
    box.innerHTML = `<div class="ibhead"><button type="button" class="btn ghost small ibback" id="ibBack">← Back</button>
        <div style="flex:1;min-width:0"><b>${esc(t.visitor_name || 'Visitor')}</b>
          <small>${t.visitor_email ? `<a href="mailto:${esc(t.visitor_email)}">${esc(t.visitor_email)}</a> · ` : ''}${t.chat_mode === 'message' ? '<span class="badge gold">Left a message</span> · ' : ''}${esc(SRC[srcOf(t)] || 'Chat')}${t.page_url && /^https:\/\//i.test(t.page_url) ? ` · <a href="${esc(t.page_url)}" target="_blank" rel="noopener">page</a>` : ''}
          · <span class="${here ? 'ok' : ''}">${t.kind === 'dev_request' ? 'Replies show on their Sites page and go to their email.' : here ? 'On the page now' : 'Not on the page. Replies go to their email.'}</span></small>
          ${t.kind === 'dev_request' ? `<small><span class="badge gold">Dev request</span> ${esc(t.sites?.name || 'Site')}${t.sites?.url ? ` · <a href="${esc(t.sites.url)}" target="_blank" rel="noopener">open site</a>` : ''}${t.escalated_at ? ' · <span class="badge due">Escalated</span>' : t.dev_responded_at ? ' · developer replied' : ' · waiting on the developer'}</small>` : ''}</div>
        <button type="button" class="btn ghost small" id="ibStatus">${t.status === 'open' ? 'Close' : 'Reopen'}</button></div>
      <div class="iborg" id="ibOrg">${t.company_id ? `Organization: <button type="button" class="linkish" id="ibOrgGo">${esc(t.companies?.name || 'Open')}</button> <button type="button" class="linkish" id="ibOrgX">Change</button>` : '<button type="button" class="linkish" id="ibOrgX">Link to an organization</button>'}</div>
      <div class="ibmsgs" id="ibMsgs">${(msgs || []).map((m) => `<div class="ibm ${m.sender === 'staff' ? 'me' : 'them'}">${esc(m.body).replace(/\n/g, '<br>')}
        <small>${m.sender === 'staff' ? esc(userName(m.staff_id) || 'Team') + ' · ' : ''}${esc(new Date(m.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}${m.emailed_at && m.sender === 'staff' ? ' · emailed' : ''}</small></div>`).join('')}</div>
      <div class="ibcompose"><textarea id="ibText" placeholder="Type a reply. Enter sends, Shift+Enter for a new line." aria-label="Reply">${esc(draft)}</textarea><button type="button" class="btn gold" id="ibSend">Send</button></div>`;
    const ms = $('#ibMsgs'); ms.scrollTop = ms.scrollHeight;
    GRW.chatTools(box, t).catch(() => {});
    $('#ibBack').onclick = () => { sel = null; leaveSub('#inbox'); $('.inbox').classList.remove('has-sel'); lastSig = ''; loadList(); loadThread(); };
    $('#ibStatus').onclick = async () => { const { error } = await sb.from('chat_threads').update({ status: t.status === 'open' ? 'closed' : 'open' }).eq('id', t.id); if (error) return fail(error); lastSig = ''; loadList(); loadThread(true); };
    const og = $('#ibOrgGo'); if (og) og.onclick = () => go('org', t.company_id);
    $('#ibOrgX').onclick = () => {
      $('#ibOrg').innerHTML = `<input type="search" id="ibOrgQ" placeholder="Search organizations" autocomplete="off"><div id="ibOrgR"></div>`;
      const run = debounce(async () => {
        const term = clean($('#ibOrgQ').value); if (!term) { $('#ibOrgR').innerHTML = ''; return; }
        const { data } = await sb.from('companies').select('id,name,city,state').is('archived_at', null).ilike('name', `%${term}%`).order('name').limit(8);
        $('#ibOrgR').innerHTML = `<div class="results">${(data || []).map((o) => `<button type="button" class="result" data-oid="${o.id}"><b>${esc(o.name)}</b><small>${esc([o.city, o.state].filter(Boolean).join(', '))}</small></button>`).join('') || '<p class="empty" style="padding:10px">No match.</p>'}</div>`;
        $$('#ibOrgR [data-oid]').forEach((b) => (b.onclick = async () => { const { error } = await sb.from('chat_threads').update({ company_id: b.dataset.oid }).eq('id', t.id); if (error) return fail(error); toast('Linked'); lastSig = ''; loadList(); loadThread(true); }));
      });
      $('#ibOrgQ').oninput = run; $('#ibOrgQ').focus();
    };
    const send = async () => {
      const ta = $('#ibText'), body = ta.value.trim(); if (!body) return;
      const b = $('#ibSend'); b.disabled = true;
      const { data, error } = await sb.rpc('chat_reply', { p_thread: t.id, p_body: body });
      b.disabled = false;
      if (error) return fail(error);
      ta.value = ''; await loadThread(true); lastSig = ''; loadList();
      if (!data?.visitor_here) {
        const { data: em, error: ee } = await sb.functions.invoke('chat-email', { body: { kind: 'reply', thread_id: t.id } });
        if (em?.emailed) toast(`They've left the page, so your reply was emailed to ${em.emailed}`);
        else if (ee || em?.error) toast('Reply saved, but the email didn\'t go out. They\'ll see it next time they open the chat.');
      }
    };
    $('#ibSend').onclick = send;
    $('#ibText').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    if (fresh || hadFocus) { const ta = $('#ibText'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
  await loadList(); await loadThread(true);
  S.inboxTimer = setInterval(() => { if (!document.hidden && S.view === 'inbox') { loadList(); if (sel) loadThread(false); } }, 4000);
}

/* ================= TEAM: profiles and team chat (inside the Inbox tab) ================= */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const TZS = [['', 'Not set'], ['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'], ['America/Phoenix', 'Arizona'],
  ['America/Los_Angeles', 'Pacific'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii']];
const bdayLabel = (u) => (u.birthday_month && u.birthday_day ? `${MONTHS[u.birthday_month - 1]} ${u.birthday_day}` : '');
const tzLabel = (z) => TZS.find((x) => x[0] === z)?.[1] || z || '';
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
// who's in the CRM right now: green dot = active in the last 2 minutes (the heartbeat stamps every minute while the CRM is open)
S.presence = S.presence || {};
async function loadPresence() {
  const { data, error } = await sb.rpc('team_presence'); if (error || !Array.isArray(data)) return;
  S.presence = Object.fromEntries(data.map((x) => [x.id, x]));
}
const isOnline = (id) => !!S.presence[id]?.online;
const seenLabel = (id) => {
  const p = S.presence[id]; if (!p) return '';
  if (p.online) return 'Online';
  if (!p.last_seen_at) return 'Offline';
  const m = Math.round((Date.now() - new Date(p.last_seen_at)) / 60000);
  return 'Last seen ' + (m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' hr ago' : fmtDate(p.last_seen_at));
};
const odot = (id) => S.presence[id] ? `<span class="odot ${isOnline(id) ? 'on' : ''}" title="${esc(seenLabel(id))}"></span>` : '';
const avatar = (u, big) => `<span class="tavatar ${big ? 'big' : ''}" aria-hidden="true">${esc(initials(u?.full_name))}${u?.id ? odot(u.id) : ''}</span>`;
function birthdaysSoon(days = 7) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return staff().filter((u) => u.birthday_month && u.birthday_day).map((u) => {
    let d = new Date(now.getFullYear(), u.birthday_month - 1, u.birthday_day);
    if (u.birthday_month === 2 && u.birthday_day === 29 && d.getMonth() !== 1) d = new Date(now.getFullYear(), 1, 28);   // Feb 29 shows on the 28th in other years
    if (d < now) d = new Date(now.getFullYear() + 1, u.birthday_month - 1, u.birthday_day);
    return { u, inDays: Math.round((d - now) / 86400000) };
  }).filter((x) => x.inDays <= days).sort((a, b) => a.inDays - b.inDays);
}
async function reloadUsers() {
  await loadUsers();
  const me = (S.users || []).find((u) => u.id === S.me.id); if (me) Object.assign(S.me, me);
}

async function viewTeamDir(main) {
  await reloadUsers();
  // logins kept out of the team (like System Admin) don't show here
  const people = staff().filter((u) => !u.hidden_in_team || u.id === S.me.id).sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
  const sel = S.param && people.find((u) => u.id === S.param) ? S.param : null;
  main.innerHTML = `<h1>Team</h1>
    <div class="teamgrid">${people.map((u) => `<button type="button" class="card tcard ${u.id === sel ? 'on' : ''}" data-tu="${u.id}">${avatar(u)}
        <span class="tinfo"><b>${esc(u.full_name)}${u.id === S.me.id ? ' <small>(you)</small>' : ''}</b><small>${esc(u.title || (u.is_admin ? 'Admin' : 'Team member'))}</small>
        ${bdayLabel(u) ? `<small>🎂 ${esc(bdayLabel(u))}</small>` : ''}</span></button>`).join('')}</div>
    <div id="tProfile"></div>`;
  $$('[data-tu]').forEach((b) => (b.onclick = () => go('teamdir', b.dataset.tu)));
  if (sel) drawProfile($('#tProfile'), people.find((u) => u.id === sel));
}
/* ---------- connected calendars (yours, on every account you work in) ---------- */
// Paste the secret iCal address of a Google, Outlook or Apple calendar. Every 10 minutes the CRM reads it and blocks
// those times for bookings on every account you're on. Only you see what the events are; everyone else sees busy.
const agoText = (t) => { if (!t) return ''; const m = Math.round((Date.now() - new Date(t)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} days ago`; };
/* ================= My availability (Nov 16): your hours, days off and video link in one place on your profile =================
   Hours and days off are yours across every account (schema/109); the video link is used by video booking calendars (110). */
const hm = (t) => { const [h, m] = String(t).split(':').map(Number); if (h === 24) return '12 AM'; const ap = h < 12 ? 'AM' : 'PM', h12 = h % 12 || 12; return m ? `${h12}:${String(m).padStart(2, '0')} ${ap}` : `${h12} ${ap}`; };
async function myAvail(box) {
  const [{ data: H }, { data: MS }] = await Promise.all([sb.rpc('hours_get', { p_user: S.me.id }),
    sb.from('ms_connections').select('status').eq('user_id', S.me.id).maybeSingle().then((r) => r, () => ({ data: null }))]);
  const msOk = !!MS && MS.status !== 'expired';
  const src = H?.account || H?.user;
  const wk = src?.weekly || { 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']] };
  const DN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = [1, 2, 3, 4, 5, 6, 0].map((d) => `<div class="prow"><span>${DN[d]}</span><div>${(wk[d] || []).length ? wk[d].map((r) => `${hm(r[0])} to ${hm(r[1])}`).join(', ') : '<span class="hint" style="margin:0">Off</span>'}</div></div>`).join('');
  const off = (H?.days || []).slice(0, 3).map((o) => `<div class="prow"><span>${esc(new Date(o.day + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}</span><div>${(o.ranges || []).length ? esc(o.ranges.map((r) => `${hm(r[0])} to ${hm(r[1])}`).join(', ')) : 'Off'}${o.note ? ' · ' + esc(o.note) : ''} <small class="hint" style="display:inline;margin:0">${o.scope === 'user' ? 'everywhere' : 'this account only'}</small></div></div>`).join('');
  const mode = S.me.meeting_mode || 'fixed';
  box.innerHTML = `<div class="card"><h2>My availability</h2>
    <p class="hint">${H?.account ? `${esc(S.acct?.name || 'This account')} uses its own hours for you.` : 'Your usual hours. They apply in every account you work in.'}</p>
    ${days}
    ${off ? `<h3 style="margin:12px 0 4px">Coming up</h3>${off}` : ''}
    <div class="actions"><button class="btn secondary small" id="maHours">Edit hours and days off</button></div>
    <h3 style="margin:16px 0 4px">Video meetings</h3>
    <p class="hint">Video booking calendars use your link when a booking goes to you.</p>
    <label class="label" for="maMode">Meeting links</label><select id="maMode" style="max-width:340px">
      <option value="fixed" ${mode === 'fixed' ? 'selected' : ''}>Use my link</option>
      ${msOk || mode === 'new' ? `<option value="new" ${mode === 'new' ? 'selected' : ''}>A new Teams meeting for every booking</option>` : ''}
      <option value="none" ${mode === 'none' ? 'selected' : ''}>No video link from me</option></select>
    <p class="hint" id="maNewHint" ${mode === 'new' ? '' : 'hidden'}>${msOk ? 'Each booking gets its own Teams meeting from your Microsoft account. The confirmation email waits a moment for the link.' : 'Microsoft is not connected anymore, so bookings say the link will follow. Connect Microsoft again under Calendars, or pick another option.'}</p>
    ${msOk ? '' : '<p class="hint">Want a fresh Teams meeting for every booking? Connect Microsoft 365 under Calendars first.</p>'}
    <div id="maLinkBox" ${mode === 'fixed' ? '' : 'hidden'}><label class="label" for="maLink">My video link (Zoom, Teams, Google Meet)</label>
      <input type="url" id="maLink" maxlength="500" placeholder="https://zoom.us/j/1234567890" value="${esc(S.me.meeting_link || '')}">
      <p class="hint">Using a personal room? Turn on the waiting room in Zoom, so a customer who joins early doesn't walk into someone else's meeting.</p></div>
    <div class="actions"><button class="btn small" id="maSave">Save video meetings</button></div></div>`;
  $('#maHours', box).onclick = () => go('calhours');
  $('#maMode', box).onchange = () => { const v = $('#maMode', box).value; $('#maLinkBox', box).hidden = v !== 'fixed'; $('#maNewHint', box).hidden = v !== 'new'; };
  $('#maSave', box).onclick = async () => {
    const link = $('#maLink', box).value.trim(), m = $('#maMode', box).value;
    if (m === 'fixed' && link && !/^https:\/\/\S+$/.test(link)) return toast('Paste the whole link, starting with https://');
    const { error } = await sb.rpc('my_meeting_save', { p_link: link || null, p_mode: m });
    if (error) return fail(error);
    S.me.meeting_link = link || null; S.me.meeting_mode = m; toast('Saved');
  };
}
async function calFeeds(box) {
  if (!box) return;
  const [{ data: feeds, error }, { data: ms }] = await Promise.all([
    sb.from('cal_feeds').select('id,label,url_hint,last_try_at,last_ok_at,last_error,events,created_at').order('created_at'),
    sb.from('ms_connections').select('email,name,status,last_ok_at,last_error,busy_count').maybeSingle(),
  ]);
  if (error) { box.innerHTML = ''; return; }
  // Microsoft 365: a real connection (busy times every 5 minutes; Teams links and more build on it)
  const msBlock = ms ? `<div class="person-row msrow"><b>Microsoft 365 (Outlook)</b> <small class="hint" style="display:inline;margin:0">${esc(ms.email || '')}</small>
      <div>${ms.status !== 'ok' ? `<span class="badge due">Needs attention</span> <small>${esc(ms.last_error || '')}</small>`
        : ms.last_ok_at ? `<small>Last synced ${esc(agoText(ms.last_ok_at))} · ${ms.busy_count ?? 0} busy time${ms.busy_count === 1 ? '' : 's'} in the next 60 days</small>` : '<small>Waiting for the first sync…</small>'}</div>
      <div class="actions">${ms.status === 'expired' ? '<button type="button" class="btn small" data-msgo>Reconnect</button>' : '<button type="button" class="btn small secondary" data-mssync>Sync now</button>'}
      <button type="button" class="btn small ghost" data-msoff>Disconnect</button></div></div>`
    : `<div class="person-row msrow"><b>Microsoft 365 (Outlook and Teams)</b><div><small>Connect your work Microsoft account. Your Outlook busy times block bookings, checked every 5 minutes.</small></div>
      <div class="actions"><button type="button" class="btn small" data-msgo>Connect Microsoft</button></div></div>`;
  const status = (f) => f.last_error ? `<span class="badge due">Feed not working</span> <small>${esc(f.last_error)}</small>`
    : f.last_ok_at ? `<small>Last synced ${esc(agoText(f.last_ok_at))} · ${f.events ?? 0} busy time${f.events === 1 ? '' : 's'} in the next 60 days</small>`
    : '<small>Waiting for the first sync…</small>';
  box.innerHTML = `<div class="card"><h2>Connected calendars</h2>
    <p class="hint" style="margin-top:0">Your busy times from Microsoft, Google, Outlook or Apple block bookings with you on every account you work in. Only you see what the events are; everyone else just sees busy.</p>
    ${msBlock}
    <h3 class="drawgrp" style="margin:14px 0 4px">Calendar addresses (Google, Apple, others) · checked every 10 minutes</h3>
    ${(feeds || []).map((f) => `<div class="person-row"><b>${esc(f.label)}</b> <small class="hint" style="display:inline;margin:0">${esc(f.url_hint)}</small><div>${status(f)}</div>
      <div class="actions"><button type="button" class="btn small secondary" data-cfsync="${f.id}">Sync now</button><button type="button" class="btn small ghost" data-cfname="${f.id}">Rename</button>
      <button type="button" class="btn small ghost" data-cfdel="${f.id}">Remove</button></div></div>`).join('')}
    <details ${(feeds || []).length ? '' : 'open'}><summary class="linkish">+ Connect a calendar</summary>
      <label class="label" for="cfLabel">Name it</label><input type="text" id="cfLabel" maxlength="60" placeholder="Work Google, Personal">
      <label class="label" for="cfUrl">Secret calendar address</label><input type="text" id="cfUrl" autocomplete="off" spellcheck="false" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics">
      <small class="hint">Treat it like a password. After you save, the CRM never shows the full address again.</small>
      <div class="actions"><button type="button" class="btn small" id="cfAdd">Connect</button></div>
      <details class="hint"><summary>Where do I find it?</summary>
        <p><b>Google:</b> on a computer, open Google Calendar › Settings (gear) › under "Settings for my calendars" pick your calendar › Integrate calendar › copy <i>Secret address in iCal format</i>.</p>
        <p><b>Outlook / Microsoft 365:</b> Outlook on the web › Settings › Calendar › Shared calendars › Publish a calendar › pick your calendar and "Can view when I'm busy" › Publish › copy the <i>ICS</i> link.</p>
        <p><b>Apple / iCloud:</b> iCloud.com › Calendar › the share icon next to the calendar › turn on Public Calendar › copy the link (webcal:// works).</p></details></details></div>`;
  const sync = async (id) => { const { error: e } = await sb.functions.invoke('cal-sync', { body: { kind: 'mine', feed_id: id } }); if (e) toast('Couldn\'t sync just now. It will try again in a few minutes.'); };
  const msCall = async (kind, extra = {}) => { const { data, error: e } = await sb.functions.invoke('ms-graph', { body: { kind, ...extra } }); if (e || data?.error) { toast(data?.error || 'Microsoft didn\'t answer. Try again in a minute.', { error: true }); return null; } return data; };
  if ($('[data-msgo]', box)) $('[data-msgo]', box).onclick = async (ev) => {
    ev.currentTarget.disabled = true;
    const r = await msCall('start', { origin: location.origin, return_to: location.origin + '/#teamdir/' + S.me.id });
    if (r?.url) location.href = r.url; else ev.currentTarget.disabled = false;
  };
  if ($('[data-mssync]', box)) $('[data-mssync]', box).onclick = async (ev) => { ev.currentTarget.disabled = true; ev.currentTarget.textContent = 'Syncing…'; await msCall('sync_mine'); calFeeds(box); };
  if ($('[data-msoff]', box)) $('[data-msoff]', box).onclick = async () => {
    if (!confirm('Disconnect Microsoft? Your Outlook busy times stop blocking bookings right away.')) return;
    if (await msCall('disconnect')) { toast('Microsoft disconnected'); calFeeds(box); }
  };
  $('#cfAdd', box).onclick = async (ev) => {
    const url = $('#cfUrl', box).value.trim(); if (!url) return toast('Paste the calendar address');
    ev.currentTarget.disabled = true;
    const { data: id, error: e } = await sb.rpc('my_cal_feed_add', { p_label: $('#cfLabel', box).value, p_url: url });
    if (e) { ev.currentTarget.disabled = false; return fail(e); }
    toast('Connected. Reading it now…'); await sync(id); calFeeds(box);
  };
  $$('[data-cfsync]', box).forEach((b) => (b.onclick = async () => { b.disabled = true; b.textContent = 'Syncing…'; await sync(b.dataset.cfsync); calFeeds(box); }));
  $$('[data-cfname]', box).forEach((b) => (b.onclick = async () => {
    const f = feeds.find((x) => x.id === b.dataset.cfname); const n = prompt('Name this calendar', f.label); if (!n || !n.trim()) return;
    const { error: e } = await sb.rpc('my_cal_feed_rename', { p_id: f.id, p_label: n }); if (e) return fail(e); calFeeds(box);
  }));
  $$('[data-cfdel]', box).forEach((b) => (b.onclick = async () => {
    if (!confirm('Disconnect this calendar? Its busy times stop blocking bookings right away.')) return;
    const { error: e } = await sb.rpc('my_cal_feed_remove', { p_id: b.dataset.cfdel }); if (e) return fail(e); toast('Disconnected'); calFeeds(box);
  }));
}
function drawProfile(box, u, editing = false) {
  const mine = u.id === S.me.id, canEdit = mine || isAdmin();
  if (!editing) {
    const row = (k, v) => (v ? `<div class="prow"><span>${k}</span><div>${v}</div></div>` : '');
    box.innerHTML = `<div class="card profile"><div class="toolbar">${avatar(u, true)}<div style="flex:1;min-width:0"><h2 style="margin:0">${esc(u.full_name)}</h2>
        <small class="hint" style="margin:0">${esc(u.title || '')}${u.title ? ' · ' : ''}${u.is_admin ? 'Admin' : 'Team member'}</small></div>
        ${mine ? '' : `<button class="btn small" id="pMsg">Message</button>`}${canEdit ? `<button class="btn secondary small" id="pEdit">Edit</button>` : ''}</div>
      ${row('Email', u.email ? `<a href="mailto:${esc(u.email)}">${esc(u.email)}</a>` : '')}
      ${row('Phone', u.phone ? `<a href="tel:${esc(u.phone.replace(/[^\d+]/g, ''))}">${esc(u.phone)}</a>` : '')}
      ${row('Birthday', esc(bdayLabel(u)))}
      ${row('Time zone', esc(tzLabel(u.timezone)))}
      ${row('About', u.about ? esc(u.about).replace(/\n/g, '<br>') : '')}
      ${!u.phone && !bdayLabel(u) && !u.about && mine ? '<p class="hint">Add your phone, birthday and a line about yourself so the team knows you. Tap Edit.</p>' : ''}</div>
      ${mine ? '<div id="myAvail"></div><div id="calFeeds"></div>' : ''}`;
    if (mine) { myAvail($('#myAvail', box)).catch(() => {}); calFeeds($('#calFeeds', box)).catch(() => {}); }
    if ($('#pMsg', box)) $('#pMsg', box).onclick = async () => { const { data, error } = await sb.rpc('team_dm_open', { p_user: u.id }); if (error) return fail(error); go('chat', data); };
    if ($('#pEdit', box)) $('#pEdit', box).onclick = () => drawProfile(box, u, true);
    return;
  }
  const days = (m) => (m ? new Date(2000, m, 0).getDate() : 31);
  box.innerHTML = `<div class="card profile"><h2>${mine ? 'Your profile' : `Edit ${esc(u.full_name)}`}</h2><form id="pf">
    <div class="row"><div><label class="label" for="pf_name">Name</label><input id="pf_name" name="full_name" required maxlength="120" value="${esc(u.full_name || '')}"></div>
      <div><label class="label" for="pf_title">Title</label><input id="pf_title" name="title" maxlength="120" placeholder="e.g. Sales" value="${esc(u.title || '')}"></div></div>
    <div class="row"><div><label class="label" for="pf_phone">Phone</label><input id="pf_phone" name="phone" type="tel" maxlength="40" value="${esc(u.phone || '')}"></div>
      <div><label class="label" for="pf_tz">Time zone</label><select id="pf_tz" name="timezone">${TZS.map(([z, l]) => `<option value="${z}" ${z === (u.timezone || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <label class="label">Birthday <small class="hint" style="display:inline;margin:0">(month and day, no year)</small></label>
    <div class="row"><div><select name="birthday_month" id="pf_bm" aria-label="Birthday month"><option value="">Month</option>${MONTHS.map((m, i) => `<option value="${i + 1}" ${u.birthday_month === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
      <div><select name="birthday_day" id="pf_bd" aria-label="Birthday day"></select></div></div>
    <label class="label" for="pf_about">About</label><textarea id="pf_about" name="about" maxlength="500" placeholder="What you work on, best way to reach you">${esc(u.about || '')}</textarea>
    <small class="hint">The whole team can see this.</small>
    <div class="actions"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" id="pfX">Cancel</button></div></form></div>`;
  const fillDays = () => { const m = +$('#pf_bm').value, cur = $('#pf_bd').value || u.birthday_day || '';
    $('#pf_bd').innerHTML = `<option value="">Day</option>${Array.from({ length: days(m) }, (_, i) => `<option ${+cur === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}`; };
  fillDays(); $('#pf_bm').onchange = fillDays;
  $('#pfX').onclick = () => drawProfile(box, u);
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!!f.birthday_month !== !!f.birthday_day) return toast('Pick both the month and the day, or neither');
    const { error } = await sb.rpc('team_profile_save', { p_user: u.id, p: f });
    if (error) return fail(error);
    toast('Profile saved'); await reloadUsers(); renderShell();
  };
}

/* ================= Support tab in the chat box (Nov 16, schema/115) =================
   Help first: search the help library. Still stuck: start a chat, Urgent or Routine. A client account's request goes to
   its agency's support team (named for the agency: "Cognix Support"); an agency's own people go to the platform. */
const supportName = () => {
  if (S.acct?.is_agency) return 'Platform support';
  const b = ((BRAND && (BRAND.short_name || BRAND.name)) || '').replace(/\s*(CRM|Platforms?)$/i, '').trim();
  return b ? `${b} Support` : 'Support';
};
async function supportPane(main, opt = {}) {
  const back = () => viewChat(main, { ...opt, support: false });
  let q = opt.q || '';
  const draw = async () => {
    const { data: me } = await sb.rpc('support_mine');
    const threads = me?.threads || [];
    const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    const hits = words.length ? HELP.filter((h) => helpOk(h) && words.every((w) => (h.t + ' ' + h.w + ' ' + h.b).toLowerCase().includes(w))).slice(0, 5) : [];
    main.innerHTML = `<div class="tctabs" role="tablist"><button type="button" role="tab" data-toteam>Team chat</button><button type="button" role="tab" class="on" aria-selected="true">${esc(supportName())}</button></div>
      <div class="suppane">
        <label class="label" for="spQ">How can we help?</label><input type="search" id="spQ" value="${esc(q)}" placeholder="Search help, like: connect my calendar" autocomplete="off">
        <div id="spHits">${words.length ? (hits.length ? hits.map((h, i) => `<details class="sphelp"${i === 0 ? ' open' : ''}><summary>${esc(h.t)}</summary><p>${esc(h.b)}</p></details>`).join('') : '<p class="hint">Nothing in help matches that. Start a chat below and we\'ll help.</p>') : '<p class="hint">Search help first; most answers are right here.</p>'}</div>
        <details id="spStart" ${words.length && !hits.length ? 'open' : ''}><summary class="btn small secondary" style="display:inline-flex">Start a chat</summary>
          <label class="label" for="spBody">What do you need?</label><textarea id="spBody" rows="3" maxlength="4000">${esc(q)}</textarea>
          <div class="row"><label class="check"><input type="radio" name="spPr" value="routine" checked> Routine <small class="hint" style="display:inline;margin:0">(reply within 1 business day)</small></label>
            <label class="check"><input type="radio" name="spPr" value="urgent"> Urgent <small class="hint" style="display:inline;margin:0">(reply within 4 business hours)</small></label></div>
          ${me?.online ? '<p class="hint">Someone from support is online now.</p>' : '<p class="hint">Nobody from support is online right now. Send it anyway: urgent requests are answered within 4 business hours, routine within 1 business day, and you\'ll get the reply here and by email.</p>'}
          <div class="actions"><button class="btn small" id="spSend">Send to support</button></div></details>
        ${threads.length ? `<h3 style="margin:16px 0 6px">Your requests</h3>${threads.map((t, i) => `<details class="spthread"${i === 0 && t.status === 'open' ? ' open' : ''}><summary>${t.priority === 'urgent' ? '<span class="badge warn">Urgent</span> ' : ''}${esc((t.messages?.[0]?.body || 'Request').slice(0, 70))}
            <small class="hint" style="display:inline;margin:0"> · ${esc(fmtDate(t.at))}${t.status === 'closed' ? ' · closed' : ''}</small></summary>
            ${(t.messages || []).map((m) => `<div class="ibm ${m.from === 'staff' ? 'them' : 'me'}">${m.from === 'staff' ? `<small class="tcfrom">${esc(m.name || 'Support')}</small>` : ''}${esc(m.body).replace(/\n/g, '<br>')}<small>${esc(new Date(m.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</small></div>`).join('')}
            <div class="row" style="margin-top:6px"><input type="text" data-spr="${t.id}" placeholder="Reply" maxlength="4000"><button class="btn small" data-sprs="${t.id}">Send</button></div></details>`).join('')}` : ''}
      </div>`;
    $('[data-toteam]', main).onclick = back;
    let tm; $('#spQ', main).oninput = (e) => { clearTimeout(tm); tm = setTimeout(() => { q = e.target.value; const pos = e.target.selectionStart; draw().then(() => { const x = $('#spQ', main); x.focus(); try { x.setSelectionRange(pos, pos); } catch {} }); }, 350); };
    $('#spStart summary', main).onclick = () => { if (!$('#spBody', main).value.trim()) $('#spBody', main).value = $('#spQ', main).value; };
    $('#spSend', main).onclick = async (e) => {
      const body = $('#spBody', main).value.trim(); if (body.length < 3) return toast('Tell us what you need help with');
      e.target.disabled = true; e.target.textContent = 'Sending…';
      const { error } = await sb.rpc('support_open', { p_body: body, p_priority: $('[name=spPr]:checked', main).value, p_search: $('#spQ', main).value.trim() || null });
      if (error) { e.target.disabled = false; e.target.textContent = 'Send to support'; return fail(error); }
      toast('Sent. We\'ll reply here and by email.'); q = ''; draw();
    };
    $$('[data-sprs]', main).forEach((b) => (b.onclick = async () => {
      const inp = $(`[data-spr="${b.dataset.sprs}"]`, main), v = inp.value.trim(); if (!v) return;
      const { error } = await sb.rpc('support_reply', { p_thread: b.dataset.sprs, p_body: v }); if (error) return fail(error);
      draw();
    }));
  };
  await draw();
}

const EMOJIS = ['😀', '😂', '😊', '😍', '😎', '🤔', '😅', '😬', '😢', '😡', '🙏', '👍', '👎', '👏', '🙌', '💪', '👀', '🔥', '🎉', '✅', '❌', '⚠️', '❤️', '💯', '☕', '🎂', '📞', '📅', '💰', '🚀'];
// one chat screen, used two ways: the full page (Inbox > Team chat) and the chat box docked in the bottom-right corner
async function viewChat(main, opt = {}) {
  const dock = !!opt.dock;
  let sel = dock ? (S.dockRoom || null) : (S.param || null), listSig = '', threadSig = '', rooms = [], heard = { room: null, at: '' }, pic = null;
  const remember = (id) => { if (dock) S.dockRoom = id; else if (!id) leaveSub('#chat'); else if (/^#chat\/./.test(location.hash)) history.replaceState({ d: depth(), sub: history.state?.sub }, '', '#chat/' + id); else pushSub('#chat/' + id); };
  if (opt.support) return supportPane(main, opt);
  const tabs = `<div class="tctabs" role="tablist"><button type="button" role="tab" class="on" aria-selected="true">Team chat</button><button type="button" role="tab" data-tosupport>${esc(supportName())}</button></div>`;
  main.innerHTML = tabs + (dock ? `<div class="dockbar"><button class="btn secondary small" id="tcNew">New message</button><button class="btn secondary small" id="tcGroup">New group</button></div>
    <div class="inbox compact ${sel ? 'has-sel' : ''}">` : `<div class="toolbar"><h1 style="margin:0;flex:1">Internal chat</h1>
      <button class="btn secondary small" id="tcNew">New message</button><button class="btn secondary small" id="tcGroup">New group</button></div>
    <small class="hint" style="margin:-6px 0 4px">Only your team sees this. If someone isn't in the CRM, they get a notification (or an email if notifications are off). The chat box in the bottom-right corner is the same chat.</small>
    <div class="tcalert page" id="tcAlertPage"></div>
    <div class="inbox ${sel ? 'has-sel' : ''}">`) + `<div class="iblist" id="tcList"><p class="empty">Loading…</p></div><div class="ibthread" id="tcThread"></div></div>`;
  $('[data-tosupport]', main).onclick = () => { clearInterval(S.dockTimer); clearInterval(S.inboxTimer); viewChat(main, { ...opt, support: true }); };
  const ago = (s) => { if (!s) return ''; const m = Math.round((Date.now() - new Date(s)) / 60000); return m < 1 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : fmtDate(s); };
  // a room from another account you're on the team of carries that account's name: "Whole team: GELP", "Julie Olivari (GELP)"
  const roomName = (r) => r.kind === 'team' ? (r.account ? `Whole team: ${r.account}` : 'Whole team') : (r.name || 'Conversation') + (r.account ? ` (${r.account})` : '');
  const pname = (id, r) => userName(id) || r?.people?.[id] || '';
  const srvAge = (iso) => Date.now() - (S.clockSkew || 0) - Date.parse(iso);
  const pickPeople = (title, exclude, multi, cb) => {
    // hidden logins (System Admin) only show to admins starting a one-on-one message
    const people = staff().filter((u) => !exclude.includes(u.id) && (!u.hidden_in_team || (!multi && isAdmin())));
    $('#tcThread').innerHTML = `<div class="ibhead"><button type="button" class="btn ghost small ibback" id="ppBack">← Back</button><b style="flex:1">${esc(title)}</b></div>
      <div style="padding:14px;overflow:auto">${multi ? `<label class="label" for="ppName">Group name</label><input id="ppName" maxlength="80" value="${esc(multi.name || '')}" ${multi.noName ? 'hidden' : ''}>` : ''}
      ${people.length ? people.map((u) => `<label class="check pprow"><input type="${multi ? 'checkbox' : 'radio'}" name="pp" value="${u.id}"> ${avatar(u)} <span><b>${esc(u.full_name)}</b><br><small>${esc(u.title || '')}</small></span></label>`).join('')
        : '<p class="empty">Everyone is already here.</p>'}
      <div class="actions"><button class="btn" id="ppGo">${multi ? multi.go : 'Start'}</button><button class="btn ghost" id="ppX">Cancel</button></div></div>`;
    ibx().classList.add('has-sel');
    const back = () => { ibx().classList.toggle('has-sel', !!sel); threadSig = ''; loadThread(true); };
    $('#ppBack').onclick = back; $('#ppX').onclick = back;
    $('#ppGo').onclick = () => cb([...$$('[name=pp]:checked')].map((x) => x.value), $('#ppName')?.value || '');
  };
  $('#tcNew').onclick = () => pickPeople('Message someone', [S.me.id], null, async ([uid]) => {
    if (!uid) return toast('Pick someone');
    const { data, error } = await sb.rpc('team_dm_open', { p_user: uid }); if (error) return fail(error); open(data);
  });
  $('#tcGroup').onclick = () => pickPeople('New group', [S.me.id], { go: 'Create group' }, async (ids, name) => {
    if (!name.trim()) return toast('Give the group a name');
    if (!ids.length) return toast('Pick at least one person');
    const { data, error } = await sb.rpc('team_group_create', { p_name: name, p_members: ids }); if (error) return fail(error); open(data);
  });
  const ibx = () => main.querySelector('.inbox');
  function open(id) { sel = id; remember(id); ibx().classList.add('has-sel'); listSig = ''; threadSig = ''; loadList().then(() => loadThread(true)); }
  async function loadList() {
    sb.rpc('other_accounts_waiting').then(({ data: w }) => { if (JSON.stringify(w || []) !== JSON.stringify(S.otherWaiting || [])) { S.otherWaiting = w || []; listSig = ''; } }, () => {});
    const [{ data, error }] = await Promise.all([sb.rpc('team_rooms_list'), !S.presenceAt || Date.now() - S.presenceAt > 30000 ? (S.presenceAt = Date.now(), loadPresence()) : null]);
    if (error) return fail(error);
    rooms = data || [];
    if (!sel && !dock && isWide() && rooms[0]) sel = rooms[0].id;
    const sig = JSON.stringify(rooms) + sel + JSON.stringify(S.presence); if (sig === listSig) return; listSig = sig;
    const onlineIn = (r) => (r.members || []).filter((id) => id !== S.me.id && isOnline(id)).length;
    const item = (r) => `<button type="button" class="ibitem ${r.id === sel ? 'on' : ''} ${r.unread ? 'unread' : ''}" data-room="${r.id}">
        <b>${r.kind === 'dm' ? odot(r.other_id) : r.kind === 'team' ? '# ' : '◦ '}${esc(roomName(r))}${r.kind !== 'dm' && onlineIn(r) ? ` <small class="hint">${onlineIn(r)} online</small>` : ''}${r.unread ? ` <span class="count">${r.unread}</span>` : ''}</b><span class="when">${esc(ago(r.last_message_at))}</span>
        <small>${r.preview ? esc((r.preview.sender_id === S.me.id ? 'You: ' : r.kind !== 'dm' ? (pname(r.preview.sender_id, r) || '').split(' ')[0] + ': ' : '') + r.preview.body) : r.kind === 'team' ? 'Everyone on the team' : 'No messages yet'}</small></button>`;
    // Nov 16: this account first; the other accounts you work in fold under "Other accounts", one section each
    const here = rooms.filter((r) => r.here !== false), away = rooms.filter((r) => r.here === false);
    const byAcct = {};
    away.forEach((r) => { (byAcct[r.tenant_id] ||= { name: r.account || 'Another account', rooms: [], unread: 0, waiting: 0 }).rooms.push(r); byAcct[r.tenant_id].unread += r.unread || 0; });
    (S.otherWaiting || []).forEach((w) => { (byAcct[w.tenant_id] ||= { name: w.account, rooms: [], unread: 0, waiting: 0 }).waiting = w.waiting; });
    const accts = Object.entries(byAcct), awayUnread = accts.reduce((a, [, x]) => a + x.unread + x.waiting, 0);
    S.tcOpenAccts ||= {};
    $('#tcList').innerHTML = here.map(item).join('') + (accts.length ? `<details class="tcother" data-acctall ${S.tcOpenAccts.all ?? awayUnread ? 'open' : ''}><summary>Other accounts${awayUnread ? ` <span class="count">${awayUnread}</span>` : ''}</summary>
      ${accts.map(([tid, x]) => `<details class="tcacct" data-acctsec="${tid}" ${S.tcOpenAccts[tid] ?? (x.unread || x.waiting) ? 'open' : ''}><summary>${esc(x.name)}${x.unread + x.waiting ? ` <span class="count">${x.unread + x.waiting}</span>` : ''}</summary>
        ${x.waiting ? `<button type="button" class="ibitem unread" data-inboxin="${tid}"><b>Customer chats waiting <span class="count">${x.waiting}</span></b><small>Opens ${esc(x.name)}'s Inbox</small></button>` : ''}
        ${x.rooms.map(item).join('')}</details>`).join('')}</details>` : '');
    $$('#tcList details').forEach((d) => (d.ontoggle = () => { S.tcOpenAccts[d.dataset.acctsec || 'all'] = d.open; }));
    $$('#tcList [data-inboxin]').forEach((b) => (b.onclick = async () => { await switchTo(b.dataset.inboxin); go('inbox'); }));
    $$('#tcList [data-room]').forEach((b) => (b.onclick = () => open(b.dataset.room)));
  }
  async function loadThread(fresh) {
    const box = $('#tcThread'), r = rooms.find((x) => x.id === sel);
    if (!r) { box.innerHTML = '<p class="empty" style="padding:30px">Pick a conversation.</p>'; return; }
    const { data: msgs, error } = await sb.from('team_messages').select('id,sender_id,body,created_at,picture_path,recalled_at').eq('room_id', r.id).order('created_at', { ascending: false }).limit(200);
    if (error) return fail(error);
    msgs.reverse();
    // pictures: signed links, kept for 50 minutes so polling doesn't re-sign them
    S.picUrls ||= {};
    const need = msgs.map((m) => m.picture_path).filter((pp) => pp && !(S.picUrls[pp] && S.picUrls[pp].at > Date.now() - 50 * 60000));
    if (need.length) ((await sb.storage.from('team-chat').createSignedUrls(need, 3600)).data || []).forEach((x) => { if (x.signedUrl) S.picUrls[x.path] = { url: x.signedUrl, at: Date.now() }; });
    // a new message from someone else in the conversation you have open: chime (it's read right away, so the unread watcher won't)
    const latest = msgs.reduce((x, m) => (m.created_at > x ? m.created_at : x), '');
    const fresh2 = heard.room === r.id ? msgs.filter((m) => m.created_at > heard.at && m.sender_id !== S.me.id) : [];
    if (fresh2.length) chatArrived(r, fresh2.reduce((x, m) => (m.created_at > x.created_at ? m : x)));
    heard = { room: r.id, at: latest || heard.at };
    if (r.unread) { await sb.rpc('team_mark_read', { p_room: r.id }); r.unread = 0; listSig = ''; loadList(); refreshCounts(); }
    const sig = JSON.stringify([r.name, r.members, msgs, (r.members || []).map((id) => seenLabel(id))]); if (!fresh && sig === threadSig) return; threadSig = sig;
    const draft = $('#tcText')?.value || '', hadFocus = document.activeElement?.id === 'tcText';
    const nOn = (r.members || []).filter((id) => id !== S.me.id && isOnline(id)).length;
    const who = r.kind === 'team' ? `Everyone on the team (${(r.members || []).length})${nOn ? ` · ${nOn} online` : ''}` : r.kind === 'dm' ? [seenLabel(r.other_id), staff().find((u) => u.id === r.other_id)?.title].filter(Boolean).join(' · ') || 'Direct message'
      : (r.members || []).map((id) => (isOnline(id) && id !== S.me.id ? '🟢 ' : '') + (pname(id, r) || '')).filter((x) => x.trim()).join(', ');
    const boss = r.kind === 'group' && (r.created_by === S.me.id || isAdmin());
    let lastDay = '';
    box.innerHTML = `<div class="ibhead"><button type="button" class="btn ghost small ibback" id="tcBack">← Back</button>
        <div style="flex:1;min-width:0"><b>${r.kind === 'dm' ? `${odot(r.other_id)}<button type="button" class="linkish" id="tcWho">${esc(roomName(r))}</button>` : esc(roomName(r))}</b><small>${esc(who)}</small></div>
        ${r.here === false && (S.accounts || []).some((a) => a.id === r.tenant_id) ? `<button type="button" class="btn ghost small" id="tcOpenIn">Open in ${esc(r.account || 'that account')}</button>` : ''}
        ${r.kind === 'group' ? `<button type="button" class="btn ghost small" id="tcAdd">Add people</button>${boss ? '<button type="button" class="btn ghost small" id="tcRen">Rename</button>' : ''}<button type="button" class="btn ghost small" id="tcLeave">Leave</button>` : ''}</div>
      <div class="ibmsgs" id="tcMsgs">${msgs.length ? msgs.map((m) => {
        const day = new Date(m.created_at).toDateString(), sep = day !== lastDay ? `<div class="tcday">${esc(fmtDate(m.created_at))}</div>` : ''; lastDay = day;
        const purl = m.picture_path && S.picUrls[m.picture_path]?.url;
        if (m.recalled_at) return `${sep}<div class="ibm ${m.sender_id === S.me.id ? 'me' : 'them'} recalled">${r.kind !== 'dm' && m.sender_id !== S.me.id ? `<small class="tcfrom">${esc(pname(m.sender_id, r) || 'Someone')}</small>` : ''}<i>${m.sender_id === S.me.id ? 'You recalled this message' : 'Message recalled'}</i>
          <small>${esc(new Date(m.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}</small></div>`;
        const canRecall = m.sender_id === S.me.id && srvAge(m.created_at) < 30000;
        return `${sep}<div class="ibm ${m.sender_id === S.me.id ? 'me' : 'them'}${m.picture_path ? ' haspic' : ''}">${r.kind !== 'dm' && m.sender_id !== S.me.id ? `<small class="tcfrom">${esc(pname(m.sender_id, r) || 'Someone')}</small>` : ''}${m.picture_path ? (purl ? `<a href="${esc(purl)}" target="_blank" rel="noopener"><img class="tcpic" src="${esc(purl)}" alt="Picture"></a>` : '<span class="hint">Picture</span>') : ''}${m.picture_path && m.body === '📷 Picture' ? '' : esc(m.body).replace(/\n/g, '<br>')}
          <small>${esc(new Date(m.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}${canRecall ? ` · <button type="button" class="linkish tcrecall" data-recall="${m.id}">Recall</button>` : ''}</small></div>`; }).join('')
        : `<p class="empty" style="margin:auto">${r.kind === 'team' ? 'Say hi to the whole team.' : 'No messages yet.'}</p>`}</div>
      <div class="tcundo" id="tcUndo" hidden></div>
      <div class="ibcompose"><div class="tctools"><div class="emojiwrap"><button type="button" class="btn ghost small emojibtn" id="tcEmo" aria-label="Add an emoji" aria-expanded="false">😀</button>
          <div class="emojipop" id="tcEmoPop" hidden role="menu">${EMOJIS.map((e) => `<button type="button" data-emo="${e}" aria-label="${e}">${e}</button>`).join('')}</div></div>
        <label class="btn ghost small emojibtn" title="Send a picture, GIF or sticker" aria-label="Add a picture">🖼️<input type="file" id="tcPic" accept="image/png,image/jpeg,image/gif,image/webp" hidden></label></div>
        <div class="tcwrite"><div id="tcPicPrev"></div><div id="tcText" class="tcedit" contenteditable="true" role="textbox" aria-multiline="true" enterkeyhint="send" data-placeholder="${esc(r.kind === 'team' ? `Message EVERYONE on the team (${(r.members || []).length})` : r.kind === 'dm' ? `Message ${roomName(r)} only` : `Message the ${roomName(r)} group`)}. Enter sends." aria-label="Message to ${esc(roomName(r))}">${esc(draft)}</div></div><button type="button" class="btn gold" id="tcSend">Send</button></div>`;
    const ms = $('#tcMsgs'); ms.scrollTop = ms.scrollHeight;
    // recall: 30 seconds to pull a message back (wrong chat, typo). The text comes back into the box so it can go to the right place.
    const recall = async (mid) => {
      const m = msgs.find((x) => x.id === mid) || (S.tcLast?.id === mid ? S.tcLast : null);
      const { error: e } = await sb.rpc('team_recall', { p_message: mid });
      if (e) return fail(e);
      if (S.tcLast?.id === mid) S.tcLast = null;
      const ta = $('#tcText'); if (ta && m?.body && m.body !== '📷 Picture' && !ta.value.trim()) ta.value = m.body;
      toast('Message recalled. The text is back in the box if you want to send it somewhere else.');
      threadSig = ''; listSig = ''; await loadThread(true); loadList();
    };
    $$('[data-recall]', box).forEach((b) => (b.onclick = () => recall(b.dataset.recall)));
    const undoBar = () => {
      const el = $('#tcUndo'); if (!el) return;
      const L = S.tcLast, left = L ? 30 - Math.floor((Date.now() - L.at) / 1000) : 0;
      if (!L || L.room !== r.id || left <= 0) { el.hidden = true; el.innerHTML = ''; if (L && left <= 0) S.tcLast = null; return; }
      el.hidden = false;
      el.innerHTML = `<span>Sent to <b>${esc(roomName(r))}</b>. Wrong chat?</span><button type="button" class="btn small" id="tcUndoBtn">Recall (${left}s)</button>`;
      $('#tcUndoBtn').onclick = () => recall(L.id);
    };
    undoBar(); clearInterval(S.tcUndoTimer); S.tcUndoTimer = setInterval(() => { if (!document.body.contains($('#tcUndo'))) return clearInterval(S.tcUndoTimer); undoBar();
      if (!S.tcLast) $$('[data-recall]').forEach((b) => { const msg = msgs.find((x) => x.id === b.dataset.recall); if (msg && srvAge(msg.created_at) >= 30000) b.remove(); }); }, 1000);
    $('#tcBack').onclick = () => { sel = null; remember(null); ibx().classList.remove('has-sel'); listSig = ''; loadList(); };
    if ($('#tcOpenIn')) $('#tcOpenIn').onclick = async () => { const rid = r.id; await switchTo(r.tenant_id); go('chat', rid); };
    if ($('#tcWho')) $('#tcWho').onclick = () => { if (dock && !isWide()) closeDock(); go('teamdir', r.other_id); };
    if ($('#tcAdd')) $('#tcAdd').onclick = () => pickPeople('Add people to ' + roomName(r), r.members || [], { go: 'Add', noName: true }, async (ids) => {
      if (!ids.length) return toast('Pick at least one person');
      const { error: e } = await sb.rpc('team_group_edit', { p_room: r.id, p_add: ids }); if (e) return fail(e); toast('Added'); open(r.id);
    });
    if ($('#tcRen')) $('#tcRen').onclick = async () => { const n = prompt('Group name', r.name || ''); if (!n || !n.trim()) return;
      const { error: e } = await sb.rpc('team_group_edit', { p_room: r.id, p_name: n }); if (e) return fail(e); toast('Renamed'); open(r.id); };
    if ($('#tcLeave')) $('#tcLeave').onclick = async () => { if (!confirm(`Leave ${roomName(r)}? You won't see it anymore unless someone adds you back.`)) return;
      const { error: e } = await sb.rpc('team_group_edit', { p_room: r.id, p_remove: [S.me.id] }); if (e) return fail(e); toast('You left the group'); sel = null; remember(null); listSig = ''; await loadList(); loadThread(true); };
    const showPic = () => {
      const box = $('#tcPicPrev'); if (!box) return;
      box.innerHTML = pic ? `<div class="tcpicprev"><img src="${pic.url}" alt="Picture to send"><button type="button" class="btn ghost small" id="tcPicX" aria-label="Remove picture">✕</button></div>` : '';
      if ($('#tcPicX')) $('#tcPicX').onclick = () => { pic = null; showPic(); };
    };
    const takePic = (f) => {
      if (!f) return;
      if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return toast('Pictures can be PNG, JPG, GIF or WebP');
      if (f.size > 8 * 1024 * 1024) return toast('Pictures must be under 8 MB');
      const rd = new FileReader(); rd.onload = () => { pic = { file: f, url: rd.result }; showPic(); $('#tcText').focus(); }; rd.readAsDataURL(f);
    };
    showPic();
    $('#tcPic').onchange = (e) => { takePic(e.target.files[0]); e.target.value = ''; };
    richBox($('#tcText'), takePic, 4000);
    const send = async () => {
      const ta = $('#tcText'), body = ta.value.trim(); if (!body && !pic) return;
      const b = $('#tcSend'); b.disabled = true;
      let path = null;
      if (pic) {
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[pic.file.type] || 'png';
        path = `${r.tenant_id || S.acct?.id || S.me.tenant_id}/${r.id}/${S.me.id}/${Date.now()}.${ext}`;
        const up = await sb.storage.from('team-chat').upload(path, pic.file, { contentType: pic.file.type, upsert: false });
        if (up.error) { b.disabled = false; return fail(up.error); }
      }
      const { data, error: e } = await sb.rpc('team_send', { p_room: r.id, p_body: body, p_picture: path });
      b.disabled = false;
      if (e) return fail(e);
      // the server's clock decides the 30 seconds, so line ours up with it
      if (data?.created_at) S.clockSkew = Date.now() - Date.parse(data.created_at);
      S.tcLast = { id: data?.id, room: r.id, body, at: Date.now() };
      ta.value = ''; pic = null; showPic(); threadSig = ''; await loadThread(true); listSig = ''; loadList();
    };
    $('#tcSend').onclick = send;
    const pop = $('#tcEmoPop');
    $('#tcEmo').onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; $('#tcEmo').setAttribute('aria-expanded', String(!pop.hidden)); };
    $$('[data-emo]', pop).forEach((b) => (b.onclick = () => {
      const ta = $('#tcText'), at = ta.selectionStart ?? ta.value.length, end = ta.selectionEnd ?? at;
      ta.value = ta.value.slice(0, at) + b.dataset.emo + ta.value.slice(end);
      ta.focus(); ta.setSelectionRange(at + b.dataset.emo.length, at + b.dataset.emo.length);
      pop.hidden = true; $('#tcEmo').setAttribute('aria-expanded', 'false');
    }));
    document.addEventListener('click', (e) => { if (!pop.hidden && !e.target.closest('.emojiwrap')) pop.hidden = true; }, { once: true });
    $('#tcText').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    if (fresh || hadFocus) { const ta = $('#tcText'); if (isWide() || hadFocus) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
  }
  await loadList(); await loadThread(true);
  if (!dock) drawAlertBar($('#tcAlertPage'));
  if (dock) { clearInterval(S.dockTimer); S.dockTimer = setInterval(() => { if (!document.hidden && S.dockOpen) { loadList(); if (sel) loadThread(false); } }, 4000); }
  else S.inboxTimer = setInterval(() => { if (!document.hidden && S.view === 'chat') { loadList(); if (sel) loadThread(false); } }, 4000);
}

// the chat box: a button in the bottom-right corner on every screen, opening a small chat window that stays open while you move around
function mountChatDock() {
  if (!S.me?.active || S.me.role === 'vendor' || S.me.role === 'member') return;
  if (!$('#tcDock')) {
    document.body.insertAdjacentHTML('beforeend', `<div id="tcDock" class="tcdock">
      <section id="tcPanel" class="tcpanel" hidden aria-label="Internal chat"><div class="tcphead"><b style="flex:1">Internal chat</b>
        <button type="button" class="btn ghost small" id="tcFull" title="Open the full page">Full view</button>
        <button type="button" class="btn ghost small" id="tcClose" aria-label="Close chat">✕</button></div>
        <div class="tcalert" id="tcAlert"></div><div id="tcBody" class="tcbody"></div></section>
      <button type="button" id="tcFab" class="tcfab" aria-label="Internal chat" aria-expanded="false"><span aria-hidden="true">💬</span><span class="tcfablabel">Internal chat</span>${badge('teamchat')}</button></div>`);
    $('#tcFab').onclick = () => (S.dockOpen ? closeDock() : openDock());
    $('#tcClose').onclick = closeDock;
    $('#tcFull').onclick = () => { const r = S.dockRoom; closeDock(); go('chat', r || null); };
  }
  // the full Team chat page is the same chat, so the corner box steps aside there
  $('#tcDock').hidden = S.view === 'chat';
  if (S.view === 'chat' && S.dockOpen) closeDock();
}
function openDock() {
  S.dockOpen = true; $('#tcPanel').hidden = false; $('#tcFab').setAttribute('aria-expanded', 'true'); $('#tcDock').classList.add('open');
  viewChat($('#tcBody'), { dock: true }).catch(fail);
  drawAlertBar($('#tcAlert'));
}
function closeDock() {
  S.dockOpen = false; clearInterval(S.dockTimer);
  if (!$('#tcPanel')) return;
  $('#tcPanel').hidden = true; $('#tcFab').setAttribute('aria-expanded', 'false'); $('#tcDock').classList.remove('open'); $('#tcBody').innerHTML = '';
}

/* ================= team chat alerts: chime, tab title, system and push notifications ================= */
// An original two-note chime made in the browser (no sound files). Muting is per device.
const chatSoundOn = () => { try { return localStorage.getItem('chatSound') !== 'off'; } catch { return true; } };
let audioCtx = null;
function unlockAudio() { try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch {} }
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));
// the bell is a short sound file built right here (two soft notes, E5 then B5), played like any audio clip
let chimeUrl = null;
function chimeWav() {
  if (chimeUrl) return chimeUrl;
  const rate = 22050, len = Math.floor(rate * 0.7), data = new Int16Array(len);
  const note = (f, start, i) => { const t = i / rate - start; return t < 0 ? 0 : Math.sin(2 * Math.PI * f * t) * Math.min(1, t / 0.01) * Math.exp(-t * 6); };
  for (let i = 0; i < len; i++) data[i] = Math.max(-1, Math.min(1, 0.55 * note(659.25, 0, i) + 0.55 * note(987.77, 0.12, i))) * 32767;
  const buf = new ArrayBuffer(44 + len * 2), v = new DataView(buf), w = (o, str) => [...str].forEach((c, k) => v.setUint8(o + k, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, len * 2, true);
  new Int16Array(buf, 44).set(data);
  return (chimeUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
}
async function playChime(force = false) {
  if (!force && !chatSoundOn()) return false;
  try { const a = new Audio(chimeWav()); a.volume = 1; await a.play(); return true; }
  catch {
    // fallback: the browser's sound engine
    try {
      unlockAudio(); if (!audioCtx) return false; if (audioCtx.state !== 'running') await audioCtx.resume();
      const t = audioCtx.currentTime;
      [[659.25, 0], [987.77, 0.12]].forEach(([f, at]) => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(0.5, t + at + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.5);
        o.connect(g).connect(audioCtx.destination); o.start(t + at); o.stop(t + at + 0.55); });
      return audioCtx.state === 'running';
    } catch { return false; }
  }
}
const BASE_TITLE = document.title;
const brandTitle = () => { const x = BRAND; return x ? (/platform/i.test(x.name) ? x.name : `${x.short_name || x.name}${/crm/i.test(x.short_name || x.name) ? '' : ' CRM'}`) : BASE_TITLE; };
function setTitleCount(n) { document.title = (n ? `(${n}) ` : '') + brandTitle(); }

// notifications on this device
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOSBrowser = () => isIOS() && !isStandalone();
const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function pushState() {
  if (!pushSupported()) return isIOSBrowser() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) && Notification.permission === 'granted' ? 'on' : 'off';
}
async function savePushSub(sub) {
  const j = sub.toJSON();
  const { error } = await sb.rpc('push_subscribe', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent.slice(0, 300) });
  if (error) throw error;
}
async function turnOnPush() {
  if (!pushSupported()) return toast(isIOSBrowser() ? 'On iPhone, add the CRM to your Home Screen first, then turn notifications on from the app.' : 'This browser can\'t do notifications.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast(perm === 'denied' ? 'Notifications are blocked for this site. Allow them in your browser settings.' : 'Notifications not turned on');
  const { data: key, error } = await sb.rpc('push_public_key');
  if (error || !key) return fail(error || { message: 'Notifications aren\'t set up yet' });
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  await savePushSub(sub);
  toast('Notifications are on for this device');
}
async function turnOffPush() {
  const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
  if (sub) { await sb.rpc('push_unsubscribe', { p_endpoint: sub.endpoint }); await sub.unsubscribe().catch(() => {}); }
  toast('Notifications are off for this device');
}
// keep this device's subscription attached to whoever is signed in
async function syncPush() { try { if ((await pushState()) === 'on') await savePushSub(await (await navigator.serviceWorker.ready).pushManager.getSubscription()); } catch {} }

// watch for new team chat messages: chime and badge while the CRM is open, a system notification if it's in the background
function startChatAlerts() {
  if (S.tcAlerts || !S.me?.active || S.me.role === 'vendor' || S.me.role === 'member') return;
  S.tcAlerts = true; S.tcLast = null;
  syncPush();
  const check = async () => {
    const { data } = await sb.rpc('team_unread'); if (data == null) return;
    const n = Number(data), prev = S.tcLast; S.tcLast = n;
    S.counts.teamchat = n; S.counts.inboxAll = (S.counts.chats || 0) + n;
    ['teamchat', 'inboxAll'].forEach((k) => $$(`[data-count="${k}"]`).forEach((el) => { el.textContent = S.counts[k] || ''; el.hidden = !S.counts[k]; }));
    setTitleCount(n + (S.counts.chats || 0));
    // customer chats waiting in the other accounts you work in: notify, and the chat box links to that Inbox
    sb.rpc('other_accounts_waiting').then(({ data: w }) => {
      const was = Object.fromEntries((S.otherWaiting || []).map((x) => [x.tenant_id, x.waiting]));
      S.otherWaiting = w || [];
      const grew = S.otherWaitingSeen ? (w || []).filter((x) => x.waiting > (was[x.tenant_id] || 0)) : [];
      S.otherWaitingSeen = true;
      if (grew.length) { playChime(); toast(`New customer chat in ${grew.map((x) => x.account).join(', ')}. Open the chat box to go to that Inbox.`); }
    }, () => {});
    if (prev == null || n <= prev) return;
    const { data: rooms } = await sb.rpc('team_rooms_list');
    const r = (rooms || []).filter((x) => x.unread && x.preview).sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)))[0];
    chatArrived(r, r?.preview);
  };
  check();
  setInterval(check, 8_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  // a notification was tapped while the CRM was already open
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type !== 'open') return;
    const m = new URL(e.data.url).hash.match(/^#chat\/([0-9a-f-]+)/i);
    if (m) { S.dockRoom = m[1]; if (S.view === 'chat') go('chat', m[1]); else { closeDock(); openDock(); } }
  });
}
// something new came in: chime, pulse the bubble, and a system notification if the CRM is in the background
async function chatArrived(r, m) {
  if (Date.now() - (S.lastChime || 0) < 1500) return;   // one alert per burst
  S.lastChime = Date.now();
  playChime();
  $('#tcFab')?.classList.add('ping'); setTimeout(() => $('#tcFab')?.classList.remove('ping'), 4000);
  if (document.hidden && r && m && 'Notification' in window && Notification.permission === 'granted') {
    const from = userName(m.sender_id) || r.people?.[m.sender_id] || 'Someone';
    try { (await navigator.serviceWorker.ready).showNotification(r.kind === 'dm' ? from + (r.account ? ` (${r.account})` : '') : `${from} in ${r.kind === 'team' ? (r.account ? `Whole team: ${r.account}` : 'Whole team') : r.name + (r.account ? ` (${r.account})` : '')}`,
      { body: m.body, tag: `room-${r.id}`, renotify: true, icon: '/icon-192.png', data: { url: `/#chat/${r.id}` } }); } catch {}
  } else if (!document.hidden && !S.dockOpen && S.view !== 'chat') {
    // Nov 16: say who and where ("Julie (Cognix): ..."); several from one account within a minute become one line
    const from = (r && m && (userName(m.sender_id) || r.people?.[m.sender_id])) || 'Someone';
    const key = r?.account || '';
    S.chatPops ||= {};
    const g = S.chatPops[key] && Date.now() - S.chatPops[key].at < 60_000 ? S.chatPops[key] : { n: 0 };
    g.n += 1; g.at = Date.now(); S.chatPops[key] = g;
    toast(g.n > 1 ? `${g.n} new chat messages${key ? ' in ' + key : ''}` : `${from.split(' ')[0]}${key ? ` (${key})` : ''}: ${String(m?.body || 'New message').slice(0, 80)}`);
  }
}
// the switch row shown in the chat box
async function drawAlertBar(el) {
  if (!el) return;
  const st = await pushState(), snd = chatSoundOn();
  const pushLine = st === 'on' ? '<span>Notifications on</span> <button type="button" class="linkish" data-push="off">Turn off</button>'
    : st === 'blocked' ? '<span>Notifications blocked in browser settings</span>'
    : st === 'ios-install' ? '<span>Add to Home Screen to get notifications</span>'
    : st === 'unsupported' ? '' : '<button type="button" class="linkish" data-push="on">Turn on notifications</button>';
  const via = S.me?.notify_via || 'push';
  el.innerHTML = `<button type="button" class="linkish" data-snd>${snd ? '🔔 Sound on' : '🔕 Sound off'}</button> · <button type="button" class="linkish" data-sndtest>Test sound</button>${pushLine ? ' · ' + pushLine : ''}
    <label class="notifyvia"><span>When someone notifies me or there's an urgent alert:</span><select data-nvia aria-label="How notifications reach me">
      ${[['push', 'Push to my devices (email if none are on)'], ['email', 'Email'], ['both', 'Push and email'], ['app', 'Only in the CRM']].map(([k, l]) => `<option value="${k}" ${via === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
  $('[data-nvia]', el).onclick = (e) => e.stopPropagation();
  $('[data-nvia]', el).onchange = async (e) => { const v = e.target.value; const { error } = await sb.rpc('my_notify_via_set', { p_via: v }); if (error) return fail(error); S.me.notify_via = v; toast('Saved'); };
  $('[data-snd]', el).onclick = () => { try { localStorage.setItem('chatSound', snd ? 'off' : 'on'); } catch {} if (!snd) playChime(true); drawAlertBar(el); };
  $('[data-sndtest]', el).onclick = async () => { if (!(await playChime(true))) toast('Your browser blocked the sound. Check that this site isn\'t muted (right-click the tab) and your volume is up.'); };
  const p = $('[data-push]', el);
  if (p) p.onclick = async () => { try { p.dataset.push === 'on' ? await turnOnPush() : await turnOffPush(); } catch (e) { fail(e); } drawAlertBar(el); };
}

/* ================= search everything (Ctrl+K or the search box in the top bar) ================= */
// screens people can open, with extra words they might type
// where a screen lives, the way you'd click to it: "Sales › Invoices", "Tools › Admin › Sales › Invoices and payments"
function screenPath(v) {
  const f = folderFor(v); if (!f || (f === FOLDERS[0] && !f.views.includes(v))) return '';
  if (f.id === 'tools') { const d = drawerFor(v), it = d?.items.find((i) => i.match.includes(v)); return ['Tools', d?.label, d && it && groupsOf(d) ? adminGroup(it) : null, it?.label].filter(Boolean).join(' › '); }
  const dv = (f.dividers || []).filter(Boolean).find((x) => (x.match || []).includes(v));
  return dv && dv.label !== f.label ? `${f.label} › ${dv.label}` : f.label;
}
const SCREENS = () => [
  ['add', 'Quick Add', 'new add organization contact lead visit'], ['orgs', 'Organizations', 'clinics companies accounts list'], ['people', 'People', 'contacts persons'],
  ['import', 'Import', 'spreadsheet excel csv upload undo template'], ['sales', 'Sales overview', 'revenue dashboard'], ['pipeline', 'Pipeline', 'stages board deals'],
  ...(S.acct?.is_gelp !== false ? [['proposals', 'Proposals', 'quotes pricing expired accepted']] : []),
  ...(FLD.can('invoices', 1) ? [['invoices', 'Invoices', 'bill billing payments paid overdue balance due']] : []),
  ...(DOC.canSetup() ? [['docsetup', 'Invoices and payments', 'stripe connect payment link tax invoice numbers company info']] : []),
  ...(BID.canSee() ? [['bids', 'Bids', 'rfp bid go no-go scorecard won lost tender']] : []),
  ...(BID.canSetup() ? [['bidsetup', 'Bids setup', 'scorecard bid email upload page base address go no-go']] : []),
  ...ESN.screens(),
  ...CAL.screens(),
  ...SOC.screens(),
  ...(PRT.canSetup() ? [['portalsetup', 'Client portal', 'client portal customer login sections files photos shared internal']] : []),
  ...(MEA.canSetup() ? [['measuresetup', 'Measuring', 'measure map satellite square feet linear feet count price book add-ons']] : []),
  ['myday', 'My Day', 'follow ups tasks today birthdays escalations'], ['sites', 'Sites', 'websites funnels chat code forms'],
  ['inbox', 'Inbox: Customers', 'website chat messages visitors'], ['chat', 'Internal chat', 'team chat messages dm group'], ['teamdir', 'Team profiles', 'people birthday phone directory'],
  ...(S.dirOn ? [['directories', 'Directories', 'listings members business']] : []),
  ...(isAdmin() ? [['review', 'Review', 'duplicates suggestions approvals problems errors'], ['team', 'Admin: Team', 'invite users logins access'],
    ['settings', 'Admin: Settings', 'pipelines stages follow up buttons'], ['archive', 'Admin: Archive', 'deleted restore'], ['lists', 'Admin: Lists', 'dropdowns types specialties'],
    ['history', 'Admin: History', 'audit changes log'], ...(S.acct?.is_gelp !== false ? [['pricing', 'Admin: Pricing', 'pricing rules hourly hosting guardrails commission stripe payments']] : []),
    ...(atAgencyHome() ? [['accounts', 'Admin: Accounts', 'tenants clients customers']] : []), ...(S.acct?.platform_owner ? [['platform', 'Admin: Platform', 'white label brands agencies every account']] : [])] : []),
].map(([v, label, words]) => ({ v, label, words }));

function openSearch() {
  if ($('#gsOver')) return $('#gsQ').focus();
  const ov = document.createElement('div'); ov.id = 'gsOver'; ov.className = 'gsover';
  ov.innerHTML = `<div class="gsbox" role="dialog" aria-label="Search"><div class="gsin"><span aria-hidden="true">🔍</span>
      <input id="gsQ" type="search" placeholder="Search organizations, people, proposals, notes, screens…" autocomplete="off"><kbd>Esc</kbd></div>
    <div class="gsres" id="gsRes"><p class="hint" style="padding:10px 14px;margin:0">Type at least 2 letters. Tip: Ctrl+K opens this anywhere.</p></div></div>`;
  document.body.appendChild(ov);
  let items = [], at = 0, seq = 0;
  let offL = null;
  const close = (fromBack) => { ov.remove(); const o = offL; offL = null; if (o && fromBack !== true) o(); };
  offL = pushLayer(() => close(true));
  ov.onclick = (e) => { if (e.target === ov) close(); };
  const pick = (it) => { close(); it.go(); };
  const paint = (groups) => {
    items = groups.flatMap((g) => g.rows);
    $('#gsRes').innerHTML = items.length ? groups.filter((g) => g.rows.length).map((g) => `<div class="gsgroup"><small>${esc(g.title)}</small>${g.rows.map((r) => {
      const i = items.indexOf(r); return `<button type="button" class="gsitem ${i === at ? 'on' : ''}" data-gi="${i}"><b>${esc(r.title)}</b>${r.sub ? `<span>${esc(r.sub)}</span>` : ''}</button>`; }).join('')}</div>`).join('')
      : '<p class="hint" style="padding:10px 14px;margin:0">Nothing matches.</p>';
    $$('#gsRes [data-gi]').forEach((b) => (b.onclick = () => pick(items[+b.dataset.gi])));
  };
  const run = debounce(async () => {
    const raw = $('#gsQ').value.trim(), my = ++seq; at = 0;
    if (raw.length < 2) { $('#gsRes').innerHTML = '<p class="hint" style="padding:10px 14px;margin:0">Type at least 2 letters. Tip: Ctrl+K opens this anywhere.</p>'; return; }
    const t = raw.replace(/[%,()*\\]/g, ' ').trim(), low = t.toLowerCase(), digitsOnly = t.replace(/\D/g, '');
    // a screen matches when one of its words starts with what was typed ("site" finds Sites, not "website chat")
    const startsWord = (text) => { const words = text.toLowerCase().split(/[^a-z0-9]+/); const parts = low.split(/\s+/); return parts.every((q) => words.some((w) => w.startsWith(q))); };
    const screens = SCREENS().filter((s) => startsWord(s.label + ' ' + s.words)).sort((a, b) => startsWord(b.label) - startsWord(a.label)).slice(0, 5)
      .map((s) => ({ title: s.label.replace(/^Admin: /, ''), sub: screenPath(s.v) || 'Screen', go: () => go(s.v) }));
    const team = staff().filter((u) => !u.hidden_in_team && (u.full_name || '').toLowerCase().includes(low)).slice(0, 4)
      .map((u) => ({ title: u.full_name, sub: u.title || 'Team member', go: () => go('teamdir', u.id) }));
    paint([{ title: 'Screens', rows: screens }, { title: 'Team', rows: team }]);
    const orgOr = [`name.ilike.%${t}%`, `city.ilike.%${t}%`, `main_email.ilike.%${t}%`, ...(digitsOnly.length >= 4 ? [`main_phone.ilike.%${digitsOnly.slice(-4)}%`] : [])].join(',');
    const pplOr = [`first_name.ilike.%${t}%`, `last_name.ilike.%${t}%`, `personal_email.ilike.%${t}%`, ...(digitsOnly.length >= 4 ? [`personal_cell.ilike.%${digitsOnly.slice(-4)}%`] : [])].join(',');
    const two = t.split(/\s+/);
    const [orgs, ppl, ppl2, notes, props] = await Promise.all([
      divQ(sb.from('companies').select('id,name,city,state')).is('archived_at', null).or(orgOr).order('name').limit(6),
      sb.from('people').select('id,first_name,last_name,company_people(companies(name))').is('archived_at', null).or(pplOr).limit(6),
      two.length > 1 ? sb.from('people').select('id,first_name,last_name,company_people(companies(name))').is('archived_at', null).ilike('first_name', `${two[0]}%`).ilike('last_name', `${two.slice(1).join(' ')}%`).limit(4) : { data: [] },
      sb.from('activities').select('id,body,company_id,created_at,companies(name)').ilike('body', `%${t}%`).order('created_at', { ascending: false }).limit(4),
      S.acct?.is_gelp !== false ? sb.from('proposals').select('id,name,status,contact_name,expires_at,companies(name)').or(`contact_name.ilike.%${t}%,name.ilike.%${t}%`).order('updated_at', { ascending: false }).limit(4) : { data: [] },
    ]);
    if (my !== seq || !$('#gsOver')) return;
    // proposals by organization name too
    let propRows = props.data || [];
    const orgIds = (orgs.data || []).map((o) => o.id);
    if (S.acct?.is_gelp !== false && orgIds.length) {
      const { data: byOrg } = await sb.from('proposals').select('id,name,status,contact_name,expires_at,companies(name)').in('company_id', orgIds).order('updated_at', { ascending: false }).limit(4);
      propRows = [...propRows, ...(byOrg || []).filter((p) => !propRows.some((x) => x.id === p.id))].slice(0, 5);
      if (my !== seq || !$('#gsOver')) return;
    }
    const people = [...(ppl2.data || []), ...(ppl.data || [])].filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i).slice(0, 6);
    const snippet = (b) => { const i = b.toLowerCase().indexOf(low); const s = Math.max(0, i - 30); return (s ? '…' : '') + b.slice(s, s + 90) + (b.length > s + 90 ? '…' : ''); };
    const st = (p) => (p.status === 'sent' && p.expires_at && new Date(p.expires_at) < new Date() ? 'Expired' : { draft: 'Draft', sent: 'Sent', accepted: 'Accepted' }[p.status] || p.status);
    paint([
      { title: 'Organizations', rows: (orgs.data || []).map((o) => ({ title: o.name, sub: [o.city, o.state].filter(Boolean).join(', '), go: () => go('org', o.id) })) },
      { title: 'People', rows: people.map((p) => ({ title: [p.first_name, p.last_name].filter(Boolean).join(' '), sub: (p.company_people || []).map((l) => l.companies?.name).filter(Boolean).slice(0, 2).join(', '), go: () => go('people', p.id) })) },
      { title: 'Proposals', rows: propRows.map((p) => ({ title: p.companies?.name || 'Proposal', sub: [p.name, st(p), p.contact_name].filter(Boolean).join(' · '), go: () => go('proposal', p.id) })) },
      { title: 'Notes', rows: (notes.data || []).filter((n) => n.company_id).map((n) => ({ title: n.companies?.name || 'Note', sub: snippet(n.body || ''), go: () => go('org', n.company_id) })) },
      { title: 'Screens', rows: screens }, { title: 'Team', rows: team },
    ]);
  }, 220);
  $('#gsQ').oninput = run;
  $('#gsQ').onkeydown = (e) => {
    if (e.key === 'Escape') return close();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!items.length) return;
      at = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      $$('#gsRes [data-gi]').forEach((b) => b.classList.toggle('on', +b.dataset.gi === at));
      $(`#gsRes [data-gi="${at}"]`)?.scrollIntoView({ block: 'nearest' });
    }
    if (e.key === 'Enter' && items[at]) { e.preventDefault(); pick(items[at]); }
  };
  $('#gsQ').focus();
}
document.addEventListener('keydown', (e) => {
  if (!S.me?.active || S.me.role === 'vendor' || S.me.role === 'member') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
});

/* ================= install to home screen ================= */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; showInstallBanner(); });
window.addEventListener('appinstalled', () => { deferredInstall = null; $('#installBanner')?.remove(); });
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function installDismissed() { try { return localStorage.getItem('installDismissed') === '1'; } catch { return false; } }
function showInstallBanner() {
  if (isStandalone() || installDismissed() || $('#installBanner') || !S.me?.active) return;
  const ios = isIOS();
  if (!ios && !deferredInstall) return;
  const bar = document.createElement('div');
  bar.id = 'installBanner'; bar.className = 'installbar';
  bar.innerHTML = ios
    ? `<div><b>Add ${esc(brandTitle())} to your home screen</b><small>Tap the Share button <span class="shareicon">⬆︎</span> below, then “Add to Home Screen.”</small></div><button class="btn ghost small" id="instX">Not now</button>`
    : `<div><b>Install ${esc(brandTitle())}</b><small>Opens like an app, right from your home screen.</small></div><button class="btn gold small" id="instGo">Install</button><button class="btn ghost small" id="instX">Not now</button>`;
  document.body.appendChild(bar);
  $('#instX').onclick = () => { try { localStorage.setItem('installDismissed', '1'); } catch {} bar.remove(); };
  const ib = $('#instGo');
  if (ib) ib.onclick = async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; bar.remove(); };
}

boot().catch(fail);

// Chat box that keyboards can drop GIFs and stickers into (Gboard won't send pictures to a plain textarea).
// Behaves like a textarea for the rest of the code: .value, .selectionStart/End, .setSelectionRange.
function richBox(el, onImage, max) {
  if (!el || el._rich) return; el._rich = true;
  const text = () => el.textContent || '';
  const offsetOf = (node, off) => { const r = document.createRange(); r.selectNodeContents(el); try { r.setEnd(node, off); } catch { return text().length; } return r.toString().length; };
  const sel = () => { const s = window.getSelection(); return s && s.rangeCount && el.contains(s.getRangeAt(0).startContainer) ? s.getRangeAt(0) : null; };
  Object.defineProperty(el, 'value', { configurable: true, get: text, set: (v) => { el.textContent = v == null ? '' : String(v); } });
  Object.defineProperty(el, 'selectionStart', { configurable: true, get: () => { const r = sel(); return r ? offsetOf(r.startContainer, r.startOffset) : text().length; } });
  Object.defineProperty(el, 'selectionEnd', { configurable: true, get: () => { const r = sel(); return r ? offsetOf(r.endContainer, r.endOffset) : text().length; } });
  el.setSelectionRange = (a, b) => {
    const find = (pos) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n, left = pos;
      while ((n = w.nextNode())) { if (left <= n.length) return [n, left]; left -= n.length; } return [el, el.childNodes.length]; };
    const [sn, so] = find(a), [en, eo] = find(b ?? a), r = document.createRange();
    r.setStart(sn, so); r.setEnd(en, eo); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  };
  const put = (t) => { if (max && text().length + t.length > max) t = t.slice(0, Math.max(0, max - text().length)); if (t) document.execCommand('insertText', false, t); };
  // a new line is a real "\n" character (the box shows it with pre-wrap); a trailing <br> only holds the caret on an empty last line
  const newline = () => {
    if (max && text().length >= max) return;
    const r = sel(); if (!r) return; r.deleteContents();
    const n = document.createTextNode('\n'); r.insertNode(n);
    const at = offsetOf(n, 1);
    el.querySelectorAll('br').forEach((b) => b.remove());
    if (at === text().length) el.appendChild(document.createElement('br'));
    el.setSelectionRange(at, at);
  };
  const imageIn = (dt) => [...(dt?.files || [])].find((f) => f.type.startsWith('image/')) || [...(dt?.items || [])].filter((x) => x.kind === 'file' && x.type.startsWith('image/')).map((x) => x.getAsFile())[0];
  el.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') { e.preventDefault(); newline(); return; }
    if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop' || e.inputType === 'insertReplacementText') {
      const f = imageIn(e.dataTransfer); if (f) { e.preventDefault(); onImage(f); }
    }
  });
  el.addEventListener('paste', (e) => {
    const f = imageIn(e.clipboardData); e.preventDefault();
    if (f) return onImage(f);
    put(e.clipboardData?.getData('text/plain') || '');
  });
  el.addEventListener('drop', (e) => { const f = imageIn(e.dataTransfer); if (f) { e.preventDefault(); onImage(f); } });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); newline(); } });
  // anything else a keyboard slips in (an <img>, formatting): keep the picture, flatten the rest to plain text
  el.addEventListener('input', async () => {
    const img = el.querySelector('img');
    if (img) { const src = img.src; img.remove();
      try { const b = await (await fetch(src)).blob(); if (b.type.startsWith('image/')) onImage(new File([b], 'keyboard-image.' + (b.type.split('/')[1] || 'png'), { type: b.type })); }
      catch { toast('That picture could not be added. Save it and use the picture button instead.'); } }
    const extra = [...el.querySelectorAll('*')].filter((x) => !(x.tagName === 'BR' && x === el.lastChild));
    if (extra.length) { const at = el.selectionStart; el.textContent = text(); el.setSelectionRange(Math.min(at, text().length)); }
    if (!text()) el.innerHTML = '';
    if (max && text().length > max) { el.textContent = text().slice(0, max); el.setSelectionRange(max, max); }
  });
}
