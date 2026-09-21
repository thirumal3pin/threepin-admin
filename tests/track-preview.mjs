// ═══════ PROPERTY & MEDIA TRACK — PREVIEW / SMOKE TEST ═══════
//
// Opens the real propertytrack.html in Chromium with track-assets/firebase-sync.js
// swapped for an in-memory stand-in, on the real stage definitions, with listings in
// every situation the board has to draw: a late card, a shoot booked for today, a
// missed shoot, an unmapped listing, a dropped one — plus seller leads that have no
// listing card, which is the gap this board exists to close.
//
// Checks the columns, the cards, both list views, the detail panel, the shoot
// booking flow, property mapping and stage moves; screenshots each at desktop and
// phone width.
//
//   node tests/track-preview.mjs <out-dir>

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStages } from '../track-assets/track-pipeline.js';

const OUT = process.argv[2] || 'tests/out/track';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.now();
const H = 3600000, D = 24 * H;
const T = 't_3pinrealty';
const STAGES = defaultStages();
const sid = key => STAGES.find(s => s.key === key).id;

const LISTINGS = [
  { id: 'l1', tenantId: T, title: '3BHK in Nungambakkam', propertyCode: 'TNAG0002', location: 'Nungambakkam',
    config: '3 BHK', askingPrice: '₹2.1 Cr', sellerName: 'Meenakshi', sellerPhone: '9840011111', leadId: 'sd1',
    stageId: sid('shoot_scheduled'), shootAt: NOW + 3 * H, shootAssignee: 'Ravi', ownerInformed: true,
    media: {}, stageChangedAt: NOW - 2 * D, createdAt: NOW - 5 * D, updatedAt: NOW - H },
  { id: 'l2', tenantId: T, title: 'Villa, Kottivakkam', propertyCode: '', location: 'Kottivakkam',
    sellerName: 'Suresh', sellerPhone: '9840022222', stageId: sid('details'),
    media: {}, stageChangedAt: NOW - 9 * D, createdAt: NOW - 9 * D, updatedAt: NOW - 3 * D },   // late: target 3d
  { id: 'l3', tenantId: T, title: '2BHK Velachery', propertyCode: 'VLCA002', location: 'Velachery',
    sellerName: 'Lakshmi', stageId: sid('shoot_done'), shootAt: NOW - 2 * D, shootAssignee: 'Ravi',
    media: { photos: true, floorPlan: true }, ownerInformed: true, ownerApproved: true,
    stageChangedAt: NOW - D, createdAt: NOW - 12 * D, updatedAt: NOW - D },
  { id: 'l4', tenantId: T, title: 'Plot, Kelambakkam', propertyCode: '', sellerName: 'Anand',
    stageId: sid('shoot_scheduled'), shootAt: NOW - 4 * D, media: {},                            // missed shoot
    stageChangedAt: NOW - 6 * D, createdAt: NOW - 8 * D, updatedAt: NOW - 4 * D },
  { id: 'l5', tenantId: T, title: 'Flat, Adyar', propertyCode: 'ADY001', stageId: sid('live'),
    media: { photos: true, video: true }, brochureLink: 'https://example.com/b.pdf',
    stageChangedAt: NOW - 3 * D, createdAt: NOW - 30 * D, updatedAt: NOW - 3 * D },
  { id: 'l6', tenantId: T, title: 'Old listing', stageId: sid('dropped'), dropReason: 'price_unrealistic',
    media: {}, stageChangedAt: NOW - 20 * D, createdAt: NOW - 40 * D, updatedAt: NOW - 20 * D }
];

// Two of these are sellers with NO listing card — they must show up under "Sellers to list".
const LEADS = [
  { id: 'sd1', tenantId: T, name: 'Meenakshi', phone: '9840011111', enquiryType: 'Seller Listing',
    propertyInterest: 'Nungambakkam', createdAt: NOW - 6 * D },
  { id: 'sd2', tenantId: T, name: 'Gopal', phone: '9840033333', enquiryType: 'Seller Listing',
    propertyInterest: 'Adambakkam 2BHK', budget: '85 L', createdAt: NOW - 2 * D },
  { id: 'sd3', tenantId: T, name: 'Priya', phone: '9840044444', enquiryType: 'Property Enquiry',
    propertyInterest: 'T Nagar', createdAt: NOW - D,
    ai: { intent: 'rent_out', line: 'Owner wants to give out her flat on rent' } },   // AI-only seller
  { id: 'b1', tenantId: T, name: 'Karthik (buyer)', phone: '9840055555', enquiryType: 'Property Enquiry',
    propertyInterest: 'Velachery', createdAt: NOW - 3 * D }
];

const INVENTORY = [
  { id: 'TNAG0002', propertyCode: 'TNAG0002', name: '2BHK Apartment T Nagar', location: 'T Nagar', config: '2 BHK', startingPrice: '₹2.25 Cr' },
  { id: 'VLCA002', propertyCode: 'VLCA002', name: 'Velachery 3BHK', location: 'Velachery', config: '3 BHK', startingPrice: '₹1.4 Cr' },
  { id: 'NOL001', propertyCode: 'NOL001', name: '4BHK Individual house', location: 'Nolambur', config: '4 BHK', startingPrice: '₹3 Cr' }
];

const STUB = `
window.__saved = []; window.__deleted = []; window.__history = [];
window.trackFirebase = {
  saveListing: async l => { window.__saved.push(JSON.parse(JSON.stringify(l))); },
  deleteListing: async id => { window.__deleted.push(id); },
  savePipeline: async () => {},
  getInventory: async () => ${JSON.stringify(INVENTORY)},
  getListingHistory: async () => window.__history.slice().reverse(),
  saveHistory: async (id, e) => { window.__history.push({ ...e, listingId: id }); }
};
window.trackAuth = { login: async () => {}, logout: async () => {}, getTenantId: () => '${T}' };
setTimeout(() => {
  window.onTrackAuthChange({ email: 'agent.a@example.com' }, '${T}');
  window.applyTrackPipelineSnapshot(${JSON.stringify(STAGES)});
  window.applyListingsSnapshot(${JSON.stringify(LISTINGS)});
  window.applyTrackLeadsSnapshot(${JSON.stringify(LEADS)});
  window.__ready = true;
}, 0);
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const browser = await chromium.launch();
const errors = [];
const ok = (label, cond, detail) => { if (cond) console.log('  ok  ' + label); else errors.push(label + (detail !== undefined ? ' — ' + detail : '')); };

async function open(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${viewport.width}px: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`${viewport.width}px console: ${m.text()}`); });
  page.on('dialog', d => d.accept());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'track.local') return route.abort();
    if (url.pathname === '/track-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://track.local/propertytrack.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.waitForTimeout(250);
  return page;
}

const text = (page, sel) => page.$$eval(sel, els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));

// ── Desktop ──
console.log('Property & Media Track — the board');
const page = await open({ width: 1440, height: 950 });
const shot = async (name) => { await page.waitForTimeout(180); await page.screenshot({ path: `${OUT}/desk-${name}.png`, fullPage: true }); };

const cols = await text(page, '.tk-col-title');
ok('Ten columns, in pipeline order', cols.length === 10 && cols[0] === 'New listing' && cols[9] === 'Dropped', JSON.stringify(cols));
ok('Every column states its rule', (await page.$$('.tk-col-rule')).length === 10);
ok('A card sits in its stage', (await text(page, '.tk-col:nth-child(2) .tk-card-title'))[0] === 'Villa, Kottivakkam');
ok('A listing past its stage target is marked late', (await page.$$('.tk-card.late')).length >= 1);
ok('An unmapped listing says so', (await text(page, '.tk-code.none')).includes('unmapped'));
ok('A mapped listing shows its Property ID', (await text(page, '.tk-code')).includes('TNAG0002'));
ok('A booked shoot shows on the card', (await text(page, '.tk-card-row')).some(t => t.includes('📸')));
ok('Sellers-to-list badge counts the gap, not every seller',
  (await text(page, '.rl-badge')).includes('2'), JSON.stringify(await text(page, '.rl-badge')));
await shot('board');

// ── Stage move ──
await page.evaluate(() => changeStage('l2', 'shoot_scheduled'));
await page.waitForTimeout(200);
const saved = await page.evaluate(() => window.__saved.map(s => [s.id, s.stageId]));
ok('Dragging a card to another column saves the move', saved.some(([id, st]) => id === 'l2' && st === 'shoot_scheduled'), JSON.stringify(saved));
ok('…and records it on the timeline', (await page.evaluate(() => window.__history.map(h => h.text))).some(t => /Moved from/.test(t)));

// ── A stage needing a reason must ask first ──
await page.evaluate(() => changeStage('l1', 'dropped'));
await page.waitForTimeout(200);
ok('Dropping a listing asks why before it moves', await page.$eval('#rsModal', e => e.classList.contains('open')));
const movedEarly = await page.evaluate(() => window.__saved.some(s => s.id === 'l1' && s.stageId === 'dropped'));
ok('…and does not move it until answered', !movedEarly);
await page.selectOption('#rsReason', 'price_unrealistic');
await page.click('#rsModal .tk-btn.primary');
await page.waitForTimeout(200);
ok('…then saves the move with its reason',
  await page.evaluate(() => window.__saved.some(s => s.id === 'l1' && s.stageId === 'dropped' && s.dropReason === 'price_unrealistic')));

// ── Detail panel ──
await page.evaluate(() => openDetail('l3'));
await page.waitForTimeout(250);
ok('The detail panel opens', await page.$eval('#dp', e => e.classList.contains('open')));
const body = (await text(page, '#dpBody'))[0];
ok('…showing the owner', /Lakshmi/.test(body));
ok('…the media checklist', /Media checklist/.test(body) && /Floor plan/.test(body));
ok('…the shoot section', /Shoot/.test(body));
ok('…and the deliverables', /Deliverables/.test(body));
await shot('detail');

// Ticking a media item writes it through.
await page.evaluate(() => setMedia('l3', 'video', true));
await page.waitForTimeout(150);
ok('Ticking a media item saves it', await page.evaluate(() => window.__saved.some(s => s.id === 'l3' && s.media && s.media.video === true)));

// ── Property mapping ──
await page.evaluate(() => openMapProperty('l2'));
await page.waitForTimeout(350);
ok('The property picker lists the inventory', (await page.$$('.tk-pick')).length >= 3);
await page.fill('#mapSearch', 'NOL');
await page.waitForTimeout(150);
ok('…and filters as you type', (await page.$$('.tk-pick')).length === 1);
await shot('map');
await page.click('.tk-pick');
await page.waitForTimeout(200);
const mapped = await page.evaluate(() => window.__saved.filter(s => s.id === 'l2').pop());
ok('Picking a property maps it', mapped.propertyCode === 'NOL001', mapped.propertyCode);
// The inventory is the source of truth, but a detail already typed on the card is
// someone's own work — mapping fills the blanks and never overwrites what is there.
ok('…filling blanks without clobbering what was typed by hand',
  mapped.location === 'Kottivakkam' && mapped.config === '4 BHK',
  JSON.stringify({ location: mapped.location, config: mapped.config }));

// ── Booking a shoot ──
await page.evaluate(() => { closeDetail(); openShootModal('l2'); });
await page.waitForTimeout(200);
await page.fill('#shDate', new Date(NOW + 2 * D).toISOString().slice(0, 10));
await page.fill('#shWho', 'Ravi');
await page.click('#shModal .tk-btn.primary');
await page.waitForTimeout(250);
const l2 = await page.evaluate(() => window.__saved.filter(s => s.id === 'l2').pop());
ok('Booking a shoot saves the date and who', !!l2.shootAt && l2.shootAssignee === 'Ravi');
ok('…and moves the listing into Shoot scheduled on its own', l2.stageId === 'shoot_scheduled', l2.stageId);

// ── Shoots view ──
await page.evaluate(() => toggleView('shoots'));
await page.waitForTimeout(250);
const shoots = (await text(page, '#shootsView'))[0];
ok('The shoots view separates missed from upcoming', /Missed/.test(shoots) && /Coming up/.test(shoots), shoots.slice(0, 160));
ok('…and flags an owner who has not been told', /owner not informed/.test(shoots));
await shot('shoots');

// ── Sellers view ──
await page.evaluate(() => toggleView('sellers'));
await page.waitForTimeout(250);
const sellers = (await text(page, '#sellersView'))[0];
ok('Sellers with no listing are listed', /Gopal/.test(sellers) && /Priya/.test(sellers), sellers.slice(0, 200));
ok('…including one only the AI read as an owner', /renting out/.test(sellers));
ok('…and a seller already on the board is not repeated', !/Meenakshi/.test(sellers));
ok('…and a buyer is never listed', !/Karthik/.test(sellers));
await shot('sellers');

// Creating a listing from a seller lead.
await page.evaluate(() => createFromLead('sd2'));
await page.waitForTimeout(250);
const created = await page.evaluate(() => window.__saved.filter(s => s.leadId === 'sd2').pop());
ok('Creating a listing from a seller carries their details over',
  !!created && created.sellerName === 'Gopal' && created.sellerPhone === '9840033333' && created.askingPrice === '85 L');
await page.evaluate(() => { closeDetail(); toggleView('sellers'); });
await page.waitForTimeout(250);
ok('…and they leave the list once tracked', !/Gopal/.test((await text(page, '#sellersView'))[0]));

// ── Phone ──
const phone = await open({ width: 390, height: 844 });
await phone.waitForTimeout(250);
await phone.screenshot({ path: `${OUT}/phone-board.png`, fullPage: true });
const wide = await phone.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
ok('The phone board does not scroll the page sideways', !wide);
await phone.evaluate(() => openDetail('l1'));
await phone.waitForTimeout(250);
await phone.screenshot({ path: `${OUT}/phone-detail.png`, fullPage: true });
ok('The phone detail panel does not scroll sideways',
  !(await phone.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)));

await browser.close();
if (errors.length) { console.log('\nERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('\nNo page errors. Screenshots in ' + OUT);
