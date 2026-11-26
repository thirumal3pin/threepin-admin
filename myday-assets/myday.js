// ═══════ MY DAY (myday.html) ═══════
// Everything a person needs to act on today, live:
//   Approvals waiting on me · My requests · Site visits today (with visits other agents booked on my
//   properties) · Follow-ups due and overdue · New enquiries on my properties since my last visit
// and a History tab of requests decided (given and received). An agent's home page; admins can
// switch to any agent's day. Full-access staff see their own.
//
// What it reads, all allowed by firestore.rules: access requests where the person is an approver or
// the asker, visit alerts addressed to them, their leads (three queries, as the CRM's agent mode),
// and, for an agent, their own copy of the properties.
import { $, esc, lc, api, db, isShutdown, whenSignedIn, watchMyView, directory, nameOf, when, ago, untilWords, toast, decideSheet, busy, approvalDefaults, codeLine } from '../shared-assets/agent-client.js';
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import { leadViews } from '../shared-assets/lead-views-client.js';
import { canWorkLead, codeKey } from '../shared-assets/agent-access.js';
import { renderMatches, matchCounts } from '../shared-assets/agent-matches.js';

const me = await whenSignedIn();
const isAdmin = me.role === 'admin';
const isAgent = me.role === 'agent';
window.AppNav.boot({ console: 'myday', select: () => {}, signOut: () => import('../shared-assets/agent-client.js').then(m => m.signOutHere()) });
window.AppNav.setUser(me.email);
window.AppNav.setActive('myday');

let people = [];
let subject = me.email;              // whose day
let unsubs = [];
const S = { asked: new Map(), approve: new Map(), pendingAll: new Map(), leads: new Map(), alerts: [], props: [], subs: [], grants: [], matches: [], listings: null, queue: null };
let reqFilter = 'all';
// Several approvals at once (owner, 26 Nov 2026): "Select" on Approvals waiting on me, tick, then
// Approve or Reject them together. The ticks survive the page redrawing as new requests come in.
let selMode = false;
const sel = new Set();
// The bar sticks just under the page's own header (its height changes with the screen).
{ const top = document.querySelector('header.top');
  if (top && window.ResizeObserver) new ResizeObserver(() => document.documentElement.style.setProperty('--top-h', top.offsetHeight + 'px')).observe(top); }
let tab = 'today';
let histRange = 7, histKind = 'all';
const SEEN_KEY = () => 'pin.myday.seen.' + subject;
let seenBefore = 0;
let shownAt = 0;          // when this page first had the person's leads on screen

const DAY = 86400000;
const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const endOfDay = (t = Date.now()) => startOfDay(t) + DAY - 1;
const CLOSED = /won|lost|closed|dead|junk|spam|not.?interested|booked/i;
const leadLink = id => 'crm.html?lead=' + encodeURIComponent(id);

directory().then(p => {
  people = p;
  if (isAdmin) {
    const agents = p.filter(x => x.role === 'agent');
    $('who').innerHTML = `<option value="${esc(me.email)}">Me (${esc(nameOf(p, me.email))})</option>` + agents.map(a => `<option value="${esc(a.email)}">${esc(a.name)} · agent</option>`).join('');
    $('whoSel').hidden = !agents.length;
    const want = lc(new URLSearchParams(location.search).get('who'));
    if (want && agents.some(a => a.email === want)) { $('who').value = want; setSubject(want); }
  }
  render();
});
$('who').addEventListener('change', e => setSubject(e.target.value));

$('tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  tab = b.dataset.tab;
  document.querySelectorAll('#tabs [data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  $('tab-today').hidden = tab !== 'today'; $('tab-history').hidden = tab !== 'history';
  render();
});
$('histRange').addEventListener('click', e => { const b = e.target.closest('[data-r]'); if (!b) return; histRange = Number(b.dataset.r); document.querySelectorAll('#histRange .chip').forEach(x => x.setAttribute('aria-pressed', String(x === b))); render(); });
$('histKind').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (!b) return; histKind = b.dataset.k; document.querySelectorAll('#histKind .chip').forEach(x => x.setAttribute('aria-pressed', String(x === b))); render(); });

function setSubject(email) {
  subject = lc(email) || me.email;
  try { const u = new URL(location.href); if (subject === me.email) u.searchParams.delete('who'); else u.searchParams.set('who', subject); history.replaceState(null, '', u); } catch (e) { /* fine */ }
  watchAll();
}

function watchAll() {
  unsubs.forEach(u => { try { u(); } catch (e) { /* gone */ } });
  unsubs = [];
  Object.assign(S, { asked: new Map(), approve: new Map(), pendingAll: new Map(), leads: new Map(), alerts: [], props: [], subs: [], subsAll: [], grants: [], names: new Map(), matches: [], listings: null, queue: null, loaded: {} });
  // "New since my last visit": what arrived after the last time they LEFT this page (marked on the
  // way out, so a reload or a switch of person does not hide what they have not looked at yet).
  try { seenBefore = Number(localStorage.getItem(SEEN_KEY()) || 0); } catch (e) { seenBefore = 0; }
  const T = me.tenantId;
  const req = collection(db, 'accessRequests');
  const live = (q, key, fn) => unsubs.push(onSnapshot(q, s => { fn(s); S.loaded[key] = true; render(); }, err => { if (isShutdown(err)) return; console.error('My Day ' + key + ':', err); S.loaded[key] = 'error'; render(); }));
  const toMap = (m, s) => { m.clear(); s.docs.forEach(d => m.set(d.id, { ...d.data(), id: d.id })); };
  live(query(req, where('tenantId', '==', T), where('approvers', 'array-contains', subject)), 'approve', s => toMap(S.approve, s));
  live(query(req, where('tenantId', '==', T), where('requesterEmail', '==', subject)), 'asked', s => toMap(S.asked, s));
  if (isAdmin && subject === me.email) live(query(req, where('tenantId', '==', T), where('status', '==', 'pending')), 'pendingAll', s => toMap(S.pendingAll, s));
  live(query(collection(db, 'visitAlerts'), where('tenantId', '==', T), where('to', 'array-contains', subject)), 'alerts', s => { S.alerts = s.docs.map(d => ({ ...d.data(), id: d.id })); });
  // The person's leads: assigned to them, as the secondary agent, or reached through the agent layer.
  // An agent reads exactly those (three queries — all the rules allow). Admins and staff read the
  // packed lead views (a read per ~20 leads, the CRM's own way) and keep that person's: someone who
  // holds hundreds of leads (the default agent) costs ~75 reads here, not hundreds.
  if (isAgent) {
    const leadsCol = collection(db, 'leads');
    const parts = { a: [], b: [], c: [] };
    const mergeLeads = () => { S.leads.clear(); [...parts.a, ...parts.b, ...parts.c].forEach(l => S.leads.set(l.id, l)); };
    [['a', where('assignedAgent', '==', subject)], ['b', where('secondaryAgent', '==', subject)], ['c', where('agentAccess', 'array-contains', subject)]].forEach(([k, w]) =>
      live(query(leadsCol, where('tenantId', '==', T), w), 'leads' + k, s => { parts[k] = s.docs.map(d => ({ ...d.data(), id: d.id })); mergeLeads(); }));
  } else {
    const stop = leadViews(db).watch(T, list => {
      S.leads.clear();
      list.forEach(l => { if (lc(l.assignedAgent) === subject || lc(l.secondaryAgent) === subject || (l.agentAccess || []).map(lc).includes(subject)) S.leads.set(l.id, l); });
      ['leadsa', 'leadsb', 'leadsc'].forEach(k => { S.loaded[k] = true; });
      render();
    }, err => { if (!isShutdown(err)) console.error('My Day leads:', err); });
    unsubs.push(stop);
  }
  // Access shared with them, for "Ending soon".
  live(query(collection(db, 'grants'), where('tenantId', '==', T), where('agentEmail', '==', subject)), 'grants', s => { S.grants = s.docs.map(d => ({ ...d.data(), id: d.id })); });
  // Their properties' codes (for "new enquiries on my properties").
  if (isAgent) {
    const w = watchMyView(me, v => { if (v) {
      S.props = (v.props || []).filter(p => p._access === 'own' || p._access === 'co').map(p => ({ id: p.id, code: p._code, name: p.name, access: p._access }));
      S.names = new Map((v.props || []).flatMap(p => [[String(p._code || '').toLowerCase(), p.name], [String(p.id).toLowerCase(), p.name]]));
      S.propById = new Map((v.props || []).map(p => [String(p.id), p]));
      S.matches = v.matches || [];
      S.loaded.matches = true;
      render();
    } });
    unsubs.push(() => w.stop());
    live(query(collection(db, 'propertySubmissions'), where('tenantId', '==', T), where('byEmail', '==', me.email)), 'subs', s => { S.subs = s.docs.map(d => ({ ...d.data(), id: d.id })); });
    // My listings that need me: sent back by an admin, approved (mark them Live), or waiting.
    loadMine();
  } else {
    if (isAdmin) live(query(collection(db, 'propertySubmissions'), where('tenantId', '==', T), where('status', '==', 'pending')), 'subsAll', s => { S.subsAll = s.docs.map(d => ({ ...d.data(), id: d.id })); });
    if (isAdmin && subject === me.email) loadQueue();
    const pc = collection(db, 'properties');
    const pp = { a: [], b: [] };
    const mergeP = () => { const m = new Map(); [...pp.a, ...pp.b].forEach(p => m.set(p.id, p)); S.props = [...m.values()]; };
    [['a', where('assignedAgent', '==', subject)], ['b', where('secondaryAgents', 'array-contains', subject)]].forEach(([k, w]) =>
      live(query(pc, where('tenantId', '==', T), w), 'props' + k, s => { pp[k] = s.docs.map(d => ({ id: d.id, code: d.data().propertyCode || d.id, name: d.data().name })); mergeP(); }));
  }
}

// Admins: the listings waiting for a decision (an agent sent them for approval). Agents: their own
// listings that need them. Asked when the page opens and again on coming back to it (at most once a
// minute — a few reads each).
function loadQueue() { S.queueAt = Date.now(); api('listing-queue').then(j => { S.queue = j.listings || []; render(); }).catch(() => { S.queue = S.queue || []; }); }
function loadMine() { S.mineAt = Date.now(); api('listings').then(j => { S.listings = j.listings || []; S.stages = j.stages || []; render(); }).catch(() => { S.listings = S.listings || []; }); }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || subject !== me.email) return;
  if (isAdmin && Date.now() - (S.queueAt || 0) > 60000) loadQueue();
  if (isAgent && Date.now() - (S.mineAt || 0) > 60000) loadMine();
});
const isAgentSubject = () => isAgent || (people.find(p => p.email === subject) || {}).role === 'agent';
// A colleague's visit on my property: who, for which client (first name only), when — and the
// property one tap away.
function collabHtml(a) {
  const words = { booked: 'booked a visit', moved: 'moved a visit', cancelled: 'called off a visit', done: 'finished a visit' }[a.kind] || 'booked a visit';
  const href = (isAgent ? 'dashboard.html?property=' : 'property.html?id=') + encodeURIComponent(a.propertyId);
  return `<a class="bd" href="${href}"><b><span class="tag brand">Collaboration visit</span> ${esc(a.propertyTitle)}</b><small>${esc(a.byName)} (agent) ${words} for their client ${esc(a.clientName)}${a.at ? ' · ' + esc(when(a.at)) : ''}</small></a>`;
}

// ── Drawing ──
const allRequests = () => { const m = new Map([...S.pendingAll, ...S.approve, ...S.asked]); return [...m.values()]; };
const canDecide = r => r.status === 'pending' && r.requesterEmail !== me.email && (isAdmin || (r.approvers || []).includes(me.email));
const statusTag = r => (r.status === 'approved' && !liveAccess(r) ? '<span class="tag">Approved</span>' : '') || ({ pending: '<span class="tag wait">Waiting</span>', approved: '<span class="tag green">Approved</span>', rejected: '<span class="tag red">Rejected</span>',
  cancelled: '<span class="tag">Cancelled</span>', expired: '<span class="tag">Expired</span>' }[r.status] || '');
const reqTitle = r => r.kind === 'lead' ? 'A matching buyer' + (r.title ? ' — ' + esc(String(r.title).replace(/^Lead:\s*/, '')) : '’s details') : r.need === 'time' ? 'More time on ' + esc(r.title) : r.need === 'number' ? 'The owner’s number for ' + esc(r.title) : esc(r.title);
// Approved and still running — a hidden owner's number leaves the details shared, so it counts.
const liveAccess = r => r.status === 'approved' && (!r.grantState || r.grantState === 'contact-hidden') && !(r.terms && r.terms.until && r.terms.until < Date.now());
const terms = r => {
  const t = r.terms || {};
  if (r.status !== 'approved') return '';
  if (r.grantState === 'revoked') return 'access taken back' + (r.grantChangedByName ? ' by ' + r.grantChangedByName : '');
  if (r.grantState === 'expired') return 'access ended';
  if (r.grantState === 'contact-hidden') return (t.until ? 'details ' + untilWords(t.until) : 'details with no time limit') + ' · owner’s number hidden';
  if (t.coAgent) return 'now a co-agent';
  return (t.until ? 'details ' + untilWords(t.until) : 'details with no time limit') + (t.contact ? ' · owner’s number ' + (t.contactUntil ? untilWords(t.contactUntil) : 'shared') : '');
};

function requestItem(r, mode) {
  const ic = r.kind === 'lead' ? 'fa-user-lock' : 'fa-building-lock';
  const decider = r.decidedBy === me.email ? 'you' : r.decidedBy === 'system' ? 'the system' : (r.decidedByName || nameOf(people, r.decidedBy));
  const decided = r.status !== 'pending' ? `${statusTag(r)} by ${esc(decider)} ${esc(ago(r.decidedAt))}${terms(r) ? ' · ' + esc(terms(r)) : ''}` : statusTag(r) + ' asked ' + esc(ago(r.createdAt));
  const head = mode === 'approve'
    ? `<b>${esc(r.requesterName)} asks for ${reqTitle(r).replace(/^(More|The|A) /, m => m.toLowerCase())}</b><small>${r.clientName ? 'For their client ' + esc(r.clientName) + ' · ' : ''}${r.kind === 'lead' && r.aboutCode ? 'for their property <span class="code">' + esc(r.aboutCode) + '</span>' + (r.aboutTitle ? ' ' + esc(r.aboutTitle) : '') + ' · ' : ''}${esc(ago(r.createdAt))}${r.visitAt ? ' · visit wanted ' + esc(when(r.visitAt)) : ''}</small>${r.kind === 'lead' ? `<small class="yourlead" data-yourlead="${esc(r.id)}">${esc(yourLead.get(r.id) || '')}</small>` : ''}`
    : `<b>${reqTitle(r)}</b><small>${decided}</small>`;
  const pick = mode === 'approve' && selMode && canDecide(r);
  return `<div class="item${pick && sel.has(r.id) ? ' picked' : ''}">${pick
    ? `<label class="pick"><input type="checkbox" data-pick="${esc(r.id)}"${sel.has(r.id) ? ' checked' : ''} aria-label="Select: ${esc(r.requesterName)} — ${esc(String(r.title || ''))}"></label>`
    : `<div class="ic ${mode === 'approve' ? 'brand' : r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : ''}"><i class="fa-solid ${ic}"></i></div>`}
    <div class="bd">${head}${codeLine(r, me.role, { link: r.requesterEmail !== me.email })}${r.reason && mode === 'approve' ? `<div class="q">“${esc(r.reason)}”</div>` : ''}${r.note && r.status !== 'pending' ? `<div class="q">${esc(r.note)}</div>` : ''}
      <div class="acts">
        ${canDecide(r) ? `<button type="button" class="btn sm primary" data-quick="${esc(r.id)}" aria-describedby="qa-${esc(r.id)}"${QD ? '' : ' disabled'}><i class="fa-solid fa-check" aria-hidden="true"></i> Approve</button><button type="button" class="btn sm" data-reject="${esc(r.id)}">Reject</button><button type="button" class="btn sm quiet" data-decide="${esc(r.id)}">More options</button>` : ''}
        ${r.threadId ? `<a class="btn sm" href="messages.html?t=${encodeURIComponent(r.threadId)}&r=${encodeURIComponent(r.id)}"><i class="fa-regular fa-comments"></i> Message</a>` : ''}
        ${r.status === 'pending' && r.requesterEmail === me.email ? `<button type="button" class="btn sm danger" data-cancel="${esc(r.id)}">Cancel</button>` : ''}
        ${liveAccess(r) && r.kind === 'property' && r.requesterEmail === me.email ? `<a class="btn sm" href="dashboard.html?property=${encodeURIComponent(r.targetId)}">Open property</a>` : ''}
        ${liveAccess(r) && r.grantId && r.decidedBy === me.email && r.requesterEmail !== me.email ? `${r.terms && r.terms.contact ? `<button type="button" class="btn sm" data-hide="${esc(r.grantId)}">Hide number</button>` : ''}<button type="button" class="btn sm danger" data-end="${esc(r.grantId)}">End access</button>` : ''}
      </div>
      ${canDecide(r) ? `<p class="qa-terms" id="qa-${esc(r.id)}">${esc(quickTerms(r))}</p>
      <div class="rj" data-rj="${esc(r.id)}" hidden><label for="rj-${esc(r.id)}">Why (they see this)</label><textarea id="rj-${esc(r.id)}" maxlength="500" rows="2" placeholder="e.g. The owner has given this to us exclusively for now"></textarea><p class="rj-err" role="alert"></p>
        <div class="acts"><button type="button" class="btn sm danger" data-rjsend="${esc(r.id)}">Send rejection</button><button type="button" class="btn sm quiet" data-rjback="${esc(r.id)}">Not now</button></div></div>` : ''}
      ${r.kind === 'lead' && r.requesterEmail === me.email && liveAccess(r) && leadOfRequest(r) ? `<div class="acts"><a class="btn sm primary" href="${leadLink(leadOfRequest(r))}">Open in Leads</a></div>` : ''}
      </div></div>`;
}
// The lead an approved lead request opened (the grant carries it; the request never does).
const leadOfRequest = r => { const g = S.grants.find(x => x.kind === 'lead' && x.requestId === r.id && x.active); return g ? g.targetId : null; };
// What one tap on Approve gives: the admin's defaults (team.html → What agents see → Approvals).
let QD = null;
approvalDefaults(me).then(d => { QD = d || {}; render(); });
function quickBody(r) {
  if (!QD) throw new Error('Still loading the approval settings — try again in a moment');
  const d = QD, need = r.need || 'details';
  const body = { id: r.id, decision: 'approve' };
  // One tap never hands out access with no end: 7 days unless the admin set another default.
  if (need !== 'number') body.days = Number(d.days) > 0 ? Number(d.days) : 7;
  if (r.kind === 'property' && (need === 'number' || (need === 'details' && d.shareContact))) { body.shareContact = true; body.hours = Number(d.hours || 24); }
  return body;
}
function quickTerms(r) {
  if (!QD) return 'Loading what Approve gives…';
  const b = quickBody(r);
  const parts = [];
  if ((r.need || 'details') !== 'number') parts.push(b.days ? `details for ${b.days} day${b.days === 1 ? '' : 's'}` : 'details with no time limit');
  if (b.shareContact) parts.push(`owner’s number for ${b.hours >= 48 ? Math.round(b.hours / 24) + ' days' : b.hours + ' hours'}`);
  else if (r.kind === 'property') parts.push('without the owner’s number');
  return 'Approve gives ' + parts.join(', ') + '. More options to change it.';
}

// The bar over the list while selecting: select all, how many, Approve / Reject them together.
// Approve gives each one exactly what its own Approve button gives (its line under it says what).
function bulkBar(list) {
  const n = sel.size, all = list.length && list.every(r => sel.has(r.id));
  const same = new Set(list.filter(r => sel.has(r.id)).map(quickTerms)).size <= 1;
  const terms = n ? (same ? quickTerms(list.find(r => sel.has(r.id))).replace(/\. More options.*$/, '') + ' — each.' : 'Each gets what its own Approve gives (written under it).') : 'Tick the requests to decide together.';
  return `<div class="bulk" role="region" aria-label="Decide several">
    <label class="bulk-all"><input type="checkbox" data-pickall${all ? ' checked' : ''}> ${n ? `<b>${n} selected</b>` : 'Select all ' + list.length}</label>
    <div class="acts">
      <button type="button" class="btn sm primary" data-bulkok${n ? '' : ' disabled'}${QD ? '' : ' disabled'}><i class="fa-solid fa-check-double" aria-hidden="true"></i> Approve${n ? ' ' + n : ''}</button>
      <button type="button" class="btn sm" data-bulkrj${n ? '' : ' disabled'}>Reject${n ? ' ' + n : ''}</button>
    </div>
    <p class="qa-terms">${esc(terms)}</p>
    <div class="rj" data-rj="__bulk" hidden><label for="rj-__bulk">Why (each of them sees this)</label><textarea id="rj-__bulk" maxlength="500" rows="2" placeholder="e.g. The owner has given these to us exclusively for now"></textarea><p class="rj-err" role="alert"></p>
      <div class="acts"><button type="button" class="btn sm danger" data-bulkrjsend>Send rejection to ${n}</button><button type="button" class="btn sm quiet" data-rjback="__bulk">Not now</button></div></div>
  </div>`;
}
function bulkDone(r, verb) {
  const failed = (r.results || []).filter(x => !x.ok);
  (r.results || []).filter(x => x.ok).forEach(x => sel.delete(x.id));
  toast(`${verb} ${r.done}` + (failed.length ? ` · ${failed.length} not: ${failed[0].error}` : ' — they’ve been told'));
  if (!sel.size) selMode = false;
  render();
}

// The lead's own agent (and admins) may see WHICH of their clients a buyer request is about
// (requestPrivate; never the asker). Read once per request.
const yourLead = new Map();
function fillYourLeads(reqs) {
  reqs.filter(r => r.kind === 'lead' && canDecide(r) && !yourLead.has(r.id)).forEach(r => {
    yourLead.set(r.id, '');
    import("https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js").then(fs => fs.getDoc(fs.doc(db, 'requestPrivate', r.id))).then(snap => {
      const n = snap.exists() ? snap.data().leadName : '';
      if (!n) return;
      const words = (isAdmin ? 'The client: ' : 'Your client: ') + n;
      yourLead.set(r.id, words);
      const el = document.querySelector(`[data-yourlead="${CSS.escape(r.id)}"]`); if (el) el.textContent = words;
    }).catch(() => {});
  });
}
function section(title, n, body, { hot = false, more = '' } = {}) {
  return `<div class="sec-h">${title} <span class="n${hot && n ? ' hot' : ''}">${n}</span>${more}</div><div class="card">${body}</div>`;
}
const empty = (icon, text) => `<div class="empty"><i class="${icon}"></i>${text}</div>`;
const loading = () => '<div class="sk"></div>';

// A reason half-typed (Reject, Send back) is never wiped by a redraw: every open box, its text and the
// cursor are carried over to the fresh page (the buyers list is carried over whole, below).
function keepOpenBoxes() {
  const open = [...document.querySelectorAll('#sections [data-rj]:not([hidden]), #sections [data-lrj]:not([hidden])')]
    .map(b => ({ sel: b.hasAttribute('data-rj') ? `[data-rj="${CSS.escape(b.dataset.rj)}"]` : `[data-lrj="${CSS.escape(b.dataset.lrj)}"]`, text: (b.querySelector('textarea') || {}).value || '' }));
  const a = document.activeElement;
  const focus = a && a.id && a.closest && a.closest('#sections') ? { id: a.id, start: a.selectionStart, end: a.selectionEnd } : null;
  return () => {
    open.forEach(o => { const b = document.querySelector('#sections ' + o.sel); if (!b) return; b.hidden = false; const t = b.querySelector('textarea'); if (t) t.value = o.text; });
    if (focus) { const el = document.getElementById(focus.id); if (el) { el.focus({ preventScroll: true }); try { if (focus.start != null) el.setSelectionRange(focus.start, focus.end); } catch (e) { /* not a text box */ } } }
  };
}
function render() {
  if (!S.loaded) return;
  const restoreBoxes = keepOpenBoxes();
  const now = Date.now(), sod = startOfDay(now), eod = endOfDay(now);
  const reqs = allRequests();
  const toDecide = reqs.filter(canDecide).sort((a, b) => a.createdAt - b.createdAt);
  // Waiting, and everything decided in the last week (a rejection read on Monday is still there on Friday).
  const mineAll = reqs.filter(r => r.requesterEmail === subject && (r.status === 'pending' || (r.decidedAt || 0) >= now - 7 * DAY)).sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || b.createdAt - a.createdAt);
  const reqKey = r => r.status === 'pending' ? 'pending' : r.status === 'approved' && liveAccess(r) ? 'approved' : r.status === 'rejected' ? 'rejected' : 'ended';
  const reqCounts = mineAll.reduce((c, r) => { c[reqKey(r)] = (c[reqKey(r)] || 0) + 1; return c; }, {});
  if (reqFilter !== 'all' && (!reqCounts[reqFilter] || mineAll.length <= 2)) reqFilter = 'all';
  const mine = mineAll.filter(r => reqFilter === 'all' || reqKey(r) === reqFilter);
  const leads = [...S.leads.values()];
  const workable = leads.filter(l => !isAgentSubject() || canWorkLead(l, subject));
  const visits = workable.filter(l => l.siteVisitAt >= sod && l.siteVisitAt <= eod && l.siteVisitStatus !== 'cancelled')
    .map(l => ({ at: l.siteVisitAt, html: `<a class="bd" href="${leadLink(l.id)}"><b>${esc(l.name || 'Client')}</b><small>${esc(when(l.siteVisitAt))}${l.siteVisitProperty ? ' · ' + esc(S.names.get(String(l.siteVisitProperty).toLowerCase()) || l.siteVisitProperty) : ''}${l.siteVisitStatus === 'done' ? ' · done' : ''}</small></a>`, ic: 'blue' }));
  // A colleague's visit on my property counts when the visit itself is today (moved or called off
  // ones show what happened to it).
  const alerts = S.alerts.filter(a => a.at >= sod && a.at <= eod).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const seenAlert = new Set();
  alerts.forEach(a => {
    const key = a.propertyId + '|' + a.byEmail + '|' + a.clientName;
    if (seenAlert.has(key)) return; seenAlert.add(key);
    visits.push({ at: a.at || a.createdAt, ic: a.kind === 'cancelled' ? 'red' : 'brand', html: collabHtml(a) });
  });
  visits.sort((a, b) => (a.at || 0) - (b.at || 0));
  // Coming up (the next 7 days): visits of mine, and colleagues' visits on my properties — a visit
  // booked for tomorrow is seen today, not tomorrow morning.
  const soon = [
    ...workable.filter(l => l.siteVisitAt > eod && l.siteVisitAt <= eod + 7 * DAY && l.siteVisitStatus !== 'cancelled')
      .map(l => ({ at: l.siteVisitAt, ic: 'blue', html: `<a class="bd" href="${leadLink(l.id)}"><b>${esc(l.name || 'Client')}</b><small>${esc(when(l.siteVisitAt))}${l.siteVisitProperty ? ' · ' + esc(S.names.get(String(l.siteVisitProperty).toLowerCase()) || l.siteVisitProperty) : ''}</small></a>` })),
    ...S.alerts.filter(a => a.at > eod && a.at <= eod + 7 * DAY && a.kind !== 'cancelled').map(a => ({ at: a.at, ic: 'brand', html: collabHtml(a) })),
  ].sort((a, b) => a.at - b.at);
  // Follow-ups: only leads the person works (not ones they can merely read). Overdue as the CRM
  // counts it: past its time, not past midnight.
  const follow = workable.filter(l => l.followUpAt && l.followUpAt <= eod && !CLOSED.test(String(l.stageId || ''))).sort((a, b) => a.followUpAt - b.followUpAt);
  const overdue = follow.filter(l => l.followUpAt < now).length;
  const codes = new Set(S.props.flatMap(p => [codeKey(p.code), codeKey(p.id)]).filter(Boolean));
  // Every enquiry on my properties — including ones the default agent holds (read-only to me).
  const fresh = leads.filter(l => (l.createdAt || 0) > (seenBefore || now - 3 * DAY) && (l.propertyCodes || []).some(c => codes.has(codeKey(c)))).sort((a, b) => b.createdAt - a.createdAt);

  // Full-access staff are never asked to approve and never need to ask: those two sections are for
  // agents and admins.
  const asksAndApproves = isAgent || isAdmin || isAgentSubject() || toDecide.length > 0 || mine.length > 0;
  const h = new Date().getHours();
  const name = nameOf(people, subject).split(' ')[0];
  $('hello').innerHTML = `<b>${subject === me.email ? (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + (name ? ', ' + esc(name) : '') : esc(nameOf(people, subject)) + '’s day'}</b><small>${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</small>`;
  // A count only once its data is in (a 0 that later turns into 3 is a small lie).
  const leadsIn = S.loaded.leadsa && S.loaded.leadsb && S.loaded.leadsc;
  const shown = (n, ready) => (ready ? n : '–');
  $('stats').innerHTML = [...(asksAndApproves ? [[toDecide.length, 'to approve', '#s-approve', toDecide.length, !!S.loaded.approve]] : []), [visits.length, 'visits today', '#s-visits', 0, leadsIn], [follow.length, 'follow-ups', '#s-follow', overdue, leadsIn], [fresh.length, 'new enquiries', '#s-new', fresh.length, leadsIn]]
    .map(([n, l, href, hot, ready]) => `<a class="stat${hot && ready ? ' hot' : ''}" href="${href}"><b>${shown(n, ready)}</b><small>${l}</small></a>`).join('');
  const ld = k => S.loaded[k];
  const leadsLoaded = ld('leadsa') && ld('leadsb') && ld('leadsc');
  if (leadsLoaded && !shownAt) shownAt = Date.now();
  let html = '';
  if (isAdmin && subject === me.email && S.subsAll.length) html += section('Properties agents added', S.subsAll.length, `<div class="item"><div class="ic brand"><i class="fa-regular fa-building"></i></div><div class="bd"><b>${S.subsAll.length === 1 ? 'One property is' : S.subsAll.length + ' properties are'} waiting for your approval</b><small>${esc(S.subsAll.map(x => (x.fields || {}).name).filter(Boolean).slice(0, 3).join(' · '))}</small><div class="acts"><a class="btn sm primary" href="team.html?tab=requests">Review in Team &amp; access</a></div></div></div>`, { hot: true });
  [...sel].forEach(id => { if (!toDecide.some(r => r.id === id)) sel.delete(id); });
  if (toDecide.length < 2 && !sel.size) selMode = false;
  const selLink = toDecide.length >= 2 && ld('approve') ? `<button type="button" class="more linkbtn" data-selmode aria-pressed="${selMode}">${selMode ? 'Done' : '<i class="fa-regular fa-square-check" aria-hidden="true"></i> Select'}</button>` : '';
  if (asksAndApproves) html += `<div id="s-approve"${selMode ? ' class="selecting"' : ''}>${section('Approvals waiting on ' + (subject === me.email ? 'me' : esc(name)), toDecide.length,
    !ld('approve') ? loading() : toDecide.length ? (selMode ? bulkBar(toDecide) : '') + toDecide.map(r => requestItem(r, 'approve')).join('') : empty('fa-regular fa-circle-check', 'Nothing waiting for a decision.'), { hot: true, more: selLink })}</div>`;
  // Admins: listings an agent sent for approval — decided right here.
  if (isAdmin && subject === me.email && S.queue && S.queue.length) html += `<div id="s-lq">${section('Listings waiting for approval', S.queue.length, S.queue.map(listingQueueItem).join(''), { hot: true, more: '<a class="more" href="propertytrack.html">Shoot &amp; Media board</a>' })}</div>`;
  // Agents: their listings that need them (sent back, approved — mark Live, waiting).
  if (isAgent && subject === me.email && S.listings) {
    const need = S.listings.filter(x => !x.virtual && (x.stageKey === 'for_approval' || x.stageKey === 'approved' || (x.approval && x.approval.decision === 'returned' && x.stageKey === 'details')));
    if (need.length) html += `<div id="s-ml">${section('My listings', need.length, need.map(myListingItem).join(''), { hot: need.some(x => x.stageKey !== 'for_approval'), more: '<a class="more" href="mylistings.html">All my listings</a>' })}</div>`;
  }
  if (asksAndApproves) {
  const ending = S.grants.filter(g => g.active && g.expiresAt && g.expiresAt > now && g.expiresAt < now + 2 * DAY).sort((a, b) => a.expiresAt - b.expiresAt);
  if (ending.length) html += `<div id="s-ending">${section('Access ending soon', ending.length, ending.map(g => `<div class="item"><div class="ic blue"><i class="fa-regular fa-hourglass-half"></i></div>
    <div class="bd"><b>${g.kind === 'lead' ? 'A buyer’s details' : esc(g.title)}</b><small>Details ${esc(untilWords(g.expiresAt))}${g.includeContact && g.contactExpiresAt > now ? ' · owner’s number ' + esc(untilWords(g.contactExpiresAt)) : ''}</small>
      ${subject === me.email && g.kind === 'property' ? `<div class="acts"><button type="button" class="btn sm" data-more="${esc(g.targetId)}">Ask for more time</button><a class="btn sm" href="dashboard.html?property=${encodeURIComponent(g.targetId)}">Open property</a></div>` : ''}</div></div>`).join(''), { hot: true })}</div>`;
  const reqChips = mineAll.length > 2 ? `<div class="mx-chips" role="group" aria-label="Show requests" id="reqChips">${[['all', 'All'], ['pending', 'Waiting'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['ended', 'Ended']]
    .filter(([k]) => k === 'all' || reqCounts[k]).map(([k, l]) => `<button type="button" class="mx-chip" data-rf="${k}" aria-pressed="${k === reqFilter}">${l} <span>${k === 'all' ? mineAll.length : reqCounts[k]}</span></button>`).join('')}</div>` : '';
  html += `<div id="s-mine">${section(subject === me.email ? 'My requests' : 'Their requests', mineAll.length,
    !ld('asked') ? loading() : (reqChips ? `<div class="pad">${reqChips}</div>` : '') + (mine.length ? mine.map(r => requestItem(r, 'mine')).join('') : empty('fa-solid fa-lock-open', isAgent ? 'No requests this week. Ask from a property, or from Buyers for my properties below.' : 'No requests this week.')),
    { more: '<span class="more">last 7 days · older in History</span>' })}</div>`;
  }
  // Buyers with other agents who fit my properties: request, see the answer, call — on the row.
  if (isAgent && subject === me.email && S.matches.length) {
    const c = matchCounts(S.matches);
    html += `<div id="s-buyers">${section('Buyers for my properties', S.matches.length, '<div class="pad" id="buyersBox"></div>', { hot: c.approved > 0, more: `<span class="more">${[c.approved ? c.approved + ' approved' : '', c.new ? c.new + ' not asked' : ''].filter(Boolean).join(' · ')}</span>` })}</div>`;
  }
  html += `<div id="s-visits">${section('Site visits today', visits.length,
    !leadsLoaded ? loading() : visits.length ? visits.map(v => `<div class="item"><div class="ic ${v.ic}"><i class="fa-solid fa-location-dot"></i></div>${v.html}</div>`).join('') : empty('fa-regular fa-calendar', 'No site visits today.'))}</div>`;
  if (soon.length) html += `<div id="s-soon">${section('Coming up (next 7 days)', soon.length, soon.map(v => `<div class="item"><div class="ic ${v.ic}"><i class="fa-regular fa-calendar"></i></div>${v.html}</div>`).join(''))}</div>`;
  html += `<div id="s-follow">${section('Follow-ups due', follow.length,
    !leadsLoaded ? loading() : follow.length ? follow.slice(0, 40).map(l => `<div class="item"><div class="ic ${l.followUpAt < now ? 'red' : ''}"><i class="fa-regular fa-bell"></i></div><a class="bd" href="${leadLink(l.id)}"><b>${esc(l.name || 'Lead')}</b><small>${l.followUpAt < now ? '<span class="tag red">Overdue</span> ' : ''}${esc(when(l.followUpAt))}${l.followUpNote ? ' · ' + esc(l.followUpNote) : ''}</small></a></div>`).join('')
      + (follow.length > 40 ? `<div class="empty"><a href="crm.html?nav=followups">All ${follow.length} in Follow-ups</a></div>` : '') : empty('fa-regular fa-face-smile', 'No follow-ups due. Nice.'), { hot: overdue > 0, more: '<a class="more" href="crm.html?nav=followups">All follow-ups</a>' })}</div>`;
  html += `<div id="s-new">${section('New enquiries on ' + (subject === me.email ? 'my' : 'their') + ' properties', fresh.length,
    !leadsLoaded ? loading() : fresh.length ? fresh.slice(0, 30).map(l => `<div class="item"><div class="ic green"><i class="fa-solid fa-user-plus"></i></div><a class="bd" href="${leadLink(l.id)}"><b>${esc(l.name || 'New lead')}</b><small>${esc(ago(l.createdAt))}${l.propertyInterest ? ' · ' + esc(l.propertyInterest) : ''}${isAgentSubject() && !canWorkLead(l, subject) ? ' · <span class="tag">with ' + esc(nameOf(people, l.assignedAgent)) + ' — read only</span>' : ''}</small></a></div>`).join('')
      : empty('fa-regular fa-envelope-open', S.props.length ? 'Nothing new since your last visit.' : 'No properties are assigned yet.'))}</div>`;
  if (subject === me.email) html += `<div class="card" style="margin-top:18px"><div class="item"><div class="ic"><i class="fa-regular fa-sun"></i></div><a class="bd" href="crm.html?nav=today"><b>Tasks and meetings for today</b><small>Your assigned tasks and calendar invitations are in Daily task</small></a></div></div>`;
  const subs = S.subs.filter(s => s.status === 'pending' || (s.decidedAt || 0) >= now - 3 * DAY);
  if (subs.length) html += section('Properties I sent for approval', subs.length, subs.map(s => `<div class="item"><div class="ic"><i class="fa-regular fa-building"></i></div><div class="bd"><b>${esc((s.fields || {}).name)}</b><small>${s.status === 'pending' ? '<span class="tag wait">Waiting for an admin</span>' : s.status === 'approved' ? '<span class="tag green">Approved</span> — now in your properties' : '<span class="tag red">Not approved</span>' + (s.note ? ' — ' + esc(s.note) : '')}</small></div></div>`).join(''));
  // The buyers list keeps what the agent was doing (a note half-typed) across redraws: it is moved
  // into the fresh page, not drawn again, unless its matches changed.
  const keepBuyers = $('buyersBox');
  $('sections').innerHTML = html;
  const box = $('buyersBox');
  if (box) {
    const sig = JSON.stringify(S.matches.map(m => [m.ref, m.propertyId, m.requested, m.granted && m.granted.until]));
    if (keepBuyers && keepBuyers.dataset.sig === sig) box.replaceWith(keepBuyers);
    else {
      box.dataset.sig = sig;
      renderMatches(box, S.matches, { api, toast, showProperty: true, limit: 5,
        propName: id => { const p = S.propById && S.propById.get(String(id)); return p ? (p._code ? p._code + ' · ' : '') + (p.name || '') : ''; },
        propHref: id => 'dashboard.html?property=' + encodeURIComponent(id) });
    }
  }
  bindActions($('sections'));
  restoreBoxes();
  if (window.AppNav && window.AppNav.setBadge && subject === me.email) window.AppNav.setBadge('myday', toDecide.length);
  renderHistory(reqs);
  openWanted(reqs);
  fillYourLeads(reqs);
}

function listingQueueItem(x) {
  return `<div class="item"><div class="ic brand"><i class="fa-regular fa-building" aria-hidden="true"></i></div>
    <div class="bd"><b>${esc(x.title || 'Untitled listing')}</b><small>${esc([x.location, x.config, x.askingPrice].filter(Boolean).join(' · '))} · sent by ${esc(x.agentName || nameOf(people, x.agentEmail) || 'the office')} ${esc(ago(x.sentAt))}</small>
      ${x.note ? `<div class="q">“${esc(x.note)}”</div>` : ''}
      <small>${x.deal ? (x.deal === 'rent' ? 'For rent' : 'For sale') + ' · ' : ''}${x.ownerInformed ? '✓ owner agreed' : 'owner’s agreement not ticked'}${x.ownerApproved ? ' · ✓ owner approved the photos' : ''}${x.brochure === 'created' ? ' · brochure ready' : x.brochure === 'requested' ? ' · brochure asked for' : ''}</small>
      ${x.duplicateOf && x.duplicateOf.length ? `<div class="callout warn">Possible duplicate — the same owner or title is already with us: ${esc(x.duplicateOf.join(', '))}. Check before approving.</div>` : ''}
      <div class="acts">
        <button type="button" class="btn sm primary" data-lapprove="${esc(x.id)}"><i class="fa-solid fa-check" aria-hidden="true"></i> Approve</button>
        <button type="button" class="btn sm" data-lreturn="${esc(x.id)}">Send back</button>
        ${x.photosLink ? `<a class="btn sm quiet" href="${esc(x.photosLink)}" target="_blank" rel="noopener">Photos</a>` : ''}
      </div>
      <div class="rj" data-lrj="${esc(x.id)}" hidden><label for="lrj-${esc(x.id)}">What to fix (the agent sees this)</label><textarea id="lrj-${esc(x.id)}" maxlength="500" rows="2" placeholder="e.g. Add the floor plan and the exact price"></textarea><p class="rj-err" role="alert"></p>
        <div class="acts"><button type="button" class="btn sm" data-lrjsend="${esc(x.id)}">Send back</button><button type="button" class="btn sm quiet" data-lrjback="${esc(x.id)}">Not now</button></div></div>
      <p class="qa-terms">Approving adds it to the inventory with ${esc(x.agentName || 'its agent')} as the agent; other agents see it once it goes Live.</p>
    </div></div>`;
}
function myListingItem(x) {
  const a = x.approval || {};
  const back = x.stageKey === 'details' && a.decision === 'returned';
  const tag = back ? '<span class="tag red">Sent back</span>' : x.stageKey === 'approved' ? '<span class="tag green">Approved</span>' : '<span class="tag wait">Waiting for approval</span>';
  const line = back ? `by ${esc(a.decidedByName || 'an admin')} ${esc(ago(a.decidedAt))}` : x.stageKey === 'approved' ? `by ${esc(a.decidedByName || 'an admin')} — mark it Live when marketing starts` : `sent ${esc(ago(a.sentAt || x.stageChangedAt))}`;
  return `<div class="item"><div class="ic ${back ? 'red' : x.stageKey === 'approved' ? 'green' : ''}"><i class="fa-solid fa-table-columns" aria-hidden="true"></i></div>
    <a class="bd" href="mylistings.html?id=${encodeURIComponent(x.id)}"><b>${esc(x.title || 'Untitled listing')}</b><small>${tag} ${line}</small>${back && a.note ? `<div class="q">“${esc(a.note)}”</div>` : ''}</a></div>`;
}

function renderHistory(reqs) {
  const now = Date.now();
  let list = reqs.filter(r => r.status !== 'pending');
  if (histRange) list = list.filter(r => (r.decidedAt || r.createdAt) >= now - histRange * DAY);
  if (histKind === 'given') list = list.filter(r => r.decidedBy === subject);
  if (histKind === 'mine') list = list.filter(r => r.requesterEmail === subject);
  list.sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0));
  $('history').innerHTML = list.length ? list.map(r => requestItem(r, 'mine').replace('<b>', `<b>${r.requesterEmail === subject ? '' : esc(r.requesterName) + ' — '}`)).join('') : empty('fa-solid fa-clock-rotate-left', 'Nothing decided in this period.');
  bindActions($('history'));
}

// Making the asker a co-agent is for an admin or the property's primary agent.
const canCo = r => r.kind === 'property' && (isAdmin || S.props.some(p => String(p.id) === String(r.targetId) && p.access === 'own'));

function bindActions(root) {
  const chips = root.querySelector('#reqChips');
  if (chips) chips.addEventListener('click', e => { const b = e.target.closest('[data-rf]'); if (!b) return; reqFilter = b.dataset.rf; render(); });
  // Several at once.
  const sm = root.querySelector('[data-selmode]');
  if (sm) sm.addEventListener('click', () => { selMode = !selMode; if (!selMode) sel.clear(); render(); });
  root.querySelectorAll('[data-pick]').forEach(c => c.addEventListener('change', () => { if (c.checked) sel.add(c.dataset.pick); else sel.delete(c.dataset.pick); render(); root.querySelector(`[data-pick="${CSS.escape(c.dataset.pick)}"]`)?.focus(); }));
  const pa = root.querySelector('[data-pickall]');
  if (pa) pa.addEventListener('change', () => { const ids = [...root.querySelectorAll('[data-pick]')].map(x => x.dataset.pick); if (pa.checked) ids.forEach(id => sel.add(id)); else sel.clear(); render(); root.querySelector('[data-pickall]')?.focus(); });
  const bok = root.querySelector('[data-bulkok]');
  if (bok) bok.addEventListener('click', () => {
    const list = allRequests().filter(r => sel.has(r.id) && canDecide(r));
    if (!list.length) return;
    busy(bok, () => Promise.resolve().then(() => api('decide-many', { decision: 'approve', items: list.map(quickBody) })).then(r => bulkDone(r, 'Approved')).catch(e => toast('✗ ' + e.message)));
  });
  const brj = root.querySelector('[data-bulkrj]');
  if (brj) brj.addEventListener('click', () => { const box = root.querySelector('[data-rj="__bulk"]'); if (!box) return; box.hidden = false; box.querySelector('textarea').focus(); });
  const brs = root.querySelector('[data-bulkrjsend]');
  if (brs) brs.addEventListener('click', () => {
    const box = root.querySelector('[data-rj="__bulk"]'), note = box.querySelector('textarea').value.trim(), err = box.querySelector('.rj-err');
    if (!note) { err.textContent = 'Say why — they see it'; box.querySelector('textarea').focus(); return; }
    const ids = [...sel].filter(id => allRequests().some(r => r.id === id && canDecide(r)));
    busy(brs, () => api('decide-many', { decision: 'reject', note, items: ids.map(id => ({ id })) }).then(r => bulkDone(r, 'Rejected')).catch(e => { err.textContent = e.message; }));
  });
  // One tap: approved with the admin's defaults.
  root.querySelectorAll('[data-quick]').forEach(b => b.addEventListener('click', () => {
    const r = allRequests().find(x => x.id === b.dataset.quick);
    if (!r) return;
    busy(b, () => Promise.resolve().then(() => api('decide', quickBody(r))).then(() => toast('Approved — ' + quickTerms(r).replace(/^Approve gives /, '').replace(/\. More options.*$/, ''))).catch(e => toast('✗ ' + e.message)));
  }));
  // Reject: the reason is typed right under the request (no pop-up).
  const rjOf = id => root.querySelector(`[data-rj="${CSS.escape(id)}"]`);
  root.querySelectorAll('[data-reject]').forEach(b => b.addEventListener('click', () => { const box = rjOf(b.dataset.reject); if (!box) return; box.hidden = false; box.querySelector('textarea').focus(); }));
  root.querySelectorAll('[data-rjback]').forEach(b => b.addEventListener('click', () => { const box = rjOf(b.dataset.rjback); if (box) box.hidden = true; }));
  root.querySelectorAll('[data-rjsend]').forEach(b => b.addEventListener('click', () => {
    const box = rjOf(b.dataset.rjsend), note = box.querySelector('textarea').value.trim(), err = box.querySelector('.rj-err');
    if (!note) { err.textContent = 'Say why — they see it'; box.querySelector('textarea').focus(); return; }
    busy(b, () => api('decide', { id: b.dataset.rjsend, decision: 'reject', note }).then(() => toast('Rejected — they’ve been told')).catch(e => { err.textContent = e.message; }));
  }));
  // Listings waiting for approval (admins).
  const lrjOf = id => root.querySelector(`[data-lrj="${CSS.escape(id)}"]`);
  root.querySelectorAll('[data-lapprove]').forEach(b => b.addEventListener('click', () => busy(b, () => api('listing-decide', { id: b.dataset.lapprove, decision: 'approve' })
    .then(j => { toast(j.created ? `Approved — added to the inventory as ${j.propertyCode}` : 'Approved'); loadQueue(); }).catch(e => toast('✗ ' + e.message)))));
  root.querySelectorAll('[data-lreturn]').forEach(b => b.addEventListener('click', () => { const box = lrjOf(b.dataset.lreturn); if (!box) return; box.hidden = false; box.querySelector('textarea').focus(); }));
  root.querySelectorAll('[data-lrjback]').forEach(b => b.addEventListener('click', () => { const box = lrjOf(b.dataset.lrjback); if (box) box.hidden = true; }));
  root.querySelectorAll('[data-lrjsend]').forEach(b => b.addEventListener('click', () => {
    const box = lrjOf(b.dataset.lrjsend), note = box.querySelector('textarea').value.trim(), err = box.querySelector('.rj-err');
    if (!note) { err.textContent = 'Say what to fix — the agent sees it'; box.querySelector('textarea').focus(); return; }
    busy(b, () => api('listing-decide', { id: b.dataset.lrjsend, decision: 'return', note }).then(() => { toast('Sent back to the agent'); loadQueue(); }).catch(e => { err.textContent = e.message; }));
  }));
  root.querySelectorAll('[data-decide]').forEach(b => b.addEventListener('click', async () => {
    const r = allRequests().find(x => x.id === b.dataset.decide);
    if (!r) return;
    await decideSheet(r, { canCoAgent: canCo(r), defaults: { ...(await approvalDefaults(me)), isAdmin }, role: me.role });
  }));
  root.querySelectorAll('[data-more]').forEach(b => b.addEventListener('click', () => {
    busy(b, () => api('request', { kind: 'property', targetId: b.dataset.more, need: 'time', reason: 'Asking for more time' })
      .then(() => toast('Asked for more time')).catch(e => toast('✗ ' + e.message)));
  }));
  root.querySelectorAll('[data-end]').forEach(b => b.addEventListener('click', () => {
    if (!confirm('End this access now? They are told in Messages.')) return;
    busy(b, () => api('revoke', { grantId: b.dataset.end }).then(() => toast('Access ended')).catch(e => toast('✗ ' + e.message)));
  }));
  root.querySelectorAll('[data-hide]').forEach(b => b.addEventListener('click', () => {
    if (!confirm('Stop sharing the owner’s number? They keep the other details.')) return;
    busy(b, () => api('hide-contact', { grantId: b.dataset.hide }).then(() => toast('Owner’s number hidden')).catch(e => toast('✗ ' + e.message)));
  }));
  root.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => {
    if (!confirm('Cancel this request?')) return;
    busy(b, () => api('cancel', { id: b.dataset.cancel }).then(() => toast('Request cancelled')).catch(e => toast('✗ ' + e.message)));
  }));
}

// myday.html?req=<id> (from the dashboard or a message): open that request's decision at once.
let wantedDone = false;
function openWanted(reqs) {
  const id = new URLSearchParams(location.search).get('req');
  if (!id || wantedDone) return;
  const r = reqs.find(x => x.id === id);
  if (!r) {
    if (S.loaded.approve && S.loaded.asked && !wantedDone) { wantedDone = true; toast('That request is not one of yours, or it is no longer there'); }
    return;
  }
  wantedDone = true;
  if (canDecide(r)) approvalDefaults(me).then(d => decideSheet(r, { canCoAgent: canCo(r), defaults: { ...d, isAdmin }, role: me.role }));
  else toast(r.status === 'pending' ? 'This request is waiting on someone else' : 'Already ' + r.status + (r.decidedByName ? ' by ' + r.decidedByName : ''));
}

watchAll();
// Marked seen only once the page has really been looked at (open, with its leads, for a few seconds) —
// not by a reload a moment after opening.
const markSeen = () => {
  if (!shownAt || Date.now() - shownAt < 6000 || subject !== me.email) return;
  try { localStorage.setItem(SEEN_KEY(), String(Date.now())); } catch (e) { /* private window */ }
};
window.addEventListener('pagehide', markSeen);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') markSeen(); });
