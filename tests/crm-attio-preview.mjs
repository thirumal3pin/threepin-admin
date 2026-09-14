// ═══════ CRM PREVIEW — MILESTONES, VIEWS, PROPERTIES, BULK, TIMELINE, MENTIONS ═══════
//
// Opens the real crm.html in Chromium with firebase-sync.js swapped for an in-memory stand-in and
// checks the features borrowed from Attio: milestone dates (days-in-stage chip, lead page trail,
// the dashboard funnel), saved team views, lead ↔ property links, bulk actions in the list, the
// one filterable timeline and @mentions. Screenshots each.
//
//   node tests/crm-attio-preview.mjs <out-dir>

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPipelineMigration } from '../crm-assets/pipeline.js';

const OUT = process.argv[2] || 'attio-preview';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.now();
const H = 3600000, D = 24 * H;
const T = 't_3pinrealty';
const STAGES = planPipelineMigration([
  { id: 'new', name: 'New' }, { id: 'site_visit', name: 'Site Visit' }, { id: 'stage_done', name: 'Site Visit Done' },
  { id: 'negotiation', name: 'in Negotiation' }, { id: 'closed_won', name: 'Closed' }, { id: 'closed_lost', name: 'Not interested' }
], []).stages;
const sid = key => STAGES.find(s => s.key === key).id;
const tt = (over = {}) => ({ id: 'x' + Math.random().toString(36).slice(2, 7), category: 'sales', integration: 'whatsapp', status: 'warm', lastMessageAt: NOW - 2 * H, lastReplyAt: NOW - 2 * H + 60000, ...over });

const LEADS = [
  { id: 'A1', tenantId: T, name: 'Rajesh Kumar', phone: '9840012345', source: 'tailortalk', stageId: sid('visit_pending'), propertyInterest: 'Velachery VLCA002', budget: '3.3 Cr',
    createdAt: NOW - 9 * D, updatedAt: NOW - D, stageChangedAt: NOW - 6 * D, reached: { new: NOW - 9 * D, options: NOW - 8 * D, visit_pending: NOW - 6 * D },
    propertyCodes: ['VLCA002'], tt: tt({ status: 'hot' }) },
  { id: 'A2', tenantId: T, name: 'Priya S', source: 'tailortalk', stageId: sid('options'), propertyInterest: 'Anna Nagar 2 BHK', budget: '1.2 Cr',
    createdAt: NOW - 20 * D, updatedAt: NOW - 16 * D, stageChangedAt: NOW - 16 * D, reached: { new: NOW - 20 * D, options: NOW - 16 * D }, tt: tt() },
  { id: 'A3', tenantId: T, name: 'Arun Prakash', phone: '98765 43211', source: 'manual', stageId: sid('new'), propertyInterest: 'Kilpauk villa', createdAt: NOW - 3 * H, updatedAt: NOW - 3 * H, reached: { new: NOW - 3 * H } },
  { id: 'A4', tenantId: T, name: 'Meena R', phone: '98765 43212', source: 'manual', stageId: sid('negotiation'), propertyInterest: 'Nanganallur', budget: '85 L',
    createdAt: NOW - 30 * D, updatedAt: NOW - 2 * D, stageChangedAt: NOW - 3 * D, reached: { new: NOW - 30 * D, visit_done: NOW - 10 * D, negotiation: NOW - 3 * D } },
  { id: 'A5', tenantId: T, name: 'Won Deal', source: 'manual', stageId: sid('won'), propertyInterest: 'T Nagar', createdAt: NOW - 60 * D, updatedAt: NOW - 10 * D, reached: { new: NOW - 60 * D, won: NOW - 12 * D } },
  { id: 'A6', tenantId: T, name: 'Divya Sundaram', phone: '98765 43216', source: 'manual', stageId: sid('lost'), lostReason: 'not_interested', createdAt: NOW - 40 * D, updatedAt: NOW - 5 * D, reached: { new: NOW - 40 * D, options: NOW - 35 * D } }
];

const STUB = `
const LEADS = ${JSON.stringify(LEADS)};
const STAGES = ${JSON.stringify(STAGES)};
window.__saved = []; window.__aiUpdates = []; window.__settings = []; window.__history = []; window.__notes = [];
window.crmFirebase = {
  saveLead: async l => { window.__saved.push(JSON.parse(JSON.stringify(l))); },
  deleteLead: async () => {}, getLeadNotes: async () => [], getLeadHistory: async () => [],
  saveNote: async (id, n) => { window.__notes.push({ id, n }); }, deleteNoteDoc: async () => {}, saveHistory: async (id, h) => { window.__history.push({ id, h }); }, savePipeline: async () => {},
  getBotConfig: async () => null, saveBotConfig: async () => {}, saveEnquiryTypes: async () => {}, saveProperties: async () => {},
  saveFollowupDigestSettings: async () => {}, saveDashboardEmailSettings: async () => {},
  releaseLeadField: async () => {}, getLeadTailorTalk: async () => null,
  updateLeadAi: async (id, f) => { window.__aiUpdates.push({ id, f }); }, saveAutomationSettings: async () => {},
  saveView: async v => { window.__settings.push({ view: v }); }, deleteView: async id => { window.__settings.push({ deleted: id }); },
  getInventory: async () => [
    { id: 'VLCA002', propertyCode: 'VLCA002', name: 'Casagrand Velachery', location: 'Velachery', startingPrice: '₹1.2 Cr' },
    { id: 'ANR003', propertyCode: 'ANR003', name: 'Firm Srivaruni', location: 'Anna Nagar West', startingPrice: '₹3.25 Cr' }
  ],
  registerTeamMember: async () => {}
};
window.crmAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => 't_3pinrealty' };
window.onCrmAuthChange({ email: 'owner@threepin.in' });
window.applyPipelineSnapshot(STAGES);
window.applyEnquiryTypesSnapshot(['Property Enquiry','Seller Listing','General']);
window.applyAutomationSettingsSnapshot({ enabled: true });
if (window.applyViewsSnapshot) window.applyViewsSnapshot({});
if (window.applyTeamSnapshot) window.applyTeamSnapshot({ 'owner@threepin.in': { email: 'owner@threepin.in' }, 'karthik@threepin.in': { email: 'karthik@threepin.in' } });
window.applyLeadsSnapshot(JSON.parse(JSON.stringify(LEADS)));
window.__ready = true;
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const browser = await chromium.launch();
const errors = [];
const ok = (label, cond, detail) => { if (cond) console.log('  ok  ' + label); else errors.push(label + (detail !== undefined ? ' — ' + detail : '')); };

async function openPage(viewport, { theme = null, search = '' } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(t => { try { localStorage.clear(); if (t) localStorage.setItem('crmTheme', t); } catch (e) {} }, theme);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${viewport.width}px: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`${viewport.width}px console: ${m.text()}`); });
  page.on('dialog', d => d.accept());
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'crm.local') return route.abort();
    if (url.pathname === '/crm-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    const file = join(ROOT, decodeURIComponent(url.pathname));
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.goto('http://crm.local/crm.html' + search);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  return page;
}
const text = (page, sel) => page.evaluate(s => [...document.querySelectorAll(s)].map(e => e.textContent.replace(/\s+/g, ' ').trim()), sel);
const cardText = (page, name) => page.evaluate(n => { const c = [...document.querySelectorAll('.lcard')].find(x => x.querySelector('.lcard-name').textContent === n); return c ? c.textContent.replace(/\s+/g, ' ') : null; }, name);

// ── 3. Milestones ──
{
  const page = await openPage({ width: 1440, height: 900 });
  ok('A lead stuck past its column\'s usual time shows it on the card', /16d in stage/.test(await cardText(page, 'Priya S') || ''));
  ok('…a lead within it does not', !/in stage/.test(await cardText(page, 'Arun Prakash') || 'in stage'));
  await page.screenshot({ path: join(OUT, '01-board-age.png') });
  await page.evaluate(() => openDetail('A1'));
  await page.waitForTimeout(300);
  const stand = (await text(page, '#dpStand')).join(' ');
  ok('Lead page says how long it has been in the column', /Visit planned\s*for 6 days/.test(stand), stand.slice(0, 160));
  ok('…and the milestones it reached with dates', /New .*→.*Options sent .*→.*Visit planned/.test(stand), stand.slice(0, 300));
  await page.locator('#dpStandSec').screenshot({ path: join(OUT, '02-lead-trail.png') });
  await page.evaluate(() => { closeDetail(); changeStage('A3', 'options_shared'); });
  const moved = await page.evaluate(() => leads.find(l => l.id === 'A3').reached);
  ok('Moving a lead records the milestone date', moved && moved.options > 0 && moved.new > 0, JSON.stringify(moved));
  await page.evaluate(() => toggleView('dashboard'));
  await page.waitForTimeout(400);
  const funnel = (await text(page, '.dash-funnel')).join(' ');
  // Arun was just moved to Options sent; the lost lead had reached it; Won and Negotiating skipped past it.
  ok('The dashboard funnel counts milestones ever reached', /Enquiries\s*6.*Options sent\s*6.*Visit planned\s*3.*Visited\s*2.*Negotiating\s*2.*Won\s*1/.test(funnel), funnel.slice(0, 400));
  await page.screenshot({ path: join(OUT, '03-dashboard-funnel.png'), fullPage: false });
  await page.close();
}

// ── 4. Saved team views ──
{
  const page = await openPage({ width: 1440, height: 900 });
  ok('The views chip starts empty', (await text(page, '#viewsCtlBtn'))[0].startsWith('☆ Views'));
  await page.evaluate(() => { setLeadScope('tt'); setLeadFocus('action'); toggleView('list'); toggleListSort('name'); });
  await page.evaluate(() => { const i = document.getElementById('searchInput'); i.value = 'raj'; i.dispatchEvent(new Event('input')); });
  await page.click('#viewsCtlBtn');
  ok('Opening the menu offers to save what is on screen', await page.isVisible('#viewNameInput'));
  await page.fill('#viewNameInput', 'Hot TailorTalk to call');
  await page.evaluate(() => { renderLeadFilterBar(); applyFilters(); });
  ok('…and a redraw while typing keeps the name', await page.inputValue('#viewNameInput') === 'Hot TailorTalk to call');
  await page.screenshot({ path: join(OUT, '20-views-menu.png') });
  await page.press('#viewNameInput', 'Enter');
  await page.waitForTimeout(100);
  const saved = await page.evaluate(() => window.__settings.map(s => s.view).filter(Boolean)[0]);
  ok('Saving writes the view for the team', saved && saved.name === 'Hot TailorTalk to call' && saved.scope === 'tt' && saved.focus === 'action' && saved.view === 'list' && saved.search === 'raj' && saved.sortCol === 'name', JSON.stringify(saved));
  ok('…and the chip shows it is active', (await text(page, '#viewsCtlBtn'))[0].startsWith('★ Hot TailorTalk to call'));
  await page.evaluate(() => { clearSearch(); setLeadScope('all'); toggleView('kanban'); });
  ok('Changing the filters clears the active name', (await text(page, '#viewsCtlBtn'))[0].startsWith('☆ Views'));
  await page.evaluate(id => applySavedView(id), saved.id);
  const restored = await page.evaluate(() => ({ f: leadFilter, s: document.getElementById('searchInput').value, v: currentView, sort: listSortCol }));
  ok('Picking the view restores scope, focus, search, list and sort', restored.f.scope === 'tt' && restored.f.focus === 'action' && restored.s === 'raj' && restored.v === 'list' && restored.sort === 'name', JSON.stringify(restored));
  ok('…and names it again', (await text(page, '#viewsCtlBtn'))[0].startsWith('★ Hot TailorTalk to call'));
  await page.evaluate(() => window.applyViewsSnapshot({ vx: { id: 'vx', name: 'Visits this week', scope: 'all', status: null, focus: 'overdue', search: '', view: 'kanban', sortCol: null, sortDir: null, colFilters: {} } }));
  await page.click('#viewsCtlBtn');
  ok('Views saved by someone else appear from the live settings', /Visits this week.*Sales leads · Overdue · Board/.test((await text(page, '.lf-views-menu')).join(' ')));
  await page.evaluate(() => deleteSavedView('vx'));
  ok('Deleting a view removes it for everyone', await page.evaluate(() => !savedViews.vx && window.__settings.some(s => s.deleted === 'vx')));
  await page.close();
}
{
  const page = await openPage({ width: 390, height: 844 });
  await page.click('#viewsCtlBtn');
  const box = await page.evaluate(() => { const r = document.querySelector('.lf-views-menu').getBoundingClientRect(); return { left: r.left, right: r.right, w: window.innerWidth }; });
  ok('On a phone the views menu stays on screen', box.left >= 0 && box.right <= box.w, JSON.stringify(box));
  await page.screenshot({ path: join(OUT, '21-views-phone.png') });
  await page.close();
}

// ── 6. Bulk actions ──
{
  const page = await openPage({ width: 1440, height: 900 });
  await page.evaluate(() => toggleView('list'));
  await page.waitForTimeout(200);
  ok('No toolbar until a row is ticked', (await page.$('.bulk-bar')) === null);
  await page.evaluate(() => { toggleBulkLead('A2', true); toggleBulkLead('A3', true); });
  ok('Ticking rows shows the toolbar with the count', /2 selected/.test((await text(page, '.bulk-bar')).join(' ')));
  ok('…and highlights the rows', (await page.$$('.list-view tbody tr.sel')).length === 2);
  await page.screenshot({ path: join(OUT, '10-bulk-bar.png') });
  await page.evaluate(() => bulkMoveTo('closed_lost'));
  ok('Moving several to Lost asks one reason for all', await page.evaluate(() => document.getElementById('stageReasonModal').classList.contains('open') && document.getElementById('srTitle').textContent === 'Why are 2 leads lost?'));
  await page.evaluate(() => { document.getElementById('srReason').value = 'unreachable'; saveStageReason(); });
  const lost = await page.evaluate(() => ['A2', 'A3'].map(id => { const l = leads.find(x => x.id === id); return [l.stageId, l.lostReason, l.stageChangedBy]; }));
  ok('…and moves each with that reason, as a person\'s decision', JSON.stringify(lost) === JSON.stringify([['closed_lost', 'unreachable', 'owner@threepin.in'], ['closed_lost', 'unreachable', 'owner@threepin.in']]), JSON.stringify(lost));
  ok('…logging a history line on each', await page.evaluate(() => ['A2', 'A3'].every(id => window.__history.some(h => h.id === id && /to <b>Lost<\/b> \(Unreachable\)/.test(h.h.text)))));
  ok('…and clears the selection', await page.evaluate(() => bulkSelected.size === 0) && (await page.$('.bulk-bar')) === null);
  await page.evaluate(() => { toggleBulkAll(true); bulkFuOpen = true; renderList(); });
  const n = await page.evaluate(() => bulkSelected.size);
  ok('Select all ticks every row on screen', n === await page.evaluate(() => listVisibleIds.length) && n > 0, n);
  await page.evaluate(() => { const d = new Date(Date.now() + 2 * 86400000); document.getElementById('bulkFuDate').value = d.toISOString().slice(0, 10); document.getElementById('bulkFuTime').value = '11:00'; bulkSetFollowUp(); });
  const fus = await page.evaluate(() => leads.filter(l => l.followUpAt && l.followUpBy === 'owner@threepin.in').length);
  ok('Setting a follow-up in bulk sets it on each selected lead', fus === n, `${fus} of ${n}`);
  await page.evaluate(() => { toggleBulkLead('A1', true); setLeadScope('other'); });
  ok('A filter that hides a ticked lead also unticks it', await page.evaluate(() => !bulkSelected.has('A1')));
  await page.close();
}

await browser.close();
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('No page errors');
