// Lead views on the server (shared-assets/lead-views.js says what they are and why).
//
//   writeLead(db, tenantId, ref, data, mode)          a lead write and its row, in ONE batch
//   rowWrites(db, tenantId, meta, leadId, data, mode)  the row writes to add to the transaction or
//                                                      batch that writes the lead (meta: viewMeta)
//   rebuildLeadViews(db, tenantId, leads, readAt)     the daily rebuild from the leads themselves
//   readLeads(db, tenantId)                           all leads, from the views (a few reads) — or
//                                                      the collection when not built or off
//
// mode, as the lead was written: 'merge' (set merge) · 'update' (update; keys are field paths) ·
// 'replace' (set) · 'delete'.
//
// Fail closed: viewMeta throws when it cannot tell where rows go (and has never known), so a writer
// fails — and is retried — rather than writing a lead whose row would silently fall behind.

import { FieldValue, FieldPath } from 'firebase-admin/firestore';
import * as LV from '../shared-assets/lead-views.js';

const metaCache = new Map();   // tenantId → { at, meta }
const META_TTL = 30 * 1000;    // a re-shard is announced a day ahead, so every writer catches it

export async function viewMeta(db, tenantId, fresh = false) {
  const c = metaCache.get(tenantId);
  // Only a known set is cached: "no views yet" is asked again every time, so the first build is
  // seen by every writer at once (it costs one read per write only until then).
  if (!fresh && c && Date.now() - c.at < META_TTL) return c.meta;
  let snap;
  try { snap = await db.collection(LV.VIEWS).doc(LV.metaId(tenantId)).get(); }
  catch (e) { if (c) return c.meta; throw e; }   // a blip: the last known layout is still right
  const d = snap.exists ? snap.data() : null;
  const meta = d && d.version && d.shards ? d : null;
  if (meta) metaCache.set(tenantId, { at: Date.now(), meta }); else metaCache.delete(tenantId);
  return meta;
}

const stamp = () => FieldValue.serverTimestamp();

export function rowWrites(db, tenantId, meta, leadId, data, mode = 'merge') {
  const out = [];
  if (!meta || !tenantId || !leadId) return out;
  for (const tg of LV.targetsOf(meta)) {
    const ref = db.collection(LV.VIEWS).doc(LV.shardId(tenantId, tg.version, LV.shardOf(leadId, tg.shards)));
    if (mode === 'delete') out.push([ref, { tenantId, rows: { [leadId]: FieldValue.delete() } }, { merge: true }]);
    else if (mode === 'merge') out.push([ref, { tenantId, rows: { [leadId]: { ...LV.rowOf(data), [LV.WROTE]: stamp() } } }, { merge: true }]);
    else if (mode === 'replace') out.push([ref, { tenantId, rows: { [leadId]: { ...LV.rowOf(data), [LV.WROTE]: stamp() } } }, { mergeFields: ['tenantId', new FieldPath('rows', leadId)] }]);
    else {
      const pairs = LV.patchPaths(data);
      if (!pairs.length) continue;
      const nested = LV.nest(pairs);
      nested[LV.WROTE] = stamp();
      out.push([ref, { tenantId, rows: { [leadId]: nested } },
        { mergeFields: ['tenantId', ...pairs.map(([seg]) => new FieldPath('rows', leadId, ...seg)), new FieldPath('rows', leadId, LV.WROTE)] }]);
    }
  }
  return out;
}
export const applyRowWrites = (tOrBatch, writes) => writes.forEach(([ref, data, opts]) => tOrBatch.set(ref, data, opts));

// A view document that cannot take a row (a Firestore per-document limit — too many fields or
// index entries after a burst of new leads, before the next rebuild spreads them): the lead must
// still be saved. Anything else is passed on.
export const isRowTrouble = e => !!e && (e.code === 3 || e.code === 'invalid-argument'
  || /index entries|maximum (size|number)|too many (fields|index)|exceeds the maximum/i.test(String(e.message || '')));
// run(useRows) writes the lead with its row (true) or alone (false).
export async function withRowFallback(run, label) {
  try { return await run(true); }
  catch (e) {
    if (!isRowTrouble(e)) throw e;
    console.error(`lead views: ${label} — its row was refused (${e.message}); the lead is saved alone and the next rebuild puts the row right`);
    return run(false);
  }
}

// A lead write and its row, together or not at all. mustSave: a write that must not be lost
// even if the views cannot be reached (a visit's calendar event id, after the event was created —
// failing it would book the visit twice): then the lead is saved alone, its row put right later.
export async function writeLead(db, tenantId, ref, data, mode = 'update', { mustSave = false } = {}) {
  let meta;
  try { meta = await viewMeta(db, tenantId); }
  catch (e) { if (!mustSave) throw e; console.error('lead views unreadable — saving lead ' + ref.id + ' alone:', e.message); meta = null; }
  return withRowFallback(useRows => {
    const b = db.batch();
    if (mode === 'update') b.update(ref, data);
    else if (mode === 'merge') b.set(ref, data, { merge: true });
    else if (mode === 'replace') b.set(ref, data);
    else b.delete(ref);
    if (useRows) applyRowWrites(b, rowWrites(db, tenantId, meta, ref.id, data, mode));
    return b.commit();
  }, 'lead ' + ref.id);
}

const MARGIN = 2 * 60 * 1000;
const canon = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, k) => (o[k] = canon(v[k]), o), {}) : Array.isArray(v) ? v.map(canon) : v);
// The same rows, whenever they were stamped: a document whose leads did not change is not rewritten.
const unstamped = rows => Object.fromEntries(Object.entries(rows || {}).map(([id, r]) => { const { [LV.WROTE]: _, ...x } = r || {}; return [id, x]; }));
const sameRows = (a, b) => JSON.stringify(canon(unstamped(a))) === JSON.stringify(canon(unstamped(b)));

// One set of view documents, built from the leads. Each document is rebuilt in its own
// transaction — a row written meanwhile makes it start again, so nothing is overwritten — keeping
// every whole row written after the leads were read (by its server-time stamp), never bringing
// back a lead deleted since the read, and writing only the documents that change.
async function buildSet(db, tenantId, set, leads, readAt) {
  const col = db.collection(LV.VIEWS), leadsCol = db.collection('leads');
  const refs = Array.from({ length: set.shards }, (_, i) => col.doc(LV.shardId(tenantId, set.version, i)));
  const fresh = row => !!row && !!row.tenantId && LV.wOf(row) >= readAt - MARGIN;
  const byDoc = Array.from({ length: set.shards }, () => []);
  for (const l of leads) if (l && l.id) byDoc[LV.shardOf(l.id, set.shards)].push(l);
  const want = (curRows, docLeads) => {
    const rows = {};
    for (const l of docLeads) { const row = curRows[l.id]; rows[l.id] = fresh(row) ? row : { ...LV.rowOf(l), [LV.WROTE]: readAt }; }
    // A row the read did not have: a lead created after the read (kept) or one deleted (dropped).
    for (const [id, row] of Object.entries(curRows)) if (!(id in rows) && fresh(row)) rows[id] = row;
    return rows;
  };
  // A first look at every document, so only the ones that need it are rebuilt.
  const snaps = await db.getAll(...refs);
  let written = 0;
  for (let j = 0; j < set.shards; j++) {
    const cur0 = (snaps[j].exists && snaps[j].data().rows) || {};
    if (snaps[j].exists && sameRows(cur0, want(cur0, byDoc[j]))) continue;
    const did = await db.runTransaction(async t => {
      const s = await t.get(refs[j]);
      const cur = (s.exists && s.data().rows) || {};
      const rows = want(cur, byDoc[j]);
      // Leads the read had that this document holds no row for: new since the last build — or
      // deleted since the read. Only the ones that still exist. (A document not there yet — a first
      // build, a new set — would re-read every lead for nothing: those are built from the read.)
      const missing = s.exists ? byDoc[j].filter(l => !cur[l.id]).map(l => l.id) : [];
      if (missing.length) {
        const ls = await t.getAll(...missing.map(id => leadsCol.doc(id)));
        ls.forEach((x, k) => { if (!x.exists) delete rows[missing[k]]; });
      }
      if (s.exists && sameRows(cur, rows)) return 0;
      t.set(refs[j], { tenantId, version: set.version, shard: j, rows, builtAt: Date.now() });
      return 1;
    });
    written += did;
  }
  return written;
}

// The daily rebuild (from the 9 AM digest's read of every lead). readAt: when the leads were read.
// Outgrown: a new set is prepared (meta.next) — every writer fills it alongside the current one —
// and the next rebuild switches to it; the old set's documents are removed at the rebuild after.
export async function rebuildLeadViews(db, tenantId, leads, readAt = Date.now()) {
  const col = db.collection(LV.VIEWS), metaRef = col.doc(LV.metaId(tenantId));
  const prev = await viewMeta(db, tenantId, true);
  const n = leads.length;
  let reading, prepared = null, retiring = null;
  if (!prev) reading = { version: 1, shards: LV.shardCountFor(n) };
  else if (prev.next && prev.next.version) { reading = { version: prev.next.version, shards: prev.next.shards }; retiring = { version: prev.version, shards: prev.shards }; }
  else {
    reading = { version: prev.version, shards: prev.shards };
    if (LV.needsReshard(prev.shards, n)) prepared = { version: prev.version + 1, shards: LV.shardCountFor(n) };
  }
  const written = await buildSet(db, tenantId, reading, leads, readAt);
  if (prepared) await buildSet(db, tenantId, prepared, leads, readAt);
  // The documents of a set retired at the rebuild before (a writer that had not yet caught up
  // may have re-created some): removed now.
  if (prev && prev.retired && prev.retired.version) {
    const b = db.batch();
    for (let j = 0; j < prev.retired.shards; j++) b.delete(col.doc(LV.shardId(tenantId, prev.retired.version, j)));
    await b.commit().catch(e => console.error('old lead view cleanup failed:', e.message));
  }
  // Merged: the switch (off) is the team's — never undone by a rebuild.
  await metaRef.set({
    tenantId, version: reading.version, shards: reading.shards, count: n, builtAt: Date.now(),
    next: prepared || FieldValue.delete(),
    retired: retiring || FieldValue.delete()
  }, { merge: true });
  metaCache.delete(tenantId);
  return { version: reading.version, shards: reading.shards, count: n, written, prepared: !!prepared, switched: !!retiring };
}

// Every lead of a tenant: from its views (a read per ~20 leads), else from the collection.
export async function readLeads(db, tenantId) {
  const meta = await viewMeta(db, tenantId, true).catch(() => null);
  if (meta && !meta.off) {
    const refs = Array.from({ length: meta.shards }, (_, i) => db.collection(LV.VIEWS).doc(LV.shardId(tenantId, meta.version, i)));
    const snaps = await db.getAll(...refs);
    if (snaps.every(s => s.exists)) return LV.rowsToLeads(snaps.map(s => s.data()));
  }
  const q = await db.collection('leads').where('tenantId', '==', tenantId).get();
  return q.docs.map(d => ({ ...d.data(), id: d.id }));
}
