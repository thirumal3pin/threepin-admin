// ═══════ THE AGENT LAYER, END TO END — real pages, real rules, real server code ═══════
//
// Chrome opens the real pages. Firebase is the real SDK, pointed at a LOCAL Firestore emulator
// (so firestore.rules decide every read and write exactly as in production). /api/* is the real
// server code (api/_agent.js, api/_agent-work.js, api/tailortalk.js) running here against the same
// emulator. Only the sign-in is played: each person's token carries the claims the real one would.
// Nothing touches the live database.
//
// People: Swami (admin), Rameez and Kavya (agents), Rajesh (full access, no role).
// Phone first (390×844); a desktop and a dark pass for the screenshots in tests/out/agent-e2e/.
//   JAVA_HOME=… node tests/agent-e2e.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || join(ROOT, 'tests/out/agent-e2e');
mkdirSync(OUT, { recursive: true });
const T = 't_3pinrealty';
const EMU = 8282, WEB = 8383;
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + String(detail).slice(0, 400) : '')); errors.push(label); }
};
const section = s => console.log('\n── ' + s);

// ── 1. The Firestore emulator ──
const JAR = join(homedir(), '.cache', 'firebase', 'emulators', 'cloud-firestore-emulator-v1.19.8.jar');
if (!existsSync(JAR)) throw new Error('Run the rule tests once first (they download the emulator): cd tests/rules && npm test');
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
const emu = spawn(java, ['-jar', JAR, '--host', '127.0.0.1', '--port', String(EMU)], { stdio: 'ignore' });
const up = port => new Promise(res => { const s = net.connect(port, '127.0.0.1', () => { s.end(); res(true); }); s.on('error', () => res(false)); });
for (let i = 0; !(await up(EMU)); i++) { if (i > 200) throw new Error('emulator did not start'); await new Promise(r => setTimeout(r, 300)); }
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:' + EMU;
// The real rules, loaded into the emulator — without them it allows everything.
{
  const r = await fetch(`http://127.0.0.1:${EMU}/emulator/v1/projects/pin-realty:securityRules`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: readFileSync(join(ROOT, 'firestore.rules'), 'utf8') }] } }) });
  if (!r.ok) throw new Error('rules did not load: ' + r.status + ' ' + await r.text());
}
process.env.TAILORTALK_TENANT_ID = T;
process.env.HOME_TENANT_ID = T;
process.env.AGENT_REF_SECRET = 'e2e-secret';

// ── 2. The server code, with sign-in played ──
const { initializeApp } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
const { getAuth } = await import('firebase-admin/auth');
initializeApp({ projectId: 'pin-realty' });
const db = getFirestore();
const PEOPLE = {
  swami: { uid: 'u_swami', email: 'swami@threepin.in', name: 'Swami', role: 'admin' },
  thirumal: { uid: 'u_thirumal', email: 'thirumal@threepin.in', name: 'Thirumal', role: 'admin' },
  rameez: { uid: 'u_rameez', email: 'rameez@threepin.in', name: 'Rameez', role: 'agent' },
  kavya: { uid: 'u_kavya', email: 'kavya@threepin.in', name: 'Kavya', role: 'agent' },
  rajesh: { uid: 'u_rajesh', email: 'rajesh@threepin.in', name: 'Rajesh', role: 'none' },
};
const auth = getAuth();
auth.verifyIdToken = async tok => {
  const c = JSON.parse(Buffer.from(String(tok), 'base64url').toString());
  return { uid: c.uid, sub: c.uid, email: c.email, email_verified: true, tenantId: c.tenantId, ...(c.role && c.role !== 'none' ? { role: c.role } : {}) };
};
const authUser = p => ({ uid: p.uid, email: p.email, disabled: false, emailVerified: true, displayName: p.name, providerData: [{ providerId: 'password' }],
  customClaims: { tenantId: T, ...(p.role !== 'none' ? { role: p.role } : {}) }, metadata: { lastSignInTime: null, creationTime: null } });
auth.listUsers = async () => ({ users: Object.values(PEOPLE).map(authUser), pageToken: undefined });
auth.getUser = async uid => { const p = Object.values(PEOPLE).find(x => x.uid === uid); if (!p) throw Object.assign(new Error('no user'), { code: 'auth/user-not-found' }); return authUser(p); };

const { agentPost } = await import('../api/_agent.js');
const TT = await import('../api/tailortalk.js');
const calls = [];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const request = new Request('http://localhost' + req.url, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : body });
      let r;
      if (url.pathname === '/api/agent') r = await agentPost(request);
      else if (url.pathname === '/api/tailortalk') r = await TT.POST(request);
      else r = new Response(JSON.stringify({ ok: false, error: 'not in this test' }), { status: 404 });
      calls.push({ path: url.pathname + url.search, body: body.toString().slice(0, 300), status: r.status });
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const f = join(ROOT, p);
    if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' });
    res.end(readFileSync(f));
  } catch (e) { console.error('server error', e); res.writeHead(500); res.end(String(e)); }
});
await new Promise(r => server.listen(WEB, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${WEB}`;

// ── 3. Seed ──
const now = Date.now(), DAY = 86400000;
const todayAt = h => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime(); };
async function seed() {
  const P = (id, o) => db.collection('properties').doc(id).set({ tenantId: T, id, propertyCode: id, ...o });
  await P('ANR001', { name: '3 BHK Apartment, Anna Nagar', config: '3 BHK', startingPrice: '₹1.8 Cr', type: 'Apartment', zone: 'Anna Nagar', location: '12, 6th Avenue, Anna Nagar',
    contactName: 'Mr Owner', contactNumber: '9840012345', availability: 'Available', detailsText: '3 BHK in Anna Nagar — call 98400 12345', assignedAgent: 'swami@threepin.in', highlights: 'Corner unit, east facing' });
  await P('ADY002', { name: '2 BHK Flat, Adyar', config: '2 BHK', startingPrice: '₹95 L', type: 'Apartment', zone: 'Adyar', location: '4, LB Road, Adyar',
    contactName: 'Mrs Seller', contactNumber: '9840099999', availability: 'Available', facing: 'North' });
  await P('VEL003', { name: '1 BHK, Velachery', config: '1 BHK', startingPrice: '₹48 L', type: 'Apartment', zone: 'Velachery', contactNumber: '9840077777', availability: 'Available', assignedAgent: 'kavya@threepin.in' });
  await P('ECR004', { name: 'Sold Villa, ECR', config: '4 BHK', startingPrice: '₹4 Cr', zone: 'ECR', soldOut: true });
  const L = (id, o) => db.collection('leads').doc(id).set({ tenantId: T, id, createdAt: now - 5 * DAY, updatedAt: now - DAY, stageId: 'new', ...o });
  await L('lead_1', { name: 'Ramesh Kumar', phone: '9111111111', propertyCodes: ['ADY002'], propertyInterest: '2 BHK Adyar', createdAt: now - 3600000 });
  await L('lead_2', { name: 'Divya Raman', phone: '9222222222', assignedAgent: 'swami@threepin.in', stageId: 'contacted', propertyInterest: '2 BHK apartment in Adyar', budget: '₹1 Cr',
    aiSummary: 'Divya Raman (9222222222) wants a 2 BHK in Adyar near the beach, budget around 1 Cr.' });
  await L('lead_3', { name: 'Arjun Mehta', phone: '9333333333', assignedAgent: 'rameez@threepin.in', followUpAt: todayAt(9), followUpNote: 'Send Anna Nagar options', propertyInterest: '3 BHK Anna Nagar' });
  await L('lead_4', { name: 'Kavya Client', phone: '9444444444', assignedAgent: 'kavya@threepin.in', propertyCodes: ['VEL003'] });
  await db.collection('pipelines').doc(T).set({ stages: [
    { id: 'new', name: 'New', color: '#1D4ED8' }, { id: 'contacted', name: 'Contacted', color: '#B45309' }, { id: 'site_visit', name: 'Site Visit', color: '#6D28D9' },
    { id: 'closed_won', name: 'Closed Won', color: '#15803D' }, { id: 'closed_lost', name: 'Closed Lost', color: '#B91C1C' }] });
  await db.collection('settings').doc(T).set({ enquiryTypes: ['Property Enquiry', 'General'], team: Object.fromEntries(Object.values(PEOPLE).map(p => [p.uid, { email: p.email }])) });
  await db.collection('leadsSeededFlags').doc(T).set({ done: true });
  await db.collection('propertiesSeededFlags').doc(T).set({ done: true });
  await db.collection('taskConfigs').doc(T).set({ tenantId: T, managers: ['swami@threepin.in'] });
  for (const p of Object.values(PEOPLE)) await db.collection('users').doc(p.uid).set({ tenantId: T, email: p.email, name: p.name });
}
await seed();

// ── 4. The browser: real Firebase, pointed at the emulator; sign-in played ──
const REAL_FS = await (await fetch('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js')).text();
const FAKE_AUTH = `
const who = () => window.__fakeUser || null;
const b64 = s => btoa(unescape(encodeURIComponent(s))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const userObj = () => { const x = who(); if (!x) return null; const claims = { tenantId: '${T}', email: x.email, email_verified: true, ...(x.role !== 'none' ? { role: x.role } : {}) };
  return { uid: x.uid, email: x.email, displayName: x.name, emailVerified: true, providerData: [],
    getIdToken: async () => b64(JSON.stringify({ uid: x.uid, email: x.email, tenantId: '${T}', role: x.role })), getIdTokenResult: async () => ({ claims }) }; };
const listeners = [];
export const getAuth = () => ({ get currentUser() { return userObj(); } });
export const onAuthStateChanged = (a, cb) => { listeners.push(cb); setTimeout(() => cb(userObj()), 0); return () => {}; };
export const signOut = async () => { window.__fakeUser = null; listeners.forEach(cb => cb(null)); };
export const signInWithEmailAndPassword = async () => ({ user: userObj() });
export const signInWithPopup = async () => ({ user: userObj() });
export class GoogleAuthProvider { setCustomParameters() {} }
export const sendPasswordResetEmail = async () => {};
export const createUserWithEmailAndPassword = async () => ({ user: userObj() });
export const setPersistence = async () => {};
export const browserLocalPersistence = {};
export const updateProfile = async () => {};
export const signInWithRedirect = async () => {};
export const getRedirectResult = async () => null;
`;
const FS_WRAP = `
import * as R from './__real-firestore.js';
export * from './__real-firestore.js';
const wired = new WeakSet();
function wire(db) {
  if (!wired.has(db)) {
    wired.add(db);
    const x = window.__fakeUser;
    R.connectFirestoreEmulator(db, '127.0.0.1', ${EMU}, x ? { mockUserToken: { sub: x.uid, user_id: x.uid, email: x.email, email_verified: true, tenantId: '${T}', ...(x.role !== 'none' ? { role: x.role } : {}) } } : undefined);
  }
  return db;
}
export function getFirestore(...a) { return wire(R.getFirestore(...a)); }
export function initializeFirestore(app, settings, id) { return wire(R.initializeFirestore(app, { ...(settings || {}), localCache: R.memoryLocalCache() }, id)); }
export async function clearIndexedDbPersistence() {}
`;
const browser = await chromium.launch({ channel: 'chrome' });
async function as(key, { viewport = { width: 390, height: 844 }, dark = false } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 2 });
  const p = PEOPLE[key];
  await ctx.addInitScript(u => { window.__fakeUser = u; }, p);
  await ctx.route('https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js', r => r.fulfill({ contentType: 'text/javascript', body: FAKE_AUTH }));
  await ctx.route('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js', r => r.fulfill({ contentType: 'text/javascript', body: FS_WRAP }));
  await ctx.route('https://www.gstatic.com/firebasejs/12.16.0/__real-firestore.js', r => r.fulfill({ contentType: 'text/javascript', body: REAL_FS }));
  const page = await ctx.newPage();
  page.__errors = [];
  page.on('pageerror', e => { if (!/ViewTransition|Transition was aborted|already been terminated/.test(e.message)) page.__errors.push('pageerror: ' + e.message); });
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource|ERR_|net::|font|webmanifest|Permissions-Policy|shutting down|terminated/i.test(m.text())) page.__errors.push(m.text()); });
  page.on('dialog', d => { page.__lastDialog = d.message(); d.accept(); });
  return { ctx, page };
}
const shot = (page, name) => page.screenshot({ path: join(OUT, name + '.png'), fullPage: false });
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (e) { /* not yet */ } await new Promise(r => setTimeout(r, 200)); } return null; };
const doc = async (c, id) => { const s = await db.collection(c).doc(id).get(); return s.exists ? s.data() : null; };
const noErrors = (page, where) => ok(`${where}: no errors in the page`, !page.__errors.length, page.__errors.slice(0, 4).join(' | '));

try {
  // ═══ Admin assigns a property on the Property dashboard ═══
  section('Swami (admin) assigns ADY002 to Rameez, Kavya as co-agent, on the Property dashboard');
  {
    const { ctx, page } = await as('swami', { viewport: { width: 1280, height: 860 } });
    await page.goto(BASE + '/dashboard.html');
    await page.waitForFunction(() => typeof properties !== 'undefined' && properties.some(p => p.id === 'ADY002'), null, { timeout: 25000 });
    await page.evaluate(() => openDetail('ADY002'));
    await page.waitForSelector('#dpAgents select');
    await until(() => page.evaluate(() => propTeam.length > 0));
    await page.evaluate(() => { renderPropAgents(properties.find(x => x.id === 'ADY002')); });
    await page.selectOption('#dpAgents select[aria-label="Primary agent"]', 'rameez@threepin.in');
    let p = await until(async () => { const d = await doc('properties', 'ADY002'); return d && d.assignedAgent === 'rameez@threepin.in' ? d : null; });
    ok('the primary agent is saved by the server', !!p);
    await page.waitForSelector('#dpAgents select.dp-add');
    await page.selectOption('#dpAgents select.dp-add', 'kavya@threepin.in');
    p = await until(async () => { const d = await doc('properties', 'ADY002'); return d && (d.secondaryAgents || []).includes('kavya@threepin.in') ? d : null; });
    ok('a co-agent is added (list + the old single field)', p && p.secondaryAgent === 'kavya@threepin.in', JSON.stringify(p && p.secondaryAgents));
    const log = await db.collection('assignmentLog').where('propertyId', '==', 'ADY002').get();
    ok('both changes are in the history', log.size === 2, log.size);
    const l1 = await doc('leads', 'lead_1');
    ok('the enquiry on ADY002 now reaches both its agents', JSON.stringify(l1.agentAccess) === JSON.stringify(['kavya@threepin.in', 'rameez@threepin.in']), JSON.stringify(l1.agentAccess));
    await until(() => page.evaluate(() => document.querySelectorAll('.dp-chip').length === 1));
    ok('the co-agent shows as a chip with a remove button', await page.evaluate(() => /Kavya/.test(document.querySelector('.dp-chip').textContent)));
    await shot(page, '01-dashboard-agents-panel');
    // Take Kavya off again: she stays only on her own VEL003.
    await page.click('.dp-chip button');
    p = await until(async () => { const d = await doc('properties', 'ADY002'); return d && !(d.secondaryAgents || []).length ? d : null; });
    ok('a co-agent is removed', !!p);
    ok('the enquiry leaves with her', !!(await until(async () => JSON.stringify((await doc('leads', 'lead_1')).agentAccess) === JSON.stringify(['rameez@threepin.in']))));
    noErrors(page, 'dashboard');
    await ctx.close();
  }

  // ═══ Rameez: home, menu, Properties ═══
  section('Rameez (agent) — My Day, the menu, his Properties');
  let rameez = await as('rameez');
  {
    const page = rameez.page;
    await page.goto(BASE + '/myday.html');
    await page.waitForSelector('#s-follow .item', { timeout: 25000 });
    ok('My Day greets him', /Rameez/.test(await page.textContent('#hello')));
    ok('his follow-up due today is listed', /Arjun Mehta/.test(await page.textContent('#s-follow')));
    await until(() => page.evaluate(() => /Ramesh Kumar/.test(document.querySelector('#s-new') && document.querySelector('#s-new').textContent)));
    ok('the new enquiry on his property is listed', /Ramesh Kumar/.test(await page.textContent('#s-new')));
    ok('nothing waits on him to approve', /Nothing waiting/.test(await page.textContent('#s-approve')));
    const tabbar = await page.evaluate(() => [...document.querySelectorAll('#pinTabbar a')].map(a => a.textContent.trim()));
    ok('phone tab bar: My Day, Properties, Messages, Leads, More', tabbar.join('|') === 'My Day|Properties|Messages|Leads|More', tabbar.join('|'));
    const menu = await page.evaluate(() => [...document.querySelectorAll('.rail-nav [data-item], .rail-nav .rl-sec-h, .rail-nav button')].map(x => x.textContent.trim()).join(' | '));
    ok('his menu has no Finance, Shoots, Team & access or Property dashboard', !/Finance|Shoot|Team &|Intelligence Dashboard/.test(menu), menu);
    await shot(page, '02-rameez-myday');
    noErrors(page, 'My Day (agent)');

    await page.goto(BASE + '/listings.html');
    await page.waitForSelector('#list .pcard', { timeout: 25000 });
    const mine = await page.$$eval('#list .pcard b', bs => bs.map(b => b.textContent));
    ok('Mine: only ADY002', mine.length === 1 && /Adyar/.test(mine[0]), mine.join(', '));
    await page.click('#tabs [data-tab="all"]');
    const all = await page.$$eval('#list .pcard', cs => cs.map(c => c.textContent));
    ok('All: every active property, the sold villa left out', all.length === 3 && !all.some(t => /ECR/.test(t)), all.length);
    ok('others are locked, with their agent named', all.some(t => /Anna Nagar/.test(t) && /Locked/.test(t) && /Swami/.test(t)));
    await shot(page, '03-rameez-properties-all');
    // The locked card: summary only.
    await page.click('.pcard[data-id="ANR001"]');
    await page.waitForSelector('.sheet');
    const sheet = await page.textContent('.sheet');
    ok('a locked property shows the summary only — no street, no owner', /Only this summary/.test(sheet) && !/6th Avenue|9840012345|Mr Owner/.test(sheet), sheet.slice(0, 200));
    await shot(page, '04-rameez-locked-sheet');
    await page.click('#pAsk');
    await page.waitForSelector('#aReason');
    await until(() => page.evaluate(() => document.querySelectorAll('#aClient option').length > 1));
    await page.selectOption('#aClient', 'lead_3');
    await page.fill('#aReason', 'My client Arjun wants a 3 BHK in Anna Nagar; can visit Saturday');
    await shot(page, '05-rameez-request-sheet');
    await page.click('#aGo');
    const req = await until(async () => { const q = await db.collection('accessRequests').where('requesterEmail', '==', 'rameez@threepin.in').get(); return q.size ? { id: q.docs[0].id, ...q.docs[0].data() } : null; });
    ok('the request is saved, for the primary agent and the admins', req && req.approvers.includes('swami@threepin.in') && req.approvers.includes('thirumal@threepin.in') && req.clientName === 'Arjun Mehta', JSON.stringify(req && req.approvers));
    await until(() => page.evaluate(() => /Asked/.test(document.querySelector('.pcard[data-id="ANR001"]').textContent)));
    ok('the card now says Asked', /Asked/.test(await page.textContent('.pcard[data-id="ANR001"]')));
    // His own property in full, with a matching buyer.
    await page.click('#tabs [data-tab="mine"]');
    await page.click('.pcard[data-id="ADY002"]');
    await page.waitForSelector('.sheet .kv');
    const own = await page.textContent('.sheet');
    ok('his own property opens in full — address and owner’s number', /LB Road/.test(own) && /9840099999/.test(own));
    ok('a matching buyer is shown without name or number', /Matching buyers/.test(own) && /2 BHK/.test(own) && !/Divya|9222222222/.test(own), own.slice(own.indexOf('Matching'), own.indexOf('Matching') + 300));
    await shot(page, '06-rameez-own-property');
    await page.selectOption('#pAvail', 'On hold');
    ok('availability changes on his own property', !!(await until(async () => (await doc('properties', 'ADY002')).availability === 'On hold')));
    await page.fill('#pNote', 'Owner open to 92 L');
    await page.click('#pNoteGo');
    ok('a note is added', !!(await until(async () => (await db.collection('properties').doc('ADY002').collection('notes').get()).docs.some(d => /92 L/.test(d.data().text)))));
    await page.click('[data-askref]');
    await page.waitForSelector('#lReason');
    await page.fill('#lReason', 'ADY002 fits her exactly');
    await page.click('#lGo');
    ok('a request for the buyer’s number is sent', !!(await until(async () => (await db.collection('accessRequests').where('kind', '==', 'lead').get()).size === 1)));
    noErrors(page, 'Properties (agent)');
  }

  // ═══ Kavya sees nothing of it ═══
  section('Kavya (another agent) — her own only');
  {
    const { ctx, page } = await as('kavya');
    await page.goto(BASE + '/listings.html');
    await page.waitForSelector('#list .pcard', { timeout: 25000 });
    const mine = await page.$$eval('#list .pcard b', bs => bs.map(b => b.textContent));
    ok('Mine: only her VEL003', mine.length === 1 && /Velachery/.test(mine[0]), mine.join());
    const read = await page.evaluate(async () => {
      const fs = await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js');
      const app = (await import('https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js')).getApps()[0];
      const d = fs.getFirestore(app);
      const r = {};
      for (const [k, path] of [['lead3', 'leads/lead_3'], ['prop', 'properties/ANR001'], ['view', 'agentViews/t_3pinrealty__u_rameez']]) {
        try { await fs.getDoc(fs.doc(d, path)); r[k] = 'read'; } catch (e) { r[k] = e.code; }
      }
      return r;
    });
    ok('she cannot read Rameez’s lead, a property, or his copy (the rules)', Object.values(read).every(v => v === 'permission-denied'), JSON.stringify(read));
    noErrors(page, 'Properties (Kavya)');
    await ctx.close();
  }

  // ═══ Swami decides ═══
  section('Swami (admin) — approves in My Day, first decision wins');
  {
    const { ctx, page } = await as('swami');
    await page.goto(BASE + '/myday.html');
    await page.waitForSelector('#s-approve [data-decide]', { timeout: 25000 });
    ok('the property request waits on him', /Rameez asks for 3 BHK Apartment, Anna Nagar/.test(await page.textContent('#s-approve')));
    await shot(page, '07-swami-myday-approvals');
    const btns = await page.$$('#s-approve [data-decide]');
    // The property request (not the lead one).
    for (const b of btns) { const t = await b.evaluate(x => x.closest('.item').textContent); if (/Anna Nagar/.test(t)) { await b.click(); break; } }
    await page.waitForSelector('#dGo');
    await page.click('input[name=dDays][value="3"]');
    await page.check('#dShare');
    await page.click('input[name=dHours][value="24"]');
    await shot(page, '08-swami-approve-sheet');
    await page.click('#dGo');
    const g = await until(async () => { const q = await db.collection('grants').where('agentEmail', '==', 'rameez@threepin.in').where('kind', '==', 'property').get(); return q.size ? q.docs[0].data() : null; });
    ok('the grant: 3 days, owner’s number for 24 hours', g && g.expiresAt > now + 2.9 * DAY && g.includeContact && g.contactExpiresAt < now + 25 * 3600000, JSON.stringify(g && { e: g.expiresAt, c: g.contactExpiresAt }));
    // Thirumal pressing Approve a moment later: told it is already decided.
    const rid = (await db.collection('accessRequests').where('kind', '==', 'property').get()).docs[0].id;
    const second = await page.evaluate(async rid => {
      const q = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + btoa(JSON.stringify({ uid: 'u_thirumal', email: 'thirumal@threepin.in', tenantId: 't_3pinrealty', role: 'admin' })).replace(/=+$/, '') },
        body: JSON.stringify({ action: 'decide', id: rid, decision: 'reject', note: 'no' }) });
      return [q.status, (await q.json()).error];
    }, rid);
    ok('a second approver is told who decided first', second[0] === 409 && /Already approved by Swami/.test(second[1]), JSON.stringify(second));
    await until(() => page.evaluate(() => /Approved by Swami/.test(document.body.textContent) || !document.querySelector('#s-approve [data-decide]') || document.querySelectorAll('#s-approve [data-decide]').length === 1));
    noErrors(page, 'My Day (admin)');
    // The lead request: decided from Team & access → Requests.
    await page.goto(BASE + '/team.html?tab=requests');
    await page.waitForSelector('#requests [data-decide]', { timeout: 25000 });
    ok('Requests tab lists the buyer request and what is shared', /matching buyer/.test(await page.textContent('#requests')) && /Shared right now/.test(await page.textContent('#requests')));
    await shot(page, '09-team-requests');
    await page.click('#requests [data-decide]');
    await page.waitForSelector('#dGo');
    await page.click('#dGo');
    ok('approved: the buyer lead is now his to read', !!(await until(async () => ((await doc('leads', 'lead_2')).agentAccess || []).includes('rameez@threepin.in'))));
    noErrors(page, 'Team & access → Requests');
    await ctx.close();
  }

  // ═══ Rameez sees the result ═══
  section('Rameez — the shared property opens; the buyer is in his CRM');
  {
    const page = rameez.page;
    await page.goto(BASE + '/listings.html');
    await page.waitForSelector('#list .pcard', { timeout: 25000 });
    await page.click('#tabs [data-tab="granted"]');
    await until(() => page.evaluate(() => !!document.querySelector('.pcard[data-id="ANR001"]')));
    ok('Shared tab: ANR001 with its timer', /Shared · (ends in|until)/.test(await page.textContent('.pcard[data-id="ANR001"]')));
    await page.click('.pcard[data-id="ANR001"]');
    await page.waitForSelector('.sheet .kv');
    const t = await page.textContent('.sheet');
    ok('…in full, with the owner’s number while that timer runs', /6th Avenue/.test(t) && /9840012345/.test(t));
    await shot(page, '10-rameez-shared-property');
    await page.goto(BASE + '/crm.html');
    await page.waitForFunction(() => typeof leads !== 'undefined' && leads.length >= 3, null, { timeout: 25000 });
    const ids = await page.evaluate(() => leads.map(l => l.id).sort());
    ok('his CRM: his lead, the enquiry on his property, the approved buyer — not Kavya’s', JSON.stringify(ids) === JSON.stringify(['lead_1', 'lead_2', 'lead_3']), JSON.stringify(ids));
    ok('team-only menus are hidden (stages, AI bot, digest)', await page.evaluate(() => getComputedStyle(document.querySelector('[onclick^="openStageManager"]')).display === 'none' && getComputedStyle(document.querySelector('[onclick^="openBotEditor"]')).display === 'none'));
    await page.evaluate(() => changeStage('lead_3', 'contacted'));
    ok('a stage change goes through the server', !!(await until(async () => (await doc('leads', 'lead_3')).stageId === 'contacted')));
    await page.evaluate(() => createLeadFromForm({ channel: 'phone', name: 'Duplicate Person', phone: '94444 44444', email: '', enquiryType: 'Property Enquiry', propertyInterest: '', budget: '', stageId: 'new', detailsSent: false, followUpAt: null, noteText: '' }));
    await until(() => !!page.__lastDialog);
    if (!page.__lastDialog) console.log('    (calls: ' + JSON.stringify(calls.filter(c => /lead-add/.test(c.body)).slice(-2)) + ')');
    ok('a number already with the team is refused, without saying whose', page.__lastDialog && /already with the team/.test(page.__lastDialog) && !/Kavya/.test(page.__lastDialog), page.__lastDialog);
    ok('…and taken off his board again', await until(() => page.evaluate(() => !leads.some(l => l.name === 'Duplicate Person'))));
    await page.evaluate(() => createLeadFromForm({ channel: 'phone', name: 'Fresh Buyer', phone: '9555555555', email: '', enquiryType: 'Property Enquiry', propertyInterest: '2 BHK', budget: '', stageId: 'new', detailsSent: false, followUpAt: null, noteText: 'Met at the site' }));
    const fresh = await until(async () => { const q = await db.collection('leads').where('name', '==', 'Fresh Buyer').get(); return q.size ? q.docs[0].data() : null; });
    ok('a new lead is added as his', fresh && fresh.assignedAgent === 'rameez@threepin.in');
    ok('…with its first note', !!(await until(async () => fresh && (await db.collection('leads').doc(fresh.id).collection('notes').get()).size === 1)));
    await shot(page, '11-rameez-crm');
    noErrors(page, 'CRM (agent)');
  }

  // ═══ Messages ═══
  section('Messages — the request’s thread, a reply, read ticks');
  {
    const page = rameez.page;
    await page.goto(BASE + '/messages.html');
    await page.waitForSelector('#threads .thread', { timeout: 25000 });
    const titles = await page.$$eval('#threads .thread b', bs => bs.map(b => b.textContent));
    ok('a thread per request', titles.some(t => /^Access: 3 BHK Apartment, Anna Nagar · for Arjun Mehta/.test(t)), titles.join(' | '));
    await page.click('#threads .thread:has-text("Anna Nagar")');
    await page.waitForSelector('#msgs .sys');
    const sys = await page.textContent('#msgs');
    ok('the system lines: asked, approved with its timers', /asked for the details/.test(sys) && /Approved by Swami — details until/.test(sys) && /owner’s number until/.test(sys), sys.slice(0, 300));
    ok('the pinned card says approved', !!(await until(() => page.evaluate(() => /Approved by Swami/.test(document.querySelector('#pinned').textContent)))));
    await page.fill('#text', 'Thanks! Visiting Saturday 11 AM.');
    await page.click('#send');
    await page.waitForSelector('.bub.mine');
    ok('a sent message turns from a clock to ticks once saved', !!(await until(() => page.evaluate(() => !!document.querySelector('.bub.mine .tick')))));
    await shot(page, '12-rameez-chat');
    const th = (await db.collection('threads').where('type', '==', 'access_request').get()).docs.find(d => /Anna Nagar/.test(d.data().title));
    ok('his message is saved, unread for the others', th && (th.data().unread || {}).swami_threepin_in >= 1 && th.data().lastText === 'Thanks! Visiting Saturday 11 AM.', JSON.stringify(th && th.data().unread));
    const { ctx, page: sp } = await as('swami');
    await sp.goto(BASE + '/messages.html');
    await sp.waitForSelector('#threads .thread.unread', { timeout: 25000 });
    ok('Swami sees it unread', /Visiting Saturday/.test(await sp.textContent('#threads .thread.unread')));
    await sp.click('#threads .thread.unread');
    await sp.waitForSelector('.bub.them');
    ok('Swami’s read mark is saved (blue ticks once every member has read)', !!(await until(async () => { const d = (await db.collection('threads').doc(th.id).get()).data(); return d.reads && d.reads.swami_threepin_in >= d.lastAt - 5000 && !d.unread.swami_threepin_in; })));
    await sp.fill('#text', 'Great, the owner knows.');
    await sp.click('#send');
    ok('Rameez gets the reply live', !!(await until(() => page.evaluate(() => [...document.querySelectorAll('.bub.them')].some(b => /owner knows/.test(b.textContent))))));
    await shot(sp, '13-swami-chat');
    noErrors(sp, 'Messages (admin)');
    await ctx.close();
    // A new conversation needs a title.
    await page.click('#back');
    await page.click('#newBtn');
    await page.waitForSelector('#nTitle');
    await page.click('#nPeople label:has-text("Swami")');
    await page.click('#nGo');
    ok('a conversation needs a title', /title/i.test(await page.textContent('#nErr')));
    await page.fill('#nTitle', 'Weekend visits');
    await page.click('#nGo');
    ok('…and opens once it has one', !!(await until(() => page.evaluate(() => /Weekend visits/.test((document.querySelector('#chatTitle') || {}).textContent || '')))));
    await page.fill('#text', 'Free on Sunday?');
    await page.click('#send');
    const wk = await until(async () => { const q = await db.collection('threads').where('title', '==', 'Weekend visits').get(); return q.size ? q.docs[0] : null; });
    const { ctx: c2, page: s2 } = await as('swami');
    await s2.goto(BASE + '/messages.html?t=' + encodeURIComponent(wk.id));
    await s2.waitForSelector('.bub.them', { timeout: 25000 });
    const blue = !!(await until(() => page.evaluate(() => !!document.querySelector('.bub.mine .tick.read'))));
    ok('two of them: the tick turns blue once Swami has read it', blue, JSON.stringify((await db.collection('threads').doc(wk.id).get()).data()) + ' swami errors: ' + s2.__errors.join('|'));
    await c2.close();
    noErrors(page, 'Messages (agent)');
  }

  // ═══ A visit on a colleague's property ═══
  section('A site visit Rameez books on Swami’s property — Swami is told, client’s first name only');
  {
    const page = rameez.page;
    await page.goto(BASE + '/crm.html');
    await page.waitForFunction(() => typeof leads !== 'undefined' && leads.length >= 3, null, { timeout: 25000 });
    const at = todayAt(17);
    const r = await page.evaluate(async at => {
      const l = leads.find(x => x.id === 'lead_3');
      Object.assign(l, { siteVisitAt: at, siteVisitStatus: 'scheduled', siteVisitProperty: 'ANR001', siteVisitBy: 'rameez@threepin.in' });
      await window.crmFirebase.saveLead(l);
      const tok = await window.crmAuth.getIdToken();
      const q = await fetch('/api/tailortalk?action=calendar', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify({ op: 'visit', leadId: 'lead_3', visit: { siteVisitAt: at, siteVisitStatus: 'scheduled', siteVisitProperty: 'ANR001' } }) });
      return q.status;
    }, at);
    const alerts = await until(async () => { const q = await db.collection('visitAlerts').get(); return q.size ? q.docs.map(d => d.data()) : null; });
    ok('one alert, to Swami, with the client’s first name only', alerts && alerts.length === 1 && alerts[0].to.join() === 'swami@threepin.in' && alerts[0].clientName === 'Arjun' && !JSON.stringify(alerts).includes('9333333333'), JSON.stringify(alerts));
    const { ctx, page: sp } = await as('swami');
    await sp.goto(BASE + '/myday.html');
    await sp.waitForSelector('#s-visits .item', { timeout: 25000 });
    ok('Swami’s My Day: “Collaboration visit” today', /Collaboration visit/.test(await sp.textContent('#s-visits')) && /Rameez booked a visit for Arjun/.test(await sp.textContent('#s-visits')));
    await shot(sp, '14-swami-collab-visit');
    // An admin takes the access back.
    await sp.goto(BASE + '/team.html?tab=requests');
    await sp.waitForSelector('#requests [data-a="revoke"]', { timeout: 25000 });
    await sp.click('#requests [data-a="hide-contact"]');
    ok('Hide number: the owner’s number is off', !!(await until(async () => { const q = await db.collection('grants').where('kind', '==', 'property').get(); return q.docs[0].data().includeContact === false; })));
    // The list redraws when the number is hidden: press Take back on the redrawn row.
    await until(() => sp.evaluate(() => !document.querySelector('#requests [data-a="hide-contact"]') && !!document.querySelector('#requests [data-a="revoke"]')));
    await sp.evaluate(() => [...document.querySelectorAll('#requests .item')].find(i => /Anna Nagar/.test(i.textContent) && i.querySelector('[data-a="revoke"]')).querySelector('[data-a="revoke"]').click());
    ok('Take back: the grant ends', !!(await until(async () => { const q = await db.collection('grants').where('kind', '==', 'property').get(); return q.docs[0].data().active === false; })));
    noErrors(sp, 'Team (admin) revoke');
    await ctx.close();
    await page.goto(BASE + '/listings.html');
    await page.waitForSelector('#list .pcard, #list .empty', { timeout: 25000 });
    await page.click('#tabs [data-tab="all"]');
    await until(() => page.evaluate(() => /Locked/.test((document.querySelector('.pcard[data-id="ANR001"]') || {}).textContent || '')));
    ok('Rameez: ANR001 is locked again', /Locked/.test(await page.textContent('.pcard[data-id="ANR001"]')));
  }

  // ═══ Staff and admin keep everything ═══
  section('Rajesh (full access) — works as before, plus My Day and Messages');
  {
    const { ctx, page } = await as('rajesh', { viewport: { width: 1280, height: 860 } });
    await page.goto(BASE + '/crm.html');
    await page.waitForFunction(() => typeof leads !== 'undefined' && leads.length >= 5, null, { timeout: 25000 });
    ok('he sees every lead, as before', await page.evaluate(() => leads.length >= 5));
    ok('…and no agent tab bar', await page.evaluate(() => !document.getElementById('pinTabbar')));
    await page.goto(BASE + '/listings.html');
    await page.waitForURL(/dashboard\.html/, { timeout: 15000 });
    ok('the agent Properties page sends him to the full dashboard', true);
    await page.goto(BASE + '/myday.html');
    await page.waitForSelector('#sections .card', { timeout: 25000 });
    ok('My Day opens for him too', /Good|day/.test(await page.textContent('#hello')));
    noErrors(page, 'My Day (staff)');
    await ctx.close();
  }

  section('Rameez on the Property dashboard link → his own Properties');
  {
    const page = rameez.page;
    await page.goto(BASE + '/dashboard.html?id=ADY002');
    await page.waitForURL(/listings\.html\?id=ADY002/, { timeout: 20000 }).catch(() => {});
    ok('sent to listings.html at the same property', /listings\.html\?id=ADY002/.test(page.url()), page.url());
  }

  // ═══ Screens: desktop and dark ═══
  section('Screens: desktop and dark');
  for (const [key, path, name] of [['rameez', '/myday.html', '20-desktop-myday'], ['rameez', '/listings.html', '21-desktop-properties'], ['swami', '/messages.html', '22-desktop-messages']]) {
    const { ctx, page } = await as(key, { viewport: { width: 1280, height: 820 } });
    await page.goto(BASE + path);
    await page.waitForTimeout(2500);
    await shot(page, name);
    ok(`${name}: no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await ctx.close();
  }
  for (const [key, path, name] of [['rameez', '/myday.html', '23-dark-myday'], ['rameez', '/listings.html', '24-dark-properties'], ['rameez', '/messages.html', '25-dark-messages']]) {
    const { ctx, page } = await as(key, { dark: true });
    await page.goto(BASE + path);
    await page.waitForTimeout(2500);
    await shot(page, name);
    ok(`${name}: no sideways scroll on a phone`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await ctx.close();
  }
} catch (e) {
  console.error(e);
  errors.push('crashed: ' + e.message);
} finally {
  await browser.close();
  server.close();
  emu.kill();
}
console.log(errors.length ? `\n${errors.length} failed:\n  · ` + errors.join('\n  · ') : '\nAll good.');
process.exit(errors.length ? 1 : 0);
