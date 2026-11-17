// chat-email: email side of the chat widget.
//   kind "visitor": called by the widget after a visitor sends a message. If nobody on the account is online (or it's
//                   a brand new conversation), emails the account's team, at most once every 10 minutes per conversation.
//   kind "team_hook": called by the database after every team chat message. People in it who are away get a push
//                   notification on devices where they turned them on, or an email if they have none (see notifyTeam).
//                   The email waits 30 seconds, the recall window, and is skipped if the message was recalled.
//   kind "reply":   called by the CRM after a team member replies. If the visitor has left the page, emails them the
//                   replies they haven't seen, with a link back to where they were chatting.
//   kind "notify_hook": called by the database for a notification marked deliver (a note someone was notified on,
//                   urgent alerts). Goes out the way the person chose: push, email, both, or only in the CRM.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { sendPush, type Vapid } from './push.ts';
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
const SOURCE: Record<string, string> = { website: 'the website', proposal: 'their proposal page', invoice: 'an invoice', other: 'a chat' };

function shell(brand: string, title: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#F3F5F9;font-family:Arial,Helvetica,sans-serif;color:#1A2A52">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F5F9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DCE2EC;border-radius:12px">
    <tr><td style="background:#1A2A52;border-radius:12px 12px 0 0;padding:18px 24px;color:#FFFFFF;font-size:18px;font-weight:bold;letter-spacing:1px">${esc(brand)}</td></tr>
    <tr><td style="padding:24px;font-size:15px;line-height:1.55"><h1 style="font-family:Georgia,serif;font-weight:600;font-size:21px;margin:0 0 14px">${title}</h1>${body}</td></tr>
  </table></td></tr></table></body></html>`;
}
const button = (href: string, label: string) =>
  `<p style="margin:22px 0"><a href="${esc(href)}" style="background:#C9A04A;color:#1A2A52;text-decoration:none;font-weight:bold;padding:13px 22px;border-radius:8px;display:inline-block">${esc(label)}</a></p>`;
const bubble = (who: string, body: string, staff: boolean) =>
  `<div style="margin:8px 0;padding:10px 12px;border-radius:10px;background:${staff ? '#EEF2F8' : '#F5ECD8'}"><div style="font-size:12px;color:#5B6B8A;margin-bottom:3px">${esc(who)}</div>${nl(body)}</div>`;

async function resend(payload: Record<string, unknown>) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new Error('Email is not set up yet (RESEND_API_KEY missing)');
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`Email failed: ${await r.text()}`);
  return r.json();
}
// sent from the account's own agency domain, under the account's name (never another agency's)
const fromFor = (name: string, send: string) => fromLine(name, 'chat', send);

// team chat: push to people who are away, email anyone with no working push (at most every 10 minutes per conversation)
async function notifyTeam(msg: any) {
      const { data: room } = await db.from('team_rooms').select('id,kind,name,tenant_id').eq('id', msg.room_id).maybeSingle();
      if (!room) return { ok: true, skipped: true };
      // the room's team: people whose home is this account plus people added to it from other accounts (Nov 16)
      const cols = 'id,full_name,email,last_seen_at,active,role,hidden_in_team,forward_to,tenant_id';
      const { data: home } = await db.from('app_users').select(cols).eq('tenant_id', room.tenant_id).eq('active', true).not('role', 'in', '(vendor,member)');
      const { data: am } = await db.from('account_members').select('user_id').eq('tenant_id', room.tenant_id).eq('active', true);
      const extraIds = (am || []).map((m: any) => m.user_id).filter((id: string) => !(home || []).some((p: any) => p.id === id));
      const { data: extra } = extraIds.length ? await db.from('app_users').select(cols).in('id', extraIds).eq('active', true).not('role', 'in', '(vendor,member)') : { data: [] };
      const team = [...(home || []), ...(extra || [])];
      const { data: mem } = await db.from('team_room_members').select('user_id,left_at,last_read_at,notified_at').eq('room_id', room.id);
      const memOf = new Map((mem || []).map((m: any) => [m.user_id, m]));
      const inRoom = (team || []).filter((p: any) => room.kind === 'team' ? !p.hidden_in_team : (memOf.get(p.id) && !memOf.get(p.id).left_at));
      const sender = (team || []).find((p: any) => p.id === msg.sender_id);
      const now = Date.now();
      const unreadRaw = inRoom.filter((p: any) => {
        if (p.id === msg.sender_id) return false;
        const m = memOf.get(p.id);
        return !(m?.last_read_at && new Date(m.last_read_at) >= new Date(msg.created_at));
      });
      // logins with forward_to (like System Admin) don't get notified themselves; the person they forward to does
      const unreadBy: any[] = [];
      for (const p of unreadRaw) {
        if (!p.forward_to) { if (!unreadBy.some((x) => x.id === p.id)) unreadBy.push(p); continue; }
        const to = (team || []).find((x: any) => x.id === p.forward_to);
        if (to && to.id !== msg.sender_id && !unreadBy.some((x) => x.id === to.id) && !unreadRaw.some((x: any) => x.id === to.id)) unreadBy.push({ ...to, forFrom: p.full_name, forFromId: p.id });
      }
      // push goes to every device they turned on (a device with the CRM open on screen skips the popup itself);
      // email only to people who aren't in the CRM right now
      const away = unreadBy.filter((p: any) => !(p.last_seen_at && now - new Date(p.last_seen_at).getTime() < 120_000));
      if (!unreadBy.length) return { ok: true, pushed: 0, emailed: 0 };
      const { data: t } = await db.from('tenants').select('name,slug').eq('id', room.tenant_id).maybeSingle();
      const bb = await brandFor(db, room.tenant_id);
      const brand = t?.name || bb.name || 'Your team';
      const where = room.kind === 'dm' ? 'sent you a message' : `posted in ${room.kind === 'team' ? 'the team chat' : esc(room.name || 'a group')}`;

      // push first: every message, grouped per conversation on the device so they replace each other instead of piling up
      const pushedTo = new Set<string>();
      const { data: vapid } = await db.rpc('push_vapid');
      const { data: subs } = vapid ? await db.from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth').in('user_id', unreadBy.map((p: any) => p.id)).is('off_at', null) : { data: [] };
      if (subs?.length) {
        const { data: full } = await db.from('team_messages').select('body').eq('id', msg.id).maybeSingle();
        const title = room.kind === 'dm' ? (sender?.full_name || 'Team chat') : `${sender?.full_name || 'Someone'} in ${room.kind === 'team' ? 'Whole team' : room.name || 'a group'}`;
        const note = { title, body: String(full?.body || '').slice(0, 180), url: `/#chat/${room.id}`, tag: `room-${room.id}` };
        const fwd = new Map(unreadBy.filter((p: any) => p.forFrom).map((p: any) => [p.id, p.forFrom]));
        // someone whose home is another account sees where it's from: "Julie Olivari (Cognix)"
        const elsewhere = new Set(unreadBy.filter((p: any) => p.tenant_id && p.tenant_id !== room.tenant_id).map((p: any) => p.id));
        const label = brand ? ` (${brand})` : '';
        await Promise.all(subs.map(async (sb: any) => {
          try {
            const base = elsewhere.has(sb.user_id) ? { ...note, title: `${title}${label}` } : note;
            const n2 = fwd.has(sb.user_id) ? { ...base, title: `For ${fwd.get(sb.user_id)}: ${base.title}`, url: '/#chat' } : base;
            const st = await sendPush(sb, n2, vapid as Vapid);
            if (st >= 200 && st < 300) { pushedTo.add(sb.user_id); await db.from('push_subscriptions').update({ last_ok_at: new Date().toISOString() }).eq('id', sb.id); }
            else if (st === 404 || st === 410) await db.from('push_subscriptions').update({ off_at: new Date().toISOString(), off_reason: 'expired' }).eq('id', sb.id);
            else console.error('push status', st, sb.id);
          } catch (e) { console.error('push failed', sb.id, (e as Error).message); }
        }));
      }

      const emailPart = async () => {
      // email: only people with no working push, at most once every 10 minutes per conversation. It waits 30 seconds
      // first (the recall window): a message recalled by then, or one they read in the meantime, sends no email.
      await new Promise((res) => setTimeout(res, 31_000));
      const { data: still } = await db.from('team_messages').select('recalled_at').eq('id', msg.id).maybeSingle();
      if (!still || still.recalled_at) return { ok: true, pushed: pushedTo.size, emailed: 0, recalled: true };
      const { data: mem2 } = await db.from('team_room_members').select('user_id,left_at,last_read_at,notified_at').eq('room_id', room.id);
      memOf.clear(); (mem2 || []).forEach((m: any) => memOf.set(m.user_id, m));
      const to = away.filter((p: any) => {
        if (pushedTo.has(p.id) || !/^\S+@\S+\.\S+$/.test(p.email || '')) return false;
        const m = memOf.get(p.forFromId || p.id);   // forwarded mail is paced by the forwarding login's own row
        if (m?.last_read_at && new Date(m.last_read_at) >= new Date(msg.created_at)) return false;
        return !(m?.notified_at && Date.now() - new Date(m.notified_at).getTime() < 10 * 60_000);
      });
      let sent = 0;
      for (const p of to) {
        const since = memOf.get(p.forFromId || p.id)?.last_read_at;
        let q = db.from('team_messages').select('sender_id,body,created_at').eq('room_id', room.id).neq('sender_id', p.id).is('recalled_at', null);
        if (since) q = q.gt('created_at', since);
        const { data: unread } = await q.order('created_at', { ascending: false }).limit(6);
        const names = new Map((team || []).map((x: any) => [x.id, x.full_name]));
        const list = (unread || []).reverse().map((m: any) => bubble(names.get(m.sender_id) || 'Team', m.body, false)).join('');
        // note when we emailed, so the next message within 10 minutes doesn't email again
        const { data: claimed } = await db.from('team_room_members').upsert({ room_id: room.id, user_id: p.forFromId || p.id, notified_at: new Date().toISOString() }, { onConflict: 'room_id,user_id' }).select('user_id');
        if (!claimed?.length) continue;
        try {
          await resend({ from: fromFor(brand, bb.send), to: [p.email],
            subject: `${p.forFrom ? `For ${p.forFrom}: ` : ''}${sender?.full_name || 'Someone on your team'} ${room.kind === 'dm' ? (p.forFrom ? `messaged ${p.forFrom}` : 'messaged you') : `posted in ${room.kind === 'team' ? 'team chat' : room.name || 'a group'}`}`,
            html: shell(brand, `${esc(sender?.full_name || 'Someone on your team')} ${p.forFrom && room.kind === 'dm' ? `messaged ${esc(p.forFrom)}` : where}`, `${list}
              ${p.forFrom ? `<p style="font-size:13px;color:#5B6B8A">This was sent to ${esc(p.forFrom)}, which forwards to you.</p>` : ''}
              ${button(`${bb.app}/#chat${p.forFrom ? '' : '/' + room.id}`, 'Open team chat')}
              <p style="font-size:13px;color:#5B6B8A">You got this because you weren't in the CRM. Replies to this email don't reach the chat; answer in the CRM.</p>`) });
          sent++;
        } catch (e) { console.error('team email', p.id, (e as Error).message); }
      }
      return { ok: true, pushed: pushedTo.size, emailed: sent };
      };
      const job = emailPart().catch((e) => { console.error('team email', (e as Error).message); return null; });
      const rt = (globalThis as any).EdgeRuntime;
      if (rt?.waitUntil) { rt.waitUntil(job); return { ok: true, pushed: pushedTo.size, email: 'in 30 seconds if still unread' }; }
      return (await job) || { ok: true, pushed: pushedTo.size };
    }

// one notification (a note someone was notified on, and later urgent alerts): delivered the way the person chose.
//   push: devices with notifications on; email instead if none worked.  email: email.  both: both.  app: nothing extra.
async function deliverNotification(id: string) {
  const { data: n } = await db.from('notifications').select('id,user_id,kind,title,body,link,tenant_id,delivered_at,done_at,via_override').eq('id', id).maybeSingle();
  if (!n || n.delivered_at || n.done_at) return { ok: true, skipped: true };
  await db.from('notifications').update({ delivered_at: new Date().toISOString() }).eq('id', n.id).is('delivered_at', null);
  const { data: u } = await db.from('app_users').select('id,email,active,notify_via,tenant_id').eq('id', n.user_id).maybeSingle();
  if (!u?.active) return { ok: true, skipped: 'inactive' };
  // alerts (support, suggestions, error reports) go by push and email whatever the person picked (schema/115)
  const via = n.via_override || u.notify_via || 'push';
  if (via === 'app') return { ok: true, via };
  let pushed = 0;
  if (via === 'push' || via === 'both') {
    const { data: vapid } = await db.rpc('push_vapid');
    const { data: subs } = vapid ? await db.from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth').eq('user_id', u.id).is('off_at', null) : { data: [] };
    await Promise.all((subs || []).map(async (sb: any) => {
      try {
        const st = await sendPush(sb, { title: n.title, body: String(n.body || '').slice(0, 180), url: '/' + (n.link || '#myday'), tag: `note-${n.id}` }, vapid as Vapid);
        if (st >= 200 && st < 300) { pushed++; await db.from('push_subscriptions').update({ last_ok_at: new Date().toISOString() }).eq('id', sb.id); }
        else if (st === 404 || st === 410) await db.from('push_subscriptions').update({ off_at: new Date().toISOString(), off_reason: 'expired' }).eq('id', sb.id);
      } catch (e) { console.error('notify push', sb.id, (e as Error).message); }
    }));
  }
  let emailed = false;
  if ((via === 'email' || via === 'both' || (via === 'push' && !pushed)) && /^\S+@\S+\.\S+$/.test(u.email || '')) {
    const tid = n.tenant_id || u.tenant_id;
    const { data: t } = await db.from('tenants').select('name').eq('id', tid).maybeSingle();
    const bb = await brandFor(db, tid);
    const brand = t?.name || bb.name || 'Your team';
    try {
      await resend({ from: fromLine(brand, 'notifications', bb.send), to: [u.email], subject: n.title,
        html: shell(brand, esc(n.title), `${n.body ? bubble('Note', n.body, true) : ''}
          ${button(`${bb.app}/${n.link || '#myday'}`, 'Open it in the CRM')}
          <p style="font-size:13px;color:#5B6B8A">You can change how notifications reach you under your profile (the gear) in the CRM.</p>`) });
      emailed = true;
    } catch (e) { console.error('notify email', n.id, (e as Error).message); }
  }
  return { ok: true, via, pushed, emailed };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  try {
    if (body.kind === 'visitor') {
      const { data: th } = await db.from('chat_threads').select('*').eq('id', body.thread).eq('visitor_key', String(body.key || '')).maybeSingle();
      if (!th) return json({ ok: true, skipped: true });
      const { data: t } = await db.from('tenants').select('name,slug').eq('id', th.tenant_id).maybeSingle();
      const bb = await brandFor(db, th.tenant_id), tname = t?.name || bb.name || 'Your team';
      const { data: team } = await db.from('app_users').select('email,last_seen_at').eq('tenant_id', th.tenant_id).eq('active', true).not('role', 'in', '(vendor,member)');
      const online = (team || []).some((u: any) => u.last_seen_at && Date.now() - new Date(u.last_seen_at).getTime() < 120_000);
      const fresh = Date.now() - new Date(th.created_at).getTime() < 60_000;
      if (online && !fresh) return json({ ok: true, skipped: 'online' });
      if (th.team_notified_at && Date.now() - new Date(th.team_notified_at).getTime() < 10 * 60_000) return json({ ok: true, skipped: 'recent' });
      let claim = db.from('chat_threads').update({ team_notified_at: new Date().toISOString() }).eq('id', th.id);
      claim = th.team_notified_at ? claim.eq('team_notified_at', th.team_notified_at) : claim.is('team_notified_at', null);
      const { data: claimed } = await claim.select('id');
      if (!claimed?.length) return json({ ok: true, skipped: true });
      const to = [...new Set((team || []).map((u: any) => u.email).filter(Boolean))] as string[];
      if (!to.length) return json({ ok: true, skipped: 'no team' });
      const { data: msgs } = await db.from('chat_messages').select('sender,body,created_at').eq('thread_id', th.id).order('created_at', { ascending: false }).limit(6);
      const list = (msgs || []).reverse().map((m: any) => bubble(m.sender === 'staff' ? 'Your team' : th.visitor_name || 'Visitor', m.body, m.sender === 'staff')).join('');
      let org = '';
      if (th.company_id) org = (await db.from('companies').select('name').eq('id', th.company_id).maybeSingle()).data?.name || '';
      await resend({ from: fromFor(tname, bb.send), to, reply_to: th.visitor_email || undefined,
        subject: `${fresh ? 'New chat' : 'New chat message'} from ${th.visitor_name || 'a visitor'}${org ? ` (${org})` : ''}`,
        html: shell(tname, `${esc(th.visitor_name || 'A visitor')} ${fresh ? 'started a chat' : 'sent a message'}`, `
          <p style="color:#5B6B8A;font-size:14px">From ${esc(SOURCE[th.source] || 'a chat')}${org ? ` · ${esc(org)}` : ''} · ${esc(th.visitor_email || '')}${online ? '' : ' · Nobody was online, so they were told you\'ll reply soon.'}</p>
          ${list}${button(`${bb.app}/#inbox/${th.id}`, 'Reply in the CRM')}
          <p style="font-size:13px;color:#5B6B8A">Reply in the CRM so it shows in their chat window. Replying to this email goes straight to their inbox instead.</p>`) });
      return json({ ok: true });
    }

    if (body.kind === 'reply') {
      const auth = req.headers.get('Authorization') || '';
      const asUser = createClient(SB_URL, PUBLIC_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
      const { data: u } = await asUser.auth.getUser(auth.replace(/^Bearer\s+/i, ''));
      if (!u?.user) return json({ error: 'Sign in again' }, 401);
      // read the conversation as the signed-in user, so the CRM's access rules decide
      const { data: th } = await asUser.from('chat_threads').select('id,tenant_id,visitor_name,visitor_email,visitor_seen_at,page_url,source').eq('id', body.thread_id).maybeSingle();
      if (!th) return json({ error: 'Conversation not found' }, 404);
      if (th.visitor_seen_at && Date.now() - new Date(th.visitor_seen_at).getTime() < 45_000) return json({ ok: true, skipped: 'visitor here' });
      if (!/^\S+@\S+\.\S+$/.test(th.visitor_email || '')) return json({ ok: true, skipped: 'no email' });
      // only replies sent after the visitor left the page (they saw the earlier ones live)
      let q = db.from('chat_messages').select('id,body,created_at,staff_id').eq('thread_id', th.id).eq('sender', 'staff').is('emailed_at', null);
      if (th.visitor_seen_at) q = q.gt('created_at', th.visitor_seen_at);
      const { data: pending } = await q.order('created_at');
      if (!pending?.length) return json({ ok: true, skipped: 'nothing new' });
      const { data: t } = await db.from('tenants').select('name,slug').eq('id', th.tenant_id).maybeSingle();
      const { data: me } = await db.from('app_users').select('full_name,email').eq('id', u.user.id).maybeSingle();
      const bb = await brandFor(db, th.tenant_id);
      const brand = t?.name || bb.name || 'Your team';
      const first = (th.visitor_name || '').split(/\s+/)[0];
      const back = th.page_url && /^https:\/\//i.test(th.page_url) ? th.page_url : '';
      await resend({ from: fromFor(brand, bb.send), to: [th.visitor_email], reply_to: me?.email || undefined,
        subject: `Reply from ${brand}`,
        html: shell(brand, `${first ? `Hi ${esc(first)}, ` : ''}you have a reply`, `
          ${pending.map((m: any) => bubble(me?.full_name || brand, m.body, true)).join('')}
          ${back ? button(back, 'Continue the chat') : ''}
          <p style="font-size:13px;color:#5B6B8A">You can also just reply to this email.</p>`) });
      await db.from('chat_messages').update({ emailed_at: new Date().toISOString() }).in('id', pending.map((m: any) => m.id));
      return json({ ok: true, emailed: th.visitor_email });
    }
    if (body.kind === 'team') {
      // older CRM pages still call this after sending; the database hook (team_hook) now does the notifying, so skip
      return json({ ok: true, skipped: 'handled by the database' });
    }
    if (body.kind === 'team_hook') {
      // called by the database itself whenever a team chat message is saved, so every message notifies (even if the
      // sender closed the tab right away). Proven by a secret only the database and this function know.
      const { data: v } = await db.rpc('push_vapid');
      if (!v?.hook_secret || body.secret !== v.hook_secret) return json({ error: 'Not allowed' }, 401);
      const { data: msg } = await db.from('team_messages').select('id,room_id,tenant_id,sender_id,created_at').eq('id', body.message_id).maybeSingle();
      if (!msg) return json({ ok: true, skipped: true });
      return json(await notifyTeam(msg));
    }
    if (body.kind === 'notify_hook') {
      const { data: v } = await db.rpc('push_vapid');
      if (!v?.hook_secret || body.secret !== v.hook_secret) return json({ error: 'Not allowed' }, 401);
      return json(await deliverNotification(String(body.notification_id || '')));
    }
    return json({ error: 'Unknown request' }, 400);
  } catch (e) {
    console.error('chat-email', (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
