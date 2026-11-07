// ═══════ META ADS LEADS, CLICKED THROUGH ═══════
//
//   node tests/meta-leads-preview.mjs
//
// The real CRM page with the Meta Ads Leads screens, wired to the REAL server code
// (api/_meta-leads.js) over the in-memory Firestore. Google Sheets is a stand-in that answers for
// the three REAL sheet ids (so Setup's "Add these three" is tested as it will run) with rows laid
// out like the real sheets but made-up people (tests/_meta-leads-fixtures.mjs). Start to end:
// an empty setup → the three sheets added and mapped to KDBMC001 / SHR0001 → a sheet that is not
// shared → Save → Read → people, duplicates, CRM summaries → analysis → a non-manager's view →
// and nothing written anywhere but the setup. Screenshots land in tests/out/meta-leads-*.png.

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metaLeadsAction } from '../api/_meta-leads.js';
import { createFakeDb } from './_fake-firestore.mjs';
import { SHEETS, CRM_LEADS, STAGES, NOW } from './_meta-leads-fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'tests/out');
mkdirSync(OUT, { recursive: true });
const T = 't_3pinrealty';
const SA = 'firebase-adminsdk-fbsvc@pin-realty.iam.gserviceaccount.com';
// The real ids, as Setup suggests them.
const REAL = { KDB: '17kaZCqDhOszTBwBkj8qEGHHsy7E1TBRjAYAWOO2aMk0', KDO: '19SD6zrkLD84KHCMQ6ZAVA3D2OHJqFExkEThXIfA1BcY', KOY: '19N-RVhJUQ-HNeEvZK0nG_5aSWW78gpA8mHfbObXpbfk' };
const LOCKED = '1LOCKEDnotSharedWithTheAppDDDDDDDDDDDDDDDDD';

function sheetsFetch() {
  const byId = { [REAL.KDB]: SHEETS.KDB, [REAL.KDO]: SHEETS.KDO, [REAL.KOY]: SHEETS.KOY };
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetch = async url => {
    const u = new URL(url); calls.push(u.pathname + u.search);
    const m = u.pathname.match(/\/v4\/spreadsheets\/([^/:]+)(\/values:batchGet)?$/);
    if (m[1] === LOCKED) return res(403, { error: { message: 'The caller does not have permission' } });
    const sh = byId[m[1]];
    if (!sh) return res(404, { error: { message: 'Requested entity was not found.' } });
    if (!m[2]) return res(200, { properties: { title: sh.title }, sheets: sh.tabs.map(t => ({ properties: { sheetId: t.gid, title: t.title } })) });
    return res(200, { valueRanges: u.searchParams.getAll('ranges').map(r => {
      const mm = r.match(/^'((?:[^']|'')+)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      const tab = sh.tabs.find(t => t.title === mm[1]);
      const rows = tab ? tab.values.slice(Number(mm[3]) - 1, Number(mm[5])) : [];
      return { values: rows.map(x => x.slice(0, mm[2] === 'A' && mm[4] === 'B' ? 2 : 52)) };
    }) });
  };
  return { fetch, calls };
}

const INV = [
  { id: 'KDBMC001', propertyCode: 'KDBMC001', name: 'Commercial Building for Rent', location: 'Kodambakkam' },
  { id: 'SHR0001', propertyCode: 'SHR0001', name: 'Shriram Codename King Life', location: 'Koyambedu' },
  { id: 'ANR005', propertyCode: 'ANR005', name: 'Brand-New Commercial Building for Rent in Anna Nagar', location: 'Anna Nagar' }
];
const LEADS = CRM_LEADS.map(l => ({ tenantId: T, ...l })).concat([
  { id: 'C3', tenantId: T, name: 'Someone Else', phone: '9000000001', stageId: 'new', createdAt: NOW - 86400000, updatedAt: NOW - 86400000 }
]);
const stubFor = (email) => `
window.__saves = 0;
window.crmFirebase = {
  saveLead: async () => { window.__saves++; }, deleteLead: async () => { window.__saves++; }, getLeadNotes: async () => [], getLeadHistory: async () => [],
  saveNote: async () => { window.__saves++; }, deleteNoteDoc: async () => {}, saveHistory: async () => {}, savePipeline: async () => {},
  getBotConfig: async () => null, saveBotConfig: async () => {}, saveEnquiryTypes: async () => {},
  saveProperties: async () => {}, saveFollowupDigestSettings: async () => {}, saveDashboardEmailSettings: async () => {},
  releaseLeadField: async () => {}, getLeadTailorTalk: async () => null, updateLeadAi: async () => {},
  saveAutomationSettings: async () => {}, saveView: async () => {}, deleteView: async () => {},
  setLeadFields: async () => { window.__saves++; }, setLeadAgents: async () => { window.__saves++; },
  getInventory: async () => (${JSON.stringify(INV)})
};
window.crmTodayOpens = { load: async () => ({}), save: async () => {} };
window.crmAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => '${T}' };
window.onCrmAuthChange({ email: '${email}' });
window.applyPipelineSnapshot(${JSON.stringify(STAGES)});
window.applyEnquiryTypesSnapshot(['Property Enquiry']);
window.applyAutomationSettingsSnapshot({ enabled: false });
if (window.applyViewsSnapshot) window.applyViewsSnapshot({});
window.applyTeamSnapshot({ admin: { email: 'admin@threepin.in' }, swami: { email: 'swami@threepin.in' }, thirumal: { email: 'thirumal@threepin.in' } });
window.applyLeadsSnapshot(${JSON.stringify(LEADS)});
window.__ready = true;
`;

const db = createFakeDb();
await db.collection('taskConfigs').doc(T).set({ managers: ['admin@threepin.in'] });
const sheets = sheetsFetch();
const deps = { db, fetch: sheets.fetch, serviceAccount: { client_email: SA }, token: async () => 'tok', now: () => Date.now() };
const apiLog = [];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/json', '.woff2': 'font/woff2' };
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); errors.push(label); }
};

async function openPage(browser, { email = 'admin@threepin.in', viewport = { width: 1366, height: 900 }, scheme = 'light', path = '?nav=ml-setup' } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, hasTouch: viewport.width < 500 });
  try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://crm.local' }); } catch (e) { /* */ }
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => errors.push(`${viewport.width}px pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`${viewport.width}px console: ${m.text()}`); });
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'crm.local') return route.abort();
    if (u.pathname === '/crm-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: stubFor(email) });
    if (u.pathname === '/api/meta-leads') {
      const body = JSON.parse(route.request().postData() || '{}');
      apiLog.push({ email, action: body.action });
      const [r, status] = await metaLeadsAction({ tenantId: T, email }, body, deps);
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(r) });
    }
    if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    const f = join(ROOT, decodeURIComponent(u.pathname));
    if (!existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
  });
  await page.goto('http://crm.local/crm.html' + path);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  return { page, ctx };
}
const text = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; }, sel);
const shot = (page, name) => page.screenshot({ path: join(OUT, 'meta-leads-' + name + '.png'), fullPage: true });
const clickText = async (page, sel, t) => { await page.locator(sel, { hasText: t }).first().click(); await page.waitForTimeout(250); };
const waitText = (page, sel, re, timeout = 8000) => page.waitForFunction(([s, r]) => { const e = document.querySelector(s); return e && new RegExp(r).test(e.textContent); }, [sel, re.source], { timeout });
const overflow = page => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));

const browser = await chromium.launch({ channel: 'chrome' });
console.log('Meta Ads Leads — clicked through');
try {
  // ── 1. A manager opens Setup: one line, sheet link → property, the Koyambedu sheet filled in ──
  let { page, ctx } = await openPage(browser);
  await waitText(page, '#metaLeadsView', /Lead sheets → properties/);
  await page.waitForFunction(() => document.querySelector('.ml-addline .ppk-in') && /SHR0001/.test(document.querySelector('.ml-addline .ppk-in').value), null, { timeout: 8000 });
  ok('The rail has Meta Ads Leads with its four screens', await page.evaluate(() => ['meta-leads', 'ml-dupes', 'ml-analysis', 'ml-setup'].every(id => document.body.innerHTML.includes(`'${id}'`) || document.body.innerHTML.includes(`"${id}"`))));
  ok('Test mode is said on the page', /Test mode/.test(await text(page, '.ml-test')));
  ok('The address to share sheets with is in the footnote', (await text(page, '.ml-foot')).includes(SA));
  ok('First time: the Koyambedu link and SHR0001 Shriram Codename King Life are filled in',
    (await page.$eval('.ml-addline .ml-link-in', e => e.value)).includes(REAL.KOY) && await page.$eval('.ml-addline .ppk-in', e => e.value) === 'SHR0001 — Shriram Codename King Life');
  ok('The property is picked from the inventory list', (await page.$$eval('.ml-addline select.ml-psel option', o => o.map(x => x.value))).join(',') === ',ANR005,KDBMC001,SHR0001');
  await shot(page, '1-setup-empty');

  // ── 2. Connect: checked with Google, saved at once ──
  await clickText(page, '.ml-addline .ml-btn', 'Connect');
  await waitText(page, '.ml-maplist', /Koyambedu - Leads/);
  let saved = (await db.collection('metaLeadConfigs').doc(T).get()).data();
  ok('Saved at once: Koyambedu - Leads → SHR0001, its tab', JSON.stringify(saved.sources.map(s => [s.title.trim(), s.propertyCode, s.tabs.map(t => t.title)])) === JSON.stringify([['Koyambedu - Leads', 'SHR0001', ['Sheet1']]]));
  ok('The add line is cleared for the next sheet', await page.$eval('.ml-addline .ml-link-in', e => e.value) === '' && await page.$eval('.ml-addline select.ml-psel', e => e.value) === '');
  // Then the two KDBMC001 sheets: paste the link, type to find the property, pick it, Connect.
  for (const id of [REAL.KDB, REAL.KDO]) {
    await page.fill('.ml-addline .ml-link-in', 'https://docs.google.com/spreadsheets/d/' + id + '/edit?gid=0#gid=0');
    await page.fill('.ml-addline .ppk-in', 'kdbmc');
    await page.locator('.ml-addline .ppk-opt', { hasText: 'KDBMC001' }).first().click();
    await clickText(page, '.ml-addline .ml-btn', 'Connect');
    await page.waitForFunction(n => document.querySelectorAll('.ml-maprow').length === n, id === REAL.KDB ? 2 : 3, { timeout: 8000 });
  }
  saved = (await db.collection('metaLeadConfigs').doc(T).get()).data();
  ok('Three sheets saved, each with its property and tabs', JSON.stringify(saved.sources.map(s => [s.title.trim(), s.propertyCode, s.tabs.map(t => t.title)])) ===
    JSON.stringify([['Koyambedu - Leads', 'SHR0001', ['Sheet1']], ['office space - Kodambakkam', 'KDBMC001', ['Sheet1', 'Sheet3']], ['Kodabakkam office', 'KDBMC001', ['Sheet1']]]), saved.sources.map(s => [s.title, s.propertyCode]));
  ok('Saved by the manager', saved.updatedBy === 'admin@threepin.in');
  ok('Each line shows its property in the picker', JSON.stringify(await page.$$eval('.ml-maprow .ppk-in', els => els.map(e => e.value))) ===
    JSON.stringify(['SHR0001 — Shriram Codename King Life', 'KDBMC001 — Commercial Building for Rent', 'KDBMC001 — Commercial Building for Rent']));
  await shot(page, '2-setup-connected');

  // ── 3. Mistakes, said plainly ──
  await page.fill('.ml-addline .ml-link-in', `https://docs.google.com/spreadsheets/d/${LOCKED}/edit#gid=0`);
  await clickText(page, '.ml-addline .ml-btn', 'Connect');
  ok('No property picked: asked for one', /Pick the property/.test(await text(page, '.ml-map .ml-alert')));
  await page.fill('.ml-addline .ppk-in', 'ANR005');
  await page.locator('.ml-addline .ppk-opt', { hasText: 'ANR005' }).first().click();
  await clickText(page, '.ml-addline .ml-btn', 'Connect');
  await waitText(page, '.ml-map', /share it with/);
  ok('A sheet not shared: the address to share with, with a Copy button', (await text(page, '.ml-map .ml-alert')).includes(SA) && !!(await page.$('.ml-map .ml-alert .ml-btn')));
  await shot(page, '2b-not-shared');
  await page.fill('.ml-addline .ml-link-in', `https://docs.google.com/spreadsheets/d/${REAL.KOY}/edit`);
  await clickText(page, '.ml-addline .ml-btn', 'Connect');
  ok('A sheet already connected is refused', /already connected/.test(await text(page, '.ml-map .ml-alert')));
  ok('…and nothing extra was saved', (await db.collection('metaLeadConfigs').doc(T).get()).data().sources.length === 3);
  // Changing a line's property is saved at once (and changed back).
  await page.locator('.ml-maprow').nth(2).locator('.ppk-in').fill('ANR005');
  await page.locator('.ml-maprow').nth(2).locator('.ppk-opt', { hasText: 'ANR005' }).first().click();
  await page.waitForFunction(() => !document.querySelector('.ml-maprow .fa-spin'), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  ok('A line\'s property changed: saved at once', (await db.collection('metaLeadConfigs').doc(T).get()).data().sources[2].propertyCode === 'ANR005');
  await page.locator('.ml-maprow').nth(2).locator('.ppk-in').fill('KDBMC001');
  await page.locator('.ml-maprow').nth(2).locator('.ppk-opt', { hasText: 'KDBMC001' }).first().click();
  await page.waitForTimeout(400);
  ok('…and back', (await db.collection('metaLeadConfigs').doc(T).get()).data().sources[2].propertyCode === 'KDBMC001');

  // ── 5. Read the sheets ──
  await clickText(page, '.ml-btn', 'Read the sheets');
  await page.waitForFunction(() => !/Reading the sheets/.test(document.querySelector('#metaLeadsView').textContent), null, { timeout: 8000 });
  await page.evaluate(() => MetaLeads.go('ml-setup'));
  await page.waitForFunction(() => /9 leads/.test(document.querySelector('.ml-maplist') && document.querySelector('.ml-maplist').textContent), null, { timeout: 8000 });
  ok('Each line shows its leads at the last read', JSON.stringify(await page.$$eval('.ml-maprow .ml-c-status', els => els.map(e => e.textContent.trim()))) === JSON.stringify(['4 leads', '9 leads', '2 leads']));
  // Details → Columns of Sheet3, with the header-less column flagged.
  await page.locator('.ml-maprow', { hasText: 'office space - Kodambakkam' }).locator('.ml-link', { hasText: 'Details' }).click();
  await page.waitForTimeout(250);
  await page.locator('.ml-tabrow', { hasText: 'Sheet3' }).locator('.ml-link').click();
  await page.waitForTimeout(250);
  const cols = await text(page, '.ml-cols');
  ok('Columns: what each one is read as, the one with no header flagged', /Assigned to/.test(cols) && /no header/.test(cols) && /Meta · phone/.test(cols), cols.slice(0, 200));
  await shot(page, '3-setup-columns');

  // ── 6. Leads ──
  await page.evaluate(() => MetaLeads.go('meta-leads'));
  await page.waitForTimeout(300);
  const tileText = () => page.$$eval('.ml-tile', els => els.map(e => e.querySelector('.ml-tile-n').textContent.trim() + ' ' + e.querySelector('.ml-tile-l').textContent.trim()));
  const tiles = await tileText();
  ok('All properties: 15 enquiries, 12 people', tiles.includes('15 Enquiries (rows)') && tiles.includes('12 People'), tiles);
  ok('Duplicates (same property) 2, more than one property 1', tiles.includes('2 With duplicate rows (same property)') && tiles.includes('1 Enquired for more than one property'), tiles);
  ok('Already in the CRM 4, would be added new 8', tiles.includes('4 Already in the CRM') && tiles.includes('8 Would be added as new leads'), tiles);
  ok('Would reopen 1, revisited — priority 4', tiles.includes('1 Closed in the CRM, would reopen') && tiles.includes('4 Revisited — priority for the agent'), tiles);
  ok('Problems 3 (imported, flagged)', tiles.includes('3 Problems (imported, flagged)'), tiles);
  await shot(page, '4-leads-all');
  await clickText(page, '.ml-chip', 'KDBMC001');
  const kt = await tileText();
  ok('KDBMC001: 11 enquiries, 9 people', kt.includes('11 Enquiries (rows)') && kt.includes('9 People'), kt);
  // Arjun: three enquiries, a duplicate for KDBMC001, also Koyambedu.
  await clickText(page, '.ml-prow', 'Arjun');
  const det = await text(page, '.ml-person.open .ml-detail');
  ok('Arjun: every enquiry with date, time, sheet › tab, row, ad', /15 Oct 2026, 2:00 pm/.test(det) && /office space - Kodambakkam › Sheet1 · row 4/.test(det) && /20 Oct 2026, 2:56 pm/.test(det) && /5 days later/.test(det) && /Koyambedu - Leads › Sheet1/.test(det), det.slice(0, 300));
  ok('Arjun: what the team wrote, and "Swami" read as swami@threepin.in', /Swami → swami@threepin\.in/.test(det) && /Visiting today 12PM/.test(det) && /Purpose: gym/.test(det));
  ok('Arjun: not in the CRM — a sync would add him, marked Revisited and put first for the agent', /new lead for KDBMC001, SHR0001/.test(det) && /Revisited \(duplicate ad lead\)/.test(det));
  ok('Arjun\'s row says duplicate for KDBMC001', /Duplicate ×2/.test(await text(page, '.ml-person.open .ml-prow')));
  await shot(page, '5-person-arjun');
  // Saravana: already a CRM lead — his CRM summary right here.
  await clickText(page, '.ml-prow', 'Saravana');
  const sd = await text(page, '.ml-person.open .ml-detail');
  ok('Saravana: the CRM summary — lead, stage, agent, properties, AI summary', /Saravanan O V/.test(sd) && /Site Visit/.test(sd) && /Swami/.test(sd) && /ANR005/.test(sd) && /fitness studio/.test(sd), sd.slice(0, 400));
  ok('Saravana: "In CRM · would add KDBMC001"', /In CRM · would add KDBMC001/.test(await text(page, '.ml-person.open .ml-prow')));
  await shot(page, '6-person-in-crm');
  await clickText(page, '.ml-person.open .ml-btn', 'Open in the CRM');
  await page.waitForTimeout(400);
  ok('"Open in the CRM" opens the lead', await page.evaluate(() => document.getElementById('dp') && document.getElementById('dp').classList.contains('open')));
  await page.evaluate(() => typeof closeDetail === 'function' && closeDetail());
  // Priority for the agent: Arjun, Queen, Parinita (KDBMC001).
  await page.locator('.ml-chip.sm', { hasText: 'Priority for the agent' }).click();
  await page.waitForTimeout(250);
  const pri = await page.$$eval('.ml-person .ml-name', els => els.map(e => e.childNodes[0].textContent.trim()));
  ok('Priority for the agent (KDBMC001): Arjun, Parinita, Queen', JSON.stringify(pri.sort()) === JSON.stringify(['Arjun', 'Parinita', 'Queen']), pri);
  await clickText(page, '.ml-prow', 'Parinita');
  ok('Parinita: in the CRM, enquired again → the new enquiry added, marked Revisited, priority', /In CRM · enquired again/.test(await text(page, '.ml-person.open .ml-prow')) && /Revisited \(duplicate ad lead\)/.test(await text(page, '.ml-person.open .ml-detail')));
  await shot(page, '6b-priority');
  await page.locator('.ml-chip.sm', { hasText: /^All$/ }).click();
  await page.waitForTimeout(250);
  // Filters and search.
  await clickText(page, '.ml-chip', 'Problems');
  const probs = await page.$$eval('.ml-person .ml-name', els => els.map(e => e.textContent.trim()));
  ok('Problems (KDBMC001): Vijaya Rani (no phone), Mari Vel (Ramesh not on the team)', JSON.stringify(probs.sort()) === JSON.stringify(['Mari Vel', 'Vijaya Rani']), probs);
  await page.locator('.ml-chip.sm', { hasText: /^All$/ }).click();
  await page.waitForTimeout(250);
  await page.fill('.ml-bar .ml-search', 'gym');
  await page.waitForTimeout(400);
  const found = await page.$$eval('.ml-person .ml-name', els => els.map(e => e.textContent.trim()));
  ok('Search finds a word in a note', JSON.stringify(found.sort()) === JSON.stringify(['Arjun', 'Vijaya Rani']), found);
  await page.fill('.ml-bar .ml-search', '');
  await page.waitForTimeout(300);

  // ── 7. Duplicates ──
  await page.evaluate(() => MetaLeads.go('ml-dupes'));
  await page.waitForTimeout(300);
  await clickText(page, '.ml-chip', 'All properties');
  const dups = await page.$$eval('.ml-dupe', els => els.map(e => e.querySelector('.ml-dupe-h').textContent.replace(/\s+/g, ' ').trim()));
  ok('Duplicates: Queen and Arjun for KDBMC001 — Arjun\'s Koyambedu enquiry is not one', dups.length === 2 && /Queen.*KDBMC001/.test(dups[0]) && /Arjun.*KDBMC001.*also enquired for SHR0001/.test(dups[1]), dups);
  ok('Queen: two rows three weeks apart, through two sheets', /21 days later/.test(await text(page, '.ml-dupe')) && /Kodabakkam office › Sheet1/.test(await text(page, '.ml-dupe')));
  await shot(page, '7-duplicates');
  await clickText(page, '.ml-chip', 'SHR0001');
  ok('SHR0001: no duplicates', /No one has enquired twice for SHR0001/.test(await text(page, '#metaLeadsView')));
  // Aswin: Lost in the CRM, a new enquiry → reopen.
  await page.evaluate(() => MetaLeads.go('meta-leads'));
  await page.waitForTimeout(250);
  await clickText(page, '.ml-prow', 'Aswin');
  ok('Aswin: Lost in the CRM, enquired again → would reopen, marked duplicate, with history', /Would reopen \(was Lost\)/.test(await text(page, '.ml-person.open .ml-prow')) && /reopen.*mark it duplicate.*history/.test(await text(page, '.ml-person.open .ml-detail')) && /Budget too low/.test(await text(page, '.ml-person.open .ml-detail')));
  ok('Arjun under SHR0001: not marked priority (his repeats are for KDBMC001)', !/Revisited · priority/.test(await page.locator('.ml-person', { hasText: 'Arjun' }).first().textContent()));
  await shot(page, '7b-reopen');
  await page.evaluate(() => MetaLeads.go('ml-dupes'));
  await page.waitForTimeout(250);

  // ── 8. Analysis ──
  await page.evaluate(() => MetaLeads.go('ml-analysis'));
  await page.waitForTimeout(300);
  await clickText(page, '.ml-chip', 'KDBMC001');
  const an = await text(page, '#metaLeadsView');
  ok('Analysis: per day, per ad, per sheet/tab, platform, rating, assigned, CRM stage, each form question',
    ['Enquiries per day', 'By ad', 'Video 1', 'By sheet and tab', 'By platform', 'Instagram', 'Rating', 'Assigned to', 'Swami', 'Site Visit', 'Form: Expected area'].every(w => an.includes(w)), an.slice(0, 300));
  await shot(page, '8-analysis');
  await clickText(page, '.ml-chip', 'SHR0001');
  ok('SHR0001 analysis: its own questions', /Form: What is your budget\?/.test(await text(page, '#metaLeadsView')) && /3 cr to 5 cr/.test(await text(page, '#metaLeadsView')));
  ok('No sideways scroll (laptop)', (await overflow(page)) <= 1, await overflow(page));

  // ── 9. Nothing written ──
  ok('The CRM saved nothing (no lead, no note)', (await page.evaluate(() => window.__saves)) === 0);
  ok('Only the setup was written to the database', JSON.stringify([...db._store.keys()].sort()) === JSON.stringify([`metaLeadConfigs/${T}`, `taskConfigs/${T}`]), [...db._store.keys()]);
  ok('Google was only read (no cell written)', sheets.calls.every(c => !/:batchUpdate|:append|:clear/.test(c)));
  await ctx.close();

  // ── 10. A team member who is not a manager ──
  ({ page, ctx } = await openPage(browser, { email: 'swami@threepin.in', path: '?nav=ml-setup' }));
  await waitText(page, '#metaLeadsView', /Only a manager can change this list/);
  ok('Not a manager: Setup is read-only (no add line, no pickers, no remove)', !(await page.$('.ml-addline')) && !(await page.$('.ml-maprow select')) && !(await page.$('.ml-icon')) && (await page.$$('.ml-maprow')).length === 3);
  await clickText(page, '.ml-btn', 'Read the sheets');
  await page.waitForFunction(() => document.querySelectorAll('.ml-tile').length > 0 || /People/.test(document.body.textContent), null, { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => MetaLeads.go('meta-leads'));
  await page.waitForTimeout(300);
  ok('…but can read the sheets and see the leads', (await page.$$('.ml-person')).length === 12);
  await ctx.close();

  // ── 11. Phone, dark ──
  ({ page, ctx } = await openPage(browser, { viewport: { width: 390, height: 844 }, scheme: 'dark', path: '?nav=meta-leads' }));
  await clickText(page, '.ml-btn', 'Read the sheets');
  await page.waitForFunction(() => document.querySelectorAll('.ml-person').length > 0, null, { timeout: 8000 });
  await clickText(page, '.ml-prow', 'Arjun');
  ok('Phone: no sideways scroll', (await overflow(page)) <= 1, await overflow(page));
  await shot(page, '9-phone-dark');
  await page.evaluate(() => MetaLeads.go('ml-analysis'));
  await page.waitForTimeout(300);
  ok('Phone analysis: no sideways scroll', (await overflow(page)) <= 1, await overflow(page));
  await shot(page, '10-phone-analysis');
  await ctx.close();
} finally {
  await browser.close();
}
console.log('API calls:', apiLog.map(a => a.action).join(', '));
if (errors.length) { console.log('\n' + errors.length + ' problem(s):\n  ' + errors.join('\n  ')); process.exit(1); }
console.log('\nAll good.');
