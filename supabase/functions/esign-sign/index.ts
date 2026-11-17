// esign-sign: the public signing page (/sign/?t=...). Deploy with verify_jwt off: signers have no login. Every action
// carries the signer's link code (t), and the database only ever opens that signer's place on that one envelope.
// This function adds who's calling (IP, user agent, device, browser) to every step for the event log, hands out
// short-lived links to the PDF, emails the one-time code, and finishes the envelope when the last person signs.
//   { action: 'view', t }                                  the document, this signer's fields and where they are
//   { action: 'consent', t }                               agreed to do business electronically
//   { action: 'code', t, channel? }                        email a 6 digit code (channel 'sms' is the seam for later)
//   { action: 'check', t, code }                           check it; gives a signing session
//   { action: 'submit', t, session, vals, signature, initials, kind }
//   { action: 'decline', t, reason }
import { admin, baseUrl, BUCKET, cors, emailCode, emailDeclined, emailInvites, finish, json, meta } from '../_shared/esign.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const body = await req.json();
    const t = String(body.t || '');
    if (!/^[a-f0-9]{64}$/.test(t)) return json({ error: 'This signing link isn\'t right. Check the email you were sent.' }, 400);
    const db = admin(), who = meta(req);
    const call = async (fn: string, args: Record<string, unknown>) => {
      const { data, error } = await db.rpc(fn, args);
      if (error) throw Object.assign(new Error(error.message), { status: 400 });
      return data;
    };
    switch (body.action) {
      case 'view': {
        const v = await call('esign_sign_view', { p_token: t, p_meta: who });
        if (!v) return json({ error: 'This signing link isn\'t right, or the document was taken back.' }, 404);
        if (v.file_path) v.url = (await db.storage.from(BUCKET).createSignedUrl(v.file_path, 1800)).data?.signedUrl || null;
        if (v.final_path) v.final_url = (await db.storage.from(BUCKET).createSignedUrl(v.final_path, 3600, { download: `signed-${v.file_name || 'document.pdf'}` })).data?.signedUrl || null;
        delete v.file_path; delete v.final_path;
        return json(v);
      }
      case 'consent':
        return json(await call('esign_sign_consent', { p_token: t, p_meta: who }));
      case 'code': {
        const c = await call('esign_sign_code', { p_token: t, p_meta: who, p_channel: body.channel || 'email' });
        await emailCode(c.mail, c.email, c.name, c.code, c.minutes);
        return json({ ok: true, to: String(c.email).replace(/^(.).*?(@.*)$/, '$1***$2'), minutes: c.minutes });
      }
      case 'check':
        return json(await call('esign_sign_check', { p_token: t, p_code: String(body.code || ''), p_meta: who }));
      case 'submit': {
        const r = await call('esign_sign_submit', { p_token: t, p_session: String(body.session || ''), p_vals: body.vals || {},
          p_signature: body.signature || null, p_initials: body.initials || null, p_sig_kind: body.kind || null, p_meta: who });
        const base = baseUrl(req, r.mail);
        if (r.next?.length) await emailInvites(r.mail, r.next, base, 'invite');
        let finished = false, problem = '';
        if (r.all_signed) {
          try { await finish(db, r.envelope_id, base); finished = true; } catch (e) { problem = (e as Error).message; console.error('esign finish', problem); }
        }
        return json({ ok: true, all_signed: r.all_signed, finished, problem: problem || undefined });
      }
      case 'decline': {
        const r = await call('esign_sign_decline', { p_token: t, p_reason: String(body.reason || ''), p_meta: who });
        try { await emailDeclined(r.mail, r.name, r.reason, baseUrl(req, r.mail)); } catch (e) { console.error('esign decline email', (e as Error).message); }
        return json({ ok: true });
      }
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    const err = e as Error & { status?: number };
    return json({ error: String(err?.message || e) }, err.status || 500);
  }
});
