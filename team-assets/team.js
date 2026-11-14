// ═══════ TEAM & ACCESS (team.html) — admins only ═══════
//
// People: every login on the tenant grouped by role (admin / agent / full access), plus accounts
//         waiting for approval. Roles, active, name, WhatsApp, team lists, reset password, add and
//         approve go through /api/agent (api/_agent.js): roles are custom claims and only the server
//         may write them.
// What agents see: agentConfigs/{tenant}, written straight to Firestore (the rules let only an admin
//         write it, and only known settings). The model and defaults are shared-assets/agent-config.js.
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import { getFirestore, doc, getDoc, runTransaction } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import * as AC from '../shared-assets/agent-config.js';

const firebaseConfig = {
  apiKey: "AIzaSyCO5782HKI_ka5zx0tSBzohlvNB5rY_ZF0",
  authDomain: "pin-realty.firebaseapp.com",
  projectId: "pin-realty",
  storageBucket: "pin-realty.firebasestorage.app",
  messagingSenderId: "570586680667",
  appId: "1:570586680667:web:859a61bf99fe1824725e7e"
};
const SIGN_IN_URL = 'https://admin.threepin.in';

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// An agent who opens this page is shown access.js's note instead; nothing below may run on it.
if ($('app')) start();

function start() {
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const ROLE_LABEL = { admin: 'Admin', agent: 'Agent', none: 'Full access' };
const ROLE_NOTE = {
  admin: 'Sees everything and decides who sees what.',
  agent: 'Sees their own properties and leads in full, and a summary of the rest. You choose the details in “What agents see”.',
  none: 'Staff: sees all properties and leads, owner numbers included, and can set a property’s agents. Can’t change roles or what agents see.',
};

let me = null;         // { uid, email, tenantId }
let people = [];       // from /api/agent team
let pending = [];
let listOnly = [];
let stored = null;     // agentConfigs/{tenant} as last read or saved
let draft = null;      // the settings being edited (full shape) for `forWho`
let forWho = '';       // '' = all agents (common settings), else an agent's email
let dirty = false;
let saving = false;

window.AppNav.boot({ console: 'team', select: () => {}, signOut: () => signOut(auth).then(() => location.assign('index.html')) });
window.AppNav.setActive('team');

// ── Server calls ──
async function api(action, body = {}) {
  const token = await auth.currentUser.getIdToken();
  const r = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

const displayOf = p => p.name || p.email;
const firstName = p => (p.name ? p.name.split(' ')[0] : p.email.split('@')[0]);

// ── Sign-in gate ──
onAuthStateChanged(auth, async user => {
  if (window.__pinGated || !$('app')) return;
  if (!user) { location.assign('index.html'); return; }
  window.AppNav.setUser(user.email || '');
  const res = await user.getIdTokenResult(true);
  if (res.claims.role !== 'admin' || !res.claims.tenantId) {
    $('boot').hidden = true;
    $('denied').hidden = false;
    return;
  }
  me = { uid: user.uid, email: (user.email || '').toLowerCase(), tenantId: res.claims.tenantId };
  try {
    await Promise.all([loadPeople(), loadSettings()]);
  } catch (e) {
    $('boot').innerHTML = '<p class="note">Couldn’t load the team: ' + esc(e.message) + '. Reload to try again.</p>';
    return;
  }
  $('boot').hidden = true;
  $('app').hidden = false;
});

// ── Tabs ──
function showTab(name) {
  document.querySelectorAll('#app > .seg button[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x.dataset.tab === name)));
  $('tab-people').hidden = name !== 'people';
  $('tab-agents').hidden = name !== 'agents';
  $('tab-requests').hidden = name !== 'requests';
  if (name === 'requests') document.dispatchEvent(new CustomEvent('team-requests-open'));
  setDirty(dirty);
}
document.querySelectorAll('#app > .seg button[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
{ const t = new URLSearchParams(location.search).get('tab'); if (['requests', 'agents', 'people'].includes(t)) showTab(t); }

// ═══════ PEOPLE ═══════

async function loadPeople() {
  const data = await api('team');
  people = data.users || [];
  pending = data.pending || [];
  listOnly = data.listOnly || [];
  renderPeople();
  renderForWho();
}

function ago(ms) {
  if (!ms) return 'never signed in';
  const d = Math.floor((Date.now() - ms) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 60) return d + 'd ago';
  return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function rowHtml(p) {
  const initial = displayOf(p).charAt(0).toUpperCase();
  const bits = [];
  if (p.name) bits.push(esc(p.email));
  bits.push(esc(ago(p.lastLogin)));
  if (!p.teamList) bits.push('not in team lists');
  return '<li class="row" data-uid="' + esc(p.uid) + '" role="button" tabindex="0">'
    + '<span class="av">' + esc(initial) + '</span>'
    + '<span class="who"><b>' + esc(displayOf(p)) + (p.self ? ' (you)' : '') + '</b><small>' + bits.join(' · ') + '</small></span>'
    + (p.active ? '' : '<span class="pill off">Off</span>')
    + '<span class="pill ' + esc(p.role) + '">' + esc(ROLE_LABEL[p.role] || p.role) + '</span>'
    + '</li>';
}

function renderPeople() {
  // Waiting for approval
  $('pendingWrap').innerHTML = pending.length
    ? '<h2 class="group-h wide">Waiting for approval <small>Signed up on their own. They see nothing until you let them in.</small></h2>'
      + '<div class="card pending"><ul class="list">' + pending.map(p =>
        '<li class="row" data-pending="' + esc(p.uid) + '" role="button" tabindex="0">'
        + '<span class="av">' + esc(p.email.charAt(0).toUpperCase()) + '</span>'
        + '<span class="who"><b>' + esc(p.email) + '</b><small>'
        + 'via ' + esc((p.via || []).join(', ') || 'email') + (p.verified ? '' : ' · email not confirmed') + (p.created ? ' · ' + esc(ago(p.created)) : '') + '</small></span>'
        + '<span class="pill wait">Waiting</span></li>').join('') + '</ul></div>'
    : '';
  // Grouped by role
  const groups = [['admin', 'Admins'], ['agent', 'Agents'], ['none', 'Full access (staff)']];
  $('people').innerHTML = groups.map(([role, title]) => {
    const list = people.filter(p => p.role === role).sort((a, b) => displayOf(a).localeCompare(displayOf(b)));
    if (!list.length && role !== 'agent') return '';
    return '<h2 class="group-h">' + title + ' <small>' + list.length + '</small></h2><div class="card"><ul class="list">'
      + (list.length ? list.map(rowHtml).join('') : '<li class="listonly">No agents yet. Add one with “Add a person”.</li>')
      + '</ul></div>';
  }).join('')
    + (listOnly.length ? '<p class="aside">In team lists but can’t sign in: ' + listOnly.map(esc).join(', ') + '</p>' : '');

  const wire = (el, fn) => {
    el.addEventListener('click', fn);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
  };
  document.querySelectorAll('#people .row').forEach(r => wire(r, () => personSheet(people.find(p => p.uid === r.dataset.uid))));
  document.querySelectorAll('#pendingWrap .row').forEach(r => wire(r, () => pendingSheet(pending.find(p => p.uid === r.dataset.pending))));
}

// ── Bottom sheet ──
let closeSheet = null;
function sheet(html, onMount) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const host = $('sheetHost');
  host.innerHTML = '<div class="scrim"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grip"></div>' + html + '</div>';
  // A sheet showing a one-time password closes only with its Done button: Escape, a tap outside or
  // Back would throw away a password that can't be shown again.
  const locked = () => { const sh = host.querySelector('.sheet'); return !!(sh && sh.dataset.locked); };
  const close = (force) => {
    if (!host.innerHTML) return;
    if (locked() && force !== true) { toast('Copy or send the password first, then tap Done'); return; }
    host.innerHTML = '';
    closeSheet = null;
    if (window.AppNav.closeLayer) window.AppNav.closeLayer('team-sheet');
  };
  closeSheet = close;
  host.querySelector('.scrim').addEventListener('click', close);
  host.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  const onBack = () => {
    if (locked()) {   // Back was pressed: keep the sheet and its history entry
      toast('Copy or send the password first, then tap Done');
      if (window.AppNav.openLayer) window.AppNav.openLayer('team-sheet', onBack);
      return;
    }
    host.innerHTML = ''; closeSheet = null;
  };
  if (window.AppNav.openLayer) window.AppNav.openLayer('team-sheet', onBack);
  const el = host.querySelector('.sheet');
  onMount && onMount(el, close);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && closeSheet) closeSheet(); });

function roleChoices(name, current, only) {
  return '<div class="choices">' + (only || ['agent', 'admin', 'none']).map(r =>
    '<label><input type="radio" name="' + name + '" value="' + r + '"' + (r === current ? ' checked' : '') + '>'
    + '<span><b>' + ROLE_LABEL[r] + (r === 'none' ? ' (staff)' : '') + '</b><small>' + esc(ROLE_NOTE[r]) + '</small></span></label>').join('') + '</div>';
}

// What saving a role change will do, said before Save.
function consequence(from, to, who) {
  if (from === to) return '';
  if (to === 'agent') return who + ' will be signed out, and from then on sees only what “What agents see” allows.';
  if (from === 'admin') return who + ' will be signed out and can no longer change who sees what.';
  if (to === 'admin') return who + ' will be able to see everything and change who sees what.';
  return who + ' will see all properties and leads, owner numbers included.';
}

// Send someone their sign-in: on WhatsApp (to their number if we have it) or copied.
function loginMessage(email, password) {
  return 'Your 3 PIN Realty login\n' + SIGN_IN_URL + '\nEmail: ' + email
    + (password ? '\nPassword: ' + password + '\n(or tap “Continue with Google”)' : '\nTap “Continue with Google” to sign in.');
}
function waLink(phone, text) { return 'https://wa.me/' + (phone || '') + '?text=' + encodeURIComponent(text); }

function credentialsPanel(el, close, { email, password, phone, title, agent }) {
  const msg = loginMessage(email, password);
  if (password) el.dataset.locked = '1';
  el.innerHTML = '<div class="grip"></div><h3>' + esc(title) + '</h3>'
    + (password
      ? '<p class="sub">Send this password now. It isn’t saved anywhere and won’t be shown again.</p><div class="pw" id="pwBox">' + esc(password) + '</div>'
      : '<p class="sub">They sign in with “Continue with Google”. No password needed.</p>')
    + '<div class="stack">'
    + '<a class="btn wa block" target="_blank" rel="noopener" href="' + esc(waLink(phone, msg)) + '"><i class="fa-brands fa-whatsapp"></i> Send login on WhatsApp</a>'
    + '<button type="button" class="btn block" id="cpBtn"><i class="fa-regular fa-copy"></i> Copy login message</button>'
    + (agent ? '<button type="button" class="btn block" id="custBtn">Customise what they see</button>' : '')
    + '<button type="button" class="btn primary block" data-close>Done</button></div>';
  el.querySelector('[data-close]').addEventListener('click', () => close(true));
  el.querySelector('#cpBtn').addEventListener('click', () => navigator.clipboard.writeText(msg).then(() => toast('Copied')).catch(() => toast('Copy didn’t work — select the password')));
  const cust = el.querySelector('#custBtn');
  if (cust) cust.addEventListener('click', () => { close(true); openSettingsFor(email); });
}

function personSheet(p) {
  if (!p) return;
  const isAgent = p.role === 'agent';
  sheet(
    '<h3>' + esc(displayOf(p)) + (p.self ? ' (you)' : '') + '</h3><p class="sub">' + (p.name ? esc(p.email) : '') + '</p>'
    + '<div class="two"><div class="field"><label for="pName">Name</label><input type="text" id="pName" value="' + esc(p.name) + '" autocomplete="off" placeholder="e.g. Rameez Khan"></div>'
    + '<div class="field"><label for="pPhone">WhatsApp number</label><input type="tel" id="pPhone" inputmode="tel" value="' + esc(p.phone ? p.phone.replace(/^91/, '') : '') + '" placeholder="10-digit mobile"></div></div>'
    + (p.self
      ? '<div class="callout">You’re ' + (p.role === 'admin' ? 'an Admin' : ROLE_LABEL[p.role]) + '. Another admin can change your role or turn your account off.</div>'
      : roleChoices('role', p.role) + '<div class="callout warn" id="pConseq" hidden></div>'
        + '<label class="toggle"><span>Account active<small>Off = they’re signed out within an hour and can’t sign in</small></span><input type="checkbox" id="pActive"' + (p.active ? ' checked' : '') + '></label>')
    + '<label class="toggle"><span>Show in team lists<small>Can be @mentioned, gets a Team calendar column, can be picked for site visits</small></span><input type="checkbox" id="pList"' + (p.teamList ? ' checked' : '') + '></label>'
    + (p.self ? '' : '<div class="stack">' + (isAgent ? '<button type="button" class="btn block" id="pCust"><i class="fa-solid fa-sliders"></i> Customise what they see</button>' : '')
      + (p.role === 'admin' ? '<p class="aside">Admins sign in with “Continue with Google”, so no password reset is needed.</p>' : '<button type="button" class="btn block" id="pReset"><i class="fa-solid fa-key"></i> Reset password</button>') + '</div>')
    + '<p class="err" id="pErr"></p>'
    + '<div class="bar"><button type="button" class="btn block" data-close>Cancel</button><button type="button" class="btn primary block" id="pSave">Save</button></div>',
    (el, close) => {
      const conseq = el.querySelector('#pConseq');
      el.querySelectorAll('input[name="role"]').forEach(i => i.addEventListener('change', () => {
        const text = consequence(p.role, i.value, firstName(p));
        conseq.textContent = text; conseq.hidden = !text;
      }));
      const cust = el.querySelector('#pCust');
      if (cust) cust.addEventListener('click', () => { close(); openSettingsFor(p.email); });
      const reset = el.querySelector('#pReset');
      if (reset) reset.addEventListener('click', async () => {
        if (!confirm('Give ' + displayOf(p) + ' a new password? They’ll be signed out everywhere.')) return;
        reset.disabled = true;
        try {
          const r = await api('reset-password', { uid: p.uid });
          credentialsPanel(el, close, { email: p.email, password: r.password, phone: p.phone, title: 'New password for ' + displayOf(p) });
        } catch (e) { el.querySelector('#pErr').textContent = e.message; reset.disabled = false; }
      });
      el.querySelector('#pSave').addEventListener('click', async () => {
        const btn = el.querySelector('#pSave');
        const err = el.querySelector('#pErr');
        const role = p.self ? p.role : ((el.querySelector('input[name="role"]:checked') || {}).value || p.role);
        const active = p.self ? p.active : el.querySelector('#pActive').checked;
        const list = el.querySelector('#pList').checked;
        const name = el.querySelector('#pName').value.trim();
        const phone = el.querySelector('#pPhone').value.trim();
        btn.disabled = true; err.textContent = '';
        try {
          // One step at a time; each that succeeds is recorded on `p`, so a retry repeats nothing.
          if (name !== p.name || phone.replace(/\D/g, '') !== String(p.phone || '').replace(/^91/, '')) {
            const r = await api('set-profile', { uid: p.uid, name, phone });
            p.name = r.name; p.phone = r.phone;
          }
          if (role !== p.role) { await api('set-role', { uid: p.uid, role }); p.role = role; }
          if (active !== p.active) { await api('set-active', { uid: p.uid, active }); p.active = active; }
          if (list !== p.teamList) { await api('team-list', { email: p.email, on: list }); p.teamList = list; }
          close();
          toast('Saved');
          await loadPeople();
        } catch (e) {
          err.textContent = e.message;
          btn.disabled = false;
          loadPeople().catch(() => {});
        }
      });
    });
}

function pendingSheet(p) {
  if (!p) return;
  const google = (p.via || []).includes('Google');
  sheet(
    '<h3>' + esc(p.email) + '</h3><p class="sub">Signed up via ' + esc((p.via || []).join(', ') || 'email')
    + (p.verified ? '' : ' · email not confirmed') + (p.nameGiven ? ' · calls themselves “' + esc(p.nameGiven) + '”' : '') + '</p>'
    + '<div class="callout warn">They see nothing yet. Let them in only if you know this email is theirs.'
    + (google ? '' : ' The password they chose is replaced: you’ll get a one-time password to send them.') + '</div>'
    + roleChoices('arole', 'agent', ['agent', 'none'])
    + '<p class="aside">Need them as an admin? Let them in first, then change their role.</p>'
    + '<label class="toggle"><span>Show in team lists<small>Only for a real person’s mailbox</small></span><input type="checkbox" id="aList"></label>'
    + '<p class="err" id="aErr"></p>'
    + '<div class="bar"><button type="button" class="btn danger block" id="aDismiss">Remove request</button><button type="button" class="btn primary block" id="aOk">Let them in</button></div>',
    (el, close) => {
      el.querySelector('#aOk').addEventListener('click', async () => {
        const btn = el.querySelector('#aOk');
        btn.disabled = true;
        try {
          const role = (el.querySelector('input[name="arole"]:checked') || {}).value || 'agent';
          const r = await api('approve', { uid: p.uid, role, teamList: el.querySelector('#aList').checked });
          await loadPeople();
          if (r.password) credentialsPanel(el, close, { email: r.email, password: r.password, phone: '', agent: role === 'agent', title: r.email + ' is in as ' + ROLE_LABEL[role] });
          else { close(); toast(p.email + ' is in as ' + ROLE_LABEL[role]); }
        } catch (e) { el.querySelector('#aErr').textContent = e.message; btn.disabled = false; }
      });
      el.querySelector('#aDismiss').addEventListener('click', async () => {
        if (!confirm('Remove the sign-up for ' + p.email + '? They can sign up again.')) return;
        try { await api('dismiss', { uid: p.uid }); close(); toast('Removed'); await loadPeople(); }
        catch (e) { el.querySelector('#aErr').textContent = e.message; }
      });
    });
}

$('addBtn').addEventListener('click', () => {
  sheet(
    '<h3>Add a person</h3><p class="sub">They’ll sign in with this email: Google, or the password shown next.</p>'
    + '<div class="field"><label for="nEmail">Email</label><input type="email" id="nEmail" autocomplete="off" placeholder="name@threepin.in"></div>'
    + '<div class="two"><div class="field"><label for="nName">Name</label><input type="text" id="nName" autocomplete="off" placeholder="e.g. Rameez Khan"></div>'
    + '<div class="field"><label for="nPhone">WhatsApp number</label><input type="tel" id="nPhone" inputmode="tel" placeholder="10-digit mobile"></div></div>'
    + roleChoices('nrole', 'agent')
    + '<label class="toggle"><span>Show in team lists<small>Turn off for shared logins like sales@ that aren’t one person</small></span><input type="checkbox" id="nList" checked></label>'
    + '<p class="err" id="nErr"></p>'
    + '<div class="bar"><button type="button" class="btn block" data-close>Cancel</button><button type="button" class="btn primary block" id="nSave">Add</button></div>',
    (el, close) => {
      el.querySelector('#nEmail').focus();
      el.querySelector('#nSave').addEventListener('click', async () => {
        const btn = el.querySelector('#nSave');
        const err = el.querySelector('#nErr');
        btn.disabled = true; err.textContent = '';
        try {
          const role = (el.querySelector('input[name="nrole"]:checked') || {}).value || 'agent';
          const r = await api('add-user', {
            email: el.querySelector('#nEmail').value, role,
            name: el.querySelector('#nName').value, phone: el.querySelector('#nPhone').value,
            teamList: el.querySelector('#nList').checked,
          });
          await loadPeople();
          credentialsPanel(el, close, { email: r.email, password: r.password, phone: r.phone, agent: role === 'agent',
            title: (r.name || r.email) + ' is added as ' + ROLE_LABEL[role] });
        } catch (e) { err.textContent = e.message; btn.disabled = false; }
      });
    });
});

// ═══════ WHAT AGENTS SEE ═══════

const settingsRef = () => doc(db, 'agentConfigs', me.tenantId);

async function loadSettings() {
  const snap = await getDoc(settingsRef());
  stored = snap.exists() ? snap.data() : null;
  pickWho('');
}

function agents() { return people.filter(p => p.role === 'agent'); }
function hasOverride(email) { return !!(stored && stored.overrides && stored.overrides[email]); }

function renderForWho() {
  const list = agents();
  $('forWho').innerHTML = '<option value="">All agents (common settings)</option>'
    + list.map(p => '<option value="' + esc(p.email.toLowerCase()) + '">' + esc(displayOf(p)) + (hasOverride(p.email.toLowerCase()) ? ' · own settings' : '') + '</option>').join('');
  // The agent being edited is no longer an agent: back to the common settings, not a silent
  // override for someone it no longer applies to.
  if (forWho && !list.some(p => p.email.toLowerCase() === forWho)) { pickWho(''); return; }
  $('forWho').value = forWho;
}

function openSettingsFor(email) {
  showTab('agents');
  const key = String(email || '').toLowerCase();
  if (dirty && !confirm('Discard your unsaved changes?')) return;
  pickWho(key);
  $('forWho').value = key;
  window.scrollTo(0, 0);
}

function pickWho(who) {
  forWho = who;
  draft = AC.effectiveConfig(stored, who || null);
  const p = people.find(x => x.email.toLowerCase() === who);
  $('forState').textContent = !who ? 'Applies to every agent without their own settings'
    : hasOverride(who) ? 'Own settings for this agent' : 'Same as the common settings until you change something';
  $('banner').innerHTML = who
    ? '<div class="banner"><b>Editing ' + esc(p ? displayOf(p) : who) + ' only</b>'
      + (hasOverride(who) ? '<button type="button" class="btn sm" id="resetBtn">Reset to common settings</button>' : '')
      + '<button type="button" class="btn sm" id="backBtn">All agents</button></div>'
    : '';
  const back = $('backBtn');
  if (back) back.addEventListener('click', () => { if (!dirty || confirm('Discard your unsaved changes?')) { pickWho(''); $('forWho').value = ''; } });
  const reset = $('resetBtn');
  if (reset) reset.addEventListener('click', () => {
    if (!confirm('Use the common settings for ' + (p ? displayOf(p) : who) + '?')) return;
    const overrides = { ...((stored && stored.overrides) || {}) };
    delete overrides[who];
    save(AC.effectiveConfig(stored, null), overrides);
  });
  setDirty(false);
  renderSettings();
}

$('forWho').addEventListener('change', e => {
  if (dirty && !confirm('Discard your unsaved changes?')) { e.target.value = forWho; return; }
  pickWho(e.target.value);
});

function setDirty(on) {
  dirty = on;
  $('savebar').hidden = !on || $('tab-agents').hidden;
  $('saveMsg').textContent = forWho ? 'Unsaved changes for ' + forWho.split('@')[0] : 'Unsaved changes for all agents';
}

$('discardBtn').addEventListener('click', () => pickWho(forWho));

// The common settings, to mark what an agent's own settings change.
const common = () => AC.effectiveConfig(stored, null);

function laterTag(live) { return live ? '' : '<span class="later">Later update</span>'; }

function summary(key, catalogue) {
  const on = draft[key] || [];
  if (!on.length) return 'Nothing';
  if (on.length === catalogue.length) return 'Everything';
  const names = catalogue.filter(c => on.includes(c.id)).map(c => c.label.replace(/ \(.*\)$/, ''));
  return names.length <= 3 ? names.join(', ') : names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' more';
}

function checks(key, catalogue) {
  const on = new Set(draft[key] || []);
  const base = forWho ? new Set(common()[key] || []) : null;
  return '<div class="checks">' + catalogue.map(item => {
    const diff = base && base.has(item.id) !== on.has(item.id);
    return '<label class="chk' + (diff ? ' diff' : '') + '"><input type="checkbox" data-key="' + key + '" value="' + esc(item.id) + '"'
      + (on.has(item.id) ? ' checked' : '') + '><span class="lb"><span class="nm">' + esc(item.label) + '</span>' + (item.note ? '<small>' + esc(item.note) + '</small>' : '') + '</span>'
      + (item.risk ? '<span class="warn">' + esc(item.risk) + '</span>' : '') + '</label>';
  }).join('') + '</div>';
}

function fold(key, title, help, catalogue, live, open = false, extra = '') {
  return '<details class="sec"' + (open ? ' open' : '') + ' data-fold="' + key + '">'
    + '<summary><span class="st"><b>' + esc(title) + ' ' + laterTag(live) + '</b><small data-sum="' + key + '">' + esc(summary(key, catalogue)) + '</small></span>'
    + '<i class="fa-solid fa-chevron-down" aria-hidden="true"></i></summary>'
    + '<div class="body"><p>' + help + '</p>'
    + (catalogue.length > 5 ? '<div class="quick"><button type="button" class="btn sm" data-all="' + key + '">Tick all</button><button type="button" class="btn sm" data-none="' + key + '">Clear</button></div>' : '')
    + checks(key, catalogue) + extra + '</div></details>';
}

const READY_TABS = AC.TABS.filter(t => t.status === 'ready');
const GRANTED = AC.PROPERTY_FIELDS.filter(f => f.id !== 'contact');
const CAT = { tabs: READY_TABS, otherPropertyFields: AC.PROPERTY_FIELDS, ownPropertyFields: AC.PROPERTY_FIELDS, grantedPropertyFields: GRANTED, matchingLeadFields: AC.LEAD_FIELDS };

function actionsSummary() {
  const on = AC.ACTIONS.filter(a => draft.actions[a.id]);
  return !on.length ? 'Nothing' : on.length === AC.ACTIONS.length ? 'Everything' : on.length + ' of ' + AC.ACTIONS.length;
}
function scopeSummary() {
  const s = v => (v === 'all' ? 'all properties' : 'their properties');
  return 'Ads: ' + s(draft.adsScope) + ' · Campaigns: ' + s(draft.campaignsScope);
}
function approvalsSummary() {
  return (AC.APPROVERS.find(a => a.id === draft.approvals.approvers) || {}).label || '';
}

function renderSettings() {
  const a = draft.approvals;
  const later = AC.TABS.filter(t => t.status === 'later').map(t => t.label).join(', ');
  const never = AC.TABS.filter(t => t.status === 'never').map(t => t.label).join(', ');
  const timer = v => v === null ? 'No limit' : v + (v === 1 ? ' day' : ' days');
  const hours = v => v < 24 ? v + ' hours' : (v / 24) + (v === 24 ? ' day' : ' days');
  const radio = (name, value, current, label, note) => '<label><input type="radio" name="' + name + '" value="' + value + '"' + (current === value ? ' checked' : '') + '>'
    + '<span><b>' + esc(label) + '</b>' + (note ? '<small>' + esc(note) + '</small>' : '') + '</span></label>';
  const changed = key => forWho && JSON.stringify(common()[key]) !== JSON.stringify(draft[key]) ? ' <span class="later">changed</span>' : '';

  $('settings').innerHTML =
    fold('tabs', 'Menu', 'What appears in an agent’s menu.', READY_TABS, AC.LIVE.tabs, true,
      '<p class="aside">Coming later: ' + esc(later) + '<br>Not for agents: ' + esc(never) + '</p>')
    + fold('otherPropertyFields', 'Properties not assigned to them', 'A summary of everyone else’s listings, with a lock and a “Request details” button.', AC.PROPERTY_FIELDS, AC.LIVE.fields)
    + fold('ownPropertyFields', 'Properties assigned to them', 'Where they are the primary agent or a co-agent.', AC.PROPERTY_FIELDS, AC.LIVE.fields)
    + fold('grantedPropertyFields', 'When a request is approved', 'A property someone approved for them. The owner’s number is shared only if the approver switches it on, with a timer.', GRANTED, AC.LIVE.fields)
    + fold('matchingLeadFields', 'Buyers and tenants matching their properties', 'Leads that suit their listings but aren’t their own. Phone numbers inside summaries are always hidden.', AC.LEAD_FIELDS, AC.LIVE.fields)
    + '<details class="sec" data-fold="actions"><summary><span class="st"><b>What agents can do ' + laterTag(AC.LIVE.actions) + changed('actions') + '</b><small data-sum="actions">' + esc(actionsSummary()) + '</small></span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></summary>'
    + '<div class="body"><div class="checks">' + AC.ACTIONS.map(x => '<label class="chk"><input type="checkbox" data-action="' + x.id + '"' + (draft.actions[x.id] ? ' checked' : '') + '><span class="lb">' + esc(x.label) + '<small>' + esc(x.note) + '</small></span></label>').join('') + '</div></div></details>'
    + '<details class="sec" data-fold="scopes"><summary><span class="st"><b>Ads and campaigns ' + laterTag(AC.LIVE.scopes) + '</b><small data-sum="scopes">' + esc(scopeSummary()) + '</small></span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></summary>'
    + '<div class="body"><div class="field"><label>Meta Ads Leads</label><div class="choices">'
    + radio('adsScope', 'own', draft.adsScope, 'Only their properties') + radio('adsScope', 'all', draft.adsScope, 'All properties', 'Includes every ad lead’s phone number') + '</div></div>'
    + '<div class="field"><label>WhatsApp Campaigns</label><div class="choices">'
    + radio('campaignsScope', 'own', draft.campaignsScope, 'Only their properties') + radio('campaignsScope', 'all', draft.campaignsScope, 'All properties', 'Includes every campaign’s leads') + '</div></div></div></details>'
    + '<details class="sec" data-fold="approvals"><summary><span class="st"><b>Approvals ' + laterTag(AC.LIVE.approvals) + changed('approvals') + '</b><small data-sum="approvals">' + esc(approvalsSummary()) + '</small></span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></summary>'
    + '<div class="body"><div class="field"><label>Who can approve a request to see a property</label><div class="choices">'
    + AC.APPROVERS.map(x => radio('approvers', x.id, a.approvers, x.label)).join('') + '</div></div>'
    + '<div class="field"><label for="aDays">Approved access lasts (default)</label><select id="aDays">'
    + AC.DETAIL_TIMERS.map(v => '<option value="' + (v === null ? '' : v) + '"' + (v === a.detailsDays ? ' selected' : '') + '>' + timer(v) + '</option>').join('') + '</select></div>'
    + '<label class="toggle"><span>Owner’s number: switched on when approving<small>The approver can still change it each time</small></span><input type="checkbox" id="aContact"' + (a.shareContact ? ' checked' : '') + '></label>'
    + '<div class="field"><label for="aHours">Owner’s number visible for</label><select id="aHours">'
    + AC.CONTACT_TIMERS.map(v => '<option value="' + v + '"' + (v === a.contactHours ? ' selected' : '') + '>' + hours(v) + '</option>').join('') + '</select></div></div></details>';

  const el = $('settings');
  const sync = key => {
    draft[key] = [...el.querySelectorAll('input[data-key="' + key + '"]:checked')].map(x => x.value);
    const sum = el.querySelector('[data-sum="' + key + '"]');
    if (sum) sum.textContent = summary(key, CAT[key]);
    if (forWho) {
      const base = new Set(common()[key] || []);
      el.querySelectorAll('input[data-key="' + key + '"]').forEach(i => i.closest('.chk').classList.toggle('diff', base.has(i.value) !== i.checked));
    }
    setDirty(true);
  };
  // Ticking something that hands out owners' or buyers' numbers, office notes or exact addresses
  // is confirmed in plain words first.
  const RISK_TEXT = {
    'otherPropertyFields:contact': 'Every agent will see every owner’s name and phone number, on properties that aren’t theirs. Continue?',
    'otherPropertyFields:address': 'Every agent will see the exact address of properties that aren’t theirs. Continue?',
    'otherPropertyFields:internal': 'Every agent will see office-only notes (lowest prices, commission talk) on properties that aren’t theirs. Continue?',
    'otherPropertyFields:sheet': 'Extra sheet columns can contain anything, including owner details. Continue?',
    'grantedPropertyFields:internal': 'Agents with an approved request will see office-only notes (lowest prices, commission talk). Continue?',
    'grantedPropertyFields:sheet': 'Extra sheet columns can contain anything, including owner details. Continue?',
    'matchingLeadFields:phone': 'Agents will get buyers’ and tenants’ phone numbers without asking. Continue?',
  };
  el.querySelectorAll('input[data-key]').forEach(i => i.addEventListener('change', () => {
    const risk = RISK_TEXT[i.dataset.key + ':' + i.value];
    if (i.checked && risk && !confirm(risk)) { i.checked = false; return; }
    sync(i.dataset.key);
  }));
  el.querySelectorAll('[data-all],[data-none]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.all || b.dataset.none;
    if (b.dataset.all && key === 'otherPropertyFields' && !confirm('Tick everything, owner numbers and addresses included, for properties that aren’t theirs?')) return;
    el.querySelectorAll('input[data-key="' + key + '"]').forEach(i => { i.checked = !!b.dataset.all; });
    sync(key);
  }));
  el.querySelectorAll('input[data-action]').forEach(i => i.addEventListener('change', () => {
    draft.actions[i.dataset.action] = i.checked;
    el.querySelector('[data-sum="actions"]').textContent = actionsSummary();
    setDirty(true);
  }));
  el.querySelectorAll('input[name="adsScope"], input[name="campaignsScope"]').forEach(i => i.addEventListener('change', () => {
    if (i.value === 'all' && !confirm('Agents will see ' + (i.name === 'adsScope' ? 'every ad lead, phone numbers included' : 'every campaign and its leads') + ', not only their own. Continue?')) {
      el.querySelector('input[name="' + i.name + '"][value="own"]').checked = true; return;
    }
    draft[i.name] = i.value;
    el.querySelector('[data-sum="scopes"]').textContent = scopeSummary();
    setDirty(true);
  }));
  el.querySelectorAll('input[name="approvers"]').forEach(i => i.addEventListener('change', () => {
    draft.approvals.approvers = i.value;
    el.querySelector('[data-sum="approvals"]').textContent = approvalsSummary();
    setDirty(true);
  }));
  el.querySelector('#aContact').addEventListener('change', e => { draft.approvals.shareContact = e.target.checked; setDirty(true); });
  el.querySelector('#aDays').addEventListener('change', e => { draft.approvals.detailsDays = e.target.value === '' ? null : Number(e.target.value); setDirty(true); });
  el.querySelector('#aHours').addEventListener('change', e => { draft.approvals.contactHours = Number(e.target.value); setDirty(true); });
}

function diffFrom(base, cfg) {
  const d = {};
  Object.keys(AC.DEFAULTS).forEach(k => { if (JSON.stringify(base[k]) !== JSON.stringify(cfg[k])) d[k] = cfg[k]; });
  return d;
}

// Save: the inputs are locked while it is in flight (nothing ticked meanwhile can be lost). The
// write is a transaction that first checks the document is still the one this page loaded: a change
// another admin saved meanwhile is never overwritten — their version is loaded at once and you are
// told whose it was, so there is no stale draft left to save by clicking again.
const CONFLICT = 'conflict';
async function save(nextShared, overrides) {
  if (saving) return;
  saving = true;
  $('settingsFs').disabled = true;
  $('saveBtn').disabled = true;
  try {
    const out = AC.normalizeConfig({ ...nextShared, overrides: tidyOverrides(nextShared, overrides) }, me.tenantId);
    out.updatedAt = Date.now();
    out.updatedBy = me.email;
    const loadedAt = (stored && stored.updatedAt) || 0;
    await runTransaction(db, async tx => {
      const fresh = await tx.get(settingsRef());
      const now = fresh.exists() ? fresh.data() : null;
      if (((now && now.updatedAt) || 0) !== loadedAt) { const e = new Error(CONFLICT); e.now = now; throw e; }
      tx.set(settingsRef(), out);
    });
    stored = out;
    toast('Saved — agents see the change now');
    renderForWho();
    pickWho(forWho);
    // Every agent's copy rebuilt at once: a setting that shows LESS must not stay in an old copy.
    api('rebuild', {}).catch(() => toast('Saved. Agents get it the next time they open a page.'));
  } catch (e) {
    if (e.message === CONFLICT) {
      stored = e.now;
      renderForWho();
      pickWho(forWho);
      toast('Another admin (' + ((e.now && e.now.updatedBy) || 'someone') + ') saved just now. Their version is loaded — make your change again.');
    } else {
      $('saveMsg').textContent = 'Not saved: ' + (e.code === 'permission-denied' ? 'only an admin can change these' : e.message);
    }
  } finally {
    saving = false;
    $('settingsFs').disabled = false;
    $('saveBtn').disabled = false;
  }
}

// An agent's own settings keep only what still differs from the common ones; one left identical is
// dropped, so nobody stays marked "own settings" for nothing.
function tidyOverrides(shared, overrides) {
  const base = AC.effectiveConfig(AC.normalizeConfig(shared), null);
  const out = {};
  Object.keys(overrides || {}).forEach(email => {
    const full = AC.effectiveConfig({ ...AC.normalizeConfig(shared), overrides: { [email]: overrides[email] } }, email);
    const d = diffFrom(base, full);
    if (Object.keys(d).length) out[email] = d;
  });
  return out;
}

$('saveBtn').addEventListener('click', () => {
  const shared = common();
  const overrides = { ...((stored && stored.overrides) || {}) };
  if (!forWho) return save(draft, overrides);
  const d = diffFrom(shared, draft);
  if (Object.keys(d).length) overrides[forWho] = d; else delete overrides[forWho];
  return save(shared, overrides);
});

window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
}
