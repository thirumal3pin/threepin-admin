// ═══════ THE LEAD PANEL, WITH A REAL INVENTORY BEHIND IT ═══════
//
//   node tests/crm-lead-panel-preview.mjs <out-dir>
//
// The other CRM previews stub the inventory with two properties, so the
// matching-properties section stays a few hundred pixels tall and everything
// below it looks fine. Against the live 131 it rendered 28 matches and 7,177
// pixels of panel, and the note box — which sits below it — ended up roughly
// eight thousand pixels down. The owner reported the Notes section as
// missing, which is a fair description of a control you cannot reach.
//
// So this one loads the REAL inventory, and checks the two things that broke:
// that an agent can log a note without hunting for the box, and that they can
// set a follow-up for later today rather than tomorrow at the earliest.

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPipelineMigration } from '../crm-assets/pipeline.js';

const OUT = process.argv[2] || 'tests/out/crm-lead-panel';
mkdirSync(OUT, { recursive: true });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.now(), D = 86400000;
const T = 't_3pinrealty';
const STAGES = planPipelineMigration([
  { id: 'new', name: 'New' }, { id: 'site_visit', name: 'Site Visit' }, { id: 'negotiation', name: 'in Negotiation' }
], []).stages;
const sid = k => STAGES.find(s => s.key === k).id;
const INV = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/properties-snapshot.json'), 'utf8'));

// A buyer with a brief open enough that the matcher returns plenty — which is
// the condition under which the panel used to bury everything after it.
const LEADS = [{
  id: 'B1', tenantId: T, name: 'Buyer With Options', phone: '9840012345', source: 'manual',
  stageId: sid('new'), propertyInterest: 'Anna Nagar 3 BHK', budget: '3 Cr',
  createdAt: NOW - 2 * D, updatedAt: NOW - D, reached: { new: NOW - 2 * D }
}];

const STUB = `
window.__saved = []; window.__notes = [];
window.crmFirebase = {
  saveLead: async l => { window.__saved.push(l); }, deleteLead: async () => {},
  getLeadNotes: async () => [], getLeadHistory: async () => [],
  saveNote: async (id, n) => { window.__notes.push({ id, n }); }, deleteNoteDoc: async () => {},
  saveHistory: async () => {}, savePipeline: async () => {},
  getBotConfig: async () => null, saveBotConfig: async () => {}, saveEnquiryTypes: async () => {},
  saveProperties: async () => {}, saveFollowupDigestSettings: async () => {}, saveDashboardEmailSettings: async () => {},
  releaseLeadField: async () => {}, getLeadTailorTalk: async () => null,
  updateLeadAi: async () => {}, saveAutomationSettings: async () => {},
  saveView: async () => {}, deleteView: async () => {},
  getInventory: async () => (${JSON.stringify(INV)})
};
// The team who can be sent on a visit — settings/{tenant}.team, the same list
// that backs @mentions.
window.applyTeamSnapshot({
  swami: { email: 'swami@threepin.in' },
  pradeep: { email: 'pradeep@threepin.in' },
  sales: { email: 'sales@threepin.in' }
});
window.crmAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => '${T}' };
window.onCrmAuthChange({ email: 'agent.a@example.com' });
window.applyPipelineSnapshot(${JSON.stringify(STAGES)});
window.applyEnquiryTypesSnapshot(['Property Enquiry','Seller Listing','General']);
window.applyAutomationSettingsSnapshot({ enabled: true });
if (window.applyViewsSnapshot) window.applyViewsSnapshot({});
window.applyLeadsSnapshot(${JSON.stringify(LEADS)});
window.__ready = true;
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.json': 'application/json' };
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};

const calendarCalls = [];
const browser = await chromium.launch();
async function open(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${viewport.width}px pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource|net::ERR/.test(m.text())) return;
    errors.push(`${viewport.width}px console: ${m.text()}`);
  });
  page.on('dialog', d => d.accept());
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'crm.local') return route.abort();
    if (u.pathname === '/crm-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
    if (u.searchParams.get('action') === 'calendar') {
      const b = JSON.parse(route.request().postData() || '{}');
      if (b.op === 'day') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, people: [
        { person: 'swami@threepin.in', events: [{ id: 'x', title: 'Bank call', busy: true, allDay: false,
          start: new Date(Date.now() + 3 * 86400000).setHours(10, 30, 0, 0) && new Date(new Date(Date.now() + 3 * 86400000).setHours(10, 30, 0, 0)).toISOString(),
          end: new Date(new Date(Date.now() + 3 * 86400000).setHours(12, 0, 0, 0)).toISOString() }] },
        { person: 'pradeep@threepin.in', events: [] },
        { person: 'sales@threepin.in', events: [] }
      ] }) });
      if (b.op === 'visit') { calendarCalls.push(b); return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, eventId: 'ev1', owner: 'sales@threepin.in', agents: b.agents || [] }) }); }
      return route.fulfill({ contentType: 'application/json', body: '{"ok":true,"replies":[]}' });
    }
    if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    const f = join(ROOT, decodeURIComponent(u.pathname));
    if (!existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
  });
  await page.goto('http://crm.local/crm.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  return page;
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  console.log('');
  console.log(viewport.width === 390 ? 'On a phone' : 'On a laptop');
  const page = await open(viewport);
  await page.evaluate(() => openDetail('B1'));
  await page.waitForTimeout(2500);

  const m = await page.evaluate(() => {
    const note = document.querySelector('#noteInput');
    const match = document.querySelector('#dpMatchSec');
    let sc = note, scroller = null;
    while (sc && sc !== document.body) {
      const cs = getComputedStyle(sc);
      if (/auto|scroll/.test(cs.overflowY) && sc.scrollHeight > sc.clientHeight + 2) { scroller = sc; break; }
      sc = sc.parentElement;
    }
    const r = note ? note.getBoundingClientRect() : null;
    return {
      exists: !!note,
      visible: !!(note && getComputedStyle(note).display !== 'none' && r.height > 0),
      offset: (scroller && note) ? Math.round(r.top - scroller.getBoundingClientRect().top + scroller.scrollTop) : (r ? Math.round(r.top) : null),
      rows: document.querySelectorAll('#dpMatch .pm-row, #dpMatch .pm-item').length,
      matchH: match ? Math.round(match.getBoundingClientRect().height) : 0,
      hasMore: !!document.querySelector('#dpMatch .pm-more')
    };
  });

  ok('the note box is on the page', m.exists && m.visible);
  // The whole complaint, as a number: it must be reachable without a trek.
  ok('...and reachable without scrolling past the matches', m.offset != null && m.offset < 700,
    m.offset + 'px down the panel');
  ok('the matching section shows a shortlist, not the whole ranking', m.rows > 0 && m.rows <= 5,
    m.rows + ' rows, ' + m.matchH + 'px tall');
  ok('...with the rest one click away', m.hasMore);
  ok('the matching section is not taller than a few screens', m.matchH < 2200, m.matchH + 'px');

  // ── LATER TODAY ──
  // Every preset set a date and left the time empty, and a bare date of today
  // is rejected as "must be a future date" — so the soonest follow-up the
  // buttons could offer was tomorrow.
  const fu = await page.evaluate(() => {
    setNoteFuHours(3);
    const d = document.getElementById('noteFollowUpDate').value;
    const t = document.getElementById('noteFollowUpTime').value;
    const x = new Date();
    const today = x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
    const r = computeFollowUpAt(d, t);
    return { isToday: d === today, hasTime: !!t, accepted: !r.error, error: r.error || null,
      hoursAhead: r.value ? Math.round((r.value - Date.now()) / 360000) / 10 : null };
  });
  ok('a "+3 hours" follow-up lands today', fu.isToday, JSON.stringify(fu));
  ok('...and carries a time, which is what makes today legal', fu.hasTime);
  ok('...and is accepted rather than refused as "must be a future date"', fu.accepted, fu.error);
  ok('...roughly three hours out', fu.hoursAhead >= 2.8 && fu.hoursAhead <= 3.2, fu.hoursAhead + 'h');

  const saved = await page.evaluate(async () => {
    document.getElementById('noteInput').value = 'Called - ringing back after lunch';
    await addNote();
    const l = window.__saved[window.__saved.length - 1];
    return { notes: window.__notes.length, at: l ? l.followUpAt : null,
      future: l && l.followUpAt ? l.followUpAt > Date.now() : false,
      sameDay: l && l.followUpAt ? new Date(l.followUpAt).toDateString() === new Date().toDateString() : false };
  });
  ok('the note saves', saved.notes === 1);
  ok('...with the follow-up set for later the same day', saved.future && saved.sameDay, JSON.stringify(saved));

  // ── SCHEDULING A SITE VISIT ──
  //
  // The viewing used to live inside the AI's verdict: no person could edit it,
  // and every AI run rewrote it. On the live board that left 76 leads carrying
  // a visit, 22 with a day that had already passed and was still open, and not
  // one visit anywhere in the future. A date nobody can move is a date that
  // rots where the AI last left it.
  //
  // It is now a booking: when, who goes, which property, what the office wants
  // them to know — and a real invitation the agents answer.
  const row = await page.evaluate(() => {
    const r = document.querySelector('.st-row.sv');
    return { there: !!r, btn: r ? (r.querySelector('button') || {}).textContent : null };
  });
  ok('the lead has a site-visit row of its own', row.there);
  ok('...offering to schedule one', /Schedule/.test(row.btn || ''), row.btn);

  await page.click('.st-row.sv button');
  await page.waitForTimeout(600);
  const form = await page.evaluate(() => {
    const ids = ['svDate', 'svTime', 'svMins', 'svAgents', 'svProp', 'svNotes', 'svStatus'];
    const box = document.querySelector('.sv-sheet');
    const b = box ? box.getBoundingClientRect() : null;
    return { missing: ids.filter(i => !document.getElementById(i)),
      agents: document.querySelectorAll('#svAgents input').length,
      properties: document.querySelectorAll('#svProp option').length,
      fits: b ? b.right <= innerWidth + 2 && b.width > 200 : false,
      freeTextOption: [...document.querySelectorAll('#svProp option')].some(o => o.value === '__free') };
  });
  ok('...which opens one form with everything on it', form.missing.length === 0, form.missing.join(','));
  ok('...listing the team to send', form.agents >= 3, String(form.agents));
  ok('...the inventory to pick a property from', form.properties > 50, String(form.properties));
  ok('...and a way to name one that is not in it', form.freeTextOption);
  ok('...fitting the screen', form.fits, JSON.stringify(form));

  // The question that decides the time, answered without leaving the lead.
  const avail = await page.evaluate(async () => {
    const d = new Date(Date.now() + 3 * 86400000);
    const pad = n => String(n).padStart(2, '0');
    document.getElementById('svDate').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    document.getElementById('svTime').value = '11:00';
    loadVisitAvailability();
    await new Promise(r => setTimeout(r, 500));
    const mark = e => (document.querySelector(`.sv-agent-free[data-for="${e}"]`) || {}).textContent || '';
    return { swami: mark('swami@threepin.in'), pradeep: mark('pradeep@threepin.in'),
      note: (document.getElementById('svAvailNote') || {}).textContent || '' };
  });
  ok('the agents\u2019 calendars are shown while you pick the time',
    /busy/i.test(avail.swami) && /free/i.test(avail.pradeep), JSON.stringify(avail));

  // Picking somebody who is busy is allowed — the office may know the other
  // thing can move — but it is said out loud first.
  const clash = await page.evaluate(async () => {
    [...document.querySelectorAll('#svAgents input')].forEach(i => { i.checked = i.value === 'swami@threepin.in'; });
    renderVisitAvailability();
    await new Promise(r => setTimeout(r, 100));
    return (document.getElementById('svAvailNote') || {}).textContent || '';
  });
  ok('...and a clash is said plainly before the invitation goes out', /busy then/i.test(clash), clash);

  // A scheduled visit with nobody on it tells nobody anything.
  const nobody = await page.evaluate(async () => {
    [...document.querySelectorAll('#svAgents input')].forEach(i => { i.checked = false; });
    document.getElementById('svStatus').value = 'scheduled';
    saveVisitEdit('B1');
    const e = document.getElementById('svErr');
    return { shown: !!(e && e.classList.contains('show')), text: e ? e.textContent : '' };
  });
  ok('a scheduled visit with nobody going is refused, and says why', nobody.shown && nobody.text.length > 20, nobody.text);

  calendarCalls.length = 0;
  const booked = await page.evaluate(async () => {
    [...document.querySelectorAll('#svAgents input')].forEach(i => {
      i.checked = i.value === 'swami@threepin.in' || i.value === 'pradeep@threepin.in';
    });
    const sel = document.getElementById('svProp');
    sel.selectedIndex = 1;
    document.getElementById('svNotes').value = 'Gate code 4412. Client asked about the car park.';
    document.getElementById('svMins').value = '90';
    document.getElementById('svStatus').value = 'scheduled';
    saveVisitEdit('B1');
    await new Promise(r => setTimeout(r, 500));
    const l = leads.find(x => x.id === 'B1');
    return { at: l.siteVisitAt, agents: l.siteVisitAgents, notes: l.siteVisitNotes, minutes: l.siteVisitMinutes,
      property: l.siteVisitProperty, replies: l.siteVisitReplies,
      closed: !document.querySelector('#svSheet'),
      shown: (document.querySelector('.st-row.sv .sv-val') || {}).textContent || '',
      followUpAt: l.followUpAt || null };
  });
  ok('two agents can be sent on one visit', (booked.agents || []).length === 2, JSON.stringify(booked.agents));
  ok('...with the office\u2019s notes attached', /4412/.test(booked.notes || ''), booked.notes);
  ok('...for as long as it needs', booked.minutes === 90, String(booked.minutes));
  ok('...against a property from the inventory', !!booked.property, booked.property);
  ok('...and nobody has answered yet', (booked.replies || []).every(r => r.status === 'needsAction'), JSON.stringify(booked.replies));
  ok('the invitation is actually sent', calendarCalls.some(c => c.op === 'visit'), JSON.stringify(calendarCalls));
  ok('...carrying the seller\u2019s number and the address for the gate',
    !!(calendarCalls[0] && calendarCalls[0].property && calendarCalls[0].property.contactNumber), JSON.stringify(calendarCalls[0] && calendarCalls[0].property));
  ok('...and the form closes', booked.closed);
  ok('the visit date is still not the follow-up date', booked.followUpAt !== booked.at,
    `visit ${booked.at} vs call ${booked.followUpAt}`);

  // What the office needs to see when somebody turns it down.
  const declined = await page.evaluate(() => {
    const l = leads.find(x => x.id === 'B1');
    l.siteVisitReplies = [{ email: 'swami@threepin.in', status: 'accepted' },
                          { email: 'pradeep@threepin.in', status: 'declined' }];
    // Exactly what refreshVisitReplies() does when an answer comes back from
    // Google between snapshots: without this the page keeps the reasons the
    // lead had before anybody replied.
    forgetAttention('B1');
    renderStandSection(l);
    const chips = [...document.querySelectorAll('.sv-who')].map(c => c.className + ':' + c.textContent);
    const attn = [...document.querySelectorAll('.st-item-t')].map(x => x.textContent);
    return { chips, attn };
  });
  ok('who accepted and who refused is on the lead',
    declined.chips.some(c => /accepted/.test(c)) && declined.chips.some(c => /declined/.test(c)), JSON.stringify(declined.chips));
  // Google tells nobody in the office. This is the message.
  ok('...and a refusal is raised for somebody to act on',
    declined.attn.some(t => /cannot make the site visit/i.test(t)), JSON.stringify(declined.attn));

  await page.screenshot({ path: join(OUT, (viewport.width === 390 ? 'phone' : 'laptop') + '.png') });
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
