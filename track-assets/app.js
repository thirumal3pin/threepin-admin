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
import * as BF from './brochure-flow.js';
import { planSync, newListingFor, isSellerLead as isSeller } from './seller-sync.js';
import { extractPropertyFacts, sortSize, TYPE_LABELS } from '../crm-assets/propertyFacts.js';
import { displayName } from '../crm-assets/mentions.js';
import * as TG from './tags.js';

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

const TRACK_VIEWS = ['board', 'shoots', 'sellers', 'posting'];
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


// ═══════ SNAPSHOT CALLBACKS ═══════
// The sync module calls these; each ends in a re-render. Same contract as the
// CRM's applyLeadsSnapshot / applyPipelineSnapshot.
window.applyListingsSnapshot = function (list) {
  listings = Array.isArray(list) ? list : [];
  seenListings = true;
  // The Posting tab shows each property's tags from its listing: tell it to redraw (it still waits
  // while someone is typing there).
  if (window.pgListingsChanged) window.pgListingsChanged();
  refreshAll();
};
window.applyTrackPipelineSnapshot = function (list) {
  // A board saved before a column was renamed ("Shot" → "Shoot done") is brought up to date once,
  // here, and saved — only where the old default name is still in place.
  const r = P.renameOldDefaults(Array.isArray(list) ? list : []);
  // The brochure columns were retired: drop them here, move their listings once listings are in.
  const t = P.retireColumns(r.stages);
  // …and a column added since (Media ready) is placed on a board that does not have it yet.
  const a = P.addNewColumns(t.stages);
  stages = a.stages.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  if (a.changed) mediaSweepPending = true;
  if (t.retiredIds.length) retirePending = { ids: t.retiredIds, stages: a.stages, all: P.addNewColumns(r.stages).stages.slice().sort((p, q) => (p.order || 0) - (q.order || 0)) };
  else if ((r.changed || a.changed) && window.trackFirebase && window.trackFirebase.savePipeline) {
    window.trackFirebase.savePipeline(a.stages).catch(e => console.error('Column update save failed:', e));
  }
  refreshAll();
};
// Listings that sat in a retired column go back to Shoot done — the brochure state they carried
// shows on their tile now — and only once every one of them is saved is the board saved without
// those columns. If a save fails the board keeps them, and the next load tries again, so no
// listing is ever left pointing at a column that no longer exists.
let retirePending = null;
function retireColumnsNow() {
  if (!retirePending || !seenListings || !window.trackFirebase) return;
  const { ids, stages: kept, all } = retirePending;
  retirePending = null;
  const target = P.stageForKey(kept, 'shoot_done') || kept[0];
  const now = Date.now();
  const moved = listings.filter(l => ids.includes(l.stageId));
  for (const x of moved) {
    addHistory(x, 'stage', `Moved to <b>${esc(target.name)}</b> — the brochure columns were retired; its brochure shows on the tile`);
    x.prevStageId = x.stageId; x.stageId = target.id; x.stageChangedAt = now; x.stageChangedBy = 'automatic';
    x.updatedAt = now;
  }
  Promise.all(moved.map(x => window.trackFirebase.saveListing(x)))
    .then(() => window.trackFirebase.savePipeline(kept))
    .catch(e => {
      // Some listing was not saved and may still point at an old column: show those columns again
      // for this session so nothing goes out of sight; the next load tries again.
      console.error('Retiring the brochure columns failed — will retry on the next load:', e);
      stages = all;
      applyFilters();
    });
}
window.applyTrackLeadsSnapshot = function (list) {
  leads = Array.isArray(list) ? list : [];
  seenLeads = true;
  refreshAll();
};

function refreshAll() {
  forgetBrochures();
  try { reconcileSellers(); } catch (e) { console.error('seller sync:', e); }
  // Listings waiting on a brochure: link them once their property reaches the dashboard, tick
  // "Brochure created" once it is delivered (throttled inside to once a minute).
  try { retireColumnsNow(); } catch (e) { console.error('column retire:', e); }
  // Only from a tab someone is looking at: a hidden tab re-reading the inventory on every CRM
  // snapshot is reads nobody sees (the visible tab, or this one when it comes back, does it).
  try { if (seenListings && window.bpReconcile && document.visibilityState === 'visible') window.bpReconcile(); } catch (e) { console.error('brochure reconcile:', e); }
  try { mediaSweepNow(); } catch (e) { console.error('media ready:', e); }
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
// A value inside an inline handler: JSON-quoted, then attribute-escaped (esc alone is undone by the
// browser before the handler runs).
const jsq = v => esc(JSON.stringify(String(v == null ? '' : v)));

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
  forgetBrochures();
  const q = currentSearch;
  filtered = listings.filter(x => {
    if (stageFilter.size && !stageFilter.has(x.stageId)) return false;
    if (brochureFilter && brochureOf(x) !== brochureFilter) return false;
    if (ownerAgentFilter.size) { const ag = listingAgents(x); if (!(ag.length ? ag.some(e => ownerAgentFilter.has(e)) : ownerAgentFilter.has('none'))) return false; }
    if (tagFilter.size && !TG.cleanTags(x.tags).some(t => tagFilter.has(TG.tagKey(t)))) return false;
    if (!q) return true;
    const l = x.leadId ? leadById(x.leadId) : null;
    const hay = [x.title, x.propertyCode, x.location, x.config, x.sellerName, x.sellerPhone,
      x.askingPrice, x.shootAssignee, x.remarks, x.lastNote && x.lastNote.text, l && l.name, l && l.phone, l && l.propertyInterest,
      l && l.assignedAgent, l && l.secondaryAgent, ...TG.cleanTags(x.tags)].join(' ').toLowerCase();
    return hay.includes(q);
  });
  fitBoard();
  if (currentView === 'board') { boardMode === 'list' ? renderList() : renderBoard(); }
  else if (currentView === 'shoots') renderShoots();
  // The Posting tab redraws through its own guard: never while someone is typing in it or has a
  // dialog open. It redraws when its rows, the search text or the listings (their tags) changed.
  else if (currentView === 'posting') { const r = window.refreshPosting || window.renderPosting; if (r) r(); }
  else renderSellers();
}

function toggleView(view) {
  currentView = TRACK_VIEWS.includes(view) ? view : 'board';
  document.documentElement.classList.toggle('pg-on', currentView === 'posting');
  TRACK_VIEWS.forEach(v => {
    const el = document.getElementById(v + 'View');
    if (el) el.style.display = v === currentView ? '' : 'none';
  });
  if (currentView === 'posting' && window.postingOpened) window.postingOpened();
  // Stage chips and the board/list switch only mean anything on the board.
  const bar = document.querySelector('.tk-filterbar');
  if (bar) bar.style.display = currentView === 'board' ? '' : 'none';
  // On a shoot phone the search box is chrome in the way of the day.
  const srch = document.querySelector('.srch-wrap');
  if (srch) srch.style.display = (myAgent && currentView === 'shoots') ? 'none' : '';
  if (window.AppNav) window.AppNav.setActive(currentView);
  applyFilters();
}
window.toggleView = toggleView;

function onSearch(v) {
  currentSearch = String(v || '').toLowerCase();
  applyFilters();
}
window.onSearch = onSearch;


// Ten stages meant ten coloured pills wrapping over five rows on a phone —
// half a screen of chrome before the first listing, and a rainbow that said
// nothing, because a colour on every chip is a colour on none.
//
// Colour is now reserved for meaning: red is late, amber is blocked, and the
// stage's own hue survives only as a small dot beside its name, which is
// enough to recognise a column by. The chips themselves are plain, and the
// selected one is simply darker. On a phone the row scrolls sideways instead
// of wrapping, so the filter costs one line whatever the number of stages.
//
// The bar is also collapsed by default on a phone behind a single summary
// button: most visits are to read the board, not to narrow it.
// Stage and Agent are multi-select dropdowns, and Sort is one choice shared by the board and the
// list. Ten stage chips ran off the edge of the bar and overlapped the Board/List switch.
let ownerAgentFilter = new Set();     // emails, or 'none' for Unassigned
let tagFilter = new Set();           // tag keys (lower case); a listing with any of them shows
// The brochure is a filter, not a column: '' (all) · none · requested · building · created.
let brochureFilter = '';
const BROCHURE_FILTERS = [['', 'All'], ['none', 'Not started'], ['requested', 'Requested'], ['building', 'On its way'], ['created', 'Created']];
window.setBrochureFilter = v => { brochureFilter = BROCHURE_FILTERS.some(([k]) => k === v) ? v : ''; renderFilterBar(); applyFilters(); };
const SORT_KEY = 'track.sort';
const SORTS = [
  ['urgency', 'Needs attention'],
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['updated', 'Last updated'],
  ['lastMsg', 'Last message'],
  ['shoot', 'Shoot date'],
  ['age', 'Longest in stage'],
  ['priceHigh', 'Price: high to low'],
  ['priceLow', 'Price: low to high'],
  ['sizeHigh', 'Size: largest first'],
  ['stage', 'Stage'],
  ['name', 'Name A–Z']
];
let boardSortKey = 'urgency';
try { const v = localStorage.getItem(SORT_KEY); if (SORTS.some(([k]) => k === v)) boardSortKey = v; } catch (e) {}
function setBoardSort(k) {
  boardSortKey = SORTS.some(([s]) => s === k) ? k : 'urgency';
  try { localStorage.setItem(SORT_KEY, boardSortKey); } catch (e) {}
  applyFilters();
}
window.setBoardSort = setBoardSort;
function sortCards(arr) {
  const items = arr.map(x => ({ x, it: sellerItem(x) }));
  const idx = o => stages.findIndex(s => s.id === o.x.stageId);
  const urgent = (a, b) => cardUrgency(b.x) - cardUrgency(a.x) || (b.x.updatedAt || 0) - (a.x.updatedAt || 0);
  const has = v => v != null && v !== 0 && isFinite(v);   // no value sinks to the end
  const num = (f, dir) => (a, b) => { const x = f(a), y = f(b); return !has(x) && !has(y) ? 0 : !has(x) ? 1 : !has(y) ? -1 : dir * (x - y); };
  const by = {
    newest: num(o => o.it.intake, -1),
    oldest: num(o => o.it.intake, 1),
    updated: num(o => o.x.updatedAt, -1),
    lastMsg: num(o => o.it.lastMsg, -1),
    shoot: num(o => o.x.shootAt, 1),
    age: (a, b) => P.stageAge(b.x, stages, Date.now()).days - P.stageAge(a.x, stages, Date.now()).days,
    priceHigh: num(o => o.it.f.priceValue, -1),
    priceLow: num(o => o.it.f.priceValue, 1),
    sizeHigh: num(o => sortSize(o.it.f), -1),
    stage: (a, b) => idx(a) - idx(b),
    name: (a, b) => String(a.it.name || '').toLowerCase().localeCompare(String(b.it.name || '').toLowerCase())
  }[boardSortKey] || urgent;
  return items.sort((a, b) => by(a, b) || urgent(a, b)).map(o => o.x);
}

function listingAgents(x) {
  const l = x.leadId ? leadById(x.leadId) : null;
  return [l && l.assignedAgent, l && l.secondaryAgent].filter(Boolean).map(e => String(e).toLowerCase());
}
function toggleStageFilter(id) {
  if (stageFilter.has(id)) stageFilter.delete(id); else stageFilter.add(id);
  renderFilterBar(); applyFilters();
}
function clearStageFilter() { stageFilter = new Set(); renderFilterBar(); applyFilters(); }
function toggleAgentFilter(v) {
  if (ownerAgentFilter.has(v)) ownerAgentFilter.delete(v); else ownerAgentFilter.add(v);
  renderFilterBar(); applyFilters();
}
function clearAgentFilter() { ownerAgentFilter = new Set(); renderFilterBar(); applyFilters(); }
function toggleTagFilter(k) {
  if (tagFilter.has(k)) tagFilter.delete(k); else tagFilter.add(k);
  renderFilterBar(); applyFilters();
}
function clearTagFilter() { tagFilter = new Set(); renderFilterBar(); applyFilters(); }
Object.assign(window, { toggleStageFilter, clearStageFilter, toggleAgentFilter, clearAgentFilter, toggleTagFilter, clearTagFilter });
// Every tag in use — the starting four, on listings, and on Posting rows of their own.
const allTags = () => TG.catalog(...listings.map(l => l.tags), ...((window.pgOwnTagLists && window.pgOwnTagLists()) || []));
// A listing's tags as chips (on the tile, the list row, the Posting tab).
const tagChips = list => { const l = TG.cleanTags(list); return l.length ? `<div class="tk-tags">${l.map(t => `<span class="tk-tag ${TG.tagClass(t)}">${esc(t)}</span>`).join('')}</div>` : ''; };

function renderFilterBar() {
  const el = document.getElementById('tkFilterBar');
  if (!el) return;
  const openId = (el.querySelector('details[open]') || {}).id;
  const row = (on, onclick, dot, label, n) => `<label class="tk-dd-row"><input type="checkbox" ${on ? 'checked' : ''} onchange="${onclick}">${dot}<span class="tk-dd-l">${esc(label)}</span><span class="tk-dd-n">${n}</span></label>`;
  const stageRows = stages.map(s => row(stageFilter.has(s.id), `toggleStageFilter('${s.id}')`,
    `<i class="tk-cdot" style="background:${s.color}"></i>`, s.name, listings.filter(x => x.stageId === s.id).length)).join('');
  const emails = [...new Set(listings.flatMap(listingAgents))].sort();
  const agentRows = row(ownerAgentFilter.has('none'), `toggleAgentFilter('none')`, '', 'Unassigned', listings.filter(x => !listingAgents(x).length).length)
    + emails.map(e => row(ownerAgentFilter.has(e), `toggleAgentFilter('${esc(e)}')`, '', personName(e), listings.filter(x => listingAgents(x).includes(e)).length)).join('');
  const names = (set, all, nameOf) => !set.size ? all : set.size <= 2 ? [...set].map(nameOf).join(', ') : set.size + ' selected';
  const stageLabel = names(stageFilter, 'All stages', id => (stageById(id) || {}).name || id);
  const agentLabel = names(ownerAgentFilter, 'Everyone', e => e === 'none' ? 'Unassigned' : personName(e));
  const tagCat = allTags();
  const tagRows = tagCat.map(t => row(tagFilter.has(TG.tagKey(t)), `toggleTagFilter(${jsq(TG.tagKey(t))})`, `<i class="tk-cdot tg-dot ${TG.tagClass(t)}"></i>`, t, listings.filter(x => TG.hasTag(x.tags, t)).length)).join('');
  const tagLabel = names(tagFilter, 'All', k => (tagCat.find(t => TG.tagKey(t) === k) || k));
  el.innerHTML = `
    <details class="tk-dd${stageFilter.size ? ' on' : ''}" id="ddStage"${openId === 'ddStage' ? ' open' : ''}>
      <summary><span class="tk-dd-k">Stage</span><span class="tk-dd-v">${esc(stageLabel)}</span><span class="tk-caret">▾</span></summary>
      <div class="tk-dd-pop">${stageRows}
        ${stageFilter.size ? `<button type="button" class="tk-dd-clear" onclick="clearStageFilter()">Show all stages</button>` : ''}</div>
    </details>
    <details class="tk-dd${ownerAgentFilter.size ? ' on' : ''}" id="ddAgent"${openId === 'ddAgent' ? ' open' : ''}>
      <summary><span class="tk-dd-k">Agent</span><span class="tk-dd-v">${esc(agentLabel)}</span><span class="tk-caret">▾</span></summary>
      <div class="tk-dd-pop">${agentRows}
        ${ownerAgentFilter.size ? `<button type="button" class="tk-dd-clear" onclick="clearAgentFilter()">Show everyone</button>` : ''}</div>
    </details>
    <details class="tk-dd${tagFilter.size ? ' on' : ''}" id="ddTag"${openId === 'ddTag' ? ' open' : ''}>
      <summary><span class="tk-dd-k">Tags</span><span class="tk-dd-v">${esc(tagLabel)}</span><span class="tk-caret">▾</span></summary>
      <div class="tk-dd-pop">${tagRows}
        ${tagFilter.size ? `<button type="button" class="tk-dd-clear" onclick="clearTagFilter()">Show all tags</button>` : ''}</div>
    </details>
    <label class="tk-dd tk-dd-pick tk-dd-bro${brochureFilter ? ' on' : ''}"><span class="tk-dd-k">Brochure</span>
      <select onchange="setBrochureFilter(this.value)" aria-label="Brochure">${BROCHURE_FILTERS.map(([k, l]) => `<option value="${k}"${brochureFilter === k ? ' selected' : ''}>${esc(l)}${k ? ' (' + listings.filter(x => brochureOf(x) === k).length + ')' : ''}</option>`).join('')}</select>
    </label>
    <label class="tk-dd tk-dd-sort"><span class="tk-dd-k">Sort</span>
      <select onchange="setBoardSort(this.value)" aria-label="Sort">${SORTS.map(([k, l]) => `<option value="${k}"${boardSortKey === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
    </label>`;
}
// A dropdown closes when you click anywhere else, like any menu.
document.addEventListener('click', e => {
  document.querySelectorAll('#tkFilterBar details[open]').forEach(d => { if (!d.contains(e.target)) d.removeAttribute('open'); });
});

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
    const cards = sortCards(filtered.filter(x => x.stageId === stage.id));
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
  fitBoard();
}
// The board fills the screen below the header: columns scroll inside themselves, and the page
// never scrolls on into blank space. Only the board view; list, shoots and sellers scroll as pages.
function fitBoard() {
  const on = currentView === 'board' && boardMode !== 'list';
  document.documentElement.classList.toggle('tk-fit', on);
  const b = on && document.querySelector('#boardView .tk-board');
  if (!b) return;
  window.scrollTo(0, 0);
  document.documentElement.style.setProperty('--board-top', Math.round(b.getBoundingClientRect().top) + 'px');
}
window.addEventListener('resize', () => fitBoard());

// ═══════ LIST VIEW ═══════
// Everything at once, in one scan: stage, owner, mapping, shoot, media,
// what is blocking it. The board answers "where is this one"; this answers
// "what is the state of all of them", which is the question asked before a
// week is planned.
function renderList() {
  const host = document.getElementById('boardView');
  if (!host) return;
  const rows = sortCards(filtered);
  if (!rows.length) {
    host.innerHTML = `<div class="tk-empty"><div class="tk-empty-i">📋</div><div class="tk-empty-t">Nothing matches</div></div>`;
    return;
  }
  host.innerHTML = `
    <div class="tk-listwrap">
      <div class="tk-listbar">
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
  const it = sellerItem(x);
  return `<div class="tk-tr${isLate(x) ? ' late' : ''}" role="row" tabindex="0"
      onclick="openDetail('${x.id}')" onkeydown="onCardKeydown(event,'${x.id}')">
    <span role="cell">
      <b>${esc(it.locality || x.title || 'Area not given')}</b>
      <span class="tk-sub2">${[it.f.deal && (it.f.deal === 'rent' ? 'For rent' : 'For sale'), it.f.type && (TYPE_LABELS[it.f.type] || it.f.type), it.f.config, it.f.sizes[0] && it.f.sizes[0].label, it.f.price].filter(Boolean).map(esc).join(' · ') || '—'}</span>
      ${codeChip(x)}
      ${tagChips(x.tags)}
    </span>
    <span role="cell">
      ${st ? `<span class="tk-pill" style="background:${st.color}22;color:${st.color}">${esc(st.name)}</span>` : '—'}
      <span class="tk-sub2${age.farOver ? ' bad' : age.over ? ' warn' : ''}">${age.days}d here</span>
    </span>
    <span role="cell">
      ${esc(it.name)}
      ${it.phone ? `<a class="tk-sub2 link" href="tel:${esc(telOf(it.phone))}" onclick="event.stopPropagation()">${esc(it.phone)}</a>` : ''}
      <span class="tk-sub2">👤 ${agentsOf(it).length ? esc(agentsOf(it).map(personName).join(' + ')) : 'Unassigned'}</span>
    </span>
    <span role="cell" class="${late ? 'bad' : ''}">
      ${x.shootAt ? `${esc(fmtDate(x.shootAt))}<span class="tk-sub2">${esc(relDays(x.shootAt))}</span>` : '<span class="tk-sub2">not booked</span>'}
    </span>
    <span role="cell">${done}/${MEDIA_KEYS.length}${x.ownerApproved ? '<span class="tk-sub2 ok">owner ✓</span>' : ''}${brochureSignal(x) ? `<span class="tk-sub2">${brochureSignal(x)}</span>` : ''}</span>
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
// The same reading order as the Sellers tiles — who (name, number), then the property (area,
// sale/rent, type, configuration, size, price), then where it stands — so a card reads the same
// on both pages. The column already says the stage, so the card says how long it has sat there.
const personName = e => { const s = String(e || '').split('@')[0]; return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; };
function agentsOf(it) {
  const l = it.lead;
  return [l && l.assignedAgent, l && l.secondaryAgent].filter(Boolean);
}
function factChips(f, maxSizes) {
  const chip = (t, cls) => `<span class="sl-chip${cls ? ' ' + cls : ''}">${esc(t)}</span>`;
  return [
    f.deal ? chip(f.deal === 'rent' ? 'For rent' : 'For sale', f.deal) : '',
    f.type ? chip(TYPE_LABELS[f.type] || f.type) : '',
    f.config && f.config !== 'Commercial' ? chip(f.config) : '',
    ...[...new Set(f.sizes.map(z => z.label))].slice(0, maxSizes).map(l => chip(l)),
    f.price ? chip(f.price, 'price') : ''
  ].join('');
}
function cardHtml(x) {
  const late = isLate(x);
  const age = P.stageAge(x, stages, Date.now());
  const blocked = blockersFor(x);
  const it = sellerItem(x);
  const wa = telOf(it.phone).replace(/^\+/, '');
  const chips = factChips(it.f, 2);
  const agents = agentsOf(it);
  const by = personName(x.updatedBy);
  // A card added by hand on the board may have no owner yet: its title is then all it has.
  it.locality = it.locality || (it.name !== x.title ? x.title || '' : '');
  return `<div class="tk-card${late ? ' late' : ''}" draggable="true" tabindex="0" role="link"
      aria-label="Open ${esc(it.name)}${it.locality ? ', ' + esc(it.locality) : ''}"
      data-id="${x.id}"
      ondragstart="onCardDragStart(event,'${x.id}')" ondragend="onCardDragEnd(event)"
      onclick="openDetail('${x.id}')" onkeydown="onCardKeydown(event,'${x.id}')">
    <div class="sl-head">
      <div class="sl-who">
        <div class="sl-name" title="${esc(it.name)}">${esc(it.name)}</div>
        ${it.phone ? `<div class="sl-phone"><a href="tel:${esc(telOf(it.phone))}" onclick="event.stopPropagation()" title="Call">${esc(it.phone)}</a>${wa ? ` · <a href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">WhatsApp</a>` : ''}${x.leadId ? ` · <button type="button" class="sl-link" onclick="event.stopPropagation();openSellerPreview('${x.id}')" title="The property at a glance">Preview</button>` : ''}</div>` : '<div class="sl-phone none">No number</div>'}
      </div>
      <span class="tk-age-pill${age.farOver ? ' bad' : age.over ? ' warn' : ''}" title="${age.target ? 'This column should take about ' + age.target + ' days' : 'Days in this column'}">${age.days === 0 ? 'today' : age.days + 'd here'}</span>
    </div>
    <div class="sl-prop">
      <div class="sl-loc">${it.locality ? '📍 ' + esc(it.locality) : '<span class="sl-none">Area not given</span>'}${codeChip(x)}</div>
      ${chips ? `<div class="sl-chips">${chips}</div>` : ''}
      ${tagChips(x.tags)}
      ${it.missing.length ? `<div class="sl-miss">Missing: ${esc(it.missing.join(', '))}</div>` : ''}
    </div>
    ${shootLine(x)}
    ${mediaBar(x)}
    ${blocked.length ? `<div class="tk-blockers">${blocked.map(b => `<span class="tk-blk">${esc(b)}</span>`).join('')}</div>` : ''}
    ${x.lastNote && x.lastNote.text ? `<div class="tk-card-note" title="${esc(x.lastNote.text)}"><span class="tk-card-note-t">📝 ${esc(x.lastNote.text)}</span><span class="tk-card-note-m">${esc(personName(x.lastNote.by))} · ${esc(timeAgo(x.lastNote.at))}${x.noteCount > 1 ? ` · ${x.noteCount} notes` : ''}</span></div>` : ''}
    <div class="tk-card-meta">
      <span class="tk-agent${agents.length ? '' : ' none'}" title="The lead's agent (set on the lead in the CRM)">👤 ${agents.length ? esc(agents.map(personName).join(' + ')) : 'Unassigned'}</span>
      ${x.ownerApproved ? '<span class="tk-ok" title="Owner approved the photos / brochure">owner ✓</span>' : ''}
      ${brochureSignal(x)}
      <span class="tk-upd" title="${esc(x.updatedAt ? new Date(x.updatedAt).toLocaleString() : '')}">Updated ${esc(timeAgo(x.updatedAt) || '—')}${by ? ' by ' + esc(by) : ''}</span>
      ${it.intake ? `<span title="${esc(new Date(it.intake).toLocaleString())}">Came in ${esc(fmtDate(it.intake))} · ${esc(it.channel)}</span>` : ''}
    </div>
  </div>`;
}

// Being unmapped is NORMAL for a listing nobody has worked yet — it is how
// every one of them starts. Shouting it in amber on all twenty-four made the
// amber worthless and the board look like a wall of problems. It is silent
// until the stage actually needs the mapping, and blockersFor() says so then.
// A purely numeric "code" is a legacy Firestore document id, not a
// Property_ID — the same rule propertyCodeOf() applies in crm-assets/app.js.
// Showing "10" in a code chip tells nobody anything.
const realCode = c => !!String(c || '').trim() && !/^\d+$/.test(String(c).trim());

function codeChip(x) {
  if (realCode(x.propertyCode)) return `<span class="tk-code" title="Inventory ${esc(x.propertyCode)}">${esc(x.propertyCode)}</span>`;
  if (x.propertyCode) return `<span class="tk-code" title="Mapped to an older inventory record">mapped</span>`;
  const key = P.stageKeyOf(stageById(x.stageId));
  const needsIt = key === 'live';
  return needsIt
    ? `<span class="tk-code none" title="This stage cannot proceed without an inventory mapping">unmapped</span>`
    : '';
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
    return `<div class="tk-card-row muted">📸 No shoot booked <button type="button" class="tk-link" onclick="event.stopPropagation();openShootModal('${x.id}')">Book →</button></div>`;
  }
  const late = x.shootAt < Date.now();
  const soon = !late && x.shootAt < Date.now() + DAY;
  return `<div class="tk-card-row${late ? ' bad' : soon ? ' hot' : ''}">📸 ${esc(fmtDateTime(x.shootAt))}
    <span class="tk-rel">${esc(relDays(x.shootAt))}</span>
    ${x.shootAssignee ? `<span class="tk-who">· ${esc(x.shootAssignee)}</span>` : ''}
    ${!x.ownerInformed && P.stageKeyOf(stageById(x.stageId)) !== 'shoot_scheduled' ? '<span class="tk-blk sm" title="The owner has not been told we are coming">owner not told</span>' : ''}
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
  // After it: what is still outstanding before the media is ready. In Media ready itself the same
  // list shows anything unticked after the move. A brochure on its way already shows as its own
  // signal on the tile, so only a missing one is repeated here.
  if (key === 'shoot_done' || key === 'media_ready') {
    for (const g of mediaGaps(x)) if (g !== GAP_BROCHURE || brochureOf(x) === 'none') out.push(g);
  }
  if (key === 'live' && !x.propertyCode) out.push('not in inventory');
  if (key === 'live' && !x.ownerApproved) out.push('owner has not approved');
  if (key === 'live' && brochureOf(x) !== 'created') out.push('no brochure');
  return out;
}

// ── Media ready: everything the shoot was for is in hand ──
// The brief's media, the photos uploaded, the voice-over (when it is made separately), every
// "Shoot for" cut that was planned, and the brochure. Empty = ready.
const GAP_BROCHURE = 'no brochure';
function mediaGaps(x) {
  const out = [];
  const { done, total } = mediaProgress(x);
  if (done < total) out.push(`${total - done} of ${total} media missing`);
  if (!x.photosLink) out.push('photos not uploaded');
  const forLeft = FOR_KEYS.filter(([k]) => forPlanned(x, k) && !forMade(x, k)).map(([, l]) => l);
  if (forLeft.length) out.push(`${forLeft.join(' + ')} not done`);
  // Voice-over per outlet: every planned outlet that needs one, until it is made.
  const voLeft = FOR_KEYS.filter(([k]) => forPlanned(x, k) && forVoice(x, k) === 'vo' && !forVoMade(x, k)).map(([, l]) => l);
  if (voLeft.length) out.push(`voice-over not made: ${voLeft.join(', ')}`);
  else if (legacyVoice(x) && !x.voDone) out.push('voice-over not made');
  if (brochureOf(x) !== 'created') out.push(GAP_BROCHURE);
  return out;
}
// A listing in Shoot done moves on by itself once nothing is left. It is called only from this
// tab's own actions — an edit (mutate, which the brochure reconcile also goes through), a move
// forward into Shoot done, the column being added — never off another tab's snapshot (that tab
// already did it). A listing someone moved BACK into Shoot done is held there (x.heldBack) until
// an edit finishes something that was missing again. Never moves a listing back out of Media
// ready either: the tile says what went missing instead.
function promoteIfMediaReady(x) {
  if (!x || x.heldBack || P.stageKeyOf(stageById(x.stageId)) !== 'shoot_done') return false;
  if (!P.stageForKey(stages, 'media_ready') || mediaGaps(x).length) return false;
  advanceTo(x.id, 'media_ready', 'everything the shoot was for is done');
  if (currentDetailId === x.id) openDetail(x.id);
  toast(`${x.title || 'Listing'} → Media ready`);
  return true;
}
// Media ready was just added to this board: listings already complete in Shoot done move once.
let mediaSweepPending = false;
function mediaSweepNow() {
  if (!mediaSweepPending || !seenListings) return;
  mediaSweepPending = false;
  listings.forEach(promoteIfMediaReady);
}

// ── The brochure, as a signal on the tile (it is a step inside a listing, not a column) ──
// created · requested (waiting for the dashboard) · building (built, not delivered) · none
// Read many times per render (tile, filter counts, blockers), so it is remembered until the
// listing, the inventory or the board changes.
let broCache = new Map(), broInv = null;
const forgetBrochures = () => broCache.clear();
function brochureOf(x) {
  if (broInv !== inventory) { broCache.clear(); broInv = inventory; }
  if (broCache.has(x.id)) return broCache.get(x.id);
  let v;
  if (BF.isLocked(x, inventory || [])) v = 'created';
  else {
    const st = BF.brochureState(x, inventory || []), b = x.brochure || {};
    // Unlocked for a redo: the old brochure no longer counts — only a request made after the unlock.
    if (b.unlockedAt) v = (b.requestedAt || 0) > b.unlockedAt ? (st === 'ready' ? 'requested' : st) : 'none';
    else v = st === 'ready' ? 'created' : st;
  }
  broCache.set(x.id, v);
  return v;
}
const BROCHURE_SIG = {
  created: ['📄 Brochure ✓', 'ok', 'Brochure created'],
  requested: ['📄 Brochure requested', 'warn', 'Requested — waiting for it to reach the dashboard'],
  building: ['📄 Brochure on its way', 'warn', 'Built — waiting for delivery from the Mac']
};
function brochureSignal(x) {
  const b = BROCHURE_SIG[brochureOf(x)];
  return b ? `<span class="tk-bro ${b[1]}" title="${esc(b[2])}">${b[0]}</span>` : '';
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

// Who can be sent on a shoot — picked, never retyped: a typo in a free-text name silently splits
// one person's day into two and neither looks wrong. The team is the CRM's (settings.team, set by
// the owner — the same people a lead can be assigned to), named the way the CRM names them; anyone
// already sent who is not on it (an outside photographer) stays pickable too. A shoot keeps the
// name (the Shoots view and "this is me" go by it) and, for a teammate, their email.
let team = [], teamKey = '';   // [{ name, email }]
// Names are compared trimmed and case-blind everywhere ("swami" on an older listing is Swami).
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
// Shoots are done by the media people. Shared mailboxes on the team (sales@, admin@…) are not
// people anyone sends to a property, so they are not offered; a new teammate added in the CRM is.
const ROLE_MAILBOX = /^(sales|admin|info|support|accounts?|hr|office|contact|hello|no-?reply)$/;
window.applyTrackTeamSnapshot = map => {
  const seenE = new Set(), seenN = new Set();
  const next = Object.values(map && typeof map === 'object' ? map : {})
    .map(m => String((m && m.email) || '').trim().toLowerCase())
    .filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && !ROLE_MAILBOX.test(e.split('@')[0]) && !seenE.has(e) && seenE.add(e))
    .map(email => ({ name: displayName(email), email }))
    // Two emails that read as the same name: the first is the one offered (no twin options).
    .filter(t => !seenN.has(t.name.toLowerCase()) && seenN.add(t.name.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  // The settings document changes for many reasons (CRM views, run stamps…): only a change to the
  // team itself redraws anything, so a half-typed note or an open dropdown is never disturbed.
  const key = next.map(t => t.email).join(',');
  if (key === teamKey) return;
  team = next; teamKey = key;
  // A picker open right now gets the new list, keeping what is chosen in it.
  for (const id of ['shWho', 'mm_shootAssignee']) {
    const sel = document.getElementById(id), box = sel && sel.closest('.tk-ov, .tk-modal');
    if (sel && sel.tagName === 'SELECT' && box && box.classList.contains('open') && sel.value !== OTHER) { const v = sel.value; sel.innerHTML = shooterOptions(v); sel.dataset.was = sel.value; }
  }
  if (currentView === 'shoots') renderShoots();
  if (currentDetailId && document.getElementById('dp')?.classList.contains('open')) openDetail(currentDetailId);
};
function shootPeople() {
  const out = team.slice(), names = new Set(team.map(t => t.name.toLowerCase()));
  for (const x of listings) {
    const n = String(x.shootAssignee || '').trim();
    if (n && !names.has(n.toLowerCase())) { names.add(n.toLowerCase()); out.push({ name: n, email: '' }); }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
// "Whose day" lists only people who actually have shoots — not every mailbox on the team.
function shootAgents() {
  const seen = new Map();
  for (const x of listings) {
    const n = String(x.shootAssignee || '').trim();
    if (!n) continue;
    // One button per person: a teammate by their email (whatever the spelling), anyone else by name.
    const mate = team.find(t => (x.shootAssigneeEmail && t.email === x.shootAssigneeEmail) || sameName(t.name, n));
    const key = mate ? mate.email : n.toLowerCase();
    if (!seen.has(key)) seen.set(key, mate ? mate.name : n);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
const emailOfShooter = name => (team.find(t => sameName(t.name, name)) || {}).email || '';
// The email to keep with a choice: the teammate's, or — same person as before but the team not
// loaded yet / since edited — the one the listing already had.
const shooterEmail = (x, who) => emailOfShooter(who) || (x && sameName(who, x.shootAssignee) ? x.shootAssigneeEmail || null : null);
const OTHER = '__other';
// The name as the list shows it (the team's spelling when it is a teammate).
const shownShooter = cur => { const n = String(cur || '').trim(); return (shootPeople().find(p => sameName(p.name, n)) || {}).name || n; };
// The options of an "Assigned to" picker: nobody, the team, others already sent, then someone new.
function shooterOptions(current) {
  const cur = String(current || '').trim();
  const people = shootPeople();
  if (cur && !people.some(p => p.name.toLowerCase() === cur.toLowerCase())) people.push({ name: cur, email: '' });
  const opt = p => `<option value="${esc(p.name)}"${sameName(p.name, cur) ? ' selected' : ''}>${esc(p.name)}</option>`;
  const mates = people.filter(p => p.email), others = people.filter(p => !p.email);
  return `<option value=""${cur ? '' : ' selected'}>Not assigned</option>
    ${mates.length ? `<optgroup label="Media team">${mates.map(opt).join('')}</optgroup>` : ''}
    ${others.length ? `<optgroup label="Also sent before">${others.map(opt).join('')}</optgroup>` : ''}
    <option value="${OTHER}">Someone else…</option>`;
}
// "Someone else…": ask for the name once, then it is in the list for next time.
function pickedShooter(sel) {
  if (sel.value !== OTHER) return sel.value;
  const n = (prompt('Who is going? (an outside photographer, for example)') || '').trim();
  if (!n) { sel.value = sel.dataset.was || ''; return null; }
  // A name already in the list (in any case) is that person, not a second spelling of them.
  const known = [...sel.options].find(o => o.value !== OTHER && o.value && sameName(o.value, n));
  if (!known) sel.querySelector('option[value="' + OTHER + '"]').insertAdjacentHTML('beforebegin', `<option value="${esc(n)}">${esc(n)}</option>`);
  sel.value = known ? known.value : n;
  return sel.value;
}
function setShooter(id, sel) {
  const who = pickedShooter(sel);
  if (who === null) return;
  sel.dataset.was = who;
  mutate(id, x => { x.shootAssigneeEmail = shooterEmail(x, who); x.shootAssignee = who; },
    who ? `Shoot assigned to <b>${esc(who)}</b>` : 'Shoot unassigned');
  if (currentDetailId === id) openDetail(id);
}
window.setShooter = setShooter;

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
  // A button or link inside the card (Book →, Preview) does its own thing on Enter.
  if (e.target !== e.currentTarget) return;
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
  markReached(x, key, now);
  // Moved BACK into Shoot done by a person: held there — it does not jump forward again on its own.
  const fromStep = P.ladderIndex(P.stageKeyOf(from)), toStep = P.ladderIndex(key);
  x.heldBack = key === 'shoot_done' && fromStep > toStep;
  x.heldGap = x.heldBack && mediaGaps(x).length > 0;
  if (kind === 'lost') x.dropReason = opts.reason || null;
  else x.dropReason = null;
  if (kind === 'hold') { x.holdReason = opts.reason || null; x.holdUntil = opts.until || null; }
  else { x.holdReason = null; x.holdUntil = null; }
  x.updatedAt = now;
  x.updatedBy = currentUserEmail || null;
  persist(x);
  applyFilters();
  if (currentDetailId === id) openDetail(id);
  // Moved into Media ready by hand with things still open: say so, rather than let the column lie.
  const gaps = key === 'media_ready' ? mediaGaps(x) : [];
  toast(gaps.length ? `Moved to ${to.name} — still missing: ${gaps.join(', ')}` : `Moved to ${to.name}`);
  // "Shoot scheduled" without a date is not scheduled: ask for the date and who goes, right away.
  if (key === 'shoot_scheduled' && !x.shootAt) openShootModal(id);
  // Brought into Shoot done with everything already in hand (forward, or back from On hold): on to
  // Media ready. Moved back from further on, it is held (above).
  if (key === 'shoot_done') promoteIfMediaReady(x);
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
// ═══════ WHOSE PHONE IS THIS ═══════
// A shoot agent and a handler want opposite things from the same data. The
// handler plans everyone's week and lives on the board. The agent is on a
// scooter with three properties to reach and wants one question answered:
// where am I going next.
//
// Saying "this is me" once flips the whole page for them — they land on their
// own day instead of a ten-column board they have no use for, the board and
// list chrome goes away, and the run sheet becomes the point of the app. It
// is a device-level choice, not an account one, because the shoot phone is
// the shoot phone.
let myAgent = '';
try { myAgent = localStorage.getItem('track.me') || ''; } catch (e) {}
let agentFilter = myAgent;
try { if (!myAgent) agentFilter = localStorage.getItem('track.agent') || ''; } catch (e) {}

function setAgentFilter(v) {
  agentFilter = v || '';
  try { localStorage.setItem('track.agent', agentFilter); } catch (e) {}
  renderShoots();
}
function setMyAgent(v) {
  myAgent = v || '';
  agentFilter = myAgent;
  try { localStorage.setItem('track.me', myAgent); localStorage.setItem('track.agent', myAgent); } catch (e) {}
  document.body.classList.toggle('agent-mode', !!myAgent);
  if (myAgent) toggleView('shoots'); else renderShoots();
  toast(myAgent ? `Your day, ${myAgent}` : 'Back to the full board');
}
window.setAgentFilter = setAgentFilter; window.setMyAgent = setMyAgent;

function renderShoots() {
  const el = document.getElementById('shootsView');
  if (!el) return;
  // A media person's shoots: by name, and by their email when the name was ever spelled differently.
  const fEmail = agentFilter ? emailOfShooter(agentFilter) : '';
  const mine = x => !agentFilter || sameName(x.shootAssignee, agentFilter) || (!!fEmail && x.shootAssigneeEmail === fEmail);
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
    ${dayHeaderHtml(groups[1][1], groups[0][1], groups[2][1])}

    ${agents.length ? `<div class="tk-agentbar">
      <span class="tk-lab">Whose day</span>
      <button type="button" class="tk-sbtn${!agentFilter ? ' on' : ''}" onclick="setAgentFilter('')">Everyone</button>
      ${agents.map(a => `<button type="button" class="tk-sbtn${sameName(agentFilter, a) ? ' on' : ''}" onclick="setAgentFilter(${jsq(a)})">${esc(a)}</button>`).join('')}
      ${myAgent
        ? `<button type="button" class="tk-link" onclick="setMyAgent('')">not ${esc(myAgent)}?</button>`
        : (agentFilter ? `<button type="button" class="tk-link" onclick="setMyAgent(${jsq(agentFilter)})">this is me — open here every time</button>` : '')}
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

// The top of the run sheet answers the only question an agent has on the
// move: where am I going next, and how do I get there — as two taps, before
// any list. Everything else on this page is for planning; this is for doing.
function dayHeaderHtml(today, missed, upcoming) {
  const doneToday = today.filter(x => x.shootDoneAt).length;
  const who = agentFilter ? esc(agentFilter) : 'the team';
  // "Next up" is the next thing still to do, wherever it falls. Checking the
  // phone at nine at night must not show an empty header just because
  // midnight has passed — tomorrow's first job is the answer to the question
  // being asked. Missed work outranks it: an agent should see the one they
  // did not get to before being sent somewhere new.
  const next = missed.find(x => !x.shootDoneAt)
    || today.find(x => !x.shootDoneAt)
    || (upcoming || []).find(x => !x.shootDoneAt)
    || null;
  if (!today.length && !missed.length && !next) return '';
  const contact = next && (next.siteContact || next.sellerPhone);
  const map = next && mapHref(next);
  const sameDay = next && new Date(next.shootAt).toDateString() === new Date().toDateString();
  const isMissed = next && next.shootAt < Date.now();
  const when = next
    ? (sameDay ? new Date(next.shootAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
               : fmtDateTime(next.shootAt))
    : '';
  return `<div class="tk-day">
    <div class="tk-day-top">
      <span class="tk-day-t">${today.length ? `${today.length} shoot${today.length === 1 ? '' : 's'} today` : 'Nothing booked today'}${doneToday ? ` · ${doneToday} done` : ''}</span>
      <span class="tk-day-s">${myAgent ? esc(myAgent) : who}${missed.length ? ` · <b class="bad">${missed.length} missed</b>` : ''}</span>
    </div>
    ${next ? `<div class="tk-next${isMissed ? ' missed' : ''}">
      <div class="tk-next-lab">${isMissed ? 'Missed · ' : 'Next up · '}${esc(when)}</div>
      <div class="tk-next-nm">${esc(next.title || next.propertyCode || 'Untitled')}</div>
      <div class="tk-next-ad">${next.address ? esc(next.address) : '<span class="tk-miss">No address on this one</span>'}</div>
      <div class="tk-next-acts">
        ${contact ? `<a class="tk-btn primary big" href="tel:${esc(telOf(contact))}">📞 Call</a>` : ''}
        ${map ? `<a class="tk-btn big" href="${esc(map)}" target="_blank" rel="noopener">🧭 Directions</a>` : ''}
        <button type="button" class="tk-btn big" onclick="openWrapModal('${next.id}')">✓ Done</button>
      </div>
    </div>` : (today.length ? '<div class="tk-day-done">Everything booked for today is done.</div>' : '')}
  </div>`;
}

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
// ═══════ SELLERS ═══════
//
// Every seller's property on one page, as tiles: who (name, number) first, then the property
// (area, configuration, size, price, sale or rent), then the rest (when they came in, from where,
// where the card stands, when they last wrote). Filters and sorts are remembered on the device.
//
// The property facts come, in order of trust: the card's own fields (edited on the board), the
// facts the TailorTalk sync read from the seller's own messages (lead.tt.facts), and — for a
// seller typed in by hand — the same reader run over their note, interest and price here.
const SELLER_PREFS_KEY = 'tkSellerPrefs';
const SELLER_DEFAULTS = { deal: 'all', type: 'all', stage: 'all', area: 'all', intake: 'all', missing: false, sort: 'newest' };
let sellerPrefs = (() => {
  try { return { ...SELLER_DEFAULTS, ...(JSON.parse(localStorage.getItem(SELLER_PREFS_KEY) || '{}')) }; }
  catch (e) { return { ...SELLER_DEFAULTS }; }
})();
function setSellerPref(k, v) {
  sellerPrefs = { ...sellerPrefs, [k]: v };
  try { localStorage.setItem(SELLER_PREFS_KEY, JSON.stringify(sellerPrefs)); } catch (e) { /* this visit only */ }
  renderSellers();
}
function clearSellerPrefs() { sellerPrefs = { ...SELLER_DEFAULTS, sort: sellerPrefs.sort }; setSellerPref('sort', sellerPrefs.sort); }
window.setSellerPref = setSellerPref; window.clearSellerPrefs = clearSellerPrefs;

const areaOf = s => {
  const a = String(s || '').split(/[,/|(]| - /)[0].trim();
  return a ? a.replace(/\b\w/g, c => c.toUpperCase()) : '';
};
const SELLER_CHANNELS = { whatsapp: 'WhatsApp', instagram: 'Instagram', website: 'Website chat' };

function sellerItem(x) {
  const lead = x.leadId ? leadById(x.leadId) : null;
  const fromChat = (lead && lead.tt && lead.tt.facts) || null;
  const typed = extractPropertyFacts([lead && lead.lastNote && lead.lastNote.text, lead && lead.propertyInterest, lead && lead.budget, x.title, x.config, x.askingPrice, x.remarks, x.lastNote && x.lastNote.text].filter(Boolean));
  const f = {
    deal: (fromChat && fromChat.deal) || typed.deal,
    type: (fromChat && fromChat.type) || typed.type,
    config: x.config || (fromChat && fromChat.config) || typed.config,
    sizes: ((fromChat && fromChat.sizes && fromChat.sizes.length) ? fromChat.sizes : typed.sizes) || [],
    price: x.askingPrice || (fromChat && fromChat.price) || typed.price,
    priceValue: (x.askingPrice ? extractPropertyFacts(x.askingPrice).priceValue : null) || (fromChat && fromChat.priceValue) || typed.priceValue || 0
  };
  const locality = x.location || (lead && lead.propertyInterest) || '';
  const intake = (lead && (lead.createdAt || (lead.tt && lead.tt.createdAt))) || x.createdAt || 0;
  const channel = lead && (lead.channel || (lead.tt && lead.tt.integration)) || '';
  return {
    x, lead, f, locality, area: areaOf(locality), intake,
    name: (lead && lead.name) || x.sellerName || x.title || 'Unnamed seller',
    phone: x.sellerPhone || (lead && lead.phone) || '',
    channel: SELLER_CHANNELS[String(channel).toLowerCase()] || (lead ? (lead.tt ? 'TailorTalk' : 'Added in CRM') : 'Added on the board'),
    lastMsg: lead && lead.tt ? lead.tt.lastMessageAt : null,
    stage: stageById(x.stageId),
    missing: [!locality && 'area', !f.config && 'configuration', !f.sizes.length && 'size', !f.price && 'price'].filter(Boolean)
  };
}

function sellerSort(items) {
  const st = id => stages.findIndex(s => s.id === id);
  const by = {
    newest: (a, b) => b.intake - a.intake,
    oldest: (a, b) => a.intake - b.intake,
    priceHigh: (a, b) => (b.f.priceValue || -1) - (a.f.priceValue || -1),
    priceLow: (a, b) => (a.f.priceValue || Infinity) - (b.f.priceValue || Infinity),
    sizeHigh: (a, b) => sortSize(b.f) - sortSize(a.f),
    name: (a, b) => a.name.localeCompare(b.name),
    stage: (a, b) => st(a.x.stageId) - st(b.x.stageId) || b.intake - a.intake,
    lastMsg: (a, b) => (b.lastMsg || 0) - (a.lastMsg || 0)
  }[sellerPrefs.sort] || ((a, b) => b.intake - a.intake);
  return items.slice().sort(by);
}

function sellerTile(it) {
  const { x, f } = it;
  const wa = telOf(it.phone).replace(/^\+/, '');
  const chips = factChips(f, 3);
  const m = mediaProgress(x);
  const stage = it.stage;
  return `<div class="sl-tile" role="button" tabindex="0" onclick="openDetail('${x.id}')" onkeydown="if(event.key==='Enter')openDetail('${x.id}')">
    <div class="sl-head">
      <div class="sl-who">
        <div class="sl-name">${esc(it.name)}</div>
        ${it.phone ? `<div class="sl-phone"><a href="tel:${esc(telOf(it.phone))}" onclick="event.stopPropagation()">${esc(it.phone)}</a>${wa ? ` · <a href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">WhatsApp</a>` : ''}</div>` : '<div class="sl-phone none">No number</div>'}
      </div>
      ${stage ? `<span class="sl-stage" style="--sc:${esc(stage.color || '#888')}">${esc(stage.name)}</span>` : ''}
    </div>
    <div class="sl-prop">
      <div class="sl-loc">${it.locality ? '📍 ' + esc(it.locality) : '<span class="sl-none">Area not given</span>'}</div>
      ${chips ? `<div class="sl-chips">${chips}</div>` : ''}
      ${it.missing.length ? `<div class="sl-miss">Missing: ${esc(it.missing.join(', '))}</div>` : ''}
    </div>
    <div class="sl-meta">
      <span title="${esc(it.intake ? new Date(it.intake).toLocaleString() : '')}">Came in ${esc(it.intake ? fmtDateTime(it.intake) : '—')}${it.intake ? ' · ' + esc(timeAgo(it.intake)) : ''}</span>
      <span>${esc(it.channel)}</span>
      ${it.lastMsg ? `<span>Last message ${esc(timeAgo(it.lastMsg))}</span>` : ''}
      ${x.propertyCode ? `<span class="tk-code">${esc(x.propertyCode)}</span>` : ''}
      ${m.total ? `<span>Media ${m.done}/${m.total}</span>` : ''}
    </div>
    ${it.lead ? `<div class="sl-acts"><a class="tk-btn ghost sm" href="${esc(crmLeadHref(it.lead.id, x.id))}" onclick="event.stopPropagation()">Open lead</a></div>` : ''}
  </div>`;
}

function renderSellers() {
  const el = document.getElementById('sellersView');
  if (!el) return;
  const now = Date.now();
  const all = listings.map(sellerItem);
  const q = currentSearch;
  const startOfToday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const since = { today: startOfToday, '7': now - 7 * DAY, '30': now - 30 * DAY }[sellerPrefs.intake] || 0;
  const p = sellerPrefs;
  const shown = sellerSort(all.filter(it => {
    if (p.deal !== 'all' && it.f.deal !== p.deal) return false;
    if (p.type !== 'all' && it.f.type !== p.type) return false;
    if (p.stage !== 'all' && it.x.stageId !== p.stage) return false;
    if (p.area !== 'all' && it.area !== p.area) return false;
    if (since && !(it.intake >= since)) return false;
    if (p.missing && !it.missing.length) return false;
    if (q) {
      const hay = [it.name, it.phone, it.locality, it.x.propertyCode, it.x.title, it.f.config, it.f.price].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }));

  const count = fn => all.filter(fn).length;
  const areas = [...new Set(all.map(it => it.area).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const opt = (v, label, cur) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(label)}</option>`;
  const sel = (key, label, options) => `<label class="sl-f"><span>${esc(label)}</span><select onchange="setSellerPref('${key}', this.value)">${options}</select></label>`;
  const filtersOn = ['deal', 'type', 'stage', 'area', 'intake'].some(k => p[k] !== 'all') || p.missing;

  const missing = unlistedSellers();
  const aside = skippedSellers();
  el.innerHTML = `
    <div class="sl-summary">
      <div class="sl-stat"><b>${all.length}</b><span>Sellers</span></div>
      <div class="sl-stat"><b>${count(it => it.intake >= now - 7 * DAY)}</b><span>New this week</span></div>
      <div class="sl-stat"><b>${count(it => it.f.deal === 'sale')}</b><span>For sale</span></div>
      <div class="sl-stat"><b>${count(it => it.f.deal === 'rent')}</b><span>For rent</span></div>
      <div class="sl-stat warn"><b>${count(it => it.missing.length)}</b><span>Missing details</span></div>
    </div>
    <div class="sl-tools">
      ${sel('deal', 'Sale / rent', opt('all', 'All', p.deal) + opt('sale', 'For sale', p.deal) + opt('rent', 'For rent', p.deal))}
      ${sel('type', 'Type', opt('all', 'All types', p.type) + Object.entries(TYPE_LABELS).map(([k, v]) => opt(k, v, p.type)).join(''))}
      ${sel('area', 'Area', opt('all', 'All areas', p.area) + areas.map(a => opt(a, a, p.area)).join(''))}
      ${sel('stage', 'Stage', opt('all', 'All stages', p.stage) + stages.map(st => opt(st.id, st.name, p.stage)).join(''))}
      ${sel('intake', 'Came in', opt('all', 'Any time', p.intake) + opt('today', 'Today', p.intake) + opt('7', 'Last 7 days', p.intake) + opt('30', 'Last 30 days', p.intake))}
      <label class="sl-f check"><input type="checkbox" ${p.missing ? 'checked' : ''} onchange="setSellerPref('missing', this.checked)"><span>Missing details</span></label>
      ${sel('sort', 'Sort', opt('newest', 'Newest first', p.sort) + opt('oldest', 'Oldest first', p.sort) + opt('lastMsg', 'Last message', p.sort)
        + opt('priceHigh', 'Price: high to low', p.sort) + opt('priceLow', 'Price: low to high', p.sort) + opt('sizeHigh', 'Size: largest first', p.sort)
        + opt('stage', 'Stage', p.sort) + opt('name', 'Name A–Z', p.sort))}
      ${filtersOn ? `<button type="button" class="tk-btn ghost sm" onclick="clearSellerPrefs()">Clear filters</button>` : ''}
    </div>
    <div class="sl-count">${shown.length === all.length ? `${all.length} seller${all.length === 1 ? '' : 's'}` : `${shown.length} of ${all.length} sellers`}</div>
    ${shown.length ? `<div class="sl-grid">${shown.map(sellerTile).join('')}</div>`
      : `<div class="tk-empty"><div class="tk-empty-i">🔎</div><div class="tk-empty-t">No seller matches</div><div class="tk-empty-s">Try clearing a filter.</div></div>`}
    ${missing.length ? `
      <div class="tk-group">
        <div class="tk-group-hdr warn">Waiting to be added <span class="tk-count">${missing.length}</span></div>
        <div class="tk-hint" style="margin:-4px 0 9px">These appear for a moment before the sync picks them up. If one stays here, something is blocking the write.</div>
        <div class="tk-rows">${missing.map(l => sellerRow(l, 'pending')).join('')}</div>
      </div>` : ''}
    ${aside.length ? `
      <details class="tk-group">
        <summary class="tk-group-hdr">Set aside <span class="tk-count">${aside.length}</span></summary>
        <div class="tk-hint" style="margin:4px 0 9px">Deliberately not tracked — a deleted card or a skip. They are never re-added on their own.</div>
        <div class="tk-rows">${aside.map(l => sellerRow(l, 'aside')).join('')}</div>
      </details>` : ''}`;
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
// The top of the detail page answers what a person opening it asks first, all in one card:
// who (name, number), what property (area, sale/rent, type, configuration, size, price), whose
// it is (agent), where it stands (stage, days there) and when it came in and was last touched.
function summaryHtml(x, lead, stage) {
  const it = sellerItem(x);
  const wa = telOf(it.phone).replace(/^\+/, '');
  const chips = factChips(it.f, 4);
  const agents = agentsOf(it);
  const age = P.stageAge(x, stages, Date.now());
  const when = ts => ts ? `${esc(fmtDateTime(ts))}<span class="tk-sum-sub">${esc(timeAgo(ts))}</span>` : '—';
  const by = personName(x.updatedBy);
  const rule = stage && P.stageDef(P.stageKeyOf(stage)) ? P.stageDef(P.stageKeyOf(stage)).rule : '';
  return `<div class="tk-sec tk-sum">
    <div class="tk-sum-head">
      <div class="tk-sum-who">
        <div class="tk-sum-name">${esc(it.name)}</div>
        <div class="sl-phone">${it.phone ? `<a href="tel:${esc(telOf(it.phone))}">${esc(it.phone)}</a>${wa ? ` · <a href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}` : '<span class="none">No number</span>'}
          ${lead ? ` · <span class="tk-sum-ch">${esc(it.channel)}</span>` : ''}</div>
      </div>
      <div class="tk-sum-acts">
        ${lead ? `<button class="tk-btn sm" onclick="openSellerPreview('${x.id}')">Preview</button>
          <a class="tk-btn ghost sm" href="${esc(crmLeadHref(lead.id, x.id))}">Open in CRM →</a>`
          : `<button class="tk-btn sm" onclick="openLinkLead('${x.id}')">Link a CRM lead</button>`}
      </div>
    </div>
    <div class="tk-sum-prop">
      <div class="sl-loc">${it.locality ? '📍 ' + esc(it.locality) : '<span class="sl-none">Area not given</span>'}</div>
      ${chips ? `<div class="sl-chips">${chips}</div>` : ''}
      ${it.missing.length ? `<div class="sl-miss">Missing: ${esc(it.missing.join(', '))} — add it with Edit details at the bottom</div>` : ''}
    </div>
    <div class="tk-sum-tags"><span class="tk-sum-k">Tags</span>${window.tagEditorHtml ? window.tagEditorHtml('l:' + x.id, x.tags) : tagChips(x.tags)}</div>
    <div class="tk-sum-grid">
      <div class="tk-sum-f"><span>Agent</span><b class="${agents.length ? '' : 'none'}">👤 ${agents.length ? esc(agents.map(personName).join(' + ')) : 'Unassigned'}</b>${lead ? '<span class="tk-sum-sub">set on the CRM lead</span>' : ''}</div>
      <div class="tk-sum-f stage"><span>Stage</span>
        <select class="tk-sel sm" aria-label="Stage" onchange="changeStage('${x.id}', this.value)">
          ${stages.map(s => `<option value="${s.id}"${s.id === x.stageId ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
        <span class="tk-sum-sub${age.farOver ? ' bad' : age.over ? ' warn' : ''}">${age.days === 0 ? 'moved here today' : age.days + (age.days === 1 ? ' day' : ' days') + ' in this stage'}${age.target ? ' · aim ' + age.target + 'd' : ''}</span></div>
      <div class="tk-sum-f"><span>Created</span><b>${when(it.intake)}</b></div>
      <div class="tk-sum-f"><span>Last updated</span><b>${when(x.updatedAt)}</b>${by ? `<span class="tk-sum-sub">by ${esc(by)}</span>` : ''}</div>
    </div>
    ${rule ? `<div class="tk-hint">${esc(stage.name)}: ${esc(rule)}</div>` : ''}
    ${x.dropReason ? `<div class="tk-hint bad">Dropped — ${esc(P.DROP_REASONS[x.dropReason] || x.dropReason)}</div>` : ''}
    ${x.holdReason ? `<div class="tk-hint warn">On hold — ${esc(P.HOLD_REASONS[x.holdReason] || x.holdReason)}${x.holdUntil ? ', until ' + esc(fmtDate(x.holdUntil)) : ''}</div>` : ''}
  </div>`;
}

function openDetail(id) {
  const x = listings.find(l => l.id === id);
  if (!x) return;
  // Redrawing the same listing (a tick, a save) keeps what was open and what was half-typed.
  const same = currentDetailId === id && document.getElementById('dp').classList.contains('open');
  const keep = same ? { buyers: !!document.getElementById('dpBuyers')?.open, note: document.getElementById('dpNoteText')?.value || '' } : null;
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
    <div class="tk-dp-main">
    ${summaryHtml(x, lead, stage)}

    <div class="tk-sec">
      <div class="tk-sec-hdr">Inventory</div>
      <div class="tk-kv"><span>Property ID</span>${x.propertyCode ? `<b>${esc(x.propertyCode)}</b>` : '<i>not mapped</i>'}</div>
      <button class="tk-btn" onclick="openMapProperty('${x.id}')">${x.propertyCode ? 'Change or remove mapping' : 'Map to a property'}</button>
      ${x.propertyCode ? `<a class="tk-btn ghost" href="dashboard.html?property=${encodeURIComponent(x.propertyCode)}" target="_blank" rel="noopener" title="The full record: notes, internal notes, matching buyers">Open property →</a>` : ''}
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
      <div class="tk-kv"><span>When</span>${x.shootAt
        ? `<b>${esc(fmtDateTime(x.shootAt))} <span class="tk-rel">${esc(relDays(x.shootAt))}</span></b>`
        : `<button type="button" class="tk-link" onclick="openShootModal('${x.id}')">Pick a date →</button>`}</div>
      <div class="tk-kv tk-pickrow"><span>Assigned to</span>
        <select class="tk-sel sm" aria-label="Shoot assigned to" data-was="${esc(shownShooter(x.shootAssignee))}" onchange="setShooter('${x.id}', this)">${shooterOptions(x.shootAssignee)}</select></div>
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

    <div class="tk-sec" id="dpFor">
      <div class="tk-sec-hdr">Shoot for</div>
      <div class="tk-hint" style="margin:-3px 0 9px">Where this shoot is going. For each: planned, made, and its voice over — with V/O, or V/O required separately.</div>
      ${legacyVoice(x) ? `<div class="tk-hint warn tk-for-legacy">Set before for the whole shoot: <b>voice-over separately</b>${x.voDone ? ' (made)' : ''}. Pick the voice for each one below.</div>` : ''}
      <div class="tk-brief tk-forgrid">
        <div class="tk-brief-hd"><span></span><span>Planned</span><span>Done</span><span>Voice over</span><span>VO made</span></div>
        ${FOR_KEYS.map(([k, label]) => {
          const plan = forPlanned(x, k), done = forMade(x, k), v = forVoice(x, k), vo = forVoMade(x, k);
          const voLeft = plan && v === 'vo' && !vo;
          return `<div class="tk-brief-r${(plan && !done) || voLeft ? ' open' : ''}${plan ? '' : ' np'}">
            <span><i class="${FOR_ICON[k]} tk-for-i tk-for-${k}" aria-hidden="true"></i> ${esc(label)}</span>
            <span><input type="checkbox" ${plan ? 'checked' : ''} onchange="setForPlan('${x.id}','${k}',this.checked)" aria-label="${esc(label)} planned"></span>
            <span><input type="checkbox" ${done ? 'checked' : ''} ${!plan ? 'class="dim"' : ''} onchange="setForDone('${x.id}','${k}',this.checked)" aria-label="${esc(label)} done"></span>
            <span class="tk-for-v">${plan ? `<select class="tk-sel sm" aria-label="${esc(label)} voice" onchange="setForVoice('${x.id}','${k}',this.value)">
                <option value=""${!v ? ' selected' : ''}>–</option>
                <option value="live"${v === 'live' ? ' selected' : ''}>With V/O</option>
                <option value="vo"${v === 'vo' ? ' selected' : ''}>V/O Reqd. separately</option>
              </select>` : '<span class="tk-muted">—</span>'}</span>
            <span class="tk-for-vo">${v === 'vo' && plan ? `<label><input type="checkbox" ${vo ? 'checked' : ''} onchange="setForVo('${x.id}','${k}',this.checked)" aria-label="${esc(label)} voice-over made"><em class="tk-m"> VO made</em></label>` : '<span class="tk-muted">—</span>'}</span>
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

    <details class="tk-sec tk-fold" id="dpBuyers" ontoggle="if (this.open) openWaitingBuyers('${x.id}')">
      <summary class="tk-sec-hdr"><span>Who is already waiting for this</span><span class="tk-fold-act">Show</span></summary>
      <div class="tk-hint" style="margin:6px 0 9px">Scored against every buyer in the CRM — before the shoot, not after.
        A property three people are waiting for is worth photographing today.</div>
      <div id="dpBuyersList"></div>
    </details>

    <div class="tk-sec tk-danger">
      <button class="tk-btn" onclick="openEditModal('${x.id}')">Edit details</button>
      <button class="tk-btn danger" onclick="deleteListing('${x.id}')">Delete listing</button>
    </div>
    </div>

    <aside class="tk-dp-side">
      <div class="tk-sec tk-notes-sec">
        <div class="tk-sec-hdr">Notes <span class="tk-count" id="dpNoteCount"></span></div>
        <div class="tk-note-add">
          <textarea id="dpNoteText" class="tk-area" rows="3" placeholder="What happened, what the owner said, what the next person needs to know…"
            onkeydown="if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();addNote('${x.id}')}"></textarea>
          <div class="tk-note-bar"><span class="tk-hint">Ctrl + Enter to add</span><button type="button" class="tk-btn primary sm" onclick="addNote('${x.id}')">Add note</button></div>
        </div>
        <div id="dpNotes" class="tk-notes"><div class="tk-hint">Loading…</div></div>
      </div>
      ${window.bpPanelHtml ? window.bpPanelHtml(x) : ''}
      <div class="tk-sec">
        <div class="tk-sec-hdr">Timeline</div>
        <div id="dpHistory" class="tk-hist"><div class="tk-hint">Loading…</div></div>
      </div>
    </aside>`;

  document.getElementById('dp').classList.add('open');
  if (keep) {
    if (keep.note) document.getElementById('dpNoteText').value = keep.note;
    if (keep.buyers) document.getElementById('dpBuyers').open = true;   // its toggle event re-fills the list
  }
  loadHistory(x.id);
  // "Who is already waiting" is folded shut; buyers are scored only when it is opened.
  // The brochure panel reads the inventory; make sure it is there, then redraw once if it arrived late.
  if (!inventory) loadInventory().then(() => { if (currentDetailId === x.id) { const s = document.getElementById('bpSec'); if (s && window.bpPanelHtml) s.outerHTML = window.bpPanelHtml(listings.find(l => l.id === x.id) || x); } });
  // A card opened from anywhere is addressable — copy the URL and it reopens.
  try {
    const u = new URL(location.href);
    u.searchParams.set('listing', x.id);
    history.replaceState(null, '', u.pathname + u.search);
  } catch (e) {}
}
window.openDetail = openDetail;

// ═══════ WHO IS ALREADY WAITING ═══════
//
// The question this board exists to answer earlier than anyone else can: a
// shoot costs money and a day, so which listing is worth doing first? The
// answer is how many buyers are already waiting for it — and that is knowable
// the moment the owner says yes, long before there are photos, a brochure or
// an inventory row.
//
// Everything needed is already on this page: `leads` is the live lead set the
// board keeps for its Sellers view, and the matcher can profile a LISTING
// rather than an inventory property (PinMatch.listingProfile), folding in the
// owner's own TailorTalk conversation — which for a brand-new listing is
// usually the only description of the property that exists anywhere.
// Opened by hand: score the buyers then (once per opening of the listing).
function openWaitingBuyers(id) {
  const x = listings.find(l => l.id === id);
  const el = document.getElementById('dpBuyersList');
  if (!x || !el || el.dataset.done === id) return;
  el.dataset.done = id;
  renderWaitingBuyers(x, x.leadId ? leadById(x.leadId) : null);
}
window.openWaitingBuyers = openWaitingBuyers;
function renderWaitingBuyers(x, lead) {
  const el = document.getElementById('dpBuyersList');
  if (!el || !window.PinMatch || !window.PinMatchPanel) return;

  const prof = window.PinMatch.listingProfile(x, { lead });
  // Nothing to score against. Name the two fields that would fix it, because
  // the person reading this is the one who can.
  if (!prof.localities.length && prof.priceLo == null && !prof.bhk.length) {
    el.classList.add('pm');
    el.innerHTML = '<div class="pm-empty">Not enough on this listing yet to match anyone.'
      + ' Add a <b>Location</b>, <b>Configuration</b> or <b>Asking price</b> and every buyer in the CRM'
      + ' will be scored against it.</div>';
    return;
  }

  window.PinMatchPanel.busy(el, 'Scoring every buyer in the CRM against this listing…');
  // The inventory is what the area model and the IDF corpus are built from,
  // and it is fetched lazily on this board. The listing itself is passed to
  // the model as `extra` inside buyersFor, so a brand-new area is placed the
  // day its first listing is created.
  loadInventory().then(inv => {
    if (currentDetailId !== x.id) return;
    const matches = window.PinMatch.buyersFor(prof, leads, {
      inventory: inv,
      includeVetoed: true,
      minPct: 40,
      limit: 30
    });
    const live = matches.filter(m => !m.vetoed).length;
    window.PinMatchPanel.render(el, matches, {
      title: live === 0 ? 'Nobody is waiting for this yet'
        : live === 1 ? '1 buyer is already waiting' : `${live} buyers are already waiting`,
      subtitle: prof.provisional ? 'scored on the listing alone — it is not in the inventory yet' : '',
      empty: 'No buyer on the CRM is looking for anything like this yet.'
        + ' That is worth knowing before the shoot, not after it.',
      shape: m => ({
        name: m.lead.name || '(no name)',
        sub: [m.lead.propertyInterest, m.lead.budget ? 'budget ' + m.lead.budget : ''].filter(Boolean).join(' · '),
        actions: [
          { id: 'crm', key: m.lead.id, label: 'Open in CRM →', href: crmLeadHref(m.lead.id, x.id), primary: true },
          m.lead.phone ? { id: 'call', key: m.lead.id, label: 'Call', href: 'tel:' + telOf(m.lead.phone) } : null
        ].filter(Boolean)
      })
    });
  }).catch(e => {
    // Without this the panel stayed on "Scoring every buyer…" for ever.
    console.error('Buyer matching failed:', e);
    if (currentDetailId === x.id) el.innerHTML = '<div class="tk-hint">Could not score the buyers just now — close and reopen the listing to try again.</div>';
  });
}

// Reuses loadInventory() further down this file — the same TTL-cached read
// the map-to-property picker uses. A second loader here would mean two
// caches of one collection disagreeing about what the inventory contains.

// ═══════ SELLER PREVIEW ═══════
// The owner and their property without leaving the board, and one click to the
// CRM record. Closing it puts you back exactly where you were, which is the whole
// point — checking a detail should not cost your place.
function openSellerPreview(listingId) {
  const x = listings.find(l => l.id === listingId);
  if (!x) return;
  const el = document.getElementById('sellerPrev');
  if (!el) return;
  // The property, read the way the board tile reads it — who, where, what, how big, how much.
  // The owner's conversation lives in the CRM (one click below); it is not repeated here.
  const it = sellerItem(x);
  const lead = it.lead;
  const wa = telOf(it.phone).replace(/^\+/, '');
  const chips = factChips(it.f, 4);
  el.querySelector('.tk-prev-body').innerHTML = `
    <div class="tk-prev-head">
      <span class="tk-ava lg">${esc(initials(it.name))}</span>
      <div>
        <div class="tk-prev-nm">${esc(it.name)}</div>
        <div class="tk-prev-sub">${esc([it.phone, it.channel].filter(Boolean).join(' · '))}</div>
      </div>
    </div>
    <div class="tk-prev-actions">
      ${it.phone ? `<a class="tk-btn primary" href="tel:${esc(telOf(it.phone))}">Call</a>` : ''}
      ${wa ? `<a class="tk-btn" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
    </div>
    <div class="tk-prev-prop">
      <div class="sl-loc">${it.locality ? '📍 ' + esc(it.locality) : '<span class="sl-none">Area not given</span>'}${codeChip(x)}</div>
      ${chips ? `<div class="sl-chips">${chips}</div>` : ''}
      ${it.missing.length ? `<div class="sl-miss">Missing: ${esc(it.missing.join(', '))}</div>` : ''}
      ${x.description ? `<div class="tk-prev-desc">${esc(x.description)}</div>` : ''}
    </div>
    <div class="tk-btnrow">
      ${lead ? `<a class="tk-btn primary" href="${esc(crmLeadHref(lead.id, listingId))}">Open in CRM →</a>` : ''}
      <button class="tk-btn ghost" onclick="openDetail('${x.id}');closeSellerPreview()">Open the listing</button>
    </div>`;
  el.classList.add('open');
}
function closeSellerPreview() { document.getElementById('sellerPrev')?.classList.remove('open'); }
window.openSellerPreview = openSellerPreview; window.closeSellerPreview = closeSellerPreview;

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
  // "Loading…" used to stay for ever when the read failed or the store was not ready.
  const failed = () => { const el = document.getElementById('dpHistory'); if (el && currentDetailId === id) el.innerHTML = '<div class="tk-hint">Could not load the timeline — close and reopen the listing to try again.</div>'; };
  if (!window.trackFirebase) { failed(); return; }
  window.trackFirebase.getListingHistory(id).then(list => {
    histCache.set(id, list);
    if (currentDetailId !== id) return;
    paintHistory(id);
  }).catch(e => { console.error('History load failed:', e); failed(); });
}
// Notes and the timeline share one subcollection: a note is an entry of type 'note', written by
// a person, kept as plain text. Everything else is the timeline the board writes itself.
const histCache = new Map();
function paintHistory(id) {
  const list = histCache.get(id) || [];
  const x = listings.find(l => l.id === id);
  const notes = list.filter(h => h.type === 'note');
  const events = list.filter(h => h.type !== 'note');
  const nEl = document.getElementById('dpNotes');
  const hEl = document.getElementById('dpHistory');
  const cEl = document.getElementById('dpNoteCount');
  if (cEl) cEl.textContent = notes.length ? String(notes.length) : '';
  if (nEl) {
    // A remark from before notes existed, not yet moved into the log, is still shown.
    const legacy = x && x.remarks ? `<div class="tk-nt legacy"><div class="tk-nt-t">${esc(x.remarks)}</div><div class="tk-nt-m">Remarks (from before notes)</div></div>` : '';
    nEl.innerHTML = (notes.length || legacy)
      ? notes.map(n => `<div class="tk-nt">
          <div class="tk-nt-t">${esc(n.text)}</div>
          <div class="tk-nt-m"><b>${esc(personName(n.by) || 'Team')}</b> · <span title="${esc(n.at ? new Date(n.at).toLocaleString() : '')}">${esc(fmtDateTime(n.at))} · ${esc(timeAgo(n.at))}</span>
            <button type="button" class="tk-nt-del" onclick="deleteNote('${id}','${esc(n.id)}')" aria-label="Delete note" title="Delete note">Delete</button></div>
        </div>`).join('') + legacy
      : '<div class="tk-hint">No notes yet. Write what happened so the next person does not have to ask.</div>';
  }
  if (hEl) {
    hEl.innerHTML = events.length
      ? events.map(h => `<div class="tk-hist-i"><div class="tk-hist-t">${h.text}</div><div class="tk-hist-m">${esc(timeAgo(h.at))} · ${esc(String(h.by || '').split('@')[0])}</div></div>`).join('')
      : '<div class="tk-hint">Nothing yet.</div>';
  }
}
function latestNoteOf(list) {
  const n = list.filter(h => h.type === 'note').sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  return n ? { text: n.text, by: n.by, at: n.at } : null;
}
async function addNote(id) {
  const box = document.getElementById('dpNoteText');
  const text = String(box && box.value || '').trim();
  if (!text) { if (box) box.focus(); return; }
  const x = listings.find(l => l.id === id);
  if (!x || !window.trackFirebase) return;
  const entry = { id: newId('n'), type: 'note', text, at: Date.now(), by: currentUserEmail || 'team' };
  try { await window.trackFirebase.saveHistory(id, entry); }
  catch (e) { console.error('Note save failed:', e); toast('Could not save the note — check your connection'); return; }
  histCache.set(id, [entry, ...(histCache.get(id) || [])]);
  if (box) box.value = '';
  // The card shows the latest note and how many there are, without opening anything.
  mutate(id, o => { o.lastNote = { text, by: entry.by, at: entry.at }; o.noteCount = (o.noteCount || 0) + 1; });
  if (currentDetailId === id) paintHistory(id);
  toast('Note added');
}
async function deleteNote(id, noteId) {
  if (!confirm('Delete this note? It cannot be brought back.')) return;
  try { await window.trackFirebase.deleteHistory(id, noteId); }
  catch (e) { console.error('Note delete failed:', e); toast('Could not delete — check your connection'); return; }
  const list = (histCache.get(id) || []).filter(h => h.id !== noteId);
  histCache.set(id, list);
  mutate(id, o => { o.lastNote = latestNoteOf(list); o.noteCount = list.filter(h => h.type === 'note').length; });
  if (currentDetailId === id) paintHistory(id);
}
window.addNote = addNote; window.deleteNote = deleteNote;

// ── Small field writes from the detail panel ──
function mutate(id, fn, historyText) {
  const x = listings.find(l => l.id === id);
  if (!x) return null;
  const hadGaps = mediaGaps(x).length > 0;
  fn(x);
  forgetBrochures();
  x.updatedAt = Date.now();
  x.updatedBy = currentUserEmail || null;
  if (historyText) addHistory(x, 'field', historyText);
  // Held back by hand: a note or remark leaves it there; finishing something that was missing
  // since it was held releases it, and it moves on. heldGap remembers that something was missing,
  // because the brochure can turn up in the inventory before the edit that records it.
  if (x.heldBack) {
    const left = mediaGaps(x).length;
    if (left || hadGaps) x.heldGap = true;
    if (!left && x.heldGap) { x.heldBack = false; x.heldGap = false; }
  }
  // When this edit completes it, the move is saved together with it — one write, so another tab
  // never sees the edit without the move.
  if (!promoteIfMediaReady(x)) { persist(x); applyFilters(); }
  return x;
}
// The first time a listing reaches a milestone (listing.reached.{key}), kept for "how long from
// owner yes to live". Set on the object itself: saveListing writes it whole, and a dotted key
// such as "reached.live" would be stored as one literal field name.
function markReached(x, key, at) {
  // Listings saved by the older code carry it as a literal "reached.<key>" field: that date counts.
  const old = Number(x['reached.' + key]) || 0;
  if (P.reachedUpdate(x, key, at)) x.reached = { ...(x.reached || {}), [key]: old || at };
}
// Move a listing forward to a milestone without asking — used when its media is all ready.
// Never moves it back, never touches a listing on hold, dropped or closed.
function advanceTo(id, key, why) {
  const x = listings.find(l => l.id === id);
  const to = P.stageForKey(stages, key);
  if (!x || !to || x.stageId === to.id) return;
  if (stageKindOfId(x.stageId) !== 'open') return;
  const cur = P.ladderIndex(P.stageKeyOf(stageById(x.stageId)));
  if (cur < 0 || cur >= P.ladderIndex(key)) return;
  const now = Date.now(), from = stageById(x.stageId);
  addHistory(x, 'stage', `Moved from <b>${esc(from ? from.name : 'no column')}</b> to <b>${esc(to.name)}</b> — automatically${why ? ', ' + esc(why) : ''}`);
  x.prevStageId = x.stageId; x.stageId = to.id; x.stageChangedAt = now; x.stageChangedBy = 'automatic';
  markReached(x, key, now);
  x.updatedAt = now;
  x.updatedBy = currentUserEmail || null;
  persist(x);
  applyFilters();
}
// What the brochure panel (brochure-panel.js) needs from the board.
window.trackApi = {
  listings: () => listings,
  inventory: () => inventory,
  loadInventory: force => loadInventory(force),
  mutate: (id, fn, text) => mutate(id, fn, text),
  brochureOf: x => brochureOf(x),
  refreshFilters: () => renderFilterBar(),   // the Tags dropdown, after a tag is added or removed
  openDetail: id => openDetail(id),
  currentDetailId: () => currentDetailId,
  editingId: () => (mModalMode === 'edit' ? mModalEditId : null),
  user: () => currentUserEmail,
  toast: m => toast(m)
};
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

// ── Shoot for: each outlet this shoot is cut for — planned, done, and its voice ──
// The same outlets as the Posting tab, plus collabs. Voice is per outlet: a YouTube walkthrough
// is often shot with voice while the Reel gets a voice-over made separately, so "voice-over
// made" is ticked per outlet too.
const FOR_KEYS = [['igStory', 'Insta Story'], ['igReel', 'Insta Reel'], ['fbReel', 'FB Reel'], ['yt', 'YouTube'], ['collab', 'Collab']];
const FOR_ICON = { igStory: 'fa-brands fa-instagram', igReel: 'fa-brands fa-instagram', fbReel: 'fa-brands fa-facebook', yt: 'fa-brands fa-youtube', collab: 'fa-solid fa-handshake' };
const VOICE = { live: 'With V/O', vo: 'V/O Reqd. separately' };
const forLabel = key => (FOR_KEYS.find(k => k[0] === key) || [, key])[1];
// "Instagram" ticked before the outlets were split (shipped for a day) reads as the Reel, and the
// first edit of the section folds it in for good — so it can always be unticked.
const forPlanned = (x, k) => !!(x.forPlan && (x.forPlan[k] || (k === 'igReel' && x.forPlan.insta)));
const forMade = (x, k) => !!(x.forDone && (x.forDone[k] || (k === 'igReel' && x.forDone.insta)));
function foldInsta(x) {
  for (const f of ['forPlan', 'forDone']) if (x[f] && x[f].insta) x[f] = { ...x[f], igReel: true, insta: false };
}
const forVoice = (x, k) => (x.forVoice && VOICE[x.forVoice[k]]) ? x.forVoice[k] : '';
const forVoMade = (x, k) => !!(x.forVo && x.forVo[k]);
// The single whole-shoot voice from before (x.voice / x.voDone) still counts until voice is set
// per outlet; the first per-outlet choice retires it.
const legacyVoice = x => x.voice === 'vo' && !(x.forVoice && Object.values(x.forVoice).some(v => VOICE[v]));
function setForPlan(id, key, on) {
  mutate(id, x => {
    foldInsta(x);
    x.forPlan = { ...(x.forPlan || {}), [key]: !!on };
    // Not planned any more: its done, voice and voice-over go with it.
    if (!on) { x.forDone = { ...(x.forDone || {}), [key]: false }; x.forVoice = { ...(x.forVoice || {}), [key]: '' }; x.forVo = { ...(x.forVo || {}), [key]: false }; }
  }, `Shoot for ${forLabel(key)}: ${on ? 'planned' : 'not planned'}`);
  if (currentDetailId === id) openDetail(id);
}
function setForDone(id, key, on) {
  mutate(id, x => { foldInsta(x); x.forDone = { ...(x.forDone || {}), [key]: !!on }; if (on) x.forPlan = { ...(x.forPlan || {}), [key]: true }; }, `${forLabel(key)} cut: ${on ? 'done' : 'not done'}`);
  if (currentDetailId === id) openDetail(id);
}
function setForVoice(id, key, v) {
  const val = VOICE[v] ? v : '';
  mutate(id, x => {
    foldInsta(x);
    x.forVoice = { ...(x.forVoice || {}), [key]: val };
    if (val !== 'vo') x.forVo = { ...(x.forVo || {}), [key]: false };
    x.forPlan = { ...(x.forPlan || {}), [key]: true };
    if (val) { x.voice = ''; x.voDone = false; }   // the old whole-shoot setting is replaced
  }, `${forLabel(key)}: ${val ? VOICE[val] : 'voice over not set'}`);
  if (currentDetailId === id) openDetail(id);
}
function setForVo(id, key, on) {
  mutate(id, x => { foldInsta(x); x.forVo = { ...(x.forVo || {}), [key]: !!on }; }, `${forLabel(key)}: voice-over ${on ? 'made' : 'not made yet'}`);
  if (currentDetailId === id) openDetail(id);
}
Object.assign(window, { setForPlan, setForDone, setForVoice, setForVo });

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
  // Picked from the team (and anyone sent before), never retyped.
  const who = document.getElementById('shWho');
  who.innerHTML = shooterOptions(x.shootAssignee);
  who.dataset.was = who.value;   // the spelling the list shows, so a cancelled "Someone else…" comes back to it
  document.getElementById('shContact').value = x.siteContact || x.sellerPhone || '';
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
  const whoEmail = emailOfShooter(who);
  const clash = listings.filter(l => l.id !== shootFor && l.shootAt && l.shootAssignee
    && (sameName(l.shootAssignee, who) || (!!whoEmail && l.shootAssigneeEmail === whoEmail))
    && Math.abs(l.shootAt - at) < 2 * 3600000);
  el.textContent = clash.length
    ? `Heads up: ${document.getElementById('shWho').value.trim()} is also at "${clash[0].title || 'another listing'}" around then.`
    : '';
}
window.checkClash = checkClash;
// The dialog's picker: "Someone else…" asks for the name, then the clash check runs on the choice.
window.shooterPicked = sel => { const n = pickedShooter(sel); if (n !== null) sel.dataset.was = n; checkClash(); };
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
    x.shootAt = at; x.shootAssigneeEmail = shooterEmail(x, who); x.shootAssignee = who; x.siteContact = contact;
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
// The inventory is the same `properties` collection the Property
// Intelligence dashboard reads — but it was fetched once per page load and
// then cached for ever, so a property added by a sheet sync was invisible
// here until someone reloaded. The picker is opened by a deliberate act, so
// it re-reads then, with a short window only to stop a double fetch when the
// dialog is reopened immediately.
const INVENTORY_TTL = 60000;
let inventoryAt = 0;
function loadInventory(force) {
  const fresh = inventory && (Date.now() - inventoryAt < INVENTORY_TTL);
  if (fresh && !force) return Promise.resolve(inventory);
  if (!window.trackFirebase) return Promise.resolve(inventory || []);
  return window.trackFirebase.getInventory()
    // Tiles read their brochure state from the inventory, so they are redrawn when it arrives.
    .then(list => { inventory = list; inventoryAt = Date.now(); if (seenListings) applyFilters(); return list; })
    // A failed refresh must not empty a picker that already had something in
    // it — better slightly stale than suddenly blank.
    .catch(e => { console.error('inventory read failed:', e); return inventory || []; });
}
window.trackLoadInventory = loadInventory;
window.trackUser = () => currentUserEmail;
window.trackSearchText = () => currentSearch;
window.trackToast = msg => toast(msg);
let mapFor = null;
function openMapProperty(id) {
  mapFor = id;
  document.getElementById('mapSearch').value = '';
  // Show whatever is cached immediately, then refresh — a picker that is
  // blank for a second is a picker people learn to distrust.
  document.getElementById('mapModal').classList.add('open');
  if (inventory) renderMapList(''); else document.getElementById('mapList').innerHTML = '<div class="tk-hint">Reading the inventory…</div>';
  loadInventory().then(() => renderMapList(document.getElementById('mapSearch').value || '')).catch(e => {
    document.getElementById('mapList').innerHTML = '<div class="tk-hint bad">Could not read the inventory.</div>';
    console.error(e);
  });
}
function renderMapList(q) {
  const el = document.getElementById('mapList');
  if (!el) return;
  const needle = String(q || '').toLowerCase();
  const all = (inventory || []).filter(p => !needle
    || [p.propertyCode, p.name, p.location, p.config].join(' ').toLowerCase().includes(needle));
  // A hard cap of 60 silently hid two thirds of a 131-property inventory from
  // anyone scrolling rather than searching. The list is capped only to keep
  // the DOM sane, and it now SAYS when it is truncated instead of pretending
  // the rest do not exist.
  const CAP = 200;
  // Real codes first and alphabetical — 48 of the 132 properties predate the
  // Property_ID scheme and fall back to a numeric document id, which sorts
  // meaninglessly and reads as noise beside "TNAG0002".
  all.sort((a, b) => {
    const ra = realCode(a.propertyCode), rb = realCode(b.propertyCode);
    if (ra !== rb) return ra ? -1 : 1;
    return String(ra ? a.propertyCode : a.name || '').localeCompare(String(rb ? b.propertyCode : b.name || ''));
  });
  const list = all.slice(0, CAP);
  const x = listings.find(l => l.id === mapFor);
  el.innerHTML = (x && x.propertyCode ? `<button type="button" class="tk-pick clear" onclick="pickProperty('')">✕ Unmap from ${esc(x.propertyCode)}</button>` : '')
    + (list.length ? list.map(p => `<button type="button" class="tk-pick" onclick="pickProperty('${esc(p.propertyCode)}')">
        ${realCode(p.propertyCode) ? `<span class="tk-code">${esc(p.propertyCode)}</span>` : ''}
        <span class="tk-pick-main"><b>${esc(p.name || p.propertyCode || '—')}</b><span>${esc([p.location, p.config, p.startingPrice].filter(Boolean).join(' · ')) || '<i>older listing</i>'}</span></span>
        ${p.soldOut ? '<span class="tk-pill muted">sold</span>' : ''}
      </button>`).join('') : '<div class="tk-hint">Nothing matches.</div>')
    + (all.length > CAP ? `<div class="tk-hint">Showing ${CAP} of ${all.length} — type to narrow it down.</div>` : '')
    + (all.length && !needle ? `<div class="tk-hint">${all.length} propert${all.length === 1 ? 'y' : 'ies'} in the inventory.</div>` : '');
}
window.onMapSearch = v => renderMapList(v);
function pickProperty(code) {
  if (!mapFor) return;
  // Linking goes through the brochure panel's path, so mapping brings the description, internal
  // notes and a delivered brochure across too, and ticks "Brochure created" when there is one.
  if (code && window.bpLink) {
    const id = mapFor; mapFor = null;
    document.getElementById('mapModal').classList.remove('open');
    window.bpLink(id, code);
    return;
  }
  // Unmapping is the same unlink as clearing the code in Edit: the old property's brochure, links
  // and request go with it — otherwise the background check would link it straight back.
  const unlink = !code && window.bpResolveFormCode ? window.bpResolveFormCode({ propertyCode: '' }, mapFor) : null;
  const p = (inventory || []).find(i => i.propertyCode === code);
  mutate(mapFor, x => {
    x.propertyCode = code || '';
    if (unlink) {
      if (unlink.patch) Object.assign(x, unlink.patch);
      if (unlink.brochure) x.brochure = { ...(x.brochure || {}), ...unlink.brochure };
    }
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
// The form's "Shoot assigned to" is the same picker as the shoot's own.
function fillShooterPick(current) {
  const el = document.getElementById('mm_shootAssignee');
  if (el && el.tagName === 'SELECT') { el.innerHTML = shooterOptions(current); el.dataset.was = el.value; }
}
function openAddModal() {
  mModalMode = 'add'; mModalEditId = null;
  document.getElementById('mmTitle').textContent = 'New listing';
  FORM_FIELDS.forEach(([k]) => { const el = document.getElementById('mm_' + k); if (el) el.value = ''; });
  fillShooterPick('');
  document.getElementById('mmErr').textContent = '';
  const hint = document.getElementById('mmCodeHint'); if (hint) hint.innerHTML = '';
  // The code check needs the inventory; read it now so it is there by the time a code is typed.
  loadInventory();
  document.getElementById('mModal').classList.add('open');
}
function openEditModal(id) {
  const x = listings.find(l => l.id === id);
  if (!x) return;
  mModalMode = 'edit'; mModalEditId = id;
  document.getElementById('mmTitle').textContent = 'Edit listing';
  FORM_FIELDS.forEach(([k]) => { const el = document.getElementById('mm_' + k); if (el) el.value = x[k] || ''; });
  // After the loop: the picker selects the person whatever the stored spelling ("swami" is Swami).
  fillShooterPick(x.shootAssignee);
  // A code kept for the brochure (not yet in the dashboard) shows in the same box.
  if (!x.propertyCode && x.brochure && x.brochure.code) document.getElementById('mm_propertyCode').value = x.brochure.code;
  document.getElementById('mmErr').textContent = '';
  const hint = () => { if (window.bpModalCode && mModalEditId === id) window.bpModalCode(document.getElementById('mm_propertyCode').value); };
  hint();
  // The code check needs the inventory, as in New listing; say it again once it is in.
  if (!inventory) loadInventory().then(hint);
  document.getElementById('mModal').classList.add('open');
}
function closeModal() { document.getElementById('mModal').classList.remove('open'); }
let modalWaiting = false;
function saveModal(retried) {
  // What a typed Property ID means depends on the inventory — never decide it without one. One
  // wait at a time (a second click does nothing), and only if the same form is still open after it.
  if (!inventory && window.trackFirebase && retried !== true) {
    if (modalWaiting) return;
    modalWaiting = true;
    const same = { mode: mModalMode, id: mModalEditId };
    document.getElementById('mmErr').textContent = 'Checking the Property dashboard…';
    loadInventory().finally(() => {
      modalWaiting = false;
      const open = document.getElementById('mModal').classList.contains('open');
      if (open && mModalMode === same.mode && mModalEditId === same.id) saveModal(true);
    });
    return;
  }
  document.getElementById('mmErr').textContent = '';
  const form = {};
  FORM_FIELDS.forEach(([k]) => { const el = document.getElementById('mm_' + k); form[k] = el ? el.value.trim() : ''; });
  if (form.shootAssignee === OTHER) form.shootAssignee = '';
  form.shootAssigneeEmail = shooterEmail(mModalMode === 'edit' ? listings.find(l => l.id === mModalEditId) : null, form.shootAssignee);
  if (!form.title && !form.propertyCode) {
    document.getElementById('mmErr').textContent = 'Give it a title, or a Property ID.';
    return;
  }
  // What the typed Property ID means: a dashboard property (link it), another listing's code
  // (refuse), or a new code (keep it for the brochure, not as a dashboard link).
  const codeMeaning = window.bpResolveFormCode ? window.bpResolveFormCode(form, mModalMode === 'edit' ? mModalEditId : null) : { propertyCode: form.propertyCode };
  if (codeMeaning.error) { document.getElementById('mmErr').textContent = codeMeaning.error; return; }
  const linkAfter = codeMeaning.link || null;
  form.propertyCode = linkAfter ? '' : codeMeaning.propertyCode;   // linking itself is done by bpLink below
  const sameCode = (a, b) => String(a || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === String(b || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let sameLink = false;
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
      // Same code as it is already linked to: keep the link as it is (no unlink-relink in the timeline).
      sameLink = !!linkAfter && sameCode(linkAfter, x.propertyCode);
      // A link to make is left to bpLink below, which sets the code itself — the listing is never
      // saved unlinked in between (seller sync would see that).
      const { propertyCode: _code, ...rest } = form;
      Object.assign(x, linkAfter ? rest : form, { own });
      if (codeMeaning.brochure) x.brochure = { ...(x.brochure || {}), ...codeMeaning.brochure };
      // Unlinked (or moved to a new code): what belonged to the old property goes with it.
      if (codeMeaning.patch) Object.assign(x, codeMeaning.patch);
      // Box cleared: forget a draft code that was never sent.
      if (!document.getElementById('mm_propertyCode').value.trim() && x.brochure && !x.brochure.requestedAt) x.brochure = { ...x.brochure, code: '' };
    }, 'Details edited');
    const editedId = mModalEditId;
    closeModal();
    if (linkAfter && !sameLink && window.bpLink) linkOrSay(editedId, linkAfter, 'Saved');
    else { if (currentDetailId === editedId) openDetail(editedId); toast('Saved'); }
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
  if (codeMeaning.brochure) x.brochure = { code: codeMeaning.brochure.code };
  listings.push(x);
  addHistory(x, 'created', 'Listing created');
  persist(x);
  closeModal();
  refreshAll();
  // A code already in the dashboard: link it now, which also fills photos, brochure and details.
  if (linkAfter && window.bpLink) linkOrSay(x.id, linkAfter, 'Listing created');
  else { toast('Listing created'); openDetail(x.id); }
}
// Link after a save. Cancelled (or not possible): the save still stands — say so, and show it.
function linkOrSay(id, code, saved) {
  const notLinked = () => { toast(`${saved} — not linked to ${code}`); openDetail(id); };
  Promise.resolve().then(() => window.bpLink(id, code))
    .then(ok => { if (!ok) notLinked(); })
    .catch(e => { console.error('link after save failed:', e); notLinked(); });
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
    if (!trackInited) {
      trackInited = true;
      // A shoot phone opens on its own day. Everyone else gets the board.
      document.body.classList.toggle('agent-mode', !!myAgent);
      toggleView(myAgent ? 'shoots' : (window.__trackInitialView || 'board'));
    }
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
// Each layer closes through its own function, so the state it holds (which listing a shoot or a
// reason is for) is cleared too — removing the class alone left that behind. The access and wrap
// modals were missing from this list, so Escape in them closed the listing underneath instead.
const TRACK_LAYERS = [
  ['acModal', () => closeAccessModal()], ['wrapModal', () => closeWrapModal()],
  ['rsModal', () => closeReasonModal()], ['shModal', () => closeShootModal()],
  ['mModal', () => closeModal()], ['mapModal', null], ['linkModal', null],
  ['sellerPrev', () => closeSellerPreview()], ['bpPrev', () => window.bpClosePreview && window.bpClosePreview()]
];
function closeTrackLayer(id) {
  const hit = TRACK_LAYERS.find(([x]) => x === id);
  const fn = hit && hit[1];
  if (fn) fn(); else { const el = document.getElementById(id); if (el) el.classList.remove('open'); }
}
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  // Innermost layer first, so Escape peels one thing at a time.
  const open = TRACK_LAYERS.map(([id]) => id).find(id => {
    const el = document.getElementById(id);
    return el && el.classList.contains('open');
  });
  if (open) closeTrackLayer(open);
  else if (currentDetailId) closeDetail();
});
document.addEventListener('mousedown', e => {
  const t = e.target;
  if (t.classList && (t.classList.contains('tk-ov') || t.classList.contains('tk-prev')) && t.id) closeTrackLayer(t.id);
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
if (pendingNav) { window.__trackInitialView = pendingNav; setTimeout(() => toggleView(pendingNav), 0); }
