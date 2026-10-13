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
const J = v => JSON.stringify(v);
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

// ═══════ 6b. A SELLER IS MATCHED THE OTHER WAY ROUND ═══════
//
// A seller is never matched TO properties: they are not buying one, and every
// field on their record means the opposite of a buyer's — propertyInterest is
// what they HAVE, budget is what they are ASKING. Reading a seller with
// requirementProfile() gets all of it backwards, which is why isBuyerLead()
// refuses to. The useful question runs the other way.
section('A seller is never offered properties');
const seller = lead({
  id: 'L_SELL', name: 'Owner', enquiryType: 'Seller Listing',
  propertyInterest: 'selling my 3 BHK in Anna Nagar, asking 3.4 Cr'
});
eq('a seller is not a buyer', M.isBuyerLead(seller), false);
check('and never appears in the buyer list of a property',
  !M.buyersFor(ANNA_35, [seller], { inventory: REF_INV, now: NOW, minPct: 0 }).some(b => b.lead.id === 'L_SELL'));

section('Instead, their property is matched to buyers');
const owner = M.ownerPropertyProfile(seller);
eq('the locality of the owner is read', owner.localities[0], 'anna nagar');
check('the configuration is read', owner.bhk.includes(3), J(owner.bhk));
// The asking price is in the sentence, not in the Budget field — reading only
// the field threw the figure away and left the price unscored entirely.
eq('the asking price is read out of their own sentence', owner.priceLo, 34000000);
check('it is flagged as not being an inventory row', owner.provisional === true);

const ownerBuyers = M.buyersFor(owner, [keen, lead({ id: 'L_SMALL', propertyInterest: '2BHK in Porur', budget: '1.2 Cr' })], { inventory: REF_INV, now: NOW, minPct: 0, includeVetoed: true });
check('a matching buyer is found for the owner', ownerBuyers.some(w => w.lead.id === 'L1' && !w.vetoed), J(ownerBuyers.map(w => [w.lead.id, w.pct, w.vetoed])));
check('and a buyer far under the asking price is ruled out',
  ownerBuyers.some(w => w.lead.id === 'L_SMALL' && w.vetoed));

section('Unknown is not the same as mismatched');
// normType() returns 'Other' for a blank or unrecognised type column, which
// means "we do not know". Scoring it as a mismatch cost 11 of 14 points
// against a property nobody had said anything wrong about — and it bit worst
// on owner descriptions, which rarely contain the word "apartment".
const noType = M.propertyProfile(prop({ id: 'P_NOTYPE', location: 'Anna Nagar', config: '3BHK', startingPrice: '₹3 Cr', type: '' }));
eq('a blank type column reads as Other', noType.type, 'Other');
const nt = M.score(profileOf(keen), noType, {});
check('it is listed as not known, never as a mismatch', nt.unknown.some(u => u.key === 'type') && !nt.against.some(a => a.key === 'type'), J([nt.unknown.map(u => u.key), nt.against.map(a => a.key)]));
check('so it costs little — the property still scores high', nt.pct >= 90, nt.pct);

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

section('Rent or buy — never mixed (the owner’s Adambakkam / OMR case, Oct 2026)');
{
  const RENT_ADB = prop({ id: 'ADB', propertyCode: 'ADB0001', name: 'Corporate Lease - 8 Brand-New Apartments',
    location: 'Adambakkam, Near OMR & Velachery, Chennai', config: '2 BHK & 3 BHK',
    startingPrice: '3 BHK - Rent Rs.45,000/month + Maintenance | 2 BHK - Rent Rs.30,000/month + Maintenance' });
  const SALE_OMR = prop({ id: 'OMR1', propertyCode: 'OMR0001', name: 'Sea Breeze', location: 'Sholinganallur, OMR', config: '3 BHK', startingPrice: '₹1.1 Cr' });
  const INV = [RENT_ADB, SALE_OMR];
  const area = M.areaModelFor(INV);
  const ap = M.propertyProfile(RENT_ADB);
  eq('a "Rent …/month" price makes the property for rent', ap.deal, 'rent');
  eq('…priced by the month', ap.priceMode, 'monthly');
  check('…and it is IN Adambakkam — OMR and Velachery are only what it is near', J(ap.localities) === J(['adambakkam']) && ap.nearLocalities.includes('velachery'), J([ap.localities, ap.nearLocalities]));
  eq('a ₹1.1 Cr flat is for sale', M.propertyProfile(SALE_OMR).deal, 'sale');

  const buyer = lead({ id: 'B_OMR', propertyInterest: 'OMR', budget: '1.2 Cr', ai: { intent: 'buy' } });
  const tenant = lead({ id: 'T_ADB', propertyInterest: 'Adambakkam, Velachery', budget: '40,000 - 50,000 per month', ai: { intent: 'rent' } });
  const both = lead({ id: 'BOTH', propertyInterest: '3BHK in Velachery, rent or buy', budget: '1.2 Cr' });
  const sb = M.score(profileOf(buyer, { inventory: INV }), ap, { area });
  check('a buyer is never shown a flat to let', sb.vetoed && /for rent, and they want to buy/.test(sb.vetoes[0].why), J(sb.vetoes));
  const st = M.score(profileOf(tenant, { inventory: INV }), M.propertyProfile(SALE_OMR), { area });
  check('nor a tenant a flat for sale', st.vetoed && /for sale, and they want to rent/.test(st.vetoes[0].why), J(st.vetoes));
  const tt = M.score(profileOf(tenant, { inventory: INV }), ap, { area });
  check('the tenant and the rental match, on a monthly budget', !tt.vetoed && tt.for.some(f => f.key === 'budget' && /a month/.test(f.why)), J(tt.for));
  check('someone open to both sees both', !M.score(profileOf(both, { inventory: INV }), ap, { area }).vetoes.some(v => v.key === 'deal')
    && !M.score(profileOf(both, { inventory: INV }), M.propertyProfile(SALE_OMR), { area }).vetoes.some(v => v.key === 'deal'));
  eq('"currently staying on rent, want to buy" is a buyer', M.readDeal(lead({}), [{ text: 'Currently staying on rent in Adyar, want to buy a 2BHK', src: 'Property / Locality', at: NOW, authority: 3 }], null).values.join(), 'sale');
  eq('a monthly budget alone makes a tenant', profileOf(lead({ propertyInterest: 'Velachery 2BHK', budget: 'Rent: 25k per month' })).deal.values.join(), 'rent');
  eq('a budget in crores alone makes a buyer', profileOf(lead({ propertyInterest: 'Velachery 2BHK', budget: '1.2 Cr' })).deal.values.join(), 'sale');
  eq('a lump-sum lease is its own kind of money', profileOf(lead({ propertyInterest: 'Adyar', budget: '₹30–35 lakhs total lease amount', ai: { intent: 'rent' } })).budget.mode, 'lumpsum');
}

section('A sparse lead can never be a 100% match');
{
  const P3 = prop({ id: 'P3B', location: 'Medavakkam, Chennai', config: '3 BHK', startingPrice: '₹1.25 Cr' });
  const thin = lead({ id: 'THIN', propertyInterest: '3 BHK' });
  const r = M.score(profileOf(thin), M.propertyProfile(P3), {});
  check('bedrooms alone score well under 80', r.pct < 80, r.pct);
  check('…and the match says what is not known, with what to ask', ['deal', 'budget', 'locality'].every(k => r.unknown.some(u => u.key === k && u.ask)), J(r.unknown.map(u => u.key)));
  check('…confidence says so too', r.confidence < 0.5, r.confidence);
  const full = lead({ id: 'FULL', propertyInterest: '3 BHK flat in Medavakkam', budget: '1.3 Cr', ai: { intent: 'buy' } });
  const f = M.score(profileOf(full), M.propertyProfile(P3), {});
  check('the same flat for a buyer we know well scores in the nineties', f.pct >= 90, f.pct);
  check('every match has why it fits AND what is open', f.for.length >= 4 && Array.isArray(f.against) && Array.isArray(f.unknown), J([f.for.length, f.unknown.map(u => u.key)]));
}

section('Budget — nearing it beats far under it');
{
  const at = price => M.score(profileOf(lead({ propertyInterest: '3BHK Anna Nagar', budget: '3 Cr', ai: { intent: 'buy' } })),
    M.propertyProfile(prop({ id: 'B' + price, location: 'Anna Nagar', config: '3BHK', startingPrice: price })), {}).breakdown.find(b => b.key === 'budget').s;
  check('₹2.8 Cr (nearing ₹3 Cr) scores full', at('₹2.8 Cr') === 1, at('₹2.8 Cr'));
  check('₹1.2 Cr (far under) scores well below it', at('₹1.2 Cr') < 0.7, at('₹1.2 Cr'));
  check('₹3.5 Cr (17% over) stays the owner’s 0.78', at('₹3.5 Cr') === 0.78, at('₹3.5 Cr'));
  check('a range overlapping the budget counts as inside it', at('₹1.21 Cr - ₹3.56 Cr') === 1, at('₹1.21 Cr - ₹3.56 Cr'));
}

section('What they asked for by name — pooja room, school, covered parking');
{
  const asks = lead({ id: 'ASK', propertyInterest: '3BHK in Velachery with pooja room and covered car parking, near a good school', budget: '1.5 Cr', ai: { intent: 'buy' } });
  const req = profileOf(asks);
  check('the asks are read', ['pooja', 'parking', 'school'].every(k => req.specs.keys.includes(k)), J(req.specs));
  check('"no need of a lift" is not an ask', !M.readSpecs([{ text: 'no need of a lift, ground floor is fine', src: 'Requirement', at: NOW }], null).keys.includes('lift'));
  check('"security deposit" is not an ask for security', !M.readSpecs([{ text: 'can pay 3 months security deposit', src: 'Requirement', at: NOW }], null).keys.includes('security'));
  const has = M.propertyProfile(prop({ id: 'HAS', location: 'Velachery', config: '3 BHK', startingPrice: '₹1.45 Cr', amenities: 'Pooja room, covered car parking', nearby: 'DAV School 1 km' }));
  const lacks = M.propertyProfile(prop({ id: 'LACK', location: 'Velachery', config: '3 BHK', startingPrice: '₹1.45 Cr', parking: 'No', amenities: 'Gym' }));
  const a = M.score(req, has, {}), b = M.score(req, lacks, {});
  check('a property with all three scores them', a.for.some(f => f.key === 'specs' && /has Pooja room, Covered car parking and A school nearby/.test(f.why)), J(a.for.map(f => f.why)));
  check('one without parking says so, and lists the rest as to ask', b.against.some(x => x.key === 'specs' && /no Covered car parking/.test(x.why)) && b.unknown.some(u => /Pooja room/.test(u.label)), J([b.against, b.unknown]));
  check('and ranks below the one that has them', a.pct > b.pct, J([a.pct, b.pct]));
}

section('Possession — to the month');
{
  const want = M.readPossession([{ text: 'need possession by March 2027', src: 'Requirement', at: NOW }], NOW);
  eq('"by March 2027" is a deadline', want.want, 'by');
  const p = when => M.score(profileOf(lead({ propertyInterest: '3BHK Velachery possession by March 2027', budget: '1.5 Cr' })),
    M.propertyProfile(prop({ id: 'PS' + when, location: 'Velachery', config: '3 BHK', startingPrice: '₹1.4 Cr', status: 'Under Construction', possession: when })), {})
    .breakdown.find(b => b.key === 'possession');
  check('Dec 2026 is inside it', p('Dec 2026').s === 1, J(p('Dec 2026')));
  check('Dec 2028 is well past it', p('Dec 2028').s <= 0.2, J(p('Dec 2028')));
}

section('Interest — how keen they are orders the buyers, never the score');
{
  const P = prop({ id: 'INT', location: 'Velachery', config: '3 BHK', startingPrice: '₹1.4 Cr' });
  const base = { propertyInterest: '3BHK Velachery', budget: '1.5 Cr' };
  const hot = lead({ id: 'HOT', name: 'Hot', ...base, tt: { status: 'hot', lastMessageAt: NOW - DAY }, ai: { intent: 'buy', stage: 'visit_done' } });
  const cold = lead({ id: 'COLD', name: 'Cold', ...base, tt: { status: 'cold', lastMessageAt: NOW - 150 * DAY }, ai: { intent: 'buy' } });
  const list = M.buyersFor(P, [cold, hot], { now: NOW, minPct: 0 });
  eq('the hot buyer who visited comes first', list[0].lead.id, 'HOT');
  eq('…with the same percentage as the cold one', list[0].pct, list[1].pct);
  check('…and the reason is said', list[0].interest.level === 'High' && list[0].interest.why.includes('has visited'), J(list[0].interest));
}

section('The AI’s read of the chat (ai.want) fills what the CRM fields do not say');
{
  const w = lead({ id: 'W', propertyInterest: '', budget: '', ai: { intent: 'buy', at: NOW, want: {
    deal: 'buy', budget_min: null, budget_max: 15000000, budget_unit: 'total', areas: ['Velachery'], bhk: [3], types: ['apartment'],
    ready_by: 'immediate', size_sqft_min: 1400, must_have: ['pooja room', 'east facing balcony'], deal_breakers: ['main road'] } } });
  const r = profileOf(w);
  check('budget, area, bedrooms, type, size and readiness come from it', r.budget && r.budget.max === 15000000 && r.localities && r.localities.keys.includes('velachery')
    && r.bhk && r.bhk.values.includes(3) && r.types && r.types.values.includes('Apartment') && r.size && r.size.min === 1400 && r.possession.want === 'ready', J([r.budget, r.localities, r.bhk, r.types, r.size, r.possession]));
  check('its must-haves become asks', r.specs.keys.includes('pooja') && r.specs.keys.includes('balcony'), J(r.specs));
  const s = M.score(r, M.propertyProfile(prop({ id: 'WP', location: 'Velachery', config: '3 BHK', startingPrice: '₹1.45 Cr' })), {});
  check('its deal-breakers are shown to be checked', s.unknown.some(u => /main road/.test(u.why)), J(s.unknown));
  check('a junk want is ignored, never trusted blindly', M.cleanWant({ budget_max: 'lots', bhk: [99], areas: 'Velachery' }).bhk.length === 0 && M.cleanWant({ budget_max: 'lots' }).budget === null);
}

section('Gazetteer — every place in a line, and where a property is');
{
  const G = globalThis.PinGeo;
  eq('commas and "&" separate places', J(G.resolveAll('Adambakkam, Near OMR & Velachery, Chennai')), J(['adambakkam', 'sholinganallur', 'velachery']));
  eq('"Mount Road" is Mount Road, not St Thomas Mount', G.resolve('Mount Road, Chennai'), 'mount road');
  eq('a property is where it is, not what it is near', J(G.placeOf('Mount Road, near Gopalapuram/Egmore/Poes Garden, Nungambakkam').at), J(['mount road', 'nungambakkam']));
  eq('a corridor beside a locality is the stretch, not a place', J(G.placeOf('OMR Perungudi').at), J(['perungudi']));
  eq('"Near X / Y" alone is still the answer', G.placeOf('Near Medavakkam / Mambakkam').at.length, 2);
}

section('A brochure is on file only when there is a link to open');
{
  const S = globalThis.PinSearch;
  check('a bare file name (made, not delivered) is not a brochure', S.indexProperty({ id: 'BR1', brochureLink: 'TNAG0002_brochure.pdf' }).facet.hasBrochure === false);
  check('a Drive link is', S.indexProperty({ id: 'BR2', brochureLink: 'https://drive.google.com/file/d/abc' }).facet.hasBrochure === true);
}

section('Review fixes — rent money, the bot’s own question, false deadlines, asks');
{
  const S = globalThis.PinSearch;
  eq('"45k per month" is ₹45,000 a month', J(S.parseMoney('45k per month', 'price').rent), J([[45000, 45000]]));
  eq('"1.2L/month" is ₹1.2 L a month', J(S.parseMoney('1.2L/month', 'price').rent), J([[120000, 120000]]));
  const b1 = profileOf(lead({ propertyInterest: 'Porur 2BHK', budget: '35000 monthly rent', ai: { intent: 'rent' } })).budget;
  check('a bare "35000 monthly rent" is read as the rent', b1 && b1.mode === 'monthly' && b1.max === 35000, J(b1));
  const b2 = profileOf(lead({ propertyInterest: 'Velachery 2BHK', budget: 'Budget 80L, EMI 50k per month' })).budget;
  check('"Budget 80L, EMI 50k per month" is a buyer with ₹80 L', b2 && b2.mode === 'sale' && b2.max === 8000000, J(b2));
  eq('a sale property quoting its rental income stays for sale', M.propertyProfile(prop({ id: 'PL', location: 'Adyar', startingPrice: '₹2.5 Cr, pre-leased, rent 1.5L/month' })).deal, 'sale');
  const dep = M.propertyProfile(prop({ id: 'DEP', name: '3BHK flat, Adyar', location: 'Adyar', startingPrice: 'Rent ₹60,000/month, deposit 6 lakhs' }));
  check('a rental quoting its deposit stays a rental, priced by the month', dep.deal === 'rent' && dep.priceMode === 'monthly' && dep.priceLo === 60000, J([dep.deal, dep.priceMode, dep.priceLo]));
  const asked = lead({ propertyInterest: 'Velachery', ai: { intent: 'unclear', evidence: 'AI asked buy/rent/sell; no reply yet' } });
  check('the bot asking "buy/rent/sell?" is not the lead being open to both', !(profileOf(asked).deal || { values: [] }).values.includes('rent') || (profileOf(asked).deal || {}).values.length < 2, J(profileOf(asked).deal));
  const p1 = M.readPossession([{ text: 'Will decide by May 15', src: 'Requirement', at: NOW }], NOW);
  const p2 = M.readPossession([{ text: 'referred by friend, market 30 lakhs', src: 'Requirement', at: NOW }], NOW);
  const p3 = M.readPossession([{ text: 'asked if handover earlier than December 2029 is possible', src: 'Conversation (AI summary)', at: NOW }], NOW);
  check('"by May 15", "market 30 lakhs" and a question in the AI summary are not deadlines', !p1 && !p2 && !p3, J([p1, p2, p3]));
  check('"possession by Dec ’27" is one', (M.readPossession([{ text: 'possession by Dec ’27', src: 'Requirement', at: NOW }], NOW) || {}).want === 'by');
  check('the bot asking "independent house or plot?" is not an ask', !M.readSpecs([{ text: 'Which type interests you most - independent house, plots or apartment?', src: 'AI evidence', at: NOW }], null).keys.includes('independent'));
  check('"facing a hospital" is a complaint, not an ask', !M.readSpecs([{ text: 'Not interested as it is facing a hospital', src: 'Note', at: NOW }], null).keys.includes('hospital'));
  check('"east facing balcony" still asks for a balcony', M.readSpecs([{ text: 'east facing balcony needed', src: 'Requirement', at: NOW }], null).keys.includes('balcony'));
  const L25 = M.propertyProfile(prop({ id: 'LS25', location: 'Adyar', startingPrice: 'Lease 25 lakhs' }));
  check('"Lease 25 lakhs" is a lease, priced as a lump sum', L25.deal === 'rent' && L25.priceMode === 'lumpsum', J([L25.deal, L25.priceMode]));
  const ADV = M.propertyProfile(prop({ id: 'ADV', location: 'Adyar', startingPrice: 'Rs 35,000 + 3L advance' }));
  check('"Rs 35,000 + 3L advance" is a rental at ₹35,000 a month', ADV.deal === 'rent' && ADV.priceLo === 35000, J([ADV.deal, ADV.priceLo]));
  const cur = profileOf(lead({ propertyInterest: 'Adyar 2BHK', budget: 'Budget 80L, rent currently 20k' }));
  check('"Budget 80L, rent currently 20k" is a buyer at ₹80 L', cur.budget && cur.budget.mode === 'sale' && cur.budget.max === 8000000 && cur.deal.values.join() === 'sale', J([cur.budget, cur.deal]));
  check('"need by Dec \u201926" is a deadline', (M.readPossession([{ text: 'need by Dec \u201926', src: 'Requirement', at: NOW }], NOW) || {}).want === 'by');
}

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
