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
    for (const it of items || []) {
      if (!it.pos || it.p.id === anchor.p.id) continue;
      if (!o.includeSold && it.p.soldOut) continue;
      const d = geo.haversine(anchor.pos, it.pos);
      // The slop on both ends widens the net, so a property that COULD be
      // inside the radius is not excluded by a centroid's error.
      const slop = (anchor.pos.accuracyKm || 0) + (it.pos.accuracyKm || 0);
      if (d - slop > km) continue;
      out.push(Object.assign({}, it, {
        km: d,
        certain: slop === 0,
        say: geo.sayDistance(d, anchor.pos.accuracyKm, it.pos.accuracyKm)
      }));
    }
    out.sort((a, b) => a.km - b.km);
    return o.limit ? out.slice(0, o.limit) : out;
  }

  // ═══════ DRIVING TIME — the only paid part of "nearby" ═══════

  // Distance Matrix: 25 destinations per request, billed per element. The
  // pre-filter is what keeps "within 30 minutes" to a single request.
  const MATRIX_MAX = 24;
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

    const key = from.lat.toFixed(4) + ',' + from.lng.toFixed(4) + '|' + list.map(t => t.id).join(',');
    if (matrixCache.has(key)) return matrixCache.get(key);

    const g = G();
    const svc = new g.DistanceMatrixService();
    const result = await new Promise(resolve => {
      svc.getDistanceMatrix({
        origins: [new g.LatLng(from.lat, from.lng)],
        destinations: list.map(t => new g.LatLng(t.pos.lat, t.pos.lng)),
        travelMode: o.mode || g.TravelMode.DRIVING,
        // Chennai traffic is the whole reason a client asks "how long", so a
        // free-flow number would be useless. `bestguess` needs a future
        // departure time; now+1min satisfies that without pretending to
        // predict a specific trip.
        drivingOptions: { departureTime: new Date(Date.now() + 60000), trafficModel: 'bestguess' },
        unitSystem: g.UnitSystem.METRIC
      }, (res, status) => {
        if (status !== 'OK' || !res || !res.rows || !res.rows[0]) return resolve(null);
        resolve(res.rows[0].elements);
      });
    });

    const map = new Map();
    if (result) {
      result.forEach((el, i) => {
        if (!el || el.status !== 'OK') return;
        const secs = (el.duration_in_traffic || el.duration || {}).value;
        map.set(list[i].id, {
          km: el.distance ? el.distance.value / 1000 : null,
          mins: secs != null ? Math.round(secs / 60) : null,
          text: el.duration_in_traffic ? el.duration_in_traffic.text : (el.duration || {}).text || null,
          inTraffic: !!el.duration_in_traffic
        });
      });
    }
    matrixCache.set(key, map);
    return map;
  }

  /**
   * "What else is within 30 minutes of here?" — the version an agent asks for
   * out loud. Straight-line filters first (free), then one Distance Matrix
   * request over the nearest candidates.
   */
  async function withinMinutes(anchor, items, mins, opts) {
    const o = opts || {};
    // A generous straight-line net first: at Chennai's ~24 km/h average,
    // 30 minutes is ~12 km of road, which is ~9 km straight. Over-fetching
    // the net slightly is free; under-fetching loses real answers.
    const roadKm = mins * 0.45;
    const candidates = nearbyProperties(anchor, items, { km: roadKm, limit: MATRIX_MAX, includeSold: o.includeSold });
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
  const CATEGORIES = [
    { key: 'school', label: 'Schools', icon: '🎓', types: ['school', 'primary_school', 'secondary_school'] },
    { key: 'hospital', label: 'Hospitals', icon: '🏥', types: ['hospital'] },
    { key: 'transit', label: 'Metro & rail', icon: '🚇', types: ['subway_station', 'train_station', 'transit_station'] },
    { key: 'shopping', label: 'Shopping', icon: '🛍️', types: ['shopping_mall', 'supermarket'] },
    { key: 'college', label: 'Colleges', icon: '🏛️', types: ['university'] },
    { key: 'park', label: 'Parks', icon: '🌳', types: ['park'] },
    { key: 'bank', label: 'Banks & ATMs', icon: '🏦', types: ['bank', 'atm'] },
    { key: 'restaurant', label: 'Places to eat', icon: '🍽️', types: ['restaurant'] }
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

  // The new Places API. `searchNearby` is a static on Place and returns
  // { places }, each a Place with the fields that were requested.
  async function searchNew(pos, cat, radius, o) {
    const g = G();
    const Place = g.places && g.places.Place;
    if (!Place || typeof Place.searchNearby !== 'function') return { error: 'no new places' };
    const { places } = await Place.searchNearby({
      fields: ['displayName', 'location', 'primaryTypeDisplayName', 'rating', 'userRatingCount', 'formattedAddress'],
      locationRestriction: { center: new g.LatLng(pos.lat, pos.lng), radius },
      includedTypes: cat.types,
      maxResultCount: Math.min(20, (o.limit || 8) * 2),
      rankPreference: 'DISTANCE'
    });
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
        type: cat.types[0]
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

  /**
   * Distance and drive time from a property to anything the agent types.
   *
   * @returns { ok, to:{formatted,lat,lng}, straightKm, say, drive:{km,mins,text}|null, note }
   */
  async function distanceTo(fromPos, text, opts) {
    const dest = await geocodeText(text, opts);
    if (!dest) return { ok: false, error: `Could not find “${text}” near Chennai.` };
    const geo = R();
    const straight = geo.haversine(fromPos, dest);
    const times = await travelTimes(fromPos, [{ id: 'q', pos: dest }], opts);
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
      drive,
      note: notes.length ? notes.join('; ') : null
    };
  }

  // A Google Maps directions URL, for when the agent wants to send it to the
  // client or open the real thing. Cheaper and better than reimplementing
  // turn-by-turn.
  function directionsUrl(from, to) {
    const o = `${from.lat},${from.lng}`;
    const d = typeof to === 'string' ? to : `${to.lat},${to.lng}`;
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(o)}&destination=${encodeURIComponent(d)}&travelmode=driving`;
  }

  const api = {
    nearbyProperties, withinMinutes, travelTimes,
    placesNear, CATEGORIES,
    geocodeText, distanceTo, directionsUrl,
    MATRIX_MAX,
    // for tests and for a cache-clear on a data refresh
    _caches: { matrixCache, placeCache, geocodeCache }
  };
  root.PinMapNearby = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
