// ═══════ END-TO-END, AGAINST THE LIVE SITE ═══════
//
// Signs in as the real account (via a custom token minted with the service account), drives
// the deployed page in headless Chromium, and checks the things unit tests cannot: the GST
// widget in a real form, an attachment travelling all the way to Drive and back into the
// Transactions drawer, the double-submit guard, and every view at phone width.
//
// Leaves the books exactly as it found them: the test entry and its Drive file are removed
// at the end and the entry counter is put back.
//
//   node tests/e2e-live.mjs [base-url]

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const BASE = process.argv[2] || 'https://admin.threepin.in';

// This suite signs in as the real account and posts real entries into the real books. It used
// to default to production, which is how a fortnight of iterating on it turned into thousands
// of reads and hundreds of writes against the live ledger. Pointing it at production is still
// allowed — it is the only place some of this can be checked — but it now has to be asked for
// out loud, so it cannot happen again merely because someone ran the file with no arguments.
const SCRIPT = 'tests/' + import.meta.url.split('/').pop();
if (/admin\.threepin\.in/.test(BASE) && !process.env.E2E_ALLOW_LIVE) {
  console.error('\n  Refusing to run against production.\n');
  console.error('  This writes to the live ledger and reads the whole book to do it.\n');
  console.error(`  Against production anyway:  E2E_ALLOW_LIVE=1 node ${SCRIPT}`);
  console.error(`  Against a local server:      node ${SCRIPT} http://localhost:5173\n`);
  process.exit(2);
}
const SHOTS = process.env.SHOTS || 'C:/Users/3PINRE~1/AppData/Local/Temp/claude/c--Users-3Pin-Realty-Downloads-Thirumal/4259cdc1-a7b1-4f0d-bfe2-0730f72ae471/scratchpad/e2e/';
const TENANT = 't_3pinrealty';
const EMAIL = '3pinrentals@gmail.com';

let passed = 0, failed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log('  ok    ' + label); return; }
  failed++; failures.push(label + (detail ? ' — ' + detail : ''));
  console.log('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
};
const section = n => console.log('\n── ' + n);

// ── admin side ──────────────────────────────────────────────────────────────────
const sa = JSON.parse(readFileSync('api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const root = db.collection('finance').doc(TENANT);
const user = await getAuth().getUserByEmail(EMAIL);
const token = await getAuth().createCustomToken(user.uid, user.customClaims || {});
const before = {
  txns: (await root.collection('txns').get()).size,
  nextTxnNo: (await root.get()).data().nextTxnNo,
};
console.log(`books before: ${before.txns} entries, next #${before.nextTxnNo}`);

// ── browser ─────────────────────────────────────────────────────────────────────
import { mkdirSync } from 'node:fs';
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pageErrors = [], consoleErrors = [];
page.on('pageerror', e => pageErrors.push(String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });

await page.goto(BASE + '/3pinfinance', { waitUntil: 'networkidle' });
await page.evaluate(async t => {
  const { getAuth, signInWithCustomToken } = await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js');
  await signInWithCustomToken(getAuth(), t);
}, token);
await page.waitForFunction(() => document.getElementById('appRoot').style.display !== 'none', { timeout: 20000 });
await page.waitForTimeout(2500);

section('Login and shell');
check('App shell shown after sign-in', await page.evaluate(() => document.getElementById('appRoot').style.display !== 'none'));
check('Logo rendered in header', await page.evaluate(() => { const i = document.querySelector('.brand img'); return !!i && i.naturalWidth > 0; }));
check('Bottom tab bar visible at phone width', await page.evaluate(() => getComputedStyle(document.getElementById('bottomnav')).display !== 'none'));

// ── every view at phone width ───────────────────────────────────────────────────
section('Every view renders at 390px with no horizontal scroll');
const VIEWS = ['overview', 'record', 'month', 'txns', 'deals', 'gst', 'analytics', 'owed', 'services', 'budget', 'petty', 'loans', 'assets', 'invoices', 'bank', 'reports', 'books', 'profile', 'settings', 'guide'];
for (const v of VIEWS) {
  await page.evaluate(k => window.fin.go(k), v);
  await page.waitForTimeout(350);
  const r = await page.evaluate(() => ({
    h1: document.querySelector('#main h1')?.textContent?.trim() || '',
    wide: document.documentElement.scrollWidth > window.innerWidth + 1,
    bad: /undefined|NaN|\[object Object\]/.test(document.getElementById('main').innerText),
  }));
  check(`${v.padEnd(9)} renders "${r.h1.slice(0, 26)}"`, !!r.h1);
  check(`${v.padEnd(9)} no horizontal scroll`, !r.wide, `scrollWidth ${await page.evaluate(() => document.documentElement.scrollWidth)}`);
  check(`${v.padEnd(9)} no undefined/NaN`, !r.bad);
  await page.screenshot({ path: `${SHOTS}m-${v}.png`, fullPage: true });
}

// ── the GST widget on a real form ───────────────────────────────────────────────
section('Record → Expense: GST widget');
await page.evaluate(() => window.fin.record('expense'));
await page.waitForSelector('#f_desc');
check('Posting strip explains where the money lands', await page.evaluate(() => !!document.getElementById('pvPosting')));
await page.fill('#f_desc', 'E2E rent with GST');
await page.selectOption('#f_acc', '5000');
await page.fill('#f_amt', '1000');
check('GST fields hidden while GST is off', await page.$('#f_gstRate') === null);
check('One GST question on a purchase form, with three answers', await page.evaluate(() => document.querySelectorAll('#f_rcm option').length === 3 && !document.getElementById('f_gst')));
await page.selectOption('#f_rcm', 'charged');
await page.waitForSelector('#f_gstRate');
const w1 = await page.evaluate(() => ({ rate: +document.getElementById('f_gstRate').value, tax: +document.getElementById('f_gstAmt').value, total: +document.getElementById('f_total').value }));
check('Turning GST on fills rate 18, tax 180, total 1180', w1.rate === 18 && w1.tax === 180 && w1.total === 1180, JSON.stringify(w1));
await page.fill('#f_total', '1000');
const w2 = await page.evaluate(() => ({ amt: +document.getElementById('f_amt').value, tax: +document.getElementById('f_gstAmt').value }));
check('Editing the total backs the amount out to 847.46', w2.amt === 847.46 && w2.tax === 152.54, JSON.stringify(w2));
await page.fill('#f_amt', '2000');
const w3 = await page.evaluate(() => ({ tax: +document.getElementById('f_gstAmt').value, total: +document.getElementById('f_total').value }));
const strip = await page.evaluate(() => document.getElementById('pvPosting')?.innerText || '');
check('Posting strip names both accounts with their codes and the profit effect', /1000/.test(strip) && /5000/.test(strip) && /2,000/.test(strip), strip.replace(/\s+/g, ' ').slice(0, 160));
check('Editing the amount refills tax 360 and total 2360', w3.tax === 360 && w3.total === 2360, JSON.stringify(w3));
check('Focus stayed in the amount field while typing', await page.evaluate(() => document.activeElement?.id === 'f_amt'));
const bar = await page.evaluate(() => document.getElementById('barSum').innerText);
check('Sticky save bar shows the total', /2,360/.test(bar), bar);
check('Mobile save bar is visible', await page.evaluate(() => getComputedStyle(document.querySelector('.save-bar')).display !== 'none'));
await page.screenshot({ path: `${SHOTS}m-record-gst.png`, fullPage: true });

// ── attachment: a real image, through the proxy, into Drive ─────────────────────
section('Attach a photo and save');
// A 1200x900 JPEG so the shrink path has something to do.
const jpeg = await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 1200; c.height = 900;
  const x = c.getContext('2d'); x.fillStyle = '#FE8D00'; x.fillRect(0, 0, 1200, 900);
  x.fillStyle = '#111'; x.font = '80px sans-serif'; x.fillText('E2E BILL', 300, 470);
  return c.toDataURL('image/jpeg', 0.9).split(',')[1];
});
await page.setInputFiles('input.js-attach[multiple]', { name: 'e2e-bill.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') });
await page.waitForTimeout(300);
check('Staged file shows as Ready with a remove button', await page.evaluate(() => document.querySelectorAll('#stageList li').length === 1 && !!document.querySelector('#stageList .rm')));

// Press Save twice as fast as a nervous thumb would.
await page.evaluate(() => { const b = document.querySelector('.save-bar .js-save'); b.click(); b.click(); });
await page.waitForSelector('.result', { timeout: 30000 });
await page.waitForFunction(() => {
  const rows = [...document.querySelectorAll('#uplList .st')];
  return rows.length && rows.every(r => /Attached|Failed/.test(r.textContent));
}, { timeout: 60000 });
const res = await page.evaluate(() => ({
  heading: document.querySelector('.result h3')?.textContent,
  entry: document.querySelector('.result .eno')?.textContent,
  amount: document.querySelector('.result .big')?.textContent,
  upload: document.querySelector('#uplList .st')?.textContent,
  err: document.querySelector('#uplList .neg')?.textContent,
}));
check('Result panel says Saved', /Saved/.test(res.heading || ''), res.heading);
check('Result panel shows the entry number', /#\d{4}/.test(res.entry || ''), res.entry);
check('Result panel shows the amount', /2,360/.test(res.amount || ''), res.amount);
check('Attachment reached Drive ("Attached ✓")', /Attached/.test(res.upload || ''), res.upload + ' ' + (res.err || ''));
await page.screenshot({ path: `${SHOTS}m-saved.png`, fullPage: true });

const after = await root.collection('txns').get();
check('Exactly ONE entry was created by the double click', after.size === before.txns + 1, `${after.size - before.txns} created`);
const testTxn = after.docs.map(d => ({ id: d.id, ...d.data() })).find(t => t.desc === 'E2E rent with GST');
check('Entry has an attachment record with a Drive file id', !!testTxn?.attachments?.[0]?.path, JSON.stringify(testTxn?.attachments?.[0] || null));
check('Entry lines: 5000 dr 2000, CGST 180, SGST 180, 1000 cr 2360', !!testTxn && JSON.stringify(testTxn.lines.map(l => [l.acc, l.dr || 0, l.cr || 0])) === JSON.stringify([['5000', 2000, 0], ['1400', 180, 0], ['1401', 180, 0], ['1000', 0, 2360]]), JSON.stringify(testTxn?.lines));

// ── the drawer shows the preview ────────────────────────────────────────────────
section('Transactions drawer');
await page.evaluate(() => window.fin.go('txns'));
await page.waitForTimeout(600);
check('List shows the entry number column', await page.evaluate(() => /#\d{4}/.test(document.querySelector('#main table')?.innerText || '')));
check('List shows the paperclip count', await page.evaluate(() => /📎 1/.test(document.getElementById('main').innerText)));
await page.evaluate(id => window.fin.openTxn(id), testTxn.id);
await page.waitForSelector('.att img', { timeout: 10000 });
await page.waitForFunction(() => { const i = document.querySelector('.att img'); return i && (i.complete); }, { timeout: 20000 });
const img = await page.evaluate(() => { const i = document.querySelector('.att img'); return { w: i?.naturalWidth || 0, src: i?.src?.slice(0, 60) }; });
check('Drive thumbnail actually loads in the drawer', img.w > 0, JSON.stringify(img));
check('Drawer link opens the Drive file', await page.evaluate(() => /drive\.google\.com/.test(document.querySelector('.att a')?.href || '')));
await page.screenshot({ path: `${SHOTS}m-drawer.png`, fullPage: true });
await page.evaluate(() => window.fin.closeModal());

// ── opening a figure ────────────────────────────────────────────────────────────
section('Drilling into a figure');
await page.setViewportSize({ width: 1280, height: 900 });
await page.evaluate(() => window.fin.go('overview'));
await page.waitForTimeout(600);
const tile = await page.evaluate(() => {
  const t = [...document.querySelectorAll('#main .stat.drill')];
  return { count: t.length, labels: t.map(x => x.querySelector('.l')?.textContent.trim()) };
});
check('Figures on the Overview say they can be opened', tile.count >= 6, JSON.stringify(tile.labels));
check('The month figures are among them', tile.labels.some(l => /expenses/i.test(l)), tile.labels.join(' | '));

const drill = await page.evaluate(async () => {
  const t = [...document.querySelectorAll('#main .stat.drill')]
    .find(x => /expenses/i.test(x.querySelector('.l')?.textContent || ''));
  const shown = t.querySelector('.v')?.textContent.trim();
  t.click();
  await new Promise(r => setTimeout(r, 500));
  const ov = document.getElementById('ov');
  const title = ov?.querySelector('h3, .modal-title, header')?.textContent?.trim() || ov?.textContent?.slice(0, 120) || '';
  const rows = ov ? [...ov.querySelectorAll('tbody tr')].length : 0;
  const foot = ov ? ov.querySelector('tfoot')?.textContent?.replace(/\s+/g, ' ').trim() : '';
  return { shown, title, rows, foot, hasBack: /Show these in Transactions/.test(ov?.textContent || '') };
});
check('Clicking it opens a list of what is behind it', drill.rows > 0 || /No entries/.test(drill.title), JSON.stringify(drill));
check('The drawer names the figure and its total', drill.title.includes('Expenses'), drill.title);
check('…and the total in the drawer is the total on the tile', drill.foot.includes(drill.shown.replace(/^−/, '')), `${drill.foot} vs ${drill.shown}`);
check('…with a way through to the full list', drill.hasBack);
await page.screenshot({ path: `${SHOTS}d-drill.png`, fullPage: false });
await page.evaluate(() => window.fin.closeModal());

await page.evaluate(() => window.fin.go('reports'));
await page.waitForTimeout(700);
const repRows = await page.evaluate(async () => {
  const r = [...document.querySelectorAll('#main tr.click')].find(x => /fin\.explain/.test(x.getAttribute('onclick') || ''));
  if (!r) return { found: false };
  r.click();
  await new Promise(z => setTimeout(z, 500));
  const ov = document.getElementById('ov');
  return { found: true, rows: ov ? [...ov.querySelectorAll('tbody tr')].length : 0 };
});
check('A category row on Reports opens the same way', repRows.found && repRows.rows >= 0, JSON.stringify(repRows));
await page.evaluate(() => window.fin.closeModal());

await page.evaluate(() => window.fin.go('analytics'));
await page.waitForTimeout(700);
check('Analytics figures can be opened too',
  await page.evaluate(() => document.querySelectorAll('#main .stat.drill').length >= 3));

// ── the navigation, on both shapes of screen ────────────────────────────────────
// "More" on the tab bar opens the app rail — the one menu shared with the CRM
// and the property dashboard. tests/appnav-preview.mjs exercises it across all
// three consoles; here we only check it works against the live deploy.
section('The app rail at 390px');
await page.evaluate(() => window.fin.openSheet());
await page.waitForTimeout(500);
const drawer = await page.evaluate(() => {
  const rail = document.getElementById('appRail');
  return {
    open: document.body.classList.contains('rail-open'),
    onScreen: Math.round(rail.getBoundingClientRect().left) === 0,
    overflows: rail.scrollWidth > rail.clientWidth + 1,
    pageOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    consoles: [...rail.querySelectorAll('.rl-sec > .rl-h .rl-nm')].map(n => n.textContent),
    financePages: [...rail.querySelectorAll('.rl-sec .rl-body .rl-item .rl-nm')].map(n => n.textContent),
    groups: [...rail.querySelectorAll('.rl-grp-h .rl-gnm')].map(n => n.textContent),
  };
});
check('"More" opens the rail', drawer.open && drawer.onScreen);
check('It does not scroll sideways', !drawer.overflows);
check('…and neither does the page behind it', !drawer.pageOverflows);
check('Every console is on it', drawer.consoles.length === 5, drawer.consoles.join(' | '));
check('Finance keeps its five groups', drawer.groups.length === 5, drawer.groups.join(' | '));
check('Every finance page is reachable from it', drawer.financePages.length >= 19, `${drawer.financePages.length}: ${drawer.financePages.join(', ')}`);
await page.screenshot({ path: `${SHOTS}m-rail.png`, fullPage: false });
await page.evaluate(() => window.AppNav.close());

// ── desktop sanity ──────────────────────────────────────────────────────────────
section('Desktop 1280px');
await page.setViewportSize({ width: 1280, height: 900 });
for (const v of ['overview', 'record', 'txns', 'reports']) {
  await page.evaluate(k => window.fin.go(k), v);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}d-${v}.png`, fullPage: true });
}
check('The rail is shown on desktop', await page.evaluate(() =>
  getComputedStyle(document.getElementById('appRail')).display !== 'none' && document.body.classList.contains('rail-on')));
const side = await page.evaluate(() => {
  const secs = [...document.querySelectorAll('#appRail .rl-sec')];
  const fin = secs.find(s => s.querySelector('.rl-h .rl-nm').textContent === 'Finance');
  return {
    consoles: secs.map(s => s.querySelector('.rl-h .rl-nm').textContent),
    openCount: secs.filter(s => s.classList.contains('open')).length,
    financeOpen: fin.classList.contains('open'),
    links: fin.querySelectorAll('.rl-item').length,
    visibleLinks: [...fin.querySelectorAll('.rl-item')].filter(b => b.offsetParent !== null).length,
    groups: [...fin.querySelectorAll('.rl-grp-h .rl-gnm')].map(g => g.textContent),
  };
});
check('Every console is on the rail', side.consoles.length === 5, side.consoles.join(' | '));
check('Finance is the open one, and the only one', side.financeOpen && side.openCount === 1, String(side.openCount));
check('Every finance page is visible in it', side.visibleLinks === side.links && side.links >= 19, `${side.visibleLinks} of ${side.links}`);
check('Finance keeps its five groups', side.groups.length === 5, side.groups.join(' | '));
check('Closing a group hides its pages', await page.evaluate(async () => {
  const money = [...document.querySelectorAll('#appRail .rl-grp')].find(g => g.querySelector('.rl-gnm').textContent === 'Money');
  money.querySelector('.rl-grp-h').click();
  await new Promise(r => setTimeout(r, 250));
  const again = [...document.querySelectorAll('#appRail .rl-grp')].find(g => g.querySelector('.rl-gnm').textContent === 'Money');
  const hidden = [...again.querySelectorAll('.rl-item')].every(b => b.offsetParent === null);
  again.querySelector('.rl-grp-h').click();
  return hidden;
}));
check('The group holding the current page cannot be left closed', await page.evaluate(async () => {
  window.fin.go('reports');
  await new Promise(r => setTimeout(r, 300));
  const tax = () => [...document.querySelectorAll('#appRail .rl-grp')].find(g => g.querySelector('.rl-gnm').textContent === 'Tax & reports');
  tax().querySelector('.rl-grp-h').click();
  await new Promise(r => setTimeout(r, 250));
  const stillOpen = tax().classList.contains('open');
  window.fin.go('overview');
  return stillOpen;
}));
check('Opening another console closes Finance', await page.evaluate(async () => {
  const head = n => [...document.querySelectorAll('#appRail .rl-h')].find(h => h.querySelector('.rl-nm').textContent === n);
  head('CRM').click();
  await new Promise(r => setTimeout(r, 250));
  const secs = [...document.querySelectorAll('#appRail .rl-sec')];
  const open = secs.filter(s => s.classList.contains('open')).map(s => s.querySelector('.rl-h .rl-nm').textContent);
  head('Finance').click();
  return open.length === 1 && open[0] === 'CRM';
}));
check('Bottom bar hidden on desktop', await page.evaluate(() => getComputedStyle(document.getElementById('bottomnav')).display === 'none'));

section('Errors');
check('No page errors', pageErrors.length === 0, pageErrors.join(' | '));
check('No console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();

// ── put the books back ──────────────────────────────────────────────────────────
section('Cleanup');
if (testTxn) {
  const att = testTxn.attachments?.[0];
  if (att?.path) {
    // Same JWT dance as the API, so the test file does not linger in Drive.
    const { token: driveToken, api } = await import('./_drive.mjs').catch(() => ({}));
    if (driveToken) {
      try { await api(await driveToken(true), 'files/' + att.path, { method: 'DELETE' }); console.log('  drive file removed'); }
      catch (e) { console.log('  drive cleanup skipped:', e.message); }
    }
  }
  await root.collection('txns').doc(testTxn.id).delete();
  await root.set({ nextTxnNo: before.nextTxnNo }, { merge: true });
  console.log(`  test entry removed, counter back to #${before.nextTxnNo}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { failures.forEach(f => console.log('  · ' + f)); process.exit(1); }
process.exit(0);
