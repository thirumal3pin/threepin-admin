// ═══════ MESSAGES (messages.html) — the team's own chat ═══════
// Agent ↔ agent and agent ↔ admin, WhatsApp style. Not client messaging (that stays on TailorTalk).
//   threads/{id}            { title, type: access_request | property | lead | general, linkedId, members,
//                             names, lastAt, lastText, lastBy, reads: { key: ms } }
//   threads/{id}/messages   { kind: text | system, text, at, by }
// Threads are opened by the server (/api/agent thread-open; a request opens its own). A member
// writes their own text messages, the thread's last line as themselves, and their own read mark —
// the only things firestore.rules let them write. What is unread is worked out from each person's
// own read mark; read ticks from the others' marks (a message is read once every other member's mark
// has passed it).
import { $, esc, lc, emailKey, api, db, isShutdown, whenSignedIn, directory, nameOf, when, toast, openSheet, decideSheet, busy, approvalDefaults } from '../shared-assets/agent-client.js';
import { collection, query, where, onSnapshot, orderBy, limit, doc, writeBatch, updateDoc, getDoc } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

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
    threads = s.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    renderList();
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

// "Access: 3 BHK, Anna Nagar · for Arjun" — the lock icon already says it is a request.
const shortTitle = t => t.type === 'access_request' ? String(t.title || '').replace(/^(Access|More time|Owner’s number):\s*/, m => m.startsWith('Access') ? '' : m) : String(t.title || '');
const ICON = { access_request: 'fa-solid fa-lock-open', property: 'fa-regular fa-building', lead: 'fa-regular fa-user', general: 'fa-regular fa-comments' };
const short = t => {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).replace(/\b(am|pm)\b/g, m => m.toUpperCase());
  if (now - d < 6 * 86400000) return d.toLocaleDateString('en-IN', { weekday: 'short' });
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
function renderList() {
  let list = threads;
  if (filter !== 'all') list = list.filter(t => t.type === filter);
  if (q) list = list.filter(t => [t.title, ...(t.members || []).map(e => nameOf(people, e))].join(' ').toLowerCase().includes(q));
  $('threads').innerHTML = list.length ? list.map(t => {
    const n = isUnread(t);
    const by = t.lastBy ? (t.lastBy === me.email ? 'You: ' : nameOf(people, t.lastBy).split(' ')[0] + ': ') : '';
    const others = (t.members || []).filter(e => e !== me.email).map(e => nameOf(people, e).split(' ')[0]).join(', ');
    return `<div class="thread${n ? ' unread' : ''}" role="button" tabindex="0" data-id="${esc(t.id)}">
      <div class="av"><i class="${ICON[t.type] || ICON.general}"></i></div>
      <div class="bd"><b>${esc(shortTitle(t))}</b><small>${t.lastText ? esc(by + t.lastText) : esc(others)}</small></div>
      <div class="side"><span>${esc(short(t.lastAt))}</span>${n ? '<span class="ub" aria-label="Unread"></span>' : ''}</div></div>`;
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
    <form class="compose" id="compose"><textarea id="text" rows="1" maxlength="4000" placeholder="Message" aria-label="Message"></textarea><button type="submit" class="send" id="send" aria-label="Send"><i class="fa-solid fa-paper-plane"></i></button></form>`;
  $('back').addEventListener('click', () => closeChat());
  const ta = $('text');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 900px)').matches) { e.preventDefault(); send(); } });
  $('compose').addEventListener('submit', e => { e.preventDefault(); send(); });
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
    renderChat();
    markRead();
  }, err => { if (!isShutdown(err)) $('msgs').innerHTML = `<div class="sys">${esc(err.message)}</div>`; });
  // The thread itself, live (it may be brand new and not in the list yet).
  docUnsub = onSnapshot(doc(db, 'threads', id), s => {
    if (!s.exists()) { $('msgs').innerHTML = '<div class="sys">This conversation is not there any more.</div>'; return; }
    openThread = { ...s.data(), id: s.id };
    renderHeader(); renderChat(); markRead();
    if ($('compose')) $('compose').hidden = !(openThread.members || []).includes(me.email);
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
  msgUnsub = reqUnsub = docUnsub = null; openId = null; openThread = null; openReq = null;
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
window.addEventListener('keydown', e => { if (e.key === 'Escape' && openId && !document.querySelector('.sheet')) closeChat(); });

function renderHeader() {
  const t = openThread;
  if (!t || !$('chatTitle')) return;
  const others = (t.members || []).filter(e => e !== me.email).map(e => nameOf(people, e));
  const link = t.type === 'property' && t.linkedId ? (isAgent ? 'listings.html?id=' : 'property.html?id=') + encodeURIComponent(t.linkedId)
    : t.type === 'lead' && t.linkedId ? 'crm.html?lead=' + encodeURIComponent(t.linkedId)
    : t.type === 'access_request' && t.linkedId ? 'myday.html?req=' + encodeURIComponent(t.linkedId) : '';
  $('chatTitle').outerHTML = `<${link ? `a href="${esc(link)}"` : 'div'} class="t" id="chatTitle"><b>${esc(t.title)}</b><small>${esc(others.join(', '))}${link ? ' · tap to open' : ''}</small></${link ? 'a' : 'div'}>`;
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
  el.innerHTML = `<div class="pinned"><b><i class="fa-solid fa-thumbtack" style="color:var(--ink3)"></i> ${mineReq ? 'You' : esc(r.requesterName)} asked for ${esc(what)}</b>
    <div><span class="tag ${live ? 'green' : r.status === 'rejected' ? 'red' : r.status === 'pending' ? 'wait' : ''}">${esc(r.grantState === 'revoked' ? 'Access taken back' : r.grantState === 'expired' ? 'Access ended' : r.grantState === 'contact-hidden' ? st + ' · owner’s number hidden' : st)}</span></div>
    <div class="acts">
      ${can ? '<button type="button" class="btn sm primary" id="pDecide">Approve or reject</button>' : ''}
      ${r.status === 'pending' && mineReq ? '<button type="button" class="btn sm danger" id="pCancel">Cancel request</button>' : ''}
      ${live && mineReq && r.kind === 'property' ? `<a class="btn sm primary" href="listings.html?id=${encodeURIComponent(r.targetId)}">Open property</a>` : ''}
      ${live && mineReq && r.kind === 'lead' ? '<button type="button" class="btn sm primary" id="pOpenLead">Open in Leads</button>' : ''}
      ${live && mineReq && r.kind === 'property' && r.terms && r.terms.until && r.terms.until - Date.now() < 2 * 86400000 ? '<button type="button" class="btn sm" id="pMore">Ask for more time</button>' : ''}
    </div></div>`;
  if (!el.querySelector('.acts').children.length) el.querySelector('.acts').remove();
  if ($('pDecide')) $('pDecide').addEventListener('click', async () => decideSheet(r, { canCoAgent: r.kind === 'property' && (isAdmin || await isMyOwnProperty(r.targetId)), defaults: { ...(await approvalDefaults(me)), isAdmin } }));
  if ($('pCancel')) $('pCancel').addEventListener('click', e => { if (confirm('Cancel this request?')) busy(e.currentTarget, () => api('cancel', { id: r.id }).catch(x => toast('✗ ' + x.message))); });
  if ($('pMore')) $('pMore').addEventListener('click', e => busy(e.currentTarget, () => api('request', { kind: 'property', targetId: r.targetId, need: 'time', reason: 'Asking for more time' }).then(() => toast('Asked for more time')).catch(x => toast('✗ ' + x.message))));
  // The lead opened to them: its id is on their own grant (they can read it), never on the request.
  if ($('pOpenLead')) $('pOpenLead').addEventListener('click', () => getDoc(doc(db, 'grants', r.grantId)).then(g => { if (g.exists()) location.href = 'crm.html?lead=' + encodeURIComponent(g.data().targetId); }).catch(() => toast('Could not open it — try again')));
}
function renderChat() {
  const box = $('msgs');
  if (!box) return;
  const t = openThread || {};
  const others = (t.members || []).filter(e => e !== me.email);
  const readAt = Math.min(...others.map(e => (t.reads || {})[emailKey(e)] || 0), Infinity);
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  let lastDay = '', html = '';
  msgs.forEach((m, i) => {
    const day = new Date(m.at || Date.now()).toDateString();
    if (day !== lastDay) { lastDay = day; html += `<div class="day">${esc(new Date(m.at || Date.now()).toDateString() === new Date().toDateString() ? 'Today' : new Date(m.at).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }))}</div>`; }
    if (m.kind === 'system') { html += `<div class="sys">${esc(m.text)}</div>`; return; }
    const mine = m.by === me.email;
    const prev = msgs[i - 1];
    const showBy = !mine && others.length > 1 && !(prev && prev.by === m.by && prev.kind !== 'system');
    const time = new Date(m.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }).replace(/\b(am|pm)\b/g, x => x.toUpperCase());
    const tick = mine ? (m.pending ? '<i class="fa-regular fa-clock"></i>' : `<span class="tick${readAt !== Infinity && readAt >= m.at ? ' read' : ''}"><i class="fa-solid fa-check-double"></i></span>`) : '';
    html += `<div class="bub ${mine ? 'mine' : 'them'}">${showBy ? `<span class="by">${esc(nameOf(people, m.by))}</span>` : ''}${esc(m.text)}<span class="meta">${time} ${tick}</span></div>`;
  });
  box.innerHTML = html || '<div class="sys">No messages yet — say hello.</div>';
  if (nearBottom || msgs.length && msgs[msgs.length - 1].by === me.email) box.scrollTop = box.scrollHeight;
}

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
  const now = Date.now();
  const b = writeBatch(db);
  b.set(doc(collection(db, 'threads', t.id, 'messages')), { kind: 'text', text: text.slice(0, 4000), at: now, by: me.email });
  b.update(doc(db, 'threads', t.id), { lastAt: now, lastText: text.replace(/\s+/g, ' ').slice(0, 140), lastBy: me.email, ['reads.' + myKey]: now });
  try { await b.commit(); }
  catch (e) { toast('✗ Not sent — ' + (e.code === 'permission-denied' ? 'you are not in this conversation' : 'check your connection')); ta.value = text; }
}

// ── A new conversation ──
$('newBtn').addEventListener('click', async () => {
  const list = (people.length ? people : await directory()).filter(p => p.email !== me.email);
  openSheet(`
    <h3>New conversation</h3>
    <div class="field"><label for="nTitle">Title (required)</label><input type="text" id="nTitle" maxlength="120" placeholder="e.g. Weekend visits in Adyar"></div>
    <div class="field"><label>With</label><div class="pick" id="nPeople">${list.map(p => `<label><input type="checkbox" value="${esc(p.email)}"> ${esc(p.name)}${p.role === 'admin' ? ' · admin' : p.role === 'agent' ? ' · agent' : ''}</label>`).join('') || '<span class="note">Nobody else on the team yet.</span>'}</div></div>
    <p class="note">For a property or a lead, use “Message” on it instead — the conversation is linked to it. Admins can read every team conversation.</p>
    <p class="err" id="nErr"></p>
    <div class="bar"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary block" id="nGo">Start</button></div>`,
  { label: 'New conversation', onOpen: (sh, close) => {
    sh.querySelector('#nGo').addEventListener('click', () => busy(sh.querySelector('#nGo'), async () => {
      const title = sh.querySelector('#nTitle').value.trim();
      const members = [...sh.querySelectorAll('#nPeople input:checked')].map(i => i.value);
      if (!title) { sh.querySelector('#nErr').textContent = 'Give it a title'; return; }
      if (!members.length) { sh.querySelector('#nErr').textContent = 'Pick at least one person'; return; }
      try { const r = await api('thread-open', { type: 'general', title, members }); await close(); openChat(r.id, { push: true }); }
      catch (e) { sh.querySelector('#nErr').textContent = e.message; }
    }));
  } });
});
