// ═══════ DASHBOARD: FREE-TEXT SEARCH, AND PER-PROPERTY SHEET SYNC ═══════
//
// Two things that were reported broken:
//   1. Search could not find a property by built-up area, UDS, or any other
//      detail — the haystack was a hand-kept list of 13 fields — and a value
//      stored as "1,131" was not found by typing 1131.
//   2. Sync from Sheet was all-or-nothing: no way to approve one property.
//
//   node tests/dashboard-search-sync-preview.mjs <out-dir>

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || 'dash-out';
mkdirSync(OUT, { recursive: true });
const T = 't_3pinrealty';

const PROPS = [
  { id:'ANR003', propertyCode:'ANR003', tenantId:T, name:'3BHK Apartment - Anna Nagar', location:'Anna Nagar',
    type:'Apartment', builder:'Individual Owner', config:'3BHK', status:'Under Construction',
    sqftRange:'1,131', uds:'620', totalLandArea:'2,400', startingPrice:'3,25,00,000', pricePerSqft:'21,173',
    possession:'Dec 2027', facing:'West', zone:'Chennai West',
    brochureLink:'https://drive.google.com/file/d/abc/view',
    sheetExtras:{ 'Corpus Fund':'2,50,000 payable on handover', 'Maintenance':'3.5 per sqft' } },
  { id:'VLC001', propertyCode:'VLC001', tenantId:T, name:'2BHK Velachery', location:'Velachery',
    type:'Apartment', builder:'Casagrand', config:'2BHK', status:'Ready to Move',
    sqftRange:'980', uds:'410', startingPrice:'1,10,00,000', pricePerSqft:'11,224',
    possession:'Ready', facing:'East', zone:'Chennai South',
    brochureLink:'https://drive.google.com/file/d/xyz/view',
    sheetExtras:{ 'Corpus Fund':'1,00,000' } },
  { id:'OMR007', propertyCode:'OMR007', tenantId:T, name:'Plot at OMR', location:'Sholinganallur',
    type:'Plot', builder:'Individual Owner', status:'Ready to Move',
    totalLandArea:'1,200', startingPrice:'85,00,000', zone:'Chennai South', sheetExtras:{} },
];

// The dry-run payload api/sync-inventory returns, with the new fields.
const SYNC_PREVIEW = {
  ok:true, dryRun:true, sheetRows:3, sheetColumns:40, unmappedHeaders:[],
  created:1, updated:2, unchanged:0, untouched:0, protectedFields:[], skippedDeleted:[],
  changesTotal:3,
  changes:[
    { id:'NEW001', name:'Brand New Listing', kind:'create', fields:[] },
    { id:'ANR003', name:'3BHK Apartment - Anna Nagar', kind:'update',
      fields:[{ field:'startingPrice', from:'3,25,00,000', to:'3,15,00,000' }] },
    { id:'VLC001', name:'2BHK Velachery', kind:'update',
      fields:[{ field:'possession', from:'Ready', to:'Immediate' }] },
  ],
};

const STUB = `
const PROPS = ${JSON.stringify(PROPS)};
window.__syncCalls = [];
window.dashboardFirebase = {
  saveProperty: async()=>{}, deleteProperty: async()=>{}, saveFavorites: async()=>{},
  saveChange: async()=>{}, getChanges: async()=>[], saveNaFields: async()=>{},
};
window.dashboardAuth = {
  login: async()=>{}, logout: async()=>{},
  getIdToken: async()=>'test-token', getTenantId: ()=>'${T}',
};
if(window.onDashboardAuthChange) window.onDashboardAuthChange({ email:'agent.a@example.com' });
if(window.applyPropertiesSnapshot) window.applyPropertiesSnapshot(JSON.parse(JSON.stringify(PROPS)));
window.__ready = true;
`;

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.jpg':'image/jpeg', '.json':'application/json' };
const browser = await chromium.launch();
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};

const page = await (async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch(e){} });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => { console.log('  PAGEERROR ' + e.message); errors.push('pageerror: ' + e.message); });
  pg.on('console', m => { if (m.type()==='error' && !/Failed to load resource|net::ERR/.test(m.text())) { console.log('  CONSOLE ' + m.text()); errors.push('console: ' + m.text()); } });
  await pg.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'dash.local') return route.abort();
    if (url.pathname === '/dashboard-assets/firebase-sync.js') return route.fulfill({ contentType:'text/javascript', body: STUB });
    // Record what the dashboard asks the sync endpoint for, and answer it.
    if (url.pathname === '/api/sync-inventory') {
      const body = JSON.parse(route.request().postData() || '{}');
      const reply = body.dryRun
        ? SYNC_PREVIEW
        : { ok:true, ...SYNC_PREVIEW, dryRun:false,
            written: (body.only || SYNC_PREVIEW.changes.map(c=>c.id)).length,
            appliedIds: body.only || SYNC_PREVIEW.changes.map(c=>c.id) };
      return route.fulfill({ contentType:'application/json', body: JSON.stringify(reply) });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType:'application/json', body:'{"ok":true}' });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status:404, body:'' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await pg.goto('http://dash.local/dashboard.html');
  await pg.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await pg.evaluate(() => { const r = document.getElementById('appRoot'); if (r) r.style.display = ''; });
  await pg.waitForTimeout(500);
  return pg;
})();

// Record every POST body the page sends to the sync endpoint.
await page.evaluate(() => {
  const orig = window.fetch;
  window.__syncCalls = [];
  window.fetch = (u, o) => {
    if (String(u).includes('/api/sync-inventory') && o && o.body) window.__syncCalls.push(JSON.parse(o.body));
    return orig(u, o);
  };
});

// Search used to be checked here against a three-property stub. It is now a
// real engine with its own suite — tests/property-search.test.mjs, 748
// assertions over the 131-property inventory snapshot — plus
// tests/search-preview.mjs, which drives the live page. Keeping a thinner copy
// of that here would only ever be the one that broke first for the wrong
// reason. This file is now about the sheet sync alone.

// ── 2. Sync from sheet, property by property ──
console.log('\n── sync ──');
await page.evaluate(() => openSyncModal());
await page.waitForTimeout(600);

const ui = await page.evaluate(() => ({
  rows: document.querySelectorAll('#syncBody .sync-row').length,
  perRowButtons: document.querySelectorAll('#syncBody .sync-one-btn').length,
  checkboxes: document.querySelectorAll('#syncBody .sync-pick').length,
  selectAll: !!document.getElementById('syncPickAll'),
  applyAll: (document.getElementById('syncApplyBtn')||{}).textContent,
  applySelShown: getComputedStyle(document.getElementById('syncApplySelBtn')).display,
}));
console.log('   ', JSON.stringify(ui));
ok('every changed property is listed', ui.rows === 3, String(ui.rows));
ok('each row has its own Update button', ui.perRowButtons === 3, String(ui.perRowButtons));
ok('each row can be ticked', ui.checkboxes === 3 && ui.selectAll, JSON.stringify(ui));
ok('Apply all names the count', /Apply all 3/.test(ui.applyAll || ''), ui.applyAll);
ok('Apply selected is hidden until something is ticked', ui.applySelShown === 'none', ui.applySelShown);

// One property, on its own.
const one = await page.evaluate(async () => {
  const row = document.querySelector('#syncBody .sync-row[data-sync-id="ANR003"]');
  row.querySelector('.sync-one-btn').click();
  await new Promise(r => setTimeout(r, 400));
  return {
    sent: window.__syncCalls[window.__syncCalls.length - 1],
    applied: row.classList.contains('applied'),
    btnDisabled: row.querySelector('.sync-one-btn').disabled,
    applyAll: document.getElementById('syncApplyBtn').textContent,
  };
});
console.log('   ', JSON.stringify(one));
ok('Update sends only that property', one.sent && one.sent.dryRun === false && JSON.stringify(one.sent.only) === '["ANR003"]', JSON.stringify(one.sent));
ok('the row shows it was applied', one.applied && one.btnDisabled, JSON.stringify(one));
ok('the remaining count drops', /Apply all 2/.test(one.applyAll || ''), one.applyAll);

// A ticked subset.
const many = await page.evaluate(async () => {
  const row = document.querySelector('#syncBody .sync-row[data-sync-id="VLC001"]');
  const cb = row.querySelector('.sync-pick');
  cb.checked = true;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 80));
  const label = document.getElementById('syncApplySelBtn').textContent;
  document.getElementById('syncApplySelBtn').click();
  await new Promise(r => setTimeout(r, 400));
  return {
    label,
    sent: window.__syncCalls[window.__syncCalls.length - 1],
    applied: row.classList.contains('applied'),
    applyAll: document.getElementById('syncApplyBtn').textContent,
  };
});
console.log('   ', JSON.stringify(many));
ok('Apply selected names how many are ticked', /Apply 1 selected/.test(many.label || ''), many.label);
ok('…and sends exactly those', JSON.stringify(many.sent.only) === '["VLC001"]', JSON.stringify(many.sent));
ok('…and marks them applied', many.applied, String(many.applied));
ok('only the untouched one is left', /Apply all 1/.test(many.applyAll || ''), many.applyAll);

// An already-applied property is not offered again.
const noRepeat = await page.evaluate(() => {
  document.getElementById('syncPickAll').click();
  const ticked = [...document.querySelectorAll('#syncBody .sync-pick')].filter(c => c.checked).length;
  return { ticked, label: document.getElementById('syncApplySelBtn').textContent };
});
ok('Select all skips what is already written', noRepeat.ticked === 1, JSON.stringify(noRepeat));

await page.screenshot({ path: join(OUT, 'sync-per-property.png') });
await page.close();
await browser.close();
console.log(errors.length ? `\n${errors.length} FAILURE(S)\n` + errors.map(e => ' - ' + e).join('\n') : '\nAll checks passed.');
process.exit(errors.length ? 1 : 0);
