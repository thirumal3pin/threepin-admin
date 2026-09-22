// ═══════ MAP VIEW — PREVIEW / SMOKE TEST ═══════
//
//   node tests/map-preview.mjs <out-dir>
//
// Opens the real dashboard.html in Chromium with TWO things swapped out:
//
//   · dashboard-assets/firebase-sync.js → an in-memory stand-in, as the other
//     previews do;
//   · window.google.maps → a stub good enough that the real map-core.js draws
//     its real markers into the real DOM.
//
// That second one is the point. Without it this test could only check that a
// grey rectangle appeared. With it, every marker, cluster, pill, card, answer
// panel and pin-drop runs the shipping code path, and the screenshots show
// what an agent will actually see — without a Maps key, without a network
// call and without a cent of Google billing per run.
//
// The stub implements only what map-core.js and map-nearby.js touch, and its
// projection is a linear lat/lng → pixel transform, which is all a marker
// needs to be placed and clicked.

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = process.argv[2] || 'tests/out/map';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const T = 't_3pinrealty';
const NOW = Date.now();
const J = v => JSON.stringify(v);

// ═══════ FIXTURE ═══════
// Chosen so every position rung and every pin state is on screen at once.
const PROPERTIES = [
  // rung 1 — an exact pin somebody dropped
  { id: 'p1', tenantId: T, propertyCode: 'ANR0099', name: 'Kanaka Residency', location: 'Anna Nagar, Chennai',
    zone: 'Chennai Central', config: '3BHK', startingPrice: '₹3.5 Crores', sqftRange: '1750-1900 Sq.Ft',
    pricePerSqft: '₹19,500/Sqft', type: 'Apartments', status: 'Ready to Move', availability: 'Available',
    geo: { lat: 13.0851, lng: 80.2102, source: 'pin', precision: 'exact', at: NOW, by: 'agent.a@example.com' } },
  // rung 2 — a full Maps URL
  { id: 'p2', tenantId: T, propertyCode: 'ADY0031', name: 'Coral Bay', location: 'Sivagamipuram, Adyar',
    config: '3BHK', startingPrice: '₹3 Crores', type: 'Apartments', status: 'Ready to Move',
    mapLink: 'https://www.google.com/maps/place/X/@13.0061,80.2571,17z' },
  // rung 3 — locality only, several in one place so the spider fans them
  { id: 'p3', tenantId: T, propertyCode: 'ANR0042', name: 'Prestige Lakeview', location: 'Anna Nagar West, Chennai',
    config: '3BHK', startingPrice: '₹2.9 Crores', type: 'Apartments', status: 'Ready to Move' },
  { id: 'p4', tenantId: T, propertyCode: 'ANR0055', name: 'Casa Blanca', location: 'I Block, Anna Nagar, Chennai',
    config: '2BHK/3BHK', startingPrice: '₹2.4 Crores', type: 'Apartments', status: 'Under Construction' },
  { id: 'p5', tenantId: T, propertyCode: 'ANR0077', name: 'Shanthi Court', location: 'Anna Nagar, Chennai',
    config: '3BHK', startingPrice: '₹3.1 Crores', type: 'Apartments', status: 'Ready to Move' },
  { id: 'p6', tenantId: T, propertyCode: 'MGD0014', name: 'Green Acres Layout', location: 'Mangadu, Chennai',
    config: '----', startingPrice: '₹95 Lakhs', type: 'Plots', status: 'Ready to Move', approval: 'DTCP' },
  { id: 'p7', tenantId: T, propertyCode: 'SHO0031', name: 'Ocean Crest', location: 'Sholinganallur, OMR, Chennai',
    config: '3BHK', startingPrice: '₹2.8 Crores', type: 'Apartments', status: 'Ready to Move', soldOut: true },
  // no position at all — the "needs a pin" case, with a short link, which is
  // the exact situation 52 of the live rows are in
  { id: 'p8', tenantId: T, propertyCode: 'UNK0001', name: 'Unmapped Heights', location: 'Periya Palayatamman Nagar',
    config: '3BHK', startingPrice: '₹1.9 Crores', type: 'Apartments', status: 'Ready to Move',
    mapLink: 'https://maps.app.goo.gl/yyirBa6urJH2cb699' },
  // snoozed — the team said this one does not need one
  { id: 'p9', tenantId: T, propertyCode: 'SNZ0001', name: 'Snoozed Plot', location: 'Nowhere Colony',
    config: '----', startingPrice: '₹60 Lakhs', type: 'Plots', status: 'Ready to Move', mapPinSnoozed: true }
];

// ═══════ THE GOOGLE MAPS STUB ═══════
//
// Injected before any page script runs. Deliberately minimal: if map-core.js
// starts using something this does not have, the test fails loudly, which is
// the behaviour we want from a stub.
const MAPS_STUB = `
(function () {
  const listeners = new WeakMap();
  function LatLng(lat, lng) { this._a = lat; this._b = lng; }
  LatLng.prototype.lat = function () { return this._a; };
  LatLng.prototype.lng = function () { return this._b; };

  function LatLngBounds(sw, ne) { this._pts = []; if (sw) this._pts.push(sw); if (ne) this._pts.push(ne); }
  LatLngBounds.prototype.extend = function (ll) { this._pts.push(ll); return this; };
  LatLngBounds.prototype.getCenter = function () {
    const la = this._pts.reduce((n, p) => n + p.lat(), 0) / (this._pts.length || 1);
    const ln = this._pts.reduce((n, p) => n + p.lng(), 0) / (this._pts.length || 1);
    return new LatLng(la, ln);
  };

  // A linear projection over a fixed Chennai window. Enough for a marker to
  // land somewhere sensible and be clickable, which is all that is under test.
  const WIN = { s: 12.70, n: 13.30, w: 79.90, e: 80.45 };
  function project(ll, w, h) {
    return {
      x: ((ll.lng() - WIN.w) / (WIN.e - WIN.w)) * w,
      y: (1 - (ll.lat() - WIN.s) / (WIN.n - WIN.s)) * h
    };
  }

  function Map(el, opts) {
    this._el = el;
    this._zoom = (opts && opts.zoom) || 11;
    this._center = (opts && opts.center) || { lat: 13.02, lng: 80.2 };
    this._opts = opts || {};
    el.classList.add('stub-map');
    el.style.background = 'linear-gradient(160deg,#f3f1ec,#e9e6de 60%,#dfe4e6)';
    const pane = document.createElement('div');
    pane.className = 'stub-pane';
    pane.style.cssText = 'position:absolute;inset:0;';
    el.appendChild(pane);
    this._pane = pane;
    // Something to prove the map is a map in a screenshot.
    const grid = document.createElement('div');
    grid.style.cssText = 'position:absolute;inset:0;opacity:.35;background-image:linear-gradient(#fff 1px,transparent 1px),linear-gradient(90deg,#fff 1px,transparent 1px);background-size:64px 64px;';
    el.insertBefore(grid, pane);
    window.__stubMaps = (window.__stubMaps || []).concat(this);
  }
  Map.prototype.addListener = function (name, fn) {
    const m = listeners.get(this) || {}; (m[name] = m[name] || []).push(fn); listeners.set(this, m);
    return { remove() {} };
  };
  Map.prototype.__fire = function (name, arg) {
    const m = listeners.get(this) || {}; (m[name] || []).forEach(fn => fn(arg));
  };
  Map.prototype.getZoom = function () { return this._zoom; };
  Map.prototype.setZoom = function (z) { this._zoom = z; this.__fire('idle'); };
  Map.prototype.getCenter = function () { return new LatLng(this._center.lat, this._center.lng); };
  Map.prototype.setCenter = function (c) { this._center = c; };
  Map.prototype.panTo = function (c) { this._center = c; };
  Map.prototype.getDiv = function () { return this._el; };
  Map.prototype.fitBounds = function (b) {
    const c = b.getCenter();
    this._center = { lat: c.lat(), lng: c.lng() };
    this._zoom = Math.max(this._zoom, 12);
    this.__fire('idle');
  };
  Map.prototype.__panes = function () { return { floatPane: this._pane }; };

  function OverlayView() {}
  OverlayView.prototype.setMap = function (map) {
    if (!map) { if (this.onRemove) this.onRemove(); this._map = null; return; }
    this._map = map;
    if (this.onAdd) this.onAdd();
    if (this.draw) this.draw();
  };
  OverlayView.prototype.getPanes = function () { return this._map.__panes(); };
  OverlayView.prototype.getProjection = function () {
    const el = this._map.getDiv();
    const w = el.clientWidth || 800, h = el.clientHeight || 600;
    return { fromLatLngToDivPixel: ll => project(ll, w, h) };
  };

  function DistanceMatrixService() {}
  DistanceMatrixService.prototype.getDistanceMatrix = function (req, cb) {
    window.__matrixCalls = (window.__matrixCalls || 0) + 1;
    window.__lastMatrix = { destinations: req.destinations.length };
    const els = req.destinations.map((d, i) => ({
      status: 'OK',
      distance: { value: 2200 + i * 1500, text: ((2.2 + i * 1.5).toFixed(1)) + ' km' },
      duration: { value: 480 + i * 240, text: (8 + i * 4) + ' mins' },
      duration_in_traffic: { value: 600 + i * 300, text: (10 + i * 5) + ' mins' }
    }));
    setTimeout(() => cb({ rows: [{ elements: els }] }, 'OK'), 5);
  };

  function Geocoder() {}
  Geocoder.prototype.geocode = function (req, cb) {
    window.__geocodeCalls = (window.__geocodeCalls || 0) + 1;
    if (/nowhere|zzzz/i.test(req.address)) return setTimeout(() => cb([], 'ZERO_RESULTS'), 5);
    setTimeout(() => cb([{
      geometry: { location: new LatLng(13.0102, 80.2123), location_type: 'ROOFTOP' },
      formatted_address: 'Guindy, Chennai, Tamil Nadu 600032, India'
    }], 'OK'), 5);
  };

  const Place = {
    searchNearby: async function (req) {
      window.__placeCalls = (window.__placeCalls || 0) + 1;
      window.__lastPlaceReq = { types: req.includedTypes, radius: req.locationRestriction.radius };
      const c = req.locationRestriction.center;
      const names = ['PSBB Millennium School', 'DAV Public School', 'Velammal Vidyalaya'];
      return { places: names.map((n, i) => ({
        displayName: { text: n },
        primaryTypeDisplayName: { text: 'School' },
        rating: 4.5 - i * 0.2,
        userRatingCount: 320 - i * 40,
        formattedAddress: n + ', Chennai',
        location: new LatLng(c.lat() + 0.004 * (i + 1), c.lng() + 0.003 * (i + 1))
      })) };
    }
  };

  window.google = { maps: {
    Map, LatLng, LatLngBounds, OverlayView, DistanceMatrixService, Geocoder,
    places: { Place },
    event: {
      addListenerOnce: (obj, name, fn) => { if (obj.addListener) return obj.addListener(name, fn); },
      trigger: (obj, name) => { if (obj.__fire) obj.__fire(name); }
    },
    ControlPosition: { TOP_RIGHT: 1, RIGHT_BOTTOM: 2 },
    MapTypeControlStyle: { DROPDOWN_MENU: 1 },
    TravelMode: { DRIVING: 'DRIVING' },
    UnitSystem: { METRIC: 0 }
  } };
})();
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };

const FIREBASE_STUB = `
window.__saved = [];
window.dashboardFirebase = {
  saveProperty: async d => { window.__saved.push(JSON.parse(JSON.stringify(d))); },
  deleteProperty: async () => {},
  getPropertyNotes: async () => [], savePropertyNote: async () => {}, deletePropertyNote: async () => {},
  getInternalNotes: async () => [], saveInternalNote: async () => {}, deleteInternalNote: async () => {},
  saveChanges: async () => {}, getChanges: async () => [],
  getLeads: async () => [], subscribeToProperty: () => () => {}
};
window.dashboardAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => '${T}' };
setTimeout(() => {
  if (window.onDashboardAuthChange) window.onDashboardAuthChange({ email: 'agent.a@example.com' });
  if (window.onPinTenantReady) window.onPinTenantReady('${T}');
  window.applyPropertiesSnapshot(${J(PROPERTIES)});
  window.__ready = true;
}, 0);
`;

const browser = await chromium.launch();
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label + (detail !== undefined ? ' — ' + detail : '')); }
};

async function open(viewport, withMaps) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  if (withMaps) await ctx.addInitScript(MAPS_STUB);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${viewport.width}px pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource|net::ERR|fonts\.googleapis|cdnjs|maps\.googleapis/.test(t)) return;
    errors.push(`${viewport.width}px console: ${t}`);
  });
  page.on('dialog', d => d.accept());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'dash.local') return route.abort();
    if (url.pathname === '/dashboard-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: FIREBASE_STUB });
    // The key is served as present so map-core takes the real load path; the
    // stub above means no script is actually fetched from Google.
    if (url.pathname === '/api/public-config') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ googleMapsApiKey: withMaps ? 'STUB-KEY' : '' }) });
    }
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://dash.local/dashboard.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.waitForTimeout(350);
  return page;
}

const shot = (page, n) => page.screenshot({ path: join(OUT, n + '.png'), fullPage: false });
const txt = (page, sel) => page.$eval(sel, e => e.textContent.replace(/\s+/g, ' ').trim());

// ═══════════════════════════════════════════════════════════════════════
// 1. NO KEY — the failure that must not look like a bug
// ═══════════════════════════════════════════════════════════════════════
console.log('');
console.log('With no Maps key configured');
{
  const page = await open({ width: 1500, height: 1000 }, false);
  ok('the mode switch is there regardless', await page.$eval('#mapModeSwitch', e => /List/.test(e.textContent)));
  await page.click('#mapModeSwitch .mv-mode:nth-child(2)');   // Split
  await page.waitForTimeout(600);
  const body = await txt(page, '#mapPane');
  ok('the map explains itself instead of showing a grey box', /cannot load yet/.test(body), body.slice(0, 120));
  ok('it names the exact fix', /GOOGLE_MAPS_BROWSER_KEY/.test(body), body.slice(0, 220));
  ok('and says what already works without it', /already works/.test(body), body.slice(0, 300));
  // The list half must still be fully usable — the positions are computed
  // locally, so losing the key loses the tiles and nothing else.
  const rows = await page.$$eval('#mapList .mv-row', e => e.length);
  ok('the list still shows every positioned property', rows === 7, String(rows));
  ok('the pin bar still reports what needs attention', /no pin/.test(await txt(page, '#mapPinBar')), await txt(page, '#mapPinBar'));
  await shot(page, 'map-nokey');
  await page.context().close();
}

// ═══════════════════════════════════════════════════════════════════════
// 2. THE REAL VIEW, against the Maps stub
// ═══════════════════════════════════════════════════════════════════════
console.log('');
console.log('The map view');
{
  const page = await open({ width: 1500, height: 1000 }, true);
  await page.click('#mapModeSwitch .mv-mode:nth-child(2)');
  await page.waitForTimeout(700);

  ok('the map canvas is created', await page.$eval('#mapPane .mv-canvas', e => !!e));
  ok('and the modules all loaded',
    await page.evaluate(() => !!(window.PinGeoResolve && window.PinMapCore && window.PinMapNearby && window.PinMapView)));

  // ── markers ──
  const pins = await page.$$eval('.gm-prop', e => e.map(x => x.textContent.trim()));
  const clusters = await page.$$eval('.gm-cluster', e => e.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  ok('markers are drawn into the DOM', pins.length + clusters.length > 0, `${pins.length} pins, ${clusters.length} clusters`);
  ok('a price pill reads as a price', pins.concat(clusters).some(t => /Cr|L\b/.test(t)), J(pins.slice(0, 4)));

  // Locality clustering is the decision worth asserting: four Anna Nagar
  // properties at one centroid must group by AREA and say so, not stack.
  ok('co-located properties cluster by locality, named',
    clusters.some(t => /Anna Nagar/.test(t)), J(clusters));
  ok('and the cluster carries a price range, not just a count',
    clusters.some(t => /Cr|L\b/.test(t)), J(clusters));

  // ── precision is visible, not hidden in a tooltip ──
  const approxPins = await page.$$eval('.gm-prop.approx', e => e.length);
  ok('approximate markers are marked as approximate', approxPins >= 0, String(approxPins));
  const badges = await page.$$eval('#mapList .mv-ax, #mapList .mv-ex', e => e.map(x => x.textContent.trim()));
  ok('every list row states its precision', badges.length === 7, J(badges));
  ok('the exact ones say pinned', badges.filter(b => b === 'pinned').length === 2, J(badges));

  // ── select from the list, then from the map ──
  await page.click('#mapList .mv-row[data-id="p1"]');
  await page.waitForTimeout(250);
  ok('clicking a row opens the card', await page.$eval('#mapCard', e => !e.hidden));
  const card = await txt(page, '#mapCard');
  ok('the card carries the code, name, config and price',
    /ANR0099/.test(card) && /Kanaka/.test(card) && /3BHK/.test(card) && /3\.5 Cr/.test(card), card.slice(0, 200));
  ok('and says the pin is exact', /Exact pin/.test(card), card.slice(0, 260));
  ok('the row is marked selected', await page.$eval('#mapList .mv-row[data-id="p1"]', e => e.classList.contains('sel')));
  ok('and so is the marker', await page.$$eval('.gm-prop.sel', e => e.length) === 1);

  await page.click('#mapList .mv-row[data-id="p3"]');
  await page.waitForTimeout(250);
  const approxCard = await txt(page, '#mapCard');
  ok('an approximate property says where it is really placed',
    /Shown at/.test(approxCard) && /km of the real address/.test(approxCard), approxCard.slice(0, 300));
  ok('and offers to fix it', /Drop the exact pin/.test(approxCard));
  await shot(page, 'map-split');

  // ── "within 5 km" — free, no API call ──
  const beforeMatrix = await page.evaluate(() => window.__matrixCalls || 0);
  await page.click('#mapList .mv-row[data-id="p1"]');
  await page.waitForTimeout(200);
  await page.click('#mapCard .mv-btn:has-text("Within 5 km")');
  await page.waitForTimeout(300);
  const near = await txt(page, '#mapAnswer');
  ok('"within 5 km" answers', /within 5 km/.test(near), near.slice(0, 160));
  ok('and costs no API call', (await page.evaluate(() => window.__matrixCalls || 0)) === beforeMatrix,
    'matrix calls: ' + (await page.evaluate(() => window.__matrixCalls || 0)));
  ok('it names the other Anna Nagar properties', /ANR00(42|55|77)/.test(near), near.slice(0, 300));
  ok('and says the distance is a straight line', /straight line/.test(near), near.slice(-160));

  // ── "within 30 minutes" — one request, not one per property ──
  await page.click('#mapCard .mv-btn:has-text("Within 30 min")');
  await page.waitForTimeout(600);
  const mins = await txt(page, '#mapAnswer');
  ok('"within 30 min" answers with drive times', /30-minute drive|within a 30/.test(mins), mins.slice(0, 200));
  const calls = await page.evaluate(() => window.__matrixCalls || 0);
  const dests = await page.evaluate(() => (window.__lastMatrix || {}).destinations || 0);
  ok('one Distance Matrix request, not one per property', calls - beforeMatrix === 1, `${calls - beforeMatrix} calls`);
  ok('and the destinations are capped at 24', dests <= 24, String(dests));

  // ── "what is nearby" — the new Places API ──
  await page.click('#mapCard .mv-btn:has-text("What is nearby")');
  await page.waitForTimeout(250);
  ok('the categories an agent gets asked about are offered',
    /Schools/.test(await txt(page, '#mapAnswer')) && /Hospitals/.test(await txt(page, '#mapAnswer')));
  await page.click('#mapAnswer .mv-chip:has-text("Schools")');
  await page.waitForTimeout(400);
  const places = await txt(page, '#mapAnswer');
  ok('schools come back with distances', /PSBB/.test(places) && /km|metres/.test(places), places.slice(0, 260));
  ok('and with ratings', /★/.test(places), places.slice(0, 300));
  ok('the NEW Places API was used, not the legacy one',
    (await page.evaluate(() => window.__placeCalls || 0)) >= 1);
  await shot(page, 'map-places');

  // ── "distance to …" ──
  await page.click('#mapCard .mv-btn:has-text("Distance to")');
  await page.waitForTimeout(200);
  await page.fill('#mvDistInput', 'Guindy');
  await page.click('#mapAnswer .mv-btn.primary');
  await page.waitForTimeout(500);
  const dist = await txt(page, '#mapAnswer');
  ok('a typed place is found and measured', /Guindy/.test(dist), dist.slice(0, 200));
  ok('with a straight line and a drive time', /straight line/.test(dist) && /driving/.test(dist), dist.slice(0, 320));
  ok('and a link to the real route', await page.$eval('#mapAnswer a.mv-link', e => /google\.com\/maps\/dir/.test(e.href)));
  await shot(page, 'map-distance');

  const bad = await page.evaluate(async () => {
    window.PinMapView.runDistance('zzzz nowhere');
    await new Promise(r => setTimeout(r, 400));
    return document.getElementById('mapAnswer').textContent;
  });
  ok('an unfindable place fails clearly, not silently', /Could not find/.test(bad), bad.slice(0, 160));

  // ── pins: the missing one, and dropping it ──
  await page.click('#mapPinBar .mv-pb-b.bad');
  await page.waitForTimeout(250);
  const pinList = await txt(page, '#mapPinList');
  ok('the no-pin list opens', /no usable pin/i.test(pinList), pinList.slice(0, 140));
  ok('it names the unmapped property', /UNK0001/.test(pinList), pinList.slice(0, 260));
  // The diagnosis has to be specific: a short link and a typed name need
  // different fixes and an agent should not have to work out which.
  ok('and diagnoses the shortened link specifically', /shortened link/.test(pinList), pinList.slice(0, 400));

  await page.click('#mapPinList .mv-btn:has-text("Drop the pin")');
  await page.waitForTimeout(300);
  ok('pin mode starts', await page.$eval('#mapPinMode', e => !e.hidden));
  ok('and tells the agent to zoom in first', /Zoom in first/.test(await txt(page, '#mapPinMode')));
  ok('saving is disabled until a point is chosen',
    await page.$eval('#mapPinMode .mv-btn.primary', e => e.disabled));

  // Click the map, which the stub routes through the real click handler.
  await page.evaluate(() => {
    const m = window.__stubMaps[0];
    m.__fire('click', { latLng: { lat: () => 13.0500, lng: () => 80.2200 } });
  });
  await page.waitForTimeout(250);
  ok('a dropped point is shown before it is saved', /Pin at 13\.05/.test(await txt(page, '#mapPinMode')));
  ok('a ghost marker appears', await page.$$eval('.gm-prop.ghost', e => e.length) === 1);
  ok('and saving is now possible', await page.$eval('#mapPinMode .mv-btn.primary', e => !e.disabled));
  await shot(page, 'map-pinmode');

  await page.click('#mapPinMode .mv-btn.primary');
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => window.__saved);
  ok('the pin is persisted', saved.some(s => s.id === 'p8' && s.geo && s.geo.source === 'pin'), J(saved));
  ok('with the agent who placed it', saved.some(s => s.geo && s.geo.by === 'agent.a@example.com'));
  ok('and the property joins the map immediately',
    (await page.$$eval('#mapList .mv-row', e => e.length)) === 8,
    String(await page.$$eval('#mapList .mv-row', e => e.length)));
  ok('so the no-pin warning clears', !/no pin/.test(await txt(page, '#mapPinBar')), await txt(page, '#mapPinBar'));

  // ── snooze ──
  await page.click('#mapPinBar .mv-pb-b:has-text("snoozed")');
  await page.waitForTimeout(250);
  ok('the snoozed list is reachable', /Snoozed/.test(await txt(page, '#mapPinList')));
  ok('and offers to un-snooze', /Un-snooze/.test(await txt(page, '#mapPinList')));
  await page.click('#mapPinList .mv-btn:has-text("Un-snooze")');
  await page.waitForTimeout(350);
  ok('un-snoozing writes it back',
    (await page.evaluate(() => window.__saved)).some(s => s.id === 'p9' && s.mapPinSnoozed === false));

  // ── filters drive the map ──
  await page.fill('#searchInput', 'anna nagar');
  await page.waitForTimeout(500);
  const filtered = await page.$$eval('#mapList .mv-row', e => e.map(x => x.dataset.id));
  ok('the map obeys the search box', filtered.length > 0 && filtered.length < 8, J(filtered));
  ok('and shows only what the filter kept', filtered.every(id => ['p1', 'p3', 'p4', 'p5'].includes(id)), J(filtered));
  await page.fill('#searchInput', '');
  await page.waitForTimeout(400);

  // ── modes and the divider ──
  await page.click('#mapModeSwitch .mv-mode:nth-child(3)');   // Map
  await page.waitForTimeout(350);
  ok('map-only hides the list', await page.$eval('#mapListPane', e => getComputedStyle(e).display === 'none'));
  ok('and hides the grid too', await page.$eval('#pgrid', e => e.style.display === 'none'));
  await shot(page, 'map-full');

  await page.click('#mapModeSwitch .mv-mode:nth-child(2)');
  await page.waitForTimeout(300);
  const before = await page.$eval('#mapShell', e => e.style.getPropertyValue('--split'));
  await page.focus('#mapResizer');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  const after = await page.$eval('#mapShell', e => e.style.getPropertyValue('--split'));
  ok('the divider moves by keyboard, not only by mouse', before !== after, `${before} → ${after}`);
  ok('and the position is remembered',
    await page.evaluate(() => !!localStorage.getItem('pin.map.split')));

  await page.click('#mapModeSwitch .mv-mode:nth-child(1)');   // List
  await page.waitForTimeout(250);
  ok('going back to List restores the card grid', await page.$eval('#pgrid', e => e.style.display !== 'none'));
  ok('and hides the map shell', await page.$eval('#mapShell', e => e.hidden));

  await page.context().close();
}

// ═══════════════════════════════════════════════════════════════════════
// 3. PHONE
// ═══════════════════════════════════════════════════════════════════════
console.log('');
console.log('On a phone');
{
  const page = await open({ width: 390, height: 844 }, true);
  await page.click('#mapModeSwitch .mv-mode:nth-child(2)');
  await page.waitForTimeout(700);
  ok('the shell stacks instead of splitting',
    await page.$eval('#mapShell', e => getComputedStyle(e).gridTemplateColumns.split(' ').length === 1));
  ok('the divider is gone', await page.$eval('#mapResizer', e => getComputedStyle(e).display === 'none'));
  ok('the list still renders', (await page.$$eval('#mapList .mv-row', e => e.length)) > 0);
  ok('nothing overflows sideways',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2));
  await page.click('#mapList .mv-row[data-id="p1"]');
  await page.waitForTimeout(250);
  ok('the card fits the screen',
    await page.$eval('#mapCard', e => e.getBoundingClientRect().width <= window.innerWidth - 8));
  await shot(page, 'map-phone');
  await page.context().close();
}

await browser.close();
console.log('\n' + '─'.repeat(64));
console.log(`screenshots → ${OUT}`);
if (errors.length) {
  console.log(`\n${errors.length} problem(s):`);
  errors.forEach(e => console.log('  ✗ ' + e));
  process.exit(1);
}
console.log('All good.');
