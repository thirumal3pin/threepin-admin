// ═══════ POSTING TRACKER — A WEEK, AS EACH PERSON WORKS IT ═══════
//
// Drives the real propertytrack.html (Firebase swapped for an in-memory stand-in) through the
// week the way the team actually works it, using the CEO's real plan text:
//
//   Monday morning   CEO's plan arrives → pasted in, lines tagged, rows land on the Sheet
//   Media team       sets the times, shares photos, picks channels for lines that had none
//   Admin            creates codes, brochure, confirms posts with links, 99 Acres, website
//   Repost           a property already done goes out again — only its posts are asked for
//   You              monitor: summary, This week, No code yet, late plans, phone
//
//   node tests/posting-roles.mjs [out-dir]

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStages } from '../track-assets/track-pipeline.js';

const OUT = process.argv[2] || 'tests/out/posting-roles';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.now(), H = 3600000, D = 24 * H, T = 't_3pinrealty';

const INV = [
  { id: 'VLC002', propertyCode: 'VLC002', name: 'Velachery 2BHK', location: 'Velachery', photosLink: 'https://drive.google.com/v', detailsText: '2BHK 1050 sqft' },
  { id: 'LUX049', propertyCode: 'LUX049', name: 'Lux49 4BHK', location: 'Anna Nagar', photosLink: 'https://drive.google.com/lux', detailsText: '4BHK 2900 sqft' },
  { id: 'SKL001', propertyCode: 'SKL001', name: 'Shriram King Life', location: 'Kelambakkam' },
  { id: '77', propertyCode: '', name: 'Old listing, no code', location: 'Adyar' }
];
// One property already fully done last week — it will come back as a repost.
const DONE = {
  id: 'VLC002', tenantId: T, propertyCode: 'VLC002', title: 'Velachery 2BHK', location: 'Velachery', propertyId: 'VLC002',
  photosLink: 'https://drive.google.com/v', details: '2BHK', brochure: { done: true, at: NOW - 8 * D, by: 'admin@x' },
  channels: Object.fromEntries(['igStory', 'igReel', 'fbReel', 'yt'].map(k => [k, { status: 'live', at: NOW - 8 * D, liveAt: NOW - 8 * D, url: 'https://x.com/' + k }])),
  acres99: { status: 'posted', url: 'https://99acres.com/v' }, website: { status: 'posted', url: 'https://3pin.in/v' }, createdAt: NOW - 9 * D
};

const PLAN = `HIS WEEK

Monday -S - Lux49 - 4Bhk

Tuesday - Velachery 2Bhk

Wednesday -S- Eden villas rent

Thursday - Kodambakkam commercial rent

Friday -S- Brigade stellaris velachery

Saturday - T nagar pushkar 3Bhk

Sunday - Nandanam 3Bhk brand new

Youtube - T nagar series`;

const STUB = `
window.__saved = []; window.__deleted = [];
window.trackFirebase = {
  // Same shapes as firebase-sync: savePosting(t, paths?) and savePostings([{ t, paths? }]).
  savePosting: async (t, paths) => { window.__saved.push(JSON.parse(JSON.stringify(t))); },
  savePostings: async ws => { for (const w of ws) window.__saved.push(JSON.parse(JSON.stringify(w.t))); },
  deletePosting: async id => { window.__deleted.push(id); },
  saveListing: async () => {}, savePipeline: async () => {}, patchLead: async () => {},
  getInventory: async () => ${JSON.stringify(INV)}, getListingHistory: async () => [], saveHistory: async () => {}, deleteHistory: async () => {}, getLeadConversation: async () => null
};
window.trackAuth = { login: async () => {}, logout: async () => {}, getTenantId: () => '${T}' };
setTimeout(() => {
  window.onTrackAuthChange({ email: 'admin@3pin.in' }, '${T}');
  window.applyTrackPipelineSnapshot(${JSON.stringify(defaultStages())});
  window.applyListingsSnapshot([]); window.applyTrackLeadsSnapshot([]);
  window.applyPostingSnapshot(${JSON.stringify([DONE])});
  window.__ready = true;
}, 0);`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const browser = await chromium.launch();
const errors = [];
const ok = (l, c, d) => { if (c) console.log('  ok  ' + l); else { console.log('  FAIL ' + l + (d !== undefined ? ' — ' + d : '')); errors.push(l); } };
const section = n => console.log('\n── ' + n);

async function open(viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${viewport.width}px: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });
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
  await page.waitForSelector('.pg-bar');
  return page;
}

const p = await open({ width: 1440, height: 950 });
const last = () => p.evaluate(() => window.__saved.slice(-1)[0]);
const saved = () => p.evaluate(() => window.__saved);
const rowsNow = () => p.evaluate(() => { const m = new Map(); for (const s of window.__saved) m.set(s.id, s); return [...m.values()]; });
const mode = async n => { await p.click('.pg-bar .tk-sbtn:nth-child(' + n + ')'); await p.waitForTimeout(80); };
const rowId = async ref => (await rowsNow()).find(r => r.reference === ref).id;
const text = sel => p.textContent(sel);
const openFilters = async () => { if (!(await p.$('.pg-fbtns'))) await p.click('.pg-fbtn'); };

// ─────────────────────────────────────────────────────────────
section('Monday morning — the CEO\'s plan arrives and is pasted in');
await p.click('text=Paste week plan');
ok('The paste dialog opens on this week\'s Monday', await p.$eval('#pgMonday', e => !!e.value));
await p.fill('#pgPlanText', PLAN);
await p.waitForTimeout(120);
const lines = await p.$$eval('.pg-planrow', r => r.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
ok('All 8 lines are understood, the heading is ignored', lines.length === 8 && !(await p.$('.pg-planrow + .tk-hint.warn')), JSON.stringify(lines));
ok('Story lines show the S badge (Mon, Wed, Fri)', (await p.$$('.pg-planrow .pg-sbadge')).length === 3);
ok('The YouTube line is a week item', /YouTube · week/.test(lines[7]));
ok('The button says how many rows will be added', /Add 8 rows/.test(await text('#pgSave')));
// The CEO's Tuesday line is the property done last week → tag it as a repost.
const tueSel = '.pg-planrow:nth-child(2) select';
ok('A line that matches a tracked property is suggested as a repost', (await p.$eval(tueSel, s => s.value)) === 't:VLC002', await p.$eval(tueSel, s => s.value));
// Monday's Lux49 already exists in the dashboard → take its code.
await p.selectOption('.pg-planrow:nth-child(1) select', 'i:LUX049');
ok('The dashboard list does not offer the property already tracked', !(await p.$('.pg-planrow:nth-child(1) select option[value="i:VLC002"]')));
ok('…nor a legacy dashboard row with no code', !(await p.$('.pg-planrow:nth-child(1) select option[value="i:77"]')));
await p.screenshot({ path: OUT + '/1-paste.png', fullPage: true });
await p.click('#pgSave');
await p.waitForTimeout(150);
let all = await rowsNow();
ok('8 rows saved', all.filter(r => r.reference).length === 8, all.length);
ok('It lands on the Sheet, sorted by planned date, with a week header', /Sheet/.test(await text('.pg-bar .tk-sbtn.on')) && (await p.$$eval('.ps-week', w => w.map(x => x.textContent))).some(w => /this week/i.test(w)));
const lux = all.find(r => r.reference === 'Lux49 - 4Bhk');
ok('Monday Lux49 took the dashboard code, title, photos and link', lux.propertyCode === 'LUX049' && lux.title === 'Lux49 4BHK' && lux.propertyId === 'LUX049' && /lux/.test(lux.photosLink));
ok('…and its Story is planned for Monday', !!lux.channels.igStory.day);
const tue = all.find(r => r.reference === 'Velachery 2Bhk');
ok('Tuesday Velachery is a repost of last week\'s property', tue.repostOf === 'VLC002' && !tue.propertyCode);
const eden = all.find(r => r.reference === 'Eden villas rent');
ok('Wednesday Eden villas is a plain reference: no code, no title', !eden.propertyCode && !eden.title && !eden.repostOf);
const yt = all.find(r => r.reference === 'T nagar series');
ok('YouTube series row: only YouTube left open', yt.channels.yt.status === 'yet' && yt.channels.igReel.status === 'na' && !!yt.weekOf);
await p.screenshot({ path: OUT + '/2-sheet.png', fullPage: true });

// Pasting the same message again (it was forwarded twice) changes nothing.
await p.click('text=Paste week plan');
await p.fill('#pgPlanText', PLAN);
await p.waitForTimeout(100);
ok('Re-pasting: every line marked already added', (await p.$$('.pg-planrow.dup')).length === 8 && /Add 0 rows/.test(await text('#pgSave')));
const before = (await saved()).length;
await p.click('#pgSave');
ok('…and saving adds nothing, with a reason', (await saved()).length === before && /already on the tracker/.test(await text('#pgErr')));
// Typos and stray lines are shown, not silently dropped.
await p.fill('#pgPlanText', 'Mon - Adyar duplex\nCall owner first\nFrday - Typo day');
await p.waitForTimeout(100);
ok('Unrecognised lines are listed as not added', /Call owner first/.test(await text('#pgPlanPreview')) && /Frday/.test(await text('#pgPlanPreview')));
await p.keyboard.press('Escape');

// ─────────────────────────────────────────────────────────────
section('Media team — fix times, share photos, choose channels');
await mode(1);
const nowTags = await p.$$eval('#pg-now .pt-tag', t => t.map(x => x.textContent));
await p.click('.pt-later summary');
let groups = await p.$$eval('.pt-later .tk-group-hdr', h => h.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
ok('Today asks for a type on plan lines with none (urgent if the day passed, else under Everything else)', nowTags.includes('Pick a type') || groups.some(g => /^Planned — choose a channel and time/.test(g)), JSON.stringify([nowTags, groups]));
ok('…and lists the property codes still to create', groups.some(g => /^Create the property code/.test(g)));
const repostName = 'Velachery 2BHK — Velachery 2Bhk';
ok('A repost never asks for a brochure or code',
  !(await p.$(`.pt-later .tk-group:has(.tk-group-hdr:text("Create the brochure")) .pg-task:has-text("${repostName}")`)) &&
  !(await p.$(`.pt-later .tk-group:has(.tk-group-hdr:text("Create the property code")) .pg-task:has-text("${repostName}")`)) &&
  !(await p.$(`#pg-now .pt-now:has-text("Brochure needed"):has-text("${repostName}")`)));
await p.screenshot({ path: OUT + '/3-todo.png', fullPage: true });

await mode(2);
ok('Week lists "Planned — time not set"', /Planned — time not set/.test(await text('#postingView')));
// Set the time for Monday's Lux49 Story.
await p.click('.tk-row:has-text("Lux49") button:has-text("Set time")');
const defaultAt = await p.$eval('#pgAt', e => e.value);
ok('The time picker starts on the planned day, not today-plus-an-hour', defaultAt.endsWith('T10:00'), defaultAt);
await p.fill('#pgAt', defaultAt.slice(0, 10) + 'T18:00');
await p.click('#pgSave');
let s = await last();
ok('Story scheduled for Monday 6pm, planned day kept', s.channels.igStory.status === 'scheduled' && new Date(s.channels.igStory.at).getHours() === 18 && !!s.channels.igStory.day);
// Thursday had no channel → pick Reel from Upcoming.
await p.click('.tk-row:has-text("Kodambakkam") button:has-text("Insta Reel")');
await p.click('#pgSave');
s = await last();
ok('A channel-less line gets a Reel at its planned day', s.reference === 'Kodambakkam commercial rent' && s.channels.igReel.status === 'scheduled');
ok('…and it leaves the "time not set" list', !(await p.$('.tk-row:has-text("Kodambakkam") button:has-text("Insta Reel")')));
// Photos for Eden villas from the Sheet chip.
await mode(3);
const edenId = await rowId('Eden villas rent');
await p.click(`#pg-${edenId} .ps-dot >> nth=0`);
await p.fill('#pgPhotos', 'drive.google.com/drive/folders/eden');
await p.fill('#pgDetails', '4BHK villa for rent, 3200 sqft');
await p.click('#pgSave');
s = await last();
ok('Photos and details saved on a row that has no code yet', s.id === edenId && s.photosLink === 'https://drive.google.com/drive/folders/eden' && !s.propertyCode);

// ─────────────────────────────────────────────────────────────
section('Admin — code, brochure, confirm posts with links');
// Code typed straight into the sheet; a clash is refused.
await p.fill(`#pg-${edenId} .pg-code-in`, 'vlc-002');
await p.press(`#pg-${edenId} .pg-code-in`, 'Tab');
await p.waitForTimeout(100);
ok('A code already used is refused (spacing and dashes ignored)', /already used/.test(await text('#toast')) && !(await last()).propertyCode);
await p.fill(`#pg-${edenId} .pg-code-in`, 'EDN010');
await p.press(`#pg-${edenId} .pg-code-in`, 'Tab');
await p.waitForTimeout(100);
s = await last();
await p.evaluate(() => 0);
ok('Code saved on the same row (nothing re-entered)', s.id === edenId && s.propertyCode === 'EDN010' && s.photosLink.includes('eden'));
// A code that IS in the dashboard links itself.
const shrId = await rowId('Nandanam 3Bhk brand new');
await p.fill(`#pg-${shrId} .pg-code-in`, 'skl001');
await p.press(`#pg-${shrId} .pg-code-in`, 'Tab');
await p.waitForTimeout(100);
s = await last();
ok('A code found in the dashboard links it and fills the title', s.propertyId === 'SKL001' && s.title === 'Shriram King Life');
ok('…typed in lowercase, saved as the dashboard writes it', s.propertyCode === 'SKL001', s.propertyCode);
ok('…the plan reference is kept as "plan:" under the title', /Plan: Nandanam 3Bhk brand new/.test(await text(`#pg-${shrId}`)));
// The brochure is not ticked in the sheet: it is read from the board / Property dashboard.
ok('No brochure tick box in the sheet — it shows where the brochure stands', !(await p.$(`#pg-${edenId} .pg-bro input`)) && !!(await p.$(`#pg-${edenId} .pg-bro`)));
// Monday 6pm passes → Due → confirm with link from To do.
// The clock moves on: put Monday's Story at an hour ago (rescheduled in the sheet, as the media team would).
await mode(3);
const luxId = await rowId('Lux49 - 4Bhk');
await p.selectOption(`#pg-${luxId} select[aria-label="Insta Story status"]`, 'scheduled');
await p.fill('#pgAt', await p.evaluate(() => { const d = new Date(Date.now() - 3600000), q = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${q(d.getMonth() + 1)}-${q(d.getDate())}T${q(d.getHours())}:${q(d.getMinutes())}`; }));
await p.click('#pgSave');
ok('Scheduling in the past warns that it shows as due', /shows as due/.test(await text('#pgUndo')));
await mode(1);
ok('The Story whose time passed today shows as Due in Today', /Due — confirm posted/.test(await text('#pg-today .pt-row:has-text("Lux49"):has-text("Story")')));
// The plan is "this week" on the real clock, so how many other posts are already past due depends
// on the day the suite runs — the box must count exactly the Due posts Today shows, and include this one:
// today's under "Today", an earlier day's under "Needs you now" as Overdue (from Friday on, Thursday's is).
const dueBox = parseInt((await text('.kpi')).trim(), 10);
const dueRows = await p.$$eval('#pg-today .pt-row', rs => rs.filter(r => /Due — confirm posted/.test(r.textContent)).length);
const overdueRows = await p.$$eval('#pg-now .pt-now', rs => rs.filter(r => /Overdue/.test(r.textContent)).length);
ok('…counted in the "Due now" box', dueRows >= 1 && dueBox === dueRows + overdueRows, `box ${dueBox}, due today ${dueRows}, overdue from earlier ${overdueRows}`);
await p.click('#pg-today .pt-row:has-text("Lux49"):has-text("Story") button:has-text("Mark live")');
await p.fill('#pgUrl', 'instagram.com/stories/3pin/123');
await p.click('#pgSave');
s = await last();
ok('Confirmed live with the link the admin copied', s.channels.igStory.status === 'live' && s.channels.igStory.url === 'https://instagram.com/stories/3pin/123');

// ─────────────────────────────────────────────────────────────
section('Repost — last week\'s property goes out again');
await mode(3);
const tueId = await rowId('Velachery 2Bhk');
const cells = await p.$$eval(`#pg-${tueId} .ps-orig`, c => c.length);
ok('Brochure, 99 Acres and website cells say "on original"', cells === 3, cells);
ok('Code cell points back to the original', /↺ Repost of VLC002/.test(await text(`#pg-${tueId}`)));
await p.selectOption(`#pg-${tueId} select[aria-label="Insta Reel status"]`, 'scheduled');
await p.click('#pgSave');
s = await last();
ok('The repost gets its own Reel schedule', s.id === tueId && s.channels.igReel.status === 'scheduled');
await mode(3);
const reelCell = await text('#pg-' + tueId + ' .ps-cell[data-l="Insta Reel"]');
ok('In the repost row, the Reel cell shows the earlier live Reel above this round', /Live ·/.test(reelCell) && reelCell.indexOf('Live ·') < reelCell.indexOf('Scheduled'), reelCell.replace(/s+/g, ' '));
ok('…and the brochure cell shows the real status from the original', /Created/.test(await text('#pg-' + tueId + ' .ps-cell[data-l="Brochure"]')));
await mode(4);
ok('Properties tab: one block for the property and its repost, with a scorecard', /2 rounds of posting/.test(await text('#pf-VLC002')) && /1× live/.test(await text('#pf-VLC002 .pf-tally')));
await mode(3);
const orig = (await rowsNow()).find(r => r.id === 'VLC002');
ok('The original is not touched', !orig);   // never re-saved
await p.click(`#pg-${tueId} .ps-repost`);
ok('"↺ VLC002" opens the original card', /Properties/.test(await text('.pg-bar .tk-sbtn.on')) && !!(await p.$('#pg-VLC002.pg-flash')));
// A mis-tag can be undone.
await p.click(`#pg-${tueId} .pg-inputs button:has-text("Edit")`);
await p.click('text=Not a repost — make it its own row');
s = await last();
ok('Untagging makes it its own row again', s.id === tueId && !s.repostOf);
// …and tagged back via Tag.
await mode(3);
await p.click(`#pg-${tueId} button:has-text("Tag property")`);
await p.click('#pgPickList .tk-pick:has-text("VLC002")');
ok('Tagged back as a repost', (await last()).repostOf === 'VLC002');

// ─────────────────────────────────────────────────────────────
section('You — monitoring the week');
const summary = await text('.pg-summary');
ok('Summary counts rows, scheduled and planned-without-time', /\d+ rows/.test(summary) && /planned, time not set/.test(summary), summary);
await openFilters(); await p.click('.pg-f:has-text("This week")');
const wk = await p.$$eval('.ps-row', r => r.length);
ok('"This week" shows this week\'s rows only (not last week\'s finished one)', wk === 8, wk);
await p.click('.pg-active .tk-link');
await openFilters(); await p.click('.pg-f:has-text("No code yet")');
const nocode = await p.$$eval('.ps-row', r => r.length);
ok('"No code yet" lists the reference-only rows (reposts excluded)', nocode === 4, nocode);
await p.click('.pg-active .tk-link');
// Search finds a row by its plan reference and by the original's name.
await p.fill('#searchInput', 'pushkar'); await p.waitForTimeout(100);
ok('Search finds a plan line', (await p.$$('.ps-row')).length === 1);
await p.fill('#searchInput', ''); await p.waitForTimeout(100);
// Rename a reference inline; clearing it is refused.
const satId = await rowId('T nagar pushkar 3Bhk');
await p.fill(`#pg-${satId} .pg-name`, 'T Nagar Pushkar 3BHK — corner flat');
await p.press(`#pg-${satId} .pg-name`, 'Tab'); await p.waitForTimeout(80);
ok('Reference renamed in place', (await last()).reference === 'T Nagar Pushkar 3BHK — corner flat');
await p.fill(`#pg-${satId} .pg-name`, '');
await p.press(`#pg-${satId} .pg-name`, 'Tab'); await p.waitForTimeout(80);
ok('Clearing the only name is refused', /needs a reference/.test(await text('#toast')));
// Move a day in the sheet.
await p.fill(`#pg-${satId} .pg-date`, '2031-01-04');
await p.press(`#pg-${satId} .pg-date`, 'Tab'); await p.waitForTimeout(80);
ok('Planned date moved in place', new Date((await last()).plannedDate).getFullYear() === 2031);
// Last week's plan that never got scheduled shows as late.
await p.click('text=Paste week plan');
const lastMon = await p.$eval('#pgMonday', e => { const d = new Date(e.value); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); });
await p.fill('#pgMonday', lastMon); await p.dispatchEvent('#pgMonday', 'change');
await p.fill('#pgPlanText', 'Tuesday -S- Mogappair 2 prop');
await p.waitForTimeout(80);
await p.click('#pgSave');
await mode(2);
ok('A Story planned for a day already passed shows red in Week', /day passed/.test(await text('#postingView')) && !!(await p.$('.tk-row.hot:has-text("Mogappair")')));
ok('…and counts as needing attention in the menu badge', Number((await p.$$eval('.rl-badge', b => b.map(x => x.textContent)))[0] || 0) >= 1);
// The week at a glance answers 'Story, Reel or both?'
await mode(2);
const wkCounts = await text('.wk-counts');
ok('Week strip totals posts by type', /Stor(y|ies)/.test(wkCounts) && /Reel/.test(wkCounts), wkCounts);
ok('…and counts the lines whose type is not decided', /type not decided/.test(wkCounts));
const monTypes = await p.$$eval('.wk-day.today .wk-it.ws-live .wk-ch', x => x.map(e => e.textContent));
ok('The Lux49 Story confirmed live today shows on today, as Live', monTypes.includes('Story'), JSON.stringify(monTypes));
ok('The YouTube series sits under "Also this week"', /T nagar series/.test(await text('.wk-week')));
await p.click('.wk-day:nth-child(4) .wk-it'); await p.click('.qk-open');
ok('Clicking a day item lights its row in the sheet', !!(await p.$('.ps-row.pg-flash')));
await mode(2); await p.click('.wk-arrow[aria-label="Next week"]');
ok('Next week can be looked at, and comes back', /Next week/.test(await text('.wk-title')) && !!(await p.$('.wk-today')));
await p.click('.wk-today');
// Export has the plan columns.
const csvHead = await p.evaluate(() => import('./track-assets/posting.js').then(G => G.toCsv([]).split('\r\n')[0]));
ok('Export CSV starts with Planned date, Reference, Repost of', csvHead.startsWith('Planned date,Reference,Repost of'));
// Deleting an original that has reposts warns first.
await mode(3);
await openFilters(); await p.click('.pg-f:has-text("This week")'); await p.click('.pg-active .tk-link');
await p.evaluate(() => { window.__confirmText = null; const c = window.confirm; window.confirm = m => { window.__confirmText = m; return false; }; });
await p.evaluate(() => window.pgDelete('VLC002'));
ok('Deleting an original warns that reposts point at it', /repost row/.test(await p.evaluate(() => window.__confirmText)));
await p.screenshot({ path: OUT + '/4-monitor.png', fullPage: true });

const wide = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok('No sideways scroll on desktop', wide <= 2, wide);
await p.close();

// ─────────────────────────────────────────────────────────────
section('On the phone — the media team on the move');
const ph = await open({ width: 390, height: 844 });
await ph.click('text=Paste week plan');
await ph.fill('#pgPlanText', PLAN);
await ph.waitForTimeout(100);
const phWide = await ph.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok('Paste dialog fits the phone', phWide <= 2, phWide);
await ph.screenshot({ path: OUT + '/5-phone-paste.png', fullPage: true });
await ph.click('#pgSave');
await ph.waitForTimeout(150);
const phWide2 = await ph.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok('Sheet on the phone does not scroll sideways', phWide2 <= 2, phWide2);
await ph.screenshot({ path: OUT + '/6-phone-sheet.png', fullPage: true });
await ph.click('.pg-bar .tk-sbtn:nth-child(4)');
await ph.screenshot({ path: OUT + '/7-phone-upcoming.png', fullPage: true });
await ph.close();

await browser.close();
const real = errors.filter(e => !/^(ok|FAIL)/.test(e));
console.log(errors.length ? `\n${errors.length} problem(s)` : '\nAll good.');
process.exit(errors.length ? 1 : 0);
