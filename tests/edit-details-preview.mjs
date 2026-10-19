// A card's name and the details its tile shows: renamed from the card page, corrected in Edit details
// (over what was read from the chat), or filled from its Property dashboard record.
//
//   node tests/edit-details-preview.mjs [outDir]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStages } from '../track-assets/track-pipeline.js';

const OUT = process.argv[2] || 'tests/out/edit-details';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.now(), D = 86400000;
const T = 't_3pinrealty';
const ST = defaultStages();
const sid = key => ST.find(s => s.key === key).id;

// Like MYLA0004's card: made from a WhatsApp lead, named after the area, its price the lead's words.
const LEAD = { id: 'tt_raj', tenantId: T, name: 'Raj', phone: '18182848163', enquiryType: 'Seller Listing', propertyInterest: 'Mylapore',
  budget: 'Expected price ₹1.45 crores, fully…', createdAt: NOW - 30 * D, tt: { facts: { deal: 'sale', type: 'apartment', sizes: [{ kind: 'built', sqft: 1225, label: '1,225 sqft' }, { kind: 'uds', sqft: 400, label: '400 sqft UDS' }] } } };
const LISTINGS = [{ id: 'lst_m', tenantId: T, leadId: 'tt_raj', sellerName: 'Raj', sellerPhone: '18182848163', title: 'Mylapore', location: 'Mylapore',
  askingPrice: 'Expected price ₹1.45 crores, fully…', propertyCode: 'MYLA0004', stageId: sid('shoot_scheduled'), media: {}, source: 'seller-sync',
  createdAt: NOW - 30 * D, updatedAt: NOW - D, stageChangedAt: NOW - 6 * D }];
const INV = [{ id: 'MYLA0004', propertyCode: 'MYLA0004', name: '2 BHK Apartment - Loganathan Colony, Mylapore', location: 'Loganathan Colony, Mylapore, Chennai',
  config: '2 BHK', startingPrice: '₹1.40 Cr (Negotiable)', sqftRange: '1,219', uds: '400', type: 'Apartment',
  photosLink: 'https://drive.google.com/drive/u/0/folders/1QY4zxYFV9zGJzWagM25WzMTxuZsXxsdy' }];

const STUB = `
window.__saved = [];
window.trackFirebase = {
  saveListing: async l => { window.__saved.push(JSON.parse(JSON.stringify(l))); }, deleteListing: async () => {}, savePipeline: async () => {}, patchLead: async () => {},
  getLeadConversation: async () => null, getInventory: async () => ${JSON.stringify(INV)}, getListingHistory: async () => [], saveHistory: async () => {}, deleteHistory: async () => {},
  getPropertyInternalNotes: async () => '', saveTrackConfig: async () => {}
};
window.trackAuth = { login: async () => {}, logout: async () => {}, getTenantId: () => '${T}' };
setTimeout(() => {
  window.onTrackAuthChange({ email: 'thirumal@threepin.in' }, '${T}');
  window.applyTrackPipelineSnapshot(${JSON.stringify(ST)});
  window.applyListingsSnapshot(${JSON.stringify(LISTINGS)});
  window.applyTrackLeadsSnapshot(${JSON.stringify([LEAD])});
  window.__ready = true;
}, 0);`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' };
const browser = await chromium.launch();
const errors = [];
const ok = (l, c, d) => { if (c) console.log('  ok  ' + l); else { errors.push(l + (d !== undefined ? ' — ' + d : '')); console.log('  FAIL ' + l + (d !== undefined ? ' — ' + d : '')); } };
async function open(viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${viewport.width}px: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`console: ${m.text()}`); });
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
  await page.waitForTimeout(400);
  return page;
}
const tile = page => page.evaluate(() => { const c = document.querySelector('.tk-card[data-id="lst_m"]'); return c ? c.textContent.replace(/\s+/g, ' ').trim() : ''; });
const card = page => page.evaluate(() => window.trackApi.listings().find(l => l.id === 'lst_m'));

console.log('Edit a card\'s name and what its tile shows');
let page = await open({ width: 1440, height: 950 });
ok('Before: the tile has the lead\'s words', /Mylapore/.test(await tile(page)));

// 1. The card page: a ✎ beside the name and an Edit details button at the top.
await page.evaluate(() => openDetail('lst_m')); await page.waitForTimeout(400);
ok('The card page: ✎ beside the name, and Edit details at the top', !!(await page.$('#dpTitle .dp-rename')) && !!(await page.$('.tk-sum-acts button:has-text("Edit details")')));
await page.click('#dpTitle .dp-rename'); await page.waitForTimeout(200);
ok('…✎ opens Edit details with the Title ready to type', await page.evaluate(() => document.getElementById('mModal').classList.contains('open') && document.activeElement.id === 'mm_title'));
await page.fill('#mm_title', '2BHK Flat, Loganathan Colony');
await page.selectOption('#mm_deal', 'rent'); await page.selectOption('#mm_propType', 'villa');
await page.fill('#mm_sqft', '1,300'); await page.fill('#mm_uds', '450'); await page.fill('#mm_askingPrice', '₹45,000/month');
await page.screenshot({ path: join(OUT, 'edit-form.png') });
await page.click('#mModal .tk-btn.primary'); await page.waitForTimeout(400);
let x = await card(page);
ok('Saved on the card: name, sale or rent, type, size, UDS, price', x.title === '2BHK Flat, Loganathan Colony' && x.deal === 'rent' && x.propType === 'villa' && x.sqft === '1,300' && x.uds === '450' && x.askingPrice === '₹45,000/month', JSON.stringify(x));
ok('…the card page shows the new name', /2BHK Flat, Loganathan Colony/.test(await page.textContent('#dpTitle')));
const chips = await page.evaluate(() => (document.querySelector('#dpBody .tk-sum .sl-chips') || {}).textContent || '');
ok('The card page\'s chips show them — over what was read from the chat', /For rent/.test(chips) && /Villa/.test(chips) && /1,300 sqft/.test(chips) && /450 sqft UDS/.test(chips) && /₹45,000\/month/.test(chips) && !/1,225 sqft|For sale|Apartment|Expected price/.test(chips), chips);
await page.screenshot({ path: join(OUT, 'card-page.png') });
await page.evaluate(() => closeDetail()); await page.waitForTimeout(300);
const t1 = await tile(page);
ok('The board tile shows the new name and Rent ₹45,000/month', /2BHK Flat, Loganathan Colony/.test(t1) && /Rent ₹45,000\/month/.test(t1), t1);

// 2. The CRM lead changing does not undo them.
await page.evaluate(l => window.applyTrackLeadsSnapshot([{ ...l, budget: 'Now asking ₹1.5 Cr', propertyInterest: 'Mylapore East' }]), LEAD); await page.waitForTimeout(400);
x = await card(page);
ok('A later change on the CRM lead does not undo them', x.title === '2BHK Flat, Loganathan Colony' && x.askingPrice === '₹45,000/month', JSON.stringify({ title: x.title, askingPrice: x.askingPrice }));

// 3. Use MYLA0004's details: filled, marked, saved only on Save.
await page.evaluate(() => openDetail('lst_m')); await page.waitForTimeout(400);
await page.click('button:has-text("Use MYLA0004\'s details")'); await page.waitForTimeout(500);
const f = await page.evaluate(() => ({ title: mm_title.value, price: mm_askingPrice.value, sqft: mm_sqft.value, uds: mm_uds.value, deal: mm_deal.value, type: mm_propType.value, loc: mm_location.value,
  marked: [...document.querySelectorAll('#mModal .mm-filled')].map(e => e.id), note: document.getElementById('mmFrom').textContent }));
ok('Use MYLA0004\'s details: the form filled from the Property dashboard', f.title === '2 BHK Apartment - Loganathan Colony, Mylapore' && f.price === '₹1.40 Cr (Negotiable)' && f.sqft === '1,219' && f.uds === '400' && f.type === 'apartment' && f.loc === 'Loganathan Colony, Mylapore, Chennai', JSON.stringify(f));
ok('…the changed fields marked, and it says to check them before saving', f.marked.includes('mm_title') && f.marked.includes('mm_sqft') && /Filled from MYLA0004/.test(f.note) && /Save/.test(f.note), JSON.stringify(f));
ok('…nothing saved until Save', (await card(page)).title === '2BHK Flat, Loganathan Colony');
await page.screenshot({ path: join(OUT, 'use-inventory.png') });
await page.click('#mModal .tk-btn.primary'); await page.waitForTimeout(400);
x = await card(page);
ok('Saved: the card now says what the Property dashboard says', x.title === '2 BHK Apartment - Loganathan Colony, Mylapore' && x.askingPrice === '₹1.40 Cr (Negotiable)' && x.sqft === '1,219' && x.uds === '400' && x.propType === 'apartment', JSON.stringify(x));
await page.evaluate(() => closeDetail()); await page.waitForTimeout(300);
ok('…and so does the tile', /2 BHK Apartment - Loganathan Colony, Mylapore/.test(await tile(page)) && /Sale ₹1.40 Cr/.test(await tile(page)), await tile(page));

// 4. The tile's own rename still works.
await page.hover('.tk-card[data-id="lst_m"]');
await page.click('.tk-card[data-id="lst_m"] .tk-pname-ed');
await page.fill('.tk-card[data-id="lst_m"] .tk-pname-in', 'Sai Vignesh Apartment, Mylapore');
await page.keyboard.press('Enter'); await page.waitForTimeout(300);
ok('Renaming on the tile itself still works', (await card(page)).title === 'Sai Vignesh Apartment, Mylapore');

// 5. The editor's view: paste the photos link, open it, see the photos in the card.
// (Linking the card above copied MYLA0004's link onto it: cleared, to see the fallback.)
await page.evaluate(() => window.trackApi.mutate('lst_m', l => { l.photosLink = ''; }, null)); await page.waitForTimeout(200);
await page.evaluate(() => openEdDetail('lst_m')); await page.waitForTimeout(600);
let ph = await page.evaluate(() => ({ box: !!document.getElementById('edPhIn'), open: (document.querySelector('#edPhotos a[href*="drive.google.com"]') || {}).href || '', hint: (document.querySelector('#edPhotos .tk-hint') || {}).textContent || '' }));
ok('Editor\'s view: a Photos box; with no link on the card, the Property dashboard\'s is offered', ph.box && /1QY4zxYFV9zGJzWagM25WzMTxuZsXxsdy/.test(ph.open) && /MYLA0004/.test(ph.hint), JSON.stringify(ph));
await page.click('#edPhotos button:has-text("Show photos here")'); await page.waitForTimeout(300);
ok('…"Show photos here" shows the folder in the card', /embeddedfolderview\?id=1QY4zxYFV9zGJzWagM25WzMTxuZsXxsdy/.test(await page.evaluate(() => (document.querySelector('#edPhotos iframe') || {}).src || '')));
await page.fill('#edPhIn', 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv');
await page.press('#edPhIn', 'Enter'); await page.waitForTimeout(400);
ph = await page.evaluate(() => ({ saved: window.trackApi.listings().find(l => l.id === 'lst_m').photosLink, frame: (document.querySelector('#edPhotos iframe') || {}).src || '', hint: (document.querySelector('#edPhotos .tk-hint') || {}).textContent || '' }));
ok('Pasting a Drive link saves it on the card and shows its photos', ph.saved === 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv' && /embeddedfolderview\?id=1AbCdEfGhIjKlMnOpQrStUv/.test(ph.frame) && !/MYLA0004/.test(ph.hint), JSON.stringify(ph));
await page.fill('#edPhIn', 'not a link'); await page.press('#edPhIn', 'Enter'); await page.waitForTimeout(300);
ok('…something that is not a link is refused', (await page.evaluate(() => window.trackApi.listings().find(l => l.id === 'lst_m').photosLink)) === 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUv');
await page.screenshot({ path: join(OUT, 'editor-photos.png') });
await page.evaluate(() => closeDetail()); await page.waitForTimeout(200);

// 6. A phone: the form fits.
page = await open({ width: 390, height: 844 });
await page.evaluate(() => openEditModal('lst_m', 'MYLA0004')); await page.waitForTimeout(700);
const fits = await page.evaluate(() => { const b = document.querySelector('#mModal .tk-box'); const r = b.getBoundingClientRect(); return r.right <= window.innerWidth + 1 && [...b.querySelectorAll('input, select')].every(e => { const q = e.getBoundingClientRect(); return !q.width || q.right <= r.right + 1; }); });
ok('Phone: the form fits, the paired fields side by side', fits);
await page.screenshot({ path: join(OUT, 'phone-form.png') });

await browser.close();
if (errors.length) { console.log('\nFAILED:\n  ' + errors.join('\n  ')); process.exit(1); }
console.log(`\nNo page errors. Screenshots in ${OUT}`);
