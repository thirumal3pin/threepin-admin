// The Inventory sheet sync's preview: what changed, field by field.   node tests/inventory-diff.test.mjs
import { diffProperty } from '../api/_inventory-shared.js';

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

console.log(failed ? `\n${failed} failure(s)` : '\nAll good.');
process.exit(failed ? 1 : 0);
