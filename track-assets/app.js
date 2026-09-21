// ═══════ 3 PIN REALTY — PROPERTY & MEDIA TRACK ═══════
//
// A board for the thing the CRM never tracked: what happens to a PROPERTY
// between "the owner said yes" and "the brochure is out". The CRM board
// follows a person through a sale; this one follows a property through
// getting listed — details, shoot, brochure, live.
//
// Deliberately the same shape as crm-assets/app.js — generated HTML uses
// inline onclick, so every handler is published on `window` at the bottom of
// its section — because the two boards are read by the same people on the same
// day; a second set of interaction habits for the same gesture would be the
// expensive part. Unlike the CRM's app.js this is an ES module (it imports the
// stage definitions directly rather than through a window bridge), which is
// also why it boots the rail itself at the end: a classic nav-boot.js would
// run before this module and find none of its globals.
//
// Three views, and the third is the point:
//   Board    — the pipeline, drag a card to move it
//   Shoots   — every booked shoot in date order, the day's run sheet
//   Sellers  — every seller lead in the CRM with NO listing card yet
//
// That last view exists because a seller who never gets a card is revenue
// that silently evaporates. It is computed from the live lead set every
// render, so it cannot drift: if a seller is in the CRM and not on this
// board, they are on that list.

import * as P from './track-pipeline.js';
import { planSync, newListingFor, isSellerLead as isSeller } from './seller-sync.js';

// ═══════ STATE ═══════
let listings = [];
let stages = [];
let leads = [];              // every lead, for the seller views
let inventory = null;        // lazily fetched, then cached
let filtered = [];
let currentView = 'board';
let currentSearch = '';
let currentDetailId = null;
let mModalMode = 'add';
let mModalEditId = null;
let currentUserEmail = null;
let trackInited = false;
let stageFilter = new Set();

const TRACK_VIEWS = ['board', 'shoots', 'sellers'];
const DAY = 86400000;

// Board or list, remembered per device. The board is for moving work along;
// the list is for reading across everything at once — what is unmapped, whose
// shoot is late, which owner has not approved. Same data, same filters, two
// ways of looking, because "where is this one" and "what is the state of
// everything" are different questions.
let boardMode = 'board';
try { boardMode = localStorage.getItem('track.mode') === 'list' ? 'list' : 'board'; } catch (e) {}
function setBoardMode(m) {
  boardMode = m === 'list' ? 'list' : 'board';
  try { localStorage.setItem('track.mode', boardMode); } catch (e) {}
  renderModeToggle();
  applyFilters();
}
window.setBoardMode = setBoardMode;
function renderModeToggle() {
  const el = document.getElementById('tkModeTog');
  if (!el) return;
  el.innerHTML = [['board', 'Board'], ['list', 'List']].map(([m, label]) =>
    `<button type="button" class="tk-sbtn${boardMode === m ? ' on' : ''}" aria-pressed="${boardMode === m}" onclick="setBoardMode('${m}')">${label}</button>`).join('');
}

// The list's own sort. Default puts what needs a person first, which is the
// same order the board's columns already imply.
let listSort = 'urgency';
function setListSort(k) { listSort = k; applyFilters(); }
window.setListSort = setListSort;

// ═══════ SNAPSHOT CALLBACKS ═══════
// The sync module calls these; each ends in a re-render. Same contract as the
// CRM's applyLeadsSnapshot / applyPipelineSnapshot.
window.applyListingsSnapshot = function (list) {
  listings = Array.isArray(list) ? list : [];
  seenListings = true;
  refreshAll();
};
window.applyTrackPipelineSnapshot = function (list) {
  stages = (Array.isArray(list) ? list : []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  refreshAll();
};
window.applyTrackLeadsSnapshot = function (list) {
  leads = Array.isArray(list) ? list : [];
  seenLeads = true;
  refreshAll();
};

function refreshAll() {
  try { reconcileSellers(); } catch (e) { console.error('seller sync:', e); }
  try { applyFilters(); } catch (e) { console.error(e); }
  try { renderFilterBar(); } catch (e) { console.error(e); }
  try { renderModeToggle(); } catch (e) { console.error(e); }
  try { updateSellerBadge(); } catch (e) { console.error(e); }
  try { openPendingListing(); } catch (e) { console.error(e); }
}

// ═══════ LIVE SELLER SYNC ═══════
// Both collections are watched, so any change on either side lands here within
// a second and is reconciled by the shared rules in seller-sync.js — a seller
// added in the CRM gets a card, a corrected phone number follows onto it, a
// property mapped here is linked back on the lead.
//
// Deliberately client-side: this app has no server process, and the two
// snapshot listeners are already open. The cost is that it only runs while
// someone has the board open, which is why scripts/sync-seller-listings.mjs
// exists to do the identical reconcile server-side, on demand or on a
// schedule. Both call planSync(), so they cannot disagree.
//
// autoCreate is off until the first snapshot of BOTH collections has arrived:
// reconciling against a half-loaded listings array would create duplicates for
// every seller whose card simply had not downloaded yet.
let seenListings = false, seenLeads = false;
let syncing = false;
function reconcileSellers() {
  if (!seenListings || !seenLeads || syncing) return;
  if (!stages.length || !window.trackFirebase) return;
  const plan = planSync(leads, listings, stages[0], Date.now(), currentUserEmail || 'sync');
  if (!plan.create.length && !plan.updateListings.length && !plan.updateLeads.length) return;

  syncing = true;   // a write triggers a snapshot, which re-enters here; one pass at a time
  const done = () => { syncing = false; };
  const jobs = [];

  for (const { lead, listing } of plan.create) {
    listings.push(listing);
    jobs.push(window.trackFirebase.saveListing(listing));
    addHistory(listing, 'created', `Created automatically from the CRM seller lead <b>${esc(lead.name || lead.id)}</b>`);
  }
  for (const { id, patch } of plan.updateListings) {
    const x = listings.find(l => l.id === id);
    if (!x) continue;
    Object.assign(x, patch, { updatedAt: Date.now() });
    jobs.push(window.trackFirebase.saveListing(x));
  }
  for (const { id, patch } of plan.updateLeads) {
    jobs.push(window.trackFirebase.patchLead(id, patch));
  }
  Promise.allSettled(jobs).then(results => {
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) console.error('seller sync: ' + failed.length + ' write(s) failed', failed[0].reason);
    else if (plan.create.length) toast(`${plan.create.length} seller${plan.create.length === 1 ? '' : 's'} added to the board`);
    done();
  });
}

// ═══════ HELPERS ═══════
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function stageById(id) { return stages.find(s => s.id === id) || null; }
function stageKindOfId(id) { return P.stageKindOf(stageById(id)); }
function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtDateTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function timeAgo(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.round(d / 60000) + 'm ago';
  if (d < DAY) return Math.round(d / 3600000) + 'h ago';
  const days = Math.round(d / DAY);
  return days === 1 ? 'yesterday' : days + 'd ago';
}
// "in 2 days" / "3 days late" — a shoot date only means something relative to
// today, and "late" is the word that gets a phone picked up.
function relDays(ts) {
  if (!ts) return '';
  const diff = ts - Date.now();
  const days = Math.round(Math.abs(diff) / DAY);
  const hrs = Math.round(Math.abs(diff) / 3600000);
  const phrase = hrs < 24 ? (hrs <= 1 ? 'an hour' : hrs + ' hours') : (days === 1 ? '1 day' : days + ' days');
  return diff < 0 ? phrase + ' late' : 'in ' + phrase;
}

// ═══════ SELLER LEADS ═══════
// The same two-signal rule the CRM uses (crm-assets/app.js isSellerLead): the
// enquiry type a person or TailorTalk set, OR the per-lead AI's read of the
// whole conversation. Either is enough — a seller missed here is revenue lost,
// so this errs toward including.
const isSellerLead = isSeller;   // the shared rule, so the board and the sync agree by construction
function sellerLeads() { return leads.filter(isSellerLead); }
// Sellers with no card on this board yet — the gap this page exists to close.
function unlistedSellers() {
  const linked = new Set(listings.map(x => x.leadId).filter(Boolean));
  return sellerLeads().filter(l => !linked.has(l.id) && l.listingSkipped !== true)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
// Sellers deliberately set aside — kept visible and reversible, never silently gone.
function skippedSellers() {
  const linked = new Set(listings.map(x => x.leadId).filter(Boolean));
  return sellerLeads().filter(l => !linked.has(l.id) && l.listingSkipped === true);
}
function leadById(id) { return leads.find(l => l.id === id) || null; }

// ═══════ FILTER + ROUTING ═══════
function applyFilters() {
  const q = currentSearch;
  filtered = listings.filter(x => {
    if (stageFilter.size && !stageFilter.has(x.stageId)) return false;
    if (!q) return true;
    const hay = [x.title, x.propertyCode, x.location, x.config, x.sellerName, x.sellerPhone,
      x.askingPrice, x.shootAssignee, x.remarks].join(' ').toLowerCase();
    return hay.includes(q);
  });
  if (currentView === 'board') { boardMode === 'list' ? renderList() : renderBoard(); }
  else if (currentView === 'shoots') renderShoots();
  else renderSellers();
}

function toggleView(view) {
  currentView = TRACK_VIEWS.includes(view) ? view : 'board';
  TRACK_VIEWS.forEach(v => {
    const el = document.getElementById(v + 'View');
    if (el) el.style.display = v === currentView ? '' : 'none';
  });
  const bar = document.querySelector('.tk-filterbar');
  if (bar) bar.style.display = currentView === 'board' ? '' : 'none';
  if (window.AppNav) window.AppNav.setActive(currentView);
  applyFilters();
}
window.toggleView = toggleView;

function onSearch(v) {
  currentSearch = String(v || '').toLowerCase();
  applyFilters();
}
window.onSearch = onSearch;

function toggleStageFilter(id) {
  if (stageFilter.has(id)) stageFilter.delete(id); else stageFilter.add(id);
  renderFilterBar();
  applyFilters();
}
window.toggleStageFilter = toggleStageFilter;

function clearStageFilter() { stageFilter = new Set(); renderFilterBar(); applyFilters(); }
window.clearStageFilter = clearStageFilter;

function renderFilterBar() {
  const el = document.getElementById('tkFilterBar');
  if (!el) return;
  const chips = stages.map(s => {
    const on = !stageFilter.size || stageFilter.has(s.id);
    const n = listings.filter(x => x.stageId === s.id).length;
    return `<button type="button" class="tk-chip${on ? ' on' : ''}" style="--sc:${s.color}" onclick="toggleStageFilter('${s.id}')">${esc(s.name)}<span class="tk-n">${n}</span></button>`;
  }).join('');
  const clear = stageFilter.size ? `<button type="button" class="tk-chip clear" onclick="clearStageFilter()">Show all</button>` : '';
  el.innerHTML = chips + clear;
}

function updateSellerBadge() {
  if (window.AppNav) window.AppNav.setBadge('sellers', unlistedSellers().length);
}

// ═══════ BOARD ═══════
function renderBoard() {
  const board = document.getElementById('boardView');
  if (!board) return;
  if (!stages.length) {
    board.innerHTML = `<div class="tk-empty"><div class="tk-empty-i">📋</div><div class="tk-empty-t">Setting up the board…</div></div>`;
    return;
  }
  const shown = stageFilter.size ? stages.filter(s => stageFilter.has(s.id)) : stages;
  board.innerHTML = `<div class="tk-board">${shown.map(stage => {
    const cards = filtered.filter(x => x.stageId === stage.id)
      .sort((a, b) => cardUrgency(b) - cardUrgency(a) || (b.updatedAt || 0) - (a.updatedAt || 0));
    const late = cards.filter(isLate).length;
    const kind = P.stageKindOf(stage);
    const rule = (P.stageDef(P.stageKeyOf(stage)) || {}).rule || '';
    return `<div class="tk-col${kind && kind !== 'open' ? ' tk-col-' + kind : ''}">
      <div class="tk-col-hdr">
        <div class="tk-col-head">
          <span class="tk-dot" style="background:${stage.color}"></span>
          <span class="tk-col-title">${esc(stage.name)}</span>
        </div>
        ${rule ? `<div class="tk-col-rule">${esc(rule)}</div>` : ''}
        <div class="tk-col-counts">
          ${late ? `<span class="tk-late" title="Sitting longer than this stage should take">${late} late</span>` : ''}
          <span class="tk-count">${cards.length}</span>
        </div>
      </div>
      <div class="tk-col-body" ondragover="onColDragOver(event)" ondragleave="onColDragLeave(event)" ondrop="onColDrop(event,'${stage.id}')">
        ${cards.map(cardHtml).join('') || '<div class="tk-col-none">Nothing here</div>'}
      </div>
    </div>`;
  }).join('')}</div>`;
}

// ═══════ LIST VIEW ═══════
// Everything at once, in one scan: stage, owner, mapping, shoot, media,
// what is blocking it. The board answers "where is this one"; this answers
// "what is the state of all of them", which is the question asked before a
// week is planned.
const LIST_SORTS = [
  ['urgency', 'Needs attention'],
  ['stage', 'Stage'],
  ['shoot', 'Shoot date'],
  ['age', 'Longest in column'],
  ['updated', 'Recently touched']
];
function sortForList(arr) {
  const idx = x => stages.findIndex(s => s.id === x.stageId);
  const copy = arr.slice();
  switch (listSort) {
    case 'stage': return copy.sort((a, b) => idx(a) - idx(b) || cardUrgency(b) - cardUrgency(a));
    case 'shoot': return copy.sort((a, b) => (a.shootAt || Infinity) - (b.shootAt || Infinity));
    case 'age': return copy.sort((a, b) => P.stageAge(b, stages, Date.now()).days - P.stageAge(a, stages, Date.now()).days);
    case 'updated': return copy.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    default: return copy.sort((a, b) => cardUrgency(b) - cardUrgency(a) || (a.shootAt || Infinity) - (b.shootAt || Infinity));
  }
}
function renderList() {
  const host = document.getElementById('boardView');
  if (!host) return;
  const rows = sortForList(filtered);
  if (!rows.length) {
    host.innerHTML = `<div class="tk-empty"><div class="tk-empty-i">📋</div><div class="tk-empty-t">Nothing matches</div></div>`;
    return;
  }
  host.innerHTML = `
    <div class="tk-listwrap">
      <div class="tk-listbar">
        <span class="tk-lab">Sort</span>
        <select class="tk-sel sm" onchange="setListSort(this.value)">
          ${LIST_SORTS.map(([k, l]) => `<option value="${k}"${listSort === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
        <span class="tk-listcount">${rows.length} listing${rows.length === 1 ? '' : 's'}</span>
      </div>
      <div class="tk-table" role="table">
        <div class="tk-tr tk-th" role="row">
          <span role="columnheader">Property</span>
          <span role="columnheader">Stage</span>
          <span role="columnheader">Owner</span>
          <span role="columnheader">Shoot</span>
          <span role="columnheader">Media</span>
          <span role="columnheader">Needs</span>
        </div>
        ${rows.map(listRowHtml).join('')}
      </div>
    </div>`;
}
function listRowHtml(x) {
  const st = stageById(x.stageId);
  const age = P.stageAge(x, stages, Date.now());
  const m = x.media || {};
  const done = MEDIA_KEYS.filter(([k]) => m[k]).length;
  const blocked = blockersFor(x);
  const late = x.shootAt && x.shootAt < Date.now();
  return `<div class="tk-tr${isLate(x) ? ' late' : ''}" role="row" tabindex="0"
      onclick="openDetail('${x.id}')" onkeydown="onCardKeydown(event,'${x.id}')">
    <span role="cell">
      <b>${esc(x.title || 'Untitled')}</b>
      <span class="tk-sub2">${[x.location, x.config, x.askingPrice].filter(Boolean).map(esc).join(' · ') || '—'}</span>
      ${x.propertyCode ? `<span class="tk-code">${esc(x.propertyCode)}</span>` : '<span class="tk-code none">unmapped</span>'}
    </span>
    <span role="cell">
      ${st ? `<span class="tk-pill" style="background:${st.color}22;color:${st.color}">${esc(st.name)}</span>` : '—'}
      <span class="tk-sub2${age.farOver ? ' bad' : age.over ? ' warn' : ''}">${age.days}d here</span>
    </span>
    <span role="cell">
      ${x.sellerName ? esc(x.sellerName) : '—'}
      ${x.sellerPhone ? `<a class="tk-sub2 link" href="tel:${esc(telOf(x.sellerPhone))}" onclick="event.stopPropagation()">${esc(x.sellerPhone)}</a>` : ''}
    </span>
    <span role="cell" class="${late ? 'bad' : ''}">
      ${x.shootAt ? `${esc(fmtDate(x.shootAt))}<span class="tk-sub2">${esc(relDays(x.shootAt))}</span>` : '<span class="tk-sub2">not booked</span>'}
    </span>
    <span role="cell">${done}/${MEDIA_KEYS.length}${x.ownerApproved ? '<span class="tk-sub2 ok">owner ✓</span>' : ''}</span>
    <span role="cell">${blocked.length ? blocked.map(b => `<span class="tk-blk">${esc(b)}</span>`).join('') : '<span class="tk-sub2">—</span>'}</span>
  </div>`;
}

// A listing is "late" when it has sat past its stage's own target — the
// signal that matters on this board, since every stage here is a promise to
// someone (an owner waiting for a photographer, a brochure not yet queued).
function isLate(x) { return P.stageAge(x, stages, Date.now()).over; }
function cardUrgency(x) {
  const a = P.stageAge(x, stages, Date.now());
  let score = a.farOver ? 3 : a.over ? 2 : 0;
  // A shoot booked for today or already missed outranks a merely stale card.
  if (x.shootAt && x.shootAt < Date.now() + DAY) score += 3;
  return score;
}

// ── What a card has to answer, in the order someone actually asks ──
//   1. Which property is this?          title, locality · config · price
//   2. Is it in the system?             the Property_ID chip, loud when not
//   3. Whose is it, and can I call now?  owner + a tap-to-dial number
//   4. What is the next physical thing?  the shoot, and whether it is late
//   5. How far is the media along?       the checklist, as progress not icons
//   6. Is this one stuck?                days in column, against its target
// Everything else belongs in the detail panel. A card that tries to show
// everything shows nothing.
function cardHtml(x) {
  const late = isLate(x);
  const age = P.stageAge(x, stages, Date.now());
  const blocked = blockersFor(x);
  return `<div class="tk-card${late ? ' late' : ''}" draggable="true" tabindex="0" role="link"
      aria-label="Open ${esc(x.title || x.propertyCode || 'listing')}"
      data-id="${x.id}"
      ondragstart="onCardDragStart(event,'${x.id}')" ondragend="onCardDragEnd(event)"
      onclick="openDetail('${x.id}')" onkeydown="onCardKeydown(event,'${x.id}')">
    <div class="tk-card-top">
      <span class="tk-card-title">${esc(x.title || x.propertyCode || 'Untitled listing')}</span>
      ${x.propertyCode ? `<span class="tk-code" title="Mapped to inventory ${esc(x.propertyCode)}">${esc(x.propertyCode)}</span>`
        : `<span class="tk-code none" title="Not in the inventory yet — it cannot reach the website until it is">unmapped</span>`}
    </div>
    ${(x.location || x.config || x.askingPrice) ? `<div class="tk-card-sub">${
      [x.location, x.config, x.askingPrice].filter(Boolean).map(esc).join(' · ')}</div>` : ''}

    ${x.sellerName || x.sellerPhone ? `<div class="tk-card-owner">
      <span class="tk-ava" aria-hidden="true">${esc(initials(x.sellerName))}</span>
      <span class="tk-own-nm">${esc(x.sellerName || 'Owner')}</span>
      ${x.sellerPhone ? `<a class="tk-call" href="tel:${esc(telOf(x.sellerPhone))}" onclick="event.stopPropagation()" title="Call ${esc(x.sellerName || 'the owner')}">Call</a>` : ''}
      ${x.leadId ? `<button type="button" class="tk-mini" onclick="event.stopPropagation();openSellerPreview('${x.id}')" title="See what they said">Chat</button>` : ''}
    </div>` : ''}

    ${shootLine(x)}
    ${mediaBar(x)}

    ${blocked.length ? `<div class="tk-blockers">${blocked.map(b => `<span class="tk-blk">${esc(b)}</span>`).join('')}</div>` : ''}

    <div class="tk-card-foot">
      <span class="tk-age${age.farOver ? ' bad' : age.over ? ' warn' : ''}"
        title="${age.target ? 'This column should take about ' + age.target + ' days' : ''}">${age.days === 0 ? 'today' : age.days + 'd here'}</span>
      ${x.ownerApproved ? '<span class="tk-ok" title="Owner approved the photos / brochure">owner ✓</span>' : ''}
      <span class="tk-upd">${esc(timeAgo(x.updatedAt))}</span>
    </div>
  </div>`;
}

const telOf = p => String(p || '').replace(/[^\d+]/g, '');
function initials(name) {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return ((w[0][0] || '') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
}

// The one physical commitment on a card, said the way it matters: not the
// date, but whether it has been missed.
function shootLine(x) {
  if (!x.shootAt) {
    const key = P.stageKeyOf(stageById(x.stageId));
    // Only nag about a missing shoot where one is actually the next step.
    if (!['new_listing', 'details', 'shoot_scheduled'].includes(key)) return '';
    return `<div class="tk-card-row muted">📸 No shoot booked</div>`;
  }
  const late = x.shootAt < Date.now();
  const soon = !late && x.shootAt < Date.now() + DAY;
  return `<div class="tk-card-row${late ? ' bad' : soon ? ' hot' : ''}">📸 ${esc(fmtDateTime(x.shootAt))}
    <span class="tk-rel">${esc(relDays(x.shootAt))}</span>
    ${x.shootAssignee ? `<span class="tk-who">· ${esc(x.shootAssignee)}</span>` : ''}
    ${!x.ownerInformed ? '<span class="tk-blk sm" title="The owner has not been told we are coming">owner not told</span>' : ''}
  </div>`;
}

// Media as progress rather than five ambiguous glyphs: how many of the things
// this listing needs are done.
function mediaBar(x) {
  const { done, total, req } = mediaProgress(x);
  if (!total) return '';
  const m = x.media || {};
  const pct = Math.round(100 * done / total);
  const missing = req.filter(([k]) => !m[k]).map(k => k[1]);
  return `<div class="tk-mbar" title="${esc(missing.length ? 'Still needed: ' + missing.join(', ') : 'Everything asked for is in')}">
    <span class="tk-mbar-t${done === total ? ' full' : ''}"><i style="width:${pct}%"></i></span>
    <span class="tk-mbar-n">${done}/${total} media</span>
  </div>`;
}

// What is standing between this listing and the next stage. Stated on the
// card because the whole point of a board is to see where the work is stuck
// without opening anything.
function blockersFor(x) {
  const key = P.stageKeyOf(stageById(x.stageId));
  const out = [];
  // Before the shoot: the things that make an agent's trip wasted.
  if (['shoot_scheduled'].includes(key)) {
    if (!x.address) out.push('no address');
    if (!x.sellerPhone && !x.siteContact) out.push('no site contact');
    if (!x.ownerInformed) out.push('owner not told');
  }
  // After it: what is still outstanding against the brief.
  if (key === 'shoot_done') {
    const { done, total } = mediaProgress(x);
    if (done < total) out.push(`${total - done} of ${total} media missing`);
    if (!x.photosLink) out.push('photos not uploaded');
  }
  if (['brochure_queued', 'brochure_ready', 'live'].includes(key) && !x.propertyCode) out.push('not in inventory');
  if (['brochure_ready', 'live'].includes(key) && !x.ownerApproved) out.push('owner has not approved');
  if (key === 'live' && !x.brochureLink) out.push('no brochure');
  return out;
}
window.blockersFor = blockersFor;   // read by tests/track-preview.mjs

// The media checklist. TWO states, not one: what this shoot is supposed to
// capture (`need` — the brief) and what came back (`media`). A shoot agent
// standing in the flat has to know whether a drone was asked for before they
// pack up, and "3 done" means nothing to a handler without "of 4 asked for".
const MEDIA_KEYS = [
  ['photos', 'Photos', '🖼'], ['video', 'Video', '🎬'], ['drone', 'Drone', '🚁'],
  ['floorPlan', 'Floor plan', '📐'], ['tour', 'Virtual tour', '🔄']
];
// What a listing is assumed to need when nobody has said otherwise — the two
// things every brochure in this pipeline actually uses.
const DEFAULT_NEED = { photos: true, floorPlan: true };
const needOf = x => (x.need && Object.keys(x.need).some(k => x.need[k])) ? x.need : DEFAULT_NEED;
function mediaProgress(x) {
  const need = needOf(x), done = x.media || {};
  const req = MEDIA_KEYS.filter(([k]) => need[k]);
  return { done: req.filter(([k]) => done[k]).length, total: req.length, req };
}

// Who can be sent on a shoot — the set actually in use, so a handler picks
// rather than retypes. A typo in a free-text name silently splits one
// person's day into two and neither looks wrong.
function shootAgents() {
  const set = new Set();
  for (const x of listings) if (x.shootAssignee) set.add(String(x.shootAssignee).trim());
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

// Where the property actually is, and how to get in. None of this existed —
// and without it a shoot agent cannot do the job, because "Nungambakkam" is
// a locality of fifty thousand people, not an address.
const OCCUPANCY = {
  vacant: 'Vacant — someone must open it',
  owner: 'Owner living there',
  tenant: 'Tenant living there',
  construction: 'Under construction'
};
// A map link is derived from the address when nobody pasted one, because the
// address is the thing people actually have to hand.
function mapHref(x) {
  if (x.mapLink) return x.mapLink;
  const q = [x.address, x.location].filter(Boolean).join(', ');
  return q ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) : '';
}
// ── Drag and drop, same handlers and class names as the CRM board ──
let draggedId = null;
function onCardDragStart(e, id) {
  draggedId = id;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', id); } catch (_) {}
  e.currentTarget.classList.add('dragging');
}
function onCardDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.tk-col-body.drag-over').forEach(el => el.classList.remove('drag-over'));
}
function onColDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('drag-over'); }
function onColDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
function onColDrop(e, stageId) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const id = draggedId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
  draggedId = null;
  if (id) changeStage(id, stageId);
}
function onCardKeydown(e, id) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(id); }
}
window.onCardDragStart = onCardDragStart; window.onCardDragEnd = onCardDragEnd;
window.onColDragOver = onColDragOver; window.onColDragLeave = onColDragLeave;
window.onColDrop = onColDrop; window.onCardKeydown = onCardKeydown;

// ═══════ MOVING A LISTING ═══════
function changeStage(id, stageId, opts) {
  opts = opts || {};
  const x = listings.find(l => l.id === id);
  const to = stageById(stageId);
  if (!x || !to || x.stageId === stageId) return;
  const kind = P.stageKindOf(to);
  // A dropped or paused listing without its reason is a record that explains
  // nothing later — the same rule the CRM board enforces for Lost/On hold.
  if ((kind === 'lost' || kind === 'hold') && !opts.reason) {
    openReasonModal(id, stageId);
    return;
  }
  const now = Date.now();
  const from = stageById(x.stageId);
  const key = P.stageKeyOf(to);

  addHistory(x, 'stage', `Moved from <b>${esc(from ? from.name : 'no column')}</b> to <b>${esc(to.name)}</b>${opts.reason ? ' — ' + esc(opts.reasonLabel || opts.reason) : ''}`);
  x.prevStageId = x.stageId || null;
  x.stageId = stageId;
  x.stageChangedAt = now;
  x.stageChangedBy = currentUserEmail || 'team';
  Object.assign(x, P.reachedUpdate(x, key, now) || {});
  if (kind === 'lost') x.dropReason = opts.reason || null;
  else x.dropReason = null;
  if (kind === 'hold') { x.holdReason = opts.reason || null; x.holdUntil = opts.until || null; }
  else { x.holdReason = null; x.holdUntil = null; }
  x.updatedAt = now;
  x.updatedBy = currentUserEmail || null;
  persist(x);
  applyFilters();
  if (currentDetailId === id) openDetail(id);
  toast(`Moved to ${to.name}`);
}
window.changeStage = changeStage;

// ═══════ REASON MODAL (Dropped / On hold) ═══════
let reasonFor = null;
function openReasonModal(id, stageId) {
  reasonFor = { id, stageId };
  const kind = stageKindOfId(stageId);
  const map = kind === 'lost' ? P.DROP_REASONS : P.HOLD_REASONS;
  document.getElementById('rsTitle').textContent = kind === 'lost' ? 'Why is this dropped?' : 'Why is this on hold?';
  document.getElementById('rsReason').innerHTML = Object.entries(map)
    .map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
  document.getElementById('rsUntilRow').style.display = kind === 'hold' ? '' : 'none';
  document.getElementById('rsUntil').value = '';
  document.getElementById('rsModal').classList.add('open');
}
function closeReasonModal() { document.getElementById('rsModal').classList.remove('open'); reasonFor = null; }
function saveReason() {
  if (!reasonFor) return;
  const key = document.getElementById('rsReason').value;
  const kind = stageKindOfId(reasonFor.stageId);
  const map = kind === 'lost' ? P.DROP_REASONS : P.HOLD_REASONS;
  const untilVal = document.getElementById('rsUntil').value;
  changeStage(reasonFor.id, reasonFor.stageId, {
    reason: key, reasonLabel: map[key],
    until: untilVal ? new Date(untilVal + 'T10:00').getTime() : null
  });
  closeReasonModal();
}
window.openReasonModal = openReasonModal; window.closeReasonModal = closeReasonModal; window.saveReason = saveReason;

// ═══════ PERSISTENCE ═══════
function persist(x) {
  if (!window.trackFirebase) return;
  window.trackFirebase.saveListing(x).catch(e => {
    console.error('Save failed:', e);
    toast('Could not save — check your connection');
  });
}
function addHistory(x, type, text) {
  const entry = { id: newId('h'), type, text, at: Date.now(), by: currentUserEmail || 'team' };
  if (window.trackFirebase) window.trackFirebase.saveHistory(x.id, entry).catch(e => console.error('History save failed:', e));
  x.lastEvent = { text, at: entry.at, by: entry.by };
}

// ═══════ SHOOTS VIEW ═══════
// Every booked shoot in date order — missed ones first, because a shoot that
// did not happen is the thing that stalls everything downstream.
// Whose day to show. A handler wants everyone; an agent wants only their own
// name, and that choice sticks on their device.
let agentFilter = '';
try { agentFilter = localStorage.getItem('track.agent') || ''; } catch (e) {}
function setAgentFilter(v) {
  agentFilter = v || '';
  try { localStorage.setItem('track.agent', agentFilter); } catch (e) {}
  renderShoots();
}
window.setAgentFilter = setAgentFilter;

function renderShoots() {
  const el = document.getElementById('shootsView');
  if (!el) return;
  const mine = x => !agentFilter || (x.shootAssignee || '').trim() === agentFilter;
  const open = listings.filter(x => stageKindOfId(x.stageId) === 'open' && mine(x));
  const withShoot = open.filter(x => x.shootAt).sort((a, b) => a.shootAt - b.shootAt);
  const now = Date.now();
  // "Missed" is judged on the brief, not on one field: a shoot whose required
  // media is all in is done, whatever else is outstanding.
  const unfinished = x => { const p = mediaProgress(x); return p.done < p.total; };
  const groups = [
    ['Missed', withShoot.filter(x => x.shootAt < now && unfinished(x))],
    ['Today', withShoot.filter(x => x.shootAt >= now && x.shootAt < endOfToday())],
    ['Coming up', withShoot.filter(x => x.shootAt >= endOfToday())]
  ];
  const noShoot = open.filter(x => !x.shootAt
    && ['new_listing', 'details', 'shoot_scheduled'].includes(P.stageKeyOf(stageById(x.stageId))));
  const agents = shootAgents();
  // What would waste a trip if nobody noticed before setting off.
  const notReady = withShoot.filter(x => x.shootAt > now && (!x.address || !(x.siteContact || x.sellerPhone) || !x.ownerInformed));

  el.innerHTML = `
    ${agents.length ? `<div class="tk-agentbar">
      <span class="tk-lab">Whose day</span>
      <button type="button" class="tk-sbtn${!agentFilter ? ' on' : ''}" onclick="setAgentFilter('')">Everyone</button>
      ${agents.map(a => `<button type="button" class="tk-sbtn${agentFilter === a ? ' on' : ''}" onclick="setAgentFilter('${esc(a).replace(/'/g, "\\'")}')">${esc(a)}</button>`).join('')}
    </div>` : ''}

    ${notReady.length ? `<div class="tk-note bad">
      <b>${notReady.length} upcoming shoot${notReady.length === 1 ? '' : 's'} ${notReady.length === 1 ? 'is' : 'are'} not ready to send.</b>
      Missing an address, a contact who can open the door, or the owner has not been told. Each one is a wasted trip.
    </div>` : ''}

    ${groups.map(([label, arr]) => arr.length ? `
      <div class="tk-group">
        <div class="tk-group-hdr${label === 'Missed' ? ' bad' : label === 'Today' ? ' warn' : ''}">${label} <span class="tk-count">${arr.length}</span></div>
        <div class="tk-rows">${arr.map(shootRow).join('')}</div>
      </div>` : '').join('')}
    ${noShoot.length ? `
      <div class="tk-group">
        <div class="tk-group-hdr">Waiting to be booked <span class="tk-count">${noShoot.length}</span></div>
        <div class="tk-rows">${noShoot.map(shootRow).join('')}</div>
      </div>` : ''}
    ${!withShoot.length && !noShoot.length ? `<div class="tk-empty"><div class="tk-empty-i">📸</div><div class="tk-empty-t">${agentFilter ? 'Nothing for ' + esc(agentFilter) : 'No shoots to plan'}</div><div class="tk-empty-s">Book one from any listing on the board.</div></div>` : ''}`;
}
function endOfToday() { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); }

// A run sheet row: everything needed to actually turn up, with the address
// and the two taps that matter (call whoever opens it, open the map) big
// enough to hit on a phone standing in the street.
function shootRow(x) {
  const stage = stageById(x.stageId);
  const late = x.shootAt && x.shootAt < Date.now();
  const contact = x.siteContact || x.sellerPhone;
  const { done, total, req } = mediaProgress(x);
  const m = x.media || {};
  const map = mapHref(x);
  const ready = x.address && contact && x.ownerInformed;
  return `<div class="tk-row shoot${late ? ' late' : ''}">
    <div class="tk-row-main" onclick="openDetail('${x.id}')">
      <div class="tk-row-top">
        <span class="tk-row-title">${esc(x.title || x.propertyCode || 'Untitled')}</span>
        ${stage ? `<span class="tk-pill" style="background:${stage.color}22;color:${stage.color}">${esc(stage.name)}</span>` : ''}
        ${x.occupancy ? `<span class="tk-pill muted">${esc((OCCUPANCY[x.occupancy] || x.occupancy).split(' —')[0])}</span>` : ''}
      </div>
      <div class="tk-addr">${x.address ? '📍 ' + esc(x.address)
        : `<span class="tk-miss">📍 No address</span> <button type="button" class="tk-link" onclick="event.stopPropagation();openAccessModal('${x.id}')">add it</button>`}</div>
      <div class="tk-row-meta">
        ${x.shootAssignee ? `<span>🎥 ${esc(x.shootAssignee)}</span>` : '<span class="tk-warn">🎥 nobody assigned</span>'}
        ${x.ownerInformed ? '<span class="tk-ok">owner told ✓</span>' : '<span class="tk-warn">owner not told</span>'}
        ${x.bestTime ? `<span>🕑 ${esc(x.bestTime)}</span>` : ''}
        ${x.rescheduled ? `<span class="tk-warn">moved ${x.rescheduled}×</span>` : ''}
      </div>
      <div class="tk-brieflist">${req.map(([k, label, icon]) =>
        `<span class="tk-bchip${m[k] ? ' got' : ''}">${icon} ${esc(label)}${m[k] ? ' ✓' : ''}</span>`).join('')
        || '<span class="tk-sub2">No brief set</span>'}</div>
      ${x.accessNotes ? `<div class="tk-row-note">🔑 ${esc(x.accessNotes)}</div>` : ''}
    </div>
    <div class="tk-row-side col">
      ${x.shootAt ? `<div class="tk-when${late ? ' bad' : ''}">${esc(fmtDateTime(x.shootAt))}</div><div class="tk-rel">${esc(relDays(x.shootAt))}</div>`
        : '<div class="tk-when none">not booked</div>'}
      <div class="tk-row-acts">
        ${contact ? `<a class="tk-btn sm primary" href="tel:${esc(telOf(contact))}">Call</a>` : ''}
        ${map ? `<a class="tk-btn sm" href="${esc(map)}" target="_blank" rel="noopener">Map</a>` : ''}
        ${x.shootAt && !x.shootDoneAt ? `<button class="tk-btn sm" onclick="event.stopPropagation();openWrapModal('${x.id}')">Done</button>` : ''}
      </div>
      ${total ? `<div class="tk-sub2">${done}/${total} captured</div>` : ''}
      ${!ready && x.shootAt ? '<div class="tk-sub2 warn">not ready to send</div>' : ''}
    </div>
  </div>`;
}

// ═══════ SELLERS VIEW ═══════
// The safety net: every seller in the CRM without a card here.
function renderSellers() {
  const el = document.getElementById('sellersView');
  if (!el) return;
  const missing = unlistedSellers();     // normally empty — the sync creates these
  const aside = skippedSellers();
  const tracked = listings.filter(x => x.leadId).length;
  const total = sellerLeads().length;
  el.innerHTML = `
    <div class="tk-note">
      <b>${tracked}</b> of <b>${total}</b> seller${total === 1 ? '' : 's'} in the CRM ${tracked === 1 ? 'is' : 'are'} on this board.
      New sellers are added here automatically, and their name and number follow any correction made in the CRM.
      A seller counts if the CRM marked them a Seller Listing <i>or</i> the AI read the conversation as selling or renting out.
    </div>
    ${missing.length ? `
      <div class="tk-group">
        <div class="tk-group-hdr warn">Waiting to be added <span class="tk-count">${missing.length}</span></div>
        <div class="tk-hint" style="margin:-4px 0 9px">These appear for a moment before the sync picks them up. If one stays here, something is blocking the write.</div>
        <div class="tk-rows">${missing.map(l => sellerRow(l, 'pending')).join('')}</div>
      </div>` : ''}
    ${!missing.length && !aside.length ? `<div class="tk-empty"><div class="tk-empty-i">✅</div><div class="tk-empty-t">Every seller is on the board</div><div class="tk-empty-s">Nothing has slipped through.</div></div>` : ''}
    ${aside.length ? `
      <div class="tk-group">
        <div class="tk-group-hdr">Set aside <span class="tk-count">${aside.length}</span></div>
        <div class="tk-hint" style="margin:-4px 0 9px">Deliberately not tracked — a deleted card or a skip. They are never re-added on their own.</div>
        <div class="tk-rows">${aside.map(l => sellerRow(l, 'aside')).join('')}</div>
      </div>` : ''}`;
}
function sellerRow(l, mode) {
  return `<div class="tk-row">
    <div class="tk-row-main">
      <div class="tk-row-top">
        <span class="tk-row-title">${esc(l.name || 'Unnamed lead')}</span>
        ${l.enquiryType ? `<span class="tk-pill muted">${esc(l.enquiryType)}</span>` : ''}
        ${l.ai && (l.ai.intent === 'sell' || l.ai.intent === 'rent_out') ? `<span class="tk-pill ai">AI: ${esc(l.ai.intent === 'sell' ? 'selling' : 'renting out')}</span>` : ''}
      </div>
      <div class="tk-row-meta">
        ${l.phone ? `<span>📞 ${esc(l.phone)}</span>` : ''}
        ${l.propertyInterest ? `<span>🏠 ${esc(l.propertyInterest)}</span>` : ''}
        ${l.budget ? `<span>💰 ${esc(l.budget)}</span>` : ''}
        <span>added ${esc(timeAgo(l.createdAt))}</span>
      </div>
      ${l.ai && l.ai.line ? `<div class="tk-row-note">${esc(l.ai.line)}</div>` : ''}
    </div>
    <div class="tk-row-side">
      ${mode === 'aside'
        ? `<button class="tk-btn" onclick="unskipSeller('${l.id}')">Track again</button>`
        : `<button class="tk-btn primary" onclick="createFromLead('${l.id}')">Create now</button>
           <button class="tk-btn ghost" onclick="skipSeller('${l.id}')" title="Do not track this one">Set aside</button>`}
      <a class="tk-btn ghost" href="crm.html?lead=${encodeURIComponent(l.id)}" onclick="event.stopPropagation()">Open lead</a>
    </div>
  </div>`;
}

// Creating a listing from a seller lead — the manual half of the mapping. The
// lead's own words become the starting point so nothing is retyped.
function createFromLead(leadId) {
  const l = leadById(leadId);
  if (!l) return;
  const first = stages[0];
  if (!first) { toast('The board is still loading'); return; }
  // The same builder the automatic sync uses, so a card made by hand and one
  // made for you are the same document.
  const x = newListingFor(l, first, Date.now(), currentUserEmail || 'team');
  listings.push(x);
  addHistory(x, 'created', `Listing created from the CRM lead <b>${esc(l.name || l.id)}</b>`);
  persist(x);
  // Creating by hand also clears a previous "set aside", and links the lead.
  if (window.trackFirebase) window.trackFirebase.patchLead(l.id, { listingId: x.id, listingSkipped: false }).catch(e => console.error(e));
  refreshAll();
  toast('Listing created');
  openDetail(x.id);
}
window.createFromLead = createFromLead;

// ═══════ DETAIL PANEL ═══════
function openDetail(id) {
  const x = listings.find(l => l.id === id);
  if (!x) return;
  currentDetailId = id;
  const stage = stageById(x.stageId);
  const lead = x.leadId ? leadById(x.leadId) : null;
  const m = x.media || {};
  document.getElementById('dpTitle').textContent = x.title || x.propertyCode || 'Untitled listing';
  document.getElementById('dpSub').innerHTML = [
    x.propertyCode ? `<span class="tk-code">${esc(x.propertyCode)}</span>` : '<span class="tk-code none">not mapped to inventory</span>',
    x.location ? esc(x.location) : '', x.config ? esc(x.config) : '', x.askingPrice ? esc(x.askingPrice) : ''
  ].filter(Boolean).join(' · ');

  document.getElementById('dpBody').innerHTML = `
    <div class="tk-sec">
      <label class="tk-lab">Stage</label>
      <select class="tk-sel" onchange="changeStage('${x.id}', this.value)">
        ${stages.map(s => `<option value="${s.id}"${s.id === x.stageId ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select>
      ${stage && P.stageDef(P.stageKeyOf(stage)) ? `<div class="tk-hint">${esc(P.stageDef(P.stageKeyOf(stage)).rule)}</div>` : ''}
      ${x.dropReason ? `<div class="tk-hint bad">Dropped — ${esc(P.DROP_REASONS[x.dropReason] || x.dropReason)}</div>` : ''}
      ${x.holdReason ? `<div class="tk-hint warn">On hold — ${esc(P.HOLD_REASONS[x.holdReason] || x.holdReason)}${x.holdUntil ? ', until ' + esc(fmtDate(x.holdUntil)) : ''}</div>` : ''}
    </div>

    <div class="tk-sec">
      <div class="tk-sec-hdr">Owner</div>
      <div class="tk-kv"><span>Name</span><b>${esc(x.sellerName || '—')}</b></div>
      <div class="tk-kv"><span>Phone</span>${x.sellerPhone ? `<a href="tel:${esc(telOf(x.sellerPhone))}">${esc(x.sellerPhone)}</a>` : '—'}</div>
      ${lead ? `<div class="tk-btnrow">
          <button class="tk-btn" onclick="openSellerPreview('${x.id}')">Preview their CRM record</button>
          <a class="tk-btn ghost" href="${esc(crmLeadHref(lead.id, x.id))}">Open in CRM →</a>
        </div>`
        : `<div class="tk-hint">Not linked to a CRM lead. <button class="tk-link" onclick="openLinkLead('${x.id}')">Link one</button></div>`}
    </div>

    ${lead ? `<div class="tk-sec" id="dpConvo">
      <div class="tk-sec-hdr">What the owner told us</div>
      <div class="tk-hint">Reading the conversation…</div>
    </div>` : ''}

    <div class="tk-sec">
      <div class="tk-sec-hdr">Inventory</div>
      <div class="tk-kv"><span>Property ID</span>${x.propertyCode ? `<b>${esc(x.propertyCode)}</b>` : '<i>not mapped</i>'}</div>
      <button class="tk-btn" onclick="openMapProperty('${x.id}')">${x.propertyCode ? 'Change mapping' : 'Map to a property'}</button>
      ${x.propertyCode ? `<a class="tk-btn ghost" href="property.html?id=${encodeURIComponent(x.propertyCode)}" target="_blank" rel="noopener">Open property →</a>` : ''}
    </div>

    <div class="tk-sec">
      <div class="tk-sec-hdr">Getting there</div>
      <div class="tk-kv col"><span>Address</span><div>${x.address ? esc(x.address) : '<i class="tk-miss">No address — a shoot cannot be sent without one</i>'}</div></div>
      <div class="tk-kv"><span>Who opens it</span>${esc(x.siteContact || x.sellerPhone || '—')}${
        (x.siteContact || x.sellerPhone) ? ` <a class="tk-btn sm" href="tel:${esc(telOf(x.siteContact || x.sellerPhone))}">Call</a>` : ''}</div>
      <div class="tk-kv"><span>Occupancy</span>${x.occupancy ? esc(OCCUPANCY[x.occupancy] || x.occupancy) : '—'}</div>
      ${x.bestTime ? `<div class="tk-kv"><span>Best time</span>${esc(x.bestTime)}</div>` : ''}
      ${x.accessNotes ? `<div class="tk-kv col"><span>Access notes</span><div>${esc(x.accessNotes)}</div></div>` : ''}
      <div class="tk-btnrow">
        ${mapHref(x) ? `<a class="tk-btn primary" href="${esc(mapHref(x))}" target="_blank" rel="noopener">Open in Maps →</a>` : ''}
        <button class="tk-btn" onclick="openAccessModal('${x.id}')">${x.address ? 'Edit access details' : 'Add the address'}</button>
      </div>
    </div>

    <div class="tk-sec">
      <div class="tk-sec-hdr">Shoot</div>
      <div class="tk-kv"><span>When</span><b>${x.shootAt ? esc(fmtDateTime(x.shootAt)) + ` <span class="tk-rel">${esc(relDays(x.shootAt))}</span>` : '—'}</b></div>
      <div class="tk-kv"><span>Assigned to</span>${esc(x.shootAssignee || '—')}</div>
      ${x.rescheduled ? `<div class="tk-kv"><span>Rescheduled</span>${x.rescheduled} time${x.rescheduled === 1 ? '' : 's'}${x.rescheduleReason ? ' — ' + esc(x.rescheduleReason) : ''}</div>` : ''}
      <label class="tk-check"><input type="checkbox" ${x.ownerInformed ? 'checked' : ''} onchange="setFlag('${x.id}','ownerInformed',this.checked)"> Owner told we are coming</label>
      <label class="tk-check"><input type="checkbox" ${x.ownerApproved ? 'checked' : ''} onchange="setFlag('${x.id}','ownerApproved',this.checked)"> Owner approved the photos / brochure</label>
      <div class="tk-btnrow">
        <button class="tk-btn" onclick="openShootModal('${x.id}')">${x.shootAt ? 'Reschedule' : 'Book the shoot'}</button>
        ${x.shootAt && !x.shootDoneAt ? `<button class="tk-btn primary" onclick="openWrapModal('${x.id}')">Shoot done →</button>` : ''}
      </div>
      ${x.shootNotes ? `<div class="tk-kv col"><span>From the shoot</span><div>${esc(x.shootNotes)}</div></div>` : ''}
    </div>

    <div class="tk-sec">
      <div class="tk-sec-hdr">The brief — what to capture</div>
      <div class="tk-hint" style="margin:-3px 0 9px">Tick what this property needs on the left, and what has come back on the right. The agent sees the left column before they go.</div>
      <div class="tk-brief">
        <div class="tk-brief-hd"><span></span><span>Needed</span><span>Done</span></div>
        ${MEDIA_KEYS.map(([k, label, icon]) => {
          const need = needOf(x)[k];
          return `<div class="tk-brief-r${need && !m[k] ? ' open' : ''}">
            <span>${icon} ${esc(label)}</span>
            <span><input type="checkbox" ${need ? 'checked' : ''} onchange="setNeed('${x.id}','${k}',this.checked)" aria-label="${esc(label)} needed"></span>
            <span><input type="checkbox" ${m[k] ? 'checked' : ''} ${!need ? 'class="dim"' : ''} onchange="setMedia('${x.id}','${k}',this.checked)" aria-label="${esc(label)} done"></span>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="tk-sec">
      <div class="tk-sec-hdr">Deliverables</div>
      ${linkRow('Drive photos', x.photosLink, x.id, 'photosLink')}
      ${linkRow('Brochure PDF', x.brochureLink, x.id, 'brochureLink')}
      <div class="tk-hint">The brochure pipeline fills both in when it finishes this property. Paste the Drive folder yourself as soon as the photos are up — nothing downstream can start until it is there.</div>
    </div>

    <div class="tk-sec">
      <div class="tk-sec-hdr">Remarks</div>
      <textarea class="tk-area" rows="3" placeholder="Anything the next person needs to know…" onchange="setRemarks('${x.id}', this.value)">${esc(x.remarks || '')}</textarea>
    </div>

    <div class="tk-sec">
      <div class="tk-sec-hdr">Timeline</div>
      <div id="dpHistory" class="tk-hist"><div class="tk-hint">Loading…</div></div>
    </div>

    <div class="tk-sec tk-danger">
      <button class="tk-btn" onclick="openEditModal('${x.id}')">Edit details</button>
      <button class="tk-btn danger" onclick="deleteListing('${x.id}')">Delete listing</button>
    </div>`;

  document.getElementById('dp').classList.add('open');
  loadHistory(x.id);
  if (lead) loadConversation(x.id, lead.id);
  // A card opened from anywhere is addressable — copy the URL and it reopens.
  try {
    const u = new URL(location.href);
    u.searchParams.set('listing', x.id);
    history.replaceState(null, '', u.pathname + u.search);
  } catch (e) {}
}
window.openDetail = openDetail;

// ═══════ WHAT THE OWNER TOLD US ═══════
// TailorTalk's AI writes a profile of every conversation. For a seller that
// profile IS the property brief — what they have, where, what they want for
// it, what has already been discussed — and it was the one thing this board
// could not show. Same field list and labels the CRM uses, so the two read
// identically.
const CONVO_FIELDS = [
  ['requirement_details', 'What they have'],
  ['preferred_location', 'Location'],
  ['budget_and_finance', 'Price expectation'],
  ['properties_discussed', 'Properties discussed'],
  ['objections_and_blockers', 'Objections & blockers'],
  ['activity_so_far', 'Activity so far'],
  ['stage_and_next_action', 'Stage & next action'],
  ['chat_summary', 'Conversation summary'],
  ['remarks', 'Remarks']
];
const convoCache = new Map();
function loadConversation(listingId, leadId) {
  const paint = state => {
    if (currentDetailId !== listingId) return;
    const el = document.getElementById('dpConvo');
    if (!el) return;
    el.innerHTML = `<div class="tk-sec-hdr">What the owner told us</div>${convoHtml(leadId, state)}`;
  };
  if (convoCache.has(leadId)) return paint(convoCache.get(leadId));
  if (!window.trackFirebase || !window.trackFirebase.getLeadConversation) return paint(null);
  window.trackFirebase.getLeadConversation(leadId)
    .then(state => { convoCache.set(leadId, state); paint(state); })
    .catch(e => { console.error('conversation load failed:', e); convoCache.set(leadId, null); paint(null); });
}
function convoHtml(leadId, state) {
  const lead = leadById(leadId);
  const bits = [];
  // The AI's one-line read of where this lead stands comes first — it is the
  // fastest thing to act on.
  if (lead && lead.ai && lead.ai.line) bits.push(`<div class="tk-ailine">🤖 ${esc(lead.ai.line)}</div>`);
  const profile = (state && state.profile) || null;
  if (profile) {
    const cards = CONVO_FIELDS.filter(([k]) => profile[k])
      .map(([k, label]) => `<div class="tk-kv col"><span>${esc(label)}</span><div>${esc(profile[k])}</div></div>`);
    if (cards.length) bits.push(`<div class="tk-convo">${cards.join('')}</div>`);
  }
  // The last few messages, so a number can be called with the thread in mind.
  const chat = (state && Array.isArray(state.chat)) ? state.chat.slice(-6) : [];
  if (chat.length) {
    bits.push(`<div class="tk-chat">${chat.map(m => `
      <div class="tk-msg ${m.role === 'user' ? 'them' : 'us'}">
        <span class="tk-msg-w">${m.role === 'user' ? esc((lead && lead.name) || 'Owner') : (m.role === 'human_agent' ? '3 PIN team' : '3 PIN AI')}</span>
        <span class="tk-msg-t">${esc(String(m.content || '').slice(0, 300))}</span>
      </div>`).join('')}</div>`);
  }
  if (lead && lead.lastNote && lead.lastNote.text) {
    bits.push(`<div class="tk-kv col"><span>Latest team note</span><div>${esc(lead.lastNote.text)}</div></div>`);
  }
  if (!bits.length) return `<div class="tk-hint">Nothing recorded from a conversation yet — this owner was probably added by hand. Their CRM record is the place to add what they told you.</div>
    <div class="tk-btnrow"><a class="tk-btn ghost" href="${esc(crmLeadHref(leadId, currentDetailId))}">Open in CRM →</a></div>`;
  return bits.join('');
}

// ═══════ SELLER PREVIEW ═══════
// Their CRM record without leaving the board: who they are, what the AI made
// of them, what they said, and one click to the real thing. Closing it puts
// you back exactly where you were, which is the whole point — checking a
// detail should not cost your place.
function openSellerPreview(listingId) {
  const x = listings.find(l => l.id === listingId);
  if (!x || !x.leadId) return;
  const lead = leadById(x.leadId);
  const el = document.getElementById('sellerPrev');
  if (!el || !lead) return;
  const stageName = lead.stageId || '—';
  el.querySelector('.tk-prev-body').innerHTML = `
    <div class="tk-prev-head">
      <span class="tk-ava lg">${esc(initials(lead.name))}</span>
      <div>
        <div class="tk-prev-nm">${esc(lead.name || 'Unnamed lead')}</div>
        <div class="tk-prev-sub">${[lead.enquiryType, lead.channel && channelName(lead.channel)].filter(Boolean).map(esc).join(' · ')}</div>
      </div>
    </div>
    <div class="tk-prev-actions">
      ${lead.phone ? `<a class="tk-btn primary" href="tel:${esc(telOf(lead.phone))}">Call ${esc(lead.phone)}</a>` : ''}
      ${lead.phone ? `<a class="tk-btn" href="https://wa.me/${esc(telOf(lead.phone).replace(/^\+/, ''))}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
    </div>
    <div class="tk-kv"><span>Property / locality</span><b>${esc(lead.propertyInterest || '—')}</b></div>
    <div class="tk-kv"><span>Budget</span>${esc(lead.budget || '—')}</div>
    <div class="tk-kv"><span>Added</span>${esc(timeAgo(lead.createdAt))}</div>
    ${lead.followUpAt ? `<div class="tk-kv"><span>Next follow-up</span>${esc(fmtDateTime(lead.followUpAt))}</div>` : ''}
    <div id="prevConvo" class="tk-prev-convo"><div class="tk-hint">Reading the conversation…</div></div>
    <div class="tk-btnrow">
      <a class="tk-btn primary" href="${esc(crmLeadHref(lead.id, listingId))}">Open fully in CRM →</a>
      <button class="tk-btn ghost" onclick="closeSellerPreview()">Close preview</button>
    </div>`;
  el.classList.add('open');
  // Same cache the detail panel fills, so opening both costs one read.
  const paint = state => {
    const host = document.getElementById('prevConvo');
    if (host) host.innerHTML = convoHtml(lead.id, state);
  };
  if (convoCache.has(lead.id)) paint(convoCache.get(lead.id));
  else if (window.trackFirebase && window.trackFirebase.getLeadConversation) {
    window.trackFirebase.getLeadConversation(lead.id)
      .then(s => { convoCache.set(lead.id, s); paint(s); })
      .catch(() => paint(null));
  } else paint(null);
}
function closeSellerPreview() { document.getElementById('sellerPrev')?.classList.remove('open'); }
window.openSellerPreview = openSellerPreview; window.closeSellerPreview = closeSellerPreview;

const CHANNELS = { whatsapp: 'WhatsApp', instagram: 'Instagram', website: 'Website', meta: 'Meta' };
const channelName = c => CHANNELS[c] || c;

// A CRM link that opens THIS lead, and knows to offer a way back here.
// crm.html reads ?lead= and ?from=track (see crm-assets/app.js).
function crmLeadHref(leadId, listingId) {
  let u = 'crm.html?lead=' + encodeURIComponent(leadId) + '&from=track';
  if (listingId) u += '&listing=' + encodeURIComponent(listingId);
  return u;
}

// A deliverable is a link someone has to be able to PUT there, not just read.
// It was read-only, which meant "photos not uploaded" could never be cleared
// and a card stayed blocked for ever however much work had actually been done.
function linkRow(label, url, id, field) {
  return `<div class="tk-kv"><span>${esc(label)}</span>
    <span class="tk-linkcell">
      ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">open →</a>` : '<i>not yet</i>'}
      <button type="button" class="tk-link" onclick="editLink('${id}','${field}')">${url ? 'change' : 'add'}</button>
    </span></div>`;
}
function editLink(id, field) {
  const x = listings.find(l => l.id === id);
  if (!x) return;
  const label = field === 'photosLink' ? 'Drive photo folder' : 'Brochure PDF';
  const next = prompt(`${label} link`, x[field] || '');
  if (next === null) return;                       // cancelled
  const v = next.trim();
  if (v && !/^https?:\/\//i.test(v)) { toast('That does not look like a link'); return; }
  mutate(id, o => { o[field] = v; }, v ? `${label} set` : `${label} cleared`);
  if (currentDetailId === id) openDetail(id);
}
window.editLink = editLink;
function closeDetail() {
  document.getElementById('dp').classList.remove('open');
  closeSellerPreview();
  currentDetailId = null;
  try {
    const u = new URL(location.href);
    u.searchParams.delete('listing');
    history.replaceState(null, '', u.pathname + u.search);
  } catch (e) {}
}
window.closeDetail = closeDetail;

// Arriving from a CRM lead (or a copied link): open that card straight away.
// The listings snapshot may not have landed yet, so this is retried until it
// has, then gives up rather than looping forever.
let pendingListing = null;
try { pendingListing = new URLSearchParams(location.search).get('listing'); } catch (e) {}
let pendingTries = 0;
function openPendingListing() {
  if (!pendingListing) return;
  if (listings.some(l => l.id === pendingListing)) {
    const id = pendingListing; pendingListing = null;
    openDetail(id);
  } else if (++pendingTries > 40) {
    pendingListing = null;
    toast('That listing no longer exists');
  }
}

function loadHistory(id) {
  if (!window.trackFirebase) return;
  window.trackFirebase.getListingHistory(id).then(list => {
    if (currentDetailId !== id) return;
    const el = document.getElementById('dpHistory');
    if (!el) return;
    el.innerHTML = list.length
      ? list.map(h => `<div class="tk-hist-i"><div class="tk-hist-t">${h.text}</div><div class="tk-hist-m">${esc(timeAgo(h.at))} · ${esc(String(h.by || '').split('@')[0])}</div></div>`).join('')
      : '<div class="tk-hint">Nothing yet.</div>';
  }).catch(e => console.error('History load failed:', e));
}

// ── Small field writes from the detail panel ──
function mutate(id, fn, historyText) {
  const x = listings.find(l => l.id === id);
  if (!x) return null;
  fn(x);
  x.updatedAt = Date.now();
  x.updatedBy = currentUserEmail || null;
  if (historyText) addHistory(x, 'field', historyText);
  persist(x);
  applyFilters();
  return x;
}
function setFlag(id, key, on) {
  mutate(id, x => { x[key] = !!on; },
    (key === 'ownerInformed' ? 'Owner informed about the shoot' : 'Owner approval') + ': ' + (on ? 'yes' : 'no'));
}
function setMedia(id, key, on) {
  const label = (MEDIA_KEYS.find(k => k[0] === key) || [, key])[1];
  mutate(id, x => { x.media = { ...(x.media || {}), [key]: !!on }; }, `${label}: ${on ? 'done' : 'not done'}`);
}
function setRemarks(id, v) { mutate(id, x => { x.remarks = String(v || '').trim(); }); }
// The brief: what this property needs shot. Changed by the handler, read by
// the agent before they travel.
function setNeed(id, key, on) {
  const label = (MEDIA_KEYS.find(k => k[0] === key) || [, key])[1];
  mutate(id, x => { x.need = { ...needOf(x), [key]: !!on }; }, `${label} ${on ? 'added to' : 'removed from'} the brief`);
  if (currentDetailId === id) openDetail(id);
}
window.setFlag = setFlag; window.setMedia = setMedia; window.setRemarks = setRemarks; window.setNeed = setNeed;

// ═══════ ACCESS DETAILS ═══════
// The block that decides whether a shoot happens at all. Kept as its own
// dialog rather than buried in the edit form, because it is filled in by
// whoever spoke to the owner, usually days before anyone is sent.
let accessFor = null;
function openAccessModal(id) {
  const x = listings.find(l => l.id === id);
  if (!x) return;
  accessFor = id;
  document.getElementById('acAddress').value = x.address || '';
  document.getElementById('acMap').value = x.mapLink || '';
  document.getElementById('acContact').value = x.siteContact || '';
  document.getElementById('acOccupancy').value = x.occupancy || '';
  document.getElementById('acBest').value = x.bestTime || '';
  document.getElementById('acNotes').value = x.accessNotes || '';
  document.getElementById('acModal').classList.add('open');
}
function closeAccessModal() { document.getElementById('acModal').classList.remove('open'); accessFor = null; }
function saveAccess() {
  if (!accessFor) return;
  const id = accessFor;
  const get = i => document.getElementById(i).value.trim();
  mutate(id, x => {
    x.address = get('acAddress'); x.mapLink = get('acMap'); x.siteContact = get('acContact');
    x.occupancy = get('acOccupancy'); x.bestTime = get('acBest'); x.accessNotes = get('acNotes');
  }, 'Access details updated');
  closeAccessModal();
  if (currentDetailId === id) openDetail(id);
}
window.openAccessModal = openAccessModal; window.closeAccessModal = closeAccessModal; window.saveAccess = saveAccess;

// ═══════ WRAPPING UP A SHOOT ═══════
// What the agent does standing in the doorway on the way out: tick what they
// actually got, say what they could not, and move the card on in one gesture.
// Anything missed against the brief stays visible on the board rather than
// being discovered a week later when the brochure is built.
let wrapFor = null;
function openWrapModal(id) {
  const x = listings.find(l => l.id === id);
  if (!x) return;
  wrapFor = id;
  const m = x.media || {}, need = needOf(x);
  document.getElementById('wrapList').innerHTML = MEDIA_KEYS.map(([k, label, icon]) =>
    `<label class="tk-check${need[k] ? ' req' : ''}"><input type="checkbox" id="wrap_${k}" ${m[k] ? 'checked' : ''}> ${icon} ${esc(label)}${need[k] ? ' <span class="tk-req">asked for</span>' : ''}</label>`).join('');
  document.getElementById('wrapNotes').value = x.shootNotes || '';
  // The moment the agent has the Drive folder open on their phone is the only
  // moment they will ever paste this. Asking later means never.
  document.getElementById('wrapPhotos').value = x.photosLink || '';
  document.getElementById('wrapModal').classList.add('open');
}
function closeWrapModal() { document.getElementById('wrapModal').classList.remove('open'); wrapFor = null; }
function saveWrap() {
  if (!wrapFor) return;
  const id = wrapFor;
  const media = {};
  for (const [k] of MEDIA_KEYS) media[k] = !!document.getElementById('wrap_' + k)?.checked;
  const notes = document.getElementById('wrapNotes').value.trim();
  const photos = document.getElementById('wrapPhotos').value.trim();
  if (photos && !/^https?:\/\//i.test(photos)) { toast('That photo link does not look like a link'); return; }
  mutate(id, x => {
    x.media = media; x.shootNotes = notes; x.shootDoneAt = Date.now();
    if (photos) x.photosLink = photos;
  }, 'Shoot wrapped up' + (photos ? ' · photos uploaded' : ''));
  const x = listings.find(l => l.id === id);
  const shot = P.stageForKey(stages, 'shoot_done');
  if (x && shot && P.ladderIndex(P.stageKeyOf(stageById(x.stageId))) < P.ladderIndex('shoot_done')) changeStage(id, shot.id);
  closeWrapModal();
  if (currentDetailId === id) openDetail(id);
  const { done, total } = mediaProgress(listings.find(l => l.id === id) || {});
  toast(done < total ? `Saved — ${total - done} of ${total} still to get` : 'Shoot complete');
}
window.openWrapModal = openWrapModal; window.closeWrapModal = closeWrapModal; window.saveWrap = saveWrap;

function deleteListing(id) {
  const x = listings.find(l => l.id === id);
  if (!x) return;
  if (!confirm(`Delete "${x.title || x.propertyCode || 'this listing'}"? The CRM lead is not touched, and the seller will not be re-added automatically.`)) return;
  listings = listings.filter(l => l.id !== id);
  if (window.trackFirebase) {
    window.trackFirebase.deleteListing(id).catch(e => console.error(e));
    // Without this tombstone the live sync would create the card again on the
    // very next snapshot — the most infuriating bug this design could have.
    if (x.leadId) window.trackFirebase.patchLead(x.leadId, { listingSkipped: true, listingId: null }).catch(e => console.error(e));
  }
  closeDetail();
  refreshAll();
  toast('Listing deleted');
}
window.deleteListing = deleteListing;

// Set a seller aside without making a card — reversible, and they stay
// visible under "Set aside" rather than vanishing.
function skipSeller(leadId) {
  if (!window.trackFirebase) return;
  const l = leadById(leadId);
  window.trackFirebase.patchLead(leadId, { listingSkipped: true })
    .then(() => toast(`${(l && l.name) || 'Seller'} set aside`))
    .catch(e => { console.error(e); toast('Could not save'); });
}
function unskipSeller(leadId) {
  if (!window.trackFirebase) return;
  window.trackFirebase.patchLead(leadId, { listingSkipped: false })
    .then(() => toast('Back on the list'))
    .catch(e => { console.error(e); toast('Could not save'); });
}
window.skipSeller = skipSeller; window.unskipSeller = unskipSeller;

// ═══════ SHOOT MODAL ═══════
let shootFor = null;
function openShootModal(id) {
  const x = listings.find(l => l.id === id);
  if (!x) return;
  shootFor = id;
  const d = x.shootAt ? new Date(x.shootAt) : null;
  document.getElementById('shDate').value = d ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '';
  document.getElementById('shTime').value = d ? String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : '10:00';
  document.getElementById('shWho').value = x.shootAssignee || '';
  document.getElementById('shContact').value = x.siteContact || x.sellerPhone || '';
  // Pick from who is already being sent out, rather than retyping a name.
  document.getElementById('shAgents').innerHTML = shootAgents().map(a => `<option value="${esc(a)}">`).join('');
  // Moving an existing booking asks why: a shoot rescheduled three times is a
  // problem with the owner, and only the reasons show that.
  document.getElementById('shWhyRow').style.display = x.shootAt ? '' : 'none';
  document.getElementById('shWhy').value = '';
  document.getElementById('shClash').textContent = '';
  document.getElementById('shModal').classList.add('open');
  checkClash();
}

// Two shoots, one agent, overlapping times. Warned about rather than blocked
// — a handler sometimes genuinely double-books two flats in one building.
function checkClash() {
  const el = document.getElementById('shClash');
  if (!el || !shootFor) return;
  const date = document.getElementById('shDate').value;
  const time = document.getElementById('shTime').value || '10:00';
  const who = document.getElementById('shWho').value.trim().toLowerCase();
  if (!date || !who) { el.textContent = ''; return; }
  const at = new Date(date + 'T' + time).getTime();
  const clash = listings.filter(l => l.id !== shootFor && l.shootAt && l.shootAssignee
    && l.shootAssignee.trim().toLowerCase() === who
    && Math.abs(l.shootAt - at) < 2 * 3600000);
  el.textContent = clash.length
    ? `Heads up: ${document.getElementById('shWho').value.trim()} is also at "${clash[0].title || 'another listing'}" around then.`
    : '';
}
window.checkClash = checkClash;
function closeShootModal() { document.getElementById('shModal').classList.remove('open'); shootFor = null; }
function saveShoot() {
  if (!shootFor) return;
  const date = document.getElementById('shDate').value;
  const time = document.getElementById('shTime').value || '10:00';
  const who = document.getElementById('shWho').value.trim();
  const contact = document.getElementById('shContact').value.trim();
  const at = date ? new Date(date + 'T' + time).getTime() : null;
  const why = document.getElementById('shWhy').value.trim();
  const id = shootFor;
  const prev = listings.find(l => l.id === id);
  const moving = !!(prev && prev.shootAt && at && prev.shootAt !== at);
  mutate(id, x => {
    x.shootAt = at; x.shootAssignee = who; x.siteContact = contact;
    if (moving) { x.rescheduled = (x.rescheduled || 0) + 1; x.rescheduleReason = why || null; }
  }, at
    ? (moving
        ? `Shoot moved to <b>${esc(fmtDateTime(at))}</b>${who ? ' with ' + esc(who) : ''}${why ? ' — ' + esc(why) : ''}`
        : `Shoot booked for <b>${esc(fmtDateTime(at))}</b>${who ? ' with ' + esc(who) : ''}`)
    : 'Shoot date cleared');
  // Booking a shoot IS the move into "Shoot scheduled" — making someone drag
  // the card as well would just be a second chance to forget.
  const x = listings.find(l => l.id === id);
  const sched = P.stageForKey(stages, 'shoot_scheduled');
  if (at && x && sched && P.ladderIndex(P.stageKeyOf(stageById(x.stageId))) < P.ladderIndex('shoot_scheduled')) {
    changeStage(id, sched.id);
  }
  closeShootModal();
  if (currentDetailId === id) openDetail(id);
}
window.openShootModal = openShootModal; window.closeShootModal = closeShootModal; window.saveShoot = saveShoot;

// ═══════ PROPERTY MAPPING ═══════
function loadInventory() {
  if (inventory) return Promise.resolve(inventory);
  if (!window.trackFirebase) return Promise.resolve([]);
  return window.trackFirebase.getInventory().then(list => { inventory = list; return list; });
}
let mapFor = null;
function openMapProperty(id) {
  mapFor = id;
  document.getElementById('mapSearch').value = '';
  document.getElementById('mapList').innerHTML = '<div class="tk-hint">Loading the inventory…</div>';
  document.getElementById('mapModal').classList.add('open');
  loadInventory().then(() => renderMapList('')).catch(e => {
    document.getElementById('mapList').innerHTML = '<div class="tk-hint bad">Could not read the inventory.</div>';
    console.error(e);
  });
}
function renderMapList(q) {
  const el = document.getElementById('mapList');
  if (!el) return;
  const needle = String(q || '').toLowerCase();
  const list = (inventory || []).filter(p => !needle
    || [p.propertyCode, p.name, p.location, p.config].join(' ').toLowerCase().includes(needle)).slice(0, 60);
  const x = listings.find(l => l.id === mapFor);
  el.innerHTML = (x && x.propertyCode ? `<button type="button" class="tk-pick clear" onclick="pickProperty('')">✕ Unmap from ${esc(x.propertyCode)}</button>` : '')
    + (list.length ? list.map(p => `<button type="button" class="tk-pick" onclick="pickProperty('${esc(p.propertyCode)}')">
        <span class="tk-code">${esc(p.propertyCode)}</span>
        <span class="tk-pick-main"><b>${esc(p.name || '—')}</b><span>${esc([p.location, p.config, p.startingPrice].filter(Boolean).join(' · '))}</span></span>
        ${p.soldOut ? '<span class="tk-pill muted">sold</span>' : ''}
      </button>`).join('') : '<div class="tk-hint">Nothing matches.</div>');
}
window.onMapSearch = v => renderMapList(v);
function pickProperty(code) {
  if (!mapFor) return;
  const p = (inventory || []).find(i => i.propertyCode === code);
  mutate(mapFor, x => {
    x.propertyCode = code || '';
    // Mapping pulls the inventory's own facts across so the card stops being a
    // second, divergent copy of them. The inventory stays the source of truth:
    // this only fills what the card has not had filled in by hand.
    if (p) {
      if (!x.title || x.title === 'New listing') x.title = p.name || x.title;
      if (!x.location) x.location = p.location || '';
      if (!x.config) x.config = p.config || '';
      if (!x.askingPrice) x.askingPrice = p.startingPrice || '';
      if (p.photosLink) x.photosLink = p.photosLink;
      if (p.brochureLink) x.brochureLink = p.brochureLink;
    }
  }, code ? `Mapped to inventory property <b>${esc(code)}</b>` : 'Unmapped from the inventory');
  document.getElementById('mapModal').classList.remove('open');
  const id = mapFor; mapFor = null;
  if (currentDetailId === id) openDetail(id);
}
window.openMapProperty = openMapProperty; window.pickProperty = pickProperty;
window.closeMapModal = () => { document.getElementById('mapModal').classList.remove('open'); mapFor = null; };

// ═══════ LINK A CRM LEAD ═══════
let linkFor = null;
function openLinkLead(id) {
  linkFor = id;
  document.getElementById('linkSearch').value = '';
  renderLinkList('');
  document.getElementById('linkModal').classList.add('open');
}
function renderLinkList(q) {
  const el = document.getElementById('linkList');
  if (!el) return;
  const needle = String(q || '').toLowerCase();
  // Sellers first — they are who this board is about — but every lead is
  // reachable, because an owner sometimes starts life as a buyer enquiry.
  const all = leads.slice().sort((a, b) => (isSellerLead(b) ? 1 : 0) - (isSellerLead(a) ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0));
  const list = all.filter(l => !needle || [l.name, l.phone, l.propertyInterest].join(' ').toLowerCase().includes(needle)).slice(0, 50);
  el.innerHTML = list.length ? list.map(l => `<button type="button" class="tk-pick" onclick="pickLead('${l.id}')">
      <span class="tk-pick-main"><b>${esc(l.name || 'Unnamed')}</b><span>${esc([l.phone, l.propertyInterest].filter(Boolean).join(' · '))}</span></span>
      ${isSellerLead(l) ? '<span class="tk-pill ai">seller</span>' : ''}
    </button>`).join('') : '<div class="tk-hint">Nothing matches.</div>';
}
window.onLinkSearch = v => renderLinkList(v);
function pickLead(leadId) {
  const l = leadById(leadId);
  if (!linkFor || !l) return;
  mutate(linkFor, x => {
    x.leadId = l.id;
    if (!x.sellerName) x.sellerName = l.name || '';
    if (!x.sellerPhone) x.sellerPhone = l.phone || '';
  }, `Linked to the CRM lead <b>${esc(l.name || l.id)}</b>`);
  document.getElementById('linkModal').classList.remove('open');
  const id = linkFor; linkFor = null;
  if (currentDetailId === id) openDetail(id);
}
window.openLinkLead = openLinkLead; window.pickLead = pickLead;
window.closeLinkModal = () => { document.getElementById('linkModal').classList.remove('open'); linkFor = null; };

// ═══════ ADD / EDIT MODAL ═══════
const FORM_FIELDS = [
  ['title', 'Title', 'text', '3BHK in Nungambakkam'],
  ['propertyCode', 'Property ID', 'text', 'TNAG0002 — leave blank if not in inventory yet'],
  ['location', 'Location', 'text', 'Nungambakkam'],
  ['config', 'Configuration', 'text', '3 BHK'],
  ['askingPrice', 'Asking price', 'text', '₹2.1 Cr'],
  ['sellerName', 'Owner name', 'text', ''],
  ['sellerPhone', 'Owner phone', 'tel', ''],
  ['shootAssignee', 'Shoot assigned to', 'text', '']
];
function openAddModal() {
  mModalMode = 'add'; mModalEditId = null;
  document.getElementById('mmTitle').textContent = 'New listing';
  FORM_FIELDS.forEach(([k]) => { const el = document.getElementById('mm_' + k); if (el) el.value = ''; });
  document.getElementById('mmErr').textContent = '';
  document.getElementById('mModal').classList.add('open');
}
function openEditModal(id) {
  const x = listings.find(l => l.id === id);
  if (!x) return;
  mModalMode = 'edit'; mModalEditId = id;
  document.getElementById('mmTitle').textContent = 'Edit listing';
  FORM_FIELDS.forEach(([k]) => { const el = document.getElementById('mm_' + k); if (el) el.value = x[k] || ''; });
  document.getElementById('mmErr').textContent = '';
  document.getElementById('mModal').classList.add('open');
}
function closeModal() { document.getElementById('mModal').classList.remove('open'); }
function saveModal() {
  const form = {};
  FORM_FIELDS.forEach(([k]) => { const el = document.getElementById('mm_' + k); form[k] = el ? el.value.trim() : ''; });
  if (!form.title && !form.propertyCode) {
    document.getElementById('mmErr').textContent = 'Give it a title, or a Property ID.';
    return;
  }
  const now = Date.now();
  if (mModalMode === 'edit') {
    mutate(mModalEditId, x => {
      // Editing the owner's name or phone HERE claims that field: the live
      // sync stops pushing the CRM's value over it from now on (see the
      // OVERRIDES note in seller-sync.js). Silently reverting someone's
      // correction on the next snapshot would be the worst thing this could do.
      const own = { ...(x.own || {}) };
      for (const f of ['sellerName', 'sellerPhone']) {
        if ((form[f] || '') !== (x[f] || '')) own[f] = true;
      }
      Object.assign(x, form, { own });
    }, 'Details edited');
    closeModal();
    if (currentDetailId === mModalEditId) openDetail(mModalEditId);
    toast('Saved');
    return;
  }
  const first = stages[0];
  if (!first) { toast('The board is still loading'); return; }
  const x = {
    id: newId('lst_'), stageId: first.id, ...form,
    media: {}, ownerInformed: false, ownerApproved: false,
    stageChangedAt: now, stageChangedBy: currentUserEmail || 'team',
    reached: { [P.stageKeyOf(first) || 'new_listing']: now },
    createdAt: now, createdBy: currentUserEmail || 'team', updatedAt: now, updatedBy: currentUserEmail || null
  };
  listings.push(x);
  addHistory(x, 'created', 'Listing created');
  persist(x);
  closeModal();
  refreshAll();
  toast('Listing created');
  openDetail(x.id);
}
window.openAddModal = openAddModal; window.openEditModal = openEditModal;
window.closeModal = closeModal; window.saveModal = saveModal;

// ═══════ TOAST ═══════
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ═══════ AUTH ═══════
window.onTrackAuthChange = function (user, tenantId) {
  const login = document.getElementById('loginScreen');
  const root = document.getElementById('appRoot');
  if (user) {
    currentUserEmail = user.email || null;
    login.classList.remove('open');
    root.style.display = '';
    if (window.AppNav) window.AppNav.setUser(user.email || '');
    if (!tenantId) {
      document.getElementById('boardView').innerHTML =
        '<div class="tk-note bad"><b>This account has no tenant yet.</b><br>Ask whoever set up your login to finish onboarding.</div>';
      return;
    }
    if (!trackInited) { trackInited = true; toggleView('board'); }
  } else {
    currentUserEmail = null;
    root.style.display = 'none';
    login.classList.add('open');
  }
};
function attemptLogin(e) {
  e.preventDefault();
  const err = document.getElementById('loginErr');
  err.classList.remove('show');
  window.trackAuth.login(document.getElementById('loginUser').value.trim(), document.getElementById('loginPass').value)
    .catch(() => { err.textContent = 'Invalid email or password.'; err.classList.add('show'); });
  return false;
}
function trackLogout() { window.trackAuth.logout(); }
window.attemptLogin = attemptLogin; window.trackLogout = trackLogout;

// Escape closes whatever is on top; overlay clicks close their own layer.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  // Innermost layer first, so Escape peels one thing at a time.
  const open = ['mModal', 'shModal', 'mapModal', 'linkModal', 'rsModal', 'sellerPrev'].find(id => {
    const el = document.getElementById(id);
    return el && el.classList.contains('open');
  });
  if (open) document.getElementById(open).classList.remove('open');
  else if (currentDetailId) closeDetail();
});
document.addEventListener('mousedown', e => {
  if (e.target.classList && e.target.classList.contains('tk-ov')) e.target.classList.remove('open');
});

// ═══════ THE RAIL ═══════
// Booted here rather than from a nav-boot.js of its own: this file is a
// module, so a classic boot script would run first and find no toggleView.
// Board, Shoots and Sellers are three panes of one page, so picking any of
// them is a display swap rather than a navigation.
window.AppNav.boot({
  console: 'track',
  select: view => toggleView(view),
  signOut: () => trackLogout()
});
window.AppNav.setActive(currentView);
const pendingNav = window.AppNav.takeNav();
if (pendingNav) setTimeout(() => toggleView(pendingNav), 0);
