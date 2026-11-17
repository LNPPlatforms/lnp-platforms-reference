/* bids.js: bids. RFPs come in by the account's bid email address or an upload (in the app or a public page), each
   bid gets a go, maybe or no-go from the account's own scorecard, a person can override it with a note (Review by
   default), and bids are tracked from new to won or lost. Won bids turn into a job, an invoice or a proposal.
   Decisions: BACKLOG.md "Oct 30 morning voice decisions", Bids bullet. Database: schema/073*. Plugs into app.js
   through init(ctx) like docs.js and measure.js. */
import * as FLD from './field.js?v=20261116t';
import * as MEA from './measure.js?v=20261116t';
import { money } from './doc/layout.js?v=20261116t';

let C = null, sb, S, esc, $, $$;
export function init(ctx) { C = ctx; ({ sb, S, esc, $, $$ } = ctx); }
const can = (a, l = 1) => FLD.can(a, l);
export const on = () => FLD.feat('bids');
export const canSee = () => on() && can('bids', 1);
export const canEdit = () => on() && can('bids', 2);
export const canApprove = () => on() && (C.isAdmin() || can('bids', 3));
export const canSetup = () => on() && (C.isAdmin() || can('bids', 4));

export const STATUS = [['new', 'New'], ['reviewing', 'Reviewing'], ['go', 'Go'], ['no_go', 'No-go'], ['bidding', 'Bidding'], ['submitted', 'Submitted'], ['won', 'Won'], ['lost', 'Lost'], ['withdrawn', 'Withdrawn']];
const STATUS_NAME = Object.fromEntries(STATUS);
const OPEN = ['new', 'reviewing', 'go', 'bidding', 'submitted'];
const RESULT = { go: ['Go', 'ok'], maybe: ['Maybe', 'gold'], no_go: ['No-go', 'due'] };
const SOURCE = { manual: 'Added by hand', upload: 'Uploaded', public: 'Upload page', email: 'Emailed in' };
const KINDS = {
  value: { label: 'Job size', unit: '$', good: 50000, poor: 5000, what: 'Bigger jobs score higher' },
  distance: { label: 'Distance from the shop', unit: 'miles', good: 25, poor: 100, what: 'Closer scores higher (from your base address)' },
  margin: { label: 'Expected margin', unit: '%', good: 30, poor: 10, what: 'More margin scores higher' },
  crew: { label: 'Crew free in the work window', what: 'Someone answers yes, tight or no on each bid' },
  lead_time: { label: 'Time to prepare', unit: 'days', good: 14, poor: 3, what: 'Days from when it came in to when it\'s due' },
};
const BUILT = Object.keys(KINDS);
const finalResult = (b) => b.override_result || b.result;
const badge = (r, big) => (r && RESULT[r] ? `<span class="badge ${RESULT[r][1]}"${big ? ' style="font-size:15px;padding:4px 12px"' : ''}>${RESULT[r][0]}</span>` : '<span class="badge">Not scored</span>');
const rid = () => Math.random().toString(36).slice(2, 10);
const fmtDue = (d) => (d ? new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const daysLeft = (d) => (d ? Math.ceil((new Date(d) - Date.now()) / 86400000) : null);
const localInput = (s) => { if (!s) return ''; const d = new Date(s); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(/[$,%\s]/g, '')));
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
function css() {
  if (cssOn) return; cssOn = true;
  const s = document.createElement('style');
  s.textContent = `.list .item.bidrow,.bidrow{display:flex;gap:12px;align-items:center;text-align:left}.bidrow .bscore{min-width:54px;flex:none;text-align:center;font-weight:700;font-size:20px;line-height:1.1}
.bidrow .bscore small{display:block;font-weight:400;font-size:11px;color:var(--muted)}
.bidhead{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.bidhead .bigscore{font-size:34px;font-weight:800;line-height:1}
.bparts{width:100%;border-collapse:collapse}.bparts td{padding:7px 4px;border-bottom:1px solid var(--line);vertical-align:middle}.bparts .num{text-align:right;white-space:nowrap}
.bparts select{margin:0;min-width:110px}.pbar{display:inline-block;width:60px;height:8px;border-radius:4px;background:#e6e9ef;vertical-align:middle;overflow:hidden}.pbar i{display:block;height:100%;background:#2A6B4F}
.mrow{display:grid;grid-template-columns:28px 2fr 110px 2fr 80px;gap:6px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}
.mrow input,.mrow select{margin:0}.mrow input[type=checkbox]{width:20px;height:20px}.mrow .mgp{display:flex;gap:6px;min-width:0}.mrow .mgp>*{flex:1;min-width:0}.mrow .mwhat{grid-column:2/-1;font-size:12px;color:var(--muted);margin-top:-4px}
.mhead{font-size:12px;color:var(--muted);border:0;padding:0}
.bfiles .listrow{gap:8px}.addr{display:flex;gap:6px}.addr input{flex:1;margin:0}
.bhist{font-size:13px;color:var(--muted);margin:0;padding-left:18px}
@media (max-width:640px){.mrow{grid-template-columns:28px 1fr 80px}.mrow .mgp{grid-column:2/-1;display:flex;gap:6px}.mhead{display:none}}`;
  document.head.appendChild(s);
}

/* ================= navigation pieces ================= */
export const drawerItems = () => ({
  admin: [{ id: 'bidsetup', label: 'Bids', match: ['bidsetup'], what: 'Your go or no-go scorecard, base address, bid email address and upload page', when: () => canSetup() }],
});
export const views = () => ({ bids: viewBids, bid: viewBid, bidsetup: viewSetup });
export const parents = { bids: 'sales', bid: 'bids', bidsetup: 'tools' };
export const guards = { bids: () => canSee(), bid: () => canSee(), bidsetup: () => canSetup() };
export const divider = { id: 'bids', label: 'Bids', match: ['bids', 'bid'], when: () => canSee() };

let SET = null;
async function settings(force) {
  if (SET && !force) return SET;
  const { data, error } = await sb.rpc('bid_settings_get');
  if (error) return null;
  SET = data || { metrics: [], go_at: 70, maybe_at: 45 };
  return SET;
}
const noDb = (main, h) => { main.innerHTML = `<h1>${h}</h1><p class="empty">Bids need the October 30 database update. Once it's applied, this works.</p>`; };

/* ================= files ================= */
async function uploadFiles(bidId, files) {
  let n = 0;
  for (const f of files) {
    if (f.size > 50 * 1024 * 1024) { C.toast(`${f.name} is over 50 MB, skipped`, { error: true }); continue; }
    const path = `${S.acct.id}/${bidId}/${rid()}-${f.name.replace(/[^\w.\- ]+/g, '_').slice(-120)}`;
    const { error } = await sb.storage.from('bid-files').upload(path, f, { contentType: f.type || 'application/octet-stream', upsert: false });
    if (error) { C.fail(error); continue; }
    const { error: e2 } = await sb.from('bid_files').insert({ bid_id: bidId, path, name: f.name, size: f.size, mime: f.type || null });
    if (e2) { C.fail(e2); continue; }
    n++;
  }
  return n;
}
const size = (b) => (b == null ? '' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');

/* ================= the list ================= */
let FILTER = 'open';
async function viewBids(main) {
  css();
  const [{ data, error }, set] = await Promise.all([
    sb.from('bids').select('id,title,client_name,company_id,status,source,due_at,score,result,override_result,review_state,est_value,submitted_amount,created_at,owner_id,companies(name)')
      .is('archived_at', null).order('created_at', { ascending: false }).limit(500),
    settings(true)]);
  if (error || !set) return noDb(main, 'Bids');
  const all = data || [];
  const pick = { open: (b) => OPEN.includes(b.status), all: () => true, ...Object.fromEntries(STATUS.map(([k]) => [k, (b) => b.status === k])) };
  const rows = all.filter(pick[FILTER] || pick.open).sort((a, b) => (OPEN.includes(a.status) && OPEN.includes(b.status) ? String(a.due_at || '9').localeCompare(String(b.due_at || '9')) : 0));
  const won = all.filter((b) => b.status === 'won'), lost = all.filter((b) => b.status === 'lost');
  const rate = won.length + lost.length ? Math.round((100 * won.length) / (won.length + lost.length)) : null;
  const dueSoon = all.filter((b) => OPEN.includes(b.status) && b.due_at && daysLeft(b.due_at) >= 0 && daysLeft(b.due_at) <= 7).length;
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Bids</h1>
      ${canSetup() ? '<button class="btn ghost small" data-nav="bidsetup">Scorecard and setup</button>' : ''}${canEdit() ? '<button class="btn small" id="bNew">Add a bid</button>' : ''}</div>
    ${set.email_address ? `<p class="hint">Forward RFPs to <b>${esc(set.email_address)}</b> and they show up here with their files.</p>`
      : canSetup() && !set.email_ready ? '<p class="hint">The bid email address turns on once email intake is set up for the platform. Uploads work now.</p>' : ''}
    ${!set.metrics?.length && canSetup() ? '<p class="banner warn">Set up your scorecard so each bid gets a go, maybe or no-go. <button class="btn small" data-nav="bidsetup">Set it up</button></p>' : ''}
    <div class="dtiles"><div class="dtile"><b>${all.filter(pick.open).length}</b><span>Open</span></div><div class="dtile ${dueSoon ? 'hot' : ''}"><b>${dueSoon}</b><span>Due in 7 days</span></div>
      <div class="dtile"><b>${rate == null ? '-' : rate + '%'}</b><span>Win rate (${won.length} won, ${lost.length} lost)</span></div>
      <div class="dtile"><b>${esc('$' + Math.round(won.reduce((a, b) => a + Number(b.submitted_amount || 0), 0)).toLocaleString('en-US'))}</b><span>Won</span></div></div>
    <div class="chips" style="margin:12px 0">${[['open', 'Open'], ...STATUS, ['all', 'All']].map(([k, n]) => `<button type="button" class="chip ${FILTER === k ? 'on' : ''}" data-f="${k}">${n} (${all.filter(pick[k]).length})</button>`).join('')}</div>
    <div class="list">${rows.map((b) => { const r = finalResult(b), dl = daysLeft(b.due_at);
      return `<button class="item bidrow" data-bid="${b.id}"><span class="bscore">${b.score == null ? '-' : Math.round(b.score)}<small>score</small></span>
        <span style="flex:1;min-width:0"><b>${esc(b.title)}</b> ${badge(r)}${b.override_result ? ' <span class="badge">overridden</span>' : ''}${b.review_state === 'pending' ? ' <span class="badge gold">in Review</span>' : ''}
        <small style="display:block">${esc([b.client_name || b.companies?.name, STATUS_NAME[b.status], b.due_at ? `due ${fmtDue(b.due_at)}${OPEN.includes(b.status) && dl != null ? (dl < 0 ? ' (past due)' : dl === 0 ? ' (today)' : ` (${dl} ${dl === 1 ? 'day' : 'days'})`) : ''}` : '', b.est_value ? money(b.est_value) : '', SOURCE[b.source]].filter(Boolean).join(' · '))}</small></span></button>`; }).join('')
      || `<p class="empty">No bids here.${canEdit() ? ' Add one by hand or upload the RFP.' : ''}</p>`}</div>`;
  $$('[data-f]', main).forEach((b) => (b.onclick = () => { FILTER = b.dataset.f; viewBids(main); }));
  $$('[data-bid]', main).forEach((b) => (b.onclick = () => C.go('bid', b.dataset.bid)));
  $$('[data-nav]', main).forEach((b) => (b.onclick = () => C.go(b.dataset.nav)));
  if ($('#bNew')) $('#bNew').onclick = () => newBid();
}

function newBid() {
  const d = dlg('bidNew', `<div class="vhead"><h2 style="margin:0">Add a bid</h2><button class="btn ghost small" data-x>Close</button></div>
    <label class="label" for="nbT">What it is</label><input type="text" id="nbT" maxlength="200" placeholder="Mall lot reseal and restripe">
    <div class="row"><div><label class="label" for="nbC">Who it's for</label><input type="text" id="nbC" maxlength="200" placeholder="Edgewater Mall"></div>
      <div><label class="label" for="nbD">Due</label><input type="datetime-local" id="nbD"></div></div>
    <label class="label" for="nbF">RFP and plans (optional)</label><input type="file" id="nbF" multiple>
    <div class="actions"><button class="btn" id="nbGo">Add it</button></div>`);
  $('[data-x]', d).onclick = () => d.close();
  $('#nbT', d).focus();
  $('#nbGo', d).onclick = async (e) => {
    const title = $('#nbT', d).value.trim(); if (!title) return C.toast('Say what the bid is first');
    const files = [...($('#nbF', d).files || [])];
    e.target.disabled = true; e.target.textContent = files.length ? 'Uploading…' : 'Adding…';
    const due = $('#nbD', d).value;
    const { data, error } = await sb.from('bids').insert({ title, client_name: $('#nbC', d).value.trim() || null, due_at: due ? new Date(due).toISOString() : null, source: files.length ? 'upload' : 'manual' }).select('id').single();
    if (error) { e.target.disabled = false; e.target.textContent = 'Add it'; return C.fail(error); }
    if (files.length) await uploadFiles(data.id, files);
    d.close(); C.toast('Bid added'); C.go('bid', data.id);
  };
}

/* ================= one bid ================= */
async function viewBid(main) {
  css();
  const id = S.param;
  const [{ data: b, error }, set, { data: files }, { data: cos }] = await Promise.all([
    sb.from('bids').select('*').eq('id', id).maybeSingle(), settings(true),
    sb.from('bid_files').select('*').eq('bid_id', id).is('archived_at', null).order('created_at'),
    sb.from('companies').select('id,name,address,city,state,zip').is('archived_at', null).order('name').limit(1000)]);
  if (error || !set) return noDb(main, 'Bid');
  if (!b) { main.innerHTML = '<h1>Bid</h1><p class="empty">That bid isn\'t here, or it\'s someone else\'s.</p>'; return; }
  const edit = canEdit() && !b.archived_at;
  const dis = edit ? '' : 'disabled';
  const co = (cos || []).find((c) => c.id === b.company_id) || null;
  const metrics = (set.metrics || []).filter((m) => !m.off);
  const parts = Object.fromEntries((b.score_parts || []).map((p) => [p.key, p]));
  const r = finalResult(b);
  const { data: meas } = b.measurement_id ? await sb.from('measurements').select('id,name,summary,picture_url').eq('id', b.measurement_id).maybeSingle() : { data: null };
  const priced = (b.price_lines || []).reduce((a, l) => a + Number(l.qty || 0) * Number(l.price || 0), 0);
  const answer = (m) => {
    const a = b.answers?.[m.key] ?? '';
    if (m.kind === 'crew') return `<select data-ans="${m.key}" ${dis}><option value="">Not answered</option>${[['yes', 'Yes, free'], ['tight', 'Tight'], ['no', 'No']].map(([v, n]) => `<option value="${v}" ${a === v ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
    if (m.kind === 'yesno') return `<select data-ans="${m.key}" ${dis}><option value="">Not answered</option><option value="yes" ${a === 'yes' ? 'selected' : ''}>Yes</option><option value="no" ${a === 'no' ? 'selected' : ''}>No</option></select>`;
    if (m.kind === 'scale') return `<select data-ans="${m.key}" ${dis}><option value="">Not answered</option>${[1, 2, 3, 4, 5].map((v) => `<option value="${v}" ${String(a) === String(v) ? 'selected' : ''}>${v}${v === 1 ? ' (poor)' : v === 5 ? ' (great)' : ''}</option>`).join('')}</select>`;
    const p = parts[m.key]; const v = p?.value;
    return v == null ? `<small class="hint" style="margin:0">${m.kind === 'distance' ? (b.site_address ? 'Find the site address below' : 'Add the site address below') : m.kind === 'lead_time' ? 'Add the due date' : 'Fill it in below'}</small>`
      : esc(m.kind === 'value' ? money(v) : m.kind === 'margin' ? v + '%' : m.kind === 'distance' ? v + ' miles' : v + ' days');
  };
  const hist = (b.history || []).slice(-12).reverse().map((h) => `<li>${esc(C.fmtDate(h.at))}: ${esc(C.userName(h.by) || 'Someone')} ${esc(
    h.what === 'status' ? `moved it from ${STATUS_NAME[h.from] || h.from} to ${STATUS_NAME[h.to] || h.to}` : h.what === 'override' ? `overrode ${RESULT[h.from]?.[0] || 'no score'} to ${RESULT[h.to]?.[0]}: "${h.note}"`
      : h.what === 'override_approved' ? 'approved the override' : h.what === 'override_returned' ? `sent the override back${h.note ? `: "${h.note}"` : ''}` : h.what === 'override_cleared' ? 'took the override off'
      : h.what === 'converted' ? `made a ${h.kind} from it` : h.what)}</li>`).join('');
  main.innerHTML = `<div class="toolbar"><button class="btn ghost small" data-nav="bids">‹ Bids</button><span style="flex:1"></span>
      ${edit ? `<select id="bStatus" aria-label="Status" style="margin:0;width:auto">${STATUS.map(([k, n]) => `<option value="${k}" ${b.status === k ? 'selected' : ''}>${n}</option>`).join('')}</select>` : `<span class="badge">${esc(STATUS_NAME[b.status])}</span>`}</div>
    <div class="card"><div class="bidhead"><span class="bigscore">${b.score == null ? '-' : Math.round(b.score)}</span><div style="flex:1;min-width:180px"><h1 style="margin:0">${esc(b.title)}</h1>
      <div>${badge(r, true)} ${b.override_result ? `<span class="badge">overridden from ${esc(RESULT[b.result]?.[0] || 'not scored')}</span>` : ''} ${b.review_state === 'pending' ? '<span class="badge gold">waiting in Review</span>' : b.review_state === 'returned' ? '<span class="badge due">override sent back</span>' : ''}</div>
      <small class="hint" style="margin:4px 0 0">${esc([SOURCE[b.source], 'added ' + C.fmtDate(b.created_at), b.owner_id ? C.userName(b.owner_id) : ''].filter(Boolean).join(' · '))}</small></div></div>
      ${b.override_result ? `<p style="margin:8px 0 0">${esc(C.userName(b.override_by) || 'Someone')}: “${esc(b.override_note || '')}”</p>` : ''}
      ${b.review_state === 'returned' && b.review_note ? `<p class="hint">Sent back: “${esc(b.review_note)}”</p>` : ''}</div>

    <div class="card"><h2>Go or no-go</h2>
      ${metrics.length ? `<table class="bparts"><tbody>${metrics.map((m) => { const p = parts[m.key];
        return `<tr><td><b>${esc(m.label)}</b><small style="display:block" class="hint">Rank ${m.rank}</small></td><td>${answer(m)}</td>
          <td class="num">${p?.points != null ? `<span class="pbar" title="${p.points} of 5"><i style="width:${Math.round(((p.points - 1) / 4) * 100)}%"></i></span> ${Number(p.points).toFixed(1)}` : '<small class="hint">-</small>'}</td></tr>`; }).join('')}</tbody></table>
        <p class="hint">Go at ${esc(set.go_at)} or more, maybe at ${esc(set.maybe_at)}. Rank 1 counts three times as much as rank 3. Only answered items count.</p>`
        : `<p class="empty">No scorecard yet.${canSetup() ? ' <button class="btn small" data-nav="bidsetup">Set it up</button>' : ' Ask your admin to set one up.'}</p>`}
      ${edit ? `<details><summary><b>${b.override_result ? 'Change the override' : 'Override the result'}</b></summary>
        <div class="row"><div><label class="label" for="oRes">Make it</label><select id="oRes"><option value="go">Go</option><option value="maybe">Maybe</option><option value="no_go">No-go</option></select></div></div>
        <label class="label" for="oNote">Why (required)</label><textarea id="oNote" maxlength="2000" placeholder="The GM asked for us by name"></textarea>
        ${set.override_review && !canApprove() ? '<p class="hint">Your override goes to Review for a yes.</p>' : ''}
        <div class="actions"><button class="btn small" id="oGo">Save the override</button>${b.override_result ? '<button class="btn ghost small" id="oClr">Take the override off</button>' : ''}</div></details>` : ''}</div>

    <div class="card"><h2>Details</h2>
      <label class="label" for="bT">What it is</label><input type="text" id="bT" maxlength="200" value="${esc(b.title)}" ${dis}>
      <div class="row"><div><label class="label" for="bC">Who it's for</label><input type="text" id="bC" maxlength="200" value="${esc(b.client_name || '')}" ${dis}></div>
        <div><label class="label" for="bCo">${esc(FLD.L('organization'))}</label><select id="bCo" ${dis}><option value="">None yet</option>${(cos || []).map((c) => `<option value="${c.id}" ${c.id === b.company_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div></div>
      ${canApprove() ? `<label class="label" for="bOwn">Whose bid</label><select id="bOwn" ${dis}><option value="">Nobody</option>${C.staff().map((u) => `<option value="${u.id}" ${u.id === b.owner_id ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}</select>` : ''}
      <div class="row"><div><label class="label" for="bDue">Due</label><input type="datetime-local" id="bDue" value="${esc(localInput(b.due_at))}" ${dis}></div>
        <div><label class="label" for="bWs">Work starts</label><input type="date" id="bWs" value="${esc(b.window_start || '')}" ${dis}></div>
        <div><label class="label" for="bWe">Work ends</label><input type="date" id="bWe" value="${esc(b.window_end || '')}" ${dis}></div></div>
      <div class="row"><div><label class="label" for="bVal">Job size ($)</label><input type="text" inputmode="decimal" id="bVal" value="${esc(b.est_value ?? '')}" placeholder="0" ${dis}></div>
        <div><label class="label" for="bMar">Expected margin (%)</label><input type="text" inputmode="decimal" id="bMar" value="${esc(b.est_margin ?? '')}" placeholder="25" ${dis}></div>
        <div><label class="label" for="bSub">Submitted amount ($)</label><input type="text" inputmode="decimal" id="bSub" value="${esc(b.submitted_amount ?? '')}" ${dis}></div></div>
      <label class="label" for="bAddr">Job site address</label><div class="addr"><input type="text" id="bAddr" maxlength="300" value="${esc(b.site_address || '')}" placeholder="2600 Beach Blvd, Biloxi, MS" ${dis}></div>
      <small class="hint" style="margin:2px 0 0">${b.distance_mi != null ? `${esc(b.distance_mi)} miles from your base, straight line.` : b.site_lat != null && !set.base_lat ? 'Set your base address in Bids setup to get the distance.' : b.site_address ? 'Saving looks up the address once to get the distance.' : ''}</small>
      <label class="label" for="bComp">Competitors</label><textarea id="bComp" maxlength="5000" placeholder="Who else is bidding, last year's price..." ${dis}>${esc(b.competitor_notes || '')}</textarea>
      <label class="label" for="bNotes">Notes</label><textarea id="bNotes" maxlength="10000" ${dis}>${esc(b.notes || '')}</textarea>
      ${['won', 'lost', 'withdrawn'].includes(b.status) ? `<label class="label" for="bOut">Why we ${b.status === 'won' ? 'won' : b.status === 'lost' ? 'lost' : 'pulled out'}</label><input type="text" id="bOut" maxlength="2000" value="${esc(b.outcome_note || '')}" ${dis}>` : ''}
      ${edit ? '<div class="actions"><button class="btn" id="bSave">Save</button><button class="btn ghost small danger" id="bArch">Archive</button></div>' : ''}</div>

    <div class="card bfiles"><div class="toolbar" style="margin:0"><h2 style="flex:1;margin:0">Files</h2>${edit ? '<label class="btn secondary small" style="cursor:pointer">Add files<input type="file" id="bFiles" multiple hidden></label>' : ''}</div>
      <div class="list" style="margin-top:8px">${(files || []).map((f) => `<div class="listrow"><button class="item" data-file="${f.id}" style="flex:1;text-align:left"><b>${esc(f.name)}</b><small>${esc([size(f.size), SOURCE[f.source] || '', C.fmtDate(f.created_at)].filter(Boolean).join(' · '))}</small></button>
        ${edit ? `<button class="btn ghost small" data-farch="${f.id}">Archive</button>` : ''}</div>`).join('') || '<p class="empty" style="margin:0">No files yet.</p>'}</div></div>

    ${MEA.canSee() ? `<div class="card"><div class="toolbar" style="margin:0"><h2 style="flex:1;margin:0">Measure and price</h2>${MEA.canMeasure() && edit ? `<button class="btn small" id="bMeasure">${meas ? 'Measure again' : 'Measure and price'}</button>` : ''}</div>
      ${meas ? `<p><b>${esc(meas.name)}</b>: ${esc(meas.summary || '')}</p>${meas.picture_url ? `<img src="${esc(meas.picture_url)}" alt="The measured map" style="max-width:100%;max-height:240px;border-radius:8px">` : ''}` : '<p class="empty" style="margin:0">Draw the site on the satellite map to price it from your price book.</p>'}
      ${(b.price_lines || []).length ? `<table class="bparts" style="margin-top:8px"><tbody>${b.price_lines.map((l) => `<tr><td>${esc(l.name)}<small class="hint" style="display:block;margin:0">${esc(l.desc || '')}</small></td><td class="num">${esc(Number(l.qty).toLocaleString())} x ${esc(MEA.unitPrice(l.price))}</td><td class="num">${esc(money(Number(l.qty) * Number(l.price)))}</td></tr>`).join('')}
        <tr><td colspan="2"><b>Priced total</b></td><td class="num"><b>${esc(money(priced))}</b></td></tr></tbody></table>` : ''}</div>` : ''}

    ${b.status === 'won' && edit ? `<div class="card"><h2>Won. Now what?</h2>${!b.company_id ? `<p class="hint">Pick the ${esc(FLD.l('organization'))} in Details first, then save.</p>` : ''}
      <div class="actions">${FLD.feat('jobs') && can('jobs', 2) ? `<button class="btn small" data-conv="job" ${b.company_id ? '' : 'disabled'}>${b.job_id ? 'Open the ' + esc(FLD.l('job')) : 'Make a ' + esc(FLD.l('job'))}</button>` : ''}
        ${can('invoices', 2) ? `<button class="btn secondary small" data-conv="invoice" ${b.company_id ? '' : 'disabled'}>${b.invoice_id ? 'Open the invoice' : 'Make an invoice'}</button>` : ''}
        ${S.acct?.is_gelp !== false && can('proposals', 2) && C.proposalDraftFor ? `<button class="btn secondary small" data-conv="proposal" ${b.company_id ? '' : 'disabled'}>${b.proposal_id ? 'Open the ' + esc(FLD.l('proposal')) : 'Start a ' + esc(FLD.l('proposal'))}</button>` : ''}</div></div>` : ''}

    ${b.from_email || b.email_body ? `<div class="card"><h2>${b.source === 'email' ? 'The email' : 'What they sent'}</h2>
      <p class="hint" style="margin:0">${esc([b.from_name, b.from_email].filter(Boolean).join(' · '))}${b.email_subject ? ` · ${esc(b.email_subject)}` : ''}</p>
      ${b.email_body ? `<details><summary>Show the message</summary><pre style="white-space:pre-wrap;font:inherit;margin:8px 0 0">${esc(b.email_body)}</pre></details>` : ''}</div>` : ''}
    ${hist ? `<div class="card"><h2>History</h2><ul class="bhist">${hist}</ul></div>` : ''}`;

  $$('[data-nav]', main).forEach((x) => (x.onclick = () => C.go(x.dataset.nav)));
  const reload = () => viewBid(main);
  $$('[data-file]', main).forEach((x) => (x.onclick = async () => {
    const f = files.find((y) => y.id === x.dataset.file);
    const { data, error: e } = await sb.storage.from('bid-files').createSignedUrl(f.path, 3600);
    if (e || !data?.signedUrl) return C.fail(e || new Error('Couldn\'t open that file'));
    window.open(data.signedUrl, '_blank', 'noopener');
  }));
  if (!edit) return;
  $$('[data-farch]', main).forEach((x) => (x.onclick = async () => {
    const { error: e } = await sb.from('bid_files').update({ archived_at: new Date().toISOString() }).eq('id', x.dataset.farch);
    if (e) return C.fail(e); reload();
  }));
  $('#bFiles').onchange = async (e) => { const n = await uploadFiles(b.id, [...e.target.files]); if (n) C.toast(n === 1 ? 'File added' : `${n} files added`); reload(); };
  $('#bStatus').onchange = async (e) => {
    const { error: er } = await sb.from('bids').update({ status: e.target.value }).eq('id', b.id);
    if (er) { e.target.value = b.status; return C.fail(er); }
    C.toast(`Marked ${STATUS_NAME[e.target.value].toLowerCase()}`); reload();
  };
  const readAnswers = () => { const a = { ...(b.answers || {}) }; $$('[data-ans]', main).forEach((x) => { if (x.value) a[x.dataset.ans] = x.value; else delete a[x.dataset.ans]; }); return a; };
  $$('[data-ans]', main).forEach((x) => (x.onchange = async () => {
    const { error: e } = await sb.from('bids').update({ answers: readAnswers() }).eq('id', b.id);
    if (e) return C.fail(e); reload();
  }));
  $('#bSave').onclick = async (e) => {
    const row = { title: $('#bT').value.trim(), client_name: $('#bC').value.trim() || null, company_id: $('#bCo').value || null, due_at: $('#bDue').value ? new Date($('#bDue').value).toISOString() : null,
      window_start: $('#bWs').value || null, window_end: $('#bWe').value || null, est_value: num($('#bVal').value), est_margin: num($('#bMar').value), submitted_amount: num($('#bSub').value),
      site_address: $('#bAddr').value.trim() || null, competitor_notes: $('#bComp').value.trim() || null, notes: $('#bNotes').value.trim() || null, answers: readAnswers() };
    if ($('#bOwn')) row.owner_id = $('#bOwn').value || null;
    if ($('#bOut')) row.outcome_note = $('#bOut').value.trim() || null;
    if (!row.title) return C.toast('Say what the bid is');
    for (const k of ['est_value', 'est_margin', 'submitted_amount']) if (row[k] != null && Number.isNaN(row[k])) return C.toast('Check the numbers: digits only');
    // look the site up once when the address changes (OpenStreetMap, free, one request)
    if (row.site_address && (row.site_address !== b.site_address || b.site_lat == null)) {
      e.target.disabled = true; e.target.textContent = 'Finding the address…';
      try { const g = await MEA.geocode(row.site_address); if (g) { row.site_lat = g.lat; row.site_lng = g.lng; } else C.toast('Couldn\'t find that address on the map, so there\'s no distance yet. Add the city and state.'); }
      catch { C.toast('Address lookup is busy. Saved without the distance; save again later.'); }
    }
    const { error: er } = await sb.from('bids').update(row).eq('id', b.id);
    e.target.disabled = false; e.target.textContent = 'Save';
    if (er) return C.fail(er); C.toast('Saved'); reload();
  };
  $('#bArch').onclick = async () => {
    if (!confirm('Archive this bid? It leaves the list and reports. Its files stay stored.')) return;
    const { error: er } = await sb.from('bids').update({ archived_at: new Date().toISOString() }).eq('id', b.id);
    if (er) return C.fail(er); C.go('bids');
  };
  if ($('#oGo')) $('#oGo').onclick = async () => {
    const note = $('#oNote').value.trim(); if (!note) return C.toast('Say why in the note. Overrides need one.');
    const { data, error: er } = await sb.rpc('bid_override', { p_id: b.id, p_result: $('#oRes').value, p_note: note });
    if (er) return C.fail(er); C.toast(data?.review === 'pending' ? 'Override saved. It waits in Review.' : 'Override saved'); C.refreshCounts?.(); reload();
  };
  if ($('#oClr')) $('#oClr').onclick = async () => { const { error: er } = await sb.rpc('bid_override', { p_id: b.id, p_result: null, p_note: null }); if (er) return C.fail(er); C.refreshCounts?.(); reload(); };
  if ($('#bMeasure')) $('#bMeasure').onclick = async () => {
    const res = await MEA.open({ company: co, id: b.measurement_id || undefined, target: 'bid', address: b.site_address || '' });
    if (!res) return;
    const lines = res.lines.map((l) => ({ code: l.code || '', name: l.name, desc: l.desc, qty: l.qty, price: l.price }));
    const total = lines.reduce((a, l) => a + l.qty * l.price, 0);
    const row = { measurement_id: res.measurement?.id || null, price_lines: lines };
    if (b.est_value == null && total) row.est_value = Math.round(total * 100) / 100;
    const { error: er } = await sb.from('bids').update(row).eq('id', b.id);
    if (er) return C.fail(er);
    MEA.markUsed('bid', b.id, res.measurement?.id).catch(() => {});
    C.toast(row.est_value ? 'Priced. The total is now the job size.' : 'Priced'); reload();
  };
  $$('[data-conv]', main).forEach((x) => (x.onclick = async () => {
    const k = x.dataset.conv;
    if (k === 'job' && b.job_id) return C.go('job', b.job_id);
    if (k === 'invoice' && b.invoice_id) return C.go('invoice', b.invoice_id);
    if (k === 'proposal' && b.proposal_id) return C.go('proposal', b.proposal_id);
    x.disabled = true;
    try {
      const amount = Number(b.submitted_amount ?? b.est_value ?? 0);
      let ref;
      if (k === 'job') {
        const { data, error: er } = await sb.from('jobs').insert({ company_id: b.company_id, title: b.title.slice(0, 120), price: amount || null, notes: `From the bid${b.notes ? ': ' + b.notes : ''}`.slice(0, 5000),
          scheduled_start: b.window_start ? new Date(b.window_start + 'T08:00').toISOString() : null, scheduled_end: b.window_end ? new Date(b.window_end + 'T17:00').toISOString() : null }).select('id').single();
        if (er) throw er; ref = data.id;
      } else if (k === 'invoice') {
        const tax = Number((await sb.rpc('doc_settings_get')).data?.default_tax_rate) || 0;
        const lines = (b.price_lines || []).length ? b.price_lines.map((l) => ({ ...l, tax })) : [{ code: '', name: b.title.slice(0, 120), desc: '', qty: 1, price: amount, tax }];
        const { data, error: er } = await sb.from('invoices').insert({ company_id: b.company_id, lines, pictures: meas?.picture_url ? [{ url: meas.picture_url, title: meas.name + ' map', measurement_id: meas.id }] : [] }).select('id').single();
        if (er) throw er; ref = data.id;
      } else {
        ref = await C.proposalDraftFor(b.company_id, (b.price_lines || []).map((l) => ({ id: rid(), ph: 1, name: l.name, desc: l.desc || '', note: '', setup: (Math.round(l.qty * l.price * 100) / 100).toFixed(2), setup_cost: '', amt: '', cost: '', every: 'month' })));
      }
      const { error: e2 } = await sb.rpc('bid_converted', { p_id: b.id, p_kind: k, p_ref: ref });
      if (e2) throw e2;
      C.toast(k === 'job' ? `${FLD.L('job')} made` : k === 'invoice' ? 'Invoice made. Check it, then send it.' : `${FLD.L('proposal')} started`);
      C.go(k, ref);
    } catch (er) { x.disabled = false; C.fail(er); }
  }));
}

/* ================= Review: overrides waiting on a yes ================= */
export const reviewOn = () => canApprove();
export async function reviewCount() {
  if (!reviewOn()) return 0;
  const { data } = await sb.rpc('bid_review_list');
  return Array.isArray(data) ? data.length : 0;
}
export async function reviewBox(box) {
  if (!box || !reviewOn()) return;
  const { data } = await sb.rpc('bid_review_list');
  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<h2 class="section">Bid overrides to approve (${rows.length})</h2>${rows.map((x) => `<div class="card" data-rb="${x.id}">
      <div class="toolbar"><b style="flex:1">${esc(x.title)}${x.client ? ' · ' + esc(x.client) : ''}</b><small>${esc(C.fmtDate(x.at))}</small></div>
      <p>${esc(x.by || 'Someone')} changed ${badge(x.result)} (score ${x.score == null ? 'none' : esc(Math.round(x.score))}) to ${badge(x.override)}: “${esc(x.note || '')}”${x.due_at ? ` Due ${esc(fmtDue(x.due_at))}.` : ''}</p>
      <div class="actions"><button class="btn small" data-ok="1">Approve</button><button class="btn secondary small" data-ok="0">Send it back</button><button class="btn ghost small" data-open="${x.id}">Look at the bid</button></div></div>`).join('')}`;
  $$('[data-rb]', box).forEach((card) => {
    $$('[data-ok]', card).forEach((x) => (x.onclick = async () => {
      const ok = x.dataset.ok === '1';
      const note = ok ? null : prompt('Why send it back? (they see this)', '');
      if (!ok && note === null) return;
      const { error } = await sb.rpc('bid_override_decide', { p_id: card.dataset.rb, p_ok: ok, p_note: note });
      if (error) return C.fail(error); C.toast(ok ? 'Approved' : 'Sent back. The scorecard result stands.'); C.refreshCounts?.(); reviewBox(box);
    }));
    $('[data-open]', card).onclick = (e) => C.go('bid', e.target.dataset.open);
  });
}

/* ================= Tools > Admin > Bids ================= */
async function viewSetup(main) {
  css();
  const s = await settings(true);
  if (!s) return noDb(main, 'Bids setup');
  const edit = !!s.can_edit;
  const dis = edit ? '' : 'disabled';
  const have = Object.fromEntries((s.metrics || []).map((m) => [m.key, m]));
  // the five built-ins always show (ticked when on the scorecard), then the account's own questions
  let rows = [...BUILT.map((k) => ({ ...(have[k] || { key: k, kind: k, label: KINDS[k].label, rank: 2, good: KINDS[k].good, poor: KINDS[k].poor }), on: !!have[k] && !have[k].off })),
    ...(s.metrics || []).filter((m) => !BUILT.includes(m.kind)).map((m) => ({ ...m, on: !m.off }))];
  let base = { address: s.base_address || '', lat: s.base_lat, lng: s.base_lng };
  const upLink = s.upload_token ? `${S.pub()}${location.pathname.replace(/[^/]*$/, '')}bid/?t=${s.upload_token}` : '';
  const mrow = (m, i) => { const built = BUILT.includes(m.kind), k = KINDS[m.kind];
    return `<div class="mrow" data-m="${i}"><input type="checkbox" data-mk="on" ${m.on ? 'checked' : ''} ${dis} aria-label="Use ${esc(m.label)}">
      <input type="text" data-mk="label" value="${esc(m.label)}" maxlength="120" ${dis} aria-label="Name">
      <select data-mk="rank" ${dis} aria-label="Rank">${[1, 2, 3].map((r) => `<option value="${r}" ${Number(m.rank) === r ? 'selected' : ''}>Rank ${r}</option>`).join('')}</select>
      ${k?.unit ? `<span class="mgp"><input type="text" inputmode="decimal" data-mk="good" value="${esc(m.good ?? k.good)}" ${dis} aria-label="Good at" title="Full points at"><input type="text" inputmode="decimal" data-mk="poor" value="${esc(m.poor ?? k.poor)}" ${dis} aria-label="Poor at" title="Lowest points at"></span>`
        : m.kind === 'yesno' ? `<span class="mgp"><select data-mk="yes_good" ${dis} aria-label="Good answer"><option value="1" ${m.yes_good !== false ? 'selected' : ''}>Yes is good</option><option value="0" ${m.yes_good === false ? 'selected' : ''}>No is good</option></select></span>`
        : '<span class="mgp"></span>'}
      ${built ? '<span></span>' : `<button type="button" class="btn ghost small danger" data-mrm="${i}" ${dis}>Remove</button>`}
      <span class="mwhat">${esc(k ? `${k.what}.${k.unit ? ` Full points at the first number, lowest at the second (${k.unit}).` : ''}` : m.kind === 'yesno' ? 'A yes or no question someone answers on each bid.' : 'A 1 to 5 question someone answers on each bid.')}</span></div>`; };
  const draw = () => {
    main.innerHTML = `<h1>Bids</h1>
    <div class="card"><h2>Scorecard</h2>
      <p class="hint">Tick what matters for go or no-go and rank each one. Rank 1 counts three times as much as rank 3, rank 2 twice. Each bid gets a score from 0 to 100.</p>
      <div class="mrow mhead"><span></span><span>What</span><span>Rank</span><span>Full points at, lowest at</span><span></span></div>
      <div id="mList">${rows.map(mrow).join('')}</div>
      ${edit ? '<div class="actions"><button type="button" class="btn ghost small" id="mYes">+ A yes or no question</button><button type="button" class="btn ghost small" id="mScale">+ A 1 to 5 question</button></div>' : ''}
      <div class="row"><div><label class="label" for="sGo">Go at a score of</label><input type="number" id="sGo" min="0" max="100" value="${esc(s.go_at)}" ${dis}></div>
        <div><label class="label" for="sMaybe">Maybe at</label><input type="number" id="sMaybe" min="0" max="100" value="${esc(s.maybe_at)}" ${dis}></div></div>
      <p class="hint">Below maybe is a no-go.</p>
      <label class="check featrow"><input type="checkbox" id="sRev" ${s.override_review ? 'checked' : ''} ${dis}> <span><b>Overrides go to Review</b><small class="hint" style="display:block;margin:0">When someone changes a bid's go or no-go, a person who can approve bids says yes first. People who can approve bids skip it.</small></span></label></div>
    <div class="card"><h2>Your base</h2><p class="hint">Where your crews leave from. Distance to each bid site is a straight line from here.</p>
      <div class="addr"><input type="text" id="sBase" maxlength="300" value="${esc(base.address)}" placeholder="Your shop address" ${dis}>${edit ? '<button type="button" class="btn secondary small" id="sFind">Find it</button>' : ''}</div>
      <small class="hint" id="sBaseAt">${base.lat != null ? `Found: ${Number(base.lat).toFixed(4)}, ${Number(base.lng).toFixed(4)}` : 'Not found yet. Tap Find it (looks it up once on OpenStreetMap).'}</small></div>
    <div class="card"><h2>Bids by email</h2>
      ${s.email_ready ? `<label class="check featrow"><input type="checkbox" id="sEmail" ${s.email_on ? 'checked' : ''} ${dis}> <span><b>Take bids by email</b></span></label>
        ${s.email_address ? `<p>Forward RFPs to <b>${esc(s.email_address)}</b>. The email becomes a bid and its attachments are saved with it.</p>` : '<p class="hint">Your account needs a short name for its address. Ask GELP to set one.</p>'}`
        : '<p class="hint">Email intake isn\'t set up for the platform yet. Once it is, your address shows here.</p>'}
      ${s.platform_owner ? `<div class="row"><div><label class="label" for="sDom">Platform: email domain for bids</label><input type="text" id="sDom" value="${esc(s.email_domain || '')}" placeholder="bids.gelpstrategies.com"></div>
        <div><label class="label" for="sSty">Address style</label><select id="sSty"><option value="plus" ${s.email_style !== 'plain' ? 'selected' : ''}>bids+name@domain</option><option value="plain" ${s.email_style === 'plain' ? 'selected' : ''}>name@domain</option></select></div></div>
        <div class="actions"><button type="button" class="btn secondary small" id="sDomGo">Save the domain</button></div>` : ''}</div>
    <div class="card"><h2>Upload page</h2>
      <label class="check featrow"><input type="checkbox" id="sUp" ${s.upload_on ? 'checked' : ''} ${dis}> <span><b>Let people upload RFPs on a page you share</b><small class="hint" style="display:block;margin:0">No login. They add their name, email and the files.</small></span></label>
      ${upLink ? `<div class="addr"><input type="text" readonly value="${esc(upLink)}" aria-label="Upload page link"><button type="button" class="btn secondary small" id="sCopy">Copy</button>${edit ? '<button type="button" class="btn ghost small" id="sNewLink">New link</button>' : ''}</div>` : ''}
      <label class="label" for="sIntro">A line at the top of the page (optional)</label><textarea id="sIntro" maxlength="1000" ${dis}>${esc(s.upload_intro || '')}</textarea></div>
    ${edit ? '<div class="actions"><button class="btn" id="sSave">Save</button></div>' : '<p class="hint">Your role can look but not change these.</p>'}`;
    bind();
  };
  const read = () => { rows = $$('[data-m]', main).map((el, i) => { const m = { ...rows[i] }; $$('[data-mk]', el).forEach((x) => {
    const k = x.dataset.mk; m[k] = k === 'on' ? x.checked : k === 'rank' ? Number(x.value) : k === 'yes_good' ? x.value === '1' : k === 'good' || k === 'poor' ? num(x.value) : x.value; }); return m; }); };
  const bind = () => {
    $$('[data-mrm]', main).forEach((x) => (x.onclick = () => { read(); rows.splice(Number(x.dataset.mrm), 1); draw(); }));
    if ($('#mYes')) $('#mYes').onclick = () => { read(); rows.push({ key: '', kind: 'yesno', label: '', rank: 3, yes_good: true, on: true }); draw(); $$('[data-mk="label"]', main).pop().focus(); };
    if ($('#mScale')) $('#mScale').onclick = () => { read(); rows.push({ key: '', kind: 'scale', label: '', rank: 3, on: true }); draw(); $$('[data-mk="label"]', main).pop().focus(); };
    if ($('#sFind')) $('#sFind').onclick = async () => {
      const q = $('#sBase').value.trim(); if (!q) return C.toast('Type your address first');
      try { const g = await MEA.geocode(q); if (!g) return C.toast('Couldn\'t find that address. Add the city and state.'); base = { address: q, lat: g.lat, lng: g.lng };
        $('#sBaseAt').textContent = `Found: ${g.lat.toFixed(4)}, ${g.lng.toFixed(4)}. Save to keep it.`; }
      catch (e) { C.toast(e.message || 'Address lookup is busy', { error: true }); }
    };
    if ($('#sCopy')) $('#sCopy').onclick = async () => { try { await navigator.clipboard.writeText(upLink); C.toast('Link copied'); } catch { prompt('Copy this link:', upLink); } };
    if ($('#sNewLink')) $('#sNewLink').onclick = async () => {
      if (!confirm('Make a new upload link? The old one stops working.')) return;
      const { error } = await sb.rpc('bid_upload_link_new'); if (error) return C.fail(error); viewSetup(main);
    };
    if ($('#sDomGo')) $('#sDomGo').onclick = async () => { const { error } = await sb.rpc('bid_intake_domain_set', { p_domain: $('#sDom').value.trim(), p_style: $('#sSty').value }); if (error) return C.fail(error); C.toast('Domain saved'); viewSetup(main); };
    if ($('#sSave')) $('#sSave').onclick = async () => {
      read();
      const addr = $('#sBase').value.trim();
      if (addr !== base.address) base = { address: addr, lat: null, lng: null };
      if (addr && base.lat == null) { try { const g = await MEA.geocode(addr); if (g) base = { address: addr, lat: g.lat, lng: g.lng }; } catch { /* saved without a pin; Find it later */ } }
      const metrics = [];
      for (const m of rows) {
        if (!m.on) continue;
        if (!m.label?.trim()) return C.toast('Every scorecard item needs a name');
        if (KINDS[m.kind]?.unit && (m.good == null || m.poor == null || Number.isNaN(m.good) || Number.isNaN(m.poor))) return C.toast(`Set the two numbers for ${m.label}`);
        metrics.push({ key: m.key || undefined, kind: m.kind, label: m.label.trim(), rank: m.rank, good: m.good, poor: m.poor, yes_good: m.yes_good });
      }
      const p = { metrics, go_at: Number($('#sGo').value), maybe_at: Number($('#sMaybe').value), override_review: $('#sRev').checked, email_on: $('#sEmail') ? $('#sEmail').checked : s.email_on,
        upload_on: $('#sUp').checked, upload_intro: $('#sIntro').value, base_address: base.address || null, base_lat: base.lat, base_lng: base.lng };
      const { data, error } = await sb.rpc('bid_settings_save', { p });
      if (error) return C.fail(error); SET = data; C.toast('Saved. Open bids are rescored.'); viewSetup(main);
    };
  };
  draw();
}
