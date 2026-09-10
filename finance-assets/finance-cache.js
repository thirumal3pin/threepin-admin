// ═══════ 3 PIN REALTY — FINANCE LOCAL CACHE ═══════
//
// The books survive between visits in IndexedDB, so opening the finance page paints from
// disk before a single byte leaves the browser. Firestore is then asked only what changed
// since the last visit — never for the whole ledger again.
//
// Why this exists at all: a Firestore listener is billed one read PER DOCUMENT every time it
// attaches, and the finance page used to attach eleven of them across every collection with
// no bound. Opening the page twice cost twice the entire ledger. That is fine at fifty
// entries and ruinous at fifty thousand, and it is the reason a page that shows the same
// numbers all day was the most expensive thing in the project.
//
// The store is deliberately dumb. It knows how to put documents in, take them out, and
// remember a cursor; it knows nothing about transactions, GST, or what a party is. All the
// synchronisation logic lives in finance-sync.js, which is the only thing that calls this.
//
// Everything here is best-effort. Private browsing, a full disk, an iOS "clear site data",
// a browser with IndexedDB disabled — every one of those makes the cache unavailable, and
// every function below then resolves to null or silently does nothing. finance-sync.js
// treats a null cache as "cold start", which is exactly the behaviour the page had before
// this file existed. Losing the cache costs reads. It can never cost correctness.

const DB_NAME = '3pin-finance';
const DB_VERSION = 1;
const DOCS = 'docs';
const META = 'meta';

// One row per Firestore document, keyed `${tenant}/${coll}/${id}`. The `scope` index holds
// `${tenant}/${coll}` so a whole collection can be read back in one cursor pass without
// walking rows belonging to other collections.
//
// Documents are stored EXACTLY as Firestore handed them over, with one exception: Firestore
// Timestamps are converted to plain `{__ts: {seconds, nanoseconds}}` markers on the way in
// and back to numbers on the way out. structuredClone (which is what IndexedDB uses) cannot
// serialise a class instance's prototype, so a Timestamp stored raw comes back as a bare
// object with no .toDate() and every date in the app quietly becomes "Invalid Date".

let dbPromise = null;
let unavailable = false;

// How long the browser gets to open the database before the page goes on without it. iOS
// Safari has been known to leave the first open() hanging for good after the page comes back
// from the background, and a page waiting on it would never paint. Past this the cache is
// treated as unavailable for the session: everything still works, from the network.
const OPEN_TIMEOUT_MS = 4000;

function open() {
  if (unavailable) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    let settled = false;
    let timer = null;
    const settle = db => {
      if (settled) { if (db) db.close(); return; }   // the open that came too late
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const giveUp = () => { unavailable = true; settle(null); };
    timer = setTimeout(giveUp, OPEN_TIMEOUT_MS);
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return giveUp();
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DOCS)) {
        db.createObjectStore(DOCS, { keyPath: 'k' }).createIndex('scope', 'scope');
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'k' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // A second tab running a newer build will bump the version; let go of the handle
      // rather than block it, and fall back to reading from the network until reload.
      db.onversionchange = () => { db.close(); dbPromise = null; unavailable = true; };
      settle(db);
    };
    req.onerror = giveUp;
    req.onblocked = giveUp;
  });
  return dbPromise;
}

// Wraps one IndexedDB transaction as a promise that resolves when the transaction COMMITS,
// not when the last request succeeds — otherwise a caller can believe a write landed while
// the transaction is still in flight and about to abort on quota.
function run(db, stores, mode, body) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(stores, mode);
    } catch (e) { return reject(e); }
    let out;
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    try {
      out = body(tx);
    } catch (e) {
      try { tx.abort(); } catch { /* already dead */ }
      reject(e);
    }
  });
}

const req2promise = r => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

// ═══════ TIMESTAMP MARKERS ═══════

// Firestore Timestamps arrive as class instances. IndexedDB stores structured clones, which
// keep own properties but drop the prototype, so `ts.toDate()` is gone after a round trip.
// They are tagged on the way in and rebuilt on the way out by finance-sync.js, which is the
// only module that holds a reference to the Firestore Timestamp constructor.

const isTs = v => v && typeof v === 'object' && typeof v.seconds === 'number'
  && typeof v.nanoseconds === 'number' && typeof v.toDate === 'function';

export function packTimestamps(value) {
  if (isTs(value)) return { __ts: { seconds: value.seconds, nanoseconds: value.nanoseconds } };
  if (Array.isArray(value)) return value.map(packTimestamps);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = packTimestamps(v);
    return out;
  }
  return value;
}

export function unpackTimestamps(value, make) {
  if (value && typeof value === 'object' && value.__ts) {
    return make(value.__ts.seconds, value.__ts.nanoseconds);
  }
  if (Array.isArray(value)) return value.map(v => unpackTimestamps(v, make));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = unpackTimestamps(v, make);
    return out;
  }
  return value;
}

// ═══════ READING ═══════

// Every document the tenant has cached, grouped by collection. One cursor pass over the
// whole store rather than one query per collection: at ledger sizes where this matters the
// difference is a few milliseconds against a page that used to wait on the network.
export async function loadAll(tenant) {
  const db = await open();
  if (!db) return null;
  try {
    return await run(db, [DOCS], 'readonly', tx => {
      const out = {};
      const prefix = tenant + '/';
      const store = tx.objectStore(DOCS);
      store.openCursor().onsuccess = e => {
        const cur = e.target.result;
        if (!cur) return;
        const row = cur.value;
        if (row.scope.startsWith(prefix)) {
          const coll = row.scope.slice(prefix.length);
          (out[coll] || (out[coll] = [])).push(row.doc);
        }
        cur.continue();
      };
      return out;
    });
  } catch {
    return null;
  }
}

// The sync cursor: how far into the change log this device has applied, and how many rows
// of each collection it held at that moment. Kept in its own store so a corrupt document row
// can never make the cursor unreadable — losing the cursor means re-reading the ledger once.
export async function loadCursor(tenant) {
  const db = await open();
  if (!db) return null;
  try {
    const row = await run(db, [META], 'readonly', tx =>
      req2promise(tx.objectStore(META).get('cursor/' + tenant)));
    return row ? row.cursor : null;
  } catch {
    return null;
  }
}

// ═══════ WRITING ═══════

// Applies one delta and moves the cursor in the SAME IndexedDB transaction. If the browser
// is closed mid-write the pair rolls back together, so the cursor can never claim to have
// seen documents that were not stored — which would silently drop them from the books until
// the next integrity check. The cursor is allowed to lag; it must never run ahead.
//
// The row count of every collection it touches is recounted here, inside that same
// transaction, and stored on the cursor. That count is what lets the next visit prove the
// documents on disk still match the cursor describing them — see loadAll's caller. Counting
// anywhere else would be a count of a different moment.
//
// Resolves to the cursor's row counts as written — every collection it knew plus every one
// this delta touched — or null if the disk refused the write, in which case nothing changed.
export async function applyDelta(tenant, { upserts = {}, removals = {}, cursor }) {
  const db = await open();
  if (!db) return null;
  try {
    const n = { ...((cursor && cursor.n) || {}) };
    await run(db, [DOCS, META], 'readwrite', tx => {
      const docs = tx.objectStore(DOCS);
      const touched = new Set();
      for (const [coll, list] of Object.entries(upserts)) {
        const scope = tenant + '/' + coll;
        touched.add(coll);
        for (const d of list) {
          docs.put({ k: scope + '/' + d.id, scope, doc: packTimestamps(d) });
        }
      }
      for (const [coll, ids] of Object.entries(removals)) {
        const scope = tenant + '/' + coll;
        touched.add(coll);
        for (const id of ids) docs.delete(scope + '/' + id);
      }
      if (!cursor) return;
      let left = touched.size;
      if (!left) return tx.objectStore(META).put({ k: 'cursor/' + tenant, cursor });
      // Every count is requested before the cursor is written, and IndexedDB runs requests
      // in the order they were made, so the put below lands last with every figure in place.
      for (const coll of touched) {
        const req = docs.index('scope').count(IDBKeyRange.only(tenant + '/' + coll));
        req.onsuccess = () => {
          n[coll] = req.result;
          if (--left === 0) tx.objectStore(META).put({ k: 'cursor/' + tenant, cursor: { ...cursor, n } });
        };
      }
    });
    return n;
  } catch {
    return null;
  }
}

// Replaces a collection wholesale. Used by the repair path after an integrity check finds the
// local count and the server count disagree — what is on disk is not trusted, so it is
// removed rather than merged into.
export async function replaceCollection(tenant, coll, docs) {
  const db = await open();
  if (!db) return false;
  try {
    await run(db, [DOCS], 'readwrite', tx => replaceIn(tx.objectStore(DOCS), tenant, coll, docs));
    return true;
  } catch {
    return false;
  }
}

// The whole books and the cursor describing them, in ONE transaction. This is the cold
// bootstrap's write: afterwards the disk holds either everything or — if the browser was
// closed halfway — nothing, and never a cursor standing over a store that is half filled.
export async function replaceAll(tenant, byColl, cursor) {
  const db = await open();
  if (!db) return false;
  try {
    await run(db, [DOCS, META], 'readwrite', tx => {
      const store = tx.objectStore(DOCS);
      for (const [coll, docs] of Object.entries(byColl)) replaceIn(store, tenant, coll, docs);
      tx.objectStore(META).put({ k: 'cursor/' + tenant, cursor });
    });
    return true;
  } catch {
    return false;
  }
}

// Every existing row of the collection goes, then every new one comes in — in that order,
// and the order is the point. A key cursor that deleted as it walked would be walking an
// index the puts were changing underneath it: a cursor sees rows written in its own
// transaction, so it would carry on and delete the very rows it had just been handed. The
// keys are read first as one list, and both the deletes and the puts are queued from that.
function replaceIn(store, tenant, coll, docs) {
  const scope = tenant + '/' + coll;
  const keys = store.index('scope').getAllKeys(IDBKeyRange.only(scope));
  keys.onsuccess = () => {
    for (const k of keys.result) store.delete(k);
    for (const d of docs) store.put({ k: scope + '/' + d.id, scope, doc: packTimestamps(d) });
  };
}

// Does what the disk holds match what the cursor says it holds? The row count of every
// collection, recorded in the same transaction as the cursor, against the rows actually read
// back. Strict on purpose: a collection the cursor has no count for is not vouched for. The
// one answer this must never give is "yes" about a store the browser has quietly emptied.
export function agrees(byColl, n, colls) {
  if (!byColl || !n) return false;
  for (const c of colls) {
    if (typeof n[c] !== 'number') return false;
    if ((byColl[c] || []).length !== n[c]) return false;
  }
  return true;
}

export async function saveCursor(tenant, cursor) {
  const db = await open();
  if (!db) return false;
  try {
    await run(db, [META], 'readwrite', tx =>
      tx.objectStore(META).put({ k: 'cursor/' + tenant, cursor }));
    return true;
  } catch {
    return false;
  }
}

// How many documents are held locally for a collection, tombstones included — the figure the
// integrity check compares against Firestore's own count(). Counted through a key cursor so
// nothing is deserialised to answer it.
export async function countLocal(tenant, coll) {
  const db = await open();
  if (!db) return null;
  try {
    return await run(db, [DOCS], 'readonly', tx =>
      req2promise(tx.objectStore(DOCS).index('scope').count(IDBKeyRange.only(tenant + '/' + coll))));
  } catch {
    return null;
  }
}

// Signing out, switching tenant, or a failed integrity check that cannot be repaired
// collection-by-collection. The next load starts cold.
export async function clear(tenant) {
  const db = await open();
  if (!db) return false;
  try {
    await run(db, [DOCS, META], 'readwrite', tx => {
      const store = tx.objectStore(DOCS);
      const prefix = tenant + '/';
      store.openCursor().onsuccess = e => {
        const cur = e.target.result;
        if (!cur) return;
        if (cur.value.scope.startsWith(prefix)) store.delete(cur.primaryKey);
        cur.continue();
      };
      tx.objectStore(META).delete('cursor/' + tenant);
    });
    return true;
  } catch {
    return false;
  }
}

export const cacheAvailable = () => !unavailable;

// ═══════ READING THE CHANGE LOG ═══════
//
// The decision that decides whether the books end up complete, kept here as a pure function
// on plain data so it can be tested exhaustively without a browser, a network, or a Firestore
// project. Everything else in the sync path is plumbing around it.

// Turns a run of log entries into the work they actually imply.
//
// Entries arrive in commit order, and a burst routinely names the same document more than
// once — a bill created, then paid, then closed, in three entries seconds apart. Only the
// LAST word about a document matters: it says whether the document still exists and, if it
// does, one fetch brings back its current state whatever the intermediate steps were. So the
// run is collapsed by document first, which is both cheaper and the only way to get the
// answer right — applying "created" after "deleted" because they were processed in the wrong
// order would resurrect a row the server does not have.
//
// Returns:
//   fetch    — documents to read back, as {coll, docId}
//   removals — {coll: [docId]}, the ones whose last word was a deletion
//   newest   — the furthest timestamp in the run, which is where the cursor moves to
export function collapseLog(entries) {
  const last = new Map();
  let newest = null;
  for (const e of entries) {
    if (e && e.coll && e.docId) last.set(e.coll + ' ' + e.docId, e);
    const at = e && e.at;
    if (!at || typeof at.seconds !== 'number') continue;
    const n = at.nanoseconds || 0;
    if (!newest || at.seconds > newest.seconds || (at.seconds === newest.seconds && n > newest.nanoseconds)) {
      newest = { seconds: at.seconds, nanoseconds: n };
    }
  }
  const fetch = [], removals = {};
  for (const e of last.values()) {
    if (e.op === 'del') (removals[e.coll] || (removals[e.coll] = [])).push(e.docId);
    else fetch.push({ coll: e.coll, docId: e.docId });
  }
  return { fetch, removals, newest };
}
