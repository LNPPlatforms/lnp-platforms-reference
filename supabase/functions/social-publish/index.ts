// social-publish: sends one copy of a social post (one post to one account). The database's social_tick calls this through
// pg_net with the target id and the shared hook secret, so only the database can start it. verify_jwt is off.
// Facebook Pages: text (with an optional link), one picture, several pictures (uploaded unpublished, then attached) or one video.
// Instagram business accounts: one picture, one video (as a Reel) or a carousel of up to 10. Instagram builds a container
// first; videos take a while, so if it isn't ready we hand back "processing" and the tick checks again in a minute.
// Optional secret: META_GRAPH_VERSION (default v25.0).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const db = createClient(SB_URL, envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const VER = Deno.env.get('META_GRAPH_VERSION') || 'v25.0';
const G = `https://graph.facebook.com/${VER}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class GraphError extends Error { code = 0; status = 0; constructor(m: string, code: number, status: number) { super(m); this.code = code; this.status = status; } }
async function call(method: 'GET' | 'POST', path: string, params: Record<string, unknown>, token: string) {
  const u = new URL(`${G}/${path}`);
  let body: string | undefined;
  if (method === 'GET') { for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v)); u.searchParams.set('access_token', token); }
  else body = JSON.stringify({ ...params, access_token: token });
  const r = await fetch(u, { method, headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined, body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new GraphError(d?.error?.error_user_msg || d?.error?.message || `Meta said ${r.status}`, Number(d?.error?.code || 0), r.status);
  return d;
}
// token problems mean the account has to be connected again; these codes and 5xx are worth another try
const needsReconnect = (e: GraphError) => e.code === 190 || e.code === 102 || e.code === 10 || (e.code >= 200 && e.code < 300);
const worthRetry = (e: GraphError) => e.status >= 500 || [1, 2, 4, 17, 32, 341, 368, 613, 9007].includes(e.code);

type Media = { url: string; kind: 'image' | 'video' };
type Job = { id: string; container_id: string | null; post: { body: string; media: Media[]; link: string | null }; account: { network: string; external_id: string }; token: string };

async function facebook(j: Job) {
  const page = j.account.external_id, t = j.token, msg = j.post.body || '', media = j.post.media || [];
  let postId: string;
  if (media.length === 1 && media[0].kind === 'video') {
    const v = await call('POST', `${page}/videos`, { file_url: media[0].url, description: msg }, t);
    postId = v.id;
    const p = await call('GET', postId, { fields: 'permalink_url' }, t).catch(() => null);
    const pu = String(p?.permalink_url || '');
    return { ok: true, external_id: postId, permalink: pu ? (pu.startsWith('http') ? pu : `https://www.facebook.com${pu}`) : null };
  }
  if (media.length === 1) {
    const ph = await call('POST', `${page}/photos`, { url: media[0].url, caption: msg }, t);
    postId = ph.post_id || ph.id;
  } else if (media.length > 1) {
    const ids: string[] = [];
    for (const m of media) ids.push((await call('POST', `${page}/photos`, { url: m.url, published: false }, t)).id);
    postId = (await call('POST', `${page}/feed`, { message: msg, attached_media: ids.map((id) => ({ media_fbid: id })) }, t)).id;
  } else {
    postId = (await call('POST', `${page}/feed`, { message: msg, ...(j.post.link ? { link: j.post.link } : {}) }, t)).id;
  }
  const p = await call('GET', postId, { fields: 'permalink_url' }, t).catch(() => null);
  return { ok: true, external_id: postId, permalink: p?.permalink_url || null };
}

async function instagram(j: Job) {
  const ig = j.account.external_id, t = j.token, media = j.post.media || [];
  let container = j.container_id;
  if (!container) {
    if (!media.length) throw new GraphError('Instagram needs a picture or video', 0, 400);
    const caption = j.post.body || '';
    if (media.length === 1) {
      const m = media[0];
      container = (await call('POST', `${ig}/media`, m.kind === 'video' ? { media_type: 'REELS', video_url: m.url, caption } : { image_url: m.url, caption }, t)).id;
    } else {
      const kids: string[] = [];
      for (const m of media) {
        const k = await call('POST', `${ig}/media`, m.kind === 'video' ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: true } : { image_url: m.url, is_carousel_item: true }, t);
        kids.push(k.id);
      }
      // carousel items with video need to finish too
      for (let i = 0; i < 6; i++) {
        const st = await Promise.all(kids.map((k) => call('GET', k, { fields: 'status_code' }, t)));
        if (st.some((s) => s.status_code === 'ERROR')) throw new GraphError('Instagram couldn\'t read one of the pictures or videos. Pictures have to be JPEG.', 0, 400);
        if (st.every((s) => !s.status_code || s.status_code === 'FINISHED')) break;
        await sleep(5000);
      }
      container = (await call('POST', `${ig}/media`, { media_type: 'CAROUSEL', children: kids.join(','), caption }, t)).id;
    }
  }
  // wait up to about 30 seconds here, then let the tick check back
  for (let i = 0; i < 6; i++) {
    const st = await call('GET', container!, { fields: 'status_code,status' }, t);
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new GraphError(`Instagram couldn't process it${st.status ? ` (${st.status})` : ''}. Pictures have to be JPEG and videos MP4 or MOV.`, 0, 400);
    if (!st.status_code || st.status_code === 'FINISHED' || st.status_code === 'PUBLISHED') {
      const pub = await call('POST', `${ig}/media_publish`, { creation_id: container }, t);
      const p = await call('GET', pub.id, { fields: 'permalink' }, t).catch(() => null);
      return { ok: true, external_id: pub.id, permalink: p?.permalink || null };
    }
    await sleep(5000);
  }
  return { processing: true, container_id: container };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let id = '', secret = '';
  try { const b = await req.json(); id = String(b.id || ''); secret = String(b.secret || ''); } catch { return json({ error: 'Bad request' }, 400); }
  const { data: j, error } = await db.rpc('social_take', { p_id: id, p_secret: secret });
  if (error) return json({ error: error.message }, 403);
  if (!j) return json({ ok: true, skipped: true });
  let result: Record<string, unknown>;
  try {
    if (!j.token) result = { error: 'This account lost its connection. Connect it again under Social planner, Accounts.', reconnect: true };
    else if (j.account.network === 'facebook') result = await facebook(j as Job);
    else if (j.account.network === 'instagram') result = await instagram(j as Job);
    else result = { error: `${j.account.network} posting isn't switched on yet` };
  } catch (e) {
    const g = e instanceof GraphError ? e : new GraphError(String((e as Error)?.message || e), 0, 500);
    result = { error: g.message, reconnect: needsReconnect(g), retry: !needsReconnect(g) && worthRetry(g) };
  }
  await db.rpc('social_done', { p_id: id, p_secret: secret, p: result });
  return json({ ok: !!result.ok });
});
