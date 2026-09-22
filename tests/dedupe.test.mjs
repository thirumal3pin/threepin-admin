// ═══════ THE SAME PROPERTY, ENTERED TWICE ═══════
//
//   node tests/dedupe.test.mjs
//
// Nothing is hidden automatically: the detector only points at pairs, and the
// owner deletes the spare record if they agree. That still makes a false
// positive expensive — it invites someone to delete a real listing — so this
// file is weighted towards the pairs that must NOT be flagged: two flats in
// one building, a phase two, a similar name in another locality.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const load = f => new Function(readFileSync(join(ROOT, f), 'utf8'))();
load('dashboard-assets/search-engine.js');
load('shared-assets/dedupe.js');
const D = globalThis.PinDedupe;

let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); fails.push(label); }
};
const section = t => { console.log(''); console.log(t); };

const P = (o) => Object.assign({ id: 'x' + Math.random().toString(36).slice(2) }, o);
const isDup = (a, b) => !!D.duplicateReason(a, b);

// ═══════════════════════════════════════════════════════════════════════
section('IT MUST NOT FIRE — the expensive direction to get wrong');
// ═══════════════════════════════════════════════════════════════════════
{
  // Two flats in the same building at the same price. Real, and common.
  const a = P({ propertyCode: 'POOJ001', name: 'Pooja Diamond Foundation (11th Floor)',
    location: 'Kilpauk, Chennai', config: '3BHK', startingPrice: '4,00,00,000', sqftRange: '1800' });
  const b = P({ name: 'Pooja Diamond Foundation (12th Floor)',
    location: 'Kilpauk, Chennai', config: '3BHK', startingPrice: '4,00,00,000', sqftRange: '1800' });
  ok('two floors of one building are two properties', !isDup(a, b), JSON.stringify(D.duplicateReason(a, b)));
}
{
  const a = P({ propertyCode: 'MPP001', name: 'MP Developers MP PETALS Phase 1',
    location: 'Kundrathur, Chennai', config: '2BHK', startingPrice: '60,00,000' });
  const b = P({ name: 'MP Developers MP PETALS Phase 2',
    location: 'Kundrathur, Chennai', config: '2BHK', startingPrice: '61,00,000' });
  ok('phase 1 and phase 2 are two projects', !isDup(a, b));
}
{
  const a = P({ propertyCode: 'ANR003', name: '3BHK Apartment - Anna Nagar, I Block',
    location: 'I Block, Anna Nagar', config: '3BHK', startingPrice: '3,00,00,000' });
  const b = P({ name: 'SriVaradha - Mahalingapuram',
    location: 'Mahalingapuram, Nungambakkam', config: '3BHK', startingPrice: '3,00,00,000' });
  ok('same price and config in DIFFERENT localities is not a duplicate', !isDup(a, b));
}
{
  const a = P({ propertyCode: 'X1', name: 'Green Acres', location: 'Adyar', config: '3BHK', startingPrice: '3,00,00,000' });
  const b = P({ name: 'Green Acres', location: 'Velachery', config: '3BHK', startingPrice: '3,00,00,000' });
  ok('the same name in another locality is another property', !isDup(a, b));
}
{
  const a = P({ propertyCode: 'X1', name: 'Tower A', location: 'Adyar', config: '2BHK', startingPrice: '1,50,00,000', sqftRange: '900' });
  const b = P({ name: 'Tower B', location: 'Adyar', config: '4BHK', startingPrice: '1,50,00,000', sqftRange: '2200' });
  ok('same locality and price but different size and config is not a duplicate', !isDup(a, b));
}
{
  const a = P({ propertyCode: 'A1', name: 'Same Name', location: 'Adyar', config: '3BHK', startingPrice: '3,00,00,000' });
  const b = P({ propertyCode: 'A2', name: 'Same Name', location: 'Adyar', config: '3BHK', startingPrice: '3,00,00,000' });
  ok('two CODED records are the sheet’s business, not ours', !isDup(a, b));
  const c = P({ name: 'Same Name', location: 'Adyar', config: '3BHK', startingPrice: '3,00,00,000' });
  const d = P({ name: 'Same Name', location: 'Adyar', config: '3BHK', startingPrice: '3,00,00,000' });
  ok('...and two UNCODED records give nothing to prefer between', !isDup(c, d));
}
{
  const a = P({ propertyCode: 'X1', name: 'A Place', location: '', config: '3BHK', startingPrice: '3,00,00,000' });
  const b = P({ name: 'A Place', location: 'Adyar', config: '3BHK', startingPrice: '3,00,00,000' });
  ok('a record with no locality is never merged on a guess', !isDup(a, b));
}
{
  const a = P({ propertyCode: 'X1', name: 'Priced', location: 'Adyar', config: '3BHK', startingPrice: '3,00,00,000' });
  const b = P({ name: 'Different Title Entirely', location: 'Adyar', config: '3BHK' });
  ok('no price on one side means the price branch cannot fire', !isDup(a, b));
}

// ═══════════════════════════════════════════════════════════════════════
section('IT MUST FIRE — the pairs actually in the inventory');
// ═══════════════════════════════════════════════════════════════════════
{
  const a = P({ propertyCode: 'SHNA001', name: 'Premium 3BHK Apartment - Shenoy Nagar',
    location: 'Shenoy Nagar', config: '3BHK', startingPrice: '₹3.15 Crores (Negotiable)' });
  const b = P({ name: 'Premium 3BHK Apartment - Shenoy Nagar',
    location: 'Shenoy Nagar, Chennai', config: '3 BHK', startingPrice: '3.15 Cr' });
  ok('the same name, one locality written two ways', isDup(a, b), JSON.stringify(D.duplicateReason(a, b)));
}
{
  // The one the owner saw: different titles, same building.
  const a = P({ propertyCode: 'AYNM001', name: 'Independent Bungalow, Police Manickam Street',
    location: 'Ayanavaram', config: '5BHK', startingPrice: '₹6.75 Crores + Registration' });
  const b = P({ name: 'Aynavaram Bungalow', location: 'Ayanavaram, Chennai',
    config: '5BHK', startingPrice: '₹6.75 Cr' });
  ok('different titles, same locality, price and config', isDup(a, b), JSON.stringify(D.duplicateReason(a, b)));
}
{
  const a = P({ propertyCode: 'ANWE0004', name: '3BHK Apartment - Anna Nagar West Extension',
    location: 'Anna Nagar West Extension', config: '3BHK', startingPrice: '₹2.20 Crores + Registration', sqftRange: '1,280 Sq.ft' });
  const b = P({ name: '3BHK Fully furnished Apartment - Anna Nagar West Extension',
    location: 'Anna Nagar West Extension, Chennai', config: '3 BHK', startingPrice: '2,20,00,000', sqftRange: '1,280' });
  ok('a rewritten title with identical specs', isDup(a, b));
  ok('...and the reason names the evidence',
    /floor area/.test(D.duplicateReason(a, b).why), D.duplicateReason(a, b).why);
}

// ═══════════════════════════════════════════════════════════════════════
section('WHICH ONE SURVIVES');
// ═══════════════════════════════════════════════════════════════════════
{
  const coded = P({ id: 'c', propertyCode: 'KD0003', name: 'House', location: 'Kodambakkam', config: '3BHK', startingPrice: '5,00,00,000' });
  const plain = P({ id: 'u', name: 'House', location: 'Kodambakkam', config: '3BHK', startingPrice: '5,00,00,000' });
  for (const order of [[coded, plain], [plain, coded]]) {
    const r = D.dedupe(order);
    ok('the coded record is the one kept, whichever order they arrive in',
      r.list.length === 1 && r.list[0].id === 'c', JSON.stringify(r.list.map(x => x.id)));
  }
}
{
  // Three of a kind must not cascade into hiding the survivor.
  const a = P({ id: 'a', propertyCode: 'T1', name: 'Trio', location: 'Adyar', config: '3BHK', startingPrice: '3,00,00,000' });
  const b = P({ id: 'b', name: 'Trio', location: 'Adyar', config: '3BHK', startingPrice: '3,00,00,000' });
  const c = P({ id: 'c', name: 'Trio', location: 'Adyar', config: '3BHK', startingPrice: '3,00,00,000' });
  const r = D.dedupe([a, b, c]);
  ok('a third copy does not take the survivor with it',
    r.list.some(x => x.id === 'a'), JSON.stringify(r.list.map(x => x.id)));
}
{
  const r = D.dedupe([]);
  ok('an empty inventory is not an error', r.list.length === 0 && r.pairs.length === 0);
  const r2 = D.dedupe(null);
  ok('neither is a missing one', r2.list.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════
section('OVER THE REAL INVENTORY');
// ═══════════════════════════════════════════════════════════════════════
{
  const live = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/properties-snapshot.json'), 'utf8'));
  const r = D.dedupe(live);
  console.log('  ·    ' + live.length + ' rows -> ' + r.list.length + ', ' + r.pairs.length + ' hidden');
  ok('it finds the duplicates that are really there', r.pairs.length >= 8, r.pairs.length + '');
  // A rule that starts hiding a tenth of the inventory has stopped being a
  // duplicate rule.
  ok('...and nothing like a tenth of the inventory', r.pairs.length <= live.length * 0.1,
    r.pairs.length + ' of ' + live.length);
  ok('every hidden record has a coded survivor', r.pairs.every(x => x.keep.propertyCode && !x.drop.propertyCode));
  ok('every hidden record can say why', r.pairs.every(x => typeof x.why === 'string' && x.why.length > 8));
  ok('no property code is lost', (() => {
    const before = new Set(live.filter(x => x.propertyCode).map(x => x.propertyCode));
    const after = new Set(r.list.filter(x => x.propertyCode).map(x => x.propertyCode));
    return before.size === after.size;
  })());
  ok('no record is both kept and hidden', (() => {
    const hidden = new Set(r.pairs.map(x => x.drop.id));
    return r.list.every(x => !hidden.has(x.id));
  })());
}

console.log('');
console.log('─'.repeat(64));
if (fails.length) {
  console.log(fails.length + ' failing of ' + (pass + fails.length) + ':');
  fails.forEach(f => console.log('  · ' + f));
  process.exit(1);
}
console.log(pass + ' checks, all good.');
