// ═══════ MATCH (match.html) ═══════
// Both directions of matching on one page, over /api/match (api/_match.js):
//   · Find properties for a requirement — every opportunity we hold, onboarded or still on its way
//     in (Shoot board card, CRM seller lead, agent's listing), each saying how far it has got.
//   · Find clients for a property — the seller's words, a property code, or the form.
// ONE search: a two-way toggle (Find properties | Find clients) above ONE box. The toggle is sent as
// `prefer`; the server reads the words and may answer the other way (a code always means clients),
// and the toggle then follows the answer so the screen agrees with the search. "More options" holds
// the field-by-field form for the side the toggle is on. After a search, "I read this as …" under
// the box says what was understood; tapping it opens More options filled in.
//
// Deep links: ?lead=<id> (properties for that lead) · ?property=<id|code> / ?listing=<id> /
// ?seller=<id> (clients) · ?q=<text> (search) · &for=clients (the toggle).
//
// Modern Web Guidance applied: the toggle is a fieldset of native radios (not a tablist); a real
// search form (Enter submits natively, IME-safe — no custom key handler); secondary content in
// <details>; filters in a native <dialog> (a panel via show() when wide, a bottom drawer via
// showModal() on a phone, scroll contained in CSS); the ⋯ menu is a native popover (light dismiss,
// Esc, focus return for free); each card is an <article> size container; the count is a polite live
// region and the loading skeleton is aria-hidden; Share uses the Web Share API where there is one
// and reports a failed copy too; every value is escaped before it reaches the page.
import { $, esc, whenSignedIn, toast, busy, auth, api, ago } from '../shared-assets/agent-client.js';

const me = await whenSignedIn();
window.AppNav.boot({ console: 'match', select: () => {}, signOut: () => import('../shared-assets/agent-client.js').then(m => m.signOutHere()) });
window.AppNav.setUser(me.email);
window.AppNav.setActive('match');
const isAgent = me.role === 'agent';

async function mt(action, body = {}) {
  const token = await auth.currentUser.getIdToken();
  const r = await fetch('/api/match', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ action, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) { const e = new Error(j.error || 'Something went wrong — try again'); e.status = r.status; throw e; }
  return j;
}

// ── Small helpers ──
const lc = s => String(s == null ? '' : s).trim().toLowerCase();
const list = s => String(s || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
const num = v => { const n = Number(v); return Number.isFinite(n) && v !== '' && v != null ? n : null; };
// "1.5 Cr" · "80 L" · "45k" · "1,20,000" → rupees. A bare small number reads as crores below 100
// and lakhs below 1,000 (the way the team writes a price), anything bigger as rupees.
function money(v, unit = 'total') {
  const s = lc(v).replace(/₹|rs\.?|inr/g, '').replace(/,/g, '').replace(/\/\s*(mo|month)$|\s*(a|per)\s*month$/, '').trim();
  if (!s) return null;
  const m = s.match(/^([\d.]+)\s*(cr|crore|crores|l|lac|lakh|lakhs|k|thousand)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = m[2] || '';
  if (/^cr/.test(u)) return Math.round(n * 1e7);
  if (/^l/.test(u)) return Math.round(n * 1e5);
  if (/^(k|th)/.test(u)) return Math.round(n * 1e3);
  // A monthly rent or a rate per sq ft of "45" is 45k / ₹45, never 45 crore.
  if (unit === 'per_month') return n < 1000 ? Math.round(n * 1e3) : Math.round(n);
  if (unit === 'per_sqft') return Math.round(n);
  return n < 100 ? Math.round(n * 1e7) : n < 1000 ? Math.round(n * 1e5) : Math.round(n);
}
const trim0 = n => String(Math.round(n * 100) / 100);
const fmtMoney = n => (n == null ? '' : n >= 1e7 ? trim0(n / 1e7) + ' Cr' : n >= 1e5 ? trim0(n / 1e5) + ' L' : n >= 1e3 ? trim0(n / 1e3) + 'k' : String(n));
const phoneDigits = p => { const d = String(p || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d; };
// "+91 98844 71343" — the way a number is read out on a call.
function fmtPhone(p) {
  const d = phoneDigits(p);
  if (d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d.slice(2))) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  return String(p || '');
}
// Not a normal Indian mobile (a landline, a toll-free number, a typo): shown as stored, flagged.
const phoneOk = p => { const d = phoneDigits(p); return d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d.slice(2)); };
// "20 Nov" (and the year when it is not this one).
function fmtDay(v) {
  const d = new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
  if (!v || Number.isNaN(d.getTime())) return '';
  const o = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  return new Intl.DateTimeFormat('en-IN', o).format(d);
}
// A reason, short: no parenthetical, nothing after the dash.
const cutParens = s => String(s || '').replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
const shortWhy = s => cutParens(s).split(' — ')[0].trim();
const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const nameFromEmail = e => (String(e || '').includes('@') ? cap(String(e).split('@')[0].replace(/[._-]+/g, ' ')) : String(e || ''));
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const BAND_ICON = { strong: 'fa-circle-check', good: 'fa-thumbs-up', partial: 'fa-circle-half-stroke', weak: 'fa-circle-minus', 'ruled-out': 'fa-ban' };
const SRC_NAME = { listing: 'Shoot board', seller: 'Seller lead', submission: 'Agent’s listing' };
const TRUST = {
  verified: { short: 'Verified', cls: 'v', icon: 'fa-circle-check' },
  seller: { short: 'Seller-provided', cls: 's', icon: 'fa-user' },
  agent: { short: 'Agent-provided', cls: 'a', icon: 'fa-id-badge' },
  chat: { short: 'AI-read', cls: 'c', icon: 'fa-comment-dots' },
  missing: { short: 'Not known yet', cls: 'm', icon: 'fa-circle-question' },
};

// ── State ──
const S = {
  base: null,        // the last search, without filters and sort (re-run when they change)
  mode: null,        // properties | clients | demand | pick — as the server answered
  about: null,       // the property a clients search was for
  reading: null,     // what the engine read (properties)
  rows: [],
  seq: 0,
  label: '',         // how the search was asked, for the title and the request reason
  last: null,        // the last response
  aiItems: null,
  requested: new Set(),   // what this agent has asked for on this page (refs / property ids)
};

// ── The toggle: Find properties | Find clients ──
const segInputs = [...document.querySelectorAll('#forSeg input[name="for"]')];
const forMode = () => (segInputs.find(i => i.checked) || {}).value || 'properties';
const COPY = {
  properties: { label: 'What the buyer wants', ph: '3 BHK Anna Nagar under 3 Cr', hint: 'What the buyer wants — or a client’s name or phone number.' },
  clients: { label: 'The seller’s property', ph: '2 BHK rent Porur 22k', hint: 'The seller’s property as they told you — or a code like ANR003.' },
};
function setFor(mode, { remember = false } = {}) {
  const m = mode === 'clients' ? 'clients' : 'properties';
  segInputs.forEach(i => { i.checked = i.value === m; });
  const c = COPY[m];
  $('qL').textContent = c.label;
  $('q').placeholder = c.ph;
  $('qHint').textContent = c.hint;
  document.querySelectorAll('#egs [data-for]').forEach(b => { b.hidden = b.dataset.for !== m; });
  $('refineProps').hidden = m !== 'properties';
  $('refineClients').hidden = m !== 'clients';
  syncForParam();
  if (remember) { try { localStorage.setItem('matchFor', m); } catch (e) { /* private mode: the URL still has it */ } }
}
function syncForParam() {
  try {
    const u = new URL(location.href);
    if (forMode() === 'clients') u.searchParams.set('for', 'clients'); else u.searchParams.delete('for');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  } catch (e) { /* fine */ }
}
// Which side of the toggle an answer belongs to.
const sideOf = r => (r.mode === 'properties' ? 'properties' : r.mode === 'pick' ? (r.pick === 'property' ? 'clients' : 'properties') : 'clients');
segInputs.forEach(i => i.addEventListener('change', () => {
  const want = forMode();
  setFor(want, { remember: true });
  // Came to these clients from a list (See buyers / Matching clients): "Find properties" goes back.
  if (want === 'properties' && S.mode === 'clients' && S.prev) { goBack(); return; }
  // The same words, the other way round — but a code always means its buyers, so switching away
  // from them puts those results aside instead of flipping straight back.
  const text = $('q').value.trim();
  if (text && S.base && S.base.text === egText(text) && !(want === 'properties' && isCode(text))) { searchText(egText(text), { label: text }); return; }
  // Results from the other side are kept aside, not lost: switching back brings them back.
  if (S.mode && sideOf(S.last || {}) !== want) { S.parked = S.last; S.parkedBase = S.base; S.mode = null; showIdle(); }
  else if (!S.mode && S.parked && sideOf(S.parked) === want) { const r = S.parked; S.base = S.parkedBase; S.parked = null; S.mode = r.mode; $('results').hidden = false; draw(r, { fresh: false }); }
}));

// Nothing on screen yet: the helper and the examples show, the reading does not.
function showIdle() {
  $('results').hidden = true;
  $('leadBox').hidden = true;
  $('readAs').hidden = true;
  $('qHint').hidden = false;
  $('egs').hidden = false;
}

// ── Filters and sort → the API's `filters` / `sort` ──
const checked = name => [...document.querySelectorAll(`#filterForm input[name="${name}"]:checked`)].map(i => i.value);
function readFilters() {
  const f = {};
  const types = checked('fType'); if (types.length) f.types = types;
  const src = checked('fSrc'); if (src.length) f.sources = src;
  const deals = checked('fDeal'); if (deals.length) f.deals = deals;
  const bhk = checked('fBhk').map(Number); if (bhk.length) f.bhk = bhk.includes(5) ? bhk.concat([6, 7, 8]) : bhk;
  const loc = $('fLoc').value.trim(); if (loc) f.location = loc;
  const bMin = money($('fBMin').value); if (bMin) f.budgetMin = bMin;
  const bMax = money($('fBMax').value); if (bMax) f.budgetMax = bMax;
  const aMin = num($('fAMin').value); if (aMin) f.areaMin = aMin;
  const aMax = num($('fAMax').value); if (aMax) f.areaMax = aMax;
  const minPct = num($('fMin').value); if (minPct) f.minPct = minPct;
  if ($('fOut').checked) f.showRuledOut = true;
  if (S.mine && S.mode === 'clients') f.mine = true;
  return f;
}
// Only the filters that work on what is listed count (client rows have no price, type or source).
function activeFilterCount() {
  const f = readFilters();
  const clientKeys = ['location', 'minPct', 'showRuledOut'];
  // "Mine" has its own chip above the list: it is not counted on the Filters button.
  return Object.keys(f).filter(k => k !== 'mine' && (S.mode !== 'clients' || clientKeys.includes(k))).length;
}
function syncFilterBar() {
  const forClients = S.mode === 'clients';
  document.querySelectorAll('#filterForm [data-for="properties"]').forEach(el => { el.hidden = forClients; });
  // The demand list and a pick list are not filtered or sorted by the server: offer neither.
  const empty = S.last && !S.last.total && !(S.last.rows || []).length && !activeFilterCount() && !S.mine;
  $('tools').hidden = S.mode === 'demand' || S.mode === 'pick' || !!empty;
  if ($('tools').hidden && $('filters').open) $('filters').close();
  const n = activeFilterCount();
  $('filterN').hidden = !n;
  $('filterN').textContent = n ? String(n) : '';
}
let refilterT = null;
function refilter() {
  syncFilterBar();
  clearTimeout(refilterT);
  if (!S.base) return;
  refilterT = setTimeout(() => run(S.base, { keepLabel: true }), 350);
}
$('filterForm').addEventListener('input', refilter);
$('filterForm').addEventListener('change', refilter);
$('filterForm').addEventListener('submit', e => e.preventDefault());
$('filterForm').addEventListener('reset', () => setTimeout(refilter, 0));
$('sort').addEventListener('change', refilter);

// The filters panel: inline under the header when there is room, a drawer from the bottom on a
// phone. One <dialog>: show() keeps it in the page, showModal() makes it the drawer.
const fdlg = $('filters');
const phoneWide = () => matchMedia('(max-width: 640px)').matches;
function openFilters() {
  if (phoneWide()) { fdlg.setAttribute('closedby', 'any'); fdlg.showModal(); }
  else { fdlg.removeAttribute('closedby'); fdlg.show(); }
  $('filterBtn').setAttribute('aria-expanded', 'true');
}
$('filterBtn').addEventListener('click', () => (fdlg.open ? fdlg.close() : openFilters()));
fdlg.addEventListener('close', () => $('filterBtn').setAttribute('aria-expanded', 'false'));
$('filterClose').addEventListener('click', () => fdlg.close());
$('filterShow').addEventListener('click', () => { fdlg.close(); $('results').scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' }); });

// ── Running a search ──
function skeleton() {
  $('list').innerHTML = '<li class="mt-sk" aria-hidden="true"></li><li class="mt-sk" aria-hidden="true"></li><li class="mt-sk" aria-hidden="true"></li>';
}
async function run(base, { label = null, keepLabel = false } = {}) {
  S.base = base;
  if (!keepLabel) { S.label = label || ''; S.mine = false; }
  const seq = ++S.seq;
  $('results').hidden = false;
  $('results').dataset.loading = '1';
  $('resCount').textContent = 'Searching…';
  if (!keepLabel) skeleton();
  // Ruled-out rows sort last: with only the top 60 they would never show, so ask for more.
  const filters = readFilters();
  const body = { ...base, filters, sort: $('sort').value, limit: filters.showRuledOut ? 200 : 60 };
  try {
    const r = await mt('search', body);
    if (seq !== S.seq) return;
    // A name or number that found exactly one client: straight to their properties.
    if (r.mode === 'pick' && r.pick === 'lead' && (r.rows || []).length === 1) { openLead(r.rows[0]); return; }
    S.mode = r.mode; S.last = r; S.rows = r.rows || []; S.about = r.about || null; S.reading = r.reading || null; S.parked = null;
    draw(r, { fresh: !keepLabel });
    if (!keepLabel) reveal(r);
  } catch (e) {
    if (seq !== S.seq) return;
    // A record that is not there says which record, not "tell me about the property".
    const msg = e.status !== 403 && /tell me about the property|no such property/i.test(e.message)
      ? (base.propertyId ? `No property has the code or id “${base.propertyId}”. Check the code, or describe the property instead.`
        : base.listingId ? 'That Shoot board card is not here any more — it may have been removed or merged.'
          : base.sellerLeadId ? 'That seller lead is not here any more.' : e.message)
      : e.message;
    S.mode = null; S.last = null; S.rows = [];
    $('mineRow').hidden = true;
    $('resTitle').textContent = 'No results';
    $('resCount').textContent = msg;
    $('resNote').hidden = true;
    $('tools').hidden = true;
    $('readAs').hidden = true;
    $('list').innerHTML = `<li class="empty"><i class="fa-regular fa-circle-question" aria-hidden="true"></i>${esc(msg)}</li>`;
  } finally {
    if (seq === S.seq) delete $('results').dataset.loading;
  }
}
// An example chip puts its short label in the box ("Seller leads with buyers"); the API gets the
// sentence it stands for. A deep link with that sentence shows the label again.
const EGS = [...document.querySelectorAll('#egs [data-eg]')].map(b => [b.textContent.trim(), b.dataset.eg]);
const egText = t => (EGS.find(([l]) => lc(l) === lc(t)) || [0, t])[1];
const egLabel = t => (EGS.find(([, x]) => x === t) || [t])[0];
// A property code (ANR003, ADYA 001, SH122W01).
const isCode = text => /^[a-z]{2,6}[\s_-]?\d{2,5}[a-z0-9_]*$/i.test(text) && /\d/.test(text) && !/^\d+$/.test(text);
function searchText(text, { label = egLabel(text) } = {}) {
  // A code names a property whichever side is on: the person wants its buyers, so the toggle goes
  // to Find clients and the screen agrees with the search.
  if (isCode(text) && forMode() !== 'clients') setFor('clients');
  setUrl({ q: text });
  run({ action: 'search', mode: 'smart', text, prefer: forMode() }, { label });
}

// After a new search, make sure the answer is in view (the title, the count and the top of the
// first card). A client's own requirement comes first in lead mode, so that box is what is shown.
function reveal(r, { force = false } = {}) {
  const el = r.mode === 'properties' && r.reading && r.reading.from === 'lead' ? $('leadBox') : $('results');
  if (!el || el.hidden) return;
  const top = el.getBoundingClientRect().top;
  if (force || top > innerHeight * 0.55 || top < 0) el.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
}

// Keep the address shareable (and the Back button sensible) without a reload.
function setUrl(params) {
  try {
    const u = new URL(location.href);
    ['q', 'lead', 'property', 'listing', 'seller', 'req'].forEach(k => u.searchParams.delete(k));
    Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') u.searchParams.set(k, v); });
    history.replaceState(history.state, '', u.pathname + u.search);
  } catch (e) { /* fine */ }
  syncForParam();
}

// ── Drawing ──
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function titleFor(r) {
  if (r.mode === 'clients') return S.about ? `Clients for ${S.about.name || 'this property'}` : 'Matching clients';
  if (r.mode === 'demand') return r.scope === 'shoot' ? 'Shoot board properties with buyers' : 'Not-yet-onboarded properties with buyers';
  if (S.base && S.base.leadId) return r.reading && r.reading.leadName ? `Properties for ${r.reading.leadName}` : 'Properties for this client';
  return S.label ? `Properties for “${S.label}”` : 'Matching properties';
}
// ONE count line: "63 matches · 29 onboarded · 34 not yet".
// With "Mine" on: how many are this agent's. The server's total can still be everyone's, so when
// the list it sent is complete (under the page limit) the rows themselves are the count.
function mineCount(r) {
  const got = (r.rows || []).filter(x => !x.vetoed).length;
  return (r.rows || []).length < 60 ? got : (r.yours != null && r.held ? r.yours : r.total);
}
function countFor(r) {
  const n = S.mine ? mineCount(r) : r.total != null ? r.total : (r.rows || []).filter(x => !x.vetoed).length;
  if (r.mode === 'demand') return plural(n, 'property has buyers', 'properties have buyers');
  const bits = [plural(n, 'match', 'matches')];
  // The per-source counts include ruled-out rows when those are shown: only split when they are not.
  if (r.mode === 'properties' && r.counts && !readFilters().showRuledOut) {
    const on = r.counts.onboarded || 0;
    const notYet = Object.entries(r.counts).filter(([k]) => k !== 'onboarded').reduce((s, [, v]) => s + (v || 0), 0);
    if (on && notYet) bits.push(`${on} onboarded`, `${notYet} not yet`);
    else if (notYet) bits.push('none onboarded yet');
    else if (on) bits.push('all onboarded');
  }
  // Agents: "N yours · M held by others" — as a "Mine" chip when they have any, else in the count.
  if (r.mode === 'clients' && r.yours != null && !S.mine && !(r.yours > 0)) bits.push(`${r.yours} yours`, `${r.held || 0} held by others`);
  const filters = readFilters();
  if (r.ruledOut && filters.showRuledOut) bits.push(`${r.ruledOut} ruled out`);
  const shown = (r.rows || []).filter(x => !x.vetoed).length;
  if (n > shown) bits.push(`top ${shown} shown`);
  return bits.join(' · ');
}
function draw(r, { fresh = true } = {}) {
  $('resTitle').textContent = titleFor(r);
  $('resCount').textContent = r.mode === 'pick' ? '' : countFor(r);
  // The toggle follows the answer, so the screen agrees with the search.
  if (sideOf(r) !== forMode()) setFor(sideOf(r));
  syncFilterBar();
  $('filterShow').textContent = r.total ? `Show ${r.total}` : 'Show results';
  drawNotes(r);
  drawMine(r);
  if (r.mode === 'properties' && r.reading && r.reading.from === 'lead') drawLeadReading(r.reading);
  else { $('leadBox').hidden = true; closeEditor(); }
  drawReadAs(r, { fresh });
  if (r.mode === 'pick') { drawPick(r); return; }

  const rows = r.rows || [];
  if (!rows.length) {
    // Nothing fits, but some were ruled out: say how many and show why with one tap.
    if (r.ruledOut && !readFilters().showRuledOut) {
      $('list').innerHTML = `<li class="empty"><i class="fa-regular fa-folder-open" aria-hidden="true"></i><span>No match yet — ${esc(r.ruledOut)} ${r.ruledOut === 1 ? 'was' : 'were'} ruled out.</span> <button type="button" class="btn sm" data-seewhy="1">See why</button></li>`;
      return;
    }
    const why = r.mode === 'clients' ? 'No client’s requirement fits this property well enough yet.'
      : r.mode === 'demand' ? 'None of this stock has a matching buyer yet.'
        : activeFilterCount() ? 'Nothing fits with these filters. Clear a filter, or widen the budget.' : 'Nothing fits well enough yet. Try a wider budget, or check what I read above.';
    $('list').innerHTML = `<li class="empty"><i class="fa-regular fa-folder-open" aria-hidden="true"></i>${esc(why)}</li>`;
    return;
  }
  $('list').innerHTML = rows.map((row, i) => r.mode === 'clients' ? clientCard(row, i) : r.mode === 'demand' ? demandCard(row, i) : propertyCard(row, i)).join('');
}
// An agent's own clients, one tap: "Mine · 16" re-asks the server for only the clients they work.
function drawMine(r) {
  const show = isAgent && r.mode === 'clients' && (S.mine || r.yours > 0);
  $('mineRow').hidden = !show;
  if (!show) return;
  const n = S.mine ? mineCount(r) : r.yours != null ? r.yours : r.total;
  $('mineRow').innerHTML = `<button type="button" class="chip mt-mine" aria-pressed="${S.mine ? 'true' : 'false'}" data-mine="1">`
    + `<i class="fa-solid ${S.mine ? 'fa-check' : 'fa-user'}" aria-hidden="true"></i> Mine · ${esc(n)}</button>`
    + (S.mine ? '' : ` <span class="mt-minenote">${esc(r.held || 0)} held by others</span>`);
}
$('mineRow').addEventListener('click', e => {
  if (!e.target.closest('[data-mine]')) return;
  S.mine = !S.mine;
  refilter();
});
// The line under the title: a way to turn the same words round, or back to the list this came from.
function drawNotes(r) {
  const notes = [];
  const smart = S.base && S.base.mode === 'smart' && S.base.text;
  if (smart && S.base.prefer === 'properties' && r.mode === 'clients' && !isCodeSearch()) {
    notes.push('Read as “find clients for this property”. <button type="button" class="linkbtn" data-redo="properties">Find properties for it instead</button>');
  }
  // A seller on the phone gets typed into the box on Find properties too ("2 BHK flat for rent in
  // Porur 22k"): one tap turns the same words round into "who are my buyers for it".
  const buyerWords = /\b(?:under|within|below|budget|max(?:imum)?|up\s*to|upto|kulla|not|except|looking|wants?|needs?|venum|client|buyer|customer|ready\s+to\s+move)\b/i;
  if (smart && S.base.prefer === 'properties' && r.mode === 'properties' && !buyerWords.test(S.base.text)) {
    notes.push('A seller’s property, not a buyer’s requirement? <button type="button" class="linkbtn" data-redo="clients">Find buyers for it instead</button>');
  }
  if (smart && S.base.prefer === 'clients' && r.mode === 'properties') {
    notes.push('Read as a buyer’s requirement, so these are properties. <button type="button" class="linkbtn" data-redo="clients">Find clients for it instead</button>');
  }
  if (S.prev && r.mode === 'clients') notes.push(`<button type="button" class="linkbtn" data-back="1">← Back to ${esc(S.prev.title || 'the list')}</button>`);
  $('resNote').innerHTML = notes.join('<br>');
  $('resNote').hidden = !notes.length;
}
const isCodeSearch = () => S.base && isCode(S.base.text || '');

// "I read this as: Rent · Apartment · 2 BHK · Porur" — the same reading the chips come from, and
// "Not stated" from that same reading. Tapping it opens More options, filled in.
const DEAL_WORD_P = { sale: 'Sale', rent: 'Rent', lease: 'Lease', jv: 'Joint venture' };
function aboutValues(a) {
  const bhk = String(a.name || '').match(/(\d)\s*bhk/i);
  return [DEAL_WORD_P[a.deal] || '', a.type, a.sub, bhk ? bhk[1] + ' BHK' : '', a.location, a.price].filter(Boolean);
}
// A chip's value said so it keeps its meaning on one line: "not Mogappair", not a bare "Mogappair".
const CHIP_SAY = { exclude: v => 'not ' + v, radius: v => 'within ' + v, mustHave: v => 'must have ' + v, corridor: v => v + ' corridor' };
const chipValue = c => (CHIP_SAY[c.field] ? CHIP_SAY[c.field](c.value) : c.value);
function drawReadAs(r, { fresh }) {
  let vals = [], missing = [];
  if (r.mode === 'properties' && r.reading && r.reading.from !== 'lead') {
    vals = (r.reading.chips || []).map(chipValue);
    missing = r.reading.missing || [];
    // Every new search refills the form with what it read (a filter change must not undo edits in
    // progress); a search made from the form keeps what was typed there.
    if (fresh && r.reading.from === 'text') fillItem(r.reading.item || {});
  } else if (r.mode === 'clients' && S.about) {
    vals = aboutValues(S.about);
    // A search made from the form keeps what was typed there; any other refills it.
    if (fresh && !(S.base && S.base.details)) fillDetailsFromAbout(S.about);
  }
  const show = vals.length > 0;
  $('readAs').hidden = !show;
  if (show) {
    $('readAs').innerHTML = `<span class="mt-readas-l">I read this as:</span> <b>${vals.map(esc).join(' · ')}</b>`
      + (missing.length ? ` <span class="mt-readas-m">Not stated: ${esc(missing.join(', '))}</span>` : '')
      + ' <i class="fa-regular fa-pen-to-square" aria-hidden="true"></i>';
  }
  // Once results show, the helper and the examples give way to the reading (and the results).
  $('qHint').hidden = true;
  $('egs').hidden = true;
}
$('readAs').addEventListener('click', () => {
  $('refine').open = true;
  const first = forMode() === 'clients' ? $('dType') : $('iDeal');
  $('refine').scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
  first.focus({ preventScroll: true });
});

// Words that named a person (or a property) rather than a requirement: pick one.
function openLead(x) {
  if (x.seller) { setFor('clients'); setUrl({ seller: x.leadId }); run({ action: 'search', mode: 'clients', sellerLeadId: x.leadId }, { label: '' }); }
  else { setFor('properties'); setUrl({ lead: x.leadId }); run({ action: 'search', mode: 'properties', leadId: x.leadId }, { label: '' }); }
}
function drawPick(r) {
  const rows = r.rows || [];
  $('resTitle').textContent = r.pick === 'property' ? `Properties matching “${r.text}”` : `Clients matching “${r.text}”`;
  $('resCount').textContent = rows.length ? (r.pick === 'property' ? 'Pick one to see who wants it' : 'Pick one to see properties for them') : 'Nobody by that name or number';
  $('resNote').hidden = true;
  if (!rows.length) {
    $('list').innerHTML = `<li class="empty"><i class="fa-regular fa-circle-question" aria-hidden="true"></i>${r.pick === 'property'
      ? 'No property has that name or code. Describe it instead — type, place, size and price.'
      : 'No client has that name or number. To search by requirement, add a place, a budget or a BHK.'}</li>`;
    return;
  }
  // The whole card is one button: tapping it opens that client (or property).
  $('list').innerHTML = rows.map((x, k) => r.pick === 'property'
    ? `<li><button type="button" class="card mt-pick" data-pick-prop="${esc(x.propertyId)}"><b>${esc(x.code)} · ${esc(x.name)}</b><span>${esc([x.location, x.price].filter(Boolean).join(' · '))}</span></button></li>`
    : `<li><button type="button" class="card mt-pick" data-pick-lead="${k}"${x.seller ? ' data-seller="1"' : ''}><b>${esc(x.name)}</b>`
      + `<span>${esc([x.seller ? 'Seller' : '', x.stage, x.phoneEnd].filter(Boolean).join(' · '))}</span>`
      + (x.requirement ? `<span class="mt-pick-r">${esc(x.requirement)}</span>` : '') + '</button></li>').join('');
}
function goBack() {
  const p = S.prev; S.prev = null;
  setUrl(p.url || {});
  if (p.q != null) $('q').value = p.q;
  run(p.base, { label: p.label });
}
document.addEventListener('click', e => {
  const l = e.target.closest('[data-pick-lead]');
  if (l) { const x = (S.rows || [])[Number(l.dataset.pickLead)]; if (x) openLead(x); return; }
  const p = e.target.closest('[data-pick-prop]');
  if (p) { setFor('clients'); setUrl({ property: p.dataset.pickProp }); run({ action: 'search', mode: 'clients', propertyId: p.dataset.pickProp }, { label: '' }); return; }
  // "Find buyers for it instead" — the same words the other way: the toggle flips and it re-runs.
  const redo = e.target.closest('[data-redo]');
  if (redo && S.base && S.base.text) {
    const m = redo.dataset.redo;
    setFor(m, { remember: true });
    run({ action: 'search', mode: m, text: S.base.text }, { label: S.label });
    return;
  }
  const back = e.target.closest('[data-back]');
  if (back && S.prev) { goBack(); return; }
  if (e.target.closest('[data-seewhy]')) { $('fOut').checked = true; refilter(); }
});

// ── Pieces of a card ──
function scorePill(row) {
  const band = (row.band && row.band.key) || (row.vetoed ? 'ruled-out' : 'weak');
  const label = row.vetoed ? 'Ruled out' : (row.band && row.band.label) || '';
  return `<p class="mt-score" data-band="${esc(band)}"><b>${row.vetoed ? '—' : esc(row.pct) + '<small>%</small>'}</b>`
    + `<span><i class="fa-solid ${BAND_ICON[band] || 'fa-circle'}" aria-hidden="true"></i> ${esc(label)}</span></p>`;
}
// ONE trust badge: onboarded and verified, or how far a not-yet-onboarded one has got.
function trustBadge(p) {
  if (p.source === 'onboarded') {
    return p.verified !== false
      ? '<span class="mt-badge ok"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Onboarded · Verified</span>'
      : '<span class="mt-badge un"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Onboarded · unchecked</span>';
  }
  const w = SRC_NAME[p.source] || p.sourceLabel || 'Opportunity';
  return `<span class="mt-badge un"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Not onboarded · ${esc(w)} · unchecked</span>`;
}
// Area · price · size · BHK, with ONE "AI-read" marker when any of it came from the chat.
function factsLine(p) {
  const facts = p.facts || [];
  const miss = l => facts.some(f => f.label === l && f.src === 'missing');
  const li = [];
  if (p.location) li.push(`<li>${esc(p.location)}</li>`);
  if (p.price) li.push(`<li>${esc(p.price)}</li>`);
  else if (miss('Price')) li.push('<li class="mt-f-miss">price not known</li>');
  if (p.area) li.push(`<li>${esc(p.area)}</li>`);
  if (p.bhk && p.bhk.length) li.push(`<li>${esc(p.bhk.join(' / '))} BHK</li>`);
  if (p.dealLabel && p.dealLabel !== 'For sale') li.push(`<li>${esc(p.dealLabel)}</li>`);
  const ai = facts.filter(f => f.src === 'chat').map(f => lc(f.label));
  if (ai.length) li.push(`<li class="mt-aimark"><i class="fa-solid fa-comment-dots" aria-hidden="true"></i> AI-read<span class="sr">: ${esc(ai.join(', '))} read from the chat</span></li>`);
  return li.length ? `<ul class="mt-facts">${li.join('')}</ul>` : '';
}
// The fit, in three lines at most: the budget, the location, then one line of ✓ / ~ / ✗ / ?.
function skipKeys(row) {
  const skip = new Set();
  const b = row.budget || row.budgetDiff;
  if (b && b.text) skip.add('budget');
  if (row.location2 && row.location2.text && row.location2.level !== 'unknown') skip.add('locality');
  return skip;
}
function fitBlock(row, { client = false } = {}) {
  const out = [];
  const b = row.budget || row.budgetDiff;
  const loc = row.location2;
  if (b && b.text) out.push(`<p class="mt-fit ${b.within ? 'ok' : b.soft ? 'soft' : 'over'}"><i class="fa-solid fa-indian-rupee-sign" aria-hidden="true"></i> ${esc(b.text)}</p>`);
  if (loc && loc.text && loc.level !== 'unknown') out.push(`<p class="mt-fit loc-${esc(loc.level)}"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${esc(cutParens(loc.text))}</p>`);
  const skip = skipKeys(row);
  const keep = x => !skip.has(x.key);
  const t = [];
  if (row.vetoed) (row.vetoes || []).forEach(x => t.push(`<li class="n"><i class="fa-solid fa-ban" aria-hidden="true"></i><span class="sr">Ruled out: </span>${esc(cutParens(x.why))}</li>`));
  (row.for || []).filter(keep).slice(0, 3).forEach(x => t.push(`<li class="y"><i class="fa-solid fa-check" aria-hidden="true"></i><span class="sr">Fits: </span>${esc(shortWhy(x.why))}</li>`));
  (row.against || []).filter(keep).slice(0, 2).forEach(x => t.push(x.partial
    ? `<li class="p"><b aria-hidden="true">~</b><span class="sr">Partly: </span>${esc(shortWhy(x.why))}</li>`
    : `<li class="n"><i class="fa-solid fa-xmark" aria-hidden="true"></i><span class="sr">Against: </span>${esc(shortWhy(x.why))}</li>`));
  // A client card has its own "Missing" row: the same gaps are not said twice.
  if (!client) (row.unknown || []).filter(keep).slice(0, 2).forEach(x => t.push(`<li class="u"><b aria-hidden="true">?</b><span class="sr">Not known: </span>${esc(cap(lc(x.label || 'a detail')))} not known</li>`));
  if (t.length) out.push(`<ul class="mt-ticks">${t.join('')}</ul>`);
  return out.length ? `<div class="mt-fitbox">${out.join('')}</div>` : '';
}
const NEXT_WORDS = { 'Request this client’s details to work them': 'Request details to take this client' };
const nextLine = row => (row.next && !row.vetoed ? `<p class="mt-next"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i> <span><span class="sr">Next: </span>${esc(NEXT_WORDS[row.next] || shortWhy(row.next))}</span></p>` : '');
function breakdown(row) {
  const items = row.breakdown || [];
  if (!items.length) return '';
  return `<ul class="mt-bd">${items.map(b => {
    const pct = b.of ? Math.max(0, Math.min(100, Math.round(b.points / b.of * 100))) : 0;
    const state = b.veto ? 'veto' : b.unknown ? 'unknown' : pct >= 60 ? 'good' : 'low';
    return `<li data-s="${state}">
      <div class="mt-bd-h"><b>${esc(b.label)}</b>${b.veto ? '<span class="tag red">Rules it out</span>' : b.unknown ? '<span class="tag">Not known — scored at a guess</span>' : ''}<span class="mt-bd-p">${esc(b.points)} of ${esc(b.of)}</span></div>
      <div class="mt-bar" aria-hidden="true"><i style="inline-size:${pct}%"></i></div>
      ${b.why ? `<p>${esc(b.why)}</p>` : ''}
    </li>`;
  }).join('')}</ul>`;
}
const confLine = row => (row.confidence ? `<p class="mt-conf" data-c="${esc(lc(row.confidence))}">${esc(row.confidence)} confidence in this score</p>` : '');
// What an agent asked for: a neutral pill instead of the button.
const waitPill = () => '<span class="mt-wait" role="status"><i class="fa-regular fa-clock" aria-hidden="true"></i> Requested · waiting</span>';

// ── A property ──
const LINK = {
  property: id => 'dashboard.html?property=' + encodeURIComponent(id),
  listing: id => 'propertytrack.html?listing=' + encodeURIComponent(id),
  lead: id => 'crm.html?lead=' + encodeURIComponent(id),
  submission: () => 'myday.html',
};
const LINK_LABEL = { property: 'Open property', listing: 'Open Shoot card', lead: 'Open seller lead', submission: 'Open in My Day' };
const statusText = p => [p.sourceLabel, p.status].filter(Boolean).join(' · ');
const alsoLine = row => ((row.alsoIn || []).length
  ? `<p class="mt-also">${row.alsoIn.map(a => (/shoot/i.test(a.label || '') ? 'Also on the Shoot board' : 'Also: ' + esc(a.label))).filter((v, k, all) => all.indexOf(v) === k).join(' · ')}</p>` : '');
function propertyCard(row, i) {
  const restricted = row.access === 'restricted' || (row.link && row.link.type === 'restricted');
  const summary = row.access === 'summary';
  const href = !restricted && row.link && LINK[row.link.type] ? LINK[row.link.type](row.link.id) : '';
  const acts = [];
  if (href) acts.push(`<a class="btn sm" href="${esc(href)}"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> ${esc(LINK_LABEL[row.link.type] || 'Open')}</a>`);
  if (!row.vetoed) {
    // Never to an admin: only an agent's summary-only rows can be requested.
    if (summary && isAgent && row.link && row.link.id) acts.push(S.requested.has('p:' + row.link.id) || row.requested ? waitPill() : `<button type="button" class="btn sm primary" data-act="req-prop" data-i="${i}"><i class="fa-solid fa-hand" aria-hidden="true"></i> Request details</button>`);
    if (restricted) acts.push('<span class="mt-held"><i class="fa-solid fa-lock" aria-hidden="true"></i> Ask the office about this one</span>');
    if (!restricted && row.link) acts.push(`<button type="button" class="btn sm quiet" data-act="buyers" data-i="${i}"><i class="fa-solid fa-users" aria-hidden="true"></i> Matching clients</button>`);
    acts.push(`<button type="button" class="btn sm quiet" data-act="share" data-i="${i}"><i class="fa-solid fa-share-nodes" aria-hidden="true"></i> Share</button>`);
  }
  const facts = (row.facts || []).length ? `<dl class="mt-factlist">${row.facts.map(f => {
    const t = TRUST[f.src] || TRUST.seller;
    return `<div><dt>${esc(f.label)}</dt><dd>${f.value != null ? esc(f.value) : '—'} <small class="mt-fsrc ${t.cls}"><i class="fa-solid ${t.icon}" aria-hidden="true"></i> ${esc(t.short)}</small></dd></div>`;
  }).join('')}</dl>` : '';
  const status = statusText(row);
  const upd = fmtDay(row.updatedAt);
  return `<li class="mt-row${row.vetoed ? ' out' : ''}" data-src="${esc(row.source)}">
    <article class="mt-card" aria-labelledby="r${i}"><div class="mt-in">
      ${scorePill(row)}
      <div class="mt-main">
        <h3 id="r${i}">${esc(row.name || 'Untitled property')}${row.code ? ` <span class="mt-pcode">${esc(row.code)}</span>` : ''}</h3>
        <p class="mt-trust">${trustBadge(row)}</p>
        ${factsLine(row)}
        ${fitBlock(row)}
        ${nextLine(row)}
        ${alsoLine(row)}
        <details class="mt-more">
          <summary><i class="fa-solid fa-chevron-down" aria-hidden="true"></i> Why this score</summary>
          ${confLine(row)}
          ${status ? `<p class="mt-stage">Stage: ${esc(status)}</p>` : ''}
          ${breakdown(row)}
          ${facts}
        </details>
        ${upd ? `<p class="mt-upd">Updated ${esc(upd)}</p>` : ''}
        <p class="mt-reqres" role="status"></p>
      </div>
      ${acts.length ? `<footer class="mt-acts">${acts.join('')}</footer>` : ''}
    </div></article>
  </li>`;
}

// ── A client ──
const hideSource = s => /tailortalk/i.test(String(s || ''));
function heldBy(row) {
  const o = String(row.ownerName || '');
  if (o === 'Office') return 'Held by the office';
  if (o === 'Unassigned') return 'Not assigned yet — ask the office';
  if (o && !/\//.test(o) && !/another agent/i.test(o)) return 'Held by ' + o;
  return 'Held by another agent / the office';
}
function clientCard(row, i) {
  const restricted = row.access === 'restricted';
  const wants = [row.config, (row.types || []).join(' / '), row.sub, row.dealLabel].filter(Boolean).join(' · ');
  const kv = [];
  if (wants) kv.push(['Wants', esc(wants)]);
  if (row.budget) kv.push(['Budget', esc(row.budget)]);
  if ((row.locations || []).length) kv.push(['Areas', esc(row.locations.join(', '))]);
  if ((row.exclude || []).length) kv.push(['Not in', esc(row.exclude.join(', '))]);
  if (row.area) kv.push(['Size', esc(row.area)]);
  const missing = (row.unknown || []).map(u => u.label).filter(Boolean);
  if (missing.length) kv.push(['Missing', esc([...new Set(missing)].slice(0, 4).join(', '))]);
  const meta = [];
  if (row.stage) meta.push(`<span class="tag">${esc(row.stage)}</span>`);
  if (row.leadSource && !hideSource(row.leadSource)) meta.push(`<span class="tag">${esc(row.leadSource)}</span>`);
  if (row.interest) meta.push(`<span class="tag ${row.interest === 'hot' || row.interest === 'high' ? 'brand' : ''}">Interest: ${esc(lc(row.interest))}</span>`);
  const times = [];
  if (row.lastTouch) times.push(`Last in touch ${esc(ago(row.lastTouch))}`);
  if (row.reqUpdated) times.push(`requirement updated ${esc(fmtDay(row.reqUpdated))}`);
  const owner = row.ownerName || '';
  const who = restricted
    ? `<p class="mt-who"><i class="fa-solid fa-lock" aria-hidden="true"></i> ${esc(heldBy(row))}</p>`
    : `<p class="mt-who">${row.phone ? `<span>${esc(fmtPhone(row.phone))}${phoneOk(row.phone) ? '' : ' <small class="mt-checkno">check number</small>'}</span>` : ''}<span><i class="fa-regular fa-user" aria-hidden="true"></i> ${esc(owner || 'Unassigned')}</span></p>`;
  const reqN = row.reqCount > 1 ? `<p class="mt-reqn">Matches their requirement #${esc((row.reqIndex || 0) + 1)} of ${esc(row.reqCount)}</p>` : '';
  const acts = [];
  const shareB = `<button type="button" class="btn sm quiet" data-act="share" data-i="${i}"><i class="fa-solid fa-share-nodes" aria-hidden="true"></i> Share</button>`;
  if (row.vetoed) {
    if (!restricted && row.leadId) acts.push(`<a class="btn sm" href="crm.html?lead=${encodeURIComponent(row.leadId)}"><i class="fa-regular fa-id-card" aria-hidden="true"></i> Open</a>`);
  } else if (restricted) {
    if (isAgent) acts.push(S.requested.has('l:' + row.ref) || row.requested ? waitPill() : `<button type="button" class="btn sm primary" data-act="request" data-i="${i}"><i class="fa-solid fa-hand" aria-hidden="true"></i> Request details</button>`);
  } else if (row.leadId) {
    const id = encodeURIComponent(row.leadId);
    const view = `<a class="btn sm quiet" href="crm.html?lead=${id}"><i class="fa-regular fa-id-card" aria-hidden="true"></i> View client</a>`;
    if (row.phone) {
      acts.push(`<a class="btn sm wa primary" href="https://wa.me/${esc(phoneDigits(row.phone))}" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp" aria-hidden="true"></i> WhatsApp</a>`);
      acts.push(`<a class="btn sm" href="tel:${esc(String(row.phone).replace(/[^\d+]/g, ''))}"><i class="fa-solid fa-phone" aria-hidden="true"></i> Call</a>`);
    }
    acts.push(`<a class="btn sm quiet" href="crm.html?lead=${id}&amp;followup=1"><i class="fa-regular fa-calendar-plus" aria-hidden="true"></i> Follow-up</a>`);
    // Wide: View client and Share in the column. Narrow: behind ⋯ (a popover right after its button).
    acts.push(`<span class="mt-wideonly">${view}${shareB}</span>`);
    acts.push(`<button type="button" class="btn sm quiet mt-moreb" popovertarget="pm${i}" aria-label="More for ${esc(row.name || 'this client')}"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></button>`
      + `<div class="mt-pop" id="pm${i}" popover>${view}${shareB}</div>`);
  }
  if (!acts.length || restricted) acts.push(shareB);
  return `<li class="mt-row${row.vetoed ? ' out' : ''}${restricted ? ' held' : ''}">
    <article class="mt-card" aria-labelledby="r${i}"><div class="mt-in">
      ${scorePill(row)}
      <div class="mt-main">
        <h3 id="r${i}">${esc(row.name || 'A matching client')}</h3>
        ${who}
        ${reqN}
        ${meta.length ? `<p class="mt-tags">${meta.join('')}</p>` : ''}
        ${kv.length ? `<dl class="mt-kv">${kv.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` : ''}
        ${fitBlock(row, { client: true })}
        ${restricted ? '' : nextLine(row)}
        <details class="mt-more">
          <summary><i class="fa-solid fa-chevron-down" aria-hidden="true"></i> Why this score</summary>
          ${confLine(row)}
          ${row.reqText ? `<p class="mt-reqtext">“${esc(row.reqText)}”</p>` : ''}
          ${breakdown(row)}
        </details>
        ${times.length ? `<p class="mt-upd">${times.join(' · ')}</p>` : ''}
        <p class="mt-reqres" role="status"></p>
      </div>
      <footer class="mt-acts">${acts.join('')}</footer>
    </div></article>
  </li>`;
}

// ── Stock that already has buyers ──
// The server counts at most 50 buyers per card (65%+): 50 means "50 or more".
const buyersN = row => (row.buyers >= 50 ? '50+' : String(row.buyers));
// "selvi040617" is a WhatsApp username, not a name: shown as it is, with the end of the number.
const looksLikeUser = n => !!n && !/\s/.test(n) && /\d/.test(n);
function demandCard(row, i) {
  const p = row.property || {};
  const href = p.link && LINK[p.link.type] ? LINK[p.link.type](p.link.id) : '';
  const top = (row.top || []).map(t => {
    const nm = esc(t.name || 'A matching client') + (looksLikeUser(t.name) && t.phoneEnd ? ` <span class="mt-pend">${esc(t.phoneEnd)}</span>` : '');
    return `<li>${t.leadId && !isAgent ? `<a href="crm.html?lead=${encodeURIComponent(t.leadId)}">${nm}</a>` : nm} <b>${esc(t.pct)}%</b></li>`;
  }).join('');
  const fits = [row.strong ? `<b class="strong">${esc(row.strong)} strong</b>` : '', `${esc(buyersN(row))} good ${row.buyers === 1 ? 'fit' : 'fits'}`].filter(Boolean).join(' · ');
  // An agent sees no names for buyers held by others: say how many are theirs instead.
  const allHidden = (row.top || []).length && row.top.every(t => !t.leadId && (!t.name || t.name === 'A matching client'));
  const whoLine = allHidden && row.held != null ? `<p class="mt-demand-who">${esc(row.yours || 0)} yours · ${esc(row.held)} held by others</p>` : '';
  return `<li class="mt-row demand" data-src="${esc(p.source)}">
    <article class="mt-card" aria-labelledby="r${i}"><div class="mt-in">
      <p class="mt-score" data-band="${row.strong ? 'strong' : 'good'}"><b>${esc(buyersN(row))}</b><span>${row.buyers === 1 ? 'buyer' : 'buyers'}</span></p>
      <div class="mt-main">
        <h3 id="r${i}">${esc(p.name || 'A property')}${p.code ? ` <span class="mt-pcode">${esc(p.code)}</span>` : ''}</h3>
        <p class="mt-trust">${trustBadge(p)}</p>
        ${factsLine(p)}
        <p class="mt-demand">${fits}</p>
        ${whoLine || (top ? `<ol class="mt-top" aria-label="Best buyers">${top}</ol>` : '')}
        ${nextLine(p)}
      </div>
      <footer class="mt-acts">
        <button type="button" class="btn sm primary" data-act="demand-buyers" data-i="${i}"><i class="fa-solid fa-users" aria-hidden="true"></i> See buyers</button>
        ${href ? `<a class="btn sm" href="${esc(href)}"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> ${esc(LINK_LABEL[p.link.type] || 'Open')}</a>` : ''}
      </footer>
    </div></article>
  </li>`;
}

// A property row → a clients search for it (by its record when the API can open it, else by its facts).
function clientsBodyFor(p) {
  const link = p.link || {};
  if (link.type === 'property' && link.id) return { mode: 'clients', propertyId: link.id };
  if (link.type === 'listing' && link.id) return { mode: 'clients', listingId: link.id };
  if (link.type === 'lead' && link.id) return { mode: 'clients', sellerLeadId: link.id };
  if (link.type === 'submission' && link.id) return { mode: 'clients', submissionId: link.id };
  const t = { House: 'Independent House' }[p.type] || p.type || '';
  return { mode: 'clients', details: { name: p.name, type: t, bhk: p.bhk && p.bhk[0] ? p.bhk[0] : '', location: p.location || '', price: p.priceLo || '', deal: p.jv ? 'jv' : p.deal || '' } };
}

// ── Row actions ──
function shareText(row) {
  if (S.mode === 'clients') {
    return [`${row.name || 'Client'} — ${row.pct}% ${row.band ? row.band.label : ''}`.trim(),
      [row.config, (row.types || []).join('/'), row.budget, (row.locations || []).join(', ')].filter(Boolean).join(' · '),
      S.about ? `For: ${S.about.name}` : '', row.next ? `Next: ${NEXT_WORDS[row.next] || shortWhy(row.next)}` : ''].filter(Boolean).join('\n');
  }
  const p = S.mode === 'demand' ? row.property : row;
  return [`${p.name || 'Property'}${p.code ? ' (' + p.code + ')' : ''}`, [p.location, p.price, p.area, p.dealLabel].filter(Boolean).join(' · '),
    p.source === 'onboarded' ? 'Onboarded · verified' : `Not onboarded yet (${SRC_NAME[p.source] || p.sourceLabel || 'opportunity'}) — details not checked`,
    // The band already says "match" ("Strong match"): the word once, not "Strong match match".
    S.mode === 'properties' && row.pct != null ? (row.band && row.band.label ? `${row.pct}% — ${row.band.label}` : `${row.pct}% match`) : ''].filter(Boolean).join('\n');
}
// A phone shares through its own sheet (WhatsApp is one tap away); elsewhere the text is copied.
async function share(text) {
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text); toast('Copied — paste into WhatsApp'); }
  catch (e) { toast('Could not copy on this device — open it and copy from there'); }
}
$('list').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const row = S.rows[Number(b.dataset.i)];
  if (!row) return;
  const act = b.dataset.act;
  const pop = b.closest('[popover]');
  if (pop) pop.hidePopover();
  if (act === 'share') share(shareText(row));
  else if (act === 'buyers') runClients(clientsBodyFor(row), row.name);
  else if (act === 'demand-buyers') runClients(clientsBodyFor(row.property || {}), (row.property || {}).name);
  else if (act === 'request') busy(b, () => requestLead(row, b));
  else if (act === 'req-prop') busy(b, () => requestProperty(row, b));
});
function runClients(body, name) {
  // Remember the list this came from, for "← Back to …".
  if (S.base && S.mode !== 'clients') S.prev = { base: S.base, label: S.label, q: $('q').value, title: $('resTitle').textContent, url: Object.fromEntries(new URL(location.href).searchParams) };
  // The box says what is being matched now: the property's name.
  $('q').value = name || '';
  setFor('clients');
  const id = body.propertyId ? { property: body.propertyId } : body.listingId ? { listing: body.listingId } : body.sellerLeadId ? { seller: body.sellerLeadId } : {};
  setUrl(id);
  run({ action: 'search', ...body }, { label: name || '' }).then(() => reveal({ mode: 'clients' }, { force: true }));
}
// After a request (or when the API says it was already asked): the button becomes a waiting pill.
function markRequested(key, btn) {
  S.requested.add(key);
  btn.insertAdjacentHTML('afterend', waitPill());
  btn.remove();
}
async function requestLead(row, btn) {
  const out = btn.closest('article').querySelector('.mt-reqres');
  const about = S.mode === 'clients' && S.about ? `my property “${S.about.name}”` : S.label ? `my client (${S.label})` : 'my client';
  try {
    await api('request', { kind: 'lead', ref: row.ref, reason: `Matches ${about} — ${row.pct}% ${row.band ? row.band.label.toLowerCase() : 'match'}` });
    out.textContent = 'Asked — the office will decide. You’ll see it in My Day.';
    out.className = 'mt-reqres ok';
    markRequested('l:' + row.ref, btn);
  } catch (err) {
    if (err.status === 409) { markRequested('l:' + row.ref, btn); return; }
    out.textContent = err.message;
    out.className = 'mt-reqres bad';
  }
}
async function requestProperty(row, btn) {
  const out = btn.closest('article').querySelector('.mt-reqres');
  const forWho = S.base && S.base.leadId && S.reading && S.reading.leadName ? `my client ${S.reading.leadName.split(' ')[0]}` : S.label ? `my client (${S.label})` : 'my client';
  try {
    await api('request', { kind: 'property', targetId: row.link.id, reason: `Matches ${forWho} — ${row.pct}% ${row.band ? row.band.label.toLowerCase() : 'match'}` });
    out.textContent = 'Asked — the office will decide. You’ll see it in My Day.';
    out.className = 'mt-reqres ok';
    markRequested('p:' + row.link.id, btn);
  } catch (err) {
    if (err.status === 409) { markRequested('p:' + row.link.id, btn); return; }
    out.textContent = err.message;
    out.className = 'mt-reqres bad';
  }
}

// ── A client's own requirement (?lead=): ONE line, Edit, History ──
const STATUS_WORD = { active: 'Active', previous: 'Previous', closed: 'Closed' };
const SRC_WORDS = { reviewed: 'Reviewed', ai: 'Read by AI from the chat', lead: 'From the CRM fields' };
const TYPE_WORD = { apartment: 'Apartment', villa: 'Villa', independent_house: 'House', plot: 'Plot', commercial: 'Commercial' };
const SUB_WORD = { res_plot: 'residential plot', commercial_land: 'commercial land', industrial_land: 'industrial land', agri_land: 'agricultural land', office: 'office', retail: 'retail', warehouse: 'warehouse', industrial: 'industrial shed', hospitality: 'hotel / restaurant', coworking: 'co-working', building: 'commercial building' };
const DEAL_ONE = { buy: 'Buy', rent: 'Rent', lease: 'Lease', jv: 'Joint venture', either: 'Rent or buy' };
function bhkRange(v) {
  const a = [...new Set(v.map(Number))].sort((x, y) => x - y);
  if (a.length > 1 && a.every((n, k) => k === 0 || n === a[k - 1] + 1)) return `${a[0]}–${a[a.length - 1]}`;
  return a.join('/');
}
// "Buy · 2–3 BHK · Anna Nagar, Kilpauk · ≤₹3.5 Cr · not Mogappair"
function itemOneLine(it) {
  if (!it) return '';
  const p = [];
  if (it.deal) p.push(DEAL_ONE[it.deal] || it.deal);
  if (it.bhk && it.bhk.length) p.push(bhkRange(it.bhk) + ' BHK');
  const kind = it.sub && SUB_WORD[it.sub] ? cap(SUB_WORD[it.sub])
    : (it.types || []).length && !(it.types.length === 1 && it.types[0] === 'apartment' && it.bhk) ? it.types.map(t => TYPE_WORD[t] || t).join(' / ') : '';
  if (kind) p.push(kind);
  if ((it.locations || []).length) p.push(it.locations.map(l => l.name).join(', '));
  else if (it.anywhere) p.push('Anywhere in Chennai');
  const b = it.budget;
  if (b && (b.min || b.max)) {
    const per = b.unit === 'per_month' ? '/mo' : b.unit === 'per_sqft' ? '/sq ft' : b.unit === 'lease_amount' ? ' lease' : '';
    p.push((b.min && b.max && b.min < b.max ? `₹${fmtMoney(b.min)}–${fmtMoney(b.max)}` : b.max ? `≤₹${fmtMoney(b.max)}` : `≥₹${fmtMoney(b.min)}`) + per);
  }
  const a = it.area;
  if (a && (a.min || a.max)) p.push((a.min && a.max ? `${a.min}–${a.max}` : a.max ? `≤${a.max}` : `${a.min}+`) + ' ' + ({ sqft: 'sq ft', sqm: 'sq m' }[a.unit] || a.unit || 'sq ft'));
  if ((it.exclude || []).length) p.push('not ' + it.exclude.join(', '));
  return p.join(' · ');
}
function itemLabel(it) {
  return [it.bhk ? it.bhk.join('/') + ' BHK' : '', it.sub && SUB_WORD[it.sub] ? SUB_WORD[it.sub] : (it.types || []).map(t => TYPE_WORD[t] || t).join('/'), { rent: 'to rent', lease: 'on lease', jv: 'for JV' }[it.deal] || '',
    it.locations ? 'in ' + it.locations.map(l => l.name).join(', ') : it.anywhere ? 'anywhere' : '',
    it.budget && it.budget.max ? 'up to ' + fmtMoney(it.budget.max) : ''].filter(Boolean).join(' ') || 'your requirement';
}
const reviewerName = reading => reading.reviewedByName || nameFromEmail(reading.reviewedBy);
function drawLeadReading(reading) {
  $('leadBox').hidden = false;
  S.leadReading = reading;
  $('leadTitle').textContent = (reading.leadName ? reading.leadName + '’s' : 'This client’s') + ' requirement';
  const reqs = reading.requirements || [];
  const cur = S.base && S.base.reqIndex != null ? Number(S.base.reqIndex) : (reqs[0] ? reqs[0].index : 0);
  $('leadReqs').innerHTML = reqs.length > 1 ? reqs.map((q, k) => `<button type="button" class="chip" aria-pressed="${q.index === cur}" data-req="${esc(q.index)}" title="${esc(q.text || '')}">#${k + 1}${q.item && itemLabel(q.item) !== 'your requirement' ? ' ' + esc(itemLabel(q.item)) : q.text ? ' ' + esc(q.text.slice(0, 50)) : ''}</button>`).join('') : '';
  const sel = reqs.find(q => q.index === cur) || reqs[0];
  const by = reading.reviewedAt ? `Reviewed ${ago(reading.reviewedAt)}${reading.reviewedBy ? ' by ' + reviewerName(reading) : ''}` : (sel ? SRC_WORDS[sel.src] || '' : '');
  $('leadReviewed').textContent = by;
  $('leadStale').hidden = !(sel && sel.stale);
  // The line and "not stated" come from the same reading (the selected requirement).
  const line = sel ? (itemOneLine(sel.item) || (sel.chips || []).map(chipValue).join(' · ') || sel.text || '') : '';
  const missing = sel && sel.missing && sel.missing.length ? sel.missing : [];
  $('leadLine').innerHTML = (line ? `<b>${esc(line)}</b>` : '<b>Nothing to match on yet</b> — Edit to add a place, a type or a budget')
    + (missing.length ? ` <span class="mt-reqmiss">· not stated: ${esc(missing.join(', '))}</span>` : '');
}

// The editor: S.edit is the list of ITEMs, S.edCur the one in the form. The form is the same one
// More options uses — moved here while editing, and back afterwards.
const blankItem = () => ({ status: 'active' });
function stashCurrent() {
  if (!S.edit || S.edCur == null || !S.edit[S.edCur]) return;
  const keep = S.edit[S.edCur];
  S.edit[S.edCur] = { ...readItem(), status: $('edStatus').value, ...(keep.id ? { id: keep.id } : {}) };
}
function drawEdTabs() {
  $('edTabs').innerHTML = S.edit.map((it, k) => `<button type="button" class="chip" aria-pressed="${k === S.edCur}" data-ed="${k}">#${k + 1} ${esc(itemLabel(it) === 'your requirement' ? 'New requirement' : itemLabel(it))}${(it.status || 'active') !== 'active' ? ' · ' + esc(STATUS_WORD[it.status] || it.status) : ''}</button>`).join('');
  $('edRemove').hidden = S.edit.length < 2;
}
function showEd(k) {
  S.edCur = k;
  const it = S.edit[k] || blankItem();
  fillItem(it);
  $('edStatus').value = it.status === 'previous' || it.status === 'closed' ? 'previous' : 'active';
  drawEdTabs();
}
function closeEditor() {
  if ($('reqEditor').hidden) return;
  $('reqEditor').hidden = true;
  $('reqEdit').setAttribute('aria-expanded', 'false');
  itemForm.classList.remove('in-editor');
  $('refineProps').append(itemForm);
  $('refine').hidden = false;
  S.edit = null; S.edCur = null; S.edModel = null;
}
async function openEditor() {
  const reading = S.leadReading || {};
  // Every saved requirement, previous ones too (allItems), so none is lost on the next save; with
  // nothing saved yet, the live reading of the lead.
  const items = (Array.isArray(reading.allItems) && reading.allItems.length ? reading.allItems : (reading.requirements || []).map(q => q.item).filter(Boolean))
    .map(it => ({ status: 'active', ...it }));
  S.edit = items.length ? items : [blankItem()];
  S.edModel = null;
  $('edFormSlot').append(itemForm);
  itemForm.classList.add('in-editor');
  $('refine').hidden = true;   // its form is in the editor now
  $('reqEditor').hidden = false;
  $('reqEdit').setAttribute('aria-expanded', 'true');
  $('reqErr').textContent = ''; $('reqAiNote').textContent = ''; $('reqQs').hidden = true;
  showEd(0);
  $('edTabs').querySelector('[data-ed]')?.focus();
}
$('reqEdit').addEventListener('click', e => ($('reqEditor').hidden ? busy(e.currentTarget, openEditor) : closeEditor()));
$('reqCancel').addEventListener('click', () => { closeEditor(); $('reqEdit').focus(); });
$('edTabs').addEventListener('click', e => {
  const b = e.target.closest('[data-ed]');
  if (!b) return;
  stashCurrent();
  showEd(Number(b.dataset.ed));
});
$('edAdd').addEventListener('click', () => {
  stashCurrent();
  if (S.edit.length >= 5) { $('reqErr').textContent = 'Five requirements at most.'; return; }
  S.edit.push(blankItem());
  showEd(S.edit.length - 1);
  $('iDeal').focus();
});
$('edRemove').addEventListener('click', () => {
  if (S.edit.length < 2) return;
  S.edit.splice(S.edCur, 1);
  showEd(Math.max(0, S.edCur - 1));
});
$('edStatus').addEventListener('change', () => { stashCurrent(); drawEdTabs(); });
$('itemForm').addEventListener('change', () => { if (S.edit) { stashCurrent(); drawEdTabs(); } });
$('reqAi').addEventListener('click', e => busy(e.currentTarget, async () => {
  $('reqErr').textContent = ''; $('reqAiNote').textContent = ''; $('reqQs').hidden = true;
  try {
    const r = await mt('structure', { leadId: S.base.leadId });
    const items = (r.items || []).map(it => ({ status: 'active', ...it }));
    if (!items.length) { $('reqAiNote').textContent = 'Nothing to read in this client’s chat and notes yet.'; return; }
    S.edit = items;
    S.edModel = r.src === 'ai' ? r.model || null : null;
    showEd(0);
    const qs = r.questions || [];
    if (qs.length) { $('reqQs').innerHTML = qs.map(q => `<li><i class="fa-regular fa-circle-question" aria-hidden="true"></i> ${esc(q)}</li>`).join(''); $('reqQs').hidden = false; }
    $('reqAiNote').textContent = r.src === 'ai'
      ? `Filled in by AI from the CRM fields, the chat and the notes — ${items.length === 1 ? 'check it' : 'check all ' + items.length}, then save.`
      : 'The AI wasn’t available — this is the built-in reading. Check it, then save.';
  } catch (err) { $('reqErr').textContent = err.message; }
}));
$('reqSave').addEventListener('click', e => busy(e.currentTarget, async () => {
  stashCurrent();
  $('reqErr').textContent = '';
  const items = S.edit.filter(it => it.deal || it.types || it.bhk || it.locations || it.budget || it.area || it.anywhere);
  if (!items.some(it => (it.status || 'active') === 'active')) { $('reqErr').textContent = 'Keep at least one active requirement with a place, a type, a budget or bedrooms.'; return; }
  // What it was before this save (the CRM's own reading the first time), for History's "Before".
  const rd = S.leadReading || {};
  S.before = { leadId: S.base.leadId, items: (rd.allItems && rd.allItems.length ? rd.allItems : (rd.requirements || []).map(q => q.item).filter(Boolean)), src: rd.reviewedAt ? 'saved' : 'crm' };
  try {
    await mt('save-req', { leadId: S.base.leadId, items, ...(S.edModel ? { aiModel: S.edModel } : {}) });
    closeEditor();
    toast('Saved. Old version kept in History.');
    $('histBox').hidden = true; $('reqHist').setAttribute('aria-expanded', 'false');
    const { reqIndex, ...base } = S.base;
    setUrl({ lead: base.leadId });
    run(base, { keepLabel: true });
  } catch (err) { $('reqErr').textContent = err.message; }
}));
// History: the version in use is "Now", every earlier one "Before".
function histItems(items) {
  return `<ul>${(items || []).map(it => `<li>${esc(itemOneLine(it) || itemLabel(it))}${(it.status || 'active') !== 'active' ? ` <span class="tag">${esc(STATUS_WORD[it.status] || it.status)}</span>` : ''}</li>`).join('') || '<li>Cleared</li>'}</ul>`;
}
function whoSaved(by) {
  const rd = S.leadReading || {};
  if (!by) return '';
  return by === rd.reviewedBy && rd.reviewedByName ? rd.reviewedByName : nameFromEmail(by);
}
$('reqHist').addEventListener('click', e => {
  if (!$('histBox').hidden) { $('histBox').hidden = true; e.currentTarget.setAttribute('aria-expanded', 'false'); return; }
  busy(e.currentTarget, async () => {
    $('histBox').hidden = false;
    $('reqHist').setAttribute('aria-expanded', 'true');
    try {
      const h = await mt('req-history', { leadId: S.base.leadId });
      const revs = h.revisions || [];
      const rowsH = revs.map((r, k) => `<li><p class="mt-hwhen"><b>${k === 0 ? 'Now' : 'Before'}</b> <span>saved ${esc(fmtDay(r.at) || ago(r.at))}${r.by ? ' by ' + esc(r.byName || whoSaved(r.by)) : ''}</span></p>${histItems(r.items)}</li>`);
      // The CRM's own reading, from before anyone reviewed it (the API keeps it as `was`; failing
      // that, what this page showed before the save just made).
      const first = revs[revs.length - 1];
      const was = first && first.was && first.was.length ? first.was
        : revs.length === 1 && S.before && S.before.leadId === S.base.leadId && S.before.src === 'crm' && S.before.items.length ? S.before.items : null;
      if (was) rowsH.push(`<li><p class="mt-hwhen"><b>Before</b> <span>from the CRM fields</span></p>${histItems(was)}</li>`);
      $('histBox').innerHTML = rowsH.length ? `<ol class="mt-histl">${rowsH.join('')}</ol>`
        : '<p class="note">No saved versions yet — what you see comes from the CRM fields and the chat.</p>';
    } catch (err) { $('histBox').innerHTML = `<p class="err">${esc(err.message)}</p>`; }
  });
});
$('leadReqs').addEventListener('click', e => {
  const b = e.target.closest('[data-req]');
  if (!b || !S.base || !S.base.leadId) return;
  setUrl({ lead: S.base.leadId, req: b.dataset.req });
  run({ ...S.base, reqIndex: Number(b.dataset.req) }, { keepLabel: true });
});

// ── More options (Find properties): the form ⇄ an ITEM (match-sources.js cleanItem decides what is kept) ──
const itemForm = $('itemForm');
const setChecks = (name, values) => itemForm.querySelectorAll(`input[name="${name}"]`).forEach(i => { i.checked = (values || []).map(String).includes(i.value); });
const getChecks = name => [...itemForm.querySelectorAll(`input[name="${name}"]:checked`)].map(i => i.value);
function fillItem(it) {
  const x = it || {};
  $('iDeal').value = x.deal || '';
  $('iSub').value = x.sub || '';
  setChecks('types', x.types);
  setChecks('bhk', (x.bhk || []).map(n => Math.min(5, n)));
  const locs = (x.locations || []).slice().sort((a, b) => (a.pref === 'primary' ? 0 : 1) - (b.pref === 'primary' ? 0 : 1));
  $('iLoc').value = locs.map(l => l.name).join(', ');
  $('iEx').value = (x.exclude || []).join(', ');
  $('iAny').checked = !!x.anywhere;
  const b = x.budget || {};
  $('iBMin').value = b.min ? fmtMoney(b.min) : '';
  $('iBMax').value = b.max ? fmtMoney(b.max) : '';
  $('iBUnit').value = b.unit || 'total';
  $('iBFlex').value = b.flex || 'fixed';
  const a = x.area || {};
  $('iAMin').value = a.min || '';
  $('iAMax').value = a.max || '';
  $('iAUnit').value = a.unit || 'sqft';
  $('iAKind').value = a.kind || '';
  setChecks('condition', x.condition);
  const poss = x.possession || '';
  $('iPoss').value = poss === 'immediate' ? 'immediate' : poss ? 'by' : '';
  $('iPossBy').value = poss && poss !== 'immediate' ? poss : '';
  $('iPossByF').hidden = $('iPoss').value !== 'by';
  $('iRad').value = x.radiusKm || '';
  $('iMust').value = (x.mustHave || []).join(', ');
}
function readItem() {
  const it = { status: 'active' };
  if ($('iDeal').value) it.deal = $('iDeal').value;
  const types = getChecks('types'); if (types.length) it.types = types;
  if ($('iSub').value) it.sub = $('iSub').value;
  const bhk = getChecks('bhk').map(Number); if (bhk.length) it.bhk = bhk;
  const locs = list($('iLoc').value); if (locs.length) it.locations = locs.map((name, k) => ({ name, pref: k === 0 ? 'primary' : 'secondary' }));
  const ex = list($('iEx').value); if (ex.length) it.exclude = ex;
  if ($('iAny').checked) it.anywhere = true;
  const unit = $('iBUnit').value;
  const bMin = money($('iBMin').value, unit), bMax = money($('iBMax').value, unit);
  if (bMin || bMax) it.budget = { min: bMin, max: bMax, unit, flex: $('iBFlex').value };
  const aMin = num($('iAMin').value), aMax = num($('iAMax').value);
  if (aMin || aMax) it.area = { min: aMin, max: aMax, unit: $('iAUnit').value, kind: $('iAKind').value || null };
  const cond = getChecks('condition'); if (cond.length) it.condition = cond;
  if ($('iPoss').value === 'immediate') it.possession = 'immediate';
  else if ($('iPoss').value === 'by' && $('iPossBy').value) it.possession = $('iPossBy').value;
  const rad = num($('iRad').value); if (rad) it.radiusKm = rad;
  const must = list($('iMust').value); if (must.length) it.mustHave = must;
  return it;
}
$('iPoss').addEventListener('change', () => { $('iPossByF').hidden = $('iPoss').value !== 'by'; });
itemForm.addEventListener('submit', e => {
  e.preventDefault();
  if (S.edit) return;   // editing a client's requirements: Save is the way out
  const item = readItem();
  const usable = item.deal || item.types || item.bhk || item.locations || item.budget || item.area || item.anywhere;
  if (!usable) { $('aiNote').textContent = 'Add at least a place, a type, a budget or bedrooms.'; return; }
  $('q').value = '';   // the box must not show other words than the ones searched
  setUrl({});
  run({ action: 'search', mode: 'properties', item }, { label: itemLabel(item) });
});
$('itemClear').addEventListener('click', () => { fillItem({}); $('aiNote').textContent = ''; $('readBox').hidden = true; });

// "Read with AI": the optional second reading. It fills the form; it never searches by itself.
// What it read and what it says is not stated both come from the AI's own item — never mixed with
// the engine's reading.
$('aiRead').addEventListener('click', e => busy(e.currentTarget, async () => {
  const text = $('q').value.trim();
  if (!text) { $('aiNote').textContent = 'Type the requirement in the box at the top first.'; $('q').focus(); return; }
  $('aiNote').textContent = '';
  $('aiQs').hidden = true; $('aiPick').hidden = true;
  try {
    const r = await mt('interpret', { text });
    const eng = r.engine || {};
    if (r.ai && (r.ai.items || []).length) {
      S.aiItems = r.ai.items;
      if (r.ai.direction === 'clients') {
        fillDetails(r.ai.items[0]);
        setFor('clients');
        toast('Read as a property — check the details, then Find clients');
        return;
      }
      showAiItem(r.ai.items[0], 'AI read');
      if (r.ai.items.length > 1) {
        $('aiPick').innerHTML = r.ai.items.map((it, k) => `<button type="button" class="chip" aria-pressed="${k === 0}" data-ai="${k}">${esc(it.label || 'Requirement ' + (k + 1))}</button>`).join('');
        $('aiPick').setAttribute('role', 'group');
        $('aiPick').setAttribute('aria-label', 'The AI found more than one requirement');
        $('aiPick').hidden = false;
      }
      const qs = r.ai.questions || [];
      if (qs.length) { $('aiQs').innerHTML = qs.map(q => `<li><i class="fa-regular fa-circle-question" aria-hidden="true"></i> ${esc(q)}</li>`).join(''); $('aiQs').hidden = false; }
      const unsure = r.ai.items[0].uncertain || [];
      $('aiNote').textContent = 'Filled in by AI — check it, then Search with these.' + (unsure.length ? ' Guessed: ' + unsure.join(', ') + '.' : '');
    } else {
      showAiItem(eng.item || {}, 'Built-in reading', eng.missing || []);
      $('aiNote').textContent = 'The AI reading isn’t available just now — the built-in reading is filled in instead.';
    }
  } catch (err) {
    $('aiNote').textContent = err.message;
  }
}));
function showAiItem(it, title, missing = it.missing || []) {
  fillItem(it);
  const line = itemOneLine(it);
  $('readBox').hidden = !line && !missing.length;
  $('readLine').innerHTML = line ? `<span>${esc(title)}:</span> <b>${esc(line)}</b>` : '';
  $('readMissing').hidden = !missing.length;
  $('readMissing').textContent = missing.length ? 'Not stated: ' + missing.join(', ') : '';
}
$('aiPick').addEventListener('click', e => {
  const b = e.target.closest('[data-ai]');
  if (!b || !S.aiItems) return;
  $('aiPick').querySelectorAll('[data-ai]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  showAiItem(S.aiItems[Number(b.dataset.ai)], 'AI read');
});

// ── More options (Find clients): the seller's property, field by field ──
const D_TYPE = { apartment: 'Apartment', villa: 'Villa', independent_house: 'Independent House', plot: 'Plot', commercial: 'Commercial' };
const D_SUB = { res_plot: 'residential plot', commercial_land: 'commercial land', industrial_land: 'industrial land', agri_land: 'agricultural land', office: 'office space', retail: 'retail showroom', warehouse: 'warehouse', industrial: 'industrial shed', hospitality: 'hotel restaurant', coworking: 'co-working', building: 'commercial building' };
function fillDetails(it) {
  const x = it || {};
  $('dType').value = D_TYPE[(x.types || [])[0]] || '';
  $('dSub').value = D_SUB[x.sub] || '';
  $('dBhk').value = x.bhk && x.bhk[0] ? String(Math.min(5, x.bhk[0])) : '';
  $('dLoc').value = (x.locations || []).map(l => l.name).join(', ');
  const a = x.area || {};
  $('dArea').value = a.min || a.max || '';
  $('dAUnit').value = ['grounds', 'cents', 'acres'].includes(a.unit) ? a.unit : 'sqft';
  const b = x.budget || {};
  $('dPrice').value = b.max || b.min ? fmtMoney(b.max || b.min) : '';
  $('dDeal').value = x.deal === 'rent' ? 'rent' : x.deal === 'lease' ? 'lease' : x.deal === 'jv' ? 'jv' : 'sale';
  const c = x.condition || [];
  $('dStatus').value = c.includes('ready') || x.possession === 'immediate' ? 'ready' : c.includes('under_construction') ? 'under construction' : '';
  $('dCond').value = c.includes('resale') ? 'resale' : c.includes('new') ? 'new' : '';
}
// What a clients search was read as → the form, so "I read this as" opens it ready to correct.
function fillDetailsFromAbout(a) {
  $('detailsForm').reset();
  const subOpt = a.sub ? [...$('dSub').options].find(o => o.value && (lc(o.text).includes(lc(a.sub)) || lc(a.sub).includes(lc(o.value)))) : null;
  if (subOpt) $('dSub').value = subOpt.value;
  const opt = [...$('dType').options].find(o => lc(o.value || o.text) === lc(a.type) || lc(o.text) === lc(a.type) || (a.type === 'House' && o.value === 'Independent House'));
  $('dType').value = opt ? opt.value : '';
  const bhk = String(a.name || '').match(/(\d)\s*bhk/i);
  $('dBhk').value = bhk ? String(Math.min(5, Number(bhk[1]))) : '';
  $('dLoc').value = a.location || '';
  const rentish = a.deal === 'rent' || a.deal === 'lease';
  const price = money(String(a.price || '').split(/[–-]/)[0], rentish ? 'per_month' : 'total');
  $('dPrice').value = price ? fmtMoney(price) : '';
  $('dDeal').value = a.deal === 'rent' ? 'rent' : a.deal === 'lease' ? 'lease' : a.deal === 'jv' ? 'jv' : 'sale';
}
$('detailsForm').addEventListener('submit', e => {
  e.preventDefault();
  const d = {
    type: $('dType').value, sub: $('dSub').value, bhk: $('dBhk').value, location: $('dLoc').value.trim(),
    area: num($('dArea').value) || '', areaUnit: $('dAUnit').value,
    // Rent and lease are a monthly amount: "25" there is ₹25k, never ₹25 Cr.
    price: money($('dPrice').value, ['rent', 'lease'].includes($('dDeal').value) ? 'per_month' : 'total') || '',
    deal: $('dDeal').value, status: $('dStatus').value, condition: $('dCond').value,
  };
  if (!d.type && !d.location && !d.price) { toast('Give at least a type, a place or a price'); $('dType').focus(); return; }
  $('q').value = '';
  setUrl({});
  run({ action: 'search', mode: 'clients', details: d }, { label: [d.bhk ? d.bhk + ' BHK' : '', d.type, d.location ? 'in ' + d.location : ''].filter(Boolean).join(' ') });
});

// ── The search box ──
// A plain search form: Enter submits it natively (IME-safe: the browser does not submit while a
// composition is being confirmed), and the button is the same path.
$('smartForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('q').value.trim();
  if (!text) { $('q').focus(); return; }
  $('aiNote').textContent = '';
  $('aiQs').hidden = true; $('aiPick').hidden = true; $('readBox').hidden = true;
  S.prev = null;
  searchText(egText(text), { label: text });
});
$('egs').addEventListener('click', e => {
  const b = e.target.closest('[data-eg]');
  if (!b) return;
  $('q').value = b.textContent.trim();
  $('smartForm').requestSubmit();
});

// ── Start: the toggle from the address (or as last left), then any deep link ──
const qs = new URLSearchParams(location.search);
let startFor = qs.get('for') === 'clients' ? 'clients' : null;
if (!startFor && !qs.get('for')) { try { startFor = localStorage.getItem('matchFor'); } catch (e) { startFor = null; } }
if (qs.get('property') || qs.get('listing') || qs.get('seller')) startFor = 'clients';
if (qs.get('lead')) startFor = 'properties';
setFor(startFor === 'clients' ? 'clients' : 'properties');
if (qs.get('lead')) {
  const reqIndex = qs.get('req');
  run({ action: 'search', mode: 'properties', leadId: qs.get('lead'), ...(reqIndex != null ? { reqIndex: Number(reqIndex) } : {}) }, { label: '' })
    // The CRM's "Review / Structure requirement →" link lands here with #requirements: open the editor.
    .then(() => { if (location.hash === '#requirements' && !$('leadBox').hidden && $('reqEditor').hidden) { $('reqEdit').click(); $('leadBox').scrollIntoView({ block: 'start' }); } });
} else if (qs.get('property') || qs.get('listing') || qs.get('seller')) {
  const body = qs.get('property') ? { propertyId: qs.get('property') } : qs.get('listing') ? { listingId: qs.get('listing') } : { sellerLeadId: qs.get('seller') };
  if (qs.get('property')) $('q').value = qs.get('property');
  run({ action: 'search', mode: 'clients', ...body }, { label: qs.get('property') || '' });
} else if (qs.get('q')) {
  $('q').value = egLabel(qs.get('q'));
  searchText(qs.get('q'));
}
