// The seller queue as search suggestions (dashboard-assets/queue-search.js): which board cards are
// offered as "upcoming, not in the Property Dashboard", and which never are.
//   node tests/queue-search.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of ['dashboard-assets/search-engine.js', 'shared-assets/chennai-geo.js', 'shared-assets/area-model.js', 'shared-assets/match-engine.js', 'dashboard-assets/queue-search.js']) new Function(fs.readFileSync(path.join(here, '..', f), 'utf8'))();
const Q = globalThis.PinQueue, S = globalThis.PinSearch;
const PROPS = [{ id: 'p1', propertyCode: 'TNAG0002', name: '2BHK Apartment in T. Nagar', location: 'T. Nagar, Chennai' },
               { id: 'p2', propertyCode: 'ADYA001', name: 'Aindro Coral Bay', location: 'Adyar' }];
const card = (o) => Object.assign({ id: 'c' + Math.random().toString(36).slice(2, 7), title: '', location: '', config: '', askingPrice: '', propertyCode: '', stageName: 'New listing', stageKind: 'open' }, o);
const CARDS = [
  card({ id: 'waiting', title: '3BHK Apartment, T Nagar', location: 'T Nagar', config: '3 BHK', askingPrice: '₹2.8 Cr', stageName: 'Shoot scheduled' }),
  card({ id: 'mapped', title: 'Same as TNAG0002', location: 'T Nagar', propertyCode: 'tnag0002', stageName: 'Live' }),
  card({ id: 'oldid', title: 'Maps to an older record', location: 'Adyar', propertyCode: 'p2' }),
  card({ id: 'dropped', title: 'Dropped flat, T Nagar', location: 'T Nagar', stageKind: 'lost', stageName: 'Dropped' }),
  card({ id: 'hold', title: 'On hold flat, T Nagar', location: 'T Nagar', stageKind: 'hold' }),
  card({ id: 'sold', title: 'Sold flat, T Nagar', location: 'T Nagar', stageKind: 'won' }),
  card({ id: 'unknown', title: 'Unknown stage, T Nagar', location: 'T Nagar', stageKind: null }),
  card({ id: 'blank' }),
  card({ id: 'numeric', title: 'Numeric code only', location: 'Kodambakkam', propertyCode: '12' }),
  card({ id: 'series', kind: 'series', title: 'T Nagar series', location: 'T Nagar', stageName: 'Shoot done' }),
  card({ id: 'brochure', title: 'Brochure asked under a dashboard code', location: 'T Nagar', brochureCode: 'ADYA001' }),
  card({ id: 'dashed', title: 'Code typed with a dash', location: 'T Nagar', propertyCode: 'TNAG-0002' }),
  card({ id: 'twin1', title: 'Villa, Kodambakkam', location: 'Kodambakkam', config: '4 BHK' }),
  card({ id: 'twin2', title: 'Villa,  Kodambakkam', location: 'kodambakkam', config: '4 BHK' }),
  card({ id: 'plot', title: 'Residential plot, T Nagar', location: 'T Nagar' })
];
let failed = 0;
const ok = (label, cond, detail) => { if (cond) console.log('  ok   ' + label); else { failed++; console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); } };

const c = Q.candidates(CARDS, PROPS);
ok('a waiting, unmapped card is a candidate', c.some(p => p.listingId === 'waiting'));
ok('a card whose code is in the dashboard is not (case-insensitive)', !c.some(p => p.listingId === 'mapped'));
ok('a card mapped to an older record id that exists is not', !c.some(p => p.listingId === 'oldid'));
ok('dropped, on hold and sold cards are not', !c.some(p => ['dropped', 'hold', 'sold'].includes(p.listingId)));
ok('a card on an unrecognised stage is kept', c.some(p => p.listingId === 'unknown'));
ok('an empty card is not', !c.some(p => p.listingId === 'blank'));
ok('a bare-number code that matches nothing does not hide it', c.some(p => p.listingId === 'numeric'));
ok('every candidate is marked as a queue entry', c.every(p => p.queue === true && /^queue:/.test(p.id)));

const gaz = S.buildGazetteer(PROPS);
const hit = q => Q.search(CARDS, PROPS, { text: q, gazetteer: gaz });
ok('"t nagar" suggests the waiting card', hit('t nagar').some(h => h.p.listingId === 'waiting'));
ok('"tnagar" does too', hit('tnagar').some(h => h.p.listingId === 'waiting'));
ok('and never the dropped or mapped ones', !hit('t nagar').some(h => ['dropped', 'mapped', 'hold', 'sold'].includes(h.p.listingId)));
ok('"3bhk t nagar" finds it by configuration', hit('3bhk t nagar').some(h => h.p.listingId === 'waiting'));
ok('"4bhk t nagar" does not', !hit('4bhk t nagar').some(h => h.p.listingId === 'waiting'));
ok('a search that matches nothing suggests nothing', hit('zzzqqxwv').length === 0);
ok('an empty search suggests nothing', Q.search(CARDS, PROPS, { text: '' }).length === 0);
ok('limit is honoured', Q.search(CARDS, PROPS, { text: 'nagar', gazetteer: gaz, limit: 1 }).length <= 1);
ok('no cards, no properties, no crash', Q.search([], [], { text: 'x' }).length === 0 && Q.search(null, null, { text: 'x' }).length === 0);
ok('a series card (one edit of several properties) is never a suggestion', !c.some(p => p.listingId === 'series'));
ok('a card whose brochure code is in the dashboard is not', !c.some(p => p.listingId === 'brochure'));
ok('codes compare as the board compares them ("TNAG-0002" is TNAG0002)', !c.some(p => p.listingId === 'dashed'));
ok('two cards for one property are one suggestion', c.filter(p => /^twin/.test(p.listingId)).length === 1);
ok('the type is read from the card', Q.typeOf({ title: 'Residential plot' }) === 'Plots' && Q.typeOf({ title: '3BHK flat' }) === 'Apartments' && Q.typeOf({ title: 'Villa' }) === 'Villa' && Q.typeOf({ title: 'Something' }) === '');
{
  const plots = Q.search(CARDS, PROPS, { text: 't nagar', gazetteer: gaz, type: 'Plots' }).map(h => h.p.listingId);
  ok('the Type bar keeps the plot card', plots.includes('plot'));
  ok('…and drops the apartment card', !plots.includes('waiting'));
  ok('…but keeps a card that does not say what it is', plots.includes('unknown'));
}
{
  const near = Q.search(CARDS, PROPS, { text: 'nungambakkam', gazetteer: gaz });
  const k = near.find(h => /^twin/.test(h.p.listingId));
  ok('a card in a nearby area is offered, with how far', !!k && k.km > 0 && k.km <= 5 && /Nungambakkam/.test(k.from), JSON.stringify(k && { km: k.km, from: k.from }));
}
console.log(failed ? `\n${failed} failed.` : '\nAll good.');
process.exit(failed ? 1 : 0);
