// ═══════ CRM PREVIEW — THE REWORKED PIPELINE, NO LOGIN ═══════
//
// Opens the real crm.html in Chromium with firebase-sync.js swapped for an in-memory stand-in,
// on the keyed 8-column pipeline, with leads in every situation the automation produces: an
// overdue promise, a visit whose time passed, an AI move to undo, an AI suggestion, a stale
// hand-entered lead, a lost lead with its reason. Checks the columns, cards, focus filters, lead
// page actions, the Lost reason prompt, the action queue and the phone layout; screenshots each.
//
//   node tests/crm-pipeline-preview.mjs <out-dir>

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPipelineMigration, STAGE_DEFS } from '../crm-assets/pipeline.js';

const OUT = process.argv[2] || 'pipeline-preview';
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
  { id: 'L1', tenantId: T, name: 'Rajesh Kumar', phone: '9840012345', source: 'tailortalk', stageId: sid('visit_pending'), propertyInterest: 'Velachery', budget: '3.3 Cr', createdAt: NOW - 3 * D, updatedAt: NOW - 3 * D,
    tt: tt({ status: 'hot' }),
    ai: { at: NOW - H, stage: 'visit_pending', confidence: 'high', evidence: '14 Sep: "Sunday 11 AM works"', line: 'Agreed to see VLCA002 Sun 11 AM; team to confirm',
      next: { owner: 'team', action: 'Call to confirm Sunday 11 AM visit to VLCA002', kind: 'confirm_visit', dueAt: NOW - 90 * 60000, setAt: NOW - 3 * H },
      visit: { status: 'scheduled', at: NOW + 2 * D, property: 'VLCA002' },
      lastMove: { from: 'options', fromStageId: sid('options'), to: 'visit_pending', at: NOW - H, evidence: '14 Sep: "Sunday 11 AM works"' } } },
  { id: 'L2', tenantId: T, name: 'Priya S', source: 'tailortalk', stageId: sid('options'), propertyInterest: 'Anna Nagar 2 BHK', budget: '1.2 Cr', createdAt: NOW - 4 * D, updatedAt: NOW - 4 * D,
    tt: tt({ integration: 'instagram', handle: 'priya.homes' }),
    ai: { at: NOW - 30 * 60000, stage: 'negotiation', confidence: 'medium', evidence: 'Asked "best price for ANRA002?"', line: 'Asking best price for ANRA002',
      next: { owner: 'team', action: 'Share final price for ANRA002', kind: 'negotiate', dueAt: NOW + 5 * H, setAt: NOW - 30 * 60000 },
      suggestion: { stage: 'negotiation', confidence: 'medium', evidence: 'Asked "best price for ANRA002?"', why: 'evidence not strong enough to skip ahead', at: NOW - 30 * 60000 } } },
  { id: 'L3', tenantId: T, name: 'Arun Prakash', source: 'tailortalk', stageId: sid('visit_pending'), propertyInterest: 'Kilpauk villa', createdAt: NOW - 6 * D, updatedAt: NOW - 5 * D,
    tt: tt({ lastMessageAt: NOW - 2 * D }),
    ai: { at: NOW - 2 * D, stage: 'visit_pending', confidence: 'high', evidence: 'Visit fixed Sat 4 PM', line: 'Visit to KILV001 was Sat 4 PM', next: null, visit: { status: 'scheduled', at: NOW - 20 * H, property: 'KILV001' } } },
  { id: 'L4', tenantId: T, name: 'Meena R', source: 'tailortalk', stageId: sid('negotiation'), propertyInterest: 'Nanganallur', budget: '85 L', createdAt: NOW - 12 * D, updatedAt: NOW - 6 * D, stageChangedAt: NOW - 6 * D,
    tt: tt({ lastMessageAt: NOW - 5 * D, lastReplyAt: NOW - 5 * D }),
    ai: { at: NOW - 5 * D, stage: 'negotiation', confidence: 'high', evidence: 'Offered 80 L', line: 'Offered 80 L for NOL002', next: { owner: 'lead', action: 'Decide on the 82 L counter', kind: 'other', dueAt: null, setAt: NOW - 5 * D } } },
  { id: 'L5', tenantId: T, name: 'Suresh Kumar', phone: '98765 43213', source: 'manual', stageId: sid('new'), propertyInterest: 'Villa in Anna Nagar', budget: '3 Cr', createdAt: NOW - 60 * D, updatedAt: NOW - 55 * D },
  { id: 'L6', tenantId: T, name: 'Divya Sundaram', phone: '98765 43216', source: 'manual', stageId: sid('lost'), lostReason: 'unreachable', propertyInterest: '2BHK Royapettah', createdAt: NOW - 60 * D, updatedAt: NOW - D },
  { id: 'L7', tenantId: T, name: 'Vignesh Iyer', source: 'tailortalk', stageId: sid('on_hold'), holdReason: 'postponed', holdUntil: NOW + 10 * D, propertyInterest: 'OMR 3 BHK', createdAt: NOW - 20 * D, updatedAt: NOW - 2 * D, tt: tt({ lastMessageAt: NOW - 3 * D }) },
  { id: 'L8', tenantId: T, name: 'Kavitha E', source: 'tailortalk', stageId: sid('new'), propertyInterest: 'Sholinganallur', createdAt: NOW - 3 * H, updatedAt: NOW - 3 * H,
    tt: tt({ status: 'hot', awaitingTeamAt: NOW - 40 * 60000, lastMessageAt: NOW - 41 * 60000 }) },
  { id: 'L9', tenantId: T, name: 'Won Deal', source: 'manual', stageId: sid('won'), propertyInterest: 'T Nagar', createdAt: NOW - 90 * D, updatedAt: NOW - 10 * D }
];

const STUB = `
const LEADS = ${JSON.stringify(LEADS)};
const STAGES = ${JSON.stringify(STAGES)};
window.__saved = []; window.__aiUpdates = [];
window.crmFirebase = {
  saveLead: async l => { window.__saved.push(JSON.parse(JSON.stringify(l))); },
  deleteLead: async () => {}, getLeadNotes: async () => [], getLeadHistory: async () => [],
  saveNote: async () => {}, deleteNoteDoc: async () => {}, saveHistory: async () => {}, savePipeline: async () => {},
  getBotConfig: async () => null, saveBotConfig: async () => {}, saveEnquiryTypes: async () => {}, saveProperties: async () => {},
  saveFollowupDigestSettings: async () => {}, saveDashboardEmailSettings: async () => {},
  releaseLeadField: async () => {}, getLeadTailorTalk: async () => null,
  updateLeadAi: async (id, f) => { window.__aiUpdates.push({ id, f }); }, saveAutomationSettings: async () => {}
};
window.crmAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => 't_3pinrealty' };
window.onCrmAuthChange({ email: 'agent.a@example.com' });
window.applyPipelineSnapshot(STAGES);
window.applyEnquiryTypesSnapshot(['Property Enquiry','Seller Listing','General']);
window.applyAutomationSettingsSnapshot({ enabled: true });
window.applyLeadsSnapshot(JSON.parse(JSON.stringify(LEADS)));
window.__ready = true;
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const browser = await chromium.launch();
const errors = [];
const ok = (label, cond, detail) => { if (cond) console.log('  ok  ' + label); else errors.push(label + (detail !== undefined ? ' — ' + detail : '')); };

async function openPage(viewport, theme) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(t => { try { localStorage.removeItem('crmLeadFilter'); if (t) localStorage.setItem('crmTheme', t); } catch (e) {} }, theme || null);
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
  await page.goto('http://crm.local/crm.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.waitForTimeout(400);
  return page;
}
const text = (page, sel) => page.evaluate(s => [...document.querySelectorAll(s)].map(e => e.textContent.replace(/\s+/g, ' ').trim()), sel);

// ── Desktop ──
{
  const page = await openPage({ width: 1440, height: 900 });
  const heads = await text(page, '.kcol-title');
  ok('Eight columns in milestone order', JSON.stringify(heads) === JSON.stringify(STAGE_DEFS.map(d => d.name)), JSON.stringify(heads));
  const rules = await text(page, '.kcol-rule');
  // Counted from STAGE_DEFS rather than hardcoded, so adding a column does not
  // need this line edited — only the board genuinely failing to show a rule does.
  ok('Every column shows its one-line rule',
    rules.length === STAGE_DEFS.length && rules.every(Boolean)
    && rules[STAGE_DEFS.findIndex(d => d.key === 'visit_pending')] === 'Visit asked for or agreed — not done yet',
    JSON.stringify(rules));
  await page.screenshot({ path: join(OUT, '01-board.png') });

  const l1 = await page.evaluate(() => { const c = [...document.querySelectorAll('.lcard')].find(x => /Rajesh/.test(x.textContent)); return c ? { cls: c.className, step: c.querySelector('.lcard-step') && c.querySelector('.lcard-step').className, text: c.textContent.replace(/\s+/g, ' ') } : null; });
  // The card's rail is now driven by isOverdueUi() rather than by severity —
  // 'high' covered every chat signal, so most cards wore one and it stopped
  // meaning anything. 'is-overdue' is the single class that earns red.
  ok('An overdue promise makes the card overdue', l1 && /is-overdue/.test(l1.cls) && /overdue/.test(l1.step), JSON.stringify(l1));
  ok('…and leads with the promised step', l1 && /Call to confirm Sunday 11 AM visit to VLCA002/.test(l1.text));
  ok('…and shows the AI moved it', l1 && /🤖 moved/.test(l1.text));
  const urgentBadge = await page.evaluate(() => { const col = [...document.querySelectorAll('.kcol')].find(c => c.querySelector('.kcol-title').textContent.trim() === 'Visit planned'); const b = col && col.querySelector('.kcol-urgent'); return b ? b.textContent : null; });
  ok('Visit planned column counts leads needing action now', urgentBadge === '2', urgentBadge);
  const firstInCol = await page.evaluate(() => { const col = [...document.querySelectorAll('.kcol')].find(c => c.querySelector('.kcol-title').textContent.trim() === 'Visit planned'); return col.querySelector('.lcard .lcard-name').textContent; });
  ok('The most urgent lead is first in its column', firstInCol === 'Rajesh Kumar', firstInCol);
  const lostCard = await page.evaluate(() => { const c = [...document.querySelectorAll('.lcard')].find(x => /Divya/.test(x.textContent)); return c ? c.textContent.replace(/\s+/g, ' ') : ''; });
  ok('A lost card shows its reason', /Lost — Unreachable/.test(lostCard), lostCard);
  const holdCard = await page.evaluate(() => { const c = [...document.querySelectorAll('.lcard')].find(x => /Vignesh/.test(x.textContent)); return c ? c.textContent.replace(/\s+/g, ' ') : ''; });
  ok('An on-hold card shows when to revisit', /Revisit/.test(holdCard), holdCard);

  // Focus filters.
  const chips = await text(page, '#leadFilterBar .lf-chip.focus');
  console.log('     focus chips:', chips.join(' | '));
  await page.evaluate(() => setLeadFocus('overdue'));
  const overdueNames = await text(page, '.lcard .lcard-name');
  ok('Overdue shows the missed promise and the visit with no outcome', overdueNames.includes('Rajesh Kumar') && overdueNames.includes('Arun Prakash') && !overdueNames.includes('Priya S'), JSON.stringify(overdueNames));
  await page.evaluate(() => setLeadFocus('ai_moved'));
  ok('Moved by AI today shows only the AI move', JSON.stringify(await text(page, '.lcard .lcard-name')) === JSON.stringify(['Rajesh Kumar']));
  await page.evaluate(() => setLeadFocus('review'));
  ok('AI suggestions shows the lead with a suggestion', JSON.stringify(await text(page, '.lcard .lcard-name')) === JSON.stringify(['Priya S']));
  await page.evaluate(() => setLeadFocus('action'));
  const actionNames = await text(page, '.lcard .lcard-name');
  ok('Needs action leaves out won, lost and quiet on-hold leads', !actionNames.includes('Won Deal') && !actionNames.includes('Divya Sundaram') && !actionNames.includes('Vignesh Iyer') && actionNames.includes('Kavitha E'), JSON.stringify(actionNames));
  await page.screenshot({ path: join(OUT, '02-needs-action.png') });
  await page.evaluate(() => setLeadFocus('action'));

  await page.evaluate(() => toggleView('followups'));
  await page.waitForTimeout(200);
  const queue = (await text(page, '#followupsView .q-wrap')).join(' ');
  ok('The queue opens with what needs a person, most urgent first', /Needs a person.*Do now.*Rajesh Kumar.*Today.*Arun Prakash/.test(queue), queue.slice(0, 260));
  await page.screenshot({ path: join(OUT, '06-action-queue.png') });
  await page.evaluate(() => toggleView('kanban'));

  // Lead page: where it stands, suggestion, undo.
  await page.evaluate(() => openDetail('L2'));
  await page.waitForTimeout(300);
  const stand = (await text(page, '#dpStand')).join(' ');
  // The rule now says what the column means for the LEAD (they are weighing it
  // up), not just what we did — asking for more details belongs here too.
  ok('Lead page shows the column and its rule', /Options sent.*Sent a property, details or location/.test(stand), stand.slice(0, 200));
  ok('…the next step with its due time', /Next step.*Share final price for ANRA002/.test(stand));
  ok('…and the AI suggestion with why it did not move', /AI suggests: Negotiating/.test(stand) && /not moved automatically: evidence not strong enough/.test(stand));
  await page.locator('#dpStandSec').screenshot({ path: join(OUT, '03-lead-suggestion.png') });
  await page.evaluate(() => acceptAiSuggestion('L2'));
  const afterAccept = await page.evaluate(() => { const l = leads.find(x => x.id === 'L2'); return { stage: l.stageId, by: l.stageChangedBy, sug: l.ai.suggestion }; });
  ok('Accepting a suggestion moves the lead as a person\'s decision', afterAccept.stage === 'negotiation' && afterAccept.by === 'agent.a@example.com' && afterAccept.sug === null, JSON.stringify(afterAccept));

  await page.evaluate(() => openDetail('L1'));
  await page.waitForTimeout(300);
  const stand1 = (await text(page, '#dpStand')).join(' ');
  ok('An AI move shows with Undo', /Moved from Options sent to Visit planned/.test(stand1) && /Undo/.test(stand1), stand1.slice(0, 300));
  await page.locator('#dpStandSec').screenshot({ path: join(OUT, '04-lead-ai-move.png') });
  await page.evaluate(() => undoAiMove('L1'));
  const undone = await page.evaluate(() => { const l = leads.find(x => x.id === 'L1'); return { stage: l.stageId, dismissed: l.ai.dismissed, update: window.__aiUpdates.find(u => u.id === 'L1') }; });
  ok('Undo moves it back and remembers not to repeat it', undone.stage === 'options_shared' && undone.dismissed && undone.dismissed.visit_pending && undone.update && 'ai.dismissed.visit_pending' in undone.update.f, JSON.stringify(undone));

  await page.evaluate(() => openDetail('L3'));
  await page.waitForTimeout(300);
  ok('A passed visit asks for the outcome with a one-tap answer', /Did the site visit happen\?.*They visited/.test((await text(page, '#dpStand')).join(' ')));
  await page.evaluate(() => markVisitedUi('L3'));
  ok('"They visited" moves it to Visited', await page.evaluate(() => leads.find(x => x.id === 'L3').stageId) === 'stage_done');

  // Lost needs a reason.
  await page.evaluate(() => { closeDetail(); changeStage('L5', 'closed_lost'); });
  ok('Moving to Lost asks why first', await page.evaluate(() => document.getElementById('stageReasonModal').classList.contains('open')));
  await page.screenshot({ path: join(OUT, '05-lost-reason.png') });
  await page.evaluate(() => { document.getElementById('srReason').value = 'bought_elsewhere'; saveStageReason(); });
  const lost = await page.evaluate(() => { const l = leads.find(x => x.id === 'L5'); return { stage: l.stageId, reason: l.lostReason, fu: l.followUpAt }; });
  ok('…and saves the reason', lost.stage === 'closed_lost' && lost.reason === 'bought_elsewhere', JSON.stringify(lost));

  // Handled leads leave the queue.
  await page.evaluate(() => toggleView('followups'));
  await page.waitForTimeout(200);
  const queueAfter = (await text(page, '#followupsView .q-wrap')).join(' ');
  ok('Acting on a lead takes it out of "Do now"', !/Do now/.test(queueAfter) && !/Rajesh Kumar/.test(queueAfter), queueAfter.slice(0, 200));
  await page.evaluate(() => toggleView('list'));
  await page.screenshot({ path: join(OUT, '07-list.png') });
  const listHead = await text(page, '.list-view th .lv-th-label');
  ok('List view has a Next step column', listHead.some(h => /Next step/.test(h)), JSON.stringify(listHead));
  await page.close();
}

// ── Phone ──
{
  const page = await openPage({ width: 390, height: 844 });
  await page.screenshot({ path: join(OUT, '08-phone-board.png') });
  await page.evaluate(() => openDetail('L1'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, '09-phone-lead.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('Phone lead page does not scroll sideways', overflow <= 1, overflow);
  await page.close();
}

// ── Dark ──
{
  const page = await openPage({ width: 1440, height: 900 }, 'dark');
  await page.screenshot({ path: join(OUT, '10-dark-board.png') });
  await page.close();
}

await browser.close();
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('No page errors');
