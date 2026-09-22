// ═══════ THE REAL GOOGLE MAPS API, THE REAL KEY, A REAL BROWSER ═══════
//
//   node tests/real-map.mjs <browser-key>
//
// NOT part of `npm test`: it makes real, billable Google requests and needs a
// key. Run it after anything that touches map-core.js, and before believing a
// green suite.
//
// It exists because every other map test uses a stub, and a stub has now let
// THREE separate production crashes through:
//
//   - `class extends google.maps.OverlayView` before importLibrary had run;
//   - ControlPosition read off the 'maps' library, which does not carry it;
//   - a stub answering every class from one library when Google splits them
//     across two.
//
// Each time the stub was more generous than the real API, so the suite stayed
// green while the map was dead in front of an agent. This one cannot be,
// because nothing is stubbed: the page is served at https://admin.threepin.in
// so Google sees the referrer the key is restricted to, our own files come
// from disk, and every googleapis.com request goes out for real.
//
// It drives the REAL pipeline - the live 131-property snapshot through the
// area model and the position ladder - and reports how many map tiles and how
// many of our own markers actually reached the DOM.

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = process.argv[2];
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };

const PROPS = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/properties-snapshot.json'), 'utf8'));
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/map-assets/style.css">
<style>html,body{margin:0;height:100%}#host{position:absolute;inset:0}</style>
</head><body>
<div id="host"></div>
<script>window.__PROPS = ${JSON.stringify(PROPS)};</script>
<script src="/shared-assets/chennai-geo.js"></script>
<script src="/shared-assets/area-model.js"></script>
<script src="/map-assets/geo-resolve.js"></script>
<script src="/map-assets/map-core.js"></script>
<script src="/dashboard-assets/search-engine.js"></script>
<script>
window.__log = [];
window.addEventListener('error', e => window.__log.push('ERROR ' + e.message));
(async () => {
  try {
    const st = await PinMapCore.load(${JSON.stringify(KEY)});
    window.__loadState = st;
    if (!st.ok) { window.__done = true; return; }
    const api = PinMapCore.create(document.getElementById('host'), {
      center: { lat: 13.0878, lng: 80.2100 }, zoom: 14
    });
    window.__api = api;
    // The REAL pipeline: the real inventory through the real area model and
    // the real position ladder, exactly as the dashboard builds it.
    const props = window.__PROPS;
    const area = PinAreaModel.forList(props);
    const located = PinGeoResolve.locate(props, { area });
    const items = located.placed.map(x => {
      const rec = PinSearch.indexProperty(x.p);
      const pr = rec.num.price;
      return { p: x.p, pos: x.pos,
        priceLo: pr.length ? Math.min(...pr.map(r => r[0])) : null,
        priceHi: pr.length ? Math.max(...pr.map(r => r[1])) : null };
    });
    window.__counts = located.counts;
    api.render(items);
    api.fit(items);
    await new Promise(r => setTimeout(r, 1500));
    // Zoom in far enough that pins are drawn rather than clusters.
    api.map.setZoom(15);
    api.map.setCenter({ lat: 13.0878, lng: 80.2100 });
    await new Promise(r => setTimeout(r, 1500));
    api.render(items);
    api.select(items[0].p.id);
    window.__done = true;
  } catch (e) { window.__log.push('THROW ' + e.message); window.__done = true; }
})();
</script></body></html>`;

// Desktop AND phone. A map that works at 1200px and not at 390 is still a
// map an agent cannot use, and they are on a phone in front of the client.
const VIEWS = [
  { name: 'desktop', viewport: { width: 1200, height: 760 } },
  { name: 'phone', viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }
];

const browser = await chromium.launch();
let bad = 0;
for (const V of VIEWS) {
const ctx = await browser.newContext(V);
const page = await ctx.newPage();
const netFail = [];
page.on('pageerror', e => netFail.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') netFail.push('console: ' + m.text()); });
page.on('requestfailed', r => { if (/googleapis/.test(r.url())) netFail.push('net: ' + r.url().slice(0, 90) + ' ' + (r.failure() || {}).errorText); });

await page.route('**/*', route => {
  const u = new URL(route.request().url());
  // Everything Google: let it through for real.
  if (/googleapis\.com|gstatic\.com|google\.com/.test(u.hostname)) return route.continue();
  if (u.hostname !== 'admin.threepin.in') return route.abort();
  if (u.pathname === '/__maptest.html') return route.fulfill({ contentType: 'text/html', body: PAGE });
  const f = join(ROOT, decodeURIComponent(u.pathname));
  if (!existsSync(f)) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({ contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
});

await page.goto('https://admin.threepin.in/__maptest.html');
await page.waitForFunction(() => window.__done === true, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3500);

const out = await page.evaluate(() => ({
  load: window.__loadState || null,
  log: window.__log || [],
  tiles: document.querySelectorAll('#host img').length,
  markers: document.querySelectorAll('.gm-prop').length,
  clusters: document.querySelectorAll('.gm-cluster').length,
  counts: window.__counts || null,
  zoom: window.__api ? window.__api.map.getZoom() : null,
  names: [...document.querySelectorAll('.gm-p-n')].map(e => e.textContent),
  gmInner: (document.querySelector('#host') || {}).childElementCount || 0
}));
console.log('');
console.log('─'.repeat(58));
console.log('  ' + V.name + '  ' + V.viewport.width + 'x' + V.viewport.height);
console.log('─'.repeat(58));
console.log('load state :', JSON.stringify(out.load));
console.log('page log   :', JSON.stringify(out.log));
console.log('tile <img> :', out.tiles);
console.log('our markers:', out.markers, '| e.g. ' + JSON.stringify(out.names.slice(0, 3)));
console.log('host kids  :', out.gmInner);
if (netFail.length) { console.log('failures   :'); netFail.slice(0, 8).forEach(x => console.log('   ' + x)); }
// The two things that decide whether this works at all.
if (!out.load || out.load.ok !== true) { console.log('   !! the map did not load'); bad++; }
if (!(out.tiles > 10)) { console.log('   !! no map tiles reached the page'); bad++; }
if (!(out.markers > 100)) { console.log('   !! our markers did not render'); bad++; }
await page.screenshot({ path: join(ROOT, 'tests/out/real-map-' + V.name + '.png') });
console.log('screenshot -> tests/out/real-map-' + V.name + '.png');
await ctx.close();
}
await browser.close();
if (bad) { console.log(''); console.log(bad + ' problem(s).'); process.exit(1); }
console.log('');
console.log('Both views: the real map loaded, tiled and took our markers.');
