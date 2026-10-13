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

console.log(failed ? `\n${failed} failed, ${passed} passed.` : `\nAll good (${passed} checks).`);
process.exit(failed ? 1 : 0);
