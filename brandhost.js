/* brandhost.js: used by functions/ (Cloudflare Pages) to give each web address its own app name and icons.
   app.gelpstrategies.com installs as GELP, app.getcoastcustomers.com as GCC, and so on; a domain with no white label
   (or with no icon set yet) falls back to the files in this folder (LNP Platforms). Brand data: brand_for_host (081b). */
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export async function brandFor(request) {
  const host = new URL(request.url).hostname;
  if (/^localhost$|^127\.|\.pages\.dev$/.test(host)) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/brand_for_host`, {
      method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_host: host }), cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!r.ok) return null;
    const b = await r.json();
    return b && b.name ? b : null;
  } catch { return null; }
}

// an icon path: send the agency's own icon when it has one, otherwise the default file
export function iconHandler(key) {
  return async (ctx) => {
    const b = await brandFor(ctx.request);
    const url = b && /^https:\/\//.test(b[key] || '') ? b[key] : null;
    if (!url) return ctx.next();
    return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'public, max-age=300' } });
  };
}
