// ═══════ THE CHANGE LOG CANNOT LOSE A WRITE ═══════
//
// The finance page no longer reads the ledger on every load. It follows a log — one line per
// document touched, appended in the same commit as the change — and asks only for the lines
// it has not seen. That is a very large saving resting on one claim: that the log is
// exhaustive, and that no entry, edit or deletion can fall through it and leave the books
// quietly short a row.
//
// This file tries to break that claim. It models Firestore's actual commit semantics — a
// commit is atomic, everything in it shares one server-assigned timestamp, and timestamps
// increase with commit order — then runs thousands of randomised interleavings of writes,
// deletions, catch-ups, dropped connections and evicted caches, checking after every one that
// the client's books are identical to the server's.
//
// collapseLog() is imported from the real module. The fetch-and-apply loop around it mirrors
// applyEntries() in finance-sync.js.
//
//   node tests/finance-delta.test.mjs

import { collapseLog, agrees } from '../finance-assets/finance-cache.js';

let passed = 0, failed = 0;
const fail = [];
const check = (label, ok, detail) => {
  if (ok) { passed++; console.log('  ok    ' + label); return; }
  failed++; fail.push(label + (detail ? ' — ' + detail : ''));
  console.log('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
};
const section = n => console.log('\n── ' + n);

const COLLS = ['txns', 'parties', 'bills'];

// ═══════ A MODEL OF FIRESTORE ═══════

// Commit timestamps are assigned by the server, shared by everything in one commit, and
// strictly increasing across commits. That is what makes a strict `>` on the cursor safe: it
// cannot slice a commit in half, because a commit is one timestamp.
function makeServer() {
  let clock = 0;
  const data = Object.fromEntries(COLLS.map(c => [c, new Map()]));
  const log = [];

  const stamp = () => { clock += 1; return { seconds: 1757000000 + clock, nanoseconds: 0 }; };

  return {
    // One atomic commit: the documents and the lines recording them, together.
    commit(writes) {
      const at = stamp();
      for (const { coll, id, doc, op } of writes) {
        if (op === 'del') data[coll].delete(id);
        else data[coll].set(id, { ...doc, id });
        log.push({ at, coll, docId: id, op: op || 'put' });
      }
      return at;
    },

    logSince(cursor) {
      const after = e => e.at.seconds > cursor.seconds ||
        (e.at.seconds === cursor.seconds && e.at.nanoseconds > cursor.nanoseconds);
      return log.filter(after).map(e => ({ ...e }));
    },

    logHead() { return log.length ? { ...log[log.length - 1].at } : null; },

    getDoc(coll, id) {
      const d = data[coll].get(id);
      return d ? { ...d } : null;
    },

    readAll(coll) { return [...data[coll].values()].map(d => ({ ...d })); },

    snapshot() {
      return Object.fromEntries(COLLS.map(c => [c, [...data[c].keys()].sort()]));
    },
  };
}

// ═══════ THE CLIENT, AS finance-sync.js DRIVES IT ═══════

function makeClient(server) {
  let cursor = { at: null, n: {} };
  let store = Object.fromEntries(COLLS.map(c => [c, new Map()]));
  let reads = 0;

  const bootstrap = () => {
    // The log head is read FIRST, so the cursor sits at or behind everything the collection
    // reads then see. A write landing in the gap is re-applied, never skipped.
    reads += 1;
    const at = server.logHead() || { seconds: 0, nanoseconds: 0 };
    for (const c of COLLS) {
      const docs = server.readAll(c);
      reads += Math.max(1, docs.length);
      store[c] = new Map(docs.map(d => [d.id, d]));
      cursor.n[c] = store[c].size;
    }
    cursor.at = at;
  };

  return {
    get reads() { return reads; },
    get cursorState() { return cursor; },

    // Wipes the documents but keeps the cursor — the eviction that would otherwise be silent,
    // and which hydrate() catches by comparing the stored row count against what came back.
    evictDocuments() { store = Object.fromEntries(COLLS.map(c => [c, new Map()])); },

    hydrateCheck() {
      for (const c of COLLS) {
        if (cursor.n[c] === undefined) continue;
        if (store[c].size !== cursor.n[c]) { cursor = { at: null, n: {} }; return true; }
      }
      return false;
    },

    sync() {
      if (!cursor.at) { bootstrap(); return; }

      const entries = server.logSince(cursor.at);
      reads += Math.max(1, entries.length);
      if (!entries.length) return;

      const { fetch, removals, newest } = collapseLog(entries);

      for (const { coll, docId } of fetch) {
        reads += 1;
        const d = server.getDoc(coll, docId);
        // Deleted after its line was written. Its own delete line is further down the log;
        // treating it as gone now simply gets there first.
        if (d) store[coll].set(docId, d);
        else store[coll].delete(docId);
      }
      for (const [coll, ids] of Object.entries(removals)) {
        for (const id of ids) store[coll].delete(id);
      }
      cursor.at = newest || cursor.at;
      for (const c of COLLS) cursor.n[c] = store[c].size;
    },

    snapshot() {
      return Object.fromEntries(COLLS.map(c => [c, [...store[c].keys()].sort()]));
    },
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ═══════ THE SHAPES A NAIVE CATCH-UP GETS WRONG ═══════

section('Collapsing a run of lines');

{
  // A document created and then updated twice in one burst is ONE fetch, and the fetch
  // returns its current state — replaying each step in turn would be three reads for the
  // same answer.
  const at = s => ({ seconds: s, nanoseconds: 0 });
  const { fetch, removals } = collapseLog([
    { at: at(1), coll: 'bills', docId: 'b1', op: 'put' },
    { at: at(2), coll: 'bills', docId: 'b1', op: 'put' },
    { at: at(3), coll: 'bills', docId: 'b1', op: 'put' },
  ]);
  check('Three lines about one document collapse to one fetch',
    fetch.length === 1 && !Object.keys(removals).length);
}

{
  const at = s => ({ seconds: s, nanoseconds: 0 });
  // Created then deleted: the LAST line wins, and it says the row is gone. Getting this
  // backwards would resurrect a document the server does not have.
  const { fetch, removals } = collapseLog([
    { at: at(1), coll: 'parties', docId: 'p1', op: 'put' },
    { at: at(2), coll: 'parties', docId: 'p1', op: 'del' },
  ]);
  check('Created then deleted resolves to a deletion, not a fetch',
    fetch.length === 0 && removals.parties.includes('p1'));
}

{
  const at = s => ({ seconds: s, nanoseconds: 0 });
  // Deleted then re-created under the same id — the reverse order, and the answer flips.
  const { fetch, removals } = collapseLog([
    { at: at(1), coll: 'parties', docId: 'p1', op: 'del' },
    { at: at(2), coll: 'parties', docId: 'p1', op: 'put' },
  ]);
  check('Deleted then re-created resolves to a fetch, not a deletion',
    fetch.length === 1 && !Object.keys(removals).length);
}

{
  const { newest } = collapseLog([
    { at: { seconds: 10, nanoseconds: 5 }, coll: 'txns', docId: 'a', op: 'put' },
    { at: { seconds: 10, nanoseconds: 9 }, coll: 'txns', docId: 'b', op: 'put' },
    { at: { seconds: 10, nanoseconds: 2 }, coll: 'txns', docId: 'c', op: 'put' },
  ]);
  check('The cursor moves to the furthest line, not the last one seen',
    newest.seconds === 10 && newest.nanoseconds === 9);
}

section('End to end');

{
  const s = makeServer(), c = makeClient(s);
  // Several documents in ONE commit share one timestamp. A cursor advanced to that timestamp
  // with a strict `>` must not leave the rest of the commit uncollected.
  s.commit([
    { coll: 'txns', id: 'a', doc: {} }, { coll: 'txns', id: 'b', doc: {} },
    { coll: 'txns', id: 'd', doc: {} }, { coll: 'bills', id: 'x', doc: {} },
  ]);
  c.sync();
  check('Four documents committed together all arrive', same(c.snapshot(), s.snapshot()));
}

{
  const s = makeServer(), c = makeClient(s);
  s.commit([{ coll: 'txns', id: 'a', doc: {} }]);
  c.sync();
  s.commit([{ coll: 'txns', id: 'a', op: 'del' }]);
  c.sync();
  check('A deletion reaches a device that already had the row', c.snapshot().txns.length === 0);
}

{
  const s = makeServer(), c = makeClient(s);
  s.commit([{ coll: 'parties', id: 'p1', doc: { name: 'One' } }]);
  c.sync();
  s.commit([{ coll: 'parties', id: 'p1', op: 'del' }]);
  c.sync();
  check('Deleting the LAST row of a collection empties it', c.snapshot().parties.length === 0);
}

{
  const s = makeServer(), c = makeClient(s);
  s.commit([{ coll: 'txns', id: 'a', doc: {} }]);
  c.sync();
  const before = c.reads;
  c.sync(); c.sync(); c.sync();
  check('Three loads with nothing new cost three reads', c.reads - before === 3, `${c.reads - before}`);
}

{
  const s = makeServer(), c = makeClient(s);
  s.commit([{ coll: 'txns', id: 'a', doc: {} }]);
  c.sync();
  c.evictDocuments();
  const caught = c.hydrateCheck();
  c.sync();
  check('A cache evicted behind the cursor is detected and re-read',
    caught && same(c.snapshot(), s.snapshot()));
}

{
  // Books that existed before any of this — no log at all. Everything must still be read, or
  // the first load after deploy shows a ledger missing every entry posted before it.
  const s = makeServer(), c = makeClient(s);
  s.commit([{ coll: 'txns', id: 'old1', doc: {} }, { coll: 'txns', id: 'old2', doc: {} }]);
  const bare = makeClient(s);
  bare.sync();
  check('A book whose log is empty is still read whole', bare.snapshot().txns.length === 2);
}

section('Randomised interleavings');

// A seeded generator, so a failure can be reproduced rather than merely reported.
function rng(seed) {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
}

let worstReads = 0, totalReads = 0, totalDocs = 0, runs = 0, broke = null;

for (let seed = 1; seed <= 400 && !broke; seed++) {
  const r = rng(seed);
  const s = makeServer(), c = makeClient(s);
  const live = { txns: [], parties: [], bills: [] };
  let n = 0;

  for (let step = 0; step < 60; step++) {
    const roll = r();
    if (roll < 0.5) {
      // A commit touching one to three collections at once, like save() posting an entry, the
      // bill it settles and the party it invented.
      const writes = [];
      const howMany = 1 + Math.floor(r() * 3);
      for (let k = 0; k < howMany; k++) {
        const coll = COLLS[Math.floor(r() * COLLS.length)];
        const id = 'd' + (++n);
        writes.push({ coll, id, doc: { v: step } });
        live[coll].push(id);
      }
      s.commit(writes);
    } else if (roll < 0.62) {
      const coll = COLLS[Math.floor(r() * COLLS.length)];
      if (!live[coll].length) continue;
      const id = live[coll][Math.floor(r() * live[coll].length)];
      s.commit([{ coll, id, doc: { v: step, edited: true } }]);
    } else if (roll < 0.72) {
      const coll = COLLS[Math.floor(r() * COLLS.length)];
      if (!live[coll].length) continue;
      const i = Math.floor(r() * live[coll].length);
      s.commit([{ coll, id: live[coll][i], op: 'del' }]);
      live[coll].splice(i, 1);
    } else if (roll < 0.78) {
      // The browser threw the cached documents away but kept the cursor.
      c.evictDocuments();
      c.hydrateCheck();
    } else {
      c.sync();
    }
  }

  c.sync();
  runs++;
  totalReads += c.reads;
  totalDocs += COLLS.reduce((a, k) => a + s.snapshot()[k].length, 0);
  worstReads = Math.max(worstReads, c.reads);
  if (!same(c.snapshot(), s.snapshot())) {
    broke = { seed, client: c.snapshot(), server: s.snapshot() };
  }
}

check(`${runs} randomised runs end with the client's books identical to the server's`,
  !broke, broke ? `seed ${broke.seed}` : '');

if (broke) {
  for (const k of COLLS) {
    const missing = broke.server[k].filter(id => !broke.client[k].includes(id));
    const extra = broke.client[k].filter(id => !broke.server[k].includes(id));
    if (missing.length) console.log(`    ${k} missing on client: ${missing.join(', ')}`);
    if (extra.length) console.log(`    ${k} stale on client:   ${extra.join(', ')}`);
  }
}

section('Trusting what is on disk');

{
  // The decision that stands between a cache and the screen: is what came back from
  // IndexedDB the whole books, or a store the browser emptied behind the cursor's back? A
  // wrong "yes" here once put a single entry on screen in place of the entire ledger.
  const rows = k => Array.from({ length: k }, (_, i) => ({ id: 'd' + i }));
  const C2 = ['txns', 'bills'];
  check('Counts that match are trusted', agrees({ txns: rows(3), bills: rows(1) }, { txns: 3, bills: 1 }, C2));
  check('A collection with no rows is empty, not missing', agrees({ txns: rows(3) }, { txns: 3, bills: 0 }, C2));
  check('One row short is a store that was emptied, not a smaller ledger', !agrees({ txns: rows(2), bills: rows(1) }, { txns: 3, bills: 1 }, C2));
  check('One row extra is just as wrong', !agrees({ txns: rows(4), bills: rows(1) }, { txns: 3, bills: 1 }, C2));
  check('A collection the cursor never counted is not vouched for', !agrees({ txns: rows(3), bills: rows(1) }, { txns: 3 }, C2));
  check('No cache at all is never trusted', !agrees(null, { txns: 0, bills: 0 }, C2));
  check('No cursor at all is never trusted', !agrees({ txns: rows(1) }, null, C2));
  check('A count that is not a number is not a count', !agrees({ txns: rows(1) }, { txns: '1', bills: 0 }, C2));
}

section('What it costs');

{
  // The shape of a real working week: a book that already exists, opened repeatedly, with a
  // few entries posted along the way.
  const s = makeServer(), c = makeClient(s);
  for (let i = 0; i < 2000; i++) s.commit([{ coll: 'txns', id: 'seed' + i, doc: {} }]);
  c.sync();
  const bootstrap = c.reads;

  let opens = 0;
  for (let day = 0; day < 7; day++) {
    for (let open = 0; open < 5; open++) { c.sync(); opens++; }
    s.commit([{ coll: 'txns', id: 'new' + day, doc: {} }, { coll: 'bills', id: 'b' + day, doc: {} }]);
  }
  c.sync(); opens++;
  const week = c.reads - bootstrap;
  const old = opens * 2000;

  console.log(`  a 2,000-entry book, opened ${opens} times over a week with 14 new documents`);
  console.log(`    before:  ${old.toLocaleString()} reads   (the whole ledger, every open)`);
  console.log(`    after:   ${week.toLocaleString()} reads   (one log query per open, plus what changed)`);
  console.log(`    cold start once per device: ${bootstrap.toLocaleString()} reads`);
  console.log(`    saving on the week: ${(100 - week / old * 100).toFixed(2)}%`);

  check('A week of use costs under 1% of what it used to', week < old * 0.01, `${week} vs ${old}`);
  check('Every one of those opens still ends up with the right books', same(c.snapshot(), s.snapshot()));
}

console.log(`\n  across ${runs} randomised runs: ${Math.round(totalReads / runs)} reads on average ` +
  `for books averaging ${Math.round(totalDocs / runs)} documents, worst case ${worstReads}`);

console.log('\n──────────────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\n' + fail.map(f => '  · ' + f).join('\n')); process.exit(1); }
console.log('All green.');
