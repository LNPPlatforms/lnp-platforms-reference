// brand.ts: which brand an email goes out under (Nov 9, 2026: every white label fully white label).
// For any account: its agency's white label (the agency itself, or the agency it sits under).
//   app   where links point: https://<white label domain>, else APP_URL
//   send  the domain it sends from: the white label's verified send_domain, else SEND_DOMAIN (shared)
//   name  the brand's name, for the From line when the account has none of its own
// Never the address of whoever clicked send, so a client only ever sees their own agency's address.
// deno-lint-ignore-file no-explicit-any
export const APP_URL = (Deno.env.get('APP_URL') || 'https://app.lnpplatforms.com').replace(/\/+$/, '');
export const SEND_DOMAIN = Deno.env.get('SEND_DOMAIN') || 'send.gelpstrategies.com';

export type Brand = { app: string; send: string; name: string; agency: string | null; support: string | null };
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const clean = (d: unknown) => { const h = String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); return HOST.test(h) ? h : ''; };
const cache = new Map<string, Promise<Brand>>();

// db: a service client (any account) or the caller's own client (their account, or one they manage).
// tenantId: the account the email is about; leave it out with a caller's client to use the account they're in.
export function brandFor(db: any, tenantId?: string | null): Promise<Brand> {
  const fallback: Brand = { app: APP_URL, send: SEND_DOMAIN, name: '', agency: null, support: null };
  const k = tenantId || '';
  if (!k || !cache.has(k)) {
    const p = (async () => {
      try {
        const { data: b, error } = await db.rpc('email_brand', tenantId ? { p_tenant: tenantId } : {});
        if (error || !b) return fallback;
        const dom = clean(b.app), sd = clean(b.send);
        return { app: dom ? `https://${dom}` : APP_URL, send: sd || SEND_DOMAIN, name: String(b.name || ''), agency: b.agency || null, support: b.support || null };
      } catch { return fallback; }
    })();
    if (!k) return p;
    cache.set(k, p);
  }
  return cache.get(k)!;
}

// "Name <box@domain>" with characters that break the header taken out
export const fromLine = (name: string, box: string, domain: string) => `${String(name || 'Notifications').replace(/[<>"@\r\n]/g, '').slice(0, 80)} <${box}@${domain}>`;
