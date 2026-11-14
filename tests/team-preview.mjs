// ═══════ TEAM & ACCESS + THE AGENT MENU — played as an admin, a teammate and an agent ═══════
//
// The real team.html and crm.html in Chrome, with Firebase and /api/agent swapped for in-memory
// stand-ins that answer like the real ones (the server's guard rails included: nobody changes their
// own role, the last admin cannot go, someone already on the team cannot be "added" again, an email
// of another business is refused). People played:
//   Swami   — admin: manages people and what agents see
//   Rajesh  — full access, no role: works as before, cannot open Team & access
//   Rameez  — agent: sees only the tabs the admin gave him
// Phone (390×844) and desktop, light and dark. Also replays the QA review's bug reports. Screenshots
// go to tests/out/team/.
//   node tests/team-preview.mjs [out-dir]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as AC from '../shared-assets/agent-config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || 'tests/out/team';
mkdirSync(OUT, { recursive: true });
const T = 't_3pinrealty';
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};

const PEOPLE = {
  swami: { uid: 'u_swami', email: 'swami@threepin.in', claims: { tenantId: T, role: 'admin', email_verified: true } },
  rajesh: { uid: 'u_rajesh', email: 'rajesh@threepin.in', claims: { tenantId: T, email_verified: true } },
  rameez: { uid: 'u_rameez', email: 'rameez@threepin.in', claims: { tenantId: T, role: 'agent', email_verified: true } },
};
const day = 86400000;
const seedUsers = () => ([
  { uid: 'u_swami', email: 'swami@threepin.in', name: 'Swami', phone: '919884883370', role: 'admin', active: true, verified: true, teamList: true, lastLogin: Date.now() - 2 * 3600000 },
  { uid: 'u_thirumal', email: 'thirumal@threepin.in', name: 'Thirumal Ashok', phone: '', role: 'admin', active: true, verified: true, teamList: true, lastLogin: Date.now() - 16 * day },
  { uid: 'u_pradeep', email: 'pradeep@threepin.in', name: '', phone: '', role: 'admin', active: true, verified: true, teamList: true, lastLogin: Date.now() - 111 * day },
  { uid: 'u_admin', email: 'admin@threepin.in', name: '', phone: '', role: 'admin', active: true, verified: true, teamList: true, lastLogin: null },
  { uid: 'u_rajesh', email: 'rajesh@threepin.in', name: 'Rajesh S', phone: '', role: 'none', active: true, verified: true, teamList: true, lastLogin: Date.now() - 28 * day },
  { uid: 'u_dev', email: 'dev@threepin.in', name: '', phone: '', role: 'none', active: true, verified: true, teamList: false, lastLogin: Date.now() - 49 * day },
  { uid: 'u_owner', email: '3pinrentals@gmail.com', name: '3Pin Rentals', phone: '', role: 'none', active: true, verified: true, teamList: false, lastLogin: Date.now() - 25 * day },
  { uid: 'u_rameez', email: 'rameez@threepin.in', name: '', phone: '', role: 'agent', active: true, verified: true, teamList: true, lastLogin: null },
]);
const seedPending = () => ([
  { uid: 'u_kumar', email: 'kumar.realtor@gmail.com', nameGiven: 'Swami – new phone', via: ['password'], verified: false, created: Date.now() - 2 * day },
  { uid: 'u_spam', email: 'test123@mailinator.com', nameGiven: '', via: ['password'], verified: false, created: Date.now() - 9 * day },
]);

// ── The server stand-in (api/_agent.js's behaviour, guard rails included) ──
function makeServer(meKey, config, opts = {}) {
  const state = { users: seedUsers(), pending: seedPending(), listOnly: ['sales@threepin.in'], calls: [] };
  const me = PEOPLE[meKey];
  const leavesNoAdmin = (uid, next) => !state.users.some(u => {
    const role = u.uid === uid && next.role !== undefined ? next.role : u.role;
    const active = u.uid === uid && next.active !== undefined ? next.active : u.active;
    return role === 'admin' && active && u.verified;
  });
  const phone = s => { const d = String(s || '').replace(/\D/g, '').replace(/^0+/, ''); if (!d) return ''; if (d.length === 10) return '91' + d; return d.length >= 11 && d.length <= 13 ? d : null; };
  return {
    state,
    handle(body) {
      state.calls.push(body);
      const admin = me.claims.role === 'admin';
      if (body.action === 'me') {
        if (opts.meFails) return [500, { error: 'cold start' }];
        return [200, { role: me.claims.role || 'none', email: me.email, config: me.claims.role === 'agent' ? AC.effectiveConfig(config(), me.email) : undefined }];
      }
      if (!admin) return [403, { error: 'Admins only' }];
      const u = state.users.find(x => x.uid === body.uid);
      switch (body.action) {
        case 'team': return [200, { users: state.users.map(x => ({ ...x, self: x.uid === me.uid })), pending: state.pending, listOnly: state.listOnly }];
        case 'set-role':
          if (body.uid === me.uid) return [400, { error: 'You cannot change your own role' }];
          if (!u) return [404, { error: 'No such login on this team' }];
          if (leavesNoAdmin(u.uid, { role: body.role })) return [400, { error: 'That would leave the team with no admin' }];
          u.role = body.role; return [200, { ok: true }];
        case 'set-active':
          if (typeof body.active !== 'boolean') return [400, { error: 'Say whether the account is active' }];
          if (body.uid === me.uid && !body.active) return [400, { error: 'You cannot turn off your own account' }];
          if (!body.active && leavesNoAdmin(u.uid, { active: false })) return [400, { error: 'That would leave the team with no admin' }];
          if (opts.activeFails) return [500, { error: 'Something went wrong — try again' }];
          u.active = body.active; return [200, { ok: true }];
        case 'set-profile': {
          const p = phone(body.phone);
          if (p === null) return [400, { error: 'Enter a 10-digit mobile number' }];
          u.name = String(body.name || '').trim(); u.phone = p; return [200, { ok: true, name: u.name, phone: u.phone }];
        }
        case 'reset-password':
          if (body.uid === me.uid) return [400, { error: 'Change your own password from the sign-in page' }];
          if (u.role === 'admin') return [403, { error: 'Admins sign in with “Continue with Google” — no password reset needed' }];
          return [200, { ok: true, email: u.email, password: 'Zr4-newPass9' }];
        case 'team-list': {
          const x = state.users.find(y => y.email === body.email); if (x) x.teamList = body.on === true; return [200, { ok: true }];
        }
        case 'add-user': {
          const email = String(body.email || '').trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return [400, { error: 'Enter an email address' }];
          if (email === 'x@otherbusiness.in') return [400, { error: 'That email belongs to another business' }];
          if (state.users.some(y => y.email === email)) return [409, { error: 'Already on the team — change their role from their row in People' }];
          const p = phone(body.phone); if (p === null) return [400, { error: 'Enter a 10-digit mobile number' }];
          state.users.push({ uid: 'u_' + email.split('@')[0], email, name: String(body.name || '').trim(), phone: p, role: body.role, active: true, verified: true, teamList: !!body.teamList, lastLogin: null });
          return [200, { ok: true, email, role: body.role, name: String(body.name || '').trim(), phone: p, password: 'Qx7-pR2mZ9kL' }];
        }
        case 'approve': {
          if (body.role !== 'agent' && body.role !== 'none') return [400, { error: 'Let them in as an agent or full access' }];
          const i = state.pending.findIndex(x => x.uid === body.uid); if (i < 0) return [404, { error: 'That request is gone' }];
          const p = state.pending.splice(i, 1)[0];
          state.users.push({ uid: p.uid, email: p.email, name: '', phone: '', role: body.role, active: true, verified: true, teamList: !!body.teamList, lastLogin: null });
          return [200, { ok: true, email: p.email, role: body.role, password: p.via.includes('password') ? 'Ap9-oneTime' : null }];
        }
        case 'dismiss': state.pending = state.pending.filter(x => x.uid !== body.uid); return [200, { ok: true }];
      }
      return [400, { error: 'Unknown action' }];
    },
  };
}

// ── Firebase stand-in: the signed-in person from window.__WHO; agentConfigs in window.__fs, written
//    only by an admin with only the keys firestore.rules allows; window.__slowSave delays the write ──
const FIREBASE = `
const W = () => window.__WHO;
export const initializeApp = () => ({}), getApps = () => [];
export const getAuth = () => ({ get currentUser() { return W() ? user() : null; } });
function user() { const w = W(); return { uid: w.uid, email: w.email, displayName: w.name || '',
  getIdToken: async () => 'tok', getIdTokenResult: async () => ({ claims: w.claims }) }; }
export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb(W() ? user() : null), 0); return () => {}; };
export const signOut = async () => { window.__signedOut = true; }, signInWithEmailAndPassword = async () => {};
export const getFirestore = () => ({}), initializeFirestore = () => ({}), persistentLocalCache = () => ({}), persistentMultipleTabManager = () => ({});
export const doc = (db, ...p) => ({ path: p.join('/') });
export const getDoc = async r => { const v = (window.__fs || {})[r.path]; return { exists: () => !!v, data: () => v && JSON.parse(JSON.stringify(v)) }; };
const KEYS = ${JSON.stringify(['tenantId', 'tabs', 'otherPropertyFields', 'ownPropertyFields', 'grantedPropertyFields', 'matchingLeadFields', 'adsScope', 'campaignsScope', 'actions', 'approvals', 'overrides', 'updatedAt', 'updatedBy'])};
export const setDoc = async (r, v) => {
  const c = W().claims;
  if (window.__slowSave) await new Promise(res => setTimeout(res, window.__slowSave));
  if (c.role !== 'admin' || !c.email_verified || !Object.keys(v).every(k => KEYS.includes(k))) { const e = new Error('denied'); e.code = 'permission-denied'; throw e; }
  window.__fs[r.path] = JSON.parse(JSON.stringify(v)); window.__writes = (window.__writes || 0) + 1;
};
export const runTransaction = async (db, fn) => {
  const sets = [];
  const tx = { get: getDoc, set: (r, v) => { sets.push([r, v]); return tx; } };
  await fn(tx);
  for (const [r, v] of sets) await setDoc(r, v);
};
export const collection = () => ({}), onSnapshot = () => () => {}, getDocs = async () => ({ docs: [] }), query = () => ({}), where = () => ({});
export const clearIndexedDbPersistence = async () => { window.__cacheCleared = (window.__cacheCleared || 0) + 1; }, terminate = async () => {};
`;

const CRM_STUB = who => `
const ME = ${JSON.stringify(who)}, TEN = '${T}';
window.crmFirebase = { saveLead: async()=>{}, deleteLead: async()=>{}, getLeadNotes: async()=>[], getLeadHistory: async()=>[], saveNote: async()=>{},
  deleteNoteDoc: async()=>{}, saveHistory: async()=>{}, savePipeline: async()=>{}, getBotConfig: async()=>null, saveBotConfig: async()=>{},
  saveEnquiryTypes: async()=>{}, saveProperties: async()=>{}, saveFollowupDigestSettings: async()=>{}, saveDashboardEmailSettings: async()=>{},
  releaseLeadField: async()=>{}, getLeadTailorTalk: async()=>null, updateLeadAi: async()=>{}, saveAutomationSettings: async()=>{}, saveTeam: async()=>{},
  getInventory: async()=>[], watchTrackTasks: ()=>{} };
window.crmAuth = { login: async()=>{}, logout: async()=>{}, getIdToken: async()=>'x', getTenantId: ()=>TEN };
window.crmTasks = { create: async()=>{}, update: async()=>{}, remove: async()=>{}, notify: async()=>({ok:true}), config: () => ({ managers: [] }), tenantId: () => TEN };
window.onCrmAuthChange({ email: ME });
if (window.applyPipelineSnapshot) window.applyPipelineSnapshot([{ id: 'new', name: 'New' }]);
window.applyLeadsSnapshot([]);
if (window.applyTasksSnapshot) window.applyTasksSnapshot([], 'mine', null, false);
window.__ready = true;
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

const browser = await chromium.launch({ channel: 'chrome' });
const PHONE = { width: 390, height: 844 }, DESK = { width: 1366, height: 860 };

async function open(meKey, viewport, path, { scheme = 'light', config = () => null, fs = {}, server: serverOpts = {}, meDelay = 120, lastAccess = null } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: scheme, hasTouch: viewport.width < 600 });
  const who = PEOPLE[meKey];
  await ctx.addInitScript(([w, f, last]) => {
    window.__WHO = w; window.__fs = f;
    try {
      if (!sessionStorage.getItem('__seeded')) {
        localStorage.clear(); sessionStorage.clear();
        if (last) localStorage.setItem('pin.access.last', JSON.stringify(last));
        localStorage.setItem('pin.agentWiped.u_rameez', '1');
        sessionStorage.setItem('__seeded', '1');
      }
    } catch (e) {}
  }, [who, fs, lastAccess]);
  const page = await ctx.newPage();
  const server = makeServer(meKey, config, serverOpts);
  page.server = server;
  page.dialogAnswer = true;
  page.dialogs = [];
  page.on('pageerror', e => { console.log('  PAGEERROR ' + e.message); errors.push('pageerror: ' + e.message); });
  page.on('dialog', d => { page.dialogs.push(d.message()); return page.dialogAnswer ? d.accept() : d.dismiss(); });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.gstatic.com' && /firebasejs/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: FIREBASE });
    if (/^(cdnjs\.cloudflare\.com)$/.test(url.hostname)) return route.continue();
    if (url.hostname !== 'app.local') return route.abort();
    if (url.pathname === '/api/agent') {
      const body = JSON.parse(route.request().postData() || '{}');
      const [status, out] = server.handle(body);
      await new Promise(r => setTimeout(r, body.action === 'me' ? meDelay : 120));
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(out) });
    }
    if (url.pathname === '/crm-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: CRM_STUB(who.email) });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://app.local' + path);
  return page;
}
const noSideways = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const shot = (page, name, full = true) => page.screenshot({ path: join(OUT, name + '.png'), fullPage: full });
const menu = page => page.evaluate(() => [...document.querySelectorAll('#appRail .rl-h .rl-nm, #appRail .rl-item .rl-nm')].map(n => n.textContent));
const smallTargets = page => page.evaluate(() => [...document.querySelectorAll('#main button, #main [role=button], #main label.chk, #main .choices label, #main select, #main input[type=email], .sheet button, .sheet a.btn, .savebar button')]
  .filter(el => el.offsetParent && el.getBoundingClientRect().height < 40).map(el => (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30)));
const fsDoc = page => page.evaluate(() => window.__fs['agentConfigs/t_3pinrealty']);
const openFold = (page, key) => page.click(`details[data-fold=${key}] > summary`);
const waitToast = async page => { await page.waitForSelector('.toast'); await page.waitForTimeout(250); };

// ═══════ SWAMI — admin, phone ═══════
for (const scheme of ['light', 'dark']) {
  console.log(`\nSwami (admin) — phone, ${scheme}`);
  const page = await open('swami', PHONE, '/team.html', { scheme });
  await page.waitForSelector('#people .row', { timeout: 15000 });
  await page.waitForTimeout(300);
  ok('People are grouped: Admins, Agents, Full access (staff)', await page.evaluate(() => [...document.querySelectorAll('#people .group-h')].map(h => h.firstChild.textContent.trim()).join('|') === 'Admins|Agents|Full access (staff)'));
  ok('Accounts that signed themselves up wait at the top, marked Waiting', await page.evaluate(() => /Waiting for approval/.test(document.querySelector('#pendingWrap').textContent) && document.querySelectorAll('#pendingWrap .row').length === 2));
  ok('Rows say “16d ago”, not a wrapped sentence', await page.evaluate(() => /16d ago/.test(document.querySelector('#people').textContent)));
  ok('“not in team lists” only where it is true', await page.evaluate(() => (document.querySelector('#people').textContent.match(/not in team lists/g) || []).length === 2));
  ok('No sideways scroll on a phone', await noSideways(page));
  ok('Every tap target at least 40px tall', (await smallTargets(page)).length === 0, (await smallTargets(page)).join(' | '));
  ok('Team & access is in the admin’s menu', (await menu(page)).includes('Team & access'));
  await shot(page, `phone-people-${scheme}`);
  await page.click('.seg button[data-tab=agents]');
  await page.waitForSelector('#settings details');
  await shot(page, `phone-settings-${scheme}`);
  if (scheme === 'dark') {
    ok('Dark: the selected segment stands apart from the other', await page.evaluate(() => {
      const [a, b] = [...document.querySelectorAll('.seg button')].map(x => getComputedStyle(x).backgroundColor);
      return a !== b;
    }));
    await page.context().close(); continue;
  }
  await page.click('.seg button[data-tab=people]');

  // Rameez's sheet: name, WhatsApp, the consequence of a role change, reset password
  await page.click('#people .row[data-uid="u_rameez"]');
  await page.waitForSelector('.sheet');
  ok('A person’s sheet has name and WhatsApp number', !!(await page.$('#pName')) && !!(await page.$('#pPhone')));
  ok('…the three roles, theirs selected', await page.evaluate(() => document.querySelector('.sheet input[name=role]:checked').value === 'agent'));
  ok('…and a way to customise what this agent sees', !!(await page.$('#pCust')));
  await page.click('.sheet input[name=role][value=none]');
  ok('Choosing another role says what will happen before Save', /will see all properties and leads, owner numbers included/.test(await page.textContent('#pConseq')));
  await page.click('.sheet input[name=role][value=agent]');
  ok('Back to the same role: the warning goes', await page.$eval('#pConseq', e => e.hidden));
  await shot(page, 'phone-person-sheet', false);
  ok('Sheet tap targets at least 40px', (await smallTargets(page)).length === 0, (await smallTargets(page)).join(' | '));
  await page.fill('#pName', 'Rameez Khan');
  await page.fill('#pPhone', '98400 12345');
  await page.click('#pSave'); await waitToast(page);
  ok('Name and WhatsApp number saved (91 added)', (() => { const u = page.server.state.users.find(x => x.uid === 'u_rameez'); return u.name === 'Rameez Khan' && u.phone === '919840012345'; })());
  ok('The list shows his name now', await page.evaluate(() => /Rameez Khan/.test(document.querySelector('#people').textContent)));
  await page.click('#people .row[data-uid="u_rameez"]'); await page.waitForSelector('.sheet');
  await page.click('#pReset');
  await page.waitForSelector('.pw');
  ok('Reset password asks first, then shows the new one once', page.dialogs.some(m => /new password/.test(m)) && (await page.textContent('.pw')) === 'Zr4-newPass9');
  const wa = await page.getAttribute('.sheet a.btn.wa', 'href');
  ok('“Send login on WhatsApp” goes to his number with the sign-in message', /^https:\/\/wa\.me\/919840012345\?text=/.test(wa) && /Zr4-newPass9/.test(decodeURIComponent(wa)) && /admin\.threepin\.in/.test(decodeURIComponent(wa)), wa);
  await shot(page, 'phone-reset-password', false);
  await page.click('.sheet .btn.primary[data-close]');
  ok('Done closes the password sheet', !(await page.$('.sheet')));
  await page.click('#people .row[data-uid="u_rameez"]'); await page.waitForSelector('.sheet');
  await page.keyboard.press('Escape');
  ok('Escape closes an ordinary sheet', !(await page.$('.sheet')));

  // Another admin: no password reset (an admin cannot take over another admin's account)
  await page.click('#people .row[data-uid="u_thirumal"]'); await page.waitForSelector('.sheet');
  ok('Another admin’s sheet offers no password reset, and says why', !(await page.$('#pReset')) && /Continue with Google/.test(await page.textContent('.sheet')));
  await page.click('.sheet [data-close]');

  // Own row
  await page.click('#people .row[data-uid="u_swami"]'); await page.waitForSelector('.sheet');
  ok('Your own sheet says plainly that another admin changes your role — no greyed-out choices', await page.evaluate(() =>
    !document.querySelector('.sheet input[name=role]') && !document.querySelector('#pActive') && /Another admin can change your role/.test(document.querySelector('.sheet').textContent)));
  ok('…and offers no password reset for yourself', !(await page.$('#pReset')));
  await shot(page, 'phone-self-sheet', false);
  await page.click('.sheet [data-close]');

  // Add a person
  await page.click('#addBtn'); await page.waitForSelector('.sheet');
  ok('Add a person: email has focus, Agent preselected, name and WhatsApp asked', await page.evaluate(() =>
    document.activeElement.id === 'nEmail' && document.querySelector('.sheet input[name=nrole]:checked').value === 'agent' && !!document.getElementById('nPhone')));
  await page.click('#nSave'); await page.waitForTimeout(300);
  ok('An empty email is refused with a message', /Enter an email/.test(await page.textContent('#nErr')));
  await page.fill('#nEmail', 'thirumal@threepin.in'); await page.click('#nSave'); await page.waitForTimeout(300);
  ok('Someone already on the team cannot be “added” (their role is not changed behind the guard rails)', /Already on the team/.test(await page.textContent('#nErr')) && page.server.state.users.find(u => u.uid === 'u_thirumal').role === 'admin');
  await page.fill('#nEmail', 'x@otherbusiness.in'); await page.click('#nSave'); await page.waitForTimeout(300);
  ok('Another business’s email is refused with a message', /another business/.test(await page.textContent('#nErr')));
  await shot(page, 'phone-add-error', false);
  ok('No stray “Saved” message over an error', !(await page.$('.toast')));
  await page.fill('#nEmail', 'Kavya@threepin.in'); await page.fill('#nName', 'Kavya'); await page.fill('#nPhone', '9876543210');
  await page.click('#nSave');
  await page.waitForSelector('.pw');
  ok('A new login shows its one-time password', (await page.textContent('.pw')) === 'Qx7-pR2mZ9kL');
  ok('…with WhatsApp to her number, Copy, and “Customise what they see”', /wa\.me\/919876543210/.test(await page.getAttribute('.sheet a.btn.wa', 'href')) && !!(await page.$('#cpBtn')) && !!(await page.$('#custBtn')));
  await shot(page, 'phone-add-password', false);
  await page.keyboard.press('Escape');
  ok('Escape does not throw away a one-time password still on screen', !!(await page.$('.pw')));
  await page.mouse.click(195, 40);
  ok('Nor does a tap outside the sheet', !!(await page.$('.pw')));
  await page.click('#custBtn');
  await page.waitForSelector('.banner');
  ok('“Customise what they see” opens her settings, clearly marked “Editing Kavya only”', /Editing Kavya only/.test(await page.textContent('.banner')));
  await page.click('#backBtn');
  await page.click('.seg button[data-tab=people]');

  // Waiting for approval
  await page.click('#pendingWrap .row[data-pending="u_kumar"]'); await page.waitForSelector('.sheet');
  ok('A sign-up is shown by its email; the name it gave itself is labelled as such, never as a name', await page.evaluate(() =>
    /kumar\.realtor@gmail\.com/.test(document.querySelector('.sheet h3').textContent) && /calls themselves “Swami – new phone”/.test(document.querySelector('.sheet .sub').textContent)));
  ok('…says the email is not confirmed, and that their chosen password will be replaced', /email not confirmed/.test(await page.textContent('.sheet .sub')) && /password they chose is replaced/.test(await page.textContent('.sheet .callout')));
  ok('…and offers only Agent or Full access (never straight to Admin)', await page.evaluate(() => [...document.querySelectorAll('.sheet input[name=arole]')].map(i => i.value).join() === 'agent,none'));
  await shot(page, 'phone-pending-sheet', false);
  await page.click('#aOk'); await page.waitForSelector('.pw');
  ok('Let in: a one-time password to send them replaces the one they chose', (await page.textContent('.pw')) === 'Ap9-oneTime');
  await page.click('.sheet [data-close]');
  ok('Kumar is now an agent on the team, listed by email (not by his self-given name)', page.server.state.users.some(u => u.uid === 'u_kumar' && u.role === 'agent') && await page.evaluate(() => /kumar\.realtor@gmail\.com/.test(document.querySelector('#people').textContent) && !/Swami – new phone/.test(document.querySelector('#people').textContent)));
  await page.click('#pendingWrap .row[data-pending="u_spam"]'); await page.waitForSelector('.sheet');
  await page.click('#aDismiss'); await waitToast(page);
  ok('Remove request: the sign-up is gone and the waiting list hides', page.server.state.pending.length === 0 && await page.evaluate(() => !document.querySelector('#pendingWrap').textContent));

  // ── What agents see ──
  await page.click('.seg button[data-tab=agents]');
  await page.waitForSelector('#settings details');
  ok('Menu: only the tabs agents can have are offered', await page.evaluate(() => [...document.querySelectorAll('input[data-key=tabs]')].map(i => i.value).join() === 'properties,crm,tasks,ads,campaigns'));
  ok('…the rest named in one line: coming later / not for agents', await page.evaluate(() => /Coming later: My Day, Messages, Team calendar/.test(document.querySelector('#settings').textContent) && /Not for agents: Shoot & Media, Finance/.test(document.querySelector('#settings').textContent)));
  ok('Sections that don’t work yet say “Later update”', await page.evaluate(() => document.querySelectorAll('#settings summary .later').length >= 7));
  ok('Other properties: the richer summary, no street', /Title, BHK \/ configuration and 5 more/.test(await page.textContent('[data-sum=otherPropertyFields]')), await page.textContent('[data-sum=otherPropertyFields]'));
  ok('Approvals default: the primary agent or an admin', /primary agent, or an admin/.test(await page.textContent('[data-sum=approvals]')));
  ok('No save bar until something changes', await page.evaluate(() => document.getElementById('savebar').hidden));
  ok('The page is short on a phone (folded groups)', await page.evaluate(() => document.documentElement.scrollHeight < 2400), await page.evaluate(() => document.documentElement.scrollHeight));
  ok('Settings tap targets at least 40px', (await smallTargets(page)).length === 0, (await smallTargets(page)).join(' | '));

  // A risky tick is confirmed in plain words; saying no leaves it off
  await openFold(page, 'otherPropertyFields');
  page.dialogAnswer = false;
  await page.click('input[data-key=otherPropertyFields][value=contact]');
  ok('Ticking the owner’s number on others’ properties asks first; “no” leaves it off', page.dialogs.some(m => /every owner’s name and phone number/.test(m)) && !(await page.isChecked('input[data-key=otherPropertyFields][value=contact]')));
  page.dialogAnswer = true;
  await page.click('input[data-key=otherPropertyFields][value=code]');
  ok('A safe tick needs no question and shows the save bar', await page.evaluate(() => !document.getElementById('savebar').hidden));
  await openFold(page, 'approvals');
  await page.click('input[name=approvers][value=admins]');
  await openFold(page, 'actions');
  await page.click('input[data-action=exportOwn]');
  await shot(page, 'phone-settings-dirty', false);
  await page.click('#saveBtn'); await waitToast(page);
  let saved = await fsDoc(page);
  ok('Saved: the new field, approvers and action', saved && saved.otherPropertyFields.includes('code') && saved.approvals.approvers === 'admins' && saved.actions.exportOwn === false, JSON.stringify(saved && saved.approvals));
  ok('Saved with who and when', saved.updatedBy === 'swami@threepin.in' && saved.updatedAt > 0);
  ok('The save bar goes away after saving', await page.evaluate(() => document.getElementById('savebar').hidden));

  // Per agent
  await page.selectOption('#forWho', 'rameez@threepin.in');
  ok('Editing one agent is unmistakable: a banner names him', /Editing Rameez Khan only/.test(await page.textContent('.banner')));
  ok('…and the banner never pushes the page sideways', await noSideways(page));
  await page.click('input[data-key=tabs][value=campaigns]');
  ok('What differs from the common settings is marked', await page.evaluate(() => document.querySelector('input[data-key=tabs][value=campaigns]').closest('.chk').classList.contains('diff')));
  ok('The save bar names whose changes they are', /for rameez/.test(await page.textContent('#saveMsg')));
  await page.click('#saveBtn'); await waitToast(page);
  saved = await fsDoc(page);
  ok('Only what differs is stored for Rameez', JSON.stringify(saved.overrides) === JSON.stringify({ 'rameez@threepin.in': { tabs: ['properties', 'crm', 'tasks', 'ads'] } }), JSON.stringify(saved.overrides));
  ok('The common settings are untouched by his change', saved.tabs.join() === 'properties,crm,tasks,ads,campaigns');
  await shot(page, 'phone-settings-agent');
  // QA #5: switch tabs and back — his own-settings banner and reset are still there
  await page.click('.seg button[data-tab=people]'); await page.click('.seg button[data-tab=agents]');
  ok('After switching tabs, “Reset to common settings” is still offered', !!(await page.$('#resetBtn')));
  await page.click('#resetBtn'); await waitToast(page);
  ok('Reset removes his own settings', Object.keys((await fsDoc(page)).overrides).length === 0);

  // QA #3: the agent being edited stops being an agent
  await page.selectOption('#forWho', 'rameez@threepin.in');
  await page.click('.seg button[data-tab=people]');
  await page.click('#people .row[data-uid="u_rameez"]'); await page.waitForSelector('.sheet');
  await page.click('.sheet input[name=role][value=none]'); await page.click('#pSave'); await waitToast(page);
  await page.click('.seg button[data-tab=agents]');
  ok('When he is no longer an agent, the page goes back to the common settings (no silent override)', (await page.inputValue('#forWho')) === '' && !(await page.$('.banner')) && /every agent/.test(await page.textContent('#forState')));
  await page.click('input[data-key=tabs][value=ads]'); await page.click('#saveBtn'); await waitToast(page);
  saved = await fsDoc(page);
  ok('…so the next save changes the common settings, not his', !saved.tabs.includes('ads') && Object.keys(saved.overrides).length === 0, JSON.stringify(saved.overrides));

  // QA #4: a tick while saving cannot be lost
  await page.evaluate(() => { window.__slowSave = 1200; });
  await page.click('input[data-key=tabs][value=ads]');
  await page.click('#saveBtn');
  await page.waitForTimeout(200);
  ok('While saving, the settings are locked (nothing ticked meanwhile can vanish)', await page.evaluate(() => document.getElementById('settingsFs').disabled));
  await page.waitForFunction(() => !document.getElementById('settingsFs').disabled, null, { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => { window.__slowSave = 0; });
  ok('…and unlocked after', await page.evaluate(() => !document.getElementById('settingsFs').disabled));
  ok('…with the change saved', (await fsDoc(page)).tabs.includes('ads'));

  // QA #19: another admin saved in the meantime
  await page.evaluate(() => { const d = window.__fs['agentConfigs/t_3pinrealty']; d.updatedAt += 5; d.updatedBy = 'thirumal@threepin.in'; d.tabs = ['crm']; });
  await page.click('input[data-key=tabs][value=tasks]');
  await page.click('#saveBtn'); await page.waitForSelector('.toast');
  ok('Another admin’s newer save is not overwritten; you are told whose', /Another admin \(thirumal@threepin\.in\)/.test(await page.textContent('.toast')) && (await fsDoc(page)).tabs.join() === 'crm');
  ok('…their version is loaded at once, so a second click has nothing stale to save', await page.evaluate(() => document.getElementById('savebar').hidden
    && [...document.querySelectorAll('input[data-key=tabs]:checked')].map(i => i.value).join() === 'crm'));

  // An agent's own settings that end up identical to the common ones are dropped
  await page.waitForTimeout(2500);
  await page.selectOption('#forWho', 'kavya@threepin.in');
  await page.click('input[data-key=tabs][value=tasks]');
  await page.click('#saveBtn'); await waitToast(page);
  ok('Kavya has her own settings (crm + tasks)', JSON.stringify((await fsDoc(page)).overrides) === JSON.stringify({ 'kavya@threepin.in': { tabs: ['crm', 'tasks'] } }), JSON.stringify((await fsDoc(page)).overrides));
  await page.click('#backBtn');
  await page.click('input[data-key=tabs][value=tasks]');
  await page.click('#saveBtn'); await waitToast(page);
  ok('When the common settings come to match hers, her identical own settings are dropped', Object.keys((await fsDoc(page)).overrides).length === 0, JSON.stringify((await fsDoc(page)).overrides));
  await page.context().close();
}

// ═══════ A failed step in a person’s sheet (QA #6) ═══════
console.log('\nSwami — a save that fails half-way');
{
  const page = await open('swami', PHONE, '/team.html', { server: { activeFails: true } });
  await page.waitForSelector('#people .row');
  await page.click('#people .row[data-uid="u_dev"]'); await page.waitForSelector('.sheet');
  await page.click('.sheet input[name=role][value=agent]');
  await page.click('#pActive');
  await page.click('#pSave'); await page.waitForTimeout(600);
  ok('The error is shown in the sheet', /try again/.test(await page.textContent('#pErr')));
  ok('The list behind already shows what did succeed (the role)', await page.evaluate(() => /Agent/.test(document.querySelector('#people .row[data-uid="u_dev"] .pill:last-child').textContent)));
  const roleCalls = () => page.server.state.calls.filter(c => c.action === 'set-role').length;
  const before = roleCalls();
  await page.click('#pSave'); await page.waitForTimeout(600);
  ok('Pressing Save again does not repeat the role change', roleCalls() === before);
  await page.context().close();
}

// ═══════ SWAMI — desktop ═══════
console.log('\nSwami (admin) — desktop');
{
  const page = await open('swami', DESK, '/team.html');
  await page.waitForSelector('#people .row'); await page.waitForTimeout(300);
  ok('Desktop: the menu rail is shown', await page.evaluate(() => document.body.classList.contains('rail-on')));
  await shot(page, 'desk-people', false);
  await page.click('.seg button[data-tab=agents]'); await page.waitForSelector('#settings details');
  await openFold(page, 'grantedPropertyFields');
  await page.click('input[data-key=grantedPropertyFields][value=code]');
  await shot(page, 'desk-settings', false);
  ok('Desktop: the save bar sits beside the menu, not under it', await page.evaluate(() => document.getElementById('savebar').getBoundingClientRect().left >= document.getElementById('appRail').getBoundingClientRect().right - 1));
  await page.context().close();
}

// ═══════ A shared phone: the last person was an agent ═══════
console.log('\nShared phone — Swami signs in after Rameez');
{
  const page = await open('swami', DESK, '/crm.html?nav=tasks', { lastAccess: { uid: 'u_rameez', role: 'agent', tabs: ['crm'], config: { tabs: ['crm'] } } });
  await page.waitForFunction(() => window.__ready === true && window.PinAccess, null, { timeout: 20000 });
  await page.waitForTimeout(500);
  const m = await menu(page);
  ok('The admin gets the full menu with Team & access, not the previous agent’s cut-down one', m.includes('Finance') && m.includes('Team & access'), m.join(', '));
  await page.context().close();
}

// ═══════ RAJESH — full access, no role ═══════
console.log('\nRajesh (full access, no role)');
{
  const page = await open('rajesh', PHONE, '/team.html');
  await page.waitForSelector('#denied:not([hidden])', { timeout: 15000 });
  ok('Team & access says “Admins only” with a way back', /Admins only/.test(await page.textContent('#denied')));
  ok('No people or settings were fetched', !page.server.state.calls.some(c => c.action === 'team'));
  await shot(page, 'phone-rajesh-denied', false);
  await page.context().close();
  const crm = await open('rajesh', DESK, '/crm.html?nav=tasks');
  await crm.waitForFunction(() => window.__ready === true && document.querySelectorAll('#appRail .rl-nm').length > 3, null, { timeout: 20000 });
  await crm.waitForTimeout(600);
  const m = await menu(crm);
  ok('His menu is as before (Finance, Shoot & Media there), without Team & access', m.includes('Finance') && m.includes('Shoot & Media') && !m.includes('Team & access'), m.join(', '));
  ok('His menu header still says Admin', /Admin/.test(await crm.textContent('.rail-brand-sb')));
  await crm.context().close();
}

// ═══════ RAMEEZ — agent ═══════
console.log('\nRameez (agent)');
{
  const page = await open('rameez', DESK, '/crm.html?nav=tasks');
  await page.waitForFunction(() => window.__ready === true && window.PinAccess, null, { timeout: 20000 });
  await page.waitForTimeout(600);
  const m = await menu(page);
  ok('His menu: only his tabs — no Finance, Shoot & Media, Team & access, Create brochure', !m.includes('Finance') && !m.includes('Shoot & Media') && !m.includes('Team & access') && !m.includes('Create brochure'), m.join(', '));
  ok('His menu has Properties, CRM, Tasks, Campaigns and Meta Ads', ['Properties', 'CRM', 'Tasks', 'WhatsApp Campaigns', 'Meta Ads Leads'].every(x => m.includes(x)), m.join(', '));
  ok('Setup screens are hidden from him', !['Missing data', 'Sync from sheet', 'Setup', 'Analytics', 'Templates', 'New campaign'].some(x => m.includes(x)), m.join(', '));
  ok('His menu header says Agent, not Admin', /Agent/.test(await page.textContent('.rail-brand-sb')));
  await shot(page, 'desk-rameez-crm', false);
  await page.context().close();

  // First paint from the device's last answer: no flash of the full menu while the check runs
  const p0 = await open('rameez', DESK, '/crm.html?nav=tasks', { meDelay: 2500, lastAccess: { uid: 'u_rameez', role: 'agent', tabs: ['crm', 'tasks'], config: { tabs: ['crm', 'tasks'] } } });
  await p0.waitForFunction(() => document.querySelectorAll('#appRail .rl-nm').length > 0, null, { timeout: 20000 });
  const early = await menu(p0);
  ok('While the check is still running, his menu is already his (from this device’s last answer)', !early.includes('Finance') && !early.includes('Shoot & Media') && early.includes('CRM'), early.join(', '));
  await p0.context().close();

  // A deep link to a staff-only view is ignored
  const pd = await open('rameez', DESK, '/crm.html?nav=ml-setup', { lastAccess: { uid: 'u_rameez', role: 'agent', tabs: ['crm', 'ads'], config: { tabs: ['crm', 'ads'] } } });
  await pd.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await pd.waitForTimeout(600);
  ok('A link to Meta Ads Setup does not open it for an agent', await pd.evaluate(() => typeof currentView === 'undefined' || currentView !== 'ml-setup'));
  await pd.context().close();

  // The check fails (cold start): no lock-out, the last known settings are used
  const pf = await open('rameez', DESK, '/crm.html?nav=tasks', { server: { meFails: true }, lastAccess: { uid: 'u_rameez', role: 'agent', tabs: ['crm', 'tasks'], config: { tabs: ['crm', 'tasks'] } } });
  await pf.waitForFunction(() => window.__ready === true && window.PinAccess, null, { timeout: 20000 });
  await pf.waitForTimeout(500);
  ok('A failed check never closes a page he is allowed', !(await pf.$('#pinGate')));
  ok('…and the menu uses the last known tabs', (await menu(pf)).includes('CRM') && !(await menu(pf)).includes('Finance'));
  await pf.context().close();

  // A narrower set from the admin: only Properties
  const p2 = await open('rameez', DESK, '/crm.html?nav=tasks', { config: () => ({ tabs: ['properties'] }) });
  await p2.waitForSelector('#pinGate', { timeout: 20000 });
  ok('A page none of his tabs open is closed with a plain note', /isn’t part of your access/.test(await p2.textContent('#pinGate')));
  ok('…offering the pages he does have, and a sign-out', await p2.evaluate(() => [...document.querySelectorAll('#pinGate a')].map(a => a.textContent).join() === 'Open Properties' && !!document.getElementById('pinGateOut')));
  const centre = await p2.evaluate(() => { const r = document.querySelector('#pinGate').getBoundingClientRect(); return { mid: (r.left + r.right) / 2, w: document.documentElement.clientWidth, cls: document.body.className, pad: getComputedStyle(document.body).paddingLeft, html: document.documentElement.className }; });
  ok('…centred on the screen (within the CRM’s reserved scrollbar strip)', Math.abs(centre.mid - centre.w / 2) < 8, JSON.stringify(centre));
  await shot(p2, 'desk-rameez-closed', false);
  await p2.context().close();

  // The /ads address (a rewrite of crm.html) is checked like crm.html: the page says its console
  const pa = await open('rameez', PHONE, '/crm.html', { config: () => ({ tabs: ['properties'] }) });
  await pa.waitForSelector('#pinGate', { timeout: 20000 });
  ok('Every CRM address is checked (the page says which console it is)', !!(await pa.$('#pinGate')));
  await pa.context().close();

  const p3 = await open('rameez', PHONE, '/team.html');
  await p3.waitForSelector('#pinGate', { timeout: 20000 });
  ok('Team & access is closed to him, with no errors behind the note', /isn’t part of your access/.test(await p3.textContent('#pinGate')));
  await shot(p3, 'phone-rameez-team', false);
  await p3.context().close();
}

await browser.close();
console.log(errors.length ? `\n${errors.length} problem(s):\n  - ` + errors.join('\n  - ') : '\nAll good. Screenshots in ' + OUT);
process.exit(errors.length ? 1 : 0);
