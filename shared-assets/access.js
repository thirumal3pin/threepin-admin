// ═══════ WHO IS LOOKING — role-aware menu and page gate (agent layer) ═══════
//
// One <script type="module" src="shared-assets/access.js"> on each console page. Once the person is
// signed in it reads their role claim and:
//   · admin  → shows the "Team & access" entry in the menu
//   · agent  → asks the server for the agent settings that apply to them (one call, kept for the
//              browser session) and hides every menu section they were not given; a page they were
//              not given at all is replaced by a short note with a way back
//   · anyone else → nothing changes
// Exposes window.PinAccess = { role, email, config } and fires a 'pin-access' event on document.
//
// This file never touches Firestore (a page initialises its own Firestore with its own cache
// settings first, and a second initialiser would break it). What an agent can READ is enforced by
// firestore.rules and the server; this only keeps the screen honest.
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

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
  property: ['properties'],
  track: ['shoots'],
  finance: ['finance'],
  team: [],
};
const page = document.documentElement.dataset.console
  || (/propertytrack/.test(location.pathname) ? 'track'
    : /dashboard|property\.html/.test(location.pathname) ? 'property'
    : /3pinfinance/.test(location.pathname) ? 'finance'
    : /team\.html/.test(location.pathname) ? 'team'
    : /crm/.test(location.pathname) ? 'crm' : '');

const CACHE = 'pin.access';
const REFRESH_MS = 10 * 60 * 1000;   // re-read the role from Google at most every 10 minutes

function cached(uid) {
  try {
    const c = JSON.parse(sessionStorage.getItem(CACHE) || 'null');
    return c && c.uid === uid && Date.now() - c.at < REFRESH_MS ? c : null;
  } catch (e) { return null; }
}
function remember(v) { try { sessionStorage.setItem(CACHE, JSON.stringify(v)); } catch (e) { /* private window */ } }

async function agentConfig(user) {
  const token = await user.getIdToken();
  const r = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action: 'me' }),
  });
  if (!r.ok) throw new Error('agent settings: ' + r.status);
  return (await r.json()).config || null;
}

function apply(a) {
  window.PinAccess = a;
  if (window.AppNav && window.AppNav.setAccess) window.AppNav.setAccess({ role: a.role, tabs: a.config ? a.config.tabs : null });
  else window.__pinAccess = { role: a.role, tabs: a.config ? a.config.tabs : null };
  document.dispatchEvent(new CustomEvent('pin-access', { detail: a }));
  if (a.role === 'agent') gate(a);
}

// An agent on a page none of their tabs open: say so plainly, offer the pages they do have, and a
// way to sign out (a shared phone, the wrong account).
function gate(a) {
  const need = PAGE_TABS[page];
  if (!need) return;
  const tabs = (a.config && a.config.tabs) || [];
  if (need.some(t => tabs.includes(t))) return;
  const btn = 'display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:10px;'
    + 'font-weight:600;text-decoration:none;border:1px solid var(--border2,#D4D4D4);';
  const links = [];
  if (tabs.some(t => PAGE_TABS.crm.includes(t))) links.push(['crm.html', 'Open the CRM']);
  if (tabs.includes('properties')) links.push(['dashboard.html', 'Open Properties']);
  document.body.className = '';
  document.body.style.cssText = 'margin:0;background:var(--bg,#F8F8F8);color:var(--ink,#171717);font:15px/1.5 var(--sans,system-ui)';
  document.body.innerHTML =
    '<main style="box-sizing:border-box;max-width:440px;margin:0 auto;padding:18vh 16px 40px;text-align:center">'
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
    const { signOut } = await import("https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js");
    try { sessionStorage.removeItem(CACHE); } catch (e) {}
    await signOut(auth);
    location.assign('index.html');
  });
}

onAuthStateChanged(auth, async user => {
  if (!user) { window.PinAccess = null; return; }
  const hit = cached(user.uid);
  if (hit) { apply(hit); return; }
  try {
    const res = await user.getIdTokenResult(true);
    const role = res.claims.role || 'none';
    const a = { uid: user.uid, at: Date.now(), role, email: user.email || '', config: null };
    if (role === 'agent') a.config = await agentConfig(user);
    remember(a);
    apply(a);
  } catch (e) {
    // Offline or the server unreachable: an agent sees no menu sections rather than all of them.
    const res = await user.getIdTokenResult(false).catch(() => null);
    const role = (res && res.claims.role) || 'none';
    apply({ uid: user.uid, at: 0, role, email: user.email || '', config: role === 'agent' ? { tabs: [] } : null });
  }
});
