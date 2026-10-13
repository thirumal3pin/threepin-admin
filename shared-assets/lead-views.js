// ═══════════════════════════════════════════════════════════════════════
// LEAD VIEWS — every lead of a tenant, packed into a few documents.
//
// Firestore bills a read per DOCUMENT, not per byte. A list screen that listens to the `leads`
// collection pays one read per lead on every open (600 leads = 600 reads), and that grows with
// every lead added. Here each lead also lives as a ROW inside a view document holding ~20 of them
// (~45 KB), so opening the CRM costs about one read per 20 leads — 27 for 519, 500 for 10,000 —
// and then one read per change, as before. Small documents keep each live update small too: a
// change re-sends only the document it is in.
//
//   leadViews/{tenant}__meta       { tenantId, version, shards, count, builtAt, off?, next? }
//   leadViews/{tenant}__v{n}_{i}   { tenantId, version, shard: i, rows: { [leadId]: lead + _w } }
//
// A row IS the lead document (the same fields; notes and history stay in their subcollections),
// so every screen reads it exactly as it read the lead. The lead document stays the source of
// truth, and the two never disagree:
//   · every write to a lead writes its row IN THE SAME BATCH OR TRANSACTION (all or nothing), the
//     same way (same merge semantics), stamped with the server's time (_w); a writer that cannot
//     tell where the row goes does not write the lead either (or, in a browser, writes the lead and
//     puts the row right as soon as it can — never silently leaves it behind);
//   · a page saves only the fields it changed (diffPaths), so even a row that was behind can never
//     carry an old value back into a lead;
//   · opening a lead re-checks its row against the lead in a transaction;
//   · a daily rebuild from the leads heals anything else (a script that wrote leads directly). Each
//     document is rebuilt in its own transaction and keeps every row written after the leads were
//     read (by _w), so it never takes a change back, and never brings back a deleted lead.
// Which document holds a lead is a hash of its id over `shards`. When the leads outgrow them, a
// rebuild prepares a new set (meta.next) that every writer fills alongside the current one for a
// day; the next rebuild switches to it — no write is ever lost to a re-shard.
//
// Pure and dependency-free: the pages and the server both use it.
// ═══════════════════════════════════════════════════════════════════════

export const VIEWS = 'leadViews';
export const ROWS_TARGET = 20;        // a new set of documents holds ~20 leads each (~45 KB)
// …and is replaced once they average 40 (~90 KB). Kept low on purpose: a document's busiest set of
// rows must stay far inside Firestore's per-document limits (20,000 fields, 40,000 index entries —
// a lead carries ~150–200 fields), whatever the hash puts there.
export const ROWS_MAX = 40;
// Never in a row: subcollections (a page's in-memory lead carries them).
export const NOT_IN_ROW = ['notes', 'history'];
export const WROTE = '_w';            // when the row was last written — the SERVER's time — the rebuild's guard

// A row's write time in ms: a server timestamp (Timestamp, or {seconds}), a number (a rebuild), or
// still pending in this browser (null — newest of all).
export function wOf(row) {
  const w = row ? row[WROTE] : undefined;
  if (w === null) return Infinity;
  if (typeof w === 'number') return w;
  if (w && typeof w.toMillis === 'function') return w.toMillis();
  if (w && typeof w.seconds === 'number') return w.seconds * 1000 + Math.floor((w.nanoseconds || 0) / 1e6);
  return 0;
}

export const metaId = tenantId => `${tenantId}__meta`;
export const shardId = (tenantId, version, i) => `${tenantId}__v${version}_${i}`;

export const shardCountFor = n => Math.max(4, Math.ceil((Number(n) || 0) / ROWS_TARGET));
// Grown past ROWS_MAX a document on average, or shrunk to a tenth: time for a new set.
export const needsReshard = (shards, n) => !shards || (Number(n) || 0) > shards * ROWS_MAX || shards > 10 * shardCountFor(n);

// Which view document holds a lead: FNV-1a of its id, over the shard count.
export function shardOf(id, shards) {
  let h = 0x811c9dc5;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % Math.max(1, shards | 0);
}

// The sets of documents a write goes to: the current one, and the next while one is being prepared.
export function targetsOf(meta) {
  if (!meta || !meta.version || !meta.shards) return [];
  const out = [{ version: meta.version, shards: meta.shards }];
  if (meta.next && meta.next.version && meta.next.shards && meta.next.version !== meta.version) out.push({ version: meta.next.version, shards: meta.next.shards });
  return out;
}

// A lead's data as its row holds it (stamped by the writer separately).
export function rowOf(data) {
  const out = { ...(data || {}) };
  for (const k of NOT_IN_ROW) delete out[k];
  return out;
}

// An update-style patch ({ 'ai.error': x, stageId: y }) as [segments, value] pairs.
export const patchPaths = patch => Object.entries(patch || {})
  .filter(([k]) => !NOT_IN_ROW.includes(k.split('.')[0]))
  .map(([k, v]) => [k.split('.'), v]);
// `base` with [segments, value] pairs applied (a deep copy): what a lead is once a paths save lands.
export function applyPaths(base, pairs) {
  const out = JSON.parse(JSON.stringify(base || {}));
  for (const [seg, v] of pairs || []) {
    let o = out;
    for (let i = 0; i < seg.length - 1; i++) o = o[seg[i]] = (o[seg[i]] && typeof o[seg[i]] === 'object' && !Array.isArray(o[seg[i]])) ? o[seg[i]] : {};
    o[seg[seg.length - 1]] = JSON.parse(JSON.stringify(v));
  }
  return out;
}
// [segments, value] pairs (diffPaths) without what never goes in a row.
export const rowPairs = pairs => (pairs || []).filter(([seg]) => !NOT_IN_ROW.includes(seg[0]));
// …and as the nested object those paths describe.
export function nest(pairs) {
  const out = {};
  for (const [seg, v] of pairs) {
    let o = out;
    for (let i = 0; i < seg.length - 1; i++) o = o[seg[i]] = (o[seg[i]] && typeof o[seg[i]] === 'object') ? o[seg[i]] : {};
    o[seg[seg.length - 1]] = v;
  }
  return out;
}

// The smallest change that turns `base` into `next`, as [segments, value] pairs: maps are descended,
// so a save sends only the leaves it really changed — a page's older copy of a field it did not
// touch can never overwrite a newer value. A key only in `base` is left alone (as a merge would);
// arrays and other values are compared whole.
const plain = v => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const canon = v => (plain(v) ? Object.keys(v).sort().reduce((o, k) => (o[k] = canon(v[k]), o), {}) : Array.isArray(v) ? v.map(canon) : v);
export function diffPaths(base, next, prefix = []) {
  const out = [];
  for (const [k, v] of Object.entries(next || {})) {
    if (v === undefined) continue;
    const b = base ? base[k] : undefined;
    if (plain(v) && plain(b) && Object.keys(v).length) out.push(...diffPaths(b, v, [...prefix, k]));
    else if (JSON.stringify(canon(v)) !== JSON.stringify(canon(b))) out.push([[...prefix, k], v]);
  }
  return out;
}

// The view documents' rows as a list of leads — without the write stamp (a page must never save it
// back into a lead), and without a partial row (one with no tenantId: never a whole lead). A lead in
// two documents is the one written last.
export function rowsToLeads(shardDocs) {
  const by = new Map();
  for (const d of shardDocs || []) {
    const rows = (d && d.rows) || {};
    for (const [id, row] of Object.entries(rows)) {
      if (!row || typeof row !== 'object' || !row.tenantId) continue;
      const was = by.get(id);
      if (!was || wOf(row) >= wOf(was)) by.set(id, row);
    }
  }
  return [...by.entries()].map(([id, row]) => { const { [WROTE]: _, ...lead } = row; return { ...lead, id: lead.id || id }; });
}
