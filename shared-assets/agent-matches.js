// ═══════ BUYERS WHO MATCH AN AGENT'S PROPERTIES — one list, every state on the row ═══════
// Used by the property's Matches tab (dashboard-assets/agent-mode.js) and by My Day. The server
// works the matches out (api/_agent-work.js matchesFor) from leads the agent does not work: other
// agents' clients, or nobody's yet. Each row says, without opening Messages:
//   Not asked yet · Details requested (when) · Approved — with the name, number, Call, WhatsApp and
//   Open in Leads while it runs · Rejected (by whom, why) · Expired / Cancelled · Access ended
// Asking happens IN the row (a short note, pre-filled — no pop-up), and so does cancelling.
//
// renderMatches(el, matches, { api, toast, propName(id), propHref(id), showProperty, limit, onChange })
import { esc, ago, untilWords } from './agent-client.js';

// Where a match stands, in one word for the filter, and the words for the badge.
export function matchState(m) {
  if (m && m.granted) return { key: 'approved', label: 'Approved', tone: 'green', detail: 'details ' + untilWords(m.granted.until) };
  const r = (m && m.req) || (m && m.requested ? { status: m.requested } : null);
  if (!r || !r.status) return { key: 'new', label: 'Not asked yet', tone: '' };
  if (r.status === 'pending') return { key: 'pending', label: 'Details requested', tone: 'wait', detail: r.at ? 'asked ' + ago(r.at) + ' · waiting for a decision' : 'waiting for a decision' };
  if (r.status === 'approved') return { key: 'ended', label: r.grantState === 'revoked' ? 'Access taken back' : 'Access ended', tone: '', detail: r.decidedAt ? 'approved ' + ago(r.decidedAt) : '' };
  if (r.status === 'rejected') return { key: 'rejected', label: 'Rejected', tone: 'red', detail: [r.by ? 'by ' + r.by : '', r.decidedAt ? ago(r.decidedAt) : ''].filter(Boolean).join(' · '), note: r.note || '' };
  if (r.status === 'expired') return { key: 'expired', label: 'Request expired', tone: '', detail: 'nobody decided within 7 days' };
  if (r.status === 'cancelled') return { key: 'cancelled', label: 'You cancelled', tone: '' };
  return { key: 'new', label: 'Not asked yet', tone: '' };
}
// The order a busy agent wants: someone to call now, then new buyers by fit, then the rest.
const ORDER = { approved: 0, new: 1, pending: 2, rejected: 3, ended: 4, expired: 4, cancelled: 4 };
export function sortMatches(list) {
  return (list || []).slice().sort((a, b) => (ORDER[matchState(a).key] - ORDER[matchState(b).key]) || ((b.pct || 0) - (a.pct || 0)));
}
const FILTERS = [['all', 'All'], ['new', 'Not asked'], ['pending', 'Requested'], ['approved', 'Approved'], ['closed', 'Rejected / ended']];
const inFilter = (k, f) => f === 'all' || (f === 'closed' ? ['rejected', 'ended', 'expired', 'cancelled'].includes(k) : k === f);
export function matchCounts(list) {
  const c = { all: 0, new: 0, pending: 0, approved: 0, closed: 0 };
  (list || []).forEach(m => { const k = matchState(m).key; c.all++; FILTERS.slice(1).forEach(([f]) => { if (inFilter(k, f)) c[f]++; }); });
  return c;
}

// "Not a fit": hidden on this device (the agent's own judgement — nothing is sent). Shown again by
// "Show N hidden".
const HIDE_KEY = 'pin.matches.hidden';
const hiddenSet = () => { try { return new Set(JSON.parse(localStorage.getItem(HIDE_KEY) || '[]')); } catch (e) { return new Set(); } };
const setHidden = (key, on) => { const h = hiddenSet(); if (on) h.add(key); else h.delete(key); try { localStorage.setItem(HIDE_KEY, JSON.stringify([...h].slice(-500))); } catch (e) { /* private window */ } };
const keyOf = m => m.ref + '|' + m.propertyId;
const tel = p => String(p || '').replace(/[^\d+]/g, '');
const wa = p => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d; };

function rowHtml(m, o) {
  const s = matchState(m);
  const g = m.granted;
  const prop = o.showProperty && o.propName ? o.propName(m.propertyId) : '';
  const fit = `${esc(m.band || 'Match')}${m.pct ? ' · ' + m.pct + '%' : ''}`;
  const canAsk = ['new', 'rejected', 'ended', 'expired', 'cancelled'].includes(s.key);
  const reqId = m.req && m.req.id;
  return `<article class="mx" data-state="${s.key}" data-ref="${esc(m.ref)}" data-pid="${esc(m.propertyId)}">
    <div class="mx-top">
      <span class="mx-fit">${fit}</span>
      <span class="mx-tag ${s.tone}">${s.key === 'approved' ? '<i class="fa-solid fa-lock-open" aria-hidden="true"></i> ' : s.key === 'pending' ? '<i class="fa-regular fa-hourglass-half" aria-hidden="true"></i> ' : ''}${esc(s.label)}</span>
    </div>
    ${prop ? `<div class="mx-prop">For ${o.propHref ? `<a href="${esc(o.propHref(m.propertyId))}">${esc(prop)}</a>` : esc(prop)}</div>` : ''}
    ${g ? `<div class="mx-person"><b>${esc(g.name || 'Buyer')}</b>${g.phone ? ` <span class="mx-phone">${esc(g.phone)}</span>` : ''}</div>` : m.name ? `<div class="mx-person"><b>${esc(m.name)}</b></div>` : ''}
    ${m.requirement ? `<p class="mx-req">${esc(m.requirement)}</p>` : ''}
    ${m.aiSummary ? `<details class="mx-ai"><summary>What they told us</summary><p>${esc(m.aiSummary)}</p></details>` : ''}
    ${s.detail ? `<p class="mx-meta">${esc(s.detail)}</p>` : ''}
    ${s.note ? `<p class="mx-note">“${esc(s.note)}”</p>` : ''}
    <div class="mx-acts">
      ${g ? `${g.phone ? `<a class="ag-btn primary" href="tel:${esc(tel(g.phone))}"><i class="fa-solid fa-phone" aria-hidden="true"></i> Call</a><a class="ag-btn" href="https://wa.me/${esc(wa(g.phone))}" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp" aria-hidden="true"></i> WhatsApp</a>` : ''}<a class="ag-btn" href="crm.html?lead=${encodeURIComponent(g.leadId)}">Open in Leads</a>` : ''}
      ${canAsk ? `<button type="button" class="ag-btn${s.key === 'new' ? ' primary' : ''}" data-mx="ask"><i class="fa-solid fa-unlock" aria-hidden="true"></i> ${s.key === 'new' ? 'Request details' : 'Ask again'}</button>` : ''}
      ${s.key === 'pending' && reqId ? `<button type="button" class="ag-btn quiet" data-mx="cancel" data-req="${esc(reqId)}">Cancel request</button>` : ''}
      ${s.key === 'new' ? `<button type="button" class="ag-btn quiet" data-mx="${o.hidden && o.hidden.has(keyOf(m)) ? 'unhide">Show again' : 'hide">Not a fit'}</button>` : ''}
    </div>
    <div class="mx-ask" hidden>
      <label class="mx-ask-l" for="mx-r-${esc(m.ref).slice(-10)}-${esc(m.propertyId)}">Note for their agent</label>
      <textarea id="mx-r-${esc(m.ref).slice(-10)}-${esc(m.propertyId)}" maxlength="500" rows="2"></textarea>
      <p class="mx-err" role="alert"></p>
      <div class="mx-acts"><button type="button" class="ag-btn primary" data-mx="send">Send request</button><button type="button" class="ag-btn quiet" data-mx="back">Not now</button></div>
    </div>
  </article>`;
}

export function renderMatches(el, matches, o = {}) {
  if (!el) return;
  const all = sortMatches(matches);
  let filter = el.dataset.mxFilter || 'all';
  let expanded = el.dataset.mxAll === '1';
  const draw = () => {
    const hid = hiddenSet();
    const showHidden = el.dataset.mxHidden === '1';
    const visible = all.filter(m => showHidden || !(matchState(m).key === 'new' && hid.has(keyOf(m))));
    const nHidden = all.length - all.filter(m => !(matchState(m).key === 'new' && hid.has(keyOf(m)))).length;
    o.hidden = hid;
    const c = matchCounts(visible);
    if (!c[filter]) filter = 'all';
    const shown = visible.filter(m => inFilter(matchState(m).key, filter));
    const limit = o.limit && !expanded ? o.limit : Infinity;
    el.innerHTML = all.length ? `
      ${all.length > 2 ? `<div class="mx-chips" role="group" aria-label="Show">${FILTERS.filter(([f]) => f === 'all' || c[f]).map(([f, l]) =>
        `<button type="button" class="mx-chip" data-f="${f}" aria-pressed="${f === filter}">${l} <span>${c[f]}</span></button>`).join('')}</div>` : ''}
      <div class="mx-list">${shown.slice(0, limit).map(m => rowHtml(m, o)).join('')}</div>
      ${shown.length > limit ? `<button type="button" class="mx-more">Show all ${shown.length}</button>` : ''}
      ${nHidden ? `<button type="button" class="mx-hidden-t" data-mx-toggle>${showHidden ? 'Hide the ones marked not a fit' : `Show ${nHidden} marked not a fit`}</button>` : ''}` : (o.empty || '');
    el.dataset.mxFilter = filter;
  };
  draw();
  if (el.__mxBound) { el.__mxOpts = o; el.__mxAll = all; return; }
  el.__mxBound = true; el.__mxOpts = o; el.__mxAll = all;
  el.addEventListener('click', async e => {
    const opts = el.__mxOpts || {};
    const chip = e.target.closest('.mx-chip');
    if (chip) { el.dataset.mxFilter = chip.dataset.f; renderMatches(el, el.__mxAll, opts); return; }
    if (e.target.closest('.mx-more')) { el.dataset.mxAll = '1'; renderMatches(el, el.__mxAll, opts); return; }
    if (e.target.closest('[data-mx-toggle]')) { el.dataset.mxHidden = el.dataset.mxHidden === '1' ? '' : '1'; renderMatches(el, el.__mxAll, opts); return; }
    const b = e.target.closest('[data-mx]');
    if (!b) return;
    const row = b.closest('.mx');
    const ref = row.dataset.ref, pid = row.dataset.pid;
    const box = row.querySelector('.mx-ask');
    const ta = box.querySelector('textarea');
    const err = box.querySelector('.mx-err');
    if (b.dataset.mx === 'ask') {
      const name = opts.propName ? opts.propName(pid) : '';
      if (!ta.value) ta.value = `My property${name ? ' ' + name : ''} fits what they are looking for — I'd like to show it to them.`;
      box.hidden = false; b.closest('.mx-acts').hidden = true;
      ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
      return;
    }
    if (b.dataset.mx === 'hide' || b.dataset.mx === 'unhide') {
      setHidden(ref + '|' + pid, b.dataset.mx === 'hide');
      if (opts.toast && b.dataset.mx === 'hide') opts.toast('Marked not a fit — hidden on this device');
      renderMatches(el, el.__mxAll, opts); return;
    }
    if (b.dataset.mx === 'back') {
      box.hidden = true; row.querySelector('.mx-acts').hidden = false; err.textContent = '';
      const ask = row.querySelector('[data-mx="ask"]'); if (ask) ask.focus();   // focus back where it was
      return;
    }
    if (b.dataset.mx === 'send') {
      const reason = ta.value.trim();
      if (!reason) { err.textContent = 'Say why, so their agent can decide'; ta.focus(); return; }
      b.disabled = true; b.textContent = 'Sending…'; err.textContent = '';
      try {
        const r = await opts.api('request', { kind: 'lead', ref, reason, propertyId: pid });
        // At once, before the agent's copy catches up.
        const m = (el.__mxAll || []).find(x => x.ref === ref && String(x.propertyId) === String(pid));
        (el.__mxAll || []).filter(x => x.ref === ref).forEach(x => { x.requested = 'pending'; x.req = { status: 'pending', id: r && r.id, at: Date.now() }; });
        if (opts.toast) opts.toast('Request sent — their agent decides. You’ll see it here and in My Day.');
        renderMatches(el, el.__mxAll, opts);
        if (opts.onChange) opts.onChange(m);
      } catch (x) { b.disabled = false; b.textContent = 'Send request'; err.textContent = x.message || 'Could not send — try again'; }
      return;
    }
    if (b.dataset.mx === 'cancel') {
      if (!confirm('Cancel your request for this buyer’s details?')) return;
      b.disabled = true;
      try {
        await opts.api('cancel', { id: b.dataset.req });
        (el.__mxAll || []).filter(x => x.ref === ref).forEach(x => { x.requested = 'cancelled'; x.req = { ...(x.req || {}), status: 'cancelled', decidedAt: Date.now() }; });
        if (opts.toast) opts.toast('Request cancelled');
        renderMatches(el, el.__mxAll, opts);
        if (opts.onChange) opts.onChange();
      } catch (x) { b.disabled = false; if (opts.toast) opts.toast('✗ ' + x.message); }
    }
  });
}
