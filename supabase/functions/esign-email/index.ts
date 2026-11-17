// esign-email: the team's e-sign actions that send email. Called from the CRM with the person's own login, so the
// database checks their role and account on every step.
//   { action: 'send', id }               lock the PDF (SHA-256 of the stored file), mark it sent, email whoever's turn it is
//   { action: 'remind', id, signer? }    email the people whose turn it is again (or one of them)
//   { action: 'finish', id }             everyone signed but the signed copy didn't get made: try again
// Secrets: RESEND_API_KEY (already set). Optional SEND_DOMAIN and APP_URL. See _shared/esign.ts.
import { admin, asUser, baseUrl, BUCKET, cors, emailInvites, finish, json } from '../_shared/esign.ts';
import { sha256Hex } from '../_shared/esign_pdf.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { action, id, signer } = await req.json();
    if (!id) return json({ error: 'Missing the document' }, 400);
    const me = asUser(req), db = admin();
    if (action === 'send') {
      const { data: prep, error } = await me.rpc('esign_send_prepare', { p_id: id });
      if (error) return json({ error: error.message }, 400);
      const { data: file, error: e1 } = await db.storage.from(BUCKET).download(prep.file_path);
      if (e1 || !file) return json({ error: 'The PDF is missing. Upload it again.' }, 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') return json({ error: 'That file isn\'t a PDF' }, 400);
      const sha = await sha256Hex(bytes);
      const { data: sent, error: e2 } = await db.rpc('esign_send_commit', { p_id: id, p_sha: sha, p_by: prep.by });
      if (e2) return json({ error: e2.message }, 400);
      const r = await emailInvites(sent.mail, sent.to, baseUrl(req, sent.mail), 'invite');
      return json({ ok: true, sha, emailed: r.sent, failed: r.failed });
    }
    if (action === 'remind') {
      const { data, error } = await me.rpc('esign_remind', { p_id: id, p_signer: signer || null });
      if (error) return json({ error: error.message }, 400);
      const r = await emailInvites(data.mail, data.to, baseUrl(req, data.mail), 'reminder');
      if (!r.sent) return json({ error: r.failed.join('; ') || 'Nothing went out' }, 502);
      return json({ ok: true, emailed: r.sent, failed: r.failed });
    }
    if (action === 'finish') {
      const { error } = await me.rpc('esign_finish_check', { p_id: id });
      if (error) return json({ error: error.message }, 400);
      return json(await finish(db, id, baseUrl(req)));
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
