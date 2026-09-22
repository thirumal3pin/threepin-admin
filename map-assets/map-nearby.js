// ═══════════════════════════════════════════════════════════════════════════
// WHAT IS AROUND IT — the questions an agent gets asked on the call
// ═══════════════════════════════════════════════════════════════════════════
//
// Module 3 of the map view. The whole point of the map is that an agent never
// has to open another tab while a client is on the phone, and these are the
// four things they get asked:
//
//   "What else do you have near there?"   → nearbyProperties()
//   "What schools are nearby?"            → placesNear()
//   "How far is it from my office?"       → distanceTo()
//   "How long to drive it?"               → travelTimes()
//
// ── COST AND TOKEN DISCIPLINE ─────────────────────────────────────────────
//
// Every function here can cost money, so none of them runs on render. They
// run on a click, and:
//
//   · nearbyProperties answers in KILOMETRES for free, from coordinates we
//     already hold. It only calls Google when the agent explicitly asks for
//     DRIVING MINUTES.
//   · Distance Matrix takes 25 destinations per request and bills per
//     element, so candidates are pre-filtered by straight-line distance and
//     only the nearest 24 are ever sent. Asking for "within 30 minutes" over
//     131 properties costs one request, not 131.
//   · Every answer is cached against the thing it describes for the life of
//     the page. Clicking back to a property you already looked at is free.
//
// ── THE API GENERATION MATTERS ────────────────────────────────────────────
//
// Places is called through `google.maps.places.Place.searchNearby` — the new
// Places API — and NOT through the legacy PlacesService. That is not
// stylistic: Google stopped granting legacy Places access to keys created
// after March 2025, so a key this team creates today would silently return
// nothing from the old call. The legacy path is kept only as a fallback for
// an older existing key, and says which one it used.

(function (root) {
  'use strict';

  function G() {
    if (!root.google || !root.google.maps) throw new Error('Maps is not loaded');
    return root.google.maps;
  }
  const R = () => root.PinGeoResolve;

  // ═══════ NEARBY PROPERTIES — free, from what we already hold ═══════

  /**
   * Other properties near one anchor.
   *
   * @param anchor  { p, pos } the property in the middle
   * @param items   [{ p, pos, priceLo, ... }] everything on the map
   * @param opts    { km = 5, limit = 40, includeSold = false }
   * @returns [{ ...item, km, say }] nearest first
   *
   * `say` is the phrase to put on screen, and it is deliberately not just the
   * number: if either end is a locality centroid, the honest answer is a
   * range. An agent reading "1.2 km" off two approximate positions and saying
   * it on a call is exactly the failure this whole design is trying to avoid.
   */
  function nearbyProperties(anchor, items, opts) {
    const o = opts || {};
    const km = o.km == null ? 5 : o.km;
    if (!anchor || !anchor.pos) return [];
    const geo = R();
    const out = [];
    let sold = 0, overBudget = 0;
    for (const it of items || []) {
      if (!it.pos || it.p.id === anchor.p.id) continue;
      const d0 = geo.haversine(anchor.pos, it.pos);
      const slop0 = (anchor.pos.accuracyKm || 0) + (it.pos.accuracyKm || 0);
      const inRange = d0 - slop0 <= km;
      // Counted, not silently dropped: "nothing within 5 km" next to a
      // visible Sold marker reads as a bug, and a hidden price cap reads as
      // a missing property.
      if (it.p.soldOut) { if (inRange) sold++; if (!o.includeSold) continue; }
      if (o.maxPrice != null && it.priceLo != null && it.priceLo > o.maxPrice) { if (inRange) overBudget++; continue; }
      if (!inRange) continue;
      out.push(Object.assign({}, it, {
        km: d0,
        certain: slop0 === 0,
        // The widest honest reading of this row's distance, so a caller can
        // tell whether the headline radius is really true of everything in
        // the list.
        maxKm: d0 + slop0,
        say: geo.sayDistance(d0, anchor.pos.accuracyKm, it.pos.accuracyKm)
      }));
    }
    out.sort((a, b) => a.km - b.km);
    const list = o.limit ? out.slice(0, o.limit) : out;
    // Attached rather than returned separately, so every existing caller
    // keeps working with an array.
    list.excluded = { sold, overBudget };
    list.allCertain = list.every(x => x.maxKm <= km);
    list.widestKm = list.length ? Math.max.apply(null, list.map(x => x.maxKm)) : 0;
    return list;
  }

  // ═══════ DRIVING TIME — the only paid part of "nearby" ═══════
  //
  // Through the ROUTES API, not Distance Matrix. Distance Matrix is a legacy
  // API and Google refuses it to keys created after March 2025 — verified
  // against this deployment's own key, which answers:
  //
  //   "You're calling a legacy API, which is not enabled for your project.
  //    To get newer features and more functionality, switch to the Places
  //    API (New) or Routes API."
  //
  // So every drive time would have failed silently, exactly as legacy Places
  // would have. Routes has no JS SDK wrapper — it is REST only — so this
  // signs its own fetch with the key map-core.js kept from load(). Google
  // serves it with CORS for the calling origin, which is what makes a browser
  // call legitimate rather than a workaround.
  const ROUTES_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

  // TRAFFIC_AWARE caps a matrix at 100 elements. With one origin that is 100
  // destinations — four times what Distance Matrix allowed — but the cap
  // stays low on purpose: it is billed per element, and 24 candidates
  // pre-filtered by straight-line distance answers "within 30 minutes" as
  // well as 100 would.
  const MATRIX_MAX = 24;

  // ── Chennai traffic, stated once ──
  //
  // 0.35 km per minute is ~21 km/h, which is the honest peak-hours average
  // once Kathipara, Madhya Kailash, the OMR toll stretch and GST at
  // Chromepet are counted. ROAD distance also runs about 1.3× straight-line
  // here, so the two have to be applied in the right order — the previous
  // code multiplied minutes by 0.45 and then filtered on STRAIGHT-LINE km,
  // which happened to land in roughly the right place because the optimism
  // and the missing detour factor cancelled out. It worked by luck and would
  // have broken the moment somebody corrected either half.
  const KM_PER_MIN_ROAD = 0.35;
  const ROAD_TO_STRAIGHT = 1 / 1.3;
  const matrixCache = new Map();

  /**
   * Driving distance and duration from one point to several.
   *
   * @param from   {lat,lng}
   * @param tos    [{id, pos}]  — trimmed to the 24 nearest before sending
   * @returns Map(id → { km, mins, text })  — missing ids simply had no route
   */
  async function travelTimes(from, tos, opts) {
    const o = opts || {};
    const list = (tos || []).filter(t => t && t.pos).slice(0, MATRIX_MAX);
    if (!list.length) return new Map();

    // The MODE is part of the key. Without it, asking "how long by metro"
    // after "how long by car" returned the cached driving answer and never
    // called Routes at all — the panel switched its label to Metro and kept
    // the car's number underneath it.
    const ck = (o.mode || 'DRIVE') + '|' + from.lat.toFixed(4) + ',' + from.lng.toFixed(4)
      + '|' + list.map(t => t.id).join(',');
    if (matrixCache.has(ck)) return matrixCache.get(ck);

    const key = (root.PinMapCore && root.PinMapCore.apiKey && root.PinMapCore.apiKey()) || '';
    const map = new Map();
    if (!key) { matrixCache.set(ck, map); return map; }

    try {
      const res = await (o.fetchImpl || fetch)(ROUTES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          // Routes bills by what you ASK for, so the mask is the cost control
          // as much as the response shape. Nothing here is unused.
          'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,condition'
        },
        body: JSON.stringify({
          origins: [{ waypoint: { location: { latLng: { latitude: from.lat, longitude: from.lng } } } }],
          destinations: list.map(t => ({ waypoint: { location: { latLng: { latitude: t.pos.lat, longitude: t.pos.lng } } } })),
          travelMode: o.mode || 'DRIVE',
          // Live traffic. A free-flow number is useless in Chennai — it is
          // the whole reason a client asks "how long".
          routingPreference: 'TRAFFIC_AWARE',
          units: 'METRIC'
        })
      });
      if (!res.ok) { matrixCache.set(ck, map); return map; }
      const rows = await res.json();

      // Routes answers with a FLAT array carrying its own indices, and in no
      // guaranteed order — unlike Distance Matrix's positional rows. Reading
      // it positionally would silently attribute one property's drive time to
      // another, which is worse than no answer at all.
      for (const row of (Array.isArray(rows) ? rows : [])) {
        if (!row || row.condition !== 'ROUTE_EXISTS') continue;
        const t = list[row.destinationIndex];
        if (!t) continue;
        const secs = typeof row.duration === 'string' ? parseInt(row.duration, 10) : null;
        const mins = secs != null && isFinite(secs) ? Math.round(secs / 60) : null;
        map.set(t.id, {
          km: row.distanceMeters != null ? row.distanceMeters / 1000 : null,
          mins,
          text: mins == null ? null : (mins >= 60 ? Math.floor(mins / 60) + ' hr ' + (mins % 60) + ' min' : mins + ' min'),
          inTraffic: true
        });
      }
    } catch (e) {
      // A failed route is not an error state for the panel — it reports "no
      // drive time" and the free straight-line answer still stands.
    }
    matrixCache.set(ck, map);
    return map;
  }

  /**
   * "What else is within 30 minutes of here?" — the version an agent asks for
   * out loud. Straight-line filters first (free), then one Distance Matrix
   * request over the nearest candidates.
   */
  async function withinMinutes(anchor, items, mins, opts) {
    const o = opts || {};
    // Road kilometres first, then converted to the straight-line radius the
    // filter actually works in, with a little slack: over-fetching the net is
    // free, under-fetching silently loses real answers.
    const roadKm = mins * KM_PER_MIN_ROAD;
    const straightKm = roadKm * ROAD_TO_STRAIGHT * 1.15;
    const candidates = nearbyProperties(anchor, items, { km: straightKm, limit: MATRIX_MAX, includeSold: o.includeSold, maxPrice: o.maxPrice });
    if (!candidates.length) return { list: [], truncated: false, priced: false };
    const times = await travelTimes(anchor.pos, candidates.map(c => ({ id: c.p.id, pos: c.pos })), o);
    const list = candidates
      .map(c => Object.assign({}, c, times.get(c.p.id) || {}))
      .filter(c => c.mins != null && c.mins <= mins)
      .sort((a, b) => a.mins - b.mins);
    return {
      list,
      // Said plainly, because it changes what the agent can claim: there may
      // be more beyond the 24 that were checked.
      truncated: candidates.length >= MATRIX_MAX,
      priced: true
    };
  }

  // ═══════ WHAT IS AROUND — schools, hospitals, transit ═══════
  //
  // The categories a Chennai buyer actually asks about, in the order they ask.
  // `types` are Google place types; `keyword` sharpens the ones where the type
  // alone is too broad to be useful.
  // No icons. The console's own chrome is 14px stroked SVG, and eight
  // multi-colour emoji in a warm-grey card did more to make this read as an
  // internal tool than anything else on screen — they cannot be tinted,
  // weighted or baseline-aligned, and they render as each platform's cartoon
  // set. Eight clean labels beat eight cartoons.
  const CATEGORIES = [
    // A bare `school` type returns tuition centres and playschools ahead of
    // the schools people actually buy a house for, and a bare `hospital`
    // returns clinics when the client means multi-speciality. `keyword`
    // sharpens exactly those two.
    { key: 'school', label: 'Schools', types: ['school', 'primary_school', 'secondary_school'],
      keyword: 'matriculation CBSE ICSE international school' },
    { key: 'hospital', label: 'Hospitals', types: ['hospital'], keyword: 'multi speciality hospital' },
    // Buses and share autos are how most of this city commutes, so the bus
    // stand belongs with the metro rather than nowhere.
    { key: 'transit', label: 'Metro, rail & bus', types: ['subway_station', 'train_station', 'transit_station', 'bus_station'] },
    // Asked before restaurants, genuinely. CONCEPTS.devotional in the
    // matcher already knew this mattered; the map did not offer it.
    { key: 'temple', label: 'Temples', types: ['hindu_temple', 'place_of_worship'] },
    { key: 'shopping', label: 'Shops & markets', types: ['shopping_mall', 'supermarket', 'market'] },
    { key: 'pharmacy', label: 'Pharmacy', types: ['pharmacy', 'drugstore'] },
    { key: 'itpark', label: 'IT & tech parks', types: ['corporate_office'], keyword: 'IT park tech park SEZ' },
    { key: 'college', label: 'Colleges', types: ['university'] },
    { key: 'park', label: 'Parks', types: ['park'] },
    { key: 'bank', label: 'Banks & ATMs', types: ['bank', 'atm'] },
    { key: 'restaurant', label: 'Places to eat', types: ['restaurant'] }
  ];

  const placeCache = new Map();

  /**
   * Places of one category near a point.
   *
   * @param pos    {lat,lng}
   * @param key    a CATEGORIES key
   * @param opts   { radius = 2500, limit = 8 }
   * @returns { list:[{name, kind, km, say, rating, ratingCount, pos}], via:'new'|'legacy', error? }
   */
  async function placesNear(pos, key, opts) {
    const o = opts || {};
    const cat = CATEGORIES.find(c => c.key === key);
    if (!cat) return { list: [], error: 'unknown category' };
    const radius = o.radius == null ? 2500 : o.radius;
    const ck = `${pos.lat.toFixed(4)},${pos.lng.toFixed(4)}|${key}|${radius}`;
    if (placeCache.has(ck)) return placeCache.get(ck);

    let res;
    try {
      res = await searchNew(pos, cat, radius, o);
      if (!res || res.error) {
        const legacy = await searchLegacy(pos, cat, radius, o);
        if (legacy && !legacy.error) res = legacy;
      }
    } catch (e) {
      res = { list: [], error: (e && e.message) || 'places failed' };
    }

    const geo = R();
    if (res && res.list) {
      res.list = res.list
        .map(x => Object.assign(x, {
          km: geo.haversine(pos, x.pos),
          say: geo.sayDistance(geo.haversine(pos, x.pos), pos.accuracyKm, 0)
        }))
        .sort((a, b) => a.km - b.km)
        .slice(0, o.limit == null ? 8 : o.limit);
    }
    placeCache.set(ck, res);
    return res;
  }

  // The new Places API. Two calls, chosen by whether the category needs
  // sharpening: `searchNearby` takes types and has NO keyword parameter, so a
  // category that must be narrowed ("multi speciality hospital", not every
  // clinic) goes through `searchByText`, which does. Passing a keyword to
  // searchNearby would have been silently ignored.
  const FIELDS = ['displayName', 'location', 'primaryTypeDisplayName', 'rating', 'userRatingCount', 'formattedAddress'];

  async function searchNew(pos, cat, radius, o) {
    const g = G();
    const Place = g.places && g.places.Place;
    if (!Place) return { error: 'no new places' };
    const max = Math.min(20, (o.limit || 8) * 2);
    const center = new g.LatLng(pos.lat, pos.lng);
    let places;
    if (cat.keyword && typeof Place.searchByText === 'function') {
      const res = await Place.searchByText({
        fields: FIELDS,
        textQuery: cat.keyword,
        locationBias: { center, radius },
        includedType: cat.types[0],
        maxResultCount: max,
        rankPreference: 'DISTANCE'
      });
      places = res.places;
    } else {
      if (typeof Place.searchNearby !== 'function') return { error: 'no new places' };
      const res = await Place.searchNearby({
        fields: FIELDS,
        locationRestriction: { center, radius },
        includedTypes: cat.types,
        maxResultCount: max,
        rankPreference: 'DISTANCE'
      });
      places = res.places;
    }
    return {
      via: 'new',
      list: (places || []).map(p => ({
        name: (p.displayName && (p.displayName.text || p.displayName)) || 'Unnamed',
        kind: (p.primaryTypeDisplayName && (p.primaryTypeDisplayName.text || p.primaryTypeDisplayName)) || cat.label,
        rating: p.rating || null,
        ratingCount: p.userRatingCount || null,
        address: p.formattedAddress || null,
        pos: { lat: p.location.lat(), lng: p.location.lng() }
      }))
    };
  }

  // Kept only for an older key that still has legacy Places enabled. A key
  // created after March 2025 will not, which is why it is the fallback and
  // not the primary.
  function searchLegacy(pos, cat, radius, o) {
    const g = G();
    if (!g.places || !g.places.PlacesService) return Promise.resolve({ error: 'no legacy places' });
    const svc = new g.places.PlacesService(document.createElement('div'));
    return new Promise(resolve => {
      svc.nearbySearch({
        location: new g.LatLng(pos.lat, pos.lng),
        radius,
        type: cat.types[0],
        keyword: cat.keyword || undefined
      }, (results, status) => {
        if (status !== 'OK' || !results) return resolve({ error: 'legacy: ' + status });
        resolve({
          via: 'legacy',
          list: results.map(p => ({
            name: p.name || 'Unnamed',
            kind: cat.label,
            rating: p.rating || null,
            ratingCount: p.user_ratings_total || null,
            address: p.vicinity || null,
            pos: { lat: p.geometry.location.lat(), lng: p.geometry.location.lng() }
          }))
        });
      });
    });
  }

  // ═══════ "HOW FAR IS IT FROM …" ═══════
  //
  // The question with the highest value and the highest chance of being
  // answered wrongly: a client says "my office in Guindy" and the agent needs
  // a number they can say out loud. Geocode what was typed, then one route.
  const geocodeCache = new Map();

  async function geocodeText(text, opts) {
    const o = opts || {};
    const q = String(text || '').trim();
    if (!q) return null;
    if (geocodeCache.has(q)) return geocodeCache.get(q);
    const g = G();
    const gc = new g.Geocoder();
    const bounds = R().BOUNDS;
    const answer = await new Promise(resolve => {
      gc.geocode({
        address: /chennai|tamil\s*nadu/i.test(q) ? q : q + ', Chennai, Tamil Nadu, India',
        componentRestrictions: { country: 'IN' },
        bounds: new g.LatLngBounds(
          new g.LatLng(bounds.south, bounds.west),
          new g.LatLng(bounds.north, bounds.east)
        )
      }, (res, status) => {
        if (status !== 'OK' || !res || !res.length) return resolve(null);
        const r = res[0];
        resolve({
          lat: r.geometry.location.lat(),
          lng: r.geometry.location.lng(),
          formatted: r.formatted_address,
          precise: /ROOFTOP|RANGE_INTERPOLATED/.test(r.geometry.location_type || ''),
          accuracyKm: /ROOFTOP|RANGE_INTERPOLATED/.test(r.geometry.location_type || '') ? 0 : 1.2
        });
      });
    });
    geocodeCache.set(q, answer);
    return answer;
  }

  // The three ways a Chennai client actually travels. Routes serves all of
  // them from one call shape, so offering only DRIVE was leaving the metro
  // question — the commonest one after price — unanswerable.
  const MODES = [
    { key: 'DRIVE', label: 'Driving', verb: 'driving' },
    { key: 'TRANSIT', label: 'Metro & bus', verb: 'by metro or bus' },
    { key: 'WALK', label: 'Walking', verb: 'on foot' }
  ];

  /**
   * Distance and travel time from a property to anything the agent types.
   *
   * @returns { ok, to:{formatted,lat,lng}, straightKm, say, drive:{km,mins,text}|null, mode, note }
   */
  async function distanceTo(fromPos, text, opts) {
    const o = opts || {};
    const dest = await geocodeText(text, o);
    if (!dest) return { ok: false, error: `Could not find “${text}” near Chennai.` };
    const geo = R();
    const straight = geo.haversine(fromPos, dest);
    const mode = o.mode || 'DRIVE';
    const times = await travelTimes(fromPos, [{ id: 'q', pos: dest }], Object.assign({}, o, { mode }));
    const drive = times.get('q') || null;

    // The caveat travels with the answer. If the property is only placed at
    // its locality, a drive time from it is a drive time from the middle of
    // that locality — which is worth knowing before saying "twelve minutes"
    // to a client.
    const notes = [];
    if (fromPos.accuracyKm) notes.push(`measured from ${fromPos.via || 'the locality'}, not the exact address`);
    if (!dest.precise) notes.push('the destination matched an area rather than a building');

    return {
      ok: true,
      to: { formatted: dest.formatted, lat: dest.lat, lng: dest.lng },
      straightKm: straight,
      say: geo.sayDistance(straight, fromPos.accuracyKm, dest.accuracyKm),
      drive, mode,
      modeVerb: (MODES.find(m => m.key === mode) || MODES[0]).verb,
      note: notes.length ? notes.join('; ') : null
    };
  }

  // ═══════ TYPE-AHEAD ═══════
  //
  // The "distance to…" box was blind typing: an agent spelled a landmark, got
  // "could not find", and tried again while a client waited. Autocomplete
  // (New) biased to Chennai turns that into two keystrokes and a pick — and
  // it is the same API family the nearby search already uses.
  const acCache = new Map();

  async function autocomplete(input, opts) {
    const o = opts || {};
    const q = String(input || '').trim();
    if (q.length < 3) return [];
    if (acCache.has(q)) return acCache.get(q);
    const key = (root.PinMapCore && root.PinMapCore.apiKey && root.PinMapCore.apiKey()) || '';
    if (!key) return [];
    let out = [];
    try {
      const res = await (o.fetchImpl || fetch)('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
        body: JSON.stringify({
          input: q,
          // Biased, not restricted: a client's office may sit just outside
          // any box we draw, and a hard restriction would hide it.
          locationBias: { circle: { center: { latitude: (o.near && o.near.lat) || 13.05, longitude: (o.near && o.near.lng) || 80.22 }, radius: 40000 } },
          includedRegionCodes: ['in']
        })
      });
      if (res.ok) {
        const d = await res.json();
        out = (d.suggestions || [])
          .filter(x => x.placePrediction)
          .slice(0, 6)
          .map(x => ({
            text: x.placePrediction.text && x.placePrediction.text.text,
            main: (x.placePrediction.structuredFormat && x.placePrediction.structuredFormat.mainText
              && x.placePrediction.structuredFormat.mainText.text) || null,
            sub: (x.placePrediction.structuredFormat && x.placePrediction.structuredFormat.secondaryText
              && x.placePrediction.structuredFormat.secondaryText.text) || null
          }))
          .filter(x => x.text);
      }
    } catch (e) { out = []; }
    acCache.set(q, out);
    return out;
  }

  // ═══════ GROUND HEIGHT ═══════
  //
  // The SME's largest finding was that flooding is absent from the whole
  // engine, and that marking named localities as flood-prone is a claim only
  // the owner can make. Elevation is the part that is NOT a claim: it is
  // measured, it comes from Google, and in this city it is the single most
  // informative number nobody has been looking at. Anna Nagar sits at ~33 m;
  // Velachery, 11 km away, at ~21 m.
  //
  // It is deliberately reported as height and context, NEVER as "this
  // floods": drainage decides that, not altitude alone, and an agent telling
  // a client a property is safe would be far worse than telling them nothing.
  const elevCache = new Map();

  // Bands read off Chennai's own spread rather than absolute sea level, which
  // is what makes them mean anything here: the metro runs from roughly 2 m on
  // the coast to 50 m inland, and the difference between 8 m and 30 m is the
  // difference every buyer who lived through 2015 is asking about.
  function elevationBand(m) {
    if (m == null) return null;
    if (m < 6) return { key: 'low', say: 'very low-lying for Chennai' };
    if (m < 12) return { key: 'lowish', say: 'low-lying by Chennai standards' };
    if (m < 20) return { key: 'mid', say: 'around the middle of the city\u2019s range' };
    return { key: 'high', say: 'on the higher ground for Chennai' };
  }

  async function elevationOf(pos, opts) {
    const o = opts || {};
    const ck = pos.lat.toFixed(4) + ',' + pos.lng.toFixed(4);
    if (elevCache.has(ck)) return elevCache.get(ck);
    const key = (root.PinMapCore && root.PinMapCore.apiKey && root.PinMapCore.apiKey()) || '';
    if (!key) return null;
    let answer = null;
    try {
      const res = await (o.fetchImpl || fetch)(
        `https://maps.googleapis.com/maps/api/elevation/json?locations=${pos.lat},${pos.lng}&key=${encodeURIComponent(key)}`);
      if (res.ok) {
        const d = await res.json();
        const m = d.status === 'OK' && d.results && d.results[0] ? d.results[0].elevation : null;
        if (m != null) answer = { metres: Math.round(m * 10) / 10, band: elevationBand(m) };
      }
    } catch (e) { answer = null; }
    elevCache.set(ck, answer);
    return answer;
  }

  // ═══════ STREET VIEW ═══════
  //
  // "What does the road look like?" is asked on almost every call, and the
  // answer was another tab. The metadata endpoint is FREE, so it is checked
  // first and the billed image is only requested when a panorama actually
  // exists — otherwise the card would show Google's grey "no imagery" tile
  // and charge for it.
  async function streetView(pos, opts) {
    const o = opts || {};
    const key = (root.PinMapCore && root.PinMapCore.apiKey && root.PinMapCore.apiKey()) || '';
    if (!key) return null;
    try {
      const res = await (o.fetchImpl || fetch)(
        `https://maps.googleapis.com/maps/api/streetview/metadata?location=${pos.lat},${pos.lng}&key=${encodeURIComponent(key)}`);
      if (!res.ok) return null;
      const d = await res.json();
      if (d.status !== 'OK') return null;
      const size = o.size || '336x150';
      return {
        // `date` is why this is worth showing rather than just linking: an
        // agent should know whether they are describing a 2026 street or a
        // 2014 one.
        date: d.date || null,
        img: `https://maps.googleapis.com/maps/api/streetview?size=${size}&location=${pos.lat},${pos.lng}&fov=80&pitch=6&key=${encodeURIComponent(key)}`,
        open: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${pos.lat},${pos.lng}`
      };
    } catch (e) { return null; }
  }

  // A Google Maps directions URL, for when the agent wants to send it to the
  // client or open the real thing. Cheaper and better than reimplementing
  // turn-by-turn.
  // A null `from` deliberately omits the origin, which makes Google route
  // from the DEVICE's location — the only origin an agent standing in the
  // street actually wants. Passing the property as both ends produced a
  // zero-length route, which is what the Directions button used to do.
  const GMAPS_MODE = { DRIVE: 'driving', TRANSIT: 'transit', WALK: 'walking' };

  function directionsUrl(from, to, mode) {
    const d = typeof to === 'string' ? to : `${to.lat},${to.lng}`;
    const m = GMAPS_MODE[mode] || mode || 'driving';
    const parts = ['api=1', 'destination=' + encodeURIComponent(d), 'travelmode=' + m];
    if (from && from.lat != null) parts.unshift('origin=' + encodeURIComponent(`${from.lat},${from.lng}`));
    return 'https://www.google.com/maps/dir/?' + parts.join('&');
  }

  const api = {
    KM_PER_MIN_ROAD, ROAD_TO_STRAIGHT, ROUTES_URL, MODES,
    nearbyProperties, withinMinutes, travelTimes,
    placesNear, CATEGORIES,
    autocomplete, elevationOf, elevationBand, streetView,
    geocodeText, distanceTo, directionsUrl,
    MATRIX_MAX,
    // for tests and for a cache-clear on a data refresh
    _caches: { matrixCache, placeCache, geocodeCache, acCache, elevCache }
  };
  root.PinMapNearby = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
