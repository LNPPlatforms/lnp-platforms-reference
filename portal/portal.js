/* The client portal (/portal/). A client signs in with their email and password (two-step sign in if they turn it
   on) and sees their organization and the locations under it: schedule, estimates, invoices with the pay button,
   shared documents and job photos, messages with the team, and things waiting on their approval. Their admin also
   gets a Team tab to invite their own people and set what each one sees. Everything comes from the portal_*
   database functions (schema/074*), which check the login every time; this page only draws it.
   ?preview=<organization id> is the CRM's "Preview what they see": the team's own login, read only. */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';
import { docHtml, fromProposal, money, DOC_CSS } from '../doc/layout.js?v=20261116t';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
const app = document.getElementById('app');
const qs = new URLSearchParams(location.search);
const PREVIEW = /^[0-9a-f-]{36}$/i.test(qs.get('preview') || '') ? qs.get('preview') : null;
const ACCOUNT = (qs.get('a') || '').trim().toLowerCase();
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const day = (s) => (s ? new Date(String(s).length === 10 ? s + 'T12:00:00' : s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const time = (s) => (s ? new Date(s).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');
const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? v : '#1A2A52');
let toastT;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), bad ? 6000 : 3000);
}
const fail = (e) => toast(e?.message || 'Something went wrong. Try again.', true);
async function rpc(name, args) { const { data, error } = await sb.rpc(name, args); if (error) throw error; return data; }

document.getElementById('docCss').textContent = DOC_CSS;
let BRAND = {}, CTX = null, HOME = null, POLL = null;
function setBrand(b) {
  BRAND = b || {};
  document.documentElement.style.setProperty('--brand', hex(BRAND.color));
  document.querySelector('meta[name=theme-color]').content = hex(BRAND.color);
  document.title = (BRAND.name ? BRAND.name + ' | ' : '') + 'Client portal';
}
const logo = () => (BRAND.logo ? `<img src="${esc(BRAND.logo)}" alt="${esc(BRAND.name || '')}">` : `<b>${esc(BRAND.name || 'Client portal')}</b>`);

/* ================= signing in ================= */
async function preBrand() {
  let b = null;
  if (ACCOUNT) b = (await sb.rpc('portal_brand', { p_account: ACCOUNT })).data;
  if (!b) { const w = (await sb.rpc('brand_for_host', { p_host: location.host })).data; if (w) b = { name: w.name, logo: w.logo_url, color: w.primary_color }; }
  setBrand(b || {});
}
function authCard(inner) {
  app.innerHTML = `<div class="auth"><div class="logo">${logo(true)}</div><div class="card">${inner}</div>
    <p class="foot">Client portal${BRAND.name ? ' for ' + esc(BRAND.name) : ''}</p></div>`;
}
function renderAuth(mode = 'in', email = '') {
  authCard(`<h2>${mode === 'in' ? 'Sign in to your portal' : mode === 'up' ? 'Create your login' : 'Reset your password'}</h2>
    ${mode === 'up' ? '<p class="hint" style="margin-top:0">Use the email address your invite was sent to.</p>' : ''}
    <form id="af">${mode === 'up' ? '<label class="l" for="aN">Your name</label><input type="text" id="aN" autocomplete="name" required>' : ''}
      <label class="l" for="aE">Email</label><input type="email" id="aE" autocomplete="email" required value="${esc(email)}">
      ${mode !== 'reset' ? `<label class="l" for="aP">Password</label><input type="password" id="aP" minlength="8" required autocomplete="${mode === 'in' ? 'current-password' : 'new-password'}">` : ''}
      <div class="err" id="aErr"></div><div class="actions"><button class="btn block">${mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create login' : 'Send reset link'}</button></div></form>
    <div class="actions">${mode === 'in' ? '<button class="btn ghost small" data-m="up">Invited? Create your login</button><button class="btn ghost small" data-m="reset">Forgot password</button>'
      : '<button class="btn ghost small" data-m="in">Back to sign in</button>'}</div>`);
  $$('[data-m]').forEach((b) => (b.onclick = () => { if (location.hash.startsWith('#signup')) history.replaceState(null, '', location.pathname + location.search); renderAuth(b.dataset.m, $('#aE').value); }));
  $('#af').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#aErr'); err.textContent = ''; err.style.color = '';
    const em = $('#aE').value.trim().toLowerCase(), back = location.origin + location.pathname + location.search;
    let r;
    if (mode === 'in') r = await sb.auth.signInWithPassword({ email: em, password: $('#aP').value });
    else if (mode === 'up') r = await sb.auth.signUp({ email: em, password: $('#aP').value, options: { data: { full_name: $('#aN').value.trim() }, emailRedirectTo: back } });
    else r = await sb.auth.resetPasswordForEmail(em, { redirectTo: back });
    if (r.error) {
      err.textContent = /database error saving new user|not_invited/i.test(r.error.message) ? "That email hasn't been invited to a portal yet. Ask whoever invited you to send it again, then use the same email."
        : /invalid login/i.test(r.error.message) ? "That email and password don't match. Try again or reset your password." : r.error.message;
      return;
    }
    if (mode === 'up' && !r.data.session) { err.style.color = 'var(--ok)'; err.textContent = 'Check your email to confirm, then come back and sign in.'; }
    if (mode === 'reset') { err.style.color = 'var(--ok)'; err.textContent = 'Reset link sent. Check your email.'; }
    if (r.data?.session) start();
  };
}
function renderReset() {
  authCard(`<h2>Set a new password</h2><form id="rf"><label class="l" for="rP">New password</label><input type="password" id="rP" minlength="8" required autocomplete="new-password">
    <div class="err" id="rErr"></div><div class="actions"><button class="btn block">Save password</button></div></form>`);
  $('#rf').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: $('#rP').value });
    if (error) { $('#rErr').textContent = error.message; return; }
    toast('Password saved'); start();
  };
}
// two-step sign in: ask for the code when the login has it turned on
async function mfaGate() {
  try {
    const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (!data || data.currentLevel === 'aal2' || data.nextLevel !== 'aal2') return false;
  } catch { return false; }
  const { data: f } = await sb.auth.mfa.listFactors();
  const totp = (f?.totp || []).find((x) => x.status === 'verified');
  if (!totp) return false;
  authCard(`<h2>Two-step sign in</h2><p>Open your authenticator app and type the 6-digit code.</p>
    <form id="mf"><label class="l" for="mC">Code</label><input type="text" id="mC" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>
    <div class="err" id="mErr"></div><div class="actions"><button class="btn block">Continue</button></div></form>
    <div class="actions"><button class="btn ghost small" id="mOut">Sign out</button></div>`);
  $('#mOut').onclick = () => sb.auth.signOut().then(() => start());
  $('#mf').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: totp.id, code: $('#mC').value.trim() });
    if (error) { $('#mErr').textContent = "That code didn't work. Codes change every 30 seconds, so try the newest one."; return; }
    start();
  };
  return true;
}
function dialog(html) {
  const d = document.createElement('dialog'); d.className = 'card'; d.style.maxWidth = '440px'; d.style.width = '92vw';
  d.innerHTML = html; document.body.appendChild(d); d.addEventListener('close', () => d.remove()); d.showModal(); return d;
}
async function mfaSetup() {
  const { data: f } = await sb.auth.mfa.listFactors();
  const on = (f?.totp || []).find((x) => x.status === 'verified');
  if (on) {
    const d = dialog(`<h2>Two-step sign in is on</h2><p>You sign in with your password and a code from your authenticator app.</p>
      <div class="actions"><button class="btn ghost small danger" id="mfOff">Turn it off</button><button class="btn ghost small" id="mfX">Close</button></div>`);
    $('#mfX', d).onclick = () => d.close();
    $('#mfOff', d).onclick = async () => { const { error } = await sb.auth.mfa.unenroll({ factorId: on.id }); if (error) return fail(error); toast('Two-step sign in is off'); d.close(); };
    return;
  }
  for (const x of (f?.all || []).filter((x) => x.status !== 'verified')) await sb.auth.mfa.unenroll({ factorId: x.id });
  const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Portal ' + new Date().toISOString().slice(0, 10) });
  if (error) return fail(error);
  const d = dialog(`<h2>Set up two-step sign in</h2><p>1. Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy).</p>
    <div class="mfaqr"><img src="${esc(data.totp.qr_code)}" alt="Scan this with your authenticator app" width="190" height="190"></div>
    <p class="hint">Can't scan? Type this key into the app: <code>${esc(data.totp.secret)}</code></p><p>2. Type the 6-digit code it shows.</p>
    <form id="mfV"><input type="text" id="mfC" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required aria-label="Code">
    <div class="actions"><button class="btn">Turn it on</button><button type="button" class="btn ghost" id="mfX">Cancel</button></div></form>`);
  $('#mfX', d).onclick = () => d.close();
  $('#mfV', d).onsubmit = async (e) => {
    e.preventDefault();
    const { error: e2 } = await sb.auth.mfa.challengeAndVerify({ factorId: data.id, code: $('#mfC', d).value.trim() });
    if (e2) return toast("That code didn't work. Try the newest one.", true);
    toast('Two-step sign in is on'); d.close();
  };
}

/* ================= start ================= */
let PORTALS = [];
async function start() {
  clearInterval(POLL);
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    await preBrand();
    if (PREVIEW) return authCard('<h2>Preview</h2><p>Sign in to the CRM first, then use Preview what they see on the organization again.</p>');
    const m = location.hash.match(/^#signup(?:\/(.+))?/);
    return m ? renderAuth('up', m[1] ? decodeURIComponent(m[1]) : '') : renderAuth();
  }
  if (await mfaGate()) return;
  if (PREVIEW) { CTX = PREVIEW; return loadHome(); }
  let me;
  try { me = await rpc('portal_me'); } catch (e) { await preBrand(); return authCard(`<h2>We couldn't load your portal</h2><p>${esc(e.message)}</p><div class="actions"><button class="btn" onclick="location.reload()">Try again</button></div>`); }
  if (me?.crm) {
    await preBrand();
    return authCard(`<h2>This is a team login</h2><p>You're signed in with a CRM login. The client portal is for your clients. To see what a client sees, open their organization in the CRM and use Preview what they see.</p>
      <div class="actions"><a class="btn" href="/">Open the CRM</a><button class="btn ghost" id="out">Sign out</button></div>`), ($('#out').onclick = () => sb.auth.signOut().then(() => start()));
  }
  PORTALS = me?.portals || [];
  if (!PORTALS.length) {
    await preBrand();
    authCard(`<h2>No portal here yet</h2><p>Your login works, but no business has given it portal access right now. If you think that's wrong, ask whoever invited you.</p>
      <div class="actions"><button class="btn ghost" id="out">Sign out</button></div>`);
    $('#out').onclick = () => sb.auth.signOut().then(() => start());
    return;
  }
  const saved = localStorage.getItem('portalCtx');
  CTX = (PORTALS.find((p) => p.id === saved) || PORTALS[0]).id;
  loadHome();
}

const TABS = [['home', 'Home'], ['schedule', 'Schedule', 'schedule'], ['estimates', 'Estimates', 'estimates'], ['invoices', 'Invoices', 'invoices'],
  ['files', 'Files and photos', 'files'], ['messages', 'Messages', 'messages'], ['approvals', 'Approvals', 'approvals'], ['team', 'Team']];
const lv = (a) => Number(HOME?.levels?.[a] || 0);
const tabOk = (t) => (t[0] === 'team' ? HOME.is_admin && !HOME.preview : !t[2] || lv(t[2]) > 0);
async function loadHome() {
  try { HOME = await rpc('portal_home', { p_ctx: CTX }); } catch (e) {
    return authCard(`<h2>We couldn't open this portal</h2><p>${esc(e.message)}</p><div class="actions"><button class="btn ghost" id="out">Sign out</button></div>`), ($('#out').onclick = () => sb.auth.signOut().then(() => start()));
  }
  setBrand(HOME.brand);
  shell();
}
function route() { const [v, p] = location.hash.replace(/^#/, '').split('/'); return { v: /access_token|type=/.test(v) ? 'home' : v || 'home', p }; }
function go(v, p) { location.hash = v + (p ? '/' + p : ''); }
addEventListener('hashchange', () => { if (HOME) shell(); });

function shell() {
  clearInterval(POLL);
  const { v, p } = route();
  const tab = TABS.find((t) => t[0] === v && tabOk(t)) ? v : ['estimate', 'invoice'].includes(v) ? v : 'home';
  const c = HOME.counts || {};
  const dots = { estimates: c.estimates, approvals: c.approvals, invoices: c.open_invoices };
  const other = PORTALS.length > 1;
  app.innerHTML = `<header class="top"><div class="topin"><div class="brand">${logo()}<span style="min-width:0"><small>${esc(HOME.org || '')}</small></span></div>
      <div class="menu"><button type="button" class="btn ghost small" id="me" aria-haspopup="true">${esc(HOME.preview ? 'Preview' : (HOME.me?.name || HOME.me?.email || 'Me').split(' ')[0])} ▾</button>
        <div class="pop" id="mePop" hidden>${HOME.me ? `<small>${esc(HOME.me.email)}</small>` : ''}
          ${other ? PORTALS.map((x) => `<button type="button" data-ctx="${x.id}">${x.id === CTX ? '✓ ' : ''}${esc(x.org)} <span class="hint">${esc(x.account)}</span></button>`).join('') : ''}
          ${HOME.preview ? '' : '<button type="button" id="mMfa">Two-step sign in</button><button type="button" id="mOut">Sign out</button>'}</div></div></div>
    <nav class="tabs" aria-label="Portal">${TABS.filter(tabOk).map((t) => `<button type="button" data-tab="${t[0]}" class="${tab === t[0] || (tab === 'invoice' && t[0] === 'invoices') || (tab === 'estimate' && t[0] === 'estimates') ? 'on' : ''}">${esc(t[1])}${dots[t[0]] ? `<span class="dot">${dots[t[0]]}</span>` : ''}</button>`).join('')}</nav></header>
    <main id="view">${HOME.preview ? '<div class="banner">Preview: this is what this client sees. Buttons to pay, accept, approve and send are turned off here.</div>' : ''}<div id="pv"><p class="empty">Loading…</p></div></main>
    <footer class="foot">${esc(BRAND.name || '')}${BRAND.phone ? ' · ' + esc(BRAND.phone) : ''}${BRAND.email ? ` · <a href="mailto:${esc(BRAND.email)}">${esc(BRAND.email)}</a>` : ''}</footer>`;
  $$('[data-tab]').forEach((b) => (b.onclick = () => go(b.dataset.tab)));
  const pop = $('#mePop');
  $('#me').onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; };
  document.onclick = () => (pop.hidden = true);
  $$('[data-ctx]').forEach((b) => (b.onclick = () => { CTX = b.dataset.ctx; localStorage.setItem('portalCtx', CTX); go('home'); loadHome(); }));
  if ($('#mMfa')) $('#mMfa').onclick = () => mfaSetup();
  if ($('#mOut')) $('#mOut').onclick = () => sb.auth.signOut().then(() => { HOME = null; location.hash = ''; start(); });
  const box = $('#pv');
  const views = { home, schedule, estimates: (b) => docs(b, 'estimates'), invoices: (b) => docs(b, 'invoices'), estimate: (b) => doc(b, 'estimate', p), invoice: (b) => doc(b, 'invoice', p),
    files, messages, approvals, team };
  Promise.resolve(views[tab](box)).catch((e) => { box.innerHTML = `<p class="empty">${esc(e.message || 'We couldn\'t load this. Refresh to try again.')}</p>`; });
}

/* ================= home ================= */
function home(box) {
  const c = HOME.counts || {};
  const tiles = [
    lv('schedule') && ['schedule', c.next_visit ? day(c.next_visit) : 'None set', c.next_visit ? `Next visit, ${time(c.next_visit)}` : 'Next visit'],
    lv('invoices') && ['invoices', money(c.balance || 0), `${c.open_invoices || 0} open ${c.open_invoices === 1 ? 'invoice' : 'invoices'}`],
    lv('estimates') && ['estimates', c.estimates || 0, 'Waiting on you'],
    lv('approvals') && ['approvals', c.approvals || 0, 'Needs your approval'],
    lv('messages') && ['messages', '✉', 'Message the team'],
  ].filter(Boolean);
  box.innerHTML = `<h1>Hi${HOME.me?.name ? ', ' + esc(HOME.me.name.split(' ')[0]) : ''}</h1>
    ${HOME.welcome ? `<div class="welcome">${esc(HOME.welcome).replace(/\n/g, '<br>')}</div>` : ''}
    <div class="tiles">${tiles.map(([t, b, s]) => `<button type="button" class="tile" data-go="${t}"><b>${esc(b)}</b><span>${esc(s)}</span></button>`).join('')}</div>
    ${HOME.locations?.length ? `<div class="card"><h2>Your locations</h2><p class="hint" style="margin:0">${HOME.locations.map((l) => esc(l.name)).join(', ')}</p></div>` : ''}
    ${!tiles.length ? '<p class="empty">Nothing to show here yet.</p>' : ''}`;
  $$('[data-go]', box).forEach((b) => (b.onclick = () => go(b.dataset.go)));
}

/* ================= schedule ================= */
const STATUS = { scheduled: ['Scheduled', ''], accepted: ['Confirmed', ''], en_route: ['On the way', 'gold'], arrived: ['Crew is there', 'gold'], started: ['In progress', 'gold'],
  completed: ['Done', 'ok'], left: ['Done', 'ok'], cancelled: ['Cancelled', 'due'], no_show: ['Missed', 'due'] };
async function schedule(box) {
  const rows = await rpc('portal_schedule', { p_ctx: CTX });
  const now = Date.now();
  const up = rows.filter((j) => new Date(j.start) >= now - 3 * 3600e3 && !['completed', 'left', 'cancelled'].includes(j.status));
  const past = rows.filter((j) => !up.includes(j)).reverse();
  const row = (j) => { const d = new Date(j.start), st = STATUS[j.status] || [j.status, ''];
    return `<div class="row"><div class="when"><small>${d.toLocaleDateString(undefined, { month: 'short' })}</small><b>${d.getDate()}</b><small>${d.toLocaleDateString(undefined, { weekday: 'short' })}</small></div>
      <div class="grow"><b>${esc(j.title)}</b> <span class="badge ${st[1]}">${esc(st[0])}</span><small>${esc([time(j.start) + (j.end ? ' to ' + time(j.end) : ''), j.service, HOME.locations?.length ? j.location : ''].filter(Boolean).join(' · '))}</small>
      ${j.note ? `<small style="color:var(--ink)">${esc(j.note)}</small>` : ''}</div></div>`; };
  box.innerHTML = `<h1>Schedule</h1><div class="card"><h2>Coming up</h2>${up.map(row).join('') || '<p class="empty" style="margin:0">Nothing on the schedule right now.</p>'}</div>
    ${past.length ? `<div class="card"><h2>Recent</h2>${past.slice(0, 30).map(row).join('')}</div>` : ''}`;
}

/* ================= estimates and invoices ================= */
const INV = { sent: ['Open', ''], partial: ['Partly paid', 'gold'], paid: ['Paid', 'ok'] };
async function docs(box, kind) {
  const rows = await rpc('portal_docs', { p_ctx: CTX, p_kind: kind });
  if (kind === 'invoices') {
    box.innerHTML = `<h1>Invoices</h1><div class="card">${rows.map((i) => { const st = i.overdue ? ['Past due', 'due'] : INV[i.status] || [i.status, ''];
      return `<div class="row"><div class="grow"><b>Invoice ${esc(i.number)}</b> <span class="badge ${st[1]}">${esc(st[0])}</span>
        <small>${esc([day(i.issue_date), i.due_date && i.balance > 0 ? 'due ' + day(i.due_date) : '', HOME.locations?.length ? i.location : ''].filter(Boolean).join(' · '))}</small></div>
        <div style="text-align:right"><b>${esc(money(i.balance > 0 ? i.balance : i.total))}</b><small class="hint" style="display:block">${i.balance > 0 ? 'due' : 'total'}</small></div>
        <button type="button" class="btn ${i.can_pay ? '' : 'ghost'} small" data-open="${i.id}">${i.can_pay ? 'View and pay' : 'View'}</button></div>`; }).join('') || '<p class="empty" style="margin:0">No invoices yet.</p>'}</div>`;
    $$('[data-open]', box).forEach((b) => (b.onclick = () => go('invoice', b.dataset.open)));
    return;
  }
  box.innerHTML = `<h1>Estimates</h1><div class="card">${rows.map((p) => { const st = p.status === 'accepted' ? ['Accepted', 'ok'] : p.expired ? ['Expired', 'due'] : ['Waiting on you', 'gold'];
    return `<div class="row"><div class="grow"><b>${esc(p.title)}${p.version > 1 ? ' v' + p.version : ''}</b> <span class="badge ${st[1]}">${esc(st[0])}</span>
      <small>${esc([p.sent_at ? 'sent ' + day(p.sent_at) : '', p.status === 'sent' && p.expires_at && !p.expired ? 'good until ' + day(p.expires_at) : '', p.accepted_at ? 'accepted ' + day(p.accepted_at) : '', HOME.locations?.length ? p.location : ''].filter(Boolean).join(' · '))}</small></div>
      <button type="button" class="btn ${p.can_accept ? '' : 'ghost'} small" data-open="${p.id}">${p.can_accept ? 'Review' : 'View'}</button></div>`; }).join('') || '<p class="empty" style="margin:0">No estimates yet.</p>'}</div>`;
  $$('[data-open]', box).forEach((b) => (b.onclick = () => go('estimate', b.dataset.open)));
}
async function doc(box, kind, id) {
  const d = await rpc('portal_doc', { p_ctx: CTX, p_kind: kind, p_id: id });
  let html;
  if (d.kind === 'proposal') {
    const acc = d.view?.accepted;
    const btn = acc ? `<div class="doc-status">Accepted by ${esc(acc.name || '')} on ${esc(day(acc.at))}</div>`
      : d.status === 'sent' && d.link ? `<a class="doc-paybtn" href="${esc(d.link)}">Review, accept and sign</a>` : '';
    html = docHtml(fromProposal(d), { acceptButton: btn });
  } else {
    const showPay = d.link && d.pay?.method && Number(d.balance) > 0;
    const status = d.status === 'paid' ? '<div class="doc-status">Paid in full. Thank you!</div>' : '';
    const ap = d.autopay?.on ? d.autopay : null;   // autopay on a repeating invoice (083a)
    const apBits = !ap ? '' : `<div class="doc-desc" style="margin-top:8px">${ap.failed ? 'The automatic payment didn\'t go through. Pay here or update your card.'
      : ap.saved ? `Automatic payments go to ${esc(ap.label || 'your saved payment method')}.` : 'Paying online also saves your card or bank for automatic payments on the next invoices.'}</div>
      ${d.link && (ap.saved || Number(d.balance) <= 0) ? `<div style="margin-top:6px"><a href="${esc(d.link)}&card=1">${ap.saved ? 'Update the card or bank on file' : 'Save a card or bank for automatic payments'}</a></div>` : ''}`;
    html = docHtml(d, { status, payButton: (showPay && !(ap?.saved && !ap.failed) ? `<a class="doc-paybtn" href="${esc(d.link)}&pay=1">Pay ${esc(money(d.balance))}</a>` : '') + apBits });
  }
  box.innerHTML = `<div class="docbar"><button type="button" class="btn ghost small" id="dBack">‹ Back</button><span style="flex:1"></span><button type="button" class="btn ghost small" id="dPrint">Print or save as PDF</button></div>
    <div class="docwrap">${html}</div>`;
  $('#dBack').onclick = () => go(kind === 'invoice' ? 'invoices' : 'estimates');
  $('#dPrint').onclick = () => window.print();
}

/* ================= files and photos ================= */
async function files(box) {
  const r = await rpc('portal_files', { p_ctx: CTX });
  const paths = (r.photos || []).map((p) => p.path);
  let urls = {};
  if (paths.length) { const { data } = await sb.storage.from('job-photos').createSignedUrls(paths, 3600); urls = Object.fromEntries((data || []).filter((x) => x.signedUrl).map((x) => [x.path, x.signedUrl])); }
  box.innerHTML = `<h1>Files and photos</h1>
    <div class="card"><h2>Documents</h2>${(r.files || []).map((f) => `<div class="row"><div class="grow"><b>${esc(f.title)}</b><small>${esc([day(f.at), HOME.locations?.length ? f.location : ''].filter(Boolean).join(' · '))}</small></div>
      <a class="btn ghost small" href="${esc(f.url)}" target="_blank" rel="noopener">Open</a></div>`).join('') || '<p class="empty" style="margin:0">No documents shared yet.</p>'}</div>
    <div class="card"><h2>Job photos</h2>${(r.photos || []).length ? `<div class="photos">${r.photos.filter((p) => urls[p.path]).map((p) => `<figure style="margin:0"><a href="${esc(urls[p.path])}" target="_blank" rel="noopener"><img src="${esc(urls[p.path])}" alt="${esc(p.job)}" loading="lazy"></a>
      <figcaption>${esc(p.job)} · ${esc(day(p.at))}</figcaption></figure>`).join('')}</div>` : '<p class="empty" style="margin:0">No photos shared yet.</p>'}</div>`;
}

/* ================= messages ================= */
async function messages(box) {
  let sig = '';
  const draw = async (first) => {
    const r = await rpc('portal_messages', { p_ctx: CTX });
    const s = JSON.stringify(r.messages); if (s === sig && !first) return; sig = s;
    const list = $('#msgs', box);
    const html = r.messages.map((m) => `<div class="msg ${m.from === 'me' ? 'me' : ''}">${esc(m.body)}<small>${esc(m.from === 'me' ? 'You' : m.name || (m.from === 'team' ? 'Team' : ''))} · ${esc(new Date(m.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</small></div>`).join('')
      || `<p class="empty">Questions about a visit, an estimate or a bill? Send a message and ${esc(BRAND.name || 'the team')} will answer here.</p>`;
    if (list) { list.innerHTML = html; list.scrollTop = list.scrollHeight; return; }
    box.innerHTML = `<h1>Messages</h1><div class="card"><div class="msgs" id="msgs">${html}</div>
      ${r.can_send ? '<form class="compose" id="mf"><textarea id="mT" maxlength="4000" placeholder="Type a message" aria-label="Message"></textarea><button class="btn">Send</button></form>' : '<p class="hint">Messages are read only for your login.</p>'}</div>`;
    const l = $('#msgs', box); l.scrollTop = l.scrollHeight;
    if ($('#mf', box)) {
      $('#mT', box).onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(min-width:700px)').matches) { e.preventDefault(); $('#mf', box).requestSubmit(); } };
      $('#mf', box).onsubmit = async (e) => {
        e.preventDefault();
        const t = $('#mT', box), body = t.value.trim(); if (!body) return;
        const b = $('#mf button', box); b.disabled = true;
        try { await rpc('portal_send', { p_ctx: CTX, p_body: body }); t.value = ''; await draw(); } catch (er) { fail(er); }
        b.disabled = false; t.focus();
      };
    }
  };
  await draw(true);
  POLL = setInterval(() => { if (!document.hidden && route().v === 'messages') draw().catch(() => {}); }, 8000);
}

/* ================= approvals ================= */
async function approvals(box) {
  const rows = await rpc('portal_approvals_list', { p_ctx: CTX });
  const st = { pending: ['Waiting on you', 'gold'], approved: ['Approved', 'ok'], declined: ['Declined', 'due'] };
  box.innerHTML = `<h1>Needs your approval</h1><div class="card">${rows.map((a) => `<div class="row" data-ap="${a.id}"><div class="grow"><b>${esc(a.title)}</b> <span class="badge ${st[a.status]?.[1] || ''}">${esc(st[a.status]?.[0] || a.status)}</span>
      <small>${esc([a.amount != null ? money(a.amount) : '', a.due_at ? 'answer by ' + day(a.due_at) : '', a.decided_at ? `${a.decided_name || ''} ${a.status} ${day(a.decided_at)}` : day(a.at), HOME.locations?.length ? a.location : ''].filter(Boolean).join(' · '))}</small>
      ${a.summary ? `<small style="color:var(--ink)">${esc(a.summary)}</small>` : ''}</div>
      ${a.can_decide ? (a.link ? `<a class="btn small" href="${esc(a.link)}">Review and sign</a>` : '<span class="actions" style="margin:0"><button type="button" class="btn small" data-ok="1">Approve</button><button type="button" class="btn ghost small" data-ok="0">Decline</button></span>') : ''}</div>`).join('')
    || '<p class="empty" style="margin:0">Nothing waiting on you.</p>'}</div>`;
  $$('[data-ok]', box).forEach((b) => (b.onclick = async () => {
    const ok = b.dataset.ok === '1';
    const note = ok ? null : prompt('Want to say why? (optional)');
    if (!ok && note === null) return;
    try { await rpc('portal_approval_decide', { p_ctx: CTX, p_id: b.closest('[data-ap]').dataset.ap, p_ok: ok, p_note: note || null }); toast(ok ? 'Approved' : 'Declined'); loadHome(); } catch (e) { fail(e); }
  }));
}

/* ================= team (the client's admin) ================= */
const AREAS = [['schedule', 'Schedule', 1], ['estimates', 'Estimates', 2], ['invoices', 'Invoices and paying', 2], ['files', 'Files and photos', 1], ['messages', 'Messages', 2], ['approvals', 'Approvals', 2]];
const LVL = ['Off', 'View', 'View and act'];
async function team(box) {
  const rows = await rpc('portal_team', { p_ctx: CTX });
  const shown = AREAS.filter(([a]) => lv(a) > 0);
  box.innerHTML = `<h1>Your team</h1><p class="hint">Invite the people at ${esc(HOME.org)} who should have a login. Everyone sees everything unless you change it. Admins can invite people and change this page.</p>
    ${rows.map((u) => `<div class="card" data-u="${u.id}"><div class="row" style="padding:0;border:0"><div class="grow"><b>${esc(u.name || u.email)}</b> ${u.is_admin ? '<span class="badge ok">Admin</span>' : ''} ${u.joined ? '' : '<span class="badge gold">Hasn\'t signed up yet</span>'}
        <small>${esc(u.email)}${u.me ? ' · you' : ''}</small></div></div>
      ${u.me ? '' : `<label class="check"><input type="checkbox" data-admin ${u.is_admin ? 'checked' : ''}> Admin</label>
        <div class="levels" ${u.is_admin ? 'hidden' : ''}>${shown.map(([a, n, mx]) => `<label>${esc(n)}<select data-a="${a}">${LVL.slice(0, mx + 1).map((l, i) => `<option value="${i}" ${Math.min(Number(u.perms?.[a] ?? mx), mx) === i ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`).join('')}</div>
        <div class="actions"><button type="button" class="btn small" data-save>Save</button>${u.joined ? '' : '<button type="button" class="btn ghost small" data-again>Email it again</button>'}<button type="button" class="btn ghost small danger" data-rm>Remove</button></div>`}</div>`).join('')}
    <div class="card"><h2>Invite someone</h2><form id="inv"><label class="l" for="iN">Name</label><input type="text" id="iN" maxlength="120">
      <label class="l" for="iE">Email</label><input type="email" id="iE" maxlength="200" required>
      <label class="check"><input type="checkbox" id="iA"> Make them an admin too</label>
      <div class="actions"><button class="btn">Send invite</button></div></form></div>`;
  const email = async (id) => {
    const { data, error } = await sb.functions.invoke('portal-invite-email', { body: { id } });
    const msg = error ? (await error.context?.json?.().catch(() => null))?.error || error.message : data?.error;
    if (msg) { toast(`Access is set, but the email didn't go out: ${msg}`, true); return false; }
    return true;
  };
  $$('[data-u]', box).forEach((card) => {
    const id = card.dataset.u;
    const adm = $('[data-admin]', card); if (!adm) return;
    adm.onchange = () => ($('.levels', card).hidden = adm.checked);
    $('[data-save]', card).onclick = async () => {
      const perms = Object.fromEntries($$('[data-a]', card).map((s) => [s.dataset.a, Number(s.value)]));
      try { await rpc('portal_team_set', { p_ctx: CTX, p_user: id, p_admin: adm.checked, p_perms: perms }); toast('Saved'); } catch (e) { fail(e); }
    };
    if ($('[data-again]', card)) $('[data-again]', card).onclick = async () => { if (await email(id)) toast('Invite emailed'); };
    $('[data-rm]', card).onclick = async () => {
      if (!confirm('Remove their login from this portal?')) return;
      try { await rpc('portal_team_remove', { p_ctx: CTX, p_user: id }); toast('Removed'); team(box); } catch (e) { fail(e); }
    };
  });
  $('#inv', box).onsubmit = async (e) => {
    e.preventDefault();
    const b = $('#inv button', box); b.disabled = true;
    try {
      const id = await rpc('portal_team_invite', { p_ctx: CTX, p_email: $('#iE', box).value.trim(), p_name: $('#iN', box).value.trim(), p_admin: $('#iA', box).checked, p_perms: null });
      if (await email(id)) toast('Invite emailed');
      team(box);
    } catch (er) { fail(er); b.disabled = false; }
  };
}

sb.auth.onAuthStateChange((evt) => { if (evt === 'PASSWORD_RECOVERY') renderReset(); });
start();
