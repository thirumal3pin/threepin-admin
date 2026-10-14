// The dashboard's property saves, over the in-memory Firestore (tests/fake-firestore.mjs) with the real
// dashboard-assets/firebase-sync.js: the page draws at once from this device's saved copy, but a save —
// which writes the whole property — waits until the server's list is in, so an hours-old copy can
// never be put back over a Sync from Sheet or a colleague's edit. A partial save (a map pin: only its
// own fields) is never held back.
//   node tests/dashboard-save.test.mjs
import { register } from 'node:module';
import { makeStore } from './fake-firestore.mjs';

register('./_gstatic-loader.mjs', import.meta.url);

let failed = 0, passed = 0;
const check = (label, cond, detail) => { if (cond) passed++; else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + detail : '')); } };
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));
const T = 't_test';
console.log('3 PIN Realty — Property dashboard saves\n');

globalThis.window = globalThis;
let props = [], draws = 0;
window.applyPropertiesSnapshot = list => { props = list; draws++; };
window.showToast = () => {};
globalThis.location = { reload() {}, pathname: '/dashboard.html', search: '', hash: '' };
globalThis.confirm = () => true;
globalThis.alert = () => {};

const store = makeStore();
globalThis.__fakeStore = store;
store.set('properties/ANR003', { id: 'ANR003', tenantId: T, name: 'Anna Nagar 3BHK', startingPrice: '3.15 Cr' });
store.fromCache = true;   // the page opens on this device's saved copy

globalThis.__fakeUser = { email: 'agent@example.com', tenantId: T };
await import('../dashboard-assets/firebase-sync.js');
for (let i = 0; i < 50 && !props.length; i++) await tick(40);
await tick(150);
const F = window.dashboardFirebase;
check('The page draws at once from the saved copy', props.length === 1, JSON.stringify(props));

// Meanwhile a Sync from Sheet has changed the price on the server; this copy still says 3.15 Cr.
let refused = null;
try { await F.saveProperty({ ...props[0], soldOut: true }); } catch (e) { refused = e; }
check('A whole-property save from the saved copy is refused', refused && refused.code === 'not-live', String(refused));
check('…and nothing was written', store.get('properties/ANR003').soldOut === undefined);

let pinOk = true;
try { await F.saveProperty({ id: 'ANR003', geo: { lat: 13.08, lng: 80.21 } }, { partial: true }); } catch (e) { pinOk = false; }
check('A partial save (a map pin) is not held back', pinOk && store.get('properties/ANR003').geo && store.get('properties/ANR003').geo.lat === 13.08);

// The server's list arrives.
store.fromCache = false;
store.notify && store.notify();
await tick(200);
let ok2 = true;
try { await F.saveProperty({ ...props[0], soldOut: true }); } catch (e) { ok2 = false; }
check('Once the server’s list is in, saves go through', ok2 && store.get('properties/ANR003').soldOut === true, JSON.stringify(store.get('properties/ANR003')));
const before = draws;
store.notify && store.notify();
await tick(150);
check('A snapshot with nothing new does not redraw the grid', draws === before, `${before} → ${draws}`);

// ── The seller board, for search suggestions: cards with where each stands, and the sellers who have
// called in and have no card yet (the board's own Sellers list).
store.set('trackPipelines/' + T, { tenantId: T, stages: [
  { id: 'c1', key: 'shoot_scheduled', name: 'Shoot scheduled' }, { id: 'c2', name: 'Rented out (custom)', kind: 'won' },
  { id: 'c3', key: 'dropped', name: 'Dropped' }] });
store.set('listings/L1', { id: 'L1', tenantId: T, title: '3BHK, T Nagar', location: 'T Nagar', stageId: 'c1', leadId: 'S1', brochure: { code: 'TNAG0099' } });
store.set('listings/L2', { id: 'L2', tenantId: T, title: 'Rented flat', stageId: 'c2' });
store.set('listings/L3', { id: 'L3', tenantId: 'someone_else', title: 'Another agency' });
store.set('leads/S1', { tenantId: T, name: 'Has a card', enquiryType: 'Seller Listing', propertyInterest: '3BHK T Nagar' });
store.set('leads/S2', { tenantId: T, name: 'New owner', enquiryType: 'Seller Listing', propertyInterest: '2BHK Kodambakkam', budget: '1.2 Cr', ai: { intent: 'rent_out', confidence: 'high' } });
store.set('leads/S3', { tenantId: T, name: 'Set aside', enquiryType: 'Seller Listing', propertyInterest: 'Plot Adyar', listingSkipped: true });
store.set('leads/B1', { tenantId: T, name: 'A buyer', enquiryType: 'Property Enquiry', propertyInterest: '3BHK Adyar' });
const q = await F.sellerQueue();
const byId = Object.fromEntries(q.map(x => [x.id, x]));
check('The board’s cards come back, this tenant’s only', byId.L1 && byId.L2 && !byId.L3, JSON.stringify(Object.keys(byId)));
check('…each with its column resolved', byId.L1 && byId.L1.stageKind === 'open' && byId.L1.stageName === 'Shoot scheduled', JSON.stringify(byId.L1));
check('…a hand-named column keeps the kind it was saved with', byId.L2 && byId.L2.stageKind === 'won', JSON.stringify(byId.L2));
check('…and the brochure code travels with the card', byId.L1 && byId.L1.brochureCode === 'TNAG0099');
check('A seller with no card comes back as a new seller', byId.lead_S2 && byId.lead_S2.kind === 'seller' && byId.lead_S2.intent === 'rent_out' && byId.lead_S2.askingPrice === '1.2 Cr', JSON.stringify(byId.lead_S2));
check('…but not one who has a card, one set aside, or a buyer', !byId.lead_S1 && !byId.lead_S3 && !byId.lead_B1, JSON.stringify(Object.keys(byId)));

console.log(failed ? `\n${failed} failed, ${passed} passed.` : `\nAll good (${passed} checks).`);
process.exit(failed ? 1 : 0);
