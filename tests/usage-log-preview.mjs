// ═══════ DATABASE USAGE LOG — counted, saved, shown ═══════
//
//   node tests/usage-log-preview.mjs
//
// The whole local stack (tests/_agent-stack.mjs). Pages count their own reads and writes
// (shared-assets/fs-metered.js) and send them to the server; server requests are counted at the
// Firestore library itself (api/_usage.js, AsyncLocalStorage) — both land in usageLog/{day};
// Team & access → Database usage shows them ranked, in words. Owner, 27 Nov 2026.
import { startStack } from './_agent-stack.mjs';
import { track, usageDay } from '../api/_usage.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(fileURLToPath(new URL('..', import.meta.url)), 'tests/out');
mkdirSync(OUT, { recursive: true });
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)) : '')); errors.push(label); }
};
const S = await startStack({ emuPort: 8492, webPort: 8593, rich: true });
console.log('Database usage log');
try {
  const log = () => S.db.collection('usageLog').doc(usageDay()).get().then(s => (s.exists ? s.data() : null));
  // Server: a request counted at the library, named by its action.
  const r = await S.api('rameez', 'request', { kind: 'property', targetId: 'POR016', reason: 'usage test' });
  await track('agent', () => S.api('swami', 'decide', { id: r.id, decision: 'approve', days: 7 }));
  await track('agent', () => S.api('rameez', 'view', {}));
  let d = await log();
  ok('A server request is logged under its action, with reads and writes', !!d && d.srv && d.srv['agent:decide'] && d.srv['agent:decide'].r > 0 && d.srv['agent:decide'].w > 0, d && d.srv);
  ok('…the decision’s reads include the agent’s copy being rebuilt (the whole stock)', d.srv['agent:decide'].r >= 12, d.srv['agent:decide']);
  ok('…totals and the hour are kept too', d.tot && d.tot.r >= d.srv['agent:decide'].r && Object.keys(d.hours || {}).length >= 1, { tot: d.tot, hours: d.hours });
  ok('…and the log’s own writes are counted apart', d.logW >= 2, d.logW);
  const before = d.tot.r;
  await track('agent', () => S.api('swami', 'me', {}));
  // Pages: open a few, then hide them so they send their counts.
  for (const [who, path] of [['swami', '/myday.html'], ['swami', '/messages.html'], ['rameez', '/myday.html']]) {
    const { page, ctx } = await S.as(who, { viewport: { width: 1280, height: 900 } });
    await page.goto(S.BASE + path);
    await page.waitForTimeout(4000);
    const c = await page.evaluate(() => window.PinUsage && window.PinUsage.counts());
    ok(`${who} ${path}: the page counted its reads by what they are`, c && Object.keys(c).length > 0 && Object.values(c).some(x => x.r > 0), c);
    await page.evaluate(() => window.PinUsage.flush());
    await page.waitForTimeout(1500);
    if (page.__errors.length) errors.push(...page.__errors);
    await ctx.close();
  }
  await S.until(async () => { const x = await log(); return x && x.cli && Object.keys(x.cli).length >= 3; }, 15000);
  d = await log();
  const cli = Object.keys(d.cli || {});
  ok('The pages’ counts reach the log, by page and collection', cli.some(k => /^myday › /.test(k)) && cli.some(k => /^messages › threads/.test(k)), cli);
  ok('…and add to the day’s total', d.tot.r > before, { before, now: d.tot.r });
  // The screen.
  const { page, ctx } = await S.as('swami', { viewport: { width: 1280, height: 900 } });
  await page.goto(S.BASE + '/team.html?tab=usage');
  await page.waitForSelector('#usage .u-table .u-r:not(.u-th)', { timeout: 30000 });
  const txt = await page.textContent('#usage');
  ok('Team & access → Database usage shows the day, totals and the ranked list', /reads counted/.test(txt) && /Approving or rejecting access requests/.test(txt) && /Server/.test(txt) && /Page/.test(txt), txt.slice(0, 400));
  const first = await page.$$eval('#usage .u-table .u-r:not(.u-th)', rs => rs.slice(0, 3).map(r => r.textContent.replace(/\s+/g, ' ').trim()));
  ok('…biggest first', first.length >= 2, first);
  await page.click('#usage [data-who="cli"]');
  ok('…can show only the pages', await page.$$eval('#usage .u-table .u-r:not(.u-th) .tag', t => t.length > 0 && t.every(x => x.textContent === 'Page')));
  await page.click('#usage [data-who="all"]');
  await page.screenshot({ path: join(OUT, 'usage-log.png'), fullPage: true });
  ok('No page errors', !page.__errors.length && !errors.length, [...page.__errors, ...errors]);
  await ctx.close();
  const { page: pp, ctx: pc } = await S.as('swami', { viewport: { width: 390, height: 844 } });
  await pp.goto(S.BASE + '/team.html?tab=usage');
  await pp.waitForSelector('#usage .u-table', { timeout: 30000 });
  ok('Phone: nothing scrolls sideways', (await pp.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  await pp.screenshot({ path: join(OUT, 'usage-log-phone.png'), fullPage: true });
  await pc.close();
} catch (e) { console.error(e); errors.push(String(e.message)); } finally { await S.stop(); }
console.log(errors.length ? `\n${errors.length} problem(s)` : '\nAll good.');
process.exit(errors.length ? 1 : 0);
