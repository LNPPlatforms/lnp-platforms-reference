/* grow.js: automations, tracked links and QR codes, webhooks, saved replies and templates, media, brand kit, reports,
   departments, chat widgets, Shortcuts with bulk actions, and the contact timeline. Decisions from Oct 29 night (BACKLOG.md).
   Plugs into app.js through init(ctx) like field.js. Everything is permission based: FLD.can(area, level). */
import * as FLD from './field.js?v=20261116t';
import { SUPABASE_URL } from './config.js';

let C = null, sb, S, esc, $, $$;
export function init(ctx) { C = ctx; ({ sb, S, esc, $, $$ } = ctx); }
const can = (a, l = 1) => FLD.can(a, l);
const APP = () => S.pub();
const noDb = (main, title) => (main.innerHTML = `<h1>${esc(title)}</h1><p class="empty">This screen needs the October 30 database update. Once it's applied, it works.</p>`);
const ago = (s) => { if (!s) return ''; const m = Math.round((Date.now() - new Date(s)) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' hr ago' : C.fmtDate(s); };
const uid = () => S.session?.user?.id;
const copy = async (text, msg = 'Copied') => { try { await navigator.clipboard.writeText(text); C.toast(msg); } catch { prompt('Copy this:', text); } };
const sel = (id, opts, cur, attrs = '') => `<select id="${id}" ${attrs}>${opts.map(([v, n]) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
const people = () => C.staff().map((u) => [u.id, u.full_name || u.email]);

// dynamic fields people can drop into replies, templates and automation steps
export const DYN = [
  ['contact.first_name', 'Their first name'], ['contact.last_name', 'Their last name'], ['contact.full_name', 'Their full name'], ['contact.email', 'Their email'], ['contact.phone', 'Their phone'],
  ['company.name', 'Their organization'], ['sender.first_name', 'Your first name'], ['sender.full_name', 'Your full name'], ['account.name', 'Your company name'],
];
// fill dynamic fields on the screen (saved replies in chat). Automations fill them on the server.
export function fill(text, ctx = {}) {
  const me = S.users.find((u) => u.id === uid()) || {};
  const base = { sender: { first_name: (me.full_name || '').split(' ')[0], full_name: me.full_name || '' }, account: { name: S.acct?.name || '' }, ...ctx };
  return String(text || '').replace(/\{([a-z_]+)\.([a-z0-9_]+)\}/g, (_, a, b) => (base[a]?.[b] ?? ''));
}
function dynButtons(target) {
  return `<div class="chips dynchips">${DYN.map(([k, n]) => `<button type="button" class="chip small" data-dyn="{${k}}" data-target="${target}" title="${esc(n)}">${esc(n)}</button>`).join('')}</div>`;
}
function bindDyn(root) {
  $$('[data-dyn]', root).forEach((b) => (b.onclick = () => {
    const ta = $('#' + b.dataset.target, root); if (!ta) return;
    const s = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + b.dataset.dyn + ta.value.slice(ta.selectionEnd ?? s); ta.focus(); ta.selectionStart = ta.selectionEnd = s + b.dataset.dyn.length;
  }));
}

/* ================= navigation pieces ================= */
export function drawerItems() {
  return {
    marketing: [
      { id: 'templates', label: 'Templates', match: ['templates'], what: 'Saved replies, emails and documents with fill-in fields', when: () => can('templates', 1) },
      { id: 'links', label: 'Links and QR codes', match: ['links'], what: 'Tracked links and QR codes that log clicks and can start things', when: () => can('marketing', 1) },
      { id: 'media', label: 'Media', match: ['media'], what: 'Pictures and files with share links', when: () => can('media', 1) },
      { id: 'brandkit', label: 'Brand kit', match: ['brandkit'], what: 'Logos, colors, fonts and do\'s and don\'ts', when: () => can('media', 1) || can('settings', 1) },
    ],
    automation: [
      { id: 'automations', label: 'Automations', match: ['automations', 'automation'], what: 'When something happens, do these steps', when: () => can('automations', 1) },
      { id: 'webhooks', label: 'Webhooks', match: ['webhooks'], what: 'Let outside apps send leads and data in', when: () => can('automations', 2) || can('sites', 2) },
    ],
    reports: [
      { id: 'reports', label: 'Reports', match: ['reports'], what: 'Build the report you want: count, group and compare', when: () => can('reports', 1) },
    ],
    admin: [
      { id: 'departments', label: 'Departments', match: ['departments'], what: 'Sales, Support and other teams, who\'s in them and who\'s customer facing', when: () => C.isAdmin() || can('team', 1) },
      { id: 'chatsetup', label: 'Chat assignment', match: ['chatsetup'], what: 'Who gets each website chat, round robin and the wait before everyone is pinged', when: () => C.isAdmin() || can('inbox', 4) },
    ],
  };
}
export const views = () => ({ automations: viewAutomations, automation: viewAutomation, links: viewLinks, webhooks: viewHooks, templates: viewTemplates,
  media: viewMedia, brandkit: viewBrandKit, reports: viewReports, departments: viewDepartments, chatsetup: viewChatSetup, contactlist: viewContactList });
export const parents = { automations: 'tools', automation: 'automations', links: 'tools', webhooks: 'tools', templates: 'tools', media: 'tools', brandkit: 'tools',
  reports: 'tools', departments: 'tools', chatsetup: 'tools', contactlist: 'people' };
export const guards = { automations: () => can('automations', 1), automation: () => can('automations', 1), links: () => can('marketing', 1), webhooks: () => can('automations', 2) || can('sites', 2),
  templates: () => can('templates', 1), media: () => can('media', 1), brandkit: () => can('media', 1) || can('settings', 1), reports: () => can('reports', 1),
  departments: () => C.isAdmin() || can('team', 1), chatsetup: () => C.isAdmin() || can('inbox', 4), contactlist: () => can('contacts', 1) };

// shared lists, loaded once per screen
async function loadDepts() {
  const [{ data: d, error }, { data: m }] = await Promise.all([sb.from('departments').select('*').is('archived_at', null).order('name'), sb.from('department_members').select('department_id,user_id')]);
  if (error) return null;
  return (d || []).map((x) => ({ ...x, members: (m || []).filter((y) => y.department_id === x.id).map((y) => y.user_id) }));
}
const scopeOpts = (canPublish, depts) => [['personal', 'Just me'], ...(canPublish ? [['company', 'Everyone on the account'], ...depts.map((d) => ['dept:' + d.id, 'Department: ' + d.name])] : [])];
const scopeVal = (r) => (r.scope === 'department' ? 'dept:' + r.department_id : r.scope);
const scopeSplit = (v) => (v.startsWith('dept:') ? { scope: 'department', department_id: v.slice(5) } : { scope: v, department_id: null });

/* ================= automations ================= */
const TRIGGERS = [
  ['contact_created', 'A contact is added'], ['field_changed', 'A field changes'], ['tag_added', 'A tag is added'], ['tag_removed', 'A tag is removed'],
  ['form_submitted', 'A form is submitted'], ['link_clicked', 'A tracked link is clicked'], ['qr_scanned', 'A QR code is scanned'], ['chat_started', 'A live chat starts'],
  ['webhook_in', 'A webhook comes in'], ['job_completed', 'A job is completed'], ['task_done', 'A to-do is done'], ['invoice_paid', 'An invoice is paid'],
  ['appointment_booked', 'An appointment is booked'], ['appointment_rescheduled', 'An appointment is rescheduled'], ['appointment_cancelled', 'An appointment is cancelled'],
  ['appointment_no_show', 'Someone doesn\'t show up'], ['appointment_completed', 'An appointment is completed'], ['manual', 'Started by hand (bulk action)'],
];
const STEPS = [
  ['email', 'Send an email'], ['wait', 'Wait'], ['if', 'If / then'], ['set_field', 'Update a field'], ['add_tag', 'Add a tag'], ['remove_tag', 'Remove a tag'],
  ['assign', 'Assign an owner'], ['task', 'Add a to-do'], ['notify', 'Notify someone'], ['webhook', 'Send a webhook'], ['start', 'Start another automation'], ['stop', 'Stop here'],
];
const OPS = [['equals', 'is'], ['not_equals', 'is not'], ['contains', 'contains'], ['empty', 'is empty'], ['not_empty', 'is not empty'], ['gt', 'is more than'], ['lt', 'is less than'], ['has', 'has tag'], ['not_has', 'does not have tag']];
const tname = (k) => (TRIGGERS.find((t) => t[0] === k) || [k, k])[1];

async function viewAutomations(main) {
  const { data, error } = await sb.from('automations').select('id,name,active,trigger,updated_at').is('archived_at', null).order('name');
  if (error) return noDb(main, 'Automations');
  const { data: runs } = await sb.from('automation_runs').select('automation_id,status').in('status', ['running', 'waiting']);
  const live = {}; (runs || []).forEach((r) => (live[r.automation_id] = (live[r.automation_id] || 0) + 1));
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Automations</h1>${can('automations', 2) ? '<button class="btn small" id="aNew">New automation</button>' : ''}</div>
    <p class="empty">When something happens (a form, a click, a field change), the CRM runs the steps you set: emails, waits, if/then, field updates, to-dos and more.</p>
    <div class="list">${(data || []).map((a) => `<button class="item" data-a="${a.id}"><b>${esc(a.name)}</b> ${a.active ? '<span class="badge ok">On</span>' : '<span class="badge">Off</span>'}
      <small>${esc(tname(a.trigger?.kind))}${live[a.id] ? ' · ' + C.plural(live[a.id], 'contact', 'contacts') + ' in it now' : ''}</small></button>`).join('') || '<p class="empty">No automations yet.</p>'}</div>`;
  if ($('#aNew')) $('#aNew').onclick = () => C.go('automation', 'new');
  $$('[data-a]', main).forEach((b) => (b.onclick = () => C.go('automation', b.dataset.a)));
}

async function viewAutomation(main) {
  const id = S.param && S.param !== 'new' ? S.param : null;
  const [aRes, { data: forms }, { data: links }, { data: hooks }, { data: tpls }, { data: autos }, { data: cfs }, { data: cals }] = await Promise.all([
    id ? sb.from('automations').select('*').eq('id', id).maybeSingle() : Promise.resolve({ data: { name: '', active: false, trigger: { kind: 'form_submitted' }, steps: [], allow_repeat: false } }),
    sb.from('site_forms').select('id,name').order('name'), sb.from('tracked_links').select('id,name,kind').is('archived_at', null).order('name'),
    sb.from('inbound_hooks').select('id,name').is('archived_at', null).order('name'), sb.from('templates').select('id,name,kind,scope').in('kind', ['email']).order('name'),
    sb.from('automations').select('id,name').is('archived_at', null).order('name'), sb.from('custom_fields').select('entity,key,label').is('archived_at', null),
    sb.from('calendars').select('id,name').is('archived_at', null).order('name'),
  ]);
  if (aRes.error) return noDb(main, 'Automation');
  const a = aRes.data; if (!a) { main.innerHTML = '<p class="empty">Not found.</p>'; return; }
  const edit = can('automations', 2);
  const FIELDS = [['contact.first_name', 'Contact: first name'], ['contact.last_name', 'Contact: last name'], ['contact.email', 'Contact: email'], ['contact.phone', 'Contact: phone'],
    ['contact.lead_source', 'Contact: lead source'], ...(cfs || []).filter((f) => f.entity === 'people').map((f) => ['contact.' + f.key, 'Contact: ' + f.label]),
    ['company.stage', 'Organization: stage'], ['company.interest_level', 'Organization: interest'], ['company.follow_up_date', 'Organization: follow up date'],
    ...(cfs || []).filter((f) => f.entity === 'companies').map((f) => ['company.' + f.key, 'Organization: ' + f.label]), ['tag', 'Tag']];
  const steps = JSON.parse(JSON.stringify(a.steps || []));
  const trig = { ...(a.trigger || {}) };

  const trigExtra = () => {
    const k = trig.kind;
    if (k === 'form_submitted') return `<label class="label">Which form</label>${sel('tgForm', [['', 'Any form'], ...(forms || []).map((f) => [f.id, f.name])], trig.form_id)}`;
    if (k === 'link_clicked' || k === 'qr_scanned') return `<label class="label">Which one</label>${sel('tgLink', [['', 'Any'], ...(links || []).filter((l) => l.kind === (k === 'qr_scanned' ? 'qr' : 'link')).map((l) => [l.id, l.name])], trig.link_id)}`;
    if ((k || '').startsWith('appointment_')) return `<label class="label">Which calendar</label>${sel('tgCal', [['', 'Any calendar'], ...(cals || []).map((c) => [c.id, c.name])], trig.calendar_id)}`;
    if (k === 'webhook_in') return `<label class="label">Which webhook</label>${sel('tgHook', [['', 'Any'], ...(hooks || []).map((h) => [h.id, h.name])], trig.hook_id)}`;
    if (k === 'tag_added' || k === 'tag_removed') return `<label class="label" for="tgTag">Tag (blank: any)</label><input type="text" id="tgTag" value="${esc(trig.tag || '')}">`;
    if (k === 'field_changed') return `<label class="label">Field</label>${sel('tgField', [['', 'Any field'], ...FIELDS.filter((f) => f[0] !== 'tag').map(([v, n]) => [v.replace(/^contact\./, '').replace(/^company\./, ''), n])], (trig.field || '').replace(/^custom\./, ''))}
      <label class="label" for="tgTo">Changes to (blank: anything)</label><input type="text" id="tgTo" value="${esc(trig.to || '')}">`;
    return '';
  };
  const readTrig = () => {
    trig.kind = $('#tgKind').value;
    ['form_id', 'link_id', 'hook_id', 'calendar_id', 'tag', 'field', 'to'].forEach((k) => delete trig[k]);
    if ($('#tgCal')?.value) trig.calendar_id = $('#tgCal').value;
    if ($('#tgForm')?.value) trig.form_id = $('#tgForm').value;
    if ($('#tgLink')?.value) trig.link_id = $('#tgLink').value;
    if ($('#tgHook')?.value) trig.hook_id = $('#tgHook').value;
    if ($('#tgTag')?.value.trim()) trig.tag = $('#tgTag').value.trim();
    if ($('#tgField')?.value) { const v = $('#tgField').value; const isCustom = (cfs || []).some((f) => f.key === v); trig.field = isCustom ? 'custom.' + v : v; }
    if ($('#tgTo')?.value.trim()) trig.to = $('#tgTo').value.trim();
  };

  // one step's settings
  const stepForm = (s, path) => {
    const f = (k) => `data-k="${k}" data-p="${path}"`;
    const v = (k) => esc(s[k] ?? '');
    switch (s.type) {
      case 'email': return `<div class="row"><div><label class="label">To</label><select ${f('to')}>${[['contact', 'The contact'], ['owner', 'The organization owner']].map(([x, n]) => `<option value="${x}" ${(s.to || 'contact') === x ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div><label class="label">Template</label><select ${f('template_id')}><option value="">Write it here</option>${(tpls || []).map((t) => `<option value="${t.id}" ${s.template_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div></div>
        <label class="label">Subject</label><input type="text" ${f('subject')} value="${v('subject')}" placeholder="Blank: the template's subject">
        <label class="label">Message</label><textarea rows="4" ${f('body')} placeholder="Blank: the template">${v('body')}</textarea><small class="hint">Fill-ins work here, like {contact.first_name}. People who unsubscribed are skipped.</small>`;
      case 'wait': return `<div class="row"><div><label class="label">How long</label><input type="number" min="1" ${f('amount')} value="${v('amount') || 1}"></div>
        <div><label class="label">&nbsp;</label><select ${f('unit')}>${['minutes', 'hours', 'days'].map((x) => `<option ${(s.unit || 'days') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>`;
      case 'if': return `<div class="row"><div><label class="label">If</label><select ${f('field')}>${FIELDS.map(([x, n]) => `<option value="${x}" ${s.field === x ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
        <div><label class="label">&nbsp;</label><select ${f('op')}>${OPS.map(([x, n]) => `<option value="${x}" ${(s.op || 'equals') === x ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div><label class="label">&nbsp;</label><input type="text" ${f('value')} value="${v('value')}" placeholder="value"></div></div>`;
      case 'set_field': return `<div class="row"><div><label class="label">Field</label><select ${f('field')}>${FIELDS.filter((x) => x[0] !== 'tag').map(([x, n]) => `<option value="${x}" ${s.field === x ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
        <div><label class="label">New value</label><input type="text" ${f('value')} value="${v('value')}"></div></div>`;
      case 'add_tag': case 'remove_tag': return `<label class="label">Tag</label><input type="text" ${f('tag')} value="${v('tag')}">`;
      case 'assign': return `<label class="label">Owner</label><select ${f('user_id')}><option value="">Pick someone</option>${people().map(([x, n]) => `<option value="${x}" ${s.user_id === x ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
      case 'task': return `<label class="label">To-do</label><input type="text" ${f('title')} value="${v('title')}" placeholder="Call {contact.first_name}">
        <div class="row"><div><label class="label">For</label><select ${f('assign_to')}><option value="owner" ${(s.assign_to || 'owner') === 'owner' ? 'selected' : ''}>The organization owner</option>${people().map(([x, n]) => `<option value="${x}" ${s.assign_to === x ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
        <div><label class="label">Due in (days)</label><input type="number" min="0" ${f('due_days')} value="${v('due_days') || 0}"></div></div>`;
      case 'notify': return `<label class="label">Who</label><select ${f('user_id')}><option value="owner">The organization owner</option>${people().map(([x, n]) => `<option value="${x}" ${s.user_id === x ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
        <label class="label">Message</label><input type="text" ${f('text')} value="${v('text')}" placeholder="{contact.full_name} filled out the form">`;
      case 'webhook': return `<label class="label">Send to (https://)</label><input type="url" ${f('url')} value="${v('url')}" placeholder="https://hooks.zapier.com/..."><small class="hint">Sends the contact, their organization and what started it as JSON.</small>`;
      case 'start': return `<label class="label">Automation</label><select ${f('automation_id')}><option value="">Pick one</option>${(autos || []).filter((x) => x.id !== id).map((x) => `<option value="${x.id}" ${s.automation_id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;
      default: return '';
    }
  };
  const getList = (path) => { // path like "2.then" or "" for the top
    let list = steps; if (!path) return list;
    const parts = path.split('.');
    for (let i = 0; i < parts.length; i += 2) list = list[Number(parts[i])][parts[i + 1]] ||= [];
    return list;
  };
  const stepsHtml = (list, path) => `<ol class="steps">${list.map((s, i) => {
    const p = path ? path + '.' + i : String(i);
    return `<li class="card step"><div class="toolbar"><b style="flex:1">${esc((STEPS.find((x) => x[0] === s.type) || [s.type, s.type])[1])}</b>
      ${edit ? `<button type="button" class="btn ghost small" data-up="${p}" aria-label="Move up">↑</button><button type="button" class="btn ghost small" data-dn="${p}" aria-label="Move down">↓</button><button type="button" class="btn ghost small danger" data-rm="${p}">Remove</button>` : ''}</div>
      ${stepForm(s, p)}
      ${s.type === 'if' ? `<div class="branch"><b>Then</b>${stepsHtml(s.then || [], p + '.then')}</div><div class="branch else"><b>Otherwise</b>${stepsHtml(s.else || [], p + '.else')}</div>` : ''}</li>`;
  }).join('')}</ol>${edit ? `<div class="addstep"><select data-addsel="${path}" aria-label="Add a step"><option value="">+ Add a step</option>${STEPS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></div>` : ''}`;
  const at = (p) => { const parts = p.split('.'); const i = Number(parts.pop()); return [getList(parts.join('.')), i]; };
  const readSteps = () => { $$('[data-k]', main).forEach((el) => { const [l, i] = at(el.dataset.p); l[i][el.dataset.k] = el.type === 'number' ? Number(el.value) : el.value; }); };

  const render = () => {
    main.innerHTML = `<div class="toolbar"><button class="btn ghost small" id="aBack">← Automations</button><div style="flex:1"></div>
        ${edit ? `<label class="featrow" style="margin:0"><input type="checkbox" id="aOn" ${a.active ? 'checked' : ''}> On</label>` : ''}</div>
      <div class="card"><label class="label" for="aName">Name</label><input type="text" id="aName" value="${esc(a.name)}" placeholder="New lead follow up" ${edit ? '' : 'disabled'}>
        <label class="label" for="tgKind">Starts when</label>${sel('tgKind', TRIGGERS, trig.kind, edit ? '' : 'disabled')}
        <div id="tgExtra">${trigExtra()}</div>
        <label class="featrow"><input type="checkbox" id="aRep" ${a.allow_repeat ? 'checked' : ''} ${edit ? '' : 'disabled'}> Can start again for someone who's already in it</label></div>
      <h2>Steps</h2><div id="aSteps">${stepsHtml(steps, '')}</div>
      ${edit ? `<div class="actions"><button class="btn" id="aSave">Save</button>${id ? '<button class="btn ghost danger small" id="aDel">Remove automation</button>' : ''}</div>` : ''}
      <div id="aRuns"></div>`;
    $('#aBack').onclick = () => C.go('automations');
    if (!edit) return;
    $('#tgKind').onchange = () => { readTrig(); $('#tgExtra').innerHTML = trigExtra(); };
    $$('[data-addsel]', main).forEach((s) => (s.onchange = () => { if (!s.value) return; readSteps(); const st = { type: s.value }; if (st.type === 'if') { st.then = []; st.else = []; st.op = 'equals'; st.field = 'tag'; } if (st.type === 'wait') { st.amount = 1; st.unit = 'days'; } getList(s.dataset.addsel).push(st); readTrig(); render(); }));
    $$('[data-rm]', main).forEach((b) => (b.onclick = () => { readSteps(); const [l, i] = at(b.dataset.rm); l.splice(i, 1); readTrig(); render(); }));
    $$('[data-up]', main).forEach((b) => (b.onclick = () => { readSteps(); const [l, i] = at(b.dataset.up); if (i > 0) [l[i - 1], l[i]] = [l[i], l[i - 1]]; readTrig(); render(); }));
    $$('[data-dn]', main).forEach((b) => (b.onclick = () => { readSteps(); const [l, i] = at(b.dataset.dn); if (i < l.length - 1) [l[i + 1], l[i]] = [l[i], l[i + 1]]; readTrig(); render(); }));
    $('#aSave').onclick = async () => {
      readSteps(); readTrig();
      a.name = $('#aName').value.trim(); a.active = $('#aOn').checked; a.allow_repeat = $('#aRep').checked;
      if (!a.name) return C.toast('Give it a name');
      const { data: nid, error } = await sb.rpc('automation_save', { p_id: id, p: { name: a.name, active: a.active, trigger: trig, steps, allow_repeat: a.allow_repeat } });
      if (error) return C.fail(error);
      C.toast('Saved'); if (!id) C.go('automation', nid); else render();
    };
    if ($('#aDel')) $('#aDel').onclick = async () => { if (!confirm('Remove this automation? Anyone in it stops.')) return; const { error } = await sb.rpc('automation_set', { p_id: id, p_active: false, p_archive: true }); if (error) return C.fail(error); C.go('automations'); };
    if (id) loadRuns();
  };
  async function loadRuns() {
    const { data: runs } = await sb.from('automation_runs').select('id,person_id,company_id,status,wake_at,log,created_at,people(first_name,last_name),companies(name)').eq('automation_id', id).order('created_at', { ascending: false }).limit(50);
    const box = $('#aRuns'); if (!box) return;
    box.innerHTML = `<div class="card"><h2>Who's been through it</h2>${(runs || []).map((r) => `<details class="runrow"><summary><b>${esc(r.people ? [r.people.first_name, r.people.last_name].filter(Boolean).join(' ') : r.companies?.name || 'Contact')}</b>
      <span class="badge ${r.status === 'failed' ? 'warn' : r.status === 'done' ? 'ok' : ''}">${esc(r.status === 'waiting' ? 'waiting until ' + new Date(r.wake_at).toLocaleString() : r.status)}</span> <small>${esc(ago(r.created_at))}</small></summary>
      <ul class="runlog">${(r.log || []).map((l) => `<li><small>${esc(new Date(l.at).toLocaleString())}</small> ${esc(l.msg)}</li>`).join('') || '<li><small>Starting soon</small></li>'}</ul>
      ${['running', 'waiting'].includes(r.status) && can('automations', 2) ? `<button class="btn ghost small" data-stop="${r.id}">Stop for them</button>` : ''}</details>`).join('') || '<p class="empty">Nobody yet.</p>'}</div>`;
    $$('[data-stop]', box).forEach((b) => (b.onclick = async () => { const { error } = await sb.rpc('automation_run_stop', { p_run: b.dataset.stop }); if (error) return C.fail(error); loadRuns(); }));
  }
  render();
}

/* ================= tracked links and QR codes ================= */
const goUrl = (slug) => `${APP()}/go/?s=${encodeURIComponent(slug)}`;
const qrImg = (url, size = 240) => `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=10&data=${encodeURIComponent(url)}`;
async function viewLinks(main) {
  const [{ data, error }, { data: autos }] = await Promise.all([sb.from('tracked_links').select('*').is('archived_at', null).order('created_at', { ascending: false }),
    sb.from('automations').select('id,name').is('archived_at', null).order('name')]);
  if (error) return noDb(main, 'Links and QR codes');
  const edit = can('marketing', 2);
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Links and QR codes</h1>${edit ? '<button class="btn small" id="lNew">New link</button><button class="btn small secondary" id="qNew">New QR code</button>' : ''}</div>
    <p class="empty">Every click and scan is counted. When the person is known (links in your emails), it lands on their timeline and can update a field, add a tag or start an automation.</p>
    <div id="lEd"></div>
    <div class="list">${(data || []).map((l) => `<div class="card linkrow"><div class="toolbar"><div style="flex:1;min-width:0"><b>${esc(l.name)}</b> <span class="badge">${l.kind === 'qr' ? 'QR code' : 'Link'}</span>
        <small class="hint" style="display:block;word-break:break-all">${esc(goUrl(l.slug))} → ${esc(l.url)}</small><small>${C.plural(l.clicks, l.kind === 'qr' ? 'scan' : 'click', l.kind === 'qr' ? 'scans' : 'clicks')}</small></div>
        ${l.kind === 'qr' ? `<img class="qrthumb" src="${esc(qrImg(goUrl(l.slug), 120))}" alt="QR code for ${esc(l.name)}" width="72" height="72">` : ''}</div>
      <div class="quick"><button class="btn ghost small" data-copy="${esc(goUrl(l.slug))}">Copy link</button>
        ${l.kind === 'qr' ? `<a class="btn ghost small" href="${esc(qrImg(goUrl(l.slug), 1000))}" target="_blank" rel="noopener" download="${esc(l.slug)}.png">Download QR</a>` : ''}
        ${edit ? `<button class="btn ghost small" data-ed="${l.id}">Edit</button><button class="btn ghost small danger" data-rm="${l.id}">Remove</button>` : ''}</div></div>`).join('') || '<p class="empty">No links yet.</p>'}</div>`;
  $$('[data-copy]', main).forEach((b) => (b.onclick = () => copy(b.dataset.copy, 'Link copied')));
  const editor = (l) => {
    const act = l.actions || {};
    $('#lEd').innerHTML = `<div class="card panel"><h2>${l.id ? 'Edit' : 'New'} ${l.kind === 'qr' ? 'QR code' : 'link'}</h2>
      <label class="label" for="lName">Name</label><input type="text" id="lName" value="${esc(l.name || '')}" placeholder="Spring flyer">
      <label class="label" for="lUrl">Sends people to</label><input type="url" id="lUrl" value="${esc(l.url || '')}" placeholder="https://">
      ${l.id ? '' : '<label class="label" for="lSlug">Short name (optional)</label><input type="text" id="lSlug" placeholder="spring" pattern="[A-Za-z0-9_-]{4,40}">'}
      <h3>When a known contact clicks</h3>
      <div class="row"><div><label class="label" for="lTag">Add tag</label><input type="text" id="lTag" value="${esc(act.add_tag || '')}"></div>
        <div><label class="label" for="lFld">Set field</label><input type="text" id="lFld" value="${esc(act.set_field?.field || '')}" placeholder="contact.interest"></div>
        <div><label class="label" for="lVal">To</label><input type="text" id="lVal" value="${esc(act.set_field?.value || '')}"></div></div>
      <label class="label">Start automation</label>${sel('lAuto', [['', 'None'], ...(autos || []).map((x) => [x.id, x.name])], act.automation_id)}
      <div class="actions"><button class="btn small" id="lSave">Save</button><button class="btn ghost small" id="lX">Cancel</button></div></div>`;
    $('#lX').onclick = () => ($('#lEd').innerHTML = '');
    $('#lSave').onclick = async () => {
      const actions = {};
      if ($('#lTag').value.trim()) actions.add_tag = $('#lTag').value.trim();
      if ($('#lFld').value.trim()) actions.set_field = { field: $('#lFld').value.trim(), value: $('#lVal').value };
      if ($('#lAuto').value) actions.automation_id = $('#lAuto').value;
      const { error } = await sb.rpc('link_save', { p_id: l.id || null, p: { name: $('#lName').value, url: $('#lUrl').value.trim(), kind: l.kind, slug: $('#lSlug')?.value || null, actions } });
      if (error) return C.fail(error); C.toast('Saved'); viewLinks(main);
    };
  };
  if ($('#lNew')) $('#lNew').onclick = () => editor({ kind: 'link' });
  if ($('#qNew')) $('#qNew').onclick = () => editor({ kind: 'qr' });
  $$('[data-ed]', main).forEach((b) => (b.onclick = () => editor(data.find((x) => x.id === b.dataset.ed))));
  $$('[data-rm]', main).forEach((b) => (b.onclick = async () => { if (!confirm('Remove this link? It stops working.')) return; const { error } = await sb.rpc('link_archive', { p_id: b.dataset.rm }); if (error) return C.fail(error); viewLinks(main); }));
}

/* ================= incoming webhooks ================= */
async function viewHooks(main) {
  const { data, error } = await sb.from('inbound_hooks').select('*').is('archived_at', null).order('created_at');
  if (error) return noDb(main, 'Webhooks');
  const url = `${SUPABASE_URL}/functions/v1/hook-in?t=`;
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Webhooks</h1><button class="btn small" id="hNew">New incoming webhook</button></div>
    <p class="empty">Give an outside app (Zapier, a website builder, an ad platform) its own address. It posts JSON, the CRM finds or adds the contact and fills the fields you map. To send data out, add a "Send a webhook" step to an automation.</p>
    <div id="hEd"></div>
    <div class="list">${(data || []).map((h) => `<div class="card"><div class="toolbar"><b style="flex:1">${esc(h.name)}</b>${h.active ? '<span class="badge ok">On</span>' : '<span class="badge">Off</span>'}</div>
      <small class="hint" style="word-break:break-all">${esc(url + h.token)}</small>
      <small>${C.plural(h.hits, 'post', 'posts')}${h.last_hit_at ? ' · last ' + esc(ago(h.last_hit_at)) : ''}</small>
      <div class="quick"><button class="btn ghost small" data-copy="${esc(url + h.token)}">Copy address</button><button class="btn ghost small" data-ed="${h.id}">Map fields</button></div></div>`).join('') || '<p class="empty">None yet.</p>'}</div>`;
  $$('[data-copy]', main).forEach((b) => (b.onclick = () => copy(b.dataset.copy, 'Address copied')));
  const flatKeys = (o, pre = '') => Object.entries(o || {}).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flatKeys(v, pre + k + '.') : [pre + k]));
  const editor = (h) => {
    const map = h.field_map || {}; const keys = flatKeys(h.last_body);
    const rows = [['contact.email', 'Email'], ['contact.phone', 'Phone'], ['contact.first_name', 'First name'], ['contact.last_name', 'Last name'], ...Object.keys(map).filter((k) => !['contact.email', 'contact.phone', 'contact.first_name', 'contact.last_name'].includes(k)).map((k) => [k, k])];
    $('#hEd').innerHTML = `<div class="card panel"><h2>${h.id ? 'Map fields' : 'New incoming webhook'}</h2>
      <label class="label" for="hName">Name</label><input type="text" id="hName" value="${esc(h.name || '')}" placeholder="Zapier leads">
      <label class="label">Match contacts by</label>${sel('hMatch', [['email', 'Email'], ['phone', 'Phone'], ['none', 'Don\'t match']], h.match_on || 'email')}
      <h3>Which incoming value goes where</h3>${keys.length ? `<small class="hint">From the last post: ${esc(keys.join(', '))}</small>` : '<small class="hint">Post a test first and the incoming names show up here. Use dots for nested values, like lead.email.</small>'}
      <table class="ptable"><tbody id="hRows">${rows.map(([k, n]) => `<tr><td>${esc(n)}</td><td><input type="text" data-map="${esc(k)}" value="${esc(map[k] || '')}" list="hKeys" placeholder="incoming name"></td></tr>`).join('')}</tbody></table>
      <datalist id="hKeys">${keys.map((k) => `<option value="${esc(k)}">`).join('')}</datalist>
      <div class="row"><div><input type="text" id="hNewF" placeholder="Another CRM field, like contact.budget"></div><div><button type="button" class="btn ghost small" id="hAdd">Add field</button></div></div>
      ${h.id ? `<label class="featrow"><input type="checkbox" id="hOn" ${h.active ? 'checked' : ''}> On</label>` : ''}
      <div class="actions"><button class="btn small" id="hSave">Save</button>${h.id ? '<button class="btn ghost small danger" id="hRm">Remove</button>' : ''}<button class="btn ghost small" id="hX">Cancel</button></div></div>`;
    $('#hX').onclick = () => ($('#hEd').innerHTML = '');
    $('#hAdd').onclick = () => { const k = $('#hNewF').value.trim().toLowerCase(); if (!/^(contact|company)\.[a-z0-9_]{1,40}$/.test(k)) return C.toast('Use contact.something or company.something'); $('#hRows').insertAdjacentHTML('beforeend', `<tr><td>${esc(k)}</td><td><input type="text" data-map="${esc(k)}" list="hKeys" placeholder="incoming name"></td></tr>`); $('#hNewF').value = ''; };
    $('#hSave').onclick = async () => {
      const field_map = {}; $$('[data-map]', $('#hEd')).forEach((i) => { if (i.value.trim()) field_map[i.dataset.map] = i.value.trim(); });
      const { error } = await sb.rpc('hook_save', { p_id: h.id || null, p: { name: $('#hName').value, field_map, match_on: $('#hMatch').value, active: $('#hOn') ? $('#hOn').checked : true } });
      if (error) return C.fail(error); C.toast('Saved'); viewHooks(main);
    };
    if ($('#hRm')) $('#hRm').onclick = async () => { if (!confirm('Remove this webhook? Its address stops working.')) return; const { error } = await sb.rpc('hook_save', { p_id: h.id, p: { name: h.name, archive: true } }); if (error) return C.fail(error); viewHooks(main); };
  };
  $('#hNew').onclick = () => editor({});
  $$('[data-ed]', main).forEach((b) => (b.onclick = () => editor(data.find((x) => x.id === b.dataset.ed))));
}

/* ================= templates and saved replies ================= */
const KINDS = [['reply', 'Saved replies'], ['email', 'Emails'], ['text', 'Texts'], ['document', 'Documents']];
let tplKind = 'reply';
async function viewTemplates(main) {
  const [{ data, error }, depts] = await Promise.all([sb.from('templates').select('*').order('name'), loadDepts()]);
  if (error) return noDb(main, 'Templates');
  const pub = can('templates', 3), save = can('templates', 2);
  const list = (data || []).filter((t) => t.kind === tplKind);
  const groups = [['starter', 'Starter set'], ['company', 'Everyone'], ['department', 'Departments'], ['personal', 'Just mine']];
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Templates</h1>${save ? '<button class="btn small" id="tNew">New</button>' : ''}</div>
    <div class="chips">${KINDS.map(([k, n]) => `<button type="button" class="chip ${k === tplKind ? 'on' : ''}" data-kind="${k}">${n}</button>`).join('')}</div>
    <p class="empty">${tplKind === 'reply' ? 'In a chat, type / and the short name (like /hi), or press Replies, to drop one in. Fill-ins like {contact.first_name} fill themselves.' : 'Use these in automations and, soon, campaigns and documents.'}</p>
    <div id="tEd"></div>
    ${groups.map(([g, n]) => { const rows = list.filter((t) => t.scope === g); return rows.length ? `<h2>${n}</h2><div class="list">${rows.map((t) => `<button class="item" data-t="${t.id}"><b>${esc(t.name)}</b>${t.shortcut ? ` <span class="badge">/${esc(t.shortcut)}</span>` : ''}${g === 'department' ? ` <span class="badge">${esc(depts?.find((d) => d.id === t.department_id)?.name || '')}</span>` : ''}<small>${esc((t.subject ? t.subject + ' · ' : '') + t.body.slice(0, 120))}</small></button>`).join('')}</div>` : ''; }).join('') || '<p class="empty">None yet.</p>'}`;
  $$('[data-kind]', main).forEach((b) => (b.onclick = () => { tplKind = b.dataset.kind; viewTemplates(main); }));
  const editor = (t) => {
    const mine = !t.id || t.owner_id === uid() || (t.scope !== 'personal' && t.scope !== 'starter' && pub);
    const starter = t.scope === 'starter';
    $('#tEd').innerHTML = `<div class="card panel"><h2>${starter ? 'Starter template' : t.id ? 'Edit' : 'New'}</h2>
      <div class="row"><div><label class="label" for="tName">Name</label><input type="text" id="tName" value="${esc(t.name || '')}" ${mine && !starter ? '' : 'disabled'}></div>
        <div><label class="label" for="tShort">Short name for /</label><input type="text" id="tShort" value="${esc(t.shortcut || '')}" placeholder="hours" ${mine && !starter ? '' : 'disabled'}></div></div>
      ${tplKind === 'email' || t.kind === 'email' ? `<label class="label" for="tSubj">Subject</label><input type="text" id="tSubj" value="${esc(t.subject || '')}" ${mine && !starter ? '' : 'disabled'}>` : ''}
      <label class="label" for="tBody">Message</label><textarea id="tBody" rows="${(t.kind || tplKind) === 'reply' ? 4 : 10}" ${mine && !starter ? '' : 'disabled'}>${esc(t.body || '')}</textarea>
      ${mine && !starter ? dynButtons('tBody') : ''}
      ${mine && !starter ? `<label class="label">Who can use it</label>${sel('tScope', scopeOpts(pub, depts || []), t.id ? scopeVal(t) : 'personal')}` : ''}
      <div class="actions">${mine && !starter ? '<button class="btn small" id="tSave">Save</button>' : ''}${save && (starter || !mine) ? '<button class="btn small" id="tCopy">Copy to mine</button>' : ''}
        ${t.id && mine && !starter ? '<button class="btn ghost small danger" id="tRm">Remove</button>' : ''}<button class="btn ghost small" id="tX">Close</button></div></div>`;
    bindDyn($('#tEd'));
    $('#tX').onclick = () => ($('#tEd').innerHTML = '');
    const payload = (base) => ({ kind: t.kind || tplKind, name: $('#tName').value, shortcut: $('#tShort').value, subject: $('#tSubj')?.value || null, body: $('#tBody').value, ...base });
    if ($('#tSave')) $('#tSave').onclick = async () => { const { error } = await sb.rpc('template_save', { p_id: t.id || null, p: payload(scopeSplit($('#tScope').value)) }); if (error) return C.fail(error); C.toast('Saved'); viewTemplates(main); };
    if ($('#tCopy')) $('#tCopy').onclick = async () => { const { error } = await sb.rpc('template_save', { p_id: null, p: { ...payload({ scope: 'personal' }), name: t.name + ' (mine)' } }); if (error) return C.fail(error); C.toast('Copied to yours'); viewTemplates(main); };
    if ($('#tRm')) $('#tRm').onclick = async () => { const { error } = await sb.rpc('template_archive', { p_id: t.id }); if (error) return C.fail(error); viewTemplates(main); };
    $('#tEd').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  if ($('#tNew')) $('#tNew').onclick = () => editor({ kind: tplKind });
  $$('[data-t]', main).forEach((b) => (b.onclick = () => editor(data.find((x) => x.id === b.dataset.t))));
}

/* ================= media ================= */
async function viewMedia(main) {
  const [{ data, error }, depts, { data: kids }] = await Promise.all([sb.rpc('media_library'), loadDepts(),
    S.acct?.is_agency ? sb.from('tenants').select('id,name').eq('agency_tenant_id', S.acct.id).order('name') : Promise.resolve({ data: [] })]);
  if (error) return noDb(main, 'Media');
  const pub = can('media', 3), up = can('media', 2);
  const divs = S.divisions || [];
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Media</h1>${up ? '<label class="btn small" for="mUp">Upload</label><input type="file" id="mUp" multiple hidden>' : ''}</div>
    <p class="empty">Every file gets a share link you can paste anywhere.${divs.length ? ' Files at the top of the account are yours; pick which companies under it can see each one.' : ''}</p>
    <input type="search" id="mQ" placeholder="Search files">
    <div class="mediagrid" id="mGrid"></div><div id="mEd"></div>`;
  const tile = (m) => `<div class="card mtile"><div class="mthumb">${/^image\//.test(m.mime || '') ? `<img src="${esc(m.url)}" alt="${esc(m.title || '')}" loading="lazy">` : `<span>${esc((m.title || 'file').split('.').pop().toUpperCase())}</span>`}</div>
    <b title="${esc(m.title || '')}">${esc(m.title || 'Untitled')}</b><small>${esc(m.from_parent ? 'From the parent account' : m.scope === 'personal' ? 'Just me' : m.scope === 'department' ? 'Department' : 'Everyone')}${m.divisions?.length ? ' · ' + C.plural(m.divisions.length, 'company', 'companies') : ''}</small>
    <div class="quick"><button class="btn ghost small" data-copy="${esc(m.url)}">Copy link</button>${!m.from_parent && (m.mine || pub) ? `<button class="btn ghost small" data-share="${m.id}">Share</button><button class="btn ghost small danger" data-rm="${m.id}">Remove</button>` : ''}</div></div>`;
  const draw = () => {
    const q = ($('#mQ').value || '').toLowerCase();
    $('#mGrid').innerHTML = (data || []).filter((m) => !q || (m.title || '').toLowerCase().includes(q)).map(tile).join('') || '<p class="empty">No files yet.</p>';
    $$('[data-copy]', main).forEach((b) => (b.onclick = () => copy(b.dataset.copy, 'Link copied')));
    $$('[data-rm]', main).forEach((b) => (b.onclick = async () => { if (!confirm('Remove this file? Its link stops showing in the library.')) return; const { error } = await sb.rpc('media_remove', { p_id: b.dataset.rm }); if (error) return C.fail(error); viewMedia(main); }));
    $$('[data-share]', main).forEach((b) => (b.onclick = () => shareBox(data.find((x) => x.id === b.dataset.share))));
  };
  const shareFields = (m) => `${sel('mScope', scopeOpts(pub, depts || []), m ? scopeVal(m) : pub ? 'company' : 'personal')}
    ${divs.length && pub ? `<label class="label">Companies under this account that can see it</label><div class="chips">${divs.map((d) => `<label class="chip"><input type="checkbox" data-div="${d.id}" ${m?.divisions?.includes(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>`).join('')}</div><small class="hint">None checked: only people at the top of the account see it.</small>` : ''}
    ${(kids || []).length && pub ? `<label class="label">Accounts under you that can see it</label><div class="chips">${kids.map((k) => `<label class="chip"><input type="checkbox" data-kid="${k.id}" ${m?.share_tenant_ids?.includes(k.id) ? 'checked' : ''}> ${esc(k.name)}</label>`).join('')}</div>` : ''}`;
  const readShare = (box) => ({ ...scopeSplit($('#mScope', box).value), divisions: $$('[data-div]', box).filter((c) => c.checked).map((c) => c.dataset.div), share_tenant_ids: $$('[data-kid]', box).filter((c) => c.checked).map((c) => c.dataset.kid) });
  const shareBox = (m) => {
    $('#mEd').innerHTML = `<div class="card panel"><h2>Share ${esc(m.title || 'file')}</h2><label class="label">Who can see it in the library</label>${shareFields(m)}
      <small class="hint">The share link itself works for anyone you send it to.</small>
      <div class="actions"><button class="btn small" id="mSave">Save</button><button class="btn ghost small" id="mX">Cancel</button></div></div>`;
    $('#mX').onclick = () => ($('#mEd').innerHTML = '');
    $('#mSave').onclick = async () => { const { error } = await sb.rpc('media_share', { p_id: m.id, p: readShare($('#mEd')) }); if (error) return C.fail(error); C.toast('Saved'); viewMedia(main); };
    $('#mEd').scrollIntoView({ behavior: 'smooth' });
  };
  $('#mQ').oninput = draw; draw();
  if ($('#mUp')) $('#mUp').onchange = async (e) => {
    const files = [...e.target.files]; if (!files.length) return;
    $('#mEd').innerHTML = `<div class="card panel"><h2>Upload ${C.plural(files.length, 'file', 'files')}</h2><label class="label">Who can see ${files.length > 1 ? 'them' : 'it'}</label>${shareFields(null)}
      <label class="label" for="mFolder">Folder (optional)</label><input type="text" id="mFolder" placeholder="Logos">
      <div class="actions"><button class="btn small" id="mGo">Upload</button><button class="btn ghost small" id="mX">Cancel</button></div></div>`;
    $('#mX').onclick = () => ($('#mEd').innerHTML = '');
    $('#mGo').onclick = async () => {
      const share = readShare($('#mEd')); $('#mGo').disabled = true;
      for (const f of files) {
        const path = `${S.acct.id}/library/${Date.now()}-${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const upr = await sb.storage.from('media').upload(path, f, { contentType: f.type || 'application/octet-stream', upsert: false });
        if (upr.error) { C.fail(upr.error); continue; }
        const url = sb.storage.from('media').getPublicUrl(path).data.publicUrl;
        const kind = /^image\//.test(f.type) ? 'photo' : /^video\//.test(f.type) ? 'video' : 'file';
        const { error } = await sb.rpc('media_add', { p: { path, url, kind, title: f.name, mime: f.type, bytes: f.size, folder: $('#mFolder').value, ...share } });
        if (error) C.fail(error);
      }
      C.toast('Uploaded'); viewMedia(main);
    };
  };
}

/* ================= brand kit ================= */
async function viewBrandKit(main) {
  const { data, error } = await sb.from('brand_kits').select('*').maybeSingle();
  if (error) return noDb(main, 'Brand kit');
  const k = { logos: {}, colors: [], fonts: [], rules: [], guide_url: '', ...(data || {}) };
  const edit = C.isAdmin() || can('settings', 2) || can('media', 3);
  const upload = async (file, folder) => {
    const path = `${S.acct.id}/brand/${folder}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const r = await sb.storage.from('media').upload(path, file, { contentType: file.type, upsert: false });
    if (r.error) { C.fail(r.error); return null; }
    return sb.storage.from('media').getPublicUrl(path).data.publicUrl;
  };
  const SLOTS = [['wide', 'Wide logo', 'Documents and emails'], ['square', 'Square logo', 'App icon and avatars'], ['circle', 'Circle logo', 'Profile pictures'], ['favicon', 'Favicon', 'Browser tab']];
  const render = () => {
    main.innerHTML = `<h1>Brand kit</h1><p class="empty">One place for how the brand looks. Documents, emails and pages use these.</p>
      <div class="card"><h2>Logos</h2><div class="logogrid">${SLOTS.map(([s, n, w]) => `<div class="logoslot ${k.logos.default === s ? 'def' : ''}"><div class="mthumb ${s === 'circle' ? 'round' : ''}">${k.logos[s] ? `<img src="${esc(k.logos[s])}" alt="${esc(n)}">` : '<span>None</span>'}</div>
        <b>${n}</b><small>${w}</small>${edit ? `<label class="btn ghost small" for="lg_${s}">Upload</label><input type="file" id="lg_${s}" accept="image/*" hidden data-slot="${s}">${k.logos[s] ? `<button type="button" class="btn ghost small" data-def="${s}">${k.logos.default === s ? 'Default ✓' : 'Make default'}</button>` : ''}` : ''}</div>`).join('')}</div>
        <small class="hint">Each spot uses its own shape, then the default logo, then the company name. The default is the one you pick, or the first one uploaded.</small></div>
      <div class="card"><h2>Colors</h2><div id="bkColors">${k.colors.map((c, i) => `<div class="row colorrow"><div><input type="color" data-nobrand data-ci="${i}" value="${esc(c.hex || '#000000')}" ${edit ? '' : 'disabled'}></div><div><input type="text" data-cn="${i}" value="${esc(c.name || '')}" placeholder="Primary" ${edit ? '' : 'disabled'}></div>${edit ? `<div><button class="btn ghost small" data-crm="${i}">Remove</button></div>` : ''}</div>`).join('')}</div>
        ${edit ? '<button class="btn ghost small" id="bkAddC">Add color</button>' : ''}</div>
      <div class="card"><h2>Fonts</h2>${k.fonts.map((f, i) => `<div class="row"><div>${sel('fr' + i, [['heading', 'Headings'], ['body', 'Body text'], ['accent', 'Accent']], f.role, edit ? `data-fr="${i}"` : 'disabled')}</div>
          <div><input type="text" data-ff="${i}" value="${esc(f.family || '')}" placeholder="Montserrat" ${edit ? '' : 'disabled'}></div><div><input type="url" data-fu="${i}" value="${esc(f.url || '')}" placeholder="Link (Google Fonts or file)" ${edit ? '' : 'disabled'}></div>
          ${edit ? `<div><button class="btn ghost small" data-frm="${i}">Remove</button></div>` : ''}</div><p class="fontsample" style="font-family:'${esc(f.family || 'inherit')}'">The quick brown fox jumps over the lazy dog</p>`).join('') || '<p class="empty">No fonts yet.</p>'}
        ${edit ? '<button class="btn ghost small" id="bkAddF">Add font</button>' : ''}</div>
      <div class="card"><h2>Do's and don'ts</h2><div class="rulegrid">${k.rules.map((r, i) => `<div class="card rule ${r.kind === 'dont' ? 'dont' : 'do'}"><b>${r.kind === 'dont' ? '✕ Don\'t' : '✓ Do'}</b>
          ${r.image ? `<img src="${esc(r.image)}" alt="">` : ''}<textarea data-rt="${i}" rows="2" ${edit ? '' : 'disabled'}>${esc(r.text || '')}</textarea>
          ${edit ? `<div class="quick"><label class="btn ghost small" for="ri${i}">Picture</label><input type="file" id="ri${i}" accept="image/*" hidden data-rimg="${i}"><button class="btn ghost small" data-rrm="${i}">Remove</button></div>` : ''}</div>`).join('')}</div>
        ${edit ? '<div class="quick"><button class="btn ghost small" id="bkDo">Add a do</button><button class="btn ghost small" id="bkDont">Add a don\'t</button></div>' : ''}</div>
      <div class="card"><h2>Full brand guide</h2>${k.guide_url ? `<a href="${esc(k.guide_url)}" target="_blank" rel="noopener">Open the brand guide</a>` : '<p class="empty">Upload your brand guide (PDF or images). Reading it in automatically comes later.</p>'}
        ${edit ? '<label class="btn ghost small" for="bkGuide">Upload guide</label><input type="file" id="bkGuide" hidden>' : ''}</div>
      ${edit ? '<div class="actions"><button class="btn" id="bkSave">Save brand kit</button></div>' : ''}`;
    if (!edit) return;
    const read = () => {
      $$('[data-ci]', main).forEach((x) => (k.colors[x.dataset.ci].hex = x.value)); $$('[data-cn]', main).forEach((x) => (k.colors[x.dataset.cn].name = x.value));
      $$('[data-fr]', main).forEach((x) => (k.fonts[x.dataset.fr].role = x.value)); $$('[data-ff]', main).forEach((x) => (k.fonts[x.dataset.ff].family = x.value)); $$('[data-fu]', main).forEach((x) => (k.fonts[x.dataset.fu].url = x.value));
      $$('[data-rt]', main).forEach((x) => (k.rules[x.dataset.rt].text = x.value));
    };
    $$('[data-slot]', main).forEach((i) => (i.onchange = async () => { const f = i.files[0]; if (!f) return; read(); const u = await upload(f, i.dataset.slot); if (!u) return; k.logos[i.dataset.slot] = u; if (!k.logos.default) k.logos.default = i.dataset.slot; render(); }));
    $$('[data-def]', main).forEach((b) => (b.onclick = () => { read(); k.logos.default = b.dataset.def; render(); }));
    $('#bkAddC').onclick = () => { read(); k.colors.push({ name: '', hex: '#1A2A52' }); render(); };
    $$('[data-crm]', main).forEach((b) => (b.onclick = () => { read(); k.colors.splice(Number(b.dataset.crm), 1); render(); }));
    $('#bkAddF').onclick = () => { read(); k.fonts.push({ role: k.fonts.length ? 'body' : 'heading', family: '', url: '' }); render(); };
    $$('[data-frm]', main).forEach((b) => (b.onclick = () => { read(); k.fonts.splice(Number(b.dataset.frm), 1); render(); }));
    $('#bkDo').onclick = () => { read(); k.rules.push({ kind: 'do', text: '' }); render(); };
    $('#bkDont').onclick = () => { read(); k.rules.push({ kind: 'dont', text: '' }); render(); };
    $$('[data-rrm]', main).forEach((b) => (b.onclick = () => { read(); k.rules.splice(Number(b.dataset.rrm), 1); render(); }));
    $$('[data-rimg]', main).forEach((i) => (i.onchange = async () => { const f = i.files[0]; if (!f) return; read(); const u = await upload(f, 'rule'); if (u) { k.rules[i.dataset.rimg].image = u; render(); } }));
    $('#bkGuide').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; read(); const u = await upload(f, 'guide'); if (u) { k.guide_url = u; render(); } };
    $('#bkSave').onclick = async () => { read(); const { error } = await sb.rpc('brand_kit_save', { p: { logos: k.logos, colors: k.colors, fonts: k.fonts, rules: k.rules, guide_url: k.guide_url } }); if (error) return C.fail(error); window.dispatchEvent(new Event('brandkit-saved')); C.toast('Brand kit saved'); };
  };
  render();
}

/* ================= reports ================= */
const SRC_NAMES = { contacts: 'Contacts', organizations: 'Organizations', deals: 'Deals', chats: 'Chats', todos: 'To-dos', jobs: 'Jobs', activity: 'Timeline activity', invoices: 'Invoices', proposals: 'Accepted proposals', bids: 'Bids' };
const word = (s) => String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
async function viewReports(main) {
  const [{ data: opts, error }, { data: saved }] = await Promise.all([sb.rpc('report_options'), sb.from('reports').select('*').order('name')]);
  if (error || !opts) return noDb(main, 'Reports');
  const spec = { source: 'contacts', group: 'month', measure: 'count', range: '90d', mine: false };
  let current = null;
  const srcs = opts.sources;
  const render = () => {
    const so = srcs[spec.source] || srcs.contacts;
    if (!so.groups.includes(spec.group)) spec.group = so.groups[0];
    if (!so.measures.includes(spec.measure)) spec.measure = so.measures[0];
    main.innerHTML = `<h1>Reports</h1>
      ${(saved || []).length ? `<div class="chips">${saved.map((r) => `<button type="button" class="chip ${current?.id === r.id ? 'on' : ''}" data-rep="${r.id}">${esc(r.name)}${r.shared ? ' 👥' : ''}</button>`).join('')}</div>` : ''}
      <div class="card"><div class="row">
        <div><label class="label">Report on</label>${sel('rSrc', Object.keys(srcs).map((k) => [k, SRC_NAMES[k] || word(k)]), spec.source)}</div>
        <div><label class="label">Group by</label>${sel('rGrp', so.groups.map((g) => [g, word(g)]), spec.group)}</div>
        <div><label class="label">Show</label>${sel('rMea', so.measures.map((m) => [m, word(m)]), spec.measure)}</div>
        <div><label class="label">Dates</label>${sel('rRange', [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['12m', 'Last 12 months'], ['ytd', 'This year'], ['all', 'All time'], ['custom', 'Custom']], spec.range)}</div></div>
        ${spec.range === 'custom' ? `<div class="row"><div><label class="label" for="rFrom">From</label><input type="date" id="rFrom" value="${esc(spec.from || '')}"></div><div><label class="label" for="rTo">To</label><input type="date" id="rTo" value="${esc(spec.to || '')}"></div></div>` : ''}
        <label class="featrow"><input type="checkbox" id="rMine" ${spec.mine ? 'checked' : ''}> Just mine</label>
        <div class="actions"><button class="btn small" id="rRun">Run</button><button class="btn ghost small" id="rSave">${current && current.owner_id === uid() ? 'Save changes' : 'Save report'}</button>
          ${current && current.owner_id === uid() ? '<button class="btn ghost small danger" id="rDel">Remove</button>' : ''}</div></div>
      <div id="rOut"></div>`;
    const read = () => { spec.source = $('#rSrc').value; spec.group = $('#rGrp').value; spec.measure = $('#rMea').value; spec.range = $('#rRange').value; spec.mine = $('#rMine').checked; spec.from = $('#rFrom')?.value || null; spec.to = $('#rTo')?.value || null; };
    ['#rSrc', '#rRange'].forEach((s) => ($(s).onchange = () => { read(); render(); }));
    $('#rRun').onclick = () => { read(); run(); };
    $$('[data-rep]', main).forEach((b) => (b.onclick = () => { current = saved.find((r) => r.id === b.dataset.rep); Object.assign(spec, current.spec); render(); run(); }));
    $('#rSave').onclick = async () => {
      read();
      const name = prompt('Name this report', current?.name || ''); if (!name) return;
      const share = (C.isAdmin() || can('reports', 3)) && confirm('Share it with the team? OK shares it, Cancel keeps it to yourself.');
      const row = { name, spec: { ...spec }, shared: share };
      const { error } = current && current.owner_id === uid() ? await sb.from('reports').update({ ...row, updated_at: new Date().toISOString() }).eq('id', current.id) : await sb.from('reports').insert(row);
      if (error) return C.fail(error); C.toast('Saved'); viewReports(main);
    };
    if ($('#rDel')) $('#rDel').onclick = async () => { const { error } = await sb.from('reports').update({ archived_at: new Date().toISOString() }).eq('id', current.id); if (error) return C.fail(error); viewReports(main); };
  };
  const run = async () => {
    const out = $('#rOut'); out.innerHTML = '<p class="empty">Running...</p>';
    const { data, error: e } = await sb.rpc('report_run', { p: spec });
    if (e) { out.innerHTML = ''; return C.fail(e); }
    const rows = data?.rows || []; const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
    const total = rows.reduce((a, r) => a + (Number(r.value) || 0), 0);
    const isMoney = /value|revenue|billed|balance|due_at|monthly|submitted|^average$/.test(spec.measure);
    const isRate = /rate$/.test(spec.measure);
    const fmt = (v) => (isMoney ? C.money(v) : isRate ? Number(v).toLocaleString() + '%' : Number(v).toLocaleString());
    out.innerHTML = `<div class="card"><h2>${esc(word(spec.measure))} of ${esc((SRC_NAMES[spec.source] || spec.source).toLowerCase())} by ${esc(word(spec.group).toLowerCase())}</h2>
      ${rows.length ? `<div class="bars">${rows.map((r) => `<div class="barrow"><span class="barlab" title="${esc(r.label)}">${esc(r.label)}</span><span class="bar"><span style="width:${Math.max(2, Math.round((Number(r.value) / max) * 100))}%"></span></span><span class="barval">${esc(fmt(r.value))}</span></div>`).join('')}</div>
        ${/avg|average|rate$/.test(spec.measure) ? '' : `<p><b>Total: ${esc(fmt(total))}</b></p>`}
        <button class="btn ghost small" id="rCsv">Download CSV</button>` : '<p class="empty">Nothing in that range.</p>'}</div>`;
    if ($('#rCsv')) $('#rCsv').onclick = () => {
      const csv = ['"' + word(spec.group) + '","' + word(spec.measure) + '"', ...rows.map((r) => `"${String(r.label).replace(/"/g, '""')}",${r.value}`)].join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'report.csv'; a.click();
    };
  };
  render(); run();
}

/* ================= departments and customer facing ================= */
async function viewDepartments(main) {
  const [depts, { data: cfRows }] = await Promise.all([loadDepts(), sb.from('app_users').select('id,customer_facing,role_id')]);
  if (!depts) return noDb(main, 'Departments');
  // members from another account keep what this account set for them (their home row says nothing about this account)
  (cfRows || []).forEach((r) => { const u = S.users.find((x) => x.id === r.id); if (u && !u.member) { u.customer_facing = r.customer_facing; u.role_id = r.role_id; } });
  const edit = C.isAdmin() || can('team', 4);
  const team = C.staff();
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Departments</h1>${edit ? '<button class="btn small" id="dNew">New department</button>' : ''}</div>
    <p class="empty">Teams inside this account, like Sales or Support. Templates, Shortcuts, media and chat widgets can be shared with a department. Separate businesses you own are their own companies or accounts, not departments.</p>
    <div id="dEd"></div>
    <div class="list">${depts.map((d) => `<div class="card"><div class="toolbar"><b style="flex:1">${esc(d.name)}</b>${edit ? `<button class="btn ghost small" data-ed="${d.id}">Edit</button>` : ''}</div>
      <small>${d.manager_id ? 'Manager: ' + esc(C.userName(d.manager_id)) + ' · ' : ''}${C.plural(d.members.length, 'person', 'people')}</small>
      <div class="chips">${d.members.map((m) => `<span class="chip small">${esc(C.userName(m))}</span>`).join('')}</div></div>`).join('') || '<p class="empty">No departments yet.</p>'}</div>
    <div class="card"><h2>Customer facing</h2><p class="hint">Customer facing people can be put on chat widgets and handed chats. A role can turn this on for everyone in it; this switch is for each person.</p>
      ${team.map((u) => `<label class="featrow"><input type="checkbox" data-cf="${u.id}" ${u.customer_facing ? 'checked' : ''} ${edit ? '' : 'disabled'}> ${esc(u.full_name || u.email)}${u.customer_facing == null && u.role_id ? ' <small class="hint">(from their role)</small>' : ''}</label>`).join('')}</div>`;
  $$('[data-cf]', main).forEach((c) => (c.onchange = async () => { const { error } = await sb.rpc('user_customer_facing_set', { p_user: c.dataset.cf, p_on: c.checked }); if (error) { c.checked = !c.checked; return C.fail(error); } const u = S.users.find((x) => x.id === c.dataset.cf); if (u) u.customer_facing = c.checked; C.toast('Saved'); }));
  const editor = (d) => {
    $('#dEd').innerHTML = `<div class="card panel"><h2>${d.id ? 'Edit' : 'New'} department</h2>
      <label class="label" for="dName">Name</label><input type="text" id="dName" value="${esc(d.name || '')}" placeholder="Support">
      <label class="label">Manager</label>${sel('dMgr', [['', 'Nobody'], ...people()], d.manager_id)}
      <label class="label">Who's in it</label><div class="chips">${team.map((u) => `<label class="chip"><input type="checkbox" data-mem="${u.id}" ${(d.members || []).includes(u.id) ? 'checked' : ''}> ${esc(u.full_name || u.email)}</label>`).join('')}</div>
      <div class="actions"><button class="btn small" id="dSave">Save</button>${d.id ? '<button class="btn ghost small danger" id="dRm">Remove</button>' : ''}<button class="btn ghost small" id="dX">Cancel</button></div></div>`;
    $('#dX').onclick = () => ($('#dEd').innerHTML = '');
    $('#dSave').onclick = async () => {
      const row = { name: $('#dName').value.trim(), manager_id: $('#dMgr').value || null };
      if (!row.name) return C.toast('Name it');
      let id = d.id;
      if (id) { const { error } = await sb.from('departments').update(row).eq('id', id); if (error) return C.fail(error); }
      else { const { data, error } = await sb.from('departments').insert(row).select('id').single(); if (error) return C.fail(error); id = data.id; }
      const want = $$('[data-mem]', $('#dEd')).filter((c) => c.checked).map((c) => c.dataset.mem), had = d.members || [];
      const add = want.filter((x) => !had.includes(x)), rm = had.filter((x) => !want.includes(x));
      if (add.length) { const { error } = await sb.from('department_members').insert(add.map((user_id) => ({ department_id: id, user_id }))); if (error) return C.fail(error); }
      if (rm.length) { const { error } = await sb.from('department_members').delete().eq('department_id', id).in('user_id', rm); if (error) return C.fail(error); }
      C.toast('Saved'); viewDepartments(main);
    };
    if ($('#dRm')) $('#dRm').onclick = async () => { const { error } = await sb.from('departments').update({ archived_at: new Date().toISOString() }).eq('id', d.id); if (error) return C.fail(error); viewDepartments(main); };
  };
  if ($('#dNew')) $('#dNew').onclick = () => editor({});
  $$('[data-ed]', main).forEach((b) => (b.onclick = () => editor(depts.find((x) => x.id === b.dataset.ed))));
}

/* ================= chat widgets and assignment ================= */
async function viewChatSetup(main) {
  const [{ data: ws, error }, depts, { data: cf }] = await Promise.all([sb.from('chat_widgets').select('*').is('archived_at', null).order('name'), loadDepts(), sb.rpc('customer_facing_people')]);
  if (error || !depts) return noDb(main, 'Chat assignment');
  const pool = cf || [];
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Chat assignment</h1><button class="btn small" id="wNew">New chat widget</button></div>
    <p class="empty">Each chat widget picks who gets its chats: one person or round robin. Drag customer facing people or whole departments onto it. If nobody picks up in time, the department (or the people's managers) gets pinged and the first to reply takes it. Returning visitors go back to the same person when they're online.</p>
    <div id="wEd"></div>
    <div class="list">${(ws || []).map((w) => `<button class="item" data-w="${w.id}"><b>${esc(w.name)}</b>${w.is_default ? ' <span class="badge ok">Default</span>' : ''}
      <small>${w.offer === 'message' ? 'Messages only · ' : w.offer === 'live' ? 'Live only · ' : ''}${w.mode === 'single' ? 'One person' : w.mode === 'none' ? 'Nobody assigned' : 'Round robin, ' + (w.style === 'first_available' ? 'first available' : 'even')} · ${C.plural(w.user_ids.length, 'person', 'people')}, ${C.plural(w.department_ids.length, 'department', 'departments')} · wait ${Math.round(w.wait_seconds / 60 * 10) / 10} min</small></button>`).join('') || '<p class="empty">No widgets yet. Until you add one, new chats go to everyone like before.</p>'}</div>`;
  const editor = (w) => {
    const st = { user_ids: [...(w.user_ids || [])], department_ids: [...(w.department_ids || [])] };
    const draw = () => {
      $('#wEd').innerHTML = `<div class="card panel"><h2>${w.id ? esc(w.name) : 'New chat widget'}</h2>
        <div class="row"><div><label class="label" for="wName">Name</label><input type="text" id="wName" value="${esc(w.name || '')}" placeholder="Website support"></div>
          <div><label class="label" for="wKey">Short name</label><input type="text" id="wKey" value="${esc(w.key || '')}" placeholder="support" ${w.id ? 'disabled' : ''}></div></div>
        <div class="row"><div><label class="label">Who gets chats</label>${sel('wMode', [['round_robin', 'Round robin'], ['single', 'One person'], ['none', 'Nobody, everyone sees them']], w.mode || 'round_robin')}</div>
          <div><label class="label">Round robin style</label>${sel('wStyle', [['even', 'Even distribution'], ['first_available', 'First available']], w.style || 'even')}</div>
          <div><label class="label" for="wWait">Wait before pinging everyone (minutes)</label><input type="number" id="wWait" min="0.25" step="0.25" value="${(w.wait_seconds || 120) / 60}"></div></div>
        <div class="dragwrap"><div class="dragcol" id="wPool"><b>Customer facing</b><small class="hint">Drag onto the widget, or tap</small>
            ${pool.filter((p) => !st.user_ids.includes(p.id)).map((p) => `<div class="dragchip" draggable="true" data-u="${p.id}">${p.online ? '🟢 ' : ''}${esc(p.name)}</div>`).join('')}
            ${depts.filter((d) => !st.department_ids.includes(d.id)).map((d) => `<div class="dragchip dept" draggable="true" data-d="${d.id}">👥 ${esc(d.name)}</div>`).join('')}</div>
          <div class="dragcol on" id="wOn"><b>On this widget</b><small class="hint">Drag back off, or tap</small>
            ${st.user_ids.map((x) => `<div class="dragchip" draggable="true" data-u="${x}">${esc(pool.find((p) => p.id === x)?.name || C.userName(x) || 'Someone')}</div>`).join('')}
            ${st.department_ids.map((x) => `<div class="dragchip dept" draggable="true" data-d="${x}">👥 ${esc(depts.find((d) => d.id === x)?.name || 'Department')}</div>`).join('')}</div></div>
        <div class="row"><div><label class="label">What visitors can pick</label>${sel('wOffer', [['both', 'Live chat or leave a message'], ['live', 'Live chat only'], ['message', 'Leave a message only']], w.offer || 'both')}</div></div>
        <small class="hint">Messages land in the Inbox like chats and the team gets an email, but nobody gets pinged to pick them up. Live chat started while nobody's online is saved as a message.</small>
        <label class="label" for="wThanks">After someone leaves a message</label><textarea id="wThanks" rows="2">${esc(w.message_thanks || "Thanks! We got your message and we'll get back to you by email soon.")}</textarea>
        <label class="label" for="wWaitT">What the visitor sees while we ping everyone</label><textarea id="wWaitT" rows="2">${esc(w.waiting_text || "Sorry for the wait, we're having trouble reaching someone. Would you like to leave a message? We'll get back to you by email.")}</textarea>
        <label class="label" for="wOff">When nobody's online</label><textarea id="wOff" rows="2">${esc(w.offline_text || "Sorry, nobody's here right now. Please leave a message and we'll get back to you by email.")}</textarea>
        <label class="featrow"><input type="checkbox" id="wDef" ${w.is_default ? 'checked' : ''}> Default (chats from widgets without a short name use this one)</label>
        ${w.key ? `<label class="label">Put this on the site</label><code class="snippet">&lt;script src="${esc(APP())}/chat/widget.js" data-account="${esc(S.acct?.slug || '')}" data-widget="${esc(w.key)}" async&gt;&lt;/script&gt;</code>
          <div class="actions"><button type="button" class="btn ghost small" id="wCopy">Copy code</button><small class="hint">Paste it into the site's footer or custom code box. Works on any website, built here or not.</small></div>` : ''}
        <div class="actions"><button class="btn small" id="wSave">Save</button>${w.id ? '<button class="btn ghost small danger" id="wRm">Remove</button>' : ''}<button class="btn ghost small" id="wX">Cancel</button></div></div>`;
      const move = (el) => { const u = el.dataset.u, d = el.dataset.d; const keep = readForm();
        if (u) st.user_ids = st.user_ids.includes(u) ? st.user_ids.filter((x) => x !== u) : [...st.user_ids, u];
        if (d) st.department_ids = st.department_ids.includes(d) ? st.department_ids.filter((x) => x !== d) : [...st.department_ids, d];
        Object.assign(w, keep); draw(); };
      $$('.dragchip', $('#wEd')).forEach((c) => { c.onclick = () => move(c); c.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.dataset.u ? 'u:' + c.dataset.u : 'd:' + c.dataset.d); });
      ['#wPool', '#wOn'].forEach((s) => { const col = $(s); col.ondragover = (e) => e.preventDefault(); col.ondrop = (e) => { e.preventDefault(); const [t, x] = e.dataTransfer.getData('text/plain').split(':'); const onNow = t === 'u' ? st.user_ids.includes(x) : st.department_ids.includes(x); if ((s === '#wOn') !== onNow) move({ dataset: t === 'u' ? { u: x } : { d: x } }); }; });
      $('#wX').onclick = () => ($('#wEd').innerHTML = '');
      if ($('#wCopy')) $('#wCopy').onclick = () => { const code = `<script src="${APP()}/chat/widget.js" data-account="${S.acct?.slug || ''}" data-widget="${w.key}" async></script>`;
        navigator.clipboard.writeText(code).then(() => C.toast('Chat code copied. Paste it into the site\'s footer code.'), () => prompt('Copy this into the site\'s footer code:', code)); };
      $('#wSave').onclick = async () => {
        const row = { ...readForm(), user_ids: st.user_ids, department_ids: st.department_ids };
        if (!row.name || !/^[a-z0-9_-]{1,40}$/.test(row.key || '')) return C.toast('Add a name and a short name (lowercase letters, numbers, dashes)');
        if (row.is_default) await sb.from('chat_widgets').update({ is_default: false }).neq('id', w.id || '00000000-0000-0000-0000-000000000000').eq('is_default', true);
        const { error: e } = w.id ? await sb.from('chat_widgets').update(row).eq('id', w.id) : await sb.from('chat_widgets').insert(row);
        if (e) return C.fail(e); C.toast('Saved'); viewChatSetup(main);
      };
      if ($('#wRm')) $('#wRm').onclick = async () => { const { error: e } = await sb.from('chat_widgets').update({ archived_at: new Date().toISOString(), is_default: false }).eq('id', w.id); if (e) return C.fail(e); viewChatSetup(main); };
    };
    const readForm = () => ({ name: $('#wName').value.trim(), key: w.id ? w.key : $('#wKey').value.trim().toLowerCase(), mode: $('#wMode').value, style: $('#wStyle').value,
      wait_seconds: Math.max(15, Math.round(Number($('#wWait').value || 2) * 60)), waiting_text: $('#wWaitT').value.trim(), offline_text: $('#wOff').value.trim(), is_default: $('#wDef').checked,
      offer: $('#wOffer').value, message_thanks: $('#wThanks').value.trim() || "Thanks! We got your message and we'll get back to you by email soon." });
    draw(); $('#wEd').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $('#wNew').onclick = () => editor({ is_default: !(ws || []).length });
  $$('[data-w]', main).forEach((b) => (b.onclick = () => editor(ws.find((x) => x.id === b.dataset.w))));
}

// Inbox: the assignment line, Take and Hand off, and saved replies (Replies button and /shortcut)
export async function chatTools(box, t) {
  if (!t || t.kind === 'team' || t.kind === 'dev_request') return;
  const compose = $('.ibcompose', box); if (!compose) return;
  const ta = $('#ibText', box);
  const bar = document.createElement('div'); bar.className = 'ibassign';
  const who = t.assigned_to ? C.userName(t.assigned_to) : '';
  bar.innerHTML = `<small>${t.assigned_to ? `Assigned to <b>${esc(who || 'someone')}</b>` : 'Not assigned'}${t.blast_at && !t.picked_up_at ? ' · <span class="warn">waiting, everyone pinged</span>' : ''}</small>
    ${t.assigned_to !== uid() ? '<button type="button" class="linkish" id="ibTake">Take it</button>' : ''}<button type="button" class="linkish" id="ibHand">Hand off</button><button type="button" class="linkish" id="ibReplies">Replies</button>`;
  compose.before(bar);
  let tpls = null;
  const getTpls = async () => { if (tpls) return tpls; const { data } = await sb.from('templates').select('id,name,shortcut,body').eq('kind', 'reply').order('name'); return (tpls = data || []); };
  const ctx = { contact: { first_name: (t.visitor_name || '').split(' ')[0], full_name: t.visitor_name || '', email: t.visitor_email || '' }, company: { name: t.companies?.name || '' } };
  const insert = (body) => { const v = fill(body, ctx); const base = ta.value.replace(/(^|\s)\/[a-z0-9_-]*$/, '$1'); ta.value = base ? (/\s$/.test(base) ? base : base + ' ') + v : v; ta.focus(); };
  if ($('#ibTake', bar)) $('#ibTake', bar).onclick = async () => { const { error } = await sb.rpc('chat_take', { p_thread: t.id }); if (error) return C.fail(error); C.toast('It\'s yours'); t.assigned_to = uid(); bar.remove(); chatTools(box, t); };
  $('#ibHand', bar).onclick = async () => {
    const { data: ppl, error } = await sb.rpc('customer_facing_people'); if (error) return C.fail(error);
    const me = S.users.find((u) => u.id === uid());
    const pop = document.createElement('div'); pop.className = 'card panel ibpop';
    pop.innerHTML = `<b>Hand this chat to</b>${sel('hoTo', [['', me?.manager_id ? 'My manager (' + C.userName(me.manager_id) + ')' : 'Pick someone'], ...(ppl || []).filter((p) => p.id !== uid()).map((p) => [p.id, (p.online ? '🟢 ' : '') + p.name])], '')}
      <div class="actions"><button class="btn small" id="hoGo">Hand off</button><button class="btn ghost small" id="hoX">Cancel</button></div>`;
    bar.after(pop);
    $('#hoX', pop).onclick = () => pop.remove();
    $('#hoGo', pop).onclick = async () => { const { data, error: e } = await sb.rpc('chat_handoff', { p_thread: t.id, p_to: $('#hoTo', pop).value || null }); if (e) return C.fail(e); C.toast('Handed to ' + (data?.name || 'them')); pop.remove(); t.assigned_to = data?.to; bar.remove(); chatTools(box, t); };
  };
  $('#ibReplies', bar).onclick = async () => {
    const list = await getTpls();
    const old = $('.ibpop', box); if (old) { old.remove(); return; }
    const pop = document.createElement('div'); pop.className = 'card panel ibpop';
    pop.innerHTML = `<input type="search" id="rpQ" placeholder="Find a reply"><div class="results" id="rpL"></div><small class="hint">Tip: type / and the short name in the box, like /hi, then Tab.</small>`;
    bar.after(pop);
    const draw = () => { const q = $('#rpQ', pop).value.toLowerCase(); $('#rpL', pop).innerHTML = list.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.shortcut || '').includes(q)).map((x) => `<button type="button" class="result" data-rp="${x.id}"><b>${esc(x.name)}</b>${x.shortcut ? ` <small>/${esc(x.shortcut)}</small>` : ''}<small>${esc(fill(x.body, ctx).slice(0, 90))}</small></button>`).join('') || '<p class="empty">No saved replies. Add them in Tools > Templates.</p>';
      $$('[data-rp]', pop).forEach((b) => (b.onclick = () => { insert(list.find((x) => x.id === b.dataset.rp).body); pop.remove(); })); };
    $('#rpQ', pop).oninput = draw; draw(); $('#rpQ', pop).focus();
  };
  // "/hi" then Tab (or space) expands
  ta.addEventListener('keydown', async (e) => {
    if (e.key !== 'Tab') return;
    const m = ta.value.match(/(?:^|\s)\/([a-z0-9_-]+)$/); if (!m) return;
    const hit = (await getTpls()).find((x) => x.shortcut === m[1]); if (!hit) return;
    e.preventDefault(); ta.value = ta.value.slice(0, ta.value.length - m[1].length - 1) + fill(hit.body, ctx);
  });
}

/* ================= contacts: Shortcuts, filters and bulk actions ================= */
let clState = { q: '', tag: '', source: '', field: '', fval: '', org: false, type: '' };
async function viewContactList(main) {
  const [{ data: sc }, { data: autos }, { data: cfs }] = await Promise.all([sb.from('shortcuts').select('*').eq('screen', 'contacts').order('sort'),
    sb.from('automations').select('id,name,trigger').eq('active', true).is('archived_at', null).order('name'), sb.from('custom_fields').select('entity,key,label').is('archived_at', null)]);
  const ent = clState.org ? 'companies' : 'people';
  const fields = (cfs || []).filter((f) => f.entity === ent);
  main.innerHTML = `<div class="toolbar"><button class="btn ghost small" id="clBack">← ${esc(FLD.L('person', true))}</button><h1 style="flex:1;margin:0 8px">Filter and bulk</h1></div>
    <div class="chips" id="clSc">${(sc || []).map((s) => `<button type="button" class="chip" data-sc="${s.id}">${esc(s.name)}${s.shared || s.department_id ? ' 👥' : ''}</button>`).join('')}<button type="button" class="chip ghostchip" id="clSave">+ Save as quick filter</button></div>
    <div class="card"><div class="row">
      <div><label class="label">Show</label>${sel('clEnt', [['people', FLD.L('person', true)], ['companies', FLD.L('organization', true)]], ent)}</div>
      <div><label class="label" for="clQ">Name or email has</label><input type="search" id="clQ" value="${esc(clState.q)}"></div>
      <div><label class="label" for="clType">Type</label>${sel('clType', [['', 'Any type'], ...(clState.org ? C.lk('org_type') : C.personTypes()).map((t) => [t, t])], clState.type)}</div>
      <div><label class="label" for="clTag">Tag</label><input type="text" id="clTag" value="${esc(clState.tag)}"></div>
      <div><label class="label" for="clSrc">Lead source has</label><input type="text" id="clSrc" value="${esc(clState.source)}"></div></div>
      ${fields.length ? `<div class="row"><div><label class="label">Custom field</label>${sel('clFld', [['', 'Any'], ...fields.map((f) => [f.key, f.label])], clState.field)}</div><div><label class="label" for="clFv">Equals</label><input type="text" id="clFv" value="${esc(clState.fval)}"></div></div>` : ''}
      <div class="actions"><button class="btn small" id="clGo">Show</button></div></div>
    <div class="bulkbar" id="clBulk" hidden><b id="clN">0 picked</b>
      <select id="clAct" aria-label="Bulk action"><option value="">Do this to them...</option><option value="tag">Add a tag</option><option value="untag">Remove a tag</option><option value="field">Set a field</option>
        ${clState.org ? '<option value="owner">Change owner</option>' : ''}<option value="task">Add a to-do for each</option>${(autos || []).length ? '<option value="auto">Start an automation</option>' : ''}<option value="delete">Request delete</option></select>
      <span id="clArgs"></span><button class="btn small" id="clRun">Go</button></div>
    <div class="list" id="clList"></div>`;
  $('#clBack').onclick = () => C.go('people');
  const read = () => { clState = { q: $('#clQ').value.trim(), tag: $('#clTag').value.trim(), source: $('#clSrc').value.trim(), field: $('#clFld')?.value || '', fval: $('#clFv')?.value || '', org: $('#clEnt').value === 'companies', type: $('#clType')?.value || '' }; };
  $('#clEnt').onchange = () => { read(); clState.type = ''; viewContactList(main); };
  let rows = [];
  const load = async () => {
    read();
    let q = clState.org ? sb.from('companies').select('id,name,city,state,tags,lead_source_channel,owner_id,org_types').is('archived_at', null).order('name').limit(500)
      : sb.from('people').select('*').is('archived_at', null).order('first_name').limit(500);
    if (clState.q) q = clState.org ? q.ilike('name', `%${clState.q}%`) : q.or(`first_name.ilike.%${clState.q}%,last_name.ilike.%${clState.q}%,personal_email.ilike.%${clState.q}%`);
    if (clState.tag) q = q.contains('tags', [clState.tag]);
    if (clState.type) q = q.contains(clState.org ? 'org_types' : 'person_types', [clState.type]);
    if (clState.source) q = q.ilike(clState.org ? 'lead_source_channel' : 'lead_source', `%${clState.source}%`);
    if (clState.field && clState.fval) q = q.eq(`custom->>${clState.field}`, clState.fval);
    const { data, error } = await C.divQ(q);
    if (error) { $('#clList').innerHTML = '<p class="empty">Filters need the October 30 database update.</p>'; return; }
    rows = data || [];
    $('#clList').innerHTML = rows.length ? `<label class="featrow"><input type="checkbox" id="clAll"> Pick all ${rows.length}${rows.length === 500 ? ' (first 500)' : ''}</label>` + rows.map((r) => `<div class="item pickrow"><input type="checkbox" data-pick="${r.id}" aria-label="Pick">
      <button type="button" class="linkish" data-open="${r.id}"><b>${esc(clState.org ? r.name : [r.first_name, r.last_name].filter(Boolean).join(' ') || r.personal_email || 'No name')}</b></button> <span class="meta inline">${C.typeBadges(clState.org ? r.org_types : r.person_types)}</span>
      <small>${esc(clState.org ? [r.city, r.state].filter(Boolean).join(', ') : r.personal_email || '')}${(r.tags || []).length ? ' · ' + esc(r.tags.join(', ')) : ''}</small></div>`).join('') : '<p class="empty">Nobody matches.</p>';
    const picked = () => $$('[data-pick]', main).filter((c) => c.checked).map((c) => c.dataset.pick);
    const sync = () => { const n = picked().length; $('#clBulk').hidden = !n; $('#clN').textContent = n + ' picked'; };
    $$('[data-pick]', main).forEach((c) => (c.onchange = sync));
    if ($('#clAll')) $('#clAll').onchange = (e) => { $$('[data-pick]', main).forEach((c) => (c.checked = e.target.checked)); sync(); };
    $$('[data-open]', main).forEach((b) => (b.onclick = () => C.go(clState.org ? 'org' : 'people', b.dataset.open)));
    $('#clRun').onclick = async () => {
      const ids = picked(), act = $('#clAct').value; if (!ids.length || !act) return;
      if (!can('contacts', 2)) return C.toast('Your role can\'t change contacts');
      const tbl = clState.org ? 'companies' : 'people';
      const v1 = $('#clA1')?.value?.trim() || '', v2 = $('#clA2')?.value || '';
      let n = 0;
      if (act === 'tag' || act === 'untag') {
        if (!v1) return C.toast('Type the tag');
        for (const r of rows.filter((x) => ids.includes(x.id))) {
          const tags = act === 'tag' ? [...new Set([...(r.tags || []), v1])] : (r.tags || []).filter((t) => t !== v1);
          const { error } = await sb.from(tbl).update({ tags }).eq('id', r.id); if (error) return C.fail(error); n++;
        }
      } else if (act === 'field') {
        if (!v1) return C.toast('Pick the field');
        const { data: cur } = await sb.from(tbl).select('id,custom').in('id', ids);
        for (const r of cur || []) { const { error } = await sb.from(tbl).update({ custom: { ...(r.custom || {}), [v1]: v2 } }).eq('id', r.id); if (error) return C.fail(error); n++; }
      } else if (act === 'owner') {
        const { error } = await sb.from('companies').update({ owner_id: v1 || null }).in('id', ids); if (error) return C.fail(error); n = ids.length;
      } else if (act === 'task') {
        if (!v1) return C.toast('Type the to-do');
        const { error } = await sb.from('tasks').insert(ids.map((id) => ({ title: v1, due_date: v2 || C.today(), assigned_to: uid(), [clState.org ? 'company_id' : 'person_id']: id }))); if (error) return C.fail(error); n = ids.length;
      } else if (act === 'auto') {
        const { data: c, error } = await sb.rpc('automation_start', { p_id: v1, p_people: clState.org ? [] : ids, p_companies: clState.org ? ids : [] }); if (error) return C.fail(error); n = c;
      } else if (act === 'delete') {
        const why = prompt(`Why delete these ${ids.length}? An admin approves each one.`); if (!why) return;
        for (const id of ids) { const { error } = await sb.rpc('request_delete', { p_entity: tbl, p_id: id, p_reason: why }); if (error) return C.fail(error); n++; }
      }
      C.toast(`Done for ${n}`); load();
    };
  };
  $('#clAct').onchange = () => {
    const a = $('#clAct').value;
    $('#clArgs').innerHTML = a === 'tag' || a === 'untag' ? '<input type="text" id="clA1" placeholder="Tag">'
      : a === 'field' ? `${sel('clA1', [['', 'Field'], ...fields.map((f) => [f.key, f.label])], '')}<input type="text" id="clA2" placeholder="Value">`
      : a === 'owner' ? sel('clA1', [['', 'Nobody'], ...people()], '')
      : a === 'task' ? `<input type="text" id="clA1" placeholder="To-do"><input type="date" id="clA2">`
      : a === 'auto' ? sel('clA1', (autos || []).map((x) => [x.id, x.name]), '') : '';
  };
  $('#clGo').onclick = load;
  $$('[data-sc]', main).forEach((b) => (b.onclick = () => { const s = sc.find((x) => x.id === b.dataset.sc); clState = { ...clState, ...(s.filters || {}) }; viewContactList(main).then(() => $('#clGo')?.click()); }));
  $('#clSave').onclick = async () => {
    read(); const name = prompt('Name this quick filter'); if (!name) return;
    const share = can('templates', 3) && confirm('Share it with the team? OK shares it, Cancel keeps it to yourself.');
    const { error } = await sb.from('shortcuts').insert({ screen: 'contacts', name, filters: clState, shared: share });
    if (error) return C.fail(error); C.toast('Quick filter saved'); viewContactList(main);
  };
  if (clState.q || clState.tag || clState.source || clState.fval || clState.type) load();
}

/* ================= contact timeline and lead source ================= */
const KIND_ICON = { call: '☎', created: '➕', form_submitted: '📝', chat_started: '💬', chat_handoff: '↪', link_clicked: '🔗', qr_scanned: '▦', webhook_in: '⇣', email_sent: '✉', email_failed: '⚠',
  field_changed: '✎', tag_added: '🏷', tag_removed: '🏷', job_completed: '⚒', task_done: '✓', note: '🗒', unsubscribed: '🚫', automation_error: '⚠',
  esign_sent: '✍', esign_signed: '✍', esign_completed: '✔', esign_declined: '✕', esign_voided: '✕',
  appointment_booked: '📅', appointment_rescheduled: '📅', appointment_cancelled: '📅', appointment_no_show: '📅', appointment_completed: '📅' };
// One feed for notes and activity. "By people" (the default) is what someone on the team did: notes, stage moves,
// contacts added or changed, to-dos done. "System" is what happened on its own: automations, forms, chats, clicks, emails sent by automations.
// Notes show just the note. Older notes from the activities table are folded in.
let tlShow = 'user';
const TL_FIRST = 3; // newest few show; the rest are behind "Show more"
const FIELD_NAMES = { pipeline_stage_id: 'Pipeline stage', owner_id: 'Owner', stage: 'Stage', follow_up_date: 'Follow up date', interest_level: 'Interest',
  next_step: 'Next step', lead_source_channel: 'How they came in', main_phone: 'Main phone', main_email: 'Email', personal_cell: 'Cell', personal_email: 'Email',
  first_name: 'First name', last_name: 'Last name', org_types: 'Type', person_types: 'Type', tags: 'Tags', divisions: 'Divisions', name: 'Name', specialty: 'Specialty',
  address: 'Address', city: 'City', state: 'State', zip: 'Zip', website: 'Website', last_contact_date: 'Last contact', preferred_contact_method: 'Prefers' };
const prettyField = (f) => FIELD_NAMES[f] || String(f || 'A field').replace(/_id$/, '').replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
function fieldTitle(e) {
  const d = e.data || {}, f = d.field;
  const val = (v) => v == null || v === '' ? '' : Array.isArray(v) ? v.join(', ') : f === 'pipeline_stage_id' ? C.stageLabel(v) || 'another stage' : f === 'owner_id' ? C.userName(v) || 'someone' : /_at$|_date$/.test(f) ? C.fmtDate(v) : String(v);
  const to = val(d.to);
  if (f === 'pipeline_stage_id') return to ? `Moved to ${to}` : 'Taken out of the pipeline';
  if (f === 'owner_id') return to ? `Owner set to ${to}` : 'Owner removed';
  return to ? `${prettyField(f)} changed to ${to}` : `${prettyField(f)} cleared`;
}
/* ---------- notify people on a note: @mentions in the text plus a Notify list (both end up in one list) ---------- */
const notifyPeople = () => (S.users || []).filter((u) => u.active && u.role !== 'vendor' && u.role !== 'member' && !u.hidden_in_team && u.id !== uid())
  .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
export function notifyPicker() {
  const ppl = notifyPeople();
  if (!ppl.length) return '';
  return `<details class="notifypick"><summary class="btn ghost small" aria-label="Pick people to notify">🔔 Notify <span class="npcount"></span></summary>
    <div class="notifymenu">${ppl.map((u) => `<label class="check"><input type="checkbox" data-np="${u.id}"> ${esc(u.full_name)}</label>`).join('')}
    <small class="hint">They get it in My Day and the way they chose (push, email or both).</small></div></details>`;
}
// wires @ autocomplete on a textarea and the Notify checkboxes inside box; ids(text) returns everyone to notify
export function wireNotify(box, ta, after = () => {}) {
  const ppl = notifyPeople();
  const list = $('#tlMention', box) || box.querySelector('.mentionlist');
  const count = () => { const n = $$('[data-np]:checked', box).length; const c = box.querySelector('.npcount'); if (c) c.textContent = n ? `(${n})` : ''; };
  $$('[data-np]', box).forEach((c) => (c.onchange = count));
  let hits = [], pick = 0, at = -1;
  const close = () => { if (list) list.hidden = true; hits = []; at = -1; };
  const show = () => {
    if (!list) return;
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(/(^|\s)@([\w.'-]{0,30})$/);
    if (!m) return close();
    at = upto.length - m[2].length - 1;
    const q = m[2].toLowerCase();
    hits = ppl.filter((u) => String(u.full_name).toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || String(u.full_name).toLowerCase().startsWith(q)).slice(0, 6);
    if (!hits.length) return close();
    pick = Math.min(pick, hits.length - 1);
    list.innerHTML = hits.map((u, i) => `<button type="button" role="option" class="${i === pick ? 'on' : ''}" data-mi="${i}">${esc(u.full_name)}</button>`).join('');
    list.hidden = false;
    $$('[data-mi]', list).forEach((b) => (b.onmousedown = (e) => { e.preventDefault(); choose(+b.dataset.mi); }));
  };
  const choose = (i) => {
    const u = hits[i]; if (!u || at < 0) return;
    const end = ta.selectionStart;
    ta.value = ta.value.slice(0, at) + '@' + u.full_name + ' ' + ta.value.slice(end);
    const pos = at + u.full_name.length + 2;
    ta.setSelectionRange(pos, pos); ta.focus();
    const c = box.querySelector(`[data-np="${u.id}"]`); if (c) { c.checked = true; count(); }
    close(); after();
  };
  ta.addEventListener('input', () => { pick = 0; show(); after(); });
  ta.addEventListener('blur', () => setTimeout(close, 150));
  ta.onkeydown = (k) => {
    if (!list || list.hidden || !hits.length) return true;
    if (k.key === 'ArrowDown' || k.key === 'ArrowUp') { k.preventDefault(); pick = (pick + (k.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length; show(); return false; }
    if (k.key === 'Enter' || k.key === 'Tab') { k.preventDefault(); choose(pick); return false; }
    if (k.key === 'Escape') { k.preventDefault(); close(); return false; }
    return true;
  };
  return {
    ids: (text) => {
      const set = new Set($$('[data-np]:checked', box).map((c) => c.dataset.np));
      const low = String(text || '').toLowerCase();
      ppl.forEach((u) => { if (u.full_name && low.includes('@' + String(u.full_name).toLowerCase())) set.add(u.id); });
      return [...set];
    },
  };
}

export async function timelineBox(box, { person = null, company = null, leadSource = null, canAdd = true, onNote = null } = {}) {
  if (!box) return;
  const [tl, acts] = await Promise.all([
    sb.rpc('timeline', { p_person: person, p_company: company, p_limit: 200 }),
    sb.from('activities').select('id,type,body,created_by,created_at').eq(company ? 'company_id' : 'person_id', company || person).order('created_at', { ascending: false }).limit(100),
  ]);
  const ev = (tl.error ? [] : tl.data || []).map((e) => ({ ...e, mine: !!e.by }));
  (acts.data || []).forEach((a) => ev.push({ id: 'a' + a.id, kind: a.type === 'note' ? 'note' : 'activity', title: a.type, data: { body: a.body }, at: a.created_at, by: a.created_by ? C.userName(a.created_by) : '', mine: !!a.created_by }));
  ev.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  let tlOpen = false;
  const draw = () => {
    const list = ev.filter((e) => tlShow === 'all' || (tlShow === 'user' ? e.mine : !e.mine));
    const nUser = ev.filter((e) => e.mine).length, nSys = ev.length - nUser;
    const when = (at) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const row = (e) => {
      const body = e.data?.body || (e.kind === 'note' ? e.title : '');
      const isNote = e.kind === 'note';
      const title = e.kind === 'field_changed' ? fieldTitle(e) : e.title;
      const head = isNote ? '' : `<b>${e.data?.envelope_id ? `<a href="#esigndoc/${esc(e.data.envelope_id)}">${esc(title)}</a>` : esc(title)}</b>`;
      const text = isNote || e.kind === 'activity' ? `<div class="tlbody">${esc(body).replace(/\n/g, '<br>')}</div>` : e.kind === 'call' && C.PHN ? C.PHN.timelineRow(e) : '';
      const told = (e.data?.notified || []).map((id) => C.userName(id)).filter(Boolean);
      return `<li class="${isNote ? 'tlnote' : ''}"><span class="tlicon" aria-hidden="true">${KIND_ICON[e.kind] || '•'}</span><div>${head}${text}${told.length ? `<small class="tlnotified">Notified ${esc(told.join(', '))}</small>` : ''}
        <small>${esc(when(e.at))}${e.by ? ' · ' + esc(e.by) : ''}${company && e.person ? ' · ' + esc(e.person) : ''}</small></div></li>`;
    };
    box.innerHTML = `<div class="card tlcard"><div class="toolbar"><h2 style="margin:0;flex:1">Activity</h2>
        <div class="seg small" role="group" aria-label="Show">${[['user', 'By people', nUser], ['system', 'System', nSys], ['all', 'All', ev.length]].map(([k, l, n]) => `<button type="button" class="${tlShow === k ? 'on' : ''}" data-tls="${k}">${l} <small>${n}</small></button>`).join('')}</div>
        ${leadSource ? `<span class="badge gold" title="Where they first came from">Lead source: ${esc(leadSource)}</span>` : ''}</div>
      ${canAdd && can('contacts', 2) ? `<div class="tladd"><div class="mentionwrap"><textarea id="tlNote" rows="2" placeholder="Add a note. Type @ to notify someone (dictation works here)"></textarea><div class="mentionlist" id="tlMention" role="listbox" hidden></div></div>
        <div class="tladdrow">${notifyPicker()}<button class="btn small" id="tlAdd">Add note</button></div></div>` : ''}
      <ul class="timeline">${(tlOpen ? list : list.slice(0, TL_FIRST)).map(row).join('') || `<li class="empty">${tlShow === 'user' ? 'No notes or changes from the team yet.' : tlShow === 'system' ? 'Nothing automatic yet. Forms, chats, clicks and automations show up here.' : 'Nothing yet.'}</li>`}</ul>
      ${list.length > TL_FIRST ? `<button type="button" class="btn ghost small tlmore" id="tlMore">${tlOpen ? 'Show less' : `Show ${list.length - TL_FIRST} more`}</button>` : ''}</div>`;
    $$('[data-tls]', box).forEach((b) => (b.onclick = () => { tlShow = b.dataset.tls; tlOpen = false; draw(); }));
    if (C.PHN) C.PHN.wireTimeline(box);
    if ($('#tlMore', box)) $('#tlMore', box).onclick = () => { tlOpen = !tlOpen; draw(); };
    const ta = $('#tlNote', box);
    if (ta) {
      const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 400) + 'px'; };
      const picker = wireNotify(box, ta, grow);
      const prevKey = ta.onkeydown;
      ta.onkeydown = (k) => { if (prevKey && prevKey(k) === false) return; if (k.key === 'Enter' && (k.ctrlKey || k.metaKey)) $('#tlAdd', box).click(); };
      $('#tlAdd', box).onclick = async () => {
        const v = ta.value.trim(); if (!v) return;
        $('#tlAdd', box).disabled = true;
        const who = picker.ids(v);
        const { error: e } = await sb.rpc('timeline_note', { p_person: person, p_company: company, p_body: v, p_notify: who });
        if (e) { $('#tlAdd', box).disabled = false; return C.fail(e); }
        if (onNote) await onNote();
        C.toast(who.length ? `Note added. Notified ${who.map((id) => C.userName(id)).join(', ')}` : 'Note added');
        timelineBox(box, { person, company, leadSource, canAdd, onNote });
      };
    }
  };
  draw();
}
