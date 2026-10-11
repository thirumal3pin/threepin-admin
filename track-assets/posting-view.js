// ═══════ POSTING TRACKER — THE PAGE ═══════
//
// The "Posting" tab of Property & Media. The rules live in posting.js; this file
// only draws them and turns clicks into saves. It talks to the rest of the page
// through the globals app.js exposes (trackLoadInventory, trackUser, trackToast,
// trackSearchText) and to Firestore through window.trackFirebase.
//
// A row can start as nothing more than a line of the weekly plan ("Monday -S- Lux49
// 4Bhk"): a reference and a day. The code, title, photos, brochure and dashboard record
// arrive later on the same row. A line can also be tagged to a property already tracked,
// which makes it a repost — its own posts, sharing the original's brochure and listings.
//
// Layout rule from the CRM: nothing here scrolls sideways. Cards and sheet rows wrap,
// the filter buttons wrap, and every dialog is a single column.

import * as G from './posting.js';
import * as TG from './tags.js';
import * as B from './brochure-flow.js';
import { postGate } from './edit-flow.js';

let trackers = [];
const MODES = ['today', 'week', 'sheet', 'cards', 'series'];
// Older saved choices map onto the new tabs, so nobody lands somewhere unexpected after the update.
const OLD_MODE = { tasks: 'today', upcoming: 'week', props: 'cards', matrix: 'sheet' };
const K_MODE = 'posting.mode', K_SORT = 'posting.sort';
const SORTS = [['attention', 'Needs attention'], ['planned', 'Planned date'], ['progress', 'Least done first'], ['newest', 'Newest first'], ['code', 'Property code']];
let mode = 'today';             // home: what needs you now, today's posts, the week; the rest is one click away
let sortKey = 'attention';
try {
  let m = localStorage.getItem(K_MODE); if (OLD_MODE[m]) m = OLD_MODE[m];
  if (MODES.includes(m)) mode = m;
  const s = localStorage.getItem(K_SORT); if (SORTS.some(x => x[0] === s)) sortKey = s;
} catch (e) {}
let order = null;               // row order, frozen while you edit so rows do not jump under your hand
let focusId = null;
let filters = new Set();
let inv = null;                 // inventory, for linking, tagging and prefill
let dlg = null;                 // the open dialog: { kind, id, key, ... }
let timer = null;
let weekOffset = 0;            // the week strip: 0 = this week, -1 = last, +1 = next
let filtersOpen = false;        // the filter list is behind one button; active filters always show
let laterOpen = false;          // Today's "Everything else" section
// The week strip above the Sheet: shown unless you hide it (remembered on this computer).
let sheetWeek = true;
try { sheetWeek = localStorage.getItem('posting.sheetWeek') !== 'off'; } catch (e) {}

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A value going into inline JS (onclick="fn(...)"): a JSON string, then HTML-escaped. esc() alone
// is not enough — the browser turns &#39; back into ' before the JS runs. Written without quotes:
// onclick="fn(${jsq(id)}, ${jsq(key)})".
const jsq = v => esc(JSON.stringify(String(v == null ? '' : v)));
// Only a web address becomes a link; anything else (a "javascript:" value) is not clickable.
const href = u => (G.isUrl(u) ? esc(u) : '');
const now = () => Date.now();
const who = () => (window.trackUser && window.trackUser()) || '';
const toast = m => { if (window.trackToast) window.trackToast(m); };
const byId = id => trackers.find(t => t.id === id) || null;
const isOpen = () => { const el = $('postingView'); return !!el && el.style.display !== 'none'; };
const dn = t => G.displayName(t, trackers);
// The reference (the plan's name for a property), shown under its name wherever the name is shown —
// when it says something the name does not. A repost's name already carries its reference.
const refOf = t => { if (!t || t.repostOf) return ''; const r = String(t.reference || '').trim(); return r && r !== G.nameOf(t) ? r : ''; };
const refHtml = (t, cls) => refOf(t) ? `<span class="${cls}" title="Reference">${esc(refOf(t))}</span>` : '';
const origOf = t => (t && t.repostOf ? byId(t.repostOf) : null);
const codeOf = t => (t.repostOf ? (origOf(t) || {}).propertyCode || '' : t.propertyCode);
// A series row (or a round of one), and the series row itself for a round.
const rootOf = t => (t && t.repostOf && origOf(t)) || t;
const isSer = t => !!t && G.isSeries(rootOf(t));

// Date formats, each built once (see G.formatDate) — toLocale*String per cell was most of a render.
const F_FULL = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
const F_TIME = { hour: 'numeric', minute: '2-digit' };
const F_WD = { weekday: 'short' };
const F_DM = { day: 'numeric', month: 'short' };
const F_WHEN = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
const F_LONG = { weekday: 'long', day: 'numeric', month: 'long' };
const F_DAYHEAD = { weekday: 'long', day: 'numeric', month: 'short' };
const timeOf = ts => G.formatDate(ts, F_TIME);
function fmt(ts) {
  return ts ? G.formatDate(ts, F_FULL) : '';
}
function localInput(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function dateInput(ts) { return ts ? localInput(ts).slice(0, 10) : ''; }
function fromDateInput(v) { if (!v) return 0; const [y, m, d] = v.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
function nextHour() { const d = new Date(); d.setMinutes(0, 0, 0); return d.getTime() + 3600000; }
function rel(ts) {
  const diff = ts - now(), a = Math.abs(diff), m = Math.round(a / 60000), h = Math.round(a / 3600000), d = Math.round(a / 86400000);
  const p = a < 3600000 ? (m <= 1 ? 'a minute' : m + ' min') : a < 86400000 ? (h === 1 ? '1 hour' : h + ' hours') : (d === 1 ? '1 day' : d + ' days');
  return diff < 0 ? p + ' ago' : 'in ' + p;
}
// Platform logos (Font Awesome brands, already loaded from cdnjs by propertytrack.html). Story and
// Reel are both Instagram: the Story wears the story ring, the Reel a small play badge.
const CH_ICON = { igStory: 'fa-instagram', igReel: 'fa-instagram', fbReel: 'fa-facebook', yt: 'fa-youtube' };
const chIcon = key => key && CH_ICON[key]
  ? `<span class="ci ci-${key}" aria-hidden="true"><i class="fa-brands ${CH_ICON[key]}"></i></span>`
  : '<span class="ci ci-none" aria-hidden="true"><i class="fa-regular fa-circle-question"></i></span>';
const chLabel = (key, text) => `<span class="ci-l">${chIcon(key)}<span>${esc(text)}</span></span>`;
const shortDay = ts => G.formatDate(ts, F_WD) + ' ' + new Date(ts).getDate();
const weekLabel = ts => 'Week of ' + G.formatDate(ts, F_DM);

// ═══════ DATA ═══════
let snapIds = new Set();        // the rows in the latest snapshot, to tell "deleted" from "no permission"
let loaded = false;             // the first snapshot has arrived (before it, a series is unknown, not gone)
window.pgLoaded = () => loaded;
window.applyPostingSnapshot = list => {
  const next = (Array.isArray(list) ? list : []).map(G.normalizeTracker);
  const same = loaded && sameRows(trackers, next);
  trackers = next;
  loaded = true;
  snapIds = new Set(next.map(t => t.id));
  // Our own write coming back (Firestore echoes every local write): the page already shows it.
  if (same) return;
  badge();
  refresh();
  // The board's series cards and Editor view read these rows (names, post dates).
  if (window.trackPostingChanged) window.trackPostingChanged();
};
function sameRows(a, b) {
  if (a.length !== b.length) return false;
  const mine = new Map(a.map(t => [t.id, t]));
  return b.every(t => { const o = mine.get(t.id); return !!o && !G.changedPaths(o, t).length; });
}
// Someone else's save, the minute timer or the CRM's own refreshes must not wipe what is
// half-typed in the Sheet (a name, "+ Add code", a date): while a field in the view has focus the
// redraw waits, and happens once focus leaves the view. It also waits while a mouse button is
// down — redrawing between press and release would swallow the click.
let renderWaiting = false, stale = true, shownQ = null, pointerDown = false;
const searchText = () => (window.trackSearchText ? window.trackSearchText() : '');
function typingInView() {
  const a = document.activeElement, el = $('postingView');
  return !!(a && el && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
}
function refresh() {
  stale = true;
  if (!isOpen() || dlg) return;
  if (typingInView() || pointerDown) { renderWaiting = true; return; }
  renderPosting();
}
const catchUp = () => { if (renderWaiting && !typingInView() && !pointerDown) refresh(); };
// For app.js: redraw only if something changed (the data, or the search text) and only when the
// tab is showing, nobody is typing in it and no dialog is open.
window.refreshPosting = () => {
  if (!isOpen()) { stale = true; return; }
  if (!stale && !renderWaiting && searchText() === shownQ) return;
  refresh();
};
document.addEventListener('focusout', e => {
  const el = $('postingView');
  if (!renderWaiting || !el || !el.contains(e.target)) return;
  // Focus has not landed yet during focusout; look once it has. Tab to the next cell keeps waiting.
  setTimeout(catchUp, 0);
});
document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
// After the release; the click that follows in the same turn runs before this timer.
const released = () => { pointerDown = false; if (renderWaiting) setTimeout(catchUp, 0); };
document.addEventListener('pointerup', released, true);
document.addEventListener('pointercancel', released, true);
document.addEventListener('click', released, true);    // in case a native popup kept the pointerup
function badge() {
  memMemo = null; serIdx = null;   // rows changed: series members are read again
  const n = trackers.filter(t => G.overall(t, now()) === 'attention').length;
  if (window.AppNav) window.AppNav.setBadge('posting', n);
}
// Saved optimistically: the row changes at once, and the snapshot confirms it. Only the fields a
// change touched are written (a new row is written whole), so two people working on different
// parts of one row never overwrite each other. Every change offers Undo for a few seconds — a
// wrong click in a dropdown should cost one more click, not a hunt for what it was before.
//
// stage() applies a change locally and says what to write: { t, paths, prev }. paths is null for
// a new row. Nothing changed → null, and nothing is written.
function stage(t) {
  const prev = byId(t.id);
  const paths = prev ? G.changedPaths(prev, t) : null;
  if (paths && !paths.length) return null;
  t = { ...t, updatedAt: now(), updatedBy: who() };
  const i = trackers.findIndex(x => x.id === t.id);
  if (i >= 0) trackers[i] = t; else trackers.push(t);
  return { t, paths, prev };
}
// An update to a row someone else deleted comes back as permission-denied (the rule reads a
// document that is no longer there) or not-found. If the latest snapshot no longer has the row,
// that is what happened: say so, and drop the row this tab put back.
function saveFailed(e, writes) {
  console.error('posting save failed:', e);
  const code = e && e.code;
  const gone = (code === 'permission-denied' || code === 'not-found') && (writes || []).filter(w => w.paths && !snapIds.has(w.t.id));
  if (gone && gone.length) {
    trackers = trackers.filter(t => !gone.some(w => w.t.id === t.id));
    badge(); refresh();
    return toast((writes.length > 1 ? 'A row here' : 'This row') + ' was deleted by someone else' + (writes.length > 1 ? ' — nothing was saved' : ''));
  }
  toast(code === 'permission-denied' ? 'You do not have permission to save this' : 'Could not save — check your connection and try again');
}
function persist(t, what, quiet, noUndo) {
  const w = stage(t);
  if (!w) { if (!quiet) renderPosting(); return Promise.resolve(); }
  if (!quiet) { badge(); renderPosting(); }
  if (!quiet && !noUndo) offerUndo(what || 'Saved', undoOne(w));
  return window.trackFirebase.savePosting(w.t, w.paths || undefined).catch(e => saveFailed(e, [w]));
}
// Several rows in one write (Add schedule, the week plan); a failure is reported once.
function persistAll(writes) {
  writes = writes.filter(Boolean);
  if (!writes.length) return Promise.resolve();
  return window.trackFirebase.savePostings(writes.map(w => ({ t: w.t, paths: w.paths || undefined }))).catch(e => saveFailed(e, writes));
}
// Undo puts back only what that one change touched, on top of the row as it is NOW — an edit
// someone else made in the meantime (to another field) survives. A row the change created is removed.
function undoOne(w) {
  if (!w.prev) return () => removeRow(w.t.id, 'Undone');
  return () => { const cur = byId(w.t.id); if (cur) persist(G.copyPaths(cur, w.prev, w.paths), 'Undone', false, true); };
}
function undoAll(writes) {
  return () => {
    for (const w of writes) {
      if (!w.prev) { trackers = trackers.filter(t => t.id !== w.t.id); window.trackFirebase.deletePosting(w.t.id).catch(deleteFailed); }
    }
    persistAll(writes.filter(w => w.prev).map(w => { const cur = byId(w.t.id); return cur ? stage(G.copyPaths(cur, w.prev, w.paths)) : null; }));
    badge(); renderPosting(); offerUndo('Undone', null);
  };
}
const deleteFailed = e => { console.error(e); toast(e && e.code === 'permission-denied' ? 'You do not have permission to delete this' : 'Could not delete'); };
function removeRow(id, what) {
  trackers = trackers.filter(x => x.id !== id);
  badge(); renderPosting();
  if (what) offerUndo(what, null);
  return window.trackFirebase.deletePosting(id).catch(deleteFailed);
}
let undoFn = null, undoTimer = null;
function offerUndo(msg, fn) {
  let el = $('pgUndo');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pgUndo'; el.className = 'pg-undo'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  undoFn = fn;
  el.innerHTML = `<span>${esc(msg)}</span>${fn ? '<button type="button" onclick="pgUndo()">Undo</button>' : ''}`;
  el.classList.add('show');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { el.classList.remove('show'); undoFn = null; }, fn ? 7000 : 2600);
}
window.pgUndo = () => { const fn = undoFn; undoFn = null; const el = $('pgUndo'); if (el) el.classList.remove('show'); if (fn) fn(); };
function loadInv() {
  if (!window.trackLoadInventory) return;
  window.trackLoadInventory().then(l => { inv = l || []; memMemo = null; refresh(); if (dlg && dlg.kind === 'plan') pgPlanPreview(); });
}
const invFor = t => inv && t.propertyCode ? inv.find(p => G.codeKey(p.propertyCode) === G.codeKey(t.propertyCode)) : null;
const trackedByCode = code => trackers.find(t => !t.repostOf && G.codeKey(t.propertyCode) && G.codeKey(t.propertyCode) === G.codeKey(code)) || null;
// The codes already tracked, as one Set — for lists that check every inventory item (one lookup
// each instead of a scan of every row).
const trackedCodes = () => new Set(trackers.filter(t => !t.repostOf).map(t => G.codeKey(t.propertyCode)).filter(Boolean));
// Dashboard properties that can still be added: they have a code, and it is not tracked yet.
const untrackedInv = () => { const has = trackedCodes(); return (inv || []).filter(p => G.trackerId(p.propertyCode) && !has.has(G.codeKey(p.propertyCode))); };

window.postingOpened = () => {
  order = null; stale = true;
  loadInv();
  clearInterval(timer);
  timer = setInterval(() => { if (isOpen()) refresh(); else clearInterval(timer); }, 60000);
};

// ═══════ RENDER ═══════
function matchesSearch(t, q) {
  if (!q) return true;
  const o = origOf(t);
  // A series is found by any of its properties too ("tnag0003" finds the T Nagar series).
  const mem = isSer(t) ? rootOf(t).members.flatMap(m => [m.propertyCode, m.title]) : [];
  return [t.propertyCode, t.title, t.reference, t.location, inputsFor(t).details, t.note, o && o.title, o && o.propertyCode, ...mem, ...tagsOf(t)].join(' ').toLowerCase().includes(q);
}

// ── Series: its properties, as they stand ──
// Each member read from its own row and the Property dashboard (G.memberStatus), once per render.
let memMemo = null, serIdx = null;
const invList = () => (window.trackApi && window.trackApi.inventory && window.trackApi.inventory()) || inv || [];
function membersOf(t) {
  const s = rootOf(t);
  if (!s || !G.isSeries(s)) return [];
  if (!memMemo) memMemo = new Map();
  if (!memMemo.has(s.id)) {
    // Photos uploaded at the shoot sit on the property's board card: those count too.
    const ms = G.memberStatus(s, trackers, invList()).map(m => {
      if (m.photosLink) return m;
      const l = memo().byCode.get(G.codeKey(m.propertyCode));
      return l && G.isUrl(l.photosLink) ? { ...m, photosLink: l.photosLink } : m;
    });
    memMemo.set(s.id, ms);
  }
  return memMemo.get(s.id);
}
G.setMemberSource(membersOf);
// The series a property is in (by its row, or by its code).
const seriesFor = t => (t && !isSer(t) ? G.seriesOf(trackers, t, serIdx || (serIdx = G.seriesIndex(trackers))) : []);
const serName = s => G.nameOf(s);
// The small "Series · 3" mark beside a series' name, wherever its name is shown.
const serBadge = t => (isSer(t) ? `<span class="pg-ser" title="A series: ${membersOf(t).length} properties in one video">Series · ${membersOf(t).length}</span>` : '');

// ── The edit, from the Shoot & Media board ──
// Where the video for a post stands: planned, being edited (and by whom, for how long), or done.
function editTag(t) {
  const l = listingOf(t), api = window.trackApi;
  if (!l || !api || !api.editOf) return '';
  const e = api.editOf(l);
  if (e.status === 'active') return `<span class="pg-ed act" title="Being edited now (from the board's Editor view)">✂ Editing${e.by ? ' · ' + esc(e.by) : ''}${e.startedAt ? ' · ' + esc(api.span(now() - e.startedAt)) : ''}</span>`;
  if (e.status === 'planned') return `<span class="pg-ed plan" title="Edit planned (from the board's Editor view)">✂ Edit planned${e.by ? ' · ' + esc(e.by) : ''}${e.planAt ? ' · ' + esc(G.dayLabel(e.planAt)) : ''}</span>`;
  if (e.status === 'done') return `<span class="pg-ed ok" title="Edit done${e.by ? ' by ' + esc(e.by) : ''}">✂ Edit done</span>`;
  return '';
}

// Every post of a board card's property (all its rounds) — or of a series card's series — for the
// board's Editor view: how many, how many with a time, how many live, and the next one.
window.pgPostsFor = l => {
  if (!l) return null;
  let rows;
  if (l.kind === 'series') {
    const sid = l.postingId || (trackers.find(t => G.isSeries(t) && t.listingId === l.id) || {}).id;
    rows = sid ? trackers.filter(t => t.id === sid || t.repostOf === sid) : [];
  } else {
    const k = G.codeKey(l.propertyCode) || G.codeKey(l.brochure && l.brochure.code);
    const root = k ? trackers.find(t => !t.repostOf && !G.isSeries(t) && G.codeKey(t.propertyCode) === k) : null;
    rows = root ? trackers.filter(t => t.id === root.id || t.repostOf === root.id) : [];
  }
  const out = { total: 0, scheduled: 0, live: 0, planned: 0, nextAt: 0, nextKey: '', planDay: 0, lastLiveAt: 0, rowId: rows[0] ? rows[0].id : '' };
  for (const t of rows) for (const k of G.CHANNEL_KEYS) {
    const c = t.channels[k];
    if (c.status === 'live') { out.total++; out.live++; out.lastLiveAt = Math.max(out.lastLiveAt, c.liveAt || c.at || 0); }
    else if (c.status === 'scheduled') { out.total++; out.scheduled++; if (!out.nextAt || c.at < out.nextAt) { out.nextAt = c.at; out.nextKey = k; } }
    else if (c.status === 'yet' && c.day) { out.total++; out.planned++; if (!out.planDay || c.day < out.planDay) out.planDay = c.day; }
  }
  return out;
};
// A series, for its board card: its name and its properties.
window.pgSeriesInfo = id => {
  const s = byId(id);
  if (!s || !G.isSeries(s)) return null;
  return { id: s.id, name: serName(s), members: membersOf(s), listingId: s.listingId };
};
// From the board: a series' row in the Series tab.
window.pgOpenSeries = id => {
  if (window.closeDetail && document.getElementById('dp') && document.getElementById('dp').classList.contains('open')) window.closeDetail();
  if (window.toggleView) window.toggleView('posting');
  mode = 'series'; try { localStorage.setItem(K_MODE, mode); } catch (e) {}
  filters = new Set(); focusId = id && byId(id) ? id : null; renderPosting();
};
// The board card a series is edited on: made with the series, and for a series that has none yet.
// Only from this tab's own actions (never off a snapshot), so two open tabs cannot make two cards.
// Returns the new card's id, or '' when none was made. `asked`: the "Add to the board" button — made
// even when Settings says new series get no card. A card that was deleted on the board counts as none.
function ensureCard(t, asked) {
  const api = window.trackApi;
  if (!t || !G.isSeries(t) || t.repostOf || !api || !api.createSeriesCard) return '';
  if (t.listingId && (!asked || listingOf(t))) return '';
  if (!asked && window.trackConfig && window.trackConfig().seriesBoardCard === false) return '';   // Settings → Configurations
  // Never two cards for one series: wait for the board's cards, and relink to one already made for it.
  if (api.listingsLoaded && !api.listingsLoaded()) return '';
  const had = (api.listings() || []).find(l => l.kind === 'series' && l.postingId === t.id);
  if (had) { tagMemo = null; const cur = byId(t.id); if (cur && cur.listingId !== had.id) persist({ ...cur, listingId: had.id }, '', true); return had.id; }
  const id = api.createSeriesCard({ title: serName(t), postingId: t.id });
  if (!id) return '';
  tagMemo = null;
  const cur = byId(t.id);
  if (cur) persist({ ...cur, listingId: id }, '', true);
  return id;
}
window.pgSeriesCard = id => {
  const t = byId(id); if (!t) return;
  toast(ensureCard(t, true) ? 'Added to the Shoot & Media board' : 'Could not add it to the board — try again once the board has loaded');
  renderPosting();
};
// Undo for an action that also made a board card: the card goes too.
const dropCard = id => { if (id && window.trackApi && window.trackApi.removeSeriesCard) window.trackApi.removeSeriesCard(id); };
// The board renamed a series card: the series is renamed with it, so it has one name everywhere.
window.pgSeriesRename = (id, name) => { const t = byId(id), v = String(name || '').trim(); if (t && v && G.isSeries(t) && v !== t.title) persist({ ...t, title: v }, '', true); };

// ── Tags ──
// A property has one set of tags: those of its listing on the board when there is one (matched by
// property code — a repost by its original's), else the row's own. Editing here edits that same set.
// Built once per render: property code → listing (the first listing with that code, as the board
// shows it), and each row's tags as worked out.
let tagMemo = null;
function memo() {
  if (tagMemo) return tagMemo;
  const byCode = new Map(), byId = new Map();
  for (const l of (window.trackApi && window.trackApi.listings()) || []) {
    byId.set(l.id, l);
    if (l.kind === 'series') continue;   // a series card is found by its id, never by a code
    for (const c of [l.propertyCode, l.brochure && l.brochure.code]) { const k = G.codeKey(c); if (k && !byCode.has(k)) byCode.set(k, l); }
  }
  return (tagMemo = { byCode, byId, tags: new Map() });
}
function listingOf(t) {
  const root = (t && t.repostOf && origOf(t)) || t;
  // A series' board card is the one it was made with.
  if (G.isSeries(root)) return root.listingId ? memo().byId.get(root.listingId) || null : null;
  const k = G.codeKey(root && root.propertyCode);
  return k ? memo().byCode.get(k) || null : null;
}
function tagsOf(t) {
  if (!t) return [];
  const m = memo();
  if (!m.tags.has(t.id)) { const l = listingOf(t); m.tags.set(t.id, TG.cleanTags(l ? l.tags : ((t.repostOf && origOf(t)) || t).tags)); }
  return m.tags.get(t.id);
}
// ── The brochure: made once per property, read from where it is made ──
// The board listing for this property (its brochure panel, fed by the brochure queue), else the
// Property dashboard's delivered brochure. A row ticked here before this was read from the board
// still counts. Nothing about the brochure is saved on a Posting row any more.
const BRO_LABEL = { created: 'Created', building: 'Built — being delivered', requested: 'Requested', none: 'Not created' };
let broMemo = null;
function broState(t) {
  if (!t) return { done: false, state: 'none' };
  const root = (t.repostOf && origOf(t)) || t;
  if (!broMemo) broMemo = new Map();
  if (broMemo.has(root.id)) return broMemo.get(root.id);
  const api = window.trackApi;
  const l = listingOf(root);
  const code = G.codeKey(root.propertyCode);
  const list = (api && api.inventory && api.inventory()) || inv || [];
  const prop = code ? list.find(q => G.codeKey(q.propertyCode) === code) : null;
  const url = v => (/^https?:\/\/\S+$/i.test(String(v || '').trim()) ? String(v).trim() : '');
  const link = url(l && l.brochureLink) || url(prop && prop.brochureLink);
  let r;
  const board = l && api && api.brochureOf ? api.brochureOf(l) : null;
  if (board === 'created') r = { state: 'created', src: 'board', link };
  else if (link) r = { state: 'created', src: 'dashboard', link };
  else if (board === 'building' || (prop && String(prop.brochureLink || '').trim())) r = { state: 'building', src: board === 'building' ? 'board' : 'dashboard' };
  else if (board === 'requested') r = { state: 'requested', src: 'board' };
  else if (root.brochure && root.brochure.done) r = { state: 'created', src: 'marked', by: root.brochure.by, at: root.brochure.at };
  else r = { state: 'none', src: l ? 'board' : '' };
  r.done = r.state === 'created';
  r.listingId = l ? l.id : null;
  broMemo.set(root.id, r);
  return r;
}
G.setBrochureSource(broState);
// Photos and details: a property with a board card keeps them on the card (the brochure is made from
// them, and they are edited there or here — one place). Without a card, the row's own.
function inputsFor(t) {
  const root = rootOf(t);
  if (!root || G.isSeries(root)) return { photosLink: (root && root.photosLink) || '', details: (root && root.details) || '', card: null };
  const l = listingOf(root);
  // With a card, the card is the one source (the row's own, from before, was moved onto it — adoptInputs).
  if (l) {
    // A card whose brochure is made cannot take the row's old values (adoptInputs skips it): show them.
    const lock = cardLocked(l);
    const lp = String(l.photosLink || '').trim(), ld = String(l.description || '').trim();
    return { photosLink: lp || (lock ? root.photosLink || '' : ''), details: ld || (lock ? root.details || '' : ''), card: l };
  }
  return { photosLink: root.photosLink || '', details: root.details || '', card: null };
}
// Rows that had their own photos / details before their property had a card: those move onto the card
// once, where it has none, so nothing typed earlier is lost — never onto a card whose brochure is made.
const adopted = new Set();
function adoptInputs() {
  const api = window.trackApi;
  if (!api || !api.mutate || !(api.listingsLoaded && api.listingsLoaded())) return;
  for (const t of trackers) {
    if (t.repostOf || G.isSeries(t) || adopted.has(t.id) || (!t.photosLink && !t.details)) continue;
    const l = listingOf(t);
    if (!l) continue;
    adopted.add(t.id);
    if (cardLocked(l)) continue;
    const patch = {};
    if (t.photosLink && G.isUrl(t.photosLink) && !String(l.photosLink || '').trim()) patch.photosLink = t.photosLink;
    if (t.details && !String(l.description || '').trim()) patch.description = t.details;
    if (Object.keys(patch).length) api.mutate(l.id, x => Object.assign(x, patch), 'Photos / details brought over from Posting');
  }
}
G.setInputsSource(inputsFor);
// The one place a brochure is made: the property's listing on the board, else the Create brochure page.
const broWhere = b => b.src === 'board' ? 'from the board' : b.src === 'dashboard' ? 'from the Property dashboard' : b.src === 'marked' ? 'marked here earlier' : '';
// A series' brochures are its properties': "2 of 3 created", and which are missing.
function serBroCell(t) {
  const ms = membersOf(t), done = ms.filter(m => m.brochure).length;
  const miss = ms.filter(m => !m.brochure).map(m => m.propertyCode || m.name);
  if (!ms.length) return '<span class="ps-ro">No properties yet</span>';
  return `<span class="ps-ro pg-bro ${done === ms.length ? 'ok' : 'warn'}">${done === ms.length ? '✓ ' : ''}${done} of ${ms.length} created</span>${miss.length ? `<div class="ps-sub">Missing: ${esc(miss.join(', '))}</div>` : '<div class="ps-sub">each property\'s own</div>'}`;
}
function broCell(t, small) {
  if (isSer(t)) return serBroCell(t);
  const b = broState(t);
  const open = b.link ? ` <a href="${href(b.link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">open ↗</a>` : '';
  const go = !b.done && b.state === 'none' ? `<button type="button" class="tk-link" onclick="pgBrochure(${jsq(rootOf(t).id)})">Create brochure</button>` : '';
  return `<span class="ps-ro pg-bro ${b.done ? 'ok' : b.state === 'none' ? '' : 'warn'}">${b.done ? '✓ ' : ''}${esc(BRO_LABEL[b.state])}${open}</span>${small !== false ? `<div class="ps-sub">${esc(broWhere(b))}${go ? (broWhere(b) ? ' · ' : '') + go : ''}</div>` : ''}`;
}
// Voice-over for a post, from the listing's Shoot for on the board: a V/O to be made separately
// shows here until it is made.
function voiceTag(t, key) {
  const l = listingOf(t), api = window.trackApi;
  if (!l || !api || !api.voiceOf) return '';
  const v = api.voiceOf(l, key);
  if (v.voice !== 'vo') return '';
  return v.made ? '<span class="pg-vo ok" title="Voice-over made (from the board)">🎙 V/O made</span>' : '<span class="pg-vo warn" title="Voice-over required separately and not made yet (from the board)">🎙 V/O pending</span>';
}
// What a post still lacks, on its own row: photos, details and the brochure (from the original row for
// a repost), and — once it is live — its link. A brochure already asked for says where it stands instead.
function needsHtml(t, key) {
  if (!t) return '';
  const root = (t.repostOf && origOf(t)) || t;
  const ed = editTag(t);
  if (G.isSeries(root)) {
    // A series: which of its properties still lack photos or a brochure.
    const ms = membersOf(t), miss = [];
    if (ms.length < 2) miss.push(ms.length ? 'More properties' : 'Properties');
    const np = ms.filter(m => !m.photosLink).map(m => m.propertyCode || m.name);
    const nb = ms.filter(m => !m.brochure).map(m => m.propertyCode || m.name);
    if (np.length) miss.push('Photos: ' + np.join(', '));
    if (nb.length) miss.push('Brochure: ' + nb.join(', '));
    const c = key && t.channels && t.channels[key];
    if (c && c.status === 'live' && !c.url) miss.push('Link');
    if (!miss.length && !ed) return '';
    return `<div class="pg-needs">${miss.length ? `<span class="pg-needs-l">Missing:</span>${miss.map(m => `<span class="pg-need">${esc(m)}</span>`).join('')}` : ''}${ed}</div>`;
  }
  const miss = [], inp = inputsFor(root);
  if (!String(inp.photosLink || '').trim()) miss.push('Photos');
  if (!String(inp.details || '').trim()) miss.push('Details');
  const b = broState(t);
  if (b.state === 'none') miss.push('Brochure');
  const c = key && t.channels && t.channels[key];
  if (c && c.status === 'live' && !c.url) miss.push('Link');
  const bro = b.state === 'requested' ? 'Brochure in queue' : b.state === 'building' ? 'Brochure being delivered' : '';
  if (!miss.length && !bro && !ed) return '';
  return `<div class="pg-needs">${miss.length ? `<span class="pg-needs-l">Missing:</span>${miss.map(m => `<span class="pg-need">${esc(m)}</span>`).join('')}` : ''}${bro ? `<span class="pg-need bro">${esc(bro)}</span>` : ''}${ed}</div>`;
}
window.pgBrochureGo = listingId => { if (window.toggleView) window.toggleView('board'); if (window.openDetail) window.openDetail(listingId); };

// The tag picker changed a listing's tags: show them here at once.
window.pgRedraw = () => { tagMemo = null; if (isOpen() && !dlg) renderPosting(); else stale = true; };
// A listings snapshot: tags may have changed — redraw on the next refresh (through the typing guard).
window.pgListingsChanged = () => { tagMemo = null; broMemo = null; memMemo = null; stale = true; badge(); };
function tagTarget(t) { const l = listingOf(t); return l ? 'l:' + l.id : 'p:' + (((t.repostOf && origOf(t)) || t).id); }
// Small and inline (it sits inside buttons): the week tiles, Today and the lists.
const miniTags = t => { const l = tagsOf(t); return l.length ? `<span class="tk-tags sm">${l.map(x => `<span class="tk-tag ${TG.tagClass(x)}">${esc(x)}</span>`).join('')}</span>` : ''; };
// The picker for a row's property (its listing's tags when it has one).
const tagPicker = (t, small, lazy) => window.tagEditorHtml ? window.tagEditorHtml(tagTarget(t), tagsOf(t), { small, lazy }) : tagChipsHtml(t);
const tagChipsHtml = t => { const l = tagsOf(t); return l.length ? `<div class="tk-tags">${l.map(x => `<span class="tk-tag ${TG.tagClass(x)}">${esc(x)}</span>`).join('')}</div>` : ''; };
// What the tag picker (tag-editor.js) needs from this tab.
window.pgOwnTags = id => (byId(id) || {}).tags || [];
window.pgOwnTagLists = () => trackers.map(t => t.tags);
window.pgSetTags = (id, list, what) => { const t = byId(id); if (t) { tagMemo = null; persist({ ...t, tags: TG.cleanTags(list) }, String(what || 'Tags saved')); } };
// Filters: the fixed ones must all hold; tag filters ('tag:<key>') — any one of them.
function passes(t, t0) {
  const keys = [...filters], tags = keys.filter(k => k.startsWith('tag:'));
  if (!keys.filter(k => !k.startsWith('tag:')).every(k => G.matchesFilter(t, k, t0))) return false;
  return !tags.length || tagsOf(t).some(x => tags.includes('tag:' + TG.tagKey(x)));
}
function worst(t) { const g = G.gaps(t, now()); return g.length ? g[0].sev : 0; }

const MODE_LABEL = { today: 'Today', week: 'Week', sheet: 'Sheet', cards: 'Properties', series: 'Series' };
// The number on each tab answers that tab's question: Today = how many things need you,
// Week = how many posts this week, Sheet / Cards = how many rows.
function urgentCount(base, t0) { return G.tasks(base, t0).reduce((n, g) => n + g.items.filter(i => i.sev >= 3).length, 0); }
function modeCount(m, base) {
  const t0 = now();
  if (m === 'today') return urgentCount(base, t0);
  if (m === 'week') { const a = G.weekAgenda(base, G.mondayOf(t0), t0); return a.days.reduce((n, d) => n + d.items.length, 0) + a.weekItems.length; }
  // Properties are properties; a series has its own tab.
  if (m === 'cards') return new Set(base.filter(t => !isSer(t)).map(t => (G.familyOf(trackers, t.id, fams())[0] || t).id)).size;
  if (m === 'series') return new Set(base.filter(isSer).map(t => rootOf(t).id)).size;
  return base.length;
}
// Every row's family, built once per render: the Sheet asks for it in every channel cell.
let famIdx = null;
const fams = () => famIdx || G.familyIndex(trackers);

function renderPosting() {
  const el = $('postingView');
  if (!el) return;
  renderWaiting = false; stale = false; shownQ = searchText();
  try { autoLink(); adoptInputs(); } catch (e) { console.error('auto-link:', e); }   // before the rows are read for drawing
  famIdx = G.familyIndex(trackers);
  tagMemo = null;   // listings and tags are looked up once per render (see listingOf)
  broMemo = null;   // …and each property's brochure state
  memMemo = null; serIdx = null;   // …and each series' properties
  try { drawPosting(el); } finally { famIdx = null; }
}
function drawPosting(el) {
  pinBelowHeader();
  const q = window.trackSearchText ? window.trackSearchText() : '';
  const base = trackers.filter(t => matchesSearch(t, q));
  const t0 = now();
  const s = G.summary(trackers, t0);
  const pl = G.planned(trackers, t0).length;
  const line = trackers.length
    ? `<b>${s.total}</b> row${s.total === 1 ? '' : 's'} · <b>${s.complete}</b> fully done · ` +
      `<b class="${s.attention ? 'pg-bad' : ''}">${s.attention}</b> need attention · <b>${s.scheduled}</b> post${s.scheduled === 1 ? '' : 's'} scheduled` +
      `${pl ? ` · <b>${pl}</b> planned, time not set` : ''}${s.due ? ` · <b class="pg-bad">${s.due} due now</b>` : ''}`
    : '';
  el.innerHTML = `
    <div class="pg-bar">
      <div class="tk-sortbar" role="group" aria-label="Posting view">
        ${MODES.map(m => { const n = modeCount(m, base); return `<button type="button" class="tk-sbtn${mode === m ? ' on' : ''}" aria-pressed="${mode === m}" onclick="pgMode(${jsq(m)})">${MODE_LABEL[m]} <span class="tk-n${m === 'today' && n ? ' hot' : ''}">${n}</span></button>`; }).join('')}
      </div>
      <div class="pg-bar-r">
        <button type="button" class="tk-btn" onclick="pgExport()">Export CSV</button>
        <button type="button" class="tk-btn" onclick="pgOpenPlan()">Paste week plan</button>
        <button type="button" class="tk-btn" onclick="pgOpenAdd()">Add property</button>
        <button type="button" class="tk-btn" onclick="pgOpenSeriesDlg('')">New series</button>
        <button type="button" class="tk-btn primary" onclick="pgOpenBulk()">+ Add schedule</button>
      </div>
    </div>
    ${line && mode !== 'today' ? `<div class="pg-summary">${line}</div>` : ''}
    ${mode === 'today' ? todayHtml(base) : mode === 'cards' ? propsHtml(base) : mode === 'sheet' ? sheetHtml(base) : mode === 'series' ? seriesHtml(base) : queueHtml(base)}`;
  if (focusId) {
    const c = document.getElementById('pg-' + focusId);
    if (c) { c.scrollIntoView({ block: 'center' }); c.classList.add('pg-flash'); }
    focusId = null;
  }
}

const emptyAll = () => `<div class="tk-empty"><div class="tk-empty-i">📣</div><div class="tk-empty-t">Nothing tracked yet</div>
  <div class="tk-empty-s">Paste this week's plan to start, or add a property you already have.</div>
  <p><button type="button" class="tk-btn primary" onclick="pgOpenPlan()">Paste week plan</button> <button type="button" class="tk-btn" onclick="pgOpenAdd()">+ Add property</button></p></div>`;
const noMatch = () => `<div class="tk-empty"><div class="tk-empty-t">Nothing matches</div><div class="tk-empty-s">Clear a filter or the search to see more.</div></div>`;

// The little code badge every view shows: the code, the original's code for a repost, or "no code".
function codeBadge(t, clickable) {
  if (isSer(t)) {
    const txt = (t.repostOf ? '↺ ' : '') + 'Series';
    return clickable ? `<button type="button" class="tk-code pg-codebtn ser" title="A series — open it" onclick="pgOpenSeries(${jsq(rootOf(t).id)})">${txt}</button>` : `<span class="tk-code ser">${txt}</span>`;
  }
  const o = origOf(t);
  const txt = t.repostOf ? '↺ ' + (codeOf(t) || 'repost') : (t.propertyCode || 'no code');
  const cls = 'tk-code' + (t.propertyCode || t.repostOf ? '' : ' none') + (clickable ? ' pg-codebtn' : '');
  const title = t.repostOf ? `Repost of ${o ? G.nameOf(o) : 'a deleted row'}` : t.propertyCode ? 'Property code' : 'No property code yet';
  return clickable
    ? `<button type="button" class="${cls}" title="${esc(title)} — open" onclick="pgFocus(${jsq(t.id)})">${esc(txt)}</button>`
    : `<span class="${cls}" title="${esc(title)}">${esc(txt)}</span>`;
}
function planBit(t) {
  if (t.plannedDate) return `<span class="pg-plan${t.plannedDate < G.startOfDay(now()) ? ' late' : ''}">🗓 ${esc(G.dayLabel(t.plannedDate))}</span>`;
  if (t.weekOf) return `<span class="pg-plan">🗓 ${esc(weekLabel(t.weekOf))}</span>`;
  return '';
}

// The page header stays on screen while you scroll, so the sheet's column names must pin just
// below it, not at the top of the window where the header would cover them. Its height changes
// with the screen width (the search box wraps), so it is measured rather than assumed.
function pinBelowHeader() {
  const h = document.getElementById('hdr');
  if (h) document.documentElement.style.setProperty('--pg-top', h.getBoundingClientRect().height + 'px');
}
window.addEventListener('resize', pinBelowHeader);

// ── To do: every open job, grouped by the work that clears it ──
const labelOf = k => (G.CHANNELS.find(c => c.key === k) || G.LISTINGS.find(c => c.key === k) || {}).label || k;
function taskActions(g, it) {
  const id = it.id, b = (label, js, cls) => `<button type="button" class="tk-btn sm${cls ? ' ' + cls : ''}" onclick="${js}">${esc(label)}</button>`;
  // A series' photos and brochures are its properties': open the series to see which and go to them.
  if (isSer(it.tracker) && (g.kind === 'photos' || g.kind === 'brochure')) return b('See its properties', `pgOpenSeries(${jsq(rootOf(it.tracker).id)})`, 'primary');
  switch (g.kind) {
    case 'members': return b('Add properties', `pgOpenSeriesDlg(${jsq(id)})`, 'primary');
    case 'due': return it.keys.map(k => b('Mark ' + labelOf(k) + ' posted', `pgChannel(${jsq(id)},${jsq(k)},'live')`, 'primary') + b('Reschedule', `pgChannel(${jsq(id)},${jsq(k)},'scheduled')`)).join('');
    case 'link': return it.keys.map(k => b('Add ' + labelOf(k) + ' link', G.CHANNEL_KEYS.includes(k) ? `pgLink(${jsq(id)},${jsq(k)})` : `pgListing(${jsq(id)},${jsq(k)},'posted')`, 'primary')).join('');
    case 'plan': return G.CHANNELS.map(c => `<button type="button" class="tk-btn sm" onclick="pgChannel(${jsq(id)},${jsq(c.key)},'scheduled')">${chLabel(c.key, c.label)}</button>`).join('');
    case 'brochure': return b('Create brochure', `pgBrochure(${jsq(id)})`, 'primary');
    case 'photos': case 'details': return b('Add it', `pgOpenEdit(${jsq(id)})`, 'primary');
    case 'code': return b('Add code', `pgOpenEdit(${jsq(id)})`, 'primary') + b('Tag a property…', `pgOpenTag(${jsq(id)})`);
    case 'yet': return it.keys.map(k => `<span class="pg-pair"><span class="pg-pair-n">${chLabel(k, labelOf(k))}</span>${b('Schedule', `pgChannel(${jsq(id)},${jsq(k)},'scheduled')`, 'primary')}${b('N/A', `pgChannel(${jsq(id)},${jsq(k)},'na')`)}</span>`).join('');
    case 'acres99': case 'website': return b('Mark posted', `pgListing(${jsq(id)},${jsq(g.kind)},'posted')`, 'primary') + b('N/A', `pgListing(${jsq(id)},${jsq(g.kind)},'na')`);
    case 'dashboard': return b('Link…', `pgOpenLink(${jsq(id)})`, 'primary');
    default: return '';
  }
}
// Task groups, drawn the same way in "Needs you now" and in "Everything else".
function taskGroupsHtml(groups) {
  return groups.map(g => `<section class="tk-group">
    <div class="tk-group-hdr ${g.kind === 'due' || g.kind === 'link' ? 'bad' : ''}">${esc(g.title)} <span class="tk-count">${g.items.length}</span><span class="pg-who">${esc(g.who)}</span></div>
    <div class="pg-hint">${esc(g.hint)}</div>
    <div class="tk-rows">${g.items.map(it => `<div class="tk-row pg-task${it.sev >= 3 ? ' hot' : ''}">
      <div class="tk-row-main">
        <div class="tk-row-top">${codeBadge(it.tracker, true)}<span class="tk-row-title">${esc(dn(it.tracker))}</span>${planBit(it.tracker)}</div>
        <div class="tk-row-meta"><span>${esc(it.tracker.location)}</span>${miniTags(it.tracker)}${it.tracker.note ? `<span class="pg-note">“${esc(it.tracker.note)}”</span>` : ''}</div>
      </div>
      <div class="pg-acts">${taskActions(g, it)}</div>
    </div>`).join('')}</div>
  </section>`).join('');
}

// ── Today: the home tab ──
// Built to be opened every morning and glanced at all day: four counts, then only what needs
// you now, then today's posts in time order, then the week. Everything routine (codes,
// brochures, 99 Acres…) waits, folded, at the bottom — present, counted, never in the way.
function todayHtml(base) {
  if (!trackers.length) return emptyAll();
  const t0 = now(), today = G.startOfDay(t0), monday = G.mondayOf(t0);
  const groups = G.tasks(base, t0);
  // A post due or missing its link TODAY is already in the Today list with the same buttons —
  // listing it twice is what makes a page feel disorganised, so it appears there only.
  const isToday = ts => ts && G.startOfDay(ts) === today;
  const onToday = (g, it) => (g.kind === 'due' || g.kind === 'link') && it.keys.length &&
    it.keys.every(k => { const c = it.tracker.channels[k]; return c && (isToday(c.at) || isToday(c.liveAt)); });
  const urgent = groups.map(g => ({ ...g, items: g.items.filter(i => i.sev >= 3 && !onToday(g, i)) })).filter(g => g.items.length);
  const later = groups.map(g => ({ ...g, items: g.items.filter(i => i.sev < 3) })).filter(g => g.items.length);
  const ag = G.weekAgenda(base, monday, t0);
  const todays = (ag.days.find(d => d.day === today) || { items: [] }).items;
  const due = G.upcoming(base, t0).filter(r => r.due).length;
  const links = G.liveMissingLink(base).length;
  const undecided = ag.counts.undecided;
  const nUrgent = urgent.reduce((n, g) => n + g.items.length, 0);
  const nLater = later.reduce((n, g) => n + g.items.length, 0);
  const weekTotal = ag.days.reduce((n, d) => n + d.items.length, 0) + ag.weekItems.length;
  const weekLive = ag.days.reduce((n, d) => n + d.items.filter(i => i.state === 'live').length, 0);
  const nextUp = todays.find(i => i.at && i.at > t0 && i.state === 'scheduled');
  const liveToday = todays.filter(i => i.state === 'live').length;

  // The one sentence the page leads with — what the day looks like, in plain words.
  let hero;
  if (due && nUrgent) hero = `<b>${due}</b> post${due === 1 ? ' is' : 's are'} overdue and <b>${nUrgent}</b> other thing${nUrgent === 1 ? '' : 's'} need${nUrgent === 1 ? 's' : ''} you.`;
  else if (due) hero = `<b>${due}</b> post${due === 1 ? '' : 's'} went past ${due === 1 ? 'its' : 'their'} time — confirm ${due === 1 ? 'it is' : 'they are'} live.`;
  else if (todays.length) hero = `<b>${todays.length}</b> post${todays.length === 1 ? ' goes' : 's go'} out today${liveToday ? `, <b>${liveToday}</b> already live` : ''}${nextUp ? `. Next up: ${esc(G.SHORT_CH[nextUp.key])} at ${esc(timeOf(nextUp.at))}` : ''}.`;
  else if (nUrgent) hero = `Nothing goes out today. <b>${nUrgent}</b> thing${nUrgent === 1 ? '' : 's'} need${nUrgent === 1 ? 's' : ''} you first.`;
  else hero = `Nothing goes out today. <b>${weekTotal}</b> post${weekTotal === 1 ? '' : 's'} planned this week.`;

  const kpi = (n, label, tone, icon, ctx, js, hint) => `<button type="button" class="kpi ${n ? tone : 'zero'}" onclick="${js}" title="${esc(hint)}">
      <span class="kpi-ic" aria-hidden="true"><i class="${icon}"></i></span>
      <span class="kpi-body"><b>${n}</b><span class="kpi-l">${esc(label)}</span><small>${ctx}</small></span>
    </button>`;
  const nextTxt = nextUp ? 'Next at ' + esc(timeOf(nextUp.at)) : (todays.length ? `${liveToday} of ${todays.length} live` : 'Nothing planned');
  return `
    <header class="pg-hero lux">
      <div class="eyebrow">${esc(G.formatDate(t0, F_LONG))}</div>
      <h2>${hero}</h2>
    </header>
    <div class="kpis">
      ${kpi(due, 'Due now — confirm', 'bad', 'fa-regular fa-clock', due ? 'Open the post, paste its link' : 'Nothing overdue', "pgScrollTo('pg-now')", 'Posts whose time has passed: confirm they are live and paste the link')}
      ${kpi(todays.length, 'Posting today', 'blue', 'fa-regular fa-paper-plane', nextTxt, "pgScrollTo('pg-today')", 'Everything planned or scheduled for today')}
      ${kpi(links, 'Live, link missing', 'bad', 'fa-solid fa-link-slash', links ? 'Add the link to close it' : 'Every live post has its link', "pgScrollTo('pg-now')", 'Posts confirmed live without their link')}
      ${kpi(undecided, 'Type not decided', 'warn', 'fa-regular fa-circle-question', undecided ? 'Story, Reel, FB or YouTube?' : 'Every plan line has a type', "pgMode('week')", 'Plan lines this week with no Story / Reel / FB / YouTube chosen yet')}
    </div>
    <div class="pg-two">
      <section class="pcard">
        <div class="pcard-h"><div><div class="eyebrow">This week</div><h3>${weekTotal} post${weekTotal === 1 ? '' : 's'} · ${weekLive} live</h3></div><button type="button" class="tk-link" onclick="pgMode('week')">Open the week</button></div>
        ${weekChartHtml(ag, t0)}
      </section>
      <section class="pcard">
        <div class="pcard-h"><div><div class="eyebrow">By platform</div><h3>This week</h3></div></div>
        ${platformTiles(ag)}
      </section>
    </div>
    <section class="pcard" id="pg-now">
      <div class="pcard-h"><div><div class="eyebrow">Needs you now</div><h3>${nUrgent ? `${nUrgent} thing${nUrgent === 1 ? '' : 's'} to fix` : 'All clear'}</h3></div></div>
      ${nUrgent ? nowListHtml(urgent) : `<div class="pt-clear"><span>✓</span> Nothing is late, due or missing a link.</div>`}
    </section>
    <section class="pcard" id="pg-today">
      <div class="pcard-h"><div><div class="eyebrow">Today</div><h3>${todays.length ? `${todays.length} post${todays.length === 1 ? '' : 's'}` : 'Nothing planned'}</h3></div></div>
      ${todays.length ? `<div class="pt-list">${todays.map(todayRow).join('')}</div>` : '<div class="pt-clear muted">Nothing goes out today.</div>'}
    </section>
    ${weekStrip(base)}
    ${nLater ? `<details class="pt-later pcard" ${laterOpen ? 'open' : ''} ontoggle="pgLaterToggle(this.open)">
      <summary><span class="pt-later-t">Everything else</span><span class="tk-count">${nLater}</span><span class="pt-sub">codes, brochures, photos, 99 Acres, website, scheduling — nothing urgent</span></summary>
      ${taskGroupsHtml(later)}
    </details>` : ''}`;
}

// ── Posts per day: a stacked column chart, drawn by hand so it matches the page ──
// Columns ≤ 24px, 4px rounded cap on the top segment only, 2px surface gaps between segments,
// the day total labelled on the cap, states in the legend (and in the tooltip) — never colour alone.
const CH_STATE = { live: 'live', scheduled: 'scheduled', due: 'overdue', late: 'overdue', nolink: 'overdue', planned: 'planned', undecided: 'planned' };
const CH_ORDER = ['live', 'scheduled', 'planned', 'overdue'];
const CH_LABEL = { live: 'Live', scheduled: 'Scheduled', planned: 'Planned, no time', overdue: 'Overdue / link missing' };
function weekChartHtml(ag, t0) {
  const today = G.startOfDay(t0);
  const days = ag.days.map(d => {
    const n = { live: 0, scheduled: 0, planned: 0, overdue: 0 };
    for (const it of d.items) n[CH_STATE[it.state] || 'planned']++;
    return { day: d.day, n, total: d.items.length };
  });
  const max = Math.max(1, ...days.map(d => d.total));
  const W = 420, H = 150, padT = 22, padB = 24, plotH = H - padT - padB, slot = W / 7, bw = 22, gap = 2;
  const y = v => plotH * v / max;
  const cols = days.map((d, i) => {
    const x = i * slot + (slot - bw) / 2;
    let acc = 0, segs = '';
    const parts = CH_ORDER.filter(k => d.n[k]);
    parts.forEach((k, j) => {
      const h = y(d.n[k]), top = padT + plotH - acc - h;
      const isTop = j === parts.length - 1, hh = Math.max(0, h - (j ? gap : 0));
      const r = isTop ? 4 : 0;
      // A rounded cap only on the top segment; square where it meets the segment below.
      const path = r && hh > r
        ? `M${x},${top + hh} v${-(hh - r)} q0,-${r} ${r},-${r} h${bw - 2 * r} q${r},0 ${r},${r} v${hh - r} z`
        : `M${x},${top + hh} v${-hh} h${bw} v${hh} z`;
      segs += `<path class="wc-seg wc-${k}" d="${path}"><title>${esc(G.dayLabel(d.day))} · ${d.n[k]} ${CH_LABEL[k].toLowerCase()}</title></path>`;
      acc += h;
    });
    const label = d.total ? `<text class="wc-val" x="${x + bw / 2}" y="${padT + plotH - acc - 6}" text-anchor="middle">${d.total}</text>` : '';
    const dl = G.formatDate(d.day, F_WD);
    return `<g class="wc-col${d.day === today ? ' today' : ''}">${segs}${label}<text class="wc-day" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${dl}</text></g>`;
  }).join('');
  const base = padT + plotH;
  return `<figure class="wc">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Posts per day this week" preserveAspectRatio="none">
      <line class="wc-axis" x1="0" y1="${base + .5}" x2="${W}" y2="${base + .5}"/>
      ${cols}
    </svg>
    <figcaption class="wc-legend">${CH_ORDER.map(k => `<span class="wc-lg ${k}"><i></i>${CH_LABEL[k]}</span>`).join('')}</figcaption>
  </figure>`;
}

// ── By platform: a tile per place, in its own colour, with this week's count and how many are live ──
function platformTiles(ag) {
  const live = {}, all = {};
  for (const d of ag.days) for (const it of d.items) { if (!it.key) continue; all[it.key] = (all[it.key] || 0) + 1; if (it.state === 'live') live[it.key] = (live[it.key] || 0) + 1; }
  for (const it of ag.weekItems) all[it.key] = (all[it.key] || 0) + 1;
  return `<div class="plats">${G.CHANNELS.map(c => {
    const n = all[c.key] || 0, l = live[c.key] || 0;
    return `<button type="button" class="plat ch-${c.key}${n ? '' : ' none'}" onclick="pgMode('week')" title="${esc(c.label)} this week — open the week">
      <span class="plat-top">${chIcon(c.key)}<span class="plat-l">${esc(c.label)}</span></span>
      <b>${n}</b>
      <small>${n ? (l ? `${l} live · ${n - l} to go` : `${n} to go`) : 'None this week'}</small>
    </button>`;
  }).join('')}${ag.counts.undecided ? `<button type="button" class="plat ch-none" onclick="pgMode('week')" title="Plan lines with no type yet"><span class="plat-top">${chIcon(null)}<span class="plat-l">Not decided</span></span><b>${ag.counts.undecided}</b><small>pick a type</small></button>` : ''}</div>`;
}

const NOW_TAG = { due: 'Overdue', link: 'Link missing', plan: 'Pick a type', brochure: 'Brochure needed', yet: 'Day passed', photos: 'No photos', details: 'No details', code: 'No code' };
function nowListHtml(groups) {
  const rows = [];
  for (const g of groups) for (const it of g.items) rows.push({ g, it });
  return `<div class="pt-list">${rows.map(({ g, it }) => `<div class="pt-now">
    <span class="pt-tag">${esc(NOW_TAG[g.kind] || g.title)}</span>
    <span class="pt-what">${it.keys.filter(k => G.CHANNEL_KEYS.includes(k)).map(k => chIcon(k)).join('')}
      <button type="button" class="pt-name" onclick="pgJump(${jsq(it.id)})" title="Open in the sheet">${esc(dn(it.tracker))}${serBadge(it.tracker)}${refHtml(it.tracker, 'pg-ref')}${miniTags(it.tracker)}</button>
      ${planBit(it.tracker)}</span>
    <span class="pt-acts">${taskActions(g, it)}</span>
  </div>`).join('')}</div>`;
}

// One of today's posts: what it is, when, and the one thing to do about it.
function todayRow(it) {
  const time = it.at ? timeOf(it.at) : 'Time not set';
  const type = it.key ? G.SHORT_CH[it.key] : 'Type not decided';
  return `<div class="pt-row ws-${it.state}">
    <span class="pt-time">${esc(time)}</span>
    <span class="pt-type">${chLabel(it.key, type)}</span>
    <span class="pt-namecol"><button type="button" class="pt-name" onclick="pgJump(${jsq(it.id)})" title="Open in the sheet">${esc(dn(it.tracker))}${serBadge(it.tracker)}${refHtml(it.tracker, 'pg-ref')}${miniTags(it.tracker)}</button>${needsHtml(it.tracker, it.key)}</span>
    <span class="pt-state">${esc(STATE_TXT[it.state])}</span>
    <span class="pt-acts">${itemActions(it)}</span>
  </div>`;
}
// The right buttons for a post in a given state — shared by Today, the week tiles' quick menu.
function itemActions(it, big) {
  const id = it.id, k = it.key, sz = big ? '' : ' sm';
  const b = (label, js, cls) => `<button type="button" class="tk-btn${sz}${cls ? ' ' + cls : ''}" onclick="${js}">${label}</button>`;
  if (!k) return G.CHANNELS.map(c => b(chLabel(c.key, c.label), `pgChannel(${jsq(id)},${jsq(c.key)},'scheduled')`)).join('') + b('Not posting — take it off the plan', `pgUnplan(${jsq(id)})`, 'ghost');
  const c = it.tracker.channels[k];
  switch (it.state) {
    case 'due': return b('Mark live', `pgChannel(${jsq(id)},${jsq(k)},'live')`, 'primary') + b('Reschedule', `pgChannel(${jsq(id)},${jsq(k)},'scheduled')`);
    case 'scheduled': return b('Mark live', `pgChannel(${jsq(id)},${jsq(k)},'live')`) + b('Reschedule', `pgChannel(${jsq(id)},${jsq(k)},'scheduled')`);
    case 'nolink': return b('Add link', `pgLink(${jsq(id)},${jsq(k)})`, 'primary');
    case 'planned': case 'late': return b('Set time', `pgChannel(${jsq(id)},${jsq(k)},'scheduled')`, 'primary') + b('N/A', `pgChannel(${jsq(id)},${jsq(k)},'na')`);
    case 'live': return c && c.url ? `<a class="tk-btn${sz}" href="${href(c.url)}" target="_blank" rel="noopener">View post ↗</a>` : '';
    default: return '';
  }
}
window.pgScrollTo = id => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
window.pgLaterToggle = open => { laterOpen = open; };

// One line per earlier / later round of a property on a channel.
const H_TXT = { live: 'Live', scheduled: 'Scheduled', yet: 'Planned' };
const shortDate = ts => ts ? G.formatDate(ts, F_DM) : '';
function histLines(list) {
  if (!list.length) return '';
  list = list.map(x => ({ ...x, many: true }));
  return `<div class="ps-hist">${list.map(x => {
    const inner = `<i></i>${esc(H_TXT[x.status] || x.status)} · ${esc(shortDate(x.when))}`;
    return x.url
      ? `<a class="ps-h h-${x.status}" href="${href(x.url)}" target="_blank" rel="noopener" title="Open that post">${inner} ↗</a>`
      : `<button type="button" class="ps-h h-${x.status}" onclick="pgJump(${jsq(x.rowId)})" title="Open that round">${inner}</button>`;
  }).join('')}</div>`;
}

// ── Sheet: one row per property, every cell editable in place ──
// Reads like a spreadsheet, but quiet: hairline rows, no boxes until you point at something,
// and colour only where a cell means something (live, scheduled, due, link missing). The code
// and dashboard state sit under the name so the posting columns get the room.
const ICON_EDIT = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 3.5l3 3L7 16H4v-3z"/><path d="M11.5 5.5l3 3"/></svg>';
const SHORT = { yet: 'To schedule', scheduled: 'Scheduled', live: 'Live', na: 'N/A' };
const SHORT_L = { pending: 'Not posted', posted: 'Posted', na: 'N/A' };
const shortWhen = ts => G.formatDate(ts, F_WHEN);

function sheetCell(t, key, label, t0, focus) {
  const id = t.id;
  // A channel going out in this row's week is framed and carries its day on top; the other
  // channels step back so the reason the row is here reads first.
  const isCh = G.CHANNEL_KEYS.includes(key);
  const fday = isCh && focus ? focus.days.find(d => d.keys.includes(key)) : null;
  const inFocus = isCh && focus && focus.keys.includes(key);
  const fcls = !isCh || !focus || !focus.keys.length ? '' : inFocus ? ' focus' : ' dim';
  const ftag = inFocus ? `<div class="ps-ftag">${fday ? esc(shortDay(fday.day)) : 'This week'}</div>` : '';
  const cell = (cls, inner) => `<div class="ps-cell ${cls || ''}${fcls}" role="cell" data-l="${esc(label)}">${ftag}${inner}</div>`;
  const sub = h => (h ? `<div class="ps-sub">${h}</div>` : '');
  if (G.CHANNEL_KEYS.includes(key)) {
    const v = G.channelView(t.channels[key], t0);
    const lateDay = v.status === 'yet' && v.day && v.day < G.startOfDay(t0);
    const tone = v.due || v.linkMissing || lateDay ? 'bad' : v.status === 'yet' && v.day ? 'plan' : v.status;
    const opts = G.STATUS_ORDER.map(s => `<option value="${s}"${v.status === s ? ' selected' : ''}>${s === 'yet' && v.day ? 'Planned' : SHORT[s]}</option>`).join('');
    let h = '';
    if (v.status === 'scheduled') h = v.due ? `<span class="ps-bad">Due · ${esc(shortWhen(v.at))}</span>` : esc(shortWhen(v.at));
    else if (v.status === 'live') h = (v.url ? `<a class="ps-link" href="${href(v.url)}" target="_blank" rel="noopener">View post ↗</a>` : `<button type="button" class="pg-warnbtn ps-bad" onclick="pgLink(${jsq(id)},${jsq(key)})">Add link</button>`)
      + `<div class="ps-livet">Live ${esc(shortWhen(v.liveAt || v.at))}${v.at && G.startOfDay(v.at) !== G.startOfDay(v.liveAt || v.at) ? ` · sched. ${esc(shortWhen(v.at))}` : ''} <button type="button" class="tk-link" onclick="pgLiveEdit(${jsq(id)},${jsq(key)})" title="Change when it went live, or its link">change</button></div>`;
    else if (v.status === 'yet' && v.day) h = `<span class="${lateDay ? 'ps-bad' : 'ps-planned'}">Plan ${esc(G.dayLabel(v.day))}</span>`;
    // Other rounds of the same property on this channel: earlier ones above this round's pill,
    // later ones below — so a repost reads "Live 12 Aug ↗" then "Scheduled 9 Oct", in one cell.
    const hist = G.channelHistory(trackers, id, key, fams());
    const mine = hist.findIndex(x => x.rowId === id);
    const myWhen = mine >= 0 ? hist[mine].when : Infinity;
    const others = hist.filter(x => x.rowId !== id);
    const before = others.filter(x => (x.when || 0) <= myWhen), after = others.filter(x => (x.when || 0) > myWhen);
    const pill = `<select class="pg-sel ps-pill t-${tone}" aria-label="${esc(label)} status" title="${esc(G.STATUS_LABEL[v.status])}" onchange="pgChannel(${jsq(id)},${jsq(key)},this.value)">${opts}</select>`;
    return cell(v.due || v.linkMissing || lateDay ? 'hot' : '', `${histLines(before)}${pill}${sub(h)}${voiceTag(t, key) ? `<div class="ps-sub">${voiceTag(t, key)}</div>` : ''}${histLines(after)}`);
  }
  if (key === 'acres99' && isSer(t)) return cell('ps-orig', '<span class="ps-faint">Not for a series</span>');
  if (t.repostOf) {
    const o = origOf(t);
    if (!o) return cell('ps-orig', '<span class="ps-faint">Original deleted</span>');
    if (key === 'brochure') return cell('ps-orig', broCell(o));
    const x = o[key];
    const txt = x.status === 'posted' ? (x.url ? `<a class="ps-ro ok" href="${href(x.url)}" target="_blank" rel="noopener">✓ Posted ↗</a>` : '<span class="ps-ro warn">Posted, no link</span>') : x.status === 'na' ? '<span class="ps-ro">N/A</span>' : '<span class="ps-ro">Not posted</span>';
    return cell('ps-orig', `${txt}<div class="ps-sub">from original</div>`);
  }
  if (key === 'brochure') {
    return cell('', broCell(t));
  }
  const x = t[key];
  const tone = x.status === 'posted' ? (x.url ? 'live' : 'bad') : x.status === 'na' ? 'na' : 'yet';
  const opts = Object.keys(G.LISTING_LABEL).map(s => `<option value="${s}"${x.status === s ? ' selected' : ''}>${SHORT_L[s]}</option>`).join('');
  const h = x.status === 'posted' ? (x.url ? `<a class="ps-link" href="${href(x.url)}" target="_blank" rel="noopener">View listing ↗</a>` : `<button type="button" class="pg-warnbtn ps-bad" onclick="pgListing(${jsq(id)},${jsq(key)},'posted')">Add link</button>`) : '';
  return cell(x.status === 'posted' && !x.url ? 'hot' : '', `<select class="pg-sel ps-pill t-${tone}" aria-label="${esc(label)} status" onchange="pgListing(${jsq(id)},${jsq(key)},this.value)">${opts}</select>${sub(h)}`);
}

// Under the name: the code (or a field to add it), the dashboard state, what media has sent.
// A series' properties as chips: amber when one still lacks photos or a brochure. Each opens that
// property's own row, where its own posts are.
function memberChips(t) {
  const ms = membersOf(t);
  if (!ms.length) return '<span class="ps-faint">No properties yet</span>';
  return ms.map(m => {
    const miss = [!m.photosLink && 'photos', !m.brochure && 'brochure'].filter(Boolean);
    const tip = `${m.name}${m.propertyCode ? ' (' + m.propertyCode + ')' : ''} — ${miss.length ? 'missing ' + miss.join(' and ') : 'photos and brochure in'}${m.trackerId ? ' · open its own row' : ' · not on the tracker'}`;
    const lbl = esc(m.propertyCode || m.name) + (miss.length ? ' <i aria-hidden="true">!</i>' : '');
    return m.trackerId
      ? `<button type="button" class="ps-mem${miss.length ? ' warn' : ' ok'}" title="${esc(tip)}" onclick="pgJump(${jsq(m.trackerId)})">${lbl}</button>`
      : `<span class="ps-mem${miss.length ? ' warn' : ' ok'}" title="${esc(tip)}">${lbl}</span>`;
  }).join('');
}
// Where a property's series are named on its own row: "In: T Nagar series".
const inSeries = t => seriesFor(t).map(s => `<button type="button" class="ps-mini ser" onclick="pgOpenSeries(${jsq(s.id)})" title="This property is also in a series — its own posts stay its own">In: ${esc(serName(s))}</button>`).join('');
function sheetIdentity(t) {
  const id = t.id;
  if (isSer(t)) {
    const s = rootOf(t), l = listingOf(t);
    const card = l ? `<button type="button" class="ps-mini ok" onclick="pgBrochureGo(${jsq(l.id)})" title="Its edit, on the Shoot & Media board">On the board</button>`
      : !t.repostOf ? `<button type="button" class="ps-mini warn" onclick="pgSeriesCard(${jsq(s.id)})">Add to the board</button>` : '';
    return `<div class="ps-ident">${t.repostOf ? `<button type="button" class="ps-tag ps-repost" onclick="pgOpenSeries(${jsq(s.id)})">↺ Again: ${esc(serName(s))}</button>` : `<span class="ps-code ser">Series · ${membersOf(t).length}</span><button type="button" class="ps-mini" onclick="pgOpenSeriesDlg(${jsq(s.id)})">Properties</button>${card}`}</div>
      <div class="ps-ident ps-mems">${memberChips(t)}</div>${editTag(t) ? `<div class="ps-ident">${editTag(t)}</div>` : ''}`;
  }
  if (t.repostOf) {
    const o = origOf(t);
    return `<button type="button" class="ps-tag ps-repost" onclick="pgFocus(${jsq(t.repostOf)})" title="Open the original">↺ Repost of ${esc(o ? (o.propertyCode || G.nameOf(o)) : 'a deleted row')}</button>`;
  }
  let code;
  if (!t.propertyCode) {
    code = `<input class="pg-in pg-code-in ps-codein" type="text" placeholder="+ Add code" aria-label="Property code" onchange="pgSetCode(${jsq(id)},this.value)">
      <button type="button" class="ps-mini" onclick="pgOpenTag(${jsq(id)})" title="Already tracked or in the dashboard? Tag it">Tag property</button>`;
  } else {
    const match = !t.propertyId ? invFor(t) : null;
    code = `<span class="ps-code">${esc(t.propertyCode)}</span>` + (t.propertyId
      ? `<a class="ps-mini ok" href="dashboard.html?property=${encodeURIComponent(t.propertyCode)}" target="_blank" rel="noopener" title="Open in the Property dashboard">In dashboard ↗</a>`
      : match ? `<button type="button" class="ps-mini warn" onclick="pgLinkTo(${jsq(id)},${jsq(match.id)})">Link dashboard</button>`
        : `<button type="button" class="ps-mini warn" onclick="pgOpenLink(${jsq(id)})">Not in dashboard</button>`);
  }
  const dot = (ok, label) => `<button type="button" class="ps-dot pg-chip ${ok ? 'ok' : 'no'}" onclick="pgOpenEdit(${jsq(id)})" title="${label} ${ok ? 'received — click to edit' : 'not received — click to add'}">${label}</button>`;
  const inp = inputsFor(t);
  return `<div class="ps-ident">${code}</div><div class="ps-ident">${dot(!!inp.photosLink, 'Photos')}${dot(!!inp.details, 'Details')}${inSeries(t)}</div>${editTag(t) ? `<div class="ps-ident">${editTag(t)}</div>` : ''}`;
}

function sheetRow(t, cols, t0, wk) {
  const focus = G.rowFocus(t, wk || undefined);
  const id = t.id;
  const nameField = t.title ? 'title' : 'reference';
  const late = t.plannedDate && t.plannedDate < G.startOfDay(t0) && G.gaps(t, t0).some(g => g.kind === 'plan' || (g.kind === 'yet' && g.sev >= 3));
  const dateTxt = t.plannedDate ? G.dayLabel(t.plannedDate) : '';
  const date = `<label class="ps-date${late ? ' late' : ''}${dateTxt || t.weekOf ? '' : ' empty'}" title="Planned date — click to change">
      <span>${dateTxt ? esc(dateTxt) : (focus.days.length ? '' : t.weekOf ? esc(weekLabel(t.weekOf)) : 'Set date')}</span>
      <input class="pg-date" type="date" value="${dateInput(t.plannedDate)}" aria-label="Planned date" onclick="try{this.showPicker()}catch(e){}" onchange="pgSetDay(${jsq(id)},this.value)">
    </label>`;
  const refLine = t.title && t.reference && t.reference !== t.title ? `<div class="ps-ref" title="As it was in the plan">Plan: ${esc(t.reference)}</div>` : '';
  const note = t.note ? `<div class="ps-note" title="${esc(t.note)}">${esc(t.note)}</div>` : '';
  return `<div class="ps-row ps-grid${G.overall(t, t0) === 'attention' ? ' attn' : ''}${t.repostOf ? ' repost' : ''}" id="pg-${esc(id)}" role="row">
    <div class="ps-cell ps-datecell" role="cell" data-l="Planned">${focus.days.length ? `<div class="ps-goes">${focus.days.map(d => `<div class="ps-go${G.startOfDay(t0) === d.day ? ' today' : ''}${d.day < G.startOfDay(t0) && d.keys.some(k => t.channels[k].status === 'yet') ? ' late' : ''}"><b>${esc(G.dayLabel(d.day))}</b><span>${d.keys.map(k => chIcon(k)).join('')}</span></div>`).join('')}</div>` : ''}${!focus.days.length || (dateTxt && !focus.days.some(d => d.day === t.plannedDate)) ? date : `<div class="ps-setdate">${date}</div>`}</div>
    <div class="ps-cell ps-prop" role="cell">
      <div class="ps-namerow">
        <textarea class="pg-in pg-name ps-name" rows="1" placeholder="Reference or title" aria-label="${nameField === 'title' ? 'Title' : 'Reference'}" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}" onchange="pgSetName(${jsq(id)},this.value)">${esc(t[nameField])}</textarea>
        <button type="button" class="ps-icon ps-edit" onclick="pgOpenEdit(${jsq(id)})" title="Edit details" aria-label="Edit details">${ICON_EDIT}</button>
      </div>
      ${refLine}${sheetIdentity(t)}<div class="ps-tags">${tagPicker(t, true, true)}</div>${note}
    </div>
    ${cols.map(([k, label]) => sheetCell(t, k, label, t0, focus)).join('')}
  </div>`;
}
// ── The week at a glance: what goes out each day, and as what ──
// Answers "this week, is it a Story, a Reel or both?" without reading the rows: seven days, each
// post with its type and a status colour, and the totals by type above.
const PLURAL = { igStory: ['Story', 'Stories'], igReel: ['Reel', 'Reels'], fbReel: ['FB Reel', 'FB Reels'], yt: ['YouTube', 'YouTube'] };
const STATE_TXT = { live: 'Live', nolink: 'Live — link missing', scheduled: 'Scheduled', due: 'Due — confirm posted', planned: 'Planned, time not set', late: 'Planned day passed', undecided: 'Type not decided yet' };
function weekStrip(base, hideable) {
  const t0 = now(), monday = G.addDays(G.mondayOf(t0), weekOffset * 7);
  const a = G.weekAgenda(base, monday, t0);
  const sun = G.addDays(monday, 6);
  const range = G.formatDate(monday, F_DM) + ' – ' + G.formatDate(sun, F_DM);
  const name = weekOffset === 0 ? 'This week' : weekOffset === 1 ? 'Next week' : weekOffset === -1 ? 'Last week' : 'Week';
  const c = a.counts;
  const counts = G.CHANNELS.filter(ch => c[ch.key]).map(ch => `<span class="wk-c">${chIcon(ch.key)}<b>${c[ch.key]}</b> ${PLURAL[ch.key][c[ch.key] === 1 ? 0 : 1]}</span>`).join('');
  const today = G.startOfDay(t0);
  const item = it => {
    const time = it.at ? timeOf(it.at) : '';
    const type = it.key ? G.SHORT_CH[it.key] : 'Not decided';
    return `<button type="button" class="wk-it ws-${it.state}" onclick="pgTile(${jsq(it.id)},${jsq(it.key || '')},${jsq(it.state)})" title="${esc(type + ' · ' + dn(it.tracker) + ' · ' + STATE_TXT[it.state])}">
      <span class="wk-row1"><span class="wk-ch ch-${it.key || 'none'}">${chIcon(it.key)}${esc(type)}</span>${time ? `<span class="wk-tm">${esc(time)}</span>` : ''}</span>
      <span class="wk-nm">${esc(dn(it.tracker))}</span>
      ${serBadge(it.tracker)}${refHtml(it.tracker, 'wk-ref')}
      ${miniTags(it.tracker)}
    </button>`;
  };
  return `<section class="wk" aria-label="Week at a glance">
    <div class="wk-top">
      <div class="wk-nav">
        <button type="button" class="wk-arrow" onclick="pgWeek(-1)" aria-label="Previous week">‹</button>
        <div class="wk-title"><b>${name}</b><span>${esc(range)}</span></div>
        <button type="button" class="wk-arrow" onclick="pgWeek(1)" aria-label="Next week">›</button>
        ${weekOffset ? '<button type="button" class="wk-today" onclick="pgWeek(0)">Back to this week</button>' : ''}
        ${hideable ? '<button type="button" class="wk-hide" onclick="pgSheetWeek(false)" title="Give the sheet the whole screen">Hide week</button>' : ''}
      </div>
      <div class="wk-counts">${counts || '<span class="wk-c none">Nothing planned or scheduled</span>'}</div>
    </div>
    <div class="wk-days">${a.days.map(d => { const shown = d.items.filter(it => it.key); return `<div class="wk-day${d.day === today ? ' today' : ''}${d.day < today ? ' past' : ''}">
        <div class="wk-dh"><span>${G.formatDate(d.day, F_WD)}</span><b>${new Date(d.day).getDate()}</b></div>
        <div class="wk-items">${shown.length ? shown.map(item).join('') : '<span class="wk-empty">—</span>'}</div>
      </div>`; }).join('')}</div>
    ${a.weekItems.length ? `<div class="wk-week">Also this week: ${a.weekItems.map(it => `<button type="button" class="wk-it ws-planned inline" onclick="pgJump(${jsq(it.id)})"><span class="wk-ch ch-${it.key}">${chIcon(it.key)}${esc(G.SHORT_CH[it.key])}</span><span class="wk-nm">${esc(dn(it.tracker))}</span>${miniTags(it.tracker)}</button>`).join('')}</div>` : ''}
    <div class="wk-legend"><span class="lg live">Live</span><span class="lg scheduled">Scheduled</span><span class="lg planned">Planned, time not set</span><span class="lg due">Due / day passed / link missing</span></div>
  </section>`;
}
// A plan line with no type yet is not a post: the week shows posts only, so it is not on the week at
// all — it is listed under "Planned — time not set", where its type is picked or it is taken off the plan.
// A week tile → the actions for that post, right there.
window.pgTile = (id, key, state) => {
  const t = byId(id); if (!t) return;
  dlg = { kind: 'quick', id, key };
  const it = { id, key: key || null, state, tracker: t };
  const type = key ? G.SHORT_CH[key] : 'Type not decided';
  const c = key && t.channels[key];
  const when = c && (c.at || c.day) ? (c.at ? fmt(c.at) : 'Planned ' + G.dayLabel(c.day) + ', time not set') : t.plannedDate ? 'Planned ' + G.dayLabel(t.plannedDate) : '';
  $('pgSave').style.display = 'none'; $('pgErr').textContent = '';
  $('pgModal').querySelector('.tk-box').classList.remove('wide');
  $('pgTitle').innerHTML = chLabel(key || null, type);
  $('pgBody').innerHTML = `<div class="qk">
      <div class="qk-name">${esc(dn(t))}</div>
      <div class="qk-meta">${when ? esc(when) + ' · ' : ''}<span class="qk-state ws-${state}">${esc(STATE_TXT[state] || '')}</span></div>
      ${key ? '' : '<p class="tk-hint">Pick what it will go out as — you set the time next.</p>'}
      <div class="qk-acts">${itemActions(it, true)}</div>
      <div class="qk-tags"><span class="qk-l">Tags</span>${tagPicker(t, true)}</div>
      <button type="button" class="tk-link qk-open" onclick="pgJump(${jsq(id)})">Open the row in the sheet</button>
    </div>`;
  $('pgModal').classList.add('open');
};
// Not posting this one: it leaves the plan (its day is free again); the row itself stays, with Undo.
window.pgUnplan = id => {
  const t = byId(id); if (!t) return;
  if (dlg) closeQuiet();
  persist({ ...t, plannedDate: 0 }, 'Taken off the plan');
};
window.pgSheetWeek = on => { sheetWeek = !!on; try { localStorage.setItem('posting.sheetWeek', on ? 'on' : 'off'); } catch (e) {} renderPosting(); };
window.pgWeek = d => { weekOffset = d === 0 ? 0 : weekOffset + d; renderPosting(); };
// From the week strip to the row: stay on the Sheet (or go to it) and light the row up.
window.pgJump = id => {
  if (!byId(id)) return;
  if (dlg) closeQuiet();
  if (mode !== 'sheet') { mode = 'sheet'; try { localStorage.setItem(K_MODE, mode); } catch (e) {} }
  filters = new Set(); order = null; focusId = id; renderPosting();
};

// Totals for the rows on screen: what the filter and search have left.
function sheetFoot(list, cols, t0) {
  const own = list.filter(t => !t.repostOf);
  const cell = (k, label) => {
    let big, small;
    if (G.CHANNEL_KEYS.includes(k)) {
      let live = 0, sch = 0, todo = 0;
      for (const t of list) { const v = G.channelView(t.channels[k], t0); if (v.status === 'live') live++; else if (v.status === 'scheduled') sch++; else if (v.status === 'yet') todo++; }
      big = `${live} live`; small = `${sch} sched · ${todo} to do`;
    } else if (k === 'brochure') {
      const props = own.filter(t => !isSer(t));   // a series' brochures are its properties'
      big = `${props.filter(t => broState(t).done).length} of ${props.length}`; small = 'created';
    } else {
      const d = own.filter(t => t[k].status === 'posted').length, na = own.filter(t => t[k].status === 'na').length;
      big = `${d} posted`; small = na ? `${na} not needed` : `of ${own.length}`;
    }
    return `<div class="ps-cell ps-fcell" data-l="${esc(label)}"><b>${big}</b><small>${small}</small></div>`;
  };
  return `<div class="ps-foot ps-grid" role="row">
    <div class="ps-cell ps-datecell ps-fcell"></div>
    <div class="ps-cell ps-prop ps-fcell ps-ftitle"><b>Totals</b><small>${list.length} row${list.length === 1 ? '' : 's'} shown</small></div>
    ${cols.map(([k, l]) => cell(k, l)).join('')}
  </div>`;
}
function sheetHtml(base) {
  if (!trackers.length) return emptyAll();
  const t0 = now();
  const cols = [...G.CHANNELS.map(c => [c.key, c.label]), ['brochure', 'Brochure'], ...G.LISTINGS.map(l => [l.key, l.label])];
  const list = sortList(base.filter(t => passes(t, t0)));
  const head = `<div class="ps-head ps-grid" role="row"><div role="columnheader">Planned</div><div role="columnheader">Property</div>${cols.map(c => `<div role="columnheader">${CH_ICON[c[0]] ? chLabel(c[0], c[1]) : esc(c[1])}</div>`).join('')}</div>`;
  const thisWeek = G.mondayOf(t0);
  let rows = '';
  if (sortKey === 'planned') {
    const groups = new Map();
    for (const t of list) { const wk = G.weekKey(t); if (!groups.has(wk)) groups.set(wk, []); groups.get(wk).push(t); }
    for (const [wk, arr] of groups) {
      rows += `<div class="ps-week" role="row"><span class="ps-week-t">${wk ? esc(weekLabel(wk)) : 'No date yet'}</span>${wk === thisWeek ? '<span class="ps-week-tag">This week</span>' : ''}<span class="ps-week-n">${arr.length} ${arr.length === 1 ? 'row' : 'rows'}</span></div>`;
      rows += arr.map(t => sheetRow(t, cols, t0, wk)).join('');
    }
  } else rows = list.map(t => sheetRow(t, cols, t0)).join('');
  const weekPart = sheetWeek ? weekStrip(base, true) : `<button type="button" class="wk-show" onclick="pgSheetWeek(true)"><i class="fa-regular fa-calendar" aria-hidden="true"></i> Show this week</button>`;
  return `${weekPart}${filterBar(base)}
    ${list.length ? `<div class="ps" role="table" aria-label="Posting sheet">${head}${rows}${sheetFoot(list, cols, t0)}</div>` : noMatch()}`;
}

// Sort. The order is computed when you arrive or change a filter/sort, then held: ticking a
// box must not make the row you are working on jump to another place on the page.
function sortList(list) {
  const plannedOf = t => G.weekKey(t) ? (t.plannedDate || t.weekOf || G.weekKey(t)) : Infinity;
  const rank = t => ({ attention: -worst(t), progress: G.progress(t).pct, newest: -(t.createdAt || 0), planned: plannedOf(t), code: 0 }[sortKey]);
  const byCode = (a, b) => String(codeOf(a) || dn(a)).localeCompare(String(codeOf(b) || dn(b)), undefined, { numeric: true });
  const cmp = (a, b) => sortKey === 'code' ? byCode(a, b) : (rank(a) - rank(b)) || byCode(a, b);
  if (!order) order = list.slice().sort(cmp).map(t => t.id);
  const pos = id => { const i = order.indexOf(id); return i < 0 ? -1 : i; };   // new rows go to the top
  return list.slice().sort((a, b) => pos(a.id) - pos(b.id));
}
window.pgSort = k => { sortKey = k; try { localStorage.setItem(K_SORT, k); } catch (e) {} order = null; renderPosting(); };
window.pgFocus = id => {
  const t = byId(id); if (!t) return;
  if (isSer(t)) return window.pgOpenSeries(rootOf(t).id);
  mode = 'cards'; try { localStorage.setItem(K_MODE, mode); } catch (e) {}
  filters = new Set(); focusId = id; renderPosting();
};

function filterBar(base) {
  const t0 = now();
  // Counted over what this tab lists: series on the Series tab, properties on Properties.
  const inTab = mode === 'series' ? base.filter(isSer) : mode === 'cards' ? base.filter(t => !isSer(t)) : base;
  const btns = G.FILTERS.map(([k, label]) => {
    const n = inTab.filter(t => G.matchesFilter(t, k, t0)).length;
    const on = filters.has(k);
    return `<button type="button" class="pg-f${on ? ' on' : ''}" aria-pressed="${on}" onclick="pgFilter(${jsq(k)})">${on ? '✓ ' : ''}${esc(label)} <span class="tk-n">${n}</span></button>`;
  }).join('');
  const cat = window.tagCatalog ? window.tagCatalog() : TG.DEFAULT_TAGS;
  // Counts in one pass over the rows, and only while the list is open.
  const tagN = new Map();
  if (filtersOpen) for (const t of base) for (const x of tagsOf(t)) tagN.set(TG.tagKey(x), (tagN.get(TG.tagKey(x)) || 0) + 1);
  const tagBtns = !filtersOpen ? '' : cat.map(tag => {
    const k = 'tag:' + TG.tagKey(tag), on = filters.has(k);
    const n = tagN.get(TG.tagKey(tag)) || 0;
    return `<button type="button" class="pg-f pg-ftag${on ? ' on' : ''}" aria-pressed="${on}" onclick="pgFilter(${jsq(k)})"><i class="tg-dot ${TG.tagClass(tag)}" aria-hidden="true"></i>${on ? '✓ ' : ''}${esc(tag)} <span class="tk-n">${n}</span></button>`;
  }).join('');
  const labelOf = k => k.startsWith('tag:') ? 'Tag: ' + (cat.find(t => 'tag:' + TG.tagKey(t) === k) || k.slice(4)) : (G.FILTERS.find(f => f[0] === k) || [])[1];
  // Active filters are always on screen as chips you can remove, even with the list folded away.
  const chips = [...filters].map(k => { const l = labelOf(k); return l ? `<button type="button" class="pg-fchip" onclick="pgFilter(${jsq(k)})" title="Remove this filter">${esc(l)} <span aria-hidden="true">✕</span></button>` : ''; }).join('');
  return `<div class="pg-filters">
    <div class="pg-fbar">
      <button type="button" class="pg-fbtn${filtersOpen ? ' open' : ''}${filters.size ? ' has' : ''}" aria-expanded="${filtersOpen}" onclick="pgFiltersToggle()"><i class="fa-solid fa-sliders" aria-hidden="true"></i> Filters${filters.size ? ` <span class="pg-fcount">${filters.size}</span>` : ''}</button>
      ${filters.size ? `<div class="pg-active">${chips}<button type="button" class="tk-link" onclick="pgClearFilters()">Clear all</button></div>` : ''}
      <label class="pg-sort">Sort <select onchange="pgSort(this.value)" aria-label="Sort">${SORTS.map(([k, l]) => `<option value="${k}"${sortKey === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    ${filtersOpen ? `<div class="pg-fbtns">${btns}<div class="pg-fgroup"><span class="pg-fgl">Tags</span>${tagBtns}</div></div>` : ''}
  </div>`;
}

// ── Properties: one block per property, every round of it together ──
// Any time, not only this week: the scorecard per platform (how many times live, how many
// coming), the full posting history, then each round's card to edit.
function propsHtml(base) {
  if (!trackers.length) return emptyAll();
  const t0 = now();
  const list = sortList(base.filter(t => passes(t, t0) && !isSer(t)));
  const seen = new Set(), blocks = [];
  for (const t of list) {
    const fam = G.familyOf(trackers, t.id, fams());
    const root = fam[0];
    if (!root || seen.has(root.id)) continue;
    fam.forEach(x => seen.add(x.id));
    blocks.push(familyHtml(fam));
  }
  return `${filterBar(base)}${blocks.length ? `<div class="pf-list">${blocks.join('')}</div>` : noMatch()}`;
}
function familyHtml(fam) {
  const root = fam[0];
  const counts = G.familyCounts(trackers, root.id, fams());
  const tally = G.CHANNELS.map(c => {
    const n = counts[c.key];
    if (!n.live && !n.coming) return `<span class="pf-t none ch-${c.key}">${chIcon(c.key)}<span>${esc(c.label)}</span><b>—</b></span>`;
    return `<span class="pf-t ch-${c.key}">${chIcon(c.key)}<span>${esc(c.label)}</span><b>${n.live}× live</b>${n.coming ? `<em>+${n.coming} coming</em>` : ''}</span>`;
  }).join('');
  const history = G.CHANNELS.map(c => {
    const h = G.channelHistory(trackers, root.id, c.key, fams()).map(x => ({ ...x, many: fam.length > 1 }));
    if (!h.length) return '';
    return `<div class="pf-h"><span class="pf-hl">${chLabel(c.key, c.label)}</span><div class="pf-hs">${h.map(x => {
      const inner = `<i></i>${esc(H_TXT[x.status])} · ${esc(shortDate(x.when))}${x.repost || !x.many ? '' : ' <em>original</em>'}`;
      return x.url ? `<a class="ps-h h-${x.status}" href="${href(x.url)}" target="_blank" rel="noopener">${inner} ↗</a>` : `<button type="button" class="ps-h h-${x.status}" onclick="pgFocus(${jsq(x.rowId)})">${inner}</button>`;
    }).join('')}</div></div>`;
  }).join('');
  const rounds = fam.length;
  return `<section class="pf" id="pf-${esc(root.id)}">
    <div class="pf-head">
      <div><div class="pf-name">${esc(G.nameOf(root))}</div>
        <div class="pf-meta">${root.propertyCode ? `<span class="ps-code">${esc(root.propertyCode)}</span>` : '<span class="tk-code none">no code</span>'}
          ${root.location ? `<span>${esc(root.location)}</span>` : ''}<span>${rounds} round${rounds === 1 ? '' : 's'} of posting</span></div>
        <div class="pf-tags">${tagPicker(root, true, true)}</div></div>
      <button type="button" class="tk-btn sm" onclick="pgJump(${jsq(root.id)})">Open in sheet</button>
    </div>
    <div class="pf-tally">${tally}</div>
    ${history && fam.length > 1 ? `<div class="pf-hist"><div class="pf-histt">Every time it went out</div>${history}</div>` : ''}
    <div class="pg-grid pf-rounds">${fam.map((t, i) => `<div class="pf-round"><div class="pf-rl">${i === 0 ? 'Round 1 · original' : `Round ${i + 1} · repost`}</div>${cardHtml(t)}</div>`).join('')}</div>
  </section>`;
}

// ── Series: several properties, shot one by one, edited into one video ──
// One block per series: its posts on every channel (all its rounds), its website listing, then each
// property — photos, brochure, and that property's OWN posts, which stay apart from the series'.
function seriesHtml(base) {
  const t0 = now();
  const list = sortList(base.filter(t => isSer(t) && passes(t, t0)));
  const seen = new Set(), blocks = [];
  for (const t of list) { const s = rootOf(t); if (!s || seen.has(s.id)) continue; seen.add(s.id); blocks.push(seriesBlock(s, t0)); }
  const intro = `<div class="sr-intro"><div><b>Series</b><span>Several properties, each shot on its own, edited into one video and posted as one post — on any channel and the website. Each property keeps its own posts.</span></div>
    <button type="button" class="tk-btn primary" onclick="pgOpenSeriesDlg('')">+ New series</button></div>`;
  if (!trackers.some(t => G.isSeries(t))) return `${intro}<div class="tk-empty"><div class="tk-empty-i">🎞️</div><div class="tk-empty-t">No series yet</div>
    <div class="tk-empty-s">Club properties shot separately — “T Nagar series”, “Studio series” — and schedule them as one post. A plan line that says “series” becomes one too.</div></div>`;
  return `${intro}${filterBar(base)}${blocks.length ? `<div class="sr-list">${blocks.join('')}</div>` : noMatch()}`;
}
function seriesBlock(s, t0) {
  const fam = G.familyOf(trackers, s.id, fams());
  const ms = membersOf(s), l = listingOf(s);
  // Each channel: every round of the series on it, newest round's state leading.
  const chans = G.CHANNELS.map(c => {
    const h = G.channelHistory(trackers, s.id, c.key, fams());
    const cur = G.channelView(s.channels[c.key], t0);
    const lateDay = cur.status === 'yet' && cur.day && cur.day < G.startOfDay(t0);
    const state = cur.due ? `<span class="ps-bad">Due · ${esc(shortWhen(cur.at))}</span>` : cur.status === 'scheduled' ? esc(shortWhen(cur.at))
      : cur.status === 'live' ? (cur.url ? `<a class="ps-link" href="${href(cur.url)}" target="_blank" rel="noopener">Live ↗</a>` : `<button type="button" class="pg-warnbtn ps-bad" onclick="pgLink(${jsq(s.id)},${jsq(c.key)})">Live — add link</button>`)
      : cur.status === 'yet' && cur.day ? `<span class="${lateDay ? 'ps-bad' : 'ps-planned'}">Plan ${esc(G.dayLabel(cur.day))}</span>` : cur.status === 'na' ? '<span class="ps-faint">N/A</span>' : '<span class="ps-faint">To schedule</span>';
    const act = cur.status === 'live' || cur.status === 'na' ? '' : `<button type="button" class="tk-link" onclick="pgChannel(${jsq(s.id)},${jsq(c.key)},'scheduled')">${cur.status === 'scheduled' ? 'Reschedule' : 'Schedule'}</button>`;
    const others = h.filter(x => x.rowId !== s.id);
    return `<div class="sr-ch${cur.due || lateDay || cur.linkMissing ? ' hot' : ''}"><span class="sr-chn">${chLabel(c.key, c.label)}</span><span class="sr-chs">${state}${voiceTag(s, c.key) ? ' ' + voiceTag(s, c.key) : ''}</span>${act}${others.length ? histLines(others) : ''}</div>`;
  }).join('');
  const w = s.website;
  const web = `<div class="sr-ch"><span class="sr-chn">3 PIN website</span><span class="sr-chs">${w.status === 'posted' ? (w.url ? `<a class="ps-link" href="${href(w.url)}" target="_blank" rel="noopener">Posted ↗</a>` : '<span class="ps-bad">Posted, no link</span>') : w.status === 'na' ? '<span class="ps-faint">N/A</span>' : '<span class="ps-faint">Not posted</span>'}</span>
    <select class="pg-sel ps-pill t-${w.status === 'posted' ? (w.url ? 'live' : 'bad') : w.status === 'na' ? 'na' : 'yet'}" aria-label="3 PIN website status" onchange="pgListing(${jsq(s.id)},'website',this.value)">${Object.keys(G.LISTING_LABEL).map(k => `<option value="${k}"${w.status === k ? ' selected' : ''}>${SHORT_L[k]}</option>`).join('')}</select></div>`;
  const mrows = ms.map(m => {
    const b = m.row ? broState(m.row) : broState({ id: m.key, propertyCode: m.propertyCode });
    // The property's own posts: every round of it, on every channel — apart from the series.
    const own = m.row ? G.CHANNELS.map(c => ({ c, h: G.channelHistory(trackers, m.row.id, c.key, fams()) })).filter(x => x.h.length) : [];
    const ownTxt = !m.row ? '<span class="ps-faint">Not on the tracker — no own posts</span>'
      : own.length ? own.map(({ c, h }) => { const last = h[h.length - 1]; return `<span class="sr-own h-${last.status}">${chIcon(c.key)}${esc(G.SHORT_CH[c.key])} · ${esc(H_TXT[last.status] || last.status)} ${esc(shortDate(last.when))}${h.length > 1 ? ` <em>${h.length}×</em>` : ''}</span>`; }).join('')
      : '<span class="ps-faint">No individual posts yet</span>';
    return `<div class="sr-m">
      <div class="sr-mn">${m.propertyCode ? `<span class="ps-code">${esc(m.propertyCode)}</span>` : ''}<b>${esc(m.name)}</b></div>
      <div class="sr-mf"><span class="sr-k">Photos</span>${m.photosLink ? (G.isUrl(m.photosLink) ? `<a class="pg-ok" href="${href(m.photosLink)}" target="_blank" rel="noopener">✓ Open ↗</a>` : '<span class="pg-ok">✓ Received</span>') : '<span class="pg-pend">Not received</span>'}</div>
      <div class="sr-mf"><span class="sr-k">Brochure</span><span class="${b.done ? 'pg-ok' : 'pg-pend'}">${b.done ? '✓ ' : ''}${esc(BRO_LABEL[b.state])}</span>${b.link ? ` <a href="${href(b.link)}" target="_blank" rel="noopener">open ↗</a>` : ''}</div>
      <div class="sr-mf sr-mown"><span class="sr-k">Own posts</span><span class="sr-owns">${ownTxt}</span></div>
      <div class="sr-ma">${m.row ? `<button type="button" class="tk-btn sm" onclick="pgJump(${jsq(m.row.id)})">Its own row</button>` : ''}</div>
    </div>`;
  }).join('');
  const ed = editTag(s);
  const p = G.progress(s), st = STATE_PILL[G.overall(s, t0)];
  return `<section class="sr" id="pg-${esc(s.id)}">
    <div class="sr-head">
      <div class="sr-ht">
        <div class="sr-name">${esc(serName(s))}</div>
        <div class="sr-meta"><span class="tk-code ser">Series · ${ms.length} propert${ms.length === 1 ? 'y' : 'ies'}</span>${planBit(s)}${fam.length > 1 ? `<span>${fam.length} rounds of posting</span>` : ''}<span class="tk-pill ${st[1]}">${st[0]}</span><span class="pg-sub">${p.done}/${p.total} done</span>${ed}</div>
        ${s.note ? `<div class="pg-notebox">📝 ${esc(s.note)}</div>` : ''}
        <div class="pf-tags">${tagPicker(s, true, true)}</div>
      </div>
      <div class="sr-acts">
        <button type="button" class="tk-btn sm" onclick="pgOpenSeriesDlg(${jsq(s.id)})">Edit series</button>
        <button type="button" class="tk-btn sm" onclick="pgJump(${jsq(s.id)})">Open in sheet</button>
        ${l ? `<button type="button" class="tk-btn sm" onclick="pgBrochureGo(${jsq(l.id)})">Board card</button>` : `<button type="button" class="tk-btn sm" onclick="pgSeriesCard(${jsq(s.id)})">Add to the board</button>`}
      </div>
    </div>
    <div class="sr-sec">Series posts <span class="pg-sub">— one video, posted as its own post</span></div>
    <div class="sr-chs-grid">${chans}${web}</div>
    <div class="sr-sec">Properties in it <span class="pg-sub">— shot separately; photos and brochure are each property's</span></div>
    <div class="sr-ms">${mrows || `<div class="pt-clear muted">No properties yet. <button type="button" class="tk-link" onclick="pgOpenSeriesDlg(${jsq(s.id)})">Add them</button></div>`}</div>
  </section>`;
}

const STATE_PILL = {
  complete: ['All done', 'ok'], attention: ['Needs attention', 'bad'], started: ['In progress', 'warn'], new: ['Not started', 'muted']
};

function channelRow(t, c) {
  const v = G.channelView(t.channels[c.key], now());
  const opts = G.STATUS_ORDER.map(s => `<option value="${s}"${v.status === s ? ' selected' : ''}>${G.STATUS_LABEL[s]}</option>`).join('');
  const lateDay = v.status === 'yet' && v.day && v.day < G.startOfDay(now());
  let info = '';
  if (v.status === 'scheduled') info = `<span class="${v.due ? 'pg-bad' : ''}">${esc(fmt(v.at))}${v.due ? ' · due — confirm posted' : ''}</span>`;
  else if (v.status === 'live') info = v.url
    ? `<a href="${href(v.url)}" target="_blank" rel="noopener">Open post ↗</a>`
    : `<button type="button" class="pg-warnbtn" onclick="pgLink(${jsq(t.id)},${jsq(c.key)})">⚠ Live — link not shared · add</button>`;
  if (v.status === 'live') info += ` <span class="pg-sub">live ${esc(fmt(v.liveAt || v.at))}</span> <button type="button" class="tk-link" onclick="pgLiveEdit(${jsq(t.id)},${jsq(c.key)})">change</button>`;
  else if (v.status === 'yet' && v.day) info = `<span class="${lateDay ? 'pg-bad' : 'pg-planned'}">Planned ${esc(G.dayLabel(v.day))} — set the time</span>`;
  return `<div class="pg-ch${v.due || v.linkMissing || lateDay ? ' hot' : ''}">
    <span class="pg-ch-n">${chLabel(c.key, c.label)}</span>
    <select class="pg-sel s-${v.status}" aria-label="${esc(c.label)} status" onchange="pgChannel(${jsq(t.id)},${jsq(c.key)},this.value)">${opts}</select>
    <span class="pg-ch-i">${info}${voiceTag(t, c.key) ? ' ' + voiceTag(t, c.key) : ''}${v.status === 'live' && v.at ? `<span class="pg-sub"> planned ${esc(fmt(v.at))}</span>` : ''}</span>
  </div>`;
}
function listingRow(t, l) {
  const x = t[l.key];
  const opts = Object.entries(G.LISTING_LABEL).map(([s, lab]) => `<option value="${s}"${x.status === s ? ' selected' : ''}>${lab}</option>`).join('');
  const info = x.status === 'posted'
    ? (x.url ? `<a href="${href(x.url)}" target="_blank" rel="noopener">Open listing ↗</a>`
      : `<button type="button" class="pg-warnbtn" onclick="pgListing(${jsq(t.id)},${jsq(l.key)},'posted')">⚠ Posted — link not shared · add</button>`)
    : '';
  return `<div class="pg-ch${x.status === 'posted' && !x.url ? ' hot' : ''}">
    <span class="pg-ch-n">${esc(l.label)}</span>
    <select class="pg-sel l-${x.status}" aria-label="${esc(l.label)} status" onchange="pgListing(${jsq(t.id)},${jsq(l.key)},this.value)">${opts}</select>
    <span class="pg-ch-i">${info}</span>
  </div>`;
}

function cardHtml(t) {
  const t0 = now();
  const p = G.progress(t), st = STATE_PILL[G.overall(t, t0)], g = G.gaps(t, t0);
  const o = origOf(t);
  const head = `<div class="pg-top">
      <div class="pg-id">${codeBadge(t, false)} ${planBit(t)}
        <div class="pg-title">${esc(dn(t))}</div>
        <div class="pg-loc">${esc(t.location)}${t.title && t.reference && t.reference !== t.title ? `<span class="pg-sub"> · plan: ${esc(t.reference)}</span>` : ''}</div></div>
      <span class="tk-pill ${st[1]}">${st[0]}</span>
    </div>
    ${t.note ? `<div class="pg-notebox">📝 ${esc(t.note)}</div>` : ''}
    <div class="pg-prog" title="${p.done} of ${p.total} done"><div class="pg-prog-bar"><i style="width:${p.pct}%"></i></div><span>${p.done}/${p.total} done</span></div>`;
  const gapList = g.length ? `<ul class="pg-gaps">${g.slice(0, 4).map(x => `<li class="s${x.sev}">${esc(x.text)}</li>`).join('')}${g.length > 4 ? `<li class="more">+ ${g.length - 4} more</li>` : ''}</ul>` : '';

  if (t.repostOf) {
    return `<article class="pg-card ${G.overall(t, t0)} repost" id="pg-${esc(t.id)}">${head}
      <div class="pg-inputs"><span class="pg-sub">↺ Repost — brochure, photos, 99 Acres, website and dashboard are on the original.</span>
        ${o ? `<button type="button" class="tk-link" onclick="pgFocus(${jsq(o.id)})">Open original</button>` : '<span class="pg-pend">Original was deleted</span>'}
        <button type="button" class="tk-link" onclick="pgOpenEdit(${jsq(t.id)})">Edit</button></div>
      <div class="pg-sec">Posts</div>
      ${G.CHANNELS.map(c => channelRow(t, c)).join('')}
      ${gapList}
    </article>`;
  }
  const match = !t.propertyId ? invFor(t) : null;
  const dash = !t.propertyCode
    ? `<span class="pg-pend">No property code yet</span> <button type="button" class="tk-btn sm" onclick="pgOpenEdit(${jsq(t.id)})">Add code</button><button type="button" class="tk-link" onclick="pgOpenTag(${jsq(t.id)})">Tag a property…</button>`
    : t.propertyId
      ? `<span class="pg-ok">✓ In Property dashboard</span> <a href="dashboard.html?property=${encodeURIComponent(t.propertyCode)}" target="_blank" rel="noopener">Open ↗</a> <button type="button" class="tk-link" onclick="pgUnlink(${jsq(t.id)})">unlink</button>`
      : `<span class="pg-pend">Not in Property dashboard yet</span> ${match ? `<button type="button" class="tk-btn sm" onclick="pgLinkTo(${jsq(t.id)},${jsq(match.id)})">Link to ${esc(match.propertyCode)}</button>` : ''}<button type="button" class="tk-link" onclick="pgOpenLink(${jsq(t.id)})">${match ? 'pick another' : 'Link…'}</button>`;
  return `<article class="pg-card ${G.overall(t, t0)}" id="pg-${esc(t.id)}">${head}
    <div class="pg-inputs">
      <span>${G.isUrl(inputsFor(t).photosLink) ? `<a href="${href(inputsFor(t).photosLink)}" target="_blank" rel="noopener">📷 Photos ↗</a>` : inputsFor(t).photosLink ? '<span class="pg-pend">📷 Photos link is not a web link</span>' : '<span class="pg-pend">📷 Photos not received</span>'}</span>
      <span>${inputsFor(t).details ? '<span class="pg-ok">✓ Details received</span>' : '<span class="pg-pend">Details not received</span>'}</span>
      <button type="button" class="tk-link" onclick="pgOpenEdit(${jsq(t.id)})">Edit</button>
    </div>
    <div class="pg-sec">Posts</div>
    ${G.CHANNELS.map(c => channelRow(t, c)).join('')}
    <div class="pg-sec">Brochure &amp; listings</div>
    <div class="pg-ch pg-brochure${broState(t).done ? '' : (g.some(x => x.kind === 'brochure' && x.sev >= 3) ? ' hot' : '')}">
      <span class="pg-ch-n">Brochure</span>
      <span class="pg-ck">${broCell(t, false)}</span>
      <span class="pg-ch-i pg-sub">${esc(broWhere(broState(t)))}</span>
    </div>
    ${G.LISTINGS.map(l => listingRow(t, l)).join('')}
    <div class="pg-dash">${dash}</div>
    ${gapList}
  </article>`;
}

// ── Upcoming: timed posts, then what the plan has a day for but no time ──
function queueHtml(base) {
  const t0 = now(), eod = new Date(); eod.setHours(23, 59, 59, 999);
  const ids = new Set(base.map(t => t.id));
  const rows = G.upcoming(trackers, t0).filter(r => ids.has(r.id));
  const missing = G.liveMissingLink(trackers).filter(r => ids.has(r.id));
  const plan = G.planned(trackers, t0).filter(r => ids.has(r.id));
  const groups = [['Due now — confirm it is posted', 'bad', rows.filter(r => r.due)]];
  const future = rows.filter(r => !r.due), byDay = new Map();
  for (const r of future) { const k = new Date(r.at).toDateString(); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(r); }
  const tmr = eod.getTime() + 86400000;
  for (const [, arr] of byDay) {
    const at = arr[0].at;
    const label = at <= eod.getTime() ? 'Today' : at < tmr ? 'Tomorrow' : G.formatDate(at, F_DAYHEAD);
    groups.push([label + ' · ' + arr.length + ' post' + (arr.length === 1 ? '' : 's'), at <= eod.getTime() ? 'warn' : '', arr]);
  }
  const row = r => `<div class="tk-row">
    <div class="tk-row-main">
      <div class="tk-row-top"><span class="tk-row-title">${r.key ? chLabel(r.key, r.label) : esc(r.label)}</span>${codeBadge(r.tracker, true)}</div>
      <div class="tk-row-meta"><span>${esc(dn(r.tracker))}</span>${serBadge(r.tracker)}${refHtml(r.tracker, 'pg-ref')}<span>${esc(r.tracker.location)}</span>${miniTags(r.tracker)}</div>
      ${needsHtml(r.tracker, r.key)}
    </div>
    <div class="tk-row-side">
      <span class="tk-when${r.due ? ' bad' : ''}">${esc(fmt(r.at))}<br><span class="pg-sub">${esc(rel(r.at))}</span></span>
      <button type="button" class="tk-btn sm primary" onclick="pgChannel(${jsq(r.id)},${jsq(r.key)},'live')">Mark posted</button>
      <button type="button" class="tk-btn sm" onclick="pgChannel(${jsq(r.id)},${jsq(r.key)},'scheduled')">Reschedule</button>
    </div>
  </div>`;
  const planRow = r => `<div class="tk-row${r.late ? ' pg-task hot' : ''}">
    <div class="tk-row-main">
      <div class="tk-row-top"><span class="tk-row-title">${esc(r.key ? r.label : 'Channel not chosen')}</span>${codeBadge(r.tracker, true)}</div>
      <div class="tk-row-meta"><span>${esc(dn(r.tracker))}</span>${serBadge(r.tracker)}${refHtml(r.tracker, 'pg-ref')}${miniTags(r.tracker)}</div>
      ${needsHtml(r.tracker, r.key)}
    </div>
    <div class="tk-row-side pg-acts">
      <span class="tk-when${r.late ? ' bad' : ''}">${esc(G.dayLabel(r.day))}<br><span class="pg-sub">${r.late ? 'day passed' : 'time not set'}</span></span>
      ${r.key ? `<button type="button" class="tk-btn sm primary" onclick="pgChannel(${jsq(r.id)},${jsq(r.key)},'scheduled')">Set time</button>`
        : G.CHANNELS.map(c => `<button type="button" class="tk-btn sm" onclick="pgChannel(${jsq(r.id)},${jsq(c.key)},'scheduled')">${esc(c.label)}</button>`).join('') + `<button type="button" class="tk-btn sm ghost" onclick="pgUnplan(${jsq(r.id)})">Not posting</button>`}
    </div>
  </div>`;
  const out = [weekStrip(base)];
  const first = groups[0];
  if (first[2].length) out.push(`<div class="tk-group"><div class="tk-group-hdr bad">${first[0]} <span class="tk-count">${first[2].length}</span></div><div class="tk-rows">${first[2].map(row).join('')}</div></div>`);
  if (plan.length) out.push(`<div class="tk-group"><div class="tk-group-hdr ${plan.some(r => r.late) ? 'bad' : 'warn'}">Planned — time not set <span class="tk-count">${plan.length}</span></div>
    <div class="pg-hint">From the weekly plan. Pick the time once it is fixed.</div><div class="tk-rows">${plan.map(planRow).join('')}</div></div>`);
  for (const [label, cls, arr] of groups.slice(1)) out.push(`<div class="tk-group"><div class="tk-group-hdr ${cls}">${label} <span class="tk-count">${arr.length}</span></div><div class="tk-rows">${arr.map(row).join('')}</div></div>`);
  if (missing.length) out.push(`<div class="tk-group"><div class="tk-group-hdr bad">Live, link not shared <span class="tk-count">${missing.length}</span></div>
    <div class="tk-rows">${missing.map(r => `<div class="tk-row"><div class="tk-row-main"><div class="tk-row-top"><span class="tk-row-title">${r.key ? chLabel(r.key, r.label) : esc(r.label)}</span>${codeBadge(r.tracker, true)}</div><div class="tk-row-meta"><span>${esc(dn(r.tracker))}</span>${serBadge(r.tracker)}${refHtml(r.tracker, 'pg-ref')}</div>${needsHtml(r.tracker, r.key)}</div>
      <div class="tk-row-side"><button type="button" class="tk-btn sm primary" onclick="pgLink(${jsq(r.id)},${jsq(r.key)})">Add link</button></div></div>`).join('')}</div></div>`);
  return out.length > 1 ? out.join('') : out[0] +
    `<div class="tk-empty"><div class="tk-empty-i">🗓️</div><div class="tk-empty-t">Nothing scheduled or planned</div><div class="tk-empty-s">Paste the week's plan, or set a post to Scheduled, and it appears here in time order.</div></div>`;
}

// ═══════ ACTIONS ═══════
window.pgMode = m => { mode = MODES.includes(m) ? m : (OLD_MODE[m] || 'today'); try { localStorage.setItem(K_MODE, mode); } catch (e) {} order = null; renderPosting(); };
window.pgFilter = k => { filters.has(k) ? filters.delete(k) : filters.add(k); order = null; renderPosting(); };
window.pgClearFilters = () => { filters = new Set(); order = null; renderPosting(); };
window.pgFiltersToggle = () => { filtersOpen = !filtersOpen; renderPosting(); };

window.pgChannel = (id, key, status) => {
  const t = byId(id); if (!t) return;
  if (status === 'scheduled') return openDlg('schedule', id, key);
  if (status === 'live') return openDlg('live', id, key);
  const r = G.setChannel(t, key, status, {}, now());
  if (r.ok) r.tracker = dropEmptyPlan(r.tracker);
  // From a week tile's quick menu: the menu has done its job, and left open it would show the old
  // state and hold back every refresh.
  if (dlg && dlg.kind === 'quick') closeQuiet();
  if (!r.ok) { toast(r.error); return renderPosting(); }
  persist(r.tracker);
};
// Cancel a schedule from its dialog: back to To schedule (its planned day kept), or N/A — with Undo.
// A post taken off (cancelled, N/A, or back to To schedule with no day) leaves nothing behind: once no
// post on the row is scheduled, live or planned for a day, the row's planned day goes too — otherwise
// the bare plan line would come back as "type not decided" for a post that was removed.
const nothingPlanned = t => !G.CHANNEL_KEYS.some(k => { const c = t.channels[k]; return c.status === 'scheduled' || c.status === 'live' || c.day; });
function dropEmptyPlan(t) { return t.plannedDate && nothingPlanned(t) ? { ...t, plannedDate: 0 } : t; }
window.pgUnschedule = status => {
  if (!dlg || dlg.kind !== 'schedule') return;
  const t = byId(dlg.id), k = dlg.key; if (!t) return;
  const r = G.setChannel(t, k, status === 'na' ? 'na' : 'yet', {}, now());
  if (!r.ok) { $('pgErr').textContent = r.error; return; }
  r.tracker.channels = { ...r.tracker.channels, [k]: { ...r.tracker.channels[k], day: 0 } };
  const label = (G.CHANNELS.find(c => c.key === k) || {}).label || 'Post';
  closeQuiet();
  persist(dropEmptyPlan(r.tracker), status === 'na' ? label + ' — not posting' : label + ' — schedule cancelled');
};
window.pgLink = (id, key) => openDlg('link', id, key);
window.pgLiveEdit = (id, key) => openDlg('live', id, key);
window.pgListing = (id, key, status) => {
  const t = byId(id); if (!t) return;
  if (status === 'posted') return openDlg('listing', id, key);
  const r = G.setListing(t, key, status, {}, now());
  if (!r.ok) { toast(r.error); return renderPosting(); }
  persist(r.tracker);
};
// Unlinked by hand: it stays unlinked — the automatic link (after a brochure) leaves it alone.
window.pgUnlink = id => { const t = byId(id); if (t) persist({ ...t, propertyId: '', noAutoLink: true }); };
// Linking a row to a dashboard property makes it that property: its code too, not only its details —
// code, details and brochure always come from the same property.
function linkTo(t, p) {
  const c = G.setCode(trackers, t.id, p.propertyCode);
  if (!c.ok) { toast(c.error); return false; }
  persist(fillFrom({ ...t, propertyCode: p.propertyCode, propertyId: p.id, noAutoLink: false }, p), 'Linked to ' + p.propertyCode);
  return true;
}
window.pgLinkTo = (id, propId) => {
  const t = byId(id); const p = invList().find(x => x.id === propId); if (!t || !p) return;
  linkTo(t, p);
};
// In-place edits from the sheet.
window.pgSetName = (id, v) => {
  const t = byId(id); if (!t) return;
  const val = String(v || '').trim();
  if (!val && !t.propertyCode && !t.repostOf) { toast('A row needs a reference or a title'); return renderPosting(); }
  persist({ ...t, [t.title ? 'title' : 'reference']: val }, 'Saved');
};
window.pgSetDay = (id, v) => { const t = byId(id); if (t) persist({ ...t, plannedDate: fromDateInput(v) }, 'Planned date saved'); };
window.pgSetCode = (id, v) => {
  const t = byId(id); if (!t) return;
  const r = G.setCode(trackers, id, v);
  if (!r.ok) { toast(r.error); return renderPosting(); }
  let nt = { ...t, propertyCode: r.code };
  const m = invFor(nt);
  if (m) nt = fillFrom({ ...nt, propertyCode: m.propertyCode, propertyId: m.id }, m);   // the dashboard's spelling of the code wins
  persist(nt, m ? 'Code saved and linked to the dashboard' : 'Code saved');
};
// Linking brings in what the dashboard already knows, but never overwrites what media shared.
// A photos link is taken only if it is a web address.
function fillFrom(t, p) {
  return {
    ...t,
    title: t.title || p.name || '', location: t.location || p.location || '',
    photosLink: t.photosLink || G.webLink(p.photosLink), details: t.details || p.detailsText || ''
  };
}
window.pgExport = () => {
  const blob = new Blob(['﻿' + G.toCsv(trackers)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'posting-tracker-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

// ═══════ DIALOG ═══════
function openDlg(kind, id, key) {
  dlg = { kind, id, key };
  const t = byId(id) || {};
  const chan = G.CHANNELS.find(c => c.key === key) || G.LISTINGS.find(c => c.key === key) || {};
  const save = $('pgSave'); save.style.display = ''; save.textContent = 'Save';
  $('pgErr').textContent = '';
  $('pgModal').querySelector('.tk-box').classList.toggle('wide', kind === 'plan' || kind === 'bulk');
  let title = '', body = '';
  const nm = t.id ? esc(dn(t)) : '';
  if (kind === 'schedule') {
    const c = t.channels && t.channels[key];
    // Start from what is known: the time already set, else the planned day, else the next hour.
    const dayBase = (c && c.day) || t.plannedDate;
    const start = (c && c.at) || (dayBase ? dayBase + 10 * 3600000 : nextHour());
    title = `Schedule ${chan.label}`;
    body = `<p class="tk-hint" style="margin-top:0">${nm}${dayBase ? ' · planned ' + esc(G.dayLabel(dayBase)) : ''}</p>
      <label for="pgAt">Date and time it goes out</label><input id="pgAt" type="datetime-local" value="${localInput(start)}">
      <p class="tk-hint">It shows as <b>Due</b> when the time passes. It becomes <b>Posted live</b> only when you confirm it.</p>${gateHtml(t, 'schedule')}${c && c.status === 'scheduled' ? `
      <div class="pg-unsched">
        <div class="pg-unsched-t">Scheduled for <b>${esc(fmt(c.at))}</b> — not going ahead?</div>
        <div class="pg-unsched-b"><button type="button" class="tk-btn sm" onclick="pgUnschedule('yet')">Cancel this schedule</button><button type="button" class="tk-btn sm ghost" onclick="pgUnschedule('na')">Won't post (N/A)</button></div>
        <div class="tk-hint">Cancelling takes this post off the calendar (it can be scheduled again later). N/A marks it as not posting.</div>
      </div>` : ''}`;
    save.textContent = c && c.status === 'scheduled' ? 'Reschedule' : 'Schedule';
    title = c && c.status === 'scheduled' ? `Reschedule ${chan.label}` : title;
  } else if (kind === 'live') {
    const c = t.channels && t.channels[key];
    const already = c && c.status === 'live';
    title = already ? `${chan.label} — live` : `${chan.label} — confirm it is live`;
    // When it actually went out: now by default, or what is already recorded — change it when the post
    // went out earlier and is only being confirmed now. The scheduled time is kept and shown apart.
    body = `<p class="tk-hint" style="margin-top:0">${nm}${c && c.at ? ' · scheduled for ' + esc(fmt(c.at)) : ''}</p>
      <label for="pgLiveAt">Went live at</label><input id="pgLiveAt" type="datetime-local" value="${localInput(already && c.liveAt ? c.liveAt : now())}" max="${localInput(now() + 60000)}">
      <p class="tk-hint" style="margin-top:4px">Now, unless it went out earlier — then pick when.</p>
      <label for="pgUrl">Link to the live post</label><input id="pgUrl" type="url" value="${esc((c && c.url) || '')}" placeholder="Open the post, copy its link and paste it here" oninput="pgCheckUrl()">
      <div class="pg-pasterow"><button type="button" class="tk-btn sm" onclick="pgPasteLink()"><i class="fa-regular fa-clipboard" aria-hidden="true"></i> Paste copied link</button><span id="pgUrlHint" class="pg-urlhint" role="status"></span></div>
      <p class="tk-hint warn">You can confirm without the link, but it stays flagged <b>Live — link not shared</b> until you add it.</p>${already ? '' : gateHtml(t, 'live')}`;
    save.textContent = already ? 'Save' : 'Confirm posted';
  } else if (kind === 'link') {
    const c = t.channels && t.channels[key];
    title = `${chan.label} — post link`;
    body = `<p class="tk-hint" style="margin-top:0">${nm}</p><label for="pgUrl">Link to the live post</label><input id="pgUrl" type="url" value="${esc((c && c.url) || '')}" placeholder="https://…" oninput="pgCheckUrl()"><div class="pg-pasterow"><button type="button" class="tk-btn sm" onclick="pgPasteLink()"><i class="fa-regular fa-clipboard" aria-hidden="true"></i> Paste copied link</button><span id="pgUrlHint" class="pg-urlhint" role="status"></span></div>`;
  } else if (kind === 'listing') {
    title = `${chan.label} — confirm it is posted`;
    body = `<p class="tk-hint" style="margin-top:0">${nm}</p><label for="pgUrl">Link to the listing</label><input id="pgUrl" type="url" value="${esc((t[key] && t[key].url) || '')}" placeholder="Open the listing, copy its link and paste it here" oninput="pgCheckUrl()"><div class="pg-pasterow"><button type="button" class="tk-btn sm" onclick="pgPasteLink()"><i class="fa-regular fa-clipboard" aria-hidden="true"></i> Paste copied link</button><span id="pgUrlHint" class="pg-urlhint" role="status"></span></div>
      <p class="tk-hint warn">Confirming without the link is allowed; it stays flagged until you add it.</p>`;
    save.textContent = 'Confirm posted';
  } else if (kind === 'edit') {
    const o = origOf(t);
    // A property with a board card: its photos link and details are the card's (one place, either side).
    const inp = inputsFor(t), shared = !!inp.card, frozen = shared && cardLocked(inp.card);
    title = t.repostOf ? 'Repost' : 'Property details';
    const common = `<label for="pgRefIn">Reference <span class="tk-opt">as it was in the plan</span></label><input id="pgRefIn" type="text" value="${esc(t.reference)}" placeholder="Lux49 4Bhk">
      <label for="pgDayIn">Planned date</label><input id="pgDayIn" type="date" value="${dateInput(t.plannedDate)}">
      <label for="pgNote">Notes <span class="tk-opt">e.g. what the CEO asked for, timing reference</span></label><input id="pgNote" type="text" value="${esc(t.note)}" placeholder="CEO: Reel Friday 6pm, Story same day">
      <label>Tags <span class="tk-opt">saved as you add them</span></label>${tagPicker(t, false)}`;
    if (t.repostOf) {
      body = `<p class="tk-hint" style="margin-top:0">↺ Repost of <b>${esc(o ? G.nameOf(o) : 'a deleted row')}</b>${o && o.propertyCode ? ' (' + esc(o.propertyCode) + ')' : ''}. Brochure, photos, details, 99 Acres, website and the dashboard link are kept on the original.</p>
        ${common}
        <p style="margin:12px 0 0;display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="tk-btn sm" onclick="pgUntag(${jsq(t.id)})">Not a repost — make it its own row</button>
        <button type="button" class="tk-btn danger sm" onclick="pgDelete(${jsq(t.id)})">Delete this row</button></p>`;
    } else {
      body = `${common}
        <label for="pgCodeIn">Property code</label>${t.propertyCode
          ? `${codeBox(t, t.propertyCode, true)}<p class="tk-hint" id="pgCodeHint">Wrong property? <b>Change code</b> — this row moves to that property: what came from ${esc(t.propertyCode)} (its title, location, photos, details, brochure) goes, the new one's comes in if it is in the dashboard. Its posts stay.</p>`
          : `${codeBox(t, '')}<p class="tk-hint">Already tracked or in the dashboard? <button type="button" class="tk-link" onclick="pgOpenTag(${jsq(t.id)})">Tag that property instead</button> · Several properties in one video? <button type="button" class="tk-link" onclick="pgOpenSeriesDlg(${jsq(t.id)})">Make it a series</button></p>`}
        <label for="pgTitleIn">Title</label><input id="pgTitleIn" type="text" value="${esc(t.title)}" placeholder="3BHK in T Nagar">
        <label for="pgLocIn">Location</label><input id="pgLocIn" type="text" value="${esc(t.location)}">
        <label for="pgPhotos">Photos link <span class="tk-opt">${shared ? 'the same link as its board card' : 'from the media team'}</span></label><input id="pgPhotos" type="url" value="${esc(inp.photosLink)}" placeholder="Drive folder link"${frozen ? ' readonly title="Its brochure is made from these — redo it on the board to change them"' : ''}>
        <label for="pgDetails">Property details <span class="tk-opt">${shared ? 'the same details as its board card — the brochure is made from them' : ''}</span></label><textarea id="pgDetails" class="tk-area" rows="6" placeholder="Price, size, facing, highlights…"${frozen ? ' readonly' : ''}>${esc(inp.details)}</textarea>${frozen ? '<p class="tk-hint">Its brochure is made from these. To change them, redo the brochure on its board card.</p>' : ''}
        <p style="margin:12px 0 0"><button type="button" class="tk-btn danger sm" onclick="pgDelete(${jsq(t.id)})">Delete this property's tracker</button></p>`;
    }
    // What the form showed when it opened: Save writes only the fields you changed from these,
    // so a field someone else changed meanwhile is not put back to what this form still shows.
    dlg.orig = { pgRefIn: t.reference, pgDayIn: dateInput(t.plannedDate), pgNote: t.note, pgTitleIn: t.title, pgLocIn: t.location, pgPhotos: inp.photosLink, pgDetails: inp.details };
    dlg.cardId = inp.card ? inp.card.id : null;
  } else if (kind === 'add') {
    title = 'Add a row';
    body = `<p class="tk-hint" style="margin-top:0"><b>Only have the plan line?</b> Type the reference and the day — the code, photos and brochure can come later.</p>
      <label for="pgTitleIn">Reference or title</label><input id="pgTitleIn" type="text" placeholder="Lux49 4Bhk">
      <label for="pgDay">Planned date <span class="tk-opt">optional</span></label><input id="pgDay" type="date">
      <label class="tk-check" style="margin-top:8px"><input type="checkbox" id="pgStory"> It is an Insta Story that day</label>
      <label for="pgCode">Property code <span class="tk-opt">if it already has one</span></label><input id="pgCode" type="text" placeholder="e.g. TNAG0002">
      <label for="pgLocIn">Location <span class="tk-opt">optional</span></label><input id="pgLocIn" type="text">
      <label for="pgNote">Notes <span class="tk-opt">optional</span></label><input id="pgNote" type="text" placeholder="CEO: Reel Friday 6pm">
      <p class="tk-hint" style="margin-top:16px"><b>Or pick it from the Property dashboard:</b></p>
      <input id="pgSearch" type="search" placeholder="Search the dashboard: code, name or area…" oninput="pgSearchInv(this.value)">
      <div id="pgPickList" class="tk-picklist"></div>`;
    save.textContent = 'Add row';
  } else if (kind === 'linkpick') {
    title = 'Link to the Property dashboard';
    body = `<input id="pgSearch" type="search" placeholder="Code, name or area…" oninput="pgSearchInv(this.value)"><div id="pgPickList" class="tk-picklist"></div>`;
    save.style.display = 'none';
  } else if (kind === 'tag') {
    title = 'Tag a property';
    body = `<p class="tk-hint" style="margin-top:0"><b>${nm}</b> — which property is this?</p>
      <p class="tk-hint">Pick one <b>already tracked here</b> and this row becomes a <b>repost</b> of it (its own schedule and links; brochure and listings stay on the original). Pick one <b>from the dashboard</b> and this row takes its code and title.</p>
      <input id="pgSearch" type="search" placeholder="Code, name or area…" oninput="pgSearchTag(this.value)"><div id="pgPickList" class="tk-picklist"></div>`;
    save.style.display = 'none';
  } else if (kind === 'bulk') {
    title = 'Add schedule';
    dlg.entries = [newEntry()];
    body = `<p class="tk-hint" style="margin-top:0">One line per post day. Leave the time empty and it is <b>Planned</b> for that day; add a time and it is <b>Scheduled</b>.</p>
      <div class="bk-head"><span>Date</span><span>Time</span><span>Property or reference</span></div>
      <div id="pgBulkList" class="bk-list"></div>
      <button type="button" class="tk-btn sm bk-more" onclick="pgBulkAdd()">+ Add another entry</button>`;
    save.textContent = 'Add to schedule';
  } else if (kind === 'plan') {
    title = 'Paste the week plan';
    dlg.tags = {};
    body = `<label for="pgMonday">Week starting (Monday)</label><input id="pgMonday" type="date" value="${dateInput(G.mondayOf(now()))}" onchange="pgPlanPreview()">
      <label for="pgPlanText">Plan</label><textarea id="pgPlanText" class="tk-area" rows="9" oninput="pgPlanPreview()" placeholder="Monday -S- Lux49 - 4Bhk&#10;Tuesday - Velachery 2Bhk&#10;…&#10;Youtube - T nagar series"></textarea>
      <p class="tk-hint"><b>-S-</b> = Insta Story that day. A line without S gets only the day; the channel is picked later. A <b>Youtube - …</b> line is that week's YouTube item. A line that says <b>series</b> (“T nagar series”) becomes a series — pick its properties after. Tag a line to a property you already have to make it a repost.</p>
      <div id="pgPlanPreview"></div>`;
    save.textContent = 'Add rows';
  }
  $('pgTitle').textContent = title;
  $('pgBody').innerHTML = body;
  $('pgModal').classList.add('open');
  if (kind === 'add' || kind === 'linkpick') { pgSearchInv(''); loadInv(); }
  if (kind === 'edit' && $('pgCodeIn')) { loadInv(); pgCodeVerdict(); }
  if (kind === 'tag') { pgSearchTag(''); loadInv(); }
  if (kind === 'plan') { pgPlanPreview(); loadInv(); }
  if (kind === 'bulk') { loadInv(); pgBulkRender(); const first = document.querySelector('#pgBulkList .bk-in'); if (first) setTimeout(() => first.focus(), 0); }
  if ($('pgUrl')) pgCheckUrl();
  const f = $('pgPlanText') || $('pgAt') || $('pgUrl') || $('pgTitleIn') || $('pgRefIn') || $('pgSearch');
  if (f) f.focus();
}
// Reads what was just copied from Instagram / Facebook / YouTube, so confirming a post is: copy
// the link there, click here. If the browser will not share the clipboard, say how to paste instead.
window.pgPasteLink = () => {
  const inp = $('pgUrl'), hint = $('pgUrlHint');
  if (!inp) return;
  if (!navigator.clipboard || !navigator.clipboard.readText) { if (hint) { hint.className = 'pg-urlhint warn'; hint.textContent = 'Paste with Ctrl+V (Cmd+V on a Mac).'; } inp.focus(); return; }
  navigator.clipboard.readText().then(v => { inp.value = String(v || '').trim(); pgCheckUrl(); inp.focus(); })
    .catch(() => { if (hint) { hint.className = 'pg-urlhint warn'; hint.textContent = 'The browser blocked the clipboard — paste with Ctrl+V.'; } inp.focus(); });
};
// A second look, never a block: a YouTube link on an Insta Story is almost always a slip.
window.pgCheckUrl = () => {
  const inp = $('pgUrl'), hint = $('pgUrlHint');
  if (!inp || !hint || !dlg) return;
  const v = inp.value.trim();
  if (!v) { hint.textContent = ''; hint.className = 'pg-urlhint'; return; }
  if (!G.validUrl(v)) { hint.className = 'pg-urlhint bad'; hint.textContent = 'That does not look like a link yet.'; return; }
  const ok = G.linkLooksLike(dlg.key, v), where = labelOf(dlg.key);
  if (ok === false) { hint.className = 'pg-urlhint warn'; hint.textContent = `This is a ${G.platformOf(v) || 'different'} link — this one is for ${where}. Check before saving.`; }
  else if (ok === true) { hint.className = 'pg-urlhint ok'; hint.textContent = '✓ ' + G.platformOf(v) + ' link'; }
  else { hint.className = 'pg-urlhint'; hint.textContent = ''; }
};
window.pgOpenAdd = () => openDlg('add', '', '');
window.pgOpenBulk = () => openDlg('bulk', '', '');

// ── Add schedule: the entries ──
let entrySeq = 0;
function newEntry(day) { return { n: ++entrySeq, text: '', ref: '', sel: null, keys: new Set(), day: day || dateInput(G.startOfDay(now())), time: '' }; }
const entryAt = n => (dlg && dlg.entries || []).find(e => e.n === n);
function pgBulkRender() {
  const host = $('pgBulkList'); if (!host || !dlg || !dlg.entries) return;
  host.innerHTML = dlg.entries.map((e, i) => `<div class="bk-row" data-n="${e.n}">
      <input class="bk-day" type="date" value="${e.day}" aria-label="Date for entry ${i + 1}" onchange="pgBulkWhen(${e.n}, 'day', this.value)">
      <input class="bk-time" type="time" value="${e.time}" aria-label="Time for entry ${i + 1}, optional" onchange="pgBulkWhen(${e.n}, 'time', this.value)">
      <div class="bk-prop">
        ${e.sel
          ? `<div class="bk-chip"><span class="bk-kind">${e.sel.kind === 't' ? 'Tracked' : 'Dashboard'}</span><b>${esc(e.sel.label)}</b><button type="button" class="bk-unpick" onclick="pgBulkUnpick(${e.n})" aria-label="Change property">✕</button></div>`
          : `<input class="bk-in" type="text" value="${esc(e.text)}" placeholder="Search a property, or type a reference" aria-label="Property or reference ${i + 1}" autocomplete="off"
              oninput="pgBulkType(${e.n}, this.value)" onfocus="pgBulkType(${e.n}, this.value)" onblur="setTimeout(() => pgBulkSug(${e.n}, false), 120)"
              onkeydown="if (event.key === 'Enter') { event.preventDefault(); pgBulkAdd(); }"><div class="bk-sug" id="bkSug-${e.n}" role="listbox"></div>`}
        ${!e.sel ? `<div class="bk-note" id="bkNote-${e.n}" ${e.text.trim() ? '' : 'hidden'}>New reference — code, photos and brochure can come later</div>`
          : `<input class="bk-ref" type="text" value="${esc(e.ref)}" placeholder="Reference (optional) — e.g. how the plan names it" aria-label="Reference for entry ${i + 1}, optional" autocomplete="off" oninput="pgBulkRef(${e.n}, this.value)">`}
      </div>
      <div class="bk-types" role="group" aria-label="Goes out as">${G.CHANNELS.map(c => `<button type="button" class="bk-type${e.keys.has(c.key) ? ' on' : ''}" aria-pressed="${e.keys.has(c.key)}" onclick="pgBulkKey(${e.n}, ${jsq(c.key)})">${chIcon(c.key)}<span>${esc(G.SHORT_CH[c.key])}</span></button>`).join('')}</div>
      <button type="button" class="bk-x" onclick="pgBulkRemove(${e.n})" aria-label="Remove this entry" ${dlg.entries.length === 1 ? 'disabled' : ''}>✕</button>
    </div>`).join('');
  pgBulkCount();
}
// Matches as you type: tracked properties first (they become a new round), then dashboard ones.
window.pgBulkType = (n, v) => {
  const e = entryAt(n); if (!e) return;
  e.text = v;
  // The "new reference" note is shown or hidden in place — redrawing the row would take the
  // caret (and the suggestion list) away mid-word.
  const note = $('bkNote-' + n); if (note) note.hidden = !v.trim();
  pgBulkSug(n, true);
  pgBulkCount();
};
window.pgBulkSug = (n, open) => {
  const box = $('bkSug-' + n); if (!box) return;
  const e = entryAt(n);
  const q = String(e && e.text || '').trim().toLowerCase();
  if (!open || !q) { box.innerHTML = ''; box.classList.remove('open'); return; }
  const tracked = trackers.filter(t => !t.repostOf && [t.propertyCode, t.title, t.reference, t.location].join(' ').toLowerCase().includes(q)).slice(0, 5);
  const fromInv = untrackedInv().filter(p => [p.propertyCode, p.name, p.location].join(' ').toLowerCase().includes(q)).slice(0, 5);
  const opt = (kind, id, code, name, sub) => `<button type="button" class="bk-opt" role="option" onmousedown="event.preventDefault()" onclick="pgBulkPick(${n}, ${jsq(kind)}, ${jsq(id)})"><b>${esc(code ? code + ' · ' + name : name)}</b><span>${esc(sub)}</span></button>`;
  box.innerHTML =
    (tracked.length ? '<div class="bk-sh">Tracked</div>' + tracked.map(t => opt('t', t.id, t.propertyCode, G.nameOf(t), t.location || 'already on the tracker')).join('') : '') +
    (fromInv.length ? '<div class="bk-sh">Property dashboard</div>' + fromInv.map(p => opt('i', p.id, p.propertyCode, p.name, p.location || '')).join('') : '') +
    `<div class="bk-sh">Or</div><button type="button" class="bk-opt new" onmousedown="event.preventDefault()" onclick="pgBulkSug(${n}, false)"><b>Keep “${esc(e.text.trim())}” as a reference</b><span>add the code and photos later</span></button>`;
  box.classList.add('open');
};
// The reference for a picked property, one name everywhere: the board listing's name for it when it
// has a listing, else the reference this tracker already carries.
function referenceFor(code, tracker) {
  const k = G.codeKey(code);
  const l = k ? memo().byCode.get(k) : null;
  const name = l && String(l.title || '').trim();
  if (name && name !== 'New listing') return name;
  return String((tracker && tracker.reference) || '').trim();
}
// For the board's New listing: the reference Posting has for a code (its listing title, if empty).
window.pgReferenceFor = code => {
  const k = G.codeKey(code);
  const t = k ? trackers.find(x => !x.repostOf && G.codeKey(x.propertyCode) === k) : null;
  return t ? String(t.reference || '').trim() : '';
};
window.pgBulkPick = (n, kind, id) => {
  const e = entryAt(n); if (!e) return;
  if (kind === 't') { const t = byId(id); if (!t) return; e.sel = { kind, id, label: (t.propertyCode ? t.propertyCode + ' · ' : '') + G.nameOf(t) }; if (!e.ref.trim()) e.ref = referenceFor(t.propertyCode, t); }
  else { const p = (inv || []).find(x => x.id === id); if (!p) return; e.sel = { kind, id, label: p.propertyCode + ' · ' + p.name }; if (!e.ref.trim()) e.ref = referenceFor(p.propertyCode, null); }
  pgBulkRender();
};
window.pgBulkUnpick = n => { const e = entryAt(n); if (!e) return; e.sel = null; pgBulkRender(); const inp = document.querySelector(`.bk-row[data-n="${n}"] .bk-in`); if (inp) inp.focus(); };
window.pgBulkRef = (n, v) => { const e = entryAt(n); if (e) e.ref = v; };
window.pgBulkWhen = (n, field, v) => { const e = entryAt(n); if (!e) return; e[field] = v; pgBulkCount(); };
window.pgBulkKey = (n, k) => { const e = entryAt(n); if (!e) return; e.keys.has(k) ? e.keys.delete(k) : e.keys.add(k); pgBulkRender(); };
window.pgBulkAdd = () => {
  if (!dlg || !dlg.entries) return;
  const last = dlg.entries[dlg.entries.length - 1];
  const next = newEntry(last && last.day);   // same day as the line above; change it for another day
  if (last) next.keys = new Set(last.keys);    // and the same types — the common case
  dlg.entries.push(next);
  pgBulkRender();
  const inp = document.querySelector(`.bk-row[data-n="${next.n}"] .bk-in`); if (inp) inp.focus();
};
window.pgBulkRemove = n => { if (!dlg || !dlg.entries || dlg.entries.length < 2) return; dlg.entries = dlg.entries.filter(e => e.n !== n); pgBulkRender(); };
window.pgBulkCount = () => {
  if (!dlg || !dlg.entries) return;
  const ready = dlg.entries.filter(e => e.sel || e.text.trim()).length;
  const posts = dlg.entries.filter(e => e.sel || e.text.trim()).reduce((m, e) => m + Math.max(1, e.keys.size), 0);
  const days = new Set(dlg.entries.filter(e => e.sel || e.text.trim()).map(e => e.day)).size;
  $('pgSave').textContent = ready ? `Add ${posts} post${posts === 1 ? '' : 's'}${days > 1 ? ` on ${days} days` : ''}` : 'Add to schedule';
};
// ═══════ THE PROPERTY CODE BOX (Property details) ═══════
// Like the board's Property ID box: as a code is typed, the codes already in the Property dashboard
// (and whether a Posting row has one) and the next free code in its series — and, under the box, what
// saving does with the code typed.
// locked: a code already set shows read-only, with "Change code" to unlock it — a code is not changed
// by a stray keystroke in a dialog used for everyday edits.
function codeBox(t, code, locked) {
  return `<div class="sd-pick pg-codebox"><input id="pgCodeIn" type="text" value="${esc(code)}" placeholder="e.g. ADB0002 — type the letters to see the codes" autocomplete="off" spellcheck="false"${locked ? ' readonly' : ''}
      oninput="pgCodeSug(this.value)" onfocus="if (!this.readOnly) pgCodeSug(this.value)" onblur="setTimeout(() => { const s = document.getElementById('pgCodeSug'); if (s) s.classList.remove('open'); }, 150)">
    ${locked ? '<button type="button" class="tk-btn sm" id="pgCodeUnlock" onclick="pgCodeUnlock()">Change code</button>' : ''}
    <div id="pgCodeSug" class="bk-sug" role="listbox"></div></div><div id="pgCodeV" class="pb-check" role="status"></div>`;
}
window.pgCodeUnlock = () => {
  const i = $('pgCodeIn'), b = $('pgCodeUnlock'); if (!i) return;
  i.readOnly = false; if (b) b.remove();
  i.focus(); i.select();
  window.pgCodeSug(i.value);
};
const rowWithCode = (code, selfId) => trackers.find(x => x.id !== selfId && !x.repostOf && !G.isSeries(x) && G.codeKey(x.propertyCode) && G.codeKey(x.propertyCode) === G.codeKey(code)) || null;
window.pgCodeSug = v => {
  const box = $('pgCodeSug'); if (!box || !dlg || dlg.kind !== 'edit') return;
  const invL = invList();
  if (!invL.length) { const api = window.trackApi; if (api && api.loadInventory) api.loadInventory().then(() => { if (dlg && dlg.kind === 'edit') window.pgCodeSug(($('pgCodeIn') || {}).value || ''); }).catch(() => {}); }
  pgCodeVerdict();
  const q = String(v || '').trim();
  // Nothing typed, or a whole code that is in the dashboard: no list — the line under the box says it.
  if (!q || invL.some(p => G.codeKey(p.propertyCode) === G.codeKey(q))) { box.innerHTML = ''; box.classList.remove('open'); return; }
  const opt = (code, sub, cls) => `<button type="button" class="bk-opt${cls ? ' ' + cls : ''}" role="option" onmousedown="event.preventDefault()" onclick="pgCodePick(${jsq(code)})"><b>${esc(code)}</b><span>${esc(sub)}</span></button>`;
  const next = B.seriesFor(q, invL).slice(0, 4).map(g => opt(g.next, `next free in ${g.letters} · ${g.count} so far, last ${g.last}`)).join('');
  const have = B.codeSuggestions(q, invL, 8).map(p => {
    const r = rowWithCode(p.propertyCode, dlg.id);
    return opt(p.propertyCode, `in the dashboard — ${[p.name, p.location].filter(Boolean).join(' · ')}${r ? ' · on Posting: ' + G.nameOf(r) : ''}`, r ? 'used' : '');
  }).join('');
  box.innerHTML = (have ? '<div class="bk-sh">In the Property dashboard</div>' + have : '') + (next ? '<div class="bk-sh">Next free code</div>' + next : '')
    || `<div class="bk-sh">${invL.length ? 'No code in the dashboard starts like that' : 'Reading the dashboard…'}</div>`;
  box.classList.add('open');
};
window.pgCodePick = c => { const i = $('pgCodeIn'); if (i) i.value = c; const box = $('pgCodeSug'); if (box) box.classList.remove('open'); pgCodeVerdict(); };
// What saving does with the code in the box.
function pgCodeVerdict() {
  const el = $('pgCodeV'); if (!el || !dlg || dlg.kind !== 'edit') return;
  const t = byId(dlg.id); if (!t) return;
  const raw = (($('pgCodeIn') || {}).value || '').trim(), cur = t.propertyCode;
  const line = (cls, html) => `<div class="pb-v ${cls}">${html}</div>`;
  if (G.codeKey(raw) === G.codeKey(cur)) { el.innerHTML = ''; return; }
  if (!raw) { el.innerHTML = cur ? line('warn', `Saving removes the code <b>${esc(cur)}</b> and what came with it (title, location, photos, details, brochure). Its posts stay.`) : ''; return; }
  const code = raw.toUpperCase();
  if (!B.looksLikeCode(code)) { el.innerHTML = line('warn', 'A property code is letters, then numbers — like ADB0003.'); return; }
  const r = rowWithCode(code, t.id);
  if (r) { el.innerHTML = line('bad', `<b>${esc(code)}</b> is already used by “${esc(G.nameOf(r))}” on Posting — saving is refused. Pick another code.`); return; }
  const p = invList().find(q => G.codeKey(q.propertyCode) === G.codeKey(code));
  el.innerHTML = p
    ? line('info', `<b>${esc(p.propertyCode)}</b> is in the Property dashboard — ${esc([p.name, p.location].filter(Boolean).join(', '))}${B.isUrl(p.brochureLink) ? ' · brochure made' : ''}. Saving moves this row to it${cur ? `: what came from ${esc(cur)} goes, its own comes in` : ' and fills in its details'}. Posts stay.`)
    : line('warn', `<b>${esc(code)}</b> is not in the Property dashboard yet — a new code.${cur ? ` Saving unlinks this row from ${esc(cur)} and removes what came from it.` : ''} Create its brochure to add it to the dashboard. Posts stay.`);
}

// ═══════ THE EDIT BEFORE THE POST ═══════
// A post with a time needs its edit planned; a post goes live once its edit is done. Read from the
// property's board card (a series: its card); a property with no card is not held back.
function gateFor(t, action) {
  const l = t ? listingOf(rootOf(t)) : null, api = window.trackApi;
  return l ? postGate(l, action, api && api.edCtx ? api.edCtx(l) : null) : { ok: true };
}
function gateHtml(t, action) {
  const g = gateFor(t, action);
  if (g.ok) return '';
  return `<div class="pg-gate" id="pgGate">${esc(g.text)}<div>${g.need === 'done'
    ? '<button type="button" class="tk-btn sm primary" onclick="pgEditDone()">The edit is done — mark it</button>'
    : '<button type="button" class="tk-btn sm" onclick="pgPlanEdit()">Plan the edit</button>'}</div></div>`;
}
window.pgEditDone = () => {
  const t = dlg && byId(dlg.id), l = t ? listingOf(rootOf(t)) : null, api = window.trackApi;
  if (!l || !api || !api.editStep) return;
  api.editStep(l.id, 'done');
  const el = $('pgGate');
  if (el && gateFor(t, 'live').ok) { el.className = 'pg-gate ok'; el.textContent = '✓ Edit marked done — confirm the post below.'; $('pgErr').textContent = ''; }
};
window.pgPlanEdit = () => {
  const t = dlg && byId(dlg.id), l = t ? listingOf(rootOf(t)) : null;
  if (!l || !window.openEditPlan) return;
  closeQuiet();
  window.openEditPlan(l.id);
  toast('Plan the edit, then schedule the post');
};

// ═══════ CREATE BROCHURE, FROM POSTING ═══════
// The same request as the board's brochure panel (window.bpGenerate), made on the property's board
// card — one card per property — so that card is mapped to the property the brochure creates, and the
// property lands in the Property dashboard with this brochure, photos and details, linked here and on
// the board. A property with no card gets one, in the column its posts say: Live — marketing when a
// post is live, else Media ready. Photos and details are the card's (one place): what is typed here is
// saved there. Nothing is saved until the questions are answered and the request can go.
const anyLive = t => G.familyOf(trackers, t.id, fams()).some(r => G.CHANNEL_KEYS.some(k => r.channels[k].status === 'live'));
const stageName = key => { const s = window.trackApi && window.trackApi.stageFor ? window.trackApi.stageFor(key) : null; return (s && s.name) || ({ live: 'Live — marketing', media_ready: 'Media ready' }[key] || key); };
const cardTitle = l => { const v = String((l && l.title) || '').trim(); return v && v !== 'New listing' ? v : ''; };
const cardLocked = l => !!(l && window.trackApi && window.trackApi.brochureOf && window.trackApi.brochureOf(l) === 'created');
function cardWhere(card) {
  return card
    ? `Made from its board card <b>${esc(cardTitle(card) || 'this property')}</b> — the card is mapped to the property it creates.`
    : `It has no board card yet: one is made in <b>${esc(stageName(dlg.stageKey))}</b>${dlg.stageKey === 'live' ? ' (a post is already live)' : ' (its posts are scheduled)'}.`;
}
window.pgBrochure = id => {
  const t0 = byId(id); if (!t0) return;
  const t = rootOf(t0);
  // A repost whose original was deleted: there is no property row to make a brochure for.
  if (t.repostOf) return toast('Its original row was deleted — make the brochure from the property\'s own row');
  if (G.isSeries(t)) return toast('A series has no brochure of its own — each property has its own');
  const b = broState(t);
  if (b.done) return toast('Its brochure is already made');
  // The board's cards must be in, or an existing card would be missed and a second one made.
  if (window.trackApi && window.trackApi.listingsLoaded && !window.trackApi.listingsLoaded()) return toast('The board is still loading — try again in a moment');
  const inp = inputsFor(t), card = inp.card;
  const linked = card && B.isRealCode(card.propertyCode) ? card.propertyCode : '';
  const code = linked || t.propertyCode || (card && card.brochure && card.brochure.code) || '';
  const stageKey = anyLive(t) ? 'live' : 'media_ready';
  dlg = { kind: 'brochure', id: t.id, cardId: card ? card.id : null, code, codeLocked: !!(linked || t.propertyCode), stageKey };
  const save = $('pgSave'); save.style.display = ''; save.disabled = false; save.textContent = 'Create brochure';
  $('pgErr').textContent = '';
  $('pgModal').querySelector('.tk-box').classList.add('wide');
  $('pgTitle').textContent = 'Create brochure — ' + dn(t);
  const again = b.state === 'requested' || b.state === 'building'
    ? `<p class="tk-hint warn">A brochure was already ${b.state === 'building' ? 'built and is being delivered' : 'requested'}. Sending again builds and emails a fresh one.</p>` : '';
  $('pgBody').innerHTML = `<p class="tk-hint" style="margin-top:0"><span id="pgBroWhere">${cardWhere(card)}</span> When it is delivered (about 30 minutes), the property is in the <b>Property dashboard</b> with the brochure, photos and details — linked here and on the board.</p>${again}
    <label for="pgBroCode">Property code</label>
    ${dlg.codeLocked ? `<div class="pb-code"><span class="ps-code">${esc(code)}</span><span class="tk-hint" style="margin:0">${linked ? 'its board card is linked to it' : 'this row\'s code'}</span></div>`
      : `<div class="sd-pick"><input id="pgBroCode" type="text" value="${esc(code)}" placeholder="e.g. TNAG0008 — type the letters to see the next free code" autocomplete="off" spellcheck="false" oninput="pgBroCodeIn(this.value)" onfocus="pgBroCodeIn(this.value)" onblur="setTimeout(() => { const s = document.getElementById('pgBroSug'); if (s) s.classList.remove('open'); }, 150)"><div id="pgBroSug" class="bk-sug" role="listbox"></div></div>`}
    <label for="pgBroTitle">Title <span class="tk-opt">on the brochure</span></label><input id="pgBroTitle" type="text" value="${esc(cardTitle(card) || t.title || t.reference)}" placeholder="3BHK Apartment, T Nagar" oninput="pgBroCheck()">
    <label for="pgBroPhotos">Photos — Google Drive folder <span class="tk-opt">the brochure is put in this folder</span></label><input id="pgBroPhotos" type="url" value="${esc(inp.photosLink)}" placeholder="https://drive.google.com/drive/folders/…" oninput="pgBroCheck()">
    <label for="pgBroDesc">Details <span class="tk-opt">price, size, facing, highlights — the brochure is written from these</span></label><textarea id="pgBroDesc" class="tk-area" rows="7" oninput="pgBroCheck()">${esc(inp.details)}</textarea>
    <label for="pgBroInt">Internal notes <span class="tk-opt">optional — never on the brochure</span></label><input id="pgBroInt" type="text" value="${esc((card && card.internalNotes) || '')}" placeholder="Owner's terms, keys with…">
    <div id="pgBroCheck" class="pb-check" role="status"></div>`;
  $('pgModal').classList.add('open');
  // The code checks need the dashboard as it is now.
  const api = window.trackApi, D = dlg;
  if (api && api.loadInventory) api.loadInventory(true).then(() => { memMemo = null; if (dlg === D) window.pgBroCheck(); }).catch(() => {});
  window.pgBroCheck();
  setTimeout(() => { const f = $(dlg && dlg.codeLocked ? 'pgBroTitle' : 'pgBroCode'); if (f) f.focus(); }, 0);
};
function broDraft() {
  const v = id => ($(id) ? $(id).value.trim() : '');
  return { code: dlg.codeLocked ? dlg.code : B.normCode(v('pgBroCode')), title: v('pgBroTitle'), photosLink: G.cleanUrl(v('pgBroPhotos')), description: v('pgBroDesc'), internalNotes: v('pgBroInt') };
}
// What sending would do, and what stops it: the board's own brochure rules, as if the card were
// already linked to a property of that code (sending links it first), plus codes on other Posting rows.
function broVerdict(d) {
  const api = window.trackApi, invL = invList(), lst = (api && api.listings()) || [];
  const card = dlg.cardId ? lst.find(l => l.id === dlg.cardId) : null;
  const existing = d.code ? invL.find(p => B.isRealCode(p.propertyCode) && B.codeKey(p.propertyCode) === B.codeKey(d.code)) : null;
  // A card already holding that code: it is this property's card (one card per property).
  const other = !card && d.code ? B.findCode(d.code, [], lst, null).listing : null;
  const use = card || other;
  const x = { id: (use || {}).id || '__new', propertyCode: existing ? existing.propertyCode : '', brochure: { code: d.code }, title: d.title, photosLink: d.photosLink, description: d.description };
  const c = B.brochureCheck(x, invL, lst);
  // Only linking (the property has its brochure): photos and details are not used — not asked for.
  const linkOnly = !!(existing && B.isUrl(existing.brochureLink));
  const missing = linkOnly ? c.missing.filter(m => !/photos|Description/i.test(m)) : c.missing.slice();
  if (d.code && !dlg.codeLocked) { const r = G.setCode(trackers, dlg.id, d.code); if (!r.ok) missing.push(r.error); }
  if (use && cardLocked(use) && !(existing && B.isUrl(existing.brochureLink))) missing.push(`Its board card “${cardTitle(use) || use.id}” already has its brochure — redo it on the board`);
  return { ok: !missing.length, missing, warnings: linkOnly ? [] : c.warnings, existing, card: use, adopted: other, linkOnly };
}
window.pgBroCheck = () => {
  const el = $('pgBroCheck'); if (!el || !dlg || dlg.kind !== 'brochure') return;
  let d = broDraft(), v = broVerdict(d);
  // The code typed belongs to a card already on the board: that card is this property's — show and
  // use what it has (an empty box keeps what was typed), and say so.
  const boxes = ['pgBroTitle', 'pgBroPhotos', 'pgBroDesc', 'pgBroInt'];
  if (v.adopted && dlg.adoptedId !== v.adopted.id) {
    // What was typed before, kept: it comes back if the code stops matching that card.
    if (!dlg.typed) dlg.typed = Object.fromEntries(boxes.map(id => [id, $(id) ? $(id).value : '']));
    dlg.adoptedId = v.adopted.id;
    const a = v.adopted, put = (id, val) => { const i = $(id); if (i) i.value = String(val || '').trim() ? val : (dlg.typed[id] || ''); };
    put('pgBroTitle', cardTitle(a)); put('pgBroPhotos', a.photosLink); put('pgBroDesc', a.description); put('pgBroInt', a.internalNotes);
    const w = $('pgBroWhere'); if (w) w.innerHTML = `${esc(d.code)} is on the board already — made from that card, <b>${esc(cardTitle(a) || 'this property')}</b>; it is mapped to the property it creates.`;
    d = broDraft(); v = broVerdict(d);
  } else if (!v.adopted && dlg.adoptedId) {
    dlg.adoptedId = null;
    if (dlg.typed) { for (const id of boxes) { const i = $(id); if (i) i.value = dlg.typed[id] || ''; } dlg.typed = null; }
    const w = $('pgBroWhere'); if (w) w.innerHTML = cardWhere(null);
    d = broDraft(); v = broVerdict(d);
  }
  const done = v.existing && B.isUrl(v.existing.brochureLink);
  el.innerHTML = (v.existing ? `<div class="pb-v ${done ? 'ok' : 'info'}">${esc(v.existing.propertyCode)} is already in the Property dashboard${v.existing.name ? ' — ' + esc(v.existing.name) : ''}. ${done ? 'It has its brochure: sending links this property to it, nothing is rebuilt.' : 'Sending links this property to it and makes its brochure.'}</div>` : d.code && B.looksLikeCode(d.code) ? `<div class="pb-v info">${esc(d.code)} is a new code — the brochure creates it in the Property dashboard.</div>` : '')
    + (v.missing.length ? `<div class="pb-v bad"><b>Still needed:</b> ${v.missing.map(esc).join(' · ')}</div>` : '')
    + (v.warnings.length ? `<div class="pb-v warn">${v.warnings.map(esc).join('<br>')}</div>` : '');
  const save = $('pgSave'); if (save && !dlg.sending) save.textContent = done ? 'Link it' : 'Create brochure';
};
// Typing a code: the next free code in its series first, then codes already in the dashboard.
window.pgBroCodeIn = v => {
  const box = $('pgBroSug'); if (!box || !dlg) return;
  window.pgBroCheck();
  const q = String(v || '').trim(), invL = invList();
  if (!q) { box.innerHTML = ''; box.classList.remove('open'); return; }
  const next = B.seriesFor(q, invL).slice(0, 4).map(g => `<button type="button" class="bk-opt" role="option" onmousedown="event.preventDefault()" onclick="pgBroCodePick(${jsq(g.next)})"><b>${esc(g.next)}</b><span>next free in ${esc(g.letters)} · ${g.count} so far, last ${esc(g.last)}</span></button>`).join('');
  const have = B.codeSuggestions(q, invL, 5).map(p => `<button type="button" class="bk-opt" role="option" onmousedown="event.preventDefault()" onclick="pgBroCodePick(${jsq(p.propertyCode)})"><b>${esc(p.propertyCode)}</b><span>already exists — ${esc([p.name, p.location].filter(Boolean).join(' · '))}</span></button>`).join('');
  box.innerHTML = (next ? '<div class="bk-sh">Next free code</div>' + next : '') + (have ? '<div class="bk-sh">In the dashboard</div>' + have : '');
  box.classList.toggle('open', !!(next || have));
};
window.pgBroCodePick = c => { const i = $('pgBroCode'); if (i) { i.value = c; } const box = $('pgBroSug'); if (box) box.classList.remove('open'); window.pgBroCheck(); };
async function sendBrochure() {
  const D = dlg;
  const err = m => { if (dlg === D) $('pgErr').textContent = m; };
  const api = window.trackApi;
  if (!api || !api.mutate || !window.bpGenerate) return err('The board is still loading — try again in a moment.');
  if (D.sending) return;
  const save = $('pgSave');
  D.sending = true; save.disabled = true; save.textContent = 'Checking…';
  // While a send is under way the dialog stays (Esc and the backdrop wait); every step after a wait
  // checks it is still this dialog.
  const stop = m => { D.sending = false; if (dlg === D) { save.disabled = false; window.pgBroCheck(); if (m) err(m); } };
  try {
    try { await api.loadInventory(true); } catch (e) { /* checked against what is loaded */ }
    memMemo = null; tagMemo = null; broMemo = null;
    if (dlg !== D) return;
    window.pgBroCheck();   // the dashboard may have changed: the boxes and the verdict follow
    const d = broDraft(), v = broVerdict(d);
    if (!v.ok) return stop('Still needed: ' + v.missing.join(' · '));
    const linkOnly = v.linkOnly;
    // The questions first — nothing is saved until they are answered.
    if (!linkOnly) {
      if (v.warnings.length && !confirm(v.warnings.join('\n') + '\n\nCreate the brochure anyway?')) return stop();
      const st = broState(byId(D.id)).state;
      const req = (v.card && v.card.brochure && v.card.brochure.requestedAt) || st === 'requested' || st === 'building' || (v.existing && String(v.existing.brochureLink || '').trim());
      if (req && !confirm('A brochure was already requested for this property.\n\nSend it again? The pipeline builds a fresh one and emails it again.')) return stop();
    }
    let t = byId(D.id);
    if (!t) return stop('This row was deleted by someone else.');
    save.textContent = linkOnly ? 'Linking…' : 'Sending…';
    // 1. The row takes the code (it is how this row, its card and the dashboard property find each other).
    if (!t.propertyCode) { const r = G.setCode(trackers, t.id, d.code); if (!r.ok) return stop(r.error); persist({ ...t, propertyCode: r.code }, '', true); t = byId(t.id); }
    // 2. Its board card: the one it has, else a new one in the column its posts say.
    let cardId = v.card ? v.card.id : null;
    if (!cardId) cardId = api.createListing({ title: d.title, location: t.location, stageKey: D.stageKey });
    if (!cardId) return stop('Could not add it to the board — try again once the board has loaded.');
    // 3. What the brochure is made from, on the card — the one place for them. Not when only linking
    // (the property's own brochure stands), and an empty box never clears notes the card has.
    if (!linkOnly) {
      const ok = api.mutate(cardId, l => {
        l.title = d.title; l.photosLink = d.photosLink; l.description = d.description;
        if (d.internalNotes || !l.internalNotes) l.internalNotes = d.internalNotes;
        if (!B.isRealCode(l.propertyCode)) l.brochure = { ...(l.brochure || {}), code: d.code };
      }, 'Brochure details set from Posting');
      if (!ok) return stop('Its board card was deleted — try again.');
    } else if (!B.isRealCode((api.listings().find(l => l.id === cardId) || {}).propertyCode)) {
      api.mutate(cardId, l => { if (!B.isRealCode(l.propertyCode)) l.brochure = { ...(l.brochure || {}), code: d.code }; });
    }
    tagMemo = null; broMemo = null;
    // 4. Already in the dashboard: the card is linked to it first (and this row with it).
    if (v.existing) {
      const card = api.listings().find(l => l.id === cardId);
      if (!card || B.codeKey(card.propertyCode) !== B.codeKey(v.existing.propertyCode)) {
        const linked = await window.bpLink(cardId, v.existing.propertyCode);
        if (!linked) return stop(`Could not link it to ${v.existing.propertyCode} — see the board card.`);
      }
      linkRow(t.id, v.existing);
      if (linkOnly) { D.sending = false; if (dlg === D) closeQuiet(); toast(`Linked to ${v.existing.propertyCode} — its brochure is already made`); tagMemo = null; broMemo = null; return renderPosting(); }
    }
    // 5. The request — the board's own path (its checks and demo guard); the questions were asked above.
    const out = await window.bpGenerate(cardId, { confirmed: true });
    tagMemo = null; broMemo = null; memMemo = null;
    if (out !== 'sent') return stop(out === 'busy' ? 'A request for this property is already being sent.' : out === 'failed' ? 'Could not send — check your connection. Nothing was lost.' : 'Not sent — check what is listed on its board card.');
    D.sending = false;
    if (dlg === D) closeQuiet();
    renderPosting();
  } catch (e) {
    console.error('brochure from Posting failed:', e);
    stop('Something went wrong — nothing more was sent. Check the board card.');
  }
}
// A row whose property has reached the dashboard is linked to it (and takes what it does not have yet).
function linkRow(id, p) {
  const t = byId(id);
  if (!t || t.repostOf || G.isSeries(t) || !p || t.propertyId === p.id) return;
  persist(fillFrom({ ...t, propertyId: p.id }, p), '', true);
}
// Once a brochure is delivered its property is in the dashboard: rows with that code are linked to
// it by themselves — once per row per visit, so a link someone removed is not put straight back.
const autoTried = new Set(), codeFixed = new Set();
function autoLink() {
  const invL = invList();
  if (!invL.length) return;
  let byCode = null, byId = null;
  for (const t of trackers) {
    // Linked to a property, but its code is not that property's: the code is put right.
    if (!t.repostOf && !G.isSeries(t) && t.propertyId && !codeFixed.has(t.id)) {
      if (!byId) byId = new Map(invL.map(q => [q.id, q]));
      const p = byId.get(t.propertyId);
      if (p && B.isRealCode(p.propertyCode) && B.codeKey(p.propertyCode) !== B.codeKey(t.propertyCode)) {
        codeFixed.add(t.id);
        if (G.setCode(trackers, t.id, p.propertyCode).ok) persist({ ...t, propertyCode: p.propertyCode }, '', true);
      }
    }
    if (t.repostOf || G.isSeries(t) || t.propertyId || t.noAutoLink || !t.propertyCode || autoTried.has(t.id)) continue;
    if (!byCode) { byCode = new Map(); for (const q of invL) { const k = B.codeKey(q.propertyCode); if (k && !byCode.has(k)) byCode.set(k, q); } }
    const p = byCode.get(B.codeKey(t.propertyCode));
    if (!p) continue;
    autoTried.add(t.id);
    linkRow(t.id, p);
  }
}

// A series is edited in its own dialog; a round of one, like any repost.
window.pgOpenEdit = id => { const t = byId(id); if (t && G.isSeries(t) && !t.repostOf) return window.pgOpenSeriesDlg(id); openDlg('edit', id, ''); };

// ── New series / Edit series ──
// id '' = a new series. The id of a series = edit its name and properties. The id of a plain row with
// no code (a plan line like "T nagar series") = make that row a series, keeping its posts.
window.pgOpenSeriesDlg = id => {
  const t = id ? byId(id) : null;
  if (id && !t) return;
  const editing = !!(t && G.isSeries(t)), converting = !!(t && !editing);
  dlg = { kind: 'series', id: t ? t.id : '', converting, q: '',
    members: editing ? t.members.map(m => ({ ...m })) : [], keys: new Set(editing || converting ? [] : ['igReel', 'fbReel', 'yt']) };
  const save = $('pgSave'); save.style.display = ''; save.textContent = editing ? 'Save' : converting ? 'Make it a series' : 'Create series';
  $('pgErr').textContent = '';
  $('pgModal').querySelector('.tk-box').classList.add('wide');
  $('pgTitle').textContent = editing ? 'Edit series' : converting ? 'Make it a series' : 'New series';
  const name = editing ? t.title || t.reference : converting ? t.title || t.reference : '';
  $('pgBody').innerHTML = `<p class="tk-hint" style="margin-top:0">${converting ? `<b>${esc(G.nameOf(t))}</b> becomes a series — its posts stay as they are. ` : ''}Several properties, each shot on its own, edited into <b>one video</b> and posted as one post. Photos and brochures are checked on each property; each keeps its own posts.</p>
    <label for="pgSerName">Series name</label><input id="pgSerName" type="text" value="${esc(name)}" placeholder="T Nagar series, Studio series…" maxlength="120">
    <label for="pgSerQ">Properties <span class="tk-opt">at least two — tracked here or in the Property dashboard</span></label>
    <div class="sd-pick"><input id="pgSerQ" type="search" placeholder="Search a code, name or area…" autocomplete="off" oninput="pgSerSearch(this.value)" onfocus="pgSerSearch(this.value)" onblur="setTimeout(() => { const b = document.getElementById('pgSerSug'); if (b) b.classList.remove('open'); }, 150)"><div id="pgSerSug" class="bk-sug" role="listbox"></div></div>
    <div id="pgSerMembers" class="sd-mems"></div>
    ${editing || converting ? '' : `<div class="sd-when">
      <div><label for="pgSerDay">Goes out on <span class="tk-opt">optional — or schedule later</span></label><input id="pgSerDay" type="date"></div>
      <div><label for="pgSerTime">Time <span class="tk-opt">empty = planned for the day</span></label><input id="pgSerTime" type="time"></div>
    </div>
    <label>Goes out as</label><div class="bk-types sd-types" id="pgSerTypes"></div>`}
    <label for="pgSerNote">Notes <span class="tk-opt">optional</span></label><input id="pgSerNote" type="text" value="${esc(t ? t.note : '')}" placeholder="e.g. CEO: one Reel for all three, Friday">
    ${editing ? `<p style="margin:14px 0 0"><button type="button" class="tk-btn danger sm" onclick="pgDelete(${jsq(t.id)})">Delete this series</button></p>` : ''}`;
  $('pgModal').classList.add('open');
  loadInv(); pgSerRender();
  setTimeout(() => { const f = $(name ? 'pgSerQ' : 'pgSerName'); if (f) f.focus(); }, 0);
};
function pgSerRender() {
  if (!dlg || dlg.kind !== 'series') return;
  const host = $('pgSerMembers');
  if (host) {
    const ms = G.memberStatus({ kind: 'series', members: dlg.members }, trackers, invList());
    host.innerHTML = ms.length ? ms.map((m, i) => `<div class="sd-mem"><span class="sd-n">${i + 1}</span>${m.propertyCode ? `<span class="ps-code">${esc(m.propertyCode)}</span>` : ''}<b>${esc(m.name)}</b>
        <span class="sd-st"><span class="${m.photosLink ? 'pg-ok' : 'pg-pend'}">${m.photosLink ? '✓ Photos' : 'No photos'}</span><span class="${m.brochure ? 'pg-ok' : 'pg-pend'}">${m.brochure ? '✓ Brochure' : 'No brochure'}</span></span>
        <button type="button" class="bk-x" onclick="pgSerRemove(${i})" aria-label="Remove ${esc(m.name)}">✕</button></div>`).join('')
      : '<div class="tk-hint">No properties picked yet.</div>';
  }
  const types = $('pgSerTypes');
  if (types) types.innerHTML = G.CHANNELS.map(c => `<button type="button" class="bk-type${dlg.keys.has(c.key) ? ' on' : ''}" aria-pressed="${dlg.keys.has(c.key)}" onclick="pgSerKey(${jsq(c.key)})">${chIcon(c.key)}<span>${esc(G.SHORT_CH[c.key])}</span></button>`).join('');
}
const inMembers = (code, id) => dlg.members.some(m => (id && m.trackerId === id) || (G.codeKey(code) && G.codeKey(m.propertyCode) === G.codeKey(code)));
window.pgSerSearch = v => {
  const box = $('pgSerSug'); if (!box || !dlg) return;
  dlg.q = v;
  const q = String(v || '').trim().toLowerCase();
  if (!q) { box.innerHTML = ''; box.classList.remove('open'); return; }
  const tracked = trackers.filter(t => !t.repostOf && !G.isSeries(t) && t.id !== dlg.id && !inMembers(t.propertyCode, t.id) && [t.propertyCode, t.title, t.reference, t.location].join(' ').toLowerCase().includes(q)).slice(0, 6);
  const has = trackedCodes();
  const fromInv = invList().filter(p => G.trackerId(p.propertyCode) && !has.has(G.codeKey(p.propertyCode)) && !inMembers(p.propertyCode) && [p.propertyCode, p.name, p.location].join(' ').toLowerCase().includes(q)).slice(0, 6);
  const opt = (kind, id, code, name, sub) => `<button type="button" class="bk-opt" role="option" onmousedown="event.preventDefault()" onclick="pgSerAdd(${jsq(kind)}, ${jsq(id)})"><b>${esc(code ? code + ' · ' + name : name)}</b><span>${esc(sub)}</span></button>`;
  box.innerHTML = (tracked.length ? '<div class="bk-sh">Tracked</div>' + tracked.map(t => opt('t', t.id, t.propertyCode, G.nameOf(t), t.location || 'on the tracker')).join('') : '') +
    (fromInv.length ? '<div class="bk-sh">Property dashboard</div>' + fromInv.map(p => opt('i', p.id, p.propertyCode, p.name, p.location || '')).join('') : '') +
    (!tracked.length && !fromInv.length ? `<div class="bk-sh">${inv ? 'Nothing matches' : 'Reading the dashboard…'}</div>` : '');
  box.classList.add('open');
};
window.pgSerAdd = (kind, id) => {
  if (!dlg || dlg.kind !== 'series') return;
  if (kind === 't') { const t = byId(id); if (t) dlg.members.push({ trackerId: t.id, propertyCode: t.propertyCode, title: G.nameOf(t) }); }
  else { const p = invList().find(x => x.id === id); if (p) dlg.members.push({ trackerId: '', propertyCode: p.propertyCode, title: p.name }); }
  dlg.members = G.cleanMembers(dlg.members);
  const q = $('pgSerQ'); if (q) { q.value = ''; q.focus(); }
  window.pgSerSearch('');
  pgSerRender();
};
window.pgSerRemove = i => { if (!dlg || dlg.kind !== 'series') return; dlg.members.splice(i, 1); pgSerRender(); };
window.pgSerKey = k => { if (!dlg || dlg.kind !== 'series') return; dlg.keys.has(k) ? dlg.keys.delete(k) : dlg.keys.add(k); pgSerRender(); };
function saveSeries() {
  const err = m => { $('pgErr').textContent = m; };
  const name = ($('pgSerName').value || '').replace(/\s+/g, ' ').trim(), note = ($('pgSerNote').value || '').trim();
  const t = dlg.id ? byId(dlg.id) : null;
  if (dlg.id && !t) { toast('This row was deleted by someone else'); return window.pgClose(); }
  if (!t) {
    const day = fromDateInput(($('pgSerDay') || {}).value), hm = ($('pgSerTime') || {}).value;
    let at = 0;
    if (day && hm) { const [h, m] = hm.split(':').map(Number); const d = new Date(day); d.setHours(h, m, 0, 0); at = d.getTime(); }
    const r = G.newSeries({ title: name, members: dlg.members, note }, day ? [...dlg.keys] : [], { day, at }, now(), who());
    if (!r.ok) return err(r.error);
    closeQuiet();
    persist(r.tracker, 'Series created', false, true);
    const card = ensureCard(byId(r.tracker.id));
    offerUndo('Series created', () => { removeRow(r.tracker.id, 'Undone'); dropCard(card); });
    mode = 'series'; try { localStorage.setItem(K_MODE, mode); } catch (e) {}
    focusId = r.tracker.id; renderPosting();
    return;
  }
  const conv = dlg.converting;
  if (!name) return err('Name the series — e.g. T Nagar series.');
  if (conv && dlg.members.length < 2) return err('Pick at least two properties for the series.');
  // Onto the row as it is now: its name, notes and properties (a plan line keeps its reference).
  const nt = { ...t, kind: 'series', members: G.cleanMembers(dlg.members), note, [t.title || conv ? 'title' : 'reference']: name };
  closeQuiet();
  persist(nt, '', false, true);
  const card = nt.listingId ? '' : ensureCard(byId(nt.id));
  // Undo puts back what this save changed (and the card it made), on the row as it is now.
  offerUndo(conv ? 'Now a series' : 'Series saved', () => {
    const cur = byId(t.id);
    if (cur) persist(G.copyPaths(cur, t, ['kind', 'members', 'note', 'title', 'reference', 'listingId']), 'Undone', false, true);
    dropCard(card);
  });
  renderPosting();
}
window.pgOpenLink = id => openDlg('linkpick', id, '');
window.pgOpenTag = id => openDlg('tag', id, '');
window.pgOpenPlan = () => openDlg('plan', '', '');

// The dialog's Save button is shared by every dialog: a send that disabled it gives it back on close.
const freeSave = () => { const s = $('pgSave'); if (s) s.disabled = false; };
window.pgClose = () => { if (dlg && dlg.sending) return; dlg = null; freeSave(); $('pgModal').classList.remove('open'); renderPosting(); };
function closeQuiet() { dlg = null; freeSave(); $('pgModal').classList.remove('open'); }

window.pgSearchInv = q => {
  const host = $('pgPickList'); if (!host) return;
  if (!inv) { host.innerHTML = '<div class="tk-hint">Reading the dashboard…</div>'; return; }
  const needle = String(q || '').trim().toLowerCase();
  const adding = dlg && dlg.kind === 'add', tracked = trackedCodes();
  const all = inv.filter(p => (!adding || G.trackerId(p.propertyCode)) && (!needle || [p.propertyCode, p.name, p.location].join(' ').toLowerCase().includes(needle))).slice(0, 40);
  host.innerHTML = all.length ? all.map(p => {
    const has = adding && tracked.has(G.codeKey(p.propertyCode));
    return `<button type="button" class="tk-pick" ${has ? 'disabled' : ''} onclick="pgPick(${jsq(p.id)})"><span class="tk-pick-main"><b>${esc(p.propertyCode)} · ${esc(p.name)}</b><span>${esc(p.location)}${has ? ' · already tracked — use Tag on a row to repost it' : ''}</span></span></button>`;
  }).join('') : '<div class="tk-hint">Nothing in the dashboard matches.</div>';
};
window.pgPick = propId => {
  const p = inv && inv.find(x => x.id === propId); if (!p) return;
  if (dlg.kind === 'linkpick') {
    const t = byId(dlg.id); if (!t) return;
    if (!linkTo(t, p)) return;
    return closeQuiet();
  }
  if (!G.trackerId(p.propertyCode)) return;
  if (trackedByCode(p.propertyCode)) { toast('Already tracked'); return; }
  const t = G.blankTracker({ propertyCode: p.propertyCode, title: p.name, location: p.location, photosLink: G.webLink(p.photosLink), details: p.detailsText, propertyId: p.id }, now(), who());
  persist(t, 'Property added');
  closeQuiet();
};

// Tagging: tracked rows first (→ repost), then dashboard properties not tracked yet (→ code + title).
window.pgSearchTag = q => {
  const host = $('pgPickList'); if (!host || !dlg) return;
  const needle = String(q || '').trim().toLowerCase();
  const hit = arr => arr.filter(x => !needle || x.join(' ').toLowerCase().includes(needle));
  const tracked = trackers.filter(t => t.id !== dlg.id && !t.repostOf && (t.propertyCode || t.title))
    .filter(t => !needle || [t.propertyCode, t.title, t.reference, t.location].join(' ').toLowerCase().includes(needle)).slice(0, 25);
  const fromInv = untrackedInv();
  const invHits = hit(fromInv.map(p => [p.propertyCode, p.name, p.location, p.id])).slice(0, 25);
  host.innerHTML =
    (tracked.length ? `<div class="pg-pickhdr">Already tracked — this row becomes a repost</div>` + tracked.map(t =>
      `<button type="button" class="tk-pick" onclick="pgTagTo('t',${jsq(t.id)})"><span class="tk-pick-main"><b>${esc(t.propertyCode || 'no code')} · ${esc(G.nameOf(t))}</b><span>${esc(t.location)} · ↺ repost</span></span></button>`).join('') : '') +
    (invHits.length ? `<div class="pg-pickhdr">In the Property dashboard — this row takes its code</div>` + invHits.map(([code, name, loc, pid]) =>
      `<button type="button" class="tk-pick" onclick="pgTagTo('i',${jsq(pid)})"><span class="tk-pick-main"><b>${esc(code)} · ${esc(name)}</b><span>${esc(loc)}</span></span></button>`).join('') : '') +
    (!tracked.length && !invHits.length ? `<div class="tk-hint">${inv ? 'Nothing matches.' : 'Reading the dashboard…'}</div>` : '');
};
window.pgTagTo = (kind, ref) => {
  const t = byId(dlg && dlg.id);
  if (!t) { toast('This row was deleted by someone else'); return window.pgClose(); }
  if (kind === 't') {
    const o = byId(ref); if (!o) return;
    // Tagged to a series: another round of the series, and a series itself.
    persist({ ...t, repostOf: o.id, propertyCode: '', propertyId: '', kind: G.isSeries(o) ? 'series' : '' }, 'Tagged as a repost of ' + G.nameOf(o));
  } else {
    const p = inv && inv.find(x => x.id === ref); if (!p) return;
    const existing = trackedByCode(p.propertyCode);
    if (existing) persist({ ...t, repostOf: existing.id, propertyCode: '', propertyId: '' }, 'Tagged as a repost of ' + G.nameOf(existing));
    else persist(fillFrom({ ...t, propertyCode: p.propertyCode, propertyId: p.id }, p), 'Tagged to ' + p.propertyCode);
  }
  closeQuiet();
};
window.pgUntag = id => {
  const t = byId(id); if (!t) return;
  persist({ ...t, repostOf: '' }, 'Now its own row');
  closeQuiet();
};

// ── Paste the week plan ──
function planState() {
  const monday = fromDateInput(($('pgMonday') || {}).value) || G.mondayOf(now());
  const parsed = G.parsePlan(($('pgPlanText') || {}).value, G.mondayOf(monday));
  return { monday: G.mondayOf(monday), parsed };
}
const tagKey = it => it.reference.toLowerCase() + '|' + it.day + '|' + it.kind;
// Settings → Configurations: whether a line that says "series" becomes a series.
const planOpts = () => ({ autoSeries: !(window.trackConfig && window.trackConfig().seriesAutoDetect === false) });
window.pgPlanPreview = () => {
  const host = $('pgPlanPreview'); if (!host || !dlg) return;
  const { monday, parsed } = planState();
  if (!parsed.items.length && !parsed.skipped.length) { host.innerHTML = ''; return; }
  const existing = new Set(G.planRows(parsed.items, monday, trackers, now(), '', planOpts()).map(r => r.reference.toLowerCase() + '|' + (r.plannedDate || 0)));
  // The option list is the same for every line: built once per preview, and each line only
  // marks its own choice.
  const own = trackers.filter(t => !t.repostOf && (t.propertyCode || t.title)), free = untrackedInv();
  const optHtml = `<option value="">New — no property yet</option>` +
    (own.length ? `<optgroup label="Already tracked → repost">${own.map(t => `<option value="${esc('t:' + t.id)}">${esc((t.propertyCode ? t.propertyCode + ' · ' : '') + G.nameOf(t))}</option>`).join('')}</optgroup>` : '') +
    (free.length ? `<optgroup label="In the dashboard → takes its code">${free.map(p => `<option value="${esc('i:' + p.id)}">${esc(p.propertyCode + ' · ' + p.name)}</option>`).join('')}</optgroup>` : '');
  const opts = sel => (sel ? optHtml.replace(`<option value="${esc(sel)}">`, `<option value="${esc(sel)}" selected>`) : optHtml);
  host.innerHTML = `<div class="pg-pickhdr">${parsed.items.length} line${parsed.items.length === 1 ? '' : 's'} found</div>
    <div class="pg-planlist">${parsed.items.map((it, i) => {
      const k = tagKey(it);
      if (!(k in dlg.tags)) { const s = G.suggestTag(it.reference, trackers); dlg.tags[k] = s ? 't:' + s : ''; }
      const dup = !existing.has(it.reference.toLowerCase() + '|' + (it.kind === 'youtube' ? 0 : it.day));
      return `<div class="pg-planrow${dup ? ' dup' : ''}">
        <span class="pg-planday">${it.kind === 'youtube' ? 'YouTube · week' : esc(G.dayLabel(it.day))}${it.story ? ` <span class="pg-sbadge" title="Insta Story">${chIcon('igStory')}Story</span>` : ''}</span>
        <span class="pg-planref">${esc(it.reference)}${planOpts().autoSeries && G.isSeriesName(it.reference) && !dlg.tags[k] ? ' <span class="pg-ser">Series</span>' : ''}${dup ? ' <span class="pg-sub">· already added</span>' : ''}</span>
        <select class="pg-plantag" aria-label="Property for ${esc(it.reference)}" data-k="${esc(k)}" onchange="pgPlanTag(this)" ${dup ? 'disabled' : ''}>${opts(dlg.tags[k])}</select>
      </div>`;
    }).join('')}</div>
    ${parsed.skipped.length ? `<p class="tk-hint warn">Not understood, so not added: ${parsed.skipped.map(s => `<code>${esc(s)}</code>`).join(', ')}</p>` : ''}`;
  $('pgSave').textContent = `Add ${existing.size} row${existing.size === 1 ? '' : 's'}`;
};
window.pgPlanTag = sel => { if (dlg && dlg.tags) dlg.tags[sel.getAttribute('data-k')] = sel.value; };

window.pgDelete = id => {
  const reposts = trackers.filter(t => t.repostOf === id);
  const ser = G.isSeries(byId(id));
  if (!confirm((ser ? 'Delete this series? Its posts and links recorded here will be lost. Its properties and their own posts are not touched; its card on the board stays until you delete it there.' : 'Delete this row from the posting tracker? Its posts and links recorded here will be lost.') + (reposts.length ? `\n\n${reposts.length} repost row(s) point at it; they will stay but lose their original.` : ''))) return;
  const gone = byId(id);
  closeQuiet();
  removeRow(id, null);
  // The row is gone locally, so the restore writes it whole again.
  offerUndo('Row deleted', gone ? () => persist(gone, 'Restored', false, true) : null);
};

window.pgSave = () => {
  if (!dlg) return;
  const err = m => { $('pgErr').textContent = m; };
  const t = byId(dlg.id), k = dlg.key, val = id => ($(id) ? $(id).value.trim() : '');
  // A dialog about one row, and that row was deleted while it was open: nothing to save onto.
  if (dlg.kind === 'series') return saveSeries();
  if (dlg.kind === 'brochure') return sendBrochure();
  if (!t && !['add', 'bulk', 'plan'].includes(dlg.kind)) { toast('This row was deleted by someone else'); window.pgClose(); return; }
  let r;
  switch (dlg.kind) {
    case 'schedule': {
      const gs = gateFor(t, 'schedule'); if (!gs.ok) return err(gs.text);
      const at = $('pgAt').value ? new Date($('pgAt').value).getTime() : 0;
      r = G.setChannel(t, k, 'scheduled', { at }, now());
      if (!r.ok) return err(r.error);
      persist(r.tracker, at < now() ? 'Scheduled — that time has passed, so it shows as due' : 'Scheduled'); break;
    }
    case 'live': {
      // A post goes live once its edit is done (an already-live post is only being corrected).
      if (!(t.channels[k] && t.channels[k].status === 'live')) { const gl = gateFor(t, 'live'); if (!gl.ok) return err(gl.text); }
      const liveAt = $('pgLiveAt') && $('pgLiveAt').value ? new Date($('pgLiveAt').value).getTime() : now();
      if (!liveAt || isNaN(liveAt)) return err('Pick when it went live.');
      if (liveAt > now() + 5 * 60000) return err('That time has not come yet — a post goes live when it is out.');
      r = G.setChannel(t, k, 'live', { url: val('pgUrl'), liveAt }, now());
      if (!r.ok) return err(r.error);
      persist(r.tracker, r.tracker.channels[k].url ? 'Marked live' : 'Marked live — remember to add the link'); break;
    }
    case 'link': {
      r = G.setChannelUrl(t, k, val('pgUrl'));
      if (!r.ok) return err(r.error);
      persist(r.tracker, 'Link saved'); break;
    }
    case 'listing': {
      r = G.setListing(t, k, 'posted', { url: val('pgUrl') }, now());
      if (!r.ok) return err(r.error);
      persist(r.tracker, 'Marked posted'); break;
    }
    case 'edit': {
      // Onto the row as it is now, only the fields changed in this form.
      const o = dlg.orig || {};
      const changed = id => !!$(id) && val(id) !== String(o[id] == null ? '' : o[id]).trim();
      let nt = { ...t };
      if (changed('pgRefIn')) nt.reference = val('pgRefIn');
      if (changed('pgDayIn')) nt.plannedDate = fromDateInput(val('pgDayIn'));
      if (changed('pgNote')) nt.note = val('pgNote');
      if (changed('pgTitleIn')) nt.title = val('pgTitleIn');
      if (changed('pgLocIn')) nt.location = val('pgLocIn');
      const card = {};
      if (changed('pgDetails')) card.description = val('pgDetails');
      if (changed('pgPhotos')) {
        const photos = G.cleanUrl(val('pgPhotos'));
        if (!G.validUrl(photos)) return err('The photos link does not look like a web link.');
        card.photosLink = photos;
      }
      if (t.repostOf) { persist(nt, 'Saved'); break; }
      const newCode = val('pgCodeIn');
      if (t.propertyCode && G.codeKey(newCode) !== G.codeKey(t.propertyCode)) {
        // A code set on the wrong property: the row moves. Unlinked from the old property; linked to the
        // new one when it is in the dashboard, and — if asked — takes its title, location, photos and
        // details, which were filled in from the old one. The row's posts and links stay as they are.
        // What came from the old property goes with it: a value equal to the old property's own (its
        // name, location, photos link, details) — anything typed here by hand stays. The brochure follows
        // the code by itself; an old "brochure created" tick on the row goes too.
        const old = invList().find(q => G.codeKey(q.propertyCode) === G.codeKey(t.propertyCode));
        const same = (a, b) => !!String(a || '').trim() && String(a).trim() === String(b || '').trim();
        if (old) {
          if (same(nt.photosLink, G.webLink(old.photosLink)) || same(nt.photosLink, old.photosLink)) nt.photosLink = '';
          if (same(nt.details, old.detailsText)) nt.details = '';
          if (same(nt.location, old.location)) nt.location = '';
          if (same(nt.title, old.name) && String(nt.reference || '').trim()) nt.title = '';   // the plan's name stays the row's name
        }
        nt.brochure = { done: false, at: 0, by: '' };
        if (!newCode) {
          if (!confirm(`Remove the code ${t.propertyCode} from this row?\n\nWhat came from that property (photos, details, brochure) goes with it. Its posts stay.`)) return;
          nt.propertyCode = ''; nt.propertyId = ''; nt.noAutoLink = false;
          if (!nt.title && !nt.reference) nt.reference = t.title || t.propertyCode;
        } else {
          const c = G.setCode(trackers, t.id, newCode);
          if (!c.ok) return err(c.error);
          const m = invList().find(q => G.codeKey(q.propertyCode) === G.codeKey(c.code));
          nt.propertyCode = m ? m.propertyCode : c.code;
          nt.propertyId = m ? m.id : '';
          nt.noAutoLink = false;
          // The right property's own fill what is now empty — and its name replaces the old one's.
          if (m && old && same(nt.title, old.name) && String(m.name || '').trim()) nt.title = m.name;
          if (m) nt = fillFrom(nt, m);
        }
      } else if (!t.propertyCode && newCode) {
        const c = G.setCode(trackers, t.id, newCode);
        if (!c.ok) return err(c.error);
        nt.propertyCode = c.code;
        const m = invFor(nt);
        if (m) nt = fillFrom({ ...nt, propertyCode: m.propertyCode, propertyId: m.id }, m);
      }
      if (!nt.propertyCode && !nt.title && !nt.reference) return err('Keep a reference, a title or a code so the row can be found.');
      // Photos and details go on the property's board card (found by the code — a code set just now
      // included): the board, the brochure and this row read them there. No card (or it was deleted
      // meanwhile): on the row. A card whose brochure is made keeps them as they were (redo it there).
      if (Object.keys(card).length) {
        // (the code was changed in this save: the new property's card, not the old one's)
        const moved = G.codeKey(nt.propertyCode) !== G.codeKey(t.propertyCode);
        const api = window.trackApi, target = dlg.cardId && !moved ? (api && api.listings().find(l => l.id === dlg.cardId)) : listingOf(nt);
        if (target && cardLocked(target)) return err('Its brochure is made from these — to change them, redo the brochure on its board card.');
        const done = target && api && api.mutate ? api.mutate(target.id, l => Object.assign(l, card), 'Photos / details edited from Posting') : null;
        if (done) { tagMemo = null; broMemo = null; memMemo = null; }
        else {
          if ('description' in card) nt.details = card.description;
          if ('photosLink' in card) nt.photosLink = card.photosLink;
        }
        if (done && !G.changedPaths(t, nt).length) { toast('Saved on its board card'); break; }
      }
      persist(nt, 'Saved'); break;
    }
    case 'add': {
      const code = val('pgCode'), name = val('pgTitleIn'), day = fromDateInput(val('pgDay'));
      if (!code && !name) return err('Enter a reference (or title), or a property code.');
      if (code) {
        if (!G.trackerId(code)) return err('Enter a property code with letters or numbers.');
        if (trackedByCode(code)) return err('That property is already tracked. To post it again, add the line and tag it as a repost.');
      }
      const match = code && inv && inv.find(p => G.codeKey(p.propertyCode) === G.codeKey(code));
      const story = $('pgStory') && $('pgStory').checked;
      const seed = { propertyCode: code, title: code ? name : '', reference: code ? '' : name, plannedDate: day, location: val('pgLocIn'), note: val('pgNote'),
        channels: story && day ? { igStory: { status: 'yet', day } } : undefined };
      if (story && !day) return err('Pick the planned date for the Story.');
      let nt = G.blankTracker(seed, now(), who());
      if (match) nt = fillFrom({ ...nt, propertyId: match.id }, match);
      persist(nt, match ? 'Added and linked to the dashboard' : 'Row added'); break;
    }
    case 'bulk': {
      const timeOf = (day, hm) => { if (!hm) return 0; const [h, m] = hm.split(':').map(Number); const d = new Date(day); d.setHours(h, m, 0, 0); return d.getTime(); };
      const entries = dlg.entries.filter(e => e.sel || e.text.trim()).map(e => {
        const keys = [...e.keys], day = fromDateInput(e.day), at = day ? timeOf(day, e.time) : 0;
        if (e.sel && e.sel.kind === 't') return { trackerId: e.sel.id, keys, day, at, ref: (e.ref || '').trim() };
        if (e.sel && e.sel.kind === 'i') { const p = (inv || []).find(x => x.id === e.sel.id); return p ? { inv: { propertyCode: p.propertyCode, title: p.name, propertyId: p.id, location: p.location, photosLink: G.webLink(p.photosLink), details: p.detailsText }, keys, day, at, ref: (e.ref || '').trim() } : null; }
        return { ref: e.text.trim(), keys, day, at };
      }).filter(Boolean);
      // A post with a time needs its edit planned (where the property has a board card).
      const held = entries.filter(e => e.at && e.keys.length).map(e => {
        const t0 = e.trackerId ? byId(e.trackerId) : e.inv ? trackedByCode(e.inv.propertyCode) || { id: '', propertyCode: e.inv.propertyCode } : null;
        return t0 && !gateFor(t0, 'schedule').ok ? (t0.id ? dn(t0) : e.inv.propertyCode) : '';
      }).filter(Boolean);
      if (held.length) return err(`Plan the edit first for ${held.join(', ')} — or leave the time empty to plan the day.`);
      const r = G.bulkSchedule(trackers, entries, {}, now(), who());
      const daysUsed = [...new Set(entries.map(e => e.day))].sort((a, b) => a - b);
      if (r.errors.length) return err(r.errors.join(' '));
      // One write for the lot; Undo takes back only what this submit changed.
      const writes = [...r.update, ...r.create].map(stage).filter(Boolean);
      persistAll(writes);
      order = null; badge(); renderPosting();
      const n = r.update.length + r.create.length;
      offerUndo(`${n} added${daysUsed.length === 1 ? ' to ' + G.dayLabel(daysUsed[0]) : ` across ${daysUsed.length} days`}`, undoAll(writes));
      break;
    }
    case 'plan': {
      const { monday, parsed } = planState();
      if (!parsed.items.length) return err('Paste the plan lines first — e.g. "Monday -S- Lux49 - 4Bhk".');
      for (const it of parsed.items) {
        const sel = dlg.tags[tagKey(it)] || '';
        if (sel.startsWith('t:')) it.tag = { repostOf: sel.slice(2) };
        else if (sel.startsWith('i:')) {
          const p = (inv || []).find(x => x.id === sel.slice(2));
          if (p) it.tag = { propertyCode: p.propertyCode, title: p.name, propertyId: p.id };
        }
      }
      const rows = G.planRows(parsed.items, monday, trackers, now(), who(), planOpts());
      if (!rows.length) return err('Every line here is already on the tracker.');
      persistAll(rows.map(row => {
        const p = row.propertyId && (inv || []).find(x => x.id === row.propertyId);
        return stage(p ? fillFrom(row, p) : row);
      }));
      // A "… series" line is a series: it gets its board card, where its edit is tracked.
      rows.filter(r => G.isSeries(r) && !r.repostOf).forEach(r => ensureCard(byId(r.id)));
      order = null; mode = 'sheet'; sortKey = 'planned';
      try { localStorage.setItem(K_MODE, mode); localStorage.setItem(K_SORT, sortKey); } catch (e) {}
      badge(); renderPosting();
      const skipped = parsed.items.length - rows.length;
      toast(`${rows.length} row${rows.length === 1 ? '' : 's'} added${skipped ? ` · ${skipped} already there` : ''}`);
      break;
    }
    default: return;
  }
  closeQuiet();
};

// Enter confirms a single-field dialog; Escape closes the dialog without saving.
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && dlg && ['schedule', 'live', 'link', 'listing'].includes(dlg.kind) && e.target.tagName === 'INPUT') { e.preventDefault(); window.pgSave(); }
  if (e.key === 'Escape' && e.target && e.target.matches && e.target.matches('.tg-in') && (e.target.value || (e.target.parentElement.querySelector('.tg-sug.open')))) return;   // the tag box clears first
  if (e.key === 'Escape' && dlg && $('pgModal').classList.contains('open')) { e.stopPropagation(); window.pgClose(); }
}, true);
document.addEventListener('mousedown', e => { if (e.target === $('pgModal')) window.pgClose(); });

window.renderPosting = renderPosting;
