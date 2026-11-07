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
  const data = JSON.parse(JSON.stringify(SHEETS));
  const byId = { [REAL.KDB]: data.KDB, [REAL.KDO]: data.KDO, [REAL.KOY]: data.KOY };
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url); calls.push((opts.method === 'POST' ? 'POST ' : '') + u.pathname + u.search);
    const wm = u.pathname.match(/\/v4\/spreadsheets\/([^/:]+)\/values:batchUpdate$/);
    if (wm) {
      const sh = byId[wm[1]];
      for (const d of JSON.parse(opts.body).data) {
        const mm = d.range.match(/^'((?:[^']|'')+)'!([A-Z]+)(\d+)$/);
        const tab = sh.tabs.find(t => t.title === mm[1]);
        const col = mm[2].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, row = Number(mm[3]) - 1;
        while (tab.values.length <= row) tab.values.push([]);
        while (tab.values[row].length <= col) tab.values[row].push('');
        tab.values[row][col] = d.values[0][0];
      }
      return res(200, {});
    }
    if (u.pathname === '/drive/v3/files') return res(200, { files: [
      { id: REAL.KOY, name: 'Koyambedu - Leads', modifiedTime: '2026-11-07T06:57:00Z', owners: [{ emailAddress: 'suriyaraja1707@gmail.com' }] },
      { id: REAL.KDO, name: 'Kodabakkam office', modifiedTime: '2026-11-07T05:11:00Z', owners: [{ emailAddress: 'suriyaraja1707@gmail.com' }] },
      { id: REAL.KDB, name: 'office space - Kodambakkam ', modifiedTime: '2026-11-06T05:41:00Z', owners: [{ emailAddress: 'suriyaraja1707@gmail.com' }] },
      { id: 'INVENTORYsheetXXXXXXXXXXXXXXXXXXXXXXXXXXXX', name: '3PIN_Inventory_Master', modifiedTime: '2026-11-07T04:00:00Z', owners: [{ emailAddress: '3pinrentals@gmail.com' }] }] });
    const one = u.pathname.match(/\/v4\/spreadsheets\/([^/:]+)\/values\/A1:AZ1$/);
    if (one) { const sh = byId[one[1]]; return res(200, { values: [sh ? sh.tabs[0].values[0] : ['Property_ID', 'Property_Name_Project']] }); }
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
  return { fetch, calls, data };
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

async function openPage(browser, { email = 'admin@threepin.in', viewport = { width: 1366, height: 900 }, scheme = 'light', path = '?nav=ml-setup', at = '/crm.html' } = {}) {
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
    const f = /^\/ads(\.html|-duplicates|-analysis|-setup)?$/.test(u.pathname) ? join(ROOT, 'crm.html') : join(ROOT, decodeURIComponent(u.pathname));
    if (!existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
  });
  await page.goto('http://crm.local' + at + (at === '/crm.html' ? path : ''));
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  return { page, ctx };
}
const text = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; }, sel);
const shot = (page, name) => page.screenshot({ path: join(OUT, 'meta-leads-' + name + '.png'), fullPage: true });
const clickText = async (page, sel, t) => { await page.locator(sel, { hasText: t }).first().click(); await page.waitForTimeout(250); };
const waitText = (page, sel, re, timeout = 8000) => page.waitForFunction(([s, r]) => { const e = document.querySelector(s); return e && new RegExp(r).test(e.textContent); }, [sel, re.source], { timeout });
// The read button: "Read the sheets" before the first read, "Refresh" after; the screen also reads on its own.
const readAll = async page => {
  await page.waitForFunction(() => { const b = document.querySelector('.ml-head .ml-btn.primary'); return b && !b.disabled; }, null, { timeout: 8000 });
  await page.click('.ml-head .ml-btn.primary');
  await page.waitForTimeout(150);
  await page.waitForFunction(() => !/Reading the sheets/.test(document.querySelector('#metaLeadsView').textContent), null, { timeout: 8000 });
};
const overflow = page => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));

const browser = await chromium.launch({ channel: 'chrome' });
console.log('Meta Ads Leads — clicked through');
try {
  // ── 1. A manager opens Setup: nothing mapped, nothing guessed ──
  let { page, ctx } = await openPage(browser);
  await waitText(page, '#metaLeadsView', /Lead sheets by property/);
  ok('The rail has Meta Ads Leads with its four screens', await page.evaluate(() => ['meta-leads', 'ml-dupes', 'ml-analysis', 'ml-setup'].every(id => document.body.innerHTML.includes(`'${id}'`) || document.body.innerHTML.includes(`"${id}"`))));
  ok('The page says edits go to the sheet and nothing to the CRM', /written to the Google Sheet/.test(await text(page, '.ml-test')) && /Nothing is added to the CRM/.test(await text(page, '.ml-test')));
  await waitText(page, '.ml-avail', /Meta ad lead sheets the app can open/);
  ok('Nothing mapped: the Add panel is open, listing the Meta ad lead sheets the app can open (3), others folded (1)',
    /Meta ad lead sheets the app can open 3/.test(await text(page, '.ml-avail .ml-h')) && (await page.$$('.ml-avail > .ml-av')).length === 3 && /Other sheets shared with the app \(1\)/.test(await text(page, '.ml-other summary')));
  ok('The share address is in the footnote', (await text(page, '.ml-foot')).includes(SA));
  await shot(page, '1-setup-empty');

  // Add a sheet: paste → Check → each tab with its own picker, none picked → pick → Save mapping.
  const openAdd = async () => { if (!(await page.$('.ml-addpanel'))) await clickText(page, '.ml-map-h .ml-btn', 'Add sheet'); };
  const addSheet = async (link, picks, tags = {}) => {
    await openAdd();
    await page.fill('.ml-addpanel .ml-link-in', link);
    await clickText(page, '.ml-addpanel .ml-btn', 'Check');
    await waitText(page, '.ml-addpanel', /pick the property for each tab/);
    for (const [tab, code] of Object.entries(picks)) {
      const row = page.locator('.ml-arow', { hasText: tab }).first();
      await row.locator('.ppk-in').fill(code);
      await row.locator('.ppk-opt', { hasText: code }).first().click();
      if (tags[tab]) await row.locator('.ml-addtag').fill(tags[tab]);
    }
    await clickText(page, '.ml-addpanel .ml-btn', 'Save mapping');
    await page.waitForFunction(() => !document.querySelector('.ml-addpanel'), null, { timeout: 8000 });
  };
  // ── 2. The Koyambedu sheet, chosen from the list: no property is picked for you ──
  await page.locator('.ml-av', { hasText: 'Koyambedu - Leads' }).locator('.ml-btn', { hasText: 'Choose' }).click();
  await waitText(page, '.ml-addpanel', /pick the property for each tab/);
  ok('Checked: its tab, ticked, with an EMPTY property picker', (await page.$$('.ml-arow')).length === 1 && await page.$eval('.ml-arow input[type=checkbox]', e => e.checked) && await page.$eval('.ml-arow select.ml-psel', e => e.value) === '');
  await shot(page, '2-add-sheet');
  await clickText(page, '.ml-addpanel .ml-btn', 'Save mapping');
  ok('Saving without a property is refused', !(await db.collection('metaLeadConfigs').doc(T).get()).exists && !!(await page.$('.ml-addpanel')));
  await clickText(page, '.ml-addpanel .ml-btn', 'Cancel');
  await addSheet(`https://docs.google.com/spreadsheets/d/${REAL.KOY}/edit`, { Sheet1: 'SHR0001' }, { Sheet1: 'Creative test' });
  let saved = (await db.collection('metaLeadConfigs').doc(T).get()).data();
  ok('Saved at once: Koyambedu - Leads › Sheet1 → SHR0001, tag kept', JSON.stringify(saved.sources.map(s => [s.title.trim(), s.tabs.map(t => [t.title, t.propertyCode, t.tag])])) === JSON.stringify([['Koyambedu - Leads', [['Sheet1', 'SHR0001', 'Creative test']]]]));
  // The two KDBMC001 sheets, each tab mapped.
  await addSheet(`https://docs.google.com/spreadsheets/d/${REAL.KDB}/edit`, { Sheet1: 'KDBMC001', Sheet3: 'KDBMC001' });
  await addSheet(`https://docs.google.com/spreadsheets/d/${REAL.KDO}/edit`, { Sheet1: 'KDBMC001' });
  saved = (await db.collection('metaLeadConfigs').doc(T).get()).data();
  ok('Three sheets saved, every tab with its property', JSON.stringify(saved.sources.map(s => [s.title.trim(), s.tabs.map(t => t.title + '→' + t.propertyCode)])) ===
    JSON.stringify([['Koyambedu - Leads', ['Sheet1→SHR0001']], ['office space - Kodambakkam', ['Sheet1→KDBMC001', 'Sheet3→KDBMC001']], ['Kodabakkam office', ['Sheet1→KDBMC001']]]), saved.sources.map(s => s.title));
  ok('Saved by the manager', saved.updatedBy === 'admin@threepin.in');
  const heads = await page.$$eval('.ml-pg-h', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  ok('Grouped by property: KDBMC001 (2 sheets, 3 tabs), SHR0001 (1 sheet, 1 tab)', /KDBMC001 Commercial Building for Rent · 2 sheets · 3 tabs/.test(heads[0]) && /SHR0001 Shriram Codename King Life · 1 sheet · 1 tab/.test(heads[1]), heads);
  ok('Each sheet shows its link', (await page.$$eval('.ml-url', els => els.map(e => e.textContent))).length === 3);
  await shot(page, '2b-setup-mapped');

  // ── 3. Mistakes, said plainly ──
  await openAdd();
  ok('The list now marks the three sheets mapped', (await page.$$eval('.ml-av.mapped', els => els.length)) === 3);
  await page.fill('.ml-addpanel .ml-link-in', `https://docs.google.com/spreadsheets/d/${LOCKED}/edit#gid=0`);
  await clickText(page, '.ml-addpanel .ml-btn', 'Check');
  await waitText(page, '.ml-addpanel', /share it with/);
  ok('A sheet not shared: the address to share with, with a Copy button', (await text(page, '.ml-addpanel .ml-alert')).includes(SA) && !!(await page.$('.ml-addpanel .ml-alert .ml-btn')));
  await shot(page, '2c-not-shared');
  await page.fill('.ml-addpanel .ml-link-in', `https://docs.google.com/spreadsheets/d/${REAL.KOY}/edit`);
  await clickText(page, '.ml-addpanel .ml-btn', 'Check');
  ok('A sheet already mapped is refused', /already mapped/.test(await text(page, '.ml-addpanel .ml-alert')));
  await clickText(page, '.ml-addpanel .ml-btn', 'Cancel');

  // ── 4. Read one sheet only ──
  await page.locator('.ml-pgroup').filter({ has: page.locator('.ml-pg-h', { hasText: 'SHR0001' }) }).locator('.ml-btn', { hasText: 'Read' }).click();
  await page.waitForFunction(() => /\b4\b/.test((document.querySelector('.ml-pgroup:nth-of-type(2) .ml-c-leads') || document.body).textContent) && !document.querySelector('.ml-sheet-act .fa-spin'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  const leadsCells = await page.$$eval('.ml-trow .ml-c-leads', els => els.map(e => e.textContent.trim()));
  ok('Read one sheet: its tab shows 4 leads, the others still unread', JSON.stringify(leadsCells) === JSON.stringify(['—', '—', '—', '4']), leadsCells);
  ok('…the last read keeps only that sheet', JSON.stringify((await db.collection('metaLeadConfigs').doc(T).get()).data().lastRead.sheets.map(x => x.title.trim())) === JSON.stringify(['Koyambedu - Leads']));
  // A tab's property changed: it moves to that property's group (saved at once), then back.
  const sheet3 = () => page.locator('.ml-trow', { hasText: 'Sheet3' }).first();
  await sheet3().locator('.ppk-in').fill('ANR005');
  await sheet3().locator('.ppk-opt', { hasText: 'ANR005' }).first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('.ml-pg-h')].some(h => /ANR005/.test(h.textContent)), null, { timeout: 5000 });
  ok('Sheet3 → ANR005: saved, and shown under ANR005', (await db.collection('metaLeadConfigs').doc(T).get()).data().sources[1].tabs[1].propertyCode === 'ANR005');
  await sheet3().locator('.ppk-in').fill('KDBMC001');
  await sheet3().locator('.ppk-opt', { hasText: 'KDBMC001' }).first().click();
  await page.waitForTimeout(400);
  ok('…and back to KDBMC001', (await db.collection('metaLeadConfigs').doc(T).get()).data().sources[1].tabs[1].propertyCode === 'KDBMC001');
  // A tag and remark on a tab.
  await sheet3().locator('.ml-link', { hasText: 'Tag / remark' }).click();
  await page.fill('.ml-tag-in', 'Copy-copy form');
  await page.fill('.ml-remark-in', 'Asks area and budget per sq ft');
  await clickText(page, '.ml-noteedit .ml-btn', 'Save');
  await page.waitForTimeout(300);
  const t3 = (await db.collection('metaLeadConfigs').doc(T).get()).data().sources[1].tabs[1];
  ok('Tag and remark saved on the tab, and shown', t3.tag === 'Copy-copy form' && t3.remark === 'Asks area and budget per sq ft' && /Copy-copy form.*Asks area/.test(await text(page, '.ml-trow .ml-tabnote')));

  // ── 5. Read every sheet ──
  await readAll(page);
  await page.waitForFunction(() => !/Reading the sheets/.test(document.querySelector('#metaLeadsView').textContent), null, { timeout: 8000 });
  await page.evaluate(() => MetaLeads.go('ml-setup'));
  await page.waitForTimeout(600);
  ok('Each tab shows its leads at the last read', JSON.stringify(await page.$$eval('.ml-trow .ml-c-leads', els => els.map(e => e.textContent.trim()))) === JSON.stringify(['5', '4', '2', '4']));
  await sheet3().locator('.ml-link', { hasText: 'Columns' }).click();
  await page.waitForTimeout(250);
  const cols = await text(page, '.ml-cols');
  ok('Columns: what each one is read as, the one with no header flagged', /Assigned to/.test(cols) && /no header/.test(cols) && /Meta · phone/.test(cols), cols.slice(0, 200));
  await shot(page, '3-setup-columns');

  // ── 6. Leads ──
  await page.evaluate(() => MetaLeads.go('meta-leads'));
  await page.waitForTimeout(300);
  const tileText = () => page.$$eval('.ml-tile', els => els.map(e => e.querySelector('.ml-tile-n').textContent.trim() + ' ' + e.querySelector('.ml-tile-l').textContent.trim()));
  const tiles = await tileText();
  ok('All properties: 12 people (15 enquiries), 7 not assigned', tiles.includes('12 People (15 enquiries)') && tiles.includes('7 Not assigned'), tiles);
  ok('Revisited — priority 4, already in the CRM 4, would be new CRM leads 8', tiles.includes('4 Revisited — priority') && tiles.includes('4 Already in the CRM') && tiles.includes('8 Would be new CRM leads'), tiles);
  await shot(page, '4-leads-all');
  await clickText(page, '.ml-chip', 'KDBMC001');
  const kt = await tileText();
  ok('KDBMC001: 9 people (11 enquiries)', kt.includes('9 People (11 enquiries)'), kt);
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
    ['Enquiries per day', 'By ad', 'Video 1', 'By sheet and tab', 'By platform', 'Instagram', 'Rating', 'Team — who holds which leads', 'Swami', 'Lead quality by ad', 'Site Visit', 'Form: Expected area'].every(w => an.includes(w)), an.slice(0, 300));
  const tt = await page.$$eval('.ml-tt-r:not(.ml-tt-h):not(.ml-team-r):not(.ml-ad-r)', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  ok('Analysis by sheet and tab: three KDBMC001 tabs, with the tag', tt.length === 3 && /office space - Kodambakkam › Sheet3 Copy-copy form/.test(tt[1]), tt);
  await page.locator('.ml-tt-r', { hasText: 'Sheet3' }).click();
  await page.waitForTimeout(300);
  ok('A tab clicked: its own analysis (4 enquiries)', /Only office space - Kodambakkam › Sheet3/.test(await text(page, '.ml-tabsel')) && (await page.$$eval('.ml-tile', els => els[0].textContent)).includes('4'));
  await shot(page, '8b-analysis-tab');
  await clickText(page, '.ml-tabsel .ml-link', 'Show the whole');
  await shot(page, '8-analysis');
  await clickText(page, '.ml-chip', 'SHR0001');
  ok('SHR0001 analysis: its own questions', /Form: What is your budget\?/.test(await text(page, '#metaLeadsView')) && /3 cr to 5 cr/.test(await text(page, '#metaLeadsView')));
  ok('No sideways scroll (laptop)', (await overflow(page)) <= 1, await overflow(page));

  // ── Pages: each screen has its address; Back and Forward move between them ──
  ok('The address follows the screen (/ads-analysis)', new URL(page.url()).pathname === '/ads-analysis', page.url());
  await page.evaluate(() => MetaLeads.go('ml-dupes'));
  await page.waitForTimeout(200);
  ok('Duplicates → /ads-duplicates', new URL(page.url()).pathname === '/ads-duplicates');
  await page.goBack();
  await page.waitForTimeout(300);
  ok('Back → /ads-analysis and the Analysis screen', new URL(page.url()).pathname === '/ads-analysis' && /By platform/.test(await text(page, '#metaLeadsView')));
  await page.evaluate(() => toggleView('kanban'));
  await page.waitForTimeout(200);
  ok('Leaving for the Board: the address is the CRM\'s again', new URL(page.url()).pathname === '/crm.html');

  // ── 9. Reading wrote nothing ──
  ok('The CRM saved nothing (no lead, no note)', (await page.evaluate(() => window.__saves)) === 0);
  ok('Only the setup was written to the database', JSON.stringify([...db._store.keys()].sort()) === JSON.stringify([`metaLeadConfigs/${T}`, `taskConfigs/${T}`]), [...db._store.keys()]);
  ok('Google was only read (no cell written)', sheets.calls.every(c => !/:batchUpdate|:append|:clear/.test(c)));
  await ctx.close();

  // ── 9b. The admin: the unassigned leads, assigned in bulk; the team report ──
  ({ page, ctx } = await openPage(browser, { at: '/ads' }));
  await readAll(page);
  await page.waitForFunction(() => document.querySelectorAll('.ml-person').length > 0, null, { timeout: 8000 });
  await clickText(page, '.ml-chip', 'KDBMC001');
  await page.locator('.ml-tile', { hasText: 'Not assigned' }).click();
  await page.waitForTimeout(250);
  let names = await page.$$eval('.ml-person .ml-name', els => els.map(e => e.childNodes[0].textContent.trim()).sort());
  ok('Admin: "Not assigned" (KDBMC001) — 4 people', JSON.stringify(names) === JSON.stringify(['Dr. Lakshmi Prasad', 'Fresh Lead', 'Saravana', 'Vijaya Rani']), names);
  await page.check('.ml-selall input');
  await page.waitForTimeout(200);
  ok('Select all → the bulk bar', /4 selected/.test(await text(page, '.ml-bulk')));
  await shot(page, '11-admin-bulk');
  await page.selectOption('.ml-bulk select >> nth=0', 'thirumal@threepin.in');
  await page.waitForFunction(() => !/Writing to the sheet/.test(document.querySelector('#metaLeadsView').textContent), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  const s1 = sheets.data.KDB.tabs[0].values, s3 = sheets.data.KDB.tabs[1].values;
  ok('Written: Sheet1 had no Assigned to column — added (W), Thirumal in rows 2, 5, 6', s1[0][22] === 'Assigned to' && s1[1][22] === 'Thirumal' && s1[4][22] === 'Thirumal' && s1[5][22] === 'Thirumal' && !(s1[2][22] || s1[3][22]), JSON.stringify(s1.map(r => r[22])));
  ok('Written: Sheet3\'s own Assigned to column (T) for Saravana, row 5', s3[4][19] === 'Thirumal');
  ok('The screen follows at once: nobody left unassigned', /Nobody matches/.test(await text(page, '#metaLeadsView')) && /^0/.test((await page.locator('.ml-tile', { hasText: 'Not assigned' }).textContent()).trim()));
  // ── The table: the sheet's remarks and rating as columns; sort and filter ──
  await page.evaluate(() => MetaLeads.clearF());
  await clickText(page, '.ml-layout button', 'Table');
  await page.waitForTimeout(250);
  const theads = await page.$$eval('.ml-table thead tr:first-child .ml-th', els => els.map(e => e.textContent.trim()));
  ok('Table: Name, Phone, Property, Enquired, Ad, Assigned to, Rating, Remarks (in the sheet), Follow-ups, Contacted, CRM', JSON.stringify(theads) === JSON.stringify(['Name', 'Phone', 'Property', 'Enquired', 'Ad', 'Assigned to', 'Rating', 'Remarks (in the sheet)', 'Follow-ups', 'Contacted', 'CRM']), theads);
  const cellOf = async (name, col) => page.evaluate(([n, c]) => { const r = [...document.querySelectorAll('.ml-table tr.ml-tr')].find(tr => tr.children[1].textContent.includes(n)); return r ? r.children[c + 1].textContent.trim() : null; }, [name, col]);
  ok('The remarks already in the sheet are shown (Arjun: both sheets\' remarks)', /Sent exact location — gym, 2\.5 km from branch · Purpose: gym 50\/sqft/.test(await cellOf('Arjun', 7)), await cellOf('Arjun', 7));
  ok('…and the follow-ups', /Visiting today 12PM \(16\/10\) · callback wednesday/.test(await cellOf('Arjun', 8)));
  await clickText(page, '.ml-th', 'Rating');
  const firstRating = await page.$eval('.ml-table tr.ml-tr', r => r.children[7].textContent.trim());
  ok('Sort by Rating: the highest first (★ 3)', firstRating === '★ 3', firstRating);
  await clickText(page, '.ml-th', 'Rating');
  const ratings = await page.$$eval('.ml-table tr.ml-tr', rs => rs.map(r => r.children[7].textContent.trim()));
  ok('Click again: the other way (★ 2 before ★ 3), unrated still last', ratings.indexOf('★ 2') < ratings.indexOf('★ 3') && ratings[ratings.length - 1] === '—', ratings);
  await page.fill('.ml-tfilt th:nth-child(9) input', 'gym');
  await page.waitForTimeout(450);
  let tnames = await page.$$eval('.ml-table tr.ml-tr', rs => rs.map(r => r.children[1].textContent.replace('⚡', '').trim()).sort());
  ok('Filter the Remarks column: "gym" → Arjun, Vijaya Rani', JSON.stringify(tnames) === JSON.stringify(['Arjun', 'Vijaya Rani']), tnames);
  await page.evaluate(() => MetaLeads.tfClear());
  await page.selectOption('.ml-tfilt th:nth-child(8) select', '2');
  await page.waitForTimeout(250);
  tnames = await page.$$eval('.ml-table tr.ml-tr', rs => rs.map(r => r.children[1].textContent.replace('⚡', '').trim()).sort());
  ok('Filter Rating: 2', JSON.stringify(tnames) === JSON.stringify(['Parinita', 'Queen']), tnames);
  ok('The Rating filter offers 5, 4, 3, 2, 1 and blank', JSON.stringify(await page.$$eval('.ml-tfilt th:nth-child(8) option', o => o.map(x => x.textContent))) === JSON.stringify(['All', '5', '4', '3', '2', '1', '—']));
  await page.locator('.ml-table tr.ml-tr', { hasText: 'Queen' }).locator('td').nth(1).click();
  await page.waitForTimeout(250);
  ok('A row clicked: the lead opens in a side panel, work form first, nothing cut off', !!(await page.$('.ml-drawer .ml-work')) &&
    await page.evaluate(() => { const d = document.querySelector('.ml-drawer'); return [...d.querySelectorAll('*')].every(e => !e.getBoundingClientRect().width || e.getBoundingClientRect().right <= d.getBoundingClientRect().right + 1); }));
  await shot(page, '11b-table');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  ok('Esc closes the side panel', !(await page.$('.ml-drawer')));
  await page.evaluate(() => MetaLeads.tfClear());
  await clickText(page, '.ml-layout button', 'List');
  await page.waitForTimeout(250);
  ok('List view: the remarks from the sheet are on each row too', /Remarks Sent exact location/.test((await page.locator('.ml-person', { hasText: 'Arjun' }).first().locator('.ml-team').textContent()).replace(/\s+/g, ' ')));
  // The team report.
  await page.evaluate(() => MetaLeads.go('ml-analysis'));
  await page.waitForTimeout(300);
  const team = await page.$$eval('.ml-team-r:not(.ml-tt-h)', els => els.map(e => [...e.children].map(c => c.textContent.trim()).join('|')));
  ok('Team report: Thirumal now holds 6, Swami 2; nobody unassigned', /^Thirumal\|6\|/.test(team[0]) && team.some(t => /^Swami\|2\|/.test(t)) && !team.some(t => /^Not assigned/.test(t)), team);
  ok('Lead quality by ad is there', /Lead quality by ad/.test(await text(page, '#metaLeadsView')) && (await page.$$('.ml-ad-r:not(.ml-tt-h)')).length === 2);
  await shot(page, '12-admin-reports');
  await page.locator('.ml-team-r', { hasText: 'Swami' }).click();
  await page.waitForTimeout(300);
  names = await page.$$eval('.ml-person .ml-name', els => els.map(e => e.childNodes[0].textContent.trim()).sort());
  ok('Click an agent in the report → their leads', JSON.stringify(names) === JSON.stringify(['Arjun', 'Parinita']), names);
  // Someone edits the sheet meanwhile: the admin's change to that cell is refused, theirs kept.
  sheets.data.KDB.tabs[0].values[1][19] = 'Changed by someone in the sheet';
  await page.evaluate(() => MetaLeads.clearF());
  await page.waitForTimeout(200);
  await clickText(page, '.ml-prow', 'Lakshmi');
  await page.fill('.ml-work textarea.ml-note-in[data-col="19"]', 'My new remark');
  await clickText(page, '.ml-work .ml-btn', 'Save to the sheet');
  await page.waitForFunction(() => !/Writing…/.test(document.querySelector('#metaLeadsView').textContent), null, { timeout: 8000 });
  ok('A cell changed in the sheet meanwhile: not overwritten', sheets.data.KDB.tabs[0].values[1][19] === 'Changed by someone in the sheet');
  await page.waitForFunction(() => !document.querySelector('.ml-sheet-act .fa-spin') && /Changed by someone/.test(document.querySelector('#metaLeadsView').textContent), null, { timeout: 8000 }).catch(() => {});
  ok('…the sheet is read again at once: the form now shows their text', /Changed by someone in the sheet/.test(await page.$eval('.ml-work textarea.ml-note-in[data-col="19"]', e => e.value).catch(() => '')) || /Changed by someone in the sheet/.test(await text(page, '.ml-person.open')));
  await ctx.close();

  // ── 10. A team member who is not a manager — opening the /ads-setup page directly ──
  ({ page, ctx } = await openPage(browser, { email: 'swami@threepin.in', at: '/ads-setup' }));
  await waitText(page, '#metaLeadsView', /Only a manager can change the mapping/);
  ok('Not a manager: Setup is read-only (no Add sheet, no pickers, no remove) — but sees the mapping', !(await page.$('.ml-map-h .ml-btn')) && !(await page.$('.ml-trow select')) && !(await page.$('.ml-icon')) && (await page.$$('.ml-trow')).length === 4);
  await readAll(page);
  await page.waitForFunction(() => !/Reading the sheets/.test(document.querySelector('#metaLeadsView').textContent), null, { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => MetaLeads.go('meta-leads'));
  await page.waitForTimeout(300);
  ok('…the leads are read on their own, and an agent starts on HIS leads, not-contacted first', (await page.$$('.ml-person')).length === 2 && await page.$eval('.ml-tools select', e => e.value) === '_mine' && await page.$$eval('.ml-tools select', els => els[els.length - 1].value) === 'untouched');
  await page.evaluate(() => MetaLeads.clearF());
  await page.waitForTimeout(200);
  ok('…and sees everyone with Clear filters', (await page.$$('.ml-person')).length === 12);
  // ── 10b. The agent: my leads, a follow-up after the call ──
  await page.locator('.ml-tile', { hasText: 'Assigned to me' }).click();
  await page.waitForTimeout(250);
  names = await page.$$eval('.ml-person .ml-name', els => els.map(e => e.childNodes[0].textContent.trim()).sort());
  ok('Agent (Swami): "Assigned to me" — Arjun and Parinita', JSON.stringify(names) === JSON.stringify(['Arjun', 'Parinita']), names);
  ok('Each has Call and WhatsApp, the message naming the agent and the property', await page.$$eval('.ml-person .ml-qb.wa', els => els.every(a => /wa\.me\/91\d{10}\?text=Hi%20.*Swami.*3%20PIN%20Realty/.test(a.href))) && (await page.$$('.ml-person a[href^="tel:+91"]')).length === 2);
  await clickText(page, '.ml-prow', 'Parinita');
  await clickText(page, '.ml-qc', 'Site visit fixed');
  ok('Quick phrase fills the follow-up', await page.$eval('#mlwF', e => e.value) === 'Site visit fixed');
  ok('The work form offers ratings 1 to 5', JSON.stringify(await page.$$eval('.ml-work .ml-rb', b => b.map(x => x.textContent))) === JSON.stringify(['1', '2', '3', '4', '5']));
  await page.click('.ml-rb.r4');
  await clickText(page, '.ml-work .ml-btn', 'Save to the sheet');
  await page.waitForFunction(() => !/Writing…/.test(document.querySelector('#metaLeadsView').textContent), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  const pr = sheets.data.KDB.tabs[1].values[2];   // Parinita, Sheet3 row 3: Remarks (V) then a header-less column (W) already full
  ok('Agent: rating 4 written in Rating (U); the follow-up in a new "Follow up 1" column with today\'s date', pr[20] === '4' && sheets.data.KDB.tabs[1].values[0][23] === 'Follow up 1' && /^Site visit fixed \(\d{1,2} \w{3}\)$/.test(pr[23]), JSON.stringify([pr[20], sheets.data.KDB.tabs[1].values[0][23], pr[23]]));
  ok('…and the screen shows it at once', /Site visit fixed/.test(await text(page, '.ml-person.open')) && /★ 4/.test(await text(page, '.ml-person.open .ml-prow')));
  await shot(page, '13-agent-work');
  // A person with rows for two properties: pick which row the form writes; Enter saves.
  await page.evaluate(() => MetaLeads.clearF());
  await page.waitForTimeout(200);
  await clickText(page, '.ml-prow', 'Arjun');
  const rowsOffered = await page.$$eval('.ml-work .ml-wgrid > select:first-of-type option', els => els.map(e => e.textContent));
  ok('Arjun: "Write to" offers his three rows (two KDBMC001, one SHR0001), newest first', rowsOffered.length === 3 && /^SHR0001/.test(rowsOffered[0]), rowsOffered);
  await page.selectOption('.ml-work .ml-wgrid > select:first-of-type', { index: 2 });
  await page.waitForTimeout(200);
  ok('…the form says where it writes', /office space - Kodambakkam › Sheet1, row 4/.test(await text(page, '.ml-work .ml-h')));
  const labels = await page.$$eval('.ml-work .ml-wgrid > label', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  ok('The row\'s notes are listed column by column — Remarks, Follow up 1, Follow up 2 (latest) — each editable',
    labels.includes('Remarks') && labels.includes('Follow up 1') && labels.includes('Follow up 2 latest') && (await page.$$('.ml-work textarea.ml-note-in')).length === 3, labels);
  ok('"Add a note" says where it goes: a new Follow up 3', /^Goes into Follow up 3 — a new column/.test(await text(page, '.ml-work .ml-goes')), await text(page, '.ml-work .ml-goes'));
  await page.fill('#mlwF', 'Visited again, wants 2 floors');
  await page.press('#mlwF', 'Enter');
  await page.waitForFunction(() => !/Writing…/.test(document.querySelector('#metaLeadsView').textContent), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  const a1 = sheets.data.KDB.tabs[0].values;
  ok('Enter saved it: Sheet1 row 4, both follow-ups full → a new "Follow up 3" column', a1[0][23] === 'Follow up 3' && /^Visited again, wants 2 floors \(/.test(a1[3][23]), JSON.stringify([a1[0][23], a1[3][23]]));
  const lab2 = await page.$$eval('.ml-work .ml-wgrid > label', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  ok('…now Follow up 3 is listed as the latest, and the next note would go to Follow up 4', lab2.includes('Follow up 3 latest') && /^Goes into Follow up 4/.test(await text(page, '.ml-work .ml-goes')), lab2);
  await shot(page, '13b-notes');
  // Edit the latest note in place: written in its own cell, no new column.
  await page.fill('.ml-work textarea.ml-note-in[data-col="23"]', 'Visited again, wants 2 floors + parking');
  await clickText(page, '.ml-work .ml-btn', 'Save to the sheet');
  await page.waitForFunction(() => !/Writing…/.test(document.querySelector('#metaLeadsView').textContent), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  ok('Editing the latest note: rewritten in Follow up 3 (X4), nothing added', a1[3][23] === 'Visited again, wants 2 floors + parking' && !a1[0][24], JSON.stringify([a1[3][23], a1[0][24]]));
  ok('…and the older notes untouched', a1[3][19] === 'Sent exact location — gym, 2.5 km from branch' && a1[3][20] === 'Visiting today 12PM (16/10)', JSON.stringify(a1[3].slice(19, 24)));
  // Edit a row cell by cell.
  await page.locator('.ml-person.open .ml-editrow').first().click();
  await page.waitForTimeout(200);
  ok('Edit this row: every team column of that row', (await page.$$('.ml-rowedit textarea')).length >= 4);
  await ctx.close();
  const edits = [...db._store.entries()].filter(([k]) => k.startsWith('metaLeadEdits/')).map(([, v]) => v.by);
  ok('Every write is logged with who made it', edits.includes('admin@threepin.in') && edits.includes('swami@threepin.in'), edits);
  ok('Still no CRM lead touched; only the connected sheets written', sheets.calls.filter(c => /^POST/.test(c)).every(c => /(17kaZCqDhOszTBwBkj8qEGHHsy7E1TBRjAYAWOO2aMk0|19SD6zrkLD84KHCMQ6ZAVA3D2OHJqFExkEThXIfA1BcY|19N-RVhJUQ-HNeEvZK0nG_5aSWW78gpA8mHfbObXpbfk)\/values:batchUpdate/.test(c)));

  // ── 11. Phone, dark ──
  ({ page, ctx } = await openPage(browser, { viewport: { width: 390, height: 844 }, scheme: 'dark', at: '/ads' }));
  ok('/ads opens the Leads screen', /Meta Ads Leads/.test(await text(page, '#metaLeadsView')) && await page.evaluate(() => document.getElementById('metaLeadsView').style.display !== 'none'));
  await readAll(page);
  await page.waitForFunction(() => document.querySelectorAll('.ml-person').length > 0, null, { timeout: 8000 });
  await clickText(page, '.ml-prow', 'Arjun');
  ok('Phone: no sideways scroll', (await overflow(page)) <= 1, await overflow(page));
  const cut = await page.evaluate(() => [...document.querySelectorAll('.ml-person.open *')].filter(e => e.getBoundingClientRect().width && e.getBoundingClientRect().right > innerWidth + 1).map(e => e.className || e.tagName).slice(0, 5));
  ok('Phone: nothing in the lead\'s panel runs past the screen edge', cut.length === 0, cut);
  ok('Phone: the work form comes before the enquiry history', await page.evaluate(() => { const w = document.querySelector('.ml-person.open .ml-work'), q = document.querySelector('.ml-person.open .ml-enq'); return w && q && w.getBoundingClientRect().top < q.getBoundingClientRect().top; }));
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
