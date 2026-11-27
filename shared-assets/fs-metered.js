// ═══════ FIRESTORE, COUNTED — every read and write a page makes, by what it is for ═══════
//
// Owner, 27 Nov 2026: "track and maintain a log of all actions with their read and write count,
// aligned with Firebase, and why and for what — so I can find it next time." Pages import Firestore
// from here instead of from gstatic; everything is the real SDK (export *), only the calls that read
// or write are wrapped to count. Every ~10 minutes, and when the page is hidden or closed, the counts
// go to the server (/api/agent usage-log), which adds them to usageLog/{day} — Firebase's own day,
// 1:30 PM to 1:30 PM India time. team.html → Database usage shows them, ranked, with what each is.
//
// How a read is counted, as Firebase bills it (an estimate on this side — the SDK does not report
// billed reads):
//   · a live list (onSnapshot on a query): its first answer from the server costs every document
//     in it — unless the same list was live on this device less than 30 minutes ago (Firebase then
//     resumes and bills only what changed); after that, each document added or changed costs one;
//   · a live document: one when it arrives, one each time it changes;
//   · a one-off read (getDocs / getDoc) from the server: one per document (an empty answer costs one);
//   · a write: one per document set, updated or deleted (batches and transactions included).
// What it is for: the page, the collection (document ids shown as *) and the fields it filters on,
// e.g. "crm › leadViews/* (live)". shared-assets/usage-catalog.js says what each one is in words.
import * as R from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
export * from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';

const PAGE = (() => { try { return (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '') || 'index'; } catch (e) { return 'page'; } })();
const counts = new Map();   // label → { r, w, n }
const RESUME_MS = 30 * 60000;
const LKEY = 'pin.usage.live';
const liveSeen = (() => { try { return JSON.parse(localStorage.getItem(LKEY) || '{}'); } catch (e) { return {}; } })();
const markLive = label => { liveSeen[label] = Date.now(); };
const saveLive = () => { try { const now = Date.now(); for (const k of Object.keys(liveSeen)) if (now - liveSeen[k] > 2 * RESUME_MS) delete liveSeen[k]; localStorage.setItem(LKEY, JSON.stringify(liveSeen)); } catch (e) { /* no storage */ } };

function tally(label, r, w) {
  if (!r && !w) return;
  const c = counts.get(label) || { r: 0, w: 0, n: 0 };
  c.r += r; c.w += w; c.n += 1;
  counts.set(label, c);
}
// "leads/abc/notes" → "leads/*/notes"
const norm = segs => segs.map((s, i) => (i % 2 ? '*' : s)).join('/');
function labelOf(target, how) {
  let what = 'unknown';
  try {
    if (target && typeof target.path === 'string') what = norm(target.path.split('/'));
    else if (target && target._query) {
      const q = target._query;
      const segs = q.path && q.path.segments ? q.path.segments.slice(q.path.offset || 0, (q.path.offset || 0) + (q.path.len != null ? q.path.len : q.path.segments.length)) : [];
      what = q.collectionGroup ? 'group:' + q.collectionGroup : norm(segs);
      const f = (q.filters || []).map(x => { try { return (x.field && x.field.canonicalString ? x.field.canonicalString() : '') + ' ' + (x.op || ''); } catch (e) { return ''; } }).filter(Boolean);
      if (f.length) what += ' [' + f.join(', ') + ']';
      if (q.limit != null) what += ' limit ' + q.limit;
    }
  } catch (e) { /* the label is a convenience */ }
  return PAGE + ' › ' + what + ' (' + how + ')';
}
const isQuerySnap = s => s && Array.isArray(s.docs) && typeof s.docChanges === 'function';
const fromServer = s => !!s && !!s.metadata && s.metadata.fromCache === false;
const json = s => { try { return JSON.stringify(s.data()); } catch (e) { return ''; } };

// ── Reads ──
export function onSnapshot(target, ...args) {
  if (typeof R.onSnapshot !== 'function') return undefined;
  const label = labelOf(target, 'live');
  const recentlyLive = Date.now() - (liveSeen[label] || 0) < RESUME_MS;
  let firstServer = true, cacheJson = null, lastJson = null;
  const count = snap => {
    try {
      markLive(label);
      if (isQuerySnap(snap)) {
        if (!fromServer(snap)) return;
        if (firstServer) { firstServer = false; tally(label, recentlyLive ? snap.docChanges().filter(c => c.type !== 'removed').length : Math.max(1, snap.size), 0); return; }
        const changed = snap.docChanges().filter(c => c.type !== 'removed').length;
        if (changed && !snap.metadata.hasPendingWrites) tally(label, changed, 0);
      } else if (snap && typeof snap.exists === 'function') {
        const j = json(snap);
        if (!fromServer(snap)) { if (cacheJson == null) cacheJson = j; return; }
        if (snap.metadata.hasPendingWrites) return;
        if (firstServer) { firstServer = false; lastJson = j; if (!(recentlyLive && cacheJson === j)) tally(label, 1, 0); return; }
        if (j !== lastJson) { lastJson = j; tally(label, 1, 0); }
      }
    } catch (e) { /* counting never breaks a page */ }
  };
  const a = args.slice();
  const i = a.findIndex(x => typeof x === 'function' || (x && typeof x === 'object' && typeof x.next === 'function'));
  if (i >= 0) {
    if (typeof a[i] === 'function') { const fn = a[i]; a[i] = snap => { count(snap); return fn(snap); }; }
    else { const o = a[i]; a[i] = { ...o, next: snap => { count(snap); return o.next(snap); } }; }
  }
  return R.onSnapshot(target, ...a);
}
export async function getDocs(q, ...a) {
  const s = await R.getDocs(q, ...a);
  try { if (fromServer(s)) tally(labelOf(q, 'once'), Math.max(1, s.size), 0); } catch (e) { /* */ }
  return s;
}
export async function getDoc(ref, ...a) {
  const s = await R.getDoc(ref, ...a);
  try { if (fromServer(s)) tally(labelOf(ref, 'once'), 1, 0); } catch (e) { /* */ }
  return s;
}
export async function getDocFromServer(ref, ...a) { const s = await R.getDocFromServer(ref, ...a); tally(labelOf(ref, 'once'), 1, 0); return s; }
export async function getDocsFromServer(q, ...a) { const s = await R.getDocsFromServer(q, ...a); tally(labelOf(q, 'once'), Math.max(1, s.size), 0); return s; }

// ── Writes ──
export function setDoc(ref, ...a) { tally(labelOf(ref, 'write'), 0, 1); return R.setDoc(ref, ...a); }
export function updateDoc(ref, ...a) { tally(labelOf(ref, 'write'), 0, 1); return R.updateDoc(ref, ...a); }
export function deleteDoc(ref, ...a) { tally(labelOf(ref, 'write'), 0, 1); return R.deleteDoc(ref, ...a); }
export function addDoc(ref, ...a) { tally(labelOf(ref, 'write'), 0, 1); return R.addDoc(ref, ...a); }
export function writeBatch(db, ...a) {
  const b = R.writeBatch(db, ...a);
  const ops = [];
  const wrap = k => (ref, ...x) => { ops.push(ref); b[k](ref, ...x); return proxy; };
  const proxy = { set: wrap('set'), update: wrap('update'), delete: wrap('delete'), commit: () => { ops.forEach(r => tally(labelOf(r, 'write'), 0, 1)); return b.commit(); } };
  return proxy;
}
export function runTransaction(db, fn, ...a) {
  return R.runTransaction(db, tx => {
    const w = {
      get: async ref => { const s = await tx.get(ref); tally(labelOf(ref, 'transaction'), 1, 0); return s; },
      set: (ref, ...x) => { tally(labelOf(ref, 'transaction'), 0, 1); tx.set(ref, ...x); return w; },
      update: (ref, ...x) => { tally(labelOf(ref, 'transaction'), 0, 1); tx.update(ref, ...x); return w; },
      delete: ref => { tally(labelOf(ref, 'transaction'), 0, 1); tx.delete(ref); return w; },
    };
    return fn(w);
  }, ...a);
}

// ── Sending the counts to the server ──
let token = null;
async function freshToken() {
  try {
    const A = await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js');
    const u = A.getAuth().currentUser;
    if (u) token = await u.getIdToken();
  } catch (e) { /* not signed in yet */ }
  return token;
}
function send(useKeepalive) {
  saveLive();
  if (!counts.size || !token) return;
  const body = JSON.stringify({ action: 'usage-log', page: PAGE, counts: Object.fromEntries([...counts].slice(0, 80)) });
  counts.clear();
  try { fetch('/api/agent', { method: 'POST', keepalive: !!useKeepalive, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body }).catch(() => {}); } catch (e) { /* */ }
}
if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof fetch === 'function') {
  setInterval(() => { freshToken().then(() => send(false)); }, 10 * 60000);
  setTimeout(freshToken, 20000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') send(true); else freshToken(); });
  window.addEventListener('pagehide', () => send(true));
  // For support: PinUsage.counts() shows what this page has read and written so far.
  window.PinUsage = { counts: () => Object.fromEntries(counts), flush: () => freshToken().then(() => send(false)) };
}
