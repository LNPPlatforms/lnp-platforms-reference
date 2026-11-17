/* calendars.js: booking calendars (GoHighLevel style). Each account sets up calendars (one person, round robin or the
   customer picks who), each person keeps their weekly hours and days off, customers book on a public page (/book/) or an
   embed on their own site, and the team works it all from the Calendar screen (day, week and month), My Day and each
   contact. Database: schema/078*. Plugs into app.js through init(ctx) like bids.js. Outside calendars (Google, Outlook)
   come later: their busy times land in cal_busy and already block bookings. */
import * as FLD from './field.js?v=20261116t';

let C = null, sb, S, esc, $, $$;
export function init(ctx) { C = ctx; ({ sb, S, esc, $, $$ } = ctx); }
const can = (a, l = 1) => FLD.can(a, l);
export const on = () => FLD.feat('calendars');
export const canSee = () => on() && can('calendars', 1);
export const canEdit = () => on() && can('calendars', 2);
export const canOthersHours = () => on() && (C.isAdmin() || can('calendars', 3));
export const canSetup = () => on() && (C.isAdmin() || can('calendars', 4));

const STATUS = [['booked', 'Booked'], ['confirmed', 'Confirmed'], ['rescheduled', 'Rescheduled'], ['completed', 'Completed'], ['no_show', 'No show'], ['cancelled', 'Cancelled']];
const STATUS_NAME = Object.fromEntries(STATUS);
const STATUS_BADGE = { confirmed: 'ok', completed: 'ok', no_show: 'due', cancelled: 'due', rescheduled: 'gold' };
const KINDS = [['one', 'One person'], ['round_robin', 'Round robin (spread across the team)'], ['pick', 'The customer picks who']];
const LOCS = [['phone', 'Phone call (we call them)'], ['video', 'Video call'], ['in_person', 'In person at our place'], ['customer', 'At their address']];
const REMINDERS = [[10080, '1 week'], [2880, '2 days'], [1440, '1 day'], [240, '4 hours'], [120, '2 hours'], [60, '1 hour'], [30, '30 minutes'], [15, '15 minutes']];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TZS = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
const DEFAULT_WEEK = { 1: [['09:00', '17:00']], 2: [['09:00', '17:00']], 3: [['09:00', '17:00']], 4: [['09:00', '17:00']], 5: [['09:00', '17:00']] };
const myTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'; } catch { return 'America/Chicago'; } };
const tzOpts = (cur) => [...new Set([...TZS, myTz(), cur].filter(Boolean))].map((z) => `<option value="${esc(z)}" ${z === cur ? 'selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`).join('');
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOf = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addD = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmtT = (s) => new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDT = (s) => new Date(s).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDay = (d, o = { weekday: 'long', month: 'long', day: 'numeric' }) => d.toLocaleDateString([], o);
const minsBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);
const userName = (id) => C.userName(id) || 'Someone';
const first = (id) => userName(id).split(' ')[0];
const bookUrl = (cal) => `${S.pub()}/book/?a=${encodeURIComponent(S.acct?.slug || '')}&c=${encodeURIComponent(cal.slug)}`;
const embedCode = (cal, popup) => `<script src="${S.pub()}/book/embed.js" data-account="${S.acct?.slug || ''}" data-calendar="${cal.slug}"${popup ? ' data-mode="popup" data-button="Book a time"' : ''} async></script>`;
const copy = async (text, msg = 'Copied') => { try { await navigator.clipboard.writeText(text); C.toast(msg); } catch { prompt('Copy this:', text); } };
const noDb = (main, title) => (main.innerHTML = `<h1>${esc(title)}</h1><p class="empty">This screen needs the calendars database update (078). Once it's applied, it works.</p>`);
const staffOpts = (cur, blank) => (blank ? `<option value="">${esc(blank)}</option>` : '') + C.staff().map((u) => `<option value="${u.id}" ${u.id === cur ? 'selected' : ''}>${esc(u.full_name || u.email)}</option>`).join('');

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
  if (!d.open) d.showModal();
  $$('[data-x]', d).forEach((b) => (b.onclick = () => d.close()));
  return d;
}

let cssOn = false;
function css() {
  if (cssOn) return; cssOn = true;
  const s = document.createElement('style');
  s.textContent = `.calbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}.calbar select{width:auto;min-width:130px;margin:0;min-height:40px}.calbar h2{margin:0 8px 0 0;font-size:18px}
.calgrid{display:grid;border:1px solid var(--line);border-radius:12px;background:var(--card);overflow:auto;position:relative;max-height:72vh}
.calgrid .ch{position:sticky;top:0;z-index:3;background:var(--card);border-bottom:1px solid var(--line);padding:6px 4px;text-align:center;font-size:13px;font-weight:700;min-height:38px}
.calgrid .ch.today{color:#B3261E}.calgrid .ch small{display:block;font-weight:400;color:var(--soft)}
.calgrid .hrs{position:sticky;left:0;z-index:2;background:var(--card);border-right:1px solid var(--line)}
.calgrid .hr{height:60px;font-size:11px;color:var(--soft);text-align:right;padding:2px 6px 0 0;box-sizing:border-box}
.calcol{position:relative;border-left:1px solid var(--line);cursor:copy;background-image:linear-gradient(var(--line) 1px,transparent 1px);background-size:100% 60px}
.calcol.off{background-color:rgba(120,130,150,.06)}
.appt{position:absolute;left:3px;right:3px;border-radius:7px;padding:3px 6px;font-size:12px;line-height:1.25;color:#fff;overflow:hidden;cursor:pointer;border:0;text-align:left;font-family:inherit;box-shadow:0 1px 2px rgba(0,0,0,.15)}
.appt b{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.appt span{display:block;opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.appt.cancelled{opacity:.45;text-decoration:line-through}.appt.short span{display:none}.appt.short{padding-top:1px}.appt.no_show{opacity:.6}
.calmonth{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--card)}
.calmonth .mh{padding:6px;font-size:12px;font-weight:700;text-align:center;border-bottom:1px solid var(--line);color:var(--soft)}
.calmonth .md{min-height:96px;border-top:1px solid var(--line);border-left:1px solid var(--line);padding:4px;cursor:pointer;min-width:0}
.calmonth .md:nth-child(7n+1){border-left:0}.calmonth .md.other{background:rgba(120,130,150,.06);color:var(--soft)}.calmonth .md.today .dn{background:#B3261E;color:#fff;border-radius:999px;padding:0 6px}
.calmonth .dn{font-size:12px;font-weight:700}.mchip{display:block;width:100%;border:0;border-radius:5px;padding:2px 5px;margin-top:3px;font-size:11px;color:#fff;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;font-family:inherit}
.mchip.cancelled{opacity:.45;text-decoration:line-through}.mmore{font-size:11px;color:var(--soft);margin-top:2px}
.caldot{display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:middle;margin-right:6px;flex:none}
.apptrow{display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line);width:100%;background:none;border-left:0;border-right:0;border-top:0;text-align:left;cursor:pointer;font:inherit;color:inherit}
.apptrow .when{min-width:92px;font-weight:700;font-size:14px}.apptrow small{display:block;color:var(--soft)}
.kvx{display:grid;grid-template-columns:110px 1fr;gap:6px 12px;margin:10px 0}.kvx dt{color:var(--soft);font-size:13px}.kvx dd{margin:0}
.hday{display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:start;padding:10px 0;border-bottom:1px solid var(--line)}
.hday .rngs{display:flex;flex-direction:column;gap:6px}.hrng{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.hrng input{width:auto;margin:0;min-height:40px}
.qrow{display:grid;grid-template-columns:2fr 130px 2fr auto auto;gap:6px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)}.qrow input,.qrow select{margin:0}
.peoplepick{display:flex;flex-wrap:wrap;gap:8px}.peoplepick label{display:flex;gap:6px;align-items:center;border:1px solid var(--line);border-radius:999px;padding:6px 12px;background:var(--card);cursor:pointer}
.peoplepick input{width:18px;height:18px;margin:0}.codebox{font-family:ui-monospace,Menlo,monospace;font-size:12px;width:100%;min-height:70px}
.calrow{display:flex;gap:12px;align-items:center}.calrow .grow{flex:1;min-width:0}
@media (max-width:640px){.qrow{grid-template-columns:1fr 1fr}.qrow .qo{grid-column:1/-1}.hday{grid-template-columns:1fr}.kvx{grid-template-columns:90px 1fr}.calmonth .md{min-height:64px}.mchip{font-size:10px}}`;
  document.head.appendChild(s);
}

/* ================= navigation pieces ================= */
export const drawerItems = () => ({
  calendars: [
    { id: 'calendar', label: 'Calendar', match: ['calendar'], what: 'Everyone\'s appointments by day, week or month', when: () => canSee() },
    { id: 'calsetup', label: 'Booking calendars', match: ['calsetup', 'calset'], what: 'Booking pages, who takes them, lengths, questions, reminders, links and embed code', when: () => canSetup() },
    { id: 'calhours', label: 'Hours and days off', match: ['calhours'], what: 'When people can be booked, plus days off and one-off hours', when: () => canEdit() },
  ],
});
export const views = () => ({ calendar: viewCalendar, calsetup: viewSetup, calset: viewEditor, calhours: viewHours });
export const parents = { calendar: 'tools', calsetup: 'tools', calset: 'calsetup', calhours: 'tools' };
export const guards = { calendar: () => canSee(), calsetup: () => canSetup(), calset: () => canSetup(), calhours: () => canEdit() };
export const screens = () => [
  ...(canSee() ? [['calendar', 'Calendar', 'appointments bookings schedule meetings day week month']] : []),
  ...(canSetup() ? [['calsetup', 'Booking calendars', 'booking page link embed round robin reminders questions calendars setup']] : []),
  ...(canEdit() ? [['calhours', 'Hours and days off', 'availability working hours days off vacation time off']] : []),
];

let CALS = null;
async function loadCals(force) {
  if (CALS && !force) return CALS;
  const { data, error } = await sb.from('calendars').select('*').is('archived_at', null).order('name');
  if (error) return null;
  CALS = data || [];
  return CALS;
}
const calOf = (id) => (CALS || []).find((c) => c.id === id);
const colorOf = (a) => calOf(a.calendar_id)?.color || '#5B6B8A';

/* ================= the Calendar screen ================= */
const VIEW = { mode: null, who: '', cal: '', cancelled: false };
const loadPrefs = () => { try { Object.assign(VIEW, JSON.parse(localStorage.getItem('calView') || '{}')); } catch {} if (!VIEW.mode) VIEW.mode = matchMedia('(min-width: 820px)').matches ? 'week' : 'day'; };
const savePrefs = () => { try { localStorage.setItem('calView', JSON.stringify(VIEW)); } catch {} };

function rangeFor(mode, day) {
  if (mode === 'day') return [day, addD(day, 1)];
  if (mode === 'week') { const s = addD(day, -day.getDay()); return [s, addD(s, 7)]; }
  const s = new Date(day.getFullYear(), day.getMonth(), 1); const gs = addD(s, -s.getDay());
  const e = new Date(day.getFullYear(), day.getMonth() + 1, 1); const ge = addD(e, (7 - e.getDay()) % 7);
  return [gs, ge];
}

async function viewCalendar(main) {
  css(); loadPrefs();
  const day = S.param && /^\d{4}-\d{2}-\d{2}$/.test(S.param) ? dayOf(S.param) : dayOf(isoDay(new Date()));
  const cals = await loadCals(true);
  if (!cals) return noDb(main, 'Calendar');
  const [from, to] = rangeFor(VIEW.mode, day);
  let q = sb.from('appointments').select('*').gte('starts_at', from.toISOString()).lt('starts_at', to.toISOString()).order('starts_at').limit(2000);
  if (VIEW.who) q = q.eq('user_id', VIEW.who);
  if (VIEW.cal) q = q.eq('calendar_id', VIEW.cal);
  if (!VIEW.cancelled) q = q.neq('status', 'cancelled');
  const { data, error } = await q;
  if (error) return noDb(main, 'Calendar');
  const appts = data || [];
  const title = VIEW.mode === 'day' ? fmtDay(day) : VIEW.mode === 'week' ? `${fmtDay(from, { month: 'short', day: 'numeric' })} to ${fmtDay(addD(to, -1), { month: 'short', day: 'numeric', year: 'numeric' })}`
    : fmtDay(day, { month: 'long', year: 'numeric' });
  const people = C.staff().filter((u) => !VIEW.who || u.id === VIEW.who);
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Calendar</h1>
      ${canSetup() ? '<button class="btn ghost small" data-nav="calsetup">Booking calendars</button>' : ''}${canEdit() ? '<button class="btn ghost small" data-nav="calhours">Hours</button><button class="btn small" id="caAdd">Add an appointment</button>' : ''}</div>
    <div class="calbar"><button class="btn secondary small" id="caPrev" aria-label="Back">‹</button><button class="btn secondary small" id="caToday">Today</button><button class="btn secondary small" id="caNext" aria-label="Forward">›</button>
      <h2 id="caTitle">${esc(title)}</h2>
      <div class="seg" role="group" aria-label="View">${[['day', 'Day'], ['week', 'Week'], ['month', 'Month']].map(([k, n]) => `<button type="button" class="${VIEW.mode === k ? 'on' : ''}" data-mode="${k}">${n}</button>`).join('')}</div>
      <select id="caWho" aria-label="Person">${staffOpts(VIEW.who, 'Everyone')}</select>
      <select id="caCal" aria-label="Calendar"><option value="">All calendars</option>${cals.map((c) => `<option value="${c.id}" ${VIEW.cal === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <label class="check" style="min-height:0"><input type="checkbox" id="caCx" ${VIEW.cancelled ? 'checked' : ''}> Cancelled</label></div>
    <div id="caBody"></div>
    ${!cals.length && canSetup() ? '<p class="hint">No booking calendars yet. <button class="linkish" data-nav="calsetup">Set one up</button> to get a booking page. You can still add appointments by hand.</p>' : ''}`;
  const body = $('#caBody', main);
  if (VIEW.mode === 'month') drawMonth(body, day, from, to, appts);
  else drawGrid(body, VIEW.mode === 'day' ? (people.length > 1 && people.length <= 12 ? people.map((u) => ({ day, user: u })) : [{ day }]) : [...Array(7)].map((_, i) => ({ day: addD(from, i) })), appts);
  const nav = (n) => { const d = VIEW.mode === 'day' ? addD(day, n) : VIEW.mode === 'week' ? addD(day, 7 * n) : new Date(day.getFullYear(), day.getMonth() + n, 1); C.go('calendar', isoDay(d)); };
  $('#caPrev').onclick = () => nav(-1); $('#caNext').onclick = () => nav(1); $('#caToday').onclick = () => C.go('calendar', isoDay(new Date()));
  $$('[data-mode]', main).forEach((b) => (b.onclick = () => { VIEW.mode = b.dataset.mode; savePrefs(); viewCalendar(main); }));
  $('#caWho').onchange = (e) => { VIEW.who = e.target.value; savePrefs(); viewCalendar(main); };
  $('#caCal').onchange = (e) => { VIEW.cal = e.target.value; savePrefs(); viewCalendar(main); };
  $('#caCx').onchange = (e) => { VIEW.cancelled = e.target.checked; savePrefs(); viewCalendar(main); };
  $$('[data-nav]', main).forEach((b) => (b.onclick = () => C.go(b.dataset.nav)));
  if ($('#caAdd')) $('#caAdd').onclick = () => addAppt({ start: nextHalfHour(day), user: VIEW.who || null, cal: VIEW.cal || null, after: () => viewCalendar(main) });
  body.onclick = (e) => {
    const a = e.target.closest('[data-appt]');
    if (a) { e.stopPropagation(); return openAppt(a.dataset.appt, () => viewCalendar(main)); }
    const md = e.target.closest('[data-mday]');
    if (md) { VIEW.mode = 'day'; savePrefs(); return C.go('calendar', md.dataset.mday); }
    const col = e.target.closest('[data-col]');
    if (col && canEdit()) {
      const r = col.getBoundingClientRect(), y = e.clientY - r.top, base = Number(col.dataset.h0);
      const minutes = Math.max(0, Math.floor((y / 60) * 2) * 30);
      const st = dayOf(col.dataset.col); st.setHours(base, 0, 0, 0); st.setMinutes(st.getMinutes() + minutes);
      addAppt({ start: st, user: col.dataset.user || VIEW.who || null, cal: VIEW.cal || null, after: () => viewCalendar(main) });
    }
  };
}
function nextHalfHour(day) {
  const n = new Date(); const d = new Date(day); d.setHours(n.getHours(), n.getMinutes() < 30 ? 30 : 60, 0, 0);
  if (isoDay(day) !== isoDay(n)) d.setHours(9, 0, 0, 0);
  return d;
}

function drawGrid(body, cols, appts) {
  let h0 = 7, h1 = 19;
  appts.forEach((a) => { const s = new Date(a.starts_at), e = new Date(a.ends_at); h0 = Math.min(h0, s.getHours()); h1 = Math.max(h1, e.getHours() + (e.getMinutes() ? 1 : 0)); });
  h1 = Math.min(Math.max(h1, h0 + 1), 24);
  const today = isoDay(new Date());
  const inCol = (c) => appts.filter((a) => isoDay(new Date(a.starts_at)) === isoDay(c.day) && (!c.user || a.user_id === c.user.id));
  const place = (list) => {
    // side by side when they overlap
    const out = []; const sorted = list.slice().sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    let group = [], end = 0;
    const flush = () => { const lanes = []; group.forEach((a) => { let i = lanes.findIndex((t) => t <= new Date(a.starts_at)); if (i < 0) { i = lanes.length; lanes.push(0); } lanes[i] = new Date(a.ends_at); out.push({ a, lane: i }); }); out.filter((x) => group.includes(x.a)).forEach((x) => (x.lanes = lanes.length)); group = []; };
    sorted.forEach((a) => { if (group.length && new Date(a.starts_at) >= end) flush(); group.push(a); end = Math.max(end, new Date(a.ends_at)); });
    if (group.length) flush();
    return out;
  };
  const colHtml = (c) => place(inCol(c)).map(({ a, lane, lanes }) => {
    const s = new Date(a.starts_at); const top = (s.getHours() - h0) * 60 + s.getMinutes(); const ht = Math.max(minsBetween(a.starts_at, a.ends_at), 20);
    const w = 100 / lanes;
    return `<button type="button" class="appt ${esc(a.status)} ${ht < 40 ? 'short' : ''}" data-appt="${a.id}" style="top:${top}px;height:${ht}px;background:${esc(colorOf(a))};left:calc(${w * lane}% + 2px);width:calc(${w}% - 4px);right:auto"
      title="${esc(`${fmtT(a.starts_at)} ${a.name || a.title || ''}`)}"><b>${esc(fmtT(a.starts_at))} ${esc(a.name || a.title || 'Appointment')}</b><span>${esc([calOf(a.calendar_id)?.name, cols.some((x) => x.user) ? '' : first(a.user_id)].filter(Boolean).join(' · '))}</span></button>`;
  }).join('');
  const minW = cols.length > 3 ? 110 : 160;
  body.innerHTML = `<div class="calgrid" style="grid-template-columns:52px repeat(${cols.length},minmax(${minW}px,1fr))">
    <div class="ch hrs"></div>${cols.map((c) => `<div class="ch ${isoDay(c.day) === today && !c.user ? 'today' : ''}">${c.user ? esc(c.user.full_name || c.user.email) : esc(fmtDay(c.day, { weekday: 'short' }))}<small>${c.user ? '' : esc(fmtDay(c.day, { month: 'short', day: 'numeric' }))}</small></div>`).join('')}
    <div class="hrs">${[...Array(h1 - h0)].map((_, i) => { const d = new Date(); d.setHours(h0 + i, 0, 0, 0); return `<div class="hr">${esc(d.toLocaleTimeString([], { hour: 'numeric' }))}</div>`; }).join('')}</div>
    ${cols.map((c) => `<div class="calcol" data-col="${isoDay(c.day)}" data-h0="${h0}" ${c.user ? `data-user="${c.user.id}"` : ''} style="height:${(h1 - h0) * 60}px">${colHtml(c)}</div>`).join('')}</div>
    ${appts.length ? '' : '<p class="hint">Nothing booked here. Click a time to add one.</p>'}`;
}

function drawMonth(body, day, from, to, appts) {
  const today = isoDay(new Date()); const cells = [];
  for (let d = new Date(from); d < to; d = addD(d, 1)) cells.push(new Date(d));
  body.innerHTML = `<div class="calmonth">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n) => `<div class="mh">${n}</div>`).join('')}
    ${cells.map((d) => { const k = isoDay(d); const list = appts.filter((a) => isoDay(new Date(a.starts_at)) === k);
      return `<div class="md ${d.getMonth() !== day.getMonth() ? 'other' : ''} ${k === today ? 'today' : ''}" data-mday="${k}"><span class="dn">${d.getDate()}</span>
        ${list.slice(0, 3).map((a) => `<button type="button" class="mchip ${esc(a.status)}" data-appt="${a.id}" style="background:${esc(colorOf(a))}">${esc(fmtT(a.starts_at))} ${esc(a.name || a.title || '')}</button>`).join('')}
        ${list.length > 3 ? `<div class="mmore">+${list.length - 3} more</div>` : ''}</div>`; }).join('')}</div>`;
}

/* ================= one appointment ================= */
export async function openAppt(id, after) {
  css();
  await loadCals();
  const [{ data: a, error }, { data: mail }] = await Promise.all([sb.from('appointments').select('*').eq('id', id).maybeSingle(), sb.rpc('appointment_mail', { p_id: id })]);
  if (error || !a) return C.toast('That appointment isn\'t there anymore', { error: true });
  const cal = calOf(a.calendar_id);
  const edit = canEdit() && (C.isAdmin() || FLD.scopeOf('calendars') !== 'own' || a.user_id === S.me?.id);
  const d = dlg('apptDlg', `<div class="vhead"><h2 style="margin:0"><span class="caldot" style="background:${esc(colorOf(a))}"></span>${esc(a.title || cal?.name || 'Appointment')}</h2><button class="btn ghost small" data-x>Close</button></div>
    <p style="margin:6px 0"><span class="badge ${STATUS_BADGE[a.status] || ''}">${esc(STATUS_NAME[a.status] || a.status)}</span> ${a.source === 'booking' ? '<span class="badge">Booked online</span>' : ''}</p>
    <dl class="kvx"><dt>When</dt><dd>${esc(fmtDT(a.starts_at))} to ${esc(fmtT(a.ends_at))} (${minsBetween(a.starts_at, a.ends_at)} min)</dd>
      <dt>With</dt><dd>${esc(userName(a.user_id))}</dd>
      <dt>Who</dt><dd>${esc([a.name, a.company_name].filter(Boolean).join(', ') || '-')}${a.person_id || a.company_id ? ` <button class="linkish" id="apOpen">Open</button>` : ''}</dd>
      ${a.email ? `<dt>Email</dt><dd><a href="mailto:${esc(a.email)}">${esc(a.email)}</a></dd>` : ''}${a.phone ? `<dt>Phone</dt><dd><a href="tel:${esc(a.phone)}">${esc(a.phone)}</a></dd>` : ''}
      ${a.location ? `<dt>Where</dt><dd>${esc(a.location)}</dd>` : ''}
      ${(a.answers || []).map((x) => `<dt>${esc(x.label)}</dt><dd style="white-space:pre-wrap">${esc(x.value)}</dd>`).join('')}
      ${a.notes ? `<dt>Notes</dt><dd style="white-space:pre-wrap">${esc(a.notes)}</dd>` : ''}
      ${a.visitor_tz ? `<dt>Their time zone</dt><dd>${esc(a.visitor_tz.replace(/_/g, ' '))}</dd>` : ''}
      ${a.cancel_reason ? `<dt>Why cancelled</dt><dd>${esc(a.cancel_reason)}</dd>` : ''}</dl>
    ${edit ? `<div class="actions">${a.status !== 'cancelled' ? `${a.status !== 'confirmed' ? '<button class="btn small" data-st="confirmed">Confirmed</button>' : ''}
        <button class="btn small secondary" data-st="completed">Completed</button><button class="btn small secondary" data-st="no_show">No show</button>
        <button class="btn small secondary" id="apMove">Reschedule</button><button class="btn small ghost danger" id="apCancel">Cancel it</button>`
      : '<button class="btn small secondary" data-st="booked">Bring it back</button>'}</div>
      <div id="apMoveBox" hidden class="card" style="margin-top:12px"><div class="row"><div><label class="label" for="apD">Day and time</label><input type="datetime-local" id="apD" value="${esc(localInput(a.starts_at))}"></div>
        <div><label class="label" for="apL">Length (minutes)</label><input type="number" id="apL" min="5" step="5" value="${minsBetween(a.starts_at, a.ends_at)}"></div></div>
        <label class="label" for="apU">With</label><select id="apU">${staffOpts(a.user_id)}</select>
        <label class="check"><input type="checkbox" id="apN" checked> Email ${esc(a.name || 'them')} about the change</label>
        <div class="actions"><button class="btn small" id="apMoveGo">Move it</button></div></div>` : ''}
    ${(a.history || []).length ? `<h3>History</h3><ul class="bhist" style="font-size:13px;color:var(--soft);padding-left:18px;margin:0">${a.history.map((h) => `<li>${esc(new Date(h.at).toLocaleString())}: ${esc(h.what)}${h.by ? ' by ' + esc(h.by) : ''}${h.to ? ' to ' + esc(fmtDT(h.to)) : ''}</li>`).join('')}</ul>` : ''}
    ${(mail || []).length ? `<h3>Emails</h3><ul style="font-size:13px;color:var(--soft);padding-left:18px;margin:0">${mail.map((m) => `<li>${esc({ confirm: 'Confirmation', notice: 'Team notice', cancel: 'Cancelled', cancel_notice: 'Team: cancelled', reschedule: 'Moved', reschedule_notice: 'Team: moved', reminder: 'Reminder' }[m.kind] || m.kind)} to ${esc(m.to)}: ${esc(m.status)}${m.error ? ' (' + esc(m.error) + ')' : ''}</li>`).join('')}</ul>` : ''}`);
  const done = () => { d.close(); if (after) after(); };
  if ($('#apOpen', d)) $('#apOpen', d).onclick = () => { d.close(); a.person_id ? C.go('people', a.person_id) : C.go('org', a.company_id); };
  $$('[data-st]', d).forEach((b) => (b.onclick = async () => {
    const { error: e } = await sb.rpc('appointment_status', { p_id: a.id, p_status: b.dataset.st, p_reason: null, p_notify: true });
    if (e) return C.fail(e); C.toast('Saved'); done();
  }));
  if ($('#apCancel', d)) $('#apCancel', d).onclick = async () => {
    const why = prompt('Cancel this appointment? They get an email. Add a reason if you like (optional):', '');
    if (why === null) return;
    const { error: e } = await sb.rpc('appointment_status', { p_id: a.id, p_status: 'cancelled', p_reason: why || null, p_notify: true });
    if (e) return C.fail(e); C.toast('Cancelled'); done();
  };
  if ($('#apMove', d)) $('#apMove', d).onclick = () => { $('#apMoveBox', d).hidden = false; $('#apD', d).focus(); };
  if ($('#apMoveGo', d)) $('#apMoveGo', d).onclick = async () => {
    const v = $('#apD', d).value; if (!v) return C.toast('Pick the new time');
    const s = new Date(v), len = Math.max(5, Number($('#apL', d).value) || 30);
    const p = { user_id: $('#apU', d).value, starts_at: s.toISOString(), ends_at: new Date(s.getTime() + len * 60000).toISOString(), notify: $('#apN', d).checked, calendar_id: a.calendar_id };
    if (await saveAppt(a.id, p)) { C.toast('Moved'); done(); }
  };
}
const localInput = (s) => { const d = new Date(s); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

// save, and when the person is already busy then, ask before booking over it
async function saveAppt(id, p) {
  let { data, error } = await sb.rpc('appointment_save', { p_id: id, p });
  if (error && /BUSY:/.test(error.message || '')) {
    if (!confirm(error.message.replace(/^.*BUSY:\s*/, ''))) return null;
    ({ data, error } = await sb.rpc('appointment_save', { p_id: id, p: { ...p, force: true } }));
  }
  if (error) { C.fail(error); return null; }
  return data || id || true;
}

/* ================= add one by hand ================= */
export async function addAppt({ start = null, user = null, cal = null, person = null, company = null, after = null } = {}) {
  css();
  const cals = (await loadCals()) || [];
  const c0 = cal ? calOf(cal) : null;
  const st = start || nextHalfHour(new Date());
  let picked = person ? { id: person.id, name: person.name, email: person.email } : null;
  const d = dlg('apptNew', `<div class="vhead"><h2 style="margin:0">Add an appointment</h2><button class="btn ghost small" data-x>Close</button></div>
    <label class="label" for="anCal">Calendar</label><select id="anCal"><option value="">No calendar</option>${cals.filter((c) => c.active).map((c) => `<option value="${c.id}" ${c0?.id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <div class="row"><div><label class="label" for="anD">Day and time</label><input type="datetime-local" id="anD" value="${esc(localInput(st))}"></div>
      <div><label class="label" for="anL">Length (minutes)</label><input type="number" id="anL" min="5" step="5" value="${c0?.duration_min || 30}"></div></div>
    <label class="label" for="anU">With</label><select id="anU">${staffOpts(user || (c0?.user_ids || [])[0] || S.me?.id)}</select>
    <label class="label" for="anQ">Contact</label><div id="anPicked"></div>
    <input type="text" id="anQ" placeholder="Search people by name, or type a new name" autocomplete="off"><div class="results" id="anRes" hidden></div>
    <div class="row"><div><label class="label" for="anE">Email</label><input type="email" id="anE"></div><div><label class="label" for="anP">Phone</label><input type="tel" id="anP"></div></div>
    <label class="label" for="anT">Title (optional)</label><input type="text" id="anT" maxlength="200">
    <label class="label" for="anLoc">Where (optional)</label><input type="text" id="anLoc" maxlength="500">
    <label class="label" for="anNo">Notes</label><textarea id="anNo" rows="2"></textarea>
    <label class="check"><input type="checkbox" id="anN" checked> Email them a confirmation</label>
    <div class="actions"><button class="btn" id="anGo">Add it</button></div>`);
  const drawPicked = () => {
    $('#anPicked', d).innerHTML = picked ? `<p style="margin:0 0 6px"><b>${esc(picked.name)}</b> <button type="button" class="linkish" id="anClr">Change</button></p>` : '';
    $('#anQ', d).hidden = !!picked; $('#anE', d).closest('.row').hidden = !!picked;
    if ($('#anClr', d)) $('#anClr', d).onclick = () => { picked = null; drawPicked(); };
  };
  drawPicked();
  if (company && !picked) $('#anT', d).value = '';
  $('#anCal', d).onchange = () => { const c = calOf($('#anCal', d).value); if (c) { $('#anL', d).value = c.duration_min; if (c.user_ids?.[0]) $('#anU', d).value = c.user_ids[0]; } };
  let tmr = 0;
  $('#anQ', d).oninput = () => {
    clearTimeout(tmr); const v = $('#anQ', d).value.trim();
    if (v.length < 2) { $('#anRes', d).hidden = true; return; }
    tmr = setTimeout(async () => {
      const w = v.split(/\s+/)[0].replace(/[%,()]/g, '');
      const { data } = await sb.from('people').select('id,first_name,last_name,personal_email,personal_cell').is('archived_at', null).ilike('first_name', `%${w}%`).limit(8);
      const rows = (data || []).filter((p) => `${p.first_name} ${p.last_name || ''}`.toLowerCase().includes(v.toLowerCase().split(/\s+/)[0]));
      $('#anRes', d).hidden = !rows.length;
      $('#anRes', d).innerHTML = rows.map((p) => `<button type="button" class="result" data-pp="${p.id}"><b>${esc([p.first_name, p.last_name].filter(Boolean).join(' '))}</b> <small>${esc(p.personal_email || p.personal_cell || '')}</small></button>`).join('');
      $$('[data-pp]', d).forEach((b) => (b.onclick = () => { const p = rows.find((x) => x.id === b.dataset.pp); picked = { id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(' '), email: p.personal_email }; $('#anRes', d).hidden = true; drawPicked(); }));
    }, 250);
  };
  $('#anGo', d).onclick = async (e) => {
    const v = $('#anD', d).value; if (!v) return C.toast('Pick a day and time');
    const s = new Date(v), len = Math.max(5, Number($('#anL', d).value) || 30);
    const p = { calendar_id: $('#anCal', d).value || null, user_id: $('#anU', d).value, starts_at: s.toISOString(), ends_at: new Date(s.getTime() + len * 60000).toISOString(),
      person_id: picked?.id || null, company_id: company || null, name: picked ? null : $('#anQ', d).value.trim() || null, email: picked ? null : $('#anE', d).value.trim() || null,
      phone: picked ? null : $('#anP', d).value.trim() || null, title: $('#anT', d).value.trim() || null, location: $('#anLoc', d).value.trim() || null, notes: $('#anNo', d).value.trim() || null,
      notify: $('#anN', d).checked };
    e.target.disabled = true;
    const ok = await saveAppt(null, p);
    e.target.disabled = false;
    if (!ok) return;
    d.close(); C.toast('Appointment added'); if (after) after();
  };
}

/* ================= boxes on My Day and on contacts ================= */
const apptRows = (list, showWho) => list.map((a) => `<button type="button" class="apptrow" data-appt="${a.id}"><span class="caldot" style="background:${esc(colorOf(a))}"></span>
  <span class="when">${esc(new Date(a.starts_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}<small>${esc(fmtT(a.starts_at))}</small></span>
  <span style="flex:1;min-width:0"><b>${esc(a.name || a.title || 'Appointment')}</b> ${a.status !== 'booked' ? `<span class="badge ${STATUS_BADGE[a.status] || ''}">${esc(STATUS_NAME[a.status])}</span>` : ''}
  <small>${esc([calOf(a.calendar_id)?.name || a.title, showWho ? userName(a.user_id) : '', a.location].filter(Boolean).join(' · '))}</small></span></button>`).join('');

export async function myDayBox(box) {
  if (!box || !canSee()) return;
  css(); await loadCals();
  const s = new Date(); s.setHours(0, 0, 0, 0);
  const { data, error } = await sb.from('appointments').select('*').eq('user_id', S.me.id).gte('starts_at', s.toISOString()).lt('starts_at', addD(s, 7).toISOString())
    .neq('status', 'cancelled').order('starts_at').limit(50);
  if (error) return;
  const list = (data || []).filter((a) => new Date(a.ends_at) > new Date() || a.status === 'booked');
  const today = list.filter((a) => isoDay(new Date(a.starts_at)) === isoDay(new Date()));
  box.innerHTML = `<div class="card"><div class="toolbar" style="margin:0"><h2 style="flex:1;margin:0">Appointments${today.length ? ` today (${today.length})` : ''}</h2>
      <button class="btn ghost small" data-nav="calendar">Calendar</button></div>
    ${list.length ? apptRows(list, false) : '<p class="empty">Nothing booked with you in the next 7 days.</p>'}</div>`;
  $('[data-nav]', box).onclick = () => C.go('calendar');
  $$('[data-appt]', box).forEach((b) => (b.onclick = () => openAppt(b.dataset.appt, () => myDayBox(box))));
}

export async function contactBox(box, { person = null, company = null, name = '' } = {}) {
  if (!box || !canSee()) return;
  css(); await loadCals();
  let q = sb.from('appointments').select('*').order('starts_at', { ascending: false }).limit(30);
  q = person ? q.eq('person_id', person) : q.eq('company_id', company);
  const { data, error } = await q;
  if (error) return;
  const now = new Date();
  const list = data || [];
  const up = list.filter((a) => new Date(a.starts_at) >= now && a.status !== 'cancelled').reverse(), past = list.filter((a) => !(new Date(a.starts_at) >= now && a.status !== 'cancelled'));
  box.innerHTML = `<div class="card"><div class="toolbar" style="margin:0"><h2 style="flex:1;margin:0">Appointments</h2>${canEdit() ? '<button class="btn ghost small" id="cbAdd">Add one</button>' : ''}</div>
    ${up.length ? apptRows(up, true) : '<p class="empty">Nothing coming up.</p>'}
    ${past.length ? `<details><summary class="hint" style="cursor:pointer">Earlier and cancelled (${past.length})</summary>${apptRows(past, true)}</details>` : ''}</div>`;
  const again = () => contactBox(box, { person, company, name });
  $$('[data-appt]', box).forEach((b) => (b.onclick = () => openAppt(b.dataset.appt, again)));
  if ($('#cbAdd', box)) $('#cbAdd', box).onclick = async () => {
    let p = null;
    if (person) { const { data: pp } = await sb.from('people').select('id,first_name,last_name,personal_email').eq('id', person).maybeSingle(); if (pp) p = { id: pp.id, name: [pp.first_name, pp.last_name].filter(Boolean).join(' '), email: pp.personal_email }; }
    addAppt({ person: p, company, after: again });
  };
}

/* ================= booking calendars (setup list) ================= */
async function viewSetup(main) {
  css();
  const cals = await loadCals(true);
  if (!cals) return noDb(main, 'Booking calendars');
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Booking calendars</h1><button class="btn ghost small" data-nav="calhours">Hours and days off</button><button class="btn small" id="csNew">New calendar</button></div>
    <p class="hint">Each calendar gets its own booking page. Share the link or put it on your website with the embed code.</p>
    ${!S.acct?.slug ? '<p class="banner warn">This account has no short name yet, so booking links can\'t be made. Ask the platform admin to set one.</p>' : ''}
    <div class="list">${cals.map((c) => `<div class="card" data-cal="${c.id}"><div class="calrow"><span class="caldot" style="background:${esc(c.color)};width:16px;height:16px"></span>
        <div class="grow"><b>${esc(c.name)}</b> ${c.active ? '' : '<span class="badge">Off</span>'}
          <small class="hint" style="margin:0">${esc([KINDS.find((k) => k[0] === c.kind)?.[0] === 'one' ? 'One person' : c.kind === 'pick' ? 'They pick who' : 'Round robin', `${c.duration_min} min`,
            (c.user_ids || []).map(first).join(', ') || 'Nobody yet'].join(' · '))}</small></div>
        <button class="btn ghost small" data-ed="${c.id}">Edit</button></div>
      <div class="actions"><button class="btn small secondary" data-link="${c.id}">Copy link</button><a class="btn small ghost" href="${esc(bookUrl(c))}" target="_blank" rel="noopener">Open the page ↗</a>
        <button class="btn small ghost" data-emb="${c.id}">Embed code</button></div></div>`).join('') || '<p class="empty">No calendars yet. Make your first one.</p>'}</div>`;
  $$('[data-nav]', main).forEach((b) => (b.onclick = () => C.go(b.dataset.nav)));
  $('#csNew').onclick = () => C.go('calset', 'new');
  $$('[data-ed]', main).forEach((b) => (b.onclick = () => C.go('calset', b.dataset.ed)));
  $$('[data-link]', main).forEach((b) => (b.onclick = () => copy(bookUrl(calOf(b.dataset.link)), 'Booking link copied')));
  $$('[data-emb]', main).forEach((b) => (b.onclick = () => embedDlg(calOf(b.dataset.emb))));
}
function embedDlg(c) {
  const d = dlg('calEmbed', `<div class="vhead"><h2 style="margin:0">Put ${esc(c.name)} on your website</h2><button class="btn ghost small" data-x>Close</button></div>
    <h3>On the page</h3><p class="hint">Paste this where the booking calendar should show.</p><textarea class="codebox" readonly id="emIn">${esc(embedCode(c, false))}</textarea>
    <div class="actions"><button class="btn small" data-cp="emIn">Copy</button></div>
    <h3>As a button</h3><p class="hint">A "Book a time" button that opens the calendar in a window. Change data-button to change its words.</p><textarea class="codebox" readonly id="emPop">${esc(embedCode(c, true))}</textarea>
    <div class="actions"><button class="btn small" data-cp="emPop">Copy</button></div>
    <h3>Link</h3><input type="text" readonly value="${esc(bookUrl(c))}">`);
  $$('[data-cp]', d).forEach((b) => (b.onclick = () => copy($('#' + b.dataset.cp, d).value)));
}

/* ================= one calendar's settings ================= */
async function viewEditor(main) {
  css();
  const isNew = !S.param || S.param === 'new';
  const cals = await loadCals(true);
  if (!cals) return noDb(main, 'Booking calendar');
  const c = isNew ? { name: '', slug: '', description: '', color: '#2563EB', kind: 'one', user_ids: [S.me?.id].filter(Boolean), duration_min: 30, durations: [], slot_min: 30, buffer_before: 0, buffer_after: 0,
    notice_min: 120, ahead_days: 60, daily_max: null, location_kind: 'phone', location_text: '', look_busy_pct: null, look_busy_min: 2, questions: [], ask_company: false, confirm_text: '', redirect_url: '', time_zone: myTz(),
    allow_cancel: true, allow_reschedule: true, cutoff_hours: 4, reminders: [1440, 60], active: true } : JSON.parse(JSON.stringify(calOf(S.param) || {}));
  if (!isNew && !c.id) { main.innerHTML = '<p class="empty">Calendar not found.</p>'; return; }
  // 112: questions can save their answer into a custom field on the person or the organization
  const cfOn = FLD.feat('custom_fields');
  let CF = cfOn ? ((await sb.from('custom_fields').select('entity,key,label,type,options').in('entity', ['people', 'companies']).is('archived_at', null).order('sort')).data || []) : [];
  const fieldOpts = (cur) => `<option value="">Don't save it</option>${['people', 'companies'].map((e) => {
      const list = CF.filter((f) => f.entity === e);
      return `<optgroup label="${e === 'people' ? 'Save on the contact' : 'Save on the organization'}">${list.map((f) => `<option value="${e}:${esc(f.key)}" ${cur === `${e}:${f.key}` ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
        <option value="new:${e}">+ New ${e === 'people' ? 'contact' : 'organization'} field from this question</option></optgroup>`; }).join('')}`;
  const read = () => {
    c.name = $('#ceName').value.trim(); c.slug = $('#ceSlug').value.trim(); c.description = $('#ceDesc').value; c.color = $('#ceColor').value; c.kind = $('#ceKind').value;
    // read whichever picker is on screen (the kind may have just changed)
    c.user_ids = $('#ceOne') ? [$('#ceOne').value, ...(c.user_ids || []).slice(1)].filter(Boolean) : $$('[data-cu]:checked', main).map((x) => x.dataset.cu);
    if (c.kind === 'one') c.user_ids = c.user_ids.slice(0, 1);
    c.duration_min = Number($('#ceDur').value) || 30; c.durations = $('#ceDurs').value.split(/[,\s]+/).map(Number).filter((x) => x >= 5);
    c.slot_min = Number($('#ceSlot').value) || 30; c.buffer_before = Number($('#ceBB').value) || 0; c.buffer_after = Number($('#ceBA').value) || 0;
    c.notice_min = Math.round((Number($('#ceNotice').value) || 0) * 60); c.ahead_days = Number($('#ceAhead').value) || 60; c.daily_max = Number($('#ceMax').value) || null;
    c.look_busy_pct = $('#ceLB').checked ? Math.max(1, Math.min(95, Number($('#ceLBPct').value) || 30)) : null;
    c.look_busy_min = Math.max(0, Math.min(20, Number($('#ceLBMin').value) || 0));
    c.location_kind = $('#ceLoc').value; c.location_text = $('#ceLocT').value; c.ask_company = $('#ceCo').checked; c.confirm_text = $('#ceConf').value; c.redirect_url = $('#ceRed').value.trim();
    c.time_zone = $('#ceTz').value; c.allow_cancel = $('#ceCan').checked; c.allow_reschedule = $('#ceRes').checked; c.cutoff_hours = Number($('#ceCut').value) || 0;
    c.reminders = $$('[data-rem]:checked', main).map((x) => Number(x.dataset.rem)); c.active = $('#ceOn').checked;
    c.questions = $$('[data-q]', main).map((r) => ({ key: r.dataset.key || '', label: $('[data-qk="label"]', r).value, kind: $('[data-qk="kind"]', r).value,
      options: $('[data-qk="options"]', r).value.split(',').map((x) => x.trim()).filter(Boolean), required: $('[data-qk="required"]', r).checked,
      field: $('[data-qk="field"]', r)?.value || '' }));
  };
  const render = () => {
    main.innerHTML = `<div class="toolbar"><button class="btn ghost small" id="ceBack">← Booking calendars</button><div style="flex:1"></div>
        <label class="check" style="margin:0"><input type="checkbox" id="ceOn" ${c.active ? 'checked' : ''}> Taking bookings</label></div>
      <h1>${isNew ? 'New calendar' : esc(c.name)}</h1>
      <div class="card"><h2>The basics</h2>
        <div class="row"><div><label class="label" for="ceName">Name</label><input type="text" id="ceName" maxlength="120" value="${esc(c.name)}" placeholder="Free estimate"></div>
          <div><label class="label" for="ceSlug">Short link name</label><input type="text" id="ceSlug" maxlength="60" value="${esc(c.slug)}" placeholder="free-estimate"></div></div>
        <label class="label" for="ceDesc">What it's for (shows on the booking page)</label><textarea id="ceDesc" rows="2" maxlength="2000">${esc(c.description || '')}</textarea>
        <div class="row"><div><label class="label" for="ceColor">Color</label><input type="color" id="ceColor" value="${esc(c.color)}" style="min-height:44px;padding:4px"></div>
          <div><label class="label" for="ceTz">Time zone</label><select id="ceTz">${tzOpts(c.time_zone)}</select></div></div></div>
      <div class="card"><h2>Who takes them</h2><select id="ceKind">${KINDS.map(([k, n]) => `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
        ${c.kind === 'one' ? `<label class="label" for="ceOne">Person</label><select id="ceOne">${staffOpts((c.user_ids || [])[0], 'Pick someone')}</select>`
          : `<p class="hint">${c.kind === 'pick' ? 'The customer picks one of these people.' : 'Each booking goes to whoever is open, the one booked least recently first.'} People from other accounts on your team can be added too.</p>
            <div class="peoplepick">${C.staff().map((u) => `<label><input type="checkbox" data-cu="${u.id}" ${(c.user_ids || []).includes(u.id) ? 'checked' : ''}> ${esc(u.full_name || u.email)}</label>`).join('')}</div>`}
        <p class="hint">Each person's own hours and days off apply. <button type="button" class="linkish" data-nav="calhours">Set hours</button></p></div>
      <div class="card"><h2>Times</h2>
        <div class="row"><div><label class="label" for="ceDur">Length (minutes)</label><input type="number" id="ceDur" min="5" max="720" step="5" value="${c.duration_min}"></div>
          <div><label class="label" for="ceDurs">Other lengths they can pick (optional)</label><input type="text" id="ceDurs" value="${esc((c.durations || []).join(', '))}" placeholder="60, 90"></div></div>
        <div class="row"><div><label class="label" for="ceSlot">A start time every (minutes)</label><input type="number" id="ceSlot" min="5" max="240" step="5" value="${c.slot_min}"></div>
          <div><label class="label" for="ceMax">Most per person per day (blank: no limit)</label><input type="number" id="ceMax" min="1" max="100" value="${c.daily_max ?? ''}"></div></div>
        <div class="row"><div><label class="label" for="ceBB">Free time before (minutes)</label><input type="number" id="ceBB" min="0" max="240" step="5" value="${c.buffer_before}"></div>
          <div><label class="label" for="ceBA">Free time after (minutes)</label><input type="number" id="ceBA" min="0" max="240" step="5" value="${c.buffer_after}"></div></div>
        <div class="row"><div><label class="label" for="ceNotice">Book at least this many hours ahead</label><input type="number" id="ceNotice" min="0" max="720" step="0.5" value="${c.notice_min / 60}"></div>
          <div><label class="label" for="ceAhead">Up to this many days out</label><input type="number" id="ceAhead" min="1" max="365" value="${c.ahead_days}"></div></div></div>
      <div class="card"><h2>Where</h2><select id="ceLoc">${LOCS.map(([k, n]) => `<option value="${k}" ${c.location_kind === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <div id="ceLocBox"><label class="label" for="ceLocT">${c.location_kind === 'video' ? (c.kind === 'one' ? 'Video link (blank: the person\'s own link)' : 'Video link (only used for someone with no link of their own)') : 'Address'}</label><input type="text" id="ceLocT" maxlength="500" value="${esc(c.location_text || '')}"></div>
        ${c.location_kind === 'video' ? `<p class="hint">${c.kind === 'one' ? 'Leave the link blank and bookings use the person\'s own video link.' : 'Each booking uses the video link of whoever takes it.'} People save their link on their profile under My availability. Using a personal room? Turn on the waiting room in Zoom.</p><div id="ceLinkWarn"></div>` : ''}</div>
      <div class="card"><h2>Look busy</h2>
        <label class="check"><input type="checkbox" id="ceLB" ${c.look_busy_pct ? 'checked' : ''}> Make this calendar look busier to customers</label>
        <div id="ceLBBox" ${c.look_busy_pct ? '' : 'hidden'}>
          <div class="row"><div><label class="label" for="ceLBPct">Aim for this much of each day looking taken (%)</label><input type="number" id="ceLBPct" min="1" max="95" value="${c.look_busy_pct || 30}"></div>
            <div><label class="label" for="ceLBMin">Always leave at least this many times open a day</label><input type="number" id="ceLBMin" min="0" max="20" value="${c.look_busy_min ?? 2}"></div></div>
          <p class="hint">If real bookings and busy time already fill that much of a day, nothing is hidden. Otherwise some open times are hidden at random, the same ones all day. Only customers see fewer times; your team always sees real availability.</p>
          <div id="ceLBPrev"></div></div></div>
      <div class="card"><h2>Questions</h2><p class="hint">Name, email and phone are always asked.${cfOn ? ' Pick a field to save an answer on the contact or organization: it fills the field when it\'s blank. If the answer differs from what\'s on file, a new contact is made and flagged in Review so you can compare and merge.' : ''}</p>
        <label class="check"><input type="checkbox" id="ceCo" ${c.ask_company ? 'checked' : ''}> Ask for their company (adds it as an organization)</label>
        <div id="ceQs">${(c.questions || []).map((q, i) => `<div class="qrow" data-q="${i}" data-key="${esc(q.key || '')}"><input type="text" data-qk="label" value="${esc(q.label)}" placeholder="Question" aria-label="Question">
          <select data-qk="kind" aria-label="Type">${[['short', 'Short answer'], ['long', 'Long answer'], ['choice', 'Pick one']].map(([k, n]) => `<option value="${k}" ${q.kind === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
          <input type="text" class="qo" data-qk="options" value="${esc((q.options || []).join(', '))}" placeholder="Choices, with commas" style="visibility:${q.kind === 'choice' ? 'visible' : 'hidden'}" aria-label="Choices">
          <label class="check" style="min-height:0"><input type="checkbox" data-qk="required" ${q.required ? 'checked' : ''}> Required</label>${cfOn ? `<select data-qk="field" aria-label="Save the answer to" style="grid-column:1/-1">${fieldOpts(q.field || '')}</select>` : ''}<button type="button" class="btn ghost small" data-qrm="${i}" aria-label="Remove">✕</button></div>`).join('')}</div>
        <div class="actions"><button type="button" class="btn small secondary" id="ceQAdd">Add a question</button></div></div>
      <div class="card"><h2>After they book</h2>
        <label class="label" for="ceConf">Thank you message</label><textarea id="ceConf" rows="2" maxlength="2000" placeholder="Thanks! You'll get an email with the details.">${esc(c.confirm_text || '')}</textarea>
        <label class="label" for="ceRed">Or send them to a page (optional, https://)</label><input type="url" id="ceRed" value="${esc(c.redirect_url || '')}" placeholder="https://yoursite.com/thank-you">
        <label class="check"><input type="checkbox" id="ceCan" ${c.allow_cancel ? 'checked' : ''}> They can cancel from their email</label>
        <label class="check"><input type="checkbox" id="ceRes" ${c.allow_reschedule ? 'checked' : ''}> They can reschedule from their email</label>
        <label class="label" for="ceCut">No changes online this many hours before</label><input type="number" id="ceCut" min="0" max="720" value="${c.cutoff_hours}" style="max-width:160px">
        <label class="label">Reminder emails (up to 4)</label><div class="peoplepick">${REMINDERS.map(([m, n]) => `<label><input type="checkbox" data-rem="${m}" ${(c.reminders || []).includes(m) ? 'checked' : ''}> ${n} before</label>`).join('')}</div></div>
      <div class="actions"><button class="btn" id="ceSave">Save</button>${isNew ? '' : '<button class="btn ghost small" id="ceLink">Copy link</button><button class="btn ghost small" id="ceEmb">Embed code</button><button class="btn ghost danger small" id="ceDel">Remove calendar</button>'}</div>`;
    $('#ceBack').onclick = () => C.go('calsetup');
    $$('[data-nav]', main).forEach((b) => (b.onclick = () => C.go(b.dataset.nav)));
    $('#ceKind').onchange = () => { read(); render(); };
    $('#ceLoc').onchange = () => { read(); render(); };
    $('#ceLocBox').hidden = !['video', 'in_person'].includes(c.location_kind);
    // Look busy: turn on, and a preview of the next week (saved calendars only)
    const lbPrev = () => {
      if (isNew || !$('#ceLB').checked) { $('#ceLBPrev').innerHTML = ''; return; }
      sb.rpc('cal_busy_preview', { p_cal: c.id, p_pct: Number($('#ceLBPct').value) || 30, p_min: Number($('#ceLBMin').value) || 0 }).then(({ data }) => {
        if (!data || !$('#ceLBPrev')) return;
        const open = data.reduce((a, d) => a + d.open, 0), shown = data.reduce((a, d) => a + d.shown, 0);
        $('#ceLBPrev').innerHTML = `<p class="hint"><b>Next 7 days:</b> ${shown} of ${open} open times show to customers, ${open - shown} hidden.</p>
          <div class="peoplepick">${data.map((d) => `<span class="badge">${esc(fmtDay(dayOf(d.day), { weekday: 'short', month: 'short', day: 'numeric' }))}: ${d.shown}/${d.open}</span>`).join(' ')}</div>`;
      }, () => {});
    };
    $('#ceLB').onchange = () => { $('#ceLBBox').hidden = !$('#ceLB').checked; lbPrev(); };
    $('#ceLBPct').onchange = lbPrev; $('#ceLBMin').onchange = lbPrev;
    lbPrev();
    // warn when someone taking video bookings has no link of their own (and the calendar's link won't cover them)
    if ($('#ceLinkWarn') && (c.kind !== 'one' || !(c.location_text || '').trim()) && (c.user_ids || []).length) {
      sb.rpc('cal_link_missing', { p_users: c.user_ids }).then(({ data }) => {
        const names = (data || []).map((id) => (C.staff().find((u) => u.id === id) || {}).full_name || 'Someone');
        if (names.length && $('#ceLinkWarn')) $('#ceLinkWarn').innerHTML = `<p class="banner warn">${esc(names.join(', '))} ${names.length === 1 ? 'has' : 'have'} no video link saved, so their bookings will say "link to follow"${(c.location_text || '').trim() ? ' (or use this calendar\'s link)' : ''}. They can add one on their profile under My availability.</p>`;
      }, () => {});
    }
    $('#ceName').oninput = () => { if (isNew && !$('#ceSlug').dataset.touched) $('#ceSlug').value = $('#ceName').value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); };
    $('#ceSlug').oninput = () => { $('#ceSlug').dataset.touched = '1'; };
    $$('[data-qk="kind"]', main).forEach((s) => (s.onchange = () => { $('[data-qk="options"]', s.closest('.qrow')).style.visibility = s.value === 'choice' ? 'visible' : 'hidden'; }));
    const KIND_OF = (f) => (f.type === 'long_text' ? ['long', []] : f.type === 'select' || f.type === 'multi_select' ? ['choice', f.options || []] : f.type === 'checkbox' ? ['choice', ['Yes', 'No']] : ['short', []]);
    $$('[data-qk="field"]', main).forEach((sel) => (sel.onchange = async () => {
      const row = sel.closest('.qrow'), v = sel.value;
      if (v.startsWith('new:')) {
        const entity = v.slice(4), label = $('[data-qk="label"]', row).value.trim();
        if (!label) { sel.value = ''; return C.toast('Write the question first; the new field uses it as its name'); }
        const kind = $('[data-qk="kind"]', row).value, opts = $('[data-qk="options"]', row).value.split(',').map((x) => x.trim()).filter(Boolean);
        const type = kind === 'long' ? 'long_text' : kind === 'choice' ? (opts.length === 2 && /^yes$/i.test(opts[0]) && /^no$/i.test(opts[1]) ? 'checkbox' : 'select') : 'text';
        const key = (label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^([^a-z])/, 'f_$1') || 'field').slice(0, 40);
        const { error } = await sb.from('custom_fields').insert({ entity, key, label: label.slice(0, 60), type, options: type === 'select' ? opts : [], sort: CF.length * 10 });
        if (error) { sel.value = ''; return C.fail(error); }
        CF.push({ entity, key, label: label.slice(0, 60), type, options: type === 'select' ? opts : [] });
        read(); c.questions[Number(row.dataset.q)].field = `${entity}:${key}`; C.toast('Field added'); return render();
      }
      const f = CF.find((x) => `${x.entity}:${x.key}` === v);
      if (!f) return;
      const [kind, opts] = KIND_OF(f);
      $('[data-qk="kind"]', row).value = kind; $('[data-qk="options"]', row).value = opts.join(', ');
      $('[data-qk="options"]', row).style.visibility = kind === 'choice' ? 'visible' : 'hidden';
      if (!$('[data-qk="label"]', row).value.trim()) $('[data-qk="label"]', row).value = f.label;
    }));
    $('#ceQAdd').onclick = () => { read(); c.questions.push({ label: '', kind: 'short', options: [], required: false }); render(); };
    $$('[data-qrm]', main).forEach((b) => (b.onclick = () => { read(); c.questions.splice(Number(b.dataset.qrm), 1); render(); }));
    $('#ceSave').onclick = async (e) => {
      read();
      if (!c.name) return C.toast('Give the calendar a name');
      if (c.reminders.length > 4) return C.toast('Pick up to 4 reminders');
      e.target.disabled = true;
      const { data, error } = await sb.rpc('calendar_save', { p_id: isNew ? null : c.id, p: c });
      e.target.disabled = false;
      if (error) return C.fail(error);
      CALS = null; C.toast('Saved');
      if (c.active !== false && C.brandCheck) C.brandCheck('calendar', isNew ? data : c.id, c.name, [c.color]);   // a saved, live calendar counts as finished
      if (isNew) C.go('calset', data); else viewEditor(main);
    };
    if ($('#ceLink')) $('#ceLink').onclick = () => copy(bookUrl(c), 'Booking link copied');
    if ($('#ceEmb')) $('#ceEmb').onclick = () => embedDlg(c);
    if ($('#ceDel')) $('#ceDel').onclick = async () => {
      if (!confirm('Remove this calendar? Its booking page stops working. Appointments already booked stay.')) return;
      const { error } = await sb.rpc('calendar_archive', { p_id: c.id }); if (error) return C.fail(error);
      CALS = null; C.go('calsetup');
    };
  };
  render();
}

/* ================= hours and days off =================
   109: a person's own hours and days off apply in every account they work in. An account can set its own hours
   for them instead (they win there and start as a copy), and add days off that only count there. */
async function viewHours(main) {
  css();
  const who = S.param && canOthersHours() ? S.param : S.me?.id;
  const { data: H, error } = await sb.rpc('hours_get', { p_user: who });
  if (error) return noDb(main, 'Hours and days off');
  const acctName = S.acct?.name || 'this account';
  const own = !!H.account;   // this account has its own hours for them
  const src = H.account || H.user;
  const week = JSON.parse(JSON.stringify(src?.weekly || DEFAULT_WEEK));
  let tz = src?.time_zone || myTz();
  const self = who === S.me?.id;
  const whose = self ? 'your' : 'their';
  const readWeek = () => { for (let i = 0; i < 7; i++) week[i] = $$(`[data-day="${i}"] .hrng`, main).map((r) => [$('[data-a]', r).value, $('[data-b]', r).value]).filter((x) => x[0] && x[1]); tz = $('#hTz').value; };
  const where = own ? `<p class="banner">${esc(acctName)} uses its own hours for ${self ? 'you' : 'them'}, instead of ${whose} usual hours.${H.can_account ? ' <button type="button" class="linkish" id="hDef">Go back to ' + whose + ' usual hours here</button>' : ''}</p>`
    : `<p class="hint">These are ${whose} usual hours. They apply in every account ${self ? 'you work' : 'they work'} in${H.home ? '' : ` (set in ${esc(H.home_name || 'their home account')})`}.</p>`;
  const saveBtns = [
    H.can_user ? `<button class="btn" id="hSaveU">${own ? 'Save as ' + whose + ' usual hours' : 'Save'}</button>` : '',
    H.can_account ? `<button class="btn ${H.can_user ? 'secondary' : ''}" id="hSaveA">${own ? 'Save for ' + esc(acctName) : 'Save for ' + esc(acctName) + ' only'}</button>` : ''].join('');
  const tag = (d) => d.scope === 'user' ? '<span class="badge">Everywhere</span>' : `<span class="badge">${esc(acctName)} only</span>`;
  const render = () => {
    main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Hours and days off</h1>${canSetup() ? '<button class="btn ghost small" data-nav="calsetup">Booking calendars</button>' : ''}</div>
      ${canOthersHours() ? `<label class="label" for="hWho">Whose hours</label><select id="hWho" style="max-width:340px">${staffOpts(who)}</select>` : ''}
      <div class="card"><h2>Every week</h2>${where}<p class="hint">Bookings only land inside these hours. Add more than one range for a lunch break.${src ? '' : ' These are the starting hours until you save.'}</p>
        ${DAYS.map((n, i) => `<div class="hday" data-day="${i}"><b>${n}</b><div class="rngs">${(week[i] || []).map((r) => `<div class="hrng"><input type="time" data-a value="${esc(r[0])}" aria-label="${n} from"> to
            <input type="time" data-b value="${esc(r[1] === '24:00' ? '23:59' : r[1])}" aria-label="${n} until"><button type="button" class="btn ghost small" data-rm aria-label="Remove">✕</button></div>`).join('') || '<span class="hint" style="margin:8px 0">Off</span>'}
          <div><button type="button" class="linkish" data-add="${i}">+ Add hours</button></div></div></div>`).join('')}
        <label class="label" for="hTz">Time zone</label><select id="hTz" style="max-width:340px">${tzOpts(tz)}</select>
        <div class="actions">${saveBtns || '<span class="hint">Only they or their home account\'s admins can change these.</span>'}</div></div>
      <div class="card"><h2>Days off and one-off hours</h2>
        ${(H.days || []).map((o) => `<div class="calrow" style="padding:8px 0;border-bottom:1px solid var(--line)"><div class="grow"><b>${esc(fmtDay(dayOf(o.day), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))}</b> ${tag(o)}
            <small class="hint" style="margin:0">${(o.ranges || []).length ? esc(o.ranges.map((r) => `${r[0]} to ${r[1]}`).join(', ')) : 'Off all day'}${o.note ? ' · ' + esc(o.note) : ''}</small></div>
          ${(o.scope === 'user' ? H.can_user : H.can_account) ? `<button type="button" class="btn ghost small" data-orm="${o.id}" data-sc="${o.scope}">Remove</button>` : ''}</div>`).join('') || '<p class="empty">None coming up.</p>'}
        ${H.can_user || H.can_account ? `<div class="row" style="margin-top:8px"><div><label class="label" for="oDay">Day</label><input type="date" id="oDay" min="${isoDay(new Date())}"></div>
          <div><label class="label" for="oKind">That day</label><select id="oKind"><option value="off">Off all day</option><option value="hours">Different hours</option></select></div></div>
        <div class="row" id="oHrs" hidden><div><label class="label" for="oA">From</label><input type="time" id="oA" value="09:00"></div><div><label class="label" for="oB">Until</label><input type="time" id="oB" value="12:00"></div></div>
        <div class="row"><div><label class="label" for="oNote">Note (optional)</label><input type="text" id="oNote" maxlength="300" placeholder="Vacation"></div>
          <div><label class="label" for="oScope">Applies</label><select id="oScope">${H.can_user ? '<option value="user">Everywhere</option>' : ''}${H.can_account ? `<option value="account">${esc(acctName)} only</option>` : ''}</select></div></div>
        <p class="hint">Notes on days off that apply everywhere only show to ${self ? 'you' : 'them'} and ${self ? 'your' : 'their'} home account. Other accounts just see "Off".</p>
        <div class="actions"><button class="btn small" id="oSave">Add it</button></div>` : ''}</div>`;
    $$('[data-nav]', main).forEach((b) => (b.onclick = () => C.go(b.dataset.nav)));
    if ($('#hWho')) $('#hWho').onchange = (e) => C.go('calhours', e.target.value);
    $$('[data-add]', main).forEach((b) => (b.onclick = () => { readWeek(); const i = Number(b.dataset.add); const last = (week[i] || []).slice(-1)[0]; (week[i] ||= []).push(last ? [last[1] < '22:00' ? last[1] : '09:00', last[1] < '22:00' ? addHour(last[1], 2) : '17:00'] : ['09:00', '17:00']); render(); }));
    $$('[data-rm]', main).forEach((b) => (b.onclick = () => { b.closest('.hrng').remove(); }));
    if ($('#oKind')) $('#oKind').onchange = () => { $('#oHrs').hidden = $('#oKind').value !== 'hours'; };
    const save = (scope) => async () => {
      readWeek();
      const p = Object.fromEntries([...Array(7)].map((_, i) => [String(i), (week[i] || []).map((r) => [r[0], r[1] === '23:59' ? '24:00' : r[1]])]));
      const { error: e } = await sb.rpc('hours_save', { p_user: who, p_scope: scope, p_weekly: p, p_tz: tz });
      if (e) return C.fail(e); C.toast(scope === 'user' ? 'Hours saved everywhere' : `Hours saved for ${acctName}`); viewHours(main);
    };
    if ($('#hSaveU')) $('#hSaveU').onclick = save('user');
    if ($('#hSaveA')) $('#hSaveA').onclick = save('account');
    if ($('#hDef')) $('#hDef').onclick = async () => {
      if (!confirm(`Use ${whose} usual hours in ${acctName} again? The hours set just for ${acctName} go away.`)) return;
      const { error: e } = await sb.rpc('hours_use_default', { p_user: who }); if (e) return C.fail(e); viewHours(main);
    };
    if ($('#oSave')) $('#oSave').onclick = async () => {
      const day = $('#oDay').value; if (!day) return C.toast('Pick the day');
      const ranges = $('#oKind').value === 'off' ? [] : [[$('#oA').value, $('#oB').value]];
      const { error: e } = await sb.rpc('hours_day_save', { p_user: who, p_scope: $('#oScope').value, p_day: day, p_ranges: ranges, p_note: $('#oNote').value.trim() || null });
      if (e) return C.fail(e); C.toast('Added'); viewHours(main);
    };
    $$('[data-orm]', main).forEach((b) => (b.onclick = async () => { const { error: e } = await sb.rpc('hours_day_remove', { p_id: b.dataset.orm, p_scope: b.dataset.sc }); if (e) return C.fail(e); viewHours(main); }));
  };
  render();
}
const addHour = (t, n) => { const [h, m] = t.split(':').map(Number); return `${pad(Math.min(h + n, 23))}:${pad(m)}`; };
