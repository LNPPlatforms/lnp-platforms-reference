// The public booking page. /book/?a=<account short name>&c=<calendar short name> books a time; /book/?m=<token> is the
// customer's manage link (cancel or reschedule). Add &embed=1 for the version shown inside other sites (embed.js does it).
// Everything goes through the book_* functions (schema/078c and 078d): open times are worked out and checked on the server.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const qs = new URLSearchParams(location.search);
const ACCT = (qs.get('a') || '').trim(), CAL = (qs.get('c') || '').trim(), TOKEN = (qs.get('m') || '').trim(), EMBED = qs.get('embed') === '1';
const root = document.getElementById('root');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, r = root) => r.querySelector(s);
const $$ = (s, r = root) => [...r.querySelectorAll(s)];
const say = (t) => { root.innerHTML = `<div class="state">${t}</div>`; tell(); };
if (EMBED) document.body.classList.add('embed');

// the embed's frame grows to fit
function tell() { if (EMBED && parent !== window) requestAnimationFrame(() => parent.postMessage({ type: 'lnp-book-height', h: document.documentElement.scrollHeight }, '*')); }
new ResizeObserver(tell).observe(document.body);

const guessTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'; } catch { return 'America/Chicago'; } };
let TZ = guessTz();
const TZS = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'];
const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const longWhen = (iso) => new Date(iso).toLocaleString([], { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const tzName = () => { try { return new Date().toLocaleTimeString([], { timeZone: TZ, timeZoneName: 'short' }).split(' ').pop(); } catch { return TZ; } };
const LOC = { phone: 'Phone call', video: 'Video call', in_person: 'In person', customer: 'At your place' };
const lenText = (m) => (m % 60 === 0 ? `${m / 60} ${m === 60 ? 'hour' : 'hours'}` : m > 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`);
const errMsg = (e) => String(e?.message || e || 'Something went wrong').replace(/^(ERROR|P0001):\s*/, '');

function brand(b) {
  if (!b) return '';
  if (/^#[0-9a-f]{6}$/i.test(b.color || '')) document.body.style.setProperty('--brand', b.color);
  return EMBED ? '' : `<div class="top">${b.logo ? `<img src="${esc(b.logo)}" alt="${esc(b.name)}">` : `<b>${esc(b.name)}</b>`}</div>`;
}
const tzPicker = () => `<div class="tzrow">Times shown in <select id="tz" aria-label="Time zone">${[...new Set([...TZS, guessTz(), TZ])].map((z) => `<option value="${esc(z)}" ${z === TZ ? 'selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`).join('')}</select></div>`;

/* ---------- a month picker with open days, then the times on the day picked ---------- */
function picker(box, { fetchSlots, onPick, ahead = 60 }) {
  const today = new Date(); let ym = [today.getFullYear(), today.getMonth()]; let slots = {}; let sel = null; let seq = 0;
  const last = new Date(Date.now() + ahead * 86400000);
  async function load() {
    const my = ++seq;
    const [y, m] = ym; const from = new Date(Date.UTC(y, m, 1) - 86400000), to = new Date(Date.UTC(y, m + 1, 1) + 86400000);
    box.innerHTML = '<div class="state" style="padding:30px">Finding open times…</div>'; tell();
    let list = [];
    try { list = (await fetchSlots(from.toISOString(), to.toISOString())) || []; } catch (e) { box.innerHTML = `<p class="err">${esc(errMsg(e))}</p>`; return; }
    if (my !== seq) return;
    slots = {}; list.forEach((iso) => { (slots[dayKey(iso)] ||= []).push(iso); });
    const monthKey = `${y}-${String(m + 1).padStart(2, '0')}`;
    const days = Object.keys(slots).filter((k) => k.startsWith(monthKey)).sort();
    if (!sel || !slots[sel]) sel = days[0] || null;
    draw();
  }
  function draw() {
    const [y, m] = ym; const first = new Date(y, m, 1); const n = new Date(y, m + 1, 0).getDate();
    const canBack = y > today.getFullYear() || (y === today.getFullYear() && m > today.getMonth());
    const canFwd = new Date(y, m + 1, 1) <= last;
    const k = (d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    box.innerHTML = `<div class="cols"><div><div class="mhead"><button type="button" class="nav" id="pv" ${canBack ? '' : 'disabled'} aria-label="Last month">‹</button>
        <b>${esc(first.toLocaleDateString([], { month: 'long', year: 'numeric' }))}</b><button type="button" class="nav" id="nx" ${canFwd ? '' : 'disabled'} aria-label="Next month">›</button></div>
      <div class="month">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<div class="dh">${d}</div>`).join('')}${'<div></div>'.repeat(first.getDay())}
        ${[...Array(n)].map((_, i) => { const key = k(i + 1); const open = !!slots[key]; return `<button type="button" class="${open ? 'open' : ''} ${sel === key ? 'on' : ''}" ${open ? `data-d="${key}"` : 'disabled'} aria-label="${esc(key)}${open ? ', open' : ''}">${i + 1}</button>`; }).join('')}</div>
      ${tzPicker()}</div>
      <div>${sel ? `<b>${esc(new Date(sel + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))}</b>
        <div class="times" style="margin-top:8px">${slots[sel].map((iso) => `<button type="button" data-t="${esc(iso)}">${esc(timeOf(iso))}</button>`).join('')}</div>`
        : '<p class="hint" style="margin-top:40px">No open times this month. Try the next one.</p>'}</div></div>`;
    $('#pv', box).onclick = () => { ym = m === 0 ? [y - 1, 11] : [y, m - 1]; sel = null; load(); };
    $('#nx', box).onclick = () => { ym = m === 11 ? [y + 1, 0] : [y, m + 1]; sel = null; load(); };
    $$('[data-d]', box).forEach((b) => (b.onclick = () => { sel = b.dataset.d; draw(); }));
    $$('[data-t]', box).forEach((b) => (b.onclick = () => onPick(b.dataset.t)));
    $('#tz', box).onchange = (e) => { TZ = e.target.value; sel = null; load(); };
    tell();
  }
  load();
  return { reload: load };
}

/* ---------- booking ---------- */
async function bookPage() {
  if (!/^[a-z0-9-]{1,60}$/i.test(ACCT) || !/^[a-z0-9-]{1,60}$/i.test(CAL)) return say('This booking link is missing a part. Check the link you were sent.');
  const { data: info, error } = await sb.rpc('book_info', { p_account: ACCT, p_cal: CAL });
  if (error) return say('We couldn\'t load this right now. Refresh the page to try again.');
  if (!info) return say('This calendar isn\'t taking bookings right now.');
  document.title = `${info.name} · ${info.brand?.name || 'Book a time'}`;
  const st = { len: info.duration, who: info.kind === 'pick' ? info.team?.[0]?.id || null : null, start: null };
  const head = () => `${brand(info.brand)}<h1>${esc(info.name)}</h1>
    <p class="meta"><span>⏱ ${esc(lenText(st.len))}</span><span>📍 ${esc(info.location || LOC[info.location_kind] || '')}</span>${info.with ? `<span>👤 ${esc(info.with)}</span>` : ''}</p>
    ${info.description ? `<p class="desc">${esc(info.description)}</p>` : ''}`;
  const choose = () => {
    root.innerHTML = `${head()}
      ${info.lengths.length > 1 ? `<label>How long</label><div class="pick" id="lens">${info.lengths.map((l) => `<button type="button" data-l="${l}" class="${l === st.len ? 'on' : ''}">${esc(lenText(l))}</button>`).join('')}</div>` : ''}
      ${info.kind === 'pick' && info.team?.length ? `<label>Who you'd like to meet with</label><div class="pick" id="who">${info.team.map((u) => `<button type="button" data-u="${esc(u.id)}" class="${u.id === st.who ? 'on' : ''}">${esc(u.name)}</button>`).join('')}</div>` : ''}
      <div id="pk"></div>`;
    $$('[data-l]').forEach((b) => (b.onclick = () => { st.len = Number(b.dataset.l); choose(); }));
    $$('[data-u]').forEach((b) => (b.onclick = () => { st.who = b.dataset.u; choose(); }));
    picker($('#pk'), {
      ahead: info.ahead_days,
      fetchSlots: async (from, to) => { const { data, error: e } = await sb.rpc('book_slots', { p_account: ACCT, p_cal: CAL, p_from: from, p_to: to, p_duration: st.len, p_user: st.who }); if (e) throw e; return data; },
      onPick: (iso) => { st.start = iso; form(); },
    });
  };
  const form = () => {
    const q = info.questions || [];
    root.innerHTML = `${head()}<div class="chosen"><b>${esc(longWhen(st.start))}</b> <span class="hint">(${esc(tzName())})</span> <button type="button" class="link" id="back">Change</button></div>
      <form id="f" novalidate>
        <div class="row"><div><label for="n">Your name</label><input id="n" name="name" maxlength="200" required autocomplete="name"></div>
          <div><label for="e">Email</label><input id="e" name="email" type="email" maxlength="320" required autocomplete="email"></div></div>
        <div class="row"><div><label for="p">Phone${info.location_kind === 'phone' ? '' : ' (optional)'}</label><input id="p" name="phone" type="tel" maxlength="40" autocomplete="tel"></div>
          ${info.ask_company ? '<div><label for="co">Company</label><input id="co" name="company" maxlength="200" autocomplete="organization"></div>' : '<div></div>'}</div>
        ${info.location_kind === 'customer' ? '<label for="ad">Address where we\'re meeting</label><input id="ad" name="address" maxlength="300" autocomplete="street-address">' : ''}
        ${q.map((x) => `<label for="q_${esc(x.key)}">${esc(x.label)}${x.required ? '' : ' (optional)'}</label>${x.kind === 'long' ? `<textarea id="q_${esc(x.key)}" data-q="${esc(x.key)}" maxlength="4000"></textarea>`
          : x.kind === 'choice' ? `<select id="q_${esc(x.key)}" data-q="${esc(x.key)}"><option value="">Pick one</option>${(x.options || []).map((o) => `<option>${esc(o)}</option>`).join('')}</select>`
          : `<input id="q_${esc(x.key)}" data-q="${esc(x.key)}" maxlength="500">`}`).join('')}
        <div class="hp" aria-hidden="true"><label for="website">Website</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
        <button type="submit" class="go" id="go">Book it</button><div class="err" id="err" role="alert"></div></form>`;
    $('#back').onclick = choose;
    $('#n').focus();
    $('#f').onsubmit = async (ev) => {
      ev.preventDefault();
      const err = $('#err'), go = $('#go'); err.textContent = '';
      const v = (id) => ($('#' + id)?.value || '').trim();
      if (!v('n')) return (err.textContent = 'Add your name.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('e'))) return (err.textContent = 'Add a good email address so we can send the details.');
      if (info.location_kind === 'phone' && v('p').replace(/\D/g, '').length < 7) return (err.textContent = 'Add a phone number we can call.');
      if (info.location_kind === 'customer' && !v('ad')) return (err.textContent = 'Add the address where we\'re meeting.');
      const answers = {}; for (const x of q) { const a = ($(`[data-q="${x.key}"]`)?.value || '').trim(); if (x.required && !a) return (err.textContent = `Please answer: ${x.label}`); if (a) answers[x.key] = a; }
      go.disabled = true; go.textContent = 'Booking…';
      const { data, error: e } = await sb.rpc('book_make', { p_account: ACCT, p_cal: CAL, p_start: st.start, p_duration: st.len, p_user: st.who,
        p: { name: v('n'), email: v('e'), phone: v('p') || null, company: v('co') || null, address: v('ad') || null, answers, tz: TZ, website: v('website') } });
      if (e) {
        go.disabled = false; go.textContent = 'Book it'; err.textContent = errMsg(e);
        if (/just taken/i.test(e.message || '')) { const b = document.createElement('button'); b.type = 'button'; b.className = 'link'; b.textContent = ' Pick another time'; b.onclick = choose; err.appendChild(b); }
        return;
      }
      if (data?.redirect_url && /^https:\/\//.test(data.redirect_url)) { (EMBED ? top : window).location.href = data.redirect_url; return; }
      done(data);
    };
    tell();
  };
  const done = (d) => {
    root.innerHTML = `${brand(info.brand)}<div class="ok"><div class="big">✓</div><h1>You're booked</h1>
      <p><b>${esc(info.name)}</b><br>${esc(longWhen(d.starts_at || st.start))} (${esc(tzName())})${d.with ? `<br>with ${esc(d.with)}` : ''}${d.location ? `<br>${esc(d.location)}` : ''}</p>
      <p class="desc">${esc(d.confirm_text || 'We emailed you the details with a calendar file. Use the link in that email if you need to change it.')}</p>
      ${d.token ? `<p><a href="?m=${esc(d.token)}${EMBED ? '&embed=1' : ''}" class="link">Change or cancel</a></p>` : ''}</div>`;
    tell();
  };
  choose();
}

/* ---------- the manage link ---------- */
async function managePage() {
  if (!/^[a-f0-9]{64}$/.test(TOKEN)) return say('This link is missing its code. Check the link in your email.');
  const { data: m, error } = await sb.rpc('book_manage', { p_token: TOKEN });
  if (error) return say('We couldn\'t load this right now. Refresh the page to try again.');
  if (!m) return say('We couldn\'t find that booking.');
  document.title = `${m.title} · ${m.brand?.name || 'Your booking'}`;
  const len = Math.round((new Date(m.ends_at) - new Date(m.starts_at)) / 60000);
  const status = { cancelled: 'Cancelled', completed: 'Done', no_show: 'Missed', rescheduled: 'Booked', confirmed: 'Confirmed', booked: 'Booked' }[m.status] || m.status;
  const show = (msg = '') => {
    root.innerHTML = `${brand(m.brand)}<h1>${esc(m.title)}</h1>
      <p class="meta"><span>${esc(status)}</span><span>⏱ ${esc(lenText(len))}</span>${m.with ? `<span>👤 ${esc(m.with)}</span>` : ''}</p>
      <div class="chosen"><b>${esc(longWhen(m.starts_at))}</b> <span class="hint">(${esc(tzName())})</span>${m.location ? `<br>${esc(m.location)}` : ''}</div>
      ${msg ? `<p class="desc"><b>${esc(msg)}</b></p>` : ''}
      ${m.status === 'cancelled' ? '' : `${m.can_reschedule ? '<button type="button" class="go" id="rs">Pick a new time</button>' : ''}${m.can_cancel ? '<button type="button" class="go ghost" id="cx">Cancel it</button>' : ''}
        ${!m.can_reschedule && !m.can_cancel ? `<p class="hint">It's too close to the start to change online${m.cutoff_hours ? ` (changes close ${m.cutoff_hours} ${m.cutoff_hours === 1 ? 'hour' : 'hours'} before)` : ''}. Please call or email us.</p>` : ''}`}
      <div id="box"></div>`;
    if ($('#cx')) $('#cx').onclick = () => {
      $('#box').innerHTML = `<label for="why">Want to tell us why? (optional)</label><textarea id="why" maxlength="1000"></textarea><button type="button" class="go" id="cxGo">Yes, cancel it</button><div class="err" id="err"></div>`;
      $('#cxGo').onclick = async (e) => {
        e.target.disabled = true;
        const { error: x } = await sb.rpc('book_cancel', { p_token: TOKEN, p_reason: $('#why').value.trim() || null });
        if (x) { e.target.disabled = false; $('#err').textContent = errMsg(x); return; }
        m.status = 'cancelled'; m.can_cancel = m.can_reschedule = false; show('Your booking is cancelled. We emailed you a note.');
      };
      tell();
    };
    if ($('#rs')) $('#rs').onclick = () => {
      picker($('#box'), {
        ahead: m.ahead_days || 60,
        fetchSlots: async (from, to) => { const { data, error: x } = await sb.rpc('book_manage_slots', { p_token: TOKEN, p_from: from, p_to: to }); if (x) throw x; return data; },
        onPick: async (iso) => {
          if (!confirm(`Move it to ${longWhen(iso)}?`)) return;
          const { data, error: x } = await sb.rpc('book_reschedule', { p_token: TOKEN, p_start: iso });
          if (x) { alert(errMsg(x)); return; }
          m.starts_at = data.starts_at; m.ends_at = data.ends_at; m.with = data.with || m.with; m.status = 'rescheduled';
          show('Done. Your booking has moved and we emailed you the new time.');
        },
      });
    };
    tell();
  };
  show();
}

(TOKEN ? managePage() : bookPage()).catch((e) => say(esc(errMsg(e))));
