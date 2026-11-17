// invite-accept: makes a login from an invite link, already confirmed, so Supabase never sends its own
// "confirm your email" message (it can't carry an agency's brand and it sent people to the wrong address).
// The invite email reaching the inbox proves the address; the secret token in its link proves they got it.
// Body: { email, token, password, full_name }. No login needed. Afterwards the app signs them in with that password.
// The new-login trigger (handle_new_auth_user) still does the rest: account, role, marks the invite accepted.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const svc = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { email, token, password, full_name } = await req.json();
    const em = String(email || '').trim().toLowerCase();
    if (!em || !token) return json({ error: 'This invite link is missing a piece. Open it from the email again.' }, 400);
    if (String(password || '').length < 8) return json({ error: 'Pick a password with at least 8 characters.' }, 400);
    const { data: inv, error } = await svc.rpc('svc_invite_by_token', { p_email: em, p_token: String(token) });
    if (error) return json({ error: error.message }, 400);
    if (!inv) return json({ error: "This invite was already used or taken back. If you made your login already, sign in. Otherwise ask for a new invite." }, 404);
    const { error: e2 } = await svc.auth.admin.createUser({ email: em, password: String(password), email_confirm: true,
      user_metadata: { full_name: String(full_name || inv.name || '').trim().slice(0, 120) } });
    if (e2) {
      const m = String(e2.message || e2);
      if (/already.*registered|already exists|email_exists/i.test(m)) return json({ error: 'That email already has a login. Sign in, or use Forgot password.' }, 409);
      if (/PORTAL_EMAIL/i.test(m)) return json({ error: "This email is a client portal login, so it can't also be a team login." }, 409);
      return json({ error: m }, 400);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
