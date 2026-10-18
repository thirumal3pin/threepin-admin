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
      fields:[{ field:'possession', from:'Ready', to:'Immediate' },
        // A sheet column of its own (sheetExtras): its own line, by the sheet's name — a long one.
        { field:'Registration & Documentation Charges Payable', from:'', to:'Approximately 7.5% of the guideline value, payable directly by the purchaser at the sub-registrar office' }] },
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

// A sheet column's change shows its name, what it was and what it becomes; on a phone the long name
// and value wrap inside the dialog.
const col = await page.evaluate(() => [...document.querySelectorAll('#syncBody .sync-f')].map(f => f.textContent.replace(/\s+/g, ' ').trim()).find(t => /Registration/.test(t)) || '');
ok('A sheet column is listed by its own name, with its new value', /Registration & Documentation Charges Payable/.test(col) && /7\.5% of the guideline value/.test(col) && !/\(map\)|keys/.test(col), col);
await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
const fits = await page.evaluate(() => { const f = [...document.querySelectorAll('#syncBody .sync-f')].find(x => /Registration/.test(x.textContent)); const b = document.getElementById('syncBody'); return !!f && f.getBoundingClientRect().right <= b.getBoundingClientRect().right + 1 && document.documentElement.scrollWidth <= window.innerWidth + 1; });
ok('…on a phone it wraps inside the dialog, no sideways scroll', fits);
await page.screenshot({ path: join(OUT, 'sync-phone.png') });
await page.setViewportSize({ width: 1440, height: 950 }); await page.waitForTimeout(200);

// ── 3. Deleting a property that cards and leads still point at says so first ──
console.log('\n── delete warning ──');
const asked = [];
const onDialog = d => { asked.push(d.message()); d.dismiss(); };   // dismissed: nothing is deleted
page.on('dialog', onDialog);
const del = await page.evaluate(async () => {
  window.dashboardFirebase.propertyUsage = async (id, code) => ({ cards: ['Anna Nagar 3BHK'], leads: 2, _asked: [id, code] });
  await deleteProperty('ANR003');
  window.dashboardFirebase.propertyUsage = async () => { throw new Error('offline'); };
  await deleteProperty('ANR003');
  delete window.dashboardFirebase.propertyUsage;
  await deleteProperty('ANR003');
  return { stillThere: properties.some(p => p.id === 'ANR003') };
});
page.off('dialog', onDialog);
console.log('   ', JSON.stringify(asked));
ok('the warning names the cards and the leads still linked',
  asked[0] && /1 Shoot & Media card \(Anna Nagar 3BHK\)/.test(asked[0]) && /2 CRM leads/.test(asked[0]), asked[0]);
ok('a failed check still asks the plain question', asked[1] && /^Delete "/.test(asked[1]) && !/Still linked/.test(asked[1]), asked[1]);
ok('no usage check available: the plain question too', asked[2] && !/Still linked/.test(asked[2]), asked[2]);
ok('cancelled: nothing deleted', del.stillThere, JSON.stringify(del));

// ── 3b. A delete that does not go through leaves no "Property deleted" step pending in the log ──
{
  const acceptAll = d => d.accept();
  page.on('dialog', acceptAll);
  const r = await page.evaluate(async () => {
    const saved = [], applied = [];
    const keep = { ...window.dashboardFirebase };
    window.dashboardFirebase.saveChanges = async entries => { saved.push(...entries); };
    window.dashboardFirebase.setChangeApplied = async (id, v) => { applied.push([id, v]); };
    window.dashboardFirebase.deleteProperty = async () => { throw new Error('offline'); };
    if (!window.dashboardAuth.getUserEmail) window.dashboardAuth.getUserEmail = () => 'agent.a@example.com';
    openDetail('VLC001');
    await new Promise(res => setTimeout(res, 150));
    await deleteProperty('VLC001');
    await new Promise(res => setTimeout(res, 400));
    Object.assign(window.dashboardFirebase, keep);
    const del = saved.find(c => c.kind === 'delete');
    return { stillThere: properties.some(p => p.id === 'VLC001'), delLogged: !!del,
      delSetAside: !!del && applied.some(([id, v]) => id === del.id && v === true),
      note: saved.some(c => /did not go through/.test(c.label || '')), onPage: location.pathname };
  });
  page.off('dialog', acceptAll);
  ok('a failed delete: the property is kept', r.stillThere, JSON.stringify(r));
  ok('…its "Property deleted" log entry is set aside, not left as a sheet step', r.delLogged && r.delSetAside, JSON.stringify(r));
  ok('…and the log says the delete did not go through', r.note, JSON.stringify(r));
  ok('…and the page is still the dashboard', /dashboard/.test(r.onPage), r.onPage);
}

// ── 4. Marketing, read only: the board card and the posts, read only when opened ──
console.log('\n── marketing ──');
const mk = await page.evaluate(async () => {
  closeSyncModal();
  let reads = 0;
  window.dashboardFirebase.propertyMarketing = async (id, code) => {
    reads++;
    return {
      cards: [{ id: 'lst_1', title: 'Anna Nagar 3BHK', stage: 'Live — marketing', shootAt: Date.now() - 864e5 * 5, shootDoneAt: Date.now() - 864e5 * 4, leadId: 'L9', listingType: 'exclusive' }],
      posts: [{ id: 'r1', channels: { igReel: { status: 'live', url: 'https://instagram.com/reel/x', liveAt: Date.now() - 864e5 }, yt: { status: 'scheduled', at: Date.now() - 3600e3 }, igStory: { status: 'na' },
        fbReel: { status: 'live', url: 'javascript:alert(1)' } }, acres99: { status: 'posted', url: 'https://99acres.com/x' } }]
    };
  };
  openDetail('ANR003');
  await new Promise(r => setTimeout(r, 200));
  const readsOnOpen = reads;
  const d = document.getElementById('dpMarketing');
  d.open = true;
  await new Promise(r => setTimeout(r, 200));
  const body = document.getElementById('dpMarketingBody');
  const links = [...body.querySelectorAll('a')].map(a => a.getAttribute('href'));
  const out = { readsOnOpen, reads, text: body.textContent.replace(/\s+/g, ' ').trim(), links };
  return out;
});
await page.evaluate(() => showTab('notes', document.querySelectorAll('.dp-tab')[DETAIL_TABS.indexOf('notes')]));
ok('the block is on the property’s Notes tab, visible there', await page.evaluate(() => document.getElementById('dpMarketing').getBoundingClientRect().height > 40));
await page.locator('#dpMarketing').scrollIntoViewIfNeeded().catch(() => {});
await page.locator('#dpMarketing').screenshot({ path: join(OUT, 'marketing.png'), timeout: 5000 }).catch(e => console.log('   (no shot: ' + e.message.split('\n')[0] + ')'));
await page.evaluate(() => { closeDetail(); delete window.dashboardFirebase.propertyMarketing; });
console.log('   ', JSON.stringify(mk));
ok('nothing is read until the block is opened', mk.readsOnOpen === 0 && mk.reads === 1, JSON.stringify(mk));
ok('it shows the card, its column and its shoot', /Anna Nagar 3BHK/.test(mk.text) && /In Live — marketing/.test(mk.text) && /Shot /.test(mk.text) && /Exclusive/.test(mk.text), mk.text);
ok('…with links to the card and to the seller', mk.links.includes('propertytrack.html?listing=lst_1') && mk.links.includes('crm.html?lead=L9'), JSON.stringify(mk.links));
ok('it lists the posts with their links (N/A ones left out)', /Insta Reel/.test(mk.text) && /99 Acres/.test(mk.text) && !/Insta Story/.test(mk.text)
  && mk.links.includes('https://instagram.com/reel/x') && mk.links.includes('https://99acres.com/x'), mk.text);
ok('a scheduled post whose time has passed reads as due', /YouTube\s*Due/.test(mk.text), mk.text);
ok('a link that is not a web address is never made clickable', !mk.links.some(h => /^javascript:/i.test(h || '')), JSON.stringify(mk.links));
await page.close();
await browser.close();
console.log(errors.length ? `\n${errors.length} FAILURE(S)\n` + errors.map(e => ' - ' + e).join('\n') : '\nAll checks passed.');
process.exit(errors.length ? 1 : 0);
