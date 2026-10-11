// Create brochure from the Posting tab: the board card made or used, mapped, the request sent through
// the board's own path (demo mode — nothing reaches the real form), the row and the card linked to the
// dashboard property once it is delivered, and photos / details kept in one place (the card).
//   node tests/posting-brochure-preview.mjs [out-dir]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStages } from '../track-assets/track-pipeline.js';

const OUT = process.argv[2] || 'tests/out/brochure-posting';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.now(), H = 3600000, DAY = 24 * H, T = 't_3pin';
const ST = defaultStages(), sid = k => ST.find(s => s.key === k).id;
const L = o => ({ tenantId: T, media: {}, tags: [], createdAt: NOW - 9 * DAY, updatedAt: NOW - DAY, stageChangedAt: NOW - DAY, ...o });
const LISTINGS = [
  // A card on the board for TNAG0010 that no Posting row knows yet (with notes of its own).
  L({ id: 'lX', title: 'Anna Nagar duplex', brochure: { code: 'TNAG0010' }, stageId: sid('shoot_done'), photosLink: 'https://drive.google.com/drive/folders/x', description: 'card desc', internalNotes: 'keys with guard' }),
  // Another card, opened and closed on the board before a Posting send (its panel stays in the page).
  L({ id: 'lO', title: 'OTHER CARD', brochure: { code: 'TNAG0009' }, stageId: sid('shoot_done'), photosLink: 'https://drive.google.com/drive/folders/OTHER', description: 'OTHER DESC', internalNotes: 'other notes' }),
  L({ id: 'lB', title: 'Studio T Nagar', propertyCode: '', brochure: { code: 'TNAG0005' }, stageId: sid('shoot_done'), photosLink: 'https://drive.google.com/drive/folders/card-b', description: '' })
];
const INV = [
  { id: 'TNAG0003', propertyCode: 'TNAG0003', name: '3BHK T Nagar', location: 'T Nagar' },
  { id: 'ADB0001', propertyCode: 'ADB0001', name: 'Corporate Lease', location: 'Adambakkam', photosLink: 'https://drive.google.com/drive/folders/c', detailsText: '8 apartments', brochureLink: 'https://drive.google.com/file/d/c/view' },
  { id: 'TNAG0007', propertyCode: 'TNAG0007', name: 'Villa T Nagar', location: 'T Nagar', photosLink: 'https://drive.google.com/drive/folders/v', detailsText: 'villa', brochureLink: 'https://drive.google.com/file/d/villa/view' }
];
const mk = o => ({ tenantId: T, channels: {}, brochure: { done: false }, acres99: { status: 'pending' }, website: { status: 'pending' }, createdAt: NOW - 5 * DAY, ...o });
const TRACKERS = [
  // Has a board card (by its code): photos come from the card, details from nowhere yet.
  mk({ id: 'pB', propertyCode: 'TNAG0005', title: 'Studio T Nagar', photosLink: 'https://drive.google.com/drive/folders/row-old', channels: { igReel: { status: 'scheduled', at: NOW + DAY } } }),
  // A plan line, no code, no card; a Reel scheduled (not live) → its card goes in Media ready.
  mk({ id: 'pN', reference: 'Kilpauk 2BHK', channels: { igReel: { status: 'scheduled', at: NOW + 2 * DAY } } }),
  // Code already in the dashboard, no brochure yet; a Story already live → its card goes in Live.
  mk({ id: 'pV', propertyCode: 'TNAG0003', title: '3BHK T Nagar', channels: { igStory: { status: 'live', at: NOW - DAY, liveAt: NOW - DAY, url: 'https://instagram.com/s/v' } } }),
  // A plan line whose property turns out to be TNAG0007 — already in the dashboard with its brochure.
  mk({ id: 'pW', reference: 'Villa in T Nagar', channels: { yt: { status: 'scheduled', at: NOW + DAY } } }),
  mk({ id: 'pX', reference: 'Duplex Anna Nagar', channels: { igReel: { status: 'scheduled', at: NOW + DAY } } }),
  mk({ id: 'pT', reference: 'Typo row', channels: { igReel: { status: 'scheduled', at: NOW + DAY } } }),
  // Linked to ADB0001 but its code was left half-typed ("AD"): the code must be the property's.
  mk({ id: 'pAD', propertyCode: 'AD', propertyId: 'ADB0001', title: 'Corporate Lease', channels: {} }),
  // Not linked yet; linked from the picker below.
  mk({ id: 'pL', propertyCode: 'XX', title: 'Something', channels: {} })
];
const STUB = `
window.__saved = []; window.__listings = []; window.__inv = ${JSON.stringify(INV)}; window.__forms = 0;
window.trackFirebase = {
  savePosting: async t => { window.__saved.push(JSON.parse(JSON.stringify(t))); },
  savePostings: async ws => { for (const w of ws) window.__saved.push(JSON.parse(JSON.stringify(w.t))); },
  deletePosting: async () => {}, saveTrackConfig: async () => {},
  saveListing: async l => { window.__listings.push(JSON.parse(JSON.stringify(l))); },
  deleteListing: async () => {}, savePipeline: async () => {}, patchLead: async () => {},
  getInventory: async () => JSON.parse(JSON.stringify(window.__inv)), getListingHistory: async () => [], saveHistory: async () => {}, deleteHistory: async () => {},
  getPropertyInternalNotes: async () => '', getLeadConversation: async () => null
};
window.trackAuth = { login: async () => {}, logout: async () => {}, getTenantId: () => '${T}', getIdToken: async () => null };
window.__demoMode = true;   // the board's request path records the request instead of sending it
setTimeout(() => {
  window.onTrackAuthChange({ email: 'admin@example.com' }, '${T}');
  window.applyTrackPipelineSnapshot(${JSON.stringify(ST)});
  window.applyTrackConfigSnapshot({});
  window.applyListingsSnapshot(${JSON.stringify(LISTINGS)});
  window.applyTrackLeadsSnapshot([]);
  window.applyPostingSnapshot(${JSON.stringify(TRACKERS)});
  window.__ready = true;
}, 0);`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg' };
const browser = await chromium.launch();
const errors = [];
const ok = (l, c, d) => { if (c) console.log('  ok  ' + l); else { errors.push(l + (d !== undefined ? ' — ' + d : '')); console.log('  FAIL ' + l + (d !== undefined ? ' — ' + d : '')); } };

let dismissNext = false;   // the page is frozen while a confirm is up: the flag lives here, not in it
async function open(viewport) {
  const ctx = await browser.newContext({ viewport });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // Confirms are accepted, unless a step asks for the next one to be dismissed (dismissNext).
  p.on('dialog', d => { if (dismissNext) { dismissNext = false; return d.dismiss(); } return d.accept(); });
  await p.addInitScript(() => { try { localStorage.setItem('posting.mode', 'sheet'); } catch (e) {} });
  await p.route('**/*', route => {
    const url = new URL(route.request().url());
    if (/docs\.google\.com/.test(url.hostname)) { errors.push('a request reached the real Google Form'); return route.abort(); }
    if (url.hostname !== 'track.local') return route.abort();
    if (url.pathname === '/track-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await p.goto('http://track.local/propertytrack.html?nav=posting');
  await p.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await p.waitForTimeout(300);
  return p;
}
const card = (p, pred) => p.evaluate(src => window.trackApi.listings().find(new Function('l', 'return ' + src)) || null, pred);
const row = (p, id) => p.evaluate(i => { const r = window.__saved.filter(x => x.id === i).pop(); return r || null; }, id);

const p = await open({ width: 1440, height: 950 });
console.log('one place for photos and details');
ok('A row with a board card reads its photos from the card (not its own old link)', await p.$eval('#pg-pB .ps-dot', e => e.classList.contains('ok')) && await p.evaluate(() => !document.querySelector('#pg-pB a[href*="row-old"]')));
await p.evaluate(() => pgOpenEdit('pB')); await p.waitForTimeout(100);
ok('Edit: photos come from the card, marked as shared', await p.$eval('#pgPhotos', i => i.value) === 'https://drive.google.com/drive/folders/card-b' && /board card/.test(await p.textContent('#pgBody')));
await p.fill('#pgDetails', '1BHK studio, 450 sqft, furnished'); await p.click('#pgSave'); await p.waitForTimeout(150);
const cb = await card(p, "l.id === 'lB'");
ok('…saving puts the details on the card, not a second copy on the row', cb.description === '1BHK studio, 450 sqft, furnished' && !((await row(p, 'pB')) || {}).details);

console.log('card exists → its brochure, mapped');
await p.evaluate(() => pgBrochure('pB')); await p.waitForTimeout(150);
ok('Create brochure: made from its board card', /Made from its board card/.test(await p.textContent('#pgBody')) && /TNAG0005/.test(await p.textContent('#pgBody')));
ok('…prefilled from the card (one place)', await p.$eval('#pgBroPhotos', i => i.value) === 'https://drive.google.com/drive/folders/card-b' && await p.$eval('#pgBroDesc', i => i.value) === '1BHK studio, 450 sqft, furnished');
await p.screenshot({ path: join(OUT, 'dialog-card.png') });
await p.click('#pgSave'); await p.waitForTimeout(400);
const cb2 = await card(p, "l.id === 'lB'");
ok('Request made on the card: code, requested, details kept', cb2.brochure.requestedCode === 'TNAG0005' && cb2.brochure.requestedAt > 0 && cb2.photosLink === 'https://drive.google.com/drive/folders/card-b');
ok('…the row shows the brochure as requested', /Requested|in queue/i.test(await p.$eval('#pg-pB', e => e.textContent)));

console.log('no code, no card → a code, a card in Media ready');
// A board card's panel opened and closed first: its boxes stay in the page and must not be sent for this one.
await p.evaluate(() => { toggleView('board'); openDetail('lO'); }); await p.waitForTimeout(250);
await p.evaluate(() => { closeDetail(); toggleView('posting'); }); await p.waitForTimeout(150);
await p.evaluate(() => pgBrochure('pN')); await p.waitForTimeout(150);
ok('Asks for a code; says a card is made in Media ready', !!(await p.$('#pgBroCode')) && /Media ready/.test(await p.textContent('#pgBody')));
await p.fill('#pgBroCode', 'TNAG'); await p.waitForTimeout(80);
const sug = await p.$$eval('#pgBroSug .bk-opt b', b => b.map(x => x.textContent));
ok('Suggests the next free code in the series first (TNAG0008), then existing ones', sug[0] === 'TNAG0008' && sug.includes('TNAG0003'), JSON.stringify(sug));
await p.click('#pgBroSug .bk-opt >> nth=0'); await p.waitForTimeout(60);
await p.click('#pgSave'); await p.waitForTimeout(150);
ok('Refuses with what is missing (photos, details)', /Still needed/.test(await p.textContent('#pgErr')) && /Photos link/.test(await p.textContent('#pgErr')));
await p.fill('#pgBroTitle', '2BHK Kilpauk'); await p.fill('#pgBroPhotos', 'https://drive.google.com/drive/folders/kil'); await p.fill('#pgBroDesc', '2BHK, 1050 sqft, east facing');
await p.click('#pgSave'); await p.waitForTimeout(400);
const cn = await card(p, "l.brochure && l.brochure.code === 'TNAG0008'");
ok('A board card is made, in Media ready (its posts are only scheduled)', cn && cn.stageId === sid('media_ready') && cn.source === 'posting', JSON.stringify(cn && cn.stageId));
ok('…with the brochure details on it, requested', cn && cn.title === '2BHK Kilpauk' && cn.photosLink === 'https://drive.google.com/drive/folders/kil' && cn.description === '2BHK, 1050 sqft, east facing' && cn.brochure.requestedAt > 0);
ok('…and the row has the code (row, card and dashboard find each other by it)', ((await row(p, 'pN')) || {}).propertyCode === 'TNAG0008');
ok('A board card closed earlier is not read: the other card is untouched', await p.evaluate(() => { const o = window.trackApi.listings().find(l => l.id === 'lO'); return o.title === 'OTHER CARD' && !(o.brochure && o.brochure.requestedAt); }) && cn.title !== 'OTHER CARD');

console.log('a code already on a board card → that card, its notes kept');
await p.evaluate(() => pgBrochure('pX')); await p.waitForTimeout(150);
await p.fill('#pgBroCode', 'TNAG0010'); await p.dispatchEvent('#pgBroCode', 'input'); await p.waitForTimeout(120);
ok('Says the code is on the board already, and shows that card’s details', /on the board already/.test(await p.textContent('#pgBroWhere')) && await p.$eval('#pgBroDesc', i => i.value) === 'card desc' && await p.$eval('#pgBroInt', i => i.value) === 'keys with guard');
await p.click('#pgSave'); await p.waitForTimeout(400);
const cx = await card(p, "l.id === 'lX'");
ok('Sent on that card, its internal notes kept, no second card', cx.brochure.requestedAt > 0 && cx.internalNotes === 'keys with guard' && await p.evaluate(() => window.trackApi.listings().filter(l => l.brochure && l.brochure.code === 'TNAG0010').length === 1));

console.log('a confirm said no → nothing saved');
await p.evaluate(() => pgBrochure('pT')); await p.waitForTimeout(150);
await p.fill('#pgBroCode', 'TNGA0003'); await p.dispatchEvent('#pgBroCode', 'input');
await p.fill('#pgBroTitle', 'Typo'); await p.fill('#pgBroPhotos', 'https://drive.google.com/drive/folders/t'); await p.fill('#pgBroDesc', 'typo');
const cardsBefore = await p.evaluate(() => window.trackApi.listings().length);
dismissNext = true;
await p.click('#pgSave'); await p.waitForTimeout(300);
ok('"Check the code — TNAG0003 already exists": cancelled → the dialog stays, no code saved, no card made', await p.evaluate(() => document.getElementById('pgModal').classList.contains('open')) && !((await row(p, 'pT')) || {}).propertyCode && await p.evaluate(n => window.trackApi.listings().length === n, cardsBefore));
await p.evaluate(() => pgClose()); await p.waitForTimeout(80);

console.log('already in the dashboard, no brochure → linked, then its brochure');
await p.evaluate(() => pgBrochure('pV')); await p.waitForTimeout(250);
ok('Says it is in the dashboard; sending links and makes its brochure; card in Live (a post is live)', /already in the Property dashboard/.test(await p.textContent('#pgBroCheck')) && /Live — marketing/.test(await p.textContent('#pgBody')));
await p.fill('#pgBroPhotos', 'https://drive.google.com/drive/folders/tn3'); await p.fill('#pgBroDesc', '3BHK, 1600 sqft');
await p.click('#pgSave'); await p.waitForTimeout(500);
const cv = await card(p, "l.propertyCode === 'TNAG0003'");
ok('A card in Live — marketing, mapped to TNAG0003, brochure requested', cv && cv.stageId === sid('live') && cv.brochure && cv.brochure.requestedAt > 0, JSON.stringify(cv && { s: cv.stageId, b: cv.brochure }));
ok('…the row linked to the dashboard property', ((await row(p, 'pV')) || {}).propertyId === 'TNAG0003');

console.log('a plan line that turns out to be a property with its brochure → just linked');
await p.evaluate(() => pgBrochure('pW')); await p.waitForTimeout(200);
await p.fill('#pgBroCode', 'TNAG0007'); await p.dispatchEvent('#pgBroCode', 'input'); await p.waitForTimeout(80);
ok('Says it has its brochure — "Link it", nothing rebuilt', /It has its brochure/.test(await p.textContent('#pgBroCheck')) && await p.textContent('#pgSave') === 'Link it');
await p.fill('#pgBroTitle', 'Villa T Nagar'); await p.fill('#pgBroPhotos', 'https://drive.google.com/drive/folders/v'); await p.fill('#pgBroDesc', 'villa');
const formsBefore = await p.evaluate(() => window.trackApi.listings().filter(l => l.brochure && l.brochure.requestedAt).length);
await p.click('#pgSave'); await p.waitForTimeout(500);
const cw = await card(p, "l.propertyCode === 'TNAG0007'");
ok('A card made and mapped to TNAG0007 — no new request', cw && await p.evaluate(() => window.trackApi.listings().filter(l => l.brochure && l.brochure.requestedAt).length) === formsBefore, JSON.stringify(cw && cw.brochure));
ok('…the row takes the code and is linked', ((await row(p, 'pW')) || {}).propertyCode === 'TNAG0007' && ((await row(p, 'pW')) || {}).propertyId === 'TNAG0007');

console.log('delivered → mapped and linked by themselves');
await p.evaluate(() => { window.__inv.push({ id: 'TNAG0008', propertyCode: 'TNAG0008', name: '2BHK Kilpauk', photosLink: 'https://drive.google.com/drive/folders/kil', detailsText: '2BHK, 1050 sqft, east facing', brochureLink: 'https://drive.google.com/file/d/kil/view' }); });
await p.evaluate(() => window.bpReconcile(true)); await p.waitForTimeout(500);
const cn2 = await card(p, "l.brochure && l.brochure.code === 'TNAG0008'");
ok('The card is mapped to the new property, its brochure linked', cn2.propertyCode === 'TNAG0008' && cn2.brochureLink === 'https://drive.google.com/file/d/kil/view' && cn2.brochure.doneAt > 0, JSON.stringify({ c: cn2.propertyCode, l: cn2.brochureLink }));
await p.evaluate(() => { pgMode('sheet'); }); await p.waitForTimeout(200);
ok('The row is linked to the dashboard property by itself', ((await row(p, 'pN')) || {}).propertyId === 'TNAG0008');
ok('…and shows the brochure created, with its link', /Created/.test(await p.$eval('#pg-pN', e => e.textContent)) && !!(await p.$('#pg-pN a[href="https://drive.google.com/file/d/kil/view"]')));
await p.screenshot({ path: join(OUT, 'sheet-after.png'), fullPage: false });
await p.evaluate(() => pgOpenEdit('pN')); await p.waitForTimeout(120);
ok('Edit: its brochure is made — photos and details are read-only there', await p.$eval('#pgDetails', e => e.readOnly) && /redo the brochure/.test(await p.textContent('#pgBody')));
await p.evaluate(() => pgClose()); await p.waitForTimeout(80);
await p.evaluate(() => pgUnlink('pN')); await p.waitForTimeout(100);
await p.evaluate(() => pgMode('today')); await p.waitForTimeout(100);
ok('Unlinked by hand: not linked back by itself', !((await row(p, 'pN')) || {}).propertyId);
await p.close();

console.log('code, details and brochure from the same property');
{
  const q = await open({ width: 1440, height: 950 });
  await q.waitForTimeout(300);
  const ad = await q.evaluate(() => window.__saved.filter(x => x.id === 'pAD').pop());
  ok('A row linked to ADB0001 with a wrong code ("AD") takes ADB0001 by itself', ad && ad.propertyCode === 'ADB0001' && ad.propertyId === 'ADB0001', JSON.stringify(ad && ad.propertyCode));
  await q.evaluate(() => { pgOpenLink('pL'); }); await q.waitForTimeout(200);
  await q.evaluate(() => pgPick('TNAG0007')); await q.waitForTimeout(150);
  const l = await q.evaluate(() => window.__saved.filter(x => x.id === 'pL').pop());
  ok('Linking a row to a property sets its code to that property\'s', l && l.propertyCode === 'TNAG0007' && l.propertyId === 'TNAG0007');
  await q.close();
}

console.log('a wrong code on a row whose posts are right → change the code, the posts stay');
{
  const q = await open({ width: 1440, height: 950 });
  // pV is TNAG0003 with a live Story; the code was a mistake — the property is TNAG0007.
  await q.evaluate(() => pgOpenEdit('pV')); await q.waitForTimeout(150);
  ok('A set code is read-only, with "Change code"', await q.$eval('#pgCodeIn', i => i.readOnly) && !!(await q.$('#pgCodeUnlock')));
  await q.click('#pgCodeUnlock'); await q.waitForTimeout(80);
  ok('…"Change code" unlocks it', await q.$eval('#pgCodeIn', i => !i.readOnly) && !(await q.$('#pgCodeUnlock')));
  // Typing a code shows what exists, like the board's Property ID box.
  await q.fill('#pgCodeIn', 'TNAG'); await q.dispatchEvent('#pgCodeIn', 'input'); await q.waitForTimeout(120);
  const sugg = await q.$$eval('#pgCodeSug .bk-opt', o => o.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  ok('Property code: typing shows the codes in the dashboard and the next free one', sugg.some(t => /^TNAG0007s*in the dashboard — Villa T Nagar/.test(t)) && sugg.some(t => /next free in TNAG/.test(t)), JSON.stringify(sugg));
  await q.$eval('#pgCodeIn', i => i.scrollIntoView({ block: 'center' })); await q.screenshot({ path: join(OUT, 'code-suggestions.png') });
  await q.fill('#pgCodeIn', 'TNAG0007'); await q.dispatchEvent('#pgCodeIn', 'input'); await q.waitForTimeout(80);
  await q.screenshot({ path: join(OUT, 'code-verdict.png') });
  ok('…and says what saving does: in the dashboard, the row moves to it', /TNAG0007 is in the Property dashboard — Villa T Nagar/.test(await q.textContent('#pgCodeV')) && /moves this row to it/.test(await q.textContent('#pgCodeV')));
  await q.fill('#pgCodeIn', 'ZZZ0001'); await q.dispatchEvent('#pgCodeIn', 'input'); await q.waitForTimeout(80);
  ok('…not in the dashboard: a new code', /not in the Property dashboard yet/.test(await q.textContent('#pgCodeV')));
  await q.fill('#pgCodeIn', 'TNAG0005'); await q.dispatchEvent('#pgCodeIn', 'input'); await q.waitForTimeout(80);
  ok('…a code another Posting row has: refused, naming that row', /already used by “Studio T Nagar”/.test(await q.textContent('#pgCodeV')));
  await q.fill('#pgCodeIn', 'TNAG0003'); await q.dispatchEvent('#pgCodeIn', 'input');
  ok('Property details: the code can be changed (not locked any more)', await q.$eval('#pgCodeIn', i => !i.disabled) && /Wrong property\?/.test(await q.textContent('#pgBody')));
  await q.fill('#pgCodeIn', 'TNAG0007');
  await q.click('#pgSave'); await q.waitForTimeout(200);
  const r = await q.evaluate(() => window.__saved.filter(x => x.id === 'pV').pop());
  ok('Moved to TNAG0007 and linked to it; title and details taken from it', r && r.propertyCode === 'TNAG0007' && r.propertyId === 'TNAG0007' && r.title === 'Villa T Nagar' && r.details === 'villa', JSON.stringify(r && { c: r.propertyCode, id: r.propertyId, t: r.title }));
  ok('…its live Story and link untouched', r && r.channels.igStory.status === 'live' && r.channels.igStory.url === 'https://instagram.com/s/v');
  await q.evaluate(() => pgOpenEdit('pB')); await q.waitForTimeout(120);
  await q.click('#pgCodeUnlock'); await q.fill('#pgCodeIn', 'TNAG0007'); await q.click('#pgSave'); await q.waitForTimeout(120);
  ok('A code another row has is refused', /already used by/.test(await q.textContent('#pgErr')));
  await q.evaluate(() => pgClose());
  // Clearing the code takes off what came with it (photos, details, brochure); the posts stay.
  await q.evaluate(() => pgOpenEdit('pV')); await q.waitForTimeout(120);
  await q.click('#pgCodeUnlock'); await q.fill('#pgCodeIn', ''); await q.click('#pgSave'); await q.waitForTimeout(200);
  const r2 = await q.evaluate(() => window.__saved.filter(x => x.id === 'pV').pop());
  ok('Code removed: unlinked, the property\'s photos and details gone, posts kept', r2 && !r2.propertyCode && !r2.propertyId && !r2.photosLink && !r2.details && r2.channels.igStory.status === 'live', JSON.stringify(r2 && { c: r2.propertyCode, p: r2.photosLink, d: r2.details }));
  ok('…and its brochure no longer shows as created', !/Created/.test(await q.$eval('#pg-pV', e => e.textContent)));
  await q.close();
}

const ph = await open({ width: 390, height: 844 });
await ph.evaluate(() => pgBrochure('pN')); await ph.waitForTimeout(150);
ok('Phone: the dialog fits, no sideways scroll', await ph.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
await ph.screenshot({ path: join(OUT, 'phone-dialog.png') });
await ph.close();

await browser.close();
console.log(errors.length ? `\n${errors.length} problem(s):\n  ${errors.join('\n  ')}` : '\nAll good.');
process.exit(errors.length ? 1 : 0);
