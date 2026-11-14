// ═══════ TEAM & ACCESS → REQUESTS (team.html, admins) ═══════
// Everything the agent layer has waiting or open, for an admin, live:
//   Waiting for a decision   requests for a property's details or a matching buyer (any admin may
//                            decide; the first decision wins, on the server)
//   Properties agents added  waiting for approval — approved ones join the inventory with the agent
//                            as primary agent
//   Shared right now         every running grant: who, what, until when — Hide number, Take back
//   Decided lately           the last 30 days, both ways
import { $, esc, api, db, isShutdown, whenSignedIn, directory, nameOf, when, ago, untilWords, toast, decideSheet, openSheet, busy } from '../shared-assets/agent-client.js';
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

if ($('tab-requests')) start();

async function start() {
  const me = await whenSignedIn();
  if (me.role !== 'admin') return;
  let people = [];
  directory().then(p => { people = p; render(); });
  const S = { reqs: [], grants: [], subs: [], loaded: 0 };
  const T = me.tenantId;
  const on = (q, k) => onSnapshot(q, s => { S[k] = s.docs.map(d => ({ ...d.data(), id: d.id })); S.loaded |= { reqs: 1, grants: 2, subs: 4 }[k]; render(); },
    e => { if (isShutdown(e)) return; console.error('requests ' + k + ':', e); $('requests').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; });
  on(query(collection(db, 'accessRequests'), where('tenantId', '==', T)), 'reqs');
  on(query(collection(db, 'grants'), where('tenantId', '==', T), where('active', '==', true)), 'grants');
  on(query(collection(db, 'propertySubmissions'), where('tenantId', '==', T)), 'subs');

  function render() {
    if (S.loaded !== 7) return;
    const now = Date.now();
    const pending = S.reqs.filter(r => r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    const subs = S.subs.filter(s => s.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    const live = S.grants.filter(g => g.active && (!g.expiresAt || g.expiresAt > now)).sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0));
    const recent = S.reqs.filter(r => r.status !== 'pending' && (r.decidedAt || 0) > now - 30 * 86400000).sort((a, b) => b.decidedAt - a.decidedAt);
    const n = pending.length + subs.length;
    $('reqN').hidden = !n; $('reqN').textContent = n;
    const block = (title, count, body) => `<div class="sec-h">${title} <span class="n${count && title.startsWith('Waiting') ? ' hot' : ''}">${count}</span></div><div class="card">${body}</div>`;
    const empty = t => `<div class="empty">${t}</div>`;
    let html = '';
    html += block('Waiting for a decision', pending.length, pending.length ? pending.map(r => `<div class="item"><div class="ic brand"><i class="fa-solid ${r.kind === 'lead' ? 'fa-user-lock' : 'fa-building-lock'}"></i></div>
      <div class="bd"><b>${esc(r.requesterName)} asks for ${r.kind === 'lead' ? 'a matching buyer’s details' : esc(r.title)}</b>
        <small>${r.clientName ? 'For their client ' + esc(r.clientName) + ' · ' : ''}${esc(ago(r.createdAt))} · decides: ${esc((r.approvers || []).map(e => nameOf(people, e).split(' ')[0]).join(', '))}</small>
        ${r.reason ? `<div class="q">“${esc(r.reason)}”</div>` : ''}
        <div class="acts"><button type="button" class="btn sm primary" data-decide="${esc(r.id)}">Approve or reject</button>${r.threadId ? `<a class="btn sm" href="messages.html?t=${encodeURIComponent(r.threadId)}"><i class="fa-regular fa-comments"></i> Message</a>` : ''}</div></div></div>`).join('') : empty('Nothing waiting.'));
    html += block('Properties agents added', subs.length, subs.length ? subs.map(s => `<div class="item"><div class="ic"><i class="fa-regular fa-building"></i></div>
      <div class="bd"><b>${esc((s.fields || {}).name)}</b><small>${esc(s.byName || nameOf(people, s.byEmail))} · ${esc(ago(s.createdAt))}</small>
        <small>${esc([s.fields.config, s.fields.startingPrice, s.fields.type, s.fields.zone].filter(Boolean).join(' · '))}</small>
        ${s.fields.location ? `<small>${esc(s.fields.location)}</small>` : ''}${s.fields.contactName || s.fields.contactNumber ? `<small>Owner: ${esc([s.fields.contactName, s.fields.contactNumber].filter(Boolean).join(' · '))}</small>` : ''}
        ${s.fields.notes ? `<div class="q">${esc(s.fields.notes)}</div>` : ''}
        <div class="acts"><button type="button" class="btn sm primary" data-sub="${esc(s.id)}" data-d="approve">Approve</button><button type="button" class="btn sm danger" data-sub="${esc(s.id)}" data-d="reject">Reject</button></div></div></div>`).join('') : empty('Nothing waiting.'));
    html += block('Shared right now', live.length, live.length ? live.map(g => `<div class="item"><div class="ic blue"><i class="fa-solid fa-lock-open"></i></div>
      <div class="bd"><b>${esc(g.agentName || nameOf(people, g.agentEmail))} — ${g.kind === 'lead' ? 'a buyer’s details' : esc(g.title)}</b>
        <small>Details ${g.expiresAt ? esc(untilWords(g.expiresAt)) : 'with no time limit'}${g.includeContact && (!g.contactExpiresAt || g.contactExpiresAt > now) ? ' · owner’s number ' + esc(untilWords(g.contactExpiresAt)) : ''} · approved by ${esc(g.grantedByName || nameOf(people, g.grantedBy))} ${esc(ago(g.grantedAt))}</small>
        <div class="acts">${g.includeContact && (!g.contactExpiresAt || g.contactExpiresAt > now) ? `<button type="button" class="btn sm" data-grant="${esc(g.id)}" data-a="hide-contact">Hide number</button>` : ''}<button type="button" class="btn sm danger" data-grant="${esc(g.id)}" data-a="revoke">Take back</button></div></div></div>`).join('') : empty('Nothing is shared outside its agents.'));
    html += block('Decided in the last 30 days', recent.length, recent.length ? recent.slice(0, 50).map(r => `<div class="item"><div class="ic ${r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : ''}"><i class="fa-solid fa-clock-rotate-left"></i></div>
      <div class="bd"><b>${esc(r.requesterName)} — ${r.kind === 'lead' ? 'a buyer’s details' : esc(r.title)}</b>
        <small><span class="tag ${r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : ''}">${esc(r.status)}</span>${r.decidedBy && r.status !== 'cancelled' ? ' by ' + esc(r.decidedByName || nameOf(people, r.decidedBy)) : ''} · ${esc(when(r.decidedAt))}</small>
        ${r.note ? `<div class="q">${esc(r.note)}</div>` : ''}</div></div>`).join('') : empty('Nothing decided lately.'));
    $('requests').innerHTML = html;
    $('requests').querySelectorAll('[data-decide]').forEach(b => b.addEventListener('click', () => {
      const r = S.reqs.find(x => x.id === b.dataset.decide);
      if (r) decideSheet(r, { canCoAgent: r.kind === 'property' });
    }));
    $('requests').querySelectorAll('[data-grant]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.a === 'revoke' && !confirm('Take back this access? The agent is told in Messages.')) return;
      busy(b, () => api(b.dataset.a, { grantId: b.dataset.grant }).then(() => toast(b.dataset.a === 'revoke' ? 'Access taken back' : 'Owner’s number hidden')).catch(e => toast('✗ ' + e.message)));
    }));
    $('requests').querySelectorAll('[data-sub]').forEach(b => b.addEventListener('click', () => decideSubmission(b.dataset.sub, b.dataset.d)));
  }

  function decideSubmission(id, d) {
    const s = S.subs.find(x => x.id === id);
    if (!s) return;
    openSheet(`<h3>${d === 'approve' ? 'Add to the inventory?' : 'Reject this property?'}</h3>
      <p class="sub">${esc((s.fields || {}).name)} · from ${esc(s.byName || nameOf(people, s.byEmail))}</p>
      ${d === 'approve' ? '<p class="note">It joins the properties with ' + esc(s.byName || 'the agent') + ' as its primary agent. Fill in the rest on the Property dashboard.</p>' : ''}
      <div class="field"><label for="sbNote">${d === 'approve' ? 'Note (optional)' : 'Why (the agent sees this)'}</label><textarea id="sbNote" maxlength="500"></textarea></div>
      <p class="err" id="sbErr"></p>
      <div class="bar"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn ${d === 'approve' ? 'primary' : 'danger'} block" id="sbGo">${d === 'approve' ? 'Approve' : 'Reject'}</button></div>`,
    { onOpen: (sh, close) => sh.querySelector('#sbGo').addEventListener('click', () => busy(sh.querySelector('#sbGo'), async () => {
      const note = sh.querySelector('#sbNote').value.trim();
      if (d === 'reject' && !note) { sh.querySelector('#sbErr').textContent = 'Say why, for the agent'; return; }
      try { const r = await api('submission-decide', { id, decision: d, note }); toast(d === 'approve' ? 'Added as ' + r.propertyId : 'Rejected'); close(); }
      catch (e) { sh.querySelector('#sbErr').textContent = e.message; }
    })) });
  }
}
