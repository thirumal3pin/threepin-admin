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
//   0. THE DEAL    rent or buy, before anything else. A tenant is never shown
//                  a flat for sale and a buyer never a flat to let — unless
//                  they have said they are open to both. This is a veto, not
//                  a weight: "for rent in Adambakkam" against "buying on OMR"
//                  used to come out at 100% because nothing ever asked.
//
//   fit  = (earned − penalties) / available. Refinements (facing, a pooja
//          room, a floor) count only when the buyer raised them — a buyer
//          who never mentioned facing is not marked down for facing. The
//          CORE is different: the deal, budget, area, bedrooms, type and
//          size are always in the sum, and one we do not know is scored at a
//          neutral prior (about half), not left out. Left out, two matching
//          facts made a 100% — the false certainty that buried the real
//          matches. Now a lead we know little about cannot score high, and
//          every match says what is still unknown and what to ask.
//
//   confidence = how much of the CORE we actually know.
//   interest   = how keen the buyer is right now (TailorTalk heat, stage,
//          visits, how recently they were in touch). It never changes the
//          percentage — that is how well the property fits — but it orders
//          the list: a hot buyer at 84% is the better call than a cold one
//          at 86%.
//   rank = fit × (0.6 + 0.4 × confidence) × (0.7 + 0.3 × interest).
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
  // Memoised: the scorer asks about the same requirement text once per property it is weighed
  // against (loan, age, lifestyle), and a "who wants this?" pass over a big CRM asked tens of
  // thousands of times about a few hundred texts. Bounded, so a long session cannot grow it forever.
  const conceptMemo = new Map();
  function conceptsOf(text) {
    const key = String(text == null ? '' : text);
    const hit = conceptMemo.get(key);
    if (hit) return hit;
    const s = fold(key).replace(/[^a-z0-9 ]+/g, ' ');
    const out = {};
    for (const [name, re] of Object.entries(CONCEPTS)) {
      re.lastIndex = 0;
      const hits = s.match(re);
      if (hits && hits.length) out[name] = hits.length;
    }
    if (conceptMemo.size > 4000) conceptMemo.clear();
    conceptMemo.set(key, out);
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
    // TailorTalk's running read of the conversation and the last thing they asked — the nearest
    // the lead document gets to the chat itself.
    if (typeof tt.stage === 'string') add(tt.stage, ttAt, 'Conversation (AI summary)', 1);
    if (typeof tt.latestAsk === 'string') add(tt.latestAsk, ttAt, 'Their latest ask', 1);

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
  //
  // Three kinds of money, never compared with each other: a purchase price,
  // a monthly rent ("40-60k per month", "Rent: 85k") and a lump-sum lease
  // ("30 lakhs lease amount"). `dealHint` ('sale' | 'rent' | null) settles a
  // bare number: "budget 30 lakhs" from a tenant is a lease amount.
  const RENTISH = /\b(?:rent|rental|per\s*month|monthly|p\.?\s*m\.?|a\s*month|month)\b|\/\s*(?:month|mon|m)\b/;
  const LEASEISH = /\b(?:lease|lumpsum|lump\s*sum|otti|bhogya|bogiyam)\b/;

  const PSF_SAID = /\b(?:per\s*sq\.?\s*(?:ft|feet|foot)|per\s*sft|per\s*square\s*(?:feet|foot)|psf|\/\s*sq\.?\s*ft|\/\s*sft|a\s*sq\.?\s*ft)\b/;
  const ANNUAL_SAID = /\b(?:per\s*annum|p\.?\s*a\.?|annual(?:ly)?|yearly|per\s*year|a\s*year)\b/;
  // "not more than 80 lakhs" is a ceiling — the negation is checked separately.
  const MIN_SAID = /\b(?<!not\s)(?<!no\s)(?:above|over|more\s*than|minimum|min|at\s*least|atleast|starting\s*(?:from|at)?)\s*(?:rs\.?|₹|inr)?\s*\d/;
  // A clause about a PROPERTY's price is not the client's budget: "ANR003 is priced at ₹3.25 Cr",
  // "₹4.7 Cr listing price for TNAG0003", "quoted 2.9 Cr". Dropped before the budget is read.
  const PROP_PRICE_CLAUSE = /\b(?:priced\s*at|is\s*priced|asking\s*price|listing\s*price|list\s*price|quoted|quote\s*(?:of|for|is)|price\s*(?:of|for)\s*[A-Z]{2,5}\d{3,4}|selling\s*price)\b|\b[A-Z]{2,5}\d{3,4}\b/;
  function budgetText(text) {
    // Clauses end at ; | a new line, "but", or a full stop that ends a sentence — never the point in "3.5 Cr".
    const parts = String(text || '').split(/[;|\n]+|\.\s+(?=[A-Z])|\s+(?=but\b)/);
    return parts.filter(c => !PROP_PRICE_CLAUSE.test(c) || /\b(?:budget|can\s*afford|my\s*range|we\s*can\s*(?:go|pay))\b/i.test(c)).join(' ').trim();
  }
  function readBudget(texts0, dealHint) {
    const texts = texts0.map(t => ({ ...t, text: budgetText(t.text) })).filter(t => t.text);
    for (const t of texts) {
      const m = S().parseMoney(t.text, 'price');
      const s = fold(t.text);
      // A rate per square foot is a budget too, and it is not a price: "up to 9000 per sqft". Only
      // from what the client said (the requirement, the budget, a typed brief) — a rate 3 PIN quoted
      // them, in the AI's status line or a chat summary, is the property's, not their budget.
      if (PSF_SAID.test(s) && /Budget|Requirement|Property \/ Locality|Typed|Reviewed|Ad form|TailorTalk/.test(t.src) && !(m.price || []).some(r => r[1] >= 5 * LAKH)) {
        const rates = (m.psf || []).concat(m.price || []).filter(r => r[0] >= 1500 && r[1] <= 100000);
        if (rates.length) {
          const hi = Math.max.apply(null, rates.map(r => r[1]));
          return { min: Math.round(hi * 0.7), max: hi, firm: true, flexible: /\b(?:around|approx|about|flexible|negotiable)\b/.test(s), mode: 'psf', stated: `₹${hi.toLocaleString('en-IN')} per sq ft`, src: t.src };
        }
      }
      const rentish = RENTISH.test(s), leaseish = LEASEISH.test(s);
      // A tenant's word for it: rent, lease, tenant. "/month" alone is also how an EMI is quoted.
      const rentWord = /\b(?:rent|rental|renting|lease|leasing|tenant)\b/.test(s.replace(NOT_RENT_WANT, ' ').replace(/\brent\s*(?:currently|now|at\s*present)\b/g, ' '));
      // A bare 35,000 reads as a rate per sqft to the search parser; with no sqft word in sight and
      // a rent in question, it is the rent.
      const bare = /\b(?:sq\.?\s*ft|sqft|sft|square\s*feet|psf)\b/.test(s) ? [] : (m.psf || []);
      const small = (m.price || []).concat(bare).filter(r => r[0] >= 3000 && r[1] < 5 * LAKH);
      const monthly = (m.rent || []).filter(r => r[0] >= 3000 && r[1] < 50 * LAKH)
        .concat(small.filter(() => rentish || dealHint === 'rent'));
      const big = (m.price || []).filter(r => r[1] >= 5 * LAKH && r[0] <= 500 * CR);
      let spans = null, mode = null;
      // "Budget 80L, EMI 50k per month" is a buyer: the big figure wins unless a rent is talked about.
      if (big.length && !dealHint && !rentWord) { spans = big; mode = 'sale'; }
      else if (monthly.length && dealHint !== 'sale') { spans = monthly; mode = 'monthly'; }
      else if (big.length && dealHint !== 'sale' && (leaseish || dealHint === 'rent')) { spans = big; mode = 'lumpsum'; }
      else if (big.length && dealHint !== 'rent') { spans = big; mode = 'sale'; }
      else if (monthly.length && rentish) { spans = monthly; mode = 'monthly'; }
      if (!spans) continue;
      let lo = Math.min.apply(null, spans.map(r => r[0]));
      let hi = Math.max.apply(null, spans.map(r => r[1]));
      // "Rent 30 lakhs per annum" is ₹2.5 L a month — a commercial tenant's usual way of saying it.
      if (ANNUAL_SAID.test(s) && (mode === 'monthly' || (mode === 'lumpsum' && !leaseish) || (rentWord && mode !== 'sale'))) {
        lo = Math.round(lo / 12); hi = Math.round(hi / 12); mode = 'monthly';
      }
      const ranged = hi > lo * 1.02;
      // "Up to", "max", "kulla" (within) are ceilings, not flexibility.
      const flexible = /\b(?:around|approx|approximately|about|roughly|can\s*(?:go|stretch|extend)|flexible|negotiable|or\s*so|ish|kitta)\b/.test(s);
      const per = mode === 'monthly' ? ' a month' : '';
      // "Under 3 Cr", "max 2.5", "not more than", "kulla": a ceiling they drew themselves.
      const ceiling = /\b(?:under|below|max|maximum|up\s*to|upto|within|not\s*more\s*than|less\s*than|not\s*(?:to\s*)?exceed|kulla|no\s*more\s*than)\b/.test(s);
      // "Above 3 Cr", "minimum 2 Cr": a floor, not a ceiling. The ceiling is left generous — a buyer
      // who says "above 3" is telling us the segment, not their limit.
      if (!ranged && MIN_SAID.test(s)) {
        return { min: lo, max: Math.round(lo * 1.6), firm: false, flexible: true, mode, minOnly: true,
          stated: 'above ' + fmtMoney(lo) + per, src: t.src };
      }
      return {
        min: ranged ? lo : Math.round(lo * (mode === 'monthly' ? 0.75 : 0.7)),
        max: hi,
        firm: !ranged,
        flexible: flexible && !ceiling,
        ceiling,
        mode,
        stated: (ranged ? fmtMoney(lo) + ' – ' : '') + fmtMoney(hi) + per,
        src: t.src
      };
    }
    return null;
  }

  // ═══════ RENT OR BUY ═══════
  //
  // The first question of every match, and the one the engine never asked.
  // Read, in order of trust: the person saying they are open to both; the
  // AI's structured read of the whole chat (ai.want); the AI's intent; the
  // enquiry type; then the words of the requirement itself. "Currently
  // staying on rent" and "rental yield" are a buyer talking, not a tenant.
  const BOTH_DEAL = /\b(?:rent\s*(?:or|\/|and)\s*(?:buy|purchase|sale|own)|(?:buy|purchase|sale)\s*(?:or|\/|and)\s*rent|open\s*to\s*(?:both|rent(?:ing)?\s*(?:or|and)\s*buy(?:ing)?|buy(?:ing)?\s*(?:or|and)\s*rent(?:ing)?)|either\s*(?:rent|buy|to\s*rent|to\s*buy))\b/;
  const NOT_RENT_WANT = /\b(?:currently|presently|now)\s*(?:staying|living)?\s*(?:on|in|at)\s*(?:a\s*)?rent(?:ed)?(?:\s*house)?|paying\s*rent|rental\s*(?:yield|income|return|value)|rent\s*out|let\s*out|for\s*rental\s*income|rent\s*receivable|(?:current|present)\s*rent|rent\s*(?:currently|now|at\s*present)/g;
  const RENT_WANT = /\b(?:rent|rental|renting|tenant|tenancy|lease|leasing|to-?let)\b/;
  // "2 grounds land for sale in Choolaimedu", "villa for sale in ECR", "outright purchase": a buyer
  // describing what they want by how it is offered. Read here only from a requirement — a seller's
  // record never reaches readDeal (isBuyerLead keeps it out).
  const BUY_WANT = /\b(?:buy|buying|purchase|purchasing|to\s*own|investment|invest(?:ing|or)?|resale|new\s*booking|book\s*(?:a|the)\s*(?:flat|villa|plot|unit)|home\s*loan|for\s*sale|on\s*sale|outright|ownership)\b/;

  // The question every bot asks — "buy, rent or sell?" — is not an answer to it.
  const DEAL_QUESTION = /\b(?:buy|purchase)\s*[,\/]?\s*(?:or\s*)?rent\s*[,\/]?\s*(?:or\s*)?(?:sell|sale)\b|\b(?:buy|rent|sell)\s*\/\s*(?:buy|rent|sell)\s*\/\s*(?:buy|rent|sell)\b/g;
  function readDeal(lead, texts, want) {
    const said = texts.filter(t => REQ_SRC.test(t.src) || /Conversation|latest ask|Note|AI evidence|AI summary|Budget/.test(t.src));
    const all = fold(said.map(t => t.text).join(' \n ')).replace(DEAL_QUESTION, ' ');
    // Open to both only on their own word (the requirement fields, the team's notes, their last
    // ask) — an AI summary saying "not stated whether rent or buy" is not that.
    const own = fold(texts.filter(t => REQ_SRC.test(t.src) || /latest ask|Note|Budget/.test(t.src)).map(t => t.text).join(' \n ')).replace(DEAL_QUESTION, ' ');
    if (BOTH_DEAL.test(own)) return { values: ['sale', 'rent'], why: 'they have said so', src: 'their own words' };
    // A joint venture, in their own words. "JV or outright" keeps both doors open.
    if (JV_RE.test(own)) {
      const alsoBuy = /\b(?:outright|or\s*(?:buy|purchase|sale)|(?:buy|purchase)\s*or)\b/.test(own);
      return { values: alsoBuy ? ['jv', 'sale'] : ['jv'], why: alsoBuy ? 'they want a joint venture or an outright purchase' : 'they want a joint venture', src: 'their own words' };
    }
    if (want && want.deal && want.deal !== 'unknown') {
      if (want.deal === 'either') return { values: ['sale', 'rent'], why: 'the AI’s read of their chat', src: 'AI read of the chat' };
      if (want.deal === 'buy') return { values: ['sale'], why: 'the AI’s read of their chat', src: 'AI read of the chat' };
      if (want.deal === 'rent' || want.deal === 'lease') return { values: ['rent'], why: 'the AI’s read of their chat', src: 'AI read of the chat' };
    }
    const intent = lead.ai && lead.ai.intent;
    if (intent === 'rent') return { values: ['rent'], why: 'the AI’s read of their chat', src: 'AI intent' };
    if (intent === 'buy' || intent === 'invest') return { values: ['sale'], why: 'the AI’s read of their chat', src: 'AI intent' };
    if (/rent|lease|tenant/i.test(String(lead.enquiryType || ''))) return { values: ['rent'], why: `the enquiry type, ${lead.enquiryType}`, src: 'Enquiry type' };
    const clean = all.replace(NOT_RENT_WANT, ' ');
    const r = RENT_WANT.test(clean), b = BUY_WANT.test(clean);
    if (r && !b) return { values: ['rent'], why: 'their requirement, which talks about renting', src: 'their own words' };
    if (b && !r) return { values: ['sale'], why: 'their requirement, which talks about buying', src: 'their own words' };
    return null;
  }

  // A property is for sale unless it plainly says otherwise — the name ("… for Rent", "(RENT)",
  // "Corporate Lease"), the availability ("Available for Rent"), or a price quoted by the month.
  const PROP_RENT = /\b(?:for\s*rent|for\s*lease|on\s*rent|on\s*lease|to\s*let|to-let|corporate\s*lease|lease\s*(?:only|basis)|rental\s*(?:flat|house|home|apartment|unit|property)(?!\s*income))\b|\(\s*rent\s*\)/;
  // "1.2 Cr, rental income 40k per month", "pre-leased, rent 1.5L/month": a property sold WITH a
  // tenant. The rent is its income, and it is for sale.
  const INCOME = /\b(?:rental\s*income|income|yield|returns?|pre\s*-?\s*leased|tenanted|already\s*(?:rented|leased)|leased\s*out|roi)\b/;
  function propertyDeal(p, rentSpans, saleSpans) {
    const d = String(p.dealType || '').toLowerCase();
    if (d === 'rent' || d === 'sale') return d;
    const head = fold([p.name, p.availability, p.type, p.propertyType, p.status].filter(Boolean).join(' | '));
    if (PROP_RENT.test(head)) return 'rent';
    const price = fold([p.startingPrice, p.price].filter(Boolean).join(' '));
    // "Rent: ₹6 lakh per month": a price that says it is the rent, or is quoted by the month, is a
    // rental however big it is — unless it is the rental income of a property being sold.
    if (/^\s*rent\b|\b(?:per\s*month|\/\s*month|p\.?\s*m\b|monthly|a\s*month)\b/.test(price) && !INCOME.test(price + ' ' + head)) return 'rent';
    // A big figure is a sale price, unless it is the deposit or advance on a rental.
    const sold = (saleSpans || []).some(r => r[1] >= 5 * LAKH)
      && ((!/\b(?:deposit|advance)\b/.test(price) && !LEASEISH.test(price)) || INCOME.test(price + ' ' + head));
    if (sold) return 'sale';
    if (/\brent\b/.test(price) || rentSpans.length || LEASEISH.test(price)) return 'rent';
    // "Rs 35,000 + 3L advance": a monthly figure beside a deposit is a rental.
    if (/\b(?:deposit|advance)\b/.test(price) && /\b\d{2}[,.]?\d{3}\b/.test(price)) return 'rent';
    return 'sale';
  }

  const DEAL_LABEL = { sale: 'for sale', rent: 'for rent', jv: 'for a joint venture' };

    // BHK. Read only from the texts a requirement is actually stated in — a
  // note saying "showed him the 2BHK, he wants 3" would otherwise make both
  // counts look wanted. The search engine's extractor handles "2, 3 & 4 BHK"
  // and refuses to read "4 Apartments (3BHK each)" as four configs.
  function readBhk(texts) {
    const REQ = /Property \/ Locality|Requirement|Preferred location|TailorTalk locality|Ad form|Intent|AI read of the chat/;
    const pick = list => {
      for (const t of list) {
        // "2 or 3 BHK", "2/3 BHK", "2 to 3 BHK": both counts, as "2, 3 BHK" says it to the extractor.
        const b = S().extractBhk(String(t.text).replace(/\b(\d)\s*(?:or|\/|to|-|&|and)\s*(\d)\s*bhk/gi, '$1, $2 BHK'));
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
    // "land" on its own is a want for land ("4 grounds land for JV", "industrial land in Oragadam")
    // — but never "land area", "landlord", "landmark" or "land owner", which are about something else.
    { type: 'Plot', re: /\b(?:plot|plots|vacant\s*land|open\s*land|dtcp\s*(?:plot|layout)|approved\s*layout|(?:plot|land)\s*layout|land\s*(?:for\s*sale|parcel)|lands|land(?!\s*(?:area|lord|owner|mark|line|scape|ed\b)))\b/ },
    { type: 'Villa', re: /\b(?:villa|villas|town\s*house|townhouse|row\s*house|duplex\s*villa)\b/ },
    { type: 'House', re: /\b(?:independent\s*house|individual\s*house|separate\s*house|own\s*house)\b/ },
    // "office" alone is not here: "a 2BHK near my office" is a home buyer. Only the phrasings that
    // mean office SPACE count.
    { type: 'Commercial', re: /\b(?:commercial|office\s*(?:space|premises|unit|floor|for\s*(?:rent|lease|sale))|offices|shop|shops|showroom|show\s*room|retail|warehouse|godown|it\s*office|it\s*space|factory|industrial\s*(?:shed|building|unit|space)|restaurant|hotel|co\s*-?\s*working|bare\s*shell|business\s*space)\b/ },
    { type: 'Apartment', re: /\b(?:apartment|apartments|flat|flats|condo)\b/ }
  ];

  // Same discipline as readBhk and readLocalities: what a buyer WANTS is read
  // from the texts a requirement is stated in, and only from a note if none
  // of those say anything. A note is a record of what happened ("showed him
  // the plot in Mambakkam, he wants a flat") and mining a want out of it
  // reliably gets the want backwards.
  const REQ_SRC = /Property \/ Locality|Requirement|Preferred location|TailorTalk locality|Ad form|Intent|Enquiry type|AI read of the chat|Reviewed requirement/;

  // ═══════ WHAT KIND, WITHIN THE KIND ═══════
  //
  // Five types are not enough to keep a matcher honest. An office and a showroom are both
  // "Commercial", and a retail tenant shown an office floor is not being listened to; an industrial
  // land buyer and a family wanting a house plot are both "Plot", and they never want the same
  // land. The sub-kind is read the same way on both sides — first match wins, so "restaurant space"
  // is hospitality and not retail — and an unknown sub-kind on either side costs nothing: only two
  // KNOWN, different sub-kinds are a mismatch.
  const SUBTYPES = [
    { type: 'Plot', sub: 'industrial_land', label: 'industrial land', re: /\bindustrial\s*(?:land|plot|site|park\s*land)s?\b|\bsipcot\s*(?:land|plot)s?\b/ },
    { type: 'Plot', sub: 'agri_land', label: 'agricultural land', re: /\b(?:agri(?:cultural|culture)?|farm|farming|paddy|wet|dry)\s*(?:land|lands|plot)s?\b|\bfarm\s*land\b/ },
    { type: 'Plot', sub: 'commercial_land', label: 'commercial land', re: /\bcommercial\s*(?:land|plot|site|property\s*land)s?\b/ },
    { type: 'Plot', sub: 'res_plot', label: 'residential plot', re: /\bresidential\s*(?:land|plot|site|layout)s?\b|\b(?:house|villa|individual)\s*(?:plot|site)s?\b|\b(?:dtcp|cmda)\s*(?:approved\s*)?(?:plot|layout)s?\b|\bgated\s*(?:community\s*)?(?:plot|layout)s?\b|\bplots?\s*in\s*(?:a\s*)?gated\b/ },
    { type: 'Commercial', sub: 'warehouse', label: 'warehouse', re: /\b(?:warehouse|warehousing|godown|go\s*down|logistics\s*park|storage\s*space)s?\b/ },
    { type: 'Commercial', sub: 'industrial', label: 'industrial shed / factory', re: /\b(?:industrial\s*(?:shed|building|unit|space|property)|factory|manufacturing\s*unit|sheds?)\b/ },
    { type: 'Commercial', sub: 'hospitality', label: 'hotel / restaurant', re: /\b(?:hotel|restaurant|cafe|hospitality|resort|service\s*apartment|guest\s*house|lodge|banquet|food\s*court|cloud\s*kitchen)s?\b/ },
    { type: 'Commercial', sub: 'coworking', label: 'co-working', re: /\bco\s*-?\s*working\b|\bshared\s*office\b|\bplug\s*(?:and|&|n)\s*play\b|\bmanaged\s*office\b/ },
    { type: 'Commercial', sub: 'retail', label: 'retail / showroom', re: /\b(?:retail|showroom|show\s*room|shop|shops|store|outlet|high\s*street|frontage)\b/ },
    { type: 'Commercial', sub: 'office', label: 'office space', re: /\b(?:office|offices|it\s*space|workspace|work\s*space|corporate\s*space)\b/ },
    { type: 'Commercial', sub: 'building', label: 'whole commercial building', re: /\b(?:commercial|entire|whole|independent|full|individual)\s*building\b|\bbuilding\s*for\s*(?:lease|rent|sale)\b/ }
  ];
  const SUB_LABEL = Object.fromEntries(SUBTYPES.map(x => [x.sub, x.label]));
  function subtypeOf(text, type) {
    const s = fold(text);
    if (!s || !type) return null;
    for (const x of SUBTYPES) if (x.type === type && x.re.test(s)) return x.sub;
    return null;
  }
  // How near two KNOWN sub-kinds are: 1 same, a fraction for a real alternative, 0 for a
  // different market altogether (a veto). Symmetric; anything not listed is 0.3 — unlike, but not
  // impossible.
  const SUB_NEAR = {
    'office|coworking': 0.8, 'office|building': 0.6, 'retail|building': 0.6, 'retail|hospitality': 0.55,
    'office|retail': 0.25, 'hospitality|building': 0.5, 'coworking|building': 0.4,
    'warehouse|industrial': 0.8, 'warehouse|building': 0.3, 'industrial|building': 0.3,
    'warehouse|office': 0, 'warehouse|retail': 0, 'warehouse|hospitality': 0, 'warehouse|coworking': 0,
    'industrial|office': 0, 'industrial|retail': 0, 'industrial|hospitality': 0, 'industrial|coworking': 0,
    'res_plot|commercial_land': 0.45, 'res_plot|agri_land': 0.3, 'res_plot|industrial_land': 0,
    'industrial_land|commercial_land': 0.5, 'industrial_land|agri_land': 0.35, 'commercial_land|agri_land': 0.3
  };
  function subNear(a, b) {
    if (!a || !b) return null;
    if (a === b) return 1;
    const v = SUB_NEAR[a + '|' + b] != null ? SUB_NEAR[a + '|' + b] : SUB_NEAR[b + '|' + a];
    return v == null ? 0.3 : v;
  }

  // A joint venture / joint development: the landowner contributes the land, a builder the
  // construction, and they share the built-up area. It is its own deal — a JV developer is not a
  // buyer at a lower price, and a landowner selling outright has not offered a JV.
  const JV_RE = /\b(?:joint\s*venture|jv|j\s*v|joint\s*development|jd|jda|development\s*agreement|land\s*owner\s*share|landowner\s*share|built\s*-?\s*up\s*share|revenue\s*shar(?:e|ing)|area\s*shar(?:e|ing))\b/;

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
    if (found) {
      const srcText = (texts.find(t => t.src === found.src) || {}).text || '';
      // "commercial land" / "industrial land" is land: the word commercial says what kind.
      const landSub = subtypeOf(srcText, 'Plot');
      if (found.values.includes('Plot') && landSub && landSub !== 'res_plot') found.values = found.values.filter(v => v !== 'Commercial');
      // A bedroom count is a home. "Commercial" beside it ("2BHK near the commercial area") is not
      // a request for a shop, unless nothing residential is named at all.
      if (bhk && bhk.values.length && found.values.length > 1) found.values = found.values.filter(v => v !== 'Commercial');
      const subs = {};
      found.values.forEach(v => { const sb = subtypeOf(srcText, v); if (sb) subs[v] = sb; });
      found.subs = subs;
      return found;
    }
    // No type word anywhere, but a BHK was asked for: residential, unspecified.
    if (bhk && bhk.values.length) return { values: ['Apartment', 'Villa', 'House'], residentialOnly: true, src: bhk.src };
    return null;
  }

  // Localities, via the gazetteer in chennai-geo.js. Read from the stated
  // requirement first; `firm` records whether the buyer named the area
  // themselves, because that is what licenses a distance veto.
  // ═══════ PLACES THEY RULED OUT ═══════
  //
  // "Not interested in Mogappair. Looking at MRC Nagar, RA Puram and Poes Garden." Read naively,
  // that is four places they want — and Mogappair, the one they refused, came out top. Every
  // place named after a refusal (up to the end of that clause) is an exclusion, and so is a place
  // followed by the Tamil "vendam". Exclusions are taken from every text a person wrote or said —
  // the requirement, the notes, the chat summary — but never from a description of a property.
  const EXCL_CUE = /\b(?:not\s*(?:interested|keen|ok|okay|happy)\s*(?:in|on|with|about)|no\s*interest\s*in|uninterested\s*in|excluding|exclude|excluded|except(?:\s*for)?|other\s*than|apart\s*from|anything\s*but|but\s*not|avoid(?:ing)?|(?:do\s*not|don'?t|doesn'?t|does\s*not|did\s*not|didn'?t|won'?t|will\s*not)\s*(?:want|like|prefer|consider)|not\s*(?:in|near|at|around|looking\s*(?:at|in))|rul(?:e|ed|ing)\s*out|rejected|dislikes?|no\s*to)\b/g;
  const EXCL_END = /[.;!?\n]|\b(?:but|looking|look|want|wants|prefer|prefers|preferred|need|needs|only|interested|show|considering|ok\s*with|fine\s*with|budget|however)\b/;
  const VENDAM = /([a-z][a-z .]{2,40}?)\s*(?:-|,)?\s*(?:vendam|venda|vaendam|vendaam|beda|venam\s*illa)\b/g;
  const NOT_WANT_SRC = /Properties discussed|Ad they replied to/;
  const BARE_NOT = /\b(?:not|no|except|avoid)\s+([a-z][a-z .]{2,40})/g;
  function readExclusions(texts) {
    const geo = G();
    const keys = [], quotes = [];
    const add = (frag, quote) => {
      const found = geo.resolveLoose ? geo.resolveLoose(frag).map(x => x.key) : geo.resolveAll(frag);
      let hit = false;
      for (const k of found) if (!keys.includes(k)) { keys.push(k); hit = true; }
      if (hit && quotes.length < 3) quotes.push(quote.length > 120 ? quote.slice(0, 117) + '…' : quote);
    };
    for (const t of texts) {
      if (NOT_WANT_SRC.test(t.src)) continue;
      const s = fold(t.text);
      EXCL_CUE.lastIndex = 0;
      let m;
      while ((m = EXCL_CUE.exec(s))) {
        let frag = s.slice(m.index + m[0].length, m.index + m[0].length + 90);
        const stop = frag.search(EXCL_END);
        if (stop > 0) frag = frag.slice(0, stop);
        else if (stop === 0) continue;
        add(frag, t.text.trim());
      }
      VENDAM.lastIndex = 0;
      while ((m = VENDAM.exec(s))) add(m[1].split(/[,.;]/).pop(), t.text.trim());
      // A bare "not Mogappair" / "no OMR": only when what follows is a place and nothing else (a
      // few words, no number) — "not more than 3 Cr in Velachery" is not a refusal of Velachery.
      BARE_NOT.lastIndex = 0;
      while ((m = BARE_NOT.exec(s))) {
        const frag = m[1].split(/[,.;!?\n]|\b(?:and|or|but|budget)\b/)[0].trim();
        if (!frag || /\d/.test(frag) || frag.split(/\s+/).length > 4) continue;
        const found = geo.resolveLoose ? geo.resolveLoose(frag) : [];
        if (found.length && found.every(f => !f.fuzzy || frag.length >= 6)) add(frag, t.text.trim());
      }
    }
    return keys.length ? { keys, quotes } : null;
  }

  // Does a property sit in a place they ruled out? In it, or inside it (a block of Anna Nagar), or
  // within a kilometre of its centre — a place they refused does not become acceptable across the
  // road.
  function excludedHit(r, p, ctx) {
    const ex = r.localities && r.localities.exclude;
    if (!ex || !ex.length || !p.localities || !p.localities.length) return null;
    const geo = G(), area = ctx && ctx.area;
    for (const bad of ex) {
      for (const h of p.localities) {
        if (h === bad) return { bad, km: 0 };
        const pr = area ? area.proximity(h, bad) : null;
        if (pr && (pr.basis === 'same' || pr.basis === 'contains')) return { bad, km: 0 };
        const km = geo.distanceKm(h, bad);
        if (km != null && km <= 1) return { bad, km };
      }
    }
    return null;
  }

  // "Anywhere in Chennai", "any area in Chennai", or a requirement whose only place is the city:
  // a stated answer (the whole city is fine), not a missing one.
  // "Central Chennai", "South Chennai", "north side": one of the four zones the inventory's Zone
  // column uses — a real answer, narrower than the city, wider than a locality.
  const ZONE_SAID = [
    ['Chennai Central', /\b(?:central\s*chennai|chennai\s*central|city\s*centre|city\s*center|heart\s*of\s*(?:the\s*)?city)\b/],
    ['Chennai North', /\b(?:north\s*chennai|chennai\s*north|north\s*side)\b/],
    ['Chennai South', /\b(?:south\s*chennai|chennai\s*south|south\s*side)\b/],
    ['Chennai West', /\b(?:west\s*chennai|chennai\s*west|west\s*side)\b/]
  ];
  const ANYWHERE = /\b(?:any\s*where|anywhere|any\s*(?:area|location|locality|place|part)|all\s*over|across)\b[^.\n]{0,20}\bchennai\b|\b(?:in|within|around)\s*chennai\b|^\s*chennai\s*$|\bchennai\s*city\b|\bany\s*(?:area|location|locality|decent\s*location)\b|\bchennai\b/;

  function readLocalities(texts) {
    const geo = G();
    const REQ = /Property \/ Locality|Preferred location|Requirement|TailorTalk locality|Ad form|AI read of the chat|Reviewed requirement/;
    const excluded = readExclusions(texts);
    const ex = excluded ? excluded.keys : [];
    // Requirement text is read with spelling slips allowed ("anna nagr"); a note only exactly.
    const scan = (list, loose) => {
      const keys = [];
      let src = null, fuzzy = [];
      for (const t of list) {
        const found = loose && geo.resolveLoose ? geo.resolveLoose(t.text) : geo.resolveAll(t.text).map(key => ({ key, fuzzy: false }));
        for (const f of found) {
          if (ex.includes(f.key) || keys.includes(f.key)) continue;
          keys.push(f.key); src = src || t.src;
          if (f.fuzzy) fuzzy.push({ key: f.key, said: f.said });
        }
        if (keys.length) break;
      }
      return keys.length ? { keys, src, fuzzy } : null;
    };
    // A named corridor ("anywhere on OMR", "ECR side") is a different kind of
    // answer from a locality and has to survive as one — the alias table
    // resolves it to a single representative point, which is right for
    // placing a property and wrong for reading a brief.
    const CORRIDOR_SAID = [
      ['OMR', /\b(?:omr|old\s*mahabalipuram\s*road|rajiv\s*gandhi\s*salai|it\s*(?:corridor|highway))\b/],
      ['ECR', /\b(?:ecr|east\s*coast\s*road)\b/],
      ['GST', /\b(?:gst\s*road|grand\s*southern\s*trunk|nh\s*?45)\b/],
      ['Radial Road', /\bradial\s*road\b/],
      ['Mount-Poonamallee', /\bmount\s*-?\s*poonamallee\b/],
      ['Velachery-Tambaram', /\bvelachery\s*-?\s*tambaram\b/]
    ];
    const allText = fold(joinTexts(texts));
    const corridors = CORRIDOR_SAID.filter(([, re]) => re.test(allText)).map(([k]) => k);

    const reqTexts = texts.filter(t => REQ.test(t.src));
    // "Anything within 5 km of Adyar": a radius the location score honours.
    const rad = fold(reqTexts.map(t => t.text).join(' ')).match(/\bwithin\s*(\d{1,2}(?:\.\d)?)\s*(?:km|kms|kilomet)/);
    const radiusKm = rad ? Number(rad[1]) : null;
    const firm0 = scan(reqTexts, true);
    const firm = firm0 && radiusKm ? Object.assign(firm0, { radiusKm }) : firm0;
    if (firm) return { keys: firm.keys, firm: true, src: firm.src, corridors, exclude: ex, excludeQuotes: excluded ? excluded.quotes : [], fuzzy: firm.fuzzy, radiusKm: firm.radiusKm || null };
    const loose = scan(texts, false);
    if (loose) return { keys: loose.keys, firm: false, src: loose.src, corridors, exclude: ex, excludeQuotes: excluded ? excluded.quotes : [], fuzzy: [] };
    // A brief that names ONLY a corridor still states a location.
    if (corridors.length) {
      const geo = G();
      const keys = corridors.flatMap(c => (geo.CORRIDOR_MEMBERS[c] || []).slice(0, 1));
      return { keys, firm: false, src: 'corridor', corridors, exclude: ex, excludeQuotes: excluded ? excluded.quotes : [], fuzzy: [] };
    }
    const zoneText = fold(reqTexts.map(t => t.text).join(' \n '));
    const zones = ZONE_SAID.filter(([, re]) => re.test(zoneText)).map(([z]) => z);
    if (zones.length) return { keys: [], zones, firm: true, src: (reqTexts[0] || {}).src || 'their words', corridors: [], exclude: ex, excludeQuotes: excluded ? excluded.quotes : [], fuzzy: [] };
    const anyText = reqTexts.find(t => ANYWHERE.test(fold(t.text)));
    if (anyText || ex.length) {
      return { keys: [], anywhere: !!anyText, firm: !!anyText, src: anyText ? anyText.src : 'their exclusions', corridors: [], exclude: ex, excludeQuotes: excluded ? excluded.quotes : [], fuzzy: [] };
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
  // A deadline is kept to the month ("by March 2027", "within 6 months",
  // "next year"), because a family moving for a school year cannot take a
  // flat that hands over in the June after.
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTH_YEAR = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s*,?\s*(20\d\d|['’]\d\d)\b/;
  const monthEnd = (y, m) => Date.UTC(y, m + 1, 0, 12);

  // A month and year out of a property's possession text ("Dec 2026", "Possession: March 2027",
  // "Q2 2027"), as the last day of that month; a bare year is its December.
  function readWhen(text) {
    const s = fold(text);
    if (!s) return null;
    const my = s.match(MONTH_YEAR);
    if (my) {
      const y = my[2].length === 3 ? 2000 + Number(my[2].slice(1)) : Number(my[2]);
      return monthEnd(y, MONTHS.indexOf(my[1].slice(0, 3)));
    }
    const q = s.match(/\bq([1-4])\s*[,'’-]?\s*(20\d\d)\b/);
    if (q) return monthEnd(Number(q[2]), Number(q[1]) * 3 - 1);
    const y = s.match(/\b(20[2-4]\d)\b/);
    return y ? monthEnd(Number(y[1]), 11) : null;
  }

  function readPossession(texts, now) {
    const t0 = now || Date.now();
    // Their own requirement only. A summary saying "asked whether handover before December 2029
    // is possible" is a question, not a deadline.
    for (const t of texts.filter(x => WANT_SRC.test(x.src))) {
      const s = fold(t.text);
      if (/\b(?:ready\s*to\s*move|rtm|immediate|immediately|shift\s*(?:now|soon)|move\s*in\s*(?:now|soon)|occupation\s*ready|need\s*it\s*now|urgent)\b/.test(s)) {
        return { want: 'ready', src: t.src };
      }
      if (/\b(?:under\s*construction|new\s*launch|pre\s*launch|prelaunch|booking\s*stage|payment\s*plan|construction\s*linked)\b/.test(s)) {
        return { want: 'upcoming', src: t.src };
      }
      const said = t.at || t0;
      const within = s.match(/\bwithin\s*(?:the\s*next\s*)?(\d{1,2})\s*months?\b/);
      if (within) {
        const d = new Date(said); d.setUTCMonth(d.getUTCMonth() + Number(within[1]));
        return { want: 'by', at: d.getTime(), label: `within ${within[1]} months`, src: t.src };
      }
      if (/\b(?:possession|handover|move|shift|ready)\b[^.]{0,30}\bnext\s*year\b|\bnext\s*year\b[^.]{0,30}\b(?:possession|handover|move|shift)\b/.test(s)) {
        const y = new Date(said).getUTCFullYear() + 1;
        return { want: 'by', at: monthEnd(y, 11), label: `by the end of ${y}`, src: t.src };
      }
      const near = s.match(/\b(?:possession|handover|hand\s*over|ready|move\s*in|shift(?:ing)?|need(?:ed)?\s*(?:it\s*)?by|required\s*by)\b[^.]{0,30}/);
      if (near) {
        const at = readWhen(near[0]);
        if (at) return { want: 'by', at, label: fmtMonth(at), src: t.src };
      }
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
    // "New or resale", "open to resale": both, which is no preference at all.
    const eitherSale = /\b(?:new\s*(?:or|\/|and)\s*(?:resale|re-sale)|(?:resale|re-sale)\s*(?:or|\/|and)\s*new|open\s*to\s*(?:resale|re-sale)|resale\s*(?:also|too)\s*(?:ok|fine))\b/.test(all);
    if (eitherSale) { /* no preference */ }
    else if (/\b(?:resale|re-sale|second\s*(?:hand|owner))\b/.test(all)) out.saleType = 'Resale';
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

  // ── What they asked for by name ──
  //
  // The things a family raises in the chat and an agent forgets by the third
  // call: a pooja room, a school nearby, covered parking, a lift for the
  // parents. Each is read from the buyer's words (and the AI's read of the
  // chat), never from a description of a property they were sent, and each
  // is checked against the property in three states: has it, plainly does
  // not, or not on record — which is a question to ask, not a no.
  const SPECS = [
    { key: 'pooja', label: 'Pooja room', want: /\b(?:pooja|puja|prayer)\s*(?:room|space|area|corner|shelf)\b/, have: /\b(?:pooja|puja|prayer)\b/ },
    { key: 'servant', label: "Servant's room", want: /\b(?:servant|maid|helper|house\s*help)(?:'?s)?\s*(?:room|quarters?)\b/, have: /\b(?:servant|maid|helper)(?:'?s)?\s*(?:room|quarters?)\b/ },
    { key: 'study', label: 'Study / home office', want: /\b(?:study\s*room|home\s*office|work\s*from\s*home\s*(?:room|space)|office\s*room)\b/, have: /\b(?:study|home\s*office)\b/ },
    { key: 'balcony', label: 'Balcony', want: /\bbalcon(?:y|ies)\b/, have: /\bbalcon(?:y|ies)\b/ },
    { key: 'terrace', label: 'Terrace', want: /\b(?:private\s*|open\s*)?terrace\b/, have: /\bterrace\b/ },
    { key: 'parking', label: 'Covered car parking', want: /\b(?:covered|stilt|basement|closed|reserved)\s*(?:car\s*)?park(?:ing)?\b|\bcar\s*park(?:ing)?\b/, have: null },
    { key: 'twoParking', label: 'Two car parks', want: /\b(?:2|two)\s*(?:car\s*)?park(?:ing)?s?\b|\b(?:2|two)\s*cars?\b/, have: null },
    { key: 'lift', label: 'Lift', want: /\b(?:lift|elevator)\b/, have: /\b(?:lifts?|elevators?)\b/ },
    { key: 'power', label: 'Power backup', want: /\b(?:power\s*back\s*-?\s*up|generator|dg\s*set)\b/, have: /\b(?:power\s*back\s*-?\s*up|generator|dg\s*(?:set|back\s*-?\s*up)|100\s*%\s*back\s*-?\s*up)\b/ },
    { key: 'gated', label: 'Gated community', want: /\bgated\b/, have: /\bgated\b/ },
    { key: 'security', label: '24×7 security', want: /\b(?:24\s*[x×*]\s*7\s*security|security\s*guard|cctv|watchman|safe\s*(?:area|locality|for\s*family))\b/, have: /\b(?:security|cctv|watchman|guard)\b/ },
    { key: 'pool', label: 'Swimming pool', want: /\b(?:swimming\s*)?pool\b/, have: /\b(?:swimming\s*)?pool\b/ },
    { key: 'gym', label: 'Gym', want: /\b(?:gym|gymnasium|fitness\s*cent(?:er|re))\b/, have: /\b(?:gym|gymnasium|fitness)\b/ },
    { key: 'clubhouse', label: 'Clubhouse', want: /\bclub\s*house\b/, have: /\bclub\s*house\b/ },
    { key: 'play', label: "Children's play area", want: /\b(?:play\s*(?:area|ground)|kids'?\s*(?:play|area))\b/, have: /\b(?:play\s*(?:area|ground)|kids'?\s*(?:play|area)|tot\s*lot)\b/ },
    { key: 'school', label: 'A school nearby', near: true, want: /\b(?:schools?|vidyalaya|matric(?:ulation)?|cbse|icse)\b/, have: /\b(?:schools?|vidyalaya|vidhyalaya|matric(?:ulation)?|cbse|icse|academy|dav|psbb|chettinad\s*vidyashram|velammal)\b/ },
    { key: 'hospital', label: 'A hospital nearby', near: true, want: /\b(?:hospitals?|medical\s*(?:care|facilit)|clinic)\b/, have: /\b(?:hospitals?|clinic|apollo|kauvery|fortis|miot|sims|gleneagles|prashanth|medical)\b/ },
    { key: 'metro', label: 'Metro / train nearby', near: true, want: /\b(?:metro|railway\s*station|train|mrts|local\s*train)\b/, have: /\b(?:metro|railway|train|mrts)\b/ },
    { key: 'temple', label: 'A temple nearby', near: true, want: /\b(?:temples?|kovil|koil)\b/, have: /\b(?:temples?|kovil|koil|mandir)\b/ },
    { key: 'market', label: 'Shops nearby', near: true, want: /\b(?:super\s*market|supermarket|grocery|shopping|market\s*nearby|mall)\b/, have: /\b(?:market|supermarket|super\s*market|mall|shopping|grocery)\b/ },
    { key: 'itpark', label: 'Close to the IT parks', near: true, want: /\b(?:it\s*park|tech\s*park|tidel|sipcot|close\s*to\s*(?:my\s*)?office|near\s*(?:my\s*)?office)\b/, have: /\b(?:it\s*park|tech\s*park|tidel|sipcot|it\s*corridor)\b/ },
    { key: 'pets', label: 'Pets allowed', want: /\b(?:pets?|dog|pet\s*friendly)\b/, have: /\bpets?\b/ },
    { key: 'furnished', label: 'Furnished', want: /\b(?:semi\s*-?\s*furnished|fully\s*-?\s*furnished|furnished)\b/, have: null },
    { key: 'independent', label: 'Independent / standalone', want: /\b(?:independent\s*(?:house|villa|building)|standalone|individual\s*house|no\s*common\s*wall)\b/, have: null },
    { key: 'corner', label: 'Corner unit', want: /\bcorner\s*(?:unit|plot|house|flat)\b/, have: null },
    // Commercial asks (Nov 2026). A retail tenant's first three questions are frontage, parking and
    // ceiling height, and none of them had a name here.
    { key: 'anyParking', label: 'Parking', want: /(?<!car\s)(?<!covered\s)(?<!stilt\s)(?<!basement\s)\bparking\b(?!\s*(?:is\s*)?(?:not|no)\b)/, have: /\b(?:parking|car\s*park)\b/ },
    { key: 'frontage', label: 'Road frontage', want: /\b(?:frontage|road\s*facing|main\s*road\s*facing|facing\s*the\s*main\s*road|visibility)\b/, have: /\b(?:frontage|main\s*road\s*facing|road\s*facing|on\s*(?:the\s*)?main\s*road)\b/ },
    { key: 'ceiling', label: 'Ceiling height', want: /\b(?:ceiling\s*height|high\s*ceiling|double\s*height)\b/, have: /\b(?:ceiling\s*height|high\s*ceiling|double\s*height|\d{2}\s*(?:ft|feet)\s*(?:clear\s*)?height)\b/ },
    { key: 'washroom', label: 'Washrooms', want: /\b(?:washrooms?|restrooms?|toilets?)\b/, have: /\b(?:washrooms?|restrooms?|toilets?)\b/ },
    { key: 'threePhase', label: 'Three-phase power', want: /\b(?:3|three)\s*-?\s*phase\b/, have: /\b(?:3|three)\s*-?\s*phase\b/ }
  ];
  // A must-have none of the names above covers ("near my daughter's school in Kilpauk", "terrace
  // garden", "EV charging"): still an ask. Checked word for word against the property — every
  // telling word present is a "has", otherwise it is "not on record", never a "no".
  const ASK_STOP = new Set(['with', 'near', 'nearby', 'have', 'must', 'should', 'need', 'needs', 'good', 'some', 'want', 'from', 'into', 'that', 'this', 'than', 'only', 'very', 'more', 'less', 'also', 'like', 'prefer', 'preferably', 'required']);
  function otherAskHas(ask, p) {
    const toks = plain(ask).split(' ').filter(w => w.length >= 4 && !ASK_STOP.has(w));
    if (!toks.length) return null;
    const txt = p.specText || '';
    const hits = toks.filter(w => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w{0,3}\\b').test(txt)).length;
    return hits === toks.length ? 1 : null;
  }
  const SPEC_BY_KEY = Object.fromEntries(SPECS.map(x => [x.key, x]));
  // "no need of a pooja room", "lift not required" — the ask turned down, not made.
  const SPEC_NEG_BEFORE = /\b(?:no|not|don'?t|doesn'?t|without|no\s*need\s*(?:of|for)?)\s+(?:\w+\s+){0,2}$/;
  const SPEC_NEG_AFTER = /^\s*(?:\w+\s+){0,2}(?:not\s*(?:needed|required|necessary|mandatory|a\s*must)|is\s*not\s*(?:needed|required)|illa|vendam)\b/;
  // Phrases that contain a spec word and mean something else entirely.
  const SPEC_NOISE = /\bsecurity\s*(?:deposit|advance|amount)\b|\bpool(?:ing)?\s*(?:money|funds)\b|\bschool\s*(?:fees?|holidays?|timings?|reopen\w*)\b|\bafter\s*(?:office|school)\b/g;

  // The sources a want can be read from. A description of a property they were sent (what was
  // discussed, the ad they replied to) is not a want.
  const WANT_SRC = /Property \/ Locality|Requirement|Preferred location|TailorTalk locality|Ad form|latest ask|Note|AI read of the chat/;

  function readSpecs(texts, want) {
    const out = [];
    const src = texts.filter(t => WANT_SRC.test(t.src)).map(t => t.text);
    if (want && Array.isArray(want.must_have)) src.push(...want.must_have);
    const all = src.map(x => fold(x).replace(SPEC_NOISE, ' ')).join(' \n ');
    for (const sp of SPECS) {
      const re = new RegExp(sp.want.source, 'g');
      let m, asked = false;
      while ((m = re.exec(all))) {
        const before = all.slice(Math.max(0, m.index - 28), m.index);
        const after = all.slice(m.index + m[0].length, m.index + m[0].length + 32);
        if (SPEC_NEG_BEFORE.test(before) || SPEC_NEG_AFTER.test(after)) continue;
        // "facing a hospital", "opposite the temple" — a complaint about what is next door.
        if (sp.near && /\b(?:facing|opposite|opp|overlooking|next\s*to|beside|behind)\s+(?:a\s+|the\s+|an\s+)?$/.test(before)) continue;
        asked = true; break;
      }
      if (asked) out.push(sp.key);
    }
    // A must-have the AI heard that none of the table's names covers is still an ask — shown
    // as something to check, never scored.
    if (out.includes('parking') || out.includes('twoParking')) { const i = out.indexOf('anyParking'); if (i !== -1) out.splice(i, 1); }
    const asks = (want && Array.isArray(want.must_have) ? want.must_have.slice() : []);
    // "Must have X, Y" in a reviewed requirement or a typed brief.
    texts.filter(t => WANT_SRC.test(t.src) || /Reviewed requirement|Typed/.test(t.src)).forEach(t => {
      const m = fold(t.text).match(/\bmust\s*(?:have|haves?|need)\s*:?\s*([^.\n]{3,160})/);
      if (m) m[1].split(/,|\band\b|;/).map(x => x.trim()).filter(x => x.length >= 3).forEach(x => asks.push(x));
    });
    const other = [...new Set(asks.filter(x => !SPECS.some(sp => new RegExp(sp.want.source).test(fold(x)))).map(x => x.trim()))].slice(0, 5);
    return { keys: out, other };
  }

  // One spec against one property: 1 has it, 0 plainly does not, null not on record.
  function specHas(sp, p) {
    const txt = p.specText || '';
    if (sp.key === 'parking' || sp.key === 'twoParking') {
      const kinds = p.parkingKind || [];
      const raw = fold([p.p && p.p.parking, p.p && p.p.parkingType].filter(Boolean).join(' '));
      if (/\b(?:no|nil|none|not\s*available)\b/.test(raw)) return 0;
      if (sp.key === 'twoParking') {
        const n = (raw.match(/\b(\d)\b/) || [])[1];
        if (n) return Number(n) >= 2 ? 1 : 0;
        return /\b(?:2|two)\s*(?:car\s*)?park/.test(txt) ? 1 : null;
      }
      if (kinds.includes('Covered') || /\b(?:covered|stilt|basement|closed)\s*(?:car\s*)?park/.test(txt)) return 1;
      if (kinds.length && kinds.every(k => /open/i.test(k))) return 0;
      return raw || /\bcar\s*park/.test(txt) ? 0.6 : null;
    }
    if (sp.key === 'furnished') {
      const f = fold(p.furnishing || '');
      if (/\bun\s*-?\s*furnished\b/.test(f)) return 0;
      if (/furnished/.test(f)) return 1;
      return null;
    }
    if (sp.key === 'independent') return ['House', 'Villa'].includes(p.type) ? 1 : (p.type === 'Apartment' ? 0 : null);
    if (sp.key === 'corner') return p.corner ? 1 : null;
    if (sp.key === 'lift' && p.type === 'Apartment' && /\b(?:no\s*lift|without\s*lift)\b/.test(txt)) return 0;
    if (!sp.have) return null;
    if (new RegExp('\\b(?:no|without)\\s+(?:' + sp.have.source + ')').test(txt)) return 0;
    if (sp.key === 'gated' && p.gated) return 1;
    if (sp.key === 'metro' && p.metro) return 1;
    return sp.have.test(txt) ? 1 : null;
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
      const key = String(p.propertyCode || '').toUpperCase();
      const visited = !!key && new RegExp('\\b' + key + '\\b', 'i').test(String(lead.siteVisitProperty || '') + ' ' + String((lead.ai && lead.ai.visit && lead.ai.visit.property) || ''));
      out.push({
        p, label: p.propertyCode || p.name || p.id,
        priceLo: prof.priceLo, priceMode: prof.priceMode, areaLo: prof.areaLo, type: prof.type, localities: prof.localities,
        visited,
        // Keen on it: visited, or still moving forward with it on the board (not lost, not on hold).
        liked: visited || ['visit_pending', 'visit_done', 'negotiation'].includes(lead.ai && lead.ai.stage)
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
    // A structured requirement (reviewed by a person, or read by the AI) arrives as a sentence the
    // same readers parse — so a reviewed requirement and a typed one can never be scored by
    // different code. A reviewed one outranks every field on the lead.
    (o.extraTexts || []).forEach(t => { if (t && t.text) texts.push({ text: String(t.text), at: t.at || now, src: t.src || 'Reviewed requirement', authority: t.authority == null ? 4 : t.authority }); });
    if (o.extraTexts && o.extraTexts.length) texts.sort((a, b) => (b.authority - a.authority) || (b.at - a.at));
    const want = o.skipWant ? null : cleanWant(lead.ai && lead.ai.want);
    // The AI's read of the whole chat, as requirement text: where the CRM's own fields are blank,
    // this is where the area, the bedrooms and the type are read from.
    if (want) {
      const at = (lead.ai && lead.ai.at) || 0;
      if (want.areas.length) texts.push({ text: want.areas.join(', '), at, src: 'AI read of the chat', authority: 2.5 });
      const bits = [];
      if (want.bhk.length) bits.push(want.bhk.join(' or ') + ' BHK');
      if (want.types.length) bits.push(want.types.map(t => WANT_TYPE_WORD[t] || t).join(' or '));
      if (bits.length) texts.push({ text: bits.join(' '), at, src: 'AI read of the chat', authority: 2.5 });
      if (want.areasExcluded.length) texts.push({ text: 'Not interested in ' + want.areasExcluded.join(', '), at, src: 'AI read of the chat', authority: 2.5 });
      texts.sort((a, b) => (b.authority - a.authority) || (b.at - a.at));
    }
    const seen = seenProperties(l, o.inventory);

    const deal = readDeal(l, texts, want);
    const dealHint = deal && deal.values.length === 1 ? deal.values[0] : null;
    const bhk = readBhk(texts);
    let types = readTypes(texts, bhk);
    let budget = readBudget(texts, dealHint);
    // The curated Budget field wins; otherwise the AI's read of the chat beats a number mentioned
    // in passing in a note.
    if (want && want.budget && (!budget || budget.src !== 'Budget')) budget = want.budget;
    const localities = readLocalities(texts);
    let size = readSize(texts);
    if (!size && want && want.sizeMin) size = { min: want.sizeMin, max: Math.round(want.sizeMin * 1.6), src: 'AI read of the chat' };
    // Grounds, cents or acres with no kind named is land: "4 grounds JV chennai".
    if (!types && size && size.unit === 'land' && !bhk) types = { values: ['Plot'], residentialOnly: false, src: size.src, subs: {} };
    let possession = readPossession(texts, now);
    if (!possession && want && want.readyBy) possession = want.readyBy;
    const floor = readFloorPref(texts);
    const facets = readFacets(texts);
    const specs = readSpecs(texts, want);
    const objections = readObjections(texts, seen, now);
    // No word about renting or buying, but the money says it: a monthly rent or a lease amount is a
    // tenant, a budget in lakhs or crores with no lease about it is a buyer.
    const dealFinal = deal || (budget
      ? (budget.mode === 'sale' || budget.mode === 'psf'
        ? { values: ['sale'], why: budget.mode === 'psf' ? 'their budget, a rate per sq ft — a purchase' : 'their budget, which is a purchase price', src: budget.src }
        : { values: ['rent'], why: `their budget, which is ${budget.mode === 'monthly' ? 'a monthly rent' : 'a lease amount'}`, src: budget.src })
      : null);

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
      deal: dealFinal, budget, bhk, types, localities, size, possession, floor,
      facets, specs, objections, seen,
      dealBreakers: want ? want.dealBreakers : [],
      vector: vec,
      text: prose,
      texts,
      lead
    };
  }

  // ── The AI's structured read of the chat (lead.ai.want, api/_lead-ai.js) ──
  // Checked again here, because a page must never trust a stored shape blindly.
  const WANT_TYPE_WORD = { apartment: 'apartment', villa: 'villa', independent_house: 'independent house', plot: 'plot', commercial: 'commercial' };
  function cleanWant(w) {
    if (!w || typeof w !== 'object') return null;
    const arr = (v, n) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 60)).slice(0, n) : []);
    const num = v => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);
    const unit = ['total', 'per_month', 'lease_amount'].includes(w.budget_unit) ? w.budget_unit : null;
    let budget = null;
    const lo = num(w.budget_min), hi = num(w.budget_max) || lo;
    if (hi && unit) {
      const mode = unit === 'per_month' ? 'monthly' : unit === 'lease_amount' ? 'lumpsum' : 'sale';
      const okRange = mode === 'monthly' ? hi >= 3000 && hi < 50 * LAKH : hi >= 5 * LAKH && hi <= 500 * CR;
      if (okRange) {
        const ranged = lo && hi > lo * 1.02;
        budget = {
          min: ranged ? lo : Math.round(hi * (mode === 'monthly' ? 0.75 : 0.7)), max: hi, firm: !ranged, flexible: false, mode,
          stated: (ranged ? fmtMoney(lo) + ' – ' : '') + fmtMoney(hi) + (mode === 'monthly' ? ' a month' : mode === 'lumpsum' ? ' lease' : ''),
          src: 'AI read of the chat'
        };
      }
    }
    let readyBy = null;
    if (w.ready_by === 'immediate') readyBy = { want: 'ready', src: 'AI read of the chat' };
    else if (typeof w.ready_by === 'string' && /^20\d\d-\d\d$/.test(w.ready_by)) {
      const [y, m] = w.ready_by.split('-').map(Number);
      if (m >= 1 && m <= 12) { const at = monthEnd(y, m - 1); readyBy = { want: 'by', at, label: fmtMonth(at), src: 'AI read of the chat' }; }
    }
    return {
      deal: ['buy', 'rent', 'lease', 'either', 'unknown'].includes(w.deal) ? w.deal : null,
      budget,
      areas: arr(w.areas, 8),
      bhk: (Array.isArray(w.bhk) ? w.bhk : []).filter(n => Number.isInteger(n) && n >= 1 && n <= 8).slice(0, 4),
      types: arr(w.types, 4).filter(t => WANT_TYPE_WORD[t]),
      readyBy,
      sizeMin: num(w.size_sqft_min) && w.size_sqft_min >= 200 && w.size_sqft_min <= 100000 ? w.size_sqft_min : null,
      must_have: arr(w.must_have, 10),
      dealBreakers: arr(w.deal_breakers, 6),
      areasExcluded: arr(w.areas_excluded, 6),
      otherRequirements: arr(w.other_requirements, 3)
    };
  }

  // ═══════ STRUCTURED REQUIREMENTS ═══════
  //
  // lead.reqs = { items: [ITEM], src: 'reviewed' | 'ai', at, by, rev } — written by api/_match.js
  // (the AI structurer and the review form), never over the lead's own fields. An ITEM:
  //   { id, status: 'active'|'previous'|'closed', deal: buy|rent|lease|jv|either,
  //     types: [apartment|villa|independent_house|plot|commercial], sub, bhk: [n],
  //     locations: [{ name, pref: primary|secondary }], exclude: [name], anywhere, radiusKm,
  //     budget: { min, max, unit: total|per_month|per_sqft|lease_amount, flex: fixed|approximate|negotiable|maximum|minimum },
  //     area: { min, max, unit: sqft|sqm|grounds|cents|acres, kind: built|carpet|land, flex },
  //     condition: [new|resale|ready|under_construction], possession: 'immediate'|'YYYY-MM',
  //     mustHave: [..], facing, furnishing, floor, notes, uncertain: [field], missing: [field] }
  // reqSentence() writes an ITEM as the sentence an agent would type, and the ordinary readers
  // parse it. One reading path: a reviewed requirement, a typed brief and a CRM lead cannot drift.
  const TYPE_WORD = { apartment: 'apartment', villa: 'villa', independent_house: 'independent house', plot: 'plot', commercial: 'commercial space' };
  function moneyWord(n) {
    if (!(n > 0)) return '';
    if (n >= CR) return '₹' + (Math.round(n / CR * 100) / 100) + ' Cr';
    if (n >= LAKH) return '₹' + (Math.round(n / LAKH * 100) / 100) + ' lakhs';
    return '₹' + Math.round(n).toLocaleString('en-IN');
  }
  function reqSentence(it) {
    if (!it || typeof it !== 'object') return '';
    const bits = [];
    const deal = { buy: 'to buy', rent: 'for rent', lease: 'for lease', jv: 'for a joint venture', either: 'rent or buy' }[it.deal] || '';
    const bhk = Array.isArray(it.bhk) && it.bhk.length ? it.bhk.filter(n => n > 0).join(' or ') + ' BHK' : '';
    const sub = it.sub && SUB_LABEL[it.sub] ? SUB_LABEL[it.sub] : '';
    const types = (Array.isArray(it.types) ? it.types : []).map(t => TYPE_WORD[t]).filter(Boolean);
    const kind = sub || types.join(' or ');
    bits.push(['Wants', deal === 'to buy' ? 'to buy' : '', bhk, kind, deal && deal !== 'to buy' ? deal : ''].filter(Boolean).join(' '));
    const locs = (Array.isArray(it.locations) ? it.locations : []).map(x => (typeof x === 'string' ? x : x && x.name)).filter(Boolean);
    if (locs.length) bits.push('in ' + locs.join(', '));
    else if (it.anywhere) bits.push('anywhere in Chennai');
    if (it.radiusKm > 0 && locs.length) bits.push(`within ${it.radiusKm} km`);
    let out = bits.join(' ') + '.';
    const ex = (Array.isArray(it.exclude) ? it.exclude : []).filter(Boolean);
    if (ex.length) out += ' Not interested in ' + ex.join(', ') + '.';
    const b = it.budget || {};
    if (b.max > 0 || b.min > 0) {
      const flex = { approximate: 'around ', negotiable: '', maximum: 'up to ', minimum: 'above ', fixed: '' }[b.flex] || '';
      const per = b.unit === 'per_month' ? ' per month' : b.unit === 'per_sqft' ? ' per sqft' : b.unit === 'lease_amount' ? ' lease amount' : '';
      const amt = b.min > 0 && b.max > 0 && b.max > b.min * 1.02 ? `${moneyWord(b.min)} to ${moneyWord(b.max)}` : moneyWord(b.flex === 'minimum' ? (b.min || b.max) : (b.max || b.min));
      out += ` Budget ${b.min > 0 && b.max > b.min * 1.02 ? '' : flex}${amt}${per}${b.flex === 'negotiable' ? ', negotiable' : ''}.`;
    }
    const a = it.area || {};
    if (a.min > 0 || a.max > 0) {
      const unit = { grounds: 'grounds', cents: 'cents', acres: 'acres', sqm: 'sq m', sqft: 'sqft' }[a.unit] || 'sqft';
      const n = x => (Math.round(x * 100) / 100);
      const amt = a.min > 0 && a.max > a.min ? `${n(a.min)} to ${n(a.max)} ${unit}` : `${n(a.min || a.max)} ${unit}`;
      out += ` ${a.flex === 'approximate' ? 'Around ' : ''}${amt}${a.kind === 'land' && !/grounds|cents|acres/.test(unit) ? ' land area' : ''}.`;
    }
    const cond = Array.isArray(it.condition) ? it.condition : [];
    if (cond.includes('new') && cond.includes('resale')) out += ' New or resale.';
    else if (cond.includes('resale')) out += ' Resale.';
    else if (cond.includes('new')) out += ' Brand new.';
    if (it.possession === 'immediate' || cond.includes('ready')) out += ' Ready to move.';
    else if (typeof it.possession === 'string' && /^20\d\d-\d\d$/.test(it.possession)) out += ` Possession by ${MONTHS[Number(it.possession.slice(5)) - 1]} ${it.possession.slice(0, 4)}.`;
    else if (cond.includes('under_construction')) out += ' Under construction is fine.';
    const must = (Array.isArray(it.mustHave) ? it.mustHave : []).filter(Boolean);
    if (it.facing) must.push(it.facing + ' facing');
    if (it.furnishing) must.push(it.furnishing);
    if (must.length) out += ' Must have ' + must.join(', ') + '.';
    return out.replace(/\s+/g, ' ').trim();
  }
  // What a reviewed requirement was reviewed AGAINST: the lead's own requirement words. When they
  // change afterwards (someone edits the CRM field, TailorTalk hears a new budget), the review is
  // out of date — the newer words win, and the screens say "changed since it was reviewed".
  function reqFingerprint(lead) {
    const l = lead || {}, tt = l.tt || {}, prof = tt.profile || {};
    const s = [l.propertyInterest, l.budget, l.enquiryType, prof.requirement_details, prof.budget_and_finance, prof.preferred_location]
      .map(v => fold(v).replace(/\s+/g, ' ').trim()).join('|');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }
  // A saved ITEM as a requirement profile, field for field. The sentence is read for what has no
  // field (must-haves, facing); every field the form holds is then set exactly as saved.
  const CORRIDOR_ITEM = { omr: 'OMR', 'old mahabalipuram road': 'OMR', 'rajiv gandhi salai': 'OMR', 'it corridor': 'OMR', ecr: 'ECR', 'east coast road': 'ECR', 'gst road': 'GST', 'gst': 'GST', 'radial road': 'Radial Road', 'mount poonamallee road': 'Mount-Poonamallee', 'velachery tambaram road': 'Velachery-Tambaram', orr: 'ORR', 'outer ring road': 'ORR' };
  function itemProfile(it, lead, o) {
    const geo = G();
    const now = (o && o.now) || Date.now();
    const prof = briefProfile(reqSentence(it), { now, inventory: o && o.inventory, name: lead.name });
    const hist = requirementProfile(lead, { now, inventory: o && o.inventory, notes: o && o.notes });
    Object.assign(prof, { kind: 'buyer', id: lead.id, lead, name: lead.name || '(no name)', objections: hist.objections, seen: hist.seen,
      dealBreakers: hist.dealBreakers, intent: hist.intent, stageId: lead.stageId || null });
    const src = 'Reviewed requirement';
    if (it.deal) prof.deal = { values: it.deal === 'buy' ? ['sale'] : it.deal === 'rent' || it.deal === 'lease' ? ['rent'] : it.deal === 'jv' ? ['jv'] : ['sale', 'rent'], why: 'their reviewed requirement', src };
    if (it.types && it.types.length) {
      const T = { apartment: 'Apartment', villa: 'Villa', independent_house: 'House', plot: 'Plot', commercial: 'Commercial' };
      const values = it.types.map(t => T[t]).filter(Boolean);
      const subs = {};
      if (it.sub) { const x = SUBTYPES.find(y => y.sub === it.sub); if (x && values.includes(x.type)) subs[x.type] = it.sub; }
      prof.types = { values, residentialOnly: false, src, subs };
    }
    if (it.bhk && it.bhk.length) prof.bhk = { values: it.bhk.slice(), src };
    if (it.budget && (it.budget.max || it.budget.min)) {
      const b = it.budget;
      const mode = b.unit === 'per_month' ? 'monthly' : b.unit === 'per_sqft' ? 'psf' : b.unit === 'lease_amount' ? 'lumpsum' : 'sale';
      const per = mode === 'monthly' ? ' a month' : mode === 'psf' ? ' per sq ft' : mode === 'lumpsum' ? ' lease amount' : '';
      if (b.flex === 'minimum' || (!b.max && b.min)) prof.budget = { min: b.min || b.max, max: Math.round((b.min || b.max) * 1.6), firm: false, flexible: true, minOnly: true, mode, stated: 'above ' + fmtMoney(b.min || b.max) + per, src };
      else {
        const ranged = b.min && b.max > b.min * 1.02;
        prof.budget = { min: ranged ? b.min : Math.round(b.max * (mode === 'monthly' ? 0.75 : 0.7)), max: b.max, firm: !ranged,
          flexible: b.flex === 'approximate' || b.flex === 'negotiable', ceiling: b.flex === 'maximum', mode, stated: (ranged ? fmtMoney(b.min) + ' – ' : '') + fmtMoney(b.max) + per, src };
      }
    }
    if ((it.locations && it.locations.length) || it.anywhere || (it.exclude && it.exclude.length)) {
      const keys = [], corridors = [], fuzzy = [];
      for (const l of it.locations || []) {
        const nm = fold(l.name || l).trim();
        if (CORRIDOR_ITEM[nm]) { corridors.push(CORRIDOR_ITEM[nm]); const m = (geo.CORRIDOR_MEMBERS[CORRIDOR_ITEM[nm]] || [])[0]; if (m && !keys.includes(m)) keys.push(m); continue; }
        for (const f of (geo.resolveLoose ? geo.resolveLoose(l.name || l) : geo.resolveAll(l.name || l).map(key => ({ key })))) if (!keys.includes(f.key)) { keys.push(f.key); if (f.fuzzy) fuzzy.push(f); }
      }
      const exclude = [];
      for (const x of it.exclude || []) for (const k of (geo.resolveLoose ? geo.resolveLoose(x).map(f => f.key) : geo.resolveAll(x))) if (!exclude.includes(k) && !keys.includes(k)) exclude.push(k);
      prof.localities = { keys, firm: true, src, corridors, exclude, excludeQuotes: exclude.length ? ['Not interested in ' + (it.exclude || []).join(', ')] : [], fuzzy, anywhere: !!it.anywhere && !keys.length, radiusKm: it.radiusKm || null };
    }
    if (it.area && (it.area.min || it.area.max)) {
      const a = it.area;
      const k = { grounds: 2400, cents: 435.6, acres: 43560, sqm: 10.7639, sqft: 1 }[a.unit] || 1;
      const land = a.kind === 'land' || ['grounds', 'cents', 'acres'].includes(a.unit);
      const lo = Math.round((a.min || a.max) * k), hi = Math.round((a.max || a.min) * k);
      prof.size = { min: lo, max: hi > lo ? hi : Math.round(lo * 1.25), src, unit: land ? 'land' : undefined };
    }
    if (it.possession === 'immediate') prof.possession = { want: 'ready', src };
    const cond = it.condition || [];
    prof.facets = Object.assign({}, prof.facets);
    if (cond.includes('resale') && !cond.includes('new')) prof.facets.saleType = 'Resale';
    else if (cond.includes('new') && !cond.includes('resale')) prof.facets.saleType = 'New';
    else delete prof.facets.saleType;
    return prof;
  }

  function activeItems(lead) {
    const r = lead && lead.reqs;
    const items = r && Array.isArray(r.items) ? r.items.filter(x => x && typeof x === 'object' && (x.status || 'active') === 'active') : [];
    const stale = !!(r && r.fp && r.fp !== reqFingerprint(lead));
    return { items, reviewed: !!(r && r.src === 'reviewed'), at: (r && r.at) || 0, stale };
  }
  // Every live requirement of one lead, each as its own profile. The first is the main one (the
  // lead's own fields fill what it leaves out); any other is scored ONLY on what it says, so a
  // second requirement ("and 2 grounds in Choolaimedu for JV") never borrows the first one's budget.
  function requirementProfiles(lead, opts) {
    const o = opts || {};
    const { items, reviewed, at, stale } = activeItems(lead);
    const out = [];
    if (items.length) {
      items.forEach((it, i) => {
        const text = reqSentence(it);
        if (!text) return;
        const src = 'Reviewed requirement';
        // Out of date: still read, but below the lead's own (newer) words.
        const authority = stale ? 2.4 : reviewed ? 4 : 2.8;
        // Reviewed and current: exactly what was saved — nothing from the old reading mixed in (it
        // was: an old "OMR" in the chat kept matching a client saved as Anna Nagar + Kilpauk). Only
        // the client's history comes along: their objections and what they have already seen.
        const prof = reviewed && !stale ? itemProfile(it, lead, o)
          : i === 0
            ? requirementProfile(lead, Object.assign({}, o, { extraTexts: [{ text, at, src, authority }], skipWant: false }))
            : Object.assign(briefProfile(text, { now: o.now, inventory: o.inventory, name: lead.name }), { id: lead.id, lead, kind: 'buyer' });
        prof.reqIndex = i; prof.reqItem = it; prof.reqText = text; prof.reqSrc = reviewed ? 'reviewed' : 'ai'; prof.reqStale = stale;
        out.push(prof);
      });
    }
    if (!out.length) {
      const main = requirementProfile(lead, o);
      main.reqIndex = 0;
      out.push(main);
      // More than one requirement heard by the automation (ai.want.other_requirements).
      const more = lead.ai && lead.ai.want && Array.isArray(lead.ai.want.other_requirements) ? lead.ai.want.other_requirements : [];
      more.filter(x => typeof x === 'string' && x.trim().length > 6).slice(0, 3).forEach((line, j) => {
        const p2 = Object.assign(briefProfile(line, { now: o.now, inventory: o.inventory, name: lead.name }), { id: lead.id, lead, kind: 'buyer' });
        p2.reqIndex = j + 1; p2.reqText = line; p2.reqSrc = 'ai';
        out.push(p2);
      });
    }
    return out;
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

    // Rent or sale first: the price means a different thing in each.
    // A phone number in a price cell ("On request: call 98400…") is not a price, and the rent is the
    // figure BEFORE "plus maintenance / deposit" — taking the smallest read ₹74,000 + ₹6,000 as ₹6,000.
    const rawPrice = [p.startingPrice, p.price].filter(Boolean).join(' | ').replace(/(?:\+?91[\s-]*)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, ' ');
    const extraAt = rawPrice.search(/\b(?:plus|maintenance|maint\.?|deposit|advance)\b|\s\+\s/i);
    const head = extraAt > 3 ? S().parseMoney(rawPrice.slice(0, extraAt), 'price') : null;
    const priceText = head && [].concat(head.price || [], head.rent || [], head.psf || []).length ? rawPrice.slice(0, extraAt) : rawPrice;
    const money = priceText ? S().parseMoney(priceText, 'price') : { price: [], rent: [] };
    const deal = propertyDeal(p, money.rent || [], money.price || []);
    let priceSpans = priceText === [p.startingPrice, p.price].filter(Boolean).join(' | ') ? (rec.num.price || []) : (money.price || []);
    priceSpans = priceSpans.filter(r => r[0] <= 500 * CR);
    let priceMode = 'sale';
    if (deal === 'rent') {
      const bare = /\b(?:sq\.?\s*ft|sqft|sft|square\s*feet|psf)\b/.test(fold(priceText)) ? [] : (money.psf || []);
      const monthly = (money.rent || []).concat((money.price || []).concat(bare).filter(r => r[0] >= 3000 && r[1] < 5 * LAKH));
      const lump = (money.price || []).filter(r => r[1] >= 5 * LAKH);
      if (monthly.length) { priceSpans = monthly; priceMode = 'monthly'; }
      else if (lump.length && LEASEISH.test(fold(priceText))) { priceSpans = lump; priceMode = 'lumpsum'; }
      else priceSpans = [];
    } else {
      // A sale price under ₹5 L is a rate or a booking amount, never the price of a home.
      priceSpans = priceSpans.filter(r => r[1] >= 5 * LAKH);
    }
    const areaSpans = (rec.num.area && rec.num.area.length) ? rec.num.area : (rec.num.sqft || []);
    const psfSpans = rec.num.psf || [];

    // Where it IS, not what it is near: "Adambakkam, Near OMR & Velachery" is in Adambakkam.
    // Reading every name in that line put it on OMR, 10 km away.
    const place = geo.placeOf ? geo.placeOf(p.location || '') : { at: geo.resolveAll(p.location || ''), near: [] };
    const localities = place.at.slice();
    // A project name often carries the locality when the Location column does
    // not ("… Anna Nagar …"), and the zone is the last resort.
    if (!localities.length) {
      const fromName = geo.resolveAll([p.name, p.nearbyLandmark, p.connectivity].filter(Boolean).join(' , '));
      fromName.forEach(k => { if (!localities.includes(k)) localities.push(k); });
    }

    // The kind within the kind, from what the property IS (type, configuration, name) — never from
    // its highlights, where "near IT offices" would make a flat an office.
    const kindText = [p.type, p.propertyType, p.config, p.name, p.subType].filter(Boolean).join(' | ');
    // No type on record (a Shoot card, a seller's words): read it from its own name and
    // configuration, and a bedroom count means a home — so a land buyer is never shown a flat as
    // "type unknown".
    let type0 = rec.facet.type, typeGuessed = false;
    if (!type0 || type0 === 'Other') {
      const g = guessType({ title: p.name, config: p.config }, '');
      const g2 = g ? S().normType(g) : null;
      if (g2 && g2 !== 'Other') { type0 = g2; typeGuessed = true; }
    }
    // Bedrooms with no type: some kind of home. Still "type not known" to a home buyer (never a
    // mismatch), but plainly not land or a shop to someone looking for those.
    const homeLikely = (!type0 || type0 === 'Other') && (rec.num.bhk || []).length > 0;
    const jvText = fold([p.dealType, p.name, p.highlights, p.availability, p.detailsText, p.sheetNotes, p.notes].filter(Boolean).join(' | '));
    let landSpans = (rec.num.land || []).filter(r => r[0] >= 300);
    if (!landSpans.length && type0 === 'Plot') landSpans = S().parseLandSqft(/\b(?:grounds?|cents?|acres?)\b/i.test([p.config, p.name].join(' ')) ? [p.config, p.name].filter(Boolean).join(' ') : '').filter(n => n >= 300).map(n => [n, n]);
    prof = {
      kind: 'property',
      p, id: p.id,
      sub: subtypeOf(kindText, type0) || (type0 === 'Plot' && /\b(?:residential|house\s*site|dtcp|cmda|layout|gated)\b/.test(fold(kindText + ' ' + (p.approval || ''))) ? 'res_plot' : null),
      // Open to a joint venture: said so in its deal or its description. Only land (or a house on
      // land) can be.
      jv: (type0 === 'Plot' || type0 === 'House' || type0 === 'Other') && (String(p.dealType || '').toLowerCase() === 'jv' || JV_RE.test(jvText)),
      jvOnly: String(p.dealType || '').toLowerCase() === 'jv',
      landLo: landSpans.length ? Math.min.apply(null, landSpans.map(r => r[0])) : null,
      landHi: landSpans.length ? Math.max.apply(null, landSpans.map(r => r[1])) : null,
      code: p.propertyCode || null,
      name: p.name || p.id,
      locationText: p.location || '',
      localities,
      zone: p.zone || geo.zoneOf(p.location || '') || null,
      nearLocalities: place.near || [],
      corridors: (rec.facet.corridor || []).slice(),
      deal, priceMode,
      type: type0, typeGuessed, homeLikely,
      bhk: (rec.num.bhk || []).slice(),
      priceLo: priceSpans.length ? Math.min.apply(null, priceSpans.map(r => r[0])) : null,
      priceHi: priceSpans.length ? Math.max.apply(null, priceSpans.map(r => r[1])) : null,
      areaLo: areaSpans.length ? Math.min.apply(null, areaSpans.map(r => r[0])) : null,
      areaHi: areaSpans.length ? Math.max.apply(null, areaSpans.map(r => r[1])) : null,
      psfLo: psfSpans.length ? Math.min.apply(null, psfSpans.map(r => r[0])) : null,
      ready: rec.facet.status === 'ready',
      possessionBucket: rec.facet.possession,
      possessionYear: rec.possessionYear || null,
      possessionAt: readWhen([p.possessionDate, p.possession].filter(Boolean).join(' ')) || (rec.possessionYear ? monthEnd(rec.possessionYear, 11) : null),
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
      specText: fold(propertyText(p)),
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
    // The board stores propType / deal / sqft / uds (track-assets/app.js); the older names are still
    // read for cards written before. Reading only the old names dropped the type, the deal and the
    // size of every card, so a card was scored as an unknown thing of unknown size.
    const facts = (lead && lead.tt && lead.tt.facts) || {};
    const factSize = kind => (Array.isArray(facts.sizes) ? facts.sizes : []).filter(z => z && z.kind === kind && z.sqft > 0).map(z => z.sqft);
    const built = listing.sqft || (factSize('built').length ? Math.max.apply(null, factSize('built')) + ' sqft' : '');
    const land = listing.landArea || (factSize('land').length ? Math.max.apply(null, factSize('land')) + ' sqft' : '');
    const typeWord = listing.propType || listing.propertyType || facts.type || '';
    const asProperty = {
      id: listing.id,
      propertyCode: listing.propertyCode || null,
      // A card the seller sync made is titled with the seller's NAME — useless as a property name.
      name: (listing.title && listing.title !== listing.sellerName ? listing.title : '') || listing.propertyCode
        || (lead && lead.propertyInterest && !/^(?:hi|hello|hey|ok|okay|yes|no)\b|map\s*location|location\s*shared|https?:|^\W*$/i.test(String(lead.propertyInterest).trim()) && String(lead.propertyInterest).trim().length >= 4 ? lead.propertyInterest : '')
        || [facts.config, typeWord, listing.location].filter(Boolean).join(' · ') || `Seller enquiry${listing.sellerName ? ' — ' + String(listing.sellerName).split(/\s+/)[0] : ''} (details pending)`,
      location: listing.location || listing.address || (lead && lead.propertyInterest) || '',
      config: listing.config || facts.config || '',
      startingPrice: listing.askingPrice || facts.price || (lead && lead.budget) || '',
      type: (typeWord && typeWord !== 'land' ? typeWord : typeWord === 'land' ? 'Land' : '') || guessType(listing, ttText),
      dealType: listing.deal || listing.dealType || facts.deal || ownerDeal(lead),
      status: listing.readyToMove ? 'Ready to Move' : '',
      sqftRange: built,
      uds: listing.uds || (factSize('uds')[0] ? factSize('uds')[0] + ' sqft' : ''),
      totalLandArea: land,
      highlights: [listing.remarks, listing.description].filter(Boolean).join(' \n '),
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
    const dealType = ownerDeal(lead);
    let asking = [lead.budget, prof.budget_and_finance, (tt.values && tt.values.budget) || '']
      .filter(Boolean)[0] || '';
    if (dealType === 'rent') {
      // An owner letting out quotes a monthly rent: "62000 rent", "rent 45k".
      const joined = [asking, described].join(' | ');
      const m = S().parseMoney(joined, 'price');
      const bare = /\b(?:sq\.?\s*ft|sqft|sft|square\s*feet|psf)\b/i.test(joined) ? [] : (m.psf || []);
      const monthly = (m.rent || []).concat((m.price || []).concat(bare).filter(r => r[0] >= 3000 && r[1] < 5 * LAKH));
      if (monthly.length) asking = fmtMoney(Math.min.apply(null, monthly.map(r => r[0]))) + ' per month';
    } else if (!moneySpans(asking).length) {
      const fromText = moneySpans(described).filter(r => r[1] >= 5 * LAKH && r[0] <= 500 * CR);
      if (fromText.length) asking = fmtMoney(Math.min.apply(null, fromText.map(r => r[0])));
    }

    // TailorTalk's extracted facts (type, config, sizes, price) are the cleanest description we
    // hold of an owner's property; the sentence is the fallback.
    const facts = tt.facts || {};
    const sizes = Array.isArray(facts.sizes) ? facts.sizes.filter(z => z && z.sqft > 0) : [];
    const sz = kind => sizes.filter(z => z.kind === kind).map(z => z.sqft);
    if (!moneySpans(asking).length && facts.priceValue > 0 && dealType !== 'rent') asking = fmtMoney(facts.priceValue);
    const factType = { apartment: 'Apartment', villa: 'Villa', house: 'Independent House', land: 'Land', commercial: 'Commercial' }[facts.type] || '';
    const asProperty = {
      id: 'owner:' + (lead.id || ''),
      propertyCode: (lead.propertyCodes || [])[0] || null,
      name: described ? described.slice(0, 80) : (lead.name ? lead.name + '’s property' : 'Owner listing'),
      location: described,
      config: [facts.config, described].filter(Boolean).join(' , '),
      // No extracted size: the owner's own sentence ("…2000 sqft", "2 grounds") is the next best.
      sqftRange: sz('built').length ? Math.max.apply(null, sz('built')) + ' sqft'
        : ((fold(described).match(/\b(\d{3,5}(?:\.\d+)?)\s*(?:sq\.?\s*ft|sqft|sft|square\s*feet)\b/) || [])[1] ? fold(described).match(/\b(\d{3,5}(?:\.\d+)?)\s*(?:sq\.?\s*ft|sqft|sft|square\s*feet)\b/)[1] + ' sqft' : ''),
      uds: sz('uds').length ? sz('uds')[0] + ' sqft' : '',
      totalLandArea: sz('land').length ? Math.max.apply(null, sz('land')) + ' sqft' : ((fold(described).match(/\b\d+(?:\.\d+)?\s*(?:grounds?|cents?|acres?)\b/) || [])[0] || ''),
      startingPrice: asking,
      type: factType || guessType({ title: described, config: described, remarks: prof.remarks }, described),
      dealType,
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

  // Selling or letting, for an owner: their intent, then what the sync read from their words.
  function ownerDeal(lead) {
    if (!lead) return '';
    const intent = lead.ai && lead.ai.intent;
    if (intent === 'rent_out') return 'rent';
    if (intent === 'sell') return 'sale';
    const f = lead.tt && lead.tt.facts && lead.tt.facts.deal;
    if (f === 'rent' || f === 'sale') return f;
    return /rent|lease|let/i.test(String(lead.enquiryType || '')) ? 'rent' : '';
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
  //   score(r,p)  → null: not scored (a refinement the buyer never raised,
  //               or one that does not apply — bedrooms on a plot), or
  //               { s: 0..1, why, veto?: 'reason' }, or
  //               unknown(why, ask) — a CORE fact one side has not told us.
  //               It is scored at the attribute's `prior` and listed under
  //               "Not known yet" with the question that would settle it.
  //   prior       the score an unknown core fact gets (about half: a coin
  //               toss, never a pass)
  //
  // Weights are relative, not absolute: only the attributes in play are
  // summed, so they express "how much does this matter COMPARED to the other
  // things this buyer told us".
  const unknown = (why, ask) => ({ unknown: true, why, ask });
  const MODE_SAID = { sale: 'a purchase price', monthly: 'a monthly rent', lumpsum: 'a lump-sum lease amount' };

  const ATTRIBUTES = [
    {
      key: 'deal', label: 'Rent or buy', weight: 12, core: true, prior: 0.5,
      score(r, p) {
        const has = p.deal || 'sale';
        const TL = t => { const w = (S().TYPE_LABEL[t] || t || 'property').toLowerCase(); return (/^[aeiou]/.test(w) ? 'an ' : 'a ') + w; };
        if (r.deal && r.deal.values.includes('jv')) {
          if (p.jv) return { s: 1, why: 'open to a joint venture — which is what they want' };
          if (p.type && !['Plot', 'House', 'Other'].includes(p.type)) return { s: 0, veto: `${TL(p.type)} — a joint venture needs land, and they want a JV` };
          if (has === 'rent') return { s: 0, veto: 'offered for rent, and they want a joint venture' };
          if (r.deal.values.includes('sale')) return { s: 0.8, why: 'for outright sale — they would also buy outright' };
          return { s: 0.1, veto: 'listed for outright sale — the owner has not said they are open to a joint venture (worth asking)' };
        }
        if (p.jvOnly && r.deal && r.deal.values.includes('sale') && has !== 'rent') {
          return { s: 0.35, why: 'offered as a joint venture — ask whether the owner would sell outright' };
        }
        // An owner who would PREFER a JV may still sell: a real option to put to a buyer, not a sure one.
        if (p.jv && r.deal && r.deal.values.length === 1 && r.deal.values[0] === 'sale' && has !== 'rent') {
          return { s: 0.7, why: 'the owner prefers a joint venture — ask whether they would sell outright' };
        }
        if (!r.deal) {
          return unknown(`whether they want to rent or to buy is not known — this is ${DEAL_LABEL[has]}`, 'Ask whether they are renting or buying');
        }
        if (r.deal.values.includes(has)) {
          return { s: 1, why: r.deal.values.length > 1 ? `${DEAL_LABEL[has]} — they are open to renting or buying (going by ${r.deal.why})` : `${DEAL_LABEL[has]} — they are ${has === 'rent' ? 'renting' : 'buying'} (going by ${r.deal.why})` };
        }
        // Never mixed: a tenant is not a buyer at a lower price.
        return { s: 0, veto: `this is ${DEAL_LABEL[has]}, and they want to ${has === 'rent' ? 'buy' : 'rent'} (going by ${r.deal.why})` };
      }
    },

    {
      key: 'budget', label: 'Budget', weight: 26, core: true, prior: 0.5,
      score(r, p) {
        // A joint venture is paid in built-up area, not rupees: there is no price to compare.
        if (r.deal && r.deal.values.length === 1 && r.deal.values[0] === 'jv') return null;
        if (!r.budget) return unknown('their budget is not known', 'Ask their budget');
        // A budget per square foot ("up to ₹9,000 a sq ft"), against the property's rate.
        if (r.budget.mode === 'psf') {
          if (p.deal === 'rent') return unknown('their budget is a rate per sq ft and this is a rental', 'Check whether they would rent');
          if (p.psfLo == null) return unknown('no rate per sq ft on record for this property', 'Get the rate per sq ft');
          const over = p.psfLo / r.budget.max;
          if (over <= 1) return { s: 1, why: `₹${Math.round(p.psfLo).toLocaleString('en-IN')}/sq ft — inside their ₹${Math.round(r.budget.max).toLocaleString('en-IN')}/sq ft` };
          const sc = over <= 1.05 ? 0.85 : over <= 1.12 ? 0.6 : over <= 1.25 ? 0.3 : 0.08;
          return { s: sc, why: `₹${Math.round(p.psfLo).toLocaleString('en-IN')}/sq ft — ${Math.round((over - 1) * 100)}% over their ₹${Math.round(r.budget.max).toLocaleString('en-IN')}/sq ft` };
        }
        if (p.priceLo == null) return unknown(`no ${p.deal === 'rent' ? 'rent' : 'price'} on record for this property`, 'Get the price from the owner or builder');
        if (r.budget.mode !== p.priceMode) {
          // A monthly rent and a sale price (or a lease amount) are not the same money. When the
          // deal itself differs the deal veto has already said so; this is the leftover case.
          return unknown(`their budget is ${MODE_SAID[r.budget.mode]} and this is quoted as ${MODE_SAID[p.priceMode]}`, 'Ask the owner for the other figure');
        }
        const monthly = r.budget.mode === 'monthly';
        const per = monthly ? ' a month' : '';
        const max = r.budget.flexible ? r.budget.max * 1.08 : r.budget.max;
        const floor = r.budget.min || max * 0.7;
        const lo = p.priceLo, hi = p.priceHi != null ? p.priceHi : p.priceLo;
        const priceSensitive = r.objections.some(o => o.kind === 'price_high');
        const shown = lo === hi ? fmtMoney(lo) : `${fmtMoney(lo)}–${fmtMoney(hi)}`;
        // "their 1.5 Cr budget", but "their budget (“Purchase budget approximately ₹3 Cr…”)" — never "budget budget".
        const said = r.budget.stated;
        const theirs = /budget/i.test(said) || said.length > 28 ? `their budget (“${said}”)` : `their ${said} budget`;

        // Something on this property sits inside what they can pay — a range overlapping the
        // budget counts, since the cheaper variant is the one to offer.
        if (lo <= max && hi >= floor) {
          const head = max > 0 ? Math.round((1 - Math.max(lo, floor) / max) * 100) : 0;
          return { s: 1, why: `${shown}${per} — inside ${theirs}${head >= 8 && lo === hi ? ` (${head}% of headroom)` : ''}` };
        }

        // Below what they are looking at. Nearing the budget is what they came for; far under it
        // is the wrong segment, and offering it reads as not having listened.
        if (hi < floor) {
          const ratio = hi / floor;
          const s = ratio >= 0.85 ? 0.92 : ratio >= 0.7 ? 0.8 : ratio >= 0.55 ? 0.62 : 0.45;
          return {
            s,
            // Half their minimum or less is a different segment, not a bargain: never more than a partial match.
            cap: ratio < 0.6 ? 0.62 : undefined,
            why: s >= 0.8 ? `${shown}${per} — a little under ${theirs}`
              : `${shown}${per} — well under ${theirs}, so possibly not the segment they want`
          };
        }

        const over = lo / max;
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
        // 17% over → 0.78) exactly where it was. A tenant's rent stretches
        // about as far as an entry-level buyer's: 10%.
        let tol = monthly ? 0.10
          : r.budget.mode === 'lumpsum' ? 0.12
            : max < 75 * LAKH ? 0.08
              : max < 2 * CR ? 0.12
                : max < 5 * CR ? 0.20
                  : 0.28;
        // A ceiling they stated ("under 3 Cr") halves the room to stretch, and anything over it is
        // never as good as something inside it — over-budget ranks below in-budget at equal fit.
        if (r.budget.ceiling) tol = tol / 2;
        const stretch = (over - 1) / tol;      // 1.0 = at the edge of it

        const s0 = stretch <= 0.15 ? 0.98
          : stretch <= 0.30 ? 0.95
            : stretch <= 0.55 ? 0.88
              : stretch <= 0.85 ? 0.78
                : stretch <= 1.20 ? 0.55
                  : stretch <= 1.80 ? 0.30
                    : 0.08;
        const s = r.budget.ceiling ? Math.min(s0, 0.8) : s0;
        // Over a range they stated by more than 15%: a partial match at most.
        const capRange = !r.budget.firm && !r.budget.minOnly && over > 1.15 ? 0.69 : undefined;

        const band = !monthly && max < 75 * LAKH ? 'at this budget a loan is already at its ceiling, so there is little room to stretch' : null;
        // The anchor rule in applyObjections() already sets the real ceiling
        // from the property they actually called expensive, and that is the
        // better instrument — so this blanket stop now only applies to a
        // buyer who has said it more than once.
        const saidTwice = r.objections.filter(o => o.kind === 'price_high').length > 1;
        if (priceSensitive && saidTwice && stretch > 1.2) {
          return { s, veto: `${pct}% over ${theirs}, and they have called a property too expensive more than once` };
        }
        if (stretch > 2.2) return { s, veto: `${fmtMoney(lo)}${per} is ${pct}% over ${theirs}` };
        return {
          s, cap: capRange,
          why: `${fmtMoney(lo)}${per} — ${pct}% over ${theirs}`
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
      prior: 0.5,
      score(r, p, ctx) {
        const geo = G();
        // A place they refused is a veto before anything else is weighed.
        const hit = excludedHit(r, p, ctx);
        if (hit) {
          const said = (r.localities.excludeQuotes || [])[0];
          return { s: 0, veto: `in ${geo.label(hit.bad)}${hit.km ? ` (about ${Math.max(1, Math.round(hit.km))} km)` : ''}, which they ruled out${said ? ` — “${said}”` : ''}` };
        }
        if (r.localities && r.localities.zones && r.localities.zones.length && !r.localities.keys.length) {
          const pz = p.zone && /chennai/i.test(p.zone) ? p.zone : (p.localities[0] ? geo.zoneOf(p.localities[0]) : null);
          const said = r.localities.zones.map(z => z.replace(/^Chennai (\w+)$/, '$1 Chennai')).join(' / ');
          if (!pz) return unknown(`they want ${said} — this property's zone is not on record`, 'Check which part of the city it is in');
          if (r.localities.zones.includes(pz)) return { s: 0.9, why: `${p.localities[0] ? geo.label(p.localities[0]) : p.locationText}, in ${pz.replace(/^Chennai (\w+)$/, '$1 Chennai')} — the part of the city they asked for` };
          return { s: 0.15, why: `${p.localities[0] ? geo.label(p.localities[0]) : p.locationText} is in ${pz.replace(/^Chennai (\w+)$/, '$1 Chennai')}, and they asked for ${said}` };
        }
        if (r.localities && r.localities.anywhere && !r.localities.keys.length) {
          return { s: 1, why: `${p.localities[0] ? geo.label(p.localities[0]) : (p.locationText || 'in Chennai')} — they are open to anywhere in Chennai` };
        }
        if (!r.localities || !r.localities.keys.length) return unknown('where they want to live is not known', 'Ask which areas they are considering');
        const area = ctx && ctx.area;
        const want = r.localities.keys;
        const heres = p.localities.length ? p.localities : (p.locationText ? [p.locationText] : []);
        if (!heres.length) {
          // Somewhere we cannot place can still be offered, but not as more than worth a call to a
          // client who named their area.
          const u = unknown('this property has no location on record', 'Add the location to the property');
          if (r.localities.firm) u.cap = 0.7;
          return u;
        }

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
        // A stated radius decides it outright, either way.
        if (r.localities.radiusKm && pr.basis !== 'same' && pr.basis !== 'contains') {
          const km = geo.distanceKm(best.h, best.w);
          if (km != null) {
            if (km <= r.localities.radiusKm) return { s: 0.95, why: `${label(best.h)}, about ${Math.max(1, Math.round(km))} km from ${label(best.w)} — inside the ${r.localities.radiusKm} km they allowed` };
            return { s: Math.min(pr.similarity, 0.25), why: `${label(best.h)}, about ${Math.round(km)} km from ${label(best.w)} — outside the ${r.localities.radiusKm} km they allowed` };
          }
        }

        if (pr.basis === 'same') return { s: 1, why: `${label(best.w)} — exactly where they are looking` };
        // "Inside" is learned from how the inventory writes addresses, and a careless one ("Saligramam,
        // Valasaravakkam") taught it that two neighbours 3 km apart are one inside the other. Two
        // places we can both pin that far apart are never "inside" each other.
        const kmIn = geo.distanceKm(best.h, best.w);
        if (pr.basis === 'contains' && !(kmIn != null && kmIn > 2.2)) return { s: 1, why: pr.note };
        if (pr.basis === 'contains') { const lp = legacyProximity(geo, best.h, best.w); if (lp) { pr.similarity = lp.similarity; pr.kmBand = lp.kmBand; pr.basis = 'anchored'; } }

        // The area model's similarity is a geographic closeness; a buyer's willingness falls off
        // faster than that. Calibrated (Nov 2026) to how a Chennai agent hears "Anna Nagar":
        // the next block (≤ 3 km) is a real option, 3–4 km a compromise to put to them, 5–8 km a
        // different market — not half a match.
        const sim = pr.similarity;
        const s = sim >= 0.8 ? sim : sim >= 0.6 ? 0.55 + (sim - 0.6) * 1.25 : sim >= 0.4 ? 0.25 + (sim - 0.4) * 1.5 : sim * 0.6;
        const near = pr.kmBand ? `${/^(?:under|about|over|less)/.test(pr.kmBand) ? '' : 'about '}${pr.kmBand} from ${pr.to || label(best.w)}` : `near ${pr.to || label(best.w)}`;

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
      key: 'bhk', label: 'Bedrooms', weight: 14, core: true, prior: 0.6,
      score(r, p) {
        // A plot has no bedrooms. Scoring it would mark down every plot for a
        // buyer who said "3BHK plot", which is a thing people say.
        if (p.type === 'Plot' || p.type === 'Commercial') return null;
        const landOnly = r.types && r.types.values.length && r.types.values.every(t => t === 'Plot' || t === 'Commercial');
        if (!r.bhk || !r.bhk.values.length) return landOnly ? null : unknown('how many bedrooms they need is not known', 'Ask how many bedrooms');
        if (!p.bhk.length) return unknown('the configuration is not on record for this property', 'Check the BHK with the owner');
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
      key: 'type', label: 'Property type', weight: 10, core: true, prior: 0.7,
      score(r, p) {
        // Not known what they want: for a home that is a fair coin, but most of our clients want a home —
        // so for land or commercial space it is a long way from a yes.
        if (!r.types || !r.types.values.length) {
          const u = unknown('the kind of property they want is not known', 'Ask: flat, villa, house or plot?');
          if (p.type === 'Plot' || p.type === 'Commercial') { u.prior = 0.25; u.cap = 0.72; }
          return u;
        }
        // 'Other' is what normType() returns for a blank or unrecognised type
        // column — which means "we do not know", not "it is something else".
        // Scoring it as a 0.2 mismatch cost 11 of 14 points for no reason,
        // and it showed up worst exactly where the data is thinnest: an
        // owner's own description of their flat rarely contains the word
        // "apartment", so a seller's buyers were all being marked down ~14%
        // against a property nobody had said anything wrong about.
        if ((p.type === 'Other' || !p.type) && p.homeLikely && r.types.values.every(t => t === 'Plot' || t === 'Commercial')) {
          return { s: 0, veto: `a home (${p.bhk.join('/')} BHK), and they want ${r.types.values.map(t => (S().TYPE_LABEL[t] || t).toLowerCase()).join(' / ')}` };
        }
        if (p.type === 'Other' || !p.type) return unknown('this property\'s type is not on record', 'Record the property type');
        const want = r.types.values;
        if (want.includes(p.type)) {
          // Same type: now the kind within it. Only two KNOWN sub-kinds can disagree.
          const wantSub = r.types.subs && r.types.subs[p.type];
          const near = subNear(wantSub, p.sub);
          // For land and commercial space the kind within the kind does the work bedrooms do for a
          // home (bedrooms are not scored there), so it carries their weight as well.
          const subWeight = (p.type === 'Commercial' || p.type === 'Plot') ? 24 : 10;
          if (near != null && near < 1) {
            const theirs = SUB_LABEL[wantSub], ours = SUB_LABEL[p.sub];
            if (near === 0) return { s: 0, weight: subWeight, veto: `${ours}, and they want ${theirs}` };
            return { s: near, weight: subWeight, why: `${ours} rather than the ${theirs} they asked for` };
          }
          if (near === 1) return { s: 1, weight: subWeight, why: `${SUB_LABEL[p.sub]}, as asked` };
          if (wantSub && !p.sub) return { unknown: true, why: `they want ${SUB_LABEL[wantSub]} — what kind of ${(S().TYPE_LABEL[p.type] || p.type).toLowerCase()} this is, is not on record`, ask: `Confirm with the owner whether it suits ${SUB_LABEL[wantSub]}` };
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
          // A villa and an independent house are close cousins; a flat for someone who asked for a
          // house of their own (or the reverse) is a different way of living.
          const pair = [want.includes('House') || want.includes('Villa') ? 'own' : 'flat', p.type === 'Apartment' ? 'flat' : 'own'];
          const sc = pair[0] === pair[1] ? 0.7 : pair[0] === 'own' ? 0.25 : 0.4;
          return { s: sc, why: `${S().TYPE_LABEL[p.type] || p.type} rather than the ${want.map(t => S().TYPE_LABEL[t] || t).join(' / ')} they named` };
        }
        // Land against a built commercial space is a different purchase, not a near miss: a land
        // buyer is not shown a showroom to let, and a showroom tenant is not shown a plot.
        if ((want.includes('Plot') && p.type === 'Commercial') || (want.includes('Commercial') && p.type === 'Plot')) {
          return { s: 0, veto: p.type === 'Plot' ? `land, and they want built commercial space` : `built commercial space, and they want land` };
        }
        return { s: 0.2, why: `${S().TYPE_LABEL[p.type] || p.type} against ${want.join(' / ')}` };
      }
    },

    {
      key: 'size', label: 'Size', weight: 6, core: true, prior: 0.8,
      score(r, p) {
        if (!r.size) return unknown('the size they need is not stated', 'Ask the size they need');
        // Land is measured as land: grounds against grounds. A 2-ground plot buyer's want is set
        // against the LAND area of a plot or a house on land, never its built-up area, and never a
        // flat's carpet (the type check has already ruled that pairing out).
        const landWant = r.size.unit === 'land';
        const landProp = p.type === 'Plot' || (p.type === 'House' && p.landLo != null && landWant);
        let lo = p.areaLo, hi = p.areaHi;
        if (landWant || p.type === 'Plot') {
          if (landProp) { lo = p.landLo != null ? p.landLo : p.areaLo; hi = p.landHi != null ? p.landHi : p.areaHi; }
          else if (landWant) return null;
        }
        if (lo == null) return unknown(`the ${landWant ? 'land ' : ''}size is not on record for this property`, landWant ? 'Get the land extent (grounds / cents) from the owner' : 'Get the area from the owner');
        if (landWant || landProp) {
          // For land the size IS the purchase — 2 grounds and 4 grounds are different budgets and
          // different projects — so it weighs as much as bedrooms do for a flat.
          const W = 14;
          const g = n => (n / 2400 >= 0.95 ? `${Math.round(n / 2400 * 10) / 10} grounds` : fmtArea(n, n));
          const ok = hi >= r.size.min * 0.95 && lo <= r.size.max * 1.05;
          if (ok) return { s: 1, weight: W, why: `${g(lo)}${hi > lo ? '–' + g(hi) : ''} of land — the ${g(r.size.min)} they want` };
          const short = hi < r.size.min;
          const gap = short ? r.size.min / hi : lo / r.size.max;
          const sc = gap <= 1.15 ? 0.7 : gap <= 1.35 ? 0.45 : gap <= 1.7 ? 0.2 : 0.05;
          return { s: sc, weight: W, why: `${g(lo)} of land against the ${g(r.size.min)} they want — ${short ? 'smaller' : 'larger'}` };
        }
        p = Object.assign({}, p, { areaLo: lo, areaHi: hi });
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
      score(r, p, ctx) {
        if (!r.possession || p.deal === 'rent') return null;
        const now = (ctx && ctx.now) || Date.now();
        const at = p.possessionAt;
        const when = at ? fmtMonth(at) : null;
        if (r.possession.want === 'ready') {
          if (p.ready) return { s: 1, why: 'ready to move, which is what they need' };
          const months = at ? (at - now) / (30 * DAY) : null;
          const s = months == null ? 0.2 : months <= 3 ? 0.7 : months <= 12 ? 0.35 : months <= 24 ? 0.15 : 0.08;
          return {
            s,
            why: `hands over ${when || 'on an unstated date'}, and they want to move in now`,
            veto: s <= 0.08 ? `possession ${when}, and they need somewhere ready now` : undefined
          };
        }
        if (r.possession.want === 'upcoming') {
          return p.ready
            ? { s: 0.4, why: 'ready to move, but they were after a project still under construction' }
            : { s: 1, why: 'under construction, as they wanted' };
        }
        if (r.possession.want === 'by') {
          const need = r.possession.label || fmtMonth(r.possession.at);
          if (p.ready) return { s: 1, why: `ready now, ahead of ${need}` };
          if (!at) return { s: 0.3, why: `no possession date on record, and they need it ${need}` };
          if (at <= r.possession.at) return { s: 1, why: `hands over ${when}, inside their deadline (${need})` };
          const late = (at - r.possession.at) / (30 * DAY);
          return { s: late <= 3 ? 0.6 : late <= 6 ? 0.4 : late <= 12 ? 0.2 : 0.08, why: `hands over ${when}, about ${Math.max(1, Math.round(late))} months after they need it (${need})` };
        }
        return null;
      }
    },

    {
      key: 'specs', label: 'What they asked for', weight: 10,
      // Every named ask — rooms, parking, a lift, a school or hospital nearby — in one line,
      // three ways: has it, plainly does not, not on record. Weighted by how many they raised:
      // four asks matter more than one.
      score(r, p) {
        const keys = (r.specs && r.specs.keys) || [];
        const others = (r.specs && r.specs.other) || [];
        if (!keys.length && !others.length) return null;
        const have = [], lack = [], ask = [];
        let sum = 0;
        for (const o of others) {
          if (otherAskHas(o, p) === 1) { have.push(o); sum += 1; } else { ask.push(o); sum += 0.5; }
        }
        for (const k of keys) {
          const sp = SPEC_BY_KEY[k];
          const v = specHas(sp, p);
          if (v == null) { ask.push(sp.label); sum += 0.45; }
          else if (v >= 0.99) { have.push(sp.label); sum += 1; }
          else if (v > 0) { have.push(sp.label + ' (not confirmed covered)'); sum += v; }
          else { lack.push(sp.label); }
        }
        const n = keys.length + others.length;
        const s = sum / n;
        const parts = [];
        if (have.length) parts.push(`has ${list(have)}`);
        if (lack.length) parts.push(`no ${list(lack)}`);
        if (ask.length) parts.push(`${list(ask)} not on record`);
        return {
          s, weight: Math.min(16, 4 + 3 * n),
          why: parts.join('; ') + ` — of the ${n === 1 ? 'one thing' : n + ' things'} they asked for`,
          unknowns: ask.map(a => ({ label: a, why: `${a} — they asked for it; not on record for this property`, ask: `Check with the owner: ${a.toLowerCase()}` }))
        };
      }
    },

    {
      key: 'taste', label: 'Like what they liked', weight: 6,
      // Revealed taste: a property close to one they visited or were keen on — same kind, same
      // part of town, same money — is the likeliest yes. Only ever scored for, never against:
      // not resembling a past property is not a reason to skip one.
      score(r, p) {
        const same = x => x.p === p.p || (x.p.id != null && x.p.id === (p.p && p.p.id)) || (!!p.name && String(x.p.name || '').trim().toLowerCase() === String(p.name).trim().toLowerCase());
        const liked = (r.seen || []).filter(x => x.liked && !same(x));
        if (!liked.length) return null;
        let best = null;
        for (const x of liked) {
          let v = 0;
          if (x.type && x.type === p.type) v += 0.3;
          const km = p.localities[0] && x.localities[0] ? G().distanceKm(p.localities[0], x.localities[0]) : null;
          if (km != null) v += km <= 3 ? 0.4 : km <= 6 ? 0.2 : 0;
          if (x.priceLo && p.priceLo && x.priceMode === p.priceMode) v += Math.abs(p.priceLo / x.priceLo - 1) <= 0.2 ? 0.3 : 0;
          if (!best || v > best.v) best = { v, x };
        }
        if (!best || best.v < 0.7) return null;
        return { s: 1, why: `much like ${best.x.label}, which they ${best.x.visited ? 'visited' : 'were keen on'} — same kind, area and price` };
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
  const GATED = { locality: true, type: true, bhk: true };

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
    const unknowns = [];
    let earned = 0, available = 0, coreKnown = 0;
    const vetoes = [];
    const caps = [];

    for (const attr of ATTRIBUTES) {
      let res = null;
      try { res = attr.score(req, prop, c); } catch (e) { res = null; }
      if (!res) continue;
      if (res.cap != null) caps.push({ key: attr.key, label: attr.label, cap: res.cap });
      if (res.unknown) {
        // Not known is not a pass: it is scored at the prior and said out loud.
        const prior = res.prior != null ? res.prior : attr.prior == null ? 0.5 : attr.prior;
        earned += prior * attr.weight;
        available += attr.weight;
        unknowns.push({ key: attr.key, label: attr.label, why: res.why, ask: res.ask, lost: round1((1 - prior) * attr.weight) });
        breakdown.push({ key: attr.key, label: attr.label, s: prior, points: round1(prior * attr.weight), of: attr.weight, why: res.why, unknown: true, veto: false });
        continue;
      }
      const w = res.weight || attr.weight;
      const s = Math.max(0, Math.min(1, res.s));
      const points = s * w;
      earned += points;
      available += w;
      if (attr.core) coreKnown += attr.weight;
      if (res.veto) vetoes.push({ key: attr.key, label: attr.label, why: res.veto });
      if (res.unknowns) res.unknowns.forEach(u => unknowns.push(Object.assign({ key: attr.key + ':' + u.label, lost: 0 }, u)));
      breakdown.push({
        key: attr.key, label: attr.label, s,
        points: round1(points), of: w,
        why: res.why || res.veto, veto: !!res.veto
      });
    }

    const objections = applyObjections(req, prop);
    objections.forEach(o => { if (o.veto) vetoes.push({ key: o.kind, label: o.label, why: o.veto }); });
    const penalty = objections.reduce((n, o) => n + o.points, 0);

    // Sold out is not a judgement call.
    if (prop.soldOut) vetoes.push({ key: 'soldOut', label: 'Availability', why: 'marked sold out' });

    // Their deal-breakers, as the AI heard them — shown to be checked, not guessed at.
    (req.dealBreakers || []).slice(0, 3).forEach(d => unknowns.push({ key: 'breaker:' + d, label: 'Deal-breaker', why: `they ruled out: ${d}`, ask: `Check this one is not ${d}`, lost: 0 }));

    let fit = available > 0 ? Math.max(0, (earned - penalty) / available) : 0;
    // ── Gates ── Location and kind are not just two weights among many: a flat 6 km from where
    // they asked, or an apartment for someone who wants an independent house, cannot be a strong
    // match however well the rest fits ("do not award high scores merely because the budget
    // matches"). A known, weak score on either caps the whole fit.
    const gates = [];
    for (const b of breakdown) {
      if (!GATED[b.key] || b.unknown || b.veto) continue;
      // 1.0 → no cap; the next block (0.82) → 88; 3–4 km (0.65) → 77; 5–8 km → ~58; 10 km → below 50.
      // Bedrooms gate more gently: one room more (0.6) is a real option to put to them → at most 80.
      const cap = b.key === 'bhk' ? 0.5 + 0.5 * b.s : 0.35 + 0.65 * b.s;
      if (fit > cap) { gates.push({ key: b.key, label: b.label, cap: Math.round(cap * 100) }); fit = cap; }
    }
    for (const c of caps) if (fit > c.cap) { gates.push({ key: c.key, label: c.label, cap: Math.round(c.cap * 100) }); fit = c.cap; }
    const confidence = CORE_WEIGHT > 0 ? coreKnown / CORE_WEIGHT : 0;

    // Why it matches, why it does not, and what we do not know yet — all of it, biggest first.
    // The panel decides how much to show.
    // Matched (✓) only when it really fits; a real-but-imperfect alternative (one room more, a
    // few km away, a little over) is PARTIAL (~) — still listed with what it costs, never as a tick.
    const forList = breakdown
      .filter(b => !b.unknown && b.s >= 0.75 && b.why && !b.veto)
      .sort((a, b) => b.points - a.points);

    const againstList = breakdown
      .filter(b => !b.unknown && b.s < 0.75 && b.why && !b.veto)
      .map(b => ({ key: b.key, label: b.label, why: b.why, lost: round1(b.of - b.points), partial: b.s >= 0.4 }))
      .concat(objections.map(o => ({ key: o.kind, label: o.label, why: o.why, lost: round1(o.points), quote: o.quote, at: o.at })))
      .sort((a, b) => b.lost - a.lost);

    unknowns.sort((a, b) => b.lost - a.lost);

    return {
      pct: Math.round(fit * 100),
      fit, confidence,
      rank: fit * (0.6 + 0.4 * confidence),
      for: forList, against: againstList, unknown: unknowns,
      vetoed: vetoes.length > 0, vetoes, gates,
      earned: round1(earned), available: round1(available), penalty: round1(penalty),
      objections, breakdown
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INTEREST — how keen the buyer is right now
  // ═══════════════════════════════════════════════════════════════════════
  //
  // A match is two questions: does the property fit them, and are they still
  // in the market for it. The second is read from what they have DONE —
  // TailorTalk's heat, how far the lead has got (visited, negotiating), the
  // AI's urgency, and how recently anyone heard from them. It orders the
  // buyers for a property; it never moves the percentage.
  function interestOf(lead, now) {
    if (!lead) return null;
    const t = now || Date.now();
    const tt = lead.tt || {}, ai = lead.ai || {};
    let s = 0.45;
    const why = [];
    const heat = String(tt.status || '').toLowerCase();
    if (heat === 'hot') { s += 0.25; why.push('hot on WhatsApp'); }
    else if (heat === 'warm') { s += 0.1; why.push('warm on WhatsApp'); }
    else if (heat === 'cold') { s -= 0.12; why.push('gone cold on WhatsApp'); }
    else if (heat === 'dead') { s -= 0.3; why.push('marked dead on WhatsApp'); }
    const stage = ai.stage;
    if (stage === 'negotiation') { s += 0.2; why.push('negotiating'); }
    else if (stage === 'visit_done' || lead.siteVisitStatus === 'done') { s += 0.15; why.push('has visited'); }
    else if (stage === 'visit_pending' || ['scheduled', 'requested'].includes(lead.siteVisitStatus)) { s += 0.1; why.push('a visit is planned'); }
    else if (stage === 'on_hold') { s -= 0.15; why.push('on hold'); }
    else if (stage === 'lost') { s -= 0.3; why.push('reads as lost'); }
    if (ai.urgency === 'high') { s += 0.08; why.push('urgent'); }
    else if (ai.urgency === 'low') { s -= 0.08; why.push('just browsing'); }
    const last = Math.max(tt.lastMessageAt || 0, (lead.lastNote && lead.lastNote.createdAt) || 0, lead.contactAt || 0,
      lead.siteVisitAt && lead.siteVisitAt < t ? lead.siteVisitAt : 0);
    if (last) {
      const days = Math.floor((t - last) / DAY);
      if (days <= 3) { s += 0.08; why.push('in touch in the last 3 days'); }
      else if (days <= 14) { s += 0.03; why.push(`in touch ${days} days ago`); }
      else if (days > 120) { s -= 0.18; why.push(`quiet for ${days} days`); }
      else if (days > 60) { s -= 0.1; why.push(`quiet for ${days} days`); }
    }
    s = Math.max(0.02, Math.min(0.98, s));
    const level = s >= 0.7 ? 'High' : s >= 0.45 ? 'Medium' : 'Low';
    return { s, level, why };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THE THREE DIRECTIONS
  // ═══════════════════════════════════════════════════════════════════════

  // Leads that cannot buy anything: sellers, vendors, collaborations, and
  // anyone already closed. Matching them to a property would fill the panel
  // with noise and hide the three people who matter.
  const DEAD_STAGES = new Set(['lost', 'won']);

  // A lead's requirement, read once per lead per inventory per hour. A property's "who wants this?"
  // reads every lead in the CRM; reading each one's texts again for every property opened made the
  // panel the slowest thing on the page.
  const reqCache = new WeakMap();
  function cachedRequirement(lead, o) {
    const now = o.now || Date.now();
    const bucket = Math.floor(now / 3600000);
    const hit = reqCache.get(lead);
    if (hit && hit.inv === (o.inventory || null) && hit.bucket === bucket) return hit.reqs;
    const reqs = requirementProfiles(lead, { now, inventory: o.inventory });
    reqCache.set(lead, { inv: o.inventory || null, bucket, reqs });
    return reqs;
  }
  // The cheap half of the vetoes, with no reasons attached — only ever used to skip a pair that
  // score() would rule out anyway.
  function quickVeto(r, p) {
    const has = p.deal || 'sale';
    if (r.deal && r.deal.values.length && !r.deal.values.includes(has) && !(r.deal.values.includes('jv') && (p.jv || has === 'sale'))) return true;
    if (r.types && r.types.values.length && p.homeLikely && r.types.values.every(t => t === 'Plot' || t === 'Commercial')) return true;
    if (r.types && r.types.values.length && p.type && p.type !== 'Other' && !r.types.values.includes(p.type)) {
      const RESI = ['Apartment', 'Villa', 'House'];
      const wantsResi = r.types.values.some(t => RESI.includes(t));
      if (wantsResi && (p.type === 'Plot' || p.type === 'Commercial')) return true;
      if (!wantsResi && RESI.includes(p.type)) return true;
    }
    return false;
  }
  function farApart(r, p) {
    const L = r.localities;
    if (!L || !L.firm || !L.keys.length || L.radiusKm || !p.localities || !p.localities.length) return false;
    if (L.corridors && L.corridors.length && p.corridors && p.corridors.some(c => L.corridors.includes(c))) return false;
    const geo = G();
    let best = Infinity;
    for (const w of L.keys) for (const h of p.localities) {
      const km = geo.distanceKm(h, w);
      if (km == null) return false;      // somewhere we cannot place: never skipped on a guess
      if (km < best) best = km;
    }
    return best > 10;
  }
  const hasSomething = req => !!(req && (req.budget || req.localities || req.bhk || req.types || (req.deal && req.deal.values.includes('jv'))));

  // Closed, whatever the page passed: the live pipeline names its closed stages closed_lost and
  // closed_won, and a caller that forgot stageKeyOf (the agents' "buyers with other agents" list did)
  // was offering lost clients as buyers.
  const CLOSED_ID = /(?:^|[_\s-])(?:lost|won|closed|dead|junk|spam|not[_\s-]?interested)(?:$|[_\s-])/i;
  function isClosedLead(lead) {
    if (!lead) return true;
    if (CLOSED_ID.test(String(lead.stageId || '')) || CLOSED_ID.test(String(lead.status || ''))) return true;
    if (lead.lostReason || lead.closedAt) return true;
    return false;
  }
  function isBuyerLead(lead, stageKeyOf) {
    if (!lead) return false;
    if (lead.deleted || lead.mergedInto) return false;
    const intent = lead.ai && lead.ai.intent;
    if (intent === 'sell' || intent === 'rent_out' || intent === 'vendor') return false;
    if (/seller|vendor|collaborat/i.test(String(lead.enquiryType || ''))) return false;
    if (stageKeyOf) {
      const k = stageKeyOf(lead);
      if (k && DEAD_STAGES.has(k)) return false;
      if (k && !DEAD_STAGES.has(k) && k !== 'open' && CLOSED_ID.test(String(k))) return false;
    } else if (isClosedLead(lead)) return false;
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
    ctx.now = o.now || Date.now();
    const min = o.minPct == null ? 45 : o.minPct;
    const out = [];

    for (const lead of (leads || [])) {
      if (!isBuyerLead(lead, o.stageKeyOf)) continue;
      const reqs = o.notesFor ? requirementProfiles(lead, { now: o.now, inventory: o.inventory, notes: o.notesFor(lead) })
        : cachedRequirement(lead, o);
      // Each live requirement is scored; the lead is listed once, under the one that fits best.
      let best = null;
      for (const req of reqs) {
        // Nothing at all to go on — no budget, no area, no configuration. A
        // score here would be a guess dressed as a number.
        if (!hasSomething(req)) continue;
        // A pair the full score would only veto (rent against sale, land against a flat) is not
        // scored at all when vetoed pairs are not wanted — most of a big CRM, for most properties.
        if (!o.includeVetoed && quickVeto(req, prop)) continue;
        // …and one more than 10 km from everywhere they named: the location gate would cap it below
        // any useful threshold, so it is not worth the full score either.
        if (!o.includeVetoed && min >= 55 && farApart(req, prop)) continue;
        const s = score(req, prop, ctx);
        const key = (s.vetoed ? 0 : 1) * 1000 + s.rank;
        if (!best || key > best.key) best = { key, req, s };
      }
      if (!best) continue;
      const { req, s } = best;
      if (s.vetoed && !o.includeVetoed) continue;
      if (!s.vetoed && s.pct < min) continue;
      const interest = interestOf(lead, ctx.now);
      s.rank = s.rank * (0.7 + 0.3 * (interest ? interest.s : 0.45));
      out.push(Object.assign({ lead, req, property: prop, interest, reqIndex: req.reqIndex || 0, reqCount: reqs.length }, s));
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
    // A lead may hold more than one live requirement; a profile (or a typed brief) is just one.
    const reqs = lead && lead.kind ? [lead]
      : (o.reqIndex != null ? requirementProfiles(lead, { now: o.now, inventory: list, notes: o.notes }).filter(r => r.reqIndex === o.reqIndex)
        : requirementProfiles(lead, { now: o.now, inventory: list, notes: o.notes }));
    const req0 = reqs[0];
    // The idf table and the area model are cached on the list itself, so the caller's own array is
    // passed whenever it holds plain properties; a mixed list (PinSources) passes its own cached
    // raw list (list.raw) for the same reason.
    const mixed = list.some(x => x && x.kind && x.p);
    const rawList = !mixed ? list : (list.raw || list.map(x => (x && x.kind && x.p ? x.p : x)).filter(x => x && !String(x.id || '').startsWith('owner:')));
    const ctx = { idf: idfFor(rawList), area: o.area || areaModelFor(rawList, o.extraListings || null), now: o.now || Date.now() };
    const min = o.minPct == null ? 45 : o.minPct;
    const already = new Set(((req0 && req0.seen) || []).map(x => String(x.p.id)));
    const out = [];

    for (const p of list) {
      // An entry may already be a profile (an un-onboarded card or seller lead from PinSources).
      const prop = p && (p.kind === 'property' || p.kind === 'listing' || p.kind === 'owner') && p.p ? p : propertyProfile(p);
      const raw = prop.p || p;
      const seen = already.has(String(raw.id));
      if (seen && !o.includeSeen) continue;
      let best = null;
      for (const req of reqs) {
        const sc = score(req, prop, ctx);
        const key = (sc.vetoed ? 0 : 1) * 1000 + sc.rank;
        if (!best || key > best.key) best = { key, req, s: sc };
      }
      if (!best) continue;
      const { req, s } = best;
      if (s.vetoed && !o.includeVetoed) continue;
      if (!s.vetoed && s.pct < min) continue;
      out.push(Object.assign({ p: raw, property: prop, req, reqIndex: req.reqIndex || 0, alreadyShared: seen }, s));
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
      let blocked = false, onlyArea = true;
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
        else { missing.push(clauseLabel(c)); if (!isAreaClause(c)) onlyArea = false; }
      }
      if (blocked) continue;
      // Missing nothing but the AREA means "right property, wrong part of town": the nearby-areas
      // group already offers those within a few km, so a 3BHK in Whitefield is not a near miss
      // of a T Nagar search.
      if (o.skipAreaOnly && missing.length && onlyArea) continue;
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

  // A clause that is only a place: every leaf resolves to a locality on the Chennai area map.
  function isAreaClause(c) {
    const geo = G(), L = geo.LOCALITIES || {};
    if (c.negate || !c.leaves.length) return false;
    return c.leaves.every(leaf => {
      const t = leaf.kind === 'gaz' ? ((leaf.entry && leaf.entry.raw) || leaf.text)
        : (leaf.kind === 'text' || leaf.kind === 'phrase' || (leaf.kind === 'scoped' && leaf.field === 'area')) ? leaf.text : null;
      const k = t ? geo.resolve(t) : null;
      return !!(k && L[k]);
    });
  }

  // ═══════ NEARBY AREAS ═══════
  //
  // "T Nagar 3BHK" with five T Nagar listings should still show the 3BHK in Kodambakkam, two
  // kilometres away — as its own group under the exact hits, never mixed into them, each
  // saying how far and from where. Everything else the person typed must still hold (rent/sale,
  // BHK, budget…): only the AREA is relaxed, and only to places the Chennai area map puts within
  // a few kilometres. A property is placed by its dropped pin when it has one, else by the
  // places its Location names.
  function nearbyAreas(list, text, opts) {
    const o = opts || {};
    const eng = S(), geo = G();
    const gaz = o.gazetteer || eng.buildGazetteer(list);
    const clauses = eng.parseQuery(text, gaz);
    if (!clauses.length) return [];
    const maxKm = o.km == null ? 5 : o.km;
    const L = geo.LOCALITIES || {};

    const areaKey = leaf => {
      const t = leaf.kind === 'gaz' ? ((leaf.entry && leaf.entry.raw) || leaf.text)
        : (leaf.kind === 'text' || leaf.kind === 'phrase' || (leaf.kind === 'scoped' && leaf.field === 'area')) ? leaf.text : null;
      const k = t ? geo.resolve(t) : null;
      return k && L[k] ? k : null;
    };
    const targets = [], rest = [];
    for (const c of clauses) {
      const keys = c.negate ? [] : c.leaves.map(areaKey);
      if (keys.length && keys.every(Boolean)) keys.forEach(k => { if (!targets.includes(k)) targets.push(k); });
      else rest.push(c);
    }
    if (!targets.length) return [];

    const exclude = new Set((o.exclude || []).map(p => p.id));
    const out = [];
    for (const p of list) {
      if (exclude.has(p.id)) continue;
      // Where it is: the pin, else the places its Location (then its name) names.
      let points = [], names = [];
      const g = p.geo;
      if (g && isFinite(Number(g.lat)) && isFinite(Number(g.lng)) && Number(g.lat) && Number(g.lng)) {
        points = [[Number(g.lat), Number(g.lng)]]; names = ['its pin'];
      } else {
        let at = geo.placeOf([p.location, p.zone].filter(Boolean).join(', ')).at;
        if (!at.length) at = geo.placeOf(p.name || '').at;
        at = at.filter(k => L[k]);
        points = at.map(k => L[k]); names = at;
      }
      if (!points.length) continue;
      // Already in the area asked for: the exact search had its say about it.
      if (names.some(n => targets.includes(n))) continue;
      let best = null;
      for (const t of targets) points.forEach((pt, i) => {
        const km = geo.haversine(L[t], pt);
        if (!best || km < best.km) best = { km, from: t, where: names[i] };
      });
      if (!best || best.km > maxKm) continue;
      // Everything that is not the area still has to hold.
      const rec = eng.indexProperty(p);
      let ok = true;
      for (const c of rest) {
        let hit = false;
        for (const leaf of c.leaves) if (leafHolds(eng, rec, leaf, p, gaz)) { hit = true; break; }
        if (c.negate ? hit : !hit) { ok = false; break; }
      }
      if (!ok) continue;
      out.push({ p, km: best.km, from: geo.label(best.from), where: best.where === 'its pin' ? 'its pin' : geo.label(best.where) });
    }
    out.sort((a, b) => a.km - b.km);
    return o.limit ? out.slice(0, o.limit) : out;
  }

  // Properties that READ like the search without containing its words — "school", "metro",
  // "gated community", "investment" — found through the concept vectors, for the person whose
  // words are not the sheet's. The facets they set (rent/sale, type, status) still have to hold.
  function similarTo(list, text, opts) {
    const o = opts || {};
    const eng = S();
    const gaz = o.gazetteer || eng.buildGazetteer(list);
    const clauses = eng.parseQuery(text, gaz);
    const exclude = new Set((o.exclude || []).map(p => p.id));
    const pool = list.filter(p => !exclude.has(p.id));
    const facetLeaves = [];
    clauses.forEach(c => { if (!c.negate) c.leaves.forEach(l => { if (l.kind === 'facet' && c.leaves.length === 1) facetLeaves.push(l); }); });
    const out = [];
    const wanted = Object.keys(conceptsOf(text));
    for (const x of semanticRank(pool, text, { floor: o.floor == null ? 0.12 : o.floor })) {
      const rec = eng.indexProperty(x.p);
      if (!facetLeaves.every(l => leafHolds(eng, rec, l, x.p, gaz))) continue;
      const have = conceptsOf(propertyText(x.p));
      const shared = wanted.filter(k => have[k]);
      out.push({ p: x.p, sim: x.sim, why: shared.slice(0, 2).map(k => CONCEPT_LABEL[k] || k) });
      if (o.limit && out.length >= o.limit) break;
    }
    return out;
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

  const MONTH_NAME = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtMonth(at) {
    if (!at) return '—';
    const d = new Date(at);
    return MONTH_NAME[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  // "a, b and c"
  const list = xs => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);

  // A property's price as a person says it: "₹1.25 Cr", "₹45,000 a month", "₹30 L lease".
  function priceLabel(prof) {
    if (!prof || prof.priceLo == null) return '';
    const per = prof.priceMode === 'monthly' ? ' a month' : prof.priceMode === 'lumpsum' ? ' lease' : '';
    return fmtMoney(prof.priceLo) + per + (prof.deal === 'rent' && !per ? ' (rent)' : '');
  }

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
    requirementProfile, requirementProfiles, reqSentence, activeItems, reqFingerprint, briefProfile, propertyProfile, listingProfile, ownerPropertyProfile,
    readExclusions, excludedHit, subtypeOf, subNear, SUBTYPES, SUB_LABEL, JV_RE, isClosedLead,
    // the hybrid search layer
    fuse, semanticRank, nearMisses, nearbyAreas, similarTo,
    // geography
    areaModelFor, legacyProximity,
    // vectors, exported for the tests and for reuse
    embed, cosine, conceptsOf, idfFor, propertyText, leadTexts,
    // extraction pieces, exported for the tests
    readBudget, readBhk, readTypes, readLocalities, readSize, readPossession,
    readObjections, readRoadWidth, readFacets, isBuyerLead,
    readDeal, propertyDeal, readSpecs, specHas, interestOf, cleanWant, readWhen,
    // presentation
    fmtMoney, fmtArea, band, priceLabel,
    // the table itself — the UI reads it to explain the scoring
    ATTRIBUTES, OBJECTIONS, CONCEPTS, CONCEPT_LABEL, CORE_WEIGHT, VETO_MIN_WEIGHT, SPECS
  };
  root.PinMatch = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
