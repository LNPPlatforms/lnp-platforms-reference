// A stand-in for Leaflet used only by the UI test (the sandbox can't reach the CDN). Real Web Mercator math, so
// clicks turn into the same latitudes and longitudes Leaflet would give; shapes draw as SVG, count markers as divs.
(function () {
  const NS = 'http://www.w3.org/2000/svg', TILE = 256;
  const proj = (lat, lng, z) => { const s = TILE * 2 ** z, sin = Math.sin((lat * Math.PI) / 180); return { x: ((lng + 180) / 360) * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s }; };
  const unproj = (x, y, z) => { const s = TILE * 2 ** z, n = Math.PI - (2 * Math.PI * y) / s; return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng: (x / s) * 360 - 180 }; };
  const ll = (a) => (Array.isArray(a) ? { lat: a[0], lng: a[1] } : a);
  class Ev {
    on(k, f) { ((this._h ||= {})[k] ||= []).push(f); return this; }
    fire(k, e) { (this._h?.[k] || []).forEach((f) => f(e || {})); return this; }
  }
  class Bounds {
    constructor(pts) { const p = pts.map(ll); this.s = Math.min(...p.map((x) => x.lat)); this.n = Math.max(...p.map((x) => x.lat)); this.w = Math.min(...p.map((x) => x.lng)); this.e = Math.max(...p.map((x) => x.lng)); }
    getSouthWest() { return { lat: this.s, lng: this.w }; } getNorthEast() { return { lat: this.n, lng: this.e }; } getCenter() { return { lat: (this.s + this.n) / 2, lng: (this.w + this.e) / 2 }; }
  }
  class FMap extends Ev {
    constructor(el) {
      super(); this.el = el; this.c = { lat: 0, lng: 0 }; this.z = 2; this.layers = new Set();
      el.classList.add('leaflet-container'); Object.assign(el.style, { position: 'relative', overflow: 'hidden', background: 'repeating-linear-gradient(45deg,#6b7b63,#6b7b63 12px,#71826a 12px,#71826a 24px)' });
      this.tp = document.createElement('div'); this.tp.className = 'leaflet-tile-pane'; el.appendChild(this.tp);
      this.svg = document.createElementNS(NS, 'svg'); Object.assign(this.svg.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' }); el.appendChild(this.svg);
      this.pane = document.createElement('div'); Object.assign(this.pane.style, { position: 'absolute', inset: '0', pointerEvents: 'none' }); el.appendChild(this.pane);
      el.addEventListener('click', (e) => { if (e.target.closest('.fake-mk,.fake-path')) return; this.fire('click', { latlng: this.evLatLng(e) }); });
      this.attributionControl = { addAttribution() {} };
    }
    evLatLng(e) { const r = this.el.getBoundingClientRect(); return this.containerPointToLatLng({ x: e.clientX - r.left, y: e.clientY - r.top }); }
    getSize() { return { x: this.el.clientWidth || 400, y: this.el.clientHeight || 300 }; }
    setView(c, z) { this.c = ll(c); if (z != null) this.z = z; this.redraw(); this.fire('moveend'); return this; }
    getCenter() { return { ...this.c }; } getZoom() { return this.z; }
    latLngToContainerPoint(a) { a = ll(a); const p = proj(a.lat, a.lng, this.z), c = proj(this.c.lat, this.c.lng, this.z), s = this.getSize(); return { x: p.x - c.x + s.x / 2, y: p.y - c.y + s.y / 2 }; }
    containerPointToLatLng(p) { const c = proj(this.c.lat, this.c.lng, this.z), s = this.getSize(); return unproj(p.x - s.x / 2 + c.x, p.y - s.y / 2 + c.y, this.z); }
    fitBounds(b, o = {}) {
      const pad = (o.padding?.[0] || 0) * 2, s = this.getSize(), sw = b.getSouthWest(), ne = b.getNorthEast();
      let z = o.maxZoom || 18;
      for (; z > 1; z--) { const a = proj(ne.lat, sw.lng, z), c = proj(sw.lat, ne.lng, z); if (c.x - a.x <= s.x - pad && c.y - a.y <= s.y - pad) break; }
      return this.setView(b.getCenter(), z);
    }
    invalidateSize() { this.redraw(); } remove() { this.el.innerHTML = ''; this.layers.clear(); }
    addLayer(l) { this.layers.add(l); l._map = this; this.redraw(); return this; }
    redraw() { this.svg.innerHTML = ''; this.pane.innerHTML = ''; this.layers.forEach((l) => l._draw?.(this)); }
  }
  class Group extends Ev {
    constructor() { super(); this.items = []; }
    addTo(m) { m.addLayer(this); return this; }
    clearLayers() { this.items = []; this._map?.redraw(); return this; }
    _draw(m) { this.items.forEach((l) => l._draw(m)); }
  }
  class Layer extends Ev {
    constructor(pts, o = {}) { super(); this.pts = pts; this.o = o; }
    addTo(g) { if (g instanceof Group) { g.items.push(this); this._map = g._map; g._map?.redraw(); } else g.addLayer(this); return this; }
    bindTooltip(t) { this.tip = t; return this; }
    tipAt(m, p) { if (!this.tip) return; const d = document.createElement('div'); d.className = 'mlabel'; d.textContent = this.tip; Object.assign(d.style, { position: 'absolute', left: p.x + 'px', top: p.y + 'px', transform: 'translate(-50%,-50%)' }); m.pane.appendChild(d); }
    clickFrom(m, el) {
      if (this.o.interactive === false) { el.style.pointerEvents = 'none'; return; }
      el.addEventListener('click', (e) => { e.stopPropagation(); this.fire('click', { latlng: m.evLatLng(e) }); if (this.o.bubblingMouseEvents !== false) m.fire('click', { latlng: m.evLatLng(e) }); });
    }
  }
  class Path extends Layer {
    _draw(m) {
      const rings = this.closed ? (Array.isArray(this.pts[0]?.[0]) ? this.pts : [this.pts]) : [this.pts];
      const d = rings.map((r) => r.map((p, i) => { const q = m.latLngToContainerPoint(p); return (i ? 'L' : 'M') + q.x + ' ' + q.y; }).join(' ') + (this.closed ? 'Z' : '')).join(' ');
      const el = document.createElementNS(NS, 'path'); el.setAttribute('d', d); el.setAttribute('class', 'fake-path');
      el.setAttribute('stroke', this.o.color || '#3388ff'); el.setAttribute('stroke-width', this.o.weight || 3);
      el.setAttribute('fill', this.closed ? this.o.fillColor || this.o.color || '#3388ff' : 'none'); el.setAttribute('fill-opacity', this.o.fillOpacity ?? 0.2); el.setAttribute('fill-rule', 'evenodd');
      if (this.o.dashArray) el.setAttribute('stroke-dasharray', this.o.dashArray);
      m.svg.appendChild(el); this.clickFrom(m, el);
      const o = rings[0].map((p) => m.latLngToContainerPoint(p));
      this.tipAt(m, { x: o.reduce((a, p) => a + p.x, 0) / o.length, y: o.reduce((a, p) => a + p.y, 0) / o.length });
    }
  }
  class Polygon extends Path { constructor(p, o) { super(p, o); this.closed = true; } }
  class CircleMarker extends Layer {
    _draw(m) {
      const p = m.latLngToContainerPoint(this.pts), r = this.o.radius || 10;
      const d = document.createElement('div'); d.className = 'fake-mk';
      Object.assign(d.style, { position: 'absolute', left: p.x - r + 'px', top: p.y - r + 'px', width: r * 2 + 'px', height: r * 2 + 'px', borderRadius: '50%', boxSizing: 'border-box',
        background: this.o.fillColor || '#3388ff', border: `${this.o.weight || 2}px solid ${this.o.color || '#fff'}`, pointerEvents: 'auto', cursor: 'pointer' });
      m.pane.appendChild(d); this.clickFrom(m, d);
    }
  }
  const tile = new (class extends Ev { addTo() { return this; } isLoading() { return false; } })();
  window.L = {
    map: (el) => new FMap(el), tileLayer: () => tile, layerGroup: () => new Group(), polygon: (p, o) => new Polygon(p, o), polyline: (p, o) => new Path(p, o),
    circleMarker: (p, o) => new CircleMarker(p, o), latLngBounds: (pts) => new Bounds(pts), control: { scale: () => ({ addTo() { return this; } }) },
  };
})();
