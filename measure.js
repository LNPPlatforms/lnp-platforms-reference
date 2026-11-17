/* measure.js: the measuring tool. Draw on a satellite map for square feet (areas, with cutouts that subtract) and
   linear feet (striping, curbs), tap to count things (parking spaces, light poles, signs) with tap states and add-ons,
   save the drawing as a picture, and price it from the account's price book into an invoice or a proposal.
   Decisions: BACKLOG.md "Oct 30 morning voice decisions", Measuring bullet. Free pieces only: Leaflet from a CDN,
   Esri World Imagery tiles and OpenStreetMap Nominatim for address search (one request per search). Area and length
   are figured here (spherical polygon area and haversine), the same way Google's map geometry does it.
   Plugs into app.js through init(ctx) like grow.js and docs.js. */
import * as FLD from './field.js?v=20261116t';
import { money } from './doc/layout.js?v=20261116t';

let C = null, sb, S, esc, $, $$;
export function init(ctx) { C = ctx; ({ sb, S, esc, $, $$ } = ctx); }
const can = (a, l = 1) => FLD.can(a, l);
export const on = () => FLD.feat('measure');
export const canSee = () => on() && (can('proposals', 1) || can('invoices', 1));
export const canMeasure = () => on() && can('proposals', 2);
export const canSetup = () => on() && (C.isAdmin() || can('settings', 4));

/* ================= the math (exported for tests/measure_math_test.mjs) ================= */
const R = 6378137;                       // meters, the sphere Google and OpenLayers use
export const SQFT_PER_M2 = 10.763910417;
export const FT_PER_M = 3.280839895;
const rad = (d) => (d * Math.PI) / 180;
const openRing = (ring) => (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring);
// area of one ring of [lng, lat] points, square meters (Chamberlain and Duquette, "Some algorithms for polygons on a sphere")
export function ringArea(ring) {
  const pts = openRing(ring || []); const n = pts.length; if (n < 3) return 0;
  let t = 0;
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; t += rad(b[0] - a[0]) * (2 + Math.sin(rad(a[1])) + Math.sin(rad(b[1]))); }
  return Math.abs((t * R * R) / 2);
}
// a polygon: the outside ring less every cutout
export const polygonArea = (rings) => Math.max(0, ringArea(rings?.[0]) - (rings || []).slice(1).reduce((a, r) => a + ringArea(r), 0));
export function haversine(a, b) {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
export const lineLength = (pts) => (pts || []).reduce((a, p, i) => (i ? a + haversine(pts[i - 1], p) : 0), 0);
export function pointInRing(pt, ring) {
  let inside = false; const r = openRing(ring || []);
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export const featureSqft = (f) => polygonArea(f.geometry.coordinates) * SQFT_PER_M2;
export const featureFt = (f) => lineLength(f.geometry.coordinates) * FT_PER_M;
const stateKey = (t, f) => (t.states || []).some((s) => s.key === f.properties.state) ? f.properties.state : t.states?.[0]?.key || 'count';

// what everything on the map adds up to, by item type: { [type id]: { name, kind, qty, states: { key: n } } }
export function totals(features, types) {
  const out = {};
  (features || []).forEach((f) => {
    const t = types.find((x) => x.id === f.properties?.type_id); if (!t) return;
    const o = (out[t.id] ||= { name: t.name, kind: t.kind, qty: 0, states: {} });
    if (t.kind === 'area' && f.geometry.type === 'Polygon') o.qty += featureSqft(f);
    else if (t.kind === 'length' && f.geometry.type === 'LineString') o.qty += featureFt(f);
    else if (t.kind === 'count' && f.geometry.type === 'Point') { o.qty += 1; const k = stateKey(t, f); o.states[k] = (o.states[k] || 0) + 1; }
  });
  Object.values(out).forEach((o) => (o.qty = Math.round(o.qty)));
  return out;
}
const n0 = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const plural = (name, n) => (n === 1 || /s$/i.test(name) ? name : name + 's');
// "12,400 sq ft paved area · 820 ft striping · 12 light poles, 3 moved"
export function summary(tot, types) {
  return types.filter((t) => tot[t.id]?.qty).map((t) => {
    const o = tot[t.id];
    if (t.kind === 'area') return `${n0(o.qty)} sq ft ${t.name.toLowerCase()}`;
    if (t.kind === 'length') return `${n0(o.qty)} ft ${t.name.toLowerCase()}`;
    const extra = (t.states || []).slice(1).filter((s) => o.states[s.key]).map((s) => `${o.states[s.key]} ${s.short || s.name.toLowerCase()}`);
    return [`${o.qty} ${plural(t.name.toLowerCase(), o.qty)}`, ...extra].join(', ');
  }).join(' · ');
}
export const UNIT = { sq_ft: 'sq ft', ln_ft: 'ft', each: 'each' };
// $0.225 stays $0.225 (per foot prices often have more than two places); $650 stays $650.00
export const unitPrice = (p) => (Math.round(Number(p) * 100) === Number(p) * 100 ? money(p) : '$' + Number(p).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }));
// price lines from the price book: each type's price item, plus each tap state's add-ons. Same item twice adds up on one line.
export function priceLines(tot, types, items) {
  const acc = new Map();
  const add = (itemId, fallback, qty, note) => {
    if (!qty) return;
    const it = items.find((i) => i.id === itemId);
    const key = it ? it.id : 'none:' + fallback;
    const row = acc.get(key) || { item_id: it?.id || null, name: it?.name || fallback, code: it?.code || '', unit: it?.unit || 'each', price: Number(it?.price || 0), qty: 0, notes: [], missing: !it };
    row.qty += qty; row.notes.push(note); acc.set(key, row);
  };
  types.forEach((t) => {
    const o = tot[t.id]; if (!o?.qty) return;
    if (t.kind !== 'count') return add(t.price_item_id, t.name, o.qty, `${n0(o.qty)} ${t.kind === 'area' ? 'sq ft' : 'ft'} of ${t.name.toLowerCase()} measured`);
    (t.states || []).forEach((s, i) => {
      const k = o.states[s.key] || 0; if (!k) return;
      const what = i === 0 ? `${k} ${plural(t.name.toLowerCase(), k)}` : `${k} ${plural(t.name.toLowerCase(), k)} ${s.short || s.name.toLowerCase()}`;
      if (s.base !== false) add(t.price_item_id, t.name, k, what);
      (s.addons || []).forEach((a) => add(a, 'Add-on', k, `for ${what}`));
    });
  });
  return [...acc.values()].map((l) => ({ ...l, desc: l.notes.join('; '), total: Math.round(l.qty * l.price * 100) / 100 }));
}

/* ================= navigation pieces ================= */
export const drawerItems = () => ({
  admin: [{ id: 'measuresetup', label: 'Measuring', match: ['measuresetup'], what: 'What your team measures and counts, tap colors, add-ons and their prices', when: () => canSetup() }],
});
export const views = () => ({ measuresetup: viewSetup });
export const parents = { measuresetup: 'tools' };
export const guards = { measuresetup: () => canSetup() };

/* ================= shared data ================= */
async function loadBook(seed = true) {
  const [{ data: types, error }, { data: items }] = await Promise.all([
    sb.from('measure_types').select('*').is('archived_at', null).order('sort').order('created_at'),
    sb.from('price_items').select('*').order('sort').order('created_at'),
  ]);
  if (error) return null;
  if (!(types || []).length && seed && canMeasure()) { const { error: e } = await sb.rpc('measure_seed'); if (!e) return loadBook(false); }
  return { types: (types || []).map((t) => ({ ...t, states: t.kind === 'count' && !(t.states || []).length ? [{ key: 'count', name: 'Counted', short: '', color: t.color, base: true, addons: [] }] : t.states || [] })), items: items || [] };
}
const unitOf = (k) => (k === 'area' ? 'sq_ft' : k === 'length' ? 'ln_ft' : 'each');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)));
let cssOn = false;
function css() {
  if (cssOn) return; cssOn = true;
  const s = document.createElement('style');
  s.textContent = `
dialog.mdlg{width:100vw;height:100vh;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:#fff;display:none}
dialog.mdlg[open]{display:flex;flex-direction:column}
.mtop{display:flex;gap:6px;align-items:center;padding:8px;flex-wrap:wrap;border-bottom:1px solid var(--line)}
.mtop input{flex:1;min-width:120px;margin:0}.mtop .mfind{display:flex;gap:6px;flex:2;min-width:220px}
.mmap{flex:1;min-height:200px;position:relative;background:#dfe3ea}
.mhint{padding:6px 10px;font-size:13px;color:var(--muted);background:#f6f8fb;border-top:1px solid var(--line)}
.mtools{display:flex;gap:6px;overflow-x:auto;padding:8px;border-top:1px solid var(--line);-webkit-overflow-scrolling:touch}
.mtools button,.mact button,.mfoot button{min-height:44px;white-space:nowrap}
.mtool{display:flex;align-items:center;gap:6px;border:2px solid var(--line);background:#fff;border-radius:10px;padding:6px 12px;font:inherit;cursor:pointer}
.mtool.on{border-color:#1d2433;background:#eef2f8;font-weight:700}
.mtool i{width:16px;height:16px;border-radius:4px;display:inline-block;flex:none}
.mtool small{color:var(--muted)}
.mact{display:flex;gap:6px;padding:0 8px 8px;flex-wrap:wrap}
.mfoot{display:flex;gap:6px;align-items:center;padding:8px;border-top:1px solid var(--line);flex-wrap:wrap;padding-bottom:max(8px,env(safe-area-inset-bottom))}
.mfoot .msum{flex:1;min-width:160px;font-size:14px}
.mlabel{background:rgba(255,255,255,.92)!important;border:0!important;box-shadow:0 1px 3px rgba(0,0,0,.3)!important;font-weight:700;font-size:12px;padding:1px 6px!important;color:#1d2433}
.mprice{position:absolute;inset:0;background:#fff;z-index:1000;overflow:auto;padding:14px;padding-bottom:max(14px,env(safe-area-inset-bottom))}
.mprice table{width:100%;border-collapse:collapse}.mprice td,.mprice th{padding:7px 4px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.mprice .num{text-align:right;white-space:nowrap}.mprice .warn{color:#B4412C;font-size:12px}
.mstate{display:grid;grid-template-columns:1fr 110px 54px;gap:6px;align-items:center;padding:6px 0;border-top:1px dashed var(--line)}
.mstate .adds{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px 12px;font-size:13px}
.pbrow{display:grid;grid-template-columns:2fr 140px 100px 100px 80px;gap:6px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)}
.pbrow input,.pbrow select{margin:0}.pbrow .pbdesc{grid-column:1/-1}.pbhead{font-size:12px;color:var(--muted);border:0;padding:0}
@media (max-width:640px){.pbrow{grid-template-columns:1fr 1fr}.pbrow input[data-pk=name]{grid-column:1/-1}.pbhead{display:none}}
.mthumb{width:64px;height:48px;object-fit:cover;border-radius:6px;flex:none;background:#eef1f6}
@media (max-width:640px){.mtop .mfind{min-width:100%}.mstate{grid-template-columns:1fr 1fr}}`;
  document.head.appendChild(s);
}

/* ================= Leaflet, from the CDN when first needed ================= */
const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/';
let LP = null;
function leaflet() {
  if (window.L?.map) return Promise.resolve(window.L);
  LP ||= new Promise((ok, no) => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = LEAFLET + 'leaflet.css'; l.crossOrigin = ''; document.head.appendChild(l);
    const s = document.createElement('script'); s.src = LEAFLET + 'leaflet.js'; s.crossOrigin = '';
    s.onload = () => (window.L?.map ? ok(window.L) : no(new Error('The map didn\'t load')));
    s.onerror = () => { LP = null; no(new Error('The map didn\'t load. Check the connection and try again.')); };
    document.head.appendChild(s);
  });
  return LP;
}
const TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TILE_CREDIT = 'Imagery &copy; Esri, Maxar, Earthstar Geographics and the GIS User Community';
const SEARCH_CREDIT = 'Search &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

// one Nominatim request per search (their usage policy: no autocomplete, credit shown)
export async function geocode(q) {
  const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(q), { referrerPolicy: 'strict-origin-when-cross-origin', headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('Address search is busy. Try again in a minute.');
  const d = await r.json();
  return d?.[0] ? { lat: Number(d[0].lat), lng: Number(d[0].lon) } : null;
}

/* ================= the tool =================
   open({ company, id, target, address }): target 'invoice', 'proposal' or 'bid' when opened from inside one (resolves with the lines
   to add), or nothing from the organization page (the push choices show in the price panel). Resolves null when closed. */
export function open(opts = {}) {
  css();
  return new Promise((resolve) => tool(opts, resolve).catch((e) => { C.fail(e); resolve(null); }));
}

async function tool({ company, id, target, address }, resolve) {
  const book = await loadBook();
  if (!book) { C.toast('Measuring needs the October 30 database update. Once it\'s applied, it works.', { error: true }); return resolve(null); }
  const { types, items } = book;
  let rec = { id: null, name: '', address: '', shapes: { type: 'FeatureCollection', features: [] }, view: {}, company_id: company?.id || null };
  if (id) {
    const { data, error } = await sb.from('measurements').select('*').eq('id', id).maybeSingle();
    if (error) throw error; if (!data) { C.toast('That measurement isn\'t here anymore'); return resolve(null); }
    rec = data;
  }
  const addr = rec.address || address || [company?.address, company?.city, [company?.state, company?.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  let feats = JSON.parse(JSON.stringify(rec.shapes?.features || []));
  let tool = null;          // a type id, 'cutout' or null (look around and pick a shape)
  let draft = [];           // [lat, lng] points of the shape being drawn
  let sel = -1;             // the picked shape
  let dirty = false, done = false, skipClick = false;
  const hist = [];
  const T = (tid) => types.find((t) => t.id === tid);
  const cur = () => (tool && tool !== 'cutout' ? T(tool) : null);
  const drawKind = () => (tool === 'cutout' ? 'area' : cur()?.kind);
  const edit = canMeasure();

  let d = $('#measureDlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'measureDlg'; d.className = 'mdlg'; document.body.appendChild(d); }
  const groups = [['area', 'Areas'], ['length', 'Lengths'], ['count', 'Counts']];
  d.innerHTML = `<div class="mtop">
      <input type="text" id="mName" maxlength="120" placeholder="Name it, like Front lot" value="${esc(rec.name === 'Measurement' ? '' : rec.name || '')}" aria-label="Measurement name" ${edit ? '' : 'disabled'}>
      <form class="mfind" id="mFind"><input type="search" id="mAddr" placeholder="Address" value="${esc(addr)}" aria-label="Address"><button class="btn secondary small" type="submit">Find</button>
        <button class="btn ghost small" type="button" id="mHere" title="Go to where I am">Here</button></form>
      <button class="btn ghost small" type="button" id="mClose">Close</button></div>
    <div class="mmap" id="mMap"><p class="empty" style="padding:20px">Loading the map…</p></div>
    <div class="mhint" id="mHint"></div>
    ${edit ? `<div class="mtools" id="mTools">${groups.map(([k]) => types.filter((t) => t.kind === k).map((t) => `<button type="button" class="mtool" data-tool="${t.id}"><i style="background:${esc(t.color)}"></i>${esc(t.name)} <small data-q="${t.id}"></small></button>`).join('')).join('')}
      <button type="button" class="mtool" data-tool="cutout"><i style="background:#fff;border:2px dashed #1d2433"></i>Cutout</button></div>
    <div class="mact"><button type="button" class="btn secondary small" id="mUndo">Undo</button><button type="button" class="btn small" id="mDone" hidden>Finish shape</button>
      <button type="button" class="btn ghost small danger" id="mDel" hidden>Remove this shape</button><button type="button" class="btn ghost small" id="mPan">Just look around</button></div>` : ''}
    <div class="mfoot"><span class="msum" id="mSum"></span>${edit ? `<button class="btn secondary" id="mSave">Save</button>` : ''}
      <button class="btn" id="mPrice">${target === 'invoice' ? 'Price it for the invoice' : target === 'proposal' ? 'Price it for the proposal' : target === 'bid' ? 'Price it for the bid' : 'Price it'}</button></div>`;
  d.showModal();
  const finish = (val) => { if (done) return; done = true; try { map?.remove(); } catch {} d.close(); resolve(val); };
  d.oncancel = (e) => { e.preventDefault(); close(); };
  const close = () => { if (dirty && edit && !confirm('Close without saving? Your drawing since the last save goes away.')) return; finish(null); };
  $('#mClose', d).onclick = close;
  addEventListener('hashchange', () => finish(null), { once: true });

  let L, map, layer, tiles;
  try { L = await leaflet(); } catch (e) { $('#mMap', d).innerHTML = `<p class="empty" style="padding:20px">${esc(e.message)}</p>`; return; }
  $('#mMap', d).innerHTML = '';
  map = L.map($('#mMap', d), { maxZoom: 21, zoomControl: true, attributionControl: true });
  tiles = L.tileLayer(TILES, { maxZoom: 21, maxNativeZoom: 19, attribution: TILE_CREDIT, crossOrigin: 'anonymous' }).addTo(map);
  map.attributionControl.addAttribution(SEARCH_CREDIT);
  L.control.scale({ imperial: true, metric: false }).addTo(map);
  layer = L.layerGroup().addTo(map);
  const v = rec.view || {};
  if (v.lat != null && v.lng != null) map.setView([v.lat, v.lng], v.zoom || 19);
  else if (feats.length) map.fitBounds(bounds(), { padding: [30, 30], maxZoom: 20 });
  else map.setView([39.5, -98.35], 4);
  setTimeout(() => map.invalidateSize(), 50);
  if (!id && addr && !(v.lat != null)) find(addr);

  function bounds() {
    const pts = [];
    feats.forEach((f) => { const g = f.geometry; (g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.coordinates[0]).forEach((c) => pts.push([c[1], c[0]])); });
    return L.latLngBounds(pts);
  }
  async function find(q) {
    if (!q.trim()) return;
    try { const r = await geocode(q.trim()); if (!r) return C.toast('Couldn\'t find that address. Try adding the city and state.'); map.setView([r.lat, r.lng], 19); }
    catch (e) { C.toast(e.message || 'Address search didn\'t answer', { error: true }); }
  }
  $('#mFind', d).onsubmit = (e) => { e.preventDefault(); find($('#mAddr', d).value); };
  $('#mHere', d).onclick = () => navigator.geolocation?.getCurrentPosition((p) => map.setView([p.coords.latitude, p.coords.longitude], 19), () => C.toast('Couldn\'t get your location'), { enableHighAccuracy: true, timeout: 10000 });

  const snap = () => { hist.push(JSON.stringify(feats)); if (hist.length > 60) hist.shift(); dirty = true; };
  const hint = () => {
    const t = cur();
    $('#mHint', d).textContent = !edit ? 'You can look but your role can\'t change measurements.'
      : tool === 'cutout' ? 'Tap around an island or building inside an area. Finish (or tap the first point) and it comes out of that area.'
      : !t ? 'Pick what you\'re measuring below, then tap the map. Tap a shape to pick it.'
      : t.kind === 'area' ? `Tap each corner of the ${t.name.toLowerCase()}. Tap the first point or Finish to close it.`
      : t.kind === 'length' ? `Tap along the ${t.name.toLowerCase()}. Finish when you're at the end.`
      : `Tap each ${t.name.toLowerCase()} to count it.${t.states.length > 1 ? ` Tap one again to mark it ${t.states.slice(1).map((s) => s.name.toLowerCase()).join(', then ')}.` : ''} Tap again after that to take it off.`;
  };
  function draw() {
    layer.clearLayers();
    feats.forEach((f, i) => {
      const t = T(f.properties.type_id); const color = t?.color || '#64748B'; const g = f.geometry;
      let lyr;
      if (g.type === 'Polygon') {
        lyr = L.polygon(g.coordinates.map((r) => openRing(r).map((c) => [c[1], c[0]])), { color, weight: i === sel ? 5 : 2, dashArray: i === sel ? '6 4' : null, fillColor: color, fillOpacity: 0.25 });
        lyr.bindTooltip(`${n0(featureSqft(f))} sq ft`, { permanent: true, direction: 'center', className: 'mlabel' });
      } else if (g.type === 'LineString') {
        lyr = L.polyline(g.coordinates.map((c) => [c[1], c[0]]), { color, weight: i === sel ? 7 : 4, dashArray: i === sel ? '8 6' : null });
        lyr.bindTooltip(`${n0(featureFt(f))} ft`, { permanent: true, direction: 'center', className: 'mlabel' });
      } else {
        const st = t?.states?.find((s) => s.key === f.properties.state) || t?.states?.[0];
        lyr = L.circleMarker([g.coordinates[1], g.coordinates[0]], { radius: 10, color: '#fff', weight: 2, fillColor: st?.color || color, fillOpacity: 1, bubblingMouseEvents: false });
        lyr.on('click', () => tapCount(i));
      }
      if (g.type !== 'Point') lyr.on('click', () => { if (!edit || tool) return; skipClick = true; sel = sel === i ? -1 : i; draw(); });
      lyr.addTo(layer);
    });
    if (draft.length) {
      const kc = tool === 'cutout' ? '#1d2433' : cur()?.color || '#1d2433';
      if (drawKind() === 'area' && draft.length > 2) L.polygon(draft, { color: kc, weight: 2, dashArray: '5 5', fillOpacity: tool === 'cutout' ? 0 : 0.15, fillColor: kc, interactive: false }).addTo(layer);
      else L.polyline(draft, { color: kc, weight: 3, dashArray: '5 5', interactive: false }).addTo(layer);
      draft.forEach((p, j) => L.circleMarker(p, { radius: j === 0 ? 8 : 5, color: kc, weight: 2, fillColor: '#fff', fillOpacity: 1, bubblingMouseEvents: false })
        .on('click', () => (j === 0 && drawKind() === 'area' && draft.length > 2 ? closeShape() : addPt(p))).addTo(layer));
    }
    const tot = totals(feats, types);
    $('#mSum', d).textContent = summary(tot, types) || 'Nothing measured yet';
    $$('[data-q]', d).forEach((s) => { const o = tot[s.dataset.q]; const t = T(s.dataset.q); s.textContent = !o?.qty ? '' : t.kind === 'area' ? n0(o.qty) + ' sq ft' : t.kind === 'length' ? n0(o.qty) + ' ft' : String(o.qty); });
    $$('[data-tool]', d).forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
    if ($('#mDone', d)) { $('#mDone', d).hidden = !draft.length; $('#mDone', d).disabled = draft.length < (drawKind() === 'area' ? 3 : 2); }
    if ($('#mDel', d)) $('#mDel', d).hidden = sel < 0;
    hint();
  }
  function addPt(p) { draft.push([p[0] ?? p.lat, p[1] ?? p.lng]); draw(); }
  function closeShape() {
    const k = drawKind(); if (draft.length < (k === 'area' ? 3 : 2)) return;
    const coords = draft.map((p) => [p[1], p[0]]);
    if (tool === 'cutout') {
      const mid = [coords.reduce((a, c) => a + c[0], 0) / coords.length, coords.reduce((a, c) => a + c[1], 0) / coords.length];
      const host = [...feats].reverse().find((f) => f.geometry.type === 'Polygon' && pointInRing(mid, f.geometry.coordinates[0]));
      if (!host) { C.toast('Draw the cutout inside an area so it knows what to take it out of'); return; }
      snap(); host.geometry.coordinates.push([...coords, coords[0]]);
    } else if (k === 'area') { snap(); feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...coords, coords[0]]] }, properties: { kind: 'area', type_id: tool } }); }
    else { snap(); feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { kind: 'length', type_id: tool } }); }
    draft = []; draw();
  }
  function tapCount(i) {
    if (!edit) return;
    const f = feats[i]; const t = T(f.properties.type_id);
    if (draft.length) return addPt([f.geometry.coordinates[1], f.geometry.coordinates[0]]);
    snap();
    const at = (t?.states || []).findIndex((s) => s.key === f.properties.state);
    const next = (at < 0 ? 0 : at) + 1;
    if (!t || next >= t.states.length) { feats.splice(i, 1); C.toast('Taken off'); }
    else f.properties.state = t.states[next].key;
    sel = -1; draw();
  }
  map.on('click', (e) => {
    if (skipClick) { skipClick = false; return; }
    if (!edit) return;
    const p = [e.latlng.lat, e.latlng.lng];
    const t = cur();
    if (!tool) { if (sel >= 0) { sel = -1; draw(); } return; }
    if (t?.kind === 'count') { snap(); feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p[1], p[0]] }, properties: { kind: 'count', type_id: t.id, state: t.states[0].key } }); draw(); return; }
    if (drawKind() === 'area' && draft.length > 2) {
      const a = map.latLngToContainerPoint(draft[0]), b = map.latLngToContainerPoint(p);
      if (Math.hypot(a.x - b.x, a.y - b.y) < 18) return closeShape();
    }
    addPt(p);
  });
  if (edit) {
    $$('[data-tool]', d).forEach((b) => (b.onclick = () => {
      if (draft.length && !confirm('Drop the shape you\'re drawing?')) return;
      draft = []; sel = -1; tool = tool === b.dataset.tool ? null : b.dataset.tool; draw();
    }));
    $('#mPan', d).onclick = () => { draft = []; tool = null; draw(); };
    $('#mDone', d).onclick = closeShape;
    $('#mUndo', d).onclick = () => { if (draft.length) { draft.pop(); return draw(); } if (!hist.length) return C.toast('Nothing to undo'); feats = JSON.parse(hist.pop()); sel = -1; draw(); };
    $('#mDel', d).onclick = () => { if (sel < 0) return; snap(); feats.splice(sel, 1); sel = -1; draw(); };
  }
  draw();

  /* ---------- the picture ---------- */
  const waitTiles = () => new Promise((ok) => { let n = 0; const tick = () => (!tiles.isLoading?.() || ++n > 30 ? ok() : setTimeout(tick, 100)); setTimeout(tick, 150); });
  function shapesOn(ctx, project, scale) {
    const labels = [];
    feats.forEach((f) => {
      const t = T(f.properties.type_id); const color = t?.color || '#64748B'; const g = f.geometry;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      if (g.type === 'Polygon') {
        ctx.beginPath();
        g.coordinates.forEach((r) => { openRing(r).forEach((c, j) => { const p = project(c); if (j) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }); ctx.closePath(); });
        ctx.fillStyle = color + '55'; ctx.fill('evenodd'); ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
        const o = openRing(g.coordinates[0]); const pts = o.map(project);
        labels.push([pts.reduce((a, p) => a + p.x, 0) / pts.length, pts.reduce((a, p) => a + p.y, 0) / pts.length, `${t?.name || 'Area'}: ${n0(featureSqft(f))} sq ft`]);
      } else if (g.type === 'LineString') {
        ctx.beginPath(); g.coordinates.forEach((c, j) => { const p = project(c); j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
        ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.stroke();
        const m = Math.floor((g.coordinates.length - 1) / 2); const a = project(g.coordinates[m]), b = project(g.coordinates[m + 1] || g.coordinates[m]);
        labels.push([(a.x + b.x) / 2, (a.y + b.y) / 2, `${n0(featureFt(f))} ft`]);
      } else {
        const st = t?.states?.find((s) => s.key === f.properties.state) || t?.states?.[0]; const p = project(g.coordinates);
        ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.fillStyle = st?.color || color; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      }
    });
    ctx.font = 'bold 13px -apple-system,Segoe UI,Roboto,Arial,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    labels.forEach(([x, y, s]) => { const w = ctx.measureText(s).width + 12; ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fillRect(x - w / 2, y - 10, w, 20); ctx.fillStyle = '#1d2433'; ctx.fillText(s, x, y); });
    // scale bar and the legend strip
    const W = ctx.canvas.width / 2, H = ctx.canvas.height / 2;
    const ftPerPx = scale * FT_PER_M;
    const nice = [5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].find((ft) => ft / ftPerPx >= 70) || 10000;
    const px = nice / ftPerPx;
    ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fillRect(10, H - 74, px + 70, 26);
    ctx.fillStyle = '#1d2433'; ctx.fillRect(16, H - 58, px, 4); ctx.fillRect(16, H - 66, 2, 12); ctx.fillRect(16 + px - 2, H - 66, 2, 12);
    ctx.textAlign = 'left'; ctx.font = '12px -apple-system,Segoe UI,Roboto,Arial,sans-serif'; ctx.fillText(`${n0(nice)} ft`, 22 + px, H - 58);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, H - 40, W, 40);
    ctx.fillStyle = '#1d2433'; ctx.font = 'bold 13px -apple-system,Segoe UI,Roboto,Arial,sans-serif';
    const line = [$('#mName', d).value.trim(), summary(totals(feats, types), types)].filter(Boolean).join(': ');
    ctx.fillText(line.length > 140 ? line.slice(0, 137) + '...' : line, 10, H - 20);
  }
  function satCanvas() {
    const size = map.getSize(); const box = $('#mMap', d).getBoundingClientRect();
    const cv = document.createElement('canvas'); cv.width = size.x * 2; cv.height = size.y * 2;
    const ctx = cv.getContext('2d'); ctx.scale(2, 2);
    const imgs = $$('.leaflet-tile-pane img', d).filter((i) => i.complete && i.naturalWidth);
    if (!imgs.length) throw new Error('no tiles');
    imgs.forEach((i) => { const r = i.getBoundingClientRect(); ctx.drawImage(i, r.left - box.left, r.top - box.top, r.width, r.height); });
    const c = map.getCenter();
    shapesOn(ctx, (ll) => map.latLngToContainerPoint([ll[1], ll[0]]), (40075016.686 * Math.cos(rad(c.lat))) / 2 ** (map.getZoom() + 8));
    ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.font = '10px Arial'; ctx.textAlign = 'right'; ctx.fillText('Imagery © Esri, Maxar, Earthstar Geographics', size.x - 6, size.y - 46);
    return cv;
  }
  // when the imagery can't be copied (CORS), the shapes on a plain background, to scale, with labels
  function plainCanvas() {
    const W = 1200, H = 800, pad = 50;
    const cv = document.createElement('canvas'); cv.width = W * 2; cv.height = H * 2;
    const ctx = cv.getContext('2d'); ctx.scale(2, 2);
    ctx.fillStyle = '#F8FAFC'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#E5E9F0'; ctx.lineWidth = 1; for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); } for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    const b = bounds(); const sw = b.getSouthWest(), ne = b.getNorthEast();
    const k = Math.cos(rad((sw.lat + ne.lat) / 2));
    const dx = Math.max((ne.lng - sw.lng) * k, 0.0004), dy = Math.max(ne.lat - sw.lat, 0.0004);
    const s = Math.min((W - pad * 2) / dx, (H - pad * 2 - 50) / dy);
    const midLng = (sw.lng + ne.lng) / 2, midLat = (sw.lat + ne.lat) / 2;
    const project = (c) => ({ x: W / 2 + (c[0] - midLng) * k * s, y: (H - 50) / 2 - (c[1] - midLat) * s });
    shapesOn(ctx, project, (2 * Math.PI * R) / 360 / s);
    ctx.fillStyle = '#1d2433'; ctx.font = 'bold 14px Arial'; ctx.textAlign = 'center'; ctx.fillText('N ↑', W - 30, 24);
    return cv;
  }
  const blobOf = (cv, type) => new Promise((ok, no) => { try { cv.toBlob((x) => (x ? ok(x) : no(new Error('no picture'))), type, 0.86); } catch (e) { no(e); } });
  async function picture() {
    if (!feats.length) return null;
    map.fitBounds(bounds(), { padding: [40, 40], maxZoom: 20, animate: false });
    await waitTiles();
    try { return { blob: await blobOf(satCanvas(), 'image/jpeg'), ext: 'jpg', type: 'image/jpeg' }; }
    catch { return { blob: await blobOf(plainCanvas(), 'image/png'), ext: 'png', type: 'image/png' }; }
  }

  /* ---------- saving ---------- */
  async function save(quiet) {
    if (!edit) return rec;
    if (!feats.length) { C.toast('Draw or count something first'); return null; }
    if (draft.length) closeShape();
    const btn = $('#mSave', d); if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const mid = rec.id || uid();
      const name = $('#mName', d).value.trim() || 'Measurement';
      let url = rec.picture_url || null;
      if (dirty || !url) {
        const pic = await picture().catch(() => null);
        if (pic) {
          const path = `${S.acct?.id || S.me?.tenant_id}/measurements/${mid}/map-${Date.now()}.${pic.ext}`;
          const up = await sb.storage.from('media').upload(path, pic.blob, { contentType: pic.type, upsert: false });
          if (up.error) C.toast('Saved, but the picture didn\'t upload: ' + up.error.message, { error: true });
          else {
            url = sb.storage.from('media').getPublicUrl(path).data.publicUrl;
            await sb.from('media').insert({ path, url, kind: 'photo', entity: 'measurements', entity_id: mid, title: name + ' map', mime: pic.type, bytes: pic.blob.size });
          }
        }
      }
      const tot = totals(feats, types);
      const c = map.getCenter();
      const row = { name, address: $('#mAddr', d).value.trim() || null, shapes: { type: 'FeatureCollection', features: feats }, totals: { types: tot }, summary: summary(tot, types).slice(0, 1000),
        picture_url: url, view: { lat: c.lat, lng: c.lng, zoom: map.getZoom() } };
      const res = rec.id ? await sb.from('measurements').update(row).eq('id', rec.id).select('*').single()
        : await sb.from('measurements').insert({ ...row, id: mid, company_id: rec.company_id }).select('*').single();
      if (res.error) { C.fail(res.error); return null; }
      rec = res.data; dirty = false;
      if (!quiet) C.toast('Saved');
      return rec;
    } finally { if (btn) { btn.disabled = false; btn.textContent = 'Save'; } }
  }
  if ($('#mSave', d)) $('#mSave', d).onclick = () => save();

  /* ---------- pricing and where it goes ---------- */
  $('#mPrice', d).onclick = async () => {
    const r = edit ? await save(true) : rec; if (!r) return;
    const lines = priceLines(totals(feats, types), types, items);
    const picture = r.picture_url ? { url: r.picture_url, title: r.name, measurement_id: r.id } : null;
    const total = lines.reduce((a, l) => a + l.total, 0);
    const box = document.createElement('div'); box.className = 'mprice';
    const gelp = S.acct?.is_gelp !== false;
    const [{ data: drafts }, { data: props }] = !target && r.company_id ? await Promise.all([
      can('invoices', 2) ? sb.from('invoices').select('id,number').eq('company_id', r.company_id).eq('status', 'draft').order('number', { ascending: false }).limit(5) : { data: [] },
      gelp && can('proposals', 2) ? sb.from('proposals').select('id,version,updated_at').eq('company_id', r.company_id).eq('status', 'draft').order('updated_at', { ascending: false }).limit(5) : { data: [] },
    ]) : [{ data: [] }, { data: [] }];
    box.innerHTML = `<div class="toolbar"><h2 style="flex:1;margin:0">${esc(r.name)}</h2><button class="btn ghost small" data-back>Back to the map</button></div>
      <p class="hint">${esc(r.summary || summary(totals(feats, types), types))}</p>
      ${r.picture_url ? `<img src="${esc(r.picture_url)}" alt="The measured map" style="max-width:100%;max-height:260px;border-radius:8px;display:block;margin:8px 0">` : ''}
      <table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th></tr></thead><tbody>
      ${lines.map((l) => `<tr><td><b>${esc(l.name)}</b><div class="hint" style="margin:0">${esc(l.desc)}</div>${l.missing ? '<div class="warn">No price book item set for this. Pick one in Measuring setup.</div>' : !l.price ? '<div class="warn">No price yet</div>' : ''}</td>
        <td class="num">${esc(n0(l.qty))} ${esc(UNIT[l.unit])}</td><td class="num">${esc(unitPrice(l.price))}</td><td class="num">${esc(money(l.total))}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nothing to price yet.</td></tr>'}
      </tbody></table>
      <p style="text-align:right;font-size:17px"><b>Total ${esc(money(total))}</b></p>
      ${canSetup() ? '<p class="hint">Prices come from Tools, Admin, Measuring.</p>' : ''}
      <div class="actions" id="mGo">${target ? `<button class="btn" data-go="back">Add these to the ${target === 'invoice' ? 'invoice' : target === 'bid' ? 'bid' : esc(FLD.l('proposal'))}</button>` : `
        ${can('invoices', 2) && r.company_id ? '<button class="btn" data-go="newinv">Make an invoice</button>' : ''}
        ${(drafts || []).map((i) => `<button class="btn secondary" data-go="inv:${i.id}">Add to draft invoice ${esc(i.number)}</button>`).join('')}
        ${(props || []).map((p) => `<button class="btn secondary" data-go="prop:${p.id}">Add to the ${esc(FLD.l('proposal'))} draft (${esc(C.fmtDate(p.updated_at))})</button>`).join('')}
        ${!r.company_id ? '<p class="hint">Open this from an organization to put it on an invoice.</p>' : ''}`}</div>`;
    d.appendChild(box);
    $('[data-back]', box).onclick = () => box.remove();
    const result = () => ({ measurement: r, lines: lines.map((l) => ({ code: l.code || '', name: l.name, desc: [r.name, l.desc].filter(Boolean).join(': '), qty: l.qty, price: l.price })), picture,
      custom: lines.map((l) => ({ id: Math.random().toString(36).slice(2, 10), ph: 1, name: l.name, desc: `${n0(l.qty)} ${UNIT[l.unit]} at ${unitPrice(l.price)}. ${l.desc}`, note: '',
        setup: (Math.round(l.total * 100) / 100).toFixed(2), setup_cost: '', amt: '', cost: '', every: 'month' })),
      mockup: picture ? { type: 'image', url: picture.url, title: r.name + ' map', measure: true } : null });
    const used = (kind, rid) => sb.from('measurements').update({ used_on: [...(r.used_on || []), { kind, id: rid, at: new Date().toISOString() }] }).eq('id', r.id);
    $$('[data-go]', box).forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      const res = result(); const g = b.dataset.go;
      try {
        if (g === 'back') { finish(res); return; }
        const set = (await sb.rpc('doc_settings_get')).data || {};
        const tax = Number(set.default_tax_rate) || 0;
        const invLines = res.lines.map((l) => ({ ...l, tax }));
        if (g === 'newinv') {
          const { data, error } = await sb.from('invoices').insert({ company_id: r.company_id, lines: invLines, pictures: picture ? [picture] : [] }).select('id').single();
          if (error) throw error;
          await used('invoice', data.id); finish(null); C.toast('Invoice made. Check it, then send it.'); C.go('invoice', data.id); return;
        }
        if (g.startsWith('inv:')) {
          const iid = g.slice(4);
          const { data: inv, error } = await sb.from('invoices').select('id,lines,pictures').eq('id', iid).single(); if (error) throw error;
          const { error: e2 } = await sb.from('invoices').update({ lines: [...(inv.lines || []), ...invLines], pictures: [...(inv.pictures || []), ...(picture ? [picture] : [])] }).eq('id', iid);
          if (e2) throw e2;
          await used('invoice', iid); finish(null); C.toast('Added to the invoice'); C.go('invoice', iid); return;
        }
        if (g.startsWith('prop:')) {
          const pid = g.slice(5);
          const { data: p, error } = await sb.from('proposals').select('id,items,status').eq('id', pid).single(); if (error) throw error;
          if (p.status !== 'draft') throw new Error('That proposal was sent. Make a new version first.');
          const it = p.items || {};
          const { error: e2 } = await sb.from('proposals').update({ items: { ...it, custom: [...(it.custom || []), ...res.custom], mockups: [...(it.mockups || []), ...(res.mockup ? [res.mockup] : [])] } }).eq('id', pid);
          if (e2) throw e2;
          await used('proposal', pid); finish(null); C.toast(`Added to the ${FLD.l('proposal')}`); C.go('proposal', pid);
        }
      } catch (e) { b.disabled = false; C.fail(e); }
    }));
  };
}
// the invoice or proposal editor calls this once the lines it took are saved there
export async function markUsed(kind, rid, mid) {
  if (!mid || !rid) return;
  const { data } = await sb.from('measurements').select('used_on').eq('id', mid).maybeSingle();
  if (data) await sb.from('measurements').update({ used_on: [...(data.used_on || []), { kind, id: rid, at: new Date().toISOString() }] }).eq('id', mid);
}

/* ================= on the organization (location) page ================= */
export async function orgBox(box, c) {
  if (!box || !canSee()) return;
  css();
  const { data, error } = await sb.from('measurements').select('id,name,summary,picture_url,updated_at').eq('company_id', c.id).is('archived_at', null).order('updated_at', { ascending: false }).limit(20);
  if (error) return;
  box.innerHTML = `<div class="card"><div class="toolbar" style="margin:0"><h2 style="flex:1;margin:0">Measurements</h2>${canMeasure() ? '<button class="btn small" id="omNew">Measure</button>' : ''}</div>
    <div class="list" style="margin-top:8px">${(data || []).map((m) => `<div class="listrow"><button class="item" data-om="${m.id}" style="flex:1;display:flex;gap:10px;align-items:center;text-align:left">
        ${m.picture_url ? `<img class="mthumb" src="${esc(m.picture_url)}" alt="">` : '<span class="mthumb"></span>'}<span><b>${esc(m.name)}</b><small style="display:block">${esc(m.summary || 'Nothing measured')} · ${esc(C.fmtDate(m.updated_at))}</small></span></button>
        ${canMeasure() ? `<button class="btn ghost small" data-omx="${m.id}" aria-label="Archive">Archive</button>` : ''}</div>`).join('')
      || `<p class="empty" style="margin:0">Nothing measured here yet.${canMeasure() ? ' Tap Measure to draw on the satellite map.' : ''}</p>`}</div></div>`;
  const reload = () => orgBox(box, c);
  if ($('#omNew', box)) $('#omNew', box).onclick = async () => { await open({ company: c }); reload(); };
  $$('[data-om]', box).forEach((b) => (b.onclick = async () => { await open({ company: c, id: b.dataset.om }); reload(); }));
  $$('[data-omx]', box).forEach((b) => (b.onclick = async () => {
    if (!confirm('Archive this measurement? It stops showing here. Invoices and proposals that used it keep their lines and picture.')) return;
    const { error: e } = await sb.from('measurements').update({ archived_at: new Date().toISOString() }).eq('id', b.dataset.omx);
    if (e) return C.fail(e); reload();
  }));
}

/* ================= Tools > Admin > Measuring ================= */
async function viewSetup(main) {
  css();
  const book = await loadBook();
  if (!book) { main.innerHTML = '<h1>Measuring</h1><p class="empty">This screen needs the October 30 database update. Once it\'s applied, it works.</p>'; return; }
  const items = book.items.filter((i) => !i.archived_at);
  const types = book.types;
  const unitOpts = (cur) => Object.entries(UNIT).map(([k, n]) => `<option value="${k}" ${cur === k ? 'selected' : ''}>${k === 'sq_ft' ? 'per sq ft' : k === 'ln_ft' ? 'per linear ft' : 'each'}</option>`).join('');
  const itemOpts = (cur, unit) => `<option value="">No price</option>${items.map((i) => `<option value="${i.id}" ${cur === i.id ? 'selected' : ''}>${esc(i.name)} (${esc(unitPrice(i.price))} ${esc(UNIT[i.unit])})${unit && i.unit !== unit ? ' *' : ''}</option>`).join('')}`;
  const pbRow = (i) => `<div class="pbrow" data-pi="${i.id || 'new'}"><input type="text" data-pk="name" value="${esc(i.name || '')}" maxlength="120" placeholder="Name, like Crack fill" aria-label="Name">
      <select data-pk="unit" aria-label="Unit">${unitOpts(i.unit || 'each')}</select><input type="text" data-pk="price" inputmode="decimal" value="${i.id ? esc(Number(i.price)) : ''}" placeholder="0.00" aria-label="Price">
      <input type="text" data-pk="code" value="${esc(i.code || '')}" maxlength="40" placeholder="Code" aria-label="Code">${i.id ? `<button type="button" class="btn ghost small danger" data-piarch="${i.id}">Archive</button>` : '<span></span>'}
      <input type="text" class="pbdesc" data-pk="description" value="${esc(i.description || '')}" maxlength="2000" placeholder="Description the customer sees (optional)" aria-label="Description"></div>`;
  const stateRow = (t, s, j) => `<div class="mstate" data-st="${j}">
      <input type="text" data-sk="name" value="${esc(s.name)}" maxlength="40" placeholder="${j ? 'Remove or relocate' : 'Counted'}" aria-label="Tap ${j + 1} name">
      <input type="text" data-sk="short" value="${esc(s.short || '')}" maxlength="20" placeholder="${j ? 'moved' : 'short word'}" aria-label="Short word in totals">
      <input type="color" data-sk="color" value="${esc(s.color)}" aria-label="Tap ${j + 1} color">
      <div class="adds"><label><input type="checkbox" data-sk="base" ${s.base !== false ? 'checked' : ''}> Charge the main price</label>
        ${items.map((i) => `<label><input type="checkbox" data-add="${i.id}" ${(s.addons || []).includes(i.id) ? 'checked' : ''}> + ${esc(i.name)}</label>`).join('')}
        ${j ? `<button type="button" class="btn ghost small danger" data-strm="${j}">Take this tap off</button>` : ''}</div></div>`;
  const typeCard = (t) => `<div class="card" data-type="${t.id || 'new'}">
      <div class="row"><div><label class="label">Name</label><input type="text" data-tk="name" value="${esc(t.name)}" maxlength="60" placeholder="Light pole"></div>
        <div><label class="label">What it is</label>${t.id ? `<input type="text" value="${esc({ area: 'An area (square feet)', length: 'A length (linear feet)', count: 'A count (tap to count)' }[t.kind])}" disabled>`
          : `<select data-tk="kind"><option value="area">An area (square feet)</option><option value="length">A length (linear feet)</option><option value="count" ${t.kind === 'count' ? 'selected' : ''}>A count (tap to count)</option></select>`}</div></div>
      <div class="row"><div><label class="label">Price from the price book</label><select data-tk="price_item_id">${itemOpts(t.price_item_id, unitOf(t.kind))}</select></div>
        ${t.kind !== 'count' ? `<div><label class="label">Color</label><input type="color" data-tk="color" value="${esc(t.color)}"></div>` : ''}</div>
      ${t.kind === 'count' ? `<h3>Taps</h3><p class="hint" style="margin:0">The first tap counts it. Each tap after that switches it to the next one, and the last tap takes it off. A switched one can skip the main price and add add-ons, like saw cut and patch.</p>
        <div data-states>${(t.states || []).map((s, j) => stateRow(t, s, j)).join('')}</div>
        ${(t.states || []).length < 6 ? '<button type="button" class="btn ghost small" data-stadd>+ Add a tap</button>' : ''}` : ''}
      <div class="actions"><button type="button" class="btn small" data-tsave>Save</button>${t.id ? '<button type="button" class="btn ghost small danger" data-tarch>Archive</button>' : ''}</div></div>`;
  main.innerHTML = `<h1>Measuring</h1>
    <p class="hint">What your team measures on the satellite map and counts by tapping, and the prices that turn it into invoice and proposal lines. A * in a price list means its unit doesn't match.</p>
    <div class="card"><h2>Price book</h2>
      <div class="pbrow pbhead"><span>Name</span><span>Unit</span><span>Price</span><span>Code</span><span></span></div>
      <div id="pbList">${items.map((i) => pbRow(i)).join('') || '<p class="empty">No prices yet.</p>'}</div>
      <div class="actions"><button type="button" class="btn secondary small" id="pbAdd">+ Add a price</button><button type="button" class="btn small" id="pbSave">Save the price book</button></div></div>
    <h2 class="section">What you measure</h2>
    ${types.length ? '' : '<p class="empty">Nothing set up yet. <button type="button" class="btn small" id="msSeed">Start with the basics</button></p>'}
    <div id="mtList">${types.map(typeCard).join('')}</div>
    <div class="actions"><button type="button" class="btn secondary" id="mtAdd">+ Add something to measure</button></div>`;
  const reload = () => viewSetup(main);
  if ($('#msSeed')) $('#msSeed').onclick = async () => { const { error } = await sb.rpc('measure_seed'); if (error) return C.fail(error); reload(); };
  $('#pbAdd').onclick = () => {
    const n = document.createElement('div'); n.innerHTML = pbRow({}); const div = n.firstElementChild;
    $('#pbList').querySelector('.empty')?.remove(); $('#pbList').appendChild(div); $('[data-pk="name"]', div).focus();
  };
  $('#pbSave').onclick = async () => {
    for (const r of $$('[data-pi]', main)) {
      const v = Object.fromEntries($$('[data-pk]', r).map((x) => [x.dataset.pk, x.value.trim()]));
      if (r.dataset.pi === 'new' && !v.name) continue;
      if (!v.name) return C.toast('Every price needs a name');
      const price = Number(v.price || 0); if (!(price >= 0)) return C.toast(`Check the price on ${v.name}`);
      const row = { name: v.name, description: v.description, unit: v.unit, price, code: v.code };
      const old = items.find((i) => i.id === r.dataset.pi);
      if (old && old.name === row.name && (old.description || '') === row.description && old.unit === row.unit && Number(old.price) === price && (old.code || '') === row.code) continue;
      const { error } = r.dataset.pi === 'new' ? await sb.from('price_items').insert({ ...row, sort: items.length + 1 }) : await sb.from('price_items').update(row).eq('id', r.dataset.pi);
      if (error) return C.fail(error);
    }
    C.toast('Price book saved'); reload();
  };
  $$('[data-piarch]', main).forEach((b) => (b.onclick = async () => {
    if (types.some((t) => t.price_item_id === b.dataset.piarch || t.states.some((s) => (s.addons || []).includes(b.dataset.piarch))) && !confirm('Something you measure uses this price. Archive it anyway? Those lines will still price at the old amount.')) return;
    const { error } = await sb.from('price_items').update({ archived_at: new Date().toISOString() }).eq('id', b.dataset.piarch); if (error) return C.fail(error); reload();
  }));
  const bindType = (card, t) => {
    const readStates = () => $$('[data-st]', card).map((r, j) => ({ key: t.states[j]?.key || ('s' + Date.now().toString(36) + j).slice(0, 20), name: $('[data-sk="name"]', r).value.trim(), short: $('[data-sk="short"]', r).value.trim(),
      color: $('[data-sk="color"]', r).value, base: $('[data-sk="base"]', r).checked, addons: $$('[data-add]', r).filter((x) => x.checked).map((x) => x.dataset.add) }));
    const rerender = () => { const n = document.createElement('div'); n.innerHTML = typeCard(t); const c2 = n.firstElementChild; card.replaceWith(c2); bindType(c2, t); };
    if ($('[data-tk="kind"]', card)) $('[data-tk="kind"]', card).onchange = (e) => { t.kind = e.target.value; t.name = $('[data-tk="name"]', card).value; t.states = t.kind === 'count' ? [{ key: 'count', name: 'Counted', short: '', color: t.color, base: true, addons: [] }] : []; rerender(); };
    if ($('[data-stadd]', card)) $('[data-stadd]', card).onclick = () => { t.name = $('[data-tk="name"]', card).value; t.price_item_id = $('[data-tk="price_item_id"]', card).value || null; t.states = [...readStates(), { key: 's' + Date.now().toString(36), name: 'Remove or relocate', short: 'moved', color: '#DC2626', base: false, addons: [] }]; rerender(); };
    $$('[data-strm]', card).forEach((b) => (b.onclick = () => { t.states = readStates(); t.states.splice(Number(b.dataset.strm), 1); rerender(); }));
    $('[data-tsave]', card).onclick = async () => {
      const row = { name: $('[data-tk="name"]', card).value.trim(), price_item_id: $('[data-tk="price_item_id"]', card).value || null };
      if (!row.name) return C.toast('Give it a name');
      if (t.kind === 'count') { row.states = readStates(); if (row.states.some((s) => !s.name)) return C.toast('Every tap needs a name'); row.color = row.states[0].color; }
      else row.color = $('[data-tk="color"]', card).value;
      const { error } = t.id ? await sb.from('measure_types').update(row).eq('id', t.id) : await sb.from('measure_types').insert({ ...row, kind: t.kind, sort: types.length + 1 });
      if (error) return C.fail(error); C.toast('Saved'); reload();
    };
    if ($('[data-tarch]', card)) $('[data-tarch]', card).onclick = async () => {
      if (!confirm(`Archive ${t.name}? It leaves the measuring tool. Saved measurements that used it stop counting it.`)) return;
      const { error } = await sb.from('measure_types').update({ archived_at: new Date().toISOString() }).eq('id', t.id); if (error) return C.fail(error); reload();
    };
  };
  $$('[data-type]', main).forEach((card) => bindType(card, types.find((t) => t.id === card.dataset.type)));
  $('#mtAdd').onclick = () => {
    const t = { id: null, name: '', kind: 'area', color: '#2563EB', price_item_id: null, states: [] };
    const n = document.createElement('div'); n.innerHTML = typeCard(t); const card = n.firstElementChild; $('#mtList').appendChild(card); bindType(card, t); $('[data-tk="name"]', card).focus();
  };
}
