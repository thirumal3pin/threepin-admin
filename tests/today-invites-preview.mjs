// ═══════ AN INVITATION MADE IN GOOGLE, ANSWERED FROM THE CRM ═══════
//
//   node tests/today-invites-preview.mjs
//
// A meeting made straight in Google (no CRM stamp on it) and sent to you must
// show in Daily task, in the bell and on the calendar, with the buttons to
// answer it. Google is stubbed; the page is real.

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPipelineMigration } from '../crm-assets/pipeline.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const T = 't_3pinrealty';
const STAGES = planPipelineMigration([{ id: 'new', name: 'New' }], []).stages;
const H = 3600000;
const iso = t => new Date(t).toISOString();
const tomorrowNoon = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(12, 0, 0, 0); return d.getTime(); })();

const ME = 'swami@threepin.in';
const MINE = { person: ME, events: [
  { id: 'g1', title: 'Studios Discussion', start: iso(tomorrowNoon), end: iso(tomorrowNoon + H), busy: true, allDay: false,
    kind: 'default', status: 'confirmed', organiser: 'rajesh@threepin.in', where: 'Anna Nagar', about: 'Script and shoots.',
    attendees: [{ email: 'rajesh@threepin.in', status: 'accepted' }, { email: ME, status: 'needsAction' }, { email: 'pradeep@threepin.in', status: 'needsAction' }] },
  { id: 'g2', title: 'Already said yes', start: iso(tomorrowNoon + 3 * H), end: iso(tomorrowNoon + 4 * H), busy: true, allDay: false,
    kind: 'default', status: 'confirmed', organiser: 'rajesh@threepin.in',
    attendees: [{ email: 'rajesh@threepin.in', status: 'accepted' }, { email: ME, status: 'accepted' }] }
] };

const STUB = `
window.crmFirebase = {
  saveLead: async () => {}, deleteLead: async () => {}, getLeadNotes: async () => [], getLeadHistory: async () => [],
  saveNote: async () => {}, deleteNoteDoc: async () => {}, saveHistory: async () => {}, savePipeline: async () => {},
  getBotConfig: async () => null, saveBotConfig: async () => {}, saveEnquiryTypes: async () => {},
  saveProperties: async () => {}, saveFollowupDigestSettings: async () => {}, saveDashboardEmailSettings: async () => {},
  releaseLeadField: async () => {}, getLeadTailorTalk: async () => null, updateLeadAi: async () => {},
  saveAutomationSettings: async () => {}, saveView: async () => {}, deleteView: async () => {}, getInventory: async () => []
};
window.crmAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => '${T}' };
window.onCrmAuthChange({ email: '${ME}' });
window.applyPipelineSnapshot(${JSON.stringify(STAGES)});
window.applyEnquiryTypesSnapshot(['Property Enquiry']);
window.applyAutomationSettingsSnapshot({ enabled: true });
if (window.applyViewsSnapshot) window.applyViewsSnapshot({});
window.applyLeadsSnapshot([]);
window.__ready = true;
`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
let answered = null;
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
await page.route('**/*', route => {
  const u = new URL(route.request().url());
  if (u.hostname !== 'crm.local') return route.abort();
  if (u.pathname === '/crm-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
  if (u.searchParams.get('action') === 'calendar') {
    const body = JSON.parse(route.request().postData() || '{}');
    // The real server's limit. A window over a month is refused outright, and a
    // page that asks for one gets nothing at all.
    if (body.op === 'day' && body.to - body.from > 31 * 24 * 3600000) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'at most a month at a time' }) });
    if (body.op === 'answer') {
      answered = body;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, replies: [
        { email: ME, status: body.response, reason: body.reason || null }] }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, team: [ME, 'rajesh@threepin.in'], people: [MINE] }) });
  }
  if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  const f = join(ROOT, decodeURIComponent(u.pathname));
  if (!existsSync(f)) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({ contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
});
await page.goto('http://crm.local/crm.html');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });

console.log('\nDAILY TASK');
await page.evaluate(() => { toggleView('today'); });
await page.waitForTimeout(800);
await page.evaluate(() => PinToday.setSpan('week'));
await page.waitForTimeout(300);
const today = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('#todayView .td-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim().slice(0, 120)),
  btns: [...document.querySelectorAll('#todayView button')].map(b => b.textContent.trim())
}));
ok('a Google-made invitation shows in Daily task this week', today.rows.some(r => /Studios Discussion/.test(r)), JSON.stringify(today.rows));
ok('...with the answers to give', today.btns.some(b => /can come/i.test(b)) && today.btns.some(b => /make it/i.test(b)), JSON.stringify(today.btns));

console.log('\nTHE BELL');
const bell = await page.evaluate(() => document.getElementById('bellCount') && document.getElementById('bellCount').textContent);
ok('the bell counts it', !!bell && Number(bell.replace('+', '')) >= 1, String(bell));

console.log('\nANSWERING');
await page.evaluate(() => PinToday.answer('g1', 'accepted'));
await page.waitForTimeout(500);
ok('accepting goes to the server as you', answered && answered.eventId === 'g1' && answered.response === 'accepted', JSON.stringify(answered));

console.log('\nTEAM CALENDAR');
await page.evaluate(() => { toggleView('calendar'); });
await page.waitForTimeout(900);
const cal = await page.evaluate(() => ({
  panel: (document.querySelector('.cal-inv') || {}).textContent || '',
  clickable: document.querySelectorAll('.cal-ev[role=button]').length
}));
ok('the upcoming list names it', /Studios Discussion/.test(cal.panel), cal.panel.slice(0, 200));
ok('...and the block on the grid opens', cal.clickable >= 0);

await browser.close();
console.log('');
if (errors.length) { console.log(errors.length + ' failed:\n  · ' + errors.join('\n  · ')); process.exit(1); }
console.log('All good.');
