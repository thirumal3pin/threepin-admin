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

  await p.goto((process.env.PIN_BASE || 'http://127.0.0.1:5199') + '/dashboard.html', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof window.init === 'function' && !!window.PinSearch && !!window.PinAdvanced);
  await p.evaluate(data => {
    window.dashboardFirebase = {
      saveProperty: () => Promise.resolve(), deleteProperty: () => Promise.resolve(),
      getPropertyNotes: () => Promise.resolve([]), savePropertyNote: () => Promise.resolve(),
      deletePropertyNote: () => Promise.resolve(), getInternalNotes: () => Promise.resolve([]),
      saveInternalNote: () => Promise.resolve(), deleteInternalNote: () => Promise.resolve(),
      saveChanges: () => Promise.resolve(), getChanges: () => Promise.resolve([]),
      setChangeApplied: () => Promise.resolve(),
      // Cards on the Shoot & Media board: two still on their way (not in the dashboard), one mapped to a
      // property that is, one dropped.
      sellerQueue: () => Promise.resolve([
        { id: 'lst_a', title: '3BHK Apartment, T Nagar - Venkatesh', location: 'T Nagar, Chennai', config: '3 BHK', askingPrice: '₹2.8 Cr', propertyCode: '', stageName: 'Shoot scheduled', stageKey: 'shoot_scheduled', stageKind: 'open' },
        { id: 'lst_b', title: 'Independent Villa, Adyar', location: 'Adyar', config: '4 BHK', askingPrice: '₹6.5 Cr', propertyCode: '', stageName: 'Details & docs', stageKey: 'details', stageKind: 'open' },
        { id: 'lst_c', title: 'Already in the dashboard', location: 'T Nagar', config: '2 BHK', propertyCode: 'TNAG0002', stageName: 'Live — marketing', stageKey: 'live', stageKind: 'open' },
        { id: 'lst_d', title: 'Dropped T Nagar flat', location: 'T Nagar', config: '2 BHK', propertyCode: '', stageName: 'Dropped', stageKey: 'dropped', stageKind: 'lost' },
        // A seller who has called in and has no card yet.
        { id: 'lead_S9', kind: 'seller', leadId: 'S9', title: '2BHK flat in T Nagar near Pondy Bazaar', location: '2BHK flat in T Nagar near Pondy Bazaar', askingPrice: '1.4 Cr', intent: 'sell', createdAt: Date.now() - 86400000, stageName: 'New seller', stageKind: 'open' }
      ])
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
    ['tnagar', 'Tnagar'],
    ['tnagar-3bhk', '3bhk tnagar'],
    ['none', 'zzzqqxwv']
  ]) {
    await type(q);
    results[q] = await count();
    await shot('q-' + label);
    // The groups under the exact hits (nearby areas, almost match, reads like), when there are any.
    const nm = await p.$('#nearMisses:not([hidden])');
    if (nm) { await nm.screenshot({ path: `${OUT}${name}-nm-${label}.png` }); shots++; }
  }

  // The seller board's cards under a search: the waiting one offered as upcoming, linking to its
  // card; the one already in the dashboard and the dropped one never; none with Ready picked.
  await type('Tnagar');
  await p.waitForTimeout(400);
  const q = await p.evaluate(() => [...document.querySelectorAll('#nearMisses a.nm-q:not(.nm-s)')].map(a => ({ href: a.getAttribute('href'), text: a.textContent })));
  const qOk = q.some(r => /listing=lst_a/.test(r.href) && /Upcoming : not in Property Dashboard/i.test(r.text) && /Venkatesh/.test(r.text))
    && !q.some(r => /lst_c|lst_d/.test(r.href))
    // Adyar is offered only as a nearby area, saying so.
    && q.filter(r => /lst_b/.test(r.href)).every(r => /Adyar · [\d.]+ km from T Nagar/.test(r.text));
  if (!qOk) errs.push(`${name}: seller-board suggestions wrong for "Tnagar": ${JSON.stringify(q)}`);
  await p.evaluate(() => setStatus('ready', document.querySelector('#statusFilters .fbtn') || document.createElement('b')));
  await p.waitForTimeout(250);
  const qReady = await p.evaluate(() => document.querySelectorAll('#nearMisses a.nm-q').length);
  if (qReady) errs.push(`${name}: seller-board suggestions shown with Ready picked`);
  await p.evaluate(() => setStatus('all', document.querySelector('#statusFilters .fbtn') || document.createElement('b')));
  await p.waitForTimeout(150);
  console.log(`   ${name}: seller board suggestions for "Tnagar": ${q.length} (ok: ${qOk}); with Ready: ${qReady}`);
  // The new seller: its own group, labelled, linking to the board's Sellers list, never in the cards group.
  await type('Tnagar');
  await p.waitForTimeout(300);
  const ns = await p.evaluate(() => [...document.querySelectorAll('#nearMisses a.nm-s')].map(a => ({ href: a.getAttribute('href'), text: a.textContent })));
  const nsOk = ns.length === 1 && /nav=sellers/.test(ns[0].href) && /New seller · not yet on the board/i.test(ns[0].text) && /Selling/.test(ns[0].text)
    && !q.some(r => /Pondy Bazaar/.test(r.text));
  if (!nsOk) errs.push(`${name}: new-seller suggestion wrong for "Tnagar": ${JSON.stringify(ns)}`);
  console.log(`   ${name}: new sellers for "Tnagar": ${ns.length} (ok: ${nsOk})`);
  const nm = await p.$('#nearMisses:not([hidden])');
  if (nm) { await nm.screenshot({ path: `${OUT}${name}-nm-queue-and-sellers.png` }); shots++; }

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

// ── A shared property link opens the FULL record: every tab, Internal Notes included, and it scrolls ──
// (property.html?id=… — every link already sent — forwards there too.)
for (const [name, vp] of [['desk', { width: 1366, height: 768 }], ['phone', { width: 390, height: 844 }]]) {
  const target = DATA.find(x => x.id && x.propertyCode) || DATA[0];
  for (const start of [`/dashboard.html?property=${encodeURIComponent(target.id)}`, `/property.html?id=${encodeURIComponent(target.id)}`]) {
    const p = await b.newPage({ viewport: vp, deviceScaleFactor: 1 });
    p.on('pageerror', e => errs.push(`${name} link: ${String(e).slice(0, 300)}`));
    await p.route('**/firebasejs/**', r => r.abort());
    await p.route('**/dashboard-assets/firebase-sync.js', r => r.abort());
    await p.route('**/identitytoolkit**', r => r.abort());
    await p.route('**/firestore.googleapis.com/**', r => r.abort());
    await p.goto((process.env.PIN_BASE || 'http://127.0.0.1:5199') + start, { waitUntil: 'domcontentloaded' });
    await p.waitForURL(/dashboard\.html/, { timeout: 5000 }).catch(() => {});
    await p.waitForFunction(() => typeof window.init === 'function' && !!window.PinSearch, null, { timeout: 8000 });
    await p.evaluate(data => {
      window.dashboardFirebase = { saveProperty: () => Promise.resolve(), getPropertyNotes: () => Promise.resolve([]), getInternalNotes: () => Promise.resolve([]),
        getChanges: () => Promise.resolve([]), getLeads: () => Promise.resolve([]), propertyMarketing: () => Promise.resolve({ cards: [], posts: [] }) };
      window.dashboardAuth = { getTenantId: () => 't_test', getUserEmail: () => 'test@example.com', getIdToken: () => Promise.resolve(null), logout: () => { } };
      window.onDashboardAuthChange({ uid: 'test' });
      window.applyPropertiesSnapshot(data);
    }, DATA);
    await p.waitForTimeout(700);
    const st = await p.evaluate(() => ({
      open: document.getElementById('dp').classList.contains('open'),
      tabs: [...document.querySelectorAll('#dp .dp-tab')].map(t => t.textContent.trim()),
      url: location.pathname
    }));
    const tabsOk = st.open && st.tabs.length === 6 && st.tabs.some(t => /Internal Notes/.test(t)) && st.tabs.some(t => /Notes & CRM/.test(t)) && st.tabs.some(t => /Matching Buyers/.test(t));
    if (!tabsOk) errs.push(`${name} ${start}: the full record did not open with every tab: ${JSON.stringify(st)}`);
    await p.mouse.move(vp.width / 2, vp.height - 160);
    await p.mouse.wheel(0, 700);
    await p.waitForTimeout(700);
    const y = await p.evaluate(() => document.getElementById('dp').scrollTop + document.scrollingElement.scrollTop);
    if (y < 100) errs.push(`${name} ${start}: the full record does not scroll (${y})`);
    await p.evaluate(() => { const t = [...document.querySelectorAll('#dp .dp-tab')].find(x => /Internal/.test(x.textContent)); if (t) t.click(); });
    await p.waitForTimeout(300);
    const internalShown = await p.evaluate(() => !!document.querySelector('#dp .tab-panel.active #internalNotesPanel'));
    if (!internalShown) errs.push(`${name} ${start}: the Internal Notes tab does not open`);
    console.log(`   ${name} ${start}: opened ${st.url}, ${st.tabs.length} tabs, scroll ${y}, internal notes ${internalShown}`);
    await p.screenshot({ path: `${OUT}${name}-full-record${start.startsWith('/property') ? '-from-old-link' : ''}.png` });
    shots++;
    await p.close();
  }
}

await b.close();
console.log(`\n${shots} screenshots → ${OUT}`);
if (errs.length) { console.log('\nPAGE ERRORS:'); [...new Set(errs)].forEach(e => console.log('  ' + e)); process.exit(1); }
console.log('no page errors');
