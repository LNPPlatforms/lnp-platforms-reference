/* pdfpages.js: shows a PDF's pages with an overlay on each, for the e-sign field editor (esign.js) and the signing
   page (sign/sign.js). pdf.js loads from jsDelivr at a pinned version the first time it's needed (like Leaflet for
   the measuring tool). Pages draw when they scroll into view. Each page gets a wrapper with the page's own shape
   (rotation included, the way pdf.js shows it), so field boxes kept as fractions of the page line up at any width. */
export const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/';
let lib = null;
export async function pdfjs() {
  if (lib) return lib;
  lib = await import(PDFJS_URL + 'pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc = PDFJS_URL + 'pdf.worker.min.mjs';
  return lib;
}
// src: bytes (Uint8Array or ArrayBuffer) or a URL
export async function openPdf(src) {
  const L = await pdfjs();
  const args = typeof src === 'string' ? { url: src } : { data: src instanceof Uint8Array ? src.slice() : new Uint8Array(src.slice(0)) };
  return L.getDocument({ ...args, isEvalSupported: false }).promise;
}
// [{w, h}] in points, the way each page shows
export async function pageSizes(doc) {
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) { const v = (await doc.getPage(n)).getViewport({ scale: 1 }); out.push({ w: Math.round(v.width * 100) / 100, h: Math.round(v.height * 100) / 100 }); }
  return out;
}
// draws every page into box; returns [{n, el (the wrapper), ov (the overlay), w, h}]
export async function renderPages(box, doc, { label = 'Page' } = {}) {
  box.innerHTML = '';
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const v = page.getViewport({ scale: 1 });
    const el = document.createElement('div');
    el.className = 'pdfpage'; el.dataset.page = n;
    el.style.aspectRatio = `${v.width} / ${v.height}`;
    el.innerHTML = `<canvas aria-label="${label} ${n}"></canvas><div class="pdfov"></div><small class="pdfnum">${n} / ${doc.numPages}</small>`;
    box.appendChild(el);
    pages.push({ n, el, ov: el.querySelector('.pdfov'), w: v.width, h: v.height, page, drawn: false });
  }
  const draw = async (p) => {
    if (p.drawn) return; p.drawn = true;
    const c = p.el.querySelector('canvas');
    const scale = Math.min(3, Math.max(1, (p.el.clientWidth || 800) * (window.devicePixelRatio || 1) / p.w));
    const vp = p.page.getViewport({ scale });
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    try { await p.page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp }).promise; } catch (e) { p.drawn = false; console.warn('page draw', e); }
  };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { const p = pages.find((x) => x.el === e.target); if (p) draw(p); } }), { rootMargin: '600px 0px' });
    pages.forEach((p) => io.observe(p.el));
  } else pages.forEach(draw);
  if (pages[0]) await draw(pages[0]);
  return pages;
}
export const pageCss = `.pdfpage{position:relative;width:100%;background:#fff;box-shadow:0 1px 4px rgba(20,30,50,.18);margin:0 auto 14px;touch-action:pan-y;user-select:none}
.pdfpage canvas{position:absolute;inset:0;width:100%;height:100%;display:block}.pdfov{position:absolute;inset:0}
.pdfnum{position:absolute;right:6px;bottom:-18px;font-size:11px;color:#7C8AA6}`;
