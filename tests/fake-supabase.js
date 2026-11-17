// A stand-in for supabase-js used only by the UI test: an in-memory database with the query builder the CRM uses.
const uid = () => crypto.randomUUID();
const DB = (window.__DB = window.__DB || {});
const RPC = (window.__RPC = window.__RPC || {});
const LOG = (window.__LOG = []);
const tbl = (t) => (DB[t] ||= []);
const getPath = (row, col) => col.split('.').reduce((a, k) => (a == null ? a : a[k]), row);
function embed(row, sel) {
  // "*, companies(name)" or "companies!fk(name)" or "x:media(url)": attach related rows when present by <name>_id or embed key
  const out = { ...row };
  const re = /(\w+:)?(\w+)(![\w]+)?\(([^()]*(?:\([^()]*\))?[^()]*)\)/g; let m;
  while ((m = re.exec(sel || ''))) {
    const alias = (m[1] || '').replace(':', '') || m[2], t = m[2];
    if (/count/.test(m[4]) && !m[4].includes(',')) { out[alias] = [{ count: 0 }]; continue; }
    const single = t.replace(/s$/, '') + '_id';
    if (row[single] !== undefined) out[alias] = tbl(t).find((r) => r.id === row[single]) || null;
    else if (row.company_id && t === 'companies') out[alias] = tbl('companies').find((r) => r.id === row.company_id) || null;
    else if (t === 'jobs' && row.job_id) out[alias] = tbl('jobs').find((r) => r.id === row.job_id) || null;
    else out[alias] = tbl(t).filter((r) => Object.values(r).includes(row.id));
  }
  return out;
}
class Q {
  constructor(t) { this.t = t; this.f = []; this.op = 'select'; this.one = 0; this.lim = null; this.ord = []; this.headOnly = false; }
  select(s, o) { if (this.op === 'select') this.sel = s; this.retSel = s; if (o?.head) this.headOnly = true; if (o?.count) this.cnt = true; return this; }
  insert(v) { this.op = 'insert'; this.val = v; return this; }
  update(v) { this.op = 'update'; this.val = v; return this; }
  upsert(v) { this.op = 'insert'; this.val = v; return this; }
  delete() { this.op = 'delete'; return this; }
  _f(fn) { this.f.push(fn); return this; }
  eq(c, v) { return this._f((r) => getPath(r, c) === v || (v === true && getPath(r, c) === true)); }
  neq(c, v) { return this._f((r) => getPath(r, c) !== v); }
  is(c, v) { return this._f((r) => (v === null ? getPath(r, c) == null : getPath(r, c) === v)); }
  in(c, v) { return this._f((r) => v.includes(getPath(r, c))); }
  not(c, op, v) { if (op === 'is') return this._f((r) => getPath(r, c) != null); if (op === 'in') { const l = v.replace(/[()]/g, '').split(','); return this._f((r) => !l.includes(getPath(r, c))); } return this; }
  gte(c, v) { return this._f((r) => getPath(r, c) == null || String(getPath(r, c)) >= String(v)); }
  gt(c, v) { return this.gte(c, v); }
  lt(c, v) { return this._f((r) => getPath(r, c) == null || String(getPath(r, c)) < String(v)); }
  lte(c, v) { return this.lt(c, v + 'z'); }
  ilike(c, v) { const s = v.replace(/%/g, '').toLowerCase(); return this._f((r) => String(getPath(r, c) || '').toLowerCase().includes(s)); }
  like(c, v) { return this.ilike(c, v); }
  contains(c, v) { return this._f((r) => (Array.isArray(v) ? v.every((x) => (getPath(r, c) || []).includes(x)) : true)); }
  overlaps() { return this; } or() { return this; } match() { return this; } filter() { return this; } textSearch() { return this; }
  order(c, o) { this.ord.push([c, o?.ascending !== false]); return this; }
  limit(n) { this.lim = n; return this; } range(a, b) { this.lim = b - a + 1; return this; }
  single() { this.one = 1; return this; } maybeSingle() { this.one = 2; return this; }
  then(ok, no) { return Promise.resolve().then(() => this.run()).then(ok, no); }
  run() {
    LOG.push([this.op, this.t]);
    const rows = tbl(this.t);
    const match = rows.filter((r) => this.f.every((fn) => fn(r)));
    let data;
    if (this.op === 'insert') {
      const vals = (Array.isArray(this.val) ? this.val : [this.val]).map((v) => ({ id: uid(), created_at: new Date().toISOString(), tenant_id: 'T1', ...(window.__DEFAULTS?.[this.t] || {}), ...v }));
      rows.push(...vals); data = vals.map((v) => embed(v, this.retSel));
    } else if (this.op === 'update') { match.forEach((r) => Object.assign(r, this.val)); data = match.map((r) => embed(r, this.retSel)); }
    else if (this.op === 'delete') { DB[this.t] = rows.filter((r) => !match.includes(r)); data = match; }
    else {
      data = match.slice();
      this.ord.slice().reverse().forEach(([c, asc]) => data.sort((a, b) => (String(a[c] ?? '') < String(b[c] ?? '') ? -1 : String(a[c] ?? '') > String(b[c] ?? '') ? 1 : 0) * (asc ? 1 : -1)));
      if (this.lim) data = data.slice(0, this.lim);
      data = data.map((r) => embed(r, this.sel));
    }
    const count = match.length;
    if (this.headOnly) return { data: null, count, error: null };
    if (this.one) { if (!data.length && this.one === 1) return { data: null, error: { message: 'No rows' } }; return { data: data[0] || null, error: null, count }; }
    return { data, error: null, count };
  }
}
const session = { access_token: 'x', user: { id: 'U1', email: 'admin@test.local' }, expires_at: 9e9 };
export function createClient() {
  return {
    from: (t) => new Q(t),
    rpc: (name, args) => ({ then: (ok, no) => Promise.resolve().then(() => { LOG.push(['rpc', name, args]); const h = RPC[name]; try { return { data: h ? h(args || {}) : null, error: h ? null : null }; } catch (e) { return { data: null, error: { message: e.message } }; } }).then(ok, no) }),
    auth: {
      getSession: async () => ({ data: { session } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({}),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' } }), listFactors: async () => ({ data: { totp: [], all: [] } }),
        enroll: async () => ({ data: { id: 'F1', totp: { qr_code: 'data:image/svg+xml;base64,PHN2Zy8+', secret: 'ABC' } } }), challengeAndVerify: async () => ({ error: null }), unenroll: async () => ({}) },
      updateUser: async () => ({}),
    },
    storage: { from: () => ({ upload: async (p, f) => { (window.__UPLOADS ||= []).push(f); return { data: { path: p }, error: null }; }, createSignedUrls: async (ps) => ({ data: ps.map((p) => ({ path: p, signedUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' })) }),
      getPublicUrl: (p) => ({ data: { publicUrl: '/x/' + p } }), createSignedUrl: async (p) => { LOG.push(['signedUrl', p]); return { data: { signedUrl: window.__SIGNED_URL || '#' } }; } }) },
    functions: { invoke: async (n, o) => { LOG.push(['fn', n, o?.body]); const h = window.__FN?.[n]; return h ? { data: h(o?.body || {}), error: null } : { data: null, error: null }; } },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
  };
}
