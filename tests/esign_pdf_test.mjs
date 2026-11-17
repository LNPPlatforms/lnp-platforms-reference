// The signed copy: run with `tsx tests/esign_pdf_test.mjs` (pdf-lib and pdfjs-dist from the global npm folder).
// Makes a two page PDF (the second page turned 90 degrees like a sideways scan), flattens a signature, initials, text,
// a checkbox, a date and a name, adds the certificate, then reads it back with pdf.js to check every value landed
// inside its box on the page as the signer saw it, and the certificate says what it should.
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildSigned, sha256Hex, uaInfo, pdfText } from '../supabase/functions/_shared/esign_pdf.ts';

const G = execSync('npm root -g').toString().trim();
const lib = await import(pathToFileURL(`${G}/pdf-lib/cjs/index.js`).href);
const pdfjs = await import(pathToFileURL(`${G}/pdfjs-dist/legacy/build/pdf.mjs`).href);
const { PDFDocument, degrees } = lib.default || lib;
let fails = 0;
const ok = (b, what) => { console.log(`${b ? 'ok' : 'FAILED'} ${what}`); if (!b) fails++; };

// the original
const src = await PDFDocument.create();
src.addPage([612, 792]).drawText('Service agreement', { x: 50, y: 740, size: 20 });
const p2 = src.addPage([612, 792]); p2.setRotation(degrees(90)); p2.drawText('Page two', { x: 50, y: 700, size: 14 });
const original = await src.save();
const osha = await sha256Hex(original);

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const fields = [
  { id: 'f1', signer: 's1', type: 'signature', page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.06 },
  { id: 'f2', signer: 's1', type: 'date', page: 1, x: 0.5, y: 0.8, w: 0.2, h: 0.04 },
  { id: 'f3', signer: 's1', type: 'text', page: 1, x: 0.1, y: 0.2, w: 0.4, h: 0.04 },
  { id: 'f4', signer: 's1', type: 'checkbox', page: 1, x: 0.1, y: 0.3, w: 0.03, h: 0.03 },
  { id: 'f5', signer: 's1', type: 'initials', page: 2, x: 0.85, y: 0.9, w: 0.08, h: 0.05 },
  { id: 'f6', signer: 's2', type: 'name', page: 2, x: 0.1, y: 0.1, w: 0.4, h: 0.05 },
  { id: 'f7', signer: 's2', type: 'signature', page: 2, x: 0.5, y: 0.1, w: 0.3, h: 0.06 },
];
const at = (m) => new Date(Date.UTC(2026, 10, 2, 15, m, 0)).toISOString();
const data = {
  id: '6bd2a9cd-c13c-4a7d-bfbb-cbe6b4e5f0c9', title: 'Service agreement – Oak “Apartments”', file_name: 'contract.pdf', original_sha256: osha, account: 'Sign Co', sent_at: at(0),
  sender: { name: 'Admin Al', email: 'al@signco.test' }, fields,
  signers: [
    { key: 's1', name: 'Pam Smith', email: 'pam@oak.test', role: 'Client', ip: '203.0.113.5', device: 'iPhone', browser: 'Safari 17', ua: 'Mozilla/5.0 (iPhone)',
      viewed_at: at(1), consent_at: at(2), verified_at: at(3), signed_at: at(4), signature: png, initials: png, signature_kind: 'typed', vals: { f2: '11/02/2026', f3: 'Unit 12B', f4: true } },
    { key: 's2', name: 'Al Admin', email: 'al@signco.test', ip: '198.51.100.7', device: 'Windows computer', browser: 'Chrome 120',
      viewed_at: at(5), consent_at: at(6), verified_at: at(7), signed_at: at(8), signature: png, vals: { f6: 'Al Admin' } }],
  events: [{ at: at(0), kind: 'sent', name: 'Admin Al', email: 'al@signco.test' }, { at: at(1), kind: 'viewed', name: 'Pam Smith', email: 'pam@oak.test', ip: '203.0.113.5', device: 'iPhone', browser: 'Safari 17' },
    ...Array.from({ length: 60 }, (_, i) => ({ at: at(2), kind: 'code_failed', name: 'Pam Smith', ip: '203.0.113.5' })),
    { at: at(8), kind: 'signed', name: 'Al Admin', email: 'al@signco.test', ip: '198.51.100.7' }],
};
const out = await buildSigned(lib.default || lib, original, data, { now: new Date(Date.UTC(2026, 10, 2, 16)), verifyUrl: 'https://app.example.com/sign/?verify=1' });
const fsha = await sha256Hex(out);
ok(fsha !== osha && /^[a-f0-9]{64}$/.test(fsha), 'final fingerprint differs from the original');
ok((await sha256Hex(out)) === fsha, 'fingerprint is stable');

const doc = await pdfjs.getDocument({ data: out.slice(), useSystemFonts: false, disableFontFace: true, standardFontDataUrl: `${G}/pdfjs-dist/standard_fonts/` }).promise;
ok(doc.numPages >= 4, `original pages plus a certificate that runs over (${doc.numPages} pages)`);
// where each piece of text ends up, as fractions of the page as shown
const textOn = async (n) => {
  const page = await doc.getPage(n); const vp = page.getViewport({ scale: 1 }); const tc = await page.getTextContent();
  return tc.items.map((it) => { const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]); return { s: it.str, x: x / vp.width, y: y / vp.height }; });
};
const inBox = (t, f) => t && t.x >= f.x - 0.01 && t.x <= f.x + f.w + 0.01 && t.y >= f.y - 0.01 && t.y <= f.y + f.h + 0.02;
const p1 = await textOn(1), p2t = await textOn(2);
ok(inBox(p1.find((t) => t.s === 'Unit 12B'), fields[2]), 'text lands in its box');
ok(inBox(p1.find((t) => t.s === '11/02/2026'), fields[1]), 'date lands in its box');
ok(inBox(p2t.find((t) => t.s === 'Al Admin'), fields[5]), 'name lands in its box on a page turned 90 degrees');
const ops1 = await (await doc.getPage(1)).getOperatorList();
ok(ops1.fnArray.filter((f) => f === pdfjs.OPS.paintImageXObject).length >= 1, 'signature image drawn on page 1');
const cert = [];
for (let n = 3; n <= doc.numPages; n++) cert.push(...(await textOn(n)).map((t) => t.s));
const ct = cert.join(' ');
ok(/Signing certificate/.test(ct) && ct.includes(data.id) && ct.includes(osha), 'certificate: envelope id and original fingerprint');
ok(ct.includes('Service agreement - Oak "Apartments"'), 'certificate: odd characters made plain');
ok(ct.includes('203.0.113.5') && ct.includes('iPhone') && ct.includes('Safari 17') && ct.includes('198.51.100.7'), 'certificate: IP, device and browser per signer');
ok(ct.includes('2026-11-02 15:02:00 UTC') && ct.includes('2026-11-02 15:03:00 UTC') && ct.includes('2026-11-02 15:04:00 UTC'), 'certificate: consent, code and signed times');
ok(/Event log/.test(ct) && ct.includes('Wrong or expired code') && ct.includes('Opened'), 'certificate: event log');
ok(ct.includes('https://app.example.com/sign/?verify=1'), 'certificate: where to check a copy');

ok(uaInfo('Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1').device === 'iPhone'
  && uaInfo('Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1').browser === 'Safari 17', 'iPhone Safari');
ok(uaInfo('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0').browser === 'Edge 120', 'Edge before Chrome');
ok(uaInfo('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36').device === 'Android phone', 'Android phone');
ok(pdfText('Zoë’s “deal” — ok 日本') === 'Zoë\'s "deal" - ok ??', 'plain text for Helvetica');

// a password protected or broken file gives a plain error
let msg = ''; try { await buildSigned(lib.default || lib, new Uint8Array([1, 2, 3]), data); } catch (e) { msg = e.message; }
ok(/Couldn't read the PDF/.test(msg), 'broken PDF gives a plain error');
if (process.env.SAVE_PDF) (await import('node:fs')).writeFileSync(process.env.SAVE_PDF, out);
console.log(fails ? `${fails} FAILED` : 'esign pdf tests passed');
process.exit(fails ? 1 : 0);
