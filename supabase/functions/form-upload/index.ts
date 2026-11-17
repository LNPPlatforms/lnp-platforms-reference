// form-upload: public file uploads for website forms (the intake page at cognixcrm.com/start/ and any other form page).
// verify_jwt is off. The caller must send an active site form key; files land in the form's account:
//   storage: media/<account>/intake/<yyyy-mm-dd>/<batch>/<rand>-<file>
//   media library: one row per file, folder "Intake: <company>", so staff see them in Media and can move them
//   to the client's own account later.
// POST multipart/form-data: k (form key), batch (client id for one submission), company, section, files (1..n)
// Returns { ok, files: [{ name, url, section }] }
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const db = createClient(Deno.env.get('SUPABASE_URL')!, envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, apikey, authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const MAX_FILES = 20, MAX_FILE = 25 * 1024 * 1024, MAX_TOTAL = 100 * 1024 * 1024;
const OK_EXT = /\.(png|jpe?g|gif|webp|heic|heif|svg|ai|eps|psd|pdf|zip|ttf|otf|woff2?|xlsx?|xlsm|csv|docx?|txt|pptx?)$/i;
const SECTIONS = new Set(['brand_kit', 'logo', 'photos', 'products', 'redirects', 'reviews', 'other']);
const safe = (n: string) => (n || 'file').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(-120) || 'file';
const rid = () => crypto.randomUUID().slice(0, 8);
const kindOf = (section: string, mime: string, name: string) =>
  section === 'brand_kit' || section === 'logo' ? 'logo' : /^image\//.test(mime) || /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(name) ? 'photo' : 'file';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const form = await req.formData();
    const key = String(form.get('k') || '');
    const batch = String(form.get('batch') || '').replace(/[^\w-]/g, '').slice(0, 40) || rid();
    const section = SECTIONS.has(String(form.get('section'))) ? String(form.get('section')) : 'other';
    const company = String(form.get('company') || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    if (!/^[a-f0-9]{20,64}$/i.test(key)) return json({ error: 'This form is not available' }, 404);
    const { data: f } = await db.from('site_forms').select('id, tenant_id, name').eq('form_key', key).eq('active', true).maybeSingle();
    if (!f) return json({ error: 'This form is not available' }, 404);

    const files = form.getAll('files').filter((v): v is File => typeof v !== 'string');
    if (!files.length) return json({ error: 'No files' }, 400);
    if (files.length > MAX_FILES) return json({ error: `Upload ${MAX_FILES} files or fewer at a time` }, 413);
    let total = 0;
    for (const v of files) {
      if (v.size > MAX_FILE) return json({ error: `${v.name} is over 25 MB. Share a link to it instead.` }, 413);
      if (!OK_EXT.test(v.name)) return json({ error: `${v.name} isn't a file type we take here. Share a link to it instead.` }, 415);
      total += v.size;
    }
    if (total > MAX_TOTAL) return json({ error: 'Those files are too big together. Upload fewer at a time or share a link.' }, 413);

    const day = new Date().toISOString().slice(0, 10);
    const out: { name: string; url: string; section: string }[] = [];
    for (const v of files) {
      const path = `${f.tenant_id}/intake/${day}/${batch}/${rid()}-${safe(v.name)}`;
      const mime = v.type || 'application/octet-stream';
      const { error } = await db.storage.from('media').upload(path, new Uint8Array(await v.arrayBuffer()), { contentType: mime, upsert: false });
      if (error) { console.error('form-upload storage', error.message); return json({ error: `Couldn't save ${v.name}. Try again.` }, 500); }
      const url = db.storage.from('media').getPublicUrl(path).data.publicUrl;
      const { error: e2 } = await db.from('media').insert({
        tenant_id: f.tenant_id, bucket: 'media', path, url, kind: kindOf(section, mime, v.name),
        title: `${v.name} (${section.replace('_', ' ')})`, mime, bytes: v.size, created_by: null,
        folder: company ? `Intake: ${company}` : 'Intake',
      });
      if (e2) console.error('form-upload media row', e2.message);
      out.push({ name: v.name, url, section });
    }
    return json({ ok: true, files: out });
  } catch (e) {
    console.error('form-upload', e);
    return json({ error: 'Something went wrong with the upload. Try again in a minute.' }, 500);
  }
});
