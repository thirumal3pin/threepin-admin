// ═══════ MATCHING — THE OWNER'S SCENARIOS, AS A CONTRACT (Nov 2026) ═══════
//
//   node tests/match-scenarios.test.mjs
//
// The ten tests in the owner's brief, and the rules behind them, asserted against the shared files
// every screen runs (match-engine.js, match-sources.js) and the API that serves them to the Match
// page and Eåsy (api/_match.js). The measured accuracy over the whole labelled set is a separate
// report: node tests/match-eval.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as D from './fixtures/match-eval-data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = f => new Function(fs.readFileSync(path.join(here, '..', ...f.split('/')), 'utf8'))();
['dashboard-assets/search-engine.js', 'shared-assets/chennai-geo.js', 'shared-assets/area-model.js', 'shared-assets/match-engine.js', 'shared-assets/match-sources.js'].forEach(load);
const M = globalThis.PinMatch, PS = globalThis.PinSources, G = globalThis.PinGeo;

let passed = 0, failed = 0;
const fails = [];
const check = (label, cond, detail) => { if (cond) passed++; else { failed++; fails.push(label + (detail !== undefined ? ' — ' + detail : '')); } };
const section = t => console.log('\n── ' + t);

const U = PS.buildUnified({ properties: D.PROPERTIES, listings: D.LISTINGS, leads: D.LEADS, submissions: D.SUBMISSIONS, trackStages: D.TRACK_STAGES });
const ids = rows => rows.filter(r => !r.vetoed).map(r => r.link ? r.link.id : r.leadId);
const find = text => PS.findProperties(text, U, { now: D.NOW });
const findAll = text => PS.findProperties(text, U, { now: D.NOW, includeVetoed: true, minPct: 0 });
const row = (rows, id) => rows.find(r => (r.link ? r.link.id : r.leadId) === id);

section('The unified list — every opportunity, once, with where it stands');
{
  const kinds = U.reduce((o, e) => { o[e.src.kind] = (o[e.src.kind] || 0) + 1; return o; }, {});
  check('onboarded properties are in it', kinds.onboarded === D.PROPERTIES.length - 1, JSON.stringify(kinds));
  check('a sold property is not', !U.some(e => e.src.ids.propertyId === 'P27'));
  check('Shoot board cards are in it (live ones only — the dropped card is not)', kinds.listing === 6 && !U.some(e => e.src.ids.listingId === 'L06'), JSON.stringify(kinds));
  check('unprocessed seller leads are in it', U.some(e => e.src.ids.leadId === 'S01') && U.some(e => e.src.ids.leadId === 'S03'));
  check('a closed seller lead is not', !U.some(e => e.src.ids.leadId === 'S04'));
  check('a seller lead with a card is ONE row (the card), with the lead under alsoIn', !U.some(e => e.src.kind === 'seller' && e.src.ids.leadId === 'S05') && U.find(e => e.src.ids.listingId === 'L01').src.alsoIn.some(a => a.id === 'S05'));
  check('a pending agent submission is in it', U.some(e => e.src.kind === 'submission'));
  const l01 = U.find(e => e.src.ids.listingId === 'L01');
  check('a card says its stage in words', l01.src.status === 'More details pending', l01.src.status);
  check('a card is never marked verified', l01.src.verified === false && l01.src.trust === 'seller');
  check('the card\'s facts say what they rest on', l01.src.facts.some(f => f.label === 'Price' && f.src === 'seller'));
  check('an onboarded property is verified', U.find(e => e.src.ids.propertyId === 'P02').src.verified === true);
  const dupProps = D.PROPERTIES.concat([{ ...D.PROPERTIES[1], id: 'P02B', propertyCode: 'P02B' }]);
  const U2 = PS.buildUnified({ properties: dupProps, listings: [], leads: [], submissions: [] });
  check('a duplicate inventory row is folded into one', U2.filter(e => /Anna Nagar 2nd Avenue/.test(e.name)).length === 1);
}

section('TEST 1 — 2 BHK in Anna Nagar, ₹2 Cr');
{
  const r = find('2 BHK apartment in Anna Nagar, budget ₹2 Cr');
  check('the Anna Nagar 2BHK comes first', ids(r)[0] === 'P01', ids(r).slice(0, 3).join());
  check('a sold flat never appears', !ids(r).includes('P27'));
  check('no land, no rentals', !ids(r).some(id => ['P19', 'P20', 'P21', 'P13'].includes(id)));
}

section('TEST 2 — 2 grounds of land for sale in Choolaimedu');
{
  const r = find('2 grounds of land for sale in Choolaimedu');
  const top3 = ids(r).slice(0, 3).sort().join();
  check('the onboarded land, the Shoot-board land and the seller\'s land are the top three', top3 === ['L02', 'P19', 'S03'].sort().join(), ids(r).join());
  check('no apartment is offered', !ids(r).some(id => /^P0[1-8]$|^P2[1-4]$|^P26$/.test(id)));
  const a = findAll('2 grounds of land for sale in Choolaimedu');
  check('an apartment is ruled out, with the reason', row(a, 'P02').vetoed && /Plot|land/i.test(row(a, 'P02').vetoes.map(v => v.why).join()));
  check('land is compared in grounds', /grounds/.test(row(a, 'P19').breakdown.find(b => b.key === 'size').why));
}

section('TEST 3 — commercial space for rent, ₹2.5 L a month, Valasaravakkam');
{
  const r = find('Commercial space for rent in Valasaravakkam, ₹2.5 Lakhs/month');
  check('the onboarded space and the new seller enquiry come first', ids(r).slice(0, 2).sort().join() === 'L03,P18', ids(r).join());
  const a = findAll('Commercial space for rent in Valasaravakkam, ₹2.5 Lakhs/month');
  check('an office for SALE is ruled out — rent is never compared with a sale price', row(a, 'P28').vetoed && /for sale/.test(row(a, 'P28').vetoes[0].why));
  check('the rent is compared month to month', /a month/.test(row(a, 'P18').breakdown.find(b => b.key === 'budget').why));
}

section('TEST 4 / 7 — 3 BHK ~2,000 sq ft in Anna Nagar (or Kilpauk), ~₹3 Cr');
{
  const r = find('3 BHK, approximately 2,000 Sq.Ft., Anna Nagar, ₹3 Cr');
  check('onboarded AND not-yet-onboarded 3BHKs in Anna Nagar lead', ['P02', 'P03', 'L01'].every(id => ids(r).slice(0, 4).includes(id)), ids(r).join());
  check('the card shows as a Shoot board opportunity, not a listing', row(r, 'L01').sourceLabel === 'Shoot board' && row(r, 'L01').status === 'More details pending');
  const r7 = find('3 BHK in Anna Nagar or Kilpauk, budget around ₹3 Cr');
  check('both places are understood', ['P02', 'P03', 'P04', 'L01', 'S01'].every(id => ids(r7).slice(0, 6).includes(id)), ids(r7).join());
  const req = M.briefProfile('3 BHK in Anna Nagar or Kilpauk, budget around ₹3 Cr', {});
  check('"around" makes the budget flexible', req.budget.flexible === true);
}

section('TEST 5 — a 3BHK in Anna Nagar, 2,000 sq ft, ₹3 Cr: who wants it?');
{
  const rows = PS.findClients(PS.propertyFromDetails({ type: 'Apartment', bhk: 3, location: 'Anna Nagar', area: 2000, price: 30000000, deal: 'sale', condition: 'resale' }), D.LEADS, { inventory: D.PROPERTIES, unified: U, stages: D.STAGES, now: D.NOW });
  const got = ids(rows);
  check('the Anna Nagar 3BHK buyers are found', ['B01', 'B02', 'B11', 'B12'].every(id => got.includes(id)), got.join());
  check('a lost lead is never offered', !got.includes('B09'));
  check('a tenant is not a buyer', !got.includes('B06'));
  check('a seller is not a buyer', !got.includes('S01') && !got.includes('S04'));
  check('an Adyar buyer is not offered an Anna Nagar flat', !got.includes('B05'));
  const b01 = row(rows, 'B01');
  check('a client row carries budget, places, stage, owner and the next step', b01.budget && b01.locations.length && b01.stage && 'owner' in b01 && b01.next);
  check('…and the budget difference and location fit', b01.budgetDiff && b01.location2.level === 'exact');
  check('the client with two requirements is matched on the right one', row(rows, 'B19') && row(rows, 'B19').reqIndex === 0);
}

section('TEST 6 — a seller lead on the Shoot board, matched before onboarding');
{
  const l01 = U.find(e => e.src.ids.listingId === 'L01');
  const got = ids(PS.findClients(l01, D.LEADS, { inventory: D.PROPERTIES, unified: U, stages: D.STAGES, now: D.NOW }));
  check('buyers are found for a property still in "More details pending"', ['B01', 'B02', 'B11'].every(id => got.includes(id)), got.join());
  const dem = PS.demandFor(U, D.LEADS, { stages: D.STAGES, now: D.NOW, minPct: 65 });
  check('the demand list puts it on top, with its buyer count', dem[0] && dem[0].entry.src.ids.listingId === 'L01' && dem[0].buyers >= 4, dem[0] && dem[0].entry.name);
}

section('TEST 8 — commercial building for lease, 5,000 sq ft, T Nagar');
{
  const r = find('Commercial building for lease, 5,000 Sq.Ft., T. Nagar');
  check('the T Nagar building comes first', ids(r)[0] === 'P17', ids(r).join());
  check('a warehouse is not offered', !ids(r).includes('P25'));
  const back = ids(PS.findClients(U.find(e => e.src.ids.propertyId === 'P17'), D.LEADS, { inventory: D.PROPERTIES, unified: U, stages: D.STAGES, now: D.NOW }));
  check('reversed: the building tenant is found', back.includes('B16'), back.join());
}

section('TEST 9 — 4 grounds for a joint venture');
{
  const r = find('4 grounds for joint venture in Chennai');
  check('only JV-open land is offered', ids(r).sort().join() === 'L05,P20', ids(r).join());
  const a = findAll('4 grounds for joint venture in Chennai');
  check('outright-sale land is ruled out, saying to ask the owner', row(a, 'P19').vetoed && /joint venture/.test(row(a, 'P19').vetoes[0].why));
  check('"in Chennai" is a stated answer (anywhere), not a missing one', M.briefProfile('4 grounds for joint venture in Chennai', {}).localities.anywhere === true);
}

section('TEST 10 — Adyar, excluding Mogappair');
{
  const a = findAll('Apartment in Adyar, excluding Mogappair');
  check('every Mogappair flat is ruled out, quoting them', ['P05', 'P06', 'P23'].every(id => row(a, id).vetoed && /ruled out/.test(row(a, id).vetoes.map(v => v.why).join())));
  check('the Adyar flats (and the agent\'s submission) come first', ids(a).slice(0, 3).sort().join() === 'P07,P08,U01', ids(a).join());
  const r = M.briefProfile('Client not interested in Mogappair. Looking at MRC Nagar, RA Puram and Poes Garden. Budget 3 Cr.', {});
  check('a CRM remark: the refused place is an exclusion, the rest are wanted', r.localities.exclude.includes('mogappair') && !r.localities.keys.includes('mogappair') && r.localities.keys.includes('mrc nagar'));
  check('"not Mogappair" alone counts too', M.briefProfile('3bhk anna nagar 3 cr, not Mogappair', {}).localities.exclude.includes('mogappair'));
  check('"not more than 80 lakhs" is NOT an exclusion of anything, and is a ceiling', (() => { const x = M.briefProfile('2bhk in porur not more than 80 lakhs', {}); return x.localities.keys[0] === 'porur' && !x.localities.exclude.length && x.budget.max === 8000000; })());
}

section('Reading the words — units, money, kinds, spelling, Tamil-English');
{
  const b = t => M.briefProfile(t, {});
  check('rent per annum becomes a monthly rent', (x => x.budget.mode === 'monthly' && x.budget.max === 250000)(b('Commercial space for rent, 30 lakhs per annum, Guindy')));
  check('a rate per sq ft is its own kind of budget', b('flat in Adyar up to 15000 per sqft').budget.mode === 'psf');
  check('acres are converted', b('Agricultural land 2 acres in Chengalpattu').size.min === 87120);
  check('cents are converted', Math.round(b('plot of 10 cents in Tambaram').size.min) === 4356);
  check('a misspelt locality is understood, and said so', (x => x.localities.keys[0] === 'anna nagar' && x.localities.fuzzy.length === 1)(b('3bhk anna nagr la venum, budget 3 cr kulla')));
  check('"X vendam" is an exclusion', b('2bhk velachery, OMR vendam').localities.exclude.includes('sholinganallur') || b('2bhk velachery, Medavakkam vendam').localities.exclude.includes('medavakkam'));
  check('"near my office" does not make a home buyer a commercial buyer', !b('2bhk near my office in Guindy').types || !b('2bhk near my office in Guindy').types.values.includes('Commercial'));
  check('industrial land is land, not commercial space', (x => x.types.values.join() === 'Plot' && x.types.subs.Plot === 'industrial_land')(b('Industrial land for sale in Oragadam')));
  check('"new or resale" is no preference', !b('3bhk anna nagar, new or resale').facets.saleType);
  check('"within 5 km of Adyar" keeps the radius', b('Anything within 5 km of Adyar, 3 BHK').localities.radiusKm === 5);
  check('a retail tenant\'s frontage and parking are asks', (x => x.specs.keys.includes('frontage') && x.specs.keys.includes('anyParking'))(b('Retail showroom for lease in Nungambakkam with frontage and parking')));
}

section('Scores that mean something');
{
  const a = findAll('Retail showroom for lease in Nungambakkam with frontage and parking');
  check('an office scores well below a showroom for a retail tenant', row(a, 'P16').pct - row(a, 'P15').pct >= 25, `${row(a, 'P16').pct} vs ${row(a, 'P15').pct}`);
  const v = findAll('Villa for sale in ECR with a private swimming pool');
  check('a villa with a pool beats one without', row(v, 'P10').pct > row(v, 'P11').pct);
  const h = findAll('Independent house for sale in Velachery, budget ₹2.5 Cr');
  check('a flat cannot be a strong match for someone who wants a house', row(h, 'P24').pct < 70, row(h, 'P24').pct);
  const t = findAll('2 BHK apartment in Anna Nagar, budget ₹2 Cr');
  check('a flat 10 km away cannot be a strong match however well the rest fits', row(t, 'P08').pct < 55, row(t, 'P08').pct);
  check('every reason is traceable: a score always has its breakdown', t.every(r => r.breakdown && r.breakdown.length));
  check('the reference case still holds: 3BHK Anna Nagar ₹3 Cr vs ₹3.5 Cr is in the high 80s or more',
    M.score(M.briefProfile('3 BHK in Anna Nagar, budget 3 Cr', {}), M.propertyProfile({ id: 'r', type: 'Apartment', location: 'Anna Nagar', config: '3 BHK', startingPrice: '3.5 Cr' }), { now: D.NOW }).pct >= 85);
}

section('Several requirements on one client');
{
  const b19 = D.LEADS.find(l => l.id === 'B19');
  const profs = M.requirementProfiles(b19, {});
  check('both live requirements are read', profs.length === 2);
  check('the second is scored on its own words — no borrowed budget', !profs[1].budget && profs[1].deal.values.includes('jv'));
  const back = ids(PS.findClients(U.find(e => e.src.ids.propertyId === 'P20'), D.LEADS, { inventory: D.PROPERTIES, unified: U, stages: D.STAGES, now: D.NOW }));
  check('the JV land finds the client through their SECOND requirement', back.includes('B19'), back.join());
  const it = PS.cleanItem({ deal: 'buy', types: ['apartment', 'castle'], bhk: [3, 99], budget: { max: 3e7, unit: 'total', flex: 'approximate' }, locations: ['Adyar'], extra: '<script>' });
  check('a structured requirement is cleaned before use', it.types.join() === 'apartment' && it.bhk.join() === '3' && !('extra' in it));
  check('…and written back as words the same readers parse', /3 BHK apartment in Adyar/.test(M.reqSentence(it)) && M.briefProfile(M.reqSentence(it), {}).budget.max === 3e7);
}

section('A reviewed requirement that has gone out of date');
{
  const base = { id: 'Z1', name: 'Z', propertyInterest: '3BHK Anna Nagar', budget: '3 Cr', stageId: 'new' };
  const reviewed = { ...base, reqs: { src: 'reviewed', at: D.NOW, fp: M.reqFingerprint(base), items: [{ status: 'active', deal: 'buy', types: ['apartment'], bhk: [3], locations: [{ name: 'Anna Nagar' }], budget: { max: 3e7, unit: 'total', flex: 'fixed' } }] } };
  check('fresh: the reviewed version is read first', M.requirementProfiles(reviewed, {})[0].reqStale === false && M.requirementProfiles(reviewed, {})[0].budget.max === 3e7);
  const edited = { ...reviewed, budget: '4.5 Cr' };
  const p0 = M.requirementProfiles(edited, {})[0];
  check('the CRM budget changed after review: the newer words win, and it is flagged', p0.reqStale === true && p0.budget.max === 4.5e7, p0.budget && p0.budget.max);
}

section('The search box');
{
  const q = t => PS.parseSmartQuery(t);
  check('"buyers looking for…" searches clients', q('Find all buyers looking for 3 BHK apartments in Adyar').direction === 'clients');
  check('a requirement searches properties', q('Find all 2 BHK apartments in Anna Nagar under ₹2 Cr').direction === 'properties');
  check('"unprocessed seller leads that match buyers" is the demand list', q('Find unprocessed seller leads that match active buyer requirements').direction === 'demand');
  check('"…in the Shoot stage" scopes it to the shoot', q('Find all active requirements matching properties currently in the Shoot stage').scope === 'shoot');
  check('"clients above ₹3 Cr" filters on THEIR budget', (x => x.direction === 'clients' && x.budgetFilter.cmp === 'gte' && x.budgetFilter.value === 3e7)(q('Show clients looking for properties above ₹3 Cr in Chennai')));
  check('"sellers with commercial in T Nagar" searches the stock not yet onboarded', q('Find sellers with commercial properties in T. Nagar').scope === 'unonboarded');
  const ex = PS.explainReq(M.briefProfile('3bhk anna nagr, not mogappair, 3 cr', {}));
  check('what was understood is said back, with the corrected spelling', ex.chips.some(c => c.field === 'locations' && /anna nagr/.test(c.note)) && ex.chips.some(c => c.field === 'exclude'));
  check('what is missing is said', PS.explainReq(M.briefProfile('flat in Adyar', {})).missing.includes('budget'));
}

section('The API — who sees what');
{
  process.env.AGENT_REF_SECRET = 'test-secret';
  const api = await import('../api/_match.js');
  api.__setSource(() => ({ properties: D.PROPERTIES, listings: D.LISTINGS, leads: D.LEADS.map(l => (l.id === 'B01' ? { ...l, assignedAgent: 'agent@x.in' } : l)), submissions: D.SUBMISSIONS, trackStages: D.TRACK_STAGES, stages: D.STAGES }));
  const data = await api.loadAll(null, 't1');
  const user = { tenantId: 't1' };
  const staff = { me: 'boss@x.in', agent: false, team: [] };
  const agent = { me: 'agent@x.in', agent: true, team: [], grants: [], agentSet: new Set(['agent@x.in']), cfg: { matchingLeadFields: ['requirement'], otherPropertyFields: ['name', 'location', 'config'], tabs: ['properties'] } };
  const body = { mode: 'clients', details: { type: 'Apartment', bhk: 3, location: 'Anna Nagar', price: 30000000, deal: 'sale' } };
  const s = await api.runSearch({ db: null, user, body, viewer: staff, data });
  check('staff see every matching client in full', s.rows.length >= 4 && s.rows.every(r => r.access === 'full' && r.leadId));
  const a = await api.runSearch({ db: null, user, body, viewer: agent, data });
  const mine = a.rows.find(r => r.leadId === 'B01');
  check('an agent sees their own client in full', mine && mine.access === 'full' && mine.phone);
  const others = a.rows.filter(r => r.access === 'restricted');
  check('…and everyone else\'s as a restricted card', others.length >= 3);
  check('a restricted card carries no id, phone or name — only a reference to request it with', others.every(r => !r.leadId && !r.phone && r.ref && !JSON.stringify(r).includes('98400')));
  const p = await api.runSearch({ db: null, user, body: { mode: 'properties', text: '3 BHK in Anna Nagar 3 Cr' }, viewer: agent, data });
  check('another agent\'s seller card shows as an opportunity, never the seller', p.rows.filter(r => r.source === 'listing').every(r => r.access === 'restricted' && !/Ravi/.test(JSON.stringify(r))));
  const sm = await api.runSearch({ db: null, user, body: { mode: 'smart', text: 'unprocessed seller leads that match active buyer requirements' }, viewer: staff, data });
  check('the smart box answers the demand question', sm.mode === 'demand' && sm.rows.length >= 1);
  api.__setAi(async () => ({ direction: 'properties', questions: [], items: [{ status: 'active', deal: 'buy', types: ['apartment'], sub: null, bhk: [3], locations: [{ name: 'Anna Nagar', pref: 'primary' }], exclude: ['Mogappair'], anywhere: false, radiusKm: null, budget: { min: null, max: 30000000, unit: 'total', flex: 'approximate' }, area: null, condition: [], possession: null, mustHave: ['covered parking'], facing: null, furnishing: null, uncertain: [], missing: [], label: '3 BHK Anna Nagar' }] }));
  const st = await api.structureText('3bhk anna nagar 3cr not mogappair covered parking');
  check('the AI reader returns cleaned items', st.ok && st.items[0].exclude[0] === 'Mogappair' && st.items[0].budget.max === 3e7);
  api.__setAi(async () => { throw new Error('down'); });
  const down = await api.structureText('something else entirely, 2bhk velachery');
  check('the AI being down is reported, not hidden', down.ok === false && /down/.test(down.error));
}

console.log('\n' + '─'.repeat(64));
console.log(`${passed} passed, ${failed} failed`);
if (failed) { fails.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
console.log('All good.');
