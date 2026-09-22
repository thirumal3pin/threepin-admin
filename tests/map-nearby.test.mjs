// ═══════ MAP NEARBY — the answers an agent gives without leaving the page ═══════
//
//   node tests/map-nearby.test.mjs
//
// map-nearby.js is 722 lines and every Google call in it is REST — Routes,
// Places (New), Geocoding, Elevation, Street View — which means the whole
// module runs in node with an injected fetch. Until now it had no unit tests
// at all: it was exercised only through canned browser responses and through
// ad-hoc runs against the live key, so the failure paths — the ones that
// decide whether an agent tells a client something wrong — were never checked.
//
// Every request the module makes is recorded here, so the tests can assert
// what was SENT as well as what was returned. Several real defects were found
// that way and are marked below.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const load = f => new Function(readFileSync(join(ROOT, f), 'utf8'))();
for (const f of ['shared-assets/chennai-geo.js', 'shared-assets/area-model.js',
  'map-assets/geo-resolve.js', 'map-assets/map-core.js', 'map-assets/map-nearby.js']) load(f);

const N = globalThis.PinMapNearby;
let KEY = 'TEST-KEY';
globalThis.PinMapCore.apiKey = () => KEY;

let pass = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); fails.push(label); }
}
function eq(label, got, want) {
  ok(label, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
}
const section = t => { console.log(''); console.log(t); };

// Caches are module-level and would leak between cases, so each case that
// cares clears them.
const clearCaches = () => { for (const c of Object.values(N._caches)) c.clear(); };

// A fetch stand-in that records every call and replies from a queue.
function stubFetch(replies) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init, body: init && init.body ? JSON.parse(init.body) : null });
    const r = replies.shift();
    if (!r) throw new Error('stub ran out of replies for ' + url);
    if (r.throw) throw new Error(r.throw);
    return {
      ok: r.ok !== false,
      status: r.status || (r.ok === false ? 500 : 200),
      json: async () => r.json,
      text: async () => (r.text != null ? r.text : JSON.stringify(r.json || ''))
    };
  };
  impl.calls = calls;
  return impl;
}
const routeRows = n => Array.from({ length: n }, (_, i) => ({
  originIndex: 0, destinationIndex: i, condition: 'ROUTE_EXISTS',
  distanceMeters: 2000 + i * 1000, duration: (600 + i * 120) + 's'
}));
const POS = (lat, lng) => ({ lat, lng, accuracyKm: 0, label: 'somewhere', precision: 'exact' });
const ANNA = POS(13.0878, 80.2100);

// ═══════════════════════════════════════════════════════════════════════
section('TRAVEL TIMES — one request for many destinations');
// ═══════════════════════════════════════════════════════════════════════
{
  clearCaches();
  const tos = [{ id: 'a', pos: POS(13.09, 80.21) }, { id: 'b', pos: POS(13.10, 80.22) }];
  const f = stubFetch([{ json: routeRows(2) }]);
  const m = await N.travelTimes(ANNA, tos, { fetchImpl: f });
  ok('one request covers every destination', f.calls.length === 1, f.calls.length + ' requests');
  ok('both destinations come back', m.get('a') && m.get('b'));
  ok('minutes are read from the duration', m.get('a').mins === 10, JSON.stringify(m.get('a')));
  ok('kilometres are read from the distance', Math.abs(m.get('b').km - 3) < 0.01, JSON.stringify(m.get('b')));
}
{
  clearCaches();
  // Routes returns rows in any order and may omit one entirely. Reading the
  // array positionally would hand one property's drive time to another.
  const tos = [{ id: 'a', pos: POS(13.09, 80.21) }, { id: 'b', pos: POS(13.10, 80.22) }, { id: 'c', pos: POS(13.11, 80.23) }];
  const f = stubFetch([{ json: [
    { originIndex: 0, destinationIndex: 2, condition: 'ROUTE_EXISTS', distanceMeters: 9000, duration: '1800s' },
    { originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 1000, duration: '300s' }
  ] }]);
  const m = await N.travelTimes(ANNA, tos, { fetchImpl: f });
  ok('rows are matched by destinationIndex, not by position', m.get('a').mins === 5 && m.get('c').mins === 30,
    JSON.stringify([m.get('a'), m.get('c')]));
  ok('a destination with no row is simply absent', !m.has('b'));
}
{
  clearCaches();
  const f = stubFetch([]);
  const m = await N.travelTimes(ANNA, [], { fetchImpl: f });
  ok('no destinations means no request at all', f.calls.length === 0 && m.size === 0);
}
{
  clearCaches();
  const many = Array.from({ length: 40 }, (_, i) => ({ id: 'p' + i, pos: POS(13 + i / 1000, 80.2) }));
  const f = stubFetch([{ json: routeRows(24) }]);
  await N.travelTimes(ANNA, many, { fetchImpl: f });
  ok('never asks for more than the Routes ceiling', f.calls[0].body.destinations.length === N.MATRIX_MAX,
    f.calls[0].body.destinations.length + ' destinations');
}
{
  clearCaches();
  // routingPreference with TRANSIT returns HTTP 200 carrying a 400, which
  // read as "nowhere is reachable" and silently killed metro and walking.
  for (const mode of ['DRIVE', 'TWO_WHEELER']) {
    const f = stubFetch([{ json: routeRows(1) }]);
    await N.travelTimes(ANNA, [{ id: 'a', pos: POS(13.09, 80.21) }], { fetchImpl: f, mode });
    ok(mode + ' asks for live traffic', f.calls[0].body.routingPreference === 'TRAFFIC_AWARE');
    clearCaches();
  }
  for (const mode of ['TRANSIT', 'WALK', 'BICYCLE']) {
    const f = stubFetch([{ json: routeRows(1) }]);
    await N.travelTimes(ANNA, [{ id: 'a', pos: POS(13.09, 80.21) }], { fetchImpl: f, mode });
    ok(mode + ' sends no routingPreference', !('routingPreference' in f.calls[0].body),
      JSON.stringify(f.calls[0].body.routingPreference));
    clearCaches();
  }
}
{
  clearCaches();
  const f = stubFetch([{ json: [{ error: { message: 'Routing preference cannot be set for TRANSIT' } }] }]);
  const m = await N.travelTimes(ANNA, [{ id: 'a', pos: POS(13.09, 80.21) }], { fetchImpl: f, mode: 'TRANSIT' });
  ok('a refusal is surfaced, not read as an empty neighbourhood', !!m.error, JSON.stringify(m.error));
  ok('...and names the mode it happened on', /TRANSIT/.test(m.error || ''), m.error);
}
{
  clearCaches();
  const f = stubFetch([{ ok: false, status: 403, text: 'PERMISSION_DENIED' }]);
  const m = await N.travelTimes(ANNA, [{ id: 'a', pos: POS(13.09, 80.21) }], { fetchImpl: f });
  ok('an HTTP failure returns no rows rather than throwing', m instanceof Map && m.size === 0);
}
{
  clearCaches();
  const f = stubFetch([{ throw: 'network down' }]);
  const m = await N.travelTimes(ANNA, [{ id: 'a', pos: POS(13.09, 80.21) }], { fetchImpl: f });
  ok('a thrown fetch is caught', m instanceof Map && m.size === 0);
}
{
  clearCaches();
  // The mode belongs in the cache key: "how long by metro" asked after "how
  // long by car" used to return the car's number under a Metro label.
  const tos = [{ id: 'a', pos: POS(13.09, 80.21) }];
  const f = stubFetch([{ json: [{ originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 5000, duration: '600s' }] },
    { json: [{ originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 8000, duration: '3000s' }] }]);
  const drive = await N.travelTimes(ANNA, tos, { fetchImpl: f, mode: 'DRIVE' });
  const transit = await N.travelTimes(ANNA, tos, { fetchImpl: f, mode: 'TRANSIT' });
  ok('a second mode is a second request', f.calls.length === 2, f.calls.length + ' requests');
  ok('...and gets its own answer', drive.get('a').mins === 10 && transit.get('a').mins === 50,
    JSON.stringify([drive.get('a'), transit.get('a')]));
  const again = await N.travelTimes(ANNA, tos, { fetchImpl: f, mode: 'DRIVE' });
  ok('the same question twice costs one request', f.calls.length === 2 && again.get('a').mins === 10);
}
{
  // THE KEY-ARRIVES-LATE DEFECT.
  // The key is fetched from /api/public-config asynchronously, so anything
  // asked before it lands sees no key — and the empty result was being
  // CACHED under a key that does not mention it. Every later ask returned
  // that empty answer from cache and never called Routes again.
  clearCaches();
  KEY = '';
  const f = stubFetch([{ json: routeRows(1) }]);
  const tos = [{ id: 'a', pos: POS(13.09, 80.21) }];
  const first = await N.travelTimes(ANNA, tos, { fetchImpl: f });
  ok('with no key yet, no request is made', f.calls.length === 0 && first.size === 0);
  KEY = 'TEST-KEY';
  const second = await N.travelTimes(ANNA, tos, { fetchImpl: f });
  ok('once the key arrives the answer is fetched, not served from an empty cache',
    second.size === 1, 'cached the keyless result: ' + f.calls.length + ' requests, ' + second.size + ' rows');
}

// ═══════════════════════════════════════════════════════════════════════
section('PLACES — what is around this property');
// ═══════════════════════════════════════════════════════════════════════
const placeBody = names => ({
  places: names.map((n, i) => ({
    displayName: { text: typeof n === 'string' ? n : n.name },
    primaryTypeDisplayName: { text: typeof n === 'string' ? 'Hospital' : n.kind },
    rating: 4.5, userRatingCount: typeof n === 'string' ? 500 : n.reviews,
    formattedAddress: 'Chennai',
    location: { latitude: 13.09 + i * 0.002, longitude: 80.21 + i * 0.002 }
  }))
});
{
  clearCaches();
  const r = await N.placesNear(ANNA, 'not-a-category', { fetchImpl: stubFetch([]) });
  ok('an unknown category is refused, not requested', r.error === 'unknown category' && r.list.length === 0);
}
{
  clearCaches();
  KEY = '';
  const f = stubFetch([]);
  const r = await N.placesNear(ANNA, 'school', { fetchImpl: f });
  ok('no key means no Places request', f.calls.length === 0 && !!r.error);
  KEY = 'TEST-KEY';
}
{
  clearCaches();
  const f = stubFetch([{ ok: false, status: 403, text: 'Places API (New) has not been used' }]);
  const r = await N.placesNear(ANNA, 'school', { fetchImpl: f });
  ok('a 403 says which API to switch on', /Places API \(New\)/.test(r.error || ''), r.error);
}
{
  clearCaches();
  const f = stubFetch([{ json: placeBody(['Apollo', 'Apollo', 'Kauvery']) }]);
  const r = await N.placesNear(ANNA, 'hospital', { fetchImpl: f, limit: 5 });
  eq('one name appears once', r.list.map(x => x.name), ['Apollo', 'Kauvery']);
}
{
  clearCaches();
  const f = stubFetch([{ json: placeBody([
    { name: 'Bashyam Dental Care', kind: 'Dental Clinic', reviews: 900 },
    { name: 'SS CLINIC and Diagnostic Centre', kind: 'Hospital', reviews: 900 },
    { name: 'Nagavardhini seo', kind: 'Hospital', reviews: 2 },
    { name: 'Vihaa Hospital', kind: 'Hospital', reviews: 2383 }
  ]) }]);
  const r = await N.placesNear(ANNA, 'hospital', { fetchImpl: f, limit: 5 });
  eq('a hospital question is answered only by hospitals', r.list.map(x => x.name), ['Vihaa Hospital']);
  ok('...and that is not flagged as a relaxed answer', !r.relaxed);
}
{
  clearCaches();
  // Filtering to nothing is not the same as there being nothing, and the
  // agent has to be told which one happened.
  const f = stubFetch([{ json: placeBody([{ name: 'Tiny Clinic', kind: 'Medical Clinic', reviews: 1 }]) }]);
  const r = await N.placesNear(ANNA, 'hospital', { fetchImpl: f, limit: 5 });
  ok('when nothing well-known is near, the closest are still shown', r.list.length === 1, JSON.stringify(r.list));
  ok('...flagged so the panel can say so', r.relaxed === true);
}
{
  clearCaches();
  const f = stubFetch([{ json: { places: [] } }]);
  const r = await N.placesNear(ANNA, 'school', { fetchImpl: f });
  ok('a genuinely empty area returns an empty list, not an error', r.list.length === 0 && !r.error);
}
{
  clearCaches();
  const f = stubFetch([{ json: placeBody(['A', 'B']) }]);
  await N.placesNear(ANNA, 'transit', { fetchImpl: f });
  const body = f.calls[0].body;
  ok('metro asks for rail types only', (body.includedTypes || []).includes('subway_station')
    && !(body.includedTypes || []).includes('bus_station'), JSON.stringify(body.includedTypes));
  ok('...and excludes bus stops outright', (body.excludedTypes || []).includes('bus_stop'),
    JSON.stringify(body.excludedTypes));
}
{
  clearCaches();
  const f = stubFetch([{ json: placeBody(['A']) }]);
  await N.placesNear(ANNA, 'hospital', { fetchImpl: f });
  ok('hospitals are chosen by prominence, then sorted by distance here',
    f.calls[0].body.rankPreference === 'POPULARITY', f.calls[0].body.rankPreference);
  const f2 = stubFetch([{ json: placeBody(['A']) }]);
  clearCaches();
  await N.placesNear(ANNA, 'park', { fetchImpl: f2 });
  ok('an unfiltered category is still ranked by distance',
    f2.calls[0].body.rankPreference === 'DISTANCE', f2.calls[0].body.rankPreference);
}
{
  clearCaches();
  const f = stubFetch([{ json: placeBody(['A']) }]);
  await N.placesNear(ANNA, 'school', { fetchImpl: f });
  const mask = f.calls[0].init.headers['X-Goog-FieldMask'] || '';
  ok('the field mask asks for nothing it does not show', /displayName/.test(mask) && /location/.test(mask)
    && !/photos/.test(mask) && !/reviews\b/.test(mask), mask);
  ok('the key travels in a header, never in the URL',
    f.calls[0].init.headers['X-Goog-Api-Key'] === 'TEST-KEY' && !/key=/.test(f.calls[0].url));
}
{
  clearCaches();
  const f = stubFetch([{ json: placeBody(['Far', 'Near']) }]);
  const r = await N.placesNear(ANNA, 'park', { fetchImpl: f, limit: 5 });
  ok('results are ordered nearest first', r.list[0].km <= r.list[1].km,
    JSON.stringify(r.list.map(x => x.km)));
  ok('each carries a distance an agent can say out loud', typeof r.list[0].say === 'string' && r.list[0].say.length > 0);
}
{
  clearCaches();
  const f = stubFetch([{ json: placeBody(['A']) }]);
  await N.placesNear(ANNA, 'school', { fetchImpl: f });
  await N.placesNear(ANNA, 'school', { fetchImpl: f });
  ok('the same category twice costs one request', f.calls.length === 1, f.calls.length + ' requests');
}

// ═══════════════════════════════════════════════════════════════════════
section('GEOCODING — "how far from my office in Guindy"');
// ═══════════════════════════════════════════════════════════════════════
const geoOK = (type = 'ROOFTOP') => ({ status: 'OK', results: [{
  geometry: { location: { lat: 13.0102, lng: 80.2123 }, location_type: type },
  formatted_address: 'Guindy, Chennai, Tamil Nadu 600032, India' }] });
{
  clearCaches();
  const f = stubFetch([{ json: geoOK() }]);
  const r = await N.geocodeText('Guindy', { fetchImpl: f });
  ok('a bare place name is pinned to Chennai', /Chennai/.test(decodeURIComponent(f.calls[0].url)), f.calls[0].url);
  ok('...and to India', /components=country:IN/.test(f.calls[0].url));
  ok('...and bounded to the city', /bounds=/.test(f.calls[0].url));
  ok('a rooftop match is exact', r.precise === true && r.accuracyKm === 0, JSON.stringify(r));
}
{
  clearCaches();
  const f = stubFetch([{ json: geoOK('APPROXIMATE') }]);
  const r = await N.geocodeText('Adyar', { fetchImpl: f });
  ok('a locality match is NOT promoted to exact', r.precise === false && r.accuracyKm > 0, JSON.stringify(r));
}
{
  clearCaches();
  const f = stubFetch([{ json: geoOK() }]);
  await N.geocodeText('Guindy, Chennai', { fetchImpl: f });
  const addr = decodeURIComponent(f.calls[0].url);
  ok('a text that already says Chennai is not made to say it twice',
    (addr.match(/Chennai/g) || []).length === 1, addr);
}
{
  clearCaches();
  const f = stubFetch([]);
  const r = await N.geocodeText('   ', { fetchImpl: f });
  ok('empty text asks nothing', f.calls.length === 0 && r === null);
}
{
  clearCaches();
  const f = stubFetch([{ json: { status: 'ZERO_RESULTS', results: [] } }]);
  const r = await N.geocodeText('zzzzqqq', { fetchImpl: f });
  ok('no match returns null rather than a guess', r === null);
}
{
  clearCaches();
  const f = stubFetch([{ throw: 'offline' }]);
  const r = await N.geocodeText('Guindy', { fetchImpl: f });
  ok('a thrown fetch returns null rather than throwing', r === null);
}

// ═══════════════════════════════════════════════════════════════════════
section('DISTANCE TO — the whole answer, end to end');
// ═══════════════════════════════════════════════════════════════════════
{
  clearCaches();
  const f = stubFetch([{ json: geoOK() }, { json: [{ originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 13200, duration: '3060s' }] }]);
  const r = await N.distanceTo(ANNA, 'Guindy', { fetchImpl: f });
  ok('it resolves the place then routes to it', r.ok === true && f.calls.length === 2);
  ok('the drive is reported', r.drive && r.drive.mins === 51, JSON.stringify(r.drive));
  ok('the straight line is reported too', typeof r.say === 'string' && r.say.length > 0, r.say);
  ok('the destination is named back to the agent', /Guindy/.test(r.to.formatted), r.to.formatted);
}
{
  clearCaches();
  const f = stubFetch([{ json: { status: 'ZERO_RESULTS', results: [] } }]);
  const r = await N.distanceTo(ANNA, 'nowhere at all', { fetchImpl: f });
  ok('an unfindable place is reported as such', r.ok === false && !!r.error, JSON.stringify(r));
  ok('...and does not go on to route to nothing', f.calls.length === 1);
}
{
  clearCaches();
  const f = stubFetch([{ json: geoOK() }, { json: [] }]);
  const r = await N.distanceTo(ANNA, 'Guindy', { fetchImpl: f });
  ok('no route still answers with the straight-line distance', r.ok === true && !r.drive && !!r.say);
}
{
  clearCaches();
  const f = stubFetch([{ json: geoOK() }, { json: [{ error: { message: 'bad request' } }] }]);
  const r = await N.distanceTo(ANNA, 'Guindy', { fetchImpl: f, mode: 'TRANSIT' });
  ok('a routing refusal is passed through so the panel can say why', !!r.routeError, JSON.stringify(r.routeError));
}
{
  clearCaches();
  for (const m of N.MODES) {
    const f = stubFetch([{ json: geoOK() }, { json: [{ originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 1000, duration: '600s' }] }]);
    const r = await N.distanceTo(ANNA, 'Guindy', { fetchImpl: f, mode: m.key });
    ok(m.key + ' is a mode the panel can offer', r.ok === true && r.mode === m.key && !!r.modeVerb);
    clearCaches();
  }
}

// ═══════════════════════════════════════════════════════════════════════
section('ELEVATION — "does that area get water?"');
// ═══════════════════════════════════════════════════════════════════════
{
  // Calibrated against this city: Velachery sits at 21m and Anna Nagar at
  // 31m, and an earlier cut called both "higher ground".
  const bands = [[2, 'low'], [7.9, 'low'], [8, 'lowish'], [14.9, 'lowish'],
    [15, 'mid'], [21.1, 'mid'], [24.9, 'mid'], [25, 'high'], [30.9, 'high'], [60, 'high']];
  for (const [m, key] of bands) ok('ground at ' + m + 'm reads as ' + key, N.elevationBand(m).key === key, N.elevationBand(m).key);
  ok('Velachery and Anna Nagar do not read the same', N.elevationBand(21.1).say !== N.elevationBand(30.9).say);
  ok('an unknown height says nothing', N.elevationBand(null) === null);
}
{
  clearCaches();
  const f = stubFetch([{ json: { status: 'OK', results: [{ elevation: 21.14 }] } }]);
  const r = await N.elevationOf(ANNA, { fetchImpl: f });
  ok('a height comes back with its band', r && r.metres === 21.1 && r.band.key === 'mid', JSON.stringify(r));
}
{
  clearCaches();
  const f = stubFetch([{ json: { status: 'INVALID_REQUEST', results: [] } }]);
  const r = await N.elevationOf(ANNA, { fetchImpl: f });
  ok('a refusal returns nothing rather than a made-up height', r === null);
}

// ═══════════════════════════════════════════════════════════════════════
section('STREET VIEW — "what does the road look like?"');
// ═══════════════════════════════════════════════════════════════════════
{
  clearCaches();
  const f = stubFetch([{ json: { status: 'OK', date: '2026-04', location: { lat: 13.08, lng: 80.21 } } }]);
  const r = await N.streetView(ANNA, { fetchImpl: f });
  ok('imagery is reported with the date it was taken', r && r.date === '2026-04', JSON.stringify(r));
}
{
  clearCaches();
  const f = stubFetch([{ json: { status: 'ZERO_RESULTS' } }]);
  const r = await N.streetView(ANNA, { fetchImpl: f });
  ok('no imagery is reported as no imagery', r === null);
}

// ═══════════════════════════════════════════════════════════════════════
section('DIRECTIONS LINK — the handover to Google, when the agent wants it');
// ═══════════════════════════════════════════════════════════════════════
{
  const u = N.directionsUrl(null, POS(13.01, 80.21), 'DRIVE');
  ok('with no origin, Google routes from the device', !/origin=/.test(u), u);
  ok('the destination is in the link', /destination=13\.01/.test(u), u);
  for (const [mode, word] of [['DRIVE', 'driving'], ['TRANSIT', 'transit'], ['WALK', 'walking']]) {
    ok(mode + ' hands over as ' + word, N.directionsUrl(null, POS(13, 80), mode).includes('travelmode=' + word));
  }
}

// ═══════════════════════════════════════════════════════════════════════
section('NEARBY PROPERTIES — free, from what we already hold');
// ═══════════════════════════════════════════════════════════════════════
{
  const mk = (id, lat, lng, price) => ({ p: { id, propertyCode: id }, pos: POS(lat, lng), priceLo: price, priceHi: price });
  const anchor = mk('anchor', 13.0878, 80.2100, 30000000);
  const items = [anchor,
    mk('near', 13.0900, 80.2120, 25000000),
    mk('far', 13.3000, 80.4000, 25000000),
    mk('pricey', 13.0890, 80.2110, 90000000)];
  const r = N.nearbyProperties(anchor, items, { km: 5, limit: 10 });
  ok('the property itself is never its own neighbour', !r.some(x => x.p.id === 'anchor'));
  ok('something 25km away is not "nearby"', !r.some(x => x.p.id === 'far'));
  ok('something 300m away is', r.some(x => x.p.id === 'near'));
  const capped = N.nearbyProperties(anchor, items, { km: 5, limit: 10, maxPrice: 30000000 });
  ok('a budget cap removes what is over it', !capped.some(x => x.p.id === 'pricey'));
  ok('...and says how many it removed, so the agent knows they exist',
    capped.excluded && capped.excluded.overBudget === 1, JSON.stringify(capped.excluded));
}

// ═══════════════════════════════════════════════════════════════════════
section('WITHIN MINUTES — "what else is 30 minutes from here?"');
// ═══════════════════════════════════════════════════════════════════════
{
  clearCaches();
  const mk = (id, lat, lng) => ({ p: { id, propertyCode: id }, pos: POS(lat, lng), priceLo: 1e7, priceHi: 1e7 });
  const anchor = mk('anchor', 13.0878, 80.2100);
  const items = [anchor, mk('a', 13.0900, 80.2120), mk('b', 13.0950, 80.2200)];
  const f = stubFetch([{ json: [
    { originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS', distanceMeters: 2000, duration: '600s' },
    { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_EXISTS', distanceMeters: 30000, duration: '5400s' }
  ] }]);
  const r = await N.withinMinutes(anchor, items, 30, { fetchImpl: f });
  eq('only what really is within the time', r.list.map(x => x.p.id), ['a']);
  ok('the answer is marked as measured, not estimated', r.priced === true);
}
{
  clearCaches();
  const anchor = { p: { id: 'anchor' }, pos: ANNA, priceLo: 1e7, priceHi: 1e7 };
  const f = stubFetch([{ json: [{ error: { message: 'quota' } }] }]);
  const r = await N.withinMinutes(anchor, [anchor, { p: { id: 'a' }, pos: POS(13.09, 80.212), priceLo: 1e7, priceHi: 1e7 }], 30, { fetchImpl: f });
  ok('a refusal is not reported as an empty neighbourhood', !!r.error && r.list.length === 0, JSON.stringify(r));
}

// ═══════════════════════════════════════════════════════════════════════
section('CACHING — a dropped request must not become a permanent answer');
// ═══════════════════════════════════════════════════════════════════════
// An agent on Chennai mobile data drops requests. Every one of these caches
// used to store the failure, so one blip killed the feature for the rest of
// the session — instantly, from cache, with no error to explain it.
{
  clearCaches();
  const tos = [{ id: 'a', pos: POS(13.09, 80.21) }];
  const f = stubFetch([{ ok: false, status: 503 }, { json: routeRows(1) }]);
  const bad = await N.travelTimes(ANNA, tos, { fetchImpl: f });
  ok('a 503 returns nothing', bad.size === 0);
  const good = await N.travelTimes(ANNA, tos, { fetchImpl: f });
  ok('...and the next ask tries again rather than repeating it', good.size === 1 && f.calls.length === 2,
    f.calls.length + ' requests, ' + good.size + ' rows');
}
{
  clearCaches();
  const tos = [{ id: 'a', pos: POS(13.09, 80.21) }];
  const f = stubFetch([{ throw: 'connection reset' }, { json: routeRows(1) }]);
  await N.travelTimes(ANNA, tos, { fetchImpl: f });
  const good = await N.travelTimes(ANNA, tos, { fetchImpl: f });
  ok('a dropped connection is retried too', good.size === 1 && f.calls.length === 2);
}
{
  clearCaches();
  const f = stubFetch([{ ok: false, status: 503 }, { json: placeBody(['Apollo']) }]);
  await N.placesNear(ANNA, 'school', { fetchImpl: f });
  const good = await N.placesNear(ANNA, 'school', { fetchImpl: f });
  ok('a failed Places request is retried', good.list.length === 1 && f.calls.length === 2,
    f.calls.length + ' requests');
}
{
  clearCaches();
  const f = stubFetch([{ json: { places: [] } }, { json: placeBody(['Apollo']) }]);
  await N.placesNear(ANNA, 'school', { fetchImpl: f });
  const again = await N.placesNear(ANNA, 'school', { fetchImpl: f });
  ok('but a real "nothing there" IS remembered, and costs nothing twice',
    again.list.length === 0 && f.calls.length === 1, f.calls.length + ' requests');
}
{
  clearCaches();
  const f = stubFetch([{ throw: 'offline' }, { json: geoOK() }]);
  await N.geocodeText('Guindy', { fetchImpl: f });
  const good = await N.geocodeText('Guindy', { fetchImpl: f });
  ok('a blip does not make an address permanently unfindable', !!good && f.calls.length === 2,
    f.calls.length + ' requests');
}
{
  clearCaches();
  const f = stubFetch([{ json: { status: 'ZERO_RESULTS', results: [] } }, { json: geoOK() }]);
  await N.geocodeText('zzzqqq', { fetchImpl: f });
  const again = await N.geocodeText('zzzqqq', { fetchImpl: f });
  ok('but a place that does not exist is only looked up once',
    again === null && f.calls.length === 1, f.calls.length + ' requests');
}
{
  clearCaches();
  const f = stubFetch([{ throw: 'offline' }, { json: { status: 'OK', results: [{ elevation: 21.1 }] } }]);
  await N.elevationOf(ANNA, { fetchImpl: f });
  const good = await N.elevationOf(ANNA, { fetchImpl: f });
  ok('a blip does not make the ground height unknowable', !!good && f.calls.length === 2);
}

console.log('');
console.log('─'.repeat(64));
if (fails.length) {
  console.log(fails.length + ' failing of ' + (pass + fails.length) + ':');
  fails.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
console.log(pass + ' checks, all good.');
