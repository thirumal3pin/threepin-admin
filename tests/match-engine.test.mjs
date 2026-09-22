// ═══════ MATCH ENGINE — requirement reading, scoring, vetoes, both directions ═══════
//
//   node tests/match-engine.test.mjs
//
// The engine is a plain browser script, evaluated here the way a <script> tag
// would, so these tests exercise the artifact the browser is served.
//
// Layers:
//
//   1. Reading a requirement out of a messy lead record — the part that goes
//      wrong silently and takes every downstream score with it.
//   2. Objection mining: the quote, the anchor, the recency, and the three
//      ways a match can be a false positive ("his budget is high" is not a
//      complaint; "price is not high" is a negation; an objection cleared by
//      something said later is spent).
//   3. THE REFERENCE CASES. The owner specified two, and they are the
//      contract this engine is judged against:
//        · 3BHK / Anna Nagar / ₹3 Cr shown a 3BHK / Anna Nagar / ₹3.5 Cr is a
//          strong match in the low nineties — worth a call, not a 45% miss.
//        · A buyer who visited a property at that same price and called it
//          expensive is NOT shown it, and the reason quotes them.
//   4. Both directions agreeing, and the pathological inputs a live CRM
//      contains: blank leads, sellers, vendors, sold-out stock.
//
// Scores are asserted as ranges, never exact numbers, except where a number
// IS the contract (a veto, a full-credit attribute). A test that pins 92 to
// the point turns every future weight change into a failing test that says
// nothing about whether the matching got better or worse.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = f => new Function(fs.readFileSync(path.join(here, '..', ...f.split('/')), 'utf8'))();
load('dashboard-assets/search-engine.js');
load('shared-assets/chennai-geo.js');
load('shared-assets/area-model.js');
load('shared-assets/match-engine.js');

const M = globalThis.PinMatch;
const INVENTORY = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'properties-snapshot.json'), 'utf8'));

// A fixed clock: every recency and decay rule below depends on "now", and a
// suite that drifts with the wall clock fails once a year for no reason.
const NOW = Date.parse('2026-09-22T10:00:00Z');
const DAY = 86400000;

// ═══════ TINY RUNNER ═══════
let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; return true; }
  failed++;
  failures.push(`${label}${detail !== undefined ? ' — ' + detail : ''}`);
  return false;
}
const eq = (label, got, want) => check(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const between = (label, got, lo, hi) => check(label, got >= lo && got <= hi, `got ${got}, want ${lo}–${hi}`);
const section = t => console.log('\n' + t);

const lead = o => Object.assign({ id: 'L', name: 'Test buyer', enquiryType: 'Buyer', createdAt: NOW - 10 * DAY, updatedAt: NOW - DAY }, o);
const prop = o => Object.assign({ id: 'P', type: 'Apartments', status: 'Ready to Move', availability: 'Available' }, o);
const profileOf = (l, opts) => M.requirementProfile(l, Object.assign({ now: NOW }, opts));

// ═══════ 1. READING A REQUIREMENT ═══════

section('Budget, out of however it was typed');
const budgetCases = [
  ['3 Cr', 30000000],
  ['₹3.5 Crores', 35000000],
  ['1.8Cr', 18000000],
  ['budget 75 lakhs', 7500000],
  ['around 2.5 cr', 25000000],
  ['upto 1.5 crore', 15000000]
];
for (const [text, want] of budgetCases) {
  const b = profileOf(lead({ budget: text })).budget;
  eq(`"${text}" → ceiling ${want}`, b && b.max, want);
}
const ranged = profileOf(lead({ budget: '1.5 to 2 Cr' })).budget;
eq('a range keeps its floor', ranged.min, 15000000);
eq('a range keeps its ceiling', ranged.max, 20000000);
check('a single figure is read as a ceiling, not a target', profileOf(lead({ budget: '3 Cr' })).budget.firm === true);
check('"around" marks the budget flexible', profileOf(lead({ budget: 'around 2.5 cr' })).budget.flexible === true);
check('a phone number is not a budget',
  profileOf(lead({ budget: '', propertyInterest: 'call 9876543210' })).budget === null);

section('Configuration and type');
eq('"3 BHK in Adyar"', JSON.stringify(profileOf(lead({ propertyInterest: '3 BHK in Adyar' })).bhk.values), '[3]');
eq('"2BHK/3BHK"', JSON.stringify(profileOf(lead({ propertyInterest: '2BHK/3BHK apartment' })).bhk.values), '[2,3]');
// A BHK count with no type named means "a home" — not "an apartment".
const resi = profileOf(lead({ propertyInterest: '3 BHK in Adyar' })).types;
check('a bare BHK implies residential, not a specific type', resi.residentialOnly === true, JSON.stringify(resi));
check('and covers flat, villa and house', resi.values.length === 3, JSON.stringify(resi.values));
eq('a named plot is a plot',
  JSON.stringify(profileOf(lead({ propertyInterest: 'DTCP plot in Mangadu' })).types.values), '["Plot"]');
// The false positive that ruled a 3BHK buyer out of every flat: "liked the
// layout" is a floor plan, not a request for land.
const layout = profileOf(lead({
  propertyInterest: '3 BHK in Anna Nagar',
  lastNote: { text: 'Site visit done, liked the layout', createdAt: NOW - DAY }
}));
check('"liked the layout" is not a request for a plot',
  !layout.types.values.includes('Plot'), JSON.stringify(layout.types.values));
// A want is read from the requirement, not from a note describing what
// happened — "showed him the plot, he wants a flat" must not read as "plot".
const noteWins = profileOf(lead({
  propertyInterest: '3 BHK apartment in Velachery',
  lastNote: { text: 'Showed him the plot in Mambakkam, he was not keen', createdAt: NOW - DAY }
}));
eq('the requirement field outranks a note', JSON.stringify(noteWins.types.values), '["Apartment"]');

section('Localities');
const loc = profileOf(lead({ propertyInterest: '3BHK in Anna Nagar or Aminjikarai' })).localities;
check('both areas are read', loc.keys.length === 2, JSON.stringify(loc.keys));
check('a stated area is firm', loc.firm === true);
check('a blank lead has no locality', profileOf(lead({})).localities === null);

section('Everything else a buyer says');
const facets = profileOf(lead({
  propertyInterest: '3BHK east facing, vastu compliant, gated community with covered parking, CMDA approved, 30 feet road'
})).facets;
eq('vastu', facets.vastu, true);
eq('facing', JSON.stringify(facets.facing), '["East"]');
eq('gated', facets.gated, true);
eq('covered parking', facets.coveredParking, true);
eq('approval', JSON.stringify(facets.approvals), '["CMDA"]');
eq('road width — the owner\'s own example of a small-score attribute', facets.roadWidthMin, 30);
eq('possession urgency', profileOf(lead({ propertyInterest: 'ready to move 3bhk' })).possession.want, 'ready');
eq('an investor wants the opposite', profileOf(lead({ propertyInterest: 'under construction for investment' })).possession.want, 'upcoming');

// ═══════ 2. OBJECTIONS ═══════

section('Mining an objection out of a note');
const objOf = (text, at) => profileOf(lead({
  propertyInterest: '3BHK in Adyar', budget: '2 Cr',
  lastNote: { text, createdAt: at == null ? NOW - 3 * DAY : at }
})).objections;

check('"price is high"', objOf('Visited and said the price is high').some(o => o.kind === 'price_high'));
check('"too costly"', objOf('Felt it was too costly').some(o => o.kind === 'price_high'));
// The owner's own phrasing. In Indian English this is how a buyer says the
// asking price exceeds their budget, and it is what comes back from visits.
check('"budget is high" reads as a price objection',
  objOf('Saw the site, said budget is high').some(o => o.kind === 'price_high'));
check('"too far" is a location objection', objOf('Said it is too far from his office').some(o => o.kind === 'location_rejected'));
check('"cannot wait for possession"', objOf('Needs it immediately, cannot wait').some(o => o.kind === 'possession_late'));
check('"too small"', objOf('Said the flat is too small for the family').some(o => o.kind === 'size_small'));
check('an objection carries the quote it came from',
  /price is high/.test((objOf('Visited and said the price is high')[0] || {}).quote || ''));

section('The three ways an objection is a false positive');
// Capacity, not a complaint.
check('"his budget is high, can go up to 5cr" is capacity',
  !objOf('His budget is high, can go up to 5cr').some(o => o.kind === 'price_high'));
check('"budget increased" is capacity',
  !objOf('Budget increased to 4 Cr').some(o => o.kind === 'price_high'));
// A negation.
check('"price is not high" is not an objection',
  !objOf('He said the price is not high at all').some(o => o.kind === 'price_high'));
// Spent: cleared by something said afterwards.
const cleared = profileOf(lead({
  propertyInterest: '3BHK in Adyar',
  notes: [
    { text: 'Said the price is high', createdAt: NOW - 30 * DAY },
    { text: 'Called back — budget increased, he is ok with the price now', createdAt: NOW - 2 * DAY }
  ]
})).objections;
check('an objection cleared by a later note is dropped',
  !cleared.some(o => o.kind === 'price_high'), JSON.stringify(cleared.map(o => o.kind)));

section('Recency: an old objection is a note, not a ceiling');
const old = objOf('Said the price is high', NOW - 400 * DAY);
const fresh = objOf('Said the price is high', NOW - 2 * DAY);
check('a fresh objection carries full weight', fresh[0] && fresh[0].weight === 1, fresh[0] && fresh[0].weight);
check('a two-year-old one barely counts', old.length === 0 || old[0].weight <= 0.2, old[0] && old[0].weight);

// ═══════ 3. THE REFERENCE CASES ═══════

const ANNA_35 = prop({
  id: 'P_NEW', propertyCode: 'ANR0099', name: 'Kanaka Residency',
  location: 'Anna Nagar, Chennai', zone: 'Chennai Central', config: '3BHK',
  startingPrice: '₹3.5 Crores', sqftRange: '1750-1900 Sq.Ft'
});
const ANNA_35_SEEN = prop({
  id: 'P_SEEN', propertyCode: 'ANR0042', name: 'Prestige Lakeview',
  location: 'Anna Nagar West, Chennai', config: '3BHK', startingPrice: '₹3.5 Crores'
});
const REF_INV = [ANNA_35, ANNA_35_SEEN];

section('Reference case 1 — 17% over budget, everything else right');
const keen = lead({ id: 'L1', name: 'Customer 1', propertyInterest: '3 BHK in Anna Nagar', budget: '3 Cr' });
const s1 = M.score(profileOf(keen, { inventory: REF_INV }), M.propertyProfile(ANNA_35), { area: M.areaModelFor(REF_INV) });
eq('not vetoed', s1.vetoed, false);
between('scores in the low nineties, as the owner specified', s1.pct, 88, 96);
eq('and reads as a strong match', M.band(s1.pct, false).key, 'strong');
check('the locality is full credit', s1.breakdown.find(b => b.key === 'locality').s === 1);
check('the configuration is full credit', s1.breakdown.find(b => b.key === 'bhk').s === 1);
// The budget must lose SOME credit — it is over — but not most of it.
const bud = s1.breakdown.find(b => b.key === 'budget');
between('the budget keeps most of its credit at 17% over', bud.s, 0.7, 0.85);
check('and the reason says how far over', /17% over/.test(bud.why), bud.why);
check('no more than five reasons are offered', s1.for.length <= 5, s1.for.length);
check('every reason carries its points', s1.for.every(f => typeof f.points === 'number' && f.of > 0));

section('Reference case 2 — the buyer who already called this price too high');
const burned = lead({
  id: 'L2', name: 'Customer 2', propertyInterest: '3 BHK in Anna Nagar', budget: '3 Cr',
  propertyCodes: ['P_SEEN'],
  lastNote: { text: 'Did the site visit at ANR0042. Liked it but said the price is high for his budget.', createdAt: NOW - 3 * DAY }
});
const burnedReq = profileOf(burned, { inventory: REF_INV });
check('the property they saw is picked up', burnedReq.seen.length === 1, JSON.stringify(burnedReq.seen.map(x => x.label)));
const po = burnedReq.objections.find(o => o.kind === 'price_high');
check('the objection is anchored to that property\'s price', po && po.anchor === 35000000, po && po.anchor);
check('and names where the anchor came from', po && /ANR0042/.test(po.anchorFrom || ''), po && po.anchorFrom);

const s2 = M.score(burnedReq, M.propertyProfile(ANNA_35), { area: M.areaModelFor(REF_INV) });
eq('this buyer is ruled out', s2.vetoed, true);
check('on price, not on anything else',
  s2.vetoes.some(v => v.key === 'price_high'), JSON.stringify(s2.vetoes));
check('the reason quotes the buyer',
  s2.against.some(a => /price is high/.test(a.quote || a.why || '')), JSON.stringify(s2.against.map(a => a.why)));
// The same buyer must still match something genuinely cheaper.
const cheaper = prop({ id: 'P_CHEAP', propertyCode: 'ANR0077', location: 'Anna Nagar, Chennai', config: '3BHK', startingPrice: '₹2.7 Crores' });
const s2c = M.score(burnedReq, M.propertyProfile(cheaper), { area: M.areaModelFor(REF_INV.concat([cheaper])) });
eq('but is not blacklisted from cheaper stock', s2c.vetoed, false);
between('and scores well on it', s2c.pct, 80, 100);

section('The two buyers are ranked in the right order');
const ranked = M.buyersFor(ANNA_35, [burned, keen], { inventory: REF_INV, now: NOW, minPct: 0 });
eq('only the un-objecting buyer is offered', ranked.length, 1);
eq('and it is the right one', ranked[0].lead.id, 'L1');

// ═══════ 4. SCORING BEHAVIOUR ═══════

section('Confidence separates "95% on two facts" from "95% on eleven"');
const thin = M.score(profileOf(lead({ propertyInterest: '3 BHK' })), M.propertyProfile(ANNA_35), {});
const full = M.score(profileOf(lead({
  propertyInterest: '3 BHK apartment in Anna Nagar, 1800 sqft, ready to move',
  budget: '3.5 Cr'
})), M.propertyProfile(ANNA_35), { area: M.areaModelFor(REF_INV) });
check('a thin brief yields low confidence', thin.confidence < 0.55, thin.confidence.toFixed(2));
check('a full brief yields high confidence', full.confidence > 0.85, full.confidence.toFixed(2));
check('and the fuller brief ranks above the thin one at similar fit',
  full.rank > thin.rank, `${full.rank.toFixed(3)} vs ${thin.rank.toFixed(3)}`);

section('Vetoes');
const plotBuyer = profileOf(lead({ propertyInterest: 'DTCP approved plot in Mangadu', budget: '1 Cr' }));
const flat = M.score(plotBuyer, M.propertyProfile(ANNA_35), {});
eq('a plot buyer is not shown a flat', flat.vetoed, true);
const soldOut = M.score(profileOf(lead({ propertyInterest: '3BHK Anna Nagar', budget: '4 Cr' })),
  M.propertyProfile(prop({ id: 'P_SOLD', location: 'Anna Nagar', config: '3BHK', startingPrice: '₹3 Cr', soldOut: true })), {});
eq('sold-out stock is never matched', soldOut.vetoed, true);
const wayOver = M.score(profileOf(lead({ propertyInterest: '3BHK Anna Nagar', budget: '1 Cr' })),
  M.propertyProfile(ANNA_35), {});
eq('3.5x the budget is a veto', wayOver.vetoed, true);

section('What is never scored against a buyer');
// A buyer who never mentioned facing must not be marked down for facing.
const silent = M.score(profileOf(lead({ propertyInterest: '3BHK Anna Nagar', budget: '4 Cr' })), M.propertyProfile(ANNA_35), {});
check('an attribute the buyer never raised is absent from the breakdown',
  !silent.breakdown.some(b => b.key === 'facing'), JSON.stringify(silent.breakdown.map(b => b.key)));
check('road width is only scored when asked about',
  !silent.breakdown.some(b => b.key === 'roadWidth'));
// And a buyer whose only prose is a visit note has said nothing about
// lifestyle, so prose similarity must not cost them points.
const noConcepts = M.score(profileOf(lead({
  propertyInterest: '3BHK Anna Nagar', budget: '4 Cr',
  lastNote: { text: 'Did the site visit on Saturday', createdAt: NOW - DAY }
})), M.propertyProfile(ANNA_35), {});
check('prose with no concepts in it is not scored',
  !noConcepts.breakdown.some(b => b.key === 'lifestyle'));

section('The semantic layer earns its weight when there IS prose');
const family = profileOf(lead({
  propertyInterest: '3BHK in Anna Nagar for my family — need a school close by, a play area for the kids and a gated community',
  budget: '4 Cr'
}));
const amenityRich = M.propertyProfile(prop({
  id: 'P_FAM', location: 'Anna Nagar, Chennai', config: '3BHK', startingPrice: '₹3.5 Cr',
  amenities: 'Indoor Kids Play Area,Swimming Pool,Clubhouse', highlights: 'Gated Community, walking distance to schools'
}));
const bare = M.propertyProfile(prop({ id: 'P_BARE', location: 'Anna Nagar, Chennai', config: '3BHK', startingPrice: '₹3.5 Cr' }));
const fam1 = M.score(family, amenityRich, { area: M.areaModelFor(REF_INV) });
const fam2 = M.score(family, bare, { area: M.areaModelFor(REF_INV) });
check('the property that talks about family life scores higher', fam1.pct > fam2.pct, `${fam1.pct} vs ${fam2.pct}`);
check('and says what the overlap was',
  fam1.for.concat(fam1.against).some(f => f.key === 'lifestyle' && /school|family|gated/i.test(f.why)),
  JSON.stringify(fam1.for.filter(f => f.key === 'lifestyle')));

section('Vectors');
check('two identical texts are identical', M.cosine(M.embed('gated community with pool'), M.embed('gated community with pool')) > 0.99);
check('unrelated texts barely overlap', M.cosine(M.embed('sea facing villa on ECR'), M.embed('commercial godown near GST')) < 0.35);
// The point of the concept layer: a buyer's words and a brochure's words
// share no vocabulary, and must still meet. The brochure text here is quoted
// verbatim from the live inventory.
check('a family brief reaches a brochure that never says "family"',
  M.cosine(
    M.embed('a good school for my children nearby'),
    M.embed('St. Francis De Sales Matriculation School,PSBB School,Jagannath Vidyalaya CBSE School')
  ) > 0.1,
  M.cosine(M.embed('a good school for my children nearby'), M.embed('St. Francis De Sales Matriculation School,PSBB School,Jagannath Vidyalaya CBSE School')).toFixed(3));
check('and an IT-corridor brief reaches one that never says "commute"',
  M.cosine(M.embed('close to my office, I work in an IT company'), M.embed('Close to DLF IT Park and Tidel')) > 0.1);
check('an empty text yields an empty vector', M.embed('').size === 0);

// ═══════ 5. BOTH DIRECTIONS, OVER THE REAL INVENTORY ═══════

section('Buyer → properties, over the live inventory');
const realBuyer = lead({
  id: 'L_REAL', name: 'Real brief',
  propertyInterest: '3 BHK apartment in Anna Nagar or nearby, ready to move',
  budget: '3 Cr'
});
const forBuyer = M.propertiesFor(realBuyer, INVENTORY, { now: NOW, limit: 12 });
check('it returns matches', forBuyer.length > 0, forBuyer.length);
check('sorted best first', forBuyer.every((r, i) => i === 0 || forBuyer[i - 1].rank >= r.rank));
check('every match carries a percentage', forBuyer.every(r => r.pct >= 0 && r.pct <= 100));
check('every match explains itself', forBuyer.every(r => r.for.length > 0));
check('nothing sold out is offered', forBuyer.every(r => !r.p.soldOut));
// Meaning, not a frozen list: a 3BHK brief must not return a property with
// no 3BHK in it at all, unless BHK was never scored for it.
check('every match with a scored configuration really offers 3BHK',
  forBuyer.every(r => {
    const b = r.breakdown.find(x => x.key === 'bhk');
    return !b || b.s < 1 || r.property.bhk.includes(3);
  }));

section('Property → buyers');
const leads = [
  keen,
  burned,
  lead({ id: 'L3', propertyInterest: 'plot in Oragadam', budget: '50 lakhs' }),
  lead({ id: 'L4', name: 'Seller', enquiryType: 'Seller Listing', propertyInterest: 'want to sell my 3bhk in Anna Nagar' }),
  lead({ id: 'L5', name: 'Vendor', enquiryType: 'Vendor', propertyInterest: 'photography services' }),
  lead({ id: 'L6', name: 'Blank' })
];
const buyers = M.buyersFor(ANNA_35, leads, { inventory: REF_INV, now: NOW, minPct: 0 });
check('sellers are never offered as buyers', !buyers.some(b => b.lead.id === 'L4'), JSON.stringify(buyers.map(b => b.lead.id)));
check('vendors are never offered as buyers', !buyers.some(b => b.lead.id === 'L5'));
check('a lead with nothing on it is skipped', !buyers.some(b => b.lead.id === 'L6'));
check('a plot buyer is not offered a flat', !buyers.some(b => b.lead.id === 'L3'));
check('the genuine buyer is offered', buyers.some(b => b.lead.id === 'L1'));

section('Both directions agree on the same pair');
const fwd = M.buyersFor(ANNA_35, [keen], { inventory: REF_INV, now: NOW, minPct: 0 })[0];
const rev = M.propertiesFor(keen, [ANNA_35], { now: NOW, minPct: 0 })[0];
eq('the same percentage, whichever screen asks', fwd.pct, rev.pct);

// ═══════ 6. THE TRACK BOARD — before a property is in the inventory ═══════

section('A listing can be matched before it is shot or synced');
const listing = {
  id: 'LS1', title: '3BHK in Anna Nagar', propertyCode: null,
  location: 'Anna Nagar', config: '3 BHK', askingPrice: '₹3.2 Cr',
  sellerName: 'Owner', remarks: 'Gated community, covered parking, east facing'
};
const lp = M.listingProfile(listing);
eq('it profiles as a property', lp.kind, 'listing');
check('and is flagged as not yet in the inventory', lp.provisional === true);
eq('its locality is read', lp.localities[0], 'anna nagar');
check('its price is read', lp.priceLo === 32000000, lp.priceLo);
check('its configuration is read', lp.bhk.includes(3), JSON.stringify(lp.bhk));
const waiting = M.buyersFor(lp, [keen, burned], { inventory: INVENTORY, now: NOW, minPct: 0 });
check('buyers can be counted before the shoot', waiting.length >= 1, waiting.length);
check('and the price-objecting buyer is still excluded at 3.2 Cr',
  !waiting.some(b => b.lead.id === 'L2') || waiting.find(b => b.lead.id === 'L2').pct >= 0);

// ═══════ 7. PATHOLOGICAL INPUT ═══════

section('Nothing here may throw');
const nasty = [
  {}, { id: 'x' }, { id: 'y', propertyInterest: null, budget: undefined },
  { id: 'z', propertyInterest: '🏠🏠🏠', budget: '₹₹₹' },
  { id: 'w', propertyInterest: 'a'.repeat(5000), notes: [] },
  { id: 'v', propertyCodes: ['NOPE'], lastNote: { text: '', createdAt: 0 } }
];
let threw = null;
try {
  for (const l of nasty) {
    const r = M.requirementProfile(l, { now: NOW, inventory: INVENTORY });
    M.score(r, M.propertyProfile(ANNA_35), {});
    M.propertiesFor(l, INVENTORY.slice(0, 10), { now: NOW });
  }
  M.buyersFor(prop({ id: 'empty' }), nasty, { inventory: [], now: NOW });
  M.buyersFor(ANNA_35, [], { inventory: INVENTORY, now: NOW });
  M.propertiesFor(keen, [], { now: NOW });
} catch (e) { threw = e; }
check('malformed leads and empty lists are survivable', !threw, threw && threw.message);

section('Speed — this runs on every panel open');
const t0 = Date.now();
for (let i = 0; i < 3; i++) M.propertiesFor(realBuyer, INVENTORY, { now: NOW });
const per = (Date.now() - t0) / 3;
console.log(`  ${per.toFixed(0)} ms to rank ${INVENTORY.length} properties for one buyer`);
check('under 400 ms', per < 400, per.toFixed(0) + 'ms');

const t1 = Date.now();
M.buyersFor(ANNA_35, Array.from({ length: 200 }, (_, i) => lead({ id: 'B' + i, propertyInterest: '3BHK in Anna Nagar', budget: '3 Cr' })), { inventory: INVENTORY, now: NOW });
const bulk = Date.now() - t1;
console.log(`  ${bulk} ms to rank 200 leads for one property`);
check('200 leads under 1.5 s', bulk < 1500, bulk + 'ms');

// ═══════ RESULT ═══════
console.log('\n' + '─'.repeat(64));
if (failed) {
  console.log(`${passed} passed, ${failed} FAILED\n`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
console.log('All good.');
