// ═══════ MODULE SMOKE TEST ═══════
//
// Every view module is loaded and rendered once against empty books and once against books
// with something in them. It catches the class of mistake unit tests miss and only a browser
// would otherwise find: a function used but never imported, a renderer that throws on a fresh
// tenant, or a template that puts "undefined" on the screen.
//
// A real ReferenceError inside a render (bal() used in app.js without importing it) shipped
// once. This is the cheap check that stops the next one.
//
//   node tests/finance-modules.test.mjs

// A DOM stub thin enough that a module can be imported and a render called. Nothing here
// pretends to be a browser — the views build strings, and that is what is being checked.
const noop = () => {};
const el = () => ({
  style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  querySelectorAll: () => [], querySelector: () => null, appendChild: noop, addEventListener: noop,
  setAttribute: noop, removeAttribute: noop, remove: noop, focus: noop, click: noop,
  innerHTML: '', textContent: '', value: '', hidden: false, dataset: {}, children: [],
});
globalThis.document = {
  getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [],
  createElement: () => el(), addEventListener: noop, body: el(), documentElement: el(),
  fonts: { ready: Promise.resolve(), check: () => true },
};
globalThis.window = { addEventListener: noop, location: { hash: '' }, matchMedia: () => ({ matches: false, addEventListener: noop }) };
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

const { getState, setState, blank, defaultSettings, num } = await import('../finance-assets/finance-core.js');
const { check, section, report, fresh, save, runMonthEnd } = await import('./_harness.mjs');

console.log('3 PIN Realty — module smoke test');

// Every module that renders something, and the export that does it.
// Modules that talk to Firestore import the SDK from a CDN, which node cannot load. Those
// are checked statically instead — which is exactly the check that would have caught the
// missing import, since it was a name used but never brought in.
const VIEWS = [
  ['views-owed.js', 'renderOwed'],
  ['views-services.js', 'renderServices'],
  ['views-services.js', 'renderLoans'],
  ['views-services.js', 'renderAssets'],
  ['views-reports.js', 'renderReports'],
  ['views-reports.js', 'renderBooks'],
  ['views-gst.js', 'renderGst'],
  ['views-analytics.js', 'renderAnalytics'],
  ['views-guide.js', 'renderGuide'],
];

section('Every module loads');
const mods = {};
for (const file of [...new Set(VIEWS.map(v => v[0]))]) {
  try {
    mods[file] = await import('../finance-assets/' + file);
    check(`${file} imports cleanly`, true);
  } catch (e) {
    check(`${file} imports cleanly`, false, e.message);
  }
}

// Every name a module borrows from finance-core.js or ui.js has to be imported. A helper
// used without importing it is a ReferenceError the moment that code path runs in a browser,
// and no amount of engine testing will find it.
section('Every module imports what it uses');
{
  const { readFileSync, readdirSync } = await import('node:fs');
  const src = f => readFileSync(new URL('../finance-assets/' + f, import.meta.url), 'utf8');
  const exportsOf = f => new Set([...src(f).matchAll(/export\s+(?:async\s+)?(?:const|function|let|class)\s+(\w+)/g)].map(m => m[1]));
  const provided = new Set([...exportsOf('finance-core.js'), ...exportsOf('ui.js')]);

  for (const file of readdirSync(new URL('../finance-assets/', import.meta.url)).filter(f => f.endsWith('.js'))) {
    const code = src(file);
    const imported = new Set();
    for (const m of code.matchAll(/import\s*{([^}]*)}\s*from/g)) {
      m[1].split(',').forEach(x => { const t = x.trim().split(/\s+as\s+/).pop(); if (t) imported.add(t); });
    }
    const declared = new Set([...code.matchAll(/(?:function|const|let|var|class)\s+(\w+)/g)].map(m => m[1]));
    // Prose is full of things that look like calls — "loan (EMI)", "ledger (1100 / 2000)" —
    // so comments and string bodies are blanked before anything is counted. A call on
    // something, `fin.closeModal(`, borrows nothing either: only a bare call does.
    // A small scanner rather than a regex, because quoting inside quoting defeats one.
    let bare = '', mode = 'code', prev = '';
    for (let i = 0; i < code.length; i++) {
      const c = code[i], next = code[i + 1];
      if (mode === 'code') {
        if (c === '/' && next === '/') { mode = 'line'; bare += ' '; continue; }
        if (c === '/' && next === '*') { mode = 'block'; bare += ' '; i++; continue; }
        if (c === '\'' || c === '"' || c === '`') { mode = c; bare += ' '; continue; }
        bare += c;
        continue;
      }
      if (mode === 'line') { if (c === '\n') { mode = 'code'; bare += '\n'; } continue; }
      if (mode === 'block') { if (prev === '*' && c === '/') mode = 'code'; prev = c; continue; }
      // inside a string: a backslash escapes the next character
      if (c === '\\') { i++; continue; }
      if (c === mode) { mode = 'code'; bare += ' '; }
      else if (c === '\n') bare += '\n';
    }
    const used = new Set([...bare.matchAll(/(^|[^.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)].map(m => m[2]));
    const missing = [...used].filter(u => provided.has(u) && !imported.has(u) && !declared.has(u));
    check(`${file} imports every helper it calls`, missing.length === 0, missing.join(', '));
  }
}

const renders = label => {
  for (const [file, fn] of VIEWS) {
    const mod = mods[file];
    if (!mod || typeof mod[fn] !== 'function') { check(`${fn} exists`, false, file); continue; }
    let html;
    try { html = mod[fn](); }
    catch (e) { check(`${fn} renders ${label}`, false, e.message); continue; }
    check(`${fn} renders ${label}`, typeof html === 'string' && html.length > 0);
    const bad = String(html).match(/undefined|NaN|\[object Object\]/);
    check(`${fn} has no undefined / NaN ${label}`, !bad,
      bad ? bad[0] + ' near "' + html.slice(Math.max(0, bad.index - 70), bad.index + 30).replace(/\s+/g, ' ') + '"' : '');
  }
};

section('Empty books — a brand-new tenant');
setState(blank());
getState().settings = { ...defaultSettings() };
renders('on empty books');

section('Books with something in them');
const s = fresh();
save('funding', { date: '2026-09-01', kind: '3000', who: 'Swaminathan N G', amt: 400000 });
save('transfer', { date: '2026-09-01', kind: '1000>1010', amt: 9000 });
save('newdeal', {
  date: '2026-09-09', nickname: 'Rajan — Nungambakkam 2BHK',
  seller: { __new: true, name: 'Mr. Rajan', type: 'client' }, buyer: { __new: true, name: 'Mr. Karthik', type: 'client' },
  expSeller: 200000, expBuyer: 100000,
});
const dealId = s.deals[0].id;
save('token', { date: '2026-09-10', deal: dealId, from: 'buyer', amt: 50000, via: '1000' });
save('invoice', {
  date: '2026-10-06', deal: dealId, from: 'buyer', amt: 100000, gst: 'yes', gstRate: 18,
  gstAmt: 18000, total: 118000, tds: 0, adv: 50000, recv: 'later', dueDate: '2026-11-05',
});
save('subnew', {
  date: '2026-09-01', name: 'Claude', plan: 'Pro', vendor: { __new: true, name: 'Anthropic', type: 'vendor' },
  payMode: 'monthly', billing: 'auto', amt: 1800, via: '1000',
});
const subId = s.subs[0].id;
save('confirmcharge', { sub: subId, month: '2026-09', date: '2026-09-05', result: 'paid', via: '1000', amt: 1800, gst: 'no', rcm: 'no' });
save('confirmcharge', {
  sub: subId, month: '2026-10', date: '2026-10-14', result: 'invoice', dueDate: '2026-10-28',
  amt: 4320, gst: 'no', rcm: 'yes', rcmRate: 18, rcmType: 'import', rcmCcy: 'USD', rcmFx: 88,
  reason: 'prorate', note: 'Upgraded mid-month', newPlan: 'yes', newAmount: 10000, newPlanName: 'Max', newFrom: '2026-11',
});
save('bill', {
  date: '2026-09-12', vendor: { __new: true, name: 'Balaji & Co', type: 'vendor' }, desc: 'Title opinion',
  acc: '5120', amt: 10000, gst: 'yes', gstRate: 18, gstAmt: 1800, total: 11800,
  gstType: 'intra', vgstin: '33AABCB1234A1Z5', vinv: 'BC/118', rcm: 'no', tds: 'none', tdsrate: 0,
});
// Office rent from a landlord who is not registered — reverse charge, paid on the spot.
save('expense', {
  date: '2026-09-08', desc: 'Office rent — Sep', acc: '5000', amt: 35000,
  rcm: 'yes', rcmRate: 18, rcmType: 'intra', gst: 'no', via: '1000',
});
save('asset', { date: '2026-09-03', name: 'MacBook Air', amt: 95000, gst: 'no', rcm: 'no', life: 36, how: '1000' });
save('petty', { date: '2026-09-20', a1: 300, c1: '5050', d1: 'Auto', a2: 0, a3: 0 });
runMonthEnd('2026-09');
renders('with entries');

section('Reverse charge on an expense reached the ledger');
{
  const { bal } = await import('../finance-assets/finance-core.js');
  // Only the rent leaves the bank — the GST on it is owed to the government, not the landlord.
  check('Only the rent itself left the bank',
    Math.abs(bal('1000') - (400000 + 50000 - 9000 - 1800 - 35000 - 95000)) < 0.02, String(bal('1000')));
  // 18% of 35,000 is 6,300, half to each head, on top of the 1,800 claimed on the lawyer's bill.
  check('CGST and SGST were self-assessed on the rent',
    Math.abs(bal('1400') - (3150 + 900)) < 0.02 && Math.abs(bal('1401') - (3150 + 900)) < 0.02,
    JSON.stringify([bal('1400'), bal('1401')]));
  check('…and the same amount is owed to the government', Math.abs(bal('2205') - (6300 + 777.6)) < 0.02, String(bal('2205')));
  const rentTxn = getState().txns.find(t => t.desc.includes('Office rent'));
  check('A self-invoice was numbered for it', !!rentTxn?.selfInvoiceNo, JSON.stringify(rentTxn?.selfInvoice));
  const svcTxn = getState().txns.find(t => t.desc.includes('Oct 2026'));
  check('The imported service records its currency and rate',
    svcTxn?.selfInvoice?.currency === 'USD' && num(svcTxn?.selfInvoice?.fxRate) === 88, JSON.stringify(svcTxn?.selfInvoice));
}

report();
