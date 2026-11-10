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
import { SHEETS, CRM_LEADS, STAGES, NOW, fakeClassify } from './_meta-leads-fixtures.mjs';

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
    const fm = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (fm) {
      const sh = byId[decodeURIComponent(fm[1])];
      if (!sh) return res(404, { error: { message: 'File not found' } });
      // Any change to the sheet (a write here, or a test editing the data) changes its modifiedTime.
      let h = 0; const str = JSON.stringify(sh.tabs); for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
      return res(200, { modifiedTime: '2026-11-07T05:00:00.' + String(h >>> 0).padStart(10, '0') + 'Z' });
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
const ai = fakeClassify();
const deps = { db, fetch: sheets.fetch, serviceAccount: { client_email: SA }, token: async () => 'tok', now: () => Date.now(), classify: ai.classify };
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
  await page.waitForFunction(() => { const b = document.querySelector('.ml-head .ml-read'); return b && !b.disabled; }, null, { timeout: 8000 });
  await page.click('.ml-head .ml-read');
  await page.waitForTimeout(150);
  await page.waitForFunction(() => { const b = document.querySelector('.ml-head .ml-read'); return b && !b.disabled; }, null, { timeout: 8000 });
  await page.waitForTimeout(150);
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
  ok('Arjun: each enquiry shows what its row says, and "Swami" read as swami@threepin.in', /Visiting today 12PM/.test(det) && /Purpose: gym/.test(det) &&
    /Sheet3, row 2/.test(await text(page, '.ml-person.open .ml-work .ml-h')) && await page.$eval('.ml-person.open #mlwA', e => e.value) === 'swami@threepin.in');
  ok('…and "Written in the sheet" is not repeated under the form', !/Written in the sheet/.test(det));
  ok('Arjun: not in the CRM — a sync would add him, marked Revisited and put first for the agent', /new lead for KDBMC001, SHR0001/.test(det) && /Revisited \(duplicate ad lead\)/.test(det));
  ok('Arjun\'s row says duplicate for KDBMC001', /Duplicate ×2/.test(await text(page, '.ml-person.open .ml-prow')));
  await shot(page, '5-person-arjun');
  // Saravana: already a CRM lead — his CRM summary right here.
  await clickText(page, '.ml-prow', 'Saravana');
  const sd = await text(page, '.ml-person.open .ml-detail');
  ok('Saravana: the CRM summary — lead, stage, agent, properties, AI summary', /Saravanan O V/.test(sd) && /Site Visit/.test(sd) && /Swami/.test(sd) && /ANR005/.test(sd) && /fitness studio/.test(sd), sd.slice(0, 400));
  ok('Saravana: "In CRM · would add KDBMC001"', /In CRM · would add KDBMC001/.test(await text(page, '.ml-person.open .ml-prow')));
  await shot(page, '6-person-in-crm');
  const openCrm = await page.locator('.ml-person.open a.ml-btn', { hasText: 'Open in the CRM' }).evaluate(a => ({ href: a.getAttribute('href'), t: a.target })).catch(() => null);
  ok('"Open in the CRM" opens that CRM lead in a new tab', openCrm && /^\/crm\.html\?lead=./.test(openCrm.href) && openCrm.t === '_blank', openCrm);
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
  ok('Analysis: one row of filters — agent, period, view by', JSON.stringify(await page.$$eval('.ml-an-ctl select', s => s.map(x => x.dataset.an))) === JSON.stringify(['agent', 'period', 'grain']));
  await page.evaluate(() => { MetaLeads.an('period', 'all'); MetaLeads.an('grain', 'day'); });   // the fixtures' dates are fixed; today moves
  await clickText(page, '.ml-chip', 'KDBMC001');
  const an = await text(page, '#metaLeadsView');
  ok('Analysis: per day, per ad, per sheet/tab, platform, rating, assigned, CRM stage, each form question',
    ['Enquiries per day', 'By ad', 'Video 1', 'By sheet and tab', 'By platform', 'Instagram', 'Rating', 'Team — who holds which leads', 'Swami', 'Lead quality by ad', 'Site Visit', 'Form: Expected area'].every(w => an.includes(w)), an.slice(0, 300));
  const tt = await page.$$eval('.ml-tt-r:not(.ml-tt-h):not(.ml-team-r):not(.ml-ad-r):not(.ml-pt-r)', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  ok('Analysis by sheet and tab: three KDBMC001 tabs, with the tag', tt.length === 3 && /office space - Kodambakkam › Sheet3 Copy-copy form/.test(tt[1]), tt);
  await page.locator('.ml-tt-r', { hasText: 'Sheet3' }).click();
  await page.waitForTimeout(300);
  ok('A tab clicked: its own analysis (4 enquiries)', /Only office space - Kodambakkam › Sheet3/.test(await text(page, '.ml-tabsel')) && (await page.$$eval('.ml-tile', els => els[0].textContent)).includes('4'));
  await shot(page, '8b-analysis-tab');
  await clickText(page, '.ml-tabsel .ml-link', 'Show the whole');
  await shot(page, '8-analysis');
  await clickText(page, '.ml-chip', 'SHR0001');
  ok('SHR0001 analysis: its own questions', /Form: What is your budget\?/.test(await text(page, '#metaLeadsView')) && /3 cr to 5 cr/.test(await text(page, '#metaLeadsView')));
  // ── 8c. Over time: a period against the one before it, day on day, week on week, one agent ──
  await clickText(page, '.ml-chip', 'KDBMC001');
  await page.evaluate(() => { MetaLeads.an('d1', '2026-10-19'); MetaLeads.an('d2', '2026-10-25'); MetaLeads.an('period', 'range'); MetaLeads.an('grain', 'day'); });
  await page.waitForTimeout(250);
  ok('19–25 Oct: 7 day bars, and 12–18 Oct as a line', (await page.$$('.ml-tc')).length === 7 && !!(await page.$('.ml-tc-prev polyline')) && /compared with 12 Oct 2026 – 18 Oct 2026/.test(await text(page, '.ml-an-win')));
  const k1 = await page.$eval('.ml-ktile', e => e.innerText.replace(/\s+/g, ' '));
  ok('Enquiries 4, ▼ -20% against 5 the week before (KDBMC001)', /Enquiries 4\b/.test(k1) && /▼ -20% vs 5/.test(k1), k1);
  const pt = await page.$$eval('.ml-pt-r:not(.ml-tt-h)', r => r.map(x => x.children[0].innerText.trim()));
  ok('Day on day: newest first, one row a day', /Day on day/.test(await text(page, '#metaLeadsView')) && pt.length === 7 && pt[0] === 'Sun 25 Oct' && pt[6] === 'Mon 19 Oct', pt);
  ok('Tue 20 Oct: 3, ▲ +3 against Monday', /▲ \+3/.test(await page.locator('.ml-pt-r', { hasText: 'Tue 20 Oct' }).innerText()));
  ok('When they come in, and from enquiry to CRM', !!(await page.$('.ml-hm i.l5')) && (await page.$$('.ml-fun-r')).length === 6);
  await page.hover('.ml-tc:nth-child(2)');
  ok('Hover a bar: its numbers, and the day before\'s', /3 enquiries · Tue 20 Oct/.test(await page.$eval('.ml-tip', e => e.textContent)) && /Before: /.test(await page.$eval('.ml-tip', e => e.textContent)));
  await page.selectOption('.ml-an-ctl select[data-an="grain"]', 'week');
  await page.waitForTimeout(250);
  ok('View by week: Week on week', /Week on week/.test(await text(page, '#metaLeadsView')) && (await page.$$('.ml-tc')).length === 1);
  const agk = await page.$$eval('.ml-agk .ml-agk-h b', b => b.map(x => x.textContent));
  ok('Leads by agent: a card each (who had leads that week), and Not assigned', agk.includes('Swami') && agk.includes('Not assigned') && !agk.includes('Thirumal'), agk);
  await page.locator('.ml-agk', { hasText: 'Swami' }).click();
  await page.waitForTimeout(250);
  ok('A card clicked: the analysis for that agent (cards gone, the filter set)', (await page.$eval('.ml-an-ctl select[data-an="agent"]', s => s.value)) === 'swami@threepin.in' && !(await page.$('.ml-agk')));
  const sw = await page.$$eval('.ml-team-r:not(.ml-tt-h)', r => r.map(x => x.children[0].innerText.trim()));
  ok('One agent: only Swami\'s leads, everywhere', sw.length === 1 && /Swami/.test(sw[0]), sw);
  await shot(page, '8c-analysis-time');
  await page.evaluate(() => { MetaLeads.an('agent', ''); MetaLeads.an('period', 'all'); MetaLeads.an('grain', 'auto'); });
  await clickText(page, '.ml-chip', 'SHR0001');
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
  ok('Only the setup was written to the database (no AI brief until one is asked for)', JSON.stringify([...db._store.keys()].sort()) === JSON.stringify([`metaLeadConfigs/${T}`, `taskConfigs/${T}`]), [...db._store.keys()]);

  // ── 9b. The AI brief: only when asked for (cost) ──
  await page.evaluate(() => MetaLeads.go('meta-leads'));
  await page.waitForTimeout(800);
  ok('Nothing is read by the AI on its own — not in the background, not on opening', ai.calls.length === 0, ai.calls.length);
  await clickText(page, '.ml-prow', 'Arjun');
  await page.waitForTimeout(400);
  ok('Opened with no brief yet: a "Get AI brief" button, and still no AI read', /Get AI brief/.test(await text(page, '.ml-person.open .ml-brief')) && ai.calls.length === 0, ai.calls.length);
  const getBrief = async () => {
    await page.locator('.ml-person.open .ml-brief .ml-btn').click();
    await page.waitForFunction(() => { const b = document.querySelector('.ml-person.open .ml-brief'); return b && !/Reading/.test(b.textContent) && !/Get AI brief/.test(b.textContent); }, null, { timeout: 8000 });
  };
  await getBrief();
  const brief = await text(page, '.ml-person.open .ml-brief');
  ok('Get AI brief: "Before you call" — the stage, the next step and when, what they want, what they ruled out', /Before you call/.test(brief) && /Visit planned/.test(brief) && /Tomorrow 11 am/.test(brief) && /Call to confirm the visit time/.test(brief) && /4,000\+ sq\. ft\./.test(brief) && /Ruled out\s*ground floor/.test(brief), brief);
  ok('…with where it was read from', /Read from 3 enquiries · \d+ sheet notes/.test(brief), brief);
  ok('…first in the lead, above the work form', await page.evaluate(() => { const b = document.querySelector('.ml-person.open .ml-brief'), w = document.querySelector('.ml-person.open .ml-work'); return b.getBoundingClientRect().top < w.getBoundingClientRect().top; }));
  ok('…one AI read for one click', ai.calls.length === 1, ai.calls.length);
  await shot(page, '6c-brief');
  await clickText(page, '.ml-prow', 'Arjun');
  await clickText(page, '.ml-prow', 'Arjun');
  await page.waitForTimeout(400);
  ok('Opening it again: the stored brief, no new AI read', ai.calls.length === 1 && /Visit planned/.test(await text(page, '.ml-person.open .ml-brief')), ai.calls.length);
  // The SHR0001 leads are in view here: Aswin (busy → call again, overdue), Sandeep (not interested → lost).
  for (const who of ['Aswin Ramesh', 'Sandeep']) { await clickText(page, '.ml-prow', who); await page.waitForTimeout(300); await getBrief(); }
  await clickText(page, '.ml-prow', 'Sandeep');
  const dueRows = await page.$$eval('.ml-person', els => els.filter(e => [...e.querySelectorAll('.ml-due')].some(d => /Overdue|Today/.test(d.textContent))).map(e => e.querySelector('.ml-name').childNodes[0].textContent.trim()).sort());
  ok('List: an overdue follow-up is flagged on the row', dueRows.length > 0, dueRows);
  await page.locator('.ml-chip.sm', { hasText: 'Follow-up due' }).click();
  await page.waitForTimeout(200);
  const dueNames = await page.$$eval('.ml-person .ml-name', els => els.map(e => e.childNodes[0].textContent.trim()));
  ok('"Follow-up due": exactly those due today or overdue', JSON.stringify(dueNames.slice().sort()) === JSON.stringify(dueRows) && !dueNames.includes('Arjun'), [dueNames, dueRows]);
  await page.locator('.ml-chip.sm', { hasText: /^All$/ }).click();
  await page.selectOption('.ml-tools .ml-sort', 'next');
  await page.waitForTimeout(200);
  const order = await page.$$eval('.ml-person', els => els.map(e => [e.querySelector('.ml-name').childNodes[0].textContent.trim(), [...e.querySelectorAll('.ml-due')].some(d => /Overdue|Today/.test(d.textContent)), [...e.querySelectorAll('.ml-due')].some(d => /Lost/.test(d.textContent))]));
  ok('"What to do next": the overdue first', order[0][1], order);
  const lostAt = order.findIndex(x => x[2]);
  ok('…the lost ones last', lostAt < 0 || order.slice(lostAt).every(x => x[2]), order);

  // ── 9c. Refresh: only the sheets that changed are read; the new and updated leads are marked ──
  const gets = () => sheets.calls.filter(c => /values:batchGet/.test(c)).length;
  let g0 = gets();
  await readAll(page);
  ok('Refresh with nothing changed: no sheet read again', gets() === g0, gets() - g0);
  ok('…and it says so', /No changes since the last refresh/.test(await page.evaluate(() => (document.querySelector('.toast, #toast, .crm-toast') || document.body).textContent)));
  const arjunRow = sheets.data.KDB.tabs[0].values[3];
  arjunRow[21] = 'callback wednesday ( 24/10) — wants covered parking';
  await page.evaluate(() => MetaLeads.prop('all'));
  g0 = gets();
  await readAll(page);
  ok('One sheet changed: only that sheet read again', gets() - g0 === 1, gets() - g0);
  const marked = await page.$$eval('.ml-person', els => els.filter(e => /Updated|New/.test([...e.querySelectorAll('.ml-badge')].map(b => b.textContent).join(' '))).map(e => e.querySelector('.ml-name').childNodes[0].textContent.trim()));
  ok('…and only the lead whose row changed is marked Updated', JSON.stringify(marked) === JSON.stringify(['Arjun']), marked);
  await page.locator('.ml-chip.sm', { hasText: 'New or updated' }).click();
  await page.waitForTimeout(200);
  ok('"New or updated": just that lead', (await page.$$('.ml-person')).length === 1);
  await page.locator('.ml-chip.sm', { hasText: /^All$/ }).click();
  await clickText(page, '.ml-prow', 'Arjun');
  await page.waitForTimeout(400);
  ok('Its brief: "the notes changed" with Refresh brief — and no AI read until it is pressed', /The notes changed since this brief/.test(await text(page, '.ml-person.open .ml-brief')) && ai.calls.length === 3, ai.calls.length);
  await page.locator('.ml-person.open .ml-brief-stale .ml-btn').click();
  await page.waitForFunction(() => !/The notes changed/.test((document.querySelector('.ml-person.open .ml-brief') || {}).textContent || ''), null, { timeout: 8000 });
  ok('Refresh brief: read again, with the new note', ai.calls.length === 4 && /wants covered parking/.test(ai.calls[3]), ai.calls.length);

  // ── 9d. From Duplicates, "See the person" always lands on them ──
  await page.evaluate(() => MetaLeads.setF('agent', '_mine'));
  await page.evaluate(() => MetaLeads.go('ml-dupes'));
  await page.waitForTimeout(300);
  const dupName = await page.$eval('.ml-dupe b', e => e.textContent.trim());
  await page.locator('.ml-dupe .ml-link', { hasText: 'See the person' }).first().click();
  await page.waitForTimeout(500);
  const landed = await page.evaluate(() => { const o = document.querySelector('.ml-person.open'); if (!o) return null; const r = o.getBoundingClientRect(); return { name: o.querySelector('.ml-name').childNodes[0].textContent.trim(), inView: r.top < innerHeight && r.bottom > 0, flash: o.classList.contains('ml-flash') }; });
  ok('See the person: "My leads" hid them, so the filter is cleared; they are open, on screen and highlighted', landed && landed.name === dupName && landed.inView && landed.flash, landed);
  await page.evaluate(() => MetaLeads.layout('table'));
  await page.evaluate(() => MetaLeads.go('ml-dupes'));
  await page.waitForTimeout(300);
  await page.locator('.ml-dupe .ml-link', { hasText: 'See the person' }).first().click();
  await page.waitForTimeout(500);
  ok('…in the Table view too: the row highlighted and the side panel open', !!(await page.$('tr.ml-tr.open')) && !!(await page.$('.ml-drawer')));
  await page.keyboard.press('Escape');
  await page.evaluate(() => MetaLeads.layout('list'));
  await page.selectOption('.ml-tools .ml-sort', 'new');

  // ── 9e. Dates: on / from / until / between, and the new sorts ──
  await page.evaluate(() => { MetaLeads.clearF(); MetaLeads.setF('agent', ''); });
  await page.waitForTimeout(200);
  const pnames = () => page.$$eval('.ml-person .ml-name', els => els.map(e => e.childNodes[0].textContent.trim()));
  const everyone = (await pnames()).length;
  await page.selectOption('.ml-tools select[aria-label="days"]', 'on');
  ok('Dates: "On a date…" asks for the day', await page.isVisible('.ml-tools .ml-date'));
  await page.fill('.ml-tools .ml-date', '2026-10-15'); await page.dispatchEvent('.ml-tools .ml-date', 'change'); await page.waitForTimeout(200);
  const on15 = await pnames();
  ok('On 15 Oct: Arjun (enquired that day), and fewer than everyone', on15.includes('Arjun') && on15.length < everyone, on15);
  await page.selectOption('.ml-tools select[aria-label="days"]', 'until'); await page.waitForTimeout(150);
  await page.fill('.ml-tools .ml-date', '2026-10-14'); await page.dispatchEvent('.ml-tools .ml-date', 'change'); await page.waitForTimeout(200);
  ok('Until 14 Oct: not Arjun (his enquiries are 15 and 20 Oct)', !(await pnames()).includes('Arjun'));
  await page.selectOption('.ml-tools select[aria-label="days"]', 'range'); await page.waitForTimeout(150);
  ok('Between two dates: From and To', (await page.$$('.ml-tools .ml-date')).length === 2);
  await page.evaluate(() => { MetaLeads.setF('d1', '2026-10-20'); MetaLeads.setF('d2', '2026-10-19'); });
  await page.waitForTimeout(200);
  ok('…given backwards, still the two days (Arjun, 20 Oct)', (await pnames()).includes('Arjun'));
  await page.selectOption('.ml-tools select[aria-label="days"]', ''); await page.waitForTimeout(150);
  ok('Any date: everyone again, no date box', (await pnames()).length === everyone && !(await page.$('.ml-tools .ml-date')));
  await page.selectOption('.ml-tools .ml-sort', 'name_desc'); await page.waitForTimeout(150);
  const zd = await pnames();
  ok('Sort Name Z–A', JSON.stringify(zd) === JSON.stringify(zd.slice().sort((a, b) => b.localeCompare(a))), zd);
  for (const k of ['fu', 'fu_desc', 'prop', 'prop_desc']) { await page.selectOption('.ml-tools .ml-sort', k); await page.waitForTimeout(100); }
  ok('Sorts by follow-up date and by property keep everyone', (await pnames()).length === everyone);
  await page.selectOption('.ml-tools .ml-sort', 'new');

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
  ok('Table: Name, Phone, Property, Enquired, Ad, Assigned to, Rating, Remarks (in the sheet), Follow-ups, Contacted, CRM', JSON.stringify(theads.filter(h => !/^Details \d/.test(h))) === JSON.stringify(['Name', 'Phone', 'Property', 'Enquired', 'Ad', 'Assigned to', 'Rating', 'Remarks (in the sheet)', 'Follow-ups', 'Contacted', 'CRM']), theads);
  const colIx = label => theads.indexOf(label);
  const cellOf = async (name, col) => page.evaluate(([n, c]) => { const r = [...document.querySelectorAll('.ml-table tr.ml-tr')].find(tr => tr.children[1].textContent.includes(n)); return r ? r.children[c + 1].textContent.trim() : null; }, [name, col]);
  ok('The remarks already in the sheet are shown (Arjun: both sheets\' remarks)', /Sent exact location — gym, 2\.5 km from branch · Purpose: gym 50\/sqft/.test(await cellOf('Arjun', colIx('Remarks (in the sheet)'))), await cellOf('Arjun', colIx('Remarks (in the sheet)')));
  ok('…and the follow-ups', /Visiting today 12PM \(16\/10\) · callback wednesday/.test(await cellOf('Arjun', colIx('Follow-ups'))));
  await clickText(page, '.ml-th', 'Rating');
  const rIx = colIx('Rating') + 1;
  const firstRating = await page.$eval('.ml-table tr.ml-tr', (r, i) => r.children[i].textContent.trim(), rIx);
  ok('Sort by Rating: the highest first (★ 3)', firstRating === '★ 3', firstRating);
  await clickText(page, '.ml-th', 'Rating');
  const ratings = await page.$$eval('.ml-table tr.ml-tr', (rs, i) => rs.map(r => r.children[i].textContent.trim()), rIx);
  ok('Click again: the other way (★ 2 before ★ 3), unrated still last', ratings.indexOf('★ 2') < ratings.indexOf('★ 3') && ratings[ratings.length - 1] === '—', ratings);
  await page.fill('.ml-tfilt input[data-k="remarks"]', 'gym');
  await page.waitForTimeout(450);
  let tnames = await page.$$eval('.ml-table tr.ml-tr', rs => rs.map(r => r.children[1].textContent.replace('⚡', '').trim()).sort());
  ok('Filter the Remarks column: "gym" → Arjun, Vijaya Rani', JSON.stringify(tnames) === JSON.stringify(['Arjun', 'Vijaya Rani']), tnames);
  await page.evaluate(() => MetaLeads.tfClear());
  await page.selectOption('.ml-tfilt select[data-k="rating"]', '2');
  await page.waitForTimeout(250);
  tnames = await page.$$eval('.ml-table tr.ml-tr', rs => rs.map(r => r.children[1].textContent.replace('⚡', '').trim()).sort());
  ok('Filter Rating: 2', JSON.stringify(tnames) === JSON.stringify(['Parinita', 'Queen']), tnames);
  ok('The Rating filter offers 5, 4, 3, 2, 1 and blank', JSON.stringify(await page.$$eval('.ml-tfilt select[data-k="rating"] option', o => o.map(x => x.textContent))) === JSON.stringify(['All', '5', '4', '3', '2', '1', '—']));
  await page.locator('.ml-table tr.ml-tr', { hasText: 'Queen' }).locator('td').nth(1).click();
  await page.waitForTimeout(250);
  ok('A row clicked: the lead opens in a side panel, work form first, nothing cut off', !!(await page.$('.ml-drawer .ml-work')) &&
    await page.evaluate(() => { const d = document.querySelector('.ml-drawer'); return [...d.querySelectorAll('*')].every(e => !e.getBoundingClientRect().width || e.getBoundingClientRect().right <= d.getBoundingClientRect().right + 1); }));
  await shot(page, '11b-table');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  // Their form answers as Details 1, 2… — "Question: answer", whatever each sheet's form asked.
  await page.evaluate(() => MetaLeads.tfClear());
  await page.waitForTimeout(200);
  const dheads = await page.$$eval('.ml-table thead tr:first-child th', t => t.map(x => x.textContent.trim()));
  ok('Table: Details 1, 2… columns right after Property', dheads.indexOf('Details 1') === dheads.indexOf('Property') + 1, dheads);
  const dcells = await page.$$eval('.ml-table td.det', t => t.map(x => x.textContent.trim()).filter(x => x !== '—'));
  ok('…each cell "Question: answer"', dcells.length > 0 && dcells.every(x => /^[^:]+: .+/.test(x)), dcells.slice(0, 4));
  const dq = (dcells[0] || '').split(':')[0];
  await page.fill('.ml-tfilt input[data-k="d1"]', dq.slice(0, 5)); await page.waitForTimeout(400);
  ok('…and a Details column can be filtered', (await page.$$('.ml-table tr.ml-tr')).length > 0 && (await page.$eval('.ml-tfilt input[data-k="d1"]', e => document.activeElement === e)));
  await page.evaluate(() => MetaLeads.tfClear());
  await page.waitForTimeout(200);
  // In the CRM: open that lead in a new tab, from the side panel's top.
  await page.locator('.ml-table tr.ml-tr', { hasText: 'Parinita' }).locator('td').nth(1).click();
  await page.waitForTimeout(250);
  const crmA = await page.$eval('.ml-drawer .ml-drawer-h a.ml-crmopen', a => ({ href: a.getAttribute('href'), t: a.target, txt: a.textContent.trim() })).catch(() => null);
  ok('In the CRM: "Open in CRM" at the top of the side panel, in a new tab', crmA && /^\/crm\.html\?lead=./.test(crmA.href) && crmA.t === '_blank' && /Open in CRM/.test(crmA.txt), crmA);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  ok('Esc closes the side panel', !(await page.$('.ml-drawer')));
  await page.evaluate(() => MetaLeads.tfClear());
  await clickText(page, '.ml-layout button', 'List');
  await page.waitForTimeout(250);
  ok('List: their form answers under the phone number', await page.$$eval('.ml-person .ml-fans', f => f.length > 0 && f.every(x => /: /.test(x.textContent))));
  const arjunNote = (await page.locator('.ml-person', { hasText: 'Arjun' }).first().locator('.ml-team .ml-note').textContent()).replace(/\s+/g, ' ').trim();
  ok('List view: each row shows its latest note with the column it is in', /^Remarks Purpose: gym 50\/sqft$/.test(arjunNote), arjunNote);
  // The team report.
  await page.evaluate(() => MetaLeads.go('ml-analysis'));
  await page.waitForTimeout(300);
  const team = await page.$$eval('.ml-team-r:not(.ml-tt-h)', els => els.map(e => [...e.children].map(c => c.innerText.trim()).join('|')));
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
  ok('…the leads are read on their own, and an agent starts on HIS leads, not-contacted first', (await page.$$('.ml-person')).length === 2 && await page.$eval('.ml-tools select', e => e.value) === '_mine' && await page.$$eval('.ml-tools select', els => els[els.length - 1].value) === 'next');
  await page.evaluate(() => MetaLeads.clearF());
  await page.waitForTimeout(200);
  ok('…and sees everyone with Clear filters', (await page.$$('.ml-person')).length === 12);
  // Analysis for someone who is not a manager: their own leads only — no agent to pick, no one else's numbers.
  await page.evaluate(() => { MetaLeads.an('period', 'all'); MetaLeads.an('agent', ''); MetaLeads.go('ml-analysis'); });
  await page.waitForTimeout(300);
  const mine = await page.$$eval('.ml-team-r:not(.ml-tt-h)', r => r.map(x => x.children[0].innerText.trim()));
  ok('Not a manager — Analysis: only their own leads (no agent filter, no one else\'s cards or rows)', !(await page.$('.ml-an-ctl select[data-an="agent"]')) && /Your leads/.test(await text(page, '.ml-an-ctl')) && !(await page.$('.ml-agk')) && mine.length === 1 && /Swami/.test(mine[0]) && /People 2\b/.test(await page.$$eval('.ml-ktile', t => t.map(x => x.innerText.replace(/\s+/g, ' ')).join(' | '))), mine);
  await page.evaluate(() => MetaLeads.go('meta-leads'));
  await page.waitForTimeout(300);
  // ── 10b. The agent: my leads, a follow-up after the call ──
  // The switch: My leads / Unassigned / All, and Take.
  ok('The switch: My leads 2 · Unassigned · All 12', /My leads 2/.test(await text(page, '.ml-sw')) && /All 12/.test(await text(page, '.ml-sw')), await text(page, '.ml-sw'));
  await page.locator('.ml-sw button', { hasText: 'Unassigned' }).click();
  await page.waitForTimeout(250);
  const freeN = Number((await text(page, '.ml-sw button.on .ml-n'))), freeNfromSwitch = freeN;
  const ut = await tileText();
  ok('Unassigned: the counts are of the unassigned leads only', ut[0] === freeNfromSwitch + ' Not assigned (' + ut[0].match(/\((\d+) enquiries\)/)[1] + ' enquiries)' && !ut.some(x => /Assigned to me/.test(x)), ut);
  ok('Unassigned: only leads nobody has, each with Take', (await page.$$('.ml-person')).length === freeN && (await page.$$('.ml-person .ml-take')).length === freeN && freeN > 0, freeN);
  const taken = await page.$eval('.ml-person .ml-name', e => e.childNodes[0].textContent.trim());
  await page.locator('.ml-person .ml-take').first().click();
  await page.waitForFunction(() => !/Writing…/.test(document.querySelector('#metaLeadsView').textContent), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  ok('Take: ' + taken + ' leaves Unassigned and is in My leads (3)', !(await page.$$eval('.ml-person .ml-name', els => els.map(e => e.childNodes[0].textContent.trim()))).includes(taken) && /My leads 3/.test(await text(page, '.ml-sw')), await text(page, '.ml-sw'));
  const allRows = Object.values(sheets.data).flatMap(sh => sh.tabs.flatMap(tb => tb.values));
  ok('…written as "Swami" in the sheet\'s Assigned to', allRows.some(r => r.includes(taken) || r.some(c => String(c).includes(taken))) && allRows.filter(r => r.some(c => String(c).includes(taken))).every(r => r.includes('Swami')));
  // Undo for the checks below: put the lead back.
  await page.locator('.ml-sw button', { hasText: 'My leads' }).click();
  await page.waitForTimeout(250);
  const mt = await tileText();
  ok('My leads: the counts are of my 3 leads only — no unassigned among them', /^3 Assigned to me \(\d+ enquiries\)$/.test(mt[0]) && !mt.some(x => /Not assigned/.test(x)) && mt.length === 8, mt);
  await clickText(page, '.ml-prow', taken);
  await page.selectOption('.ml-person.open #mlwA', '');
  await clickText(page, '.ml-work .ml-btn', 'Save to the sheet');
  await page.waitForFunction(() => !/Writing…/.test(document.querySelector('#metaLeadsView').textContent), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  await page.locator('.ml-sw button', { hasText: 'All' }).click();
  await page.waitForTimeout(200);
  await page.locator('.ml-sw button', { hasText: 'My leads' }).click();
  await page.waitForTimeout(250);
  names = await page.$$eval('.ml-person .ml-name', els => els.map(e => e.childNodes[0].textContent.trim()).sort());
  ok('Agent (Swami): "Assigned to me" — Arjun and Parinita', JSON.stringify(names) === JSON.stringify(['Arjun', 'Parinita']), names);
  ok('Each has Call and WhatsApp, the message naming the agent and the property', await page.$$eval('.ml-person .ml-qb.wa', els => els.every(a => /wa\.me\/91\d{10}\?text=Hi%20.*Swami.*3%20PIN%20Realty/.test(a.href))) && (await page.$$('.ml-person a[href^="tel:+91"]')).length === 2);
  await clickText(page, '.ml-prow', 'Parinita');
  ok('The preset phrases are hidden until asked for', !(await page.isVisible('.ml-work .ml-qc')));
  await page.click('.ml-work .ml-qtoggle');
  ok('…"Quick phrases" shows them', await page.isVisible('.ml-work .ml-qc'));
  await clickText(page, '.ml-qc', 'Site visit fixed');
  ok('…and picking one hides them again', !(await page.isVisible('.ml-work .ml-qc')));
  ok('Quick phrase fills the follow-up', await page.$eval('#mlwF', e => e.value) === 'Site visit fixed');
  ok('The work form offers ratings 1 to 5', JSON.stringify(await page.$$eval('.ml-work .ml-rb', b => b.map(x => x.textContent))) === JSON.stringify(['1', '2', '3', '4', '5']));
  await page.click('.ml-rb.r4');
  await clickText(page, '.ml-work .ml-btn', 'Save to the sheet');
  await page.waitForFunction(() => !/Writing…/.test(document.querySelector('#metaLeadsView').textContent), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  const pr = sheets.data.KDB.tabs[1].values[2];   // Parinita, Sheet3 row 3: Remarks (V) then a header-less column (W) already full
  ok('Agent: rating 4 written in Rating (U); the follow-up in a new "Follow up 1" column with today\'s date', pr[20] === '4' && sheets.data.KDB.tabs[1].values[0][23] === 'Follow up 1' && /^Site visit fixed \(\d{1,2} \w{3}\)$/.test(pr[23]), JSON.stringify([pr[20], sheets.data.KDB.tabs[1].values[0][23], pr[23]]));
  ok('…and the screen shows it at once', /Site visit fixed/.test(await text(page, '.ml-person.open')) && /★ 4/.test(await text(page, '.ml-person.open .ml-prow')));
  await page.waitForTimeout(800);
  ok('A note saved on a lead with no brief: no AI read on its own', !ai.calls.some(c => /Site visit fixed/.test(c)));
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
  ok('Phone: search and "Filters" on one row; the five filters folded away', !(await page.isVisible('.ml-tools .fsel')) && await page.isVisible('.ml-bar .ml-fbtn2') && await page.evaluate(() => Math.abs(document.querySelector('.ml-search').getBoundingClientRect().top - document.querySelector('.ml-fbtn2').getBoundingClientRect().top) < 4));
  await page.click('.ml-bar .ml-fbtn2'); await page.waitForTimeout(150);
  ok('…"Filters" opens them (who, rating, ad, tab, which date, when)', (await page.$$eval('.ml-tools .fsel', els => els.filter(e => e.offsetParent).length)) === 6);
  ok('Phone: the lists that scroll sideways do not widen the page', (await overflow(page)) <= 1, await overflow(page));
  const nameW = await page.$eval('.ml-person .ml-name', e => e.getBoundingClientRect().width);
  ok('Phone: a name keeps its width (not squeezed letter by letter)', nameW > 110, nameW);
  await clickText(page, '.ml-prow', 'Arjun');
  ok('Phone: no sideways scroll', (await overflow(page)) <= 1, await overflow(page));
  const cut = await page.evaluate(() => [...document.querySelectorAll('.ml-person.open *')].filter(e => e.getBoundingClientRect().width && e.getBoundingClientRect().right > innerWidth + 1).map(e => e.className || e.tagName).slice(0, 5));
  ok('Phone: nothing in the lead\'s panel runs past the screen edge', cut.length === 0, cut);
  const full = await page.evaluate(() => { const d = document.querySelector('.ml-drawer.full'); if (!d) return null; const r = d.getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.right), vw: Math.round(document.querySelector('.ml-drawer-bg').getBoundingClientRect().right) }; });
  ok('Phone: an opened lead is its own full screen', full && full.l === 0 && Math.abs(full.w - full.vw) <= 1, full);
  ok('…with Call and WhatsApp as big buttons, and tabs Overview · Update · Enquiries', (await page.$$('.ml-drawer .ml-dact')).length >= 2 && JSON.stringify(await page.$$eval('.ml-dtabs button', b => b.map(x => x.textContent.trim()))) === JSON.stringify(['Overview', 'Update', 'Enquiries 3']));
  const vis = sel => page.evaluate(q => { const e = document.querySelector(q); return !!(e && e.offsetParent); }, sel);
  ok('Overview: the brief and the CRM — not the form, not the history', await vis('.ml-drawer .ml-brief') && !(await vis('.ml-drawer .ml-work')) && !(await vis('.ml-drawer .ml-enq')));
  await page.click('.ml-dtabs button:nth-child(2)'); await page.waitForTimeout(150);
  ok('Update: the work form, Save at the bottom of the screen', await vis('.ml-drawer .ml-work') && !(await vis('.ml-drawer .ml-brief')) && await page.evaluate(() => getComputedStyle(document.querySelector('.ml-drawer .ml-wbtns')).position === 'sticky'));
  await page.click('.ml-dtabs button:nth-child(3)'); await page.waitForTimeout(150);
  ok('Enquiries: the history', await vis('.ml-drawer .ml-enq') && !(await vis('.ml-drawer .ml-work')));
  await page.goBack(); await page.waitForTimeout(300);
  ok('Phone Back: closes the lead, stays on the leads', !(await page.$('.ml-drawer')) && /\/ads/.test(page.url()) && (await page.$$('.ml-person')).length > 0, page.url());
  await clickText(page, '.ml-prow', 'Arjun');
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
