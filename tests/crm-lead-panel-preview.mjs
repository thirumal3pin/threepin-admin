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

  // ── THE SITE VISIT, WHICH IS NOT THE FOLLOW-UP ──
  //
  // The viewing used to live inside the AI's verdict: no person could edit it,
  // and every AI run rewrote it. On the live board that left 76 leads carrying a
  // visit, 22 of them with a day that had already passed and was still open, and
  // not one visit anywhere in the future. A date nobody can move is a date that
  // rots where the AI last left it.
  const row = await page.evaluate(() => {
    const r = document.querySelector('.st-row.sv');
    return { there: !!r, text: r ? r.textContent.replace(/\s+/g, ' ').trim() : '',
      btn: r ? (r.querySelector('button') || {}).textContent : null };
  });
  ok('the lead has a site-visit row of its own', row.there, row.text);
  ok('...offering a way to set one when there is none', /Set a date/.test(row.btn || ''), row.btn);

  await page.click('.st-row.sv button');
  await page.waitForTimeout(250);
  const editor = await page.evaluate(() => {
    const ids = ['svDate', 'svTime', 'svStatus', 'svProp'];
    const missing = ids.filter(i => !document.getElementById(i));
    const box = document.querySelector('.st-row.sv .sv-edit');
    const b = box ? box.getBoundingClientRect() : null;
    return { missing, fits: b ? b.right <= innerWidth + 2 : false,
      taps: ids.map(i => { const e = document.getElementById(i); return e ? Math.round(e.getBoundingClientRect().height) : 0; }) };
  });
  ok('...which opens a date, a time, where it stands and the property', editor.missing.length === 0, editor.missing.join(','));
  ok('...without spilling off the side', editor.fits);
  ok('...with controls big enough to tap', Math.min(...editor.taps) >= 32, editor.taps.join(','));

  // A day with no time is refused for a fixed visit, because a viewing nobody
  // has a time for is a viewing nobody turns up to.
  const refused = await page.evaluate(() => {
    document.getElementById('svStatus').value = 'scheduled';
    document.getElementById('svDate').value = '';
    saveVisitEdit('B1');
    const e = document.getElementById('svErr');
    return { shown: !!(e && e.classList.contains('show')), saved: !!(leads.find(x => x.id === 'B1').siteVisitAt) };
  });
  ok('a fixed visit with no day is refused, and says why', refused.shown && !refused.saved, JSON.stringify(refused));

  const fixed = await page.evaluate(() => {
    const d = new Date(Date.now() + 3 * 86400000);
    const pad = n => String(n).padStart(2, '0');
    document.getElementById('svDate').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    document.getElementById('svTime').value = '11:00';
    document.getElementById('svStatus').value = 'scheduled';
    document.getElementById('svProp').value = 'TNAG0001';
    saveVisitEdit('B1');
    const l = leads.find(x => x.id === 'B1');
    const w = window.__saved[window.__saved.length - 1];
    return { at: l.siteVisitAt, status: l.siteVisitStatus, prop: l.siteVisitProperty, by: l.siteVisitBy,
      persisted: !!(w && w.siteVisitAt), followUpAt: l.followUpAt || null,
      shown: (document.querySelector('.st-row.sv .sv-val') || {}).textContent || '' };
  });
  ok('an agent can fix the visit date by hand', !!fixed.at && fixed.status === 'scheduled', JSON.stringify(fixed));
  ok('...recorded as theirs, so the AI leaves it alone', /@/.test(fixed.by || ''), fixed.by);
  ok('...and it reaches the database', fixed.persisted);
  ok('...shown on the row afterwards', /TNAG0001/.test(fixed.shown), fixed.shown);
  // The whole point of the field: it is a different date from the follow-up.
  ok('...and it did NOT become the follow-up date', fixed.followUpAt !== fixed.at,
    `visit ${fixed.at} vs call ${fixed.followUpAt}`);

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
