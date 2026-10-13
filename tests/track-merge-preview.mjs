// Shoot & Media — two cards for one property, merged.
//
// The owner's case (Oct 2026): a card made by hand for "Alwarpet Commercial building Sale - Chamier's
// Road", shoot booked; then the owner wrote in on WhatsApp and the seller sync made a second card,
// "Chamiers Road", in New listing, with the CRM lead on it. Merge must keep the booked card, bring the
// lead, the price and the notes across, write down what differed, and remove the other card.
//
//   node tests/track-merge-preview.mjs
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStages } from '../track-assets/track-pipeline.js';

const OUT = 'tests/out/track-merge';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.now(), H = 3600000, D = 24 * H, T = 't_3pinrealty';
const STAGES = defaultStages();
const sid = key => STAGES.find(s => s.key === key).id;

const LISTINGS = [
  { id: 'hand', tenantId: T, title: "Alwarpet Commercial building Sale - Chamier's Road", location: 'Alwarpet',
    stageId: sid('shoot_scheduled'), shootAt: NOW + 26 * H, shootAssignee: 'Rajesh', address: '12 Chamiers Road, Alwarpet',
    tags: ['Commercial'], media: {}, reached: { new_listing: NOW - 8 * D, shoot_scheduled: NOW - 2 * D },
    stageChangedAt: NOW - 2 * D, createdAt: NOW - 8 * D, updatedAt: NOW - H },
  { id: 'wa', tenantId: T, title: 'Chamiers Road', location: 'Chamiers Road', leadId: 'sandhya', sellerName: 'Sandhya',
    sellerPhone: '919908532000', askingPrice: 'Expected selling price: ₹30 crore', propertyType: 'Commercial',
    tags: ['Sale'], docs: { Patta: 'have' }, media: {}, own: { sellerName: true }, reached: { new_listing: NOW - 6 * D },
    stageId: sid('new_listing'), stageChangedAt: NOW - 6 * D, createdAt: NOW - 6 * D, updatedAt: NOW - 5 * D, source: 'seller-sync' },
  // Two hand-made cards in the same locality: never suggested as the same property.
  { id: 'myl1', tenantId: T, title: 'Mylapore 3.5 grounds Land for Sale', location: 'Mylapore', stageId: sid('shoot_scheduled'), media: {}, createdAt: NOW - 3 * D, updatedAt: NOW - D },
  { id: 'myl2', tenantId: T, title: 'Mylapore Office Floor for sale', location: 'Mylapore', stageId: sid('shoot_scheduled'), media: {}, createdAt: NOW - 3 * D, updatedAt: NOW - D }
];
const LEADS = [
  { id: 'sandhya', tenantId: T, name: 'Sandhya', phone: '919908532000', enquiryType: 'Seller Listing', propertyInterest: 'Chamiers Road', listingId: 'wa', createdAt: NOW - 6 * D }
];
const HISTORY = [
  { id: 'n_wa1', listingId: 'wa', type: 'note', text: 'Owner wants ₹30 Cr, open to a lease too', at: NOW - 5 * D, by: 'thirumal@example.com' },
  { id: 'h_wa2', listingId: 'wa', type: 'field', text: 'Card made from the WhatsApp lead', at: NOW - 6 * D, by: 'sync' },
  { id: 'n_h1', listingId: 'hand', type: 'note', text: 'Shoot on the ground and first floor', at: NOW - 2 * D, by: 'rajesh@example.com' }
];

const STUB = `
window.__saved = []; window.__deleted = []; window.__history = ${JSON.stringify(HISTORY)}; window.__leadPatches = [];
window.trackFirebase = {
  saveListing: async l => { window.__saved.push(JSON.parse(JSON.stringify(l))); },
  deleteListing: async id => { window.__deleted.push(id); },
  savePipeline: async () => {},
  patchLead: async (id, patch) => { window.__leadPatches.push({ id, patch }); },
  getLeadConversation: async () => null,
  getInventory: async () => [],
  getListingHistory: async id => window.__history.filter(h => h.listingId === id).slice().sort((a, b) => b.at - a.at),
  saveHistory: async (id, e) => { window.__history = window.__history.filter(h => !(h.listingId === id && h.id === e.id)); window.__history.push({ ...e, listingId: id }); },
  deleteHistory: async (id, eid) => { window.__history = window.__history.filter(h => !(h.listingId === id && h.id === eid)); }
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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
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

for (const [name, viewport] of [['desktop', { width: 1440, height: 950 }], ['phone', { width: 390, height: 844 }]]) {
  console.log(`── ${name}`);
  const page = await open(viewport);

  // The WhatsApp card says it looks like the booked one.
  await page.evaluate(() => openDetail('wa'));
  await page.waitForTimeout(250);
  const banner = await page.$eval('#dpBody', el => (el.querySelector('.tk-dupe') || {}).textContent || '');
  ok('The WhatsApp card asks: same property as the booked card?', /Alwarpet Commercial building Sale/.test(banner) && /chamiers/i.test(banner), banner.replace(/\s+/g, ' '));
  // …and the two Mylapore cards are not called duplicates of each other.
  const myl = await page.evaluate(() => likelyDuplicates('myl1').map(d => d.card.id));
  ok('Two hand-made cards in one locality are not suggested', !myl.length, JSON.stringify(myl));

  await page.click('.tk-dupe button');
  await page.waitForTimeout(200);
  const list = await page.$eval('#mergeList', el => el.textContent.replace(/\s+/g, ' '));
  ok('The picker leads with the likely same property', /Looks like the same property\s*Alwarpet Commercial/.test(list), list.slice(0, 160));
  await page.click('#mergeList .tk-pick');
  await page.waitForTimeout(200);
  const step = await page.$eval('#mergeStep', el => el.textContent.replace(/\s+/g, ' '));
  ok('The booked card (Shoot scheduled) is the one kept', /Keep Alwarpet Commercial building Sale - Chamier's Road\s*Shoot scheduled/.test(step), step.slice(0, 200));
  ok('It says the CRM lead comes across', /CRM lead Sandhya/.test(step), step);
  ok('It says what differs and that it is kept as a note', /both cards differ \(Title, Location\)/.test(step), step);
  ok('No sideways scroll in the dialog', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: `${OUT}/${name}-step.png` });

  // "Keep the other card instead" swaps the two, and back.
  await page.click('#mergeStep .tk-btnrow .tk-btn:not(.primary)');
  ok('Keep the other card instead swaps them', /Keep Chamiers Road\s*New listing/.test(await page.$eval('#mergeStep', el => el.textContent.replace(/\s+/g, ' '))));
  await page.click('#mergeStep .tk-btnrow .tk-btn:not(.primary)');
  await page.click('#mergeGo');
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const k = window.__saved.filter(l => l.id === 'hand').pop();
    return { gone: ![...document.querySelectorAll('.tk-card')].some(c => /Chamiers Road$/.test((c.querySelector('.tk-pname') || {}).textContent || '')), deleted: window.__deleted, k, patches: window.__leadPatches,
      hist: window.__history.filter(h => h.listingId === 'hand').map(h => h.text) };
  });
  const k = after.k || {};
  ok('The WhatsApp card is removed', after.gone && after.deleted.includes('wa'), JSON.stringify(after.deleted));
  ok('The kept card stays in Shoot scheduled with its shoot', k.stageId === STAGES.find(s => s.key === 'shoot_scheduled').id && k.shootAt === LISTINGS[0].shootAt);
  ok('The CRM lead is linked to the kept card', k.leadId === 'sandhya' && after.patches.some(p => p.id === 'sandhya' && p.patch.listingId === 'hand' && !p.patch.listingSkipped), JSON.stringify(after.patches));
  ok('Owner, phone, price, type and documents came across', k.sellerName === 'Sandhya' && k.sellerPhone === '919908532000' && /30 crore/.test(k.askingPrice) && k.propertyType === 'Commercial' && k.docs && k.docs.Patta === 'have', JSON.stringify(k));
  ok('Tags from both cards', JSON.stringify(k.tags) === JSON.stringify(['Commercial', 'Sale']), JSON.stringify(k.tags));
  ok('The board-edited flags of both cards are kept', k.own && k.own.sellerName === true);
  ok('The earliest dates are kept', k.createdAt === LISTINGS[0].createdAt && k.reached.new_listing === LISTINGS[0].reached.new_listing);
  ok('Notes and timeline moved across', after.hist.includes('Owner wants ₹30 Cr, open to a lease too') && after.hist.includes('Card made from the WhatsApp lead') && after.hist.includes('Shoot on the ground and first floor'), JSON.stringify(after.hist));
  ok('What differed is on record as a note', after.hist.some(t => /From the merged card “Chamiers Road”: Title: Chamiers Road · Location: Chamiers Road/.test(t)), JSON.stringify(after.hist));
  ok('The note count covers both cards', k.noteCount === 2 && /₹30 Cr|From the merged card/.test((k.lastNote || {}).text || ''), JSON.stringify([k.noteCount, k.lastNote]));
  await page.screenshot({ path: `${OUT}/${name}-after.png` });
  const panel = await page.$eval('#dpBody', el => el.textContent.replace(/\s+/g, ' '));
  ok('The panel shows the kept card, with Sandhya and no duplicate banner', /Sandhya/.test(panel) && !(await page.$('.tk-dupe')), panel.slice(0, 160));
  await page.context().close();
}

await browser.close();
if (errors.length) { console.log('\nFAILED:\n  ' + errors.join('\n  ')); process.exit(1); }
console.log('\nAll good.');
