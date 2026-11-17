// bid-intake: bids coming in from outside the CRM. verify_jwt is off; every path checks its caller itself.
//   POST ?mode=resend   Resend inbound (email.received webhook). Signature checked with RESEND_WEBHOOK_SECRET (Svix headers),
//                       then the email and its attachments are fetched with RESEND_API_KEY.
//   POST ?mode=raw      the raw email (message/rfc822) from a Cloudflare Email Routing worker (or any relay).
//                       Header x-bid-secret must match BID_INBOUND_SECRET. Header x-bid-to: the address it was sent to.
//   POST ?mode=upload   the public upload page (bid/index.html): multipart form with t (the account's upload link code),
//                       name, email, phone, company, title, due, notes and files.
// The account comes from the address (bids+slug@, slug@) or the upload code. Files go to the private bid-files bucket
// at <account>/<bid>/<file>. Setup steps: BACKLOG.md "Bids: email intake setup".
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import PostalMime from 'npm:postal-mime@2';

function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const db = createClient(Deno.env.get('SUPABASE_URL')!, envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-bid-secret, x-bid-to', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const enc = new TextEncoder();
const MAX_FILES = 15, MAX_FILE = 25 * 1024 * 1024, MAX_TOTAL = 60 * 1024 * 1024;
const safe = (n: string) => (n || 'file').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(-120) || 'file';
const rid = () => crypto.randomUUID().slice(0, 8);
const textOf = (html?: string | null) => (html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
const safeEq = (a: string, b: string) => a.length === b.length && [...a].every((c, i) => c === b[i]);

type BidFile = { name: string; type: string; bytes: Uint8Array };

// Svix (what Resend signs webhooks with): base64 HMAC-SHA256 of "id.timestamp.body" with the secret after whsec_
async function svixOk(req: Request, raw: string) {
  const secret = Deno.env.get('RESEND_WEBHOOK_SECRET') || '';
  const id = req.headers.get('svix-id') || '', ts = req.headers.get('svix-timestamp') || '', sig = req.headers.get('svix-signature') || '';
  if (!secret || !id || !ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${ts}.${raw}`)))));
  return sig.split(' ').some((s) => { const [v, val] = s.split(','); return v === 'v1' && !!val && safeEq(val, mac); });
}

async function store(bid: { bid_id: string; tenant_id: string }, files: BidFile[], source: string) {
  let total = 0, kept = 0;
  for (const f of files.slice(0, MAX_FILES)) {
    if (!f.bytes.length || f.bytes.length > MAX_FILE || (total += f.bytes.length) > MAX_TOTAL) continue;
    const path = `${bid.tenant_id}/${bid.bid_id}/${rid()}-${safe(f.name)}`;
    const { error } = await db.storage.from('bid-files').upload(path, f.bytes, { contentType: f.type || 'application/octet-stream', upsert: false });
    if (error) { console.error('bid file upload', error.message); continue; }
    const { error: e2 } = await db.rpc('bid_intake_file', { p_bid: bid.bid_id, p_path: path, p_name: f.name || 'file', p_size: f.bytes.length, p_mime: f.type || null, p_source: source });
    if (e2) console.error('bid file record', e2.message); else kept++;
  }
  return kept;
}

async function fromEmail(to: string[], from: { address?: string; name?: string } | undefined, subject: string, text: string, files: BidFile[]) {
  const { data, error } = await db.rpc('bid_intake_email', { p: { to, from_email: from?.address || '', from_name: from?.name || '', subject, text: text.slice(0, 100000) } });
  if (error) return json({ error: error.message }, 400);
  if (!data) return json({ ok: true, ignored: 'No account takes bids at that address' });   // 200 so the relay doesn't retry
  const kept = await store(data, files, 'email');
  return json({ ok: true, bid: data.bid_id, files: kept });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const mode = new URL(req.url).searchParams.get('mode') || '';
  try {
    if (mode === 'resend') {
      const raw = await req.text();
      if (!(await svixOk(req, raw))) return json({ error: 'Bad signature' }, 401);
      const ev = JSON.parse(raw);
      if (ev?.type !== 'email.received' || !ev?.data?.email_id) return json({ ok: true, ignored: ev?.type || 'unknown' });
      const key = Deno.env.get('RESEND_API_KEY'); if (!key) return json({ error: 'RESEND_API_KEY missing' }, 500);
      const h = { Authorization: `Bearer ${key}` };
      const em = await (await fetch(`https://api.resend.com/emails/receiving/${ev.data.email_id}`, { headers: h })).json();
      const list = await (await fetch(`https://api.resend.com/emails/receiving/${ev.data.email_id}/attachments`, { headers: h })).json();
      const files: BidFile[] = [];
      for (const a of (list?.data || []).slice(0, MAX_FILES)) {
        if (a.content_disposition === 'inline' && /^image\//.test(a.content_type || '')) continue;   // signature logos and the like
        if (Number(a.size) > MAX_FILE || !a.download_url) continue;
        const r = await fetch(a.download_url); if (!r.ok) continue;
        files.push({ name: a.filename || 'file', type: a.content_type || '', bytes: new Uint8Array(await r.arrayBuffer()) });
      }
      const fromHdr = String(em?.from || ev.data.from || ''); const m = fromHdr.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
      const to = [...(em?.received_for || []), ...(em?.to || ev.data.to || []), ...(em?.cc || [])].map(String);
      return await fromEmail(to, m ? { name: m[1].trim(), address: m[2] } : { address: fromHdr }, String(em?.subject || ev.data.subject || ''), em?.text || textOf(em?.html), files);
    }
    if (mode === 'raw') {
      const secret = Deno.env.get('BID_INBOUND_SECRET') || '';
      if (!secret || !safeEq(req.headers.get('x-bid-secret') || '', secret)) return json({ error: 'Not allowed' }, 401);
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.length > MAX_TOTAL + 5 * 1024 * 1024) return json({ error: 'Too big' }, 413);
      const mail = await PostalMime.parse(buf);
      const to = [req.headers.get('x-bid-to') || '', ...(mail.to || []).map((x: any) => x.address || ''), ...(mail.cc || []).map((x: any) => x.address || '')].filter(Boolean);
      const files: BidFile[] = (mail.attachments || []).filter((a: any) => !(a.disposition === 'inline' && /^image\//.test(a.mimeType || '')))
        .map((a: any) => ({ name: a.filename || 'file', type: a.mimeType || '', bytes: a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content) }));
      return await fromEmail(to, mail.from as any, mail.subject || '', mail.text || textOf(mail.html), files);
    }
    if (mode === 'upload') {
      const form = await req.formData();
      const t = String(form.get('t') || '');
      if (!/^[a-f0-9]{64}$/.test(t)) return json({ error: 'This upload link is missing its code' }, 404);
      const files: BidFile[] = [];
      for (const v of form.getAll('files')) {
        if (typeof v === 'string') continue;
        if (v.size > MAX_FILE) return json({ error: `${v.name} is over 25 MB. Send a smaller copy or a link in the notes.` }, 413);
        files.push({ name: v.name, type: v.type, bytes: new Uint8Array(await v.arrayBuffer()) });
      }
      if (files.length > MAX_FILES) return json({ error: `Send ${MAX_FILES} files or fewer at a time` }, 413);
      const p = Object.fromEntries(['title', 'name', 'email', 'phone', 'company', 'due', 'notes'].map((k) => [k, String(form.get(k) || '').slice(0, 5000)]));
      const { data, error } = await db.rpc('bid_intake_public', { p_token: t, p });
      if (error) return json({ error: error.message }, 400);
      const kept = await store(data, files, 'public');
      return json({ ok: true, files: kept });
    }
    return json({ error: 'Unknown mode' }, 400);
  } catch (e) {
    console.error('bid-intake', e);
    return json({ error: 'Something went wrong taking that in. Try again in a minute.' }, 500);
  }
});
