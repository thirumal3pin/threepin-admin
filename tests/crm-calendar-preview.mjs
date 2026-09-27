// ═══════ THE TEAM CALENDAR, IN A BROWSER ═══════
//
//   node tests/crm-calendar-preview.mjs <out-dir>
//
// The unit tests in calendar.test.mjs prove what the CRM will and will not do
// to somebody's Google Calendar. This one proves the page: that five people's
// days line up against the same hours, that two overlapping meetings do not
// hide each other, that the status reads the way Teams reads, and that none of
// it collapses on a phone.
//
// Google is stubbed. The point here is the layout and the wiring, and driving
// real calendars from a test would book real meetings in real diaries.

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPipelineMigration } from '../crm-assets/pipeline.js';

const OUT = process.argv[2] || 'tests/out/crm-calendar';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const T = 't_3pinrealty';
const STAGES = planPipelineMigration([{ id: 'new', name: 'New' }, { id: 'site_visit', name: 'Site Visit' }], []).stages;

// A day built around 11am local, so the grid always has something in view.
const base = new Date(); base.setHours(11, 0, 0, 0);
const at = base.getTime();
const H = 3600000;
const iso = t => new Date(t).toISOString();

const PEOPLE = [
  { person: 'sales@threepin.in', events: [
    { id: 'a', title: 'Standup', start: iso(at - 2 * H), end: iso(at - 1.5 * H), busy: true, allDay: false },
    { id: 'b', title: 'Site visit: Mr Kumar · ANRL001', start: iso(at), end: iso(at + H), busy: true, allDay: false, leadId: 'B1' }
  ] },
  { person: 'swami@threepin.in', events: [
    // Two meetings that overlap: if the layout stacks them, one is invisible
    // and somebody gets double-booked.
    { id: 'c', title: 'Bank call', start: iso(at), end: iso(at + H), busy: true, allDay: false },
    { id: 'd', title: 'Owner meeting', start: iso(at + 0.5 * H), end: iso(at + 1.5 * H), busy: true, allDay: false },
    { id: 'e', title: 'Diwali', start: iso(at + 3 * H), end: iso(at + 4 * H), busy: false, allDay: false }
  ] },
  { person: 'pradeep@threepin.in', events: [] },
  { person: 'admin@threepin.in', events: [
    { id: 'f', title: 'Monday review', start: iso(at + 2 * H), end: iso(at + 2.5 * H), busy: true, allDay: false, meetingId: '1', meet: 'https://meet.google.com/abc' }
  ] },
  { person: 'thirumal@threepin.in', events: [], error: 'calendar unreadable' }
];

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
window.onCrmAuthChange({ email: 'swami@threepin.in' });
window.applyPipelineSnapshot(${JSON.stringify(STAGES)});
window.applyEnquiryTypesSnapshot(['Property Enquiry']);
window.applyAutomationSettingsSnapshot({ enabled: true });
if (window.applyViewsSnapshot) window.applyViewsSnapshot({});
window.applyLeadsSnapshot([{ id: 'B1', tenantId: '${T}', name: 'Mr Kumar', phone: '9840012345', stageId: '${STAGES[0].id}', createdAt: Date.now(), updatedAt: Date.now() }]);
window.__ready = true;
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};

const browser = await chromium.launch();
let booked = null;

async function open(viewport, calendarReply) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${viewport.width}px pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource|net::ERR/.test(m.text())) return;
    errors.push(`${viewport.width}px console: ${m.text()}`);
  });
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'crm.local') return route.abort();
    if (u.pathname === '/crm-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
    if (u.searchParams.get('action') === 'calendar') {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.op === 'meeting') { booked = body; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, eventId: 'm1', meet: 'https://meet.google.com/xyz' }) }); }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(calendarReply) });
    }
    if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    const f = join(ROOT, decodeURIComponent(u.pathname));
    if (!existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
  });
  await page.goto('http://crm.local/crm.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.evaluate(() => toggleView('calendar'));
  await page.waitForTimeout(700);
  return page;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  console.log('');
  console.log(viewport.width === 390 ? 'On a phone' : 'On a laptop');
  const page = await open(viewport, { ok: true, people: PEOPLE });

  const grid = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.cal-col')];
    const evs = [...document.querySelectorAll('.cal-ev')];
    const rect = e => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), w: Math.round(r.width), t: Math.round(r.top), h: Math.round(r.height) }; };
    return {
      columns: cols.length,
      names: cols.map(c => (c.querySelector('b') || {}).textContent),
      statuses: cols.map(c => (c.querySelector('.cal-st') || {}).textContent),
      dots: cols.map(c => { const d = c.querySelector('.cal-dot'); return d ? d.className.replace('cal-dot', '').trim() || 'free' : null; }),
      events: evs.length,
      visits: document.querySelectorAll('.cal-ev.visit').length,
      free: document.querySelectorAll('.cal-ev.free').length,
      nowLine: !!document.querySelector('.cal-now'),
      overlap: (() => {
        const swami = cols[1];
        const two = [...swami.querySelectorAll('.cal-ev')].filter(e => /Bank call|Owner meeting/.test(e.textContent)).map(rect);
        if (two.length !== 2) return 'expected 2, got ' + two.length;
        // Side by side, not on top of each other.
        return (two[0].l + two[0].w <= two[1].l + 2 || two[1].l + two[1].w <= two[0].l + 2) ? 'side by side' : 'overlapping';
      })(),
      overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth)
    };
  });

  ok('every agent gets a column', grid.columns === 5, grid.columns + ': ' + grid.names.join(', '));
  ok('...including the one with nothing on', /Pradeep|pradeep/i.test(grid.names.join(',')));
  ok('the hours are drawn once, down the side', await page.evaluate(() => document.querySelectorAll('.cal-hr').length > 8));
  ok('events are placed on the grid', grid.events >= 5, JSON.stringify(grid.events));
  // The bug this catches is the ugly one: two meetings at once, one hidden.
  ok('two meetings at the same time sit side by side, not on top of each other',
    grid.overlap === 'side by side', grid.overlap);
  ok('a site visit is marked as the CRM’s own work', grid.visits === 1, String(grid.visits));
  ok('...and an event marked free is drawn differently', grid.free === 1, String(grid.free));
  ok('the current time is marked', grid.nowLine);
  ok('an unreadable calendar says so rather than looking free',
    grid.statuses.some(s => /unreadable/i.test(s || '')), JSON.stringify(grid.statuses));
  // The one lie a status board must never tell. A green dot beside "unreadable"
  // gets somebody booked into a meeting they were already in.
  ok('...and is not given the green dot that means free',
    grid.dots[grid.statuses.findIndex(s => /unreadable/i.test(s || ''))] === 'unknown', JSON.stringify(grid.dots));
  ok('somebody in a meeting reads as busy',
    grid.statuses.some(s => /in a (meeting|site visit) until/i.test(s || '')), JSON.stringify(grid.statuses));
  ok('...and somebody with a clear day reads as free',
    grid.statuses.some(s => /^free/i.test((s || '').trim())), JSON.stringify(grid.statuses));
  // The grid scrolls sideways inside itself; the PAGE must not.
  ok('the page does not scroll sideways', grid.overflowX === 0, grid.overflowX + 'px');

  // ── Booking a meeting ──
  booked = null;
  await page.click('.cal-acts .tt-btn:last-child');
  await page.waitForTimeout(300);
  const sheet = await page.evaluate(() => {
    const s = document.querySelector('#calSheet');
    if (!s) return { open: false };
    const r = s.querySelector('.cal-sheet-in').getBoundingClientRect();
    return { open: true, fits: r.right <= innerWidth + 2 && r.width > 200,
      people: [...s.querySelectorAll('.cm-who input')].length,
      selfLocked: [...s.querySelectorAll('.cm-who input')].some(i => i.disabled && i.checked),
      meetDefault: (s.querySelector('#cmMeet') || {}).checked };
  });
  ok('New meeting opens a booking form', sheet.open);
  ok('...listing the whole team to invite', sheet.people === 5, String(sheet.people));
  ok('...with you already in it and not removable', sheet.selfLocked);
  ok('...offering a Meet link by default', sheet.meetDefault === true);
  ok('...and fitting the screen', sheet.fits, JSON.stringify(sheet));

  // A meeting with no name is one nobody recognises in a week.
  const noName = await page.evaluate(() => { PinCalendar.book(); const e = document.getElementById('cmErr'); return { shown: e.classList.contains('show'), text: e.textContent }; });
  ok('a nameless meeting is refused, and says why', noName.shown && noName.text.length > 20, noName.text);

  const sent = await page.evaluate(async () => {
    document.getElementById('cmTitle').value = 'Monday pipeline review';
    const boxes = [...document.querySelectorAll('.cm-who input:not(:disabled)')];
    boxes[0].checked = true;
    PinCalendar.book();
    await new Promise(r => setTimeout(r, 400));
    return { closed: !document.querySelector('#calSheet') };
  });
  ok('booking sends the invitations', !!booked && booked.op === 'meeting', JSON.stringify(booked));
  ok('...with the title, the time and the people', !!(booked.title && booked.at && booked.attendees.length), JSON.stringify(booked));
  ok('...and closes the form', sent.closed);

  await page.screenshot({ path: join(OUT, (viewport.width === 390 ? 'phone' : 'laptop') + '.png'), fullPage: false });
  await page.context().close();
}

// ═══════ BEFORE GOOGLE IS SET UP ═══════
// The two console steps are the owner's to do. Until then this page must read
// as "not set up yet" and explain itself, not as a broken CRM.
console.log('');
console.log('Before the Workspace switch is flipped');
{
  const page = await open({ width: 1440, height: 900 },
    { ok: false, notReady: true, error: 'Google has not been told this CRM may read the team calendars',
      hint: 'Add client id 118007570407573886710 with scope .../auth/calendar under Domain Wide Delegation in the Workspace admin console.' });
  const msg = await page.evaluate(() => {
    const m = document.querySelector('.cal-msg.err');
    return { there: !!m, text: m ? m.textContent : '', red: !!document.querySelector('.cal-grid') };
  });
  ok('it says what is missing', msg.there && /Domain Wide Delegation/.test(msg.text), msg.text.slice(0, 120));
  ok('...rather than drawing an empty grid', !msg.red);
  ok('...and says the rest of the CRM is fine', /rest of the CRM is unaffected/i.test(msg.text));
  await page.screenshot({ path: join(OUT, 'not-set-up.png') });
  await page.context().close();
}

await browser.close();
console.log('');
console.log('─'.repeat(64));
console.log('screenshots → ' + OUT);
if (errors.length) {
  console.log('');
  console.log(errors.length + ' problem(s):');
  errors.forEach(e => console.log('  · ' + e));
  process.exit(1);
}
console.log('All good.');
