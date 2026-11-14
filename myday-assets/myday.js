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
import { $, esc, lc, api, db, isShutdown, whenSignedIn, watchMyView, directory, nameOf, when, ago, untilWords, toast, decideSheet, busy, approvalDefaults } from '../shared-assets/agent-client.js';
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import { leadViews } from '../shared-assets/lead-views-client.js';
import { canWorkLead } from '../shared-assets/agent-access.js';

const me = await whenSignedIn();
const isAdmin = me.role === 'admin';
const isAgent = me.role === 'agent';
window.AppNav.boot({ console: 'myday', select: () => {}, signOut: () => import('../shared-assets/agent-client.js').then(m => m.signOutHere()) });
window.AppNav.setActive('myday');

let people = [];
let subject = me.email;              // whose day
let unsubs = [];
const S = { asked: new Map(), approve: new Map(), pendingAll: new Map(), leads: new Map(), alerts: [], props: [], subs: [], grants: [] };
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
  Object.assign(S, { asked: new Map(), approve: new Map(), pendingAll: new Map(), leads: new Map(), alerts: [], props: [], subs: [], subsAll: [], grants: [], names: new Map(), loaded: {} });
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
      render();
    } });
    unsubs.push(() => w.stop());
    live(query(collection(db, 'propertySubmissions'), where('tenantId', '==', T), where('byEmail', '==', me.email)), 'subs', s => { S.subs = s.docs.map(d => ({ ...d.data(), id: d.id })); });
  } else {
    if (isAdmin) live(query(collection(db, 'propertySubmissions'), where('tenantId', '==', T), where('status', '==', 'pending')), 'subsAll', s => { S.subsAll = s.docs.map(d => ({ ...d.data(), id: d.id })); });
    const pc = collection(db, 'properties');
    const pp = { a: [], b: [] };
    const mergeP = () => { const m = new Map(); [...pp.a, ...pp.b].forEach(p => m.set(p.id, p)); S.props = [...m.values()]; };
    [['a', where('assignedAgent', '==', subject)], ['b', where('secondaryAgents', 'array-contains', subject)]].forEach(([k, w]) =>
      live(query(pc, where('tenantId', '==', T), w), 'props' + k, s => { pp[k] = s.docs.map(d => ({ id: d.id, code: d.data().propertyCode || d.id, name: d.data().name })); mergeP(); }));
  }
}

const isAgentSubject = () => isAgent || (people.find(p => p.email === subject) || {}).role === 'agent';

// ── Drawing ──
const allRequests = () => { const m = new Map([...S.pendingAll, ...S.approve, ...S.asked]); return [...m.values()]; };
const canDecide = r => r.status === 'pending' && r.requesterEmail !== me.email && (isAdmin || (r.approvers || []).includes(me.email));
const statusTag = r => ({ pending: '<span class="tag wait">Waiting</span>', approved: '<span class="tag green">Approved</span>', rejected: '<span class="tag red">Rejected</span>',
  cancelled: '<span class="tag">Cancelled</span>', expired: '<span class="tag">Expired</span>' }[r.status] || '');
const reqTitle = r => r.kind === 'lead' ? 'A matching buyer’s details' : r.need === 'time' ? 'More time on ' + esc(r.title) : r.need === 'number' ? 'The owner’s number for ' + esc(r.title) : esc(r.title);
const terms = r => {
  const t = r.terms || {};
  if (r.status !== 'approved') return '';
  if (r.grantState === 'revoked') return 'access taken back' + (r.grantChangedByName ? ' by ' + r.grantChangedByName : '');
  if (r.grantState === 'expired') return 'access ended';
  if (t.coAgent) return 'now a co-agent';
  return (t.until ? 'details ' + untilWords(t.until) : 'details with no time limit') + (t.contact ? ' · owner’s number ' + (t.contactUntil ? untilWords(t.contactUntil) : 'shared') : '');
};

function requestItem(r, mode) {
  const ic = r.kind === 'lead' ? 'fa-user-lock' : 'fa-building-lock';
  const decided = r.status !== 'pending' ? `${statusTag(r)} by ${esc(r.decidedByName || nameOf(people, r.decidedBy))} ${esc(ago(r.decidedAt))}${terms(r) ? ' · ' + esc(terms(r)) : ''}` : statusTag(r) + ' asked ' + esc(ago(r.createdAt));
  const head = mode === 'approve'
    ? `<b>${esc(r.requesterName)} asks for ${reqTitle(r).replace(/^(More|The|A) /, m => m.toLowerCase())}</b><small>${r.clientName ? 'For their client ' + esc(r.clientName) + ' · ' : ''}${esc(ago(r.createdAt))}${r.visitAt ? ' · visit wanted ' + esc(when(r.visitAt)) : ''}</small>`
    : `<b>${reqTitle(r)}</b><small>${decided}</small>`;
  return `<div class="item"><div class="ic ${mode === 'approve' ? 'brand' : r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : ''}"><i class="fa-solid ${ic}"></i></div>
    <div class="bd">${head}${r.reason && mode === 'approve' ? `<div class="q">“${esc(r.reason)}”</div>` : ''}${r.note && r.status !== 'pending' ? `<div class="q">${esc(r.note)}</div>` : ''}
      <div class="acts">
        ${canDecide(r) ? `<button type="button" class="btn sm primary" data-decide="${esc(r.id)}">Approve or reject</button>` : ''}
        ${r.threadId ? `<a class="btn sm" href="messages.html?t=${encodeURIComponent(r.threadId)}"><i class="fa-regular fa-comments"></i> Message</a>` : ''}
        ${r.status === 'pending' && r.requesterEmail === me.email ? `<button type="button" class="btn sm danger" data-cancel="${esc(r.id)}">Cancel</button>` : ''}
        ${r.status === 'approved' && !r.grantState && r.kind === 'property' && r.requesterEmail === me.email ? `<a class="btn sm" href="listings.html?id=${encodeURIComponent(r.targetId)}">Open property</a>` : ''}
      </div></div></div>`;
}

function section(title, n, body, { hot = false, more = '' } = {}) {
  return `<div class="sec-h">${title} <span class="n${hot && n ? ' hot' : ''}">${n}</span>${more}</div><div class="card">${body}</div>`;
}
const empty = (icon, text) => `<div class="empty"><i class="${icon}"></i>${text}</div>`;
const loading = () => '<div class="sk"></div>';

function render() {
  if (!S.loaded) return;
  const now = Date.now(), sod = startOfDay(now), eod = endOfDay(now);
  const reqs = allRequests();
  const toDecide = reqs.filter(canDecide).sort((a, b) => a.createdAt - b.createdAt);
  const mine = reqs.filter(r => r.requesterEmail === subject && (r.status === 'pending' || (r.decidedAt || 0) >= now - DAY)).sort((a, b) => b.createdAt - a.createdAt);
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
    const words = { booked: 'booked a visit', moved: 'moved a visit', cancelled: 'called off a visit', done: 'finished a visit' }[a.kind] || 'a visit';
    visits.push({ at: a.at || a.createdAt, ic: a.kind === 'cancelled' ? 'red' : 'brand', html: `<div class="bd"><b><span class="tag brand">Collaboration visit</span> ${esc(a.propertyTitle)}</b><small>${esc(a.byName)} ${words} for ${esc(a.clientName)}${a.at ? ' · ' + esc(when(a.at)) : ''}</small></div>` });
  });
  visits.sort((a, b) => (a.at || 0) - (b.at || 0));
  // Follow-ups: only leads the person works (not ones they can merely read). Overdue as the CRM
  // counts it: past its time, not past midnight.
  const follow = workable.filter(l => l.followUpAt && l.followUpAt <= eod && !CLOSED.test(String(l.stageId || ''))).sort((a, b) => a.followUpAt - b.followUpAt);
  const overdue = follow.filter(l => l.followUpAt < now).length;
  const codes = new Set(S.props.flatMap(p => [String(p.code || ''), String(p.id)]));
  const fresh = workable.filter(l => (l.createdAt || 0) > (seenBefore || now - 3 * DAY) && (l.propertyCodes || []).some(c => codes.has(String(c)))).sort((a, b) => b.createdAt - a.createdAt);

  const h = new Date().getHours();
  const name = nameOf(people, subject).split(' ')[0];
  $('hello').innerHTML = `<b>${subject === me.email ? (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + (name ? ', ' + esc(name) : '') : esc(nameOf(people, subject)) + '’s day'}</b><small>${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</small>`;
  $('stats').innerHTML = [...(isAgent || isAdmin || isAgentSubject() ? [[toDecide.length, 'to approve', '#s-approve', toDecide.length]] : []), [visits.length, 'visits today', '#s-visits', 0], [follow.length, 'follow-ups', '#s-follow', overdue], [fresh.length, 'new enquiries', '#s-new', fresh.length]]
    .map(([n, l, href, hot]) => `<a class="stat${hot ? ' hot' : ''}" href="${href}"><b>${n}</b><small>${l}</small></a>`).join('');
  const ld = k => S.loaded[k];
  const leadsLoaded = ld('leadsa') && ld('leadsb') && ld('leadsc');
  if (leadsLoaded && !shownAt) shownAt = Date.now();
  let html = '';
  // Full-access staff are never asked to approve and never need to ask: those two sections are for
  // agents and admins.
  const asksAndApproves = isAgent || isAdmin || isAgentSubject();
  if (isAdmin && subject === me.email && S.subsAll.length) html += section('Properties agents added', S.subsAll.length, `<div class="item"><div class="ic brand"><i class="fa-regular fa-building"></i></div><div class="bd"><b>${S.subsAll.length === 1 ? 'One property is' : S.subsAll.length + ' properties are'} waiting for your approval</b><small>${esc(S.subsAll.map(x => (x.fields || {}).name).filter(Boolean).slice(0, 3).join(' · '))}</small><div class="acts"><a class="btn sm primary" href="team.html?tab=requests">Review in Team &amp; access</a></div></div></div>`, { hot: true });
  if (asksAndApproves) html += `<div id="s-approve">${section('Approvals waiting on ' + (subject === me.email ? 'me' : esc(name)), toDecide.length,
    !ld('approve') ? loading() : toDecide.length ? toDecide.map(r => requestItem(r, 'approve')).join('') : empty('fa-regular fa-circle-check', 'Nothing waiting for a decision.'), { hot: true })}</div>`;
  if (asksAndApproves) {
  const ending = S.grants.filter(g => g.active && g.expiresAt && g.expiresAt > now && g.expiresAt < now + 2 * DAY).sort((a, b) => a.expiresAt - b.expiresAt);
  if (ending.length) html += `<div id="s-ending">${section('Access ending soon', ending.length, ending.map(g => `<div class="item"><div class="ic blue"><i class="fa-regular fa-hourglass-half"></i></div>
    <div class="bd"><b>${g.kind === 'lead' ? 'A buyer’s details' : esc(g.title)}</b><small>Details ${esc(untilWords(g.expiresAt))}${g.includeContact && g.contactExpiresAt > now ? ' · owner’s number ' + esc(untilWords(g.contactExpiresAt)) : ''}</small>
      ${subject === me.email && g.kind === 'property' ? `<div class="acts"><button type="button" class="btn sm" data-more="${esc(g.targetId)}">Ask for more time</button><a class="btn sm" href="listings.html?id=${encodeURIComponent(g.targetId)}">Open property</a></div>` : ''}</div></div>`).join(''), { hot: true })}</div>`;
  html += `<div id="s-mine">${section(subject === me.email ? 'My requests' : 'Their requests', mine.length,
    !ld('asked') ? loading() : mine.length ? mine.map(r => requestItem(r, 'mine')).join('') : empty('fa-solid fa-lock-open', isAgent ? 'No open requests. Ask for a property’s details from Properties → All.' : 'No open requests.'))}</div>`;
  }
  html += `<div id="s-visits">${section('Site visits today', visits.length,
    !leadsLoaded ? loading() : visits.length ? visits.map(v => `<div class="item"><div class="ic ${v.ic}"><i class="fa-solid fa-location-dot"></i></div>${v.html}</div>`).join('') : empty('fa-regular fa-calendar', 'No site visits today.'))}</div>`;
  html += `<div id="s-follow">${section('Follow-ups due', follow.length,
    !leadsLoaded ? loading() : follow.length ? follow.slice(0, 40).map(l => `<div class="item"><div class="ic ${l.followUpAt < now ? 'red' : ''}"><i class="fa-regular fa-bell"></i></div><a class="bd" href="${leadLink(l.id)}"><b>${esc(l.name || 'Lead')}</b><small>${l.followUpAt < now ? '<span class="tag red">Overdue</span> ' : ''}${esc(when(l.followUpAt))}${l.followUpNote ? ' · ' + esc(l.followUpNote) : ''}</small></a></div>`).join('')
      + (follow.length > 40 ? `<div class="empty"><a href="crm.html?nav=followups">All ${follow.length} in Follow-ups</a></div>` : '') : empty('fa-regular fa-face-smile', 'No follow-ups due. Nice.'), { hot: overdue > 0, more: '<a class="more" href="crm.html?nav=followups">All follow-ups</a>' })}</div>`;
  html += `<div id="s-new">${section('New enquiries on ' + (subject === me.email ? 'my' : 'their') + ' properties', fresh.length,
    !leadsLoaded ? loading() : fresh.length ? fresh.slice(0, 30).map(l => `<div class="item"><div class="ic green"><i class="fa-solid fa-user-plus"></i></div><a class="bd" href="${leadLink(l.id)}"><b>${esc(l.name || 'New lead')}</b><small>${esc(ago(l.createdAt))}${l.propertyInterest ? ' · ' + esc(l.propertyInterest) : ''}</small></a></div>`).join('')
      : empty('fa-regular fa-envelope-open', S.props.length ? 'Nothing new since your last visit.' : 'No properties are assigned yet.'))}</div>`;
  const subs = S.subs.filter(s => s.status === 'pending' || (s.decidedAt || 0) >= now - 3 * DAY);
  if (subs.length) html += section('Properties I sent for approval', subs.length, subs.map(s => `<div class="item"><div class="ic"><i class="fa-regular fa-building"></i></div><div class="bd"><b>${esc((s.fields || {}).name)}</b><small>${s.status === 'pending' ? '<span class="tag wait">Waiting for an admin</span>' : s.status === 'approved' ? '<span class="tag green">Approved</span> — now in your properties' : '<span class="tag red">Not approved</span>' + (s.note ? ' — ' + esc(s.note) : '')}</small></div></div>`).join(''));
  $('sections').innerHTML = html;
  bindActions($('sections'));
  if (window.AppNav && window.AppNav.setBadge && subject === me.email) window.AppNav.setBadge('myday', toDecide.length);
  renderHistory(reqs);
  openWanted(reqs);
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
  root.querySelectorAll('[data-decide]').forEach(b => b.addEventListener('click', async () => {
    const r = allRequests().find(x => x.id === b.dataset.decide);
    if (!r) return;
    await decideSheet(r, { canCoAgent: canCo(r), defaults: await approvalDefaults(me) });
  }));
  root.querySelectorAll('[data-more]').forEach(b => b.addEventListener('click', () => {
    busy(b, () => api('request', { kind: 'property', targetId: b.dataset.more, need: 'time', reason: 'Asking for more time' })
      .then(() => toast('Asked for more time')).catch(e => toast('✗ ' + e.message)));
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
  if (!r) return;
  wantedDone = true;
  if (canDecide(r)) approvalDefaults(me).then(d => decideSheet(r, { canCoAgent: canCo(r), defaults: d }));
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
