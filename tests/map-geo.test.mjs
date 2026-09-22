// ═══════ MAP GEO RESOLUTION — where a property is, and how sure we are ═══════
//
//   node tests/map-geo.test.mjs
//
// The map's foundation, and the module most able to do quiet damage: every
// distance an agent quotes to a client on the phone is computed from what
// this returns. So the tests care as much about the HONESTY of a position as
// about the position itself — a coordinate with the wrong precision label is
// worse than no coordinate, because it is a confident wrong answer.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = f => new Function(fs.readFileSync(path.join(here, '..', ...f.split('/')), 'utf8'))();
load('shared-assets/chennai-geo.js');
load('shared-assets/area-model.js');
load('map-assets/geo-resolve.js');

const R = globalThis.PinGeoResolve;
const A = globalThis.PinAreaModel;
const P = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'properties-snapshot.json'), 'utf8'));
const AREA = A.forList(P);

let passed = 0, failed = 0;
const failures = [];
const check = (l, c, d) => { if (c) { passed++; return true; } failed++; failures.push(l + (d !== undefined ? ' — ' + d : '')); return false; };
const eq = (l, g, w) => check(l, g === w, `got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);
const section = t => console.log('\n' + t);
const near = (l, g, w, tol) => check(l, g != null && Math.abs(g - w) <= tol, `got ${g}, want ${w}±${tol}`);

// ═══════ 1. COORDINATES OUT OF A MAPS URL ═══════
section('Reading a coordinate out of a Location Pin');
const c1 = R.coordsFromMapLink('https://www.google.com/maps/place/X/@13.0853,80.2101,17z');
near('the camera position in an @ link (lat)', c1 && c1.lat, 13.0853, 0.0001);
near('the camera position in an @ link (lng)', c1 && c1.lng, 80.2101, 0.0001);
const c2 = R.coordsFromMapLink('https://maps.google.com/?q=13.0067,80.2570');
near('a ?q= pair', c2 && c2.lat, 13.0067, 0.0001);
// !3d/!4d is the PLACE, not the camera, so it has to win.
const c3 = R.coordsFromMapLink('https://www.google.com/maps/place/A/@13.5,80.5,17z/data=!3d12.9175!4d80.1923');
near('place data beats the camera position', c3 && c3.lat, 12.9175, 0.0001);
// The most common way a coordinate arrives broken. Chennai's two ranges do
// not overlap, so it is correctable rather than merely rejectable.
const c4 = R.coordsFromMapLink('80.2101,13.0853');
near('a swapped pair is corrected, not rejected', c4 && c4.lat, 13.0853, 0.0001);
eq('a short link yields nothing', R.coordsFromMapLink('https://maps.app.goo.gl/yyirBa6urJH2cb699'), null);
check('but is recognised as a short link', R.isShortMapLink('https://maps.app.goo.gl/yyirBa6urJH2cb699'));
eq('a project name in the URL column yields nothing', R.coordsFromMapLink('Adityaram Palace City'), null);
check('and is not mistaken for a URL', !R.looksLikeUrl('Adityaram Palace City'));
// A coordinate in another city is a parsing accident, not a property.
eq('a coordinate outside Chennai is refused', R.coordsFromMapLink('https://maps.google.com/?q=19.0760,72.8777'), null);
eq('and so is nonsense', R.coordsFromMapLink('?q=999,999'), null);
eq('an empty pin is fine', R.coordsFromMapLink(''), null);

// ═══════ 2. THE LADDER ═══════
section('The ladder, rung by rung');
const base = { id: 'x', location: 'Anna Nagar, Chennai' };

const stored = R.positionOf({ ...base, geo: { lat: 13.0851, lng: 80.2102, source: 'pin', precision: 'exact' } }, { area: AREA });
eq('a stored pin is exact', stored.precision, 'exact');
eq('and says a person placed it', stored.source, 'pin');
eq('with no accuracy caveat', stored.accuracyKm, null);

const viaLink = R.positionOf({ ...base, mapLink: 'https://maps.google.com/?q=13.0067,80.2570' }, { area: AREA });
eq('a full Maps URL is exact', viaLink.precision, 'exact');
eq('and says where it came from', viaLink.source, 'maplink');

const viaLocality = R.positionOf(base, { area: AREA });
eq('a locality is approximate', viaLocality.precision, 'approx');
eq('and admits it is only the locality', viaLocality.source, 'locality');
check('with an accuracy in kilometres', viaLocality.accuracyKm >= 1, viaLocality.accuracyKm);
check('and says which area it was placed at', /Anna Nagar/.test(viaLocality.label), viaLocality.label);

// A stored pin must beat a Location Pin URL, which must beat the locality.
const all = R.positionOf({
  ...base,
  geo: { lat: 13.0851, lng: 80.2102, source: 'pin', precision: 'exact' },
  mapLink: 'https://maps.google.com/?q=13.0067,80.2570'
}, { area: AREA });
near('the stored pin wins over everything', all.lat, 13.0851, 0.0001);

// The rung that only the area model can reach: a street inside a locality.
const street = R.positionOf({ id: 's', location: 'TNHB East Avenue, Korattur, Chennai - 600080' }, { area: AREA });
check('a street is placed through its locality', !!street, 'not placed');
if (street) {
  check('and says which one', /Korattur/.test(street.label), street.label);
  eq('as an approximate position', street.precision, 'approx');
}

section('An unknown place is never guessed');
const nowhere = R.positionOf({ id: 'n', location: 'Periya Palayatamman Nagar' }, { area: AREA });
eq('no position at all', nowhere, null);
eq('and it reads as needing a pin', R.pinState({ id: 'n', location: 'Periya Palayatamman Nagar' }, { area: AREA }), 'missing');

// ═══════ 3. WHAT NEEDS ATTENTION ═══════
section('Pin state and the advice that goes with it');
eq('an exact pin needs nothing',
  R.pinState({ id: 'a', geo: { lat: 13.08, lng: 80.21, source: 'pin', precision: 'exact' } }, { area: AREA }), 'exact');
eq('a locality position wants sharpening',
  R.pinState({ id: 'b', location: 'Adyar' }, { area: AREA }), 'approx');
eq('a snoozed property is left alone',
  R.pinState({ id: 'c', location: 'Adyar', mapPinSnoozed: true }, { area: AREA }), 'snoozed');
eq('and gets no advice', R.pinAdvice({ id: 'c', location: 'Adyar', mapPinSnoozed: true }, { area: AREA }), null);
eq('nor does an exact one',
  R.pinAdvice({ id: 'a', geo: { lat: 13.08, lng: 80.21, source: 'pin', precision: 'exact' } }, { area: AREA }), null);

// The advice has to name the actual obstacle, because each one has a
// different fix and an agent should not have to guess which.
const shortAdv = R.pinAdvice({ id: 'd', location: 'Nowhereville', mapLink: 'https://maps.app.goo.gl/abc' }, { area: AREA });
check('a short link is diagnosed as a short link', /shortened link/.test(shortAdv.why), shortAdv.why);
check('and the fix is to paste the full URL', /full URL|drop the pin/i.test(shortAdv.fix), shortAdv.fix);
const nameAdv = R.pinAdvice({ id: 'e', location: 'Nowhereville', mapLink: 'Adityaram Palace City' }, { area: AREA });
check('a name in the URL column is diagnosed as that', /holds a name/.test(nameAdv.why), nameAdv.why);
const approxAdv = R.pinAdvice({ id: 'f', location: 'Adyar' }, { area: AREA });
eq('an approximate position is low severity, not an error', approxAdv.severity, 'low');
check('and says how far out it could be', /about [\d.]+ km/.test(approxAdv.why), approxAdv.why);

// ═══════ 4. WRITING A PIN BACK ═══════
section('Saving a pin');
const patch = R.pinPatch(13.0851234567, 80.2102345678, 'agent@example.com');
eq('the source records that a person placed it', patch.geo.source, 'pin');
eq('precision is exact', patch.geo.precision, 'exact');
// Six decimal places is about 10 cm. More is noise pretending to be data.
eq('coordinates are rounded to ~10 cm', patch.geo.lat, 13.085123);
check('the placer is recorded', patch.geo.by === 'agent@example.com');
check('and placing a pin un-snoozes it', patch.mapPinSnoozed === false);
eq('a pin outside Chennai is refused', R.pinPatch(19.076, 72.8777), null);
check('a swapped pin is corrected', R.pinPatch(80.21, 13.08).geo.lat === 13.08);
check('snoozing records who and when', !!R.snoozePatch('a@example.com').mapPinSnoozedAt);

section('A geocode result is not automatically exact');
// ROOFTOP is a building. GEOMETRIC_CENTER is a road or a locality — rung 3
// accuracy wearing a smarter hat, and promoting it would be a lie.
const fakeGeocode = type => async () => ([{
  geometry: { location: { lat: () => 13.0851, lng: () => 80.2102 }, location_type: type },
  formatted_address: 'Somewhere, Chennai'
}]);
const roof = await R.geocodeProperty({ name: 'X', location: 'Anna Nagar' }, fakeGeocode('ROOFTOP'));
eq('ROOFTOP is exact', roof.precision, 'exact');
const centre = await R.geocodeProperty({ name: 'X', location: 'Anna Nagar' }, fakeGeocode('GEOMETRIC_CENTER'));
eq('GEOMETRIC_CENTER is only approximate', centre.precision, 'approx');
eq('and is stored as such', centre.patch.geo.precision, 'approx');
const off = await R.geocodeProperty({ name: 'X', location: 'Y' }, async () => ([{
  geometry: { location: { lat: () => 19.076, lng: () => 72.8777 }, location_type: 'ROOFTOP' }
}]));
check('a result outside Chennai is refused', !off.ok, JSON.stringify(off));
const none = await R.geocodeProperty({ name: 'X', location: 'Y' }, async () => ([]));
check('nothing found is reported, not thrown', !none.ok && /not found/.test(none.error));
check('no geocoder at all is survivable', !(await R.geocodeProperty({}, null)).ok);
// The address must pin the city and state, or "Anna Nagar" resolves to a
// street of that name in another state.
check('the address sent is bounded to Chennai',
  /Chennai/.test(R.addressFor({ name: 'X', location: 'Adyar' })) && /Tamil Nadu/.test(R.addressFor({ name: 'X', location: 'Adyar' })),
  R.addressFor({ name: 'X', location: 'Adyar' }));
check('and the city is not repeated when it is already there',
  (R.addressFor({ name: 'X', location: 'Adyar, Chennai' }).match(/Chennai/g) || []).length === 1,
  R.addressFor({ name: 'X', location: 'Adyar, Chennai' }));

// ═══════ 5. HOW A DISTANCE MAY BE SAID ═══════
section('A distance is never stated more precisely than it is known');
eq('two exact positions give a figure', R.sayDistance(3.2, 0, 0), '3 km');
// Two locality centroids 1.2 km apart could be touching or 4 km apart. An
// agent must not read "1.2 km" off that and say it on a call.
check('two approximate positions give a range',
  /roughly|about|under/.test(R.sayDistance(1.2, 1.5, 1.5)), R.sayDistance(1.2, 1.5, 1.5));
check('one approximate end still widens it',
  /roughly|about/.test(R.sayDistance(3.2, 1.5, 0)), R.sayDistance(3.2, 1.5, 0));
near('the maths itself is right', R.haversine({ lat: 13.0853, lng: 80.2101 }, { lat: 13.0067, lng: 80.257 }), 10.1, 0.5);

// ═══════ 6. OVER THE REAL INVENTORY ═══════
section('The whole inventory, with no API key and no geocoding');
const located = R.locate(P, { area: AREA });
const c = located.counts;
console.log(`  ${c.exact} exact · ${c.approx} approximate · ${c.missing} unplaced · ${c.snoozed} snoozed  (of ${c.total})`);
eq('every property is accounted for', c.exact + c.approx + c.missing + c.snoozed, P.length);
// The whole point of rung 3: a useful map on day one, before anybody drops a
// single pin and without a geocoding bill.
check('almost everything is on the map already', (c.exact + c.approx) / c.total >= 0.95, `${c.exact + c.approx}/${c.total}`);
check('and what is not is listed, not dropped', located.missing.length === c.missing);
check('every unplaced property carries advice', located.missing.every(m => m.advice && m.advice.why && m.advice.fix));
check('every placed property carries a precision', located.placed.every(x => x.pos.precision === 'exact' || x.pos.precision === 'approx'));
check('and every approximate one carries an accuracy',
  located.placed.filter(x => x.pos.precision === 'approx').every(x => x.pos.accuracyKm > 0));
// Nothing may be placed outside Chennai — a marker in the Bay of Bengal is
// how a map loses an agent's trust in one glance.
check('nothing lands outside Chennai', located.placed.every(x => R.inChennai(x.pos.lat, x.pos.lng)));

section('Speed and caching');
const t0 = Date.now();
for (let i = 0; i < 20; i++) R.locate(P, { area: AREA });
check('locating the inventory is cached', Date.now() - t0 < 400, (Date.now() - t0) + 'ms for 20 passes');

console.log('\n' + '─'.repeat(64));
if (failed) {
  console.log(`${passed} passed, ${failed} FAILED\n`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
console.log('All good.');
