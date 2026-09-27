// ═══════ THE DAY, AS SOMEBODY LEAVING THE OFFICE READS IT ═══════
//
//   node tests/crm-today-preview.mjs
//
// Daily task had no test at all, which is how a screen people open first thing
// every morning ends up showing "Site visit — TNAG0002" and nothing else: not
// which property that is, not who is going, not whether they have said yes.
//
// The three things this screen has to answer before somebody picks up their
// keys: which property, who is going, and is it actually settled.

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPipelineMigration } from '../crm-assets/pipeline.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(join(ROOT, 'tests/out'), { recursive: true });
const T = 't_3pinrealty';
const STAGES = planPipelineMigration([{ id: 'new', name: 'New' }, { id: 'site_visit', name: 'Site Visit' }], []).stages;
const sid = k => STAGES.find(s => s.key === k).id;
const NOW = Date.now();
const atHour = h => { const d = new Date(); d.setHours(h, 30, 0, 0); return d.getTime(); };

const INV = [
  { id: 'p1', propertyCode: 'TNAG0002', name: '2BHK Apartment for Sale in T. Nagar',
    location: 'T. Nagar', contactName: 'Mr Rajan', contactNumber: '9840099887' },
  { id: 'p2', propertyCode: 'VGN0004', name: 'VGN Stafford, Avadi', location: 'Avadi' }
];

const LEADS = [
  // Everybody has answered. Settled; nothing to chase.
  { id: 'L1', tenantId: T, name: 'Radhi Radhikha', phone: '919999000111', stageId: sid('visit_pending'),
    createdAt: NOW - 4 * 86400000, updatedAt: NOW - 86400000,
    siteVisitAt: atHour(14), siteVisitStatus: 'scheduled', siteVisitProperty: 'TNAG0002',
    siteVisitAgents: ['swami@threepin.in', 'thirumal@threepin.in'],
    siteVisitReplies: [{ email: 'swami@threepin.in', status: 'accepted', reason: null },
                       { email: 'thirumal@threepin.in', status: 'needsAction', reason: null }] },
  // Sent, not answered. This is the one to sort out this morning.
  { id: 'L2', tenantId: T, name: 'Vignesh R', phone: '919888000222', stageId: sid('visit_pending'),
    createdAt: NOW - 3 * 86400000, updatedAt: NOW - 86400000,
    siteVisitAt: atHour(17), siteVisitStatus: 'scheduled', siteVisitProperty: 'VGN0004',
    siteVisitAgents: ['pradeep@threepin.in', 'rajesh@threepin.in'],
    siteVisitReplies: [{ email: 'pradeep@threepin.in', status: 'needsAction', reason: null },
                       { email: 'rajesh@threepin.in', status: 'declined', reason: 'On another visit.' }] },
  // Booked, nobody on it.
  { id: 'L3', tenantId: T, name: 'Kirthika P', phone: '919777000333', stageId: sid('visit_pending'),
    createdAt: NOW - 2 * 86400000, updatedAt: NOW - 86400000,
    siteVisitAt: atHour(11), siteVisitStatus: 'scheduled', siteVisitProperty: 'TNAG0002',
    siteVisitAgents: [] },
  // No travel: the agent rings both sides and puts it together.
  { id: 'L4', tenantId: T, name: 'Arun S', phone: '919666000444', stageId: sid('visit_pending'),
    createdAt: NOW - 86400000, updatedAt: NOW - 86400000,
    siteVisitAt: atHour(10), siteVisitStatus: 'scheduled', siteVisitProperty: 'VGN0004',
    siteVisitMode: 'remote', siteVisitAgents: ['swami@threepin.in'],
    siteVisitReplies: [{ email: 'swami@threepin.in', status: 'accepted', reason: null }] }
];

const STUB = `
window.crmFirebase = {
  saveLead: async () => {}, deleteLead: async () => {}, getLeadNotes: async () => [], getLeadHistory: async () => [],
  saveNote: async () => {}, deleteNoteDoc: async () => {}, saveHistory: async () => {}, savePipeline: async () => {},
  getBotConfig: async () => null, saveBotConfig: async () => {}, saveEnquiryTypes: async () => {},
  saveProperties: async () => {}, saveFollowupDigestSettings: async () => {}, saveDashboardEmailSettings: async () => {},
  releaseLeadField: async () => {}, getLeadTailorTalk: async () => null, updateLeadAi: async () => {},
  saveAutomationSettings: async () => {}, saveView: async () => {}, deleteView: async () => {},
  getInventory: async () => (${JSON.stringify(INV)})
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
window.applyPropertiesSnapshot && window.applyPropertiesSnapshot(${JSON.stringify(INV)});
window.applyLeadsSnapshot(${JSON.stringify(LEADS)});
window.__ready = true;
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};

const browser = await chromium.launch();
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  console.log('');
  console.log(viewport.width === 390 ? 'On a phone' : 'On a laptop');
  const ctx = await browser.newContext({ viewport });
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
      const b = JSON.parse(route.request().postData() || '{}');
      if (b.op === 'day') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, people: [
        { person: 'thirumal@threepin.in', events: [
          { id: 'm1', title: 'Monday pipeline review', start: new Date(atHour(9)).toISOString(),
            end: new Date(atHour(9) + 1800000).toISOString(), busy: true, allDay: false, meetingId: '1',
            where: 'Office', meet: 'https://meet.google.com/abc',
            about: ['Client: Mr Kumar · 98400 12345',
                    'Seller: Mr Rajan · 98400 99887', '',
                    'Notes from the office:', 'Gate code 4412.'].join(String.fromCharCode(10)),
            attendees: [{ email: 'thirumal@threepin.in', status: 'accepted' },
                        { email: 'swami@threepin.in', status: 'accepted' }] },
          { id: 'm3', title: 'Owner call with VGN', start: new Date(atHour(16)).toISOString(),
            end: new Date(atHour(16) + 1800000).toISOString(), busy: true, allDay: false, meetingId: '1',
            attendees: [{ email: 'thirumal@threepin.in', status: 'needsAction' },
                        { email: 'pradeep@threepin.in', status: 'accepted' }] },
          // Not answered, and not today — this is what the bell must surface.
          { id: 'm2', title: 'Budget review', start: new Date(atHour(9) + 3 * 86400000).toISOString(),
            end: new Date(atHour(9) + 3 * 86400000 + 1800000).toISOString(), busy: true, allDay: false, meetingId: '1',
            attendees: [{ email: 'thirumal@threepin.in', status: 'needsAction' }] },
          // A site visit is NOT a meeting: it already has its own row, built
          // from the lead, which carries the client and the seller.
          { id: 'v1', title: 'Site visit: Radhi', start: new Date(atHour(14)).toISOString(),
            end: new Date(atHour(14) + 3600000).toISOString(), busy: true, allDay: false, leadId: 'L1',
            attendees: [{ email: 'thirumal@threepin.in', status: 'accepted' }] }
        ] } ] }) });
      return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    }
    if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    const f = join(ROOT, decodeURIComponent(u.pathname));
    if (!existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
  });
  await page.goto('http://crm.local/crm.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  // The inventory is what turns a code into a name, and it loads lazily.
  await page.evaluate(() => loadInventory());
  await page.evaluate(() => toggleView('today'));
  await page.waitForTimeout(1200);

  const day = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.td-row')];
    const visit = t => rows.find(r => r.textContent.includes(t));
    const read = r => r ? r.textContent.replace(/\s+/g, ' ').trim() : '';
    return {
      count: rows.length,
      radhi: read(visit('Radhi')), vignesh: read(visit('Vignesh')),
      kirthika: read(visit('Kirthika')), arun: read(visit('Arun')),
      titles: [...document.querySelectorAll('.td-prop')].map(e => e.textContent),
      agents: [...document.querySelectorAll('.td-agent')].map(e => e.className.replace('td-agent', '').trim() + ':' + e.textContent),
      unassigned: document.querySelectorAll('.td-unassigned').length,
      // The line reads action, then code, then name. If the name is set larger
      // than the line it sits in, it stops being part of a sentence and starts
      // being a headline with a caption stuck to it.
      sizes: (() => {
        const w = document.querySelector('.td-what');
        const t = w && w.querySelector('.td-prop');
        const c = w && w.querySelector('b');
        const px = e => e ? Math.round(parseFloat(getComputedStyle(e).fontSize)) : null;
        return { what: px(w), code: px(c), title: px(t) };
      })(),
      overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth)
    };
  });

  // Which property. "TNAG0002" does not tell you which of today's two to leave for first.
  ok('a visit names the property, not only its code',
    /2BHK Apartment for Sale in T\. Nagar/.test(day.radhi), day.radhi.slice(0, 90));
  ok('...keeping the code, which is what an agent quotes', /TNAG0002/.test(day.radhi));
  ok('...for every visit that has one', day.titles.length >= 3, String(day.titles.length));

  // Who is going.
  ok('it says who is going', /Swami/.test(day.radhi), day.radhi.slice(0, 120));
  ok('...and two agents both show', /Pradeep/.test(day.vignesh) && /Rajesh/.test(day.vignesh), day.vignesh.slice(0, 140));

  // And whether it is actually settled.
  ok('an accepted visit reads as accepted', day.agents.some(a => /^accepted:Swami.*accepted/.test(a)), JSON.stringify(day.agents));
  ok('...one nobody has answered reads as not accepted yet',
    day.agents.some(a => /^needsAction:Pradeep/.test(a)), JSON.stringify(day.agents));
  ok('...and a refusal reads as one', day.agents.some(a => /^declined:Rajesh/.test(a)), JSON.stringify(day.agents));
  // The one to sort out before the morning goes.
  ok('a visit with nobody on it says so', day.unassigned === 1 && /nobody assigned yet/.test(day.kirthika), day.kirthika.slice(0, 90));

  // A phone job is not a journey, and the day should not send somebody driving.
  ok('a phone-only visit is not called a site visit', /Coordinate by phone/.test(day.arun), day.arun.slice(0, 90));

  ok('the property name sits in the line, not over it',
    day.sizes.title !== null && day.sizes.title <= day.sizes.what, JSON.stringify(day.sizes));
  // ── WHICH OF THESE ARE MINE ──
  // The day is everybody's work. The rows that are yours have to be findable
  // without reading every line.
  const mine = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.td-row')];
    const read = r => r ? r.textContent.replace(/\s+/g, ' ').trim() : '';
    const find = t => rows.find(r => r.textContent.includes(t));
    return {
      radhi: { marked: !!(find('Radhi') && find('Radhi').classList.contains('is-mine')), text: read(find('Radhi')) },
      // Not on this one, so it must NOT be marked — a badge on everything is
      // a badge on nothing.
      vignesh: !!(find('Vignesh') && find('Vignesh').classList.contains('is-mine')),
      // Accepted already, so nothing is waiting on them: it must NOT be marked.
      meetingDone: !!(find('Monday pipeline') && find('Monday pipeline').classList.contains('is-mine')),
      meeting: { marked: !!(find('Owner call') && find('Owner call').classList.contains('is-mine')),
        text: read(find('Owner call')) },
      icons: document.querySelectorAll('.td-mine').length,
      marks: [...document.querySelectorAll('.td-mine')].map(e => Math.round(e.getBoundingClientRect().left)),
      sameColumn: (() => {
        const xs = [...document.querySelectorAll('.td-mine')].map(e => Math.round(e.getBoundingClientRect().left));
        return xs.length > 1 ? xs.every(x => x === xs[0]) : xs.length === 1;
      })(),
      sections: [...document.querySelectorAll('.td-sec-mine')].map(e => e.textContent.trim()),
      sectionCount: document.querySelectorAll('.td-sec-mine').length > 0
    };
  });
  ok('a visit you are on is marked as yours', mine.radhi.marked, mine.radhi.text.slice(0, 100));
  // A mark, not a label: it has to sit in the SAME place on every row, or
  // finding your own work means reading every line rather than scanning one
  // column. The x position of the mark is the thing being asserted.
  ok('...with a person icon, not a worded tag', mine.icons >= 1 && !/You have not answered/.test(mine.radhi.text),
    mine.radhi.text.slice(0, 110));
  ok('...in the same place on every row that has one', mine.sameColumn, JSON.stringify(mine.marks));
  ok('...and a count beside the section heading', mine.sectionCount, JSON.stringify(mine.sections));
  // The mark carries the words in its title; the row still spells it out in
  // the agent chips, so nothing is known only by hovering.
  ok('...and the row still says it in words as well',
    /not accepted yet/i.test(mine.radhi.text), mine.radhi.text.slice(0, 140));
  ok('a visit you are NOT on is left unmarked', !mine.vignesh);
  ok('a meeting waiting on your answer is marked too', mine.meeting.marked, mine.meeting.text.slice(0, 100));
  // Every meeting on this screen is already yours — it came out of your own
  // calendar — so a mark on all of them marks nothing. Only the ones still
  // waiting on an answer carry it.
  ok('...and one you have already accepted is not', !mine.meetingDone);
  ok('...so the section counts what is waiting, not what exists',
    mine.sections.includes('1'), JSON.stringify(mine.sections));

  // Expanded, a meeting has to carry what the person who called it wrote down.
  const opened = await page.evaluate(async () => {
    const row = [...document.querySelectorAll('.td-row')].find(r => r.textContent.includes('Monday pipeline'));
    row.open = true;
    await new Promise(r => setTimeout(r, 120));
    return { text: row.textContent.replace(/\s+/g, ' ').trim() };
  });
  ok('opening a meeting shows the client and the number', /Mr Kumar/.test(opened.text) && /98400 12345/.test(opened.text), opened.text.slice(-160));
  ok('...the seller too', /Mr Rajan/.test(opened.text));
  ok('...and the notes kept on it', /Gate code 4412/.test(opened.text));

  ok('the page does not scroll sideways', day.overflowX === 0, day.overflowX + 'px');

  // ── MEETINGS ARE PART OF THE DAY TOO ──
  const mtg = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('.td-sec, section')].map(s => s.textContent);
    const all = document.body.textContent;
    const rows = [...document.querySelectorAll('.td-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim());
    return { has: /Monday pipeline review/.test(all),
      row: rows.find(r => /Monday pipeline review/.test(r)) || '',
      // A site visit must not be listed twice: once from the lead, once from
      // the calendar copy of itself.
      visitOnce: rows.filter(r => /Radhi/.test(r)).length,
      summary: (document.querySelector('.td-sub') || {}).textContent || '' };
  });
  ok('a meeting shows in the day', mtg.has, mtg.row.slice(0, 90));
  ok('...saying where you stand on it', /you are coming/i.test(mtg.row), mtg.row.slice(0, 120));
  ok('...and who else is on it', /Swami/.test(mtg.row), mtg.row.slice(0, 140));
  ok('...counted in the summary line', /meeting/i.test(mtg.summary), mtg.summary);
  ok('a site visit is not listed twice', mtg.visitOnce === 1, String(mtg.visitOnce));

  // ── THE BELL, GROUPED ──
  const bell = await page.evaluate(async () => {
    toggleAlerts();
    await new Promise(r => setTimeout(r, 200));
    const menu = document.getElementById('bellMenu');
    return { groups: [...menu.querySelectorAll('.bell-head')].map(h => h.textContent),
      text: menu.textContent, count: (document.getElementById('bellCount') || {}).textContent };
  });
  ok('the bell groups what it shows', bell.groups.length >= 2, JSON.stringify(bell.groups));
  // The thing somebody else is waiting on comes first.
  ok('...invitations to answer first', /invitation/i.test(bell.groups[0] || ''), JSON.stringify(bell.groups));
  ok('...naming the one not answered', /Budget review/.test(bell.text));
  ok('...then what is on today', bell.groups.some(g => /on today/i.test(g)), JSON.stringify(bell.groups));
  ok('...then the leads', bell.groups.some(g => /lead/i.test(g)), JSON.stringify(bell.groups));
  await page.evaluate(() => closeAlerts());

  await page.screenshot({ path: join(ROOT, 'tests/out/today-' + viewport.width + '.png') });
  await ctx.close();
}
await browser.close();
console.log('');
console.log('─'.repeat(64));
if (errors.length) { console.log(errors.length + ' problem(s):'); errors.forEach(e => console.log('  · ' + e)); process.exit(1); }
console.log('All good.');
