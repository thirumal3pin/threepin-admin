// ═══════ TASKS — the page, the form, Daily task, and who sees what ═══════
//
// The real crm.html with its Firebase module swapped for an in-memory stand-in that behaves like
// the Firestore rules: a manager gets every task, anyone else only the tasks whose visibleTo carries
// their key; a person on a task may write only the fields the rules allow (the stand-in refuses the
// rest, as the rules would). Three people are played: Thirumal (assigns), Rajesh (has the tasks),
// Pradeep (allowed to see Rajesh's).
//   node tests/tasks-preview.mjs [out-dir]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || 'tests/out/tasks';
mkdirSync(OUT, { recursive: true });
const T = 't_3pinrealty';
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};
const istDay = off => new Date(Date.now() + off * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const CFG = { tenantId: T, managers: ['thirumal@threepin.in', 'swami@threepin.in'], viewers: { 'pradeep@threepin.in': ['rajesh@threepin.in'] } };
const k = e => T + '|' + e;
const TASKS = [
  { id: 'tsk_late', tenantId: T, title: 'Collect the EC for ANR003 from the owner', description: 'Owner said Friday.\nSecond line.', status: 'doing', due: istDay(-2),
    primary: 'rajesh@threepin.in', secondary: [], assignees: ['rajesh@threepin.in'], visibleTo: [k('pradeep@threepin.in'), k('rajesh@threepin.in')],
    createdBy: 'thirumal@threepin.in', createdAt: Date.now() - 5 * 86400000, history: [{ at: Date.now() - 5 * 86400000, by: 'thirumal@threepin.in', text: 'assigned it to Rajesh' }] },
  { id: 'tsk_today', tenantId: T, title: 'Shoot plan for the Adyar villa', status: 'todo', due: istDay(0),
    primary: 'rajesh@threepin.in', secondary: ['dev@threepin.in'], assignees: ['rajesh@threepin.in', 'dev@threepin.in'],
    visibleTo: [k('dev@threepin.in'), k('pradeep@threepin.in'), k('rajesh@threepin.in')], createdBy: 'swami@threepin.in', createdAt: Date.now() - 86400000,
    link: { kind: 'lead', id: 'L1', label: 'Rajesh Kumar' } },
  { id: 'tsk_dev', tenantId: T, title: 'A very long task title, unbroken word to check a phone row: ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', status: 'todo', due: '',
    primary: 'dev@threepin.in', secondary: [], assignees: ['dev@threepin.in'], visibleTo: [k('dev@threepin.in')], createdBy: 'thirumal@threepin.in', createdAt: Date.now() },
  { id: 'tsk_tomorrow', tenantId: T, title: 'Send the brochure to the Nungambakkam buyer', status: 'todo', due: istDay(1),
    primary: 'rajesh@threepin.in', secondary: [], assignees: ['rajesh@threepin.in'], visibleTo: [k('pradeep@threepin.in'), k('rajesh@threepin.in')], createdBy: 'swami@threepin.in', createdAt: Date.now() },
  { id: 'tsk_done', tenantId: T, title: 'Upload the Kodambakkam photos', status: 'done', due: istDay(-1), completedAt: Date.now() - 3600000,
    primary: 'rajesh@threepin.in', secondary: [], assignees: ['rajesh@threepin.in'], visibleTo: [k('pradeep@threepin.in'), k('rajesh@threepin.in')], createdBy: 'thirumal@threepin.in', createdAt: Date.now() - 9 * 86400000 },
];
const LEADS = [{ id: 'L1', tenantId: T, name: 'Rajesh Kumar', phone: '98400 12345', enquiryType: 'Property Enquiry', stageId: 'new', createdAt: Date.now() - 86400000, updatedAt: Date.now() }];

// The stand-in: crmFirebase (no-ops), crmAuth, and crmTasks over an in-memory store that answers
// like the rules — what the signed-in person may read, and only the writes they may make.
const stub = (who) => `
const ME = ${JSON.stringify(who)}, CFG = ${JSON.stringify(CFG)}, TEN = '${T}';
const store = new Map(${JSON.stringify([...TASKS, { ...TASKS[1], id: 'tsk_new', title: 'Just assigned' }].map(t => [t.id, t]))});
window.__writes = []; window.__notified = [];
if (!/task=tsk_new/.test(location.search)) store.delete('tsk_new');   // only the email-link check has it
const isMgr = CFG.managers.includes(ME);
const ALLOWED = ['title','description','status','due','link','updatedAt','updatedBy','statusAt','completedAt','history','tenantId'];
function push(fromCache){ window.applyTasksSnapshot([...store.values()].filter(t => isMgr || (t.visibleTo || []).includes(TEN + '|' + ME)).map(t => JSON.parse(JSON.stringify(t))), isMgr ? 'all' : 'mine', null, !!fromCache); }
// An email link opened on a device whose saved copy predates the task: the copy (without it) first.
if (/task=tsk_new/.test(location.search)) { const held = store.get('tsk_new'); store.delete('tsk_new'); push(true); store.set('tsk_new', held); setTimeout(() => push(false), 300); }
window.crmFirebase = { saveLead: async()=>{}, deleteLead: async()=>{}, getLeadNotes: async()=>[], getLeadHistory: async()=>[], saveNote: async()=>{},
  deleteNoteDoc: async()=>{}, saveHistory: async()=>{}, savePipeline: async()=>{}, getBotConfig: async()=>null, saveBotConfig: async()=>{},
  saveEnquiryTypes: async()=>{}, saveProperties: async()=>{}, saveFollowupDigestSettings: async()=>{}, saveDashboardEmailSettings: async()=>{},
  releaseLeadField: async()=>{}, getLeadTailorTalk: async()=>null, updateLeadAi: async()=>{}, saveAutomationSettings: async()=>{}, saveTeam: async()=>{},
  getInventory: async()=>[{ id: 'ANR003', propertyCode: 'ANR003', name: '3BHK Anna Nagar', location: 'Anna Nagar' }], watchTrackTasks: ()=>{} };
window.crmAuth = { login: async()=>{}, logout: async()=>{}, getIdToken: async()=>'x', getTenantId: ()=>TEN };
window.crmTasks = {
  create: async (t) => { if (!isMgr) { const e = new Error('denied'); e.code = 'permission-denied'; throw e; } window.__writes.push({ op: 'create', t }); store.set(t.id, { ...t, tenantId: TEN }); setTimeout(push, 0); },
  update: async (id, patch) => {
    const cur = store.get(id); const mine = cur && (cur.assignees || []).includes(ME);
    if (!isMgr && !(mine && Object.keys(patch).every(k => ALLOWED.includes(k)))) { const e = new Error('denied'); e.code = 'permission-denied'; throw e; }
    window.__writes.push({ op: 'update', id, patch }); store.set(id, { ...cur, ...patch }); setTimeout(push, 0);
  },
  remove: async (id) => { window.__writes.push({ op: 'remove', id }); store.delete(id); setTimeout(push, 0); },
  notify: async (id, event, extra) => { window.__notified.push({ id, event, ...(extra || {}) }); return { ok: true, sent: (extra && extra.added ? extra.added.length : 2) }; },
  config: () => CFG, tenantId: () => TEN
};
window.__bump = (id, patch) => { store.set(id, { ...store.get(id), ...patch }); push(); };
window.onCrmAuthChange({ email: ME });
if(window.applyPipelineSnapshot) window.applyPipelineSnapshot([{ id: 'new', name: 'New' }, { id: 'won', name: 'Booked' }]);
if(window.applyTeamSnapshot) window.applyTeamSnapshot({ a: { email: 'thirumal@threepin.in' }, b: { email: 'swami@threepin.in' }, c: { email: 'rajesh@threepin.in' },
  d: { email: 'pradeep@threepin.in' }, e: { email: 'dev@threepin.in' } });
window.applyLeadsSnapshot(${JSON.stringify(LEADS)});
window.applyTaskConfig(CFG);
push();
window.__ready = true;
`;

const FIREBASE_STUB = `
const obj = () => ({}), arr = () => [], off = () => () => {};
export const initializeApp = obj, getApps = arr, getFirestore = obj, collection = obj, doc = obj, setDoc = async()=>{}, onSnapshot = off;
export const getDoc = obj, getDocs = obj, writeBatch = obj, query = obj, where = obj, updateDoc = async()=>{}, deleteDoc = async()=>{}, deleteField = obj;
export const initializeFirestore = obj, persistentLocalCache = obj, persistentMultipleTabManager = obj, terminate = async()=>{}, clearIndexedDbPersistence = async()=>{}, waitForPendingWrites = async()=>{};
export const getAuth = obj, signInWithEmailAndPassword = async()=>{}, signOut = async()=>{}, onAuthStateChanged = (a, cb) => { setTimeout(() => cb(null), 0); return () => {}; };
`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff2': 'font/woff2' };

const browser = await chromium.launch();
async function open(who, viewport, path, scheme) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: scheme || 'light' });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('  PAGEERROR ' + e.message); errors.push('pageerror: ' + e.message); });
  page.on('dialog', d => d.accept());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.gstatic.com' && /firebasejs/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: FIREBASE_STUB });
    if (/^(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) return route.continue();
    if (url.hostname !== 'app.local') return route.abort();
    if (url.pathname === '/crm-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: stub(who) });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://app.local' + (path || '/crm.html?nav=tasks'));
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.waitForTimeout(600);
  return page;
}
const rows = page => page.evaluate(() => [...document.querySelectorAll('#tasksView .tsk-row')].map(r => ({ title: r.querySelector('.tsk-t').textContent, select: !!r.querySelector('select.tsk-st') })));
const noSideways = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const DESK = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };

// ── Thirumal: assigns, sees everything ──
console.log('\nThirumal (manager) — desktop');
{
  const page = await open('thirumal@threepin.in', DESK);
  ok('The Tasks page opens from ?nav=tasks', await page.evaluate(() => document.getElementById('tasksView').style.display !== 'none'));
  ok('Tasks is in the menu', await page.evaluate(() => [...document.querySelectorAll('#appRail .rl-nm')].some(n => n.textContent === 'Tasks')));
  const r = await rows(page);
  ok('A manager sees every open task (4), the completed one hidden by "Open"', r.length === 4, JSON.stringify(r.map(x => x.title.slice(0, 20))));
  ok('Late first, then due today, then tomorrow, then undated', /EC for ANR003/.test(r[0].title) && /Adyar villa/.test(r[1].title) && /Nungambakkam/.test(r[2].title) && /very long/.test(r[3].title));
  ok('The overdue count says 1', await page.evaluate(() => document.querySelector('.tsk-stat.k-overdue b').textContent === '1'));
  ok('Assign task and Who sees what are offered', await page.evaluate(() => !!document.querySelector('.tsk-btn.primary') && /Who sees what/.test(document.querySelector('.tsk-hacts').textContent)));
  await page.screenshot({ path: join(OUT, 'desk-manager-list.png') });

  // Assign a new task: Pradeep primary, Dev secondary, linked to a property.
  await page.click('.tsk-btn.primary');
  await page.waitForSelector('#taskModal.open');
  await page.click('#tkmFtr .modal-save');
  ok('Saving an empty form names what is missing', /title/.test(await page.textContent('#tkmErr')) && /who the task is for/.test(await page.textContent('#tkmErr')));
  await page.fill('#tkmT', 'Call the owner of ANR003 about the EC');
  await page.fill('#tkmD', 'Ask for the encumbrance certificate.');
  await page.selectOption('#tkmP', 'rajesh@threepin.in');
  await page.click('.tsk-chip:has-text("Dev")');
  await page.fill('#tkmDue', istDay(3));
  await page.dispatchEvent('#tkmDue', 'change');
  await page.click('.tsk-seg-b:has-text("A property")');
  await page.fill('#tkmLinkQ', 'anr');
  await page.waitForSelector('.tsk-res');
  await page.click('.tsk-res');
  await page.screenshot({ path: join(OUT, 'desk-manager-form.png') });
  await page.click('#tkmFtr .modal-save');
  await page.waitForTimeout(400);
  const w = await page.evaluate(() => ({ writes: window.__writes, notified: window.__notified }));
  const c = w.writes.find(x => x.op === 'create');
  ok('The task is written with its people, visibility and link', c && c.t.primary === 'rajesh@threepin.in' && c.t.secondary.join() === 'dev@threepin.in'
    && c.t.assignees.join() === 'rajesh@threepin.in,dev@threepin.in'
    && c.t.visibleTo.join() === [k('dev@threepin.in'), k('pradeep@threepin.in'), k('rajesh@threepin.in')].join()
    && c.t.link && c.t.link.kind === 'property' && c.t.link.id === 'ANR003' && c.t.due === istDay(3) && c.t.status === 'todo', JSON.stringify(c && c.t));
  ok('…and both people are emailed', w.notified.length === 1 && w.notified[0].event === 'assigned' && w.notified[0].added.join() === 'rajesh@threepin.in,dev@threepin.in', JSON.stringify(w.notified));
  ok('The new task shows in the list', (await rows(page)).some(x => /about the EC/.test(x.title)));

  // Reassign: a manager moves a task to someone else — only the new person is emailed.
  await page.evaluate(() => PinTasks.open('tsk_dev'));
  await page.waitForSelector('#taskModal.open');
  await page.selectOption('#tkmP', 'pradeep@threepin.in');
  await page.click('#tkmFtr .modal-save');
  await page.waitForTimeout(400);
  const n2 = await page.evaluate(() => window.__notified.slice(-1)[0]);
  ok('Reassigning emails the person now on it', n2 && n2.event === 'assigned' && n2.added.join() === 'pradeep@threepin.in', JSON.stringify(n2));
  const u2 = await page.evaluate(() => window.__writes.filter(x => x.op === 'update').slice(-1)[0]);
  ok('…and re-stamps who can see it', u2 && u2.patch.assignees.join() === 'pradeep@threepin.in' && u2.patch.visibleTo.join() === k('pradeep@threepin.in'), JSON.stringify(u2 && u2.patch));

  // Someone else changes the status while the manager has the form open: the manager's save of the
  // title must not put the old status back.
  await page.evaluate(() => PinTasks.open('tsk_today'));
  await page.waitForSelector('#taskModal.open');
  await page.evaluate(() => { const s = window.__store || null; });
  await page.evaluate(() => window.__bump && window.__bump('tsk_today', { status: 'done', statusAt: Date.now() }));
  await page.fill('#tkmT', 'Shoot plan for the Adyar villa — Saturday');
  await page.dispatchEvent('#tkmT', 'input');
  await page.click('#tkmFtr .modal-save');
  await page.waitForTimeout(400);
  const cu = await page.evaluate(() => window.__writes.filter(x => x.op === 'update' && x.id === 'tsk_today').slice(-1)[0]);
  ok('A save writes only what this person changed (another\u2019s status change stays)', cu && cu.patch.title === 'Shoot plan for the Adyar villa — Saturday' && !('status' in cu.patch), JSON.stringify(cu && cu.patch));
  ok('…so the task is still Completed', await page.evaluate(() => (PinTasks.tasks().find(t => t.id === 'tsk_today') || {}).status === 'done'));

  // Filters
  await page.selectOption('#tasksView .tsk-f select >> nth=0', 'rajesh@threepin.in');
  ok('The person filter shows only Rajesh’s', (await rows(page)).every(x => !/very long/.test(x.title)));
  await page.click('.tsk-stat.k-overdue');
  ok('The Overdue tile filters to the late one', (await rows(page)).length === 1);
  await page.evaluate(() => { PinTasks.filter('who', 'all'); PinTasks.quick('overdue'); });
  await page.context().close();
}

// ── Rajesh: has tasks; may change them, not reassign them ──
console.log('\nRajesh (assignee) — desktop');
{
  const page = await open('rajesh@threepin.in', DESK);
  const r = await rows(page);
  ok('He sees his own open tasks only', r.length === 3 && r.every(x => !/very long/.test(x.title)), JSON.stringify(r.map(x => x.title.slice(0, 20))));
  ok('No Assign task for him', await page.evaluate(() => !document.querySelector('.tsk-btn.primary')));
  ok('The menu badge counts his late and due-today tasks (2)', await page.evaluate(() => {
    const it = [...document.querySelectorAll('#appRail .rl-h, #appRail .rl-item')].find(x => /Tasks/.test(x.textContent));
    return it && /2/.test((it.querySelector('.rl-badge') || {}).textContent || '');
  }));
  // Status straight from the row
  await page.selectOption('#tasksView .tsk-row:has-text("Adyar villa") select.tsk-st', 'doing');
  await page.waitForTimeout(400);
  const w = await page.evaluate(() => ({ writes: window.__writes, notified: window.__notified }));
  const u = w.writes.find(x => x.op === 'update');
  ok('Changing the status writes only what he may change', u && u.patch.status === 'doing' && !('primary' in u.patch) && !('assignees' in u.patch) && !('visibleTo' in u.patch), JSON.stringify(u && u.patch));
  ok('…and the status email goes out', w.notified.some(x => x.event === 'status' && x.from === 'todo'), JSON.stringify(w.notified));
  // The form: everything editable but the people
  await page.evaluate(() => PinTasks.open('tsk_late'));
  await page.waitForSelector('#taskModal.open');
  const f = await page.evaluate(() => ({ title: !document.getElementById('tkmT').disabled, primary: document.getElementById('tkmP').disabled,
    chips: [...document.querySelectorAll('.tsk-chip')].every(c => c.disabled), del: !!document.querySelector('.tsk-del'), note: (document.querySelector('.tsk-ro') || {}).textContent || '' }));
  ok('He may edit the title but not who it is assigned to, and cannot delete', f.title && f.primary && f.chips && !f.del && /assigned to is set by/.test(f.note), JSON.stringify(f));
  await page.fill('#tkmD', 'Owner said Friday. Called again today.');
  await page.click('.tsk-seg-b.s-done');
  await page.click('#tkmFtr .modal-save');
  await page.waitForTimeout(400);
  const u2 = await page.evaluate(() => window.__writes.filter(x => x.op === 'update').slice(-1)[0]);
  ok('Completing it from the form saves, with a history line', u2 && u2.patch.status === 'done' && u2.patch.completedAt > 0 && /Completed/.test(u2.patch.history.slice(-1)[0].text), JSON.stringify(u2 && u2.patch));
  await page.screenshot({ path: join(OUT, 'desk-assignee-list.png') });
  await page.evaluate(() => PinTasks.filter('status', 'all'));
  const done = await page.evaluate(() => { const r = [...document.querySelectorAll('#tasksView .tsk-row.s-done select.tsk-st')][0]; return r ? { text: r.options[r.selectedIndex].text, color: getComputedStyle(r).color } : null; });
  ok('A completed task shows a green ✓ Completed', done && done.text === '✓ Completed' && /rgb\(21, 128, 61\)/.test(done.color), JSON.stringify(done));
  await page.screenshot({ path: join(OUT, 'desk-assignee-all.png') });
  await page.evaluate(() => PinTasks.filter('status', 'open'));

  // Daily task
  await page.evaluate(() => toggleView('today'));
  await page.waitForTimeout(300);
  const d = await page.evaluate(() => {
    const sec = [...document.querySelectorAll('#todayView .td-sec')].find(s => /Tasks for you/.test(s.textContent));
    return sec ? { rows: [...sec.querySelectorAll('.tsk-t')].map(x => x.textContent), select: !!sec.querySelector('select.tsk-st') } : null;
  });
  ok('Daily task lists his open tasks due today (not tomorrow\u2019s), with the status to change', d && d.rows.length === 1 && /Adyar villa/.test(d.rows[0]) && d.select, JSON.stringify(d));
  await page.evaluate(() => PinToday.setSpan('week'));
  await page.waitForTimeout(200);
  const wk = await page.evaluate(() => { const sec = [...document.querySelectorAll('#todayView .td-sec')].find(s => /Tasks for you/.test(s.textContent)); return [...sec.querySelectorAll('.tsk-t')].length; });
  ok('…and This week adds tomorrow\u2019s', wk === 2, wk);
  await page.evaluate(() => PinToday.setSpan('day'));
  await page.screenshot({ path: join(OUT, 'desk-daily-task.png'), fullPage: true });
  await page.context().close();
}

// ── Pradeep: allowed to see Rajesh's tasks, to read ──
console.log('\nPradeep (viewer) — desktop');
{
  const page = await open('pradeep@threepin.in', DESK);
  const r = await rows(page);
  ok('He sees Rajesh’s tasks (given to him to see)', r.length === 3, JSON.stringify(r.map(x => x.title.slice(0, 20))));
  ok('…as status labels, not controls', r.every(x => !x.select));
  await page.evaluate(() => PinTasks.open('tsk_late'));
  await page.waitForSelector('#taskModal.open');
  const f = await page.evaluate(() => ({ save: !!document.querySelector('#tkmFtr .modal-save'), title: document.getElementById('tkmT').disabled, note: (document.querySelector('.tsk-ro') || {}).textContent || '' }));
  ok('The form is read only for him', !f.save && f.title && /You can see this task/.test(f.note), JSON.stringify(f));
  await page.context().close();
}

// ── An email link: ?nav=tasks&task=ID opens that task ──
console.log('\nEmail link');
{
  const page = await open('rajesh@threepin.in', DESK, '/crm.html?nav=tasks&task=tsk_today');
  ok('The task from the email opens', await page.evaluate(() => document.getElementById('taskModal') && document.getElementById('taskModal').classList.contains('open')
    && document.getElementById('tkmT').value === 'Shoot plan for the Adyar villa'));
  ok('…and the link is cleaned out of the address', await page.evaluate(() => !/task=/.test(location.search)));
  await page.context().close();
  const p3 = await open('rajesh@threepin.in', DESK, '/crm.html?nav=tasks&task=tsk_new');
  await p3.waitForTimeout(500);
  ok('A link to a task the device\u2019s saved copy does not have yet still opens, once the server answers', await p3.evaluate(() => document.getElementById('taskModal') && document.getElementById('taskModal').classList.contains('open')
    && document.getElementById('tkmT').value === 'Just assigned'));
  await p3.context().close();
  const p2 = await open('rajesh@threepin.in', DESK, '/crm.html?nav=tasks&task=tsk_dev');
  ok('A task he cannot see does not open (it is not his)', await p2.evaluate(() => !(document.getElementById('taskModal') || { classList: { contains: () => false } }).classList.contains('open')));
  await p2.context().close();
}

// ── Phone ──
console.log('\nPhone');
for (const [who, name] of [['thirumal@threepin.in', 'manager'], ['rajesh@threepin.in', 'assignee']]) {
  for (const scheme of ['light', 'dark']) {
    const page = await open(who, PHONE, undefined, scheme);
    ok(`${name}, ${scheme}: no sideways scroll on the Tasks page`, await noSideways(page));
    await page.screenshot({ path: join(OUT, `phone-${name}-${scheme}.png`), fullPage: true });
    if (name === 'manager' && scheme === 'light') {
      await page.click('.tsk-btn.primary');
      await page.waitForSelector('#taskModal.open');
      ok('manager: the form fits a phone', await noSideways(page));
      await page.screenshot({ path: join(OUT, 'phone-form.png') });
      await page.evaluate(() => PinTasks.close());
    }
    if (name === 'assignee' && scheme === 'light') {
      await page.evaluate(() => toggleView('today'));
      await page.waitForTimeout(300);
      ok('assignee: Daily task fits a phone', await noSideways(page));
      await page.screenshot({ path: join(OUT, 'phone-daily-task.png'), fullPage: true });
    }
    await page.context().close();
  }
}

// ── Settings → Configurations → Tasks (Shoot & Media's settings page) ──
console.log('\nSettings → Configurations → Tasks');
const TRACK_STUB = (who) => `
window.__cfgSaves = [];
window.trackFirebase = { saveListing: async () => {}, deleteListing: async () => {}, savePipeline: async () => {}, patchLead: async () => {},
  getLeadConversation: async () => null, getInventory: async () => [], getListingHistory: async () => [], saveHistory: async () => {}, deleteHistory: async () => {},
  saveTrackConfig: async () => {},
  saveTaskConfig: async (cfg) => { window.__cfgSaves.push(JSON.parse(JSON.stringify(cfg))); return { tasksUpdated: 3 }; } };
window.trackAuth = { login: async () => {}, logout: async () => {}, getTenantId: () => '${T}' };
setTimeout(() => {
  window.onTrackAuthChange({ email: ${JSON.stringify(who)} }, '${T}');
  window.applyTrackPipelineSnapshot([]);
  window.applyListingsSnapshot([]);
  window.applyTrackLeadsSnapshot([]);
  window.applyTrackTeamSnapshot({ a: { email: 'thirumal@threepin.in' }, b: { email: 'swami@threepin.in' }, c: { email: 'rajesh@threepin.in' }, d: { email: 'pradeep@threepin.in' }, e: { email: 'dev@threepin.in' } });
  window.applyTrackTaskConfig(${JSON.stringify(CFG)});
  window.__ready = true;
}, 0);
`;
async function openTrack(who, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('  PAGEERROR ' + e.message); errors.push('pageerror: ' + e.message); });
  page.on('dialog', d => d.accept());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.gstatic.com' && /firebasejs/.test(url.pathname)) return route.fulfill({ contentType: 'text/javascript', body: FIREBASE_STUB });
    if (/^(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) return route.continue();
    if (url.hostname !== 'app.local') return route.abort();
    if (url.pathname === '/track-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: TRACK_STUB(who) });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://app.local/propertytrack.html?nav=settings#cfTasks');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.waitForTimeout(600);
  return page;
}
{
  const page = await openTrack('thirumal@threepin.in', DESK);
  const s = await page.evaluate(() => {
    const el = document.getElementById('cfTasks');
    if (!el) return null;
    const on = [...el.querySelectorAll('.cf-pick.on')].map(b => b.textContent.replace('✓ ', '').trim());
    return { on, rows: [...el.querySelectorAll('.cf-vrow .cf-vwho b')].map(b => b.textContent), disabled: [...el.querySelectorAll('.cf-pick')].some(b => b.disabled),
      inView: el.getBoundingClientRect().top < innerHeight };
  });
  ok('The Tasks section is on Settings → Configurations, opened at it from the Tasks page link', s && s.inView, JSON.stringify(s));
  ok('It shows Thirumal and Swami assigning, and Pradeep seeing Rajesh', s && s.on.includes('Thirumal') && s.on.includes('Swami') && s.on.includes('Rajesh'), JSON.stringify(s && s.on));
  ok('One row per person who is not a manager', s && s.rows.join() === 'Dev,Pradeep,Rajesh', JSON.stringify(s && s.rows));
  ok('A manager can change it', s && !s.disabled);
  await page.screenshot({ path: join(OUT, 'desk-settings-tasks.png'), fullPage: false });
  // Let Dev see Pradeep's tasks
  await page.evaluate(() => { const row = [...document.querySelectorAll('#cfTasks .cf-vrow')].find(r => /Dev/.test(r.querySelector('.cf-vwho b').textContent));
    [...row.querySelectorAll('.cf-pick')].find(b => /Pradeep/.test(b.textContent)).click(); });
  await page.waitForTimeout(300);
  const saved = await page.evaluate(() => window.__cfgSaves.slice(-1)[0]);
  ok('Letting Dev see Pradeep’s tasks saves it (and keeps the rest)', saved && saved.viewers['dev@threepin.in'].join() === 'pradeep@threepin.in'
    && saved.viewers['pradeep@threepin.in'].join() === 'rajesh@threepin.in' && saved.managers.join() === 'thirumal@threepin.in,swami@threepin.in', JSON.stringify(saved));
  await page.context().close();
}
{
  const page = await openTrack('rajesh@threepin.in', PHONE);
  const s = await page.evaluate(() => ({ disabled: [...document.querySelectorAll('#cfTasks .cf-pick')].every(b => b.disabled), note: (document.querySelector('#cfTasks .cf-sh p') || {}).textContent || '' }));
  ok('Anyone else sees it, read only, and is told who can change it', s.disabled && /Only Thirumal and Swami can change this/.test(s.note), JSON.stringify(s));
  ok('It fits a phone', await noSideways(page));
  await page.screenshot({ path: join(OUT, 'phone-settings-tasks.png'), fullPage: false });
  await page.context().close();
}

await browser.close();
console.log(errors.length ? `\n${errors.length} check(s) failed.` : '\nAll checks passed.');
process.exit(errors.length ? 1 : 0);
