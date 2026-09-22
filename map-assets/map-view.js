// ═══════════════════════════════════════════════════════════════════════════
// THE MAP VIEW — the shell an agent actually works in
// ═══════════════════════════════════════════════════════════════════════════
//
// Module 4, and the only one that touches the page. It owns:
//
//   · the three-way view switch — List · Split · Map
//   · the draggable divider, and remembering where it was left
//   · list ⇄ map selection and hover, in both directions
//   · the answer panel: nearby properties, what is around, distance to
//   · the pins that are missing, and placing them
//
// Everything it draws comes from modules 1–3. It computes nothing itself.
//
// ── WHY THREE VIEWS AND NOT A TOGGLE ─────────────────────────────────────
//
// The three are genuinely different jobs, and an agent switches between them
// several times in one call:
//
//   List   scanning and comparing — the existing grid, untouched
//   Split  the working view: read a card, see where it is
//   Map    "show me the area" — the map full-bleed, list collapsed
//
// The divider is draggable between them and its position is remembered per
// browser, because where somebody wants it depends on their screen and they
// should only have to say so once.
//
// ── THE RULE THE WHOLE PANEL FOLLOWS ─────────────────────────────────────
//
// Every number shown here can end up being said out loud to a client in the
// next ten seconds. So a distance measured from a locality centroid is
// labelled as such, everywhere, every time — in the marker, in the card, in
// the nearby list and in the drive time. An agent who does not know a figure
// is approximate will quote it as if it were not.

(function (root) {
  'use strict';

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const LS_SPLIT = 'pin.map.split';
  const LS_MODE = 'pin.map.mode';

  const S = {
    mode: 'list',          // list | split | map
    split: 42,             // list width, percent
    mapApi: null,          // PinMapCore.create() handle
    loadState: null,       // the result of PinMapCore.load()
    items: [],             // [{ p, pos, priceLo, priceHi }]
    located: null,         // PinGeoResolve.locate() result
    selectedId: null,
    pinFor: null,          // the property a pin is being placed for
    pendingPin: null,      // {lat,lng} awaiting Save
    answer: null,          // the open answer panel: { kind, ... }
    host: null,            // callbacks into the page
    booted: false
  };

  // ═══════ BOOT ═══════

  /**
   * @param host {
   *   properties()       every property (for the area model / IDF corpus)
   *   filtered()         the properties currently passing the filters
   *   onOpenProperty(id) open the full detail panel
   *   savePatch(id,patch)persist a pin or a snooze
   *   user()             who is placing the pin
   *   onModeChange(mode)
   * }
   */
  function boot(host) {
    S.host = host;
    try {
      const m = localStorage.getItem(LS_MODE);
      if (m === 'split' || m === 'map') S.mode = m;
      const w = parseFloat(localStorage.getItem(LS_SPLIT));
      if (isFinite(w) && w >= 22 && w <= 78) S.split = w;
    } catch (e) { /* private window; defaults are fine */ }
    S.booted = true;
    hookSize();
    return api;
  }

  // ═══════ MODE ═══════

  function setMode(mode) {
    if (!['list', 'split', 'map'].includes(mode)) return;
    S.mode = mode;
    try { localStorage.setItem(LS_MODE, mode); } catch (e) {}
    applyMode();
    if (mode !== 'list') ensureMap();
    if (S.host && S.host.onModeChange) S.host.onModeChange(mode);
  }

  const NARROW = () => root.matchMedia && root.matchMedia('(max-width: 860px)').matches;

  function applyMode() {
    // There is no room for two panes on a phone. Split silently became a
    // stacked 108vh shell with the map below the fold, so a tapped row
    // produced no visible response.
    if (S.mode === 'split' && NARROW()) S.mode = 'map';
    const shell = document.getElementById('mapShell');
    const grid = document.getElementById('pgrid');
    const gmeta = document.querySelector('.gmeta');
    if (!shell) return;
    document.body.classList.toggle('map-on', S.mode !== 'list');
    shell.hidden = S.mode === 'list';
    shell.dataset.mode = S.mode;
    if (grid) grid.style.display = S.mode === 'list' ? '' : 'none';
    if (gmeta) gmeta.style.display = S.mode === 'map' ? 'none' : '';
    shell.style.setProperty('--split', S.split + '%');
    sizeShell();
    renderModeSwitch();
    // The map cannot lay itself out while it is display:none, so it is told
    // the moment it becomes visible.
    if (S.mapApi && S.mode !== 'list') {
      setTimeout(() => {
        resizeMap();
        if (S.mode === 'map' || !S.selectedId) S.mapApi.fit(S.items);
      }, 60);
    }
  }

  // The shell fills whatever is left below the controls. A CSS
  // calc(100vh - 210px) cannot know that: the search row, the filter row and
  // the chip row all wrap at different widths, so the guess was ~90px out at
  // 1500px and the property card fell below the fold. Measured instead, and
  // re-measured on resize.
  // The one place that nudges the map after a layout change. Goes through
  // PinMapCore.lib() rather than google.maps, which with loading=async is not
  // populated until importLibrary has run.
  function resizeMap() {
    if (!S.mapApi) return;
    const lib = root.PinMapCore.lib && root.PinMapCore.lib();
    const ev = (lib && lib.event) || (root.google && root.google.maps && root.google.maps.event);
    if (ev && ev.trigger) ev.trigger(S.mapApi.map, 'resize');
  }

  function sizeShell() {
    const shell = document.getElementById('mapShell');
    if (!shell || shell.hidden) return;
    const top = shell.getBoundingClientRect().top;
    const h = Math.max(420, window.innerHeight - top - 20);
    shell.style.height = h + 'px';
  }

  let sizeHooked = false;
  function hookSize() {
    if (sizeHooked) return;
    sizeHooked = true;
    let t = null;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        sizeShell();
        if (S.mapApi) resizeMap();
      }, 120);
    });
  }

  function renderModeSwitch() {
    const el = document.getElementById('mapModeSwitch');
    if (!el) return;
    if (NARROW()) {
      const b2 = (k, label) => `<button type="button" class="mv-mode${S.mode === k ? ' on' : ''}"
        onclick="PinMapView.setMode('${k}')" aria-pressed="${S.mode === k}">${esc(label)}</button>`;
      el.innerHTML = b2('list', 'List') + b2('map', 'Map');
      return;
    }
    const b = (k, label, title) => `<button type="button" class="mv-mode${S.mode === k ? ' on' : ''}"
      onclick="PinMapView.setMode('${k}')" title="${esc(title)}" aria-pressed="${S.mode === k}">${esc(label)}</button>`;
    el.innerHTML = b('list', 'List', 'Cards only — the view for scanning and comparing')
      + b('split', 'Split', 'Cards and map together — the working view')
      + b('map', 'Map', 'Map only — for showing a client the area');
  }

  // ═══════ THE MAP ═══════

  let mapBooting = null;
  function ensureMap() {
    if (S.mapApi || mapBooting) return mapBooting || Promise.resolve(S.mapApi);
    // The CANVAS host, not the whole pane: #mapCard, #mapPinList and
    // #mapPinMode live inside #mapPane too, and replacing the pane's
    // innerHTML deleted all three — after which every card render silently
    // wrote to an element that was no longer in the document.
    const pane = document.getElementById('mapCanvasHost');
    if (!pane) return Promise.resolve(null);
    pane.innerHTML = '<div class="mv-load">Loading the map…</div>';

    mapBooting = fetchKey()
      .then(key => root.PinMapCore.load(key))
      .then(st => {
        S.loadState = st;
        if (!st.ok) { renderMapProblem(st); return null; }
        pane.innerHTML = '';
        const canvas = document.createElement('div');
        canvas.className = 'mv-canvas';
        pane.appendChild(canvas);
        S.mapApi = root.PinMapCore.create(canvas, {
          onSelect: id => select(id, 'map'),
          onHover: id => hover(id, 'map'),
          onPinDrop: pos => onPinDrop(pos),
          areaOf: it => it.pos && it.pos.via
        });
        refresh();
        return S.mapApi;
      })
      .catch(e => { renderMapProblem({ ok: false, reason: 'error', message: e.message, fix: 'Reload the page.' }); return null; });
    return mapBooting;
  }

  let keyPromise = null;
  function fetchKey() {
    if (keyPromise) return keyPromise;
    // publicConfig may already be on the page (dashboard pre-fetches it).
    if (root.publicConfig && root.publicConfig.googleMapsApiKey != null) {
      keyPromise = Promise.resolve(root.publicConfig.googleMapsApiKey);
      return keyPromise;
    }
    keyPromise = fetch('/api/public-config')
      .then(r => r.json())
      .then(c => c.googleMapsApiKey || '')
      .catch(() => '');
    return keyPromise;
  }

  // A blank grey rectangle is the worst way to report a missing key, so the
  // panel says what is wrong, what to do, and what still works without it.
  function renderMapProblem(st) {
    const pane = document.getElementById('mapCanvasHost');
    if (!pane) return;
    const placed = S.located ? S.located.counts : null;
    pane.innerHTML = `<div class="mv-problem"><div class="mv-problem-in">
      <h3>The map cannot load yet</h3>
      <p>${esc(st.message || 'Google Maps did not start.')}</p>
      <p class="mv-fix"><b>What to do:</b> ${esc(st.fix || 'Tell the office - the map needs switching on.')}</p>
      ${placed ? `<p class="mv-still"><b>Everything else still works.</b> ${placed.exact + placed.approx} of
        ${placed.total} properties already have a position, so the list, the distances and the pin report on the
        left are all live - only the map picture is missing.</p>` : ''}
    </div></div>`;
  }

  // ═══════ DATA ═══════

  /**
   * Called by the page whenever the filters change, and by every path here
   * that mutates a property.
   *
   * @param force  re-resolve positions even if the list is the same object.
   *   PinGeoResolve.locate() memoises against the list IDENTITY, which is
   *   right for a re-render and wrong straight after a pin is saved: the
   *   array is the same object, its contents are not, and the stale answer
   *   left the newly pinned property off the map until the next filter
   *   change. Filter changes build a new array and so never need this.
   */
  function refresh(force) {
    if (!S.booted) return;
    const all = S.host.properties();
    const shown = S.host.filtered();
    const area = root.PinAreaModel ? root.PinAreaModel.forList(all) : null;
    S.located = root.PinGeoResolve.locate(shown, { area, force: !!force });

    S.items = S.located.placed.map(x => {
      const rec = root.PinSearch ? root.PinSearch.indexProperty(x.p) : null;
      const price = rec && rec.num.price.length ? rec.num.price : null;
      return {
        p: x.p, pos: x.pos,
        priceLo: price ? Math.min.apply(null, price.map(r => r[0])) : null,
        priceHi: price ? Math.max.apply(null, price.map(r => r[1])) : null
      };
    });

    if (S.mapApi) {
      S.mapApi.render(S.items);
      if (!S.selectedId) S.mapApi.fit(S.items);
    }
    renderList();
    renderPinBar();
    if (S.selectedId && !S.items.some(i => i.p.id === S.selectedId)) { select(null); return; }
    // A filter change invalidates any open property list: the answer on
    // screen was computed against the OLD set, and leaving it there is how an
    // agent reads out a property the filter has just excluded. The card is
    // redrawn too — it used to keep whatever it had.
    if (S.answer && (S.answer.kind === 'near5' || S.answer.kind === 'near30')) {
      S.answer = { kind: S.answer.kind, stale: true };
    }
    renderCard();
  }

  const itemOf = id => S.items.find(i => i.p.id === id) || null;

  // ═══════ THE LIST ═══════
  //
  // Deliberately not the card grid. In split view the column is ~400px and
  // the job is different: scan, hover to locate, click to inspect. So it is a
  // dense row — code, name, locality, config, price — with the precision of
  // its position shown, because that is what decides whether the agent can
  // quote a distance from it.
  function renderList() {
    const el = document.getElementById('mapList');
    if (!el) return;
    const core = root.PinMapCore;
    if (!S.items.length) {
      el.innerHTML = `<div class="mv-empty">Nothing to show on the map.
        ${S.located && S.located.counts.missing ? `<b>${S.located.counts.missing}</b> of the matching properties have no pin yet.` : ''}</div>`;
      return;
    }
    el.innerHTML = S.items.map(it => {
      const p = it.p;
      const approx = it.pos.precision === 'approx';
      return `<button type="button" class="mv-row${S.selectedId === p.id ? ' sel' : ''}${p.soldOut ? ' sold' : ''}"
          data-id="${esc(p.id)}"
          onclick="PinMapView.select('${esc(p.id)}','list')"
          onmouseenter="PinMapView.hover('${esc(p.id)}','list')"
          onmouseleave="PinMapView.hover(null,'list')">
        <div class="mv-row-1">
          ${p.propertyCode ? `<span class="mv-code">${esc(p.propertyCode)}</span>` : ''}
          <span class="mv-nm">${esc(p.name || p.id)}</span>
          <span class="mv-pr">${esc(core.priceRange(it.priceLo, it.priceHi))}</span>
        </div>
        <div class="mv-row-2">
          <span class="mv-loc">${esc(shortLoc(p.location) || '—')}</span>
          ${p.config ? `<span class="mv-cfg">${esc(p.config)}</span>` : ''}
          ${approx ? `<span class="mv-ax" title="Placed at ${esc(it.pos.via || 'its locality')} — within about ${it.pos.accuracyKm} km, not the exact address">~${it.pos.accuracyKm}km</span>`
            : '<span class="mv-ex" title="Exact pin">pinned</span>'}
        </div>
      </button>`;
    }).join('');
  }

  // ═══════ SELECTION ═══════

  function select(id, from) {
    S.selectedId = id || null;
    if (S.mapApi) {
      S.mapApi.select(S.selectedId);
      if (from === 'list' && S.selectedId) S.mapApi.panTo(S.selectedId);
    }
    // Only re-render the rows' selected class, not the whole list: rebuilding
    // it would throw away the scroll position mid-click.
    const el = document.getElementById('mapList');
    if (el) el.querySelectorAll('.mv-row').forEach(r => r.classList.toggle('sel', r.dataset.id === S.selectedId));
    if (from === 'map' && S.selectedId && el) {
      const row = el.querySelector(`.mv-row[data-id="${cssEscape(S.selectedId)}"]`);
      if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    S.answer = null;
    renderCard();
  }

  function hover(id, from) {
    if (S.mapApi) S.mapApi.hover(id || null);
    if (from === 'map') {
      const el = document.getElementById('mapList');
      if (el) el.querySelectorAll('.mv-row').forEach(r => r.classList.toggle('hot', !!id && r.dataset.id === id));
    }
  }

  // CSS.escape is not in every browser this runs on, and an id from the sheet
  // can contain anything.
  const cssEscape = s => (root.CSS && root.CSS.escape) ? root.CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');

  // ═══════ THE SELECTED PROPERTY CARD ═══════
  //
  // The tile the brief asked for, and the launchpad for every question an
  // agent gets asked next. Everything on it is one click from an answer.
  function renderCard() {
    const el = document.getElementById('mapCard');
    if (!el) return;
    const it = itemOf(S.selectedId);
    if (!it) { el.hidden = true; el.innerHTML = ''; return; }
    const p = it.p, core = root.PinMapCore;
    const approx = it.pos.precision === 'approx';
    el.hidden = false;
    el.innerHTML = `
      <button type="button" class="mv-card-x" data-act="close" aria-label="Close this property">✕</button>
      <div class="mv-card-hd">
        ${p.propertyCode ? `<span class="mv-code">${esc(p.propertyCode)}</span>` : ''}
        <b>${esc(p.name || p.id)}</b>
        ${p.soldOut ? '<span class="mv-sold">Sold out</span>' : ''}
      </div>
      <div class="mv-card-sub">${esc([shortLoc(p.location), p.config].filter(Boolean).join(' · '))}</div>
      <div class="mv-card-price">${esc(core.priceRange(it.priceLo, it.priceHi))}
        ${p.pricePerSqft ? `<i>· ${esc(String(p.pricePerSqft).replace(/sqft/i, 'sq ft'))}</i>` : ''}</div>
      <div class="mv-facts">
        ${fact(readyOf(p), /^Ready/.test(readyOf(p) || '') ? 'ok' : 'warn')}
        ${fact(p.sqftRange ? String(p.sqftRange).replace(/\s*sq\.?\s*ft\.?/i, ' sq ft') : null)}
        ${fact(p.builder)}
        ${fact(p.facing ? p.facing + ' facing' : null)}
      </div>
      <div class="mv-prec ${approx ? 'ax' : 'ex'}">
        ${approx
          ? `Shown at <b>${esc(it.pos.via || it.pos.area || 'its locality')}</b> — within about ${it.pos.accuracyKm} km of the real address,
             so do not quote a distance from it.
             <button type="button" class="mv-link" data-act="pin">Drop the exact pin</button>`
          : `Exact pin${it.pos.source === 'pin' ? ', placed by the team' : ''}.
             <button type="button" class="mv-link" data-act="pin">Move it</button>`}
      </div>
      <div class="mv-acts">
        <button type="button" class="mv-btn primary" data-act="open">Open property →</button>
        <a class="mv-btn send" href="${esc(core.whatsappUrl(pitch(it), null))}" target="_blank" rel="noopener"
           title="Opens WhatsApp with the property written out — you pick who to send it to">Send on WhatsApp</a>
        ${p.contactNumber ? `<a class="mv-btn" href="tel:${esc(String(p.contactNumber).replace(/[^\d+]/g, ''))}">Call site</a>` : ''}
        <!-- No origin, so Google routes from the DEVICE — what an agent in the
             street wants. Passing the property as both ends, as this did,
             opened a zero-length route. -->
        <a class="mv-btn ghost" href="${esc(root.PinMapNearby.directionsUrl(null, it.pos))}" target="_blank" rel="noopener">Directions ↗</a>
      </div>
      <div class="mv-asks">
        <span class="mv-asks-l">Answer a question</span>
        <button type="button" class="mv-chip" data-ask="near5">Nearby, 5 km</button>
        <button type="button" class="mv-chip" data-ask="near30" title="Asks Google for live drive times">Nearby, 30 min drive</button>
        <button type="button" class="mv-chip" data-ask="places">Schools, hospitals, metro</button>
        <button type="button" class="mv-chip" data-ask="distance">Distance to…</button>
      </div>
      <div class="mv-context" id="mapContext"></div>
      <div class="mv-answer" id="mapAnswer" role="region" aria-live="polite" aria-label="Answer"></div>`;
    wireCard(el);
    loadContext(it);
    if (S.answer) renderAnswer();
  }

  // Possession is the fact most expensive to omit: an agent quoting a price
  // without knowing it is a 2028 handover has wasted everybody's afternoon.
  function readyOf(p) {
    if (/ready\s*to\s*move/i.test(String(p.status || ''))) return 'Ready to move';
    if (p.possession) return 'Possession ' + p.possession;
    return p.status || null;
  }
  const fact = (v, tone) => v ? `<span class="mv-fact${tone ? ' ' + tone : ''}">${esc(v)}</span>` : '';

  // Every property is in Chennai, so printing it on all of them costs about
  // 45% of the row and pushes the part that differs out of view.
  const shortLoc = v => String(v == null ? '' : v)
    .replace(/,?\s*(?:chennai|tamil\s*nadu|india)\b\.?/gi, '')
    .replace(/,?\s*\b6\d{2}\s?\d{3}\b/g, '')
    .replace(/\s*,\s*$/, '').replace(/\s+/g, ' ').trim();

  function pitch(it) {
    let url = null;
    try { url = new URL('property.html?id=' + encodeURIComponent(it.p.id), location.href).href; } catch (e) {}
    return root.PinMapCore.pitchFor(it.p, { priceLo: it.priceLo, priceHi: it.priceHi, url });
  }

  // The card's controls are wired by delegation rather than by writing the
  // property id into an inline onclick. esc() turns an apostrophe into
  // &#39;, the browser decodes the attribute BEFORE the JS parses it, and an
  // id containing one produced a syntax error and a dead control. Inventory
  // ids come from a hand-edited sheet, so that is a real input.
  // ONE listener for the whole card, including the answer panel inside it.
  // There were two — a second on #mapAnswer with its own `__dWired` guard —
  // and they had different lifecycles: #mapAnswer is rebuilt every time the
  // card re-renders, so the guard survived on an element that had been
  // replaced and the Find button silently stopped responding. One listener on
  // one element that the card owns end to end cannot drift like that.
  function wireCard(el) {
    if (!el || el.__wired) return;
    el.__wired = true;

    el.addEventListener('click', ev => {
      const ask = ev.target.closest('[data-ask]');
      if (ask) { api.ask(ask.getAttribute('data-ask')); return; }

      // data-TRAVEL, not data-mode. #mapShell already carries data-mode for
      // the view mode (List / Split / Map), so closest('[data-mode]') matched
      // the shell on EVERY click inside the map — hijacking Find, the
      // category chips and the nearby rows into the travel-mode branch and
      // setting the travel mode to 'split'. One attribute name, two
      // meanings, and the outer one always won.
      const mode = ev.target.closest('[data-travel]');
      if (mode) {
        // Switching to Metro is a question, not a setting — so if there is
        // already an answer on screen, ask it again in the new mode.
        S.answer = Object.assign({}, S.answer, { mode: mode.getAttribute('data-travel') });
        const v = (document.getElementById('mvDistInput') || {}).value;
        if (S.answer.result && v) runDistance(v); else renderAnswer();
        return;
      }

      if (ev.target.closest('[data-find]')) {
        const i = document.getElementById('mvDistInput');
        const v = (i && i.value) || (S.answer && S.answer.text) || '';
        hideAc();
        runDistance(v);
        return;
      }

      const pick = ev.target.closest('[data-ac]');
      if (pick) {
        const i = document.getElementById('mvDistInput');
        if (i) { i.value = pick.getAttribute('data-ac'); hideAc(); runDistance(i.value); }
        return;
      }

      const go = ev.target.closest('[data-go]');
      if (go) { select(go.getAttribute('data-go'), 'list'); return; }

      const cat = ev.target.closest('[data-cat]');
      if (cat) { pickCategory(cat.getAttribute('data-cat')); return; }

      const act = ev.target.closest('[data-act]');
      if (!act) return;
      const what = act.getAttribute('data-act');
      if (what === 'open') openProperty(S.selectedId);
      else if (what === 'close') select(null);
      else if (what === 'pin') startPin(S.selectedId);
    });

    el.addEventListener('keydown', ev => {
      if (ev.target.id !== 'mvDistInput') return;
      if (ev.key === 'Enter') { ev.preventDefault(); hideAc(); runDistance(ev.target.value); }
      else if (ev.key === 'Escape') hideAc();
    });

    el.addEventListener('input', ev => {
      if (ev.target.id !== 'mvDistInput') return;
      const q = ev.target.value;
      // Kept on the state as it is typed, NOT only read at submit time. The
      // panel is re-rendered by anything that touches the card — a snapshot
      // landing, a filter changing, the context images arriving — and each
      // re-render rebuilds this input from S.answer.text. Without this line
      // that was always the empty string, so a re-render silently wiped what
      // the agent had half-typed and the Find button then searched for
      // nothing at all.
      if (S.answer && S.answer.kind === 'distance') S.answer.text = q;
      clearTimeout(acTimer);
      // Debounced: autocomplete is billed per request, and a keystroke is
      // not a question.
      acTimer = setTimeout(() => suggest(q), 220);
    });
  }

  // ═══════ CONTEXT — what the street looks like, and how high it sits ═══════
  //
  // Two things an agent is asked on almost every call and had to leave the
  // page for. Both are fetched once per property and cached, and both are
  // only asked for when a card is actually open.
  async function loadContext(it) {
    const el = document.getElementById('mapContext');
    if (!el || !S.loadState || !S.loadState.ok) return;
    const id = it.p.id;
    const N = root.PinMapNearby;

    const [sv, elev] = await Promise.all([
      N.streetView(it.pos).catch(() => null),
      N.elevationOf(it.pos).catch(() => null)
    ]);
    // The agent may have moved on while those were in flight.
    if (S.selectedId !== id) return;
    const still = document.getElementById('mapContext');
    if (!still) return;

    const approx = it.pos.precision === 'approx';
    const bits = [];

    if (sv) {
      bits.push(`<a class="mv-sv" href="${esc(sv.open)}" target="_blank" rel="noopener"
          title="Open Street View">
          <img src="${esc(sv.img)}" alt="Street View near ${esc(it.p.name || 'this property')}" loading="lazy">
          <span class="mv-sv-t">Street View${sv.date ? ' · ' + esc(sv.date) : ''}${approx ? ' · of the locality, not the building' : ''}</span>
        </a>`);
    }

    // Reported as height and context, never as "this floods". Altitude is
    // measured; flood risk depends on drainage as well, and an agent telling
    // a client a property is safe would be far worse than telling them
    // nothing. What this does is let them answer "is it low-lying?" with a
    // number instead of a shrug.
    if (elev && elev.band) {
      bits.push(`<div class="mv-elev ${esc(elev.band.key)}">
          <b>${elev.metres} m</b> above sea level — ${esc(elev.band.say)}.
          <i>Ground height only; it does not say whether the area drains well.</i>
        </div>`);
    }

    still.innerHTML = bits.join('');
  }

  function openProperty(id) {
    if (S.host && S.host.onOpenProperty) S.host.onOpenProperty(id);
  }

  // ═══════ THE ANSWERS ═══════

  // Every question gets a ticket, and a late answer checks its ticket before
  // writing itself to the screen. Without this, clicking "Schools" while a
  // 30-minute drive-time request was still in flight let the OLDER answer
  // land on top of the newer one a second later — the panel silently replaced
  // what the agent had just asked for with what they had moved on from.
  let askSeq = 0;
  const stillAsking = n => askSeq === n;

  function ask(kind) {
    askSeq++;
    S.answer = { kind, loading: kind !== 'places' && kind !== 'distance' ? true : false };
    if (kind === 'near5') answerNear5();
    else if (kind === 'near30') answerNear30();
    else if (kind === 'places') { S.answer.cat = null; renderAnswer(); }
    else if (kind === 'distance') { S.answer.text = ''; S.answer.mode = 'DRIVE'; renderAnswer(); }
  }

  function answerNear5() {
    const it = itemOf(S.selectedId);
    if (!it) return;
    // Free: straight-line, from coordinates already held. No API call.
    // The price cap is whatever the agent already set in Advanced — "what
    // else near here under 3 crore" was otherwise left to their eye.
    const cap = S.host.priceCap ? S.host.priceCap() : null;
    const list = root.PinMapNearby.nearbyProperties(it, S.items, { km: 5, limit: 12, maxPrice: cap });
    S.answer = { kind: 'near5', list, cap, priced: false };
    renderAnswer();
  }

  async function answerNear30() {
    const it = itemOf(S.selectedId);
    if (!it) return;
    if (!S.loadState || !S.loadState.ok) { S.answer = { kind: 'near30', error: 'Drive times need the map key.' }; return renderAnswer(); }
    const seq = askSeq;
    S.answer = { kind: 'near30', loading: true };
    renderAnswer();
    try {
      const res = await root.PinMapNearby.withinMinutes(it, S.items, 30);
      if (!stillAsking(seq)) return;
      if (res.error) { S.answer = { kind: 'near30', error: res.error }; renderAnswer(); return; }
      S.answer = { kind: 'near30', list: res.list, truncated: res.truncated, priced: true };
    } catch (e) {
      if (!stillAsking(seq)) return;
      S.answer = { kind: 'near30', error: 'Could not get drive times: ' + (e.message || 'request failed') };
    }
    renderAnswer();
  }

  async function pickCategory(key) {
    const it = itemOf(S.selectedId);
    if (!it) return;
    askSeq++;
    const seq = askSeq;
    S.answer = { kind: 'places', cat: key, loading: true };
    renderAnswer();
    try {
      const res = await root.PinMapNearby.placesNear(it.pos, key, { radius: 3000, limit: 8 });
      if (!stillAsking(seq)) return;
      S.answer = { kind: 'places', cat: key, list: res.list || [], error: res.error, via: res.via, relaxed: res.relaxed };
    } catch (e) {
      if (!stillAsking(seq)) return;
      S.answer = { kind: 'places', cat: key, error: e.message || 'Places request failed' };
    }
    renderAnswer();
  }

  async function runDistance(text) {
    const it = itemOf(S.selectedId);
    if (!it || !text.trim()) return;
    const mode = (S.answer && S.answer.mode) || 'DRIVE';
    askSeq++;
    const seq = askSeq;
    S.answer = { kind: 'distance', text, mode, loading: true };
    renderAnswer();
    try {
      const res = await root.PinMapNearby.distanceTo(it.pos, text, { mode });
      if (!stillAsking(seq)) return;
      S.answer = { kind: 'distance', text, mode, result: res };
    } catch (e) {
      if (!stillAsking(seq)) return;
      S.answer = { kind: 'distance', text, mode, result: { ok: false, error: e.message || 'failed' } };
    }
    renderAnswer();
  }

  function renderAnswer() {
    const el = document.getElementById('mapAnswer');
    if (!el) return;
    const a = S.answer;
    if (!a) { el.innerHTML = ''; return; }
    const it = itemOf(S.selectedId);
    const core = root.PinMapCore;

    // The distance panel owns its own loading and error states: it holds a
    // text input, and wiping it would take the agent's half-typed place name
    // with it. So it is checked BEFORE the generic guards below.
    if (a.kind === 'distance') { renderDistance(a, it); return; }

    if (a.loading) { el.innerHTML = '<div class="mv-a-busy">Asking Google\u2026</div>'; return; }
    if (a.error) { el.innerHTML = `<div class="mv-a-err">${esc(a.error)}</div>`; return; }

    if (a.kind === 'near5' || a.kind === 'near30') {
      if (a.stale) {
        el.innerHTML = '<div class="mv-a-note">The filters changed, so this list is out of date \u2014 ask again.</div>';
        return;
      }
      const unit = a.kind === 'near30' ? 'drive' : 'straight line';
      if (!a.list.length) {
        el.innerHTML = `<div class="mv-a-hd">Nothing else ${a.kind === 'near30' ? 'within 30 minutes' : 'within 5 km'}</div>
          <div class="mv-a-note">Worth saying plainly to a client \u2014 it means this one is on its own in the area.</div>`;
        return;
      }

      // The heading must not claim something a row underneath it denies.
      // Widening the net for centroid error meant a row reading "roughly
      // 5\u201311 km" could sit under a heading that said "within 5 km", and
      // the agent reads the heading.
      const n = a.list.length, word = n === 1 ? 'property' : 'properties';
      const head = a.kind === 'near30'
        ? `${n} ${word} within a 30-minute drive`
        : (a.list.allCertain
          ? `${n} ${word} within 5 km`
          : `${n} ${word} nearby \u2014 5 km, or up to ${Math.round(a.list.widestKm)} km on the widest reading`);
      const ex = a.list.excluded || {};
      const exNote = [
        ex.sold ? `${ex.sold} sold-out nearby, not counted` : '',
        ex.overBudget ? `${ex.overBudget} over the ${core.priceRange(a.cap, null)} filter` : ''
      ].filter(Boolean).join(' \u00b7 ');

      el.innerHTML = `<div class="mv-a-hd">${esc(head)}${a.cap ? ' under ' + esc(core.priceRange(a.cap, null)) : ''}</div>
        ${a.truncated ? '<div class="mv-a-note">The nearest 24 were checked \u2014 there may be more further out.</div>' : ''}
        ${exNote ? `<div class="mv-a-note">${esc(exNote)}.</div>` : ''}
        <div class="mv-a-list">${a.list.map(x => `
          <button type="button" class="mv-a-row" data-go="${esc(x.p.id)}">
            <span class="mv-a-d">${esc(a.kind === 'near30' ? (x.text || x.mins + ' min') : x.say)}</span>
            <span class="mv-a-n">${x.p.propertyCode ? esc(x.p.propertyCode) + ' \u00b7 ' : ''}${esc(x.p.name || x.p.id)}</span>
            <span class="mv-a-p">${esc(core.priceRange(x.priceLo, x.priceHi))}</span>
          </button>`).join('')}</div>
        <div class="mv-a-note">${esc(unit)}${it && it.pos.accuracyKm ? `, measured from ${esc(it.pos.via || it.pos.area || 'the locality')} rather than the exact address` : ''}.</div>`;
      return;
    }

    if (a.kind === 'places') {
      const cats = root.PinMapNearby.CATEGORIES;
      const chips = cats.map(c => `<button type="button" class="mv-chip${a.cat === c.key ? ' on' : ''}"
        data-cat="${c.key}">${esc(c.label)}</button>`).join('');
      let body = '<div class="mv-a-note">Pick what the client asked about.</div>';
      if (a.cat) {
        const cat = cats.find(c => c.key === a.cat);
        body = a.list && a.list.length
          ? `<div class="mv-a-list">${a.list.map(x => `
              <div class="mv-a-row static">
                <span class="mv-a-d">${esc(x.say)}</span>
                <span class="mv-a-n">${esc(x.name)}${x.kind ? `<i>${esc(x.kind)}</i>` : ''}</span>
                <span class="mv-a-p">${x.rating ? '\u2605 ' + x.rating + (x.ratingCount ? ` (${x.ratingCount})` : '') : ''}</span>
              </div>`).join('')}</div>
             ${a.relaxed ? `<div class="mv-a-note warn">Nothing well-known of that kind nearby — these are the closest listed,
               and may be small practices rather than what the client has in mind.</div>` : ''}
             <div class="mv-a-note">Straight-line distance, nearest first.${it && it.pos.accuracyKm
               ? ` Measured from ${esc(it.pos.via || it.pos.area || 'the locality')}, so a closer one on the other side of it may be missing \u2014
                   <button type="button" class="mv-link" data-act="pin">drop the exact pin</button> to be sure.` : ''}</div>`
          : `<div class="mv-a-note">No ${esc(((cat || {}).label || 'places').toLowerCase())} found within 3 km.</div>`;
      }
      el.innerHTML = `<div class="mv-a-hd">What is around this property</div><div class="mv-chips">${chips}</div>${body}`;
      return;
    }
  }

  // ═══════ THE DISTANCE PANEL ═══════
  //
  // Rendered in TWO parts, and that split is the whole point.
  //
  // The shell — the text box, the mode chips — is built ONCE per property and
  // then left alone. Only the output underneath it is redrawn. Rebuilding the
  // whole panel from state, as this used to, replaced the <input> element on
  // every render, and the panel is re-rendered by anything that touches the
  // card: a Firestore snapshot landing, a filter changing, the Street View
  // and elevation lookups returning. So whatever the agent had typed was
  // silently thrown away mid-sentence, and Find then searched for an empty
  // string. An input is stateful DOM; it cannot be treated as a pure
  // function of a variable.
  function renderDistance(a, it) {
    const el = document.getElementById('mapAnswer');
    if (!el) return;
    const N = root.PinMapNearby;
    const mode = a.mode || 'DRIVE';

    if (!document.getElementById('mvDistInput')) {
      el.innerHTML = `<div class="mv-a-hd">Distance from this property to…</div>
        <div class="mv-dist-row">
          <input id="mvDistInput" type="text" autocomplete="off" role="combobox" aria-expanded="false"
            aria-autocomplete="list" placeholder="An office, a school, an address…">
          <button type="button" class="mv-btn primary" data-find="1">Find</button>
        </div>
        <div class="mv-ac" id="mvAc" role="listbox" hidden></div>
        <div class="mv-modes-row" id="mvModes"></div>
        <div id="mvDistOut"></div>`;
      const input = document.getElementById('mvDistInput');
      if (input) { input.value = a.text || ''; input.focus(); }
    }

    // The mode chips are cheap and hold no typed state, so they are safe to
    // redraw — and they must be, to show which mode the answer is for.
    const modes = document.getElementById('mvModes');
    if (modes) {
      modes.innerHTML = N.MODES.map(m => `<button type="button" class="mv-chip sm${mode === m.key ? ' on' : ''}"
        data-travel="${m.key}">${esc(m.label)}</button>`).join('');
    }

    const out = document.getElementById('mvDistOut');
    if (!out) return;
    if (a.loading) { out.innerHTML = '<div class="mv-a-busy">Asking Google…</div>'; return; }
    const r = a.result;
    if (!r) {
      out.innerHTML = '<div class="mv-a-note">Start typing — anywhere in Chennai. Pick a suggestion to be sure it is the right one.</div>';
      return;
    }
    if (!r.ok) { out.innerHTML = `<div class="mv-a-err">${esc(r.error)}</div>`; return; }

    out.innerHTML = `<div class="mv-dist-out">
        <div class="mv-dist-to">${esc(r.to.formatted)}</div>
        <div class="mv-dist-n">
          ${r.drive ? `<span class="lead"><b>${esc(r.drive.text || r.drive.mins + ' min')}</b><i>${esc(r.modeVerb || 'driving')}${r.drive.inTraffic && r.mode === 'DRIVE' ? ', traffic now' : ''}</i></span>` : ''}
          ${r.drive && r.drive.km != null ? `<span><b>${Math.round(r.drive.km * 10) / 10} km</b><i>by road</i></span>` : ''}
          <span><b>${esc(r.say)}</b><i>straight line</i></span>
        </div>
        ${!r.drive ? `<div class="mv-a-note">${r.routeError
          ? 'Google could not route that: ' + esc(r.routeError)
          : 'No route came back for that mode - the straight-line distance still stands.'}</div>` : ''}
        ${r.note ? `<div class="mv-a-note">Worth knowing: ${esc(r.note)}.</div>` : ''}
        <a class="mv-link" href="${esc(N.directionsUrl(null, r.to, r.mode))}"
           target="_blank" rel="noopener">Open the route in Google Maps ↗</a>
      </div>`;
  }

  let acTimer = null;

  async function suggest(q) {
    const box = document.getElementById('mvAc');
    if (!box) return;
    const it = itemOf(S.selectedId);
    const list = await root.PinMapNearby.autocomplete(q, { near: it ? it.pos : null }).catch(() => []);
    const cur = document.getElementById('mvAc');
    if (!cur) return;
    if (!list.length) { hideAc(); return; }
    cur.hidden = false;
    cur.innerHTML = list.map(x => `<button type="button" class="mv-ac-i" role="option"
      data-ac="${esc(x.text)}"><b>${esc(x.main || x.text)}</b>${x.sub ? `<i>${esc(x.sub)}</i>` : ''}</button>`).join('');
    const input = document.getElementById('mvDistInput');
    if (input) input.setAttribute('aria-expanded', 'true');
  }

  function hideAc() {
    const box = document.getElementById('mvAc');
    if (box) { box.hidden = true; box.innerHTML = ''; }
    const input = document.getElementById('mvDistInput');
    if (input) input.setAttribute('aria-expanded', 'false');
  }

  // ═══════ PINS ═══════

  function renderPinBar() {
    const el = document.getElementById('mapPinBar');
    if (!el || !S.located) return;
    const c = S.located.counts;
    const needs = S.located.missing.length;
    const approx = c.approx;
    if (!needs && !approx) {
      el.innerHTML = `<span class="mv-pb-ok">All ${c.exact} properties are pinned exactly.</span>`;
      return;
    }
    // One line, not four coloured pills. This is a coordinate-quality report
    // and it was sitting in the most valuable position on the page, shouting
    // in red about something that is not wrong — while duplicating the rail is
    // own "Missing data" count. Only the part that needs a person is a link.
    const bits = [`<span class="mv-pb-n"><b>${c.exact + c.approx}</b> of ${c.total} on the map</span>`];
    if (needs) bits.push(`<button type="button" class="mv-pb-b" onclick="PinMapView.openPinList('missing')">${needs} need a pin</button>`);
    if (approx) bits.push(`<button type="button" class="mv-pb-b quiet" onclick="PinMapView.openPinList('approx')">${approx} placed by locality</button>`);
    if (c.snoozed) bits.push(`<button type="button" class="mv-pb-b quiet" onclick="PinMapView.openPinList('snoozed')">${c.snoozed} snoozed</button>`);
    el.innerHTML = bits.join('<span class="mv-pb-sep">·</span>');
  }

  function openPinList(which) {
    const el = document.getElementById('mapPinList');
    if (!el || !S.located) return;
    const rows = which === 'missing' ? S.located.missing
      : which === 'snoozed' ? S.located.snoozed
        : S.located.placed.filter(x => x.pos.precision === 'approx').map(x => ({ p: x.p, advice: root.PinGeoResolve.pinAdvice(x.p, { area: root.PinAreaModel ? root.PinAreaModel.forList(S.host.properties()) : null }) }));

    const title = which === 'missing' ? 'Not on the map — no usable pin'
      : which === 'snoozed' ? 'Snoozed — the team said these do not need a pin'
        : 'On the map, but only at their locality';
    const why = which === 'missing'
      ? 'These cannot be placed at all, so they are invisible to every distance question an agent gets asked. Each needs one pin, once.'
      : which === 'snoozed'
        ? 'Left alone. Un-snooze one if it turns out to matter after all.'
        : 'Good enough to show a client the area; not good enough to quote a distance from. Worth pinning the ones you show often.';

    el.hidden = false;
    el.innerHTML = `
      <div class="mv-pl-hd"><b>${esc(title)}</b>
        <button type="button" class="mv-card-x" onclick="PinMapView.closePinList()" aria-label="Close">✕</button></div>
      <div class="mv-pl-why">${esc(why)}</div>
      <div class="mv-pl-l">${rows.length ? rows.map(r => `
        <div class="mv-pl-r">
          <div class="mv-pl-p">
            ${r.p.propertyCode ? `<span class="mv-code">${esc(r.p.propertyCode)}</span>` : ''}
            <b>${esc(r.p.name || r.p.id)}</b>
            <span class="mv-pl-loc">${esc(r.p.location || 'no location')}</span>
          </div>
          ${r.advice ? `<div class="mv-pl-a">${esc(r.advice.why)} <i>${esc(r.advice.fix)}</i></div>` : ''}
          <div class="mv-pl-acts">
            <button type="button" class="mv-btn sm primary" onclick="PinMapView.startPin('${esc(r.p.id)}')">Drop the pin</button>
            ${which === 'snoozed'
              ? `<button type="button" class="mv-btn sm" onclick="PinMapView.unsnooze('${esc(r.p.id)}')">Un-snooze</button>`
              : `<button type="button" class="mv-btn sm" onclick="PinMapView.snooze('${esc(r.p.id)}')" title="Stop asking about this one">Does not need one</button>`}
          </div>
        </div>`).join('') : '<div class="mv-a-note">Nothing here.</div>'}</div>`;
  }

  function closePinList() {
    const el = document.getElementById('mapPinList');
    if (el) { el.hidden = true; el.innerHTML = ''; }
  }

  // Placing a pin: enter the mode, show what will happen, commit on Save. A
  // single click that silently writes a coordinate is not something to do
  // with data an agent will quote.
  function startPin(id) {
    const p = S.host.properties().find(x => x.id === id);
    if (!p) return;
    if (S.mode === 'list') setMode('split');
    closePinList();
    // The open card belongs to a DIFFERENT property, and leaving it up while
    // the banner says "Placing the pin for UNK0001" is how somebody pins the
    // wrong building.
    if (S.selectedId && S.selectedId !== id) select(null);
    S.pinFor = p;
    S.pendingPin = null;
    if (S.mapApi) {
      S.mapApi.setPinMode(true);
      const existing = root.PinGeoResolve.positionOf(p, { area: root.PinAreaModel ? root.PinAreaModel.forList(S.host.properties()) : null });
      if (existing) { S.mapApi.map.panTo({ lat: existing.lat, lng: existing.lng }); S.mapApi.map.setZoom(16); }
    }
    renderPinMode();
  }

  function onPinDrop(pos) {
    if (!S.pinFor) return;
    S.pendingPin = pos;
    if (S.mapApi) S.mapApi.ghostPin(pos);
    renderPinMode();
  }

  function renderPinMode() {
    const el = document.getElementById('mapPinMode');
    if (!el) return;
    if (!S.pinFor) { el.hidden = true; el.innerHTML = ''; return; }
    const p = S.pinFor;
    el.hidden = false;
    el.innerHTML = `
      <div class="mv-pm-t">Placing the pin for
        <b>${esc([p.name, p.propertyCode].filter(Boolean).join(' · ') || p.id)}</b></div>
      ${p.location ? `<div class="mv-pm-l">${esc(shortLoc(p.location))}</div>` : ''}
      <div class="mv-pm-s">${S.pendingPin
        ? 'Pin placed. Click again to move it, or save it.'
        : 'Click the map where the property actually is. Zoom right in first — a pin is only worth placing if it is right.'}</div>
      <div class="mv-pm-a">
        <button type="button" class="mv-btn primary" ${S.pendingPin ? '' : 'disabled'} onclick="PinMapView.savePin()">Save this pin</button>
        <button type="button" class="mv-btn" onclick="PinMapView.cancelPin()">Cancel</button>
      </div>`;
  }

  function cancelPin() {
    S.pinFor = null; S.pendingPin = null;
    if (S.mapApi) { S.mapApi.setPinMode(false); S.mapApi.ghostPin(null); }
    renderPinMode();
  }

  function savePin() {
    if (!S.pinFor || !S.pendingPin) return;
    const patch = root.PinGeoResolve.pinPatch(S.pendingPin.lat, S.pendingPin.lng, S.host.user ? S.host.user() : null);
    if (!patch) {
      const el = document.getElementById('mapPinMode');
      if (el) el.insertAdjacentHTML('beforeend',
        '<div class="mv-a-err">That point is outside Chennai — zoom in and click the property itself.</div>');
      S.pendingPin = null;
      if (S.mapApi) S.mapApi.ghostPin(null);
      return;
    }
    const id = S.pinFor.id;
    S.host.savePatch(id, patch);
    cancelPin();
    // The page's own snapshot listener will bring the new geo back and call
    // refresh(); patch the local copy so the marker moves immediately rather
    // than after a round trip.
    const p = S.host.properties().find(x => x.id === id);
    if (p) Object.assign(p, patch);
    refresh(true);
    select(id, 'list');
  }

  function snooze(id) {
    S.host.savePatch(id, root.PinGeoResolve.snoozePatch(S.host.user ? S.host.user() : null));
    const p = S.host.properties().find(x => x.id === id);
    if (p) Object.assign(p, root.PinGeoResolve.snoozePatch());
    closePinList(); refresh(true);
  }
  function unsnooze(id) {
    S.host.savePatch(id, root.PinGeoResolve.unsnoozePatch());
    const p = S.host.properties().find(x => x.id === id);
    if (p) Object.assign(p, root.PinGeoResolve.unsnoozePatch());
    closePinList(); refresh(true);
  }

  // ═══════ THE DIVIDER ═══════
  //
  // Pointer events rather than mouse, so it works on a touchscreen; the body
  // class kills text selection and pointer events on the map while dragging,
  // which is what stops the map swallowing the gesture halfway across.
  function initResizer() {
    const bar = document.getElementById('mapResizer');
    const shell = document.getElementById('mapShell');
    if (!bar || !shell || bar.__wired) return;
    bar.__wired = true;

    let dragging = false;
    const apply = clientX => {
      const r = shell.getBoundingClientRect();
      const pct = Math.min(78, Math.max(22, ((clientX - r.left) / r.width) * 100));
      S.split = Math.round(pct * 10) / 10;
      shell.style.setProperty('--split', S.split + '%');
    };
    bar.addEventListener('pointerdown', ev => {
      dragging = true;
      bar.setPointerCapture(ev.pointerId);
      document.body.classList.add('mv-dragging');
    });
    bar.addEventListener('pointermove', ev => { if (dragging) apply(ev.clientX); });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('mv-dragging');
      try { localStorage.setItem(LS_SPLIT, String(S.split)); } catch (e) {}
      if (S.mapApi) resizeMap();
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
    // Keyboard: a divider nobody can move without a mouse is not a control.
    bar.addEventListener('keydown', ev => {
      const step = ev.shiftKey ? 8 : 3;
      if (ev.key === 'ArrowLeft') S.split = Math.max(22, S.split - step);
      else if (ev.key === 'ArrowRight') S.split = Math.min(78, S.split + step);
      else return;
      ev.preventDefault();
      shell.style.setProperty('--split', S.split + '%');
      try { localStorage.setItem(LS_SPLIT, String(S.split)); } catch (e) {}
      if (S.mapApi) resizeMap();
    });
  }

  const api = {
    boot, setMode, refresh, select, hover, ask, pickCategory, runDistance,
    openProperty, openPinList, closePinList, startPin, savePin, cancelPin,
    snooze, unsnooze, initResizer, applyMode, renderModeSwitch,
    state: S
  };
  root.PinMapView = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
