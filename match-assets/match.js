// ═══════ MATCH (match.html) ═══════
// Both directions of matching on one page, over /api/match (api/_match.js):
//   · Find properties for a requirement — every opportunity we hold, onboarded or still on its way
//     in (Shoot board card, CRM seller lead, agent submission), each saying where it came from, how
//     far it has got and which facts were checked.
//   · Find clients for a property — by its code, or a few typed details.
// One smart box on top reads a sentence and the server decides the direction (properties, clients,
// or un-onboarded stock that already has buyers). What the engine understood is shown as chips and
// an editable requirement ("Check what I understood"), so a search can be put right before acting on
// it. The AI read is optional and only fills the form; every score is the engine's.
//
// Deep links: ?lead=<id> (properties for that lead) · ?property=<id> / ?listing=<id> / ?seller=<id>
// (clients) · ?q=<text> (smart search).
//
// Modern Web Guidance applied: a real search form (Enter submits natively, no custom key handler),
// secondary content in <details>, the result list adapts to its own width (container queries), the
// count is announced (aria-live), every action is a native link or button with a 44px target on
// touch screens, nothing depends on hover, and every value is escaped before it reaches the page.
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
  const s = lc(v).replace(/₹|rs\.?|inr/g, '').replace(/,/g, '').trim();
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
const BAND_ICON = { strong: 'fa-circle-check', good: 'fa-thumbs-up', partial: 'fa-circle-half-stroke', weak: 'fa-circle-minus', 'ruled-out': 'fa-ban' };
const SRC_TAG = { onboarded: 'green', listing: 'blue', seller: 'wait', submission: '' };
const TRUST = {
  verified: { short: 'Verified', cls: 'v', icon: 'fa-circle-check' },
  seller: { short: 'Seller-provided', cls: 's', icon: 'fa-user' },
  agent: { short: 'Agent-provided', cls: 'a', icon: 'fa-id-badge' },
  chat: { short: 'From chat (AI)', cls: 'c', icon: 'fa-comment-dots' },
  missing: { short: 'Not known yet', cls: 'm', icon: 'fa-circle-question' },
};

// ── State ──
const S = {
  base: null,        // the last search, without filters and sort (re-run when they change)
  mode: null,        // properties | clients | demand — as the server answered
  about: null,       // the property a clients search was for
  reading: null,     // what the engine read (properties)
  rows: [],
  seq: 0,
  label: '',         // how the search was asked, for the title and the request reason
  aiItems: null,
};

// ── Direction tabs ──
const TABS = [['tabProps', 'pProps'], ['tabClients', 'pClients']];
function setTab(id, { focus = false } = {}) {
  TABS.forEach(([t, p]) => {
    const on = t === id;
    $(t).setAttribute('aria-selected', String(on));
    $(t).tabIndex = on ? 0 : -1;
    $(p).hidden = !on;
  });
  if (focus) $(id).focus();
}
TABS.forEach(([t], i) => {
  $(t).addEventListener('click', () => setTab(t));
  $(t).addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    setTab(TABS[(i + 1) % 2][0], { focus: true });
  });
});

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
  return f;
}
// Only the filters that work on what is listed count (client rows have no price, type or source).
function activeFilterCount() {
  const f = readFilters();
  const clientKeys = ['location', 'minPct', 'showRuledOut'];
  return Object.keys(f).filter(k => S.mode !== 'clients' || clientKeys.includes(k)).length;
}
function syncFilterBar() {
  const forClients = S.mode === 'clients';
  document.querySelectorAll('#filterForm [data-for="properties"]').forEach(el => { el.hidden = forClients; });
  // The demand list is not filtered or sorted by the server: offer neither.
  $('filters').hidden = S.mode === 'demand';
  $('tools').hidden = S.mode === 'demand';
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

// ── Running a search ──
function skeleton() {
  $('list').innerHTML = '<li class="mt-sk" aria-hidden="true"></li><li class="mt-sk" aria-hidden="true"></li><li class="mt-sk" aria-hidden="true"></li>';
}
async function run(base, { label = null, keepLabel = false } = {}) {
  S.base = base;
  if (!keepLabel) S.label = label || '';
  const seq = ++S.seq;
  $('results').hidden = false;
  $('start').hidden = true;
  $('resCount').textContent = 'Searching…';
  $('list').setAttribute('aria-busy', 'true');
  if (!keepLabel) skeleton();
  const body = { ...base, filters: readFilters(), sort: $('sort').value, limit: 60 };
  try {
    const r = await mt('search', body);
    if (seq !== S.seq) return;
    S.mode = r.mode; S.rows = r.rows || []; S.about = r.about || null; S.reading = r.reading || null;
    draw(r, { fresh: !keepLabel });
  } catch (e) {
    if (seq !== S.seq) return;
    $('resTitle').textContent = 'No results';
    $('resCount').textContent = e.message;
    $('resNote').hidden = true;
    $('list').innerHTML = `<li class="empty"><i class="fa-regular fa-circle-question" aria-hidden="true"></i>${esc(e.message)}</li>`;
  } finally {
    if (seq === S.seq) $('list').removeAttribute('aria-busy');
  }
}

// Keep the address shareable (and the Back button sensible) without a reload.
function setUrl(params) {
  try {
    const u = new URL(location.href);
    ['q', 'lead', 'property', 'listing', 'seller', 'req'].forEach(k => u.searchParams.delete(k));
    Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') u.searchParams.set(k, v); });
    history.replaceState(history.state, '', u.pathname + u.search);
  } catch (e) { /* fine */ }
}

// ── Drawing ──
function titleFor(r) {
  const n = r.total != null ? r.total : (r.rows || []).length;
  if (r.mode === 'clients') return { title: S.about ? `Clients for ${S.about.name || 'this property'}` : 'Matching clients', count: n === 1 ? '1 matching client' : `${n} matching clients` };
  if (r.mode === 'demand') return { title: r.scope === 'shoot' ? 'Shoot-stage properties with buyers' : 'Unprocessed stock with buyers', count: n === 1 ? '1 property has matching buyers' : `${n} properties have matching buyers` };
  if (S.base && S.base.leadId) return { title: 'Properties for this client', count: n === 1 ? '1 matching property' : `${n} matching properties` };
  return { title: S.label ? `Properties for “${S.label}”` : 'Matching properties', count: n === 1 ? '1 matching property' : `${n} matching properties` };
}
const SRC_WORD = { onboarded: 'onboarded', listing: 'on the Shoot board', seller: 'seller lead', submission: 'agent submission' };
const srcWord = (k, n) => { const w = SRC_WORD[k] || k; return /lead$|submission$/.test(w) && n !== 1 ? w + 's' : w; };
function draw(r, { fresh = true } = {}) {
  const t = titleFor(r);
  $('resTitle').textContent = t.title;
  const shown = (r.rows || []).length;
  $('resCount').textContent = t.count + (r.total > shown ? ` · showing the top ${shown}` : '');
  syncFilterBar();
  // A line under the title: what it was for, and where the properties come from.
  const notes = [];
  if (r.mode === 'clients' && S.about) {
    const a = S.about;
    notes.push([a.type, a.sub, a.location, a.price, a.deal === 'rent' ? 'for rent' : a.deal === 'sale' ? 'for sale' : ''].filter(Boolean).map(esc).join(' · '));
  }
  if (r.mode === 'properties' && r.counts) {
    const c = Object.entries(r.counts).filter(([, n]) => n).map(([k, n]) => `${n} ${srcWord(k, n)}`);
    if (c.length) notes.push(esc(c.join(' · ')));
  }
  if (r.scope === 'unonboarded') notes.push('Only stock not yet onboarded');
  $('resNote').innerHTML = notes.join('<br>');
  $('resNote').hidden = !notes.length;

  if (r.mode === 'properties') {
    setTab('tabProps');
    drawReading(r.reading, { fresh });
  } else if (r.mode === 'clients') setTab('tabClients');
  else setTab('tabProps');

  const rows = r.rows || [];
  if (!rows.length) {
    const why = r.mode === 'clients' ? 'No client’s requirement fits this property well enough yet.' : r.mode === 'demand' ? 'None of this stock has a matching buyer yet.' : 'Nothing fits well enough yet. Try fewer filters, a wider budget, or check what I understood above.';
    $('list').innerHTML = `<li class="empty"><i class="fa-regular fa-folder-open" aria-hidden="true"></i>${esc(why)}</li>`;
    return;
  }
  $('list').innerHTML = rows.map((row, i) => r.mode === 'clients' ? clientCard(row, i) : r.mode === 'demand' ? demandCard(row, i) : propertyCard(row, i)).join('');
}

// The score, the verdict and how sure we are.
function scoreTile(row) {
  const band = (row.band && row.band.key) || (row.vetoed ? 'ruled-out' : 'weak');
  return `<div class="mt-score" data-band="${esc(band)}">
    <b>${row.vetoed ? '—' : esc(row.pct) + '<small>%</small>'}</b>
    <span><i class="fa-solid ${BAND_ICON[band] || 'fa-circle'}" aria-hidden="true"></i> ${esc((row.band && row.band.label) || '')}</span>
  </div>`;
}
const confLine = row => row.confidence ? `<span class="mt-conf" data-c="${esc(lc(row.confidence))}">${esc(row.confidence)} confidence</span>` : '';

// Why, why not, and what is not known yet — the top few.
// The budget and the location already have their own line (fitLine): their reasons are not repeated.
function shownInFit(row) {
  const skip = new Set();
  const b = row.budget || row.budgetDiff;
  if (b && b.text) skip.add('budget');
  if (row.location2 && row.location2.text && row.location2.level !== 'unknown') skip.add('locality');
  return skip;
}
function reasons(row) {
  const li = [];
  const skip = shownInFit(row);
  const keep = x => !skip.has(x.key);
  (row.for || []).filter(keep).slice(0, 3).forEach(x => li.push(`<li class="y"><i class="fa-solid fa-check" aria-hidden="true"></i><span><span class="sr">Fits: </span>${esc(x.why)}</span></li>`));
  (row.against || []).filter(keep).slice(0, 2).forEach(x => li.push(`<li class="n"><i class="fa-solid fa-xmark" aria-hidden="true"></i><span><span class="sr">Against: </span>${esc(x.why)}</span></li>`));
  (row.unknown || []).slice(0, 2).forEach(x => li.push(`<li class="u"><i class="fa-solid fa-question" aria-hidden="true"></i><span>Not known yet: ${esc(x.why || x.label)}</span></li>`));
  if (row.vetoed) (row.vetoes || []).forEach(x => li.push(`<li class="n"><i class="fa-solid fa-ban" aria-hidden="true"></i><span><span class="sr">Ruled out: </span>${esc(x.why)}</span></li>`));
  return li.length ? `<ul class="mt-why">${li.join('')}</ul>` : '';
}
function fitLine(row) {
  const b = row.budget || row.budgetDiff;
  const loc = row.location2;
  const bits = [];
  if (b && b.text) bits.push(`<span class="mt-fit ${b.within ? 'ok' : 'over'}"><i class="fa-solid fa-indian-rupee-sign" aria-hidden="true"></i> ${esc(b.text)}</span>`);
  if (loc && loc.text && loc.level !== 'unknown') bits.push(`<span class="mt-fit loc-${esc(loc.level)}"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${esc(loc.text)}</span>`);
  else if (loc && loc.level === 'unknown') bits.push(`<span class="mt-fit loc-unknown"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> Location: ${esc(loc.text || 'not compared')}</span>`);
  return bits.length ? `<p class="mt-fits">${bits.join('')}</p>` : '';
}
const nextLine = row => row.next ? `<p class="mt-next"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i> <span><span class="mt-next-l">Next:</span> ${esc(row.next)}</span></p>` : '';
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

// ── A property ──
const LINK = {
  property: id => 'dashboard.html?property=' + encodeURIComponent(id),
  listing: id => 'propertytrack.html?listing=' + encodeURIComponent(id),
  lead: id => 'crm.html?lead=' + encodeURIComponent(id),
  submission: () => 'myday.html',
};
const LINK_LABEL = { property: 'Open property', listing: 'Open Shoot card', lead: 'Open seller lead', submission: 'Open in My Day' };
function factsLine(row) {
  const facts = row.facts || [];
  if (!facts.length) {
    return [row.location, row.price, row.area, row.bhk && row.bhk.length ? row.bhk.join(' / ') + ' BHK' : ''].filter(Boolean).map(v => `<li>${esc(v)}</li>`).join('');
  }
  // A checked property says so once; anything else marks the facts that rest on something weaker.
  return facts.filter(f => f.label !== 'Type').map(f => {
    if (f.src === 'missing') return `<li class="mt-f-miss">${esc(f.label)}: <span>not known yet</span></li>`;
    const t = TRUST[f.src] || TRUST.seller;
    // The trust line says what the row rests on; a fact is marked only when it rests on something
    // else (a price read from the chat on a seller's card).
    const mark = row.verified || f.src === 'verified' || f.src === row.trust ? '' : ` <small class="mt-fsrc ${t.cls}" title="${esc(t.short)}"><i class="fa-solid ${t.icon}" aria-hidden="true"></i> ${esc(t.short)}</small>`;
    return `<li>${esc(f.value)}${mark}</li>`;
  }).join('');
}
// "Shoot board · More details pending" — but an onboarded one's status already says so.
const statusText = p => (p.source === 'onboarded' && /onboarded/i.test(p.status || '') ? p.status : [p.sourceLabel, p.status].filter(Boolean).join(' · '));
function propertyCard(row, i) {
  const restricted = row.access === 'restricted' || (row.link && row.link.type === 'restricted');
  const summary = row.access === 'summary';
  const tag = SRC_TAG[row.source] != null ? SRC_TAG[row.source] : '';
  const status = statusText(row);
  const trust = row.verified
    ? `<span class="mt-trust v"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Verified (inventory)</span>`
    : `<span class="mt-trust u"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${esc(row.trustLabel || 'Not verified')} — not verified</span>`;
  const href = !restricted && row.link && LINK[row.link.type] ? LINK[row.link.type](row.link.id) : '';
  const acts = [];
  if (href) acts.push(`<a class="btn sm" href="${esc(href)}"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> ${esc(LINK_LABEL[row.link.type] || 'Open')}</a>`);
  if (restricted) acts.push(`<span class="mt-held"><i class="fa-solid fa-lock" aria-hidden="true"></i> Ask the office about this one</span>`);
  if (summary) acts.push(`<span class="mt-held"><i class="fa-solid fa-lock" aria-hidden="true"></i> Summary only — request it from the property page</span>`);
  if (!restricted && row.link) acts.push(`<button type="button" class="btn sm quiet" data-act="buyers" data-i="${i}"><i class="fa-solid fa-users" aria-hidden="true"></i> Matching clients</button>`);
  acts.push(`<button type="button" class="btn sm quiet" data-act="share" data-i="${i}"><i class="fa-regular fa-copy" aria-hidden="true"></i> Share</button>`);
  const also = (row.alsoIn || []).length ? `<p class="mt-also">Also in: ${row.alsoIn.map(a => esc(a.label)).join(', ')}</p>` : '';
  const facts = (row.facts || []).length ? `<dl class="mt-factlist">${row.facts.map(f => {
    const t = TRUST[f.src] || TRUST.seller;
    return `<div><dt>${esc(f.label)}</dt><dd>${f.value != null ? esc(f.value) : '—'} <small class="mt-fsrc ${t.cls}"><i class="fa-solid ${t.icon}" aria-hidden="true"></i> ${esc(t.short)}</small></dd></div>`;
  }).join('')}</dl>` : '';
  return `<li class="mt-row${row.vetoed ? ' out' : ''}" data-src="${esc(row.source)}">
    <article aria-labelledby="r${i}">
      ${scoreTile(row)}
      <div class="mt-main">
        <h3 id="r${i}">${esc(row.name || 'Untitled property')}${row.code ? ` <span class="mt-code">${esc(row.code)}</span>` : ''}</h3>
        <p class="mt-src"><span class="tag ${tag}">${esc(status)}</span>${trust}${confLine(row)}</p>
        <ul class="mt-facts">${factsLine(row)}</ul>
        ${fitLine(row)}
        ${reasons(row)}
        ${nextLine(row)}
        ${also}
        <details class="mt-more">
          <summary><i class="fa-solid fa-chevron-down" aria-hidden="true"></i> Score breakdown${facts ? ' and facts' : ''}</summary>
          ${facts}
          ${breakdown(row)}
          ${row.updatedAt ? `<p class="mt-upd">Updated ${esc(ago(row.updatedAt))}${row.createdAt ? ` · added ${esc(ago(row.createdAt))}` : ''}</p>` : ''}
        </details>
      </div>
      <footer class="mt-acts">${acts.join('')}${row.updatedAt ? `<span class="mt-when">Updated ${esc(ago(row.updatedAt))}</span>` : ''}</footer>
    </article>
  </li>`;
}

// ── A client ──
function clientCard(row, i) {
  const restricted = row.access === 'restricted';
  const wants = [row.config, (row.types || []).join(' / '), row.sub, row.dealLabel].filter(Boolean).join(' · ');
  const kv = [];
  if (wants) kv.push(['Wants', esc(wants)]);
  if (restricted && row.requirement) kv.push(['Asked for', esc(row.requirement)]);
  if (row.budget) kv.push(['Budget', esc(row.budget)]);
  if ((row.locations || []).length) kv.push(['Areas', esc(row.locations.join(', '))]);
  if ((row.exclude || []).length) kv.push(['Not in', esc(row.exclude.join(', '))]);
  if (row.area) kv.push(['Size', esc(row.area)]);
  const missing = (row.unknown || []).map(u => u.label).filter(Boolean);
  if (missing.length) kv.push(['Missing', esc([...new Set(missing)].slice(0, 4).join(', '))]);
  const meta = [];
  if (row.stage) meta.push(`<span class="tag">${esc(row.stage)}</span>`);
  if (row.leadSource) meta.push(`<span class="tag">${esc(row.leadSource)}</span>`);
  if (row.interest) meta.push(`<span class="tag ${row.interest === 'hot' || row.interest === 'high' ? 'brand' : ''}">Interest: ${esc(lc(row.interest))}</span>`);
  const times = [];
  if (row.lastTouch) times.push(`Last in touch ${esc(ago(row.lastTouch))}`);
  if (row.reqUpdated) times.push(`requirement updated ${esc(ago(row.reqUpdated))}`);
  const owner = row.ownerName || row.owner;
  const who = restricted
    ? `<p class="mt-who"><i class="fa-solid fa-lock" aria-hidden="true"></i> Held by another agent / the office</p>`
    : `<p class="mt-who">${row.phone ? `<span>${esc(row.phone)}</span>` : ''}${owner ? `<span><i class="fa-regular fa-user" aria-hidden="true"></i> ${esc(owner)}</span>` : '<span>Not assigned</span>'}</p>`;
  const reqN = row.reqCount > 1 ? `<p class="mt-reqn">Matches their requirement #${esc((row.reqIndex || 0) + 1)} of ${esc(row.reqCount)}</p>` : '';
  const acts = [];
  if (restricted) {
    acts.push(`<button type="button" class="btn sm primary" data-act="request" data-i="${i}"><i class="fa-solid fa-hand" aria-hidden="true"></i> Request details</button>`);
  } else if (row.leadId) {
    const id = encodeURIComponent(row.leadId);
    acts.push(`<a class="btn sm" href="crm.html?lead=${id}"><i class="fa-regular fa-id-card" aria-hidden="true"></i> View client</a>`);
    if (row.phone) {
      acts.push(`<a class="btn sm wa" href="https://wa.me/${esc(phoneDigits(row.phone))}" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp" aria-hidden="true"></i> WhatsApp</a>`);
      acts.push(`<a class="btn sm" href="tel:${esc(String(row.phone).replace(/[^\d+]/g, ''))}"><i class="fa-solid fa-phone" aria-hidden="true"></i> Call</a>`);
    }
    acts.push(`<a class="btn sm quiet" href="crm.html?lead=${id}&amp;followup=1"><i class="fa-regular fa-calendar-plus" aria-hidden="true"></i> Follow-up</a>`);
  }
  acts.push(`<button type="button" class="btn sm quiet" data-act="share" data-i="${i}"><i class="fa-regular fa-copy" aria-hidden="true"></i> Share</button>`);
  return `<li class="mt-row${row.vetoed ? ' out' : ''}${restricted ? ' held' : ''}">
    <article aria-labelledby="r${i}">
      ${scoreTile(row)}
      <div class="mt-main">
        <h3 id="r${i}">${esc(row.name || 'A matching client')}</h3>
        ${who}
        ${reqN}
        <p class="mt-src">${meta.join('')}${confLine(row)}</p>
        ${kv.length ? `<dl class="mt-kv">${kv.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` : ''}
        ${fitLine(row)}
        ${reasons(row)}
        ${nextLine(row)}
        ${times.length ? `<p class="mt-upd">${times.join(' · ')}</p>` : ''}
        <details class="mt-more">
          <summary><i class="fa-solid fa-chevron-down" aria-hidden="true"></i> Score breakdown</summary>
          ${row.reqText ? `<p class="mt-reqtext">“${esc(row.reqText)}”</p>` : ''}
          ${breakdown(row)}
        </details>
        <p class="mt-reqres" id="rq${i}" role="status"></p>
      </div>
      <footer class="mt-acts">${acts.join('')}</footer>
    </article>
  </li>`;
}

// ── Stock that already has buyers ──
function demandCard(row, i) {
  const p = row.property || {};
  const tag = SRC_TAG[p.source] != null ? SRC_TAG[p.source] : '';
  const facts = [p.location, p.price, p.area, p.bhk && p.bhk.length ? p.bhk.join(' / ') + ' BHK' : ''].filter(Boolean);
  const href = p.link && LINK[p.link.type] ? LINK[p.link.type](p.link.id) : '';
  const top = (row.top || []).map(t => `<li>${t.leadId && !isAgent ? `<a href="crm.html?lead=${encodeURIComponent(t.leadId)}">${esc(t.name || 'Client')}</a>` : esc(t.name || 'A matching client')} <b>${esc(t.pct)}%</b></li>`).join('');
  return `<li class="mt-row demand" data-src="${esc(p.source)}">
    <article aria-labelledby="r${i}">
      <div class="mt-score" data-band="${row.strong ? 'strong' : 'good'}"><b>${esc(row.buyers)}</b><span>${row.buyers === 1 ? 'buyer' : 'buyers'}</span></div>
      <div class="mt-main">
        <h3 id="r${i}">${esc(p.name || 'A property')}${p.code ? ` <span class="mt-code">${esc(p.code)}</span>` : ''}</h3>
        <p class="mt-src"><span class="tag ${tag}">${esc(statusText(p))}</span>${p.verified ? '' : `<span class="mt-trust u"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${esc(p.trustLabel || 'Not verified')} — not verified</span>`}</p>
        ${facts.length || (p.facts || []).length ? `<ul class="mt-facts">${factsLine(p)}</ul>` : ''}
        <p class="mt-demand"><b>${esc(row.buyers)} matching ${row.buyers === 1 ? 'buyer' : 'buyers'}</b>${row.strong ? `, <b class="strong">${esc(row.strong)} strong</b>` : ''}</p>
        ${top ? `<ol class="mt-top">${top}</ol>` : ''}
        ${p.next ? nextLine(p) : ''}
      </div>
      <footer class="mt-acts">
        <button type="button" class="btn sm primary" data-act="demand-buyers" data-i="${i}"><i class="fa-solid fa-users" aria-hidden="true"></i> See buyers</button>
        ${href ? `<a class="btn sm" href="${esc(href)}"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> ${esc(LINK_LABEL[p.link.type] || 'Open')}</a>` : ''}
      </footer>
    </article>
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
      S.about ? `For: ${S.about.name}` : '', row.next ? `Next: ${row.next}` : ''].filter(Boolean).join('\n');
  }
  const p = S.mode === 'demand' ? row.property : row;
  return [`${p.name || 'Property'}${p.code ? ' (' + p.code + ')' : ''}`, [p.location, p.price, p.area].filter(Boolean).join(' · '),
    [p.sourceLabel, p.status].filter(Boolean).join(' · ') + (p.verified ? '' : ' — not verified yet'),
    S.mode === 'properties' && row.pct != null ? `${row.pct}% ${row.band ? row.band.label : ''} match` : ''].filter(Boolean).join('\n');
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied — paste it where you need it'); }
  catch (e) { toast('Could not copy on this device'); }
}
$('list').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const row = S.rows[Number(b.dataset.i)];
  if (!row) return;
  const act = b.dataset.act;
  if (act === 'share') copy(shareText(row));
  else if (act === 'buyers') runClients(clientsBodyFor(row), row.name);
  else if (act === 'demand-buyers') runClients(clientsBodyFor(row.property || {}), (row.property || {}).name);
  else if (act === 'request') busy(b, () => requestLead(row, b));
});
function runClients(body, name) {
  setTab('tabClients');
  const id = body.propertyId ? { property: body.propertyId } : body.listingId ? { listing: body.listingId } : body.sellerLeadId ? { seller: body.sellerLeadId } : {};
  setUrl(id);
  run({ action: 'search', ...body }, { label: name || '' });
  $('results').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
async function requestLead(row, btn) {
  const out = btn.closest('article').querySelector('.mt-reqres');
  const about = S.mode === 'clients' && S.about ? `my property “${S.about.name}”` : S.label ? `my client (${S.label})` : 'my client';
  try {
    await api('request', { kind: 'lead', ref: row.ref, reason: `Matches ${about} — ${row.pct}% ${row.band ? row.band.label.toLowerCase() : 'match'}` });
    out.textContent = 'Asked — the office will decide. You’ll see it in My Day.';
    out.className = 'mt-reqres ok';
    btn.remove();
  } catch (err) {
    out.textContent = err.message;
    out.className = 'mt-reqres bad';
  }
}

// ── What the engine read: chips, and the editable requirement ──
function chipList(chips) {
  return (chips || []).map(c => `<li><span>${esc(c.label)}</span><b>${esc(c.value)}</b>${c.note ? `<small>${esc(c.note)}</small>` : ''}</li>`).join('');
}
function drawReading(reading, { fresh = true } = {}) {
  if (!reading) return;
  if (reading.from === 'lead') {
    drawLeadReading(reading);
    return;
  }
  $('leadBox').hidden = true;
  closeEditor();
  $('refine').hidden = false;
  $('readBox').hidden = !(reading.chips && reading.chips.length) && !(reading.missing && reading.missing.length);
  $('readChips').innerHTML = chipList(reading.chips);
  $('readMissing').hidden = !(reading.missing && reading.missing.length);
  if (reading.missing && reading.missing.length) $('readMissing').textContent = 'Not stated: ' + reading.missing.join(', ');
  $('refineTitle').innerHTML = `Check what I understood <span class="mt-sum-chips">${(reading.chips || []).slice(0, 4).map(c => `<span>${esc(c.value)}</span>`).join('')}</span>`;
  // Only a new search refills the form — a filter change must not undo edits in progress.
  if (reading.item && fresh) fillItem(reading.item);
}
// ── A client's own requirements (?lead=) ──
const SRC_WORDS = { reviewed: 'Reviewed', ai: 'Read by AI from the chat', lead: 'From the CRM fields' };
const STATUS_WORD = { active: 'Active', previous: 'Previous', closed: 'Closed' };
function drawLeadReading(reading) {
  $('leadBox').hidden = false;
  $('refine').hidden = true;
  S.leadReading = reading;
  if ($('leadTitle')) $('leadTitle').textContent = (reading.leadName ? reading.leadName + '’s' : 'This client’s') + ' requirements';
  const reqs = reading.requirements || [];
  const cur = S.base && S.base.reqIndex != null ? Number(S.base.reqIndex) : (reqs[0] ? reqs[0].index : 0);
  $('leadReqs').innerHTML = reqs.length > 1 ? reqs.map((q, k) => `<button type="button" class="chip" aria-pressed="${q.index === cur}" data-req="${esc(q.index)}" title="${esc(q.text || '')}">#${k + 1}${q.item && itemLabel(q.item) !== 'your requirement' ? ' ' + esc(itemLabel(q.item)) : q.text ? ' ' + esc(q.text.slice(0, 50)) : ''}</button>`).join('') : '';
  const sel = reqs.find(q => q.index === cur) || reqs[0];
  const by = reading.reviewedAt ? `Reviewed ${ago(reading.reviewedAt)}${reading.reviewedBy ? ' by ' + reading.reviewedBy : ''}` : (sel ? SRC_WORDS[sel.src] || '' : '');
  $('leadReviewed').textContent = by;
  $('leadStale').hidden = !(sel && sel.stale);
  $('leadText').hidden = !(sel && sel.text);
  $('leadText').textContent = sel && sel.text ? '“' + sel.text + '”' : '';
  $('leadChips').innerHTML = sel ? chipList(sel.chips) : '';
  $('leadMissing').hidden = !(sel && sel.missing && sel.missing.length);
  if (sel && sel.missing && sel.missing.length) $('leadMissing').textContent = 'Not stated: ' + sel.missing.join(', ');
}

// The editor: S.edit is the list of ITEMs, S.edCur the one in the form. The form is the same one
// the free-text refine uses — moved here while editing, and back afterwards.
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
  document.querySelector('.mt-refine-b').append(itemForm);
  S.edit = null; S.edCur = null; S.edModel = null;
}
async function openEditor() {
  const reading = S.leadReading || {};
  // Every saved requirement, previous ones too (allItems), so none is lost on the next save; with
  // nothing saved yet, the live reading of the lead.
  let items = (Array.isArray(reading.allItems) && reading.allItems.length ? reading.allItems : (reading.requirements || []).map(q => q.item).filter(Boolean))
    .map(it => ({ status: 'active', ...it }));
  S.edit = items.length ? items : [blankItem()];
  S.edModel = null;
  $('edFormSlot').append(itemForm);
  itemForm.classList.add('in-editor');
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
  try {
    await mt('save-req', { leadId: S.base.leadId, items, ...(S.edModel ? { aiModel: S.edModel } : {}) });
    closeEditor();
    toast('Saved — the CRM’s own fields are unchanged; the old version is in History');
    $('histBox').hidden = true; $('reqHist').setAttribute('aria-expanded', 'false');
    const { reqIndex, ...base } = S.base;
    setUrl({ lead: base.leadId });
    run(base, { keepLabel: true });
  } catch (err) { $('reqErr').textContent = err.message; }
}));
$('reqHist').addEventListener('click', e => {
  if (!$('histBox').hidden) { $('histBox').hidden = true; e.currentTarget.setAttribute('aria-expanded', 'false'); return; }
  busy(e.currentTarget, async () => {
    $('histBox').hidden = false;
    $('reqHist').setAttribute('aria-expanded', 'true');
    try {
      const h = await mt('req-history', { leadId: S.base.leadId });
      const revs = h.revisions || [];
      $('histBox').innerHTML = revs.length ? `<ol class="mt-histl">${revs.map(r => `<li><b>${esc(ago(r.at))}</b> <span>${esc(r.by || '')}${r.src && r.src !== 'reviewed' ? ' · ' + esc(r.src) : ''}</span>
        <ul>${(r.items || []).map(it => `<li>${esc(itemLabel(it))}${(it.status || 'active') !== 'active' ? ` <span class="tag">${esc(STATUS_WORD[it.status] || it.status)}</span>` : ''}</li>`).join('') || '<li>Cleared</li>'}</ul></li>`).join('')}</ol>`
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

// The form ⇄ an ITEM (shared-assets/match-sources.js cleanItem decides what is kept).
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
  setUrl({});
  run({ action: 'search', mode: 'properties', item }, { label: itemLabel(item) });
});
$('itemClear').addEventListener('click', () => { fillItem({}); $('aiNote').textContent = ''; });
const TYPE_WORD = { apartment: 'Apartment', villa: 'Villa', independent_house: 'House', plot: 'Plot', commercial: 'Commercial' };
const SUB_WORD = { res_plot: 'residential plot', commercial_land: 'commercial land', industrial_land: 'industrial land', agri_land: 'agricultural land', office: 'office', retail: 'retail', warehouse: 'warehouse', industrial: 'industrial shed', hospitality: 'hotel / restaurant', coworking: 'co-working', building: 'commercial building' };
const DEAL_WORD = { rent: 'to rent', lease: 'on lease', jv: 'for JV' };
function itemLabel(it) {
  return [it.bhk ? it.bhk.join('/') + ' BHK' : '', it.sub && SUB_WORD[it.sub] ? SUB_WORD[it.sub] : (it.types || []).map(t => TYPE_WORD[t] || t).join('/'), DEAL_WORD[it.deal] || '',
    it.locations ? 'in ' + it.locations.map(l => l.name).join(', ') : it.anywhere ? 'anywhere' : '',
    it.budget && it.budget.max ? 'up to ' + fmtMoney(it.budget.max) : ''].filter(Boolean).join(' ') || 'your requirement';
}

// "Read with AI": the optional second reading. It fills the form; it never searches by itself.
$('aiRead').addEventListener('click', e => busy(e.currentTarget, async () => {
  const text = $('q').value.trim();
  if (!text) { $('aiNote').textContent = 'Type the requirement in the box at the top first.'; $('q').focus(); return; }
  $('aiNote').textContent = '';
  $('aiQs').hidden = true; $('aiPick').hidden = true;
  try {
    const r = await mt('interpret', { text });
    const eng = r.engine || {};
    $('readBox').hidden = false;
    $('readChips').innerHTML = chipList(eng.chips);
    $('readMissing').hidden = !(eng.missing && eng.missing.length);
    if (eng.missing && eng.missing.length) $('readMissing').textContent = 'Not stated: ' + eng.missing.join(', ');
    if (r.ai && (r.ai.items || []).length) {
      S.aiItems = r.ai.items;
      if (r.ai.direction === 'clients') {
        fillDetails(r.ai.items[0]);
        setTab('tabClients');
        toast('Read as a property — check the details, then Find clients');
        return;
      }
      fillItem(r.ai.items[0]);
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
      fillItem(eng.item || {});
      $('aiNote').textContent = 'The AI reading isn’t available just now — the built-in reading is filled in instead.';
    }
  } catch (err) {
    $('aiNote').textContent = err.message;
  }
}));
$('aiPick').addEventListener('click', e => {
  const b = e.target.closest('[data-ai]');
  if (!b || !S.aiItems) return;
  $('aiPick').querySelectorAll('[data-ai]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  fillItem(S.aiItems[Number(b.dataset.ai)]);
});

// ── Clients for a property: by code, or typed details ──
$('codeForm').addEventListener('submit', e => {
  e.preventDefault();
  const code = $('pCode').value.trim().toUpperCase();
  if (!code) { $('pCode').focus(); return; }
  setUrl({ property: code });
  run({ action: 'search', mode: 'clients', propertyId: code }, { label: code });
});
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
$('detailsForm').addEventListener('submit', e => {
  e.preventDefault();
  const d = {
    type: $('dType').value, sub: $('dSub').value, bhk: $('dBhk').value, location: $('dLoc').value.trim(),
    area: num($('dArea').value) || '', areaUnit: $('dAUnit').value, price: money($('dPrice').value) || '',
    deal: $('dDeal').value, status: $('dStatus').value, condition: $('dCond').value,
  };
  if (!d.type && !d.location && !d.price) { toast('Give at least a type, a place or a price'); $('dType').focus(); return; }
  setUrl({});
  run({ action: 'search', mode: 'clients', details: d }, { label: [d.bhk ? d.bhk + ' BHK' : '', d.type, d.location ? 'in ' + d.location : ''].filter(Boolean).join(' ') });
});

// ── The smart box ──
// A plain search form: Enter submits it natively (IME-safe: the browser does not submit while a
// composition is being confirmed), and the button is the same path.
$('smartForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('q').value.trim();
  if (!text) { $('q').focus(); return; }
  $('aiNote').textContent = '';
  $('aiQs').hidden = true; $('aiPick').hidden = true;
  setUrl({ q: text });
  run({ action: 'search', mode: 'smart', text }, { label: text });
});
document.querySelector('.mt-eg').addEventListener('click', e => {
  const b = e.target.closest('[data-eg]');
  if (!b) return;
  $('q').value = b.dataset.eg;
  $('smartForm').requestSubmit();
});

// ── Deep links ──
const qs = new URLSearchParams(location.search);
if (qs.get('lead')) {
  const reqIndex = qs.get('req');
  run({ action: 'search', mode: 'properties', leadId: qs.get('lead'), ...(reqIndex != null ? { reqIndex: Number(reqIndex) } : {}) }, { label: '' });
} else if (qs.get('property') || qs.get('listing') || qs.get('seller')) {
  const body = qs.get('property') ? { propertyId: qs.get('property') } : qs.get('listing') ? { listingId: qs.get('listing') } : { sellerLeadId: qs.get('seller') };
  if (qs.get('property')) $('pCode').value = qs.get('property');
  setTab('tabClients');
  run({ action: 'search', mode: 'clients', ...body }, { label: qs.get('property') || '' });
} else if (qs.get('q')) {
  $('q').value = qs.get('q');
  run({ action: 'search', mode: 'smart', text: qs.get('q') }, { label: qs.get('q') });
}
