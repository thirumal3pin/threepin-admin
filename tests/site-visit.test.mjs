// The site visit confirmation (shared-assets/site-visit.js): what each kind of property says, the
// words for the day and time, the greeting, who meets the client — over the real inventory snapshot
// and the three messages the team wrote by hand.
//   node tests/site-visit.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteVisitFacts, siteVisitMessage, whenWords, dealOf, kindOf, waNumber, prettyPhone } from '../shared-assets/site-visit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const props = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'properties-snapshot.json'), 'utf8'));
const byCode = c => props.find(p => p.propertyCode === c || p.id === c);
let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${label}${extra ? ' — ' + extra : ''}`); } };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
const fact = (p, label) => (siteVisitFacts(p).find(f => f.label === label) || {}).value;
const labels = p => siteVisitFacts(p).map(f => f.label);

const NOW = new Date(2026, 9, 22, 10, 0).getTime();   // Thu 22 Oct 2026, 10 AM
const at = (d, h, m = 0) => new Date(2026, 9, 22 + d, h, m).getTime();

// ── The day and time, as the messages say them ──
eq('today, with the date', whenWords(at(0, 14), NOW), 'today, 22nd October, at 2:00 PM');
eq('tomorrow, with the date', whenWords(at(1, 11), NOW), 'tomorrow, 23rd October, at 11:00 AM');
eq('today next year: the year too', whenWords(new Date(2027, 0, 1, 10).getTime(), new Date(2027, 0, 1, 8).getTime()), 'today, 1st January, at 10:00 AM');
eq('later this week: the weekday and date', whenWords(at(2, 12, 15), NOW), 'Saturday, 24th October, at 12:15 PM');
eq('next year: the year too', whenWords(new Date(2027, 0, 3, 9, 30).getTime(), NOW), 'Sunday, 3rd January 2027, at 9:30 AM');
eq('noon and midnight', [whenWords(at(0, 12), NOW), whenWords(at(3, 0), NOW)], ['today, 22nd October, at 12:00 PM', 'Sunday, 25th October, at 12:00 AM']);
eq('11th, 12th, 13th, 21st, 22nd, 23rd', [11, 12, 13, 21, 22, 23].map(d => whenWords(new Date(2026, 10, d, 10).getTime(), NOW).split(',')[1].trim().split(' ')[0]), ['11th', '12th', '13th', '21st', '22nd', '23rd']);
eq('no time: nothing said', whenWords(0, NOW), '');

// ── Rent or sale, commercial / residential / land — every property in the snapshot ──
eq('POR0001: rent (the price is per month)', dealOf(byCode('POR0001')), 'rent');
eq('POR0002: rent though its saleType says "New"', dealOf(byCode('POR0002')), 'rent');
eq('A townhouse "(RENT)" priced /Month: rent', dealOf(byCode('44')), 'rent');
eq('A sale in crores: sale', dealOf(byCode('NGMA002')), 'sale');
eq('ASNC001: commercial (its type)', kindOf(byCode('ASNC001')), 'commercial');
eq('ANRL003: commercial though typed Land ("Commercial Land")', kindOf(byCode('ANRL003')), 'commercial');
eq('ANRL002 "Officers Colony": land, not an office', kindOf(byCode('ANRL002')), 'land');
eq('Plots and Land: land', ['11', 'ELENO001', 'VGN0002'].map(c => kindOf(byCode(c))), ['land', 'land', 'land']);
eq('Land + Building: residential (it has homes on it)', kindOf(byCode('KLP0002')), 'residential');
eq('Villa / Independent House / Apartment: residential', ['ADRA0001', 'MYLA002', 'CHET001'].map(c => kindOf(byCode(c))), ['residential', 'residential', 'residential']);
eq('Explicit dealType wins', [dealOf({ dealType: 'Rent', startingPrice: '₹2 Cr' }), dealOf({ listingFor: 'Sale', name: 'for rent' })], ['rent', 'sale']);

let worst = 0;
for (const p of props) {
  const id = p.propertyCode || p.id;
  const f = siteVisitFacts(p);
  ok(`${id}: says what it is`, f[0] && /^(Property|Project)$/.test(f[0].label) && f[0].value);
  ok(`${id}: has a location`, f.some(x => x.label === 'Location'));
  for (const x of f) {
    ok(`${id}: ${x.label} is not a placeholder`, !/^(-+|—|n\/?a|undefined|null)$/i.test(x.value) && !/undefined|null|NaN|\[object/.test(x.value), x.value);
    ok(`${id}: ${x.label} has no stray "----"`, !/-{3,}/.test(x.value), x.value);
  }
  ok(`${id}: no "Price on Request" / "DM us" written as a price`, !/on request|dm us|contact for/i.test(fact(p, 'Price') || ''), fact(p, 'Price'));
  ok(`${id}: a property code is never the price`, !/^[A-Z]{2,}\d{3,}$/.test(fact(p, 'Price') || ''));
  ok(`${id}: rent shows a rent, sale a price — never both`, !(fact(p, 'Price') && (fact(p, 'Monthly Rent') || fact(p, 'Rent'))));
  ok(`${id}: no "Near" twice`, !/\(near near|\(near next|\(near opp|\(near behind/i.test(fact(p, 'Location')), fact(p, 'Location'));
  const msg = siteVisitMessage(p, { name: 'Test', title: 'Mr.', at: at(1, 11), now: NOW });
  ok(`${id}: message ends with the team sign-off`, msg.endsWith('*Team 3 PIN Realty*'));
  ok(`${id}: message has no empty bullet`, !/•\s*\*[^*]+:\*\s*$/m.test(msg));
  ok(`${id}: no three blank lines in a row`, !/\n\n\n/.test(msg));
  worst = Math.max(worst, msg.length);
}
ok('Every message fits easily in one WhatsApp message', worst < 2000, String(worst));

// ── What each kind of property says ──
const por2 = byCode('POR0002'), adya = byCode('ADYA002');
eq('Rental flat: the rent with its maintenance', fact(por2, 'Monthly Rent'), '₹1,30,000/month + ₹14,000/month Maintenance');
eq('Rental flat: floor and car parks in the area line', fact(por2, 'Area'), '2,514 Sq.Ft. | 5th Floor | 2 Covered Car Parks');
eq('Rental flat: furnishing', fact(por2, 'Furnishing'), 'Semi-Furnished');
eq('Rental flat: the portal "for Rent –" taken out of the title', fact(por2, 'Property'), 'Brand New 4BHK Apartment – Appaswamy Broadstone, DLF Ramapuram');
eq('Two rent options: both, without one option\'s maintenance', fact(byCode('POR0001'), 'Monthly Rent'), '4BHK - ₹1,00,000/month | 3BHK - ₹1,60,000/month');
const ng2 = byCode('NGMA002');
eq('Flat for sale: price, built-up, UDS', [fact(ng2, 'Price'), fact(ng2, 'Area'), fact(ng2, 'UDS')], ['₹3.35 Crore (All Inclusive)', '1540 Sq.Ft. | 2 Covered Car Parks', '675 Sq.Ft.']);
eq('Flat for sale: no furnishing line', fact(ng2, 'Furnishing'), undefined);
eq('Commercial: building and land, no configuration', labels(byCode('ASNC001')), ['Property', 'Location', 'Building', 'Land Area', 'Price']);
eq('Commercial land: land area only', labels(byCode('ANRL003')), ['Property', 'Location', 'Land Area', 'Price']);
eq('Land: extent and approval', [fact(byCode('ELSA0001'), 'Land Area'), fact(byCode('ELSA0001'), 'Approval')], ['549 to 1983 Sq.Ft.', 'DTCP Approved, RERA Registered, Clear Title']);
eq('A landmark the location already names is not repeated', fact(byCode('20'), 'Location'), 'Guduvanchery, Chennai');
eq('"Opposite …" landmark: no "Near" in front', fact(byCode('46'), 'Location'), 'Abhiramapuram, Alwarpet, Chennai (Opposite Citibank)');
eq('A long list of landmarks is left out', fact(byCode('CHET001'), 'Location'), 'McNichols Road, Chetpet, Chennai');
eq('"Price on Request" left out', fact(byCode('38'), 'Price'), undefined);
eq('"DM us to know price" left out', fact(byCode('KILV001'), 'Price'), undefined);
eq('A code typed into the price column left out', fact(byCode('ADRM0002'), 'Price'), undefined);
eq('Car parks "2 Covered + 1 Open" with the count 3: written once', fact(byCode('44'), 'Area'), '4946 Sq.Ft. | 2 Covered + 1 Open Car Parks');
eq('No area: parking on its own line', fact(byCode('AMPIN001'), 'Parking'), 'Dedicated Stilt Car Parking');
eq('Availability only when it says how many', [fact({ name: 'X', location: 'Y', availability: '3 Units' }, 'Availability'), fact({ name: 'X', location: 'Y', availability: 'Available' }, 'Availability')], ['3 Units', undefined]);
eq('A bare record: name and location only', siteVisitFacts({ name: 'Plot', location: 'Adyar', type: 'Plot' }), [{ label: 'Property', value: 'Plot' }, { label: 'Location', value: 'Adyar' }]);
eq('No property at all: no details', siteVisitFacts(null), []);
eq('A builder\'s new project: "Project"', siteVisitFacts({ name: 'Sobha Arbor', builder: 'Sobha', saleType: 'New', startingPrice: '₹1.4 Cr', location: 'Poonamallee' })[0].label, 'Project');

// ── The greeting ──
const greet = o => siteVisitMessage(null, { ...o, now: NOW }).split('\n')[2];
eq('Mr. before the name', greet({ name: 'Nitin', title: 'Mr.' }), 'Dear Mr. Nitin,');
eq("Ma'am after the name", greet({ name: 'Aiswarya', title: "Ma'am" }), "Dear Aiswarya Ma'am,");
eq('Sir after the name', greet({ name: 'Ravi', title: 'Sir' }), 'Dear Ravi Sir,');
eq('Name only', greet({ name: 'Ram Rajappa', title: '' }), 'Dear Ram Rajappa,');
eq('No name', greet({}), "Dear Sir/Ma'am,");

// ── Who meets the client ──
const tail = o => siteVisitMessage(byCode('NGMA002'), { name: 'X', at: at(0, 14), now: NOW, ...o });
ok('A team member with a number: who and the number', tail({ host: { kind: 'team', name: 'Thirumal', phone: '99418 80088' } }).includes('Thirumal from 3 PIN Realty will meet you at the location and assist you with the site visit.\n\n📞 *Contact:* 99418 80088'));
ok('A team member without a number: no contact line', !tail({ host: { kind: 'team', name: 'Pradeep' } }).includes('Contact'));
ok('The caretaker', tail({ host: { kind: 'caretaker' } }).includes('The caretaker will assist you during the site visit.'));
ok('Nobody named: no line about it', !/will meet you|will assist you during/.test(tail({ host: { kind: '' } })));
ok('A name-less "team" host says nothing', !/from 3 PIN Realty will/.test(tail({ host: { kind: 'team', name: ' ' } })));

// ── The map pin ──
ok('The property\'s Maps link', siteVisitMessage(adya, { now: NOW }).includes('📌 *Google Maps Location:*\n' + adya.mapLink));
ok('No map pin on the property: no map lines', !tail({}).includes('Google Maps'));
ok('A pasted link replaces it', tail({ map: 'https://maps.app.goo.gl/NEW' }).includes('https://maps.app.goo.gl/NEW'));
ok('A place name is not a link: no map lines', !siteVisitMessage({ name: 'X', location: 'Y', mapLink: 'Near the temple' }, { now: NOW }).includes('Google Maps'));
ok('A typed location replaces the record\'s', tail({ location: 'Kamdar Nagar, Chennai – 600034' }).includes('• *Location:* Kamdar Nagar, Chennai – 600034'));

// ── The whole message, against the ones the team wrote by hand ──
const kodambakkam = { name: 'Commercial Building, Kodambakkam', type: 'Commercial', saleType: 'New', location: 'Kodambakkam, Chennai',
  builtupArea: '11,000', totalFloors: 'Stilt + 5 Floors', parking: '10', parkingType: 'Covered', amenities: 'Commercial Lift, Power Backup & Security',
  startingPrice: '₹110/Sq.Ft. per month', mapLink: 'https://maps.app.goo.gl/kHS4kG6TsUUiDhYf8' };
eq('Commercial rental, as the team writes it', siteVisitMessage(kodambakkam, { name: 'Nitin', title: 'Mr.', at: at(0, 14), now: NOW, host: { kind: 'team', name: 'Thirumal', phone: '99418 80088' } }), [
  '🏢 *SITE VISIT CONFIRMATION | 3 PIN REALTY*', '',
  'Dear Mr. Nitin,', '',
  'Your site visit has been confirmed for *today, 22nd October, at 2:00 PM.*', '',
  '📍 *Property Details*', '',
  '• *Property:* Commercial Building, Kodambakkam',
  '• *Location:* Kodambakkam, Chennai',
  '• *Building:* 11,000 Sq.Ft. | Stilt + 5 Floors | Brand New',
  '• *Facilities:* 10 Covered Car Parks, Commercial Lift, Power Backup & Security',
  '• *Rent:* ₹110/Sq.Ft. per month', '',
  '📌 *Google Maps Location:*', 'https://maps.app.goo.gl/kHS4kG6TsUUiDhYf8', '',
  'Thirumal from 3 PIN Realty will meet you at the location and assist you with the site visit.', '',
  '📞 *Contact:* 99418 80088', '',
  'Please let us know if you need any assistance before the visit or if there are any changes to your schedule.', '',
  'Thank you!', '', '*Team 3 PIN Realty*'
].join('\n'));
const amara = { name: 'Luxury 4 BHK Duplex Apartment for Rent – Amara Akasha, OMR, Perungudi', type: 'Apartment', location: 'OMR, Perungudi, Chennai',
  config: '4 BHK Duplex', sqftRange: '4,358', floorNo: '12th & 13th Floors', parking: '3', startingPrice: '₹1.75 Lakhs/month', mapLink: 'https://maps.app.goo.gl/1x4kJHCcbK6vYBSf6' };
const am = siteVisitMessage(amara, { name: 'Aiswarya', title: "Ma'am", at: at(0, 13), now: NOW, host: { kind: 'caretaker' } });
ok('Residential rental: home emoji, rent, area | floors | car parks, caretaker', am.startsWith('🏡') && am.includes('• *Area:* 4,358 Sq.Ft. | 12th & 13th Floors | 3 Car Parks') && am.includes('• *Monthly Rent:* ₹1.75 Lakhs/month') && am.includes('The caretaker will assist you during the site visit.'), am);
const rr = siteVisitMessage(byCode('NGMA002'), { name: 'Ram Rajappa', title: 'Mr.', at: at(1, 11), now: NOW, host: { kind: 'team', name: 'Thirumal', phone: '99418 80088' } });
ok('Flat for sale: tomorrow, price, area, UDS, map', rr.includes('*tomorrow, 23rd October, at 11:00 AM.*') && rr.includes('• *Price:* ₹3.35 Crore (All Inclusive)') && rr.includes('• *UDS:* 675 Sq.Ft.'), rr);

// ── Phone numbers ──
eq('wa.me: a ten-digit mobile gets 91', waNumber('98400 12345'), '919840012345');
eq('wa.me: +91 kept, 0 dropped', [waNumber('+91 98400-12345'), waNumber('098400 12345')], ['919840012345', '919840012345']);
eq('wa.me: too short is nothing (WhatsApp asks whom)', waNumber('12345'), '');
eq('Shown as 5 + 5', [prettyPhone('919941880088'), prettyPhone('9941880088')], ['99418 80088', '99418 80088']);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
