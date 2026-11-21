// ═══════ MY LISTINGS (mylistings.html) — an agent's properties, stage by stage ═══════
// The Shoot & Media board's pipeline (track-assets/track-pipeline.js), for the properties an agent
// brings in and looks after: Board or List, a "next step" button on every card, and a sheet with the
// details, the brochure, the approval and the timeline. Everything goes through the server
// (api/_agent-listings.js), which checks it: an agent moves their own cards anywhere except into
// Approved — an admin approves — and Live comes after that.
//
// Modern Web Guidance applied: the board scrolls sideways natively with scroll-snap (no touch
// handlers; natural-interactions), every action is a real <button> or <a> (no hover-only controls),
// moves use a native <select> instead of drag-only, touch targets are 44px on touch screens
// (form-factor-adaptation), and secondary content (the timeline) sits in <details>
// (content-first-noise-reduction).
import { $, esc, api, whenSignedIn, toast, openSheet, closeSheet, busy, ago, when } from '../shared-assets/agent-client.js';

const me = await whenSignedIn();
window.AppNav.boot({ console: 'mylistings', select: () => {}, signOut: () => import('../shared-assets/agent-client.js').then(m => m.signOutHere()) });
window.AppNav.setUser(me.email);
window.AppNav.setActive('mylistings');

const VIEW_KEY = 'pin.mylistings.view';
let view = 'board';
// A phone opens on the List (one column, what needs you first); a laptop on the Board — until the
// person picks one, which is then remembered.
try { const saved = localStorage.getItem(VIEW_KEY); view = saved === 'list' || saved === 'board' ? saved : (matchMedia('(max-width: 700px)').matches ? 'list' : 'board'); } catch (e) { /* private window */ }
let chip = 'all';
let D = { stages: [], listings: [], canAdd: false, holdReasons: {}, dropReasons: {} };
let loaded = false;
let loadedAt = 0;

// The one step forward from each stage, in the words an agent would use.
const NEXT = {
  new_listing: ['details', 'Start collecting details'],
  details: ['shoot_scheduled', 'Shoot booked'],
  shoot_scheduled: ['shoot_done', 'Shoot done'],
  shoot_done: ['media_ready', 'Media ready'],
  media_ready: ['for_approval', 'Send for approval'],
  approved: ['live', 'Mark Live'],
  live: ['closed', 'Sold / Rented'],
  on_hold: ['details', 'Back to work'],
  dropped: ['details', 'Back to work'],
};
const CLOSED_KEYS = ['closed', 'on_hold', 'dropped'];
const stageByKey = k => D.stages.find(s => s.key === k);
const stageName = k => (stageByKey(k) || {}).name || k;
const daysIn = x => Math.max(0, Math.floor((Date.now() - (x.stageChangedAt || x.createdAt || Date.now())) / 86400000));
const late = x => { const s = stageByKey(x.stageKey); return !!(s && s.targetDays && daysIn(x) > s.targetDays && !CLOSED_KEYS.includes(x.stageKey) && x.stageKey !== 'live'); };
// What a listing needs from the agent right now (the "Needs me" chip and the card's red line).
function needs(x) {
  if (x.virtual) return '';
  const a = x.approval || {};
  if (x.stageKey === 'details' && a.decision === 'returned') return 'Sent back: ' + (a.note || 'see the note');
  if (x.stageKey === 'approved') return 'Approved — mark it Live when marketing starts';
  if (x.stageKey === 'media_ready') return 'Ready to send for approval';
  if (late(x)) return `${daysIn(x)} days in ${stageName(x.stageKey)}`;
  return '';
}
const FILTERS = [
  ['all', 'All', () => true],
  ['me', 'Needs me', x => !!needs(x)],
  ['work', 'In progress', x => !CLOSED_KEYS.includes(x.stageKey) && !['live', 'for_approval', 'approved'].includes(x.stageKey)],
  ['approval', 'Approval', x => x.stageKey === 'for_approval' || x.stageKey === 'approved'],
  ['live', 'Live', x => x.stageKey === 'live'],
  ['closed', 'Sold / paused', x => CLOSED_KEYS.includes(x.stageKey)],
];

async function load() {
  try {
    D = await api('listings');
    loaded = true; loadedAt = Date.now();
    $('addBtn').hidden = !D.canAdd;
    // The office runs every listing on the Shoot & Media board; this page is the agents'.
    if (!D.isAgent) { document.querySelector('.ml-bar').hidden = !D.listings.length; $('chips').hidden = !D.listings.length; }
    if (!D.isAgent && !document.getElementById('officeNote')) $('main').insertAdjacentHTML('afterbegin', '<div class="callout" id="officeNote">This page is for agents. The office runs every listing — agents’ ones too — on the <a href="propertytrack.html">Shoot &amp; Media board</a>.</div>');
    draw();
    openWanted();
  } catch (e) {
    // Switched off or not part of their access: nothing to try again.
    const final = e.status === 403;
    $('out').innerHTML = `<div class="card"><div class="empty"><i class="fa-solid fa-${final ? 'lock' : 'triangle-exclamation'}" aria-hidden="true"></i>${final ? esc(e.message) : 'Couldn’t load your listings — ' + esc(e.message)} ${final ? '<a class="btn sm" href="dashboard.html">Go to Properties</a>' : '<button type="button" class="btn sm" id="retry">Try again</button>'}</div></div>`;
    if (!final) $('retry').addEventListener('click', load);
    document.querySelector('.ml-bar').hidden = true; $('chips').hidden = true;
  }
}

function filtered() {
  const q = $('q').value.trim().toLowerCase();
  const f = (FILTERS.find(x => x[0] === chip) || FILTERS[0])[2];
  return D.listings.filter(x => f(x) && (!q || [x.title, x.propertyCode, x.draftCode, x.location, x.config, x.sellerName, x.askingPrice].join(' ').toLowerCase().includes(q)));
}

function draw() {
  if (!loaded) return;
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  const counts = Object.fromEntries(FILTERS.map(([k, , f]) => [k, D.listings.filter(f).length]));
  $('chips').innerHTML = FILTERS.filter(([k]) => k === 'all' || counts[k]).map(([k, l]) =>
    `<button type="button" class="mx-chip${k === 'me' ? ' hot' : ''}" data-chip="${k}" aria-pressed="${k === chip}">${l} <span>${counts[k]}</span></button>`).join('');
  const list = filtered();
  if (!D.listings.length && !D.isAgent) { $('out').innerHTML = ''; return; }
  if (!D.listings.length) {
    $('out').innerHTML = `<div class="card ml-empty"><i class="fa-regular fa-building" aria-hidden="true"></i><b>No listings yet</b><p>${D.canAdd ? 'Add a property you are bringing in — it starts as a New listing, and you move it on as the work gets done.' : 'Properties assigned to you show up here.'}</p>${D.canAdd ? '<button type="button" class="btn primary" data-add>New listing</button>' : ''}</div>`;
    return;
  }
  $('out').innerHTML = view === 'board' ? boardHtml(list) : listHtml(list);
  // The board starts at the first stage that has a card in it — and stays where the person
  // scrolled it to across redraws (a move, a refresh).
  const b = $('out').querySelector('.ml-board');
  if (b) {
    const first = b.querySelector('.ml-col:not(.empty)');
    b.scrollLeft = boardX != null ? boardX : first ? Math.max(0, first.offsetLeft - b.offsetLeft - 8) : 0;
    b.addEventListener('scroll', () => { boardX = b.scrollLeft; }, { passive: true });
  }
}
let boardX = null;

// ── Cards ──
function chips(x) {
  const out = [];
  if (x.brochure && x.brochure.state === 'created') out.push('<span class="tag green"><i class="fa-regular fa-file-lines" aria-hidden="true"></i> Brochure</span>');
  else if (x.brochure && x.brochure.state === 'requested') out.push('<span class="tag wait">Brochure asked</span>');
  if (x.stageKey === 'for_approval') out.push('<span class="tag wait">Waiting for an admin</span>');
  if (x.hidden && x.stageKey !== 'live') out.push('<span class="tag">Not shown to other agents yet</span>');
  if (x.byOffice) out.push('<span class="tag blue">Office listing</span>');
  if (x.role === 'co') out.push('<span class="tag">You are a co-agent</span>');
  if (x.possibleDuplicate) out.push('<span class="tag red">Possible duplicate</span>');
  return out.join('');
}
const approvedOnce = x => !!(x.approvedOnce || (x.approval && x.approval.decision === 'approved'));
// Approved once, or an inventory property open to everyone: the way on is Live, never another approval.
const nextOf = x => {
  const open = approvedOnce(x) || (x.inInventory && !x.hidden);
  if ((x.stageKey === 'on_hold' || x.stageKey === 'dropped') && open) return ['live', 'Back on the market'];
  if (x.stageKey === 'media_ready' && open) return ['live', 'Mark Live'];
  return NEXT[x.stageKey];
};
function nextBtn(x, cls = 'btn sm') {
  const n = nextOf(x);
  if (n && x.role === 'co' && ['closed'].includes(n[0])) return '';
  if (!n || !stageByKey(n[0])) return x.stageKey === 'for_approval' ? '<span class="ml-wait">An admin decides next</span>' : '';
  return `<button type="button" class="${cls}${n[0] === 'for_approval' || n[0] === 'live' ? ' primary' : ''}" data-next="${esc(x.id)}">${esc(n[1])} <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>`;
}
function cardHtml(x) {
  const meta = [x.location, x.config || x.propType, x.askingPrice].filter(Boolean).join(' · ');
  const need = needs(x);
  const code = x.propertyCode || x.draftCode;
  return `<article class="ml-card${late(x) ? ' late' : ''}" data-id="${esc(x.id)}">
    <div class="ml-ctop">${code ? `<span class="ml-code">${esc(code)}</span>` : '<span class="ml-code none">No code yet</span>'}<span class="ml-age${late(x) ? ' warn' : ''}" title="Days in this stage">${daysIn(x) ? daysIn(x) + 'd here' : 'today'}</span></div>
    <button type="button" class="ml-title" data-open="${esc(x.id)}">${esc(x.title || 'Untitled listing')}</button>
    ${meta ? `<div class="ml-meta">${esc(meta)}</div>` : ''}
    ${chips(x) ? `<div class="ml-tags">${chips(x)}</div>` : ''}
    ${need ? `<div class="ml-need"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i> ${esc(need)}</div>` : ''}
    <div class="ml-acts">${nextBtn(x)}<button type="button" class="btn sm quiet" data-open="${esc(x.id)}">Open</button></div>
  </article>`;
}
function boardHtml(list) {
  const cols = D.stages.filter(s => !['on_hold', 'dropped'].includes(s.key));
  const paused = list.filter(x => x.stageKey === 'on_hold' || x.stageKey === 'dropped');
  return `<div class="ml-board" role="region" aria-label="Board — scroll sideways for more stages" tabindex="0">${cols.map(s => {
    const items = list.filter(x => x.stageKey === s.key);
    return `<section class="ml-col${s.key === 'for_approval' ? ' gate' : ''}${items.length ? '' : ' empty'}" aria-label="${esc(s.name)}">
      <header class="ml-col-h"><span class="ml-dot" style="background:${esc(s.color || '#999')}"></span><b>${esc(s.name)}</b><span class="ml-n">${items.length}</span></header>
      <p class="ml-rule">${esc(s.rule || '')}</p>
      <div class="ml-col-b">${items.length ? items.map(cardHtml).join('') : '<p class="ml-none">Nothing here</p>'}</div>
    </section>`;
  }).join('')}${paused.length ? `<section class="ml-col paused" aria-label="On hold or dropped"><header class="ml-col-h"><span class="ml-dot" style="background:#64748B"></span><b>On hold / Dropped</b><span class="ml-n">${paused.length}</span></header><div class="ml-col-b">${paused.map(cardHtml).join('')}</div></section>` : ''}</div>`;
}
function listHtml(list) {
  const rank = k => { const i = D.stages.findIndex(s => s.key === k); return i < 0 ? 99 : i; };
  const rows = list.slice().sort((a, b) => (!!needs(b) - !!needs(a)) || rank(a.stageKey) - rank(b.stageKey) || (b.updatedAt || 0) - (a.updatedAt || 0));
  return `<div class="card ml-list">${rows.length ? rows.map(x => {
    const s = stageByKey(x.stageKey) || {};
    const need = needs(x);
    return `<div class="ml-row" data-id="${esc(x.id)}">
      <div class="ml-row-main"><button type="button" class="ml-title" data-open="${esc(x.id)}">${esc(x.title || 'Untitled listing')}</button>
        <div class="ml-meta">${esc([x.propertyCode || x.draftCode, x.location, x.config || x.propType, x.askingPrice].filter(Boolean).join(' · '))}</div>
        ${chips(x) ? `<div class="ml-tags">${chips(x)}</div>` : ''}
        ${need ? `<div class="ml-need"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i> ${esc(need)}</div>` : ''}</div>
      <div class="ml-row-stage"><span class="ml-pill" style="--c:${esc(s.color || '#999')}">${esc(s.name || x.stageKey)}</span><small>${daysIn(x) ? daysIn(x) + ' days' : 'today'}</small></div>
      <div class="ml-row-act">${nextBtn(x)}</div>
    </div>`;
  }).join('') : '<div class="empty">Nothing matches.</div>'}</div>`;
}

// ── Moving a card ──
async function move(x, key, extra = {}) {
  if (key === 'for_approval') return sendForApproval(x);
  if (key === 'on_hold' || key === 'dropped') return askReason(x, key);
  if (key === 'closed' && !extra.availability) return askClosed(x);
  if (key === 'shoot_scheduled' && !x.shootAt && !extra.skipDate) return askShootDate(x);
  try {
    await api('listing-stage', { id: x.id, key, ...extra });
    toast(`${x.title || 'Listing'} → ${stageName(key)}`);
    await load();
  } catch (e) {
    toast('✗ ' + e.message);
    if (e.body && e.body.gaps) openDetail(x.id);
  }
}
function sendForApproval(x) {
  const gaps = [];
  if (!x.title) gaps.push('a title'); if (!x.location) gaps.push('the area'); if (!x.config && !x.propType) gaps.push('the BHK or type');
  if (!x.deal) gaps.push('sale or rent'); if (!x.askingPrice) gaps.push('the price'); if (!x.photosLink) gaps.push('the photos link');
  openSheet(`<h3>Send for approval</h3><p class="sub">${esc(x.title || '')}</p>
    ${gaps.length ? `<div class="callout warn">Add ${esc(gaps.join(', '))} first — open the listing and fill them in.</div>` : '<p class="note">An admin checks it. Once approved it joins the inventory, and you mark it Live when marketing starts.</p>'}
    <div class="field"><label for="apNote">Note for the admin (optional)</label><textarea id="apNote" maxlength="500" placeholder="e.g. Owner wants it live by Friday"></textarea></div>
    <p class="err" id="apErr"></p>
    <div class="bar"><button type="button" class="btn" data-close>Cancel</button>${gaps.length ? `<button type="button" class="btn primary block" id="apFix">Fill in the details</button>` : `<button type="button" class="btn primary block" id="apGo">Send for approval</button>`}</div>`,
  { label: 'Send for approval', onOpen: (sh, close) => {
    const fix = sh.querySelector('#apFix');
    if (fix) fix.addEventListener('click', async () => { await close(); openDetail(x.id, { edit: true }); });
    const go = sh.querySelector('#apGo');
    if (go) go.addEventListener('click', () => busy(go, async () => {
      try { await api('listing-stage', { id: x.id, key: 'for_approval', note: sh.querySelector('#apNote').value.trim() }); close(); toast('Sent for approval — an admin decides'); await load(); }
      catch (e) { sh.querySelector('#apErr').textContent = e.message; }
    }));
  } });
}
function askReason(x, key) {
  const reasons = key === 'on_hold' ? D.holdReasons : D.dropReasons;
  openSheet(`<h3>${key === 'on_hold' ? 'Put on hold' : 'Drop this listing'}</h3><p class="sub">${esc(x.title || '')}</p>
    <fieldset class="pick" id="rs"><legend class="sr">Why</legend>${Object.entries(reasons || {}).map(([k, l], i) => `<label><input type="radio" name="rs" value="${esc(k)}"${i === 0 ? ' checked' : ''}> ${esc(l)}</label>`).join('')}</fieldset>
    <p class="err" id="rsErr"></p>
    <div class="bar"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary block" id="rsGo">${key === 'on_hold' ? 'Put on hold' : 'Drop it'}</button></div>`,
  { label: 'Why', onOpen: (sh, close) => {
    sh.querySelector('#rsGo').addEventListener('click', () => busy(sh.querySelector('#rsGo'), async () => {
      const r = sh.querySelector('input[name=rs]:checked');
      try { await api('listing-stage', { id: x.id, key, reason: r && r.value }); close(); toast(`${x.title || 'Listing'} → ${stageName(key)}`); await load(); }
      catch (e) { sh.querySelector('#rsErr').textContent = e.message; }
    }));
  } });
}
function askClosed(x) {
  openSheet(`<h3>Deal done?</h3><p class="sub">${esc(x.title || '')}</p>
    <p class="note">It comes off the market for every other agent, and the office copies it to the inventory sheet.</p>
    <div class="bar"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn block" data-av="Let out">Rented</button><button type="button" class="btn primary block" data-av="Sold">Sold</button></div>`,
  { label: 'Sold or rented', onOpen: (sh, close) => {
    sh.querySelectorAll('[data-av]').forEach(b => b.addEventListener('click', () => busy(b, async () => {
      try { await api('listing-stage', { id: x.id, key: 'closed', availability: b.dataset.av }); close(); toast('Marked ' + (b.dataset.av === 'Sold' ? 'sold' : 'rented')); await load(); }
      catch (e) { toast('✗ ' + e.message); }
    })));
  } });
}
function askShootDate(x) {
  openSheet(`<h3>When is the shoot?</h3><p class="sub">${esc(x.title || '')}</p>
    <div class="field"><label for="sdAt">Date and time</label><input type="datetime-local" id="sdAt"></div>
    <p class="err" id="sdErr"></p>
    <div class="bar"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn" id="sdSkip">Not fixed yet</button><button type="button" class="btn primary block" id="sdGo">Save</button></div>`,
  { label: 'Shoot date', onOpen: (sh, close) => {
    sh.querySelector('#sdSkip').addEventListener('click', async () => { await close(); move(x, 'shoot_scheduled', { skipDate: true }); });
    sh.querySelector('#sdGo').addEventListener('click', () => busy(sh.querySelector('#sdGo'), async () => {
      const t = Date.parse(sh.querySelector('#sdAt').value);
      if (!t) { sh.querySelector('#sdErr').textContent = 'Pick the date, or press Not fixed yet'; return; }
      try { await api('listing-stage', { id: x.id, key: 'shoot_scheduled', shootAt: t }); close(); toast('Shoot booked for ' + when(t)); await load(); }
      catch (e) { sh.querySelector('#sdErr').textContent = e.message; }
    }));
  } });
}

// ── A listing's sheet: progress, details, brochure, approval, timeline ──
const SELLER_KEYS = ['sellerName', 'sellerPhone'];
const INV_KEYS = ['title', 'location', 'config', 'propType', 'askingPrice', 'sqft', 'uds', 'photosLink'];
const FIELD_ROWS = [
  ['title', 'Title', 'text', 'e.g. 3 BHK Apartment, Anna Nagar'], ['location', 'Area', 'text', 'e.g. Anna Nagar West'],
  ['config', 'BHK', 'text', 'e.g. 3 BHK'], ['propType', 'Type', 'text', 'e.g. Apartment'], ['askingPrice', 'Price', 'text', 'e.g. ₹1.8 Cr'],
  ['sqft', 'Size (sq ft)', 'text', 'e.g. 1,450'], ['uds', 'UDS (sq ft)', 'text', ''],
  ['sellerName', 'Owner’s name', 'text', ''], ['sellerPhone', 'Owner’s number', 'tel', ''], ['photosLink', 'Photos link (Google Drive)', 'url', 'https://'],
];
function stepper(x) {
  const ladder = D.stages.filter(s => !['closed', 'on_hold', 'dropped'].includes(s.key));
  const at = ladder.findIndex(s => s.key === x.stageKey);
  return `<ol class="ml-steps" aria-label="Progress">${ladder.map((s, i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}"${i === at ? ' aria-current="step"' : ''}><span>${esc(s.name.replace(/ — marketing$/, ''))}</span></li>`).join('')}</ol>`;
}
function openDetail(id, { edit = false } = {}) {
  const x = D.listings.find(l => l.id === id);
  if (!x) { toast('That listing is not one of yours, or it is gone'); return; }
  const a = x.approval || {};
  // What this person may move it to (the server checks the same): never Approved (an admin's), Live
  // only once approved or for an inventory property open to everyone, Sold only from Approved/Live,
  // and a co-agent never pauses, drops or closes it.
  const approvedBefore = approvedOnce(x);
  const openInInventory = x.inInventory && !x.hidden;
  const moves = D.stages.filter(s => s.key !== x.stageKey && s.key !== 'approved'
    && !(s.key === 'live' && x.stageKey !== 'approved' && !approvedBefore && !openInInventory)
    && !(s.key === 'closed' && !['approved', 'live'].includes(x.stageKey) && !approvedBefore && !openInInventory)
    && !(x.role === 'co' && ['on_hold', 'dropped', 'closed'].includes(s.key))
    && !((approvedBefore || openInInventory) && ['new_listing', 'for_approval'].includes(s.key)));
  const lockInv = x.inInventory && (x.role === 'co' || !D.canEditInventory);
  const back = x.stageKey === 'details' && a.decision === 'returned';
  openSheet(`
    <div class="ml-sh-top"><span class="ml-code${x.propertyCode || x.draftCode ? '' : ' none'}">${esc(x.propertyCode || x.draftCode || 'No code yet')}</span><span class="ml-pill" style="--c:${esc((stageByKey(x.stageKey) || {}).color || '#999')}">${esc(stageName(x.stageKey))}</span></div>
    <h3>${esc(x.title || 'Untitled listing')}</h3>
    <p class="sub">${esc([x.location, x.config || x.propType, x.askingPrice].filter(Boolean).join(' · '))}${x.stageChangedAt ? ' · in this stage ' + esc(ago(x.stageChangedAt).replace(/ ago$/, '')) : ''}</p>
    ${stepper(x)}
    ${back ? `<div class="callout warn"><b>Sent back by ${esc(a.decidedByName || 'an admin')}</b> ${esc(ago(a.decidedAt))}: “${esc(a.note || '')}”. Fix it, then send it for approval again.</div>` : ''}
    ${x.stageKey === 'approved' ? `<div class="callout"><b>Approved by ${esc(a.decidedByName || 'an admin')}</b> ${esc(ago(a.decidedAt))}${a.note ? ': “' + esc(a.note) + '”' : ''}. Mark it Live when marketing starts — other agents see it from then.</div>` : ''}
    ${x.stageKey === 'for_approval' ? `<div class="callout">Sent for approval ${esc(ago(a.sentAt || x.stageChangedAt))} — waiting for an admin.</div>` : ''}
    ${x.virtual ? `<div class="callout">This property is in the inventory with you as its agent. Move it here to track its work; its details are edited by the office.</div>` : ''}
    <div class="ml-sh-acts">${nextBtn(x, 'btn')}
      <label class="ml-move"><span>Move to</span><select id="dMove" aria-label="Move to another stage"><option value="">Choose a stage…</option>${moves.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('')}</select></label>
      ${x.propertyId ? `<a class="btn sm quiet" href="dashboard.html?property=${encodeURIComponent(x.propertyId)}">Property page</a>` : ''}
    </div>
    ${x.virtual ? '' : `
    <details class="ml-sec" id="dEditSec"${edit || back || !x.title ? ' open' : ''}><summary>Details</summary>
      ${x.inInventory ? `<p class="note">${lockInv ? (x.role === 'co' ? 'Its title, price, area and type are what the inventory says — its primary agent or the office changes them.' : 'Its title, price, area and type are what the inventory says — changing them isn’t part of your access; ask an admin.') : 'It is in the inventory: a change to its title, price, area or type goes there too, and the office copies it to the sheet.'}</p>` : ''}
      <div class="two">${FIELD_ROWS.filter(([k]) => !(x.contactHidden && SELLER_KEYS.includes(k))).map(([k, l, t, ph]) => `<div class="field"><label for="f_${k}">${l}</label><input type="${t === 'url' ? 'text' : t}" id="f_${k}" value="${esc(x[k] || '')}" placeholder="${esc(ph)}"${t === 'url' ? ' inputmode="url"' : ''}${lockInv && INV_KEYS.includes(k) ? ' readonly aria-readonly="true"' : ''}></div>`).join('')}
        <div class="field"><label for="f_deal">Sale or rent</label><select id="f_deal"${lockInv ? ' disabled' : ''}><option value="">—</option><option value="sale"${x.deal === 'sale' ? ' selected' : ''}>Sale</option><option value="rent"${x.deal === 'rent' ? ' selected' : ''}>Rent</option></select></div>
        <div class="field"><label for="f_shootAt">Shoot</label><input type="datetime-local" id="f_shootAt" value="${x.shootAt ? esc(localInput(x.shootAt)) : ''}"></div>
      </div>
      <fieldset class="ml-checks"><legend>Owner and media</legend>
        <label><input type="checkbox" id="f_ownerInformed"${x.ownerInformed ? ' checked' : ''}> Owner agreed to list with us</label>
        <label><input type="checkbox" id="f_ownerApproved"${x.ownerApproved ? ' checked' : ''}> Owner approved the photos</label>
        <label><input type="checkbox" id="f_m_photos"${x.media && x.media.photos ? ' checked' : ''}> Photos in hand</label>
        <label><input type="checkbox" id="f_m_video"${x.media && x.media.video ? ' checked' : ''}> Video in hand</label>
        <label><input type="checkbox" id="f_m_floorPlan"${x.media && x.media.floorPlan ? ' checked' : ''}> Floor plan in hand</label>
      </fieldset>
      <div class="field"><label for="f_remarks">Notes (only you and the office)</label><textarea id="f_remarks" maxlength="2000">${esc(x.remarks || '')}</textarea></div>
      <p class="err" id="fErr"></p>
      <div class="bar"><button type="button" class="btn primary" id="fSave">Save details</button></div>
    </details>
    <details class="ml-sec"${x.brochure && x.brochure.state === 'none' && ['shoot_done', 'media_ready'].includes(x.stageKey) ? ' open' : ''}><summary>Brochure <span class="ml-sum">${x.brochure.state === 'created' ? 'ready' : x.brochure.state === 'requested' ? 'asked for' : 'not asked yet'}</span></summary>
      ${x.brochure.state === 'created' ? `<p><a class="btn sm" href="${esc(x.brochure.link)}" target="_blank" rel="noopener"><i class="fa-regular fa-file-lines" aria-hidden="true"></i> Open the brochure</a></p>`
        : x.brochure.state === 'requested' ? `<p class="note">Asked for ${esc(ago(x.brochure.at))}${x.brochure.code ? ' under the code <b>' + esc(x.brochure.code) + '</b>' : ''}. The office builds it and the link shows here.</p>`
        : `<p class="note">The office builds it from the photos link and this write-up (what you would send a buyer on WhatsApp).</p>
           <div class="field"><label for="bDesc">Write-up for the brochure</label><textarea id="bDesc" maxlength="4000" rows="6" placeholder="🏡 3 BHK FOR SALE | …&#10;▪️ 1,450 Sq.Ft. …&#10;💰 Price …">${esc(x.description || '')}</textarea></div>
           <p class="err" id="bErr"></p><div class="bar"><button type="button" class="btn" id="bGo"><i class="fa-regular fa-file-lines" aria-hidden="true"></i> Ask for the brochure</button></div>`}
    </details>`}
    <details class="ml-sec" id="dHist"><summary>Timeline</summary><div id="dHistBody"><div class="sk-line"></div><div class="sk-line"></div></div></details>
    ${CLOSED_KEYS.includes(x.stageKey) || x.role === 'co' ? '' : `<div class="ml-sh-foot"><button type="button" class="btn sm quiet" data-pause="on_hold">Put on hold</button><button type="button" class="btn sm quiet danger" data-pause="dropped">Drop</button></div>`}
    <div class="bar"><button type="button" class="btn block" data-close>Close</button></div>`,
  { label: x.title || 'Listing', wide: true, url: 'mylistings.html?id=' + encodeURIComponent(x.id), focus: false, onOpen: (sh, close) => {
    const q = s => sh.querySelector(s);
    // On a phone the progress bar scrolls: show the current step.
    const steps = q('.ml-steps'), nowStep = steps && steps.querySelector('li.now');
    if (steps && nowStep) steps.scrollLeft = Math.max(0, nowStep.offsetLeft - steps.offsetLeft - steps.clientWidth / 2 + nowStep.offsetWidth / 2);
    const nb = sh.querySelector('[data-next]');
    if (nb) nb.addEventListener('click', async () => { await close(); move(x, nextOf(x)[0]); });
    q('#dMove').addEventListener('change', async e => { const k = e.target.value; if (!k) return; await close(); move(x, k); });
    sh.querySelectorAll('[data-pause]').forEach(b => b.addEventListener('click', async () => { await close(); move(x, b.dataset.pause); }));
    if (q('#fSave')) q('#fSave').addEventListener('click', () => busy(q('#fSave'), async () => {
      // Only what changed is sent (a field shown from the inventory is not copied onto the listing,
      // and a field not shown is never sent).
      const fields = {};
      FIELD_ROWS.forEach(([k]) => { const el = q('#f_' + k); if (!el || el.readOnly) return; const v = el.value.trim(); if (v !== String(x[k] || '')) fields[k] = v; });
      if (!lockInv && q('#f_deal').value !== String(x.deal || '')) fields.deal = q('#f_deal').value;
      if (q('#f_remarks').value.trim() !== String(x.remarks || '')) fields.remarks = q('#f_remarks').value.trim();
      const t = Date.parse(q('#f_shootAt').value) || null;
      const minute = v => (v ? Math.floor(v / 60000) : null);
      if (minute(t) !== minute(x.shootAt)) fields.shootAt = t;
      if (q('#f_ownerInformed').checked !== !!x.ownerInformed) fields.ownerInformed = q('#f_ownerInformed').checked;
      if (q('#f_ownerApproved').checked !== !!x.ownerApproved) fields.ownerApproved = q('#f_ownerApproved').checked;
      const media = { photos: q('#f_m_photos').checked, video: q('#f_m_video').checked, floorPlan: q('#f_m_floorPlan').checked };
      if (['photos', 'video', 'floorPlan'].some(k => media[k] !== !!(x.media && x.media[k]))) fields.media = media;
      if (!Object.keys(fields).length) { toast('Nothing changed'); return; }
      try { const j = await api('listing-save', { id: x.id, fields }); sh.dataset.done = '1'; toast(j.inventory ? 'Saved — the inventory too' : 'Saved'); await load(); openDetail(x.id); }
      catch (e) { q('#fErr').textContent = e.message; }
    }));
    if (q('#bGo')) q('#bGo').addEventListener('click', () => busy(q('#bGo'), async () => {
      try { const j = await api('listing-brochure', { id: x.id, description: q('#bDesc').value.trim() }); sh.dataset.done = '1'; toast('Brochure asked for — code ' + j.code); await load(); openDetail(x.id); }
      catch (e) { q('#bErr').textContent = e.message; }
    }));
    q('#dHist').addEventListener('toggle', () => {
      if (!q('#dHist').open || q('#dHist').dataset.got) return;
      q('#dHist').dataset.got = '1';
      if (x.virtual) { q('#dHistBody').innerHTML = '<p class="note">Nothing yet — its timeline starts with its first move here.</p>'; return; }
      api('listing-history', { id: x.id }).then(j => {
        q('#dHistBody').innerHTML = (j.items || []).length ? `<ul class="ml-tl">${j.items.map(h => `<li><span>${h.text}</span><small>${esc(when(h.at))}</small></li>`).join('')}</ul>` : '<p class="note">Nothing yet.</p>';
      }).catch(e => { q('#dHistBody').innerHTML = `<p class="err">${esc(e.message)}</p>`; });
    });
  } });
}
const localInput = t => { const d = new Date(t); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

// ── A new listing ──
function openAdd() {
  openSheet(`<h3>New listing</h3><p class="sub">A property you are bringing in. It starts as a New listing; you move it on as the work gets done, and an admin approves it before it goes Live.</p>
    <div class="two">${FIELD_ROWS.map(([k, l, t, ph]) => `<div class="field"><label for="n_${k}">${l}${k === 'title' ? ' *' : ''}</label><input type="${t === 'url' ? 'text' : t}" id="n_${k}" placeholder="${esc(ph)}"${t === 'url' ? ' inputmode="url"' : ''}${k === 'title' ? ' required' : ''}></div>`).join('')}
      <div class="field"><label for="n_deal">Sale or rent</label><select id="n_deal"><option value="">—</option><option value="sale">Sale</option><option value="rent">Rent</option></select></div>
    </div>
    <div class="field"><label for="n_remarks">Notes (only you and the office)</label><textarea id="n_remarks" maxlength="2000"></textarea></div>
    <p class="err" id="nErr"></p>
    <div class="bar"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary block" id="nGo">Add listing</button></div>`,
  { label: 'New listing', onOpen: (sh, close) => {
    const q = s => sh.querySelector(s);
    q('#nGo').addEventListener('click', () => busy(q('#nGo'), async () => {
      const fields = Object.fromEntries(FIELD_ROWS.map(([k]) => [k, q('#n_' + k).value.trim()]));
      fields.deal = q('#n_deal').value; fields.remarks = q('#n_remarks').value.trim();
      if (!fields.title) { q('#nErr').textContent = 'Give it a title'; q('#n_title').focus(); return; }
      try { const j = await api('listing-save', { fields }); close(); toast(j.possibleDuplicate ? 'Added — the same owner or title may already be with us; an admin will check' : 'Listing added'); await load(); openDetail(j.id); }
      catch (e) { q('#nErr').textContent = e.message; }
    }));
  } });
}

// ── Wiring ──
$('main').addEventListener('click', e => {
  const c = e.target.closest('[data-chip]'); if (c) { chip = c.dataset.chip; draw(); return; }
  const v = e.target.closest('[data-view]'); if (v) { view = v.dataset.view; try { localStorage.setItem(VIEW_KEY, view); } catch (x) { /* fine */ } draw(); return; }
  const o = e.target.closest('[data-open]'); if (o) { openDetail(o.dataset.open); return; }
  const n = e.target.closest('[data-next]');
  if (n) { const x = D.listings.find(l => l.id === n.dataset.next); if (x && nextOf(x)) busy(n, () => move(x, nextOf(x)[0])); return; }
  if (e.target.closest('[data-add]')) openAdd();
});
$('addBtn').addEventListener('click', openAdd);
let qT = null;
$('q').addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(draw, 120); });
// mylistings.html?id=… (from My Day): that listing's sheet at once.
let wanted = new URLSearchParams(location.search).get('id');
let wantNew = new URLSearchParams(location.search).get('new') === '1';
function openWanted() {
  // Handled once: the address loses ?new / ?id, so a reload or Back does not open it again.
  if (wantNew || wanted) { try { history.replaceState(history.state, '', 'mylistings.html'); } catch (e) { /* fine */ } }
  if (wantNew) { wantNew = false; if (D.canAdd) openAdd(); else toast('Adding properties isn’t part of your access — ask an admin'); }
  if (!wanted) return; const id = wanted; wanted = null; if (D.listings.some(l => l.id === id)) openDetail(id); else toast('That listing is not one of yours, or it is gone'); }
// Coming back to the page: fresh data (an admin may have approved meanwhile).
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && loaded && !document.querySelector('.sheet') && Date.now() - loadedAt > 2 * 60000) load(); });
load();
