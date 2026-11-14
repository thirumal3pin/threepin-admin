// ═══════ TEAM & ACCESS (team.html) — admins only ═══════
//
// People: every login on the tenant, its role (admin / agent / as before), enabled or not, on the
//         team list or not — changed through /api/agent (api/_agent.js), because roles are custom
//         claims and only the server may write them.
// Agent settings: agentConfigs/{tenant}, written straight to Firestore (the rules let only an admin
//         write it, and only known settings). The model and defaults are shared-assets/agent-config.js.
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import * as AC from '../shared-assets/agent-config.js';

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
const db = getFirestore(app);

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ROLE_LABEL = { admin: 'Admin', agent: 'Agent', none: 'Team' };
const ROLE_NOTE = {
  admin: 'Sees and manages everything: assigns properties, approves requests, changes these settings.',
  agent: 'Sees only what Agent settings allows: their own properties and leads.',
  none: 'Works exactly as before the agent layer: sees everything, cannot change access.',
};

let me = null;         // { uid, email, tenantId }
let people = [];       // from /api/agent team
let listOnly = [];
let stored = null;     // agentConfigs/{tenant} as saved
let draft = null;      // the settings being edited (full shape) for `forWho`
let forWho = '';       // '' = all agents, else an agent's email
let dirty = false;

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
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

// ── Sign-in gate ──
onAuthStateChanged(auth, async user => {
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
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  $('tab-people').hidden = b.dataset.tab !== 'people';
  $('tab-agents').hidden = b.dataset.tab !== 'agents';
  $('savebar').hidden = b.dataset.tab !== 'agents' || !dirty;
}));

// ═══════ PEOPLE ═══════

async function loadPeople() {
  const data = await api('team');
  people = data.users || [];
  listOnly = data.listOnly || [];
  renderPeople();
  renderForWho();
}

function ago(ms) {
  if (!ms) return 'never signed in';
  const d = Math.floor((Date.now() - ms) / 86400000);
  if (d <= 0) return 'signed in today';
  if (d === 1) return 'signed in yesterday';
  if (d < 60) return 'signed in ' + d + ' days ago';
  return 'signed in ' + new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function renderPeople() {
  const order = { admin: 0, agent: 1, none: 2 };
  const rows = people.slice().sort((a, b) => (order[a.role] - order[b.role]) || a.email.localeCompare(b.email));
  $('people').innerHTML = rows.map(p => {
    const initial = (p.name || p.email || '?').charAt(0).toUpperCase();
    return '<li class="row" data-uid="' + esc(p.uid) + '" role="button" tabindex="0">'
      + '<span class="av">' + esc(initial) + '</span>'
      + '<span class="who"><b>' + esc(p.name || p.email) + (p.self ? ' (you)' : '') + '</b>'
      + '<small>' + (p.name ? esc(p.email) + ' · ' : '') + esc(ago(p.lastLogin)) + (p.teamList ? ' · on team list' : '') + '</small></span>'
      + (p.active ? '' : '<span class="pill off">Disabled</span>')
      + '<span class="pill ' + esc(p.role) + '">' + esc(ROLE_LABEL[p.role] || p.role) + '</span>'
      + '</li>';
  }).join('')
    + (listOnly.length ? '<li class="listonly">On the team list without a login: ' + listOnly.map(esc).join(', ') + '</li>' : '');
  $('people').querySelectorAll('.row').forEach(r => {
    const open = () => personSheet(people.find(p => p.uid === r.dataset.uid));
    r.addEventListener('click', open);
    r.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

// ── Bottom sheet ──
function sheet(html, onMount) {
  const host = $('sheetHost');
  host.innerHTML = '<div class="scrim"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grip"></div>' + html + '</div>';
  const close = () => { host.innerHTML = ''; window.AppNav.closeLayer && window.AppNav.closeLayer('team-sheet'); };
  host.querySelector('.scrim').addEventListener('click', close);
  host.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  if (window.AppNav.openLayer) window.AppNav.openLayer('team-sheet', () => { host.innerHTML = ''; });
  onMount && onMount(host.querySelector('.sheet'), close);
}

function roleChoices(name, current, disabled) {
  return '<div class="roles">' + ['admin', 'agent', 'none'].map(r =>
    '<label><input type="radio" name="' + name + '" value="' + r + '"' + (r === current ? ' checked' : '') + (disabled ? ' disabled' : '') + '>'
    + '<span><b>' + ROLE_LABEL[r] + (r === 'none' ? ' (as before)' : '') + '</b><small>' + esc(ROLE_NOTE[r]) + '</small></span></label>').join('') + '</div>';
}

function personSheet(p) {
  if (!p) return;
  sheet(
    '<h3>' + esc(p.name || p.email) + '</h3>' + (p.name ? '<p class="sub">' + esc(p.email) + '</p>' : '<p class="sub"></p>')
    + (p.self ? '<p class="note">You can’t change your own role or disable yourself. Ask another admin.</p>' : '')
    + roleChoices('role', p.role, p.self)
    + '<label class="toggle"><span>Can sign in</span><input type="checkbox" id="pActive"' + (p.active ? ' checked' : '') + (p.self ? ' disabled' : '') + '></label>'
    + '<label class="toggle"><span>On the team list<br><small class="note" style="margin:0">@mentions, Team calendar column, site visits</small></span><input type="checkbox" id="pList"' + (p.teamList ? ' checked' : '') + '></label>'
    + '<p class="err" id="pErr"></p>'
    + '<div class="bar"><button type="button" class="btn block" data-close>Cancel</button><button type="button" class="btn primary block" id="pSave">Save</button></div>',
    (el, close) => {
      el.querySelector('#pSave').addEventListener('click', async () => {
        const btn = el.querySelector('#pSave');
        const err = el.querySelector('#pErr');
        const role = (el.querySelector('input[name="role"]:checked') || {}).value || p.role;
        const active = el.querySelector('#pActive').checked;
        const list = el.querySelector('#pList').checked;
        btn.disabled = true; err.textContent = '';
        try {
          if (!p.self && role !== p.role) await api('set-role', { uid: p.uid, role });
          if (!p.self && active !== p.active) await api('set-active', { uid: p.uid, active });
          if (list !== p.teamList) await api('team-list', { email: p.email, on: list });
          close();
          toast('Saved');
          await loadPeople();
        } catch (e) { err.textContent = e.message; btn.disabled = false; }
      });
    });
}

$('addBtn').addEventListener('click', () => {
  sheet(
    '<h3>Add a person</h3><p class="sub">They sign in with this email: Google, or the password shown after you add them.</p>'
    + '<div class="field"><label for="nEmail">Email</label><input type="email" id="nEmail" autocomplete="off" placeholder="name@threepin.in"></div>'
    + roleChoices('nrole', 'agent', false)
    + '<label class="toggle"><span>Add to the team list<br><small class="note" style="margin:0">Only for a real mailbox: it gets a Team calendar column</small></span><input type="checkbox" id="nList" checked></label>'
    + '<p class="err" id="nErr"></p>'
    + '<div class="bar"><button type="button" class="btn block" data-close>Cancel</button><button type="button" class="btn primary block" id="nSave">Add</button></div>',
    (el, close) => {
      el.querySelector('#nEmail').focus();
      el.querySelector('#nSave').addEventListener('click', async () => {
        const btn = el.querySelector('#nSave');
        const err = el.querySelector('#nErr');
        btn.disabled = true; err.textContent = '';
        try {
          const r = await api('add-user', {
            email: el.querySelector('#nEmail').value,
            role: (el.querySelector('input[name="nrole"]:checked') || {}).value || 'none',
            teamList: el.querySelector('#nList').checked,
          });
          await loadPeople();
          if (r.password) {
            el.innerHTML = '<div class="grip"></div><h3>' + esc(r.email) + ' is added</h3>'
              + '<p class="sub">Send them this password now. It is not saved anywhere and won’t be shown again. They can also use “Continue with Google”.</p>'
              + '<div class="pw">' + esc(r.password) + '</div>'
              + '<div class="bar"><button type="button" class="btn block" id="cp">Copy</button><button type="button" class="btn primary block" data-close>Done</button></div>';
            el.querySelector('[data-close]').addEventListener('click', close);
            el.querySelector('#cp').addEventListener('click', () => navigator.clipboard.writeText(r.password).then(() => toast('Copied')));
          } else {
            close();
            toast(r.email + ' already had a login: role set');
          }
        } catch (e) { err.textContent = e.message; btn.disabled = false; }
      });
    });
});

// ═══════ AGENT SETTINGS ═══════

const settingsRef = () => doc(db, 'agentConfigs', me.tenantId);

async function loadSettings() {
  const snap = await getDoc(settingsRef());
  stored = snap.exists() ? snap.data() : null;
  pickWho('');
}

function agents() { return people.filter(p => p.role === 'agent').map(p => p.email.toLowerCase()); }

function renderForWho() {
  if (!$('forWho')) return;
  const list = agents();
  $('forWho').innerHTML = '<option value="">All agents (shared settings)</option>'
    + list.map(e => '<option value="' + esc(e) + '"' + (e === forWho ? ' selected' : '') + '>' + esc(e) + '</option>').join('');
  $('forWho').value = list.includes(forWho) ? forWho : '';
}

function hasOverride(email) { return !!(stored && stored.overrides && stored.overrides[email]); }

function pickWho(who) {
  forWho = who;
  draft = AC.effectiveConfig(stored, who || null);
  $('forState').textContent = !who ? 'Applies to every agent without their own settings'
    : hasOverride(who) ? 'Own settings for this agent' : 'Using the shared settings';
  $('resetBtn').hidden = !(who && hasOverride(who));
  setDirty(false);
  renderSettings();
}

$('forWho').addEventListener('change', e => {
  if (dirty && !confirm('Discard your unsaved changes?')) { e.target.value = forWho; return; }
  pickWho(e.target.value);
});

function setDirty(on) {
  dirty = on;
  $('savebar').hidden = !on && !(forWho && hasOverride(forWho));
  $('saveMsg').textContent = on ? 'Unsaved changes' : (forWho && hasOverride(forWho) ? forWho.split('@')[0] + ' has their own settings' : '');
  $('saveBtn').disabled = !on;
}

const WARN = { contact: 'owner phone', address: 'reveals the address', internal: 'team-only notes' };

function checks(key, catalogue, opts = {}) {
  const on = new Set(draft[key] || []);
  return '<div class="checks">' + catalogue.map(item => {
    const dis = opts.disabled && opts.disabled(item);
    const tag = opts.tag && opts.tag(item);
    const warn = opts.warn && opts.warn(item);
    return '<label class="chk' + (dis ? ' dis' : '') + '"><input type="checkbox" data-key="' + key + '" value="' + esc(item.id) + '"'
      + (on.has(item.id) ? ' checked' : '') + (dis ? ' disabled' : '') + '><span>' + esc(item.label) + '</span>'
      + (tag ? '<span class="tag">' + esc(tag) + '</span>' : warn ? '<span class="warn">' + esc(warn) + '</span>' : '') + '</label>';
  }).join('') + '</div>';
}

// What a folded section says it holds, so nobody has to open it to know.
function summary(key, catalogue) {
  const on = draft[key] || [];
  if (!on.length) return 'Nothing';
  if (on.length === catalogue.length) return 'Everything';
  const names = catalogue.filter(c => on.includes(c.id)).map(c => c.label.replace(/ \(.*\)$/, ''));
  return names.length <= 3 ? names.join(', ') : names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' more';
}

// One foldable group of ticks. Tabs start open; the long field lists start folded.
function fold(key, title, help, catalogue, opts = {}, open = false) {
  const pickable = catalogue.filter(c => !(opts.disabled && opts.disabled(c)));
  return '<details class="sec"' + (open ? ' open' : '') + ' data-fold="' + key + '">'
    + '<summary><span class="st"><b>' + esc(title) + '</b><small data-sum="' + key + '">' + esc(summary(key, catalogue)) + '</small></span>'
    + '<i class="fa-solid fa-chevron-down" aria-hidden="true"></i></summary>'
    + '<p>' + help + '</p>'
    + (pickable.length > 4 ? '<div class="quick"><button type="button" class="btn sm" data-all="' + key + '">Tick all</button><button type="button" class="btn sm" data-none="' + key + '">Clear</button></div>' : '')
    + checks(key, catalogue, opts) + '</details>';
}

function scope(key, label) {
  return '<div class="field"><label>' + esc(label) + '</label><div class="scope">'
    + [['own', 'Only their properties'], ['all', 'Everything']].map(([v, l]) =>
      '<label><input type="radio" name="' + key + '" data-scope="' + key + '" value="' + v + '"' + (draft[key] === v ? ' checked' : '') + '> ' + l + '</label>').join('')
    + '</div></div>';
}

function renderSettings() {
  const a = draft.approvals;
  const timer = (v, unit) => v === null ? 'No limit' : v + ' ' + unit + (v === 1 ? '' : 's');
  const GRANTED = AC.PROPERTY_FIELDS.filter(f => f.id !== 'contact');
  $('settings').innerHTML =
    fold('tabs', 'Tabs', 'What appears in an agent’s menu. “Coming” tabs aren’t built for agents yet.', AC.TABS, { disabled: t => !t.ready, tag: t => (t.ready ? '' : 'coming') }, true)
    + fold('otherPropertyFields', 'Other properties', 'Properties they are not assigned to. Shown with a lock and a “Request details” button.', AC.PROPERTY_FIELDS, { warn: f => WARN[f.id] })
    + fold('ownPropertyFields', 'Their own properties', 'Where they are the primary or a secondary agent.', AC.PROPERTY_FIELDS)
    + fold('grantedPropertyFields', 'After an approved request', 'A property someone approved for them. The owner contact is shared only if the approver switches it on, with a timer.', GRANTED)
    + fold('matchingLeadFields', 'Matching leads', 'Leads that match their properties but aren’t theirs. The number needs approval unless you tick it here.', AC.LEAD_FIELDS, { warn: f => (f.id === 'phone' ? 'no approval needed' : '') })
    + '<div class="sec"><h2>Ads and campaigns</h2>'
    + scope('adsScope', 'Meta Ads Leads') + scope('campaignsScope', 'WhatsApp Campaigns') + '</div>'
    + '<div class="sec"><h2>Approvals</h2><p>Defaults on the approve sheet. The approver can change them each time.</p>'
    + '<label class="toggle"><span>A property’s own agents can approve requests on it</span><input type="checkbox" id="aAgents"' + (a.agentsApprove ? ' checked' : '') + '></label>'
    + '<div class="field"><label for="aDays">Details access lasts</label><select id="aDays">'
    + AC.DETAIL_TIMERS.map(v => '<option value="' + (v === null ? '' : v) + '"' + (v === a.detailsDays ? ' selected' : '') + '>' + timer(v, 'day') + '</option>').join('') + '</select></div>'
    + '<label class="toggle"><span>“Share owner contact” starts on</span><input type="checkbox" id="aContact"' + (a.shareContact ? ' checked' : '') + '></label>'
    + '<div class="field"><label for="aHours">Owner contact lasts</label><select id="aHours">'
    + AC.CONTACT_TIMERS.map(v => '<option value="' + v + '"' + (v === a.contactHours ? ' selected' : '') + '>' + (v < 24 ? v + ' hours' : (v / 24) + (v === 24 ? ' day' : ' days')) + '</option>').join('') + '</select></div>'
    + '</div>';

  const el = $('settings');
  const CAT = { tabs: AC.TABS, otherPropertyFields: AC.PROPERTY_FIELDS, ownPropertyFields: AC.PROPERTY_FIELDS, grantedPropertyFields: GRANTED, matchingLeadFields: AC.LEAD_FIELDS };
  const sync = key => {
    draft[key] = [...el.querySelectorAll('input[data-key="' + key + '"]:checked')].map(x => x.value);
    const sum = el.querySelector('[data-sum="' + key + '"]');
    if (sum) sum.textContent = summary(key, CAT[key]);
    setDirty(true);
  };
  el.querySelectorAll('input[data-key]').forEach(i => i.addEventListener('change', () => sync(i.dataset.key)));
  el.querySelectorAll('[data-all],[data-none]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.all || b.dataset.none;
    el.querySelectorAll('input[data-key="' + key + '"]:not(:disabled)').forEach(i => { i.checked = !!b.dataset.all; });
    sync(key);
  }));
  el.querySelectorAll('input[data-scope]').forEach(i => i.addEventListener('change', () => { draft[i.dataset.scope] = i.value; setDirty(true); }));
  el.querySelector('#aAgents').addEventListener('change', e => { draft.approvals.agentsApprove = e.target.checked; setDirty(true); });
  el.querySelector('#aContact').addEventListener('change', e => { draft.approvals.shareContact = e.target.checked; setDirty(true); });
  el.querySelector('#aDays').addEventListener('change', e => { draft.approvals.detailsDays = e.target.value === '' ? null : Number(e.target.value); setDirty(true); });
  el.querySelector('#aHours').addEventListener('change', e => { draft.approvals.contactHours = Number(e.target.value); setDirty(true); });
}

// What is saved: the shared settings, plus per agent only what differs from the shared settings.
function buildDoc(nextShared, overrides) {
  const out = AC.normalizeConfig({ ...nextShared, overrides }, me.tenantId);
  out.updatedAt = Date.now();
  out.updatedBy = me.email;
  return out;
}

function diffFrom(base, cfg) {
  const d = {};
  Object.keys(AC.DEFAULTS).forEach(k => { if (JSON.stringify(base[k]) !== JSON.stringify(cfg[k])) d[k] = cfg[k]; });
  return d;
}

async function save(nextShared, overrides) {
  $('saveBtn').disabled = true;
  try {
    const out = buildDoc(nextShared, overrides);
    await setDoc(settingsRef(), out);
    stored = out;
    toast('Saved');
    pickWho(forWho);
  } catch (e) {
    $('saveMsg').textContent = 'Not saved: ' + (e.code === 'permission-denied' ? 'only an admin can change these' : e.message);
    $('saveBtn').disabled = false;
  }
}

$('saveBtn').addEventListener('click', () => {
  const shared = AC.effectiveConfig(stored, null);
  const overrides = { ...((stored && stored.overrides) || {}) };
  if (!forWho) return save(draft, overrides);
  const d = diffFrom(shared, draft);
  if (Object.keys(d).length) overrides[forWho] = d; else delete overrides[forWho];
  return save(shared, overrides);
});

$('resetBtn').addEventListener('click', () => {
  if (!forWho || !confirm('Use the shared settings for ' + forWho + '?')) return;
  const overrides = { ...((stored && stored.overrides) || {}) };
  delete overrides[forWho];
  save(AC.effectiveConfig(stored, null), overrides);
});

window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
