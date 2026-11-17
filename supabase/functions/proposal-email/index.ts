// proposal-email: sends proposal emails through Resend.
//   kind "sent":     called by the CRM right after Send. Caller must be the proposal's closer or an admin.
//                    Emails the client their link (reply-to and bcc the rep).
//   kind "accepted": called by the client page right after they accept. Sends once per acceptance:
//                    a heads-up to the rep and admins, and a confirmation to the client.
//   kind "plan":     called by the client page when the client sends a different phase plan. Emails the rep
//                    once per suggestion.
//   kind "ad_feedback": called by a client launch page (proposal/<client>/) when they ask for an ad change.
//                    Adds a note on the company timeline and emails the rep the note and marked-up image.
// The Resend key lives only in Supabase secrets (RESEND_API_KEY).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const APP = 'https://app.gelpstrategies.com';
const FROM = 'GELP Strategies <proposals@send.gelpstrategies.com>';
// online payment on accept: GELP's account only, when the switch in Admin > Pricing is on and the key is set
const payOn = async (tenant: string) => !!Deno.env.get('STRIPE_SECRET_KEY') && !!(await db.rpc('payments_on_for', { p_tenant: tenant })).data;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SB_URL = Deno.env.get('SUPABASE_URL')!;
// New-style secret key first (projects with legacy keys turned off), then the legacy service role key.
function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const SERVICE_KEY = envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const PUBLIC_KEY = envKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const db = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const money = (n: unknown) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const longDate = (s: string) => new Date(s).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
const firstName = (s: string) => (s || '').replace(/^(dr\.?|mr\.?|mrs\.?|ms\.?)\s+/i, '').split(/[\s,]+/)[0] || '';

function shell(title: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#F3F5F9;font-family:Arial,Helvetica,sans-serif;color:#1A2A52">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DCE2EC;border-radius:12px">
    <tr><td style="background:#1A2A52;border-radius:12px 12px 0 0;padding:18px 24px;color:#FFFFFF;font-size:18px;font-weight:bold;letter-spacing:2px">GELP <span style="color:#C9A04A;font-size:11px;letter-spacing:3px">STRATEGIES</span></td></tr>
    <tr><td style="padding:24px;font-size:15px;line-height:1.55">
      <h1 style="font-family:Georgia,serif;font-weight:600;font-size:22px;margin:0 0 14px">${title}</h1>${body}
    </td></tr>
    <tr><td style="border-top:2px solid #C9A04A;padding:14px 24px;font-size:12px;color:#7C8AA6">GELP Strategies, an authorized RLX dealer · info@gelpstrategies.com · gelpstrategies.com</td></tr>
  </table></td></tr></table></body></html>`;
}
const button = (href: string, label: string) =>
  `<p style="margin:22px 0"><a href="${href}" style="background:#C9A04A;color:#1A2A52;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:8px;display:inline-block">${label}</a></p>`;
const totals = (setup: unknown, month: unknown, week: unknown = 0) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#F6F8FB;border-radius:8px;font-size:15px"><tr><td style="padding:12px 14px">Due at signing</td><td align="right" style="padding:12px 14px;font-weight:bold">${money(setup)}</td></tr>
   <tr><td style="padding:0 14px 12px">Monthly</td><td align="right" style="padding:0 14px 12px;font-weight:bold">${money(month)}/mo</td></tr>${Number(week) > 0 ? `
   <tr><td style="padding:0 14px 12px">Weekly</td><td align="right" style="padding:0 14px 12px;font-weight:bold">${money(week)}/week</td></tr>` : ''}</table>`;

// "Phase 1 of 3. Phases 2 and 3 are price-locked until May 16, 2027." for phased proposals
function phaseNote(ver: any, from?: string) {
  const ph = ver?.quote?.phases || [];
  if (ph.length < 2) return '';
  const later = ph.slice(1).map((x: any) => x.n).join(ph.length > 3 ? ', ' : ' and ');
  const months = Number(ver.quote.lock_months) || 6;
  const until = from ? new Date(new Date(from).setMonth(new Date(from).getMonth() + months)) : null;
  const lock = until ? `price-locked until ${longDate(until.toISOString())}` : `price-locked for ${months} months after you accept`;
  return `<p style="font-size:14px;color:#5B6B8A">These totals are Phase 1 of ${ph.length}. ${ph.length > 2 ? 'Phases' : 'Phase'} ${later} ${ph.length > 2 ? 'are' : 'is'} ${lock}: ${money(ver.quote.plan?.setup)} in setup and ${money(ver.quote.plan?.month)}/mo once everything is running.</p>`;
}

async function resend(payload: Record<string, unknown>) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new Error('Email is not set up yet (RESEND_API_KEY missing in Supabase secrets)');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, ...payload }),
  });
  if (!r.ok) throw new Error(`Email failed: ${await r.text()}`);
  return r.json();
}

async function context(p: any) {
  const [{ data: co }, { data: rep }, { data: ver }] = await Promise.all([
    db.from('companies').select('name').eq('id', p.company_id).maybeSingle(),
    db.from('app_users').select('full_name,email').eq('id', p.owner_id).maybeSingle(),
    db.from('proposal_versions').select('setup_total,monthly_total,weekly_total,quote').eq('proposal_id', p.id).eq('version', p.version).maybeSingle(),
  ]);
  return { org: co?.name || 'your organization', rep, ver };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }

  try {
    if (body.kind === 'sent') {
      // Check the caller with their own login, so access follows the same rules as the CRM.
      const auth = req.headers.get('Authorization') || '';
      const asUser = createClient(SB_URL, PUBLIC_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
      const { data: u, error: ue } = await asUser.auth.getUser(auth.replace(/^Bearer\s+/i, ''));
      if (!u?.user) { console.error('getUser', ue?.message); return json({ error: 'Sign in again' }, 401); }
      const { data: me, error: me_e } = await asUser.from('app_users').select('id,is_admin,active,role').eq('id', u.user.id).maybeSingle();
      if (me_e) console.error('app_users', me_e.message);
      if (!me?.active || me.role === 'vendor') return json({ error: 'Your login is not allowed to send email' }, 403);
      // the caller must be able to see the proposal under the CRM's own rules (same account, closer or admin)
      const { data: seen } = await asUser.from('proposals').select('id').eq('id', body.proposal_id).maybeSingle();
      if (!seen) return json({ error: 'Proposal not found' }, 404);
      const { data: p, error: pe } = await db.from('proposals').select('*').eq('id', body.proposal_id).maybeSingle();
      if (pe) { console.error('proposals', pe.message); return json({ error: 'Email service could not read the proposal: ' + pe.message }, 500); }
      if (!p || (p.owner_id !== me.id && !me.is_admin)) return json({ error: 'Proposal not found' }, 404);
      if (p.status !== 'sent' || !p.version) return json({ error: 'Send the proposal first' }, 400);
      const to = (p.contact_email || '').trim();
      if (!/^\S+@\S+\.\S+$/.test(to)) return json({ error: 'Add the client email on the proposal first' }, 400);
      if (p.last_emailed_at && Date.now() - new Date(p.last_emailed_at).getTime() < 60_000) return json({ error: 'Already emailed in the last minute' }, 429);
      const { org, rep, ver } = await context(p);
      const link = `${APP}/proposal/view/#${p.share_token}`;
      const hi = firstName(p.contact_name) ? `Hi ${esc(firstName(p.contact_name))},` : 'Hello,';
      const html = shell(`Your proposal for ${esc(org)}`, `
        <p>${hi}</p>
        <p>${p.version > 1 ? 'Here is the updated proposal we put together for you.' : 'Here is the proposal we put together for you.'} Every item includes what's covered, and you can accept it right on the page when you're ready.</p>
        ${ver ? totals(ver.setup_total, ver.monthly_total, ver.weekly_total) + phaseNote(ver) : ''}
        ${button(link, 'View your proposal')}
        <p style="font-size:13px;color:#5B6B8A">Pricing is valid until ${esc(longDate(p.expires_at))}. Questions? Just reply to this email.</p>
        <p>${esc(rep?.full_name || 'The GELP Strategies team')}<br><span style="color:#5B6B8A">GELP Strategies</span></p>`);
      const sent = await resend({ to: [to], bcc: rep?.email ? [rep.email] : undefined, reply_to: rep?.email || 'info@gelpstrategies.com',
        subject: `Your proposal from GELP Strategies${p.version > 1 ? ` (updated, version ${p.version})` : ''}`, html });
      await db.from('proposals').update({ last_emailed_at: new Date().toISOString(), last_emailed_to: to }).eq('id', p.id);
      await db.from('activities').insert({ company_id: p.company_id, type: 'email', body: `Proposal version ${p.version} emailed to ${to}.`, created_by: me.id });
      return json({ ok: true, to, id: sent?.id });
    }

    if (body.kind === 'accepted') {
      const token = String(body.token || '');
      if (token.length < 32) return json({ error: 'Bad request' }, 400);
      const { data: p } = await db.from('proposals').select('*').eq('share_token', token).maybeSingle();
      if (!p || p.status !== 'accepted' || p.accept_notified_at) return json({ ok: true, skipped: true });
      if (Date.now() - new Date(p.accepted_at).getTime() > 30 * 60_000) return json({ ok: true, skipped: true });
      // claim the notification first so it can only go out once
      const { data: claimed } = await db.from('proposals').update({ accept_notified_at: new Date().toISOString() })
        .eq('id', p.id).is('accept_notified_at', null).select('id');
      if (!claimed?.length) return json({ ok: true, skipped: true });
      const { org, rep, ver } = await context(p);
      const PAY_ON = await payOn(p.tenant_id);
      const { data: admins } = await db.from('app_users').select('email').eq('is_admin', true).eq('active', true).eq('tenant_id', p.tenant_id);
      const team = [...new Set([rep?.email, ...(admins || []).map((a: any) => a.email)].filter(Boolean))] as string[];
      const when = new Date(p.accepted_at).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Chicago' });
      if (team.length) await resend({ to: team, reply_to: p.accepted_email || undefined,
        subject: `Accepted: ${org} proposal (version ${p.accepted_version})`,
        html: shell(`${esc(org)} accepted`, `
          <p><b>${esc(p.accepted_name)}</b>${p.accepted_email ? ` (${esc(p.accepted_email)})` : ''} accepted version ${p.accepted_version} on ${esc(when)} Central.</p>
          ${ver ? totals(ver.setup_total, ver.monthly_total, ver.weekly_total) + phaseNote(ver, p.accepted_at) : ''}
          <p>${PAY_ON ? 'They were sent straight to the secure Stripe payment page. The CRM marks the proposal paid when the payment goes through.' : 'Next: send the invoice for the setup and first month from the GELP Portal.'}</p>
          ${button(`${APP}/#proposal/${p.id}`, 'Open in the CRM')}`) });
      const clientTo = (p.accepted_email || p.contact_email || '').trim();
      if (/^\S+@\S+\.\S+$/.test(clientTo)) await resend({ to: [clientTo], reply_to: rep?.email || 'info@gelpstrategies.com',
        subject: 'Thank you. Your GELP Strategies proposal is accepted',
        html: shell('Thank you', `
          <p>Hi ${esc(firstName(p.accepted_name) || '')},</p>
          <p>We received your acceptance of version ${p.accepted_version} of the proposal for ${esc(org)} on ${esc(when)} Central. A copy stays at the link below.</p>
          ${ver ? totals(ver.setup_total, ver.monthly_total, ver.weekly_total) + phaseNote(ver, p.accepted_at) : ''}
          ${button(`${APP}/proposal/view/#${p.share_token}`, 'View your accepted proposal')}
          <p>${PAY_ON ? `If you didn't finish your payment, you can complete it any time from the link above. ${esc(rep?.full_name || 'Our team')} will follow up with next steps.` : `${esc(rep?.full_name || 'Our team')} will follow up with next steps and your first invoice.`} Questions? Just reply to this email.</p>`) });
      return json({ ok: true });
    }
    if (body.kind === 'plan') {
      const token = String(body.token || '');
      if (token.length < 32) return json({ error: 'Bad request' }, 400);
      const { data: p } = await db.from('proposals').select('*').eq('share_token', token).maybeSingle();
      if (!p || !p.client_plan?.at || p.status === 'accepted') return json({ ok: true, skipped: true });
      if (Date.now() - new Date(p.client_plan.at).getTime() > 30 * 60_000) return json({ ok: true, skipped: true });
      // one email per suggestion
      let claim = db.from('proposals').update({ client_plan_notified_at: new Date().toISOString() }).eq('id', p.id);
      claim = p.client_plan_notified_at ? claim.lt('client_plan_notified_at', p.client_plan.at) : claim.is('client_plan_notified_at', null);
      const { data: claimed } = await claim.select('id');
      if (!claimed?.length) return json({ ok: true, skipped: true });
      const { org, rep } = await context(p);
      if (!rep?.email) return json({ ok: true, skipped: true });
      const who = p.contact_name || 'Your client';
      await resend({ to: [rep.email], reply_to: p.contact_email || undefined,
        subject: `${who} suggested a phase plan for ${org}`,
        html: shell(`${esc(who)} rearranged the phases`, `
          <p>${esc(who)} moved some items between phases on the ${esc(org)} proposal and sent it to you to review.</p>
          <p>Open the proposal to see their plan next to yours. You can use their plan as is, adjust it, or keep yours, then send an updated version for them to accept.</p>
          ${button(`${APP}/#proposal/${p.id}`, 'Review their plan')}`) });
      return json({ ok: true });
    }
    if (body.kind === 'ad_feedback') {
      // A client asks for a change to an ad proof from their launch page. Lands on the company's timeline in the CRM
      // and emails the rep, with the marked-up image attached and saved in the private feedback bucket.
      const token = String(body.token || '');
      if (token.length < 32) return json({ error: 'Bad request' }, 400);
      const note = String(body.note || '').trim().slice(0, 3000);
      const ad = String(body.ad || 'General').trim().slice(0, 80);
      const who = String(body.name || '').trim().slice(0, 80);
      const img = String(body.image || '');
      if (!note && !img) return json({ error: 'Write a note or mark up the ad first' }, 400);
      if (img && (!/^[A-Za-z0-9+/=]+$/.test(img) || img.length > 6_000_000)) return json({ error: 'That image is too big. Mark up a smaller area.' }, 400);
      const { data: p } = await db.from('proposals').select('*').eq('share_token', token).maybeSingle();
      if (!p) return json({ error: 'This link is no longer active' }, 404);
      const since = new Date(Date.now() - 60 * 60_000).toISOString();
      const { count } = await db.from('activities').select('id', { count: 'exact', head: true })
        .eq('company_id', p.company_id).like('body', 'Ad change request%').gte('created_at', since);
      if ((count || 0) >= 15) return json({ error: 'That is a lot of requests in an hour. Email david@gelpstrategies.com and we will pick it up there.' }, 429);
      const { org, rep } = await context(p);
      let path = '';
      if (img) {
        path = `clients/${p.id}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.jpg`;
        const bytes = Uint8Array.from(atob(img), (c) => c.charCodeAt(0));
        const up = await db.storage.from('feedback').upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
        if (up.error) { console.error('feedback upload', up.error.message); path = ''; }
      }
      const by = who || p.contact_name || 'The client';
      await db.from('activities').insert({ company_id: p.company_id, tenant_id: p.tenant_id, type: 'note',
        body: `Ad change request from ${by} on ${ad}:\n${note || '(marked up the ad, no note)'}${path ? `\nMarked-up image: feedback/${path} (also emailed)` : ''}` });
      const to = rep?.email || 'info@gelpstrategies.com';
      await resend({ to: [to], reply_to: p.contact_email || undefined,
        subject: `${org} asked for an ad change: ${ad}`,
        attachments: img ? [{ filename: `${org} ${ad} markup.jpg`.replace(/[^\w .-]+/g, ''), content: img }] : undefined,
        html: shell(`${esc(by)} asked for a change`, `
          <p><b>${esc(ad)}</b> on the ${esc(org)} launch page.</p>
          <p style="white-space:pre-wrap;background:#F6F8FB;border-radius:8px;padding:12px 14px">${esc(note || 'No note. See the marked-up image attached.')}</p>
          ${img ? '<p style="font-size:14px;color:#5B6B8A">Their marked-up image is attached.</p>' : ''}
          ${button(`${APP}/#proposal/${p.id}`, 'Open in the CRM')}`) });
      return json({ ok: true });
    }
    return json({ error: 'Unknown request' }, 400);
  } catch (e) {
    console.error('proposal-email', (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
