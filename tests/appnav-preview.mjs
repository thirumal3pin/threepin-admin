// ═══════ THE APP RAIL, ON ALL THREE CONSOLES ═══════
//
// One menu now serves Properties, the CRM and Finance, so the thing worth
// checking is that it behaves identically on each: the same sections, only
// one open at a time, the page you are on marked, and the whole thing out of
// the way on a phone until you ask for it.
//
// Each console is served from the repo with its Firebase module swapped for
// an in-memory stand-in, so there is no login and no network.
//
//   node tests/appnav-preview.mjs [out-dir]

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || 'tests/out/appnav';
mkdirSync(OUT, { recursive: true });
const T = 't_3pinrealty';
const NOW = Date.now();
const H = 3600000, D = 24 * H;

// Today at a fixed hour, so a visit "at 3 PM" is at 3 PM whenever this runs.
const at = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };

const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};

// ── Fixtures ──

const PROPS = [
  { id: 'TNAG003', propertyCode: 'TNAG003', tenantId: T, name: '3BHK - Thiruvanmiyur', location: 'Thiruvanmiyur',
    type: 'Apartment', config: '3BHK', status: 'Ready to Move', startingPrice: '2,10,00,000', zone: 'Chennai South' },
  { id: 'ANR003', propertyCode: 'ANR003', tenantId: T, name: '3BHK - Anna Nagar', location: 'Anna Nagar',
    type: 'Apartment', config: '3BHK', status: 'Under Construction', zone: 'Chennai West' },
];

const LEADS = [
  { id: 'L1', tenantId: T, name: 'Rajesh Kumar', phone: '98400 12345', enquiryType: 'Property Enquiry',
    propertyInterest: 'Thiruvanmiyur 3BHK', propertyCodes: ['TNAG003'], budget: '2.1 Cr',
    stageId: 'visit_pending', createdAt: NOW - 3 * D, updatedAt: NOW - H,
    ai: { at: NOW - H, line: 'Agreed to see TNAG003 today at 3 PM', visit: { status: 'scheduled', at: at(15), property: 'TNAG003' } } },
  { id: 'L2', tenantId: T, name: 'Meena R', phone: '98400 22222', enquiryType: 'Property Enquiry',
    propertyInterest: 'Anna Nagar 2BHK', budget: '1.2 Cr', stageId: 'negotiation',
    createdAt: NOW - 8 * D, updatedAt: NOW - 2 * D,
    followUpAt: at(10), followUpNote: 'Share the final price for ANR003' },
  { id: 'L3', tenantId: T, name: 'Arun Prakash', phone: '98400 33333', enquiryType: 'Property Enquiry',
    propertyInterest: 'Kilpauk villa', stageId: 'options', createdAt: NOW - 20 * D, updatedAt: NOW - 6 * D,
    followUpAt: NOW - 2 * D, followUpNote: 'Call back about the Kilpauk villa' },
  // The other side of L1's visit: an owner listing for the same property.
  { id: 'L4', tenantId: T, name: 'Mrs Lakshmi', phone: '98400 44444', enquiryType: 'Seller Listing',
    propertyInterest: 'Thiruvanmiyur 3BHK', propertyCodes: ['TNAG003'], stageId: 'options',
    createdAt: NOW - 40 * D, updatedAt: NOW - 10 * D },
  // Someone put my name in a note — this is the "task assigned to me" row.
  { id: 'L5', tenantId: T, name: 'Prakash Builders', phone: '98400 55555', enquiryType: 'Property Enquiry',
    propertyInterest: 'I Block 3BHK', stageId: 'options', createdAt: NOW - 5 * D, updatedAt: NOW - 3 * D,
    followUpAt: at(18),
    mentions: { agent_a_example_com: { email: 'agent.a@example.com', by: 'admin@example.com',
      at: NOW - 6 * H, noteId: 'n1', text: 'Complete the brochure of I Block 3 BHK', doneAt: null } } },
];

const STAGES = [
  { id: 'new', name: 'New' }, { id: 'options', name: 'Options sent' },
  { id: 'visit_pending', name: 'Visit planned' }, { id: 'negotiation', name: 'Negotiating' },
  { id: 'won', name: 'Booked' }, { id: 'lost', name: 'Not interested' },
];

const CRM_STUB = `
window.crmFirebase = { saveLead: async()=>{}, deleteLead: async()=>{}, getLeadNotes: async()=>[],
  getLeadHistory: async()=>[], saveNote: async()=>{}, deleteNoteDoc: async()=>{}, saveHistory: async()=>{},
  savePipeline: async()=>{}, getBotConfig: async()=>null, saveBotConfig: async()=>{}, saveEnquiryTypes: async()=>{},
  saveProperties: async()=>{}, saveFollowupDigestSettings: async()=>{}, saveDashboardEmailSettings: async()=>{},
  releaseLeadField: async()=>{}, getLeadTailorTalk: async()=>null, updateLeadAi: async()=>{},
  saveAutomationSettings: async()=>{}, saveTeam: async()=>{} };
window.crmAuth = { login: async()=>{}, logout: async()=>{}, getIdToken: async()=>'x', getTenantId: ()=>'${T}' };
window.onCrmAuthChange({ email: 'agent.a@example.com' });
if(window.applyPipelineSnapshot) window.applyPipelineSnapshot(${JSON.stringify(STAGES)});
if(window.applyTeamSnapshot) window.applyTeamSnapshot({
  agent_a: { email: 'agent.a@example.com' }, admin: { email: 'admin@example.com' } });
if(window.applyEnquiryTypesSnapshot) window.applyEnquiryTypesSnapshot(['Property Enquiry','Seller Listing','General']);
window.applyLeadsSnapshot(${JSON.stringify(LEADS)});
window.__ready = true;
`;

const DASH_STUB = `
window.dashboardFirebase = { saveProperty: async()=>{}, deleteProperty: async()=>{}, saveFavorites: async()=>{},
  saveChange: async()=>{}, getChanges: async()=>[], saveNaFields: async()=>{} };
window.dashboardAuth = { login: async()=>{}, logout: async()=>{}, getIdToken: async()=>'t', getTenantId: ()=>'${T}' };
if(window.onDashboardAuthChange) window.onDashboardAuthChange({ email:'agent.a@example.com' });
if(window.applyPropertiesSnapshot) window.applyPropertiesSnapshot(${JSON.stringify(PROPS)});
window.__ready = true;
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };

// Finance imports the Firebase SDK straight from gstatic. Nothing here talks
// to Firestore — the preview page builds its own books — but the import has to
// resolve or the whole module graph fails to load. One stub answers all four
// SDK modules; each only pulls the names it needs out of it.
const FIREBASE_STUB = `
const nul = () => null, obj = () => ({}), arr = () => [], off = () => () => {};
export const initializeApp = obj, getApps = arr;
export const getFirestore = obj, collection = obj, doc = obj, setDoc = async()=>{}, onSnapshot = off;
export const getDoc = obj, getDocs = obj, getDocFromServer = obj, getDocsFromServer = obj;
export const writeBatch = obj, runTransaction = async()=>{}, query = obj, where = obj, limit = obj;
export const orderBy = obj, serverTimestamp = obj, Timestamp = { fromMillis: obj }, getCountFromServer = obj;
export const getAuth = obj, signInWithEmailAndPassword = async()=>{}, signOut = async()=>{};
// Real Firebase never calls back synchronously, and finance-sync.js relies on
// that: its callback touches module state declared further down the file.
export const onAuthStateChanged = (a, cb) => { setTimeout(() => { try { cb(null); } catch (e) {} }, 0); return () => {}; };
export const getStorage = obj, ref = obj, uploadBytes = async()=>{}, getDownloadURL = async()=>'', deleteObject = async()=>{};
`;

const browser = await chromium.launch();

async function open(path, viewport, stubs) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log('  PAGEERROR ' + e.message); errors.push('pageerror: ' + e.message); });
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR|favicon/.test(m.text())) {
      console.log('  CONSOLE ' + m.text()); errors.push('console: ' + m.text());
    }
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.gstatic.com' && /firebasejs/.test(url.pathname)) {
      return route.fulfill({ contentType: 'text/javascript', body: FIREBASE_STUB });
    }
    // The icon font and the web fonts come from the network, because a
    // screenshot with neither of them is not a screenshot of this design.
    if (/^(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) return route.continue();
    if (url.hostname !== 'app.local') return route.abort();
    for (const [p, body] of Object.entries(stubs || {})) {
      if (url.pathname === p) return route.fulfill({ contentType: 'text/javascript', body });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://app.local' + path);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
  await page.waitForTimeout(500);
  return page;
}

// What the rail is showing: section labels, which one is open, which item is current.
const railState = page => page.evaluate(() => {
  const secs = [...document.querySelectorAll('#appRail .rl-sec')].map(s => ({
    name: (s.querySelector('.rl-nm') || {}).textContent || '',
    open: s.classList.contains('open'),
    here: s.classList.contains('here'),
    items: [...s.querySelectorAll('.rl-body .rl-item .rl-nm')].map(n => n.textContent),
    groups: [...s.querySelectorAll('.rl-grp-h .rl-gnm')].map(n => n.textContent),
  }));
  const on = document.querySelector('#appRail .rl-item.on, #appRail .rl-h.on');
  return {
    exists: !!document.getElementById('appRail'),
    visible: !!document.getElementById('appRail') && getComputedStyle(document.getElementById('appRail')).display !== 'none',
    secs,
    current: on ? (on.querySelector('.rl-nm') || {}).textContent : null,
    railOn: document.body.classList.contains('rail-on'),
    padded: parseInt(getComputedStyle(document.body).paddingLeft, 10),
  };
});

const clickSection = (page, name) => page.evaluate(n => {
  const h = [...document.querySelectorAll('#appRail .rl-h')].find(x => (x.querySelector('.rl-nm') || {}).textContent === n);
  if (h) h.click();
}, name);

const clickItem = (page, name) => page.evaluate(n => {
  const i = [...document.querySelectorAll('#appRail .rl-item')].find(x => (x.querySelector('.rl-nm') || {}).textContent === n);
  if (i) i.click();
}, name);

const SECTIONS = ['Daily task', 'Properties', 'CRM', 'Finance', 'Property & Media', 'Create brochure'];

// ═══════ CRM ═══════
console.log('\nCRM — desktop');
{
  const page = await open('/crm.html', { width: 1440, height: 900 }, { '/crm-assets/firebase-sync.js': CRM_STUB });
  let s = await railState(page);
  ok('The rail is on the page and laid out', s.exists && s.visible && s.railOn);
  ok('Every console is listed, in order', JSON.stringify(s.secs.map(x => x.name)) === JSON.stringify(SECTIONS), JSON.stringify(s.secs.map(x => x.name)));
  ok('The page content is pushed clear of it', s.padded >= 240, String(s.padded));
  const crm = s.secs.find(x => x.name === 'CRM');
  ok('The console you are in is the open one', crm.open && crm.here, JSON.stringify(crm));
  ok('…showing its four pages', JSON.stringify(crm.items) === JSON.stringify(['Board', 'List', 'Follow-ups', 'Analytics']), JSON.stringify(crm.items));
  ok('…with Board marked as where you are', s.current === 'Board', String(s.current));
  ok('No other console is expanded', s.secs.filter(x => x.open).length === 1);
  await page.screenshot({ path: join(OUT, 'crm-01-board.png') });

  // Opening another console closes this one — the whole point of the accordion.
  await clickSection(page, 'Finance');
  s = await railState(page);
  const fin = s.secs.find(x => x.name === 'Finance');
  ok('Clicking Finance opens Finance', fin.open);
  ok('…and closes CRM', !s.secs.find(x => x.name === 'CRM').open);
  ok('…but CRM still shows you are there', s.secs.find(x => x.name === 'CRM').here);
  ok('Finance keeps its five groups', JSON.stringify(fin.groups) === JSON.stringify(['Daily', 'Business', 'Money', 'Tax & reports', 'Setup']), JSON.stringify(fin.groups));
  ok('…and all nineteen of its pages', fin.items.length === 19, String(fin.items.length));
  await page.screenshot({ path: join(OUT, 'crm-02-finance-open.png') });

  // A finance entry is a link out, not something this page can show.
  const href = await page.evaluate(() => {
    const i = [...document.querySelectorAll('#appRail .rl-item')].find(x => (x.querySelector('.rl-nm') || {}).textContent === 'GST');
    return i ? i.getAttribute('href') : null;
  });
  ok('A Finance page is a real link from here', href === '3pinfinance#gst', String(href));

  await clickSection(page, 'CRM');

  // A lead page is a page, not a dialog: it must sit beside the rail so you
  // can leave for Finance without closing the lead you were reading.
  await page.evaluate(() => openDetail('L1'));
  await page.waitForTimeout(400);
  const dp = await page.evaluate(() => {
    const el = document.getElementById('dp');
    return { shown: getComputedStyle(el).display !== 'none', left: Math.round(el.getBoundingClientRect().left) };
  });
  ok('A lead page opens beside the rail, not over it', dp.shown && dp.left >= 240, JSON.stringify(dp));
  await page.evaluate(() => closeDetail());
  await page.waitForTimeout(200);

  await clickItem(page, 'Follow-ups');
  s = await railState(page);
  ok('Picking Follow-ups switches the view without leaving the page', s.current === 'Follow-ups', String(s.current));
  const shown = await page.evaluate(() => document.getElementById('followupsView').style.display !== 'none');
  ok('…and the follow-ups pane is the one on screen', shown);

  // ── Daily task ──
  await clickSection(page, 'Daily task');
  await page.waitForTimeout(300);
  s = await railState(page);
  ok('Daily task has no sub-pages, so it goes straight there', s.current === 'Daily task', String(s.current));
  const today = await page.evaluate(() => {
    const v = document.getElementById('todayView');
    return {
      shown: v.style.display !== 'none',
      title: (v.querySelector('.td-title') || {}).textContent || '',
      sub: (v.querySelector('.td-sub') || {}).textContent || '',
      sections: [...v.querySelectorAll('.td-sec-t')].map(x => x.textContent),
      rows: [...v.querySelectorAll('.td-row summary')].map(x => x.textContent.replace(/\s+/g, ' ').trim()),
    };
  });
  ok('The day opens on the person signed in', today.shown && /Your day, Agent A/.test(today.title), today.title);
  ok('…summarised in one line', /1 visit/.test(today.sub) && /call/.test(today.sub), today.sub);
  ok('…in three sections', JSON.stringify(today.sections) === JSON.stringify(['Site visits', 'Calls due', 'Asked of you']), JSON.stringify(today.sections));
  ok('Today\'s site visit is listed with its property and time', today.rows.some(r => /15:00|3:00 PM/.test(r) && /TNAG003/.test(r)), JSON.stringify(today.rows[0]));
  ok('…and the brochure a colleague asked for', today.rows.some(r => /Complete the brochure of I Block 3 BHK/.test(r)), JSON.stringify(today.rows));

  // The row opens to what you need on the way out.
  const opened = await page.evaluate(() => {
    const r = [...document.querySelectorAll('#todayView .td-row')].find(x => /TNAG003/.test(x.textContent));
    r.open = true;
    return [...r.querySelectorAll('.td-f')].map(f => f.querySelector('dt').textContent + ': ' + f.querySelector('dd').textContent.replace(/\s+/g, ' ').trim());
  });
  ok('A visit opens to the client number', opened.some(x => /^Client: Rajesh Kumar 98400 12345/.test(x)), JSON.stringify(opened));
  ok('…and the property owner, found from the owner listing on the same property', opened.some(x => /^Property owner: Mrs Lakshmi 98400 44444/.test(x)), JSON.stringify(opened));
  ok('…and the note explaining it', opened.some(x => /^Notes:/.test(x)), JSON.stringify(opened));

  const ask = await page.evaluate(() => {
    const sec = [...document.querySelectorAll('#todayView .td-sec')]
      .find(s => s.querySelector('.td-sec-t').textContent === 'Asked of you');
    const r = sec.querySelector('.td-row');
    r.open = true;
    return [...r.querySelectorAll('.td-f')].map(f => f.querySelector('dt').textContent + ': ' + f.querySelector('dd').textContent.replace(/\s+/g, ' ').trim());
  });
  ok('A task opens to who asked, when it is due and the note',
    ask.some(x => /^Asked by: Admin/.test(x)) && ask.some(x => /^Due: /.test(x)) && ask.some(x => /^Notes: Complete the brochure/.test(x)),
    JSON.stringify(ask));
  await page.screenshot({ path: join(OUT, 'crm-03-daily-task.png'), fullPage: true });

  // ── Narrowed ──
  await page.evaluate(() => window.AppNav.toggle());
  await page.waitForTimeout(350);
  const min = await page.evaluate(() => ({
    min: document.body.classList.contains('rail-min'),
    width: Math.round(document.getElementById('appRail').getBoundingClientRect().width),
    labels: getComputedStyle(document.querySelector('#appRail .rl-nm')).display,
  }));
  ok('The rail narrows to icons', min.min && min.width < 80 && min.labels === 'none', JSON.stringify(min));
  await page.screenshot({ path: join(OUT, 'crm-04-narrow.png') });
  await page.evaluate(() => window.AppNav.toggle());
  await page.close();
}

console.log('\nCRM — phone');
{
  const page = await open('/crm.html', { width: 390, height: 844 }, { '/crm-assets/firebase-sync.js': CRM_STUB });
  const shut = await page.evaluate(() => {
    const r = document.getElementById('appRail');
    return { offscreen: r.getBoundingClientRect().right <= 0, pad: parseInt(getComputedStyle(document.body).paddingLeft, 10) };
  });
  ok('The rail is off-canvas until asked for', shut.offscreen && shut.pad < 20, JSON.stringify(shut));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('…and the header does not run off the side', overflow <= 1, String(overflow));
  await page.screenshot({ path: join(OUT, 'phone-01-crm.png') });

  await page.click('[data-rail-toggle]');
  await page.waitForTimeout(350);
  const open1 = await page.evaluate(() => {
    const r = document.getElementById('appRail');
    return { x: Math.round(r.getBoundingClientRect().left), scrim: getComputedStyle(document.querySelector('.rail-scrim')).opacity };
  });
  ok('Tapping the menu slides it in over the page', open1.x === 0 && Number(open1.scrim) > 0.5, JSON.stringify(open1));
  await page.screenshot({ path: join(OUT, 'phone-02-drawer.png') });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok('Escape closes it', await page.evaluate(() => !document.body.classList.contains('rail-open')));
  await page.close();
}

// ═══════ PROPERTIES ═══════
console.log('\nProperties — desktop');
{
  const page = await open('/dashboard.html', { width: 1440, height: 900 }, { '/dashboard-assets/firebase-sync.js': DASH_STUB });
  let s = await railState(page);
  ok('The same rail, with the same sections', JSON.stringify(s.secs.map(x => x.name)) === JSON.stringify(SECTIONS), JSON.stringify(s.secs.map(x => x.name)));
  const prop = s.secs.find(x => x.name === 'Properties');
  ok('Properties is the open one here', prop.open && prop.here);
  ok('…listing this console\'s own pages', JSON.stringify(prop.items) === JSON.stringify(['All properties', 'Missing data', 'Changes to apply', 'Area map', 'Sync from sheet']), JSON.stringify(prop.items));
  ok('…with All properties current', s.current === 'All properties', String(s.current));
  await page.screenshot({ path: join(OUT, 'prop-01-all.png') });

  await clickItem(page, 'Missing data');
  await page.waitForTimeout(300);
  s = await railState(page);
  const panel = await page.evaluate(() => ({
    open: document.getElementById('missingPanel').classList.contains('open'),
    left: Math.round(document.getElementById('missingPanel').getBoundingClientRect().left),
  }));
  ok('Missing data opens its panel', panel.open);
  ok('…beside the rail, not under it', panel.left >= 240, String(panel.left));
  ok('…and the rail marks it as where you are', s.current === 'Missing data', String(s.current));
  await page.screenshot({ path: join(OUT, 'prop-02-missing.png') });

  // Closing the panel from its own back button has to move the rail back.
  await page.evaluate(() => closeMissing());
  await page.waitForTimeout(200);
  s = await railState(page);
  ok('Closing it from the panel returns the rail to All properties', s.current === 'All properties', String(s.current));

  // Create brochure is an action, so it must not steal the highlight.
  await clickSection(page, 'Create brochure');
  await page.waitForTimeout(300);
  s = await railState(page);
  const modal = await page.evaluate(() => getComputedStyle(document.getElementById('brochureModal')).display !== 'none');
  ok('Create brochure opens the intake form', modal);
  ok('…and leaves the rail pointing at the page underneath', s.current === 'All properties', String(s.current));
  await page.screenshot({ path: join(OUT, 'prop-03-brochure.png') });
  await page.evaluate(() => closeBrochureModal());

  await page.evaluate(() => openDetail('TNAG003'));
  await page.waitForTimeout(400);
  const propDp = await page.evaluate(() => {
    const el = document.getElementById('dp');
    return { shown: getComputedStyle(el).display !== 'none', left: Math.round(el.getBoundingClientRect().left) };
  });
  ok('A property page opens beside the rail too', propDp.shown && propDp.left >= 240, JSON.stringify(propDp));
  await page.evaluate(() => closeDetail());
  await page.waitForTimeout(200);

  const headerButtons = await page.evaluate(() =>
    [...document.querySelectorAll('#hdr button, #hdr a')].map(b => b.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean));
  ok('The header no longer carries links to other consoles',
    !headerButtons.some(t => /Lead CRM|Finance|Property Intelligence/.test(t)), JSON.stringify(headerButtons));
  await page.close();
}

// ═══════ FINANCE ═══════
console.log('\nFinance — desktop');
{
  const page = await open('/tests/app-preview.html', { width: 1440, height: 900 }, {});
  let s = await railState(page);
  ok('The same rail again', JSON.stringify(s.secs.map(x => x.name)) === JSON.stringify(SECTIONS), JSON.stringify(s.secs.map(x => x.name)));
  const fin = s.secs.find(x => x.name === 'Finance');
  ok('Finance is open, with its five groups', fin.open && fin.here && fin.groups.length === 5, JSON.stringify(fin.groups));
  ok('…and Overview is where you are', s.current === 'Overview', String(s.current));
  ok('The old side nav is gone', await page.evaluate(() => !document.getElementById('sidenav')));
  await page.screenshot({ path: join(OUT, 'fin-01-overview.png') });

  await clickItem(page, 'GST');
  await page.waitForTimeout(400);
  s = await railState(page);
  ok('Picking GST goes there without a reload', s.current === 'GST', String(s.current));
  ok('…and the URL says so, so it can be bookmarked', await page.evaluate(() => location.hash) === '#gst');
  await page.screenshot({ path: join(OUT, 'fin-02-gst.png') });

  // A group folds away; the one holding the current page cannot hide it.
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('#appRail .rl-grp-h')].find(x => x.querySelector('.rl-gnm').textContent === 'Money');
    h.click();
  });
  await page.waitForTimeout(200);
  const grp = await page.evaluate(() => {
    const g = [...document.querySelectorAll('#appRail .rl-grp')].find(x => x.querySelector('.rl-gnm').textContent === 'Money');
    const t = [...document.querySelectorAll('#appRail .rl-grp')].find(x => x.querySelector('.rl-gnm').textContent === 'Tax & reports');
    return { money: g.classList.contains('open'), tax: t.classList.contains('open') };
  });
  ok('A finance group closes when you close it', !grp.money);
  ok('…and the group holding the current page stays open', grp.tax);
  await page.close();
}

console.log('\nFinance — phone');
{
  const page = await open('/tests/app-preview.html', { width: 390, height: 844 }, {});
  const bar = await page.evaluate(() => [...document.querySelectorAll('#bottomnav button')].map(b => b.textContent.trim()));
  ok('The phone keeps its tab bar', JSON.stringify(bar) === JSON.stringify(['Overview', 'Transactions', 'Record', 'Owed', 'More']), JSON.stringify(bar));
  await page.evaluate(() => { [...document.querySelectorAll('#bottomnav button')].pop().click(); });
  await page.waitForTimeout(350);
  ok('…and "More" opens the one menu rather than a second one',
    await page.evaluate(() => document.body.classList.contains('rail-open') && !document.getElementById('moreSheet')));
  await page.screenshot({ path: join(OUT, 'phone-03-finance-drawer.png') });
  await page.close();
}

await browser.close();
console.log('\nScreenshots in ' + OUT);
if (errors.length) { console.log('\n' + errors.length + ' problem(s):'); errors.forEach(e => console.log('  - ' + e)); process.exit(1); }
console.log('All checks passed.');
