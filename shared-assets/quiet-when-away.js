// ═══════ QUIET WHEN AWAY — a page nobody is looking at stops reading the database ═══════
//
// Why (owner, 27 Nov 2026: "why is my database quota exhausting daily"): the Firebase usage chart
// showed ~13,000 reads a night between 10 PM and 8 AM with nobody working — 200–400 live listeners
// stayed connected from pages left open on laptops and phones (the CRM alone holds ~120: one per lead
// view document). Every lead change at night was read again by every open page, and every device
// waking up re-read what its pages show. Reads grew from ~15K a day (early Nov) to 50–73K.
//
// What it does: when the page has been hidden for HIDDEN_MS (another tab, minimised, the phone
// locked) or nobody has touched it for IDLE_MS, the page's Firestore goes offline (disableNetwork):
// listeners pause and serve this device's copy, no reads are made. The moment someone looks at it or
// touches it again it goes back online (enableNetwork) and catches up — within half an hour only what
// changed is read. Saves made meanwhile wait in this device's queue and go out on return (nothing is
// lost; a page only goes quiet minutes after the last touch, long after a save has reached the
// server).
//
//   quietWhenAway(db)   — once per Firestore instance; any page module may call it.
const HIDDEN_MS = 3 * 60000;
const IDLE_MS = 30 * 60000;
const FS = 'https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js';
const seen = new WeakSet();

export function quietWhenAway(db, { hiddenMs = HIDDEN_MS, idleMs = IDLE_MS } = {}) {
  if (!db || seen.has(db) || typeof document === 'undefined') return;
  seen.add(db);
  let off = false, hideT = null, idleT = null, fsP = null, lastPoke = 0;
  const fs = () => (fsP || (fsP = import(FS)));
  const pause = why => {
    if (off) return;
    off = true;
    document.documentElement.dataset.dbQuiet = why;
    fs().then(m => m.disableNetwork(db)).catch(() => { off = false; delete document.documentElement.dataset.dbQuiet; });
  };
  const wake = () => {
    clearTimeout(idleT);
    idleT = setTimeout(() => pause('idle'), idleMs);
    if (!off) return;
    off = false;
    delete document.documentElement.dataset.dbQuiet;
    fs().then(m => m.enableNetwork(db)).catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hideT);
    if (document.visibilityState === 'hidden') hideT = setTimeout(() => pause('hidden'), hiddenMs);
    else wake();
  });
  // Any touch counts as someone being there (a moving mouse at most once every few seconds).
  const poke = () => { const now = Date.now(); if (!off && now - lastPoke < 5000) return; lastPoke = now; wake(); };
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll', 'pointermove'].forEach(ev => window.addEventListener(ev, poke, { passive: true, capture: true }));
  window.addEventListener('focus', wake);
  window.addEventListener('pageshow', wake);
  idleT = setTimeout(() => pause('idle'), idleMs);
  if (document.visibilityState === 'hidden') hideT = setTimeout(() => pause('hidden'), hiddenMs);
  // For tests and support: PinDbQuiet.pause('test') / .wake() / .state().
  window.PinDbQuiet = { pause, wake, state: () => (off ? document.documentElement.dataset.dbQuiet || 'off' : 'on') };
}
