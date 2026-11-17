// /manifest.json: the installed app's name, colors and icons follow the web address's white label (see brandhost.js)
import { brandFor } from '../brandhost.js';

export async function onRequest(ctx) {
  const b = await brandFor(ctx.request);
  if (!b) return ctx.next();
  const ok = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
  const icon = (u, size, purpose, fallback) => ({ src: /^https:\/\//.test(u || '') ? u : fallback, sizes: size, type: 'image/png', purpose });
  const m = {
    name: b.name, short_name: b.short_name || b.name, id: '/', start_url: '/', scope: '/', display: 'standalone',
    background_color: ok(b.background_color) ? b.background_color : '#F4F6FA', theme_color: ok(b.primary_color) ? b.primary_color : '#1A2A52',
    icons: [icon(b.icon_192_url, '192x192', 'any', 'icon-192.png'), icon(b.icon_512_url, '512x512', 'any', 'icon-512.png'),
      icon(b.icon_maskable_url, '512x512', 'maskable', 'icon-maskable-512.png')],
  };
  return new Response(JSON.stringify(m, null, 2), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=300' } });
}
