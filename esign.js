/* esign.js: e-sign inside the CRM. Upload a PDF (or start from a template), place fields for each signer, send it,
   then follow it: who opened it, who signed, the event log, reminders, void, and the original and signed PDFs.
   Templates keep a PDF with fields placed against roles (Client, Company rep) so sending one takes a couple clicks.
   Signers use the public page /sign/ (sign/sign.js). Decisions: BACKLOG.md "Oct 30 morning voice decisions", E-sign
   bullet, and "E-sign: shipped". Database: schema/077*. Edge functions esign-email and esign-sign.
   Plugs into app.js through init(ctx) like bids.js. */
import * as FLD from './field.js?v=20261116t';
import { openPdf, pageSizes, renderPages, pageCss } from './sign/pdfpages.js?v=20261116t';

let C = null, sb, S, esc, $, $$;
export function init(ctx) { C = ctx; ({ sb, S, esc, $, $$ } = ctx); }
const can = (a, l = 1) => FLD.can(a, l);
export const on = () => FLD.feat('esign');
export const canSee = () => on() && can('esign', 1);
export const canEdit = () => on() && can('esign', 2);
export const canVoidAny = () => on() && (C.isAdmin() || can('esign', 3));
export const canSetup = () => on() && (C.isAdmin() || can('esign', 4));

export const STATUS = [['draft', 'Draft'], ['sent', 'Sent'], ['viewed', 'Viewed'], ['partly_signed', 'Partly signed'], ['completed', 'Completed'], ['declined', 'Declined'], ['voided', 'Voided']];
const STATUS_NAME = Object.fromEntries(STATUS);
const STATUS_BADGE = { draft: '', sent: 'gold', viewed: 'gold', partly_signed: 'gold', completed: 'ok', declined: 'due', voided: 'due' };
const OPEN = ['sent', 'viewed', 'partly_signed'];
const SIGNER_STATUS = { waiting: 'Waiting their turn', sent: 'Emailed', viewed: 'Opened it', signed: 'Signed', declined: 'Declined' };
export const TYPES = [['signature', 'Signature'], ['initials', 'Initials'], ['date', 'Date signed'], ['name', 'Name'], ['text', 'Text'], ['checkbox', 'Checkbox']];
const TYPE_NAME = Object.fromEntries(TYPES);
const COLORS = ['#2F6FDE', '#D9822B', '#2A9D6F', '#B5487A', '#7B61C9', '#C0392B', '#3B8EA5', '#8A6D3B'];
const EVENT_NAME = { created: 'Created', sent: 'Sent to sign', viewed: 'Opened', consented: 'Agreed to sign electronically', code_sent: 'Code emailed', code_failed: 'Wrong or expired code',
  code_verified: 'Code checked', signed: 'Signed', reminded: 'Reminder sent', declined: 'Declined', voided: 'Voided', completed: 'Completed' };
const SIGNER_COLS = 'id,envelope_id,key,role_label,name,email,phone,sign_order,status,invited_at,last_sent_at,reminders,viewed_at,consent_at,otp_verified_at,signed_at,declined_at,decline_reason,sign_ip,sign_device,sign_browser,signature_kind';
const BUCKET = 'esign-files';
export const WET_NOTE = 'Wills, trusts, codicils and some other papers (like adoption, divorce and some court or notary documents) still need a wet, ink signature in most states. Don\'t send those here.';
export const CONSENT_TEXT = 'I agree to use electronic records and signatures for this document. My electronic signature means the same as my signature on paper. I can ask the sender for a paper copy, and I can say no to signing electronically by declining before I sign. I can open PDFs on this device and get email at this address.';

const rid = () => Math.random().toString(36).slice(2, 10);
const fmtDT = (d) => (d ? new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const fmtSec = (d) => (d ? new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '');
const badge = (st) => `<span class="badge ${STATUS_BADGE[st] || ''}">${esc(STATUS_NAME[st] || st)}</span>`;
const safeName = (n) => (n || 'document.pdf').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(-120) || 'document.pdf';
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
async function fnError(error, data) {
  if (error) return (await error.context?.json?.().catch(() => null))?.error || error.message;
  return data?.error || null;
}
let cssOn = false;
function css() {
  if (cssOn) return; cssOn = true;
  const s = document.createElement('style');
  s.textContent = `${pageCss}
.esrow{display:flex;gap:12px;align-items:center;text-align:left}.esrow .esico{font-size:22px;width:34px;text-align:center;flex:none}
.esedit{display:grid;grid-template-columns:300px 1fr;gap:16px;align-items:start}.espanel{position:sticky;top:8px;max-height:calc(100vh - 16px);overflow:auto}
.espanel .card{margin-bottom:12px}.espanel h3{margin:0 0 8px;font-size:15px}
.essig{display:grid;grid-template-columns:14px 1fr auto;gap:6px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)}
.essig .dot,.esdot{width:12px;height:12px;border-radius:50%;background:var(--c);display:inline-block}
.essig input{margin:0;min-width:0}.essig .esfl{grid-column:2/-1;display:grid;grid-template-columns:1fr 1fr 60px;gap:6px}
.essig.on{background:#EEF3FC;border-radius:8px;padding:6px}
.estypes{display:grid;grid-template-columns:1fr 1fr;gap:6px}.estypes button{min-height:40px;border:1px dashed var(--c,#888);border-radius:8px;background:var(--card);cursor:grab;font-size:14px;color:var(--text)}
.estypes button.on{background:var(--c);color:#fff;border-style:solid}
.espages{background:#E2E5EB;border-radius:12px;padding:14px 14px 24px;min-height:300px}.espages.arm .pdfov{cursor:crosshair}
.esf{position:absolute;border:2px solid var(--c);background:color-mix(in srgb,var(--c) 18%,transparent);border-radius:4px;font-size:11px;color:#1d2433;
  display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:move;touch-action:none;white-space:nowrap}
.esf.sel{box-shadow:0 0 0 3px rgba(26,42,82,.35)}.esf>span{pointer-events:none;padding:0 2px;text-overflow:ellipsis;overflow:hidden}
.esf .esrz{position:absolute;right:-1px;bottom:-1px;width:14px;height:14px;background:var(--c);cursor:nwse-resize;border-radius:3px 0 3px 0}
.esf .esreq{position:absolute;top:0;right:3px;color:#B4412C;font-weight:700;pointer-events:none}
.esdet td,.eslog td{padding:6px 4px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}.eslog{width:100%;border-collapse:collapse}.esdet{width:100%;border-collapse:collapse}
.eslog small,.esdet small{color:var(--muted)}.esmono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;word-break:break-all}
.esrole{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0}.esrole input,.esrole select{margin:0}
.eswet{border-left:4px solid var(--gold);background:#FBF6EA;padding:10px 12px;border-radius:8px;font-size:14px}
@media (max-width:900px){.esedit{grid-template-columns:1fr}.espanel{position:static;max-height:none}}`;
  document.head.appendChild(s);
}

/* ================= navigation pieces ================= */
export const drawerItems = () => ({
  documents: [{ id: 'esign', label: 'E-sign', match: ['esign', 'esigndoc', 'esignedit', 'esigntpl'], what: 'Send PDFs to sign, reusable templates and every signature\'s record', when: () => canSee() }],
  admin: [{ id: 'esignsetup', label: 'E-sign', match: ['esignsetup'], what: 'The default message, how long links last and what can\'t be signed here', when: () => canSetup() }],
});
export const views = () => ({ esign: viewList, esigndoc: viewDoc, esignedit: (m) => viewEditor(m, 'envelope'), esigntpl: (m) => viewEditor(m, 'template'), esignsetup: viewSetup });
export const parents = { esign: 'tools', esigndoc: 'esign', esignedit: 'esign', esigntpl: 'esign', esignsetup: 'tools' };
export const guards = { esign: () => canSee(), esigndoc: () => canSee(), esignedit: () => canEdit(), esigntpl: () => canEdit(), esignsetup: () => canSetup() };
export const screens = () => [
  ...(canSee() ? [['esign', 'E-sign', 'sign signature esign docusign pdf contract agreement envelope template']] : []),
  ...(canSetup() ? [['esignsetup', 'E-sign setup', 'esign signature settings default message expire wet signature']] : []),
];
const noDb = (main, h) => { main.innerHTML = `<h1>${h}</h1><p class="empty">E-sign needs the November 2 database update. Once it's applied, this works.</p>`; };

/* ================= upload ================= */
// reads the PDF (pages and their sizes), stores it in the account's folder and hands back what the database needs
async function upload(file, folder) {
  if (!file) throw new Error('Pick a PDF first');
  if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} is over 25 MB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw new Error('That file isn\'t a PDF');
  let pages;
  try { pages = await pageSizes(await openPdf(bytes)); } catch (e) { throw new Error(/password/i.test(e?.message || '') ? 'That PDF has a password. Save a copy without one and try again.' : 'Couldn\'t open that PDF'); }
  if (!pages.length) throw new Error('That PDF has no pages');
  if (pages.length > 300) throw new Error('That PDF has more than 300 pages');
  const path = `${S.acct.id}/${folder}/${rid()}-${safeName(file.name)}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: 'application/pdf', upsert: false });
  if (error) throw error;
  return { file_path: path, file_name: file.name.slice(0, 255), file_size: file.size, pages, bytes };
}
const BYTES = new Map();   // a just-uploaded file, so the editor doesn't download it again

/* ================= the list ================= */
let TAB = 'docs', FILTER = 'open';
async function viewList(main) {
  css();
  const [{ data: envs, error }, { data: tpls }, { data: sigs }] = await Promise.all([
    sb.from('esign_envelopes').select('id,title,status,source,company_id,created_at,sent_at,completed_at,expires_at,owner_id,companies(name)').is('archived_at', null).order('created_at', { ascending: false }).limit(500),
    sb.from('esign_templates').select('id,name,description,file_name,roles,fields,owner_id,updated_at').is('archived_at', null).order('name'),
    sb.from('esign_signers').select('id,envelope_id,name,status,signed_at,sign_order').limit(3000)]);
  if (error) return noDb(main, 'E-sign');
  const all = envs || [], T = tpls || [];
  const bySig = {};
  (sigs || []).forEach((s) => (bySig[s.envelope_id] ||= []).push(s));
  const pick = { open: (e) => OPEN.includes(e.status), all: () => true, ...Object.fromEntries(STATUS.map(([k]) => [k, (e) => e.status === k])) };
  const rows = all.filter(pick[FILTER] || pick.open);
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">E-sign</h1>
      ${canEdit() ? `<button class="btn ghost small" id="esFromTpl" ${T.length ? '' : 'disabled title="Make a template first"'}>Send from a template</button><button class="btn small" id="esNew">Upload a PDF to sign</button>` : ''}</div>
    <div class="chips" style="margin:6px 0 12px"><button type="button" class="chip ${TAB === 'docs' ? 'on' : ''}" data-tab="docs">Documents (${all.length})</button>
      <button type="button" class="chip ${TAB === 'tpl' ? 'on' : ''}" data-tab="tpl">Templates (${T.length})</button></div>
    <div id="esBody"></div>`;
  const body = $('#esBody', main);
  if (TAB === 'docs') {
    const done = all.filter((e) => e.status === 'completed').length;
    body.innerHTML = `<div class="dtiles"><div class="dtile"><b>${all.filter(pick.open).length}</b><span>Waiting on signatures</span></div>
        <div class="dtile"><b>${all.filter((e) => e.status === 'draft').length}</b><span>Drafts</span></div><div class="dtile"><b>${done}</b><span>Completed</span></div></div>
      <div class="chips" style="margin:12px 0">${[['open', 'Waiting'], ...STATUS, ['all', 'All']].map(([k, n]) => `<button type="button" class="chip ${FILTER === k ? 'on' : ''}" data-f="${k}">${n} (${all.filter(pick[k]).length})</button>`).join('')}</div>
      <div class="list">${rows.map((e) => { const ss = (bySig[e.id] || []).sort((a, b) => a.sign_order - b.sign_order); const signed = ss.filter((s) => s.signed_at).length;
        return `<button class="item esrow" data-env="${e.id}"><span class="esico" aria-hidden="true">${e.status === 'completed' ? '✔' : '✍'}</span>
          <span style="flex:1;min-width:0"><b>${esc(e.title)}</b> ${badge(e.status)}
          <small style="display:block">${esc([ss.map((s) => s.name).join(', '), ss.length && e.status !== 'draft' ? `${signed} of ${ss.length} signed` : '', e.companies?.name,
            e.completed_at ? 'done ' + fmtDT(e.completed_at) : e.sent_at ? 'sent ' + fmtDT(e.sent_at) : 'made ' + fmtDT(e.created_at)].filter(Boolean).join(' · '))}</small></span></button>`; }).join('')
        || `<p class="empty">Nothing here.${canEdit() ? ' Upload a PDF to send one.' : ''}</p>`}</div>
      <p class="hint">Anyone can check a signed copy is real at <a href="/sign/?verify=1" target="_blank" rel="noopener">${esc(S.pub())}/sign/?verify=1</a>.</p>`;
    $$('[data-f]', body).forEach((b) => (b.onclick = () => { FILTER = b.dataset.f; viewList(main); }));
    $$('[data-env]', body).forEach((b) => (b.onclick = () => { const e = all.find((x) => x.id === b.dataset.env); C.go(e.status === 'draft' && canEdit() ? 'esignedit' : 'esigndoc', e.id); }));
  } else {
    body.innerHTML = `${canEdit() ? '<div class="actions" style="justify-content:flex-start;margin:0 0 10px"><button class="btn small" id="esNewTpl">New template from a PDF</button></div>' : ''}
      <div class="list">${T.map((t) => `<div class="item esrow" data-tpl="${t.id}"><span class="esico" aria-hidden="true">▤</span>
        <span style="flex:1;min-width:0"><b>${esc(t.name)}</b><small style="display:block">${esc([(t.roles || []).map((r) => r.label).join(', '), `${(t.fields || []).length} fields`, t.description].filter(Boolean).join(' · '))}</small></span>
        ${canEdit() ? `<button class="btn small" data-tsend="${t.id}">Send</button><button class="btn ghost small" data-tedit="${t.id}">Edit</button>` : ''}</div>`).join('')
        || '<p class="empty">No templates yet. Make one from a PDF you send often, with fields placed for each role (like Client and Company rep).</p>'}</div>`;
    $$('[data-tsend]', body).forEach((b) => (b.onclick = () => fromTemplate(b.dataset.tsend)));
    $$('[data-tedit]', body).forEach((b) => (b.onclick = () => C.go('esigntpl', b.dataset.tedit)));
    if ($('#esNewTpl', body)) $('#esNewTpl', body).onclick = () => newUpload('template');
  }
  $$('[data-tab]', main).forEach((b) => (b.onclick = () => { TAB = b.dataset.tab; viewList(main); }));
  if ($('#esNew', main)) $('#esNew', main).onclick = () => newUpload('envelope');
  if ($('#esFromTpl', main)) $('#esFromTpl', main).onclick = () => fromTemplate(null);
}

function newUpload(kind, link = {}) {
  const tpl = kind === 'template';
  const d = dlg('esUp', `<div class="vhead"><h2 style="margin:0">${tpl ? 'New template' : 'Upload a PDF to sign'}</h2><button class="btn ghost small" data-x>Close</button></div>
    <label class="label" for="esF">The PDF</label><input type="file" id="esF" accept="application/pdf,.pdf">
    <label class="label" for="esT">${tpl ? 'Template name' : 'What it is'}</label><input type="text" id="esT" maxlength="200" placeholder="${tpl ? 'Service agreement' : 'Service agreement for Oak Apartments'}">
    <p class="hint">25 MB at most. Next you'll place where each person signs.</p>
    <p class="eswet">${esc(WET_NOTE)}</p>
    <div class="actions"><button class="btn" id="esGo">Next: place fields</button></div>`);
  $('[data-x]', d).onclick = () => d.close();
  $('#esF', d).onchange = () => { const f = $('#esF', d).files?.[0]; if (f && !$('#esT', d).value) $('#esT', d).value = f.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').slice(0, 200); };
  $('#esGo', d).onclick = async (e) => {
    const f = $('#esF', d).files?.[0];
    if (!f) return C.toast('Pick a PDF first');
    e.target.disabled = true; e.target.textContent = 'Uploading…';
    try {
      const up = await upload(f, tpl ? 't' : 'u');
      const p = { title: $('#esT', d).value.trim(), name: $('#esT', d).value.trim(), file_path: up.file_path, file_name: up.file_name, file_size: up.file_size, pages: up.pages, ...link };
      const { data: id, error } = tpl ? await sb.rpc('esign_template_save', { p: { ...p, roles: [{ key: 'client', label: 'Client', order: 1 }, { key: 'rep', label: 'Company rep', order: 2 }] } })
        : await sb.rpc('esign_envelope_create', { p: { ...p, signers: [] } });
      if (error) throw error;
      BYTES.set(up.file_path, up.bytes);
      d.close(); C.go(tpl ? 'esigntpl' : 'esignedit', id);
    } catch (x) { e.target.disabled = false; e.target.textContent = 'Next: place fields'; C.fail(x); }
  };
}

/* ================= send from a template ================= */
async function fromTemplate(tplId) {
  const [{ data: tpls }, { data: cos }] = await Promise.all([
    sb.from('esign_templates').select('id,name,roles,message,ordered').is('archived_at', null).order('name'),
    sb.from('companies').select('id,name').is('archived_at', null).order('name').limit(1000)]);
  if (!tpls?.length) return C.toast('Make a template first');
  let tp = tpls.find((t) => t.id === tplId) || tpls[0];
  let people = [];
  const team = C.staff().filter((u) => u.email);
  const d = dlg('esTpl', '');
  const draw = () => {
    d.innerHTML = `<div class="vhead"><h2 style="margin:0">Send from a template</h2><button class="btn ghost small" data-x>Close</button></div>
      <label class="label" for="etT">Template</label><select id="etT">${tpls.map((t) => `<option value="${t.id}" ${t.id === tp.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <label class="label" for="etC">For which ${esc(FLD.l('organization'))} (optional)</label><select id="etC"><option value="">None</option>${(cos || []).map((c) => `<option value="${c.id}" ${c.id === d.dataset.co ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      ${(tp.roles || []).sort((a, b) => (a.order || 0) - (b.order || 0)).map((r) => `<div class="card" style="margin:10px 0;padding:10px" data-role="${esc(r.key)}"><b>${esc(r.label)}</b>
        <div class="esrole"><select data-pick><option value="">Pick someone…</option>${people.length ? `<optgroup label="${esc(FLD.L('person', true))}">${people.map((p) => `<option value="p:${p.id}">${esc(p.name)} (${esc(p.email)})</option>`).join('')}</optgroup>` : ''}
          <optgroup label="Your team">${team.map((u) => `<option value="u:${u.id}">${esc(u.full_name)}</option>`).join('')}</optgroup></select><span></span>
          <input type="text" data-k="name" placeholder="Name" maxlength="200"><input type="email" data-k="email" placeholder="Email" maxlength="320">
          <input type="tel" data-k="phone" placeholder="Phone (optional)" maxlength="40"></div></div>`).join('')}
      <label class="label" for="etM">Message</label><textarea id="etM" rows="3" maxlength="5000">${esc(tp.message || '')}</textarea>
      <div class="actions"><button class="btn ghost" id="etReview">Review first</button><button class="btn" id="etSend">Send now</button></div>`;
    $('[data-x]', d).onclick = () => d.close();
    $('#etT', d).onchange = () => { tp = tpls.find((t) => t.id === $('#etT', d).value); draw(); };
    $('#etC', d).onchange = async () => {
      d.dataset.co = $('#etC', d).value;
      people = [];
      if (d.dataset.co) {
        const { data } = await sb.from('company_people').select('person_id,people(id,first_name,last_name,personal_email)').eq('company_id', d.dataset.co);
        people = (data || []).map((x) => x.people).filter((p) => p?.personal_email).map((p) => ({ id: p.id, name: `${p.first_name || ''} ${p.last_name || ''}`.trim(), email: p.personal_email }));
      }
      draw();
    };
    $$('[data-role] [data-pick]', d).forEach((s) => (s.onchange = () => {
      const box = s.closest('[data-role]'); const [k, id] = s.value.split(':');
      const who = k === 'p' ? people.find((p) => p.id === id) : k === 'u' ? (() => { const u = team.find((x) => x.id === id); return u && { name: u.full_name, email: u.email }; })() : null;
      if (who) { $('[data-k="name"]', box).value = who.name; $('[data-k="email"]', box).value = who.email; box.dataset.person = k === 'p' ? id : ''; }
    }));
    const make = async () => {
      const signers = $$('[data-role]', d).map((b) => ({ key: b.dataset.role, name: $('[data-k="name"]', b).value.trim(), email: $('[data-k="email"]', b).value.trim(), phone: $('[data-k="phone"]', b).value.trim() || null }));
      const miss = signers.find((s) => !s.name || !s.email);
      if (miss) { C.toast(`Fill in who signs as ${(tp.roles || []).find((r) => r.key === miss.key)?.label || 'each role'}`); return null; }
      const person = $$('[data-role]', d).map((b) => b.dataset.person).find(Boolean) || null;
      const { data: id, error } = await sb.rpc('esign_envelope_create', { p: { template_id: tp.id, signers, message: $('#etM', d).value, company_id: d.dataset.co || null, person_id: person } });
      if (error) { C.fail(error); return null; }
      return id;
    };
    $('#etReview', d).onclick = async () => { const id = await make(); if (id) { d.close(); C.go('esignedit', id); } };
    $('#etSend', d).onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = 'Sending…';
      const id = await make();
      if (!id) { e.target.disabled = false; e.target.textContent = 'Send now'; return; }
      const ok = await send(id);
      d.close(); C.go(ok ? 'esigndoc' : 'esignedit', id);
    };
  };
  draw();
}

async function send(id) {
  const { data, error } = await sb.functions.invoke('esign-email', { body: { action: 'send', id } });
  const msg = await fnError(error, data);
  if (msg) { C.toast(`Not sent: ${msg}`, { error: true }); return false; }
  C.toast(data?.failed?.length ? `Sent, but some emails didn't go out: ${data.failed.join('; ')}` : 'Sent to sign', data?.failed?.length ? { error: true } : undefined);
  return true;
}

/* ================= the field editor (envelopes and templates) ================= */
// E: what's being edited. people: signers ({key, name, email, phone, order}) or template roles ({key, label, order})
let E = null;
async function viewEditor(main, kind) {
  css();
  const id = S.param, tpl = kind === 'template';
  const { data: row, error } = tpl ? await sb.from('esign_templates').select('*').eq('id', id).maybeSingle() : await sb.from('esign_envelopes').select('*').eq('id', id).maybeSingle();
  if (error) return noDb(main, 'E-sign');
  if (!row || row.archived_at) { main.innerHTML = '<h1>E-sign</h1><p class="empty">That isn\'t here, or it\'s someone else\'s.</p>'; return; }
  if (!tpl && row.status !== 'draft') return C.go('esigndoc', id);
  const { data: sg } = tpl ? { data: [] } : await sb.from('esign_signers').select(SIGNER_COLS).eq('envelope_id', id).order('sign_order');
  const { data: cos } = tpl ? { data: [] } : await sb.from('companies').select('id,name').is('archived_at', null).order('name').limit(1000);
  E = { kind, id, row, tpl, title: tpl ? row.name : row.title, message: row.message || '', ordered: !!row.ordered, description: row.description || '',
    people: tpl ? (row.roles || []).map((r) => ({ ...r })) : (sg || []).map((s) => ({ key: s.key, name: s.name, email: s.email, phone: s.phone || '', order: s.sign_order, role_label: s.role_label })),
    fields: (row.fields || []).map((f) => ({ ...f })), pages: row.pages || [], active: null, sel: null, arm: null, dirty: false,
    links: { company_id: row.company_id || '', person_id: row.person_id || '', job_id: row.job_id || '', opportunity_id: row.opportunity_id || '' }, cos: cos || [] };
  if (!tpl && !E.people.length) E.people.push({ key: 's1', name: '', email: '', phone: '', order: 1 });
  E.active = E.people[0]?.key || null;
  main.innerHTML = `<div class="toolbar"><button class="btn ghost small" data-nav="esign">‹ E-sign</button><h1 style="flex:1;margin:0">${tpl ? 'Template' : 'Place fields'}</h1>
      <button class="btn ghost small" id="edSave">Save</button>${tpl ? '' : '<button class="btn small" id="edSend">Send to sign</button>'}</div>
    <div class="esedit"><aside class="espanel" id="edPanel"></aside><div><p class="hint" id="edHint"></p><div class="espages" id="edPages"><p class="empty">Loading the PDF…</p></div></div></div>`;
  $$('[data-nav]', main).forEach((b) => (b.onclick = () => C.go(b.dataset.nav)));
  $('#edSave', main).onclick = () => save(true);
  if ($('#edSend', main)) $('#edSend', main).onclick = async (e) => {
    if (!(await save(false))) return;
    e.target.disabled = true; e.target.textContent = 'Sending…';
    if (await send(id)) C.go('esigndoc', id); else { e.target.disabled = false; e.target.textContent = 'Send to sign'; }
  };
  drawPanel();
  // the pages
  try {
    let src = BYTES.get(row.file_path);
    if (!src) { const { data: u, error: e2 } = await sb.storage.from(BUCKET).createSignedUrl(row.file_path, 900); if (e2) throw e2; src = u.signedUrl; }
    const doc = await openPdf(src);
    E.doc = doc;
    E.pg = await renderPages($('#edPages', main), doc);
    if (!E.pages.length) E.pages = E.pg.map((p) => ({ w: p.w, h: p.h }));
    E.pg.forEach((p) => wirePage(p));
    drawFields();
  } catch (x) { $('#edPages', main).innerHTML = `<p class="empty">Couldn't show the PDF: ${esc(x.message || x)}</p>`; }
}
const colorOf = (key) => COLORS[Math.max(0, E.people.findIndex((p) => p.key === key)) % COLORS.length];
const whoLabel = (p) => (E.tpl ? p.label : p.name || p.email) || 'New signer';
const nextKey = () => { const pre = E.tpl ? 'r' : 's'; let n = 1; while (E.people.some((p) => p.key === pre + n)) n++; return pre + n; };

function drawPanel() {
  const P = $('#edPanel'); if (!P) return;
  const f = E.fields.find((x) => x.id === E.sel);
  const co = E.links.company_id;
  P.innerHTML = `<div class="card"><h3>${E.tpl ? 'Roles' : 'Who signs'}</h3>
      ${E.people.map((p, i) => `<div class="essig ${p.key === E.active ? 'on' : ''}" data-who="${esc(p.key)}" style="--c:${colorOf(p.key)}"><span class="dot"></span>
        ${E.tpl ? `<input type="text" data-pk="label" value="${esc(p.label || '')}" placeholder="Role, like Client" maxlength="100" aria-label="Role name">`
          : `<input type="text" data-pk="name" value="${esc(p.name || '')}" placeholder="Name" maxlength="200" aria-label="Signer name">`}
        <button type="button" class="btn ghost small" data-rm="${esc(p.key)}" title="Take off" aria-label="Take off">✕</button>
        <div class="esfl">${E.tpl ? '' : `<input type="email" data-pk="email" value="${esc(p.email || '')}" placeholder="Email" maxlength="320" aria-label="Signer email">
          <input type="tel" data-pk="phone" value="${esc(p.phone || '')}" placeholder="Phone (optional)" maxlength="40" aria-label="Signer phone">`}
          ${E.ordered ? `<input type="number" data-pk="order" value="${p.order || i + 1}" min="1" max="50" aria-label="Signing order" title="Signing order">` : ''}</div></div>`).join('')}
      <div class="actions" style="justify-content:space-between;margin-top:8px"><button type="button" class="btn ghost small" id="edAddWho">${E.tpl ? 'Add a role' : 'Add a signer'}</button>
        <label class="check" style="min-height:0"><input type="checkbox" id="edOrd" ${E.ordered ? 'checked' : ''}> In order</label></div>
      ${E.ordered ? '<p class="hint" style="margin:4px 0 0">Lower numbers sign first. Same number signs at the same time.</p>' : ''}</div>
    <div class="card"><h3>Add fields${E.active ? ` for <span class="esdot" style="--c:${colorOf(E.active)}"></span> ${esc(whoLabel(E.people.find((p) => p.key === E.active) || {}))}` : ''}</h3>
      <div class="estypes" style="--c:${E.active ? colorOf(E.active) : '#888'}">${TYPES.map(([k, n]) => `<button type="button" draggable="true" data-type="${k}" class="${E.arm === k ? 'on' : ''}">${n}</button>`).join('')}</div>
      <p class="hint" style="margin:8px 0 0">Tap a field, then tap the page where it goes. Or drag it onto the page. Drag a box to move it, its corner to resize.</p></div>
    ${f ? `<div class="card"><h3>This field</h3>
      <label class="label" for="edFT">Type</label><select id="edFT">${TYPES.map(([k, n]) => `<option value="${k}" ${f.type === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label class="label" for="edFW">${E.tpl ? 'Role' : 'Signer'}</label><select id="edFW">${E.people.map((p) => `<option value="${esc(p.key)}" ${f.signer === p.key ? 'selected' : ''}>${esc(whoLabel(p))}</option>`).join('')}</select>
      ${['text', 'checkbox'].includes(f.type) ? `<label class="label" for="edFL">Label (what to fill in)</label><input type="text" id="edFL" maxlength="100" value="${esc(f.label || '')}" placeholder="${f.type === 'text' ? 'Unit number' : 'I read the terms'}">` : ''}
      ${['date', 'name'].includes(f.type) ? '<p class="hint">Filled in for them when they sign.</p>' : `<label class="check"><input type="checkbox" id="edFR" ${f.required ? 'checked' : ''}> Required</label>`}
      <div class="actions" style="justify-content:flex-start"><button type="button" class="btn ghost small" id="edFD">Remove this field</button></div></div>` : ''}
    <div class="card"><h3>Details</h3>
      <label class="label" for="edT">${E.tpl ? 'Template name' : 'Title'}</label><input type="text" id="edT" maxlength="200" value="${esc(E.title || '')}">
      ${E.tpl ? `<label class="label" for="edDs">About it (optional)</label><input type="text" id="edDs" maxlength="2000" value="${esc(E.description)}">` : ''}
      <label class="label" for="edM">Message in the email</label><textarea id="edM" rows="3" maxlength="5000">${esc(E.message)}</textarea>
      ${E.tpl ? '' : `<label class="label" for="edCo">${esc(FLD.L('organization'))} (shows on its timeline)</label><select id="edCo"><option value="">None</option>${E.cos.map((c) => `<option value="${c.id}" ${c.id === co ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <div id="edLinks"></div>`}
      ${E.tpl && canEdit() ? '<div class="actions" style="justify-content:flex-start"><button type="button" class="btn ghost small" id="edArch">Remove this template</button></div>' : ''}
      ${E.tpl ? '' : '<div class="actions" style="justify-content:flex-start"><button type="button" class="btn ghost small" id="edDel">Delete this draft</button></div>'}</div>`;
  // signers / roles
  $$('[data-who]', P).forEach((r) => {
    r.onclick = (e) => { if (e.target.closest('button')) return; if (E.active !== r.dataset.who) { E.active = r.dataset.who; drawPanel(); $(`[data-who="${CSS.escape(r.dataset.who)}"] input`, P)?.focus(); } };
    $$('[data-pk]', r).forEach((i) => (i.oninput = () => { const p = E.people.find((x) => x.key === r.dataset.who); p[i.dataset.pk] = i.dataset.pk === 'order' ? Number(i.value) || 1 : i.value; E.dirty = true; drawFields(); }));
  });
  $$('[data-rm]', P).forEach((b) => (b.onclick = () => {
    const k = b.dataset.rm, n = E.fields.filter((f2) => f2.signer === k).length;
    if (E.people.length === 1) return C.toast(E.tpl ? 'A template needs at least one role' : 'Someone has to sign');
    if (n && !confirm(`Take them off and remove their ${n} ${n === 1 ? 'field' : 'fields'}?`)) return;
    E.people = E.people.filter((p) => p.key !== k); E.fields = E.fields.filter((f2) => f2.signer !== k);
    if (E.active === k) E.active = E.people[0]?.key || null;
    E.dirty = true; drawPanel(); drawFields();
  }));
  $('#edAddWho', P).onclick = () => {
    const k = nextKey(); const order = Math.max(0, ...E.people.map((p) => p.order || 0)) + 1;
    E.people.push(E.tpl ? { key: k, label: '', order } : { key: k, name: '', email: '', phone: '', order });
    E.active = k; E.dirty = true; drawPanel(); $(`[data-who="${k}"] input`, P)?.focus();
  };
  $('#edOrd', P).onchange = (e) => { E.ordered = e.target.checked; E.people.forEach((p, i) => (p.order ||= i + 1)); E.dirty = true; drawPanel(); };
  // field types: tap to arm, or drag onto a page
  $$('[data-type]', P).forEach((b) => {
    b.onclick = () => { if (!E.active) return C.toast('Add who signs first'); E.arm = E.arm === b.dataset.type ? null : b.dataset.type; drawPanel(); hint(); };
    b.ondragstart = (e) => { if (!E.active) { e.preventDefault(); return; } e.dataTransfer.setData('text/plain', 'esf:' + b.dataset.type); e.dataTransfer.effectAllowed = 'copy'; };
  });
  if (f) {
    $('#edFT', P).onchange = (e) => { f.type = e.target.value; const s = sizeFor(f.type, f.page); f.w = s.w; f.h = s.h; if (['date', 'name'].includes(f.type)) f.required = true; E.dirty = true; drawPanel(); drawFields(); };
    $('#edFW', P).onchange = (e) => { f.signer = e.target.value; E.dirty = true; drawFields(); };
    if ($('#edFL', P)) $('#edFL', P).oninput = (e) => { f.label = e.target.value; E.dirty = true; drawFields(); };
    if ($('#edFR', P)) $('#edFR', P).onchange = (e) => { f.required = e.target.checked; E.dirty = true; drawFields(); };
    $('#edFD', P).onclick = () => { E.fields = E.fields.filter((x) => x.id !== f.id); E.sel = null; E.dirty = true; drawPanel(); drawFields(); };
  }
  $('#edT', P).oninput = (e) => { E.title = e.target.value; E.dirty = true; };
  $('#edM', P).oninput = (e) => { E.message = e.target.value; E.dirty = true; };
  if ($('#edDs', P)) $('#edDs', P).oninput = (e) => { E.description = e.target.value; E.dirty = true; };
  if ($('#edCo', P)) { $('#edCo', P).onchange = (e) => { E.links = { company_id: e.target.value, person_id: '', job_id: '', opportunity_id: '' }; E.dirty = true; drawLinks(); }; drawLinks(); }
  if ($('#edArch', P)) $('#edArch', P).onclick = async () => {
    if (!confirm('Remove this template? Documents already sent from it stay as they are.')) return;
    const { error } = await sb.rpc('esign_template_archive', { p_id: E.id }); if (error) return C.fail(error);
    C.toast('Template removed'); TAB = 'tpl'; C.go('esign');
  };
  if ($('#edDel', P)) $('#edDel', P).onclick = async () => {
    if (!confirm('Delete this draft?')) return;
    const { error } = await sb.rpc('esign_envelope_delete', { p_id: E.id }); if (error) return C.fail(error);
    C.toast('Draft deleted'); C.go('esign');
  };
  hint();
}
// person, job and deal under the picked organization
async function drawLinks() {
  const box = $('#edLinks'); if (!box) return;
  const co = E.links.company_id;
  if (!co) { box.innerHTML = ''; return; }
  const [{ data: ppl }, { data: jobs }, { data: deals }] = await Promise.all([
    sb.from('company_people').select('person_id,people(id,first_name,last_name)').eq('company_id', co),
    FLD.feat('jobs') ? sb.from('jobs').select('id,number,title').eq('company_id', co).is('archived_at', null).order('scheduled_start', { ascending: false }).limit(100) : { data: [] },
    FLD.feat('sales') ? sb.from('opportunities').select('id,status,estimated_value').eq('company_id', co).limit(100) : { data: [] }]);
  const sel = (id, label, opts, cur) => `<label class="label" for="${id}">${label}</label><select id="${id}"><option value="">None</option>${opts.map(([v, n]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  box.innerHTML = sel('edLP', FLD.L('person'), (ppl || []).map((x) => x.people).filter(Boolean).map((p) => [p.id, `${p.first_name || ''} ${p.last_name || ''}`.trim()]), E.links.person_id)
    + ((jobs || []).length ? sel('edLJ', FLD.L('job'), jobs.map((j) => [j.id, `${j.number ? '#' + j.number + ' ' : ''}${j.title || ''}`]), E.links.job_id) : '')
    + ((deals || []).length ? sel('edLD', FLD.L('deal'), deals.map((x) => [x.id, `${x.status || 'Open'}${x.estimated_value ? ' · $' + Number(x.estimated_value).toLocaleString('en-US') : ''}`]), E.links.opportunity_id) : '');
  [['edLP', 'person_id'], ['edLJ', 'job_id'], ['edLD', 'opportunity_id']].forEach(([i, k]) => { const s = $('#' + i, box); if (s) s.onchange = () => { E.links[k] = s.value; E.dirty = true; }; });
}
function hint() {
  const h = $('#edHint'); if (!h) return;
  $('#edPages')?.classList.toggle('arm', !!E.arm);
  h.textContent = E.arm ? `Tap the page where the ${TYPE_NAME[E.arm].toLowerCase()} goes.` : `${E.fields.length} ${E.fields.length === 1 ? 'field' : 'fields'} placed.`;
}
// a sensible starting size, as fractions of this page
function sizeFor(type, page) {
  const pg = E.pages[(page || 1) - 1] || { w: 612, h: 792 };
  const pts = { signature: [180, 40], initials: [54, 30], date: [100, 22], name: [160, 22], text: [160, 22], checkbox: [16, 16] }[type] || [120, 22];
  return { w: Math.min(1, pts[0] / pg.w), h: Math.min(1, pts[1] / pg.h) };
}
function addField(type, page, fx, fy) {
  const s = sizeFor(type, page);
  const f = { id: rid() + rid(), signer: E.active, type, page, w: s.w, h: s.h, x: Math.max(0, Math.min(1 - s.w, fx - s.w / 2)), y: Math.max(0, Math.min(1 - s.h, fy - s.h / 2)),
    required: type !== 'checkbox' && type !== 'text' ? true : false };
  E.fields.push(f); E.sel = f.id; E.arm = null; E.dirty = true;
  drawPanel(); drawFields();
}
function wirePage(p) {
  const at = (e) => { const r = p.ov.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  p.ov.onclick = (e) => {
    if (e.target !== p.ov) return;
    if (E.arm) { const [x, y] = at(e); addField(E.arm, p.n, x, y); }
    else if (E.sel) { E.sel = null; drawPanel(); drawFields(); }
  };
  p.ov.ondragover = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
  p.ov.ondrop = (e) => { const t = (e.dataTransfer.getData('text/plain') || '').replace(/^esf:/, ''); if (!TYPE_NAME[t]) return; e.preventDefault(); const [x, y] = at(e); addField(t, p.n, x, y); };
}
function drawFields() {
  if (!E?.pg) return;
  E.pg.forEach((p) => {
    p.ov.innerHTML = E.fields.filter((f) => f.page === p.n).map((f) => `<div class="esf ${f.id === E.sel ? 'sel' : ''}" data-fid="${esc(f.id)}" style="--c:${colorOf(f.signer)};left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%"
        title="${esc(TYPE_NAME[f.type])} for ${esc(whoLabel(E.people.find((x) => x.key === f.signer) || {}))}"><span>${f.type === 'checkbox' ? '' : esc(f.label || TYPE_NAME[f.type])}</span>${f.required && !['date', 'name'].includes(f.type) ? '<b class="esreq">*</b>' : ''}<i class="esrz"></i></div>`).join('');
    $$('.esf', p.ov).forEach((el) => wireField(el, p));
  });
  hint();
}
// drag to move, drag the corner to resize; a plain tap selects
function wireField(el, p) {
  el.onpointerdown = (e) => {
    e.preventDefault(); e.stopPropagation();
    const f = E.fields.find((x) => x.id === el.dataset.fid); if (!f) return;
    const r = p.ov.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, o = { ...f }, rs = e.target.classList.contains('esrz');
    let moved = false;
    el.setPointerCapture?.(e.pointerId);
    el.onpointermove = (m) => {
      const dx = (m.clientX - sx) / r.width, dy = (m.clientY - sy) / r.height;
      if (!moved && Math.abs(m.clientX - sx) + Math.abs(m.clientY - sy) < 3) return;
      moved = true;
      if (rs) { f.w = Math.max(0.01, Math.min(1 - f.x, o.w + dx)); f.h = Math.max(0.008, Math.min(1 - f.y, o.h + dy)); }
      else { f.x = Math.max(0, Math.min(1 - f.w, o.x + dx)); f.y = Math.max(0, Math.min(1 - f.h, o.y + dy)); }
      Object.assign(el.style, { left: f.x * 100 + '%', top: f.y * 100 + '%', width: f.w * 100 + '%', height: f.h * 100 + '%' });
    };
    el.onpointerup = () => {
      el.onpointermove = null; el.onpointerup = null;
      if (moved) E.dirty = true;
      if (E.sel !== f.id || !moved) { E.sel = f.id; if (E.active !== f.signer) E.active = f.signer; drawPanel(); drawFields(); }
    };
  };
}
async function save(say) {
  const people = E.tpl ? E.people.map((p, i) => ({ key: p.key, label: (p.label || '').trim(), order: E.ordered ? p.order || i + 1 : i + 1 }))
    : E.people.filter((p) => (p.name || '').trim() || (p.email || '').trim()).map((p, i) => ({ key: p.key, name: p.name.trim(), email: p.email.trim(), phone: (p.phone || '').trim() || null, order: E.ordered ? p.order || i + 1 : i + 1, role_label: p.role_label || null }));
  const keys = new Set(people.map((p) => p.key));
  const orphan = E.fields.find((f) => !keys.has(f.signer));
  if (orphan) { C.toast(`Fill in the ${E.tpl ? 'role name' : 'name and email'} for everyone who has fields first`); return false; }
  const fields = E.fields.map(({ id, signer, type, page, x, y, w, h, required, label }) => ({ id, signer, type, page, x, y, w, h, required, label }));
  const { error } = E.tpl
    ? await sb.rpc('esign_template_save', { p: { id: E.id, name: E.title, description: E.description, message: E.message, roles: people, fields, ordered: E.ordered, pages: E.pages } })
    : await sb.rpc('esign_envelope_update', { p_id: E.id, p: { title: E.title, message: E.message, ordered: E.ordered, signers: people, fields, pages: E.pages,
        company_id: E.links.company_id || null, person_id: E.links.person_id || null, job_id: E.links.job_id || null, opportunity_id: E.links.opportunity_id || null } });
  if (error) { C.fail(error); return false; }
  E.dirty = false;
  if (say) C.toast('Saved');
  return true;
}

/* ================= one envelope ================= */
async function viewDoc(main) {
  css();
  const id = S.param;
  const [{ data: e, error }, { data: sg }, { data: ev }] = await Promise.all([
    sb.from('esign_envelopes').select('*').eq('id', id).maybeSingle(),
    sb.from('esign_signers').select(SIGNER_COLS).eq('envelope_id', id).order('sign_order'),
    sb.from('esign_events').select('*').eq('envelope_id', id).order('at')]);
  if (error) return noDb(main, 'E-sign');
  if (!e || e.archived_at) { main.innerHTML = '<h1>E-sign</h1><p class="empty">That document isn\'t here, or it\'s someone else\'s.</p>'; return; }
  const ss = sg || [];
  const [{ data: co }, { data: pe }, { data: job }] = await Promise.all([
    e.company_id ? sb.from('companies').select('id,name').eq('id', e.company_id).maybeSingle() : { data: null },
    e.person_id ? sb.from('people').select('id,first_name,last_name').eq('id', e.person_id).maybeSingle() : { data: null },
    e.job_id ? sb.from('jobs').select('id,number,title').eq('id', e.job_id).maybeSingle() : { data: null }]);
  const open = OPEN.includes(e.status);
  const allSigned = ss.length && ss.every((s) => s.signed_at);
  const mine = e.owner_id === S.me?.id;
  const turn = (s) => !s.signed_at && !s.declined_at && (!e.ordered || s.sign_order === Math.min(...ss.filter((x) => !x.signed_at).map((x) => x.sign_order)));
  const expired = open && e.expires_at && new Date(e.expires_at) < new Date();
  main.innerHTML = `<div class="toolbar"><button class="btn ghost small" data-nav="esign">‹ E-sign</button><h1 style="flex:1;margin:0">${esc(e.title)}</h1> ${badge(e.status)}</div>
    <div class="actions" style="justify-content:flex-start;flex-wrap:wrap;margin:0 0 12px">
      ${e.status === 'draft' && canEdit() ? '<button class="btn small" data-nav2="esignedit">Edit and send</button>' : ''}
      ${open && canEdit() && !expired && !allSigned ? '<button class="btn small" id="dRemind">Remind whose turn it is</button>' : ''}
      ${open && allSigned && canEdit() ? '<button class="btn small" id="dFinish">Make the signed copy</button>' : ''}
      ${e.final_path ? '<button class="btn small" id="dFinal">Download the signed PDF</button>' : ''}
      <button class="btn ghost small" id="dOrig">Download the original</button>
      ${open && canEdit() && (mine || canVoidAny()) ? '<button class="btn ghost small" id="dVoid">Void</button>' : ''}</div>
    ${expired ? '<p class="banner warn">The signing links expired. Void this one and send a new one.</p>' : ''}
    ${e.status === 'voided' ? `<p class="banner warn">Voided ${esc(fmtDT(e.voided_at))}${e.void_reason ? ': ' + esc(e.void_reason) : ''}</p>` : ''}
    ${open && allSigned ? '<p class="banner warn">Everyone signed, but the signed copy didn\'t get made. Try Make the signed copy.</p>' : ''}
    <div class="card"><table class="esdet"><tbody>
      <tr><td>File</td><td>${esc(e.file_name)} · ${(e.pages || []).length} ${(e.pages || []).length === 1 ? 'page' : 'pages'} · ${(e.fields || []).length} fields</td></tr>
      ${co || pe || job ? `<tr><td>About</td><td>${co ? `<a href="#org/${co.id}">${esc(co.name)}</a>` : ''}${pe ? ` · <a href="#people/${pe.id}">${esc(`${pe.first_name || ''} ${pe.last_name || ''}`.trim())}</a>` : ''}${job ? ` · <a href="#job/${job.id}">${esc(`${FLD.L('job')} ${job.number ? '#' + job.number : ''} ${job.title || ''}`)}</a>` : ''}</td></tr>` : ''}
      <tr><td>Sent by</td><td>${esc(C.userName(e.owner_id) || '')}${e.sent_at ? ' · ' + esc(fmtDT(e.sent_at)) : ' · not sent yet'}${e.ordered ? ' · in order' : ''}</td></tr>
      ${e.expires_at && open ? `<tr><td>Links work until</td><td>${esc(fmtDT(e.expires_at))}</td></tr>` : ''}
      ${e.completed_at ? `<tr><td>Completed</td><td>${esc(fmtDT(e.completed_at))}</td></tr>` : ''}
      ${e.message ? `<tr><td>Message</td><td style="white-space:pre-wrap">${esc(e.message)}</td></tr>` : ''}
      ${e.original_sha256 ? `<tr><td>Original fingerprint</td><td class="esmono">${esc(e.original_sha256)}<br><small>SHA-256 of the PDF when it was sent. It's locked from then on.</small></td></tr>` : ''}
      ${e.final_sha256 ? `<tr><td>Signed fingerprint</td><td class="esmono">${esc(e.final_sha256)}<br><small>Anyone can check a copy at <a href="/sign/?verify=1" target="_blank" rel="noopener">/sign/?verify=1</a></small></td></tr>` : ''}
    </tbody></table></div>
    <div class="card"><h2>Signers</h2><table class="esdet"><tbody>${ss.map((s) => `<tr data-s="${s.id}"><td><b>${esc(s.name)}</b>${s.role_label ? ` <span class="badge">${esc(s.role_label)}</span>` : ''}<br><small>${esc(s.email)}${s.phone ? ' · ' + esc(s.phone) : ''}${e.ordered ? ' · signs ' + s.sign_order + (s.sign_order === 1 ? 'st' : s.sign_order === 2 ? 'nd' : s.sign_order === 3 ? 'rd' : 'th') : ''}</small></td>
      <td>${esc(e.status === 'draft' ? 'Not sent' : SIGNER_STATUS[s.status] || s.status)}${s.signed_at ? ' ' + esc(fmtDT(s.signed_at)) : s.viewed_at ? ' ' + esc(fmtDT(s.viewed_at)) : ''}
        ${s.decline_reason ? `<br><small>Why: ${esc(s.decline_reason)}</small>` : ''}${s.signed_at ? `<br><small>${esc([s.sign_ip, s.sign_device, s.sign_browser].filter(Boolean).join(' · '))}</small>` : ''}
        ${s.reminders ? `<br><small>${s.reminders} ${s.reminders === 1 ? 'reminder' : 'reminders'}</small>` : ''}</td>
      <td style="text-align:right">${open && canEdit() && !expired && turn(s) ? `<button class="btn ghost small" data-rem="${s.id}">Remind</button>` : ''}</td></tr>`).join('') || '<tr><td class="empty">Nobody yet.</td></tr>'}</tbody></table></div>
    <div class="card"><h2>Event log</h2><p class="hint" style="margin-top:0">Times are from the server. The signed PDF has the same log on its last page.</p>
      <div class="tablewrap"><table class="eslog"><tbody>${(ev || []).map((v) => `<tr><td style="white-space:nowrap">${esc(fmtSec(v.at))}</td><td>${esc(EVENT_NAME[v.kind] || v.kind)}${v.detail?.reason ? `<br><small>${esc(v.detail.reason)}</small>` : ''}</td>
        <td>${esc(v.name || '')}${v.email ? `<br><small>${esc(v.email)}</small>` : ''}</td><td><small>${esc([v.ip, v.device, v.browser].filter(Boolean).join(' · '))}</small></td></tr>`).join('') || '<tr><td class="empty">Nothing yet.</td></tr>'}</tbody></table></div></div>`;
  $$('[data-nav]', main).forEach((b) => (b.onclick = () => C.go(b.dataset.nav)));
  $$('[data-nav2]', main).forEach((b) => (b.onclick = () => C.go(b.dataset.nav2, id)));
  const dl = async (path, name) => {
    const { data, error: e2 } = await sb.storage.from(BUCKET).createSignedUrl(path, 300, { download: name });
    if (e2 || !data?.signedUrl) return C.fail(e2 || new Error('Couldn\'t get the file'));
    const a = document.createElement('a'); a.href = data.signedUrl; a.download = name; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
  };
  $('#dOrig', main).onclick = () => dl(e.file_path, e.file_name);
  if ($('#dFinal', main)) $('#dFinal', main).onclick = () => dl(e.final_path, e.final_path.split('/').pop());
  const remind = async (btn, signer) => {
    btn.disabled = true;
    const { data, error: e2 } = await sb.functions.invoke('esign-email', { body: { action: 'remind', id, signer } });
    const msg = await fnError(e2, data);
    if (msg) { btn.disabled = false; return C.toast(msg, { error: true }); }
    C.toast(`Reminder emailed${data?.emailed > 1 ? ` to ${data.emailed} people` : ''}`); viewDoc(main);
  };
  if ($('#dRemind', main)) $('#dRemind', main).onclick = (ev2) => remind(ev2.target, null);
  $$('[data-rem]', main).forEach((b) => (b.onclick = () => remind(b, b.dataset.rem)));
  if ($('#dFinish', main)) $('#dFinish', main).onclick = async (ev2) => {
    ev2.target.disabled = true; ev2.target.textContent = 'Working…';
    const { data, error: e2 } = await sb.functions.invoke('esign-email', { body: { action: 'finish', id } });
    const msg = await fnError(e2, data);
    if (msg) { ev2.target.disabled = false; ev2.target.textContent = 'Make the signed copy'; return C.toast(msg, { error: true }); }
    C.toast('Signed copy made and emailed'); viewDoc(main);
  };
  if ($('#dVoid', main)) $('#dVoid', main).onclick = () => {
    const d = dlg('esVoid', `<div class="vhead"><h2 style="margin:0">Void this document</h2><button class="btn ghost small" data-x>Close</button></div>
      <p>The signing links stop working right away. Signatures already made stay in the log.</p>
      <label class="label" for="vR">Why</label><textarea id="vR" rows="3" maxlength="1000" placeholder="Sent the wrong version"></textarea>
      <div class="actions"><button class="btn" id="vGo">Void it</button></div>`);
    $('[data-x]', d).onclick = () => d.close();
    $('#vGo', d).onclick = async () => {
      const why = $('#vR', d).value.trim(); if (!why) return C.toast('Say why you\'re voiding it');
      const { error: e2 } = await sb.rpc('esign_void', { p_id: id, p_reason: why }); if (e2) return C.fail(e2);
      d.close(); C.toast('Voided'); viewDoc(main);
    };
  };
}

/* ================= Tools, Admin, E-sign ================= */
async function viewSetup(main) {
  css();
  const { data: s, error } = await sb.rpc('esign_settings_get');
  if (error || !s) return noDb(main, 'E-sign setup');
  main.innerHTML = `<h1>E-sign</h1>
    <p class="eswet"><b>Not for wills or trusts.</b> ${esc(WET_NOTE)}</p>
    <div class="card"><label class="label" for="sM">Default message in the email</label><textarea id="sM" rows="3" maxlength="2000">${esc(s.default_message || '')}</textarea>
      <label class="label" for="sE">Signing links work for (days)</label><input type="number" id="sE" min="1" max="365" value="${esc(s.expires_days || 30)}" style="max-width:140px">
      <div class="actions"><button class="btn" id="sSave" ${s.can_edit ? '' : 'disabled'}>Save</button></div></div>
    <div class="card"><h2>How signing works</h2>
      <p>Each signer gets their own link by email. They see the document, tick that they agree to sign electronically, get a 6 digit code by email (good for 10 minutes, 5 tries), then sign. Every step is logged with their name, email, IP address, device, browser and the server's time.</p>
      <p>When everyone signs, the fields are written into the PDF with a signing certificate on the last page, everyone gets a copy and the fingerprint (SHA-256) is saved. Anyone can check a copy at <a href="/sign/?verify=1" target="_blank" rel="noopener">${esc(S.pub())}/sign/?verify=1</a>.</p>
      <p class="hint">What signers agree to: "${esc(CONSENT_TEXT)}"</p>
      <p class="hint">Codes go by email for now. Codes by text come once texting is set up.</p></div>
    <p class="hint">Turn E-sign on or off in Settings, Features. Who can send, void and set it up is in Roles, E-sign.</p>`;
  $('#sSave', main).onclick = async () => {
    const { error: e2 } = await sb.rpc('esign_settings_save', { p: { default_message: $('#sM', main).value, expires_days: Number($('#sE', main).value) || 30 } });
    if (e2) return C.fail(e2);
    C.toast('Saved');
  };
}
