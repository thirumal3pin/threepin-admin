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

// Anchored to the clock, not to 11am. Fixed at 11:00 it only straddled "now"
// if the suite happened to run late morning, so "somebody in a meeting reads
// as busy" passed before lunch and failed after it.
const now = Date.now();
const at = now - 30 * 60000;   // started half an hour ago, still running
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
  // Outside the normal 8am-9pm working window. A fixed grid dropped these
  // without a word, which is how a calendar starts lying about somebody's day.
  { person: 'pradeep@threepin.in', events: [
    { id: 'early', title: 'Early site visit', start: iso(at - 5 * H), end: iso(at - 4 * H), busy: true, allDay: false }
  ] },
  { person: 'admin@threepin.in', events: [
    // A meeting where one person has said yes, one has said no and one has not
    // answered at all. Booking from the CRM is only worth doing if the answers
    // come back to the CRM.
    { id: 'mtg1', title: 'Monday review', start: iso(at + 2 * H), end: iso(at + 2.5 * H), busy: true, allDay: false,
      meetingId: '1', meet: 'https://meet.google.com/abc',
      attendees: [{ email: 'swami@threepin.in', status: 'needsAction' },
                  { email: 'pradeep@threepin.in', status: 'declined', reason: 'Bank appointment.' },
                  { email: 'sales@threepin.in', status: 'accepted' }] }
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
let answered = null;

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
      if (body.op === 'event') {
        if (body.eventId !== 'mtg1') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'That is not a 3 PIN booking' }) });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, event: {
          id: 'mtg1', title: 'Monday review', start: iso(at + 2 * H), end: iso(at + 2.5 * H),
          where: 'Office', about: 'Pipeline and the week ahead.', meet: 'https://meet.google.com/abc',
          organiser: 'sales@threepin.in', leadId: null, mine: 'needsAction',
          attendees: [{ email: 'swami@threepin.in', status: 'needsAction', reason: null },
                      { email: 'pradeep@threepin.in', status: 'declined', reason: 'Bank appointment.' },
                      { email: 'sales@threepin.in', status: 'accepted', reason: null } ] } }) });
      }
      if (body.op === 'answer') {
        answered = body;
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, replies: [
          { email: 'swami@threepin.in', status: body.response, reason: body.reason || null },
          { email: 'pradeep@threepin.in', status: 'declined', reason: 'Bank appointment.' },
          { email: 'sales@threepin.in', status: 'accepted', reason: null } ] }) });
      }
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
      rsvp: (document.querySelector('.cal-ev.meet .cal-rsvp') || {}).textContent || null,
      rsvpTitle: (document.querySelector('.cal-ev.meet') || {}).title || null,
      earlyShown: [...document.querySelectorAll('.cal-ev')].some(e => /Early site visit/.test(e.textContent)),
      hours: [...document.querySelectorAll('.cal-hr')].map(h => h.textContent),
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
  // The question the owner asked: do their replies come back? They do, and
  // until now the CRM fetched them and threw them away.
  ok('a meeting shows how many have accepted, out of how many were asked',
    /1\/3/.test(grid.rsvp || ''), JSON.stringify(grid.rsvp));
  ok('...and flags that somebody declined', /2|✗/.test(grid.rsvp || ''), JSON.stringify(grid.rsvp));
  ok('...naming who is coming and who has not replied, on hover',
    /Coming: .*Not coming: .*No reply yet: /s.test(grid.rsvpTitle || ''), JSON.stringify(grid.rsvpTitle));
  // The grid stretches rather than cropping: an appointment the page does not
  // draw is one nobody turns up to.
  ok('an appointment outside working hours is still drawn',
    grid.earlyShown, JSON.stringify(grid.hours));
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
      meetDefault: (s.querySelector('#cmMeet') || {}).checked,
      repeats: [...s.querySelectorAll('#cmRepeat option')].map(o => o.value),
      repeatDefault: (s.querySelector('#cmRepeat') || {}).value,
      also: !!s.querySelector('#cmAlso') };
  });
  ok('New meeting opens a booking form', sheet.open);
  ok('...listing the whole team to invite', sheet.people === 5, String(sheet.people));
  ok('...with you already in it and not removable', sheet.selfLocked);
  ok('...offering a Meet link by default', sheet.meetDefault === true);
  // The weekly review is the meeting people actually keep. Having to open
  // Google to set one up is having to open Google.
  ok('...and a repeating meeting can be set from here', sheet.repeats.includes('weekly'), JSON.stringify(sheet.repeats));
  ok('...with a one-off still the default', sheet.repeatDefault === 'none', sheet.repeatDefault);
  // Colleagues exist who need no calendar column here but still come to meetings.
  ok('...and somebody with no column can still be invited', sheet.also);
  ok('...and fitting the screen', sheet.fits, JSON.stringify(sheet));

  // A meeting with no name is one nobody recognises in a week.
  const noName = await page.evaluate(() => { PinCalendar.book(); const e = document.getElementById('cmErr'); return { shown: e.classList.contains('show'), text: e.textContent }; });
  ok('a nameless meeting is refused, and says why', noName.shown && noName.text.length > 20, noName.text);

  const typedBad = await page.evaluate(() => {
    document.getElementById('cmTitle').value = 'Monday pipeline review';
    document.getElementById('cmAlso').value = 'rajesh';
    [...document.querySelectorAll('.cm-who input:not(:disabled)')][0].checked = true;
    PinCalendar.book();
    const e = document.getElementById('cmErr');
    return { shown: e.classList.contains('show'), text: e.textContent };
  });
  ok('a half-typed address is refused, and names which one', typedBad.shown && /rajesh/.test(typedBad.text), typedBad.text);

  const sent = await page.evaluate(async () => {
    document.getElementById('cmTitle').value = 'Monday pipeline review';
    document.getElementById('cmAlso').value = 'rajesh@threepin.in';
    const boxes = [...document.querySelectorAll('.cm-who input:not(:disabled)')];
    boxes[0].checked = true;
    PinCalendar.book();
    await new Promise(r => setTimeout(r, 400));
    return { closed: !document.querySelector('#calSheet') };
  });
  ok('booking sends the invitations', !!booked && booked.op === 'meeting', JSON.stringify(booked));
  ok('...with the title, the time and the people', !!(booked.title && booked.at && booked.attendees.length), JSON.stringify(booked));
  ok('...and how often it repeats', typeof booked.repeat === 'string', JSON.stringify(booked.repeat));
  ok('...including somebody typed in who has no column here',
    (booked.attendees || []).includes('rajesh@threepin.in'), JSON.stringify(booked.attendees));
  ok('...and closes the form', sent.closed);

  // ── ANSWERING A MEETING FROM THE CALENDAR ITSELF ──
  //
  // A site visit sends you to the lead, because what you need in order to
  // decide — who the client is, what the office wrote down — is there. A
  // meeting has nowhere else to be, so it is answered here rather than by
  // going and hunting for the invitation in your mail.
  answered = null;
  const detail = await page.evaluate(async () => {
    [...document.querySelectorAll('.cal-ev.meet')][0].click();
    await new Promise(r => setTimeout(r, 500));
    const sheet = document.getElementById('evSheet');
    const box = sheet && sheet.querySelector('.cal-sheet-in');
    const r2 = box ? box.getBoundingClientRect() : null;
    const hit = r2 ? document.elementFromPoint(Math.round(r2.left + r2.width / 2), Math.round(r2.top + 30)) : null;
    return { open: !!sheet, visible: !!(hit && sheet.contains(hit)),
      title: ((sheet && sheet.querySelector('h3')) || {}).textContent || '',
      mine: ((sheet && sheet.querySelector('.ev-mine')) || {}).textContent || '',
      people: sheet ? sheet.querySelectorAll('.ev-who').length : 0,
      text: sheet ? sheet.textContent : '',
      meet: !!(sheet && sheet.querySelector('.ev-meet')),
      buttons: sheet ? [...sheet.querySelectorAll('.cal-sheet-acts button')].map(x => x.textContent.trim()) : [] };
  });
  ok('a meeting opens from the grid', detail.open && /Monday review/.test(detail.title), detail.title);
  ok('...somewhere you can see it', detail.visible);
  ok('...saying where you stand on it', /No reply yet/i.test(detail.mine), detail.mine);
  ok('...and where everyone else does', detail.people === 3, String(detail.people));
  // A refusal without its reason makes somebody go and ask.
  ok('...including why somebody cannot come', /Bank appointment/.test(detail.text));
  ok('...with the video link to hand', detail.meet);
  ok('...and both answers offered',
    detail.buttons.some(x => /can come/i.test(x)) && detail.buttons.some(x => /make it/i.test(x)), JSON.stringify(detail.buttons));

  const said = await page.evaluate(async () => {
    PinCalendar.answer('accepted');
    await new Promise(r => setTimeout(r, 450));
    return { mine: (document.querySelector('.ev-mine') || {}).textContent || '' };
  });
  ok('accepting is sent', !!answered && answered.response === 'accepted', JSON.stringify(answered));
  ok('...and the sheet says so straight away', /Coming/i.test(said.mine), said.mine);

  const refused = await page.evaluate(async () => {
    PinCalendar.answer('declined', 'Site visit in Tambaram that afternoon.');
    await new Promise(r => setTimeout(r, 450));
    return { mine: (document.querySelector('.ev-mine') || {}).textContent || '' };
  });
  ok('a refusal carries its reason', /Tambaram/.test((answered || {}).reason || ''), JSON.stringify(answered));
  ok('...and is shown as such', /Not coming/i.test(refused.mine), refused.mine);
  await page.evaluate(() => PinCalendar.closeEvent());

  // Somebody's own appointment is drawn as a busy block. Opening it would hand
  // over what it is, so it does not open.
  const priv = await page.evaluate(() => {
    const block = [...document.querySelectorAll('.cal-ev')].find(e => /Standup/.test(e.textContent));
    return { clickable: !!(block && block.getAttribute('onclick')) };
  });
  ok('an event the CRM did not book does not open', !priv.clickable);

  // ── WEEK AND MONTH, ONE PERSON ──
  // Six people across seven days is a wall nobody reads. These spans answer a
  // different question — "what has Swami got on" — so they show one person.
  const week = await page.evaluate(async () => {
    PinCalendar.setSpan('week');
    await new Promise(r => setTimeout(r, 600));
    return { cols: document.querySelectorAll('.cal-col').length,
      heads: [...document.querySelectorAll('.cal-col-h b')].map(b => b.textContent),
      picker: !!document.querySelector('.cal-who'),
      on: (document.querySelector('.cal-span.on') || {}).textContent,
      label: (document.querySelector('.cal-date') || {}).textContent || '' };
  });
  ok('a week shows seven days', week.cols === 7, JSON.stringify(week.heads));
  ok('...of one person, chosen from a picker', week.picker);
  ok('...with the span marked', week.on === 'Week', week.on);
  ok('...and the dates it covers', /\d/.test(week.label), week.label);

  const month = await page.evaluate(async () => {
    PinCalendar.setSpan('month');
    await new Promise(r => setTimeout(r, 600));
    return { cells: document.querySelectorAll('.cal-m-d').length,
      heads: document.querySelectorAll('.cal-m-h').length,
      today: document.querySelectorAll('.cal-m-d.today').length,
      hours: document.querySelectorAll('.cal-hr').length };
  });
  ok('a month draws whole weeks', month.cells % 7 === 0 && month.cells >= 28, String(month.cells));
  ok('...under seven weekday headings', month.heads === 7, String(month.heads));
  ok('...marking today once', month.today <= 1, String(month.today));
  // At a month's scale the start time is noise; which days are heavy is not.
  ok('...and drops the hour rail, which means nothing at that scale', month.hours === 0, String(month.hours));

  // ── FINDING A TIME ──
  // Booking by guessing and reading five refusals is how people give up on a
  // scheduler. This offers the times that actually work.
  const find = await page.evaluate(async () => {
    PinCalendar.setSpan('day');
    await new Promise(r => setTimeout(r, 400));
    PinCalendar.findTime();
    await new Promise(r => setTimeout(r, 700));
    const sheet = document.getElementById('findSheet');
    return { open: !!sheet, who: sheet ? sheet.querySelectorAll('#ftWho input').length : 0,
      slots: document.querySelectorAll('.ft-slot').length,
      firstSlot: (document.querySelector('.ft-slot') || {}).textContent || '',
      days: document.querySelectorAll('.ft-day').length };
  });
  ok('there is a scheduling assistant', find.open && find.who > 0, JSON.stringify(find));
  ok('...offering times everyone is free', find.slots > 0, JSON.stringify(find));
  ok('...as real clock times', /\d/.test(find.firstSlot), find.firstSlot);
  ok('...grouped by day', find.days > 0, String(find.days));

  // Finding a time and then retyping it is the half that gets skipped.
  const used = await page.evaluate(async () => {
    document.querySelector('.ft-slot').click();
    await new Promise(r => setTimeout(r, 400));
    return { findClosed: !document.getElementById('findSheet'),
      booking: !!document.getElementById('calSheet'),
      date: (document.getElementById('cmDate') || {}).value,
      time: (document.getElementById('cmTime') || {}).value,
      ticked: [...document.querySelectorAll('.cm-who input:checked')].length };
  });
  ok('picking a slot opens the booking form already filled in',
    used.booking && used.findClosed && !!used.date && !!used.time, JSON.stringify(used));
  ok('...with the people it was found for', used.ticked > 0, String(used.ticked));
  await page.evaluate(() => PinCalendar.closeMeeting());

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
