// ═══════ MESSAGES (messages.html) — the team's own chat ═══════
// Agent ↔ agent and agent ↔ admin, WhatsApp style. Not client messaging (that stays on TailorTalk).
//   threads/{id}            { title, type: direct | property | lead | general (| access_request, before
//                             26 Nov 2026 — folded into the people's chat, foldedInto), linkedId, members,
//                             names, lastAt, lastText, lastBy, reads: { key: ms } }
//   threads/{id}/messages   { kind: text | system, text, at, by, replyTo? }
//                           replyTo: the id of the message it answers, in this thread (the quote is
//                           drawn from that message itself, so it can't be made up — firestore.rules).
// Threads are opened by the server (/api/agent thread-open; a request opens its own). A member
// writes their own text messages, the thread's last line as themselves, and their own read mark —
// the only things firestore.rules let them write. What is unread is worked out from each person's
// own read mark; read ticks from the others' marks (a message is read once every other member's mark
// has passed it).
// Requests (owner, 26 Nov 2026): one chat per set of people ('direct'). Each request is a card in it
// (kind 'request', requestId) with Approve / Reject on the card and its status live; everything about
// one request — decisions, visits, the team's replies — answers the card (replyTo) and lives in the
// card's own thread, a panel beside the chat. Decision lines also show small in the chat.
import { $, esc, lc, emailKey, api, db, isShutdown, whenSignedIn, directory, nameOf, when, toast, openSheet, decideSheet, busy, approvalDefaults, codeLine } from '../shared-assets/agent-client.js';
import { collection, query, where, onSnapshot, orderBy, limit, doc, writeBatch, updateDoc, getDoc } from "../shared-assets/fs-metered.js";

const me = await whenSignedIn();
const isAdmin = me.role === 'admin', isAgent = me.role === 'agent';
const myKey = emailKey(me.email);
window.AppNav.boot({ console: 'messages', select: () => {}, signOut: () => import('../shared-assets/agent-client.js').then(m => m.signOutHere()) });
window.AppNav.setUser(me.email);
window.AppNav.setActive('messages');

let people = [];
let threads = [];
let filter = 'all', q = '', everyone = false;
let openId = null, msgUnsub = null, reqUnsub = null, msgs = [], openThread = null, openReq = null;
let threadUnsub = null, docUnsub = null, wantTried = false, chatPushed = false;
// Replying: the message being answered (shown above the box until sent or ✕), and the answered
// messages older than the 300 loaded — fetched once by id, so their quotes still show.
let replyTo = null, lastSwipeEnd = 0, msgsLoaded = false;   // (msgsLoaded: "no messages yet" only once they have come)
const quoted = new Map();   // id → message | null (being fetched) | false (not there)
// Request cards: each card's request, live (id → request | null when it is not there / not ours).
const reqs = new Map(), reqUnsubs = new Map();
let sideCard = null, wantReq = new URLSearchParams(location.search).get('r'), foldTried = false;
// Waiting on me, for the chat list ("3 waiting"): admins every pending request, others theirs to decide.
let waitingByThread = new Map();
// What one tap on Approve gives (the admin's defaults — team.html → What agents see → Approvals).
let QD = null;
approvalDefaults(me).then(d => { QD = d || {}; renderChat(); renderSide(); renderWaiting(); }).catch(() => { QD = {}; });
// Is this property one I am the primary agent of (my own copy says so)?
let myViewP = null;
function isMyOwnProperty(id) {
  if (!isAgent) return Promise.resolve(false);
  if (!myViewP) myViewP = getDoc(doc(db, 'agentViews', me.tenantId + '__' + me.uid)).then(s => (s.exists() ? s.data().props || [] : [])).catch(() => []);
  return myViewP.then(props => props.some(p => String(p.id) === String(id) && p._access === 'own'));
}

directory().then(p => { people = p; renderList(); if (openThread) renderChat(); });
// Unread: the conversation's last line is newer than my read mark, and not mine. Worked out here from
// my own mark — nobody writes anyone else's counter.
const isUnread = t => !!t && !!t.lastAt && t.lastBy !== me.email && (t.members || []).includes(me.email) && t.lastAt > Number((t.reads || {})[myKey] || 0);

let plainThreads = false;   // the index is not there (yet): the plain query, sorted here
function watchThreads() {
  if (threadUnsub) threadUnsub();
  const base = collection(db, 'threads');
  // The newest conversations (an index keeps this one read per conversation shown, however long the
  // history grows).
  const scope = everyone && isAdmin ? [where('tenantId', '==', me.tenantId)] : [where('tenantId', '==', me.tenantId), where('members', 'array-contains', me.email)];
  const qq = plainThreads ? query(base, ...scope) : query(base, ...scope, orderBy('lastAt', 'desc'), limit(everyone && isAdmin ? 200 : 150));
  threadUnsub = onSnapshot(qq, { includeMetadataChanges: true }, s => {
    // An empty answer from this device's copy is not "no conversations": wait for the server's.
    if (s.metadata.fromCache && !s.docs.length && !threads.length && navigator.onLine !== false) return;
    threads = s.docs.map(d => ({ ...d.data(), id: d.id })).filter(t => !t.foldedInto).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    renderList();
    // Chats from before 26 Nov (one per request): folded into the people's chat, once.
    if (!foldTried && threads.some(t => t.type === 'access_request' && (t.members || []).includes(me.email))) {
      foldTried = true;
      api('threads-fold').catch(e => console.error('fold:', e.message));
    }
    if (window.AppNav && window.AppNav.setBadge) window.AppNav.setBadge('messages', threads.filter(isUnread).length);
    const want = new URLSearchParams(location.search).get('t');
    if (want && !openId && !wantTried) {
      wantTried = true;
      if (threads.some(t => t.id === want)) openChat(want);
      else getDoc(doc(db, 'threads', want)).then(sn => { if (sn.exists()) openChat(want); else toast('That conversation is no longer there'); })
        .catch(() => toast('That conversation is not one of yours'));
    }
  }, err => {
    if (isShutdown(err)) return;
    if (!plainThreads && (err.code === 'failed-precondition' || /index/i.test(err.message || ''))) { plainThreads = true; watchThreads(); return; }
    $('threads').innerHTML = `<div class="empty"><i class="fa-solid fa-triangle-exclamation"></i>${esc(err.message)}</div>`;
  });
}
watchThreads();
{
  const rq = collection(db, 'accessRequests');
  const qq = isAdmin ? query(rq, where('tenantId', '==', me.tenantId), where('status', '==', 'pending'))
    : query(rq, where('tenantId', '==', me.tenantId), where('approvers', 'array-contains', me.email));
  onSnapshot(qq, s => {
    const m = new Map();
    s.docs.map(d => ({ ...d.data(), id: d.id })).filter(r => canDecide(r) && r.threadId).forEach(r => m.set(r.threadId, (m.get(r.threadId) || 0) + 1));
    waitingByThread = m; renderList();
  }, () => {});
}

if (isAdmin) {
  const c = document.createElement('button');
  c.type = 'button'; c.className = 'chip'; c.setAttribute('aria-pressed', 'false'); c.textContent = 'Everyone’s';
  c.title = 'Admins can read every conversation';
  c.addEventListener('click', () => { everyone = !everyone; c.setAttribute('aria-pressed', String(everyone)); watchThreads(); });
  $('filters').appendChild(c);
}
$('filters').addEventListener('click', e => {
  const b = e.target.closest('[data-f]'); if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll('#filters [data-f]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  renderList();
});
$('q').addEventListener('input', e => { q = e.target.value.trim().toLowerCase(); renderList(); });

// "Access: 3 BHK, Anna Nagar · for Arjun" — the lock icon already says it is a request. A people's
// chat is named after the others in it.
const othersOf = t => (t.members || []).filter(e => e !== me.email);
const shortTitle = t => t.type === 'direct' ? (othersOf(t).map(e => nameOf(people, e)).join(', ') || String(t.title || ''))
  : t.type === 'access_request' ? String(t.title || '').replace(/^(Access|More time|Owner’s number):\s*/, m => m.startsWith('Access') ? '' : m) : String(t.title || '');
const ICON = { access_request: 'fa-solid fa-lock-open', property: 'fa-regular fa-building', lead: 'fa-regular fa-user', general: 'fa-regular fa-comments', direct: 'fa-solid fa-user-group' };
const initials = t => { const o = othersOf(t); if (o.length !== 1) return ''; const n = nameOf(people, o[0]).trim().split(/\s+/); return ((n[0] || '')[0] || '') + ((n[1] || '')[0] || ''); };
const canDecide = r => !!r && r.status === 'pending' && r.requesterEmail !== me.email && (isAdmin || (r.approvers || []).includes(me.email));
const short = t => {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).replace(/\b(am|pm)\b/g, m => m.toUpperCase());
  if (now - d < 6 * 86400000) return d.toLocaleDateString('en-IN', { weekday: 'short' });
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
function renderList() {
  let list = threads;
  if (filter !== 'all') list = list.filter(t => filter === 'requests' ? t.type === 'direct' || t.type === 'access_request' : t.type === filter);
  if (q) list = list.filter(t => [t.title, shortTitle(t), ...(t.members || []).map(e => nameOf(people, e))].join(' ').toLowerCase().includes(q));
  $('threads').innerHTML = list.length ? list.map(t => {
    const n = isUnread(t);
    const by = t.lastBy ? (t.lastBy === me.email ? 'You: ' : nameOf(people, t.lastBy).split(' ')[0] + ': ') : '';
    const others = (t.members || []).filter(e => e !== me.email).map(e => nameOf(people, e).split(' ')[0]).join(', ');
    const w = waitingByThread.get(t.id) || 0, ini = t.type === 'direct' ? initials(t) : '';
    return `<div class="thread${n ? ' unread' : ''}" role="button" tabindex="0" data-id="${esc(t.id)}">
      <div class="av${ini ? ' ini' : ''}">${ini ? esc(ini.toUpperCase()) : `<i class="${ICON[t.type] || ICON.general}"></i>`}</div>
      <div class="bd"><b>${esc(shortTitle(t))}</b><small>${t.lastText ? esc(by + t.lastText) : esc(others)}</small></div>
      <div class="side"><span>${esc(short(t.lastAt))}</span>${w ? `<span class="wt" title="Requests waiting for your decision">${w} waiting</span>` : ''}${n ? '<span class="ub" aria-label="Unread"></span>' : ''}</div></div>`;
  }).join('') : `<div class="empty"><i class="fa-regular fa-comments"></i>${q || filter !== 'all' ? 'No conversations here.' : 'No conversations yet. A request for details opens one; so does “Message” on a property or a lead, or New.'}</div>`;
  $('threads').querySelectorAll('.thread').forEach(el => {
    el.addEventListener('click', () => openChat(el.dataset.id, { push: true }));
    el.addEventListener('keydown', e => { if (e.key === 'Enter') openChat(el.dataset.id, { push: true }); });
    if (el.dataset.id === openId) el.setAttribute('aria-current', 'true');
  });
}

// ── One conversation ──
// push: a conversation opened by a tap is a step the browser's Back undoes (it closes the chat, it does
// not leave Messages).
function openChat(id, { push = false } = {}) {
  const wasOpen = !!openId;
  closeChat(true);
  openId = id;
  openThread = threads.find(t => t.id === id) || null;
  msgs = [];
  document.body.classList.add('chat-open');
  $('chat').hidden = false;
  $('chat').innerHTML = `
    <div class="chat-h"><button type="button" class="btn sm" id="back" aria-label="Back to conversations"><i class="fa-solid fa-arrow-left"></i></button><div class="t" id="chatTitle"></div></div>
    <div id="pinned"></div>
    <div class="msgs" id="msgs" aria-live="polite"><div class="day">Loading…</div></div>
    <div class="replybar" id="replyBar" hidden></div>
    <form class="compose" id="compose"><textarea id="text" rows="1" maxlength="4000" placeholder="Message" aria-label="Message"></textarea><button type="submit" class="send" id="send" aria-label="Send"><i class="fa-solid fa-paper-plane"></i></button></form>
    <aside class="rside" id="side" hidden aria-labelledby="sideT">
      <div class="rside-h"><button type="button" class="btn sm" id="sideBack" aria-label="Back to the conversation"><i class="fa-solid fa-arrow-left"></i></button><div class="t"><b id="sideT">Request</b><small id="sideS"></small></div><button type="button" class="x" id="sideX" aria-label="Close the request" title="Close"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="rside-b" id="sideBody"></div>
      <form class="compose" id="sideCompose"><textarea id="sideText" rows="1" maxlength="4000" placeholder="Reply about this request" aria-label="Reply about this request"></textarea><button type="submit" class="send" aria-label="Send the reply"><i class="fa-solid fa-paper-plane"></i></button></form>
    </aside>`;
  $('back').addEventListener('click', () => closeChat());
  replyTo = null; msgsLoaded = false; quoted.clear(); untap();
  const ta = $('text');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 900px)').matches) { e.preventDefault(); send(); } });
  $('compose').addEventListener('submit', e => { e.preventDefault(); send(); });
  $('sideX').addEventListener('click', () => closeSide());
  $('sideBack').addEventListener('click', () => closeSide());
  const st = $('sideText');
  st.addEventListener('input', () => { st.style.height = 'auto'; st.style.height = Math.min(140, st.scrollHeight) + 'px'; });
  st.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 900px)').matches) { e.preventDefault(); sendSide(); } });
  $('sideCompose').addEventListener('submit', e => { e.preventDefault(); sendSide(); });
  const url = new URL(location.href); url.searchParams.set('t', id);
  if (push && !wasOpen) { history.pushState({ chat: id }, '', url); chatPushed = true; }
  else { history.replaceState({ ...(history.state || {}), chat: id }, '', url); if (!wasOpen) chatPushed = false; }
  if (window.matchMedia('(min-width: 900px)').matches) setTimeout(() => { const t = $('text'); if (t && !$('compose').hidden) t.focus(); }, 50);
  renderList();
  renderHeader();
  // includeMetadataChanges: told also when a message this page sent reaches the server, so its clock
  // turns into ticks (without it the page hears nothing until the next message arrives).
  msgUnsub = onSnapshot(query(collection(db, 'threads', id, 'messages'), orderBy('at', 'desc'), limit(300)), { includeMetadataChanges: true }, s => {
    msgs = s.docs.map(d => ({ ...d.data(), id: d.id, pending: d.metadata.hasPendingWrites })).reverse();
    msgsLoaded = true;
    watchCards();
    renderChat(); renderSide(); renderWaiting();
    markRead();
    // myday.html → "Message" on a request: its card's thread opens.
    if (wantReq) { const c = msgs.find(m => m.kind === 'request' && m.requestId === wantReq); if (c) { wantReq = null; openSide(c.id); } }
  }, err => { if (!isShutdown(err)) $('msgs').innerHTML = `<div class="sys">${esc(err.message)}</div>`; });
  // The thread itself, live (it may be brand new and not in the list yet).
  docUnsub = onSnapshot(doc(db, 'threads', id), s => {
    if (!s.exists()) { $('msgs').innerHTML = '<div class="sys">This conversation is not there any more.</div>'; return; }
    openThread = { ...s.data(), id: s.id };
    // A chat from before 26 Nov, folded: on to the people's chat, at that request's card.
    if (openThread.foldedInto) { wantReq = wantReq || openThread.linkedId || null; const to = openThread.foldedInto; setTimeout(() => openChat(to), 0); return; }
    renderHeader(); renderChat(); markRead();
    if ($('compose')) $('compose').hidden = !(openThread.members || []).includes(me.email);
    if (!canReply() && replyTo) { replyTo = null; renderReplyBar(); }
    if (!reqUnsub && openThread.type === 'access_request' && openThread.linkedId) {
      reqUnsub = onSnapshot(doc(db, 'accessRequests', openThread.linkedId), r => { openReq = r.exists() ? { ...r.data(), id: r.id } : null; renderPinned(); }, () => {});
    }
  }, err => { $('msgs').innerHTML = `<div class="sys">${esc(err.code === 'permission-denied' ? 'You are not in this conversation.' : err.message)}</div>`; });
}
window.addEventListener('popstate', () => {
  const t = new URLSearchParams(location.search).get('t');
  if (!t && openId) closeChat(false, { fromHistory: true });
  else if (t && t !== openId && threads.some(x => x.id === t)) openChat(t);
});
function closeChat(silent, { fromHistory = false } = {}) {
  if (msgUnsub) msgUnsub(); if (reqUnsub) reqUnsub(); if (docUnsub) docUnsub();
  msgUnsub = reqUnsub = docUnsub = null; openId = null; openThread = null; openReq = null; replyTo = null; sideCard = null;
  reqUnsubs.forEach(u => u()); reqUnsubs.clear(); reqs.clear();
  if (!silent) {
    $('chat').hidden = true; $('chat').innerHTML = ''; document.body.classList.remove('chat-open');
    if (!fromHistory) {
      // Back one step only when opening it added one (a tapped conversation); a chat opened from a
      // link or a new one just leaves the address — never Messages itself.
      if (chatPushed) { chatPushed = false; history.back(); }
      else { const url = new URL(location.href); url.searchParams.delete('t'); history.replaceState(null, '', url); }
    } else chatPushed = false;
    renderList();
  }
}
// Escape: first drops a reply being written, then closes the conversation.
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || e.defaultPrevented || !openId || document.querySelector('.sheet')) return;   // (a sheet's own Escape is not ours)
  if (sideCard) { closeSide(); return; }
  if (replyTo) { replyTo = null; renderReplyBar(); return; }
  closeChat();
});

function renderHeader() {
  const t = openThread;
  if (!t || !$('chatTitle')) return;
  const others = (t.members || []).filter(e => e !== me.email).map(e => nameOf(people, e));
  const link = t.type === 'property' && t.linkedId ? (isAgent ? 'dashboard.html?property=' : 'property.html?id=') + encodeURIComponent(t.linkedId)
    : t.type === 'lead' && t.linkedId ? 'crm.html?lead=' + encodeURIComponent(t.linkedId)
    : t.type === 'access_request' && t.linkedId ? 'myday.html?req=' + encodeURIComponent(t.linkedId) : '';
  const sub = t.type === 'direct' ? 'Requests and messages' + (others.length > 1 ? ' · ' + others.length + ' people' : '') : others.join(', ');
  $('chatTitle').outerHTML = `<${link ? `a href="${esc(link)}"` : 'div'} class="t" id="chatTitle"><b>${esc(shortTitle(t))}</b><small>${esc(sub)}${link ? ' · tap to open' : ''}</small></${link ? 'a' : 'div'}>`;
  const member = (t.members || []).includes(me.email);
  let note = document.getElementById('roNote');
  if (!member && !note) { note = document.createElement('div'); note.id = 'roNote'; note.className = 'readonly-note'; note.textContent = 'You are reading this as an admin — you are not in this conversation, so you cannot reply.'; $('pinned').before(note); }
}
function renderPinned() {
  const r = openReq, el = $('pinned');
  if (!el) return;
  if (!r) { el.innerHTML = ''; return; }
  const mineReq = r.requesterEmail === me.email;
  const can = r.status === 'pending' && !mineReq && (isAdmin || (r.approvers || []).includes(me.email));
  const byWho = e => (e === me.email ? 'you' : (r.decidedByName || nameOf(people, e)));
  const st = { pending: mineReq ? 'Waiting for a decision' : 'Waiting for your decision', approved: `Approved by ${byWho(r.decidedBy)} · ${when(r.decidedAt)}`,
    rejected: `Not approved by ${byWho(r.decidedBy)} · ${when(r.decidedAt)}`, cancelled: (mineReq ? 'You' : r.requesterName) + ' cancelled it', expired: 'Expired — nobody decided in time' }[r.status] || r.status;
  const what = r.kind === 'lead' ? 'a matching buyer' + (r.title ? ' — ' + String(r.title).replace(/^Lead:\s*/, '') : '') : r.need === 'time' ? 'more time on ' + r.title : r.need === 'number' ? 'the owner’s number for ' + r.title : r.title;
  // Hiding the owner's number leaves the details shared: still live access.
  const live = r.status === 'approved' && (!r.grantState || r.grantState === 'contact-hidden');
  // The property's code for everyone on it; the approvers (and admins) also get it in a new tab, to
  // look before deciding. The asker has "Open property" below once it is shared.
  el.innerHTML = `<div class="pinned"><b><i class="fa-solid fa-thumbtack" style="color:var(--ink3)"></i> ${mineReq ? 'You' : esc(r.requesterName)} asked for ${esc(what)}</b>
    ${codeLine(r, me.role, { link: !mineReq })}
    <div><span class="tag ${live ? 'green' : r.status === 'rejected' ? 'red' : r.status === 'pending' ? 'wait' : ''}">${esc(r.grantState === 'revoked' ? 'Access taken back' : r.grantState === 'expired' ? 'Access ended' : r.grantState === 'contact-hidden' ? st + ' · owner’s number hidden' : st)}</span></div>
    <div class="acts">
      ${can ? '<button type="button" class="btn sm primary" id="pDecide">Approve or reject</button>' : ''}
      ${r.status === 'pending' && mineReq ? '<button type="button" class="btn sm danger" id="pCancel">Cancel request</button>' : ''}
      ${live && mineReq && r.kind === 'property' ? `<a class="btn sm primary" href="dashboard.html?property=${encodeURIComponent(r.targetId)}">Open property</a>` : ''}
      ${live && mineReq && r.kind === 'lead' ? '<button type="button" class="btn sm primary" id="pOpenLead">Open in Leads</button>' : ''}
      ${live && mineReq && r.kind === 'property' && r.terms && r.terms.until && r.terms.until - Date.now() < 2 * 86400000 ? '<button type="button" class="btn sm" id="pMore">Ask for more time</button>' : ''}
    </div></div>`;
  if (!el.querySelector('.acts').children.length) el.querySelector('.acts').remove();
  if ($('pDecide')) $('pDecide').addEventListener('click', async () => decideSheet(r, { canCoAgent: r.kind === 'property' && (isAdmin || await isMyOwnProperty(r.targetId)), defaults: { ...(await approvalDefaults(me)), isAdmin }, role: me.role }));
  if ($('pCancel')) $('pCancel').addEventListener('click', e => { if (confirm('Cancel this request?')) busy(e.currentTarget, () => api('cancel', { id: r.id }).catch(x => toast('✗ ' + x.message))); });
  if ($('pMore')) $('pMore').addEventListener('click', e => busy(e.currentTarget, () => api('request', { kind: 'property', targetId: r.targetId, need: 'time', reason: 'Asking for more time' }).then(() => toast('Asked for more time')).catch(x => toast('✗ ' + x.message))));
  // The lead opened to them: its id is on their own grant (they can read it), never on the request.
  if ($('pOpenLead')) $('pOpenLead').addEventListener('click', () => getDoc(doc(db, 'grants', r.grantId)).then(g => { if (g.exists()) location.href = 'crm.html?lead=' + encodeURIComponent(g.data().targetId); }).catch(() => toast('Could not open it — try again')));
}
function renderChat() {
  const box = $('msgs');
  if (!box) return;
  // A finger on a message: redraw once it lifts (a redraw would swap the element under the finger, and
  // Safari would send the rest of the touch to the removed one — the swipe stuck).
  if (swipe) { drawLater = true; return; }
  const t = openThread || {};
  const others = (t.members || []).filter(e => e !== me.email);
  const readAt = Math.min(...others.map(e => (t.reads || {})[emailKey(e)] || 0), Infinity);
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const rp = canReply() ? id => `<button type="button" class="rp" data-reply="${esc(id)}" aria-label="Reply" title="Reply"><i class="fa-solid fa-reply"></i></button>` : () => '';
  const tap = id => (id === tappedId ? ' tapped' : '');
  let lastDay = '', html = '';
  // A request's replies live in its card's thread; its updates (approved, a visit…) also show here, small.
  const cards = cardMap();
  const shown = msgs.filter(m => !(m.replyTo && cards.has(m.replyTo) && m.kind !== 'system'));
  shown.forEach((m, i) => {
    const day = new Date(m.at || Date.now()).toDateString();
    if (day !== lastDay) { lastDay = day; html += `<div class="day">${esc(new Date(m.at || Date.now()).toDateString() === new Date().toDateString() ? 'Today' : new Date(m.at).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }))}</div>`; }
    if (m.kind === 'request') { html += cardHtml(m); return; }
    if (m.kind === 'system' && m.replyTo && cards.has(m.replyTo)) { html += `<button type="button" class="sys sysreq" data-side="${esc(m.replyTo)}" title="Open this request">${esc(reqLabel(cards.get(m.replyTo)))}${esc(m.text)}</button>`; return; }
    if (m.kind === 'system') { html += `<div class="sys${tap(m.id)}" data-mid="${esc(m.id)}">${esc(m.text)}${rp(m.id)}</div>`; return; }
    const mine = m.by === me.email;
    const prev = shown[i - 1];
    const showBy = !mine && others.length > 1 && !(prev && prev.by === m.by && prev.kind !== 'system');
    const time = new Date(m.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).replace(/\b(am|pm)\b/g, x => x.toUpperCase());
    const tick = mine ? (m.pending ? '<i class="fa-regular fa-clock"></i>' : `<span class="tick${readAt !== Infinity && readAt >= m.at ? ' read' : ''}"><i class="fa-solid fa-check-double"></i></span>`) : '';
    // (One line on purpose: the bubble keeps the message's own line breaks, so any space here would show.)
    html += `<div class="bub ${mine ? 'mine' : 'them'}${tap(m.id)}" data-mid="${esc(m.id)}">${showBy ? `<span class="by">${esc(nameOf(people, m.by))}</span>` : ''}${m.replyTo ? quoteHtml(m.replyTo) : ''}${esc(m.text)}<span class="meta">${time} ${tick}</span>${rp(m.id)}</div>`;
  });
  // A redraw (a request's status arriving, a new message) keeps the keyboard where it was.
  const fa = document.activeElement, fk = fa && box.contains(fa) ? ['reply', 'side', 'jump', 'capprove', 'creject', 'cmore', 'ccancel'].find(k => fa.dataset && fa.dataset[k]) : null;
  const fsel = fk ? `[data-${fk}="${CSS.escape(fa.dataset[fk])}"]` : null;
  box.innerHTML = html || (msgsLoaded ? '<div class="sys">No messages yet — say hello.</div>' : '<div class="day">Loading…</div>');
  if (fsel) { const n = box.querySelector(fsel); if (n) n.focus({ preventScroll: true }); }
  if (nearBottom || msgs.length && msgs[msgs.length - 1].by === me.email) box.scrollTop = box.scrollHeight;
}

// ── Replies (WhatsApp style) ──
// Swipe a message to the right on a phone (or tap it, then its arrow); the arrow beside it on a laptop
// (hover, or Tab from the box). The quote sits above the box until sent or ✕ (Escape). In the
// conversation a reply shows the message it answers — tap the quote to go back to that message.
const canReply = () => !!openThread && (openThread.members || []).includes(me.email);
const snippet = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
const whoSaid = m => (m.kind === 'system' ? 'Update' : m.by === me.email ? 'You' : nameOf(people, m.by));
function originalOf(id) {
  const m = msgs.find(x => x.id === id);
  if (m) return m;
  if (quoted.has(id)) return quoted.get(id);
  quoted.set(id, null);
  const tid = openId;
  getDoc(doc(db, 'threads', tid, 'messages', id))
    .then(s => { if (openId !== tid) return; quoted.set(id, s.exists() ? { ...s.data(), id } : false); renderChat(); })
    .catch(() => { if (openId === tid) quoted.delete(id); });   // offline: asked again at the next redraw
  return null;
}
function quoteHtml(id) {
  const o = originalOf(id);
  const who = o ? whoSaid(o) : '';
  const text = o === null ? '…' : o === false ? 'This message isn’t available' : snippet(o.text);
  return `<button type="button" class="quote${o && o.kind !== 'system' && o.by === me.email ? ' me' : ''}" data-jump="${esc(id)}" title="Go to this message"><b>${esc(who)}</b><span>${esc(text)}</span></button>`;
}
function startReply(id) {
  const m = msgs.find(x => x.id === id) || quoted.get(id);
  if (!m || !canReply()) return;
  // Answering a request (or one of its updates) is talking about that request: its thread opens.
  if (m.kind === 'request') { openSide(m.id); return; }
  if (m.replyTo && cardMap().has(m.replyTo)) { openSide(m.replyTo); return; }
  replyTo = { id, m };
  untap();
  renderReplyBar();
  const ta = $('text');
  if (ta) ta.focus();
}
function renderReplyBar() {
  const bar = $('replyBar'), box = $('msgs');
  if (!bar) return;
  // At the newest message when the bar opens or closes: stay there (the bar takes room from the list).
  const atBottom = box && box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const keep = () => { if (atBottom) box.scrollTop = box.scrollHeight; };
  bar.hidden = !replyTo;
  if (!replyTo) { bar.innerHTML = ''; keep(); return; }
  const m = replyTo.m;
  bar.innerHTML = `<div class="rq${m.kind !== 'system' && m.by === me.email ? ' me' : ''}"><b>${esc(m.kind === 'system' ? 'Replying to the update' : m.by === me.email ? 'Replying to yourself' : 'Replying to ' + nameOf(people, m.by))}</b><span>${esc(snippet(m.text))}</span></div>`
    + '<button type="button" class="x" id="replyX" aria-label="Cancel the reply" title="Cancel the reply"><i class="fa-solid fa-xmark"></i></button>';
  keep();
  $('replyX').addEventListener('click', () => { replyTo = null; renderReplyBar(); const ta = $('text'); if (ta) ta.focus(); });
}
function jumpTo(id) {
  const box = $('msgs');
  const el = box && box.querySelector(`[data-mid="${CSS.escape(id)}"]`);
  if (!el) { toast('That message is further back than this conversation shows'); return; }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1700);
}
// A tap on a message (touch screens) shows its reply arrow for a few seconds — the way to reply
// without the swipe gesture.
let tappedId = null, tapT = null, typingAtDown = false;
function untap() {
  tappedId = null; clearTimeout(tapT);
  document.querySelectorAll('#msgs .tapped').forEach(x => x.classList.remove('tapped'));
}
const MSG = '#msgs .bub[data-mid], #msgs .sys[data-mid]';
document.addEventListener('click', e => {
  if (!e.target.closest || !e.target.closest('#msgs')) return;
  if (Date.now() - lastSwipeEnd < 400) return;   // the end of a swipe is not a tap
  const r = e.target.closest('[data-reply]');
  if (r) { startReply(r.dataset.reply); return; }
  const j = e.target.closest('[data-jump]');
  if (j) { jumpTo(j.dataset.jump); return; }
  const el = e.target.closest(MSG);
  if (!el || e.target.closest('a, button') || !canReply() || !window.matchMedia('(hover: none)').matches || String(getSelection() || '')) return;
  // A tap while typing only puts the keyboard away (as phones do) — and the pinned card unfolding then
  // moves the messages under the finger, so it is not a tap on any one of them.
  if (typingAtDown) { typingAtDown = false; return; }
  const id = el.dataset.mid, again = id === tappedId;
  untap();
  if (again) return;
  tappedId = id; el.classList.add('tapped');
  tapT = setTimeout(untap, 5000);
});
// Touch: the message follows the finger to the right; far enough and let go → reply. A mostly
// up-and-down move is a scroll, left to the browser (touch-action on the bubbles). Listened for on the
// whole page, so a finger lifted anywhere still ends it; a new touch also ends whatever was left.
const SWIPE = 56;   // px to the right that makes it a reply
let swipe = null, drawLater = false, swipeGuard = null;
function endSwipe(e) {
  const s = swipe;
  if (!s || (e && e.pointerId !== s.pid)) return;
  swipe = null;
  clearTimeout(swipeGuard);
  if (s.on) {
    lastSwipeEnd = Date.now();
    s.el.classList.remove('swiping');
    s.el.style.translate = '';
    s.el.style.removeProperty('--rp');
    if (e && e.type === 'pointerup' && s.dx >= SWIPE && s.el.isConnected) startReply(s.id);
  }
  if (drawLater) { drawLater = false; renderChat(); }
}
document.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse') return;
  if (e.isPrimary) typingAtDown = !!(document.activeElement && document.activeElement.id === 'text');
  if (swipe && e.isPrimary) endSwipe(null);
  if (swipe) return;   // a second finger
  const el = e.target.closest && e.target.closest(MSG);
  if (!el || e.target.closest('a') || !canReply()) return;
  swipe = { el, id: el.dataset.mid, x: e.clientX, y: e.clientY, dx: 0, on: false, buzzed: false, pid: e.pointerId };
  swipeGuard = setTimeout(() => endSwipe(null), 4000);   // never hold the list longer than this
});
document.addEventListener('pointermove', e => {
  const s = swipe;
  if (!s || e.pointerId !== s.pid) return;
  const dx = e.clientX - s.x, dy = e.clientY - s.y;
  if (!s.on) {
    if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { endSwipe(null); return; }
    if (dx < 10 || dx < Math.abs(dy) * 1.5) return;
    if (!s.el.isConnected) { endSwipe(null); return; }
    s.on = true;
    s.el.classList.add('swiping');
    try { s.el.setPointerCapture(e.pointerId); } catch (x) { /* fine */ }
  }
  s.dx = Math.max(0, Math.min(dx - 10, 88));
  s.el.style.translate = s.dx + 'px 0';
  s.el.style.setProperty('--rp', String(Math.min(1, s.dx / SWIPE)));
  if (s.dx >= SWIPE && !s.buzzed) { s.buzzed = true; try { if (navigator.vibrate) navigator.vibrate(10); } catch (x) { /* fine */ } }
});
document.addEventListener('pointerup', endSwipe);
document.addEventListener('pointercancel', endSwipe);

let lastMark = 0;
function markRead() {
  const t = openThread;
  if (!t || !(t.members || []).includes(me.email) || document.visibilityState !== 'visible') return;
  const latest = Math.max(Number(t.lastAt) || 0, msgs.length ? Number(msgs[msgs.length - 1].at) || 0 : 0);
  const mark = Number((t.reads || {})[myKey] || 0);
  if (mark >= latest) return;
  if (Date.now() - lastMark < 1500) { setTimeout(markRead, 1600); return; }
  lastMark = Date.now();
  // At least the last message's time (a sender whose clock runs ahead must not leave it unread
  // forever), never more than the rules allow ahead of now.
  updateDoc(doc(db, 'threads', t.id), { ['reads.' + myKey]: Math.min(Math.max(Date.now(), latest), Date.now() + 50000) }).catch(e => console.error('read mark:', e));
}
document.addEventListener('visibilitychange', markRead);

async function send() {
  const ta = $('text');
  const text = ta.value.trim();
  const t = openThread;
  if (!text || !t) return;
  ta.value = ''; ta.style.height = 'auto';
  const reply = replyTo;
  replyTo = null; renderReplyBar();
  const now = Date.now();
  const msg = { kind: 'text', text: text.slice(0, 4000), at: now, by: me.email };
  if (reply) msg.replyTo = reply.id;
  const b = writeBatch(db);
  b.set(doc(collection(db, 'threads', t.id, 'messages')), msg);
  b.update(doc(db, 'threads', t.id), { lastAt: now, lastText: text.replace(/\s+/g, ' ').slice(0, 140), lastBy: me.email, ['reads.' + myKey]: now });
  try { await b.commit(); }
  catch (e) {
    toast('✗ Not sent — ' + (e.code === 'permission-denied' ? 'you are not in this conversation' : 'check your connection'));
    if (openThread && openThread.id === t.id) { ta.value = text; if (reply && !replyTo) { replyTo = reply; renderReplyBar(); } }
  }
}

// ── Request cards ──
const cardMap = () => new Map(msgs.filter(m => m.kind === 'request').map(m => [m.id, m]));
const repliesTo = id => msgs.filter(m => m.replyTo === id);
const reqOfCard = c => (c && c.requestId ? reqs.get(c.requestId) : undefined);
function reqLabel(c) {
  const r = reqOfCard(c);
  const l = r ? (r.targetCode || String(r.title || '').replace(/^Lead:\s*/, '').slice(0, 40)) : '';
  return l ? l + ' — ' : '';
}
// Each card's request, live — the newest 40 cards (an old chat's history needs no live status).
function watchCards() {
  const ids = [...new Set(msgs.filter(m => m.kind === 'request' && m.requestId).map(m => m.requestId))].slice(-40);
  ids.forEach(id => {
    if (reqUnsubs.has(id)) return;
    const tid = openId;
    reqUnsubs.set(id, onSnapshot(doc(db, 'accessRequests', id), sn => {
      if (openId !== tid) return;
      reqs.set(id, sn.exists() ? { ...sn.data(), id: sn.id } : null);
      renderChat(); renderSide(); renderWaiting();
    }, () => { reqs.set(id, null); renderChat(); }));
  });
}
const whatOf = r => r.kind === 'lead' ? 'a matching buyer' + (r.title ? ' — ' + String(r.title).replace(/^Lead:\s*/, '') : '') : r.need === 'time' ? 'more time on ' + r.title : r.need === 'number' ? 'the owner’s number for ' + r.title : r.title;
const liveOf = r => r.status === 'approved' && (!r.grantState || r.grantState === 'contact-hidden') && !(r.terms && r.terms.until && r.terms.until < Date.now());
function statusOf(r) {
  const mine = r.requesterEmail === me.email;
  const byWho = e => (e === me.email ? 'you' : (r.decidedByName || nameOf(people, e)));
  if (r.grantState === 'revoked') return ['', 'Access taken back'];
  if (r.status === 'approved' && !liveOf(r)) return ['', 'Approved · access ended'];
  return ({ pending: ['wait', canDecide(r) ? 'Waiting for your decision' : mine ? 'Waiting for a decision' : 'Waiting'],
    approved: ['green', `Approved by ${byWho(r.decidedBy)}${r.terms && r.terms.until ? ' · details ' + untilText(r.terms.until) : ''}${r.grantState === 'contact-hidden' ? ' · owner’s number hidden' : r.terms && r.terms.contact ? ' · with the owner’s number' : ''}`],
    rejected: ['red', `Not approved by ${byWho(r.decidedBy)}`], cancelled: ['', (mine ? 'You' : r.requesterName) + ' cancelled it'],
    expired: ['', 'Expired — nobody decided in time'] })[r.status] || ['', r.status];
}
const untilText = t => 'until ' + new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
// What one tap on Approve gives — the same as on My Day.
function quickBody(r) {
  const d = QD || {}, need = r.need || 'details';
  const body = { id: r.id, decision: 'approve' };
  if (need !== 'number') body.days = Number(d.days) > 0 ? Number(d.days) : 7;
  if (r.kind === 'property' && (need === 'number' || (need === 'details' && d.shareContact))) { body.shareContact = true; body.hours = Number(d.hours || 24); }
  return body;
}
function quickTerms(r) {
  const b = quickBody(r), parts = [];
  if ((r.need || 'details') !== 'number') parts.push(b.days ? `details for ${b.days} day${b.days === 1 ? '' : 's'}` : 'details with no time limit');
  if (b.shareContact) parts.push(`owner’s number for ${b.hours >= 48 ? Math.round(b.hours / 24) + ' days' : b.hours + ' hours'}`);
  else if (r.kind === 'property') parts.push('without the owner’s number');
  return 'Approve gives ' + parts.join(', ');
}
function cardHtml(c, { inSide = false } = {}) {
  const r = reqOfCard(c);
  const reps = repliesTo(c.id), talk = reps.filter(m => m.kind !== 'system');
  const last = reps.length ? reps[reps.length - 1] : null;
  const time = new Date(c.at || Date.now()).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).replace(/\b(am|pm)\b/g, x => x.toUpperCase());
  const foot = inSide ? '' : `<button type="button" class="rc-thread" data-side="${esc(c.id)}"><i class="fa-regular fa-comments" aria-hidden="true"></i> ${talk.length ? `${talk.length} repl${talk.length === 1 ? 'y' : 'ies'}` : 'Reply'}${last ? ` · last ${esc(short(last.at))}` : ''}</button>`;
  if (r === undefined) return `<div class="rcard loading" data-card="${esc(c.id)}"><div class="rc-h"><span class="rc-k">Request</span><span class="rc-t">${time}</span></div><b>${esc(c.text)}</b>${foot}</div>`;
  if (r === null) return `<div class="rcard gone" data-card="${esc(c.id)}"><div class="rc-h"><span class="rc-k">Request</span><span class="rc-t">${time}</span></div><b>${esc(c.text)}</b><small>This request is no longer there.</small>${foot}</div>`;
  const mineReq = r.requesterEmail === me.email, [tone, st] = statusOf(r), can = canDecide(r) && canReply();
  const live = liveOf(r);
  return `<div class="rcard${r.status === 'pending' ? ' open' : ''}" data-card="${esc(c.id)}">
    <div class="rc-h"><span class="rc-k"><i class="fa-solid ${r.kind === 'lead' ? 'fa-user-lock' : 'fa-building-lock'}" aria-hidden="true"></i> Request</span><span class="rc-t">${time}</span></div>
    <b>${mineReq ? 'You' : esc(r.requesterName)} asked for ${esc(whatOf(r))}</b>
    ${r.clientName ? `<small>For ${mineReq ? 'your' : 'their'} client ${esc(r.clientName)}</small>` : ''}
    ${codeLine(r, me.role, { link: !mineReq })}
    ${r.reason ? `<div class="q">“${esc(r.reason)}”</div>` : ''}
    <div><span class="tag ${tone}">${esc(st)}</span></div>
    ${r.note && r.status !== 'pending' ? `<div class="q">${esc(r.note)}</div>` : ''}
    <div class="acts">
      ${can ? `<button type="button" class="btn sm primary" data-capprove="${esc(r.id)}"${QD ? '' : ' disabled'}><i class="fa-solid fa-check" aria-hidden="true"></i> Approve</button><button type="button" class="btn sm" data-creject="${esc(r.id)}">Reject</button><button type="button" class="btn sm quiet" data-cmore="${esc(r.id)}">More options</button>` : ''}
      ${r.status === 'pending' && mineReq ? `<button type="button" class="btn sm danger" data-ccancel="${esc(r.id)}">Cancel request</button>` : ''}
      ${live && mineReq && r.kind === 'property' ? `<a class="btn sm primary" href="dashboard.html?property=${encodeURIComponent(r.targetId)}">Open property</a>` : ''}
      ${live && mineReq && r.kind === 'lead' && r.grantId ? `<button type="button" class="btn sm primary" data-copenlead="${esc(r.grantId)}">Open in Leads</button>` : ''}
    </div>
    ${can ? `<p class="qa-terms">${esc(QD ? quickTerms(r) + '. More options to change it.' : 'Loading what Approve gives…')}</p>
    <div class="rj" data-crj="${esc(r.id)}" hidden><label for="crj-${esc(r.id)}${inSide ? '-s' : ''}">Why (they see this)</label><textarea id="crj-${esc(r.id)}${inSide ? '-s' : ''}" maxlength="500" rows="2" placeholder="e.g. The owner has given this to us exclusively for now"></textarea><p class="rj-err" role="alert"></p>
      <div class="acts"><button type="button" class="btn sm danger" data-crjsend="${esc(r.id)}">Send rejection</button><button type="button" class="btn sm quiet" data-crjback="${esc(r.id)}">Not now</button></div></div>` : ''}
    ${foot}</div>`;
}
// The strip on top of a people's chat: what waits on me here, all approvable at once.
function renderWaiting() {
  const el = $('pinned');
  if (!el || !openThread || openThread.type !== 'direct') return;
  const cards = msgs.filter(m => m.kind === 'request');
  const mineWait = cards.map(reqOfCard).filter(r => r && canDecide(r));
  const asked = cards.map(reqOfCard).filter(r => r && r.status === 'pending' && r.requesterEmail === me.email);
  if (!mineWait.length && !asked.length) { el.innerHTML = ''; return; }
  const terms = mineWait.length && QD && new Set(mineWait.map(quickTerms)).size === 1 ? quickTerms(mineWait[0]) + ' — each.' : 'Each gets what its own Approve gives.';
  el.innerHTML = `<div class="pinned waiting">${mineWait.length ? `<b>${mineWait.length} request${mineWait.length === 1 ? '' : 's'} waiting on you</b>
      <div class="acts"><button type="button" class="btn sm" data-firstwait>Show the first</button>${mineWait.length > 1 && canReply() ? `<button type="button" class="btn sm primary" data-approveall${QD ? '' : ' disabled'}><i class="fa-solid fa-check-double" aria-hidden="true"></i> Approve all ${mineWait.length}</button>` : ''}</div>
      ${mineWait.length > 1 ? `<small>${esc(terms)}</small>` : ''}` : `<b>${asked.length} of your requests waiting for a decision</b>`}</div>`;
}
function openSide(cardId) {
  sideCard = cardId;
  const side = $('side');
  if (!side) return;
  side.hidden = false;
  document.body.classList.add('side-open');
  const url = new URL(location.href); const c = msgs.find(m => m.id === cardId);
  if (c && c.requestId) { url.searchParams.set('r', c.requestId); history.replaceState(history.state, '', url); }
  renderSide();
  if (window.matchMedia('(min-width: 900px)').matches) setTimeout(() => { const t = $('sideText'); if (t) t.focus(); }, 50);
}
function closeSide() {
  sideCard = null;
  const side = $('side');
  if (side) { side.hidden = true; $('sideBody').innerHTML = ''; }
  document.body.classList.remove('side-open');
  const url = new URL(location.href); url.searchParams.delete('r'); history.replaceState(history.state, '', url);
  const el = document.querySelector(`#msgs [data-card]`); if (el) { const back = document.querySelector('#msgs .rc-thread'); if (back) back.focus({ preventScroll: true }); }
}
function renderSide() {
  if (!sideCard || !$('sideBody')) return;
  const c = msgs.find(m => m.id === sideCard);
  if (!c) return;
  const r = reqOfCard(c);
  $('sideT').textContent = r ? (r.targetCode ? r.targetCode + ' · ' : '') + String(r.title || 'Request').replace(/^Lead:\s*/, '') : 'Request';
  $('sideS').textContent = 'Everything about this request';
  const box = $('sideBody');
  const keep = { open: [...box.querySelectorAll('[data-crj]:not([hidden])')].map(x => [x.dataset.crj, x.querySelector('textarea').value]) };
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const others = othersOf(openThread || {});
  const readAt = Math.min(...others.map(e => ((openThread || {}).reads || {})[emailKey(e)] || 0), Infinity);
  const reps = repliesTo(c.id);
  box.innerHTML = cardHtml(c, { inSide: true }) + (reps.length ? '' : '<div class="sys">No replies yet — ask a question or add a note about this request.</div>') + reps.map(m => {
    if (m.kind === 'system') return `<div class="sys">${esc(m.text)}</div>`;
    const mine = m.by === me.email;
    const time = new Date(m.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).replace(/\b(am|pm)\b/g, x => x.toUpperCase());
    const tick = mine ? (m.pending ? '<i class="fa-regular fa-clock"></i>' : `<span class="tick${readAt !== Infinity && readAt >= m.at ? ' read' : ''}"><i class="fa-solid fa-check-double"></i></span>`) : '';
    return `<div class="bub ${mine ? 'mine' : 'them'}">${!mine ? `<span class="by">${esc(nameOf(people, m.by))}</span>` : ''}${esc(m.text)}<span class="meta">${time} ${tick}</span></div>`;
  }).join('');
  keep.open.forEach(([id, text]) => { const b = box.querySelector(`[data-crj="${CSS.escape(id)}"]`); if (b) { b.hidden = false; b.querySelector('textarea').value = text; } });
  if (nearBottom || (reps.length && reps[reps.length - 1].by === me.email)) box.scrollTop = box.scrollHeight;
  $('sideCompose').hidden = !canReply();
}
async function sendSide() {
  const ta = $('sideText'), text = ta.value.trim(), t = openThread, cardId = sideCard;
  if (!text || !t || !cardId) return;
  ta.value = ''; ta.style.height = 'auto';
  const now = Date.now();
  const label = reqLabel(msgs.find(m => m.id === cardId));
  const b = writeBatch(db);
  b.set(doc(collection(db, 'threads', t.id, 'messages')), { kind: 'text', text: text.slice(0, 4000), at: now, by: me.email, replyTo: cardId });
  b.update(doc(db, 'threads', t.id), { lastAt: now, lastText: (label + text).replace(/\s+/g, ' ').slice(0, 140), lastBy: me.email, ['reads.' + myKey]: now });
  try { await b.commit(); }
  catch (e) { toast('✗ Not sent — ' + (e.code === 'permission-denied' ? 'you are not in this conversation' : 'check your connection')); if (sideCard === cardId) ta.value = text; }
}
// Card buttons — in the chat and in the side panel alike.
document.addEventListener('click', async e => {
  const t = e.target.closest && e.target.closest('#chat [data-side], #chat [data-capprove], #chat [data-creject], #chat [data-crjback], #chat [data-crjsend], #chat [data-cmore], #chat [data-ccancel], #chat [data-copenlead], #chat [data-approveall], #chat [data-firstwait]');
  if (!t) return;
  const scope = t.closest('#sideBody') || t.closest('#msgs') || document;
  const reqBy = id => [...reqs.values()].find(r => r && r.id === id);
  if (t.dataset.side) { openSide(t.dataset.side); return; }
  if (t.hasAttribute('data-firstwait')) {
    const c = msgs.find(m => m.kind === 'request' && canDecide(reqOfCard(m)));
    const el = c && document.querySelector(`#msgs [data-card="${CSS.escape(c.id)}"]`);
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    return;
  }
  if (t.hasAttribute('data-approveall')) {
    const list = msgs.filter(m => m.kind === 'request').map(reqOfCard).filter(r => r && canDecide(r));
    if (!list.length) return;
    busy(t, () => api('decide-many', { decision: 'approve', items: list.map(quickBody) })
      .then(r => toast(`Approved ${r.done}` + (r.failed ? ` · ${r.failed} not: ${(r.results.find(x => !x.ok) || {}).error}` : ' — they’ve been told'))).catch(x => toast('✗ ' + x.message)));
    return;
  }
  if (t.dataset.capprove) { const r = reqBy(t.dataset.capprove); if (r) busy(t, () => api('decide', quickBody(r)).then(() => toast('Approved — ' + quickTerms(r).replace(/^Approve gives /, ''))).catch(x => toast('✗ ' + x.message))); return; }
  if (t.dataset.cmore) { const r = reqBy(t.dataset.cmore); if (r) decideSheet(r, { canCoAgent: r.kind === 'property' && (isAdmin || await isMyOwnProperty(r.targetId)), defaults: { ...(await approvalDefaults(me)), isAdmin }, role: me.role }); return; }
  const box = id => scope.querySelector(`[data-crj="${CSS.escape(id)}"]`);
  if (t.dataset.creject) { const b = box(t.dataset.creject); if (b) { b.hidden = false; b.querySelector('textarea').focus(); } return; }
  if (t.dataset.crjback) { const b = box(t.dataset.crjback); if (b) b.hidden = true; return; }
  if (t.dataset.crjsend) {
    const b = box(t.dataset.crjsend), note = b.querySelector('textarea').value.trim(), err = b.querySelector('.rj-err');
    if (!note) { err.textContent = 'Say why — they see it'; b.querySelector('textarea').focus(); return; }
    busy(t, () => api('decide', { id: t.dataset.crjsend, decision: 'reject', note }).then(() => toast('Rejected — they’ve been told')).catch(x => { err.textContent = x.message; }));
    return;
  }
  if (t.dataset.ccancel) { if (confirm('Cancel this request?')) busy(t, () => api('cancel', { id: t.dataset.ccancel }).then(() => toast('Request cancelled')).catch(x => toast('✗ ' + x.message))); return; }
  if (t.dataset.copenlead) getDoc(doc(db, 'grants', t.dataset.copenlead)).then(g => { if (g.exists()) location.href = 'crm.html?lead=' + encodeURIComponent(g.data().targetId); }).catch(() => toast('Could not open it — try again'));
});

// ── A new conversation ──
$('newBtn').addEventListener('click', async () => {
  const list = (people.length ? people : await directory()).filter(p => p.email !== me.email);
  openSheet(`
    <h3>New conversation</h3>
    <div class="field"><label for="nTitle">Topic (optional)</label><input type="text" id="nTitle" maxlength="120" placeholder="e.g. Weekend visits in Adyar" aria-describedby="nTitleHelp"><p class="note" id="nTitleHelp">Leave it empty to open your one chat with them — where their requests are too. A topic starts a separate group chat.</p></div>
    <div class="field"><label>With</label><div class="pick" id="nPeople">${list.map(p => `<label><input type="checkbox" value="${esc(p.email)}"> ${esc(p.name)}${p.role === 'admin' ? ' · admin' : p.role === 'agent' ? ' · agent' : ''}</label>`).join('') || '<span class="note">Nobody else on the team yet.</span>'}</div></div>
    <p class="note">For a property or a lead, use “Message” on it instead — the conversation is linked to it. Admins can read every team conversation.</p>
    <p class="err" id="nErr"></p>
    <div class="bar"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary block" id="nGo">Start</button></div>`,
  { label: 'New conversation', onOpen: (sh, close) => {
    sh.querySelector('#nGo').addEventListener('click', () => busy(sh.querySelector('#nGo'), async () => {
      const title = sh.querySelector('#nTitle').value.trim();
      const members = [...sh.querySelectorAll('#nPeople input:checked')].map(i => i.value);
      if (!members.length) { sh.querySelector('#nErr').textContent = 'Pick at least one person'; return; }
      try { const r = await api('thread-open', title ? { type: 'general', title, members } : { type: 'direct', members }); await close(true); openChat(r.id, { push: true }); }
      catch (e) { sh.querySelector('#nErr').textContent = e.message; }
    }));
  } });
});
