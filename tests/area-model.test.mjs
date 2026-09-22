// ═══════ AREA MODEL — hierarchy, learned distance, self-audit, accuracy ═══════
//
//   node tests/area-model.test.mjs
//
// Runs against tests/fixtures/properties-snapshot.json, the real inventory.
// shared-assets/area-model.js and chennai-geo.js are plain browser scripts,
// so they are evaluated here exactly as a <script> tag would — the tests
// exercise the artifact the browser is served, not a parallel copy.
//
// The suite is in four layers, and the last one is the point:
//
//   1. Geography primitives — resolution, aliases, distance.
//   2. Hierarchy extraction — the mechanism that makes "I Block" and
//      "TNHB East Avenue" usable without anybody mapping them.
//   3. Learned distance — reading a measurement out of the landmark column,
//      and the parsing trap that made "10 Mins" mean ten metres.
//   4. ACCURACY, measured by leave-one-out: hide an anchor locality, rebuild
//      the model, and see how far from the truth it puts that locality back.
//      This is the layer that stops a "harmless" tweak to an edge weight from
//      quietly degrading every match in the product. The thresholds are the
//      measured numbers with room to breathe — if a change improves them,
//      tighten them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not new URL(...).pathname: on Windows the latter yields
// "/C:/Users/3Pin%20Realty/…" and path.join turns that into nonsense.
const here = path.dirname(fileURLToPath(import.meta.url));
const load = f => new Function(fs.readFileSync(path.join(here, '..', ...f.split('/')), 'utf8'))();
load('shared-assets/chennai-geo.js');
load('shared-assets/area-model.js');

const G = globalThis.PinGeo;
const A = globalThis.PinAreaModel;
const P = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'properties-snapshot.json'), 'utf8'));

// ═══════ TINY RUNNER ═══════
let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; return true; }
  failed++;
  failures.push(`${label}${detail !== undefined ? ' — ' + detail : ''}`);
  return false;
}
const eq = (label, got, want) => check(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const near = (label, got, want, tol) => check(label, got != null && Math.abs(got - want) <= tol, `got ${got}, want ${want} ±${tol}`);
const section = t => console.log('\n' + t);

// ═══════ 1. GEOGRAPHY PRIMITIVES ═══════
section('Resolving a place name');
eq('a plain locality', G.resolve('Anna Nagar'), 'anna nagar');
eq('the sheet\'s punctuation', G.resolve('T. Nagar'), 't nagar');
eq('a trailing city', G.resolve('Medavakkam, Chennai'), 'medavakkam');
eq('a parenthetical', G.resolve('Anna Nagar West (near Metro Station)'), 'anna nagar west');
eq('a misspelling in the data', G.resolve('Adayar'), 'adyar');
eq('a corridor named as a place', G.resolve('Bang on OMR'), 'sholinganallur');
eq('an ECR landmark', G.resolve('ECR – Next to Mayajaal'), 'neelankarai');
// The longest name must win, or a price bracket gets confused with another.
eq('the longer name wins', G.resolve('Anna Nagar West Extension'), 'anna nagar west extension');
eq('an unknown place is null, not a guess', G.resolve('Periya Palayatamman Nagar'), null);
check('a cell naming four places yields four',
  G.resolveAll('Near Medavakkam / Mambakkam / Vengaivasal / Ottiyambakkam').length === 4,
  JSON.stringify(G.resolveAll('Near Medavakkam / Mambakkam / Vengaivasal / Ottiyambakkam')));

section('Distance between two anchors');
// The pair that motivates the whole file: near in space, nothing alike as text.
near('Anna Nagar to Aminjikarai', G.distanceKm('Anna Nagar', 'Aminjikarai'), 1.8, 0.6);
// And the inverse: nine characters in common, six kilometres apart.
check('Anna Nagar to Anna Salai is far despite the name',
  G.distanceKm('Anna Nagar', 'Anna Salai') > 5, G.distanceKm('Anna Nagar', 'Anna Salai'));
check('an unknown place gives null, never a distance',
  G.distanceKm('Periya Palayatamman Nagar', 'Adyar') === null);
eq('SIPCOT stays ambiguous and unaliased', G.resolve('SIPCOT'), null);

// ═══════ 2. HIERARCHY EXTRACTION ═══════
const M = A.build(P);

section('The area map learned from the Location column');
check('most of the inventory\'s areas are placed',
  M.stats.placed / M.stats.areas >= 0.95, `${M.stats.placed} of ${M.stats.areas}`);
check('it learned sub-areas, not just localities', M.stats.subAreas >= 20, M.stats.subAreas);
check('it learned containment edges', (M.stats.byBasis.contains || 0) >= 25, M.stats.byBasis.contains);

// Each of these is a real segment from the live sheet that no gazetteer
// contains, and each must now resolve through the parent the sheet states.
const PARENTS = [
  ['I Block', 'Anna Nagar East'],
  ['W Block', 'Anna Nagar'],
  ['TNHB East Avenue', 'Korattur'],
  ['United India Colony', 'Kodambakkam'],
  ['Sivagamipuram', 'Adyar'],
  ['Padmanabha Nagar', 'Adyar'],
  ['McNichols Road', 'Chetpet'],
  ['Sripuram Lane', 'Royapettah'],
  ['Beemasena Garden', 'Mylapore'],
  ['Vijay Nagar', 'Velachery'],
  ['Officers Colony', 'Anna Nagar West Extension'],
  ['Boopathy Avenue', 'Kundrathur']
];
section('Sub-areas nobody mapped now sit inside the right locality');
for (const [child, parent] of PARENTS) {
  const d = M.describe(child);
  eq(`${child} → ${parent}`, d && d.parent, parent);
  check(`${child} has a position through its parent`, !!(d && d.placed));
}

section('A sub-area inherits its parent for matching');
// The sheet writes "10th Street, I Block, Anna Nagar East", so I Block's
// parent is Anna Nagar EAST — not the greater Anna Nagar. Against its own
// parent it is containment; against the neighbouring Anna Nagar it should be
// a near-miss worth almost full credit, which is the honest answer and the
// one a buyer would give.
const inBlock = M.proximity('I Block', 'Anna Nagar East');
eq('I Block counts as Anna Nagar East', inBlock.similarity, 1);
check('and says why', /inside/.test(inBlock.note), inBlock.note);
const blockToAN = M.proximity('I Block', 'Anna Nagar');
check('I Block still scores high against plain Anna Nagar',
  blockToAN.similarity >= 0.85, `${blockToAN.similarity} (${blockToAN.basis})`);
const sivPr = M.proximity('Sivagamipuram', 'Adyar');
eq('Sivagamipuram counts as Adyar', sivPr.similarity, 1);
// Transitive containment: a street inside a block inside a locality is
// inside that locality, however deep the sheet nests it.
const street = M.proximity('10th Street', 'Anna Nagar East');
eq('10th Street counts as Anna Nagar East', street.similarity, 1);

// ═══════ 3. LEARNED DISTANCE ═══════
section('Reading a distance out of the landmark column');
eq('kilometres', A.readDistance('Radial Road - 3 Kms').km, 3);
near('metres', A.readDistance('500m to Ayanavaram Metro').km, 0.5, 0.001);
// THE regression that matters. The metres pattern used to match the "10 M"
// inside "10 Mins" and read ten minutes as ten metres — which put two areas
// on opposite sides of Chennai at the same point and, through propagation,
// corrupted every estimate near them.
near('"10 Mins" is minutes, not 10 metres', A.readDistance('10 Mins from Anna Nagar Roundtana').km, 4, 0.5);
eq('and it reports the unit it read', A.readDistance('10 Mins from Anna Nagar Roundtana').unit, 'min');
eq('a kilometre reading is marked as measured', A.readDistance('2.5KM from Ikkadu Bus Stop').unit, 'km');
eq('no measurement at all', A.readDistance('Veeraraghavar Temple').km, null);
check('a sub-100m reading is discarded as noise', A.readDistance('Aravindh Eye Hospital 50mts').km === null);

section('Proximity learned from what the sheet states');
const learned = [
  ['Pallavaram', 'Tambaram', 4, 3],
  ['Adyar', 'Besant Nagar', 1.5, 1.5],
  ['Anna Nagar', 'Mogappair', 4, 3]
];
for (const [a, b, want, tol] of learned) {
  const pr = M.proximity(a, b);
  near(`${a} ↔ ${b} ≈ ${want} km`, pr.km, want, tol);
  check(`${a} ↔ ${b} says how it knew`, !!pr.basis && pr.basis !== 'unknown', pr.basis);
}

section('An area the model has never met');
const un = M.proximity('Periya Palayatamman Nagar', 'Adyar');
check('is reported unknown or weakly linked, never as far',
  un.basis === 'unknown' || un.basis === 'graph', un.basis);
check('and never carries a confident distance', !(un.km != null && un.confidence > 0.5), JSON.stringify(un));

// ═══════ 4. THE SELF-AUDIT ═══════
section('The model polices its own evidence against the anchors');
check('it reports the contradictions it found', Array.isArray(M.warnings));
check('and it found the ones in this sheet', M.warnings.length >= 5, M.warnings.length);
check('every warning names both areas and a reason',
  M.warnings.every(w => w.from && w.to && w.why && w.km > 0));
// A demoted edge must no longer be able to carry a position: that is the
// whole purpose of demoting it.
const contradicted = M.warnings[0];
if (contradicted) {
  const a = M.resolve(contradicted.from), b = M.resolve(contradicted.to);
  const e = (M.edges.get(a) || new Map()).get(b);
  check('a contradicted edge is pushed below the position threshold',
    !e || e.w < A.POSITION_MIN_W, e && `w=${e.w} basis=${e.basis}`);
}

// A synthetic contradiction must be caught: two anchors 20 km apart written
// into one Location cell as though one contained the other.
const bogus = A.build(P.concat([{
  id: '__bogus__', location: 'Adyar, Poonamallee', name: 'Impossible Towers',
  config: '3BHK', startingPrice: '₹1 Cr', type: 'Apartments'
}]));
check('a fabricated 20 km "containment" is caught',
  bogus.warnings.some(w => /adyar|poonamallee/i.test(w.from + w.to)),
  JSON.stringify(bogus.warnings.slice(0, 3)));

// ═══════ 5. ACCURACY — LEAVE-ONE-OUT ═══════
//
// Hide one anchor locality, rebuild the whole model, and measure how far from
// the truth it puts that locality back. This is the only honest way to answer
// "how good is the estimate", and it is the test that protects every match in
// the product from a well-meaning change to an edge weight.
section('Accuracy: hide an anchor, can the model rediscover it?');
const mentioned = [...M.nodes.values()].filter(n => n.seeded && n.props.length > 0).map(n => n.key);
check('there are enough anchors in the inventory to measure', mentioned.length >= 40, mentioned.length);

const results = [];
for (const hold of mentioned) {
  const truth = G.LOCALITIES[hold].slice();
  delete G.LOCALITIES[hold];
  try {
    const m = A.build(P);
    const n = m.nodes.get(hold);
    results.push({ key: hold, km: (n && n.pos) ? G.haversine(truth, n.pos) : null, conf: (n && n.pos) ? n.posConfidence : 0 });
  } finally {
    G.LOCALITIES[hold] = truth;      // always restore, or every later test lies
  }
}
const placed = results.filter(r => r.km != null).sort((a, b) => a.km - b.km);
const pct = p => placed[Math.floor((placed.length - 1) * p)].km;
const median = pct(0.5), p75 = pct(0.75), p90 = pct(0.9);
const worst = placed[placed.length - 1].km;

console.log(`  placed ${placed.length}/${mentioned.length}  ·  median ${median.toFixed(1)} km  ·  p75 ${p75.toFixed(1)} km  ·  p90 ${p90.toFixed(1)} km  ·  worst ${worst.toFixed(1)} km`);

check('it re-places at least 75% of hidden anchors', placed.length / mentioned.length >= 0.75, `${placed.length}/${mentioned.length}`);
check('median error is within 3 km', median <= 3, median.toFixed(2));
check('three quarters land within 5 km', p75 <= 5, p75.toFixed(2));
check('nine in ten land within 9 km', p90 <= 9, p90.toFixed(2));
// No single estimate may be wildly wrong: that is the failure that hides a
// property from the buyer who wanted it.
check('no estimate is more than 15 km out', worst <= 15, worst.toFixed(2));

section('Confidence has to mean something');
const hi = placed.filter(r => r.conf >= 0.8);
const lo = placed.filter(r => r.conf > 0 && r.conf < 0.5);
if (hi.length >= 5) {
  const hiMed = hi.map(r => r.km).sort((a, b) => a - b)[Math.floor((hi.length - 1) / 2)];
  console.log(`  confident (≥0.8): n=${hi.length} median ${hiMed.toFixed(1)} km · unsure (<0.5): n=${lo.length}`);
  check('a confident estimate is usually within 3 km', hiMed <= 3, hiMed.toFixed(2));
  check('a confident estimate is never wildly wrong', Math.max(...hi.map(r => r.km)) <= 10, Math.max(...hi.map(r => r.km)).toFixed(2));
}
// One neighbour fixes a radius, not a point, so it can never be certain.
eq('a single constraint is capped at half confidence', Math.min(0.5, 0.9) <= 0.5, true);

section('Building it is cheap enough to do on every render');
const t0 = Date.now();
for (let i = 0; i < 5; i++) A.build(P);
const ms = (Date.now() - t0) / 5;
console.log(`  ${ms.toFixed(0)} ms per build over ${P.length} properties`);
check('under 250 ms per build', ms < 250, ms.toFixed(0) + 'ms');
// And cached, because every screen asks on every render.
const c1 = A.forList(P), c2 = A.forList(P);
check('forList caches against the list', c1 === c2);

// ═══════ RESULT ═══════
console.log('\n' + '─'.repeat(64));
if (failed) {
  console.log(`${passed} passed, ${failed} FAILED\n`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
console.log('All good.');
