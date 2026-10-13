// An in-memory Firestore for tests: the write semantics the lead views depend on —
//   set (replace) · set { merge: true } (deep merge of maps) · set { mergeFields } (exactly those
//   paths; a path missing from the data is an error, as in Firestore) · update (dotted keys replace
//   at their path) · delete sentinels · batches and transactions (all or nothing) · snapshots.
// Two faces over one store: an Admin-SDK-like `db` (server code) and the web SDK's functions
// (served to pages in place of firebase-firestore.js).
// A test can also make the store refuse writes (store.deny = path => true — as rules would), fail
// listeners (store.failListen = path => true), and serve from a "local copy" (store.fromCache).
// As the project's rules do for a browser: updating a lead that does not exist is
// "permission-denied" (the rule reads the existing document), and reading or deleting one is
// allowed. The server (Admin SDK) gets "not-found". Server timestamps become Date.now().

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isMap = v => v && typeof v === 'object' && !Array.isArray(v) && !isDelete(v) && !isTs(v) && !(v instanceof FieldPath);
export const DELETE = { __fakeDelete: true };
const isDelete = v => !!v && (v.__fakeDelete === true || (v.constructor && v.constructor.name === 'DeleteTransform'));
export const SERVER_TS = { __fakeTs: true };
const isTs = v => !!v && (v.__fakeTs === true || (v.constructor && /ServerTimestamp/.test(v.constructor.name)));
export class FieldPath { constructor(...segments) { this.segments = segments; } }
const segsOf = f => (Array.isArray(f) ? f : f && f.segments ? f.segments : String(f).split('.'));
const HAS = Symbol('missing');

function getAt(o, seg) { let x = o; for (const s of seg) { if (!isMap(x) || !(s in x)) return HAS; x = x[s]; } return x; }
function setAt(o, seg, v) {
  let x = o;
  for (let i = 0; i < seg.length - 1; i++) { if (!isMap(x[seg[i]])) x[seg[i]] = {}; x = x[seg[i]]; }
  if (isDelete(v)) delete x[seg[seg.length - 1]]; else x[seg[seg.length - 1]] = strip(v);
}
const val = v => (isTs(v) ? Date.now() : clone(v));
// a value written whole: delete sentinels inside it are not allowed by Firestore; drop them here
function strip(v) { if (!isMap(v)) return val(v); const o = {}; for (const [k, x] of Object.entries(v)) if (!isDelete(x)) o[k] = strip(x); return o; }
function deepMerge(base, data) {
  const out = isMap(base) ? base : {};
  for (const [k, v] of Object.entries(data || {})) {
    if (isDelete(v)) delete out[k];
    else if (isMap(v)) out[k] = deepMerge(isMap(out[k]) ? out[k] : {}, v);
    else out[k] = val(v);
  }
  return out;
}
// store.deny(path) → true: refused as the rules would; a string: fail with that error code (e.g.
// 'invalid-argument', as Firestore does for a document past its limits).
const denied = c => (typeof c === 'string' ? Object.assign(new Error('refused: ' + c), { code: c }) : Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));

export function makeStore() {
  const docs = new Map();           // path → data
  const subs = new Set();
  let held = 0;
  const notify = () => { if (!held) for (const s of [...subs]) s.fire(); };
  const store = {
    docs, subs, deny: null, failListen: null, fromCache: false, notify,
    get: p => (docs.has(p) ? clone(docs.get(p)) : undefined),
    set(p, data, opts = {}) {
      { const dn = store.deny && store.deny(p); if (dn) throw denied(dn); }
      if (opts.mergeFields) {
        const cur = docs.has(p) ? clone(docs.get(p)) : {};
        for (const f of opts.mergeFields) {
          const v = getAt(data, segsOf(f));
          if (v === HAS) throw new Error('Field "' + segsOf(f).join('.') + '" is specified in your field mask but missing from your input data.');
          setAt(cur, segsOf(f), v);
        }
        docs.set(p, cur);
      } else if (opts.merge) docs.set(p, deepMerge(docs.has(p) ? clone(docs.get(p)) : {}, data));
      else docs.set(p, strip(data));
      notify();
    },
    // patch: { 'a.b': v } or [[segments, v], …]; browser: as the rules answer a browser
    update(p, patch, browser = false) {
      { const dn = store.deny && store.deny(p); if (dn) throw denied(dn); }
      if (!docs.has(p)) { if (browser) throw denied(); throw Object.assign(new Error('not found'), { code: 'not-found' }); }
      const cur = clone(docs.get(p));
      const pairs = Array.isArray(patch) ? patch : Object.entries(patch).map(([k, v]) => [k.split('.'), v]);
      for (const [seg, v] of pairs) setAt(cur, seg, v);
      docs.set(p, cur); notify();
    },
    delete(p) { { const dn = store.deny && store.deny(p); if (dn) throw denied(dn); } docs.delete(p); notify(); },
    // Several writes together: all of them, or (on any error) none — then one notification.
    atomic(ops) {
      const before = new Map([...docs].map(([k, v]) => [k, clone(v)]));
      held++;
      try { for (const op of ops) op(); }
      catch (e) { docs.clear(); for (const [k, v] of before) docs.set(k, v); held--; throw e; }
      held--; notify();
    }
  };
  return store;
}

// ── Admin-SDK-like ──
export function adminDb(store) {
  const P = (coll, id) => coll + '/' + id;
  const ref = (coll, id) => ({
    id, path: P(coll, id), _coll: coll,
    collection: c => ({ doc: i => ref(P(coll, id) + '/' + c, i) }),
    get: async () => { const d = store.get(P(coll, id)); return { id, exists: d !== undefined, data: () => d, ref: ref(coll, id) }; },
    set: async (data, opts) => store.set(P(coll, id), data, opts || {}),
    update: async patch => store.update(P(coll, id), patch),
    delete: async () => store.delete(P(coll, id))
  });
  const writer = ops => ({
    set: (r, d, o) => { ops.push(() => store.set(r.path, d, o || {})); },
    update: (r, p) => { ops.push(() => store.update(r.path, p)); },
    delete: r => { ops.push(() => store.delete(r.path)); }
  });
  const db = {
    collection: c => ({
      doc: id => ref(c, id),
      where: (f, op, v) => ({
        get: async () => {
          const out = [];
          for (const [p, d] of store.docs) { const parts = p.split('/'); if (parts.length === 2 && parts[0] === c && d[f] === v) out.push({ id: parts[1], data: () => clone(d), ref: ref(c, parts[1]) }); }
          return { docs: out, empty: !out.length };
        }
      })
    }),
    getAll: async (...refs) => Promise.all(refs.map(r => r.get())),
    batch: () => { const ops = []; return { ...writer(ops), commit: async () => store.atomic(ops) }; },
    runTransaction: async fn => { const ops = []; const t = { ...writer(ops), get: r => r.get(), getAll: (...rs) => Promise.all(rs.map(r => r.get())) }; const out = await fn(t); store.atomic(ops); return out; }
  };
  return db;
}

// ── web SDK functions (firebase-firestore.js) over a store ──
export function webApi(store) {
  const doc = (db, ...parts) => ({ type: 'doc', path: parts.join('/'), id: parts[parts.length - 1] });
  const collection = (db, ...parts) => ({ type: 'coll', path: parts.join('/') });
  const where = (f, op, v) => ({ f, op, v });
  const query = (c, ...w) => ({ type: 'query', path: c.path, where: w });
  const meta = () => ({ fromCache: !!store.fromCache, hasPendingWrites: false });
  const snapDoc = (path) => { const d = store.get(path); return { id: path.split('/').pop(), exists: () => d !== undefined, data: () => d, metadata: meta() }; };
  const runQuery = q => {
    const out = [];
    for (const [p, d] of store.docs) { const parts = p.split('/'); if (parts.slice(0, -1).join('/') === q.path && (q.where || []).every(w => d[w.f] === w.v)) out.push({ id: parts.pop(), data: () => clone(d) }); }
    return { docs: out, metadata: meta() };
  };
  // update(ref, { 'a.b': v }) or update(ref, fieldPath, v, fieldPath, v, …)
  const upd = (r, a, rest) => store.update(r.path, rest.length || a instanceof FieldPath
    ? [a, ...rest].reduce((o, x, i, all) => (i % 2 ? o : (o.push([segsOf(x), all[i + 1]]), o)), [])
    : a, true);
  const writer = ops => ({
    set: (r, d, o) => { ops.push(() => store.set(r.path, d, o || {})); },
    update: (r, a, ...rest) => { ops.push(() => upd(r, a, rest)); },
    delete: r => { ops.push(() => store.delete(r.path)); }
  });
  return {
    doc, collection, where, query, FieldPath, deleteField: () => DELETE, serverTimestamp: () => SERVER_TS,
    getDoc: async r => snapDoc(r.path),
    getDocs: async q => runQuery(q.type === 'coll' ? { path: q.path, where: [] } : q),
    setDoc: async (r, data, opts) => store.set(r.path, data, opts || {}),
    updateDoc: async (r, a, ...rest) => upd(r, a, rest),
    deleteDoc: async r => store.delete(r.path),
    writeBatch: () => { const ops = []; return { ...writer(ops), commit: async () => store.atomic(ops) }; },
    runTransaction: async (db, fn) => { const ops = []; const t = { ...writer(ops), get: async r => snapDoc(r.path) }; const out = await fn(t); store.atomic(ops); return out; },
    // onSnapshot(target, cb, err) or onSnapshot(target, { includeMetadataChanges }, cb, err)
    onSnapshot: (target, a, b, c) => {
      const [opts, cb, err] = typeof a === 'function' ? [{}, a, b] : [a || {}, b, c];
      if (store.failListen && store.failListen(target.path)) {
        setTimeout(() => err && err(Object.assign(new Error('listen failed'), { code: 'unavailable' })), 0);
        return () => {};
      }
      let last = null, lastCache = null;
      const s = { fire() {
        const v = target.type === 'doc' ? snapDoc(target.path) : runQuery(target);
        const key = JSON.stringify(target.type === 'doc' ? v.data() : v.docs.map(d => [d.id, d.data()]));
        const changed = key !== last;
        if (changed || (opts.includeMetadataChanges && v.metadata.fromCache !== lastCache)) {
          last = key; lastCache = v.metadata.fromCache;
          if (target.type !== 'doc') v.docChanges = () => (changed ? v.docs : []);
          cb(v);
        }
      } };
      store.subs.add(s); s.fire();
      return () => store.subs.delete(s);
    }
  };
}
