// ═══════ CRM PREVIEW — TAILORTALK LEADS, NO LOGIN ═══════
//
// Opens the real crm.html in Chromium with crm-assets/firebase-sync.js swapped for an
// in-memory stand-in, seeded with leads built by the REAL webhook mapping
// (api/_tailortalk-shared.js planUpdate) from TailorTalk's sample payload. Screenshots the
// filter, board, list and lead page at desktop and phone width, and fails on any page error.
//
//   node tests/crm-tailortalk-preview.mjs <out-dir>

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planUpdate } from '../api/_tailortalk-shared.js';
import { planPipelineMigration } from '../crm-assets/pipeline.js';

const OUT = process.argv[2] || 'tailortalk-preview';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.now();
const H = 3600000;
const TENANT = 't_3pinrealty';
// The reworked, keyed pipeline (same ids the live migration keeps).
const STAGES = planPipelineMigration([
  { id: 'new', name: 'New' }, { id: 'site_visit', name: 'Site Visit' }, { id: 'negotiation', name: 'in Negotiation' },
  { id: 'closed_won', name: 'Closed' }, { id: 'closed_lost', name: 'Not interested' }
], []).stages;
const TYPES = ['Property Enquiry', 'Seller Listing', 'General'];
const SAMPLE = JSON.parse(readFileSync(new URL('./fixtures/tailortalk-sample.json', import.meta.url), 'utf8'));
const iso = ms => new Date(ms).toISOString();

function ttLead(id, data, extra = {}, signal = null) {
  const e = JSON.parse(JSON.stringify(SAMPLE));
  e.webhook_trigger = signal ? 'custom' : 'every_message';
  e.occurred_at = iso(NOW - H);
  Object.assign(e.data, { id: 'agent_' + id }, data);
  const p = planUpdate({ envelope: e, lead: null, state: null, leadId: id, tenantId: TENANT, stages: STAGES, enquiryTypes: TYPES, now: NOW, signal });
  return { lead: { ...p.leadWrite, ...extra, tt: { ...p.leadWrite.tt, ...(extra.tt || {}) } }, state: p.stateWrite };
}

const chat = (mins, rows) => rows.map(([role, content], i) => ({ role, content, time: iso(NOW - (mins - i * 3) * 60000), ...(role === 'human_agent' ? { email: 'thirumal@threepin.in' } : {}) }));

const seeds = [
  ttLead('tt1', {
    lead_name: 'Rajesh Kumar', lead_contact: '919840012345', lead_status: 'hot', escalated: true, escalated_to: 'Sales – South Chennai',
    total_followups: 1, created_at: iso(NOW - 26 * H), last_message_seen: false,
    metadata: [SAMPLE.data.metadata[0], SAMPLE.data.metadata[1]].map((m, i) => i === 0 ? { ...m, start_time: iso(NOW + 30 * H), summary: 'Site visit — VLCA002' } : m),
    chat_history: chat(95, [
      ['user', 'Hi, saw your reel about the Velachery 3 BHK. Is it still available?'],
      ['assistant', 'Hi Rajesh! Yes, VLCA002 is available. May I know your budget and when you plan to move?'],
      ['user', 'Around 3.3 Cr. Need possession within 6 months. Must be a gated community.'],
      ['assistant', 'VLCA002 fits that. Would you like to visit this weekend?'],
      ['user', 'Yes, Sunday evening works. Can someone call me about the price?'],
      ['human_agent', 'Hi Rajesh, Thirumal from 3 PIN here. I will call you in 10 minutes.'],
      ['user', 'Also, is the car park covered?'],
      ['assistant', '<No response from agent>']
    ])
  }, { stageId: 'site_visit' }),
  ttLead('tt2', {
    lead_name: 'Priya S', lead_contact: 'priya.homes', integration: 'instagram', lead_source: 'instagram_dm', lead_status: 'warm',
    lead_lock_status: true, preferred_location: 'Anna Nagar. Near her parents.', budget_and_finance: '1.2 Cr. Loan pre-approved.',
    metadata: [], ad_data: null, created_at: iso(NOW - 50 * H),
    chat_history: chat(400, [['user', 'Looking for a 2 BHK in Anna Nagar'], ['assistant', 'Happy to help! What budget are you considering?'], ['user', 'Can you send me the brochure and floor plan?']])
  }, { stageId: 'options_shared' }, 'details_request'),
  ttLead('tt3', {
    lead_name: 'Meena R', lead_contact: '919500067890', lead_status: 'cold', is_converted: true, converted_at: iso(NOW - 5 * 24 * H),
    preferred_location: 'Nanganallur', budget_and_finance: '85 L', intent_and_who: 'Sell, owner of a 2 BHK flat', metadata: [], ad_data: null,
    created_at: iso(NOW - 12 * 24 * H), chat_history: chat(3000, [['user', 'I want to sell my flat in Nanganallur']])
  }, { stageId: 'negotiation' }),
  ttLead('tt4', {
    lead_name: 'Karthik Subramaniam', lead_contact: '919876543211', lead_status: 'warm', flagged: true, flag_details: 'Asked for a discount twice',
    budget_and_finance: '2 Cr (earlier: 1.8 Cr)', preferred_location: 'Adyar', metadata: [], created_at: iso(NOW - 6 * 24 * H),
    chat_history: chat(1500, [['user', 'Can you do 2 Cr for the Adyar flat?']])
  }, { stageId: 'options_shared', source: 'manual', createdBy: 'owner@threepin.in', budget: '1.8 Cr', ttHold: { budget: true } }),
  ttLead('tt5', {
    lead_name: 'AdSpark Media', lead_contact: '919444012121', category: 'others', lead_status: 'vendor pitch',
    intent_and_who: 'Selling advertising packages', preferred_location: null, budget_and_finance: null, metadata: [], ad_data: null,
    created_at: iso(NOW - 3 * 24 * H), chat_history: chat(4000, [['user', 'We run property ads on YouTube, can we pitch?'], ['assistant', 'Thanks, I will pass this to the team.']])
  }, { stageId: 'new' })
];

const plain = [
  { id: 'lead_m1', name: 'Suresh Kumar', phone: '98765 43213', email: '', channel: 'call', enquiryType: 'Property Enquiry', propertyInterest: 'Villa in Anna Nagar', budget: '3 Cr', source: 'manual', stageId: 'site_visit', createdAt: NOW - 10 * 24 * H, updatedAt: NOW - 3 * 24 * H, followUpAt: NOW - 2 * H, tenantId: TENANT },
  { id: 'lead_m2', name: 'Divya Sundaram', phone: '98765 43216', email: 'divya.s@example.com', channel: 'instagram', enquiryType: 'Property Enquiry', propertyInterest: '2BHK in Royapettah', source: 'meta', stageId: 'new', createdAt: NOW - H, updatedAt: NOW - H, tenantId: TENANT }
];

const LEADS = [...seeds.map(s => s.lead), ...plain];
const STATES = Object.fromEntries(seeds.map(s => [s.lead.id, s.state]));

const STUB = `
const LEADS = ${JSON.stringify(LEADS)};
const STATES = ${JSON.stringify(STATES)};
const STAGES = ${JSON.stringify(STAGES)};
window.__saved = [];
window.crmFirebase = {
  saveLead: async l => { window.__saved.push(JSON.parse(JSON.stringify(l))); },
  deleteLead: async () => {}, getLeadNotes: async () => [], getLeadHistory: async () => [
    { id:'h1', type:'tailortalk', text:'TailorTalk status changed from <b>Warm</b> to <b>Hot</b>', at: Date.now()-3600000, by:'TailorTalk' },
    { id:'h0', type:'created', text:'Lead added from <b>TailorTalk</b> (WhatsApp ad · Summer Sale Campaign 2026)', at: Date.now()-90000000, by:'TailorTalk' }
  ],
  saveNote: async () => {}, deleteNoteDoc: async () => {}, saveHistory: async () => {}, savePipeline: async () => {},
  getBotConfig: async () => null, saveBotConfig: async () => {}, saveEnquiryTypes: async () => {}, saveProperties: async () => {},
  saveFollowupDigestSettings: async () => {}, saveDashboardEmailSettings: async () => {},
  releaseLeadField: async () => {},
  getLeadTailorTalk: async id => STATES[id] || null
};
window.crmAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => 't_3pinrealty' };
window.onCrmAuthChange({ email: 'owner@threepin.in' });
window.applyPipelineSnapshot(STAGES);
window.applyEnquiryTypesSnapshot(['Property Enquiry','Seller Listing','General']);
window.applyLeadsSnapshot(JSON.parse(JSON.stringify(LEADS)));
window.__ready = true;
`;

const TYPES_BY_EXT = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };

const browser = await chromium.launch();
const errors = [];
async function openPage(viewport, theme) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  if (theme) await ctx.addInitScript(t => { try { localStorage.setItem('crmTheme', t); } catch (e) {} }, theme);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${viewport.width}px: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`${viewport.width}px console: ${m.text()}`); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'crm.local') return route.abort();
    if (url.pathname === '/crm-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{}' });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES_BY_EXT[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://crm.local/crm.html');
  try {
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  } catch (e) {
    console.log('Page never became ready. Errors so far:\n' + errors.join('\n'));
    throw e;
  }
  await page.waitForTimeout(300);
  return page;
}

const shots = [];
const shot = async (page, name, opts = {}) => { const path = join(OUT, name + '.png'); await page.screenshot({ path, ...opts }); shots.push(path); };

// Desktop
{
  const page = await openPage({ width: 1440, height: 900 });
  await page.evaluate(() => { try { localStorage.removeItem('crmLeadFilter'); } catch (e) {} setLeadScope('all'); });
  await shot(page, '01-board-all');
  await page.evaluate(() => setLeadScope('tt'));
  await shot(page, '02-board-tailortalk');
  const counts = await page.evaluate(() => ({
    columns: [...document.querySelectorAll('.kcol')].map(c => c.querySelectorAll('.lcard').length).reduce((a, b) => a + b, 0),
    chips: [...document.querySelectorAll('#leadFilterBar .lf-chip')].map(b => b.textContent.trim())
  }));
  console.log('TailorTalk filter shows', counts.columns, 'cards; chips:', counts.chips.join(' | '));
  if (counts.columns !== 4) errors.push(`TailorTalk filter should show 4 cards, showed ${counts.columns}`);
  await page.evaluate(() => setLeadStatusFilter('hot'));
  const hot = await page.evaluate(() => document.querySelectorAll('.lcard').length);
  if (hot !== 1) errors.push(`Hot filter should show 1 card, showed ${hot}`);
  await page.evaluate(() => { setLeadScope('tt'); setLeadFocus('action'); });
  const att = await page.evaluate(() => document.querySelectorAll('.lcard').length);
  if (att !== 3) errors.push(`Needs-action focus should show 3 cards (escalated, flagged, wants details), showed ${att}`);
  const alertLine = await page.evaluate(() => [...document.querySelectorAll('.lcard-alert')].map(c => c.textContent.trim()));
  if (!alertLine.some(c => /Asked for property details/.test(c))) errors.push('Signal missing on the board: ' + JSON.stringify(alertLine));
  else console.log('  ok  signal on the board:', alertLine.join(' | '));
  await shot(page, '03-board-needs-attention', { clip: { x: 0, y: 0, width: 1440, height: 560 } });
  // The lead page lists what needs a person once; "Handled" closes it everywhere.
  await page.evaluate(() => openDetail('tt2'));
  await page.waitForTimeout(300);
  const row = await page.evaluate(() => [...document.querySelectorAll('#dpStand .st-item')].map(r => r.textContent.replace(/\s+/g, ' ').trim()).join(' | '));
  if (!/Asked for property details/.test(row) || !/brochure and floor plan/.test(row) || !/Log follow-up/.test(row)) errors.push('Signal row on the lead page is wrong: ' + row);
  else console.log('  ok  signal row:', row);
  await page.locator('#dpStandSec').screenshot({ path: join(OUT, '03b-detail-signal.png') });
  const waiting = await page.evaluate(() => attentionFor(leads.find(l => l.id === 'tt1')).map(a => a.key));
  if (!waiting.includes('waiting_for_team')) errors.push('A conversation ending on "no response" should raise waiting_for_team: ' + JSON.stringify(waiting));
  else console.log('  ok  "waiting for team" raised for a message the AI left for the team');
  await page.evaluate(() => { markHandledUi('tt2', 'Asked for property details'); closeDetail(); });
  const attAfter = await page.evaluate(() => document.querySelectorAll('.lcard').length);
  if (attAfter !== 2) errors.push(`After "Handled", needs action should drop to 2, got ${attAfter}`);
  else console.log('  ok  "Handled" closes the signal (needs action 3 → 2)');
  await page.evaluate(() => setLeadFocus('action'));
  await page.evaluate(() => setLeadScope('other'));
  const other = await page.evaluate(() => document.querySelectorAll('.lcard').length);
  if (other !== 2) errors.push(`Other filter should show 2 cards, showed ${other}`);
  await page.evaluate(() => setLeadScope('business'));
  const biz = await page.evaluate(() => [...document.querySelectorAll('.lcard .lcard-name')].map(n => n.textContent));
  if (biz.length !== 1 || biz[0] !== 'AdSpark Media') errors.push('Vendors & collabs should show only the vendor: ' + JSON.stringify(biz));
  else console.log('  ok  Vendors & collabs is its own category:', biz.join(', '));
  await page.evaluate(() => setLeadScope('all'));
  const salesNames = await page.evaluate(() => [...document.querySelectorAll('.lcard .lcard-name')].map(n => n.textContent));
  if (salesNames.includes('AdSpark Media')) errors.push('Sales leads must not include the vendor');
  await page.evaluate(() => { setLeadScope('all'); toggleView('list'); });
  await shot(page, '04-list');
  await page.evaluate(() => { toggleView('kanban'); openDetail('tt1'); });
  await page.waitForTimeout(400);
  await shot(page, '05-detail-hot-lead');
  await page.evaluate(() => { setTtTab('overview'); });
  await page.locator('#dpTtSec').screenshot({ path: join(OUT, '05b-detail-overview.png') });
  // The day-by-day chat summary lives in the lead's Timeline now (TailorTalk filter).
  await page.evaluate(() => { setTimelineFilter('tailortalk'); });
  const act = await page.evaluate(() => { const el = document.getElementById('timelinePanel'); return el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 260) : null; });
  if (!act || !/from the lead/.test(act)) errors.push('Timeline should summarise the chat day: ' + act);
  else console.log('  ok  timeline chat day:', act);
  await page.locator('#dpTimelineSec').screenshot({ path: join(OUT, '05c-detail-timeline.png') });
  await page.evaluate(() => { setTimelineFilter('all'); });
  await page.evaluate(() => { setTtTab('conversation'); });
  const sys = await page.evaluate(() => !!document.querySelector('#dpTt .tt-chat-sys') && !!document.querySelector('#dpTt .tt-chat-day'));
  if (!sys) errors.push('Conversation should show day separators and the "left for the team" line');
  await page.locator('#dpTtSec').screenshot({ path: join(OUT, '05d-detail-conversation.png') });
  await page.evaluate(() => { setTtTab('overview'); });
  await page.evaluate(() => openDetail('tt4'));
  await page.waitForTimeout(400);
  await page.locator('#dpTtSec').screenshot({ path: join(OUT, '06-detail-held-budget.png') });
  const says = await page.evaluate(() => { const el = document.querySelector('#dpTt .tt-says'); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null; });
  if (!says || !/budget: 2 Cr · you have 1\.8 Cr/.test(says)) errors.push('Held budget should show what TailorTalk now says, got: ' + says);
  else console.log('  ok  held field row:', says);
  const booking = await page.evaluate(() => { openDetail('tt1'); return new Promise(r => setTimeout(() => r([...document.querySelectorAll('#dpTt .tt-item')].map(e => e.textContent.replace(/\s+/g, ' ').trim())), 300)); });
  if (booking.length !== 2) errors.push('Hot lead should list 1 booking + 1 payment, got: ' + JSON.stringify(booking));
  else console.log('  ok  bookings/payments:', booking.join(' | '));
  await page.evaluate(() => openDetail('tt4'));
  // Editing a followed field in the Edit form takes it over (ttHold) — the untouched ones don't.
  await page.evaluate(() => {
    openEditLeadModal('tt1');
    document.getElementById('lmBudget').value = '3.4 Cr';
    saveLeadModal();
  });
  const edited = await page.evaluate(() => window.__saved[window.__saved.length - 1]);
  if (!(edited.ttHold && edited.ttHold.budget === true)) errors.push('Editing the budget should hold it: ' + JSON.stringify(edited.ttHold));
  if (edited.ttHold && (edited.ttHold.name || edited.ttHold.propertyInterest)) errors.push('Untouched fields must not be held: ' + JSON.stringify(edited.ttHold));
  else console.log('  ok  Edit form holds only the field that was changed:', JSON.stringify(edited.ttHold));
  await page.evaluate(() => openDetail('tt3'));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('dpTtSec').scrollIntoView() || window.scrollBy(0, -80));
  await shot(page, '07-detail-converted');
  await page.close();
}

// Phone
{
  const page = await openPage({ width: 390, height: 844 });
  await page.evaluate(() => setLeadScope('tt'));
  await shot(page, '08-phone-board-tailortalk');
  await page.evaluate(() => openDetail('tt1'));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('dpTtSec').scrollIntoView() || window.scrollBy(0, -80));
  await shot(page, '09-phone-detail');
  await page.evaluate(() => { document.getElementById('dpTimelineSec').scrollIntoView(); });
  await shot(page, '09b-phone-timeline');
  await page.evaluate(() => setTtTab('overview'));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) errors.push(`Phone lead page scrolls sideways by ${overflow}px`);
  const edges = () => page.evaluate(() => [...document.querySelectorAll('#dp .dp-act')].map(b => `${b.textContent.trim()}→${Math.round(b.getBoundingClientRect().right)}`).join(', '));
  const ttEdges = await edges();
  await page.evaluate(() => openDetail('lead_m1'));
  const plainEdges = await edges();
  console.log(`  phone header buttons (viewport 390) — TailorTalk lead: ${ttEdges} | ordinary lead: ${plainEdges}`);
  const past = s => s.split(', ').some(x => Number(x.split('→')[1]) > 391);
  if (past(ttEdges) && !past(plainEdges)) errors.push('Phone lead page: a header button runs off the screen on a TailorTalk lead only');
  await page.evaluate(() => openDetail('tt1'));
  await page.close();
}

// Dark
{
  const page = await openPage({ width: 1440, height: 900 }, 'dark');
  await page.evaluate(() => { setLeadScope('tt'); openDetail('tt1'); });
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('dpTtSec').scrollIntoView() || window.scrollBy(0, -80));
  await shot(page, '10-dark-detail');
  await page.close();
}

// The REAL crm-assets/firebase-sync.js saveLead, with the Firebase SDK swapped for recorders:
// a save on a lead TailorTalk follows must not carry tt or the fields TailorTalk still owns.
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('firebase-sync: ' + e.message));
  const rec = 'const w=()=>(window.__writes||(window.__writes=[]));';
  const SDK = {
    'firebase-app.js': 'export const initializeApp=()=>({}); export const getApps=()=>[];',
    'firebase-firestore.js': `${rec} export const getFirestore=()=>({}); export const collection=(db,...p)=>({path:p.join('/')}); export const doc=(db,...p)=>({path:p.join('/')});
      export const setDoc=async(ref,data,opts)=>{w().push({op:'set',path:ref.path,data:JSON.parse(JSON.stringify(data)),opts:opts||null});};
      export const updateDoc=async(ref,data)=>{w().push({op:'update',path:ref.path,data});};
      export const deleteDoc=async()=>{}; export const onSnapshot=()=>()=>{}; export const getDoc=async()=>({exists:()=>false,data:()=>null});
      export const getDocs=async()=>({docs:[]}); export const writeBatch=()=>({set(){},commit:async()=>{}}); export const query=()=>({}); export const where=()=>({});
      export const deleteField=()=>({__deleteField:true});`,
    'firebase-auth.js': 'export const getAuth=()=>({}); export const signInWithEmailAndPassword=async()=>{}; export const signOut=async()=>{}; export const onAuthStateChanged=()=>{};'
  };
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.gstatic.com') return route.fulfill({ contentType: 'text/javascript', body: SDK[url.pathname.split('/').pop()] || '' });
    if (url.hostname !== 'crm.local') return route.abort();
    if (url.pathname === '/sync.html') {
      // phoneKey() comes from app.js on the real page; this is the same function.
      const phoneKeySrc = readFileSync(join(ROOT, 'crm-assets/app.js'), 'utf8').match(/function phoneKey\(raw\)\{[\s\S]*?\n\}/)[0];
      return route.fulfill({ contentType: 'text/html', body: `<script>${phoneKeySrc}</script><script type="module" src="/crm-assets/firebase-sync.js"></script>` });
    }
    return route.fulfill({ contentType: 'text/javascript', body: readFileSync(join(ROOT, url.pathname)) });
  });
  await page.goto('http://crm.local/sync.html');
  await page.waitForFunction(() => !!window.crmFirebase, null, { timeout: 10000 });
  const writes = await page.evaluate(async ([ttLeadObj, plainLead]) => {
    window.__writes = [];
    await window.crmFirebase.saveLead({ ...ttLeadObj, notes: [{ id: 'n' }], history: [] });
    await window.crmFirebase.saveLead(plainLead);
    await window.crmFirebase.releaseLeadField(ttLeadObj.id, 'budget', '2 Cr');
    return window.__writes;
  }, [LEADS.find(l => l.id === 'tt4'), LEADS.find(l => l.id === 'lead_m1')]);
  const [ttSave, plainSave, release] = writes;
  const need = (label, ok) => { if (!ok) errors.push('saveLead: ' + label); else console.log('  ok  saveLead: ' + label); };
  need('merges instead of replacing the document', ttSave.opts && ttSave.opts.merge === true);
  need('never sends tt', !('tt' in ttSave.data));
  need('never sends notes/history bodies', !('notes' in ttSave.data) && !('history' in ttSave.data));
  need('leaves out name / locality / enquiry type TailorTalk still follows', !('name' in ttSave.data) && !('propertyInterest' in ttSave.data) && !('enquiryType' in ttSave.data));
  need('sends the budget the team took over', ttSave.data.budget === '1.8 Cr');
  need('sends the team\'s own fields (stage)', ttSave.data.stageId === 'options_shared');
  need('stamps phoneKey', ttSave.data.phoneKey === '919876543211');
  need('a lead without TailorTalk still sends every field', plainSave.data.name === 'Suresh Kumar' && plainSave.data.propertyInterest === 'Villa in Anna Nagar');
  need('"Use TailorTalk\'s value" writes the value and releases the hold together', release.op === 'update' && release.data.budget === '2 Cr' && release.data['ttHold.budget'] === false);
  await ctx.close();
}

await browser.close();
console.log(shots.length, 'screenshots in', OUT);
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('No page errors');
