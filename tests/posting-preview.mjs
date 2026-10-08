// Posting tracker smoke test: the real propertytrack.html, Firebase swapped for an in-memory stand-in.
//   node tests/posting-preview.mjs <out-dir>
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStages } from '../track-assets/track-pipeline.js';

const OUT = process.argv[2] || 'tests/out/posting';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.now(), H = 3600000, T = 't_3pinrealty';
const INV = [
  { id: 'TNAG0002', propertyCode: 'TNAG0002', name: '2BHK Apartment T Nagar', location: 'T Nagar', photosLink: 'https://drive.google.com/x', detailsText: '2BHK, 1100 sqft' },
  { id: 'VLCA002', propertyCode: 'VLCA002', name: 'Velachery 3BHK', location: 'Velachery' }
];
const mk = o => ({ tenantId: T, channels: {}, brochure: { done: false }, acres99: { status: 'pending' }, website: { status: 'pending' }, ...o });
const TRACKERS = [
  mk({ id: 'TNAG0002', propertyCode: 'TNAG0002', title: '2BHK T Nagar', location: 'T Nagar', photosLink: 'https://drive.google.com/x', details: 'text', propertyId: 'TNAG0002',
    channels: { igReel: { status: 'scheduled', at: NOW - 2 * H }, igStory: { status: 'live', at: NOW - 5 * H, liveAt: NOW - 5 * H, url: '' }, fbReel: { status: 'scheduled', at: NOW + 26 * H }, yt: { status: 'na' } } }),
  mk({ id: 'VLCA002', propertyCode: 'VLCA002', title: 'Velachery 3BHK', location: 'Velachery' })
];
const STUB = `
window.__saved = []; window.__deleted = []; window.__paths = [];
window.trackFirebase = {
  // Same shapes as firebase-sync: savePosting(t, paths?) and savePostings([{ t, paths? }]).
  savePosting: async (t, paths) => { window.__saved.push(JSON.parse(JSON.stringify(t))); window.__paths.push(paths || null); },
  savePostings: async ws => { for (const w of ws) { window.__saved.push(JSON.parse(JSON.stringify(w.t))); window.__paths.push(w.paths || null); } },
  deletePosting: async id => { window.__deleted.push(id); },
  saveListing: async () => {}, savePipeline: async () => {}, patchLead: async () => {},
  getInventory: async () => ${JSON.stringify(INV)}, getListingHistory: async () => [], saveHistory: async () => {}, deleteHistory: async () => {}, getLeadConversation: async () => null
};
window.trackAuth = { login: async () => {}, logout: async () => {}, getTenantId: () => '${T}' };
setTimeout(() => {
  window.onTrackAuthChange({ email: 'admin@example.com' }, '${T}');
  window.applyTrackPipelineSnapshot(${JSON.stringify(defaultStages())});
  window.applyListingsSnapshot([]); window.applyTrackLeadsSnapshot([]);
  window.applyPostingSnapshot(${JSON.stringify(TRACKERS)});
  window.__ready = true;
}, 0);`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const browser = await chromium.launch();
const errors = [];
const ok = (l, c, d) => { if (c) console.log('  ok  ' + l); else errors.push(l + (d !== undefined ? ' — ' + d : '')); };

async function open(viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${viewport.width}px: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|posting save failed/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('dialog', d => d.accept());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'track.local') return route.abort();
    if (url.pathname === '/track-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://track.local/propertytrack.html?nav=posting');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.waitForSelector('.pg-bar', { timeout: 5000 }).catch(async e => { console.log('DEBUG', await page.evaluate(() => ({ v: document.getElementById('postingView').style.display, h: document.getElementById('postingView').innerHTML.slice(0, 200), r: typeof window.renderPosting, a: typeof window.applyPostingSnapshot }))); throw e; });
  return page;
}
const saved = p => p.evaluate(() => window.__saved.slice(-1)[0]);

for (const [name, vp] of [['desk', { width: 1440, height: 950 }], ['phone', { width: 390, height: 844 }]]) {
  console.log(name);
  const p = await open(vp);
  const mode = async m => { await p.click('.pg-bar .tk-sbtn:nth-child(' + m + ')'); await p.waitForTimeout(80); };
  // Filters live behind one button now.
  const openFilters = async () => { if (!(await p.$('.pg-fbtns'))) await p.click('.pg-fbtn'); };
  // ── Today is the landing view ──
  ok('Opens on Today', /Today/.test(await p.textContent('.pg-bar .tk-sbtn.on')));
  const kpis = await p.$$eval('.kpi', k => k.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  ok('Four counts on top: due, today, link missing, type not decided', kpis.length === 4 && /^1s*Due now/.test(kpis[0]) && /Live, link missing/.test(kpis[2]), JSON.stringify(kpis));
  ok('The Today tab number is the urgent count, in red', !!(await p.$('.pg-bar .tk-sbtn.on .tk-n.hot')));
  const nowTags = await p.$$eval('#pg-now .pt-tag', t => t.map(x => x.textContent));
  ok('Needs you now: one flat list with a tag saying what is wrong', nowTags.length >= 1 && nowTags.includes('Brochure needed'), JSON.stringify(nowTags));
  const todayRows = await p.$$eval('#pg-today .pt-row', r => r.map(x => x.textContent.replace(/\s+/g, ' ')));
  ok("Today lists today's posts with their type", todayRows.some(r => /Reel/.test(r) && /Due/.test(r)), JSON.stringify(todayRows));
  ok('A post due today is not listed twice', !nowTags.includes('Overdue'));
  ok('Routine work is folded away under "Everything else"', !!(await p.$('details.pt-later:not([open])')) && /Everything else/.test(await p.textContent('.pt-later summary')));
  await p.screenshot({ path: OUT + '/' + name + '-today.png', fullPage: true });
  // one click from Today does the job, with Undo
  await p.click('#pg-now .pt-now:has-text("2BHK T Nagar") button:has-text("Mark brochure created")');
  let s0 = await p.evaluate(() => window.__saved.slice(-1)[0]);
  ok('Marking brochure from Today saves it', s0.id === 'TNAG0002' && s0.brochure.done === true);
  ok('…writing only the brochure field', JSON.stringify(await p.evaluate(() => window.__paths.slice(-1)[0])) === '["brochure"]', JSON.stringify(await p.evaluate(() => window.__paths.slice(-1)[0])));
  ok('…offers Undo', /Undo/.test(await p.textContent('#pgUndo')));
  await p.click('#pgUndo button');
  s0 = await p.evaluate(() => window.__saved.slice(-1)[0]);
  ok('Undo puts it back', s0.id === 'TNAG0002' && s0.brochure.done === false);
  await p.click('#pg-now .pt-now:has-text("2BHK T Nagar") button:has-text("Mark brochure created")');
  ok('…and it leaves the list', !(await p.$('#pg-now .pt-now:has-text("Brochure needed"):has-text("2BHK T Nagar")')));
  // everything else, unfolded
  await p.click('.pt-later summary');
  await p.click('.pt-later .tk-group:has(.tk-group-hdr:text("Schedule the posts")) .pg-task:has-text("VLCA002") .pg-pair:has-text("YouTube") button:has-text("N/A")');
  s0 = await p.evaluate(() => window.__saved.slice(-1)[0]);
  ok('N/A on one channel from "Everything else"', s0.channels.yt.status === 'na' && s0.channels.igReel.status === 'yet');
  ok('"Everything else" stays open after a change', !!(await p.$('details.pt-later[open]')));
  // Mark live from Today: paste helper + wrong-platform warning
  await p.click('#pg-today .pt-row:has-text("Reel") button:has-text("Mark live")');
  await p.fill('#pgUrl', 'https://youtu.be/oops'); await p.dispatchEvent('#pgUrl', 'input');
  ok('A YouTube link on an Insta Reel gets a warning', /YouTube link — this one is for Insta Reel/.test(await p.textContent('#pgUrlHint')));
  await p.fill('#pgUrl', 'instagram.com/reel/ok'); await p.dispatchEvent('#pgUrl', 'input');
  ok('…the right link gets a tick', /✓ Instagram link/.test(await p.textContent('#pgUrlHint')));
  ok('There is a "Paste copied link" button', !!(await p.$('.pg-pasterow button')));
  await p.keyboard.press('Escape');
  // the week tile quick menu
  await p.click('.wk-day.today .wk-it.ws-due');
  ok('Clicking a due tile opens its actions', /Mark live/.test(await p.textContent('.qk-acts')) && /Reel/.test(await p.textContent('#pgTitle')));
  await p.keyboard.press('Escape');
  // overview
  await mode(3);
  ok('List has a line per property', (await p.$$('.ps-row')).length === 2);
  ok('List flags due and no-link cells', (await p.$$('.ps-cell.hot')).length >= 2);
  const wide0 = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('List does not scroll sideways', wide0 <= 2, wide0);
  await p.screenshot({ path: OUT + '/' + name + '-list.png', fullPage: true });
  // edit straight from the list
  await p.selectOption('#pg-VLCA002 select[aria-label="YouTube status"]', 'na');
  ok('List: change a status in place', (await p.evaluate(() => window.__saved.slice(-1)[0])).channels.yt.status === 'na');
  await p.selectOption('#pg-VLCA002 select[aria-label="Insta Reel status"]', 'scheduled');
  await p.fill('#pgAt', '2031-02-02T10:00'); await p.click('#pgSave');
  ok('List: scheduling opens the same dialog and saves', (await p.evaluate(() => window.__saved.slice(-1)[0])).channels.igReel.status === 'scheduled');
  await p.check('#pg-VLCA002 .pg-ck input');
  ok('List: tick the brochure', (await p.evaluate(() => window.__saved.slice(-1)[0])).brochure.done === true);
  await p.selectOption('#pg-TNAG0002 select[aria-label="99 Acres status"]', 'na');
  ok('List: 99 Acres N/A', (await p.evaluate(() => window.__saved.slice(-1)[0])).acres99.status === 'na');
  await p.selectOption('#pg-VLCA002 select[aria-label="Facebook Reel status"]', 'live'); await p.click('#pgSave');
  ok('List: live without a link is flagged in the cell', !!(await p.$('#pg-VLCA002 .ps-cell.hot')));
  await p.click('#pg-VLCA002 .pg-warnbtn'); await p.fill('#pgUrl', 'facebook.com/reel/zz'); await p.press('#pgUrl', 'Enter');
  ok('List: add the missing link', (await p.evaluate(() => window.__saved.slice(-1)[0])).channels.fbReel.url === 'https://facebook.com/reel/zz' && !(await p.$('#pg-VLCA002 .ps-cell.hot')));
  await p.click('#pg-VLCA002 .ps-dot >> nth=0');
  ok('List: photos/details chip opens the editor', await p.$eval('#pgTitle', e => /details/i.test(e.textContent)));
  await p.keyboard.press('Escape');
  await p.click('#pg-VLCA002 .ps-edit');
  ok('List: Edit opens the editor', await p.$eval('#pgModal', e => e.classList.contains('open')));
  await p.keyboard.press('Escape');
  await openFilters();
  await p.click('.pg-f:has-text("Link missing")');
  ok('List: filters apply here too', (await p.$$('.ps-row')).length <= 1);
  await p.click('.pg-active .tk-link');
  await p.screenshot({ path: OUT + '/' + name + '-list2.png', fullPage: true });
  await mode(4);
  ok('Two property cards', (await p.$$('.pg-card')).length === 2);
  ok('Attention card sorts first', await p.$eval('.pg-card', c => c.classList.contains('attention')));
  ok('Due reel is flagged', /due — confirm posted/.test(await p.$eval('.pg-card', c => c.textContent)));
  ok('Live story without a link warns', /link not shared/.test(await p.$eval('.pg-card', c => c.textContent)));
  ok('Nav badge counts attention', (await p.$$eval('.rl-badge', e => e.map(x => x.textContent))).includes('1'));
  const wide = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('No sideways scroll', wide <= 2, wide + ' ' + JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('#postingView *')].filter(e => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 4).map(e => e.tagName + '.' + e.className + ':' + Math.round(e.getBoundingClientRect().right)))));
  await p.screenshot({ path: `${OUT}/${name}-cards.png`, fullPage: true });

  const card2 = '#pg-VLCA002';
  const cardOrder = (await p.$$eval('.pg-card', c => c.map(x => x.id))).join();
  await p.selectOption(`${card2} select[aria-label="Insta Reel status"]`, 'scheduled');
  ok('Scheduling opens the dialog', await p.$eval('#pgModal', e => e.classList.contains('open')));
  await p.fill('#pgAt', '2030-01-02T10:30');
  await p.click('#pgSave');
  let s = await saved(p);
  ok('Saved as scheduled with a time', s.id === 'VLCA002' && s.channels.igReel.status === 'scheduled' && s.channels.igReel.at > NOW, JSON.stringify(s.channels.igReel));
  ok('Other channels stay independent', s.channels.igStory.status === 'yet');

  await p.selectOption(`${card2} select[aria-label="Insta Reel status"]`, 'live');
  await p.click('#pgSave');
  s = await saved(p);
  ok('Live without link is saved', s.channels.igReel.status === 'live' && s.channels.igReel.url === '');
  ok('…and flagged', /Live — link not shared/.test(await p.$eval(card2, c => c.textContent)));
  await p.click(`${card2} .pg-warnbtn`);
  await p.fill('#pgUrl', 'https://instagram.com/reel/abc');
  await p.click('#pgSave');
  s = await saved(p);
  ok('Link saved, flag gone', s.channels.igReel.url.includes('instagram') && !/Live — link not shared/.test(await p.$eval(card2, c => c.textContent)));

  ok('Card order holds while editing', (await p.$$eval('.pg-card', c => c.map(x => x.id))).join() === cardOrder, cardOrder);
  await p.check(`${card2} .pg-brochure input`);
  s = await saved(p);
  ok('Brochure ticked records who', s.brochure.done && s.brochure.by === 'admin@example.com');

  await p.selectOption(`${card2} select[aria-label="99 Acres status"]`, 'na');
  s = await saved(p);
  ok('99 Acres N/A', s.acres99.status === 'na');

  await p.click(`${card2} .pg-dash .tk-btn`);
  s = await saved(p);
  ok('Linked to dashboard from the code match', s.propertyId === 'VLCA002');

  await mode(2);
  const rows = await p.$$eval('.tk-row', r => r.length);
  ok('Week lists scheduled posts', rows >= 2, rows);
  ok('Due group first', /Due now/.test(await p.$eval('.tk-group-hdr', e => e.textContent)));
  await p.screenshot({ path: `${OUT}/${name}-queue.png`, fullPage: true });
  await mode(4);

  await openFilters();
  await p.click('.pg-f:has-text("Link missing")');
  ok('Filter narrows to one', (await p.$$('.pg-card')).length === 1 && /Clear all/.test(await p.textContent('.pg-active')));
  await p.click('.pg-active .tk-link');

  await p.click('.pg-bar-r button:has-text("Add property")');
  await p.fill('#pgCode', 'new 001'); await p.fill('#pgTitleIn', 'Test plot');
  await p.click('#pgSave');
  s = await saved(p);
  ok('Added by hand, unlinked, under its own id (not the code)', /^pt_/.test(s.id) && /new 001/i.test(s.propertyCode) && !s.propertyId, s.id);
  ok('…written whole, as a new row', (await p.evaluate(() => window.__paths.slice(-1)[0])) === null);
  ok('Unlinked shows as pending', /Not in Property dashboard yet/.test(await p.$eval('.pg-grid', g => g.textContent)));
  await p.screenshot({ path: `${OUT}/${name}-after.png`, fullPage: true });
  await p.close();
}

// ── More scenarios (desktop) ──
console.log('scenarios');
{
  const p = await open({ width: 1440, height: 950 });
  const last = () => p.evaluate(() => window.__saved.slice(-1)[0]);
  const count = () => p.evaluate(() => window.__saved.length);
  await p.click('.pg-bar .tk-sbtn:nth-child(4)');
  const card = '#pg-TNAG0002';

  // bad link refused inside the dialog, nothing saved
  const n0 = await count();
  await p.click(card + ' .pg-warnbtn');
  await p.fill('#pgUrl', 'posted already');
  await p.click('#pgSave');
  ok('A bad link is refused with a message and nothing is saved', /web link/.test(await p.textContent('#pgErr')) && (await count()) === n0 && await p.$eval('#pgModal', e => e.classList.contains('open')));
  await p.fill('#pgUrl', 'instagram.com/stories/x');
  await p.press('#pgUrl', 'Enter');
  ok('Enter confirms, and a bare domain is accepted with https added', (await last()).channels.igStory.url === 'https://instagram.com/stories/x');

  // escape closes the dialog without saving
  const n1 = await count();
  await p.selectOption(card + ' select[aria-label="Facebook Reel status"]', 'live');
  await p.keyboard.press('Escape');
  ok('Escape closes the dialog without saving', !(await p.$eval('#pgModal', e => e.classList.contains('open'))) && (await count()) === n1);
  ok('…and the select snaps back to what is saved', await p.$eval(card + ' select[aria-label="Facebook Reel status"]', e => e.value) === 'scheduled');

  // scheduling without a time
  await p.selectOption(card + ' select[aria-label="YouTube status"]', 'scheduled');
  await p.fill('#pgAt', '');
  await p.click('#pgSave');
  ok('Scheduling without a time is refused', /date and time/.test(await p.textContent('#pgErr')));
  await p.keyboard.press('Escape');

  // reschedule a due post
  await p.selectOption(card + ' select[aria-label="Insta Reel status"]', 'scheduled');
  await p.fill('#pgAt', '2031-05-05T09:00');
  await p.click('#pgSave');
  ok('Rescheduling clears the due flag', !/due — confirm/.test(await p.textContent(card)));

  // edit details: note + photos link
  await p.click(card + ' .pg-inputs .tk-link');
  await p.fill('#pgNote', 'CEO: Reel Friday 6pm');
  await p.fill('#pgPhotos', 'not a link');
  await p.click('#pgSave');
  ok('A bad photos link is refused', /web link/.test(await p.textContent('#pgErr')));
  await p.fill('#pgPhotos', 'drive.google.com/drive/folders/abc');
  await p.click('#pgSave');
  const ed = await last();
  ok('Notes and a cleaned photos link are saved', ed.note === 'CEO: Reel Friday 6pm' && ed.photosLink === 'https://drive.google.com/drive/folders/abc');
  ok('The note shows on the card', /CEO: Reel Friday 6pm/.test(await p.textContent(card)));

  // search finds by note
  await p.fill('#searchInput', 'friday 6pm');
  await p.waitForTimeout(100);
  ok('Search finds a property by its note', (await p.$$('.pg-card')).length === 1);
  await p.fill('#searchInput', 'zzzz');
  await p.waitForTimeout(100);
  ok('No match says so', /Nothing matches/.test(await p.textContent('#postingView')));
  await p.fill('#searchInput', '');
  await p.waitForTimeout(100);

  // unlink and re-link
  await p.click(card + ' .pg-dash .tk-link');
  ok('Unlinking saves and marks it pending', (await last()).propertyId === '' && /Not in Property dashboard yet/.test(await p.textContent(card)));
  await p.click(card + ' .pg-dash .tk-btn');
  ok('Re-linking from the code match', (await last()).propertyId === 'TNAG0002');

  // add from the dashboard list; blank-code legacy rows are not offered; duplicates blocked
  await p.click('.pg-bar-r button:has-text("Add property")');
  await p.waitForSelector('#pgPickList .tk-pick');
  ok('Dashboard list is offered', (await p.$$('#pgPickList .tk-pick')).length >= 1);
  ok('A property already tracked is not pickable', await p.$eval('#pgPickList .tk-pick:has-text("TNAG0002")', e => e.disabled));
  await p.fill('#pgSearch', 'zzz');
  ok('Search with no result says so', /Nothing in the dashboard/.test(await p.textContent('#pgPickList')));
  await p.fill('#pgCode', 'tnag0002');
  await p.click('#pgSave');
  ok('Adding a duplicate code is refused', /already tracked/.test(await p.textContent('#pgErr')));
  await p.fill('#pgCode', '');
  await p.click('#pgSave');
  ok('Adding with no code is refused', /code/.test(await p.textContent('#pgErr')));
  await p.keyboard.press('Escape');

  // Add schedule: several entries, each on its own day
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.click('.pg-bar-r button:has-text("Add schedule")');
  ok('Add schedule opens with one entry dated today', (await p.$$('#pgBulkList .bk-row')).length === 1 && !!(await p.$eval('#pgBulkList .bk-day', e => e.value)));
  await p.fill('#pgBulkList .bk-in', 'tna');
  ok('Typing suggests tracked properties', !!(await p.$('.bk-sug.open .bk-opt:has-text("TNAG0002")')));
  await p.click('.bk-opt:has-text("TNAG0002")');
  await p.click('#pgBulkList .bk-row:nth-child(1) .bk-type:has-text("Story")');
  await p.click('.bk-more');
  ok('Another entry starts on the same day with the same types', await p.$eval('#pgBulkList .bk-row:nth-child(2) .bk-day', e => e.value) === await p.$eval('#pgBulkList .bk-row:nth-child(1) .bk-day', e => e.value) && !!(await p.$('#pgBulkList .bk-row:nth-child(2) .bk-type.on:has-text("Story")')));
  await p.fill('#pgBulkList .bk-row:nth-child(2) .bk-in', 'Porur 4BHK');
  ok('A typed name is kept as a new reference', !(await p.$eval('#pgBulkList .bk-row:nth-child(2) .bk-note', e => e.hidden)));
  await p.fill('#pgBulkList .bk-row:nth-child(2) .bk-day', '2030-03-04'); await p.dispatchEvent('#pgBulkList .bk-row:nth-child(2) .bk-day', 'change');
  await p.fill('#pgBulkList .bk-row:nth-child(2) .bk-time', '18:30'); await p.dispatchEvent('#pgBulkList .bk-row:nth-child(2) .bk-time', 'change');
  ok('The button counts posts and days', /Add 2 posts on 2 days/.test(await p.textContent('#pgSave')), await p.textContent('#pgSave'));
  const nBefore = await count();
  await p.click('#pgSave');
  const added = (await p.evaluate(() => window.__saved)).slice(nBefore);
  const porur = added.find(r => r.reference === 'Porur 4BHK');
  ok('Both entries saved', added.length === 2, added.length);
  ok('…the reference on its own day, scheduled at 6:30pm', porur && porur.channels.igStory.status === 'scheduled' && new Date(porur.channels.igStory.at).getHours() === 18 && new Date(porur.plannedDate).getFullYear() === 2030);
  ok('…and Undo is offered for the whole batch', /added across 2 days/.test(await p.textContent('#pgUndo')));

  // delete
  await p.click(card + ' .pg-inputs .tk-link');
  await p.click('text=Delete this property');
  ok('Delete removes the tracker', (await p.evaluate(() => window.__deleted)).includes('TNAG0002') && !(await p.$(card)));

  // a failed save tells the user
  await p.evaluate(() => { window.trackFirebase.savePosting = async () => { throw new Error('offline'); }; });
  await p.check('#pg-VLCA002 .pg-brochure input');
  await p.waitForTimeout(150);
  ok('A failed save shows a message', /Could not save/.test(await p.textContent('#toast')));
  await p.evaluate(() => { window.trackFirebase.savePosting = async (t, paths) => { window.__saved.push(JSON.parse(JSON.stringify(t))); window.__paths.push(paths || null); }; });

  // N/A from a week tile's quick menu closes the menu
  await p.evaluate(() => window.pgTile('VLCA002', 'igStory', 'planned'));
  await p.click('.qk-acts button:has-text("N/A")');
  ok('N/A from a week tile closes its quick menu', !(await p.$eval('#pgModal', e => e.classList.contains('open'))) && (await last()).channels.igStory.status === 'na');

  // half-typed text in the Sheet survives someone else's save
  await p.click('.pg-bar .tk-sbtn:nth-child(3)');
  await p.fill('#pg-VLCA002 .pg-name', 'half typed');
  await p.evaluate(rows => window.applyPostingSnapshot(rows), [{ ...TRACKERS[0], note: 'from the server' }, TRACKERS[1],
    mk({ id: 'q\'"<x>', reference: 'Quote row', photosLink: 'javascript:alert(1)' })]);
  ok('A snapshot while typing does not wipe the text', (await p.$eval('#pg-VLCA002 .pg-name', e => e.value)) === 'half typed' && !/from the server/.test(await p.textContent('#postingView')));
  await p.evaluate(() => document.activeElement.blur());
  await p.waitForTimeout(80);
  ok('…the page catches up once focus leaves', /from the server/.test(await p.textContent('#postingView')));

  // ids with quotes still work in every button, and a javascript: link is never clickable
  await p.click('.ps-row:has-text("Quote row") .ps-edit');
  ok('A row id with quotes in it opens its editor', (await p.$eval('#pgRefIn', e => e.value)) === 'Quote row');
  await p.keyboard.press('Escape');
  await p.click('.pg-bar .tk-sbtn:nth-child(4)');
  ok('A javascript: photos link is not rendered as a link', (await p.$$('a[href^="javascript"]')).length === 0 && /not a web link/.test(await p.textContent('#postingView')));

  // window.refreshPosting (what app.js calls on every CRM snapshot) respects the guards
  const ROWS = [mk({ id: 'R1', propertyCode: 'R1', title: 'Row one' }), mk({ id: 'R2', propertyCode: 'R2', title: 'Row two', note: 'first note' })];
  const snap = rows => p.evaluate(rows => window.applyPostingSnapshot(rows), rows);
  await snap(ROWS);
  await p.click('.pg-bar .tk-sbtn:nth-child(3)');
  const mark = () => p.evaluate(() => { document.querySelector('#pg-R1 .pg-name').__mark = 1; });
  const marked = () => p.evaluate(() => !!(document.querySelector('#pg-R1 .pg-name') || {}).__mark);
  await mark();
  await p.evaluate(() => window.refreshPosting());
  ok('refreshPosting with nothing changed does not redraw', await marked());
  await p.focus('#pg-R1 .pg-name');
  await p.evaluate(() => { window.__q = window.trackSearchText; window.trackSearchText = () => 'zzzz'; window.refreshPosting(); });
  ok('refreshPosting waits while a Sheet field has focus', (await marked()) && (await p.$eval('#pg-R1 .pg-name', e => e === document.activeElement)));
  await p.evaluate(() => document.activeElement.blur());
  await p.waitForTimeout(80);
  ok('…and redraws for the new search once focus leaves', /Nothing matches/.test(await p.textContent('#postingView')));
  await p.evaluate(() => { window.trackSearchText = window.__q; window.refreshPosting(); });
  ok('…and again when the search is cleared', !!(await p.$('#pg-R1')));
  await p.evaluate(() => window.pgOpenEdit('R1'));
  await p.evaluate(() => { window.trackSearchText = () => 'zzzz'; window.refreshPosting(); window.trackSearchText = window.__q; });
  ok('refreshPosting does nothing while a dialog is open', !!(await p.$('#pg-R1')) && await p.$eval('#pgModal', e => e.classList.contains('open')));
  await p.keyboard.press('Escape');

  // Edit dialog: a field changed by someone else while it was open is not written back
  await p.evaluate(() => window.pgOpenEdit('R2'));
  await snap([ROWS[0], { ...ROWS[1], note: 'changed elsewhere' }]);
  await p.fill('#pgTitleIn', 'Row two, renamed');
  await p.click('#pgSave');
  const e2 = await last();
  ok('Edit saves only the field changed in the form', e2.title === 'Row two, renamed' && e2.note === 'changed elsewhere' && JSON.stringify(await p.evaluate(() => window.__paths.slice(-1)[0])) === '["title"]',
    JSON.stringify([e2.note, await p.evaluate(() => window.__paths.slice(-1)[0])]));

  // a redraw that was waiting does not swallow the click that moves focus away
  await p.click('.pg-bar .tk-sbtn:nth-child(3)');
  const fOpen = !!(await p.$('.pg-fbtns'));
  await p.focus('#pg-R1 .pg-name');
  await snap([ROWS[0], { ...ROWS[1], title: 'Row two from server' }]);
  // A person's click: press, hold a moment, release (a redraw in between used to eat it).
  const fb = await p.$eval('.pg-fbtn', e => { const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
  await p.mouse.move(fb[0], fb[1]); await p.mouse.down(); await p.waitForTimeout(60); await p.mouse.up();
  await p.waitForTimeout(80);
  ok('A click that moves focus out of the Sheet still lands', !!(await p.$('.pg-fbtns')) !== fOpen);
  ok('…and the waiting redraw happens after it', /Row two from server/.test(await p.textContent('#postingView')));

  // the row was deleted by someone else
  await p.evaluate(() => window.pgOpenEdit('R2'));
  await snap([ROWS[0]]);
  const n2 = await count();
  await p.click('#pgSave');
  ok('Saving a dialog for a row deleted elsewhere says so and writes nothing', /deleted by someone else/.test(await p.textContent('#toast')) && (await count()) === n2 && !(await p.$eval('#pgModal', e => e.classList.contains('open'))));
  await p.evaluate(() => { window.trackFirebase.savePosting = async t => { window.applyPostingSnapshot([]); throw Object.assign(new Error('denied'), { code: 'permission-denied' }); }; });
  await p.click('#pg-R1 .ps-check input');   // click, not check: the row is meant to vanish
  await p.waitForTimeout(100);
  ok('An update refused because the row is gone says it was deleted, not "no permission"', /deleted by someone else/.test(await p.textContent('#toast')) && !(await p.$('#pg-R1')));
  await snap(ROWS);
  await p.evaluate(() => { window.trackFirebase.savePosting = async () => { throw Object.assign(new Error('denied'), { code: 'permission-denied' }); }; });
  await p.click('#pg-R1 .ps-check input');
  await p.waitForTimeout(100);
  ok('…while a real refusal still says no permission', /do not have permission/.test(await p.textContent('#toast')));
  await p.close();
}

// ── 300 rows: an edit draws once, and the heavy views stay usable ──
console.log('300 rows');
{
  const p = await open({ width: 1440, height: 950 });
  const many = [];
  for (let i = 0; i < 300; i++) {
    const ch = {}; ['igStory', 'igReel', 'fbReel', 'yt'].forEach((k, j) => { const r = (i + j) % 4; ch[k] = r === 0 ? { status: 'live', at: NOW - (i % 9) * 864e5, liveAt: NOW - (i % 9) * 864e5, url: 'https://instagram.com/p/' + i } : r === 1 ? { status: 'scheduled', at: NOW + ((i % 7) - 3) * 864e5 } : r === 2 ? { status: 'yet', day: NOW + ((i % 7) - 3) * 864e5 } : { status: 'na' }; });
    many.push(mk({ id: 'm' + i, propertyCode: i % 4 === 3 ? '' : 'M' + i, repostOf: i % 4 === 3 ? 'm' + (i - 1) : '', title: 'Many ' + i, plannedDate: NOW + ((i % 14) - 7) * 864e5, channels: ch }));
  }
  // Like Firestore, every write comes straight back as a snapshot.
  await p.evaluate(rows => {
    let server = rows;
    window.trackFirebase.savePosting = async t => { server = server.map(x => x.id === t.id ? JSON.parse(JSON.stringify(t)) : x); setTimeout(() => window.applyPostingSnapshot(JSON.parse(JSON.stringify(server))), 0); };
    window.applyPostingSnapshot(JSON.parse(JSON.stringify(server)));
  }, many);
  const ms = m => p.evaluate(m => { const t = performance.now(); window.pgMode(m); return performance.now() - t; }, m);
  const times = {};
  for (const m of ['today', 'sheet', 'cards']) { await ms(m); times[m] = Math.min(await ms(m), await ms(m)); }
  console.log('  render ms', JSON.stringify(Object.fromEntries(Object.entries(times).map(([k, v]) => [k, Math.round(v)]))));
  // 800 ms: still well under a second, with headroom for a slower machine. (600 failed now and
  // then on the office PC even before tags — Sheet measured 376–513 there; with tags 470–610.)
  ok('300 rows: every view draws in well under a second', Object.values(times).every(v => v < 800), JSON.stringify(times));
  await p.evaluate(() => { let n = 0; const el = document.getElementById('postingView'); const mo = new MutationObserver(r => { if (r.some(x => x.target === el)) n++; }); mo.observe(el, { childList: true }); window.__draws = () => { mo.disconnect(); return n; }; window.pgBrochure('m1', true); });
  await p.waitForTimeout(300);
  ok('300 rows: an edit draws once (its own echo does not draw again)', (await p.evaluate(() => window.__draws())) === 1);
  await p.evaluate(() => window.pgOpenPlan());
  await p.waitForTimeout(200);
  const plan = await p.evaluate(() => { document.getElementById('pgPlanText').value = 'Monday -S- Lux49\nTuesday - Velachery\nWednesday - Eden\nThursday - Kodambakkam\nFriday -S- Brigade\nSaturday - T nagar\nSunday - Nandanam\nYoutube - series'; window.pgPlanPreview(); const t = performance.now(); window.pgPlanPreview(); return performance.now() - t; });
  console.log('  plan preview ms', Math.round(plan));
  ok('300 rows: the plan preview keeps up with typing', plan < 150, plan);
  await p.close();
}
await browser.close();
if (errors.length) { console.log('\nFAILED:\n - ' + errors.join('\n - ')); process.exit(1); }
console.log('\nAll good.');
