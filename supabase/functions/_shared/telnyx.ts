// Telnyx REST helper (Nov 16, 2026). One Telnyx account runs the whole CRM; the key is the TELNYX_API_KEY secret.
export const TELNYX_KEY = Deno.env.get('TELNYX_API_KEY') || '';
const API = 'https://api.telnyx.com/v2';

export async function tx(path: string, init: { method?: string; body?: unknown; text?: boolean } = {}) {
  if (!TELNYX_KEY) throw new Error('The phone system isn\'t set up on the server yet (TELNYX_API_KEY missing).');
  const r = await fetch(API + path, {
    method: init.method || (init.body ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${TELNYX_KEY}`, 'Content-Type': 'application/json', Accept: init.text ? 'text/plain, application/json' : 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const raw = await r.text();
  let j: any = null; try { j = JSON.parse(raw); } catch { /* plain text (tokens) */ }
  if (!r.ok) {
    const e = j?.errors?.[0];
    throw new Error(e ? `${e.title || 'Telnyx error'}${e.detail ? ': ' + e.detail : ''}` : `Telnyx answered ${r.status}`);
  }
  return init.text ? (j?.data?.token || j?.token || (typeof j === 'string' ? j : raw)) : j;
}

// call commands; a call that already hung up is not an error worth stopping for
export async function cmd(ccid: string, action: string, body: Record<string, unknown> = {}) {
  try { return await tx(`/calls/${encodeURIComponent(ccid)}/actions/${action}`, { body }); }
  catch (e) { console.log('telnyx', action, (e as Error).message); return null; }
}

export const state = (o: Record<string, unknown>) => btoa(JSON.stringify(o));
export const unstate = (s?: string | null): any => { try { return s ? JSON.parse(atob(s)) : {}; } catch { return {}; } };
