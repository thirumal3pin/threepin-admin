// What a seller's property is, read from their own words (crm-assets/propertyFacts.js).
// Every case is a real seller message from the CRM, trimmed.
//
//   node tests/property-facts.test.mjs

import { extractPropertyFacts, sortSize } from '../crm-assets/propertyFacts.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`  FAIL ${label} — got ${g}, expected ${w}`); }
};
const read = t => { const f = extractPropertyFacts(t); return { deal: f.deal, type: f.type, config: f.config, sizes: f.sizes.map(s => s.label), price: f.price }; };

eq('A house: land and construction told apart', read('Individual house 4800 sqft land. Over 3000 sqft construction. Adambakkam'),
  { deal: null, type: 'house', config: null, sizes: ['4,800 sqft land', '3,000 sqft'], price: null });
eq('A rental flat with a monthly figure', read('Apartment (Gated Community) Anna Nagar- METROZONE 1555sqft 62000₹ Immediately FLAT FOR RENT 2 BHK'),
  { deal: 'rent', type: 'apartment', config: '2 BHK', sizes: ['1,555 sqft'], price: '₹62,000/month' });
eq('Land in cents, priced in lakhs', read('We have a land in Keeranatham and is it possible for u to sell it? 6.5 cents and 16L'),
  { deal: 'sale', type: 'land', config: null, sizes: ['6.5 cents'], price: '₹16 L' });
eq('A label before the number ("Land - 1375 sqft")', read('Land - 1375 sqft Built up area- 3000 sqft 5 bhk Expecting: 3.6 crores'),
  { deal: 'sale', type: 'house', config: '5 BHK', sizes: ['1,375 sqft land', '3,000 sqft'], price: '₹3.6 Cr' });
eq('Commercial space for rent', read('I have a 3BHK in G floor which I am planning to Rent out for Commercial space of 1650Sq ft - Mogappair West. Expecting 60,000/month'),
  { deal: 'rent', type: 'commercial', config: '3 BHK', sizes: ['1,650 sqft'], price: '₹60,000/month' });
eq('A price range stays a range', read('looking to sell my pre school property. Size- Approx 3000 sq.ft Price- 55-60L'),
  { deal: 'sale', type: 'commercial', config: 'Commercial', sizes: ['3,000 sqft'], price: '₹55–60 L' });
eq('Super built-up, carpet and UDS each get their own label', read('Super Built up Area- 1836 sq ft Carpet Area- 1250 sq ft Uds- 300 sq ft Type- 4BHK'),
  { deal: null, type: 'apartment', config: '4 BHK', sizes: ['1,836 sqft', '1,250 sqft carpet', '300 sqft UDS'], price: null });
eq('A villa with its land is a villa, not a plot', read('Rent in my villa ECR muttukadu || Land area 4500sqft || Building area 3500 sqft'),
  { deal: 'rent', type: 'villa', config: null, sizes: ['4,500 sqft land', '3,500 sqft'], price: null });
eq('Nothing to read gives nothing', read('Hi'), { deal: null, type: null, config: null, sizes: [], price: null });
eq('Sorting by size uses the built-up area first', sortSize(extractPropertyFacts('2858sqft land 7000sqft built up house')), 7000);
eq('Prices sort by value: crores above lakhs', extractPropertyFacts('3.6 crores').priceValue > extractPropertyFacts('95 lakhs').priceValue, true);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
