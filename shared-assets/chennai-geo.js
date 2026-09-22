// ═══════════════════════════════════════════════════════════════════════════
// CHENNAI GEOGRAPHY — the reference data behind "or somewhere near it"
// ═══════════════════════════════════════════════════════════════════════════
//
// Every Chennai enquiry states location the same way: a locality, then a
// hedge. "3BHK in Anna Nagar — or nearby." "Anywhere on OMR." "Adyar side."
// No amount of string matching can answer that, and getting it wrong is
// expensive in both directions:
//
//   · "Anna Nagar" and "Aminjikarai" share a border and not one character.
//   · "Anna Nagar" and "Anna Salai" share nine characters and six kilometres.
//
// Text similarity ranks both of those exactly backwards. Coordinates do not.
//
// ── WHAT THESE COORDINATES ARE ─────────────────────────────────────────────
//
// Approximate locality centroids, good to roughly a kilometre, for ONE
// purpose: deciding how near two localities are to each other so a match can
// be ranked. They are deliberately NOT:
//
//   · addresses — a locality is tens of thousands of people, not a door
//   · plotted on any map in the product
//   · quoted to the user tighter than "about N km"
//
// A property's own map pin (p.mapLink) is the authority on where it actually
// is. This file only answers "is this the right part of town".
//
// ── COVERAGE AND WHAT HAPPENS WITHOUT IT ───────────────────────────────────
//
// Every locality in the live inventory, plus the rest of the metro an enquiry
// realistically names. A locality that is missing is not an error and not a
// guess: distanceKm() returns null, and the caller falls back to corridor,
// then zone, then plain text — each worth less than the last. That laddering
// is what lets a hand-typed "Periya Palayatamman Nagar" still match on its
// zone instead of scoring zero or, worse, inventing a position for it.
//
// Pure data and four pure functions. No DOM, no network. Plain script for the
// classic pages (window.PinGeo), module.exports for node and the ES modules.

(function (root) {
  'use strict';

  // ═══════ LOCALITY CENTROIDS ═══════
  // Grouped the way a Chennai agent groups the city, which is also how the
  // Zone column in the Inventory sheet is filled in.
  const LOCALITIES = {
    // ── Central ──
    'anna nagar': [13.085, 80.210], 'anna nagar west': [13.088, 80.198],
    'anna nagar east': [13.086, 80.218], 'anna nagar west extension': [13.091, 80.193],
    'shenoy nagar': [13.078, 80.224], 'aminjikarai': [13.073, 80.221],
    'kilpauk': [13.079, 80.240], 'kilpauk garden colony': [13.081, 80.238],
    'ayanavaram': [13.099, 80.234], 'purasawalkam': [13.093, 80.252],
    'egmore': [13.078, 80.261], 'chetpet': [13.071, 80.244],
    'nungambakkam': [13.058, 80.242], 'mahalingapuram': [13.055, 80.235],
    'kamdar nagar': [13.048, 80.236], 'sterling road': [13.062, 80.240],
    't nagar': [13.040, 80.234], 'kodambakkam': [13.051, 80.226],
    'vadapalani': [13.050, 80.212], 'ashok nagar': [13.035, 80.212],
    'cit nagar': [13.033, 80.238], 'teynampet': [13.041, 80.247],
    'gopalapuram': [13.049, 80.257], 'poes garden': [13.041, 80.250],
    'alwarpet': [13.033, 80.253], 'abhiramapuram': [13.035, 80.257],
    'mylapore': [13.033, 80.269], 'royapettah': [13.053, 80.264],
    'mount road': [13.060, 80.264], 'anna salai': [13.060, 80.264],
    'chintadripet': [13.071, 80.268], 'triplicane': [13.060, 80.278],
    'koyambedu': [13.070, 80.194], 'arumbakkam': [13.073, 80.208],

    // ── North ──
    'madhavaram': [13.148, 80.231], 'korattur': [13.109, 80.184],
    'ambattur': [13.098, 80.162], 'mogappair': [13.084, 80.175],
    'nolambur': [13.075, 80.171], 'ayyapakkam': [13.095, 80.140],
    'perambur': [13.111, 80.245], 'kolathur': [13.120, 80.211],
    'villivakkam': [13.106, 80.208], 'thiruvottiyur': [13.158, 80.303],
    'red hills': [13.185, 80.178], 'avadi': [13.115, 80.102],

    // ── West ──
    'vanagaram': [13.056, 80.152], 'maduravoyal': [13.061, 80.164],
    'valasaravakkam': [13.043, 80.176], 'saligramam': [13.050, 80.196],
    'nesapakkam': [13.027, 80.190], 'k k nagar': [13.032, 80.199],
    'ramapuram': [13.032, 80.178], 'dlf ramapuram': [13.032, 80.178],
    'manapakkam': [13.013, 80.174], 'mugalivakkam': [13.018, 80.163],
    'porur': [13.038, 80.158], 'iyyappanthangal': [13.024, 80.128],
    'kattupakkam': [13.036, 80.124], 'gerugambakkam': [13.010, 80.140],
    'kolapakkam': [13.005, 80.135], 'mangadu': [13.032, 80.109],
    'poonamallee': [13.048, 80.096], 'nazarathpet': [13.035, 80.083],
    'kundrathur': [12.997, 80.096], 'kovur': [12.995, 80.115],
    'sriperumbudur': [12.966, 79.944], 'valarpuram': [13.020, 79.980],
    'oragadam': [12.796, 79.955], 'ikkadu': [13.213, 79.979],
    'thirumazhisai': [13.052, 80.043], 'mevalurkuppam': [12.990, 79.990],

    // ── South-west, along GST ──
    'ekkatuthangal': [13.016, 80.204], 'guindy': [13.010, 80.212],
    'nanganallur': [12.980, 80.190], 'adambakkam': [12.988, 80.203],
    'madipakkam': [12.963, 80.197], 'keelkattalai': [12.945, 80.186],
    'pallavaram': [12.968, 80.150], 'pozhichalur': [12.975, 80.128],
    'anakaputhur': [12.978, 80.130], 'chromepet': [12.951, 80.140],
    'tambaram': [12.922, 80.127], 'mudichur': [12.907, 80.077],
    'perungalathur': [12.903, 80.096], 'vandalur': [12.891, 80.081],
    'guduvanchery': [12.845, 80.059],
    'maraimalai nagar': [12.792, 80.024], 'singaperumal koil': [12.760, 80.005],
    'chengalpattu': [12.692, 79.977],

    // ── South, along OMR ──
    'velachery': [12.975, 80.221], 'pallikaranai': [12.936, 80.205],
    'perumbakkam': [12.905, 80.197], 'medavakkam': [12.917, 80.192],
    'mambakkam': [12.882, 80.176], 'vengaivasal': [12.906, 80.169],
    'ottiyambakkam': [12.897, 80.181], 'ponmar': [12.879, 80.161],
    'melakottaiyur': [12.865, 80.152], 'perungudi': [12.962, 80.243],
    'thoraipakkam': [12.939, 80.232], 'karapakkam': [12.925, 80.228],
    'sholinganallur': [12.901, 80.227], 'navalur': [12.848, 80.227],
    'siruseri': [12.822, 80.212], 'padur': [12.822, 80.231],
    'kelambakkam': [12.786, 80.221], 'thiruporur': [12.722, 80.191],
    'taramani': [12.987, 80.243], 'thiruvanmiyur': [12.983, 80.259],

    // ── Central, the rest of it ──
    'r a puram': [13.017, 80.262], 'raja annamalai puram': [13.017, 80.262],
    'mandaveli': [13.026, 80.268], 'nandanam': [13.034, 80.239],
    'kotturpuram': [13.014, 80.244], 'saidapet': [13.022, 80.223],
    'west mambalam': [13.039, 80.219], 'mambalam': [13.039, 80.222],
    'choolaimedu': [13.060, 80.222], 'virugambakkam': [13.054, 80.190],
    'alwarthirunagar': [13.048, 80.184], 'thirumangalam': [13.085, 80.196],
    'boat club': [13.030, 80.250], 'vepery': [13.083, 80.263],
    'sowcarpet': [13.093, 80.278], 'washermanpet': [13.115, 80.285],
    'tondiarpet': [13.130, 80.290], 'royapuram': [13.108, 80.294],
    'alandur': [13.003, 80.203], 'st thomas mount': [12.995, 80.196],
    'nerkundram': [13.065, 80.178],

    // ── South, the OMR hinterland a buyer names by village ──
    'thalambur': [12.855, 80.222], 'egattur': [12.836, 80.224],
    'semmancheri': [12.878, 80.225], 'kazhipattur': [12.833, 80.226],
    'pudupakkam': [12.796, 80.212], 'nanmangalam': [12.925, 80.169],
    'kovilambakkam': [12.945, 80.197], 'sithalapakkam': [12.900, 80.181],
    'jalladianpet': [12.940, 80.190], 'perumbakkam': [12.905, 80.197],

    // ── GST, including the SRM belt ──
    'urapakkam': [12.865, 80.070], 'potheri': [12.823, 80.043],
    'kattankulathur': [12.820, 80.038], 'chitlapakkam': [12.938, 80.135],
    'selaiyur': [12.917, 80.138], 'rajakilpakkam': [12.923, 80.144],
    'hasthinapuram': [12.945, 80.132],

    // ── West and north ──
    'moulivakkam': [13.018, 80.152], 'thiruverkadu': [13.070, 80.108],
    'ayanambakkam': [13.075, 80.155], 'thirumullaivoyal': [13.125, 80.120],
    'retteri': [13.120, 80.196], 'padi': [13.100, 80.185],
    'karambakkam': [13.040, 80.163],

    // ── Coastal, along ECR ──
    'adyar': [13.006, 80.257], 'besant nagar': [13.000, 80.267],
    'kottivakkam': [12.963, 80.257], 'palavakkam': [12.955, 80.258],
    'neelankarai': [12.947, 80.258], 'akkarai': [12.937, 80.254],
    'vettuvankeni': [12.933, 80.253], 'injambakkam': [12.925, 80.251],
    'kanathur': [12.858, 80.242], 'muttukadu': [12.826, 80.243],
    'kovalam': [12.788, 80.254], 'mahabalipuram': [12.626, 80.192],
    'uthandi': [12.875, 80.248], 'panaiyur': [12.892, 80.244]
  };

  // ═══════ ALIASES ═══════
  //
  // Spellings the sheet and the enquiries actually use. Every entry is a
  // variant met in the live data or on a call — this is not a guess at what
  // someone might type, it is what they did type. A corridor name used as a
  // location ("looking on OMR") resolves to a representative point on it, and
  // CORRIDOR_MEMBERS below is what widens it back out to the whole stretch.
  const ALIASES = {
    't. nagar': 't nagar', 'thyagaraya nagar': 't nagar', 'tnagar': 't nagar',
    'annanagar': 'anna nagar', 'anna nagar w extn': 'anna nagar west extension',
    'anna nagar western extension': 'anna nagar west extension',
    'kk nagar': 'k k nagar', 'kknagar': 'k k nagar', 'k.k. nagar': 'k k nagar',
    'adayar': 'adyar', 'velacherry': 'velachery', 'velachary': 'velachery',
    'medavakam': 'medavakkam', 'sholinganallore': 'sholinganallur',
    'thoraipakam': 'thoraipakkam', 'ottiyampakkam': 'ottiyambakkam',
    'vengaivaasal': 'vengaivasal', 'anagakaputhur': 'anakaputhur',
    'iyyapanthangal': 'iyyappanthangal', 'nanganalloor': 'nanganallur',
    'mogappair west': 'mogappair', 'mogappair east': 'mogappair',
    'mogappair-nolambur': 'nolambur', 'mogappair - nolambur': 'nolambur',
    'pallikarnai': 'pallikaranai',
    'thiruvanmyur': 'thiruvanmiyur', 'tiruvanmiyur': 'thiruvanmiyur',
    'besantnagar': 'besant nagar', 'elliots beach': 'besant nagar',
    'chrompet': 'chromepet', 'kelambakam': 'kelambakkam',
    // The commonest variant of Velachery of all, and it was the one missing.
    'velacheri': 'velachery',
    'ekkaduthangal': 'ekkatuthangal', 'ekkatuthangal': 'ekkatuthangal',
    // The official name on the signboards and in the documents.
    'mamallapuram': 'mahabalipuram',
    'tiruporur': 'thiruporur', 'ayapakkam': 'ayyapakkam',
    'thuraipakkam': 'thoraipakkam', 'thoraippakkam': 'thoraipakkam',
    'redhills': 'red hills', 'covelong': 'kovalam',
    'tiruvottiyur': 'thiruvottiyur', 'thiruvotriyur': 'thiruvottiyur',
    'purasaiwakkam': 'purasawalkam', 'purasawakkam': 'purasawalkam',
    'r.a. puram': 'r a puram', 'ra puram': 'r a puram',
    'mount': 'st thomas mount',
    // Corridors named as a place.
    'omr': 'sholinganallur', 'rajiv gandhi salai': 'sholinganallur',
    'old mahabalipuram road': 'sholinganallur',
    'ecr': 'neelankarai', 'east coast road': 'neelankarai',
    'gst': 'tambaram', 'gst road': 'tambaram', 'grand southern trunk road': 'tambaram',
    'radial road': 'thoraipakkam', 'pallavaram radial road': 'thoraipakkam',
    'pallavaram thoraipakkam road': 'thoraipakkam',
    '200 ft radial road': 'thoraipakkam', '200ft radial road': 'thoraipakkam',
    'mount poonamallee road': 'porur', 'mount-poonamallee': 'porur',
    'arcot road': 'valasaravakkam', 'velachery tambaram road': 'pallikaranai',
    // Streets and landmarks that stand in for their locality.
    'gn chetty road': 't nagar', 'g n chetty road': 't nagar',
    'college road': 'nungambakkam', 'sivasamy salai': 'mylapore',
    'kalakshetra road': 'thiruvanmiyur', 'tidel park': 'taramani',
    'siruseri it park': 'siruseri',
    // The corridor synonyms a brief actually uses. CONCEPTS.it_corridor in
    // match-engine.js already understood "IT corridor" while the resolver
    // did not, so the engine knew what the buyer meant and could not place it.
    'it corridor': 'sholinganallur', 'it highway': 'sholinganallur',
    'nh 45': 'tambaram', 'nh45': 'tambaram',
    'orr': 'vandalur', 'outer ring road': 'vandalur',
    'lb road': 'thiruvanmiyur', 'lattice bridge road': 'thiruvanmiyur',
    'beach road': 'besant nagar',
    'guindy industrial estate': 'guindy', 'nazarethpet': 'nazarathpet'
    // Deliberately NOT aliased: "SIPCOT". There is a SIPCOT at Siruseri and
    // another at Sriperumbudur, 45 km apart. Aliasing it to either one put a
    // Valarpuram property (whose landmark reads "Sriperumbudur SIPCOT") next
    // door to Siruseri and dragged the whole estimate 33 km off. An
    // ambiguous landmark is worse than no landmark: leave it out and let the
    // area model work from the evidence that is not ambiguous.
  };

  // ═══════ CORRIDORS ═══════
  //
  // For the buyer who names a road instead of a locality. Every locality
  // within reach of the corridor is listed, so "anything on OMR" widens to
  // the whole stretch rather than collapsing onto the one representative
  // point ALIASES resolves it to.
  const CORRIDOR_MEMBERS = {
    // Thiruvanmiyur is on BOTH: OMR begins at Madhya Kailash and runs past
    // it, and LB Road/ECR runs through it.
    OMR: ['taramani', 'thiruvanmiyur', 'perungudi', 'thoraipakkam', 'karapakkam', 'sholinganallur', 'semmancheri', 'navalur', 'thalambur', 'egattur', 'siruseri', 'padur', 'kelambakkam', 'thiruporur'],
    ECR: ['besant nagar', 'thiruvanmiyur', 'kottivakkam', 'palavakkam', 'neelankarai', 'akkarai', 'vettuvankeni', 'injambakkam', 'panaiyur', 'uthandi', 'kanathur', 'muttukadu', 'kovalam', 'mahabalipuram'],
    GST: ['pallavaram', 'chromepet', 'tambaram', 'perungalathur', 'vandalur', 'urapakkam', 'guduvanchery', 'potheri', 'kattankulathur', 'maraimalai nagar', 'singaperumal koil', 'chengalpattu'],
    'Radial Road': ['thoraipakkam', 'pallikaranai', 'medavakkam', 'perumbakkam'],
    'Mount-Poonamallee': ['porur', 'manapakkam', 'mugalivakkam', 'iyyappanthangal', 'kattupakkam', 'poonamallee'],
    'Velachery-Tambaram': ['velachery', 'pallikaranai', 'medavakkam', 'keelkattalai', 'madipakkam', 'chromepet', 'tambaram'],
    // The Outer Ring Road — the fastest-moving industrial and residential
    // axis in the metro, and absent until now.
    ORR: ['vandalur', 'perungalathur', 'thirumazhisai', 'nazarathpet', 'poonamallee', 'vanagaram', 'ambattur', 'thiruverkadu', 'thirumullaivoyal']
  };

  // ═══════ ZONES ═══════
  //
  // The four values the Inventory sheet's Zone column uses. This is the
  // widest fallback — used only when neither side has coordinates, where it
  // is still worth something: two unknown localities in Chennai West are
  // more likely to suit the same buyer than one in the west and one in the
  // south.
  const ZONE_MEMBERS = {
    'Chennai Central': ['anna nagar', 'anna nagar west', 'anna nagar east', 'anna nagar west extension', 'shenoy nagar', 'aminjikarai', 'kilpauk', 'kilpauk garden colony', 'ayanavaram', 'purasawalkam', 'egmore', 'chetpet', 'nungambakkam', 'mahalingapuram', 'kamdar nagar', 'sterling road', 't nagar', 'kodambakkam', 'vadapalani', 'ashok nagar', 'cit nagar', 'teynampet', 'gopalapuram', 'poes garden', 'alwarpet', 'abhiramapuram', 'mylapore', 'royapettah', 'mount road', 'anna salai', 'chintadripet', 'triplicane', 'koyambedu', 'arumbakkam'],
    'Chennai North': ['madhavaram', 'korattur', 'ambattur', 'mogappair', 'nolambur', 'ayyapakkam', 'perambur', 'kolathur', 'villivakkam', 'thiruvottiyur', 'red hills', 'avadi'],
    'Chennai West': ['vanagaram', 'maduravoyal', 'valasaravakkam', 'saligramam', 'nesapakkam', 'k k nagar', 'ramapuram', 'dlf ramapuram', 'manapakkam', 'mugalivakkam', 'porur', 'iyyappanthangal', 'kattupakkam', 'gerugambakkam', 'kolapakkam', 'mangadu', 'poonamallee', 'nazarathpet', 'kundrathur', 'kovur', 'sriperumbudur', 'valarpuram', 'oragadam', 'thirumazhisai', 'mevalurkuppam', 'moulivakkam', 'thiruverkadu', 'ayanambakkam', 'karambakkam', 'nerkundram', 'virugambakkam', 'alwarthirunagar'],
    'Chennai South': ['ekkatuthangal', 'guindy', 'nanganallur', 'adambakkam', 'madipakkam', 'keelkattalai', 'pallavaram', 'pozhichalur', 'anakaputhur', 'chromepet', 'tambaram', 'mudichur', 'perungalathur', 'vandalur', 'guduvanchery', 'maraimalai nagar', 'singaperumal koil', 'chengalpattu', 'velachery', 'pallikaranai', 'perumbakkam', 'medavakkam', 'mambakkam', 'vengaivasal', 'ottiyambakkam', 'ponmar', 'melakottaiyur', 'perungudi', 'thoraipakkam', 'karapakkam', 'sholinganallur', 'navalur', 'siruseri', 'padur', 'kelambakkam', 'thiruporur', 'taramani', 'thiruvanmiyur', 'adyar', 'besant nagar', 'kottivakkam', 'palavakkam', 'neelankarai', 'akkarai', 'vettuvankeni', 'injambakkam', 'kanathur', 'muttukadu', 'kovalam', 'mahabalipuram']
  };

  const ZONE_OF = (() => {
    const out = {};
    for (const [zone, names] of Object.entries(ZONE_MEMBERS)) names.forEach(n => { out[n] = zone; });
    return out;
  })();

  const CORRIDOR_OF = (() => {
    const out = {};
    for (const [c, names] of Object.entries(CORRIDOR_MEMBERS)) {
      names.forEach(n => { (out[n] || (out[n] = [])).push(c); });
    }
    return out;
  })();

  // ═══════ RESOLUTION ═══════

  // The key a piece of location text resolves to, or null. Tolerant on
  // purpose: the Location column holds "Anna Nagar West (near Metro
  // Station)", "Gerugambakkam / Porur", "Chennai - 600080" and
  // "off Pallavaram–Thoraipakkam Road", none of which is a bare locality.
  //
  // The longest alias or locality contained in the text wins, so
  // "anna nagar west extension" is never mistaken for "anna nagar" — which
  // matters, because they are different price brackets.
  const norm = v => String(v == null ? '' : v)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[.,'’`()#]/g, ' ')
    .replace(/[^a-z0-9\-\/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Longest first, so containment cannot match a shorter name inside a
  // longer one. Built once — the lists never change at runtime.
  const KEYS_BY_LENGTH = Object.keys(LOCALITIES).sort((a, b) => b.length - a.length);
  const ALIAS_BY_LENGTH = Object.keys(ALIASES).sort((a, b) => b.length - a.length);

  function resolve(text) {
    const s = norm(text);
    if (!s) return null;
    if (LOCALITIES[s]) return s;
    if (ALIASES[s]) return ALIASES[s];
    // Whole-word containment. The \b-style guards stop "porur" matching
    // inside "tiruporur" and "adyar" inside "kadyaram".
    const contains = (hay, needle) => {
      const i = hay.indexOf(needle);
      if (i === -1) return false;
      const before = i === 0 ? ' ' : hay[i - 1];
      const after = i + needle.length >= hay.length ? ' ' : hay[i + needle.length];
      return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
    };
    for (const a of ALIAS_BY_LENGTH) if (contains(s, a)) return ALIASES[a];
    for (const k of KEYS_BY_LENGTH) if (contains(s, k)) return k;
    return null;
  }

  // Every locality named in one string. The Location column routinely holds
  // two ("Gerugambakkam / Porur", "Near Medavakkam / Mambakkam / Vengaivasal
  // / Ottiyambakkam"), and a property in both is genuinely in both as far as
  // a buyer is concerned.
  function resolveAll(text) {
    const s = norm(text);
    if (!s) return [];
    const out = [];
    const seen = new Set();
    // Split on the separators the sheet uses between two place names, then
    // resolve each part, so one part failing does not lose the others.
    for (const part of s.split(/[\/,]|\band\b|\bor\b/)) {
      const k = resolve(part);
      if (k && !seen.has(k)) { seen.add(k); out.push(k); }
    }
    if (!out.length) { const k = resolve(s); if (k) out.push(k); }
    return out;
  }

  // ═══════ DISTANCE ═══════

  const R_KM = 6371;
  const rad = d => d * Math.PI / 180;

  // Great-circle distance. Chennai is flat and small enough that road
  // distance is typically 1.2–1.4× this, which is why callers band the
  // result ("about 2 km", "same part of town") rather than quoting it.
  function haversine(a, b) {
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Kilometres between two locality names/texts, or null when either side is
  // not in the gazetteer. null means "unknown", never "far" — the caller has
  // to fall back rather than penalise a locality this file has not heard of.
  function distanceKm(a, b) {
    const ka = typeof a === 'string' ? resolve(a) : null;
    const kb = typeof b === 'string' ? resolve(b) : null;
    const pa = ka && LOCALITIES[ka], pb = kb && LOCALITIES[kb];
    if (!pa || !pb) return null;
    return haversine(pa, pb);
  }

  // The nearest gazetteer localities to a point, for "what else is around
  // here" — used to explain a near-miss ("2 km from Anna Nagar").
  function near(key, withinKm, limit) {
    const k = resolve(key);
    const p = k && LOCALITIES[k];
    if (!p) return [];
    const max = withinKm == null ? 5 : withinKm;
    return Object.keys(LOCALITIES)
      .filter(n => n !== k)
      .map(n => ({ key: n, km: haversine(p, LOCALITIES[n]) }))
      .filter(x => x.km <= max)
      .sort((x, y) => x.km - y.km)
      .slice(0, limit || 8);
  }

  function zoneOf(text) {
    const k = resolve(text);
    if (k && ZONE_OF[k]) return ZONE_OF[k];
    // The sheet's own Zone value, when it is already one of the four.
    const s = String(text || '').trim();
    return ZONE_MEMBERS[s] ? s : null;
  }

  function corridorsOf(text) {
    const k = resolve(text);
    return (k && CORRIDOR_OF[k]) ? CORRIDOR_OF[k].slice() : [];
  }

  // Title Case for display, from a gazetteer key. "k k nagar" → "K K Nagar",
  // "t nagar" → "T Nagar".
  function label(key) {
    return String(key || '').split(' ')
      .map(w => w ? w[0].toUpperCase() + w.slice(1) : w)
      .join(' ');
  }

  const api = {
    LOCALITIES, ALIASES, CORRIDOR_MEMBERS, CORRIDOR_OF, ZONE_MEMBERS, ZONE_OF,
    resolve, resolveAll, distanceKm, haversine, near, zoneOf, corridorsOf, label, norm
  };
  root.PinGeo = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
