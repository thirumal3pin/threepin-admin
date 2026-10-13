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
    stageId: sid('shoot_scheduled'), shootAt: NOW + Math.min(3 * H, Math.floor((new Date(NOW).setHours(23, 59, 0, 0) - NOW) / 2)), shootAssignee: 'Ravi', ownerInformed: true,   // later today, whatever the hour
    address: 'Flat 3B, Sai Apartments, 12 Wallace Garden 2nd St, Nungambakkam',
    siteContact: '9840011111', occupancy: 'tenant', bestTime: 'Morning light', accessNotes: 'Gate code 4417',
    need: { photos: true, floorPlan: true, video: true },
    media: {}, stageChangedAt: NOW - 2 * D, createdAt: NOW - 5 * D, updatedAt: NOW - H, updatedBy: 'agent.a@example.com' },
  { id: 'l2', tenantId: T, title: 'Villa, Kottivakkam', propertyCode: '', location: 'Kottivakkam',
    sellerName: 'Suresh', sellerPhone: '9840022222', stageId: sid('details'),
    media: {}, stageChangedAt: NOW - 9 * D, createdAt: NOW - 9 * D, updatedAt: NOW - 3 * D },   // late: target 3d
  { id: 'l3', tenantId: T, title: '2BHK Velachery', propertyCode: 'VLCA002', location: 'Velachery',
    sellerName: 'Lakshmi', stageId: sid('shoot_done'), shootAt: NOW - 2 * D, shootAssignee: 'Ravi',
    media: { photos: true, floorPlan: true }, ownerInformed: true, ownerApproved: true, remarks: 'Owner prefers calls after 6pm',
    stageChangedAt: NOW - D, createdAt: NOW - 12 * D, updatedAt: NOW - D },
  { id: 'l4', tenantId: T, title: 'Plot, Kelambakkam', propertyCode: '', sellerName: 'Anand',
    stageId: sid('shoot_scheduled'), shootAt: NOW - 4 * D, media: {},                            // missed shoot
    stageChangedAt: NOW - 6 * D, createdAt: NOW - 8 * D, updatedAt: NOW - 4 * D },
  // Deliberately unmapped at a stage that cannot proceed without it.
  { id: 'l5', tenantId: T, title: 'Flat, Adyar', propertyCode: '', stageId: sid('live'),
    media: { photos: true, video: true }, brochureLink: 'https://example.com/b.pdf',
    stageChangedAt: NOW - 3 * D, createdAt: NOW - 30 * D, updatedAt: NOW - 3 * D },
  { id: 'l6', tenantId: T, title: 'Old listing', stageId: sid('dropped'), dropReason: 'price_unrealistic',
    media: {}, stageChangedAt: NOW - 20 * D, createdAt: NOW - 40 * D, updatedAt: NOW - 20 * D }
];

// Two of these are sellers with NO listing card — they must show up under "Sellers to list".
const LEADS = [
  { id: 'sd1', tenantId: T, name: 'Meenakshi', phone: '9840011111', enquiryType: 'Seller Listing',
    propertyInterest: 'Nungambakkam', createdAt: NOW - 6 * D,
    assignedAgent: 'agent.a@example.com', secondaryAgent: 'agent.b@example.com' },
  { id: 'sd2', tenantId: T, name: 'Gopal', phone: '9840033333', enquiryType: 'Seller Listing',
    propertyInterest: 'Adambakkam 2BHK', budget: '85 L', createdAt: NOW - 2 * D },
  { id: 'sd3', tenantId: T, name: 'Priya', phone: '9840044444', enquiryType: 'Property Enquiry',
    propertyInterest: 'T Nagar', createdAt: NOW - D,
    ai: { intent: 'rent_out', confidence: 'high', line: 'Owner wants to give out her flat on rent' } },   // AI-only seller
  { id: 'b1', tenantId: T, name: 'Karthik (buyer)', phone: '9840055555', enquiryType: 'Property Enquiry',
    propertyInterest: 'Velachery', createdAt: NOW - 3 * D },
  // Deliberately set aside — must never be given a card by the reconcile.
  { id: 'sd4', tenantId: T, name: 'Ravi (set aside)', phone: '9840066666', enquiryType: 'Seller Listing',
    propertyInterest: 'Porur', listingSkipped: true, createdAt: NOW - 5 * D }
];

// The live inventory is ~132 properties and the picker used to cap at 60, so
// two thirds were invisible to anyone scrolling rather than searching. The
// fixture is deliberately larger than that old cap, and includes the legacy
// records that carry a numeric document id instead of a Property_ID.
const INVENTORY = [
  { id: 'TNAG0002', propertyCode: 'TNAG0002', name: '2BHK Apartment T Nagar', location: 'T Nagar', config: '2 BHK', startingPrice: '₹2.25 Cr' },
  { id: 'VLCA002', propertyCode: 'VLCA002', name: 'Velachery 3BHK', location: 'Velachery', config: '3 BHK', startingPrice: '₹1.4 Cr' },
  { id: 'NOL001', propertyCode: 'NOL001', name: '4BHK Individual house', location: 'Nolambur', config: '4 BHK', startingPrice: '₹3 Cr' },
  ...Array.from({ length: 70 }, (_, i) => ({
    id: 'FILL' + String(i).padStart(3, '0'), propertyCode: 'FILL' + String(i).padStart(3, '0'),
    name: 'Filler property ' + i, location: 'Chennai', config: '2 BHK', startingPrice: '₹1 Cr'
  })),
  { id: '7', propertyCode: '', name: 'Older listing with no Property_ID', location: 'Adyar' }
];

const STUB = `
window.__saved = []; window.__deleted = []; window.__history = []; window.__leadPatches = [];
window.trackFirebase = {
  saveListing: async l => { window.__saved.push(JSON.parse(JSON.stringify(l))); },
  deleteListing: async id => { window.__deleted.push(id); },
  savePipeline: async () => {},
  patchLead: async (id, patch) => { window.__leadPatches.push({ id, patch }); },
  getLeadConversation: async id => id === 'sd1' ? {
    profile: {
      requirement_details: 'Owner selling a 3BHK, 1450 sqft, 4th floor, north facing',
      preferred_location: 'Nungambakkam, near the railway station',
      budget_and_finance: 'Expecting 2.1 Cr, some room to negotiate',
      properties_discussed: 'TNAG0002',
      chat_summary: 'Owner wants to list; asked what photos we need.'
    },
    chat: [
      { role: 'user', content: 'I want to sell my flat in Nungambakkam', at: 1 },
      { role: 'assistant', content: 'Happy to help — can we send a photographer?', at: 2 },
      { role: 'user', content: 'Yes, weekend works', at: 3 }
    ]
  } : null,
  getInventory: async () => ${JSON.stringify(INVENTORY)},
  getListingHistory: async () => window.__history.slice().reverse(),
  saveHistory: async (id, e) => { window.__history.push({ ...e, listingId: id }); },
  deleteHistory: async (id, eid) => { window.__history = window.__history.filter(h => !(h.listingId === id && h.id === eid)); }
};
window.trackAuth = { login: async () => {}, logout: async () => {}, getTenantId: () => '${T}' };
setTimeout(() => {
  window.onTrackAuthChange({ email: 'agent.a@example.com' }, '${T}');
  window.applyTrackPipelineSnapshot(${JSON.stringify(STAGES)});
  window.applyListingsSnapshot(${JSON.stringify(LISTINGS)}, window.__fromCache ? false : undefined);
  window.applyTrackLeadsSnapshot(${JSON.stringify(LEADS)});
  window.__ready = true;
}, 0);
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const browser = await chromium.launch();
const errors = [];
const ok = (label, cond, detail) => { if (cond) console.log('  ok  ' + label); else errors.push(label + (detail !== undefined ? ' — ' + detail : '')); };

async function open(viewport, seedStorage) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  if (seedStorage) await ctx.addInitScript(seedStorage);
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
// The owner is in the panel, not on the compact card: a card names it in its label ("…, owner Meenakshi").
const owners = (page, sel) => page.$$eval(sel, els => els.map(e => ((e.getAttribute('aria-label') || '').match(/, owner (.+)$/) || [])[1] || ''));

// ── Desktop ──
console.log('Property & Media Track — the board');
const page = await open({ width: 1440, height: 950 });
// The board scrolls sideways inside itself; a full-page capture of it renders shifted, so it is shot at the viewport.
const shot = async (name) => { await page.waitForTimeout(180); await page.screenshot({ path: `${OUT}/desk-${name}.png`, fullPage: name !== 'board' }); };

const cols = await text(page, '.tk-col-title');
ok('Nine columns, in pipeline order — Media ready after Shoot done, no brochure columns', cols.length === 9 && cols[0] === 'New listing' && cols[3] === 'Shoot done' && cols[4] === 'Media ready' && cols[8] === 'Dropped' && !cols.some(c => /Brochure/.test(c)), JSON.stringify(cols));
ok('Every column states its rule', (await page.$$('.tk-col-rule')).length === 9);
ok('A card sits in its stage', (await owners(page, '.tk-col:nth-child(2) .tk-card'))[0] === 'Suresh');
// The card is compact: the property, one quiet line, the next thing, a footer. The owner and their
// number are in the panel; call and WhatsApp show on hover.
const meena = await page.evaluate(() => {
  const c = [...document.querySelectorAll('.tk-card')].find(e => /owner Meenakshi/.test(e.getAttribute('aria-label') || ''));
  const t = s => (c.querySelector(s) || {}).textContent || '';
  return { prop: t('.tk-pname'), all: c.textContent.replace(/\s+/g, ' '), meta: t('.tk-meta1'), tel: !!c.querySelector('.tk-qa[href^="tel:"]'), wa: !!c.querySelector('.tk-qa[href*="wa.me"]'),
    av: [...c.querySelectorAll('.tk-av')].map(e => e.getAttribute('title')), age: t('.tk-age-pill'), ageTitle: (c.querySelector('.tk-age-pill') || {}).title || '' };
});
ok('Card: the property name, no phone numbers or owner on the card', !!meena.prop.trim() && !/9840011111|Meenakshi/.test(meena.all), JSON.stringify(meena));
ok('Card: call and WhatsApp on hover', meena.tel && meena.wa, JSON.stringify(meena));

// Renamed right on the card: Enter saves (with a timeline line), Escape leaves it as it was, and
// clicking into the box does not open the listing or start a drag.
{
  const sel = '.tk-card[aria-label*="owner Meenakshi"]';
  await page.click(sel + ' .tk-pname-ed');
  await page.click(sel + ' .tk-pname-in');
  const opened = await page.evaluate(() => !!document.querySelector('.tk-dp.open, #dp.open, .tk-detail.open'));
  await page.fill(sel + ' .tk-pname-in', '3BHK Apartment, Nungambakkam');
  await page.keyboard.press('Enter'); await page.waitForTimeout(150);
  const renamed = await page.evaluate(() => { const l = window.trackApi.listings().find(x => (x.sellerName || '') === 'Meenakshi' || /Nungambakkam/.test(x.title || '')); return l && l.title; });
  ok('Rename on the card: Enter saves the property name', renamed === '3BHK Apartment, Nungambakkam' && /3BHK Apartment, Nungambakkam/.test(await page.textContent(sel + ' .tk-pname')), renamed);
  ok('…clicking into the box does not open the listing', !opened);
  await page.click(sel + ' .tk-pname-ed');
  await page.fill(sel + ' .tk-pname-in', 'Something else');
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  ok('…Escape leaves it as it was', /3BHK Apartment, Nungambakkam/.test(await page.textContent(sel + ' .tk-pname')) && !(await page.$(sel + ' .tk-pname-in')));
  const tag = await page.evaluate(() => { const t = document.querySelector('.tk-card .tk-tag'); if (!t) return null; const cs = getComputedStyle(t); return { clip: cs.clipPath, hole: getComputedStyle(t, '::before').content }; });
  ok('Tags look like tags: pointed end with a hole', !tag || (/polygon/.test(tag.clip) && tag.hole !== 'none'), JSON.stringify(tag));

  // A long property name (or one long word) must never widen its column: every column is the same width.
  const keptTitles = await page.evaluate(() => window.trackApi.listings().slice(0, 2).map(l => [l.id, l.title]));
  await page.evaluate(() => { const ls = window.trackApi.listings(); window.trackApi.mutate(ls[0].id, l => { l.title = '2 Grounds for sale in Shenoy nagar with individual house, corner plot, east facing'; }, null); window.trackApi.mutate(ls[1].id, l => { l.title = 'AVERYLONGPROPERTYNAMEWITHNOSPACESATALLTHATWOULDPUSHTHECOLUMN'; }, null); });
  await page.waitForTimeout(200);
  const widths = await page.evaluate(() => [...document.querySelectorAll('.tk-col')].map(c => Math.round(c.getBoundingClientRect().width)));
  ok('Every board column is the same width, whatever the names in it', widths.length > 3 && new Set(widths).size === 1, JSON.stringify(widths));
  const clamp = await page.evaluate(() => { const t = [...document.querySelectorAll('.tk-pname-t')].find(e => /Shenoy/.test(e.textContent)); return t && { h: t.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(t).lineHeight) }; });
  ok('…a long name wraps to at most two lines', clamp && clamp.h <= clamp.lh * 2 + 2, JSON.stringify(clamp));
  await page.screenshot({ path: 'tests/out/board-even.png' });
  await page.evaluate(k => k.forEach(([id, t]) => window.trackApi.mutate(id, l => { l.title = t; }, null)), keptTitles);
  await page.waitForTimeout(150);}ok('Card: one quiet line — configuration · price (the area is in the name already, not said twice)', /^3 BHK · Sale ₹2\.1 Cr$/.test(meena.meta), meena.meta);
{
  // A name that does not say the area: the quiet line starts with it.
  const kept = await page.evaluate(() => { const l = window.trackApi.listings().find(x => (x.sellerName || '') === 'Meenakshi'); const t = l.title; window.trackApi.mutate(l.id, y => { y.title = 'Sea-facing flat'; }, null); return [l.id, t]; });
  await page.waitForTimeout(150);
  const m2 = await page.$eval(`.tk-card[data-id="${kept[0]}"] .tk-meta1`, e => e.textContent).catch(() => '');
  ok('…a card whose name does not say its area shows the area first', /^Nungambakkam · 3 BHK · Sale ₹2\.1 Cr$/.test(m2), m2);
  await page.evaluate(k => window.trackApi.mutate(k[0], y => { y.title = k[1]; }, null), kept); await page.waitForTimeout(100);
}
ok('Card: the assigned agents, as initials', meena.av.join() === 'Agent: Agent.a,Agent: Agent.b', JSON.stringify(meena.av));
ok('Card: last updated, and by whom — on the days pill', /Updated 1h ago by Agent\.a/.test(meena.ageTitle), meena.ageTitle);
ok('Card: days in this column', /2d here/.test(meena.age), meena.age);
ok('A card with no agent has no initials', await page.evaluate(() => [...document.querySelectorAll('.tk-card')].some(c => !c.querySelector('.tk-av'))));
ok('A card with no owner keeps its title', await page.evaluate(() => [...document.querySelectorAll('.tk-card .tk-pname-t')].some(e => e.textContent === 'Flat, Adyar')));
ok('A listing past its stage target is marked late', (await page.$$('.tk-card.late')).length >= 1);
// Unmapped is normal early on and only matters once a stage needs it, so the
// chip is silent on a new listing and loud on one at the brochure stages.
ok('An unmapped listing is not nagged about while that is normal',
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.tk-card')].find(c => /Kottivakkam/.test(c.textContent));
    return card && !/unmapped/.test(card.textContent);
  }));
ok('…but says so once the stage cannot proceed without it',
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.tk-card')].find(c => /Flat, Adyar/.test(c.textContent));
    return card && /unmapped/.test(card.textContent);
  }));
ok('A mapped listing shows its Property ID', (await text(page, '.tk-code')).includes('TNAG0002'));
ok('A booked shoot shows on the card', (await text(page, '.tk-card-row')).some(t => t.includes('📸')));
// The badge counts sellers still WAITING for a card. With the live sync
// running that should settle at zero, and a zero badge renders nothing — so a
// badge appearing here means the sync has stopped keeping up, which is
// exactly what it is now for.
ok('The sellers badge settles at nothing once the sync has caught up',
  !(await text(page, '.rl-badge')).length, JSON.stringify(await text(page, '.rl-badge')));
const deskWide = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sx: window.scrollX,
  culprits: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > document.documentElement.clientWidth + 2 && !e.closest('.tk-board')).slice(0, 5).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)) }));
ok('The desktop board does not scroll the page sideways (the board scrolls inside itself)', deskWide.sw <= deskWide.cw + 2 && deskWide.sx === 0, JSON.stringify(deskWide));
// Stage and Agent are multi-select dropdowns, Sort is one select, all on one line with Board/List.
const bar = await page.evaluate(() => {
  const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { t: Math.round(b.top), l: Math.round(b.left), r: Math.round(b.right) }; };
  return { stage: r('#ddStage'), agent: r('#ddAgent'), sort: r('.tk-dd-sort'), tog: r('#tkModeTog'), chips: document.querySelectorAll('.tk-chip').length,
    opts: [...document.querySelectorAll('.tk-dd-sort option')].map(o => o.textContent) };
});
ok('The filter bar is Stage, Agent and Sort dropdowns — no row of chips running off the edge',
  bar.stage && bar.agent && bar.sort && !bar.chips && bar.sort.r < bar.tog.l && Math.abs(bar.stage.t - bar.tog.t) <= 4, JSON.stringify(bar));
ok('…and Sort offers every order', ['Needs attention', 'Newest first', 'Oldest first', 'Last updated', 'Last message', 'Price: high to low', 'Price: low to high', 'Size: largest first', 'Name A–Z'].every(o => bar.opts.includes(o)), JSON.stringify(bar.opts));
await page.click('#ddStage summary');
await page.click('#ddStage .tk-dd-row:has-text("Shoot scheduled") input');
await page.waitForTimeout(150);
await page.click('#ddStage .tk-dd-row:has-text("Shoot done") input');
await page.waitForTimeout(150);
const picked = await page.evaluate(() => ({ cols: [...document.querySelectorAll('.tk-col-title')].map(e => e.textContent), open: !!document.querySelector('#ddStage[open]'), v: document.querySelector('#ddStage .tk-dd-v').textContent }));
await page.screenshot({ path: `${OUT}/desk-filter-open.png` });
ok('Ticking two stages shows just those two columns, and the list stays open while ticking', picked.cols.join('|') === 'Shoot scheduled|Shoot done' && picked.open && /Shoot scheduled, Shoot done/.test(picked.v), JSON.stringify(picked));
await page.click('#ddStage .tk-dd-clear');
await page.mouse.click(5, 900);
await page.waitForTimeout(150);
ok('…a click elsewhere closes it', !(await page.$('#ddStage[open]')));
await page.click('#ddAgent summary');
await page.click('#ddAgent .tk-dd-row:has-text("Agent.b") input');
await page.waitForTimeout(150);
ok('Picking an agent shows only their listings', JSON.stringify(await owners(page, '.tk-card')) === '["Meenakshi"]', JSON.stringify(await owners(page, '.tk-card')));
await page.evaluate(() => clearAgentFilter());
await page.selectOption('.tk-dd-sort select', 'name');
await page.waitForTimeout(150);
const sortedCol = await page.evaluate(() => [...document.querySelectorAll('.tk-col')].map(c => [...c.querySelectorAll('.tk-card')].map(e => ((e.getAttribute('aria-label') || '').match(/, owner (.+)$/) || [])[1] || '')).find(a => a.length > 1));
ok('Sorting by name orders the cards in each column', sortedCol && sortedCol.join() === [...sortedCol].sort((a, b) => a.localeCompare(b)).join(), JSON.stringify(sortedCol));
await page.selectOption('.tk-dd-sort select', 'urgency');
await page.waitForTimeout(150);
const shifted = await page.evaluate(() => [...document.querySelectorAll('*')].filter(e => e.scrollLeft > 0 && !e.classList.contains('tk-board') && !e.classList.contains('tk-chips')).map(e => e.tagName + '#' + e.id + '.' + e.className + ' ' + e.scrollLeft));
ok('Nothing around the board is left scrolled sideways', !shifted.length, JSON.stringify(shifted));
await shot('board');

// ── Stage move ──
await page.evaluate(() => changeStage('l2', 'shoot_scheduled'));
await page.waitForTimeout(200);
const saved = await page.evaluate(() => window.__saved.map(s => [s.id, s.stageId]));
ok('Dragging a card to another column saves the move', saved.some(([id, st]) => id === 'l2' && st === 'shoot_scheduled'), JSON.stringify(saved));
ok('…and records it on the timeline', (await page.evaluate(() => window.__history.map(h => h.text))).some(t => /Moved from/.test(t)));
ok('…and, with no shoot date yet, opens the booking to pick one', await page.$eval('#shModal', e => e.classList.contains('open')));
await page.evaluate(() => closeShootModal());

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
// Put it back: the shoot-agent checks below need this one live, and a dropped
// listing is correctly excluded from every shoot view.
await page.evaluate(() => changeStage('l1', 'shoot_scheduled'));
await page.waitForTimeout(200);

// ── Detail panel ──
await page.evaluate(() => openDetail('l3'));
await page.waitForTimeout(250);
ok('The detail panel opens', await page.$eval('#dp', e => e.classList.contains('open')));
const body = (await text(page, '#dpBody'))[0];
ok('…showing the owner', /Lakshmi/.test(body));
const sum = await page.evaluate(() => {
  const s = document.querySelector('#dpBody .tk-sum');
  const secs = [...document.querySelectorAll('#dpBody .tk-dp-main > .tk-sec')];
  return { first: secs[0] === s, txt: s ? s.textContent.replace(/\s+/g, ' ') : '', buyersLast: secs.indexOf(document.getElementById('dpBuyers')) === secs.length - 2 };
});
ok('The detail page opens on a summary: name, area, agent, stage, created and last updated', sum.first
  && /Lakshmi/.test(sum.txt) && /Velachery/.test(sum.txt) && /Agent/.test(sum.txt) && /Unassigned/.test(sum.txt)
  && /Stage/.test(sum.txt) && /Created/.test(sum.txt) && /Last updated/.test(sum.txt), sum.txt.slice(0, 300));
ok('Matching buyers come last, after the property work', sum.buyersLast);
ok('…the brief, with what is needed and what is done', /what to capture/i.test(body) && /Floor plan/.test(body), body.slice(0, 200));
ok('…and how to actually get there', /Getting there/.test(body));
ok('…the shoot section', /Shoot/.test(body));
ok('…and the deliverables', /Deliverables/.test(body));
const cols2 = await page.evaluate(() => { const m = document.querySelector('#dp .tk-dp-main').getBoundingClientRect(), d = document.querySelector('#dp .tk-dp-side').getBoundingClientRect(); return { mR: Math.round(m.right), sL: Math.round(d.left), sW: Math.round(d.width) }; });
ok('The detail page uses the width: notes and timeline sit in a right-hand column', cols2.sL >= cols2.mR && cols2.sW >= 340, JSON.stringify(cols2));
ok('An old remark still shows in the notes until it is moved', /Owner prefers calls after 6pm/.test((await text(page, '#dpNotes'))[0] || ''));
await page.fill('#dpNoteText', 'Owner will be away till Monday — shoot after that');
await page.click('.tk-note-bar .tk-btn');
await page.waitForTimeout(250);
const noteNow = await page.evaluate(() => ({ list: document.querySelector('#dpNotes').textContent, saved: window.__history.filter(h => h.type === 'note'), card: (window.__saved.filter(s => s.id === 'l3').pop() || {}).lastNote, box: document.querySelector('#dpNoteText').value }));
ok('A note is added with who wrote it and when', /away till Monday/.test(noteNow.list) && /Agent\.a/.test(noteNow.list) && noteNow.saved.length === 1 && noteNow.saved[0].by === 'agent.a@example.com' && !noteNow.box, JSON.stringify(noteNow));
ok('…and the card carries it as the latest note', noteNow.card && /away till Monday/.test(noteNow.card.text));
ok('…while the timeline keeps only what the board recorded', !/away till Monday/.test((await text(page, '#dpHistory'))[0] || ''));
await shot('detail');
await page.evaluate(() => closeDetail());
await page.waitForTimeout(150);
ok('The board card marks the latest note (read on hover)', (await page.$$eval('.tk-card .tk-noteic', e => e.map(x => x.title))).some(t => /away till Monday/.test(t) && /Agent\.a/.test(t)));
const fit = await page.evaluate(() => { const b = document.querySelector('.tk-board').getBoundingClientRect(); return { bottom: Math.round(b.bottom), vh: innerHeight, sh: document.documentElement.scrollHeight }; });
ok('The board fills the screen to the bottom, with no blank page below', Math.abs(fit.bottom - fit.vh) <= 2 && fit.sh <= fit.vh + 2, JSON.stringify(fit));
await page.evaluate(() => openDetail('l3'));
await page.waitForTimeout(250);
await page.click('.tk-nt-del');
await page.waitForTimeout(250);
ok('A note can be deleted', !(await page.evaluate(() => window.__history.some(h => h.type === 'note'))) && !(await page.evaluate(() => (window.__saved.filter(s => s.id === 'l3').pop() || {}).lastNote)));

// Ticking a media item writes it through.
await page.evaluate(() => setMedia('l3', 'video', true));
await page.waitForTimeout(150);
ok('Ticking a media item saves it', await page.evaluate(() => window.__saved.some(s => s.id === 'l3' && s.media && s.media.video === true)));

// ── The owner conversation was taken off the listing (it lives in the CRM); the brochure panel took its place ──
await page.evaluate(() => { closeDetail(); openDetail('l1'); });
await page.waitForTimeout(400);
// The owner's report: a card open, then "Editor" picked in the menu — the editor opened behind the
// card and only showed after Back. Picking a section closes the card.
// (Within the open Shoot & Media section: the rail lists every console, and "Board" is also the CRM's.)
await page.evaluate(() => { const i = [...document.querySelectorAll('#appRail .rl-sec.open .rl-item')].find(x => (x.querySelector('.rl-nm') || {}).textContent === 'Editor'); if (i) i.click(); });
await page.waitForTimeout(300);
ok('Picking a section in the menu with a card open closes the card and shows the section', await page.evaluate(() =>
  !document.getElementById('dp').classList.contains('open') && !!document.querySelector('#boardView .ed-board')));
await page.evaluate(() => { const i = [...document.querySelectorAll('#appRail .rl-sec.open .rl-item')].find(x => (x.querySelector('.rl-nm') || {}).textContent === 'Board'); if (i) i.click(); });
await page.waitForTimeout(200);
await page.evaluate(() => openDetail('l1'));
await page.waitForTimeout(400);
ok('The listing no longer shows the owner chat', !(await page.$('#dpConvo')) && !/weekend works/.test(await page.textContent('#dpBody')));
ok('…the brochure panel is there instead, under Notes', !!(await page.$('.tk-dp-side #bpSec')));
await shot('detail-convo');

// ── Move to… — a card's column in two clicks, no dragging (and the drop target is the whole column) ──
await page.evaluate(() => closeDetail());
await page.waitForTimeout(150);
{
  const before = await page.evaluate(() => window.trackApi.listings().find(l => l.id === 'l4').stageId);
  const savedCard = await page.evaluate(() => JSON.stringify(window.trackApi.listings().find(l => l.id === 'l4')));
  await page.click('.tk-card[data-id="l4"] .tk-move-btn');
  await page.waitForTimeout(150);
  const menu = await page.evaluate(() => { const m = document.getElementById('tkMoveMenu'); return m ? { n: m.querySelectorAll('.tk-move-i').length, here: (m.querySelector('.tk-move-i.here .tk-move-l') || {}).textContent || '', focus: document.activeElement && document.activeElement.classList.contains('tk-move-i') } : null; });
  ok('A card’s Move button opens the list of columns, the current one marked', menu && menu.n === (await page.evaluate(() => window.trackApi.stages().length)) && /here now/.test(menu.here) && menu.focus, JSON.stringify(menu));
  const target = await page.evaluate(b => window.trackApi.stages().find(s => s.id !== b && !/hold|drop/i.test(s.key || s.name)).id, before);
  const picked = await page.evaluate(t => { const m = document.getElementById('tkMoveMenu'); if (!m) return 'menu closed before picking'; const i = window.trackApi.stages().findIndex(s => s.id === t); m.querySelectorAll('.tk-move-i')[i].click(); return 'ok'; }, target);
  if (picked !== 'ok') console.log('  · ' + picked);
  await page.waitForTimeout(250);
  ok('…picking a column moves the card there', await page.evaluate(t => window.trackApi.listings().find(l => l.id === 'l4').stageId === t && !document.getElementById('tkMoveMenu'), target));
  await page.click('.tk-card[data-id="l4"] .tk-move-btn');
  await page.keyboard.press('Escape');
  ok('…Escape closes the menu (and nothing else)', await page.evaluate(() => !document.getElementById('tkMoveMenu')));
  // Put the card back exactly as it was (a column change records dates the later steps would see).
  await page.evaluate(j => { const was = JSON.parse(j); window.trackApi.mutate('l4', o => { Object.keys(o).forEach(k => delete o[k]); Object.assign(o, was); }, 'restored'); if (window.applyFilters) window.applyFilters(); }, savedCard);
  await page.waitForTimeout(250);
  // The drop target is the whole column — its header too, not only the strip under the cards.
  const hdrDrop = await page.evaluate(() => {
    const col = document.querySelector('.tk-col'); const hdr = col.querySelector('.tk-col-hdr');
    const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
    hdr.dispatchEvent(ev);
    const marked = col.classList.contains('drag-over');
    col.classList.remove('drag-over');
    return marked && ev.defaultPrevented;
  });
  ok('A drag over a column’s header is accepted (the whole column is the drop target)', hdrDrop);
}
// (back to where the next step expects: the card open)
await page.evaluate(() => openDetail('l1'));
await page.waitForTimeout(300);

// ── Back closes the card (the phone's Back button), not the console ──
{
  await page.evaluate(() => closeDetail());
  await page.waitForTimeout(150);
  await page.evaluate(() => openDetail('l2'));
  await page.waitForTimeout(250);
  const urlBefore = page.url();
  await page.goBack();
  await page.waitForTimeout(250);
  ok('Back with a card open closes the card and stays on the board', await page.evaluate(() => !document.getElementById('dp').classList.contains('open')) && /propertytrack/.test(page.url()), urlBefore + ' → ' + page.url());
  await page.evaluate(() => openDetail('l2'));
  await page.waitForTimeout(200);
  await page.evaluate(() => closeDetail());
  await page.waitForTimeout(250);
  ok('…and closing it from the page leaves no extra Back step behind', await page.evaluate(() => !(history.state && history.state.pinLayer)));
  // Switching cards in a hurry (close + open in the same moment, five times): one Back still closes
  // the card and stays on the page — the history never drifts.
  await page.evaluate(() => { for (let i = 0; i < 5; i++) { closeDetail(); openDetail(i % 2 ? 'l1' : 'l2'); } });
  await page.waitForTimeout(400);
  await page.goBack();
  await page.waitForTimeout(300);
  ok('…after switching cards quickly, one Back closes the card and stays on the page', /propertytrack/.test(page.url()) && await page.evaluate(() => !document.getElementById('dp').classList.contains('open')));
  await page.evaluate(() => openDetail('l1'));
  await page.waitForTimeout(300);
}

// ── Seller preview, without leaving the board ──
await page.evaluate(() => openSellerPreview('l1'));
await page.waitForTimeout(400);
ok('The seller preview opens over the board', await page.$eval('#sellerPrev', e => e.classList.contains('open')));
const prev = (await text(page, '#sellerPrev'))[0] || '';
ok('…showing who they are and how to reach them', /Meenakshi/.test(prev) && /Call/.test(prev), prev.slice(0, 160));
ok('…the property the way the tile reads it (area, configuration, price) — no conversation', /Nungambakkam/.test(prev) && /3 BHK/.test(prev) && /2.1 Cr/.test(prev) && !/weekend works|What they have|Price expectation/.test(prev), prev.slice(0, 200));
ok('…a way to open them fully in the CRM', (await page.$$eval('#sellerPrev a', els => els.map(a => a.getAttribute('href')))).some(h => /crm\.html\?lead=sd1&from=track/.test(h)));
await shot('seller-preview');
await page.evaluate(() => closeSellerPreview());
await page.waitForTimeout(200);
ok('Closing the preview leaves the card open underneath',
  !(await page.$eval('#sellerPrev', e => e.classList.contains('open'))) && await page.$eval('#dp', e => e.classList.contains('open')));

// ── Board ⇄ List ──
await page.evaluate(() => { closeDetail(); setBoardMode('list'); });
await page.waitForTimeout(300);
ok('The list view renders every listing as a row', (await page.$$('.tk-tr:not(.tk-th)')).length >= 5);
const listTxt = (await text(page, '.tk-table'))[0] || '';
ok('…with stage, owner, shoot and what it needs', /Shoot/.test(listTxt) && /Owner/.test(listTxt) && /Needs/.test(listTxt), listTxt.slice(0, 200));
ok('…and it says what is blocking a listing', /not in inventory|owner has not approved|photos not/.test(listTxt), listTxt.slice(0, 400));
await shot('list');
await page.selectOption('.tk-dd-sort select', 'shoot');
await page.waitForTimeout(250);
ok('The list re-sorts with the same Sort as the board', (await page.$$('.tk-tr:not(.tk-th)')).length >= 5 && await page.evaluate(() => document.querySelector('.tk-dd-sort select').value === 'shoot'));
await page.evaluate(() => { setBoardSort('urgency'); setBoardMode('board'); });
await page.waitForTimeout(250);
ok('…and switches back to the board', (await page.$$('.tk-col')).length === 9);

// ── Property mapping ──
await page.evaluate(() => openMapProperty('l2'));
await page.waitForTimeout(350);
// The bug this guards: a hard cap of 60 hid two thirds of a 132-property
// inventory from anyone browsing instead of searching.
const picks = (await page.$$('.tk-pick')).length;
ok('The property picker lists the WHOLE inventory, not the first sixty',
  picks >= INVENTORY.length, `${picks} shown of ${INVENTORY.length}`);
ok('…saying how many there are', /propert(y|ies) in the inventory/.test((await text(page, '#mapList'))[0] || ''));
ok('…and a legacy record with no Property_ID is still offered, by name',
  /Older listing with no Property_ID/.test((await text(page, '#mapList'))[0] || ''));
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
await page.selectOption('#shWho', 'Ravi');
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
ok('…and flags an owner who has not been told', /owner not told/.test(shoots));
ok('An agent can see the actual address, not just a locality',
  /Wallace Garden/.test(shoots), shoots.slice(0, 280));
ok('…who lives there, so they know what they are walking into', /Tenant living there/.test(shoots));
ok('…the access note they need at the gate', /4417/.test(shoots));
ok('…and what they are meant to capture', /Floor plan/.test(shoots) && /Video/.test(shoots));
const acts = await page.$$eval('.tk-row-acts a', els => els.map(a => a.getAttribute('href')));
ok('Call and Map are one tap from the run sheet',
  acts.some(h => /^tel:/.test(h)) && acts.some(h => /google\.com\/maps/.test(h)), JSON.stringify(acts.slice(0, 4)));
ok('A trip that would be wasted is called out before anyone leaves',
  /not ready to send/.test(shoots), shoots.slice(0, 320));
await shot('shoots');

// One agent's day.
await page.evaluate(() => setAgentFilter('Ravi'));
await page.waitForTimeout(250);
const ravi = (await text(page, '#shootsView'))[0];
ok('A handler can pull up one agent\'s day', /Nungambakkam/.test(ravi) && !/Kelambakkam/.test(ravi), ravi.slice(0, 200));
await page.evaluate(() => setAgentFilter(''));
await page.waitForTimeout(200);

// The doorway moment.
await page.evaluate(() => openWrapModal('l1'));
await page.waitForTimeout(250);
ok('The wrap-up marks what was asked for', /asked for/.test((await text(page, '#wrapModal'))[0] || ''));
// Each tick row is one line: the box, then its name (not a full-width box on a line of its own).
const wrapRow = await page.$eval('#wrapList label.tk-check', l => { const i = l.querySelector('input').getBoundingClientRect(), r = l.getBoundingClientRect(); return { iw: Math.round(i.width), rh: Math.round(r.height) }; });
ok('…each item is one neat row: the tick box beside its name', wrapRow.iw <= 20 && wrapRow.rh <= 44, JSON.stringify(wrapRow));
await page.screenshot({ path: `${OUT}/desk-wrap.png` });
await page.check('#wrap_photos');
await page.fill('#wrapPhotos', 'https://drive.google.com/drive/folders/abc123');
await page.fill('#wrapNotes', 'Bedroom not shot — tenant asleep');
await page.click('#wrapModal .tk-btn.primary');
await page.waitForTimeout(350);
const wrapped = await page.evaluate(() => window.__saved.filter(s => s.id === 'l1').pop());
ok('Wrapping up records what was captured and what happened',
  wrapped.media.photos === true && /tenant asleep/.test(wrapped.shootNotes || ''), JSON.stringify(wrapped.shootNotes));
// The whole point of asking for the link on the doorstep: the "photos not
// uploaded" blocker was previously unclearable, because nothing could set it.
ok('…and the Drive folder the agent pastes actually lands',
  /drive\.google\.com\/drive\/folders\/abc123/.test(wrapped.photosLink || ''), wrapped.photosLink);
ok('…which clears the blocker that used to be permanent',
  await page.evaluate(() => {
    const x = window.__saved.filter(s => s.id === 'l1').pop();
    return !blockersFor(x).includes('photos not uploaded');
  }));
ok('…and what was asked for but not got stays outstanding',
  !wrapped.media.floorPlan && !wrapped.media.video);
ok('…and the card moves to Shoot done', wrapped.stageId === 'shoot_done', wrapped.stageId);

// Two shoots, one agent, same hour.
await page.evaluate(() => { toggleView('board'); openShootModal('l5'); });
await page.waitForTimeout(250);
// The same local date AND hour as l1's shoot, or there is nothing to clash with.
const clashAt = new Date(NOW + 3 * H);
const pad = n => String(n).padStart(2, '0');
await page.fill('#shDate', `${clashAt.getFullYear()}-${pad(clashAt.getMonth() + 1)}-${pad(clashAt.getDate())}`);
await page.fill('#shTime', `${pad(clashAt.getHours())}:${pad(clashAt.getMinutes())}`);
await page.selectOption('#shWho', 'Ravi');
await page.waitForTimeout(300);
ok('Booking one agent twice at once warns rather than clashing silently',
  /also at/.test(await page.$eval('#shClash', e => e.textContent)), await page.$eval('#shClash', e => e.textContent));
await page.evaluate(() => closeShootModal());
await page.evaluate(() => toggleView('shoots'));
await page.waitForTimeout(200);

// ── Live seller sync ──
// The two untracked sellers (Gopal, and Priya whom only the AI read as an
// owner) must have been given cards automatically by the reconcile, without
// anyone pressing anything.
const autoMade = await page.evaluate(() => window.__saved.filter(s => s.source === 'seller-sync'));
ok('Untracked sellers get a card automatically', autoMade.length === 2, JSON.stringify(autoMade.map(s => s.sellerName)));
ok('…carrying the owner\'s details across',
  autoMade.some(s => s.sellerName === 'Gopal' && s.sellerPhone === '9840033333' && s.askingPrice === '85 L'),
  JSON.stringify(autoMade.map(s => [s.sellerName, s.sellerPhone, s.askingPrice])));
ok('…including one only the AI read as an owner', autoMade.some(s => s.sellerName === 'Priya'));
ok('…and never a buyer', !autoMade.some(s => /Karthik/.test(s.sellerName || '')));
ok('…and never one deliberately set aside', !autoMade.some(s => /Ravi/.test(s.sellerName || '')));
ok('Each new card is linked back on its lead',
  (await page.evaluate(() => window.__leadPatches.filter(p => p.patch.listingId).length)) >= 2);

// ── Sellers view is now a status view ──
await page.evaluate(() => toggleView('sellers'));
await page.waitForTimeout(300);
const sellers = (await text(page, '#sellersView'))[0];
ok('It reports how many sellers there are', /\d+\s*Sellers/.test(sellers) && /\d+ sellers?/.test(sellers), sellers.slice(0, 140));
const tiles = await page.evaluate(() => [...document.querySelectorAll('#sellersView .sl-tile')].map(t => ({
  name: (t.querySelector('.sl-name') || {}).textContent, phone: (t.querySelector('.sl-phone') || {}).textContent || '',
  prop: (t.querySelector('.sl-prop') || {}).textContent || '', meta: (t.querySelector('.sl-meta') || {}).textContent || '' })));
const gopal = tiles.find(t => t.name === 'Gopal');
ok('Each seller is a tile: name and number first', gopal && /9840033333/.test(gopal.phone), JSON.stringify(gopal));
ok('…then the property: area, configuration and price', gopal && /Adambakkam/.test(gopal.prop) && /2 BHK/.test(gopal.prop) && /85 L/.test(gopal.prop), gopal && gopal.prop);
ok('…then when they came in', gopal && /Came in/.test(gopal.meta), gopal && gopal.meta);
await page.evaluate(() => { setSellerPref('sort', 'name'); });
await page.waitForTimeout(100);
const byName = await page.evaluate(() => [...document.querySelectorAll('#sellersView .sl-name')].map(n => n.textContent));
ok('Sorting by name orders the tiles', JSON.stringify(byName) === JSON.stringify([...byName].sort((a, b) => a.localeCompare(b))), JSON.stringify(byName));
await page.evaluate(() => { setSellerPref('deal', 'rent'); });
await page.waitForTimeout(100);
const rentOnly = await page.evaluate(() => [...document.querySelectorAll('#sellersView .sl-name')].map(n => n.textContent));
ok('Filtering to rent shows only rentals', rentOnly.length < byName.length, JSON.stringify(rentOnly));
await page.evaluate(() => { clearSellerPrefs(); setSellerPref('sort', 'newest'); });
await page.waitForTimeout(100);
ok('…nothing is left waiting once the sync has run', !/Waiting to be added/.test(sellers), sellers.slice(0, 220));
ok('…and a seller set aside is shown as such, not silently gone',
  /Set aside/.test(sellers) && /Ravi/.test(sellers), sellers.slice(0, 260));
await shot('sellers');

// Putting one back must be one click, and must clear the tombstone.
await page.evaluate(() => unskipSeller('sd4'));
await page.waitForTimeout(200);
ok('"Track again" clears the set-aside flag',
  await page.evaluate(() => window.__leadPatches.some(p => p.id === 'sd4' && p.patch.listingSkipped === false)));

// ── The shoot agent's own phone ──
// Saying "this is me" has to change what the app IS for them: their day, not
// a ten-column board, and the next address reachable without reading a list.
await page.evaluate(() => { toggleView('shoots'); setAgentFilter('Ravi'); });
await page.waitForTimeout(250);
await page.evaluate(() => setMyAgent('Ravi'));
await page.waitForTimeout(350);
// A shoot phone opens on the Editor view, the agent's own work (shoots to do, edits, dates) — the
// day's run sheet one tap away.
ok('Saying "this is me" puts the agent on their own work (Editor view, theirs only)',
  await page.evaluate(() => !!document.querySelector('#boardView .ed-board') && /This phone is Ravi/.test(document.querySelector('.ed-agent').textContent)));
await page.click('.ed-agent .tk-btn'); await page.waitForTimeout(250);
ok('…and "Today’s shoots" opens their day', await page.$eval('#shootsView', e => e.style.display !== 'none'));
const day = (await text(page, '.tk-day'))[0] || '';
ok('The day opens with what is next, not a board', /Next up/.test(day), day.slice(0, 200));
ok('…naming the property and its address', /Kottivakkam|Nungambakkam/.test(day), day.slice(0, 220));
const dayActs = await page.$$eval('.tk-next-acts a, .tk-next-acts button', els => els.map(e => e.textContent.trim()));
ok('…with Call, Directions and Done as the only three things to do',
  dayActs.length === 3 && /Call/.test(dayActs[0]), JSON.stringify(dayActs));
ok('The stage chips and board switch are out of the way in agent mode',
  await page.evaluate(() => document.body.classList.contains('agent-mode')));
await shot('agent-day');

// ── Listing type and documents: shown on the card, never holding it back ──
{
  const was = await page.evaluate(() => JSON.stringify(window.trackApi.listings().find(l => l.id === 'l1')));
  // On the Board itself (earlier steps leave it in the Editor view).
  const modeWas = await page.evaluate(() => ((document.querySelector('#tkModeTog .on') || {}).textContent || 'Board').toLowerCase());
  const agentWas = await page.evaluate(() => { try { return localStorage.getItem('track.me') || ''; } catch (e) { return ''; } });
  if (agentWas) await page.evaluate(() => setMyAgent(''));
  await page.evaluate(() => { if (document.getElementById('dp').classList.contains('open')) closeDetail(); toggleView('board', true); setBoardMode('board'); openDetail('l1'); });
  await page.waitForTimeout(250);
  const sec = await page.evaluate(() => {
    const s = document.getElementById('dpTerms');
    return s ? { types: [...s.querySelectorAll('.tk-seg-b')].map(b => b.textContent.trim()), docs: s.querySelectorAll('.tk-doc-r').length,
      count: (s.querySelector('.tk-count') || {}).textContent || '' } : null;
  });
  ok('The card has a Listing & documents section', !!sec && sec.types.join() === 'Normal,Exclusive,Collab' && sec.docs === 7, JSON.stringify(sec));
  ok('…counting what is in hand', sec && sec.count === '0 of 7', JSON.stringify(sec));
  await page.click('#dpTerms .tk-seg-b:has-text("Exclusive")');
  await page.waitForTimeout(150);
  await page.selectOption('#dpTerms .tk-doc-r:has-text("Patta") select', 'have');
  await page.waitForTimeout(150);
  await page.selectOption('#dpTerms .tk-doc-r:has-text("Approved plan") select', 'missing');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => {
    const l = window.trackApi.listings().find(x => x.id === 'l1');
    const saved = window.__saved.filter(s => s.id === 'l1').pop() || {};
    return { type: l.listingType, docs: l.docs, savedType: saved.listingType, savedDocs: saved.docs,
      count: (document.querySelector('#dpTerms .tk-count') || {}).textContent || '',
      on: (document.querySelector('#dpTerms .tk-seg-b.on') || {}).textContent || '', stage: l.stageId };
  });
  ok('Picking a type and a document status saves them', after.type === 'exclusive' && after.savedType === 'exclusive'
    && after.savedDocs && after.savedDocs.patta === 'have' && after.savedDocs.approved_plan === 'missing', JSON.stringify(after));
  ok('…the section shows them', /Exclusive/.test(after.on) && after.count === '1 of 7', JSON.stringify(after));
  await page.locator('#dpTerms').screenshot({ path: `${OUT}/card-terms.png` });
  await page.evaluate(() => closeDetail());
  await page.waitForTimeout(200);
  const chipOn = await page.evaluate(() => { const all = [...document.querySelectorAll('.tk-card[data-id="l1"]')]; const c = document.querySelector('.tk-card.cmp[data-id="l1"]'); return { card: !!c, n: all.map(x => x.className + '@' + (x.closest('[id]') || {}).id), top: c ? (c.querySelector('.tk-ctop') || {}).outerHTML || 'no top' : '', type: window.trackApi.listings().find(x => x.id === 'l1').listingType }; });
  ok('…and the board card shows the type', /tk-ltype exclusive/.test(chipOn.top), JSON.stringify(chipOn));
  // A missing document is a note, not a stop: the card is never held back or flagged for it.
  ok('…a missing document holds nothing back', await page.evaluate(() => !/Approved plan|document/i.test((document.querySelector('.tk-card[data-id="l1"] .tk-stuck') || {}).textContent || '')));
  // Picking the chosen type again clears it.
  await page.evaluate(() => { openDetail('l1'); });
  await page.waitForTimeout(150);
  await page.click('#dpTerms .tk-seg-b.on');
  await page.waitForTimeout(150);
  ok('Picking the chosen type again clears it', await page.evaluate(() => window.trackApi.listings().find(x => x.id === 'l1').listingType === ''));
  await page.evaluate(() => closeDetail());
  // Settings → Configurations sets the list.
  await page.evaluate(() => toggleView('settings', true));
  await page.waitForTimeout(200);
  await page.fill('#cfDoc', 'Society NOC');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const cfg = await page.evaluate(() => [...document.querySelectorAll('#settingsView .cf-chip')].map(c => c.textContent.replace('✕', '').trim()));
  ok('Settings: a document can be added to the checklist', cfg.includes('Society NOC'), JSON.stringify(cfg));
  await page.evaluate(() => cfRemoveDoc('Society NOC'));
  await page.waitForTimeout(150);
  ok('…and removed', await page.evaluate(() => ![...document.querySelectorAll('#settingsView .cf-chip')].some(c => /Society NOC/.test(c.textContent))));
  // The new-listing form offers the type too.
  await page.evaluate(() => { toggleView('board', true); openAddModal(); });
  await page.waitForTimeout(150);
  ok('New listing: the type can be set there', await page.evaluate(() => [...document.querySelectorAll('#mm_listingType option')].map(o => o.value).join() === ',normal,exclusive,collab'));
  await page.evaluate(() => closeModal());
  await page.evaluate(m => setBoardMode(m), modeWas);
  if (agentWas) await page.evaluate(a => setMyAgent(a), agentWas);

  // ── The finished video's link: optional, on a done edit, read by Posting ──
  const fin = await page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const now = Date.now();
    window.trackApi.mutate('l1', o => { o.cuts = { ...(o.cuts || {}), igReel: { status: 'done', by: 'Ravi', startedAt: now - 7200e3, doneAt: now - 3600e3 } }; }, null);
    openDetail('l1'); await wait(150);
    const offered = !!document.querySelector('#dpEdit .tk-final button');
    const realPrompt = window.prompt;
    window.prompt = () => 'not a link';
    edFinalLink('l1', 'igReel'); await wait(80);
    const refused = !(window.trackApi.listings().find(x => x.id === 'l1').finalLinks || {}).igReel;
    window.prompt = () => 'https://drive.google.com/file/d/final123/view';
    edFinalLink('l1', 'igReel'); await wait(150);
    const l = window.trackApi.listings().find(x => x.id === 'l1');
    const shown = (document.querySelector('#dpEdit .tk-final a') || {}).href || '';
    const viaPosting = window.trackApi.finalLinkOf(l, 'igReel'), viaFb = window.trackApi.finalLinkOf(l, 'fbReel');
    const saved = l.finalLinks && l.finalLinks.igReel && l.finalLinks.igReel.url;
    window.prompt = () => '';
    edFinalLink('l1', 'igReel'); await wait(80);
    const removed = !(window.trackApi.listings().find(x => x.id === 'l1').finalLinks || {}).igReel;
    window.prompt = realPrompt;
    closeDetail();
    return { offered, refused, saved, shown,
      viaPosting: viaPosting && viaPosting.url, viaFb: viaFb && viaFb.url, removed };
  });
  ok('A done edit offers an optional final video link', fin.offered, JSON.stringify(fin));
  ok('…a non-link is refused', fin.refused, JSON.stringify(fin));
  ok('…a link is saved and shown on the card', /final123/.test(fin.saved || '') && /final123/.test(fin.shown), JSON.stringify(fin));
  ok('…Posting reads it (the FB Reel sharing the Insta Reel’s cut too)', /final123/.test(fin.viaPosting || '') && /final123/.test(fin.viaFb || ''), JSON.stringify(fin));
  ok('…and emptying it removes it', fin.removed, JSON.stringify(fin));

  // ── Re-shot after the brochure was made: a "Brochure v2?" reminder, never a block ──
  const v2 = await page.evaluate(async ([modeWas, agentWas]) => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    if (agentWas) setMyAgent('');
    setBoardMode('board');
    const now = Date.now();
    const sd = window.trackApi.stages().find(st => st.key === 'shoot_done' || st.name === 'Shoot done');
    window.trackApi.mutate('l1', o => { o.stageId = sd.id; }, null);
    const stageBefore = window.trackApi.listings().find(x => x.id === 'l1').stageId;
    window.trackApi.mutate('l1', o => { o.brochure = { ...(o.brochure || {}), doneAt: now - 5 * 864e5 }; o.shootDoneAt = now; o.broV2Seen = null; }, null);
    await wait(150);
    const chip = !!document.querySelector('.tk-card[data-id="l1"] .tk-bro.v2');
    openDetail('l1'); await wait(150);
    const note = !!document.querySelector('#dpBody .tk-v2');
    const blocked = (window.blockersFor ? window.blockersFor(window.trackApi.listings().find(x => x.id === 'l1')) : []).some(b => /brochure v2|re-?shot/i.test(b));
    broV2Seen('l1'); await wait(150);
    const gone = !document.querySelector('#dpBody .tk-v2');
    closeDetail(); await wait(150);
    const chipGone = !document.querySelector('.tk-card[data-id="l1"] .tk-bro.v2');
    // A shoot done BEFORE the brochure: no reminder.
    window.trackApi.mutate('l1', o => { o.shootDoneAt = now - 9 * 864e5; o.broV2Seen = null; }, null);
    await wait(150);
    const none = !document.querySelector('.tk-card[data-id="l1"] .tk-bro.v2');
    const sameStage = window.trackApi.listings().find(x => x.id === 'l1').stageId === stageBefore;
    setBoardMode(modeWas);
    if (agentWas) setMyAgent(agentWas);
    return { chip, note, blocked, gone, chipGone, none, sameStage };
  }, [modeWas, agentWas]);
  ok('Re-shot after the brochure: the card says "Brochure v2?"', v2.chip && v2.note, JSON.stringify(v2));
  ok('…as a reminder only: nothing is held back, the card does not move', !v2.blocked && v2.sameStage, JSON.stringify(v2));
  ok('…"Not needed" puts it away', v2.gone && v2.chipGone, JSON.stringify(v2));
  ok('…and a shoot from before the brochure never asks', v2.none, JSON.stringify(v2));

  // ── Shoots on the team calendar: off until switched on in Settings; then booked, moved, called off ──
  const calRun = await page.evaluate(async () => {
    const calls = [];
    const realFetch = window.fetch;
    window.fetch = (u, o) => {
      if (String(u).includes('/api/tailortalk?action=calendar')) {
        const b = JSON.parse(o.body); calls.push(b);
        return Promise.resolve(new Response(JSON.stringify({ ok: true, eventId: b.cancel ? null : (b.eventId || 'ev1') }), { status: 200 }));
      }
      return realFetch(u, o);
    };
    window.trackAuth.getIdToken = async () => 'tok';
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const book = async (date, time) => {
      openShootModal('l1'); await wait(80);
      document.getElementById('shDate').value = date; document.getElementById('shTime').value = time;
      saveShoot(); await wait(150);
    };
    const l1 = () => window.trackApi.listings().find(x => x.id === 'l1');
    // A card not shot yet (earlier steps finished l1's shoot; it is put back after).
    window.trackApi.mutate('l1', o => { o.shootDoneAt = null; }, null);
    const d = new Date(Date.now() + 3 * 86400000), day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    await book(day, '10:00');
    const whenOff = calls.length;
    window.applyTrackConfigSnapshot({ shootCalendar: true });
    await book(day, '11:00');
    const first = calls[calls.length - 1], idAfter = l1().shootEventId;
    await book(day, '15:30');
    const moved = calls[calls.length - 1], ownerAfter = l1().shootEventBy;
    const want11 = new Date(day + 'T11:00').getTime(), want1530 = new Date(day + 'T15:30').getTime();
    // Somebody else's entry: not touched from here (the server would refuse; a second entry is never made).
    window.trackApi.mutate('l1', o => { o.shootEventBy = 'someone.else@example.com'; }, null);
    const before = calls.length;
    await book(day, '16:00');
    const othersSent = calls.length - before;
    window.trackApi.mutate('l1', o => { o.shootEventBy = ownerAfter; }, null);
    cancelShoot('l1', 'rain'); await wait(150);
    const off = calls[calls.length - 1];
    window.applyTrackConfigSnapshot({});
    window.fetch = realFetch;
    return { whenOff, n: calls.length, first, idAfter, moved, off, idEnd: l1().shootEventId || null, ownerAfter, othersSent,
      firstAtOk: first && first.at === want11, movedAtOk: moved && moved.at === want1530 };
  });
  ok('Shoots on the calendar: nothing is sent while the setting is off', calRun.whenOff === 0, JSON.stringify(calRun));
  ok('…switched on, a booked shoot goes on the calendar', calRun.first && calRun.first.op === 'meeting' && !calRun.first.eventId && /Shoot/.test(calRun.first.title)
    && /propertytrack\.html\?listing=l1/.test(calRun.first.about || '') && calRun.idAfter === 'ev1', JSON.stringify(calRun.first));
  ok('…with the shoot\u2019s own time', calRun.firstAtOk, JSON.stringify(calRun.first));
  ok('…kept as the booker\u2019s entry', calRun.ownerAfter === 'agent.a@example.com', JSON.stringify(calRun));
  ok('…moving it moves the same entry, to the new time', calRun.moved && calRun.moved.eventId === 'ev1' && !calRun.moved.cancel && calRun.movedAtOk, JSON.stringify(calRun.moved));
  ok('…someone else\u2019s entry is left to them (no second entry)', calRun.othersSent === 0, JSON.stringify(calRun));
  ok('…cancelling it calls that entry off', calRun.off && calRun.off.eventId === 'ev1' && calRun.off.cancel === true && calRun.idEnd === null, JSON.stringify(calRun));
  // A slow calendar, and every save coming back as a fresh snapshot (new objects): book, then call it
  // off before the booking has answered — the entry that was made is called off, none is left behind.
  const race = await page.evaluate(async () => {
    const calls = [], wait = ms => new Promise(r => setTimeout(r, ms));
    const realFetch = window.fetch;
    window.fetch = (u, o) => {
      if (String(u).includes('/api/tailortalk?action=calendar')) {
        const b = JSON.parse(o.body); calls.push(b);
        return new Promise(res => setTimeout(() => res(new Response(JSON.stringify({ ok: true, eventId: b.cancel ? null : (b.eventId || 'ev9') }), { status: 200 })), b.cancel ? 10 : 200));
      }
      return realFetch(u, o);
    };
    const echo = () => window.applyListingsSnapshot(JSON.parse(JSON.stringify(window.trackApi.listings())), true);
    window.trackApi.mutate('l1', o => { o.shootDoneAt = null; o.shootEventId = null; o.shootEventBy = ''; }, null);
    window.applyTrackConfigSnapshot({ shootCalendar: true });
    const d = new Date(Date.now() + 4 * 86400000), day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    openShootModal('l1'); await wait(60);
    document.getElementById('shDate').value = day; document.getElementById('shTime').value = '10:00';
    saveShoot(); echo(); await wait(20);
    cancelShoot('l1', 'owner busy'); echo();
    await wait(700);
    window.applyTrackConfigSnapshot({});
    window.fetch = realFetch;
    const l = window.trackApi.listings().find(x => x.id === 'l1');
    return { calls: calls.map(c => (c.cancel ? 'cancel:' : 'make:') + (c.eventId || '-')), left: l.shootEventId || null };
  });
  ok('Booked and called off before the calendar answered: the entry made is called off again', race.calls[0] === 'make:-' && race.calls.includes('cancel:ev9') && race.left === null, JSON.stringify(race));
  ok('…and only one entry was ever made', race.calls.filter(c => c.startsWith('make:')).length === 1, JSON.stringify(race));
  ok('…and the Settings page has the switch', await page.evaluate(() => { toggleView('settings', true); const t = [...document.querySelectorAll('#settingsView .cf-tog')].some(l => /team calendar/i.test(l.textContent)); toggleView('board', true); return t; }));
  await page.evaluate(j => { const w = JSON.parse(j); window.trackApi.mutate('l1', o => { Object.keys(o).forEach(k => delete o[k]); Object.assign(o, w); }, null); if (window.applyFilters) window.applyFilters(); }, was);
  await page.waitForTimeout(150);
}

// A shoot phone reopens on the day, not the board.
const agentPage = await open({ width: 390, height: 844 }, () => {
  try { localStorage.setItem('track.me', 'Ravi'); localStorage.setItem('track.agent', 'Ravi'); } catch (e) {}
});
await agentPage.waitForTimeout(400);
ok('Reopening a shoot phone lands on their own work, never the full board',
  await agentPage.evaluate(() => !!document.querySelector('#boardView .ed-board') && !document.querySelector('#boardView .tk-board:not(.ed-board)')));
await agentPage.evaluate(() => toggleView('board', true)); await agentPage.waitForTimeout(150);
ok('…even "Board" from the menu shows their work, not the full board', await agentPage.evaluate(() => !!document.querySelector('#boardView .ed-board')));
await agentPage.click('.ed-agent .tk-btn'); await agentPage.waitForTimeout(250);
ok('…their day one tap away', await agentPage.$eval('#shootsView', e => e.style.display !== 'none'));
const tap = await agentPage.$$eval('.tk-next-acts .tk-btn', els => els.map(e => Math.round(e.getBoundingClientRect().height)));
ok('…with thumb-sized actions', tap.length && tap.every(h => h >= 44), JSON.stringify(tap));
ok('…and no sideways scroll', !(await agentPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)));
await agentPage.screenshot({ path: `${OUT}/phone-agent-day.png`, fullPage: true });

// ── Opened from this device's saved copy: no card is saved until the server's list is in ──
// (a save writes the whole card — from an hours-old copy it would undo everyone's changes since).
{
  const cached = await open({ width: 1280, height: 860 }, () => { window.__fromCache = true; });
  const r = await cached.evaluate(async () => {
    const wait = ms => new Promise(res => setTimeout(res, ms));
    const was = window.trackApi.listings().find(x => x.id === 'l1').ownerInformed;
    setFlag('l1', 'ownerInformed', !was); await wait(100);
    const blocked = { saved: window.__saved.length, same: window.trackApi.listings().find(x => x.id === 'l1').ownerInformed === was,
      toast: document.getElementById('toast').textContent };
    // The server's list arrives: changes go through again.
    window.applyListingsSnapshot(JSON.parse(JSON.stringify(window.trackApi.listings())), true); await wait(100);
    setFlag('l1', 'ownerInformed', !was); await wait(100);
    return { blocked, after: window.__saved.filter(x => x.id === 'l1').length };
  });
  ok('From the saved copy: a change is not saved (it would put the old copy back)', r.blocked.saved === 0 && r.blocked.same, JSON.stringify(r));
  ok('…and the person is told why', /Still connecting/.test(r.blocked.toast), r.blocked.toast);
  ok('…once the server\u2019s list is in, it saves', r.after === 1, JSON.stringify(r));
  await cached.context().close();
}

// ── Phone ──
const phone = await open({ width: 390, height: 844 });
await phone.waitForTimeout(250);
await phone.screenshot({ path: `${OUT}/phone-board.png`, fullPage: true });
// On a phone the filters are folded behind one button: the board starts under the search.
ok('On a phone the filters fold behind one Filters button', await phone.evaluate(() => {
  const btn = document.getElementById('tkFiltersBtn'), stage = document.getElementById('ddStage');
  return !!btn && btn.getBoundingClientRect().width > 0 && stage.getBoundingClientRect().width === 0;
}));
await phone.click('#tkFiltersBtn'); await phone.waitForTimeout(150);
ok('…and open with it', await phone.evaluate(() => document.getElementById('ddStage').getBoundingClientRect().width > 0 && document.getElementById('tkFiltersBtn').getAttribute('aria-expanded') === 'true'));
await phone.click('#ddStage summary'); await phone.waitForTimeout(150); await phone.screenshot({ path: `${OUT}/phone-filter-open.png` });
ok('On a phone the stage list fits on screen', await phone.evaluate(() => { const b = document.querySelector('#ddStage .tk-dd-pop').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; }));
await phone.click('#ddStage summary');
const wide = await phone.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
ok('The phone board does not scroll the page sideways', !wide);
await phone.evaluate(() => openDetail('l1'));
await phone.waitForTimeout(250);
await phone.screenshot({ path: `${OUT}/phone-detail.png`, fullPage: true });
await phone.locator('#dpTerms').screenshot({ path: `${OUT}/phone-card-terms.png` });
ok('The phone detail panel does not scroll sideways',
  !(await phone.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)));

await browser.close();
if (errors.length) { console.log('\nERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('\nNo page errors. Screenshots in ' + OUT);
