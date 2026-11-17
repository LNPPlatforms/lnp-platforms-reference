// Area, length, totals and pricing for the measuring tool, against shapes with known sizes. Run: node tests/measure_math_test.mjs
import { ringArea, polygonArea, haversine, lineLength, pointInRing, totals, summary, priceLines, SQFT_PER_M2, FT_PER_M, unitPrice } from '../measure.js?v=test';
let bad = 0;
const near = (name, got, want, tol) => { const ok = Math.abs(got - want) <= tol; if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got.toFixed(3)} (want ${want} ± ${tol})`); };
const is = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ' want ' + JSON.stringify(want)}`); };

// one degree of longitude along the equator on Google's sphere (R 6378137) is 111,319.49 m
near('1 degree at the equator, m', haversine([0, 0], [1, 0]), 111319.49, 0.05);
// a quarter of the equator
near('90 degrees of equator, m', haversine([0, 0], [90, 0]), (Math.PI / 2) * 6378137, 0.01);
// Biloxi to Gulfport city halls is about 19.9 km
near('Biloxi to Gulfport, km', haversine([-88.8853, 30.3960], [-89.0928, 30.3674]) / 1000, 20.15, 0.3);
// the whole northern hemisphere is 2 pi R^2
const eq = [[-180, 0], [-90, 0], [0, 0], [90, 0], [180, 0], [180, 90], [-180, 90]];
near('northern hemisphere / (2 pi R^2)', ringArea(eq) / (2 * Math.PI * 6378137 ** 2), 1, 1e-9);
// a 100 m x 100 m square near Biloxi: 10,000 m2 = 107,639 sq ft (within 0.1%)
const lat = 30.4, dLat = 100 / 111319.49, dLng = 100 / (111319.49 * Math.cos((lat * Math.PI) / 180));
const sq = [[-89, lat], [-89 + dLng, lat], [-89 + dLng, lat + dLat], [-89, lat + dLat], [-89, lat]];
near('100 m square, sq ft', ringArea(sq) * SQFT_PER_M2, 107639, 110);
// the same square drawn the other way round is the same size
near('drawn backwards, sq ft', ringArea([...sq].reverse()) * SQFT_PER_M2, 107639, 110);
// a 20 m x 20 m cutout (an island) in the middle comes off: 9,600 m2
const c0 = [-89 + dLng * 0.4, lat + dLat * 0.4], c = (fx, fy) => [c0[0] + dLng * fx, c0[1] + dLat * fy];
const hole = [c(0, 0), c(0.2, 0), c(0.2, 0.2), c(0, 0.2), c(0, 0)];
near('square with a cutout, m2', polygonArea([sq, hole]), 9600, 12);
is('cutout point is inside the square', pointInRing(c(0.1, 0.1), sq), true);
is('outside point is not', pointInRing([-88.9, lat], sq), false);
// a 100 m line in three pieces is 328.08 ft
near('line, ft', lineLength([[-89, lat], [-89 + dLng * 0.3, lat], [-89 + dLng * 0.7, lat], [-89 + dLng, lat]]) * FT_PER_M, 328.084, 0.4);

// totals and prices
const items = [{ id: 'pave', name: 'Paving', unit: 'sq_ft', price: 0.25 }, { id: 'stripe', name: 'Striping', unit: 'ln_ft', price: 0.45 },
  { id: 'pole', name: 'Light pole', unit: 'each', price: 600 }, { id: 'saw', name: 'Saw cut and patch', unit: 'each', price: 150 }, { id: 'rel', name: 'Remove or relocate', unit: 'each', price: 350 }];
const types = [{ id: 'A', name: 'Paved area', kind: 'area', price_item_id: 'pave' }, { id: 'S', name: 'Striping', kind: 'length', price_item_id: 'stripe' },
  { id: 'P', name: 'Light pole', kind: 'count', price_item_id: 'pole', states: [{ key: 'count', name: 'Counted', base: true, addons: [] }, { key: 'moved', name: 'Remove or relocate', short: 'moved', base: false, addons: ['rel', 'saw'] }] },
  { id: 'X', name: 'Sign', kind: 'count', price_item_id: null, states: [{ key: 'count', name: 'Counted', base: true, addons: [] }] }];
const pt = (state, tid = 'P') => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-89, lat] }, properties: { kind: 'count', type_id: tid, state } });
const feats = [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [sq, hole] }, properties: { kind: 'area', type_id: 'A' } },
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-89, lat], [-89 + dLng, lat]] }, properties: { kind: 'length', type_id: 'S' } },
  ...Array.from({ length: 9 }, () => pt('count')), pt('moved'), pt('moved'), pt('moved'), pt('count', 'X')];
const tot = totals(feats, types);
is('area total', tot.A.qty, 103333);
is('line total', tot.S.qty, 328);
is('poles', [tot.P.qty, tot.P.states], [12, { count: 9, moved: 3 }]);
is('summary', summary(tot, types), '103,333 sq ft paved area · 328 ft striping · 12 light poles, 3 moved · 1 sign');
const lines = priceLines(tot, types, items);
is('price lines', lines.map((l) => [l.name, l.qty, l.total]), [['Paving', 103333, 25833.25], ['Striping', 328, 147.6], ['Light pole', 9, 5400], ['Remove or relocate', 3, 1050], ['Saw cut and patch', 3, 450], ['Sign', 1, 0]]);
is('missing price flagged', lines.find((l) => l.name === 'Sign').missing, true);
is('add-on note', lines.find((l) => l.name === 'Saw cut and patch').desc, 'for 3 light poles moved');
is('unit prices', [unitPrice(0.25), unitPrice(0.225), unitPrice(650)], ['$0.25', '$0.225', '$650.00']);
console.log(bad ? `${bad} FAILED` : 'all math ok');
process.exit(bad ? 1 : 0);
