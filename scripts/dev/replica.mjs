// Local dev only (scripts/easy-dev.mjs). Runs in the browser before the CRM's Firebase code: makes
// the in-memory Firestore the page uses (tests/fake-firestore.mjs) a live copy of the dev server's
// — filled from /__dev/state, kept up to date from /__dev/events, and every write the page makes
// sent back to /__dev/write. So the page and the real API handlers on the server see the same data.

import { makeStore } from '/tests/fake-firestore.mjs';

const store = makeStore();
const docs = store.docs;
const rawSet = Map.prototype.set, rawDelete = Map.prototype.delete;
let applying = false;
const dirty = new Set();
docs.set = function (k, v) { if (!applying) dirty.add(k); return rawSet.call(this, k, v); };
docs.delete = function (k) { if (!applying) dirty.add(k); return rawDelete.call(this, k); };
docs.clear = function () { for (const k of this.keys()) dirty.add(k); return Map.prototype.clear.call(this); };

function apply(changes) {
  applying = true;
  try { for (const { path, data } of changes) data == null ? rawDelete.call(docs, path) : rawSet.call(docs, path, data); }
  finally { applying = false; }
  store.notify();
}

// After any write the page makes: send what changed (whole documents) to the server.
let flushing = null;
store.subs.add({ fire() {
  if (!dirty.size || flushing) return;
  flushing = Promise.resolve().then(() => {
    const changes = [...dirty].map(path => ({ path, data: docs.has(path) ? docs.get(path) : null }));
    dirty.clear(); flushing = null;
    return fetch('/__dev/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
  });
} });

const [state, me] = await Promise.all([fetch('/__dev/state').then(r => r.json()), fetch('/__dev/whoami').then(r => r.json())]);
apply(Object.entries(state).map(([path, data]) => ({ path, data })));
globalThis.__fakeStore = store;
globalThis.__fakeUser = me;

const ev = new EventSource('/__dev/events');
ev.onmessage = e => { try { apply(JSON.parse(e.data)); } catch (err) { console.warn('dev replica:', err); } };
console.info(`%cEåsy local dev%c — signed in as ${me.email}, fake Firestore (${Object.keys(state).length} documents). Nothing here touches the live site.`, 'background:#FF8A00;color:#111;padding:2px 6px;border-radius:4px;font-weight:700', '');
