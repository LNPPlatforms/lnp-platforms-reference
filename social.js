/* social.js: the social planner (Tools > Marketing > Social planner). Write a post once, pick the Facebook Pages and
   Instagram accounts it goes to, add pictures or a video from the media library, then post now, schedule it or keep it as
   a draft. Batches: a spreadsheet of posts, or a stack of media spread across days. Optional approval step for people
   below Marketing level 3. Database: schema/082. Publishing: the social-publish edge function, started every minute.
   Accounts connect through social-connect (Facebook login, which brings each Page's Instagram business account along). */
import * as FLD from './field.js?v=20261116t';
import { SUPABASE_URL } from './config.js';

let C = null, sb, S, esc, $, $$;
export function init(ctx) { C = ctx; ({ sb, S, esc, $, $$ } = ctx); }
const can = (a, l = 1) => FLD.can(a, l);
export const on = () => FLD.feat('social');
const lvl = (l) => on() && (C.isAdmin() || can('marketing', l));

const NET = {
  facebook: { name: 'Facebook', short: 'f', color: '#1877F2', max: 63206 },
  instagram: { name: 'Instagram', short: 'IG', color: '#C13584', max: 2200 },
  linkedin: { name: 'LinkedIn', short: 'in', color: '#0A66C2', max: 3000 },
  google: { name: 'Google Business Profile', short: 'G', color: '#34A853', max: 1500 },
};
const STATUS = { draft: ['Draft', ''], pending: ['Needs approval', 'gold'], scheduled: ['Scheduled', 'type'], publishing: ['Posting', 'type'], posted: ['Posted', 'ok'], partial: ['Partly posted', 'due'], failed: ['Failed', 'due'] };
const T_STATUS = { waiting: 'Waiting', sending: 'Sending', processing: 'Instagram is processing', posted: 'Posted', failed: 'Failed', cancelled: 'Cancelled' };
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOf = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addD = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtT = (s) => new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDT = (s) => new Date(s).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const kindOf = (m) => (/^video\//.test(m.mime || '') || /\.(mp4|mov|m4v)(\?|$)/i.test(m.url || '') ? 'video' : /^image\//.test(m.mime || '') || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(m.url || '') ? 'image' : null);
const isPng = (m) => /png/i.test(m.mime || '') || /\.png(\?|$)/i.test(m.url || '');
const noDb = (main, title) => (main.innerHTML = `<h1>${esc(title)}</h1><p class="empty">This screen needs the social planner database update (082). Once it's applied, it works.</p>`);
const badge = (n) => `<span class="snet" style="background:${NET[n]?.color || '#666'}" title="${esc(NET[n]?.name || n)}">${esc(NET[n]?.short || '?')}</span>`;
const stBadge = (s) => `<span class="badge ${STATUS[s]?.[1] || ''}">${esc(STATUS[s]?.[0] || s)}</span>`;

let cssOn = false;
function css() {
  if (cssOn) return; cssOn = true;
  const s = document.createElement('style');
  s.textContent = `.snet{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 4px;border-radius:6px;color:#fff;font:700 11px/1 system-ui,sans-serif}
.sbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}.sbar h2{margin:0 8px 0 0;font-size:18px}.sbar select{width:auto;min-width:150px;margin:0;min-height:40px}
.smonth{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--card)}
.smonth .dh{padding:6px;font-size:12px;color:var(--muted);text-align:center;border-bottom:1px solid var(--line);background:#F5F5F5}
.smonth .dc{min-height:104px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:4px;cursor:pointer;display:flex;flex-direction:column;gap:3px;min-width:0}
.smonth .dc.out{background:#F5F5F5;opacity:.7}.smonth .dc.today .dn{background:var(--navy);color:#fff;border-radius:999px;padding:0 6px}
.smonth .dn{font-size:12px;color:var(--muted);align-self:flex-start}
.schip{display:flex;gap:4px;align-items:center;font-size:12px;border-radius:6px;padding:2px 4px;background:#EEF2F8;border:0;text-align:left;cursor:pointer;min-width:0;color:var(--navy)}
.schip span.t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}.schip img{width:18px;height:18px;object-fit:cover;border-radius:3px}
.schip.draft{background:#F5F5F5;color:var(--muted)}.schip.pending{background:#F6EBD3}.schip.posted{background:#DDF0E6}.schip.failed,.schip.partial{background:#FBE3D9}
.slist .srow{display:flex;gap:10px;align-items:flex-start;padding:10px;border-bottom:1px solid var(--line);cursor:pointer}.slist .srow:last-child{border-bottom:0}
.slist .srow img,.slist .srow .ph{width:56px;height:56px;object-fit:cover;border-radius:8px;background:#EEF2F8;flex:none}
.slist .srow .tx{flex:1;min-width:0}.slist .srow .tx p{margin:2px 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.smedia{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}.smedia .mi{position:relative;width:76px;height:76px;border-radius:8px;overflow:hidden;background:#EEF2F8;display:flex;align-items:center;justify-content:center;font-size:12px}
.smedia .mi img,.smedia .mi video{width:100%;height:100%;object-fit:cover}.smedia .mi button{position:absolute;top:2px;right:2px;border:0;border-radius:999px;width:22px;height:22px;background:rgba(0,0,0,.6);color:#fff;cursor:pointer}
.sacc{display:flex;gap:8px;flex-wrap:wrap}.sacc label{display:flex;gap:6px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:6px 10px;cursor:pointer;background:var(--card)}
.sacc label img{width:22px;height:22px;border-radius:999px}.sacc label.off{opacity:.55}
.scount{font-size:12px;color:var(--muted);text-align:right}.scount .over{color:var(--warn);font-weight:600}
.sprev{border:1px solid var(--line);border-radius:12px;padding:10px;background:var(--card);margin-top:8px}.sprev .h{display:flex;gap:8px;align-items:center;font-weight:600;margin-bottom:6px}
.sprev p{white-space:pre-wrap;margin:0 0 8px;font-size:14px}.sprev .pm{display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:4px}.sprev .pm img,.sprev .pm video{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px}
.spick{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;max-height:52vh;overflow:auto;margin:8px 0}
.spick label{position:relative;display:block;border:2px solid transparent;border-radius:10px;overflow:hidden;cursor:pointer;aspect-ratio:1;background:#EEF2F8}
.spick label:has(input:checked){border-color:var(--navy)}.spick input{position:absolute;top:6px;left:6px}.spick img,.spick video{width:100%;height:100%;object-fit:cover}
.spick small{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.55);color:#fff;font-size:11px;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sbatch table{width:100%;border-collapse:collapse;font-size:13px}.sbatch th,.sbatch td{padding:6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.sbatch th{background:#F5F5F5}
.sbatch td textarea{min-height:56px;font-size:13px}.sbatch td input{font-size:13px;min-height:34px}.sbatch tr.bad td{background:#FBE3D9}#spAt input{min-width:0;width:100%}.sbatch .err{color:var(--warn);font-size:12px}
@media (max-width:700px){.smonth .dc{min-height:64px}.schip span.t{display:none}}`;
  document.head.appendChild(s);
}

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

/* ================= navigation ================= */
export const drawerItems = () => ({
  marketing: [
    { id: 'social', label: 'Social planner', match: ['social', 'socialaccounts', 'socialbatch'], what: 'Write, schedule and batch posts for Facebook and Instagram', when: () => lvl(1) },
  ],
});
export const views = () => ({ social: viewPlanner, socialaccounts: viewAccounts, socialbatch: viewBatch });
export const parents = { social: 'tools', socialaccounts: 'social', socialbatch: 'social' };
export const guards = { social: () => lvl(1), socialaccounts: () => lvl(1), socialbatch: () => lvl(2) };
export const screens = () => (lvl(1) ? [['social', 'Social planner', 'social media posts facebook instagram schedule batch content calendar planner']] : []);

/* ================= shared loads ================= */
let ACCTS = [], SET = {};
async function loadBasics() {
  const [a, s] = await Promise.all([sb.from('social_accounts').select('*').order('network').order('name'), sb.rpc('social_settings')]);
  if (a.error || s.error) return false;
  ACCTS = a.data || []; SET = s.data || {};
  return true;
}
const acct = (id) => ACCTS.find((a) => a.id === id);
const VIEW = { mode: 'month', acct: '' };
try { Object.assign(VIEW, JSON.parse(localStorage.getItem('lnp.social') || '{}')); } catch { /* storage off */ }
const savePrefs = () => { try { localStorage.setItem('lnp.social', JSON.stringify(VIEW)); } catch { /* storage off */ } };

/* ================= the planner ================= */
async function viewPlanner(main, param = S.param) {
  css();
  if (!(await loadBasics())) return noDb(main, 'Social planner');
  const day = param && /^\d{4}-\d{2}-\d{2}$/.test(param) ? dayOf(param) : new Date();
  const first = new Date(day.getFullYear(), day.getMonth(), 1);
  const from = addD(first, -first.getDay()), to = addD(from, 42);
  const { data, error } = await sb.rpc('social_posts_list', { p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) return C.fail(error);
  let posts = (data || []).filter((p) => !VIEW.acct || (p.account_ids || []).includes(VIEW.acct));
  const ready = ACCTS.filter((a) => a.status === 'ok');
  const pend = posts.filter((p) => p.status === 'pending').length, failed = posts.filter((p) => p.status === 'failed' || p.status === 'partial').length;
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Social planner</h1>
      <button class="btn ghost small" data-nav="socialaccounts">Accounts${ACCTS.some((a) => a.status !== 'ok') ? ' <span class="badge due">Reconnect</span>' : ''}</button>
      ${SET.can_post ? '<button class="btn ghost small" data-nav="socialbatch">Batch</button><button class="btn small" id="spNew">New post</button>' : ''}</div>
    ${!ACCTS.length ? `<div class="card panel"><h2>Connect your pages first</h2><p class="empty">Connect a Facebook Page and its Instagram business account and posts can go out on their own. You can still write drafts now.</p>
      ${SET.can_connect ? '<button class="btn small" data-nav="socialaccounts">Connect accounts</button>' : '<p class="hint">Ask an admin to connect your accounts.</p>'}</div>` : ''}
    ${pend || failed ? `<p class="hint">${pend ? `<b>${pend}</b> waiting for approval. ` : ''}${failed ? `<b>${failed}</b> didn't fully go out. ` : ''}<button class="linkish" id="spShowList">See them</button></p>` : ''}
    <div class="sbar"><button class="btn secondary small" id="spPrev" aria-label="Back">‹</button><button class="btn secondary small" id="spToday">Today</button><button class="btn secondary small" id="spNext" aria-label="Forward">›</button>
      <h2>${esc(day.toLocaleDateString([], { month: 'long', year: 'numeric' }))}</h2>
      <div class="seg" role="group" aria-label="View">${[['month', 'Month'], ['list', 'List']].map(([k, n]) => `<button type="button" class="${VIEW.mode === k ? 'on' : ''}" data-mode="${k}">${n}</button>`).join('')}</div>
      ${ACCTS.length > 1 ? `<select id="spAcct" aria-label="Account"><option value="">All accounts</option>${ACCTS.map((a) => `<option value="${a.id}" ${VIEW.acct === a.id ? 'selected' : ''}>${esc(NET[a.network]?.name || a.network)}: ${esc(a.name)}</option>`).join('')}</select>` : ''}</div>
    <div id="spBody"></div>`;
  const body = $('#spBody', main);
  const thumb = (p) => { const m = (p.media || [])[0]; return m ? (m.kind === 'video' ? '<span class="ph" style="display:flex;align-items:center;justify-content:center">▶</span>' : `<img src="${esc(m.url)}" alt="" loading="lazy">`) : '<span class="ph"></span>'; };
  const nets = (p) => [...new Set((p.account_ids || []).map((id) => acct(id)?.network).filter(Boolean))].map(badge).join('');
  if (VIEW.mode === 'month') {
    const today = isoDay(new Date());
    const cells = [...Array(42)].map((_, i) => {
      const d = addD(from, i), k = isoDay(d);
      const list = posts.filter((p) => p.scheduled_at && isoDay(new Date(p.scheduled_at)) === k);
      return `<div class="dc ${d.getMonth() !== day.getMonth() ? 'out' : ''} ${k === today ? 'today' : ''}" data-day="${k}"><span class="dn">${d.getDate()}</span>
        ${list.slice(0, 4).map((p) => `<button type="button" class="schip ${p.status}" data-post="${p.id}" title="${esc(STATUS[p.status]?.[0] || '')}: ${esc((p.body || '').slice(0, 80))}">
          ${(p.media || [])[0]?.kind === 'image' ? `<img src="${esc(p.media[0].url)}" alt="" loading="lazy">` : ''}<span class="t">${esc(fmtT(p.scheduled_at))} ${esc(p.body || '(picture)')}</span>${nets(p)}</button>`).join('')}
        ${list.length > 4 ? `<small class="hint">+${list.length - 4} more</small>` : ''}</div>`;
    }).join('');
    const drafts = posts.filter((p) => p.status === 'draft' && !p.scheduled_at);
    body.innerHTML = `<div class="smonth">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="dh">${d}</div>`).join('')}${cells}</div>
      ${drafts.length ? `<h2 style="margin-top:16px">Drafts with no date</h2><div class="card slist">${drafts.map(row).join('')}</div>` : ''}`;
  } else {
    const groups = [['Needs approval', (p) => p.status === 'pending'], ['Didn\'t go out', (p) => p.status === 'failed' || p.status === 'partial'],
      ['Coming up', (p) => ['scheduled', 'publishing'].includes(p.status)], ['Drafts', (p) => p.status === 'draft'], ['Posted', (p) => p.status === 'posted']];
    body.innerHTML = groups.map(([n, f]) => { const l = posts.filter(f); if (n === 'Posted') l.reverse(); return l.length ? `<h2>${esc(n)}</h2><div class="card slist">${l.map(row).join('')}</div>` : ''; }).join('')
      || '<p class="empty">Nothing this month yet.</p>';
  }
  function row(p) {
    return `<div class="srow" data-post="${p.id}">${thumb(p)}<div class="tx"><div>${stBadge(p.status)} ${nets(p)} <small class="hint">${p.scheduled_at ? esc(fmtDT(p.scheduled_at)) : 'No date yet'}${p.batch_name ? ' · ' + esc(p.batch_name) : ''} · ${esc(p.by || '')}</small></div>
      <p>${esc(p.body || '(no text)')}</p>${(p.targets || []).filter((t) => t.status === 'failed').map((t) => `<small class="err" style="color:var(--warn)">${esc(acct(t.account_id)?.name || '')}: ${esc(t.error || 'Failed')}</small>`).join('<br>')}</div></div>`;
  }
  const nav = (n) => C.go('social', isoDay(new Date(day.getFullYear(), day.getMonth() + n, 1)));
  $('#spPrev').onclick = () => nav(-1); $('#spNext').onclick = () => nav(1); $('#spToday').onclick = () => C.go('social', isoDay(new Date()));
  $$('[data-mode]', main).forEach((b) => (b.onclick = () => { VIEW.mode = b.dataset.mode; savePrefs(); viewPlanner(main, param); }));
  if ($('#spAcct')) $('#spAcct').onchange = (e) => { VIEW.acct = e.target.value; savePrefs(); viewPlanner(main, param); };
  if ($('#spShowList')) $('#spShowList').onclick = () => { VIEW.mode = 'list'; savePrefs(); viewPlanner(main, param); };
  $$('[data-nav]', main).forEach((b) => (b.onclick = () => C.go(b.dataset.nav)));
  const again = () => viewPlanner(main, param);
  if ($('#spNew')) $('#spNew').onclick = () => compose(null, { after: again });
  body.onclick = (e) => {
    const p = e.target.closest('[data-post]');
    if (p) { e.stopPropagation(); return compose((data || []).find((x) => x.id === p.dataset.post), { after: again }); }
    const d = e.target.closest('[data-day]');
    if (d && SET.can_post) {
      const at = dayOf(d.dataset.day); const [h, m] = String(SET.default_time || '10:00').split(':').map(Number); at.setHours(h, m, 0, 0);
      if (at < new Date()) { if (isoDay(at) !== isoDay(new Date())) return C.toast('That day already passed'); at.setTime(Date.now() + 3600000); at.setMinutes(0); }
      compose(null, { at, after: again });
    }
  };
  if (!ready.length && ACCTS.length) C.toast('Your connected accounts need reconnecting', { error: true });
}

/* ================= the composer ================= */
function compose(post, { at = null, after = () => {}, seed = null } = {}) {
  const p = post ? JSON.parse(JSON.stringify(post)) : { body: '', media: [], link: '', account_ids: ACCTS.filter((a) => a.status === 'ok').map((a) => a.id), note: '', ...(seed || {}), status: 'draft' };
  const locked = ['publishing', 'posted', 'partial'].includes(p.status);
  const mineOrManage = !post || post.mine || SET.can_manage;
  const editable = SET.can_post && mineOrManage && !locked;
  const when = p.scheduled_at ? new Date(p.scheduled_at) : at || (() => { const d = addD(new Date(), 1); const [h, m] = String(SET.default_time || '10:00').split(':').map(Number); d.setHours(h, m, 0, 0); return d; })();
  const d = dlg('spDlg', `<form method="dialog" style="max-width:760px">
    <div class="vhead"><h2 style="margin:0;flex:1">${post ? (locked ? 'Post' : 'Edit post') : 'New post'} ${post ? stBadge(p.status) : ''}</h2><button type="button" class="btn ghost small" data-x>Close</button></div>
    ${locked ? `<div class="card" style="padding:10px;margin:8px 0">${(p.targets || []).map((t) => { const a = acct(t.account_id); return `<div style="display:flex;gap:8px;align-items:center;padding:4px 0">${badge(a?.network)}<b>${esc(a?.name || 'Removed account')}</b>
        <span class="badge ${t.status === 'posted' ? 'ok' : t.status === 'failed' ? 'due' : ''}">${esc(T_STATUS[t.status] || t.status)}</span>${t.permalink ? `<a href="${esc(t.permalink)}" target="_blank" rel="noopener">View</a>` : ''}${t.error ? `<small class="hint">${esc(t.error)}</small>` : ''}</div>`; }).join('') || '<p class="hint">Nothing sent yet.</p>'}</div>` : ''}
    <label class="label">Post to</label>
    <div class="sacc" id="spAccts">${ACCTS.length ? ACCTS.map((a) => `<label class="${a.status !== 'ok' ? 'off' : ''}"><input type="checkbox" value="${a.id}" ${(p.account_ids || []).includes(a.id) ? 'checked' : ''} ${editable ? '' : 'disabled'}>
      ${a.picture_url ? `<img src="${esc(a.picture_url)}" alt="">` : ''}${badge(a.network)} ${esc(a.handle ? '@' + a.handle : a.name)}${a.status !== 'ok' ? ' <span class="badge due">Reconnect</span>' : ''}</label>`).join('')
      : '<p class="hint">No accounts connected yet, so this can only be a draft.</p>'}</div>
    <label class="label" for="spText">Text</label>
    <textarea id="spText" rows="6" ${editable ? '' : 'readonly'} placeholder="What do you want to say?">${esc(p.body || '')}</textarea>
    <div class="scount" id="spCount"></div>
    <label class="label">Pictures or video</label>
    <div class="smedia" id="spMedia"></div>
    ${editable ? `<div class="actions" style="margin-top:0"><button type="button" class="btn secondary small" id="spLib">From media library</button><label class="btn secondary small" for="spUp">Upload</label><input type="file" id="spUp" accept="image/*,video/*" multiple hidden></div>
      <small class="hint">Up to 10 pictures, or one video. Instagram needs at least one and only takes JPEG pictures.</small>` : ''}
    <label class="label" for="spLink">Link (Facebook, text posts only)</label>
    <input type="url" id="spLink" value="${esc(p.link || '')}" placeholder="https://" ${editable ? '' : 'readonly'}>
    ${editable ? `<label class="label">When</label>
      <div class="seg" role="group" id="spWhen">${[['schedule', 'Schedule'], ['now', 'Post now'], ['draft', 'Draft']].map(([k, n]) => `<button type="button" data-when="${k}" class="${(p.status === 'draft' && post ? 'draft' : 'schedule') === k ? 'on' : ''}">${n}</button>`).join('')}</div>
      <div class="row" id="spAt"><div><label class="label" for="spDate">Date</label><input type="date" id="spDate" value="${isoDay(when)}"></div><div><label class="label" for="spTime">Time</label><input type="time" id="spTime" value="${hm(when)}"></div></div>
      ${SET.require_approval && !SET.can_manage ? '<small class="hint">A manager approves posts before they go out.</small>' : ''}` : (p.scheduled_at ? `<p class="hint">${esc(fmtDT(p.scheduled_at))}</p>` : '')}
    <label class="label" for="spNote">Note for the team (never posted)</label>
    <input type="text" id="spNote" value="${esc(p.note || '')}" ${editable ? '' : 'readonly'}>
    <div id="spWarn"></div>
    <details style="margin-top:8px"><summary>Preview</summary><div id="spPrev"></div></details>
    <div class="actions">
      ${editable ? '<button type="button" class="btn small" id="spGo">Schedule</button>' : ''}
      ${post && SET.can_manage && p.status === 'pending' ? '<button type="button" class="btn small" id="spApprove">Approve</button>' : ''}
      ${post && mineOrManage && ['failed', 'partial'].includes(p.status) ? '<button type="button" class="btn small" id="spRetry">Try again</button>' : ''}
      ${post && mineOrManage && ['scheduled', 'pending', 'failed'].includes(p.status) ? '<button type="button" class="btn ghost small" id="spUnsched">Back to draft</button>' : ''}
      ${post && SET.can_post ? '<button type="button" class="btn ghost small" id="spDup">Duplicate</button>' : ''}
      ${post && mineOrManage && p.status !== 'publishing' ? '<button type="button" class="btn ghost small danger" id="spDel">Delete</button>' : ''}
    </div>
    ${post ? `<small class="hint">By ${esc(p.by || 'someone')}${p.approved_by ? ` · approved by ${esc(p.approved_by)}` : ''}${p.batch_name ? ` · ${esc(p.batch_name)}` : ''}</small>` : ''}
  </form>`);
  let mode = p.status === 'draft' && post ? 'draft' : 'schedule';
  const chosen = () => $$('#spAccts input', d).filter((c) => c.checked).map((c) => c.value);
  const drawMedia = () => {
    $('#spMedia', d).innerHTML = (p.media || []).map((m, i) => `<div class="mi">${m.kind === 'video' ? `<video src="${esc(m.url)}" muted></video>` : `<img src="${esc(m.url)}" alt="">`}${editable ? `<button type="button" data-rmm="${i}" aria-label="Remove">×</button>` : ''}</div>`).join('')
      || '<small class="hint">None</small>';
    $$('[data-rmm]', d).forEach((b) => (b.onclick = () => { p.media.splice(Number(b.dataset.rmm), 1); refresh(); }));
  };
  const refresh = () => {
    drawMedia();
    const text = $('#spText', d).value, nets = [...new Set(chosen().map((id) => acct(id)?.network))].filter(Boolean);
    $('#spCount', d).innerHTML = nets.map((n) => { const over = text.length > NET[n].max; return `<span class="${over ? 'over' : ''}">${esc(NET[n].name)} ${text.length.toLocaleString()} / ${NET[n].max.toLocaleString()}</span>`; }).join(' · ') || `${text.length.toLocaleString()} characters`;
    const w = [];
    if (nets.includes('instagram')) {
      if (!p.media.length) w.push('Instagram needs a picture or video.');
      if (p.media.some(isPng)) w.push('Instagram only takes JPEG pictures. Save PNGs as JPEG first.');
      if ((text.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) w.push('Instagram allows up to 30 hashtags.');
    }
    if ($('#spLink', d).value && p.media.length) w.push('Facebook shows the link preview only on posts without pictures. The link still shows in the text if you paste it there.');
    $('#spWarn', d).innerHTML = w.map((x) => `<p class="hint" style="color:var(--warn)">${esc(x)}</p>`).join('');
    const mediaHtml = p.media.length ? `<div class="pm">${p.media.map((m) => (m.kind === 'video' ? `<video src="${esc(m.url)}" muted></video>` : `<img src="${esc(m.url)}" alt="">`)).join('')}</div>` : '';
    $('#spPrev', d).innerHTML = chosen().map((id) => { const a = acct(id); return `<div class="sprev"><div class="h">${badge(a.network)} ${esc(a.handle ? '@' + a.handle : a.name)}</div>
      ${a.network === 'instagram' ? mediaHtml + `<p>${esc(text)}</p>` : `<p>${esc(text)}</p>` + mediaHtml}</div>`; }).join('') || '<p class="hint">Pick an account to see a preview.</p>';
    if ($('#spAt', d)) $('#spAt', d).style.display = mode === 'schedule' ? '' : 'none';
    if ($('#spGo', d)) $('#spGo', d).textContent = mode === 'draft' ? 'Save draft' : mode === 'now' ? 'Post now' : SET.require_approval && !SET.can_manage ? 'Send for approval' : 'Schedule';
  };
  $('#spText', d).oninput = refresh; $('#spLink', d).oninput = refresh;
  $$('#spAccts input', d).forEach((c) => (c.onchange = refresh));
  $$('[data-when]', d).forEach((b) => (b.onclick = () => { mode = b.dataset.when; $$('[data-when]', d).forEach((x) => x.classList.toggle('on', x === b)); refresh(); }));
  const addMedia = (list) => {
    for (const m of list) { const kind = kindOf(m); if (!kind) { C.toast(`${m.title || 'That file'} isn't a picture or video`, { error: true }); continue; } if (!p.media.some((x) => x.url === m.url)) p.media.push({ url: m.url, kind, title: m.title || '', mime: m.mime || '' }); }
    if (p.media.length > 10) { p.media = p.media.slice(0, 10); C.toast('Kept the first 10'); }
    refresh();
  };
  if ($('#spLib', d)) $('#spLib', d).onclick = () => pickMedia(addMedia);
  if ($('#spUp', d)) $('#spUp', d).onchange = async (e) => { const up = await uploadFiles([...e.target.files]); addMedia(up); };
  const save = async (m) => {
    const dt = m === 'schedule' ? new Date(`${$('#spDate', d).value}T${$('#spTime', d).value || '10:00'}`) : null;
    if (m === 'schedule' && isNaN(dt)) return C.toast('Pick a date and time', { error: true });
    const payload = { id: post?.id || null, body: $('#spText', d).value, media: p.media, link: $('#spLink', d).value.trim(), account_ids: chosen(), mode: m,
      scheduled_at: dt ? dt.toISOString() : (m === 'draft' && post?.scheduled_at) || null, note: $('#spNote', d).value };
    if (m === 'now' && !confirm(`Post this to ${C.plural(chosen().length, 'account', 'accounts')} right now?`)) return;
    const { error } = await sb.rpc('social_post_save', { p: payload });
    if (error) return C.fail(error);
    C.toast(m === 'draft' ? 'Draft saved' : m === 'now' ? 'Going out now. It takes about a minute.' : SET.require_approval && !SET.can_manage ? 'Sent for approval' : 'Scheduled');
    d.close(); after();
  };
  const act = async (fn, msg, ask) => { if (ask && !confirm(ask)) return; const { error } = await sb.rpc(fn, { p_id: post.id }); if (error) return C.fail(error); C.toast(msg); d.close(); after(); };
  if ($('#spGo', d)) $('#spGo', d).onclick = () => save(mode);
  if ($('#spApprove', d)) $('#spApprove', d).onclick = () => act('social_post_approve', 'Approved and scheduled');
  if ($('#spRetry', d)) $('#spRetry', d).onclick = () => act('social_post_retry', 'Trying again');
  if ($('#spUnsched', d)) $('#spUnsched', d).onclick = () => act('social_post_unschedule', 'Back to drafts');
  if ($('#spDel', d)) $('#spDel', d).onclick = () => act('social_post_delete', 'Deleted', locked ? 'Remove this from the planner? It stays up on Facebook and Instagram.' : 'Delete this post?');
  if ($('#spDup', d)) $('#spDup', d).onclick = () => { d.close(); compose(null, { after, seed: { body: p.body || '', media: JSON.parse(JSON.stringify(p.media || [])), link: p.link || '', account_ids: (p.account_ids || []).filter((id) => acct(id)), note: '' } }); };
  refresh();
}
async function uploadFiles(files) {
  const out = [];
  for (const f of files) {
    const path = `${S.acct.id}/library/${Date.now()}-${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const up = await sb.storage.from('media').upload(path, f, { contentType: f.type || 'application/octet-stream', upsert: false });
    if (up.error) { C.fail(up.error); continue; }
    const url = sb.storage.from('media').getPublicUrl(path).data.publicUrl;
    const kind = /^image\//.test(f.type) ? 'photo' : /^video\//.test(f.type) ? 'video' : 'file';
    const { error } = await sb.rpc('media_add', { p: { path, url, kind, title: f.name, mime: f.type, bytes: f.size, folder: 'Social', scope: 'personal' } });
    if (error) C.fail(error);
    out.push({ url, title: f.name, mime: f.type });
  }
  return out;
}

async function pickMedia(done, { multi = true } = {}) {
  const { data, error } = await sb.rpc('media_library');
  if (error) return C.fail(error);
  const items = (data || []).filter((m) => kindOf(m));
  const d = dlg('spPick', `<div style="max-width:720px"><div class="vhead"><h2 style="margin:0">Media library</h2><button type="button" class="btn ghost small" data-x>Close</button></div>
    <input type="search" id="spPq" placeholder="Search pictures and videos"><div class="spick" id="spPg"></div>
    <div class="actions"><button type="button" class="btn small" id="spPadd">Add</button><span class="hint" id="spPn"></span></div></div>`);
  const draw = () => {
    const q = $('#spPq', d).value.toLowerCase();
    $('#spPg', d).innerHTML = items.filter((m) => !q || (m.title || '').toLowerCase().includes(q) || (m.folder || '').toLowerCase().includes(q)).map((m) => `<label><input type="${multi ? 'checkbox' : 'radio'}" name="spp" value="${m.id}">
      ${kindOf(m) === 'video' ? `<video src="${esc(m.url)}" muted preload="metadata"></video>` : `<img src="${esc(m.url)}" alt="" loading="lazy">`}<small>${esc(m.title || '')}</small></label>`).join('') || '<p class="empty">No pictures or videos in the library yet. Upload them under Tools, Marketing, Media.</p>';
    $$('#spPg input', d).forEach((c) => (c.onchange = () => ($('#spPn', d).textContent = `${$$('#spPg input:checked', d).length} picked`)));
  };
  $('#spPq', d).oninput = draw; draw();
  $('#spPadd', d).onclick = () => { const ids = $$('#spPg input:checked', d).map((c) => c.value); d.close(); done(items.filter((m) => ids.includes(m.id))); };
}

/* ================= accounts and settings ================= */
async function viewAccounts(main, param = S.param) {
  css();
  if (!(await loadBasics())) return noDb(main, 'Social accounts');
  const msg = String(param || '');
  if (msg.startsWith('connected-')) setTimeout(() => C.toast(`Connected ${C.plural(Number(msg.split('-')[1]) || 0, 'account', 'accounts')}`), 50);
  if (msg.startsWith('error-')) setTimeout(() => C.toast(decodeURIComponent(msg.slice(6)), { error: true }), 50);
  const by = (n) => ACCTS.filter((a) => a.network === n);
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Social accounts</h1><button class="btn ghost small" data-nav="social">Planner</button></div>
    <div class="card panel"><h2>${badge('facebook')} ${badge('instagram')} Facebook and Instagram</h2>
      <p class="empty">Sign in with Facebook and pick the Pages to connect. Any Instagram business or creator account linked to a Page comes along with it.</p>
      ${[...by('facebook'), ...by('instagram')].map((a) => `<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--line)">
        ${a.picture_url ? `<img src="${esc(a.picture_url)}" alt="" style="width:32px;height:32px;border-radius:999px">` : badge(a.network)}
        <div style="flex:1;min-width:0"><b>${esc(a.name)}</b> ${a.handle ? `<small class="hint">@${esc(a.handle)}</small>` : ''}<br><small class="hint">${esc(NET[a.network].name)}${a.status !== 'ok' ? ` · ${esc(a.status_note || 'Needs reconnecting')}` : ''}</small></div>
        ${a.status !== 'ok' ? '<span class="badge due">Reconnect</span>' : '<span class="badge ok">Connected</span>'}
        ${SET.can_connect ? `<button class="btn ghost small danger" data-rm="${a.id}">Remove</button>` : ''}</div>`).join('')}
      ${SET.can_connect ? `<div class="actions"><button class="btn small" id="saMeta">${ACCTS.some((a) => ['facebook', 'instagram'].includes(a.network)) ? 'Connect more or reconnect' : 'Connect Facebook and Instagram'}</button></div>
        <small class="hint">Instagram personal accounts can't be posted to by any app. Switch it to a business or creator account in the Instagram app and link it to your Facebook Page first.</small>`
        : '<p class="hint">Only admins (or Marketing level 4) can connect accounts.</p>'}</div>
    <div class="card panel"><h2>${badge('linkedin')} LinkedIn and ${badge('google')} Google Business Profile</h2><p class="empty">Coming next. They each need their own app approval before they can post for you.</p></div>
    ${SET.can_connect ? `<div class="card panel"><h2>Planner settings</h2>
      <label class="check"><input type="checkbox" id="saAppr" ${SET.require_approval ? 'checked' : ''}> Posts need approval before they go out</label>
      <small class="hint">People with Marketing level 3 or higher approve, and their own posts skip it.</small>
      <label class="label" for="saTime">Default time for new posts</label><input type="time" id="saTime" value="${esc(SET.default_time || '10:00')}" style="max-width:160px">
      <div class="actions"><button class="btn small" id="saSave">Save</button></div></div>` : ''}`;
  $$('[data-nav]', main).forEach((b) => (b.onclick = () => C.go(b.dataset.nav)));
  $$('[data-rm]', main).forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this account? Posts waiting to go to it are cancelled. Nothing already posted changes.')) return;
    const { error } = await sb.rpc('social_account_remove', { p_id: b.dataset.rm }); if (error) return C.fail(error); C.toast('Removed'); viewAccounts(main);
  }));
  if ($('#saMeta')) $('#saMeta').onclick = async () => {
    $('#saMeta').disabled = true;
    const { data, error } = await sb.functions.invoke('social-connect', { body: { action: 'start', return_to: location.origin + '/' } });
    $('#saMeta').disabled = false;
    if (error || !data?.url) {
      let m = data?.error; try { m = m || (await error?.context?.json?.())?.error; } catch { /* plain error */ }
      return C.toast(m || error?.message || 'Couldn\'t start the Facebook connect', { error: true });
    }
    location.href = data.url;
  };
  if ($('#saSave')) $('#saSave').onclick = async () => {
    const { error } = await sb.rpc('social_settings_save', { p: { require_approval: $('#saAppr').checked, default_time: $('#saTime').value || '10:00' } });
    if (error) return C.fail(error); C.toast('Saved'); viewAccounts(main);
  };
}

/* ================= batches ================= */
// a small CSV reader: quotes, commas and line breaks inside quotes
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
// "2026-11-10" or "11/10/2026" plus "9:30", "09:30" or "9:30 am"
export function parseWhen(date, time, fallback = '10:00') {
  let y, m, d; const s = String(date || '').trim();
  let x = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); if (x) [y, m, d] = [x[1], x[2], x[3]].map(Number);
  else if ((x = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) { [m, d, y] = [x[1], x[2], x[3]].map(Number); if (y < 100) y += 2000; } else return null;
  const t = String(time || fallback).trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/); if (!t) return null;
  let h = Number(t[1]); const mi = Number(t[2] || 0); if (t[3]?.startsWith('p') && h < 12) h += 12; if (t[3]?.startsWith('a') && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  const out = new Date(y, m - 1, d, h, mi); return out.getMonth() === m - 1 ? out : null;
}
const TEMPLATE = 'date,time,text,media,accounts,link\n2026-11-10,10:00,"Our first post of the week! #local",https://example.com/photo.jpg,all,\n2026-11-12,2:30 pm,"Text only post for Facebook",,facebook,https://yoursite.com\n';

async function viewBatch(main) {
  css();
  if (!(await loadBasics())) return noDb(main, 'Batch posts');
  const ok = ACCTS.filter((a) => a.status === 'ok');
  let rows = [];
  main.innerHTML = `<div class="toolbar"><h1 style="flex:1;margin:0">Batch posts</h1><button class="btn ghost small" data-nav="social">Planner</button></div>
    <div class="seg" role="group" id="sbTabs"><button type="button" class="on" data-tab="media">From media</button><button type="button" data-tab="sheet">From a spreadsheet</button></div>
    <div class="card panel" id="sbMedia"><h2>One post per picture, spread across days</h2>
      <p class="empty">Pick a stack of pictures or videos, write one caption (or leave it for each post), and they're laid out on the days you choose. You can change each one before scheduling.</p>
      <button type="button" class="btn secondary small" id="sbPick">Pick from media library</button> <span class="hint" id="sbPicked">None picked</span>
      <label class="label" for="sbCap">Caption for every post (optional)</label><textarea id="sbCap" rows="3" placeholder="Use {n} for the post number"></textarea>
      <div class="row"><div><label class="label" for="sbStart">Start</label><input type="date" id="sbStart" value="${isoDay(addD(new Date(), 1))}"></div>
        <div><label class="label" for="sbTime">Time</label><input type="time" id="sbTime" value="${esc(SET.default_time || '10:00')}"></div>
        <div><label class="label" for="sbEvery">Every</label><select id="sbEvery">${[[1, 'day'], [2, '2 days'], [3, '3 days'], [7, 'week'], ['wk', 'weekday (skip weekends)'], ['mwf', 'Mon, Wed and Fri']].map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></div></div>
      <label class="label">Post to</label><div class="sacc" id="sbAccts">${ok.map((a) => `<label><input type="checkbox" value="${a.id}" checked> ${badge(a.network)} ${esc(a.handle ? '@' + a.handle : a.name)}</label>`).join('') || '<p class="hint">No accounts connected. These can still be saved as drafts.</p>'}</div>
      <div class="actions"><button type="button" class="btn small" id="sbLay">Lay them out</button></div></div>
    <div class="card panel" id="sbSheet" hidden><h2>From a spreadsheet</h2>
      <p class="empty">One row per post. Columns: date, time, text, media (links from the media library, separated by spaces), accounts (all, facebook, instagram or the page names separated by ;) and link. Excel or Google Sheets can save it as CSV.</p>
      <div class="actions" style="margin-top:0"><button type="button" class="btn secondary small" id="sbTpl">Download the template</button><label class="btn secondary small" for="sbFile">Open a CSV</label><input type="file" id="sbFile" accept=".csv,text/csv,.tsv,text/tab-separated-values" hidden></div>
      <label class="label" for="sbPaste">Or paste the rows here (copying from a sheet works)</label><textarea id="sbPaste" rows="5" placeholder="date,time,text,media,accounts,link"></textarea>
      <div class="actions"><button type="button" class="btn small" id="sbRead">Read the rows</button></div></div>
    <div id="sbOut"></div>`;
  $$('[data-nav]', main).forEach((b) => (b.onclick = () => C.go(b.dataset.nav)));
  $$('[data-tab]', main).forEach((b) => (b.onclick = () => { $$('[data-tab]', main).forEach((x) => x.classList.toggle('on', x === b)); $('#sbMedia').hidden = b.dataset.tab !== 'media'; $('#sbSheet').hidden = b.dataset.tab !== 'sheet'; }));
  let picked = [];
  $('#sbPick').onclick = () => pickMedia((list) => { picked = list.map((m) => ({ url: m.url, kind: kindOf(m), title: m.title || '', mime: m.mime || '' })); $('#sbPicked').textContent = C.plural(picked.length, 'file', 'files') + ' picked'; });
  $('#sbLay').onclick = () => {
    if (!picked.length) return C.toast('Pick some pictures or videos first', { error: true });
    const accts = $$('#sbAccts input', main).filter((c) => c.checked).map((c) => c.value);
    const every = $('#sbEvery').value; let d = new Date(`${$('#sbStart').value}T${$('#sbTime').value || '10:00'}`);
    if (isNaN(d)) return C.toast('Pick a start date', { error: true });
    const fits = (x) => (every === 'wk' ? x.getDay() % 6 !== 0 : every === 'mwf' ? [1, 3, 5].includes(x.getDay()) : true);
    while (!fits(d)) d = addD(d, 1);
    rows = picked.map((m, i) => {
      const r = { when: new Date(d), body: ($('#sbCap').value || '').replace(/\{n\}/g, String(i + 1)), media: [m], link: '', account_ids: accts };
      do { d = addD(d, every === 'wk' || every === 'mwf' ? 1 : Number(every)); } while (!fits(d));
      return r;
    });
    drawRows();
  };
  $('#sbTpl').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([TEMPLATE], { type: 'text/csv' })); a.download = 'social-posts-template.csv'; a.click(); };
  $('#sbFile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; $('#sbPaste').value = await f.text(); readSheet(); };
  $('#sbRead').onclick = () => readSheet();
  function readSheet() {
    const all = parseCsv($('#sbPaste').value || '');
    if (!all.length) return C.toast('Nothing to read', { error: true });
    const head = all[0].map((h) => h.trim().toLowerCase());
    const hasHead = head.includes('date') || head.includes('text');
    const col = (n, i) => (hasHead ? head.indexOf(n) : i);
    const ix = { date: col('date', 0), time: col('time', 1), text: col('text', 2), media: col('media', 3), accounts: col('accounts', 4), link: col('link', 5) };
    const get = (r, k) => (ix[k] >= 0 ? String(r[ix[k]] ?? '').trim() : '');
    rows = (hasHead ? all.slice(1) : all).map((r) => {
      const media = get(r, 'media').split(/[\s|]+/).filter(Boolean).map((url) => ({ url, kind: kindOf({ url }) || 'image', title: '', mime: '' }));
      const want = get(r, 'accounts').toLowerCase();
      const account_ids = !want || want === 'all' ? ok.map((a) => a.id)
        : want.split(/[;]+/).map((x) => x.trim()).filter(Boolean).flatMap((w) => ok.filter((a) => a.network === w || a.name.toLowerCase() === w || (a.handle || '').toLowerCase() === w.replace(/^@/, '')).map((a) => a.id));
      return { when: parseWhen(get(r, 'date'), get(r, 'time'), SET.default_time), body: get(r, 'text'), media, link: get(r, 'link'), account_ids: [...new Set(account_ids)], raw: get(r, 'date') + ' ' + get(r, 'time') };
    });
    drawRows();
  }
  const check = (r) => {
    const nets = r.account_ids.map((id) => acct(id)?.network);
    if (!r.when) return `Couldn't read the date or time (${r.raw || 'blank'})`;
    if (r.when < new Date()) return 'That time already passed';
    if (!r.body.trim() && !r.media.length) return 'No text or media';
    if (r.media.some((m) => !/^https:\/\//i.test(m.url))) return 'Media links have to start with https://';
    if (nets.includes('instagram') && !r.media.length) return 'Instagram needs a picture or video';
    if (nets.includes('instagram') && r.body.length > 2200) return 'Too long for Instagram';
    if (r.media.filter((m) => m.kind === 'video').length && r.media.length > 1) return 'One video, or pictures, not both';
    return '';
  };
  function drawRows() {
    const out = $('#sbOut', main);
    if (!rows.length) { out.innerHTML = ''; return; }
    const bad = rows.map(check).filter(Boolean).length;
    out.innerHTML = `<div class="card panel sbatch"><div class="toolbar"><h2 style="flex:1;margin:0">${C.plural(rows.length, 'post', 'posts')}</h2>${bad ? `<span class="badge due">${bad} to fix</span>` : '<span class="badge ok">Ready</span>'}</div>
      <label class="label" for="sbName">Batch name</label><input type="text" id="sbName" value="${esc(new Date().toLocaleDateString([], { month: 'long' }) + ' posts')}" style="max-width:320px">
      <div style="overflow:auto"><table><thead><tr><th>When</th><th>Text</th><th>Media</th><th>To</th><th></th></tr></thead><tbody>
      ${rows.map((r, i) => { const e = check(r); return `<tr class="${e ? 'bad' : ''}"><td style="min-width:150px"><input type="datetime-local" data-w="${i}" value="${r.when ? `${isoDay(r.when)}T${hm(r.when)}` : ''}"></td>
        <td style="min-width:220px"><textarea data-b="${i}">${esc(r.body)}</textarea>${e ? `<div class="err">${esc(e)}</div>` : ''}</td>
        <td>${r.media.map((m) => (m.kind === 'video' ? '▶' : `<img src="${esc(m.url)}" alt="" style="width:40px;height:40px;object-fit:cover;border-radius:6px">`)).join(' ') || '<small class="hint">None</small>'}</td>
        <td>${r.account_ids.map((id) => badge(acct(id)?.network)).join(' ') || '<small class="hint">Draft only</small>'}</td><td><button type="button" class="btn ghost small" data-rmr="${i}" aria-label="Remove">×</button></td></tr>`; }).join('')}
      </tbody></table></div>
      <div class="actions"><button type="button" class="btn small" id="sbGo" ${bad ? 'disabled' : ''}>${SET.require_approval && !SET.can_manage ? 'Send all for approval' : 'Schedule all'}</button><button type="button" class="btn ghost small" id="sbDraft">Save all as drafts</button></div></div>`;
    $$('[data-w]', out).forEach((x) => (x.onchange = () => { rows[x.dataset.w].when = x.value ? new Date(x.value) : null; drawRows(); }));
    $$('[data-b]', out).forEach((x) => (x.onchange = () => { rows[x.dataset.b].body = x.value; drawRows(); }));
    $$('[data-rmr]', out).forEach((x) => (x.onclick = () => { rows.splice(Number(x.dataset.rmr), 1); drawRows(); }));
    const send = async (mode) => {
      const posts = rows.map((r) => ({ body: r.body, media: r.media, link: r.link || '', account_ids: r.account_ids, scheduled_at: r.when ? r.when.toISOString() : null }));
      const { data, error } = await sb.rpc('social_batch_save', { p: { name: $('#sbName', out).value, mode, posts } });
      if (error) return C.fail(error);
      C.toast(`${C.plural(data?.count || posts.length, 'post', 'posts')} ${mode === 'draft' ? 'saved as drafts' : SET.require_approval && !SET.can_manage ? 'sent for approval' : 'scheduled'}`);
      C.go('social', rows[0]?.when ? isoDay(rows[0].when) : null);
    };
    $('#sbGo', out).onclick = () => send('schedule');
    $('#sbDraft', out).onclick = () => send('draft');
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
