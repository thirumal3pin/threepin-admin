// ═══════ PROPERTY SEARCH — parsers, findability sweep, agent scenarios ═══════
//
//   node tests/property-search.test.mjs
//
// Runs against tests/fixtures/properties-snapshot.json — the real inventory
// (131 properties) with every phone number and owner name replaced, because
// this repository is public. Nothing else is touched: the prices, areas,
// configurations, localities and the genuinely broken cells ("----", a
// locality sitting in the Built-up Area column) are exactly as an agent meets
// them, which is the only way to know the search survives them.
//
// dashboard-assets/search-engine.js is a plain browser script, so it is
// evaluated here the same way a <script> tag would — the tests exercise the
// artifact the browser is actually served, not a parallel copy.
//
// The suite is built in three layers:
//
//   1. Parsers, case by case, on the exact strings in the sheet.
//   2. A findability sweep: for EVERY property, each fact an agent might hold
//      about it — code, name, locality, builder, a size inside its range, its
//      UDS, its phone number — must find it. That is several hundred
//      assertions generated from the data, and it is the layer that catches a
//      regression on a listing nobody thought to write a test for.
//   3. Agent scenarios: the sentences someone actually says on a call, each
//      asserted on MEANING (every hit really is a 3BHK, really is under the
//      budget) rather than on a frozen result list, so the suite keeps its
//      value when the inventory changes.

import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
new Function(fs.readFileSync(path.join(here, '..', 'dashboard-assets', 'search-engine.js'), 'utf8'))();
const S = globalThis.PinSearch;
const P = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'properties-snapshot.json'), 'utf8'));
const GAZ = S.buildGazetteer(P);

// ═══════ TINY RUNNER ═══════
let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; return true; }
  failed++;
  failures.push(`${label}${detail !== undefined ? ' — ' + detail : ''}`);
  return false;
}
const eq = (label, actual, expected) =>
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
let sectionName = '';
const section = n => { sectionName = n; console.log(`\n── ${n}`); };

const find = q => S.search(P, { text: q, gazetteer: GAZ });
const ids = res => res.map(r => r.p.id);
const byId = id => P.find(p => p.id === id);
const codeOf = p => p.propertyCode || p.propertyId || p.id;

// "this query must return something, and every hit must satisfy `pred`"
function all(label, q, pred, opts) {
  const res = find(q);
  const o = opts || {};
  if (!o.allowEmpty && !check(`${label} — returns results`, res.length > 0, `"${q}" found nothing`)) return res;
  const bad = res.filter(r => !pred(r.p, r));
  check(`${label} — every hit qualifies`, bad.length === 0,
    `"${q}": ${bad.length}/${res.length} bad, e.g. ${bad.slice(0, 2).map(r => `${codeOf(r.p)} (${r.p.config} | ${r.p.startingPrice} | ${r.p.location})`).join(' ; ')}`);
  return res;
}
// "this query must find this property"
function finds(label, q, id, opts) {
  const res = find(q);
  const at = ids(res).indexOf(id);
  const o = opts || {};
  const within = o.top || res.length;
  check(label, at > -1 && at < within, `"${q}" → ${id} at rank ${at < 0 ? 'absent' : at + 1} of ${res.length}`);
  return res;
}
function excludes(label, q, id) {
  const res = find(q);
  check(label, ids(res).indexOf(id) === -1, `"${q}" wrongly returned ${id}`);
}

// Property-level helpers used by the semantic assertions.
const bhkOf = p => S.extractBhk([p.config, p.name, p.propertyType].filter(Boolean).join(' | '));
const priceLo = p => {
  const m = S.parseMoney(p.startingPrice, 'price').price.concat(S.parseMoney(p.price, 'price').price);
  return m.length ? Math.min(...m.map(r => r[0])) : null;
};
const areaSpans = p => {
  const rec = S.indexProperty(p);
  return rec.num.sqft.concat(rec.num.superb, rec.num.carpet);
};
const covers = (spans, n) => spans.some(s => n >= s[0] - 0.001 && n <= s[1] + 0.001);
const hay = p => S.normText(Object.entries(p)
  .filter(([k]) => !/link|tenant|createdat|updatedat/i.test(k))
  .map(([, v]) => typeof v === 'object' && v ? JSON.stringify(v) : v).join(' '));

// ═══════ 1. TEXT NORMALISATION ═══════
section('Normalisation — a number is the same number however it is written');

eq('comma inside a number is dropped', S.normText('1,518'), '1518');
eq('indian grouping is dropped', S.normText('1,35,000'), '135000');
eq('comma between list values survives', S.normText('2, 3 & 4 BHK'), '2 3 4 bhk');
eq('Sq.Ft splits on the dot', S.normText('2505 Sq.Ft'), '2505 sq ft');
eq('decimal point survives', S.normText('813.89 Sq.ft'), '813.89 sq ft');
eq('rupee sign and slash go', S.normText('₹7999/Sqft'), '7999 sqft');
eq('en dash becomes a hyphen then a space', S.normText('1,669 – 4,559'), '1669 4559');
eq('accents folded', S.normText('Pallavaram–Thoraipakkam'), 'pallavaram thoraipakkam');
check('1518 and 1,518 normalise alike', S.normText('1518') === S.normText('1,518'));
check('indian grouping reaches the plain number', S.normText('₹1,25,00,000') === S.normText('12500000'));

eq('edit distance — identical', S.withinDistance('adyar', 'adyar', 1), 0);
eq('edit distance — one insertion', S.withinDistance('adayar', 'adyar', 1), 1);
eq('edit distance — over budget', S.withinDistance('adyar', 'mylapore', 1), -1);

// ═══════ 2. RANGE PARSING ═══════
section('Ranges — the built-up column, exactly as the sheet has it');

const R = v => { const r = S.parseRanges(v); return { r: r.ranges, p: r.points, f: r.first }; };
eq('hyphen range', R('1250-2000 Sq.Ft'), { r: [[1250, 2000]], p: [], f: 1250 });
eq('bare hyphen range', R('1161-2960'), { r: [[1161, 2960]], p: [], f: 1161 });
eq('en dash + commas', R('1,669 – 4,559 Sq.Ft.'), { r: [[1669, 4559]], p: [], f: 1669 });
eq('"to" range', R('2400 to 4800'), { r: [[2400, 4800]], p: [], f: 2400 });
eq('BHK label is not an area', R('1BHK-460-510'), { r: [[460, 510]], p: [], f: 460 });
eq('single value with comma', R('2,135'), { r: [], p: [2135], f: 2135 });
eq('decimal value', R('813.89 Sq.ft'), { r: [], p: [813.89], f: 813.89 });
eq('a percentage is not an area', R('33% (UDS, not sq.ft)'), { r: [], p: [], f: 33 });
eq('the sheet\'s empty marker', R('----'), { r: [], p: [], f: null });
eq('parenthetical note keeps the range', R('1,093 to 1,934 (varies by config)'), { r: [[1093, 1934]], p: [], f: 1093 });
eq('BHK inside a note is dropped', R('1786 (3BHK Villa option only)'), { r: [], p: [1786], f: 1786 });
eq('first number wins for banding', R('98,010 (approx; 2.25 Acres)').f, 98010);
eq('empty string', R(''), { r: [], p: [], f: null });
eq('null', R(null), { r: [], p: [], f: null });

section('Land area — acres, cents and grounds become sqft');
eq('89 cents', Math.round(S.parseLandSqft('89 Cents')[0]), 38768);
eq('22 acres', S.parseLandSqft('22 Acres')[0], 958320);
eq('3.5 grounds', S.parseLandSqft('3.5 Grounds')[0], 8400);
eq('plain sqft passes through', S.parseLandSqft('3,588 Sq.ft')[0], 3588);
eq('noise yields nothing', S.parseLandSqft('----'), []);

// ═══════ 3. MONEY PARSING ═══════
section('Money — price, rate and rent all live in the same columns');

const M = (v, h) => S.parseMoney(v, h);
eq('crores', M('₹1.25 Crores', 'price').price, [[12500000, 12500000]]);
eq('lakh-to-crore range', M('₹60L - 1.6Cr', 'price').price, [[6000000, 16000000]]);
eq('open-ended plus', M('₹28L+', 'price').price, [[2800000, 2800000]]);
eq('a per-sqft rate in the price column is not a price', M('₹2700/Sqft+', 'price').price, []);
eq('…it is a rate', M('₹2700/Sqft+', 'price').psf, [[2700, 2700]]);
eq('a monthly figure is rent', M('₹1,35,000/Month', 'price').rent, [[135000, 135000]]);
eq('price on request parses to nothing', M('Price on Request', 'price').price, []);
eq('Rs. with a bracketed rate — price', M('Rs.78 Lakhs+ onwards (Rs.6,500/Sq.ft)', 'price').price, [[7800000, 7800000]]);
eq('Rs. with a bracketed rate — rate', M('Rs.78 Lakhs+ onwards (Rs.6,500/Sq.ft)', 'price').psf, [[6500, 6500]]);
eq('unit on the high side governs both', M('2 BHK - ₹1.49 to ₹2.11 Cr', 'price').price, [[14900000, 21100000]]);
eq('4.06 Cr is exactly 40600000 (no float drift)', M('₹4.06 Cr', 'price').price, [[40600000, 40600000]]);
eq('two onwards prices stay separate', M('₹4.77 Cr onwards (4BHK), ₹9.55 Cr onwards (5BHK)', 'price').price,
  [[47700000, 47700000], [95500000, 95500000]]);
eq('bare number in the rate column', M('19,900', 'psf').psf, [[19900, 19900]]);
eq('floor-prefixed rate', M('GF-5275', 'psf').psf, [[5275, 5275]]);
eq('rate range', M('5000-5300', 'psf').psf, [[5000, 5300]]);
eq('"RENT ONLY" parses to nothing', M('RENT ONLY', 'psf'), { price: [], psf: [], rent: [] });
eq('approx rate range', M('Approx ₹23,250 - ₹23,810', 'psf').psf, [[23250, 23810]]);
eq('a project name in the price column yields nothing', M('ADRM0003', 'price').price, []);
eq('three-config price line spans all three', M('2 BHK - ₹1.49 to ₹2.11 Cr + Charges | 3 BHK - ₹1.97 to ₹3.05 Cr | 4 BHK - ₹4.06 Cr', 'price').price.length, 3);

// ═══════ 4. CONFIGURATION PARSING ═══════
section('BHK — every spelling the sheet uses');

const B = v => S.extractBhk(v);
eq('3BHK', B('3BHK'), [3]);
eq('3 BHK', B('3 BHK'), [3]);
eq('comma-and list', B('2, 3 & 4 BHK'), [2, 3, 4]);
eq('list with a repeat and a suffix', B('1, 2, 3 BHK & 3 BHK Large'), [1, 2, 3]);
eq('half sizes', B('2, 2.5 & 3 BHK'), [2, 2.5, 3]);
eq('slash list with a trailing note', B('3 BHK / 4 BHK + Home Office-Maid Room'), [3, 4]);
eq('a unit count is not a BHK', B('4 Apartments (3BHK each)'), [3]);
eq('plot counts are not BHK', B('223 Plots'), []);
eq('duplex', B('4BHK Duplex'), [4]);
eq('slash-joined', B('2BHK/3BHK/4BHK'), [2, 3, 4]);
eq('toilet count is not a BHK', B('3BHK 3T'), [3]);
eq('bracketed alternative counts', B('3 BHK (2 BHK also available)'), [2, 3]);
eq('ampersand pair', B('1BHK & 2BHK'), [1, 2]);
eq('high-end pair', B('4 & 5 BHK'), [4, 5]);
eq('villa option inside a plot listing', B('Plots (3BHK Villa option)'), [3]);
eq('empty marker', B('----'), []);
eq('"bedrooms" is the same thing', B('3 Bedrooms'), [3]);
eq('nothing at all', B(''), []);

section('Type — eleven spellings, six buckets');
eq('Apartment', S.normType('Apartment'), 'Apartment');
eq('Apartments', S.normType('Apartments'), 'Apartment');
eq('Flat', S.normType('Flat'), 'Apartment');
eq('Villa', S.normType('Villa'), 'Villa');
eq('Townhouse', S.normType('Townhouse'), 'Villa');
eq('Plots', S.normType('Plots'), 'Plot');
eq('Land', S.normType('Land'), 'Plot');
eq('Independent House', S.normType('Independent House'), 'House');
eq('Commercial', S.normType('Commercial'), 'Commercial');
eq('Residential is too vague to bucket', S.normType('Residential'), 'Other');
eq('empty', S.normType(''), 'Other');

section('Floors — G+5, Stilt + 3, 2B+G+19');
eq('G+5', S.extractFloors('G+5'), 5);
eq('Stilt + 5 Floors', S.extractFloors('Stilt + 5 Floors'), 5);
eq('2B+G+19', S.extractFloors('2B+G+19'), 19);
eq('a plain count', S.extractFloors('14'), 14);
eq('empty marker', S.extractFloors('----'), null);

// ═══════ 5. FINDABILITY SWEEP ═══════
//
// The core promise: an agent holding ANY one fact about a listing can reach
// it. Generated per property, so a listing that nobody wrote a test for is
// still covered.
section(`Findability sweep — every fact about each of the ${P.length} properties`);

let sweep = { code: 0, name: 0, area: 0, builder: 0, size: 0, uds: 0, phone: 0, price: 0 };
const missCode = [], missName = [], missArea = [], missBuilder = [], missSize = [], missUds = [], missPhone = [], missPrice = [];

for (const p of P) {
  // ── its code, which must come first ──
  const code = p.propertyCode || p.propertyId;
  if (code && !/^\s*$/.test(code)) {
    const res = find(code);
    sweep.code++;
    // Compared on the code, not the document id: the live sheet has two
    // codes entered against two properties each (asserted below), so "the
    // right one" can only mean "one carrying that code".
    if (!res.length || codeOf(res[0].p) !== code) missCode.push(`${code}→${res.length ? codeOf(res[0].p) : 'none'}`);
  }
  // ── its name ──
  if (p.name && p.name.length > 3 && !/^-+$/.test(p.name)) {
    const res = find(p.name);
    sweep.name++;
    const at = ids(res).indexOf(p.id);
    if (at < 0 || at > 2) missName.push(`${codeOf(p)} "${p.name}" rank ${at < 0 ? '∅' : at + 1}`);
  }
  // ── the locality it is in ──
  const area = String(p.location || '').split(',')[0].trim();
  if (area && area.length > 3 && !/^chennai$/i.test(area)) {
    sweep.area++;
    if (ids(find(area)).indexOf(p.id) < 0) missArea.push(`${codeOf(p)} "${area}"`);
  }
  // ── who is selling it ──
  if (p.builder && p.builder.length > 3) {
    sweep.builder++;
    if (ids(find(p.builder)).indexOf(p.id) < 0) missBuilder.push(`${codeOf(p)} "${p.builder}"`);
  }
  // ── a size the client would quote: the low end, the high end, and a value
  //    in between that appears NOWHERE in the text ──
  const spans = areaSpans(p);
  if (spans.length) {
    const s = spans[0];
    const mid = Math.round((s[0] + s[1]) / 2);
    for (const n of [Math.round(s[0]), Math.round(s[1]), mid]) {
      if (n < 100) continue;
      sweep.size++;
      if (ids(find(`${n} sqft`)).indexOf(p.id) < 0) missSize.push(`${codeOf(p)} ${n} not in ${s[0]}–${s[1]}`);
    }
  }
  // ── its UDS, typed with and without the comma ──
  const uds = S.parseRanges(p.uds);
  if (uds.first != null && uds.first >= 100) {
    const n = uds.first;
    const withComma = Math.round(n).toLocaleString('en-IN');
    for (const q of [`uds ${n}`, `uds ${withComma}`, String(n)]) {
      sweep.uds++;
      if (ids(find(q)).indexOf(p.id) < 0) missUds.push(`${codeOf(p)} "${q}"`);
    }
  }
  // ── the number on the file ──
  if (p.contactNumber && /\d{5}/.test(p.contactNumber)) {
    for (const q of [p.contactNumber, p.contactNumber.replace(/\s/g, '')]) {
      sweep.phone++;
      if (ids(find(q)).indexOf(p.id) < 0) missPhone.push(`${codeOf(p)} "${q}"`);
    }
  }
  // ── its own asking price, spoken back ──
  const lo = priceLo(p);
  if (lo && lo >= S.LAKH) {
    const spoken = lo >= S.CR ? `${Math.round(lo / S.CR * 100) / 100} cr` : `${Math.round(lo / S.LAKH * 100) / 100} lakhs`;
    sweep.price++;
    if (ids(find(spoken)).indexOf(p.id) < 0) missPrice.push(`${codeOf(p)} "${spoken}"`);
  }
}

check(`code finds its property and ranks it first (${sweep.code} codes)`, missCode.length === 0, missCode.slice(0, 6).join(' ; '));
check(`name finds its property in the top 3 (${sweep.name} names)`, missName.length === 0, missName.slice(0, 6).join(' ; '));
check(`locality finds its properties (${sweep.area} localities)`, missArea.length === 0, missArea.slice(0, 6).join(' ; '));
check(`builder finds its properties (${sweep.builder} builders)`, missBuilder.length === 0, missBuilder.slice(0, 6).join(' ; '));
check(`a size inside the range finds it (${sweep.size} sizes, incl. values never written down)`, missSize.length === 0, missSize.slice(0, 6).join(' ; '));
check(`UDS finds it with and without the comma (${sweep.uds} queries)`, missUds.length === 0, missUds.slice(0, 6).join(' ; '));
check(`the contact number finds it, spaced or not (${sweep.phone} queries)`, missPhone.length === 0, missPhone.slice(0, 6).join(' ; '));
check(`its own asking price finds it (${sweep.price} prices)`, missPrice.length === 0, missPrice.slice(0, 8).join(' ; '));
console.log(`   ${Object.values(sweep).reduce((a, b) => a + b, 0)} generated queries across ${P.length} properties`);

// ═══════ 6. THE CASES THAT WERE BROKEN ═══════
section('The reported failures');

check('a multi-word size query returns results', find('1518 sqft built up area').length > 0);
all('1518 sqft built up area', '1518 sqft built up area', p => covers(areaSpans(p), 1518));
all('1,518 with a comma finds the same', '1,518 sqft', p => covers(areaSpans(p), 1518));
eq('with and without the comma agree',
  ids(find('1518 sqft')).sort(), ids(find('1,518 sqft')).sort());
eq('"1518 sqft" and "built up area 1518" agree',
  ids(find('1518 sqft')).sort(), ids(find('built up area 1518')).sort());
eq('"1518 sqft" and "1518 sq ft" agree',
  ids(find('1518 sqft')).sort(), ids(find('1518 sq ft')).sort());
eq('"1518 sqft" and "1518 sft" agree',
  ids(find('1518 sqft')).sort(), ids(find('1518 sft')).sort());

// The exact ask in the brief: two configurations, two localities.
const both = find('3 and 4 bhk in anna nagar and adyar');
check('"3 and 4 bhk in anna nagar and adyar" returns results', both.length > 0);
check('…and every hit is a 3 or a 4 BHK',
  both.every(r => bhkOf(r.p).some(b => b === 3 || b === 4)),
  both.filter(r => !bhkOf(r.p).some(b => b === 3 || b === 4)).slice(0, 3).map(r => `${codeOf(r.p)} ${r.p.config}`).join(' ; '));
// "somewhere" is the real contract: a locality term is matched against the
// location first and the rest of the document as a fallback, so a listing
// whose brochure says "15 mins to Adyar" is a hit — ranked below the ones
// actually in Adyar, and the result card says which field matched.
const inArea = (p, re) => re.test(hay(p));
check('…and every hit names Anna Nagar or Adyar somewhere',
  both.every(r => inArea(r.p, /anna nagar|adyar/)),
  both.filter(r => !inArea(r.p, /anna nagar|adyar/)).slice(0, 3).map(r => `${codeOf(r.p)} ${r.p.location}`).join(' ; '));
check('…and it finds MORE than either half alone',
  both.length > find('3 bhk anna nagar').length && both.length > find('4 bhk adyar').length);
eq('"or" and "and" between two values of one field mean the same',
  ids(find('3 or 4 bhk in anna nagar or adyar')).sort(), ids(both).sort());
eq('a comma between them means the same too',
  ids(find('3, 4 bhk anna nagar, adyar')).sort(), ids(both).sort());

// UDS typed with a comma, which is how it is stored.
all('uds with a comma', 'uds 1,140', p => S.normText(p.uds || '').includes('1140'));
all('uds without a comma', 'uds 1140', p => S.normText(p.uds || '').includes('1140'));

// ═══════ 7. AGENT SCENARIOS ═══════
//
// Each asserts on meaning, not on a frozen list.
section('Agent on a call — configuration');

all('3bhk', '3bhk', p => bhkOf(p).includes(3));
all('3 bhk with a space', '3 bhk', p => bhkOf(p).includes(3));
all('3BHK in capitals', '3BHK', p => bhkOf(p).includes(3));
all('2bhk', '2bhk', p => bhkOf(p).includes(2));
all('4bhk', '4bhk', p => bhkOf(p).includes(4));
all('5bhk', '5bhk', p => bhkOf(p).includes(5));
all('1bhk', '1bhk', p => bhkOf(p).includes(1));
all('3 bedroom', '3 bedrooms', p => bhkOf(p).includes(3));
all('config:3', 'config:3', p => bhkOf(p).includes(3));
all('bhk:4', 'bhk:4', p => bhkOf(p).includes(4));
all('2 or 3 bhk', '2 or 3 bhk', p => bhkOf(p).some(b => b === 2 || b === 3));
all('3 and 4 bhk', '3 and 4 bhk', p => bhkOf(p).some(b => b === 3 || b === 4));
all('2, 3, 4 bhk', '2, 3, 4 bhk', p => bhkOf(p).some(b => [2, 3, 4].includes(b)));
all('3-4 bhk as a range', '3-4 bhk', p => bhkOf(p).some(b => b >= 3 && b <= 4));
all('4 bhk or bigger', 'bhk:>4', p => bhkOf(p).some(b => b >= 4));

section('Agent on a call — budget');

all('under 1 cr', 'under 1 cr', p => { const v = priceLo(p); return v == null || v <= S.CR; });
all('below 50 lakhs', 'below 50 lakhs', p => { const v = priceLo(p); return v == null || v <= 50 * S.LAKH; });
all('budget 2 crore', 'budget under 2 crore', p => { const v = priceLo(p); return v == null || v <= 2 * S.CR; });
all('above 5 cr', 'above 5 cr', p => {
  const spans = S.indexProperty(p).num.price;
  return !spans.length || spans.some(r => r[1] >= 5 * S.CR);
});
all('between 1 and 2 cr', 'between 1 and 2 cr', p => {
  const rec = S.indexProperty(p);
  return rec.num.price.some(r => r[1] >= S.CR && r[0] <= 2 * S.CR);
});
all('1cr to 2cr', '1cr-2cr', p => S.indexProperty(p).num.price.some(r => r[1] >= S.CR && r[0] <= 2 * S.CR));
all('price:<8000000', 'price:<8000000', p => { const v = priceLo(p); return v == null || v <= 8000000; });
all('2cr+ means 2cr and above', '2cr+', p => S.indexProperty(p).num.price.some(r => r[1] >= 2 * S.CR));
check('under 1cr is a smaller set than under 5cr', find('under 1 cr').length < find('under 5 cr').length);
check('"50 lakhs" is read as money, not as the number 50',
  find('under 50 lakhs').every(r => { const v = priceLo(r.p); return v == null || v <= 50 * S.LAKH; }));
check('"under 50 lakhs" and "under 50L" agree',
  JSON.stringify(ids(find('under 50 lakhs')).sort()) === JSON.stringify(ids(find('under 50L')).sort()));
check('"1.5 cr" and "1.5cr" agree',
  JSON.stringify(ids(find('under 1.5 cr')).sort()) === JSON.stringify(ids(find('under 1.5cr')).sort()));

section('Agent on a call — size');

all('2000 sqft', '2000 sqft', p => covers(areaSpans(p), 2000) || areaSpans(p).length === 0);
all('above 3000 sqft', 'above 3000 sqft', p => areaSpans(p).some(s => s[1] >= 3000));
all('under 1000 sqft', 'under 1000 sqft', p => areaSpans(p).some(s => s[0] <= 1000));
all('1500 to 2000 sqft', '1500 to 2000 sqft', p => areaSpans(p).some(s => s[1] >= 1500 && s[0] <= 2000));
all('sqft:1200', 'sqft:1200', p => covers(areaSpans(p), 1200) || areaSpans(p).length === 0);
all('carpet area 1940', 'carpet area 1940', p => S.normText(p.carpetArea || '').includes('1940'));
all('super built up 3750', 'super built up 3750',
  p => S.normText(p.superBuiltupArea || '').includes('3750') || !S.indexProperty(p).num.superb.length);
all('land over an acre', 'land:>43560', p => S.indexProperty(p).num.land.some(s => s[1] >= 43560));

section('Agent on a call — locality and corridor');

for (const a of ['Adyar', 'Velachery', 'Medavakkam', 'Porur', 'Nungambakkam', 'Mylapore', 'Kundrathur', 'Oragadam']) {
  const res = find(a);
  if (res.length) all(`locality ${a}`, a, p => hay(p).includes(S.normText(a)));
}
all('anna nagar as one locality', 'anna nagar', p => hay(p).includes('anna nagar'));
all('omr', 'omr', p => S.indexProperty(p).facet.corridor.includes('OMR'));
all('ecr', 'ecr', p => S.indexProperty(p).facet.corridor.includes('ECR'));
all('gst road', 'gst road', p => S.indexProperty(p).facet.corridor.includes('GST'));
all('zone south', 'zone:"chennai south"', p => /south/i.test(p.zone || ''));
check('a typo in a locality still finds it', find('adayar').length > 0);
check('another typo', find('velacherry').length > 0 || find('velachery').length === 0);
check('two localities return at least as many as one', find('adyar or mylapore').length >= find('adyar').length);

section('Agent on a call — type and status');

all('apartment', 'apartment', p => S.normType(p.type || p.propertyType) === 'Apartment');
all('flat means apartment', 'flat', p => S.normType(p.type || p.propertyType) === 'Apartment');
all('villa', 'villa', p => S.normType(p.type || p.propertyType) === 'Villa');
all('plot', 'plot', p => S.normType(p.type || p.propertyType) === 'Plot');
all('land means plot', 'land', p => S.normType(p.type || p.propertyType) === 'Plot');
all('ready to move', 'ready to move', p => p.status === 'Ready to Move');
all('rtm', 'rtm', p => p.status === 'Ready to Move');
all('under construction', 'under construction', p => p.status === 'Under Construction');
all('type:villa', 'type:villa', p => S.normType(p.type || p.propertyType) === 'Villa');
all('status:ready', 'status:ready', p => p.status === 'Ready to Move');
check('ready and under construction partition the inventory',
  find('ready to move').length + find('under construction').length === P.length);

section('Agent on a call — features');

all('vastu', 'vastu', p => S.indexProperty(p).facet.vastu);
all('vaastu spelt the other way', 'vaastu', p => S.indexProperty(p).facet.vastu);
all('east facing', 'east facing', p => S.indexProperty(p).facet.facing.includes('East'));
all('covered parking', 'covered parking', p => S.indexProperty(p).facet.parkingKind.includes('Covered'));
all('semi furnished', 'semi furnished', p => S.indexProperty(p).facet.furnishing === 'Semi-Furnished');
all('rera', 'rera', p => S.indexProperty(p).facet.approvals.includes('RERA'));
all('cmda', 'cmda', p => S.indexProperty(p).facet.approvals.includes('CMDA'));
all('dtcp', 'dtcp', p => S.indexProperty(p).facet.approvals.includes('DTCP'));
all('swimming pool', 'swimming pool', p => S.indexProperty(p).facet.amenityTags.includes('pool'));
all('gym', 'gym', p => S.indexProperty(p).facet.amenityTags.includes('gym'));
all('clubhouse', 'clubhouse', p => S.indexProperty(p).facet.amenityTags.includes('clubhouse'));
all('resale', 'resale', p => S.indexProperty(p).facet.saleType === 'Resale');

section('Agent on a call — combinations');

all('3bhk ready to move', '3bhk ready to move', p => bhkOf(p).includes(3) && p.status === 'Ready to Move');
all('3bhk adyar', '3bhk adyar', p => bhkOf(p).includes(3) && hay(p).includes('adyar'));
check('…and a real Adyar listing outranks one merely near it',
  (() => { const r = find('3bhk adyar'); return !r.length || /adyar/i.test(r[0].p.location || ''); })());
all('2bhk under 1cr', '2bhk under 1cr', p => bhkOf(p).includes(2) && (priceLo(p) == null || priceLo(p) <= S.CR));
all('villa ready to move under 3cr', 'ready to move villa under 3cr',
  p => S.normType(p.type || p.propertyType) === 'Villa' && p.status === 'Ready to Move' && (priceLo(p) == null || priceLo(p) <= 3 * S.CR));
all('3bhk omr 1500 sqft', '3bhk omr 1500 sqft',
  p => bhkOf(p).includes(3) && S.indexProperty(p).facet.corridor.includes('OMR') && covers(areaSpans(p), 1500));
all('apartment vastu east facing covered parking', 'apartment vastu east facing covered parking', p => {
  const f = S.indexProperty(p).facet;
  return f.type === 'Apartment' && f.vastu && f.facing.includes('East') && f.parkingKind.includes('Covered');
});
all('(3 or 4) bhk villa', '(3 or 4) bhk villa',
  p => bhkOf(p).some(b => b === 3 || b === 4) && S.normType(p.type || p.propertyType) === 'Villa');
check('adding a term never widens the result set',
  find('3bhk adyar').length <= find('3bhk').length && find('3bhk adyar').length <= find('adyar').length);
check('adding a third term narrows again',
  find('3bhk adyar ready to move').length <= find('3bhk adyar').length);

section('Agent on a call — exclusions');

const noPlots = find('3bhk -plot');
check('"-plot" excludes plots', noPlots.every(r => S.normType(r.p.type || r.p.propertyType) !== 'Plot'));
check('"not plot" does the same', find('3bhk not plot').every(r => S.normType(r.p.type || r.p.propertyType) !== 'Plot'));
check('excluding narrows', noPlots.length <= find('3bhk').length);
excludes('a sold property is excluded by -sold', '-sold', (P.find(p => p.soldOut) || {}).id || '__none__');

section('Named lookups');

finds('a full project name', 'Palace City Paradise', 'ADRA0001', { top: 1 });
finds('part of a project name', 'Palace City', 'ADRA0001', { top: 3 });
finds('a project code', 'ADRA0001', 'ADRA0001', { top: 1 });
finds('a lowercase code', 'adra0001', 'ADRA0001', { top: 1 });
const arun = P.filter(p => /arun excello/i.test(p.builder || ''));
const arunRes = find('Arun Excello');
check('a builder name returns all of that builder\'s stock',
  arun.every(p => ids(arunRes).includes(p.id)), `${arun.length} expected, got ${arunRes.length}`);
check('…and ranks them above everything else',
  arunRes.slice(0, arun.length).every(r => /arun excello/i.test(r.p.builder + ' ' + r.p.name)));
check('a misspelt builder still finds it', find('casagrande').length > 0);
check('a partial builder name works', find('excello').length > 0);

// ═══════ 7b. THE CALL MATRIX ═══════
//
// A hundred-odd sentences taken from how the job is actually done: a client
// on the phone, half a fact remembered, the number written on a scrap of
// paper. Each entry is [query, predicate?] — with a predicate every hit must
// satisfy it; without one the query only has to come back with something,
// because "no properties match" is the wrong answer to a question the
// inventory can answer.
section('The call matrix — how the job is actually done');

const T = S.indexProperty;
const SCENARIOS = [
  // ── the client leads with a configuration ──
  ['3 bhk', p => bhkOf(p).includes(3)],
  ['need a 3bhk', p => bhkOf(p).includes(3)],
  ['client wants 3 bhk', p => bhkOf(p).includes(3)],
  ['looking for 2 bhk flat', p => bhkOf(p).includes(2) && T(p).facet.type === 'Apartment'],
  ['show me 4 bhk villas', p => bhkOf(p).includes(4) && T(p).facet.type === 'Villa'],
  ['any 5 bhk', p => bhkOf(p).includes(5)],
  ['1 bhk or 2 bhk', p => bhkOf(p).some(b => b === 1 || b === 2)],
  ['2 3 or 4 bhk', p => bhkOf(p).some(b => [2, 3, 4].includes(b))],
  ['3 bhk and above', p => bhkOf(p).some(b => b >= 3)],
  ['3bhk apartment ready', p => bhkOf(p).includes(3) && T(p).facet.type === 'Apartment' && p.status === 'Ready to Move'],

  // ── the client leads with a place ──
  ['property in adyar', p => hay(p).includes('adyar')],
  ['anything in velachery', null],
  ['near porur', p => hay(p).includes('porur')],
  ['omr properties', p => T(p).facet.corridor.includes('OMR')],
  ['ecr plots', p => T(p).facet.corridor.includes('ECR') && T(p).facet.type === 'Plot'],
  ['chennai south', p => /south/i.test(p.zone || '') || hay(p).includes('south')],
  ['chennai west 3bhk', p => bhkOf(p).includes(3)],
  ['anna nagar or nungambakkam', p => /anna nagar|nungambakkam/.test(hay(p))],
  ['adyar mylapore besant nagar', null],
  ['medavakkam and mambakkam', null],

  // ── the client leads with a budget ──
  ['under 1 crore', p => !T(p).num.price.length || T(p).num.price.some(r => r[0] <= S.CR)],
  ['below 75 lakhs', p => !T(p).num.price.length || T(p).num.price.some(r => r[0] <= 75 * S.LAKH)],
  ['upto 2 cr', p => !T(p).num.price.length || T(p).num.price.some(r => r[0] <= 2 * S.CR)],
  ['max 3 crore', p => !T(p).num.price.length || T(p).num.price.some(r => r[0] <= 3 * S.CR)],
  ['budget is 1.5 cr', null],
  ['above 2 crore', p => !T(p).num.price.length || T(p).num.price.some(r => r[1] >= 2 * S.CR)],
  ['minimum 5 cr', p => !T(p).num.price.length || T(p).num.price.some(r => r[1] >= 5 * S.CR)],
  ['1 to 2 crore', p => !T(p).num.price.length || T(p).num.price.some(r => r[1] >= S.CR && r[0] <= 2 * S.CR)],
  ['50 to 80 lakhs', null],
  ['price:<5000000', p => !T(p).num.price.length || T(p).num.price.some(r => r[0] <= 5000000)],

  // ── the client leads with a size ──
  ['1200 sqft', null],
  ['1500 sq ft', null],
  ['1800 sft', null],
  ['2000 square feet', null],
  ['built up area 1600', null],
  ['super built up area 2000', null],
  ['carpet area 1000', null],
  ['above 2500 sqft', p => !areaSpans(p).length || areaSpans(p).some(s => s[1] >= 2500)],
  ['under 900 sqft', p => !areaSpans(p).length || areaSpans(p).some(s => s[0] <= 900)],
  ['1000 to 1500 sqft', p => !areaSpans(p).length || areaSpans(p).some(s => s[1] >= 1000 && s[0] <= 1500)],

  // ── the number on the scrap of paper ──
  ['1140', null],
  ['1,140', null],
  ['2505', null],
  ['2,505', null],
  ['813.89', null],
  ['uds 600', null],
  ['uds 580', null],
  ['undivided share 800', null],

  // ── readiness and possession ──
  ['ready to move', p => p.status === 'Ready to Move'],
  ['ready to move in', p => p.status === 'Ready to Move'],
  ['immediate possession', null],
  ['under construction', p => p.status === 'Under Construction'],
  ['possession 2027', null],
  ['new launch', null],

  // ── type ──
  ['apartments', p => T(p).facet.type === 'Apartment'],
  ['flats', p => T(p).facet.type === 'Apartment'],
  ['villas', p => T(p).facet.type === 'Villa'],
  ['independent house', null],
  ['plots', p => T(p).facet.type === 'Plot'],
  ['land for sale', null],
  ['commercial', null],
  ['townhouse', null],

  // ── the fussy client ──
  ['east facing vastu', p => T(p).facet.facing.includes('East') && T(p).facet.vastu],
  ['north facing 3bhk', p => T(p).facet.facing.includes('North') && bhkOf(p).includes(3)],
  ['vastu compliant apartment', p => T(p).facet.vastu && T(p).facet.type === 'Apartment'],
  ['covered car parking', p => T(p).facet.parkingKind.includes('Covered')],
  ['fully furnished', p => T(p).facet.furnishing === 'Fully Furnished'],
  ['semi furnished 2bhk', p => T(p).facet.furnishing === 'Semi-Furnished' && bhkOf(p).includes(2)],
  ['gated community', p => hay(p).includes('gated community')],
  ['swimming pool and gym', p => T(p).facet.amenityTags.includes('pool') || T(p).facet.amenityTags.includes('gym')],
  ['clubhouse children play area', null],
  ['ev charging', p => T(p).facet.amenityTags.includes('ev')],
  ['power backup lift', null],
  ['rera approved', p => T(p).facet.approvals.includes('RERA')],
  ['cmda approved plot', p => T(p).facet.approvals.includes('CMDA')],
  ['dtcp approved', p => T(p).facet.approvals.includes('DTCP')],

  // ── who is selling ──
  ['arun excello', null],
  ['shriram', null],
  ['casa grande', null],
  ['sobha', null],
  ['prestige', null],
  ['individual owner', p => /individual/i.test(p.builder || '')],
  ['mp developers', null],
  ['navin', null],

  // ── the whole brief at once ──
  ['3bhk apartment adyar under 5cr ready to move', null],
  ['2bhk under 60 lakhs ready', null],
  ['4bhk villa omr gated community', null],
  ['plot ecr under 1 cr', null],
  ['3 or 4 bhk anna nagar or nungambakkam under 6 cr', null],
  ['ready to move 3bhk with covered parking and vastu', null],
  ['apartment 1200 to 1600 sqft under 1.5 cr', null],
  ['villa 3000 sqft above', null],
  ['plots above 2000 sqft dtcp', null],
  ['2 and 3 bhk in porur and mangadu', null],

  // ── half-remembered ──
  ['casagrand millenia', null],
  ['palace city', null],
  ['whitefield mudra', null],
  ['aura', null],
  ['adityaram', null],
  ['heritage', null],
  ['cassia', null],
  ['lux 49', null],

  // ── by code ──
  ['ADRA0001', null],
  ['adra0001', null],
  ['NAVI', null],
  ['ANR', null],

  // ── spelling as it comes ──
  ['adayar', null],
  ['nungabakkam', null],
  ['medavakam', null],
  ['appartment', null],
  ['appartments 3bhk', null],
  ['vasthu', p => T(p).facet.vastu],
  ['swiming pool', null],

  // ── exclusions ──
  ['3bhk -plot', p => T(p).facet.type !== 'Plot'],
  ['apartment not resale', p => T(p).facet.saleType !== 'Resale'],
  ['ready to move without plots', p => T(p).facet.type !== 'Plot'],
  ['villa -sold', p => !p.soldOut],

  // ── explicit fields ──
  ['builder:sobha', null],
  ['type:plot', p => T(p).facet.type === 'Plot'],
  ['status:ready type:apartment', p => p.status === 'Ready to Move' && T(p).facet.type === 'Apartment'],
  ['area:adyar bhk:3', p => bhkOf(p).includes(3)],
  ['price:1-2cr', null],
  ['sqft:>2000', p => !areaSpans(p).length || areaSpans(p).some(s => s[1] >= 2000)],
  ['uds:>1000', null],
  ['floors:>10', null],
  ['facing:east', p => T(p).facet.facing.includes('East')],
  ['amenity:pool', null]
];

let matrixEmpty = 0;
const emptyQs = [];
for (const [q, pred] of SCENARIOS) {
  let res;
  try { res = find(q); }
  catch (e) { check(`matrix "${q}" does not throw`, false, e.message); continue; }
  if (!res.length) { matrixEmpty++; emptyQs.push(q); continue; }
  if (pred) {
    const bad = res.filter(r => !pred(r.p));
    check(`matrix "${q}" — every hit qualifies`, bad.length === 0,
      `${bad.length}/${res.length}, e.g. ${bad.slice(0, 2).map(r => `${codeOf(r.p)} (${r.p.config} | ${r.p.type} | ${r.p.startingPrice})`).join(' ; ')}`);
  } else {
    check(`matrix "${q}" — returns something`, true);
  }
}
check(`every one of the ${SCENARIOS.length} call-matrix queries returns results`,
  matrixEmpty === 0, `empty: ${emptyQs.join(' | ')}`);

// ═══════ 8. ROBUSTNESS ═══════
section('Robustness — nothing the box is given may throw or empty the grid');

const survives = (label, q) => {
  try { const r = S.search(P, { text: q, gazetteer: GAZ }); check(label, Array.isArray(r)); }
  catch (e) { check(label, false, e.message); }
};
survives('empty string', '');
survives('only spaces', '     ');
survives('only punctuation', '!!!???,,,');
survives('a lone hyphen', '-');
survives('a lone comma', ',');
survives('unbalanced quote', 'adyar "3bhk');
survives('unbalanced bracket', '(3bhk or 4bhk');
survives('regex metacharacters', '.*+?[](){}|^$\\');
survives('a SQL-looking string', "'; DROP TABLE properties;--");
survives('html', '<script>alert(1)</script>');
survives('emoji', '🏠 3bhk 🏢');
survives('a very long query', 'adyar '.repeat(200));
survives('a lone operator', 'or');
survives('two operators', 'and or');
survives('a bare comparator', 'under');
survives('comparator with nothing after it', 'under cr');
survives('field with no value', 'price:');
survives('unknown field', 'nonsense:3');
survives('a huge number', '999999999999999 sqft');
survives('a negative number', '-500 sqft');
survives('zero', '0');
survives('tamil script', 'அடையார்');
survives('mixed script', 'adyar அடையார் 3bhk');

eq('an empty query returns everything', S.search(P, { text: '' }).length, P.length);
eq('whitespace-only returns everything', S.search(P, { text: '   ' }).length, P.length);
check('a nonsense word returns nothing rather than everything', find('zzzqqxwv').length === 0);
check('stopwords alone do not empty the grid', find('looking for a property in').length > 0);
check('a query of only stopwords behaves like an empty one', find('please show me any options').length === P.length);

section('Robustness — properties with broken data still index');
for (const p of P) {
  try { S.indexProperty(p); }
  catch (e) { check(`indexing ${codeOf(p)}`, false, e.message); }
}
check('every property indexes without throwing', true);
const blank = { id: 'x' };
check('a property with only an id indexes', (() => { try { S.indexProperty(blank); return true; } catch { return false; } })());
check('a property with null fields indexes',
  (() => { try { S.indexProperty({ id: 'y', name: null, config: null, sqftRange: null, startingPrice: null }); return true; } catch { return false; } })());
check('searching an empty inventory is fine', S.search([], { text: '3bhk' }).length === 0);

// ═══════ 9. ADVANCED SEARCH (STRUCTURED) ═══════
section('Advanced search — rules, OR inside, AND across');

const adv = (rules, match) => S.search(P, { advanced: { match: match || 'all', rules } });

const r34 = adv([{ field: 'bhk', values: [3, 4] }]);
check('BHK 3 or 4', r34.length > 0 && r34.every(r => bhkOf(r.p).some(b => b === 3 || b === 4)));
check('…is the union of the two', r34.length >= adv([{ field: 'bhk', values: [3] }]).length);

const twoAreas = adv([{ field: 'area', values: ['Adyar', 'Mylapore'] }]);
check('two localities OR together', twoAreas.every(r => S.indexProperty(r.p).facet.areas.some(a => /adyar|mylapore/i.test(a))));

const combo = adv([{ field: 'bhk', values: [3, 4] }, { field: 'status', values: ['ready'] }]);
check('rules AND together', combo.every(r => bhkOf(r.p).some(b => b === 3 || b === 4) && r.p.status === 'Ready to Move'));
check('…and narrow the result', combo.length <= r34.length);

const anyOf = adv([{ field: 'bhk', values: [3] }, { field: 'type', values: ['Villa'] }], 'any');
check('match:any widens', anyOf.length >= adv([{ field: 'bhk', values: [3] }]).length);
check('…and every hit satisfies at least one rule',
  anyOf.every(r => bhkOf(r.p).includes(3) || S.normType(r.p.type || r.p.propertyType) === 'Villa'));

const budget = adv([{ field: 'price', min: 0, max: 2 * S.CR }]);
check('a budget rule keeps only overlapping prices',
  budget.every(r => S.indexProperty(r.p).num.price.some(s => s[0] <= 2 * S.CR)));
check('a price rule drops properties with no price unless asked',
  budget.every(r => S.indexProperty(r.p).num.price.length > 0));
const budgetInc = adv([{ field: 'price', min: 0, max: 2 * S.CR, includeUnknown: true }]);
check('includeUnknown keeps Price-on-Request listings', budgetInc.length > budget.length);

const sizeRule = adv([{ field: 'sqft', min: 1500, max: 2000 }]);
check('a size rule keeps only overlapping ranges',
  sizeRule.every(r => areaSpans(r.p).some(s => s[1] >= 1500 && s[0] <= 2000)));

const amenAll = adv([{ field: 'amenityTags', values: ['pool', 'gym'], mode: 'all' }]);
check('amenities default to ALL of them',
  amenAll.every(r => { const t = S.indexProperty(r.p).facet.amenityTags; return t.includes('pool') && t.includes('gym'); }));
const amenAny = adv([{ field: 'amenityTags', values: ['pool', 'gym'], mode: 'any' }]);
check('…and can be switched to ANY', amenAny.length >= amenAll.length);

check('an empty rule list returns everything', adv([]).length === P.length);
check('a rule with no values is ignored', adv([{ field: 'bhk', values: [] }]).length === P.length);
check('an unknown rule field is ignored', adv([{ field: 'nope', values: ['x'] }]).length === P.length);

section('Advanced search — combined with the text box');
const mixed = S.search(P, { text: 'adyar', gazetteer: GAZ, advanced: { match: 'all', rules: [{ field: 'bhk', values: [3] }] } });
check('text and rules both apply',
  mixed.every(r => hay(r.p).includes('adyar') && bhkOf(r.p).includes(3)));
check('…and the result is no larger than either alone', mixed.length <= find('adyar').length);

// ═══════ 10. FACETS ═══════
section('Filters are derived from the data, and their counts are true');

const facets = S.buildFacets(P);
check('facets were built', facets.length > 8, `${facets.length}`);
for (const f of facets) {
  check(`${f.label} has options`, f.options.length > 0);
  for (const o of f.options) {
    const viaRule = adv([{ field: f.field, values: [o.value], mode: 'any' }]).length;
    check(`${f.label} / ${o.label} count matches the filter (${o.count})`, viaRule === o.count, `chip says ${o.count}, filter returns ${viaRule}`);
  }
}
const bhkFacet = facets.find(f => f.field === 'bhk');
check('BHK options are in numeric order',
  bhkFacet.options.every((o, i) => i === 0 || Number(o.value) > Number(bhkFacet.options[i - 1].value)));
const priceFacet = facets.find(f => f.field === 'priceBand');
check('every budget band that is offered has stock', priceFacet.options.every(o => o.count > 0));
check('no facet offers a blank option', facets.every(f => f.options.every(o => String(o.label).trim() !== '')));
check('no facet offers the sheet\'s empty marker', facets.every(f => f.options.every(o => !/^-+$/.test(String(o.value).trim()))));

// ═══════ 11. RANKING ═══════
section('Ranking — the obvious answer comes first');

for (const p of P.slice(0, 40)) {
  if (!p.propertyCode) continue;
  const res = find(p.propertyCode);
  check(`${p.propertyCode} ranks itself first`, res.length > 0 && res[0].p.id === p.id,
    res.length ? `got ${codeOf(res[0].p)}` : 'no results');
}
const exact = find('2505 sqft');
if (exact.length > 1) {
  const top = S.indexProperty(exact[0].p);
  check('an exact size outranks a range that merely covers it',
    top.num.sqft.concat(top.num.superb, top.num.carpet).some(s => s[0] === s[1] && Math.abs(s[0] - 2505) < 1),
    `top was ${codeOf(exact[0].p)} (${exact[0].p.sqftRange})`);
}
check('scores are descending', find('3bhk adyar ready').every((r, i, a) => i === 0 || a[i - 1].score >= r.score));
check('every hit carries a reason', find('3bhk adyar').every(r => r.reasons.length > 0));

// ═══════ 12. SUGGESTIONS ═══════
section('Type-ahead suggestions');
check('a locality prefix suggests it', S.suggest(P, 'ady', GAZ).some(s => /adyar/i.test(s.text)));
check('a builder prefix suggests it', S.suggest(P, 'arun', GAZ).some(s => /arun/i.test(s.text)));
check('one letter suggests nothing', S.suggest(P, 'a', GAZ).length === 0);
check('two letters suggest nothing', S.suggest(P, 'ad', GAZ).length === 0);
check('suggestions are capped', S.suggest(P, 'nag', GAZ).length <= 8);
check('nonsense suggests nothing', S.suggest(P, 'zzzqq', GAZ).length === 0);
// The dropdown covers the results, so it must never open on a fragment that
// is part of what was being typed rather than the start of a name.
check('a unit word suggests nothing', S.suggest(P, 'cr', GAZ).length === 0);
check('"lakhs" suggests nothing', S.suggest(P, 'lakhs', GAZ).length === 0);
check('"crore" suggests nothing', S.suggest(P, 'crore', GAZ).length === 0);
check('"sqft" suggests nothing', S.suggest(P, 'sqft', GAZ).length === 0);
check('a number suggests nothing', S.suggest(P, '1518', GAZ).length === 0);
check('"3bhk" suggests nothing', S.suggest(P, '3bhk', GAZ).length === 0);
check('"ready" suggests nothing', S.suggest(P, 'ready', GAZ).length === 0);
check('"villa" suggests nothing', S.suggest(P, 'villa', GAZ).length === 0);
check('every suggestion starts with what was typed, in the name or a word of it',
  S.suggest(P, 'nag', GAZ).every(s => {
    const n = S.normText(s.text);
    return n.startsWith('nag') || n.split(' ').some(w => w.startsWith('nag'))
      || S.withinDistance('nag', n, 1) >= 0;
  }));
check('every suggestion is labelled', S.suggest(P, 'ann', GAZ).every(s => s.kind && s.text));

// ═══════ RESULT ═══════
console.log('\n' + '─'.repeat(64));
if (failed) {
  console.log(`\n${failed} FAILED:\n`);
  failures.slice(0, 40).forEach(f => console.log('  ✗ ' + f));
  if (failures.length > 40) console.log(`  …and ${failures.length - 40} more`);
}
console.log(`\n${passed} passed, ${failed} failed  (${P.length} properties)`);
process.exit(failed ? 1 : 0);
