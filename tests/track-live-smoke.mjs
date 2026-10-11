// ═══════ SHOOT & MEDIA, AGAINST THE LIVE SITE — READ-ONLY ═══════
//
// Signs in as the real account (a custom token minted with the service account), opens the deployed
// Shoot & Media page and checks every view draws — Board, List, Editor, Settings, Posting (Today,
// Week, Sheet, Properties, Series), Shoots, Sellers — at desktop and phone width, with no page errors
// and no sideways scroll.
//
// It never writes: every Firestore write channel is cut off at the network, so nothing the page might
// save on load (a column upgrade, a seller card) reaches the live data.
//
//   node tests/track-live-smoke.mjs [base-url]          (default https://admin.threepin.in)

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const BASE = process.argv[2] || 'https://admin.threepin.in';
const EMAIL = '3pinrentals@gmail.com';
const sa = JSON.parse(readFileSync('api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const user = await getAuth().getUserByEmail(EMAIL);
const token = await getAuth().createCustomToken(user.uid, user.customClaims || {});

let failed = 0, writesBlocked = 0;
const ok = (l, c, d) => { if (!c) failed++; console.log((c ? '  ok    ' : '  FAIL  ') + l + (c || d === undefined ? '' : ' — ' + d)); };
const browser = await chromium.launch();

for (const [name, viewport] of [['desktop', { width: 1440, height: 950 }], ['phone', { width: 390, height: 844 }]]) {
  console.log('\n── ' + name);
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
  // Read-only: Firestore writes go over the Write channel (and commit for batches) — cut them off.
  await page.route(/firestore\.googleapis\.com\/.*(\/Write\/|:commit|:batchWrite)/, r => { writesBlocked++; return r.abort(); });
  await page.goto(BASE + (/localhost|127.0.0.1/.test(BASE) ? '/propertytrack.html' : '/propertytrack'), { waitUntil: 'networkidle' });
  // The page's modules wait on Firebase's own scripts: sign in once they are all in.
  await page.waitForFunction(() => window.trackApi && window.trackAuth && typeof window.toggleView === 'function', null, { timeout: 30000 });
  await page.evaluate(async t => {
    const { getAuth, signInWithCustomToken } = await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js');
    await signInWithCustomToken(getAuth(), t);
  }, token);
  await page.waitForFunction(() => document.getElementById('appRoot').style.display !== 'none', null, { timeout: 25000 });
  await page.waitForTimeout(4000);

  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok('The deployed page is the new one (Settings view, Editor, series API)', await page.evaluate(() => !!document.getElementById('settingsView') && !!document.getElementById('edModal') && !!(window.trackApi && window.trackApi.createSeriesCard) && typeof window.pgOpenSeries === 'function'));
  const counts = await page.evaluate(() => ({ cards: window.trackApi.listings().length, series: window.trackApi.listings().filter(l => l.kind === 'series').length }));
  console.log(`        ${counts.cards} board cards, ${counts.series} series cards`);

  await page.evaluate(() => { toggleView('board', true); setBoardMode('board'); }); await page.waitForTimeout(400);
  ok('Board draws its columns', (await page.$$('#boardView .tk-board .tk-col')).length >= 6);
  await page.evaluate(() => setBoardMode('list')); await page.waitForTimeout(400);
  ok('List draws', !!(await page.$('#boardView .tk-listwrap, #boardView .tk-empty')));
  ok('List: no sideways scroll', !(await wide()));
  await page.evaluate(() => setBoardMode('editor')); await page.waitForTimeout(500);
  const cols = await page.$$eval('.ed-col .tk-col-title', t => t.map(x => x.textContent));
  ok('Editor view: six columns', cols.length === 6, JSON.stringify(cols));
  const edCards = await page.$$eval('.ed-board .tk-card', c => c.length);
  console.log(`        Editor view: ${edCards} cards — ${JSON.stringify(await page.$$eval('.ed-col', c => c.map(x => x.querySelector('.tk-count').textContent)))}`);
  ok('Editor view: no sideways page scroll', !(await wide()));
  await page.screenshot({ path: `tests/out/live-${name}-editor.png` });
  await page.evaluate(() => setBoardMode('board')); await page.waitForTimeout(200);

  await page.evaluate(() => toggleView('settings', true)); await page.waitForTimeout(400);
  ok('Settings → Configurations draws', /Configurations/.test(await page.textContent('#settingsView')) && (await page.$$('.cf-sec')).length === 6);
  ok('Settings: no sideways scroll', !(await wide()));
  await page.screenshot({ path: `tests/out/live-${name}-settings.png` });

  await page.evaluate(() => toggleView('posting', true)); await page.waitForTimeout(800);
  for (const tab of ['Today', 'Week', 'Sheet', 'Properties', 'Series']) {
    await page.click(`.pg-bar .tk-sbtn:has-text("${tab}")`); await page.waitForTimeout(600);
    ok(`Posting ${tab} draws`, (await page.textContent('#postingView')).length > 50 && /\b/.test(tab));
    ok(`Posting ${tab}: no sideways scroll`, !(await wide()));
  }
  await page.screenshot({ path: `tests/out/live-${name}-series.png` });
  for (const v of ['shoots', 'sellers']) {
    await page.evaluate(k => toggleView(k, true), v); await page.waitForTimeout(400);
    ok(`${v} draws, no sideways scroll`, (await page.textContent('#' + v + 'View')).length > 10 && !(await wide()));
  }
  ok('No page errors', !errors.length, errors.join(' | '));
  await ctx.close();
}
await browser.close();
console.log(`\n${failed ? failed + ' failure(s)' : 'All good'} — ${writesBlocked} write request(s) blocked, nothing written.`);
process.exit(failed ? 1 : 0);
