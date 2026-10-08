// ═══════ BROCHURE FROM THE PROPERTY & MEDIA BOARD — a property manager's day ═══════
// The real propertytrack.html, Firebase replaced by an in-memory stand-in, the Google
// Form replaced by a recorder. Every scenario a manager meets:
//   • the owner chat is gone from the listing; the brochure panel sits under Notes
//   • typing a code: suggestions, "duplicate found" → preview → link (everything fills)
//   • the THVA0001 / THVA001 slip is caught; a code another listing uses is refused
//   • a new property: fill, generate → same form as Create brochure, logged, stage moves
//   • nothing can be sent half-filled
//   • the property reaches the dashboard → the listing links itself, ticks done, locks
//   • locked fields copy; unlocking for a redo does not re-lock on the old brochure
//   • New listing / Edit: same code checks, an existing code links on save
//   node tests/brochure-board.mjs [out-dir]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStages } from '../track-assets/track-pipeline.js';

const OUT = process.argv[2] || 'tests/out/brochure-board';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.now(), D = 86400000, T = 't_3pinrealty';
const STAGES = defaultStages();
const sid = k => STAGES.find(s => s.key === k).id;

const INV = [
  { id: 'EGM0001', propertyCode: 'EGM0001', name: 'Egmore 3BHK', location: 'Egmore', config: '3 BHK', startingPrice: '₹1.9 Cr', photosLink: 'https://drive.google.com/drive/folders/egm', brochureLink: 'https://drive.google.com/file/d/egm-brochure', detailsText: 'Egmore 3BHK, 1650 sqft, east facing, near Egmore station.' },
  { id: 'EGM0002', propertyCode: 'EGM0002', name: 'Egmore Villa', location: 'Egmore', photosLink: 'https://drive.google.com/drive/folders/egm2', brochureLink: '', detailsText: '' },
  { id: 'THVA001', propertyCode: 'THVA001', name: 'LUX 49 - Manvi Homes', location: 'Thiruvanmiyur', brochureLink: 'THVA001_LUX49.pdf' },
  { id: '17', propertyCode: '', name: 'Old listing with no code' },
  { id: '123', propertyCode: '123', name: 'Older property, bare-number id', photosLink: 'https://drive.google.com/drive/folders/old123' },
  // A sheet value is not trusted: a code that tries to break out of an inline handler.
  { id: 'evil', propertyCode: "XQ1');window.__pwned=1;//", name: 'Odd code from the sheet' }
];
const LEADS = [{ id: 'sd1', tenantId: T, name: 'Meenakshi', phone: '9840011111', enquiryType: 'Seller Listing', createdAt: NOW - 3 * D }];
const base = o => ({ tenantId: T, media: {}, ownerInformed: true, ownerApproved: true, stageChangedAt: NOW - D, createdAt: NOW - 5 * D, updatedAt: NOW - D, ...o });
const LISTINGS = [
  base({ id: 'l1', title: 'Egmore flat', location: 'Egmore', stageId: sid('shoot_done'), leadId: 'sd1', sellerName: 'Meenakshi', sellerPhone: '9840011111' }),
  base({ id: 'l2', title: 'Villa near ECR', location: 'Kottivakkam', stageId: sid('shoot_done') }),
  base({ id: 'l3', title: 'Plot, Adyar', stageId: sid('details'), brochure: { code: 'ADYR0001' } }),
  base({ id: 'l4', title: 'Old flat, mapped long ago', stageId: sid('details'), propertyCode: '123' }),
  base({ id: 'l5', title: 'Egmore villa, asked for', stageId: sid('details'), propertyCode: 'EGM0002', brochure: { code: 'EGM0002', requestedAt: NOW - D } })
];

const STUB = `
window.__saved = []; window.__inv = ${JSON.stringify(INV)};
window.trackFirebase = {
  saveListing: async l => { window.__saved.push(JSON.parse(JSON.stringify(l))); },
  deleteListing: async () => {}, savePipeline: async () => {}, patchLead: async () => {},
  getInventory: async () => JSON.parse(JSON.stringify(window.__inv)),
  getPropertyInternalNotes: async id => id === 'EGM0001' ? 'Owner: Mr Raman, call after 6pm. Keys with watchman.' : '',
  getLeadConversation: async () => ({ chat: [{ role: 'user', content: 'SHOULD NOT BE SHOWN' }] }),
  getListingHistory: async () => [], saveHistory: async () => {}, deleteHistory: async () => {},
  savePosting: async () => {}, deletePosting: async () => {}
};
window.trackAuth = { login: async () => {}, logout: async () => {}, getTenantId: () => '${T}', getIdToken: async () => 'test-token' };
setTimeout(() => {
  window.onTrackAuthChange({ email: 'admin@3pin.in' }, '${T}');
  window.applyTrackPipelineSnapshot(${JSON.stringify(STAGES)});
  window.applyListingsSnapshot(${JSON.stringify(LISTINGS)});
  window.applyTrackLeadsSnapshot(${JSON.stringify(LEADS)});
  window.applyPostingSnapshot([]);
  window.__ready = true;
}, 0);`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const browser = await chromium.launch();
const problems = [];
const ok = (l, c, d) => { if (c) console.log('  ok  ' + l); else { console.log('  FAIL ' + l + (d !== undefined ? ' — ' + d : '')); problems.push(l); } };
const section = n => console.log('\n── ' + n);
const formPosts = [], logPosts = [];
let formHold = null;

async function open(viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://track.local' });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  // The test host is plain http, where browsers hide the clipboard; the live site is https. Stand one in.
  await ctx.addInitScript(() => { try { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__clip = t; }, readText: async () => window.__clip || '' } }); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => problems.push(`${viewport.width}px page error: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) problems.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    // The form can be held unanswered (formHold), as on a slow phone: time to click twice or redraw meanwhile.
    if (url.hostname === 'docs.google.com' && url.pathname.endsWith('/formResponse')) { formPosts.push(req.postData() || ''); return (formHold || Promise.resolve()).then(() => route.fulfill({ status: 200, body: '' })); }
    if (url.hostname !== 'track.local') return route.abort();
    if (url.pathname === '/api/brochure') { logPosts.push(req.postData() || ''); return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); }
    if (url.pathname === '/track-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://track.local/propertytrack.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  return page;
}

const p = await open({ width: 1440, height: 950 });
const last = id => p.evaluate(i => { const s = window.__saved.filter(x => x.id === i); return s[s.length - 1] || null; }, id);
const openListing = async id => { await p.evaluate(i => window.openDetail(i), id); await p.waitForSelector('#bpSec'); await p.waitForTimeout(150); };
const typeCode = async v => { await p.fill('#bpCode', v); await p.dispatchEvent('#bpCode', 'input'); await p.waitForTimeout(80); };
const stageKey = async id => { const s = await last(id); return s ? STAGES.find(x => x.id === s.stageId).key : null; };

section('The listing: no owner chat; the brochure panel sits under Notes');
await openListing('l1');
ok('The owner conversation is gone', !(await p.$('#dpConvo')) && !/SHOULD NOT BE SHOWN/.test(await p.textContent('#dpBody')));
const order = await p.$$eval('.tk-dp-side > .tk-sec', s => s.map(e => (e.querySelector('.tk-sec-hdr') || {}).textContent.trim().split(/\s/)[0]));
ok('Right pane: Notes, then Brochure, then Timeline', order.join() === 'Notes,Brochure,Timeline', JSON.stringify(order));
ok('Not started, Generate disabled until filled', /Not started/.test(await p.textContent('#bpSec')) && await p.$eval('#bpCheck .tk-btn.primary', b => b.disabled));
ok('The checklist names what is missing', /Property code/.test(await p.textContent('#bpCheck')) && /Photos link/.test(await p.textContent('#bpCheck')) && /Description/.test(await p.textContent('#bpCheck')));
await p.screenshot({ path: OUT + '/1-panel.png', fullPage: true });

section('Typing a code that already exists: suggest → duplicate → preview → link');
await typeCode('egm');
const sug = await p.$$eval('#bpSug.open .bp-opt b', b => b.map(x => x.textContent));
ok('Existing codes are suggested as you type', sug.join() === 'EGM0001,EGM0002', JSON.stringify(sug));
await typeCode('egm0001');
ok('"Duplicate code found" with the property named', /Duplicate code found/.test(await p.textContent('#bpVerdict')) && /Egmore 3BHK/.test(await p.textContent('#bpVerdict')));
ok('Generate stays off for an unlinked duplicate', await p.$eval('#bpCheck .tk-btn.primary', b => b.disabled) && /Link to EGM0001/.test(await p.textContent('#bpCheck')));
await p.click('#bpVerdict button:has-text("Preview property")');
ok('Preview opens with the property, its photos and brochure', await p.$eval('#bpPrev', e => e.classList.contains('open')) && /Egmore 3BHK/.test(await p.textContent('#bpPrev')) && !!(await p.$('#bpPrev a:has-text("Brochure")')));
await p.screenshot({ path: OUT + '/2-preview.png' });
await p.click('#bpPrev button:has-text("Link this listing to it")');
await p.waitForTimeout(300);
let s = await last('l1');
ok('Linked: code set on the listing', s && s.propertyCode === 'EGM0001');
ok('…photos, brochure and description filled from the dashboard', s.photosLink === INV[0].photosLink && s.brochureLink === INV[0].brochureLink && /1650 sqft/.test(s.description));
ok('…internal notes brought across', /call after 6pm/.test(s.internalNotes || ''));
ok('…hand-typed title kept', s.title === 'Egmore flat');
ok('…brochure already delivered → ticked done', !!(s.brochure && s.brochure.doneAt));
ok('…the listing stays in its column (the brochure is a signal, not a stage)', await stageKey('l1') === 'shoot_done');
ok('…and its tile shows Brochure ✓', /Brochure ✓/.test(await p.$eval('.tk-card[data-id="l1"]', c => c.textContent)));
ok('Preview closed after linking', !(await p.$eval('#bpPrev', e => e.classList.contains('open'))));

section('Locked once created: copy, not edit');
ok('Panel is locked: no inputs, Copy buttons', !!(await p.$('#bpSec.frozen')) && !(await p.$('#bpSec input[type=text], #bpSec textarea')) && (await p.$$('#bpSec .bp-copy')).length >= 4);
await p.click('#bpSec .bp-ro:has-text("Description") .bp-copy');
ok('Copy puts the text on the clipboard', /1650 sqft/.test(await p.evaluate(() => navigator.clipboard.readText())));
await p.click('#bpSec .bp-copyall');
const all = await p.evaluate(() => navigator.clipboard.readText());
ok('Copy all: code - title, photos, description, internal notes', /^EGM0001 - Egmore flat/.test(all) && /drive\.google\.com/.test(all) && /Internal notes:/.test(all), all.slice(0, 80));
await p.screenshot({ path: OUT + '/3-locked.png', fullPage: true });

section('Unlocking for a redo');
await p.uncheck('#bpSec .bp-done input');
await p.waitForTimeout(200);
s = await last('l1');
ok('Unlocked: fields editable again', !!(await p.$('#bpTitle')) && !(await p.$('#bpSec.frozen')) && s.brochure.unlockedLink === INV[0].brochureLink);
await p.evaluate(() => window.bpReconcile(true)); await p.waitForTimeout(300);
await openListing('l1');
ok('The old brochure does not lock it again', !(await p.$('#bpSec.frozen')));

section('A sheet code cannot run script through a button');
await openListing('l2');
await typeCode('xq1');
await p.click('#bpSug .bp-opt:has-text("XQ1")'); await p.waitForTimeout(150);
ok('Picking an odd code runs nothing; the code arrives as text', !(await p.evaluate(() => window.__pwned)) && await p.$eval('#bpCode', e => e.value) === "XQ1');window.__pwned=1;//");
await p.click('#bpVerdict button:has-text("Preview property")'); await p.waitForTimeout(150);
ok('…and Preview / Link for it run nothing either', !(await p.evaluate(() => window.__pwned)) && /Odd code from the sheet/.test(await p.textContent('#bpPrev')));
await p.evaluate(() => window.bpClosePreview());

section('Picking an existing code: saved as typed, never linked behind anyone\'s back');
await typeCode('egm');
await p.click('#bpSug .bp-opt:has-text("EGM0002")'); await p.waitForTimeout(150);
s = await last('l2');
ok('The picked code is saved on the listing', s && s.brochure && s.brochure.code === 'EGM0002' && !s.propertyCode, JSON.stringify(s && s.brochure));
await p.evaluate(() => window.bpReconcile(true)); await p.waitForTimeout(300);
s = await last('l2');
ok('The background check does not link it or copy that property in', !s.propertyCode && !s.photosLink && !s.brochureLink && !(s.brochure && s.brochure.doneAt));

section('The THVA0001 slip, and a code another listing uses');
await typeCode('THVA0001');
ok('"Did you mean THVA001?" with Preview and Link', /Did you mean THVA001/.test(await p.textContent('#bpVerdict')) && !!(await p.$('#bpVerdict button:has-text("Link to THVA001")')));
await typeCode('ADYR0001');
ok('A code another listing already uses is refused', /Already used on this board/.test(await p.textContent('#bpVerdict')) && /Plot, Adyar/.test(await p.textContent('#bpVerdict')) && await p.$eval('#bpCheck .tk-btn.primary', b => b.disabled));
await typeCode('12345');
ok('Not a code: says what codes look like', /letters, then numbers/.test(await p.textContent('#bpVerdict')));

section('A new property: fill, generate');
await typeCode('kotv0007');
await p.dispatchEvent('#bpCode', 'change');
ok('A new code is welcomed', /new code/.test(await p.textContent('#bpVerdict')));
s = await last('l2');
// Checked before any other field is saved: a later save writes the whole listing and would hide a lost code.
ok('Leaving the code box saves the typed code', s && s.brochure && s.brochure.code === 'KOTV0007', JSON.stringify(s && s.brochure));
await p.evaluate(() => window.openDetail('l2')); await p.waitForTimeout(150);
ok('…and it is still there after a redraw', await p.$eval('#bpCode', e => e.value) === 'KOTV0007');
await p.fill('#bpTitle', '4BHK Villa near ECR'); await p.dispatchEvent('#bpTitle', 'change');
ok('Still blocked without photos and description', await p.$eval('#bpCheck .tk-btn.primary', b => b.disabled));
await p.fill('#bpPhotos', 'https://drive.google.com/drive/folders/kotv'); await p.dispatchEvent('#bpPhotos', 'change');
await p.fill('#bpDesc', '4BHK villa, 2800 sqft, 400m from ECR. Price ₹3.4 Cr.'); await p.dispatchEvent('#bpDesc', 'change');
// Typed and NOT left: the click on Generate is what leaves the box (and saves it).
await p.fill('#bpInternal', 'Owner Suresh 9840022222');
ok('Ready: shows exactly what goes to the pipeline', /KOTV0007 - 4BHK Villa near ECR/.test(await p.textContent('#bpCheck')) && !(await p.$eval('#bpCheck .tk-btn.primary', b => b.disabled)));
await p.screenshot({ path: OUT + '/4-ready.png', fullPage: true });
let releaseForm;
formHold = new Promise(r => { releaseForm = r; });
await p.click('#bpCheck .tk-btn.primary');
await p.waitForTimeout(150);
const busy = await p.$eval('#bpCheck .tk-btn.primary', b => [b.disabled, b.textContent]);
ok('One click sends, even straight out of a box being typed in', formPosts.length === 1 && busy[0] && /Sending/.test(busy[1]), JSON.stringify([formPosts.length, busy]));
await p.evaluate(() => { window.bpGenerate('l2'); window.openDetail('l2'); });
await p.waitForTimeout(100);
ok('While sending: a second click is ignored, and a redraw keeps the button off', await p.$eval('#bpCheck .tk-btn.primary', b => b.disabled && /Sending/.test(b.textContent)));
releaseForm(); formHold = null;
await p.waitForTimeout(500);
ok('…so the form got it exactly once', formPosts.length === 1, formPosts.length);
const form = new URLSearchParams(formPosts[formPosts.length - 1] || '');
ok('Sent to the same Google Form as Create brochure', formPosts.length === 1 && form.get('entry.1238821452') === 'KOTV0007 - 4BHK Villa near ECR');
ok('…with photos, description and internal notes', form.get('entry.1785532374') === 'https://drive.google.com/drive/folders/kotv' && /2800 sqft/.test(form.get('entry.134248436')) && /Suresh/.test(form.get('entry.1764716931')));
ok('…and logged in Recent brochures', logPosts.length === 1 && /KOTV0007 - 4BHK Villa near ECR/.test(logPosts[0]));
s = await last('l2');
ok('Listing records the request', s.brochure.requestedAt && s.brochure.code === 'KOTV0007' && s.brochure.by === 'admin@3pin.in' && !s.propertyCode);
ok('Stays in Shoot done; the tile says Brochure requested', await stageKey('l2') === 'shoot_done' && /Brochure requested/.test(await p.$eval('.tk-card[data-id="l2"]', c => c.textContent)));
ok('Panel says it is waiting for the dashboard', /Requested — waiting/.test(await p.textContent('#bpSec')) && /Send again/.test(await p.textContent('#bpCheck')));

section('The property reaches the dashboard → links itself, ticks done, locks');
await p.evaluate(() => { window.__inv.push({ id: 'KOTV0007', propertyCode: 'KOTV0007', name: 'Villa near ECR', location: 'Kottivakkam', photosLink: 'https://drive.google.com/drive/folders/kotv', brochureLink: 'KOTV0007_villa.pdf', detailsText: '4BHK villa…' }); });
await p.evaluate(() => window.bpReconcile(true)); await p.waitForTimeout(300);
s = await last('l2');
ok('Built but not delivered: linked, not done yet', s.propertyCode === 'KOTV0007' && !s.brochure.doneAt);
await p.evaluate(() => { const q = window.__inv.find(x => x.propertyCode === 'KOTV0007'); q.brochureLink = 'https://drive.google.com/file/d/kotv-brochure'; });
await p.evaluate(() => window.bpReconcile(true)); await p.waitForTimeout(300);
s = await last('l2');
ok('Delivered: brochure link pulled in and ticked done', s.brochureLink === 'https://drive.google.com/file/d/kotv-brochure' && !!s.brochure.doneAt);
ok('…still in Shoot done, tile now Brochure ✓', await stageKey('l2') === 'shoot_done' && /Brochure ✓/.test(await p.$eval('.tk-card[data-id="l2"]', c => c.textContent)));

// Asked for three days ago and only delivered now (the Mac was off): still links on its own.
await p.evaluate(() => {
  window.__reads = 0;
  const get = window.trackFirebase.getInventory;
  window.trackFirebase.getInventory = async () => { window.__reads++; return JSON.parse(JSON.stringify(await get())); };
  window.applyListingsSnapshot([...window.trackApi.listings(), { id: 'late', tenantId: window.trackApi.listings()[0].tenantId, title: 'Late flat', stageId: window.trackApi.listings()[0].stageId, media: {}, brochure: { code: 'LATE0001', requestedCode: 'LATE0001', requestedAt: Date.now() - 3 * 86400000 }, createdAt: 1, updatedAt: 1, stageChangedAt: 1 }]);
  window.__inv.push({ id: 'LATE0001', propertyCode: 'LATE0001', name: 'Late flat', brochureLink: 'https://drive.google.com/file/d/late' });
});
await p.evaluate(() => window.bpReconcile(true)); await p.waitForTimeout(400);
const late = await p.evaluate(() => window.trackApi.listings().find(l => l.id === 'late'));
ok('A brochure delivered days later still links the listing and ticks it done (the dashboard is re-read)', late.propertyCode === 'LATE0001' && !!late.brochure.doneAt && await p.evaluate(() => window.__reads) >= 1, JSON.stringify({ pc: late.propertyCode, done: late.brochure.doneAt, reads: await p.evaluate(() => window.__reads) }));
await p.evaluate(() => window.applyListingsSnapshot(window.trackApi.listings().filter(l => l.id !== 'late'))); await p.waitForTimeout(150);
await p.evaluate(() => window.setBrochureFilter('created')); await p.waitForTimeout(150);
const createdCards = await p.$$eval('.tk-card', c => c.map(x => x.dataset.id));
ok('The Brochure filter shows only listings with a brochure', createdCards.length && createdCards.every(id => ['l1', 'l2'].includes(id)), JSON.stringify(createdCards));
await p.evaluate(() => window.setBrochureFilter('none')); await p.waitForTimeout(150);
const notStarted = await p.$$eval('.tk-card', c => c.map(x => x.dataset.id));
// l1 was unlocked for a redo and nothing has been asked for since, so it counts as not started again.
ok('…and Not started shows the rest', !notStarted.includes('l2') && notStarted.includes('l1'), JSON.stringify(notStarted));
await p.evaluate(() => window.setBrochureFilter('')); await p.waitForTimeout(100);
const cols = await p.$$eval('.tk-col-title', c => c.map(x => x.textContent.trim()));
ok('No Brochure queued / Brochure ready columns on the board', !cols.some(c => /Brochure/.test(c)), JSON.stringify(cols));
await openListing('l2');
ok('…and the panel is locked', !!(await p.$('#bpSec.frozen')));

section('New listing and Edit: the same code checks');
await p.evaluate(() => window.closeDetail && window.closeDetail());
await p.evaluate(() => window.openAddModal());
await p.fill('#mm_title', 'Egmore villa (owner wording)');
await p.fill('#mm_propertyCode', 'egm0002'); await p.dispatchEvent('#mm_propertyCode', 'input');
ok('Existing code: "Already in the dashboard"', /Already in the dashboard/.test(await p.textContent('#mmCodeHint')));
const before = await p.evaluate(() => window.__saved.length);
await p.click('#mModal .tk-btn.primary'); await p.waitForTimeout(400);
const created = (await p.evaluate(b => window.__saved.slice(b), before)).filter(x => x.title === 'Egmore villa (owner wording)').pop();
ok('Saved and linked to EGM0002, its photos filled', created && created.propertyCode === 'EGM0002' && created.photosLink === INV[1].photosLink);
await p.evaluate(() => window.closeDetail && window.closeDetail());
await p.evaluate(() => window.openAddModal());
await p.fill('#mm_title', 'Typo test');
await p.fill('#mm_propertyCode', 'ADYR0001'); await p.dispatchEvent('#mm_propertyCode', 'input');
await p.click('#mModal .tk-btn.primary'); await p.waitForTimeout(150);
ok('A code another listing uses is refused on save', /already used by “Plot, Adyar”/.test(await p.textContent('#mmErr')));
await p.fill('#mm_propertyCode', 'THVA0001'); await p.dispatchEvent('#mm_propertyCode', 'input');
ok('A near-miss offers the real code, one click to use it', /Did you mean THVA001/.test(await p.textContent('#mmCodeHint')) && !!(await p.$('#mmCodeHint button:has-text("Use THVA001")')));
await p.fill('#mm_propertyCode', 'NEWC0001'); await p.dispatchEvent('#mm_propertyCode', 'input');
const b2 = await p.evaluate(() => window.__saved.length);
await p.click('#mModal .tk-btn.primary'); await p.waitForTimeout(300);
const nc = (await p.evaluate(b => window.__saved.slice(b), b2)).filter(x => x.title === 'Typo test').pop();
ok('A new code is kept for the brochure, not as a dashboard link', nc && !nc.propertyCode && nc.brochure && nc.brochure.code === 'NEWC0001');
await openListing(nc.id);
ok('…and shows in the brochure panel', await p.$eval('#bpCode', e => e.value) === 'NEWC0001');

section('Edit keeps the links it should, and drops the one cleared');
const editSave = async (id, fields) => {
  await p.evaluate(() => window.closeDetail && window.closeDetail());
  await p.evaluate(i => window.openEditModal(i), id);
  for (const [k, v] of Object.entries(fields)) await p.fill('#mm_' + k, v);
  await p.dispatchEvent('#mm_propertyCode', 'input');
  await p.click('#mModal .tk-btn.primary'); await p.waitForTimeout(300);
  return (await p.textContent('#mmErr')).trim();
};
let err = await editSave(created.id, { title: 'Egmore villa (renamed)' });
s = await last(created.id);
ok('Two listings on one property: either can still be edited', !err && s.title === 'Egmore villa (renamed)' && s.propertyCode === 'EGM0002', err || JSON.stringify(s.propertyCode));
err = await editSave('l4', { title: 'Old flat (renamed)' });
s = await last('l4');
ok('An older property with a bare-number id keeps its link through an edit', !err && s.title === 'Old flat (renamed)' && s.propertyCode === '123', err || JSON.stringify([s.propertyCode, s.brochure]));
err = await editSave('l5', { propertyCode: '' });
s = await last('l5');
ok('Box emptied: unlinked', !err && !s.propertyCode, err || JSON.stringify(s.propertyCode));
await p.evaluate(() => window.bpReconcile(true)); await p.waitForTimeout(300);
s = await last('l5');
ok('…and the background check does not link it straight back', !s.propertyCode && !(s.brochure && s.brochure.code), JSON.stringify(s.brochure));

section('Mapping through the shared path still brings the same details');
await openListing('l3');
await p.evaluate(() => window.openMapProperty('l3')); await p.waitForTimeout(200);
await p.click('#mapList .tk-pick:has-text("EGM0001")'); await p.waitForTimeout(400);
s = await last('l3');
ok('Mapping fills description and internal notes too', s.propertyCode === 'EGM0001' && /1650 sqft/.test(s.description) && /call after 6pm/.test(s.internalNotes));
await p.close();

section('On a phone');
const ph = await open({ width: 390, height: 844 });
await ph.evaluate(() => window.openDetail('l2')); await ph.waitForSelector('#bpSec'); await ph.waitForTimeout(200);
const wide = await ph.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok('Listing with the brochure panel does not scroll sideways', wide <= 2, wide);
section('No hand-mapping on the board');
const um = await ph.evaluate(() => ({ t: /Map to a property|Change mapping/.test(document.body.innerText), b: !!document.querySelector('[onclick*="openMapProperty"]'), h: /maps from the customer conversation/i.test(document.body.innerText) }));
ok('An unmapped listing has no Map button, and says where mapping comes from', !um.t && !um.b && um.h, JSON.stringify(um));
await ph.evaluate(() => window.openDetail('l5')); await ph.waitForTimeout(200);
ok('A mapped listing has no Change button either', await ph.evaluate(() => !document.querySelector('[onclick*="openMapProperty"]')));
await ph.screenshot({ path: OUT + '/5-phone.png', fullPage: true });
await ph.close();

await browser.close();
console.log(problems.length ? `\n${problems.length} problem(s):\n - ` + problems.join('\n - ') : '\nAll good.');
process.exit(problems.length ? 1 : 0);
