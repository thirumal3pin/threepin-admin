// ═══════ THE MATCH PAGE — PREVIEW / SMOKE TEST (match.html) ═══════
//
//   node tests/match-page-preview.mjs [out-dir]        (default tests/out)
//
// Serves the worktree as static files and opens the REAL match.html in Chrome, signed in through a
// stand-in for Firebase Auth (Firestore is a no-op stub — the page never reads it). /api/match is
// answered by the REAL search code (api/_match.js runSearch) over the labelled scenario data
// (tests/fixtures/match-eval-data.mjs), so every row on screen has the exact shape the server sends:
// onboarded properties, Shoot board cards, seller leads and an agent submission; buyers with
// several requirements; ruled-out rows. The AI reader is a canned answer.
//
// Walks: the smart box (properties) → Check what I understood → Read with AI → Search with these →
// filters → Show ruled out → a score breakdown → clients for a property (code and details) → the
// demand question → See buyers → a lead deep link, and an agent's restricted client card with
// Request details. Screenshots at 1280 and 390 wide; fails on any console error, page error, or
// sideways scroll at 390.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as D from './fixtures/match-eval-data.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || join(ROOT, 'tests/out');
mkdirSync(OUT, { recursive: true });

// ── The API, for real, over the scenario data ──
process.env.AGENT_REF_SECRET = process.env.AGENT_REF_SECRET || 'preview-secret';
const api = await import('../api/_match.js');
const PS = globalThis.PinSources, PM = globalThis.PinMatch;
const NAMES = ['Priya Venkatesh', 'Mohammed Irfan', 'Sangeetha Raman', 'Arjun Mehta', 'Divya Krishnan', 'Ganesh Iyer', 'Fathima Nazeer', 'Karthik Subramanian',
  'Lakshmi Narayanan', 'Rahul Menon', 'Anitha Joseph', 'Vignesh Kumar', 'Deepa Srinivasan', 'Harish Chandran', 'Meena Ramesh', 'Suresh Babu', 'Kavitha Mohan', 'Ravi Shankar', 'Nisha Thomas', 'Prakash Rao'];
const leads = D.LEADS.map((l, i) => ({ ...l, name: l.name && /^Client /.test(l.name) ? NAMES[i % NAMES.length] : l.name, assignedAgent: l.assignedAgent || (i % 3 === 0 ? 'rameez@threepin.in' : i % 3 === 1 ? 'kavya@threepin.in' : ''), source: i % 2 ? 'Meta ad' : 'WhatsApp (TailorTalk)' }));
api.__setSource(() => ({ properties: D.PROPERTIES, listings: D.LISTINGS, leads, submissions: D.SUBMISSIONS, trackStages: D.TRACK_STAGES, stages: D.STAGES }));
let data = await api.loadAll(null, 't1');
const user = { tenantId: 't1' };
const team = [{ email: 'rameez@threepin.in', name: 'Rameez' }, { email: 'kavya@threepin.in', name: 'Kavya' }];
const STAFF = { me: 'swami@threepin.in', agent: false, team };
const AGENT = { me: 'rameez@threepin.in', agent: true, team, grants: [], agentSet: new Set(['rameez@threepin.in', 'kavya@threepin.in']), cfg: { matchingLeadFields: ['requirement', 'stage'], otherPropertyFields: ['name', 'location', 'config', 'price'], tabs: ['properties', 'crm'] } };
const AI_ITEM = { status: 'active', deal: 'buy', types: ['apartment'], sub: null, bhk: [3], locations: [{ name: 'Anna Nagar', pref: 'primary' }, { name: 'Kilpauk', pref: 'secondary' }], exclude: ['Mogappair'], anywhere: false, radiusKm: null,
  budget: { min: null, max: 30000000, unit: 'total', flex: 'approximate' }, area: null, condition: ['ready'], possession: 'immediate', mustHave: ['covered car parking'], facing: null, furnishing: null, uncertain: ['possession'], missing: [], label: '3 BHK in Anna Nagar, ~₹3 Cr' };
api.__setAi(async () => ({ direction: 'properties', questions: ['Is Kilpauk fine if Anna Nagar has nothing ready?'], items: [AI_ITEM] }));

const calls = [];
async function answer(body, viewer) {
  calls.push(body.action + ':' + (body.mode || ''));
  if (body.action === 'search') {
    const out = await api.runSearch({ db: null, user, body, viewer, data });
    return { ok: !out.error, ...out };
  }
  if (body.action === 'interpret') {
    const q = PS.parseSmartQuery(body.text);
    const req = PM.briefProfile(q.text, {});
    const engine = { ...PS.explainReq(req), item: PS.itemFromProfile(req) };
    const ai = body.ai === false ? null : await api.structureText(body.text);
    return { ok: true, direction: q.direction, scope: q.scope, engine, ai: ai && ai.ok ? ai : null, aiError: ai && !ai.ok ? ai.error : null };
  }
  // The lead's requirement: read, saved beside the CRM fields, every version kept (as the API does).
  const lead = leads.find(l => l.id === body.leadId);
  if (['structure', 'save-req', 'req-history'].includes(body.action) && !lead) return { status: 404, error: 'That lead is not here' };
  if (body.action === 'structure') {
    const text = [lead.propertyInterest, lead.budget].filter(Boolean).join('. ');
    const ai = await api.structureText(text);
    const fallback = PM.requirementProfiles(lead, {}).map(PS.itemFromProfile).map(PS.cleanItem).filter(Boolean);
    return { ok: true, items: ai.ok && ai.items.length ? ai.items : fallback, questions: ai.ok ? ai.questions : [], src: ai.ok ? 'ai' : 'engine', model: ai.model || null, aiError: ai.ok ? null : ai.error };
  }
  if (body.action === 'save-req') {
    const items = (body.items || []).map(PS.cleanItem).filter(Boolean).slice(0, 5);
    const at = Date.now(), rev = ((lead.reqs && lead.reqs.rev) || 0) + 1;
    saved.push({ leadId: lead.id, items });
    revisions.unshift({ id: 'r' + rev, at, by: viewer.me, src: 'reviewed', rev, items, was: (lead.reqs && lead.reqs.items) || null });
    lead.reqs = items.length ? { items, src: 'reviewed', at, by: viewer.me, rev, fp: PM.reqFingerprint ? PM.reqFingerprint(lead) : undefined } : null;
    data = await api.loadAll(null, 't1');
    return { ok: true, reqs: lead.reqs };
  }
  if (body.action === 'req-history') return { ok: true, revisions: revisions.filter(() => true) };
  return { status: 400, error: 'Unknown action' };
}
const saved = [], revisions = [];

// ── Static files ──
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = normalize(join(ROOT, p === '/' ? 'index.html' : p));
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ── Firebase stand-ins (the page imports them from gstatic) ──
const FAKE_APP = `export const initializeApp = (c) => ({ options: c, name: '[DEFAULT]' }); export const getApps = () => [];`;
const FAKE_AUTH = `
  const who = () => window.__fakeUser || null;
  let cached = null;
  const userObj = () => { const x = who(); if (!x) return null; if (cached && cached.uid === x.uid) return cached;
    const claims = { tenantId: 't1', email: x.email, role: x.role };
    return cached = { uid: x.uid, email: x.email, getIdToken: async () => 'token-' + x.uid, getIdTokenResult: async () => ({ claims }) }; };
  export const getAuth = () => ({ get currentUser() { return userObj(); } });
  export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb(userObj()), 0); return () => {}; };
  export const signOut = async () => { window.__fakeUser = null; };
  export const signInWithEmailAndPassword = async () => ({ user: userObj() });`;
const FAKE_FS = `
  const none = () => {};
  export const initializeFirestore = () => ({}); export const getFirestore = () => ({});
  export const persistentLocalCache = () => ({}); export const persistentMultipleTabManager = () => ({}); export const memoryLocalCache = () => ({});
  export const doc = () => ({}); export const collection = () => ({}); export const query = () => ({}); export const where = () => ({});
  export const orderBy = () => ({}); export const limit = () => ({});
  export const onSnapshot = (q, ok) => { setTimeout(() => ok({ docs: [], size: 0, exists: () => false, data: () => null }), 0); return none; };
  export const getDoc = async () => ({ exists: () => false, data: () => null }); export const getDocs = async () => ({ docs: [], size: 0 });
  export const terminate = async () => {}; export const clearIndexedDbPersistence = async () => {};`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const problems = [];
const PEOPLE = { swami: { uid: 'u_swami', email: 'swami@threepin.in', role: 'admin' }, rameez: { uid: 'u_rameez', email: 'rameez@threepin.in', role: 'agent' } };

async function open(who, viewport, path) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const person = PEOPLE[who];
  await ctx.addInitScript(p => {
    window.__fakeUser = p;
    const day = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
    try { localStorage.setItem('pin.att.state.' + p.uid, JSON.stringify({ day, s: 'in', at: Date.now() })); } catch (e) { /* none */ }
  }, person);
  await ctx.route('https://www.gstatic.com/firebasejs/**/firebase-app.js', r => r.fulfill({ contentType: 'text/javascript', body: FAKE_APP }));
  await ctx.route('https://www.gstatic.com/firebasejs/**/firebase-auth.js', r => r.fulfill({ contentType: 'text/javascript', body: FAKE_AUTH }));
  await ctx.route('https://www.gstatic.com/firebasejs/**/firebase-firestore.js', r => r.fulfill({ contentType: 'text/javascript', body: FAKE_FS }));
  await ctx.route(BASE + '/api/**', async r => {
    const url = new URL(r.request().url());
    let body = {};
    try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) { /* empty */ }
    let out = { ok: true };
    if (url.pathname === '/api/match') out = await answer(body, who === 'rameez' ? AGENT : STAFF);
    else if (url.pathname === '/api/agent' && body.action === 'me') out = { ok: true, role: person.role, config: person.role === 'agent' ? { tabs: ['myday', 'properties', 'crm'], actions: {} } : null };
    else if (url.pathname === '/api/agent' && body.action === 'request') { calls.push('request:' + body.kind); out = { ok: true, id: 'req1' }; }
    else if (url.pathname === '/api/attendance') out = { ok: true, tracked: false, today: {} };
    const status = out.status || 200; delete out.status;
    await r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(out) });
  });
  const page = await ctx.newPage();
  const tag = who + '@' + viewport.width;
  page.on('pageerror', e => problems.push(`${tag} pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource|net::ERR|webmanifest/i.test(m.text())) problems.push(`${tag} console: ${m.text()}`); });
  await page.goto(BASE + path);
  await page.waitForSelector('#smartForm', { timeout: 15000 });
  return { ctx, page, tag };
}
const shot = (page, name, full = true) => page.screenshot({ path: join(OUT, `match-${name}.png`), fullPage: full });
// The first rows as a phone shows them (a full-page shot of a long list is too tall to look at).
const rowsShot = async (page, name) => { await page.locator('#results').scrollIntoViewIfNeeded(); await page.evaluate(() => document.querySelector('#results').scrollIntoView()); await page.screenshot({ path: join(OUT, `match-${name}.png`) }); };
const sideways = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const results = page => page.waitForFunction(() => !document.querySelector('#list[aria-busy]') && document.querySelector('#list > li:not(.mt-sk)'), null, { timeout: 15000 });
const expect = (cond, msg) => { if (!cond) problems.push('expect: ' + msg); };

try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const w = viewport.width;
    const { ctx, page, tag } = await open('swami', viewport, '/match.html');
    await shot(page, `${w}-0-start`, false);

    // 1. The smart box → properties, from every source.
    await page.fill('#q', '3bhk anna nagr around 3 cr, not mogappair');
    await page.press('#q', 'Enter');
    await results(page);
    const n = await page.locator('#list > li.mt-row').count();
    expect(await page.locator('#list > li.mt-row:not([data-src="onboarded"])').count() > 0, `${tag}: stock not yet onboarded is listed too`);
    expect(n > 0, `${tag}: the smart box found properties`);
    expect(/matching propert/.test(await page.textContent('#resCount')), `${tag}: the count is announced`);
    expect(await page.locator('#tabProps[aria-selected="true"]').count() === 1, `${tag}: properties tab selected`);
    await shot(page, `${w}-1-properties`);
    if (w === 390) await rowsShot(page, '390-1b-properties-rows');
    if (w === 390) expect(await sideways(page) <= 0, `${tag}: no sideways scroll on the results (${await sideways(page)}px)`);

    // 2. Check what I understood → Read with AI → Search with these.
    await page.click('#refine > summary');
    expect(await page.locator('#readChips li').count() > 0, `${tag}: the reading is shown as chips`);
    await page.click('#aiRead');
    await page.waitForFunction(() => /AI/.test(document.querySelector('#aiNote').textContent), null, { timeout: 10000 });
    expect(await page.inputValue('#iEx') === 'Mogappair', `${tag}: the AI read filled "Not in"`);
    await shot(page, `${w}-2-refine`);
    if (w === 390) expect(await sideways(page) <= 0, `${tag}: no sideways scroll with the form open (${await sideways(page)}px)`);
    await page.click('#itemForm button[type="submit"]');
    await results(page);

    // 3. Filters and ruled-out rows; a score breakdown.
    await page.click('#filters > summary');
    await page.check('#fOut');
    await page.waitForTimeout(500);
    await results(page);
    await page.locator('.mt-row .mt-more > summary').first().click();
    await shot(page, `${w}-3-filters-breakdown`, w !== 390);
    if (w === 390) { await page.locator('.mt-row .mt-more[open]').first().scrollIntoViewIfNeeded(); await shot(page, '390-3b-breakdown', false); }
    if (w === 390) expect(await sideways(page) <= 0, `${tag}: no sideways scroll with filters open (${await sideways(page)}px)`);
    await page.uncheck('#fOut');
    await page.click('#filters > summary');

    // 4. Clients for a property, by its typed details.
    await page.click('#tabClients');
    await page.selectOption('#dType', 'Apartment');
    await page.selectOption('#dBhk', '3');
    await page.fill('#dLoc', 'Anna Nagar');
    await page.fill('#dPrice', '3 Cr');
    await page.click('#detailsForm button[type="submit"]');
    await page.waitForFunction(() => /client/.test(document.querySelector('#resCount').textContent) && !document.querySelector('#list[aria-busy]'), null, { timeout: 15000 });
    expect(await page.locator('#list .mt-row a[href^="crm.html?lead="]').count() > 0, `${tag}: client rows link to the CRM`);
    expect(await page.locator('#list .mt-row a[href^="https://wa.me/91"]').count() > 0, `${tag}: WhatsApp links carry 91`);
    await shot(page, `${w}-4-clients`);
    if (w === 390) await rowsShot(page, '390-4b-clients-rows');
    if (w === 390) expect(await sideways(page) <= 0, `${tag}: no sideways scroll on clients (${await sideways(page)}px)`);

    // 5. The demand question → See buyers.
    await page.fill('#q', 'unprocessed seller leads that match active buyer requirements');
    await page.press('#q', 'Enter');
    await page.waitForFunction(() => document.querySelector('#list .mt-row.demand'), null, { timeout: 15000 });
    await shot(page, `${w}-5-demand`);
    if (w === 390) await rowsShot(page, '390-5b-demand-rows');
    await page.locator('[data-act="demand-buyers"]').first().click();
    await page.waitForFunction(() => /client/.test(document.querySelector('#resCount').textContent) && !document.querySelector('#list[aria-busy]'), null, { timeout: 15000 });

    // 6. A lead deep link with more than one requirement.
    await page.goto(BASE + '/match.html?lead=B19');
    await results(page);
    expect(!(await page.locator('#leadBox').isHidden()), `${tag}: the lead's requirements are shown`);
    await shot(page, `${w}-6-lead`, false);
    if (w === 1280) {
      // Edit the client's requirements: read with AI, add a second one, save — then the search re-runs.
      await page.click('#reqEdit');
      await page.waitForSelector('#reqEditor:not([hidden]) #itemForm', { timeout: 10000 });
      await page.click('#reqAi');
      await page.waitForFunction(() => /AI|built-in/.test(document.querySelector('#reqAiNote').textContent), null, { timeout: 10000 });
      await page.click('#edAdd');
      await page.check('#itemForm input[name="types"][value="plot"]');
      await page.fill('#iLoc', 'Choolaimedu');
      await page.selectOption('#iDeal', 'jv');
      await page.locator('#edTabs [data-ed]').first().click();
      await shot(page, `${w}-6b-lead-edit`);
      await page.click('#reqSave');
      await page.waitForFunction(() => document.querySelector('#reqEditor').hidden && !document.querySelector('#list[aria-busy]'), null, { timeout: 15000 });
      expect(saved.length === 1 && saved[0].items.length === 2, `${tag}: two requirements saved (${JSON.stringify(saved.map(x => x.items.length))})`);
      expect(await page.locator('#leadReqs [data-req]').count() === 2, `${tag}: both requirements are offered after saving`);
      await page.click('#reqHist');
      await page.waitForSelector('.mt-histl li', { timeout: 10000 });
      await shot(page, `${w}-6c-lead-saved`, false);
    }

    // 7. A property code deep link.
    await page.goto(BASE + '/match.html?property=P01');
    await page.waitForFunction(() => !document.querySelector('#list[aria-busy]') && /client|No results/.test(document.querySelector('#resCount').textContent), null, { timeout: 15000 });
    expect(await page.locator('#tabClients[aria-selected="true"]').count() === 1, `${tag}: ?property= opens the clients side`);
    await ctx.close();
  }

  // 8. An agent: other agents' clients are restricted cards with Request details.
  const { ctx, page, tag } = await open('rameez', { width: 390, height: 844 }, '/match.html');
  await page.click('#tabClients');
  await page.selectOption('#dType', 'Apartment');
  await page.selectOption('#dBhk', '3');
  await page.fill('#dLoc', 'Anna Nagar');
  await page.fill('#dPrice', '3 Cr');
  await page.click('#detailsForm button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector('#list[aria-busy]') && document.querySelector('#list > li:not(.mt-sk)'), null, { timeout: 15000 });
  const held = page.locator('.mt-row.held [data-act="request"]');
  expect(await held.count() > 0, `${tag}: restricted client cards offer Request details`);
  if (await held.count()) {
    await held.first().click();
    await page.waitForFunction(() => /Asked/.test((document.querySelector('.mt-reqres.ok') || {}).textContent || ''), null, { timeout: 10000 });
  }
  await shot(page, '390-7-agent-clients', false);
  await page.locator('.mt-row.held').first().scrollIntoViewIfNeeded();
  await shot(page, '390-7b-agent-held', false);
  expect(await sideways(page) <= 0, `${tag}: no sideways scroll for the agent (${await sideways(page)}px)`);
  await ctx.close();
} catch (e) {
  problems.push('FAIL ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
console.log('API calls:', [...new Set(calls)].join(', '));
console.log('Screenshots in', OUT);
if (problems.length) { console.log('\nProblems:\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('All good — no console errors, no sideways scroll at 390.');
