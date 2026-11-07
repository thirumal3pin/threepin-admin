// ═══════ META ADS LEADS — HOW IT LOOKS (screenshots for design review) ═══════
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

// Every screen at desktop and phone width, light and dark → tests/out/look-*.png. Not a test: run
// it after a design change and look at the pictures.
await metaLeadsAction({ tenantId: T, email: 'admin@threepin.in' }, { action: 'save', sources: [
  { spreadsheetId: REAL.KDB, title: SHEETS.KDB.title, propertyCode: 'KDBMC001', propertyName: 'Commercial Building for Rent', tabs: [{ gid: 0, title: 'Sheet1' }, { gid: 222, title: 'Sheet3', tag: 'Copy-copy form' }] },
  { spreadsheetId: REAL.KDO, title: SHEETS.KDO.title, propertyCode: 'KDBMC001', propertyName: 'Commercial Building for Rent', tabs: [{ gid: 0, title: 'Sheet1' }] },
  { spreadsheetId: REAL.KOY, title: SHEETS.KOY.title, propertyCode: 'SHR0001', propertyName: 'Shriram Codename King Life', tabs: [{ gid: 0, title: 'Sheet1' }] }] }, deps);
const lshot = (page, name) => page.screenshot({ path: join(OUT, 'look-' + name + '.png'), fullPage: true });
const only = process.argv[2] || '';
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [vw, vh, tag] of [[1366, 900, 'desk'], [390, 844, 'phone']]) {
    for (const scheme of ['light', 'dark']) {
      if (only && !(tag + '-' + scheme).includes(only)) continue;
      const { page, ctx } = await openPage(browser, { viewport: { width: vw, height: vh }, scheme, at: '/ads' });
      if (scheme === 'dark') await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await page.waitForFunction(() => document.querySelectorAll('.ml-person').length > 0, null, { timeout: 10000 });
      await page.waitForTimeout(300);
      const p = tag + '-' + scheme;
      const ov = async n => { const o = await overflow(page); if (o > 1) console.log('  OVERFLOW ' + p + ' ' + n + ': ' + o + 'px', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed').map(e => (e.id || e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().right)).slice(0, 6)))); };
      await lshot(page, p + '-1-list'); await ov('list');
      await clickText(page, '.ml-prow', 'Arjun');
      await lshot(page, p + '-2-open'); await ov('open');
      await page.evaluate(() => { MetaLeads.toggle(null); });
      await page.evaluate(() => MetaLeads.layout && MetaLeads.layout('table'));
      await page.waitForTimeout(250);
      await lshot(page, p + '-3-table'); await ov('table');
      const r = await page.$('.ml-table tbody tr');
      if (r) { await r.click(); await page.waitForTimeout(250); await page.screenshot({ path: join(OUT, 'look-' + p + '-4-drawer.png') }); await page.keyboard.press('Escape'); }
      await page.evaluate(() => MetaLeads.layout && MetaLeads.layout('list'));
      await page.evaluate(() => MetaLeads.go('ml-analysis')); await page.waitForTimeout(300);
      await lshot(page, p + '-5-analysis'); await ov('analysis');
      await page.evaluate(() => MetaLeads.go('ml-dupes')); await page.waitForTimeout(300);
      await lshot(page, p + '-6-dupes'); await ov('dupes');
      await page.evaluate(() => MetaLeads.go('ml-setup')); await page.waitForTimeout(500);
      await lshot(page, p + '-7-setup');
      console.log('  ' + p + ' overflow ' + await overflow(page));
      await ctx.close();
    }
  }
} finally { await browser.close(); }
if (errors.length) console.log(errors.join('\n'));
console.log('look: done');
