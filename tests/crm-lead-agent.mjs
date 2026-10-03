// ═══════ A LEAD'S OWN AGENT, AND A SECONDARY ═══════
//
//   node tests/crm-lead-agent.mjs
//
// Every lead starts unassigned; a person picks its agent (and, if needed, a second) on the lead
// page. Never automatic, and separate from the agents on a site visit. The board card says who,
// the list has an Agent column, and the filter bar narrows to Unassigned, Mine or one person.

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPipelineMigration } from '../crm-assets/pipeline.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const T = 't_3pinrealty';
const STAGES = planPipelineMigration([{ id: 'new', name: 'New' }], []).stages;
const NOW = Date.now();
const lead = (id, name, extra) => ({ id, tenantId: T, name, phone: '9000000' + id.slice(-3), source: 'manual', stageId: STAGES[0].id, createdAt: NOW - 86400000, updatedAt: NOW - 3600000, ...extra });
const LEADS = [
  lead('L001', 'Asha'),
  lead('L002', 'Bala', { siteVisitAt: NOW + 86400000, siteVisitStatus: 'scheduled', siteVisitAgents: ['pradeep@threepin.in'] }),
  lead('L003', 'Chitra')
];
const saved = [];
const STUB = `
window.__agentWrites = [];
window.crmFirebase = {
  saveLead: async () => {}, deleteLead: async () => {}, getLeadNotes: async () => [], getLeadHistory: async () => [],
  saveNote: async () => {}, deleteNoteDoc: async () => {}, saveHistory: async () => {}, savePipeline: async () => {},
  getBotConfig: async () => null, saveBotConfig: async () => {}, saveEnquiryTypes: async () => {},
  saveProperties: async () => {}, saveFollowupDigestSettings: async () => {}, saveDashboardEmailSettings: async () => {},
  releaseLeadField: async () => {}, getLeadTailorTalk: async () => null, updateLeadAi: async () => {},
  saveAutomationSettings: async () => {}, saveView: async () => {}, deleteView: async () => {}, getInventory: async () => ({ docs: [] }),
  setLeadAgents: async (id, patch) => { window.__agentWrites.push({ id, patch }); }
};
window.crmAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => '${T}' };
window.onCrmAuthChange({ email: 'thirumal@threepin.in' });
window.applyPipelineSnapshot(${JSON.stringify(STAGES)});
window.applyEnquiryTypesSnapshot(['Property Enquiry']);
window.applyAutomationSettingsSnapshot({ enabled: false });
if (window.applyViewsSnapshot) window.applyViewsSnapshot({});
window.applyTeamSnapshot({ swami: { email: 'swami@threepin.in' }, pradeep: { email: 'pradeep@threepin.in' }, thirumal: { email: 'thirumal@threepin.in' } });
window.applyLeadsSnapshot(${JSON.stringify(LEADS)});
window.__ready = true;
`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const errors = [], thrown = [];
const ok = (label, cond, detail) => { if (cond) console.log('  ok   ' + label); else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); } };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on('pageerror', e => thrown.push(e.message));
await page.route('**/*', route => {
  const u = new URL(route.request().url());
  if (u.hostname !== 'crm.local') return route.abort();
  if (u.pathname === '/crm-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
  if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  const f = join(ROOT, decodeURIComponent(u.pathname));
  if (!existsSync(f)) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({ contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
});
await page.goto('http://crm.local/crm.html');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
await page.evaluate(() => { try { localStorage.removeItem('crmLeadFilter'); } catch (e) {} });

console.log('\nEvery lead starts unassigned');
const cards = await page.evaluate(() => [...document.querySelectorAll('.lcard .lcard-agent')].map(e => e.textContent.trim()));
ok('Each card says Unassigned', cards.length === 3 && cards.every(t => /Unassigned/.test(t)), JSON.stringify(cards));

console.log('\nPicking the agent on the lead page');
await page.evaluate(() => openDetail('L001'));
await page.waitForTimeout(400);
const before = await page.evaluate(() => [...document.querySelectorAll('#dpAgents select')].map(s => ({ v: s.value, opts: [...s.options].map(o => o.textContent), disabled: s.disabled })));
ok('Lead agent and Secondary are on the lead page, both empty', before.length === 2 && before[0].v === '' && before[1].v === '', JSON.stringify(before));
ok('…offering the team by name', before[0].opts.includes('Swami') && before[0].opts.includes('Pradeep'), JSON.stringify(before[0].opts));
ok('…and a secondary only once there is a lead agent', before[1].disabled === true);
await page.selectOption('#dpAgents select >> nth=0', 'swami@threepin.in');
await page.waitForTimeout(200);
await page.selectOption('#dpAgents select >> nth=1', 'pradeep@threepin.in');
await page.waitForTimeout(200);
const writes = await page.evaluate(() => window.__agentWrites);
const last = writes[writes.length - 1] || {};
ok('Both are saved on the lead, with who set them', last.id === 'L001' && last.patch.assignedAgent === 'swami@threepin.in' && last.patch.secondaryAgent === 'pradeep@threepin.in' && last.patch.agentsSetBy === 'thirumal@threepin.in', JSON.stringify(last));
const secondOpts = await page.evaluate(() => [...document.querySelectorAll('#dpAgents select')[1].options].map(o => o.textContent));
ok('The lead agent is not offered again as the secondary', !secondOpts.includes('Swami'), JSON.stringify(secondOpts));
const hist = await page.evaluate(() => (leads.find(l => l.id === 'L001').history || []).map(h => h.text.replace(/<[^>]+>/g, '')));
ok('The timeline records it', hist.some(t => /Lead agent set to Swami/.test(t)) && hist.some(t => /Secondary agent set to Pradeep/.test(t)), JSON.stringify(hist));
const visitUntouched = await page.evaluate(() => JSON.stringify(leads.find(l => l.id === 'L002').siteVisitAgents));
ok('A site visit keeps its own agents', visitUntouched === '["pradeep@threepin.in"]', visitUntouched);
await page.evaluate(() => closeDetail && closeDetail());
await page.waitForTimeout(200);
const card = await page.evaluate(() => (document.querySelector('.lcard[data-lead="L001"] .lcard-agent') || {}).textContent || '');
ok('The card names both', /Swami/.test(card) && /Pradeep/.test(card), card);

console.log('\nFiltering by agent');
const count = () => page.evaluate(() => document.querySelectorAll('.lcard').length);
await page.evaluate(() => setLeadAgentFilter('none'));
ok('Unassigned shows the other two', await count() === 2, String(await count()));
await page.evaluate(() => setLeadAgentFilter('pradeep@threepin.in'));
ok('One person shows the leads they are on, as lead or secondary agent', await count() === 1, String(await count()));
await page.evaluate(() => setLeadAgentFilter(''));
ok('Everyone shows all three again', await count() === 3, String(await count()));

console.log('\nSeveral agents at once');
await page.evaluate(() => { const L = leads.find(l => l.id === 'L003'); L.assignedAgent = 'thirumal@threepin.in'; applyFilters(); renderLeadFilterBar(); });
await page.click('details.lf-agent summary');
await page.waitForTimeout(150);
const rows = await page.evaluate(() => [...document.querySelectorAll('.lf-pop-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()));
ok('The Agent button opens a checklist with counts', rows.some(r => /^Unassigned/.test(r)) && rows.some(r => /^Swami\s*1$/.test(r)) && rows.some(r => /^Thirumal\s*1$/.test(r)), JSON.stringify(rows));
await page.click('.lf-pop-row:has-text("Swami") input');
await page.waitForTimeout(150);
await page.click('.lf-pop-row:has-text("Thirumal") input');
await page.waitForTimeout(150);
ok('Ticking Swami and Thirumal shows both of their leads', await count() === 2, String(await count()));
const stillOpen = await page.evaluate(() => !!document.querySelector('details.lf-agent[open]'));
ok('…and the list stays open while ticking', stillOpen);
const label = await page.evaluate(() => document.querySelector('details.lf-agent summary').textContent.replace(/\s+/g, ' ').trim());
ok('…and the button names them', /Swami/.test(label) && /Thirumal/.test(label), label);
await page.evaluate(() => setLeadAgents([]));

ok('Nothing threw', !thrown.length, thrown.join(' | '));
await browser.close();
console.log('');
if (errors.length) { console.log(errors.length + ' failed'); process.exit(1); }
console.log('All good.');
