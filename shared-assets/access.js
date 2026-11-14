// ═══════ WHO IS LOOKING — role-aware menu and page gate (agent layer) ═══════
//
// One <script type="module" src="shared-assets/access.js"> on each console page (whose <html> says
// which console it is: data-console="crm" | "property" | "track" | "finance" | "team"). Once the
// person is signed in it reads their role claim and:
//   · admin  → shows the "Team & access" entry in the menu
//   · agent  → asks the server for the agent settings that apply to them and hides every menu
//              section they were not given; a page none of their tabs open is replaced by a short
//              note with the pages they do have and a sign-out
//   · anyone else → nothing changes
// Exposes window.PinAccess = { role, email, config } and fires a 'pin-access' event on document.
//
// The last answer is kept on the device (localStorage 'pin.access.last') so the menu is right from
// the first paint of the next page (appnav.js reads it), and so a failed check (a blip, offline)
// falls back to what was known instead of shutting an agent out of pages they are allowed.
//
// When a login becomes an agent, anything the browser saved for it while it had full access (the
// pages keep a copy of the data in IndexedDB) is wiped once, then the page reloads.
//
// Nothing here is security: what an agent can READ is enforced by firestore.rules and the server.
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCO5782HKI_ka5zx0tSBzohlvNB5rY_ZF0",
  authDomain: "pin-realty.firebaseapp.com",
  projectId: "pin-realty",
  storageBucket: "pin-realty.firebasestorage.app",
  messagingSenderId: "570586680667",
  appId: "1:570586680667:web:859a61bf99fe1824725e7e"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);

// Which console needs which tab. A page an agent has none of these tabs for is closed to them.
const PAGE_TABS = {
  crm: ['crm', 'tasks', 'ads', 'campaigns', 'calendar'],
  // The Property dashboard is the full inventory: an agent's Properties is listings.html.
  property: [],
  myprops: ['properties'],
  myday: ['myday'],
  messages: ['messages'],
  track: ['shoots'],
  finance: ['finance'],
  team: [],
};
const page = document.documentElement.dataset.console || '';

const SESSION = 'pin.access';          // this tab's answer, re-checked every 10 minutes
const LAST = 'pin.access.last';        // the device's last answer (menu at first paint, offline fallback)
const REFRESH_MS = 10 * 60 * 1000;

const read = (store, key) => { try { return JSON.parse(store.getItem(key) || 'null'); } catch (e) { return null; } };
const write = (store, key, v) => { try { store.setItem(key, JSON.stringify(v)); } catch (e) { /* private window */ } };

async function agentSettings(user) {
  const token = await user.getIdToken();
  const r = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action: 'me' }),
  });
  if (!r.ok) throw new Error('agent settings: ' + r.status);
  return r.json();
}

// Clear what the pages saved on this device: Firestore's copy in IndexedDB, and the data copies kept
// in localStorage (a property opened in full, the team calendar, Eåsy's chat, Daily task opens).
// Returns false when IndexedDB could not be cleared (another tab of the site still holds it), so the
// caller can try again on the next page load. Hygiene, not a control: what an agent can read is
// decided by the rules and the server, and a copy already taken cannot be taken back.
const DATA_KEYS = /^(pinProp:|pinCal:|pinTodayOpens:|easy\.)/;
async function forgetLocalCopy() {
  try {
    Object.keys(localStorage).filter(k => DATA_KEYS.test(k)).forEach(k => localStorage.removeItem(k));
  } catch (e) { /* private window */ }
  try {
    const fs = await import("https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js");
    const db = fs.getFirestore(app);
    await fs.terminate(db);
    await fs.clearIndexedDbPersistence(db);
    return true;
  } catch (e) { return false; }
}

// ── What is waiting for me, on every page ──
// Push notifications are out of scope, so the menu's badges are how a request or a message gets
// noticed: approvals waiting on me (My Day), conversations with something new (Messages), and for
// admins what is waiting in Team & access. Plus a short message when one of my own requests is
// decided while I am elsewhere. A few small live queries, once per page.
let inboxOn = false;
async function startInbox(a) {
  if (inboxOn || !a || !a.uid || window.__pinGated) return;
  inboxOn = true;
  try {
    if (!a.tenantId) { const r = await auth.currentUser.getIdTokenResult(false); a = { ...a, tenantId: r.claims.tenantId || null }; }
    if (!a.tenantId) return;
    const fs = await import("https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js");
    const db = fs.getFirestore(app);
    const me = String(a.email || '').toLowerCase();
    const key = me.replace(/[^a-z0-9]/g, '_');
    const T = a.tenantId;
    const badge = (k, n) => { if (window.AppNav && window.AppNav.setBadge) window.AppNav.setBadge(k, n); };
    const quiet = () => {};
    const req = fs.collection(db, 'accessRequests');
    if (a.role === 'agent' || a.role === 'admin') {
      fs.onSnapshot(fs.query(req, fs.where('tenantId', '==', T), fs.where('approvers', 'array-contains', me), fs.where('status', '==', 'pending')),
        s => badge('myday', s.docs.filter(d => d.data().requesterEmail !== me).length), quiet);
    }
    let known = null;
    fs.onSnapshot(fs.query(req, fs.where('tenantId', '==', T), fs.where('requesterEmail', '==', me)), s => {
      const now = new Map(s.docs.map(d => [d.id, d.data()]));
      if (known && page !== 'myday') now.forEach((r, id) => {
        const was = known.get(id);
        if (was && was.status === 'pending' && (r.status === 'approved' || r.status === 'rejected'))
          inboxToast((r.status === 'approved' ? 'Approved by ' : 'Not approved by ') + (r.decidedByName || 'an admin') + ' — ' + (r.kind === 'lead' ? 'a matching buyer' : r.title), 'myday.html');
      });
      known = now;
    }, quiet);
    fs.onSnapshot(fs.query(fs.collection(db, 'threads'), fs.where('tenantId', '==', T), fs.where('members', 'array-contains', me)),
      s => badge('messages', s.docs.filter(d => { const t = d.data(); return t.lastAt && t.lastBy !== me && t.lastAt > Number((t.reads || {})[key] || 0); }).length), quiet);
    if (a.role === 'admin') {
      let pend = 0, subs = 0;
      fs.onSnapshot(fs.query(req, fs.where('tenantId', '==', T), fs.where('status', '==', 'pending')), s => { pend = s.size; badge('team', pend + subs); }, quiet);
      fs.onSnapshot(fs.query(fs.collection(db, 'propertySubmissions'), fs.where('tenantId', '==', T), fs.where('status', '==', 'pending')), s => { subs = s.size; badge('team', pend + subs); }, quiet);
    }
  } catch (e) { /* badges are a convenience: the pages themselves still show everything */ }
}
function inboxToast(text, href) {
  let el = document.getElementById('pinInboxToast');
  if (!el) {
    el = document.createElement('a');
    el.id = 'pinInboxToast';
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:50%;top:max(14px,env(safe-area-inset-top));translate:-50% 0;z-index:9999;max-width:calc(100vw - 32px);'
      + 'background:var(--ink,#171717);color:var(--bg,#fff);padding:12px 16px;border-radius:12px;font:600 14px/1.35 var(--sans,system-ui);'
      + 'box-shadow:0 8px 24px rgba(0,0,0,.25);text-decoration:none';
    document.body.appendChild(el);
  }
  el.textContent = text + ' · Open';
  el.href = href;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 7000);
}

function apply(a, { gatePage = true } = {}) {
  window.PinAccess = a;
  const nav = { role: a.role, tabs: a.config ? a.config.tabs : null, actions: a.config ? a.config.actions : null };
  if (window.AppNav && window.AppNav.setAccess) window.AppNav.setAccess(nav);
  else window.__pinAccess = nav;
  document.dispatchEvent(new CustomEvent('pin-access', { detail: a }));
  if (a.role === 'agent' && gatePage) gate(a);
  startInbox(a);
}

// An agent on a page none of their tabs open: say so plainly, offer the pages they do have, and a
// way to sign out (a shared phone, the wrong account).
function gate(a) {
  const need = PAGE_TABS[page];
  if (!need) return;
  const tabs = (a.config && a.config.tabs) || [];
  if (need.some(t => tabs.includes(t))) return;
  // An agent opening the Property dashboard (a bookmark, a shared property link) goes to their own
  // Properties page, at the same property when the link named one.
  if ((page === 'property') && tabs.includes('properties')) {
    const qs = new URLSearchParams(location.search);
    const id = qs.get('id') || qs.get('property');
    location.replace('listings.html' + (id ? '?id=' + encodeURIComponent(id) : ''));
    return;
  }
  window.__pinGated = true;
  const btn = 'display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:10px;'
    + 'font-weight:600;text-decoration:none;border:1px solid var(--border2,#D4D4D4);';
  const links = [];
  if (tabs.includes('myday')) links.push(['myday.html', 'Open My Day']);
  if (tabs.some(t => PAGE_TABS.crm.includes(t))) links.push(['crm.html', 'Open the CRM']);
  if (tabs.includes('properties')) links.push(['listings.html', 'Open Properties']);
  document.body.className = '';
  document.body.style.cssText = 'margin:0;background:var(--bg,#F8F8F8);color:var(--ink,#171717);font:15px/1.5 var(--sans,system-ui)';
  document.body.innerHTML =
    '<main id="pinGate" style="box-sizing:border-box;max-width:440px;margin:0 auto;padding:18vh 16px 40px;text-align:center">'
    + '<img src="/logo.jpg" alt="" width="44" height="44" style="border-radius:10px;background:#fff;padding:3px;margin-bottom:16px">'
    + '<h1 style="font-size:20px;margin:0 0 8px">This page isn’t part of your access</h1>'
    + '<p style="color:var(--ink3,#5C5C5C);margin:0 0 22px">Ask an admin if you need it.</p>'
    + '<div style="display:flex;flex-direction:column;gap:10px">'
    + links.map(([href, label], i) => '<a href="' + href + '" style="' + btn + (i === 0
      ? 'background:var(--brand,#FF8A00);border-color:var(--brand,#FF8A00);color:var(--on-brand,#1A1206)'
      : 'background:var(--card,#fff);color:var(--ink,#171717)') + '">' + label + '</a>').join('')
    + '<button type="button" id="pinGateOut" style="' + btn + 'background:transparent;border-color:transparent;color:var(--ink3,#5C5C5C);font:inherit;font-weight:600;cursor:pointer">Sign out</button>'
    + '</div></main>';
  document.getElementById('pinGateOut').addEventListener('click', async () => {
    try { sessionStorage.removeItem(SESSION); localStorage.removeItem(LAST); } catch (e) {}
    await forgetLocalCopy();
    await signOut(auth);
    location.assign('index.html');
  });
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    window.PinAccess = null;
    try { localStorage.removeItem(LAST); sessionStorage.removeItem(SESSION); } catch (e) {}
    if (window.AppNav && window.AppNav.setAccess) window.AppNav.setAccess(null);
    return;
  }
  const last0 = read(localStorage, LAST);
  if (last0 && last0.uid !== user.uid) { try { localStorage.removeItem(LAST); } catch (e) {} if (window.AppNav && window.AppNav.setAccess) window.AppNav.setAccess({ pending: true }); }
  const hit = read(sessionStorage, SESSION);
  if (hit && hit.uid === user.uid && Date.now() - hit.at < REFRESH_MS) { apply(hit); return; }
  try {
    const res = await user.getIdTokenResult(true);
    const role = res.claims.role || 'none';
    const a = { uid: user.uid, at: Date.now(), role, email: user.email || '', config: null, tenantId: res.claims.tenantId || null };
    if (role === 'agent') a.config = (await agentSettings(user)).config || { tabs: [] };
    write(sessionStorage, SESSION, a);
    write(localStorage, LAST, { uid: a.uid, role: a.role, tabs: a.config ? a.config.tabs : null, config: a.config });
    const WIPED = 'pin.agentWiped.' + user.uid;
    if (role !== 'agent') { try { localStorage.removeItem(WIPED); } catch (e) {} }   // a later spell as agent wipes again
    else if (!localStorage.getItem(WIPED) && !sessionStorage.getItem('pin.wipeTried')) {
      // Became an agent on this device: drop what was saved while this login had full access. Marked
      // done only once it worked; with another tab of the site open it fails and is tried again in the
      // next browser session. Either way the page reloads (the wipe shuts this page's database
      // connection) — once per tab session, so it can never loop.
      try { sessionStorage.setItem('pin.wipeTried', '1'); } catch (e) {}
      if (await forgetLocalCopy()) { try { localStorage.setItem(WIPED, String(Date.now())); } catch (e) {} }
      location.reload();
      return;
    }
    apply(a);
  } catch (e) {
    // Could not check (offline, the server waking up): use what this device last knew, and never
    // close a page on a guess — the rules still decide what can be read.
    const last = read(localStorage, LAST);
    const res = await user.getIdTokenResult(false).catch(() => null);
    const role = (res && res.claims.role) || (last && last.uid === user.uid && last.role) || 'none';
    const config = role === 'agent' ? ((last && last.uid === user.uid && last.config) || { tabs: [] }) : null;
    apply({ uid: user.uid, at: 0, role, email: user.email || '', config, tenantId: (res && res.claims.tenantId) || null }, { gatePage: false });
  }
});
