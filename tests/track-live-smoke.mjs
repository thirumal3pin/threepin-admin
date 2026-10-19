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
  await page.goto(BASE + '/propertytrack.html', { waitUntil: 'networkidle' });
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
  ok('Editor view: seven columns', cols.length === 7, JSON.stringify(cols));
  const edCards = await page.$$eval('.ed-board .tk-card', c => c.length);
  console.log(`        Editor view: ${edCards} cards — ${JSON.stringify(await page.$$eval('.ed-col', c => c.map(x => x.querySelector('.tk-count').textContent)))}`);
  ok('Editor view: no sideways page scroll', !(await wide()));
  await page.screenshot({ path: `tests/out/live-${name}-editor.png` });
  // The Editor's list and the editor's view of a card, and the Calendar (since 03e9e2f).
  if (!(await page.evaluate(() => typeof window.setEdLayout === 'function' && !!document.getElementById('calendarView')))) {
    console.log('        (Calendar and the Editor list are not deployed here yet)');
  } else {
    await page.evaluate(() => setEdLayout('list')); await page.waitForTimeout(500);
    const lrows = await page.$$eval('.ed-lrow', r => r.length);
    ok('Editor list: one row per card, the same cards as the columns', !!(await page.$('.ed-lt')) && lrows === edCards, `${lrows} rows, ${edCards} cards`);
    ok('Editor list: a filter on every column', (await page.$$('.ed-lf .ed-lf-c')).length === 7);
    ok('Editor list: no sideways page scroll', !(await wide()));
    await page.screenshot({ path: `tests/out/live-${name}-editor-list.png` });
    if (lrows) {
      await page.click('.ed-lrow >> nth=0'); await page.waitForTimeout(700);
      const dv = await page.evaluate(() => ({ ed: document.getElementById('dp').classList.contains('dp-ed'), secs: [...document.querySelectorAll('#dpBody .tk-sec-hdr')].map(h => h.textContent.trim()) }));
      // A series card opens its own (full) view; a property card the editor's view.
      ok('A card opens in the editor\'s view (or a series in its own)', dv.ed ? JSON.stringify(dv.secs) === JSON.stringify(['Shoot', 'Photos', 'Edit — per outlet', 'Posts', 'Shoot for']) : dv.secs.length > 0, JSON.stringify(dv));
      await page.screenshot({ path: `tests/out/live-${name}-editor-view.png` });
      await page.evaluate(() => closeDetail()); await page.waitForTimeout(300);
    }
    await page.evaluate(() => setEdLayout('board')); await page.waitForTimeout(200);
    await page.evaluate(() => toggleView('calendar', true)); await page.waitForTimeout(600);
    const sum = await page.evaluate(() => (document.querySelector('.tc-sum') || {}).textContent || '');
    console.log(`        Calendar this week: ${sum.replace(/\s+/g, ' ').trim()}`);
    ok('Calendar: the week draws (columns on a desk, a day list on a phone)', (await page.$$(name === 'phone' ? '.tc-aday' : '.tc-wh')).length === 7);
    ok('Calendar week: no sideways scroll', !(await wide()));
    await page.screenshot({ path: `tests/out/live-${name}-calendar-week.png` });
    await page.evaluate(() => calSpan('month')); await page.waitForTimeout(500);
    const cells = await page.$$eval('.tc-md', c => c.length);
    ok('Calendar: the month draws, whole weeks', cells >= 28 && cells % 7 === 0, cells);
    ok('Calendar month: no sideways scroll', !(await wide()));
    await page.screenshot({ path: `tests/out/live-${name}-calendar-month.png` });
    await page.evaluate(() => calSpan('week')); await page.waitForTimeout(200);
  }
  await page.evaluate(() => { toggleView('board', true); setBoardMode('board'); }); await page.waitForTimeout(200);

  // A mapped card: renamed from its page, its details edited, filled from the Property dashboard —
  // the form opened and closed, never saved.
  const mapped = await page.evaluate(() => (window.trackApi.listings().find(l => l.propertyCode && l.kind !== 'series') || {}).id || '');
  if (mapped && await page.evaluate(() => typeof window.openEditModal === 'function' && !!document.getElementById('mm_deal'))) {
    await page.evaluate(id => openDetail(id), mapped); await page.waitForTimeout(700);
    ok('A card page: ✎ by the name, Edit details at the top, Use … details', !!(await page.$('#dpTitle .dp-rename')) && !!(await page.$('.tk-sum-acts button:has-text("Edit details")')) && !!(await page.$('button:has-text("details"):has-text("Use ")')));
    await page.evaluate(id => openEditModal(id, window.trackApi.listings().find(l => l.id === id).propertyCode), mapped); await page.waitForTimeout(2500);
    const form = await page.evaluate(() => ({ open: document.getElementById('mModal').classList.contains('open'), fields: ['mm_deal', 'mm_propType', 'mm_sqft', 'mm_uds'].every(id => !!document.getElementById(id)), from: !document.getElementById('mmFrom').hidden && /MYLA|Filled from|already matches/.test(document.getElementById('mmFrom').textContent) }));
    ok('…the form: For, type, size, UDS; filled from the Property dashboard (not saved)', form.open && form.fields && form.from, JSON.stringify(form));
    ok('…the form fits, no sideways scroll', !(await wide()));
    await page.evaluate(() => { closeModal(); closeDetail(); }); await page.waitForTimeout(300);
  } else console.log('        (Edit details is not deployed here yet)');

  await page.evaluate(() => toggleView('settings', true)); await page.waitForTimeout(400);
  const cf = await page.evaluate(() => ({ title: /Configurations/.test(document.getElementById('settingsView').textContent), secs: [...document.querySelectorAll('.cf-sec h3')].map(h => h.textContent.trim()), vo: /Voice-over by/.test(document.getElementById('settingsView').textContent) }));
  ok('Settings → Configurations draws', cf.title && ['Editors', 'Voice-over', 'Edit deadlines', 'Series', 'Team calendar', 'Tags', 'Documents checklist', 'Tasks', 'Team'].every(s => cf.secs.includes(s)) && cf.vo, JSON.stringify(cf));
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
