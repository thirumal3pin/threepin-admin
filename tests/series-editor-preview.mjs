// Series (Posting) + the board's series cards + the Editor view, on the real propertytrack.html with
// Firebase swapped for an in-memory stand-in. Desktop and phone, light and dark; screenshots in the out dir.
//   node tests/series-editor-preview.mjs [out-dir]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStages } from '../track-assets/track-pipeline.js';

const OUT = process.argv[2] || 'tests/out/series';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.now(), H = 3600000, DAY = 24 * H, T = 't_3pin';
const day0 = (() => { const d = new Date(NOW); d.setHours(0, 0, 0, 0); return d.getTime(); })();
const ST = defaultStages(), sid = k => ST.find(s => s.key === k).id;
const L = (o) => ({ tenantId: T, media: {}, tags: [], createdAt: NOW - 9 * DAY, updatedAt: NOW - DAY, stageChangedAt: NOW - DAY, ...o });
const LISTINGS = [
  L({ id: 'lA', title: '3BHK T Nagar', propertyCode: 'TNAG0003', stageId: sid('shoot_done'), shootAssignee: 'Ravi', shootAt: NOW - 2 * DAY, shootDoneAt: NOW - 2 * DAY, photosLink: 'https://drive.google.com/a', forPlan: { igReel: true, yt: true }, forVoice: { igReel: 'vo' } }),
  L({ id: 'lB', title: 'Studio T Nagar', propertyCode: 'TNAG0005', stageId: sid('shoot_scheduled'), shootAssignee: 'Anu', shootAt: day0 + DAY + 10 * H }),
  L({ id: 'lC', title: 'Velachery 3BHK', propertyCode: 'VLCA002', stageId: sid('media_ready'), shootDoneAt: NOW - 4 * DAY, edit: { status: 'active', by: 'Ravi', startedAt: NOW - 2 * H - 10 * 60000, dueAt: day0 + 12 * H } }),
  L({ id: 'lD', title: 'Adyar villa', propertyCode: 'ADYR0001', stageId: sid('media_ready'), shootDoneAt: NOW - 5 * DAY, edit: { status: 'done', by: 'Anu', startedAt: NOW - DAY - 3 * H, doneAt: NOW - DAY }, editLog: [{ by: 'Anu', startedAt: NOW - 20 * DAY, doneAt: NOW - 20 * DAY + 2 * H }] }),
  L({ id: 'lE', title: 'Old live flat', propertyCode: 'LIVE0001', stageId: sid('live'), shootDoneAt: NOW - 60 * DAY }),
  L({ id: 'lF', title: 'ECR duplex', propertyCode: 'ECR0009', stageId: sid('shoot_done'), shootDoneAt: NOW - DAY, shootAssignee: 'Ravi' })
];
const INV = [
  { id: 'TNAG0007', propertyCode: 'TNAG0007', name: 'Villa T Nagar', location: 'T Nagar', photosLink: 'https://drive.google.com/c', detailsText: 'villa' },
  { id: 'TNAG0003', propertyCode: 'TNAG0003', name: '3BHK T Nagar', location: 'T Nagar', photosLink: 'https://drive.google.com/a' }
];
const mk = o => ({ tenantId: T, channels: {}, brochure: { done: false }, acres99: { status: 'pending' }, website: { status: 'pending' }, createdAt: NOW - 5 * DAY, ...o });
const TRACKERS = [
  mk({ id: 'pA', propertyCode: 'TNAG0003', title: '3BHK T Nagar', photosLink: 'https://drive.google.com/a', details: 'x', propertyId: 'TNAG0003', channels: { igReel: { status: 'live', at: NOW - 3 * DAY, liveAt: NOW - 3 * DAY, url: 'https://instagram.com/reel/a' } } }),
  mk({ id: 'pB', propertyCode: 'TNAG0005', title: 'Studio T Nagar' }),
  mk({ id: 'pD', propertyCode: 'ADYR0001', title: 'Adyar villa', photosLink: 'https://drive.google.com/d', details: 'x', channels: { igReel: { status: 'scheduled', at: day0 + DAY + 18 * H } } }),
  mk({ id: 'pF', propertyCode: 'ECR0009', title: 'ECR duplex', channels: { igStory: { status: 'yet', day: day0 + 2 * DAY } }, plannedDate: day0 + 2 * DAY })
];
const STUB = `
window.__saved = []; window.__listings = []; window.__rows = null;
window.__lastRows = () => { const m = new Map((window.__rows || []).map(r => [r.id, r])); for (const r of window.__saved) m.set(r.id, { ...(m.get(r.id) || {}), ...r }); return [...m.values()]; }; window.__inv = ${JSON.stringify(INV)};
window.trackFirebase = {
  savePosting: async (t, paths) => { window.__saved.push(JSON.parse(JSON.stringify(t))); },
  savePostings: async ws => { for (const w of ws) window.__saved.push(JSON.parse(JSON.stringify(w.t))); },
  deletePosting: async () => {},
  saveListing: async l => { window.__listings.push(JSON.parse(JSON.stringify(l))); },
  deleteListing: async () => {}, savePipeline: async () => {}, patchLead: async () => {},
  saveTrackConfig: async c => { window.__cfg = JSON.parse(JSON.stringify(c)); },
  getInventory: async () => JSON.parse(JSON.stringify(window.__inv)), getListingHistory: async () => [], saveHistory: async () => {}, deleteHistory: async () => {},
  getPropertyInternalNotes: async () => '', getLeadConversation: async () => null
};
window.trackAuth = { login: async () => {}, logout: async () => {}, getTenantId: () => '${T}' };
setTimeout(() => {
  window.onTrackAuthChange({ email: window.__EMAIL || 'admin@example.com' }, '${T}');
  window.applyTrackPipelineSnapshot(${JSON.stringify(ST)});
  window.applyTrackTeamSnapshot({ a: { email: 'rajesh@3pin.in' }, b: { email: 'anu@3pin.in' } });
  window.applyTrackConfigSnapshot(window.__CFG || {});
  window.applyListingsSnapshot(${JSON.stringify(LISTINGS)});
  window.applyTrackLeadsSnapshot([]);
  window.__rows = ${JSON.stringify(TRACKERS)};
  window.applyPostingSnapshot(window.__rows);
  window.__ready = true;
}, 0);`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const browser = await chromium.launch();
const errors = [];
const ok = (l, c, d) => { if (c) console.log('  ok  ' + l); else { errors.push(l + (d !== undefined ? ' — ' + d : '')); console.log('  FAIL ' + l + (d !== undefined ? ' — ' + d : '')); } };

async function open(viewport, theme, nav, cfg, email) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${viewport.width}px: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('dialog', d => d.accept());
  await page.addInitScript(([c]) => { window.__CFG = c; }, [cfg || {}]);
  if (email) await page.addInitScript(([e]) => { window.__EMAIL = e; }, [email]);
  await page.addInitScript(([th]) => { try { localStorage.setItem('crmTheme', th); localStorage.removeItem('track.mode'); localStorage.removeItem('posting.mode'); localStorage.removeItem('track.edPerson'); } catch (e) {} }, [theme]);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'track.local') return route.abort();
    if (url.pathname === '/track-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://track.local/propertytrack.html' + (nav ? '?nav=' + nav : ''));
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.waitForTimeout(250);
  return page;
}
const noSideways = async (p, where) => {
  const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  ok(`${where}: no sideways page scroll`, r.sw <= r.w + 1, JSON.stringify(r));
};
const lastSaved = p => p.evaluate(() => window.__saved[window.__saved.length - 1]);
const savedListing = (p, pred) => p.evaluate(src => { const f = new Function('l', 'return ' + src); return window.__listings.filter(f).pop() || null; }, pred);

// ─────────────────────────── desktop, light ───────────────────────────
console.log('desktop — Posting: a new series');
let p = await open({ width: 1440, height: 950 }, 'light', 'posting');
await p.click('.pg-bar .tk-sbtn:has-text("Series")'); await p.waitForTimeout(100);
ok('A Series tab at the top', /Series/.test(await p.textContent('.pg-bar .tk-sbtn.on')));
ok('…with an empty state that says what a series is', /No series yet/.test(await p.textContent('#postingView')));
await p.click('.pg-bar-r .tk-btn:has-text("New series")'); await p.waitForTimeout(100);
ok('New series dialog', /New series/.test(await p.textContent('#pgTitle')));
await p.click('#pgSave'); await p.waitForTimeout(50);
ok('A name is asked for', /Name the series/.test(await p.textContent('#pgErr')));
await p.fill('#pgSerName', 'T Nagar series');
for (const q of ['TNAG0003', 'TNAG0005', 'TNAG0007']) { await p.fill('#pgSerQ', q); await p.waitForTimeout(80); await p.click('#pgSerSug .bk-opt'); await p.waitForTimeout(60); }
const mems = await p.$$eval('.sd-mem', r => r.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
ok('Three properties picked: two tracked, one from the dashboard', mems.length === 3 && /TNAG0007/.test(mems[2]), JSON.stringify(mems));
ok('…each with its photos and brochure state', /✓ Photos/.test(mems[0]) && /No photos/.test(mems[1]) && /No brochure/.test(mems[0]), JSON.stringify(mems));
await p.fill('#pgSerQ', 'TNAG0003'); await p.waitForTimeout(80);
ok('A property already picked is not offered again', !/TNAG0003/.test(await p.textContent('#pgSerSug')));
const fri = new Date(day0 + 3 * DAY); const fd = `${fri.getFullYear()}-${String(fri.getMonth() + 1).padStart(2, '0')}-${String(fri.getDate()).padStart(2, '0')}`;
await p.fill('#pgSerDay', fd);
await p.screenshot({ path: join(OUT, 'desk-new-series.png') });
await p.click('#pgSave'); await p.waitForTimeout(250);
const rows = await p.evaluate(() => window.__saved);
const ser = rows.find(r => r.kind === 'series');
ok('Saved as a series with its three properties', ser && ser.members.length === 3 && ser.title === 'T Nagar series', JSON.stringify(ser && ser.members));
ok('…planned on Reel, FB Reel and YouTube that day, 99 Acres N/A', ser && ser.channels.igReel.day && ser.channels.fbReel.day && ser.channels.yt.day && ser.channels.igStory.status === 'yet' && !ser.channels.igStory.day && ser.acres99.status === 'na');
const card = await savedListing(p, "l.kind === 'series'");
ok('A series card is made on the board with it', card && card.postingId === ser.id && card.title === 'T Nagar series' && card.stageId === sid('shoot_done'), JSON.stringify(card));
ok('…and the series row remembers its card', rows.some(r => r.id === ser.id && r.listingId === card.id));
// The board card arrives through the listings snapshot, as Firestore would echo it.
await p.evaluate(c => window.applyListingsSnapshot([...window.trackApi.listings().filter(l => l.id !== c.id), c]), card); await p.waitForTimeout(150);
ok('Lands on the Series tab', /T Nagar series/.test(await p.textContent('.sr-name')));
const mrows = await p.$$eval('.sr-m', r => r.map(x => x.textContent.replace(/\s+/g, ' ')));
ok('Each property: its own posts — TNAG0003 has its own Reel live', /TNAG0003/.test(mrows[0]) && /Reel · Live/.test(mrows[0]), mrows[0]);
ok('…TNAG0005 none yet', /No individual posts yet/.test(mrows[1]));
ok('…TNAG0007 is only in the dashboard', /Not on the tracker/.test(mrows[2]) && /✓ Open/.test(mrows[2]));
ok('Series posts per channel, planned for the day', (await p.$$('.sr-ch')).length === 5 && /Plan/.test(await p.textContent('.sr-chs-grid')));
await p.waitForTimeout(3000); await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(100); await p.screenshot({ path: join(OUT, 'desk-series-tab.png') });
await noSideways(p, 'Series tab');

console.log('desktop — Sheet');
await p.click('.pg-bar .tk-sbtn:has-text("Sheet")'); await p.waitForTimeout(150);
const serRow = await p.$eval(`#pg-${ser.id}`, e => e.textContent.replace(/\s+/g, ' '));
ok('The series row: Series · 3 and its properties', /Series · 3/.test(serRow) && /TNAG0003/.test(serRow) && /TNAG0007/.test(serRow), serRow);
ok('…99 Acres: not for a series', /Not for a series/.test(serRow));
ok('…brochure: 0 of 3, which are missing', /0 of 3 created/.test(serRow));
ok('…"On the board" link to its card', /On the board/.test(serRow));
ok('TNAG0003\'s own row says it is in the series', /In: T Nagar series/.test(await p.$eval('#pg-pA', e => e.textContent)));
ok('TNAG0003 keeps its own Reel (the series is a separate post)', /View post/.test(await p.$eval('#pg-pA', e => e.textContent)));
await p.click('#pg-pA .ps-mini.ser'); await p.waitForTimeout(120);
ok('"In: T Nagar series" opens the series', /Series/.test(await p.textContent('.pg-bar .tk-sbtn.on')) && !!(await p.$('.sr')));

console.log('desktop — the board');
await p.evaluate(() => toggleView('board')); await p.waitForTimeout(150);
const sc = await p.$eval(`.tk-card[data-id="${card.id}"]`, e => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
ok('Series card on the board, in Shoot done', /T Nagar series/.test(sc) && /Series · 3/.test(sc), sc);
ok('…its properties, TNAG0005 still to shoot', /TNAG0005 · to shoot/.test(sc));
ok('…blocked by what is not shot', /not shot yet: TNAG0005/.test(sc));
await p.click(`.tk-card[data-id="${card.id}"]`); await p.waitForTimeout(200);
const dp = await p.textContent('#dpBody');
ok('Its panel: properties, Shoot for, the edit — no owner, shoot or mapping', /Properties in it/.test(dp) && /Shoot for/.test(dp) && /Plan the edit/.test(dp) && !/Map to a property/.test(dp) && !/Getting there/.test(dp));
await p.screenshot({ path: join(OUT, 'desk-series-card.png') });
await p.evaluate(() => closeDetail()); await p.waitForTimeout(100);

console.log('desktop — Editor view');
await p.click('#tkModeTog .tk-sbtn:has-text("Editor")'); await p.waitForTimeout(200);
const col = async key => p.$$eval(`.ed-${key} .tk-card`, c => c.map(x => x.querySelector('.ed-name').textContent));
ok('Six columns: Shoot planned … Post scheduled', (await p.$$eval('.ed-col .tk-col-title', t => t.map(x => x.textContent))).join('|') === 'Shoot planned|Shoot done|Planned to edit / post|Editing|Edit done|Post scheduled');
ok('Shoot planned: TNAG0005, and the series (a property still to shoot)', JSON.stringify((await col('shoot_planned')).sort()) === JSON.stringify(['Studio T Nagar', 'T Nagar series']), JSON.stringify(await col('shoot_planned')));
ok('Shoot done: TNAG0003', JSON.stringify(await col('shoot_done')) === JSON.stringify(['3BHK T Nagar']), JSON.stringify(await col('shoot_done')));
ok('Planned to edit / post: ECR0009 — post day fixed, edit not planned', JSON.stringify(await col('planned')) === JSON.stringify(['ECR duplex']) && /edit not planned/.test(await p.textContent('.ed-planned')));
ok('Editing: Velachery, by Ravi, delivery due today', JSON.stringify(await col('active')) === JSON.stringify(['Velachery 3BHK']) && /Ravi/.test(await p.textContent('.ed-active')) && /today/.test(await p.textContent('.ed-active .ed-due')));
ok('Post scheduled: Adyar (edit done, post booked in Posting)', JSON.stringify(await col('scheduled')) === JSON.stringify(['Adyar villa']));
ok('An old live card with nothing booked is not on it', !/Old live flat/.test(await p.textContent('.ed-board')));
ok('Shoot planned shows the shoot date to prioritise by', /Shoot/.test(await p.textContent('.ed-shoot_planned .ed-due')));
ok('Cuts and a V/O still to make on the card', /Reel · V\/O/.test(await p.textContent('.ed-shoot_done')));
const tiles = await p.$$eval('.ed-tile', t => t.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
ok('Editors, live: Ravi editing Velachery now', tiles.some(t => /^Ravi/.test(t) && /Editing Velachery 3BHK · 2h 10m/.test(t)), JSON.stringify(tiles));
ok('…Anu: not editing, 1 done this week', tiles.some(t => /^Anu/.test(t) && /Not editing now/.test(t) && /1 done this week/.test(t)), JSON.stringify(tiles));
await p.screenshot({ path: join(OUT, 'desk-editor.png'), fullPage: true });
await noSideways(p, 'Editor view');

console.log('desktop — plan, start and finish an edit');
await p.click('.tk-card[data-id="lA"] .tk-btn:has-text("Plan edit")'); await p.waitForTimeout(100);
ok('Plan the edit: the shooter is offered as editor', await p.$eval('#edWho', s => s.value) === 'Ravi');
const due = new Date(day0 + 2 * DAY); await p.fill('#edDue', `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`);
await p.click('#edModal .tk-btn.primary'); await p.waitForTimeout(150);
let lA = await savedListing(p, "l.id === 'lA'");
ok('Saved: planned, by Ravi, delivery date kept', lA && lA.edit.status === 'planned' && lA.edit.by === 'Ravi' && lA.edit.dueAt === day0 + 2 * DAY, JSON.stringify(lA && lA.edit));
ok('…moved to Planned to edit / post, with its delivery date', (await col('planned')).includes('3BHK T Nagar') && /Deliver by/.test(await p.$eval('.tk-card[data-id="lA"]', e => e.textContent)));
await p.click('.tk-card[data-id="lA"] .tk-btn:has-text("Start editing")'); await p.waitForTimeout(150);
lA = await savedListing(p, "l.id === 'lA'");
ok('Start editing: active, time stamped', lA.edit.status === 'active' && lA.edit.startedAt > NOW - 60000 && (await col('active')).includes('3BHK T Nagar'));
ok('…Ravi\'s tile now shows two edits going', (await p.$$eval('.ed-tile', t => t.map(x => x.textContent))).some(t => /Ravi/.test(t) && /\+1/.test(t)));
await p.click('.tk-card[data-id="lA"] .tk-btn:has-text("Edit done")'); await p.waitForTimeout(150);
lA = await savedListing(p, "l.id === 'lA'");
ok('Edit done: stamped, in Edit done with "Schedule in Posting"', lA.edit.status === 'done' && lA.edit.doneAt && (await col('done')).includes('3BHK T Nagar') && /Schedule in Posting/.test(await p.$eval('.tk-card[data-id="lA"]', e => e.textContent)));
await p.click('.ed-tile:has-text("Anu")'); await p.waitForTimeout(120);
// Anu shoots TNAG0005, which the T Nagar series is waiting on: the series is hers to unblock too.
ok('Tap an editor: only their work (Anu: TNAG0005 to shoot, the series waiting on it, Adyar booked)', JSON.stringify((await p.$$eval('.ed-board .ed-name', n => n.map(x => x.textContent))).sort()) === JSON.stringify(['Adyar villa', 'Studio T Nagar', 'T Nagar series']), JSON.stringify(await p.$$eval('.ed-board .ed-name', n => n.map(x => x.textContent))));
ok('…and their past edits, with how long each took', /past edits/.test(await p.textContent('.ed-past')) && (await p.$$('.ed-prow')).length === 2 && /took 3h/.test(await p.textContent('.ed-past')));
await p.click('.ed-tile:has-text("Anu")'); await p.waitForTimeout(100);
ok('Tap again: everyone', !(await p.$('.ed-past')));
await p.evaluate(() => toggleView('posting')); await p.waitForTimeout(120);
await p.click('.pg-bar .tk-sbtn:has-text("Sheet")'); await p.waitForTimeout(120);
ok('Posting shows the edit: TNAG0003 "Edit done", Velachery "Editing · Ravi"', /Edit done/.test(await p.$eval('#pg-pA', e => e.textContent)));
await p.close();

// ─────────────────────────── Settings → Configurations ───────────────────────────
console.log('Settings → Configurations');
p = await open({ width: 1440, height: 950 }, 'light', 'settings');
ok('Settings opens from the menu', await p.evaluate(() => document.getElementById('settingsView').style.display !== 'none') && /Configurations/.test(await p.textContent('#settingsView')));
await p.selectOption('#cfEdPick', 'Rajesh'); await p.click('.cf-add .tk-btn:has-text("Add editor")'); await p.waitForTimeout(80);
ok('Add Rajesh as an editor: saved for the team', JSON.stringify((await p.evaluate(() => window.__cfg)).editors) === '["Rajesh"]');
await p.selectOption('.cf-row select', 'same'); await p.waitForTimeout(60);
await p.fill('input[aria-label="Shoot done target days"]', '4'); await p.dispatchEvent('input[aria-label="Shoot done target days"]', 'change'); await p.waitForTimeout(60);
const cfg = await p.evaluate(() => window.__cfg);
ok('Deliver-by default and a stage target saved', cfg.deliverDefault === 'same' && cfg.targetDays.shoot_done === 4, JSON.stringify(cfg));
await p.uncheck('.cf-tog input >> nth=0'); await p.waitForTimeout(60);
ok('Series auto-detect switched off', (await p.evaluate(() => window.__cfg)).seriesAutoDetect === false);
await p.fill('#cfTag', 'Premium'); await p.click('.cf-add .tk-btn:has-text("Add tag")'); await p.waitForTimeout(60);
ok('A standard tag added, offered in the tag list', (await p.evaluate(() => window.__cfg)).tags.includes('Premium') && await p.evaluate(() => window.tagCatalog().includes('Premium')));
ok('The team is listed (kept in the CRM)', /Rajesh/.test(await p.textContent('.cf-sec:last-child')) && /Anu/.test(await p.textContent('.cf-sec:last-child')));
await p.evaluate(() => window.scrollTo(0, 0)); await p.screenshot({ path: join(OUT, 'desk-settings.png') });
await noSideways(p, 'Settings');
await p.close();
p = await open({ width: 1440, height: 950 }, 'light', '', { editors: ['Rajesh'] }, 'rajesh@3pin.in');
ok('Rajesh (an editor) lands on the Editor view, his own work', await p.evaluate(() => !!document.querySelector('.ed-board')) && /Rajesh/.test(await p.$eval('.ed-bar select', s => s.value)));
await p.click('#tkModeTog .tk-sbtn:has-text("Board")'); await p.waitForTimeout(120);
ok('…and can switch to the Board', !!(await p.$('.tk-board:not(.ed-board)')));
await p.close();
p = await open({ width: 1440, height: 950 }, 'light', '', { editors: ['Rajesh'] }, 'admin@example.com');
ok('Anyone else lands on the Board', !(await p.$('.ed-board')) && !!(await p.$('.tk-board')));
await p.click('#tkModeTog .tk-sbtn:has-text("Editor")'); await p.waitForTimeout(120);
ok('…and can open the Editor view', !!(await p.$('.ed-board')));
await p.close();
p = await open({ width: 390, height: 844 }, 'light', 'settings');
await noSideways(p, 'phone Settings');
await p.screenshot({ path: join(OUT, 'phone-settings.png'), fullPage: true });
await p.close();

// ─────────────────────────── the review's fixes ───────────────────────────
console.log('fixes from review');
{
  const S = mk({ id: 'pS2', kind: 'series', title: 'Studio series', members: [{ trackerId: 'pA', propertyCode: 'TNAG0003' }, { trackerId: 'pB', propertyCode: 'TNAG0005' }], listingId: 'gone' });
  p = await open({ width: 1440, height: 950 }, 'light', '', { editors: ['Outside Editor'] });
  await p.evaluate(([s, ts]) => window.applyPostingSnapshot([...ts, s]), [S, TRACKERS]);
  await p.waitForTimeout(120);
  // Menu: Editor, then Board → the board itself.
  await p.evaluate(() => toggleView('editor', true)); await p.waitForTimeout(100);
  await p.evaluate(() => toggleView('board', true)); await p.waitForTimeout(100);
  ok('"Board" in the menu leaves the Editor view', !(await p.$('.ed-board')) && !!(await p.$('.tk-board')));
  // Sellers: a series card is no seller.
  await p.evaluate(() => window.applyListingsSnapshot([...window.trackApi.listings(), { id: 'lS9', tenantId: 't', kind: 'series', title: 'Studio series', postingId: 'pS2', stageId: window.trackApi.listings()[0].stageId, media: {} }]));
  await p.evaluate(() => toggleView('sellers')); await p.waitForTimeout(150);
  ok('Sellers view does not list a series card', !/Studio series/.test(await p.textContent('#sellersView')));
  // Plan the edit: an editor typed into Settings can be picked.
  await p.evaluate(() => { toggleView('board'); openEditPlan('lA'); }); await p.waitForTimeout(100);
  ok('An editor typed into Settings can be picked to edit', (await p.$$eval('#edWho option', o => o.map(x => x.value))).includes('Outside Editor'));
  await p.evaluate(() => closeEditPlan());
  // A cancelled drag does not stop the Editor view following Posting.
  await p.evaluate(() => setBoardMode('editor')); await p.waitForTimeout(100);
  await p.dispatchEvent('.tk-card[data-id="lD"]', 'dragstart', { dataTransfer: await p.evaluateHandle(() => new DataTransfer()) });
  await p.dispatchEvent('.tk-card[data-id="lD"]', 'dragend'); await p.waitForTimeout(50);
  await p.evaluate(ts => window.applyPostingSnapshot(ts.map(t => t.id === 'pD' ? { ...t, channels: {} } : t)), TRACKERS); await p.waitForTimeout(120);
  ok('After a cancelled drag, a post removed in Posting moves the card out of Post scheduled', !/Adyar villa/.test(await p.textContent('.ed-scheduled')));
  // Rename a series card: the new name shows at once.
  await p.evaluate(() => setBoardMode('board')); await p.waitForTimeout(100);
  await p.close();
}
{
  // "Add to the board" when the card was deleted on the board; Undo of a new series takes its card.
  const S = mk({ id: 'pS3', kind: 'series', title: 'Lux series', members: [{ trackerId: 'pA', propertyCode: 'TNAG0003' }, { trackerId: 'pB', propertyCode: 'TNAG0005' }], listingId: 'deleted-card' });
  p = await open({ width: 1440, height: 950 }, 'light', 'posting');
  await p.evaluate(([s, ts]) => { window.__rows = [...ts, s]; window.applyPostingSnapshot(window.__rows); }, [S, TRACKERS]); await p.waitForTimeout(100);
  await p.click('.pg-bar .tk-sbtn:has-text("Series")'); await p.waitForTimeout(100);
  await p.click('.sr-acts .tk-btn:has-text("Add to the board")'); await p.waitForTimeout(150);
  ok('"Add to the board" re-makes a card that was deleted', !!(await savedListing(p, "l.kind === 'series' && l.postingId === 'pS3'")));
  await p.evaluate(() => window.pgOpenSeriesDlg('')); await p.fill('#pgSerName', 'Undo series');
  for (const q of ['TNAG0003', 'TNAG0005']) { await p.fill('#pgSerQ', q); await p.waitForTimeout(60); await p.click('#pgSerSug .bk-opt'); }
  await p.click('#pgSave'); await p.waitForTimeout(150);
  const made = await savedListing(p, "l.kind === 'series' && l.title === 'Undo series'");
  await p.click('#pgUndo button'); await p.waitForTimeout(150);
  ok('Undo of a new series also takes back its board card', made && !(await p.evaluate(id => window.trackApi.listings().some(l => l.id === id), made.id)));
  // Rename on the board: shows the new name at once.
  await p.evaluate(() => toggleView('board')); await p.waitForTimeout(100);
  const c3 = await savedListing(p, "l.kind === 'series' && l.postingId === 'pS3'");
  await p.evaluate(c => window.applyListingsSnapshot([...window.trackApi.listings().filter(l => l.id !== c.id), c]), c3); await p.waitForTimeout(100);
  await p.evaluate(id => editCardTitle(id), c3.id); await p.waitForTimeout(50);
  await p.fill('.tk-pname-in', 'Lux series 2'); await p.press('.tk-pname-in', 'Enter'); await p.waitForTimeout(150);
  ok('Renaming a series card shows the new name at once', /Lux series 2/.test(await p.$eval(`.tk-card[data-id="${c3.id}"]`, e => e.textContent)));
  // "Open in Posting" from its panel closes the panel.
  await p.evaluate(id => openDetail(id), c3.id); await p.waitForTimeout(150);
  await p.click('#dpBody .tk-btn:has-text("Open in Posting")'); await p.waitForTimeout(150);
  // A plain plan line tagged to the series: another round of it, counted as a series.
  await p.evaluate(() => { window.applyPostingSnapshot([...window.__lastRows(), { id: 'pLine', tenantId: 't', reference: 'Lux again', channels: {}, brochure: {}, acres99: { status: 'pending' }, website: { status: 'pending' } }]); });
  await p.evaluate(() => { window.pgOpenTag('pLine'); window.pgTagTo('t', 'pS3'); }); await p.waitForTimeout(100);
  const tagged = await p.evaluate(() => window.__saved.filter(r => r.id === 'pLine').pop());
  ok('Tagging a line to a series makes it another round of the series', tagged && tagged.repostOf === 'pS3' && tagged.kind === 'series', JSON.stringify(tagged && { r: tagged.repostOf, k: tagged.kind }));
  ok('"Open in Posting" closes the card panel', !(await p.evaluate(() => document.getElementById('dp').classList.contains('open'))) && /Lux series 2/.test(await p.textContent('#postingView')));
  await p.close();
}

{
  // Second review: a series card is not moved on before its edit is done; "not X?" from the Editor
  // view goes back to the full board; the Series tab's property rows fit at mid widths.
  const S = mk({ id: 'pS4', kind: 'series', title: 'Ready series', members: [{ trackerId: 'pA', propertyCode: 'TNAG0003' }, { propertyCode: 'TNAG0007', title: 'Villa T Nagar' }], listingId: 'lS4' });
  const C = L({ id: 'lS4', kind: 'series', title: 'Ready series', postingId: 'pS4', stageId: sid('shoot_done') });
  p = await open({ width: 900, height: 900 }, 'light', 'posting');
  await p.evaluate(([s, ts, c]) => { window.applyListingsSnapshot([...window.trackApi.listings(), c]); window.applyPostingSnapshot([...ts, s]); }, [S, TRACKERS, C]); await p.waitForTimeout(120);
  await p.click('.pg-bar .tk-sbtn:has-text("Series")'); await p.waitForTimeout(150);
  ok('Series tab at 900px: property rows are not clipped', await p.evaluate(() => [...document.querySelectorAll('.sr-m')].every(r => r.scrollWidth <= r.clientWidth + 1)));
  await noSideways(p, 'Series tab 900px');
  await p.screenshot({ path: join(OUT, 'mid-series.png') });
  await p.evaluate(() => { toggleView('board'); editCardTitle('lS4'); }); await p.waitForTimeout(60);
  await p.fill('.tk-pname-in', 'Ready series 2'); await p.press('.tk-pname-in', 'Enter'); await p.waitForTimeout(150);
  const c4 = await savedListing(p, "l.id === 'lS4'");
  ok('All shot and photos in, edit not done: a change does not move the series card on', c4 && c4.stageId === sid('shoot_done') && /edit not done/.test(await p.$eval('.tk-card[data-id="lS4"]', e => e.textContent)), c4 && c4.stageId);
  await p.close();
  p = await open({ width: 390, height: 844 }, 'light', '');
  await p.evaluate(() => setMyAgent('Ravi')); await p.waitForTimeout(200);
  ok('Shoot phone: its bar is there, thumb-sized', await p.evaluate(() => [...document.querySelectorAll('.ed-agent .tk-btn, .ed-agent .tk-link')].every(b => b.getBoundingClientRect().height >= 44)));
  await p.screenshot({ path: join(OUT, 'phone-agent-editor.png') });
  await p.click('.ed-agent .tk-link'); await p.waitForTimeout(200);
  ok('"not Ravi?" from the Editor view goes back to the full board', !(await p.$('.ed-board')) && !!(await p.$('#boardView .tk-board')) && !(await p.evaluate(() => document.body.classList.contains('agent-mode'))));
  await p.close();
}

{
  console.log('Shoots: open, reschedule, cancel');
  p = await open({ width: 1440, height: 950 }, 'light', 'shoots');
  ok('"Waiting to be booked" is gone from Shoots', !/Waiting to be booked/.test(await p.textContent('#shootsView')));
  const more = await p.$$eval('.tk-row.shoot .tk-shoot-more', m => m.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  // A shoot already done can only be opened; one still to happen can be moved or called off.
  ok('Every shoot row: Open; one still to happen also Reschedule · Cancel shoot', more.length && more.every(t => /Open/.test(t)) && more.some(t => /Reschedule/.test(t) && /Cancel shoot/.test(t)), JSON.stringify(more));
  ok('The next-up card has them too, and still only Call / Directions / Done as big buttons', !!(await p.$('.tk-next .tk-shoot-more')) && (await p.$$('.tk-next-acts a, .tk-next-acts button')).length <= 3);
  await p.click('.tk-row.shoot:has-text("Studio T Nagar") .tk-shoot-more .tk-link:has-text("Reschedule")'); await p.waitForTimeout(100);
  ok('Reschedule opens the booking, with "Cancel this shoot"', await p.evaluate(() => document.getElementById('shModal').classList.contains('open')) && await p.isVisible('#shCancelShoot'));
  await p.evaluate(() => closeShootModal());
  await p.click('.tk-row.shoot:has-text("Studio T Nagar") .tk-shoot-more .tk-link:has-text("Cancel shoot")'); await p.waitForTimeout(150);
  const lb = await savedListing(p, "l.id === 'lB'");
  ok('Cancel shoot: date cleared, logged, back to Details & docs', lb && !lb.shootAt && lb.shootCancelled === 1 && lb.stageId === sid('details'), JSON.stringify(lb && { at: lb.shootAt, st: lb.stageId }));
  ok('…and gone from the Shoots list', !/Studio T Nagar/.test(await p.textContent('#shootsView')));
  await p.click('.tk-row.shoot .tk-shoot-more .tk-link:has-text("Open") >> nth=0'); await p.waitForTimeout(150);
  ok('Open shows the property', await p.evaluate(() => document.getElementById('dp').classList.contains('open')));
  await p.screenshot({ path: join(OUT, 'desk-shoots.png') });
  await p.close();
}

{
  console.log('Editor checklist: edit planned · post planned; the edit before the post');
  p = await open({ width: 1440, height: 950 }, 'light', '');
  await p.evaluate(() => { toggleView('board'); setBoardMode('editor'); }); await p.waitForTimeout(200);
  const ckOf = async id => p.$eval(`.tk-card[data-id="${id}"] .ed-checks`, e => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
  ok('Card checklist: ECR — post planned, edit not (flagged)', /○ Edit planned ✓ Post planned/.test(await ckOf('lF')) && !!(await p.$('.tk-card[data-id="lF"] .ed-ck.bad')), await ckOf('lF'));
  ok('…Velachery being edited, no post planned yet', /✓ Edit planned ○ Post planned/.test(await ckOf('lC')), await ckOf('lC'));
  await p.selectOption('.ed-bar select[aria-label="Checklist"]', 'edit'); await p.waitForTimeout(120);
  ok('Filter "Post planned, edit not planned": only ECR duplex', JSON.stringify(await p.$$eval('.ed-board .ed-name', n => n.map(x => x.textContent))) === JSON.stringify(['ECR duplex']));
  await p.selectOption('.ed-bar select[aria-label="Checklist"]', 'post'); await p.waitForTimeout(120);
  ok('Filter "Edit planned, post not planned": Velachery (edited in free time, post later)', (await p.$$eval('.ed-board .ed-name', n => n.map(x => x.textContent))).includes('Velachery 3BHK'));
  await p.selectOption('.ed-bar select[aria-label="Checklist"]', ''); await p.waitForTimeout(80);
  // Posting: scheduling ECR's Story with a time needs its edit planned.
  await p.evaluate(() => toggleView('posting')); await p.waitForTimeout(150);
  await p.evaluate(() => pgChannel('pF', 'igStory', 'scheduled')); await p.waitForTimeout(120);
  ok('Schedule: says the edit is not planned, offers to plan it', /edit is not planned/.test(await p.textContent('#pgBody')) && !!(await p.$('#pgGate .tk-btn')));
  await p.click('#pgSave'); await p.waitForTimeout(100);
  ok('…and refuses to schedule until it is', /edit is not planned/.test(await p.textContent('#pgErr')) && !(await p.evaluate(() => window.__saved.some(t => t.id === 'pF' && t.channels && t.channels.igStory && t.channels.igStory.status === 'scheduled'))));
  await p.click('#pgGate .tk-btn'); await p.waitForTimeout(150);
  ok('"Plan the edit" opens the edit plan for its card', await p.evaluate(() => document.getElementById('edModal').classList.contains('open')) && /ECR duplex/.test(await p.textContent('#edTitle')));
  await p.click('#edModal .tk-btn.primary'); await p.waitForTimeout(150);
  await p.evaluate(() => pgChannel('pF', 'igStory', 'scheduled')); await p.waitForTimeout(120);
  ok('Edit planned: scheduling is allowed', !(await p.$('#pgGate')));
  await p.click('#pgSave'); await p.waitForTimeout(120);
  ok('…and the Story is scheduled', await p.evaluate(() => window.__saved.some(t => t.id === 'pF' && t.channels.igStory.status === 'scheduled')));
  // Mark live: Adyar's edit is done → fine; ECR's edit only planned → held until marked done.
  await p.evaluate(() => pgChannel('pF', 'igStory', 'live')); await p.waitForTimeout(120);
  ok('Mark live with the edit not done: says so, offers "The edit is done — mark it"', /edit is not done/.test(await p.textContent('#pgBody')));
  await p.click('#pgSave'); await p.waitForTimeout(100);
  ok('…refuses until it is', /edit is not done/.test(await p.textContent('#pgErr')));
  await p.click('#pgGate .tk-btn'); await p.waitForTimeout(150);
  await p.click('#pgSave'); await p.waitForTimeout(150);
  const lf = await savedListing(p, "l.id === 'lF'");
  ok('"The edit is done": the edit is marked done, and the post goes live', lf && lf.edit.status === 'done' && await p.evaluate(() => window.__saved.some(t => t.id === 'pF' && t.channels.igStory.status === 'live')), JSON.stringify(lf && lf.edit));
  await p.close();
}

// ─────────────────────────── phone + dark ───────────────────────────
for (const [name, vp, theme] of [['phone-light', { width: 390, height: 844 }, 'light'], ['phone-dark', { width: 390, height: 844 }, 'dark'], ['desk-dark', { width: 1440, height: 950 }, 'dark']]) {
  console.log(name);
  p = await open(vp, theme, 'posting');
  const series = { id: 'pS', kind: 'series', title: 'Studio series', members: [{ trackerId: 'pA', propertyCode: 'TNAG0003' }, { trackerId: 'pB', propertyCode: 'TNAG0005' }, { propertyCode: 'TNAG0007', title: 'Villa T Nagar' }], listingId: 'lS',
    channels: { igReel: { status: 'scheduled', at: day0 + 2 * DAY + 18 * H }, yt: { status: 'yet', day: day0 + 3 * DAY } }, plannedDate: day0 + 2 * DAY };
  await p.evaluate(([s, ts, card]) => { window.applyListingsSnapshot([...window.trackApi.listings(), card]); window.applyPostingSnapshot([...ts, s]); }, [mk(series), TRACKERS, L({ id: 'lS', kind: 'series', title: 'Studio series', postingId: 'pS', stageId: sid('shoot_done'), edit: { status: 'planned', by: 'Anu', dueAt: day0 + DAY } })]);
  await p.waitForTimeout(150);
  await p.click('.pg-bar .tk-sbtn:has-text("Series")'); await p.waitForTimeout(150);
  ok(`${name}: Series tab draws`, /Studio series/.test(await p.textContent('#postingView')) && /Edit planned · Anu/.test(await p.textContent('.sr')));
  await noSideways(p, `${name} Series tab`);
  await p.screenshot({ path: join(OUT, `${name}-series.png`), fullPage: true });
  await p.click('.sr-acts .tk-btn:has-text("Edit series")'); await p.waitForTimeout(120);
  await noSideways(p, `${name} Edit series dialog`);
  await p.screenshot({ path: join(OUT, `${name}-series-dialog.png`) });
  await p.evaluate(() => pgClose());
  await p.click('.pg-bar .tk-sbtn:has-text("Sheet")'); await p.waitForTimeout(150);
  await noSideways(p, `${name} Sheet`);
  await p.screenshot({ path: join(OUT, `${name}-sheet.png`), fullPage: true });
  await p.evaluate(() => { toggleView('board'); setBoardMode('editor'); }); await p.waitForTimeout(200);
  ok(`${name}: Editor view draws; the series, its edit planned, in Planned to edit`, /Studio series/.test(await p.textContent('.ed-planned')) && /Anu/.test(await p.textContent('.ed-planned')));
  await noSideways(p, `${name} Editor view`);
  await p.screenshot({ path: join(OUT, `${name}-editor.png`), fullPage: true });
  await p.evaluate(() => setBoardMode('board')); await p.waitForTimeout(150);
  ok(`${name}: the normal board keeps its columns and shows the series card`, (await p.$$('.tk-board .tk-col')).length === ST.length && !!(await p.$('.tk-card.ser')));
  await p.screenshot({ path: join(OUT, `${name}-board.png`) });
  await p.evaluate(() => openDetail('lS')); await p.waitForTimeout(200);
  await noSideways(p, `${name} series card panel`);
  await p.screenshot({ path: join(OUT, `${name}-series-panel.png`), fullPage: true });
  await p.close();
}

await browser.close();
console.log(errors.length ? `\n${errors.length} problem(s):\n  ${errors.join('\n  ')}` : '\nAll good.');
process.exit(errors.length ? 1 : 0);
