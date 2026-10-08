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

let trackers = [];
const MODES = ['today', 'week', 'sheet', 'cards'];
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
const origOf = t => (t && t.repostOf ? byId(t.repostOf) : null);
const codeOf = t => (t.repostOf ? (origOf(t) || {}).propertyCode || '' : t.propertyCode);

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
window.applyPostingSnapshot = list => {
  const next = (Array.isArray(list) ? list : []).map(G.normalizeTracker);
  const same = sameRows(trackers, next);
  trackers = next;
  snapIds = new Set(next.map(t => t.id));
  // Our own write coming back (Firestore echoes every local write): the page already shows it.
  if (same) return;
  badge();
  refresh();
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
  window.trackLoadInventory().then(l => { inv = l || []; refresh(); if (dlg && dlg.kind === 'plan') pgPlanPreview(); });
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
  return [t.propertyCode, t.title, t.reference, t.location, t.details, t.note, o && o.title, o && o.propertyCode, ...tagsOf(t)].join(' ').toLowerCase().includes(q);
}

// ── Tags ──
// A property has one set of tags: those of its listing on the board when there is one (matched by
// property code — a repost by its original's), else the row's own. Editing here edits that same set.
// Built once per render: property code → listing (the first listing with that code, as the board
// shows it), and each row's tags as worked out.
let tagMemo = null;
function memo() {
  if (tagMemo) return tagMemo;
  const byCode = new Map();
  for (const l of (window.trackApi && window.trackApi.listings()) || []) {
    for (const c of [l.propertyCode, l.brochure && l.brochure.code]) { const k = G.codeKey(c); if (k && !byCode.has(k)) byCode.set(k, l); }
  }
  return (tagMemo = { byCode, tags: new Map() });
}
function listingOf(t) {
  const root = (t && t.repostOf && origOf(t)) || t;
  const k = G.codeKey(root && root.propertyCode);
  return k ? memo().byCode.get(k) || null : null;
}
function tagsOf(t) {
  if (!t) return [];
  const m = memo();
  if (!m.tags.has(t.id)) { const l = listingOf(t); m.tags.set(t.id, TG.cleanTags(l ? l.tags : ((t.repostOf && origOf(t)) || t).tags)); }
  return m.tags.get(t.id);
}
// The tag picker changed a listing's tags: show them here at once.
window.pgRedraw = () => { tagMemo = null; if (isOpen() && !dlg) renderPosting(); else stale = true; };
// A listings snapshot: tags may have changed — redraw on the next refresh (through the typing guard).
window.pgListingsChanged = () => { tagMemo = null; stale = true; };
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

const MODE_LABEL = { today: 'Today', week: 'Week', sheet: 'Sheet', cards: 'Properties' };
// The number on each tab answers that tab's question: Today = how many things need you,
// Week = how many posts this week, Sheet / Cards = how many rows.
function urgentCount(base, t0) { return G.tasks(base, t0).reduce((n, g) => n + g.items.filter(i => i.sev >= 3).length, 0); }
function modeCount(m, base) {
  const t0 = now();
  if (m === 'today') return urgentCount(base, t0);
  if (m === 'week') { const a = G.weekAgenda(base, G.mondayOf(t0), t0); return a.days.reduce((n, d) => n + d.items.length, 0) + a.weekItems.length; }
  if (m === 'cards') return new Set(base.map(t => (G.familyOf(trackers, t.id, fams())[0] || t).id)).size;
  return base.length;
}
// Every row's family, built once per render: the Sheet asks for it in every channel cell.
let famIdx = null;
const fams = () => famIdx || G.familyIndex(trackers);

function renderPosting() {
  const el = $('postingView');
  if (!el) return;
  renderWaiting = false; stale = false; shownQ = searchText();
  famIdx = G.familyIndex(trackers);
  tagMemo = null;   // listings and tags are looked up once per render (see listingOf)
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
        <button type="button" class="tk-btn primary" onclick="pgOpenBulk()">+ Add schedule</button>
      </div>
    </div>
    ${line && mode !== 'today' ? `<div class="pg-summary">${line}</div>` : ''}
    ${mode === 'today' ? todayHtml(base) : mode === 'cards' ? propsHtml(base) : mode === 'sheet' ? sheetHtml(base) : queueHtml(base)}`;
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
  switch (g.kind) {
    case 'due': return it.keys.map(k => b('Mark ' + labelOf(k) + ' posted', `pgChannel(${jsq(id)},${jsq(k)},'live')`, 'primary') + b('Reschedule', `pgChannel(${jsq(id)},${jsq(k)},'scheduled')`)).join('');
    case 'link': return it.keys.map(k => b('Add ' + labelOf(k) + ' link', G.CHANNEL_KEYS.includes(k) ? `pgLink(${jsq(id)},${jsq(k)})` : `pgListing(${jsq(id)},${jsq(k)},'posted')`, 'primary')).join('');
    case 'plan': return G.CHANNELS.map(c => `<button type="button" class="tk-btn sm" onclick="pgChannel(${jsq(id)},${jsq(c.key)},'scheduled')">${chLabel(c.key, c.label)}</button>`).join('');
    case 'brochure': return b('Mark brochure created', `pgBrochure(${jsq(id)},true)`, 'primary');
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
      <button type="button" class="pt-name" onclick="pgJump(${jsq(it.id)})" title="Open in the sheet">${esc(dn(it.tracker))}${miniTags(it.tracker)}</button>
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
    <button type="button" class="pt-name" onclick="pgJump(${jsq(it.id)})" title="Open in the sheet">${esc(dn(it.tracker))}${miniTags(it.tracker)}</button>
    <span class="pt-state">${esc(STATE_TXT[it.state])}</span>
    <span class="pt-acts">${itemActions(it)}</span>
  </div>`;
}
// The right buttons for a post in a given state — shared by Today, the week tiles' quick menu.
function itemActions(it, big) {
  const id = it.id, k = it.key, sz = big ? '' : ' sm';
  const b = (label, js, cls) => `<button type="button" class="tk-btn${sz}${cls ? ' ' + cls : ''}" onclick="${js}">${label}</button>`;
  if (!k) return G.CHANNELS.map(c => b(chLabel(c.key, c.label), `pgChannel(${jsq(id)},${jsq(c.key)},'scheduled')`)).join('');
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
    else if (v.status === 'live') h = v.url ? `<a class="ps-link" href="${href(v.url)}" target="_blank" rel="noopener">View post ↗</a>` : `<button type="button" class="pg-warnbtn ps-bad" onclick="pgLink(${jsq(id)},${jsq(key)})">Add link</button>`;
    else if (v.status === 'yet' && v.day) h = `<span class="${lateDay ? 'ps-bad' : 'ps-planned'}">Plan ${esc(G.dayLabel(v.day))}</span>`;
    // Other rounds of the same property on this channel: earlier ones above this round's pill,
    // later ones below — so a repost reads "Live 12 Aug ↗" then "Scheduled 9 Oct", in one cell.
    const hist = G.channelHistory(trackers, id, key, fams());
    const mine = hist.findIndex(x => x.rowId === id);
    const myWhen = mine >= 0 ? hist[mine].when : Infinity;
    const others = hist.filter(x => x.rowId !== id);
    const before = others.filter(x => (x.when || 0) <= myWhen), after = others.filter(x => (x.when || 0) > myWhen);
    const pill = `<select class="pg-sel ps-pill t-${tone}" aria-label="${esc(label)} status" title="${esc(G.STATUS_LABEL[v.status])}" onchange="pgChannel(${jsq(id)},${jsq(key)},this.value)">${opts}</select>`;
    return cell(v.due || v.linkMissing || lateDay ? 'hot' : '', `${histLines(before)}${pill}${sub(h)}${histLines(after)}`);
  }
  if (t.repostOf) {
    const o = origOf(t);
    if (!o) return cell('ps-orig', '<span class="ps-faint">Original deleted</span>');
    if (key === 'brochure') return cell('ps-orig', `<span class="ps-ro ${o.brochure.done ? 'ok' : ''}" title="From the original row">${o.brochure.done ? '✓ Created' : 'Not yet'}</span><div class="ps-sub">from original</div>`);
    const x = o[key];
    const txt = x.status === 'posted' ? (x.url ? `<a class="ps-ro ok" href="${href(x.url)}" target="_blank" rel="noopener">✓ Posted ↗</a>` : '<span class="ps-ro warn">Posted, no link</span>') : x.status === 'na' ? '<span class="ps-ro">N/A</span>' : '<span class="ps-ro">Not posted</span>';
    return cell('ps-orig', `${txt}<div class="ps-sub">from original</div>`);
  }
  if (key === 'brochure') {
    return cell('', `<label class="pg-ck ps-check"><input type="checkbox" ${t.brochure.done ? 'checked' : ''} onchange="pgBrochure(${jsq(id)},this.checked)"><span>${t.brochure.done ? 'Created' : 'Not yet'}</span></label>`);
  }
  const x = t[key];
  const tone = x.status === 'posted' ? (x.url ? 'live' : 'bad') : x.status === 'na' ? 'na' : 'yet';
  const opts = Object.keys(G.LISTING_LABEL).map(s => `<option value="${s}"${x.status === s ? ' selected' : ''}>${SHORT_L[s]}</option>`).join('');
  const h = x.status === 'posted' ? (x.url ? `<a class="ps-link" href="${href(x.url)}" target="_blank" rel="noopener">View listing ↗</a>` : `<button type="button" class="pg-warnbtn ps-bad" onclick="pgListing(${jsq(id)},${jsq(key)},'posted')">Add link</button>`) : '';
  return cell(x.status === 'posted' && !x.url ? 'hot' : '', `<select class="pg-sel ps-pill t-${tone}" aria-label="${esc(label)} status" onchange="pgListing(${jsq(id)},${jsq(key)},this.value)">${opts}</select>${sub(h)}`);
}

// Under the name: the code (or a field to add it), the dashboard state, what media has sent.
function sheetIdentity(t) {
  const id = t.id;
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
  return `<div class="ps-ident">${code}</div><div class="ps-ident">${dot(!!t.photosLink, 'Photos')}${dot(!!t.details, 'Details')}</div>`;
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
  const counts = G.CHANNELS.filter(ch => c[ch.key]).map(ch => `<span class="wk-c">${chIcon(ch.key)}<b>${c[ch.key]}</b> ${PLURAL[ch.key][c[ch.key] === 1 ? 0 : 1]}</span>`).join('') +
    (c.undecided ? `<span class="wk-c undecided">${chIcon(null)}<b>${c.undecided}</b> type not decided</span>` : '');
  const today = G.startOfDay(t0);
  const item = it => {
    const time = it.at ? timeOf(it.at) : '';
    const type = it.key ? G.SHORT_CH[it.key] : 'Not decided';
    return `<button type="button" class="wk-it ws-${it.state}" onclick="pgTile(${jsq(it.id)},${jsq(it.key || '')},${jsq(it.state)})" title="${esc(type + ' · ' + dn(it.tracker) + ' · ' + STATE_TXT[it.state])}">
      <span class="wk-row1"><span class="wk-ch ch-${it.key || 'none'}">${chIcon(it.key)}${esc(type)}</span>${time ? `<span class="wk-tm">${esc(time)}</span>` : ''}</span>
      <span class="wk-nm">${esc(dn(it.tracker))}</span>
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
    <div class="wk-days">${a.days.map(d => `<div class="wk-day${d.day === today ? ' today' : ''}${d.day < today ? ' past' : ''}">
        <div class="wk-dh"><span>${G.formatDate(d.day, F_WD)}</span><b>${new Date(d.day).getDate()}</b></div>
        <div class="wk-items">${d.items.length ? d.items.map(item).join('') : '<span class="wk-empty">—</span>'}</div>
      </div>`).join('')}</div>
    ${a.weekItems.length ? `<div class="wk-week">Also this week: ${a.weekItems.map(it => `<button type="button" class="wk-it ws-planned inline" onclick="pgJump(${jsq(it.id)})"><span class="wk-ch ch-${it.key}">${chIcon(it.key)}${esc(G.SHORT_CH[it.key])}</span><span class="wk-nm">${esc(dn(it.tracker))}</span>${miniTags(it.tracker)}</button>`).join('')}</div>` : ''}
    <div class="wk-legend"><span class="lg live">Live</span><span class="lg scheduled">Scheduled</span><span class="lg planned">Planned, time not set</span><span class="lg due">Due / day passed / link missing</span></div>
  </section>`;
}
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
      big = `${own.filter(t => t.brochure.done).length} of ${own.length}`; small = 'created';
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
  mode = 'cards'; try { localStorage.setItem(K_MODE, mode); } catch (e) {}
  filters = new Set(); focusId = id; renderPosting();
};

function filterBar(base) {
  const t0 = now();
  const btns = G.FILTERS.map(([k, label]) => {
    const n = base.filter(t => G.matchesFilter(t, k, t0)).length;
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
  const list = sortList(base.filter(t => passes(t, t0)));
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
  else if (v.status === 'yet' && v.day) info = `<span class="${lateDay ? 'pg-bad' : 'pg-planned'}">Planned ${esc(G.dayLabel(v.day))} — set the time</span>`;
  return `<div class="pg-ch${v.due || v.linkMissing || lateDay ? ' hot' : ''}">
    <span class="pg-ch-n">${chLabel(c.key, c.label)}</span>
    <select class="pg-sel s-${v.status}" aria-label="${esc(c.label)} status" onchange="pgChannel(${jsq(t.id)},${jsq(c.key)},this.value)">${opts}</select>
    <span class="pg-ch-i">${info}${v.status === 'live' && v.at ? `<span class="pg-sub"> planned ${esc(fmt(v.at))}</span>` : ''}</span>
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
      <span>${G.isUrl(t.photosLink) ? `<a href="${href(t.photosLink)}" target="_blank" rel="noopener">📷 Photos ↗</a>` : t.photosLink ? '<span class="pg-pend">📷 Photos link is not a web link</span>' : '<span class="pg-pend">📷 Photos not received</span>'}</span>
      <span>${t.details ? '<span class="pg-ok">✓ Details received</span>' : '<span class="pg-pend">Details not received</span>'}</span>
      <button type="button" class="tk-link" onclick="pgOpenEdit(${jsq(t.id)})">Edit</button>
    </div>
    <div class="pg-sec">Posts</div>
    ${G.CHANNELS.map(c => channelRow(t, c)).join('')}
    <div class="pg-sec">Brochure &amp; listings</div>
    <label class="pg-ch pg-brochure${t.brochure.done ? '' : (g.some(x => x.kind === 'brochure' && x.sev >= 3) ? ' hot' : '')}">
      <span class="pg-ch-n">Brochure created</span>
      <span class="pg-ck"><input type="checkbox" ${t.brochure.done ? 'checked' : ''} onchange="pgBrochure(${jsq(t.id)},this.checked)"> ${t.brochure.done ? 'Yes' : 'Not yet'}</span>
      <span class="pg-ch-i pg-sub">${t.brochure.done ? esc((t.brochure.by || '').split('@')[0]) + (t.brochure.at ? ' · ' + esc(fmt(t.brochure.at)) : '') : ''}</span>
    </label>
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
      <div class="tk-row-meta"><span>${esc(dn(r.tracker))}</span><span>${esc(r.tracker.location)}</span>${miniTags(r.tracker)}</div>
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
      <div class="tk-row-meta"><span>${esc(dn(r.tracker))}</span>${miniTags(r.tracker)}</div>
    </div>
    <div class="tk-row-side pg-acts">
      <span class="tk-when${r.late ? ' bad' : ''}">${esc(G.dayLabel(r.day))}<br><span class="pg-sub">${r.late ? 'day passed' : 'time not set'}</span></span>
      ${r.key ? `<button type="button" class="tk-btn sm primary" onclick="pgChannel(${jsq(r.id)},${jsq(r.key)},'scheduled')">Set time</button>`
        : G.CHANNELS.map(c => `<button type="button" class="tk-btn sm" onclick="pgChannel(${jsq(r.id)},${jsq(c.key)},'scheduled')">${esc(c.label)}</button>`).join('')}
    </div>
  </div>`;
  const out = [weekStrip(base)];
  const first = groups[0];
  if (first[2].length) out.push(`<div class="tk-group"><div class="tk-group-hdr bad">${first[0]} <span class="tk-count">${first[2].length}</span></div><div class="tk-rows">${first[2].map(row).join('')}</div></div>`);
  if (plan.length) out.push(`<div class="tk-group"><div class="tk-group-hdr ${plan.some(r => r.late) ? 'bad' : 'warn'}">Planned — time not set <span class="tk-count">${plan.length}</span></div>
    <div class="pg-hint">From the weekly plan. Pick the time once it is fixed.</div><div class="tk-rows">${plan.map(planRow).join('')}</div></div>`);
  for (const [label, cls, arr] of groups.slice(1)) out.push(`<div class="tk-group"><div class="tk-group-hdr ${cls}">${label} <span class="tk-count">${arr.length}</span></div><div class="tk-rows">${arr.map(row).join('')}</div></div>`);
  if (missing.length) out.push(`<div class="tk-group"><div class="tk-group-hdr bad">Live, link not shared <span class="tk-count">${missing.length}</span></div>
    <div class="tk-rows">${missing.map(r => `<div class="tk-row"><div class="tk-row-main"><div class="tk-row-top"><span class="tk-row-title">${r.key ? chLabel(r.key, r.label) : esc(r.label)}</span>${codeBadge(r.tracker, true)}</div><div class="tk-row-meta"><span>${esc(dn(r.tracker))}</span></div></div>
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
  // From a week tile's quick menu: the menu has done its job, and left open it would show the old
  // state and hold back every refresh.
  if (dlg && dlg.kind === 'quick') closeQuiet();
  if (!r.ok) { toast(r.error); return renderPosting(); }
  persist(r.tracker);
};
window.pgLink = (id, key) => openDlg('link', id, key);
window.pgListing = (id, key, status) => {
  const t = byId(id); if (!t) return;
  if (status === 'posted') return openDlg('listing', id, key);
  const r = G.setListing(t, key, status, {}, now());
  if (!r.ok) { toast(r.error); return renderPosting(); }
  persist(r.tracker);
};
window.pgBrochure = (id, on) => {
  const t = byId(id); if (!t) return;
  persist(G.setBrochure(t, on, who(), now()), on ? 'Brochure marked created' : null);
};
window.pgUnlink = id => { const t = byId(id); if (t) persist({ ...t, propertyId: '' }); };
window.pgLinkTo = (id, propId) => {
  const t = byId(id); const p = inv && inv.find(x => x.id === propId); if (!t || !p) return;
  persist(fillFrom({ ...t, propertyId: p.id }, p), 'Linked to the Property dashboard');
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
      <p class="tk-hint">It shows as <b>Due</b> when the time passes. It becomes <b>Posted live</b> only when you confirm it.</p>`;
    save.textContent = 'Schedule';
  } else if (kind === 'live') {
    const c = t.channels && t.channels[key];
    title = `${chan.label} — confirm it is live`;
    body = `<p class="tk-hint" style="margin-top:0">${nm}${c && c.at ? ' · planned ' + esc(fmt(c.at)) : ''}</p>
      <label for="pgUrl">Link to the live post</label><input id="pgUrl" type="url" value="${esc((c && c.url) || '')}" placeholder="Open the post, copy its link and paste it here" oninput="pgCheckUrl()">
      <div class="pg-pasterow"><button type="button" class="tk-btn sm" onclick="pgPasteLink()"><i class="fa-regular fa-clipboard" aria-hidden="true"></i> Paste copied link</button><span id="pgUrlHint" class="pg-urlhint" role="status"></span></div>
      <p class="tk-hint warn">You can confirm without the link, but it stays flagged <b>Live — link not shared</b> until you add it.</p>`;
    save.textContent = 'Confirm posted';
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
          ? `<input id="pgCodeIn" type="text" value="${esc(t.propertyCode)}" disabled><p class="tk-hint">The code is set. To change it, delete this row and add it again.</p>`
          : `<input id="pgCodeIn" type="text" placeholder="Add it once created, e.g. TNAG0002"><p class="tk-hint">Already tracked or in the dashboard? <button type="button" class="tk-link" onclick="pgOpenTag(${jsq(t.id)})">Tag that property instead</button></p>`}
        <label for="pgTitleIn">Title</label><input id="pgTitleIn" type="text" value="${esc(t.title)}" placeholder="3BHK in T Nagar">
        <label for="pgLocIn">Location</label><input id="pgLocIn" type="text" value="${esc(t.location)}">
        <label for="pgPhotos">Photos link <span class="tk-opt">from the media team</span></label><input id="pgPhotos" type="url" value="${esc(t.photosLink)}" placeholder="Drive folder link">
        <label for="pgDetails">Property details</label><textarea id="pgDetails" class="tk-area" rows="6" placeholder="Price, size, facing, highlights…">${esc(t.details)}</textarea>
        <p style="margin:12px 0 0"><button type="button" class="tk-btn danger sm" onclick="pgDelete(${jsq(t.id)})">Delete this property's tracker</button></p>`;
    }
    // What the form showed when it opened: Save writes only the fields you changed from these,
    // so a field someone else changed meanwhile is not put back to what this form still shows.
    dlg.orig = { pgRefIn: t.reference, pgDayIn: dateInput(t.plannedDate), pgNote: t.note, pgTitleIn: t.title, pgLocIn: t.location, pgPhotos: t.photosLink, pgDetails: t.details };
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
      <p class="tk-hint"><b>-S-</b> = Insta Story that day. A line without S gets only the day; the channel is picked later. A <b>Youtube - …</b> line is that week's YouTube item. Tag a line to a property you already have to make it a repost.</p>
      <div id="pgPlanPreview"></div>`;
    save.textContent = 'Add rows';
  }
  $('pgTitle').textContent = title;
  $('pgBody').innerHTML = body;
  $('pgModal').classList.add('open');
  if (kind === 'add' || kind === 'linkpick') { pgSearchInv(''); loadInv(); }
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
function newEntry(day) { return { n: ++entrySeq, text: '', sel: null, keys: new Set(), day: day || dateInput(G.startOfDay(now())), time: '' }; }
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
        ${!e.sel ? `<div class="bk-note" id="bkNote-${e.n}" ${e.text.trim() ? '' : 'hidden'}>New reference — code, photos and brochure can come later</div>` : ''}
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
window.pgBulkPick = (n, kind, id) => {
  const e = entryAt(n); if (!e) return;
  if (kind === 't') { const t = byId(id); if (!t) return; e.sel = { kind, id, label: (t.propertyCode ? t.propertyCode + ' · ' : '') + G.nameOf(t) }; }
  else { const p = (inv || []).find(x => x.id === id); if (!p) return; e.sel = { kind, id, label: p.propertyCode + ' · ' + p.name }; }
  pgBulkRender();
};
window.pgBulkUnpick = n => { const e = entryAt(n); if (!e) return; e.sel = null; pgBulkRender(); const inp = document.querySelector(`.bk-row[data-n="${n}"] .bk-in`); if (inp) inp.focus(); };
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
window.pgOpenEdit = id => openDlg('edit', id, '');
window.pgOpenLink = id => openDlg('linkpick', id, '');
window.pgOpenTag = id => openDlg('tag', id, '');
window.pgOpenPlan = () => openDlg('plan', '', '');

window.pgClose = () => { dlg = null; $('pgModal').classList.remove('open'); renderPosting(); };
function closeQuiet() { dlg = null; $('pgModal').classList.remove('open'); }

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
    persist(fillFrom({ ...t, propertyId: p.id }, p), 'Linked to the Property dashboard');
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
    persist({ ...t, repostOf: o.id, propertyCode: '', propertyId: '' }, 'Tagged as a repost of ' + G.nameOf(o));
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
window.pgPlanPreview = () => {
  const host = $('pgPlanPreview'); if (!host || !dlg) return;
  const { monday, parsed } = planState();
  if (!parsed.items.length && !parsed.skipped.length) { host.innerHTML = ''; return; }
  const existing = new Set(G.planRows(parsed.items, monday, trackers, now(), '').map(r => r.reference.toLowerCase() + '|' + (r.plannedDate || 0)));
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
        <span class="pg-planref">${esc(it.reference)}${dup ? ' <span class="pg-sub">· already added</span>' : ''}</span>
        <select class="pg-plantag" aria-label="Property for ${esc(it.reference)}" data-k="${esc(k)}" onchange="pgPlanTag(this)" ${dup ? 'disabled' : ''}>${opts(dlg.tags[k])}</select>
      </div>`;
    }).join('')}</div>
    ${parsed.skipped.length ? `<p class="tk-hint warn">Not understood, so not added: ${parsed.skipped.map(s => `<code>${esc(s)}</code>`).join(', ')}</p>` : ''}`;
  $('pgSave').textContent = `Add ${existing.size} row${existing.size === 1 ? '' : 's'}`;
};
window.pgPlanTag = sel => { if (dlg && dlg.tags) dlg.tags[sel.getAttribute('data-k')] = sel.value; };

window.pgDelete = id => {
  const reposts = trackers.filter(t => t.repostOf === id);
  if (!confirm('Delete this row from the posting tracker? Its posts and links recorded here will be lost.' + (reposts.length ? `\n\n${reposts.length} repost row(s) point at it; they will stay but lose their original.` : ''))) return;
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
  if (!t && !['add', 'bulk', 'plan'].includes(dlg.kind)) { toast('This row was deleted by someone else'); window.pgClose(); return; }
  let r;
  switch (dlg.kind) {
    case 'schedule': {
      const at = $('pgAt').value ? new Date($('pgAt').value).getTime() : 0;
      r = G.setChannel(t, k, 'scheduled', { at }, now());
      if (!r.ok) return err(r.error);
      persist(r.tracker, at < now() ? 'Scheduled — that time has passed, so it shows as due' : 'Scheduled'); break;
    }
    case 'live': {
      r = G.setChannel(t, k, 'live', { url: val('pgUrl') }, now());
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
      if (changed('pgDetails')) nt.details = val('pgDetails');
      if (changed('pgPhotos')) {
        const photos = G.cleanUrl(val('pgPhotos'));
        if (!G.validUrl(photos)) return err('The photos link does not look like a web link.');
        nt.photosLink = photos;
      }
      if (t.repostOf) { persist(nt, 'Saved'); break; }
      if (!t.propertyCode && val('pgCodeIn')) {
        const c = G.setCode(trackers, t.id, val('pgCodeIn'));
        if (!c.ok) return err(c.error);
        nt.propertyCode = c.code;
        const m = invFor(nt);
        if (m) nt = fillFrom({ ...nt, propertyCode: m.propertyCode, propertyId: m.id }, m);
      }
      if (!nt.propertyCode && !nt.title && !nt.reference) return err('Keep a reference, a title or a code so the row can be found.');
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
        if (e.sel && e.sel.kind === 't') return { trackerId: e.sel.id, keys, day, at };
        if (e.sel && e.sel.kind === 'i') { const p = (inv || []).find(x => x.id === e.sel.id); return p ? { inv: { propertyCode: p.propertyCode, title: p.name, propertyId: p.id, location: p.location, photosLink: G.webLink(p.photosLink), details: p.detailsText }, keys, day, at } : null; }
        return { ref: e.text.trim(), keys, day, at };
      }).filter(Boolean);
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
      const rows = G.planRows(parsed.items, monday, trackers, now(), who());
      if (!rows.length) return err('Every line here is already on the tracker.');
      persistAll(rows.map(row => {
        const p = row.propertyId && (inv || []).find(x => x.id === row.propertyId);
        return stage(p ? fillFrom(row, p) : row);
      }));
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
