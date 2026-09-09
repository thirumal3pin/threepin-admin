// ═══════ 3 PIN REALTY — SERVER-SIDE LEDGER SNAPSHOT ═══════
//
// The nightly digest needs the whole book to say who owes what, and reading the whole book
// from Firestore every night costs one document read per document, for ever, growing with
// the ledger. Once the browser stopped doing that (see SYNC ENGINE in finance-sync.js) this
// cron became the single most expensive thing left in the project.
//
// So the cron keeps its own copy, in Firestore, compacted: the entire ledger gzipped into a
// handful of documents, plus a cursor. Each night it reads that copy, asks each collection
// only what changed since the cursor, merges, and writes back. A night with four new entries
// costs about thirty reads instead of several thousand.
//
// WHY IT IS SHAPED LIKE THIS. Firestore refuses an index entry over 7.5 KiB, and it indexes
// every field of every document automatically — so a single long JSON string field would
// make the write fail outright once the ledger grew. The payload is therefore gzipped (the
// books compress about five to one), base64'd so that string length is byte length and no
// multi-byte character can straddle a boundary, and split into an ARRAY of 4 KB pieces.
// Firestore indexes each array element separately, so every index entry stays small however
// large the book gets.
//
// Everything here is an optimisation and nothing here is a source of truth. If the snapshot
// is missing, unreadable, written by an older layout, or fails to save, loadBooks() falls
// back to reading the collections directly — the exact behaviour this replaced. A corrupt
// snapshot costs one expensive night and then rebuilds itself.

import { gzipSync, gunzipSync } from 'node:zlib';

const SNAP = '_snapshots';
const INDEX = '_index';
const LOG = '_changes';
const LAYOUT = 1;

// Must match RETENTION_DAYS in finance-assets/finance-sync.js: the client refuses to trust a
// cursor older than this and reads the books afresh instead, so the two numbers being the
// same is what makes pruning safe.
const RETENTION_DAYS = 90;

// 4 KB per array element keeps every index entry well inside Firestore's 7.5 KiB ceiling;
// 200 elements keeps every document inside the 1 MiB ceiling with room to spare.
const PIECE = 4000;
const PIECES_PER_DOC = 200;

const snapCol = (db, tenantId) => db.collection('finance').doc(tenantId).collection(SNAP);

// ═══════ CODEC ═══════

export function encode(docs) {
  const b64 = gzipSync(Buffer.from(JSON.stringify(docs), 'utf8')).toString('base64');
  const pieces = [];
  for (let i = 0; i < b64.length; i += PIECE) pieces.push(b64.slice(i, i + PIECE));
  return pieces;
}

export function decode(pieces) {
  return JSON.parse(gunzipSync(Buffer.from(pieces.join(''), 'base64')).toString('utf8'));
}

// ═══════ READING ═══════

// Firestore Timestamps do not survive JSON, so they are stored as {__ts:{seconds,nanoseconds}}
// and rebuilt with the SDK's own Timestamp class on the way out — the same trick the browser
// cache plays, for the same reason.
function pack(value) {
  if (value && typeof value === 'object' && typeof value.toDate === 'function') {
    return { __ts: { seconds: value.seconds, nanoseconds: value.nanoseconds } };
  }
  if (Array.isArray(value)) return value.map(pack);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pack(v)]));
  }
  return value;
}

function unpack(value, Timestamp) {
  if (value && typeof value === 'object' && value.__ts) {
    return new Timestamp(value.__ts.seconds, value.__ts.nanoseconds || 0);
  }
  if (Array.isArray(value)) return value.map(v => unpack(v, Timestamp));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unpack(v, Timestamp)]));
  }
  return value;
}

async function readSnapshot(db, tenantId, colls, Timestamp) {
  const idx = await snapCol(db, tenantId).doc(INDEX).get();
  if (!idx.exists) return null;
  const meta = idx.data();
  if (meta.layout !== LAYOUT || !meta.at) return null;

  const byColl = {};
  for (const c of colls) {
    const parts = meta.parts?.[c] ?? 0;
    if (!parts) { byColl[c] = []; continue; }
    const refs = [];
    for (let i = 0; i < parts; i++) refs.push(snapCol(db, tenantId).doc(`${c}-${i}`));
    const snaps = await db.getAll(...refs);
    const pieces = [];
    for (const s of snaps) {
      if (!s.exists) return null;                    // a missing part means a torn snapshot
      pieces.push(...(s.data().b64 || []));
    }
    byColl[c] = decode(pieces).map(d => unpack(d, Timestamp));
  }
  return { byColl, at: new Timestamp(meta.at.seconds ?? meta.at._seconds, meta.at.nanoseconds ?? meta.at._nanoseconds ?? 0) };
}

// ═══════ WRITING ═══════

async function writeSnapshot(db, tenantId, byColl, at, changedColls) {
  const parts = {};
  const batch = db.batch();
  for (const [coll, docs] of Object.entries(byColl)) {
    const pieces = encode(docs.map(pack));
    const n = Math.max(1, Math.ceil(pieces.length / PIECES_PER_DOC));
    parts[coll] = n;
    if (!changedColls.has(coll)) continue;           // untouched collection: leave its parts alone
    for (let i = 0; i < n; i++) {
      batch.set(snapCol(db, tenantId).doc(`${coll}-${i}`), {
        coll, i, b64: pieces.slice(i * PIECES_PER_DOC, (i + 1) * PIECES_PER_DOC),
      });
    }
  }
  // The index is written LAST and in the same batch, so a snapshot is only ever advertised
  // once every part backing it is in place. A batch that fails leaves the previous index
  // pointing at the previous parts, which are still whole.
  batch.set(snapCol(db, tenantId).doc(INDEX), {
    layout: LAYOUT, at, parts, builtAt: Date.now(),
  });
  await batch.commit();
}

// Parts left over from a rebuild that produced fewer documents than last time. Harmless if
// they linger — the index says how many to read — but they are removed so the collection
// does not accumulate orphans across years of growth and shrinkage.
async function pruneOrphans(db, tenantId, parts) {
  const all = await snapCol(db, tenantId).listDocuments();
  const keep = new Set([INDEX, ...Object.entries(parts).flatMap(([c, n]) =>
    Array.from({ length: n }, (_, i) => `${c}-${i}`))]);
  const dead = all.filter(d => !keep.has(d.id));
  if (!dead.length) return;
  const batch = db.batch();
  for (const d of dead) batch.delete(d);
  await batch.commit();
}

// ═══════ THE ONE ENTRY POINT ═══════

// Returns { byColl, at, reads, cold } — every document in each requested collection, brought
// up to date. `reads` is what it cost, which the digest logs so a regression here is visible
// in the cron output rather than only on the billing page a month later.
export async function loadBooks(db, tenantId, colls, Timestamp) {
  const root = db.collection('finance').doc(tenantId);
  let base = null;
  try {
    base = await readSnapshot(db, tenantId, colls, Timestamp);
  } catch (e) {
    console.warn('finance snapshot unreadable, falling back to a full read:', e.message);
  }

  // ── cold: no usable snapshot, so read the collections and build one ──
  //
  // The log's head is read FIRST and used as the cursor, rather than the clock of whatever
  // machine this function happens to be running on. Two reasons: a serverless clock is not
  // the same clock that stamps Firestore commits, and reading the head first means the cursor
  // sits at or behind everything the collection reads then see. A write landing in the gap is
  // re-applied from the log tomorrow, which is harmless; one skipped would not be.
  if (!base) {
    const head = await root.collection(LOG).orderBy('at', 'desc').limit(1).get();
    const at = head.empty ? new Timestamp(0, 0) : head.docs[0].data().at;
    const byColl = {};
    let reads = 1;
    for (const c of colls) {
      const snap = await root.collection(c).get();
      byColl[c] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      reads += snap.size;
    }
    await save(db, tenantId, byColl, at, new Set(colls));
    return { byColl, at, reads, cold: true };
  }

  // ── warm: read the log from the cursor and apply what it says ──
  //
  // The same log the browser follows (see SYNC ENGINE in finance-assets/finance-sync.js).
  // Deletions need no special case here: a delete leaves a line like any other change.
  const { byColl, at } = base;
  const changed = new Set();
  let reads = 1;
  let newest = at;

  const log = await root.collection(LOG).where('at', '>', at).orderBy('at').get();
  reads += Math.max(1, log.size);

  // Collapse by document — a bill created, paid and closed in one burst is one fetch, and its
  // last line decides whether it still exists.
  const wanted = new Map();
  for (const d of log.docs) {
    const e = d.data();
    if (!e.coll || !e.docId || !colls.includes(e.coll)) continue;
    wanted.set(e.coll + ' ' + e.docId, e);
    if (e.at && e.at.toMillis() > newest.toMillis()) newest = e.at;
  }

  const byId = Object.fromEntries(colls.map(c => [c, new Map(byColl[c].map(d => [d.id, d]))]));
  const fetches = [];
  for (const e of wanted.values()) {
    changed.add(e.coll);
    if (e.op === 'del') byId[e.coll].delete(e.docId);
    else fetches.push(e);
  }
  if (fetches.length) {
    const snaps = await db.getAll(...fetches.map(e => root.collection(e.coll).doc(e.docId)));
    reads += snaps.length;
    snaps.forEach((snap, i) => {
      const e = fetches[i];
      if (snap.exists) byId[e.coll].set(snap.id, { id: snap.id, ...snap.data() });
      else byId[e.coll].delete(e.docId);      // deleted after its line was written
    });
  }
  for (const c of changed) byColl[c] = [...byId[c].values()];

  if (changed.size) await save(db, tenantId, byColl, newest, changed);
  await prune(db, tenantId, newest);
  return { byColl, at: newest, reads, cold: false };
}

// The log only has to reach back as far as the oldest device that might still be catching up.
// Ninety days is far past that, and a client whose cursor is older reads the books afresh
// rather than trusting a log with a hole in it — finance-sync.js checks its own cursor's age
// before it follows. Pruning runs on the Admin SDK, which is why firestore.rules can refuse
// deletes to every client and still leave this possible.
async function prune(db, tenantId, now) {
  try {
    const cutoff = new Date(now.toMillis() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const old = await db.collection('finance').doc(tenantId).collection(LOG)
      .where('at', '<', cutoff).orderBy('at').limit(400).get();
    if (old.empty) return;
    const batch = db.batch();
    for (const d of old.docs) batch.delete(d.ref);
    await batch.commit();
    console.log(`finance change log: pruned ${old.size} entries older than ${RETENTION_DAYS} days`);
  } catch (e) {
    console.warn('finance change log not pruned:', e.message);
  }
}

// Saving is best-effort on purpose. A snapshot that cannot be written costs the next run a
// full read; a snapshot write that took the digest down with it would cost the morning email.
async function save(db, tenantId, byColl, at, changed) {
  try {
    await writeSnapshot(db, tenantId, byColl, at, changed);
    const parts = Object.fromEntries(Object.entries(byColl).map(([c, docs]) =>
      [c, Math.max(1, Math.ceil(encode(docs.map(pack)).length / PIECES_PER_DOC))]));
    await pruneOrphans(db, tenantId, parts);
  } catch (e) {
    console.warn('finance snapshot not saved:', e.message);
  }
}
