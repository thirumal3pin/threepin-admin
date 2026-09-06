// Screenshots the Analytics tab with sample books at desktop and phone width, and checks
// the filters redraw. Needs the repo root served on :5199 (python -m http.server 5199).
//
//   node tests/analytics-preview.mjs [output-dir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = (process.argv[2] || 'tests/out') + '/';
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const errs = [];
for (const [name, width] of [['desktop', 1100], ['phone', 390]]) {
  const p = await b.newPage({ viewport: { width, height: 900 } });
  p.on('pageerror', e => errs.push(name + ': ' + String(e).slice(0, 200)));
  p.on('console', m => { if (m.type() === 'error') errs.push(name + ' console: ' + m.text().slice(0, 200)); });
  await p.goto('http://localhost:5199/tests/analytics-preview.html', { waitUntil: 'networkidle' });
  await p.waitForFunction(() => window.__ready, { timeout: 15000 });
  const info = await p.evaluate(() => ({
    svgs: document.querySelectorAll('#main svg').length,
    svgHeight: Math.round(document.querySelector('#main svg')?.getBoundingClientRect().height || 0),
    bad: /undefined|NaN|\[object Object\]/.test(document.getElementById('main').innerText),
    wide: document.documentElement.scrollWidth > window.innerWidth + 1,
    income: document.querySelector('#main .stat .v')?.textContent,
  }));
  console.log(name.padEnd(8), JSON.stringify(info));
  await p.screenshot({ path: OUT + 'analytics-' + name + '.png', fullPage: true });
  const before = await p.evaluate(() => document.querySelector('#main .lead').textContent.trim().slice(0, 20));
  await p.evaluate(() => window.finAn.set('channel', '2300'));
  await p.waitForTimeout(150);
  const after = await p.evaluate(() => document.querySelector('#main .lead').textContent.trim().slice(0, 20));
  console.log(name.padEnd(8), 'channel filter:', before, '→', after);
  await p.close();
}
console.log('errors:', errs.length); errs.forEach(e => console.log('  ' + e));
await b.close();
process.exit(errs.length ? 1 : 0);
