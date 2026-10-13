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
import * as VO from './voiceover.js';
import { planSync, newListingFor, isSellerLead as isSeller } from './seller-sync.js';
import { extractPropertyFacts, sortSize, TYPE_LABELS } from '../crm-assets/propertyFacts.js';
import { displayName } from '../crm-assets/mentions.js';
import * as TG from './tags.js';
import * as EF from './edit-flow.js';
import * as CFG from './track-config.js';

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

const TRACK_VIEWS = ['board', 'shoots', 'sellers', 'posting', 'settings'];
const DAY = 86400000;

// Board or list, remembered per device. The board is for moving work along;
// the list is for reading across everything at once — what is unmapped, whose
// shoot is late, which owner has not approved. Same data, same filters, two
// ways of looking, because "where is this one" and "what is the state of
// everything" are different questions.
// A third way of looking: Editor — the same cards in the editor's columns (shoot → edit → post).
const BOARD_MODES = ['board', 'list', 'editor'];
let boardMode = 'board';
// The last Board or List choice, so "Board" in the menu leaves the Editor view for it.
let plainMode = 'board';
try { const m = localStorage.getItem('track.mode'); boardMode = BOARD_MODES.includes(m) ? m : 'board'; plainMode = localStorage.getItem('track.plainMode') === 'list' ? 'list' : 'board'; } catch (e) {}
function setBoardMode(m) {
  boardMode = BOARD_MODES.includes(m) ? m : 'board';
  if (boardMode !== 'editor') { plainMode = boardMode; try { localStorage.setItem('track.plainMode', plainMode); } catch (e) {} }
  try { localStorage.setItem('track.mode', boardMode); } catch (e) {}
  renderModeToggle();
  if (window.AppNav) window.AppNav.setActive(navActive());
  applyFilters();
}
window.setBoardMode = setBoardMode;
function renderModeToggle() {
  const fb = document.getElementById('tkFilterBar');
  if (fb) fb.classList.toggle('ed-mode', boardMode === 'editor');   // its own order there: Sort hidden
  const el = document.getElementById('tkModeTog');
  if (!el) return;
  el.innerHTML = [['board', 'Board'], ['list', 'List'], ['editor', 'Editor']].map(([m, label]) =>
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
    // A series card is found by its name and any of its properties.
    const ser = isSeriesCard(x) ? seriesInfo(x) : null;
    const hay = [x.title, x.propertyCode, x.location, x.config, x.sellerName, x.sellerPhone, ser && ser.name, ...(ser ? ser.members.flatMap(m => [m.propertyCode, m.name]) : []), ...cutsOfCard(x).map(k => EF.cutEdit(x, k).by),
      x.askingPrice, x.shootAssignee, x.remarks, x.lastNote && x.lastNote.text, l && l.name, l && l.phone, l && l.propertyInterest,
      l && l.assignedAgent, l && l.secondaryAgent, ...TG.cleanTags(x.tags)].join(' ').toLowerCase();
    return hay.includes(q);
  });
  fitBoard();
  // A shoot phone (agent mode) sees the Editor view, never the full board.
  if (currentView === 'board') { const m = myAgent ? 'editor' : boardMode; m === 'list' ? renderList() : m === 'editor' ? renderEditor() : renderBoard(); }
  else if (currentView === 'shoots') renderShoots();
  // The Posting tab redraws through its own guard: never while someone is typing in it or has a
  // dialog open. It redraws when its rows, the search text or the listings (their tags) changed.
  else if (currentView === 'posting') { const r = window.refreshPosting || window.renderPosting; if (r) r(); }
  else if (currentView === 'settings') renderSettings();
  else renderSellers();
}

function toggleView(view, fromMenu) {
  // "Editor" in the menu is the board in its Editor view; "Board" in the menu is the board itself.
  if (view === 'editor') { view = 'board'; boardMode = 'editor'; try { localStorage.setItem('track.mode', boardMode); } catch (e) {} renderModeToggle(); }
  else if (fromMenu && view === 'board' && boardMode === 'editor') { boardMode = plainMode; try { localStorage.setItem('track.mode', boardMode); } catch (e) {} renderModeToggle(); }
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
  if (window.AppNav) window.AppNav.setActive(navActive());
  applyFilters();
}
window.toggleView = toggleView;
const navActive = () => currentView === 'board' && (boardMode === 'editor' || myAgent) ? 'editor' : currentView;

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
const allTags = () => TG.catalog(config.tags, ...listings.map(l => l.tags), ...((window.pgOwnTagLists && window.pgOwnTagLists()) || []));
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
  const on = currentView === 'board' && boardMode === 'board' && !myAgent;
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
  if (isSeriesCard(x)) return seriesListRowHtml(x);
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
// ── The board card: what it is, where it stands, what is next — nothing more ──
// A busy office reads a column in seconds. The card says: the code and how long it has sat here; the
// property's name; one quiet line (area · type · price); the ONE next thing for its stage; a voice-over
// still to make; what is stuck, in one line; and a footer of tags, a note mark and the agent. Numbers,
// the owner, sizes, the full note and the history are one tap away in the card's panel (call and
// WhatsApp also show on hover).
function cardHtml(x) {
  if (isSeriesCard(x)) return seriesCardHtml(x);
  const late = isLate(x), key = P.stageKeyOf(stageById(x.stageId));
  const age = P.stageAge(x, stages, Date.now());
  const blocked = cardBlockers(x);
  const it = sellerItem(x), f = it.f || {};
  const tel = it.phone ? telOf(it.phone) : '', wa = tel.replace(/^\+/, '');
  const agents = agentsOf(it);
  const by = personName(x.updatedBy);
  const owner = String((it.lead && it.lead.name) || x.sellerName || '').trim();
  // A card added by hand on the board may have no owner yet: its title is then all it has.
  it.locality = it.locality || (it.name !== x.title ? x.title || '' : '');
  const kind = f.config && f.config !== 'Commercial' ? f.config : (TYPE_LABELS[f.type] || f.type || '');
  const deal = f.deal === 'rent' ? 'Rent' : f.deal === 'sale' ? 'Sale' : '';
  const nm = String(propName(x, it) || '').toLowerCase(), loc = String(it.locality || '').trim();
  const meta = [loc && !nm.includes(loc.toLowerCase()) ? loc : '', kind, f.price ? `${deal ? deal + ' ' : ''}${f.price}` : deal ? 'For ' + deal.toLowerCase() : ''].filter(Boolean).join(' · ');
  const ageTitle = [age.target ? `About ${age.target} days in this column` : 'Days in this column',
    `Updated ${timeAgo(x.updatedAt) || '—'}${by ? ' by ' + by : ''}`, it.intake ? `Came in ${fmtDate(it.intake)} · ${it.channel}` : ''].filter(Boolean).join('\n');
  // The code and the days here share the top row; with no code, the days sit beside the name.
  const code = codeChip(x);
  const pill = `<span class="tk-age-pill${age.farOver ? ' bad' : age.over ? ' warn' : ''}" title="${esc(ageTitle)}">${age.days === 0 ? 'today' : age.days + 'd here'}</span>`;
  return `<div class="tk-card cmp${late ? ' late' : ''}" draggable="true" tabindex="0" role="link"
      aria-label="Open ${esc(propName(x, it) || it.locality || it.name)}${owner ? ', owner ' + esc(owner) : ''}"
      data-id="${x.id}"
      ondragstart="onCardDragStart(event,'${x.id}')" ondragend="onCardDragEnd(event)"
      onclick="openDetail('${x.id}')" onkeydown="onCardKeydown(event,'${x.id}')">
    ${code ? `<div class="tk-ctop"><span class="tk-pcode">${code}</span>${pill}</div>` : ''}
    <div class="tk-pname">${propNameHtml(x, it)}
      <button type="button" class="tk-pname-ed" title="Rename this property" aria-label="Rename this property" onclick="event.stopPropagation();editCardTitle('${x.id}')">✎</button>${code ? '' : pill}</div>
    ${refLine(x, propName(x, it), true)}
    ${meta ? `<div class="tk-meta1" title="${esc(meta)}">${esc(meta)}</div>` : loc ? '' : '<div class="tk-meta1 none">Area not given</div>'}
    ${nextLine(x, it, key)}
    ${voRow(x)}
    ${stuckLine(blocked)}
    ${cardFoot(x, { tel, wa, owner, agents, preview: !!x.leadId })}
  </div>`;
}
// The reference Posting knows the property by (its plan name), when it says something the name does not.
// On the board card it is set or changed right there (editable): "+ Reference" on hover when there is none.
function refLine(x, name, editable) {
  const r = window.pgRefOf ? window.pgRefOf(x.id) : '';
  const shown = r && r.toLowerCase() !== String(name || '').trim().toLowerCase();
  if (!editable) return shown ? `<div class="tk-ref" title="The reference in Posting (the plan's name for it)">Ref: ${esc(r)}</div>` : '';
  if (!window.pgSetRef) return '';
  return r
    ? `<button type="button" class="tk-ref tk-ref-ed${shown ? '' : ' same'}" title="The reference in Posting (the plan's name for it) — click to change" onclick="event.stopPropagation();editCardRef('${x.id}')">Ref: ${esc(r)}</button>`
    : `<button type="button" class="tk-ref tk-ref-add" title="Give it the reference used when planning posts" onclick="event.stopPropagation();editCardRef('${x.id}')">+ Reference</button>`;
}
// The reference typed on the card itself: Enter saves (on its Posting row), Escape leaves it.
function editCardRef(id) {
  const card = document.querySelector(`.tk-card[data-id="${CSS.escape(id)}"]`);
  const slot = card && card.querySelector('.tk-ref');
  if (!slot) return;
  card.draggable = false;
  const inp = document.createElement('input');
  inp.className = 'tk-ref-in'; inp.type = 'text'; inp.maxLength = 80;
  inp.value = window.pgRefOf ? window.pgRefOf(id) : ''; inp.placeholder = 'e.g. Lux49 4Bhk';
  inp.setAttribute('aria-label', 'Reference for posting');
  let done = false;
  const finish = save => {
    if (done) return; done = true;
    card.draggable = true;
    if (save && window.pgSetRef) window.pgSetRef(id, inp.value);
    applyFilters();
  };
  inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); });
  inp.addEventListener('click', e => e.stopPropagation());
  inp.addEventListener('mousedown', e => e.stopPropagation());
  inp.addEventListener('blur', () => finish(true));
  slot.replaceWith(inp);
  inp.focus(); inp.select();
}
window.editCardRef = editCardRef;
// The one next thing, by stage: what is missing → the shoot → the media, cuts and brochure → the brochure.
function nextLine(x, it, key) {
  if (['closed', 'on_hold', 'dropped'].includes(key)) return '';
  if (['new_listing', 'details', 'shoot_scheduled'].includes(key)) {
    const miss = ['new_listing', 'details'].includes(key) && it.missing.length ? `<span class="tk-miss">Missing: ${esc(it.missing.join(', '))}</span>` : '';
    return shootLine(x, miss);
  }
  const parts = key === 'live' ? [brochureSignal(x), editChip(x)] : [mediaBar(x), editChip(x), brochureSignal(x)];
  const html = parts.filter(Boolean).join('');
  return html ? `<div class="tk-next">${html}</div>` : '';
}
// Two letters for an agent, from their name or email ("agent.a" → AA, "Ravi Kumar" → RK, "rajesh" → RA).
function avInitials(email) {
  const parts = String(personName(email) || email || '').split(/[\s._-]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2)).toUpperCase();
}
// What is stuck, in one line (all of it on hover).
const stuckLine = blocked => (blocked.length ? `<div class="tk-blockers tk-stuck" title="${esc(blocked.join('\n'))}">${blocked.map(b => `<span class="tk-blk">${esc(b)}</span>`).join('')}</div>` : '');
// Tags (two, then a count), a note mark (the note on hover), quick call / WhatsApp on hover, the agent.
function cardFoot(x, o) {
  const tags = TG.cleanTags(x.tags), n = x.lastNote && x.lastNote.text;
  const left = (tags.length ? `<div class="tk-tags">${tags.slice(0, 3).map(t => `<span class="tk-tag ${TG.tagClass(t)}">${esc(t)}</span>`).join('')}</div>${tags.length > 3 ? `<span class="tk-more" title="${esc(tags.slice(3).join(', '))}">+${tags.length - 3}</span>` : ''}` : '')
    + (n ? `<span class="tk-noteic" title="${esc(n)} — ${esc(personName(x.lastNote.by))}, ${esc(timeAgo(x.lastNote.at))}${x.noteCount > 1 ? ` (${x.noteCount} notes)` : ''}"><i class="fa-regular fa-note-sticky" aria-hidden="true"></i>${x.noteCount > 1 ? ' ' + x.noteCount : ''}</span>` : '');
  const quick = (o.tel ? `<a class="tk-qa" href="tel:${esc(o.tel)}" onclick="event.stopPropagation()" title="Call ${esc(o.owner || 'the owner')}" aria-label="Call"><i class="fa-solid fa-phone" aria-hidden="true"></i></a>` : '')
    + (o.wa ? `<a class="tk-qa" href="https://wa.me/${esc(o.wa)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="WhatsApp ${esc(o.owner || 'the owner')}" aria-label="WhatsApp"><i class="fa-brands fa-whatsapp" aria-hidden="true"></i></a>` : '')
    + (o.preview ? `<button type="button" class="tk-qa" onclick="event.stopPropagation();openSellerPreview('${x.id}')" title="The property at a glance" aria-label="Preview"><i class="fa-regular fa-eye" aria-hidden="true"></i></button>` : '');
  const av = (o.agents || []).map(e => `<span class="tk-av" title="Agent: ${esc(personName(e))}">${esc(avInitials(e))}</span>`).join('');
  if (!left && !quick && !av) return '';
  return `<div class="tk-cfoot">${left}<span class="tk-cfoot-r">${quick ? `<span class="tk-qas">${quick}</span>` : ''}${av}</span></div>`;
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

// The property comes first on a card; the seller is second. Its name is the listing's title — the
// mapped property's name when the listing has none of its own — and is renamed right on the card.
function propName(x, it) {
  if (isSeriesCard(x)) return seriesInfo(x).name;
  const t = String(x.title || '').trim();
  // A lead with no area of interest seeds the title with the owner's name — that is not a property name.
  const owner = String((it && it.lead && it.lead.name) || x.sellerName || '').trim();
  if (t && t !== 'New listing' && t !== owner) return t;
  const p = realCode(x.propertyCode) && inventory ? inventory.find(q => q.propertyCode === x.propertyCode) : null;
  return (p && p.name) || '';
}
function propNameHtml(x, it) {
  const n = propName(x, it);
  return n ? `<span class="tk-pname-t" title="${esc(n)}">${esc(n)}</span>` : '<span class="tk-pname-t none">Add the property name</span>';
}
function editCardTitle(id) {
  const x = listings.find(l => l.id === id);
  const card = document.querySelector(`.tk-card[data-id="${CSS.escape(id)}"]`);
  const slot = card && card.querySelector('.tk-pname-t');
  if (!x || !slot) return;
  card.draggable = false;
  const inp = document.createElement('input');
  inp.className = 'tk-pname-in'; inp.type = 'text'; inp.maxLength = 120;
  inp.value = propName(x, sellerItem(x)); inp.placeholder = 'e.g. 2BHK Apartment, Anna Nagar';
  inp.setAttribute('aria-label', 'Property name');
  let done = false;
  const finish = save => {
    if (done) return; done = true;
    const v = inp.value.replace(/\s+/g, ' ').trim();
    if (save && v && v !== String(propName(x, sellerItem(x)) || '').trim()) {
      // A series has one name: the Posting tab's series is renamed first, so the card redraws with it.
      if (isSeriesCard(x) && x.postingId && window.pgSeriesRename) window.pgSeriesRename(x.postingId, v);
      mutate(id, l => { l.title = v; }, `Renamed to <b>${esc(v)}</b>`);
    }
    else applyFilters();
  };
  for (const ev of ['click', 'mousedown', 'pointerdown', 'dblclick']) inp.addEventListener(ev, e => e.stopPropagation());
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
  slot.replaceWith(inp);
  const ed = card.querySelector('.tk-pname-ed'); if (ed) ed.hidden = true;
  inp.focus(); inp.select();
}
window.editCardTitle = editCardTitle;

const telOf = p => String(p || '').replace(/[^\d+]/g, '');
function initials(name) {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return ((w[0][0] || '') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
}

// The one physical commitment on a card, said the way it matters: not the
// date, but whether it has been missed.
// extra: said at the end of the same line (the card's "Missing: …" before the shoot).
function shootLine(x, extra) {
  if (!x.shootAt) {
    const key = P.stageKeyOf(stageById(x.stageId));
    // Only nag about a missing shoot where one is actually the next step.
    if (!['new_listing', 'details', 'shoot_scheduled'].includes(key)) return extra ? `<div class="tk-card-row">${extra}</div>` : '';
    return `<div class="tk-card-row muted">📸 No shoot booked <button type="button" class="tk-link" onclick="event.stopPropagation();openShootModal('${x.id}')">Book →</button>${extra || ''}</div>`;
  }
  const late = x.shootAt < Date.now();
  const soon = !late && x.shootAt < Date.now() + DAY;
  return `<div class="tk-card-row${late ? ' bad' : soon ? ' hot' : ''}">📸 ${esc(fmtDateTime(x.shootAt))}
    <span class="tk-rel">${esc(relDays(x.shootAt))}</span>
    ${x.shootAssignee ? `<span class="tk-who">· ${esc(x.shootAssignee)}</span>` : ''}
    ${!x.ownerInformed && P.stageKeyOf(stageById(x.stageId)) !== 'shoot_scheduled' ? '<span class="tk-blk sm" title="The owner has not been told we are coming">owner not told</span>' : ''}
    ${extra || ''}
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
  if (isSeriesCard(x)) return ['closed', 'dropped'].includes(key) ? [] : seriesGaps(x);
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
  if (isSeriesCard(x)) return seriesGaps(x);
  const out = [];
  const { done, total } = mediaProgress(x);
  if (done < total) out.push(`${total - done} of ${total} media missing`);
  if (!x.photosLink) out.push('photos not uploaded');
  const forLeft = FOR_KEYS.filter(([k]) => forPlanned(x, k) && !forMade(x, k)).map(([, l]) => l);
  if (forLeft.length) out.push(`${forLeft.join(' + ')} not done`);
  const cutLeft = cutsOfCard(x).filter(k => k !== 'all' && !EF.cutPlanned(x, k)).filter(k => { const st = EF.cutEdit(x, k).status; return st !== 'done' && (st || !EF.isLegacy(x)); });
  if (cutLeft.length) out.push(`edit not done: ${cutLeft.map(k => EF.cutLabel(x, k)).join(', ')}`);
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
  if (isSeriesCard(x)) return '';   // a series' brochures are its properties' — never one of its own
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
  if (currentView === 'settings') renderSettings();
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
  // A drag dropped nowhere (or cancelled) must not leave the page thinking one is under way —
  // the Editor view waits while one is. After the drop handler, which still reads it.
  setTimeout(() => { draggedId = null; }, 0);
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
  const wasShot = !!x.shootDoneAt;
  // Moved back before the shoot was done: it is not shot (a reshoot) — the old wrap is kept aside.
  if (toStep >= 0 && toStep < P.ladderIndex('shoot_done') && x.shootDoneAt) {
    x.prevShootDoneAt = x.shootDoneAt; x.shootDoneAt = null;
    addHistory(x, 'field', 'Shoot marked not done (moved back) — to be shot again');
  }
  // Moved back before Shoot scheduled with a shoot booked: that shoot is off.
  if (toStep >= 0 && toStep < P.ladderIndex('shoot_scheduled') && x.shootAt && !x.shootDoneAt) {
    if (!wasShot) { addHistory(x, 'field', `Shoot on <b>${esc(fmtDateTime(x.shootAt))}</b> cancelled (moved back)`); x.shootCancelled = (x.shootCancelled || 0) + 1; }
    x.shootAt = null; x.ownerInformed = false;
  }
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
  if (key === 'shoot_scheduled' && !x.shootAt && !isSeriesCard(x)) openShootModal(id);   // a series is not shot
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
  const was = edPerson;
  if (myAgent) { edPerson = myAgent; toggleView('editor'); }
  else {
    // Back to the full board: the phone's own filter and the Editor view it was put on go too.
    if (was) { edPerson = ''; try { localStorage.setItem('track.edPerson', ''); } catch (e) {} }
    if (boardMode === 'editor') { boardMode = plainMode; try { localStorage.setItem('track.mode', boardMode); } catch (e) {} }
    renderModeToggle();
    if (currentView === 'shoots') renderShoots(); else toggleView(currentView);
  }
  toast(myAgent ? `Your work, ${myAgent}` : 'Back to the full board');
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
  const groups = [
    ['Missed', withShoot.filter(x => x.shootAt < startOfDay(now) && !isShot(x))],
    ['Today', withShoot.filter(x => x.shootAt >= startOfDay(now) && x.shootAt < endOfToday() && (!isShot(x) || (x.shootDoneAt || 0) >= startOfDay(now)))],
    ['Coming up', withShoot.filter(x => x.shootAt >= endOfToday())]
  ];
  // Only booked shoots: listings still to be booked are on the board (New listing, Details & docs),
  // and listing them here too buried the day's run sheet under every unbooked card.
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
        : (agentFilter ? `<button type="button" class="tk-link" onclick="setMyAgent(${jsq(agentFilter)})">this is me — open my work every time</button>` : '')}
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
    ${!groups.some(g => g[1].length) ? `<div class="tk-empty"><div class="tk-empty-i">📸</div><div class="tk-empty-t">${agentFilter ? 'Nothing for ' + esc(agentFilter) : 'No shoots to plan'}</div><div class="tk-empty-s">Book one from any listing on the board.</div></div>` : ''}`;
}
// Under each shoot: open the property, move the shoot, or call it off — without going to the board.
function shootMore(x) {
  if (!x) return '';
  return `<div class="tk-shoot-more" onclick="event.stopPropagation()">
    <button type="button" class="tk-link" onclick="openDetail('${x.id}')">Open</button>
    ${x.shootAt && !x.shootDoneAt ? `<button type="button" class="tk-link" onclick="openShootModal('${x.id}')">Reschedule</button>
    <button type="button" class="tk-link bad" onclick="cancelShoot('${x.id}')">Cancel shoot</button>` : ''}
  </div>`;
}
// Calling a shoot off: the date goes, the reason is kept, and a card that was only "Shoot scheduled"
// goes back to Details & docs (a card further on keeps its column).
function cancelShoot(id, reason) {
  const x = listings.find(l => l.id === id);
  if (!x || !x.shootAt || x.shootDoneAt) return;   // a shoot already done is not called off
  const when = fmtDateTime(x.shootAt);
  if (reason === undefined) {
    const r = prompt(`Cancel the shoot on ${when} for “${x.title || x.propertyCode || 'this listing'}”?

Why? (optional)`);
    if (r === null) return;
    reason = r.trim();
  }
  mutate(id, l => {
    l.shootAt = null; l.ownerInformed = false;
    l.shootCancelled = (l.shootCancelled || 0) + 1;
    l.cancelReason = reason || null;
  }, `Shoot on <b>${esc(when)}</b> cancelled${reason ? ' — ' + esc(reason) : ''}`);
  const det = P.stageForKey(stages, 'details');
  if (det && P.stageKeyOf(stageById(x.stageId)) === 'shoot_scheduled') changeStage(id, det.id);
  if (currentView === 'shoots') renderShoots();
  if (currentDetailId === id && document.getElementById('dp').classList.contains('open')) openDetail(id);
  toast('Shoot cancelled');
}
function cancelShootFromModal() {
  const id = shootFor; if (!id) return;
  const reason = document.getElementById('shWhy').value.trim();
  const x = listings.find(l => l.id === id);
  if (!x || !confirm(`Cancel the shoot on ${fmtDateTime(x.shootAt)}?`)) return;
  closeShootModal();
  cancelShoot(id, reason);
}
Object.assign(window, { cancelShoot, cancelShootFromModal });
function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
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
      ${shootMore(next)}
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
      ${shootMore(x)}
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
  const all = listings.filter(x => !isSeriesCard(x)).map(sellerItem);   // a series card is no seller
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

// Redrawn after a tick or a save, the panel stays where it was scrolled — every scrolling part of it.
const DP_SCROLLERS = ['#dpBody', '#dp .tk-dp-main', '#dp .tk-dp-side', '#dp'];
function keepDpScroll() {
  const at = DP_SCROLLERS.map(sel => { const el = document.querySelector(sel); return el ? el.scrollTop : 0; });
  const win = window.scrollY;
  // Put back once this redraw is done (it is synchronous), and again after the layout settles.
  const put = () => { DP_SCROLLERS.forEach((sel, i) => { const el = document.querySelector(sel); if (el && at[i]) el.scrollTop = at[i]; }); if (win) window.scrollTo(0, win); };
  queueMicrotask(put); requestAnimationFrame(put);
}
function openDetail(id) {
  const x = listings.find(l => l.id === id);
  if (!x) return;
  if (currentDetailId === id && document.getElementById('dp').classList.contains('open')) keepDpScroll();
  if (isSeriesCard(x)) return openSeriesDetail(x);
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
        ${x.shootDoneAt ? '' : `<button class="tk-btn" onclick="openShootModal('${x.id}')">${x.shootAt ? 'Reschedule' : 'Book the shoot'}</button>`}
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

    ${forSectionHtml(x)}

    ${editSectionHtml(x)}

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

// Shoot for's "Edit" column: where the outlet's edit stands — read only. It moves by its own steps
// (Plan → Start editing → Edit done) in the Edit section and the Editor view, never by a tick here.
function forEditMark(x, k) {
  const e = EF.cutEdit(x, EF.cutOfChannel(x, k));
  const M = { done: ['ok', '✓', 'Edit done'], active: ['act', '✂', 'Being edited'], planned: ['plan', '◷', 'Edit planned'] };
  const m = M[e.status];
  return m ? `<span class="tk-for-ed ${m[0]}" title="${esc(m[2])}${e.by ? ' — ' + esc(e.by) : ''}" aria-label="${esc(m[2])}">${m[1]}</span>` : '<span class="tk-for-ed none" title="Edit not planned">·</span>';
}
// An outlet whose voice-over is still to make: asked for or not — the editor asks once the rough cut is ready.
function voAskLine(x, k) {
  const a = VO.voAsk(x, k), who = config.voiceBy;
  return `<div class="tk-for-ask">${a
    ? `<span class="tk-vo">🎙 V/O asked by <b>${esc(a.by || '—')}</b> · ${esc(timeAgo(a.at))}${who ? ` — ${esc(who)}` : ''}</span>${a.note ? `<span class="tk-for-note">“${esc(a.note)}”</span>` : ''}<button type="button" class="tk-link" onclick="voUnask('${x.id}','${k}')">Take back</button>`
    : `<span class="tk-vo need">🎙 V/O not asked yet</span>${voCutOn(x, k) ? `<button type="button" class="tk-vo-ask" onclick="voAskFor('${x.id}','${k}')">Ask for V/O</button>` : ''}<span class="tk-sub2">${voCutOn(x, k) ? 'once the rough cut is ready' : 'asked by the editor once the edit is under way'}</span>`}</div>`;
}
// Shoot for: each outlet this shoot (or a series' edit) is cut for — planned, made, and its voice.
function forSectionHtml(x, intro) {
  return `<div class="tk-sec" id="dpFor">
      <div class="tk-sec-hdr">Shoot for</div>
      <label class="tk-refrow"><span>Reference for posting <em class="tk-sub2">the plan's name for it — the same in Posting</em></span>
        <input type="text" maxlength="80" value="${esc(window.pgRefOf ? window.pgRefOf(x.id) : '')}" placeholder="e.g. Lux49 4Bhk" onchange="pgSetRef('${x.id}', this.value)" aria-label="Reference for posting"></label>
      <div class="tk-hint" style="margin:-3px 0 9px">${intro || 'Where this shoot is going. For each: planned, made, and its voice over — with V/O, or V/O required separately.'}</div>
      ${legacyVoice(x) ? `<div class="tk-hint warn tk-for-legacy">Set before for the whole shoot: <b>voice-over separately</b>${x.voDone ? ' (made)' : ''}. Pick the voice for each one below.</div>` : ''}
      <div class="tk-brief tk-forgrid">
        <div class="tk-brief-hd"><span></span><span>Planned</span><span>Edit</span><span>Voice over</span><span>VO made</span></div>
        ${FOR_KEYS.map(([k, label]) => {
          const plan = forPlanned(x, k), done = forMade(x, k), v = forVoice(x, k), vo = forVoMade(x, k);
          const voLeft = plan && v === 'vo' && !vo;
          return `<div class="tk-brief-r${(plan && !done) || voLeft ? ' open' : ''}${plan ? '' : ' np'}">
            <span><i class="${FOR_ICON[k]} tk-for-i tk-for-${k}" aria-hidden="true"></i> ${esc(label)}</span>
            <span><input type="checkbox" ${plan ? 'checked' : ''} onchange="setForPlan('${x.id}','${k}',this.checked)" aria-label="${esc(label)} planned"></span>
            <span>${plan ? forEditMark(x, k) : '<span class="tk-muted">—</span>'}</span>
            <span class="tk-for-v">${plan ? `<select class="tk-sel sm" aria-label="${esc(label)} voice" onchange="setForVoice('${x.id}','${k}',this.value)">
                <option value=""${!v ? ' selected' : ''}>–</option>
                <option value="live"${v === 'live' ? ' selected' : ''}>With V/O</option>
                <option value="vo"${v === 'vo' ? ' selected' : ''}>V/O Reqd. separately</option>
              </select>` : '<span class="tk-muted">—</span>'}</span>
            <span class="tk-for-vo">${v === 'vo' && plan ? `<label><input type="checkbox" ${vo ? 'checked' : ''} onchange="setForVo('${x.id}','${k}',this.checked)" aria-label="${esc(label)} voice-over made"><em class="tk-m"> VO made</em></label>` : '<span class="tk-muted">—</span>'}</span>
            ${voLeft ? voAskLine(x, k) : ''}
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

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
  // A card from before edits were per outlet: what its old edit and "made" ticks meant is written as
  // cuts now, before this change — so a tick made later never changes what the old edit meant.
  const m = EF.materializeCuts(x);
  if (m) x.cuts = m;
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
  // A property finished: a series it is in may be complete now.
  if (!isSeriesCard(x)) for (const s of listings) if (isSeriesCard(s) && s.id !== x.id) promoteIfMediaReady(s);
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
  editSheetHtml: () => edSheetHtml(listings),
  inventory: () => inventory,
  loadInventory: force => loadInventory(force),
  mutate: (id, fn, text) => mutate(id, fn, text),
  brochureOf: x => brochureOf(x),
  // Voice-over per outlet, as set on the listing's Shoot for: 'live' (with V/O), 'vo' (V/O made separately) or '' — and whether that V/O is made.
  voiceOf: (x, k) => ({ voice: forVoice(x, k), made: forVoMade(x, k), planned: forPlanned(x, k) }),
  // The edit, for the Posting tab: where the video for a post stands.
  editOf: x => EF.editOf(x),
  span: ms => EF.span(ms),
  createSeriesCard: seed => createSeriesCard(seed),
  editStep: (id, action, k) => edStep(id, action, null, k),
  // Forward only, open cards only (advanceTo): a post live in Posting moves its card to Live.
  advance: (id, key, why) => { const x = listings.find(l => l.id === id); if (!x) return; advanceTo(id, key, why); if (currentDetailId === id && document.getElementById('dp').classList.contains('open')) openDetail(id); },
  shot: x => edCtx(x).shot,
  edCtx: (x, k) => edCtx(x, k),
  cutOfChannel: (x, ch) => EF.cutOfChannel(x, ch),
  cutEdit: (x, k) => EF.cutEdit(x, k),
  cutLabel: (x, k) => EF.cutLabel(x, k),
  cutsOf: x => cutsOfCard(x),
  listingsLoaded: () => seenListings,
  stageFor: key => P.stageForKey(stages, key),
  // A property's card made from the Posting tab (to make its brochure): placed in the column its posts
  // say — Live when one is live, else Media ready. No owner, no lead: the board fills those in later.
  createListing: seed => {
    const key = seed && seed.stageKey;
    const st = P.stageForKey(stages, key) || P.stageForKey(stages, 'media_ready') || P.stageForKey(stages, 'shoot_done') || stages[0];
    if (!st || !window.trackFirebase) return null;
    const now = Date.now(), k = P.stageKeyOf(st) || 'new_listing';
    const x = {
      id: newId('lst_'), stageId: st.id, title: String((seed && seed.title) || '').trim() || 'New listing', location: String((seed && seed.location) || '').trim(),
      media: {}, ownerInformed: false, ownerApproved: false, source: 'posting',
      stageChangedAt: now, stageChangedBy: currentUserEmail || 'team', reached: { [k]: now },
      createdAt: now, createdBy: currentUserEmail || 'team', updatedAt: now, updatedBy: currentUserEmail || null
    };
    listings.push(x);
    persist(x);   // the card first: its timeline's rule reads the card
    addHistory(x, 'created', `Created from Posting to make its brochure — placed in <b>${esc(st.name)}</b>`);
    applyFilters();
    return x.id;
  },
  // Undo of making a series: its card, made in the same action, goes too (no confirm — it is new).
  removeSeriesCard: id => {
    const x = listings.find(l => l.id === id);
    if (!x || !isSeriesCard(x)) return;
    listings = listings.filter(l => l.id !== id);
    if (window.trackFirebase) window.trackFirebase.deleteListing(id).catch(e => console.error(e));
    if (currentDetailId === id) closeDetail();
    applyFilters();
  },
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
// ── Voice-overs still to make (voiceover.js — the same reading as the CRM's Daily task) ──
// On a shot, open card: the outlets whose V/O is still to make. The editor asks for it once the rough
// cut is ready ("Ask for V/O"); only then is it the voice-over person's (Settings → Configurations →
// Voice-over by) — with their name here, and in their Daily task. Shown on the board card, the series
// card, the Editor view's cards and the card's Shoot for.
const voFor = x => (VO.voDue(x, stages) ? VO.voLeft(x) : []);
const VO_SHORT = { igStory: 'Story', igReel: 'Reel', fbReel: 'FB Reel', yt: 'YouTube', collab: 'Collab', all: 'Video' };
const voNames = list => list.map(o => VO_SHORT[o.k] || o.label).join(', ');
// keys: only these outlets (an Editor card's cut); none: all of them.
const voOf = (x, keys) => voFor(x).filter(o => !keys || o.k === 'all' || keys.includes(o.k));
function voChip(x, keys) {
  const left = voOf(x, keys);
  if (!left.length) return '';
  const asked = left.filter(o => o.ask), need = left.filter(o => !o.ask), who = config.voiceBy;
  const since = asked.length ? Math.min(...asked.map(o => o.ask.at)) : 0;
  return (asked.length ? `<span class="tk-vo" title="Asked for by ${esc(asked.map(o => o.ask.by).filter(Boolean).join(', ') || 'the editor')}${asked.some(o => o.ask.note) ? ' — ' + esc(asked.map(o => o.ask.note).filter(Boolean).join(' · ')) : ''}"><i class="fa-solid fa-microphone" aria-hidden="true"></i> V/O asked: <b>${esc(voNames(asked))}</b>${who ? ` · ${esc(who)}` : ''} · ${esc(timeAgo(since))}</span>` : '')
    + (need.length ? `<span class="tk-vo need" title="Needs a voice-over made separately — ask once the rough cut is ready"><i class="fa-solid fa-microphone" aria-hidden="true"></i> V/O needed: <b>${esc(voNames(need))}</b> · not asked yet</span>` : '');
}
// The buttons: ask for the ones not asked yet; "made" for the ones asked.
// Asking needs the rough cut: an outlet's V/O can be asked once its edit is being edited (or done).
const voCutOn = (x, k) => (k === 'all' ? cutsOfCard(x) : [EF.cutOfChannel(x, k)]).some(c => ['active', 'done'].includes(EF.cutEdit(x, c).status));
function voBtns(x, keys) {
  const left = voOf(x, keys), need = left.filter(o => !o.ask && voCutOn(x, o.k)).map(o => o.k), asked = left.filter(o => o.ask).map(o => o.k);
  return (need.length ? `<button type="button" class="tk-vo-ask" onclick="event.stopPropagation();voAskFor('${x.id}',${jsq(need.join(','))})" title="The rough cut is ready — ask ${esc(config.voiceBy || 'for the voice-over')}">Ask for V/O</button>` : '')
    + (asked.length ? `<button type="button" class="tk-vo-done" onclick="event.stopPropagation();voMade('${x.id}',${jsq(asked.join(','))})" title="The voice-over is made">V/O made ✓</button>` : '');
}
function voRow(x) {
  const chip = voChip(x);
  return chip ? `<div class="tk-vo-row">${chip}${voBtns(x)}</div>` : '';
}
// "Ask for V/O": the rough cut is ready — the voice-over person is asked (with a note for them).
function voAskFor(id, keys) {
  const x0 = listings.find(l => l.id === id); if (!x0) return;
  const want = String(keys || '').split(',').filter(Boolean);
  const left = voFor(x0).filter(o => !o.ask && (!want.length || want.includes(o.k)));
  if (!left.length) return;
  const who = config.voiceBy || 'the voice-over person';
  const note = prompt(`Ask ${who} for the voice-over — ${voNames(left)}, ${cardName(x0)}.\nAnything for them (script, length)? Optional.`, '');
  if (note === null) return;
  const at = Date.now(), by = meName();
  mutate(id, x => {
    foldInsta(x);
    const a = { ...(x.forVoAsk || {}) };
    for (const o of left) a[o.k] = { at, by, note: String(note).trim().slice(0, 300) };
    x.forVoAsk = a;
  }, `Voice-over asked for: ${esc(voNames(left))}${note.trim() ? ' — ' + esc(note.trim().slice(0, 300)) : ''}`);
  if (currentDetailId === id && document.getElementById('dp').classList.contains('open')) openDetail(id);
  toast(config.voiceBy ? `${config.voiceBy} is asked — it is in their Daily task` : 'Asked — set who makes voice-overs in Settings → Configurations');
}
window.voAskFor = voAskFor;
// Taken back (asked by mistake, or the cut is being redone first).
function voUnask(id, k) {
  mutate(id, x => { x.forVoAsk = { ...(x.forVoAsk || {}), [k]: null }; }, `Voice-over request taken back: ${esc(VO_SHORT[k] || k)}`);
  if (currentDetailId === id) openDetail(id);
}
window.voUnask = voUnask;
// The card's blockers, without the voice-over line when the V/O row shows it.
const cardBlockers = x => { const b = blockersFor(x); return voFor(x).length ? b.filter(t => !/^voice-over not made/.test(t)) : b; };
// "V/O made" from a card: those outlets (none named: every one still to make) ticked made.
function voMade(id, keys) {
  const x0 = listings.find(l => l.id === id); if (!x0) return;
  const want = String(keys || '').split(',').filter(Boolean);
  const left = voFor(x0).filter(o => !want.length || o.k === 'all' || want.includes(o.k));
  if (!left.length) return;
  mutate(id, x => {
    foldInsta(x);
    for (const o of left) {
      if (o.k === 'all') x.voDone = true;
      else x.forVo = { ...(x.forVo || {}), [o.k]: true };
    }
  }, `Voice-over made: ${esc(left.map(o => VO_SHORT[o.k] || o.label).join(', '))}`);
  if (currentDetailId === id && document.getElementById('dp').classList.contains('open')) openDetail(id);
  toast(`Voice-over made: ${left.map(o => VO_SHORT[o.k] || o.label).join(', ')}`);
}
window.voMade = voMade;
// The single whole-shoot voice from before (x.voice / x.voDone) still counts until voice is set
// per outlet; the first per-outlet choice retires it.
const legacyVoice = x => x.voice === 'vo' && !(x.forVoice && Object.values(x.forVoice).some(v => VOICE[v]));
function setForPlan(id, key, on) {
  mutate(id, x => {
    foldInsta(x);
    // Not cut for this outlet any more: its edit is cleared (kept in its log), unless it still has
    // another outlet (the FB Reel sharing the Insta Reel's cut).
    const k = EF.cutOfChannel(x, key);
    if (!on && EF.cutEdit(x, k).status && !EF.channelsOfCut(x, k).some(ch => ch !== key && forPlanned(x, ch))) {
      const r = EF.setCut(x, k, 'reset', {}, Date.now(), meName());
      if (r.ok) x.cuts = r.patch.cuts;
    }
    x.forPlan = { ...(x.forPlan || {}), [key]: !!on };
    // Planned now: made when its cut already is (an FB Reel ticked after the Insta Reel is done).
    if (on) x.forDone = { ...(x.forDone || {}), [key]: EF.cutEdit(x, EF.cutOfChannel(x, key)).status === 'done' };
    // Not planned any more: its done, voice and voice-over go with it.
    if (!on) { x.forDone = { ...(x.forDone || {}), [key]: false }; x.forVoice = { ...(x.forVoice || {}), [key]: '' }; x.forVo = { ...(x.forVo || {}), [key]: false }; if (x.forVoAsk && x.forVoAsk[key]) x.forVoAsk = { ...x.forVoAsk, [key]: null }; }
  }, `Shoot for ${forLabel(key)}: ${on ? 'planned' : 'not planned'}`);
  if (currentDetailId === id) openDetail(id);
}
function setForVoice(id, key, v) {
  const val = VOICE[v] ? v : '';
  mutate(id, x => {
    foldInsta(x);
    x.forVoice = { ...(x.forVoice || {}), [key]: val };
    if (val !== 'vo') { x.forVo = { ...(x.forVo || {}), [key]: false }; if (x.forVoAsk && x.forVoAsk[key]) x.forVoAsk = { ...x.forVoAsk, [key]: null }; }
    x.forPlan = { ...(x.forPlan || {}), [key]: true };
    if (val) { x.voice = ''; x.voDone = false; }   // the old whole-shoot setting is replaced
  }, `${forLabel(key)}: ${val ? VOICE[val] : 'voice over not set'}`);
  if (currentDetailId === id) openDetail(id);
}
function setForVo(id, key, on) {
  // Made taken back: the old request goes too — the editor asks again when the cut is ready for it.
  mutate(id, x => { foldInsta(x); x.forVo = { ...(x.forVo || {}), [key]: !!on }; if (!on && x.forVoAsk && x.forVoAsk[key]) x.forVoAsk = { ...x.forVoAsk, [key]: null }; }, `${forLabel(key)}: voice-over ${on ? 'made' : 'not made yet'}`);
  if (currentDetailId === id) openDetail(id);
}
Object.assign(window, { setForPlan, setForVoice, setForVo });

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
  if (x && shot && stageKindOfId(x.stageId) === 'open' && P.ladderIndex(P.stageKeyOf(stageById(x.stageId))) < P.ladderIndex('shoot_done')) changeStage(id, shot.id);
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
  document.getElementById('shCancelShoot').style.display = x.shootAt && !x.shootDoneAt ? '' : 'none';
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
  if (!at && prev && prev.shootAt && !prev.shootDoneAt) {
    if (!confirm(`No date: cancel the shoot on ${fmtDateTime(prev.shootAt)}?`)) return;
    closeShootModal(); return cancelShoot(id, why);
  }
  const moving = !!(prev && prev.shootAt && at && prev.shootAt !== at);
  mutate(id, x => {
    x.shootAt = at; x.shootAssigneeEmail = shooterEmail(x, who); x.shootAssignee = who; x.siteContact = contact;
    if (moving) { x.rescheduled = (x.rescheduled || 0) + 1; x.rescheduleReason = why || null; x.ownerInformed = false; }
  }, at
    ? (moving
        ? `Shoot moved to <b>${esc(fmtDateTime(at))}</b>${who ? ' with ' + esc(who) : ''}${why ? ' — ' + esc(why) : ''}`
        : `Shoot booked for <b>${esc(fmtDateTime(at))}</b>${who ? ' with ' + esc(who) : ''}`)
    : 'Shoot date cleared');
  // Booking a shoot IS the move into "Shoot scheduled" — making someone drag
  // the card as well would just be a second chance to forget.
  const x = listings.find(l => l.id === id);
  const sched = P.stageForKey(stages, 'shoot_scheduled');
  if (at && x && sched && stageKindOfId(x.stageId) === 'open' && P.ladderIndex(P.stageKeyOf(stageById(x.stageId))) < P.ladderIndex('shoot_scheduled')) {
    changeStage(id, sched.id);
  } else if (at && x && stageKindOfId(x.stageId) !== 'open') toast(`Booked — the card stays in ${(stageById(x.stageId) || {}).name || 'its column'}`);
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
    // Posting reads each property's brochure from the inventory too: tell it.
    .then(list => { inventory = list; inventoryAt = Date.now(); if (window.pgListingsChanged) window.pgListingsChanged(); if (seenListings) applyFilters(); return list; })
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
    // One property, one seller, one listing: a property already on another listing cannot be picked.
    + (list.length ? list.map(p => (o => o ? `<div class="tk-pick taken" aria-disabled="true">
        ${realCode(p.propertyCode) ? `<span class="tk-code">${esc(p.propertyCode)}</span>` : ''}
        <span class="tk-pick-main"><b>${esc(p.name || p.propertyCode || '—')}</b><span>Mapped to “${esc(o.title || 'another listing')}” — one property, one listing</span></span>
      </div>` : null)(BF.findCode(p.propertyCode, inventory, listings, mapFor).listing) || `<button type="button" class="tk-pick" onclick="pickProperty('${esc(p.propertyCode)}')">
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
  renderLinkNew(q, !list.length);
}
window.onLinkSearch = v => renderLinkList(v);
// Not in the CRM: the owner becomes a seller lead there, linked to this card — name and number are all it needs.
const phoneKeyOf = raw => { const d = String(raw || '').replace(/\D/g, ''); return !d ? '' : d.length === 10 ? '91' + d : d.length === 11 && d[0] === '0' ? '91' + d.slice(1) : d; };
function renderLinkNew(q, open) {
  const el = document.getElementById('linkNew'); if (!el) return;
  const x = listings.find(l => l.id === linkFor) || {};
  const typed = String(q || '').trim(), isPhone = /^[+\d\s-]{6,}$/.test(typed);
  if (!open) { el.innerHTML = `<button type="button" class="tk-link" onclick="renderLinkNewOpen()">Not in the CRM? Create the lead</button>`; return; }
  el.innerHTML = `<div class="tk-linknew-f">
      <div class="tk-linknew-h">Create the owner as a lead <span class="tk-sub2">a seller lead in the CRM, linked to this card</span></div>
      <label for="lnName">Owner name</label><input id="lnName" type="text" maxlength="80" value="${esc(isPhone ? x.sellerName || '' : typed || x.sellerName || '')}" placeholder="e.g. Meenakshi">
      <label for="lnPhone">Phone</label><input id="lnPhone" type="tel" maxlength="20" value="${esc(isPhone ? typed : x.sellerPhone || '')}" placeholder="98400 11111">
      <div class="tk-box-err" id="lnErr"></div>
      <div class="tk-btnrow"><button type="button" class="tk-btn primary" id="lnSave" onclick="createLinkedLead()">Create lead &amp; link</button></div>
    </div>`;
}
window.renderLinkNewOpen = () => renderLinkNew(document.getElementById('linkSearch').value, true);
async function createLinkedLead() {
  const x = listings.find(l => l.id === linkFor); if (!x) return;
  const name = document.getElementById('lnName').value.trim(), phone = document.getElementById('lnPhone').value.trim();
  const err = m => { document.getElementById('lnErr').textContent = m; };
  if (!name) return err('Type the owner’s name.');
  if (!phoneKeyOf(phone) || phoneKeyOf(phone).length < 10) return err('Type the owner’s phone number.');
  // Already in the CRM under this number: that is the lead — link it rather than make a second one.
  const same = leads.find(l => phoneKeyOf(l.phone) === phoneKeyOf(phone));
  if (same) { if (confirm(`${same.name || 'A lead'} already has ${phone} in the CRM. Link that lead?`)) pickLead(same.id); return; }
  const now = Date.now(), me = currentUserEmail || null;
  const lead = { id: 'lead_' + now, channel: 'call', name, phone, phoneKey: phoneKeyOf(phone), email: '',
    enquiryType: 'Seller Listing', propertyInterest: x.title || x.location || '', budget: '',
    ...(realCode(x.propertyCode) ? { propertyCodes: [x.propertyCode] } : {}),
    listingId: x.id, source: 'board', detailsSent: false, contactAt: now, followUpAt: null,
    createdAt: now, updatedAt: now, createdBy: me, updatedBy: me, lastActionType: 'created' };
  const event = { id: 'h' + now + Math.random().toString(36).slice(2, 7), type: 'created', text: `Lead added from the Shoot &amp; Media board (<b>${esc(x.title || 'a property')}</b>)`, at: now, by: me };
  const btn = document.getElementById('lnSave'); if (btn) btn.disabled = true;
  try {
    const saved = await window.trackFirebase.createLead(lead, event);
    if (!leads.some(l => l.id === saved.id)) leads.push(saved);
    pickLead(saved.id);
    toast(`${name} is in the CRM now — linked to this card`);
  } catch (e) {
    console.error('create lead failed:', e);
    if (btn) btn.disabled = false;
    err(e && e.code === 'permission-denied' ? 'You do not have permission to add leads.' : 'Could not create the lead — check your connection.');
  }
}
window.createLinkedLead = createLinkedLead;
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

// ═══════ SERIES CARDS ═══════
// A series ("T Nagar series") is several properties, each shot on its own card, edited into one
// video. Its card here tracks that edit: which properties are in it and whether each is shot, the
// cuts it is made for (Shoot for, with V/O), and the edit itself. It has no owner, shoot, mapping or
// brochure of its own. Its name and properties live on its Posting row (postingId) — one place.
const isSeriesCard = x => !!x && x.kind === 'series';
const keyOfCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
function seriesInfo(x) {
  const s = x.postingId && window.pgSeriesInfo ? window.pgSeriesInfo(x.postingId) : null;
  return s || { id: x.postingId || '', name: String(x.title || '').trim() || 'Series', members: [], gone: !!x.postingId && postingLoaded() };
}
// "Gone" only once the Posting rows have arrived — before that a series is simply not loaded yet.
const postingLoaded = () => !!(window.pgLoaded && window.pgLoaded());
// A property's own card on this board (never a series card).
function cardForCode(code) {
  const k = keyOfCode(code);
  return k ? listings.find(l => !isSeriesCard(l) && (keyOfCode(l.propertyCode) === k || keyOfCode(l.brochure && l.brochure.code) === k)) || null : null;
}
// Shot: past the shoot on the board (or its shoot wrapped up). A property with no card here was
// shot before this board tracked it.
function isShot(l) {
  const k = P.stageKeyOf(stageById(l.stageId));
  return !!l.shootDoneAt || P.ladderIndex(k) >= P.ladderIndex('shoot_done');
}
function memberCards(x) {
  return seriesInfo(x).members.map(m => {
    const card = cardForCode(m.propertyCode);
    // No card here: a coded property was shot before this board tracked it; one with no code yet
    // (a plan line) has not been.
    return { ...m, card, stage: card ? stageById(card.stageId) : null, shot: card ? isShot(card) : !!keyOfCode(m.propertyCode), shootAt: card ? card.shootAt || 0 : 0, shooter: card ? card.shootAssignee || '' : '' };
  });
}
const memLabel = m => m.propertyCode || m.name;
// What stands between a series and a finished edit.
function seriesGaps(x) {
  const info = seriesInfo(x), ms = memberCards(x), out = [];
  if (info.gone) return ['removed from Posting'];
  if (ms.length < 2) out.push(ms.length ? 'only one property' : 'no properties added');
  const notShot = ms.filter(m => !m.shot).map(memLabel);
  if (notShot.length) out.push('not shot yet: ' + notShot.join(', '));
  const noPh = ms.filter(m => !m.photosLink).map(memLabel);
  if (noPh.length) out.push('photos missing: ' + noPh.join(', '));
  const forLeft = FOR_KEYS.filter(([k]) => forPlanned(x, k) && !forMade(x, k)).map(([, l]) => l);
  if (forLeft.length) out.push(`${forLeft.join(' + ')} not done`);
  const voLeft = FOR_KEYS.filter(([k]) => forPlanned(x, k) && forVoice(x, k) === 'vo' && !forVoMade(x, k)).map(([, l]) => l);
  if (voLeft.length) out.push(`voice-over not made: ${voLeft.join(', ')}`);
  // The series' own work is its edits (per outlet): not media-ready until they are done.
  const ks = cutsOfCard(x), notDone = ks.filter(k => EF.cutEdit(x, k).status !== 'done');
  if (!ks.length) out.push('outlets not planned');
  else if (notDone.length) out.push('edit not done: ' + notDone.map(k => EF.cutLabel(x, k)).join(', '));
  return out;
}
// The cuts a card is made for, as small chips: done ones ticked, a V/O still to make flagged.
function cutsHtml(x) {
  const planned = FOR_KEYS.filter(([k]) => forPlanned(x, k));
  if (!planned.length) return '';
  return `<div class="ed-cuts" title="Shoot for">${planned.map(([k, l]) => {
    const vo = forVoice(x, k) === 'vo' && !forVoMade(x, k);
    return `<span class="ed-cut${forMade(x, k) ? ' ok' : ''}${vo ? ' vo' : ''}" title="${esc(l)}${forMade(x, k) ? ' — done' : ' — to do'}${vo ? ' · V/O to make' : ''}"><i class="${FOR_ICON[k]}" aria-hidden="true"></i>${esc(l.replace('Insta ', ''))}${forMade(x, k) ? ' ✓' : ''}${vo ? ' · V/O' : ''}</span>`;
  }).join('')}</div>`;
}
function memberPills(x) {
  const ms = memberCards(x);
  if (!ms.length) return '<div class="tk-sermems"><span class="sl-none">No properties yet — add them in Posting</span></div>';
  return `<div class="tk-sermems">${ms.map(m => `<span class="tk-sermem${m.shot ? ' ok' : ''}" title="${esc(m.name)} — ${m.card ? esc(m.stage ? m.stage.name : '') : 'not on the board'}${m.photosLink ? '' : ' · no photos'}"><i style="background:${m.stage ? m.stage.color : 'var(--t3, #94a3b8)'}"></i>${esc(memLabel(m))}${m.shot ? '' : ' · to shoot'}</span>`).join('')}</div>`;
}
function seriesCardHtml(x) {
  const age = P.stageAge(x, stages, Date.now());
  const info = seriesInfo(x), blocked = cardBlockers(x), by = personName(x.updatedBy);
  return `<div class="tk-card cmp ser${isLate(x) ? ' late' : ''}" draggable="true" tabindex="0" role="link" aria-label="Open series ${esc(info.name)}" data-id="${x.id}"
      ondragstart="onCardDragStart(event,'${x.id}')" ondragend="onCardDragEnd(event)" onclick="openDetail('${x.id}')" onkeydown="onCardKeydown(event,'${x.id}')">
    <div class="sl-head tk-chead">
      <div class="tk-ctop"><span class="tk-pcode"><span class="tk-code ser" title="Several properties, one video">Series · ${info.members.length}</span></span>
        <span class="tk-age-pill${age.farOver ? ' bad' : age.over ? ' warn' : ''}" title="${esc(`Updated ${timeAgo(x.updatedAt) || '—'}${by ? ' by ' + by : ''}`)}">${age.days === 0 ? 'today' : age.days + 'd here'}</span></div>
      <div class="tk-pname"><span class="tk-pname-t" title="${esc(info.name)}">${esc(info.name)}</span>
        <button type="button" class="tk-pname-ed" title="Rename this series" aria-label="Rename this series" onclick="event.stopPropagation();editCardTitle('${x.id}')">✎</button></div>
    </div>
    ${memberPills(x)}
    ${cutsHtml(x)}
    ${editChip(x) ? `<div class="tk-next">${editChip(x)}</div>` : ''}
    ${voRow(x)}
    ${stuckLine(blocked)}
    ${cardFoot(x, {})}
  </div>`;
}
function seriesListRowHtml(x) {
  const st = stageById(x.stageId), age = P.stageAge(x, stages, Date.now()), info = seriesInfo(x), blocked = blockersFor(x);
  const ms = memberCards(x), shot = ms.filter(m => m.shot).length;
  return `<div class="tk-tr${isLate(x) ? ' late' : ''}" role="row" tabindex="0" onclick="openDetail('${x.id}')" onkeydown="onCardKeydown(event,'${x.id}')">
    <span role="cell"><b>${esc(info.name)}</b><span class="tk-sub2">${ms.map(memLabel).map(esc).join(' · ') || 'no properties yet'}</span><span class="tk-code ser">Series · ${ms.length}</span>${tagChips(x.tags)}</span>
    <span role="cell">${st ? `<span class="tk-pill" style="background:${st.color}22;color:${st.color}">${esc(st.name)}</span>` : '—'}<span class="tk-sub2${age.farOver ? ' bad' : age.over ? ' warn' : ''}">${age.days}d here</span></span>
    <span role="cell"><span class="tk-sub2">Series — no owner</span></span>
    <span role="cell"><span class="tk-sub2">${shot} of ${ms.length} shot</span></span>
    <span role="cell">${editChip(x) || '<span class="tk-sub2">edit not planned</span>'}</span>
    <span role="cell">${blocked.length ? blocked.map(b => `<span class="tk-blk">${esc(b)}</span>`).join('') : '<span class="tk-sub2">—</span>'}</span>
  </div>`;
}
function openSeriesDetail(x) {
  const same = currentDetailId === x.id && document.getElementById('dp').classList.contains('open');
  const keepNote = same ? document.getElementById('dpNoteText')?.value || '' : '';
  currentDetailId = x.id;
  const info = seriesInfo(x), ms = memberCards(x), age = P.stageAge(x, stages, Date.now());
  document.getElementById('dpTitle').textContent = info.name;
  document.getElementById('dpSub').innerHTML = `<span class="tk-code ser">Series · ${ms.length} propert${ms.length === 1 ? 'y' : 'ies'}</span> · edited into one video`;
  const memRows = ms.map(m => `<div class="tk-sermrow">
      <div class="tk-sermrow-n"><b>${esc(m.name)}</b>${m.propertyCode ? ` <span class="tk-code">${esc(m.propertyCode)}</span>` : ''}</div>
      <div class="tk-sub2">${m.card ? `${m.stage ? `<span class="tk-pill" style="background:${m.stage.color}22;color:${m.stage.color}">${esc(m.stage.name)}</span> ` : ''}${m.shot ? '✓ shot' : m.shootAt ? '📸 ' + esc(fmtDateTime(m.shootAt)) + (m.shooter ? ' · ' + esc(m.shooter) : '') : 'shoot not booked'}` : 'Not on this board — taken as shot'}
        · ${m.photosLink ? '✓ photos' : '<span class="tk-miss">no photos</span>'} · ${m.brochure ? '✓ brochure' : '<span class="tk-miss">no brochure</span>'}</div>
      ${m.card ? `<button type="button" class="tk-btn sm" onclick="openDetail('${m.card.id}')">Open its card</button>` : ''}
    </div>`).join('');
  const posts = window.pgPostsFor ? window.pgPostsFor(x) : null;
  document.getElementById('dpBody').innerHTML = `
    <div class="tk-dp-main">
    <div class="tk-sec tk-sum">
      ${info.gone ? '<div class="tk-hint bad">This series was deleted from Posting. Delete this card too if it is not needed.</div>' : ''}
      <div class="tk-sum-tags"><span class="tk-sum-k">Tags</span>${window.tagEditorHtml ? window.tagEditorHtml('l:' + x.id, x.tags) : tagChips(x.tags)}</div>
      <div class="tk-sum-grid">
        <div class="tk-sum-f stage"><span>Stage</span>
          <select class="tk-sel sm" aria-label="Stage" onchange="changeStage('${x.id}', this.value)">${stages.map(s => `<option value="${s.id}"${s.id === x.stageId ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
          <span class="tk-sum-sub${age.farOver ? ' bad' : age.over ? ' warn' : ''}">${age.days === 0 ? 'moved here today' : age.days + (age.days === 1 ? ' day' : ' days') + ' in this stage'}</span></div>
        <div class="tk-sum-f"><span>Posting</span><b>${posts && posts.total ? `${posts.live} of ${posts.total} live` : 'Nothing scheduled'}</b>${posts && posts.nextAt ? `<span class="tk-sum-sub">next ${esc(fmtDateTime(posts.nextAt))}</span>` : ''}</div>
        <div class="tk-sum-f"><span>Created</span><b>${esc(fmtDateTime(x.createdAt))}</b></div>
        <div class="tk-sum-f"><span>Last updated</span><b>${esc(fmtDateTime(x.updatedAt))}</b></div>
      </div>
      ${x.postingId ? `<div class="tk-btnrow"><button type="button" class="tk-btn" onclick="pgOpenSeries(${jsq(x.postingId)})">Open in Posting →</button></div>` : ''}
    </div>
    <div class="tk-sec">
      <div class="tk-sec-hdr">Properties in it</div>
      <div class="tk-hint" style="margin:-3px 0 9px">Each is shot on its own card. Add or remove properties in Posting → Series.</div>
      ${memRows || '<div class="tk-hint">No properties yet.</div>'}
    </div>
    ${forSectionHtml(x, 'The cuts this series is edited into. For each: planned, made, and its voice over.')}
    ${editSectionHtml(x)}
    <div class="tk-sec tk-danger"><button class="tk-btn danger" onclick="deleteListing('${x.id}')">Delete series card</button></div>
    </div>
    <aside class="tk-dp-side">
      <div class="tk-sec tk-notes-sec">
        <div class="tk-sec-hdr">Notes <span class="tk-count" id="dpNoteCount"></span></div>
        <div class="tk-note-add">
          <textarea id="dpNoteText" class="tk-area" rows="3" placeholder="What the edit needs — music, order of the properties…"
            onkeydown="if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();addNote('${x.id}')}"></textarea>
          <div class="tk-note-bar"><span class="tk-hint">Ctrl + Enter to add</span><button type="button" class="tk-btn primary sm" onclick="addNote('${x.id}')">Add note</button></div>
        </div>
        <div id="dpNotes" class="tk-notes"><div class="tk-hint">Loading…</div></div>
      </div>
      <div class="tk-sec"><div class="tk-sec-hdr">Timeline</div><div id="dpHistory" class="tk-hist"><div class="tk-hint">Loading…</div></div></div>
    </aside>`;
  document.getElementById('dp').classList.add('open');
  if (keepNote) document.getElementById('dpNoteText').value = keepNote;
  loadHistory(x.id);
  try { const u = new URL(location.href); u.searchParams.set('listing', x.id); history.replaceState(null, '', u.pathname + u.search); } catch (e) {}
}
// Made from the Posting tab when a series is created there; starts in Shoot done (its properties are
// shot on their own cards — this card is the edit).
function createSeriesCard(seed) {
  const st = P.stageForKey(stages, 'shoot_done') || stages[0];
  if (!st || !window.trackFirebase) return null;
  const now = Date.now();
  const x = {
    id: newId('lst_'), kind: 'series', title: String((seed && seed.title) || 'Series').trim(), postingId: String((seed && seed.postingId) || ''),
    stageId: st.id, media: {}, tags: [],
    stageChangedAt: now, stageChangedBy: currentUserEmail || 'team', reached: { [P.stageKeyOf(st) || 'shoot_done']: now },
    createdAt: now, createdBy: currentUserEmail || 'team', updatedAt: now, updatedBy: currentUserEmail || null
  };
  listings.push(x);
  persist(x);   // the card first: its timeline's rule reads the card
  addHistory(x, 'created', 'Series card created from Posting');
  applyFilters();
  return x.id;
}

// ═══════ THE EDIT — one per outlet (a cut) ═══════
// A property is edited per outlet — the Reel on Monday, YouTube on Thursday — so each outlet is a CUT
// with its own editor, days and status (edit-flow.js: cutEdit / setCut). The Editor view moves cuts
// along; Posting reads the cut of the outlet it posts to. The FB Reel is the Insta Reel's cut unless
// the card says it has its own.
const fmtDay = ts => ts ? new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '';
const cutIcon = k => `<i class="${FOR_ICON[k] || 'fa-solid fa-film'} tk-for-i tk-for-${k}" aria-hidden="true"></i>`;
// The card's posts per channel (planned, scheduled or live), for which cuts it has.
const postChannelsOf = x => { const p = window.pgPostsFor && window.pgPostsFor(x); return p ? p.channels || [] : []; };
const cutsOfCard = x => EF.cutKeys(x, postChannelsOf(x));
// On a board card: where its cuts stand, in a few words.
function editChip(x) {
  const ks = cutsOfCard(x);
  if (!ks.length) return '';
  const es = ks.map(k => EF.cutEdit(x, k));
  const act = es.filter(e => e.status === 'active').length, done = es.filter(e => e.status === 'done').length;
  if (!act && !done && !es.some(e => e.status)) return '';
  return `<span class="tk-ed${act ? ' act' : done === ks.length ? ' ok' : ' plan'}" title="${esc(ks.map(k => EF.cutLabel(x, k) + ': ' + EF.EDIT_LABEL[EF.cutEdit(x, k).status]).join(' · '))}">✂ ${act ? act + ' editing · ' : ''}${done}/${ks.length} cut${ks.length === 1 ? '' : 's'} done</span>`;
}
const meName = () => myAgent || personName(currentUserEmail);
// How long an edit took — nothing for under a minute (marked done straight after starting).
const took = (a, b) => (a && b && b - a >= 60000 ? EF.span(b - a) : '');
// The card's Edit section: a row per cut — editor, days, status, its post date — and the FB switch.
// Plan or move this outlet's post — in Posting's own schedule dialog, on the property's Posting row
// (made from the card if it has none): one place for posts, read back here.
function postBtns(x, k, c) {
  if (k === 'collab' || k === 'all' || !window.pgPlanPost) return '';
  const chs = EF.channelsOfCut(x, k).filter(ch => ch === k || forPlanned(x, ch));
  const SH = { igStory: 'Story', igReel: 'Insta', fbReel: 'FB', yt: 'YouTube' };
  return chs.map(ch => `<button type="button" class="tk-btn sm ghost" onclick="pgPlanPost('${x.id}','${ch}')" title="Schedule this post in Posting">${chs.length > 1 ? 'Post ' + SH[ch] : (c.postAt ? 'Move post' : 'Plan post')}</button>`).join('');
}
function editSectionHtml(x) {
  const now = Date.now(), ks = cutsOfCard(x), shot = edCtx(x).shot;
  const btn = (label, js, cls) => `<button type="button" class="tk-btn sm${cls ? ' ' + cls : ''}" onclick="${js}">${label}</button>`;
  const rows = ks.map(k => {
    const e = EF.cutEdit(x, k), c = edCtx(x, k), log = EF.cutLog(x, k);
    const st = e.status === 'active' && e.startedAt ? `Editing · ${EF.span(now - e.startedAt)}` : EF.EDIT_LABEL[e.status];
    return `<div class="tk-cutrow">
      <div class="tk-cut-n">${cutIcon(k)} <b>${esc(EF.cutLabel(x, k))}</b></div>
      <div class="tk-cut-s"><b class="tk-ed-s ${e.status || 'none'}">${esc(st)}</b>${e.by ? ` · ${esc(e.by)}` : ''}${e.planAt ? ` · edit ${esc(fmtDay(e.planAt))}` : ''}${e.dueAt ? ` · deliver ${esc(fmtDay(e.dueAt))}` : ''}${e.doneAt ? ` · done ${esc(fmtDay(e.doneAt))}${took(e.startedAt, e.doneAt) ? ' (' + esc(took(e.startedAt, e.doneAt)) + ')' : ''}` : ''}
        <span class="tk-sub2">${c.postAt ? 'Post ' + esc(postWhen(c)) : c.posts.live ? 'Posted ' + esc(fmtDay(c.posts.lastLiveAt)) : k === 'collab' ? '' : 'No post in Posting yet'}</span>
        ${log.length ? `<details class="tk-cutlog"><summary>${log.length} earlier edit${log.length === 1 ? '' : 's'}</summary>${log.map(l => `<div class="tk-cutlog-r"><span>${esc(l.by || '—')} · done ${esc(fmtDay(l.doneAt))}${took(l.startedAt, l.doneAt) ? ' (' + esc(took(l.startedAt, l.doneAt)) + ')' : ''}</span><button type="button" class="tk-link" title="Not a real edit — take it out of the history" onclick="edForget('${x.id}','${k}',${jsq(l.by)},${Number(l.doneAt)})">Remove</button></div>`).join('')}</details>` : ''}</div>
      <div class="tk-cut-a">
        ${btn(e.status && e.status !== 'done' ? 'Plan…' : 'Plan', `openEditPlan('${x.id}','${k}')`, e.status ? '' : 'primary')}
        ${(e.status === 'planned' || e.status === 'done') && shot ? btn(e.status === 'done' ? 'Edit again' : 'Start editing', `edStep('${x.id}','start',null,'${k}')`, e.status === 'planned' ? 'primary' : '') : ''}
        ${e.status === 'active' ? btn('Edit done', `edStep('${x.id}','done',null,'${k}')`, 'primary') : ''}
        ${postBtns(x, k, c)}
        ${e.status ? btn('Clear', `edStep('${x.id}','reset',null,'${k}')`, 'ghost') : ''}
      </div>
    </div>`;
  }).join('');
  return `<div class="tk-sec" id="dpEdit">
    <div class="tk-sec-hdr">Edit — per outlet</div>
    <div class="tk-hint" style="margin:-3px 0 9px">Each outlet is its own cut, in three steps: <b>Plan</b> (who, which day) → <b>Start editing</b> → <b>Edit done</b>.${shot ? '' : ' <b>Not shot yet</b> — edits can be planned now, and started once the shoot is done.'}</div>
    ${rows || '<div class="tk-hint">No outlet planned yet — tick what this is cut for in Shoot for, or plan an edit.</div>'}
    <div class="tk-btnrow">${btn('Plan edits…', `openEditPlan('${x.id}')`)}</div>
    <label class="tk-check" style="margin-top:8px"><input type="checkbox" ${EF.fbOwnCut(x) ? 'checked' : ''} onchange="setFbOwnCut('${x.id}', this.checked)"> FB Reel has its own cut <span class="tk-sub2">(otherwise it is the Insta Reel's video)</span></label>
  </div>`;
}
function setFbOwnCut(id, on) {
  const x0 = listings.find(l => l.id === id); if (!x0) return;
  if (!on && EF.cutEdit({ ...x0, fbOwnCut: true }, 'fbReel').status === 'active' && !confirm('The FB Reel is being edited as its own cut. Make it the Insta Reel’s video again?')) { openDetail(id); return; }
  mutate(id, l => {
    const reel = (l.cuts || {}).igReel;
    // Its own cut now: it starts where the Insta Reel's stands. Back to the Reel's: "made" follows the Reel.
    if (on && reel && !(l.cuts || {}).fbReel) l.cuts = { ...l.cuts, fbReel: { ...reel, log: [], shared: true } };
    l.fbOwnCut = !!on;
    if (!on && forPlanned(l, 'fbReel')) l.forDone = { ...(l.forDone || {}), fbReel: EF.cutEdit(l, 'igReel').status === 'done' };
  }, on ? 'FB Reel: its own cut' : 'FB Reel: the Insta Reel’s cut');
  if (currentDetailId === id) openDetail(id);
}
window.setFbOwnCut = setFbOwnCut;
// An earlier edit that was not real (marked done by mistake, then redone): out of the history and the
// editor's count.
function edForget(id, k, by, doneAt) {
  const x0 = listings.find(l => l.id === id); if (!x0) return;
  if (!confirm(`Remove the ${EF.cutLabel(x0, k)} edit done by ${by || 'nobody'} on ${fmtDay(doneAt)} from the history? It stops counting for ${by || 'them'}.`)) return;
  if (!EF.forgetEdit(x0, k, { by, doneAt })) return toast('That edit is not in the history any more');
  mutate(id, x => { const c = EF.forgetEdit(x, k, { by, doneAt }); if (c) x.cuts = c; }, `${EF.cutLabel(x0, k)}: earlier edit by <b>${esc(by || '—')}</b> removed from the history`);
  if (currentDetailId === id) openDetail(id);
  toast('Removed from the history');
}
window.edForget = edForget;
const ED_HIST = { plan: 'Edit planned', start: 'Editing started', done: 'Edit done', reset: 'Edit plan cleared', assign: 'Editor changed' };
// One cut moved along. With no cut named, the card's only cut — or the plan, to pick.
function edStep(id, action, opts, k) {
  const x = listings.find(l => l.id === id); if (!x) return;
  if (!k) { const ks = cutsOfCard(x); if (ks.length !== 1) return openEditPlan(id); k = ks[0]; }
  if (action === 'reset' && EF.cutEdit(x, k).status === 'active' && !confirm(`The ${EF.cutLabel(x, k)} is being edited. Clear its edit?`)) return;
  // Editing needs the footage: started or finished only once the shoot is done (planning can come first).
  if (action === 'start' && !edCtx(x).shot && !(x.reached && x.reached.shoot_done) && !x.prevShootDoneAt) return toast('The shoot is not done yet — mark it done first, then edit.');
  const r = EF.setCut(x, k, action, opts || {}, Date.now(), meName());
  if (!r.ok) { if (/Pick who|Plan the edit first/.test(r.error)) return openEditPlan(id, k); return toast(`${EF.cutLabel(x, k)}: ${r.error}`); }
  mutate(id, l => { Object.assign(l, r.patch); foldInsta(l); }, `${EF.cutLabel(x, k)}: ${ED_HIST[action]}${r.edit.by ? ' — <b>' + esc(r.edit.by) + '</b>' : ''}`);
  if (currentDetailId === id && document.getElementById('dp').classList.contains('open')) openDetail(id);
  toast(`${EF.cutLabel(x, k)}: ${ED_HIST[action]}`);
}
window.edStep = edStep;

// ── Plan edits: which outlets, who, which day, delivered by when ──
let edPlanFor = null;
const dateIn = ts => { if (!ts) return ''; const d = new Date(ts), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
function openEditPlan(id, k) {
  const x = listings.find(l => l.id === id); if (!x) return;
  edPlanFor = id;
  // Every outlet can be planned here; ticked: the one asked for, else those still to plan.
  const have = cutsOfCard(x);
  const all = [...(have.includes('all') ? ['all'] : []), ...EF.CUTS.map(c => c[0]).filter(c => c !== 'fbReel' || EF.fbOwnCut(x))];
  const pick = k ? [k] : have.filter(c => !EF.cutEdit(x, c).status);
  const first = pick[0] || have[0] || 'igReel';
  const e = EF.cutEdit(x, first), c = edCtx(x, first);
  const people = editorPeople();
  const cur = e.by || (isSeriesCard(x) ? '' : x.shootAssignee) || myAgent || '';
  if (cur && !people.some(n => sameName(n, cur))) people.unshift(cur);
  document.getElementById('edTitle').textContent = 'Plan the edit — ' + cardName(x);
  document.getElementById('edCuts').innerHTML = all.map(c2 => {
    const s = EF.cutEdit(x, c2).status;
    return `<label class="ed-cutpick${pick.includes(c2) ? ' on' : ''}"><input type="checkbox" value="${c2}" ${pick.includes(c2) ? 'checked' : ''} onchange="this.parentElement.classList.toggle('on', this.checked)">${cutIcon(c2)} ${esc(EF.cutLabel(x, c2))}${s ? ` <span class="tk-sub2">· ${esc(EF.EDIT_LABEL[s])}</span>` : ''}</label>`;
  }).join('');
  document.getElementById('edWho').innerHTML = '<option value="">Pick the editor…</option>' + people.map(n => `<option value="${esc(n)}"${sameName(n, cur) ? ' selected' : ''}>${esc(n)}</option>`).join('');
  document.getElementById('edDay').value = dateIn(e.planAt);
  // Deliver by: as set, else from that outlet's post day in Posting (Settings → Configurations says how).
  document.getElementById('edDue').value = dateIn(e.dueAt || CFG.defaultDelivery(config, c.postAt));
  document.getElementById('edNote').value = e.note || '';
  document.getElementById('edPost').innerHTML = c.postAt ? `${esc(EF.cutLabel(x, first))} post <b>${esc(postWhen(c))}</b> in Posting — deliver before it.` : 'No post date in Posting yet for it.';
  document.getElementById('edErr').textContent = '';
  document.getElementById('edModal').classList.add('open');
}
function closeEditPlan() { document.getElementById('edModal').classList.remove('open'); edPlanFor = null; }
function saveEditPlan() {
  const x = listings.find(l => l.id === edPlanFor); if (!x) return closeEditPlan();
  const v = id => document.getElementById(id).value.trim();
  const day = s => { if (!s) return 0; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  const ks = [...document.querySelectorAll('#edCuts input:checked')].map(i => i.value);
  const by = v('edWho'), planAt = day(v('edDay')), dueAt = day(v('edDue')), note = v('edNote');
  const err = m => { document.getElementById('edErr').textContent = m; };
  if (!ks.length) return err('Tick the outlets this plan is for.');
  if (!by) return err('Pick who edits it.');
  if (planAt && dueAt && dueAt < planAt) return err('The delivery date is before the edit day.');
  // Each outlet: planned or being edited — the plan changes, where it stands is kept; else it is planned.
  let y = { ...x, cuts: EF.cutsView(x) };
  for (const k of ks) {
    const r = EF.setCut(y, k, 'details', { by, planAt, dueAt, note }, Date.now(), meName());
    if (!r.ok) return err(r.error);
    y = { ...y, ...r.patch };
  }
  const id = x.id, patch = { cuts: y.cuts, forDone: y.forDone, forPlan: y.forPlan };
  closeEditPlan();
 mutate(id, l => { Object.assign(l, patch); foldInsta(l); }, `Edit planned — ${esc(ks.map(k => EF.cutLabel(x, k)).join(', '))} — <b>${esc(by)}</b>${planAt ? ', ' + esc(fmtDay(planAt)) : ''}${dueAt ? ', deliver by ' + esc(fmtDay(dueAt)) : ''}`);
  if (currentDetailId === id && document.getElementById('dp').classList.contains('open')) openDetail(id);
  toast(`Edit planned: ${ks.map(k => EF.cutLabel(x, k)).join(', ')}`);
}
Object.assign(window, { openEditPlan, closeEditPlan, saveEditPlan });

// ═══════ EDITOR VIEW ═══════
// The cuts in the editor's columns — what to shoot, what to edit, what is done and booked to post —
// each with its next deadline (shoot day, delivery date or that outlet's post day), nearest first. A
// property not shot yet, or shot with outlets still to plan, is one card in the shoot columns; from
// "Planned to edit" on, each outlet is its own card (Reel, YouTube…), moving along on its own. A track
// of every editor sits on top: what each is editing now and for how long, assigned, delivered.
let edPerson = '';
try { edPerson = localStorage.getItem('track.edPerson') || ''; } catch (e) {}
let edPastAll = false;
let edCheck = '';   // the checklist filter: '' · 'post' (no post planned yet) · 'edit' (no edit planned)
let edDragCut = null;   // the cut a dragged Editor card is
window.setEdCheck = v => { edCheck = ['post', 'edit', 'vo'].includes(v) ? v : ''; renderEditor(); };
function setEdPerson(v) {
  edPerson = edPerson && sameName(edPerson, v) ? '' : String(v || '');
  try { localStorage.setItem('track.edPerson', edPerson); } catch (e) {}
  renderEditor();
}
window.setEdPerson = setEdPerson;
window.edPastToggle = () => { edPastAll = !edPastAll; renderEditor(); };
// What the Editor view needs to know about a card — or one cut of it (k): its stage, whether it is shot
// (a series: all its properties), its shoot date, and its posts in Posting (a cut: its outlet's only).
function edCtx(x, k) {
  const stageKey = P.stageKeyOf(stageById(x.stageId));
  const posts = (window.pgPostsFor && window.pgPostsFor(x, k ? EF.channelsOfCut(x, k) : null)) || { total: 0, scheduled: 0, live: 0, planned: 0, channels: [] };
  const postAt = posts.nextAt || posts.planDay || 0;
  const left = k ? (EF.cutPlanned(x, k) && EF.cutEdit(x, k).status !== 'done' ? 1 : 0) : cutsLeft(x);
  const base = { stageKey, posts, postAt, postTimed: !!posts.nextAt, cutsLeft: left, now: Date.now(), legacy: EF.isLegacy({ source: x.source, createdAt: x.createdAt || 0 }) };
  if (isSeriesCard(x)) {
    const ms = memberCards(x), notShot = ms.filter(m => !m.shot);
    const next = notShot.map(m => m.shootAt).filter(Boolean).sort((a, b) => a - b)[0] || 0;
    return { ...base, shot: ms.length >= 2 && !notShot.length, shootPlanned: true, shootAt: next };
  }
  return { ...base, shot: isShot(x), shootPlanned: !!x.shootAt || stageKey === 'shoot_scheduled', shootAt: x.shootAt || 0 };
}
// ── The property sheet: every shot property, outlet by outlet — edited or not, its V/O, its post ──
// Below the Editor view and the Posting tab, folded away until opened (the choice is remembered).
let sheetOpen = false, sheetLeft = false;
try { sheetOpen = localStorage.getItem('track.sheetOpen') === '1'; sheetLeft = localStorage.getItem('track.sheetLeft') === '1'; } catch (e) {}
window.edSheetToggle = el => {
  const was = sheetOpen;
  sheetOpen = !!el.open;
  try { localStorage.setItem('track.sheetOpen', sheetOpen ? '1' : ''); } catch (e) {}
  // Folded, its rows are not built (every redraw would pay for them): opened, they are drawn now.
  if (sheetOpen && !was && !el.querySelector('.sh-grid, .sh-body')) { if (currentView === 'posting') { if (window.renderPosting) window.renderPosting(); } else applyFilters(); }
};
window.edSheetLeft = on => {
  sheetLeft = !!on;
  try { localStorage.setItem('track.sheetLeft', sheetLeft ? '1' : ''); } catch (e) {}
  if (currentView === 'posting') { if (window.renderPosting) window.renderPosting(); } else applyFilters();
};
function edSheetHtml(list) {
  if (!sheetOpen) return `<details class="sh-wrap" ontoggle="edSheetToggle(this)"><summary><span class="sh-t">Property sheet</span><span class="tk-sub2">Shot properties, outlet by outlet — edited or not, V/O, post</span></summary></details>`;
  const PARKED = ['on_hold', 'dropped', 'closed'];
  // Shot — or edited already (an edit means there was footage, whatever the card's stage says).
  const rows = (list || listings).map(x => ({ x, c: edCtx(x), ks: cutsOfCard(x) }))
    .filter(r => !PARKED.includes(r.c.stageKey) && (r.c.shot || r.ks.some(k => EF.cutEdit(r.x, k).status === 'done' || EF.cutEdit(r.x, k).status === 'active')));
  const done = r => r.ks.length > 0 && r.ks.every(k => EF.cutEdit(r.x, k).status === 'done');
  const cols = [...(rows.some(r => r.ks.includes('all')) ? ['all'] : []), 'igStory', 'igReel', ...(rows.some(r => EF.fbOwnCut(r.x)) ? ['fbReel'] : []), 'yt', 'collab'];
  const nDone = rows.filter(done).length;
  const shown = (sheetLeft ? rows.filter(r => !done(r)) : rows)
    .sort((a, b) => (done(a) - done(b)) || ((b.x.shootDoneAt || 0) - (a.x.shootDoneAt || 0)));
  const ST = { done: ['ok', '✓ Edited'], active: ['act', 'Editing'], planned: ['plan', 'Planned'], '': ['none', 'Not planned'] };
  const cell = (x, k, ks) => {
    if (!ks.includes(k)) return `<div class="sh-c sh-na" data-l="${esc(VO_SHORT[k])}">—</div>`;
    const e = EF.cutEdit(x, k), [cls, label] = ST[e.status] || ST[''], p = edCtx(x, k).posts;
    const vl = voOf(x, k === 'all' ? null : [k, ...EF.channelsOfCut(x, k)]);
    const vo = vl.length ? (vl.some(o => o.ask) ? 'V/O asked' : 'V/O needed') : '';
    const post = p.live ? '<span class="sh-p live">● Live</span>' : p.scheduled ? '<span class="sh-p sch">Scheduled</span>' : p.planned ? '<span class="sh-p">Post planned</span>' : '';
    return `<div class="sh-c" data-l="${esc(k === 'igReel' && !EF.fbOwnCut(x) ? 'Reel + FB' : VO_SHORT[k])}"><span class="sh-s ${cls}">${label}</span>${e.by ? `<span class="sh-by">${esc(e.by)}</span>` : ''}${vo ? `<span class="sh-vo${vo === 'V/O needed' ? ' need' : ''}" title="Voice-over still to make">🎙 ${vo}</span>` : ''}${post}</div>`;
  };
  const head = `<div class="sh-r sh-h"><div>Property</div><div>Shot</div>${cols.map(k => `<div>${esc(k === 'igReel' ? 'Reel (+FB)' : VO_SHORT[k])}</div>`).join('')}</div>`;
  const body = shown.map(r => `<div class="sh-r${done(r) ? ' all-done' : ''}" onclick="openDetail('${r.x.id}')">
      <div class="sh-n" role="button" tabindex="0" onkeydown="if(event.key==='Enter')openDetail('${r.x.id}')">${isSeriesCard(r.x) ? '<span class="tk-code ser">Series</span>' : (codeChip(r.x) || '')}<b>${esc(cardName(r.x))}</b></div>
      <div class="sh-d" data-l="Shot">${r.x.shootDoneAt ? esc(fmtDay(r.x.shootDoneAt)) : '—'}</div>
      ${r.ks.length ? cols.map(k => cell(r.x, k, r.ks)).join('') : `<div class="sh-c sh-warn" style="grid-column: span ${cols.length}">Nothing ticked in Shoot for yet</div>`}
    </div>`).join('');
  return `<details class="sh-wrap"${sheetOpen ? ' open' : ''} ontoggle="edSheetToggle(this)">
    <summary><span class="sh-t">Property sheet</span><span class="tk-sub2">Shot properties, outlet by outlet — edited or not, V/O, post</span><span class="sh-cnt"><b>${nDone}</b> of ${rows.length} fully edited</span></summary>
    <div class="sh-tools"><label class="tk-check"><input type="checkbox" ${sheetLeft ? 'checked' : ''} onchange="edSheetLeft(this.checked)"> Only those not fully edited</label></div>
    ${shown.length ? `<div class="sh-grid" style="--sh-n:${cols.length}">${head}${body}</div>` : `<div class="tk-hint sh-body" style="padding:8px 2px">${rows.length ? 'Every shot property is fully edited.' : 'No property shot yet.'}</div>`}
  </details>`;
}
// Who can edit: the editors set in Settings first, then the shoot team (and anyone already editing).
function editorPeople(withPast) {
  const out = [];
  const past = withPast ? listings.flatMap(x => cutsOfCard(x).map(k => EF.cutEdit(x, k).by)) : [];
  for (const n of [...config.editors, ...shootPeople().map(p => p.name), ...past]) {
    if (n && !out.some(o => sameName(o, n))) out.push(n);
  }
  return out;
}
const cutsLeft = x => FOR_KEYS.filter(([k]) => forPlanned(x, k) && !forMade(x, k)).length;
// A cut as the edit rules read it (the card's own source for "edited before" kept).
const cutPseudo = (x, k) => ({ id: x.id, k, edit: EF.cutEdit(x, k), editLog: EF.cutLog(x, k), source: x.source, createdAt: x.createdAt || 0 });
// Whose an item is: a cut's editor; before that, whoever shoots the property.
// The outlets an Editor card's V/O is about: its cut's; a property card in the shoot columns, the cuts it
// still lists (those with a card of their own say it there).
function edVoKeys(it) {
  const of = c => (c === 'all' ? ['all'] : [c, ...EF.channelsOfCut(it.x, c)]);
  if (it.k) return it.k === 'all' ? null : of(it.k);
  return (it.cuts || []).flatMap(of);
}
const edVoList = it => (it.col !== 'shoot_planned' && it.col !== 'posted' ? voOf(it.x, edVoKeys(it)) : []);
const edVo = it => edVoList(it).length > 0;
const edVoAsked = it => edVoList(it).some(o => o.ask);
function edWho(it) {
  const vo = config.voiceBy && edVoAsked(it) ? [config.voiceBy] : [];
  return [...edWhoEdit(it), ...vo];
}
function edWhoEdit(it) {
  if (it.k) { const e = EF.cutEdit(it.x, it.k); if (e.by) return [e.by]; }
  const x = it.x;
  if (isSeriesCard(x)) return memberCards(x).filter(m => !m.shot).map(m => m.shooter).filter(Boolean);
  return x.shootAssignee ? [x.shootAssignee] : [];
}
const cardName = x => isSeriesCard(x) ? seriesInfo(x).name : (propName(x, sellerItem(x)) || x.title || x.propertyCode || 'Untitled');
const WHAT = { shoot: 'Shoot', delivery: 'Deliver by', post: 'Post' };
// A post with a time shows its time; one only planned for a day shows the day.
const postWhen = c => c.postTimed ? fmtDateTime(c.postAt) : fmtDay(c.postAt) + ' (planned)';
function edCardHtml(it) {
  const { x, k, col, c, pr } = it, ser = isSeriesCard(x), now = Date.now();
  const e = k ? EF.cutEdit(x, k) : EF.normalizeEdit(null);
  const code = ser ? `<span class="tk-code ser">Series · ${seriesInfo(x).members.length}</span>` : (codeChip(x) || '');
  const due = pr.at ? `<span class="ed-due${pr.late ? ' bad' : pr.today ? ' hot' : pr.soon ? ' warn' : ''}" title="The next deadline">${esc(WHAT[pr.what])} ${esc(pr.what === 'delivery' ? fmtDay(pr.at) : pr.what === 'post' ? postWhen(c) : fmtDateTime(pr.at))}${pr.late ? ' · late' : pr.today ? ' · today' : ''}</span>` : '';
  const lines = [];
  if (col === 'shoot_planned') {
    if (ser) { const left = memberCards(x).filter(m => !m.shot); lines.push(`📸 ${left.length ? 'To shoot: ' + left.map(m => esc(memLabel(m)) + (m.shootAt ? ' (' + esc(fmtDay(m.shootAt)) + ')' : '')).join(', ') : 'Add the properties in Posting'}`); }
    else if (!x.shootAt) lines.push('📸 Shoot not booked');
    else if (pr.what === 'shoot') { if (x.shootAssignee) lines.push(`📸 ${esc(x.shootAssignee)}`); }
    else lines.push(`📸 ${esc(fmtDateTime(x.shootAt))}${x.shootAssignee ? ' · ' + esc(x.shootAssignee) : ''}`);
  } else if (col === 'shoot_done') {
    if (x.shootDoneAt) lines.push(`📸 Shot ${esc(fmtDay(x.shootDoneAt))}${x.shootAssignee ? ' · ' + esc(x.shootAssignee) : ''}`);
    lines.push(it.cuts && it.cuts.length ? `To plan: ${it.cuts.map(c2 => cutIcon(c2) + ' ' + esc(EF.cutLabel(x, c2))).join(' · ')}` : '<span class="ed-warn">Tick what it is cut for (Shoot for)</span>');
  } else if (e.status === 'active') lines.push(`✂ <b>${esc(e.by || '—')}</b> · editing for ${esc(EF.span(now - e.startedAt))}`);
  else if (e.status === 'planned') lines.push(`✂ <b>${esc(e.by)}</b>${e.planAt ? ' · edit ' + esc(fmtDay(e.planAt)) : ''}`);
  else if (e.status === 'done') lines.push(`✂ Done${e.by ? ' by ' + esc(e.by) : ''}${e.doneAt ? ' · ' + esc(fmtDay(e.doneAt)) : ''}`);
  if (col === 'posted' && c.posts.lastLiveAt) lines.push(`<span class="ed-live">● Live ${esc(fmtDateTime(c.posts.lastLiveAt))}${c.posts.live > 1 ? ` · ${c.posts.live} posts` : ''}</span>`);
  else if (col === 'planned' && !e.status) lines.push('<span class="ed-warn">✂ Post day fixed — edit not planned</span>');
  // The two dates the editor plans by, whichever are known (the one in the deadline chip not repeated).
  const dates = k ? [e.dueAt && col !== 'done' && col !== 'scheduled' && col !== 'posted' && pr.what !== 'delivery' ? `Deliver by ${esc(fmtDay(e.dueAt))}` : '', c.postAt && pr.what !== 'post' ? `Post ${esc(postWhen(c))}` : ''].filter(Boolean) : [];
  const b = (label, js, cls) => `<button type="button" class="tk-btn sm${cls ? ' ' + cls : ''}" onclick="event.stopPropagation();${js}">${label}</button>`;
  const kq = k ? `'${k}'` : 'null';
  const act = {
    shoot_planned: !ser && x.shootAt && !x.shootDoneAt ? b('Shoot done →', `openWrapModal('${x.id}')`) : '',
    shoot_done: b('Plan edits', `openEditPlan('${x.id}')`, 'primary'),
    planned: e.status === 'planned' ? (c.shot ? b('Start editing', `edStep('${x.id}','start',null,${kq})`, 'primary') : '<span class="ed-warn">📸 Not shot yet</span>') + b('Plan…', `openEditPlan('${x.id}',${kq})`, 'ghost') : b('Plan edit', `openEditPlan('${x.id}',${kq})`, 'primary'),
    active: b('Edit done', `edStep('${x.id}','done',null,${kq})`, 'primary') + b('Plan…', `openEditPlan('${x.id}',${kq})`, 'ghost'),
    done: b('Schedule in Posting', `edPosting('${x.id}')`, 'primary'),
    scheduled: b('Open in Posting', `edPosting('${x.id}')`),
    posted: (c.posts.lastUrl ? `<a class="tk-btn sm primary" href="${esc(c.posts.lastUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">View post ↗</a>` : '') + b('Open in Posting', `edPosting('${x.id}')`)
  }[col] || '';
  // The two checks for a cut: its edit planned, its post planned (either can come first).
  const ck = k ? EF.checks(cutPseudo(x, k), c) : null;
  const checklist = !ck || col === 'posted' ? '' : `<div class="ed-checks">
    <span class="ed-ck${ck.edit ? ' ok' : ck.gap === 'edit' ? ' bad' : ''}">${ck.edit ? '✓' : '○'} Edit planned</span>
    <span class="ed-ck${ck.post ? ' ok' : ''}">${ck.post ? '✓' : '○'} Post planned</span></div>`;
  // The voice-over still to make for this cut (its outlets), from Shoot done until it is posted.
  const voKeys = edVoKeys(it);
  const vo = col !== 'shoot_planned' && col !== 'posted' ? voChip(x, voKeys) : '';
  return `<div class="tk-card ed-card${pr.late ? ' late' : ''}${ser ? ' ser' : ''}" draggable="true" tabindex="0" role="link" data-id="${x.id}"${k ? ` data-cut="${k}"` : ''}
      aria-label="Open ${esc(cardName(x))}${k ? ' — ' + esc(EF.cutLabel(x, k)) : ''}" ondragstart="onCardDragStart(event,'${x.id}');edSetDragCut(${kq})" ondragend="onCardDragEnd(event)" onclick="openDetail('${x.id}')" onkeydown="onCardKeydown(event,'${x.id}')">
    <div class="ed-top">${code}${due}</div>
    <div class="ed-name">${esc(cardName(x))}</div>
    ${refLine(x, cardName(x))}
    ${k ? `<div class="ed-cutname">${cutIcon(k)} ${esc(EF.cutLabel(x, k))}</div>` : ''}
    ${vo ? `<div class="tk-vo-row">${vo}${voBtns(x, voKeys)}</div>` : ''}
    ${lines.map(l => `<div class="ed-line">${l}</div>`).join('')}
    ${dates.length ? `<div class="ed-dates">${dates.join(' · ')}</div>` : ''}
    ${checklist}
    ${act ? `<div class="ed-acts">${act}</div>` : ''}
  </div>`;
}
window.edSetDragCut = k => { edDragCut = k; };
// Everything in the editor's world: one item per property in the shoot columns, one per cut after.
function edItems(list) {
  const now = Date.now(), out = [];
  const push = (x, k, col, c, extra) => out.push({ x, k, col, c, pr: EF.priority(k ? cutPseudo(x, k) : x, { ...c, column: col }, now, config.dueSoonDays), ...(extra || {}) });
  for (const x of list) {
    const ks = cutsOfCard(x), whole = edCtx(x);
    if (!ks.length) { const col = EF.editColumn({}, whole); if (col === 'shoot_planned' || col === 'shoot_done') push(x, null, col, whole, { cuts: [] }); continue; }
    const shootCol = { shoot_planned: [], shoot_done: [] };
    for (const k of ks) {
      const c = edCtx(x, k), e = EF.cutEdit(x, k);
      // A cut with no outlet to post to (Collab) is finished once its edit is done.
      if (k === 'collab' && e.status === 'done') continue;
      const col = EF.editColumn(cutPseudo(x, k), c);
      if (!col) continue;
      if (col === 'shoot_planned' || col === 'shoot_done') shootCol[col].push(k);
      else push(x, k, col, c);
    }
    for (const col of ['shoot_planned', 'shoot_done']) if (shootCol[col].length) push(x, null, col, whole, { cuts: shootCol[col] });
  }
  return out;
}
function edTrackHtml() {
  const now = Date.now();
  const items = [];
  // Every cut the card holds a record for — one no longer planned keeps its history here too.
  for (const x of listings) {
    const ks = Object.keys(EF.cutsView(x)).filter(k => k === 'all' || EF.CUTS.some(c => c[0] === k));
    const own = ks.filter(k => !EF.cutShared(x, k)).map(k => EF.cutEdit(x, k));
    for (const k of ks) {
      const p = cutPseudo(x, k), e = p.edit;
      // A copy of an old edit counts once: a done copy never (its edit is counted where it came from); a
      // planned or active one only once nothing it was copied with still stands for it.
      if (EF.cutShared(x, k) && (e.status === 'done' || own.some(o => o.status === e.status && o.by === e.by && o.startedAt === e.startedAt))) continue;
      // The FB Reel back on the Insta Reel's video: its own plan has no card any more — only its history counts.
      if (k === 'fbReel' && !EF.fbOwnCut(x) && e.status !== 'done') p.edit = EF.normalizeEdit(null);
      if (p.edit.status || p.editLog.length) items.push({ x: p, title: `${cardName(x)} · ${EF.cutLabel(x, k)}` });
    }
  }
  const tr = EF.editorTrack(items, now).filter(r => r.name);
  if (!tr.length) return `<section class="ed-track"><div class="ed-track-h"><b>Editors</b><span class="tk-sub2">Nobody has an edit yet — plan one from a card in Shoot done.</span></div></section>`;
  const tile = r => {
    const on = edPerson && sameName(edPerson, r.name), a = r.active[0];
    return `<button type="button" class="ed-tile${on ? ' on' : ''}${r.active.length ? ' live' : ''}" aria-pressed="${!!on}" onclick="setEdPerson(${jsq(r.name)})" title="${on ? 'Show everyone' : 'Show only ' + esc(r.name) + '’s work'}">
      <span class="ed-tn">${r.active.length ? '<i class="ed-dot" aria-hidden="true"></i>' : ''}${esc(r.name)}</span>
      <span class="ed-tnow">${a ? `Editing <b>${esc(a.title)}</b> · ${esc(EF.span(now - a.since))}${r.active.length > 1 ? ` +${r.active.length - 1}` : ''}` : 'Not editing now'}</span>
      <span class="ed-tstats"><span><b>${r.planned.length}</b> assigned</span><span><b>${r.doneWeek}</b> done this week</span>${r.avgHours * 60 >= 1 ? `<span>~${esc(EF.span(r.avgHours * 3600000))} each</span>` : ''}</span>
    </button>`;
  };
  const me = edPerson ? tr.find(r => sameName(r.name, edPerson)) : null;
  const past = me && me.done.length ? `<div class="ed-past"><div class="ed-past-h">${esc(me.name)} — past edits <span class="tk-count">${me.done.length}</span></div>
    <div class="ed-prows">${me.done.slice(0, edPastAll ? 50 : 6).map(d => `<div class="ed-prow"><button type="button" class="ed-prow-o" onclick="openDetail('${d.id}')"><span>${esc(d.title)}</span><span class="tk-sub2">${esc(fmtDay(d.doneAt))}${took(d.startedAt, d.doneAt) ? ' · took ' + esc(took(d.startedAt, d.doneAt)) : ''}</span></button>${d.earlier && d.k ? `<button type="button" class="tk-link ed-prow-x" title="Not ${esc(d.by || 'their')} edit — done by mistake, redone since: take it out of the history" onclick="edForget('${d.id}','${d.k}',${jsq(d.by)},${Number(d.doneAt)})">Remove</button>` : ''}</div>`).join('')}</div>
    ${me.done.length > 6 ? `<button type="button" class="tk-link" onclick="edPastToggle()">${edPastAll ? 'Show fewer' : `Show all ${me.done.length}`}</button>` : ''}</div>` : '';
  return `<section class="ed-track"><div class="ed-track-h"><b>Editors</b><span class="tk-sub2">live · tap one to see only their work and past edits</span></div>
    <div class="ed-tiles">${tr.map(tile).join('')}</div>${past}</section>`;
}
function renderEditor() {
  const host = document.getElementById('boardView');
  if (!host || currentView !== 'board') return;
  if (!stages.length) { host.innerHTML = '<div class="tk-empty"><div class="tk-empty-t">Setting up the board…</div></div>'; return; }
  const all = edItems(filtered);
  const byPerson = edPerson ? all.filter(it => edWho(it).some(n => sameName(n, edPerson))) : all;
  // The checklist filter: edited (or edit planned) with no post planned yet, or a post planned with no edit.
  const gapOf = it => it.k ? EF.checks(cutPseudo(it.x, it.k), it.c).gap : '';
  const mine = edCheck === 'vo' ? byPerson.filter(edVo) : edCheck ? byPerson.filter(it => gapOf(it) === edCheck) : byPerson;
  const nGap = k => byPerson.filter(it => gapOf(it) === k).length;
  // Counted per voice-over (a card can have one asked and one still to ask); the filter is by card.
  const nVo = byPerson.filter(edVo).length;
  const vos = byPerson.flatMap(edVoList), nVoAsked = vos.filter(o => o.ask).length, nVoNeed = vos.length - nVoAsked;
  const people = editorPeople(true);
  if (config.voiceBy && !people.some(n => sameName(n, config.voiceBy))) people.push(config.voiceBy);   // their V/O work
  const late = mine.filter(it => it.pr.late).length, today = mine.filter(it => it.pr.today).length;
  const sx = host.querySelector('.ed-board') ? host.querySelector('.ed-board').scrollLeft : 0;
  // A shoot phone: whose it is, the day's run sheet one tap away, and the way out of "this is me".
  const agentBar = myAgent ? `<div class="ed-agent"><span>This phone is <b>${esc(myAgent)}</b>'s</span><button type="button" class="tk-btn sm" onclick="toggleView('shoots')">Today's shoots →</button><button type="button" class="tk-link" onclick="setMyAgent('')">not ${esc(myAgent)}?</button></div>` : '';
  host.innerHTML = `<div class="ed-wrap">
    ${agentBar}
    ${myAgent ? '' : edTrackHtml()}
    <div class="ed-bar">
      <label class="tk-dd tk-dd-pick${edPerson ? ' on' : ''}"><span class="tk-dd-k">Person</span>
        <select onchange="setEdPerson(this.value || '')" aria-label="Show the work of">${['', ...people].map(n => `<option value="${esc(n)}"${(n === '' ? !edPerson : sameName(n, edPerson)) ? ' selected' : ''}>${n ? esc(n) : 'Everyone'}</option>`).join('')}</select></label>
      <label class="tk-dd tk-dd-pick${edCheck ? ' on' : ''}"><span class="tk-dd-k">Checklist</span>
        <select onchange="setEdCheck(this.value)" aria-label="Checklist">
          <option value=""${!edCheck ? ' selected' : ''}>All</option>
          <option value="post"${edCheck === 'post' ? ' selected' : ''}>Edit planned, post not planned (${nGap('post')})</option>
          <option value="edit"${edCheck === 'edit' ? ' selected' : ''}>Post planned, edit not planned (${nGap('edit')})</option>
          <option value="vo"${edCheck === 'vo' ? ' selected' : ''}>V/O needed or asked (${nVo})</option>
        </select></label>
      <span class="ed-sum"><b>${mine.length}</b> card${mine.length === 1 ? '' : 's'}${late ? ` · <b class="bad">${late} late</b>` : ''}${today ? ` · <b class="hot">${today} due today</b>` : ''}${nVo && edCheck !== 'vo' ? ` · <button type="button" class="tk-link ed-vo-n" onclick="setEdCheck('vo')"><i class="fa-solid fa-microphone" aria-hidden="true"></i> ${nVoAsked ? `${nVoAsked} V/O asked${config.voiceBy ? ' · ' + esc(config.voiceBy) : ''}` : ''}${nVoAsked && nVoNeed ? ', ' : ''}${nVoNeed ? `${nVoNeed} to ask` : ''}</button>` : ''} · nearest deadline first</span>
    </div>
    <div class="tk-board ed-board">${EF.ED_COLS.map(col => {
      const cards = mine.filter(it => it.col === col.key).sort((a, b) => (b.pr.late - a.pr.late) || (a.pr.rank - b.pr.rank) || String(cardName(a.x)).localeCompare(cardName(b.x)) || EF.CUTS.findIndex(c => c[0] === a.k) - EF.CUTS.findIndex(c => c[0] === b.k));
      const nLate = cards.filter(it => it.pr.late).length;
      return `<div class="tk-col ed-col ed-${col.key}${cards.length ? '' : ' ed-empty'}" title="${cards.length ? '' : esc(col.label + ' — ' + col.hint)}">
        <div class="tk-col-hdr"><div class="tk-col-head"><span class="tk-col-title">${esc(col.label)}</span></div><div class="tk-col-rule">${esc(col.hint)}</div>
          <div class="tk-col-counts">${nLate ? `<span class="tk-late">${nLate} late</span>` : ''}<span class="tk-count">${cards.length}</span></div></div>
        <div class="tk-col-body" ondragover="onColDragOver(event)" ondragleave="onColDragLeave(event)" ondrop="edColDrop(event,'${col.key}')">
          ${cards.map(edCardHtml).join('') || '<div class="tk-col-none">Nothing here</div>'}
        </div></div>`;
    }).join('')}</div>
    ${edSheetHtml(filtered)}
  </div>`;
  const b = host.querySelector('.ed-board'); if (b && sx) b.scrollLeft = sx;
}
// Dropping a cut on one of the editor's own columns moves its edit; the others follow the shoot and Posting.
function edColDrop(e, colKey) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const id = draggedId, k = edDragCut;
  draggedId = null; edDragCut = null;
  const x = listings.find(l => l.id === id); if (!x) return;
  const action = EF.ED_DROP[colKey];
  if (!action) return toast(colKey === 'scheduled' || colKey === 'posted' ? 'Schedule or post it in Posting — it moves here by itself' : 'This column follows the shoot');
  if (!k) return action === 'plan' ? openEditPlan(id) : toast('Plan its edits first — each outlet then moves on its own');
  const e0 = EF.cutEdit(x, k);
  if (action === 'plan' && (e0.status === 'planned' || !e0.by)) return e0.status === 'planned' ? null : openEditPlan(id, k);
  if (action === 'reset' && !e0.status) return;
  if (action === 'reset' && !confirm(`Clear the edit plan for the ${EF.cutLabel(x, k)}?`)) return;
  if (action === 'done' && e0.status === 'done') return;
  edStep(id, action, action === 'plan' ? { by: e0.by, planAt: e0.planAt, dueAt: e0.dueAt } : {}, k);
}
window.edColDrop = edColDrop;
// To the card's posts in Posting: a series to its block, a property to its row.
function edPosting(id) {
  const x = listings.find(l => l.id === id); if (!x) return;
  if (isSeriesCard(x)) return window.pgOpenSeries && window.pgOpenSeries(x.postingId);
  const p = window.pgPostsFor && window.pgPostsFor(x);
  toggleView('posting');
  if (p && p.rowId && window.pgJump) setTimeout(() => window.pgJump(p.rowId), 0);
  else toast('Not on the Posting tab yet — use + Add schedule there');
}
window.edPosting = edPosting;
// Someone is using a field in that view (a picker open, a box half-typed): a redraw would take it away.
const inUse = id => { const a = document.activeElement, el = document.getElementById(id); return !!(a && el && el.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)); };
// Editing times tick: the Editor view redraws each minute while it is showing (not mid-drag, not
// under an open dialog).
setInterval(() => {
  if (currentView === 'board' && (boardMode === 'editor' || myAgent) && !draggedId && !document.querySelector('.tk-ov.open') && document.visibilityState === 'visible' && !inUse('boardView')) renderEditor();
}, 60000);
// The Posting tab's rows changed: series names, post dates and "Post scheduled" follow.
window.trackPostingChanged = () => {
  if (currentView !== 'board' || draggedId || inUse('boardView')) return;
  const m = myAgent ? 'editor' : boardMode;
  if (m === 'list') renderList(); else if (m === 'editor') renderEditor(); else renderBoard();
};

// ═══════ SETTINGS → CONFIGURATIONS ═══════
// Everything the admin sets for this page, in one place: who the editors are (the Editor view opens
// first for them), edit deadlines, series, the board's stage targets, the standard tags. Saved in
// settings/{tenant}.trackConfig for the whole team; every field has a default (track-config.js).
let config = CFG.normalizeConfig({});
let configLoaded = false;
window.trackConfig = () => config;
window.applyTrackConfigSnapshot = raw => {
  const next = CFG.normalizeConfig(raw);
  const changed = JSON.stringify(next) !== JSON.stringify(config);
  config = next;
  P.setTargetDays(config.targetDays);
  const first = !configLoaded;
  configLoaded = true;
  if (first) editorDefault();
  if (changed) {
    if (window.pgListingsChanged) window.pgListingsChanged();
    // Someone else's change while a field here is in use: redraw once it is left, not under the typing.
    if (currentView === 'settings') { if (inUse('settingsView')) cfStale = true; else renderSettings(); }
    else if (!document.querySelector('.tk-ov.open')) applyFilters();
  }
};
// The person signed in, by the team's name for them (as editors are named).
const signedInName = () => {
  const e = String(currentUserEmail || '').toLowerCase();
  return (team.find(t => t.email === e) || {}).name || (e ? displayName(e) : '');
};
// An editor opens on the Editor view, showing their own work — once per visit, and only when no view
// was asked for (a link, the menu). Anyone can still switch to Board or List, and back.
let editorDefaultDone = false;
function editorDefault() {
  if (editorDefaultDone || !trackInited || !configLoaded) return;
  editorDefaultDone = true;
  const me = signedInName();
  if (myAgent || window.__trackInitialView || currentView !== 'board' || !CFG.isEditor(config, me)) return;
  boardMode = 'editor';
  if (!edPerson) edPerson = config.editors.find(n => sameName(n, me)) || me;
  renderModeToggle();
  if (window.AppNav) window.AppNav.setActive(navActive());
  applyFilters();
}
function saveConfig(patch, what) {
  const before = config;
  const next = CFG.normalizeConfig({ ...config, ...patch });
  config = next;
  P.setTargetDays(config.targetDays);
  renderSettings();
  if (!window.trackFirebase || !window.trackFirebase.saveTrackConfig) return;
  window.trackFirebase.saveTrackConfig(next, Object.keys(patch)).then(() => toast(what || 'Saved')).catch(e => {
    console.error('Settings save failed:', e);
    // Not saved: show what is really stored again.
    config = before; P.setTargetDays(config.targetDays); renderSettings();
    toast(e && e.code === 'permission-denied' ? 'You do not have permission to change settings' : 'Could not save — check your connection');
  });
}
window.cfAddEditor = () => {
  const sel = document.getElementById('cfEdPick'), typed = document.getElementById('cfEdName');
  const name = String((typed && typed.value) || (sel && sel.value) || '').trim();
  if (!name) return;
  if (config.editors.some(n => sameName(n, name))) return toast(name + ' is already an editor');
  saveConfig({ editors: [...config.editors, name] }, name + ' added as an editor');
};
window.cfRemoveEditor = name => saveConfig({ editors: config.editors.filter(n => !sameName(n, name)) }, name + ' removed');
window.cfSet = (key, value) => saveConfig({ [key]: value });
// Who makes the voice-overs, by name and — from the team — email (Daily task finds them by it).
window.cfVoiceBy = name => {
  const t = team.find(m => sameName(m.name, name));
  saveConfig({ voiceBy: name || '', voiceByEmail: t ? t.email : '' }, name ? name + ' makes the voice-overs' : 'Voice-over person cleared');
};
window.cfTarget = (key, v) => {
  const n = Math.round(Number(v));
  const t = { ...config.targetDays };
  if (n > 0) t[key] = n; else delete t[key];
  saveConfig({ targetDays: t }, 'Stage target saved');
};
window.cfAddTag = () => {
  const inp = document.getElementById('cfTag'), v = TG.normTag(inp && inp.value);
  if (!v) return;
  if ([...TG.DEFAULT_TAGS, ...config.tags].some(t => TG.tagKey(t) === TG.tagKey(v))) return toast('That tag is already offered');
  saveConfig({ tags: [...config.tags, v] }, 'Tag added');
};
window.cfRemoveTag = t => saveConfig({ tags: config.tags.filter(x => TG.tagKey(x) !== TG.tagKey(t)) }, 'Tag removed');
// A field's change can fire again as the redraw takes it away (it loses focus): one redraw at a time.
let cfDrawing = false, cfStale = false;
document.addEventListener('focusout', e => {
  const el = document.getElementById('settingsView');
  if (cfStale && el && el.contains(e.target)) setTimeout(() => { if (cfStale && !inUse('settingsView')) { cfStale = false; renderSettings(); } }, 0);
});
function renderSettings() {
  const host = document.getElementById('settingsView');
  if (!host) return;
  if (cfDrawing) { setTimeout(renderSettings, 0); return; }
  cfDrawing = true;
  try { drawSettings(host); } finally { cfDrawing = false; }
}
function drawSettings(host) {
  const people = shootPeople().map(p => p.name).filter(n => !config.editors.some(e => sameName(e, n)));
  const chip = (label, js, cls) => `<span class="cf-chip${cls ? ' ' + cls : ''}">${esc(label)}${js ? `<button type="button" onclick="${js}" aria-label="Remove ${esc(label)}">✕</button>` : ''}</span>`;
  const sec = (title, hint, body) => `<section class="cf-sec"><div class="cf-sh"><h3>${title}</h3>${hint ? `<p>${hint}</p>` : ''}</div><div class="cf-sb">${body}</div></section>`;
  const tog = (key, label, sub) => `<label class="cf-tog"><input type="checkbox" ${config[key] ? 'checked' : ''} onchange="cfSet('${key}', this.checked)"><span><b>${esc(label)}</b><small>${esc(sub)}</small></span></label>`;
  host.innerHTML = `<div class="cf-wrap">
    <header class="cf-head"><div class="eyebrow">Settings</div><h2>Configurations</h2><p>Shoot &amp; Media, for the whole team. Changes save at once.</p></header>
    ${sec('Editors', 'The <b>Editor view</b> opens first for these people, with their own work. Anyone can open it from <b>Board · List · Editor</b>, or from the menu.', `
      <div class="cf-chips">${config.editors.length ? config.editors.map(n => chip(n, `cfRemoveEditor(${jsq(n)})`)).join('') : '<span class="cf-none">No editors yet</span>'}</div>
      <div class="cf-add">
        <select id="cfEdPick" aria-label="Pick a team member">${people.length ? '<option value="">Pick from the team…</option>' + people.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') : '<option value="">Everyone on the team is an editor</option>'}</select>
        <span class="cf-or">or</span><input id="cfEdName" type="text" placeholder="Type a name" maxlength="60" onkeydown="if(event.key==='Enter'){event.preventDefault();cfAddEditor()}">
        <button type="button" class="tk-btn primary" onclick="cfAddEditor()">Add editor</button>
      </div>`)}
    ${sec('Voice-over', 'Who makes the voice-overs. Every V/O still to make shows on the cards with their name, in the Editor view (Checklist → V/O to make), and in their <b>Daily task</b>.', `
      <label class="cf-row"><span>Voice-over by</span><select onchange="cfVoiceBy(this.value)" aria-label="Voice-over by">
        <option value=""${config.voiceBy ? '' : ' selected'}>Nobody set</option>
        ${[...new Set([...(config.voiceBy ? [config.voiceBy] : []), ...team.map(t => t.name), ...config.editors])].map(n => `<option value="${esc(n)}"${sameName(n, config.voiceBy) ? ' selected' : ''}>${esc(n)}</option>`).join('')}
      </select></label>`)}
    ${sec('Edit deadlines', 'How the Editor view dates and orders the work.', `
      <label class="cf-row"><span>Deliver by, when not typed</span><select onchange="cfSet('deliverDefault', this.value)" aria-label="Default delivery date">${CFG.DELIVER_DEFAULTS.map(([k, l]) => `<option value="${k}"${config.deliverDefault === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="cf-row"><span>Flag a deadline as "soon" when it is within</span><span class="cf-num"><input type="number" min="0" max="14" value="${config.dueSoonDays}" onchange="cfSet('dueSoonDays', this.value)" aria-label="Days for soon"> days</span></label>`)}
    ${sec('Series', 'Several properties, shot separately, edited into one video.', `
      ${tog('seriesAutoDetect', 'Plan lines that say "series" become a series', 'Pasting "Youtube - T nagar series" makes a series; its properties are picked after.')}
      ${tog('seriesBoardCard', 'A new series gets a card on the board', 'Its edit is then tracked on the board and in the Editor view.')}`)}
    ${sec('Board — stage targets', 'Days a card can sit in a stage before it shows as late (red at double).', `
      <div class="cf-targets">${CFG.TARGET_STAGES.map(([k, l, d]) => `<label class="cf-row"><span>${esc((P.stageForKey(stages, k) || {}).name || l)}</span><span class="cf-num"><input type="number" min="1" max="365" value="${config.targetDays[k] || ''}" placeholder="${d}" onchange="cfTarget('${k}', this.value)" aria-label="${esc(l)} target days"> days${config.targetDays[k] ? '' : ' <em>default</em>'}</span></label>`).join('')}</div>`)}
    ${sec('Tags', 'Offered on every card and Posting row, besides the four starting tags and any in use.', `
      <div class="cf-chips">${TG.DEFAULT_TAGS.map(t => chip(t, '', 'fixed')).join('')}${config.tags.map(t => chip(t, `cfRemoveTag(${jsq(t)})`)).join('')}</div>
      <div class="cf-add"><input id="cfTag" type="text" placeholder="New tag" maxlength="32" onkeydown="if(event.key==='Enter'){event.preventDefault();cfAddTag()}"><button type="button" class="tk-btn" onclick="cfAddTag()">Add tag</button></div>`)}
    ${sec('Team', 'Who can be picked for a shoot or an edit. The team is kept in the CRM by the owner.', `
      <div class="cf-chips">${team.length ? team.map(t => `<span class="cf-chip" title="${esc(t.email)}">${esc(t.name)}</span>`).join('') : '<span class="cf-none">No team set yet</span>'}</div>`)}
  </div>`;
}
window.renderSettings = renderSettings;

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
      // A shoot phone opens on its own work in the Editor view (the Shoots run sheet is in the menu).
      if (myAgent && !window.__trackInitialView) edPerson = myAgent;
      toggleView(myAgent && !window.__trackInitialView ? 'editor' : (window.__trackInitialView || 'board'));
      editorDefault();
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
  ['mModal', () => closeModal()], ['edModal', () => closeEditPlan()], ['mapModal', null], ['linkModal', null],
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
  select: view => toggleView(view, true),
  signOut: () => trackLogout()
});
window.AppNav.setActive(currentView);
const pendingNav = window.AppNav.takeNav();
if (pendingNav) { window.__trackInitialView = pendingNav; setTimeout(() => toggleView(pendingNav, true), 0); }
