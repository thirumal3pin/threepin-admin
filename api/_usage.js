// ═══════ DATABASE USAGE LOG — every read and write, by what it was for ═══════
//
// Owner, 27 Nov 2026: "track and maintain a log of all actions with their read and write count,
// aligned with Firebase, and why and for what — so I can find it next time."
//
// Server side: the Firestore library's few read and write points are counted (patched once, below)
// into the request that made them (AsyncLocalStorage), so nothing can read without being counted —
// whatever code path it takes. Each API entry runs inside track('<name>'); a handler may name itself
// more exactly with relabel('agent:decide'). When the request ends, ONE write adds its counts to
// usageLog/{day}.
// Pages count their own (shared-assets/fs-metered.js) and send them here (usage-log).
//
// usageLog/{day}   day = Firebase's quota day (US Pacific date: it starts 1:30 PM India time)
//   { day, at, tot: { r, w, n }, logW,               everything counted, and the log's own writes
//     srv: { '<name>': { r, w, n } },                server: per API action / job
//     cli: { '<page> › <what>': { r, w, n } },        pages: per page and collection
//     hours: { 'HH': { r, w } } }                     India hour (as the Firebase console's chart)
// team.html → Database usage reads it back (usage-read) and says in words what each line is
// (shared-assets/usage-catalog.js).
import { AsyncLocalStorage } from 'node:async_hooks';
import { Firestore, Query, Transaction, WriteBatch, DocumentReference, FieldValue } from 'firebase-admin/firestore';
import { getDb } from './_bot-shared.js';

const als = new AsyncLocalStorage();
const add = (r, w) => { const s = als.getStore(); if (s && !s.off) { s.r += r; s.w += w; } };

// ── Counting at the library's read and write points (each read is counted once) ──
// DocumentReference.get and db.getAll both go through Firestore.getAll; a query (and a query in a
// transaction) through Query._get; a document in a transaction through Transaction.get/getAll; every
// write (set, update, delete, create, add, batches, transactions) through WriteBatch._commit.
let patched = false;
function patch() {
  if (patched) return;
  patched = true;
  const wrap = (proto, name, after) => {
    const orig = proto && proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function (...a) {
      const out = orig.apply(this, a);
      return out && typeof out.then === 'function' ? out.then(v => { try { after.call(this, v, a); } catch (e) { /* */ } return v; }) : out;
    };
  };
  wrap(Firestore.prototype, 'getAll', v => add(Array.isArray(v) ? v.length : 1, 0));
  wrap(Query.prototype, '_get', v => add(Math.max(1, (v && v.result && v.result.size) || 0), 0));
  wrap(Transaction.prototype, 'get', (v, a) => { if (a[0] instanceof DocumentReference) add(1, 0); });
  wrap(Transaction.prototype, 'getAll', v => add(Array.isArray(v) ? v.length : 1, 0));
  const commit = WriteBatch.prototype._commit;
  if (typeof commit === 'function') WriteBatch.prototype._commit = function (...a) {
    const n = Array.isArray(this._ops) ? this._ops.length : 0;
    return commit.apply(this, a).then(v => { add(0, n); return v; });
  };
}
patch();

// Firebase's day: the US Pacific date (the free quota resets at midnight there, 1:30 PM India time).
export const usageDay = (t = Date.now()) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const istHour = (t = Date.now()) => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).slice(0, 2);
// A name safe as a map key, short.
const keyOf = s => String(s || 'unknown').replace(/\./g, '·').replace(/`/g, "'").replace(/\s+/g, ' ').trim().slice(0, 140) || 'unknown';


// Run an API entry counted: track('agent', () => handler(request)).
export function track(name, fn) {
  const store = { name, r: 0, w: 0, off: false };
  return als.run(store, async () => {
    try { return await fn(); }
    finally { await flush(store).catch(e => console.error('usage log:', e.message)); }
  });
}
// The request names itself more exactly once it knows its action ("agent" → "agent:decide").
export function relabel(name) { const s = als.getStore(); if (s && name) s.name = name; }
// Work that must not be counted as this request's (the log's own writes).
async function flush(s) {
  if (s.off || (!s.r && !s.w)) return;
  s.off = true;
  const inc = FieldValue.increment, now = Date.now(), k = keyOf(s.name), h = istHour(now);
  await getDb().collection('usageLog').doc(usageDay(now)).set({
    day: usageDay(now), at: now, logW: inc(1),
    tot: { r: inc(s.r), w: inc(s.w), n: inc(1) },
    srv: { [k]: { r: inc(s.r), w: inc(s.w), n: inc(1) } },
    hours: { [h]: { r: inc(s.r), w: inc(s.w) } },
  }, { merge: true });
}

// ── /api/agent usage-log: a page's own counts (shared-assets/fs-metered.js) ──
export async function usageFromPage(db, user, body) {
  const counts = body && body.counts && typeof body.counts === 'object' ? body.counts : {};
  const inc = FieldValue.increment, now = Date.now(), h = istHour(now);
  const cli = {};
  let R = 0, W = 0, N = 0;
  for (const [label, c] of Object.entries(counts).slice(0, 80)) {
    const r = Math.max(0, Math.min(1e6, Math.floor(Number(c && c.r) || 0)));
    const w = Math.max(0, Math.min(1e6, Math.floor(Number(c && c.w) || 0)));
    const n = Math.max(0, Math.min(1e6, Math.floor(Number(c && c.n) || 0)));
    if (!r && !w) continue;
    cli[keyOf(label)] = { r: inc(r), w: inc(w), n: inc(n) };
    R += r; W += w; N += n;
  }
  if (!R && !W) return { ok: true, empty: true };
  // This request's own reads (signing in) go into the same single write, under its own name.
  const s = als.getStore(), own = s ? { r: s.r, w: s.w, name: keyOf(s.name) } : null;
  if (s) s.off = true;
  await db.collection('usageLog').doc(usageDay(now)).set({
    day: usageDay(now), at: now, logW: inc(1),
    tot: { r: inc(R + (own ? own.r : 0)), w: inc(W + (own ? own.w : 0)), n: inc(N + (own ? 1 : 0)) }, cli,
    ...(own && (own.r || own.w) ? { srv: { [own.name]: { r: inc(own.r), w: inc(own.w), n: inc(1) } } } : {}),
    hours: { [h]: { r: inc(R), w: inc(W) } },
    pages: { [keyOf(String(body.page || 'page'))]: inc(1) },
  }, { merge: true });
  return { ok: true };
}

// ── /api/agent usage-read (admins): the last days, as stored ──
export async function usageRead(db, user, body) {
  const days = Math.max(1, Math.min(14, Number(body && body.days) || 7));
  const ids = Array.from({ length: days }, (_, i) => usageDay(Date.now() - i * 86400000));
  const snaps = await db.getAll(...[...new Set(ids)].map(id => db.collection('usageLog').doc(id)));
  return { ok: true, days: snaps.filter(s => s.exists).map(s => ({ id: s.id, ...s.data() })) };
}

// An entry's name from its address: the ?op= / ?action= it was called with, else the file
// ("agent", "match", "meta-leads", "followup-digest (GET)").
export function nameFor(file, request, method) {
  let op = null;
  try { const u = new URL(request.url); op = u.searchParams.get('op') || u.searchParams.get('action'); } catch (e) { /* */ }
  return op ? (file === 'bot-test-message' || file === 'sync-inventory' || file === 'lead-summary' ? op : file + ':' + op) : file + (method === 'GET' ? ' (GET)' : '');
}
