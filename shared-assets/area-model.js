// ═══════════════════════════════════════════════════════════════════════════
// AREA MODEL — Chennai's area map, learned from the inventory
// ═══════════════════════════════════════════════════════════════════════════
//
// THE PROBLEM THIS EXISTS TO SOLVE
//
// Matching needs to answer "how near is this property to where the buyer is
// looking". The obvious way is a table of localities and their coordinates.
// That way is wrong here, and the reason is worth writing down so nobody
// rebuilds it:
//
//   · Nobody can maintain it. The inventory names 144 distinct location
//     segments today and gains new ones every week — a new layout, a new
//     block, a colony nobody outside it has heard of.
//   · The map links cannot help. 52 properties carry one and NOT ONE has
//     coordinates in it: they are shortened maps.app.goo.gl links, or just a
//     project name typed into the column. There is no lat/lng in this data.
//   · Most of the unmappable names are not areas. "I Block", "W Block",
//     "10th Street", "TNHB East Avenue", "Sripuram Lane", "Officers Colony" —
//     these are streets and blocks. Geocoding them individually would be
//     absurd. They do not need a position of their own. They need a PARENT.
//
// And the parent is already written down. 114 of 131 location cells are a
// comma-separated hierarchy, narrow to broad:
//
//     10th Street → I Block → Anna Nagar East → Chennai
//     TNHB East Avenue → Korattur → Chennai - 600080
//     Mahalingapuram → Nungambakkam → Chennai
//     Next to Neelankarai → Akkarai → ECR → Chennai
//
// So does the proximity. 42 properties state a distance or a travel time to
// something in the landmark and connectivity columns, and that something is
// very often another area:
//
//     "10 Mins from Anna Nagar Roundtana"          (Mogappair)
//     "500m to Ayanavaram Metro"                   (Ayanavaram)
//     "Approx 1.5 Km from Pachaiappa Metro Station" (Chetpet)
//     "Close to Kalakshetra road in thiruvanmiyur,
//      Near to Shastri Nagar in adyar"             (Sivagamipuram)
//
// Read that as data and Sivagamipuram — which no table contains — is placed
// between Thiruvanmiyur and Adyar, from the sheet alone.
//
// ── WHAT THE MODEL IS ──────────────────────────────────────────────────────
//
// A weighted graph over area names, plus a semi-supervised position estimate.
//
//   NODES   every area name the inventory mentions, classified as a
//           locality, a sub-area (block/street/colony) or a corridor.
//   EDGES   evidence that two areas are near each other, each tagged with
//           what the evidence was and how strong it is:
//
//             contains    1.00   a sub-area inside its locality — the comma
//                                hierarchy. Effectively distance zero.
//             measured    0.90   a stated distance or travel time between two
//                                areas, read out of the landmark text.
//             adjacent    0.80   "Next to Neelankarai" — a proximity phrase
//                                naming a known area.
//             co-cell     0.70   two areas named in one cell ("Gerugambakkam
//                                / Porur") — an agent writing both means both.
//             landmark    0.25…0.6  areas sharing a distinctive landmark. A
//                                school two properties both cite is strong
//                                evidence; "Chennai Airport", cited by
//                                twenty, is none, so the weight is scaled by
//                                how rare the landmark is.
//             corridor    0.30   both on OMR / ECR / GST.
//             zone        0.10   both in the same one of the sheet's four
//                                zones. The weakest thing we know.
//
//   POSITIONS  Known coordinates (chennai-geo.js, which is now an ANCHOR set,
//           not the source of truth) are held fixed. Every other connected
//           node's position is solved by harmonic propagation: repeatedly set
//           each unknown node to the weighted mean of its neighbours until it
//           stops moving. This is the standard semi-supervised label
//           propagation, and on this graph it converges in well under a
//           hundred passes.
//
// ── WHAT IT REPORTS, AND HOW HONESTLY ──────────────────────────────────────
//
// proximity(a, b) returns a similarity AND how it knew:
//
//     basis 'same' | 'contains'      — certain
//     basis 'anchored'               — both ends are anchor localities
//     basis 'estimated'              — one or both positions were solved;
//                                      `confidence` says how well, and km is
//                                      reported as a band, never a figure
//     basis 'graph'                  — no position at all; similarity comes
//                                      from the decayed shortest path
//     basis 'unknown'                — genuinely nothing. Never scored as
//                                      "far": absence of evidence is not
//                                      evidence of distance.
//
// That last line is the rule the whole file is built around. A model that
// guesses "far" for an area it has not heard of will quietly hide the right
// property from the right buyer, and nobody will ever know it happened.
//
// Pure, no DOM, no network. Plain script (window.PinAreaModel) + module.exports.

(function (root) {
  'use strict';

  function geo() {
    const g = root.PinGeo;
    if (!g) throw new Error('PinAreaModel needs PinGeo (shared-assets/chennai-geo.js) loaded first');
    return g;
  }

  // ═══════ EDGE STRENGTHS ═══════
  // One table, because these numbers are the model's entire prior and they
  // must be readable in one place.
  const W = {
    contains: 1.00,
    measured: 0.90,     // a distance in km or metres — the sheet measuring
    timed: 0.65,        // a travel TIME, which is a brochure's claim, not a measurement
    adjacent: 0.80,     // "Next to Neelankarai" in the Location column: the agent
                        // saying where the property is
    cocell: 0.70,
    nearby: 0.45,       // an area named in the landmark column with no distance —
                        // marketing copy, so weaker than the two above
    landmarkMax: 0.60,
    landmarkMin: 0.25,
    corridor: 0.30,
    zone: 0.10
  };

  // How near a DIRECT link of each kind implies two areas are, before any
  // decay. Used when there is no position to compare — a basis is far more
  // interpretable than a raw edge weight, and this is the table the fallback
  // ladder in the matcher mirrors.
  const BASIS_SIM = {
    contains: 1.00, measured: 0.85, timed: 0.75, adjacent: 0.85,
    cocell: 0.80, nearby: 0.60, landmark: 0.50, corridor: 0.55, zone: 0.30
  };

  // Only evidence at least this strong is allowed to carry a position. Zone
  // and generic-landmark edges connect half the city to the other half; using
  // them to place a node would drag every unknown area to the middle of
  // Chennai and make the estimate worse than no estimate.
  const POSITION_MIN_W = 0.45;

  // Chennai traffic, for turning a stated travel time into a distance. ~24
  // km/h inside the city is the honest average once signals are counted, so
  // a minute is about 400 m. Used only to ORDER candidates, never quoted.
  const KM_PER_MIN = 0.4;

  // ═══════ TEXT ═══════

  const clean = s => String(s == null ? '' : s)
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  // Prepositions that mark a segment as pointing AT somewhere rather than
  // containing the property. "Next to Neelankarai" is not a container; it is
  // the single most useful sentence in the cell.
  const NEAR_PREFIX = /^(?:next\s+to|near(?:\s+to)?|close\s+to|opp(?:osite)?(?:\s+to)?|off|behind|beside|adjacent\s+to|bang\s+on|just\s+off|abutting)\s+/i;

  // Things that are an address, not an area.
  const IS_ADDRESS = /^(?:no\.?\s*\d|plot\s*no|door\s*no|survey\s*no|#\s*\d|\d+\s*&\s*\d+|flat\s*no)/i;
  const IS_CITY = /^(?:chennai|madras|tamil\s*nadu|india)\b|^\d{3}\s?\d{3}$|^6\d{5}$/i;
  const HAS_PIN = /\b6\d{2}\s?\d{3}\b/;

  // A segment that is a street or a block rather than a named area. These
  // become sub-areas: they inherit a position and are searchable, but they
  // never act as anybody's parent.
  const IS_STREET = /\b(?:street|st\.?|road|rd\.?|lane|avenue|ave\.?|main\s*road|cross\s*street|salai|bazaar|block)\b/i;

  const CORRIDOR_RE = [
    { key: 'OMR', re: /\bomr\b|old\s*mahabalipuram|rajiv\s*gandhi\s*salai/i },
    { key: 'ECR', re: /\becr\b|east\s*coast\s*road/i },
    { key: 'GST', re: /\bgst\b|grand\s*southern\s*trunk/i },
    { key: 'Radial Road', re: /radial\s*road/i },
    { key: 'Mount-Poonamallee', re: /mount\s*-?\s*poonamallee/i },
    { key: 'Velachery-Tambaram', re: /velachery\s*-?\s*tambaram/i }
  ];

  const corridorOfSegment = s => (CORRIDOR_RE.find(c => c.re.test(s)) || {}).key || null;

  // The key a name is stored under. Falls through to a normalised form of the
  // name itself when the anchor gazetteer has never heard of it — which is
  // the whole point: an unknown area still becomes a first-class node.
  function keyOf(name) {
    const g = geo();
    const seeded = g.resolve(name);
    if (seeded) return seeded;
    return g.norm(name);
  }

  // ═══════ DISTANCE PHRASES ═══════
  //
  // "10 Mins from Anna Nagar Roundtana" → { km: 4, target: 'anna nagar' }
  // "Radial Road - 3 Kms"               → { km: 3, target: 'radial road' }
  // "500m to Ayanavaram Metro"          → { km: 0.5, target: 'ayanavaram' }
  // "Approx 1.5 Km from Pachaiappa Metro Station" → km only, no known target
  //
  // Returns { km, rest } where `rest` is the phrase with the measurement
  // removed, so the caller can try to resolve an area out of what is left.
  // Every unit is closed with (?![a-z]) — a negative lookahead for another
  // letter. Without it the metres pattern matches the "10 M" inside "10 Mins
  // from Anna Nagar Roundtana" and reads ten minutes as ten METRES: a 4 km
  // neighbour becomes a 0.01 km one, and the propagation below then pins two
  // areas on opposite sides of the city to the same point. Minutes are tried
  // before metres as well, so the intent is clear even if a lookahead is ever
  // dropped again.
  const DIST_PATTERNS = [
    { re: /^\s*(?:approx(?:imately)?\.?\s*|about\s*|just\s*|only\s*)?(\d+(?:\.\d+)?)\s*(?:km|kms|kilometers?|kilometres?)(?![a-z])\s*(?:from|to|away\s*from)?\s*/i, unit: 'km' },
    { re: /^\s*(?:approx(?:imately)?\.?\s*|about\s*|just\s*|only\s*)?(\d+(?:\.\d+)?)\s*(?:mins?|minutes?)(?![a-z])\s*(?:from|to|drive\s*from|away\s*from|by\s*car)?\s*/i, unit: 'min' },
    { re: /^\s*(?:approx(?:imately)?\.?\s*|about\s*|just\s*|only\s*)?(\d+(?:\.\d+)?)\s*(?:m|mtr|meters?|metres?)(?![a-z])\s*(?:from|to|away\s*from)?\s*/i, unit: 'm' },
    { re: /\s*[-–—,]?\s*(?:approx(?:imately)?\.?\s*|about\s*)?(\d+(?:\.\d+)?)\s*(?:km|kms|kilometers?|kilometres?)(?![a-z])\s*$/i, unit: 'km' },
    { re: /\s*[-–—,]?\s*(?:approx(?:imately)?\.?\s*|about\s*)?(\d+(?:\.\d+)?)\s*(?:mins?|minutes?)(?![a-z])\s*$/i, unit: 'min' },
    { re: /\s*[-–—,]?\s*(?:approx(?:imately)?\.?\s*|about\s*)?(\d+(?:\.\d+)?)\s*(?:m|mtr|meters?|metres?)(?![a-z])\s*$/i, unit: 'm' }
  ];

  // → { km, unit: 'km'|'m'|'min'|null, rest }
  //
  // `unit` travels with the answer because a stated TIME is a different class
  // of evidence from a stated distance: "5 mins to Sholinganallur" is a
  // brochure's claim and is weighted as W.timed, while "3 Kms" is the sheet
  // measuring and is weighted as W.measured.
  function readDistance(phrase) {
    let rest = clean(phrase);
    for (const pat of DIST_PATTERNS) {
      const m = pat.re.exec(rest);
      if (!m) continue;
      const n = Number(m[1]);
      if (!isFinite(n) || n <= 0) continue;
      const km = pat.unit === 'km' ? n
        : pat.unit === 'm' ? n / 1000
          : n * KM_PER_MIN;
      // Under 100 m is a rounding artefact, not a measurement between two
      // areas; over 40 km is a different city, not a neighbour.
      if (km < 0.1 || km > 40) continue;
      rest = clean(rest.replace(m[0], ' '));
      return { km, unit: pat.unit, rest };
    }
    return { km: null, unit: null, rest };
  }

  // Landmark phrases carry an area name inside them far more often than they
  // are one: "Kalakshetra road in thiruvanmiyur", "Shastri Nagar in adyar",
  // "Tambaram Railway Station", "Porur Junction". Pulling the area out is
  // what turns a landmark list into a proximity graph.
  // → [{ key, viaCorridor }]
  //
  // `viaCorridor` matters more than it looks. "OMR" and "GST Road" resolve,
  // through the anchor aliases, to ONE representative locality on that road —
  // Sholinganallur and Tambaram. That is right for placing a property whose
  // address is "on OMR", and completely wrong as an adjacency claim: read
  // naively, "3-Way Connectivity — OMR & GST Road" on an Akkarai property
  // asserts that Akkarai is next door to Tambaram, 20 km away. So a
  // corridor-derived hit is demoted to a corridor edge, which sits below
  // POSITION_MIN_W and therefore cannot move anybody's position.
  const CORRIDOR_TOKEN = /\b(?:omr|ecr|gst|old\s*mahabalipuram|east\s*coast\s*road|grand\s*southern\s*trunk|rajiv\s*gandhi\s*salai|radial\s*road|mount\s*-?\s*poonamallee)\b/i;

  function areasInPhrase(phrase) {
    const g = geo();
    const s = clean(phrase);
    if (!s) return [];
    const out = [];
    const push = (k, viaCorridor) => {
      const cur = out.find(x => x.key === k);
      if (cur) { if (!viaCorridor) cur.viaCorridor = false; return; }
      out.push({ key: k, viaCorridor: !!viaCorridor });
    };
    // "X in Y" / "X at Y" — the area is the tail, and it is the reliable half
    // ("Kalakshetra road in thiruvanmiyur", "Shastri Nagar in adyar").
    const tail = /\b(?:in|at|near|off|beside)\s+([a-z\s.'-]{3,40})$/i.exec(s);
    if (tail) g.resolveAll(tail[1]).forEach(k => push(k, CORRIDOR_TOKEN.test(tail[1])));
    // A corridor token anywhere in the phrase taints only the keys that the
    // corridor itself resolves to, so "2-Way Connectivity to Kelambakkam and
    // Kovalam" keeps both real areas while "OMR" stays a corridor hint.
    const corridorKeys = new Set();
    if (CORRIDOR_TOKEN.test(s)) {
      (s.match(new RegExp(CORRIDOR_TOKEN.source, 'gi')) || [])
        .forEach(tok => g.resolveAll(tok).forEach(k => corridorKeys.add(k)));
    }
    g.resolveAll(s).forEach(k => push(k, corridorKeys.has(k)));
    return out;
  }

  // ═══════ BUILD ═══════

  const cache = new WeakMap();

  /**
   * Learn the area map from a property list.
   *
   * @param properties  the inventory
   * @param opts        { extra: [{location, nearbyLandmark, connectivity, nearby, zone}] }
   *                    `extra` lets the Track board fold in listings that are
   *                    not in the inventory yet, so a brand-new area is known
   *                    to the model the day its first listing is created.
   * @returns the model
   */
  function build(properties, opts) {
    const o = opts || {};
    const list = (properties || []).concat(o.extra || []);
    const g = geo();

    // node: { key, label, kind, parent, seeded, pos, posConfidence, props }
    const nodes = new Map();
    // edges: key → Map(key → { w, basis, km })
    const edges = new Map();

    function node(name, kind) {
      const key = keyOf(name);
      if (!key) return null;
      let n = nodes.get(key);
      if (!n) {
        const anchored = !!g.LOCALITIES[key];
        n = {
          key,
          label: anchored ? g.label(key) : clean(name),
          kind: kind || (anchored ? 'locality' : 'area'),
          parent: null, seeded: anchored,
          pos: anchored ? g.LOCALITIES[key].slice() : null,
          posConfidence: anchored ? 1 : 0,
          props: [], evidence: []
        };
        nodes.set(key, n);
      }
      // A name first met as a street can later be confirmed as a locality by
      // a cell where it stands alone; never the other way round.
      if (kind === 'locality' && n.kind !== 'locality') n.kind = 'locality';
      return n;
    }

    function link(a, b, w, basis, km) {
      if (!a || !b || a === b) return;
      const put = (x, y) => {
        let m = edges.get(x);
        if (!m) { m = new Map(); edges.set(x, m); }
        const cur = m.get(y);
        // Strongest evidence wins; a measured distance also records the km.
        if (!cur || w > cur.w) m.set(y, { w, basis, km: km == null ? (cur ? cur.km : null) : km });
        else if (km != null && cur.km == null) cur.km = km;
      };
      put(a, b); put(b, a);
    }

    // ── 1. Segment every location cell into a hierarchy ──
    //
    // Returns { locality, subs[], corridors[], nearHints[] } for one cell.
    function parseCell(text) {
      const raw = clean(text);
      const out = { locality: null, subs: [], corridors: [], nearHints: [], coLocated: [] };
      if (!raw) return out;

      // A slash between two names is an OR, not a hierarchy: both are where
      // the property is ("Gerugambakkam / Porur"). Handled first so the comma
      // walk below never reads them as parent and child.
      const commaParts = raw.split(',').map(clean).filter(Boolean);
      const candidates = [];

      for (const part of commaParts) {
        if (IS_CITY.test(part) && !HAS_PIN.test(part)) continue;
        if (IS_CITY.test(part) && HAS_PIN.test(part)) continue;   // "Chennai - 600080"
        if (IS_ADDRESS.test(part)) continue;

        const corr = corridorOfSegment(part);
        if (corr) { out.corridors.push(corr); continue; }

        const nearM = NEAR_PREFIX.exec(part);
        if (nearM) {
          // "Next to Neelankarai" — a pointer, not a container.
          const target = clean(part.slice(nearM[0].length));
          if (target) out.nearHints.push(target);
          continue;
        }

        // Slash-separated alternatives inside one segment.
        if (part.includes('/')) {
          part.split('/').map(clean).filter(Boolean).forEach(x => {
            if (!IS_CITY.test(x) && !IS_ADDRESS.test(x)) out.coLocated.push(x);
          });
          continue;
        }
        candidates.push(part);
      }

      if (!candidates.length) {
        // Everything was a corridor or a pointer. The pointer is then the
        // best location evidence there is — "Thiruporur, Bang on OMR".
        return out;
      }

      // Which candidate is the container? Frequency first — a broad area is
      // named by many properties and a colony by one or two — with comma
      // order as the tiebreak, because the sheet writes narrow → broad.
      //
      // This is what gets "Adyar, Padmanabha Nagar" right (Adyar is the
      // container even though it comes first) where a naive "last segment is
      // broadest" rule gets it backwards.
      const scored = candidates.map((c, i) => {
        const k = keyOf(c);
        return {
          name: c, key: k, i,
          freq: cellFreq.get(k) || 0,
          anchored: !!g.LOCALITIES[k],
          street: IS_STREET.test(c)
        };
      });
      const containers = scored.filter(s => !s.street);
      const pool = containers.length ? containers : scored;
      pool.sort((a, b) =>
        (b.anchored - a.anchored) ||
        (b.freq - a.freq) ||
        (b.i - a.i)
      );
      const head = pool[0];
      out.locality = head.name;
      out.subs = scored.filter(s => s.key !== head.key).map(s => s.name);
      return out;
    }

    // Frequency needs one pass before parseCell can use it, so count the
    // normalised segments up front.
    const cellFreq = new Map();
    for (const p of list) {
      const seen = new Set();
      for (const part of String(p.location || '').split(/[,\/]/)) {
        const c = clean(part);
        if (!c || IS_CITY.test(c) || IS_ADDRESS.test(c) || corridorOfSegment(c)) continue;
        const k = keyOf(c.replace(NEAR_PREFIX, ''));
        if (!k || seen.has(k)) continue;
        seen.add(k);
        cellFreq.set(k, (cellFreq.get(k) || 0) + 1);
      }
    }

    // ── 2. Nodes, containment and co-location ──
    const landmarkIndex = new Map();     // landmark → Set(localityKey)
    const zoneIndex = new Map();         // zone → Set(localityKey)

    for (const p of list) {
      const cell = parseCell(p.location);
      let home = null;

      if (cell.locality) {
        const n = node(cell.locality, IS_STREET.test(cell.locality) ? 'area' : 'locality');
        if (n) { home = n; n.props.push(p.id); }
      }

      // Sub-areas sit inside the locality. This single edge is what makes
      // "I Block", "W Block", "TNHB East Avenue" and the other 25 street and
      // block names usable without anybody mapping them.
      for (const s of cell.subs) {
        const sn = node(s, IS_STREET.test(s) ? 'street' : 'sub');
        if (!sn || !home) continue;
        sn.parent = sn.parent || home.key;
        sn.evidence.push({ basis: 'contains', of: home.label, from: p.id });
        link(sn.key, home.key, W.contains, 'contains');
      }

      // Slash alternatives are all equally "where it is".
      const co = cell.coLocated.map(x => node(x, 'locality')).filter(Boolean);
      if (home) co.forEach(c => link(home.key, c.key, W.cocell, 'cocell'));
      for (let i = 0; i < co.length; i++) {
        for (let j = i + 1; j < co.length; j++) link(co[i].key, co[j].key, W.cocell, 'cocell');
        co[i].props.push(p.id);
      }
      if (!home && co.length) home = co[0];

      // "Next to Neelankarai" / "Bang on OMR" — the strongest single phrase
      // in the cell, because somebody chose to write it.
      for (const hint of cell.nearHints) {
        for (const t of areasInPhrase(hint)) {
          const tn = node(t.key, 'locality');
          if (!tn || !home || tn.key === home.key) continue;
          if (t.viaCorridor) { link(home.key, tn.key, W.corridor, 'corridor'); continue; }
          link(home.key, tn.key, W.adjacent, 'adjacent');
          home.evidence.push({ basis: 'adjacent', of: tn.label, from: p.id });
        }
      }

      for (const c of cell.corridors) {
        // Corridor membership, recorded on the node so the fallback ladder
        // can use it without re-parsing.
        if (home) (home.corridors || (home.corridors = [])).push(c);
      }

      if (!home) continue;

      // ── 3. Landmarks and measured distances ──
      const lmText = [p.nearbyLandmark, p.connectivity, p.nearby].filter(Boolean).join(',');
      for (const piece of lmText.split(/[,|;]/)) {
        const phrase = clean(piece);
        if (!phrase || phrase.length < 3) continue;
        const { km, unit, rest } = readDistance(phrase);
        const targets = areasInPhrase(rest || phrase);

        // A stated distance to a named area is the only metric evidence
        // anywhere in this data. A stated TIME is the same shape of fact with
        // a brochure's optimism on it, so it is kept and marked rather than
        // trusted equally: basis 'timed', weight W.timed.
        if (km != null && targets.length) {
          for (const t of targets) {
            const tn = node(t.key, 'locality');
            if (!tn || tn.key === home.key) continue;
            if (t.viaCorridor) { link(home.key, tn.key, W.corridor, 'corridor'); continue; }
            const basis = unit === 'min' ? 'timed' : 'measured';
            link(home.key, tn.key, unit === 'min' ? W.timed : W.measured, basis, km);
            home.evidence.push({ basis, of: tn.label, km, unit, from: p.id });
          }
          continue;
        }
        // A named area with no distance at all: still proximity evidence,
        // but it is marketing copy listing what is "nearby", so it carries
        // W.nearby rather than the stronger claim the Location column makes.
        if (targets.length) {
          for (const t of targets) {
            const tn = node(t.key, 'locality');
            if (!tn || tn.key === home.key) continue;
            link(home.key, tn.key, t.viaCorridor ? W.corridor : W.nearby, t.viaCorridor ? 'corridor' : 'nearby');
          }
          continue;
        }
        // Not an area: a school, a hospital, a bus stop. Index it — two
        // properties citing the same school are near each other.
        const lk = g.norm(rest || phrase);
        if (lk.length < 4) continue;
        let set = landmarkIndex.get(lk);
        if (!set) { set = new Set(); landmarkIndex.set(lk, set); }
        set.add(home.key);
      }

      const z = p.zone || g.zoneOf(p.location || '');
      if (z) {
        let set = zoneIndex.get(z);
        if (!set) { set = new Set(); zoneIndex.set(z, set); }
        set.add(home.key);
      }
    }

    // ── 4. Landmark edges, weighted by how distinctive the landmark is ──
    //
    // A school cited by two properties says a great deal; "Chennai Airport",
    // cited by twenty, says nothing at all. So the weight falls away with the
    // number of areas sharing it, and a landmark spanning more than six areas
    // is discarded rather than trusted a little.
    for (const [, set] of landmarkIndex) {
      const keys = [...set];
      if (keys.length < 2 || keys.length > 6) continue;
      const w = Math.max(W.landmarkMin, W.landmarkMax / (keys.length - 1));
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) link(keys[i], keys[j], w, 'landmark');
      }
    }

    // ── 5. Corridor and zone edges — the weak backstop ──
    const byCorridor = new Map();
    for (const n of nodes.values()) {
      for (const c of (n.corridors || [])) {
        let s = byCorridor.get(c);
        if (!s) { s = new Set(); byCorridor.set(c, s); }
        s.add(n.key);
      }
    }
    // The anchor file's own corridor membership, so a corridor the sheet did
    // not spell out on this row still connects.
    for (const [c, names] of Object.entries(g.CORRIDOR_MEMBERS)) {
      let s = byCorridor.get(c);
      if (!s) { s = new Set(); byCorridor.set(c, s); }
      names.forEach(n => { if (nodes.has(n)) s.add(n); });
    }
    for (const [, set] of byCorridor) {
      const keys = [...set];
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) link(keys[i], keys[j], W.corridor, 'corridor');
      }
    }
    for (const [, set] of zoneIndex) {
      const keys = [...set];
      if (keys.length > 40) continue;
      for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) link(keys[i], keys[j], W.zone, 'zone');
      }
    }

    // ── 6. Police the evidence against the anchors ──
    const warnings = auditEdges(nodes, edges);

    // ── 7. Solve the unknown positions ──
    propagate(nodes, edges);

    // ═══════ QUERY SURFACE ═══════

    const memo = new Map();

    // The node a piece of location text refers to, following a sub-area up to
    // the locality that actually has a position.
    function nodeFor(text) {
      const k = keyOf(text);
      if (!k) return null;
      let n = nodes.get(k);
      if (n) return n;
      // Not a node the inventory has met. The anchor table may still know it
      // (a buyer can name an area we hold nothing in), which is a legitimate
      // answer — it just has no learned edges.
      if (g.LOCALITIES[k]) {
        return { key: k, label: g.label(k), kind: 'locality', parent: null, seeded: true, pos: g.LOCALITIES[k].slice(), posConfidence: 1, props: [], evidence: [], synthetic: true };
      }
      return null;
    }

    // Walk up to whatever ancestor carries a position.
    function positioned(n) {
      let cur = n, hops = 0;
      while (cur && !cur.pos && cur.parent && hops < 6) { cur = nodes.get(cur.parent); hops++; }
      return cur && cur.pos ? { node: cur, hops } : null;
    }

    // Dijkstra over −log(w), i.e. the most-reliable path, returning the
    // product of the edge weights along it. Only run when there is no
    // position to compare — it is the fallback, not the main road.
    function bestPath(aKey, bKey, minW) {
      const floor = minW == null ? W.zone : minW;
      const dist = new Map([[aKey, 0]]);
      const prev = new Map();
      const seen = new Set();
      const queue = [[0, aKey]];
      while (queue.length) {
        queue.sort((x, y) => x[0] - y[0]);
        const [d, k] = queue.shift();
        if (seen.has(k)) continue;
        seen.add(k);
        if (k === bKey) break;
        const nbrs = edges.get(k);
        if (!nbrs) continue;
        for (const [nk, e] of nbrs) {
          if (e.w < floor || seen.has(nk)) continue;
          const nd = d - Math.log(e.w);
          if (!dist.has(nk) || nd < dist.get(nk)) {
            dist.set(nk, nd);
            prev.set(nk, { from: k, basis: e.basis, w: e.w, km: e.km });
            queue.push([nd, nk]);
          }
        }
      }
      if (!dist.has(bKey)) return null;
      const path = [];
      let cur = bKey;
      while (prev.has(cur)) { const s = prev.get(cur); path.unshift(Object.assign({ to: cur }, s)); cur = s.from; }
      return { strength: Math.exp(-dist.get(bKey)), hops: path.length, path };
    }

    // How km maps onto a 0..1 similarity. Chennai as a buyer experiences it:
    // under 2 km is the same neighbourhood, 4 km is worth offering, 8 km is a
    // different part of town but often the same commute, and past 15 km it is
    // a different search. Shared with the matcher deliberately — one curve.
    function simFromKm(km) {
      return km <= 1.5 ? 0.92
        : km <= 3 ? 0.82
          : km <= 5 ? 0.68
            : km <= 8 ? 0.48
              : km <= 12 ? 0.3
                : km <= 18 ? 0.15
                  : 0.05;
    }

    /**
     * How near two areas are.
     *
     * @returns {{ similarity:number, km:number|null, kmBand:string|null,
     *             basis:string, confidence:number, note:string,
     *             from:string, to:string }}
     */
    function proximity(a, b) {
      const ak = keyOf(a), bk = keyOf(b);
      if (!ak || !bk) return unknown(a, b);
      const id = ak + ' ' + bk;
      if (memo.has(id)) return memo.get(id);
      const res = compute(a, b, ak, bk);
      memo.set(id, res);
      return res;
    }

    function unknown(a, b) {
      return {
        similarity: null, km: null, kmBand: null, basis: 'unknown', confidence: 0,
        note: 'this area is not in the model yet, so distance is unknown — not far',
        from: clean(a), to: clean(b)
      };
    }

    function compute(a, b, ak, bk) {
      const an = nodeFor(a), bn = nodeFor(b);
      if (!an || !bn) return unknown(a, b);

      const from = an.label, to = bn.label;
      if (ak === bk) {
        return { similarity: 1, km: 0, kmBand: null, basis: 'same', confidence: 1, note: 'the same area', from, to };
      }

      // Containment either way — a block inside the locality the buyer named.
      // Walked up the whole chain, not just the direct parent: the sheet can
      // nest three deep ("10th Street, I Block, Anna Nagar East"), and a
      // street inside a block inside a locality is inside that locality.
      const inside = (child, ancestorKey) => {
        let cur = child, hops = 0;
        while (cur && cur.parent && hops < 6) {
          if (cur.parent === ancestorKey) return true;
          cur = nodes.get(cur.parent); hops++;
        }
        return false;
      };
      if (inside(an, bk) || inside(bn, ak)) {
        const inner = inside(an, bk) ? an : bn;
        const outer = inner === an ? bn : an;
        return {
          similarity: 1, km: 0, kmBand: null, basis: 'contains', confidence: 1,
          note: `${inner.label} is inside ${outer.label}`, from, to
        };
      }

      // A measured edge is the best evidence in the data — use it directly
      // rather than the positions it also helped produce.
      const direct = (edges.get(ak) || new Map()).get(bk);
      if (direct && (direct.basis === 'measured' || direct.basis === 'timed') && direct.km != null) {
        const timed = direct.basis === 'timed';
        const conf = timed ? 0.7 : 0.9;
        return {
          similarity: simFromKm(direct.km), km: direct.km, kmBand: band(direct.km, conf),
          basis: direct.basis, confidence: conf,
          note: timed
            ? `the sheet quotes a drive of about ${Math.round(direct.km / KM_PER_MIN)} minutes, so roughly ${band(direct.km, conf)}`
            : `the sheet states about ${band(direct.km, conf)} between them`,
          from, to
        };
      }

      // Positions, following sub-areas up to their locality.
      const pa = positioned(an), pb = positioned(bn);
      if (pa && pb) {
        const km = geo().haversine(pa.node.pos, pb.node.pos);
        const conf = Math.min(pa.node.posConfidence, pb.node.posConfidence)
          * Math.pow(0.92, pa.hops + pb.hops);
        const anchored = pa.node.seeded && pb.node.seeded;
        const via = [];
        if (pa.hops) via.push(`${an.label} via ${pa.node.label}`);
        if (pb.hops) via.push(`${bn.label} via ${pb.node.label}`);
        return {
          similarity: simFromKm(km),
          km,
          kmBand: band(km, conf),
          basis: anchored ? 'anchored' : 'estimated',
          confidence: anchored ? 1 : conf,
          note: (anchored ? `about ${band(km, 1)} apart` : `about ${band(km, conf)} apart, estimated from the inventory`)
            + (via.length ? ` (${via.join('; ')})` : ''),
          from, to
        };
      }

      // No position for one of them: fall back to the reliability of the best
      // evidence path. Strong paths (containment, measurement, co-cell) mean
      // near; a path made only of zone edges means almost nothing, and says so.
      const path = bestPath(ak, bk);
      if (path) {
        // Similarity comes from the WEAKEST link on the path — a chain is no
        // stronger than that — decayed once per extra hop. Reading it off
        // BASIS_SIM rather than the raw edge weights keeps the answer
        // interpretable: one zone hop means 0.30, and no amount of chaining
        // zone hops can ever make two areas look adjacent.
        const weakest = Math.min.apply(null, path.path.map(s => BASIS_SIM[s.basis] == null ? 0.3 : BASIS_SIM[s.basis]));
        const sim = Math.min(0.85, weakest * Math.pow(0.75, Math.max(0, path.hops - 1)));
        const basisRun = [...new Set(path.path.map(s => s.basis))];
        return {
          similarity: sim, km: null, kmBand: null, basis: 'graph',
          confidence: Math.min(0.7, sim),
          note: `linked through ${path.hops} step${path.hops === 1 ? '' : 's'} of ${basisRun.join(' + ')} evidence`,
          from, to, path: path.path
        };
      }

      return unknown(a, b);
    }

    // A distance is never quoted tighter than the model deserves.
    function band(km, confidence) {
      if (km == null) return null;
      if (km < 0.9) return 'under a kilometre';
      const r = Math.round(km);
      if (confidence >= 0.85) return `${r} km`;
      const lo = Math.max(1, Math.round(km * 0.7)), hi = Math.round(km * 1.35);
      return lo === hi ? `${lo} km` : `${lo}–${hi} km`;
    }

    // Everything the model learned about one area — what the UI shows when
    // somebody asks why.
    function describe(name) {
      const n = nodeFor(name);
      if (!n) return null;
      const nbrs = [...(edges.get(n.key) || new Map()).entries()]
        .map(([k, e]) => ({ key: k, label: (nodes.get(k) || {}).label || geo().label(k), w: e.w, basis: e.basis, km: e.km }))
        .sort((x, y) => y.w - x.w);
      const pos = positioned(n);
      return {
        key: n.key, label: n.label, kind: n.kind,
        parent: n.parent ? (nodes.get(n.parent) || {}).label || n.parent : null,
        properties: n.props.length,
        placed: !!pos,
        placedVia: pos && pos.hops ? pos.node.label : null,
        anchored: !!n.seeded,
        confidence: pos ? pos.node.posConfidence : 0,
        evidence: n.evidence.slice(0, 8),
        neighbours: nbrs.slice(0, 12)
      };
    }

    // The learned map, in one sorted list — for the inspection page, so the
    // team can read what the model believes and correct the sheet where it is
    // wrong. "I cannot map the areas" is answered by never having to.
    function areaMap() {
      return [...nodes.values()]
        .map(n => {
          const pos = positioned(n);
          return {
            key: n.key, label: n.label, kind: n.kind,
            parent: n.parent ? (nodes.get(n.parent) || {}).label || n.parent : null,
            properties: n.props.length,
            anchored: !!n.seeded,
            placed: !!pos,
            placedVia: pos && pos.hops ? pos.node.label : null,
            confidence: pos ? Math.round(pos.node.posConfidence * 100) / 100 : 0,
            degree: (edges.get(n.key) || new Map()).size
          };
        })
        .sort((a, b) => b.properties - a.properties || a.label.localeCompare(b.label));
    }

    const all = [...nodes.values()];
    const placed = all.filter(n => positioned(n));
    const stats = {
      areas: all.length,
      localities: all.filter(n => n.kind === 'locality').length,
      subAreas: all.filter(n => n.kind === 'sub' || n.kind === 'street').length,
      anchored: all.filter(n => n.seeded).length,
      placed: placed.length,
      estimated: placed.filter(n => !n.seeded).length,
      unplaced: all.length - placed.length,
      edges: [...edges.values()].reduce((n, m) => n + m.size, 0) / 2,
      measuredEdges: [...edges.values()].reduce((n, m) => n + [...m.values()].filter(e => e.basis === 'measured').length, 0) / 2,
      byBasis: (() => {
        const c = {};
        for (const m of edges.values()) for (const e of m.values()) c[e.basis] = (c[e.basis] || 0) + 1;
        Object.keys(c).forEach(k => { c[k] = c[k] / 2; });
        return c;
      })()
    };

    return {
      nodes, edges, stats, warnings,
      proximity, describe, areaMap,
      resolve: keyOf,
      nodeFor,
      simFromKm,
      // distanceKm keeps the same name and meaning as PinGeo's, so callers
      // can take either — a model when they have the inventory, the anchor
      // table when they do not.
      distanceKm: (a, b) => { const r = proximity(a, b); return r.km; },
      label: k => (nodes.get(keyOf(k)) || {}).label || geo().label(keyOf(k))
    };
  }

  // ═══════ SELF-AUDIT ═══════
  //
  // Wherever BOTH ends of an edge are anchored, the anchors are ground truth
  // and the edge is a testable claim. Most hold. The ones that do not are
  // almost always one of two things, and both are worth catching:
  //
  //   · an ambiguous name — "SIPCOT" exists at Siruseri AND at Sriperumbudur,
  //     45 km apart, so resolving it to either one asserts a neighbour
  //     relationship that is simply false;
  //   · a genuine sheet error — two areas in one Location cell that are
  //     nowhere near each other.
  //
  // A contradicted edge is demoted to zone weight, which puts it below
  // POSITION_MIN_W so it can no longer move anybody's position, and recorded
  // as a warning. That second half matters as much as the first: these
  // warnings are a list of location cells worth a human's attention, produced
  // without anybody auditing the sheet by hand.
  //
  // This is the mechanism that makes the model self-correcting. Adding an
  // anchor does not just place one area — it starts testing every claim that
  // touches it.
  const EXPECT_KM = { contains: 4, adjacent: 7, cocell: 8, nearby: 12, landmark: 15 };

  function auditEdges(nodes, edges) {
    const g = geo();
    const warnings = [];
    const seen = new Set();

    for (const [ak, nbrs] of edges) {
      const a = nodes.get(ak);
      if (!a || !a.seeded || !a.pos) continue;
      for (const [bk, e] of nbrs) {
        const b = nodes.get(bk);
        if (!b || !b.seeded || !b.pos) continue;
        const id = ak < bk ? ak + '|' + bk : bk + '|' + ak;
        if (seen.has(id)) continue;
        seen.add(id);

        const trueKm = g.haversine(a.pos, b.pos);
        let bad = null;

        if (e.basis === 'measured' || e.basis === 'timed') {
          // A stated distance is testable directly. The tolerance is generous
          // because a brochure measures to its own front gate and an anchor is
          // a locality centroid — but an order-of-magnitude disagreement is
          // not measurement error, it is the wrong place.
          const tol = Math.max(4, trueKm * 0.8);
          if (e.km != null && Math.abs(e.km - trueKm) > tol) {
            bad = `the sheet implies ${e.km.toFixed(1)} km but they are about ${trueKm.toFixed(1)} km apart`;
          }
        } else if (EXPECT_KM[e.basis] != null && trueKm > EXPECT_KM[e.basis]) {
          bad = `treated as ${e.basis} evidence, but they are about ${trueKm.toFixed(1)} km apart`;
        }

        if (!bad) continue;
        // Demote both directions — the edge is symmetric.
        e.w = W.zone; e.basis = 'zone'; e.km = null;
        const back = edges.get(bk) && edges.get(bk).get(ak);
        if (back) { back.w = W.zone; back.basis = 'zone'; back.km = null; }
        warnings.push({ from: a.label, to: b.label, km: trueKm, why: bad });
      }
    }
    return warnings;
  }

  // ═══════ POSITION PROPAGATION ═══════
  //
  // Harmonic solution: anchored nodes stay put, every other node settles at
  // the weighted mean of its neighbours. Converges quickly on a graph this
  // shape, and degrades exactly the way it should — a node whose only link is
  // a weak one ends up with a low confidence, which the caller then reports
  // as a band instead of a figure.
  //
  // Only edges at or above POSITION_MIN_W take part. Zone edges connect a
  // third of the city to another third; letting them place a node would pull
  // every unknown area towards the centre of Chennai and produce a number
  // that looks authoritative and is worthless.
  function propagate(nodes, edges, opts) {
    const o = opts || {};
    const rounds = o.rounds || 60;
    const tol = o.tol || 1e-5;

    const movable = [...nodes.values()].filter(n => !n.seeded);
    if (!movable.length) return;

    // Contribution weight of one edge towards carrying a position. A measured
    // edge with a short distance is much better evidence of "here" than a
    // long one.
    // A short measured hop is far better evidence of "here" than a long one:
    // "500 m to Ayanavaram Metro" all but places the property, while "13 km
    // from Tambaram" barely constrains it at all.
    const contribution = e => {
      let w = e.w;
      if ((e.basis === 'measured' || e.basis === 'timed') && e.km != null) {
        w *= e.km <= 3 ? 1 : e.km <= 8 ? 0.7 : 0.4;
      }
      return w;
    };

    for (let r = 0; r < rounds; r++) {
      let moved = 0;
      for (const n of movable) {
        const nbrs = edges.get(n.key);
        if (!nbrs) continue;
        let lat = 0, lng = 0, tw = 0;
        const reaches = [];
        for (const [nk, e] of nbrs) {
          if (e.w < POSITION_MIN_W) continue;
          const nb = nodes.get(nk);
          if (!nb || !nb.pos) continue;
          const c = contribution(e);
          const w = c * (0.35 + 0.65 * nb.posConfidence);
          if (!w) continue;
          lat += nb.pos[0] * w; lng += nb.pos[1] * w; tw += w;
          // Confidence must use the SAME distance discount the position does.
          // Using the raw edge weight here is what let Siruseri claim 0.90
          // confidence off a single "11 km from Mambakkam": a long hop tells
          // you the radius and nothing about the bearing, so placing the node
          // on top of its neighbour is ~11 km wrong while looking certain.
          reaches.push({ r: c * (nb.seeded ? 1 : nb.posConfidence * 0.9), basis: e.basis });
        }
        if (!tw) continue;
        const next = [lat / tw, lng / tw];
        const prev = n.pos;
        n.pos = next;
        n.posConfidence = confidenceFrom(reaches);
        if (!prev || Math.abs(prev[0] - next[0]) + Math.abs(prev[1] - next[1]) > tol) moved++;
      }
      if (!moved) break;
    }
  }

  // One constraint fixes a RADIUS, not a point — so a node held by a single
  // distance can never be more than half-confident however strong that one
  // edge is. A second independent neighbour genuinely triangulates, and is
  // what earns the higher band.
  //
  // Containment is the exception, and it matters: a street inside Korattur is
  // IN Korattur. That is not a radius, it is a location, and one such edge
  // settles the position as well as ten would. Without this exception every
  // street and colony in the sheet — 30 of them — carried the single-
  // constraint cap and reported ±3.5 km when it was really within the
  // locality it is named after.
  //
  // Ten weak links still do not make a strong one: this reads the best two
  // reaches, never the sum.
  function confidenceFrom(reaches) {
    if (!reaches.length) return 0;
    reaches.sort((a, b) => b.r - a.r);
    const best = reaches[0];
    if (best.basis === 'contains') return Math.min(0.95, best.r);
    if (reaches.length === 1) return Math.min(0.5, best.r);
    const second = reaches[1];
    return Math.min(0.95, best.r * (1 + 0.3 * Math.min(1, second.r / (best.r || 1))));
  }

  // ═══════ CACHED ENTRY POINT ═══════
  //
  // Building is ~O(properties + edges) and takes a couple of milliseconds on
  // this inventory, but every screen asks for the model on every render, so
  // it is cached against the list identity the way PinSearch caches its index.
  function forList(properties, opts) {
    if (!Array.isArray(properties)) return build([], opts);
    if (opts && opts.extra && opts.extra.length) return build(properties, opts);
    let m = cache.get(properties);
    if (!m) { m = build(properties, opts); cache.set(properties, m); }
    return m;
  }

  const api = { build, forList, propagate, readDistance, areasInPhrase, W, POSITION_MIN_W, KM_PER_MIN };
  root.PinAreaModel = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
