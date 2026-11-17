/* Phone (Nov 16, 2026). Off until an account turns on Phone (Settings › Features). Server side: schema/117_phone.sql,
   supabase/functions/phone (numbers, browser logins) and phone-hook (Telnyx call events).
   - Anyone on a line gets the phone button (bottom left): a dial pad, calls from a line they're on, incoming calls with
     who's calling, mute, hold and keypad. Call buttons and phone numbers on contacts dial through it.
   - Tools › Phone › Calls: every call, voicemails and recordings to play, notes, and unknown numbers to file.
   - Tools › Phone › Usage: your numbers; admins see the company pool (3,000 minutes a month per line) in color.
   - Tools › Admin › Phone lines: names, direct or group, who rings, how long, recording, voicemail and greeting.
     Platform and agency admins buy and give back numbers here too (they cost money every month). */

let C = null;
let sb, S, esc, $, $$;
export function init(ctx) { C = ctx; ({ sb, S, esc, $, $$ } = ctx); }

const SDK = 'https://esm.sh/@telnyx/webrtc@2.27.4';
const on = () => C.FLD.feat('phone');
export const views = () => ({ phonelog: viewLog, phoneusage: viewUsage, phoneset: viewSetup });
export const parents = { phonelog: 'tools', phoneusage: 'tools', phoneset: 'tools' };
export const drawerItems = () => ({
  phone: [
    { id: 'phonelog', label: 'Calls', match: ['phonelog'], what: 'Every call, voicemails and recordings, and numbers to file', when: () => on() },
    { id: 'phoneusage', label: 'Usage', match: ['phoneusage'], what: 'Calls and minutes this month', when: () => on() } ],
  admin: [{ id: 'phoneset', label: 'Phone lines', match: ['phoneset'], what: 'Numbers, who rings, voicemail and recording', when: () => on() && C.isAdmin() }],
});

export const fmt = (n) => { const d = String(n || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(n || 'Unknown'); };
const dur = (s) => { s = Math.max(0, s | 0); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, '0')}`; };
const when = (at) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
async function fn(body) {
  const { data, error } = await sb.functions.invoke('phone', { body });
  if (error) { let m = error.message; try { m = (await error.context?.json())?.error || m; } catch { /* plain */ } throw new Error(m); }
  if (data?.error) throw new Error(data.error);
  return data;
}

/* ================= the browser phone ================= */
const P = { client: null, lines: [], call: null, callId: null, answeredAt: 0, muted: false, held: false, ready: false, starting: false, tick: null };

// lines I'm on in this account (admins can call from any line)
async function myLines() {
  const { data } = await sb.from('phone_lines').select('id,name,number,members,kind,record').eq('active', true).order('name');
  return (data || []).filter((l) => C.isAdmin() || (l.members || []).includes(S.me.id));
}

export async function start() {
  if (P.starting || P.client || !on() || !S.me?.id) return;
  P.starting = true;
  try {
    P.lines = await myLines();
    if (!P.lines.length) return;
    dock();
    if (!window.RTCPeerConnection) { status('This browser can\'t make calls'); return; }
    const { token } = await fn({ kind: 'token' });
    const { TelnyxRTC } = await import(SDK);
    P.client = new TelnyxRTC({ login_token: token, ringtoneFile: './phone/ring.wav', ringbackFile: './phone/ringback.wav' });
    P.client.remoteElement = 'phRemote';
    P.client.on('telnyx.ready', () => { P.ready = true; status(''); });
    P.client.on('telnyx.error', (e) => { P.ready = false; status('Phone offline'); console.log('phone', e); });
    P.client.on('telnyx.socket.close', () => { P.ready = false; status('Reconnecting…'); setTimeout(() => P.client?.connect(), 4000); });
    P.client.on('telnyx.notification', (n) => { if (n.type === 'callUpdate' && n.call) callUpdate(n.call); });
    P.client.on('telnyx.warning', async (w) => {   // the 24 hour login is about to run out: get a new one without dropping calls
      if (/TOKEN_EXPIRING|expir/i.test(String(w?.code || w?.name || w?.message || ''))) { try { const r = await fn({ kind: 'token' }); P.client.updateToken?.(r.token) || P.client.login?.({ login_token: r.token }); } catch { /* next connect */ } }
    });
    P.client.connect();
    status('Connecting…');
    hookTelLinks();
  } catch (e) { status('Phone offline'); console.log('phone start', e); }
  finally { P.starting = false; }
}

function dock() {
  if ($('#phDock')) return;
  const d = document.createElement('div'); d.id = 'phDock'; d.className = 'phdock';
  d.innerHTML = `<audio id="phRemote" autoplay></audio>
    <div class="phpanel card" id="phPanel" hidden></div>
    <button type="button" class="phfab" id="phFab" aria-label="Phone">☎<span class="phstat" id="phStat"></span></button>`;
  document.body.appendChild(d);
  $('#phFab').onclick = () => {
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* not supported */ }
    const p = $('#phPanel'); if (p.hidden) { p.hidden = false; draw(); } else if (!P.call) p.hidden = true; };
}
const status = (t) => { const s = $('#phStat'); if (s) { s.textContent = t; s.hidden = !t; } };

// tel: links and Call buttons on contacts dial through the CRM phone (long-press or no phone: the device's own dialer)
function hookTelLinks() {
  if (window.__phTel) return; window.__phTel = true;
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="tel:"]');
    if (!a || !P.client || !P.lines.length || e.altKey) return;
    e.preventDefault(); dial(a.getAttribute('href').slice(4));
  }, true);
}

export function dial(number) {
  if (!P.lines.length) return C.toast('You\'re not on a phone line yet. Ask an admin', { error: true });
  $('#phPanel').hidden = false; draw(number);
}

function draw(prefill = '') {
  const p = $('#phPanel'); if (!p) return;
  if (P.call) return drawCall();
  const last = localStorage.getItem('phLine');
  const line = P.lines.find((l) => l.id === last) || P.lines[0];
  p.innerHTML = `<div class="toolbar"><b style="flex:1">Phone</b><button type="button" class="btn ghost small" id="phClose" aria-label="Close">✕</button></div>
    ${P.lines.length > 1 ? `<label class="label" for="phLine">Call from</label><select id="phLine">${P.lines.map((l) => `<option value="${l.id}" ${l.id === line.id ? 'selected' : ''}>${esc(l.name)} · ${esc(fmt(l.number))}</option>`).join('')}</select>`
      : `<small class="hint">Calling from ${esc(line.name)} · ${esc(fmt(line.number))}</small>`}
    <input type="tel" id="phNum" inputmode="tel" autocomplete="off" placeholder="Number to call" value="${esc(prefill)}" style="font-size:1.3rem;text-align:center;margin-top:8px">
    <div class="phwho" id="phWho"></div>
    <div class="phpad">${'123456789*0#'.split('').map((k) => `<button type="button" data-k="${k}">${k}</button>`).join('')}</div>
    <div class="actions" style="justify-content:center"><button type="button" class="btn" id="phGo" ${P.ready ? '' : 'disabled'}>📞 Call</button><button type="button" class="btn ghost small" id="phBack">⌫</button></div>
    ${P.ready ? '' : '<small class="hint" style="text-align:center">Connecting the phone…</small>'}
    <small class="hint" style="text-align:center">The CRM phone can't call 911. Use a cell or desk phone for emergencies.</small>`;
  const num = $('#phNum', p);
  const who = C.debounce(async () => {
    const d = num.value.replace(/\D/g, ''); const w = $('#phWho', p); if (!w) return;
    if (d.length < 10) { w.textContent = ''; return; }
    const { data } = await sb.rpc('phone_who', { p_number: d }); w.textContent = data ? [data.person, data.company].filter(Boolean).join(' · ') : '';
  }, 300);
  num.oninput = who; who();
  $$('[data-k]', p).forEach((b) => (b.onclick = () => { num.value += b.dataset.k; who(); }));
  $('#phBack', p).onclick = () => { num.value = num.value.slice(0, -1); who(); };
  $('#phClose', p).onclick = () => { p.hidden = true; };
  num.onkeydown = (e) => { if (e.key === 'Enter') $('#phGo', p).click(); };
  $('#phGo', p).onclick = () => placeCall($('#phLine', p)?.value || line.id, num.value);
  setTimeout(() => num.focus(), 30);
}

async function placeCall(lineId, to) {
  if (!P.ready) return C.toast('The phone is still connecting', { error: true });
  localStorage.setItem('phLine', lineId);
  const { data, error } = await sb.rpc('phone_out_start', { p_line: lineId, p_to: to });
  if (error) return C.fail(error);
  P.callId = data.call_id;
  const call = P.client.newCall({ destinationNumber: data.to, callerNumber: data.from, callerName: S.acct?.name || '', audio: true, video: false });
  P.call = call; P.answeredAt = 0; P.muted = false; P.held = false;
  P.callInfo = { dir: 'out', number: data.to, name: '' };
  sb.rpc('phone_who', { p_number: data.to }).then(({ data: w }) => { if (w && P.callInfo) { P.callInfo.name = [w.person, w.company].filter(Boolean).join(' · '); drawCall(); } });
  drawCall();
}

function callUpdate(call) {
  const st = call.state;
  if (st === 'ringing' && call.direction === 'inbound') {
    if (P.call && P.call !== call) { call.hangup(); return; }   // busy on another call: it keeps ringing the others or goes to voicemail
    P.call = call; P.callId = null; P.answeredAt = 0; P.muted = false; P.held = false;
    const num = call.options?.remoteCallerNumber || call.options?.callerNumber || '';
    const ln = call.options?.remoteCallerName || '';
    P.callInfo = { dir: 'in', number: num, name: '', line: ln && ln.replace(/\D/g, '') !== num.replace(/\D/g, '') ? ln : '' };
    $('#phPanel').hidden = false; drawCall();
    sb.rpc('phone_who', { p_number: num }).then(({ data: w }) => { if (w && P.callInfo) { P.callInfo.name = [w.person, w.company].filter(Boolean).join(' · '); P.callInfo.ids = w; drawCall(); } });
    try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('Incoming call', { body: fmt(num) }); } catch { /* no notifications */ }
    return;
  }
  if (call !== P.call) return;
  if (st === 'active') {
    if (!P.answeredAt) {
      P.answeredAt = Date.now();
      if (P.callInfo?.dir === 'out' && P.callId) {
        const cc = call.telnyxIDs?.telnyxCallControlId || '';
        if (cc) sb.rpc('phone_out_ccid', { p_call: P.callId, p_ccid: cc }).then(() => fn({ kind: 'record', call_id: P.callId }).catch(() => {}));
      }
      clearInterval(P.tick); P.tick = setInterval(() => { const t = $('#phTime'); if (t) t.textContent = dur((Date.now() - P.answeredAt) / 1000); }, 1000);
    }
    drawCall();
  } else if (st === 'held') { P.held = true; drawCall(); }
  else if (st === 'hangup' || st === 'destroy' || st === 'purge') {
    if (P.callInfo?.dir === 'out' && P.callId) {
      const cc = call.telnyxIDs?.telnyxCallControlId || '';
      const id = P.callId, secs = P.answeredAt ? Math.round((Date.now() - P.answeredAt) / 1000) : 0;
      (cc ? sb.rpc('phone_out_ccid', { p_call: id, p_ccid: cc }) : Promise.resolve()).then(() => sb.rpc('phone_out_end', { p_call: id, p_answered_secs: secs }));
    }
    clearInterval(P.tick); P.call = null; P.callId = null; P.callInfo = null;
    const pn = $('#phPanel'); if (pn) pn.hidden = true;
  } else drawCall();
}

function drawCall() {
  const p = $('#phPanel'); const c = P.call; if (!p || !c) return;
  const i = P.callInfo || {}; const ringing = c.state === 'ringing' && i.dir === 'in';
  const active = c.state === 'active' || c.state === 'held';
  p.innerHTML = `<div class="phcall">
      <small class="hint">${i.dir === 'in' ? (ringing ? 'Incoming call' : 'Call') : active ? 'On a call' : 'Calling…'}${i.line ? ' · ' + esc(i.line) : ''}</small>
      <b class="phname">${esc(i.name || fmt(i.number))}</b>${i.name ? `<small>${esc(fmt(i.number))}</small>` : ''}
      ${active ? `<div class="phtime" id="phTime">${dur(P.answeredAt ? (Date.now() - P.answeredAt) / 1000 : 0)}</div>` : ''}
      ${ringing ? `<div class="actions" style="justify-content:center"><button type="button" class="btn" id="phAns">Answer</button><button type="button" class="btn dangerbtn" id="phDec">Decline</button></div>`
        : `<div class="actions" style="justify-content:center;flex-wrap:wrap">
            ${active ? `<button type="button" class="btn secondary small" id="phMute">${P.muted ? 'Unmute' : 'Mute'}</button>
            <button type="button" class="btn secondary small" id="phHold">${c.state === 'held' ? 'Resume' : 'Hold'}</button>
            <button type="button" class="btn secondary small" id="phKeys">Keypad</button>` : ''}
            <button type="button" class="btn dangerbtn" id="phEnd">Hang up</button></div>
          <div class="phpad" id="phDtmf" hidden>${'123456789*0#'.split('').map((k) => `<button type="button" data-d="${k}">${k}</button>`).join('')}</div>`}
      ${i.ids?.person_id || i.ids?.company_id ? `<button type="button" class="btn ghost small" id="phOpen">Open ${esc(i.ids.person || i.ids.company || 'contact')}</button>` : ''}</div>`;
  if ($('#phAns', p)) $('#phAns', p).onclick = () => c.answer();
  if ($('#phDec', p)) $('#phDec', p).onclick = () => c.hangup();
  if ($('#phEnd', p)) $('#phEnd', p).onclick = () => c.hangup();
  if ($('#phMute', p)) $('#phMute', p).onclick = () => { P.muted ? c.unmuteAudio() : c.muteAudio(); P.muted = !P.muted; drawCall(); };
  if ($('#phHold', p)) $('#phHold', p).onclick = () => { c.state === 'held' ? c.unhold() : c.hold(); };
  if ($('#phKeys', p)) $('#phKeys', p).onclick = () => { $('#phDtmf', p).hidden = !$('#phDtmf', p).hidden; };
  $$('[data-d]', p).forEach((b) => (b.onclick = () => c.dtmf(b.dataset.d)));
  if ($('#phOpen', p)) $('#phOpen', p).onclick = () => i.ids.person_id ? C.go('people', i.ids.person_id) : C.go('org', i.ids.company_id);
}

/* ================= Calls (the log) ================= */
let logShow = 'all';
async function viewLog(main) {
  if (!on()) { main.innerHTML = '<h1>Calls</h1><p class="empty">Phone is off for this account. An admin can turn it on in Settings › Features.</p>'; return; }
  main.innerHTML = '<h1>Calls</h1><p class="empty">Loading…</p>';
  let q = sb.from('phone_calls').select('id,direction,other_number,status,started_at,seconds,user_id,person_id,company_id,line_id,recording_path,voicemail_path,notes,dismissed_at,people(first_name,last_name),companies(name),phone_lines(name)')
    .order('started_at', { ascending: false }).limit(200);
  if (logShow === 'mine') q = q.eq('user_id', S.me.id);
  if (logShow === 'unfiled') q = q.is('person_id', null).is('company_id', null).is('dismissed_at', null);
  if (logShow === 'voicemail') q = q.not('voicemail_path', 'is', null);
  if (logShow === 'missed') q = q.in('status', ['missed', 'voicemail']);
  const { data, error } = await q;
  if (error) { main.innerHTML = '<h1>Calls</h1><p class="empty">Couldn\'t load calls.</p>'; return C.fail(error); }
  const name = (c) => c.people?.first_name ? `${c.people.first_name} ${c.people.last_name || ''}`.trim() : c.companies?.name || '';
  const ST = { done: '', answered: 'On the call', ringing: 'Ringing', missed: 'Missed', voicemail: 'Voicemail', failed: 'No answer' };
  main.innerHTML = `<h1>Calls</h1>
    <div class="toolbar"><div class="seg" role="group" aria-label="Show">${[['all', 'All'], ['mine', 'Mine'], ['missed', 'Missed'], ['voicemail', 'Voicemail'], ['unfiled', 'To file']].map(([k, l]) => `<button type="button" class="${logShow === k ? 'on' : ''}" data-ls="${k}">${l}</button>`).join('')}</div>
      ${P.lines.length ? '<button type="button" class="btn small" id="plDial">📞 New call</button>' : ''}</div>
    <div class="card">${(data || []).map((c) => `<div class="person-row" data-call="${c.id}">
      <div class="toolbar"><div style="flex:1"><b>${c.direction === 'in' ? '↙' : '↗'} ${esc(name(c) || fmt(c.other_number))}</b>${name(c) ? ` <small>${esc(fmt(c.other_number))}</small>` : ''}
          ${ST[c.status] ? ` <span class="badge ${c.status === 'missed' || c.status === 'voicemail' ? 'warn' : ''}">${ST[c.status]}</span>` : ''}<br>
        <small>${esc(when(c.started_at))} · ${esc(c.phone_lines?.name || 'Phone')}${c.seconds ? ' · ' + dur(c.seconds) : ''}${c.user_id ? ' · ' + esc(C.userName(c.user_id)) : ''}</small></div>
        ${c.other_number ? `<a class="btn secondary small" href="tel:${esc(c.other_number)}">Call back</a>` : ''}</div>
      ${c.voicemail_path || c.recording_path ? `<div class="actions">${c.voicemail_path ? `<button type="button" class="btn ghost small" data-play="${esc(c.voicemail_path)}">▶ Voicemail</button>` : ''}${c.recording_path ? `<button type="button" class="btn ghost small" data-play="${esc(c.recording_path)}">▶ Recording</button>` : ''}</div>` : ''}
      <div data-playbox></div>
      <textarea rows="1" data-cnote style="min-height:38px" placeholder="Add a note about this call">${esc(c.notes || '')}</textarea>
      ${!c.person_id && !c.company_id && !c.dismissed_at ? `<div class="actions"><button type="button" class="btn small" data-file>File it</button><button type="button" class="btn ghost small" data-dismiss>Not a customer</button></div><div data-filebox></div>`
        : `<small class="hint">${c.dismissed_at ? 'Marked not a customer' : 'On the timeline of ' + esc(name(c))} · <button type="button" class="btn ghost small" data-file>Move</button></small><div data-filebox></div>`}
    </div>`).join('') || `<p class="empty">${logShow === 'unfiled' ? 'Nothing to file. Calls from numbers the CRM doesn\'t know land here.' : 'No calls yet.'}</p>`}</div>`;
  $$('[data-ls]', main).forEach((b) => (b.onclick = () => { logShow = b.dataset.ls; viewLog(main); }));
  if ($('#plDial', main)) $('#plDial', main).onclick = () => dial('');
  $$('[data-call]', main).forEach((row) => wireCall(row, row.dataset.call, () => viewLog(main)));
}

// play, notes and filing on one call (the log and timelines use it)
export function wireCall(row, id, after) {
  $$('[data-play]', row).forEach((b) => (b.onclick = async () => {
    const { data, error } = await sb.storage.from('phone').createSignedUrl(b.dataset.play, 600);
    if (error) return C.fail(error);
    $('[data-playbox]', row).innerHTML = `<audio controls autoplay src="${esc(data.signedUrl)}" style="width:100%"></audio>`;
  }));
  const ta = $('[data-cnote]', row);
  if (ta) ta.onchange = async () => { const { error } = await sb.rpc('phone_call_note', { p_call: id, p_notes: ta.value }); if (error) return C.fail(error); C.toast('Note saved'); };
  if ($('[data-dismiss]', row)) $('[data-dismiss]', row).onclick = async () => { const { error } = await sb.rpc('phone_call_file', { p_call: id, p_person: null, p_company: null, p_dismiss: true }); if (error) return C.fail(error); after?.(); };
  $$('[data-file]', row).forEach((b) => (b.onclick = () => filePicker($('[data-filebox]', row), id, after)));
}

function filePicker(box, id, after) {
  box.innerHTML = `<input type="search" placeholder="Search people and organizations" data-fq><div data-fres></div>`;
  const inp = $('[data-fq]', box);
  inp.oninput = C.debounce(async () => {
    const t = inp.value.trim(); const res = $('[data-fres]', box);
    if (t.length < 2) { res.innerHTML = ''; return; }
    const like = `%${t.replace(/[%_]/g, '')}%`;
    const [pe, co] = await Promise.all([
      sb.from('people').select('id,first_name,last_name,company_people(company_id,companies(name))').or(`first_name.ilike.${like},last_name.ilike.${like}`).limit(6),
      sb.from('companies').select('id,name').ilike('name', like).limit(6)]);
    res.innerHTML = [...(pe.data || []).map((p) => `<button type="button" class="drawitem" data-fp="${p.id}" data-fc="${p.company_people?.[0]?.company_id || ''}"><b>${esc(`${p.first_name} ${p.last_name || ''}`)}</b><small>Person${p.company_people?.[0]?.companies?.name ? ' at ' + esc(p.company_people[0].companies.name) : ''}</small></button>`),
      ...(co.data || []).map((c) => `<button type="button" class="drawitem" data-fco="${c.id}"><b>${esc(c.name)}</b><small>Organization</small></button>`)].join('') || '<p class="empty">No match. Add them in Quick Add first.</p>';
    $$('[data-fp]', res).forEach((b) => (b.onclick = () => go(b.dataset.fp, null)));
    $$('[data-fco]', res).forEach((b) => (b.onclick = () => go(null, b.dataset.fco)));
  }, 250);
  const go = async (person, company) => { const { error } = await sb.rpc('phone_call_file', { p_call: id, p_person: person, p_company: company, p_dismiss: false }); if (error) return C.fail(error); C.toast('Filed'); after?.(); };
  inp.focus();
}

// a call on a contact's timeline: line, direction, length, who, play and notes
export function timelineRow(e) {
  const d = e.data || {};
  const bits = [d.line, d.seconds ? dur(d.seconds) : '', d.user].filter(Boolean).join(' · ');
  return `<div class="tlbody" data-tlcall="${esc(d.call_id || '')}"><small>${esc(bits)}</small>
    ${d.voicemail || d.recorded ? `<div class="actions">${d.voicemail ? '<button type="button" class="btn ghost small" data-tlplay="voicemail">▶ Voicemail</button>' : ''}${d.recorded ? '<button type="button" class="btn ghost small" data-tlplay="call">▶ Recording</button>' : ''}</div><div data-playbox></div>` : ''}
    ${d.notes ? `<div>${esc(d.notes)}</div>` : ''}</div>`;
}
export function wireTimeline(box) {
  $$('[data-tlcall]', box).forEach((row) => $$('[data-tlplay]', row).forEach((b) => (b.onclick = async () => {
    const { data: c } = await sb.from('phone_calls').select('recording_path,voicemail_path').eq('id', row.dataset.tlcall).maybeSingle();
    const path = b.dataset.tlplay === 'voicemail' ? c?.voicemail_path : c?.recording_path;
    if (!path) return C.toast('That recording isn\'t ready yet', { error: true });
    const { data, error } = await sb.storage.from('phone').createSignedUrl(path, 600);
    if (error) return C.fail(error);
    $('[data-playbox]', row).innerHTML = `<audio controls autoplay src="${esc(data.signedUrl)}" style="width:100%"></audio>`;
  })));
}

/* ================= Usage ================= */
const tone = (pct) => pct >= 100 ? 'red' : pct >= 90 ? 'orange' : pct >= 75 ? 'yellow' : 'green';
async function viewUsage(main) {
  if (!on()) { main.innerHTML = '<h1>Phone usage</h1><p class="empty">Phone is off for this account.</p>'; return; }
  const { data: u, error } = await sb.rpc('phone_usage', { p_month: null });
  if (error) return C.fail(error);
  const tile = (label, v, cls = '') => `<div class="phtile ${cls}"><b>${v}</b><small>${esc(label)}</small></div>`;
  const co = u?.company, pct = co?.limit ? Math.round(100 * co.minutes / co.limit) : 0;
  main.innerHTML = `<h1>Phone usage</h1><p class="hint">${esc(new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</p>
    <div class="card"><h2>You</h2><div class="phtiles">${tile('Calls in', u?.me?.calls_in ?? 0)}${tile('Calls out', u?.me?.calls_out ?? 0)}${tile('Minutes', u?.me?.minutes ?? 0)}</div></div>
    ${co ? `<div class="card"><h2>Company</h2>
      <div class="phtiles">${tile('Calls in', co.calls_in)}${tile('Calls out', co.calls_out)}${tile('Missed and voicemail', co.missed)}
        ${tile(`Minutes of ${co.limit.toLocaleString()} (${co.lines} line${co.lines === 1 ? '' : 's'} × 3,000)`, `${Number(co.minutes).toLocaleString()} · ${pct}%`, 'ph-' + tone(pct))}</div>
      <div class="phbar"><span class="ph-${tone(pct)}" style="width:${Math.min(100, pct)}%"></span></div>
      <small class="hint">Minutes are pooled across the whole company. Admins and the billing contact get an email at 90%, 95% and 100%, and a notice in Review.</small>
      ${(u.people || []).length ? `<h3>By person</h3><div class="phrows">${u.people.map((p) => `<div class="prow"><span>${esc(p.name || '')}</span><div>${p.calls_in} in · ${p.calls_out} out · ${p.minutes} min</div></div>`).join('')}</div>` : ''}</div>` : ''}`;
}
// admins on the dashboard: the pool in color
export async function dashTile(box) {
  if (!box || !on() || !C.isAdmin()) return;
  const { data: u } = await sb.rpc('phone_usage', { p_month: null });
  const co = u?.company; if (!co?.limit) return;
  const pct = Math.round(100 * co.minutes / co.limit);
  box.innerHTML = `<div class="card"><div class="toolbar"><h2 style="margin:0;flex:1">Phone this month</h2><button class="btn ghost small" data-nav="phoneusage">Usage</button></div>
    <div class="phtiles"><div class="phtile"><b>${co.calls_in}</b><small>Calls in</small></div><div class="phtile"><b>${co.calls_out}</b><small>Calls out</small></div>
      <div class="phtile ph-${tone(pct)}"><b>${pct}%</b><small>${Number(co.minutes).toLocaleString()} of ${co.limit.toLocaleString()} min</small></div></div></div>`;
  $$('[data-nav]', box).forEach((b) => (b.onclick = () => C.go(b.dataset.nav)));
}

/* ================= Review: usage alerts ================= */
export async function reviewBox(box) {
  if (!box || !on() || !C.isAdmin()) return;
  const { data } = await sb.rpc('phone_review');
  if (!data?.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<h2 class="section">Phone minutes (${data.length})</h2>${data.map((a) => `<div class="card"><div class="toolbar"><b style="flex:1">${a.level >= 100 ? 'Over the monthly pool' : `At ${a.level}% of the monthly pool`}</b><small>${esc(C.fmtDate(a.at))}</small></div>
    <p>${Number(a.minutes).toLocaleString()} of ${Number(a.limit).toLocaleString()} pooled minutes used in ${esc(new Date(a.month + 'T12:00').toLocaleDateString(undefined, { month: 'long' }))}.</p>
    <div class="actions"><button class="btn small" data-nav="phoneusage">See usage</button><button class="btn secondary small" data-pclr="${a.month}|${a.level}">Got it</button></div></div>`).join('')}`;
  $$('[data-nav]', box).forEach((b) => (b.onclick = () => C.go(b.dataset.nav)));
  $$('[data-pclr]', box).forEach((b) => (b.onclick = async () => { const [m, l] = b.dataset.pclr.split('|'); const { error } = await sb.rpc('phone_review_clear', { p_month: m, p_level: +l }); if (error) return C.fail(error); C.renderShell(); }));
}
export async function reviewCount() {
  if (!on() || !C.isAdmin()) return 0;
  const { data } = await sb.rpc('phone_review').then((r) => r, () => ({ data: [] }));
  return (data || []).length;
}

/* ================= Phone lines (admin) ================= */
async function viewSetup(main) {
  if (!on()) { main.innerHTML = '<h1>Phone lines</h1><p class="empty">Turn on Phone in Settings › Features first.</p>'; return; }
  const [{ data: lines }, { data: me }] = await Promise.all([
    sb.from('phone_lines').select('*').eq('active', true).order('created_at'), sb.rpc('phone_me')]);
  const team = C.staff();
  main.innerHTML = `<h1>Phone lines</h1>
    <p class="hint">Each line is a phone number. A direct line rings one person; a group line (like your main number) rings everyone on it at once, and the first to answer gets the call. Nobody answers in time: voicemail. Everyone on a line gets the phone button at the bottom left.</p>
    ${(lines || []).map((l) => `<form class="card" data-line="${l.id}">
      <div class="toolbar"><h2 style="margin:0;flex:1">${esc(l.name)} <small>${esc(fmt(l.number))}</small></h2>${me?.can_buy ? '<button type="button" class="btn ghost small" data-release>Give back this number</button>' : ''}</div>
      <div class="row"><div><label class="label">Name</label><input type="text" name="name" value="${esc(l.name)}" maxlength="60" required></div>
        <div><label class="label">Kind</label><select name="kind"><option value="group" ${l.kind === 'group' ? 'selected' : ''}>Group: rings everyone checked</option><option value="direct" ${l.kind === 'direct' ? 'selected' : ''}>Direct: rings one person</option></select></div></div>
      <label class="label">Who it rings</label><div class="phchecks">${team.map((u) => `<label><input type="checkbox" name="m" value="${u.id}" ${(l.members || []).includes(u.id) ? 'checked' : ''}> ${esc(u.full_name || u.email)}</label>`).join('')}</div>
      <div class="row"><div><label class="label">Ring for (seconds)</label><input type="number" name="ring_secs" min="10" max="60" value="${l.ring_secs}"></div>
        <div><label class="label">Recording</label><select name="record"><option value="false">Don't record calls</option><option value="true" ${l.record ? 'selected' : ''}>Record every call (+$0.01 a minute)</option></select></div></div>
      <label><input type="checkbox" name="voicemail" ${l.voicemail ? 'checked' : ''}> Voicemail when nobody answers</label>
      <label class="label">Voicemail greeting (read out by a voice; blank uses a standard one)</label><textarea name="greeting" rows="2" maxlength="500" placeholder="Thanks for calling ${esc(S.acct?.name || '')}. We can't get to the phone right now…">${esc(l.greeting || '')}</textarea>
      ${l.record ? '<small class="hint">Some states need everyone on a call to agree to recording. Mention it in your greeting or when you answer.</small>' : ''}
      <div class="actions"><button class="btn small">Save line</button></div></form>`).join('') || '<p class="empty">No phone numbers yet.</p>'}
    ${me?.can_buy ? `<div class="card"><h2>Add a number</h2><p class="hint">Numbers are $25 a month per line, with unlimited calling (fair use: 3,000 minutes per line, pooled across the company). The account is billed from the day it's added.</p>
      <div class="row"><div><label class="label" for="pnArea">Area code</label><input type="text" id="pnArea" inputmode="numeric" maxlength="3" placeholder="228"></div>
        <div><label class="label" for="pnCity">Or city and state</label><div style="display:flex;gap:6px"><input type="text" id="pnCity" placeholder="Biloxi"><input type="text" id="pnState" maxlength="2" placeholder="MS" style="max-width:4.5em"></div></div></div>
      <div class="actions"><button class="btn small" id="pnFind">Find numbers</button></div><div id="pnList" class="phrows"></div></div>`
      : '<p class="hint">Need another number or want to move your existing one here? Ask support.</p>'}`;
  $$('form[data-line]', main).forEach((f) => {
    f.onsubmit = async (e) => {
      e.preventDefault(); const d = new FormData(f);
      const p = { name: d.get('name'), kind: d.get('kind'), members: d.getAll('m'), ring_secs: +d.get('ring_secs'), record: d.get('record') === 'true', voicemail: !!d.get('voicemail'), greeting: d.get('greeting') };
      const { error } = await sb.rpc('phone_line_save', { p_id: f.dataset.line, p }); if (error) return C.fail(error);
      C.toast('Line saved'); viewSetup(main);
    };
    if ($('[data-release]', f)) $('[data-release]', f).onclick = async () => {
      if (!confirm('Give this number back? Calls to it stop working right away, and you may not get it back.')) return;
      try { await fn({ kind: 'release', line_id: f.dataset.line }); C.toast('Number given back'); viewSetup(main); } catch (e) { C.fail(e); }
    };
  });
  if ($('#pnFind', main)) $('#pnFind', main).onclick = async () => {
    const list = $('#pnList', main); list.innerHTML = '<p class="empty">Looking…</p>';
    try {
      const r = await fn({ kind: 'search', area_code: $('#pnArea', main).value, city: $('#pnCity', main).value.trim(), state: $('#pnState', main).value.trim() });
      list.innerHTML = (r.numbers || []).map((n) => `<div class="prow"><span>${esc(fmt(n.number))}</span><div>${esc(n.place || '')} <button type="button" class="btn small" data-buy="${esc(n.number)}">Add this number</button></div></div>`).join('') || '<p class="empty">None found. Try a nearby area code.</p>';
      $$('[data-buy]', list).forEach((b) => (b.onclick = async () => {
        const name = prompt('Name this line (like Main line or Julie direct)', (lines || []).length ? 'New line' : 'Main line'); if (name === null) return;
        b.disabled = true;
        try { await fn({ kind: 'buy', number: b.dataset.buy, name }); C.toast('Number added. It can take a minute to start ringing'); viewSetup(main); }
        catch (e) { b.disabled = false; C.fail(e); }
      }));
    } catch (e) { list.innerHTML = ''; C.fail(e); }
  };
}

/* ================= Platform: one-time Telnyx setup ================= */
export async function platformCard(box) {
  if (!box) return;
  box.innerHTML = `<div class="card"><h2>Phone system</h2><p class="hint" id="psStat">Checking Telnyx…</p><div class="actions"><button class="btn small" id="psSetup" hidden>Set up phones</button></div></div>`;
  const show = (r) => {
    $('#psStat', box).textContent = r.ready ? `Ready. Telnyx balance: ${r.balance?.balance != null ? '$' + Number(r.balance.balance).toFixed(2) : r.balance?.error || 'unknown'}` : 'Not set up yet. This makes the calling profile, the call app and the browser phone login on Telnyx, once.';
    $('#psSetup', box).hidden = !!r.ready;
  };
  try { show(await fn({ kind: 'status' })); } catch (e) { $('#psStat', box).textContent = e.message; }
  $('#psSetup', box).onclick = async () => { $('#psSetup', box).disabled = true; try { show(await fn({ kind: 'setup' })); C.toast('Phone system set up'); } catch (e) { $('#psSetup', box).disabled = false; C.fail(e); } };
}
