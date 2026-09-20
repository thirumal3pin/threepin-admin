// ═══════ THE RAIL AND FINANCE MUST AGREE ═══════
//
// finance-assets/app.js owns routing: which view keys exist, what each is
// called, and which group it belongs to. shared-assets/appnav.js owns the
// menu, and has to list the same nineteen pages — it cannot import the
// finance module, because it also runs on two pages that never load it.
//
// So the two lists are kept in step by this test rather than by memory. Add a
// finance screen and forget the rail, and this fails by name.
//
//   node tests/appnav.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url);
const read = p => readFileSync(fileURLToPath(new URL(p, root)), 'utf8');

let failures = 0;
const test = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n       ' + e.message); }
};

// ── finance-assets/app.js: const NAV = [ ['key', 'Label', 'icon', 'Group'], … ]
const navSrc = read('finance-assets/app.js').match(/const NAV = \[([\s\S]*?)\n\];/);
assert.ok(navSrc, 'finance-assets/app.js: NAV table not found — has it been renamed?');
const FINANCE = [...navSrc[1].matchAll(/\[\s*'([^']+)',\s*'([^']+)',\s*'[^']+',\s*'([^']+)'\s*\]/g)]
  .map(m => ({ key: m[1], label: m[2], group: m[3] }));

// ── shared-assets/appnav.js: FIN_GROUPS = [ ['Group', 'note', [ ['key','Label','icon'], … ] ], … ]
const railSrc = read('shared-assets/appnav.js').match(/var FIN_GROUPS = \[([\s\S]*?)\n  \];/);
assert.ok(railSrc, 'shared-assets/appnav.js: FIN_GROUPS table not found — has it been renamed?');
const RAIL = [];
for (const g of railSrc[1].matchAll(/\['([^']+)', '[^']*', \[([\s\S]*?)\]\]/g)) {
  for (const it of g[2].matchAll(/\['([^']+)', '([^']+)', '[^']+'\]/g)) {
    RAIL.push({ key: it[1], label: it[2], group: g[1] });
  }
}

console.log('\nThe app rail lists what Finance routes');
test('Both tables were parsed', () => {
  assert.ok(FINANCE.length > 10, 'finance NAV parsed ' + FINANCE.length + ' entries');
  assert.ok(RAIL.length > 10, 'rail FIN_GROUPS parsed ' + RAIL.length + ' entries');
});

test('Every finance page is in the rail, once', () => {
  const railKeys = RAIL.map(r => r.key);
  const missing = FINANCE.filter(f => !railKeys.includes(f.key)).map(f => f.key);
  assert.deepEqual(missing, [], 'missing from the rail: ' + missing.join(', '));
  const dupes = railKeys.filter((k, i) => railKeys.indexOf(k) !== i);
  assert.deepEqual(dupes, [], 'listed twice in the rail: ' + dupes.join(', '));
});

test('The rail invents no page Finance cannot route to', () => {
  const finKeys = FINANCE.map(f => f.key);
  const extra = RAIL.filter(r => !finKeys.includes(r.key)).map(r => r.key);
  assert.deepEqual(extra, [], 'in the rail but not in NAV: ' + extra.join(', '));
});

test('Each page is called the same thing in both', () => {
  const wrong = FINANCE
    .map(f => ({ f, r: RAIL.find(x => x.key === f.key) }))
    .filter(p => p.r && p.r.label !== p.f.label)
    .map(p => `${p.f.key}: "${p.f.label}" vs "${p.r.label}"`);
  assert.deepEqual(wrong, [], wrong.join('; '));
});

test('…and sits in the same group in both', () => {
  const wrong = FINANCE
    .map(f => ({ f, r: RAIL.find(x => x.key === f.key) }))
    .filter(p => p.r && p.r.group !== p.f.group)
    .map(p => `${p.f.key}: ${p.f.group} vs ${p.r.group}`);
  assert.deepEqual(wrong, [], wrong.join('; '));
});

test('The groups are in the order Finance declares them', () => {
  const order = a => a.map(x => x.group).filter((g, i, all) => all.indexOf(g) === i);
  assert.deepEqual(order(RAIL), order(FINANCE));
});

// ── Every console the rail offers has to be somewhere to go ──
const appnav = read('shared-assets/appnav.js');
const pages = [...appnav.matchAll(/^\s*(property|crm|finance): \{ href: '([^']+)'/gm)].map(m => m[2]);

console.log('\nEvery console the rail points at exists');
test('Three consoles, three destinations', () => assert.equal(pages.length, 3, JSON.stringify(pages)));
test('…and each one is a page in the repo', () => {
  // 3pinfinance is a rewrite to 3pinfinance.html — see vercel.json.
  const rewrites = JSON.parse(read('vercel.json')).rewrites || [];
  for (const href of pages) {
    const rule = rewrites.find(r => r.source === '/' + href);
    const file = rule ? rule.destination.replace(/^\//, '') : href;
    assert.doesNotThrow(() => read(file), href + ' → ' + file + ' is not in the repo');
  }
});

// ── The pages that draw the rail have to load it ──
console.log('\nEvery console loads the rail');
for (const [page, file] of [['Properties', 'dashboard.html'], ['CRM', 'crm.html'], ['Finance', '3pinfinance.html']]) {
  const html = read(file);
  test(page + ' loads the stylesheet, the script and has a menu button', () => {
    assert.match(html, /shared-assets\/appnav\.css/, file + ' is missing appnav.css');
    assert.match(html, /shared-assets\/appnav\.js/, file + ' is missing appnav.js');
    assert.match(html, /data-rail-toggle/, file + ' has no menu button');
  });
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll good.');
process.exit(failures ? 1 : 0);
