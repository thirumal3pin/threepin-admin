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
  mk({ id: 'pA', propertyCode: 'TNAG0003', title: '3BHK T Nagar', photosLink: 'https://drive.google.com/a', details: 'x', propertyId: 'TNAG0003', channels: { igReel: { status: 'live', at: NOW - 2 * DAY, liveAt: NOW - 2 * DAY, url: 'https://instagram.com/reel/a' } } }),
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
  createLead: async (l, e) => { window.__newLead = JSON.parse(JSON.stringify(l)); window.__newLeadEvent = e; return { ...l, stageId: 'crm_new' }; },
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
ok('Its panel: properties, Shoot for, the edit — no owner, shoot or mapping', /Properties in it/.test(dp) && /Shoot for/.test(dp) && /Edit — per outlet/.test(dp) && !/Map to a property/.test(dp) && !/Getting there/.test(dp));
await p.screenshot({ path: join(OUT, 'desk-series-card.png') });
await p.evaluate(() => closeDetail()); await p.waitForTimeout(100);

console.log('desktop — Editor view');
await p.click('#tkModeTog .tk-sbtn:has-text("Editor")'); await p.waitForTimeout(200);
const col = async key => p.$$eval(`.ed-${key} .tk-card`, c => c.map(x => x.querySelector('.ed-name').textContent));
ok('Seven columns: Shoot planned … Post scheduled, Posted', (await p.$$eval('.ed-col .tk-col-title', t => t.map(x => x.textContent))).join('|') === 'Shoot planned|Shoot done|Planned to edit / post|Editing|Edit done|Post scheduled|Posted');
ok('Shoot planned: TNAG0005, and the series (a property still to shoot)', JSON.stringify((await col('shoot_planned')).sort()) === JSON.stringify(['Studio T Nagar', 'T Nagar series']), JSON.stringify(await col('shoot_planned')));
ok('Shoot done: TNAG0003', JSON.stringify(await col('shoot_done')) === JSON.stringify(['3BHK T Nagar']), JSON.stringify(await col('shoot_done')));
ok('Planned to edit / post: ECR0009 — post day fixed, edit not planned', JSON.stringify(await col('planned')) === JSON.stringify(['ECR duplex']) && /edit not planned/.test(await p.textContent('.ed-planned')));
ok('Editing: Velachery, by Ravi, delivery due today', JSON.stringify(await col('active')) === JSON.stringify(['Velachery 3BHK']) && /Ravi/.test(await p.textContent('.ed-active')) && /today/.test(await p.textContent('.ed-active .ed-due')));
ok('Post scheduled: Adyar (edit done, post booked in Posting)', JSON.stringify(await col('scheduled')) === JSON.stringify(['Adyar villa']));
ok('An old live card with nothing booked is not on it', !/Old live flat/.test(await p.textContent('.ed-board')));
ok('Shoot planned shows the shoot date to prioritise by', /Shoot/.test(await p.textContent('.ed-shoot_planned .ed-due')));
ok('Shoot done: one card for the property, listing the outlets still to plan', /To plan:.*Reel \+ FB.*YouTube/.test(await p.textContent('.ed-shoot_done')), await p.textContent('.ed-shoot_done'));
const tiles = await p.$$eval('.ed-tile', t => t.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
ok('Editors, live: Ravi editing Velachery now', tiles.some(t => /^Ravi/.test(t) && /Editing Velachery 3BHK · Video · 2h 10m/.test(t)), JSON.stringify(tiles));
ok('…Anu: not editing, 1 done this week', tiles.some(t => /^Anu/.test(t) && /Not editing now/.test(t) && /1 done this week/.test(t)), JSON.stringify(tiles));
await p.screenshot({ path: join(OUT, 'desk-editor.png'), fullPage: true });
// Move ▾ on an editor card: the steps the editor moves by hand, the column it is in marked.
await p.click('.ed-active .tk-move-btn');
await p.waitForTimeout(150);
const mv = await p.evaluate(() => { const m = document.getElementById('tkMoveMenu'); return m ? [...m.querySelectorAll('.tk-move-i')].map(b => b.querySelector('.tk-move-l').textContent.trim()) : null; });
ok('Move ▾ on an editor card lists the steps it can go to, its own marked', !!mv && mv.length === 4 && mv.some(l => /^Editing.*here now/.test(l)), JSON.stringify(mv));
await p.keyboard.press('Escape');

await noSideways(p, 'Editor view');

console.log('desktop — per outlet: the Reel on its own, YouTube on another day');
const cutCard = (id, k) => `.tk-card[data-id="${id}"][data-cut="${k}"]`;
await p.click('.tk-card[data-id="lA"] .tk-btn:has-text("Plan edits")'); await p.waitForTimeout(100);
ok('Plan edits: the outlets still to plan are ticked (Reel + FB, YouTube); the shooter is offered as editor', await p.$eval('#edCuts input[value="igReel"]', i => i.checked) && await p.$eval('#edCuts input[value="yt"]', i => i.checked) && await p.$eval('#edWho', s => s.value) === 'Ravi');
await p.uncheck('#edCuts input[value="yt"]');   // only the Reel now; YouTube another day
const due = new Date(day0 + 2 * DAY); await p.fill('#edDue', `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`);
await p.click('#edModal .tk-btn.primary'); await p.waitForTimeout(150);
let lA = await savedListing(p, "l.id === 'lA'");
ok('Saved on the Reel only: planned, by Ravi, delivery date kept; YouTube untouched', lA && lA.cuts.igReel.status === 'planned' && lA.cuts.igReel.by === 'Ravi' && lA.cuts.igReel.dueAt === day0 + 2 * DAY && !lA.cuts.yt, JSON.stringify(lA && lA.cuts));
ok('…the Reel is its own card in Planned to edit; YouTube still to plan in Shoot done', !!(await p.$(`.ed-planned ${cutCard('lA', 'igReel')}`)) && /To plan:.*YouTube/.test(await p.textContent('.ed-shoot_done')) && !/To plan:.*Reel/.test(await p.textContent('.ed-shoot_done')));
// Dragging the Reel's card onto Editing starts that cut (and only that cut).
await p.dragAndDrop(cutCard('lA', 'igReel'), '.ed-active .tk-col-body'); await p.waitForTimeout(200);
lA = await savedListing(p, "l.id === 'lA'");
ok('Start editing the Reel (dragged onto Editing): active, time stamped', lA.cuts.igReel.status === 'active' && lA.cuts.igReel.startedAt > NOW - 60000 && !!(await p.$(`.ed-active ${cutCard('lA', 'igReel')}`)));
ok('…while being edited, the card shows its V/O needed, with "Ask for V/O"', !!(await p.$(`.ed-active ${cutCard('lA', 'igReel')} .tk-vo`)) && !!(await p.$(`.ed-active ${cutCard('lA', 'igReel')} .tk-vo-ask`)));
ok('…Ravi\'s tile now shows two edits going', (await p.$$eval('.ed-tile', t => t.map(x => x.textContent))).some(t => /Ravi/.test(t) && /\+1/.test(t)));
await p.click(`${cutCard('lA', 'igReel')} .tk-btn:has-text("Edit done")`); await p.waitForTimeout(150);
lA = await savedListing(p, "l.id === 'lA'");
ok('Reel edit done: stamped; Shoot for shows the Reel made, YouTube not', lA.cuts.igReel.status === 'done' && lA.cuts.igReel.doneAt && lA.forDone.igReel && !lA.forDone.yt);
ok('…its Reel is already live in Posting → Posted, with the link', !!(await p.$(`.ed-posted ${cutCard('lA', 'igReel')} a[href="https://instagram.com/reel/a"]`)));
// YouTube, another day, by Anu.
await p.evaluate(() => openEditPlan('lA', 'yt')); await p.waitForTimeout(100);
ok('Planning YouTube: only YouTube ticked', await p.$eval('#edCuts input[value="yt"]', i => i.checked) && !(await p.$eval('#edCuts input[value="igReel"]', i => i.checked)));
await p.selectOption('#edWho', 'Anu'); await p.click('#edModal .tk-btn.primary'); await p.waitForTimeout(150);
lA = await savedListing(p, "l.id === 'lA'");
ok('YouTube planned by Anu, the Reel still done — two cuts, two editors', lA.cuts.yt.status === 'planned' && lA.cuts.yt.by === 'Anu' && lA.cuts.igReel.status === 'done' && !!(await p.$(`.ed-planned ${cutCard('lA', 'yt')}`)) && !!(await p.$(`.ed-posted ${cutCard('lA', 'igReel')}`)));
await p.click('.ed-tile:has-text("Anu")'); await p.waitForTimeout(120);
// Anu: her YouTube cut, TNAG0005 to shoot (and the series waiting on it), Adyar's booked post.
ok('Tap an editor: only their work', JSON.stringify((await p.$$eval('.ed-board .ed-name', n => n.map(x => x.textContent))).sort()) === JSON.stringify(['3BHK T Nagar', 'Adyar villa', 'Studio T Nagar', 'T Nagar series']), JSON.stringify(await p.$$eval('.ed-board .ed-name', n => n.map(x => x.textContent))));
ok('…and their past edits, with how long each took', /past edits/.test(await p.textContent('.ed-past')) && (await p.$$('.ed-prow')).length === 2 && /took 3h/.test(await p.textContent('.ed-past')));
ok('…an earlier edit (since redone) can be removed right there; the current one cannot', (await p.$$('.ed-prow .ed-prow-x')).length === 1);
await p.click('.ed-tile:has-text("Anu")'); await p.waitForTimeout(100);
ok('Tap again: everyone', !(await p.$('.ed-past')));
await p.screenshot({ path: join(OUT, 'desk-editor-cuts.png'), fullPage: true });
await p.evaluate(() => openDetail('lA')); await p.waitForTimeout(150);
ok('The card\'s Edit section: one row per outlet with its own status', /Reel \+ FB/.test(await p.textContent('#dpEdit')) && /YouTube/.test(await p.textContent('#dpEdit')) && /Edit done/.test(await p.textContent('#dpEdit')) && /Planned to edit/.test(await p.textContent('#dpEdit')));
await p.evaluate(() => closeDetail());
// An earlier edit that was not real: removed from the history from the card's Edit section.
await p.evaluate(() => openDetail('lD')); await p.waitForTimeout(150);
await p.click('#dpEdit .tk-cutlog summary'); await p.waitForTimeout(80);
ok('Earlier edits listed under the outlet: Anu, with how long it took', /Anu · done .*\(2h\)/.test(await p.textContent('#dpEdit .tk-cutlog')), await p.textContent('#dpEdit .tk-cutlog'));
await p.click('#dpEdit .tk-cutlog .tk-link:has-text("Remove")'); await p.waitForTimeout(150);
const lD = await savedListing(p, "l.id === 'lD'");
ok('…Remove: out of the history, the current edit kept', lD && lD.cuts && lD.cuts.all.log.length === 0 && lD.cuts.all.status === 'done' && lD.cuts.all.by === 'Anu' && !(await p.$('#dpEdit .tk-cutlog')), JSON.stringify(lD && lD.cuts));
await p.evaluate(() => closeDetail());
await p.evaluate(() => toggleView('posting')); await p.waitForTimeout(120);
await p.click('.pg-bar .tk-sbtn:has-text("Sheet")'); await p.waitForTimeout(120);
ok('Posting shows each outlet\'s edit: TNAG0003 Reel done, YouTube planned by Anu', /Reel \+ FB done/.test(await p.$eval('#pg-pA', e => e.textContent)) && /YouTube planned · Anu/.test(await p.$eval('#pg-pA', e => e.textContent)), await p.$eval('#pg-pA', e => e.textContent.replace(/\s+/g, ' ')));
await p.close();

// ─────────────────────────── Voice-overs, and the property sheet ───────────────────────────
console.log('Voice-overs and the property sheet');
p = await open({ width: 1440, height: 950 }, 'light', '', { voiceBy: 'Anu' });
await p.click('#tkModeTog .tk-sbtn:has-text("Board")'); await p.waitForTimeout(120);
ok('Board card: V/O needed, not asked yet — no "Ask" until the edit is under way (the rough cut comes first)', /V\/O needed: Reel · not asked yet/.test(await p.$eval('.tk-card[data-id="lA"] .tk-vo', e => e.textContent.replace(/\s+/g, ' ').trim())) && !(await p.$('.tk-card[data-id="lA"] .tk-vo-ask')), await p.$eval('.tk-card[data-id="lA"]', e => e.textContent.replace(/\s+/g, ' ')).catch(() => 'no chip'));
ok('…its line not repeated in the blockers', !/voice-over not made/.test(await p.$eval('.tk-card[data-id="lA"]', e => e.textContent)));
await p.click('#tkModeTog .tk-sbtn:has-text("Editor")'); await p.waitForTimeout(150);
ok('Editor view: the shot card shows the V/O to make', !!(await p.$('.ed-shoot_done .tk-card[data-id="lA"] .tk-vo')));
ok('…the summary counts it (to ask), a tap filters to them', /1 to ask/.test(await p.textContent('.ed-sum')), await p.textContent('.ed-sum'));
await p.click('.ed-vo-n'); await p.waitForTimeout(120);
ok('Checklist → V/O to make: only cards with one', JSON.stringify(await p.$$eval('.ed-board .tk-card', c => [...new Set(c.map(x => x.dataset.id))])) === '["lA"]', JSON.stringify(await p.$$eval('.ed-board .tk-card', c => c.map(x => x.dataset.id))));
await p.evaluate(() => setEdCheck('')); await p.evaluate(() => setEdPerson('Anu')); await p.waitForTimeout(120);
ok('Not asked yet: not Anu\'s work', !(await p.$('.ed-board .tk-card[data-id="lA"]')));
await p.evaluate(() => setEdPerson('Anu')); await p.waitForTimeout(80);
// The editor starts the Reel; with the rough cut ready, asks (the note box is answered with nothing).
await p.evaluate(() => { edStep('lA', 'plan', { by: 'Ravi' }, 'igReel'); edStep('lA', 'start', null, 'igReel'); }); await p.waitForTimeout(150);
ok('…the edit under way: "Ask for V/O" is offered', !!(await p.$('.ed-board .tk-card[data-id="lA"][data-cut="igReel"] .tk-vo-ask')));
await p.click('.ed-board .tk-card[data-id="lA"][data-cut="igReel"] .tk-vo-ask'); await p.waitForTimeout(150);
let lAa = await savedListing(p, "l.id === 'lA'");
ok('"Ask for V/O": asked, stamped with who and when', lAa && lAa.forVoAsk && lAa.forVoAsk.igReel && lAa.forVoAsk.igReel.at > NOW - 60000 && !!lAa.forVoAsk.igReel.by, JSON.stringify(lAa && lAa.forVoAsk));
ok('…the card now says V/O asked · Anu, with "V/O made"', /V\/O asked: Reel · Anu/.test(await p.$eval('.ed-board .tk-card[data-id="lA"][data-cut="igReel"] .tk-vo', e => e.textContent.replace(/\s+/g, ' '))) && !!(await p.$('.ed-board .tk-card[data-id="lA"][data-cut="igReel"] .tk-vo-done')));
await p.evaluate(() => setEdPerson('Anu')); await p.waitForTimeout(120);
ok('Person → Anu (the voice-over person): asked, so it is in her work', !!(await p.$('.ed-board .tk-card[data-id="lA"]')));
await p.evaluate(() => setEdPerson('Anu')); await p.waitForTimeout(80);
await p.evaluate(() => openDetail('lA')); await p.waitForTimeout(150);
ok('The card\'s Shoot for: the Reel\'s V/O asked, with "Take back"', /V\/O asked by/.test(await p.textContent('#dpFor')) && !!(await p.$('#dpFor .tk-for-ask .tk-link')));
await p.evaluate(() => closeDetail());
// The property sheet, folded until opened.
ok('Property sheet below the board, folded', !!(await p.$('.ed-wrap .sh-wrap:not([open])')));
await p.click('.ed-wrap .sh-wrap > summary'); await p.waitForTimeout(80);
const shRow = await p.$$eval('.sh-r:not(.sh-h)', rs => rs.map(r => r.textContent.replace(/\s+/g, ' ').trim()));
ok('…opened: shot properties, outlet by outlet — TNAG0003 Reel not planned with its V/O asked, YouTube not planned', shRow.some(t => /3BHK T Nagar/.test(t) && /Not planned/.test(t) && /V\/O asked/.test(t)), JSON.stringify(shRow));
ok('…not-yet-shot properties are not in it', !shRow.some(t => /Studio T Nagar|TNAG0005/.test(t)), JSON.stringify(shRow));
await p.click('.ed-board .tk-card[data-id="lA"] .tk-vo-done'); await p.waitForTimeout(150);
const lAv = await savedListing(p, "l.id === 'lA'");
ok('"V/O made" on the card: ticked made, the reminder gone', lAv && lAv.forVo && lAv.forVo.igReel === true && !(await p.$('.ed-board .tk-card[data-id="lA"] .tk-vo')));
ok('…the sheet stays open across redraws', !!(await p.$('.ed-wrap .sh-wrap[open]')));
await p.evaluate(() => toggleView('posting')); await p.waitForTimeout(150);
ok('Posting: the same property sheet below', !!(await p.$('#postingView .pg-edsheet .sh-wrap')));
await p.close();

// ─────────────────────────── The lifecycle: edit steps, posts from the card, live → Live ───────────────────────────
console.log('Lifecycle: edit steps, posts from the card, live → Live');
p = await open({ width: 1440, height: 950 }, 'light', '');
await p.click('#tkModeTog .tk-sbtn:has-text("Board")'); await p.waitForTimeout(120);
// Not shot yet: an edit can be planned, not started.
await p.evaluate(() => { edStep('lB', 'plan', { by: 'Anu' }, 'yt'); edStep('lB', 'start', null, 'yt'); }); await p.waitForTimeout(150);
let lBx = await savedListing(p, "l.id === 'lB'");
ok('Shoot not done: the edit is planned, but cannot be started', lBx && lBx.cuts && lBx.cuts.yt.status === 'planned', JSON.stringify(lBx && lBx.cuts));
await p.evaluate(() => openDetail('lB')); await p.waitForTimeout(150);
ok('…the card says so and offers no "Start editing"', /Not shot yet/.test(await p.textContent('#dpEdit')) && !(await p.$('#dpEdit .tk-btn:has-text("Start editing")')));
ok('Shoot for has no "Done" tick — its Edit column shows where the edit stands', !(await p.$('#dpFor input[aria-label$=" done"]')) && !!(await p.$('#dpFor .tk-for-ed.plan')));
await p.evaluate(() => closeDetail());
// Done straight from planned is refused; planned → start → done works.
await p.evaluate(() => { edStep('lF', 'plan', { by: 'Ravi' }, 'yt'); edStep('lF', 'done', null, 'yt'); }); await p.waitForTimeout(150);
ok('Edit done straight from planned: refused (start editing first)', (await savedListing(p, "l.id === 'lF'")).cuts.yt.status === 'planned');
// Plan the post from the card: Posting's schedule dialog, on the property's row.
await p.evaluate(() => openDetail('lF')); await p.waitForTimeout(150);
ok('The card\'s Edit section offers "Plan post" for an outlet', !!(await p.$('#dpEdit .tk-btn:has-text("Plan post")')));
await p.click('#dpEdit .tk-btn:has-text("Plan post") >> nth=0'); await p.waitForTimeout(150);
ok('Times are picked in 30-minute steps (the picker offers :00 and :30)', await p.$eval('#pgAt', i => i.step) === '1800' && await p.evaluate(() => document.getElementById('shTime').step) === '1800');
ok('…it opens Posting\'s schedule for that outlet, over the board', await p.evaluate(() => document.getElementById('pgModal').classList.contains('open')) && /Schedule YouTube/.test(await p.textContent('#pgTitle')));
const when = new Date(day0 + 3 * DAY + 18 * H), pad = n => String(n).padStart(2, '0');
await p.fill('#pgAt', `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T18:00`);
await p.click('#pgSave'); await p.waitForTimeout(250);
const pF = await p.evaluate(() => window.__lastRows().find(r => r.id === 'pF'));
ok('…saved on the property\'s Posting row: YouTube scheduled', pF && pF.channels.yt && pF.channels.yt.status === 'scheduled' && pF.channels.yt.at === day0 + 3 * DAY + 18 * H, JSON.stringify(pF && pF.channels.yt));
ok('…and the card shows it at once', /Post /.test(await p.textContent('#dpEdit')) && !!(await p.$('#dpEdit .tk-btn:has-text("Move post")')), await p.textContent('#dpEdit'));
await p.evaluate(() => closeDetail());
// A card with no Posting row yet gets one (by its code).
await p.evaluate(() => pgPlanPost('lE', 'igStory')); await p.waitForTimeout(150);
ok('A card with no Posting row: the row is made from the card (its code)', await p.evaluate(() => (window.__lastRows() || []).some(r => r.propertyCode === 'LIVE0001')) && await p.evaluate(() => document.getElementById('pgModal').classList.contains('open')));
await p.evaluate(() => pgClose()); await p.waitForTimeout(150);
ok('…cancelled: the row made for it goes again (nothing left empty in Posting)', await p.evaluate(() => !window.pgPostsFor(window.trackApi.listings().find(l => l.id === 'lE')).rowId));
// The reference: set on the card, kept on the property's Posting row, shown on the card.
await p.evaluate(() => toggleView('board', true)); await p.waitForTimeout(150);
await p.evaluate(() => openDetail('lF')); await p.waitForTimeout(150);
await p.fill('#dpFor input[aria-label="Reference for posting"]', 'ECR sea view 4Bhk');
await p.dispatchEvent('#dpFor input[aria-label="Reference for posting"]', 'change'); await p.waitForTimeout(200);
ok('Reference set on the card: saved on its Posting row', await p.evaluate(() => window.__lastRows().find(r => r.id === 'pF').reference) === 'ECR sea view 4Bhk');
await p.evaluate(() => closeDetail()); await p.waitForTimeout(150);
ok('…and shown under the card\'s name on the board', /Ref: ECR sea view 4Bhk/.test(await p.textContent('.tk-card[data-id="lF"]')));
await p.click('.tk-card[data-id="lF"] .tk-ref'); await p.waitForTimeout(100);
await p.fill('.tk-card[data-id="lF"] .tk-ref-in', 'ECR villa 4Bhk'); await p.keyboard.press('Enter'); await p.waitForTimeout(200);
ok('…changed right on the board card (Enter saves, on its Posting row)', await p.evaluate(() => window.__lastRows().find(r => r.id === 'pF').reference) === 'ECR villa 4Bhk' && /Ref: ECR villa 4Bhk/.test(await p.textContent('.tk-card[data-id="lF"]')));
await p.hover('.tk-card[data-id="lC"]'); await p.waitForTimeout(150);
ok('…a card with none offers "+ Reference" on hover', await p.isVisible('.tk-card[data-id="lC"] .tk-ref-add'));
await p.evaluate(() => pgSetRef('lE', 'Old flat, Besant Nagar')); await p.waitForTimeout(200);
ok('…a card with no Posting row: the row is made with the reference', await p.evaluate(() => (window.__lastRows() || []).some(r => r.propertyCode === 'LIVE0001' && r.reference === 'Old flat, Besant Nagar')));
// A tick in the panel redraws it — and it stays where it was scrolled.
await p.evaluate(() => openDetail('lF')); await p.waitForTimeout(150);
const scroller = await p.evaluate(() => { const c = ['#dpBody', '#dp .tk-dp-main', '#dp .tk-dp-side', '#dp'].find(sel => { const el = document.querySelector(sel); return el && el.scrollHeight > el.clientHeight + 50; }); return c || ''; });
await p.evaluate(sel => { document.querySelector(sel).scrollTop = 400; }, scroller); await p.waitForTimeout(100);
const before = await p.evaluate(sel => document.querySelector(sel).scrollTop, scroller);
await p.evaluate(() => setForPlan('lF', 'collab', true)); await p.waitForTimeout(250);
const after = await p.evaluate(sel => document.querySelector(sel).scrollTop, scroller);
ok('A tick in the panel keeps it where it was scrolled (not back to the top)', !!scroller && before > 100 && Math.abs(after - before) < 5, JSON.stringify({ scroller, before, after }));
await p.evaluate(() => closeDetail()); await p.waitForTimeout(100);
// No lead in the CRM for this owner: create it from the card, linked.
await p.evaluate(() => openLinkLead('lF')); await p.waitForTimeout(120);
await p.fill('#linkSearch', '9876543210'); await p.dispatchEvent('#linkSearch', 'input'); await p.waitForTimeout(120);
ok('Link a CRM lead → nothing matches: the form to create the lead, the number typed already in it', /Nothing matches/.test(await p.textContent('#linkList')) && await p.$eval('#lnPhone', i => i.value) === '9876543210');
await p.fill('#lnName', 'Prakash'); await p.click('#lnSave'); await p.waitForTimeout(250);
const nl = await p.evaluate(() => window.__newLead);
ok('…created as a seller lead in the CRM, already linked to the card', nl && nl.name === 'Prakash' && nl.enquiryType === 'Seller Listing' && nl.listingId === 'lF' && nl.phoneKey === '919876543210' && (nl.propertyCodes || []).includes('ECR0009'), JSON.stringify(nl));
ok('…and the card is linked to it', (await savedListing(p, "l.id === 'lF'")).leadId === nl.id && !(await p.evaluate(() => document.getElementById('linkModal').classList.contains('open'))));
// A post live in Posting: the card moves to Live.
await p.evaluate(() => toggleView('posting')); await p.waitForTimeout(150);
await p.evaluate(() => pgChannel('pD', 'igReel', 'live')); await p.waitForTimeout(150);
await p.fill('#pgUrl', 'https://www.instagram.com/reel/adyar'); await p.click('#pgSave'); await p.waitForTimeout(250);
ok('A post marked live in Posting moves its card to Live', (await savedListing(p, "l.id === 'lD'")).stageId === sid('live'));
// Moved back before the shoot: it is not shot any more (a reshoot); before Shoot scheduled, the shoot is off.
await p.evaluate(sd => changeStage('lF', sd), sid('shoot_scheduled')); await p.waitForTimeout(200);
await p.evaluate(() => { const m = document.getElementById('shModal'); if (m) m.classList.remove('open'); });
const lFb = await savedListing(p, "l.id === 'lF'");
ok('Dragged back to Shoot scheduled: not shot any more (the old wrap kept aside)', lFb && !lFb.shootDoneAt && lFb.prevShootDoneAt > 0, JSON.stringify(lFb && { d: lFb.shootDoneAt, p: lFb.prevShootDoneAt }));
await p.evaluate(sd => changeStage('lB', sd), sid('details')); await p.waitForTimeout(200);
const lBb = await savedListing(p, "l.id === 'lB'");
ok('Dragged back to Details: the booked shoot is off, the owner to be told again', lBb && !lBb.shootAt && lBb.ownerInformed === false && lBb.shootCancelled === 1);
await p.close();

// ─────────────────────────── Settings → Configurations ───────────────────────────
console.log('Settings → Configurations');
p = await open({ width: 1440, height: 950 }, 'light', 'settings');
ok('Settings opens from the menu', await p.evaluate(() => document.getElementById('settingsView').style.display !== 'none') && /Configurations/.test(await p.textContent('#settingsView')));
await p.selectOption('#cfEdPick', 'Rajesh'); await p.click('.cf-add .tk-btn:has-text("Add editor")'); await p.waitForTimeout(80);
ok('Add Rajesh as an editor: saved for the team', JSON.stringify((await p.evaluate(() => window.__cfg)).editors) === '["Rajesh"]');
await p.selectOption('select[aria-label="Default delivery date"]', 'same'); await p.waitForTimeout(60);
await p.selectOption('select[aria-label="Voice-over by"]', 'Anu'); await p.waitForTimeout(60);
ok('Voice-over by: Anu, saved for the team', (await p.evaluate(() => window.__cfg)).voiceBy === 'Anu');
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
  ok('All shot and photos in, edit not done: a change does not move the series card on', c4 && c4.stageId === sid('shoot_done') && /edit not done|outlets not planned/.test(await p.$eval('.tk-card[data-id="lS4"]', e => e.textContent)), c4 && c4.stageId);
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
  await p.click('.tk-row.shoot .tk-shoot-more .tk-link:has-text("Open") >> nth=0'); await p.waitForTimeout(150);
  ok('Open shows the property', await p.evaluate(() => document.getElementById('dp').classList.contains('open')));
  await p.evaluate(() => closeDetail()); await p.waitForTimeout(100);
  ok('A shoot already done is not "Missed" (judged by the shoot, not the media list)', !/Missed[^]*3BHK T Nagar/.test(await p.textContent('#shootsView')));
  await p.click('.tk-row.shoot:has-text("Studio T Nagar") .tk-shoot-more .tk-link:has-text("Reschedule")'); await p.waitForTimeout(100);
  ok('Reschedule opens the booking, with "Cancel this shoot"', await p.evaluate(() => document.getElementById('shModal').classList.contains('open')) && await p.isVisible('#shCancelShoot'));
  await p.evaluate(() => closeShootModal());
  await p.click('.tk-row.shoot:has-text("Studio T Nagar") .tk-shoot-more .tk-link:has-text("Cancel shoot")'); await p.waitForTimeout(150);
  const lb = await savedListing(p, "l.id === 'lB'");
  ok('Cancel shoot: date cleared, logged, back to Details & docs', lb && !lb.shootAt && lb.shootCancelled === 1 && lb.stageId === sid('details'), JSON.stringify(lb && { at: lb.shootAt, st: lb.stageId }));
  ok('…and gone from the Shoots list', !/Studio T Nagar/.test(await p.textContent('#shootsView')));
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
  ok('"The edit is done": the Story\'s edit is marked done, and the post goes live', lf && lf.cuts.igStory.status === 'done' && await p.evaluate(() => window.__saved.some(t => t.id === 'pF' && t.channels.igStory.status === 'live')), JSON.stringify(lf && lf.cuts));
  await p.close();
}

{
  console.log('Editor view follows Posting: scheduled → Post scheduled; live → Posted');
  p = await open({ width: 1440, height: 950 }, 'light', '');
  await p.evaluate(() => { toggleView('board'); setBoardMode('editor'); }); await p.waitForTimeout(200);
  ok('Adyar: edit done, its Reel scheduled → Post scheduled', /Adyar villa/.test(await p.textContent('.ed-scheduled')));
  // The Reel is marked live in Posting (before the edit record was even touched again).
  await p.evaluate(ts => window.applyPostingSnapshot(ts.map(t => t.id === 'pD' ? { ...t, channels: { igReel: { status: 'live', at: Date.now() - 7200000, liveAt: Date.now() - 3600000, url: 'https://www.youtube.com/watch?v=adyar' } } } : t)), TRACKERS);
  await p.waitForTimeout(200);
  ok('…marked live in Posting → moves to Posted by itself', /Adyar villa/.test(await p.textContent('.ed-posted')) && !/Adyar villa/.test(await p.textContent('.ed-scheduled')));
  ok('…with the post link and when it went live', !!(await p.$('.ed-posted a[href="https://www.youtube.com/watch?v=adyar"]')) && /Live/.test(await p.textContent('.ed-posted')));
  await p.screenshot({ path: join(OUT, 'desk-posted.png') });
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
  ok(`${name}: Series tab draws`, /Studio series/.test(await p.textContent('#postingView')) && /planned · Anu/.test(await p.textContent('.sr')));
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
