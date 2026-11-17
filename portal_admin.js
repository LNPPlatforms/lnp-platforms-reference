/* portal_admin.js: the CRM side of the client portal. The Client portal card on an organization (invite the client's
   admin, see who has access, email invites again, remove access, preview what they see, choose what they see) and
   Tools, Admin, Client portal (sections on or off, the files and photos default, a welcome line).
   The client-facing page is portal/index.html. Decisions: BACKLOG.md "Oct 30 morning voice decisions", Client portal
   bullet. Database: schema/074*. Plugs into app.js through init(ctx) like bids.js. */
import * as FLD from './field.js?v=20261116t';

let C = null, sb, S, esc, $, $$;
export function init(ctx) { C = ctx; ({ sb, S, esc, $, $$ } = ctx); }
const can = (a, l = 1) => FLD.can(a, l);
export const on = () => FLD.feat('portal');
export const canManage = () => on() && (C.isAdmin() || can('contacts', 3));
export const canSetup = () => on() && (C.isAdmin() || can('settings', 4));

export const SECTIONS = [
  ['schedule', 'Upcoming schedule', 'Their jobs and visits, for them and the locations under them'],
  ['estimates', 'Estimates and proposals', 'Sent ones, with the button to accept'],
  ['invoices', 'Invoices and paying', 'Sent invoices. The pay button shows only when you have a way to take payments set up'],
  ['files', 'Documents and job photos', 'Only the ones you share (or all of them, if you flip the default below)'],
  ['messages', 'Messages with your team', 'They land in your Inbox like a chat'],
  ['approvals', 'Needs your approval', 'Change orders waiting on a yes'],
];
const ago = (s) => (s ? new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
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
  s.textContent = `.pu{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--line)}.pu>span{flex:1;min-width:180px}
.pu small{display:block;color:var(--muted)}.pu .acts{display:flex;gap:6px;flex-wrap:wrap}
.pinv{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:end;margin-top:10px}.pinv input{margin:0}
.vis h3{margin:16px 0 6px;font-size:15px}.visrow{display:flex;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)}
.visrow>span{flex:1;min-width:0}.visrow small{display:block;color:var(--muted)}.visrow select{margin:0;width:auto;min-width:120px}.visrow img{width:48px;height:48px;object-fit:cover;border-radius:6px;flex:none}
.visrow input[type=checkbox]{width:22px;height:22px;flex:none}.visnote{margin:4px 0 0;font-size:13px}
.check.featrow>input{flex:none}
@media (max-width:640px){.pinv{grid-template-columns:1fr}.visrow{flex-wrap:wrap}}`;
  document.head.appendChild(s);
}

/* ================= navigation pieces ================= */
export const drawerItems = () => ({
  admin: [{ id: 'portalsetup', label: 'Client portal', match: ['portalsetup'], what: 'Which sections clients see, whether files are shared by default and a welcome line', when: () => canSetup() }],
});
export const views = () => ({ portalsetup: viewSetup });
export const parents = { portalsetup: 'tools' };
export const guards = { portalsetup: () => canSetup() };

async function sendInvite(id, quiet) {
  const { data, error } = await sb.functions.invoke('portal-invite-email', { body: { id } });
  const msg = error ? (await error.context?.json?.().catch(() => null))?.error || error.message : data?.error;
  if (msg) { C.toast(`Access is set, but the email didn't go out: ${msg}`, { error: true }); return false; }
  if (!quiet) C.toast('Invite emailed');
  return true;
}

/* ================= the card on an organization ================= */
export async function orgBox(box, c) {
  if (!box || !canManage() || c.archived_at) return;
  css();
  const { data, error } = await sb.rpc('portal_admin_get', { p_company: c.id });
  if (error || !data) return;
  const users = data.users || [];
  const noAdmin = !users.some((u) => u.is_admin);
  box.innerHTML = `<div class="card"><div class="toolbar" style="margin:0"><h2 style="flex:1;margin:0">Client portal</h2>
      <a class="btn ghost small" href="/portal/?preview=${esc(c.id)}" target="_blank" rel="noopener" data-title="What ${esc(c.name)} sees">Preview what they see</a>
      <button type="button" class="btn ghost small" id="pvVis">Choose what they see</button></div>
    ${data.parent_portal ? `<p class="hint">People in ${esc(data.parent_portal.name)}'s portal already see this ${esc(FLD.l('organization'))}.</p>` : ''}
    ${users.length ? `<div>${users.map((u) => `<div class="pu" data-pu="${u.id}"><span><b>${esc(u.name || u.email)}</b> ${u.is_admin ? '<span class="badge ok">Their admin</span>' : ''}
        ${u.joined ? '' : '<span class="badge gold">Hasn\'t signed up yet</span>'}
        <small>${esc(u.email)}${u.by_client ? ' · invited by their admin' : ''}${u.last_seen_at ? ' · last signed in ' + esc(ago(u.last_seen_at)) : ''}</small></span>
        <span class="acts"><button type="button" class="btn ghost small" data-again>Email it again</button>
          <button type="button" class="btn ghost small" data-adm="${u.is_admin ? '0' : '1'}">${u.is_admin ? 'Not admin' : 'Make admin'}</button>
          <button type="button" class="btn ghost small danger" data-rm>Remove</button></span></div>`).join('')}</div>`
      : `<p class="hint" style="margin:6px 0 0">Give this client a login to see their schedule, estimates, invoices and shared files and photos. They can message your team too. The first person you invite is their admin and can invite their own people.</p>`}
    <div class="pinv"><div><label class="label" for="pvName">Name</label><input type="text" id="pvName" maxlength="120" autocomplete="off"></div>
      <div><label class="label" for="pvEmail">Email</label><input type="email" id="pvEmail" maxlength="200" autocomplete="off"></div>
      <button type="button" class="btn small" id="pvInv">${noAdmin ? 'Invite their admin' : 'Invite someone'}</button></div></div>`;
  $('#pvInv', box).onclick = async () => {
    const email = $('#pvEmail', box).value.trim(), name = $('#pvName', box).value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return C.toast('Enter their email');
    const b = $('#pvInv', box); b.disabled = true;
    const { data: id, error: e } = await sb.rpc('portal_admin_invite', { p_company: c.id, p_email: email, p_name: name });
    b.disabled = false;
    if (e) return C.fail(e);
    if (await sendInvite(id, true)) C.toast(`Invite emailed to ${email}`);
    orgBox(box, c);
  };
  $$('[data-pu]', box).forEach((row) => {
    const id = row.dataset.pu;
    $('[data-again]', row).onclick = () => sendInvite(id).then(() => orgBox(box, c));
    $('[data-adm]', row).onclick = async (e) => {
      const { error: er } = await sb.rpc('portal_admin_set', { p_id: id, p_admin: e.target.dataset.adm === '1' });
      if (er) return C.fail(er); C.toast('Saved'); orgBox(box, c);
    };
    $('[data-rm]', row).onclick = async () => {
      if (!confirm('Remove their portal access? They can\'t sign in to this portal after this.')) return;
      const { error: er } = await sb.rpc('portal_admin_remove', { p_id: id });
      if (er) return C.fail(er); C.toast('Access removed'); orgBox(box, c);
    };
  });
  $('#pvVis', box).onclick = () => visDialog(c);
}

/* ================= choose what they see ================= */
async function visDialog(c) {
  css();
  const { data, error } = await sb.rpc('portal_vis_list', { p_company: c.id });
  if (error || !data) return C.fail(error || { message: 'Not available' });
  const dflt = data.files_default === 'shared' ? 'shared' : 'hidden';
  const paths = (data.photos || []).map((p) => p.path);
  const urls = paths.length ? Object.fromEntries(((await sb.storage.from('job-photos').createSignedUrls(paths, 3600)).data || []).map((x) => [x.path, x.signedUrl])) : {};
  const sub = (r) => esc([r.location, r.at ? ago(r.at) : '', r.status].filter(Boolean).join(' · '));
  const toggle = (kind, r) => `<div class="visrow"><input type="checkbox" data-k="${kind}" data-id="${r.id}" ${r.shown ? 'checked' : ''} aria-label="Shows in the portal">
      <span><b>${esc(r.title)}</b><small>${sub(r)}</small>${kind === 'job' ? `<input type="text" class="visnote" data-note="${r.id}" maxlength="2000" placeholder="Note the client sees (optional)" value="${esc(r.note || '')}">` : ''}</span></div>`;
  const share = (kind, r) => `<div class="visrow">${kind === 'photo' ? `<img src="${esc(urls[r.path] || '')}" alt="">` : ''}
      <span><b>${esc(r.title)}</b><small>${sub(r)}</small></span>
      <select data-k="${kind}" data-id="${r.id}" aria-label="Who sees it"><option value="default" ${!r.share ? 'selected' : ''}>Default (${dflt === 'shared' ? 'shared' : 'internal'})</option>
        <option value="shared" ${r.share === 'shared' ? 'selected' : ''}>Shared</option><option value="internal" ${r.share === 'internal' ? 'selected' : ''}>Internal</option></select></div>`;
  const part = (h, rows, fn, kind, none) => `<h3>${h}</h3>${rows?.length ? rows.map((r) => fn(kind, r)).join('') : `<p class="empty" style="margin:0">${none}</p>`}`;
  const d = dlg('portalVis', `<div class="vhead"><h2 style="margin:0">What ${esc(c.name)} sees</h2><button class="btn ghost small" data-x>Close</button></div>
    <p class="hint">Ticked items show in their portal. Untick anything internal and it never shows. Files and photos follow your default (${dflt === 'shared' ? 'shared' : 'internal unless shared'}) unless you pick.</p>
    <div class="vis">${part(FLD.L('job', true), data.jobs, toggle, 'job', 'Nothing in the last 60 days or coming up.')}
      ${part('Invoices', data.invoices, toggle, 'invoice', 'No sent invoices.')}
      ${part(FLD.L('proposal', true), data.estimates, toggle, 'estimate', 'None sent.')}
      ${part('Documents', data.files, share, 'file', 'No documents. Add them under Assets.')}
      ${part('Job photos', data.photos, share, 'photo', 'No job photos yet.')}</div>`);
  $('[data-x]', d).onclick = () => d.close();
  const save = async (kind, id, state, note) => {
    const { error: e } = await sb.rpc('portal_vis_set', { p_kind: kind, p_id: id, p_state: state, p_note: note ?? null });
    if (e) return C.fail(e); C.toast('Saved');
  };
  $$('input[type=checkbox][data-k]', d).forEach((x) => (x.onchange = () => save(x.dataset.k, x.dataset.id, x.checked ? 'shown' : 'hidden')));
  $$('select[data-k]', d).forEach((x) => (x.onchange = () => save(x.dataset.k, x.dataset.id, x.value)));
  $$('[data-note]', d).forEach((x) => (x.onchange = () => {
    const cb = $(`input[type=checkbox][data-id="${x.dataset.note}"]`, d);
    save('job', x.dataset.note, cb.checked ? 'shown' : 'hidden', x.value);
  }));
}

/* ================= Tools > Admin > Client portal ================= */
async function viewSetup(main) {
  css();
  const { data: s, error } = await sb.rpc('portal_settings_get');
  if (error || !s) { main.innerHTML = '<h1>Client portal</h1><p class="empty">The client portal needs the October 30 database update. Once it\'s applied, this works.</p>'; return; }
  const edit = !!s.can_edit, dis = edit ? '' : 'disabled';
  main.innerHTML = `<h1>Client portal</h1>
    <div class="card"><h2>Where clients sign in</h2>
      <p><b>${esc(S.pub())}/portal/</b></p>
      <p class="hint">Invite people from each ${esc(FLD.l('organization'))}'s page (the Client portal card). The first person is the client's admin; they invite their own people and choose what each one sees. Two-step sign in is there for anyone who wants it. Your brand kit sets the logo and colors.</p></div>
    <div class="card"><h2>Sections</h2><small class="hint" style="margin:-4px 0 10px">Off means no client sees it, whatever their admin set.</small>
      ${SECTIONS.map(([k, n, w]) => `<label class="check featrow"><input type="checkbox" data-sec="${k}" ${s.sections?.[k] ? 'checked' : ''} ${dis}> <span><b>${esc(n)}</b><small class="hint" style="display:block;margin:0">${esc(w)}</small></span></label>`).join('')}</div>
    <div class="card"><h2>Files and photos</h2>
      <label class="check featrow"><input type="radio" name="pfd" value="hidden" ${s.files_default !== 'shared' ? 'checked' : ''} ${dis}> <span><b>Internal unless you share them</b><small class="hint" style="display:block;margin:0">Nothing shows until someone picks Shared on it.</small></span></label>
      <label class="check featrow"><input type="radio" name="pfd" value="shared" ${s.files_default === 'shared' ? 'checked' : ''} ${dis}> <span><b>Shared unless you mark them internal</b><small class="hint" style="display:block;margin:0">Every document and job photo for that client shows, except ones marked Internal.</small></span></label>
      <p class="hint">Jobs, sent invoices and sent ${esc(FLD.l('proposal', true))} always show unless someone unticks them in Choose what they see.</p></div>
    <div class="card"><h2>Welcome line</h2><label class="label" for="pWel">Shows at the top of their home page (optional)</label>
      <textarea id="pWel" maxlength="500" ${dis}>${esc(s.welcome || '')}</textarea></div>
    ${edit ? '<div class="actions"><button class="btn" id="pSave">Save</button></div>' : '<p class="hint">Your role can look but not change these.</p>'}`;
  if ($('#pSave')) $('#pSave').onclick = async () => {
    const sections = Object.fromEntries($$('[data-sec]', main).map((x) => [x.dataset.sec, x.checked]));
    const { error: e } = await sb.rpc('portal_settings_save', { p: { sections, files_default: $('input[name=pfd]:checked', main)?.value || 'hidden', welcome: $('#pWel').value } });
    if (e) return C.fail(e); C.toast('Saved'); viewSetup(main);
  };
}
