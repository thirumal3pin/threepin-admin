// ═══════ TEAM & ACCESS + THE AGENT MENU — played as an admin, a teammate and an agent ═══════
//
// The real team.html and crm.html in Chrome, with Firebase and /api/agent swapped for in-memory
// stand-ins that answer like the real ones (the server's guard rails included: nobody changes their
// own role, the last admin cannot go, an email of another business is refused). People played:
//   Swami   — admin: manages people and agent settings
//   Rajesh  — on the team, no role: works as before, cannot open Team & access
//   Rameez  — agent: sees only the tabs the admin gave him
// Phone (390×844) and desktop, light and dark. Screenshots go to tests/out/team/.
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
  { uid: 'u_swami', email: 'swami@threepin.in', name: 'Swami', role: 'admin', active: true, teamList: true, lastLogin: Date.now() - 2 * 3600000 },
  { uid: 'u_thirumal', email: 'thirumal@threepin.in', name: 'Thirumal Ashok', role: 'admin', active: true, teamList: true, lastLogin: Date.now() - 16 * day },
  { uid: 'u_pradeep', email: 'pradeep@threepin.in', name: '', role: 'admin', active: true, teamList: true, lastLogin: Date.now() - 111 * day },
  { uid: 'u_rajesh', email: 'rajesh@threepin.in', name: 'Rajesh S', role: 'none', active: true, teamList: true, lastLogin: Date.now() - 28 * day },
  { uid: 'u_dev', email: 'dev@threepin.in', name: '', role: 'none', active: true, teamList: false, lastLogin: Date.now() - 49 * day },
  { uid: 'u_owner', email: '3pinrentals@gmail.com', name: '3Pin Rentals', role: 'none', active: true, teamList: false, lastLogin: Date.now() - 25 * day },
  { uid: 'u_rameez', email: 'rameez@threepin.in', name: '', role: 'agent', active: true, teamList: true, lastLogin: null },
]);

// ── The server stand-in (api/_agent.js's behaviour, guard rails included) ──
function makeServer(meKey, config) {
  const state = { users: seedUsers(), listOnly: ['admin@threepin.in', 'sales@threepin.in'], calls: [] };
  const me = PEOPLE[meKey];
  const leavesNoAdmin = (uid, role, active) => !state.users.some(u => (u.uid === uid ? role : u.role) === 'admin' && (u.uid === uid ? active : u.active));
  return {
    state,
    handle(body) {
      state.calls.push(body);
      const admin = me.claims.role === 'admin';
      if (body.action === 'me') return [200, { role: me.claims.role || 'none', email: me.email, config: me.claims.role === 'agent' ? AC.effectiveConfig(config(), me.email) : undefined }];
      if (!admin) return [403, { error: 'Admins only' }];
      const u = state.users.find(x => x.uid === body.uid);
      switch (body.action) {
        case 'team': return [200, { users: state.users.map(x => ({ ...x, self: x.uid === me.uid })), listOnly: state.listOnly }];
        case 'set-role':
          if (body.uid === me.uid) return [400, { error: 'You cannot change your own role' }];
          if (!u) return [404, { error: 'No such login on this team' }];
          if (leavesNoAdmin(u.uid, body.role, u.active)) return [400, { error: 'That would leave the team with no admin' }];
          u.role = body.role; return [200, { ok: true }];
        case 'set-active':
          if (body.uid === me.uid && !body.active) return [400, { error: 'You cannot disable your own login' }];
          if (!body.active && leavesNoAdmin(u.uid, u.role, false)) return [400, { error: 'That would leave the team with no admin' }];
          u.active = !!body.active; return [200, { ok: true }];
        case 'team-list': {
          const x = state.users.find(y => y.email === body.email); if (x) x.teamList = !!body.on; return [200, { ok: true }];
        }
        case 'add-user': {
          const email = String(body.email || '').trim().toLowerCase();
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return [400, { error: 'Enter an email address' }];
          if (email === 'x@otherbusiness.in') return [400, { error: 'That email belongs to another business' }];
          const had = state.users.find(y => y.email === email);
          if (had) { had.role = body.role; return [200, { ok: true, email, role: body.role, created: false, password: null }]; }
          state.users.push({ uid: 'u_' + email.split('@')[0], email, name: '', role: body.role, active: true, teamList: !!body.teamList, lastLogin: null });
          state.listOnly = state.listOnly.filter(e => e !== email);
          return [200, { ok: true, email, role: body.role, created: true, password: 'Qx7-pR2mZ9kL' }];
        }
      }
      return [400, { error: 'Unknown action' }];
    },
  };
}

// ── Firebase stand-in: the signed-in person from window.__WHO; agentConfigs in window.__fs, written
//    only by an admin with only the keys firestore.rules allows ──
const FIREBASE = `
const W = () => window.__WHO;
export const initializeApp = () => ({}), getApps = () => [];
export const getAuth = () => ({ get currentUser() { return W() ? user() : null; } });
function user() { const w = W(); return { uid: w.uid, email: w.email, displayName: w.name || '',
  getIdToken: async () => 'tok', getIdTokenResult: async () => ({ claims: w.claims }) }; }
export const onAuthStateChanged = (a, cb) => { setTimeout(() => cb(W() ? user() : null), 0); return () => {}; };
export const signOut = async () => {}, signInWithEmailAndPassword = async () => {};
export const getFirestore = () => ({}), initializeFirestore = () => ({}), persistentLocalCache = () => ({}), persistentMultipleTabManager = () => ({});
export const doc = (db, ...p) => ({ path: p.join('/') });
export const getDoc = async r => { const v = (window.__fs || {})[r.path]; return { exists: () => !!v, data: () => v && JSON.parse(JSON.stringify(v)) }; };
const KEYS = ['tenantId','tabs','otherPropertyFields','ownPropertyFields','grantedPropertyFields','matchingLeadFields','adsScope','campaignsScope','approvals','overrides','updatedAt','updatedBy'];
export const setDoc = async (r, v) => {
  const c = W().claims;
  if (c.role !== 'admin' || !c.email_verified || !Object.keys(v).every(k => KEYS.includes(k))) { const e = new Error('denied'); e.code = 'permission-denied'; throw e; }
  window.__fs[r.path] = JSON.parse(JSON.stringify(v)); window.__writes = (window.__writes || 0) + 1;
};
export const collection = () => ({}), onSnapshot = () => () => {}, getDocs = async () => ({ docs: [] }), query = () => ({}), where = () => ({});
export const clearIndexedDbPersistence = async () => {}, terminate = async () => {};
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

async function open(meKey, viewport, path, { scheme = 'light', config = () => null, fs = {} } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: scheme, hasTouch: viewport.width < 600 });
  const who = PEOPLE[meKey];
  await ctx.addInitScript(([w, f]) => { window.__WHO = w; window.__fs = f; try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} }, [who, fs]);
  const page = await ctx.newPage();
  const server = makeServer(meKey, config);
  page.server = server;
  page.on('pageerror', e => { console.log('  PAGEERROR ' + e.message); errors.push('pageerror: ' + e.message); });
  page.on('dialog', d => d.accept());
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.gstatic.com' && /firebasejs/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: FIREBASE });
    if (/^(cdnjs\.cloudflare\.com)$/.test(url.hostname)) return route.continue();
    if (url.hostname !== 'app.local') return route.abort();
    if (url.pathname === '/api/agent') {
      const [status, body] = server.handle(JSON.parse(route.request().postData() || '{}'));
      await new Promise(r => setTimeout(r, 120));   // a real round trip, so busy states show
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
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
// Tap targets under 40px tall that a thumb has to hit.
const smallTargets = page => page.evaluate(() => [...document.querySelectorAll('#main button, #main [role=button], #main label.chk, #main select, #main input[type=email], .sheet button, .savebar button')]
  .filter(el => el.offsetParent && el.getBoundingClientRect().height < 40).map(el => (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30)));

// ═══════ SWAMI — admin, phone ═══════
for (const scheme of ['light', 'dark']) {
  console.log(`\nSwami (admin) — phone, ${scheme}`);
  const page = await open('swami', PHONE, '/team.html', { scheme });
  await page.waitForSelector('#people .row', { timeout: 15000 });
  await page.waitForTimeout(300);
  ok('People list loads with every login', (await page.$$('#people .row')).length === 7);
  ok('Admins first, then the agent, then the team', await page.evaluate(() => [...document.querySelectorAll('#people .pill:last-child')].map(p => p.textContent).join() === 'Admin,Admin,Admin,Agent,Team,Team,Team'));
  ok('You are marked (you)', await page.evaluate(() => /\(you\)/.test(document.querySelector('#people').textContent)));
  ok('Team-list entries without a login are listed', await page.evaluate(() => /admin@threepin\.in/.test(document.querySelector('.listonly').textContent)));
  ok('No sideways scroll on a phone', await noSideways(page));
  ok('Every tap target at least 40px tall', (await smallTargets(page)).length === 0, (await smallTargets(page)).join(' | '));
  ok('Team & access is in the admin’s menu', (await menu(page)).includes('Team & access'));
  await shot(page, `phone-people-${scheme}`);
  if (scheme === 'dark') { await page.context().close(); continue; }

  // Rameez's sheet: change the role
  await page.click('#people .row[data-uid="u_rameez"]');
  await page.waitForSelector('.sheet');
  ok('A person without a name is not shown twice in their sheet', await page.evaluate(() => document.querySelector('.sheet .sub').textContent === ''));
  ok('Tapping a person opens a bottom sheet with the three roles', (await page.$$('.sheet input[name=role]')).length === 3);
  ok('The sheet shows their current role', await page.evaluate(() => document.querySelector('.sheet input[name=role]:checked').value === 'agent'));
  await shot(page, 'phone-person-sheet', false);
  ok('Sheet tap targets at least 40px', (await smallTargets(page)).length === 0, (await smallTargets(page)).join(' | '));
  await page.click('.sheet input[value=none]');
  await page.click('#pSave');
  await page.waitForSelector('.toast');
  ok('Saving changes the role on the server', page.server.state.users.find(u => u.uid === 'u_rameez').role === 'none');
  await page.waitForTimeout(400);
  ok('The list shows the new role', await page.evaluate(() => /Team/.test(document.querySelector('#people .row[data-uid="u_rameez"] .pill:last-child').textContent)));
  // put him back
  await page.click('#people .row[data-uid="u_rameez"]'); await page.waitForSelector('.sheet');
  await page.click('.sheet input[value=agent]'); await page.click('#pSave'); await page.waitForSelector('.toast'); await page.waitForTimeout(400);

  // Own row: locked
  await page.click('#people .row[data-uid="u_swami"]');
  await page.waitForSelector('.sheet');
  ok('Your own row: role and sign-in locked, with the reason', await page.evaluate(() =>
    [...document.querySelectorAll('.sheet input[name=role]')].every(i => i.disabled) && document.querySelector('#pActive').disabled && /can’t change your own role/.test(document.querySelector('.sheet').textContent)));
  await shot(page, 'phone-self-sheet', false);
  await page.click('.sheet [data-close]');
  ok('Cancel closes the sheet', !(await page.$('.sheet')));

  // Last admin guard: demote Thirumal and Pradeep, then Swami would be alone — the server refuses
  // nothing until only one admin is left; try disabling the last other admin path via the API.
  // Add a person: a bad email, another business, then a real one
  await page.click('#addBtn'); await page.waitForSelector('.sheet');
  ok('Add a person: the email field has focus (keyboard opens)', await page.evaluate(() => document.activeElement && document.activeElement.id === 'nEmail'));
  ok('Add a person: Agent is preselected', await page.evaluate(() => document.querySelector('.sheet input[name=nrole]:checked').value === 'agent'));
  await page.click('#nSave'); await page.waitForTimeout(300);
  ok('An empty email is refused with a message', /Enter an email/.test(await page.textContent('#nErr')));
  await page.fill('#nEmail', 'x@otherbusiness.in'); await page.click('#nSave'); await page.waitForTimeout(300);
  ok('Another business’s email is refused with a message', /another business/.test(await page.textContent('#nErr')));
  await shot(page, 'phone-add-error', false);
  await page.fill('#nEmail', 'Kavya@threepin.in'); await page.click('#nSave');
  await page.waitForSelector('.pw');
  ok('A new login shows its one-time password', (await page.textContent('.pw')) === 'Qx7-pR2mZ9kL');
  await shot(page, 'phone-add-password', false);
  await page.click('.sheet [data-close]');
  ok('The new person is in the list', await page.evaluate(() => /kavya@threepin\.in/.test(document.querySelector('#people').textContent)));

  // ── Agent settings ──
  await page.click('.seg button[data-tab=agents]');
  await page.waitForSelector('#settings .sec');
  ok('Agent settings: the brief’s tabs are ticked', await page.evaluate(() =>
    [...document.querySelectorAll('input[data-key=tabs]:checked')].map(i => i.value).join() === 'properties,crm,tasks,ads,campaigns'));
  ok('Tabs not built for agents are greyed and say “coming”', await page.evaluate(() => {
    const fin = document.querySelector('input[data-key=tabs][value=finance]'); return fin.disabled && /coming/.test(fin.closest('label').textContent); }));
  ok('Other properties: title, config, budget', await page.evaluate(() =>
    [...document.querySelectorAll('input[data-key=otherPropertyFields]:checked')].map(i => i.value).join() === 'title,config,budget'));
  ok('Risky fields are flagged (owner phone, address)', await page.evaluate(() => /owner phone/.test(document.querySelector('#settings').textContent) && /reveals the address/.test(document.querySelector('#settings').textContent)));
  ok('No save bar until something changes', await page.evaluate(() => document.getElementById('savebar').hidden));
  ok('The long field lists start folded, so the page is short on a phone', await page.evaluate(() => document.documentElement.scrollHeight < 2400), await page.evaluate(() => document.documentElement.scrollHeight));
  ok('Each folded group says what it holds', await page.evaluate(() => document.querySelector('[data-sum=otherPropertyFields]').textContent === 'Title, Configuration, Budget / price'
    && document.querySelector('[data-sum=ownPropertyFields]').textContent === 'Everything'), await page.evaluate(() => document.querySelector('[data-sum=otherPropertyFields]').textContent));
  ok('No sideways scroll on a phone (settings)', await noSideways(page));
  ok('Settings tap targets at least 40px', (await smallTargets(page)).length === 0, (await smallTargets(page)).join(' | '));
  await shot(page, 'phone-settings');
  await page.click('details[data-fold=otherPropertyFields] > summary');
  await page.click('input[data-key=otherPropertyFields][value=area]');
  ok('Ticking updates the group’s summary', /and 2 more|Area/.test(await page.textContent('[data-sum=otherPropertyFields]')), await page.textContent('[data-sum=otherPropertyFields]'));
  ok('A change shows the save bar', await page.evaluate(() => !document.getElementById('savebar').hidden && !document.getElementById('saveBtn').disabled));
  await shot(page, 'phone-settings-dirty', false);
  await page.click('#saveBtn'); await page.waitForSelector('.toast');
  const saved = await page.evaluate(() => window.__fs['agentConfigs/t_3pinrealty']);
  ok('Saved to agentConfigs with the new field', saved && saved.otherPropertyFields.join() === 'title,config,budget,area', JSON.stringify(saved && saved.otherPropertyFields));
  ok('Saved with who and when', saved && saved.updatedBy === 'swami@threepin.in' && saved.updatedAt > 0);
  ok('The save bar goes away after saving', await page.evaluate(() => document.getElementById('savebar').hidden));

  // Per agent
  await page.selectOption('#forWho', 'rameez@threepin.in');
  ok('Picking an agent says they use the shared settings', /Using the shared settings/.test(await page.textContent('#forState')));
  await page.click('input[data-key=tabs][value=campaigns]');
  await page.click('#saveBtn'); await page.waitForSelector('.toast'); await page.waitForTimeout(300);
  const saved2 = await page.evaluate(() => window.__fs['agentConfigs/t_3pinrealty']);
  ok('Only what differs is stored for Rameez', JSON.stringify(saved2.overrides) === JSON.stringify({ 'rameez@threepin.in': { tabs: ['properties', 'crm', 'tasks', 'ads'] } }), JSON.stringify(saved2.overrides));
  ok('The shared settings are untouched by his change', saved2.tabs.join() === 'properties,crm,tasks,ads,campaigns');
  ok('He now shows as having his own settings, with a way back', /Own settings/.test(await page.textContent('#forState')) && !(await page.$eval('#resetBtn', b => b.hidden)));
  await shot(page, 'phone-settings-agent');
  await page.click('#resetBtn'); await page.waitForSelector('.toast'); await page.waitForTimeout(300);
  ok('“Use shared settings” removes his override', await page.evaluate(() => Object.keys(window.__fs['agentConfigs/t_3pinrealty'].overrides).length === 0));
  await page.context().close();
}

// ═══════ SWAMI — desktop ═══════
console.log('\nSwami (admin) — desktop');
{
  const page = await open('swami', DESK, '/team.html');
  await page.waitForSelector('#people .row'); await page.waitForTimeout(300);
  ok('Desktop: the menu rail is shown', await page.evaluate(() => document.body.classList.contains('rail-on')));
  await shot(page, 'desk-people', false);
  await page.click('.seg button[data-tab=agents]'); await page.waitForSelector('#settings .sec');
  await page.click('details[data-fold=matchingLeadFields] > summary');
  await page.click('input[data-key=matchingLeadFields][value=phone]');
  await page.click('details[data-fold=grantedPropertyFields] > summary');
  await page.click('[data-none=grantedPropertyFields]');
  ok('Clear unticks a whole group and says so', (await page.textContent('[data-sum=grantedPropertyFields]')) === 'Nothing');
  await page.click('[data-all=grantedPropertyFields]');
  ok('Tick all ticks a whole group and says so', (await page.textContent('[data-sum=grantedPropertyFields]')) === 'Everything');
  await shot(page, 'desk-settings', false);
  ok('Desktop: the save bar sits beside the menu, not under it', await page.evaluate(() => document.getElementById('savebar').getBoundingClientRect().left >= document.getElementById('appRail').getBoundingClientRect().right - 1));
  await page.click('#people') .catch(() => {});
  await page.context().close();
}

// ═══════ RAJESH — on the team, no role ═══════
console.log('\nRajesh (team, no role)');
{
  const page = await open('rajesh', PHONE, '/team.html');
  await page.waitForSelector('#denied:not([hidden])', { timeout: 15000 });
  ok('Team & access says “Admins only” with a way back', /Admins only/.test(await page.textContent('#denied')));
  ok('No people or settings were fetched', !page.server.state.calls.some(c => c.action === 'team'));
  await shot(page, 'phone-rajesh-denied', false);
  await page.context().close();
  const crm = await open('rajesh', DESK, '/crm.html?nav=tasks');
  await crm.waitForFunction(() => window.__ready === true && document.querySelector('#appRail .rl-nm'), null, { timeout: 20000 });
  await crm.waitForTimeout(600);
  const m = await menu(crm);
  ok('His menu is as before (Finance, Shoot & Media there), without Team & access', m.includes('Finance') && m.includes('Shoot & Media') && !m.includes('Team & access'), m.join(', '));
  await crm.context().close();
}

// ═══════ RAMEEZ — agent ═══════
console.log('\nRameez (agent)');
{
  const page = await open('rameez', DESK, '/crm.html?nav=tasks', { config: () => null });
  await page.waitForFunction(() => window.__ready === true && window.PinAccess, null, { timeout: 20000 });
  await page.waitForTimeout(600);
  const m = await menu(page);
  ok('His menu: only his tabs — no Finance, Shoot & Media, Team & access, Create brochure', !m.includes('Finance') && !m.includes('Shoot & Media') && !m.includes('Team & access') && !m.includes('Create brochure'), m.join(', '));
  ok('His menu has Properties, CRM, Tasks, Campaigns and Meta Ads', ['Properties', 'CRM', 'Tasks', 'WhatsApp Campaigns', 'Meta Ads Leads'].every(x => m.includes(x)), m.join(', '));
  ok('Setup screens are hidden from him (Missing data, Sync, Setup, Analytics, Templates)', !['Missing data', 'Sync from sheet', 'Setup', 'Analytics', 'Templates', 'New campaign'].some(x => m.includes(x)), m.join(', '));
  ok('Team calendar is not in his menu (not built for agents yet)', !m.includes('Team calendar'));
  await shot(page, 'desk-rameez-crm', false);
  await page.context().close();

  // A narrower set from the admin: only Properties
  const p2 = await open('rameez', DESK, '/crm.html?nav=tasks', { config: () => ({ tabs: ['properties'] }) });
  await p2.waitForFunction(() => /isn’t part of your access/.test(document.body.textContent), null, { timeout: 20000 }).catch(() => {});
  ok('A page none of his tabs open is closed with a plain note', /isn’t part of your access/.test(await p2.textContent('body')));
  ok('…and offers the pages he does have', await p2.evaluate(() => [...document.querySelectorAll('main a')].map(a => a.textContent).join() === 'Open Properties'));
  ok('…and a way to sign out', await p2.evaluate(() => !!document.getElementById('pinGateOut')));
  ok('…centred on the screen (no room left for a missing menu)', await p2.evaluate(() => { const r = document.querySelector('main').getBoundingClientRect(); return Math.abs((r.left + r.right) / 2 - innerWidth / 2) < 4; }));
  await shot(p2, 'desk-rameez-closed', false);
  await p2.context().close();

  const p3 = await open('rameez', PHONE, '/team.html', { config: () => null });
  await p3.waitForSelector('main h1', { timeout: 20000 });
  ok('Team & access is closed to him too', /isn’t part of your access|Admins only/.test(await p3.textContent('body')));
  await shot(p3, 'phone-rameez-team', false);
  await p3.context().close();
}

await browser.close();
console.log(errors.length ? `\n${errors.length} problem(s):\n  - ` + errors.join('\n  - ') : '\nAll good. Screenshots in ' + OUT);
process.exit(errors.length ? 1 : 0);
