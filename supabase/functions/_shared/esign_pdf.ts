// esign_pdf.ts: builds the signed copy. Flattens every signer's fields into the original PDF and adds a signing
// certificate page at the end. pdf-lib is passed in (lib) so the edge functions use npm:pdf-lib and the Node test
// (tests/esign_pdf_test.mjs) uses the local copy. No network, no other imports.
//
// Field boxes are fractions (0 to 1) of the page as shown on screen (pdf.js uses the crop box and the page's
// rotation), measured from the top left. They're mapped back to PDF space here, rotation included, so a field
// placed on a rotated scan lands where the signer saw it.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type SignedInput = {
  id: string; title: string; file_name: string; original_sha256: string; account?: string; sent_at?: string;
  sender?: { name?: string; email?: string } | null;
  fields: Array<{ id: string; signer: string; type: string; page: number; x: number; y: number; w: number; h: number; label?: string }>;
  signers: Array<{ key: string; name: string; email: string; role?: string; ip?: string; device?: string; browser?: string; ua?: string;
    viewed_at?: string; consent_at?: string; verified_at?: string; signed_at?: string; signature?: string | null; initials?: string | null;
    signature_kind?: string | null; vals?: Record<string, unknown> }>;
  events: Array<{ at: string; kind: string; name?: string; email?: string; ip?: string; device?: string; browser?: string }>;
};

const EVENT_NAMES: Record<string, string> = {
  created: 'Created', sent: 'Sent to sign', viewed: 'Opened', consented: 'Agreed to sign electronically', code_sent: 'Code emailed',
  code_failed: 'Wrong or expired code', code_verified: 'Code checked', signed: 'Signed', reminded: 'Reminder sent', declined: 'Declined',
  voided: 'Voided', completed: 'Completed',
};

// Helvetica (WinAnsi) can't draw everything; keep plain Latin text and swap the rest for '?'
export const pdfText = (v: unknown) => String(v ?? '')
  .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[–—−]/g, '-').replace(/…/g, '...')
  .replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
export const utc = (s?: string | null) => (s ? new Date(s).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '');
const b64bytes = (dataUrl: string) => {
  const b = atob(dataUrl.replace(/^data:image\/png;base64,/, ''));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};

export async function buildSigned(lib: any, original: Uint8Array, d: SignedInput, opts: { now?: Date; verifyUrl?: string } = {}): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb, degrees } = lib;
  let pdf: any;
  try { pdf = await PDFDocument.load(original, { updateMetadata: false }); }
  catch (e) { throw new Error(/encrypt/i.test(String((e as Error)?.message)) ? 'This PDF is password protected, so it can\'t be signed here' : 'Couldn\'t read the PDF'); }
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const ink = rgb(0.06, 0.12, 0.35);
  const pages = pdf.getPages();
  const imgs = new Map<string, any>();
  const img = async (dataUrl?: string | null) => {
    if (!dataUrl) return null;
    if (!imgs.has(dataUrl)) imgs.set(dataUrl, await pdf.embedPng(b64bytes(dataUrl)));
    return imgs.get(dataUrl);
  };

  // ---------- flatten the fields ----------
  for (const s of d.signers) {
    for (const f of d.fields.filter((x) => x.signer === s.key)) {
      const page = pages[(f.page || 1) - 1];
      if (!page) continue;
      const box = page.getCropBox();
      const rot = (((page.getRotation()?.angle || 0) % 360) + 360) % 360;
      const sideways = rot === 90 || rot === 270;
      const dispW = sideways ? box.height : box.width, dispH = sideways ? box.width : box.height;
      const dx = f.x * dispW, dy = f.y * dispH, dw = f.w * dispW, dh = f.h * dispH;
      // a point on screen (from the top left) to PDF space
      const map = (px: number, py: number) => {
        if (rot === 90) return { x: box.x + py, y: box.y + px };
        if (rot === 180) return { x: box.x + box.width - px, y: box.y + py };
        if (rot === 270) return { x: box.x + box.width - py, y: box.y + box.height - px };
        return { x: box.x + px, y: box.y + box.height - py };
      };
      // a point inside the field, from its bottom left, the way the signer saw it
      const local = (lx: number, ly: number) => map(dx + lx, dy + dh - ly);
      const turn = degrees(rot);
      const v = s.vals?.[f.id];
      if (f.type === 'signature' || f.type === 'initials') {
        const im = await img(f.type === 'signature' ? s.signature : (s.initials || s.signature));
        if (!im) continue;
        const k = Math.min(dw / im.width, dh / im.height);
        const w = im.width * k, h = im.height * k;
        const o = local(0, (dh - h) / 2);
        page.drawImage(im, { x: o.x, y: o.y, width: w, height: h, rotate: turn });
      } else if (f.type === 'checkbox') {
        if (v === true || v === 'true') {
          const a = local(dw * 0.15, dh * 0.15), b = local(dw * 0.85, dh * 0.85), c = local(dw * 0.15, dh * 0.85), e = local(dw * 0.85, dh * 0.15);
          const t = Math.max(0.8, Math.min(dw, dh) * 0.12);
          page.drawLine({ start: a, end: b, thickness: t, color: ink });
          page.drawLine({ start: c, end: e, thickness: t, color: ink });
        }
      } else {
        let txt = pdfText(f.type === 'name' ? (v ?? s.name) : v);
        if (!txt) continue;
        const size = Math.max(5, Math.min(dh * 0.72, 13));
        while (txt.length > 1 && font.widthOfTextAtSize(txt, size) > dw - 2) txt = txt.slice(0, -1);
        const o = local(1, Math.max(0, (dh - size) / 2) + size * 0.22);
        page.drawText(txt, { x: o.x, y: o.y, size, font, color: ink, rotate: turn });
      }
    }
  }

  // ---------- the signing certificate ----------
  const W = 612, H = 792, M = 50;
  let pg = pdf.addPage([W, H]);
  let y = H - M;
  const newPage = () => { pg = pdf.addPage([W, H]); y = H - M; };
  const need = (h: number) => { if (y - h < M) newPage(); };
  const wrap = (t: string, f: any, size: number, width: number) => {
    const words = pdfText(t).split(' '); const lines: string[] = []; let cur = '';
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w;
      if (f.widthOfTextAtSize(next, size) <= width) { cur = next; continue; }
      if (cur) lines.push(cur);
      // a single word wider than the line (a hash): break it
      let rest = w;
      while (f.widthOfTextAtSize(rest, size) > width) { let n = rest.length; while (n > 1 && f.widthOfTextAtSize(rest.slice(0, n), size) > width) n--; lines.push(rest.slice(0, n)); rest = rest.slice(n); }
      cur = rest;
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const line = (t: string, o: { f?: any; size?: number; x?: number; gap?: number; color?: any } = {}) => {
    const f = o.f || font, size = o.size || 10, x = o.x ?? M;
    for (const l of wrap(t, f, size, W - M - x)) { need(size + 3); pg.drawText(l, { x, y: y - size, size, font: f, color: o.color || rgb(0.1, 0.12, 0.18) }); y -= size + 3; }
    y -= o.gap ?? 2;
  };
  const rule = () => { need(10); pg.drawLine({ start: { x: M, y: y - 4 }, end: { x: W - M, y: y - 4 }, thickness: 0.6, color: rgb(0.8, 0.83, 0.88) }); y -= 12; };
  const now = opts.now || new Date();

  line('Signing certificate', { f: bold, size: 18, gap: 6 });
  line(`Document: ${d.title}`, { f: bold, size: 11 });
  line(`File: ${d.file_name}`);
  line(`Envelope ID: ${d.id}`);
  if (d.sender?.name || d.account) line(`Sent by: ${[d.sender?.name, d.sender?.email ? `(${d.sender.email})` : '', d.account ? `for ${d.account}` : ''].filter(Boolean).join(' ')}`);
  if (d.sent_at) line(`Sent: ${utc(d.sent_at)}`);
  line(`Completed: ${utc(now.toISOString())}`);
  line('Original SHA-256 (the PDF before anyone signed):', { gap: 0 });
  line(d.original_sha256, { f: mono, size: 9, gap: 4 });
  line(`Every signer agreed to do business electronically, got a one-time code by email and checked it before signing. Times are the server's clock in UTC.${opts.verifyUrl ? ` Check a copy of this file at ${opts.verifyUrl}` : ''}`, { size: 9, color: rgb(0.35, 0.4, 0.5), gap: 6 });
  rule();
  line('Signers', { f: bold, size: 13, gap: 4 });
  for (const s of d.signers) {
    need(110);
    line(`${s.name}${s.role ? ` (${s.role})` : ''}`, { f: bold, size: 11, gap: 0 });
    line(s.email, { gap: 1 });
    line(`IP address: ${s.ip || 'not recorded'}    Device: ${s.device || 'unknown'}    Browser: ${s.browser || 'unknown'}`, { size: 9, gap: 0 });
    if (s.ua) line(`User agent: ${s.ua}`, { size: 7, color: rgb(0.4, 0.44, 0.52), gap: 1 });
    line(`Opened: ${utc(s.viewed_at) || '-'}    Agreed to sign electronically: ${utc(s.consent_at) || '-'}`, { size: 9, gap: 0 });
    line(`Code checked (email): ${utc(s.verified_at) || '-'}    Signed: ${utc(s.signed_at) || '-'}`, { size: 9, gap: 2 });
    const im = await img(s.signature);
    if (im) {
      const k = Math.min(160 / im.width, 40 / im.height); need(46);
      pg.drawImage(im, { x: M, y: y - im.height * k, width: im.width * k, height: im.height * k });
      pg.drawText(s.signature_kind === 'typed' ? 'typed' : 'drawn', { x: M + 170, y: y - 12, size: 8, font, color: rgb(0.4, 0.44, 0.52) });
      y -= im.height * k + 6;
    }
    y -= 6;
  }
  rule();
  line('Event log (UTC)', { f: bold, size: 13, gap: 4 });
  const cols = [M, M + 118, M + 268, M + 432];
  const row = (cells: string[], f = font) => {
    const size = 8; const wrapped = cells.map((c, i) => wrap(c, f, size, (cols[i + 1] ?? W - M) - cols[i] - 6));
    const n = Math.max(...wrapped.map((w) => w.length || 1)); need(n * (size + 2) + 4);
    wrapped.forEach((ls, i) => ls.forEach((l, j) => pg.drawText(l, { x: cols[i], y: y - size - j * (size + 2), size, font: f, color: rgb(0.1, 0.12, 0.18) })));
    y -= n * (size + 2) + 4;
  };
  row(['Time', 'What happened', 'Who', 'IP and device'], bold);
  for (const e of d.events) {
    row([utc(e.at), EVENT_NAMES[e.kind] || e.kind, [e.name, e.email ? `<${e.email}>` : ''].filter(Boolean).join(' '), [e.ip, e.device, e.browser].filter(Boolean).join(', ')]);
  }
  y -= 8;
  line('The SHA-256 of this whole signed file is kept with the envelope. If even one byte of this file changes, it won\'t match.', { size: 8, color: rgb(0.35, 0.4, 0.5) });

  pdf.setTitle(pdfText(d.title));
  pdf.setProducer('E-sign');
  pdf.setModificationDate(now);
  return await pdf.save();
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// "iPhone", "Windows computer"... and "Chrome 120" from a user agent
export function uaInfo(ua: string): { device: string; browser: string } {
  const u = ua || '';
  const device = /iPad/.test(u) ? 'iPad' : /iPhone/.test(u) ? 'iPhone' : /Android/.test(u) ? (/Mobile/.test(u) ? 'Android phone' : 'Android tablet')
    : /CrOS/.test(u) ? 'Chromebook' : /Windows/.test(u) ? 'Windows computer' : /Macintosh|Mac OS X/.test(u) ? 'Mac' : /Linux/.test(u) ? 'Linux computer' : u ? 'Other device' : 'Unknown';
  const m = (re: RegExp) => u.match(re)?.[1];
  const browser = m(/Edg(?:e|A|iOS)?\/(\d+)/) ? `Edge ${m(/Edg(?:e|A|iOS)?\/(\d+)/)}` : m(/OPR\/(\d+)/) ? `Opera ${m(/OPR\/(\d+)/)}`
    : m(/SamsungBrowser\/(\d+)/) ? `Samsung Internet ${m(/SamsungBrowser\/(\d+)/)}` : m(/(?:Firefox|FxiOS)\/(\d+)/) ? `Firefox ${m(/(?:Firefox|FxiOS)\/(\d+)/)}`
    : m(/(?:Chrome|CriOS)\/(\d+)/) ? `Chrome ${m(/(?:Chrome|CriOS)\/(\d+)/)}` : /Safari/.test(u) && m(/Version\/(\d+)/) ? `Safari ${m(/Version\/(\d+)/)}` : u ? 'Other browser' : 'Unknown';
  return { device, browser };
}
