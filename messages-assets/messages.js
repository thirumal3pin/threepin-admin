// ═══════ MESSAGES (messages.html) — the team's own chat ═══════
// Agent ↔ agent and agent ↔ admin, WhatsApp style. Not client messaging (that stays on TailorTalk).
//   threads/{id}            { title, type: access_request | property | lead | general, linkedId, members,
//                             names, lastAt, lastText, lastBy, unread: { key: n }, reads: { key: ms } }
//   threads/{id}/messages   { kind: text | system, text, at, by }
// Threads are opened by the server (/api/agent thread-open; a request opens its own). A member
// writes their own text messages and the thread's last line, unread counts and read marks — the
// only things firestore.rules let them write. Read ticks come from the read marks: a message is
// read once every other member's mark has passed it.
import { $, esc, lc, emailKey, api, db, isShutdown, whenSignedIn, directory, nameOf, when, toast, openSheet, decideSheet, busy } from '../shared-assets/agent-client.js';
import { collection, query, where, onSnapshot, orderBy, limit, doc, writeBatch, increment, updateDoc } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const me = await whenSignedIn();
const isAdmin = me.role === 'admin', isAgent = me.role === 'agent';
const myKey = emailKey(me.email);
window.AppNav.boot({ console: 'messages', select: () => {}, signOut: () => import('../shared-assets/agent-client.js').then(m => m.signOutHere()) });
window.AppNav.setActive('messages');

let people = [];
let threads = [];
let filter = 'all', q = '', everyone = false;
let openId = null, msgUnsub = null, reqUnsub = null, msgs = [], openThread = null, openReq = null;
let threadUnsub = null, docUnsub = null;

directory().then(p => { people = p; renderList(); if (openThread) renderChat(); });

function watchThreads() {
  if (threadUnsub) threadUnsub();
  const base = collection(db, 'threads');
  const qq = everyone && isAdmin ? query(base, where('tenantId', '==', me.tenantId)) : query(base, where('tenantId', '==', me.tenantId), where('members', 'array-contains', me.email));
  threadUnsub = onSnapshot(qq, s => {
    threads = s.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    renderList();
    const unread = threads.filter(t => (t.members || []).includes(me.email)).reduce((n, t) => n + ((t.unread || {})[myKey] || 0), 0);
    if (window.AppNav && window.AppNav.setBadge) window.AppNav.setBadge('messages', unread);
    const want = new URLSearchParams(location.search).get('t');
    if (want && !openId && threads.some(t => t.id === want)) openChat(want);
  }, err => { if (!isShutdown(err)) $('threads').innerHTML = `<div class="empty"><i class="fa-solid fa-triangle-exclamation"></i>${esc(err.message)}</div>`; });
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

const ICON = { access_request: 'fa-solid fa-lock-open', property: 'fa-regular fa-building', lead: 'fa-regular fa-user', general: 'fa-regular fa-comments' };
const short = t => {
  if (!t) return '';
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  if (now - d < 6 * 86400000) return d.toLocaleDateString('en-IN', { weekday: 'short' });
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};
function renderList() {
  let list = threads;
  if (filter !== 'all') list = list.filter(t => t.type === filter);
  if (q) list = list.filter(t => String(t.title || '').toLowerCase().includes(q));
  $('threads').innerHTML = list.length ? list.map(t => {
    const n = (t.unread || {})[myKey] || 0;
    const by = t.lastBy ? (t.lastBy === me.email ? 'You: ' : nameOf(people, t.lastBy).split(' ')[0] + ': ') : '';
    const others = (t.members || []).filter(e => e !== me.email).map(e => nameOf(people, e).split(' ')[0]).join(', ');
    return `<div class="thread${n ? ' unread' : ''}" role="button" tabindex="0" data-id="${esc(t.id)}">
      <div class="av"><i class="${ICON[t.type] || ICON.general}"></i></div>
      <div class="bd"><b>${esc(t.title)}</b><small>${t.lastText ? esc(by + t.lastText) : esc(others)}</small></div>
      <div class="side"><span>${esc(short(t.lastAt))}</span>${n ? `<span class="ub">${n > 99 ? '99+' : n}</span>` : ''}</div></div>`;
  }).join('') : `<div class="empty"><i class="fa-regular fa-comments"></i>${q || filter !== 'all' ? 'No conversations here.' : 'No conversations yet. A request for details opens one; so does “Message” on a property, or New.'}</div>`;
  $('threads').querySelectorAll('.thread').forEach(el => {
    el.addEventListener('click', () => openChat(el.dataset.id));
    el.addEventListener('keydown', e => { if (e.key === 'Enter') openChat(el.dataset.id); });
  });
}

// ── One conversation ──
function openChat(id) {
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
  const url = new URL(location.href); url.searchParams.set('t', id); history.replaceState(null, '', url);
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
function closeChat(silent) {
  if (msgUnsub) msgUnsub(); if (reqUnsub) reqUnsub(); if (docUnsub) docUnsub();
  msgUnsub = reqUnsub = docUnsub = null; openId = null; openThread = null; openReq = null;
  if (!silent) {
    $('chat').hidden = true; $('chat').innerHTML = ''; document.body.classList.remove('chat-open');
    const url = new URL(location.href); url.searchParams.delete('t'); history.replaceState(null, '', url);
  }
}
window.addEventListener('keydown', e => { if (e.key === 'Escape' && openId && !document.querySelector('.sheet')) closeChat(); });

function renderHeader() {
  const t = openThread;
  if (!t || !$('chatTitle')) return;
  const others = (t.members || []).filter(e => e !== me.email).map(e => nameOf(people, e));
  const link = t.type === 'property' && t.linkedId ? (isAgent ? 'listings.html?id=' : 'property.html?id=') + encodeURIComponent(t.linkedId)
    : t.type === 'lead' && t.linkedId ? 'crm.html?lead=' + encodeURIComponent(t.linkedId) : '';
  $('chatTitle').outerHTML = `<${link ? `a href="${esc(link)}"` : 'div'} class="t" id="chatTitle"><b>${esc(t.title)}</b><small>${esc(others.join(', '))}${link ? ' · tap to open' : ''}</small></${link ? 'a' : 'div'}>`;
}
function renderPinned() {
  const r = openReq, el = $('pinned');
  if (!el) return;
  if (!r) { el.innerHTML = ''; return; }
  const can = r.status === 'pending' && r.requesterEmail !== me.email && (isAdmin || (r.approvers || []).includes(me.email));
  const st = { pending: 'Waiting for a decision', approved: `Approved by ${r.decidedByName || nameOf(people, r.decidedBy)} · ${when(r.decidedAt)}`,
    rejected: `Rejected by ${r.decidedByName || nameOf(people, r.decidedBy)} · ${when(r.decidedAt)}`, cancelled: 'Cancelled by ' + r.requesterName }[r.status] || r.status;
  el.innerHTML = `<div class="pinned"><b><i class="fa-solid fa-thumbtack" style="color:var(--ink3)"></i> ${esc(r.requesterName)} asked for ${r.kind === 'lead' ? 'a matching buyer’s details' : esc(r.title)}</b>
    <div><span class="tag ${r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : r.status === 'pending' ? 'wait' : ''}">${esc(st)}</span></div>
    ${can || (r.status === 'pending' && r.requesterEmail === me.email) ? `<div class="acts">
      ${can ? '<button type="button" class="btn sm primary" id="pDecide">Approve or reject</button>' : ''}
      ${r.status === 'pending' && r.requesterEmail === me.email ? '<button type="button" class="btn sm danger" id="pCancel">Cancel request</button>' : ''}</div>` : ''}</div>`;
  if ($('pDecide')) $('pDecide').addEventListener('click', () => decideSheet(r, { canCoAgent: r.kind === 'property' && isAdmin }));
  // (A property's primary agent can also make the asker a co-agent — from My Day, which knows whose
  // property it is.)
  if ($('pCancel')) $('pCancel').addEventListener('click', e => { if (confirm('Cancel this request?')) busy(e.currentTarget, () => api('cancel', { id: r.id }).catch(x => toast('✗ ' + x.message))); });
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
    const time = new Date(m.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
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
  const latest = msgs.length ? msgs[msgs.length - 1].at || 0 : 0;
  const unread = (t.unread || {})[myKey] || 0;
  const mark = (t.reads || {})[myKey] || 0;
  if (!unread && mark >= latest) return;
  if (Date.now() - lastMark < 1500) { setTimeout(markRead, 1600); return; }
  lastMark = Date.now();
  updateDoc(doc(db, 'threads', t.id), { ['unread.' + myKey]: 0, ['reads.' + myKey]: Date.now() }).catch(e => console.error('read mark:', e));
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
  const patch = { lastAt: now, lastText: text.replace(/\s+/g, ' ').slice(0, 140), lastBy: me.email, ['unread.' + myKey]: 0, ['reads.' + myKey]: now };
  (t.members || []).filter(e => e !== me.email).forEach(e => { patch['unread.' + emailKey(e)] = increment(1); });
  b.update(doc(db, 'threads', t.id), patch);
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
    <p class="note">For a property or a lead, use “Message” on it instead — the conversation is linked to it.</p>
    <p class="err" id="nErr"></p>
    <div class="bar"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary block" id="nGo">Start</button></div>`,
  { label: 'New conversation', onOpen: (sh, close) => {
    sh.querySelector('#nGo').addEventListener('click', () => busy(sh.querySelector('#nGo'), async () => {
      const title = sh.querySelector('#nTitle').value.trim();
      const members = [...sh.querySelectorAll('#nPeople input:checked')].map(i => i.value);
      if (!title) { sh.querySelector('#nErr').textContent = 'Give it a title'; return; }
      if (!members.length) { sh.querySelector('#nErr').textContent = 'Pick at least one person'; return; }
      try { const r = await api('thread-open', { type: 'general', title, members }); close(); openChat(r.id); }
      catch (e) { sh.querySelector('#nErr').textContent = e.message; }
    }));
  } });
});
