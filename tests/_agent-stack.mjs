// ═══════ THE AGENT LAYER TEST KIT — a whole local copy of the system ═══════
//
// startStack() brings up, on this machine only:
//   · a Firestore emulator with the REAL firestore.rules loaded (every read and write decided as in
//     production)
//   · the REAL server code (api/_agent.js, api/_agent-work.js, api/tailortalk.js) behind a small web
//     server that also serves the pages
//   · Chrome contexts signed in as a team member — the real Firebase SDK, pointed at the emulator;
//     only the sign-in itself is played
// Nothing touches the live database. Used by tests/agent-e2e.mjs, and by anyone exploring the
// pages by hand or by script:
//   const S = await startStack({ emuPort: 8484, webPort: 8585, rich: true });
//   const { page } = await S.as('rameez', { viewport: { width: 390, height: 844 } });
//   await page.goto(S.BASE + '/myday.html');   …   await S.stop();
// People: swami, thirumal (admins), rameez, kavya (agents), rajesh (full access, no role).
// rich: true seeds a realistic day (a dozen properties, fifteen leads, requests in every state,
// conversations, a collaboration visit) instead of the bare minimum the end-to-end test starts from.
// Needs Java (JAVA_HOME) and the emulator jar (run the rule tests once: cd tests/rules && npm test).
import { chromium } from 'playwright';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const T = 't_3pinrealty';
// A phone number's key, as every real lead carries it (the team-wide duplicate check reads it).
const pk = raw => { const d = String(raw || '').replace(/\D/g, ''); return d.length === 10 ? '91' + d : d.length === 11 && d[0] === '0' ? '91' + d.slice(1) : d; };
const JAR = join(homedir(), '.cache', 'firebase', 'emulators', 'cloud-firestore-emulator-v1.19.8.jar');
const up = port => new Promise(res => { const s = net.connect(port, '127.0.0.1', () => { s.end(); res(true); }); s.on('error', () => res(false)); });

export async function startStack({ emuPort = Number(process.env.E2E_EMU_PORT) || 8282, webPort = Number(process.env.E2E_WEB_PORT) || 8383, rich = false, headless = true } = {}) {
  const EMU = emuPort, WEB = webPort;
  if (!existsSync(JAR)) throw new Error('Run the rule tests once first (they download the emulator): cd tests/rules && npm test');
  if (await up(EMU)) throw new Error('Port ' + EMU + ' is already in use — pick another emuPort');
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
  const emu = spawn(java, ['-jar', JAR, '--host', '127.0.0.1', '--port', String(EMU)], { stdio: 'ignore' });
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

  // ── The server code, with sign-in played ──
  const { initializeApp, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getAuth } = await import('firebase-admin/auth');
  if (!getApps().length) initializeApp({ projectId: 'pin-realty' });
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

  // A call to /api/agent as one of the people (the same handler the pages call).
  const tokenOf = key => { const p = PEOPLE[key]; return Buffer.from(JSON.stringify({ uid: p.uid, email: p.email, tenantId: T, role: p.role })).toString('base64url'); };
  async function api(key, action, body = {}) {
    const r = await agentPost(new Request(BASE + '/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenOf(key) }, body: JSON.stringify({ action, ...body }) }));
    return { status: r.status, ...(await r.json()) };
  }

  // ── Seed ──
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
    const L = (id, o) => db.collection('leads').doc(id).set({ tenantId: T, id, createdAt: now - 5 * DAY, updatedAt: now - DAY, stageId: 'new', ...(o.phone ? { phoneKey: pk(o.phone) } : {}), ...o });
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
  if (rich) await seedRich({ db, api, now, DAY, todayAt });

  // ── The browser: real Firebase, pointed at the emulator; sign-in played ──
  const REAL_FS = await (await fetch('https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js')).text();
  const FAKE_AUTH = `
  const who = () => window.__fakeUser || null;
  const b64 = s => btoa(unescape(encodeURIComponent(s))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  // One user object per signed-in person, like Firebase (pages compare auth.currentUser by identity).
  let cached = null;
  const userObj = () => { const x = who(); if (!x) return (cached = null); if (cached && cached.uid === x.uid) return cached;
    const claims = { tenantId: '${T}', email: x.email, email_verified: true, ...(x.role !== 'none' ? { role: x.role } : {}) };
    return cached = { uid: x.uid, email: x.email, displayName: x.name, emailVerified: true, providerData: [],
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
  const browser = await chromium.launch({ channel: 'chrome', headless });
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
  
  const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (e) { /* not yet */ } await new Promise(r => setTimeout(r, 200)); } return null; };
  const doc = async (c, id) => { const s = await db.collection(c).doc(id).get(); return s.exists ? s.data() : null; };
  const stop = async () => { try { await browser.close(); } catch (e) { /* gone */ } server.close(); emu.kill(); };
  return { BASE, db, api, as, until, doc, stop, PEOPLE, T, calls, browser, todayAt, DAY };
}

// A realistic day for looking at the screens: long titles, every availability, follow-ups overdue,
// today and later, visits today and tomorrow, requests waiting / approved / rejected / on a lead,
// conversations, a collaboration visit, a property waiting for approval.
async function seedRich({ db, api, now, DAY, todayAt }) {
  const P = (id, o) => db.collection('properties').doc(id).set({ tenantId: T, id, propertyCode: id, availability: 'Available', type: 'Apartment', ...o });
  await P('ANN010', { name: '4 BHK Premium Villa with Private Garden and Home Theatre, Anna Nagar West Extension', config: '4 BHK', startingPrice: '₹4.25 Cr', zone: 'Anna Nagar', location: '22, 3rd Main Road, Anna Nagar West Extension', contactName: 'Mr Raghavan', contactNumber: '9840011122', assignedAgent: 'rameez@threepin.in', photosLink: 'https://example.com/photos', brochureLink: 'https://example.com/brochure.pdf', detailsText: '4 BHK villa — call 98400 11122', highlights: 'Private garden, home theatre, 3 car parks', facing: 'East', floorNo: 'G+2', sqftRange: '3,850 sq ft', sheetExtras: { 'Owner mobile': '9840011122', 'Key with': 'Security', 'Viewing hours': '10 am – 6 pm' } });
  await P('KKN011', { name: '3 BHK, KK Nagar', config: '3 BHK', startingPrice: '₹1.35 Cr', zone: 'KK Nagar', location: '8, Sector 9', contactName: 'Mrs Lakshmi', contactNumber: '9840022233', assignedAgent: 'rameez@threepin.in', secondaryAgents: ['kavya@threepin.in'], secondaryAgent: 'kavya@threepin.in' });
  await P('NUN012', { name: 'Office space for rent, Nungambakkam', type: 'Commercial', config: '2,400 sq ft', startingPrice: '₹1,80,000/month', zone: 'Nungambakkam', contactNumber: '9840033344', assignedAgent: 'kavya@threepin.in', secondaryAgents: ['rameez@threepin.in'], secondaryAgent: 'rameez@threepin.in', availability: 'On Hold' });
  await P('TNG013', { name: '2 BHK, T Nagar', config: '2 BHK', startingPrice: '₹1.1 Cr', zone: 'T Nagar', contactNumber: '9840044455', assignedAgent: 'swami@threepin.in' });
  await P('OMR014', { name: 'Plot, OMR (2,400 sq ft, DTCP approved)', type: 'Land', config: 'Plot', startingPrice: '₹68 L', zone: 'OMR', contactNumber: '9840055566', assignedAgent: 'swami@threepin.in' });
  await P('BES015', { name: '3 BHK Sea-view Apartment, Besant Nagar', config: '3 BHK', startingPrice: '₹3.2 Cr', zone: 'Besant Nagar', contactNumber: '9840066677', assignedAgent: 'kavya@threepin.in' });
  await P('POR016', { name: '2 BHK, Porur', config: '2 BHK', startingPrice: '₹72 L', zone: 'Porur', contactNumber: '9840077788' });
  await P('MYL017', { name: 'Independent house, Mylapore', type: 'Independent House', config: '3 BHK', startingPrice: '₹5.5 Cr', zone: 'Mylapore', contactNumber: '9840088899', availability: 'Sold', soldOut: true, assignedAgent: 'rameez@threepin.in' });
  const L = (id, o) => db.collection('leads').doc(id).set({ tenantId: T, id, createdAt: now - 6 * DAY, updatedAt: now - DAY, stageId: 'new', ...(o.phone ? { phoneKey: pk(o.phone) } : {}), ...o });
  await L('lead_r1', { name: 'Priya Venkatesh', phone: '9500000001', assignedAgent: 'rameez@threepin.in', stageId: 'contacted', followUpAt: todayAt(8) - DAY, followUpNote: 'Call back about the KK Nagar price', propertyInterest: '3 BHK KK Nagar', budget: '₹1.4 Cr' });
  await L('lead_r2', { name: 'Mohammed Irfan', phone: '9500000002', assignedAgent: 'rameez@threepin.in', stageId: 'site_visit', siteVisitAt: todayAt(16), siteVisitStatus: 'scheduled', siteVisitProperty: 'ANN010', propertyInterest: 'Villa Anna Nagar', budget: '₹4.5 Cr' });
  await L('lead_r3', { name: 'Sangeetha R', phone: '9500000003', assignedAgent: 'rameez@threepin.in', followUpAt: todayAt(18), followUpNote: 'Send brochure', propertyInterest: '4 BHK' });
  await L('lead_r4', { name: 'Venkat (NRI)', phone: '+1 415 555 0104', assignedAgent: 'rameez@threepin.in', stageId: 'contacted', followUpAt: now + 3 * DAY, propertyInterest: 'Plot OMR' });
  await L('lead_e1', { name: 'Harish Kumar', phone: '9500000005', propertyCodes: ['ANN010'], propertyInterest: 'Villa', createdAt: now - 2 * 3600000 });
  await L('lead_e2', { name: 'Deepa S', phone: '9500000006', propertyCodes: ['KKN011'], propertyInterest: '3 BHK KK Nagar', createdAt: now - 26 * 3600000 });
  await L('lead_k1', { name: 'Kavya Buyer One', phone: '9500000007', assignedAgent: 'kavya@threepin.in', propertyCodes: ['BES015'] });
  await L('lead_s1', { name: 'Ganesh Iyer', phone: '9500000008', assignedAgent: 'swami@threepin.in', stageId: 'contacted', propertyInterest: '3 BHK apartment in KK Nagar', budget: '₹1.3 Cr', aiSummary: 'Ganesh Iyer (9500000008) is looking for a 3 BHK in KK Nagar around 1.3 Cr, ready to move.' });
  await L('lead_s2', { name: 'Fathima N', phone: '9500000009', assignedAgent: 'swami@threepin.in', propertyInterest: 'Villa in Anna Nagar', budget: '₹4 Cr', aiSummary: 'Fathima wants an independent villa in Anna Nagar with a garden; budget 4 Cr.' });
  await L('lead_u1', { name: 'Unassigned Walk-in', phone: '9500000010', propertyInterest: '2 BHK Porur', budget: '₹75 L' });
  // Requests in every state, through the real server.
  const a = await api('kavya', 'request', { kind: 'property', targetId: 'ANN010', reason: 'My client wants a villa with a garden — can we visit Sunday?' });
  const b = await api('rameez', 'request', { kind: 'property', targetId: 'TNG013', reason: 'Client Priya wants a 2 BHK in T Nagar too', clientLeadId: 'lead_r1' });
  const c = await api('rameez', 'request', { kind: 'property', targetId: 'BES015', reason: 'NRI client wants a sea view', clientLeadId: 'lead_r4' });
  await api('kavya', 'decide', { id: c.id, decision: 'approve', days: 7, shareContact: true, hours: 2, note: 'Owner prefers evening calls' });
  const d = await api('rameez', 'request', { kind: 'property', targetId: 'OMR014', reason: 'For Venkat' });
  await api('swami', 'decide', { id: d.id, decision: 'reject', note: 'Owner has given this exclusively to us for now' });
  await api('rameez', 'view', { force: true });
  const v = (await db.collection('agentViews').doc(T + '__u_rameez').get()).data();
  const m = (v.matches || [])[0];
  if (m) await api('rameez', 'request', { kind: 'lead', ref: m.ref, reason: 'Fits my KK Nagar 3 BHK exactly' });
  await api('rameez', 'property-submit', { fields: { name: '1 BHK, Velachery (resale)', config: '1 BHK', startingPrice: '₹52 L', zone: 'Velachery', contactName: 'Mr Babu', contactNumber: '9840099988', notes: 'Owner relocating; wants a quick sale' } });
  const t = await api('rameez', 'thread-open', { type: 'general', title: 'Weekend site visits', members: ['swami@threepin.in', 'kavya@threepin.in'] });
  const tref = db.collection('threads').doc(t.id);
  const msgs = [['rameez@threepin.in', 'Who is free for the Anna Nagar visits on Saturday?', -50], ['swami@threepin.in', 'I can take the 11 am one.', -40], ['kavya@threepin.in', 'I will cover KK Nagar at 4.', -30]];
  for (const [by, text, mins] of msgs) await tref.collection('messages').add({ kind: 'text', text, by, at: now + mins * 60000 });
  await tref.update({ lastAt: now - 30 * 60000, lastText: 'I will cover KK Nagar at 4.', lastBy: 'kavya@threepin.in', 'reads.swami_threepin_in': now - 35 * 60000 });
  // A collaboration visit Kavya booked on Rameez's villa (through the server's own alert).
  const { visitAlert } = await import('../api/_agent-work.js');
  const kv = { id: 'lead_k1', name: 'Kavya Buyer One', phone: '9500000007', assignedAgent: 'kavya@threepin.in' };
  await visitAlert(db, { tenantId: T, email: 'kavya@threepin.in', role: 'agent' }, kv, { ...kv, siteVisitAt: todayAt(17), siteVisitStatus: 'scheduled', siteVisitProperty: 'ANN010' });
  return { pendingForRameez: a.id, rameezPending: b.id, approved: c.id, rejected: d.id };
}
