// ═══════ UX SWEEP — EVERY PAGE, EVERY MENU ENTRY, MEASURED ═══════
//
//   node tests/ux-sweep.mjs [out-dir]
//
// Fixtures and stubs are the same as tests/appnav-preview.mjs (copied, so this runs on its own).
// Reports text drawn over other text, sideways scrolling, cut-off controls, and full-screen
// layers that Esc does not close — on the CRM, Properties and Finance consoles, desktop and phone.
//
// (Original header of appnav-preview follows.)
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
const OUT = process.argv[2] || 'tests/out/ux-sweep';
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
window.__propAgentWrites = [];
window.dashboardFirebase = { saveProperty: async()=>{}, deleteProperty: async()=>{}, saveFavorites: async()=>{},
  saveChange: async()=>{}, getChanges: async()=>[], saveNaFields: async()=>{},
  getTeam: async()=>['pradeep@threepin.in','swami@threepin.in','thirumal@threepin.in'],
  setPropertyAgents: async(id, patch)=>{ window.__propAgentWrites.push({ id, patch }); } };
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
export const getFirestore = obj, collection = obj, doc = obj, setDoc = async()=>{}, onSnapshot = off, deleteDoc = async()=>{}, updateDoc = async()=>{}, deleteField = obj, addDoc = async()=>({}), increment = obj, arrayUnion = obj, arrayRemove = obj;
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
  page.on('pageerror', e => { console.log('  PAGEERROR ' + e.message + (process.env.STACK ? ' @ ' + String(e.stack).split(/\r?\n/).slice(1, 4).join(' | ') : '')); errors.push('pageerror: ' + e.message); });
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


// ═══════ THE SWEEP ═══════
// Every menu entry on every console, at a laptop and a phone width. After each one opens, the
// browser is asked — not a screenshot — whether text sits on top of other text, whether the page
// scrolls sideways, whether a button or label is cut off, and whether a full-screen layer that
// appeared can be closed with Esc. Anything found is a line in the report with where it is.
const findings = [];
const note = (where, kind, detail) => { findings.push({ where, kind, detail }); console.log(`  ${kind.padEnd(12)} ${where} — ${detail}`); };

const measure = page => page.evaluate(() => {
  const vis = el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.05 && r.width > 0 && r.height > 0; };
  const layerOf = el => { let e = el; while (e && e !== document.body) { const p = getComputedStyle(e).position; if (p === 'fixed' || p === 'sticky') return e; e = e.parentElement; } return document.body; };
  const out = { overlaps: [], clipped: [], overflowX: 0, layers: [] };
  out.overflowX = Math.max(0, document.scrollingElement.scrollWidth - window.innerWidth);
  // Text runs that are actually painted on screen.
  const runs = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode()) && runs.length < 2500) {
    const t = n.textContent.trim();
    if (t.length < 2) continue;
    const el = n.parentElement;
    if (!el || !vis(el) || el.closest('script,style,noscript,option,select,textarea,[aria-hidden="true"]')) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width < 3 || r.height < 6 || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue;
      // Painted, not merely laid out: inside a closed <details>, scrolled out of a list, or under
      // another layer, what is at the run's middle is not the run.
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) continue;
      runs.push({ el, r, t: t.slice(0, 40), layer: layerOf(el) });
    }
  }
  const seen = new Set();
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i], b = runs[j];
    if (a.el === b.el || a.layer !== b.layer || a.el.contains(b.el) || b.el.contains(a.el)) continue;
    const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
    const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
    if (w > 4 && h > 4 && w * h > 40) {
      // Only if what is painted at the overlap is one of the two (not something covering both).
      const x = Math.max(a.r.left, b.r.left) + w / 2, y = Math.max(a.r.top, b.r.top) + h / 2;
      const top = document.elementFromPoint(x, y);
      if (!top || !(a.el.contains(top) || top.contains(a.el) || b.el.contains(top) || top.contains(b.el))) continue;
      const k = a.t + '|' + b.t;
      if (seen.has(k)) continue; seen.add(k);
      out.overlaps.push(`"${a.t}" over "${b.t}" at ${Math.round(x)},${Math.round(y)}`);
    }
  }
  // Buttons, chips, labels and headings whose text is cut without an ellipsis.
  for (const el of document.querySelectorAll('button, a, label, h1, h2, h3, [class*="chip"], [class*="pill"], [class*="badge"], th')) {
    if (!vis(el) || !el.textContent.trim()) continue;
    const s = getComputedStyle(el);
    if ((s.overflow === 'hidden' || s.overflowX === 'hidden') && s.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      out.clipped.push(`"${el.textContent.trim().slice(0, 40)}" (${el.scrollWidth}px in ${el.clientWidth}px)`);
    }
  }
  // Full-screen layers that are open right now.
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' || !vis(el)) continue;
    const r = el.getBoundingClientRect();
    // On screen, not a drawer parked off to the side.
    const w = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0), h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    if (w > 0 && h > 0 && w * h > window.innerWidth * window.innerHeight * 0.55 && +s.zIndex >= 100) out.layers.push(el.id || el.className.toString().slice(0, 40));
  }
  out.clipped = out.clipped.slice(0, 12); out.overlaps = out.overlaps.slice(0, 15);
  return out;
});

async function sweep(path, stubs, viewport, label) {
  console.log(`\n${label} — ${viewport.width}px`);
  const page = await open(path, viewport, stubs);
  const items = await page.evaluate(() => [...document.querySelectorAll('#appRail .rl-item, #appRail .rl-h')]
    .map(e => (e.querySelector('.rl-nm') || {}).textContent).filter(Boolean));
  const check = async where => {
    const m = await measure(page);
    if (m.overflowX > 2) note(where, 'SIDEWAYS', `page scrolls ${m.overflowX}px sideways`);
    m.overlaps.forEach(o => note(where, 'OVERLAP', o));
    if (m.overlaps.length) await page.screenshot({ path: join(OUT, where.replace(/[^\w]+/g, '_') + '_' + page.viewportSize().width + '.png') }).catch(() => {});
    m.clipped.forEach(c => note(where, 'CUT OFF', c));
    for (const layer of m.layers) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      const still = await page.evaluate(id => { const el = id && document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0; }, layer);
      if (still) note(where, 'NO ESC', `full-screen layer "${layer}" stays open on Esc`);
    }
  };
  await check(`${label} home`);
  for (const name of [...new Set(items)]) {
    if (/sign out/i.test(name)) continue;
    // On a phone the rail is a drawer: open it first.
    await page.evaluate(() => { const b = document.querySelector('#railToggle, .rl-burger, [aria-label="Open menu"]'); if (b && !document.body.classList.contains('rail-open') && window.innerWidth < 800) b.click(); });
    const before = page.url();
    await page.evaluate(n => {
      const el = [...document.querySelectorAll('#appRail .rl-item, #appRail .rl-h')].find(x => (x.querySelector('.rl-nm') || {}).textContent === n);
      if (el) el.click();
    }, name);
    await page.waitForTimeout(700);
    if (page.url().split('?')[0].split('#')[0] !== before.split('?')[0].split('#')[0]) { await page.goBack().catch(() => {}); await page.waitForTimeout(300); continue; }   // another console: swept on its own
    await check(`${label} › ${name}`);
  }
  await page.close();
}

await sweep('/crm.html', { '/crm-assets/firebase-sync.js': CRM_STUB }, { width: 1440, height: 900 }, 'CRM');
await sweep('/crm.html', { '/crm-assets/firebase-sync.js': CRM_STUB }, { width: 390, height: 844 }, 'CRM');
await sweep('/dashboard.html', { '/dashboard-assets/firebase-sync.js': DASH_STUB }, { width: 1440, height: 900 }, 'Properties');
await sweep('/dashboard.html', { '/dashboard-assets/firebase-sync.js': DASH_STUB }, { width: 390, height: 844 }, 'Properties');
await sweep('/tests/app-preview.html', {}, { width: 1440, height: 900 }, 'Finance');
await sweep('/tests/app-preview.html', {}, { width: 390, height: 844 }, 'Finance');

await browser.close();
console.log(`\n${findings.length} finding(s); ${errors.length} page error(s)`);
errors.forEach(e => console.log('  ERROR ' + e));
