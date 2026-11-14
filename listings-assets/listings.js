// ═══════ PROPERTIES FOR AGENTS (listings.html) ═══════
// The agent's copy of the inventory (agentViews, built by the server from the admin's settings):
//   Mine    properties where they are the primary agent or a co-agent — in full (as the settings
//           allow), with notes, availability and the buyers that match them
//   Shared  properties another agent or an admin opened to them through a request, while it runs
//   All     every active property: theirs, shared, and the rest as a summary with a lock and
//           "Request details"
// Admins and full-access staff use the Property dashboard instead; this page sends them there.
import { $, esc, lc, api, whenSignedIn, watchMyView, directory, nameOf, myLeads, when, ago, untilWords, toast, openSheet, busy } from '../shared-assets/agent-client.js';
import { PROPERTY_FIELDS } from '../shared-assets/agent-config.js';

const me = await whenSignedIn();
if (me.role !== 'agent') location.replace('dashboard.html');

window.AppNav.boot({ console: 'myprops', select: () => {}, signOut: () => import('../shared-assets/agent-client.js').then(m => m.signOutHere()) });
window.AppNav.setActive('myprops');

let view = null;          // agentViews document
let cfg = null;           // the agent's effective settings (from /api/agent me)
let people = [];
let tab = (() => { try { return sessionStorage.getItem('pin.props.tab') || 'mine'; } catch (e) { return 'mine'; } })();
let q = '';
const wanted = new URLSearchParams(location.search).get('id');
const numberTimers = new Set();   // properties whose owner's-number timer is already being watched
let openedWanted = false;

api('me').then(j => { cfg = j.config || null; $('addProp').hidden = !(cfg && cfg.actions && cfg.actions.addProperties); }).catch(() => {});
directory().then(p => { people = p; });

const watcher = watchMyView(me, (v, err) => {
  if (err && !v) {
    $('boot').innerHTML = `<div class="card empty"><i class="fa-solid fa-triangle-exclamation"></i>Couldn’t load your properties. ${esc(err.message || '')}<div class="bar" style="justify-content:center"><button class="btn" onclick="location.reload()">Try again</button></div></div>`;
    return;
  }
  if (!v) return;
  view = v;
  $('boot').hidden = true;
  $('app').hidden = false;
  render();
  // ?id= opens that property once — not again every time the copy refreshes.
  if (wanted && !openedWanted) {
    openedWanted = true;
    const p = view.props.find(x => String(x.id) === wanted);
    if (p) { if (!document.querySelector('.sheet')) { history.replaceState(null, '', location.pathname); openProperty(p); } }
    else toast('That property is not in your list — it may be sold, or not shared with you');
  }
});
$('refreshBtn').addEventListener('click', e => busy(e.currentTarget, async () => { watcher.refresh(); toast('Checking for changes…'); }));

$('tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  try { sessionStorage.setItem('pin.props.tab', tab); } catch (x) { /* private window */ }
  render();
});
$('q').addEventListener('input', e => { q = e.target.value.trim().toLowerCase(); render(); });

const isMine = p => p._access === 'own' || p._access === 'co';
const price = p => p.startingPrice || p.price || (p.priceInCr ? '₹' + p.priceInCr + ' Cr' : '');
const line = p => [p.config, price(p), p.zone].filter(Boolean).join(' · ');
const availTag = p => {
  const a = String(p.availability || '');
  if (!a) return '';
  const off = /\b(not|un)\s*-?available|sold|let out|rented|withdrawn|inactive/i.test(a);
  const cls = off ? 'red' : /^\s*(available|immediate|ready)/i.test(a) ? 'green' : 'wait';
  return `<span class="tag ${cls}">${esc(a)}</span>`;
};

function render() {
  const props = view.props || [];
  const mine = props.filter(isMine), granted = props.filter(p => p._access === 'granted');
  const counts = { mine: mine.length, granted: granted.length, all: props.length };
  document.querySelectorAll('#tabs [data-tab]').forEach(b => {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    b.innerHTML = { mine: 'Mine', granted: 'Shared', all: 'All' }[b.dataset.tab] + ` <span class="n" style="background:var(--bg2);color:var(--ink2)">${counts[b.dataset.tab]}</span>`;
  });
  $('tabNote').textContent = {
    mine: 'Properties you are the primary agent or a co-agent of.',
    granted: 'Properties opened to you through an approved request.',
    all: 'Every property on the market. Locked ones show a summary: tap one to ask for its details.',
  }[tab];
  let list = tab === 'mine' ? mine : tab === 'granted' ? granted : props;
  if (q) list = list.filter(p => [p.name, p.config, p.zone, p.type, p.startingPrice, p._code].join(' ').toLowerCase().includes(q));
  const matchN = id => (view.matches || []).filter(m => m.propertyId === String(id) && !m.requested).length;
  $('list').innerHTML = list.length ? list.map(p => {
    const locked = p._access === 'summary';
    const side = locked
      ? (p._pending ? '<span class="tag wait">Asked</span>' : '<span class="tag"><i class="fa-solid fa-lock"></i> Locked</span>')
      : p._access === 'granted' ? `<span class="tag blue">Shared · ${esc(untilWords(p._grant && p._grant.until))}</span>`
      : `${p._access === 'co' ? '<span class="tag">Co-agent</span>' : ''}${availTag(p)}${matchN(p.id) ? `<span class="tag brand">${matchN(p.id)} matching</span>` : ''}`;
    return `<div class="pcard${locked ? ' locked' : ''}" role="button" tabindex="0" data-id="${esc(p.id)}">
      <div class="ic"><i class="fa-${locked ? 'solid fa-lock' : 'regular fa-building'}"></i></div>
      <div class="bd"><b>${esc(p.name || p._code || 'Untitled property')}</b><small>${esc(line(p)) || '&nbsp;'}</small>
        ${locked && p._primaryName ? `<small>Agent: ${esc(p._primaryName)}</small>` : ''}</div>
      <div class="side">${side}</div></div>`;
  }).join('') : `<div class="empty"><i class="fa-regular fa-building"></i>${
    q ? 'Nothing matches that search.' : tab === 'mine' ? 'No properties are assigned to you yet. An admin assigns them on the Property dashboard.'
      : tab === 'granted' ? 'Nothing shared with you right now. Open a locked property in “All” and ask for its details.' : 'No properties to show.'}</div>`;
  $('built').textContent = view.builtAt ? 'Updated ' + ago(view.builtAt) + (view.trimmed ? ' · some summaries were left out (too many to send)' : '') : '';
  $('list').querySelectorAll('.pcard').forEach(el => {
    const open = () => openProperty(props.find(p => String(p.id) === el.dataset.id));
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
}

// ── One property ──
const LABELS = {
  name: 'Title', config: 'BHK', startingPrice: 'Price', price: 'Price', priceInCr: 'Price (Cr)', pricePerSqft: 'Price / sq ft',
  type: 'Type', propertyType: 'Property type', saleType: 'Sale type', dealType: 'Sale or rent', listingFor: 'For', zone: 'Locality',
  availability: 'Availability', soldOut: 'Sold out', propertyCode: 'Code', propertyId: 'Property ID', location: 'Address', nearby: 'Nearby',
  nearbyLandmark: 'Landmark', connectivity: 'Connectivity', mapLink: 'Map', sqftRange: 'Size (sq ft)', superBuiltupArea: 'Super built-up',
  carpetArea: 'Carpet area', builtupArea: 'Built-up area', plotSize: 'Plot size', uds: 'UDS', totalLandArea: 'Land area', facing: 'Facing',
  mainDoorFacing: 'Main door', floorNo: 'Floor', totalFloors: 'Total floors', bathrooms: 'Bathrooms', parking: 'Parking', parkingType: 'Parking type',
  furnishing: 'Furnishing', cornerUnit: 'Corner unit', vastu: 'Vastu', powerBackup: 'Power backup', ebGenerator: 'EB / generator',
  maintenance: 'Maintenance', totalUnits: 'Units', totalTowers: 'Towers', status: 'Status', constructionStage: 'Construction', possession: 'Possession',
  possessionDate: 'Possession date', propertyAge: 'Age', readyToMove: 'Ready to move', newOrResale: 'New / resale', approval: 'Approval',
  builder: 'Builder', highlights: 'Highlights', amenities: 'Amenities', sheetNotes: 'Notes from the sheet', contactName: 'Owner', contactNumber: 'Owner’s number',
  photosLink: 'Photos link', brochureLink: 'Brochure link', detailsText: 'WhatsApp share message',
  assignedAgent: 'Primary agent',
};
const ORDER = PROPERTY_FIELDS.flatMap(g => g.fields || []);
const isUrl = v => /^https?:\/\//i.test(String(v || '').trim());
function kvHtml(p) {
  const rows = [];
  ORDER.forEach(k => {
    if (['name', 'detailsText', 'photosLink', 'brochureLink', 'sheetExtras', 'secondaryAgents', 'secondaryAgent', 'geo', 'soldOut'].includes(k)) return;
    let v = p[k];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
    if (k === 'assignedAgent') v = p._primaryName || nameOf(people, v);
    if (Array.isArray(v)) v = v.join(', ');
    if (typeof v === 'object') return;
    if (k === 'contactNumber') { rows.push([LABELS[k], `<a href="tel:${esc(String(v).replace(/[^\d+]/g, ''))}">${esc(v)}</a>`]); return; }
    rows.push([LABELS[k] || k, isUrl(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener">Open</a>` : esc(v)]);
  });
  if (p._coNames && p._coNames.length) rows.push(['Co-agents', esc(p._coNames.join(', '))]);
  if (p.sheetExtras && typeof p.sheetExtras === 'object') Object.entries(p.sheetExtras).forEach(([k, v]) => { if (v != null && v !== '') rows.push([esc(k), esc(v)]); });
  return rows.length ? `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : '';
}

function openProperty(p) {
  if (!p) return;
  // The property's own link while it is open; Back closes it (agent-client's sheet adds the step).
  let url = location.href;
  try { const u = new URL(location.href); u.searchParams.set('id', p.id); url = u.toString(); } catch (e) { /* old browser */ }
  // The owner's number goes the moment its timer ends, open sheet or not.
  if (p._grant && p._grant.contactUntil && p._grant.contactUntil > Date.now() && !numberTimers.has(String(p.id))) {
    numberTimers.add(String(p.id));
    setTimeout(() => {
      numberTimers.delete(String(p.id)); watcher.refresh(); const sh = document.querySelector('.sheet'); if (sh && sh.dataset.pid === String(p.id)) { toast('The owner’s number is no longer shared with you'); import('../shared-assets/agent-client.js').then(m => m.closeSheet()); } }, Math.min(p._grant.contactUntil - Date.now() + 1000, 2147000000));
  }
  const locked = p._access === 'summary';
  const mine = isMine(p);
  const matches = (view.matches || []).filter(m => m.propertyId === String(p.id));
  const can = (cfg && cfg.actions) || {};
  const accessLine = {
    own: 'You are the primary agent.', co: 'You are a co-agent.',
    granted: `Shared with you · ${untilWords(p._grant && p._grant.until)}${p._grant && p._grant.contactUntil ? ' · owner’s number ' + untilWords(p._grant.contactUntil) : ''}`,
    summary: '',
  }[p._access];
  openSheet(`
    <div class="detail-h"><h3>${esc(p.name || p._code)}</h3><button type="button" class="btn sm" data-close aria-label="Close">✕</button></div>
    <p class="sub">${esc(line(p))}${accessLine ? ' · ' + esc(accessLine) : ''}</p>
    ${locked && p._refused ? `<div class="callout warn"><b>Not approved last time</b>${p._refused.by ? ' by ' + esc(p._refused.by) : ''}${p._refused.note ? ': “' + esc(p._refused.note) + '”' : ''}. You can ask again.</div>` : ''}
    ${locked && !p._refused ? `<div class="lockline"><i class="fa-solid fa-lock"></i><span>${p._pending ? 'You asked for its details — waiting for ' + (p._primaryName ? esc(p._primaryName) + ' (its agent) or an admin' : 'an admin') + '.' : 'Only this summary is open to you. Ask ' + (p._primaryName ? esc(p._primaryName) + ' (its agent) or an admin' : 'an admin') + ' for the details.'}</span></div>` : ''}
    ${kvHtml(p)}
    ${!locked && (p.photosLink || p.brochureLink || p.detailsText) ? `<div class="bar" style="flex-wrap:wrap">
      ${isUrl(p.photosLink) ? `<a class="btn sm" href="${esc(p.photosLink)}" target="_blank" rel="noopener"><i class="fa-regular fa-images"></i> Photos</a>` : ''}
      ${isUrl(p.brochureLink) ? `<a class="btn sm" href="${esc(p.brochureLink)}" target="_blank" rel="noopener"><i class="fa-regular fa-file-pdf"></i> Brochure</a>` : ''}
      ${p.detailsText ? `<button type="button" class="btn sm" id="pShare"><i class="fa-brands fa-whatsapp"></i> Copy share message</button>` : ''}
    </div>` : ''}
    ${mine && can.editOwnProperties ? `<div class="field"><label for="pAvail">Availability</label><select id="pAvail">${(() => {
      const raw = String(p.availability || '');
      const opts = ['Available', 'On hold', 'Booked', 'Sold', 'Let out'];
      const cur = opts.find(o => o.toLowerCase() === raw.trim().toLowerCase()) || '';
      return (raw && !cur ? `<option value="" selected disabled>${esc(raw)} (from the sheet)</option>` : !raw ? '<option value="" selected disabled>Pick one</option>' : '')
        + opts.map(a => `<option value="${a}"${cur === a ? ' selected' : ''}>${a}</option>`).join('');
    })()}</select></div>` : ''}
    ${matches.length ? `<div class="sec-h">Matching buyers <span class="n hot">${matches.length}</span></div>
      <p class="note">Leads with other agents (or nobody yet) whose requirement fits. Their name and number open once their agent or an admin approves.</p>
      ${matches.map(m => `<div class="match"><b>${esc(m.band || 'Match')}${m.pct ? ' · ' + m.pct + '%' : ''}</b>${m.name ? ' — ' + esc(m.name) : ''}
        ${m.requirement ? `<p>${esc(m.requirement)}</p>` : ''}${m.aiSummary ? `<p><i class="fa-solid fa-wand-magic-sparkles" style="color:var(--ink3)"></i> ${esc(m.aiSummary)}</p>` : ''}
        ${m.phone ? `<p><a href="tel:${esc(m.phone)}">${esc(m.phone)}</a></p>` : ''}
        <div class="bar" style="margin:10px 0 0;flex-wrap:wrap">${m.requested === 'pending' ? '<span class="tag wait">Asked — waiting</span>'
          : `${m.requested === 'rejected' ? '<span class="tag red" style="align-self:center">Not approved last time</span>' : ''}<button type="button" class="btn sm" data-askref="${esc(m.ref)}"><i class="fa-solid fa-unlock"></i> ${m.requested === 'rejected' || m.requested === 'cancelled' || m.requested === 'expired' ? 'Ask again' : 'Ask for their number'}</button>`}</div></div>`).join('')}` : ''}
    ${!locked && ((p._access !== 'granted' && (cfg ? (cfg.ownPropertyFields || []).includes('notes') : true)) || (p._access === 'granted' && cfg && (cfg.grantedPropertyFields || []).includes('notes'))) ? `<div class="sec-h">${p._access === 'granted' ? 'Notes from its agents' : 'Notes'}</div>
      ${mine && can.editOwnProperties ? `<div class="field"><textarea id="pNote" placeholder="Add a note about this property" maxlength="2000"></textarea><div class="bar" style="margin:8px 0 0;justify-content:flex-end"><button type="button" class="btn sm primary" id="pNoteGo">Add note</button></div></div>` : ''}
      <ul class="notes" id="pNotes"><li><div class="sk-line"></div></li></ul>` : ''}
    <div class="bar" style="flex-wrap:wrap">
      ${locked ? (p._pending ? `<span class="tag wait" style="align-self:center">You asked — waiting for a decision</span><button type="button" class="btn danger" data-cancelreq="${esc(p._pending)}">Cancel request</button>` : `<button type="button" class="btn primary block" id="pAsk"><i class="fa-solid fa-unlock"></i> ${p._refused ? 'Ask again' : 'Request details'}</button>`) : ''}
      ${p._access === 'granted' ? (p._pending ? '<span class="tag wait" style="align-self:center">You asked — waiting for a decision</span>'
        : `${p._grant && p._grant.until ? '<button type="button" class="btn" data-need="time"><i class="fa-regular fa-hourglass-half"></i> Ask for more time</button>' : ''}${p._grant && p._grant.contactUntil ? '' : '<button type="button" class="btn" data-need="number"><i class="fa-solid fa-phone"></i> Ask for the owner’s number</button>'}`) : ''}
      <button type="button" class="btn${locked ? '' : ' block'}" id="pMsg"><i class="fa-regular fa-comments"></i> ${mine ? 'Message the team about it' : 'Message its agent'}</button>
    </div>`, { label: p.name || 'Property', wide: true, url, onOpen: (sh, close) => {
      sh.dataset.pid = String(p.id);
      const qq = s => sh.querySelector(s);
      if (qq('#pShare')) qq('#pShare').addEventListener('click', async () => { try { await navigator.clipboard.writeText(p.detailsText); toast('Copied — paste it in WhatsApp'); } catch (e) { toast('Could not copy'); } });
      if (qq('#pAvail')) qq('#pAvail').addEventListener('change', e => {
        const v = e.target.value;
        // Sold or let out takes it off the market for every other agent: asked first.
        if ((v === 'Sold' || v === 'Let out') && !confirm(`Mark “${p.name || p._code}” as ${v.toLowerCase()}? Other agents stop seeing it, and it goes on “Changes to apply” for the sheet.`)) {
          e.target.value = (['Available', 'On hold', 'Booked', 'Sold', 'Let out'].find(o => o.toLowerCase() === String(p.availability || '').toLowerCase())) || ''; return;
        }
        api('property-availability', { id: p.id, availability: v }).then(() => {
          p.availability = v;
          const row = [...sh.querySelectorAll('.kv dt')].find(dt => dt.textContent === 'Availability');
          if (row && row.nextElementSibling) row.nextElementSibling.textContent = v;
          toast('Availability is now ' + v + '. The office copies it to the inventory sheet.');
          watcher.refresh();
        }).catch(err => { toast('✗ ' + err.message); e.target.value = p.availability || ''; });
      });
      if (qq('#pNotes')) loadNotes(p, qq('#pNotes'));
      if (qq('#pNoteGo')) qq('#pNoteGo').addEventListener('click', () => busy(qq('#pNoteGo'), async () => {
        const text = qq('#pNote').value.trim();
        if (!text) { qq('#pNote').focus(); return; }
        try { await api('property-note', { id: p.id, text }); qq('#pNote').value = ''; toast('Note added'); loadNotes(p, qq('#pNotes')); }
        catch (e) { toast('✗ ' + e.message); }
      }));
      sh.querySelectorAll('[data-askref]').forEach(b => b.addEventListener('click', () => askLead(b.dataset.askref, p)));
      if (qq('#pAsk')) qq('#pAsk').addEventListener('click', () => askProperty(p));
      sh.querySelectorAll('[data-need]').forEach(b => b.addEventListener('click', () => askMore(p, b.dataset.need)));
      sh.querySelectorAll('[data-cancelreq]').forEach(b => b.addEventListener('click', () => {
        if (!confirm('Cancel your request for this property’s details?')) return;
        busy(b, () => api('cancel', { id: b.dataset.cancelreq }).then(() => { toast('Request cancelled'); close(); }).catch(e => toast('✗ ' + e.message)));
      }));
      qq('#pMsg').addEventListener('click', () => busy(qq('#pMsg'), async () => {
        try { const t = await api('thread-open', { type: 'property', linkedId: p.id }); location.href = 'messages.html?t=' + encodeURIComponent(t.id); }
        catch (e) { toast('✗ ' + e.message); }
      }));
    } });
}

async function loadNotes(p, ul) {
  try {
    const j = await api('property-notes', { id: p.id });
    const li = n => `<li>${esc(n.text)}<small>${esc(nameOf(people, n.author || n.by))} · ${esc(when(n.createdAt))}</small></li>`;
    ul.innerHTML = ((j.notes || []).length ? j.notes.map(li).join('') : '<li class="empty" style="background:none">No notes yet.</li>')
      + ((j.internal || []).length ? '<li style="background:none;padding:6px 0 0"><b><i class="fa-solid fa-lock" style="color:var(--ink3)"></i> Office-only notes</b></li>' + j.internal.map(li).join('') : '');
  } catch (e) { ul.innerHTML = `<li>${esc(e.message)}</li>`; }
}

// ── Asking ──
function askProperty(p) {
  openSheet(`
    <h3>Request details</h3>
    <p class="sub">${esc(p.name || p._code)} · ${esc(line(p))}</p>
    <div class="field"><label for="aClient">For which client</label><select id="aClient"><option value="">Loading your leads…</option></select></div>
    <div class="field"><label for="aReason">Why (the approver sees this)</label><textarea id="aReason" maxlength="500" placeholder="e.g. My client wants a 3 BHK here; can visit this weekend"></textarea></div>
    <div class="field"><label for="aVisit">Preferred site visit (optional)</label><input type="datetime-local" id="aVisit"></div>
    <p class="note">${p._primaryName ? esc(p._primaryName) + ' (its agent) or an admin' : 'An admin'} decides. The first to decide wins; you’ll see it in My Day and Messages.</p>
    <p class="err" id="aErr"></p>
    <div class="bar"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary block" id="aGo">Send request</button></div>`,
  { label: 'Request details', onOpen: (sh, close) => {
    const qq = s => sh.querySelector(s);
    myLeads(me).then(ls => {
      ls.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      qq('#aClient').innerHTML = '<option value="">No particular client</option>' + ls.map(l => `<option value="${esc(l.id)}">${esc(l.name || l.phone || 'Unnamed lead')}</option>`).join('');
    }).catch(() => { qq('#aClient').innerHTML = '<option value="">No particular client</option>'; });
    qq('#aGo').addEventListener('click', () => busy(qq('#aGo'), async () => {
      const reason = qq('#aReason').value.trim();
      if (!reason) { qq('#aErr').textContent = 'Say why, so the approver can decide'; qq('#aReason').focus(); return; }
      try {
        await api('request', { kind: 'property', targetId: p.id, reason, clientLeadId: qq('#aClient').value || null, visitAt: Date.parse(qq('#aVisit').value) || null });
        toast('Request sent'); close();
      } catch (e) { qq('#aErr').textContent = e.message; }
    }));
  } });
}

// More time on a shared property, or its owner's number: a request to the same people.
function askMore(p, need) {
  openSheet(`
    <h3>${need === 'time' ? 'Ask for more time' : 'Ask for the owner’s number'}</h3>
    <p class="sub">${esc(p.name || p._code)} · ${need === 'time' ? 'details ' + esc(untilWords(p._grant && p._grant.until)) : 'shared with you without the number'}</p>
    <div class="field"><label for="mReason">Why (the approver sees this)</label><textarea id="mReason" maxlength="500" placeholder="${need === 'time' ? 'e.g. The client wants a second visit next week' : 'e.g. The client is ready to meet the owner'}"></textarea></div>
    <p class="err" id="mErr"></p>
    <div class="bar"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary block" id="mGo">Send request</button></div>`,
  { label: need === 'time' ? 'Ask for more time' : 'Ask for the owner’s number', onOpen: (sh, close) => {
    const qq = s => sh.querySelector(s);
    qq('#mGo').addEventListener('click', () => busy(qq('#mGo'), async () => {
      const reason = qq('#mReason').value.trim();
      if (!reason) { qq('#mErr').textContent = 'Say why, so the approver can decide'; return; }
      try { await api('request', { kind: 'property', targetId: p.id, need, reason }); toast('Request sent'); close(); }
      catch (e) { qq('#mErr').textContent = e.message; }
    }));
  } });
}

function askLead(ref, p) {
  openSheet(`
    <h3>Ask for this buyer’s details</h3>
    <p class="sub">A matching buyer for ${esc(p.name || p._code)}</p>
    <div class="field"><label for="lReason">Why (their agent sees this)</label><textarea id="lReason" maxlength="500" placeholder="e.g. My 2 BHK in Adyar fits exactly what they want"></textarea></div>
    <p class="note">Their agent or an admin decides. Once approved, the lead shows in your CRM with their name and number.</p>
    <p class="err" id="lErr"></p>
    <div class="bar"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary block" id="lGo">Send request</button></div>`,
  { label: 'Ask for the buyer', onOpen: (sh, close) => {
    const qq = s => sh.querySelector(s);
    qq('#lGo').addEventListener('click', () => busy(qq('#lGo'), async () => {
      const reason = qq('#lReason').value.trim();
      if (!reason) { qq('#lErr').textContent = 'Say why, so their agent can decide'; return; }
      try { await api('request', { kind: 'lead', ref, reason }); toast('Request sent'); close(); }
      catch (e) { qq('#lErr').textContent = e.message; }
    }));
  } });
}

// ── A property the agent sourced ──
$('addProp').addEventListener('click', () => {
  openSheet(`
    <h3>Add a property you sourced</h3>
    <p class="sub">An admin checks it before it joins the inventory, with you as its agent.</p>
    <div class="field"><label for="sName">Title</label><input type="text" id="sName" maxlength="200" placeholder="e.g. 3 BHK Apartment, Anna Nagar"></div>
    <div class="two">
      <div class="field"><label for="sConfig">BHK</label><input type="text" id="sConfig" maxlength="40" placeholder="e.g. 3 BHK"></div>
      <div class="field"><label for="sPrice">Price</label><input type="text" id="sPrice" maxlength="60" placeholder="e.g. ₹1.8 Cr"></div>
      <div class="field"><label for="sType">Type</label><input type="text" id="sType" maxlength="60" placeholder="e.g. Apartment"></div>
      <div class="field"><label for="sZone">Locality</label><input type="text" id="sZone" maxlength="80" placeholder="e.g. Anna Nagar"></div>
    </div>
    <div class="field"><label for="sLoc">Address</label><input type="text" id="sLoc" maxlength="300"></div>
    <div class="two">
      <div class="field"><label for="sOwner">Owner’s name</label><input type="text" id="sOwner" maxlength="80"></div>
      <div class="field"><label for="sPhone">Owner’s number</label><input type="tel" id="sPhone" maxlength="20"></div>
    </div>
    <div class="field"><label for="sPhotos">Photos link (optional)</label><input type="text" id="sPhotos" maxlength="300" placeholder="https://"></div>
    <div class="field"><label for="sNotes">Notes</label><textarea id="sNotes" maxlength="2000"></textarea></div>
    <p class="err" id="sErr"></p>
    <div class="bar"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary block" id="sGo">Send for approval</button></div>`,
  { label: 'Add a property', onOpen: (sh, close) => {
    const v = id => sh.querySelector(id).value.trim();
    sh.querySelector('#sGo').addEventListener('click', () => busy(sh.querySelector('#sGo'), async () => {
      if (!v('#sName')) { sh.querySelector('#sErr').textContent = 'Give it a title'; return; }
      try {
        const r = await api('property-submit', { fields: { name: v('#sName'), config: v('#sConfig'), startingPrice: v('#sPrice'), type: v('#sType'), zone: v('#sZone'),
          location: v('#sLoc'), contactName: v('#sOwner'), contactNumber: v('#sPhone'), photosLink: v('#sPhotos'), notes: v('#sNotes') } });
        toast(r.possibleDuplicate ? 'Sent — note: this owner or title may already be with us; an admin will check' : 'Sent — an admin will approve it'); close();
      } catch (e) { sh.querySelector('#sErr').textContent = e.message; }
    }));
  } });
});

// Export what the agent can see (when their settings allow it): the list on screen, as a CSV of
// exactly the fields their copy holds — nothing the page was not given.
function downloadList() {
  const props = view.props || [];
  let list = tab === 'mine' ? props.filter(isMine) : tab === 'granted' ? props.filter(p => p._access === 'granted') : props;
  if (q) list = list.filter(p => [p.name, p.config, p.zone, p.type, p.startingPrice, p._code].join(' ').toLowerCase().includes(q));
  const keys = ORDER.filter(k => list.some(p => p[k] != null && p[k] !== '' && typeof p[k] !== 'object'));
  const cell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = [['Access', ...keys.map(k => LABELS[k] || k)].map(cell).join(',')]
    .concat(list.map(p => [{ own: 'Mine', co: 'Co-agent', granted: 'Shared', summary: 'Summary' }[p._access], ...keys.map(k => k === 'assignedAgent' ? (p._primaryName || p[k]) : p[k])].map(cell).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + rows.join('\n')], { type: 'text/csv' }));
  a.download = 'properties-' + tab + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
}
const dl = document.createElement('button');
dl.type = 'button'; dl.className = 'btn sm'; dl.hidden = true; dl.setAttribute('aria-label', 'Download this list'); dl.title = 'Download this list (CSV)';
dl.innerHTML = '<i class="fa-solid fa-download"></i>';
$('refreshBtn').before(dl);
dl.addEventListener('click', () => view && downloadList());
api('me').then(j => { dl.hidden = !(j.config && j.config.actions && j.config.actions.exportOwn); }).catch(() => {});
