// Drives the REAL dashboard.html in a browser with the inventory snapshot
// loaded, exercises the search box and the Advanced panel, and screenshots
// the result at desktop and phone width. Firebase is cut off at the network
// layer and the page is handed its data directly, which is the only part of
// the page that is faked.
//
// Needs the repo root served (python3 -m http.server 5199).
//
//   node tests/search-preview.mjs [output-dir]

import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';

const OUT = (process.argv[2] || 'tests/out/search') + '/';
mkdirSync(OUT, { recursive: true });
const DATA = JSON.parse(readFileSync('tests/fixtures/properties-snapshot.json', 'utf8'));

const b = await chromium.launch();
const errs = [];
let shots = 0;

for (const [name, width] of [['desk', 1280], ['phone', 390]]) {
  const p = await b.newPage({ viewport: { width, height: 950 }, deviceScaleFactor: 1 });
  p.on('pageerror', e => errs.push(`${name}: ${String(e).slice(0, 300)}`));
  // The Firebase requests below are aborted on purpose, so the failures they
  // log are expected and are not page errors.
  p.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/ERR_FAILED|ERR_ABORTED|net::/.test(t)) return;
    errs.push(`${name} console: ${t.slice(0, 300)}`);
  });

  // The page must never reach Firebase: no credentials here, and the run has
  // to be deterministic.
  await p.route('**/firebasejs/**', r => r.abort());
  await p.route('**/dashboard-assets/firebase-sync.js', r => r.abort());
  await p.route('**/identitytoolkit**', r => r.abort());
  await p.route('**/firestore.googleapis.com/**', r => r.abort());

  await p.goto('http://127.0.0.1:5199/dashboard.html', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof window.init === 'function' && !!window.PinSearch && !!window.PinAdvanced);
  await p.evaluate(data => {
    window.dashboardFirebase = {
      saveProperty: () => Promise.resolve(), deleteProperty: () => Promise.resolve(),
      getPropertyNotes: () => Promise.resolve([]), savePropertyNote: () => Promise.resolve(),
      deletePropertyNote: () => Promise.resolve(), getInternalNotes: () => Promise.resolve([]),
      saveInternalNote: () => Promise.resolve(), deleteInternalNote: () => Promise.resolve(),
      saveChanges: () => Promise.resolve(), getChanges: () => Promise.resolve([]),
      setChangeApplied: () => Promise.resolve()
    };
    window.dashboardAuth = { getTenantId: () => 't_test', getUserEmail: () => 'test@example.com', getIdToken: () => Promise.resolve(null), logout: () => { } };
    window.onDashboardAuthChange({ uid: 'test' });
    window.applyPropertiesSnapshot(data);
  }, DATA);
  await p.waitForTimeout(400);

  const shot = async (label, opts = {}) => {
    await p.waitForTimeout(opts.wait ?? 260);
    await p.screenshot({ path: `${OUT}${name}-${label}.png`, fullPage: opts.full === true });
    shots++;
  };
  const type = async q => {
    await p.fill('#searchInput', '');
    await p.type('#searchInput', q, { delay: 8 });
    await p.waitForTimeout(220);
  };
  const count = () => p.$eval('#rCnt', el => el.textContent.trim());

  await shot('grid');

  const results = {};
  for (const [label, q] of [
    ['1518-sqft', '1518 sqft built up area'],
    ['3-and-4-bhk', '3 and 4 bhk in anna nagar and adyar'],
    ['uds-comma', 'uds 1,140'],
    ['budget', 'ready to move 3bhk under 2 cr'],
    ['code', 'ADRA0001'],
    ['typo', 'adayar villa'],
    ['none', 'zzzqqxwv']
  ]) {
    await type(q);
    results[q] = await count();
    await shot('q-' + label);
  }

  // Type-ahead
  await type('ady');
  await p.waitForTimeout(250);
  const sugVisible = await p.$eval('#srchSug', el => el.classList.contains('show')).catch(() => false);
  await shot('suggestions');

  // The Advanced panel, and the brief from the request: 3 or 4 BHK in two
  // localities, ready to move.
  await p.fill('#searchInput', '');
  await p.evaluate(() => { window.currentSearch = ''; applyFilters(); });
  await p.click('#advBtn');
  await p.waitForTimeout(350);
  await shot('adv-open');

  const advCount = await p.evaluate(() => {
    PinAdvanced.toggle('bhk', '3');
    PinAdvanced.toggle('bhk', '4');
    PinAdvanced.toggle('status', 'ready');
    return document.getElementById('advCount').textContent;
  });
  await p.waitForTimeout(300);
  await shot('adv-picked');
  await shot('adv-full', { full: true });

  await p.evaluate(() => PinAdvanced.close());
  await p.waitForTimeout(300);
  // One chip per chosen value, plus the "Clear all filters" chip.
  const chipCount = await p.$$eval('.advchip:not(.advchip-clr)', els => els.length);
  await shot('adv-applied');
  const gridAfter = await count();

  await p.evaluate(() => PinAdvanced.reset());
  await p.waitForTimeout(250);

  console.log(`\n${name} (${width}px)`);
  Object.entries(results).forEach(([q, c]) => console.log(`   "${q}" → ${c}`));
  console.log(`   suggestions visible for "ady": ${sugVisible}`);
  console.log(`   advanced 3+4 BHK ready: ${advCount}; chips ${chipCount}; grid ${gridAfter}`);
  await p.close();
}

await b.close();
console.log(`\n${shots} screenshots → ${OUT}`);
if (errs.length) { console.log('\nPAGE ERRORS:'); [...new Set(errs)].forEach(e => console.log('  ' + e)); process.exit(1); }
console.log('no page errors');
