// ═══════ THE CACHE, IN A REAL BROWSER ═══════
//
// finance-cache.js is the one module whose correctness rests on IndexedDB's own semantics —
// the order requests run in, what a cursor sees of its own transaction, what a transaction
// commits as one — and none of that can be modelled in node. So it is exercised here in a
// real Chromium, against the real store.
//
// Needs the preview server running at the repo root:
//   python -m http.server 5199
//   node tests/cache-browser.mjs

import { chromium } from 'playwright';

const b = await chromium.launch();
const p = await b.newPage();
p.on('console', m => { if (m.type() === 'error') console.log('  console:', m.text()); });
p.on('pageerror', e => console.log('  page error:', e.message));
await p.goto('http://127.0.0.1:5199/finance-assets/', { waitUntil: 'load' });

const out = await p.evaluate(async () => {
  const C = await import('/finance-assets/finance-cache.js');
  const T = 't_test';
  const r = [];
  const ok = (label, cond, detail) => r.push({ label, ok: !!cond, detail: cond ? '' : String(detail ?? '') });
  const rows = (prefix, k) => Array.from({ length: k }, (_, i) => ({ id: prefix + i, v: i }));
  const lens = by => Object.fromEntries(Object.entries(by || {}).sort().map(([k, v]) => [k, v.length]));
  const ALL = ['txns', 'bills', 'parties'];

  await C.clear(T);

  // 1. The cold bootstrap's write: every collection and the cursor, one transaction.
  const c1 = { at: { seconds: 10, nanoseconds: 0 }, n: { txns: 5, bills: 2, parties: 0 }, verifiedAt: 1, build: 'v2' };
  ok('replaceAll stores', await C.replaceAll(T, { txns: rows('t', 5), bills: rows('b', 2), parties: [], _root: [{ id: 'settings', name: 'x' }] }, c1));
  let all = await C.loadAll(T);
  ok('…and loadAll returns exactly what was written', JSON.stringify(lens(all)) === JSON.stringify({ _root: 1, bills: 2, txns: 5 }), JSON.stringify(lens(all)));
  ok('…with the cursor beside it', JSON.stringify(await C.loadCursor(T)) === JSON.stringify(c1), JSON.stringify(await C.loadCursor(T)));
  ok('…and the pair agrees', C.agrees(all, c1.n, ALL));

  // 2. Replacing a collection that already holds rows: the old rows go and the new ones STAY.
  //    A key cursor deleting as it walked would have walked on into these and deleted them.
  ok('replaceCollection over existing rows', await C.replaceCollection(T, 'txns', rows('n', 7)));
  all = await C.loadAll(T);
  ok('…leaves exactly the new rows', all.txns.length === 7 && all.txns.every(d => d.id.startsWith('n')), all.txns.map(d => d.id).join(','));
  ok('…and the other collections alone', all.bills.length === 2 && all._root.length === 1, JSON.stringify(lens(all)));
  // Same again with ids that overlap the rows already there — the put replaces the row in
  // place, which is precisely the case where a walking cursor would still find and delete it.
  ok('replaceAll over existing rows with the same ids', await C.replaceAll(T, { txns: rows('n', 3), bills: rows('b', 4) }, { ...c1, n: { txns: 3, bills: 4, parties: 0 } }));
  all = await C.loadAll(T);
  ok('…leaves exactly the new rows', all.txns.length === 3 && all.bills.length === 4, JSON.stringify(lens(all)));

  // 3. A delta: two upserts, one removal, and the counts come back from inside the transaction.
  const c2 = { at: { seconds: 11, nanoseconds: 0 }, n: { txns: 3, bills: 4, parties: 0 }, verifiedAt: 1, build: 'v2' };
  const n = await C.applyDelta(T, {
    upserts: { txns: [{ id: 'n0', v: 'changed' }, { id: 'new', v: 1 }], parties: [{ id: 'p1' }] },
    removals: { bills: ['b0'] },
    cursor: c2,
  });
  ok('applyDelta returns the counts', n && n.txns === 4 && n.bills === 3 && n.parties === 1, JSON.stringify(n));
  all = await C.loadAll(T);
  ok('…which match the rows on disk', C.agrees(all, n, ALL), JSON.stringify(lens(all)));
  ok('…an upsert replaced its row in place', all.txns.find(d => d.id === 'n0').v === 'changed');
  ok('…the removal is gone', !all.bills.some(d => d.id === 'b0'));
  const cur = await C.loadCursor(T);
  ok('…and the stored cursor carries the counts', cur.at.seconds === 11 && cur.n.txns === 4 && cur.n.bills === 3 && cur.n.parties === 1, JSON.stringify(cur));
  ok('countLocal agrees', (await C.countLocal(T, 'txns')) === 4);

  // 4. A delta with no cursor — the settings row — touches nothing else.
  ok('the settings row alone', !!(await C.applyDelta(T, { upserts: { _root: [{ id: 'settings', name: 'y' }] } })));
  ok('…leaves the cursor where it was', (await C.loadCursor(T)).at.seconds === 11);
  ok('…and the row is updated', (await C.loadAll(T))._root[0].name === 'y');

  // 5. A row evicted behind the cursor's back is noticed.
  await new Promise((res, rej) => {
    const q = indexedDB.open('3pin-finance', 1);
    q.onsuccess = () => {
      const db = q.result;
      const tx = db.transaction('docs', 'readwrite');
      tx.objectStore('docs').delete(T + '/txns/new');
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    q.onerror = () => rej(q.error);
  });
  all = await C.loadAll(T);
  ok('A row deleted behind the cursor makes the pair disagree', !C.agrees(all, (await C.loadCursor(T)).n, ALL), JSON.stringify(lens(all)));

  // 6. Timestamps survive the round trip as markers.
  const fakeTs = { seconds: 5, nanoseconds: 7, toDate() { return new Date(5000); } };
  await C.applyDelta(T, { upserts: { txns: [{ id: 'ts', at: fakeTs, nested: { when: fakeTs }, list: [fakeTs] }] } });
  all = await C.loadAll(T);
  const back = all.txns.find(d => d.id === 'ts');
  ok('Timestamps are stored as markers', back.at.__ts?.seconds === 5 && back.nested.when.__ts?.nanoseconds === 7 && back.list[0].__ts?.seconds === 5, JSON.stringify(back));
  const un = C.unpackTimestamps(back, (s, ns) => ({ s, ns, real: true }));
  ok('…and rebuilt on the way out', un.at.real && un.nested.when.s === 5 && un.list[0].ns === 7);

  // 7. clear() leaves nothing for the tenant, and nothing of another tenant is touched.
  await C.replaceAll('t_other', { txns: rows('o', 2) }, { at: { seconds: 1, nanoseconds: 0 }, n: { txns: 2 } });
  ok('clear', await C.clear(T));
  const gone = await C.loadAll(T);
  ok('…leaves nothing for the tenant', gone === null || Object.keys(gone).length === 0, JSON.stringify(lens(gone)));
  ok('…and no cursor', (await C.loadCursor(T)) === null);
  ok('…and the other tenant is untouched', (await C.loadAll('t_other')).txns.length === 2);
  await C.clear('t_other');
  ok('The cache reports itself available', C.cacheAvailable());
  return r;
});
await b.close();

let failed = 0;
for (const x of out) {
  console.log((x.ok ? '  ok    ' : '  FAIL  ') + x.label + (x.ok ? '' : ' — ' + x.detail));
  if (!x.ok) failed++;
}
console.log(`\n${out.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
