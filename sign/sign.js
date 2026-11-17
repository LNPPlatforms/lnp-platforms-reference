/* sign.js: the public signing page. /sign/?t=<signer's link code> to review and sign; /sign/?verify=1 to check a PDF.
   Signing: see the document, agree to do business electronically, get a 6 digit code by email, check it, fill in
   your fields (draw or type your signature and initials), finish. Or decline with a reason. Every step goes through
   the esign-sign edge function, which logs who did it (IP, device, browser) with the server's clock.
   Checking: the PDF's SHA-256 is worked out right here in the browser (the file never leaves the device) and looked up.
   Decisions: BACKLOG.md "E-sign: shipped". Database: schema/077f. */
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';
import { openPdf, renderPages, pageCss } from './pdfpages.js?v=20261116t';

const q = new URLSearchParams(location.search);
const token = (q.get('t') || '').trim();
const root = document.getElementById('root'), top = document.getElementById('top');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
const say = (html, icon = '') => { root.innerHTML = `<div class="card state">${icon ? `<div class="big" aria-hidden="true">${icon}</div>` : ''}${html}</div>`; };
const style = document.createElement('style'); style.textContent = pageCss; document.head.appendChild(style);
const CONSENT = 'I agree to use electronic records and signatures for this document. My electronic signature means the same as my signature on paper. I can ask the sender for a paper copy, and I can say no to signing electronically by declining before I sign. I can open PDFs on this device and get email at this address.';
const TYPE_NAME = { signature: 'Sign here', initials: 'Initials', date: 'Date signed', name: 'Your name', text: 'Type here', checkbox: '' };

async function call(action, body = {}) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/esign-sign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, t: token, ...body }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || 'That didn\'t go through. Check your connection and try again.');
  return d;
}
function brand(v) {
  const b = v?.mail?.brand || {};
  if (/^#[0-9a-f]{6}$/i.test(b.color || '')) document.body.style.setProperty('--c', b.color);
  top.innerHTML = b.logo ? `<img src="${esc(b.logo)}" alt="${esc(b.name || '')}">` : `<b>${esc(b.name || v?.mail?.account || 'Review and sign')}</b>`;
}
const footer = (v) => `<p class="foot">${esc(v?.mail?.brand?.name || v?.mail?.account || '')}${v?.mail?.from_name && v.mail.from_name !== (v?.mail?.brand?.name || v?.mail?.account) ? ` · e-sign by ${esc(v.mail.from_name)}` : ''}
  · <a href="?verify=1">Check a signed PDF</a></p>`;

/* ================= checking a PDF ================= */
async function verifyPage() {
  document.title = 'Check a signed PDF';
  root.innerHTML = `<div class="card"><h1>Check a signed PDF</h1>
    <p class="muted">Pick the PDF. We work out its fingerprint (SHA-256) right here on your device and look it up. The file isn't uploaded anywhere.</p>
    <input type="file" id="vf" accept="application/pdf,.pdf"><div id="vr"></div></div><p class="foot">Fingerprints are kept for every document signed here.</p>`;
  $('#vf').onchange = async () => {
    const f = $('#vf').files?.[0]; if (!f) return;
    const out = $('#vr'); out.innerHTML = '<p class="muted">Checking…</p>';
    try {
      const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
      const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
      const { data, error } = await sb.rpc('esign_verify', { p_sha: h });
      if (error) throw error;
      const rows = data || [];
      const signed = rows.find((r) => r.match === 'signed');
      out.innerHTML = `<p class="small muted">Fingerprint: <span class="hash">${h}</span></p>` + (signed
        ? `<div class="res"><b>This is a real signed copy.</b><br>${esc(signed.title)}${signed.from ? ` from ${esc(signed.from)}` : ''}, completed ${esc(new Date(signed.completed_at).toLocaleString())}.
            <br>Signed by ${esc((signed.signers || []).map((s) => s.name).join(', '))}. Not one byte has changed since.</div>`
        : rows.length ? `<div class="res"><b>This is the original, before signing.</b><br>${esc(rows[0].title)}${rows[0].from ? ` from ${esc(rows[0].from)}` : ''}. Status: ${esc(String(rows[0].status).replace('_', ' '))}.</div>`
        : '<div class="res bad"><b>No match.</b><br>This file isn\'t one we have, or it changed after it was signed (even saving it again in another program changes it).</div>');
    } catch (e) { out.innerHTML = `<p class="err">${esc(e.message || e)}</p>`; }
  };
}

/* ================= signing ================= */
let V = null, SESSION = null;
const st = { vals: {}, signature: null, initials: null, kind: null };
const mine = () => V.fields || [];
const filled = (f) => f.type === 'signature' ? !!st.signature : f.type === 'initials' ? !!st.initials : f.type === 'text' ? !!(st.vals[f.id] || '').trim()
  : f.type === 'checkbox' ? st.vals[f.id] === true : true;
const needs = () => mine().filter((f) => (f.required || f.type === 'signature') && !['date', 'name'].includes(f.type));

async function signPage() {
  if (!/^[a-f0-9]{64}$/.test(token)) return say('This link is missing its code. Check the email you were sent.', '✉');
  try { V = await call('view'); } catch (e) { return say(esc(e.message), '⚠'); }
  brand(V);
  document.title = `Sign: ${V.title}`;
  SESSION = sessionStorage.getItem('esign:' + token);
  const head = `<div class="card"><h1>${esc(V.title)}</h1><p class="muted" style="margin:0">From ${esc(V.mail?.sender?.name || V.mail?.brand?.name || V.mail?.account || '')}${V.mail?.brand?.name && V.mail?.sender?.name ? ` at ${esc(V.mail.brand.name)}` : ''}, for ${esc(V.signer.name)}</p>
    ${V.message ? `<p class="msg">${esc(V.message)}</p>` : ''}</div>`;
  if (V.state === 'completed') return (root.innerHTML = head + `<div class="card state"><div class="big">✔</div><h2>Everyone signed</h2><p>The signed copy has a signing certificate on its last page.</p>
    ${V.final_url ? `<p><a class="btn" href="${esc(V.final_url)}" id="dlFinal">Download the signed PDF</a></p>` : ''}${V.final_sha256 ? `<p class="small muted">Fingerprint: <span class="hash">${esc(V.final_sha256)}</span></p>` : ''}</div>` + footer(V));
  const msgs = { voided: ['✕', 'The sender voided this document', V.void_reason ? `Why: ${esc(V.void_reason)}` : 'Nothing more to do here.'],
    declined: ['✕', V.signer.declined ? 'You declined this document' : 'This document was declined', 'The sender knows. Nothing more to do here.'],
    expired: ['⌛', 'This signing link expired', 'Ask the sender for a new one.'],
    waiting: ['⏳', 'It isn\'t your turn yet', 'Someone signs before you. We\'ll email you when it\'s your turn.'],
    signed: ['✔', 'You signed this', `We'll email you the signed copy when ${V.others?.filter((o) => !o.signed).map((o) => esc(o.name)).join(', ') || 'everyone'} ${V.others?.filter((o) => !o.signed).length > 1 ? 'sign' : 'signs'}.`] };
  if (msgs[V.state]) { const [i, h, p] = msgs[V.state]; return (root.innerHTML = head + `<div class="card state"><div class="big">${i}</div><h2>${h}</h2><p>${p}</p></div>` + footer(V)); }
  // open: the steps, then the document
  root.innerHTML = head + '<div class="card" id="steps"></div><div class="pages" id="pages"><div class="card state">Loading the document…</div></div>' + footer(V)
    + `<div class="bar" id="bar"><span class="prog" id="prog"></span><button class="btn ghost" id="next" type="button">Next</button><button class="btn" id="finish" type="button" disabled>Finish</button></div>`;
  steps();
  try {
    const doc = await openPdf(V.url);
    V.pg = await renderPages($('#pages'), doc, { label: 'Page' });
    drawFields();
  } catch (e) { $('#pages').innerHTML = `<div class="card"><p class="err">Couldn't show the document: ${esc(e.message || e)}. Refresh to try again.</p></div>`; }
  $('#next').onclick = () => {
    const f = needs().find((x) => !filled(x)) || mine()[0]; if (!f) return;
    const el = $(`[data-ff="${CSS.escape(f.id)}"]`); if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  };
  $('#finish').onclick = finish;
}

// consent, then the code
function steps() {
  const box = $('#steps');
  if (SESSION) {
    box.innerHTML = `<p style="margin:0">✔ <b>You're checked in.</b> Fill in the highlighted boxes, then tap Finish.</p>
      <p class="small muted" style="margin:6px 0 0">Not going to sign? <button class="linkish" id="dec" type="button">Decline</button></p>`;
  } else if (!V.signer.consent_at && !st.consented) {
    box.innerHTML = `<h2>Before you sign</h2><label class="chk"><input type="checkbox" id="agree"><span>${esc(CONSENT)}</span></label>
      <div class="row"><button class="btn" id="agreeGo" type="button" disabled>Continue</button><button class="linkish" id="dec" type="button">Decline to sign</button></div><div class="err" id="serr" role="alert"></div>`;
    $('#agree').onchange = (e) => ($('#agreeGo').disabled = !e.target.checked);
    $('#agreeGo').onclick = async (e) => {
      e.target.disabled = true;
      try { await call('consent'); st.consented = true; await sendCode(); } catch (x) { $('#serr').textContent = x.message; e.target.disabled = false; }
    };
  } else {
    box.innerHTML = `<h2>Check it's you</h2><p>${st.sentTo ? `We emailed a 6 digit code to <b>${esc(st.sentTo)}</b>. It works for 10 minutes.` : `We'll email a 6 digit code to <b>${esc(V.signer.email)}</b>.`}</p>
      ${st.sentTo ? `<div class="row"><input class="code" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" aria-label="6 digit code">
        <button class="btn" id="check" type="button">Check the code</button></div>` : '<button class="btn" id="send" type="button">Email me a code</button>'}
      <div class="err" id="serr" role="alert"></div>
      <p class="small muted">${st.sentTo ? '<button class="linkish" id="send" type="button">Send a new code</button> · ' : ''}Not going to sign? <button class="linkish" id="dec" type="button">Decline</button></p>`;
    $('#send').onclick = async (e) => { e.target.disabled = true; try { await sendCode(); } catch (x) { $('#serr').textContent = x.message; e.target.disabled = false; } };
    if ($('#check')) {
      const go = async () => {
        const code = $('#code').value.replace(/\D/g, '');
        if (code.length !== 6) return ($('#serr').textContent = 'Type the 6 digits from the email');
        $('#check').disabled = true;
        try {
          const r = await call('check', { code });
          if (!r.ok) { $('#serr').textContent = r.error || 'That code doesn\'t match'; $('#check').disabled = false; if (r.expired) { st.sentTo = null; } return; }
          SESSION = r.session; sessionStorage.setItem('esign:' + token, SESSION); steps(); drawFields();
        } catch (x) { $('#serr').textContent = x.message; $('#check').disabled = false; }
      };
      $('#check').onclick = go;
      $('#code').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); if (e.target.value.length === 6) go(); };
      $('#code').focus();
    }
  }
  if ($('#dec')) $('#dec').onclick = decline;
}
async function sendCode() {
  const r = await call('code', { channel: 'email' });
  st.sentTo = r.to || V.signer.email;
  steps();
}

function drawFields() {
  if (!V.pg) return;
  const locked = !SESSION;
  V.pg.forEach((p) => {
    p.ov.innerHTML = mine().filter((f) => f.page === p.n).map((f) => {
      const done = filled(f) && !['date', 'name'].includes(f.type);
      const box = `data-ff="${esc(f.id)}" class="ff ${done ? 'done' : ''} ${locked ? 'locked' : ''}" style="left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%" title="${esc(f.label || TYPE_NAME[f.type])}"`;
      const req = (f.required || f.type === 'signature') && !['date', 'name'].includes(f.type) ? '<b class="req">*</b>' : '';
      if (f.type === 'signature' || f.type === 'initials') {
        const im = f.type === 'signature' ? st.signature : st.initials;
        return `<div ${box}><button type="button" data-pad="${f.type}" ${locked ? 'disabled' : ''}>${im ? `<img src="${im}" alt="Your ${f.type}">` : esc(TYPE_NAME[f.type])}</button>${req}</div>`;
      }
      if (f.type === 'date') return `<div ${box}><span>${esc(new Date().toLocaleDateString('en-US'))}</span></div>`;
      if (f.type === 'name') return `<div ${box}><span>${esc(V.signer.name)}</span></div>`;
      if (f.type === 'checkbox') return `<div ${box}><input type="checkbox" data-cb="${esc(f.id)}" ${st.vals[f.id] === true ? 'checked' : ''} ${locked ? 'disabled' : ''} aria-label="${esc(f.label || 'Check')}">${req}</div>`;
      return `<div ${box}><input type="text" data-tx="${esc(f.id)}" maxlength="1000" value="${esc(st.vals[f.id] || '')}" placeholder="${esc(f.label || '')}" ${locked ? 'disabled' : ''} aria-label="${esc(f.label || 'Text')}">${req}</div>`;
    }).join('');
    $$('[data-pad]', p.ov).forEach((b) => (b.onclick = () => pad(b.dataset.pad)));
    $$('[data-cb]', p.ov).forEach((c) => (c.onchange = () => { st.vals[c.dataset.cb] = c.checked; c.parentElement.classList.toggle('done', c.checked); progress(); }));
    $$('[data-tx]', p.ov).forEach((t) => (t.oninput = () => { st.vals[t.dataset.tx] = t.value; t.parentElement.classList.toggle('done', !!t.value.trim()); progress(); }));
  });
  progress();
}
function progress() {
  const n = needs(), d = n.filter(filled).length;
  $('#prog').textContent = !SESSION ? 'Check the code first, then fill these in' : n.length ? `${d} of ${n.length} done` : 'Ready to finish';
  $('#finish').disabled = !SESSION || d < n.length;
}

// draw or type a signature (or initials). One signature fills every signature box.
function pad(kind) {
  let d = $('#padDlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'padDlg'; document.body.appendChild(d); }
  const typedDefault = kind === 'initials' ? V.signer.name.split(/\s+/).map((w) => w[0] || '').join('').toUpperCase() : V.signer.name;
  let mode = 'draw';
  d.innerHTML = `<h2>${kind === 'initials' ? 'Your initials' : 'Your signature'}</h2>
    <div class="tabs"><button type="button" data-m="draw" class="on">Draw</button><button type="button" data-m="type">Type</button></div>
    <div id="pm"></div><div class="row" style="justify-content:space-between;margin-top:12px"><button type="button" class="linkish" id="pClear">Clear</button>
      <span class="row"><button type="button" class="btn ghost" id="pX">Cancel</button><button type="button" class="btn" id="pOk">Use this</button></span></div>
    <p class="small muted">By tapping Use this, you agree this is your electronic ${kind === 'initials' ? 'initials' : 'signature'} for this document.</p>`;
  let cv, ctx, ink = false;
  const show = () => {
    $$('.tabs button', d).forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    if (mode === 'draw') {
      $('#pm', d).innerHTML = '<canvas class="pad" id="pc" aria-label="Draw here"></canvas><p class="small muted" style="margin:4px 0 0">Draw with your finger or mouse.</p>';
      cv = $('#pc', d); const r = cv.getBoundingClientRect(); cv.width = Math.round(r.width * 2); cv.height = Math.round(r.height * 2);
      ctx = cv.getContext('2d'); ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0F1F5A'; ink = false;
      let down = false, last = null;
      const pt = (e) => { const b = cv.getBoundingClientRect(); return [(e.clientX - b.left) * cv.width / b.width, (e.clientY - b.top) * cv.height / b.height]; };
      cv.onpointerdown = (e) => { down = true; last = pt(e); cv.setPointerCapture?.(e.pointerId); ctx.beginPath(); ctx.arc(last[0], last[1], 2.5, 0, 7); ctx.fillStyle = '#0F1F5A'; ctx.fill(); ink = true; };
      cv.onpointermove = (e) => { if (!down) return; const p = pt(e); ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); last = p; ink = true; };
      cv.onpointerup = cv.onpointercancel = () => { down = false; };
    } else {
      $('#pm', d).innerHTML = `<input type="text" id="pt" maxlength="${kind === 'initials' ? 6 : 80}" value="${esc(typedDefault)}" aria-label="Type it"><div class="typed" id="pv" style="margin-top:8px"></div>`;
      const sync = () => { $('#pv', d).textContent = $('#pt', d).value; }; $('#pt', d).oninput = sync; sync();
    }
  };
  $$('.tabs button', d).forEach((b) => (b.onclick = () => { mode = b.dataset.m; show(); }));
  $('#pClear', d).onclick = () => { if (mode === 'draw') { ctx.clearRect(0, 0, cv.width, cv.height); ink = false; } else { $('#pt', d).value = ''; $('#pv', d).textContent = ''; } };
  $('#pX', d).onclick = () => d.close();
  $('#pOk', d).onclick = () => {
    let url = null;
    if (mode === 'draw') { if (!ink) return; url = trim(cv); }
    else {
      const t = $('#pt', d).value.trim(); if (!t) return;
      const c = document.createElement('canvas'); c.width = 900; c.height = 220; const x = c.getContext('2d');
      x.font = `italic ${kind === 'initials' ? 120 : 96}px "Segoe Script", "Brush Script MT", "Snell Roundhand", "Apple Chancery", cursive`;
      x.fillStyle = '#0F1F5A'; x.textBaseline = 'middle'; x.fillText(t, 20, 112, 860); url = trim(c);
    }
    if (kind === 'initials') st.initials = url; else { st.signature = url; st.kind = mode === 'draw' ? 'drawn' : 'typed'; }
    d.close(); drawFields();
  };
  d.showModal(); show();
}
// crop to what was drawn, with a little room, as a PNG
function trim(c) {
  const x = c.getContext('2d'), { width: w, height: h } = c, px = x.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 2) for (let i = 0; i < w; i += 2) if (px[(y * w + i) * 4 + 3] > 10) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return c.toDataURL('image/png');
  const m = 8; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w, x1 + m); y1 = Math.min(h, y1 + m);
  const o = document.createElement('canvas'); o.width = x1 - x0; o.height = y1 - y0;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return o.toDataURL('image/png');
}

async function finish() {
  const miss = needs().find((f) => !filled(f));
  if (miss) { $('#next').click(); return; }
  const b = $('#finish'); b.disabled = true; b.textContent = 'Signing…';
  try {
    const r = await call('submit', { session: SESSION, vals: st.vals, signature: st.signature, initials: st.initials, kind: st.kind || 'drawn' });
    sessionStorage.removeItem('esign:' + token);
    $('#bar')?.remove();
    root.innerHTML = `<div class="card state"><div class="big">✔</div><h2>Done. You signed ${esc(V.title)}.</h2>
      <p>${r.all_signed ? (r.finished ? 'Everyone has signed. We emailed you the signed copy.' : 'Everyone has signed. The signed copy will be emailed to you shortly.')
        : 'We\'ll email you the signed copy when everyone has signed.'}</p>${r.all_signed && r.finished ? '<p><a class="btn" href="" id="again">See the signed copy</a></p>' : ''}</div>` + footer(V);
    window.scrollTo(0, 0);
  } catch (e) {
    b.disabled = false; b.textContent = 'Finish';
    if (/code we emailed/i.test(e.message)) { SESSION = null; sessionStorage.removeItem('esign:' + token); st.sentTo = null; steps(); drawFields(); window.scrollTo(0, 0); }
    alert(e.message);
  }
}

function decline() {
  let d = $('#decDlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'decDlg'; document.body.appendChild(d); }
  d.innerHTML = `<h2>Decline to sign</h2><p>The sender gets your reason, and nobody else can sign this copy after you decline.</p>
    <textarea id="dr" rows="4" maxlength="2000" placeholder="Why you're declining"></textarea><div class="err" id="derr" role="alert"></div>
    <div class="row" style="justify-content:flex-end;margin-top:10px"><button type="button" class="btn ghost" id="dX">Never mind</button><button type="button" class="btn" id="dGo">Decline</button></div>`;
  $('#dX', d).onclick = () => d.close();
  $('#dGo', d).onclick = async (e) => {
    const why = $('#dr', d).value.trim(); if (!why) return ($('#derr', d).textContent = 'Say why, so the sender knows');
    e.target.disabled = true;
    try { await call('decline', { reason: why }); d.close(); $('#bar')?.remove(); say(`<h2>You declined ${esc(V.title)}</h2><p>We let the sender know.</p>`, '✕'); }
    catch (x) { $('#derr', d).textContent = x.message; e.target.disabled = false; }
  };
  d.showModal();
}

if (q.get('verify')) verifyPage(); else signPage();
