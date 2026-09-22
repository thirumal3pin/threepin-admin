// ═══════════════════════════════════════════════════════════════════════════
// WHERE IS THIS PROPERTY? — the one answer, and how sure we are of it
// ═══════════════════════════════════════════════════════════════════════════
//
// Module 1 of the map view. Nothing here draws anything: it turns a property
// into a coordinate plus a HONESTY LABEL, and every other map module reads
// that and nothing else.
//
// ── THE PROBLEM ───────────────────────────────────────────────────────────
//
// A map needs latitude and longitude. The inventory has neither. 52 of 131
// properties carry a Location Pin, and not one of them contains a coordinate:
// they are shortened maps.app.goo.gl links, which cannot be resolved from a
// browser (the redirect is cross-origin), or somebody has typed the project's
// name into the URL column.
//
// So "just plot the pins" renders an empty map. The positions have to be
// worked out, and the only responsible way to show a worked-out position is
// to say that is what it is.
//
// ── THE LADDER ────────────────────────────────────────────────────────────
//
// In order, stopping at the first that answers:
//
//   1. exact     p.geo — an agent dropped the pin, or a geocode was run and
//                cached. This is the building. Written once, trusted after.
//   2. exact     coordinates parsed out of the Location Pin URL, when it is a
//                full Google Maps link rather than a short one. Free, offline,
//                and the common case when an agent pastes from desktop Maps.
//   3. approx    the locality centroid from the area model — which already
//                knows where Anna Nagar is, and that "I Block" is inside Anna
//                Nagar East. Free, offline, needs no API key and no geocoding
//                bill for 131 properties.
//   4. nothing   the area model has never heard of this locality either. The
//                property goes on the "needs a pin" list. It is NOT dropped
//                silently and NOT guessed at the middle of Chennai.
//
// ── WHY PRECISION TRAVELS WITH THE POSITION ───────────────────────────────
//
// Rung 3 is a locality centroid. It is right to within a kilometre or two and
// it is NOT the building. An agent on the phone to a client will read whatever
// the map shows them, so a marker that is 1.5 km out must not look identical
// to one that is on the doorstep. `precision` drives the marker, the tile and
// the wording, and any distance computed from an approximate position is
// quoted as approximate all the way down.
//
// Getting this wrong is worse than having no map: it turns a good tool into a
// confident source of wrong answers in front of a customer.
//
// Pure, no DOM, no network, no Google dependency — the geocoder is injected
// so tests run offline and so the whole module works with no API key at all.

(function (root) {
  'use strict';

  // ═══════ COORDINATE SANITY ═══════
  //
  // The Chennai metropolitan area, generously. Anything outside it is a
  // parsing accident, not a property — a swapped lat/lng, a stray number out
  // of a URL, a pin dropped on the wrong continent by a mis-click.
  const BOUNDS = { south: 12.4, north: 13.6, west: 79.6, east: 80.6 };

  function inChennai(lat, lng) {
    return isFinite(lat) && isFinite(lng)
      && lat >= BOUNDS.south && lat <= BOUNDS.north
      && lng >= BOUNDS.west && lng <= BOUNDS.east;
  }

  // Latitude and longitude the wrong way round is the single most common way
  // a coordinate arrives broken. Chennai's two ranges do not overlap, so it
  // is detectable and correctable rather than just rejectable.
  function orient(a, b) {
    if (inChennai(a, b)) return { lat: a, lng: b };
    if (inChennai(b, a)) return { lat: b, lng: a };
    return null;
  }

  // ═══════ RUNG 2 — COORDINATES OUT OF A MAPS URL ═══════
  //
  // Every shape a Google Maps link arrives in. Ordered most-specific first:
  // !3d/!4d is the place's own coordinate and beats @, which is only where
  // the camera happened to be sitting.
  const URL_PATTERNS = [
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,                 // place data, the truest
    /[?&#](?:q|query|daddr|destination|ll|center|sll)=(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/i,
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,                     // camera position
    /\/(-?\d+\.\d+),(-?\d+\.\d+)(?:[,/?#]|$)/,        // bare path pair
    /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/         // somebody pasted the numbers
  ];

  function coordsFromMapLink(url) {
    const s = String(url == null ? '' : url);
    if (!s || s.length > 2000) return null;
    for (const re of URL_PATTERNS) {
      const m = re.exec(s);
      if (!m) continue;
      const o = orient(parseFloat(m[1]), parseFloat(m[2]));
      if (o) return o;
    }
    return null;
  }

  // A short link carries no coordinate and cannot be followed from a browser.
  // Worth detecting explicitly so the UI can say "this pin needs opening
  // once" rather than "no pin", which would be untrue and would send an agent
  // hunting for something that is already there.
  const SHORT_LINK = /(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)/i;
  const isShortMapLink = url => SHORT_LINK.test(String(url || ''));

  // And plenty of Location Pin cells are not URLs at all — somebody typed the
  // project name into the column.
  const looksLikeUrl = url => /^\s*(?:https?:)?\/\//i.test(String(url || ''));

  // ═══════ THE LADDER ═══════

  /**
   * Where a property is, and how sure we are.
   *
   * @param p       the property
   * @param opts    { area }  an area model (shared-assets/area-model.js) for
   *                rung 3. Without one, rung 3 falls back to the anchor
   *                gazetteer alone, which knows fewer places.
   * @returns {{
   *   lat:number, lng:number,
   *   precision:'exact'|'approx',
   *   source:'pin'|'geocoded'|'maplink'|'locality',
   *   label:string,           what to tell the user this position IS
   *   accuracyKm:number|null, how wrong it could be
   *   via:string|null         the area it was placed through, for rung 3
   * } | null}
   */
  function positionOf(p, opts) {
    const o = opts || {};
    if (!p) return null;

    // ── 1. A stored position. An agent put it there, or a geocode did. ──
    const g = p.geo;
    if (g && inChennai(Number(g.lat), Number(g.lng))) {
      const src = g.source === 'geocoded' ? 'geocoded' : 'pin';
      // A geocode of a STREET is a building; a geocode that only resolved to
      // the locality is not, and says so via its own stored precision.
      const approx = g.precision === 'approx';
      return {
        lat: Number(g.lat), lng: Number(g.lng),
        precision: approx ? 'approx' : 'exact',
        source: src,
        label: src === 'pin'
          ? 'Pin placed by the team'
          : (approx ? 'Geocoded to the locality only' : 'Geocoded from the address'),
        accuracyKm: approx ? 1.5 : null,
        via: null
      };
    }

    // ── 2. A full Maps URL in the Location Pin column. ──
    const fromLink = coordsFromMapLink(p.mapLink);
    if (fromLink) {
      return {
        lat: fromLink.lat, lng: fromLink.lng,
        precision: 'exact', source: 'maplink',
        label: 'From the Location Pin link',
        accuracyKm: null, via: null
      };
    }

    // ── 3. The locality, from the area model. ──
    const approx = localityPosition(p, o.area);
    if (approx) return approx;

    // ── 4. Genuinely unknown. Never guessed. ──
    return null;
  }

  // Rung 3. Uses the area model when the caller has one — it knows the
  // hierarchy, so "TNHB East Avenue, Korattur" resolves through Korattur —
  // and the anchor gazetteer otherwise.
  function localityPosition(p, area) {
    const geo = root.PinGeo;
    if (!geo) return null;
    const text = [p.location, p.name, p.nearbyLandmark, p.connectivity].filter(Boolean).join(' , ');
    if (!text) return null;

    // The area model first: it can place a street or a colony through its
    // parent, which the flat gazetteer cannot.
    if (area && area.nodeFor) {
      for (const seg of String(p.location || '').split(/[,\/]/)) {
        const node = area.nodeFor(seg.trim());
        if (!node) continue;
        const pos = nodePosition(node, area);
        if (!pos) continue;
        return {
          lat: pos.lat, lng: pos.lng,
          precision: 'approx', source: 'locality',
          label: pos.via ? `Placed at ${pos.label} (via ${pos.via})` : `Placed at ${pos.label}`,
          accuracyKm: pos.accuracyKm,
          via: pos.via || pos.label
        };
      }
    }

    // The gazetteer.
    for (const key of geo.resolveAll(text)) {
      const c = geo.LOCALITIES[key];
      if (!c) continue;
      return {
        lat: c[0], lng: c[1],
        precision: 'approx', source: 'locality',
        label: `Placed at ${geo.label(key)}`,
        accuracyKm: 1.5, via: geo.label(key)
      };
    }
    return null;
  }

  // An area-model node's coordinate, following a sub-area up to whichever
  // ancestor actually has one.
  function nodePosition(node, area) {
    let cur = node, hops = 0, via = null;
    while (cur && !cur.pos && cur.parent && hops < 6) {
      via = cur.label;
      cur = area.nodes.get(cur.parent);
      hops++;
    }
    if (!cur || !cur.pos) return null;

    // Name the LOCALITY, not the street. A street or a colony gets its
    // position by inheriting its parent's, so "Placed at TNHB East Avenue
    // ±1.5 km" claims we know where a specific avenue is when what we
    // actually know is Korattur. An agent reading this aloud needs the name
    // that is true — and the street still travels, as the `via`, because it
    // is how the property was found.
    let anchorLabel = cur.label, anchorVia = hops ? via : null;
    if (!anchorVia && (node.kind === 'street' || node.kind === 'sub') && node.parent) {
      const parent = area.nodes.get(node.parent);
      if (parent) { anchorLabel = parent.label; anchorVia = node.label; }
    }

    // An estimated position is less certain than an anchored one, and a
    // position inherited from a parent is less certain again.
    const conf = cur.posConfidence == null ? 1 : cur.posConfidence;
    const inherited = hops > 0 || !!anchorVia;
    const accuracyKm = cur.seeded
      ? (inherited ? 2 : 1.5)
      : Math.max(1.5, 4 * (1 - conf) + 1.5);
    return {
      lat: cur.pos[0], lng: cur.pos[1],
      label: anchorLabel,
      via: anchorVia,
      accuracyKm: Math.round(accuracyKm * 10) / 10
    };
  }

  // ═══════ WHAT NEEDS A PIN ═══════
  //
  // "Needs a pin" is not the same as "has no position". A property sitting at
  // its locality centroid IS on the map and is useful there — it just cannot
  // be quoted to a client as an address. Both states are surfaced, separately,
  // because they need different actions: one wants precision, the other
  // wants any position at all.
  const PIN_STATE = {
    exact: 'exact',        // on the doorstep
    approx: 'approx',      // in the right neighbourhood, wants sharpening
    missing: 'missing',    // nowhere — not on the map at all
    snoozed: 'snoozed'     // the team has said this one does not need one
  };

  function pinState(p, opts) {
    if (p && p.mapPinSnoozed) return PIN_STATE.snoozed;
    const pos = positionOf(p, opts);
    if (!pos) return PIN_STATE.missing;
    return pos.precision === 'exact' ? PIN_STATE.exact : PIN_STATE.approx;
  }

  // Why this property still wants attention, in words an agent can act on.
  function pinAdvice(p, opts) {
    const st = pinState(p, opts);
    if (st === PIN_STATE.snoozed) return null;
    if (st === PIN_STATE.exact) return null;
    if (st === PIN_STATE.missing) {
      const hasLink = looksLikeUrl(p.mapLink);
      if (hasLink && isShortMapLink(p.mapLink)) {
        return {
          state: st, severity: 'high',
          why: 'The Location Pin is a shortened link, which cannot be read for coordinates.',
          fix: 'Open it once and paste the full URL, or drop the pin on the map.'
        };
      }
      if (p.mapLink && !hasLink) {
        return {
          state: st, severity: 'high',
          why: 'The Location Pin column holds a name, not a link.',
          fix: 'Drop the pin on the map, or paste a Google Maps URL.'
        };
      }
      return {
        state: st, severity: 'high',
        why: 'No pin, and the locality is not one the area map recognises.',
        fix: 'Drop the pin on the map — it is the only way this property becomes findable by location.'
      };
    }
    const pos = positionOf(p, opts);
    return {
      state: st, severity: 'low',
      why: `Shown at ${pos.via || 'its locality'}, so it is within about ${pos.accuracyKm} km of where it really is.`,
      fix: 'Drop the pin to place it exactly — worth doing before quoting a distance to a client.'
    };
  }

  // ═══════ WRITING A POSITION BACK ═══════
  //
  // Returns a patch, never saves: the page owns persistence, and a pure patch
  // is testable. `geo` is a new field on the property document — the sheet
  // sync does not know about it, so a Sync from Sheet cannot wipe a pin the
  // team placed (saveProperty merges, and FIELD_MAP has no column for it).
  function pinPatch(lat, lng, by) {
    const o = orient(Number(lat), Number(lng));
    if (!o) return null;
    return {
      geo: {
        lat: Math.round(o.lat * 1e6) / 1e6,     // ~10 cm; more is noise
        lng: Math.round(o.lng * 1e6) / 1e6,
        source: 'pin',
        precision: 'exact',
        at: Date.now(),
        by: by || null
      },
      mapPinSnoozed: false
    };
  }

  function geocodedPatch(lat, lng, precision, formatted) {
    const o = orient(Number(lat), Number(lng));
    if (!o) return null;
    return {
      geo: {
        lat: Math.round(o.lat * 1e6) / 1e6,
        lng: Math.round(o.lng * 1e6) / 1e6,
        source: 'geocoded',
        precision: precision === 'approx' ? 'approx' : 'exact',
        formatted: formatted || null,
        at: Date.now(),
        by: 'geocoder'
      }
    };
  }

  const snoozePatch = by => ({ mapPinSnoozed: true, mapPinSnoozedBy: by || null, mapPinSnoozedAt: Date.now() });
  const unsnoozePatch = () => ({ mapPinSnoozed: false });

  // ═══════ GEOCODING ═══════
  //
  // The only rung that costs money, so it is never automatic and never
  // batched over the whole inventory: rung 3 already puts everything on the
  // map for free. This runs when an agent asks for one property to be placed
  // precisely, and the answer is cached on the document for ever.
  //
  // The geocoder is injected (`geocode` returns a promise of Google's
  // results array) so this is testable offline and so the module loads with
  // no API key present.
  //
  // Chennai is bounded and the country is fixed, which stops "Anna Nagar"
  // resolving to a street of that name in another state.
  function addressFor(p) {
    const parts = [];
    if (p.name && !/^\d+$/.test(String(p.name))) parts.push(p.name);
    if (p.location) parts.push(p.location);
    const s = parts.join(', ');
    return /chennai/i.test(s) ? s + ', Tamil Nadu, India' : s + ', Chennai, Tamil Nadu, India';
  }

  // Google's location_type, mapped onto our two-value precision. ROOFTOP and
  // RANGE_INTERPOLATED are a building; GEOMETRIC_CENTER and APPROXIMATE are a
  // locality or a road, which is rung 3 accuracy wearing a smarter hat — and
  // must be labelled as such rather than promoted.
  const EXACT_TYPES = { ROOFTOP: 1, RANGE_INTERPOLATED: 1 };

  async function geocodeProperty(p, geocode, opts) {
    const o = opts || {};
    if (typeof geocode !== 'function') return { ok: false, error: 'no geocoder' };
    const address = addressFor(p);
    try {
      const results = await geocode({
        address,
        componentRestrictions: { country: 'IN', administrativeArea: 'Tamil Nadu' },
        bounds: BOUNDS
      });
      const r = (results || [])[0];
      if (!r || !r.geometry || !r.geometry.location) return { ok: false, error: 'not found', address };
      const loc = r.geometry.location;
      const lat = typeof loc.lat === 'function' ? loc.lat() : loc.lat;
      const lng = typeof loc.lng === 'function' ? loc.lng() : loc.lng;
      if (!inChennai(lat, lng)) return { ok: false, error: 'outside Chennai', address, lat, lng };
      const type = r.geometry.location_type || '';
      const precision = EXACT_TYPES[type] ? 'exact' : 'approx';
      const patch = geocodedPatch(lat, lng, precision, r.formatted_address);
      return patch
        ? { ok: true, patch, precision, formatted: r.formatted_address, type, address }
        : { ok: false, error: 'rejected', address };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'geocode failed', address };
    }
  }

  // ═══════ DISTANCE ═══════
  //
  // Straight-line kilometres. Road distance in Chennai runs about 1.3× this,
  // which is why anything shown to a user is either banded or comes from the
  // Distance Matrix in map-nearby.js.
  const R_KM = 6371;
  const rad = d => d * Math.PI / 180;

  function haversine(a, b) {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // How a distance is allowed to be SAID, given how sure we are of both ends.
  // Two approximate positions 1.2 km apart could be anywhere from touching to
  // 4 km apart, and an agent must not read "1.2 km" off that.
  function sayDistance(km, fromAcc, toAcc) {
    const slop = (fromAcc || 0) + (toAcc || 0);
    if (km < 0.4 && slop === 0) return 'a few hundred metres';
    if (!slop) return km < 1 ? `${Math.round(km * 10) / 10} km` : `${Math.round(km)} km`;
    const lo = Math.max(0, km - slop), hi = km + slop;
    if (hi <= 1.5) return 'under a kilometre or so';
    if (Math.round(lo) === Math.round(hi)) return `about ${Math.round(hi)} km`;
    return `roughly ${Math.max(1, Math.round(lo))}–${Math.round(hi)} km`;
  }

  // ═══════ BULK ═══════
  //
  // Positions for a whole list in one pass, with the counts the UI needs for
  // its banner. Cached against the list identity like every other pass over
  // the inventory in this codebase.
  const cache = new WeakMap();

  function locate(list, opts) {
    const o = opts || {};
    if (!Array.isArray(list)) return { placed: [], missing: [], snoozed: [], counts: {} };
    if (!o.force) {
      const hit = cache.get(list);
      if (hit && hit.areaKey === (o.area || null)) return hit.result;
    }
    const placed = [], missing = [], snoozed = [];
    for (const p of list) {
      if (p.mapPinSnoozed) { snoozed.push({ p }); continue; }
      const pos = positionOf(p, o);
      if (pos) placed.push({ p, pos });
      else missing.push({ p, advice: pinAdvice(p, o) });
    }
    const result = {
      placed, missing, snoozed,
      counts: {
        total: list.length,
        exact: placed.filter(x => x.pos.precision === 'exact').length,
        approx: placed.filter(x => x.pos.precision === 'approx').length,
        missing: missing.length,
        snoozed: snoozed.length
      }
    };
    cache.set(list, { areaKey: o.area || null, result });
    return result;
  }

  const api = {
    positionOf, pinState, pinAdvice, locate,
    coordsFromMapLink, isShortMapLink, looksLikeUrl,
    pinPatch, geocodedPatch, snoozePatch, unsnoozePatch,
    geocodeProperty, addressFor,
    haversine, sayDistance, inChennai, orient,
    BOUNDS, PIN_STATE
  };
  root.PinGeoResolve = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
