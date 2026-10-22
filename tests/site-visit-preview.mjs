// ═══════ SITE VISIT CONFIRMATION — in the real pages ═══════
//
//   node tests/site-visit-preview.mjs [out-dir]        (PW_CHANNEL=chrome to use the installed Chrome)
//
// The Property dashboard's "📅 Site visit" and the CRM lead's "💬 Confirmation", driven as a person
// would: only the client's name and the time typed; the property, its map pin, who meets them and the
// client's number filled from where they already are. Every property in the real inventory snapshot is
// opened once. Screenshots at laptop and phone width go to the out-dir.

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPipelineMigration } from '../crm-assets/pipeline.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] || 'tests/out/site-visit';
mkdirSync(OUT, { recursive: true });
const T = 't_3pinrealty';
const NOW = new Date(new Date().setHours(10, 0, 0, 0)).getTime(), D = 86400000;
const INV = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/properties-snapshot.json'), 'utf8')).map(p => ({ ...p, tenantId: T }));
const TEAM = ['sales@threepin.in', 'admin@threepin.in', 'thirumal@threepin.in', 'pradeep@threepin.in', 'swami@threepin.in'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };

const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});

async function open(host, page0, stub, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.clock.setFixedTime(NOW);
  await ctx.addInitScript(() => {
    try { localStorage.clear(); } catch (e) {}
    window.__opened = [];
    window.open = (url) => { window.__opened.push(url); return null; };
    // The test origin is plain http, so Copy takes the select-and-copy path: what it copies is recorded.
    document.execCommand = cmd => { if (cmd === 'copy') window.__copied = document.activeElement && document.activeElement.value; return true; };
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${host} ${viewport.width}px pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|permissions|listen failed/i.test(m.text())) errors.push(`${host} console: ${m.text()}`); });
  page.on('dialog', d => d.accept());
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname !== host) return route.abort();
    if (u.pathname === stub.path) return route.fulfill({ contentType: 'text/javascript', body: stub.body });
    if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true,"replies":[]}' });
    const f = join(ROOT, decodeURIComponent(u.pathname));
    if (!existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
  });
  await page.goto(`http://${host}/${page0}`);
  await page.waitForFunction(() => window.__ready === true && !!window.openSiteVisitDialog, null, { timeout: 20000 });
  return page;
}
const msg = page => page.inputValue('#svmMsg');
const fits = page => page.evaluate(() => {
  const b = document.querySelector('#svmModal .svm-box').getBoundingClientRect();
  return b.left >= 0 && b.right <= innerWidth + 0.5 && document.documentElement.scrollWidth <= innerWidth + 1;
});

// ═══════ PROPERTY DASHBOARD ═══════
const DASH_STUB = `
window.__saves = []; window.__notes = []; window.__changes = [];
window.dashboardFirebase = {
  saveProperty: async p => { window.__saves.push(JSON.parse(JSON.stringify(p))); }, deleteProperty: async () => {}, saveFavorites: async () => {},
  saveChange: async c => { window.__changes.push(c); }, saveChanges: async cs => { window.__changes.push(...cs); }, getChanges: async () => [], saveNaFields: async () => {},
  getPropertyNotes: async () => [], savePropertyNote: async (id, n) => { window.__notes.push({ id, n }); },
  getInternalNotes: async () => [],
  getTeam: async () => ${JSON.stringify(TEAM)}
};
window.dashboardAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => '${T}', getUserEmail: () => 'thirumal@threepin.in' };
if (window.onDashboardAuthChange) window.onDashboardAuthChange({ email: 'thirumal@threepin.in' });
window.applyPropertiesSnapshot(${JSON.stringify(INV)});
window.__ready = true;
`;
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const phone = viewport.width < 600;
  console.log(`\nProperty dashboard — ${phone ? 'phone' : 'laptop'}`);
  const page = await open('dash.local', 'dashboard.html', { path: '/dashboard-assets/firebase-sync.js', body: DASH_STUB }, viewport);

  // A rental flat with no map link of its own.
  await page.evaluate(() => openDetail('POR0002'));
  await page.waitForTimeout(300);
  const btn = page.locator('#dpHdrActions button:has-text("Site visit"), .dp-hdr-actions button:has-text("Site visit")').first();
  ok('The property page has a "Site visit" button', await btn.count() > 0);
  await btn.click();
  await page.waitForSelector('#svmModal.open');
  await page.waitForTimeout(120);
  ok('The dialog opens on that property', /POR0002/.test(await page.textContent('#svmFor')));
  ok('…the property is fixed (no picker on its own page)', await page.isHidden('#svmPropWrap'));
  ok('…focus is in the client\'s name', await page.evaluate(() => document.activeElement && document.activeElement.id === 'svmName'));
  let m = await msg(page);
  ok('…a message is there before anything is typed', m.startsWith('🏡 *SITE VISIT CONFIRMATION | 3 PIN REALTY*') && m.endsWith('*Team 3 PIN Realty*'));
  ok('…with the rent and its maintenance', m.includes('• *Monthly Rent:* ₹1,30,000/month + ₹14,000/month Maintenance'), m);
  ok('…no map pin: says so, and no map lines', /no map pin/i.test(await page.textContent('#svmMapHint')) && !m.includes('Google Maps'));
  ok('…the time offered is the next half hour, today', /\*today, \d+(st|nd|rd|th) [A-Z][a-z]+, at 10:30 AM\.\*/.test(m), m.split('\n')[4]);

  // Only the name and the time.
  await page.fill('#svmName', 'Nitin');
  await page.click('#svmTitles button[data-title="Mr."]');
  await page.selectOption('#svmTime', '14:00');
  m = await msg(page);
  ok('Name and Mr.: "Dear Mr. Nitin,"', m.includes('Dear Mr. Nitin,'));
  ok('Time picked: "today, <date>, at 2:00 PM"', /\*today, \d+(st|nd|rd|th) [A-Z][a-z]+, at 2:00 PM\.\*/.test(m));
  await page.fill('#svmDay', new Date(NOW + D).toISOString().slice(0, 10).replace(/^(.{8}).*/, (_, a) => { const d = new Date(NOW + D); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }));
  ok('Tomorrow: "tomorrow, <date>, at 2:00 PM"', /\*tomorrow, \d+(st|nd|rd|th) [A-Z][a-z]+, at 2:00 PM\.\*/.test(await msg(page)));
  ok('Times are in 15-minute steps', await page.evaluate(() => [...document.querySelectorAll('#svmTime option')].every(o => /:(00|15|30|45)$/.test(o.value))));

  // Who meets them: the team by name (sales@/admin@ are not people), with the number remembered.
  const hosts = await page.evaluate(() => [...document.querySelectorAll('#svmHost option')].map(o => o.textContent));
  ok('Who meets them: nobody, the team by name, caretaker, owner, someone else', JSON.stringify(hosts) === JSON.stringify(['Nobody named', 'Pradeep', 'Swami', 'Thirumal', 'The caretaker', 'The owner', 'Someone else…']), JSON.stringify(hosts));
  await page.selectOption('#svmHost', 'team:Thirumal');
  ok('Thirumal: his number filled in', await page.inputValue('#svmHostPhone') === '99418 80088');
  m = await msg(page);
  ok('…"Thirumal from 3 PIN Realty will meet you" and the contact', m.includes('Thirumal from 3 PIN Realty will meet you at the location') && m.includes('📞 *Contact:* 99418 80088'));
  await page.selectOption('#svmHost', 'team:Pradeep');
  await page.fill('#svmHostPhone', '98765 43210');
  ok('Pradeep, number typed: in the message', (await msg(page)).includes('📞 *Contact:* 98765 43210'));
  await page.selectOption('#svmHost', 'caretaker');
  ok('The caretaker: "The caretaker will assist you"', (await msg(page)).includes('The caretaker will assist you during the site visit.'));
  await page.selectOption('#svmHost', 'other');
  ok('Someone else: a name box appears', await page.isVisible('#svmHostName'));
  await page.fill('#svmHostName', 'Ravi');
  ok('…"Ravi from 3 PIN Realty"', (await msg(page)).includes('Ravi from 3 PIN Realty will meet you'));
  await page.selectOption('#svmHost', '');
  ok('Nobody named: no line about who', !/will meet you|will assist you during/.test(await msg(page)));

  // The map pin pasted: in the message, and offered to be kept on the property.
  ok('No pasted link yet: no "save on the property"', await page.isHidden('#svmSaveMapWrap'));
  await page.fill('#svmMap', 'https://maps.app.goo.gl/TESTPIN123');
  ok('Pasted link: in the message', (await msg(page)).includes('📌 *Google Maps Location:*\nhttps://maps.app.goo.gl/TESTPIN123'));
  ok('…"Save this link on the property" offered, ticked', await page.isVisible('#svmSaveMapWrap') && await page.isChecked('#svmSaveMap'));

  // Editing the message by hand: kept until asked to rewrite.
  await page.fill('#svmMsg', (await msg(page)) + '\nP.S. Bring ID.');
  await page.fill('#svmName', 'Nitin Kumar');
  ok('Hand edits survive a change to the fields', (await msg(page)).includes('P.S. Bring ID.') && !(await msg(page)).includes('Nitin Kumar'));
  await page.click('#svmRewrite');
  ok('"Rewrite from the fields" brings the fields back', (await msg(page)).includes('Dear Mr. Nitin Kumar,') && !(await msg(page)).includes('P.S.'));

  // Copy: the message on the clipboard, the link saved on the property, the person remembered.
  await page.selectOption('#svmHost', 'team:Pradeep');
  await page.fill('#svmHostPhone', '98765 43210');
  await page.click('#svmModal [data-svm="copy"]');
  await page.waitForTimeout(300);
  const clip = await page.evaluate(() => window.__copied);
  ok('Copy: the message is on the clipboard', clip === await msg(page));
  const saved = await page.evaluate(() => window.__saves.at(-1));
  ok('…the pasted link saved on the property', saved && saved.id === 'POR0002' && saved.mapLink === 'https://maps.app.goo.gl/TESTPIN123', JSON.stringify(saved && saved.mapLink));
  await page.click('#svmModal [data-svm="close"]');
  await page.click('#dpHdrActions button:has-text("Site visit"), .dp-hdr-actions button:has-text("Site visit")');
  await page.selectOption('#svmHost', 'team:Pradeep');
  ok('Next time: Pradeep\'s number remembered', await page.inputValue('#svmHostPhone') === '98765 43210');
  ok('…and the saved map pin filled in', await page.inputValue('#svmMap') === 'https://maps.app.goo.gl/TESTPIN123' && !/no map pin/i.test(await page.textContent('#svmMapHint')));
  ok('…a fresh dialog: the name is empty again', await page.inputValue('#svmName') === '');
  ok('…and no "save" offered for the link the property now has', await page.isHidden('#svmSaveMapWrap'));
  let note = await page.evaluate(() => window.__notes.at(-1));
  ok('The pin given for the visit is logged in the property\'s Notes', note && note.id === 'POR0002' && /Map pin added — for a site visit: https:\/\/maps\.app\.goo\.gl\/TESTPIN123/.test(note.n.text), JSON.stringify(note));
  ok('…and the property page shows it: header link and the Map Pin row', await page.evaluate(() =>
    !!document.querySelector('#dpHero a[href="https://maps.app.goo.gl/TESTPIN123"]') && !!document.querySelector('#dpMapRow a[href="https://maps.app.goo.gl/TESTPIN123"]')));
  // Changed in the dialog: the property follows.
  await page.fill('#svmMap', 'https://maps.app.goo.gl/CHANGED456');
  ok('A different link: "Update the property\'s map pin" offered', await page.isVisible('#svmSaveMapWrap') && /Update the property/.test(await page.textContent('#svmSaveMapText')));
  await page.click('#svmModal [data-svm="copy"]');
  await page.waitForTimeout(250);
  note = await page.evaluate(() => window.__notes.at(-1));
  ok('…saved, and the change noted with the old one', (await page.evaluate(() => window.__saves.at(-1).mapLink)) === 'https://maps.app.goo.gl/CHANGED456' && /Map pin changed — for a site visit: https:\/\/maps\.app\.goo\.gl\/CHANGED456 \(was https:\/\/maps\.app\.goo\.gl\/TESTPIN123\)/.test(note.n.text), note && note.n.text);
  await page.click('#svmModal [data-svm="close"]');
  ok('…the Map Pin row shows the new one', await page.evaluate(() => !!document.querySelector('#dpMapRow a[href="https://maps.app.goo.gl/CHANGED456"]')));

  // Changed on the property page itself: the next site visit message follows.
  await page.evaluate(() => { document.querySelectorAll('.dp-tab')[0].click(); document.getElementById('dpMapRow').scrollIntoView(); });
  await page.click('#dpMapRow .conn-mapedit');
  ok('Map Pin row: "Change" opens a box with the current link', await page.inputValue('#dpMapIn') === 'https://maps.app.goo.gl/CHANGED456');
  await page.fill('#dpMapIn', 'not a link');
  await page.click('#dpMapRow button:has-text("Save")');
  ok('…not a link: refused, with how to get one', /not a link/i.test(await page.textContent('#dpMapErr')));
  await page.fill('#dpMapIn', 'https://maps.app.goo.gl/FROMPAGE789');
  await page.press('#dpMapIn', 'Enter');
  await page.waitForTimeout(250);
  ok('…Enter saves it: the row and header show it', await page.evaluate(() => !!document.querySelector('#dpMapRow a[href="https://maps.app.goo.gl/FROMPAGE789"]') && !!document.querySelector('#dpHero a[href="https://maps.app.goo.gl/FROMPAGE789"]')));
  note = await page.evaluate(() => window.__notes.at(-1));
  ok('…noted: "changed — on the property page"', /Map pin changed — on the property page: https:\/\/maps\.app\.goo\.gl\/FROMPAGE789/.test(note.n.text), note.n.text);
  ok('…kept as a dashboard edit (to carry to the sheet), so the sync does not undo it', await page.evaluate(() => window.__changes.some(c => c.propertyId === 'POR0002' && c.field === 'mapLink' && c.to === 'https://maps.app.goo.gl/FROMPAGE789' && c.appliedToSheet === false)), JSON.stringify(await page.evaluate(() => window.__changes.at(-1))));
  await page.click('#dpHdrActions button:has-text("Site visit"), .dp-hdr-actions button:has-text("Site visit")');
  ok('The next site visit message has the new pin', (await msg(page)).includes('https://maps.app.goo.gl/FROMPAGE789') && await page.isHidden('#svmSaveMapWrap'));
  // A property with no pin: "+ Add the Maps link" in its row.
  await page.click('#svmModal [data-svm="close"]');
  await page.evaluate(() => openDetail('NGMA002'));
  await page.waitForTimeout(200);
  ok('No pin: the row says so, with "+ Add the Maps link"', /No map pin yet/.test(await page.textContent('#dpMapRow')) && /Add the Maps link/.test(await page.textContent('#dpMapRow')));
  const placeName = await page.evaluate(() => { const p = properties.find(x => x.mapLink && !/^https?:/.test(x.mapLink)); openDetail(p.id); return p.id; });
  await page.waitForTimeout(150);
  ok('A place name as the pin: shown as a place name, with "Change"', /a place name, not a Maps link/.test(await page.textContent('#dpMapRow')) && /Change/.test(await page.textContent('#dpMapRow')), placeName);
  await page.evaluate(() => openDetail('POR0002'));
  await page.waitForTimeout(150);
  await page.click('#dpHdrActions button:has-text("Site visit"), .dp-hdr-actions button:has-text("Site visit")');

  // WhatsApp: the client's chat when the number is given; WhatsApp asks whom when it is not.
  await page.fill('#svmName', 'Aiswarya');
  await page.click('#svmTitles button[data-title="Ma\'am"]');
  await page.click('#svmModal [data-svm="wa"]');
  let url = await page.evaluate(() => window.__opened.at(-1));
  ok('WhatsApp with no number: wa.me/?text=…', /^https:\/\/wa\.me\/\?text=/.test(url), url && url.slice(0, 40));
  ok('…carrying the whole message', decodeURIComponent(url.split('text=')[1]) === await msg(page));
  await page.click('#svmMore summary');
  await page.fill('#svmPhone', '98400 12345');
  await page.click('#svmModal [data-svm="wa"]');
  url = await page.evaluate(() => window.__opened.at(-1));
  ok('WhatsApp with the client\'s number: straight to their chat', url.startsWith('https://wa.me/919840012345?text='), url.slice(0, 40));
  ok('The dialog fits the screen', await fits(page));
  await page.screenshot({ path: join(OUT, `dashboard-${viewport.width}.png`) });
  await page.keyboard.press('Escape');
  ok('Escape closes it', await page.isHidden('#svmModal'));

  if (!phone) {
    // Every property in the inventory: opens, and writes a whole message.
    const bad = await page.evaluate(async () => {
      const out = [];
      for (const p of properties) {
        openSiteVisit(p.id);
        await new Promise(r => setTimeout(r, 0));
        const m = document.getElementById('svmMsg').value;
        if (!document.getElementById('svmModal').classList.contains('open') || !m.startsWith('🏡') && !m.startsWith('🏢') || !m.endsWith('*Team 3 PIN Realty*') || /undefined|null|NaN/.test(m)) out.push(p.propertyCode || p.id);
        if (p.mapLink && /^https?:/.test(p.mapLink) && !m.includes(p.mapLink)) out.push((p.propertyCode || p.id) + ' (map)');
      }
      return out;
    });
    ok(`All ${INV.length} properties: the dialog opens and writes a whole message`, !bad.length, bad.join(', '));
    // A commercial one, for the eye.
    await page.evaluate(() => { openDetail('ASNC001'); openSiteVisit('ASNC001'); });
    await page.waitForTimeout(150);
    ok('Commercial: the office-block emoji', (await msg(page)).startsWith('🏢'));
    await page.screenshot({ path: join(OUT, 'dashboard-commercial.png') });
  }
}

// ═══════ CRM — from the lead's site visit booking ═══════
const STAGES = planPipelineMigration([{ id: 'new', name: 'New' }, { id: 'site_visit', name: 'Site Visit' }], []).stages;
const sid = k => STAGES.find(s => s.key === k).id;
const VISIT_AT = new Date(NOW + D).setHours(11, 0, 0, 0);
const LEADS = [
  { id: 'V1', tenantId: T, name: 'Ram Rajappa', phone: '+91 98400 11111', source: 'manual', stageId: sid('visit_pending'),
    siteVisitAt: VISIT_AT, siteVisitStatus: 'scheduled', siteVisitProperty: 'NGMA002', siteVisitAgents: ['thirumal@threepin.in'],
    createdAt: NOW - 2 * D, updatedAt: NOW - D, reached: { new: NOW - 2 * D } },
  // Booked with no property — but the lead has exactly one property linked.
  { id: 'V2', tenantId: T, name: 'Linked Only', phone: '9840022222', source: 'manual', stageId: sid('visit_pending'),
    siteVisitAt: VISIT_AT, siteVisitStatus: 'scheduled', propertyCodes: ['POR0002'], siteVisitAgents: ['sales@threepin.in'],
    createdAt: NOW - 2 * D, updatedAt: NOW - D, reached: { new: NOW - 2 * D } },
  // Booked with nothing to go on: the property is picked in the dialog.
  { id: 'V3', tenantId: T, name: '', phone: '', source: 'manual', stageId: sid('visit_pending'),
    siteVisitAt: VISIT_AT, siteVisitStatus: 'requested', createdAt: NOW - 2 * D, updatedAt: NOW - D, reached: { new: NOW - 2 * D } },
  // Cancelled, and not booked: no confirmation to send.
  { id: 'V4', tenantId: T, name: 'Cancelled', source: 'manual', stageId: sid('visit_pending'), siteVisitAt: VISIT_AT, siteVisitStatus: 'cancelled',
    createdAt: NOW - 2 * D, updatedAt: NOW - D, reached: { new: NOW - 2 * D } },
  { id: 'V5', tenantId: T, name: 'Not Booked', source: 'manual', stageId: sid('new'), createdAt: NOW - 2 * D, updatedAt: NOW - D, reached: { new: NOW - 2 * D } },
];
const CRM_STUB = `
window.__savedLeads = [];
window.crmFirebase = {
  saveLead: async l => { window.__savedLeads.push(JSON.parse(JSON.stringify(l))); }, deleteLead: async () => {}, getLeadNotes: async () => [], getLeadHistory: async () => [],
  saveNote: async () => {}, deleteNoteDoc: async () => {}, saveHistory: async () => {}, savePipeline: async () => {},
  getBotConfig: async () => null, saveBotConfig: async () => {}, saveEnquiryTypes: async () => {}, saveProperties: async () => {},
  saveFollowupDigestSettings: async () => {}, saveDashboardEmailSettings: async () => {}, releaseLeadField: async () => {},
  getLeadTailorTalk: async () => null, updateLeadAi: async () => {}, saveAutomationSettings: async () => {},
  saveView: async () => {}, deleteView: async () => {},
  getInventory: async () => (${JSON.stringify(INV)})
};
window.applyTeamSnapshot(${JSON.stringify(Object.fromEntries(TEAM.map(e => [e.split('@')[0], { email: e }])))});
window.crmAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => '${T}' };
window.onCrmAuthChange({ email: 'thirumal@threepin.in' });
window.applyPipelineSnapshot(${JSON.stringify(STAGES)});
window.applyEnquiryTypesSnapshot(['Property Enquiry','Seller Listing','General']);
window.applyAutomationSettingsSnapshot({ enabled: true });
if (window.applyViewsSnapshot) window.applyViewsSnapshot({});
window.applyLeadsSnapshot(${JSON.stringify(LEADS)});
window.__ready = true;
`;
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  const phone = viewport.width < 600;
  console.log(`\nCRM — ${phone ? 'phone' : 'laptop'}`);
  const page = await open('crm.local', 'crm.html', { path: '/crm-assets/firebase-sync.js', body: CRM_STUB }, viewport);
  const confirmBtn = () => page.locator('#dpVisit button:has-text("Confirmation")');

  await page.evaluate(() => openDetail('V1'));
  await page.waitForTimeout(400);
  ok('A booked visit: "💬 Confirmation" beside Reschedule', await confirmBtn().count() === 1);
  await confirmBtn().click();
  await page.waitForSelector('#svmModal.open');
  await page.waitForTimeout(100);
  let m = await msg(page);
  ok('Opens with the property booked on the visit', await page.inputValue('#svmProp') === 'NGMA002' && /NGMA002/.test(await page.textContent('#svmFor')));
  ok('…the client\'s name from the lead', await page.inputValue('#svmName') === 'Ram Rajappa' && m.includes('Dear Ram Rajappa,'));
  ok('…the booked time: "tomorrow, <date>, at 11:00 AM"', /\*tomorrow, \d+(st|nd|rd|th) [A-Z][a-z]+, at 11:00 AM\.\*/.test(m), m.split('\n')[4]);
  ok('…the agent sent, with his number', await page.inputValue('#svmHost') === 'team:Thirumal' && m.includes('Thirumal from 3 PIN Realty will meet you') && m.includes('📞 *Contact:* 99418 80088'));
  ok('…the lead\'s number for WhatsApp', await page.inputValue('#svmPhone') === '98400 11111');
  ok('…the flat\'s price, area and UDS', m.includes('• *Price:* ₹3.35 Crore (All Inclusive)') && m.includes('• *UDS:* 675 Sq.Ft.'));
  ok('…focus on the time (the name is already there)', await page.evaluate(() => document.activeElement && document.activeElement.id === 'svmTime'));
  await page.click('#svmTitles button[data-title="Mr."]');
  ok('One tap for Mr.: "Dear Mr. Ram Rajappa,"', (await msg(page)).includes('Dear Mr. Ram Rajappa,'));
  await page.click('#svmModal [data-svm="wa"]');
  const url = await page.evaluate(() => window.__opened.at(-1));
  ok('WhatsApp: straight to the lead\'s chat', url && url.startsWith('https://wa.me/919840011111?text='), url && url.slice(0, 40));
  // Another property picked: the message follows it.
  await page.click('#svmPropSearch');
  await page.fill('#svmPropSearch', 'asnc001');
  await page.keyboard.press('Enter');
  m = await msg(page);
  ok('Another property picked: its details, the commercial emoji', m.startsWith('🏢') && m.includes('Commercial / Retail Space, Ashok Nagar') && !m.includes('UDS'));
  ok('The dialog fits the screen', await fits(page));
  await page.screenshot({ path: join(OUT, `crm-${viewport.width}.png`) });
  await page.keyboard.press('Escape');

  await page.evaluate(() => openDetail('V2'));
  await page.waitForTimeout(300);
  await confirmBtn().click();
  await page.waitForSelector('#svmModal.open');
  await page.waitForTimeout(100);
  ok('No property on the booking, one linked to the lead: that one', await page.inputValue('#svmProp') === 'POR0002');
  ok('…sales@ sent: nobody named (a mailbox is not a person)', await page.inputValue('#svmHost') === '');
  ok('…its rent in the message', (await msg(page)).includes('Monthly Rent'));
  await page.keyboard.press('Escape');

  await page.evaluate(() => openDetail('V3'));
  await page.waitForTimeout(300);
  await confirmBtn().click();
  await page.waitForSelector('#svmModal.open');
  await page.waitForTimeout(100);
  m = await msg(page);
  ok('Nothing to go on: "Pick the property", and the message still whole', await page.inputValue('#svmProp') === '' && /pick the property/i.test(await page.textContent('#svmFor')) && m.includes("Dear Sir/Ma'am,") && m.endsWith('*Team 3 PIN Realty*') && !m.includes('Property Details'));
  await page.click('#svmPropSearch');
  await page.fill('#svmPropSearch', 'maha palace');
  await page.keyboard.press('Enter');
  ok('…typed "maha palace", Enter: its details come in', (await msg(page)).includes('• *Property:* MAHA Palace') && await page.inputValue('#svmProp') === 'MYLA002');
  await page.keyboard.press('Escape');

  // ── Booking the visit: the property typed for, not scrolled for ──
  await page.evaluate(() => openVisitEditor('V1'));
  await page.waitForFunction(() => document.getElementById('svPropSearch') && document.querySelectorAll('#svProp option').length > 100, null, { timeout: 5000 });
  ok('Visit booking: a search box for the property, showing the one booked', /NGMA002/.test(await page.inputValue('#svPropSearch')) && await page.isHidden('#svProp'));
  const top = async q => { await page.fill('#svPropSearch', q); await page.waitForTimeout(30); return page.$$eval('#svSheet .ppk-opt', bs => bs.map(b => b.textContent)); };
  let r = await top('ngma002');
  ok('By code: "ngma002" → NGMA002 first', /^NGMA002/.test(r[0] || ''), r[0]);
  r = await top('srivaradha');
  ok('By title: "srivaradha" → the Srivaradha flats', r.length >= 1 && r.slice(0, 2).every(t => /varadha/i.test(t)), r.slice(0, 3).join(' | '));
  r = await top('uds 675');
  ok('By details: "uds 675" → NGMA002', r.some(t => /NGMA002/.test(t)), r.slice(0, 3).join(' | '));
  r = await top('rent porur');
  ok('By details: "rent porur" → the Porur rentals first', /POR000/.test(r[0] || '') && /POR000/.test(r[1] || ''), r.slice(0, 3).join(' | '));
  r = await top('3 bhk anna nagar');
  ok('"3 bhk anna nagar" → Anna Nagar 3BHKs (spacing does not matter)', r.length >= 2 && r.slice(0, 3).filter(t => /^(AN|p17)/.test(t) || /Anna Nagar/i.test(t)).length >= 2, r.slice(0, 4).join(' | '));
  await page.screenshot({ path: join(OUT, `crm-booking-search-${viewport.width}.png`) });
  ok('…the details line shows where it matched', await page.$eval('#svSheet .ppk-opt', b => !!b.querySelector('small')));
  r = await top('zzqqxx');
  ok('Nothing matches: says so, "Something not in the inventory…" still offered', /No property has/.test(await page.textContent('#svSheet .ppk-list')) && r.some(t => /not in the inventory/.test(t)));
  await page.fill('#svPropSearch', 'mylapore 6bhk');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  ok('↑ ↓ Enter picks: MAHA Palace (MYLA002) chosen', await page.inputValue('#svProp') === 'MYLA002' && /MYLA002/.test(await page.inputValue('#svPropSearch')));
  await page.click('#svPropSearch');
  await page.fill('#svPropSearch', 'not in the inventory');
  await page.keyboard.press('Enter');
  ok('"Something not in the inventory…": the free-text box opens', await page.inputValue('#svProp') === '__free' && await page.isVisible('#svPropFree'));
  await page.click('#svPropSearch');
  await page.fill('#svPropSearch', 'POR0002');
  await page.keyboard.press('Enter');
  ok('…and back to a property: the free-text box closes', await page.inputValue('#svProp') === 'POR0002' && await page.isHidden('#svPropFree'));
  await page.click('#svPropSearch');
  await page.keyboard.press('Escape');
  ok('Escape: the list closes, the choice kept — the booking form stays open', await page.isHidden('#svSheet .ppk-list') && /POR0002/.test(await page.inputValue('#svPropSearch')));
  await page.screenshot({ path: join(OUT, `crm-booking-${viewport.width}.png`) });
  await page.evaluate(() => saveVisitEdit('V1'));
  await page.waitForTimeout(400);
  const savedLead = await page.evaluate(() => window.__savedLeads.filter(l => l.id === 'V1').at(-1));
  ok('Saved: the visit is booked for the property typed for', savedLead && savedLead.siteVisitProperty === 'POR0002', JSON.stringify(savedLead && savedLead.siteVisitProperty));
  await page.evaluate(() => closeVisitEditor && closeVisitEditor());

  for (const [id, why] of [['V4', 'cancelled'], ['V5', 'not booked']]) {
    await page.evaluate(i => openDetail(i), id);
    await page.waitForTimeout(250);
    ok(`A visit ${why}: no "Confirmation"`, await confirmBtn().count() === 0);
  }
}

await browser.close();
console.log('');
if (errors.length) { console.log(`${errors.length} problem(s):\n  ` + errors.join('\n  ')); process.exit(1); }
console.log('All good.');
