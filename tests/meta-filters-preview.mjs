// ═══════ META ADS LEADS — ACTIVE FILTERS HIGHLIGHTED, CLEAR ALL, NEWEST FIRST ON OPEN ═══════
//
//   node tests/meta-filters-preview.mjs
//
// The real CRM page (same stand-ins as tests/meta-followup-preview.mjs). A rating left on from last
// time hid every lead behind "Not contacted yet" (owner, 25 Nov 2026). Now every filter narrowing
// the list is highlighted and listed in words with its own ✕ and a "Clear all filters" button, the
// empty list says which filters hide everyone, and the page always opens newest enquiries first.
// Screenshots land in tests/out/meta-filters-{light,dark,phone}.png.
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metaLeadsAction } from '../api/_meta-leads.js';
import { createFakeDb } from './_fake-firestore.mjs';
import { SHEETS, CRM_LEADS, STAGES, NOW, fakeClassify, ROSTER } from './_meta-leads-fixtures.mjs';

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
const deps = { db, fetch: sheets.fetch, serviceAccount: { client_email: SA }, token: async () => 'tok', now: () => Date.now(), classify: ai.classify,
  team: async () => ROSTER.map(email => ({ email, uid: email, role: 'none' })), mail: async () => ({ ok: true }), rebuildAgents: async () => {} };
const apiLog = [];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/json', '.woff2': 'font/woff2' };
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); errors.push(label); }
};

async function openPage(browser, { email = 'admin@threepin.in', viewport = { width: 1366, height: 900 }, scheme = 'light', path = '?nav=ml-setup', at = '/crm.html', init } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, hasTouch: viewport.width < 500 });
  if (init) await ctx.addInitScript(init);
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
const shot = (page, name) => page.evaluate(() => { const n = document.getElementById('mlwN'); if (n) n.scrollIntoView({ block: 'center' }); }).then(() => page.screenshot({ path: join(OUT, 'meta-followup-' + name + '.png') }));
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
console.log('Meta Ads Leads — active filters');
// Last visit left: sorted "Not contacted first", rating "4 and above" (what the owner had on screen).
const LEFT = `try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('ml.filters', JSON.stringify({ f: { agent: '', rating: '4+', ad: '', tab: '', days: '', d1: '', d2: '', dateOf: '', sort: 'untouched' }, by: 'admin@threepin.in' })); sessionStorage.setItem('seeded', '1'); } } catch (e) {}`;
const bar = page => text(page, '.ml-active');
const chips = page => page.$$eval('.ml-active .ml-af', b => b.map(x => x.textContent.trim()));
try {
  const sources = [
    { spreadsheetId: REAL.KDB, title: SHEETS.KDB.title, propertyCode: 'KDBMC001', tabs: [{ gid: 0, title: 'Sheet1', on: true }, { gid: 222, title: 'Sheet3', on: true }] },
    { spreadsheetId: REAL.KOY, title: SHEETS.KOY.title, propertyCode: 'SHR0001', tabs: [{ gid: 0, title: 'Sheet1', on: true }] }
  ];
  const [saved, st] = await metaLeadsAction({ tenantId: T, email: 'admin@threepin.in' }, { action: 'save', sources }, deps);
  ok('Two sheets connected for the test', st === 200, saved);
  let { page, ctx } = await openPage(browser, { path: '?nav=meta-leads', init: LEFT });
  await readAll(page);
  await page.waitForSelector('.ml-tools', { timeout: 8000 });
  ok('Opens sorted "Enquiry date: newest first", whatever was left last time', await page.$eval('.ml-sort', s => s.value) === 'new');
  ok('…the default sort is not highlighted', !(await page.$eval('.ml-sort', s => s.classList.contains('set'))));
  ok('The rating left on is highlighted', await page.$eval('select[aria-label="rating"]', s => s.classList.contains('set')));
  ok('…and listed under "Filters on" with a ✕', JSON.stringify(await chips(page)) === '["Rated 4 and above"]', await chips(page));
  ok('…with a count and a "Clear all filters" button', /\d+ shown · Filters on:/.test(await bar(page)) && await page.isVisible('.ml-active .ml-clearall'), await bar(page));
  ok('Untouched filters are not highlighted', await page.$eval('select[aria-label="ad"]', s => !s.classList.contains('set')));
  await page.evaluate(() => MetaLeads.filter('uncontacted'));
  await page.waitForTimeout(300);
  ok('"Not contacted yet" chip is highlighted (aria-pressed)', await page.$eval('.ml-chips .ml-chip.on', b => b.classList.contains('set') && b.getAttribute('aria-pressed') === 'true' && /Not contacted yet/.test(b.textContent)));
  ok('…both filters listed', JSON.stringify(await chips(page)) === '["Not contacted yet","Rated 4 and above"]', await chips(page));
  if (!(await page.$$('.ml-person')).length) ok('Nothing left: the empty list names both filters and offers Clear all', /Nobody matches Not contacted yet \+ Rated 4 and above together\. Clear all filters/.test(await text(page, '.ml-empty')), await text(page, '.ml-empty'));
  else console.log('  (some fixture leads are rated and not contacted; empty message checked below)');
  await page.screenshot({ path: join(OUT, 'meta-filters-light.png') });
  await page.click('.ml-af[aria-label="Remove filter: Rated 4 and above"]');
  await page.waitForTimeout(300);
  ok('✕ removes just that filter', JSON.stringify(await chips(page)) === '["Not contacted yet"]' && await page.$eval('select[aria-label="rating"]', s => s.value === '' && !s.classList.contains('set')), await chips(page));
  ok('…and the leads come back', (await page.$$('.ml-person')).length > 0);
  await page.evaluate(() => MetaLeads.search('zzzz-nobody'));
  await page.waitForTimeout(500);
  ok('While searching, the bar steps aside (search sets filters aside)', !(await page.$('.ml-active')));
  await page.evaluate(() => MetaLeads.search('', true));
  await page.waitForTimeout(300);
  await page.selectOption('select[aria-label="sort"]', 'hot');
  await page.waitForTimeout(250);
  ok('A changed sort is highlighted', await page.$eval('.ml-sort', s => s.classList.contains('set')));
  await page.evaluate(() => MetaLeads.setF('agent', '_mine'));
  await page.selectOption('select[aria-label="rating"]', '1');
  await page.waitForTimeout(250);
  if (!(await page.$$('.ml-person')).length) ok('Empty list names the filters', /Nobody matches .*Rating 1.*Clear all filters/.test(await text(page, '.ml-empty')), await text(page, '.ml-empty'));
  await page.click('.ml-active .ml-clearall');
  await page.waitForTimeout(300);
  ok('Clear all filters: the bar goes, "All" is back', !(await page.$('.ml-active')) && await page.$eval('.ml-chips .ml-chip.on', b => /^All$/.test(b.textContent.trim())));
  ok('…My leads is kept (it is a switch, not a filter)', await page.evaluate(() => JSON.parse(localStorage.getItem('ml.filters')).f.agent === '_mine'));
  ok('…the sort is kept', await page.$eval('.ml-sort', s => s.value) === 'hot');
  ok('No page errors so far', !errors.length, errors);
  await ctx.close();

  for (const [name, opt] of [['dark', { scheme: 'dark' }], ['phone', { viewport: { width: 390, height: 844 } }]]) {
    ({ page, ctx } = await openPage(browser, { path: '?nav=meta-leads', init: LEFT, ...opt }));
    await readAll(page);
    await page.waitForSelector('.ml-tools', { state: 'attached', timeout: 8000 });
    await page.evaluate(() => MetaLeads.filter('uncontacted'));
    await page.waitForTimeout(300);
    ok(name + ': "Filters on" is visible and nothing scrolls sideways', await page.isVisible('.ml-active') && (await overflow(page)) === 0, await overflow(page));
    await page.evaluate(() => document.querySelector('.ml-active').scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: join(OUT, 'meta-filters-' + name + '.png') });
    await ctx.close();
  }
  ok('No page errors', !errors.length, errors);
} finally {
  await browser.close();
}
console.log(errors.length ? `\n${errors.length} problem(s)` : '\nAll good.');
process.exit(errors.length ? 1 : 0);
