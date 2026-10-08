// Tags on the Property & Media board and the Posting tab, in the real page with firebase-sync
// stubbed: picking, creating on the spot, sharing spelling, tiles, the board's Tags filter, the
// Posting Sheet / Properties / Filters, and that a property has one set of tags across both.
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStages } from '../track-assets/track-pipeline.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ST = defaultStages(), T = 't', NOW = Date.now();
const L = [
  { id: 'a', tenantId: T, title: 'Velachery flat', location: 'Velachery', propertyCode: 'TVEL0001', stageId: 'details', media: {}, tags: ['Resale'], createdAt: NOW - 9e7, updatedAt: NOW, stageChangedAt: NOW },
  { id: 'b', tenantId: T, title: 'ECR plot', location: 'ECR', stageId: 'new_listing', media: {}, createdAt: NOW - 8e7, updatedAt: NOW, stageChangedAt: NOW },
  { id: 'c', tenantId: T, title: 'OMR tower', location: 'OMR', stageId: 'new_listing', media: {}, tags: ['New Dev.'], createdAt: NOW - 7e7, updatedAt: NOW, stageChangedAt: NOW }
];
const PT = [
  { id: 'pt_1', tenantId: T, propertyCode: 'TVEL0001', title: 'Velachery flat', channels: {}, createdAt: NOW - 5e6, updatedAt: NOW },
  { id: 'pt_2', tenantId: T, reference: 'Lux49 collab', channels: {}, tags: ['Collab'], createdAt: NOW - 4e6, updatedAt: NOW }
];
const STUB = `window.__saved=[];window.__posts=[];
window.trackFirebase={saveListing:async l=>{window.__saved.push(JSON.parse(JSON.stringify(l)))},getInventory:async()=>[],getListingHistory:async()=>[],saveHistory:async(id,e)=>{(window.__hist=window.__hist||[]).push(e.text)},deleteHistory:async()=>{},savePipeline:async()=>{},patchLead:async()=>{},
  savePosting:async(t,paths)=>{window.__posts.push({t:JSON.parse(JSON.stringify(t)),paths})},savePostings:async w=>{for(const x of w)window.__posts.push(x)},deletePosting:async()=>{},getPropertyInternalNotes:async()=>''};
window.trackAuth={login:async()=>{},logout:async()=>{},getTenantId:()=>'t',getIdToken:async()=>null};
setTimeout(()=>{window.onTrackAuthChange({email:'a@x'},'t');window.applyTrackPipelineSnapshot(${JSON.stringify(ST)});window.applyListingsSnapshot(${JSON.stringify(L)});window.applyTrackLeadsSnapshot([]);window.applyPostingSnapshot(${JSON.stringify(PT)});window.__ready=true},0);`;

const b = await chromium.launch();
let fails = 0;
const ok = (l, c, d = '') => { if (!c) fails++; console.log((c ? '  ok  ' : '  FAIL ') + l + (c ? '' : ' — ' + d)); };
async function open(width) {
  const p = await b.newPage({ viewport: { width, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**/*', r => {
    const u = new URL(r.request().url());
    if (u.hostname !== 'track.local') return r.abort();
    if (u.pathname === '/track-assets/firebase-sync.js') return r.fulfill({ contentType: 'text/javascript', body: STUB });
    const f = join(ROOT, decodeURIComponent(u.pathname));
    return existsSync(f) ? r.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(f)] || 'application/octet-stream', body: readFileSync(f) }) : r.fulfill({ status: 404, body: '' });
  });
  await p.addInitScript(() => { window.__trackInitialView = 'board'; });
  await p.goto('http://track.local/propertytrack.html');
  await p.waitForFunction(() => window.__ready); await p.waitForTimeout(400);
  return { p, errs };
}
const { p, errs } = await open(1440);
const settle = () => p.waitForTimeout(160);
const lst = id => p.evaluate(i => window.trackApi.listings().find(l => l.id === i), id);
const tileTags = id => p.$$eval(`.tk-card[data-id="${id}"] .tk-tags .tk-tag`, t => t.map(e => e.textContent.trim()));

console.log('On the board');
ok('a tile shows its tags', JSON.stringify(await tileTags('a')) === '["Resale"]', JSON.stringify(await tileTags('a')));
ok('…a tile with none shows none', (await tileTags('b')).length === 0);
ok('…each tag in its own colour (Resale is green)', await p.$eval('.tk-card[data-id="a"] .tk-tag', e => e.classList.contains('tc2') && getComputedStyle(e).color === 'rgb(21, 128, 61)'), await p.$eval('.tk-card[data-id="a"] .tk-tag', e => e.className + ' ' + getComputedStyle(e).color));
await p.evaluate(() => openDetail('a')); await settle();
ok('the listing\'s summary has the tag picker with its tags', await p.$eval('#dpBody .tk-sum-tags', e => /Resale/.test(e.textContent)) && !!(await p.$('#dpBody .tk-sum-tags .tg-in')));
await p.focus('#dpBody .tg-in'); await settle();
let sug = await p.$$eval('#dpBody .tg-sug.open .tg-opt', o => o.map(e => e.textContent.trim()));
ok('focusing it offers the other tags (not the ones on it), starting four first', JSON.stringify(sug) === JSON.stringify(['Collab', 'New Dev.', 'Plot']), JSON.stringify(sug));
await p.type('#dpBody .tg-in', 'plo'); await settle();
sug = await p.$$eval('#dpBody .tg-sug.open .tg-opt', o => o.map(e => e.textContent.trim()));
ok('typing narrows it (and still offers to create what was typed)', JSON.stringify(sug) === JSON.stringify(['Plot', 'Create “plo”']), JSON.stringify(sug));
await p.keyboard.press('Enter'); await settle();
ok('Enter adds it and saves', JSON.stringify((await lst('a')).tags) === '["Resale","Plot"]', JSON.stringify((await lst('a')).tags));
ok('…the box is ready for the next one', await p.evaluate(() => document.activeElement && document.activeElement.classList.contains('tg-in')));
ok('…and the tile shows it', JSON.stringify(await tileTags('a')) === '["Resale","Plot"]');
await p.type('#dpBody .tg-in', 'Sea   view'); await settle();
ok('a new word is offered as Create', /Create\s*“Sea view”/.test(await p.$eval('#dpBody .tg-sug.open', e => e.textContent)));
await p.keyboard.press('Enter'); await settle();
ok('…Enter creates it on the spot', (await lst('a')).tags.includes('Sea view'));
ok('the change is in the timeline', (await p.evaluate(() => window.__hist || [])).some(t => /Tag added: <b>Sea view<\/b>/.test(t)));
await p.evaluate(() => openDetail('b')); await settle();
await p.focus('#dpBody .tg-in'); await settle();
sug = await p.$$eval('#dpBody .tg-sug.open .tg-opt', o => o.map(e => e.textContent.trim()));
ok('another listing now gets the new tag offered too', sug.includes('Sea view'), JSON.stringify(sug));
await p.type('#dpBody .tg-in', 'resale'); await p.keyboard.press('Enter'); await settle();
ok('typing an existing tag in another case uses its spelling', JSON.stringify((await lst('b')).tags) === '["Resale"]', JSON.stringify((await lst('b')).tags));
await p.click('#dpBody .tg .tk-tag button.tg-x'); await settle();
ok('✕ removes it', (await lst('b')).tags.length === 0);
await p.evaluate(() => closeDetail()); await settle();

console.log('The board\'s Tags filter');
await p.click('#ddTag summary'); await settle();
const rows = await p.$$eval('#ddTag .tk-dd-row', r => r.map(e => [...e.querySelectorAll('.tk-dd-l, .tk-dd-n')].map(s => s.textContent.trim()).join(' ')));
ok('lists every tag with how many listings have it', rows.join('|').includes('Plot 1') && rows.join('|').includes('Resale 1') && rows.join('|').includes('New Dev. 1') && rows.join('|').includes('Sea view 1') && rows.join('|').includes('Collab 0'), JSON.stringify(rows));
await p.click('#ddTag .tk-dd-row:has-text("Plot") input'); await settle();
const shown = () => p.$$eval('.tk-card', c => c.map(e => e.dataset.id).sort().join(','));
ok('ticking Plot shows only listings tagged Plot', await shown() === 'a', await shown());
await p.click('#ddTag .tk-dd-row:has-text("New Dev.") input'); await settle();
ok('ticking New Dev. too shows either', await shown() === 'a,c', await shown());
await p.evaluate(() => clearTagFilter()); await settle();
await p.fill('#search, .srch-wrap input', 'sea view').catch(async () => p.evaluate(() => { const i = document.querySelector('input[type=search], .srch-wrap input'); i.value = 'sea view'; i.dispatchEvent(new Event('input', { bubbles: true })); }));
await settle();
ok('search finds a listing by its tag', await shown() === 'a', await shown());
await p.evaluate(() => { const i = document.querySelector('input[type=search], .srch-wrap input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); }); await settle();

console.log('In the Posting tab');
await p.evaluate(() => { toggleView('posting'); pgMode('sheet'); }); await p.waitForTimeout(500);
const rowTags = id => p.$$eval(`#pg-${id} .ps-tags .tg-t`, t => t.map(e => e.textContent.trim()));
ok('a row of a listed property shows the listing\'s tags', JSON.stringify(await rowTags('pt_1')) === '["Resale","Plot","Sea view"]', JSON.stringify(await rowTags('pt_1')));
ok('a row with no listing shows its own', JSON.stringify(await rowTags('pt_2')) === '["Collab"]', JSON.stringify(await rowTags('pt_2')));
await p.evaluate(() => window.applyListingsSnapshot(window.trackApi.listings().map(l => l.id === 'a' ? { ...l, tags: [...l.tags, 'Lake view'] } : l))); await p.waitForTimeout(250);
ok('a listing changed by someone else shows here at once', (await rowTags('pt_1')).includes('Lake view'), JSON.stringify(await rowTags('pt_1')));
await p.evaluate(() => window.applyListingsSnapshot(window.trackApi.listings().map(l => l.id === 'a' ? { ...l, tags: l.tags.filter(t => t !== 'Lake view') } : l))); await p.waitForTimeout(250);
await p.evaluate(() => pgFiltersToggle()); await settle();
const tagBtns = await p.$$eval('.pg-fgroup .pg-ftag', t => t.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
ok('Filters has a Tags group with counts', tagBtns.includes('Collab 1') && tagBtns.includes('Resale 1') && tagBtns.includes('Plot 1'), JSON.stringify(tagBtns));
await p.click('.pg-fgroup .pg-ftag:has-text("Collab")'); await settle();
const sheetIds = () => p.$$eval('.ps-row[id^="pg-"]', r => r.map(e => e.id.slice(3)).sort().join(','));
ok('picking a tag filters the sheet', await sheetIds() === 'pt_2', await sheetIds());
ok('…and shows as a removable chip', /Tag: Collab/.test(await p.$eval('.pg-active', e => e.textContent)));
await p.click('.pg-fgroup .pg-ftag:has-text("Plot")'); await settle();
ok('two tags show either', await sheetIds() === 'pt_1,pt_2', await sheetIds());
await p.evaluate(() => pgClearFilters()); await settle();

// Every view shows them, and they can be added from the Sheet row, a week tile and the Edit dialog.
await p.evaluate(s => window.applyPostingSnapshot(s), [...PT, { id: 'pt_3', tenantId: T, repostOf: 'pt_1', reference: 'Velachery flat — again', channels: {}, createdAt: NOW - 1e6, updatedAt: NOW }].map(t => ({ ...t, plannedDate: new Date(new Date().setHours(0, 0, 0, 0)).getTime(), channels: { igStory: { status: 'scheduled', at: Date.now() + 3600000 } } })));
await p.evaluate(() => pgMode('sheet')); await p.waitForTimeout(400);
ok('Sheet: each row shows its tags and a "+ Tag" button (no box on every row)', !!(await p.$('#pg-pt_2 .ps-tags .tg-plus')) && !(await p.$('#pg-pt_2 .ps-tags .tg-in')));
await p.click('#pg-pt_2 .ps-tags .tg-plus'); await p.waitForTimeout(150);
ok('…"+ Tag" opens the box, ready to type', await p.evaluate(() => document.activeElement && document.activeElement.matches('#pg-pt_2 .ps-tags .tg-in')));
await p.type('#pg-pt_2 .ps-tags .tg-in', 'Gated'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
ok('…adding there saves the row\'s tags and keeps the box ready', (await p.evaluate(() => window.__posts[window.__posts.length - 1].t.tags)).includes('Gated') && await p.evaluate(() => document.activeElement && document.activeElement.closest('#pg-pt_2') !== null));
await p.click('#pg-pt_3 .ps-tags .tg-plus'); await p.waitForTimeout(120);
await p.keyboard.type('Second round'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
ok('a repost row tags its property (the original\'s listing), and the box stays in the repost\'s row', (await lst('a')).tags.includes('Second round') && await p.evaluate(() => !!(document.activeElement && document.activeElement.closest('#pg-pt_3'))), await p.evaluate(() => (document.activeElement.closest('[id^="pg-"]') || {}).id));
const wkTags = await p.$$eval('.wk-it', t => t.map(e => [...e.querySelectorAll('.tk-tag')].map(x => x.textContent).join('+')).filter(Boolean));
ok('the week strip tiles show their property\'s tags', wkTags.some(x => /Resale/.test(x)) && wkTags.some(x => /Gated/.test(x)), JSON.stringify(wkTags));
await p.evaluate(() => document.querySelector('.wk-it')?.click()); await p.waitForTimeout(250);
ok('a week tile\'s dialog has the tag picker', await p.evaluate(() => document.getElementById('pgModal').classList.contains('open') && !!document.querySelector('#pgModal .qk-tags .tg-in')));
const qkTarget = await p.$eval('#pgModal .qk-tags .tg', e => e.dataset.tg);
await p.type('#pgModal .qk-tags .tg-in', 'Lakeside'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
ok('…adding there shows in the dialog at once, and the dialog stays open', (await p.$$eval('#pgModal .qk-tags .tg-t', t => t.map(e => e.textContent))).includes('Lakeside') && await p.evaluate(() => document.getElementById('pgModal').classList.contains('open')), qkTarget);
await p.keyboard.press('Escape'); await p.evaluate(() => pgClose && pgClose()); await p.waitForTimeout(200);
await p.evaluate(() => pgOpenEdit('pt_2')); await p.waitForTimeout(250);
ok('the Edit dialog has the tag picker', !!(await p.$('#pgModal .tg .tg-in')));
await p.type('#pgModal .tg .tg-in', 'Corner'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
ok('…adding there saves and shows in the dialog', (await p.$$eval('#pgModal .tg .tg-t', t => t.map(e => e.textContent))).includes('Corner') && (await p.evaluate(() => window.__posts[window.__posts.length - 1].t.tags)).includes('Corner'));
await p.fill('#pgNote', 'unsaved note');
await p.type('#pgModal .tg .tg-in', 'Xy'); await p.keyboard.press('Escape'); await p.waitForTimeout(150);
ok('Escape in the tag box clears it — the dialog (and what was typed in it) stays', await p.evaluate(() => document.getElementById('pgModal').classList.contains('open')) && await p.$eval('#pgModal .tg .tg-in', i => i.value) === '' && await p.$eval('#pgNote', i => i.value) === 'unsaved note');
// Typing on straight after Enter: nothing is lost while the page redraws.
await p.type('#pgModal .tg .tg-in', 'Alpha'); await p.keyboard.press('Enter'); await p.keyboard.type('Beta'); await p.waitForTimeout(200);
ok('keys typed right after Enter land in the box', await p.$eval('#pgModal .tg .tg-in', i => i.value) === 'Beta', await p.$eval('#pgModal .tg .tg-in', i => i.value));
await p.$eval('#pgModal .tg .tg-in', i => { i.value = ''; });
await p.evaluate(() => pgClose()); await p.waitForTimeout(200);
await p.evaluate(() => pgMode('today')); await p.waitForTimeout(300);
ok('Today shows the tags too', /Corner/.test(await p.$eval('#postingView', e => e.textContent)));
await p.evaluate(() => pgMode('cards')); await p.waitForTimeout(400);
ok('Properties: each property has its tags and "+ Tag"', !!(await p.$('#pf-pt_1 .pf-tags .tg-plus')) && !!(await p.$('#pf-pt_2 .pf-tags .tg-plus')));
const addIn = async (sel, text) => { if (!(await p.$(sel + ' .tg-in'))) await p.click(sel + ' .tg-plus'); await p.waitForTimeout(100); await p.type(sel + ' .tg-in', text); await p.keyboard.press('Enter'); await p.waitForTimeout(300); };
await addIn('#pf-pt_1 .pf-tags', 'Collab');
ok('tagging a listed property here tags the listing itself (one set of tags)', (await lst('a')).tags.includes('Collab'), JSON.stringify((await lst('a')).tags));
ok('…and shows at once here, with the box open and empty for the next one', (await p.$$eval('#pf-pt_1 .pf-tags .tk-tag', t => t.map(e => e.textContent.replace('✕', '').trim()))).includes('Collab') && await p.$eval('#pf-pt_1 .pf-tags .tg-in', i => i.value) === '');
await p.evaluate(() => { toggleView('board'); }); await settle();
ok('…the board tile shows it', (await tileTags('a')).includes('Collab'));
await p.evaluate(() => { toggleView('posting'); pgMode('cards'); }); await p.waitForTimeout(400);
await addIn('#pf-pt_2 .pf-tags', 'Plot');
const lastPost = await p.evaluate(() => window.__posts[window.__posts.length - 1]);
ok('tagging a property with no listing saves on its Posting row, only the tags', lastPost && lastPost.t.id === 'pt_2' && lastPost.t.tags.includes('Plot') && lastPost.t.tags.includes('Collab') && JSON.stringify(lastPost.paths) === '["tags"]', JSON.stringify(lastPost));
await addIn('#pf-pt_2 .pf-tags', '<b>R&D</b>');
ok('a tag with symbols shows as typed — in its chip and in the Undo note', (await p.$$eval('#pf-pt_2 .pf-tags .tg-t', t => t.map(e => e.textContent))).includes('<b>R&D</b>') && /Tag added: <b>R&D<\/b>/.test(await p.$eval('#pgUndo', e => e.textContent)), await p.$eval('#pgUndo', e => e.textContent));
ok('no page errors', !errs.length, errs.join(' | '));

console.log('On a phone');
const ph = await open(390);
await ph.p.evaluate(() => openDetail('a')); await ph.p.waitForTimeout(300);
ok('the picker fits a 390px screen (no sideways scroll)', await ph.p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
await ph.p.focus('#dpBody .tg-in'); await ph.p.waitForTimeout(200);
ok('…its suggestions stay on screen', await ph.p.$eval('#dpBody .tg-sug.open', e => e.getBoundingClientRect().right <= innerWidth));
await ph.p.evaluate(() => { closeDetail(); toggleView('posting'); pgMode('cards'); }); await ph.p.waitForTimeout(400);
ok('Posting Properties with tags fits too', await ph.p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
// The longest tag allowed: its ✕ stays inside the chip, and the filter button cannot push the page sideways.
const LONG = 'W'.repeat(32);
await ph.p.evaluate(l => window.trackApi.mutate('c', x => { x.tags = [l]; }), LONG); await ph.p.waitForTimeout(200);
await ph.p.evaluate(() => { toggleView('board'); openDetail('c'); }); await ph.p.waitForTimeout(300);
ok('a 32-character tag keeps its ✕ visible on a phone', await ph.p.evaluate(() => { const chip = document.querySelector('#dpBody .tg .tk-tag'), x = chip.querySelector('.tg-x'); const c = chip.getBoundingClientRect(), r = x.getBoundingClientRect(); return r.width > 0 && r.right <= c.right + 1 && c.right <= innerWidth; }));
await ph.p.evaluate(() => { closeDetail(); toggleView('posting'); pgMode('sheet'); pgFiltersToggle(); }); await ph.p.waitForTimeout(400);
ok('…and in Posting Filters it does not make the page scroll sideways', await ph.p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), await ph.p.evaluate(() => document.documentElement.scrollWidth));
ok('no page errors on the phone', !ph.errs.length, ph.errs.join(' | '));

await b.close();
if (fails) { console.log(`\n${fails} failed`); process.exit(1); }
console.log('\nAll good.');
