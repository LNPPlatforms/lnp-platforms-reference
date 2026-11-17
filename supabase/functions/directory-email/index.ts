// directory-email: emails for directories. The business's own email is never shown to visitors.
//   kind "invite":  an admin invited a business to manage its listing (caller must be an admin who can see it).
//   kind "message": a visitor wrote to a business (called by the public page with the visitor's key).
//                   Emails the business logins on that listing (or the account's admins if it has none),
//                   at most once every 10 minutes per conversation.
//   kind "reply":   the business replied (caller must be a business login on that listing). Emails the visitor a link
//                   back to the conversation, unless they're looking at it right now.
//   kind "edit":    an admin approved or turned down a business's listing edit. Tells whoever sent it.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { brandFor, fromLine } from '../_shared/brand.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SB_URL = Deno.env.get('SUPABASE_URL')!;
function envKey(mapVar: string, legacyVar: string) {
  try { const m = JSON.parse(Deno.env.get(mapVar) || '{}'); const k = m.default || Object.values(m)[0]; if (k) return String(k); } catch { /* not set */ }
  return Deno.env.get(legacyVar) || '';
}
const PUBLIC_KEY = envKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const db = createClient(SB_URL, envKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const nl = (s: string) => esc(s).replace(/\n/g, '<br>');
const hex = (h: unknown, d: string) => /^#[0-9a-f]{6}$/i.test(String(h || '')) ? String(h) : d;

function shell(brand: string, color: string, title: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#F3F5F9;font-family:Arial,Helvetica,sans-serif;color:#1A2A52">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DCE2EC;border-radius:12px">
    <tr><td style="background:${color};border-radius:12px 12px 0 0;padding:18px 24px;color:#FFFFFF;font-size:18px;font-weight:bold">${esc(brand)}</td></tr>
    <tr><td style="padding:24px;font-size:15px;line-height:1.55"><h1 style="font-family:Georgia,serif;font-weight:600;font-size:21px;margin:0 0 14px">${title}</h1>${body}</td></tr>
    <tr><td style="border-top:1px solid #DCE2EC;padding:12px 24px;font-size:12px;color:#7C8AA6">Sent by ${esc(brand)} through GELP Strategies.</td></tr>
  </table></td></tr></table></body></html>`;
}
const button = (href: string, label: string, color = '#C9A04A') =>
  `<p style="margin:22px 0"><a href="${esc(href)}" style="background:${color};color:#111;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:8px;display:inline-block">${esc(label)}</a></p>`;
const bubble = (who: string, body: string, mine: boolean) =>
  `<div style="margin:8px 0;padding:10px 12px;border-radius:10px;background:${mine ? '#EEF2F8' : '#F5ECD8'}"><div style="font-size:12px;color:#5B6B8A;margin-bottom:3px">${esc(who)}</div>${nl(body)}</div>`;

async function resend(payload: Record<string, unknown>) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new Error('Email is not set up yet (RESEND_API_KEY missing)');
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`Email failed: ${await r.text()}`);
  return r.json();
}
// from the directory's name, at its owner's agency sending domain
const fromFor = (name: string, send: string) => fromLine(String(name || 'Directory').slice(0, 60), 'directory', send);

async function caller(req: Request) {
  const auth = req.headers.get('Authorization') || '';
  const asUser = createClient(SB_URL, PUBLIC_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: u } = await asUser.auth.getUser(auth.replace(/^Bearer\s+/i, ''));
  return { asUser, uid: u?.user?.id || null };
}
async function listingInfo(listingId: string) {
  const { data: l } = await db.from('directory_listings').select('id,tenant_id,directory_id,company_id').eq('id', listingId).maybeSingle();
  if (!l) return null;
  const [{ data: d }, { data: co }] = await Promise.all([
    db.from('directories').select('id,tenant_id,name,slug,settings,custom_domain').eq('id', l.directory_id).maybeSingle(),
    db.from('companies').select('name').eq('id', l.company_id).maybeSingle(),
  ]);
  const bb = await brandFor(db, d?.tenant_id || l.tenant_id);
  return { l, d, app: bb.app, send: bb.send, org: co?.name || 'your business', color: hex(d?.settings?.colors?.primary, '#1A2A52'), accent: hex(d?.settings?.colors?.accent, '#C9A04A') };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  try {
    if (body.kind === 'invite') {
      const { asUser, uid } = await caller(req);
      if (!uid) return json({ error: 'Sign in again' }, 401);
      const { data: me } = await asUser.from('app_users').select('is_admin,active,role').eq('id', uid).maybeSingle();
      if (!me?.active || !me.is_admin || me.role === 'member' || me.role === 'vendor') return json({ error: 'Only an admin can send invites' }, 403);
      // the CRM's own rules decide whether this admin can see the invite
      const { data: m } = await asUser.from('directory_members').select('id,listing_id,email,full_name,user_id,revoked_at').eq('id', body.member_id).maybeSingle();
      if (!m || m.revoked_at) return json({ error: 'Invite not found' }, 404);
      const x = await listingInfo(m.listing_id); if (!x) return json({ error: 'Listing not found' }, 404);
      const first = String(m.full_name || '').split(/\s+/)[0];
      await resend({ from: fromFor(x.d?.name, x.send), to: [m.email],
        subject: `Manage ${x.org}'s listing on ${x.d?.name}`,
        html: shell(x.d?.name || 'Directory', x.color, `${first ? `Hi ${esc(first)}, ` : ''}your listing is ready for you`, `
          <p>You've been given access to manage <b>${esc(x.org)}</b> on ${esc(x.d?.name)}. You can update your details, add photos and answer messages from customers.</p>
          ${m.user_id
            ? `<p>Sign in with this email address (${esc(m.email)}) to see it.</p>${button(x.app, 'Sign in', x.accent)}`
            : `<p>Create your login with this email address (<b>${esc(m.email)}</b>). On the sign-in page, tap <b>Invited? Create your login</b>.</p>${button(x.app, 'Create your login', x.accent)}`}
          <p style="font-size:13px;color:#5B6B8A">If you weren't expecting this, you can ignore it.</p>`) });
      return json({ ok: true, to: m.email });
    }

    if (body.kind === 'message') {
      const { data: th } = await db.from('directory_threads').select('*').eq('id', body.thread).eq('visitor_key', String(body.key || '')).maybeSingle();
      if (!th) return json({ ok: true, skipped: true });
      if (th.business_notified_at && Date.now() - new Date(th.business_notified_at).getTime() < 10 * 60_000) return json({ ok: true, skipped: 'recent' });
      let claim = db.from('directory_threads').update({ business_notified_at: new Date().toISOString() }).eq('id', th.id);
      claim = th.business_notified_at ? claim.eq('business_notified_at', th.business_notified_at) : claim.is('business_notified_at', null);
      const { data: claimed } = await claim.select('id');
      if (!claimed?.length) return json({ ok: true, skipped: true });
      const x = await listingInfo(th.listing_id); if (!x) return json({ ok: true, skipped: true });
      const { data: mem } = await db.from('directory_members').select('user_id').eq('listing_id', th.listing_id).is('revoked_at', null).not('user_id', 'is', null);
      let to: string[] = [];
      if (mem?.length) {
        const { data: us } = await db.from('app_users').select('email').in('id', mem.map((r: any) => r.user_id)).eq('active', true);
        to = (us || []).map((u: any) => u.email);
      }
      const toBusiness = to.length > 0;
      if (!toBusiness) {
        const { data: adm } = await db.from('app_users').select('email').eq('tenant_id', th.tenant_id).eq('active', true).eq('is_admin', true).not('role', 'in', '(vendor,member)');
        to = (adm || []).map((u: any) => u.email);
      }
      to = [...new Set(to.filter(Boolean))];
      if (!to.length) return json({ ok: true, skipped: 'nobody' });
      const { data: msgs } = await db.from('directory_messages').select('sender,body').eq('thread_id', th.id).order('created_at', { ascending: false }).limit(6);
      const list = (msgs || []).reverse().map((m: any) => bubble(m.sender === 'business' ? x.org : th.visitor_name, m.body, m.sender === 'business')).join('');
      await resend({ from: fromFor(x.d?.name, x.send), to,
        subject: `New message for ${x.org} from ${th.visitor_name}`,
        html: shell(x.d?.name || 'Directory', x.color, `${esc(th.visitor_name)} sent ${esc(x.org)} a message`, `
          ${toBusiness ? '' : `<p style="color:#8A6100;background:#FBF0D3;border-radius:8px;padding:8px 10px;font-size:14px">${esc(x.org)} has no business login yet, so this came to you as an admin of ${esc(x.d?.name)}. Invite them from the listing to pass messages along.</p>`}
          <p style="color:#5B6B8A;font-size:14px">Through your listing on ${esc(x.d?.name)}${th.visitor_phone ? ` · phone ${esc(th.visitor_phone)}` : ''}</p>
          ${list}${button(x.app, 'Reply', x.accent)}
          <p style="font-size:13px;color:#5B6B8A">Reply from your login so your email address stays private.</p>`) });
      return json({ ok: true });
    }

    if (body.kind === 'reply') {
      const { asUser, uid } = await caller(req);
      if (!uid) return json({ error: 'Sign in again' }, 401);
      const { data: open } = await asUser.rpc('directory_thread_open', { p_thread: body.thread });
      if (!open?.can_reply) return json({ error: 'Conversation not found' }, 404);
      const { data: th } = await db.from('directory_threads').select('*').eq('id', body.thread).maybeSingle();
      if (!th) return json({ error: 'Conversation not found' }, 404);
      if (th.visitor_seen_at && Date.now() - new Date(th.visitor_seen_at).getTime() < 45_000) return json({ ok: true, skipped: 'visitor here' });
      if (th.visitor_notified_at && Date.now() - new Date(th.visitor_notified_at).getTime() < 5 * 60_000) return json({ ok: true, skipped: 'recent' });
      await db.from('directory_threads').update({ visitor_notified_at: new Date().toISOString() }).eq('id', th.id);
      const x = await listingInfo(th.listing_id); if (!x) return json({ ok: true, skipped: true });
      const { data: msgs } = await db.from('directory_messages').select('sender,body').eq('thread_id', th.id).order('created_at', { ascending: false }).limit(4);
      const list = (msgs || []).reverse().map((m: any) => bubble(m.sender === 'business' ? x.org : 'You', m.body, m.sender !== 'business')).join('');
      const base = x.d?.custom_domain ? `https://${x.d.custom_domain}/` : `${x.app}/directory/?d=${encodeURIComponent(x.d?.slug || '')}`;
      const link = `${base}#t=${th.id}&k=${th.visitor_key}`;
      const first = String(th.visitor_name || '').split(/\s+/)[0];
      await resend({ from: fromFor(x.d?.name, x.send), to: [th.visitor_email],
        subject: `${x.org} replied to your message`,
        html: shell(x.d?.name || 'Directory', x.color, `${first ? `Hi ${esc(first)}, ` : ''}${esc(x.org)} replied`, `
          ${list}${button(link, 'See the conversation and reply', x.accent)}
          <p style="font-size:13px;color:#5B6B8A">Replies to this email aren't read. Use the button above to answer.</p>`) });
      return json({ ok: true });
    }

    if (body.kind === 'edit') {
      const { asUser, uid } = await caller(req);
      if (!uid) return json({ error: 'Sign in again' }, 401);
      const { data: e } = await asUser.from('directory_listing_edits').select('id,listing_id,status,note,submitted_by').eq('id', body.edit_id).maybeSingle();
      if (!e || !['approved', 'rejected'].includes(e.status) || !e.submitted_by) return json({ ok: true, skipped: true });
      const { data: who } = await db.from('app_users').select('email,full_name,role').eq('id', e.submitted_by).maybeSingle();
      if (!who?.email || who.role !== 'member') return json({ ok: true, skipped: true });
      const x = await listingInfo(e.listing_id); if (!x) return json({ ok: true, skipped: true });
      const ok = e.status === 'approved';
      await resend({ from: fromFor(x.d?.name, x.send), to: [who.email],
        subject: ok ? `Your changes to ${x.org} are live` : `About your changes to ${x.org}`,
        html: shell(x.d?.name || 'Directory', x.color, ok ? 'Your changes are live' : 'Your changes weren\'t published', `
          <p>${ok ? `The updates you sent for <b>${esc(x.org)}</b> are now showing on ${esc(x.d?.name)}.` : `The updates you sent for <b>${esc(x.org)}</b> weren't published.`}</p>
          ${e.note ? `<p><b>Note from ${esc(x.d?.name)}:</b><br>${nl(e.note)}</p>` : ''}
          ${button(x.app, ok ? 'See your listing' : 'Update and send again', x.accent)}`) });
      return json({ ok: true });
    }
    return json({ error: 'Unknown request' }, 400);
  } catch (e) {
    console.error('directory-email', (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
