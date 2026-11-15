// ═══════ THE PROPERTY DASHBOARD FOR AN AGENT ═══════
// The same dashboard the office uses, fed from the agent's own copy of the inventory (agentViews,
// built by the server from what an admin lets agents see — team.html → What agents see) instead of
// the properties themselves, which an agent's login cannot read (firestore.rules):
//   own / co   a property they are the primary or a co-agent of: in full, as the settings allow
//   granted    opened to them by an approved request, while it runs
//   summary    every other active property: a few fields, a lock, and "Request details"
// Their changes go through the server (/api/agent), which checks each one: availability and notes on
// their own properties, a property they sourced (an admin approves it), requests for the rest. What
// the dashboard does that is the office's — edit, delete, Sync from sheet, the change log, assigning
// agents — is not offered to them, and is refused here too if anything still asks.
// Loaded by dashboard-assets/firebase-sync.js only for an agent's login.
import { api, watchMyView, directory, nameOf as nameIn, myLeads, untilWords, openSheet, busy, esc } from '../shared-assets/agent-client.js';

const say = msg => (typeof window.showToast === 'function' ? window.showToast(msg) : console.log(msg));
const refuse = (what = 'That’s for the office — ask an admin') => Promise.reject(Object.assign(new Error(what), { code: 'agent-refused' }));
const isMine = p => !!p && (p._access === 'own' || p._access === 'co');
const price = p => p.startingPrice || p.price || (p.priceInCr ? '₹' + p.priceInCr + ' Cr' : '');
const line = p => [p.config, price(p), p.zone].filter(Boolean).join(' · ');
const AVAILABILITY = ['Available', 'On hold', 'Booked', 'Sold', 'Let out'];

export function start(me, { markLive } = {}) {
  const A = window.PinAgent = {
    me, cfg: null, view: null, people: [], isMine, line,
    can: k => !!(A.cfg && A.cfg.actions && A.cfg.actions[k]),
    nameOf: e => nameIn(A.people, e),
    until: untilWords,
  };
  document.documentElement.classList.add('as-agent');
  document.body.classList.add('agent-mode');
  const redraw = () => { if (typeof window.onPinAgentChange === 'function') window.onPinAgentChange(); };
  api('me').then(j => {
    A.cfg = j.config || null;
    document.body.classList.toggle('agent-can-add', A.can('addProperties'));
    document.body.classList.toggle('agent-can-export', A.can('exportOwn'));
    redraw();
  }).catch(() => {});
  directory().then(p => { A.people = p || []; redraw(); });

  // What the settings let this agent see of a property: the field groups of agent-config.js
  // (own / granted / other), as the server applied them when it built the copy.
  A.allows = (p, group) => {
    if (!p || !A.cfg) return false;
    const list = isMine(p) ? A.cfg.ownPropertyFields : p._access === 'granted' ? A.cfg.grantedPropertyFields : A.cfg.otherPropertyFields;
    return (list || []).includes(group);
  };
  A.canEdit = p => isMine(p) && A.can('editOwnProperties');
  A.matchesFor = id => ((A.view && A.view.matches) || []).filter(m => m.propertyId === String(id));

  // ── The data, live ──
  const watcher = watchMyView(me, (v, err) => {
    if (err && !v) { say('Couldn’t load your properties — ' + (err.message || 'try again')); return; }
    if (!v) return;
    A.view = v;
    if (markLive) markLive();
    window.applyPropertiesSnapshot((v.props || []).map(p => ({ ...p, id: String(p.id), propertyCode: p.propertyCode || p._code || '' })));
  });
  A.refresh = () => watcher.refresh();

  // ── What the dashboard asks of the database, answered for an agent ──
  const notesCache = new Map();   // id → { notes, internal } from the server (phones masked where the number is not theirs)
  const notesOf = id => {
    if (!notesCache.has(id)) {
      notesCache.set(id, api('property-notes', { id })
        .then(j => ({ notes: j.notes || [], internal: j.internal || [] }))
        .catch(e => { notesCache.delete(id); if (e.status === 403) return { notes: [], internal: [], denied: true }; throw e; }));
    }
    return notesCache.get(id);
  };
  Object.assign(window.dashboardFirebase, {
    isLive: () => !!A.view,
    saveProperty: () => refuse(),
    deleteProperty: () => refuse(),
    subscribeToProperty: () => () => {},
    getTeam: async () => (await directory()).map(p => p.email),
    setPropertyAgents: () => refuse(),
    getLeads: () => myLeads(me),
    getPropertyNotes: id => notesOf(id).then(x => x.notes),
    getInternalNotes: id => notesOf(id).then(x => x.internal),
    savePropertyNote: (id, note) => api('property-note', { id, text: note.text, kind: note.kind, eventDate: note.eventDate }).then(r => { notesCache.delete(id); return r; }),
    deletePropertyNote: () => refuse(),
    saveInternalNote: () => refuse(),
    deleteInternalNote: () => refuse(),
    saveChanges: () => Promise.resolve(),          // the server logs an agent's changes itself
    getChanges: () => Promise.resolve([]),
    sellerQueue: () => Promise.resolve([]),         // the Shoot & Media board is the office's
    propertyMarketing: () => Promise.resolve({ cards: [], posts: [] }),
    propertyUsage: () => refuse(),
    setChangeApplied: () => refuse(),
  });

  // ── On a property's page: who it belongs to, and what this agent can do with it ──
  A.agentsLine = p => {
    const primary = p._primaryName || (p.assignedAgent ? A.nameOf(p.assignedAgent) : '');
    const co = p._coNames && p._coNames.length ? p._coNames : (Array.isArray(p.secondaryAgents) ? p.secondaryAgents.map(A.nameOf) : []);
    if (!primary && !co.length) return '';
    return `<div class="dp-agent"><span class="dp-agent-l">Primary agent</span><b class="ag-name">${esc(primary || '—')}</b></div>`
      + (co.length ? `<div class="dp-agent dp-coagents"><span class="dp-agent-l">Co-agents</span><b class="ag-name">${esc(co.join(', '))}</b></div>` : '');
  };
  A.accessPanel = p => {
    const who = p._primaryName ? esc(p._primaryName) + ' (its agent) or an admin' : 'an admin';
    if (p._access === 'summary') {
      return `<div class="ag-panel locked">
        ${p._refused ? `<div class="ag-refused"><b>Not approved last time</b>${p._refused.by ? ' by ' + esc(p._refused.by) : ''}${p._refused.note ? ': “' + esc(p._refused.note) + '”' : ''}. You can ask again.</div>` : ''}
        <div class="ag-line"><i class="fa-solid fa-lock"></i><span>${p._pending ? 'You asked for its details — waiting for ' + who + '.' : 'Only this summary is open to you: the address, the owner and the full details open once ' + who + ' approves.'}</span></div>
        <div class="ag-acts">
          ${p._pending ? `<button type="button" class="ag-btn danger" data-ag="cancel" data-req="${esc(p._pending)}">Cancel my request</button>`
            : `<button type="button" class="ag-btn primary" data-ag="ask"><i class="fa-solid fa-unlock"></i> ${p._refused ? 'Ask again' : 'Request details'}</button>`}
          <button type="button" class="ag-btn" data-ag="msg"><i class="fa-regular fa-comments"></i> Message its agent</button>
        </div></div>`;
    }
    if (p._access === 'granted') {
      const g = p._grant || {};
      return `<div class="ag-panel granted">
        <div class="ag-line"><i class="fa-solid fa-lock-open"></i><span>Shared with you · details ${esc(untilWords(g.until))}${g.contactUntil ? ' · owner’s number ' + esc(untilWords(g.contactUntil)) : ' · without the owner’s number'}</span></div>
        <div class="ag-acts">
          ${p._pending ? `<span class="ag-tag wait">You asked — waiting for a decision</span><button type="button" class="ag-btn danger" data-ag="cancel" data-req="${esc(p._pending)}">Cancel my request</button>` : `${g.until ? '<button type="button" class="ag-btn" data-ag="time"><i class="fa-regular fa-hourglass-half"></i> Ask for more time</button>' : ''}${g.contactUntil ? '' : '<button type="button" class="ag-btn" data-ag="number"><i class="fa-solid fa-phone"></i> Ask for the owner’s number</button>'}`}
          <button type="button" class="ag-btn" data-ag="msg"><i class="fa-regular fa-comments"></i> Message its agent</button>
        </div></div>`;
    }
    const raw = String(p.availability || '');
    const cur = AVAILABILITY.find(o => o.toLowerCase() === raw.trim().toLowerCase()) || '';
    return `<div class="ag-panel mine">
      <div class="ag-line"><i class="fa-regular fa-building"></i><span>${p._access === 'co' ? 'You are a co-agent on this property.' : 'You are the primary agent.'}</span></div>
      <div class="ag-acts">
        ${A.canEdit(p) ? `<label class="ag-avail">Availability <select data-ag="avail" aria-label="Availability">${(raw && !cur ? `<option value="" selected disabled>${esc(raw)} (from the sheet)</option>` : !raw ? '<option value="" selected disabled>Pick one</option>' : '')
          + AVAILABILITY.map(a => `<option value="${a}"${cur === a ? ' selected' : ''}>${a}</option>`).join('')}</select></label>` : ''}
        <button type="button" class="ag-btn" data-ag="msg"><i class="fa-regular fa-comments"></i> Message the team about it</button>
      </div></div>`;
  };
  A.wire = (p, root) => {
    if (!root) return;
    const q = s => root.querySelector(s);
    if (q('[data-ag="ask"]')) q('[data-ag="ask"]').addEventListener('click', () => askProperty(p));
    root.querySelectorAll('[data-ag="time"], [data-ag="number"]').forEach(b => b.addEventListener('click', () => askMore(p, b.dataset.ag)));
    if (q('[data-ag="cancel"]')) q('[data-ag="cancel"]').addEventListener('click', e => {
      if (!confirm('Cancel your request for this property’s details?')) return;
      busy(e.currentTarget, () => api('cancel', { id: e.currentTarget.dataset.req }).then(() => { say('Request cancelled'); A.refresh(); }).catch(x => say('✗ ' + x.message)));
    });
    if (q('[data-ag="msg"]')) q('[data-ag="msg"]').addEventListener('click', e => busy(e.currentTarget, async () => {
      try { const t = await api('thread-open', { type: 'property', linkedId: p.id }); location.href = 'messages.html?t=' + encodeURIComponent(t.id); }
      catch (x) { say('✗ ' + x.message); }
    }));
    const sel = q('[data-ag="avail"]');
    if (sel) sel.addEventListener('change', () => {
      const v = sel.value, was = p.availability || '';
      // Sold or let out takes it off the market for every other agent: asked first.
      if ((v === 'Sold' || v === 'Let out') && !confirm(`Mark “${p.name || p._code}” as ${v.toLowerCase()}? Other agents stop seeing it, and it goes on the office’s “Changes to apply” for the sheet.`)) {
        sel.value = AVAILABILITY.find(o => o.toLowerCase() === String(was).toLowerCase()) || ''; return;
      }
      sel.disabled = true;
      api('property-availability', { id: p.id, availability: v })
        .then(() => { say('Availability is now ' + v + '. The office copies it to the inventory sheet.'); A.refresh(); })
        .catch(x => { say('✗ ' + x.message); sel.value = AVAILABILITY.find(o => o.toLowerCase() === String(was).toLowerCase()) || ''; })
        .finally(() => { sel.disabled = false; });
    });
  };
  // Buyers with other agents (or nobody yet) whose requirement fits one of the agent's own
  // properties: worked out by the server, without names or numbers, each with "Ask for their number".
  // (Drawn beside the match panel, not inside it: the panel redraws itself when opened up further.)
  A.otherMatches = (el, p, jumpEl) => {
    if (!el) return;
    el.innerHTML = ''; if (jumpEl) jumpEl.innerHTML = '';
    if (!isMine(p)) return;
    const list = A.matchesFor(p.id);
    const box = el;
    box.className = 'ag-matches';
    box.innerHTML = list.length ? `<div class="ag-matches-h">Buyers with other agents who match <span class="ag-n">${list.length}</span></div>
      <p class="ag-note">Their name and number open once their agent or an admin approves.</p>
      ${list.map(m => `<div class="ag-match"><b>${esc(m.band || 'Match')}${m.pct ? ' · ' + m.pct + '%' : ''}</b>${m.name ? ' — ' + esc(m.name) : ''}
        ${m.requirement ? `<p>${esc(m.requirement)}</p>` : ''}${m.aiSummary ? `<p class="ag-ai">${esc(m.aiSummary)}</p>` : ''}
        ${m.phone ? `<p><a href="tel:${esc(m.phone)}">${esc(m.phone)}</a></p>` : ''}
        <div class="ag-acts">${m.requested === 'pending' ? '<span class="ag-tag wait">Asked — waiting</span>'
          : `${m.requested === 'rejected' ? '<span class="ag-tag red">Not approved last time</span>' : ''}<button type="button" class="ag-btn" data-askref="${esc(m.ref)}"><i class="fa-solid fa-unlock"></i> ${['rejected', 'cancelled', 'expired'].includes(m.requested) ? 'Ask again' : 'Ask for their number'}</button>`}</div></div>`).join('')}` : '';
    if (!list.length) { box.className = ''; return; }
    box.querySelectorAll('[data-askref]').forEach(b => b.addEventListener('click', () => askLead(b.dataset.askref, p, b)));
    // At the top of the tab: they would otherwise sit below every one of the agent's own matches.
    if (jumpEl) {
      jumpEl.innerHTML = `<button type="button" class="ag-jump"><i class="fa-solid fa-arrow-down"></i> ${list.length} buyer${list.length === 1 ? '' : 's'} with other agents also match — see ${list.length === 1 ? 'it' : 'them'}</button>`;
      jumpEl.querySelector('button').addEventListener('click', () => box.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  };

  // ── Asking: a request to the property's agent (or an admin), first decision wins ──
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
          say('Request sent'); close(true); A.refresh();
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
        try { await api('request', { kind: 'property', targetId: p.id, need, reason }); say('Request sent'); close(true); A.refresh(); }
        catch (e) { qq('#mErr').textContent = e.message; }
      }));
    } });
  }
  function askLead(ref, p, btn) {
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
        try {
          await api('request', { kind: 'lead', ref, reason });
          if (btn && btn.isConnected) btn.outerHTML = '<span class="ag-tag wait">Asked — waiting</span>';   // at once, before the copy catches up
          say('Request sent'); close(true); A.refresh();
        }
        catch (e) { qq('#lErr').textContent = e.message; }
      }));
    } });
  }

  // ── A property the agent sourced: an admin checks it before it joins the inventory ──
  A.addProperty = () => {
    if (!A.can('addProperties')) { say('Adding properties isn’t part of your access — ask an admin'); return; }
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
          say(r.possibleDuplicate ? 'Sent — this owner or title may already be with us; an admin will check' : 'Sent — an admin will approve it'); close(true);
        } catch (e) { sh.querySelector('#sErr').textContent = e.message; }
      }));
    } });
  };
  // The owner's number goes the moment its timer ends: the copy is asked again then.
  let numberTimer = null;
  const watchNumbers = () => {
    clearTimeout(numberTimer);
    const next = Math.min(...((A.view && A.view.props) || []).map(p => (p._grant && p._grant.contactUntil > Date.now() ? p._grant.contactUntil : Infinity)), Infinity);
    if (next !== Infinity) numberTimer = setTimeout(() => A.refresh(), Math.min(next - Date.now() + 1000, 2147000000));
  };
  const prevApply = window.applyPropertiesSnapshot;
  window.applyPropertiesSnapshot = list => { prevApply(list); watchNumbers(); };
  return A;
}
