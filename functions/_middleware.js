// Site hosting by web address: a request for a domain in sites/hosts.js is answered from that site's folder, so one
// Pages project serves the app and every public site. Everything else (the app, proposals, portals) passes through.
// Each site may keep a simple _redirects file (from, to, optional status per line); exact paths only.
import SITES from '../sites/hosts.js';
import { brandFor } from '../brandhost.js';

const RULES = new Map();
async function rulesFor(ctx, dir, origin) {
  if (RULES.has(dir)) return RULES.get(dir);
  const out = new Map();
  try {
    const r = await ctx.env.ASSETS.fetch(new Request(`${origin}/sites/${dir}/_redirects`));
    if (r.ok) for (const line of (await r.text()).split('\n')) {
      const [from, to, code] = line.trim().split(/\s+/);
      if (from && to && !from.startsWith('#')) out.set(from, { to, code: Number(code) || 302 });
    }
  } catch { /* no rules */ }
  RULES.set(dir, out);
  return out;
}

// the app's own page at a white label's address: its name and color from the first byte, so nothing says LNP while
// the app loads, in the browser tab or when someone adds it to their home screen (iPhone reads the page, not the manifest)
async function brandedApp(ctx) {
  const res = await ctx.next();
  if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
  const b = await brandFor(ctx.request);
  if (!b) return res;
  const name = String(b.name || '').slice(0, 60), short = String(b.short_name || b.name || '').slice(0, 30);
  const color = /^#[0-9a-f]{6}$/i.test(b.primary_color || '') ? b.primary_color : null;
  return new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(name); } })
    .on('meta[name="apple-mobile-web-app-title"]', { element(e) { e.setAttribute('content', short); } })
    .on('meta[name="theme-color"]', { element(e) { if (color) e.setAttribute('content', color); } })
    .transform(res);
}

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  const dir = SITES[url.hostname.toLowerCase().replace(/^www\./, '')];
  if (!dir) return url.pathname === '/' || url.pathname === '/index.html' ? brandedApp(ctx) : ctx.next();
  const rule = (await rulesFor(ctx, dir, url.origin)).get(url.pathname);
  if (rule) return Response.redirect(new URL(rule.to, url).toString(), rule.code);
  if (/(^|\/)(_redirects|README\.md)$/i.test(url.pathname)) return new Response('Not found', { status: 404 });
  const base = `/sites/${dir}`;
  const target = new URL(base + url.pathname + url.search, url.origin);
  const res = await ctx.env.ASSETS.fetch(new Request(target.toString(), ctx.request));
  // Pages tidies addresses (adds a slash, drops .html); keep those redirects on the site's own paths
  const loc = res.headers.get('Location');
  if (res.status >= 300 && res.status < 400 && loc) {
    const l = new URL(loc, url.origin);
    if (l.pathname.startsWith(base)) {
      const h = new Headers(res.headers); h.set('Location', l.pathname.slice(base.length) + l.search || '/');
      return new Response(null, { status: res.status, headers: h });
    }
  }
  return res;
}
