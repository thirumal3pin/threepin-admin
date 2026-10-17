// The Shoot & Media calendar, in a browser: shoots, edit plans and posts on one calendar in their own
// colours, one kind on its own, one person's calendar, week and month, desk and phone, light and dark.
//
//   node tests/calendar-preview.mjs [outDir]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStages } from '../track-assets/track-pipeline.js';

const OUT = process.argv[2] || 'tests/out/calendar';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const H = 3600000, D = 24 * H;
const T = 't_3pinrealty';
const ST = defaultStages();
const sid = key => ST.find(s => s.key === key).id;
const day0 = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
const at = (d, h, m = 0) => day0 + d * D + h * H + m * 60000;
const NOW = Date.now();

const L = o => ({ tenantId: T, media: {}, createdAt: NOW - 20 * D, updatedAt: NOW - D, stageChangedAt: NOW - 2 * D, ...o });
const LONG = '2 Grounds with an individual house in Shenoy Nagar, corner plot, east facing, near the metro';
const LISTINGS = [
  L({ id: 'L1', title: 'Velachery 2BHK', propertyCode: 'VLCA002', location: 'Velachery', stageId: sid('shoot_scheduled'), shootAt: at(0, 11), shootAssignee: 'Rajesh', shootAssigneeEmail: 'rajesh@3pin.in' }),
  L({ id: 'L2', title: 'Adyar flat', propertyCode: 'ADYR0001', location: 'Adyar', stageId: sid('shoot_scheduled'), shootAt: at(0, 11, 30), shootAssignee: 'Kumar Studio' }),
  L({ id: 'L3', title: LONG, propertyCode: 'ECR0009', stageId: sid('shoot_done'), shootAt: at(-1, 10), shootDoneAt: at(-1, 12), shootAssignee: 'Rajesh',
    cuts: {
      igStory: { status: 'planned', by: 'Anu', planAt: day0, dueAt: day0 + 2 * D },
      igReel: { status: 'planned', by: 'Anu', planAt: day0, dueAt: day0 + 2 * D },
      yt: { status: 'active', by: 'Anu', planAt: day0 - 3 * D, dueAt: day0 - D, startedAt: at(-3, 10) },
      collab: { status: 'active', by: 'Anu', startedAt: at(0, 9) }   // started with no plan days
    }, forPlan: { igStory: true, igReel: true, yt: true, collab: true } }),
  L({ id: 'L4', title: 'Plot, Kelambakkam', stageId: sid('shoot_scheduled'), shootAt: at(-3, 9), shootAssignee: 'Rajesh', shootAssigneeEmail: 'rajesh@3pin.in' }),
  // A busy day: more than a month's day can show.
  ...[8, 13, 15, 17].map((h, i) => L({ id: 'B' + i, title: 'Busy-day flat ' + (i + 1), stageId: sid('shoot_scheduled'), shootAt: at(0, h), shootAssignee: 'Kumar Studio' })),
  L({ id: 'L9', title: 'Dropped villa', stageId: sid('dropped'), shootAt: at(1, 10), dropReason: 'price_unrealistic' })   // not on the calendar
];
const mk = o => ({ tenantId: T, channels: {}, brochure: { done: false }, acres99: { status: 'pending' }, website: { status: 'pending' }, createdAt: NOW - 5 * D, ...o });
const TRACKERS = [
  mk({ id: 'pA', propertyCode: 'VLCA002', title: 'Velachery 2BHK', channels: { igReel: { status: 'live', at: at(0, 8), liveAt: at(0, 8), url: 'https://instagram.com/reel/a' } } }),
  mk({ id: 'pD', propertyCode: 'ADYR0001', title: 'Adyar flat', channels: { igReel: { status: 'scheduled', at: at(0, 19) }, fbReel: { status: 'scheduled', at: at(0, 19) } } }),
  mk({ id: 'pF', propertyCode: 'ECR0009', title: LONG, channels: { yt: { status: 'yet', day: day0 } } }),
  mk({ id: 'pP', reference: 'Mylapore plan line', plannedDate: day0 })
];

const STUB = `
window.trackFirebase = {
  savePosting: async () => {}, savePostings: async () => {}, deletePosting: async () => {},
  saveListing: async () => {}, deleteListing: async () => {}, savePipeline: async () => {}, patchLead: async () => {},
  saveTrackConfig: async () => {}, getInventory: async () => [], getListingHistory: async () => [], saveHistory: async () => {}, deleteHistory: async () => {},
  getPropertyInternalNotes: async () => '', getLeadConversation: async () => null
};
window.trackAuth = { login: async () => {}, logout: async () => {}, getTenantId: () => '${T}' };
setTimeout(() => {
  window.onTrackAuthChange({ email: 'admin@example.com' }, '${T}');
  window.applyTrackPipelineSnapshot(${JSON.stringify(ST)});
  window.applyTrackTeamSnapshot({ a: { email: 'rajesh@3pin.in' }, b: { email: 'anu@3pin.in' } });
  window.applyTrackConfigSnapshot({ editors: ['Anu'] });
  window.applyListingsSnapshot(${JSON.stringify(LISTINGS)});
  window.applyTrackLeadsSnapshot([]);
  window.applyPostingSnapshot(${JSON.stringify(TRACKERS)});
  window.__ready = true;
}, 0);`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const browser = await chromium.launch();
const errors = [];
const ok = (l, c, d) => { if (c) console.log('  ok  ' + l); else { errors.push(l + (d !== undefined ? ' — ' + d : '')); console.log('  FAIL ' + l + (d !== undefined ? ' — ' + d : '')); } };

async function open(viewport, { theme = 'light', keep } = {}) {
  const ctx = keep || await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${viewport.width}px: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('dialog', d => d.accept());
  if (!keep) await ctx.addInitScript(([th]) => { if (!sessionStorage.getItem('seeded')) { try { localStorage.clear(); localStorage.setItem('crmTheme', th); } catch (e) {} sessionStorage.setItem('seeded', '1'); } }, [theme]);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'track.local') return route.abort();
    if (url.pathname === '/track-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://track.local/propertytrack.html?nav=calendar');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  return page;
}
// What the calendar shows (visible events only), by kind and title.
const shown = page => page.evaluate(() => [...document.querySelectorAll('#calendarView .tc-ev')].filter(e => e.offsetParent)
  .map(e => ({ k: (e.className.match(/t-(shoot|edit|post)/) || [])[1], late: e.classList.contains('late'), done: e.classList.contains('done'), t: e.textContent.replace(/\s+/g, ' ').trim() })));
const noSideways = page => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const off = [...document.querySelectorAll('#calendarView *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > vw + 1).map(e => e.className).slice(0, 3);
  return { page: document.documentElement.scrollWidth <= vw + 1, off };
});

// ── Desk ──
console.log('Shoot & Media calendar — desk');
let ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { try { localStorage.clear(); } catch (e) {} sessionStorage.setItem('seeded', '1'); } });
let page = await open({ width: 1440, height: 1000 }, { keep: ctx });

ok('The menu has Calendar under Shoot & Media, and it is the one lit', await page.evaluate(() => { const a = [...document.querySelectorAll('.appnav a, .appnav button, nav a, nav button')].find(e => /^\s*Calendar\s*$/.test(e.textContent)); return !!a && /\b(on|active|is-active)\b/.test(a.className + ' ' + (a.parentElement || {}).className) || a && a.getAttribute('aria-current') === 'page'; }));
ok('…its view is the one showing', await page.evaluate(() => getComputedStyle(document.getElementById('calendarView')).display !== 'none' && getComputedStyle(document.getElementById('boardView')).display === 'none'));
let ev = await shown(page);
const has = (k, re) => ev.some(e => e.k === k && re.test(e.t));
ok('Week: shoots in blue', has('shoot', /Velachery 2BHK/) && has('shoot', /Adyar flat/), JSON.stringify(ev.map(e => e.k + ':' + e.t.slice(0, 30))));
ok('…edit plans in purple, outlets planned together as one ("Story + Reel")', ev.filter(e => e.k === 'edit' && /Story \+ Reel/.test(e.t)).length >= 1);
ok('…posts in green: scheduled, planned, a plan line with no outlet yet, and live (done)', has('post', /Adyar flat/) && has('post', /Mylapore plan line/) && ev.some(e => e.k === 'post' && e.done && /Velachery/.test(e.t)));
ok('…two outlets going out together are one post', ev.filter(e => e.k === 'post' && /Adyar flat/.test(e.t)).length === 1);
ok('…a dropped card\'s shoot is not on it', !ev.some(e => /Dropped villa/.test(e.t)));
const lanes = await page.evaluate(() => [...document.querySelectorAll('.tc-wc.today .tc-blk.t-shoot')].filter(b => /Velachery|Adyar flat/.test(b.textContent)).map(b => b.getBoundingClientRect()).map(r => [Math.round(r.left), Math.round(r.width)]));
ok('…two shoots at once sit side by side, not on top of each other', lanes.length >= 2 && lanes[0][0] !== lanes[1][0], JSON.stringify(lanes));
const sum = await page.textContent('.tc-sum');
ok('The count of each kind, and the late', /\d+ shoots?/.test(sum) && /\d+ edits?/.test(sum) && /\d+ posts?/.test(sum), sum);
ok('No sideways scroll', (await noSideways(page)).page, JSON.stringify(await noSideways(page)));
await page.screenshot({ path: `${OUT}/desk-week.png`, fullPage: true });

// One kind on its own
await page.click('.tc-seg button:has-text("Shoots")');
await page.waitForTimeout(150);
ev = await shown(page);
ok('Shoots only: nothing else', ev.length > 0 && ev.every(e => e.k === 'shoot'), JSON.stringify(ev.map(e => e.k)));
await page.click('.tc-seg button:has-text("Edits")');
await page.waitForTimeout(150);
ev = await shown(page);
ok('Edits only', ev.length > 0 && ev.every(e => e.k === 'edit'));
await page.click('.tc-seg button:has-text("All")');
await page.waitForTimeout(150);

// One person's calendar
const people = await page.$$eval('.tc-who option', os => os.map(o => o.value));
ok('The person list: everyone with work on the calendar', ['Anu', 'Kumar Studio', 'Rajesh'].every(p => people.includes(p)) && people[0] === '', JSON.stringify(people));
await page.selectOption('.tc-who select', 'Anu');
await page.waitForTimeout(150);
ev = await shown(page);
ok('Anu\'s calendar: her edits, and the posts of her property — no shoots, no one else\'s posts', ev.length > 0 && ev.every(e => e.k === 'edit' || (e.k === 'post' && /Shenoy/.test(e.t))) && !ev.some(e => /Adyar|Mylapore/.test(e.t)), JSON.stringify(ev.map(e => e.k + ':' + e.t.slice(0, 24))));
ok('…it says whose it is', /Anu’s calendar/.test(await page.textContent('.tc-sum')));
await page.selectOption('.tc-who select', 'Rajesh');
await page.waitForTimeout(150);
ev = await shown(page);
ok('Rajesh\'s calendar: his shoots (by his teammate name), not Kumar Studio\'s', ev.some(e => e.k === 'shoot' && /Velachery/.test(e.t)) && !ev.some(e => /Busy-day|Adyar flat/.test(e.t)), JSON.stringify(ev.map(e => e.t.slice(0, 24))));
await page.selectOption('.tc-who select', '');
await page.waitForTimeout(150);

// The month
await page.click('.tc-seg button:has-text("Month")');
await page.waitForTimeout(200);
const mo = await page.evaluate(() => {
  const t = document.querySelector('.tc-md.today');
  return { cells: document.querySelectorAll('.tc-md').length, todayChips: t ? t.querySelectorAll('.tc-chip').length : -1, more: t ? (t.querySelector('.tc-more') || {}).textContent : '', pane: !!document.querySelector('.tc-daypane') };
});
ok('Month: whole weeks', mo.cells % 7 === 0 && mo.cells >= 28, mo.cells);
ok('…a busy day shows three and says how many more', mo.todayChips === 3 && /^\+\d+ more$/.test(mo.more || ''), JSON.stringify(mo));
ok('…today is chosen, and listed in full under the month', mo.pane && (await page.$$('.tc-daypane .tc-row')).length > 3);
ok('…a late edit is marked late', (await page.$$('.tc-month .tc-ev.t-edit.late, .tc-daypane .tc-ev.t-edit.late')).length > 0 || (await page.$$('.tc-mdots .late')).length > 0);
await page.screenshot({ path: `${OUT}/desk-month.png`, fullPage: true });
// Pick another day
await page.evaluate(() => { const d = [...document.querySelectorAll('.tc-md:not(.today):not(.other)')][0]; d && d.click(); });
await page.waitForTimeout(150);
ok('Picking a day lists that day', await page.evaluate(() => !!document.querySelector('.tc-md.sel:not(.today)') && !!document.querySelector('.tc-daypane')));
// Forward a month: nothing picked, a hint
await page.click('.tc-nav button[aria-label="Forward"]');
await page.waitForTimeout(150);
ok('Next month: the hint, and Today to come back', /Pick a day/.test(await page.textContent('#calendarView')) && !(await page.$eval('.tc-nav button:has-text("Today")', b => b.disabled)));
await page.click('.tc-nav button:has-text("Today")');
await page.waitForTimeout(150);

// Opening
await page.click('.tc-daypane .tc-row.t-shoot >> nth=0');
await page.waitForTimeout(300);
ok('A shoot opens its card', await page.evaluate(() => document.getElementById('dp') && document.getElementById('dp').classList.contains('open')));
await page.evaluate(() => window.closeDetail && window.closeDetail());
await page.waitForTimeout(200);
await page.click('.tc-daypane .tc-row.t-post:has-text("Adyar flat")');
await page.waitForTimeout(400);
const landed = await page.evaluate(() => ({
  shown: getComputedStyle(document.getElementById('postingView')).display !== 'none',
  sheet: !!document.querySelector('#postingView .ps[aria-label="Posting sheet"]'),
  week: !!document.querySelector('#postingView .wk'),
  row: (document.getElementById('pg-pD') || {}).className || ''
}));
ok('A post opens Posting\'s Sheet — the week strip shown, its row lit up', landed.shown && landed.sheet && landed.week && /ps-row/.test(landed.row) && /pg-flash/.test(landed.row), JSON.stringify(landed));

// An edit opens the editor's view; its "In Posting →" closes the card and shows the Sheet
await page.evaluate(() => toggleView('calendar'));
await page.waitForTimeout(150);
ok('An edit started with no plan days is on the calendar, on the day it was started', (await page.$$('.tc-daypane .tc-row.t-edit')).length >= 1 && /Collab/.test(await page.textContent('.tc-daypane')));
await page.click('.tc-daypane .tc-row.t-edit >> nth=0');
await page.waitForTimeout(400);
const ev2 = await page.evaluate(() => ({ ed: document.getElementById('dp').classList.contains('dp-ed'), when: (document.querySelector('#dpBody .ed-dt td') || {}).textContent || '' }));
ok('…an edit opens the card\'s editor\'s view', ev2.ed, JSON.stringify(ev2));
ok('…a shoot already done is not called late there', !/late|ago/.test(ev2.when), ev2.when);
await page.click('#dpBody button:has-text("In Posting")');
await page.waitForTimeout(500);
ok('…"In Posting →" closes the card and shows that post on the Sheet', await page.evaluate(() => !document.getElementById('dp').classList.contains('open') && getComputedStyle(document.getElementById('postingView')).display !== 'none' && !!document.querySelector('#postingView .ps-row.pg-flash')));

// Kept on the device
await page.evaluate(() => toggleView('calendar'));
await page.click('.tc-seg button:has-text("Posts")');
await page.selectOption('.tc-who select', 'Anu');
await page.reload();
await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
await page.evaluate(() => toggleView('calendar', true));
await page.waitForTimeout(300);
ok('After a reload: month, Posts, Anu — as left', await page.evaluate(() => !!document.querySelector('.tc-month') && /Posts/.test(document.querySelector('.tc-seg .tk-sbtn.on:not([onclick*="calSpan"])').textContent) && document.querySelector('.tc-who select').value === 'Anu'));
await page.evaluate(() => { calPerson(''); calType('all'); calSpan('week'); });

// The search box narrows it too
await page.fill('#search, .srch-wrap input', 'velachery');
await page.waitForTimeout(250);
ev = await shown(page);
ok('The search box narrows the calendar', ev.length > 0 && ev.every(e => /Velachery/.test(e.t)), JSON.stringify(ev.map(e => e.t.slice(0, 20))));
await page.fill('#search, .srch-wrap input', '');
await ctx.close();

// A smaller desk: the seven days still fit
page = await open({ width: 1024, height: 800 });
ok('1024px: the week fits, no sideways scroll', (await noSideways(page)).page, JSON.stringify(await noSideways(page)));
await page.screenshot({ path: `${OUT}/desk1024-week.png`, fullPage: true });
// Dark
page = await open({ width: 1440, height: 1000 }, { theme: 'dark' });
await page.evaluate(() => calSpan('month'));
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/desk-month-dark.png`, fullPage: true });
await page.evaluate(() => calSpan('week'));
await page.waitForTimeout(150);
await page.screenshot({ path: `${OUT}/desk-week-dark.png` });

// ── Phone ──
console.log('Phone');
page = await open({ width: 390, height: 844 });
const ph = await page.evaluate(() => ({ grid: getComputedStyle(document.querySelector('.tc-week')).display, list: document.querySelectorAll('.tc-aday').length }));
ok('Phone week: a list of the seven days, not seven columns', ph.grid === 'none' && ph.list === 7, JSON.stringify(ph));
ok('…no sideways scroll', (await noSideways(page)).page && !(await noSideways(page)).off.length, JSON.stringify(await noSideways(page)));
ok('…thumb-sized controls', await page.evaluate(() => [...document.querySelectorAll('.tc-head button, .tc-head select')].filter(b => b.offsetParent).every(b => b.getBoundingClientRect().height >= 32)));
await page.screenshot({ path: `${OUT}/phone-week.png`, fullPage: true });
await page.evaluate(() => calSpan('month'));
await page.waitForTimeout(200);
const pm = await page.evaluate(() => ({ chips: [...document.querySelectorAll('.tc-mchips')].some(c => c.offsetParent), dots: document.querySelectorAll('.tc-md.today .tc-mdots .tc-key').length }));
ok('Phone month: dots, not chips', !pm.chips && pm.dots >= 2, JSON.stringify(pm));
ok('…no sideways scroll', (await noSideways(page)).page && !(await noSideways(page)).off.length, JSON.stringify(await noSideways(page)));
await page.screenshot({ path: `${OUT}/phone-month.png`, fullPage: true });

await browser.close();
if (errors.length) { console.log('\nFAILED:\n  ' + errors.join('\n  ')); process.exit(1); }
console.log(`\nNo page errors. Screenshots in ${OUT}`);
