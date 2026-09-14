// ═══════ IN-MEMORY FIRESTORE ═══════
//
// Just enough of the firebase-admin Firestore API for api/_tailortalk-sync.js: documents and
// subcollections, equality queries (including dotted map paths), batches and transactions.
// It is strict where the real one is strict — an `undefined` anywhere in written data throws,
// exactly as firebase-admin does without ignoreUndefinedProperties — so a plan that would fail
// in production fails here too.

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function assertNoUndefined(value, path = '') {
  if (value === undefined) throw new Error(`Cannot use "undefined" as a Firestore value (found in field "${path || '(root)'}")`);
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, path ? `${path}.${k}` : k);
  }
}

const isMap = v => v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(target, src) {
  const out = isMap(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(src)) out[k] = isMap(v) && isMap(out[k]) ? deepMerge(out[k], v) : clone(v);
  return out;
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

export function createFakeDb() {
  const store = new Map();   // full doc path -> data
  const stats = { reads: 0, writes: 0, queries: [] };
  let autoId = 0;

  const snap = (ref) => {
    const data = store.get(ref.path);
    return { id: ref.id, ref, exists: data !== undefined, data: () => clone(data) };
  };

  function docRef(path) {
    const id = path.split('/').pop();
    return {
      id, path,
      collection: name => collectionRef(`${path}/${name}`),
      async get() { stats.reads++; return snap(this); },
      async set(data, opts) { applySet(this, data, opts); },
      async update(data) { applyUpdate(this, data); }
    };
  }

  function applySet(ref, data, opts) {
    assertNoUndefined(data);
    stats.writes++;
    const prev = store.get(ref.path);
    store.set(ref.path, opts && opts.merge ? deepMerge(prev, data) : clone(data));
  }

  function applyUpdate(ref, data) {
    assertNoUndefined(data);
    const prev = store.get(ref.path);
    if (prev === undefined) throw new Error(`No document to update: ${ref.path}`);
    stats.writes++;
    const next = clone(prev);
    for (const [k, v] of Object.entries(data)) {
      const keys = k.split('.');
      let o = next;
      keys.slice(0, -1).forEach(key => { if (!isMap(o[key])) o[key] = {}; o = o[key]; });
      o[keys[keys.length - 1]] = clone(v);
    }
    store.set(ref.path, next);
  }

  function query(collPath, filters = [], lim = null) {
    return {
      where: (field, op, value) => {
        if (op !== '==' && op !== 'array-contains') throw new Error(`fake db supports == and array-contains (got ${op})`);
        return query(collPath, [...filters, [field, value, op]], lim);
      },
      limit: n => query(collPath, filters, n),
      async get() {
        stats.queries.push({ collPath, filters: filters.map(f => f.join('==')) });
        const depth = collPath.split('/').length + 1;
        let docs = [];
        for (const [path, data] of store) {
          if (!path.startsWith(collPath + '/') || path.split('/').length !== depth) continue;
          if (filters.every(([f, v, op]) => op === 'array-contains' ? (Array.isArray(getPath(data, f)) && getPath(data, f).includes(v)) : getPath(data, f) === v)) docs.push(snap(docRef(path)));
        }
        docs.sort((a, b) => a.id.localeCompare(b.id));
        if (lim !== null) docs = docs.slice(0, lim);
        stats.reads += Math.max(1, docs.length);
        return { empty: docs.length === 0, size: docs.length, docs };
      }
    };
  }

  function collectionRef(path) {
    return {
      path,
      doc: id => docRef(`${path}/${id ?? `auto${++autoId}`}`),
      async add(data) { const ref = docRef(`${path}/auto${++autoId}`); applySet(ref, data); return ref; },
      ...query(path)
    };
  }

  const db = {
    collection: collectionRef,
    batch() {
      const ops = [];
      return {
        set: (ref, data, opts) => ops.push(() => applySet(ref, data, opts)),
        update: (ref, data) => ops.push(() => applyUpdate(ref, data)),
        async commit() { ops.forEach(op => op()); }
      };
    },
    async runTransaction(fn) {
      const ops = [];
      let wrote = false;
      const t = {
        async get(refOrQuery) {
          if (wrote) throw new Error('Firestore transactions require all reads before writes');
          return refOrQuery.path && refOrQuery.collection ? refOrQuery.get() : refOrQuery.get();
        },
        set(ref, data, opts) { wrote = true; assertNoUndefined(data); ops.push(() => applySet(ref, data, opts)); return t; },
        update(ref, data) { wrote = true; assertNoUndefined(data); ops.push(() => applyUpdate(ref, data)); return t; },
        delete(ref) { wrote = true; ops.push(() => { stats.writes++; store.delete(ref.path); }); return t; }
      };
      const result = await fn(t);
      ops.forEach(op => op());
      return result;
    },
    // test helpers
    _store: store,
    _stats: stats,
    _get: path => clone(store.get(path)),
    _list: prefix => [...store.keys()].filter(p => p.startsWith(prefix + '/') && p.split('/').length === prefix.split('/').length + 1)
  };
  return db;
}
