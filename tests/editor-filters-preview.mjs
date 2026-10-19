// The Editor keeps filters and a Sort of its own, apart from the board's (and the list's).
//
//   node tests/editor-filters-preview.mjs [outDir]
//
// Narrowing the board to one stage must not empty the editor's columns, nor the other way round;
// the Editor's Sort is shown and orders its cards; both views keep their choices when you switch.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStages } from '../track-assets/track-pipeline.js';

const OUT = process.argv[2] || 'tests/out/editor-filters';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.now();
const H = 3600000, D = 24 * H;
const T = 't_3pinrealty';
const STAGES = defaultStages();
const sid = key => STAGES.find(s => s.key === key).id;

const LISTINGS = [
  { id: 'l1', tenantId: T, title: 'Apartment in Nungambakkam', propertyCode: 'TNAG0002', location: 'Nungambakkam',
    stageId: sid('shoot_scheduled'), shootAt: NOW + 2 * D, shootAssignee: 'Ravi', ownerInformed: true,
    media: {}, stageChangedAt: NOW - 2 * D, createdAt: NOW - 5 * D, updatedAt: NOW - H },
  { id: 'l4', tenantId: T, title: 'Plot, Kelambakkam', sellerName: 'Anand',
    stageId: sid('shoot_scheduled'), shootAt: NOW - 4 * D, media: {},                                  // missed: late
    stageChangedAt: NOW - 6 * D, createdAt: NOW - 8 * D, updatedAt: NOW - 4 * D },
  { id: 'l3', tenantId: T, title: 'Velachery 2BHK', propertyCode: 'VLCA002', location: 'Velachery',
    stageId: sid('shoot_done'), shootAt: NOW - 2 * D, shootAssignee: 'Ravi', media: { photos: true }, ownerInformed: true, ownerApproved: true,
    stageChangedAt: NOW - D, createdAt: NOW - 12 * D, updatedAt: NOW - D },
  { id: 'l2', tenantId: T, title: 'Villa, Kottivakkam', stageId: sid('details'),
    media: {}, stageChangedAt: NOW - 9 * D, createdAt: NOW - 9 * D, updatedAt: NOW - 3 * D }
];

const STUB = `
window.trackFirebase = {
  saveListing: async () => {}, deleteListing: async () => {}, savePipeline: async () => {}, patchLead: async () => {},
  getLeadConversation: async () => null, getInventory: async () => [], getListingHistory: async () => [],
  saveHistory: async () => {}, deleteHistory: async () => {}
};
window.trackAuth = { login: async () => {}, logout: async () => {}, getTenantId: () => '${T}' };
setTimeout(() => {
  window.onTrackAuthChange({ email: 'agent.a@example.com' }, '${T}');
  window.applyTrackPipelineSnapshot(${JSON.stringify(STAGES)});
  window.applyListingsSnapshot(${JSON.stringify(LISTINGS)});
  window.applyTrackLeadsSnapshot([]);
  window.__ready = true;
}, 0);
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const browser = await chromium.launch();
const errors = [];
const ok = (label, cond, detail) => { if (cond) console.log('  ok  ' + label); else errors.push(label + (detail !== undefined ? ' — ' + detail : '')); };

async function open(viewport, ctx) {
  ctx = ctx || await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${viewport.width}px: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`${viewport.width}px console: ${m.text()}`); });
  page.on('dialog', d => d.accept());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'track.local') return route.abort();
    if (url.pathname === '/track-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://track.local/propertytrack.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.waitForTimeout(250);
  return page;
}

const bar = page => page.evaluate(() => {
  const t = s => ((document.querySelector(s) || {}).textContent || '').replace(/\s+/g, ' ').trim();
  const sort = document.querySelector('.tk-dd-sort select');
  return {
    stage: t('#ddStage .tk-dd-v'), badge: t('#tkFiltersBtn .lf-badge'),
    sortShown: !!sort && getComputedStyle(sort.closest('.tk-dd-sort')).display !== 'none',
    sort: sort && sort.value, sortOpts: sort ? [...sort.options].map(o => o.textContent) : []
  };
});
const edCol = (page, key) => page.$$eval(`.ed-${key} .ed-card`, els => els.map(e => e.dataset.id));
const boardCols = page => page.$$eval('.tk-board:not(.ed-board) .tk-col-title', els => els.map(e => e.textContent.trim()));

console.log('Shoot & Media — the Editor has its own filters and Sort');
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { try { localStorage.clear(); } catch (e) {} sessionStorage.setItem('seeded', '1'); } });
let page = await open({ width: 1440, height: 950 }, ctx);

// The board: one stage, sorted by name.
await page.evaluate(() => { setBoardMode('board'); toggleStageFilter(window.trackApi.listings().find(l => l.id === 'l3').stageId); setBoardSort('name'); });
await page.waitForTimeout(150);
let b = await bar(page);
ok('Board: the stage filter is on, its badge says 1', b.stage === 'Shoot done' && b.badge === '1', JSON.stringify(b));
ok('…only that column shows', JSON.stringify(await boardCols(page)) === '["Shoot done"]', JSON.stringify(await boardCols(page)));

// The Editor: none of the board's filters, its own Sort shown.
await page.evaluate(() => setBoardMode('editor'));
await page.waitForTimeout(200);
b = await bar(page);
ok('Editor: the board\'s stage filter does not follow', b.stage === 'All stages' && !b.badge, JSON.stringify(b));
ok('…its Sort is shown', b.sortShown, JSON.stringify(b));
ok('…with the Editor\'s own options, nearest deadline by default', b.sort === 'deadline' && b.sortOpts[0] === 'Nearest deadline' && b.sortOpts.includes('Editor A–Z') && b.sortOpts.includes('Outlet') && !b.sortOpts.includes('Price: high to low'), JSON.stringify(b.sortOpts));
const planned0 = await edCol(page, 'shoot_planned');
ok('…every editor card shows (the board\'s filter does not empty it)', planned0.length === 2 && (await edCol(page, 'shoot_done')).includes('l3'), JSON.stringify(planned0));
ok('…nearest deadline: the late (missed) shoot first', JSON.stringify(planned0) === '["l4","l1"]', JSON.stringify(planned0));
ok('…no "nearest deadline first" note left in the summary (the Sort says it)', !/nearest deadline first/.test(await page.textContent('.ed-sum')));
await page.screenshot({ path: `${OUT}/desk-editor.png` });

// The Editor's own Sort orders its cards.
await page.selectOption('.tk-dd-sort select', 'name');
await page.waitForTimeout(150);
ok('Editor Sort Name A–Z: the cards re-order', JSON.stringify(await edCol(page, 'shoot_planned')) === '["l1","l4"]', JSON.stringify(await edCol(page, 'shoot_planned')));
await page.selectOption('.tk-dd-sort select', 'shoot');
await page.waitForTimeout(150);
ok('Editor Sort Shoot date: earliest shoot first', JSON.stringify(await edCol(page, 'shoot_planned')) === '["l4","l1"]', JSON.stringify(await edCol(page, 'shoot_planned')));
await page.selectOption('.tk-dd-sort select', 'name');
await page.waitForTimeout(100);

// The Editor's own filter.
await page.evaluate(() => toggleStageFilter(window.trackApi.listings().find(l => l.id === 'l1').stageId));
await page.waitForTimeout(150);
b = await bar(page);
ok('Editor: a stage filter of its own', b.stage === 'Shoot scheduled' && b.badge === '1' && (await edCol(page, 'shoot_done')).length === 0 && (await edCol(page, 'shoot_planned')).length === 2, JSON.stringify(b));

// Back to the board: its own choices, untouched.
await page.evaluate(() => setBoardMode('board'));
await page.waitForTimeout(200);
b = await bar(page);
ok('Board again: its stage filter and Sort are as left', b.stage === 'Shoot done' && b.badge === '1' && b.sort === 'name' && b.sortOpts.includes('Price: high to low'), JSON.stringify(b));
ok('…still one column', JSON.stringify(await boardCols(page)) === '["Shoot done"]');
// The list shares the board's.
await page.evaluate(() => setBoardMode('list'));
await page.waitForTimeout(150);
b = await bar(page);
ok('List: the board\'s filters and Sort', b.stage === 'Shoot done' && b.sort === 'name', JSON.stringify(b));
await page.evaluate(() => setBoardMode('editor'));
await page.waitForTimeout(150);
b = await bar(page);
ok('Editor again: its own filter and Sort, as left', b.stage === 'Shoot scheduled' && b.sort === 'name', JSON.stringify(b));
// "Board" in the menu leaves the Editor for the board's own filters.
await page.evaluate(() => toggleView('board', true));
await page.waitForTimeout(150);
ok('The menu\'s Board: the board\'s filters again', (await bar(page)).stage === 'Shoot done');

// Each Sort is remembered on the device, apart.
const saved = await page.evaluate(() => ({ board: localStorage.getItem('track.sort'), editor: localStorage.getItem('track.edSort') }));
ok('Each Sort is remembered apart', saved.board === 'name' && saved.editor === 'name', JSON.stringify(saved));
await page.evaluate(() => { setBoardSort('stage'); setBoardMode('editor'); });
await page.reload();
await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
await page.waitForTimeout(250);
b = await bar(page);
ok('After a reload the Editor opens on its own Sort', b.sort === 'name' && b.sortOpts[0] === 'Nearest deadline', JSON.stringify(b));
await page.evaluate(() => setBoardMode('board'));
await page.waitForTimeout(150);
ok('…and the board on its own', (await bar(page)).sort === 'stage');

// ── The Editor as a list, a filter on every column ──
console.log('The Editor\'s list');
await page.evaluate(() => { setBoardMode('editor'); clearStageFilter(); setEditorSort('deadline'); setEdLayout('list'); });
await page.waitForTimeout(250);
const lrows = () => page.$$eval('.ed-lrow', rs => rs.map(r => r.querySelector('.ed-lc-prop b').textContent));
const all3 = await lrows();
ok('List: one row per card, the same cards as the columns', all3.length === 3 && !(await page.$('.ed-board')), JSON.stringify(all3));
ok('…a filter under every column', (await page.$$('.ed-lf .ed-lf-c')).length === 7);
ok('…in the Editor\'s Sort: the late shoot first', all3[0] === 'Plot, Kelambakkam', JSON.stringify(all3));
await page.selectOption('.ed-lf select[aria-label="Filter Status"]', 'shoot_done');
await page.waitForTimeout(200);
ok('Status column filter: only Shoot done', JSON.stringify(await lrows()) === '["Velachery 2BHK"]', JSON.stringify(await lrows()));
ok('…the count says how many of how many', /1 of 3/.test(await page.textContent('.ed-lbar')));
await page.click('.ed-lbar .tk-link:has-text("Clear column filters")');
await page.waitForTimeout(200);
await page.fill('#edLfProp', 'nunga');
await page.waitForTimeout(250);
ok('Property filter: by name, the box keeps its focus while typing', JSON.stringify(await lrows()) === '["Apartment in Nungambakkam"]' && await page.evaluate(() => document.activeElement.id === 'edLfProp'), JSON.stringify(await lrows()));
await page.evaluate(() => clearEdColF());
await page.waitForTimeout(150);
ok('Columns or list is remembered on the device', await page.evaluate(() => localStorage.getItem('track.edLayout') === 'list'));

// ── The editor's view of a card ──
console.log('The editor\'s view');
await page.click('.ed-lrow:has-text("Velachery 2BHK")');
await page.waitForTimeout(400);
const dv = await page.evaluate(() => ({ ed: document.getElementById('dp').classList.contains('dp-ed'), secs: [...document.querySelectorAll('#dpBody .tk-sec-hdr')].map(h => h.textContent.trim()) }));
ok('From the Editor a card opens in the editor\'s view: the shoot, its photos, the edits, the posts, Shoot for — nothing else', dv.ed && JSON.stringify(dv.secs) === JSON.stringify(['Shoot', 'Photos', 'Edit — per outlet', 'Posts', 'Shoot for']), JSON.stringify(dv));
await page.evaluate(() => openDetail('l3'));
await page.waitForTimeout(200);
ok('…a redraw of the open card keeps the editor\'s view', await page.evaluate(() => document.getElementById('dp').classList.contains('dp-ed')));
await page.click('#dpBody button:has-text("Full record")');
await page.waitForTimeout(300);
ok('…"Full record" opens everything', await page.evaluate(() => !document.getElementById('dp').classList.contains('dp-ed') && document.querySelectorAll('#dpBody .tk-sec-hdr').length > 6));
await page.evaluate(() => { closeDetail(); setBoardMode('board'); openDetail('l3'); });
await page.waitForTimeout(300);
ok('From the board a card opens in full, as before', await page.evaluate(() => !document.getElementById('dp').classList.contains('dp-ed')));
await page.evaluate(() => { closeDetail(); setEdLayout('board'); });
await ctx.close();

// ── Phone ──
console.log('Phone');
page = await open({ width: 390, height: 844 });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} setBoardMode('editor'); });
await page.waitForTimeout(200);
const folded = await page.evaluate(() => [...document.querySelectorAll('#tkFilterBar > *')].every(e => getComputedStyle(e).display === 'none'));
ok('Phone Editor: the filters fold behind the Filters button', folded);
await page.click('#tkFiltersBtn');
await page.waitForTimeout(150);
b = await bar(page);
ok('…and open with it, the Editor\'s Sort among them', b.sortShown && b.sort === 'deadline', JSON.stringify(b));
const fits = await page.evaluate(() => {
  const r = s => [...document.querySelectorAll(s)].map(e => e.getBoundingClientRect()).filter(x => x.width);
  return { page: document.documentElement.scrollWidth <= window.innerWidth + 1, dd: r('#tkFilterBar > *').every(x => x.left >= 0 && x.right <= window.innerWidth + 1) };
});
ok('…every control on screen, no sideways scroll of the page', fits.page && fits.dd, JSON.stringify(fits));
await page.screenshot({ path: `${OUT}/phone-editor-filters.png` });

await browser.close();
if (errors.length) { console.log('\nFAILED:\n  ' + errors.join('\n  ')); process.exit(1); }
console.log(`\nNo page errors. Screenshots in ${OUT}`);
