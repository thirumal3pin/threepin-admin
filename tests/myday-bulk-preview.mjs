// ═══════ MY DAY — APPROVE OR REJECT SEVERAL REQUESTS AT ONCE ═══════
//
//   node tests/myday-bulk-preview.mjs
//
// The whole local stack (tests/_agent-stack.mjs: Firestore emulator with the real rules, the real
// server, Chrome). Rameez asks for several properties; Swami (admin) opens My Day, taps Select,
// ticks them, and approves them together — each approved exactly as its own Approve button would,
// each thread told, Rameez's copy rebuilt once. Then a batch is rejected with one reason. Light,
// dark and phone screenshots land in tests/out/myday-bulk-*.png. Asked for by the owner, 26 Nov 2026.
import { startStack } from './_agent-stack.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(fileURLToPath(new URL('..', import.meta.url)), 'tests/out');
mkdirSync(OUT, { recursive: true });
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); errors.push(label); }
};

const S = await startStack({ emuPort: 8484, webPort: 8585, rich: true });
console.log('My Day — decide several at once');
try {
  // Four more requests from Rameez, on properties he has nothing to do with.
  const ids = [];
  for (const [code, why] of [['OMR014', 'Asking again — client is keen'], ['POR016', 'interested in the property'], ['ANR001', 'second look'], ['ADY002', 'office client'], ['ECR004', 'beach house client'], ['VEL003', 'client in Velachery']]) {
    const r = await S.api('rameez', 'request', { kind: 'property', targetId: code, reason: why });
    if (r.id) ids.push(r.id);
  }
  ok('Rameez has new requests waiting', ids.length >= 5, ids);
  const { page, ctx } = await S.as('swami', { viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(S.BASE + '/myday.html');
  await page.waitForSelector('#s-approve [data-quick]', { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('#s-approve [data-quick][disabled]'), null, { timeout: 15000 });
  const waiting = await page.$$eval('#s-approve [data-quick]', b => b.length);
  ok('Several approvals are waiting', waiting >= 3, waiting);
  ok('A "Select" button sits on the section heading', await page.isVisible('#s-approve [data-selmode]'));
  await page.click('#s-approve [data-selmode]');
  await page.waitForSelector('#s-approve .bulk');
  ok('Select shows a tick box on each request and the bar', (await page.$$('#s-approve [data-pick]')).length === waiting && await page.isVisible('#s-approve [data-pickall]'));
  ok('…Approve / Reject are off until something is ticked', await page.$eval('#s-approve [data-bulkok]', b => b.disabled) && await page.$eval('#s-approve [data-bulkrj]', b => b.disabled));
  // Tick the property requests Rameez just made (not the others).
  for (const id of ids.slice(0, 3)) await page.click(`#s-approve [data-pick="${id}"]`);
  ok('Three ticked: "3 selected", "Approve 3"', /3 selected/.test(await page.textContent('#s-approve .bulk')) && /Approve 3/.test(await page.textContent('#s-approve [data-bulkok]')));
  ok('…and the bar says what Approve gives each', /details for \d+ days?/.test(await page.textContent('#s-approve .bulk .qa-terms')), await page.textContent('#s-approve .bulk .qa-terms'));
  ok('…ticked requests are highlighted', (await page.$$('#s-approve .item.picked')).length === 3);
  await page.screenshot({ path: join(OUT, 'myday-bulk-light.png') });
  const before = S.calls ? S.calls.length : 0;
  await page.click('#s-approve [data-bulkok]');
  await S.until(async () => {
    const st = await Promise.all(ids.slice(0, 3).map(id => S.db.collection('accessRequests').doc(id).get().then(d => d.data().status)));
    return st.every(x => x === 'approved');
  }, 20000);
  const docs = await Promise.all(ids.slice(0, 3).map(id => S.db.collection('accessRequests').doc(id).get().then(d => d.data())));
  ok('All three approved, by Swami, with the usual terms (details with an end)', docs.every(d => d.status === 'approved' && d.decidedBy === 'swami@threepin.in' && d.terms && d.terms.until), docs.map(d => [d.status, d.terms]));
  const grants = await Promise.all(docs.map(d => S.db.collection('grants').doc(d.grantId).get().then(g => g.exists && g.data().active)));
  ok('…each with its own live grant', grants.every(Boolean), grants);
  const lines = await Promise.all(docs.map(d => S.db.collection('threads').doc(d.threadId).collection('messages').get().then(q => q.docs.map(x => x.data().text))));
  ok('…each request’s conversation says "Approved by Swami"', lines.every(l => l.some(t => /^Approved by Swami/.test(t))), lines);
  const v = (await S.db.collection('agentViews').doc(S.T + '__u_rameez').get()).data();
  const opened = (v.props || []).filter(p => docs.some(d => String(d.targetId) === String(p.id)) && p._access && p._access !== 'summary').length;
  ok('Rameez’s copy opens all three (rebuilt once at the end)', opened === 3, (v.props || []).filter(p => docs.some(d => String(d.targetId) === String(p.id))).map(p => [p.id, p._access]));
  await S.until(() => page.evaluate(n => document.querySelectorAll('#s-approve [data-quick]').length === n, waiting - 3), 15000).catch(() => {});
  ok('They leave the list', await page.$$eval('#s-approve [data-quick]', b => b.length) === waiting - 3);
  ok('…and selecting ends when nothing is left ticked', !(await page.$('#s-approve .bulk')));

  // Reject a batch with one reason.
  const rest = ids.slice(3);
  {
    await page.click('#s-approve [data-selmode]');
    await page.click(`#s-approve [data-pick="${rest[0]}"]`);
    await page.click('#s-approve [data-bulkrj]');
    await page.click('#s-approve [data-bulkrjsend]');
    ok('Reject without a reason: asked why', /Say why/.test(await page.textContent('#s-approve [data-rj="__bulk"] .rj-err')));
    await page.fill('#rj-__bulk', 'The owner wants only our office team on these');
    await page.click('#s-approve [data-bulkrjsend]');
    await S.until(async () => (await S.db.collection('accessRequests').doc(rest[0]).get()).data().status === 'rejected', 15000);
    const r = (await S.db.collection('accessRequests').doc(rest[0]).get()).data();
    ok('Rejected with that reason', r.status === 'rejected' && r.note === 'The owner wants only our office team on these', r);
  }
  // Select all.
  await page.waitForTimeout(500);
  if (await page.$('#s-approve [data-selmode]')) {
    await page.click('#s-approve [data-selmode]');
    await page.click('#s-approve [data-pickall]');
    const n = await page.$$eval('#s-approve [data-pick]', b => b.length);
    ok('"Select all" ticks every request', await page.$$eval('#s-approve [data-pick]', b => b.every(x => x.checked)) && new RegExp(n + ' selected').test(await page.textContent('#s-approve .bulk')));
    await page.click('#s-approve [data-selmode]');
    ok('"Done" clears the ticks and the bar', !(await page.$('#s-approve .bulk')) && !(await page.$('#s-approve [data-pick]')));
  }
  ok('No page errors', !errors.length, errors);
  await ctx.close();

  // Dark and phone: selecting, readable, nothing sideways.
  for (const [name, opt] of [['dark', { dark: true, viewport: { width: 1280, height: 900 } }], ['phone', { viewport: { width: 390, height: 844 } }]]) {
        const { page: p2, ctx: c2 } = await S.as('swami', opt);
    p2.on('pageerror', e => errors.push(name + ' pageerror: ' + e.message));
    await p2.goto(S.BASE + '/myday.html');
    await p2.waitForSelector('#s-approve [data-quick]', { timeout: 30000 });
    if (await p2.$('#s-approve [data-selmode]')) {
      await p2.click('#s-approve [data-selmode]');
      await p2.click('#s-approve [data-pick]');
    }
    const over = await p2.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
    ok(name + ': the bar shows and nothing scrolls sideways', !!(await p2.$('#s-approve .bulk')) && over === 0, over);
    await p2.evaluate(() => document.getElementById('s-approve').scrollIntoView({ block: 'start' }));
    await p2.screenshot({ path: join(OUT, 'myday-bulk-' + name + '.png') });
    await c2.close();
  }
  ok('No page errors', !errors.length, errors);
} finally {
  await S.stop();
}
console.log(errors.length ? `\n${errors.length} problem(s)` : '\nAll good.');
process.exit(errors.length ? 1 : 0);
