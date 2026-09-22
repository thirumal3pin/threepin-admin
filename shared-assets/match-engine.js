// ═══════════════════════════════════════════════════════════════════════════
// PIN MATCH — the buyer ⇄ property matching engine
// ═══════════════════════════════════════════════════════════════════════════
//
// One engine, three directions, one set of numbers:
//
//   property → buyers     dashboard.html      "who wants this?"
//   buyer    → properties crm.html            "what do we show them?"
//   listing  → buyers     propertytrack.html  "is this worth shooting?"
//
// They MUST be one engine. A board that says 93% and a lead page that says
// 71% for the same pair is worse than no score at all, because the team stops
// believing both. So everything below is a pure function of
// (requirement, property) → score + reasons, and each screen supplies only
// the two sides.
//
// ── WHY NOT JUST USE THE SEARCH ENGINE ─────────────────────────────────────
//
// search-engine.js answers "does this property contain what was typed". That
// is the wrong question here, for three reasons:
//
//   1. It is a FILTER: every clause must hold or the property disappears. A
//      buyer wanting 3BHK in Anna Nagar under ₹3 Cr would never see the
//      ₹3.5 Cr flat in the same block — the exact property an agent would
//      pick up the phone about. Matching has to RANK near-misses and say how
//      near they are, not drop them.
//   2. It has no geography. Anna Nagar and Aminjikarai share a border and not
//      one character; Anna Nagar and Anna Salai share nine characters and six
//      kilometres. Text similarity ranks both backwards — see chennai-geo.js.
//   3. It has no memory of the person. The most valuable fact about a buyer
//      is usually the last thing they rejected and why, and that fact lives
//      in a note, in prose, with no field of its own.
//
// ── HOW A SCORE IS BUILT ───────────────────────────────────────────────────
//
// Four layers, in the order they run:
//
//   1. VETOES      dealbreakers. A plot buyer is never shown a flat. A buyer
//                  who called ₹3.5 Cr too expensive is never shown ₹3.6 Cr.
//                  A veto removes the pair AND states why, so nobody is left
//                  wondering whether the engine simply missed it.
//   2. ATTRIBUTES  the weighted facts in ATTRIBUTES below, each scored on a
//                  tolerance curve rather than yes/no — 6% over budget is not
//                  the same answer as 60% over.
//   3. SEMANTIC    cosine similarity between two concept vectors, for
//                  everything that never fits a field: "quiet street", "near
//                  my daughter's school", "for rental yield".
//   4. OBJECTIONS  penalties mined from the buyer's own words, each carrying
//                  the quote it came from, decayed by age.
//
//   fit  = (earned − penalties) / available, over the attributes this buyer
//          actually GAVE us. A buyer who never mentioned facing is not marked
//          down for facing.
//
// That ratio alone would be misleading, so it never travels on its own:
//
//   confidence = how much of the CORE (budget, locality, BHK, type, size) we
//          actually know. "95% on two things" and "95% on eleven" are
//          different claims and the team must be able to tell them apart.
//   rank = fit × (0.6 + 0.4 × confidence), so a well-understood buyer
//          outranks a barely-known one at equal fit.
//
// ── CALIBRATION ────────────────────────────────────────────────────────────
//
// The curves are calibrated against the judgement a 3 PIN agent actually
// makes, not against equal-width buckets. The reference case is the owner's
// own: a buyer wanting 3BHK in Anna Nagar at ₹3 Cr, shown a 3BHK in Anna
// Nagar at ₹3.5 Cr, is a strong match worth a call — not a 45% one. So 17%
// over budget scores 0.78 of the budget weight, and that pair comes out in
// the low nineties. Every curve below has a comment saying what it is tuned
// to; change the comment when you change the number.
//
// ── WHAT THE SEMANTIC LAYER IS, AND IS NOT ─────────────────────────────────
//
// A sparse, concept-expanded TF-IDF space — not a neural sentence embedding.
// That is a deliberate trade:
//
//   · A transformer in the browser costs ~25 MB on first load, on a phone, on
//     mobile data, before the first property appears.
//   · It cannot be unit-tested to a stable number.
//   · It buys little on text this short and this jargon-heavy. "2BHK", "UDS",
//     "CMDA", "Cr", "Anna Nagar West Extension" are not in a general model's
//     vocabulary. They are in CONCEPTS below.
//
// embed() is the only place that turns text into a vector, so a hosted
// embedding (Gemini's text-embedding endpoint, cached on the property doc)
// can replace it later without the scorer changing — see EMBEDDING NOTE at
// embed(). Today's api/ directory is at Vercel's 12-function ceiling, which
// is the other reason this runs in the browser.
//
// Pure: no DOM, no network, no clock of its own (`now` is always passed in),
// so tests/match-engine.test.mjs drives the artifact the browser is served.
// A plain script (window.PinMatch) so the CRM's classic scripts and the Track
// board's ES module can both read it.

(function (root) {
  'use strict';

  // search-engine.js already parses every property field — prices in eleven
  // formats, areas as ranges, BHK out of "2, 3 & 4 BHK". Re-deriving any of
  // it here would guarantee the search bar and the matcher eventually
  // disagree about what a property costs.
  function S() {
    const e = root.PinSearch;
    if (!e) throw new Error('PinMatch needs PinSearch (dashboard-assets/search-engine.js) loaded first');
    return e;
  }
  function G() {
    const g = root.PinGeo;
    if (!g) throw new Error('PinMatch needs PinGeo (shared-assets/chennai-geo.js) loaded first');
    return g;
  }

  const CR = 10000000, LAKH = 100000, DAY = 86400000;

  // ═══════════════════════════════════════════════════════════════════════
  // CONCEPT ONTOLOGY
  // ═══════════════════════════════════════════════════════════════════════
  //
  // What the semantic layer actually knows. Each concept is a bundle of the
  // words Chennai buyers and brochures use for one underlying want, so a
  // buyer who wrote "school for my kids nearby" and a property whose
  // brochure says "walking distance to DAV & PSBB" land on the same axis
  // without sharing a word.
  //
  // These are wants, not features. `family` is not "has a play area" — it is
  // the whole cluster of school, park, creche, paediatrician that a family
  // buyer weighs together, which is why a single keyword match is worth less
  // here than a facet match in ATTRIBUTES.
  const CONCEPTS = {
    // "vidyalaya", "matriculation", "international school" and the rest are
    // here because that is literally how the inventory's landmark column
    // names a school — "St. Francis De Sales Matriculation School", "Velammal
    // Vidyalaya", "Jagannath Vidyalaya CBSE School". A family brief saying
    // "a good school for my kids" has to reach those, and a bare `school`
    // token alone does not.
    family: /\b(school|schools|vidyalaya|vidhyalaya|matric|matriculation|international\s*school|public\s*school|senior\s*secondary|cbse|icse|kids?|children|child|creche|day\s*care|play\s*area|playground|park|paediatric|pediatric|family|families|toddler)\b/g,
    it_corridor: /\b(it\s*park|tech\s*park|tidel|sipcot|infosys|tcs|cognizant|wipro|accenture|zoho|office|workplace|commute|work\s*place|it\s*corridor|campus)\b/g,
    transit: /\b(metro|metro\s*station|railway|train|mrts|bus\s*stand|bus\s*stop|airport|connectivity|connected|highway\s*access|expressway)\b/g,
    coastal: /\b(beach|sea|sea\s*view|sea\s*facing|ecr|east\s*coast|shore|waterfront|coastal)\b/g,
    waterbody: /\b(lake|lake\s*view|pond|eri|canal|water\s*body|backwater)\b/g,
    luxury: /\b(luxury|luxurious|ultra\s*luxury|premium|high\s*end|bespoke|penthouse|duplex|concierge|signature|exclusive|opulent|infinity\s*pool|sky\s*lounge)\b/g,
    value: /\b(affordable|budget\s*friendly|economical|reasonable|value\s*for\s*money|best\s*price|cost\s*effective|entry\s*level)\b/g,
    investment: /\b(investment|invest|rental\s*yield|yield|appreciation|appreciate|resale\s*value|roi|returns?|lease|rent\s*out|capital\s*gain)\b/g,
    devotional: /\b(temple|temples|pooja|puja|prayer\s*room|vastu|vaastu|vasthu|agraharam|mutt|church|mosque)\b/g,
    senior: /\b(senior\s*citizen|elderly|old\s*parents|aged\s*parents|my\s*parents|ground\s*floor|wheel\s*chair|wheelchair|hospital\s*nearby|physio)\b/g,
    privacy: /\b(independent|standalone|stand\s*alone|individual\s*house|own\s*compound|private\s*terrace|no\s*common\s*wall|privacy)\b/g,
    greenery: /\b(garden|gardens|landscap|green|greenery|trees?|open\s*space|avenue|park\s*facing|breeze)\b/g,
    quiet: /\b(quiet|calm|peaceful|serene|no\s*traffic|inner\s*street|residential\s*street|low\s*density|not\s*on\s*main\s*road)\b/g,
    main_road: /\b(main\s*road|arterial|highway\s*facing|road\s*facing|frontage|commercial\s*frontage|bus\s*route|shop\s*front)\b/g,
    security: /\b(gated|gated\s*community|security|cctv|guard|watchman|access\s*control|intercom)\b/g,
    fitness: /\b(gym|gymnasium|fitness|jogging|walking\s*track|swimming|pool|sports|badminton|tennis|basketball|cycling|yoga)\b/g,
    healthcare: /\b(hospital|hospitals|clinic|apollo|medical|pharmacy|nursing\s*home|multi\s*speciality)\b/g,
    shopping: /\b(mall|malls|super\s*market|supermarket|market|shopping|grocery|phoenix|express\s*avenue|forum)\b/g,
    education_higher: /\b(college|university|iit|anna\s*university|engineering\s*college|medical\s*college|institute)\b/g,
    ready_now: /\b(ready\s*to\s*move|immediate|immediately|shift\s*now|move\s*in|occupation\s*ready|rtm|urgent)\b/g,
    new_build: /\b(brand\s*new|new\s*launch|pre\s*launch|under\s*construction|fresh\s*booking|first\s*owner)\b/g,
    loan: /\b(loan|home\s*loan|bank\s*loan|emi|finance|sbi|hdfc|lic|mortgage|pre\s*approved|eligibility)\b/g,
    nri: /\b(nri|abroad|onsite|us|usa|singapore|dubai|uk|australia|remote\s*buyer|power\s*of\s*attorney)\b/g,
    joint_family: /\b(joint\s*family|large\s*family|two\s*families|in\s*laws|servant\s*room|maid\s*room|utility\s*room)\b/g,
    parking_need: /\b(car\s*park|parking|two\s*cars|2\s*cars|covered\s*parking|stilt|basement\s*parking)\b/g
  };

  // Words that carry no signal in this domain and would otherwise dominate
  // every vector, because "property", "chennai" and "bhk" appear in almost
  // every document on both sides.
  const STOP = new Set(('a an the and or of in at on for to is are was were be been with without from by as it its this that these those ' +
    'i we he she they you my our his her their your me us them ' +
    'property properties flat flats apartment apartments house home homes site sites ' +
    'chennai tamil nadu india client customer buyer lead enquiry enquiries ' +
    'want wants wanted need needs needed looking look prefer prefers preferred require required ' +
    'please pls kindly thanks thank ok okay yes no not very much more most some any all ' +
    'said says told asked asking call called calling spoke speaking sent send sending ' +
    'sqft sq ft feet bhk cr crore crores lakh lakhs rs inr ' +
    'also there here then than so but if when will would can could may might ' +
    'one two three four five six seven eight nine ten ' +
    'day days week weeks month months year years today tomorrow yesterday ' +
    'mr mrs ms sir madam').split(/\s+/));

  const fold = v => String(v == null ? '' : v)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‐-―−]/g, '-')
    .toLowerCase();

  const plain = v => fold(v).replace(/[^a-z0-9.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();

  function words(text) {
    return plain(text).split(' ')
      .map(w => w.replace(/^[.\-]+|[.\-]+$/g, ''))
      .filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  }

  // Which concepts a piece of text expresses, with how many distinct hits —
  // a brief that mentions school, park AND creche is more of a family brief
  // than one that mentions school once.
  function conceptsOf(text) {
    const s = fold(text).replace(/[^a-z0-9 ]+/g, ' ');
    const out = {};
    for (const [name, re] of Object.entries(CONCEPTS)) {
      re.lastIndex = 0;
      const hits = s.match(re);
      if (hits && hits.length) out[name] = hits.length;
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VECTORS
  // ═══════════════════════════════════════════════════════════════════════
  //
  // EMBEDDING NOTE — the only place text becomes a vector. Everything
  // downstream consumes a { term → weight } map and cosine(). To move to
  // hosted embeddings later: make embed() return the cached dense vector off
  // the document (property.embedding / lead.embedding, written by a backfill
  // through the existing api/knowledge-sync.js rather than a 13th function),
  // keep cosine() as-is, and nothing else in this file changes.
  //
  // Terms are unigrams plus concept axes. Concept axes are prefixed "~" so
  // they cannot collide with a real word, and carry a multiplier because they
  // are the part that generalises: "~family" firing on both sides means more
  // than the literal word "school" appearing on both.
  const CONCEPT_BOOST = 2.6;

  function embed(text) {
    const v = new Map();
    const ws = words(text);
    if (!ws.length && !Object.keys(conceptsOf(text)).length) return v;
    // Sub-linear term frequency: saying "school" nine times is not nine
    // times the want, and brochure prose repeats itself constantly.
    const tf = new Map();
    ws.forEach(w => tf.set(w, (tf.get(w) || 0) + 1));
    for (const [w, n] of tf) v.set(w, 1 + Math.log(n));
    for (const [c, n] of Object.entries(conceptsOf(text))) {
      v.set('~' + c, (1 + Math.log(n)) * CONCEPT_BOOST);
    }
    return v;
  }

  // IDF over the property corpus — computed once per property list and
  // cached against it, so a term like "apartment" (in every document) stops
  // counting while "amphitheatre" still does.
  const idfCache = new WeakMap();

  function idfFor(list) {
    if (!Array.isArray(list) || !list.length) return null;
    let idf = idfCache.get(list);
    if (idf) return idf;
    const df = new Map();
    for (const p of list) {
      const seen = new Set(embed(propertyText(p)).keys());
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }
    const n = list.length;
    idf = new Map();
    for (const [t, d] of df) idf.set(t, Math.log((n + 1) / (d + 0.5)));
    idfCache.set(list, idf);
    return idf;
  }

  // Cosine similarity, IDF-weighted when a corpus is available. Iterates the
  // smaller vector, because a brochure vector is often 40× a buyer's.
  function cosine(a, b, idf) {
    if (!a || !b || !a.size || !b.size) return 0;
    const w = t => (idf && idf.has(t) ? idf.get(t) : 1);
    let dot = 0, na = 0, nb = 0;
    for (const [t, x] of a) { const i = w(t); na += (x * i) ** 2; }
    for (const [t, y] of b) { const i = w(t); nb += (y * i) ** 2; }
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const [t, x] of small) {
      const y = large.get(t);
      if (y === undefined) continue;
      const i = w(t);
      dot += (x * i) * (y * i);
    }
    if (!na || !nb) return 0;
    return dot / Math.sqrt(na * nb);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // OBJECTIONS
  // ═══════════════════════════════════════════════════════════════════════
  //
  // The single most valuable thing in a lead record, and the only one with no
  // field of its own. A buyer who saw a ₹3.5 Cr flat and called it expensive
  // has told us something no requirement field can: the real ceiling.
  //
  // Each kind carries how it should be used, because they are not alike. A
  // price objection with a known anchor is a hard ceiling (veto); a vague
  // "maintenance seems high" is a nudge (penalty). `penalty` is in attribute
  // weight points — the same currency ATTRIBUTES is scored in.
  const OBJECTIONS = [
    {
      kind: 'price_high', label: 'Price', penalty: 14, anchors: 'price',
      // "budget is high" is in the list on purpose: in Indian English it is
      // how a buyer says the asking price exceeds their budget, and it is the
      // phrasing that comes back most often from site visits. It is also
      // genuinely ambiguous — "his budget is high" is the opposite claim —
      // so CAPACITY_CUE below vetoes that reading.
      re: /\b(?:too\s*(?:costly|expensive|pricey|high|much)|price\s*(?:is|was|seems|looks)?\s*(?:too\s*)?high|budget\s*(?:is|was)\s*(?:too\s*)?high|(?:over|above|beyond|outside|exceeds?|exceeding|crossing)\s*(?:the\s*|his\s*|her\s*|their\s*|my\s*|our\s*)?budget|out\s*of\s*budget|not\s*worth\s*(?:the\s*)?(?:price|cost|rate)|rate\s*(?:is|was)\s*(?:too\s*)?high|asking\s*(?:too\s*)?(?:high|much)|quoted?\s*(?:too\s*)?high|costly|expensive|price\s*reduction|reduce\s*the\s*(?:price|rate))\b/
    },
    {
      kind: 'location_rejected', label: 'Location', penalty: 12, anchors: 'locality',
      re: /\b(?:too\s*far|very\s*far|far\s*(?:from|away|off)|not\s*convenient|inconvenient|too\s*much\s*travel|long\s*commute|distance\s*is\s*(?:too\s*)?(?:much|far)|interior\s*location|no\s*connectivity|poor\s*connectivity|does\s*not\s*(?:like|want)\s*(?:the\s*)?(?:area|location|locality)|not\s*this\s*(?:area|locality))\b/
    },
    {
      kind: 'possession_late', label: 'Possession', penalty: 11,
      re: /\b(?:possession\s*(?:is\s*)?(?:too\s*)?(?:late|far|long)|cannot\s*wait|can'?t\s*wait|needs?\s*(?:it\s*)?immediately|wants?\s*ready\s*to\s*move|no\s*under\s*construction|not\s*under\s*construction|too\s*long\s*to\s*wait|only\s*ready\s*(?:to\s*move|possession))\b/
    },
    {
      kind: 'size_small', label: 'Size', penalty: 9, anchors: 'area',
      re: /\b(?:too\s*small|very\s*small|size\s*(?:is\s*)?(?:too\s*)?small|space\s*(?:is\s*)?(?:too\s*)?(?:small|less|tight)|carpet\s*area\s*(?:is\s*)?less|needs?\s*(?:a\s*)?bigger|wants?\s*(?:a\s*)?bigger|not\s*spacious|cramped)\b/
    },
    {
      kind: 'floor_high', label: 'Floor', penalty: 6,
      re: /\b(?:top\s*floor\s*(?:is\s*)?not|no\s*top\s*floor|too\s*high\s*(?:a\s*)?floor|wants?\s*(?:a\s*)?(?:lower|low|ground)\s*floor|lower\s*floor\s*only|ground\s*floor\s*only|lift\s*(?:is\s*)?(?:an\s*)?issue)\b/
    },
    {
      kind: 'no_parking', label: 'Parking', penalty: 6,
      re: /\b(?:no\s*(?:car\s*)?parking|parking\s*(?:is\s*)?(?:not\s*enough|insufficient|a\s*problem|an\s*issue)|needs?\s*two\s*(?:car\s*)?park|open\s*parking\s*(?:is\s*)?not)\b/
    },
    {
      kind: 'vastu_fail', label: 'Vastu', penalty: 8,
      re: /\b(?:vastu\s*(?:is\s*)?(?:not|no|issue|problem|mismatch|not\s*ok)|not\s*vastu|vaastu\s*(?:issue|problem)|facing\s*(?:is\s*)?(?:not|wrong)|south\s*facing\s*not)\b/
    },
    {
      kind: 'approval_missing', label: 'Approval', penalty: 10,
      re: /\b(?:no\s*(?:cmda|dtcp|rera)\s*approval|approval\s*(?:is\s*)?(?:missing|pending|not\s*there|an\s*issue)|unapproved|not\s*approved|panchayat\s*approval\s*only|patta\s*(?:issue|problem|not\s*clear)|(?:title|document)s?\s*(?:not\s*clear|issue|problem))\b/
    },
    {
      kind: 'loan_issue', label: 'Loan', penalty: 7,
      re: /\b(?:loan\s*(?:not|rejected|issue|problem|did\s*not|didn'?t)|bank\s*(?:rejected|did\s*not\s*approve)|not\s*loan\s*eligible|no\s*bank\s*funding|emi\s*(?:too\s*)?high)\b/
    },
    {
      kind: 'maintenance_high', label: 'Maintenance', penalty: 5,
      re: /\b(?:maintenance\s*(?:is\s*)?(?:too\s*)?high|high\s*maintenance|cam\s*charges?\s*high|monthly\s*charges?\s*(?:too\s*)?high)\b/
    },
    {
      kind: 'old_property', label: 'Age', penalty: 6,
      re: /\b(?:too\s*old|very\s*old|old\s*(?:building|construction|property)|needs?\s*(?:a\s*lot\s*of\s*)?renovation|wants?\s*(?:only\s*)?new)\b/
    },
    {
      kind: 'main_road_noise', label: 'Noise', penalty: 5,
      re: /\b(?:too\s*(?:much\s*)?noise|noisy|traffic\s*(?:is\s*)?(?:too\s*much|a\s*problem|an\s*issue)|on\s*(?:the\s*)?main\s*road\s*(?:is\s*)?not|dust\s*(?:and|&)?\s*noise)\b/
    }
  ];

  // "his budget is high", "budget increased to 4cr" — capacity, not a
  // complaint. Any of these in the same sentence flips the reading, which is
  // the difference between filing a buyer correctly and blacklisting the
  // whole inventory for them.
  const CAPACITY_CUE = /\b(?:can\s*(?:go|stretch|extend|afford)|upto|up\s*to|increased?|raised?|revised?\s*up|higher\s*budget|good\s*budget|healthy\s*budget|budget\s*ok|no\s*budget\s*(?:issue|constraint)|flexible)\b/;

  // A later statement that puts an objection to bed. Checked only against
  // text NEWER than the objection, so an old "too costly" stops applying
  // once the buyer says they can stretch.
  const CLEARED_CUE = /\b(?:budget\s*(?:increased?|revised?|extended?)|can\s*(?:now\s*)?(?:go|stretch|afford)\s*(?:up\s*)?to|ok\s*with\s*(?:the\s*)?price|agreed\s*(?:to\s*|on\s*)?(?:the\s*)?price|price\s*(?:is\s*)?fine|fine\s*with\s*(?:the\s*)?(?:price|rate)|ready\s*to\s*pay|accepted\s*(?:the\s*)?(?:price|quote))\b/;

  // Negations that make a match a non-objection: "price is not high",
  // "no issue with the location".
  const NEGATED = /\b(?:not|no|never|without|isn'?t|wasn'?t|don'?t|doesn'?t|didn'?t)\s+(?:\w+\s+){0,3}$/;

  // And the same thing said the other way round. Indian English and Tamil put
  // the negation AFTER the complaint — "price high illa", "problem illa",
  // "issue edhuvum illa", "not a problem at all" — so a backward-only check
  // read every one of those as a live objection. That is the worst possible
  // direction to be wrong in: it blacklists inventory on the exact sentences
  // that say there is nothing wrong.
  const NEGATED_AFTER = /^\s*(?:\w+\s+){0,4}(?:illa|illai|kidaiyathu|no issue|not an issue|no problem|not a problem|is fine|was fine|ok\b|okay\b)/;

  const SENTENCE_SPLIT = /(?<=[.!?;\n])\s+|\s*[•·]\s*/;

  // How much an objection still counts, by age. A price objection from last
  // week is a ceiling; one from eighteen months ago is a note. Nothing older
  // than ~6 months can veto (VETO_MIN_WEIGHT), because the market and the
  // buyer's salary both moved.
  function recency(at, now) {
    if (!at) return 0.55;              // undated (a bare profile line) — mid weight
    const age = Math.max(0, now - at);
    if (age < 30 * DAY) return 1;
    if (age < 90 * DAY) return 0.75;
    if (age < 180 * DAY) return 0.5;
    if (age < 365 * DAY) return 0.3;
    return 0.15;
  }
  const VETO_MIN_WEIGHT = 0.5;

  // ═══════════════════════════════════════════════════════════════════════
  // THE TEXTS OF A LEAD
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Everything a lead has ever told us, each fragment tagged with when it was
  // said, where it came from and how much authority it has. Order and
  // authority both matter: `lead.budget` is a curated field (a person or
  // TailorTalk maintains it) and outranks a number mentioned in passing in a
  // note, while a note from yesterday outranks a profile line from March.
  //
  // Reads only the lead DOCUMENT and its denormalised lastNote — never a
  // subcollection. Matching runs over every lead on a board at once, so one
  // Firestore read per lead would be hundreds of reads per screen. `notes`
  // are used when the caller already has them (the open lead panel does).
  function leadTexts(lead) {
    const out = [];
    const add = (text, at, src, authority) => {
      const t = String(text == null ? '' : text).trim();
      if (t) out.push({ text: t, at: at || 0, src, authority: authority == null ? 1 : authority });
    };
    const base = lead.updatedAt || lead.createdAt || 0;

    // ── curated fields ──
    add(lead.propertyInterest, base, 'Property / Locality', 3);
    add(lead.budget, base, 'Budget', 3);
    add(lead.enquiryType, base, 'Enquiry type', 2);

    // ── TailorTalk's AI profile: the richest requirement text we hold ──
    const tt = lead.tt || {};
    const prof = tt.profile || {};
    const ttAt = tt.lastMessageAt || tt.syncedAt || base;
    add(prof.requirement_details, ttAt, 'Requirement (AI profile)', 3);
    add(prof.budget_and_finance, ttAt, 'Budget & finance (AI profile)', 3);
    add(prof.preferred_location, ttAt, 'Preferred location (AI profile)', 3);
    add(prof.objections_and_blockers, ttAt, 'Objections (AI profile)', 3);
    add(prof.properties_discussed, ttAt, 'Properties discussed', 2);
    add(prof.intent_and_who, ttAt, 'Intent (AI profile)', 2);
    add(prof.activity_so_far, ttAt, 'Activity (AI profile)', 1);
    add(prof.remarks, ttAt, 'Remarks (AI profile)', 1);
    add(prof.chat_summary, ttAt, 'Chat summary', 1);
    if (tt.values) {
      add(tt.values.propertyInterest, ttAt, 'TailorTalk locality', 2);
      add(tt.values.budget, ttAt, 'TailorTalk budget', 2);
    }
    add(tt.adTitle, ttAt, 'Ad they replied to', 1);

    // ── the team's own words ──
    if (lead.lastNote) add(lead.lastNote.text, lead.lastNote.createdAt, 'Latest note', 2);
    (lead.notes || []).forEach(n => add(n && n.text, n && n.createdAt, 'Note', 2));

    // ── what the automation concluded ──
    const ai = lead.ai || {};
    add(ai.evidence, ai.at, 'AI evidence', 2);
    add(ai.line, ai.at, 'AI status line', 1);
    add(lead.aiSummary, lead.aiSummaryAt, 'AI summary', 2);

    // ── Meta lead-ad answers, which are literally the buyer's own typing ──
    const raw = lead.rawFieldData || {};
    Object.entries(raw).forEach(([k, v]) => {
      if (/^(full_name|phone_number|email|name)$/.test(k)) return;
      add(v, lead.createdAt, 'Ad form: ' + k.replace(/_/g, ' '), 2);
    });

    // Newest and most authoritative first — every extractor below takes the
    // first usable answer, so this ordering IS the precedence rule.
    out.sort((a, b) => (b.authority - a.authority) || (b.at - a.at));
    return out;
  }

  // Everything joined, for the vector and for objection scanning. Free text
  // only: the curated one-word fields add nothing to a concept vector.
  const joinTexts = ts => ts.map(t => t.text).join(' \n ');

  // ═══════════════════════════════════════════════════════════════════════
  // REQUIREMENT EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════

  // Money out of one string, as rupee spans, using the search engine's parser
  // so "1.49 to 2.11 Cr", "₹60L - 1.6Cr" and "75 lakhs" all read the same way
  // here as they do in the search box.
  function moneySpans(text) {
    const m = S().parseMoney(text, 'price');
    return (m.price || []).filter(r => isFinite(r[0]) && r[0] > 0);
  }

  // A buyer's budget. Buyers state a CEILING ("budget 3 cr", "up to 1.5")
  // far more often than a range, so a single number becomes the max and the
  // floor is inferred only to catch a segment mismatch (a ₹60 L flat shown
  // to a ₹3 Cr buyer is not a good match even though it "fits").
  function readBudget(texts) {
    for (const t of texts) {
      const spans = moneySpans(t.text);
      if (!spans.length) continue;
      // Ignore anything that cannot be a Chennai home price — a phone number
      // or a pincode that happens to parse as money.
      const usable = spans.filter(r => r[1] >= 5 * LAKH && r[0] <= 500 * CR);
      if (!usable.length) continue;
      const lo = Math.min.apply(null, usable.map(r => r[0]));
      const hi = Math.max.apply(null, usable.map(r => r[1]));
      const ranged = hi > lo * 1.02;
      const flexible = /\b(?:around|approx|about|roughly|近|upto|up\s*to|can\s*(?:go|stretch|extend)|flexible|negotiable|or\s*so|ish)\b/.test(fold(t.text));
      return {
        min: ranged ? lo : Math.round(lo * 0.7),
        max: hi,
        firm: !ranged,
        flexible,
        stated: t.text.length <= 60 ? t.text : fmtMoney(lo) + (ranged ? ' – ' + fmtMoney(hi) : ''),
        src: t.src
      };
    }
    return null;
  }

  // BHK. Read only from the texts a requirement is actually stated in — a
  // note saying "showed him the 2BHK, he wants 3" would otherwise make both
  // counts look wanted. The search engine's extractor handles "2, 3 & 4 BHK"
  // and refuses to read "4 Apartments (3BHK each)" as four configs.
  function readBhk(texts) {
    const REQ = /Property \/ Locality|Requirement|Preferred location|TailorTalk locality|Ad form|Intent/;
    const pick = list => {
      for (const t of list) {
        const b = S().extractBhk(t.text);
        if (b.length) return { values: b, src: t.src };
      }
      return null;
    };
    return pick(texts.filter(t => REQ.test(t.src))) || pick(texts);
  }

  // Property type. A BHK count with no type named means "a home" — which is
  // the common case and must NOT be read as "an apartment": the buyer has
  // told us it is residential and nothing more. `residential` carries that
  // distinction so the scorer can credit a villa and still veto a plot.
  const TYPE_WORDS = [
    // "layout" is NOT here on its own. In Chennai a layout is indeed a plot
    // development — and "liked the layout" is also how every buyer describes
    // a floor plan. Read loosely it turned a 3BHK buyer's site-visit note
    // into a request for land. Only the unambiguous phrasings count.
    { type: 'Plot', re: /\b(?:plot|plots|vacant\s*land|open\s*land|dtcp\s*(?:plot|layout)|approved\s*layout|(?:plot|land)\s*layout|land\s*(?:for\s*sale|parcel))\b/ },
    { type: 'Villa', re: /\b(?:villa|villas|town\s*house|townhouse|row\s*house|duplex\s*villa)\b/ },
    { type: 'House', re: /\b(?:independent\s*house|individual\s*house|separate\s*house|own\s*house)\b/ },
    { type: 'Commercial', re: /\b(?:commercial|office\s*space|shop|showroom|retail|warehouse|godown|it\s*office)\b/ },
    { type: 'Apartment', re: /\b(?:apartment|apartments|flat|flats|condo)\b/ }
  ];

  // Same discipline as readBhk and readLocalities: what a buyer WANTS is read
  // from the texts a requirement is stated in, and only from a note if none
  // of those say anything. A note is a record of what happened ("showed him
  // the plot in Mambakkam, he wants a flat") and mining a want out of it
  // reliably gets the want backwards.
  const REQ_SRC = /Property \/ Locality|Requirement|Preferred location|TailorTalk locality|Ad form|Intent|Enquiry type/;

  function readTypes(texts, bhk) {
    const scan = list => {
      const found = [];
      let src = null;
      for (const t of list) {
        const s = fold(t.text);
        for (const w of TYPE_WORDS) {
          if (w.re.test(s) && !found.includes(w.type)) { found.push(w.type); src = src || t.src; }
        }
        if (found.length) break;
      }
      return found.length ? { values: found, residentialOnly: false, src } : null;
    };
    const found = scan(texts.filter(t => REQ_SRC.test(t.src))) || scan(texts);
    if (found) return found;
    // No type word anywhere, but a BHK was asked for: residential, unspecified.
    if (bhk && bhk.values.length) return { values: ['Apartment', 'Villa', 'House'], residentialOnly: true, src: bhk.src };
    return null;
  }

  // Localities, via the gazetteer in chennai-geo.js. Read from the stated
  // requirement first; `firm` records whether the buyer named the area
  // themselves, because that is what licenses a distance veto.
  function readLocalities(texts) {
    const geo = G();
    const REQ = /Property \/ Locality|Preferred location|Requirement|TailorTalk locality|Ad form/;
    const scan = list => {
      const keys = [];
      let src = null;
      for (const t of list) {
        for (const k of geo.resolveAll(t.text)) if (!keys.includes(k)) { keys.push(k); src = src || t.src; }
        if (keys.length) break;
      }
      return keys.length ? { keys, src } : null;
    };
    // A named corridor ("anywhere on OMR", "ECR side") is a different kind of
    // answer from a locality and has to survive as one — the alias table
    // resolves it to a single representative point, which is right for
    // placing a property and wrong for reading a brief.
    const CORRIDOR_SAID = [
      ['OMR', /\b(?:omr|old\s*mahabalipuram\s*road|rajiv\s*gandhi\s*salai|it\s*(?:corridor|highway))\b/],
      ['ECR', /\b(?:ecr|east\s*coast\s*road)\b/],
      ['GST', /\b(?:gst\s*road|gst\b|grand\s*southern\s*trunk|nh\s*?45)\b/],
      ['Radial Road', /\bradial\s*road\b/],
      ['Mount-Poonamallee', /\bmount\s*-?\s*poonamallee\b/],
      ['Velachery-Tambaram', /\bvelachery\s*-?\s*tambaram\b/]
    ];
    const allText = fold(joinTexts(texts));
    const corridors = CORRIDOR_SAID.filter(([, re]) => re.test(allText)).map(([k]) => k);

    const firm = scan(texts.filter(t => REQ.test(t.src)));
    if (firm) return { keys: firm.keys, firm: true, src: firm.src, corridors };
    const loose = scan(texts);
    if (loose) return { keys: loose.keys, firm: false, src: loose.src, corridors };
    // A brief that names ONLY a corridor still states a location.
    if (corridors.length) {
      const geo = G();
      const keys = corridors.flatMap(c => (geo.CORRIDOR_MEMBERS[c] || []).slice(0, 1));
      return { keys, firm: false, src: 'corridor', corridors };
    }
    return null;
  }

  // Built-up area, when a buyer states one. Guarded to plausible home sizes
  // so a price or a pincode cannot arrive here as a size.
  function readSize(texts) {
    // Land in Chennai is quoted in grounds and cents, not square feet — "3
    // grounds", "6 cents", "2 acres" — and the sqft guard below silently
    // dropped every one of them, which is most plot and independent-house
    // briefs in the city. PinSearch already knows the conversions
    // (1 ground = 2,400 sqft, 1 cent = 435.6).
    for (const t of texts) {
      if (/\b(?:ground|grounds|cent|cents|acre|acres)\b/i.test(t.text)) {
        const land = S().parseLandSqft(t.text).filter(n => n >= 400 && n <= 500000);
        if (land.length) {
          const lo = Math.min.apply(null, land), hi = Math.max.apply(null, land);
          return { min: lo, max: hi > lo ? hi : Math.round(lo * 1.25), src: t.src, unit: 'land' };
        }
      }
    }
    for (const t of texts) {
      if (!/\b(?:sq\.?\s*ft|sqft|sft|square\s*feet|built\s*up|builtup|carpet|area)\b/i.test(t.text)) continue;
      const p = S().parseRanges(t.text);
      const spans = S().spansOf(p).filter(r => r[0] >= 200 && r[1] <= 20000);
      if (!spans.length) continue;
      const lo = Math.min.apply(null, spans.map(r => r[0]));
      const hi = Math.max.apply(null, spans.map(r => r[1]));
      return { min: lo, max: hi > lo ? hi : Math.round(lo * 1.25), src: t.src };
    }
    return null;
  }

  // Possession urgency. 'ready' and 'under_construction' are both real
  // preferences — an investor often wants the latter for the payment plan.
  function readPossession(texts) {
    for (const t of texts) {
      const s = fold(t.text);
      if (/\b(?:ready\s*to\s*move|rtm|immediate|immediately|shift\s*(?:now|soon)|move\s*in\s*(?:now|soon)|occupation\s*ready|need\s*it\s*now|urgent)\b/.test(s)) {
        return { want: 'ready', src: t.src };
      }
      if (/\b(?:under\s*construction|new\s*launch|pre\s*launch|prelaunch|booking\s*stage|payment\s*plan|construction\s*linked)\b/.test(s)) {
        return { want: 'upcoming', src: t.src };
      }
      const y = s.match(/\b(?:possession|handover|ready)\b[^.]{0,24}\b(20\d\d)\b/);
      if (y) return { want: 'by', year: Number(y[1]), src: t.src };
    }
    return null;
  }

  // Road width, in feet. The owner's own example of an attribute that should
  // carry a small score: in Chennai a 30 ft approach road versus a 20 ft one
  // is a real difference in price and in resale, and buyers of plots and
  // independent houses ask about it by name. Small weight because most
  // buyers never raise it — and an attribute nobody raised is not scored.
  const ROAD_RE = /(\d{1,3}(?:\.\d+)?)\s*(?:ft|feet|foot|')\s*(?:wide\s*)?(?:approach\s*|main\s*|inner\s*)?road|road\s*(?:width|size)\s*(?:of\s*)?(\d{1,3})\s*(?:ft|feet|foot)?/i;

  function readRoadWidth(text) {
    const m = ROAD_RE.exec(String(text || ''));
    if (!m) return null;
    const n = Number(m[1] || m[2]);
    return isFinite(n) && n >= 8 && n <= 300 ? n : null;
  }

  function readFloorPref(texts) {
    for (const t of texts) {
      const s = fold(t.text);
      if (/\b(?:ground\s*floor|stilt\s*floor|first\s*floor\s*only|lower\s*floor|low\s*floor|no\s*lift)\b/.test(s)) return { want: 'low', src: t.src };
      if (/\b(?:higher\s*floor|high\s*floor|top\s*floor|upper\s*floor|above\s*\d+(?:th|rd|nd|st)?\s*floor|good\s*view)\b/.test(s)) return { want: 'high', src: t.src };
    }
    return null;
  }

  // Facets the buyer asked for by name, read with the search engine's own
  // vocabulary so a chip in Advanced Search and a sentence in a note mean
  // the same thing.
  function readFacets(texts) {
    const all = fold(joinTexts(texts));
    const out = {};
    if (/\b(?:vastu|vaastu|vasthu|vaasthu)\b/.test(all) && !/\bvastu\s*(?:not|no)\b/.test(all)) out.vastu = true;
    const facing = ['East', 'West', 'North', 'South'].filter(f => new RegExp('\\b' + f.toLowerCase() + '\\s*facing\\b').test(all));
    if (facing.length) out.facing = facing;
    const appr = ['RERA', 'CMDA', 'DTCP'].filter(a => new RegExp('\\b' + a.toLowerCase() + '\\b').test(all));
    if (appr.length) out.approvals = appr;
    if (/\bgated\b/.test(all)) out.gated = true;
    if (/\b(?:covered\s*parking|stilt\s*parking|basement\s*parking|two\s*car|2\s*car)\b/.test(all)) out.coveredParking = true;
    if (/\b(?:corner\s*(?:unit|plot|house))\b/.test(all)) out.corner = true;
    if (/\b(?:resale|re-sale|second\s*(?:hand|owner))\b/.test(all)) out.saleType = 'Resale';
    else if (/\b(?:brand\s*new|new\s*property|first\s*owner|fresh\s*booking)\b/.test(all)) out.saleType = 'New';
    if (/\b(?:semi\s*furnished)\b/.test(all)) out.furnishing = 'Semi-Furnished';
    else if (/\b(?:fully\s*furnished|furnished)\b/.test(all)) out.furnishing = 'Fully Furnished';
    const road = readRoadWidth(all);
    if (road) out.roadWidthMin = road;
    // Amenities, using the search engine's tag list so the two agree.
    const tags = S().AMENITY_TAGS.filter(t => t.test.test(all)).map(t => t.key);
    if (tags.length) out.amenityTags = tags;
    return out;
  }

  // ── Objections ──
  //
  // Scanned sentence by sentence so a quote can be shown, and anchored to a
  // number wherever the buyer gave one. The anchor is what turns "too
  // expensive" from a vague penalty into a usable ceiling.
  function readObjections(texts, seen, now) {
    const found = [];
    for (const t of texts) {
      for (const raw of String(t.text).split(SENTENCE_SPLIT)) {
        const sentence = raw.trim();
        if (!sentence || sentence.length < 4) continue;
        const s = fold(sentence);
        for (const def of OBJECTIONS) {
          const m = def.re.exec(s);
          if (!m) continue;
          // "price is not high" — the negation belongs to this match.
          const before = s.slice(Math.max(0, m.index - 32), m.index);
          if (NEGATED.test(before)) continue;
          const after = s.slice(m.index + m[0].length);
          if (NEGATED_AFTER.test(after)) continue;
          if (def.kind === 'price_high' && CAPACITY_CUE.test(s)) continue;
          const weight = recency(t.at, now);
          const o = {
            kind: def.kind, label: def.label, penalty: def.penalty,
            authority: t.authority == null ? 1 : t.authority,
            quote: sentence.length > 160 ? sentence.slice(0, 157) + '…' : sentence,
            at: t.at, src: t.src, weight, anchor: null, anchorFrom: null
          };
          // An amount in the sentence itself is the best anchor there is:
          // "3.5 cr is too high" gives the ceiling directly.
          if (def.anchors === 'price') {
            const here = moneySpans(sentence).filter(r => r[1] >= 5 * LAKH);
            if (here.length) { o.anchor = Math.min.apply(null, here.map(r => r[0])); o.anchorFrom = 'their own words'; }
          }
          if (def.anchors === 'area') {
            const p = S().parseRanges(sentence);
            const sp = S().spansOf(p).filter(r => r[0] >= 200 && r[1] <= 20000);
            if (sp.length) { o.anchor = Math.max.apply(null, sp.map(r => r[1])); o.anchorFrom = 'their own words'; }
          }
          if (def.anchors === 'locality') {
            const keys = G().resolveAll(sentence);
            if (keys.length) { o.anchor = keys; o.anchorFrom = 'their own words'; }
          }
          found.push(o);
          break;      // one objection per sentence — the strongest reading
        }
      }
    }

    // A property they were actually shown anchors a price or size objection
    // that carried no number of its own. This is the owner's second case:
    // the buyer visited a site at this budget and said it was expensive, so
    // that site's price is the ceiling even though no number was ever typed.
    const priced = seen.filter(x => x.priceLo != null).sort((a, b) => b.priceLo - a.priceLo);
    for (const o of found) {
      if (o.anchor != null) continue;
      if (o.kind === 'price_high' && priced.length) {
        o.anchor = priced[0].priceLo;
        o.anchorFrom = priced[0].label;
      }
      if (o.kind === 'size_small') {
        const sized = seen.filter(x => x.areaLo != null).sort((a, b) => b.areaLo - a.areaLo);
        if (sized.length) { o.anchor = sized[0].areaLo; o.anchorFrom = sized[0].label; }
      }
    }

    // Cleared by something said afterwards.
    //
    // `>` alone was not enough. Every fragment of TailorTalk's AI profile
    // carries the SAME timestamp (the conversation's last-message time), so a
    // profile reading "was worried about price, now confirmed budget 1.2 Cr"
    // could never clear its own objection: the clearing sentence was never
    // LATER than the objection, only equal. The result was a stale price veto
    // quietly hiding good inventory — the exact failure this file's header
    // warns about. Equal timestamps now fall back to authority, and a
    // clearing cue in the same text as the objection clears it.
    const clearing = texts.filter(t => CLEARED_CUE.test(fold(t.text)));
    for (const o of found) {
      const after = clearing.find(c => {
        if (!c.at || !o.at) return false;
        if (c.at > o.at) return true;
        if (c.at !== o.at) return false;
        return c.authority >= o.authority || c.src === o.src;
      });
      if (after) { o.cleared = true; o.clearedBy = after.src; o.weight = 0; }
    }

    // One per kind — the strongest surviving reading, newest first.
    const byKind = new Map();
    for (const o of found.sort((a, b) => (b.weight - a.weight) || (b.at - a.at))) {
      if (!byKind.has(o.kind)) byKind.set(o.kind, o);
    }
    return [...byKind.values()].filter(o => !o.cleared && o.weight > 0);
  }

  // The properties this lead has already been shown, resolved against the
  // inventory. Doubles as the anchor source above and as a taste signal.
  function seenProperties(lead, inventory) {
    if (!inventory || !inventory.length) return [];
    const codes = (lead.propertyCodes || []).map(String);
    if (!codes.length) return [];
    const byId = new Map();
    inventory.forEach(p => {
      byId.set(String(p.id), p);
      if (p.propertyCode) byId.set(String(p.propertyCode).toUpperCase(), p);
    });
    const out = [];
    for (const c of codes) {
      const p = byId.get(c) || byId.get(c.toUpperCase());
      if (!p) continue;
      const prof = propertyProfile(p);
      out.push({
        p, label: p.propertyCode || p.name || p.id,
        priceLo: prof.priceLo, areaLo: prof.areaLo, type: prof.type, localities: prof.localities
      });
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PROFILES
  // ═══════════════════════════════════════════════════════════════════════

  // Everything a requirement is, from a lead. `opts.inventory` enables the
  // anchor and taste signals; `opts.notes` lets the open lead panel pass the
  // notes it has already loaded.
  function requirementProfile(lead, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const l = o.notes ? Object.assign({}, lead, { notes: o.notes }) : lead;
    const texts = leadTexts(l);
    const seen = seenProperties(l, o.inventory);

    const bhk = readBhk(texts);
    const types = readTypes(texts, bhk);
    const budget = readBudget(texts);
    const localities = readLocalities(texts);
    const size = readSize(texts);
    const possession = readPossession(texts);
    const floor = readFloorPref(texts);
    const facets = readFacets(texts);
    const objections = readObjections(texts, seen, now);

    // The concept vector is built from free prose only — the curated
    // one-word fields ("Buyer", "3 Cr") add noise, not meaning. What they
    // were shown counts too, at a discount: it is revealed taste rather than
    // a stated want.
    const prose = texts.filter(t => t.text.length >= 18).map(t => t.text).join(' \n ');
    const tasteText = seen.map(x => propertyText(x.p)).join(' \n ');
    const vec = embed(prose);
    if (tasteText) {
      for (const [t, w] of embed(tasteText)) vec.set(t, (vec.get(t) || 0) + w * 0.35);
    }

    return {
      kind: 'buyer',
      id: lead.id,
      name: lead.name || '(no name)',
      intent: (lead.ai && lead.ai.intent) || null,
      stageId: lead.stageId || null,
      budget, bhk, types, localities, size, possession, floor,
      facets, objections, seen,
      vector: vec,
      text: prose,
      texts,
      lead
    };
  }

  // The same shape, from a sentence somebody typed into a box — the "match a
  // client brief" path on the dashboard. One function so a pasted brief and a
  // stored lead are scored by identical code.
  function briefProfile(text, opts) {
    const o = opts || {};
    const fake = {
      id: '__brief__',
      name: o.name || 'Typed brief',
      propertyInterest: text,
      updatedAt: o.now || Date.now(),
      createdAt: o.now || Date.now()
    };
    const prof = requirementProfile(fake, o);
    prof.kind = 'brief';
    return prof;
  }

  // ── The property side ──

  // Every word of a property that could carry meaning. Excludes links and
  // bookkeeping for the same reason search-engine.js does: "drive" would
  // otherwise be the most common term in the corpus.
  function propertyText(p) {
    return [
      p.name, p.location, p.zone, p.builder, p.config, p.type, p.propertyType,
      p.highlights, p.amenities, p.nearby, p.nearbyLandmark, p.connectivity,
      p.detailsText, p.sheetNotes, p.notes, p.approval, p.furnishing, p.facing,
      p.parkingType, p.powerBackup, p.maintenance, p.possession, p.constructionStage
    ].filter(Boolean).join(' \n ');
  }

  const propCache = new WeakMap();

  // A property, reduced to the facts a requirement is scored against. Thin on
  // purpose — every parse comes from search-engine.js's index, so there is one
  // definition of what a property costs and how big it is.
  function propertyProfile(p) {
    let prof = propCache.get(p);
    if (prof) return prof;
    const rec = S().indexProperty(p);
    const geo = G();

    const priceSpans = rec.num.price || [];
    const areaSpans = (rec.num.area && rec.num.area.length) ? rec.num.area : (rec.num.sqft || []);
    const psfSpans = rec.num.psf || [];

    const localities = geo.resolveAll(p.location || '');
    // A project name often carries the locality when the Location column does
    // not ("… Anna Nagar …"), and the zone is the last resort.
    if (!localities.length) {
      const fromName = geo.resolveAll([p.name, p.nearbyLandmark, p.connectivity].filter(Boolean).join(' , '));
      fromName.forEach(k => { if (!localities.includes(k)) localities.push(k); });
    }

    prof = {
      kind: 'property',
      p, id: p.id,
      code: p.propertyCode || null,
      name: p.name || p.id,
      locationText: p.location || '',
      localities,
      zone: p.zone || geo.zoneOf(p.location || '') || null,
      corridors: (rec.facet.corridor || []).slice(),
      type: rec.facet.type,
      bhk: (rec.num.bhk || []).slice(),
      priceLo: priceSpans.length ? Math.min.apply(null, priceSpans.map(r => r[0])) : null,
      priceHi: priceSpans.length ? Math.max.apply(null, priceSpans.map(r => r[1])) : null,
      areaLo: areaSpans.length ? Math.min.apply(null, areaSpans.map(r => r[0])) : null,
      areaHi: areaSpans.length ? Math.max.apply(null, areaSpans.map(r => r[1])) : null,
      psfLo: psfSpans.length ? Math.min.apply(null, psfSpans.map(r => r[0])) : null,
      ready: rec.facet.status === 'ready',
      possessionBucket: rec.facet.possession,
      possessionYear: rec.possessionYear || null,
      facing: (rec.facet.facing || []).slice(),
      vastu: !!rec.facet.vastu,
      approvals: (rec.facet.approvals || []).slice(),
      amenityTags: (rec.facet.amenityTags || []).slice(),
      parkingKind: (rec.facet.parkingKind || []).slice(),
      furnishing: rec.facet.furnishing || '',
      saleType: rec.facet.saleType || '',
      soldOut: !!rec.facet.soldOut,
      floorNo: S().parseRanges(p.floorNo).first,
      roadWidth: readRoadWidth(propertyText(p)),
      corner: /\byes\b|\btrue\b/i.test(String(p.cornerUnit || '')),
      builder: p.builder || '',
      gated: (rec.facet.amenityTags || []).includes('gated'),
      metro: /\bmetro\b/i.test([p.connectivity, p.nearbyLandmark, p.highlights, p.detailsText].filter(Boolean).join(' ')),
      loanEligible: /\byes\b|eligible|approved/i.test(String(p.loanEligible || '')),
      ageYears: readAge(p),
      vector: embed(propertyText(p)),
      rec
    };
    propCache.set(p, prof);
    return prof;
  }

  function readAge(p) {
    const s = fold([p.propertyAge, p.ageOfProperty].filter(Boolean).join(' '));
    if (!s) return null;
    if (/\bnew\b/.test(s)) return 0;
    const m = s.match(/(\d+(?:\.\d+)?)\s*(?:year|yr)/);
    return m ? Number(m[1]) : null;
  }

  // A Property & Media Track listing, scored before it is in the inventory at
  // all. That is the whole point of the Track board's panel: the team wants
  // to know how many buyers are waiting BEFORE paying for a shoot. The
  // listing's own fields are thin, so the linked seller lead's conversation
  // is folded in — an owner describing their flat to TailorTalk is describing
  // the property, and it is often the only description that exists.
  function listingProfile(listing, opts) {
    const o = opts || {};
    const lead = o.lead || null;
    const ttText = lead ? leadTexts(lead).filter(t => t.text.length >= 18).map(t => t.text).join(' \n ') : '';
    // Shaped as an inventory property so ONE profiler serves both, rather
    // than a second scorer that would drift from this one.
    const asProperty = {
      id: listing.id,
      propertyCode: listing.propertyCode || null,
      name: listing.title || listing.propertyCode || 'Untitled listing',
      location: listing.location || listing.address || '',
      config: listing.config || '',
      startingPrice: listing.askingPrice || '',
      type: listing.propertyType || guessType(listing, ttText),
      status: listing.readyToMove ? 'Ready to Move' : '',
      highlights: listing.remarks || '',
      detailsText: ttText,
      sheetNotes: [listing.accessNotes, listing.shootNotes].filter(Boolean).join(' \n ')
    };
    const prof = propertyProfile(asProperty);
    prof.kind = 'listing';
    prof.listing = listing;
    prof.provisional = !listing.propertyCode;
    return prof;
  }

  // ── The seller's own property ──
  //
  // A seller is never matched to properties: they are not buying one. But the
  // question worth asking of a seller is the reverse, and it is the most
  // commercially useful screen in the product — "how many buyers are already
  // waiting for what this owner is selling?" Walking into a listing pitch
  // able to say "six people are looking for exactly this" is worth more than
  // any brochure.
  //
  // The catch is that a seller's record means the OPPOSITE of a buyer's, field
  // for field. `propertyInterest` is not what they want, it is what they
  // have. `budget` is not their ceiling, it is their asking price.
  // TailorTalk's `requirement_details` describes their flat, not their
  // requirement. Reading a seller with requirementProfile() gets every one of
  // those backwards, which is exactly why isBuyerLead() refuses to.
  //
  // So this maps a seller lead onto the PROPERTY side instead, and hands it
  // to the same buyersFor() the Properties console and the Track board use.
  function ownerPropertyProfile(lead, opts) {
    const o = opts || {};
    const tt = (lead && lead.tt) || {};
    const prof = tt.profile || {};
    // What the owner told us about the property, richest source first.
    const described = [
      lead.propertyInterest,
      prof.requirement_details,
      prof.preferred_location,
      (tt.values && tt.values.propertyInterest) || ''
    ].filter(Boolean).join(' , ');
    // The asking price, from the field if it is filled in and otherwise out
    // of the owner's own sentence — "selling my 3BHK in Anna Nagar, asking
    // 3.4 Cr" is how an owner writes in, and reading only the Budget field
    // threw that figure away and left the price unscored entirely.
    let asking = [lead.budget, prof.budget_and_finance, (tt.values && tt.values.budget) || '']
      .filter(Boolean)[0] || '';
    if (!moneySpans(asking).length) {
      const fromText = moneySpans(described).filter(r => r[1] >= 5 * LAKH && r[0] <= 500 * CR);
      if (fromText.length) asking = fmtMoney(Math.min.apply(null, fromText.map(r => r[0])));
    }

    const asProperty = {
      id: 'owner:' + (lead.id || ''),
      propertyCode: (lead.propertyCodes || [])[0] || null,
      name: described ? described.slice(0, 80) : (lead.name ? lead.name + '’s property' : 'Owner listing'),
      location: described,
      config: described,
      startingPrice: asking,
      type: guessType({ title: described, config: described, remarks: prof.remarks }, described),
      highlights: [prof.remarks, prof.activity_so_far].filter(Boolean).join(' | '),
      detailsText: [described, prof.chat_summary, lead.aiSummary, lead.lastNote && lead.lastNote.text]
        .filter(Boolean).join(' \n ')
    };
    const p = propertyProfile(asProperty);
    p.kind = 'owner';
    p.provisional = true;
    p.lead = lead;
    return p;
  }

  function guessType(listing, extra) {
    const s = fold([listing.title, listing.config, listing.remarks, extra].filter(Boolean).join(' '));
    for (const w of TYPE_WORDS) if (w.re.test(s)) return w.type;
    return '';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ATTRIBUTES
  // ═══════════════════════════════════════════════════════════════════════
  //
  // The scoring table. Each attribute:
  //
  //   weight      its share of the total, in points
  //   core        counts towards `confidence` (the facts a match stands or
  //               falls on — everything else is refinement)
  //   score(r,p)  → null when the buyer never told us (not scored, and not
  //               held against the property), else
  //               { s: 0..1, why, veto?: 'reason' }
  //
  // Weights are relative, not absolute: only the attributes in play are
  // summed, so they express "how much does this matter COMPARED to the other
  // things this buyer told us".
  const ATTRIBUTES = [
    {
      key: 'budget', label: 'Budget', weight: 28, core: true,
      score(r, p) {
        if (!r.budget || p.priceLo == null) return null;
        const max = r.budget.flexible ? r.budget.max * 1.08 : r.budget.max;
        const price = p.priceLo;
        const priceSensitive = r.objections.some(o => o.kind === 'price_high');

        if (price <= max) {
          // Comfortably inside. Far BELOW the stated floor is a segment
          // mismatch, not a bargain: a ₹60 L flat is not what a ₹3 Cr buyer
          // came for, and offering it reads as not having listened.
          if (r.budget.min && price < r.budget.min * 0.55) {
            return { s: 0.6, why: `${fmtMoney(price)} — well under the ${r.budget.stated} they quoted, so possibly the wrong segment` };
          }
          const head = max > 0 ? Math.round((1 - price / max) * 100) : 0;
          return { s: 1, why: `${fmtMoney(price)} against a ${r.budget.stated} budget${head >= 8 ? ` — ${head}% of headroom` : ''}` };
        }

        const over = price / max;
        const pct = Math.round((over - 1) * 100);

        // ── How far a buyer can stretch depends on the segment, not on a
        //    percentage ──
        //
        // A flat 20% band was materially wrong at both ends. A ₹50 L buyer
        // stretching 17% has to find ₹8.5 L in cash they do not have, because
        // their loan is already at the eligibility ceiling — that is a wall,
        // not a preference, and it is where this market's volume is. A ₹8 Cr
        // buyer stretching 17% is often one phone call. So tolerance is read
        // off the bracket and the curve is expressed in multiples of it,
        // which leaves the reference case (₹3 Cr budget, ₹3.5 Cr property,
        // 17% over → 0.78) exactly where it was.
        const tol = max < 75 * LAKH ? 0.08
          : max < 2 * CR ? 0.12
            : max < 5 * CR ? 0.20
              : 0.28;
        const stretch = (over - 1) / tol;      // 1.0 = at the edge of it

        const s = stretch <= 0.15 ? 0.98
          : stretch <= 0.30 ? 0.95
            : stretch <= 0.55 ? 0.88
              : stretch <= 0.85 ? 0.78
                : stretch <= 1.20 ? 0.55
                  : stretch <= 1.80 ? 0.30
                    : 0.08;

        const band = max < 75 * LAKH ? 'at this budget a loan is already at its ceiling, so there is little room to stretch' : null;
        // The anchor rule in applyObjections() already sets the real ceiling
        // from the property they actually called expensive, and that is the
        // better instrument — so this blanket stop now only applies to a
        // buyer who has said it more than once.
        const saidTwice = r.objections.filter(o => o.kind === 'price_high').length > 1;
        if (priceSensitive && saidTwice && stretch > 1.2) {
          return { s, veto: `${pct}% over the ${r.budget.stated} budget, and they have called a property too expensive more than once` };
        }
        if (stretch > 2.2) return { s, veto: `${fmtMoney(price)} is ${pct}% over the ${r.budget.stated} budget` };
        return {
          s,
          why: `${fmtMoney(price)} — ${pct}% over the ${r.budget.stated} budget`
            + (s >= 0.78 ? ', close enough to put to them' : (band ? ` — ${band}` : ''))
        };
      }
    },

    {
      key: 'locality', label: 'Location', weight: 22, core: true,
      // Every geographic judgement in the product funnels through here, and
      // it defers to the area model (shared-assets/area-model.js) whenever
      // the caller has one — which is whenever the inventory is to hand. The
      // model knows things no table can: that "I Block" is inside Anna Nagar,
      // that Sivagamipuram sits between Adyar and Thiruvanmiyur, and that it
      // has never heard of Periya Palayatamman Nagar.
      score(r, p, ctx) {
        if (!r.localities || !r.localities.keys.length) return null;
        const geo = G();
        const area = ctx && ctx.area;
        const want = r.localities.keys;
        const heres = p.localities.length ? p.localities : (p.locationText ? [p.locationText] : []);
        if (!heres.length) return { s: 0.08, why: 'no location recorded on this property' };

        // ── A corridor is a whole answer, not a point ──
        //
        // "Anywhere on OMR" is the commonest brief in this market, and it was
        // scored as straight-line distance from Sholinganallur — because the
        // alias table collapses 'omr' onto one representative locality, and
        // the corridor fallback below only ran when the gazetteer FAILED.
        // Both sides resolved fine, so it never ran: Perungudi (8 km) scored
        // 0.48 and Kelambakkam (13 km) scored 0.3, when both are exactly what
        // that buyer asked for. Anything on a corridor the buyer named is a
        // full match, and only the length of the stretch separates them.
        if (r.localities.corridors && r.localities.corridors.length) {
          const geo2 = G();
          for (const c of r.localities.corridors) {
            const members = geo2.CORRIDOR_MEMBERS[c] || [];
            const hit = heres.find(h => members.includes(geo2.resolve(h)));
            if (hit) {
              // Name the property's OWN locality, not whichever member of the
              // corridor happened to match — "Sholinganallur, on OMR" for a
              // Kelambakkam property is true and useless.
              const own = p.localities[0] ? geo2.label(p.localities[0]) : geo2.label(geo2.resolve(hit));
              return { s: 1, why: `${own}, on ${c} — the stretch they asked for` };
            }
          }
        }

        // Best pairing over everywhere the buyer named × everywhere the
        // property can be said to be.
        // Argument order is (property, want), not (want, property), so that
        // `pr.from` is always the property and `pr.to` always the area the
        // buyer named. Every message below reads off that, and reversed it
        // produced lines like "Anna Nagar, about 1 km from Anna Nagar".
        let best = null;
        for (const w of want) {
          for (const h of heres) {
            const pr = area ? area.proximity(h, w) : legacyProximity(geo, h, w);
            if (!pr || pr.similarity == null) continue;
            if (!best || pr.similarity > best.pr.similarity) best = { w, h, pr };
          }
        }

        if (!best) {
          // The model has never met this area. That is NOT "far" — saying so
          // would quietly hide the right property from the right buyer and
          // nobody would ever find out. Fall back to the widest things we do
          // know, and score the unknown case neutrally rather than against.
          const wantCorridors = new Set(want.flatMap(w => geo.corridorsOf(w)));
          const shared = p.corridors.filter(c => wantCorridors.has(c));
          if (shared.length) return { s: 0.55, why: `on ${shared[0]}, the corridor they are looking along` };
          const wantZones = new Set(want.map(w => geo.zoneOf(w)).filter(Boolean));
          if (p.zone && wantZones.has(p.zone)) return { s: 0.3, why: `in ${p.zone}, the same side of the city` };
          return { s: 0.25, why: `${p.locationText || 'this area'} — we cannot place it against ${geo.label(want[0])} yet, so it is neither ruled in nor out` };
        }

        const { pr } = best;
        const label = k => (area ? area.label(k) : geo.label(k));

        if (pr.basis === 'same') return { s: 1, why: `${label(best.w)} — exactly where they are looking` };
        if (pr.basis === 'contains') return { s: 1, why: pr.note };

        const s = pr.similarity;
        const near = pr.kmBand ? `about ${pr.kmBand} from ${pr.to}` : `near ${pr.to}`;

        // A veto needs evidence strong enough to justify hiding a property.
        // Anchored positions and stated distances qualify. An ESTIMATED
        // position does not unless the model is confident in it, and a
        // graph-only link never does — being unsure where somewhere is, is
        // not grounds for excluding it.
        const trustworthy = pr.basis === 'anchored' || pr.basis === 'measured'
          || (pr.basis === 'estimated' && pr.confidence >= 0.7);
        if (s <= 0.15 && r.localities.firm && trustworthy) {
          return { s, veto: `${pr.from} is ${pr.kmBand || 'a long way'} from ${pr.to}, which is where they asked for` };
        }

        const hedge = pr.basis === 'estimated' && pr.confidence < 0.7 ? ' (estimated)'
          : pr.basis === 'timed' ? ' (from a quoted drive time)'
            : pr.basis === 'graph' ? '' : '';
        return {
          s: pr.basis === 'graph' ? Math.min(s, 0.6) : s,
          why: pr.basis === 'graph' ? `${pr.from} — ${pr.note}` : `${pr.from}, ${near}${hedge}`
        };
      }
    },

    {
      key: 'bhk', label: 'Configuration', weight: 16, core: true,
      score(r, p) {
        if (!r.bhk || !r.bhk.values.length) return null;
        // A plot has no bedrooms. Scoring it would mark down every plot for a
        // buyer who said "3BHK plot", which is a thing people say.
        if (p.type === 'Plot' || p.type === 'Commercial') return null;
        if (!p.bhk.length) return null;
        const want = r.bhk.values, has = p.bhk;
        const exact = want.filter(w => has.includes(w));
        if (exact.length) return { s: 1, why: `${exact.join(' / ')} BHK, as asked` };
        // One bedroom up is a real option if the budget holds; one down is a
        // compromise the buyer has to accept, so it is worth less.
        const up = want.some(w => has.includes(w + 1));
        const down = want.some(w => has.includes(w - 1));
        const nearest = has.reduce((a, b) => Math.abs(b - want[0]) < Math.abs(a - want[0]) ? b : a, has[0]);
        if (up) return { s: 0.6, why: `${nearest} BHK against the ${want.join('/')} they asked for — one more room` };
        if (down) return { s: 0.38, why: `${nearest} BHK against the ${want.join('/')} they asked for — one room short` };
        return {
          s: 0.05,
          veto: `${has.join('/')} BHK only, and they asked for ${want.join('/')}`
        };
      }
    },

    {
      key: 'type', label: 'Property type', weight: 14, core: true,
      score(r, p) {
        if (!r.types || !r.types.values.length) return null;
        // 'Other' is what normType() returns for a blank or unrecognised type
        // column — which means "we do not know", not "it is something else".
        // Scoring it as a 0.2 mismatch cost 11 of 14 points for no reason,
        // and it showed up worst exactly where the data is thinnest: an
        // owner's own description of their flat rarely contains the word
        // "apartment", so a seller's buyers were all being marked down ~14%
        // against a property nobody had said anything wrong about.
        if (p.type === 'Other') return null;
        const want = r.types.values;
        if (want.includes(p.type)) {
          // A BHK with no type named tells us "a home" and nothing more, so
          // the reason has to say that rather than claim they asked for a flat.
          return r.types.residentialOnly
            ? { s: 1, why: `${S().TYPE_LABEL[p.type] || p.type} — residential, which is what they are after` }
            : { s: 1, why: `${S().TYPE_LABEL[p.type] || p.type}, as asked` };
        }
        const RESI = ['Apartment', 'Villa', 'House'];
        const wantsResi = want.some(t => RESI.includes(t));
        const isResi = RESI.includes(p.type);
        // A plot buyer does not want a flat and a flat buyer does not want a
        // plot — that is not a near-miss, it is a different transaction.
        if (wantsResi && (p.type === 'Plot' || p.type === 'Commercial')) {
          return { s: 0, veto: `a ${S().TYPE_LABEL[p.type] || p.type} — they are looking for somewhere to live` };
        }
        if (!wantsResi && isResi) {
          return { s: 0, veto: `${S().TYPE_LABEL[p.type] || p.type}, and they asked for ${want.join(' / ')}` };
        }
        if (wantsResi && isResi) {
          return { s: 0.5, why: `${S().TYPE_LABEL[p.type] || p.type} rather than the ${want.join(' / ')} they named` };
        }
        return { s: 0.2, why: `${S().TYPE_LABEL[p.type] || p.type} against ${want.join(' / ')}` };
      }
    },

    {
      key: 'size', label: 'Size', weight: 10, core: true,
      score(r, p) {
        if (!r.size || p.areaLo == null) return null;
        const overlap = p.areaHi >= r.size.min && p.areaLo <= r.size.max;
        if (overlap) return { s: 1, why: `${fmtArea(p.areaLo, p.areaHi)} covers the ${fmtArea(r.size.min, r.size.max)} they want` };
        const short = p.areaHi < r.size.min;
        const gap = short ? r.size.min / p.areaHi : p.areaLo / r.size.max;
        const s = gap <= 1.1 ? 0.7 : gap <= 1.25 ? 0.45 : gap <= 1.5 ? 0.2 : 0.05;
        return { s, why: `${fmtArea(p.areaLo, p.areaHi)} against ${fmtArea(r.size.min, r.size.max)} — ${short ? 'smaller' : 'larger'} than asked` };
      }
    },

    {
      key: 'possession', label: 'Possession', weight: 9,
      score(r, p) {
        if (!r.possession) return null;
        if (r.possession.want === 'ready') {
          if (p.ready) return { s: 1, why: 'ready to move, which is what they need' };
          const y = p.possessionYear;
          const s = !y ? 0.2 : y <= 2026 ? 0.45 : y === 2027 ? 0.25 : 0.1;
          return {
            s,
            why: `hands over ${y || 'on an unstated date'}, and they want to move in now`,
            veto: s <= 0.1 ? `possession in ${y}, and they need somewhere ready now` : undefined
          };
        }
        if (r.possession.want === 'upcoming') {
          return p.ready
            ? { s: 0.4, why: 'ready to move, but they were after a project still under construction' }
            : { s: 1, why: 'under construction, as they wanted' };
        }
        if (r.possession.want === 'by') {
          if (p.ready) return { s: 1, why: `ready now, ahead of the ${r.possession.year} they need` };
          const y = p.possessionYear;
          if (!y) return { s: 0.3, why: 'no possession date on record' };
          if (y <= r.possession.year) return { s: 1, why: `hands over ${y}, inside their ${r.possession.year} deadline` };
          return { s: y - r.possession.year === 1 ? 0.4 : 0.1, why: `hands over ${y}, past the ${r.possession.year} they need` };
        }
        return null;
      }
    },

    {
      key: 'amenities', label: 'Amenities', weight: 6,
      score(r, p) {
        const want = r.facets.amenityTags;
        if (!want || !want.length) return null;
        const have = want.filter(t => p.amenityTags.includes(t));
        const labelOf = k => (S().AMENITY_TAGS.find(t => t.key === k) || {}).label || k;
        if (!have.length) return { s: 0.1, why: `none of the ${want.map(labelOf).join(', ')} they asked about` };
        const s = have.length / want.length;
        return { s, why: `${have.map(labelOf).join(', ')}${have.length < want.length ? ` (${want.length - have.length} of their asks missing)` : ''}` };
      }
    },

    {
      key: 'vastu', label: 'Vastu', weight: 5,
      score(r, p) {
        if (!r.facets.vastu) return null;
        return p.vastu
          ? { s: 1, why: 'Vastu compliant, which they asked for' }
          : { s: 0.15, why: 'no Vastu compliance recorded, and they asked for it' };
      }
    },

    {
      key: 'approval', label: 'Approval', weight: 4,
      score(r, p) {
        const want = r.facets.approvals;
        // A plot with no approval on record is a real risk even when nobody
        // asked, because it decides whether a bank will lend at all.
        if (!want || !want.length) {
          if (p.type !== 'Plot') return null;
          return p.approvals.length
            ? { s: 1, why: `${p.approvals.join(' / ')} approved` }
            : { s: 0.3, why: 'no approval recorded — worth confirming before showing a plot' };
        }
        const have = want.filter(a => p.approvals.includes(a));
        if (have.length) return { s: 1, why: `${have.join(' / ')} approved, as they asked` };
        return { s: 0.15, why: `no ${want.join(' / ')} approval on record` };
      }
    },

    {
      key: 'facing', label: 'Facing', weight: 4,
      score(r, p) {
        const want = r.facets.facing;
        if (!want || !want.length) return null;
        if (!p.facing.length) return { s: 0.3, why: 'facing not recorded' };
        const have = want.filter(f => p.facing.includes(f));
        return have.length
          ? { s: 1, why: `${have.join(' / ')} facing, as they asked` }
          : { s: 0.15, why: `${p.facing.join(' / ')} facing, and they wanted ${want.join(' / ')}` };
      }
    },

    {
      key: 'gated', label: 'Gated community', weight: 3,
      score(r, p) {
        if (!r.facets.gated) return null;
        return p.gated
          ? { s: 1, why: 'a gated community, as they asked' }
          : { s: 0.2, why: 'not recorded as a gated community' };
      }
    },

    {
      key: 'parking', label: 'Parking', weight: 3,
      score(r, p) {
        if (!r.facets.coveredParking) return null;
        return p.parkingKind.includes('Covered')
          ? { s: 1, why: 'covered parking, as they asked' }
          : { s: 0.25, why: p.parkingKind.length ? `${p.parkingKind.join(' / ')} parking only` : 'parking type not recorded' };
      }
    },

    {
      key: 'saleType', label: 'New / resale', weight: 3,
      score(r, p) {
        const want = r.facets.saleType;
        if (!want || !p.saleType) return null;
        return p.saleType === want
          ? { s: 1, why: `${want}, as they asked` }
          : { s: 0.2, why: `${p.saleType}, and they wanted ${want}` };
      }
    },

    {
      key: 'floor', label: 'Floor', weight: 3,
      score(r, p) {
        if (!r.floor || p.floorNo == null) return null;
        const low = p.floorNo <= 2;
        if (r.floor.want === 'low') {
          return low ? { s: 1, why: `floor ${p.floorNo}, low as they wanted` }
            : { s: 0.2, why: `floor ${p.floorNo}, and they wanted something lower` };
        }
        return !low ? { s: 1, why: `floor ${p.floorNo}, high as they wanted` }
          : { s: 0.3, why: `floor ${p.floorNo}, lower than they wanted` };
      }
    },

    {
      key: 'roadWidth', label: 'Approach road', weight: 2,
      score(r, p) {
        // Scored only when the buyer raised it. In Chennai a 30 ft approach
        // road against a 20 ft one is a real difference in price and resale —
        // but most buyers never mention it, and an unmentioned attribute is
        // not a gap.
        const min = r.facets.roadWidthMin;
        if (!min) return null;
        if (p.roadWidth == null) return { s: 0.35, why: 'road width not recorded' };
        if (p.roadWidth >= min) return { s: 1, why: `${p.roadWidth} ft approach road, at or above the ${min} ft they wanted` };
        const ratio = p.roadWidth / min;
        return { s: ratio >= 0.8 ? 0.55 : 0.15, why: `${p.roadWidth} ft approach road against the ${min} ft they wanted` };
      }
    },

    {
      key: 'corner', label: 'Corner unit', weight: 1,
      score(r, p) {
        if (!r.facets.corner) return null;
        return p.corner ? { s: 1, why: 'a corner unit, as they asked' } : { s: 0.2, why: 'not a corner unit' };
      }
    },

    {
      key: 'builder', label: 'Builder', weight: 4,
      score(r, p) {
        // Only when the buyer actually named a builder — matched on the
        // buyer's own text so "looking at Casagrand" counts and a builder
        // they never mentioned is not scored either way.
        if (!r.text || !p.builder) return null;
        const b = plain(p.builder);
        if (!b || b.length < 4) return null;
        const hay = plain(r.text);
        const head = b.split(' ')[0];
        const named = hay.includes(b) || (head.length >= 5 && hay.includes(head));
        return named ? { s: 1, why: `${p.builder} — the builder they named` } : null;
      }
    },

    {
      key: 'transit', label: 'Connectivity', weight: 3,
      score(r, p) {
        const c = conceptsOf(r.text || '');
        if (!c.transit) return null;
        return p.metro
          ? { s: 1, why: 'metro on the doorstep, and connectivity is one of their asks' }
          : { s: 0.3, why: 'no metro noted nearby, and they asked about connectivity' };
      }
    },

    {
      key: 'loan', label: 'Loan', weight: 2,
      score(r, p) {
        const c = conceptsOf(r.text || '');
        if (!c.loan) return null;
        if (p.loanEligible || p.approvals.includes('RERA') || p.approvals.includes('CMDA')) {
          return { s: 1, why: 'bank-fundable on record, and they are buying on a loan' };
        }
        return { s: 0.35, why: 'loan eligibility not recorded, and they are buying on a loan' };
      }
    },

    {
      key: 'age', label: 'Age', weight: 2,
      score(r, p) {
        const wantsNew = r.facets.saleType === 'New' || conceptsOf(r.text || '').new_build;
        if (!wantsNew || p.ageYears == null) return null;
        return p.ageYears <= 1 ? { s: 1, why: 'new build, as they wanted' }
          : p.ageYears <= 5 ? { s: 0.6, why: `about ${p.ageYears} years old` }
            : { s: 0.2, why: `about ${p.ageYears} years old, and they wanted something new` };
      }
    },

    {
      key: 'lifestyle', label: 'What they talk about', weight: 8,
      score(r, p, ctx) {
        // The semantic layer. Only scored when the buyer has actually said
        // enough for a concept vector to mean something — two words of
        // requirement do not justify a similarity claim.
        if (!r.vector || r.vector.size < 4) return null;
        // And only when their words express at least one CONCEPT. A buyer
        // whose entire prose is "Did the site visit, said the price is high"
        // has told us a great deal about price and nothing about lifestyle;
        // scoring prose similarity there is measuring noise, and it was
        // quietly costing such leads seven points they had never been asked
        // about.
        if (!Object.keys(conceptsOf(r.text || '')).length) return null;
        const sim = cosine(r.vector, p.vector, ctx && ctx.idf);
        // Cosine on short, jargon-heavy text lands low even for a good
        // match, so the band is what carries the meaning, not the number.
        // Nothing here vetoes: prose is the weakest evidence we hold.
        const shared = sharedConcepts(r, p);
        if (sim >= 0.28) return { s: 1, why: shared.length ? `talks about ${shared.slice(0, 3).join(', ')} — so does this property` : 'the wording of their brief lines up closely' };
        if (sim >= 0.18) return { s: 0.75, why: shared.length ? `overlaps on ${shared.slice(0, 2).join(', ')}` : 'their brief overlaps this property' };
        if (sim >= 0.10) return { s: 0.5, why: shared.length ? `some overlap on ${shared[0]}` : 'a little overlap with their brief' };
        if (sim >= 0.04) return { s: 0.28, why: 'little in common with how they describe what they want' };
        return { s: 0.1, why: 'nothing in common with how they describe what they want' };
      }
    }
  ];

  // Without an area model — a page that has a lead but not the inventory —
  // fall back to the anchor table alone, in the same shape proximity()
  // returns so the scorer above needs no second code path. It knows far less:
  // no hierarchy, no learned edges, no idea what a block is.
  function legacyProximity(geo, a, b) {
    if (geo.resolve(a) && geo.resolve(a) === geo.resolve(b)) {
      return { similarity: 1, km: 0, kmBand: null, basis: 'same', confidence: 1, note: 'the same area', from: geo.label(geo.resolve(a)), to: geo.label(geo.resolve(b)) };
    }
    const km = geo.distanceKm(a, b);
    if (km == null) return null;
    const similarity = km <= 1.5 ? 0.92 : km <= 3 ? 0.82 : km <= 5 ? 0.68
      : km <= 8 ? 0.48 : km <= 12 ? 0.3 : km <= 18 ? 0.15 : 0.05;
    return {
      similarity, km, kmBand: km < 0.9 ? 'under a kilometre' : Math.round(km) + ' km',
      basis: 'anchored', confidence: 1, note: `about ${Math.round(km)} km apart`,
      from: geo.label(geo.resolve(a)), to: geo.label(geo.resolve(b))
    };
  }

  // The area model for a property list, when one can be built. Cached by
  // PinAreaModel itself against the list identity, so calling this on every
  // render costs nothing after the first.
  function areaModelFor(list, extra) {
    if (!root.PinAreaModel || !Array.isArray(list) || !list.length) return null;
    try { return root.PinAreaModel.forList(list, extra ? { extra } : null); } catch (e) { return null; }
  }

  // Human names for the concept axes, for the "why" line.
  const CONCEPT_LABEL = {
    family: 'schools and family life', it_corridor: 'the IT corridor', transit: 'metro and connectivity',
    coastal: 'the coast', waterbody: 'a lake outlook', luxury: 'premium finish', value: 'value for money',
    investment: 'investment return', devotional: 'temples and Vastu', senior: 'elderly parents',
    privacy: 'privacy and independence', greenery: 'greenery and open space', quiet: 'a quiet street',
    main_road: 'main-road frontage', security: 'gated security', fitness: 'sports and fitness',
    healthcare: 'hospitals nearby', shopping: 'shops and markets', education_higher: 'colleges nearby',
    ready_now: 'moving in straight away', new_build: 'a new build', loan: 'bank funding',
    nri: 'buying from abroad', joint_family: 'a joint family', parking_need: 'parking'
  };

  function sharedConcepts(r, p) {
    const a = conceptsOf(r.text || ''), b = conceptsOf(propertyText(p.p || {}));
    return Object.keys(a).filter(k => b[k]).map(k => CONCEPT_LABEL[k] || k);
  }

  const CORE_WEIGHT = ATTRIBUTES.filter(a => a.core).reduce((n, a) => n + a.weight, 0);

  // ═══════════════════════════════════════════════════════════════════════
  // SCORING
  // ═══════════════════════════════════════════════════════════════════════

  // How an objection applies to one property. Separate from ATTRIBUTES
  // because an objection is not a want — it is a line the buyer has already
  // drawn, and it can rule a property out on its own.
  function applyObjections(r, p) {
    const out = [];
    for (const o of r.objections) {
      const hard = o.weight >= VETO_MIN_WEIGHT;
      const said = `“${o.quote}”`;

      if (o.kind === 'price_high' && p.priceLo != null && o.anchor) {
        // The ceiling they set by rejecting a price. 0.97 rather than 1.0
        // because "₹3.5 Cr was too much" also rules out ₹3.48 Cr — the
        // objection was to the level, not to the exact figure.
        if (p.priceLo >= o.anchor * 0.97) {
          out.push({
            kind: o.kind, label: o.label, quote: o.quote, at: o.at, src: o.src,
            points: o.penalty * o.weight,
            veto: hard ? `they called ${fmtMoney(o.anchor)} too expensive${o.anchorFrom && o.anchorFrom !== 'their own words' ? ` after seeing ${o.anchorFrom}` : ''}, and this is ${fmtMoney(p.priceLo)}` : null,
            why: `${fmtMoney(p.priceLo)} is at or above the ${fmtMoney(o.anchor)} they already called too expensive — ${said}`
          });
          continue;
        }
        // Below the ceiling: the objection is satisfied, not violated.
        continue;
      }

      if (o.kind === 'location_rejected' && Array.isArray(o.anchor) && o.anchor.length) {
        const geo = G();
        let hit = null;
        for (const bad of o.anchor) {
          for (const h of p.localities) {
            if (bad === h) { hit = { bad, km: 0 }; break; }
            const km = geo.distanceKm(bad, h);
            if (km != null && km <= 2.5 && (!hit || km < hit.km)) hit = { bad, km };
          }
          if (hit && hit.km === 0) break;
        }
        if (hit) {
          out.push({
            kind: o.kind, label: o.label, quote: o.quote, at: o.at, src: o.src,
            points: o.penalty * o.weight,
            veto: hard ? `they ruled out ${geo.label(hit.bad)}, and this is ${hit.km === 0 ? 'in it' : 'about ' + Math.round(hit.km) + ' km away'}` : null,
            why: `they ruled out ${geo.label(hit.bad)} — ${said}`
          });
        }
        continue;
      }

      if (o.kind === 'possession_late' && !p.ready) {
        out.push({
          kind: o.kind, label: o.label, quote: o.quote, at: o.at, src: o.src,
          points: o.penalty * o.weight,
          veto: hard ? `they will not wait for possession, and this hands over ${p.possessionYear || 'on an unstated date'}` : null,
          why: `still under construction, and they have said they cannot wait — ${said}`
        });
        continue;
      }

      if (o.kind === 'size_small' && o.anchor && p.areaHi != null && p.areaHi <= o.anchor * 1.02) {
        out.push({
          kind: o.kind, label: o.label, quote: o.quote, at: o.at, src: o.src,
          points: o.penalty * o.weight, veto: null,
          why: `${fmtArea(p.areaLo, p.areaHi)} is no bigger than the ${Math.round(o.anchor)} sqft they already called small — ${said}`
        });
        continue;
      }

      if (o.kind === 'floor_high' && p.floorNo != null && p.floorNo >= 5) {
        out.push({ kind: o.kind, label: o.label, quote: o.quote, at: o.at, src: o.src, points: o.penalty * o.weight, veto: null, why: `floor ${p.floorNo}, and they have objected to a high floor — ${said}` });
        continue;
      }
      if (o.kind === 'no_parking' && !p.parkingKind.length) {
        out.push({ kind: o.kind, label: o.label, quote: o.quote, at: o.at, src: o.src, points: o.penalty * o.weight, veto: null, why: `no parking recorded, and parking has already been a problem for them — ${said}` });
        continue;
      }
      if (o.kind === 'vastu_fail' && !p.vastu) {
        out.push({ kind: o.kind, label: o.label, quote: o.quote, at: o.at, src: o.src, points: o.penalty * o.weight, veto: null, why: `no Vastu compliance recorded, and they have turned one down over it — ${said}` });
        continue;
      }
      if (o.kind === 'approval_missing' && !p.approvals.length) {
        out.push({ kind: o.kind, label: o.label, quote: o.quote, at: o.at, src: o.src, points: o.penalty * o.weight, veto: null, why: `no approval on record, and paperwork has already stopped them once — ${said}` });
        continue;
      }
      if (o.kind === 'old_property' && p.ageYears != null && p.ageYears >= 8) {
        out.push({ kind: o.kind, label: o.label, quote: o.quote, at: o.at, src: o.src, points: o.penalty * o.weight, veto: null, why: `about ${p.ageYears} years old, and they have rejected one for being old — ${said}` });
        continue;
      }
      if (o.kind === 'main_road_noise' && conceptsOf(propertyText(p.p || {})).main_road) {
        out.push({ kind: o.kind, label: o.label, quote: o.quote, at: o.at, src: o.src, points: o.penalty * o.weight, veto: null, why: `on a main road, and they have complained about noise — ${said}` });
        continue;
      }
      if (o.kind === 'maintenance_high' || o.kind === 'loan_issue') {
        // Nothing in the inventory answers these, so they travel as context
        // rather than as a penalty against a specific property.
        continue;
      }
    }
    return out;
  }

  /**
   * Score one requirement against one property.
   *
   * @returns {{
   *   pct:number, fit:number, confidence:number, rank:number,
   *   for:Array<{key,label,points,of,why}>, against:Array,
   *   vetoed:boolean, vetoes:Array<{label,why}>,
   *   earned:number, available:number, penalty:number, breakdown:Array
   * }}
   */
  function score(req, prop, ctx) {
    const c = ctx || {};
    const breakdown = [];
    let earned = 0, available = 0, coreKnown = 0;
    const vetoes = [];

    for (const attr of ATTRIBUTES) {
      let res = null;
      try { res = attr.score(req, prop, c); } catch (e) { res = null; }
      if (!res) continue;
      const s = Math.max(0, Math.min(1, res.s));
      const points = s * attr.weight;
      earned += points;
      available += attr.weight;
      if (attr.core) coreKnown += attr.weight;
      if (res.veto) vetoes.push({ key: attr.key, label: attr.label, why: res.veto });
      breakdown.push({
        key: attr.key, label: attr.label, s,
        points: round1(points), of: attr.weight,
        why: res.why || res.veto, veto: !!res.veto
      });
    }

    const objections = applyObjections(req, prop);
    objections.forEach(o => { if (o.veto) vetoes.push({ key: o.kind, label: o.label, why: o.veto }); });
    const penalty = objections.reduce((n, o) => n + o.points, 0);

    // Sold out is not a judgement call.
    if (prop.soldOut) vetoes.push({ key: 'soldOut', label: 'Availability', why: 'marked sold out' });

    const fit = available > 0 ? Math.max(0, (earned - penalty) / available) : 0;
    const confidence = CORE_WEIGHT > 0 ? coreKnown / CORE_WEIGHT : 0;

    // The reasons an agent reads. Ranked by how much each actually
    // contributed, not by the table's order — five is the most anyone takes
    // in before picking up the phone.
    const forList = breakdown
      .filter(b => b.s >= 0.5 && b.why && !b.veto)
      .sort((a, b) => b.points - a.points)
      .slice(0, 5);

    const againstList = breakdown
      .filter(b => b.s < 0.5 && b.why)
      .sort((a, b) => (b.of - b.points) - (a.of - a.points))
      .slice(0, 3)
      .map(b => ({ key: b.key, label: b.label, why: b.why, lost: round1(b.of - b.points) }))
      .concat(objections.map(o => ({ key: o.kind, label: o.label, why: o.why, lost: round1(o.points), quote: o.quote, at: o.at })))
      .sort((a, b) => b.lost - a.lost)
      .slice(0, 4);

    return {
      pct: Math.round(fit * 100),
      fit, confidence,
      rank: fit * (0.6 + 0.4 * confidence),
      for: forList, against: againstList,
      vetoed: vetoes.length > 0, vetoes,
      earned: round1(earned), available: round1(available), penalty: round1(penalty),
      objections, breakdown
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THE THREE DIRECTIONS
  // ═══════════════════════════════════════════════════════════════════════

  // Leads that cannot buy anything: sellers, vendors, collaborations, and
  // anyone already closed. Matching them to a property would fill the panel
  // with noise and hide the three people who matter.
  const DEAD_STAGES = new Set(['lost', 'won']);

  function isBuyerLead(lead, stageKeyOf) {
    if (!lead) return false;
    const intent = lead.ai && lead.ai.intent;
    if (intent === 'sell' || intent === 'rent_out' || intent === 'vendor') return false;
    if (/seller|vendor|collaborat/i.test(String(lead.enquiryType || ''))) return false;
    if (stageKeyOf) {
      const k = stageKeyOf(lead);
      if (k && DEAD_STAGES.has(k)) return false;
    }
    return true;
  }

  /**
   * Buyers for one property, best first.
   *
   * @param property    an inventory property, or a listingProfile()/propertyProfile() result
   * @param leads       every lead the page holds
   * @param opts        { inventory, now, limit, minPct, includeVetoed, stageKeyOf, notesFor }
   */
  function buyersFor(property, leads, opts) {
    const o = opts || {};
    const prop = property && property.kind ? property : propertyProfile(property);
    const idf = idfFor(o.inventory);
    // The listing side of the Track board is not in the inventory yet, so it
    // is handed to the model as `extra` — a brand-new area is known to the
    // model the day its first listing is created, not the day it is synced.
    const ctx = { idf, area: o.area || areaModelFor(o.inventory, prop.listing ? [prop.listing] : null) };
    const min = o.minPct == null ? 45 : o.minPct;
    const out = [];

    for (const lead of (leads || [])) {
      if (!isBuyerLead(lead, o.stageKeyOf)) continue;
      const req = requirementProfile(lead, { now: o.now, inventory: o.inventory, notes: o.notesFor ? o.notesFor(lead) : null });
      // Nothing at all to go on — no budget, no area, no configuration. A
      // score here would be a guess dressed as a number.
      if (!req.budget && !req.localities && !req.bhk && !req.types) continue;
      const s = score(req, prop, ctx);
      if (s.vetoed && !o.includeVetoed) continue;
      if (!s.vetoed && s.pct < min) continue;
      out.push(Object.assign({ lead, req, property: prop }, s));
    }
    out.sort((a, b) => b.rank - a.rank || b.pct - a.pct);
    return o.limit ? out.slice(0, o.limit) : out;
  }

  /**
   * Properties for one lead (or one typed brief), best first.
   *
   * @param lead        a lead document, or a requirementProfile()/briefProfile() result
   * @param properties  the inventory
   * @param opts        { now, limit, minPct, includeVetoed, includeSeen, notes }
   */
  function propertiesFor(lead, properties, opts) {
    const o = opts || {};
    const list = properties || [];
    const req = lead && lead.kind ? lead : requirementProfile(lead, { now: o.now, inventory: list, notes: o.notes });
    const ctx = { idf: idfFor(list), area: o.area || areaModelFor(list) };
    const min = o.minPct == null ? 45 : o.minPct;
    const already = new Set((req.seen || []).map(x => String(x.p.id)));
    const out = [];

    for (const p of list) {
      const prop = propertyProfile(p);
      const seen = already.has(String(p.id));
      if (seen && !o.includeSeen) continue;
      const s = score(req, prop, ctx);
      if (s.vetoed && !o.includeVetoed) continue;
      if (!s.vetoed && s.pct < min) continue;
      out.push(Object.assign({ p, property: prop, req, alreadyShared: seen }, s));
    }
    out.sort((a, b) => b.rank - a.rank || b.pct - a.pct);
    return o.limit ? out.slice(0, o.limit) : out;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SEMANTIC SEARCH — the hybrid layer for the search bar
  // ═══════════════════════════════════════════════════════════════════════
  //
  // search-engine.js stays the precision layer and its contract is untouched:
  // every clause must still hold. What it cannot do is rank what it has
  // already decided to keep, or find the property that answers a sentence
  // without containing its words. Both are handled here and fused by
  // Reciprocal Rank Fusion, which combines two rankings without needing their
  // scores to be on the same scale — the standard trick, and the reason no
  // magic multiplier appears below.
  const RRF_K = 60;

  function semanticRank(list, text, opts) {
    const o = opts || {};
    const q = embed(text);
    if (!q.size) return [];
    const idf = idfFor(list);
    return list
      .map(p => ({ p, sim: cosine(q, propertyProfile(p).vector, idf) }))
      .filter(x => x.sim > (o.floor == null ? 0.03 : o.floor))
      .sort((a, b) => b.sim - a.sim);
  }

  /**
   * Fuse the lexical result with the semantic one.
   *
   * @param lexical  [{ p, score, reasons }] straight from PinSearch.search
   * @param list     the same candidate list the lexical pass ran over
   * @param text     the raw query
   * @returns        [{ p, score, reasons, lexRank, semRank, fused }]
   */
  function fuse(lexical, list, text, opts) {
    const o = opts || {};
    const sem = semanticRank(list, text, o);
    if (!sem.length) return lexical;
    const semPos = new Map();
    sem.forEach((x, i) => semPos.set(x.p.id, { rank: i + 1, sim: x.sim }));

    // Only properties the lexical layer kept are returned — this widens the
    // ORDER, not the result set. Recall is a separate, explicit feature
    // (nearMisses below), because silently loosening a filter an agent set is
    // how a search stops being trusted.
    const out = lexical.map((h, i) => {
      const s = semPos.get(h.p.id);
      const lexRank = i + 1;
      const fused = 1 / (RRF_K + lexRank) + (s ? 1 / (RRF_K + s.rank) : 0);
      const reasons = h.reasons ? h.reasons.slice() : [];
      if (s && s.sim >= 0.15 && reasons.length < 5) {
        const shared = Object.keys(conceptsOf(text)).filter(k => conceptsOf(propertyText(h.p))[k]);
        if (shared.length) reasons.push('reads like ' + (CONCEPT_LABEL[shared[0]] || shared[0]));
      }
      return Object.assign({}, h, { reasons, lexRank, semRank: s ? s.rank : null, sim: s ? s.sim : 0, fused });
    });
    out.sort((a, b) => b.fused - a.fused);
    return out;
  }

  /**
   * Properties that ALMOST answer the query — the recall half, kept separate
   * and clearly labelled so it can never be mistaken for a real hit.
   *
   * Each clause is scored on its own and the property is kept when it
   * satisfies most of them, with the misses named. This is what turns "no
   * properties found" into "nothing has all five, here are four that have
   * four of them, each missing only Vastu".
   */
  function nearMisses(list, text, opts) {
    const o = opts || {};
    const eng = S();
    const gaz = o.gazetteer || eng.buildGazetteer(list);
    const clauses = eng.parseQuery(text, gaz);
    if (clauses.length < 2) return [];
    const exclude = new Set((o.exclude || []).map(p => p.id));
    const out = [];

    for (const p of list) {
      if (exclude.has(p.id)) continue;
      const rec = eng.indexProperty(p);
      let met = 0;
      const missing = [];
      let blocked = false;
      for (const c of clauses) {
        let hit = null;
        for (const leaf of c.leaves) {
          // matchLeaf is not exported; parseQuery + the public matchers are.
          // A one-clause search() over this single property is the honest way
          // to ask "does this clause hold", and it costs one index lookup
          // because indexProperty is cached.
          const r = leafHolds(eng, rec, leaf, p, gaz);
          if (r && (!hit || r > hit)) hit = r;
        }
        if (c.negate) { if (hit) { blocked = true; break; } continue; }
        if (hit) met++;
        else missing.push(clauseLabel(c));
      }
      if (blocked) continue;
      const wanted = clauses.filter(c => !c.negate).length;
      const ratio = wanted ? met / wanted : 0;
      // "Missing at most two things", not a ratio alone. A two-thirds ratio
      // reads fine on a five-part query and silently excludes the case
      // near-misses exist FOR: a query so specific that NOTHING meets it,
      // where every candidate is missing two. Both conditions are kept — the
      // count alone would let a two-clause query offer a property that met
      // only one of them.
      if (missing.length && missing.length <= 2 && ratio >= 0.5) {
        out.push({ p, met, of: wanted, ratio, missing });
      }
    }
    out.sort((a, b) => b.ratio - a.ratio || a.missing.length - b.missing.length);
    return o.limit ? out.slice(0, o.limit) : out;
  }

  // Whether one leaf holds for one property, using only PinSearch's public
  // surface. Returns a rough score or 0.
  function leafHolds(eng, rec, leaf, p, gaz) {
    if (leaf.kind === 'facet') {
      const rule = { field: leaf.facet, values: [leaf.value] };
      const r = eng.matchRule(rec, rule);
      return r && r.ok ? 1 : 0;
    }
    if (leaf.kind === 'num' && leaf.field) {
      const NUMERIC = new Set(['price', 'psf', 'sqft', 'superb', 'carpet', 'uds', 'land', 'units', 'floors', 'bath', 'parking']);
      if (leaf.field === 'bhk') {
        const r = eng.matchRule(rec, { field: 'bhk', values: [leaf.lo] });
        return r && r.ok ? 1 : 0;
      }
      if (NUMERIC.has(leaf.field)) {
        const lo = leaf.cmp === 'lt' ? 0 : leaf.lo;
        const hi = leaf.cmp === 'gt' ? Infinity : leaf.hi;
        const r = eng.matchRule(rec, { field: leaf.field, min: lo, max: hi });
        return r && r.ok ? 1 : 0;
      }
    }
    // Text, gazetteer and unscoped numbers: ask the real engine over a
    // single-property list, which is exactly the semantics the full search
    // would apply.
    const text = leaf.kind === 'gaz' ? (leaf.entry && leaf.entry.raw) || leaf.text : leaf.text;
    if (!text) return 0;
    const hit = eng.search([p], { text: String(text), gazetteer: gaz });
    return hit.length ? 1 : 0;
  }

  // What a clause is CALLED when we have to tell somebody it was not met.
  //
  // This reads off the leaf's facet and value rather than its `text`, because
  // `text` is the engine's internal spelling — the normalised token that
  // VALUE_MAP matched. Using it put "eastfacing" and "readytomove" in front
  // of an agent, and "BHK 3" where they say "3 BHK".
  function clauseLabel(c) {
    const l = c.leaves[0] || {};

    if (l.kind === 'facet') {
      const v = l.value;
      switch (l.facet) {
        case 'facing': return v + ' facing';
        case 'status': return v === 'ready' ? 'ready to move' : 'under construction';
        case 'vastu': return 'Vastu';
        case 'type': return S().TYPE_LABEL[v] || String(v);
        case 'saleType': return String(v);
        case 'furnishing': return String(v);
        case 'parkingKind': return v + ' parking';
        case 'availability': return String(v);
        case 'approvals': return v + ' approval';
        case 'corridor': return String(v);
        case 'bhk': return v + ' BHK';
        case 'hasBrochure': return 'a brochure';
        case 'hasPhotos': return 'photos';
        case 'amenityTags': return (S().AMENITY_TAGS.find(t => t.key === v) || {}).label || String(v);
        default: return String(l.text || v);
      }
    }

    if (l.kind === 'gaz') return (l.entry && l.entry.raw) || l.text;

    if (l.kind === 'num') {
      const f = l.field || 'value';
      if (f === 'bhk') {
        // Every value in the clause, since same-field leaves are ORed:
        // "3 or 4 BHK" is one clause and one label.
        const vals = c.leaves.filter(x => x.kind === 'num').map(x => x.lo);
        return [...new Set(vals)].join(' or ') + ' BHK';
      }
      const LBL = { price: 'budget', sqft: 'size', superb: 'super built-up', carpet: 'carpet area', psf: 'rate', land: 'land area', floors: 'floors', bath: 'bathrooms', parking: 'parking', units: 'units', uds: 'UDS' };
      const name = LBL[f] || f;
      if (f === 'price') {
        if (l.cmp === 'lt') return `a budget under ${fmtMoney(l.hi)}`;
        if (l.cmp === 'gt') return `a budget over ${fmtMoney(l.lo)}`;
        if (l.cmp === 'range') return `a budget of ${fmtMoney(l.lo)}–${fmtMoney(l.hi)}`;
        return `a budget of ${fmtMoney(l.lo)}`;
      }
      if (l.cmp === 'lt') return `${name} under ${Math.round(l.hi).toLocaleString('en-IN')}`;
      if (l.cmp === 'gt') return `${name} over ${Math.round(l.lo).toLocaleString('en-IN')}`;
      if (l.cmp === 'range') return `${name} of ${Math.round(l.lo).toLocaleString('en-IN')}–${Math.round(l.hi).toLocaleString('en-IN')}`;
      return `${name} of ${Math.round(l.lo).toLocaleString('en-IN')}`;
    }

    if (l.kind === 'scoped') return `${l.field}: ${l.text}`;
    return String(l.text || 'one term');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FORMATTING
  // ═══════════════════════════════════════════════════════════════════════

  function fmtMoney(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n >= CR) return '₹' + trim(n / CR) + ' Cr';
    if (n >= LAKH) return '₹' + trim(n / LAKH) + ' L';
    return '₹' + Math.round(n).toLocaleString('en-IN');
  }
  const trim = n => String(Math.round(n * 100) / 100);

  function fmtArea(lo, hi) {
    if (lo == null) return '—';
    const a = Math.round(lo).toLocaleString('en-IN');
    if (hi == null || Math.round(hi) === Math.round(lo)) return a + ' sqft';
    return a + '–' + Math.round(hi).toLocaleString('en-IN') + ' sqft';
  }

  const round1 = n => Math.round(n * 10) / 10;

  // A one-line verdict, for a card that has no room for five reasons.
  function band(pct, vetoed) {
    if (vetoed) return { key: 'ruled-out', label: 'Ruled out' };
    if (pct >= 85) return { key: 'strong', label: 'Strong match' };
    if (pct >= 70) return { key: 'good', label: 'Worth a call' };
    if (pct >= 55) return { key: 'partial', label: 'Partial match' };
    return { key: 'weak', label: 'Long shot' };
  }

  // ═══════════════════════════════════════════════════════════════════════
  const api = {
    // the three directions
    buyersFor, propertiesFor, score,
    // profiles
    requirementProfile, briefProfile, propertyProfile, listingProfile, ownerPropertyProfile,
    // the hybrid search layer
    fuse, semanticRank, nearMisses,
    // geography
    areaModelFor, legacyProximity,
    // vectors, exported for the tests and for reuse
    embed, cosine, conceptsOf, idfFor, propertyText, leadTexts,
    // extraction pieces, exported for the tests
    readBudget, readBhk, readTypes, readLocalities, readSize, readPossession,
    readObjections, readRoadWidth, readFacets, isBuyerLead,
    // presentation
    fmtMoney, fmtArea, band,
    // the table itself — the UI reads it to explain the scoring
    ATTRIBUTES, OBJECTIONS, CONCEPTS, CONCEPT_LABEL, CORE_WEIGHT, VETO_MIN_WEIGHT
  };
  root.PinMatch = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
