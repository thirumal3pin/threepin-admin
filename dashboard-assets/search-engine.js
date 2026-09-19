// ═══════ PROPERTY SEARCH ENGINE ═══════
//
// Everything the dashboard's search bar and Advanced Search panel know about
// how to read a property. No DOM in this file — it is pure data in, matches
// out, which is what lets tests/property-search.test.mjs drive it over the
// real inventory snapshot.
//
// Loaded as a plain script (window.PinSearch) so it is available before
// app.js runs, exactly like property-view.js. The Node test evaluates this
// same file, so the tests exercise the artifact the browser actually gets.
//
// ── The three problems this replaces ──
//
// 1. The old search concatenated every field into one string, stripped the
//    spaces out of BOTH the haystack and the query, and did a single
//    `includes`. So a query of more than one word only matched if those words
//    happened to be adjacent in that concatenation — "1518 sqft built up
//    area" could never match anything. Here a query is a set of clauses and
//    each is matched on its own.
//
// 2. It was pure text. "1518" could only be found if the digits 1518 sat
//    somewhere in the document. But built-up area is stored as a RANGE
//    ("1161-2960", "2,400 to 4,800", "1,669 – 4,559 Sq.Ft."), so the one
//    number a client actually says is exactly the number that is never
//    written down. Numbers are parsed into ranges here and a query number is
//    tested for containment as well as for literal presence.
//
// 3. It had no idea two terms could mean the same field. An agent asking for
//    "3 and 4 BHK in Anna Nagar and Adyar" means 3 OR 4, and Anna Nagar OR
//    Adyar — "and" between two values of ONE field is an OR. Terms are
//    classified into fields first, and a run of same-field terms joined by
//    and/or/&/comma becomes one OR clause.
//
// The value formats below are not hypothetical — every one is quoted from the
// live inventory, which is entered by hand and is as irregular as that makes
// it ("----", "G+1", "33% (UDS, not sq.ft)", a price in the units column).
// Parsing is therefore written to give up on a field quietly rather than to
// throw, and literal text matching always stays available as the floor.

(function (root) {
  'use strict';

  // ═══════ TEXT NORMALISATION ═══════

  const DASHES = /[‐-―−]/g;          // ‐ ‑ ‒ – — ― −
  const THIN_SPACES = /[   ]/g;

  // Lowercase, strip accents, unify every dash and space. Keeps digits,
  // letters and the punctuation the parsers care about.
  function fold(v) {
    return String(v == null ? '' : v)
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(DASHES, '-')
      .replace(THIN_SPACES, ' ')
      .toLowerCase();
  }

  // "1,518" → "1518", "1,35,000" → "135000". Only strips a comma that sits
  // BETWEEN two digits, so the comma in "2, 3 & 4 BHK" (comma then space)
  // survives and the BHK list still parses as a list.
  const dropDigitCommas = s => s.replace(/(\d),(?=\d)/g, '$1');

  // The canonical form a term and a stored value are compared in: folded,
  // digit-separators gone, everything else that is not a letter/digit/dot
  // turned into a single space. "₹1,25,000/Sqft" → "1.25 000 sqft"… no:
  // dots are kept only between digits, so "Sq.Ft" → "sq ft" but "813.89"
  // stays "813.89".
  function normText(v) {
    return dropDigitCommas(fold(v))
      .replace(/['’`]/g, '')        // "Navin's" → "navins", the same both sides
      .replace(/\.(?!\d)/g, ' ')
      .replace(/[^a-z0-9.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const tokenize = s => normText(s).split(' ').filter(Boolean);

  // Levenshtein, abandoned as soon as it is certain to exceed `max`. Used for
  // typo tolerance on names and localities — "adayar"/"adyar",
  // "velacherry"/"velachery", "casagrand"/"casagrande".
  function withinDistance(a, b, max) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return -1;
    const prev = new Array(b.length + 1), cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return -1;
      for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length] <= max ? prev[b.length] : -1;
  }

  // A word only earns fuzzy tolerance once it is long enough that a typo is
  // more likely than a different word: "2bhk" and "3bhk" are one edit apart.
  function fuzzyBudget(term) {
    if (/\d/.test(term)) return 0;
    if (term.length >= 8) return 2;
    if (term.length >= 5) return 1;
    return 0;
  }

  // ═══════ NUMBER PARSING ═══════

  const NOISE = /^(-+|n\/?a|na|tba|tbd|nil|none|not applicable|contact for details|-)$/i;
  const isNoise = v => !v || NOISE.test(String(v).trim());

  // Ranges joined by "-", "to" or "–"; everything else that looks like a
  // number becomes a point. `dropBhk` first deletes "3BHK"-style labels so
  // "1BHK-460-510" yields 460–510 and not a phantom 1.
  //
  // Returns { ranges: [[lo,hi]], points: [n], first: n|null } — `first` is the
  // number a human reads first and is what banding uses.
  function parseRanges(value, opts) {
    const o = opts || {};
    if (isNoise(value)) return { ranges: [], points: [], first: null };
    let s = dropDigitCommas(fold(value));
    if (o.dropBhk !== false) s = s.replace(/\d+(?:\.\d+)?\s*(?:bhk|bed\s*rooms?|beds?)\b/g, ' ');
    s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, ' ');           // "33% (UDS…)" is a share, not an area
    const ranges = [], points = [], seen = new Set();
    const RANGE = /(\d+(?:\.\d+)?)\s*(?:-|to|upto|up to|until)\s*(\d+(?:\.\d+)?)/g;
    let m;
    while ((m = RANGE.exec(s))) {
      const lo = parseFloat(m[1]), hi = parseFloat(m[2]);
      if (!isFinite(lo) || !isFinite(hi)) continue;
      ranges.push([Math.min(lo, hi), Math.max(lo, hi)]);
      seen.add(m.index); seen.add(m.index + m[0].length);
      s = s.slice(0, m.index) + ' '.repeat(m[0].length) + s.slice(m.index + m[0].length);
      RANGE.lastIndex = m.index;
    }
    const NUM = /(\d+(?:\.\d+)?)/g;
    while ((m = NUM.exec(s))) points.push(parseFloat(m[1]));
    const all = [];
    ranges.forEach(r => all.push(r[0]));
    points.forEach(p => all.push(p));
    // `first` must be the first number in READING order, which the
    // range-then-points collection above has already scrambled.
    const firstMatch = dropDigitCommas(fold(value))
      .replace(o.dropBhk !== false ? /\d+(?:\.\d+)?\s*(?:bhk|bed\s*rooms?|beds?)\b/g : /$^/g, ' ')
      .match(/(\d+(?:\.\d+)?)/);
    return { ranges, points, first: firstMatch ? parseFloat(firstMatch[1]) : (all.length ? all[0] : null) };
  }

  // Every interval a field covers, point values included, so containment and
  // overlap tests only need one list.
  function spansOf(parsed) {
    const out = parsed.ranges.map(r => [r[0], r[1]]);
    parsed.points.forEach(p => out.push([p, p]));
    return out;
  }

  const CR = 10000000, LAKH = 100000;
  const AREA_UNITS = { acre: 43560, acres: 43560, cent: 435.6, cents: 435.6, ground: 2400, grounds: 2400 };

  // Money. Returns rupee spans split by what the number actually is: a total
  // price, a rate per sqft, or a monthly rent — the live data puts all three
  // in the same column at one time or another ("₹2700/Sqft+" and
  // "₹1,35,000/Month" both sit in Starting Price).
  function parseMoney(value, hint) {
    const out = { price: [], psf: [], rent: [] };
    if (isNoise(value)) return out;
    let s = dropDigitCommas(fold(value))
      .replace(/\d+(?:\.\d+)?\s*(?:bhk|bed\s*rooms?)\b/g, ' ')   // "2 BHK - ₹1.49 to ₹2.11 Cr"
      .replace(/\s+/g, ' ');

    const ATOM = /(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|lakh|lac|l|k)?\s*((?:\/|per\s*)\s*(?:sq\.?\s*ft|sqft|sft|square\s*feet)|psf|(?:\/|per\s*)\s*month|pm\b)?/g;
    const atoms = [];
    let m;
    while ((m = ATOM.exec(s))) {
      if (!m[1]) continue;
      const n = parseFloat(m[1]);
      if (!isFinite(n)) continue;
      atoms.push({ n, unit: m[2] || '', suffix: (m[3] || '').replace(/\s+/g, ''), start: m.index, end: m.index + m[0].length, raw: m[0] });
    }

    const mult = u => (/^cr|^crore/.test(u) ? CR : /^l|^lak|^lac/.test(u) ? LAKH : /^k$/.test(u) ? 1000 : 1);
    const kindOf = a => {
      if (/sq|sft|psf/.test(a.suffix)) return 'psf';
      if (/month|pm/.test(a.suffix)) return 'rent';
      return null;
    };

    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      const b = atoms[i + 1];
      // "₹60L - 1.6Cr", "₹1.49 to ₹2.11 Cr" — only whitespace and a range word
      // may sit between the two for them to be one range, and a missing unit
      // on the low side inherits the high side's ("1.49 to 2.11 Cr").
      const between = b ? s.slice(a.end, b.start) : '';
      const isRange = b && /^\s*(?:-|to)\s*(?:₹|rs\.?|inr)?\s*$/.test(between);
      const unitA = a.unit || (isRange ? b.unit : '');
      let kind = kindOf(a) || (isRange ? kindOf(b) : null);
      if (!kind) {
        // No explicit unit and no suffix: fall back to the column it came from,
        // then to magnitude. A bare 19,900 in Rate/Sqft is a rate; a bare
        // 135000 in Price is rupees.
        if (hint === 'psf') kind = 'psf';
        else if (unitA) kind = 'price';
        else if (a.n >= LAKH) kind = 'price';
        else if (hint === 'price' && a.n >= 1000 && a.n < LAKH) kind = 'psf';
        else kind = null;
      }
      if (!kind) continue;
      // Rounded because 4.06 × 10^7 is 40599999.99999999 in binary floating
      // point, and a price that renders as "₹4.06 Cr" must compare equal to
      // one typed as 4.06cr.
      const lo = Math.round(a.n * (kind === 'price' ? mult(unitA) : 1) * 100) / 100;
      const hi = isRange ? Math.round(b.n * (kind === 'price' ? mult(b.unit || unitA) : 1) * 100) / 100 : lo;
      if (!isFinite(lo)) continue;
      out[kind].push([Math.min(lo, hi), Math.max(lo, hi)]);
      if (isRange) i++;
    }
    return out;
  }

  // Land comes as acres, cents, grounds or plain sqft — normalised to sqft so
  // one slider can cover the lot, with the raw numbers kept for text matching.
  function parseLandSqft(value) {
    if (isNoise(value)) return [];
    const s = dropDigitCommas(fold(value));
    const out = [];
    const UNIT = /(\d+(?:\.\d+)?)\s*(acres?|cents?|grounds?)/g;
    let m, consumed = false;
    while ((m = UNIT.exec(s))) { out.push(parseFloat(m[1]) * AREA_UNITS[m[2]]); consumed = true; }
    if (!consumed) {
      const p = parseRanges(value);
      spansOf(p).forEach(sp => out.push(sp[0]));
    }
    return out.filter(n => isFinite(n) && n > 0);
  }

  // BHK counts out of a configuration string. Walks backwards from each "bhk"
  // over the characters a list may be made of, which is what separates
  // "1, 2, 3 BHK" (three configs) from "4 Apartments (3BHK each)" (one).
  function extractBhk(value) {
    const out = new Set();
    if (isNoise(value)) return [];
    const s = dropDigitCommas(fold(value)).replace(/\band\b/g, '&').replace(/\bbed\s*rooms?\b|\bbeds?\b|\bbr\b/g, 'bhk');
    const RE = /bhk/g;
    let m;
    while ((m = RE.exec(s))) {
      let i = m.index - 1;
      while (i >= 0 && /[\s\d.,&/+-]/.test(s[i])) i--;
      const run = s.slice(i + 1, m.index);
      const nums = run.match(/\d+(?:\.\d+)?/g) || [];
      nums.forEach(n => { const v = parseFloat(n); if (v >= 1 && v <= 12) out.add(v); });
    }
    return [...out].sort((a, b) => a - b);
  }

  // Floor count out of "G+5", "Stilt + 3 Floors", "2B+G+19", "14".
  function extractFloors(value) {
    if (isNoise(value)) return null;
    const s = fold(value);
    const nums = (dropDigitCommas(s).match(/\d+/g) || []).map(Number);
    if (!nums.length) return null;
    return Math.max.apply(null, nums);
  }

  // ═══════ VOCABULARY ═══════

  // Six buckets, because the sheet spells the same thing eleven ways
  // (Apartment/Apartments, Plot/Plots/Land, …).
  const TYPE_BUCKETS = [
    { key: 'Apartment', label: 'Apartment / Flat', test: /apartment|flat|condo/ },
    { key: 'Villa', label: 'Villa / Townhouse', test: /villa|town\s*house|townhouse|row\s*house/ },
    { key: 'House', label: 'Independent House', test: /independent\s*house|individual\s*house|^house$|\bhouse\b/ },
    { key: 'Plot', label: 'Plot / Land', test: /plot|land|site|layout/ },
    { key: 'Commercial', label: 'Commercial', test: /commercial|office|shop|retail|warehouse/ },
  ];

  function normType(value) {
    const s = fold(value).trim();
    if (!s) return 'Other';
    for (const b of TYPE_BUCKETS) if (b.test.test(s)) return b.key;
    return 'Other';
  }
  const TYPE_LABEL = { Apartment: 'Apartment / Flat', Villa: 'Villa / Townhouse', House: 'Independent House', Plot: 'Plot / Land', Commercial: 'Commercial', Other: 'Other' };

  // The corridors an agent names instead of a locality.
  const CORRIDORS = [
    { key: 'OMR', test: /\bomr\b|old\s*mahabalipuram|rajiv\s*gandhi\s*salai/ },
    { key: 'ECR', test: /\becr\b|east\s*coast\s*road/ },
    { key: 'GST', test: /\bgst\s*road|grand\s*southern\s*trunk/ },
    { key: 'Radial Road', test: /radial\s*road/ },
    { key: 'Mount-Poonamallee', test: /mount\s*-?\s*poonamallee/ },
    { key: 'Velachery-Tambaram', test: /velachery\s*-?\s*tambaram/ },
  ];

  // Amenity/feature tags worth their own filter chip. Each is matched over
  // amenities + highlights + the brochure text, so a property that only
  // mentions its pool in prose is still findable by the chip.
  const AMENITY_TAGS = [
    { key: 'pool', label: 'Swimming Pool', test: /swimming\s*pool|\bpool\b|infinity\s*pool/ },
    { key: 'gym', label: 'Gym', test: /\bgym\b|gymnasium|fitness\s*(?:centre|center|studio)|health\s*club/ },
    { key: 'clubhouse', label: 'Clubhouse', test: /club\s*house|clubhouse/ },
    { key: 'play', label: "Children's Play Area", test: /play\s*area|kids\s*play|children'?s?\s*play|toddler/ },
    { key: 'gated', label: 'Gated Community', test: /gated\s*community|gated\s*(?:layout|enclave)/ },
    { key: 'lift', label: 'Lift', test: /\blifts?\b|elevator/ },
    { key: 'power', label: 'Power Backup', test: /power\s*back\s*up|powerbackup|generator|\bdg\b|genset/ },
    { key: 'security', label: '24x7 Security / CCTV', test: /cctv|24\s*[x*\/]\s*7\s*security|security\s*(?:cabin|system|surveillance)|gated\s*security/ },
    { key: 'park', label: 'Park / Landscaped Garden', test: /landscap|\bpark\b|garden|green\s*space/ },
    { key: 'jogging', label: 'Jogging / Walking Track', test: /jogging|walking\s*track|cycling\s*track/ },
    { key: 'sports', label: 'Sports Court', test: /badminton|tennis|basketball|pickle\s*ball|cricket\s*(?:net|pitch)|sports\s*court|multipurpose\s*court/ },
    { key: 'indoor', label: 'Indoor Games', test: /indoor\s*games|table\s*tennis|carrom|billiards|snooker|chess/ },
    { key: 'party', label: 'Party / Banquet Hall', test: /party\s*hall|banquet|multipurpose\s*hall|community\s*hall/ },
    { key: 'yoga', label: 'Yoga / Meditation', test: /yoga|meditation|aerobic/ },
    { key: 'ev', label: 'EV Charging', test: /ev\s*charg|electric\s*vehicle\s*charg/ },
    { key: 'solar', label: 'Solar', test: /solar/ },
    { key: 'rwh', label: 'Rainwater Harvesting', test: /rain\s*water\s*harvest|rwh/ },
    { key: 'stp', label: 'STP / Sewage Treatment', test: /\bstp\b|sewage\s*treatment/ },
    { key: 'amphi', label: 'Amphitheatre', test: /amphi\s*theat|amphitheatre|amphitheater/ },
    { key: 'terrace', label: 'Private Terrace', test: /private\s*terrace|terrace\s*garden|roof\s*terrace/ },
    { key: 'modular', label: 'Modular Kitchen', test: /modular\s*kitchen/ },
    { key: 'servant', label: 'Servant / Maid Room', test: /servant\s*room|maid'?s?\s*room|utility\s*room/ },
    { key: 'lake', label: 'Lake / Sea View', test: /lake\s*view|sea\s*view|beach\s*(?:front|view)|waterfront/ },
    { key: 'temple', label: 'Temple / Prayer Room', test: /temple|prayer\s*(?:room|hall)|pooja\s*room/ },
    { key: 'pet', label: 'Pet Friendly', test: /pet\s*friendly|pet\s*park/ },
    { key: 'senior', label: 'Senior Citizen Area', test: /senior\s*citizen|elderly/ },
  ];

  const APPROVALS = [
    { key: 'RERA', test: /\brera\b/ },
    { key: 'CMDA', test: /\bcmda\b/ },
    { key: 'DTCP', test: /\bdtcp\b/ },
    { key: 'Panchayat', test: /panchayat/ },
  ];

  const FACINGS = ['East', 'West', 'North', 'South'];

  // Price and size bands. The boundaries are the ones a Chennai agent
  // actually quotes, not equal-width buckets.
  const PRICE_BANDS = [
    { key: 'lt50', label: 'Under ₹50 L', lo: 0, hi: 50 * LAKH },
    { key: '50-75', label: '₹50 L – ₹75 L', lo: 50 * LAKH, hi: 75 * LAKH },
    { key: '75-100', label: '₹75 L – ₹1 Cr', lo: 75 * LAKH, hi: CR },
    { key: '1-2', label: '₹1 Cr – ₹2 Cr', lo: CR, hi: 2 * CR },
    { key: '2-5', label: '₹2 Cr – ₹5 Cr', lo: 2 * CR, hi: 5 * CR },
    { key: 'gt5', label: 'Above ₹5 Cr', lo: 5 * CR, hi: Infinity },
  ];
  const SQFT_BANDS = [
    { key: 'lt800', label: 'Under 800 sqft', lo: 0, hi: 800 },
    { key: '800-1200', label: '800 – 1,200 sqft', lo: 800, hi: 1200 },
    { key: '1200-1600', label: '1,200 – 1,600 sqft', lo: 1200, hi: 1600 },
    { key: '1600-2000', label: '1,600 – 2,000 sqft', lo: 1600, hi: 2000 },
    { key: '2000-3000', label: '2,000 – 3,000 sqft', lo: 2000, hi: 3000 },
    { key: 'gt3000', label: 'Above 3,000 sqft', lo: 3000, hi: Infinity },
  ];

  // ═══════ FIELD WEIGHTS ═══════
  //
  // What a term matching in this field is worth. A hit on the property name
  // or code is what the agent meant; a hit inside the brochure prose is a
  // long shot that should still be found but should never outrank a name.
  const FIELD_WEIGHT = {
    name: 10, propertyCode: 10, propertyId: 9, id: 6,
    location: 8, zone: 5, builder: 7, config: 6, type: 5,
    startingPrice: 4, price: 4, priceInCr: 3, pricePerSqft: 4,
    sqftRange: 4, builtupArea: 4, superBuiltupArea: 4, carpetArea: 4, plotSize: 4, uds: 4,
    totalLandArea: 3, possession: 3, possessionDate: 3, status: 3, availability: 3,
    highlights: 2.5, amenities: 2.5, nearby: 2.5, nearbyLandmark: 2.5, connectivity: 2.5,
    contactName: 2, contactNumber: 3, ownerContact: 2,
    facing: 2, furnishing: 2, vastu: 2, approval: 2, parkingType: 2, totalFloors: 2,
    floorNo: 2, bathrooms: 2, totalUnits: 2, totalTowers: 2, saleType: 2, newOrResale: 2,
    detailsText: 1, sheetNotes: 0.8, notes: 0.8
  };
  const DEFAULT_WEIGHT = 1.2;

  // Never searched: links are noise ("drive" would match every property with a
  // brochure), and bookkeeping is not something anyone looks for.
  const SKIP_KEYS = new Set([
    'brochureLink', 'photosLink', 'mapLink', 'detailsLink', 'imageUrl', 'thumbnail',
    'tenantId', 'createdAt', 'updatedAt', 'insertedAt', 'syncedAt', 'naFields',
    'soldOut', 'favorite', 'source'
  ]);

  // ═══════ INDEXING ═══════

  const cache = new WeakMap();

  function indexProperty(p) {
    let rec = cache.get(p);
    if (rec) return rec;

    const fieldText = {};
    const allParts = [];
    const push = (key, v) => {
      if (v == null) return;
      const t = typeof v;
      if (t === 'string' || t === 'number') {
        if (String(v) === '') return;
        fieldText[key] = (fieldText[key] ? fieldText[key] + ' ' : '') + normText(v);
        allParts.push(String(v));
      } else if (Array.isArray(v)) v.forEach(x => push(key, x));
      else if (t === 'object') {
        // sheetExtras — unmapped inventory columns. Keys are pushed as well as
        // values, so "instagram" finds the properties that carry that column.
        Object.entries(v).forEach(([k, val]) => { push(key, k.replace(/_/g, ' ')); push(key, val); });
      }
    };
    for (const k of Object.keys(p)) { if (!SKIP_KEYS.has(k)) push(k, p[k]); }

    const text = normText(allParts.join(' \n '));
    const tokens = new Set(text.split(' ').filter(Boolean));
    // The same text with the gaps inside digit runs closed up, so a contact
    // number stored as "93159 60906" is reachable by typing it either way.
    const digitText = text.replace(/(\d)\s+(?=\d)/g, '$1');

    // ── numbers ──
    const money = parseMoney(p.startingPrice, 'price');
    const money2 = parseMoney(p.price, 'price');
    const psf = parseMoney(p.pricePerSqft, 'psf');
    const price = money.price.concat(money2.price);
    const psfSpans = money.psf.concat(money2.psf, psf.psf, psf.price.map(r => r));
    const rent = money.rent.concat(money2.rent);

    const sqftParsed = parseRanges(p.sqftRange);
    const builtParsed = parseRanges(p.builtupArea);
    const superParsed = parseRanges(p.superBuiltupArea);
    const carpetParsed = parseRanges(p.carpetArea);
    const plotParsed = parseRanges(p.plotSize);
    const udsParsed = parseRanges(p.uds);

    const sqft = spansOf(sqftParsed).concat(spansOf(builtParsed), spansOf(plotParsed));
    const superb = spansOf(superParsed);
    const carpet = spansOf(carpetParsed);
    const uds = spansOf(udsParsed);
    // "Area" as an agent means it: whichever of the area columns is filled in.
    const anyArea = sqft.concat(superb, carpet);

    const landSqft = parseLandSqft(p.totalLandArea);
    const bhk = extractBhk([p.config, p.name, p.propertyType].filter(Boolean).join(' | '));
    const floors = extractFloors(p.totalFloors);
    const baths = parseRanges(p.bathrooms).first;
    const parkingN = parseRanges(p.parking).first;
    const units = parseRanges(p.totalUnits).first;

    // ── facets ──
    const type = normType(p.type || p.propertyType);
    const status = fold(p.status) === 'ready to move' ? 'ready' : 'upcoming';
    const locText = fold([p.location, p.zone, p.name, p.connectivity, p.nearbyLandmark].filter(Boolean).join(' , '));
    const areas = String(p.location || '').split(',')
      .map(s => s.trim()).filter(Boolean)
      .filter(s => !/^chennai$/i.test(s) && !/^tamil\s*nadu$/i.test(s) && !/^india$/i.test(s))
      .filter(s => !CORRIDORS.some(c => c.test.test(fold(s))));
    const corridor = CORRIDORS.filter(c => c.test.test(locText)).map(c => c.key);

    const featureText = fold([p.amenities, p.highlights, p.detailsText, p.powerBackup, p.ebGenerator, p.maintenance].filter(Boolean).join(' | '));
    const amenityTags = AMENITY_TAGS.filter(t => t.test.test(featureText)).map(t => t.key);

    const approvalText = fold([p.approval, p.highlights, p.detailsText].filter(Boolean).join(' | '));
    const approvals = APPROVALS.filter(a => a.test.test(approvalText)).map(a => a.key);

    // Both columns, and neither of the sheet's empty markers: one property
    // carries "----" in Facing and "East" in Main Door Facing, and reading
    // only the first would have called it unknown.
    const facingRaw = fold([p.facing, p.mainDoorFacing].filter(v => !isNoise(v)).join(' '));
    const facing = FACINGS.filter(f => new RegExp('\\b' + f.toLowerCase() + '\\b').test(facingRaw));

    const furnRaw = fold(p.furnishing || '');
    const furnishing = /semi/.test(furnRaw) ? 'Semi-Furnished'
      : /fully|full\b/.test(furnRaw) ? 'Fully Furnished'
        : /unfurnish|^un/.test(furnRaw) ? 'Unfurnished' : '';

    const vastu = /\byes\b|compliant|vaastu|vastu/.test(fold(p.vastu || '')) && !/^no\b/.test(fold(p.vastu || ''));

    const parkRaw = fold(p.parkingType || '');
    const parkingKind = [];
    if (/cover|stilt|basement|reserved/.test(parkRaw)) parkingKind.push('Covered');
    if (/\bopen\b/.test(parkRaw)) parkingKind.push('Open');

    const availRaw = fold(p.availability || '');
    const availability = p.soldOut ? 'Sold' : /sold/.test(availRaw) ? 'Sold' : /immediate|available/.test(availRaw) ? 'Available' : '';

    const saleRaw = fold([p.saleType, p.newOrResale].filter(Boolean).join(' '));
    const saleType = /resale|re-sale/.test(saleRaw) ? 'Resale' : /\bnew\b/.test(saleRaw) ? 'New' : '';

    const possession = possessionInfo(p, status);

    const priceLo = price.length ? Math.min.apply(null, price.map(r => r[0])) : null;
    const areaLo = anyArea.length ? Math.min.apply(null, anyArea.map(r => r[0])) : null;
    const priceBand = priceLo == null ? null : (PRICE_BANDS.find(b => priceLo >= b.lo && priceLo < b.hi) || {}).key || null;
    const sqftBand = areaLo == null ? null : (SQFT_BANDS.find(b => areaLo >= b.lo && areaLo < b.hi) || {}).key || null;

    rec = {
      p, id: p.id, text, digitText, tokens, fieldText,
      num: {
        price, psf: psfSpans, rent, sqft, superb, carpet, uds, area: anyArea,
        land: landSqft.map(n => [n, n]),
        units: units == null ? [] : [[units, units]],
        floors: floors == null ? [] : [[floors, floors]],
        bath: baths == null ? [] : [[baths, baths]],
        parking: parkingN == null ? [] : [[parkingN, parkingN]],
        bhk
      },
      facet: {
        type, status, availability, saleType, furnishing, vastu, priceBand, sqftBand,
        zone: p.zone || '',
        builder: p.builder || '',
        areas, corridor, facing, parkingKind, approvals, amenityTags,
        bhk, possession: possession.bucket,
        hasBrochure: !!p.brochureLink, hasPhotos: !!p.photosLink, hasMap: !!p.mapLink,
        soldOut: !!p.soldOut
      },
      possessionYear: possession.year
    };
    cache.set(p, rec);
    return rec;
  }

  // Readiness and a year, out of five columns that disagree with each other.
  // `status` wins on readiness because that is the field the dashboard's own
  // Ready/Upcoming counters have always used.
  function possessionInfo(p, status) {
    const s = fold([p.possession, p.possessionDate, p.readyToMove, p.constructionStage].filter(Boolean).join(' | '));
    if (status === 'ready') return { bucket: 'ready', year: null };
    const yearMatch = s.match(/\b(20\d\d)\b/);
    if (yearMatch) {
      const y = Number(yearMatch[1]);
      return { bucket: y <= 2026 ? '2026' : y === 2027 ? '2027' : y === 2028 ? '2028' : '2029', year: y };
    }
    const mo = s.match(/(\d+)\s*(?:-\s*\d+\s*)?month/);
    if (mo) {
      const y = new Date().getFullYear() + Math.ceil(Number(mo[1]) / 12);
      return { bucket: y <= 2026 ? '2026' : y === 2027 ? '2027' : y === 2028 ? '2028' : '2029', year: y };
    }
    if (/ready|immediate|rtm|rtc/.test(s)) return { bucket: 'ready', year: null };
    return { bucket: 'unknown', year: null };
  }

  const POSSESSION_LABEL = { ready: 'Ready to move', 2026: 'By 2026', 2027: 'In 2027', 2028: 'In 2028', 2029: '2029 or later', unknown: 'Not stated' };

  // ═══════ GAZETTEER ═══════
  //
  // The multi-word names that exist in THIS inventory — localities, builders,
  // project names. The query parser matches the longest of these first, so
  // "anna nagar" is one locality term rather than two loose words, and
  // "3 bhk in anna nagar or adyar" splits where an agent means it to.
  function buildGazetteer(list) {
    const areas = new Map(), builders = new Map(), names = new Map();
    const add = (map, raw, field) => {
      const n = normText(raw);
      if (!n || n.length < 3) return;
      if (!map.has(n)) map.set(n, { text: n, raw: String(raw).trim(), field, words: n.split(' ').length });
    };
    for (const p of list) {
      String(p.location || '').split(',').map(s => s.trim()).filter(Boolean)
        .forEach(seg => { if (!/^chennai$/i.test(seg)) add(areas, seg, 'area'); });
      if (p.zone) add(areas, p.zone, 'area');
      if (p.builder) add(builders, p.builder, 'builder');
      if (p.name) add(names, p.name, 'name');
      if (p.propertyCode) add(names, p.propertyCode, 'code');
    }
    const phrases = [...areas.values(), ...builders.values(), ...names.values()]
      .filter(e => e.words > 1)
      .sort((a, b) => b.text.length - a.text.length);
    return { areas, builders, names, phrases };
  }

  // ═══════ QUERY LANGUAGE ═══════

  // field:value — the explicit escape hatch when the guesser gets it wrong.
  const FIELD_ALIASES = {
    name: 'name', project: 'name', title: 'name',
    code: 'code', id: 'code', propertycode: 'code', ref: 'code',
    builder: 'builder', developer: 'builder', promoter: 'builder',
    location: 'area', area: 'area', locality: 'area', place: 'area', zone: 'zone',
    type: 'type', config: 'bhk', bhk: 'bhk', bedrooms: 'bhk', beds: 'bhk',
    price: 'price', budget: 'price', cost: 'price',
    psf: 'psf', rate: 'psf', persqft: 'psf', pricepersqft: 'psf',
    sqft: 'sqft', size: 'sqft', builtup: 'sqft', builtuparea: 'sqft', saleable: 'sqft',
    superbuiltup: 'superb', superbuiltuparea: 'superb',
    carpet: 'carpet', carpetarea: 'carpet',
    uds: 'uds', undividedshare: 'uds',
    land: 'land', landarea: 'land', plot: 'land', plotsize: 'sqft', extent: 'land',
    units: 'units', totalunits: 'units', floors: 'floors', totalfloors: 'floors',
    bath: 'bath', baths: 'bath', bathrooms: 'bath', toilets: 'bath',
    parking: 'parking', facing: 'facing', furnishing: 'furnishing',
    status: 'status', possession: 'possession', availability: 'availability',
    approval: 'approval', vastu: 'vastu', amenity: 'amenity', amenities: 'amenity',
    contact: 'contact', phone: 'contact', mobile: 'contact', number: 'contact',
    nearby: 'nearby', landmark: 'nearby', connectivity: 'nearby'
  };

  // Words that name a field rather than a value. They attach to the number
  // beside them ("1518 sqft", "built up area 1518") and otherwise drop out.
  const UNIT_HINTS = [
    { re: /^(?:super\s*built\s*-?\s*up(?:\s*area)?|sba|saleable(?:\s*area)?)$/, field: 'superb' },
    { re: /^(?:built\s*-?\s*up(?:\s*area)?|builtup|buildup|bua)$/, field: 'sqft' },
    { re: /^(?:carpet(?:\s*area)?)$/, field: 'carpet' },
    { re: /^(?:uds|undivided\s*share|undivided)$/, field: 'uds' },
    { re: /^(?:plot\s*(?:size|area)|land\s*(?:area|extent)|extent)$/, field: 'land' },
    { re: /^(?:sq\s*ft|sqft|sft|sq\s*feet|square\s*feet|square\s*foot|sqfeet|sq)$/, field: 'sqft' },
    { re: /^(?:per\s*sq\s*ft|psf|rate|price\s*per\s*sq\s*ft|per\s*sqft)$/, field: 'psf' },
    { re: /^(?:budget|price|cost|priced)$/, field: 'price' },
    { re: /^(?:bhk|bed\s*rooms?|beds?|bedroom)$/, field: 'bhk' },
    { re: /^(?:floors?|storeys?|stories)$/, field: 'floors' },
    { re: /^(?:units?)$/, field: 'units' },
    { re: /^(?:baths?|bathrooms?|toilets?|washrooms?)$/, field: 'bath' },
    { re: /^(?:car\s*parks?|parkings?|car\s*parking)$/, field: 'parking' },
    { re: /^(?:cents?)$/, field: 'land', scale: 435.6 },
    { re: /^(?:acres?)$/, field: 'land', scale: 43560 },
    { re: /^(?:grounds?)$/, field: 'land', scale: 2400 }
  ];

  // Dropped outright — they carry no signal but would otherwise be an
  // unmatchable AND clause that empties the result list. "in", "near", "with"
  // are how an agent speaks, not what they are looking for.
  const STOPWORDS = new Set([
    'in', 'at', 'on', 'of', 'the', 'a', 'an', 'to', 'for', 'with', 'and', 'or', 'is', 'are',
    'near', 'around', 'about', 'approx', 'approximately', 'nearby', 'close', 'by',
    'want', 'wants', 'need', 'needs', 'needed', 'looking', 'look', 'client', 'customer',
    'show', 'me', 'find', 'get', 'any', 'some', 'available', 'please', 'pls', 'property',
    'properties', 'option', 'options', 'something', 'anything', 'have', 'has', 'give',
    'prefer', 'prefers', 'preferably', 'budget', 'rs', 'inr', 'only', 'both', 'either'
  ]);
  // "budget" is a field hint AND a stopword — the hint list is consulted
  // first, so "budget 1.5cr" keeps its meaning and a bare "budget" drops.

  // Value vocabularies that classify a bare word into a facet.
  const VALUE_MAP = [
    { facet: 'status', value: 'ready', re: /^(?:ready|rtm|readytomove|readytomovein|ready-to-move|immediate|immediatepossession|readypossession|movein|move-in)$/ },
    { facet: 'status', value: 'upcoming', re: /^(?:upcoming|uc|underconstruction|under-construction|construction|ongoing|launch|prelaunch|pre-launch|newlaunch)$/ },
    { facet: 'type', value: 'Apartment', re: /^(?:apartment|apartments|flat|flats|apt|apts)$/ },
    { facet: 'type', value: 'Villa', re: /^(?:villa|villas|townhouse|townhouses|rowhouse|rowhouses)$/ },
    { facet: 'type', value: 'House', re: /^(?:independenthouse|individualhouse)$/ },
    { facet: 'type', value: 'Plot', re: /^(?:plot|plots|land|lands|site|sites|layout)$/ },
    { facet: 'type', value: 'Commercial', re: /^(?:commercial|office|offices|shop|shops|retail)$/ },
    { facet: 'vastu', value: true, re: /^(?:vastu|vaastu|vasthu|vaasthu)$/ },
    { facet: 'saleType', value: 'Resale', re: /^(?:resale)$/ },
    { facet: 'saleType', value: 'New', re: /^(?:newproperty|brandnew)$/ },
    { facet: 'facing', value: 'East', re: /^(?:east|eastfacing)$/ },
    { facet: 'facing', value: 'West', re: /^(?:west|westfacing)$/ },
    { facet: 'facing', value: 'North', re: /^(?:north|northfacing)$/ },
    { facet: 'facing', value: 'South', re: /^(?:south|southfacing)$/ },
    { facet: 'furnishing', value: 'Fully Furnished', re: /^(?:fullyfurnished|furnished)$/ },
    { facet: 'furnishing', value: 'Semi-Furnished', re: /^(?:semifurnished|semi)$/ },
    { facet: 'furnishing', value: 'Unfurnished', re: /^(?:unfurnished)$/ },
    { facet: 'parkingKind', value: 'Covered', re: /^(?:coveredparking|covered|stilt|basementparking)$/ },
    { facet: 'parkingKind', value: 'Open', re: /^(?:openparking)$/ },
    { facet: 'availability', value: 'Sold', re: /^(?:sold|soldout)$/ },
    { facet: 'approvals', value: 'RERA', re: /^(?:rera)$/ },
    { facet: 'approvals', value: 'CMDA', re: /^(?:cmda)$/ },
    { facet: 'approvals', value: 'DTCP', re: /^(?:dtcp)$/ },
    { facet: 'corridor', value: 'OMR', re: /^(?:omr)$/ },
    { facet: 'corridor', value: 'ECR', re: /^(?:ecr)$/ },
    { facet: 'corridor', value: 'GST', re: /^(?:gst|gstroad)$/ },
    { facet: 'hasBrochure', value: true, re: /^(?:brochure|withbrochure)$/ },
    { facet: 'hasPhotos', value: true, re: /^(?:photos|photo|images|pictures)$/ }
  ];

  // Magnitude words that follow a number instead of being glued to it —
  // "50 lakhs", "1.5 crore", "80 lakh". Without these "under 50 lakhs" parsed
  // as the number fifty and the loose word "lakhs".
  const MAG_WORDS = {
    cr: CR, crs: CR, crore: CR, crores: CR, cror: CR,
    l: LAKH, lac: LAKH, lacs: LAKH, lakh: LAKH, lakhs: LAKH, lakhes: LAKH,
    k: 1000, thousand: 1000, million: 1000000, mn: 1000000
  };

  const COMPARATORS = {
    under: 'lt', below: 'lt', less: 'lt', lesser: 'lt', upto: 'lt', max: 'lt', maximum: 'lt', within: 'lt', budget: null,
    over: 'gt', above: 'gt', more: 'gt', greater: 'gt', min: 'gt', minimum: 'gt', atleast: 'gt', plus: 'gt', beyond: 'gt'
  };

  // Turns a spoken money/size word into a number. "1.5cr" → 15000000,
  // "80l" → 8000000, "7000psf" stays 7000 with field psf.
  function readMagnitude(word) {
    const m = /^(\d+(?:\.\d+)?)(crores?|cr|c|lakhs?|lacs?|lakh|lac|l|k|sqft|sft|sqf|bhk|psf)?$/.exec(word);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const u = m[2] || '';
    if (/^cr|^c$|^crore/.test(u)) return { n: n * CR, field: 'price', explicit: true };
    if (/^lakh|^lac|^l$/.test(u)) return { n: n * LAKH, field: 'price', explicit: true };
    if (/^k$/.test(u)) return { n: n * 1000, field: null, explicit: false };
    if (/^sq/.test(u)) return { n, field: 'sqft', explicit: true };
    if (/^psf$/.test(u)) return { n, field: 'psf', explicit: true };
    if (/^bhk$/.test(u)) return { n, field: 'bhk', explicit: true };
    return { n, field: null, explicit: false };
  }

  // ── Lexing ──
  //
  // Produces atoms in source order, each already classified. Multi-word
  // gazetteer names and multi-word field hints are matched greedily first,
  // which is the whole reason "built up area" and "anna nagar" survive as
  // single ideas.
  function lexQuery(q, gaz) {
    const raw = dropDigitCommas(fold(q))
      .replace(/['’`]/g, '')
      // A phone number typed the way it is written down — "93159 60906",
      // "+91 93159 60906", "044 2345 6789" — is one number, not two.
      .replace(/\+?91[\s-]?(?=\d{10}\b)/g, '')
      .replace(/\b(\d{5})[\s-](\d{5})\b/g, '$1$2')
      .replace(/\b(\d{3})[\s-](\d{3})[\s-](\d{4})\b/g, '$1$2$3')
      .replace(/\b(\d{4})[\s-](\d{3})[\s-](\d{3})\b/g, '$1$2$3');
    const atoms = [];
    let i = 0;

    const HINT_PHRASES = [
      'super built up area', 'super built-up area', 'super builtup area', 'super built up', 'super builtup',
      'built up area', 'built-up area', 'builtup area', 'built up', 'built-up', 'builtup',
      'carpet area', 'plot size', 'plot area', 'land area', 'land extent',
      'undivided share', 'price per sqft', 'price per sq ft', 'per sq ft', 'per sqft',
      'sq ft', 'sq. ft', 'sq feet', 'square feet', 'square foot',
      'ready to move', 'ready to move in', 'under construction', 'new launch', 'pre launch',
      'independent house', 'individual house', 'row house', 'gated community',
      'east facing', 'west facing', 'north facing', 'south facing',
      'semi furnished', 'fully furnished', 'car parking', 'covered parking', 'open parking',
      'sold out', 'price on request', 'contact for details'
    ].sort((a, b) => b.length - a.length);

    while (i < raw.length) {
      const ch = raw[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '(') { atoms.push({ t: 'lp' }); i++; continue; }
      if (ch === ')') { atoms.push({ t: 'rp' }); i++; continue; }
      if (ch === '"' || ch === '“' || ch === '”') {
        const end = raw.indexOf('"', i + 1);
        const body = end === -1 ? raw.slice(i + 1) : raw.slice(i + 1, end);
        atoms.push({ t: 'term', kind: 'phrase', text: normText(body) });
        i = end === -1 ? raw.length : end + 1;
        continue;
      }
      if (ch === ',' || ch === '&' || ch === '|' || ch === '+' || ch === '/') {
        // A lone "+" or "/" between two values is a list separator, but a "+"
        // glued to a number ("2cr+") is a comparator and is read with it.
        atoms.push({ t: 'conn', v: ch === '|' ? 'or' : 'listsep' }); i++; continue;
      }
      // "-plot" excludes plots, but the hyphen inside "Ultra-Luxury" or
      // "Pallavaram-Thoraipakkam" is part of the word. Only a hyphen that
      // STARTS a term is a negation.
      if (ch === '-') {
        const atStart = i === 0 || /[\s(]/.test(raw[i - 1]);
        if (atStart && /^[a-z]/.test(raw.slice(i + 1))) { atoms.push({ t: 'not' }); i++; continue; }
        if (!/\d/.test(raw[i + 1] || '')) { i++; continue; }
      }
      if (ch === '>' || ch === '<') {
        const eq = raw[i + 1] === '=';
        atoms.push({ t: 'cmp', v: ch === '>' ? 'gt' : 'lt' });
        i += eq ? 2 : 1; continue;
      }

      // Greedy multi-word phrases.
      const rest = raw.slice(i);
      let matched = null;
      for (const ph of HINT_PHRASES) {
        if (rest.startsWith(ph) && !/[a-z0-9]/.test(rest[ph.length] || '')) { matched = { text: ph, len: ph.length }; break; }
      }
      if (matched) {
        const key = matched.text.replace(/[^a-z0-9]+/g, ' ').trim();
        const hint = UNIT_HINTS.find(h => h.re.test(key));
        if (hint) atoms.push({ t: 'hint', field: hint.field, scale: hint.scale || 1, text: key });
        else atoms.push({ t: 'word', w: key.replace(/\s+/g, ''), text: key, phrase: true });
        i += matched.len; continue;
      }
      if (gaz) {
        let g = null;
        for (const e of gaz.phrases) {
          if (rest.startsWith(e.text) && !/[a-z0-9]/.test(rest[e.text.length] || '')) { g = e; break; }
        }
        if (g) { atoms.push({ t: 'gaz', entry: g, text: g.text }); i += g.text.length; continue; }
      }

      // field:value
      const fv = /^([a-z][a-z_]*)\s*:\s*/.exec(rest);
      if (fv && FIELD_ALIASES[fv[1].replace(/_/g, '')]) {
        const field = FIELD_ALIASES[fv[1].replace(/_/g, '')];
        let j = i + fv[0].length;
        let val = '';
        if (raw[j] === '"') { const e = raw.indexOf('"', j + 1); val = raw.slice(j + 1, e === -1 ? raw.length : e); j = e === -1 ? raw.length : e + 1; }
        else { const mm = /^[^\s,()|&]+/.exec(raw.slice(j)) || ['']; val = mm[0]; j += mm[0].length; }
        atoms.push({ t: 'fielded', field, value: val.trim() });
        i = j; continue;
      }

      // A spoken range — "1500-2000", "1500 to 2000 sqft", "1 to 2 cr",
      // "3-4 bhk". Read as one interval rather than as two loose numbers, so
      // it is tested for OVERLAP with what the property offers: a project
      // selling 1,285–2,140 sqft answers "1500 to 2000" even though it lists
      // neither number.
      const isUnit = u => !!u && (MAG_WORDS[u] !== undefined || UNIT_HINTS.some(h => h.re.test(u)) || /^bhk$/.test(u));
      const nr = /^(\d+(?:\.\d+)?)\s*([a-z]*)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*([a-z]+)?/.exec(rest);
      if (nr && /^\d/.test(rest) && (!nr[2] || isUnit(nr[2]))) {
        const hiUnit = isUnit(nr[4]) ? nr[4] : '';
        atoms.push({ t: 'range', lo: parseFloat(nr[1]), hi: parseFloat(nr[3]), unit: hiUnit || nr[2] || '' });
        i += hiUnit ? nr[0].length : nr[0].length - (nr[4] || '').length;
        continue;
      }

      const w = /^[a-z0-9][a-z0-9.]*\+?/.exec(rest);
      if (!w) { i++; continue; }
      // The trailing "+" of "2cr+" is a comparator, not part of the number —
      // it stays on `text`, where the parser reads it, and comes off `w`.
      atoms.push({ t: 'word', w: w[0].replace(/[.]+$/, '').replace(/\+$/, ''), text: w[0] });
      i += w[0].length;
    }
    return atoms;
  }

  // ── Classifying an atom into a leaf clause ──

  function numLeaf(field, cmp, lo, hi, label) {
    return { kind: 'num', field, cmp, lo, hi, label };
  }

  // The result of reading the atom stream: a list of clauses, where a clause
  // is one leaf or an OR of leaves from the same field.
  function parseQuery(q, gaz) {
    const atoms = lexQuery(q, gaz);
    const leaves = [];          // in source order, with connector info
    let pendingHint = null;     // a field word waiting for its number
    let pendingCmp = null;
    let negateNext = false;
    let depth = 0;
    const groupStack = [];

    const emit = leaf => {
      if (!leaf) return;
      if (negateNext) { leaf.negate = true; negateNext = false; }
      leaf.depth = depth;
      leaves.push(leaf);
    };

    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      if (a.t === 'lp') { depth++; groupStack.push(leaves.length); continue; }
      if (a.t === 'rp') { depth = Math.max(0, depth - 1); groupStack.pop(); continue; }
      if (a.t === 'not') { negateNext = true; continue; }
      if (a.t === 'cmp') { pendingCmp = a.v; continue; }
      if (a.t === 'conn') { if (leaves.length) leaves[leaves.length - 1].conn = a.v; continue; }
      if (a.t === 'hint') { pendingHint = a; continue; }

      if (a.t === 'gaz') {
        emit({ kind: 'gaz', entry: a.entry, text: a.text, field: a.entry.field });
        continue;
      }

      if (a.t === 'fielded') {
        emit(fieldedLeaf(a.field, a.value));
        continue;
      }

      if (a.t === 'range') {
        let lo = a.lo, hi = a.hi, field = null;
        const u = a.unit;
        if (u && MAG_WORDS[u] !== undefined) { lo *= MAG_WORDS[u]; hi *= MAG_WORDS[u]; if (MAG_WORDS[u] >= LAKH) field = 'price'; }
        else if (u === 'bhk') field = 'bhk';
        else if (u) {
          const h = UNIT_HINTS.find(x => x.re.test(u));
          if (h) { field = h.field; if (h.scale && h.scale !== 1) { lo *= h.scale; hi *= h.scale; } }
        }
        if (!field && pendingHint) field = pendingHint.field;
        // A field word can also follow the range: "1500-2000 built up area".
        if (!field) {
          const nxt = atoms[i + 1];
          if (nxt && nxt.t === 'hint') { field = nxt.field; i++; }
          else if (nxt && nxt.t === 'word') {
            const h = UNIT_HINTS.find(x => x.re.test(nxt.w));
            if (h) { field = h.field; i++; }
            else if (MAG_WORDS[nxt.w] !== undefined) { lo *= MAG_WORDS[nxt.w]; hi *= MAG_WORDS[nxt.w]; if (MAG_WORDS[nxt.w] >= LAKH) field = 'price'; i++; }
            else if (nxt.w === 'bhk') { field = 'bhk'; i++; }
          }
        }
        pendingHint = null; pendingCmp = null;
        emit(numLeaf(field, 'range', Math.min(lo, hi), Math.max(lo, hi), a.lo + '-' + a.hi));
        continue;
      }

      // word
      const w = a.w;
      if (!w) continue;

      // connective words
      if (w === 'or') { if (leaves.length) leaves[leaves.length - 1].conn = 'or'; continue; }
      if (w === 'and') { if (leaves.length) leaves[leaves.length - 1].conn = 'and'; continue; }
      // "no" is deliberately NOT a negation word: in this inventory it is far
      // more often part of an address — "No. 158 & 159", "Plot No. 1309",
      // "Car_Parking_(No)" — than an instruction to exclude something.
      // Exclusion is "-term", "not", "without" or "except".
      if (w === 'not' || w === 'without' || w === 'except') { negateNext = true; continue; }
      if (w === 'between') { pendingCmp = 'between'; continue; }
      if (COMPARATORS[w] !== undefined) { if (COMPARATORS[w]) pendingCmp = COMPARATORS[w]; continue; }
      if (w === 'than' || w === 'then') continue;

      // "3bhk", "1.5cr", "1518sqft", "7000psf"
      const mag = readMagnitude(w);
      if (mag && /^\d/.test(w)) {
        let field = mag.field || (pendingHint ? pendingHint.field : null);
        let n = mag.n;
        if (!mag.explicit && pendingHint && pendingHint.scale && pendingHint.scale !== 1) n = n * pendingHint.scale;
        // A trailing "+" on a number is "and above".
        const plus = /\+$/.test(a.text);
        const cmp = plus ? 'gt' : (pendingCmp || 'eq');
        // A magnitude word standing on its own after the number belongs to
        // it: "50 lakhs" is one value, not a number and a stray word.
        const magWord = atoms[i + 1];
        if (!mag.explicit && magWord && magWord.t === 'word' && MAG_WORDS[magWord.w] !== undefined) {
          n = n * MAG_WORDS[magWord.w];
          if (MAG_WORDS[magWord.w] >= LAKH) field = 'price';
          i++;
        }
        // Look ahead: a bare number followed by a field word takes that field.
        if (!field) {
          const nxt = atoms[i + 1];
          if (nxt && nxt.t === 'hint') { field = nxt.field; if (nxt.scale && nxt.scale !== 1) n = n * nxt.scale; i++; }
          else if (nxt && nxt.t === 'word') {
            const m2 = UNIT_HINTS.find(h => h.re.test(nxt.w));
            if (m2) { field = m2.field; if (m2.scale && m2.scale !== 1) n = n * m2.scale; i++; }
            else if (/^bhk$/.test(nxt.w)) { field = 'bhk'; i++; }
          }
        }
        pendingHint = null;
        if (cmp === 'between') {
          // "between 1 and 2 cr" — the next number closes the interval, and
          // the unit sits at the far end where it governs BOTH sides.
          const nxtNum = findNextNumber(atoms, i + 1);
          if (nxtNum) {
            const hiMag = readMagnitude(nxtNum.atom.w);
            if (hiMag) {
              let hi = hiMag.n, lo = mag.n, f = field || hiMag.field;
              let j = nxtNum.index;
              const after = atoms[j + 1];
              let scale = 1;
              if (!hiMag.explicit && after && after.t === 'word' && MAG_WORDS[after.w] !== undefined) {
                scale = MAG_WORDS[after.w];
                if (scale >= LAKH) f = 'price';
                j++;
              }
              hi *= scale;
              if (!mag.explicit) lo *= scale;
              pendingCmp = null; pendingHint = null; i = j;
              emit(numLeaf(f, 'range', Math.min(lo, hi), Math.max(lo, hi), `${lo}-${hi}`));
              continue;
            }
          }
        }
        pendingCmp = null;
        emit(numLeaf(field, cmp, n, n, a.text));
        continue;
      }

      if (STOPWORDS.has(w) && !UNIT_HINTS.some(h => h.re.test(w))) { pendingHint = null; continue; }

      const hintHit = UNIT_HINTS.find(h => h.re.test(w));
      if (hintHit) {
        // A field word directly after a number attaches to it retroactively.
        const prev = leaves[leaves.length - 1];
        if (prev && prev.kind === 'num' && !prev.field) {
          prev.field = hintHit.field;
          if (hintHit.scale && hintHit.scale !== 1) { prev.lo *= hintHit.scale; prev.hi *= hintHit.scale; }
        } else pendingHint = { field: hintHit.field, scale: hintHit.scale || 1 };
        continue;
      }

      const vm = VALUE_MAP.find(v => v.re.test(w));
      if (vm) {
        // "Plot No. 1309" is an address, not a request for plots — and the
        // flat at that address is an apartment. A value word followed by
        // "no"/"number" and a figure is read as part of an address instead.
        const n1 = atoms[i + 1], n2 = atoms[i + 2];
        const addressish = n1 && n1.t === 'word' && /^(?:no|number|door|flat|survey)$/.test(n1.w)
          && n2 && n2.t === 'word' && /^\d/.test(n2.w);
        if (!addressish) { emit({ kind: 'facet', facet: vm.facet, value: vm.value, text: w }); continue; }
      }

      // A single-word locality or builder that exists in THIS inventory —
      // "adyar", "porur", "sobha". Classifying it as a locality rather than a
      // loose word is what lets "anna nagar and adyar" group into one OR:
      // both leaves then name the same field.
      if (gaz) {
        const g = gaz.areas.get(w) || gaz.builders.get(w);
        if (g) { pendingHint = null; emit({ kind: 'gaz', entry: g, text: g.text, field: g.field }); continue; }
      }

      pendingHint = null;
      emit({ kind: 'text', text: a.phrase ? a.text : w, phrase: !!a.phrase });
    }

    return groupClauses(propagateNumFields(leaves));
  }

  // "3 and 4 bhk" says BHK once, at the end. The leading 3 arrives with no
  // field of its own, and without this it would be matched as a loose number
  // against every column — which is how that query used to return nothing.
  // A bare number joined by a connector to a number that DOES name a field
  // takes that field. Backwards first, because the field word almost always
  // comes last in speech ("2 or 3 bhk", "1500 to 1800 sqft").
  function propagateNumFields(leaves) {
    for (let i = leaves.length - 2; i >= 0; i--) {
      const l = leaves[i], next = leaves[i + 1];
      if (l.kind === 'num' && !l.field && l.conn && next.kind === 'num' && next.field) l.field = next.field;
    }
    for (let i = 1; i < leaves.length; i++) {
      const l = leaves[i], prev = leaves[i - 1];
      if (l.kind === 'num' && !l.field && prev.conn && prev.kind === 'num' && prev.field) l.field = prev.field;
    }
    return leaves;
  }

  function findNextNumber(atoms, from) {
    for (let i = from; i < atoms.length && i < from + 4; i++) {
      const a = atoms[i];
      if (a.t === 'word' && /^\d/.test(a.w)) return { atom: a, index: i };
      if (a.t === 'word' && (a.w === 'and' || a.w === 'to' || a.w === 'or')) continue;
      if (a.t === 'conn') continue;
      return null;
    }
    return null;
  }

  function fieldedLeaf(field, value) {
    const NUM_FIELDS = new Set(['price', 'psf', 'sqft', 'superb', 'carpet', 'uds', 'land', 'units', 'floors', 'bath', 'parking', 'bhk']);
    if (NUM_FIELDS.has(field)) {
      const v = value.replace(/\s+/g, '');
      let m = /^(\d+(?:\.\d+)?[a-z]*)-(\d+(?:\.\d+)?[a-z]*)$/.exec(v);
      if (m) {
        const a = readMagnitude(m[1]), b = readMagnitude(m[2]);
        if (a && b) return numLeaf(field, 'range', Math.min(a.n, b.n), Math.max(a.n, b.n), value);
      }
      m = /^([<>]=?)(.+)$/.exec(v);
      if (m) { const a = readMagnitude(m[2]); if (a) return numLeaf(field, m[1][0] === '>' ? 'gt' : 'lt', a.n, a.n, value); }
      const a = readMagnitude(v.replace(/\+$/, ''));
      if (a) return numLeaf(field, /\+$/.test(v) ? 'gt' : 'eq', a.n, a.n, value);
      return { kind: 'text', text: normText(value) };
    }
    if (field === 'vastu') return { kind: 'facet', facet: 'vastu', value: true, text: value };
    if (field === 'status') {
      const v = fold(value);
      return { kind: 'facet', facet: 'status', value: /ready|rtm|immediate/.test(v) ? 'ready' : 'upcoming', text: value };
    }
    if (field === 'type') return { kind: 'facet', facet: 'type', value: normType(value), text: value };
    return { kind: 'scoped', field, text: normText(value) };
  }

  // A run of leaves joined by a list separator or by "and"/"or" that all name
  // the SAME field collapses into one OR clause. This is the rule that makes
  // "3 and 4 bhk in anna nagar and adyar" mean what an agent means by it.
  // Fields a property can hold only ONE value of. Two of them side by side —
  // "adyar mylapore", "3bhk 4bhk", "east west" — cannot both be required, so
  // ANDing them could only ever return nothing. They are ORed even with no
  // "or" between them, which is how an agent reading three localities off a
  // client's message expects it to behave.
  const MUTEX_FIELDS = new Set([
    'gaz:area', 'gaz:builder', 'facet:type', 'facet:status', 'facet:facing',
    'facet:furnishing', 'facet:corridor', 'facet:saleType', 'facet:availability', 'num:bhk'
  ]);

  function groupClauses(leaves) {
    const fieldOf = l =>
      l.kind === 'num' ? 'num:' + (l.field || '?')
        : l.kind === 'facet' ? 'facet:' + l.facet
          : l.kind === 'gaz' ? 'gaz:' + l.field
            : l.kind === 'scoped' ? 'scoped:' + l.field
              : 'text';
    const clauses = [];
    let cur = null;
    for (let i = 0; i < leaves.length; i++) {
      const l = leaves[i];
      const prev = leaves[i - 1];
      const joined = prev && (prev.conn === 'or' || prev.conn === 'listsep' || prev.conn === 'and');
      const sameField = prev && fieldOf(prev) === fieldOf(l) && !l.negate && !prev.negate;
      const explicitOr = prev && prev.conn === 'or';
      // Bare numbers with no field yet are grouped with a neighbouring bare
      // number too ("1500 1800 sqft" is a pair of candidate sizes).
      const mutex = sameField && MUTEX_FIELDS.has(fieldOf(l));
      if (cur && (joined || mutex) && (sameField || (explicitOr && !l.negate))) { cur.leaves.push(l); continue; }
      cur = { leaves: [l], negate: !!l.negate };
      clauses.push(cur);
    }
    return clauses;
  }

  // ═══════ MATCHING ═══════

  // Areas are hand-entered to two decimals ("813.89 Sq.ft", "2,242.70") and
  // spoken as whole numbers, so an area comparison tolerates half a foot.
  // Everything else is exact.
  const EPS = 0.001, AREA_EPS = 0.5;
  const AREA_FIELDS = new Set(['sqft', 'superb', 'carpet', 'uds', 'land']);
  const tolFor = field => (AREA_FIELDS.has(field) ? AREA_EPS : EPS);

  const spanHas = (spans, n, t) => spans.some(s => n >= s[0] - (t || EPS) && n <= s[1] + (t || EPS));
  const spanOverlaps = (spans, lo, hi, t) => spans.some(s => s[1] >= lo - (t || EPS) && s[0] <= hi + (t || EPS));
  const spanAbove = (spans, n, t) => spans.some(s => s[1] >= n - (t || EPS));
  const spanBelow = (spans, n, t) => spans.some(s => s[0] <= n + (t || EPS));

  const NUM_FIELD_SPANS = {
    price: r => r.num.price, psf: r => r.num.psf, sqft: r => r.num.sqft.concat(r.num.superb, r.num.carpet),
    superb: r => r.num.superb, carpet: r => r.num.carpet, uds: r => r.num.uds,
    land: r => r.num.land, units: r => r.num.units, floors: r => r.num.floors,
    bath: r => r.num.bath, parking: r => r.num.parking,
    bhk: r => r.num.bhk.map(n => [n, n])
  };
  const NUM_FIELD_LABEL = {
    price: 'price', psf: 'rate/sqft', sqft: 'built-up', superb: 'super built-up', carpet: 'carpet',
    uds: 'UDS', land: 'land', units: 'units', floors: 'floors', bath: 'baths', parking: 'parking', bhk: 'BHK'
  };

  // A number with no field named. Tried against the areas first (that is what
  // three- and four-digit numbers nearly always are) and against the literal
  // text always, so an exact UDS or unit count is never lost.
  const GUESS_ORDER = ['sqft', 'uds', 'land', 'psf', 'units', 'price'];

  function matchTextTerm(rec, term, opts) {
    const o = opts || {};
    const fields = o.fields || Object.keys(rec.fieldText);
    let best = 0, bestField = '';
    for (const f of fields) {
      const hay = rec.fieldText[f];
      if (!hay) continue;
      const w = (o.weightOverride != null ? o.weightOverride : (FIELD_WEIGHT[f] || DEFAULT_WEIGHT));
      let s = 0;
      if (hay === term) s = 1.3;
      else if (new RegExp('(?:^| )' + escapeRe(term) + '(?:$| )').test(hay)) s = 1;
      else if (hay.includes(term)) s = term.length >= 3 ? 0.62 : 0;
      else if (!o.noFuzzy) {
        const budget = fuzzyBudget(term);
        if (budget > 0) {
          for (const word of hay.split(' ')) {
            if (Math.abs(word.length - term.length) > budget) continue;
            if (withinDistance(term, word, budget) >= 0) { s = 0.42; break; }
          }
        }
      }
      if (s > 0 && s * w > best) { best = s * w; bestField = f; }
    }
    // A long run of digits — a phone number, a RERA registration, a plot
    // number — is compared again against the text with the gaps inside digit
    // runs closed, so "93159 60906" and "9315960906" are the same number.
    if (!best && /^\d{6,}$/.test(term) && rec.digitText && rec.digitText.includes(term)) {
      return { score: 3, field: 'contactNumber' };
    }
    return { score: best, field: bestField };
  }

  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function matchLeaf(rec, leaf) {
    switch (leaf.kind) {
      case 'text': case 'phrase': {
        const r = matchTextTerm(rec, leaf.text);
        return r.score > 0 ? { score: r.score, reason: `${leaf.text} in ${humanField(r.field)}` } : null;
      }
      case 'gaz': {
        const e = leaf.entry;
        const fields = e.field === 'area' ? ['location', 'zone', 'connectivity', 'nearbyLandmark', 'nearby', 'name']
          : e.field === 'builder' ? ['builder', 'name']
            : ['name', 'propertyCode', 'propertyId'];
        const r = matchTextTerm(rec, e.text, { fields });
        if (r.score > 0) return { score: r.score + 2, reason: `${e.raw} in ${humanField(r.field)}` };
        const any = matchTextTerm(rec, e.text);
        return any.score > 0 ? { score: any.score, reason: `${e.raw} in ${humanField(any.field)}` } : null;
      }
      case 'scoped': {
        const map = {
          name: ['name'], code: ['propertyCode', 'propertyId', 'id'], builder: ['builder'],
          area: ['location', 'zone', 'nearby', 'nearbyLandmark', 'connectivity'], zone: ['zone'],
          possession: ['possession', 'possessionDate'], availability: ['availability'],
          approval: ['approval', 'highlights'], amenity: ['amenities', 'highlights', 'detailsText'],
          contact: ['contactNumber', 'contactName', 'ownerContact'], nearby: ['nearby', 'nearbyLandmark', 'connectivity'],
          facing: ['facing', 'mainDoorFacing'], furnishing: ['furnishing'], parking: ['parkingType', 'parking']
        };
        const r = matchTextTerm(rec, leaf.text, { fields: map[leaf.field] || undefined });
        return r.score > 0 ? { score: r.score + 1, reason: `${leaf.field}: ${leaf.text}` } : null;
      }
      case 'facet': {
        const f = rec.facet;
        const val = leaf.value;
        const has = (arr, v) => Array.isArray(arr) && arr.some(x => String(x) === String(v));
        let ok = false;
        switch (leaf.facet) {
          case 'status': ok = f.status === val; break;
          case 'type': ok = f.type === val; break;
          case 'vastu': ok = !!f.vastu; break;
          case 'saleType': ok = f.saleType === val; break;
          case 'facing': ok = has(f.facing, val); break;
          case 'furnishing': ok = f.furnishing === val; break;
          case 'parkingKind': ok = has(f.parkingKind, val); break;
          case 'availability': ok = f.availability === val || (val === 'Sold' && f.soldOut); break;
          case 'approvals': ok = has(f.approvals, val); break;
          case 'corridor': ok = has(f.corridor, val); break;
          case 'amenityTags': ok = has(f.amenityTags, val); break;
          case 'hasBrochure': ok = !!f.hasBrochure; break;
          case 'hasPhotos': ok = !!f.hasPhotos; break;
          case 'bhk': ok = has(f.bhk, val); break;
          default: ok = false;
        }
        return ok ? { score: 6, reason: facetReason(leaf.facet, val) } : null;
      }
      case 'num': return matchNum(rec, leaf);
      default: return null;
    }
  }

  const FACET_REASON = {
    status: v => v === 'ready' ? 'Ready to Move' : 'Under Construction',
    type: v => TYPE_LABEL[v] || v,
    vastu: () => 'Vastu compliant',
    saleType: v => v,
    facing: v => v + ' facing',
    furnishing: v => v,
    parkingKind: v => v + ' parking',
    availability: v => v,
    approvals: v => v + ' approved',
    corridor: v => 'on ' + v,
    amenityTags: v => (AMENITY_TAGS.find(t => t.key === v) || {}).label || v,
    hasBrochure: () => 'brochure on file',
    hasPhotos: () => 'photos on file',
    bhk: v => v + ' BHK'
  };
  const facetReason = (facet, val) => (FACET_REASON[facet] ? FACET_REASON[facet](val) : `${facet}: ${val}`);

  function matchNum(rec, leaf) {
    const { field, cmp, lo, hi } = leaf;
    const test = (spans, label, weight, tolField) => {
      if (!spans || !spans.length) return null;
      const t = tolFor(tolField);
      if (cmp === 'eq') {
        if (spanHas(spans, lo, t)) {
          const exact = spans.some(s => s[0] === s[1] && Math.abs(s[0] - lo) <= t);
          // "BHK 3 is 3 BHK" is not a sentence. A configuration match needs
          // no explaining; a range that merely COVERS the asked-for number
          // does, and that is the case this line exists for.
          const reason = field === 'bhk' ? `${lo} BHK`
            : `${label} ${fmtSpanFor(spans, lo, t)} ${exact ? 'is' : 'covers'} ${fmtNum(lo, field)}`;
          return { score: weight * (exact ? 1.6 : 1), reason };
        }
        return null;
      }
      if (cmp === 'gt') return spanAbove(spans, lo, t) ? { score: weight * 0.9, reason: `${label} reaches ${fmtNum(lo, field)}+` } : null;
      if (cmp === 'lt') return spanBelow(spans, hi, t) ? { score: weight * 0.9, reason: `${label} starts at or under ${fmtNum(hi, field)}` } : null;
      if (cmp === 'range') return spanOverlaps(spans, lo, hi, t) ? { score: weight * 1.1, reason: `${label} overlaps ${fmtNum(lo, field)}–${fmtNum(hi, field)}` } : null;
      return null;
    };

    if (field) {
      const get = NUM_FIELD_SPANS[field];
      const spans = get ? get(rec) : null;
      const hit = spans ? test(spans, NUM_FIELD_LABEL[field], 7, field) : null;
      if (hit) return hit;
      // A scoped number that finds no data in its own field gets a literal
      // chance — "uds 1140" when the UDS column is blank but 1,140 is written
      // into the brochure text. Only when that field is genuinely empty, only
      // for a number distinctive enough to mean something (three digits or
      // more), and never for BHK or price, where the parse is authoritative
      // and a stray "3" in a postcode is not a three-bedroom flat.
      if (cmp === 'eq' && lo >= 100 && (!spans || !spans.length) && field !== 'bhk' && field !== 'price') {
        const lit = literalNumber(rec, lo);
        if (lit) return { score: lit.score * 0.7, reason: lit.reason };
      }
      return null;
    }

    // Unscoped number.
    if (cmp === 'eq') {
      const lit = literalNumber(rec, lo);
      let best = lit;
      for (const f of GUESS_ORDER) {
        const spans = NUM_FIELD_SPANS[f](rec);
        const hit = test(spans, NUM_FIELD_LABEL[f], f === 'sqft' ? 6 : 4, f);
        if (hit && (!best || hit.score > best.score)) best = hit;
      }
      if (lo >= 1 && lo <= 12 && rec.num.bhk.includes(lo)) {
        const hit = { score: 5, reason: `${lo} BHK` };
        if (!best || hit.score > best.score) best = hit;
      }
      return best;
    }
    // ">2cr" with no field named: price if it reads like money, else size.
    const guess = lo >= LAKH ? ['price'] : lo >= 100 ? ['sqft', 'psf', 'land'] : ['bhk', 'floors', 'units'];
    for (const f of guess) {
      const hit = test(NUM_FIELD_SPANS[f](rec), NUM_FIELD_LABEL[f], 5, f);
      if (hit) return hit;
    }
    return null;
  }

  // Literal presence of the digits anywhere — the floor that keeps an exact
  // number findable whatever column it landed in, comma or no comma.
  function literalNumber(rec, n) {
    const asInt = Number.isInteger(n) ? String(n) : String(n);
    const r = matchTextTerm(rec, asInt, { noFuzzy: true });
    if (r.score > 0) return { score: r.score * 0.9, reason: `${asInt} in ${humanField(r.field)}` };
    return null;
  }

  function fmtNum(n, field) {
    if (field === 'price') return n >= CR ? '₹' + round2(n / CR) + ' Cr' : n >= LAKH ? '₹' + round2(n / LAKH) + ' L' : '₹' + Math.round(n).toLocaleString('en-IN');
    if (field === 'bhk') return n + ' BHK';
    return Math.round(n).toLocaleString('en-IN');
  }
  const round2 = n => Math.round(n * 100) / 100;

  function fmtSpanFor(spans, n, t) {
    const tol = t || EPS;
    const s = spans.find(x => n >= x[0] - tol && n <= x[1] + tol) || spans[0];
    return s[0] === s[1] ? String(round2(s[0])) : round2(s[0]) + '–' + round2(s[1]);
  }

  const FIELD_HUMAN = {
    name: 'name', propertyCode: 'code', propertyId: 'code', builder: 'builder', location: 'location',
    zone: 'zone', config: 'configuration', type: 'type', startingPrice: 'price', pricePerSqft: 'rate',
    sqftRange: 'built-up area', builtupArea: 'built-up area', superBuiltupArea: 'super built-up',
    carpetArea: 'carpet area', uds: 'UDS', totalLandArea: 'land area', plotSize: 'plot size',
    amenities: 'amenities', highlights: 'highlights', nearby: 'nearby', nearbyLandmark: 'landmark',
    connectivity: 'connectivity', detailsText: 'brochure text', contactNumber: 'contact',
    possession: 'possession', totalUnits: 'units', totalFloors: 'floors', bathrooms: 'baths'
  };
  const humanField = f => FIELD_HUMAN[f] || f;

  // ═══════ SEARCH ═══════

  // A clause matches if ANY of its leaves match (they are the same field
  // ORed); the property must satisfy every clause.
  function scoreProperty(rec, clauses) {
    let total = 0;
    const reasons = [];
    for (const c of clauses) {
      let best = null;
      for (const leaf of c.leaves) {
        const hit = matchLeaf(rec, leaf);
        if (hit && (!best || hit.score > best.score)) best = hit;
      }
      if (c.negate) { if (best) return null; continue; }
      if (!best) return null;
      total += best.score;
      if (best.reason && reasons.length < 4) reasons.push(best.reason);
    }
    return { score: total, reasons };
  }

  // ═══════ ADVANCED (STRUCTURED) QUERY ═══════
  //
  // What the Advanced Search panel produces. Values inside one rule are ORed,
  // rules are combined by `match` — which is the panel's ALL/ANY switch.
  //
  //   { match:'all', rules:[ {field:'bhk', values:[3,4]},
  //                          {field:'area', values:['Anna Nagar','Adyar']},
  //                          {field:'price', min:0, max:20000000} ] }
  function matchAdvanced(rec, adv) {
    if (!adv || !adv.rules || !adv.rules.length) return { ok: true, score: 0, reasons: [] };
    const results = adv.rules.map(rule => matchRule(rec, rule));
    const ok = adv.match === 'any' ? results.some(r => r.ok) : results.every(r => r.ok);
    const reasons = results.filter(r => r.ok && r.reason).map(r => r.reason);
    return { ok, score: results.filter(r => r.ok).length * 3, reasons };
  }

  const RULE_NUM_FIELDS = new Set(['price', 'psf', 'sqft', 'superb', 'carpet', 'uds', 'land', 'units', 'floors', 'bath', 'parking']);

  function matchRule(rec, rule) {
    const f = rec.facet;
    if (RULE_NUM_FIELDS.has(rule.field)) {
      const spans = NUM_FIELD_SPANS[rule.field](rec);
      const lo = rule.min == null || rule.min === '' ? -Infinity : Number(rule.min);
      const hi = rule.max == null || rule.max === '' ? Infinity : Number(rule.max);
      if (!spans.length) return { ok: !!rule.includeUnknown, reason: '' };
      const ok = spanOverlaps(spans, lo, hi);
      return { ok, reason: ok ? `${NUM_FIELD_LABEL[rule.field]} in range` : '' };
    }
    const vals = (rule.values || []).map(String);
    if (!vals.length) return { ok: true, reason: '' };
    const anyOf = (arr) => Array.isArray(arr) && arr.some(x => vals.includes(String(x)));
    const oneOf = (v) => vals.includes(String(v));
    switch (rule.field) {
      case 'bhk': return { ok: anyOf(f.bhk), reason: 'BHK' };
      case 'type': return { ok: oneOf(f.type), reason: 'type' };
      case 'status': return { ok: oneOf(f.status), reason: 'status' };
      case 'zone': return { ok: oneOf(f.zone), reason: 'zone' };
      case 'area': {
        const ok = f.areas.some(a => vals.some(v => normText(a) === normText(v)));
        return { ok, reason: 'locality' };
      }
      case 'corridor': return { ok: anyOf(f.corridor), reason: 'corridor' };
      case 'builder': return { ok: oneOf(f.builder), reason: 'builder' };
      case 'facing': return { ok: anyOf(f.facing), reason: 'facing' };
      case 'furnishing': return { ok: oneOf(f.furnishing), reason: 'furnishing' };
      case 'parkingKind': return { ok: anyOf(f.parkingKind), reason: 'parking' };
      case 'approvals': return { ok: anyOf(f.approvals), reason: 'approval' };
      case 'amenityTags': {
        // Amenities are the one facet where an agent usually means ALL of
        // them ("pool AND gym"), so this rule takes an explicit mode.
        const ok = rule.mode === 'any' ? anyOf(f.amenityTags) : vals.every(v => f.amenityTags.includes(v));
        return { ok, reason: 'amenities' };
      }
      case 'possession': return { ok: oneOf(f.possession), reason: 'possession' };
      case 'availability': return { ok: oneOf(f.availability), reason: 'availability' };
      case 'saleType': return { ok: oneOf(f.saleType), reason: 'sale type' };
      case 'vastu': return { ok: !!f.vastu, reason: 'vastu' };
      case 'priceBand': return { ok: oneOf(f.priceBand), reason: 'budget' };
      case 'sqftBand': return { ok: oneOf(f.sqftBand), reason: 'size' };
      case 'hasBrochure': return { ok: !!f.hasBrochure, reason: 'brochure' };
      case 'hasPhotos': return { ok: !!f.hasPhotos, reason: 'photos' };
      default: return { ok: true, reason: '' };
    }
  }

  // ═══════ PUBLIC ENTRY POINT ═══════

  // list        — the properties to search
  // text        — what is in the search box
  // advanced    — the structured query from the panel (optional)
  // gaz         — a gazetteer from buildGazetteer(list) (optional but better)
  //
  // Returns [{ p, score, reasons }] in best-match order. With no query at all
  // it returns everything, score 0, which lets the caller keep its own sort.
  function search(list, opts) {
    const o = opts || {};
    const text = (o.text || '').trim();
    const adv = o.advanced && o.advanced.rules && o.advanced.rules.length ? o.advanced : null;
    if (!text && !adv) return list.map(p => ({ p, score: 0, reasons: [] }));
    const gaz = o.gazetteer || (text ? buildGazetteer(list) : null);
    const clauses = text ? parseQuery(text, gaz) : [];
    const out = [];
    for (const p of list) {
      const rec = indexProperty(p);
      let score = 0;
      let reasons = [];
      if (clauses.length) {
        const r = scoreProperty(rec, clauses);
        if (!r) continue;
        score += r.score; reasons = reasons.concat(r.reasons);
      }
      if (adv) {
        const r = matchAdvanced(rec, adv);
        if (!r.ok) continue;
        score += r.score;
      }
      out.push({ p, score, reasons });
    }
    out.sort((a, b) => b.score - a.score);

    // Nothing matched. Before answering "no properties", try again treating
    // the whole query as plain words — every word has to appear somewhere,
    // typos allowed. This is the safety net under all the cleverness above:
    // a property whose NAME is "Commercial Land, H-Block" or "Arun Excello
    // TEMPLE GREEN ACRES 1-3" reads, to the parser, as contradictory facets
    // and an unscoped range, and must still be findable by its own name.
    if (!out.length && text && clauses.length) {
      const loose = looseSearch(list, text, adv);
      if (loose.length) return loose;
    }
    return out;
  }

  function looseSearch(list, text, adv) {
    const terms = normText(text).split(' ')
      .filter(t => t && !STOPWORDS.has(t) && t.length > 1);
    if (!terms.length) return [];
    const out = [];
    for (const p of list) {
      const rec = indexProperty(p);
      if (adv && !matchAdvanced(rec, adv).ok) continue;
      let score = 0;
      const reasons = [];
      let ok = true;
      for (const t of terms) {
        const r = matchTextTerm(rec, t);
        if (!r.score) { ok = false; break; }
        score += r.score;
        if (reasons.length < 3) reasons.push(`${t} in ${humanField(r.field)}`);
      }
      if (ok) out.push({ p, score: score * 0.5, reasons, loose: true });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  // ═══════ FACETS FOR THE PANEL ═══════
  //
  // Built from the data, never hand-listed, so a filter appears the moment
  // the inventory starts carrying that fact and its count is always real.
  function buildFacets(list) {
    const recs = list.map(indexProperty);
    const tally = (get) => {
      const m = new Map();
      recs.forEach(r => {
        const v = get(r);
        (Array.isArray(v) ? v : [v]).forEach(x => {
          if (x == null || x === '' || x === false) return;
          const k = String(x);
          m.set(k, (m.get(k) || 0) + 1);
        });
      });
      return m;
    };
    const rows = (m, labeller) => [...m.entries()]
      .map(([value, count]) => ({ value, count, label: labeller ? labeller(value) : value }))
      .filter(r => r.count > 0);
    const byCount = a => a.sort((x, y) => y.count - x.count || String(x.label).localeCompare(String(y.label)));
    const byLabel = a => a.sort((x, y) => String(x.label).localeCompare(String(y.label)));

    // Localities are keyed on their normalised form so the sheet's two
    // spellings of one place ("T. Nagar" and "T Nagar") are one chip with one
    // true count — a filter on either spelling returns the same three
    // properties, so offering two chips of two and one would be a lie. The
    // label shown is whichever spelling the inventory uses most.
    const areaCounts = new Map();
    recs.forEach(r => {
      const seen = new Set();
      r.facet.areas.forEach(a => {
        const k = normText(a);
        if (!k || seen.has(k)) return;
        seen.add(k);
        const e = areaCounts.get(k) || { count: 0, labels: new Map() };
        e.count++;
        const raw = String(a).trim();
        e.labels.set(raw, (e.labels.get(raw) || 0) + 1);
        areaCounts.set(k, e);
      });
    });

    const bandRows = (bands, key) => bands
      .map(b => ({ value: b.key, label: b.label, count: recs.filter(r => r.facet[key] === b.key).length }))
      .filter(r => r.count > 0);

    return [
      { field: 'bhk', label: 'Configuration (BHK)', kind: 'chips', options: rows(tally(r => r.facet.bhk), v => v + ' BHK').sort((a, b) => Number(a.value) - Number(b.value)) },
      { field: 'type', label: 'Property type', kind: 'chips', options: byCount(rows(tally(r => r.facet.type), v => TYPE_LABEL[v] || v)) },
      { field: 'status', label: 'Status', kind: 'chips', options: rows(tally(r => r.facet.status), v => v === 'ready' ? 'Ready to Move' : 'Under Construction') },
      { field: 'priceBand', label: 'Budget', kind: 'chips', options: bandRows(PRICE_BANDS, 'priceBand'), numeric: 'price' },
      { field: 'sqftBand', label: 'Built-up area', kind: 'chips', options: bandRows(SQFT_BANDS, 'sqftBand'), numeric: 'sqft' },
      { field: 'zone', label: 'Zone', kind: 'chips', options: byCount(rows(tally(r => r.facet.zone))) },
      {
        field: 'area', label: 'Locality', kind: 'search',
        options: byCount([...areaCounts.entries()].map(([value, e]) => ({
          value,
          count: e.count,
          label: [...e.labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
        })))
      },
      { field: 'corridor', label: 'Corridor', kind: 'chips', options: byCount(rows(tally(r => r.facet.corridor))) },
      { field: 'builder', label: 'Builder', kind: 'search', options: byCount(rows(tally(r => r.facet.builder))) },
      { field: 'possession', label: 'Possession', kind: 'chips', options: rows(tally(r => r.facet.possession), v => POSSESSION_LABEL[v] || v).sort((a, b) => String(a.value).localeCompare(String(b.value))) },
      { field: 'facing', label: 'Facing', kind: 'chips', options: byLabel(rows(tally(r => r.facet.facing))) },
      { field: 'furnishing', label: 'Furnishing', kind: 'chips', options: byCount(rows(tally(r => r.facet.furnishing))) },
      { field: 'parkingKind', label: 'Car parking', kind: 'chips', options: byCount(rows(tally(r => r.facet.parkingKind), v => v + ' parking')) },
      { field: 'approvals', label: 'Approval', kind: 'chips', options: byCount(rows(tally(r => r.facet.approvals))) },
      { field: 'saleType', label: 'New / Resale', kind: 'chips', options: byCount(rows(tally(r => r.facet.saleType))) },
      { field: 'availability', label: 'Availability', kind: 'chips', options: byCount(rows(tally(r => r.facet.availability))) },
      { field: 'amenityTags', label: 'Amenities', kind: 'chips', multi: 'all', options: byCount(rows(tally(r => r.facet.amenityTags), v => (AMENITY_TAGS.find(t => t.key === v) || {}).label || v)) },
      { field: 'vastu', label: 'Vastu compliant', kind: 'toggle', options: [{ value: 'true', label: 'Vastu compliant', count: recs.filter(r => r.facet.vastu).length }] },
      { field: 'hasBrochure', label: 'Has brochure', kind: 'toggle', options: [{ value: 'true', label: 'Brochure on file', count: recs.filter(r => r.facet.hasBrochure).length }] },
      { field: 'hasPhotos', label: 'Has photos', kind: 'toggle', options: [{ value: 'true', label: 'Photos on file', count: recs.filter(r => r.facet.hasPhotos).length }] }
    ].filter(f => f.options.length > 0);
  }

  // Suggestions for the search box: what exists in the inventory that starts
  // with, or is close to, what has been typed so far.
  function suggest(list, text, gaz, limit) {
    const q = normText(text);
    if (!q || q.length < 3) return [];
    if (/\d/.test(q)) return [];
    if (MAG_WORDS[q] !== undefined || STOPWORDS.has(q)) return [];
    if (UNIT_HINTS.some(h => h.re.test(q)) || VALUE_MAP.some(v => v.re.test(q))) return [];
    const g = gaz || buildGazetteer(list);
    const pool = [];
    const add = (map, kind, icon) => map.forEach(e => pool.push({ kind, icon, text: e.raw, norm: e.text }));
    add(g.areas, 'Locality', '📍');
    add(g.builders, 'Builder', '🏗️');
    add(g.names, 'Property', '🏠');
    const scored = [];
    for (const e of pool) {
      let s = 0;
      if (e.norm === q) s = 100;
      else if (e.norm.startsWith(q)) s = 80 - e.norm.length * 0.1;
      else if (e.norm.split(' ').some(w => w.startsWith(q))) s = 60 - e.norm.length * 0.1;
      else if (q.length >= 5 && e.norm.split(' ').some(w => w.length >= 4 && withinDistance(q, w, 1) >= 0)) s = 40;
      if (s > 0) scored.push({ ...e, s });
    }
    scored.sort((a, b) => b.s - a.s);
    const seen = new Set();
    return scored.filter(x => (seen.has(x.norm) ? false : (seen.add(x.norm), true))).slice(0, limit || 8);
  }

  // ═══════ EXPORTS ═══════
  const api = {
    // main
    search, parseQuery, buildFacets, buildGazetteer, suggest, indexProperty,
    matchAdvanced, matchRule,
    // parsing pieces, exported for the tests
    normText, fold, tokenize, withinDistance, parseRanges, parseMoney, parseLandSqft,
    extractBhk, extractFloors, normType, possessionInfo, spansOf, readMagnitude, lexQuery,
    // vocabulary, shared with the panel
    TYPE_BUCKETS, TYPE_LABEL, PRICE_BANDS, SQFT_BANDS, AMENITY_TAGS, POSSESSION_LABEL,
    CR, LAKH, FIELD_ALIASES
  };
  root.PinSearch = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
