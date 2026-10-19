// The Inventory sheet sync's preview: what changed, field by field.   node tests/inventory-diff.test.mjs
import { diffProperty, detailLost, keepNoteText, planSync, commitWrites, keepFromChoice, findLostDetail, writeRecoveredNotes, TENANT_ID } from '../api/_inventory-shared.js';

// A small in-memory Firestore: collections, documents, sub-collections, where('==') and get().
function fakeFirestore(seed){
  const store = new Map(Object.entries(seed || {}).map(([p, d]) => [p, JSON.parse(JSON.stringify(d))]));
  const snap = docs => ({ docs, empty: !docs.length, forEach: fn => docs.forEach(fn) });
  const col = path => ({
    doc: id => ({ path: path + '/' + id, get: async () => ({ exists: store.has(path + '/' + id), data: () => store.get(path + '/' + id) }),
      set: async data => { store.set(path + '/' + id, JSON.parse(JSON.stringify(data))); }, collection: s => col(path + '/' + id + '/' + s) }),
    where: (f, op, v) => ({ get: async () => snap([...store].filter(([p, d]) => p.startsWith(path + '/') && !p.slice(path.length + 1).includes('/') && d[f] === v).map(([p, d]) => ({ id: p.split('/').pop(), data: () => d }))) })
  });
  return { store, collection: col };
}

let failed = 0;
const eq = (l, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) { failed++; console.log(`  FAIL  ${l} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); } };

console.log('3 PIN Realty — inventory sync diff');

eq('A field the sheet changed: old → new', diffProperty({ name: 'A', zone: '' }, { name: 'A', zone: 'Chennai Central', updatedAt: 1, source: 'inventory-sync' }),
  [{ field: 'zone', from: '', to: 'Chennai Central' }]);

// The sheet's own columns: one line each, by the sheet's name for it — never "(map) → 2 keys".
eq('Sheet columns: each change on its own line, named as in the sheet',
  diffProperty({ sheetExtras: { 'Corpus Fund': '1,00,000', 'Old column': 'x' } }, { sheetExtras: { 'Corpus Fund': '2,50,000', Maintenance: '3.5 per sqft' } }),
  [{ field: 'Corpus Fund', from: '1,00,000', to: '2,50,000' }, { field: 'Old column', from: 'x', to: '' }, { field: 'Maintenance', from: '', to: '3.5 per sqft' }]);
eq('…first time: every column, from nothing', diffProperty({}, { sheetExtras: { A: '1', B: '2' } }),
  [{ field: 'A', from: '', to: '1' }, { field: 'B', from: '', to: '2' }]);
eq('…the same columns in another order: no change', diffProperty({ sheetExtras: { b: '2', a: '1' } }, { sheetExtras: { a: '1', b: '2' } }), []);
eq('…unchanged columns are not listed', diffProperty({ sheetExtras: { a: '1', b: '2' } }, { sheetExtras: { a: '1', b: '3' } }), [{ field: 'b', from: '2', to: '3' }]);

// ── Nothing lost when the sheet shortens a value (KDBMC001, 19 Oct) ──
const after = { parking: '9', powerBackup: 'Available', sqftRange: '11,400', nearbyLandmark: 'Near Apollo Hospital', zone: 'Chennai Central',
  location: 'Khader Nawaz Khan Road, Nungambakkam', contactName: 'Swaminathan N G',
  startingPrice: 'Furnished - ₹200/sq.ft/month | Bareshell - ₹175/sq.ft/month', sheetExtras: { Owner_Builder_Contact: 'Swaminathan N G, 9080895163' } };
eq('Parking "3 cars per floor (9 spaces in total)" → "9": the detail would be lost — kept', detailLost('parking', '3 cars per floor (9 spaces in total)', '9', after), true);
eq('Formatting only (11400 → 11,400): nothing lost', detailLost('sqftRange', '11400', '11,400', after), false);
eq('Rs. → ₹, "per sq.ft per month" → "/sq.ft/month": nothing lost', detailLost('startingPrice', 'Furnished - Rs.200 per sq.ft per month | Bareshell - Rs.175 per sq.ft per month', after.startingPrice, after), false);
eq('"Power Backup Available" → "Available": only the field\'s own name went', detailLost('powerBackup', 'Power Backup Available', 'Available', after), false);
eq('A value that moved to another field (Nearby → Nearby landmark): nothing lost', detailLost('Nearby', 'Near Apollo Hospital', '', after), false);
eq('"…, Chennai" dropped, but Chennai is in the zone: nothing lost', detailLost('location', 'Khader Nawaz Khan Road, Nungambakkam, Chennai', after.location, after), false);
eq('A name made longer: nothing lost', detailLost('contactName', 'Swaminathan', 'Swaminathan N G', after), false);
eq('Nothing there before: nothing to keep', detailLost('nearbyLandmark', '', 'Near Apollo Hospital', after), false);
// Kept even when the same words sit in another field (the highlights) — the parking field itself lost them.
eq('…kept even though the highlights mention parking too', detailLost('parking', '3 cars per floor (9 spaces in total)', '9', { ...after, highlights: 'Floor Area - 3800 Sq.ft per floor, Car Parking - 3 cars per floor (9 spaces in total)' }), true);
eq('"10 Covered Car Parks" → "10": kept', detailLost('parking', '10 Covered Car Parks', '10', {}), true);
eq('A new price is the sheet update, not lost detail', detailLost('startingPrice', '3.2 Crores (Negotiable)', '2.85 Crores ( including Registration)', {}), false);
eq('A new link: not lost detail', detailLost('photosLink', 'https://drive.google.com/drive/folders/1twqZ', 'https://drive.google.com/drive/folders/16neC', {}), false);
eq('Available → Sold: not lost detail', detailLost('availability', 'Available', 'Sold', {}), false);
eq('Highlights cut short: kept', detailLost('highlights', '2 Covered Car Parks; Private Lift; 4 years old Property; Solar powered', '2 Covered Car Parks; Private Lift', {}), true);
eq('Cleared, and found nowhere else: kept', detailLost('GST Applicable', 'Included in price', '', { sheetExtras: {} }), true);
const txt = keepNoteText([{ field: 'parking', from: '3 cars per floor (9 spaces in total)', to: '9' }, { field: 'Car Parking Notes', from: 'Visitor slots at the back', to: '' }], Date.UTC(2026, 9, 19, 6));
eq('The note: the date, each old value and what the sheet now says',
  [/19 Oct 2026/.test(txt), /• Parking: 3 cars per floor \(9 spaces in total\) — the sheet now says “9”/.test(txt), /• Car Parking Notes: Visitor slots at the back — the sheet has it blank now/.test(txt)], [true, true, true]);

// planSync marks the line and plans the note; commitWrites writes it — only for what it writes.
{
  const headers = ['Property_ID', 'Property_Name', 'Car_Parking_(No)', 'Total_Built-up_Area'];
  const rows = [headers, ['KDBMC001', 'Commercial Building for Rent', '9', '']];
  const existing = new Map([['KDBMC001', { id: 'KDBMC001', name: 'Commercial Building for Rent', parking: '3 cars per floor (9 spaces in total)', tenantId: 't_3pinrealty' }]]);
  const plan = planSync(rows, existing, null, null, null);
  const ch = (plan.updates[0] || { changes: [] }).changes.find(c => c.field === 'parking') || {};
  eq('planSync: the parking line is marked "kept in Notes"', [ch.from, ch.to, ch.keep], ['3 cars per floor (9 spaces in total)', '9', true]);
  eq('planSync: one note planned, for that property', plan.keepNotes.map(k => [k.id, k.items.map(i => i.field)]), [['KDBMC001', ['parking']]]);

  const sets = [];
  const fakeDb = { batch: () => ({ set: (ref, data, opt) => sets.push({ path: ref.path, data, opt }), update: () => {}, commit: async () => {} }),
    collection: c => ({ doc: id => ({ path: c + '/' + id, collection: s => ({ doc: n => ({ path: c + '/' + id + '/' + s + '/' + n }) }) }) }) };
  await commitWrites(fakeDb, plan.writes, plan.staleExtras, plan.keepNotes);
  const note = sets.find(s => /\/notes\//.test(s.path));
  eq('commitWrites: the property, then a note in its Notes', [sets[0].path, sets[0].data.parking, !!note], ['properties/KDBMC001', '9', true]);
  eq('…a plain note by "Inventory sync", with the old value in it', note && [note.data.kind, note.data.author, /3 cars per floor \(9 spaces in total\)/.test(note.data.text), note.data.id === note.path.split('/').pop()], ['note', 'Inventory sync', true, true]);
  sets.length = 0;
  await commitWrites(fakeDb, [], [], plan.keepNotes);
  eq('…and never for a property this run did not write (a subset apply)', sets.length, 0);
}

// ── The person decides: their ticks, not the suggestion ──
{
  const plan = { updates: [{ id: 'A', changes: [{ field: 'parking', from: '3 cars per floor', to: '3' }, { field: 'zone', from: '', to: 'Chennai South' }, { field: 'startingPrice', from: '1.2 Cr', to: '1.3 Cr' }] },
                           { id: 'B', changes: [{ field: 'parking', from: '2 Cars', to: '2' }] }] };
  eq('Ticks: exactly the fields ticked, with an old value; a property with none ticked keeps nothing',
    keepFromChoice(plan, { A: ['startingPrice', 'zone'], B: [] }), [{ id: 'A', items: [{ field: 'startingPrice', from: '1.2 Cr', to: '1.3 Cr' }] }]);
}

// ── Detail earlier syncs replaced: found, picked, kept — and not asked again ──
{
  const P = (id, d) => ({ ['properties/' + id]: { id, tenantId: TENANT_ID, ...d } });
  const db = fakeFirestore({
    ...P('NGMC0001', { name: 'Prime Commercial', parking: '9', highlights: 'Car Parking - 3 cars per floor (9 spaces in total)' }),
    ...P('TNAG0002', { name: '2BHK T Nagar', parking: '1', startingPrice: '₹1.3 Cr', sheetExtras: {} }),
    'syncBackups/sync-1': { tenantId: TENANT_ID, takenAt: '2026-10-15T07:00:00Z', properties: [
      { id: 'TNAG0002', data: { parking: '1 Open Car Park + Space for 1 Additional Car', startingPrice: '₹1.2 Cr', sheetExtras: { 'Main Door Facing': 'East & South Entrance' } } }] },
    'syncBackups/sync-2': { tenantId: TENANT_ID, takenAt: '2026-10-19T06:26:00Z', properties: [{ id: 'NGMC0001', data: { parking: '3 cars per floor (9 spaces in total)' } }] },
    // A run made since the dialog asks: its old values were decided there.
    'syncBackups/sync-3': { tenantId: TENANT_ID, takenAt: '2026-10-20T06:00:00Z', keepDecided: true, properties: [{ id: 'NGMC0001', data: { parking: '9 covered car parks' } }] }
  });
  const found = await findLostDetail(db);
  eq('Found: each shortened old value, not the price change, not a run already decided',
    found.map(f => [f.id, f.items.map(i => i.field + '=' + i.from)]),
    [['TNAG0002', ['parking=1 Open Car Park + Space for 1 Additional Car', 'Main Door Facing=East & South Entrance']], ['NGMC0001', ['parking=3 cars per floor (9 spaces in total)']]]);

  const ids = await writeRecoveredNotes(db,
    [{ id: 'TNAG0002', field: 'parking', from: '1 Open Car Park + Space for 1 Additional Car' }, { id: 'TNAG0002', field: 'parking', from: 'something never there' }],
    [{ id: 'TNAG0002', field: 'Main Door Facing', from: 'East & South Entrance' }]);
  const notes = [...db.store].filter(([p]) => /^properties\/TNAG0002\/notes\//.test(p)).map(([, d]) => d);
  eq('Picked: one note for that property, only the real old value', [ids, notes.length, /1 Open Car Park \+ Space for 1 Additional Car/.test(notes[0].text), /never there/.test(notes[0].text), notes[0].author], [['TNAG0002'], 1, true, false, 'Inventory sync']);
  eq('…NGMC0001, not picked, is left alone', [...db.store.keys()].some(p => /^properties\/NGMC0001\/notes\//.test(p)), false);
  eq('Next time: the kept one and the "just an update" one are not offered again; the rest still is',
    (await findLostDetail(db)).map(f => [f.id, f.items.map(i => i.field)]), [['NGMC0001', ['parking']]]);
  await writeRecoveredNotes(db, [], [{ id: 'NGMC0001', field: 'parking', from: 'made up' }]);
  eq('A "just an update" for an old value that is not there records nothing', (db.store.get('syncBackups/keepDecisions_' + TENANT_ID) || {}).declined.length, 1);
}

console.log(failed ? `\n${failed} failure(s)` : '\nAll good.');
process.exit(failed ? 1 : 0);
