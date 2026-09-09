// ═══════ 3 PIN REALTY — FINANCE FIRESTORE SYNC ═══════
//
// Same Firebase project, tenant and login accounts as crm.html and dashboard.html — log in
// here with the same email/password. Mirrors dashboard-assets/firebase-sync.js: the modular
// v12 SDK straight off the gstatic CDN, tenantId resolved from the Auth custom claim, and a
// window.onFinanceAuthChange hook the page implements.
//
// Everything the finance module owns lives under one document, finance/{tenantId}, so it can
// never be confused with CRM or property data. The tenant id IS the document id, which lets
// firestore.rules gate the whole subtree with the ownsTenantDoc() helper it already has.
//
// The whole ledger is cached in memory and read from there by every view. Nothing re-queries
// Firestore to render — that is what keeps the page usable on a phone once there are
// thousands of transactions.
//
// That cache is filled ONCE, ever, per device. It then lives in IndexedDB (finance-cache.js)
// and is kept current by following a change log: every write here appends one line naming the
// document it touched, and a single listener collects the lines this device has not seen.
// Opening the page when nothing has happened costs one read, whatever the ledger weighs.
//
// The listener-per-collection design this replaced cost one read PER DOCUMENT in the entire
// ledger every time the page was opened, because that is how Firestore bills a listener
// attaching. See SYNC ENGINE below for why the log is its own collection rather than a
// timestamp on each document — it is the difference between synchronisation needing the
// ledger's security rules relaxed and it needing nothing from them at all.
//
// Every write that posts to the ledger runs as a Firestore transaction rather than a batch,
// because each entry takes the next number off a counter on the settings document (#0001,
// #0002…) and that read-then-write has to be atomic across two devices.

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  getFirestore, collection, doc, setDoc, onSnapshot,
  getDoc, getDocs, writeBatch, runTransaction, query, where, limit,
  orderBy, serverTimestamp, Timestamp, getCountFromServer,
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject,
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-storage.js';

import {
  ACCOUNTS, getState, setState, blank, defaultSettings,
  validate, normalise, reversalLines, fyOf, today, ym, num,
  monthEndEntries, billOutstanding, invoiceOutstanding, docStatus,
} from './finance-core.js';
import { validateEvent } from './finance-events.js';
import { EV, PARTY_FIELDS } from './finance-events.js';
import * as CACHE from './finance-cache.js';

const firebaseConfig = {
  apiKey: 'AIzaSyCO5782HKI_ka5zx0tSBzohlvNB5rY_ZF0',
  authDomain: 'pin-realty.firebaseapp.com',
  projectId: 'pin-realty',
  storageBucket: 'pin-realty.firebasestorage.app',
  messagingSenderId: '570586680667',
  appId: '1:570586680667:web:859a61bf99fe1824725e7e',
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);

let currentTenantId = null;
let currentUser = null;
let subscribed = false;

// Which subcollections make up the books, and where each lands on the state. monthEnds is in
// this list like the rest — it is fetched and cached identically and only reshaped into a map
// at the last moment, because the sync engine has no business knowing which slices of state
// happen to be arrays and which are keyed by month.
const COLLECTIONS = [
  ['txns', 'txns'],
  ['parties', 'parties'],
  ['deals', 'deals'],
  ['subscriptions', 'subs'],
  ['loans', 'loans'],
  ['assets', 'assets'],
  ['invoices', 'invoices'],
  ['bills', 'bills'],
  ['bankStatements', 'bankStatements'],
  ['monthEnds', 'monthEnds'],
];

// The change log: one append-only line per document touched, written in the same commit as
// the change. Everything a device needs in order to catch up, and the reason no collection
// above needs a synchronisation field of its own. See SYNC ENGINE below.
const LOG = '_changes';

// The settings document is cached under this pseudo-collection so a returning visit paints
// the company name, tax config and column mappings from disk along with everything else,
// rather than showing a half-configured page for one round trip.
const ROOTC = '_root';

const SYNCED = COLLECTIONS.map(([name]) => name);

const root = () => doc(db, 'finance', currentTenantId);
const col = name => collection(db, 'finance', currentTenantId, name);
const ref = (name, id) => doc(db, 'finance', currentTenantId, name, id);

// ═══════ AUTH ═══════

window.financeAuth = {
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  logout: () => signOut(auth),
  getTenantId: () => currentTenantId,
  getUserEmail: () => currentUser?.email || null,
  getIdToken: () => currentUser ? currentUser.getIdToken() : Promise.resolve(null),
};

onAuthStateChanged(auth, async user => {
  currentUser = user;
  if (user) {
    // Force a refresh so a claim added moments ago on a freshly provisioned account is seen.
    const tokenResult = await user.getIdTokenResult(true);
    currentTenantId = tokenResult.claims.tenantId || null;
    if (!currentTenantId) {
      console.error('This account has no tenantId claim yet — contact support to finish onboarding.');
    } else {
      subscribeAll();
    }
  } else {
    currentTenantId = null;
    subscribed = false;
    hydrated = false;
    cursor = { at: null, n: {}, verifiedAt: 0 };
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    setState(blank());
    // The cached books are deliberately LEFT on disk. They are keyed by tenant, they are
    // useless without a login that Firestore rules still have to honour, and keeping them is
    // the entire point of the cache — signing back in on the same device should not re-read
    // the ledger. resetCache() clears them on request.
  }
  if (window.onFinanceAuthChange) window.onFinanceAuthChange(user, currentTenantId);
});

// ═══════ SYNC ENGINE ═══════
//
// The books are read from Firestore ONCE per device, ever. After that this device holds them
// in IndexedDB and follows a change log — one append-only collection where every write in
// this file leaves a line saying which document it touched:
//
//   finance/{tid}/_changes/{id}   →   { at, coll, docId, op }
//
// A single listener watches that log from where this device left off. Opening the page when
// nothing has happened matches nothing and costs one read. Opening it after three entries
// were posted costs three lines plus the three documents. The ledger's size does not enter
// into it, which is the entire point: the design this replaced attached a listener to every
// collection with no bound, and Firestore bills a listener one read PER DOCUMENT when it
// attaches, so opening the page twice cost twice the whole ledger.
//
// WHY THE LOG IS A SEPARATE COLLECTION. The obvious way to find changes is to stamp each
// document with an updatedAt and query for stamps newer than a cursor. It is one fewer
// collection and one fewer write. It is also wrong here: firestore.rules holds a posted
// journal entry to exactly two mutable fields, and stamping it would mean widening that rule
// — making an accounting invariant more permissive in order to make synchronisation
// convenient. A log entry is a new document in a collection of its own, so nothing that
// guards the ledger has to give an inch, and nothing that guards the ledger has to be
// touched again the next time this engine changes. This is how a message queue, an oplog or
// any other catch-up feed is built, and for exactly this reason.
//
// WHY IT CANNOT MISS A CHANGE:
//
//   1. The log entry is written in the SAME transaction or batch as the change itself.
//      Firestore commits those atomically, so there is no ordering in which a document moves
//      without its line, or a line appears for a document that did not move.
//   2. `at` is a serverTimestamp — assigned by Firestore at commit, not by a device clock —
//      so two phones with skewed clocks cannot produce out-of-order entries.
//   3. The cursor advances only to a timestamp actually seen in a result, and it is written
//      to IndexedDB in the same transaction as the documents it accounts for. Interrupt the
//      browser anywhere and the cursor is behind the data, never ahead.
//
// And what remains — a document changed by something that never wrote a line, a console edit,
// a script from before the log existed — is DETECTED rather than prevented: verify() compares
// Firestore's own count() against what is held here, and re-reads anything that disagrees.

let cursor = { at: null, n: {}, verifiedAt: 0 };
let hydrated = false;
let unsubscribe = null;

// A cursor older than the window the cron prunes to cannot be trusted to have seen every
// line, so the books are read afresh instead. Checked against the device's own clock, which
// is allowed to be wrong by hours without mattering — the window is ninety days.
const RETENTION_DAYS = 90;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

const tsOf = c => (c && typeof c.seconds === 'number') ? new Timestamp(c.seconds, c.nanoseconds || 0) : null;
const plain = c => c ? { seconds: c.seconds, nanoseconds: c.nanoseconds } : null;
const rehydrate = d => CACHE.unpackTimestamps(d, (s, n) => new Timestamp(s, n));

// Is this log entry past the cursor — that is, not already applied?
const after = at => {
  const c = cursor.at;
  if (!c) return true;
  return at.seconds > c.seconds || (at.seconds === c.seconds && (at.nanoseconds || 0) > c.nanoseconds);
};

async function subscribeAll() {
  if (subscribed) return;
  subscribed = true;
  await hydrate();
  await follow();
}

// Paint from disk before the network is touched at all. On a returning visit this is the
// whole render path — by the time the log listener reports in there is usually nothing to do.
async function hydrate() {
  const tenant = currentTenantId;
  const [byColl, saved] = await Promise.all([CACHE.loadAll(tenant), CACHE.loadCursor(tenant)]);
  if (!byColl || !saved || !saved.at) return;    // no cache, or one with no cursor: start cold
  cursor = { at: null, n: {}, verifiedAt: 0, ...saved };

  // The cursor and the documents it accounts for are written together, but they can still
  // come apart afterwards: a browser evicting site data under storage pressure clears the
  // document store while the small meta store survives, and iOS does this on its own after a
  // week or so of not visiting. A cursor that outlives its rows is the one failure that would
  // be SILENT — the page would show an empty ledger and believe it was current, because
  // "nothing has changed since" is a perfectly true answer about a collection that was wiped.
  //
  // So the row count stored with the cursor is checked against what actually came back. Any
  // disagreement throws the cursor away entirely and reads the books again.
  for (const c of SYNCED) {
    const expected = cursor.n?.[c];
    if (expected === undefined) continue;        // written by a build that did not record it
    if ((byColl[c] || []).length !== expected) {
      console.warn(`Finance cache incomplete (${c}: ${(byColl[c] || []).length} of ${expected}) — reading the books again`);
      cursor = { at: null, n: {}, verifiedAt: 0 };
      return;
    }
  }

  // Too old to trust the log to still hold every line since.
  if (cursor.at && Date.now() - cursor.at.seconds * 1000 > RETENTION_MS) {
    console.warn('Finance cursor older than the log keeps — reading the books again');
    cursor = { at: null, n: {}, verifiedAt: 0 };
    return;
  }

  applyToState(byColl, (byColl[ROOTC] || [])[0] || null);
  hydrated = true;
  notify('cache');
}

// Rebuilds the in-memory state from cached rows. monthEnds is the one slice keyed by id
// rather than listed, which is finance-core's blank() shape and what every close lookup
// expects; everything else lands as an array under its state key.
//
// `complete` says whether byColl is the WHOLE cache or only part of it, and the difference is
// not cosmetic: loadAll() only creates a key for a collection holding at least one row, so a
// collection whose last row was just deleted comes back missing rather than empty. Read as
// "not included" that would leave the deleted row on screen for ever; read as empty it clears,
// which is right when the whole cache was read.
function applyToState(byColl, settings, { complete = true } = {}) {
  const s = getState();
  if (settings) {
    s.settings = { ...defaultSettings(), ...rehydrate(settings) };
    s.settingsExists = true;
  }
  for (const [name, key] of COLLECTIONS) {
    if (!byColl[name] && !complete) continue;
    const docs = (byColl[name] || []).map(rehydrate);
    if (name === 'monthEnds') {
      const m = {};
      for (const d of docs) m[d.id] = d;
      s.monthEnds = m;
    } else {
      s[key] = docs;
    }
  }
}

// ── following the log ──────────────────────────────────────────────────────────

// The settings document is small, singular and read on its own — it is the one thing not
// worth a log line, because watching it directly costs exactly the same one read.
function watchSettings() {
  onSnapshot(root(), snap => {
    const data = snap.exists() ? snap.data() : null;
    const s = getState();
    s.settings = { ...defaultSettings(), ...(data || {}) };
    s.settingsExists = snap.exists();
    if (data && !snap.metadata.hasPendingWrites) {
      CACHE.applyDelta(currentTenantId, { upserts: { [ROOTC]: [{ id: 'settings', ...data }] } });
    }
    notify('settings');
  }, err => console.error('Finance settings sync error:', err));
}

// Attaches the log listener at the cursor. Everything appended from here on is pushed to this
// device as it happens, so the page stays live exactly as it did when eleven listeners were
// streaming whole collections — at one read per change rather than one read per document in
// the books.
async function follow() {
  if (!hydrated) await bootstrap();
  watchSettings();
  listen();
}

function listen() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  const from = tsOf(cursor.at) || new Timestamp(0, 0);
  unsubscribe = onSnapshot(
    query(col(LOG), where('at', '>', from), orderBy('at')),
    snap => {
      // Only entries new to this listener, only once the server has confirmed them — a
      // pending local write carries a null timestamp and would move the cursor to nothing —
      // and only those the cursor has not already passed. That last filter is what stops a
      // write being applied twice: pullNow() collects its own lines the moment it commits so
      // that `await save()` returns with the entry in state, and this listener would
      // otherwise hand the same lines back a heartbeat later.
      const fresh = snap.docChanges()
        .filter(c => c.type === 'added' && c.doc.data().at && after(c.doc.data().at))
        .map(c => ({ id: c.doc.id, ...c.doc.data() }));
      if (fresh.length) queueApply(fresh);

      // A tab left open for weeks would otherwise accumulate every line since it attached.
      // Re-attaching at the current cursor drops them and costs one read.
      if (snap.size > 500) setTimeout(listen, 0);
    },
    err => console.error('Finance change log error:', err),
  );
}

// The one full read, on a device that has never opened these books. The log's own head is
// read FIRST, so the cursor starts at or behind the commit of everything the read then sees:
// a write landing in the gap is re-applied from the log, which is harmless, rather than
// skipped, which would not be.
async function bootstrap() {
  const tenant = currentTenantId;
  const head = await getDocs(query(col(LOG), orderBy('at', 'desc'), limit(1)));
  // An empty log starts the cursor at zero, NOT at this device's clock. A clock running a few
  // minutes fast would put the cursor in the future and silently skip every line written
  // before it caught up — and a browser's clock is not the clock that stamps Firestore
  // commits, so there is no safe amount to trust it by. Zero costs nothing: the log is empty,
  // so there is nothing behind the cursor to re-read.
  const at = plain(head.docs[0]?.data()?.at) || { seconds: 0, nanoseconds: 0 };

  const byColl = {};
  for (const [name] of COLLECTIONS) {
    const snap = await getDocs(col(name));
    byColl[name] = snap.docs.map(d => ({ ...d.data(), id: d.id }));
  }
  const next = { at, n: {}, verifiedAt: Date.now() };
  for (const [name] of COLLECTIONS) {
    await CACHE.replaceCollection(tenant, name, byColl[name]);
    next.n[name] = byColl[name].length;
  }
  await CACHE.saveCursor(tenant, next);
  cursor = next;
  applyToState(byColl, null, { complete: false });
  hydrated = true;
  notify('bootstrap');
}

// ── applying what the log says ─────────────────────────────────────────────────

// Applications are serialised, and one that throws is RETRIED rather than dropped. Without
// the retry a delta lost to a dead tunnel or a tab suspended mid-fetch would sit uncollected
// until the page was next opened — the one way this design could show stale figures without
// knowing it.
let pendingEntries = [], applying = false, applyChain = Promise.resolve();
let retryToken = 0, retryIn = 2000;
const RETRY_MAX = 60000;

function queueApply(entries) {
  pendingEntries.push(...entries);
  if (applying) return applyChain;
  applying = true;
  applyChain = (async () => {
    try {
      while (pendingEntries.length) {
        const batch = pendingEntries;
        pendingEntries = [];
        await applyEntries(batch);
      }
      retryIn = 2000;
      await maybeVerify();
    } catch (e) {
      console.error('Finance sync failed, retrying:', e);
      // Nothing below commits unless the whole pass succeeded, so the cursor has not moved
      // and the retry asks for exactly the same entries again.
      pendingEntries.unshift(...(e.__entries || []));
      const wait = retryIn;
      retryIn = Math.min(retryIn * 2, RETRY_MAX);
      const mine = ++retryToken;
      setTimeout(() => { if (mine === retryToken && pendingEntries.length) queueApply([]); }, wait);
    } finally {
      applying = false;
    }
  })();
  return applyChain;
}

async function applyEntries(entries) {
  const tenant = currentTenantId;
  const { fetch, removals, newest } = CACHE.collapseLog(entries);
  const upserts = {};

  // Every fetch runs before anything is written anywhere, so a failure part-way leaves the
  // cursor and the cache exactly as they were and the retry re-asks for the same entries.
  try {
    const got = await Promise.all(fetch.map(e => getDoc(ref(e.coll, e.docId))));
    got.forEach((snap, i) => {
      const e = fetch[i];
      // Deleted between the line being written and this fetch. The delete has its own line
      // further down the log; treating it as a removal now simply gets there first.
      if (!snap.exists()) { (removals[e.coll] || (removals[e.coll] = [])).push(e.docId); return; }
      (upserts[e.coll] || (upserts[e.coll] = [])).push({ ...snap.data(), id: snap.id });
    });
  } catch (err) {
    err.__entries = entries;
    throw err;
  }

  const next = { ...cursor, at: newest || cursor.at };

  // Documents and cursor go to disk in ONE IndexedDB transaction, so the cursor can never
  // claim to have seen rows that were not stored.
  const stored = await CACHE.applyDelta(tenant, { upserts, removals, cursor: next });
  cursor = next;
  if (!stored) cursor.n = {};   // counts are unknown now; the next load re-reads rather than trusts

  // Reload from disk only if the disk took the write. If it did not — quota, private
  // browsing, a cache that vanished mid-session — reloading would hand back the state from
  // BEFORE this delta and silently undo it on screen. Merge what was just fetched instead.
  const fresh = stored ? await CACHE.loadAll(tenant) : null;
  if (fresh) applyToState(fresh, (fresh[ROOTC] || [])[0] || null);
  else mergeIntoState(upserts, removals);
  notify('delta');
}

// The no-cache path. Same result as reloading from disk, computed from the delta alone.
function mergeIntoState(upserts, removals) {
  const s = getState();
  for (const [name, key] of COLLECTIONS) {
    const add = upserts[name] || [];
    const drop = new Set(removals[name] || []);
    if (!add.length && !drop.size) continue;
    if (name === 'monthEnds') {
      const m = { ...s.monthEnds };
      for (const d of add) m[d.id] = d;
      for (const id of drop) delete m[id];
      s.monthEnds = m;
    } else {
      const by = new Map((s[key] || []).map(d => [d.id, d]));
      for (const d of add) by.set(d.id, d);
      for (const id of drop) by.delete(id);
      s[key] = [...by.values()];
    }
  }
}

// Straight after a write, collect whatever the listener has not delivered yet rather than
// waiting on the round trip. Awaited by every write, so `await save()` still resolves with
// the entry already in state — which is what the code calling it has always been able to
// assume, back when a Firestore listener applied the write locally before the server had
// even seen it.
//
// A failure here is swallowed on purpose: the write itself committed, and reporting a sync
// error as a save error would tell the user their entry did not land when it did.
async function pullNow() {
  try {
    const from = tsOf(cursor.at) || new Timestamp(0, 0);
    const snap = await getDocs(query(col(LOG), where('at', '>', from), orderBy('at')));
    const fresh = snap.docs.filter(d => d.data().at && after(d.data().at)).map(d => ({ id: d.id, ...d.data() }));
    if (fresh.length) await queueApply(fresh);
  } catch (e) {
    console.warn('Finance post-write sync deferred:', e.message);
  }
}

// ── integrity ──────────────────────────────────────────────────────────────────

const VERIFY_EVERY = 24 * 60 * 60 * 1000;

// count() is an aggregation: Firestore bills one read per thousand documents counted, so
// checking the whole ledger costs about as much as reading a dozen. Cheap enough to run
// daily, exact enough that a collection which has drifted for ANY reason — a console edit, a
// script that never wrote a log line, a delta lost to a browser crash mid-write — is found
// and re-read rather than quietly serving wrong numbers.
//
// Returns the list of collections it repaired, or null when there was no local copy to check.
// The distinction matters: an empty list means "checked, all correct", and saying that when
// nothing was checked is the one answer this must never give.
async function maybeVerify(force = false) {
  if (!hydrated) return null;
  if (!force && Date.now() - (cursor.verifiedAt || 0) < VERIFY_EVERY) return null;
  const tenant = currentTenantId;
  const repaired = [];
  for (const [name] of COLLECTIONS) {
    const local = await CACHE.countLocal(tenant, name);
    if (local === null) return null;
    const remote = (await getCountFromServer(col(name))).data().count;
    cursor.n = { ...(cursor.n || {}), [name]: local };
    if (remote === local) continue;
    const snap = await getDocs(col(name));
    const docs = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    await CACHE.replaceCollection(tenant, name, docs);
    cursor.n[name] = docs.length;
    repaired.push(`${name} (${local} → ${remote})`);
  }
  cursor.verifiedAt = Date.now();
  await CACHE.saveCursor(tenant, cursor);
  if (repaired.length) {
    console.warn('Finance cache repaired:', repaired.join(', '));
    const fresh = await CACHE.loadAll(tenant);
    if (fresh) applyToState(fresh, (fresh[ROOTC] || [])[0] || null);
    notify('repair');
  }
  return repaired;
}

// Offered on the Admin screen, and worth reaching for if a figure ever looks wrong.
export async function verifyNow() {
  return maybeVerify(true);
}

// Drops everything held for this tenant and reloads. The escape hatch for a cache that is
// wrong in a way count() cannot see.
export async function resetCache() {
  await CACHE.clear(currentTenantId);
  cursor = { at: null, n: {}, verifiedAt: 0 };
  hydrated = false;
  location.reload();
}

let repaintQueued = false;
function notify(what) {
  // A bootstrap fills every collection at once; coalesce into one repaint.
  if (repaintQueued) return;
  repaintQueued = true;
  queueMicrotask(() => {
    repaintQueued = false;
    if (window.onFinanceData) window.onFinanceData(what);
  });
}

// ═══════ RECORDING WHAT CHANGED ═══════

// One line, appended beside every write, saying which document moved. That line is the only
// thing another device needs in order to catch up, and appending it is the only obligation a
// write here has beyond writing what it came to write.
//
// The entry goes in the SAME transaction or batch as the change. Firestore commits those
// atomically, so the log cannot record a change that did not happen, and a change cannot
// happen without being recorded. That is the whole guarantee, and it needs no timestamp on
// the document, no version counter, and no widening of any rule above.
//
// `w` is a transaction or a batch — both expose .set(ref, data), which is all this needs.
function logChange(w, coll, docId, op = 'put') {
  w.set(doc(col(LOG)), { at: serverTimestamp(), coll, docId, op });
}

// Wraps a plain write — one with no counter to reserve, so no transaction is needed — with
// its log entries in a single batch. `apply` is handed the batch and a `log` function, and
// records each document it touches.
async function commitWith(apply) {
  const b = writeBatch(db);
  const out = apply(b, (coll, docId, op = 'put') => logChange(b, coll, docId, op));
  await b.commit();
  await pullNow();
  return out;
}

// ═══════ WRITING TO THE LEDGER ═══════

function stamp(t, no) {
  const s = getState();
  const lines = normalise(t.lines);
  return {
    no: no || null,
    date: t.date || today(),
    event: t.event || 'manual',
    desc: t.desc || '',
    lines,
    totals: {
      dr: Math.round(lines.reduce((a, l) => a + num(l.dr), 0) * 100) / 100,
      cr: Math.round(lines.reduce((a, l) => a + num(l.cr), 0) * 100) / 100,
    },
    meta: t.meta || {},
    attachments: t.attachments || [],
    auto: !!t.auto,
    fy: fyOf(t.date || today(), s.settings.fyStartMonth),
    createdBy: currentUser?.email || 'unknown',
    createdAt: Date.now(),
    ...(t.reversalOf ? { reversalOf: t.reversalOf } : {}),
    ...(t.allocations && t.allocations.length ? { allocations: t.allocations } : {}),
  };
}

// Reads the entry counter inside a transaction and reserves `count` numbers. The caller must
// have done no writes yet — Firestore requires every read in a transaction before any write.
async function reserveNumbers(tx, count) {
  const snap = await tx.get(root());
  const settings = snap.exists() ? snap.data() : defaultSettings();
  const first = num(settings.nextTxnNo) || 1;
  return {
    settings,
    nos: Array.from({ length: count }, (_, i) => first + i),
    patch: count ? { nextTxnNo: first + count } : {},
  };
}

// The one entry point the Record screen uses. Materialises any brand-new parties, runs the
// event builder for real, and writes the transaction plus every master record it implies in
// a single transaction — so a half-saved deal or subscription can never exist, and the entry
// number cannot collide with one taken from another phone at the same moment.
export async function save(evKey, values, opts = {}) {
  const ev = EV[evKey];
  if (!ev) throw new Error('Unknown event ' + evKey);
  const v = { ...values };

  // 1. Turn "add new" party entries into records with reserved ids BEFORE the transaction,
  //    and seed the cache once. Firestore may run the transaction body more than once on
  //    contention, so the party writes are replayed from this list each attempt rather than
  //    being decided inside it.
  const newParties = [];
  for (const k of (PARTY_FIELDS[evKey] || [])) v[k] = resolveParty(v[k], newParties);
  // card2emi always books against a lender called "Card EMI"; reuse it rather than making
  // a new party every time a purchase is converted.
  if (evKey === 'card2emi') {
    v.__lender = resolveParty(findPartyByName('Card EMI') || { __new: true, name: 'Card EMI', type: 'lender' }, newParties);
  }

  // 2. The same field-level checks the form shows. Nothing reaches the ledger past them.
  const problems = validateEvent(evKey, v).filter(p => !p.warn);
  if (problems.length) throw new Error(problems[0].msg);

  // 3. Build for real. Nothing in here writes — it only describes what should happen.
  const out = ev.build(v);
  if (out.incomplete) throw new Error(out.effects[0] || 'Fill in the form');

  const lines = normalise(out.lines || []);
  const docs = out.docs || [];
  const updates = out.updates || [];
  const allocations = out.allocations || [];
  if (!lines.length && !docs.length && !updates.length) throw new Error('Nothing to save');
  // A cost can belong to a month earlier than the paperwork: last month's rent, invoiced on
  // the 4th. build() says so with postDate, and that — not the bill date — is the ledger date.
  const postDate = out.postDate || v.date;
  if (lines.length) validate({ ...out, date: postDate, lines });

  // 4. Document ids are reserved before the transaction so an update elsewhere in the same
  //    save can point at a document that does not exist yet — the service month's record
  //    naming the bill it produced, for instance.
  const docRefs = docs.map(d => ({ ...d, ref: doc(col(d.coll)) }));
  const keyIds = {};
  for (const d of docRefs) if (d._key) keyIds['$' + d._key] = d.ref.id;
  const link = val => {
    if (typeof val === 'string' && keyIds[val] !== undefined) return keyIds[val];
    if (Array.isArray(val)) return val.map(link);
    if (val && typeof val === 'object') return Object.fromEntries(Object.entries(val).map(([k, x]) => [k, link(x)]));
    return val;
  };

  // 5. One transaction for the entry, its number, the documents, the updates, the
  //    allocations and the invoice. Any party invented along the way is only real once this
  //    commits, so the cache entry is confirmed or removed either way.
  return runTransaction(db, async tx => {
    const { settings, nos, patch } = await reserveNumbers(tx, lines.length ? 1 : 0);

    // Every document a payment is allocated to is read first — Firestore wants all reads
    // before any write — so paid-so-far is taken from the live document, not the cache.
    const allocSnaps = [];
    for (const a of allocations) allocSnaps.push({ a, snap: await tx.get(ref(a.coll, a.id)) });

    // Every document this save touches leaves a line in the change log, written in this same
    // transaction. Another device therefore learns about the entry and the bill it settled in
    // one atomic step — never the bill without the entry.
    for (const p of newParties) {
      tx.set(p.ref, p.record);
      logChange(tx, 'parties', p.ref.id);
    }

    let txnId = null, no = null;
    if (lines.length) {
      const tref = doc(col('txns'));
      txnId = tref.id;
      no = nos[0];
      tx.set(tref, stamp({
        ...out, lines, date: postDate, event: evKey,
        meta: stripForMeta(v),
        attachments: opts.attachments || [],
        allocations: allocations.map(a => ({ coll: a.coll, id: a.id, amt: a.amt })),
      }, no));
      logChange(tx, 'txns', txnId);
    }

    for (const d of docRefs) {
      const data = {
        ...link(d.data), createdBy: currentUser?.email || 'unknown',
        createdAt: Date.now(),
      };
      if (d._linkTxn && txnId) data.txnId = txnId;
      if (d.coll === 'bills' && no) data.no = no;
      tx.set(d.ref, data);
      logChange(tx, d.coll, d.ref.id);
    }
    for (const u of updates) {
      tx.update(ref(u.coll, u.id), link(u.data));
      logChange(tx, u.coll, u.id);
    }

    // Allocations: paid-so-far and status move together, and the payment is recorded on the
    // document so the vendor statement can show which payment settled which bill.
    for (const { a, snap } of allocSnaps) {
      if (!snap.exists()) continue;
      const cur = snap.data();
      // A voided document is closed for good — allocating to it would resurrect it.
      if (cur.status === 'void') continue;
      const paid = Math.round((num(cur.paid) + num(a.amt)) * 100) / 100;
      const total = a.coll === 'bills' ? num(cur.net ?? cur.total) : num(cur.total);
      const outstanding = Math.round((total - paid) * 100) / 100;
      tx.update(ref(a.coll, a.id), {
        paid,
        status: docStatus(outstanding, total),
        ...(a.creditNote ? { credited: Math.round((num(cur.credited) + num(a.amt)) * 100) / 100 } : {}),
        allocations: [...(cur.allocations || []),
          { txnId, amt: a.amt, date: v.date || today(), ...(a.writtenOff ? { writtenOff: true } : {}), ...(a.creditNote ? { creditNote: true } : {}) }],
      });
      logChange(tx, a.coll, a.id);
    }

    // A GST invoice takes the next invoice number off the same settings document, in the
    // same transaction, so the sequence stays gapless and can never double up.
    let invoiceId = null, invoiceNo = null;
    if (out.invoice && txnId) {
      const n = num(settings.nextInvoiceNo) || 1;
      invoiceNo = (settings.invoicePrefix || '3PIN/') + String(n).padStart(3, '0');
      const iref = doc(col('invoices'));
      invoiceId = iref.id;
      const invPaid = num(out.invoice.paid);
      tx.set(iref, {
        ...out.invoice, txnId, invoiceNo,
        paid: invPaid, status: docStatus(num(out.invoice.total) - invPaid, out.invoice.total),
        allocations: [],
        createdBy: currentUser?.email || 'unknown', createdAt: Date.now(),
      });
      logChange(tx, 'invoices', invoiceId);
      patch.nextInvoiceNo = n + 1;
    }

    // A partial credit note takes the next number in the credit-note series and is stored
    // against the invoice it reduces. The invoice stays live — only what it is worth changes.
    let creditNoteNo = null;
    if (out.creditNote && txnId) {
      const n = num(settings.nextCreditNoteNo) || 1;
      creditNoteNo = (settings.creditNotePrefix || '3PIN/CN/') + String(n).padStart(3, '0');
      const cnref = doc(col('invoices'));
      tx.set(cnref, {
        kind: 'creditnote', ...out.creditNote, invoiceNo: creditNoteNo, txnId, status: 'issued',
        desc: 'Credit note — ' + (out.creditNote.reason || ''),
        createdBy: currentUser?.email || 'unknown', createdAt: Date.now(),
      });
      logChange(tx, 'invoices', cnref.id);
      patch.nextCreditNoteNo = n + 1;
    }

    let selfInvoiceNo = null;
    if (out.selfInvoice && txnId) {
      const n = num(settings.nextSelfInvoiceNo) || 1;
      selfInvoiceNo = (settings.selfInvoicePrefix || '3PIN/SI/') + String(n).padStart(3, '0');
      tx.update(ref('txns', txnId), { selfInvoiceNo, selfInvoice: out.selfInvoice });
      patch.nextSelfInvoiceNo = n + 1;
    }

    if (Object.keys(patch).length) tx.set(root(), patch, { merge: true });
    return {
      txnId, no, invoiceId, invoiceNo, selfInvoiceNo, creditNoteNo, desc: out.desc,
      total: lines.reduce((a, l) => a + num(l.dr), 0),
    };
  }).then(
    async r => { clearPendingParties(newParties, true); await pullNow(); return r; },
    e => { clearPendingParties(newParties, false); throw e; },
  );
}

// Party values arrive either as an existing id or as {__new:true, name, phone}. New ones get
// a document id reserved up front so the journal can reference them inside the transaction.
function resolveParty(value, newParties) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const existing = findPartyByName(value.name);
  if (existing) return existing;
  const pref = doc(col('parties'));
  const record = {
    name: String(value.name || '').trim(),
    type: value.type || 'other',
    phone: value.phone || '',
    email: value.email || '',
    gstin: value.gstin || '',
    state: value.state || '',
    crmRef: value.crmRef || null,
    createdAt: Date.now(),
  };
  newParties.push({ ref: pref, record });
  // Seed the cache straight away. build() runs before the onSnapshot echo gets back, and it
  // asks for this party's name to write the transaction description — without this it would
  // render as "—" on the very entry that created the party.
  getState().parties.push({ ...record, id: pref.id, __pending: true });
  return pref.id;
}

// A pending party exists only in this browser's cache until the transaction commits, so it
// must never satisfy a lookup — otherwise a retry after a failed save silently reuses an id
// that was never written.
function clearPendingParties(newParties, committed) {
  const s = getState();
  for (const p of newParties) {
    const hit = s.parties.find(x => x.id === p.ref.id);
    if (!hit) continue;
    if (committed) delete hit.__pending;
    else s.parties.splice(s.parties.indexOf(hit), 1);
  }
}

function findPartyByName(name) {
  if (!name) return null;
  const hit = getState().parties.find(
    p => !p.__pending && p.name.trim().toLowerCase() === String(name).trim().toLowerCase());
  return hit ? hit.id : null;
}

// The form values are kept on the transaction so an entry can be explained later, but the
// bulky picker objects are flattened first — Firestore rejects undefined and nested classes.
function stripForMeta(v) {
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined || val === null || k.startsWith('__') || k === 'alloc') continue;
    if (typeof val === 'object') {
      out[k] = val.id || val.name || JSON.stringify(val).slice(0, 200);
    } else {
      out[k] = val;
    }
  }
  return out;
}

// A mistake is corrected by posting the opposite entry, never by editing or deleting the
// original — both stay on the record, which is what makes the ledger auditable.
export async function reverse(txnId) {
  const t = getState().txns.find(x => x.id === txnId);
  if (!t) throw new Error('Transaction not found');
  if (t.reversedBy) throw new Error('This entry has already been reversed');

  // Reversing an invoiced entry has to issue a credit note against the original — GST does
  // not allow an invoice to simply disappear.
  const inv = getState().invoices.find(i => i.txnId === txnId && i.kind !== 'creditnote');
  // The same rule as bills: an invoice with a payment still standing against it would go
  // negative if its entry were reversed underneath that payment.
  if (inv && (inv.allocations || []).reduce((a, x) => a + num(x.amt), 0) > 0.005) {
    throw new Error(`${inv.invoiceNo} has a payment against it. Reverse the payment first, or reduce the invoice with a credit note instead.`);
  }
  // A reversed payment gives its allocations back to the bills it settled; a reversed bill
  // is voided so it stops showing as owed.
  const allocs = t.allocations || [];
  // Read the documents this entry created from the SERVER, not the snapshot cache: undo
  // pressed a moment after saving would otherwise find nothing and silently leave the bill
  // open on the Owed tab.
  const madeSnap = await getDocs(query(col('bills'), where('txnId', '==', txnId)));
  const madeBills = madeSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(b => b.status !== 'void');
  const stillSettled = b => (b.allocations || []).reduce((a, x) => a + num(x.amt), 0) > 0.005;
  const settled = madeBills.find(stillSettled);
  if (settled) {
    throw new Error(`${settled.desc} has already been paid. Reverse the payment first, then reverse this entry.`);
  }
  // The vendor's own bill was attached to this accrual afterwards. Undoing the accrual would
  // leave that entry pointing at a voided document, so it has to come off first.
  const truedUp = madeBills.find(b => b.billNo && b.accrued === false);
  if (truedUp) {
    throw new Error(`The vendor bill ${truedUp.billNo} was recorded against ${truedUp.desc} with "Bill arrived". Reverse that entry first, then reverse this one.`);
  }
  const svcMonth = madeBills.filter(b => b.serviceId && b.month).map(b => ({ subId: b.serviceId, m: b.month }));

  // Dated on the original's day while that month is still open, so a mistake corrected
  // inside a month leaves the month entirely — the P&L, the cash book and the statement all
  // agree it never happened. Once a month is closed its figures stand: the correction is
  // dated today and the current month carries it, which is how every accounting package
  // treats a closing date.
  const when = getState().monthEnds[ym(t.date)] ? today() : t.date;

  return runTransaction(db, async tx => {
    const { settings, nos, patch } = await reserveNumbers(tx, 1);
    const allocSnaps = [];
    for (const a of allocs) allocSnaps.push({ a, snap: await tx.get(ref(a.coll, a.id)) });

    const rref = doc(col('txns'));
    tx.set(rref, stamp({
      date: when,
      event: 'reverse',
      desc: 'Reversal — ' + t.desc,
      lines: reversalLines(t.lines),
      reversalOf: t.id,
    }, nos[0]));
    logChange(tx, 'txns', rref.id);
    tx.update(ref('txns', t.id), { reversedBy: rref.id });
    logChange(tx, 'txns', t.id);

    for (const { a, snap } of allocSnaps) {
      if (!snap.exists()) continue;
      const cur = snap.data();
      if (cur.status === 'void' || madeBills.some(b => b.id === a.id)) continue;
      const paid = Math.max(0, Math.round((num(cur.paid) - num(a.amt)) * 100) / 100);
      const total = a.coll === 'bills' ? num(cur.net ?? cur.total) : num(cur.total);
      tx.update(ref(a.coll, a.id), {
        paid, status: docStatus(total - paid, total),
        allocations: [...(cur.allocations || []), { txnId: rref.id, amt: -num(a.amt), date: when, reversal: true }],
      });
      logChange(tx, a.coll, a.id);
    }
    for (const b of madeBills) {
      tx.update(ref('bills', b.id), { status: 'void', voidedBy: rref.id });
      logChange(tx, 'bills', b.id);
    }
    for (const { subId, m } of svcMonth) {
      tx.update(ref('subscriptions', subId), {
        [`charges.${m}.reversed`]: true, [`charges.${m}.reversedBy`]: rref.id,
      });
      logChange(tx, 'subscriptions', subId);
    }

    let creditNoteNo = null;
    if (inv) {
      const n = num(settings.nextCreditNoteNo) || 1;
      creditNoteNo = (settings.creditNotePrefix || '3PIN/CN/') + String(n).padStart(3, '0');
      const invFy = fyOf(inv.date, settings.fyStartMonth);
      const window = `${Number(invFy.slice(0, 4)) + 1}-11-30`;
      const cnref = doc(col('invoices'));
      tx.set(cnref, {
        kind: 'creditnote', against: inv.invoiceNo, againstId: inv.id, invoiceNo: creditNoteNo,
        date: today(), beyondS34: today() > window, s34Window: window,
        partyId: inv.partyId, dealId: inv.dealId || null,
        base: inv.base, gstRate: inv.gstRate, cgst: inv.cgst || 0, sgst: inv.sgst || 0, igst: inv.igst || 0,
        total: inv.total, placeOfSupply: inv.placeOfSupply || null, sac: inv.sac || null,
        desc: 'Credit note — ' + t.desc, txnId: rref.id, status: 'issued',
        createdBy: currentUser?.email || 'unknown', createdAt: Date.now(),
      });
      logChange(tx, 'invoices', cnref.id);
      patch.nextCreditNoteNo = n + 1;
      // The original stops being a live receivable the moment it is credit-noted, or the
      // Owed list and the ageing keep claiming money the ledger has already reversed.
      tx.update(ref('invoices', inv.id), {
        status: 'void', voidedBy: rref.id, creditNote: creditNoteNo,
      });
      logChange(tx, 'invoices', inv.id);
    }
    tx.set(root(), patch, { merge: true });
    return { id: rref.id, no: nos[0], creditNoteNo };
  }).then(async r => { await pullNow(); return r; });
}

// ═══════ MONTH END ═══════

// Idempotent: monthEndEntries() only returns work that has not been done, so a second run
// posts nothing. The guard flags and the monthEnds record are written with the entries, so
// the two can never disagree.
export async function runMonthEnd(month, opts = {}) {
  const s = getState();
  const entries = monthEndEntries(month);

  await runTransaction(db, async tx => {
    const { nos, patch } = await reserveNumbers(tx, entries.length);

    const bumped = { subscriptions: {}, assets: {} };
    entries.forEach((e, i) => {
      const eref = doc(col('txns'));
      tx.set(eref, stamp(e.txn, nos[i]));
      logChange(tx, 'txns', eref.id);
      if (e.kind === 'prepaid') {
        const sub = s.subs.find(x => x.id === e.ref);
        bumped.subscriptions[e.ref] = [...(sub.amortized || []), month];
      } else {
        const a = s.assets.find(x => x.id === e.ref);
        bumped.assets[e.ref] = [...(a.depreciated || []), month];
      }
    });
    for (const [id, amortized] of Object.entries(bumped.subscriptions)) {
      tx.update(ref('subscriptions', id), { amortized });
      logChange(tx, 'subscriptions', id);
    }
    for (const [id, depreciated] of Object.entries(bumped.assets)) {
      tx.update(ref('assets', id), { depreciated });
      logChange(tx, 'assets', id);
    }

    tx.set(ref('monthEnds', month), {
      ranAt: Date.now(),
      ranBy: currentUser?.email || 'unknown',
      entriesPosted: entries.length,
      ...(opts.overrodeReconciliation ? { overrodeReconciliation: true } : {}),
    });
    logChange(tx, 'monthEnds', month);
    if (Object.keys(patch).length) tx.set(root(), patch, { merge: true });
  });
  await pullNow();
  return entries.length;
}

// Bank reconciliation status is the one field allowed to change on a month-end record.
export async function markReconciled(month, reconciled) {
  await commitWith((b, log) => {
    b.update(ref('monthEnds', month), { reconciled: !!reconciled });
    log('monthEnds', month);
  });
}

// ═══════ INVOICES ═══════

// Used to retry an invoice that failed to generate; save() normally does this inline.
export async function createInvoice(data) {
  const iref = doc(col('invoices'));
  await runTransaction(db, async tx => {
    const snap = await tx.get(root());
    const s = snap.exists() ? snap.data() : defaultSettings();
    const nextNo = num(s.nextInvoiceNo) || 1;
    const invoiceNo = (s.invoicePrefix || '3PIN/') + String(nextNo).padStart(3, '0');
    tx.set(iref, {
      ...data, invoiceNo, status: 'unpaid',
      createdBy: currentUser?.email || 'unknown', createdAt: Date.now(),
    });
    logChange(tx, 'invoices', iref.id);
    tx.update(root(), { nextInvoiceNo: nextNo + 1 });
  });
  await pullNow();
  return iref.id;
}

export async function attachInvoicePdf(invoiceId, path, field = 'pdfPath') {
  await commitWith((b, log) => {
    b.update(ref('invoices', invoiceId), { [field]: path });
    log('invoices', invoiceId);
  });
}

// ═══════ ATTACHMENTS ═══════
//
// Bills are photographed on a phone, and a phone photo is 3–8 MB. Uploading that over a site
// office's mobile signal is slow, and Vercel refuses request bodies over 4.5 MB outright. So a
// photo is shrunk in the browser first — 1600px on the long edge is more than enough to read
// a receipt — and then sent through the API to Drive. Only a file still over the limit after
// that (a long scanned PDF) takes the direct-to-Google route.

const PROXY_LIMIT = 3.9 * 1024 * 1024;
const HARD_LIMIT = 10 * 1024 * 1024;

const okType = t => /^image\//.test(t || '') || t === 'application/pdf';

async function shrinkImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    // from-image honours the EXIF orientation, so a portrait photo does not come out sideways.
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const max = 1600;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.2 * 1024 * 1024) { bmp.close?.(); return file; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

async function apiJson(url, init) {
  const token = await window.financeAuth.getIdToken();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, ...(init.headers || {}) },
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || data.success === false) {
    throw new Error(data.error || text.slice(0, 200) || `Upload failed (${res.status})`);
  }
  return data;
}

// Returns the attachment record to store on the transaction. `onStatus` is called with a
// short human phrase as the upload moves along, for the row in the Record screen.
export async function uploadAttachment(file, txnId, onStatus = () => { }) {
  const s = getState();
  if (!okType(file.type)) throw new Error('Only photos and PDFs can be attached');

  onStatus('Preparing…');
  const f = await shrinkImage(file);
  if (f.size > HARD_LIMIT) throw new Error('That file is larger than 10 MB');

  if (s.settings.attachmentBackend !== 'drive') return uploadViaStorage(f, txnId, onStatus);

  const fy = fyOf(today(), s.settings.fyStartMonth);
  const base = { backend: 'drive', name: f.name, type: f.type, size: f.size, uploadedAt: Date.now() };

  onStatus('Uploading…');
  if (f.size <= PROXY_LIMIT) {
    const params = new URLSearchParams({ task: 'upload', action: 'put', name: f.name, type: f.type, txnId: txnId || 'unfiled', fy });
    const d = await apiJson('/api/finance?' + params, { method: 'POST', headers: { 'Content-Type': f.type }, body: f });
    return { ...base, path: d.fileId, url: d.url, thumb: d.thumb };
  }

  // Too big to pass through the function: open a session and send the bytes straight to Google.
  const init = await apiJson('/api/finance?task=upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'init', fileName: f.name, mimeType: f.type, txnId: txnId || 'unfiled', fy }),
  });
  const put = await fetch(init.sessionUrl, { method: 'PUT', headers: { 'Content-Type': f.type }, body: f });
  if (!put.ok) throw new Error('Drive refused the upload (' + put.status + ')');
  const uploaded = await put.json();
  const done = await apiJson('/api/finance?task=upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'finish', fileId: uploaded.id }),
  });
  return { ...base, path: done.fileId, url: done.url, thumb: done.thumb };
}

async function uploadViaStorage(f, txnId, onStatus) {
  onStatus('Uploading…');
  const yyyy = today().slice(0, 4);
  const safe = f.name.replace(/[^\w.\-]+/g, '_');
  const path = `finance/${currentTenantId}/${yyyy}/${txnId || 'unfiled'}/${Date.now()}_${safe}`;
  const r = storageRef(storage, path);
  await uploadBytes(r, f, { contentType: f.type });
  const url = await getDownloadURL(r);
  return {
    backend: 'storage', path, url, thumb: f.type.startsWith('image/') ? url : null,
    name: f.name, type: f.type, size: f.size, uploadedAt: Date.now(),
  };
}

export async function deleteAttachment(att) {
  if (att.backend === 'storage') {
    await deleteObject(storageRef(storage, att.path));
  } else {
    await apiJson('/api/finance?task=upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', fileId: att.path }),
    });
  }
}

// Changing the attachment list is the only edit firestore.rules permits on a posted entry,
// alongside marking it reversed.
export async function addAttachments(txnId, attachments) {
  const t = getState().txns.find(x => x.id === txnId);
  await commitWith((b, log) => {
    b.update(ref('txns', txnId), { attachments: [...(t?.attachments || []), ...attachments] });
    log('txns', txnId);
  });
}

export async function removeAttachment(txnId, att) {
  const t = getState().txns.find(x => x.id === txnId);
  await commitWith((b, log) => {
    b.update(ref('txns', txnId), { attachments: (t?.attachments || []).filter(a => a.path !== att.path) });
    log('txns', txnId);
  });
  await deleteAttachment(att).catch(e => console.warn('attachment file not removed:', e));
}

// ═══════ MASTER DATA ═══════

// The settings document IS the pointer's home, so writing it is already a change the one
// listener sees. There is nothing to bump and nothing to fetch afterwards.
export async function saveSettings(patch) {
  await setDoc(root(), patch, { merge: true });
}

export async function saveParty(id, data) {
  const r = id ? ref('parties', id) : doc(col('parties'));
  await commitWith((b, log) => {
    b.set(r, { ...data, ...(id ? {} : { createdAt: Date.now() }) }, { merge: true });
    log('parties', r.id);
  });
  return r.id;
}

export async function saveDeal(id, data) {
  const r = id ? ref('deals', id) : doc(col('deals'));
  await commitWith((b, log) => {
    b.set(r, { ...data, ...(id ? {} : { createdAt: Date.now() }) }, { merge: true });
    log('deals', r.id);
  });
  return r.id;
}

export async function saveBankStatement(data) {
  const r = doc(col('bankStatements'));
  await commitWith((b, log) => {
    b.set(r, { ...data, importedAt: Date.now(), importedBy: currentUser?.email || 'unknown' });
    log('bankStatements', r.id);
  });
  return r.id;
}

export async function updateBankStatement(id, data) {
  await commitWith((b, log) => {
    b.update(ref('bankStatements', id), data);
    log('bankStatements', id);
  });
}

// A delete needs no special handling: it leaves a line like any other change, saying the
// document is gone. If the delete is refused — the hasTxns guard in firestore.rules still
// applies, untouched — the line is refused with it, because a batch is all or nothing. There
// is no ordering in which a device is told to drop a document that still exists.
export async function removeDoc(collName, id) {
  await commitWith((b, log) => {
    b.delete(ref(collName, id));
    log(collName, id, 'del');
  });
}

// Merging duplicate parties rewrites every journal line that points at the loser, then
// deletes it. Done in chunks because a Firestore batch caps at 500 writes.
export async function mergeParties(keepId, dropId) {
  const affected = getState().txns.filter(t => t.lines.some(l => l.party === dropId));
  // 200 rather than 400: each row is now two writes — the update and the line recording it —
  // and a Firestore batch caps at 500 operations.
  for (let i = 0; i < affected.length; i += 200) {
    const slice = affected.slice(i, i + 200);
    // Each chunk bumps the pointer itself. A merge interrupted halfway then leaves other
    // devices holding exactly the lines that were actually rewritten, rather than a version
    // number promising a rewrite that never finished.
    await commitWith((b, log) => {
      for (const t of slice) {
        b.update(ref('txns', t.id), {
          lines: t.lines.map(l => l.party === dropId ? { ...l, party: keepId } : l),
        });
        log('txns', t.id);
      }
    });
  }
  await removeDoc('parties', dropId);
  return affected.length;
}

// ═══════ PROPERTY LOOKUP ═══════

// Deals may link to a property from the dashboard. That collection is flat and scoped by a
// tenantId field (not a subcollection), so it is queried the same way dashboard.html does.
let propertyCache = null;
export async function searchProperties(term) {
  if (!propertyCache) {
    const snap = await getDocs(query(collection(db, 'properties'), where('tenantId', '==', currentTenantId)));
    propertyCache = snap.docs.map(d => ({
      id: d.id,
      propertyCode: d.data().propertyCode || '',
      name: d.data().name || '',
      location: d.data().location || '',
      startingPrice: d.data().startingPrice || '',
      status: d.data().status || '',
    }));
  }
  const q = String(term || '').trim().toLowerCase();
  if (!q) return propertyCache.slice(0, 20);
  return propertyCache
    .filter(p => (p.propertyCode + ' ' + p.name + ' ' + p.location).toLowerCase().includes(q))
    .slice(0, 20);
}

// ═══════ ONE-TIME SEED ═══════

// Writes the chart of accounts and the settings document if they are not there yet. Safe to
// run more than once: existing documents are left exactly as they are.
// A short, stable fingerprint of the chart as the code currently defines it. FNV-1a: eight
// lines, no dependency, and collision-proof enough for "did this list change?".
function chartHash() {
  let h = 0x811c9dc5;
  const s = JSON.stringify(ACCOUNTS);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export async function seedFinance() {
  const snap = await getDoc(root());
  const settings = snap.exists() ? snap.data() : null;
  if (!settings) {
    await setDoc(root(), { ...defaultSettings(), nextTxnNo: 1, seededAt: Date.now() });
  }
  // The chart is upserted so an account added to the code later (the GST heads were) reaches
  // an existing project — but only when the code's list has actually changed. This used to
  // rewrite all sixty-two accounts on every call, including from the "Re-check seed" button,
  // which is sixty-two writes to say nothing happened.
  const hash = chartHash();
  if (settings && settings.chartHash === hash) return { settings: false, accounts: 0 };

  for (let i = 0; i < ACCOUNTS.length; i += 400) {
    const batch = writeBatch(db);
    for (const a of ACCOUNTS.slice(i, i + 400)) batch.set(ref('accounts', a.code), a, { merge: true });
    await batch.commit();
  }
  await setDoc(root(), { chartHash: hash }, { merge: true });
  return { settings: !settings, accounts: ACCOUNTS.length };
}

// ═══════ OPENING BALANCES ═══════

// Used once, when the books start. Posts ONE balanced journal against 3100 Opening balance
// equity, and creates the loan/asset master records the figures imply, all together.
export async function postOpeningBalances({ date, lines, loans = [], assets = [], subscriptions = [] }) {
  const balanced = normalise(lines);
  const dr = balanced.reduce((a, l) => a + num(l.dr), 0);
  const cr = balanced.reduce((a, l) => a + num(l.cr), 0);
  const gap = Math.round((dr - cr) * 100) / 100;
  // Whatever the figures do not account for is the owner's stake on day one — that is
  // exactly what 3100 is for, so the entry always balances.
  if (Math.abs(gap) > 0.005) balanced.push(gap > 0 ? { acc: '3100', cr: gap } : { acc: '3100', dr: -gap });

  return runTransaction(db, async tx => {
    const { nos, patch } = await reserveNumbers(tx, 1);
    const tref = doc(col('txns'));
    tx.set(tref, stamp({ date, event: 'opening', desc: 'Opening balances', lines: balanced, auto: true }, nos[0]));
    logChange(tx, 'txns', tref.id);
    for (const l of loans) {
      const lref = doc(col('loans'));
      tx.set(lref, { ...l, hasTxns: true, createdAt: Date.now() });
      logChange(tx, 'loans', lref.id);
    }
    for (const a of assets) {
      const aref = doc(col('assets'));
      tx.set(aref, { ...a, hasTxns: true, createdAt: Date.now() });
      logChange(tx, 'assets', aref.id);
    }
    for (const sub of subscriptions) {
      const sref = doc(col('subscriptions'));
      tx.set(sref, { ...sub, createdAt: Date.now() });
      logChange(tx, 'subscriptions', sref.id);
    }
    tx.set(root(), { ...patch, openingPosted: true, booksStartDate: date }, { merge: true });
    return tref.id;
  }).then(async r => { await pullNow(); return r; });
}

export { db, auth, storage };
