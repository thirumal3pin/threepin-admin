// ═══════ ASSIGNING AN AGENT TO A VISIT THE AI BOOKED ═══════
//
//   node tests/crm-assign-agent.mjs
//
// The owner reported the Assign agent button doing nothing — twice, after two
// fixes that each addressed a plausible cause rather than the real one. The
// lead-panel preview kept passing, which means its fixture was not the lead
// the owner was clicking.
//
// This reproduces THAT lead exactly, from the screenshot: a TailorTalk lead,
// a visit the AI agreed from the chat, a property code, nobody assigned, and
// the person signed in NOT on the visit. And it clicks the real button in the
// DOM rather than calling the function, so anything that throws on the way
// shows up here instead of being swallowed by the inline handler.

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPipelineMigration } from '../crm-assets/pipeline.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(join(ROOT, 'tests/out'), { recursive: true });
const T = 't_3pinrealty';
const STAGES = planPipelineMigration([
  { id: 'new', name: 'New' }, { id: 'site_visit', name: 'Site Visit' }
], []).stages;
const sid = k => STAGES.find(s => s.key === k).id;

const at = new Date(); at.setHours(13, 45, 0, 0);
const NOW = Date.now();

// Radhi Radhikha, as the record actually looks.
const LEAD = {
  id: 'tt_t_3pinrealty_contact_919999000111', tenantId: T, name: 'Radhi Radhikha',
  phone: '919999000111', source: 'tailortalk', stageId: sid('visit_pending'),
  propertyInterest: 'T Nagar', budget: '2.25 Cr',
  createdAt: NOW - 5 * 86400000, updatedAt: NOW - 86400000,
  tt: { id: 'x1', category: 'sales', integration: 'whatsapp', lastMessageAt: NOW - 3600000 },
  ai: { at: NOW - 64800000, confidence: 'high', line: 'Site visit agreed', visit: null },
  // Set by the AI from the conversation. No agents, no notes, no mode, no
  // minutes — every optional field absent, which is what a lead the office has
  // not touched looks like.
  siteVisitAt: at.getTime(), siteVisitStatus: 'scheduled', siteVisitProperty: 'TNAG0002',
  siteVisitBy: 'ai', siteVisitSetAt: NOW - 64800000,
  followUpAt: NOW - 3 * 86400000, followUpBy: 'ai'
};

const STUB = `
window.crmFirebase = {
  saveLead: async () => {}, deleteLead: async () => {}, getLeadNotes: async () => [], getLeadHistory: async () => [],
  saveNote: async () => {}, deleteNoteDoc: async () => {}, saveHistory: async () => {}, savePipeline: async () => {},
  getBotConfig: async () => null, saveBotConfig: async () => {}, saveEnquiryTypes: async () => {},
  saveProperties: async () => {}, saveFollowupDigestSettings: async () => {}, saveDashboardEmailSettings: async () => {},
  releaseLeadField: async () => {}, getLeadTailorTalk: async () => null, updateLeadAi: async () => {},
  saveAutomationSettings: async () => {}, saveView: async () => {}, deleteView: async () => {},
  // The live symptom: Firestore's read quota is exhausted, so this never
  // settles. Anything that waits on it waits for ever.
  getInventory: () => new Promise(() => {})
};
window.crmAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => '${T}' };
window.onCrmAuthChange({ email: 'thirumal@threepin.in' });
window.applyPipelineSnapshot(${JSON.stringify(STAGES)});
window.applyEnquiryTypesSnapshot(['Property Enquiry']);
window.applyAutomationSettingsSnapshot({ enabled: true });
if (window.applyViewsSnapshot) window.applyViewsSnapshot({});
window.applyTeamSnapshot({
  swami: { email: 'swami@threepin.in' }, pradeep: { email: 'pradeep@threepin.in' },
  rajesh: { email: 'rajesh@threepin.in' }, thirumal: { email: 'thirumal@threepin.in' }
});
window.applyLeadsSnapshot(${JSON.stringify([LEAD])});
window.__ready = true;
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const errors = [];
const thrown = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};

const browser = await chromium.launch();

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
console.log('');
console.log('═'.repeat(64));
console.log(viewport.width === 390 ? 'ON A PHONE' : 'ON A LAPTOP');
console.log('═'.repeat(64));
const ctx = await browser.newContext({ viewport });
const page = await ctx.newPage();
// An inline onclick that throws is silent in the UI. It is not silent here.
page.on('pageerror', e => thrown.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) thrown.push(m.text()); });

await page.route('**/*', route => {
  const u = new URL(route.request().url());
  if (u.hostname !== 'crm.local') return route.abort();
  if (u.pathname === '/crm-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
  if (u.searchParams.get('action') === 'calendar') {
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, people: [
      { person: 'swami@threepin.in', events: [] }, { person: 'pradeep@threepin.in', events: [] },
      { person: 'rajesh@threepin.in', events: [] }, { person: 'thirumal@threepin.in', events: [] }
    ] }) });
  }
  if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  const f = join(ROOT, decodeURIComponent(u.pathname));
  if (!existsSync(f)) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({ contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
});

await page.goto('http://crm.local/crm.html');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
await page.evaluate(id => openDetail(id), LEAD.id);
await page.waitForTimeout(900);

console.log('');
console.log('The lead as the owner sees it');
const row = await page.evaluate(() => {
  const b = document.querySelector('#dpVisit button');
  return { text: b ? b.textContent.trim() : null, shown: !!b && !document.getElementById('dpVisitSec').hidden,
    said: (document.querySelector('#dpVisit .sv-val') || {}).textContent.replace(/\s+/g, ' ').trim() || '' };
});
ok('the visit the AI booked is shown', row.shown && /TNAG0002/.test(row.said), row.said);
ok('...with nobody on it', /nobody assigned/i.test(row.said), row.said);
ok('...and a button that says so', row.text === 'Assign agent', row.text);

// The click itself — the real element, the real handler.
thrown.length = 0;
await page.click('#dpVisit button');
await page.waitForTimeout(800);

const opened = await page.evaluate(() => {
  const sheet = document.getElementById('svSheet');
  // EXISTING is not SHOWING. The first version of this test asked whether the
  // element was in the DOM, and a form sitting behind an opaque full-screen
  // panel answers yes. Ask the browser what is actually painted at the middle
  // of the form, and whether that thing is part of the form.
  let visible = false, covering = null;
  if (sheet) {
    const box = sheet.querySelector('.cal-sheet-in');
    const r = box.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + 40));
    visible = !!hit && sheet.contains(hit);
    if (!visible && hit) covering = (hit.id || hit.className || hit.tagName) + '';
  }
  return { open: !!sheet, visible: visible, covering: covering,
    agents: sheet ? sheet.querySelectorAll('#svAgents input').length : 0,
    fields: ['svDate', 'svTime', 'svMins', 'svProp', 'svNotes', 'svStatus'].filter(i => !document.getElementById(i)),
    propText: (document.getElementById('svProp') || {}).textContent || '' };
});

console.log('');
console.log('Clicking Assign agent');
if (thrown.length) {
  console.log('  the click threw:');
  thrown.forEach(t => console.log('    ' + t));
}
ok('the form opens', opened.open, thrown[0] || 'nothing happened and nothing threw');
// The bug the owner hit twice: in the DOM, filled in, and behind the lead panel.
ok('...where somebody can actually see it', opened.visible,
  opened.covering ? 'covered by ' + opened.covering : 'not painted');
ok('...even though the inventory never loads', opened.open && opened.fields.length === 0, opened.fields.join(','));
ok('...listing the team to assign', opened.agents >= 3, String(opened.agents));
ok('...and saying the property list is still coming', /loading/i.test(opened.propText), opened.propText.slice(0, 60));
ok('nothing threw on the way', thrown.length === 0, thrown.join(' | '));

// The form has to FIT, not merely be on top of things. A sheet wider than the
// screen puts Save off the right-hand edge, which is its own kind of button
// that does nothing.
if (opened.open) {
  const fits = await page.evaluate(() => {
    const box = document.querySelector('#svSheet .cal-sheet-in');
    const r = box.getBoundingClientRect();
    const save = [...box.querySelectorAll('button')].find(b => /Send|Update/.test(b.textContent));
    const sr = save ? save.getBoundingClientRect() : null;
    return { right: Math.round(r.right), w: innerWidth,
      // Reachable means ON THE SCREEN, both ways. The sheet scrolls, so the
      // actions used to scroll off the bottom of a phone and the form opened
      // with no visible way to finish it.
      saveOn: sr ? (sr.right <= innerWidth + 2 && sr.left >= -2 && sr.width > 40
        && sr.bottom <= innerHeight + 2 && sr.top >= -2) : false,
      // The tap target is the LABEL wrapping a checkbox, not the 15px box.
      taps: [...box.querySelectorAll('input:not([type=checkbox]):not([type=radio]),select,button,.cm-p')]
        .map(e => Math.round(e.getBoundingClientRect().height)),
      shouting: [...box.querySelectorAll('.cm-p')]
        .filter(e => getComputedStyle(e).textTransform === 'uppercase').length,
      // The sheet is a flex column with a max height. Its children default to
      // flex-shrink:1, so once the form is taller than the sheet they all get
      // squeezed - and the textarea, being the tallest flexible thing, is
      // squeezed hardest. It ended up half a line high with its own
      // placeholder clipped through the middle.
      notes: Math.round(document.getElementById('svNotes').getBoundingClientRect().height),
      // Checkboxes and radios are 15px by design; their label is the target.
      squashed: [...box.querySelectorAll('input:not([type=checkbox]):not([type=radio]),select,textarea')]
        .filter(e => e.getBoundingClientRect().height < 28)
        .map(e => (e.id || e.tagName) + ':' + Math.round(e.getBoundingClientRect().height)) };
  });
  ok('...fitting the screen', fits.right <= fits.w + 2, JSON.stringify(fits));
  ok('...with Save reachable', fits.saveOn, JSON.stringify(fits));
  ok('...and controls big enough to tap', Math.min(...fits.taps) >= 30, fits.taps.join(','));
  // A caption style leaking onto a person's name renders "PRADEEP".
  ok('...with names written, not shouted', fits.shouting === 0, fits.shouting + ' uppercased');
  ok('...a notes box you can actually write in', fits.notes >= 50, fits.notes + 'px tall');
  ok('...and nothing squeezed flat by the form being long', fits.squashed.length === 0, fits.squashed.join(', '));
}

// A picture of it open, because "is it fixed" is a question about what a
// person sees, not about what an assertion returns.
if (opened.open) await page.screenshot({ path: join(ROOT, 'tests/out/assign-' + viewport.width + '.png') });

// And the whole point: assigning somebody.
if (opened.open) {
  const saved = await page.evaluate(async () => {
    [...document.querySelectorAll('#svAgents input')].forEach(i => { i.checked = i.value === 'rajesh@threepin.in'; });
    saveVisitEdit('tt_t_3pinrealty_contact_919999000111');
    await new Promise(r => setTimeout(r, 400));
    const l = leads.find(x => x.id === 'tt_t_3pinrealty_contact_919999000111');
    return { agents: l.siteVisitAgents, closed: !document.getElementById('svSheet'),
      row: (document.querySelector('#dpVisit .sv-val') || {}).textContent.replace(/\s+/g, ' ').trim() || '' };
  });
  console.log('');
  console.log('Assigning somebody');
  ok('the agent is assigned', (saved.agents || []).includes('rajesh@threepin.in'), JSON.stringify(saved.agents));
  ok('...the form closes', saved.closed);
  ok('...and the row says who is going', /Rajesh/i.test(saved.row) && !/nobody assigned/i.test(saved.row), saved.row);
}

await ctx.close();
}
await browser.close();
console.log('');
console.log('─'.repeat(64));
if (errors.length) { console.log(errors.length + ' problem(s):'); errors.forEach(e => console.log('  · ' + e)); process.exit(1); }
console.log('All good.');
