// Screenshots every screen of the finance app, with real books and no login, at desktop and
// phone width — the material a design review is done from. Needs the repo root served on
// :5199 (python -m http.server 5199) and tests/app-preview.html, which builds the books by
// posting real events through the test harness.
//
//   node tests/app-preview.mjs [output-dir]

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = (process.argv[2] || 'tests/out/app') + '/';
mkdirSync(OUT, { recursive: true });

const VIEWS = ['overview', 'record', 'txns', 'owed', 'deals', 'invoices', 'services', 'loans', 'assets',
  'bank', 'petty', 'budget', 'month', 'reports', 'books', 'gst', 'analytics', 'profile', 'settings', 'guide'];

const b = await chromium.launch();
const errs = [];
let shots = 0;

for (const [name, width] of [['desk', 1280], ['phone', 390]]) {
  const p = await b.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  p.on('pageerror', e => errs.push(`${name}: ${String(e).slice(0, 220)}`));
  p.on('console', m => { if (m.type() === 'error') errs.push(`${name} console: ${m.text().slice(0, 220)}`); });
  await p.goto('http://127.0.0.1:5199/tests/app-preview.html', { waitUntil: 'networkidle' });
  await p.waitForFunction(() => window.__ready === true, { timeout: 30000 });

  const shot = async (label, opts = {}) => {
    await p.waitForTimeout(opts.wait ?? 250);
    await p.screenshot({ path: `${OUT}${name}-${label}.png`, fullPage: opts.full !== false });
    shots++;
  };
  const go = async v => { await p.evaluate(v => window.fin.go(v), v); };

  for (const v of VIEWS) {
    await go(v);
    if (v === 'record') await p.evaluate(() => window.fin.pick(null));
    await shot(v);
  }

  // Record, in depth: the chooser filtered each way, then three representative forms.
  await go('record');
  await p.evaluate(() => { window.fin.pick(null); window.fin.pickGroup('money-out'); });
  await shot('record-group');
  await p.evaluate(() => { window.fin.pickGroup(''); window.fin.findAction('emi'); });
  await shot('record-search');
  await p.evaluate(() => window.fin.findAction(''));
  if (name === 'phone') {
    await p.evaluate(() => window.fin.record('expense'));
    await p.waitForTimeout(300);
    await p.evaluate(() => window.fin.openPreview());
    await shot('record-preview-sheet', { wait: 400, full: false });
    await p.evaluate(() => window.fin.closePreview());
  }

  const ids = await p.evaluate(() => {
    const s = window.__st();
    return {
      dealReg: s.deals.find(d => d.status === 'registered')?.id,
      dealOpen: s.deals.find(d => d.status === 'open')?.id,
      owes: Object.entries(window.__bal('1100')).find(([, b]) => b > 1)?.[0],
      txn: s.txns.find(t => t.event === 'expense' && !t.reversedBy)?.id,
      reversed: s.txns.find(t => t.reversedBy)?.id,
    };
  });

  await p.evaluate(() => window.fin.record('expense'));
  await shot('record-form-expense', { wait: 400 });
  await p.evaluate(id => window.fin.record('invoice', { deal: id, from: 'buyer' }), ids.dealOpen);
  await shot('record-form-invoice', { wait: 400 });
  await p.evaluate(id => window.fin.record('dealpay', { party: id }), ids.owes);
  await shot('record-form-dealpay', { wait: 400 });
  await p.evaluate(() => window.fin.record('confirmcharge'));
  await shot('record-form-recurring', { wait: 400 });

  // Drawers and the deal modal.
  await go('deals');
  await p.evaluate(id => window.finDeals.open(id), ids.dealReg);
  await shot('deal-drawer', { wait: 400, full: false });
  await p.evaluate(() => window.fin.closeModal());
  await go('txns');
  await p.evaluate(id => window.fin.openTxn(id), ids.txn);
  await shot('txn-drawer', { wait: 400, full: false });
  await p.evaluate(() => window.fin.closeModal());

  if (name === 'phone') {
    await go('overview');
    await p.evaluate(() => window.fin.openSheet());
    await shot('more-sheet', { wait: 300, full: false });
  }

  await p.close();
}

console.log(`${shots} screenshots in ${OUT}`);
console.log('errors:', errs.length);
errs.forEach(e => console.log('  ' + e));
await b.close();
process.exit(errs.length ? 1 : 0);
