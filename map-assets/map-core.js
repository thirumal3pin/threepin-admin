// ═══════════════════════════════════════════════════════════════════════════
// THE MAP ITSELF — tiles, markers, clustering, selection
// ═══════════════════════════════════════════════════════════════════════════
//
// Module 2 of the map view. It owns the Google Maps instance and everything
// drawn on it, and it knows nothing about filters, lists or panels — it takes
// positioned items in (from geo-resolve.js) and emits selection events out.
//
// ── TWO DECISIONS WORTH THE WORDS ─────────────────────────────────────────
//
// 1. CLUSTERING BY LOCALITY, NOT BY PIXEL.
//
// Every off-the-shelf clusterer groups markers by screen distance. That is
// wrong for this data, and not by a little: most positions are locality
// centroids (see the ladder in geo-resolve.js), so twelve Anna Nagar
// properties are at the SAME coordinate. A pixel clusterer shows one blob
// reading "12" and, zoom in as far as you like, it never separates — they
// never get further apart.
//
// So markers are grouped by the area they belong to. A cluster is "Anna Nagar
// · 12 · ₹1.4–3.5 Cr", which is a thing an agent can use, and clicking it
// zooms in and fans its members out around the centroid so each is
// individually clickable. The data's weakness becomes the organising idea.
//
// 2. CUSTOM HTML MARKERS OVER A STYLED MAP.
//
// The price-pill marker — the one every premium listing site uses, because
// the price IS the label an agent scans for — needs arbitrary DOM. Google's
// AdvancedMarkerElement gives that but requires a cloud Map ID, and setting
// one makes the map ignore a `styles` array, which would hand the palette to
// whoever configures the Cloud console. So: `styles` for the muted ground,
// and a small OverlayView subclass for the markers. Full control of both,
// and nothing to configure outside this repo.
//
// ── THE MAP HAS TO SURVIVE HAVING NO KEY ──────────────────────────────────
//
// A missing or unrestricted Maps key is the likeliest failure in production,
// and a blank grey rectangle is the worst possible way to report it. load()
// resolves to a status rather than throwing, and the view renders a real
// explanation with the exact thing to do.

(function (root) {
  'use strict';

  // ═══════ LOADING ═══════
  //
  // One load per page, whoever asks first. `places` is for the "what is
  // nearby" tools and `geometry` for spherical distance — both are needed by
  // module 3, and asking for them here avoids a second script load later.
  let loadPromise = null;

  function load(key, opts) {
    if (loadPromise) return loadPromise;
    const o = opts || {};
    if (!key) {
      loadPromise = Promise.resolve({
        ok: false, reason: 'no-key',
        message: 'No Google Maps key is configured for this deployment.',
        fix: 'Set GOOGLE_MAPS_BROWSER_KEY in the Vercel project, restricted by HTTP referrer to this domain, then redeploy. The full recipe is in docs/MAP-SETUP.md.'
      });
      return loadPromise;
    }
    loadPromise = new Promise(resolve => {
      if (root.google && root.google.maps) return resolve({ ok: true });

      // Google reports key and billing problems through this global rather
      // than through the script's onerror, so it is the only way to tell
      // "wrong key" from "no network".
      const priorAuthFailure = root.gm_authFailure;
      root.gm_authFailure = function () {
        if (typeof priorAuthFailure === 'function') try { priorAuthFailure(); } catch (e) {}
        resolve({
          ok: false, reason: 'auth',
          message: 'Google rejected the Maps key for this site.',
          fix: 'Check the key’s HTTP-referrer restriction covers this domain, that Maps JavaScript API, Places API (New) and Distance Matrix are enabled, and that billing is on. See docs/MAP-SETUP.md.'
        });
      };

      const s = document.createElement('script');
      const libs = o.libraries || 'places,geometry';
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=${libs}&loading=async&v=quarterly`;
      s.async = true;
      s.onerror = () => resolve({
        ok: false, reason: 'network',
        message: 'The Google Maps script could not be loaded.',
        fix: 'Check the connection, and that no extension or network policy is blocking maps.googleapis.com.'
      });
      s.onload = () => {
        // onload fires before the auth check completes, so give
        // gm_authFailure a tick to win the race if it is going to.
        setTimeout(() => resolve(root.google && root.google.maps ? { ok: true } : {
          ok: false, reason: 'auth', message: 'Google Maps loaded but did not initialise.',
          fix: 'Usually a key restriction or a disabled API. Check the browser console for Google’s own message.'
        }), 120);
      };
      document.head.appendChild(s);
    });
    return loadPromise;
  }

  // ═══════ THE GROUND ═══════
  //
  // Muted, low-contrast, warm-neutral — so the markers are the only saturated
  // thing on screen. A default Google map has coloured roads, coloured parks
  // and red POI pins competing with the listings; a premium listing map gets
  // out of the way. Landmarks the agent's job depends on (schools, hospitals,
  // transit) stay visible because module 3 is built around them; shops,
  // restaurants and business POIs go, because they are noise here.
  const MAP_STYLE = [
    { elementType: 'geometry', stylers: [{ color: '#f6f5f2' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#6b6660' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#f6f5f2' }, { weight: 2 }] },
    { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#e0dbd2' }] },
    { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#44403c' }] },
    { featureType: 'administrative.neighborhood', elementType: 'labels.text.fill', stylers: [{ color: '#78716c' }] },
    { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#efece6' }] },
    { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#eceade' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.park', stylers: [{ visibility: 'on' }] },
    { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#dfe7d5' }] },
    { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#7a8a66' }] },
    { featureType: 'poi.school', stylers: [{ visibility: 'on' }] },
    { featureType: 'poi.school', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.medical', stylers: [{ visibility: 'on' }] },
    { featureType: 'poi.medical', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
    { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#9c968e' }] },
    { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#fbfaf8' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#f0e9dc' }] },
    { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#e6dcc9' }] },
    { featureType: 'road.local', elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit.line', elementType: 'geometry', stylers: [{ color: '#e4ded2' }] },
    { featureType: 'transit.station', stylers: [{ visibility: 'on' }] },
    { featureType: 'transit.station', elementType: 'labels.text.fill', stylers: [{ color: '#8b8279' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#d9e4e8' }] },
    { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#92a7ae' }] }
  ];

  // Chennai, framed so the whole metro is in view on open.
  const CHENNAI = { lat: 13.02, lng: 80.20 };

  // Past this zoom, individual properties replace locality clusters. 13 is
  // roughly "one part of the city fills the screen" — the point at which a
  // cluster stops being a useful summary and starts hiding the listings.
  const SPLIT_ZOOM = 13;

  // ═══════ MONEY ═══════
  //
  // The marker label. Short enough to fit in a pill and read at a glance:
  // an agent scanning a map is reading prices, not names.
  const CR = 10000000, LAKH = 100000;
  function priceLabel(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n >= CR) {
      const v = n / CR;
      return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + ' Cr';
    }
    if (n >= LAKH) return Math.round(n / LAKH) + ' L';
    return '₹' + Math.round(n / 1000) + 'k';
  }
  function priceRange(lo, hi) {
    if (lo == null) return 'Price on request';
    if (hi == null || Math.abs(hi - lo) / lo < 0.02) return '₹' + priceLabel(lo);
    return '₹' + priceLabel(lo) + '–' + priceLabel(hi);
  }

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ═══════ MARKERS ═══════
  //
  // Defined after the API loads, because OverlayView only exists then.
  let Overlay = null;

  function defineOverlay() {
    if (Overlay) return Overlay;
    const g = root.google.maps;

    class HtmlMarker extends g.OverlayView {
      constructor(position, html, opts) {
        super();
        this.position = position;
        this.html = html;
        this.opts = opts || {};
        this.div = null;
      }
      onAdd() {
        const d = document.createElement('div');
        d.className = 'gm-pin ' + (this.opts.className || '');
        d.innerHTML = this.html;
        d.style.position = 'absolute';
        // A marker is a control, so it must announce itself as one.
        d.tabIndex = 0;
        d.setAttribute('role', 'button');
        if (this.opts.aria) d.setAttribute('aria-label', this.opts.aria);
        const fire = ev => { ev.stopPropagation(); if (this.opts.onClick) this.opts.onClick(ev); };
        d.addEventListener('click', fire);
        d.addEventListener('keydown', ev => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fire(ev); }
        });
        if (this.opts.onOver) d.addEventListener('mouseenter', this.opts.onOver);
        if (this.opts.onOut) d.addEventListener('mouseleave', this.opts.onOut);
        this.div = d;
        // paneName: a marker belongs above the map but below info windows.
        this.getPanes().floatPane.appendChild(d);
      }
      draw() {
        if (!this.div) return;
        const p = this.getProjection().fromLatLngToDivPixel(this.position);
        if (!p) return;
        // Translated rather than offset by width, so the pill stays centred
        // on its point at any size without measuring it.
        this.div.style.left = p.x + 'px';
        this.div.style.top = p.y + 'px';
      }
      onRemove() {
        if (this.div && this.div.parentNode) this.div.parentNode.removeChild(this.div);
        this.div = null;
      }
      setSelected(on) { if (this.div) this.div.classList.toggle('sel', !!on); }
      setHot(on) { if (this.div) this.div.classList.toggle('hot', !!on); }
      raise() { if (this.div) this.div.style.zIndex = '40'; }
      lower() { if (this.div) this.div.style.zIndex = ''; }
    }
    Overlay = HtmlMarker;
    return Overlay;
  }

  // ═══════ THE MAP ═══════

  /**
   * @param el    the element to fill
   * @param opts  { onSelect(id), onHover(id|null), onPinDrop({lat,lng}), onIdle() }
   */
  function create(el, opts) {
    const o = opts || {};
    const g = root.google.maps;
    defineOverlay();

    const map = new g.Map(el, {
      center: CHENNAI,
      zoom: 11,
      styles: MAP_STYLE,
      // The default control set is a lot of chrome on a panel this size.
      // Zoom and a map-type switch are the two anybody uses.
      mapTypeControl: true,
      mapTypeControlOptions: { style: g.MapTypeControlStyle.DROPDOWN_MENU, position: g.ControlPosition.TOP_RIGHT },
      streetViewControl: true,
      streetViewControlOptions: { position: g.ControlPosition.RIGHT_BOTTOM },
      fullscreenControl: false,           // the view has its own expand control
      zoomControl: true,
      zoomControlOptions: { position: g.ControlPosition.RIGHT_BOTTOM },
      clickableIcons: false,              // Google's own POIs are not our data
      gestureHandling: 'greedy',          // a map in a split pane should pan on one finger
      keyboardShortcuts: true,
      maxZoom: 19, minZoom: 9
    });

    const state = {
      map, markers: new Map(), clusters: [], items: [],
      selectedId: null, hoverId: null,
      pinMode: false, pinGhost: null,
      areaOf: o.areaOf || null
    };

    map.addListener('click', ev => {
      if (state.pinMode && o.onPinDrop) {
        o.onPinDrop({ lat: ev.latLng.lat(), lng: ev.latLng.lng() });
        return;
      }
      if (o.onSelect) o.onSelect(null);       // clicking the ground clears
    });

    // Redraw the marker layer when the zoom crosses the cluster threshold —
    // and only then, because rebuilding on every idle is what makes a map
    // feel sticky while panning.
    let lastMode = null;
    map.addListener('idle', () => {
      const mode = map.getZoom() >= SPLIT_ZOOM ? 'pins' : 'clusters';
      if (mode !== lastMode) { lastMode = mode; draw(state, o); }
      if (o.onIdle) o.onIdle();
    });

    return {
      map, state,
      render: items => { state.items = items || []; lastMode = state.map.getZoom() >= SPLIT_ZOOM ? 'pins' : 'clusters'; draw(state, o); },
      select: id => { state.selectedId = id; applyFlags(state); },
      hover: id => { state.hoverId = id; applyFlags(state); },
      panTo: id => panTo(state, id),
      fit: items => fit(state, items || state.items),
      setPinMode: on => { state.pinMode = !!on; el.classList.toggle('pin-mode', !!on); },
      ghostPin: pos => ghostPin(state, pos),
      clear: () => clearMarkers(state),
      zoomToArea: key => zoomToArea(state, key)
    };
  }

  function clearMarkers(state) {
    state.markers.forEach(m => m.setMap(null));
    state.markers.clear();
    state.clusters.forEach(m => m.setMap(null));
    state.clusters = [];
  }

  // ═══════ DRAWING ═══════

  function draw(state, o) {
    clearMarkers(state);
    const items = state.items;
    if (!items.length) return;
    const zoomed = state.map.getZoom() >= SPLIT_ZOOM;
    if (zoomed) drawPins(state, o, items);
    else drawClusters(state, o, items);
    applyFlags(state);
  }

  // Group items by the area they were placed at — see the header. Items with
  // an exact pin are grouped by their nearest area too, so a cluster count is
  // the whole truth about that locality rather than the approximate half.
  function groupByArea(items, areaOf) {
    const groups = new Map();
    for (const it of items) {
      // The locality, which geo-resolve puts on every position whatever
      // rung placed it. Grouping by `via` grouped by STREET, and `label` is
      // prose ("Pin placed by the team"), so four Anna Nagar properties
      // produced four keys and never clustered at all.
      const key = (it.pos && it.pos.area) || (areaOf && areaOf(it)) || 'Elsewhere';
      let grp = groups.get(key);
      if (!grp) { grp = { key, label: String(key).replace(/^Placed at /, ''), items: [], lat: 0, lng: 0 }; groups.set(key, grp); }
      grp.items.push(it);
    }
    for (const grp of groups.values()) {
      // The centroid of the members, not of the locality: it keeps a cluster
      // sitting over the properties it actually contains.
      grp.lat = grp.items.reduce((n, x) => n + x.pos.lat, 0) / grp.items.length;
      grp.lng = grp.items.reduce((n, x) => n + x.pos.lng, 0) / grp.items.length;
      const prices = grp.items.map(x => x.priceLo).filter(v => v != null);
      grp.lo = prices.length ? Math.min.apply(null, prices) : null;
      grp.hi = prices.length ? Math.max.apply(null, prices) : null;
    }
    return [...groups.values()].sort((a, b) => b.items.length - a.items.length);
  }

  function drawClusters(state, o, items) {
    const g = root.google.maps;
    const groups = groupByArea(items, state.areaOf);
    for (const grp of groups) {
      // A single property is drawn as itself — a cluster of one is a lie
      // about there being more.
      if (grp.items.length === 1) { drawPins(state, o, grp.items); continue; }
      const html = `<span class="gm-cl-n">${grp.items.length}</span>`
        + `<span class="gm-cl-t"><b>${esc(grp.label)}</b><i>${esc(priceRange(grp.lo, grp.hi))}</i></span>`;
      const m = new Overlay(new g.LatLng(grp.lat, grp.lng), html, {
        className: 'gm-cluster' + (grp.items.length >= 8 ? ' big' : ''),
        aria: `${grp.items.length} properties in ${grp.label}, ${priceRange(grp.lo, grp.hi)}. Open.`,
        onClick: () => {
          // Zoom to the members rather than by a fixed step, so one click
          // always resolves the cluster.
          fit(state, grp.items, { maxZoom: 16 });
        }
      });
      m.setMap(state.map);
      state.clusters.push(m);
    }
  }

  // Co-located markers are fanned around their shared point so every one is
  // clickable. Without this, twelve Anna Nagar properties at one centroid are
  // one marker and eleven unreachable ones.
  function spider(items) {
    const byPoint = new Map();
    for (const it of items) {
      // 4 decimal places is ~11 m — close enough to be the same point as far
      // as a marker is concerned.
      const k = it.pos.lat.toFixed(4) + ',' + it.pos.lng.toFixed(4);
      let bucket = byPoint.get(k);
      if (!bucket) { bucket = []; byPoint.set(k, bucket); }
      bucket.push(it);
    }
    const out = [];
    for (const group of byPoint.values()) {
      if (group.length === 1) { out.push({ it: group[0], lat: group[0].pos.lat, lng: group[0].pos.lng, fanned: false }); continue; }
      // ~120 m radius, growing with the count so a big group does not overlap
      // itself. Deterministic, so a marker does not jump between renders.
      const r = 0.0011 + 0.00028 * Math.min(group.length, 14);
      group.forEach((it, i) => {
        const a = (2 * Math.PI * i) / group.length - Math.PI / 2;
        out.push({
          it,
          lat: it.pos.lat + r * Math.sin(a) * 0.72,   // ×0.72: a degree of
          lng: it.pos.lng + r * Math.cos(a),         // latitude is longer
          fanned: true
        });
      });
    }
    return out;
  }

  function drawPins(state, o, items) {
    const g = root.google.maps;
    for (const node of spider(items)) {
      const it = node.it;
      const p = it.p;
      const approx = it.pos.precision === 'approx';
      const cls = ['gm-prop'];
      if (approx) cls.push('approx');
      if (p.soldOut) cls.push('sold');
      if (it.matchPct != null) cls.push('scored');

      const label = it.matchPct != null
        ? `${it.matchPct}%`
        : (p.soldOut ? 'Sold' : '₹' + priceLabel(it.priceLo));

      // The approximate flag is its own chip, not a character trailing the
      // price: "₹2.9 Cr ~" reads as a price qualifier, which is the one
      // thing it must not mean. What is approximate is the POSITION.
      const html = `<span class="gm-p-l">${esc(label)}</span>`
        + (approx ? `<span class="gm-p-a" title="Approximate — placed at ${esc(it.pos.via || it.pos.area || 'the locality')}, within about ${it.pos.accuracyKm} km of the real address" aria-hidden="true">◍</span>` : '');

      const m = new Overlay(new g.LatLng(node.lat, node.lng), html, {
        className: cls.join(' '),
        aria: `${p.propertyCode || p.name || 'Property'}, ${p.config || ''} ${priceRange(it.priceLo, it.priceHi)}${approx ? ', approximate position' : ''}. Open.`,
        onClick: () => { if (o.onSelect) o.onSelect(p.id); },
        onOver: () => { if (o.onHover) o.onHover(p.id); },
        onOut: () => { if (o.onHover) o.onHover(null); }
      });
      m.setMap(state.map);
      state.markers.set(p.id, m);
    }
  }

  function applyFlags(state) {
    state.markers.forEach((m, id) => {
      const sel = id === state.selectedId;
      const hot = id === state.hoverId;
      m.setSelected(sel);
      m.setHot(hot);
      if (sel || hot) m.raise(); else m.lower();
    });
  }

  // ═══════ CAMERA ═══════

  function fit(state, items, opts) {
    const o = opts || {};
    const g = root.google.maps;
    const pts = (items || []).filter(x => x.pos);
    if (!pts.length) return;
    if (pts.length === 1) {
      state.map.setCenter({ lat: pts[0].pos.lat, lng: pts[0].pos.lng });
      state.map.setZoom(o.maxZoom || 16);
      return;
    }
    const b = new g.LatLngBounds();
    pts.forEach(x => b.extend(new g.LatLng(x.pos.lat, x.pos.lng)));
    state.map.fitBounds(b, o.padding || 64);
    if (o.maxZoom) {
      // fitBounds is async; clamp once it has settled.
      const l = g.event.addListenerOnce(state.map, 'idle', () => {
        if (state.map.getZoom() > o.maxZoom) state.map.setZoom(o.maxZoom);
      });
      void l;
    }
  }

  function panTo(state, id) {
    const it = state.items.find(x => x.p.id === id);
    if (!it || !it.pos) return;
    state.map.panTo({ lat: it.pos.lat, lng: it.pos.lng });
    if (state.map.getZoom() < SPLIT_ZOOM) state.map.setZoom(15);
  }

  function zoomToArea(state, key) {
    const sub = state.items.filter(x => x.pos && (x.pos.via === key || x.pos.label === key));
    if (sub.length) fit(state, sub, { maxZoom: 16 });
  }

  // A draggable marker shown while placing a pin, so the agent sees where it
  // will land before committing.
  function ghostPin(state, pos) {
    const g = root.google.maps;
    if (state.pinGhost) { state.pinGhost.setMap(null); state.pinGhost = null; }
    if (!pos) return;
    const m = new Overlay(new g.LatLng(pos.lat, pos.lng), '<span class="gm-p-l">New pin</span>', { className: 'gm-prop ghost' });
    m.setMap(state.map);
    state.pinGhost = m;
  }

  const api = { load, create, MAP_STYLE, SPLIT_ZOOM, CHENNAI, priceLabel, priceRange, esc };
  root.PinMapCore = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
