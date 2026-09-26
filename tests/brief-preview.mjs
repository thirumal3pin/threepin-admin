// ═══════ CLIENT BRIEF ═══════
//
//   node tests/brief-preview.mjs <out-dir>
//
// The Client brief takes what a client said, in their words, and ranks the
// whole inventory against it. It had no test at all, and the owner reported
// it as "not opening, or working properly" — which turned out to be three
// separate things, none of them the ranking:
//
//   · the box opens in the CONTENT while the button that opens it is in a
//     sticky header, so pressing it part-way down the page opened a panel
//     above the viewport and looked like a dead button;
//   · pressing Rank with an empty box returned silently, which is
//     indistinguishable from a broken feature;
//   · running a brief hid the card grid but not the MAP, so with Split or
//     Map open you got two differently-ordered result sets stacked.
//
// This drives the real dashboard with the real 131-property inventory.

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = process.argv[2] || 'tests/out/brief';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const T = 't_3pinrealty';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const P = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/properties-snapshot.json'), 'utf8')).map(p => ({ tenantId: T, ...p }));

const STUB = `
window.dashboardFirebase={saveProperty:async()=>{},deleteProperty:async()=>{},getPropertyNotes:async()=>[],savePropertyNote:async()=>{},deletePropertyNote:async()=>{},getInternalNotes:async()=>[],saveInternalNote:async()=>{},deleteInternalNote:async()=>{},saveChanges:async()=>{},getChanges:async()=>[],getLeads:async()=>[],subscribeToProperty:()=>()=>{}};
window.dashboardAuth={login:async()=>{},logout:async()=>{},getIdToken:async()=>'x',getTenantId:()=>'${T}'};
setTimeout(()=>{if(window.onDashboardAuthChange)window.onDashboardAuthChange({email:'agent.a@example.com'});if(window.onPinTenantReady)window.onPinTenantReady('${T}');window.applyPropertiesSnapshot(${JSON.stringify(P)});window.__ready=true;},0);`;

const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};

const browser = await chromium.launch();
async function open(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${viewport.width}px pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource|net::ERR|fonts\.googleapis|maps\.googleapis/.test(m.text())) return;
    errors.push(`${viewport.width}px console: ${m.text()}`);
  });
  await page.route('**/*', r => {
    const u = new URL(r.request().url());
    if (u.hostname !== 'dash.local') return r.abort();
    if (u.pathname === '/dashboard-assets/firebase-sync.js') return r.fulfill({ contentType: 'text/javascript', body: STUB });
    if (u.pathname === '/api/public-config') return r.fulfill({ contentType: 'application/json', body: '{"googleMapsApiKey":""}' });
    const f = join(ROOT, decodeURIComponent(u.pathname));
    if (!existsSync(f)) return r.fulfill({ status: 404, body: '' });
    return r.fulfill({ contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
  });
  await page.goto('http://dash.local/dashboard.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.waitForTimeout(600);
  return page;
}

// ═══════ ON A LAPTOP ═══════
console.log('');
console.log('On a laptop');
{
  const page = await open({ width: 1440, height: 900 });

  // ── It opens where you can see it ──
  // The button lives in a sticky header; the box it opens does not.
  await page.evaluate(() => window.scrollTo(0, 1400));
  await page.waitForTimeout(200);
  await page.click('#briefBtn');
  await page.waitForTimeout(700);
  const opened = await page.evaluate(() => {
    const bar = document.querySelector('#briefBar');
    const r = bar.getBoundingClientRect();
    const hdr = document.querySelector('#hdr');
    const hb = hdr ? hdr.getBoundingClientRect().bottom : 0;
    return { hidden: bar.hidden, top: Math.round(r.top), h: Math.round(r.height),
      belowHeader: r.top >= hb - 2, onScreen: r.top >= 0 && r.bottom <= innerHeight + 2,
      focused: document.activeElement === document.querySelector('#briefText') };
  });
  ok('the box opens', !opened.hidden && opened.h > 40, JSON.stringify(opened));
  ok('...in view, even when the page was scrolled down', opened.onScreen, JSON.stringify(opened));
  ok('...clear of the sticky header', opened.belowHeader, JSON.stringify(opened));
  ok('...with the cursor already in it', opened.focused);

  // ── An empty brief says why, rather than nothing ──
  await page.click('.brief-go');
  await page.waitForTimeout(400);
  const empty = await page.evaluate(() => {
    const m = document.querySelector('#briefMsg');
    return { shown: m && !m.hidden, text: m ? m.textContent.trim() : '', results: !document.querySelector('#briefResults').hidden };
  });
  ok('pressing Rank with an empty box explains itself', empty.shown && empty.text.length > 20, JSON.stringify(empty));
  ok('...and does not pretend to have results', !empty.results);

  // ── The ranking ──
  await page.fill('#briefText', '3 BHK in Anna Nagar under 3.5 crore, ready to move');
  await page.click('.brief-go');
  await page.waitForTimeout(1200);
  const ran = await page.evaluate(() => ({
    results: !document.querySelector('#briefResults').hidden,
    rows: document.querySelectorAll('#briefList .pm-row, #briefList .pm-item').length,
    title: (document.querySelector('#briefList .pm-hdr-n') || {}).textContent || '',
    gridHidden: document.querySelector('#pgrid').style.display === 'none',
    msg: !document.querySelector('#briefMsg').hidden,
    hasMore: !!document.querySelector('#briefList .pm-more'),
    firstPct: (document.querySelector('#briefList .pm-sc-n') || {}).textContent || ''
  }));
  ok('a brief ranks the inventory', ran.results && ran.rows > 0, JSON.stringify(ran));
  ok('...says how many are worth sending', /\d+ propert/.test(ran.title), ran.title);
  ok('...shows a shortlist with the rest one click away', ran.rows <= 5 && ran.hasMore, JSON.stringify(ran));
  ok('...scores each one', /%/.test(ran.firstPct), ran.firstPct);
  ok('...and takes the grid’s place rather than sitting under it', ran.gridHidden);
  ok('...clearing the earlier complaint', !ran.msg);

  await page.screenshot({ path: join(OUT, 'laptop.png') });

  // ── One set of results, never two ──
  // This hid the grid but not the map, so Split left a map and a ranked list
  // stacked, each ordered differently.
  await page.evaluate(() => clearBrief());
  await page.evaluate(() => PinMapView.setMode('split'));
  await page.waitForTimeout(800);
  await page.click('#briefBtn');
  await page.fill('#briefText', '3 BHK Anna Nagar');
  await page.click('.brief-go');
  await page.waitForTimeout(1000);
  const withMap = await page.evaluate(() => {
    const shell = document.querySelector('#mapShell');
    return { mapShowing: !!(shell && !shell.hidden), results: !document.querySelector('#briefResults').hidden, mode: PinMapView.mode() };
  });
  ok('running a brief over the map leaves one result set, not two',
    withMap.results && !withMap.mapShowing, JSON.stringify(withMap));

  // ── And gives the view back ──
  await page.evaluate(() => clearBrief());
  await page.waitForTimeout(800);
  const restored = await page.evaluate(() => ({ mode: PinMapView.mode(), mapShowing: !document.querySelector('#mapShell').hidden }));
  ok('clearing puts back the view the brief interrupted',
    restored.mode === 'split' && restored.mapShowing, JSON.stringify(restored));

  await page.context().close();
}

// ═══════ ON A PHONE ═══════
console.log('');
console.log('On a phone');
{
  const page = await open({ width: 390, height: 844 });
  await page.click('#briefBtn');
  await page.waitForTimeout(400);
  await page.fill('#briefText', '3 BHK Anna Nagar 3 crore');
  await page.click('.brief-go');
  await page.waitForTimeout(1200);
  const m = await page.evaluate(() => {
    const go = document.querySelector('.brief-go');
    const res = document.querySelector('#briefResults');
    return {
      overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      goTall: Math.round(go.getBoundingClientRect().height),
      rows: document.querySelectorAll('#briefList .pm-row, #briefList .pm-item').length,
      fits: [...res.querySelectorAll('*')].every(x => { const b = x.getBoundingClientRect(); return !b.width || b.right <= innerWidth + 2; })
    };
  });
  ok('the brief ranks on a phone too', m.rows > 0, JSON.stringify(m));
  ok('...without pushing the page sideways', m.overflowX === 0, m.overflowX + 'px');
  ok('...with nothing spilling out of the results', m.fits);
  ok('...and a button big enough to tap', m.goTall >= 36, m.goTall + 'px');
  await page.screenshot({ path: join(OUT, 'phone.png') });
  await page.context().close();
}

await browser.close();
console.log('');
console.log('─'.repeat(64));
console.log('screenshots → ' + OUT);
if (errors.length) {
  console.log('');
  console.log(errors.length + ' problem(s):');
  errors.forEach(e => console.log('  · ' + e));
  process.exit(1);
}
console.log('All good.');
