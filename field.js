/* Field service, roles, labels and switches (Oct 29, 2026).
   Everything here plugs into app.js through init(ctx): app.js hands over its helpers, and calls the exported
   views and hooks. Nothing here runs for an account until it switches the matching feature on, except labels
   (which default to today's words) and roles (which default to what each person could already do). */

let C = null;          // the helpers from app.js
let sb, S, esc, $, $$;
export function init(ctx) { C = ctx; ({ sb, S, esc, $, $$ } = ctx); }

/* ================= feature switches ================= */
// default: true = on for every account until switched off; false = off until switched on
export const FEATURES = [
  { key: 'sales', label: 'Sales and pipeline', def: true, what: 'Deals, pipelines and the Sales tab' },
  { key: 'inbox', label: 'Inbox and live chat', def: true, what: 'Website chat and internal chat' },
  { key: 'sites', label: 'Sites and forms', def: true, what: 'Websites, forms and their leads' },
  { key: 'custom_fields', label: 'Custom fields', def: false, what: 'Your own fields on organizations, people and jobs' },
  { key: 'parent_locations', label: 'Parent locations', def: false, what: 'A location can belong to a parent (a management company), with billing and totals rolled up' },
  { key: 'location_nesting', label: 'Nesting', def: false, what: 'Parents can belong to parents (company, region, property)', needs: 'parent_locations' },
  { key: 'jobs', label: 'Jobs and repeat schedules', def: false, what: 'Jobs from proposals, Quick Add or bookings, and schedules that make them' },
  { key: 'dispatch', label: 'Dispatch and GPS check-in', def: false, what: 'The dispatch board, the worker steps and GPS pins', needs: 'jobs' },
  { key: 'costs', label: 'Other costs on jobs', def: false, what: 'Materials, parts and dump fees logged on a job', needs: 'jobs' },
  { key: 'timeclock', label: 'Time clock', def: false, what: 'Clock in and out with breaks and GPS' },
  { key: 'routes', label: 'Routes (Beta)', def: false, what: 'Stops in order on a schedule, Arrived and Left taps checked by GPS, and alerts when nobody starts on time', needs: 'timeclock' },
  { key: 'pay', label: 'Worker pay and payroll export', def: false, what: 'Pay rates, pay periods, pay batches and export files' },
  { key: 'accounting', label: 'Accounting connection', def: false, what: 'Send labor, contractor pay and invoices to Wave (QuickBooks and Xero later)' },
  { key: 'measure', label: 'Measuring', def: false, what: 'Draw on a satellite map for square and linear feet, count things by tapping and price it from your price book' },
  { key: 'bids', label: 'Bids', def: false, what: 'RFPs by email or upload, a go or no-go scorecard and win and loss tracking' },
  { key: 'portal', label: 'Client portal', def: false, what: 'Clients sign in to see their schedule, estimates, invoices and shared files and photos. They can message your team too' },
  { key: 'esign', label: 'E-sign', def: false, what: 'Send PDFs to sign with a code by email, a full event log and a signing certificate. Reusable templates too' },
  { key: 'calendars', label: 'Calendars', def: false, what: 'Booking pages customers use to pick a time, round robin across your team, reminders by email and a day, week and month calendar' },
  { key: 'phone', label: 'Phone', def: false, what: 'Phone numbers that ring your team in the CRM, voicemail, call recording and every call logged on the contact. Numbers are added by your agency' },
  { key: 'social', label: 'Social planner', def: true, what: 'Write, schedule and batch posts for Facebook and Instagram, with an optional approval step' },
];
// in the account's plan (set by its agency)? No plan means everything is allowed.
export const inPlan = (k) => !Array.isArray(S.plan?.allowed) || S.plan.allowed.includes(k);
export const feat = (k) => {
  if (!inPlan(k)) return false;
  const f = FEATURES.find((x) => x.key === k); const v = S.acctSettings?.features?.[k];
  const on = typeof v === 'boolean' ? v : !!f?.def;
  return on && (!f?.needs || feat(f.needs));
};

/* ================= labels ================= */
export const LABELS = [
  ['organization', 'Organization', 'Organizations'], ['person', 'Person', 'People'], ['contact', 'Contact', 'Contacts'],
  ['deal', 'Deal', 'Deals'], ['proposal', 'Proposal', 'Proposals'], ['job', 'Job', 'Jobs'], ['schedule', 'Repeat schedule', 'Repeat schedules'],
  ['worker', 'Worker', 'Workers'], ['division', 'Company', 'Companies'], ['parent', 'Parent', 'Parents'], ['pin', 'Check-in pin', 'Check-in pins'],
];
export const LABEL_PRESETS = {
  clinic: { name: 'Clinic (standard)', labels: {} },
  home_service: { name: 'Home service', labels: { organization: ['Location', 'Locations'], person: ['Contact', 'Contacts'], contact: ['Customer', 'Customers'],
    deal: ['Estimate', 'Estimates'], proposal: ['Estimate', 'Estimates'], worker: ['Technician', 'Technicians'], parent: ['Customer account', 'Customer accounts'] } },
  field_crew: { name: 'Field crew', labels: { organization: ['Property', 'Properties'], person: ['Contact', 'Contacts'], deal: ['Bid', 'Bids'],
    proposal: ['Bid', 'Bids'], worker: ['Crew member', 'Crew'], parent: ['Owner', 'Owners'] } },
  agency: { name: 'Agency', labels: { organization: ['Client', 'Clients'], person: ['Contact', 'Contacts'] } },
};
// L('organization') -> "Location"; L('organization', true) -> "Locations". Platform default, then white label, then account.
export function L(key, many = false) {
  const base = LABELS.find((x) => x[0] === key) || [key, key, key + 's'];
  const wl = S.acct?.brand?.labels?.[key];
  const own = S.acctSettings?.labels?.[key];
  const pick = own || wl;
  return pick ? (many ? pick.many : pick.one) : (many ? base[2] : base[1]);
}
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1);
export const l = (key, many) => lower(L(key, many));

/* ================= permissions ================= */
export const AREAS = [
  ['contacts', 'Contacts'], ['sales', 'Sales and pipeline'], ['proposals', 'Proposals'], ['inbox', 'Inbox'], ['sites', 'Sites'],
  ['jobs', 'Jobs'], ['dispatch', 'Dispatch'], ['timeclock', 'Time clock'], ['costs', 'Other costs'], ['pay', 'Pay and payroll'],
  ['review', 'Review and approvals'], ['reports', 'Reports and dashboard money'], ['settings', 'Settings'], ['team', 'Team and roles'], ['invoices', 'Invoices and payments'], ['bids', 'Bids'], ['esign', 'E-sign', ['View', 'Send their own', 'Void anyone\'s', 'Manage']],
  ['calendars', 'Calendars and bookings', ['See appointments', 'Book and change, keep own hours', 'Change anyone\'s hours', 'Set up booking calendars']],
  ['automations', 'Automations and webhooks'], ['marketing', 'Links, QR codes and campaigns'],
  ['templates', 'Templates and saved replies', ['Use', 'Save their own', 'Publish to a department or everyone', 'Manage']],
  ['media', 'Media and brand kit', ['View', 'Upload their own', 'Publish and share', 'Manage']],
];
export const LEVELS = ['Off', 'View', 'Edit', 'Approve', 'Manage'];
export const SCOPES = [['own', 'Own'], ['division', 'Company'], ['all', 'All']];
export async function loadPerms() {
  const { data } = await sb.rpc('my_perms');
  S.perms = data || null;
}
// can('jobs', 2): may edit jobs. Before the database knows roles (migration not applied), fall back to admin or not.
export const can = (area, lvl = 1) => {
  if (C.isAdmin()) return true;
  if (!S.perms) return lvl <= 2 && area !== 'pay' && area !== 'settings' && area !== 'team';
  return (S.perms[area]?.level || 0) >= lvl;
};
export const scopeOf = (area) => (C.isAdmin() ? 'all' : S.perms?.[area]?.scope || 'own');
export const needsMfa = () => !!S.acctSettings?.require_mfa && S.perms?._aal !== 'aal2';

/* ================= small helpers ================= */
const money2 = (n) => (n == null || n === '' ? '' : (Number(n) < 0 ? '-$' : '$') + Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtTime = (s) => (s ? new Date(s).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');
const fmtDT = (s) => (s ? new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const localInput = (s) => { if (!s) return ''; const d = new Date(s); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocal = (v) => (v ? new Date(v).toISOString() : null);
const dayStart = (d) => { const x = new Date(d + 'T00:00:00'); return x.toISOString(); };
const dayEnd = (d) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + 1); return x.toISOString(); };
const isoDay = (date) => { const d = new Date(date); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const shiftDay = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return isoDay(x); };
const hrsOf = (t) => (t.clock_out ? Math.max((new Date(t.clock_out) - new Date(t.clock_in)) / 3600000 - (t.break_min || 0) / 60, 0) : 0);
const workers = () => C.staff();
const workerOptions = (sel, blank = 'Unassigned') => `<option value="">${esc(blank)}</option>` + workers().map((u) => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('');
/* crews (071): account settings and the saved crews */
const crewSet = () => S.acctSettings?.crews || {};
export const crewMode = () => (crewSet().mode === 'standing' ? 'standing' : 'pick');
const crewOpt = (service, k) => crewSet().by_service?.[service || '']?.[k] || crewSet()[k] || { clock: 'self', steps: 'foreman', pay: 'hours' }[k];
const canCrews = () => can('dispatch', 3) || can('jobs', 4);
async function loadCrews(force) {
  if (S.crews && !force) return S.crews;
  const { data } = await sb.from('crews').select('*').is('archived_at', null).order('sort').order('name');
  S.crews = data || []; return S.crews;
}
const firstName = (id) => (C.userName(id) || '').split(' ')[0];
// "Bob, Joe, Bill" for a job's crew rows (lead first)
const crewNames = (rows, max = 4) => {
  const r = [...(rows || [])].sort((a, b) => (a.role === 'lead' ? -1 : 0) - (b.role === 'lead' ? -1 : 0));
  const n = r.map((x) => firstName(x.user_id)); return n.length > max ? n.slice(0, max).join(', ') + ` +${n.length - max}` : n.join(', ');
};
// job crew rows for a list of jobs: { jobId: [rows] }
async function crewFor(ids) {
  const out = {}; if (!ids.length) return out;
  const { data } = await sb.from('job_crew').select('job_id,user_id,role,absent,arrived_at,left_at').in('job_id', ids).is('removed_at', null);
  (data || []).forEach((r) => (out[r.job_id] ||= []).push(r)); return out;
}
// ids of the jobs someone is on (lead or crew)
async function jobsOn(userId) {
  const { data } = await sb.from('job_crew').select('job_id').eq('user_id', userId).is('removed_at', null).limit(1000);
  return [...new Set((data || []).map((r) => r.job_id))];
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
// the phone's location, or null when it can't be had (denied, no GPS, timed out)
export function where(timeout = 12000) {
  return new Promise((ok) => {
    if (!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      () => ok(null), { enableHighAccuracy: true, timeout, maximumAge: 15000 });
  });
}
const mapLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
async function uploadPhoto(file, folder = 'jobs') {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
  const path = `${S.acct.id}/${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await sb.storage.from('job-photos').upload(path, file, { contentType: file.type || 'image/jpeg', upsert: false });
  if (error) throw error;
  return path;
}
async function signed(paths) {
  const list = [...new Set(paths.filter(Boolean))]; if (!list.length) return {};
  const { data } = await sb.storage.from('job-photos').createSignedUrls(list, 3600);
  return Object.fromEntries((data || []).filter((x) => x.signedUrl).map((x) => [x.path, x.signedUrl]));
}
const STATUS = { scheduled: 'Scheduled', accepted: 'Accepted', en_route: 'En route', arrived: 'Arrived', started: 'Started', completed: 'Completed', left: 'Left', cancelled: 'Cancelled', no_show: 'No-show' };
const NEXT = { scheduled: 'accepted', accepted: 'en_route', en_route: 'arrived', arrived: 'started', started: 'completed', completed: 'left' };
const STEP_BTN = { accepted: 'Accept', en_route: 'On my way', arrived: 'Arrived', started: 'Start work', completed: 'Completed', left: 'Leaving' };
const APPROVAL = { none: '', pending: 'Waiting on approval', approved: 'Approved', auto: 'Auto-approved', returned: 'Sent back' };
const FLAG = { far_arrive: 'Arrived far from the pin', far_leave: 'Left far from the pin', no_gps: 'No GPS', late: 'Ran late', over_cost: 'Costs over limit', problem: 'Problem reported',
  far_in: 'Clocked in far away', far_out: 'Clocked out far away', edited: 'Changed by a manager', added_by_foreman: 'Added by the foreman', by_foreman: 'Clocked by the foreman' };
const CATS = [['materials', 'Materials'], ['parts', 'Parts'], ['disposal', 'Disposal and dump fees'], ['equipment', 'Equipment'], ['fuel', 'Fuel'], ['supplies', 'Supplies'], ['subcontract', 'Subcontract'], ['other', 'Other']];
const statusBadge = (j) => `<span class="badge js-${esc(j.status)}">${esc(STATUS[j.status] || j.status)}</span>${APPROVAL[j.approval] ? ` <span class="badge ${j.approval === 'returned' ? 'due' : j.approval === 'pending' ? 'gold' : 'ok'}">${esc(APPROVAL[j.approval])}</span>` : ''}`;
const flagBadges = (fl) => (fl || []).map((f) => `<span class="badge due">${esc(FLAG[f] || f)}</span>`).join(' ');
const jobWhen = (j) => (j.scheduled_start ? `${C.fmtDate(j.scheduled_start)} ${fmtTime(j.scheduled_start)}${j.scheduled_end ? '–' + fmtTime(j.scheduled_end) : ''}` : 'Not scheduled');

/* ================= nav pieces app.js adds when features are on ================= */
// Routes (Beta) sit with Jobs or Time, for the people who build and dispatch them (workers use My Day)
const routesNav = () => feat('routes') && (C.isAdmin() || can('dispatch', 3));
const ROUTES_DV = { id: 'routes', label: 'Routes', match: ['routes'] };
export function folders() {
  const out = [];
  if (feat('jobs') && (can('jobs', 1) || can('dispatch', 1))) {
    const dv = [{ id: 'jobs', label: L('job', true), match: ['jobs', 'job'] }];
    if (feat('dispatch') && can('dispatch', 1)) dv.push({ id: 'dispatch', label: 'Dispatch', match: ['dispatch'] });
    if (can('jobs', 1)) dv.push({ id: 'schedules', label: L('schedule', true), match: ['schedules'] });
    if (crewMode() === 'standing' && (can('dispatch', 1) || can('jobs', 1))) dv.push({ id: 'crews', label: 'Crews', match: ['crews'] });
    if (feat('timeclock') && can('timeclock', 1)) dv.push({ id: 'time', label: 'Time', match: ['time'] });
    if (feat('pay') && can('pay', 1)) dv.push({ id: 'pay', label: 'Pay', match: ['pay'] });
    if (routesNav()) dv.push(ROUTES_DV);
    out.push({ id: 'jobs', side: 'CR', label: L('job', true), icon: '⚒', views: ['jobs', 'job', 'dispatch', 'schedules', 'crews', 'time', 'pay', 'routes'], dividers: dv });
  } else if (feat('timeclock') && can('timeclock', 1)) {
    const dv = [{ id: 'time', label: 'Time', match: ['time'] }];
    if (feat('pay') && can('pay', 1)) dv.push({ id: 'pay', label: 'Pay', match: ['pay'] });
    if (routesNav()) dv.push(ROUTES_DV);
    out.push({ id: 'time', side: 'CR', label: 'Time', icon: '⏱', views: ['time', 'pay', 'routes'], dividers: dv });
  }
  return out;
}
export function adminItems() {
  const items = [{ id: 'roles', label: 'Roles', match: ['roles'], what: 'Who can see and do what, feature by feature' }];
  if (feat('accounting') && (can('pay', 1) || can('settings', 4))) items.push({ id: 'accounting', label: 'Accounting', match: ['accounting'], what: 'Your accounting connection, account mapping and the sync log' });
  return items;
}
export const views = () => ({ jobs: viewJobs, job: viewJob, dispatch: viewDispatch, schedules: viewSchedules, crews: viewCrews, time: viewTime, pay: viewPay, roles: viewRoles, accounting: viewAccounting });
export const parents = { jobs: 'dashboard', job: 'jobs', dispatch: 'jobs', schedules: 'jobs', crews: 'jobs', time: 'myday', pay: 'jobs', roles: 'tools', accounting: 'tools' };

/* ================= MFA (two-step sign in) ================= */
// returns true when the person still has to pass the second step before using the CRM
export async function mfaGate(renderAuthCard) {
  try {
    const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (!data || data.currentLevel === 'aal2' || data.nextLevel !== 'aal2') return false;
  } catch { return false; }
  const { data: f } = await sb.auth.mfa.listFactors();
  const totp = (f?.totp || []).find((x) => x.status === 'verified');
  if (!totp) return false;
  renderAuthCard(`<h2>Two-step sign in</h2><p>Open your authenticator app and type the 6-digit code for this CRM.</p>
    <form id="mfaF"><label class="label" for="mfaCode">Code</label><input id="mfaCode" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
    <div class="err" id="mfaErr"></div><div class="actions"><button class="btn block">Continue</button></div></form>
    <div class="actions"><button class="btn ghost small" id="mfaOut">Sign out</button></div>`);
  $('#mfaOut').onclick = () => sb.auth.signOut();
  $('#mfaF').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: totp.id, code: $('#mfaCode').value.trim() });
    if (error) { $('#mfaErr').textContent = 'That code didn\'t work. Codes change every 30 seconds, so try the newest one.'; return; }
    location.reload();
  };
  return true;
}
// gear menu: set up or remove two-step sign in
export async function mfaSetup() {
  const { data: f } = await sb.auth.mfa.listFactors();
  const on = (f?.totp || []).find((x) => x.status === 'verified');
  if (on) {
    const d = dlg('mfaDlg', `<div class="vhead"><h2 style="margin:0">Two-step sign in is on</h2><button class="btn ghost small" data-x>Close</button></div>
      <p>You sign in with your password and a code from your authenticator app.</p>
      ${S.acctSettings?.require_mfa ? '<p class="hint">Your account requires it for approvals, payroll and settings, so turning it off will lock those for you.</p>' : ''}
      <div class="actions"><button class="btn ghost small danger" id="mfaOff">Turn it off</button></div>`);
    $('[data-x]', d).onclick = () => d.close();
    $('#mfaOff', d).onclick = async () => { const { error } = await sb.auth.mfa.unenroll({ factorId: on.id }); if (error) return C.fail(error); C.toast('Two-step sign in is off'); d.close(); };
    return;
  }
  // clear out an unfinished setup first
  for (const x of (f?.all || []).filter((x) => x.status !== 'verified')) await sb.auth.mfa.unenroll({ factorId: x.id });
  const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator ' + new Date().toISOString().slice(0, 10) });
  if (error) return C.fail(error);
  const d = dlg('mfaDlg', `<div class="vhead"><h2 style="margin:0">Set up two-step sign in</h2><button class="btn ghost small" data-x>Close</button></div>
    <p>1. Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy) and scan this code.</p>
    <div class="mfaqr"><img src="${esc(data.totp.qr_code)}" alt="Scan this with your authenticator app" width="200" height="200"></div>
    <small class="hint">Can't scan? Type this key into the app: <code>${esc(data.totp.secret)}</code></small>
    <p>2. Type the 6-digit code the app shows.</p>
    <form id="mfaV"><input id="mfaC" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required aria-label="Code"><div class="actions"><button class="btn">Turn it on</button></div></form>`);
  $('[data-x]', d).onclick = () => d.close();
  $('#mfaV', d).onsubmit = async (e) => {
    e.preventDefault();
    const { error: e2 } = await sb.auth.mfa.challengeAndVerify({ factorId: data.id, code: $('#mfaC', d).value.trim() });
    if (e2) return C.toast('That code didn\'t work. Try the newest one.', { error: true });
    C.toast('Two-step sign in is on'); d.close(); await loadPerms();
  };
}

/* ================= Settings: features, labels, rules, custom fields, presets ================= */
async function saveSettings(p, msg = 'Saved') {
  const { data, error } = await sb.rpc('account_settings_save', { p });
  if (error) { C.fail(error); return false; }
  S.acctSettings = data || {}; C.toast(msg); return true;
}
// app.js calls this at the end of Settings
export async function settingsCards(box) {
  const st = S.acctSettings || {};
  const aa = st.auto_approve || {}; const aj = aa.jobs || {}; const at = aa.timesheets || {};
  const ot = st.pay_settings?.overtime || { weekly_over: 40, mult: 1.5 };
  box.innerHTML = `
    <div class="card" id="setFeatures"><h2>Features</h2>
      <small class="hint" style="margin:-4px 0 10px">Turn whole features on or off for everyone in this account. Off means its tabs, buttons, widgets and fields never show.${Array.isArray(S.plan?.allowed) && !S.plan.agency_view ? ` These are the features in your plan. To add more, ask ${esc(S.plan.billing?.agency || 'your provider')}.` : ''}</small>
      ${FEATURES.filter((f) => inPlan(f.key)).map((f) => `<label class="check featrow"><input type="checkbox" data-feat="${f.key}" ${feat(f.key) ? 'checked' : ''} ${f.needs && !feat(f.needs) ? 'disabled' : ''}>
        <span><b>${esc(f.label)}</b><small class="hint" style="margin:0">${esc(f.what)}${f.needs ? ` (needs ${esc(FEATURES.find((x) => x.key === f.needs).label)})` : ''}</small></span></label>`).join('')}
    </div>
    <div class="card" id="setLabels"><h2>Words the CRM uses</h2>
      <small class="hint" style="margin:-4px 0 10px">Rename the built-in names to fit how you talk. Start from a preset, then change any word. Custom fields are named when you make them, so they aren't here.</small>
      <div class="chips">${Object.entries(LABEL_PRESETS).map(([k, p]) => `<button type="button" class="chip ${st.label_preset === k || (!st.label_preset && k === 'clinic') ? 'on' : ''}" data-lp="${k}">${esc(p.name)}</button>`).join('')}</div>
      <div class="tw" style="margin-top:10px"><table class="ptable"><thead><tr><th>Built in</th><th>One</th><th>More than one</th></tr></thead><tbody>
      ${LABELS.map(([k, one, many]) => `<tr><td>${esc(one)}</td><td><input type="text" data-l1="${k}" value="${esc(L(k))}" maxlength="40" aria-label="${esc(one)}, one"></td>
        <td><input type="text" data-l2="${k}" value="${esc(L(k, true))}" maxlength="40" aria-label="${esc(one)}, more than one"></td></tr>`).join('')}</tbody></table></div>
      <div class="actions"><button class="btn small" id="lblSave">Save words</button></div>
    </div>
    <div class="card" id="setCF"></div>
    ${feat('dispatch') || feat('timeclock') ? `<div class="card"><h2>GPS check-in</h2>
      <label class="label" for="gpsFt">How close counts as there (feet)</label>
      <div class="pline"><input type="number" id="gpsFt" min="50" max="10000" step="50" value="${esc(st.gps_radius_ft || 500)}"><button class="btn small" id="gpsSave">Save</button></div>
      <small class="hint">Default 500. Phone GPS can drift a hundred feet or more, especially indoors. Each ${esc(l('organization'))} or pin can have its own.</small></div>` : ''}
    ${feat('jobs') ? '<div class="card" id="setCrews"></div>' : ''}
    ${feat('jobs') || feat('timeclock') ? `<div class="card"><h2>Auto-approve</h2>
      <small class="hint" style="margin:-4px 0 10px">Clean work can skip Review. It still lands there, marked done, under the Auto-approved shortcut.</small>
      ${feat('jobs') ? `<h3 class="section">Finished ${esc(l('job', true))}</h3>
      <label class="check"><input type="checkbox" id="aaJ" ${aj.on ? 'checked' : ''}> Auto-approve finished ${esc(l('job', true))} that pass every rule below</label>
      <label class="check"><input type="checkbox" id="aaJr" ${aj.in_radius !== false ? 'checked' : ''}> Arrived and left inside the GPS distance</label>
      <label class="check"><input type="checkbox" id="aaJt" ${aj.on_time !== false ? 'checked' : ''}> Finished within the scheduled window, plus <input type="number" id="aaJg" min="0" max="600" value="${esc(aj.grace_min ?? 30)}" style="width:80px"> minutes</label>
      <label class="check"><input type="checkbox" id="aaJf" ${aj.no_flags !== false ? 'checked' : ''}> No problems or other flags</label>
      <label class="check">Other costs no more than $<input type="number" id="aaJc" min="0" step="1" value="${esc(aj.max_costs ?? '')}" placeholder="any" style="width:110px"></label>` : ''}
      ${feat('timeclock') ? `<h3 class="section">Timesheets</h3>
      <label class="check"><input type="checkbox" id="aaT" ${at.on ? 'checked' : ''}> Auto-approve timesheets that pass every rule below</label>
      <label class="check"><input type="checkbox" id="aaTr" ${at.in_radius !== false ? 'checked' : ''}> Clocked in and out inside the GPS distance</label>
      <label class="check">No more than <input type="number" id="aaTh" min="1" max="24" step="0.5" value="${esc(at.max_hours ?? 12)}" style="width:80px"> hours</label>` : ''}
      <div class="actions"><button class="btn small" id="aaSave">Save rules</button></div></div>` : ''}
    ${feat('costs') ? '<div class="card" id="setCosts"></div>' : ''}
    ${feat('pay') ? `<div class="card"><h2>Pay</h2>
      <label class="check"><input type="checkbox" id="payMix" ${st.mixed_pay_types !== false ? 'checked' : ''}> Let one person have more than one pay type (hourly for one company, per job for another)</label>
      <div class="row"><div><label class="label" for="otW">Overtime after this many hours a week (W-2 hourly)</label><input type="number" id="otW" min="0" max="80" value="${esc(ot.weekly_over ?? 40)}"></div>
        <div><label class="label" for="otM">Overtime pays</label><select id="otM">${[1, 1.5, 2].map((m) => `<option value="${m}" ${Number(ot.mult) === m ? 'selected' : ''}>${m === 1 ? 'Straight time' : m + 'x'}</option>`).join('')}</select></div></div>
      <small class="hint">Check your state's overtime rules with your payroll provider. Your payroll system has the final say.</small>
      <div class="actions"><button class="btn small" id="paySave">Save pay settings</button></div></div>` : ''}
    <div class="card"><h2>Security</h2>
      <label class="check"><input type="checkbox" id="reqMfa" ${st.require_mfa ? 'checked' : ''}> Require two-step sign in for anyone who approves, exports payroll or manages settings</label>
      <small class="hint">People set it up from the gear menu. Until they do, approving and exporting stay locked for them. Turn on your own first.</small></div>`;

  $$('[data-feat]', box).forEach((cb) => (cb.onchange = async () => {
    const k = cb.dataset.feat, v = cb.checked, p = { [k]: v };
    FEATURES.filter((f) => f.needs === k && !v).forEach((f) => (p[f.key] = false));
    if (await saveSettings({ features: p }, `${FEATURES.find((f) => f.key === k).label} ${v ? 'on' : 'off'}`)) { await loadPerms(); C.renderShell(); }
  }));
  $$('[data-lp]', box).forEach((b) => (b.onclick = () => {
    const p = LABEL_PRESETS[b.dataset.lp];
    LABELS.forEach(([k, one, many]) => { const w = p.labels[k] || [one, many]; $(`[data-l1="${k}"]`, box).value = w[0]; $(`[data-l2="${k}"]`, box).value = w[1]; });
    $$('[data-lp]', box).forEach((x) => x.classList.toggle('on', x === b)); box.dataset.lp = b.dataset.lp;
  }));
  $('#lblSave', box).onclick = async () => {
    const labels = {};
    for (const [k, one, many] of LABELS) {
      const a = $(`[data-l1="${k}"]`, box).value.trim(), b = $(`[data-l2="${k}"]`, box).value.trim();
      if (!a || !b) return C.toast(`Fill in both words for ${one}`, { error: true });
      if (a !== one || b !== many) labels[k] = { one: a, many: b };
    }
    if (await saveSettings({ labels, ...(box.dataset.lp ? { label_preset: box.dataset.lp } : {}) }, 'Words saved')) C.renderShell();
  };
  if ($('#gpsSave', box)) $('#gpsSave', box).onclick = () => { const n = Number($('#gpsFt', box).value); if (!(n >= 50 && n <= 10000)) return C.toast('Use 50 to 10,000 feet', { error: true }); saveSettings({ gps_radius_ft: n }); };
  if ($('#aaSave', box)) $('#aaSave', box).onclick = () => {
    const v = (id) => $(id, box);
    const auto = { ...(st.auto_approve || {}) };
    if (v('#aaJ')) auto.jobs = { on: v('#aaJ').checked, in_radius: v('#aaJr').checked, on_time: v('#aaJt').checked, grace_min: Number(v('#aaJg').value) || 0, no_flags: v('#aaJf').checked,
      ...(v('#aaJc').value !== '' ? { max_costs: Number(v('#aaJc').value) } : {}) };
    if (v('#aaT')) auto.timesheets = { on: v('#aaT').checked, in_radius: v('#aaTr').checked, max_hours: Number(v('#aaTh').value) || 12 };
    saveSettings({ auto_approve: auto }, 'Auto-approve rules saved');
  };
  if ($('#paySave', box)) $('#paySave', box).onclick = () => saveSettings({ mixed_pay_types: $('#payMix', box).checked,
    pay_settings: { ...(st.pay_settings || {}), overtime: { weekly_over: Number($('#otW', box).value) || null, mult: Number($('#otM', box).value) } } }, 'Pay settings saved');
  $('#reqMfa', box).onchange = async (e) => {
    if (e.target.checked && S.perms?._aal !== 'aal2') {
      const { data: f } = await sb.auth.mfa.listFactors();
      if (!(f?.totp || []).some((x) => x.status === 'verified')) { e.target.checked = false; return C.toast('Set up your own two-step sign in first (gear menu), so you don\'t lock yourself out', { error: true }); }
    }
    if (await saveSettings({ require_mfa: e.target.checked })) await loadPerms();
  };
  if (feat('custom_fields')) drawCustomFieldSettings($('#setCF', box)); else $('#setCF', box).remove();
  if ($('#setCosts', box)) drawCostPresets($('#setCosts', box));
  if ($('#setCrews', box)) drawCrewSettings($('#setCrews', box));
}


/* ================= crew settings ================= */
function drawCrewSettings(box) {
  const c = { mode: 'pick', clock: 'self', steps: 'foreman', pay: 'hours', ...(S.acctSettings?.crews || {}) };
  const svc = Object.entries(c.by_service || {});
  const radio = (k, v, label, hint) => `<label class="check"><input type="radio" name="cr_${k}" value="${v}" ${c[k] === v ? 'checked' : ''}> <span><b>${esc(label)}</b>${hint ? `<small class="hint" style="margin:0">${esc(hint)}</small>` : ''}</span></label>`;
  const sel = (k, v, opts) => `<select data-sk="${k}">${opts.map(([o, n]) => `<option value="${o}" ${v === o ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  const svcRow = (name = '', o = {}) => `<div class="svcrow"><div><input type="text" data-sn value="${esc(name)}" maxlength="80" placeholder="Service, like Striping" list="crSvcL" aria-label="Service"></div>
    <div>${sel('clock', o.clock || c.clock, [['self', 'Everyone clocks in'], ['foreman', 'Foreman clocks the crew']])}</div><div>${sel('steps', o.steps || c.steps, [['foreman', 'Foreman marks arrived and left'], ['each', 'Each person marks their own']])}</div>
    <div style="flex:0"><button type="button" class="btn ghost small danger" data-srm aria-label="Remove">✕</button></div></div>`;
  box.innerHTML = `<h2>Crews</h2>
    <h3 class="section">How people go on a ${esc(l('job'))}</h3>
    ${radio('mode', 'standing', 'Standing crews', 'Save crews (a foreman plus the people always with them) and put a whole crew on a job. Anyone can still be pulled onto another job.')}
    ${radio('mode', 'pick', 'No crews, pick people for each job', 'Pick one person or several on each job.')}
    ${feat('timeclock') ? `<h3 class="section">Clocking in</h3>${radio('clock', 'self', 'Everyone clocks themselves in and out', 'When the foreman marks arrived and someone on the crew never clocked in, the foreman and supervisor get a crew check.')}${radio('clock', 'foreman', 'The foreman clocks the whole crew in and out')}` : ''}
    ${feat('dispatch') ? `<h3 class="section">Arrived and left</h3>${radio('steps', 'foreman', 'The foreman marks arrived and left for the crew (with GPS)')}${radio('steps', 'each', 'Each person also marks their own arrived and left (with GPS)')}` : ''}
    ${feat('pay') ? `<h3 class="section">Pay on crew ${esc(l('job', true))}</h3>${radio('pay', 'hours', 'Each person by their own hours and rate', 'Pay set on the job goes to the foreman, like before.')}${radio('pay', 'split', 'Split the job\'s pay across the crew', 'Equal shares by default. Hours on that job aren\'t paid on top.')}` : ''}
    <h3 class="section">Different for some services</h3><small class="hint" style="margin:-4px 0 6px">Optional. Each line overrides clocking and arrived and left for one service type.</small>
    <datalist id="crSvcL">${(C.lk('service') || []).map((x) => `<option>${esc(x)}</option>`).join('')}</datalist>
    <div id="crSvc">${svc.map(([n, o]) => svcRow(n, o)).join('')}</div>
    <div class="actions"><button type="button" class="btn ghost small" id="crSvcAdd">+ Service</button><button class="btn small" id="crSave">Save crew settings</button></div>`;
  const bindRm = () => $$('[data-srm]', box).forEach((b) => (b.onclick = () => b.closest('.svcrow').remove()));
  bindRm();
  $('#crSvcAdd', box).onclick = () => { $('#crSvc', box).insertAdjacentHTML('beforeend', svcRow()); bindRm(); };
  $('#crSave', box).onclick = async () => {
    const v = (k) => $(`[name="cr_${k}"]:checked`, box)?.value || c[k];
    const by = {};
    for (const r of $$('.svcrow', box)) { const n = $('[data-sn]', r).value.trim(); if (n) by[n] = { clock: $('[data-sk="clock"]', r).value, steps: $('[data-sk="steps"]', r).value }; }
    if (await saveSettings({ crews: { mode: v('mode'), clock: v('clock'), steps: v('steps'), pay: v('pay'), by_service: by } }, 'Crew settings saved')) { S.crews = null; C.renderShell(); }
  };
}

/* ================= custom fields ================= */
const CF_TYPES = [['text', 'Short text'], ['long_text', 'Long text'], ['number', 'Number'], ['money', 'Money'], ['date', 'Date'], ['select', 'Pick one'], ['multi_select', 'Pick several'],
  ['checkbox', 'Yes / no'], ['phone', 'Phone'], ['email', 'Email'], ['url', 'Link']];
const CF_ENT = () => [['companies', L('organization', true)], ['people', L('person', true)], ...(feat('jobs') ? [['jobs', L('job', true)]] : [])];
export async function loadCustomFields(force) {
  if (!feat('custom_fields')) { S.cfields = []; return []; }
  if (!force && S.cfields) return S.cfields;
  const { data } = await sb.from('custom_fields').select('*').is('archived_at', null).order('sort').order('created_at');
  S.cfields = data || []; return S.cfields;
}
async function drawCustomFieldSettings(box) {
  const fields = await loadCustomFields(true);
  box.innerHTML = `<h2>Custom fields</h2><small class="hint" style="margin:-4px 0 10px">Your own fields. They show on the record. Removing one hides it; what people typed stays.</small>
    ${CF_ENT().map(([e, name]) => `<h3 class="section">${esc(name)}</h3>${fields.filter((f) => f.entity === e).map((f) => `<div class="listrow"><b style="flex:1">${esc(f.label)}</b>
      <small>${esc(CF_TYPES.find((t) => t[0] === f.type)?.[1] || f.type)}${f.options?.length ? ': ' + esc(f.options.join(', ')) : ''}${f.required ? ' · required' : ''}</small>
      <button class="btn ghost small danger" data-cfrm="${f.id}">Remove</button></div>`).join('') || '<p class="empty">None yet.</p>'}`).join('')}
    <h3 class="section">Add a field</h3>
    <div class="row"><div><label class="label" for="cfE">On</label><select id="cfE">${CF_ENT().map(([e, n]) => `<option value="${e}">${esc(n)}</option>`).join('')}</select></div>
      <div><label class="label" for="cfT">Type</label><select id="cfT">${CF_TYPES.map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join('')}</select></div></div>
    <label class="label" for="cfL">Name</label><input type="text" id="cfL" maxlength="60" placeholder="Gate code, Dumpster size, Preferred day">
    <div id="cfOptWrap" hidden><label class="label" for="cfO">Choices (comma between each)</label><input type="text" id="cfO" placeholder="Small, Medium, Large"></div>
    <label class="check"><input type="checkbox" id="cfR"> Required</label>
    <div class="actions"><button class="btn small" id="cfAdd">Add field</button></div>`;
  $('#cfT', box).onchange = (e) => ($('#cfOptWrap', box).hidden = !/select/.test(e.target.value));
  $('#cfAdd', box).onclick = async () => {
    const label = $('#cfL', box).value.trim(); if (!label) return C.toast('Name the field first', { error: true });
    const type = $('#cfT', box).value, entity = $('#cfE', box).value;
    const options = /select/.test(type) ? $('#cfO', box).value.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (/select/.test(type) && !options.length) return C.toast('Add at least one choice', { error: true });
    let key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36) || 'field';
    if (!/^[a-z]/.test(key)) key = 'f_' + key;
    while (fields.some((f) => f.entity === entity && f.key === key)) key = key.slice(0, 34) + '_' + Math.floor(Math.random() * 9);
    const { error } = await sb.from('custom_fields').insert({ entity, key, label, type, options, required: $('#cfR', box).checked, sort: fields.length * 10 });
    if (error) return C.fail(error); C.toast('Field added'); drawCustomFieldSettings(box);
  };
  $$('[data-cfrm]', box).forEach((b) => (b.onclick = async () => {
    if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Remove it?'; return; }
    const { error } = await sb.from('custom_fields').update({ archived_at: new Date().toISOString() }).eq('id', b.dataset.cfrm);
    if (error) return C.fail(error); C.toast('Field removed'); drawCustomFieldSettings(box);
  }));
}
// the custom fields on one record. save(customObject) writes it.
export async function customFieldsBox(box, entity, record, save, editable = true) {
  if (!box) return;
  const fields = (await loadCustomFields()).filter((f) => f.entity === entity);
  if (!fields.length) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  const vals = { ...(record.custom || {}) };
  const input = (f) => {
    const v = vals[f.key], id = `cf_${entity}_${f.key}`, dis = editable ? '' : 'disabled';
    if (f.type === 'long_text') return `<textarea id="${id}" data-cf="${f.key}" ${dis}>${esc(v || '')}</textarea>`;
    if (f.type === 'checkbox') return `<label class="check"><input type="checkbox" id="${id}" data-cf="${f.key}" ${v ? 'checked' : ''} ${dis}> ${esc(f.label)}</label>`;
    if (f.type === 'select') return `<select id="${id}" data-cf="${f.key}" ${dis}><option value=""></option>${f.options.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    if (f.type === 'multi_select') return `<div class="chips" data-cfm="${f.key}">${f.options.map((o) => `<button type="button" class="chip ${(v || []).includes(o) ? 'on' : ''}" data-o="${esc(o)}" ${dis}>${esc(o)}</button>`).join('')}</div>`;
    const t = { number: 'number', money: 'number', date: 'date', phone: 'tel', email: 'email', url: 'url' }[f.type] || 'text';
    return `<input type="${t}" id="${id}" data-cf="${f.key}" value="${esc(v ?? '')}" ${f.type === 'money' ? 'step="0.01"' : ''} ${dis}>`;
  };
  box.innerHTML = `<h2>More details</h2>${fields.map((f) => f.type === 'checkbox' ? input(f) : `<label class="label" for="cf_${entity}_${f.key}">${esc(f.label)}${f.required ? ' *' : ''}</label>${input(f)}`).join('')}`;
  if (!editable) return;
  const commit = async () => { if (await save({ ...vals }) !== false) C.toast('Saved'); };
  $$('[data-cf]', box).forEach((el) => (el.onchange = () => {
    const f = fields.find((x) => x.key === el.dataset.cf);
    let v = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (['number', 'money'].includes(f.type)) v = v === '' ? null : Number(v);
    if (v === '' || v === null) delete vals[f.key]; else vals[f.key] = v;
    commit();
  }));
  $$('[data-cfm]', box).forEach((wrap) => $$('[data-o]', wrap).forEach((b) => (b.onclick = () => {
    const k = wrap.dataset.cfm, cur = new Set(vals[k] || []); cur.has(b.dataset.o) ? cur.delete(b.dataset.o) : cur.add(b.dataset.o);
    b.classList.toggle('on'); vals[k] = [...cur]; if (!vals[k].length) delete vals[k]; commit();
  })));
}

/* ================= cost presets ================= */
async function drawCostPresets(box) {
  const { data } = await sb.from('cost_presets').select('*').is('archived_at', null).order('sort').order('item');
  const rows = data || [];
  box.innerHTML = `<h2>Other cost presets</h2><small class="hint" style="margin:-4px 0 10px">The dropdown workers pick from on a ${esc(l('job'))}. The category stays behind the scenes, like in accounting software, and groups costs on the dashboard.</small>
    ${rows.map((r) => `<div class="listrow" data-pr="${r.id}"><input type="text" value="${esc(r.item)}" data-k="item" maxlength="80" aria-label="Item">
      <input type="number" value="${esc(r.default_cost ?? '')}" data-k="default_cost" step="0.01" style="max-width:110px" aria-label="Default price">
      <select data-k="category" style="max-width:170px" aria-label="Category">${CATS.map(([v, n]) => `<option value="${v}" ${v === r.category ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <button class="btn ghost small danger" data-rm>Remove</button></div>`).join('') || '<p class="empty">No presets yet.</p>'}
    <div class="pline" style="margin-top:10px"><input type="text" id="cpI" placeholder="Parking bumper" maxlength="80"><input type="number" id="cpC" placeholder="45.00" step="0.01" style="max-width:110px">
      <select id="cpK" style="max-width:170px">${CATS.map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join('')}</select><button class="btn small" id="cpAdd">Add</button></div>`;
  $('#cpAdd', box).onclick = async () => {
    const item = $('#cpI', box).value.trim(); if (!item) return C.toast('Name the item', { error: true });
    const { error } = await sb.from('cost_presets').insert({ item, default_cost: $('#cpC', box).value === '' ? null : Number($('#cpC', box).value), category: $('#cpK', box).value, sort: rows.length * 10 });
    if (error) return C.fail(error); C.toast('Preset added'); drawCostPresets(box);
  };
  $$('[data-pr]', box).forEach((row) => {
    $$('[data-k]', row).forEach((el) => (el.onchange = async () => {
      const v = el.dataset.k === 'default_cost' ? (el.value === '' ? null : Number(el.value)) : el.value.trim();
      const { error } = await sb.from('cost_presets').update({ [el.dataset.k]: v }).eq('id', row.dataset.pr); if (error) return C.fail(error); C.toast('Saved');
    }));
    $('[data-rm]', row).onclick = async () => { const { error } = await sb.from('cost_presets').update({ archived_at: new Date().toISOString() }).eq('id', row.dataset.pr); if (error) return C.fail(error); drawCostPresets(box); };
  });
}

/* ================= Roles ================= */
async function viewRoles(main) {
  const [{ data: roles, error }, { data: presets }] = await Promise.all([sb.from('roles').select('*').is('archived_at', null).order('name'), sb.rpc('role_presets')]);
  if (error) { main.innerHTML = '<h1>Roles</h1><p class="empty">Roles need the October 29 database update. Once it\'s applied, this screen works.</p>'; return; }
  const used = {}; S.users.forEach((u) => { if (u.role_id) used[u.role_id] = (used[u.role_id] || 0) + 1; });
  const canEdit = can('team', 4);
  main.innerHTML = `<h1>Roles</h1>
    <p class="empty">Each role turns every feature on or off and sets how far it goes: view, edit, approve or manage, for their own records, their company or everything. Nobody can give a role more than they have themselves.</p>
    ${canEdit ? `<div class="card"><h2>Start from a ready-made role</h2><div class="chips">${Object.entries(presets || {}).map(([k, p]) => `<button type="button" class="chip" data-pre="${k}">${esc(p.name)}</button>`).join('')}
      <button type="button" class="chip ghostchip" data-pre="">Blank role</button></div></div>` : ''}
    <div class="list">${(roles || []).map((r) => `<button class="item" data-role="${r.id}"><b>${esc(r.name)}</b><small>${C.plural(used[r.id] || 0, 'person', 'people')}${r.preset_key ? ' · from ' + esc(presets?.[r.preset_key]?.name || r.preset_key) : ''}</small></button>`).join('')
      || '<p class="empty">No roles yet. Without one, team members keep what they could always do, and admins can do everything.</p>'}</div>
    <div id="roleEd"></div>`;
  $$('[data-pre]', main).forEach((b) => (b.onclick = () => roleEditor($('#roleEd', main), null, b.dataset.pre ? { name: presets[b.dataset.pre].name, perms: presets[b.dataset.pre].perms, preset_key: b.dataset.pre } : { name: '', perms: {} }, () => viewRoles(main))));
  $$('[data-role]', main).forEach((b) => (b.onclick = () => roleEditor($('#roleEd', main), b.dataset.role, roles.find((r) => r.id === b.dataset.role), () => viewRoles(main))));
}
function roleEditor(box, id, role, done) {
  const canEdit = can('team', 4);
  const mine = (a) => (C.isAdmin() ? { level: 4, scope: 'all' } : S.perms?.[a] || { level: 0, scope: 'own' });
  const rank = { own: 1, division: 2, all: 3 };
  box.innerHTML = `<div class="card panel"><h2>${id ? 'Edit role' : 'New role'}</h2>
    <label class="label" for="rName">Name</label><input type="text" id="rName" value="${esc(role.name || '')}" maxlength="60" ${canEdit ? '' : 'disabled'}>
    <div class="tw" style="margin-top:10px"><table class="ptable roletable"><thead><tr><th>Feature</th><th>On</th><th>How much</th><th>Whose records</th></tr></thead><tbody>
    ${AREAS.map(([a, name, lvNames]) => {
      const p = role.perms?.[a] || { level: 0, scope: 'own' }, m = mine(a);
      return `<tr data-a="${a}"><td>${esc(name)}</td><td><input type="checkbox" data-on ${p.level > 0 ? 'checked' : ''} ${canEdit && m.level > 0 ? '' : 'disabled'} aria-label="${esc(name)} on"></td>
        <td><select data-lv ${canEdit ? '' : 'disabled'} aria-label="${esc(name)} level">${(lvNames || LEVELS.slice(1)).map((n, i) => `<option value="${i + 1}" ${p.level === i + 1 ? 'selected' : ''} ${i + 1 > m.level ? 'disabled' : ''}>${n}</option>`).join('')}</select></td>
        <td><select data-sc ${canEdit ? '' : 'disabled'} aria-label="${esc(name)} scope">${SCOPES.map(([v, n]) => `<option value="${v}" ${p.scope === v ? 'selected' : ''} ${rank[v] > rank[m.scope] ? 'disabled' : ''}>${n}</option>`).join('')}</select></td></tr>`;
    }).join('')}</tbody></table></div>
    <small class="hint">View: see it. Edit: add and change. Approve: sign off in Review. Manage: settings for it, presets and everyone's records. Choices above what you have are grayed out.</small>
    ${canEdit ? `<div class="actions"><button class="btn small" id="rSave">Save role</button>${id ? '<button class="btn ghost small danger" id="rRm">Remove role</button>' : ''}<button class="btn ghost small" id="rX">Close</button></div>` : ''}</div>`;
  const sync = (tr) => { const on = $('[data-on]', tr).checked; $('[data-lv]', tr).disabled = !on || !canEdit; $('[data-sc]', tr).disabled = !on || !canEdit; };
  $$('tr[data-a]', box).forEach((tr) => { sync(tr); $('[data-on]', tr).onchange = () => sync(tr); });
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!canEdit) return;
  $('#rX', box).onclick = () => (box.innerHTML = '');
  $('#rSave', box).onclick = async () => {
    const perms = {};
    $$('tr[data-a]', box).forEach((tr) => { perms[tr.dataset.a] = { level: $('[data-on]', tr).checked ? Number($('[data-lv]', tr).value) : 0, scope: $('[data-sc]', tr).value }; });
    const { error } = await sb.rpc('role_save', { p_id: id, p_name: $('#rName', box).value, p_perms: perms, p_preset: role.preset_key || null });
    if (error) return C.fail(error); C.toast('Role saved'); done();
  };
  if ($('#rRm', box)) $('#rRm', box).onclick = async () => { const { error } = await sb.rpc('role_archive', { p_id: id }); if (error) return C.fail(error); C.toast('Role removed'); done(); };
}
// Team screen: the role picker on each person
export async function teamRolePicker(card, u) {
  if (u.role === 'vendor' || !S.rolesList) return;
  const wrap = document.createElement('div'); wrap.className = 'rolepick';
  wrap.innerHTML = `<label class="label" for="ur_${u.id}">Role</label><select id="ur_${u.id}" ${u.id === S.me.id || (u.is_admin && !C.isAdmin()) || !can('team', 4) ? 'disabled' : ''}>
    <option value="">${u.is_admin ? 'Admin (everything)' : 'Default for a team member'}</option>${S.rolesList.map((r) => `<option value="${r.id}" ${r.id === u.role_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
    ${u.is_admin ? '<small class="hint">Admins can do everything whatever role is picked.</small>' : ''}`;
  card.appendChild(wrap);
  $('select', wrap).onchange = async (e) => {
    const { error } = await sb.rpc('user_role_set', { p_user: u.id, p_role: e.target.value || null });
    if (error) { e.target.value = u.role_id || ''; return C.fail(error); }
    u.role_id = e.target.value || null; C.toast('Role changed');
  };
}
export async function loadRolesList() { const { data, error } = await sb.from('roles').select('id,name').is('archived_at', null).order('name'); S.rolesList = error ? null : data || []; }

/* ================= Shortcuts: saved filters on any list ================= */
// defaults: [{ key, name, filters }]. Personal ones and team-shared ones come from the database.
async function shortcutsBar(box, screen, defaults, cur, apply, counts = {}) {
  const hidden = C.recall('scHidden_' + screen, { v: [] }).v;
  const { data } = await sb.from('shortcuts').select('*').eq('screen', screen).order('sort').order('created_at');
  const mine = (data || []).filter((x) => x.user_id === S.me.id), shared = (data || []).filter((x) => x.user_id !== S.me.id);
  const all = [...defaults.filter((d) => !hidden.includes(d.key)).map((d) => ({ ...d, id: 'd:' + d.key, kind: 'default' })),
    ...mine.map((x) => ({ id: x.id, name: x.name, filters: x.filters, kind: 'mine', shared: x.shared })),
    ...shared.map((x) => ({ id: x.id, name: x.name, filters: x.filters, kind: 'team', who: C.userName(x.user_id) }))];
  const same = (a, b) => JSON.stringify(Object.entries(a || {}).filter(([, v]) => v !== '' && v != null && v !== false).sort()) === JSON.stringify(Object.entries(b || {}).filter(([, v]) => v !== '' && v != null && v !== false).sort());
  box.innerHTML = `<div class="chips shortcuts">${all.map((s) => `<button type="button" class="chip ${same(s.filters, cur) ? 'on' : ''}" data-sc="${s.id}" title="${s.kind === 'team' ? 'Shared by ' + esc(s.who) : s.kind === 'mine' ? (s.shared ? 'Yours, shared with the team' : 'Yours') : 'Built in'}">
      ${esc(s.name)}${counts[s.id] ? ` <span class="count">${counts[s.id]}</span>` : ''}${s.kind === 'team' ? ' 👥' : s.shared ? ' ↗' : ''}</button>`).join('')}
    <button type="button" class="chip ghostchip" data-scsave>+ Save as shortcut</button>
    <button type="button" class="chip ghostchip" data-scedit>Edit</button></div>`;
  $$('[data-sc]', box).forEach((b) => (b.onclick = () => apply({ ...all.find((s) => s.id === b.dataset.sc).filters })));
  $('[data-scsave]', box).onclick = () => {
    const d = dlg('scDlg', `<div class="vhead"><h2 style="margin:0">Save as a shortcut</h2><button class="btn ghost small" data-x>Close</button></div>
      <p class="hint">Saves the filters you have on right now.</p><label class="label" for="scN">Name</label><input id="scN" maxlength="40" placeholder="My company's pending timesheets">
      <label class="check"><input type="checkbox" id="scS"> Share with the team</label><div class="actions"><button class="btn" id="scGo">Save</button></div>`);
    $('[data-x]', d).onclick = () => d.close();
    $('#scGo', d).onclick = async () => {
      const name = $('#scN', d).value.trim(); if (!name) return C.toast('Name it first', { error: true });
      const { error } = await sb.from('shortcuts').insert({ screen, name, filters: cur, shared: $('#scS', d).checked, sort: mine.length * 10 });
      if (error) return C.fail(error); d.close(); C.toast('Shortcut saved'); shortcutsBar(box, screen, defaults, cur, apply, counts);
    };
  };
  $('[data-scedit]', box).onclick = () => {
    const d = dlg('scDlg', `<div class="vhead"><h2 style="margin:0">Shortcuts</h2><button class="btn ghost small" data-x>Done</button></div>
      ${defaults.map((s) => `<label class="check"><input type="checkbox" data-def="${s.key}" ${hidden.includes(s.key) ? '' : 'checked'}> ${esc(s.name)} <small class="hint" style="margin:0 0 0 6px">built in</small></label>`).join('')}
      ${mine.map((s) => `<div class="listrow"><b style="flex:1">${esc(s.name)}</b><label class="check"><input type="checkbox" data-share="${s.id}" ${s.shared ? 'checked' : ''}> Shared</label>
        <button class="btn ghost small danger" data-del="${s.id}">Remove</button></div>`).join('')}
      ${shared.length ? `<small class="hint">Shared by others: ${esc(shared.map((s) => s.name).join(', '))}</small>` : ''}`);
    const reload = () => shortcutsBar(box, screen, defaults, cur, apply, counts);
    $('[data-x]', d).onclick = () => { d.close(); reload(); };
    $$('[data-def]', d).forEach((cb) => (cb.onchange = () => { const h = new Set(C.recall('scHidden_' + screen, { v: [] }).v); cb.checked ? h.delete(cb.dataset.def) : h.add(cb.dataset.def); C.store('scHidden_' + screen, { v: [...h] }); }));
    $$('[data-share]', d).forEach((cb) => (cb.onchange = async () => { const { error } = await sb.from('shortcuts').update({ shared: cb.checked }).eq('id', cb.dataset.share); if (error) C.fail(error); }));
    $$('[data-del]', d).forEach((b) => (b.onclick = async () => { const { error } = await sb.from('shortcuts').delete().eq('id', b.dataset.del); if (error) return C.fail(error); b.closest('.listrow').remove(); }));
  };
}

/* ================= on an organization (location) ================= */
export async function orgExtras(box, c) {
  if (!box) return;
  const parts = [];
  const nest = feat('location_nesting');
  if (feat('parent_locations')) {
    const [{ data: kids }, par] = await Promise.all([
      sb.from('companies').select('id,name,city,state,bill_to').eq('parent_company_id', c.id).is('archived_at', null).order('name').limit(500),
      c.parent_company_id ? sb.from('companies').select('id,name').eq('id', c.parent_company_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    S._kids = kids || [];
    parts.push(`<div class="card" id="parCard"><h2>${esc(L('parent'))} and ${esc(l('organization', true))}</h2>
      <label class="label">Belongs to</label>
      <div class="pline">${par.data ? `<button type="button" class="btn ghost small" data-oid="${par.data.id}">${esc(par.data.name)} ›</button>` : '<span class="empty">Nobody. It stands on its own.</span>'}
        <button type="button" class="btn secondary small" id="parPick">${par.data ? 'Change' : 'Pick a ' + esc(l('parent'))}</button>${par.data ? '<button type="button" class="btn ghost small" id="parClear">Remove</button>' : ''}</div>
      <div id="parSearch" hidden><input type="search" id="parQ" placeholder="Search ${esc(l('organization', true))}"><div class="list" id="parRes"></div></div>
      ${c.parent_company_id ? `<label class="label" for="billTo">Who gets the bill</label><select id="billTo"><option value="self" ${c.bill_to !== 'parent' ? 'selected' : ''}>This ${esc(l('organization'))}</option>
        <option value="parent" ${c.bill_to === 'parent' ? 'selected' : ''}>The ${esc(l('parent'))}</option></select>` : ''}
      ${(kids || []).length ? `<h3 class="section">Under this one (${kids.length})</h3><div class="list">${kids.map((k) => `<button class="item" data-oid="${k.id}"><b>${esc(k.name)}</b><small>${esc([k.city, k.state].filter(Boolean).join(', '))}${k.bill_to === 'parent' ? ' · billed here' : ''}</small></button>`).join('')}</div>
        <div id="rollup"></div>` : ''}
      ${!nest && c.parent_company_id && (kids || []).length ? '' : ''}
    </div>`);
  }
  if (feat('jobs') && can('jobs', 1)) parts.push(`<div class="card" id="orgJobs"><div class="toolbar"><h2 style="margin:0;flex:1">${esc(L('job', true))}</h2>
    ${can('jobs', 2) ? `<button class="btn small" id="newJob">+ ${esc(L('job'))}</button>` : ''}${can('jobs', 4) ? `<button class="btn secondary small" id="newSched">+ ${esc(L('schedule'))}</button>` : ''}</div><div id="orgJobList"><p class="empty">Loading…</p></div></div>`);
  if (feat('dispatch')) parts.push(`<div class="card" id="pinCard"><h2>${esc(L('pin', true))}</h2><div id="pinList"><p class="empty">Loading…</p></div></div>`);
  if (feat('custom_fields')) parts.push('<div class="card" id="orgCF" hidden></div>');
  box.innerHTML = parts.join('');
  $$('[data-oid]', box).forEach((b) => (b.onclick = () => C.go('org', b.dataset.oid)));
  if ($('#parPick', box)) {
    $('#parPick', box).onclick = () => { $('#parSearch', box).hidden = false; $('#parQ', box).focus(); };
    $('#parQ', box).oninput = C.debounce(async (e) => {
      const q = C.clean(e.target.value); if (q.length < 2) return ($('#parRes', box).innerHTML = '');
      let qq = sb.from('companies').select('id,name,city,parent_company_id').ilike('name', `%${q}%`).is('archived_at', null).neq('id', c.id).limit(12);
      const { data } = await qq;
      const ok = (data || []).filter((x) => nest || !x.parent_company_id);
      $('#parRes', box).innerHTML = ok.map((x) => `<button class="item" data-par="${x.id}"><b>${esc(x.name)}</b><small>${esc(x.city || '')}</small></button>`).join('') || `<p class="empty">No match${nest ? '' : ' (a ' + esc(l('organization')) + ' that already belongs to a ' + esc(l('parent')) + ' can\'t be one while nesting is off)'}.</p>`;
      $$('[data-par]', box).forEach((b) => (b.onclick = async () => {
        const { error } = await sb.from('companies').update({ parent_company_id: b.dataset.par }).eq('id', c.id);
        if (error) return C.fail(error); C.toast('Saved'); C.renderShell();
      }));
    }, 300);
  }
  if ($('#parClear', box)) $('#parClear', box).onclick = async () => { const { error } = await sb.from('companies').update({ parent_company_id: null, bill_to: 'self' }).eq('id', c.id); if (error) return C.fail(error); C.renderShell(); };
  if ($('#billTo', box)) $('#billTo', box).onchange = async (e) => { const { error } = await sb.from('companies').update({ bill_to: e.target.value }).eq('id', c.id); if (error) return C.fail(error); C.toast('Saved'); };
  if ($('#rollup', box) && feat('jobs')) {
    const { data: tree } = await sb.rpc('location_tree', { p_root: c.id });
    const ids = (tree || []).map((x) => x.location_tree || x);
    const since = new Date(); since.setDate(1); since.setHours(0, 0, 0, 0);
    const { data: js } = await sb.from('jobs').select('id,price,approval,status,company_id').in('company_id', ids.slice(0, 500)).is('archived_at', null).gte('scheduled_start', since.toISOString());
    const done = (js || []).filter((j) => ['approved', 'auto'].includes(j.approval));
    $('#rollup', box).innerHTML = `<div class="dtiles"><div class="dtile"><b>${(js || []).length}</b><span>${esc(L('job', true))} this month, all ${esc(l('organization', true))}</span></div>
      <div class="dtile"><b>${esc(C.money(done.reduce((a, j) => a + Number(j.price || 0), 0)))}</b><span>Approved this month</span></div></div>`;
  }
  if ($('#orgJobs', box)) {
    const { data: js } = await sb.from('jobs').select('id,number,title,status,approval,scheduled_start,scheduled_end,assigned_to,price,flags').eq('company_id', c.id).is('archived_at', null)
      .order('scheduled_start', { ascending: false, nullsFirst: true }).limit(30);
    const { data: sch } = await sb.from('job_schedules').select('id,title,rule,active,assigned_to').eq('company_id', c.id).order('created_at');
    const { data: props } = can('jobs', 2) ? await sb.from('proposals').select('id,accepted_at').eq('company_id', c.id).eq('status', 'accepted') : { data: [] };
    const withJob = new Set((await sb.from('jobs').select('proposal_id').eq('company_id', c.id).not('proposal_id', 'is', null)).data?.map((x) => x.proposal_id) || []);
    const toMake = (props || []).filter((p) => !withJob.has(p.id));
    $('#orgJobList', box).innerHTML = `${toMake.map((p) => `<div class="listrow"><span style="flex:1">Accepted ${esc(l('proposal'))} · ${esc(C.fmtDate(p.accepted_at))}</span>
        <button class="btn small" data-mkjob="${p.id}">Make a ${esc(l('job'))} from it</button></div>`).join('')}${(sch || []).length ? `<h3 class="section">${esc(L('schedule', true))}</h3><div class="list">${sch.map((s) => `<button class="item" data-sch="${s.id}"><b>${esc(s.title)}</b><small>${esc(ruleText(s.rule))}${s.assigned_to ? ' · ' + esc(C.userName(s.assigned_to)) : ''}${s.active ? '' : ' · paused'}</small></button>`).join('')}</div>` : ''}
      <div class="list">${(js || []).map(jobItem).join('') || `<p class="empty">No ${esc(l('job', true))} yet.</p>`}</div>`;
    $$('[data-job]', box).forEach((b) => (b.onclick = () => C.go('job', b.dataset.job)));
    $$('[data-mkjob]', box).forEach((b) => (b.onclick = async () => { const { data, error } = await sb.rpc('job_from_proposal', { p_proposal: b.dataset.mkjob, p_title: null, p_start: null }); if (error) return C.fail(error); C.toast(`${L('job')} made. Set the time and ${l('worker')}.`); C.go('job', data); }));
    $$('[data-sch]', box).forEach((b) => (b.onclick = () => scheduleEditor((sch || []).find((s) => s.id === b.dataset.sch))));
    if ($('#newJob', box)) $('#newJob', box).onclick = () => jobEditor(null, { company_id: c.id, company_name: c.name, divisions: c.divisions || [] });
    if ($('#newSched', box)) $('#newSched', box).onclick = () => scheduleEditor(null, { company_id: c.id, company_name: c.name, divisions: c.divisions || [] });
  }
  if ($('#pinCard', box)) drawPins($('#pinList', box), c);
  if ($('#orgCF', box)) customFieldsBox($('#orgCF', box), 'companies', c, async (custom) => { const { error } = await sb.from('companies').update({ custom }).eq('id', c.id); if (error) { C.fail(error); return false; } c.custom = custom; }, can('contacts', 2));
}
async function drawPins(box, c) {
  const { data } = await sb.from('location_pins').select('*').eq('company_id', c.id).is('archived_at', null).order('is_primary', { ascending: false }).order('created_at');
  const def = S.acctSettings?.gps_radius_ft || 500, mgr = can('dispatch', 3);
  box.innerHTML = `${(data || []).map((p) => `<div class="listrow" data-pin="${p.id}"><b style="flex:1">${esc(p.label)}${p.is_primary ? ' <span class="badge">Main</span>' : ''}</b>
      <small>${p.radius_ft || def} ft</small><a class="btn ghost small" href="${mapLink(p.lat, p.lng)}" target="_blank" rel="noopener">Map</a>${mgr ? '<button class="btn ghost small" data-pe>Edit</button>' : ''}</div>`).join('')
    || `<p class="empty">No pin yet. The first check-in here suggests one for a manager to approve${mgr ? ', or add it now while you\'re standing there' : ''}.</p>`}
    <small class="hint">Workers check in against the closest pin. The mailing address never changes when a pin moves.</small>
    ${mgr ? `<div class="actions"><button class="btn secondary small" id="pinHere">+ Pin where I'm standing</button></div>` : ''}`;
  if ($('#pinHere', box)) $('#pinHere', box).onclick = async () => {
    C.toast('Getting your location…'); const g = await where(); if (!g) return C.toast('Couldn\'t get your location. Check that location is allowed for this site.', { error: true });
    const label = (data || []).length ? prompt('Name this pin (Office, Dumpster, Back gate)', 'Check-in spot') : 'Main'; if (label === null) return;
    const { error } = await sb.from('location_pins').insert({ company_id: c.id, label: label.trim() || 'Check-in spot', lat: g.lat, lng: g.lng, is_primary: !(data || []).length });
    if (error) return C.fail(error); C.toast('Pin added'); drawPins(box, c);
  };
  $$('[data-pe]', box).forEach((b) => (b.onclick = () => {
    const p = data.find((x) => x.id === b.closest('[data-pin]').dataset.pin);
    const d = dlg('pinDlg', `<div class="vhead"><h2 style="margin:0">${esc(p.label)}</h2><button class="btn ghost small" data-x>Close</button></div>
      <label class="label" for="pnL">Name</label><input id="pnL" value="${esc(p.label)}" maxlength="60">
      <label class="label" for="pnR">Check-in distance (feet)</label><input id="pnR" type="number" min="50" max="10000" step="50" value="${esc(p.radius_ft || '')}" placeholder="${def} (account default)">
      <div class="actions"><button class="btn small" id="pnS">Save</button><button class="btn secondary small" id="pnM">Move it to where I'm standing</button><button class="btn ghost small danger" id="pnD">Remove</button></div>`);
    $('[data-x]', d).onclick = () => d.close();
    const upd = async (f) => { const { error } = await sb.from('location_pins').update(f).eq('id', p.id); if (error) return C.fail(error); d.close(); C.toast('Saved'); drawPins(box, c); };
    $('#pnS', d).onclick = () => upd({ label: $('#pnL', d).value.trim() || p.label, radius_ft: $('#pnR', d).value ? Number($('#pnR', d).value) : null });
    $('#pnM', d).onclick = async () => { const g = await where(); if (!g) return C.toast('Couldn\'t get your location', { error: true }); upd({ lat: g.lat, lng: g.lng }); };
    $('#pnD', d).onclick = () => upd({ archived_at: new Date().toISOString() });
  }));
}

/* ================= jobs ================= */
const jobItem = (j) => `<button class="item" data-job="${j.id}"><b>${esc(j.title)} <small>#${esc(j.number)}</small></b>
  <div class="meta">${statusBadge(j)} ${flagBadges(j.flags)}</div>
  <small>${esc([jobWhen(j), j.companies?.name, j._crew?.length > 1 ? crewNames(j._crew) : j.assigned_to ? C.userName(j.assigned_to) : 'Unassigned', can('reports', 1) && j.price != null ? C.money(j.price) : ''].filter(Boolean).join(' · '))}</small></button>`;
const JOB_DEFAULTS = () => [
  { key: 'today', name: 'Today', filters: { day: 'today' } },
  { key: 'mine', name: 'Mine today', filters: { day: 'today', who: 'me' } },
  { key: 'unassigned', name: 'Unassigned', filters: { who: 'none', open: true } },
  { key: 'waiting', name: 'Waiting on approval', filters: { approval: 'pending' } },
  { key: 'unbilled', name: 'Finished, not billed', filters: { unbilled: true } },
];
let JF = null;
async function viewJobs(main) {
  if (!feat('jobs')) return C.go('dashboard');
  JF = JF || C.recall('jobFilters', { day: 'today', who: '', status: '', approval: '', open: false, unbilled: false, q: '' });
  sb.rpc('schedules_generate', { p_days: 21 }).then(() => {});
  const apply = (f) => { JF = { day: '', who: '', status: '', approval: '', open: false, unbilled: false, q: '', ...f }; C.store('jobFilters', JF); viewJobs(main); };
  main.innerHTML = `<div class="toolbar"><h1 style="margin:0;flex:1">${esc(L('job', true))}</h1>${can('jobs', 2) ? `<button class="btn small" id="jNew">+ ${esc(L('job'))}</button>` : ''}</div>
    <div id="jSc"></div>
    <div class="toolbar"><input type="search" id="jQ" placeholder="Search ${esc(l('job', true))}" value="${esc(JF.q || '')}">
      <select id="jDay" aria-label="When" style="max-width:160px"><option value="">Any day</option>${[['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Next 7 days'], ['past', 'Last 7 days']].map(([v, n]) => `<option value="${v}" ${JF.day === v ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <select id="jWho" aria-label="Who" style="max-width:180px"><option value="">Anyone</option><option value="me" ${JF.who === 'me' ? 'selected' : ''}>Me</option><option value="none" ${JF.who === 'none' ? 'selected' : ''}>Unassigned</option>
        ${workers().map((u) => `<option value="${u.id}" ${JF.who === u.id ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}</select>
      <select id="jSt" aria-label="Status" style="max-width:160px"><option value="">Any status</option>${Object.entries(STATUS).map(([v, n]) => `<option value="${v}" ${JF.status === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    <div class="list" id="jList"><p class="empty">Loading…</p></div>`;
  shortcutsBar($('#jSc', main), 'jobs', JOB_DEFAULTS(), JF, apply);
  if ($('#jNew', main)) $('#jNew', main).onclick = () => jobEditor(null, {});
  $('#jQ', main).onchange = (e) => apply({ ...JF, q: e.target.value.trim() });
  $('#jDay', main).onchange = (e) => apply({ ...JF, day: e.target.value });
  $('#jWho', main).onchange = (e) => apply({ ...JF, who: e.target.value });
  $('#jSt', main).onchange = (e) => apply({ ...JF, status: e.target.value });
  let q = C.divQ(sb.from('jobs').select('id,number,title,status,approval,scheduled_start,scheduled_end,assigned_to,price,flags,company_id,companies(name)').is('archived_at', null));
  const t = C.today();
  if (JF.day === 'today') q = q.gte('scheduled_start', dayStart(t)).lt('scheduled_start', dayEnd(t));
  if (JF.day === 'tomorrow') q = q.gte('scheduled_start', dayStart(shiftDay(t, 1))).lt('scheduled_start', dayEnd(shiftDay(t, 1)));
  if (JF.day === 'week') q = q.gte('scheduled_start', dayStart(t)).lt('scheduled_start', dayEnd(shiftDay(t, 6)));
  if (JF.day === 'past') q = q.gte('scheduled_start', dayStart(shiftDay(t, -7))).lt('scheduled_start', dayEnd(t));
  if (JF.who === 'none') q = q.is('assigned_to', null);
  else if (JF.who) { const who = JF.who === 'me' ? S.me.id : JF.who; const on = await jobsOn(who); q = on.length ? q.or(`assigned_to.eq.${who},id.in.(${on.join(',')})`) : q.eq('assigned_to', who); }
  if (JF.status) q = q.eq('status', JF.status);
  if (JF.open) q = q.not('status', 'in', '(left,cancelled,no_show)');
  if (JF.approval) q = q.eq('approval', JF.approval);
  if (JF.unbilled) q = q.in('approval', ['approved', 'auto']).is('billed_at', null);
  if (JF.q) q = q.ilike('title', `%${C.clean(JF.q)}%`);
  const { data, error } = await q.order('scheduled_start', { ascending: JF.day !== 'past' }).limit(300);
  if (error) return C.fail(error);
  if (!main.isConnected) return;
  const cm = await crewFor((data || []).map((j) => j.id)); (data || []).forEach((j) => (j._crew = cm[j.id]));
  $('#jList', main).innerHTML = (data || []).map(jobItem).join('') || `<p class="empty">No ${esc(l('job', true))} match.</p>`;
  $$('[data-job]', main).forEach((b) => (b.onclick = () => C.go('job', b.dataset.job)));
}

// add or change a job (manager side). seed: { company_id, company_name, divisions, title... }
export function jobEditor(j, seed = {}) {
  const x = j || { title: seed.title || '', company_id: seed.company_id || null, divisions: seed.divisions || [], scheduled_start: seed.scheduled_start || null, scheduled_end: null, price: null, pay_amount: null, assigned_to: seed.assigned_to || null, service_type: '', scope: '', notes: '' };
  let company = { id: x.company_id, name: seed.company_name || j?.companies?.name || '' };
  const money = can('jobs', 3) || can('dispatch', 2);
  const d = dlg('jobDlg', `<div class="vhead"><h2 style="margin:0">${j ? 'Edit ' + esc(l('job')) : 'New ' + esc(l('job'))}</h2><button class="btn ghost small" data-x>Close</button></div>
    <label class="label">Customer</label><div id="jeCo"></div>
    <label class="label" for="jeT">What</label><input id="jeT" maxlength="120" value="${esc(x.title)}" placeholder="Nightly pickup, Lot restripe, Garage cleanout">
    <div class="row dtrow"><div><label class="label" for="jeS">Starts</label><input id="jeS" type="datetime-local" value="${esc(localInput(x.scheduled_start))}"></div>
      <div><label class="label" for="jeE">Ends</label><input id="jeE" type="datetime-local" value="${esc(localInput(x.scheduled_end))}"></div></div>
    <div class="row"><div><label class="label" for="jeW">${esc(L('worker'))}</label><select id="jeW" ${money ? '' : 'disabled'}>${workerOptions(x.assigned_to)}</select></div>
      <div><label class="label" for="jeV">Service</label><input id="jeV" maxlength="80" value="${esc(x.service_type || '')}" list="jeVl"><datalist id="jeVl">${(C.lk('service') || []).map((s) => `<option>${esc(s)}</option>`).join('')}</datalist></div></div>
    ${money ? `<div class="row"><div><label class="label" for="jeP">Price to the customer</label><input id="jeP" type="number" step="0.01" value="${esc(x.price ?? '')}"></div>
      <div><label class="label" for="jePay">Pay for the ${esc(l('worker'))} (blank uses their rate)</label><input id="jePay" type="number" step="0.01" value="${esc(x.pay_amount ?? '')}"></div></div>` : ''}
    ${money && !j ? `<div id="jeCrew"></div>` : ''}
    <label class="label" for="jeSc">Scope</label><textarea id="jeSc" rows="3">${esc(x.scope || '')}</textarea>
    <div id="jeDiv"></div><div id="jeCF"></div>
    <div class="actions"><button class="btn" id="jeGo">${j ? 'Save' : 'Add ' + esc(l('job'))}</button>${!j && can('jobs', 4) ? `<button class="btn ghost small" id="jeRep">Make it repeat instead</button>` : ''}</div>`);
  $('[data-x]', d).onclick = () => d.close();
  let divs = [...(x.divisions || [])];
  C.divPicker($('#jeDiv', d), divs, (next) => { divs = next; });
  // new job: a saved crew and anyone else on it
  const extra = new Set();
  if ($('#jeCrew', d)) (crewMode() === 'standing' ? loadCrews() : Promise.resolve([])).then((crews) => {
    $('#jeCrew', d).innerHTML = `${crews.length ? `<label class="label" for="jeCr">Crew</label><select id="jeCr"><option value="">No saved crew</option>${crews.map((c) => `<option value="${c.id}">${esc(c.name)} (${esc(firstName(c.foreman_id))} + ${c.member_ids.length})</option>`).join('')}</select>` : ''}
      <label class="label">${crews.length ? 'Anyone else on it' : 'Also on this ' + esc(l('job'))}</label><div class="chips">${workers().map((u) => `<button type="button" class="chip" data-ex="${u.id}">${esc(u.full_name)}</button>`).join('')}</div>`;
    $$('[data-ex]', d).forEach((b) => (b.onclick = () => { const v = b.dataset.ex; extra.has(v) ? extra.delete(v) : extra.add(v); b.classList.toggle('on'); }));
    if ($('#jeCr', d)) $('#jeCr', d).onchange = (e) => { const c = crews.find((y) => y.id === e.target.value); if (c && !$('#jeW', d).value) $('#jeW', d).value = c.foreman_id; };
  });
  const custom = { ...(x.custom || {}) };
  customFieldsBox($('#jeCF', d), 'jobs', { custom }, (c) => { Object.assign(custom, c); Object.keys(custom).forEach((k) => !(k in c) && delete custom[k]); });
  coPicker($('#jeCo', d), company, (co) => { company = co; if (!divs.length && co.divisions?.length) { divs = co.divisions; C.divPicker($('#jeDiv', d), divs, (n) => { divs = n; }); } });
  $('#jeS', d).onchange = () => { if (!$('#jeE', d).value && $('#jeS', d).value) { const e = new Date($('#jeS', d).value); e.setHours(e.getHours() + 1); $('#jeE', d).value = localInput(e.toISOString()); } };
  if ($('#jeRep', d)) $('#jeRep', d).onclick = () => { d.close(); scheduleEditor(null, { company_id: company.id, company_name: company.name, divisions: divs, title: $('#jeT', d).value }); };
  $('#jeGo', d).onclick = async () => {
    if (!company.id) return C.toast('Pick the customer first', { error: true });
    const title = $('#jeT', d).value.trim(); if (!title) return C.toast('Say what the job is', { error: true });
    const f = { company_id: company.id, ...(company.person_id ? { person_id: company.person_id } : {}), title, scheduled_start: fromLocal($('#jeS', d).value), scheduled_end: fromLocal($('#jeE', d).value), service_type: $('#jeV', d).value.trim() || null,
      scope: $('#jeSc', d).value.trim() || null, divisions: divs, custom: j?.schedule_id ? { ...custom, _edited: true } : custom };
    if (f.scheduled_end && f.scheduled_start && f.scheduled_end <= f.scheduled_start) return C.toast('The end has to be after the start', { error: true });
    if (money) Object.assign(f, { assigned_to: $('#jeW', d).value || null, price: $('#jeP', d).value === '' ? null : Number($('#jeP', d).value), pay_amount: $('#jePay', d).value === '' ? null : Number($('#jePay', d).value) });
    const res = j ? await sb.from('jobs').update(f).eq('id', j.id).select('id').single() : await sb.from('jobs').insert({ ...f, source: seed.source || 'quick', proposal_id: seed.proposal_id || null }).select('id').single();
    if (res.error) return C.fail(res.error);
    const crewId = $('#jeCr', d)?.value || null;
    if (!j && (crewId || extra.size)) {
      const crew = crewId ? (S.crews || []).find((c) => c.id === crewId) : null;
      const lead = f.assigned_to || crew?.foreman_id || [...extra][0];
      const people = crew ? [crew.foreman_id, ...crew.member_ids, ...extra] : [lead, ...extra];
      const r2 = await sb.rpc('job_crew_set', { p_job: res.data.id, p_crew: crewId, p_people: [...new Set(people.filter(Boolean))], p_lead: lead || null });
      if (r2.error) C.fail(r2.error);
    }
    d.close(); C.toast(j ? 'Saved' : `${L('job')} added`); C.go('job', res.data.id);
  };
}
// pick the customer: an organization or a person (Nov 16, 2026: some accounts serve homes). A person at an
// organization brings that organization; a person at none gets an "Individual" organization in their name, made or
// reused by customer_for_person, so locations, pins, invoices and history work the same either way.
export function coPicker(box, cur, pick) {
  const paint = () => {
    box.innerHTML = cur.id ? `<div class="pline"><b>${esc(cur.name)}</b>${cur.person_name && cur.person_name !== cur.name ? ` <small>(${esc(cur.person_name)})</small>` : ''}<button type="button" class="btn ghost small" data-chg>Change</button></div>`
      : `<input type="search" data-q placeholder="Search ${esc(l('organization', true))} and people" autocomplete="off"><div class="list" data-r></div>`;
    if (cur.id) return ($('[data-chg]', box).onclick = () => { cur = { id: null, name: '' }; pick(cur); paint(); });
    $('[data-q]', box).oninput = C.debounce(async (e) => {
      const q = C.clean(e.target.value); if (q.length < 2) return ($('[data-r]', box).innerHTML = '');
      const words = q.toLowerCase().split(/\s+/).filter(Boolean), w = words[0].replace(/[%,()]/g, '');
      const [{ data: orgs }, { data: ppl }] = await Promise.all([
        sb.from('companies').select('id,name,city,divisions,org_types').ilike('name', `%${q}%`).is('archived_at', null).order('name').limit(8),
        sb.from('people').select('id,first_name,last_name,personal_email,company_people(company_id,is_primary_contact,companies(name,archived_at))')
          .or(`first_name.ilike.%${w}%,last_name.ilike.%${w}%`).is('archived_at', null).order('first_name').limit(20),
      ]);
      const pname = (x) => [x.first_name, x.last_name].filter(Boolean).join(' ');
      const people = (ppl || []).filter((x) => words.every((v) => pname(x).toLowerCase().includes(v) || (x.personal_email || '').toLowerCase().includes(v))).slice(0, 8);
      const atOrg = (x) => (x.company_people || []).filter((cp) => cp.companies && !cp.companies.archived_at).sort((a, b) => b.is_primary_contact - a.is_primary_contact)[0];
      $('[data-r]', box).innerHTML = (orgs || []).map((x) => `<button type="button" class="item" data-co="${x.id}"><b>${esc(x.name)}</b><small>${esc([(x.org_types || []).includes('Individual') ? 'Individual' : l('organization'), x.city].filter(Boolean).join(' · '))}</small></button>`).join('')
        + people.map((x) => { const o = atOrg(x); return `<button type="button" class="item" data-pe="${x.id}"><b>${esc(pname(x))}</b><small>Person${o && o.companies.name !== pname(x) ? ' · ' + esc(o.companies.name) : ''}</small></button>`; }).join('')
        || '<p class="empty">No match. Add them under Contacts first.</p>';
      $$('[data-co]', box).forEach((b) => (b.onclick = () => { const x = orgs.find((y) => y.id === b.dataset.co); cur = { id: x.id, name: x.name, divisions: x.divisions }; pick(cur); paint(); }));
      $$('[data-pe]', box).forEach((b) => (b.onclick = async () => {
        b.disabled = true;
        const { data, error } = await sb.rpc('customer_for_person', { p_person: b.dataset.pe });
        if (error) { b.disabled = false; return C.fail(error); }
        const x = people.find((y) => y.id === b.dataset.pe);
        cur = { id: data.id, name: data.name, divisions: data.divisions || [], person_id: data.person_id, person_name: pname(x) }; pick(cur); paint();
      }));
    }, 250);
  };
  paint();
}

/* ================= one job: the worker's phone screen and the manager's view ================= */
async function viewJob(main) {
  const [{ data: j, error }, { data: ev }, { data: costs }] = await Promise.all([
    sb.from('jobs').select('*, companies(id,name,address,city,state,zip,main_phone)').eq('id', S.param).maybeSingle(),
    sb.from('job_events').select('*').eq('job_id', S.param).order('created_at', { ascending: false }),
    feat('costs') ? sb.from('job_costs').select('*').eq('job_id', S.param).is('archived_at', null).order('created_at') : Promise.resolve({ data: [] }),
  ]);
  if (error) return C.fail(error);
  if (!j) { main.innerHTML = `<p class="empty">Not found, or it isn't yours to see.</p>`; return; }
  const mine = j.assigned_to === S.me.id, mgr = can('dispatch', 2) || can('jobs', 3);
  const { data: myCrew } = await sb.from('job_crew').select('id').eq('job_id', j.id).eq('user_id', S.me.id).is('removed_at', null).maybeSingle();
  const crewOnly = !!myCrew && !mine && !mgr;
  const closed = ['left', 'cancelled', 'no_show'].includes(j.status) || (j.status === 'completed' && !feat('dispatch'));
  let next = NEXT[j.status]; if (!feat('dispatch') && ['en_route', 'arrived', 'left'].includes(next)) next = j.status === 'accepted' ? 'started' : j.status === 'scheduled' ? 'accepted' : null;
  if (!feat('dispatch') && j.status === 'completed') next = null;
  const photos = await signed((ev || []).map((e) => e.photo_path));
  const co = j.companies || {};
  const addr = [co.address, co.city, co.state, co.zip].filter(Boolean).join(', ');
  const costTotal = (costs || []).reduce((a, c) => a + Number(c.amount || 0), 0);
  const { data: presets } = feat('costs') ? await sb.from('cost_presets').select('id,item,default_cost').is('archived_at', null).order('sort').order('item') : { data: [] };
  main.innerHTML = `<div class="toolbar"><button class="btn ghost small" id="jBack">← ${esc(L('job', true))}</button><div style="flex:1"></div>
      ${mgr || can('jobs', 2) && !closed ? `<button class="btn secondary small" id="jEdit">Edit</button>` : ''}<button class="btn secondary small" id="jEsc">Escalate</button></div>
    <div class="titlerow"><h1>${esc(j.title)} <small>#${esc(j.number)}</small></h1></div>
    <div class="meta">${statusBadge(j)} ${flagBadges(j.flags)} ${C.divChips(j.divisions)}</div>
    ${j.approval === 'returned' ? `<div class="banner warn"><b>Sent back</b><span>${esc((ev || []).find((e) => e.kind === 'edit')?.note || 'A manager sent this back. See the note in Review history.')}</span></div>` : ''}
    <div class="card jobcard">
      <button type="button" class="jobco" data-oid="${co.id}">${esc(co.name || '')} ›</button>
      ${addr ? `<div><a href="${esc(C.mapHref(addr))}" target="_blank" rel="noopener">${esc(addr)}</a></div>` : ''}
      <div><small>${esc(jobWhen(j))}${j.assigned_to ? ' · ' + esc(C.userName(j.assigned_to)) : ' · Unassigned'}${j.service_type ? ' · ' + esc(j.service_type) : ''}</small></div>
      ${j.scope ? `<p>${esc(j.scope).replace(/\n/g, '<br>')}</p>` : ''}
      ${can('reports', 1) && j.price != null ? `<small>Price ${esc(money2(j.price))}${j.pay_amount != null ? ' · pay ' + esc(money2(j.pay_amount)) : ''}${feat('costs') ? ' · other costs ' + esc(money2(costTotal)) : ''}</small>` : ''}
    </div>
    <div id="jCrewFlags"></div>
    ${crewOnly && !closed && feat('dispatch') && crewOpt(j.service_type, 'steps') === 'foreman' ? `<p class="hint">${esc(firstName(j.assigned_to) || 'Your foreman')} marks the steps for the crew.</p>` : ''}
    ${!closed && !crewOnly && (mine || mgr || !j.assigned_to) && next ? `<div class="stepbar">
      <button class="btn gold block big" id="jStep" data-s="${next}">${esc(STEP_BTN[next])}</button>
      <small class="hint" id="jStepHint">${['arrived', 'left'].includes(next) ? 'This saves where your phone is, so allow location if it asks.' : ''}</small>
      <div class="quick">${mgr ? '<button class="btn ghost small" data-s2="no_show">No-show</button><button class="btn ghost small danger" data-s2="cancelled">Cancel job</button>' : '<button class="btn ghost small" data-s2="no_show">Customer no-show</button>'}</div></div>` : ''}
    <div id="jCrew"></div>
    <div class="card"><h2>Photos and notes</h2>
      <div class="quick"><label class="btn secondary small">📷 Photo<input type="file" accept="image/*" capture="environment" id="jPhoto" hidden></label>
        <button class="btn secondary small" id="jNote">Note</button><button class="btn secondary small" id="jProb">Report a problem</button>
        ${feat('dispatch') ? '<button class="btn ghost small" id="jPin">Check-in spot is wrong</button>' : ''}</div>
      <div class="timeline" style="margin-top:10px">${(ev || []).map((e) => `<div class="entry ${e.flagged ? 'flagged' : ''}"><small>${esc(fmtDT(e.created_at))} · ${esc(C.userName(e.created_by))} · ${esc(e.kind === 'status' ? STATUS[e.status] || e.status : e.kind === 'problem' ? 'Problem' : e.kind === 'photo' ? 'Photo' : 'Note')}
        ${e.distance_ft != null ? ` · ${Math.round(e.distance_ft)} ft from the pin` : ''}${e.lat != null ? ` · <a href="${mapLink(e.lat, e.lng)}" target="_blank" rel="noopener">where</a>` : ''}</small>
        ${e.note ? `<div>${esc(e.note)}</div>` : ''}${e.photo_path && photos[e.photo_path] ? `<a href="${esc(photos[e.photo_path])}" target="_blank" rel="noopener"><img class="jobphoto" src="${esc(photos[e.photo_path])}" alt="Job photo"></a>` : ''}</div>`).join('') || '<p class="empty">Nothing yet.</p>'}</div></div>
    ${feat('costs') ? `<div class="card"><h2>Other costs${costTotal ? ' · ' + esc(money2(costTotal)) : ''}</h2>
      ${(costs || []).map((c) => `<div class="listrow"><span style="flex:1"><b>${esc(c.item)}</b>${c.qty != 1 ? ` × ${esc(Number(c.qty))}` : ''}${c.notes ? `<br><small>${esc(c.notes)}</small>` : ''}${c.category ? '' : ' <span class="badge gold">Waiting on a manager</span>'}</span>
        <b>${esc(money2(c.amount))}</b>${c.created_by === S.me.id && !['approved', 'auto'].includes(j.approval) || can('costs', 3) ? `<button class="btn ghost small danger" data-crm="${c.id}" aria-label="Remove">✕</button>` : ''}</div>`).join('') || '<p class="empty">None.</p>'}
      <div class="costadd"><select id="cP" aria-label="Item"><option value="">Pick an item…</option>${(presets || []).map((p) => `<option value="${p.id}" data-c="${esc(p.default_cost ?? '')}">${esc(p.item)}</option>`).join('')}<option value="_new">Something else (one time)</option></select>
        <input id="cItem" placeholder="What was it" maxlength="80" hidden><div class="row"><input id="cQty" type="number" min="0.001" step="any" value="1" aria-label="Quantity"><input id="cAmt" type="number" min="0" step="0.01" placeholder="Price each" aria-label="Price each"></div>
        <textarea id="cNotes" rows="2" placeholder="Notes (optional): which one, what happened"></textarea>
        <div class="actions"><button class="btn small" id="cAdd">Add cost</button></div>
        <small class="hint">Something new goes to a manager to sort out. Other costs count toward job profit only; they never go to accounting.</small></div></div>` : ''}
    <div class="card" id="jobCF" hidden></div>
    <div id="jEscBox"></div>`;
  $('#jBack', main).onclick = () => C.goBack();
  $$('[data-oid]', main).forEach((b) => (b.onclick = () => C.go('org', b.dataset.oid)));
  if ($('#jEdit', main)) $('#jEdit', main).onclick = () => jobEditor(j);
  $('#jEsc', main).onclick = () => C.escalatePanel($('#jEscBox', main), { id: co.id, name: `${co.name}: ${j.title} #${j.number}`, notePrefix: `${L('job')} #${j.number} ${j.title}: ${S.pub()}/#job/${j.id}` });
  const step = async (s, btn) => {
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    let g = null;
    if (['arrived', 'left'].includes(s) && feat('dispatch')) { g = await where(); if (!g) C.toast('No GPS. It still saves, and a manager sees that it had no location.'); }
    const { data, error: e } = await sb.rpc('job_step', { p_job: j.id, p_status: s, p_lat: g?.lat ?? null, p_lng: g?.lng ?? null, p_accuracy: g?.acc ?? null, p_note: null });
    if (e) { if (btn) btn.disabled = false; return C.fail(e); }
    if (data?.flag === 'far_arrive' || data?.flag === 'far_leave') {
      C.toast(`You're about ${data.feet} ft from the check-in spot (allowed ${data.radius}). It saved and your manager will see it. If the spot is wrong, tap "Check-in spot is wrong".`, { error: false });
    } else C.toast(STATUS[s] || 'Saved');
    viewJob(main);
  };
  if ($('#jStep', main)) $('#jStep', main).onclick = (e) => step(e.currentTarget.dataset.s, e.currentTarget);
  $$('[data-s2]', main).forEach((b) => (b.onclick = () => { if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Tap again to confirm'; return; } step(b.dataset.s2); }));
  const addEvent = async (kind, note, photo) => { const { error: e } = await sb.rpc('job_note', { p_job: j.id, p_kind: kind, p_note: note, p_photo: photo }); if (e) return C.fail(e); C.toast('Saved'); viewJob(main); };
  $('#jPhoto', main).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return; C.toast('Uploading…');
    try { const p = await uploadPhoto(f); addEvent('photo', null, p); } catch (err) { C.fail(err); }
  };
  const ask = (title, kind) => {
    const d = dlg('jnDlg', `<div class="vhead"><h2 style="margin:0">${esc(title)}</h2><button class="btn ghost small" data-x>Close</button></div>
      <textarea id="jnT" rows="4" placeholder="${kind === 'problem' ? 'What happened? Dictation works here.' : 'Dictation works here.'}"></textarea>
      <div class="actions"><button class="btn" id="jnGo">Save</button></div>`);
    $('[data-x]', d).onclick = () => d.close(); $('#jnT', d).focus();
    $('#jnGo', d).onclick = () => { const t = $('#jnT', d).value.trim(); if (!t) return; d.close(); addEvent(kind, t); };
  };
  $('#jNote', main).onclick = () => ask('Add a note', 'note');
  $('#jProb', main).onclick = () => ask('Report a problem', 'problem');
  if ($('#jPin', main)) $('#jPin', main).onclick = () => {
    const d = dlg('jpDlg', `<div class="vhead"><h2 style="margin:0">Check-in spot is wrong</h2><button class="btn ghost small" data-x>Close</button></div>
      <p>Stand where you actually check in (by the dumpster, at the gate), then send. A manager approves it and the pin moves for next time.</p>
      <label class="label">Photo of the spot</label><input type="file" accept="image/*" capture="environment" id="jpF">
      <label class="label" for="jpN">Note</label><input id="jpN" maxlength="200" placeholder="Dumpster is behind building C">
      <div class="actions"><button class="btn" id="jpGo">Send my spot</button></div>`);
    $('[data-x]', d).onclick = () => d.close();
    $('#jpGo', d).onclick = async (ev2) => {
      ev2.currentTarget.disabled = true;
      const g = await where(); if (!g) { ev2.currentTarget.disabled = false; return C.toast('Couldn\'t get your location. Allow location for this site and try again.', { error: true }); }
      let p = null; const f = $('#jpF', d).files[0]; if (f) try { p = await uploadPhoto(f, 'pins'); } catch (err) { return C.fail(err); }
      const { error: e } = await sb.rpc('pin_report', { p_job: j.id, p_lat: g.lat, p_lng: g.lng, p_accuracy: g.acc, p_note: $('#jpN', d).value, p_photo: p });
      if (e) return C.fail(e); d.close(); C.toast('Sent to your manager');
    };
  };
  if ($('#cP', main)) {
    $('#cP', main).onchange = (e) => { const o = e.target.selectedOptions[0]; $('#cItem', main).hidden = e.target.value !== '_new'; if (o?.dataset.c) $('#cAmt', main).value = o.dataset.c; };
    $('#cAdd', main).onclick = async () => {
      const pv = $('#cP', main).value; if (!pv) return C.toast('Pick an item', { error: true });
      const item = pv === '_new' ? $('#cItem', main).value.trim() : null; if (pv === '_new' && !item) return C.toast('Say what it was', { error: true });
      const { error: e } = await sb.rpc('job_cost_add', { p_job: j.id, p_preset: pv === '_new' ? null : pv, p_item: item, p_qty: Number($('#cQty', main).value) || 1,
        p_unit_cost: $('#cAmt', main).value === '' ? null : Number($('#cAmt', main).value), p_notes: $('#cNotes', main).value });
      if (e) return C.fail(e); C.toast('Cost added'); viewJob(main);
    };
    $$('[data-crm]', main).forEach((b) => (b.onclick = async () => { const { error: e } = await sb.rpc('job_cost_remove', { p_cost: b.dataset.crm }); if (e) return C.fail(e); viewJob(main); }));
  }
  crewCard($('#jCrew', main), j, { mgr, closed, reload: () => viewJob(main) }).catch(C.fail);
  crewFlagsBox($('#jCrewFlags', main), { job: j.id, onDone: () => viewJob(main) }).catch(C.fail);
  customFieldsBox($('#jobCF', main), 'jobs', j, async (custom) => { const { error: e } = await sb.from('jobs').update({ custom: j.schedule_id ? { ...custom, _edited: true } : custom }).eq('id', j.id); if (e) { C.fail(e); return false; } }, can('jobs', 2) && !closed);
}

/* ================= repeat schedules ================= */
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function ruleText(r) {
  if (!r) return '';
  const t = r.start_time ? ' at ' + new Date('2000-01-01T' + r.start_time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  const ev = r.every > 1 ? `Every ${r.every} ` : 'Every ';
  if (r.freq === 'daily') return (r.every > 1 ? `Every ${r.every} days` : 'Every day') + t;
  if (r.freq === 'weekly') { const days = (r.days || []).slice().sort(); const wk = days.join() === '1,2,3,4,5' ? 'weeknight' : days.length === 7 ? 'day' : days.map((d) => DOW[d - 1]).join(', ');
    return (r.every > 1 ? `Every ${r.every} weeks on ` : 'Every ') + wk + t; }
  if (r.freq === 'monthly') return `${ev}${r.every > 1 ? 'months' : 'month'} on day ${r.day_of_month || 1}` + t;
  return '';
}
async function viewSchedules(main) {
  if (crewMode() === 'standing') await loadCrews();
  const { data, error } = await C.divQ(sb.from('job_schedules').select('*, companies(name)')).order('active', { ascending: false }).order('title');
  if (error) return C.fail(error);
  main.innerHTML = `<div class="toolbar"><h1 style="margin:0;flex:1">${esc(L('schedule', true))}</h1>${can('jobs', 4) ? `<button class="btn small" id="sNew">+ ${esc(L('schedule'))}</button>` : ''}</div>
    <p class="empty">A schedule keeps its ${esc(l('job', true))} made three weeks ahead. Changing one ${esc(l('job'))} never changes the rest. Changing the schedule updates the upcoming ones nobody has started.</p>
    <div class="list">${(data || []).map((s) => `<button class="item" data-s="${s.id}"><b>${esc(s.title)}${s.active ? '' : ' <span class="badge">Paused</span>'}</b><small>${esc([s.companies?.name, ruleText(s.rule), s.assigned_to ? C.userName(s.assigned_to) : 'Unassigned'].filter(Boolean).join(' · '))}</small></button>`).join('') || '<p class="empty">None yet.</p>'}</div>`;
  if ($('#sNew', main)) $('#sNew', main).onclick = () => scheduleEditor(null, {});
  $$('[data-s]', main).forEach((b) => (b.onclick = () => scheduleEditor(data.find((s) => s.id === b.dataset.s))));
}
export function scheduleEditor(s, seed = {}) {
  const r = s?.rule || { freq: 'weekly', every: 1, days: [1, 2, 3, 4, 5], start_time: '19:00', duration_min: 60 };
  let company = { id: s?.company_id || seed.company_id || null, name: s?.companies?.name || seed.company_name || '' };
  let divs = [...(s?.divisions || seed.divisions || [])];
  const ro = !can('jobs', 4);
  const d = dlg('schDlg', `<div class="vhead"><h2 style="margin:0">${s ? esc(s.title) : 'New ' + esc(l('schedule'))}</h2><button class="btn ghost small" data-x>Close</button></div>
    <label class="label">Customer</label><div id="seCo"></div>
    <label class="label" for="seT">What</label><input id="seT" maxlength="120" value="${esc(s?.title || seed.title || '')}" placeholder="Nightly valet trash">
    <div class="row"><div><label class="label" for="seF">Repeats</label><select id="seF">${[['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].map(([v, n]) => `<option value="${v}" ${r.freq === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div><label class="label" for="seE">Every</label><input id="seE" type="number" min="1" max="12" value="${esc(r.every || 1)}"></div></div>
    <div id="seDays"><label class="label">On</label><div class="chips">${DOW.map((n, i) => `<button type="button" class="chip ${(r.days || []).includes(i + 1) ? 'on' : ''}" data-dw="${i + 1}">${n}</button>`).join('')}</div></div>
    <div id="seDom" hidden><label class="label" for="seD">Day of the month</label><input id="seD" type="number" min="1" max="28" value="${esc(r.day_of_month || 1)}"></div>
    <div class="row"><div><label class="label" for="seS">Start time</label><input id="seS" type="time" value="${esc(r.start_time || '19:00')}"></div>
      <div><label class="label" for="seM">How long (minutes)</label><input id="seM" type="number" min="5" step="5" value="${esc(r.duration_min || 60)}"></div></div>
    <div class="row"><div><label class="label" for="seA">Starts on</label><input id="seA" type="date" value="${esc(s?.starts_on || C.today())}"></div>
      <div><label class="label" for="seZ">Ends on (optional)</label><input id="seZ" type="date" value="${esc(s?.ends_on || '')}"></div></div>
    <div class="row"><div><label class="label" for="seW">${esc(L('worker'))}</label><select id="seW">${workerOptions(s?.assigned_to)}</select></div>
      <div><label class="label" for="seP">Price each time</label><input id="seP" type="number" step="0.01" value="${esc(s?.price ?? '')}"></div></div>
    ${crewMode() === 'standing' && (S.crews || []).length ? `<label class="label" for="seCr">Crew</label><select id="seCr"><option value="">No saved crew</option>${S.crews.map((c) => `<option value="${c.id}" ${s?.crew_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <small class="hint">Each ${esc(l('job'))} it makes gets the whole crew, with the foreman as the ${esc(l('worker'))} unless you pick one.</small>` : ''}
    <label class="label" for="seSc">Scope</label><textarea id="seSc" rows="2">${esc(s?.scope || '')}</textarea>
    <div id="seDiv"></div>
    ${s ? `<label class="check"><input type="checkbox" id="seOn" ${s.active ? 'checked' : ''}> Active</label>` : ''}
    ${ro ? '' : `<div class="actions"><button class="btn" id="seGo">${s ? 'Save and update upcoming' : 'Start schedule'}</button></div>`}`);
  $('[data-x]', d).onclick = () => d.close();
  coPicker($('#seCo', d), company, (c) => { company = c; if (!divs.length && c.divisions?.length) divs = c.divisions; });
  C.divPicker($('#seDiv', d), divs, (n) => { divs = n; });
  const days = new Set(r.days || []);
  $$('[data-dw]', d).forEach((b) => (b.onclick = () => { const v = +b.dataset.dw; days.has(v) ? days.delete(v) : days.add(v); b.classList.toggle('on'); }));
  const vis = () => { $('#seDays', d).hidden = $('#seF', d).value !== 'weekly'; $('#seDom', d).hidden = $('#seF', d).value !== 'monthly'; };
  $('#seF', d).onchange = vis; vis();
  if (ro) return;
  $('#seGo', d).onclick = async () => {
    if (!company.id) return C.toast('Pick the customer first', { error: true });
    const title = $('#seT', d).value.trim(); if (!title) return C.toast('Say what it is', { error: true });
    const freq = $('#seF', d).value; if (freq === 'weekly' && !days.size) return C.toast('Pick at least one day', { error: true });
    const rule = { freq, every: Math.max(1, Number($('#seE', d).value) || 1), start_time: $('#seS', d).value || '09:00', duration_min: Math.max(5, Number($('#seM', d).value) || 60),
      ...(freq === 'weekly' ? { days: [...days].sort() } : {}), ...(freq === 'monthly' ? { day_of_month: Math.min(28, Math.max(1, Number($('#seD', d).value) || 1)) } : {}) };
    const f = { company_id: company.id, title, rule, starts_on: $('#seA', d).value || C.today(), ends_on: $('#seZ', d).value || null, assigned_to: $('#seW', d).value || null,
      price: $('#seP', d).value === '' ? null : Number($('#seP', d).value), scope: $('#seSc', d).value.trim() || null, divisions: divs,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago', ...(s ? { active: $('#seOn', d).checked } : {}), ...($('#seCr', d) ? { crew_id: $('#seCr', d).value || null } : {}) };
    const res = s ? await sb.from('job_schedules').update(f).eq('id', s.id).select('id').single() : await sb.from('job_schedules').insert(f).select('id').single();
    if (res.error) return C.fail(res.error);
    const g = s ? await sb.rpc('schedule_apply', { p_schedule: res.data.id }) : await sb.rpc('schedules_generate', { p_days: 21 });
    if (g.error) return C.fail(g.error);
    d.close(); C.toast(s ? 'Schedule saved. Upcoming ' + l('job', true) + ' updated.' : 'Schedule started'); C.renderShell();
  };
}

/* ================= dispatch board ================= */
let DDAY = null;
async function viewDispatch(main) {
  if (!feat('dispatch')) return C.go('jobs');
  DDAY = DDAY || C.today();
  await sb.rpc('schedules_generate', { p_days: 21 });
  const { data, error } = await C.divQ(sb.from('jobs').select('id,number,title,status,approval,scheduled_start,scheduled_end,assigned_to,flags,companies(name)'))
    .is('archived_at', null).gte('scheduled_start', dayStart(DDAY)).lt('scheduled_start', dayEnd(DDAY)).not('status', 'in', '(cancelled)').order('scheduled_start');
  if (error) return C.fail(error);
  const standing = crewMode() === 'standing';
  const [cm, crews] = await Promise.all([crewFor((data || []).map((j) => j.id)), standing ? loadCrews(true) : Promise.resolve([])]);
  (data || []).forEach((j) => (j._crew = cm[j.id] || []));
  const unassigned = (data || []).filter((j) => !j.assigned_to);
  const cols = [{ id: '', name: 'Unassigned', jobs: unassigned }, ...workers().map((u) => ({ id: u.id, name: u.full_name, jobs: (data || []).filter((j) => j.assigned_to === u.id) }))]
    .filter((c) => c.id === '' || c.jobs.length || C.recall('dispShowAll', { v: false }).v);
  const crewOpts = (j) => (standing && crews.length ? `<optgroup label="Crews">${crews.map((c) => `<option value="crew:${c.id}" ${j.crew_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>` : '');
  const card = (j) => `<div class="dcard" draggable="${can('dispatch', 2)}" data-j="${j.id}"><b>${esc(fmtTime(j.scheduled_start))} ${esc(j.title)}</b><small>${esc(j.companies?.name || '')}</small>
    ${j._crew.length > 1 ? `<small class="dcrew">${esc((crews.find((c) => c.id === j.crew_id)?.name || 'Crew') + ': ' + crewNames(j._crew, 6))}</small>` : ''}
    <div class="meta">${statusBadge(j)} ${flagBadges(j.flags)}</div>
    ${can('dispatch', 2) ? `<select data-mv="${j.id}" aria-label="Move to"><option value="">Unassigned</option>${workers().map((u) => `<option value="${u.id}" ${u.id === j.assigned_to && !j.crew_id ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}${crewOpts(j)}</select>` : ''}</div>`;
  main.innerHTML = `<div class="toolbar"><h1 style="margin:0;flex:1">Dispatch</h1>
      <button class="btn ghost small" id="dPrev" aria-label="Previous day">‹</button><input type="date" id="dDay" value="${esc(DDAY)}" style="max-width:170px"><button class="btn ghost small" id="dNext" aria-label="Next day">›</button>
      <label class="check"><input type="checkbox" id="dAll" ${C.recall('dispShowAll', { v: false }).v ? 'checked' : ''}> Everyone</label>
      ${can('jobs', 2) ? `<button class="btn small" id="dNew">+ ${esc(L('job'))}</button>` : ''}</div>
    <small class="hint" style="margin:-6px 0 10px">${(data || []).length} ${esc(l('job', (data || []).length !== 1))} · drag a card to another column, or use its menu${standing && crews.length && can('dispatch', 2) ? ' · drag a crew onto a card to send the whole crew' : ''}</small>
    ${standing && crews.length ? `<div class="chips dcrews">${crews.map((c) => `<span class="chip crewchip" draggable="${can('dispatch', 2)}" data-crewdrag="${c.id}" title="${esc([C.userName(c.foreman_id), ...c.member_ids.map(C.userName)].join(', '))}">⚒ ${esc(c.name)} <small>${1 + c.member_ids.length}</small></span>`).join('')}</div>` : ''}
    <div class="dboard">${cols.map((c) => `<div class="dcol" data-col="${c.id}"><div class="dhead"><b>${esc(c.name)}</b> <span class="count">${c.jobs.length}</span></div>${c.jobs.map(card).join('') || '<p class="empty">Nothing.</p>'}</div>`).join('')}</div>`;
  $('#dDay', main).onchange = (e) => { DDAY = e.target.value || C.today(); viewDispatch(main); };
  $('#dPrev', main).onclick = () => { DDAY = shiftDay(DDAY, -1); viewDispatch(main); };
  $('#dNext', main).onclick = () => { DDAY = shiftDay(DDAY, 1); viewDispatch(main); };
  $('#dAll', main).onchange = (e) => { C.store('dispShowAll', { v: e.target.checked }); viewDispatch(main); };
  if ($('#dNew', main)) $('#dNew', main).onclick = () => jobEditor(null, { scheduled_start: new Date(DDAY + 'T09:00:00').toISOString() });
  const sendCrew = async (id, crewId) => {
    const { data: r, error: e } = await sb.rpc('job_crew_set', { p_job: id, p_crew: crewId, p_people: null, p_lead: null }); if (e) return C.fail(e);
    C.toast(`${crews.find((c) => c.id === crewId)?.name || 'Crew'} is on it${r?.swaps ? '. Moves off their usual crew go to the supervisor.' : ''}`); viewDispatch(main);
  };
  const move = async (id, to) => {
    if (to && to.startsWith('crew:')) return sendCrew(id, to.slice(5));
    const j = (data || []).find((x) => x.id === id);
    // a crew job dropped on one person: that person runs it alone
    const { error: e } = j?.crew_id || j?._crew.length > 1 ? await sb.rpc('job_crew_set', { p_job: id, p_crew: null, p_people: to ? [to] : [], p_lead: to || null })
      : await sb.from('jobs').update({ assigned_to: to || null }).eq('id', id);
    if (e) return C.fail(e); C.toast(to ? 'Assigned to ' + C.userName(to) : 'Unassigned'); viewDispatch(main);
  };
  $$('[data-mv]', main).forEach((s) => { s.onclick = (e) => e.stopPropagation(); s.onchange = () => move(s.dataset.mv, s.value); });
  $$('.dcard', main).forEach((c) => {
    c.onclick = (e) => { if (!e.target.closest('select')) C.go('job', c.dataset.j); };
    c.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.dataset.j);
    // a crew dropped on a card: the whole crew goes on that job
    c.ondragover = (e) => { if (e.dataTransfer.types.includes('application/x-crew')) { e.preventDefault(); e.stopPropagation(); c.classList.add('over'); } };
    c.ondragleave = () => c.classList.remove('over');
    c.ondrop = (e) => { const cr = e.dataTransfer.getData('application/x-crew'); if (!cr) return; e.preventDefault(); e.stopPropagation(); c.classList.remove('over'); sendCrew(c.dataset.j, cr); };
  });
  $$('[data-crewdrag]', main).forEach((ch) => (ch.ondragstart = (e) => { e.dataTransfer.setData('application/x-crew', ch.dataset.crewdrag); e.dataTransfer.setData('text/plain', ''); }));
  $$('.dcol', main).forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = (e) => { e.preventDefault(); col.classList.remove('over'); if (e.dataTransfer.getData('application/x-crew')) return C.toast('Drop the crew on a ' + l('job') + ' card'); const id = e.dataTransfer.getData('text/plain'); if (id) move(id, col.dataset.col); };
  });
}

/* ================= crews: who's on a job, saved crews and crew checks ================= */
// the crew card on a job: everyone on it, the lead, and (for dispatch) changing it
async function crewCard(box, j, { mgr, closed, reload }) {
  if (!box) return;
  const standing = crewMode() === 'standing';
  const [{ data: rows }, crews] = await Promise.all([
    sb.from('job_crew').select('*').eq('job_id', j.id).is('removed_at', null).order('added_at'),
    standing ? loadCrews() : Promise.resolve([])]);
  const list = (rows || []).sort((a, b) => (a.role === 'lead' ? -1 : 0) - (b.role === 'lead' ? -1 : 0));
  const ids = list.map((r) => r.user_id);
  const me = list.find((r) => r.user_id === S.me.id);
  const crew = crews.find((c) => c.id === j.crew_id);
  const each = crewOpt(j.service_type, 'steps') === 'each' && feat('dispatch');
  const fClock = crewOpt(j.service_type, 'clock') === 'foreman' && feat('timeclock');
  const edit = mgr && !closed;
  box.innerHTML = `<div class="card"><h2>${list.length > 1 || crew ? 'Crew' : esc(L('worker'))}${crew ? ' · ' + esc(crew.name) : ''}</h2>
    ${list.map((r) => `<div class="listrow" data-cr="${r.user_id}"><span style="flex:1"><b>${esc(C.userName(r.user_id))}</b>
      ${r.role === 'lead' ? ` <span class="badge ok">${list.length > 1 ? 'Foreman' : 'Lead'}</span>` : ''}${r.absent ? ' <span class="badge due">Wasn\'t here</span>' : ''}
      ${r.from_crew_id && r.from_crew_id !== j.crew_id && crews.find((c) => c.id === r.from_crew_id) ? ` <small>from ${esc(crews.find((c) => c.id === r.from_crew_id).name)}</small>` : ''}
      ${r.arrived_at || r.left_at ? `<br><small>${r.arrived_at ? 'Arrived ' + esc(fmtTime(r.arrived_at)) : ''}${r.left_at ? ' · left ' + esc(fmtTime(r.left_at)) : ''}</small>` : ''}</span>
      ${edit && r.role !== 'lead' ? `<button class="btn ghost small" data-lead="${r.user_id}">Make ${list.length > 1 ? 'foreman' : 'lead'}</button>` : ''}
      ${edit ? `<button class="btn ghost small danger" data-off="${r.user_id}" aria-label="Take off this job">✕</button>` : ''}</div>`).join('') || '<p class="empty">Nobody yet.</p>'}
    ${edit ? `${standing && crews.length ? `<div class="pline"><select id="crPick" aria-label="Saved crew"><option value="">Use a saved crew…</option>${crews.map((c) => `<option value="${c.id}" ${c.id === j.crew_id ? 'selected' : ''}>${esc(c.name)} (${esc(firstName(c.foreman_id))} + ${c.member_ids.length})</option>`).join('')}</select><button class="btn small" id="crUse">Use crew</button></div>` : ''}
      <div class="pline"><select id="crAdd" aria-label="Add someone"><option value="">Add someone…</option>${workers().filter((u) => !ids.includes(u.id)).map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}</select><button class="btn secondary small" id="crAddGo">Add</button></div>
      ${standing ? '<small class="hint">Pulling someone onto this job doesn\'t change their usual crew.</small>' : ''}` : ''}
    ${me && each && !closed ? `<div class="actions">${!me.arrived_at ? '<button class="btn gold" data-mark="arrived">I\'m here</button>' : !me.left_at ? '<button class="btn gold" data-mark="left">I\'m leaving</button>' : ''}</div>` : ''}
    ${fClock && !closed && (j.assigned_to === S.me.id || mgr) && list.length ? `<div class="actions"><button class="btn secondary" data-cclock="in">Clock in the crew</button><button class="btn secondary" data-cclock="out">Clock out the crew</button></div>
      <small class="hint">The ${esc(list.length > 1 ? 'foreman' : 'lead')} clocks everyone on this ${esc(l('job'))}. It saves where the phone is.</small>` : ''}</div>`;
  const save = async (crewId, people, lead) => {
    const { data, error } = await sb.rpc('job_crew_set', { p_job: j.id, p_crew: crewId || null, p_people: people, p_lead: lead || null });
    if (error) return C.fail(error);
    C.toast(data?.swaps ? 'Saved. The move off their usual crew goes to their supervisor.' : 'Saved'); reload();
  };
  const lead = list.find((r) => r.role === 'lead')?.user_id;
  if ($('#crUse', box)) $('#crUse', box).onclick = () => { const v = $('#crPick', box).value; if (!v) return C.toast('Pick a crew', { error: true }); save(v, null, null); };
  if ($('#crAddGo', box)) $('#crAddGo', box).onclick = () => { const v = $('#crAdd', box).value; if (!v) return; save(j.crew_id, [...ids, v], lead || v); };
  $$('[data-lead]', box).forEach((b) => (b.onclick = () => save(j.crew_id, ids, b.dataset.lead)));
  $$('[data-off]', box).forEach((b) => (b.onclick = () => { const rest = ids.filter((x) => x !== b.dataset.off); save(rest.length ? j.crew_id : null, rest, rest.includes(lead) ? lead : rest[0]); }));
  $$('[data-mark]', box).forEach((b) => (b.onclick = async () => {
    b.disabled = true; const g = await where(); if (!g) C.toast('No GPS. It still saves, and a manager sees that it had no location.');
    const { data, error } = await sb.rpc('crew_mark', { p_job: j.id, p_step: b.dataset.mark, p_lat: g?.lat ?? null, p_lng: g?.lng ?? null, p_accuracy: g?.acc ?? null });
    if (error) { b.disabled = false; return C.fail(error); }
    C.toast(data?.flag === 'far' ? `You're about ${data.feet} ft from the check-in spot (allowed ${data.radius}). It saved and your manager will see it.` : 'Saved'); reload();
  }));
  $$('[data-cclock]', box).forEach((b) => (b.onclick = async () => {
    b.disabled = true; const g = await where(); if (!g) C.toast('No GPS. It still saves, and a manager sees that it had no location.');
    const { data, error } = await sb.rpc('crew_clock', { p_job: j.id, p_dir: b.dataset.cclock, p_lat: g?.lat ?? null, p_lng: g?.lng ?? null, p_accuracy: g?.acc ?? null });
    if (error) { b.disabled = false; return C.fail(error); }
    C.toast(`${b.dataset.cclock === 'in' ? 'Clocked in' : 'Clocked out'} ${C.plural(data || 0, 'person', 'people')}`); reload();
  }));
}

// open crew checks: missed clock-ins (the foreman answers) and moves off someone's usual crew (the supervisor marks OK)
export async function crewFlagsBox(box, { job = null, mine = false, onDone } = {}) {
  if (!box || !feat('jobs')) return;
  let q = sb.from('crew_flags').select('*, jobs(id,number,title)').eq('status', 'open').order('created_at').limit(100);
  if (job) q = q.eq('job_id', job);
  const { data, error } = await q;
  if (error || !box.isConnected) { if (box) box.innerHTML = ''; return; }
  let rows = (data || []).filter((f) => job || f.jobs);
  if (mine) rows = rows.filter((f) => f.foreman_id === S.me.id || f.supervisor_id === S.me.id);
  if (!rows.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card crewflags"><h2>Crew check</h2>${rows.map((f) => {
    const answer = f.kind === 'missed_clock' && (f.foreman_id === S.me.id || f.supervisor_id === S.me.id || can('dispatch', 2));
    const ok = f.kind === 'swap' && (f.supervisor_id === S.me.id || can('review', 3));
    return `<div class="listrow" data-cf="${f.id}" style="flex-wrap:wrap"><span style="flex:1;min-width:200px"><b>${f.kind === 'swap' ? 'Moved for one ' + esc(l('job')) : 'Missed clock-in'}</b>
        <br><small>${esc(f.summary || '')}${f.jobs && !job ? ` · #${esc(f.jobs.number)} ${esc(f.jobs.title)}` : ''}</small></span>
      ${answer ? '<button class="btn small" data-here="1">Was here</button><button class="btn secondary small" data-here="0">Wasn\'t here</button>' : f.kind === 'missed_clock' ? '<small class="hint">Waiting on the foreman</small>' : ''}
      ${ok ? '<button class="btn small" data-seen>OK</button>' : ''}
      ${f.jobs && !job ? `<button class="btn ghost small" data-jopen="${f.job_id}">Open</button>` : ''}
      <div data-ans style="flex-basis:100%"></div></div>`;
  }).join('')}</div>`;
  const done = (msg) => { C.toast(msg); C.refreshCounts?.(); onDone ? onDone() : crewFlagsBox(box, { job, mine }); };
  $$('[data-cf]', box).forEach((row) => {
    const f = rows.find((x) => x.id === row.dataset.cf);
    $$('[data-here]', row).forEach((b) => (b.onclick = async () => {
      if (b.dataset.here === '0') {
        if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Tap again to confirm'; return; }
        const { error } = await sb.rpc('crew_missed_answer', { p_flag: f.id, p_here: false, p_hours: null, p_note: null });
        return error ? C.fail(error) : done('Marked not here');
      }
      const a = $('[data-ans]', row);
      a.innerHTML = `<div class="row"><div><label class="label">Hours they worked</label><input type="number" data-hrs min="0.25" max="24" step="0.25" placeholder="6"></div>
        <div><label class="label">Note (optional)</label><input data-note maxlength="300" placeholder="Phone died"></div></div>
        <div class="actions"><button class="btn small" data-save>Add the hours</button></div><small class="hint">Their supervisor approves or fixes these hours before they count for pay.</small>`;
      $('[data-save]', a).onclick = async () => {
        const h = Number($('[data-hrs]', a).value); if (!(h > 0 && h <= 24)) return C.toast('Enter the hours they worked (up to 24)', { error: true });
        const { error } = await sb.rpc('crew_missed_answer', { p_flag: f.id, p_here: true, p_hours: h, p_note: $('[data-note]', a).value });
        return error ? C.fail(error) : done('Hours added. Their supervisor reviews them.');
      };
    }));
    if ($('[data-seen]', row)) $('[data-seen]', row).onclick = async () => { const { error } = await sb.rpc('crew_flag_seen', { p_id: f.id, p_note: null }); return error ? C.fail(error) : done('OK'); };
    if ($('[data-jopen]', row)) $('[data-jopen]', row).onclick = () => C.go('job', f.job_id);
  });
}
async function crewFlagCount() {
  if (!feat('jobs')) return 0;
  const { data } = await sb.from('crew_flags').select('id,kind,foreman_id,supervisor_id').eq('status', 'open').limit(500);
  return (data || []).filter((f) => f.foreman_id === S.me.id || f.supervisor_id === S.me.id || can('review', 3)).length;
}

// saved crews (standing crews mode)
async function viewCrews(main) {
  if (!feat('jobs')) return C.go('dashboard');
  const crews = await loadCrews(true);
  const edit = canCrews();
  main.innerHTML = `<div class="toolbar"><h1 style="margin:0;flex:1">Crews</h1>${edit && crewMode() === 'standing' ? '<button class="btn small" id="crNew">+ Crew</button>' : ''}</div>
    ${crewMode() !== 'standing' ? `<div class="banner warn"><b>Standing crews are off</b><span>This account picks people for each ${esc(l('job'))}. ${C.isAdmin() ? 'Turn standing crews on in Settings, under Crews.' : 'An admin can turn standing crews on in Settings.'}</span></div>` : ''}
    <p class="empty">A crew is a foreman and the people who usually work with them. Put the crew on a ${esc(l('job'))} and everyone comes along. Pulling someone onto another ${esc(l('job'))} doesn't change their crew.</p>
    <div class="list">${crews.map((c) => `<button class="item" data-crew="${c.id}"><b>${esc(c.name)}</b>
      <small>${esc(['Foreman ' + C.userName(c.foreman_id), c.member_ids.map(C.userName).join(', '), c.supervisor_id ? 'supervisor ' + C.userName(c.supervisor_id) : ''].filter(Boolean).join(' · '))}</small></button>`).join('') || '<p class="empty">No crews yet.</p>'}</div>`;
  if ($('#crNew', main)) $('#crNew', main).onclick = () => crewEditor(null, () => viewCrews(main));
  $$('[data-crew]', main).forEach((b) => (b.onclick = () => crewEditor(crews.find((c) => c.id === b.dataset.crew), () => viewCrews(main))));
}
function crewEditor(c, done) {
  const ro = !canCrews();
  const others = (S.crews || []).filter((x) => x.id !== c?.id);
  const usual = (u) => { const o = others.find((x) => x.foreman_id === u || x.member_ids.includes(u)); return o ? ` (now on ${o.name})` : ''; };
  const d = dlg('crDlg', `<div class="vhead"><h2 style="margin:0">${c ? esc(c.name) : 'New crew'}</h2><button class="btn ghost small" data-x>Close</button></div>
    <label class="label" for="ceN">Name</label><input id="ceN" maxlength="60" value="${esc(c?.name || '')}" placeholder="Bob's crew">
    <div class="row"><div><label class="label" for="ceF">Foreman</label><select id="ceF">${workerOptions(c?.foreman_id, 'Pick the foreman')}</select></div>
      <div><label class="label" for="ceS">Supervisor</label><select id="ceS">${workerOptions(c?.supervisor_id, 'Their manager')}</select></div></div>
    <label class="label">Always with them</label><div class="chips" id="ceM">${workers().map((u) => `<button type="button" class="chip ${c?.member_ids.includes(u.id) ? 'on' : ''}" data-m="${u.id}">${esc(u.full_name)}${esc(c?.member_ids.includes(u.id) ? '' : usual(u.id))}</button>`).join('')}</div>
    <small class="hint">Adding someone here moves them off their old crew. Moves made by anyone but the supervisor show up in the supervisor's Review.</small>
    ${ro ? '' : `<div class="actions"><button class="btn" id="ceGo">Save crew</button>${c ? '<button class="btn ghost small danger" id="ceArc">Retire this crew</button>' : ''}</div>`}`);
  $('[data-x]', d).onclick = () => d.close();
  const mem = new Set(c?.member_ids || []);
  $$('[data-m]', d).forEach((b) => (b.onclick = () => { const v = b.dataset.m; mem.has(v) ? mem.delete(v) : mem.add(v); b.classList.toggle('on'); }));
  if (ro) return;
  $('#ceGo', d).onclick = async () => {
    const f = $('#ceF', d).value; if (!f) return C.toast('Pick the foreman', { error: true });
    const { error } = await sb.rpc('crew_save', { p_id: c?.id || null, p_name: $('#ceN', d).value.trim(), p_foreman: f, p_members: [...mem].filter((x) => x !== f), p_supervisor: $('#ceS', d).value || null, p_divisions: c?.divisions || [] });
    if (error) return C.fail(error); d.close(); C.toast('Crew saved'); await loadCrews(true); done();
  };
  if ($('#ceArc', d)) $('#ceArc', d).onclick = async (e) => {
    if (!e.currentTarget.dataset.armed) { e.currentTarget.dataset.armed = 1; e.currentTarget.textContent = 'Tap again to retire it'; return; }
    const { error } = await sb.rpc('crew_archive', { p_id: c.id }); if (error) return C.fail(error); d.close(); C.toast('Crew retired'); await loadCrews(true); done();
  };
}
// a time entry's fix dialog (Time screen and Review)
function timeFixDialog(t, done) {
  const d = dlg('tfDlg', `<div class="vhead"><h2 style="margin:0">Fix ${esc(C.userName(t.user_id))}'s time</h2><button class="btn ghost small" data-x>Close</button></div>
    <div class="row dtrow"><div><label class="label" for="tfI">In</label><input id="tfI" type="datetime-local" value="${esc(localInput(t.clock_in))}"></div><div><label class="label" for="tfO">Out</label><input id="tfO" type="datetime-local" value="${esc(localInput(t.clock_out))}"></div></div>
    <label class="label" for="tfB">Break minutes</label><input id="tfB" type="number" min="0" value="${esc(t.break_min || 0)}">
    <label class="label" for="tfR">Why (required, it's kept in the history)</label><input id="tfR" maxlength="300" placeholder="Forgot to clock out">
    <div class="actions"><button class="btn" id="tfGo">Save</button></div>`);
  $('[data-x]', d).onclick = () => d.close();
  $('#tfGo', d).onclick = async () => {
    const { error: e } = await sb.rpc('time_fix', { p_id: t.id, p_in: fromLocal($('#tfI', d).value), p_out: fromLocal($('#tfO', d).value), p_break_min: Number($('#tfB', d).value) || 0, p_reason: $('#tfR', d).value });
    if (e) return C.fail(e); d.close(); C.toast('Saved. It goes back to Review.'); done();
  };
}

/* ================= time clock ================= */
export async function clockCard(box) {
  if (!box || !feat('timeclock') || !can('timeclock', 2)) { if (box) box.innerHTML = ''; return; }
  const { data: open } = await sb.from('time_entries').select('*, jobs(title,number), companies(name)').eq('user_id', S.me.id).is('clock_out', null).maybeSingle();
  const onBreak = open && open.breaks?.length && !open.breaks[open.breaks.length - 1].end;
  let todays = [];
  if (!open && feat('jobs')) {
    const t = C.today();
    const on = await jobsOn(S.me.id);
    let q = sb.from('jobs').select('id,number,title,company_id,companies(name)');
    q = on.length ? q.or(`assigned_to.eq.${S.me.id},id.in.(${on.join(',')})`) : q.eq('assigned_to', S.me.id);
    todays = (await q.is('archived_at', null)
      .gte('scheduled_start', dayStart(t)).lt('scheduled_start', dayEnd(t)).not('status', 'in', '(left,cancelled,no_show)').order('scheduled_start')).data || [];
  }
  box.innerHTML = `<div class="card clockcard"><h2>Time clock</h2>
    ${open ? `<p><b>${onBreak ? 'On break' : 'Clocked in'}</b> since ${esc(fmtTime(onBreak ? open.breaks[open.breaks.length - 1].start : open.clock_in))}${open.jobs ? ' · ' + esc(open.jobs.title) : open.companies ? ' · ' + esc(open.companies.name) : ''}</p>
      <div class="actions"><button class="btn gold" id="ckOut">Clock out</button><button class="btn secondary" id="ckBr">${onBreak ? 'End break' : 'Start break'}</button></div>`
    : `${todays.length ? `<label class="label" for="ckJob">For</label><select id="ckJob"><option value="">No particular ${esc(l('job'))}</option>${todays.map((j) => `<option value="${j.id}">${esc(j.title)} · ${esc(j.companies?.name || '')}</option>`).join('')}</select>` : ''}
      <div class="actions"><button class="btn gold block big" id="ckIn">Clock in</button></div>`}
    <small class="hint">Clocking in and out saves where your phone is.</small></div>`;
  const gps = async () => { const g = await where(); if (!g) C.toast('No GPS. It still saves, and your manager sees it had no location.'); return g; };
  if ($('#ckIn', box)) $('#ckIn', box).onclick = async (e) => {
    e.currentTarget.disabled = true; const g = await gps();
    const { error } = await sb.rpc('clock_in', { p_job: $('#ckJob', box)?.value || null, p_company: null, p_lat: g?.lat ?? null, p_lng: g?.lng ?? null, p_accuracy: g?.acc ?? null });
    if (error) { e.currentTarget.disabled = false; return C.fail(error); } C.toast('Clocked in'); clockCard(box);
  };
  if ($('#ckOut', box)) $('#ckOut', box).onclick = async (e) => {
    e.currentTarget.disabled = true; const g = await gps();
    const { error } = await sb.rpc('clock_out', { p_lat: g?.lat ?? null, p_lng: g?.lng ?? null, p_accuracy: g?.acc ?? null, p_note: null });
    if (error) { e.currentTarget.disabled = false; return C.fail(error); } C.toast('Clocked out'); clockCard(box);
  };
  if ($('#ckBr', box)) $('#ckBr', box).onclick = async () => { const { data, error } = await sb.rpc('break_toggle'); if (error) return C.fail(error); C.toast(data === 'on_break' ? 'Break started' : 'Back to work'); clockCard(box); };
}
let TW = null;
async function viewTime(main) {
  if (!feat('timeclock')) return C.go('dashboard');
  TW = TW || { from: shiftDay(C.today(), -13), to: C.today(), who: can('timeclock', 3) ? '' : S.me.id };
  let q = sb.from('time_entries').select('*, jobs(title,number), companies(name)').gte('clock_in', dayStart(TW.from)).lt('clock_in', dayEnd(TW.to)).order('clock_in', { ascending: false }).limit(500);
  if (TW.who) q = q.eq('user_id', TW.who);
  const { data, error } = await q; if (error) return C.fail(error);
  const total = (data || []).reduce((a, t) => a + hrsOf(t), 0);
  const fixer = can('timeclock', 3);
  main.innerHTML = `<h1>Time</h1><div id="tClock"></div>
    <div class="toolbar"><input type="date" id="tF" value="${esc(TW.from)}" style="max-width:170px"><span>to</span><input type="date" id="tT" value="${esc(TW.to)}" style="max-width:170px">
      ${can('timeclock', 1) && scopeOf('timeclock') !== 'own' ? `<select id="tW" style="max-width:200px"><option value="">Everyone I can see</option>${workers().map((u) => `<option value="${u.id}" ${TW.who === u.id ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}</select>` : ''}</div>
    <p class="empty">${(data || []).length} entries · ${total.toFixed(2)} hours</p>
    <div class="tw"><table class="ptable"><thead><tr><th>Who</th><th>In</th><th>Out</th><th>Break</th><th>Hours</th><th>For</th><th>Status</th>${fixer ? '<th></th>' : ''}</tr></thead><tbody>
    ${(data || []).map((t) => `<tr><td>${esc(C.userName(t.user_id))}</td><td>${esc(fmtDT(t.clock_in))}</td><td>${t.clock_out ? esc(fmtTime(t.clock_out)) : '<span class="badge gold">Open</span>'}</td>
      <td>${t.break_min ? t.break_min + 'm' : ''}</td><td>${hrsOf(t).toFixed(2)}</td><td>${esc(t.jobs?.title || t.companies?.name || '')}</td>
      <td><span class="badge ${['approved', 'auto'].includes(t.status) ? 'ok' : t.status === 'returned' ? 'due' : ''}">${esc({ open: 'Open', pending: 'Waiting', approved: 'Approved', auto: 'Auto-approved', returned: 'Sent back' }[t.status])}</span> ${flagBadges(t.flags)}
        ${t.edit_reason ? `<br><small>Changed: ${esc(t.edit_reason)}</small>` : ''}</td>${fixer ? `<td>${t.user_id !== S.me.id || C.isAdmin() ? `<button class="btn ghost small" data-fix="${t.id}">Fix</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
  clockCard($('#tClock', main));
  const set = (k, v) => { TW = { ...TW, [k]: v }; viewTime(main); };
  $('#tF', main).onchange = (e) => set('from', e.target.value); $('#tT', main).onchange = (e) => set('to', e.target.value);
  if ($('#tW', main)) $('#tW', main).onchange = (e) => set('who', e.target.value);
  $$('[data-fix]', main).forEach((b) => (b.onclick = () => timeFixDialog(data.find((x) => x.id === b.dataset.fix), () => viewTime(main))));
}

/* ================= pay: rates, periods, batches and the export builder ================= */
const EXPORT_FIELDS = [
  ['employee_name', 'Name'], ['first_name', 'First name'], ['last_name', 'Last name'], ['email', 'Email'], ['external_id', 'Payroll ID / file number'], ['payroll_code', 'Company or department code'],
  ['worker_class', 'W-2 or 1099'], ['division', 'Company (division)'], ['pay_kind', 'Pay type'], ['earnings_code', 'Earnings code'], ['hours', 'Hours'], ['regular_hours', 'Regular hours'], ['overtime_hours', 'Overtime hours'],
  ['days', 'Days'], ['jobs', 'Jobs'], ['rate', 'Rate'], ['amount', 'Amount'], ['period_start', 'Period start'], ['period_end', 'Period end'], ['pay_date', 'Pay date'], ['batch_id', 'Batch ID'],
];
// starting points. Payroll systems differ by setup, so check a template against a sample import file from your own payroll account.
const EXPORT_TEMPLATES = {
  adp_run: { name: 'ADP RUN (check against your ADP import)', fields: [['payroll_code', 'Co Code'], ['batch_id', 'Batch ID'], ['external_id', 'File #'], ['regular_hours', 'Reg Hours'], ['overtime_hours', 'O/T Hours'], ['earnings_code', 'Earnings 3 Code'], ['amount', 'Earnings 3 Amount']] },
  adp_wfn: { name: 'ADP Workforce Now (check against your ADP import)', fields: [['payroll_code', 'Co Code'], ['batch_id', 'Batch ID'], ['external_id', 'File #'], ['regular_hours', 'Reg Hours'], ['overtime_hours', 'O/T Hours'], ['earnings_code', 'Hours 3 Code'], ['amount', 'Earnings 3 Amount']] },
  gusto: { name: 'Gusto', fields: [['last_name', 'last_name'], ['first_name', 'first_name'], ['external_id', 'employee_id'], ['regular_hours', 'regular_hours'], ['overtime_hours', 'overtime_hours'], ['amount', 'bonus']] },
  quickbooks: { name: 'QuickBooks Payroll', fields: [['employee_name', 'Employee'], ['period_start', 'Pay period start'], ['period_end', 'Pay period end'], ['pay_kind', 'Pay item'], ['hours', 'Hours'], ['rate', 'Rate'], ['amount', 'Amount']] },
  generic: { name: 'Everything (generic CSV)', fields: EXPORT_FIELDS.map(([k, n]) => [k, n]) },
};
let PAYTAB = 'batches';
async function viewPay(main) {
  if (!feat('pay')) return C.go('dashboard');
  const tabs = [['batches', 'Pay batches'], ['rates', 'People and rates'], ['periods', 'Pay periods'], ['templates', 'Export templates']];
  main.innerHTML = `<h1>Pay</h1><p class="empty">The CRM tracks who worked, what got approved and what each person is owed, then hands it to your payroll or accounting system. It never moves money or runs payroll.</p>
    <div class="pltabs">${tabs.map(([k, n]) => `<button type="button" class="pltab ${PAYTAB === k ? 'on' : ''}" data-pt="${k}">${n}</button>`).join('')}</div><div id="payBody" style="margin-top:12px"><p class="empty">Loading…</p></div>`;
  $$('[data-pt]', main).forEach((b) => (b.onclick = () => { PAYTAB = b.dataset.pt; viewPay(main); }));
  const body = $('#payBody', main);
  if (PAYTAB === 'rates') return payRates(body);
  if (PAYTAB === 'periods') return payPeriods(body);
  if (PAYTAB === 'templates') return payTemplates(body);
  return payBatches(body);
}
async function payRates(box) {
  const [{ data: profiles }, { data: rates }] = await Promise.all([sb.from('worker_pay_profiles').select('*'), sb.from('pay_rates').select('*').is('archived_at', null).order('effective_from', { ascending: false })]);
  const mgr = can('pay', 4);
  const people = can('pay', 1) ? workers() : workers().filter((u) => u.id === S.me.id);
  box.innerHTML = people.map((u) => {
    const p = (profiles || []).find((x) => x.user_id === u.id) || {}; const rs = (rates || []).filter((r) => r.user_id === u.id);
    return `<div class="card" data-pu="${u.id}"><div class="toolbar"><b style="flex:1">${esc(u.full_name)}</b><span class="badge">${p.worker_class === '1099' ? '1099 contractor' : 'W-2 employee'}</span>
        <span class="badge ${p.tax_doc === 'received' ? 'ok' : 'due'}">${p.worker_class === '1099' ? 'W-9' : 'W-4'} ${esc(p.tax_doc || 'missing')}</span></div>
      ${mgr ? `<div class="row"><div><label class="label">Type</label><select data-pf="worker_class"><option value="w2" ${p.worker_class !== '1099' ? 'selected' : ''}>W-2 employee</option><option value="1099" ${p.worker_class === '1099' ? 'selected' : ''}>1099 contractor</option></select></div>
        <div><label class="label">Tax form</label><select data-pf="tax_doc">${['missing', 'requested', 'received'].map((v) => `<option ${p.tax_doc === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
        <div class="row"><div><label class="label">Payroll ID / file number</label><input data-pf="external_id" value="${esc(p.external_id || '')}" maxlength="40"></div>
          <div><label class="label">Company or department code</label><input data-pf="payroll_code" value="${esc(p.payroll_code || '')}" maxlength="40"></div></div>
        <label class="label">Where pay goes (words only, never bank numbers)</label><input data-pf="payout_note" value="${esc(p.payout_note || '')}" maxlength="200" placeholder="Direct deposit set up in ADP">` : ''}
      <h3 class="section">Rates</h3>${rs.map((r) => `<div class="listrow"><span style="flex:1">${esc({ hourly: 'Hourly', daily: 'Daily', per_job: 'Per job' }[r.kind])} ${esc(money2(r.rate))}${r.division_id ? ' · ' + esc(C.divName(r.division_id)) : ''}</span><small>from ${esc(C.fmtDate(r.effective_from))}</small></div>`).join('') || '<p class="empty">No rate yet.</p>'}
      ${mgr ? `<div class="pline"><select data-rk aria-label="Pay type"><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="per_job">Per job</option></select>
        <input data-rr type="number" step="0.01" placeholder="Rate" style="max-width:110px" aria-label="Rate">
        ${(S.divisions || []).length > 1 ? `<select data-rd aria-label="Company"><option value="">All companies</option>${S.divisions.map((dv) => `<option value="${dv.id}">${esc(dv.name)}</option>`).join('')}</select>` : ''}
        <input data-rf type="date" value="${esc(C.today())}" style="max-width:160px" aria-label="Starting"><button class="btn small" data-radd>Add rate</button></div>
        <small class="hint">A new rate starts on its date; older periods keep the old one. A company's own rate beats the all-companies rate.</small>` : ''}</div>`;
  }).join('') || '<p class="empty">Nobody on the team yet.</p>';
  if (!mgr) return;
  $$('[data-pu]', box).forEach((card) => {
    const uid = card.dataset.pu;
    $$('[data-pf]', card).forEach((el) => (el.onchange = async () => {
      const cur = (profiles || []).find((x) => x.user_id === uid);
      const f = { [el.dataset.pf]: el.value.trim() || null, ...(el.dataset.pf === 'tax_doc' && el.value === 'received' ? { tax_doc_at: C.today() } : {}) };
      const { error } = cur ? await sb.from('worker_pay_profiles').update(f).eq('user_id', uid) : await sb.from('worker_pay_profiles').insert({ user_id: uid, ...f });
      if (error) return C.fail(error); C.toast('Saved'); if (!cur) payRates(box);
    }));
    $('[data-radd]', card).onclick = async () => {
      const rate = Number($('[data-rr]', card).value); if (!(rate >= 0) || $('[data-rr]', card).value === '') return C.toast('Type the rate', { error: true });
      const { error } = await sb.rpc('pay_rate_save', { p_user: uid, p_kind: $('[data-rk]', card).value, p_rate: rate, p_division: $('[data-rd]', card)?.value || null, p_from: $('[data-rf]', card).value || C.today(), p_note: null });
      if (error) return C.fail(error); C.toast('Rate added'); payRates(box);
    };
  });
}
// the period that contains a day, for a pay schedule
export function periodFor(s, day) {
  const d = new Date(day + 'T12:00:00'), iso = (x) => isoDay(x);
  const anchor = new Date((s.anchor || day) + 'T12:00:00');
  const back = (n) => { const x = new Date(d); x.setDate(x.getDate() - n); return x; };
  if (s.freq === 'daily') return [day, day];
  if (s.freq === 'weekly' || s.freq === 'biweekly') {
    const len = s.freq === 'weekly' ? 7 : 14, diff = Math.floor((d - anchor) / 86400000), off = ((diff % len) + len) % len;
    const st = back(off), en = new Date(st); en.setDate(st.getDate() + len - 1); return [iso(st), iso(en)];
  }
  if (s.freq === 'semimonthly') { const y = d.getFullYear(), m = d.getMonth(); return d.getDate() <= 15 ? [iso(new Date(y, m, 1, 12)), iso(new Date(y, m, 15, 12))] : [iso(new Date(y, m, 16, 12)), iso(new Date(y, m + 1, 0, 12))]; }
  if (s.freq === 'monthly') { const y = d.getFullYear(), m = d.getMonth(); return [iso(new Date(y, m, 1, 12)), iso(new Date(y, m + 1, 0, 12))]; }
  // twice weekly and custom: periods end on the cut days (weekdays, or days of the month for monthly custom)
  const cuts = (s.cut_days || []).slice().sort((a, b) => a - b); if (!cuts.length) return [day, day];
  const isCut = (x) => (s.custom_unit === 'month' ? cuts.includes(x.getDate()) : cuts.includes(((x.getDay() + 6) % 7) + 1));
  let en = new Date(d); for (let i = 0; i < 62 && !isCut(en); i++) en.setDate(en.getDate() + 1);
  let st = new Date(en); st.setDate(st.getDate() - 1); for (let i = 0; i < 62 && !isCut(st); i++) st.setDate(st.getDate() - 1); st.setDate(st.getDate() + 1);
  return [iso(st), iso(en)];
}
const FREQ = [['daily', 'Daily'], ['twice_weekly', 'Twice a week'], ['weekly', 'Weekly'], ['biweekly', 'Every two weeks'], ['semimonthly', 'Twice a month (1st-15th, 16th-end)'], ['monthly', 'Monthly'], ['custom', 'Custom']];
async function payPeriods(box) {
  const { data } = await sb.from('pay_schedules').select('*').is('archived_at', null).order('created_at');
  const mgr = can('pay', 4);
  box.innerHTML = `${(data || []).map((s) => { const [a, b] = periodFor(s, C.today()); return `<div class="card"><div class="toolbar"><b style="flex:1">${esc(s.name)}${s.is_default ? ' <span class="badge ok">Default</span>' : ''}</b><small>${esc(FREQ.find((f) => f[0] === s.freq)?.[1])}</small></div>
      <small>This period: ${esc(C.fmtDate(a))} to ${esc(C.fmtDate(b))} · payday ${esc(s.payday_lag_days)} days after it ends</small>
      ${mgr ? `<div class="actions">${s.is_default ? '' : `<button class="btn ghost small" data-def="${s.id}">Make default</button>`}<button class="btn ghost small danger" data-rm="${s.id}">Remove</button></div>` : ''}</div>`; }).join('') || '<p class="empty">No pay periods yet.</p>'}
    ${mgr ? `<div class="card"><h2>Add a pay period</h2>
      <label class="label" for="ppN">Name</label><input id="ppN" maxlength="60" placeholder="Weekly, paid Friday">
      <div class="row"><div><label class="label" for="ppF">How often</label><select id="ppF">${FREQ.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></div>
        <div><label class="label" for="ppA">A day a period starts on</label><input id="ppA" type="date" value="${esc(C.today())}"></div></div>
      <div id="ppCut" hidden><label class="label">Periods end on</label><div class="row"><select id="ppU"><option value="week">Days of the week</option><option value="month">Days of the month</option></select><input id="ppD" placeholder="Wed, Sat  or  10, 25"></div></div>
      <label class="label" for="ppL">Payday, days after the period ends</label><input id="ppL" type="number" min="0" max="31" value="5">
      <small class="hint">Friday direct deposit depends on your payroll provider's cutoff. Set the lag so approvals and the export land before it.</small>
      <div class="actions"><button class="btn small" id="ppGo">Add</button></div></div>` : ''}`;
  if (!mgr) return;
  $('#ppF', box).onchange = (e) => ($('#ppCut', box).hidden = !['twice_weekly', 'custom'].includes(e.target.value));
  $('#ppGo', box).onclick = async () => {
    const name = $('#ppN', box).value.trim(); if (!name) return C.toast('Name it', { error: true });
    const freq = $('#ppF', box).value; let cut = [], unit = null;
    if (['twice_weekly', 'custom'].includes(freq)) {
      unit = freq === 'twice_weekly' ? 'week' : $('#ppU', box).value;
      const raw = $('#ppD', box).value.split(/[,\s]+/).filter(Boolean);
      cut = raw.map((x) => (unit === 'week' ? DOW.findIndex((n) => n.toLowerCase() === x.slice(0, 3).toLowerCase()) + 1 : Number(x))).filter((n) => n >= 1 && n <= (unit === 'week' ? 7 : 31));
      if (!cut.length) return C.toast(unit === 'week' ? 'Type the days, like Wed, Sat' : 'Type the days of the month, like 10, 25', { error: true });
    }
    const { error } = await sb.from('pay_schedules').insert({ name, freq, anchor: $('#ppA', box).value || C.today(), cut_days: cut, custom_unit: unit, payday_lag_days: Number($('#ppL', box).value) || 0, is_default: !(data || []).length });
    if (error) return C.fail(error); C.toast('Pay period added'); payPeriods(box);
  };
  $$('[data-def]', box).forEach((b) => (b.onclick = async () => { await sb.from('pay_schedules').update({ is_default: false }).neq('id', b.dataset.def); const { error } = await sb.from('pay_schedules').update({ is_default: true }).eq('id', b.dataset.def); if (error) return C.fail(error); payPeriods(box); }));
  $$('[data-rm]', box).forEach((b) => (b.onclick = async () => { const { error } = await sb.from('pay_schedules').update({ archived_at: new Date().toISOString() }).eq('id', b.dataset.rm); if (error) return C.fail(error); payPeriods(box); }));
}
async function payBatches(box) {
  const [{ data: batches }, { data: scheds }] = await Promise.all([sb.from('pay_batches').select('*').order('period_end', { ascending: false }).limit(40), sb.from('pay_schedules').select('*').is('archived_at', null)]);
  const mgr = can('pay', 4) && !needsMfa();
  const def = (scheds || []).find((s) => s.is_default) || (scheds || [])[0];
  const [ps, pe] = def ? periodFor(def, shiftDay(C.today(), -1)) : [shiftDay(C.today(), -7), shiftDay(C.today(), -1)];
  box.innerHTML = `${can('pay', 4) && needsMfa() ? '<div class="banner warn"><b>Two-step sign in needed</b><span>Your account requires it to build or export pay. Set it up from the gear menu.</span></div>' : ''}
    ${mgr ? `<div class="card"><h2>Build a pay batch</h2>
      <div class="row"><div><label class="label" for="pbS">Pay period</label><select id="pbS"><option value="">Pick dates myself</option>${(scheds || []).map((s) => `<option value="${s.id}" ${def?.id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
        <div><label class="label" for="pbC">Who</label><select id="pbC"><option value="w2">W-2 employees</option><option value="1099">1099 contractors</option></select></div></div>
      <div class="row"><div><label class="label" for="pbA">From</label><input id="pbA" type="date" value="${esc(ps)}"></div><div><label class="label" for="pbB">To</label><input id="pbB" type="date" value="${esc(pe)}"></div></div>
      <small class="hint">Only approved time and approved ${esc(l('job', true))} go in. W-2 and 1099 always build separately.</small>
      <div class="actions"><button class="btn small" id="pbGo">Build</button></div></div>` : ''}
    <div class="list">${(batches || []).map((b) => `<button class="item" data-b="${b.id}"><b>${esc(C.fmtDate(b.period_start))} to ${esc(C.fmtDate(b.period_end))} · ${b.worker_class === '1099' ? '1099' : 'W-2'}</b>
      <small>${esc(money2(b.total))} · <span class="badge ${b.status === 'draft' ? 'gold' : 'ok'}">${esc({ draft: 'Draft', final: 'Final', exported: 'Exported' }[b.status])}</span>${b.pay_date ? ' · pays ' + esc(C.fmtDate(b.pay_date)) : ''}</small></button>`).join('') || '<p class="empty">No batches yet.</p>'}</div><div id="pbView"></div>`;
  if ($('#pbS', box)) $('#pbS', box).onchange = (e) => { const s = (scheds || []).find((x) => x.id === e.target.value); if (!s) return; const [a, b] = periodFor(s, shiftDay(C.today(), -1)); $('#pbA', box).value = a; $('#pbB', box).value = b; };
  if ($('#pbGo', box)) $('#pbGo', box).onclick = async () => {
    const { data, error } = await sb.rpc('pay_batch_build', { p_start: $('#pbA', box).value, p_end: $('#pbB', box).value, p_class: $('#pbC', box).value, p_schedule: $('#pbS', box).value || null, p_batch: null });
    if (error) return C.fail(error); C.toast('Batch built'); await payBatches(box); batchView($('#pbView', box), data, () => payBatches(box));
  };
  $$('[data-b]', box).forEach((b) => (b.onclick = () => batchView($('#pbView', box), b.dataset.b, () => payBatches(box))));
}
async function batchView(box, id, reload) {
  const [{ data: b }, { data: lines }, { data: profiles }, { data: tpls }] = await Promise.all([sb.from('pay_batches').select('*').eq('id', id).single(), sb.from('pay_lines').select('*').eq('batch_id', id),
    sb.from('worker_pay_profiles').select('*'), sb.from('export_templates').select('*').is('archived_at', null)]);
  const mgr = can('pay', 4) && !needsMfa();
  const KIND = { hourly: 'Regular hours', overtime: 'Overtime', daily: 'Daily', per_job: 'Per job', adjustment: 'Adjustment' };
  box.innerHTML = `<div class="card panel"><div class="toolbar"><h2 style="margin:0;flex:1">${esc(C.fmtDate(b.period_start))} to ${esc(C.fmtDate(b.period_end))} · ${b.worker_class === '1099' ? '1099' : 'W-2'}</h2><b>${esc(money2(b.total))}</b></div>
    <div class="tw"><table class="ptable"><thead><tr><th>Who</th><th>Company</th><th>Type</th><th>Hours</th><th>Days</th><th>Jobs</th><th>Rate</th><th>Amount</th></tr></thead><tbody>
    ${(lines || []).map((x) => `<tr><td>${esc(C.userName(x.user_id))}</td><td>${esc(C.divName(x.division_id) || '')}</td><td>${esc(KIND[x.kind])}</td><td>${x.hours ? Number(x.hours).toFixed(2) : ''}</td><td>${x.days || ''}</td><td>${x.jobs || ''}</td><td>${esc(money2(x.rate))}</td><td>${esc(money2(x.amount))}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">Nothing approved in this period yet.</td></tr>'}</tbody></table></div>
    ${mgr ? `<div class="actions" style="flex-wrap:wrap">
      ${b.status === 'draft' ? '<button class="btn small" data-a="rebuild">Rebuild</button><button class="btn gold small" data-a="finalize">Finalize</button><button class="btn ghost small danger" data-a="delete">Delete draft</button>' : ''}
      ${b.status === 'final' ? '<button class="btn ghost small" data-a="reopen">Reopen</button>' : ''}
      ${b.status !== 'draft' ? `<select id="exT" aria-label="Export template">${Object.entries(EXPORT_TEMPLATES).map(([k, t]) => `<option value="b:${k}">${esc(t.name)}</option>`).join('')}${(tpls || []).map((t) => `<option value="t:${t.id}">${esc(t.name)} (yours)</option>`).join('')}</select>
        <input id="exE" maxlength="10" placeholder="Earnings code" style="max-width:130px" aria-label="Earnings code"><button class="btn small" id="exGo">Download export</button>` : ''}</div>
      <small class="hint">Finalize locks the batch so the numbers can't move, then export. Exporting a 1099 batch also queues it for your accounting connection, once that's on.</small>` : ''}</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $$('[data-a]', box).forEach((btn) => (btn.onclick = async () => {
    const a = btn.dataset.a;
    if (a === 'rebuild') { const { error } = await sb.rpc('pay_batch_build', { p_start: b.period_start, p_end: b.period_end, p_class: b.worker_class, p_schedule: b.schedule_id, p_batch: b.id }); if (error) return C.fail(error); return batchView(box, id, reload); }
    if (a === 'delete' && !btn.dataset.armed) { btn.dataset.armed = 1; btn.textContent = 'Delete it?'; return; }
    const { error } = await sb.rpc('pay_batch_set', { p_batch: b.id, p_action: a }); if (error) return C.fail(error);
    C.toast({ finalize: 'Finalized', reopen: 'Reopened', delete: 'Deleted' }[a]); if (a === 'delete') { box.innerHTML = ''; return reload(); } batchView(box, id, reload); reload();
  }));
  if ($('#exGo', box)) $('#exGo', box).onclick = async () => {
    const v = $('#exT', box).value, [kind, key] = v.split(':');
    const t = kind === 'b' ? { name: EXPORT_TEMPLATES[key].name, fields: EXPORT_TEMPLATES[key].fields.map(([k, h]) => ({ key: k, header: h })), delimiter: ',', header_row: true }
      : (() => { const x = tpls.find((y) => y.id === key); return { ...x, fields: x.fields }; })();
    // with an overtime column, regular and overtime for the same person and company share one row
    const otCol = t.fields.some((f) => f.key === 'overtime_hours');
    const groups = [];
    (lines || []).forEach((x) => {
      const merge = otCol && (x.kind === 'hourly' || x.kind === 'overtime');
      const g = merge ? groups.find((y) => y.merge && y.user_id === x.user_id && y.division_id === x.division_id) : null;
      const reg = x.kind === 'hourly' ? Number(x.hours) : 0, over = x.kind === 'overtime' ? Number(x.hours) : 0;
      if (g) { g.reg += reg; g.over += over; g.hours += Number(x.hours); g.amount += Number(x.amount); if (x.kind === 'hourly') g.rate = x.rate; return; }
      groups.push({ merge, user_id: x.user_id, division_id: x.division_id, kind: merge ? 'hourly' : x.kind, reg: x.kind === 'overtime' && !otCol ? 0 : reg, over, hours: Number(x.hours), days: x.days, jobs: x.jobs, rate: x.rate, amount: Number(x.amount) });
    });
    const rows = groups.map((x) => {
      const u = S.users.find((y) => y.id === x.user_id) || {}, p = (profiles || []).find((y) => y.user_id === x.user_id) || {};
      const [first, ...rest] = (u.full_name || '').split(' ');
      const val = { employee_name: u.full_name, first_name: first, last_name: rest.join(' '), email: u.email, external_id: p.external_id, payroll_code: p.payroll_code, worker_class: b.worker_class === '1099' ? '1099' : 'W-2',
        division: C.divName(x.division_id), pay_kind: KIND[x.kind], earnings_code: $('#exE', box).value.trim(), hours: x.hours ? x.hours.toFixed(2) : '',
        regular_hours: x.kind === 'hourly' ? x.reg.toFixed(2) : '', overtime_hours: x.kind === 'hourly' && x.over ? x.over.toFixed(2) : '', days: x.days || '', jobs: x.jobs || '',
        rate: Number(x.rate).toFixed(2), amount: x.amount.toFixed(2), period_start: b.period_start, period_end: b.period_end, pay_date: b.pay_date || '', batch_id: b.id.slice(0, 8) };
      return t.fields.map((f) => val[f.key] ?? '');
    });
    const q = (s) => { s = String(s ?? ''); return /[",\n;\t|]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const csv = [...(t.header_row !== false ? [t.fields.map((f) => f.header)] : []), ...rows].map((r) => r.map(q).join(t.delimiter || ',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `pay-${b.worker_class}-${b.period_start}-to-${b.period_end}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    const { error } = await sb.rpc('pay_batch_set', { p_batch: b.id, p_action: 'exported', p_template: t.name }); if (error) return C.fail(error);
    C.toast('Export downloaded'); reload();
  };
}
async function payTemplates(box) {
  const { data } = await sb.from('export_templates').select('*').is('archived_at', null).order('name');
  const mgr = can('pay', 4);
  box.innerHTML = `<p class="empty">Built in: ${esc(Object.values(EXPORT_TEMPLATES).map((t) => t.name).join(', '))}. Payroll setups differ, so get a sample import file from your payroll account and match it here. Start from a built-in one and change the columns.</p>
    ${(data || []).map((t) => `<div class="card"><div class="toolbar"><b style="flex:1">${esc(t.name)}</b>${mgr ? `<button class="btn ghost small" data-ed="${t.id}">Edit</button>` : ''}</div><small>${esc(t.fields.map((f) => f.header).join(t.delimiter === '\t' ? ' ⇥ ' : ' ' + t.delimiter + ' '))}</small></div>`).join('')}
    ${mgr ? `<div class="actions"><select id="tbBase">${Object.entries(EXPORT_TEMPLATES).map(([k, t]) => `<option value="${k}">${esc(t.name)}</option>`).join('')}</select><button class="btn small" id="tbNew">Make my own from this</button></div>` : ''}
    <div id="tbEd"></div>`;
  const editor = (t) => {
    const ed = $('#tbEd', box); let fields = t.fields.map((f) => ({ ...f }));
    const paint = () => {
      ed.innerHTML = `<div class="card panel"><label class="label" for="tbN">Name</label><input id="tbN" value="${esc(t.name)}" maxlength="60">
        <div class="row"><div><label class="label" for="tbD">Separator</label><select id="tbD">${[[',', 'Comma'], [';', 'Semicolon'], ['\t', 'Tab'], ['|', 'Pipe']].map(([v, n]) => `<option value="${esc(v)}" ${t.delimiter === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          <div><label class="check" style="margin-top:26px"><input type="checkbox" id="tbH" ${t.header_row !== false ? 'checked' : ''}> Header row</label></div></div>
        <h3 class="section">Columns, in order</h3>
        ${fields.map((f, i) => `<div class="listrow" data-i="${i}"><select data-k>${EXPORT_FIELDS.map(([k, n]) => `<option value="${k}" ${f.key === k ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
          <input data-h value="${esc(f.header)}" placeholder="Column header" aria-label="Column header"><button class="btn ghost small" data-up ${i ? '' : 'disabled'}>↑</button><button class="btn ghost small danger" data-x>✕</button></div>`).join('')}
        <div class="actions"><button class="btn secondary small" id="tbAdd">+ Column</button><button class="btn small" id="tbSave">Save template</button>${t.id ? '<button class="btn ghost small danger" id="tbRm">Remove</button>' : ''}</div></div>`;
      $$('[data-i]', ed).forEach((row) => { const i = +row.dataset.i;
        $('[data-k]', row).onchange = (e) => (fields[i].key = e.target.value); $('[data-h]', row).oninput = (e) => (fields[i].header = e.target.value);
        $('[data-up]', row).onclick = () => { [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]]; paint(); };
        $('[data-x]', row).onclick = () => { fields.splice(i, 1); paint(); }; });
      $('#tbAdd', ed).onclick = () => { fields.push({ key: 'amount', header: 'Amount' }); paint(); };
      $('#tbSave', ed).onclick = async () => {
        const f = { name: $('#tbN', ed).value.trim() || 'My export', fields: fields.filter((x) => x.header.trim()), delimiter: $('#tbD', ed).value, header_row: $('#tbH', ed).checked, base: t.base || null };
        if (!f.fields.length) return C.toast('Add at least one column', { error: true });
        const { error } = t.id ? await sb.from('export_templates').update(f).eq('id', t.id) : await sb.from('export_templates').insert(f);
        if (error) return C.fail(error); C.toast('Template saved'); payTemplates(box);
      };
      if ($('#tbRm', ed)) $('#tbRm', ed).onclick = async () => { const { error } = await sb.from('export_templates').update({ archived_at: new Date().toISOString() }).eq('id', t.id); if (error) return C.fail(error); payTemplates(box); };
    };
    paint(); ed.scrollIntoView({ behavior: 'smooth' });
  };
  if ($('#tbNew', box)) $('#tbNew', box).onclick = () => { const k = $('#tbBase', box).value; editor({ name: EXPORT_TEMPLATES[k].name.replace(/ \(.*\)/, '') + ' (mine)', base: k, delimiter: ',', header_row: true, fields: EXPORT_TEMPLATES[k].fields.map(([key, header]) => ({ key, header })) }); };
  $$('[data-ed]', box).forEach((b) => (b.onclick = () => editor(data.find((t) => t.id === b.dataset.ed))));
}

/* ================= accounting connection (Wave first) ================= */
const PROVIDERS = { wave: 'Wave', quickbooks: 'QuickBooks', xero: 'Xero' };
async function viewAccounting(main) {
  const [{ data: conns, error }, { data: maps }, { data: queue }, { data: sum }] = await Promise.all([
    sb.from('acct_connections').select('*'), sb.from('acct_mappings').select('*'),
    sb.from('acct_sync_queue').select('*').order('created_at', { ascending: false }).limit(100), sb.rpc('acct_sync_summary', { p_days: 7 })]);
  if (error) { main.innerHTML = '<h1>Accounting</h1><p class="empty">This needs the October 29 database update.</p>'; return; }
  const wave = (conns || []).find((c) => c.provider === 'wave');
  const mgr = can('pay', 4);
  const divs = (S.divisions || []).length ? S.divisions : [{ id: null, name: 'Everything' }];
  const mapRow = (kind, label, div) => { const m = (maps || []).find((x) => x.kind === kind && (x.division_id || null) === (div.id || null));
    return `<div class="listrow"><span style="flex:1">${esc(label)}${div.id ? ' · ' + esc(div.name) : ''}</span><input data-map="${kind}" data-div="${div.id || ''}" value="${esc(m?.external_name || '')}" placeholder="Wave account name" ${mgr ? '' : 'disabled'} style="max-width:260px"></div>`; };
  main.innerHTML = `<h1>Accounting</h1>
    <div class="card"><h2>Wave</h2>
      <p>${wave?.status === 'connected' ? `<span class="badge ok">Connected</span> ${esc(wave.external_business_name || '')}` : '<span class="badge">Not connected yet</span>'}</p>
      <small class="hint">What goes to Wave: invoices, payments and contractor pay (as bills). W-2 payroll goes out as an export file for your payroll system, since Wave has no payroll API. Other job costs never go. Full accounting and reports stay in Wave; the CRM pulls back whether invoices are paid.</small>
      ${wave?.status === 'connected' ? '' : '<p class="hint">Connecting needs GELP registered as a Wave app and a Wave Pro (or Advisor) plan on your side. That part is being finished next.</p>'}</div>
    <div class="card"><h2>Which Wave account each thing posts to</h2>
      ${divs.map((d) => mapRow('income', 'Sales', d) + mapRow('labor', 'Labor', d) + mapRow('contractor', 'Contractor costs', d)).join('')}
      <small class="hint">Each company gets its own accounts so its numbers stay separate in Wave. Once Wave is connected these become pick lists from your chart of accounts.</small></div>
    <div class="card"><h2>Last 7 days</h2>
      <div class="dtiles"><div class="dtile"><b>${sum?.queued ?? 0}</b><span>Waiting to send</span></div><div class="dtile ${sum?.failed ? 'hot' : ''}"><b>${sum?.failed ?? 0}</b><span>Failed</span></div>
        <div class="dtile"><b>${sum?.sent ?? 0}</b><span>Sent · ${esc(money2(sum?.sent_total || 0))}</span></div></div>
      <div class="tw"><table class="ptable"><thead><tr><th>When</th><th>What</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>
      ${(queue || []).map((q) => `<tr><td>${esc(fmtDT(q.created_at))}</td><td>${esc({ invoice: 'Invoice', payment: 'Payment', contractor_bill: 'Contractor bill', payroll_journal: 'Payroll journal' }[q.entity_type])}</td>
        <td>${esc(money2(q.amount))}</td><td><span class="badge ${q.status === 'sent' ? 'ok' : q.status === 'failed' ? 'due' : ''}">${esc(q.status)}</span>${q.last_error ? `<br><small>${esc(q.last_error)}</small>` : ''}</td>
        <td>${q.status === 'failed' && mgr ? `<button class="btn ghost small" data-retry="${q.id}">Retry</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nothing yet.</td></tr>'}</tbody></table></div>
      <small class="hint">The same item never posts twice: each one has its own key, so sending it again is skipped.</small></div>`;
  $$('[data-map]', main).forEach((inp) => (inp.onchange = async () => {
    const f = { provider: 'wave', kind: inp.dataset.map, division_id: inp.dataset.div || null, pay_kind: null };
    const name = inp.value.trim();
    const cur = (maps || []).find((x) => x.kind === f.kind && (x.division_id || null) === f.division_id);
    const { error: e } = !name ? (cur ? await sb.from('acct_mappings').delete().eq('id', cur.id) : { error: null })
      : cur ? await sb.from('acct_mappings').update({ external_name: name, external_id: cur.external_id || 'pending:' + name }).eq('id', cur.id)
      : await sb.from('acct_mappings').insert({ ...f, external_name: name, external_id: 'pending:' + name });
    if (e) return C.fail(e); C.toast('Saved');
  }));
  $$('[data-retry]', main).forEach((b) => (b.onclick = async () => { const { error: e } = await sb.rpc('acct_sync_retry', { p_id: b.dataset.retry }); if (e) return C.fail(e); viewAccounting(main); }));
}

/* ================= Review: field work ================= */
const RK = { job_done: 'Finished jobs', timesheet: 'Timesheets', gps_flag: 'GPS flags', pin_change: 'Pin changes', cost_category: 'Costs to sort', preset_suggestion: 'Preset suggestions' };
const RK1 = { job_done: 'Finished', timesheet: 'Timesheet', gps_flag: 'GPS flag', pin_change: 'Pin change', cost_category: 'Cost to sort', preset_suggestion: 'Preset suggestion' };
const rkName = (k) => (k === 'job_done' ? 'Finished ' + l('job', true) : RK[k]);
const rkOne = (k) => (k === 'job_done' ? 'Finished ' + l('job') : RK1[k]);
const REVIEW_DEFAULTS = () => [
  { key: 'pending', name: 'Everything waiting', filters: {} },
  { key: 'jobs', name: 'Finished ' + l('job', true), filters: { kind: 'job_done' } },
  { key: 'time', name: 'Timesheets', filters: { kind: 'timesheet' } },
  { key: 'pins', name: 'Pin changes', filters: { kind: 'pin_change' } },
  { key: 'gps', name: 'GPS flags', filters: { kind: 'gps_flag' } },
  { key: 'costs', name: 'Costs to sort', filters: { kind: 'cost_category' } },
  { key: 'auto', name: 'Auto-approved', filters: { status: 'auto' } },
];
let RF = null;
export function fieldReviewOn() { return (feat('jobs') || feat('timeclock')) && can('review', 1); }
export async function fieldReview(box) {
  if (!box || !fieldReviewOn()) return;
  RF = RF || C.recall('reviewFilters', {});
  const apply = (f) => { RF = { ...f }; C.store('reviewFilters', RF); fieldReview(box); };
  const st = RF.status || (RF.done ? null : 'pending');
  let q = sb.from('work_reviews').select('*, jobs(id,number,title,price,scheduled_start), companies(name)').order('created_at', { ascending: st === 'pending' }).limit(200);
  if (st) q = q.eq('status', st); else q = q.in('status', ['approved', 'returned', 'auto', 'dismissed']);
  if (RF.kind) q = q.eq('kind', RF.kind);
  if (RF.who) q = q.eq('worker_id', RF.who);
  if (RF.div) q = q.contains('divisions', [RF.div]);
  if (RF.from) q = q.gte('created_at', dayStart(RF.from));
  if (RF.to) q = q.lt('created_at', dayEnd(RF.to));
  const [{ data, error }, { data: pend }] = await Promise.all([q, sb.from('work_reviews').select('kind').eq('status', 'pending').limit(5000)]);
  if (error) { box.innerHTML = ''; return; }
  const counts = {}; (pend || []).forEach((r) => (counts[r.kind] = (counts[r.kind] || 0) + 1));
  const scCounts = { 'd:pending': (pend || []).length, 'd:jobs': counts.job_done || 0, 'd:time': counts.timesheet || 0, 'd:pins': counts.pin_change || 0, 'd:gps': counts.gps_flag || 0, 'd:costs': counts.cost_category || 0 };
  const photos = await signed((data || []).map((r) => r.details?.photo));
  const decide = can('review', 3) && !needsMfa();
  const item = (r) => {
    const own = r.worker_id === S.me.id && !C.isAdmin() && ['job_done', 'timesheet'].includes(r.kind);
    const extra = r.kind === 'cost_category' ? `<div class="row"><select data-cat aria-label="Category"><option value="">Pick a category…</option>${CATS.map(([v, n]) => `<option value="${v}">${esc(n)}</option>`).join('')}</select>
        ${can('costs', 4) ? '<label class="check"><input type="checkbox" data-savep> Save as a preset</label>' : '<button type="button" class="btn ghost small" data-suggest>Suggest as preset</button>'}</div>
        <small>${esc(money2(Number(r.details?.qty || 1) * Number(r.details?.unit_cost || 0)))}${r.details?.notes ? ' · ' + esc(r.details.notes) : ''}</small>`
      : r.kind === 'pin_change' ? `<small>${r.details?.feet != null ? `${esc(r.details.feet)} ft from the current pin · ` : ''}<a href="${mapLink(r.details?.lat, r.details?.lng)}" target="_blank" rel="noopener">See the spot on a map</a>${r.details?.accuracy_m ? ` · GPS within ${Math.round(r.details.accuracy_m * 3.28)} ft` : ''}</small>
        ${r.details?.photo && photos[r.details.photo] ? `<img class="jobphoto" src="${esc(photos[r.details.photo])}" alt="Photo of the spot">` : ''}
        ${r.details?.pin_id ? '<label class="check"><input type="checkbox" data-newpin> Add as another pin instead of moving the old one</label>' : ''}`
      : r.kind === 'preset_suggestion' ? `<small>${esc(money2(r.details?.default_cost))} · ${esc(CATS.find((c) => c[0] === r.details?.category)?.[1] || '')}${r.details?.note ? ' · ' + esc(r.details.note) : ''}</small>`
      : r.kind === 'timesheet' ? `<small>${flagBadges(r.details?.flags)}${r.details?.break_min ? ' · break ' + r.details.break_min + 'm' : ''}</small>
        ${r.details?.added_by ? `<p><small>Note from ${esc(C.userName(r.details.added_by))}: ${esc(r.details.note || 'none')}</small></p>${can('timeclock', 3) && r.status === 'pending' ? '<button type="button" class="btn ghost small" data-tfix>Fix the hours</button>' : ''}` : ''}`
      : r.kind === 'job_done' && r.jobs ? `<small>${esc(jobWhen(r.jobs))}${can('reports', 1) && r.jobs.price != null ? ' · ' + esc(money2(r.jobs.price)) : ''}</small>` : '';
    return `<div class="card rv" data-rv="${r.id}"><div class="toolbar"><b style="flex:1">${esc(rkOne(r.kind))}: ${esc(r.summary || '')}</b><small>${esc(fmtDT(r.created_at))}</small></div>
      <small>${esc([C.userName(r.worker_id), r.companies?.name, r.jobs ? `#${r.jobs.number} ${r.jobs.title}` : ''].filter(Boolean).join(' · '))}</small> ${C.divChips(r.divisions)}
      ${extra}
      ${r.status !== 'pending' ? `<p><span class="badge ${r.status === 'returned' ? 'due' : 'ok'}">${esc({ approved: 'Approved', returned: 'Sent back', auto: 'Auto-approved', dismissed: 'Dismissed' }[r.status])}</span>
        ${r.decided_by ? esc(C.userName(r.decided_by)) : ''} ${esc(fmtDT(r.decided_at))}${r.decision_note ? ' · ' + esc(r.decision_note) : ''}</p>` : ''}
      <div class="actions" style="flex-wrap:wrap">
        ${decide && !own && ['pending', 'auto'].includes(r.status) ? `<button class="btn small" data-d="approve">${r.status === 'auto' ? 'Confirm' : 'Approve'}</button>${['job_done', 'timesheet'].includes(r.kind) ? '<button class="btn secondary small" data-d="return">Send back</button>' : ''}<button class="btn ghost small" data-d="dismiss">Dismiss</button>` : ''}
        ${own && r.status === 'pending' ? '<small class="hint">Your own work needs someone else to approve it.</small>' : ''}
        ${r.job_id ? `<button class="btn ghost small" data-jopen="${r.job_id}">Open ${esc(l('job'))}</button>` : ''}
        ${r.status === 'pending' && r.company_id ? '<button class="btn ghost small" data-escal>Escalate</button>' : ''}</div><div data-escbox></div></div>`;
  };
  box.innerHTML = `<h2 class="section">Field work</h2><div id="rvCrew"></div><div id="rvSc"></div>
    <div class="toolbar">${(S.divisions || []).length > 1 ? `<select id="rvDiv" style="max-width:180px"><option value="">Every company</option>${S.divisions.map((d) => `<option value="${d.id}" ${RF.div === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` : ''}
      <select id="rvWho" style="max-width:200px"><option value="">Anyone</option>${workers().map((u) => `<option value="${u.id}" ${RF.who === u.id ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}</select>
      <input type="date" id="rvFrom" value="${esc(RF.from || '')}" style="max-width:160px" aria-label="From"><input type="date" id="rvTo" value="${esc(RF.to || '')}" style="max-width:160px" aria-label="To">
      <label class="check"><input type="checkbox" id="rvDone" ${RF.done || (RF.status && RF.status !== 'pending') ? 'checked' : ''}> Show done</label></div>
    ${!decide && can('review', 3) ? '<div class="banner warn"><b>Two-step sign in needed</b><span>Your account requires it to approve. Set it up from the gear menu.</span></div>' : ''}
    ${(data || []).map(item).join('') || `<p class="empty">${st === 'pending' ? 'Nothing waiting.' : 'Nothing here.'}</p>`}`;
  shortcutsBar($('#rvSc', box), 'review', REVIEW_DEFAULTS(), RF, apply, scCounts);
  crewFlagsBox($('#rvCrew', box), { onDone: () => fieldReview(box) }).catch(C.fail);
  if ($('#rvDiv', box)) $('#rvDiv', box).onchange = (e) => apply({ ...RF, div: e.target.value });
  $('#rvWho', box).onchange = (e) => apply({ ...RF, who: e.target.value });
  $('#rvFrom', box).onchange = (e) => apply({ ...RF, from: e.target.value });
  $('#rvTo', box).onchange = (e) => apply({ ...RF, to: e.target.value });
  $('#rvDone', box).onchange = (e) => { const f = { ...RF, done: e.target.checked }; if (!e.target.checked && f.status && f.status !== 'pending') delete f.status; apply(f); };
  $$('[data-rv]', box).forEach((card) => {
    const r = data.find((x) => x.id === card.dataset.rv);
    $$('[data-d]', card).forEach((b) => (b.onclick = async () => {
      const dec = b.dataset.d; let note = null; const extra = {};
      if (dec === 'return') { note = prompt('Why is it going back? The worker sees this.'); if (!note) return; }
      if (r.kind === 'cost_category' && dec === 'approve') { extra.category = $('[data-cat]', card).value; if (!extra.category) return C.toast('Pick a category', { error: true }); extra.save_preset = !!$('[data-savep]', card)?.checked; }
      if (r.kind === 'pin_change') extra.new_pin = !!$('[data-newpin]', card)?.checked;
      const { error: e } = await sb.rpc('work_review_decide', { p_id: r.id, p_decision: dec, p_note: note, p_extra: extra });
      if (e) return C.fail(e); C.toast({ approve: 'Approved', return: 'Sent back', dismiss: 'Dismissed' }[dec]); fieldReview(box); C.refreshCounts();
    }));
    if ($('[data-jopen]', card)) $('[data-jopen]', card).onclick = () => C.go('job', r.job_id);
    if ($('[data-tfix]', card)) $('[data-tfix]', card).onclick = async () => {
      const { data: t, error: e } = await sb.from('time_entries').select('*').eq('id', r.ref_id).maybeSingle();
      if (e || !t) return C.fail(e || { message: 'Time entry not found' }); timeFixDialog(t, () => fieldReview(box));
    };
    if ($('[data-suggest]', card)) $('[data-suggest]', card).onclick = async () => {
      const { error: e } = await sb.rpc('preset_suggest', { p_item: r.summary, p_cost: Number(r.details?.unit_cost) || null, p_category: $('[data-cat]', card).value || null, p_note: 'Suggested from a one-time cost' });
      if (e) return C.fail(e); C.toast('Sent to someone who can save presets');
    };
    if ($('[data-escal]', card)) $('[data-escal]', card).onclick = () => C.escalatePanel($('[data-escbox]', card), { id: r.company_id, name: `${rkName(r.kind)}: ${r.summary || ''}`, notePrefix: `${rkName(r.kind)}${r.jobs ? ` on #${r.jobs.number} ${r.jobs.title}` : ''}` });
  });
}
export async function fieldReviewCount() {
  if (!fieldReviewOn() || !can('review', 3)) return 0;
  const { count } = await sb.from('work_reviews').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  return (count || 0) + await crewFlagCount().catch(() => 0);
}

/* ================= Quick Add: tabs across the top ================= */
export function quickTabs() {
  const t = [{ id: 'contact', label: L('contact') }];
  if (feat('jobs') && can('jobs', 2)) t.push({ id: 'job', label: L('job') });
  return t;
}
export const QJ = { open: false, title: '', start: '', end: '', worker: '', price: '', service: '', scope: '', repeat: false };
export const qjHasContent = () => !!QJ.title.trim();
export function quickJobForm(box, hasOrg) {
  const money = can('jobs', 3) || can('dispatch', 2);
  box.innerHTML = `<div class="card"><h2>${esc(L('job'))}</h2>
    <small class="hint" style="margin:-4px 0 10px">${hasOrg ? `Saves to the ${esc(l('organization'))} on the ${esc(L('contact'))} tab.` : `Pick or create the ${esc(l('organization'))} on the ${esc(L('contact'))} tab; anything filled in on both tabs is linked when you save.`}</small>
    <label class="label" for="qjT">What</label><input id="qjT" maxlength="120" value="${esc(QJ.title)}" placeholder="Garage cleanout, Lot restripe">
    <div class="row dtrow"><div><label class="label" for="qjS">Starts</label><input id="qjS" type="datetime-local" value="${esc(QJ.start)}"></div><div><label class="label" for="qjE">Ends</label><input id="qjE" type="datetime-local" value="${esc(QJ.end)}"></div></div>
    ${money ? `<div class="row"><div><label class="label" for="qjW">${esc(L('worker'))}</label><select id="qjW">${workerOptions(QJ.worker)}</select></div><div><label class="label" for="qjP">Price</label><input id="qjP" type="number" step="0.01" value="${esc(QJ.price)}"></div></div>` : ''}
    <label class="label" for="qjSc">Scope</label><textarea id="qjSc" rows="2">${esc(QJ.scope)}</textarea>
    ${can('jobs', 4) ? `<label class="check"><input type="checkbox" id="qjR" ${QJ.repeat ? 'checked' : ''}> It repeats (set up the schedule after saving)</label>` : ''}</div>`;
  const bind = (id, k, ev = 'oninput') => { const el = $('#' + id, box); if (el) el[ev] = () => { QJ[k] = el.type === 'checkbox' ? el.checked : el.value; }; };
  bind('qjT', 'title'); bind('qjS', 'start', 'onchange'); bind('qjE', 'end', 'onchange'); bind('qjW', 'worker', 'onchange'); bind('qjP', 'price'); bind('qjSc', 'scope'); bind('qjR', 'repeat', 'onchange');
  $('#qjS', box).addEventListener('change', () => { if (!QJ.end && QJ.start) { const e = new Date(QJ.start); e.setHours(e.getHours() + 1); QJ.end = localInput(e.toISOString()); $('#qjE', box).value = QJ.end; } });
}
// save the job part of Quick Add against an organization; returns the job id
export async function saveQuickJob(companyId, divisions) {
  const money = can('jobs', 3) || can('dispatch', 2);
  if (QJ.repeat && can('jobs', 4)) { const seed = { company_id: companyId, divisions, title: QJ.title }; Object.assign(QJ, { title: '', start: '', end: '', worker: '', price: '', scope: '', repeat: false }); scheduleEditor(null, seed); return null; }
  const f = { company_id: companyId, divisions: divisions || [], title: QJ.title.trim(), scheduled_start: fromLocal(QJ.start), scheduled_end: fromLocal(QJ.end), scope: QJ.scope.trim() || null, source: 'quick',
    ...(money ? { assigned_to: QJ.worker || null, price: QJ.price === '' ? null : Number(QJ.price) } : {}) };
  const { data, error } = await sb.from('jobs').insert(f).select('id').single();
  if (error) { C.fail(error); return null; }
  Object.assign(QJ, { title: '', start: '', end: '', worker: '', price: '', scope: '', repeat: false });
  return data.id;
}

/* ================= My Day: today's jobs and the clock ================= */
export async function myDayCards(box) {
  if (!box) return;
  const parts = [];
  if (feat('jobs')) parts.push('<div id="mdCrew"></div>');
  if (feat('timeclock') && can('timeclock', 2)) parts.push('<div id="mdClock"></div>');
  if (feat('jobs')) parts.push(`<div class="card"><h2>My ${esc(l('job', true))} today</h2><div class="list" id="mdJobs"><p class="empty">Loading…</p></div></div>`);
  box.innerHTML = parts.join('');
  if ($('#mdClock', box)) clockCard($('#mdClock', box));
  if ($('#mdCrew', box)) crewFlagsBox($('#mdCrew', box), { mine: true }).catch(C.fail);
  if ($('#mdJobs', box)) {
    const t = C.today();
    const on = await jobsOn(S.me.id);
    let q = sb.from('jobs').select('id,number,title,status,approval,scheduled_start,scheduled_end,assigned_to,flags,price,companies(name)');
    q = on.length ? q.or(`assigned_to.eq.${S.me.id},id.in.(${on.join(',')})`) : q.eq('assigned_to', S.me.id);
    const { data } = await q.is('archived_at', null).gte('scheduled_start', dayStart(t)).lt('scheduled_start', dayEnd(t)).order('scheduled_start');
    const cm = await crewFor((data || []).map((j) => j.id)); (data || []).forEach((j) => (j._crew = cm[j.id]));
    $('#mdJobs', box).innerHTML = (data || []).map(jobItem).join('') || `<p class="empty">No ${esc(l('job', true))} on your list today.</p>`;
    $$('[data-job]', box).forEach((b) => (b.onclick = () => C.go('job', b.dataset.job)));
  }
}

/* ================= dashboard widgets ================= */
// size: how wide it sits on a desktop screen (full, half, third); everyone can change it in Customize. Phones stack them all.
// ok: who can see it (on top of the feature switch in needs)
const marketingOk = () => C.isAdmin() || can('marketing', 1);
export const WIDGETS = [
  { id: 'tiles', name: 'Quick counts', core: true, size: 'full' }, { id: 'closed', name: 'Closed deals', core: true, size: 'half' }, { id: 'pipeline', name: 'Pipeline', core: true, size: 'full' },
  { id: 'my_todos', name: 'My to-dos', core: true, size: 'half' }, { id: 'new_leads', name: 'New this week', core: true, size: 'third' },
  { id: 'escalations', name: 'Escalated to me', core: true, size: 'third' },
  { id: 'inv_open', name: 'Open invoices', ok: () => can('invoices', 1), size: 'third' }, { id: 'inv_overdue', name: 'Overdue invoices', ok: () => can('invoices', 1), size: 'half' },
  { id: 'inv_paid', name: 'Paid this month', ok: () => can('invoices', 1), money: true, size: 'third' },
  { id: 'bids_due', name: 'Bids due soon', needs: 'bids', ok: () => can('bids', 1), size: 'half' },
  { id: 'esign_waiting', name: 'Waiting for signature', needs: 'esign', ok: () => can('esign', 1), size: 'third' },
  { id: 'appts_today', name: "Today's appointments", needs: 'calendars', ok: () => can('calendars', 1), size: 'half' },
  { id: 'social_next', name: 'Next social posts', needs: 'social', ok: marketingOk, size: 'half' },
  { id: 'jobs_today', name: "Today's " + 'jobs', needs: 'jobs', size: 'half' }, { id: 'revenue_month', name: 'Revenue this month', needs: 'jobs', money: true, size: 'half' },
  { id: 'margin_division', name: 'Gross margin by company', needs: 'jobs', money: true, size: 'full' }, { id: 'unbilled', name: 'Finished, not billed', needs: 'jobs', size: 'third' },
  { id: 'review_waiting', name: 'Waiting in Review', needs: 'jobs', size: 'half' },
  { id: 'clocked_in', name: 'On the clock now', needs: 'timeclock', ok: () => can('timeclock', 3), size: 'third' },
  { id: 'phone_in', name: 'Phone: calls in', needs: 'phone', size: 'third' }, { id: 'phone_out', name: 'Phone: calls out', needs: 'phone', size: 'third' },
  { id: 'phone_minutes', name: 'Phone: minutes', needs: 'phone', size: 'third' },
  { id: 'crm_clients', name: 'CRM clients', ok: () => !!(S.acct?.is_agency && S.acct?.platform_admin), size: 'half' },
];
export const SIZES = [['full', 'Full width'], ['half', 'Half'], ['third', 'Third']];
export function dashSizes() {
  const mine = C.recall('dashSizes_' + S.acct.id, { v: null }).v || {}, acct = S.acctSettings?.dashboard?.sizes || {};
  return Object.fromEntries(WIDGETS.map((w) => [w.id, mine[w.id] || acct[w.id] || w.size || 'full']));
}
const LAYOUTS = { clinic: ['tiles', 'my_todos', 'closed', 'inv_open', 'inv_overdue', 'pipeline'], home_service: ['jobs_today', 'revenue_month', 'inv_open', 'inv_overdue', 'unbilled', 'margin_division', 'review_waiting'] };
const widgetOk = (w) => (!w.needs || feat(w.needs)) && (!w.money || can('reports', 1)) && (!w.ok || w.ok());
export function dashLayout() {
  const mine = C.recall('dashLayout_' + S.acct.id, { v: null }).v;
  const acct = S.acctSettings?.dashboard?.layout;
  const preset = feat('jobs') && (S.acctSettings?.label_preset === 'home_service' || S.acctSettings?.label_preset === 'field_crew') ? LAYOUTS.home_service : LAYOUTS.clinic;
  return (mine || acct || preset).filter((id) => { const w = WIDGETS.find((x) => x.id === id); return w && widgetOk(w); });
}
let phoneUse = null;   // one usage call per dashboard draw, shared by the phone widgets
export async function widgetHtml(id) {
  const t = C.today(), m0 = new Date(); m0.setDate(1); const ms = isoDay(m0);
  if (id.startsWith('phone_')) {
    if (!phoneUse || Date.now() - phoneUse.at > 5000) phoneUse = { at: Date.now(), p: sb.rpc('phone_usage', { p_month: null }).then((r) => r.data, () => null) };
    const u = await phoneUse.p; if (!u) return '';
    const co = u.company, me = u.me || {};
    const key = { phone_in: 'calls_in', phone_out: 'calls_out', phone_minutes: 'minutes' }[id];
    const name = { phone_in: 'Calls in', phone_out: 'Calls out', phone_minutes: 'Minutes' }[id];
    const pct = co?.limit ? Math.round(100 * co.minutes / co.limit) : 0, tone = pct >= 100 ? 'red' : pct >= 90 ? 'orange' : pct >= 75 ? 'yellow' : 'green';
    return `<div class="card"><h2>${name} this month</h2><div class="dtiles">
      <button class="dtile" data-nav="phoneusage"><b>${Number(me[key] || 0).toLocaleString()}</b><span>Yours</span></button>
      ${co ? `<button class="dtile ${id === 'phone_minutes' ? 'ph-' + tone : ''}" data-nav="phoneusage"><b>${Number(co[key] || 0).toLocaleString()}</b><span>${id === 'phone_minutes' ? `Company · ${pct}% of ${Number(co.limit).toLocaleString()}` : 'Company'}</span></button>` : ''}</div></div>`;
  }
  if (id === 'jobs_today') {
    const { data } = await C.divQ(sb.from('jobs').select('id,status,assigned_to')).is('archived_at', null).gte('scheduled_start', dayStart(t)).lt('scheduled_start', dayEnd(t));
    const done = (data || []).filter((j) => ['completed', 'left'].includes(j.status)).length, open = (data || []).filter((j) => !j.assigned_to).length;
    return `<div class="card"><h2>Today's ${esc(l('job', true))}</h2><div class="dtiles"><button class="dtile" data-nav="jobs"><b>${(data || []).length}</b><span>Scheduled</span></button>
      <button class="dtile" data-nav="jobs"><b>${done}</b><span>Done</span></button><button class="dtile ${open ? 'hot' : ''}" data-nav="${feat('dispatch') ? 'dispatch' : 'jobs'}"><b>${open}</b><span>Unassigned</span></button></div></div>`;
  }
  if (id === 'revenue_month' || id === 'margin_division') {
    const { data, error } = await sb.rpc('job_profit', { p_from: ms, p_to: t });
    if (error) return '';
    const rows = data || [], rev = rows.reduce((a, r) => a + Number(r.revenue), 0), cost = rows.reduce((a, r) => a + Number(r.labor) + Number(r.other_costs), 0);
    if (id === 'revenue_month') return `<div class="card"><h2>Revenue this month</h2><div class="dtiles"><div class="dtile"><b>${esc(C.money(rev))}</b><span>Approved ${esc(l('job', true))}</span></div>
      <div class="dtile"><b>${esc(C.money(rev - cost))}</b><span>Gross profit</span></div><div class="dtile"><b>${rev ? Math.round((rev - cost) / rev * 100) : 0}%</b><span>Gross margin</span></div></div>
      <small class="hint">Revenue less labor and other costs on those ${esc(l('job', true))}. Overhead isn't in it, so this is gross, not net.</small></div>`;
    const by = {}; rows.forEach((r) => { const k = r.division_id || ''; const b = (by[k] ||= { rev: 0, lab: 0, oc: 0, n: 0 }); b.rev += Number(r.revenue); b.lab += Number(r.labor); b.oc += Number(r.other_costs); b.n++; });
    return `<div class="card"><h2>Gross margin by ${esc(l('division'))}</h2><div class="tw"><table class="ptable"><thead><tr><th></th><th>${esc(L('job', true))}</th><th>Revenue</th><th>Labor</th><th>Other costs</th><th>Margin</th></tr></thead><tbody>
      ${Object.entries(by).map(([k, b]) => `<tr><td>${esc(C.divName(k) || 'Shared')}</td><td>${b.n}</td><td>${esc(C.money(b.rev))}</td><td>${esc(C.money(b.lab))}</td><td>${esc(C.money(b.oc))}</td><td>${b.rev ? Math.round((b.rev - b.lab - b.oc) / b.rev * 100) + '%' : ''}</td></tr>`).join('') || `<tr><td colspan="6" class="empty">No approved ${esc(l('job', true))} this month yet.</td></tr>`}</tbody></table></div></div>`;
  }
  const card = (title, body, nav) => `<div class="card dwcard"><div class="toolbar"><h2 style="margin:0;flex:1">${esc(title)}</h2>${nav ? `<button type="button" class="linkish small" data-nav="${nav}">Open</button>` : ''}</div>${body}</div>`;
  const ago = (d) => { const n = Math.round((new Date(t + 'T12:00:00') - new Date(String(d).slice(0, 10) + 'T12:00:00')) / 86400000); return n <= 0 ? 'today' : n === 1 ? '1 day' : n + ' days'; };
  const custName = (x) => x.companies?.name || x.bill_to?.name || 'Customer';
  if (id === 'inv_open' || id === 'inv_overdue') {
    const { data, error } = await sb.from('invoices').select('id,number,due_date,balance,status,bill_to,companies(name)').in('status', ['sent', 'partial']).gt('balance', 0).is('voided_at', null).order('due_date').limit(1000);
    if (error) return '';
    const rows = data || [], late = rows.filter((x) => x.due_date && x.due_date < t), sum = (a) => a.reduce((n, x) => n + Number(x.balance || 0), 0);
    if (id === 'inv_open') return card('Open invoices', `<div class="dtiles"><button class="dtile" data-nav="invoices"><b>${rows.length}</b><span>${esc(C.money(sum(rows)))} owed</span></button>
      <button class="dtile ${late.length ? 'hot' : ''}" data-nav="invoices"><b>${late.length}</b><span>${esc(C.money(sum(late)))} past due</span></button></div>`);
    return card('Overdue invoices', late.length ? `<div class="list">${late.slice(0, 6).map((x) => `<button type="button" class="item" data-inv="${x.id}"><b>${esc(custName(x))}</b>
        <small>#${esc(String(x.number || ''))} · ${esc(C.money(x.balance))} · ${esc(ago(x.due_date))} late</small></button>`).join('')}</div>${late.length > 6 ? `<small class="hint">And ${late.length - 6} more</small>` : ''}`
      : '<p class="empty">Nothing past due.</p>', 'invoices');
  }
  if (id === 'inv_paid') {
    const { data, error } = await sb.from('invoice_payments').select('amount').eq('status', 'posted').gte('paid_on', ms).limit(5000);
    if (error) return '';
    const n = (data || []).reduce((a, x) => a + Number(x.amount || 0), 0);
    return card('Paid this month', `<div class="dtiles"><button class="dtile" data-nav="invoices"><b>${esc(C.money(n))}</b><span>${(data || []).length} payment${(data || []).length === 1 ? '' : 's'}</span></button></div>`);
  }
  if (id === 'my_todos') {
    const { data } = await sb.from('tasks').select('id,title,due_date,companies(name)').eq('done', false).eq('assigned_to', S.me.id).lte('due_date', t).order('due_date').limit(50);
    const rows = data || [];
    return card('My to-dos', rows.length ? `<div class="list">${rows.slice(0, 6).map((x) => `<button type="button" class="item" data-nav="myday"><b>${esc(x.title || 'To-do')}</b>
        <small>${x.companies?.name ? esc(x.companies.name) + ' · ' : ''}${x.due_date < t ? `<span class="due">${esc(ago(x.due_date))} overdue</span>` : 'Due today'}</small></button>`).join('')}</div>${rows.length > 6 ? `<small class="hint">And ${rows.length - 6} more</small>` : ''}`
      : '<p class="empty">Nothing due. Nice.</p>', 'myday');
  }
  if (id === 'new_leads') {
    const wk = new Date(); wk.setDate(wk.getDate() - 7);
    const [{ count: orgs }, { count: ppl }] = await Promise.all([
      sb.from('companies').select('id', { count: 'exact', head: true }).is('archived_at', null).gte('created_at', wk.toISOString()),
      sb.from('people').select('id', { count: 'exact', head: true }).is('archived_at', null).gte('created_at', wk.toISOString())]);
    return card('New this week', `<div class="dtiles"><button class="dtile" data-nav="orgs"><b>${orgs || 0}</b><span>${esc(L('organization', true))}</span></button><button class="dtile" data-nav="people"><b>${ppl || 0}</b><span>People</span></button></div>`);
  }
  if (id === 'escalations') {
    const { count } = await sb.from('escalations').select('id', { count: 'exact', head: true }).eq('to_user', S.me.id).eq('status', 'open');
    return card('Escalated to me', `<div class="dtiles"><button class="dtile ${count ? 'hot' : ''}" data-nav="myday"><b>${count || 0}</b><span>Waiting on you</span></button></div>`);
  }
  if (id === 'bids_due') {
    const soon = new Date(); soon.setDate(soon.getDate() + 14);
    const { data, error } = await C.divQ(sb.from('bids').select('id,title,client_name,due_at,status')).is('archived_at', null).in('status', ['new', 'reviewing', 'go', 'bidding']).lte('due_at', soon.toISOString()).order('due_at').limit(20);
    if (error) return '';
    const when = (d) => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return card('Bids due soon', (data || []).length ? `<div class="list">${data.slice(0, 6).map((x) => `<button type="button" class="item" data-go="bid/${x.id}"><b>${esc(x.title || x.client_name || 'Bid')}</b>
        <small>${x.due_at && new Date(x.due_at) < new Date() ? '<span class="due">Past due</span>' : 'Due ' + esc(when(x.due_at))} · ${esc(x.status.replace('_', ' '))}</small></button>`).join('')}</div>` : '<p class="empty">Nothing due in the next two weeks.</p>', 'bids');
  }
  if (id === 'esign_waiting') {
    const { count, error } = await C.divQ(sb.from('esign_envelopes').select('id', { count: 'exact', head: true })).is('archived_at', null).in('status', ['sent', 'viewed', 'partly_signed']);
    if (error) return '';
    return card('Waiting for signature', `<div class="dtiles"><button class="dtile" data-nav="esign"><b>${count || 0}</b><span>Sent, not signed yet</span></button></div>`);
  }
  if (id === 'appts_today') {
    const { data, error } = await C.divQ(sb.from('appointments').select('id,starts_at,title,name,company_name,status')).gte('starts_at', dayStart(t)).lt('starts_at', dayEnd(t)).not('status', 'in', '(cancelled,rescheduled)').order('starts_at').limit(30);
    if (error) return '';
    const hm = (d) => new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return card("Today's appointments", (data || []).length ? `<div class="list">${data.slice(0, 6).map((x) => `<button type="button" class="item" data-nav="calendar"><b>${esc(hm(x.starts_at))} · ${esc(x.name || x.company_name || x.title || 'Appointment')}</b>
        <small>${esc(x.title || '')}${x.status === 'no_show' ? ' · No show' : ''}</small></button>`).join('')}</div>` : '<p class="empty">No appointments today.</p>', 'calendar');
  }
  if (id === 'social_next') {
    const { data, error } = await sb.from('social_posts').select('id,body,scheduled_at,status').is('deleted_at', null).in('status', ['scheduled', 'pending']).gte('scheduled_at', new Date().toISOString()).order('scheduled_at').limit(5);
    if (error) return '';
    const when = (d) => new Date(d).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return card('Next social posts', (data || []).length ? `<div class="list">${data.map((x) => `<button type="button" class="item" data-nav="social"><b>${esc(when(x.scheduled_at))}</b>
        <small>${x.status === 'pending' ? '<span class="due">Needs approval</span> · ' : ''}${esc(String(x.body || '').slice(0, 90))}</small></button>`).join('')}</div>` : '<p class="empty">Nothing scheduled.</p>', 'social');
  }
  if (id === 'clocked_in') {
    const { data, error } = await sb.from('time_entries').select('user_id,clock_in').is('clock_out', null).order('clock_in').limit(200);
    if (error) return '';
    const names = [...new Set((data || []).map((x) => C.userName(x.user_id)).filter(Boolean))];
    return card('On the clock now', `<div class="dtiles"><button class="dtile" data-nav="time"><b>${names.length}</b><span>${esc(names.slice(0, 4).map((n) => n.split(' ')[0]).join(', ') || 'Nobody yet')}${names.length > 4 ? ' +' + (names.length - 4) : ''}</span></button></div>`);
  }
  if (id === 'crm_clients') {
    const { data, error } = await sb.rpc('account_plans_list');
    if (error) return '';
    const c = { ok: 0, trial: 0, setup: 0, grace: 0, locked: 0 }; (data || []).forEach((p) => { const st = p.billing?.state || 'ok'; c[st] = (c[st] || 0) + 1; });
    return card('CRM clients', `<div class="dtiles"><button class="dtile" data-nav="accounts"><b>${(data || []).length}</b><span>On a plan</span></button>
      <button class="dtile ${c.setup ? 'hot' : ''}" data-nav="accounts"><b>${c.setup}</b><span>Waiting on first payment</span></button>
      <button class="dtile ${c.grace ? 'hot' : ''}" data-nav="accounts"><b>${c.grace}</b><span>Late</span></button>
      <button class="dtile ${c.locked ? 'hot' : ''}" data-nav="accounts"><b>${c.locked}</b><span>Paused</span></button></div>`, 'accounts');
  }
  if (id === 'unbilled') {
    const { count } = await C.divQ(sb.from('jobs').select('id', { count: 'exact', head: true })).in('approval', ['approved', 'auto']).is('billed_at', null).is('archived_at', null);
    return `<div class="card"><h2>Finished, not billed</h2><div class="dtiles"><button class="dtile ${count ? 'hot' : ''}" data-unbilled><b>${count || 0}</b><span>Approved ${esc(l('job', true))} with no invoice yet</span></button></div></div>`;
  }
  if (id === 'review_waiting') {
    const { data } = await sb.from('work_reviews').select('kind').eq('status', 'pending').limit(5000);
    const c = {}; (data || []).forEach((r) => (c[r.kind] = (c[r.kind] || 0) + 1));
    return `<div class="card"><h2>Waiting in Review</h2><div class="dtiles">${Object.keys(RK).filter((k) => c[k]).map((k) => `<button class="dtile hot" data-rk="${k}"><b>${c[k]}</b><span>${esc(rkName(k))}</span></button>`).join('') || '<p class="empty">Nothing waiting.</p>'}</div></div>`;
  }
  return '';
}
export function bindWidgets(main) {
  $$('[data-inv]', main).forEach((b) => (b.onclick = () => C.go('invoice', b.dataset.inv)));
  $$('[data-go]', main).forEach((b) => (b.onclick = () => { const [v, id] = b.dataset.go.split('/'); C.go(v, id); }));
  $$('[data-unbilled]', main).forEach((b) => (b.onclick = () => { C.store('jobFilters', { unbilled: true }); JF = null; C.go('jobs'); }));
  $$('[data-rk]', main).forEach((b) => (b.onclick = () => { C.store('reviewFilters', { kind: b.dataset.rk }); RF = null; C.go('review'); }));
}
// arranging right on the dashboard (drag and drop, widths, hide): saved just for this person, like Customize
export function saveDash(order, sizes) {
  C.store('dashLayout_' + S.acct.id, { v: order });
  C.store('dashSizes_' + S.acct.id, { v: { ...dashSizes(), ...(sizes || {}) } });
}
export function customizeDash(onDone) {
  const cur = dashLayout(); const all = WIDGETS.filter(widgetOk); const sizes = dashSizes();
  let order = [...cur, ...all.map((w) => w.id).filter((id) => !cur.includes(id))]; const on = new Set(cur);
  const d = dlg('dashDlg', '');
  const paint = () => {
    d.innerHTML = `<div class="vhead"><h2 style="margin:0">Your dashboard</h2><button class="btn ghost small" data-x>Done</button></div>
      <p class="hint">Turn widgets on or off and put them in order. This is just for you.</p>
      ${order.map((id, i) => { const w = all.find((x) => x.id === id); return w ? `<div class="listrow"><label class="check" style="flex:1"><input type="checkbox" data-w="${id}" ${on.has(id) ? 'checked' : ''}> ${esc(w.id === 'jobs_today' ? "Today's " + l('job', true) : w.name)}</label>
        <select data-sz="${id}" aria-label="Width of ${esc(w.name)}" style="width:auto">${SIZES.map(([k, n]) => `<option value="${k}" ${sizes[id] === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <button class="btn ghost small" data-up="${i}" ${i ? '' : 'disabled'} aria-label="Move up">↑</button></div>` : ''; }).join('')}
      <div class="actions"><button class="btn ghost small" data-reset>Back to the default</button>${C.isAdmin() ? '<button class="btn secondary small" data-acct>Make this the default for everyone</button>' : ''}</div>`;
    $('[data-x]', d).onclick = () => { d.close(); onDone(); };
    $$('[data-w]', d).forEach((cb) => (cb.onchange = () => { cb.checked ? on.add(cb.dataset.w) : on.delete(cb.dataset.w); save(); }));
    $$('[data-up]', d).forEach((b) => (b.onclick = () => { const i = +b.dataset.up; [order[i - 1], order[i]] = [order[i], order[i - 1]]; save(); paint(); }));
    $$('[data-sz]', d).forEach((x) => (x.onchange = () => { sizes[x.dataset.sz] = x.value; save(); }));
    $('[data-reset]', d).onclick = () => { C.store('dashLayout_' + S.acct.id, { v: null }); C.store('dashSizes_' + S.acct.id, { v: null }); d.close(); onDone(); };
    if ($('[data-acct]', d)) $('[data-acct]', d).onclick = async () => { if (await saveSettings({ dashboard: { ...(S.acctSettings?.dashboard || {}), layout: order.filter((x) => on.has(x)), sizes } }, 'Default dashboard saved')) { d.close(); onDone(); } };
  };
  const save = () => { C.store('dashLayout_' + S.acct.id, { v: order.filter((x) => on.has(x)) }); C.store('dashSizes_' + S.acct.id, { v: { ...sizes } }); };
  paint();
}
