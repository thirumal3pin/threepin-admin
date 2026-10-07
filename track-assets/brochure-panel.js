// ═══════ BROCHURE PANEL — on a listing, below its notes ═══════
//
// Property code, title, photos link, description and internal notes — the five
// things the brochure pipeline needs — kept on the listing itself, so the brochure
// can be asked for from here instead of retyping it all on the Create brochure page.
//
//   • Linked to a dashboard property: everything fills from that property, and the
//     "Brochure created" box ticks itself when its brochure has been delivered.
//   • Not linked: fill it in and Generate. The request goes to the same Google Form
//     as the Create brochure page. When the property arrives in the dashboard, the
//     listing links to it on its own, pulls in the brochure, and ticks the box.
//   • Typing a code: existing codes are suggested; a code already in the dashboard
//     offers Preview and Link; a near-miss (THVA0001 for THVA001) says so.
//
// The rules live in brochure-flow.js. This file draws them and talks to the board
// through window.trackApi (set up by app.js).

import * as B from './brochure-flow.js';

const api = () => window.trackApi;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A value inside an inline handler (onclick="fn(…)"). esc() alone is not enough there: the browser
// decodes &#39; back to ' before running the handler, so a code like X');alert(1);// would run.
// A JSON string literal, then escaped for the attribute, stays a string. Used without quotes around it.
const jsq = v => esc(JSON.stringify(String(v == null ? '' : v)));
const $ = id => document.getElementById(id);
const inv = () => (api() && api().inventory()) || [];
const listingsNow = () => (api() && api().listings()) || [];
const byId = id => listingsNow().find(l => l.id === id) || null;
const fmt = ts => ts ? new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
const STATE = {
  none: ['Not started', 'muted'],
  requested: ['Requested — waiting for it to reach the dashboard', 'warn'],
  building: ['Built — waiting for delivery from the Mac', 'warn'],
  ready: ['Brochure created', 'ok']
};

// A code being typed is a draft, kept here until the box is left — not on the listing, where it
// would look already saved and the save on leaving the box would find nothing to do.
const drafts = new Map();
const withDraft = x => (x && drafts.has(x.id) && !B.isRealCode(x.propertyCode) ? { ...x, brochure: { ...(x.brochure || {}), code: drafts.get(x.id) } } : x);
// Listings whose brochure request is on its way to the form right now (one send per listing).
const sending = new Set();

// ── The panel ──
window.bpPanelHtml = x0 => {
  const x = withDraft(x0);
  // The header says what the tile says (one rule, in app.js): a brochure unlocked for a redo is
  // not "created" any more, even though its old link is still on the listing.
  const shared = api() && api().brochureOf ? api().brochureOf(x0) : null;
  const st = shared ? (shared === 'created' ? 'ready' : shared) : B.brochureState(x, inv());
  const mapped = B.isRealCode(x.propertyCode);
  const code = B.listingCode(x);
  const done = B.isLocked(x, inv());
  const p = mapped ? inv().find(q => B.codeKey(q.propertyCode) === B.codeKey(x.propertyCode)) : null;
  const link = B.isUrl(x.brochureLink) ? x.brochureLink : (p && B.isUrl(p.brochureLink) ? p.brochureLink : '');
  if (done) return frozenHtml(x, code, link);
  const id = jsq(x.id);
  return `<div class="tk-sec bp" id="bpSec">
    <div class="tk-sec-hdr bp-hdr">Brochure <span class="bp-state ${STATE[done ? 'ready' : st][1]}">${esc(STATE[done ? 'ready' : st][0])}</span></div>
    <label class="tk-check bp-done"><input type="checkbox" ${done ? 'checked' : ''} onchange="bpMarkDone(${id}, this.checked)"> Brochure created${link ? ` — <a href="${esc(link)}" target="_blank" rel="noopener">open ↗</a>` : ''}</label>
    ${x.brochure && x.brochure.requestedAt ? `<div class="tk-hint">Requested ${esc(fmt(x.brochure.requestedAt))}${x.brochure.by ? ' by ' + esc(String(x.brochure.by).split('@')[0]) : ''} as <b>${esc(x.brochure.title || B.brochureTitle(x))}</b>.${st === 'requested' && code ? ' This listing links to the property on its own once it is in the dashboard.' : ''}</div>` : ''}

    <label class="bp-l" for="bpCode">Property code</label>
    ${mapped
      ? `<div class="bp-mapped"><span class="tk-code">${esc(x.propertyCode)}</span><span class="bp-ok">✓ Linked to the Property dashboard</span>
           <button type="button" class="tk-link" onclick="bpPreview(${jsq(x.propertyCode)})">Preview</button>
           <button type="button" class="tk-link" onclick="openMapProperty(${id})">Change</button></div>`
      : `<div class="bp-codewrap">
           <input id="bpCode" class="tk-in bp-in" type="text" value="${esc(code)}" placeholder="e.g. TNAG0002" autocomplete="off" spellcheck="false"
             oninput="bpCodeInput(${id}, this.value)" onfocus="bpCodeInput(${id}, this.value)" onblur="setTimeout(() => bpSug(false), 150)" onchange="bpSaveCode(${id}, this.value)">
           <div id="bpSug" class="bp-sug" role="listbox"></div>
         </div>
         <div id="bpVerdict" class="bp-verdict">${verdictHtml(x.id, code)}</div>`}

    <label class="bp-l" for="bpTitle">Title <span class="tk-opt">sent as “code - title”</span></label>
    <input id="bpTitle" class="tk-in bp-in" type="text" value="${esc(x.title === 'New listing' ? '' : x.title)}" placeholder="Premium 4BHK Apartments in Thiruvanmiyur" onchange="bpSave(${id}, 'title', this.value)">

    <label class="bp-l" for="bpPhotos">Photos link <span class="tk-opt">Google Drive folder</span></label>
    <input id="bpPhotos" class="tk-in bp-in" type="url" value="${esc(x.photosLink)}" placeholder="https://drive.google.com/drive/folders/…" onchange="bpSave(${id}, 'photosLink', this.value)">

    <label class="bp-l" for="bpDesc">Description</label>
    <textarea id="bpDesc" class="tk-area bp-in" rows="7" placeholder="Title, specs, highlights, price, nearby landmarks — what goes in the brochure" onchange="bpSave(${id}, 'description', this.value)">${esc(x.description)}</textarea>

    <label class="bp-l" for="bpInternal">Internal notes <span class="tk-opt">team only — owner number, keys, anything not for buyers</span></label>
    <textarea id="bpInternal" class="tk-area bp-in" rows="3" onchange="bpSave(${id}, 'internalNotes', this.value)">${esc(x.internalNotes)}</textarea>

    <div id="bpCheck">${checkHtml(x)}</div>
  </div>`;
};

// Once the brochure is created, what it was made from is a record: shown, copyable, not editable.
// Unticking "Brochure created" is the one way back (for a genuine re-do).
const FROZEN = [['code', 'Property code'], ['title', 'Title'], ['photosLink', 'Photos link'], ['description', 'Description'], ['internalNotes', 'Internal notes']];
let frozenText = {};
function frozenHtml(x, code, link) {
  const val = { code, title: x.title === 'New listing' ? '' : x.title, photosLink: x.photosLink, description: x.description, internalNotes: x.internalNotes };
  frozenText = { ...val, all: [`${B.normCode(code)} - ${val.title || ''}`, val.photosLink, val.description, val.internalNotes ? 'Internal notes:\n' + val.internalNotes : ''].filter(Boolean).join('\n\n') };
  const when = x.brochure && x.brochure.doneAt;
  return `<div class="tk-sec bp frozen" id="bpSec">
    <div class="tk-sec-hdr bp-hdr">Brochure <span class="bp-state ok">✓ Brochure created</span></div>
    <label class="tk-check bp-done"><input type="checkbox" checked onchange="bpUnfreeze(${jsq(x.id)}, this)"> Brochure created${link ? ` — <a href="${esc(link)}" target="_blank" rel="noopener">open ↗</a>` : ''}</label>
    <div class="tk-hint">Locked${when ? ' since ' + esc(fmt(when)) : ''} — this is what the brochure was made from. Copy anything you need; untick above only to redo it.</div>
    ${FROZEN.map(([k, label]) => `<div class="bp-ro">
      <div class="bp-ro-h"><span class="bp-l">${esc(label)}</span>${val[k] ? `<button type="button" class="bp-copy" onclick="bpCopy(${jsq(k)}, this)">Copy</button>` : ''}</div>
      <div class="bp-ro-v${k === 'description' || k === 'internalNotes' ? ' long' : ''}">${val[k] ? (k === 'photosLink' && B.isUrl(val[k]) ? `<a href="${esc(val[k])}" target="_blank" rel="noopener">${esc(val[k])}</a>` : esc(val[k])) : '<span class="bp-muted">—</span>'}</div>
    </div>`).join('')}
    <button type="button" class="tk-btn bp-copyall" onclick="bpCopy(${jsq('all')}, this)">Copy all</button>
  </div>`;
}
window.bpCopy = (k, btn) => {
  const text = frozenText[k] || '';
  const ok = () => { if (btn) { const t = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = t; }, 1400); } };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok).catch(() => fallbackCopy(text, ok));
  else fallbackCopy(text, ok);
};
function fallbackCopy(text, ok) {
  const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); ok(); } catch (e) { api().toast('Could not copy — select the text instead'); }
  ta.remove();
}
window.bpUnfreeze = (id, box) => {
  if (!confirm('Unlock the brochure details?\n\n“Brochure created” is unticked and the fields become editable, so the brochure can be redone. The delivered brochure itself is not deleted.')) { box.checked = true; return; }
  const p = inv().find(q => B.codeKey(q.propertyCode) === B.codeKey(B.listingCode(byId(id))));
  const showing = (p && B.isUrl(p.brochureLink) && p.brochureLink) || (byId(id) || {}).brochureLink || '';
  api().mutate(id, l => { l.brochure = { ...(l.brochure || {}), doneAt: null, unlockedAt: Date.now(), unlockedLink: showing }; }, 'Brochure details unlocked for a redo');
  if (api().currentDetailId() === id) api().openDetail(id);
};

// The checklist and the Generate button. Split in two so a save can repaint the list without
// replacing the button (see paintCheck).
function checkParts(x) {
  const c = B.brochureCheck(x, inv(), listingsNow());
  const asked = !!(x.brochure && x.brochure.requestedAt);
  const done = B.brochureState(x, inv()) === 'ready';
  const busy = sending.has(x.id);
  const lines = [
    ...c.missing.map(m => `<li class="no">${esc(m)}</li>`),
    ...c.warnings.map(w => `<li class="warn">${esc(w)}</li>`)
  ];
  return {
    info: `${c.ok ? `<div class="bp-sendas">Goes to the pipeline as <b>${esc(B.brochureTitle(x))}</b></div>` : ''}${lines.length ? `<ul class="bp-list">${lines.join('')}</ul>` : ''}`,
    disabled: busy || !c.ok,
    label: busy ? 'Sending…' : done ? 'Generate again' : asked ? 'Send again' : 'Generate brochure'
  };
}
function checkHtml(x) {
  const v = checkParts(x);
  // display:contents keeps the list a direct part of .bp-go's column layout.
  return `<div class="bp-go">
    <div class="bp-go-info" style="display:contents">${v.info}</div>
    <button type="button" class="tk-btn primary bp-gen" ${v.disabled ? 'disabled' : ''} onclick="bpGenerate(${jsq(x.id)})">${esc(v.label)}</button>
  </div>`;
}
// Repaints the checklist in place. The button element itself is kept: leaving a field by
// clicking Generate saves that field (blur → change) between the button's mousedown and click,
// and a replaced button would swallow that first click.
function paintCheck(id, given) {
  const x = given || withDraft(byId(id)), el = $('bpCheck');
  if (!x || !el || (api().currentDetailId && api().currentDetailId() !== id)) return;
  const info = el.querySelector('.bp-go-info'), btn = el.querySelector('.bp-gen');
  if (!info || !btn) { el.innerHTML = checkHtml(x); return; }
  const v = checkParts(x);
  info.innerHTML = v.info;
  btn.disabled = v.disabled;
  btn.textContent = v.label;
}

// ── Saving a field (no redraw, so the caret stays where it is) ──
window.bpSave = (id, field, value) => {
  const v = String(value || '').trim();
  const x = byId(id); if (!x) return;
  if ((x[field] || '') === v) return;
  api().mutate(id, l => { l[field] = v; }, null);
  paintCheck(id);
};
window.bpSaveCode = (id, value) => {
  const x = byId(id); if (!x || B.isRealCode(x.propertyCode)) return;
  const code = B.normCode(value);
  // Compared with what is saved — the draft typed so far is not the listing yet.
  drafts.delete(id);
  if (((x.brochure && x.brochure.code) || '') !== code) api().mutate(id, l => { l.brochure = { ...(l.brochure || {}), code }; }, null);
  paintCheck(id);
};

// ── Typing a code: suggestions and the verdict ──
function verdictHtml(id, code) {
  const c = String(code || '').trim();
  if (!c) return '<span class="bp-muted">Type the code for this property. Existing codes are suggested as you type.</span>';
  const f = B.findCode(c, inv(), listingsNow(), id);
  if (f.inventory) {
    const p = f.inventory;
    return `<div class="bp-v dup"><b>Duplicate code found.</b> ${esc(p.propertyCode)} is already in the Property dashboard — ${esc(p.name || '')}${p.location ? ', ' + esc(p.location) : ''}.
      <div class="bp-v-acts"><button type="button" class="tk-btn sm" onclick="bpPreview(${jsq(p.propertyCode)})">Preview property</button>
      <button type="button" class="tk-btn sm primary" onclick="bpLink(${jsq(id)}, ${jsq(p.propertyCode)})">Link this listing to it</button></div>
      <div class="bp-muted">Linking brings its photos, brochure, description and internal notes here. If this is a different property, use a different code.</div></div>`;
  }
  if (f.listing) {
    return `<div class="bp-v dup"><b>Already used on this board</b> by “${esc(f.listing.title || 'another listing')}”. One code, one property — use a different code, or open that listing.
      <div class="bp-v-acts"><button type="button" class="tk-btn sm" onclick="openDetail(${jsq(f.listing.id)})">Open that listing</button></div></div>`;
  }
  if (!B.looksLikeCode(c)) return '<div class="bp-v warn">Codes look like <b>TNAG0002</b> — letters, then numbers.</div>';
  const sim = B.similarCodes(c, inv());
  if (sim.length) {
    return `<div class="bp-v warn"><b>Did you mean ${sim.map(p => esc(p.propertyCode)).join(' or ')}?</b> ${sim.length === 1 ? esc(sim[0].name || '') + ' is' : 'Those are'} already in the dashboard.
      <div class="bp-v-acts">${sim.map(p => `<button type="button" class="tk-btn sm" onclick="bpPreview(${jsq(p.propertyCode)})">Preview ${esc(p.propertyCode)}</button>
        <button type="button" class="tk-btn sm primary" onclick="bpLink(${jsq(id)}, ${jsq(p.propertyCode)})">Link to ${esc(p.propertyCode)}</button>`).join('')}</div>
      <div class="bp-muted">If ${esc(B.normCode(c))} really is a new property, carry on.</div></div>`;
  }
  return `<div class="bp-v ok">✓ ${esc(B.normCode(c))} is a new code — not in the dashboard yet. Generating the brochure creates it there.</div>`;
}
window.bpCodeInput = (id, value) => {
  const v = $('bpVerdict'); if (v) v.innerHTML = verdictHtml(id, value);
  const list = B.codeSuggestions(value, inv()).filter(p => B.codeKey(p.propertyCode) !== B.codeKey(value));
  const box = $('bpSug'); if (!box) return;
  box.innerHTML = list.map(p => `<button type="button" class="bp-opt" role="option" onmousedown="event.preventDefault()" onclick="bpPickSug(${jsq(id)}, ${jsq(p.propertyCode)})"><b>${esc(p.propertyCode)}</b><span>${esc([p.name, p.location].filter(Boolean).join(' · '))}</span></button>`).join('');
  box.classList.toggle('open', list.length > 0);
  // The draft code is kept as it is typed, so the checklist below follows along. Saved on leaving the box.
  const x = byId(id);
  if (x && !B.isRealCode(x.propertyCode)) { drafts.set(id, B.normCode(value)); paintCheck(id); }
};
window.bpSug = open => { const box = $('bpSug'); if (box && !open) box.classList.remove('open'); };
window.bpPickSug = (id, code) => {
  const inp = $('bpCode'); if (inp) inp.value = code;
  bpSug(false);
  bpCodeInput(id, code);
  bpSaveCode(id, code);
};

// What a listing carries from the property it was linked to: its delivered brochure (and the
// brochure's state), and its photos link if that is the property's. Dropped when the link goes or
// moves to another property — they belong to the old one.
function fromOldProperty(x) {
  const old = x && String(x.propertyCode || '').trim() ? inv().find(q => B.codeKey(q.propertyCode) === B.codeKey(x.propertyCode)) : null;
  const patch = { brochureLink: '' };
  if (old && B.isUrl(old.photosLink) && String(old.photosLink).trim() === String(x.photosLink || '').trim()) patch.photosLink = '';
  return { patch, brochure: { doneAt: null, requestedAt: null, requestedCode: '', unlockedAt: null, unlockedLink: '' } };
}

// ── Link a listing to a dashboard property: the shared path (also used by "Map to a property") ──
// Resolves true once linked, false when it could not be or the person cancelled.
window.bpLink = async (id, code) => {
  const x = byId(id);
  const p = inv().find(q => B.codeKey(q.propertyCode) === B.codeKey(code));
  if (!x || !p) return false;
  const taken = B.findCode(p.propertyCode, inv(), listingsNow(), id).listing;
  if (taken && !confirm(`${p.propertyCode} is already linked to “${taken.title || 'another listing'}”.\n\nLink this listing to it as well?`)) return false;
  let notes = '';
  try { notes = window.trackFirebase && window.trackFirebase.getPropertyInternalNotes ? await window.trackFirebase.getPropertyInternalNotes(p.id) : ''; } catch (e) { console.error('internal notes read failed:', e); }
  // Moving from one property to another: start from what is the listing's own, not the old property's.
  const switching = String(x.propertyCode || '').trim() && B.codeKey(x.propertyCode) !== B.codeKey(p.propertyCode);
  const reset = switching ? fromOldProperty(x) : null;
  const f = B.fillFromProperty(reset ? { ...x, ...reset.patch } : x, p, notes);
  drafts.delete(id);
  api().mutate(id, l => {
    if (reset) { Object.assign(l, reset.patch); l.brochure = { ...(l.brochure || {}), ...reset.brochure }; }
    l.propertyCode = p.propertyCode;
    Object.assign(l, f.patch);
    l.brochure = { ...(l.brochure || {}), code: p.propertyCode };
    // Unlocked for a redo and linked back to the same property: the brochure that was showing
    // then is not a new one, so it does not lock the panel again.
    if (B.isUrl(p.brochureLink) && String(p.brochureLink).trim() !== String(l.brochure.unlockedLink || '').trim()) l.brochure.doneAt = l.brochure.doneAt || Date.now();
  }, `Linked to <b>${esc(p.propertyCode)}</b> in the Property dashboard${f.filled.length ? ' — filled ' + esc(f.filled.join(', ').toLowerCase()) : ''}`);
  closePreview();
  api().toast(`Linked to ${p.propertyCode}${f.filled.length ? ' · ' + f.filled.length + ' field' + (f.filled.length === 1 ? '' : 's') + ' filled' : ''}`);
  if (api().currentDetailId() === id) api().openDetail(id);
  return true;
};

// ── A quick look at a dashboard property, without leaving the listing ──
window.bpPreview = code => {
  const p = inv().find(q => B.codeKey(q.propertyCode) === B.codeKey(code));
  const el = $('bpPrev'); if (!p || !el) return;
  const forId = api().currentDetailId();
  const forX = forId ? byId(forId) : null;
  const linked = forX && B.codeKey(forX.propertyCode) === B.codeKey(p.propertyCode);
  el.querySelector('.tk-prev-body').innerHTML = `
    <div class="bp-pv-code"><span class="tk-code">${esc(p.propertyCode)}</span>${p.soldOut ? '<span class="tk-pill muted">sold</span>' : ''}</div>
    <h3 class="bp-pv-name">${esc(p.name || p.propertyCode)}</h3>
    <div class="bp-pv-meta">${esc([p.location, p.config, p.type].filter(Boolean).join(' · '))}</div>
    ${p.startingPrice ? `<div class="bp-pv-price">${esc(p.startingPrice)}</div>` : ''}
    <div class="bp-pv-links">
      ${B.isUrl(p.photosLink) ? `<a class="tk-btn sm" href="${esc(p.photosLink)}" target="_blank" rel="noopener">📷 Photos ↗</a>` : '<span class="bp-muted">No photos link</span>'}
      ${B.isUrl(p.brochureLink) ? `<a class="tk-btn sm" href="${esc(p.brochureLink)}" target="_blank" rel="noopener">📄 Brochure ↗</a>` : `<span class="bp-muted">${p.brochureLink ? 'Brochure built, not delivered yet' : 'No brochure yet'}</span>`}
    </div>
    ${p.detailsText ? `<div class="bp-pv-desc">${esc(p.detailsText)}</div>` : '<div class="bp-muted">No description in the dashboard yet.</div>'}
    <div class="bp-pv-acts">
      <a class="tk-btn" href="dashboard.html?property=${encodeURIComponent(p.propertyCode)}" target="_blank" rel="noopener">Open in the dashboard ↗</a>
      ${forX && !linked ? `<button type="button" class="tk-btn primary" onclick="bpLink(${jsq(forX.id)}, ${jsq(p.propertyCode)})">Link this listing to it</button>` : ''}
    </div>`;
  el.classList.add('open');
};
function closePreview() { const el = $('bpPrev'); if (el) el.classList.remove('open'); }
window.bpClosePreview = closePreview;

// ── Ticking "Brochure created" by hand (for a brochure made outside the pipeline) ──
window.bpMarkDone = (id, on) => {
  api().mutate(id, l => { l.brochure = { ...(l.brochure || {}), doneAt: on ? Date.now() : null }; }, on ? 'Brochure marked created' : 'Brochure un-marked');
  if (api().currentDetailId() === id) api().openDetail(id);
};

// ── Generate: the same Google Form as the Create brochure page ──
window.bpGenerate = async id => {
  // One send per listing: a second click, or a fresh button from a redraw, waits for the first.
  if (sending.has(id)) return;
  const saved = byId(id); if (!saved) return;
  // Work on a copy with anything typed but not yet blurred: nothing on the listing changes
  // unless the request actually goes.
  const x = { ...withDraft(saved) };
  for (const [elId, f] of [['bpTitle', 'title'], ['bpPhotos', 'photosLink'], ['bpDesc', 'description'], ['bpInternal', 'internalNotes']]) {
    const el = $(elId); if (el) x[f] = el.value.trim();
  }
  const codeEl = $('bpCode'); if (codeEl && !B.isRealCode(x.propertyCode)) x.brochure = { ...(x.brochure || {}), code: B.normCode(codeEl.value) };
  const c = B.brochureCheck(x, inv(), listingsNow());
  if (!c.ok) { paintCheck(id, x); api().toast('Fill in what is listed first'); return; }
  if (c.warnings.length && !confirm(c.warnings.join('\n') + '\n\nGenerate anyway?')) return;
  if (x.brochure && x.brochure.requestedAt && !confirm(`A brochure was already requested ${fmt(x.brochure.requestedAt)}.\n\nSend it again? The pipeline builds a fresh one and emails it again.`)) return;
  if (sending.has(id)) return;   // a second click got through while a confirm was open
  const title = B.brochureTitle(x);
  const code = B.normCode(B.listingCode(x));
  sending.add(id); paintCheck(id, x);
  let sent = false;
  try {
    try {
      // Demo mode (localhost ?demo=1) must never reach the real form — that would start the real
      // pipeline and email a real brochure. It records the request locally instead.
      if (window.__demoMode) { console.info('[demo] brochure request not sent:', Object.fromEntries(B.formBody(x))); }
      // Google Forms sends no CORS headers: the request is delivered, the answer is opaque.
      else await fetch(B.FORM_ACTION, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: B.formBody(x).toString() });
    } catch (e) {
      console.error('brochure form submit failed:', e);
      api().toast('Could not send — check your connection. Nothing was lost.');
      return;
    }
    // Recorded the moment the form has it, before the log call below: from here a redraw shows
    // "Send again", which asks first.
    const now = Date.now();
    sent = true;
    drafts.delete(id);
    api().mutate(id, l => {
      l.title = x.title; l.photosLink = x.photosLink; l.description = x.description; l.internalNotes = x.internalNotes;
      l.brochure = { ...(l.brochure || {}), code, requestedCode: code, title, requestedAt: now, by: api().user() || '', doneAt: null };
    }, `Brochure requested as <b>${esc(title)}</b>`);
    // The team's brochure log (the Create brochure page's "Recent brochures") — best effort.
    if (!window.__demoMode) try {
      const token = window.trackAuth && window.trackAuth.getIdToken ? await window.trackAuth.getIdToken() : null;
      if (token) await fetch('/api/brochure?op=log', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    } catch (e) { /* the request went; the log line is a nicety */ }
    api().toast(window.__demoMode ? 'Demo: request recorded here only — nothing was sent' : '✓ Sent — the brochure is ready in about 30 minutes');
  } finally {
    sending.delete(id);
    // Not sent: only the button comes back, so whatever was typed stays in the boxes.
    if (!sent) paintCheck(id, x);
    else if (api().currentDetailId() === id) api().openDetail(id);
  }
};

// ── Keep listings in step with the dashboard: link on arrival, tick on delivery ──
// The properties collection is re-read only while some brochure is actually on its way; linked
// listings are otherwise kept in step from the inventory already loaded.
let reconciling = false, lastRun = 0;
window.bpReconcile = force => {
  if (reconciling || !api()) return;
  if (!force && Date.now() - lastRun < 60000) return;
  const now = Date.now();
  const waiting = listingsNow().some(x => B.awaitingBrochure(x, now));
  const cached = api().inventory();
  if (!waiting && !cached) return;
  reconciling = true; lastRun = Date.now();
  (waiting ? api().loadInventory(true) : Promise.resolve(cached)).then(list => {
    for (const u of B.reconcileBrochures(listingsNow(), list || [], Date.now())) {
      api().mutate(u.id, l => {
        const { brochure, ...rest } = u.patch;
        Object.assign(l, rest);
        if (brochure) l.brochure = { ...(l.brochure || {}), ...brochure };
      }, u.history);
    }
  }).catch(e => console.error('brochure reconcile failed:', e)).finally(() => { reconciling = false; });
};
setInterval(() => { if (document.visibilityState === 'visible') window.bpReconcile(); }, 5 * 60000);
// A tab coming back to the front catches up at once (hidden tabs skip the checks).
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') window.bpReconcile(); });

// ── The New listing / Edit form: same code check under its Property ID box ──
// The listing being edited, when the code in the box is the one it is already linked to.
const keptLink = (code, editId) => {
  const x = editId ? byId(editId) : null;
  return x && String(x.propertyCode || '').trim() && B.codeKey(code) === B.codeKey(x.propertyCode) ? x : null;
};
window.bpModalCode = value => {
  const el = $('mmCodeHint'); if (!el) return;
  const editId = api().editingId();
  const c = String(value || '').trim();
  if (!c) { el.innerHTML = ''; return; }
  const kept = keptLink(c, editId);
  if (kept) { el.innerHTML = `<div class="bp-v ok">✓ Linked to ${esc(kept.propertyCode)} in the Property dashboard — saving keeps the link.</div>`; return; }
  const f = B.findCode(c, inv(), listingsNow(), editId);
  if (f.inventory) el.innerHTML = `<div class="bp-v dup"><b>Already in the dashboard:</b> ${esc(f.inventory.name || '')}. Saving links this listing to it and brings its photos, brochure and details. <button type="button" class="tk-link" onclick="bpPreview(${jsq(f.inventory.propertyCode)})">Preview</button></div>`;
  else if (f.listing) el.innerHTML = `<div class="bp-v dup"><b>Already used</b> by “${esc(f.listing.title || 'another listing')}” on this board — use a different code.</div>`;
  else if (!B.looksLikeCode(c)) el.innerHTML = '<div class="bp-v warn">Codes look like <b>TNAG0002</b> — letters, then numbers.</div>';
  else { const sim = B.similarCodes(c, inv()); el.innerHTML = sim.length ? `<div class="bp-v warn"><b>Did you mean ${sim.map(p => esc(p.propertyCode)).join(' or ')}?</b> ${sim.map(p => `<button type="button" class="tk-link" onclick="bpModalUse(${jsq(p.propertyCode)})">Use ${esc(p.propertyCode)}</button>`).join(' ')}</div>` : `<div class="bp-v ok">✓ New code — the listing keeps it for its brochure.</div>`; }
};
window.bpModalUse = code => { const el = $('mm_propertyCode'); if (el) { el.value = code; window.bpModalCode(code); } };
// Called by saveModal: decides what a typed Property ID means. Returns { error } or the patch.
window.bpResolveFormCode = (form, editId) => {
  const code = B.normCode(form.propertyCode);
  const x = editId ? byId(editId) : null;
  if (!code) {
    // Box emptied on a linked listing: an unlink. Its code goes too, or the background check would
    // link it straight back to the property its brochure was requested for.
    // What came with the old property (its brochure, its photos link) goes with the link.
    if (x && String(x.propertyCode || '').trim()) { const r = fromOldProperty(x); return { propertyCode: '', brochure: { ...r.brochure, code: '' }, patch: r.patch }; }
    return { propertyCode: '', brochure: null };
  }
  // The code it is already linked to: kept exactly as it is. Older properties have a bare number
  // for an id (not a code findCode matches), and two listings may share a property on purpose.
  if (keptLink(code, editId)) return { propertyCode: x.propertyCode };
  const f = B.findCode(code, inv(), listingsNow(), editId);
  // In the dashboard: link it — even if another listing is linked too (bpLink asks about that).
  if (f.inventory) return { propertyCode: f.inventory.propertyCode, link: f.inventory.propertyCode };
  const unchanged = x && x.brochure && B.codeKey(code) === B.codeKey(x.brochure.code);
  if (f.listing && !unchanged) return { error: `${code} is already used by “${f.listing.title || 'another listing'}” on this board.` };
  // Not in the dashboard yet: kept as the brochure's code, not as a dashboard link. A listing that
  // was linked to another property leaves that property's brochure and photos behind.
  if (x && String(x.propertyCode || '').trim()) { const r = fromOldProperty(x); return { propertyCode: '', brochure: { ...r.brochure, code }, patch: r.patch }; }
  return { propertyCode: '', brochure: { code } };
};
