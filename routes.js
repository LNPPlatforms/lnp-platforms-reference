/* Routes (Beta), Nov 13, 2026. Off until an account admin turns it on (Settings > Features > Routes).
   A route is an ordered list of stops (customers) run on a schedule by people and/or crews.
   - Managers (dispatch level 3, or admins): Jobs/Time > Routes builds routes, and each route's page has today's board:
     split the stops between people, mark someone late, dismiss the day, push it to tomorrow (and email those customers),
     and approve location reports.
   - Everyone on a route: My Day shows the route with its stops in order, with Arrived and Left buttons. The phone's
     location is checked only at the tap; far from the stop gives a warning and a way to report the right spot.
   - Customers' pages show their stops, and managers add stops from there.
   - The only background location: an hourly ping while clocked in, for people an admin turned it on for.
   Server side: schema/104_routes.sql. */

let C = null;
let sb, S, esc, $, $$;
export function init(ctx) { C = ctx; ({ sb, S, esc, $, $$ } = ctx); }

const feat = () => C.FLD.feat('routes');
export const canManage = () => feat() && (C.isAdmin() || C.FLD.can('dispatch', 3));
export const views = () => ({ routes: viewRoutes });
export const parents = { routes: 'myday' };

const DOW = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const sel = (id, opts, cur, attrs = '') => `<select id="${id}" ${attrs}>${opts.map(([v, n]) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
const time12 = (t) => { if (!t) return ''; const [h, m] = String(t).split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const mapLink = (lat, lng, addr) => lat != null ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : addr ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}` : '';
const STATUS = { scheduled: 'Not started', started: 'Under way', late: 'Running late', dismissed: 'Called off today', pushed: 'Moved to tomorrow', done: 'Done' };
const STOP = { pending: '', arrived: 'Arrived', done: 'Done', incomplete: 'Not finished', skipped: 'Skipped' };
export function scheduleText(r) {
  const at = ' at ' + time12(r.start_time);
  if (r.repeat === 'daily') return 'Every day' + at;
  if (r.repeat === 'monthly') return `Monthly on the ${(r.month_days || []).map((d) => d + (d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th')).join(', ') || '?'}${at}`;
  const days = (r.days || []).map((d) => DOW[d]).join(', ') || 'no days picked';
  return (r.repeat === 'custom' && r.every_weeks > 1 ? `Every ${r.every_weeks} weeks on ` : 'Weekly on ') + days + at;
}
function dlg(html) {
  let d = $('#rteDlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'rteDlg'; d.className = 'vdlg'; document.body.appendChild(d); }
  d.innerHTML = html; d.showModal();
  addEventListener('hashchange', () => d.open && d.close(), { once: true });
  return d;
}
async function upload(file) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
  const path = `${S.acct.id}/routes/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await sb.storage.from('job-photos').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (error) throw error;
  return path;
}
const people = () => C.staff().filter((u) => !u.hidden_in_team);

/* ================= the Routes screen (managers) ================= */
async function viewRoutes(main) {
  if (!feat()) { main.innerHTML = '<p class="empty">Routes are off. An admin can turn them on in Settings › Features.</p>'; return; }
  if (S.param) return viewRoute(main, S.param);
  if (!canManage()) { C.go('myday'); return; }
  const [{ data: routes, error }, { data: stops }, { data: asg }, { data: crews }] = await Promise.all([
    sb.from('routes').select('*').is('archived_at', null).order('name'),
    sb.from('route_stops').select('route_id').is('archived_at', null),
    sb.from('route_assignments').select('*'),
    sb.from('crews').select('id,name').is('archived_at', null).order('name'),
  ]);
  if (error) { main.innerHTML = '<p class="empty">Routes need the November 13 database update.</p>'; return; }
  const n = (id) => (stops || []).filter((s) => s.route_id === id).length;
  const who = (id) => (asg || []).filter((a) => a.route_id === id && !a.from_date && !a.to_date)
    .map((a) => a.user_id ? C.userName(a.user_id) : (crews || []).find((c) => c.id === a.crew_id)?.name + ' (crew)').filter(Boolean).join(', ');
  main.innerHTML = `<div class="toolbar"><h1 style="margin:0;flex:1">Routes <span class="badge gold">Beta</span></h1><button class="btn small" id="rtNew">+ New route</button></div>
    <div class="list">${(routes || []).map((r) => `<button class="item" data-rt="${r.id}"><b>${esc(r.name)}</b>${r.active ? '' : ' <span class="badge">Paused</span>'}
      <small>${esc(scheduleText(r))} · ${n(r.id)} stop${n(r.id) === 1 ? '' : 's'}${who(r.id) ? ' · ' + esc(who(r.id)) : ''}${r.dispatcher_id ? ' · Dispatcher ' + esc(C.userName(r.dispatcher_id)) : ''}</small></button>`).join('')
      || '<p class="empty">No routes yet. Make one, then add stops from each customer\'s page (or right on the route).</p>'}</div>
    ${C.isAdmin() ? `<details class="card"><summary><h2 style="display:inline">Hourly location while on the clock</h2></summary>
      <p class="hint">Off for everyone unless you turn it on here. When on, the CRM saves where that person's phone is about once an hour, only while they're clocked in and have the CRM open. Arrived and Left always check location at the tap, whatever this says.</p>
      ${people().map((u) => `<label class="check"><input type="checkbox" data-gps="${u.id}" ${u.gps_tracking ? 'checked' : ''}> ${esc(u.full_name)}</label>`).join('')}</details>` : ''}`;
  $$('[data-rt]', main).forEach((b) => (b.onclick = () => C.go('routes', b.dataset.rt)));
  $('#rtNew').onclick = () => editRoute(null, (id) => C.go('routes', id));
  $$('[data-gps]', main).forEach((c) => (c.onchange = async () => {
    const { error: e } = await sb.rpc('gps_tracking_set', { p_user: c.dataset.gps, p_on: c.checked });
    if (e) { c.checked = !c.checked; return C.fail(e); }
    const u = S.users.find((x) => x.id === c.dataset.gps); if (u) u.gps_tracking = c.checked; C.toast('Saved');
  }));
  // the user list doesn't carry gps_tracking; fill it in
  if (C.isAdmin()) {
    const { data: g } = await sb.from('app_users').select('id,gps_tracking').eq('gps_tracking', true);
    (g || []).forEach((x) => { const c = $(`[data-gps="${x.id}"]`, main); if (c) c.checked = true; });
  }
}

// the route form: name, schedule, start time, dispatcher, grace periods, people and crews
async function editRoute(r, done) {
  r = r || { name: '', start_time: '08:00', repeat: 'weekly', days: [1, 2, 3, 4, 5], month_days: [], every_weeks: 1, grace_min: 15, escalate_min: 15, active: true, starts_on: C.today() };
  const [{ data: asg }, { data: crews }] = await Promise.all([
    r.id ? sb.from('route_assignments').select('*').eq('route_id', r.id).order('created_at') : { data: [] },
    sb.from('crews').select('id,name').is('archived_at', null).order('name'),
  ]);
  const perm = (asg || []).filter((a) => !a.from_date && !a.to_date), temp = (asg || []).filter((a) => a.from_date || a.to_date);
  const whoOpts = [['', 'Pick…'], ...people().map((u) => ['u:' + u.id, u.full_name]), ...(crews || []).map((c) => ['c:' + c.id, c.name + ' (crew)'])];
  const whoName = (a) => a.user_id ? C.userName(a.user_id) : ((crews || []).find((c) => c.id === a.crew_id)?.name || 'Crew') + ' (crew)';
  const d = dlg(`<h2 style="margin-top:0">${r.id ? 'Edit route' : 'New route'}</h2>
    <label class="label" for="reName">Name</label><input type="text" id="reName" maxlength="80" value="${esc(r.name)}" placeholder="North side Tuesday">
    <div class="row"><div><label class="label" for="reRep">Repeats</label>${sel('reRep', [['daily', 'Every day'], ['weekly', 'Weekly'], ['custom', 'Every few weeks'], ['monthly', 'Monthly']], r.repeat)}</div>
      <div><label class="label" for="reTime">Starts at</label><input type="time" id="reTime" value="${esc(String(r.start_time).slice(0, 5))}"></div></div>
    <div id="reDaysBox"><label class="label">On</label><div class="chips">${[1, 2, 3, 4, 5, 6, 7].map((n) => `<label class="chip"><input type="checkbox" data-dow="${n}" ${(r.days || []).includes(n) ? 'checked' : ''}> ${DOW[n]}</label>`).join('')}</div></div>
    <div id="reEveryBox"><label class="label" for="reEvery">Every how many weeks</label><input type="number" id="reEvery" min="1" max="12" value="${esc(r.every_weeks)}" style="width:90px"></div>
    <div id="reMonthBox"><label class="label" for="reMonth">Days of the month (like 1, 15)</label><input type="text" id="reMonth" value="${esc((r.month_days || []).join(', '))}"><small class="hint">31 means the last day in shorter months too.</small></div>
    <div class="row"><div><label class="label" for="reFrom">First day</label><input type="date" id="reFrom" value="${esc(r.starts_on || C.today())}"></div>
      <div><label class="label" for="reTo">Last day (optional)</label><input type="date" id="reTo" value="${esc(r.ends_on || '')}"></div></div>
    <h3>If nobody starts</h3>
    <div class="row"><div><label class="label" for="reDisp">Dispatcher (gets the first alert)</label>${sel('reDisp', [['', 'Nobody: alert the admins'], ...people().map((u) => [u.id, u.full_name])], r.dispatcher_id)}</div>
      <div><label class="label" for="reGrace">Alert the dispatcher after (minutes)</label><input type="number" id="reGrace" min="1" max="240" value="${esc(r.grace_min)}"></div>
      <div><label class="label" for="reEsc">Then all admins after (more minutes)</label><input type="number" id="reEsc" min="1" max="240" value="${esc(r.escalate_min)}"></div></div>
    <small class="hint">"Started" means someone on the route clocked in. Alerts go out the way each person picked under the gear menu.</small>
    <h3>Who runs it</h3>
    <div id="rePerm">${perm.map((a) => `<span class="chip on">${esc(whoName(a))} <button type="button" class="linkish" data-rmasg="${a.id}" aria-label="Remove">×</button></span>`).join(' ') || '<small class="hint">Nobody yet.</small>'}</div>
    <div class="row"><div>${sel('reAddWho', whoOpts, '')}</div><div><button type="button" class="btn secondary small" id="reAddPerm">Add (every time)</button></div></div>
    <details ${temp.length ? 'open' : ''}><summary>Fill-ins for some days (someone else covers it for a while)</summary>
      ${temp.map((a) => `<div class="person-row">${esc(whoName(a))}: ${esc(a.from_date || '…')} to ${esc(a.to_date || '…')} <button type="button" class="linkish" data-rmasg="${a.id}">Remove</button></div>`).join('')}
      <div class="row"><div>${sel('reTmpWho', whoOpts, '')}</div><div><input type="date" id="reTmpFrom" aria-label="From"></div><div><input type="date" id="reTmpTo" aria-label="To"></div>
        <div><button type="button" class="btn secondary small" id="reAddTmp">Add fill-in</button></div></div>
      <small class="hint">On those days the fill-ins run it instead of the usual people.</small></details>
    <label class="check"><input type="checkbox" id="reActive" ${r.active ? 'checked' : ''}> Active (uncheck to pause it)</label>
    <div class="actions"><button class="btn" id="reSave">${r.id ? 'Save' : 'Create route'}</button><button class="btn ghost" id="reCancel">Cancel</button>
      ${r.id ? '<button class="btn ghost small" id="reArch" style="margin-left:auto">Archive route</button>' : ''}</div>`);
  const show = () => { const v = $('#reRep', d).value; $('#reDaysBox', d).hidden = !['weekly', 'custom'].includes(v); $('#reEveryBox', d).hidden = v !== 'custom'; $('#reMonthBox', d).hidden = v !== 'monthly'; };
  $('#reRep', d).onchange = show; show();
  $('#reCancel', d).onclick = () => d.close();
  const pending = [];   // people added before a new route is saved
  const save = async () => {
    const days = $$('[data-dow]', d).filter((c) => c.checked).map((c) => +c.dataset.dow);
    const month_days = $('#reMonth', d).value.split(/[\s,]+/).map(Number).filter((n) => n >= 1 && n <= 31);
    const row = { name: $('#reName', d).value.trim(), repeat: $('#reRep', d).value, start_time: $('#reTime', d).value || '08:00', days, month_days,
      every_weeks: Math.max(1, Math.min(12, +$('#reEvery', d).value || 1)), starts_on: $('#reFrom', d).value || C.today(), ends_on: $('#reTo', d).value || null,
      dispatcher_id: $('#reDisp', d).value || null, grace_min: +$('#reGrace', d).value || 15, escalate_min: +$('#reEsc', d).value || 15, active: $('#reActive', d).checked };
    if (!row.name) { C.toast('Name the route'); return null; }
    if (['weekly', 'custom'].includes(row.repeat) && !days.length) { C.toast('Pick at least one day'); return null; }
    if (row.repeat === 'monthly' && !month_days.length) { C.toast('Type the days of the month'); return null; }
    const q = r.id ? sb.from('routes').update(row).eq('id', r.id).select('id').single() : sb.from('routes').insert(row).select('id').single();
    const { data, error } = await q; if (error) { C.fail(error); return null; }
    r.id = data.id;
    for (const p of pending.splice(0)) { const { error: e } = await sb.from('route_assignments').insert({ ...p, route_id: r.id }); if (e) C.fail(e); }
    return r.id;
  };
  const addAsg = async (who, from, to) => {
    if (!who) return C.toast('Pick a person or crew');
    const row = { [who.startsWith('u:') ? 'user_id' : 'crew_id']: who.slice(2), from_date: from || null, to_date: to || null };
    if (!r.id) { pending.push(row); $('#rePerm', d).insertAdjacentHTML('beforeend', ` <span class="chip on">${esc(whoOpts.find(([v]) => v === who)[1])}${from || to ? ` (${esc(from || '…')} to ${esc(to || '…')})` : ''}</span>`); return; }
    const { error } = await sb.from('route_assignments').insert({ ...row, route_id: r.id }); if (error) return C.fail(error);
    d.close(); const { data: fresh } = await sb.from('routes').select('*').eq('id', r.id).single(); editRoute(fresh, done);
  };
  $('#reAddPerm', d).onclick = () => addAsg($('#reAddWho', d).value);
  $('#reAddTmp', d).onclick = () => { if (!$('#reTmpFrom', d).value) return C.toast('Pick the first day they cover'); addAsg($('#reTmpWho', d).value, $('#reTmpFrom', d).value, $('#reTmpTo', d).value); };
  $$('[data-rmasg]', d).forEach((b) => (b.onclick = async () => {
    const { error } = await sb.from('route_assignments').delete().eq('id', b.dataset.rmasg); if (error) return C.fail(error);
    d.close(); const { data: fresh } = await sb.from('routes').select('*').eq('id', r.id).single(); editRoute(fresh, done);
  }));
  $('#reSave', d).onclick = async () => { const id = await save(); if (!id) return; d.close(); C.toast('Saved'); done(id); };
  if ($('#reArch', d)) $('#reArch', d).onclick = async () => {
    if (!confirm('Archive this route? It stops running. Its history stays.')) return;
    const { error } = await sb.from('routes').update({ archived_at: new Date().toISOString(), active: false }).eq('id', r.id); if (error) return C.fail(error);
    d.close(); C.go('routes');
  };
}

// one route: today's board, then its stops
let boardDay = null;
async function viewRoute(main, id) {
  const { data: r, error } = await sb.from('routes').select('*').eq('id', id).maybeSingle();
  if (error || !r) { main.innerHTML = '<p class="empty">That route isn\'t here.</p>'; return; }
  const manage = canManage();
  const [{ data: b, error: be }, { data: stops }] = await Promise.all([
    manage ? sb.rpc('route_board', { p_route: id, p_date: boardDay }) : { data: null },
    sb.from('route_stops').select('*, companies(id,name,city,state)').eq('route_id', id).is('archived_at', null).order('sort'),
  ]);
  if (be) return C.fail(be);
  const run = b?.run;
  const ppl = people();
  main.innerHTML = `<div class="toolbar"><button class="btn ghost small" id="rtBack">← Routes</button><h1 style="flex:1;margin:0 8px">${esc(r.name)} <span class="badge gold">Beta</span></h1>
      ${manage ? '<button class="btn secondary small" id="rtEdit">Edit</button>' : ''}</div>
    <p class="hint" style="margin-top:0">${esc(scheduleText(r))}${r.dispatcher_id ? ' · Dispatcher ' + esc(C.userName(r.dispatcher_id)) : ''}${r.active ? '' : ' · Paused'}</p>
    ${manage ? `<div class="card"><div class="toolbar"><h2 style="margin:0;flex:1">Day board</h2><input type="date" id="rtDay" value="${esc(b.date)}" aria-label="Day"></div>
      ${!run ? '<p class="empty">This route doesn\'t run that day.</p>' : `
      <p><span class="badge ${run.status === 'scheduled' && run.alerted ? 'due' : run.status === 'done' ? 'ok' : ''}">${esc(STATUS[run.status] || run.status)}</span>
        Starts ${esc(new Date(run.starts_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))} · ${esc((run.people || []).map(C.userName).filter(Boolean).join(', ') || 'Nobody assigned')}
        ${(run.late_users || []).length ? ` · Late: ${esc(run.late_users.map(C.userName).join(', '))}` : ''}${run.note ? ` · ${esc(run.note)}` : ''}</p>
      <div class="actions">
        ${['scheduled', 'late', 'started'].includes(run.status) ? `<button class="btn small secondary" id="rbSplit">Split up for the day</button>
          <button class="btn small secondary" id="rbLate">Mark someone late</button><button class="btn small secondary" id="rbPush">Push to tomorrow</button>
          <button class="btn small ghost" id="rbDismiss">Dismiss today</button>` : ''}
        ${['dismissed', 'pushed'].includes(run.status) ? '<button class="btn small ghost" id="rbUndo">Undo</button>' : ''}</div>
      <ol class="rtstops">${run.stops.map((s) => `<li><b>${esc(s.company)}</b>${s.label ? ' · ' + esc(s.label) : ''} ${STOP[s.status] ? `<span class="badge ${s.status === 'incomplete' ? 'due' : s.status === 'done' ? 'ok' : ''}">${esc(STOP[s.status])}</span>` : ''}
          ${s.far ? '<span class="badge due" title="Tapped far from the stop">Far from the stop</span>' : ''}${s.user_id ? ` <span class="badge">${esc(C.userName(s.user_id))}</span>` : ''}
          ${s.reason ? `<div><small>Why: ${esc(s.reason)}</small></div>` : ''}${(s.media || []).length ? `<div><button type="button" class="linkish" data-media="${esc(s.id)}">See ${s.media.length} photo/video${s.media.length === 1 ? '' : 's'}</button></div>` : ''}</li>`).join('') || '<li class="empty">No stops.</li>'}</ol>`}
      ${(b.exceptions || []).length ? `<h3>Location reports to approve</h3>${b.exceptions.map((e) => `<div class="person-row"><b>${esc(e.company)}</b> · ${esc(C.userName(e.user_id))} · ${e.scope === 'permanent' ? 'Move the stop for good' : 'Just this time'}
          ${e.feet != null ? ` · ${esc(e.feet)} ft from the pin` : ''}<div><small>${esc(e.reason)}</small></div>
          <div class="actions">${e.lat != null ? `<a class="btn small ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lng}">See where they were</a>` : ''}
          <button class="btn small" data-exok="${e.id}">Approve</button><button class="btn small secondary" data-exno="${e.id}">Deny</button></div></div>`).join('')}` : ''}</div>` : ''}
    <div class="card"><h2>Stops (${(stops || []).length})</h2>
      ${manage && (stops || []).length > 1 ? '<p class="hint" style="margin:0">Drag ⠿ to put the stops in order (or use the arrows).</p>' : ''}
      <ol class="rtstops" id="rtStopList">${(stops || []).map((s, i) => `<li data-sid="${s.id}">${manage ? '<span class="rtgrip" aria-hidden="true" title="Drag to reorder">⠿</span>' : ''}<b><a href="#org/${s.company_id}">${esc(s.companies?.name || '')}</a></b>${s.label ? ' · ' + esc(s.label) : ''}
          <small> ${esc([s.companies?.city, s.companies?.state].filter(Boolean).join(', '))}</small>${s.request ? `<div><small>${esc(s.request)}</small></div>` : ''}
          ${manage ? `<span class="rtmove"><button type="button" class="linkish" data-up="${i}" ${i ? '' : 'disabled'} aria-label="Move up">↑</button><button type="button" class="linkish" data-dn="${i}" ${i < stops.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button>
          <button type="button" class="linkish" data-sedit="${s.id}">Edit</button><button type="button" class="linkish" data-srm="${s.id}">Remove</button></span>` : ''}</li>`).join('') || '<li class="empty">No stops yet.</li>'}</ol>
      ${manage ? `<label class="label">Add a customer</label><div id="stOrg"></div>
        <label class="label" for="stReq">What to do there</label><input type="text" id="stReq" maxlength="2000" placeholder="Empty the bins, check the gate">
        <div class="actions"><button class="btn small" id="stAdd">Add stop</button></div>
        <small class="hint">You can also add stops from a customer's page. One customer can be on many routes, and more than once.</small>` : ''}</div>`;
  $('#rtBack').onclick = () => { boardDay = null; C.go('routes'); };
  if (!manage) return;
  const again = () => viewRoute(main, id);
  $('#rtEdit').onclick = () => editRoute(r, again);
  $('#rtDay').onchange = (e) => { boardDay = e.target.value || null; again(); };
  const act = async (action, p = {}) => { const { data, error: e } = await sb.rpc('route_run_action', { p_run: run.id, p_action: action, p }); if (e) { C.fail(e); return null; } return data || {}; };
  if ($('#rbSplit')) $('#rbSplit').onclick = () => {
    const d = dlg(`<h2 style="margin-top:0">Split up ${esc(r.name)} for ${esc(b.date)}</h2><p class="hint">Pick who does each stop today. Blank means anyone on the route. Only today changes.</p>
      ${run.stops.map((s) => `<div class="row"><div><b>${esc(s.company)}</b></div><div>${sel('sp_' + s.id, [['', 'Anyone on the route'], ...ppl.map((u) => [u.id, u.full_name])], s.user_id || '', `data-sp="${s.id}"`)}</div></div>`).join('')}
      <div class="actions"><button class="btn" id="spSave">Save</button><button class="btn ghost" id="spX">Cancel</button></div>`);
    $('#spX', d).onclick = () => d.close();
    $('#spSave', d).onclick = async () => { const assign = {}; $$('[data-sp]', d).forEach((s) => (assign[s.dataset.sp] = s.value)); if (await act('split', { assign })) { d.close(); C.toast('Split saved. They were notified.'); again(); } };
  };
  if ($('#rbLate')) $('#rbLate').onclick = () => {
    const d = dlg(`<h2 style="margin-top:0">Who's running late?</h2>${sel('lateWho', (run.people?.length ? run.people.map((u) => [u, C.userName(u)]) : ppl.map((u) => [u.id, u.full_name])), '')}
      <label class="label" for="lateNote">Note (optional)</label><input type="text" id="lateNote" placeholder="Truck trouble, there by 9">
      <div class="actions"><button class="btn" id="lateOk">Mark late</button><button class="btn ghost" id="lateX">Cancel</button></div><small class="hint">This stops the alerts for today.</small>`);
    $('#lateX', d).onclick = () => d.close();
    $('#lateOk', d).onclick = async () => { if (await act('late', { user: $('#lateWho', d).value, note: $('#lateNote', d).value })) { d.close(); again(); } };
  };
  if ($('#rbDismiss')) $('#rbDismiss').onclick = async () => { const note = prompt('Dismiss today\'s run? Say why (optional).'); if (note === null) return; if (await act('dismiss', { note })) again(); };
  if ($('#rbUndo')) $('#rbUndo').onclick = async () => { if (await act('undo')) again(); };
  if ($('#rbPush')) $('#rbPush').onclick = async () => {
    if (!confirm(`Push ${r.name} to tomorrow? Unfinished stops move to tomorrow's run.`)) return;
    const res = await act('push'); if (!res) return;
    const cs = res.customers || [];
    const d = dlg(`<h2 style="margin-top:0">Send notifications to these customers now?</h2>
      ${cs.map((c) => `<label class="check"><input type="checkbox" data-cust="${c.company_id}" ${c.emails.length ? 'checked' : 'disabled'}> <b>${esc(c.company)}</b> <small>${c.emails.length ? esc(c.emails.map((e) => e.email).join(', ')) : 'no email on file (primary contact or decision maker)'}</small></label>`).join('') || '<p class="empty">No customers on the route.</p>'}
      <label class="label" for="pnSubj">Subject</label><input type="text" id="pnSubj" value="A change to your service day">
      <label class="label" for="pnBody">Message</label><textarea id="pnBody" rows="5">Hi {company},\n\nWe had to move today's visit to tomorrow. Sorry for the change, and thanks for understanding.\n\n${esc(S.acct?.name || '')}</textarea>
      <small class="hint">{company} becomes each customer's name. It goes on each customer's activity too.</small>
      <div class="actions"><button class="btn" id="pnSend">Send now</button><button class="btn ghost" id="pnSkip">Not now</button></div>`);
    $('#pnSkip', d).onclick = () => { d.close(); again(); };
    $('#pnSend', d).onclick = async () => {
      const ids = $$('[data-cust]', d).filter((c) => c.checked).map((c) => c.dataset.cust); if (!ids.length) { d.close(); return again(); }
      const { data: n, error: e } = await sb.rpc('route_notify_customers', { p_run: run.id, p_subject: $('#pnSubj', d).value, p_body: $('#pnBody', d).value, p_companies: ids });
      if (e) return C.fail(e); d.close(); C.toast(`Sent ${n} email${n === 1 ? '' : 's'}`); again();
    };
  };
  $$('[data-exok],[data-exno]', main).forEach((x) => (x.onclick = async () => {
    const { error: e } = await sb.rpc('route_exception_decide', { p_id: x.dataset.exok || x.dataset.exno, p_approve: !!x.dataset.exok }); if (e) return C.fail(e);
    C.toast(x.dataset.exok ? 'Approved' : 'Denied'); again();
  }));
  $$('[data-media]', main).forEach((x) => (x.onclick = () => showMedia(run.stops.find((s) => s.id === x.dataset.media).media)));
  const order = async (from, to) => { const ids = stops.map((s) => s.id); const [m] = ids.splice(from, 1); ids.splice(to, 0, m); const { error: e } = await sb.rpc('route_stops_order', { p_route: id, p_ids: ids }); if (e) return C.fail(e); again(); };
  $$('[data-up]', main).forEach((x) => (x.onclick = () => order(+x.dataset.up, +x.dataset.up - 1)));
  dragSort($('#rtStopList', main), async (ids) => {
    const { error: e } = await sb.rpc('route_stops_order', { p_route: id, p_ids: ids }); if (e) return C.fail(e);
    C.toast('Order saved'); again();
  });
  $$('[data-dn]', main).forEach((x) => (x.onclick = () => order(+x.dataset.dn, +x.dataset.dn + 1)));
  $$('[data-srm]', main).forEach((x) => (x.onclick = async () => {
    if (!confirm('Take this stop off the route? Past visits stay in the history.')) return;
    const { error: e } = await sb.from('route_stops').update({ archived_at: new Date().toISOString() }).eq('id', x.dataset.srm); if (e) return C.fail(e); again();
  }));
  $$('[data-sedit]', main).forEach((x) => (x.onclick = () => stopEditor(stops.find((s) => s.id === x.dataset.sedit), again)));
  let cust = { id: null, name: '' };
  C.FLD.coPicker($('#stOrg'), cust, (c) => { cust = c; });
  $('#stAdd').onclick = async () => {
    if (!cust.id) return C.toast('Pick a customer (an organization or a person)');
    const { error: e } = await sb.from('route_stops').insert({ route_id: id, company_id: cust.id, request: $('#stReq').value.trim() || null, sort: (stops || []).length + 1 });
    if (e) return C.fail(e); C.toast('Stop added'); again();
  };
}

// drag a list item by its ⠿ grip to reorder (mouse, touch and pen); done(ids) gets the new order of data-sid
function dragSort(list, done) {
  if (!list) return;
  $$('.rtgrip', list).forEach((grip) => {
    grip.onpointerdown = (e) => {
      e.preventDefault();
      const li = grip.closest('li'), start = [...list.children].map((x) => x.dataset.sid).join();
      li.classList.add('dragging');
      const move = (ev) => {
        const sibs = [...list.children].filter((x) => x !== li && x.dataset.sid);
        const after = sibs.find((x) => { const r = x.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
        if (after) list.insertBefore(li, after); else list.appendChild(li);
        if (ev.clientY < 60) scrollBy(0, -12); else if (ev.clientY > innerHeight - 60) scrollBy(0, 12);
      };
      const up = () => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
        li.classList.remove('dragging');
        const ids = [...list.children].map((x) => x.dataset.sid).filter(Boolean);
        if (ids.join() !== start) done(ids);
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
    };
  });
}

async function showMedia(paths) {
  const { data } = await sb.storage.from('job-photos').createSignedUrls(paths, 3600);
  const d = dlg(`<h2 style="margin-top:0">Photos and videos</h2><div class="rtmedia">${(data || []).filter((x) => x.signedUrl).map((x) => /\.(mp4|mov|webm|m4v|3gp)$/i.test(x.path)
    ? `<video src="${esc(x.signedUrl)}" controls playsinline></video>` : `<a href="${esc(x.signedUrl)}" target="_blank" rel="noopener"><img src="${esc(x.signedUrl)}" alt="Photo from the stop"></a>`).join('')}</div>
    <div class="actions"><button class="btn ghost" id="mdX">Close</button></div>`);
  $('#mdX', d).onclick = () => d.close();
}

// a stop's details: what to do, label, which pin
async function stopEditor(s, done) {
  const { data: pins } = await sb.from('location_pins').select('id,label,is_primary').eq('company_id', s.company_id).is('archived_at', null).order('is_primary', { ascending: false });
  const d = dlg(`<h2 style="margin-top:0">${esc(s.companies?.name || 'Stop')}</h2>
    <label class="label" for="seLbl">Label (optional, like "Back dock")</label><input type="text" id="seLbl" maxlength="80" value="${esc(s.label || '')}">
    <label class="label" for="seReq">What to do there</label><textarea id="seReq" rows="3">${esc(s.request || '')}</textarea>
    <label class="label" for="sePin">Location</label>${sel('sePin', [['', s.lat != null ? 'Its own spot (set from a location report)' : 'The customer\'s main pin'], ...(pins || []).map((p) => [p.id, p.label + (p.is_primary ? ' (main)' : '')])], s.pin_id || '')}
    ${(pins || []).length ? '' : '<small class="hint">This customer has no pin yet. Arrived and Left still work; they just can\'t check distance until there is one.</small>'}
    <div class="actions"><button class="btn" id="seOk">Save</button><button class="btn ghost" id="seX">Cancel</button></div>`);
  $('#seX', d).onclick = () => d.close();
  $('#seOk', d).onclick = async () => {
    const pin = $('#sePin', d).value || null;
    const { error } = await sb.from('route_stops').update({ label: $('#seLbl', d).value.trim() || null, request: $('#seReq', d).value.trim() || null, pin_id: pin, ...(pin ? { lat: null, lng: null } : {}) }).eq('id', s.id);
    if (error) return C.fail(error); d.close(); done();
  };
}

/* ================= a customer's page: their stops ================= */
export async function orgCard(box, companyId) {
  if (!box) return;
  if (!feat()) { box.innerHTML = ''; return; }
  const [{ data: stops }, { data: routes }] = await Promise.all([
    sb.from('route_stops').select('id,route_id,label,request,routes(name,start_time,repeat,days,month_days,every_weeks)').eq('company_id', companyId).is('archived_at', null),
    canManage() ? sb.from('routes').select('id,name').is('archived_at', null).order('name') : { data: [] },
  ]);
  if (!(stops || []).length && !canManage()) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card"><h2>Routes <span class="badge gold">Beta</span></h2>
    ${(stops || []).map((s) => `<div class="person-row"><b><a href="#routes/${s.route_id}">${esc(s.routes?.name || '')}</a></b>${s.label ? ' · ' + esc(s.label) : ''}
      <small> ${esc(s.routes ? scheduleText(s.routes) : '')}</small>${s.request ? `<div><small>${esc(s.request)}</small></div>` : ''}</div>`).join('') || '<p class="empty">Not on any route.</p>'}
    ${canManage() ? ((routes || []).length ? `<details><summary class="linkish">+ Add to a route</summary>
      <div class="row"><div><label class="label" for="ocRt">Route</label>${sel('ocRt', (routes || []).map((r) => [r.id, r.name]), '')}</div>
        <div><label class="label" for="ocLbl">Label (optional)</label><input type="text" id="ocLbl" maxlength="80" placeholder="Back dock"></div></div>
      <label class="label" for="ocReq">What to do there</label><textarea id="ocReq" rows="2"></textarea>
      <div class="actions"><button class="btn small" id="ocAdd">Add stop</button></div></details>` : '<p class="hint"><a href="#routes">Make a route</a> first, then add this customer to it.</p>') : ''}</div>`;
  if ($('#ocAdd', box)) $('#ocAdd', box).onclick = async () => {
    const rid = $('#ocRt', box).value;
    const { count } = await sb.from('route_stops').select('id', { count: 'exact', head: true }).eq('route_id', rid).is('archived_at', null);
    const { error } = await sb.from('route_stops').insert({ route_id: rid, company_id: companyId, label: $('#ocLbl', box).value.trim() || null, request: $('#ocReq', box).value.trim() || null, sort: (count || 0) + 1 });
    if (error) return C.fail(error); C.toast('Added to the route (at the end; reorder it on the route)'); orgCard(box, companyId);
  };
}

/* ================= My Day: my routes today ================= */
export async function myDayBox(box) {
  if (!box) return;
  if (!feat()) { box.innerHTML = ''; return; }
  const { data, error } = await sb.rpc('my_routes');
  if (error || !(data || []).length) { box.innerHTML = ''; return; }
  box.innerHTML = data.map((run) => {
    const live = !['dismissed', 'pushed'].includes(run.status);
    return `<div class="card rtcard"><div class="toolbar"><h2 style="margin:0;flex:1">${esc(run.name)} <span class="badge gold">Beta</span></h2>
      <small>${esc(new Date(run.starts_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))} · ${esc(STATUS[run.status] || '')}</small></div>
      ${!live ? `<p class="empty">${run.status === 'pushed' ? 'Moved to tomorrow.' : 'Called off for today.'}${run.note ? ' ' + esc(run.note) : ''}</p>` : ''}
      <ol class="rtstops">${run.stops.map((s) => `<li class="${s.status}"><b>${esc(s.company)}</b>${s.label ? ' · ' + esc(s.label) : ''} ${STOP[s.status] ? `<span class="badge ${s.status === 'incomplete' ? 'due' : s.status === 'done' ? 'ok' : ''}">${esc(STOP[s.status])}</span>` : ''}
        ${s.address ? `<div><small>${esc(s.address)}</small></div>` : ''}${s.request ? `<div class="rtreq">${esc(s.request)}</div>` : ''}
        ${s.pending_exception ? '<div><small>Location report waiting on your dispatcher.</small></div>' : ''}
        ${live && !['done', 'skipped'].includes(s.status) ? `<div class="actions">
          ${mapLink(s.lat, s.lng, s.address) ? `<a class="btn small ghost" target="_blank" rel="noopener" href="${esc(mapLink(s.lat, s.lng, s.address))}">Directions</a>` : ''}
          ${s.status === 'pending' ? `<button class="btn small" data-tap="arrived" data-rs="${s.id}">Arrived</button>` : `<button class="btn small gold" data-tap="left" data-rs="${s.id}">Left</button>`}
          ${s.status !== 'incomplete' ? `<button class="btn small secondary" data-inc="${s.id}">Can't finish</button>` : ''}</div>` : ''}</li>`).join('')}</ol></div>`;
  }).join('');
  const again = () => myDayBox(box);
  $$('[data-tap]', box).forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    const g = await C.FLD.where();
    const { data: res, error: e } = await sb.rpc('route_stop_tap', { p_run_stop: b.dataset.rs, p_action: b.dataset.tap, p_lat: g?.lat ?? null, p_lng: g?.lng ?? null, p_accuracy: g?.acc ?? null });
    if (e) { b.disabled = false; return C.fail(e); }
    if (res.far) locationWarning(b.dataset.rs, res, g, again);
    else { C.toast(res.no_gps ? `${b.dataset.tap === 'arrived' ? 'Arrived' : 'Left'}, but your phone gave no location. Your dispatcher will see that.` : b.dataset.tap === 'arrived' ? 'Arrived' : 'Left. Nice work.'); again(); }
  }));
  $$('[data-inc]', box).forEach((b) => (b.onclick = () => incomplete(b.dataset.inc, again)));
}

function locationWarning(runStop, res, g, done) {
  const d = dlg(`<h2 style="margin-top:0">You look far from this stop</h2>
    <p>Your phone is about <b>${esc(Number(res.feet).toLocaleString())} feet</b> from where this stop is pinned (it allows ${esc(res.radius)} feet). Your tap was saved, with a warning for your dispatcher.</p>
    <p>If you're in the right place and the pin is wrong, tell your dispatcher:</p>
    <label class="check"><input type="radio" name="lmScope" value="once" checked> Just this time (I'm somewhere else today for a reason)</label>
    <label class="check"><input type="radio" name="lmScope" value="permanent"> For good (the stop is really here; move it)</label>
    <label class="label" for="lmWhy">Why</label><textarea id="lmWhy" rows="2" placeholder="Gate moved to the back street"></textarea>
    <div class="actions"><button class="btn" id="lmSend">Send to dispatcher</button><button class="btn ghost" id="lmX">I'm fine, close</button></div>`);
  $('#lmX', d).onclick = () => { d.close(); done(); };
  $('#lmSend', d).onclick = async () => {
    const why = $('#lmWhy', d).value.trim(); if (why.length < 2) return C.toast('Say why');
    const scope = $$('[name="lmScope"]', d).find((x) => x.checked).value;
    const { error } = await sb.rpc('route_location_report', { p_run_stop: runStop, p_scope: scope, p_reason: why, p_lat: g?.lat ?? null, p_lng: g?.lng ?? null });
    if (error) return C.fail(error); d.close(); C.toast('Sent. Your dispatcher will approve it.'); done();
  };
}

function incomplete(runStop, done) {
  const d = dlg(`<h2 style="margin-top:0">Can't finish this stop</h2>
    <label class="label" for="icWhy">What happened</label><textarea id="icWhy" rows="3" placeholder="Locked out, nobody answered"></textarea>
    <label class="label" for="icFiles">Photos or videos (optional)</label><input type="file" id="icFiles" accept="image/*,video/*" multiple capture="environment">
    <div class="actions"><button class="btn" id="icOk">Save</button><button class="btn ghost" id="icX">Cancel</button></div>
    <small class="hint">Your dispatcher is told right away. Tap Left when you go.</small>`);
  $('#icX', d).onclick = () => d.close();
  $('#icOk', d).onclick = async (e) => {
    const why = $('#icWhy', d).value.trim(); if (why.length < 2) return C.toast('Say what happened');
    e.currentTarget.disabled = true;
    const media = [];
    try { for (const f of $('#icFiles', d).files) { if (f.size > 200 * 1024 * 1024) { C.toast(`${f.name} is over 200 MB; skipped`); continue; } media.push(await upload(f)); } }
    catch (err) { e.currentTarget.disabled = false; return C.fail(err); }
    const { error } = await sb.rpc('route_stop_incomplete', { p_run_stop: runStop, p_reason: why, p_media: media });
    if (error) { e.currentTarget.disabled = false; return C.fail(error); }
    d.close(); C.toast('Saved'); done();
  };
}

/* ================= hourly location while on the clock ================= */
// Only for people an admin turned it on for, only while clocked in, only while the CRM is open. The server keeps at
// most one ping an hour.
let gpsTimer = null;
export function gpsStart() {
  if (gpsTimer || !S.me?.gps_tracking || !C.FLD.feat('timeclock')) return;
  const tick = async () => {
    const { data: open } = await sb.from('time_entries').select('id').eq('user_id', S.me.id).is('clock_out', null).maybeSingle();
    if (!open) return;
    const g = await C.FLD.where(20000); if (!g) return;
    await sb.rpc('gps_ping', { p_lat: g.lat, p_lng: g.lng, p_accuracy: g.acc });
  };
  tick().catch(() => {});
  gpsTimer = setInterval(() => tick().catch(() => {}), 60 * 60 * 1000);
}
