// ═══════ HOME PAGE SIGN-IN (Firebase Authentication) ═══════
// The front door of admin.threepin.in. Same Firebase project and the same accounts as the CRM, the
// Dashboard and Finance: an email + password, or Google. Access is decided by the `tenantId` claim
// on the account (scripts/create-tenant.js, scripts/add-team-member.js) — a Google account that has
// no claim is signed straight back out here and told so, instead of landing on a console with
// no data. Signing in on this page opens the Daily task; arriving already signed in shows the consoles.
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCO5782HKI_ka5zx0tSBzohlvNB5rY_ZF0",
  authDomain: "pin-realty.firebaseapp.com",
  projectId: "pin-realty",
  storageBucket: "pin-realty.firebasestorage.app",
  messagingSenderId: "570586680667",
  appId: "1:570586680667:web:859a61bf99fe1824725e7e"
};
const DAILY_TASK = 'crm.html?nav=today';

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
window.__homeReady = true;

const $ = id => document.getElementById(id);
const gate = $('gate');
const form = $('signin-form');
const errBox = $('signin-err');
const googleBtn = $('google-btn');
const submitBtn = $('signin-submit');
const emailIn = $('signin-email');
const passIn = $('signin-pass');

let intent = false;      // true while a sign-in started on THIS page is in flight → go to the Daily task

function show(view) { gate.dataset.view = view; }
function setError(msg) {
  errBox.textContent = msg || '';
  errBox.hidden = !msg;
}
function setBusy(on, which) {
  [googleBtn, submitBtn, emailIn, passIn].forEach(el => { el.disabled = on; });
  googleBtn.classList.toggle('is-busy', on && which === 'google');
  submitBtn.classList.toggle('is-busy', on && which === 'email');
  form.setAttribute('aria-busy', on ? 'true' : 'false');
}

function describe(e) {
  switch (e && e.code) {
    case 'auth/invalid-credential': case 'auth/wrong-password': case 'auth/user-not-found': case 'auth/invalid-email':
      return "That email and password don't match. Check them and try again.";
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'auth/network-request-failed':
      return 'No connection. Check your internet and try again.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google window. Allow pop-ups for this site and try again.';
    case 'auth/popup-closed-by-user': case 'auth/cancelled-popup-request':
      return '';   // the person closed it: nothing went wrong
    case 'auth/unauthorized-domain':
      return "This address isn't authorised for Google sign-in yet. Ask the admin to add it in Firebase.";
    case 'auth/operation-not-allowed':
      return "Google sign-in isn't switched on for this project yet.";
    case 'auth/user-disabled':
      return 'This account has been disabled. Contact the admin.';
    default:
      return "Couldn't sign you in. Try again.";
  }
}

// Whoever is signed in must carry the tenant claim to be let in. A claim set after this browser's
// last sign-in is picked up by one refresh before giving up. Returns { tenant, failed }: `failed`
// means the token could not be fetched at all (offline, expired), which is not the same as an
// account that has no claim and must never sign anyone out.
async function tenantOf(user) {
  let r = null, failed = false;
  try { r = await user.getIdTokenResult(false); } catch (e) { failed = true; }
  if (!(r && r.claims.tenantId)) {
    try { r = await user.getIdTokenResult(true); failed = false; } catch (e) { failed = !r; }
  }
  return { tenant: (r && r.claims.tenantId) || null, role: (r && r.claims.role) || '', failed };
}

function nameOf(user) {
  const first = String(user.displayName || '').trim().split(/\s+/)[0];
  if (first) return first;
  const local = String(user.email || '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  return /^[a-z ]{2,24}$/i.test(local) ? local.replace(/\b\w/g, c => c.toUpperCase()).split(' ')[0] : '';
}

// Signing out here also drops the local copy the consoles keep, as the CRM's own sign-out does.
async function forgetLocalCopy() {
  try {
    const fs = await import("../shared-assets/fs-metered.js");
    await fs.clearIndexedDbPersistence(fs.getFirestore(app));
  } catch (e) { /* another tab still has it open, or none was kept */ }
}

onAuthStateChanged(auth, async user => {
  if (!user) { intent = false; setBusy(false); show('signin'); return; }
  const { tenant, role, failed } = await tenantOf(user);
  if (auth.currentUser !== user) return;   // signed out, or another account, while we were asking
  if (failed) {
    // Could not reach Google to check: keep the person signed in and let them retry.
    intent = false;
    setBusy(false);
    setError("Couldn't check your account. Check your connection and reload the page.");
    show('signin');
    return;
  }
  if (!tenant) {
    const email = user.email || 'This account';
    intent = false;
    setError(email + " isn't set up for the console yet. Ask the admin to add this email, then sign in again.");
    await signOut(auth);
    return;   // the null state that follows shows the sign-in with the message above
  }
  setError('');
  // An agent's home is My Day; their tiles are the pages they have (the menu shows the rest).
  const agent = role === 'agent';
  if (intent) {
    show('opening');
    location.assign(agent ? 'myday.html' : DAILY_TASK);
    return;
  }
  if (agent) agentTiles(); else teamTiles();
  // The buyers' chat button (bottom right) must never sit on a tile: room is left under them.
  const tilesNav = document.querySelector('nav.tiles');
  if (tilesNav) tilesNav.style.paddingBottom = '96px';
  // On a phone the buyers' chat button would sit on a tile at first sight: for the signed-in team it
  // is hidden there (it is for buyers; the sign-in screen keeps it).
  if (!document.getElementById('teamWidgetOff')) {
    const st = document.createElement('style'); st.id = 'teamWidgetOff';
    st.textContent = '@media (max-width: 520px) { iframe[src*="tailortalk" i], [id*="tailortalk" i], [class*="tailortalk" i], #tt-widget-container, [id^="tt-widget" i], [class*="tt-widget" i] { display: none !important; } } .who-hi { white-space: normal; overflow-wrap: anywhere; }';
    document.head.appendChild(st);
  }
  const name = nameOf(user);
  $('who-hi').textContent = name ? 'Welcome back, ' + name : 'Welcome back';
  $('who-email').textContent = user.email || '';
  $('who-av').textContent = (name || user.email || '?').charAt(0).toUpperCase();
  show('signedin');
});

googleBtn.addEventListener('click', async () => {
  setError('');
  intent = true;
  setBusy(true, 'google');
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    await signInWithPopup(auth, provider);
  } catch (e) {
    intent = false;
    setBusy(false);
    setError(describe(e));
  }
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  setError('');
  intent = true;
  setBusy(true, 'email');
  try {
    await signInWithEmailAndPassword(auth, emailIn.value.trim(), passIn.value);
  } catch (err) {
    intent = false;
    setBusy(false);
    setError(describe(err));
    passIn.focus();
    passIn.select();
  }
});

$('pass-toggle').addEventListener('click', e => {
  const on = passIn.type === 'password';
  passIn.type = on ? 'text' : 'password';
  e.currentTarget.setAttribute('aria-pressed', on ? 'true' : 'false');
  e.currentTarget.setAttribute('aria-label', on ? 'Hide password' : 'Show password');
  e.currentTarget.textContent = on ? 'Hide' : 'Show';
});

$('signout-btn').addEventListener('click', async () => {
  show('checking');
  try { await signOut(auth); } catch (e) { /* the state change below puts the sign-in back */ }
  forgetLocalCopy();
});

// The tiles an agent sees on this page: My Day, their Properties, the CRM (their leads), Messages.
// Everyone else keeps their tiles, with My Day and Messages added up front (approvals and the team's
// conversations live there).
function teamTiles() {
  const nav = document.querySelector('nav.tiles');
  if (!nav || nav.dataset.team) return;
  nav.dataset.team = '1';
  const go = '<span class="go"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>';
  const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const tile = (href, ico, nm, ds) => `<a class="tile rise" style="--i:0" href="${href}"><span class="ico">${ico}</span><span class="tx"><span class="nm">${nm}</span><span class="ds">${ds}</span></span>${go}</a>`;
  nav.insertAdjacentHTML('afterbegin', tile('myday.html', svg('<path d="M3.5 10.5 12 3.5l8.5 7M5.5 9v11h13V9"/>'), 'My Day', 'Approvals waiting on you, visits and follow-ups')
    + tile('messages.html', svg('<path d="M4 5h16v11H8l-4 4z"/>'), 'Messages', 'The team’s conversations, one for every request'));
}

function agentTiles() {
  const nav = document.querySelector('nav.tiles');
  if (!nav || nav.dataset.agent) return;
  nav.dataset.agent = '1';
  const k = document.querySelector('.kicker');
  if (k) k.textContent = '3 PIN · Agent';
  const go = '<span class="go"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>';
  const tile = (i, href, ico, nm, ds, primary) => `<a class="tile${primary ? ' primary' : ''} rise" style="--i:${i}" href="${href}"><span class="ico">${ico}</span><span class="tx"><span class="nm">${nm}</span><span class="ds">${ds}</span></span>${go}</a>`;
  const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  nav.innerHTML = tile(1, 'myday.html', svg('<path d="M3.5 10.5 12 3.5l8.5 7M5.5 9v11h13V9"/>'), 'My Day', 'Approvals, site visits and follow-ups for today', true)
    + tile(2, 'dashboard.html', svg('<rect x="3.5" y="3.5" width="7" height="8" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.8"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.8"/><rect x="3.5" y="14.5" width="7" height="6" rx="1.8"/>'), 'Properties', 'Yours in full, the rest as a summary')
    + tile(3, 'crm.html', svg('<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20c.6-3.6 3.3-5.6 6.5-5.6s5.9 2 6.5 5.6"/>'), 'Leads', 'Your enquiries, follow-ups and visits')
    + tile(4, 'messages.html', svg('<path d="M4 5h16v11H8l-4 4z"/>'), 'Messages', 'Talk to the team about a property or a lead');
}
