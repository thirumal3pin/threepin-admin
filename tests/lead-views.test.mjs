// Lead views (shared-assets/lead-views.js, api/_lead-views.js, shared-assets/lead-views-client.js):
// a lead's row must ALWAYS equal the lead — through every kind of write the pages and the server
// make (merge, update with field paths, replace, delete), written in the same batch as the lead
// (all or nothing), through a rebuild with writes landing mid-way, a two-phase re-shard, the switch,
// rules that refuse the rows — and a page must read the views when built and the leads when not.
//   node tests/lead-views.test.mjs
import { register } from 'node:module';
import { FieldValue } from 'firebase-admin/firestore';
import * as LV from '../shared-assets/lead-views.js';
import { makeStore, adminDb, webApi, DELETE } from './fake-firestore.mjs';
import { writeLead, rowWrites, applyRowWrites, rebuildLeadViews, readLeads, viewMeta } from '../api/_lead-views.js';

register('./_gstatic-loader.mjs', import.meta.url);

let failed = 0, passed = 0;
const check = (label, cond, detail) => { if (cond) passed++; else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : '')); } };
const T = 't_test';
const strip = l => { const { notes, history, [LV.WROTE]: _w, ...r } = l || {}; return r; };
const sortKeys = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, k) => (o[k] = sortKeys(v[k]), o), {}) : Array.isArray(v) ? v.map(sortKeys) : v);
const eq = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));
const E = 1790000000000;   // real clock times: the rebuild allows a 2-minute margin around its read
console.log('3 PIN Realty — lead views\n');

// ── the pure core ──
check('Documents for 519 leads: 26 (~20 a document) — a page opens with 27 reads', LV.shardCountFor(519) === 26);
check('…never fewer than 4', LV.shardCountFor(3) === 4);
check('A lead always lands in the same document', LV.shardOf('lead_123', 27) === LV.shardOf('lead_123', 27));
{
  const counts = new Array(27).fill(0);
  for (let i = 0; i < 5200; i++) counts[LV.shardOf('lead_' + (1700000000000 + i * 7919), 27)]++;
  check('…and leads spread evenly (no document over twice its share)', Math.max(...counts) < 2 * 5200 / 27, JSON.stringify(counts));
}
check('A new set only when outgrown (avg > 40 — far inside the per-document limits) or shrunk to a tenth', !LV.needsReshard(26, 519) && !LV.needsReshard(26, 1040) && LV.needsReshard(26, 1041) && LV.needsReshard(400, 100) && !LV.needsReshard(4, 100));
check('Field paths nest', eq(LV.nest(LV.patchPaths({ 'ai.error': 'x', 'ai.lastMove.at': 5, stageId: 's1' })), { ai: { error: 'x', lastMove: { at: 5 } }, stageId: 's1' }));
check('Notes and history never go in a row', eq(LV.rowOf({ a: 1, notes: [1], history: [2] }), { a: 1 }) && LV.patchPaths({ notes: [], 'history.x': 1, a: 2 }).length === 1);
check('A lead in two documents: the one written last wins; the stamp never reaches a page',
  (() => { const l = LV.rowsToLeads([{ rows: { x: { tenantId: T, _w: 1, v: 'old' } } }, { rows: { x: { tenantId: T, _w: 2, v: 'new' } } }]); return l.length === 1 && l[0].v === 'new' && !('_w' in l[0]) && l[0].id === 'x'; })());
check('A partial row (no tenantId — never a whole lead) is not shown', LV.rowsToLeads([{ rows: { x: { v: 1, _w: 3 } } }]).length === 0);
check('A save sends only what it changed — leaves of maps, arrays whole, untouched keys never',
  eq(LV.diffPaths({ a: 1, m: { x: 1, y: 2 }, arr: [1, 2], keep: 'old' }, { a: 1, m: { x: 1, y: 3, z: {} }, arr: [1, 2, 3], keep: 'old', n: 5 }),
     [[['m', 'y'], 3], [['m', 'z'], {}], [['arr'], [1, 2, 3]], [['n'], 5]]));
check('…nothing changed: nothing to send', LV.diffPaths({ a: { b: [1] } }, { a: { b: [1] } }).length === 0);
check('…a map that replaces a plain value is sent whole', eq(LV.diffPaths({ m: 'x' }, { m: { k: 1 } }), [[['m'], { k: 1 }]]));
check('Write times: server timestamps, numbers, pending (newest)', LV.wOf({ _w: { seconds: 2, nanoseconds: 5e6 } }) === 2005 && LV.wOf({ _w: 7 }) === 7 && LV.wOf({ _w: null }) === Infinity && LV.wOf({}) === 0);
check('Targets: the current set, and the next while one is prepared',
  LV.targetsOf({ version: 2, shards: 4 }).length === 1 && LV.targetsOf({ version: 2, shards: 4, next: { version: 3, shards: 9 } }).length === 2 && LV.targetsOf(null).length === 0);

// ── random writes ──
let seed = 7;
const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const randValue = depth => {
  const k = rnd(6);
  if (k === 0) return rnd(1000);
  if (k === 1) return 'v' + rnd(50);
  if (k === 2) return null;
  if (k === 3) return [rnd(5), 'a' + rnd(3)];
  if (k === 4 && depth < 2) { const o = {}; for (let i = 0; i < 1 + rnd(3); i++) o['k' + rnd(4)] = randValue(depth + 1); return o; }
  return rnd(2) === 0;
};
const FIELDS = ['name', 'stageId', 'ai', 'tt', 'tags', 'followUpAt', 'siteVisitReplies', 'ttHold', 'reached'];
const randPatch = () => { const o = {}; for (let i = 0; i < 1 + rnd(3); i++) o[FIELDS[rnd(FIELDS.length)]] = randValue(0); return o; };
const randPaths = () => { const o = {}; for (let i = 0; i < 1 + rnd(3); i++) { const f = FIELDS[rnd(FIELDS.length)]; o[rnd(2) ? f : f + '.k' + rnd(4)] = randValue(1); } return o; };
// (a patch must not name a field and a path inside it — Firestore refuses that, so does the test)
const clean = p => Object.fromEntries(Object.entries(p).filter(([k]) => !Object.keys(p).some(o => o !== k && (k.startsWith(o + '.') || o.startsWith(k + '.')))));

async function rowIn(store, db, id) {
  const m = await viewMeta(db, T, true);
  const d = store.get('leadViews/' + LV.shardId(T, m.version, LV.shardOf(id, m.shards)));
  return d && d.rows ? d.rows[id] : undefined;
}

async function serverRun() {
  const store = makeStore(), db = adminDb(store);
  const ids = Array.from({ length: 30 }, (_, i) => 'lead_' + i);
  for (const id of ids) store.set('leads/' + id, { id, tenantId: T, name: 'n' + id, updatedAt: 1 });
  await rebuildLeadViews(db, T, ids.map(id => store.get('leads/' + id)));
  let bad = 0, ops = 0, refusedTogether = 0;
  for (let step = 0; step < 600; step++) {
    const id = ids[rnd(ids.length)], kind = rnd(10), path = 'leads/' + id, ref = db.collection('leads').doc(id);
    const rowBefore = JSON.stringify(await rowIn(store, db, id));
    try {
      if (kind < 4) await writeLead(db, T, ref, { ...randPatch(), tenantId: T }, 'merge');
      else if (kind < 7) await writeLead(db, T, ref, clean(randPaths()), 'update');
      else if (kind < 8) await writeLead(db, T, ref, { id, tenantId: T, ...randPatch() }, 'replace');
      else if (kind < 9) await writeLead(db, T, ref, { 'ai.error': FieldValue.delete(), stageId: 'x' + rnd(3) }, 'update');
      else await writeLead(db, T, ref, null, 'delete');
    } catch (e) {
      // An update of a lead that is gone fails — and its row must not have moved either.
      if (e.code !== 'not-found') throw e;
      if (JSON.stringify(await rowIn(store, db, id)) !== rowBefore) bad++; else refusedTogether++;
      continue;
    }
    ops++;
    const lead = store.get(path), row = await rowIn(store, db, id);
    if (!(lead === undefined ? row === undefined : eq(strip(lead), strip(row)))) { bad++; if (bad < 3) console.log('   mismatch', id, JSON.stringify(lead), JSON.stringify(row)); }
  }
  check(`Server: ${ops} random writes (merge · update · replace · delete) — every row equals its lead`, bad === 0, bad + ' mismatches');
  // An update of a lead that is gone: refused — the lead AND its row (all or nothing).
  await writeLead(db, T, db.collection('leads').doc('lead_3'), null, 'delete');
  let threw = false;
  try { await writeLead(db, T, db.collection('leads').doc('lead_3'), { stageId: 'won' }, 'update'); } catch (e) { threw = e.code === 'not-found'; }
  check('An update of a deleted lead is refused — and writes no row either (all or nothing)', threw && store.get('leads/lead_3') === undefined && (await rowIn(store, db, 'lead_3')) === undefined && bad === 0);
  const all = await readLeads(db, T);
  const live = [...store.docs.keys()].filter(k => k.startsWith('leads/') && store.get(k).tenantId === T);
  check('…the views read back every lead, exactly', all.length === live.length && all.every(l => eq(strip(l), strip(store.get('leads/' + l.id)))));
  // A transaction (the TailorTalk sync, the AI) adds the rows to its own writes.
  await db.runTransaction(async t => {
    const ref = db.collection('leads').doc('lead_tx');
    const data = { id: 'lead_tx', tenantId: T, name: 'from a transaction' };
    t.set(ref, data);
    applyRowWrites(t, rowWrites(db, T, await viewMeta(db, T), 'lead_tx', data, 'replace'));
  });
  check('A transaction writes the lead and its row together', eq(strip(await rowIn(store, db, 'lead_tx')), store.get('leads/lead_tx')));
}

async function rebuilds() {
  const store = makeStore(), db = adminDb(store);
  const leads = Array.from({ length: 50 }, (_, i) => ({ id: 'L' + i, tenantId: T, updatedAt: E, v: 'a' }));
  for (const l of leads) store.set('leads/' + l.id, l);
  await rebuildLeadViews(db, T, leads, E);
  const readAt = E + 10 * 60000;
  const read = leads.map(l => store.get('leads/' + l.id));
  // Mid-rebuild: a change lands after the leads were read; a lead is created; one was deleted.
  const realNow = Date.now; Date.now = () => readAt + 5000;
  await writeLead(db, T, db.collection('leads').doc('L3'), { v: 'b' }, 'update');
  await writeLead(db, T, db.collection('leads').doc('NEW'), { id: 'NEW', tenantId: T }, 'replace');
  Date.now = realNow;
  // A script wrote a lead directly, before the read (no row write): the rebuild must heal it.
  store.update('leads/L9', { v: 'script' });
  store.delete('leads/L7');
  read[9] = store.get('leads/L9');
  await rebuildLeadViews(db, T, read.filter(l => l.id !== 'L7'), readAt);
  const by = new Map((await readLeads(db, T)).map(l => [l.id, l]));
  check('Rebuild: a change that landed after the read is kept (never taken back)', by.get('L3') && by.get('L3').v === 'b');
  check('…a lead created after the read is kept', by.has('NEW'));
  check('…a lead deleted since is removed', !by.has('L7'));
  check('…a direct script write is healed', by.get('L9') && by.get('L9').v === 'script');
  // Only the documents that change are written.
  const again = await rebuildLeadViews(db, T, [...store.docs.keys()].filter(k => k.startsWith('leads/')).map(k => ({ ...store.get(k), id: k.slice(6) })), Date.now());
  check('A rebuild with nothing to change writes no view document', again.written === 0, again.written);
  // The switch is the team's: a rebuild never turns the views back on, and the server obeys it too.
  store.set('leadViews/' + LV.metaId(T), { off: true }, { merge: true });
  await rebuildLeadViews(db, T, [...store.docs.keys()].filter(k => k.startsWith('leads/')).map(k => ({ ...store.get(k), id: k.slice(6) })), Date.now());
  check('Switched off: a rebuild keeps it off', store.get('leadViews/' + LV.metaId(T)).off === true);
  store.set('leads/RAW', { id: 'RAW', tenantId: T });   // not in the views: readLeads must go to the leads
  check('…and the server reads the leads themselves while off', (await readLeads(db, T)).some(l => l.id === 'RAW'));
}

async function reshard() {
  const store = makeStore(), db = adminDb(store);
  const few = Array.from({ length: 50 }, (_, i) => ({ id: 'M' + i, tenantId: T, n: i }));
  for (const l of few) store.set('leads/' + l.id, l);
  await rebuildLeadViews(db, T, few, Date.now());
  const v1 = await viewMeta(db, T, true);
  const many = Array.from({ length: 400 }, (_, i) => ({ id: 'M' + i, tenantId: T, n: i }));
  for (const l of many) store.set('leads/' + l.id, l);
  const r1 = await rebuildLeadViews(db, T, many, Date.now());
  const m1 = await viewMeta(db, T, true);
  check('Outgrown: the next set is prepared, the current one still read', r1.prepared && m1.version === v1.version && m1.next && m1.next.version === v1.version + 1 && m1.next.shards === 20, JSON.stringify(m1));
  // A write while both sets exist goes to both.
  await writeLead(db, T, db.collection('leads').doc('M5'), { n: 'changed' }, 'update');
  const inNext = store.get('leadViews/' + LV.shardId(T, m1.next.version, LV.shardOf('M5', m1.next.shards))).rows.M5;
  const inCur = store.get('leadViews/' + LV.shardId(T, m1.version, LV.shardOf('M5', m1.shards))).rows.M5;
  check('…a write meanwhile reaches both sets', inNext.n === 'changed' && inCur.n === 'changed');
  const r2 = await rebuildLeadViews(db, T, many.map(l => store.get('leads/' + l.id)), Date.now() - 1000);
  const m2 = await viewMeta(db, T, true);
  check('Next rebuild: switched to the new set, the old one marked retired', r2.switched && m2.version === v1.version + 1 && m2.shards === 20 && !m2.next && m2.retired && m2.retired.version === v1.version);
  const after = await readLeads(db, T);
  check('…every lead readable, the write made in between included', after.length === 400 && after.find(l => l.id === 'M5').n === 'changed');
  await rebuildLeadViews(db, T, many.map(l => store.get('leads/' + l.id)), Date.now());
  const oldLeft = [...store.docs.keys()].filter(k => k.startsWith('leadViews/' + T + '__v' + v1.version + '_'));
  check('…and the old set removed the rebuild after', oldLeft.length === 0 && !(await viewMeta(db, T, true)).retired, oldLeft.length);
}

async function serverSafety() {
  // A write that lands between the rebuild's first look and its rewrite of that document is kept;
  // a lead deleted after the leads were read is not brought back; a partial row is replaced.
  const store = makeStore(), db0 = adminDb(store);
  const leads = Array.from({ length: 12 }, (_, i) => ({ id: 'S' + i, tenantId: T, v: 'a' }));
  for (const l of leads) store.set('leads/' + l.id, l);
  await rebuildLeadViews(db0, T, leads, Date.now());
  const meta = await viewMeta(db0, T, true);
  // The rebuild's read of the leads, older than what follows; S2 changed directly by a script
  // (no row write), so its document has to be rebuilt.
  const readAt = Date.now() - 10 * 60000;
  store.update('leads/S2', { v: 'script' });
  const read = leads.map(l => ({ ...store.get('leads/' + l.id), id: l.id }));
  store.set('leads/NEWX', { id: 'NEWX', tenantId: T, v: 'n' });   // no row yet; the read has it
  read.push({ ...store.get('leads/NEWX'), id: 'NEWX' });
  // A partial row (no tenantId), written "now".
  const pid = 'S5', pref = 'leadViews/' + LV.shardId(T, meta.version, LV.shardOf(pid, meta.shards));
  { const d = store.get(pref); d.rows[pid] = { v: 'partial', _w: Date.now() }; store.set(pref, d); }
  let hooked = false;
  const db = { ...db0, getAll: async (...refs) => {
    const out = await db0.getAll(...refs);
    if (!hooked && refs[0] && refs[0].path.startsWith('leadViews/')) {
      hooked = true;
      // …between the first look and the rewrite: a change to S2 lands; NEWX is deleted.
      await writeLead(db0, T, db0.collection('leads').doc('S2'), { v: 'landed' }, 'update');
      store.delete('leads/NEWX');
    }
    return out;
  } };
  await rebuildLeadViews(db, T, read, readAt);
  const by = new Map((await readLeads(db0, T)).map(l => [l.id, l]));
  check('Rebuild: a write landing mid-rebuild survives (each document rebuilt in a transaction)', by.get('S2') && by.get('S2').v === 'landed', JSON.stringify(by.get('S2')));
  check('…a lead deleted after the read is not brought back', !by.has('NEWX'));
  check('…a partial row is replaced by the whole lead', by.get('S5') && by.get('S5').tenantId === T && by.get('S5').v === 'a', JSON.stringify(by.get('S5')));

  // Fail closed: the layout cannot be read and was never known — no lead is written without its row.
  const store2 = makeStore(), dbOk = adminDb(store2);
  store2.set('leads/F1', { id: 'F1', tenantId: 't_other', v: 1 });
  // Reading a view document fails (writes would still go through).
  const broken = { ...dbOk, collection: c => (c === LV.VIEWS ? { doc: id => ({ ...dbOk.collection(c).doc(id), get: async () => { throw Object.assign(new Error('unavailable'), { code: 'unavailable' }); } }) } : dbOk.collection(c)) };
  let threw = false;
  try { await writeLead(broken, 't_never_seen', dbOk.collection('leads').doc('F1'), { v: 2 }, 'update'); } catch (e) { threw = true; }
  check('Server: layout unreadable and never known — the write fails (to be retried), nothing half-written', threw && store2.get('leads/F1').v === 1);
  await rebuildLeadViews(dbOk, 't_other', [{ ...store2.get('leads/F1'), id: 'F1' }], Date.now());
  await viewMeta(dbOk, 't_other', true);   // known now
  await writeLead(broken, 't_other', dbOk.collection('leads').doc('F1'), { v: 3 }, 'update');
  const r = (await readLeads(dbOk, 't_other')).find(l => l.id === 'F1');
  check('…a blip once the layout is known: the last known layout is used, lead and row together', store2.get('leads/F1').v === 3 && r && r.v === 3);
  // A view document past a Firestore limit refuses the row: the lead is saved all the same.
  store2.deny = p => (p.startsWith('leadViews/') && !p.endsWith('__meta') ? 'invalid-argument' : false);
  await writeLead(dbOk, 't_other', dbOk.collection('leads').doc('F1'), { v: 4 }, 'update');
  store2.deny = null;
  check('Server: a view document refusing the row (a limit) never blocks the lead itself', store2.get('leads/F1').v === 4);
  // A write that must not be lost (a visit's calendar event) goes through even with the layout unreadable.
  let saved = true;
  try { await writeLead(broken, 't_never_seen2', dbOk.collection('leads').doc('F1'), { v: 5 }, 'update', { mustSave: true }); } catch (e) { saved = false; }
  check('…and a must-save write goes through even when the layout cannot be read', saved && store2.get('leads/F1').v === 5);
}

async function browserSide() {
  const store = makeStore(), db = adminDb(store);
  globalThis.__fakeStore = store;
  const { leadViews } = await import('../shared-assets/lead-views-client.js');
  const web = webApi(store);
  const leadCount = () => [...store.docs.keys()].filter(k => k.startsWith('leads/') && store.get(k).tenantId === T).length;
  for (let i = 0; i < 20; i++) store.set('leads/P' + i, { id: 'P' + i, tenantId: T, name: 'p' + i, updatedAt: 1 });
  const views = leadViews({});
  let got = null, live = null, calls = 0;
  // The local copy first (fromServer false), then the server's.
  store.fromCache = true;
  const stop = views.watch(T, (list, fromServer) => { got = list; live = fromServer; calls++; }, e => { throw e; });
  await tick();
  check('Page: no views yet — reads the leads themselves', got && got.length === 20 && views.meta() === null);
  check('…from the local copy first: marked not from the server', live === false);
  store.fromCache = false; store.notify(); await tick();
  check('…then confirmed by the server, with nothing else changed: marked from the server', live === true);
  calls = 0;
  await rebuildLeadViews(db, T, [...store.docs.entries()].filter(([k]) => k.startsWith('leads/')).map(([, v]) => v));
  await tick();
  check('…views built — the page switches to them by itself (no reload)', views.meta() && got.length === 20 && eq(got.find(l => l.id === 'P3'), store.get('leads/P3')));
  check('…in one update, not one per view document', calls === 1, calls);
  // the page's own writes — lead and row together
  let bad = 0, refused = 0;
  for (let step = 0; step < 300; step++) {
    const id = 'P' + rnd(20), path = 'leads/' + id, kind = rnd(5), ref = web.doc(null, 'leads', id);
    try {
      if (kind === 0) await views.save(T, ref, { ...randPatch(), tenantId: T }, 'merge');
      else if (kind === 1) await views.save(T, ref, clean(randPaths()), 'update');
      else if (kind === 2) await views.save(T, ref, { id, tenantId: T, ...randPatch() }, 'replace');
      else if (kind === 3) { const base = store.get(path) || {}; await views.save(T, ref, LV.diffPaths(base, { ...base, ...randPatch() }), 'paths'); }
      else await views.save(T, ref, null, 'delete');
    } catch (e) { if (e.code !== 'permission-denied') throw e; refused++; }
    await tick(35);
    const lead = store.get(path), row = got.find(l => l.id === id);
    if (!(lead === undefined ? !row : row && eq(strip(lead), strip({ ...row, id: lead.id === undefined ? undefined : row.id })))) { bad++; if (bad < 3) console.log('   page mismatch', id, JSON.stringify(lead), JSON.stringify(row)); }
  }
  check(`Page: 300 random saves (merge · update · paths · replace · delete; ${refused} refused, lead gone) — the list always equals the leads`, bad === 0 && refused > 0, bad + ' mismatches, ' + refused + ' refused');
  // A refused save (a lead someone else deleted) does not switch the rows off for the visit.
  store.set('leads/G1', { id: 'G1', tenantId: T, name: 'ghost' });
  await views.save(T, web.doc(null, 'leads', 'G1'), store.get('leads/G1'), 'replace');
  store.delete('leads/G1');   // deleted elsewhere, row left behind
  let denied = false;
  try { await views.save(T, web.doc(null, 'leads', 'G1'), [[['name'], 'edit of a ghost']], 'paths'); } catch (e) { denied = e.code === 'permission-denied'; }
  await tick(150);
  check('Editing a lead someone deleted: refused, the lead NOT re-created, its row cleared', denied && store.get('leads/G1') === undefined && !got.find(l => l.id === 'G1'));
  if (!store.get('leads/P7')) store.set('leads/P7', { id: 'P7', tenantId: T, name: 'p7' });
  await views.save(T, web.doc(null, 'leads', 'P7'), [[['name'], 'after the refusal']], 'paths');
  await tick();
  check('…and the very next save still writes its row (nothing switched off)', got.find(l => l.id === 'P7') && got.find(l => l.id === 'P7').name === 'after the refusal');
  // A page's copy behind the lead (a write that bypassed the views): saving one field cannot carry
  // the old value of another back.
  if (!store.get('leads/P8')) store.set('leads/P8', { id: 'P8', tenantId: T, name: 'p8' });
  await tick();
  const before = got.find(l => l.id === 'P8') || store.get('leads/P8');
  store.update('leads/P8', { stageId: 'won-elsewhere' });   // newer than the page's copy
  await views.save(T, web.doc(null, 'leads', 'P8'), LV.diffPaths(before, { ...before, name: 'renamed here' }), 'paths');
  check('A save from an older copy keeps the newer value it did not touch', store.get('leads/P8').stageId === 'won-elsewhere' && store.get('leads/P8').name === 'renamed here');
  // heal: a lead written past the views; a lead deleted past them; one already right
  store.set('leads/P1', { id: 'P1', tenantId: T, name: 'fixed by a script' });
  const h1 = await views.heal(T, 'P1', got.find(l => l.id === 'P1')); await tick();
  check('Opening a lead a script changed: its row put right', h1 === 'healed' && got.find(l => l.id === 'P1').name === 'fixed by a script', h1);
  const h2 = await views.heal(T, 'P1', got.find(l => l.id === 'P1'));
  check('…opening it again: nothing written', h2 === 'same', h2);
  store.set('leads/P2', { id: 'P2', tenantId: T, name: 'x' }); await views.heal(T, 'P2', null);
  store.delete('leads/P2');
  const h3 = await views.heal(T, 'P2', got.find(l => l.id === 'P2')); await tick();
  check('…a lead deleted past the views: its row removed', h3 === 'removed' && !got.find(l => l.id === 'P2'), h3);
  // rules not live yet: rows refused — the lead is still saved, alone
  store.deny = p => p.startsWith('leadViews/');
  await views.save(T, web.doc(null, 'leads', 'P4'), { id: 'P4', tenantId: T, name: 'saved anyway' }, 'replace');
  check('Rows refused (rules not live): the lead is saved all the same', store.get('leads/P4').name === 'saved anyway');
  store.deny = null;
  // the switch-off: meta.off → straight back to the leads; writes keep the rows up to date meanwhile
  store.set('leadViews/' + LV.metaId(T), { off: true }, { merge: true });
  await tick();
  check('Switched off (meta.off): the page reads the leads themselves again', got.length === leadCount() && got.some(l => l.id === 'P4' && l.name === 'saved anyway'));
  stop();
  const v2 = leadViews({});   // a fresh page: no rows refused
  const stop2 = v2.watch(T, () => {}, () => {});
  await tick();
  await v2.save(T, web.doc(null, 'leads', 'P6'), { id: 'P6', tenantId: T, name: 'while off' }, 'replace');
  check('…while off, a save still writes its row (so switching on is safe at any moment)', strip(await rowIn(store, db, 'P6')).name === 'while off');
  stop2();
  store.set('leadViews/' + LV.metaId(T), { off: false }, { merge: true });
  // Saved before the layout was confirmed (only the local copy so far): the lead goes, and its
  // row is put right the moment the server confirms where it goes.
  if (!store.get('leads/P9')) store.set('leads/P9', { id: 'P9', tenantId: T, name: 'p9' });
  store.fromCache = true;
  const v4 = leadViews({});
  const stop4 = v4.watch(T, () => {}, () => {});
  await v4.save(T, web.doc(null, 'leads', 'P9'), [[['name'], 'before the layout']], 'paths');   // waits up to 3 s, then the lead alone
  check('Layout not yet confirmed: the lead is saved without waiting forever', store.get('leads/P9').name === 'before the layout');
  store.fromCache = false; store.notify(); await tick(200);
  check('…and its row is put right once the server confirms the layout', strip(await rowIn(store, db, 'P9')).name === 'before the layout');
  stop4();
  // The layout cannot be read at all (an error, not slowness): saves do not stall 3 s waiting.
  store.failListen = p => p.endsWith('__meta');
  const v5 = leadViews({});
  const stop5 = v5.watch(T, () => {}, () => {});
  await tick(30);
  const t0 = Date.now();
  await v5.save(T, web.doc(null, 'leads', 'P9'), [[['name'], 'no stall']], 'paths');
  check('Layout unreadable: a save goes at once (no 3 s wait)', Date.now() - t0 < 1000 && store.get('leads/P9').name === 'no stall', Date.now() - t0);
  stop5();
  store.failListen = null;
  // A view listener that fails: the page falls back to the leads.
  store.failListen = p => p.startsWith('leadViews/') && !p.endsWith('__meta');
  let got3 = null;
  const v3 = leadViews({});
  const stop3 = v3.watch(T, list => { got3 = list; }, () => {});
  await tick(120);
  check('A view listener that fails: the page reads the leads themselves instead', got3 && got3.length === leadCount());
  stop3();
  store.failListen = null;
  const once = await leadViews({}).readAll(T);
  check('Read once (the dashboard): every lead, each with its id', once.length === leadCount() && once.every(l => l.id));
  store.set('leadViews/' + LV.metaId(T), { off: true }, { merge: true });
  const onceOff = await leadViews({}).readAll(T);
  check('…and from the leads themselves while off, each with its id', onceOff.length === once.length && onceOff.every(l => l.id));
}

await serverRun();
await rebuilds();
await reshard();
await serverSafety();
await browserSide();
console.log(failed ? `\n${failed} failed, ${passed} passed.` : `\nAll good (${passed} checks).`);
process.exit(failed ? 1 : 0);
