// ═══════ THE AGENT LAYER'S PAGES — what they share ═══════
// My Day (myday.html), Properties for agents (listings.html) and Messages (messages.html):
// signing in, the server (/api/agent), the agent's copy of the properties, the team directory,
// and the small pieces of screen they all use (toast, bottom sheet, times).
//
// Nothing here is security. What a person can read is decided by firestore.rules and the server
// (api/_agent-work.js); these pages only draw it.
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCO5782HKI_ka5zx0tSBzohlvNB5rY_ZF0",
  authDomain: "pin-realty.firebaseapp.com",
  projectId: "pin-realty",
  storageBucket: "pin-realty.firebasestorage.app",
  messagingSenderId: "570586680667",
  appId: "1:570586680667:web:859a61bf99fe1824725e7e"
};
export const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const auth = getAuth(app);
let _db;
try { _db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (e) { _db = getFirestore(app); }
export const db = _db;

export const $ = id => document.getElementById(id);
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const lc = s => String(s == null ? '' : s).trim().toLowerCase();
export const emailKey = e => lc(e).replace(/[^a-z0-9]/g, '_');
// The page's database connection being closed on purpose (access.js clears an agent's device copy
// once, then reloads): not an error worth showing.
export const isShutdown = e => !!e && (/shutting down|terminated/i.test(String(e.message || '')) || e.code === 'cancelled');

// ── Who is signed in ──
// Resolves with { user, uid, email, tenantId, role } once signed in; a signed-out visitor is sent to
// the sign-in page.
export function whenSignedIn() {
  return new Promise(resolve => {
    onAuthStateChanged(auth, async user => {
      if (!user) { location.replace('index.html'); return; }
      let res = null;
      try { res = await user.getIdTokenResult(false); } catch (e) { res = null; }
      if (!(res && res.claims.tenantId)) { try { res = await user.getIdTokenResult(true); } catch (e) { /* below */ } }
      resolve({ user, uid: user.uid, email: lc(user.email), tenantId: (res && res.claims.tenantId) || null, role: (res && res.claims.role) || 'none' });
    });
  });
}
export const signOutHere = () => signOut(auth).then(() => location.assign('index.html'));

// ── The server ──
export async function api(action, body = {}) {
  const token = await auth.currentUser.getIdToken();
  const r = await fetch('/api/agent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, ...body }),
  });
  let j = {};
  try { j = await r.json(); } catch (e) { j = {}; }
  if (!r.ok || j.ok === false) { const err = new Error(j.error || 'Something went wrong — try again'); err.status = r.status; err.body = j; throw err; }
  return j;
}

// The team (names for emails), asked once per page.
let dirP = null;
export function directory() {
  if (!dirP) dirP = api('directory').then(j => j.people || []).catch(() => { dirP = null; return []; });
  return dirP;
}
export function nameOf(people, email) {
  const p = (people || []).find(x => x.email === lc(email));
  if (p) return p.name;
  const e = lc(email);
  return e ? e.split('@')[0].split(/[._-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') : '';
}

// ── The agent's own copy of the properties (agentViews/{tenant}__{uid}), live ──
// Asks the server to rebuild it when it is old (the server decides), then listens to it. cb(view)
// gets the document, or null when there is none yet; cb is also told about errors (view null, err).
export function watchMyView(me, cb, { force = false } = {}) {
  let unsub = null;
  const listen = () => {
    if (unsub) return;
    unsub = onSnapshot(doc(db, 'agentViews', me.tenantId + '__' + me.uid), s => cb(s.exists() ? s.data() : null, null),
      err => { unsub = null; if (!isShutdown(err)) cb(null, err); });
  };
  const refresh = (f) => api('view', { force: !!f }).then(() => { listen(); }).catch(e => { listen(); if (!unsub) cb(null, e); });
  refresh(force);
  // Coming back to the page after a while: ask again (the server rebuilds only when it is due).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(false); });
  return { refresh: () => refresh(true), stop: () => unsub && unsub() };
}

// ── Times ──
const pad = n => String(n).padStart(2, '0');
export function when(t, now = Date.now()) {
  if (!t) return '';
  const d = new Date(t), today = new Date(now);
  const sameDay = d.toDateString() === today.toDateString();
  const yest = new Date(now - 86400000).toDateString() === d.toDateString();
  const tom = new Date(now + 86400000).toDateString() === d.toDateString();
  const time = `${d.getHours() % 12 || 12}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  if (sameDay) return 'today ' + time;
  if (yest) return 'yesterday ' + time;
  if (tom) return 'tomorrow ' + time;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) }) + ', ' + time;
}
export function ago(t, now = Date.now()) {
  if (!t) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return when(t, now);
}
export function untilWords(t, now = Date.now()) {
  if (!t) return 'no time limit';
  const h = (t - now) / 3600000;
  if (h <= 0) return 'ended';
  if (h < 1) return 'ends in ' + Math.max(1, Math.round(h * 60)) + ' min';
  if (h < 48) return 'ends in ' + Math.round(h) + ' h';
  return 'until ' + new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// ── Toast ──
let toastT = null;
export function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.hidden = true; }, 3200);
}

// ── Bottom sheet ──
// openSheet(html, { onOpen(root, close), locked }) — Escape and the scrim close it unless locked.
let sheetClose = null;
export function openSheet(html, { onOpen, locked = false, label = '' } = {}) {
  if (sheetClose) sheetClose();
  const scrim = document.createElement('div'); scrim.className = 'scrim';
  const sh = document.createElement('div'); sh.className = 'sheet'; sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true');
  if (label) sh.setAttribute('aria-label', label);
  sh.innerHTML = '<div class="grip"></div>' + html;
  document.body.append(scrim, sh);
  const before = document.activeElement;
  const close = () => {
    scrim.remove(); sh.remove(); document.removeEventListener('keydown', onKey);
    if (sheetClose === close) sheetClose = null;
    if (before && before.focus) try { before.focus(); } catch (e) { /* gone */ }
  };
  const onKey = e => { if (e.key === 'Escape' && !locked) close(); };
  document.addEventListener('keydown', onKey);
  if (!locked) scrim.addEventListener('click', close);
  sheetClose = close;
  sh.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  const first = sh.querySelector('textarea, input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select, button:not([data-close])');
  if (first && window.matchMedia('(min-width: 640px)').matches) first.focus();
  if (onOpen) onOpen(sh, close);
  return close;
}
export const closeSheet = () => { if (sheetClose) sheetClose(); };

// A button that shows it is working and cannot be pressed twice.
export async function busy(btn, run) {
  if (!btn || btn.disabled) return;
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + btn.textContent.trim();
  try { return await run(); } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
}

// ── The approve sheet (My Day, Messages, the property page) ──
// The decision on one access request, first decision wins (the server's transaction). opts: { req,
// canCoAgent, defaults: { days, shareContact, hours } } → resolves true when a decision was saved.
export function decideSheet(req, { canCoAgent = false, defaults = {} } = {}) {
  return new Promise(resolve => {
    const isLead = req.kind === 'lead';
    const days = defaults.days == null ? '' : String(defaults.days);
    const hours = String(defaults.hours || 24);
    let done = false;
    openSheet(`
      <h3>${esc(req.requesterName)} asks for ${isLead ? 'this lead’s details' : esc(req.title)}</h3>
      <p class="sub">${req.clientName ? 'For their client ' + esc(req.clientName) + ' · ' : ''}asked ${esc(ago(req.createdAt))}${req.visitAt ? ' · wants a visit ' + esc(when(req.visitAt)) : ''}</p>
      ${req.reason ? `<div class="callout">“${esc(req.reason)}”</div>` : ''}
      <div class="seg" role="tablist" style="margin-top:6px">
        <button type="button" role="tab" data-d="approve" aria-selected="true">Approve</button>
        <button type="button" role="tab" data-d="reject" aria-selected="false">Reject</button>
      </div>
      <div id="dApprove">
        ${!isLead && canCoAgent ? `<label class="toggle"><span><b>Make them a co-agent</b><small>A lasting collaboration: they see this property as you do, with no timer</small></span><input type="checkbox" id="dCo"></label>` : ''}
        <div id="dTimers">
          <div class="field"><label>${isLead ? 'Lead details for' : 'Property details for'}</label>
            <div class="pick" id="dDays">
              ${[['', 'No limit'], ['1', '1 day'], ['3', '3 days'], ['7', '7 days'], ['custom', 'Pick a date']].map(([v, l]) => `<label><input type="radio" name="dDays" value="${v}"${v === days ? ' checked' : ''}> ${l}</label>`).join('')}
            </div>
            <input type="datetime-local" id="dUntil" hidden aria-label="Details until">
          </div>
          ${isLead ? '' : `<label class="toggle"><span><b>Share the owner’s number</b><small>Off unless you switch it on; it has its own timer</small></span><input type="checkbox" id="dShare"${defaults.shareContact ? ' checked' : ''}></label>
          <div class="field" id="dHoursF"${defaults.shareContact ? '' : ' hidden'}><label>Owner’s number for</label>
            <div class="pick">${[['2', '2 hours'], ['24', '24 hours'], ['72', '3 days'], ['custom', 'Pick a time']].map(([v, l]) => `<label><input type="radio" name="dHours" value="${v}"${v === hours ? ' checked' : ''}> ${l}</label>`).join('')}</div>
            <input type="datetime-local" id="dCUntil" hidden aria-label="Owner’s number until">
          </div>`}
        </div>
      </div>
      <div class="field"><label for="dNote" id="dNoteL">Note (optional)</label><textarea id="dNote" maxlength="500" placeholder="Anything they should know"></textarea></div>
      <p class="err" id="dErr"></p>
      <div class="bar"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary block" id="dGo">Approve</button></div>`,
    { label: 'Decide the request', onOpen: (sh, close) => {
      let mode = 'approve';
      const q = s => sh.querySelector(s);
      sh.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => {
        mode = b.dataset.d;
        sh.querySelectorAll('[data-d]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
        q('#dApprove').hidden = mode !== 'approve';
        q('#dNoteL').textContent = mode === 'reject' ? 'Why (the agent sees this)' : 'Note (optional)';
        q('#dGo').textContent = mode === 'reject' ? 'Reject' : 'Approve';
        q('#dGo').classList.toggle('danger', mode === 'reject');
      }));
      const syncCustom = () => {
        const d = sh.querySelector('input[name=dDays]:checked');
        q('#dUntil').hidden = !(d && d.value === 'custom');
        const h = sh.querySelector('input[name=dHours]:checked');
        if (q('#dCUntil')) q('#dCUntil').hidden = !(h && h.value === 'custom');
      };
      sh.querySelectorAll('input[name=dDays], input[name=dHours]').forEach(i => i.addEventListener('change', syncCustom));
      if (q('#dShare')) q('#dShare').addEventListener('change', () => { q('#dHoursF').hidden = !q('#dShare').checked; });
      if (q('#dCo')) q('#dCo').addEventListener('change', () => { q('#dTimers').hidden = q('#dCo').checked; });
      q('#dGo').addEventListener('click', () => busy(q('#dGo'), async () => {
        q('#dErr').textContent = '';
        const note = q('#dNote').value.trim();
        const body = { id: req.id, decision: mode, note };
        if (mode === 'approve') {
          if (q('#dCo') && q('#dCo').checked) body.coAgent = true;
          else {
            const d = sh.querySelector('input[name=dDays]:checked');
            if (d && d.value === 'custom') { const t = Date.parse(q('#dUntil').value); if (!t) { q('#dErr').textContent = 'Pick the date the details stop'; return; } body.until = t; }
            else if (d && d.value) body.days = Number(d.value);
            if (q('#dShare') && q('#dShare').checked) {
              body.shareContact = true;
              const h = sh.querySelector('input[name=dHours]:checked');
              if (h && h.value === 'custom') { const t = Date.parse(q('#dCUntil').value); if (!t) { q('#dErr').textContent = 'Pick when the number stops'; return; } body.contactUntil = t; }
              else body.hours = Number((h && h.value) || 24);
            }
          }
        } else if (!note) { q('#dErr').textContent = 'Say why — the agent sees it'; q('#dNote').focus(); return; }
        try {
          await api('decide', body);
          done = true;
          toast(mode === 'approve' ? 'Approved — they can see it now' : 'Rejected — they’ve been told');
          close();
        } catch (e) {
          q('#dErr').textContent = e.message;
          if (e.status === 409) setTimeout(close, 1800);
        }
      }));
    } });
    const iv = setInterval(() => { if (!document.querySelector('#dGo')) { clearInterval(iv); resolve(done); } }, 200);
  });
}

// ── An agent's own leads (the three queries the rules allow), read once — for pickers ──
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
export async function myLeads(me) {
  const col = collection(db, 'leads');
  const qs = [
    query(col, where('tenantId', '==', me.tenantId), where('assignedAgent', '==', me.email)),
    query(col, where('tenantId', '==', me.tenantId), where('secondaryAgent', '==', me.email)),
    query(col, where('tenantId', '==', me.tenantId), where('agentAccess', 'array-contains', me.email)),
  ];
  const snaps = await Promise.all(qs.map(q => getDocs(q).catch(() => null)));
  const by = new Map();
  snaps.forEach(s => s && s.docs.forEach(d => by.set(d.id, { ...d.data(), id: d.id })));
  return [...by.values()];
}
