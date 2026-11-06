// ═══════ WHATSAPP CAMPAIGNS, CLICKED THROUGH ═══════
//
//   node tests/campaign-preview.mjs
//
// The real CRM page with the Campaigns screen, wired to the REAL server code (api/_campaign.js)
// over the in-memory Firestore — only TailorTalk's API and the AI are stand-ins, so no message
// leaves this machine. Laptop and phone, light and dark. Every path a person takes: the dashboard's
// suggested messages (the stage journeys, crm-assets/journeys.js, with the real match engine),
// replies waiting, templates by hand / starter / AI / "Create it", the four-step campaign with
// quick lists, filters (several stages, agent, lost reason, on hold, ad), saved lists, AI picks,
// ticks, contacts typed in, the cost estimate, a test, the CSV, a real send and its delivery,
// quiet hours ("Send anyway" / "Cancel"), a campaign's replies and what it led to, settings.
// Screenshots land in tests/out/campaign-*.png. Quiet hours run on the server's own clock: the
// test sets that clock (deps.now) to daytime for ordinary sends and to 11 PM IST to test them.

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPipelineMigration } from '../crm-assets/pipeline.js';
import { campaignAction, makeDeps } from '../api/_campaign.js';
import { createFakeDb } from './_fake-firestore.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'tests/out');
mkdirSync(OUT, { recursive: true });
const T = 't_3pinrealty';
const STAGES = planPipelineMigration([{ id: 'new', name: 'New' }, { id: 'site_visit', name: 'Site Visit' }], []).stages;
const sid = k => STAGES.find(s => s.key === k).id;
const NOW = Date.now();
const DAY = 86400000;
const at = (days, h = 11) => { const d = new Date(NOW + days * DAY); d.setHours(h, 0, 0, 0); return d.getTime(); };

// A listing added three days ago — "new" for the journeys — that suits Ravi and Lakshmi.
const NEWP = { id: 'p' + (NOW - 3 * DAY), propertyCode: 'MADA0002', name: 'Radiance Phase 2', location: 'Madhavaram', config: '3 BHK', type: 'Apartment', startingPrice: '₹88 L', createdAt: NOW - 3 * DAY };
const INV = [
  NEWP,
  { id: 'ANR003', propertyCode: 'ANR003', name: 'Sunrise Residency 3 BHK', location: 'Anna Nagar', config: '3 BHK', startingPrice: '₹3.25 Cr', soldOut: true, brochureLink: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view' },
  { id: 'MADA0001', propertyCode: 'MADA0001', name: 'Radiance Solitaire', location: 'Madhavaram', config: '2, 3 & 4 BHK', startingPrice: '₹85 L' },
  { id: 'VLCA002', propertyCode: 'VLCA002', name: 'Velachery Villa', location: 'Velachery', config: '4 BHK', startingPrice: '₹2.1 Cr' }
];
const tt = (status, contact, lastDays = 2) => ({ id: 'tt_' + contact, status, contact, lastMessageAt: NOW - lastDays * DAY });
const LEADS = [
  // Visited this week — feedback.
  { id: 'L1', tenantId: T, name: '~ Ravi Kumar 🙂', phone: '9840011111', stageId: sid('visit_done') || sid('visit_pending'), tt: tt('hot', '919840011111'),
    propertyCodes: ['MADA0001'], siteVisitAt: at(-1), siteVisitStatus: 'done', siteVisitProperty: 'MADA0001', createdAt: NOW - 20 * DAY, updatedAt: NOW - DAY, budget: '90 L', enquiryType: 'Property Enquiry', propertyInterest: '3 BHK Madhavaram' },
  { id: 'L2', tenantId: T, name: 'Anitha', phone: '9840022222', stageId: sid('visit_pending'), tt: tt('warm', '919840022222'),
    propertyCodes: ['ANR003'], siteVisitAt: at(-3), siteVisitStatus: 'done', siteVisitProperty: 'ANR003', createdAt: NOW - 30 * DAY, updatedAt: NOW - 2 * DAY, budget: '3 Cr', propertyInterest: '3BHK Anna Nagar', ai: { line: 'Visited ANR003; felt the price was too high', intent: 'buy' } },
  // Visited, but no property known — {{property_code}} missing until filled in.
  { id: 'L3', tenantId: T, name: 'Prakash', phone: '9840033333', stageId: sid('visit_pending'), tt: tt('warm', '919840033333'),
    siteVisitAt: at(-1), siteVisitStatus: 'done', createdAt: NOW - 9 * DAY, updatedAt: NOW - DAY },
  // Visit tomorrow.
  { id: 'L4', tenantId: T, name: 'Meena', phone: '9840044444', stageId: sid('visit_pending'), tt: tt('hot', '919840044444'),
    propertyCodes: ['VLCA002'], siteVisitAt: at(1, 16), siteVisitStatus: 'scheduled', siteVisitProperty: 'VLCA002', createdAt: NOW - 5 * DAY, updatedAt: NOW - DAY },
  // Interested in the sold-out ANR003.
  { id: 'L5', tenantId: T, name: 'Suresh', phone: '9840055555', stageId: sid('new'), tt: tt('warm', '919840055555', 20), propertyCodes: ['ANR003'], createdAt: NOW - 40 * DAY, updatedAt: NOW - 20 * DAY, budget: '3.2 Cr' },
  { id: 'L6', tenantId: T, name: 'Opted Out Person', phone: '9840066666', stageId: sid('new'), tt: tt('cold', '919840066666'), propertyCodes: ['ANR003'], createdAt: NOW - 40 * DAY, updatedAt: NOW - 10 * DAY },
  // Instagram — no number.
  { id: 'L7', tenantId: T, name: 'insta_user', stageId: sid('new'), tt: tt('warm', 'insta_user'), propertyCodes: ['ANR003'], createdAt: NOW - 8 * DAY, updatedAt: NOW - 8 * DAY },
  // Dead in TailorTalk.
  { id: 'L8', tenantId: T, name: 'Gone Cold', phone: '9840088888', stageId: sid('new'), tt: tt('dead', '919840088888', 60), propertyCodes: ['VLCA002'], createdAt: NOW - 90 * DAY, updatedAt: NOW - 60 * DAY },
  // Same number as L1.
  { id: 'L9', tenantId: T, name: 'Ravi (duplicate)', phone: '+91 98400 11111', stageId: sid('new'), createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY, propertyCodes: ['MADA0001'], siteVisitAt: at(-1), siteVisitStatus: 'done', siteVisitProperty: 'MADA0001' },
  // Messaged by a Marketing campaign 2 days ago.
  { id: 'L10', tenantId: T, name: 'Recently Messaged', phone: '9840010101', stageId: sid('new'), tt: tt('hot', '919840010101', 30), createdAt: NOW - 60 * DAY, updatedAt: NOW - 30 * DAY, lastCampaignAt: NOW - 2 * DAY, propertyCodes: ['VLCA002'] },
  // ── The stage journeys ──
  // Asked for feedback 4 days ago (the seeded campaign below), never answered: a nudge.
  { id: 'L11', tenantId: T, name: 'Nadia Nudge', phone: '9840011011', stageId: sid('visit_done'), tt: tt('warm', '919840011011', 10), propertyCodes: ['MADA0001'],
    siteVisitAt: at(-9), siteVisitStatus: 'done', siteVisitProperty: 'MADA0001', lastCampaignAt: NOW - 4 * DAY, createdAt: NOW - 20 * DAY, updatedAt: NOW - 8 * DAY },
  // Answered it "call me", and has since booked a visit — a reply waiting, and a result.
  { id: 'L12', tenantId: T, name: 'Rita Reply', phone: '9840012012', stageId: sid('visit_pending'), stageChangedAt: NOW - 2 * DAY, reached: { new: NOW - 30 * DAY, visit_pending: NOW - 2 * DAY },
    tt: tt('hot', '919840012012', 3), propertyCodes: ['MADA0001'], siteVisitAt: at(3), siteVisitStatus: 'scheduled', siteVisitSetAt: NOW - 2 * DAY, siteVisitProperty: 'MADA0001',
    lastCampaignAt: NOW - 4 * DAY, createdAt: NOW - 30 * DAY, updatedAt: NOW - 5 * DAY,
    campaignReply: { campaignId: 'seed_fb', campaignName: 'Feedback — last week', template: 'post_visit_feedback', text: 'Can you call me tomorrow?', action: 'call', at: NOW - 3 * DAY } },
  // Answered STOP: out of everything, though the number is not on the settings' list.
  { id: 'L13', tenantId: T, name: 'Omar Optout', phone: '9840013013', stageId: sid('new'), tt: tt('cold', '919840013013', 3), propertyCodes: ['ANR003'], waOptOut: true, waOptOutAt: NOW - 3 * DAY, waOptOutReason: 'replied stop',
    lastCampaignAt: NOW - 4 * DAY, createdAt: NOW - 30 * DAY, updatedAt: NOW - 6 * DAY,
    campaignReply: { campaignId: 'seed_fb', campaignName: 'Feedback — last week', template: 'post_visit_feedback', text: 'STOP', action: 'optout', at: NOW - 3 * DAY } },
  // Options sent 5 days ago, quiet since.
  { id: 'L14', tenantId: T, name: 'Olivia Options', phone: '9840014014', stageId: sid('options'), stageChangedAt: NOW - 5 * DAY, tt: { ...tt('warm', '919840014014', 6), adTitle: 'Anna Nagar 3BHK reel' },
    assignedAgent: 'swami@threepin.in', createdAt: NOW - 12 * DAY, updatedAt: NOW - 5 * DAY },
  // On hold until yesterday.
  { id: 'L15', tenantId: T, name: 'Harish Hold', phone: '9840015015', stageId: sid('on_hold'), holdUntil: NOW - DAY, holdReason: 'postponed', tt: tt('cold', '919840015015', 40), createdAt: NOW - 60 * DAY, updatedAt: NOW - 20 * DAY },
  // Lost over budget; the new Madhavaram listing fits.
  { id: 'L16', tenantId: T, name: 'Lakshmi Lost', phone: '9840016016', stageId: sid('lost'), lostReason: 'budget', budget: '90 L', propertyInterest: '3 BHK Madhavaram', enquiryType: 'Property Enquiry',
    ai: { intent: 'buy' }, tt: tt('cold', '919840016016', 30), createdAt: NOW - 50 * DAY, updatedAt: NOW - 25 * DAY },
  // Won ten days ago — time to ask for a review or a referral.
  { id: 'L17', tenantId: T, name: 'Wasim Won', phone: '9840017017', stageId: sid('won'), stageChangedAt: NOW - 10 * DAY, reached: { won: NOW - 10 * DAY }, tt: tt('converted', '919840017017', 11), createdAt: NOW - 80 * DAY, updatedAt: NOW - 10 * DAY },
  // Negotiating: never a Marketing message.
  { id: 'L18', tenantId: T, name: 'Nikhil Negotiating', phone: '9840018018', stageId: sid('negotiation'), stageChangedAt: NOW - 3 * DAY, propertyCodes: ['VLCA002'], tt: tt('hot', '919840018018', 1), createdAt: NOW - 25 * DAY, updatedAt: NOW - 3 * DAY }
];
// Agents and the ad that brought them, for the filters.
Object.assign(LEADS[0], { assignedAgent: 'swami@threepin.in' });
Object.assign(LEADS[1], { assignedAgent: 'pradeep@threepin.in' });
LEADS[4].tt.adTitle = 'Anna Nagar 3BHK reel';

// A feedback campaign sent four days ago: Nadia read it and said nothing, Rita asked for a call,
// Omar said STOP. Written straight into the in-memory Firestore, as the server would have.
const SEED_FB = {
  tenantId: T, name: 'Feedback — last week', template: 'post_visit_feedback', vars: ['name', 'property_name', 'property_code'], category: 'UTILITY', mode: 'send',
  purpose: 'visit_feedback', mapping: {}, propertyMode: 'own', propertyId: null, headerMediaUrl: null, lockLead: false, audience: 'Visited in the last 7 days',
  createdAt: NOW - 4 * DAY, createdBy: 'admin@threepin.in', statusCheckedAt: NOW - 60000,
  recipients: {
    L11: { contact: '919840011011', name: 'Nadia Nudge', values: { name: 'Nadia', property_name: 'Radiance Solitaire', property_code: 'MADA0001' }, status: 'read', manual: false, sentAt: NOW - 4 * DAY },
    L12: { contact: '919840012012', name: 'Rita Reply', values: { name: 'Rita', property_name: 'Radiance Solitaire', property_code: 'MADA0001' }, status: 'replied', manual: false, sentAt: NOW - 4 * DAY,
      reply: { text: 'Can you call me tomorrow?', action: 'call', at: NOW - 3 * DAY } },
    L13: { contact: '919840013013', name: 'Omar Optout', values: { name: 'Omar', property_name: 'Sunrise Residency 3 BHK', property_code: 'ANR003' }, status: 'replied', manual: false, sentAt: NOW - 4 * DAY,
      reply: { text: 'STOP', action: 'optout', at: NOW - 3 * DAY } }
  },
  counts: { total: 3, ready: 0, sending: 0, sent: 3, delivered: 3, read: 3, replied: 2, failed: 0, cancelled: 0, exported: 0 }
};

const stubFor = leads => `
window.crmFirebase = {
  saveLead: async () => {}, deleteLead: async () => {}, getLeadNotes: async () => [], getLeadHistory: async () => [],
  saveNote: async () => {}, deleteNoteDoc: async () => {}, saveHistory: async () => {}, savePipeline: async () => {},
  getBotConfig: async () => null, saveBotConfig: async () => {}, saveEnquiryTypes: async () => {},
  saveProperties: async () => {}, saveFollowupDigestSettings: async () => {}, saveDashboardEmailSettings: async () => {},
  releaseLeadField: async () => {}, getLeadTailorTalk: async () => null, updateLeadAi: async () => {},
  saveAutomationSettings: async () => {}, saveView: async () => {}, deleteView: async () => {},
  getInventory: async () => (${JSON.stringify(INV)})
};
window.crmTodayOpens = { load: async () => ({}), save: async () => {} };
window.crmAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => '${T}' };
window.onCrmAuthChange({ email: 'admin@threepin.in' });
window.applyPipelineSnapshot(${JSON.stringify(STAGES)});
window.applyEnquiryTypesSnapshot(['Property Enquiry', 'Seller Listing']);
window.applyAutomationSettingsSnapshot({ enabled: false });
if (window.applyViewsSnapshot) window.applyViewsSnapshot({});
window.applyTeamSnapshot({ admin: { email: 'admin@threepin.in' } });
window.applyLeadsSnapshot(${JSON.stringify(leads)});
window.__ready = true;
`;
const STUB = stubFor(LEADS);

// ─── the server, for real, over fakes ───────────────────────────────────
function server() {
  const db = createFakeDb();
  const calls = [];
  const TEMPLATES = [
    { template_name: 'post_visit_feedback', template_status: 'APPROVED', template_type: 'UTILITY', language: 'en' },
    { template_name: 'sold_out_collect_requirement', template_status: 'APPROVED', template_type: 'MARKETING', language: 'en' },
    { template_name: 'property_requirement_followup', template_status: 'APPROVED', template_type: 'MARKETING', language: 'en' },
    { template_name: 'site_visit_unavailable_update', template_status: 'APPROVED', template_type: 'UTILITY', language: 'en' },
    { template_name: 'old_offer_v1', template_status: 'REJECTED', template_type: 'MARKETING', language: 'en' },
    // A brochure in its header, and a numbered template whose text TailorTalk gives.
    { template_name: 'brochure_share_v1', template_status: 'APPROVED', template_type: 'UTILITY', language: 'en',
      components: [{ type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: 'Hi {{name}}, here is the brochure for {{property}} ({{code}}) that you asked about. Reply here to book a visit.' }] },
    { template_name: 'visit_reminder_positional', template_status: 'APPROVED', template_type: 'UTILITY', language: 'en',
      components: [{ type: 'BODY', text: 'Hi {{1}}, a reminder of your visit to {{2}} on {{3}}. See you there.' }] }
  ];
  let n = 0;
  const wrap = (body, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify({ data: body, success: status < 300 }), json: async () => ({ data: body }) });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url), path = u.pathname.replace('/api/v1/', ''), body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path, body, query: Object.fromEntries(u.searchParams) });
    if (path === 'get_whatsapp_templates') {
      const name = u.searchParams.get('template_name');
      const list = name ? TEMPLATES.filter(t => t.template_name === name) : TEMPLATES;
      return name && !list.length ? wrap({ detail: 'Template not found' }, 404) : wrap({ templates: list, count: list.length });
    }
    if (path === 'send_whatsapp_template_message') {
      if (srv.delay) await new Promise(r => setTimeout(r, srv.delay));
      if (body.lead_contact === '919840044444') return wrap({ detail: '(#131026) Message undeliverable' }, 400);
      return wrap({ message: 'Message sent successfully.', message_id: 'wamid.' + (++n) });
    }
    if (path === 'campaign_logs') {
      const sends = calls.filter(c => c.path === 'send_whatsapp_template_message' && c.body.lead_contact !== '919840044444');
      return wrap({ logs: u.searchParams.get('start_after') ? [] : sends.map((c, i) => ({ message_id: 'wamid.' + (i + 1), contact_number: c.body.lead_contact, template_name: c.body.template_name, status: i === 0 ? 'replied' : 'read', error: null })), next_cursor: null });
    }
    return wrap({ detail: 'no route' }, 404);
  };
  const ai = async ({ system, user }) => {
    if (/WhatsApp Business message templates/.test(system)) {
      return JSON.stringify({ name: 'price_revised_notice', category: 'UTILITY', header: 'Price Update', body: 'Hi {{name}}, the price of {{property}} ({{code}}) you enquired about is now {{price}}.\n\nShall we arrange a visit this week?', footer: '- 3PIN Realty', buttons: ['Book a visit', 'Send details'], examples: { name: 'Ravi', property: 'Sunrise', code: 'ANR003', price: '₹3 Cr' }, note: 'Tied to their enquiry, no promotion — Utility.' });
    }
    // The leads come as a JSON list ({ id, details }); older servers sent "L1 | …" lines.
    const json = (() => { try { return JSON.parse(user.slice(user.indexOf('['))); } catch (e) { return null; } })();
    const ids = json ? json.filter(l => /price/i.test(l.details || l.text || '')).map(l => l.id) : [...user.matchAll(/^(L\d+) \|.*price/gim)].map(m => m[1]);
    return JSON.stringify(ids.map(id => ({ id, reason: 'Said the price was too high' })));
  };
  // The server's clock. Quiet hours (9 PM – 9 AM IST) are decided by it, so a run at night still
  // sends by day — and the quiet-hours test sets it to 11 PM on purpose.
  const clock = { at: null };
  const deps = makeDeps({ fetch, ai, sleep: async () => {}, now: () => clock.at || Date.now() });
  const handle = body => campaignAction(db, { tenantId: T, email: 'admin@threepin.in' }, 'tok', body, deps, {});
  // delay: ms per TailorTalk send; quietFn(body) → true makes that op land at 11 PM; fail: the next
  // op of that name answers like a gateway timeout (an HTML page, 504).
  const srv = { db, calls, handle, clock, ops: [], forceQuiet: false, delay: 0, quietFn: null, fail: null };
  return srv;
}
const IST = 5.5 * 3600000;
const istHour = (t, h) => Math.floor((t + IST) / DAY) * DAY - IST + h * 3600000;
const quietNow = t => { const h = new Date(t + IST).getUTCHours(); return h >= 21 || h < 9; };
// One op from the page, through the real server.
async function serverOp(srv, body) {
  srv.ops.push(body);
  const quietOp = body.op === 'send' || body.op === 'test-send';
  const forced = srv.forceQuiet || (srv.quietFn && srv.quietFn(body));
  srv.clock.at = !quietOp ? null : forced && !body.allowQuietHours ? istHour(Date.now(), 23) : istHour(Date.now(), 12);
  try { return await srv.handle(body); } finally { srv.clock.at = null; }
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/json' };
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); errors.push(label); }
};

async function openPage(browser, viewport, scheme, opts = {}) {
  const srv = opts.srv || server();
  await srv.handle({ op: 'settings', save: true, addOptOut: '9840066666' });
  await srv.db.collection('campaigns').doc('seed_fb').set(SEED_FB);
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, acceptDownloads: true, hasTouch: viewport.width < 500 });
  if (opts.clipboard !== false) try { await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://crm.local' }); } catch (e) { /* not supported */ }
  const page = await ctx.newPage();
  await page.addInitScript(() => { window.open = (...a) => { window.__opened = a; return null; }; });
  page.__dialogs = [];
  page.on('dialog', d => { page.__dialogs.push(d.message()); d.accept(); });
  const stub = opts.leads ? stubFor(opts.leads) : STUB;
  page.on('pageerror', e => errors.push(`${viewport.width}px pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(`${viewport.width}px console: ${m.text()}`); });
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'crm.local') return route.abort();
    if (u.pathname === '/crm-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: stub });
    if (u.pathname === '/api/tailortalk' && u.searchParams.get('action') === 'campaign') {
      const body = JSON.parse(route.request().postData() || '{}');
      if (srv.fail && srv.fail.op === body.op) {
        // The work happens; the answer is lost — as when Vercel's gateway gives up first.
        const f = srv.fail; srv.fail = null;
        if (f.doIt) await serverOp(srv, body).catch(() => null);
        return route.fulfill({ status: f.status || 504, contentType: 'text/html', body: '<html><body>An error occurred with your deployment FUNCTION_INVOCATION_TIMEOUT</body></html>' });
      }
      let r;
      try { r = await serverOp(srv, body); } catch (e) { r = { ok: false, error: e.message }; }
      return route.fulfill({ status: r.ok === false && !r.notConfigured ? 400 : 200, contentType: 'application/json', body: JSON.stringify(r) });
    }
    if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    const f = join(ROOT, decodeURIComponent(u.pathname));
    if (!existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
  });
  await page.goto('http://crm.local/crm.html' + (opts.path || '?nav=campaigns'));
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  if (opts.noWait) { await page.waitForTimeout(500); return { page, ctx, srv }; }
  try {
    await page.waitForFunction(() => document.querySelector('#campaignsView .cmp-kpis') && !/…/.test(document.querySelector('#campaignsView .cmp-kpis').textContent), null, { timeout: 10000 });
  } catch (e) {
    console.log('DEBUG kpis:', await page.evaluate(() => (document.querySelector('#campaignsView .cmp-kpis')||{}).textContent), await page.evaluate(() => (document.querySelector('.cmp-alert')||{}).textContent)); console.log('DEBUG view:', await page.evaluate(() => ({ disp: document.getElementById('campaignsView').style.display, html: document.getElementById('campaignsView').innerHTML.slice(0, 600), cur: typeof currentView !== 'undefined' && currentView })));
    console.log('DEBUG errors:', errors);
    throw e;
  }
  await page.waitForTimeout(300);
  return { page, ctx, srv };
}
const text = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; }, sel);
const overflow = page => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
const shot = (page, name) => page.screenshot({ path: join(OUT, 'campaign-' + name + '.png'), fullPage: true });
const click = async (page, sel) => { await page.click(sel); await page.waitForTimeout(150); };
const clickText = async (page, sel, t) => { await page.locator(sel, { hasText: t }).first().click(); await page.waitForTimeout(150); };

// Contrast of an element's text against the first opaque background behind it (WCAG ratio).
// Colours are read back through a canvas, so oklab(), color-mix() and light-dark() all resolve.
const contrastOf = (page, sel) => page.evaluate(s => {
  const el = document.querySelector(s);
  if (!el) return null;
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = c => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); return [...cx.getImageData(0, 0, 1, 1).data]; };
  let bg = null;
  for (let e = el; e && !bg; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 250) bg = c; }
  if (!bg) bg = rgba(getComputedStyle(document.body).backgroundColor);
  const fg = rgba(getComputedStyle(el).color);
  const lum = c => { const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const a = lum(fg), b = lum(bg);
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
}, sel);
const sendsTo = srv => srv.calls.filter(c => c.path === 'send_whatsapp_template_message');
const rowsText = page => page.evaluate(() => [...document.querySelectorAll('#campaignsView .cmp-r')].map(r => ({ t: r.textContent.replace(/\s+/g, ' '), on: r.classList.contains('on') })));
const pickFilter = async (page, label, value) => { await page.locator('.cmp-filters label', { hasText: label }).locator('select').selectOption(value); await page.waitForTimeout(150); };
const card = (page, has) => page.locator('#campaignsView .cmp-need', { hasText: has });

const browser = await chromium.launch();

// ═══ 1. The whole journey on a laptop ═══
{
  console.log('\nLaptop — the whole journey');
  const { page, ctx, srv } = await openPage(browser, { width: 1440, height: 900 }, 'light');
  ok('opens from ?nav=campaigns, the CRM search bar hidden', await page.evaluate(() => document.getElementById('campaignsView').style.display === '' && document.querySelector('.srch-wrap').style.display === 'none'));
  ok('rail has the WhatsApp Campaigns section', await page.evaluate(() => window.AppNav.map.some(s => s.id === 'wa' && s.items.length === 4)));
  ok('inventory loaded although the page opened straight onto Campaigns', await page.evaluate(() => inventory && inventory.length === 4));
  ok('the journeys module is on the page', await page.evaluate(() => typeof window.crmJourneys.dueJourneys === 'function'));
  const needs = await text(page, '#campaignsView');
  // ── Suggested messages: every journey with its exact count ──
  ok('suggested: ANR003 sold out with interested leads', /ANR003 · Sunrise Residency 3 BHK is sold out/.test(needs), needs.slice(0, 300));
  ok('…counting only the reachable ones not yet told (Suresh) — not the opted-out, the STOP or the Instagram-only', /1 interested lead not yet told/.test(needs), needs.slice(0, 400));
  ok('…and a call list for the one with a visit planned there (Anitha) — no template, no send', /Call these first — ANR003/.test(needs) && await card(page, 'Call these first').locator('a[href^="tel:+91"]').count() === 1 && await card(page, 'Call these first').locator('.tsk-btn').count() === 0);
  ok('suggested: yesterday’s visits without feedback', /1 visit today or yesterday with no feedback asked/.test(needs));
  ok('…the reminder card says when to send it', /Send between 10 AM and 7 PM/.test(await card(page, 'visit tomorrow').textContent()));
  ok('suggested: tomorrow’s visit', /1 visit tomorrow/.test(needs));
  ok('suggested: the unanswered feedback request (Nadia)', /1 didn’t answer the feedback request/.test(needs));
  ok('suggested: options sent 3+ days ago (Olivia)', /1 sent options 2\+ days ago, no reply/.test(needs));
  ok('suggested: on hold, date come (Harish)', /1 on hold — time to check back/.test(needs));
  ok('suggested: the new listing for matched buyers, by the real match engine', /New listing MADA0002 · Radiance Phase 2/.test(needs) && /3 open buyers match it well/.test(needs), needs.match(/New listing[^·]*·[^R]*/));
  ok('suggested: a lost-over-budget lead the new listing fits (Lakshmi)', /1 lost lead worth one more try/.test(needs) && /MADA0002 came in since/.test(needs));
  ok('suggested: won ten days ago — review or referral (Wasim)', /1 bought in the last 3 weeks — ask for a review or referral/.test(needs));
  const nl = await page.evaluate(() => (PinCampaigns && window.crmJourneys) ? [...document.querySelectorAll('.cmp-need[data-journey^="new_listing"]')].length : 0);
  ok('new listing: one card for the one fresh listing', nl === 1, nl);
  ok('a journey with an approved template offers “Review & send”', await card(page, 'no feedback asked').locator('.tsk-btn', { hasText: 'Review & send' }).count() === 1);
  ok('…one without says so and offers “Create it”', /No approved “Feedback nudge” template yet/.test(await card(page, 'feedback request').textContent()) && await card(page, 'feedback request').locator('.tsk-btn', { hasText: 'Create it' }).count() === 1);
  ok('needs a person: the rejected template', /old_offer_v1 is rejected/.test(needs));
  ok('needs a person: 1 reply waiting (Rita — not Omar’s STOP)', /1 reply waiting for a person/.test(needs) && /Rita Reply: asked for a call/.test(needs), needs.match(/repl[^.]*waiting[^·]*/));
  ok('KPI: replies waiting', /1Replieswaitingneedaperson/.test((await text(page, '.cmp-kpis')).replace(/\s/g, '')), await text(page, '.cmp-kpis'));
  ok('six KPI tiles', await page.evaluate(() => document.querySelectorAll('#campaignsView .cmp-kpis .cmp-kpi').length === 6));
  ok('recent campaign shows its results: replies and visits booked after it', /Feedback — last week.*Results: 2 replies · 1 visit booked/.test(await text(page, '#campaignsView')));
  ok('templates on the dashboard show status', /post_visit_feedback.*Approved/.test(await text(page, '.cmp-tlist')));
  ok('no sideways scroll', (await overflow(page)) === 0, await overflow(page));
  await shot(page, 'dashboard-laptop');

  // Replies waiting.
  await clickText(page, '.cmp-need .tsk-btn', 'See them');
  const rep = await text(page, '.cmp-modal');
  ok('replies: Rita’s words and what they mean', /Rita Reply/.test(rep) && /“Can you call me tomorrow\?”/.test(rep) && /Asked for a call/.test(rep), rep.slice(0, 200));
  ok('…a STOP is not waiting for anyone', !/Omar/.test(rep));
  ok('…the dialog has the focus', await page.evaluate(() => !!document.activeElement.closest('.cmp-modal')));
  await shot(page, 'replies-laptop');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok('Esc closes it', await page.evaluate(() => !document.querySelector('.cmp-modal')));

  // Hide and bring back a suggestion.
  await card(page, 'bought in the last 3 weeks').locator('.cmp-x').click();
  await page.waitForTimeout(200);
  ok('hiding a suggestion takes it off', !/bought in the last 3 weeks/.test(await text(page, '#campaignsView')));
  await clickText(page, '.cmp-link', 'Show 1 hidden');
  ok('“Show hidden” brings it back', /bought in the last 3 weeks/.test(await text(page, '#campaignsView')));

  // "Create it": the feedback nudge from its starter.
  await card(page, 'feedback request').locator('.tsk-btn', { hasText: 'Create it' }).click();
  await page.waitForTimeout(200);
  ok('“Create it” opens the editor on the matching starter', /visit_feedback_nudge_v2/.test(await page.inputValue('.cmp-edform input[placeholder="visit_feedback_v2"]')) && /checking in after your visit/.test(await page.inputValue('#cmpBody')));
  ok('…which meets WhatsApp’s rules', /Meets WhatsApp’s template rules/.test(await text(page, '.cmp-lintbox')));
  await clickText(page, '.cmp-mfoot .tsk-btn', 'Save draft');
  await page.waitForFunction(() => /visit_feedback_nudge_v2 is draft/.test(document.getElementById('campaignsView').textContent), null, { timeout: 5000 });
  ok('…and the card then says its template is a draft', true);
  ok('…saved with its purpose', (srv.db._get(`campaignTemplates/${T}_visit_feedback_nudge_v2`) || Object.values(Object.fromEntries(srv.db._list('campaignTemplates').map(p => [p, srv.db._get(p)]))).find(t => t.name === 'visit_feedback_nudge_v2') || {}).purpose === 'feedback_nudge');

  // Templates
  await clickText(page, '.cmp-tab', 'Templates');
  ok('the screen is marked current in the nav', await page.evaluate(() => document.querySelector('.cmp-tab[aria-current="page"]').textContent.includes('Templates')));
  ok('templates: the 4 made in TailorTalk show their text', await page.evaluate(() => [...document.querySelectorAll('.cmp-tcard')].filter(c => /Thank you for visiting|SOLD|just checking in|not ready for a site visit/.test(c.textContent)).length === 4));
  ok('templates: Meta’s re-label is shown', /moved it from Utility to Marketing/.test(await text(page, '.cmp-tgrid')));
  await clickText(page, '.cmp-chip', 'Rejected');
  ok('filter: rejected only', await page.evaluate(() => document.querySelectorAll('.cmp-tcard').length === 1));
  await clickText(page, '.cmp-chip', 'All');

  // Create with AI
  await clickText(page, '.tsk-btn', 'Create template');
  ok('editor opens with the AI panel open', await page.evaluate(() => !!document.querySelector('.cmp-ai[open]')));
  await page.selectOption('.cmp-ai select >> nth=0', 'price_update');
  await clickText(page, '.cmp-ai .tsk-btn', 'Write it');
  await page.waitForFunction(() => /price of/.test((document.getElementById('cmpBody') || {}).value || ''), null, { timeout: 5000 });
  ok('AI wrote the template into the editor', /price_revised_notice/.test(await page.inputValue('.cmp-edform input[placeholder="visit_feedback_v2"]')));
  ok('preview fills samples', /₹3 Cr/.test(await text(page, '.cmp-edprev')));
  ok('passes the rules', /Meets WhatsApp’s template rules/.test(await text(page, '.cmp-lintbox')));
  await page.fill('#cmpBody', '{{name}} the price changed');
  ok('a broken rule is named and Save is off', /cannot start with a variable/.test(await text(page, '.cmp-lintbox')) && await page.isDisabled('.cmp-mfoot .tsk-btn.primary'));
  ok('typing kept the caret in the message box', await page.evaluate(() => document.activeElement && document.activeElement.id === 'cmpBody'));
  await page.fill('#cmpBody', 'Hi {{name}}, the price of {{property}} ({{code}}) you enquired about is now {{price}}.\n\nShall we arrange a visit this week?');
  await clickText(page, '.cmp-mfoot .tsk-btn', 'Save draft');
  await page.waitForFunction(() => [...document.querySelectorAll('.cmp-tcard')].some(c => /price_revised_notice/.test(c.textContent) && /Draft/.test(c.textContent)), null, { timeout: 5000 });
  ok('draft saved and listed', true);
  await page.locator('.cmp-tcard', { hasText: 'price_revised_notice' }).locator('.tsk-btn', { hasText: 'Copy & open TailorTalk' }).click();
  await page.waitForTimeout(400);
  ok('Copy & open TailorTalk opens TailorTalk', await page.evaluate(() => window.__opened && /dashboard\.tailortalk\.ai/.test(window.__opened[0])));
  const clip = await page.evaluate(() => navigator.clipboard ? navigator.clipboard.readText().catch(() => '') : '') || await page.evaluate(() => (document.querySelector('.cmp-copybox') || {}).value || '');
  ok('…with the template ready to paste', /Name: price_revised_notice[\s\S]*Body:[\s\S]*Quick reply buttons/.test(clip), clip.slice(0, 120));
  // Copied: marked at once. The clipboard refused: the person says when it is in TailorTalk.
  const copyDialog = await page.$('.cmp-modal .cmp-copybox');
  if (copyDialog) await clickText(page, '.cmp-modal .tsk-btn', 'submitted it in TailorTalk');
  await page.waitForTimeout(400);
  ok('…and it is marked submitted', /Submitted/.test(await page.locator('.cmp-tcard', { hasText: 'price_revised_notice' }).textContent()));

  // Starter library
  await clickText(page, '.tsk-btn', 'Starter library');
  const nStarters = await page.evaluate(() => window.crmCampaign.STARTERS.length);
  ok('starter library lists every starter', await page.evaluate(n => document.querySelectorAll('.cmp-modal .cmp-tcard').length === n, nStarters), nStarters);
  await page.locator('.cmp-modal .cmp-tcard', { hasText: 'Visit reminder' }).first().locator('.tsk-btn').click();
  await page.waitForTimeout(200);
  ok('starter opens in the editor, valid', /Meets WhatsApp’s template rules/.test(await text(page, '.cmp-lintbox')));
  await clickText(page, '.cmp-mfoot .tsk-btn', 'Save draft');
  await page.waitForTimeout(400);
  await shot(page, 'templates-laptop');

  // ── Sold-out from the dashboard: "Review & send" opens the suggestion's own leads ──
  await clickText(page, '.cmp-tab', 'Dashboard');
  await card(page, 'sold out').locator('.tsk-btn', { hasText: 'Review & send' }).click();
  await page.waitForTimeout(300);
  ok('“Review & send” opens step 3, template and property already chosen', await page.evaluate(() => /Who gets it/.test(document.querySelector('.cmp-stepper li.on').textContent) && document.querySelectorAll('.cmp-stepper li.done').length === 2));
  let sold = await rowsText(page);
  ok('…exactly the suggestion’s leads: Suresh (Anitha is on the call list)', sold.length === 1 && sold.some(r => /Suresh/.test(r.t)), sold.map(r => r.t.slice(0, 30)));
  ok('…its chip marked as the list in use', /Suggested: ANR003/.test(await text(page, '.cmp-chip.j.on')));
  ok('…property_name filled from ANR003', await page.evaluate(() => [...document.querySelectorAll('.cmp-rvals input')].some(i => i.value === 'Sunrise Residency 3 BHK')));
  await clickText(page, '.cmp-chip', 'Interested in a sold-out property');
  sold = await rowsText(page);
  ok('the full quick list holds back the opted-out, the STOP and the Instagram-only, each with a reason', sold.some(r => /Opted Out Person.*Asked not to be messaged/.test(r.t)) && sold.some(r => /Omar Optout.*Asked not to be messaged/.test(r.t) && !r.on) && sold.some(r => /insta_user.*No WhatsApp number/.test(r.t)), sold.map(r => r.t.slice(0, 60)));
  await clickText(page, '.cmp-chip', 'Everyone');
  sold = await rowsText(page);
  ok('a Marketing template holds back Negotiating and Won leads', sold.some(r => /Nikhil Negotiating.*Negotiating — no Marketing messages/.test(r.t) && !r.on) && sold.some(r => /Wasim Won.*Won — no Marketing messages/.test(r.t)), sold.filter(r => /Nikhil|Wasim/.test(r.t)).map(r => r.t.slice(0, 80)));

  // ── A journey: visit feedback, one tap ──
  await clickText(page, '.cmp-tab', 'Dashboard');
  await card(page, 'no feedback asked').locator('.tsk-btn', { hasText: 'Review & send' }).click();
  await page.waitForTimeout(300);
  let rows = await rowsText(page);
  ok('visit feedback opens with the journey’s lead', rows.length === 1 && rows.some(r => /Ravi \(duplicate\)/.test(r.t)), rows.map(r => r.t.slice(0, 40)));
  ok('…with post_visit_feedback picked', await page.evaluate(() => document.querySelector('.cmp-stepper li.done') !== null) && /post_visit_feedback/.test(await page.evaluate(() => { PinCampaigns.step(1); return document.querySelector('.cmp-tcard.pick.on .cmp-tn').textContent; })));

  // ── The full four steps for visit feedback ──
  await page.evaluate(() => PinCampaigns.startWizard());
  await page.waitForTimeout(200);
  ok('step 1 lists only approved templates', await page.evaluate(() => { const n = [...document.querySelectorAll('.cmp-tcard.pick .cmp-tn')].map(e => e.textContent); return n.includes('post_visit_feedback') && !n.includes('old_offer_v1') && !n.includes('price_revised_notice'); }));
  ok('…and says why the others are missing', /old_offer_v1 \(rejected\)/.test(await text(page, '#campaignsView')));
  await page.locator('.cmp-tcard.pick', { hasText: 'post_visit_feedback' }).click();
  await page.waitForTimeout(150);
  await clickText(page, '.cmp-wnav .tsk-btn', 'Property & values');
  const maps = await page.evaluate(() => [...document.querySelectorAll('.cmp-map')].map(m => m.querySelector('code').textContent + '=' + m.querySelector('select').value));
  ok('the rail follows the screen', await page.evaluate(() => currentView === 'cmp-new'));
  ok('step 2 maps 3 PIN’s variable names by themselves', JSON.stringify(maps) === '["{{name}}=lead_name","{{property_name}}=property","{{property_code}}=code"]', maps);
  await clickText(page, '.cmp-wnav .tsk-btn', 'Who gets it');
  await clickText(page, '.cmp-chip', 'Visited in the last 7 days');
  rows = await rowsText(page);
  ok('quick list: visited this week = Ravi, Anitha, Prakash, Ravi(dup)', rows.length === 4, rows.map(r => r.t.slice(0, 30)));
  ok('greeting name cleaned (“~ Ravi Kumar 🙂” → Ravi Kumar)', await page.evaluate(() => [...document.querySelectorAll('.cmp-rvals input')].some(i => i.value === 'Ravi Kumar')));
  ok('a duplicate number is held back', rows.some(r => /Ravi \(duplicate\).*Same number/.test(r.t)));
  ok('Prakash (no property) is held for a missing code', rows.some(r => /Prakash.*Missing/.test(r.t) && !r.on));
  const pr = page.locator('.cmp-r', { hasText: 'Prakash' });
  await pr.locator('input').nth(2).fill('Radiance Solitaire'); await pr.locator('input').nth(2).dispatchEvent('change');
  await page.waitForTimeout(150);
  await page.locator('.cmp-r', { hasText: 'Prakash' }).locator('input').nth(3).fill('MADA0001');
  await page.locator('.cmp-r', { hasText: 'Prakash' }).locator('input').nth(3).dispatchEvent('change');
  await page.waitForTimeout(150);
  ok('filling the missing value puts Prakash back in', await page.evaluate(() => [...document.querySelectorAll('.cmp-r')].some(r => /Prakash/.test(r.textContent) && r.classList.contains('on'))));
  await page.click('.cmp-filters input[placeholder="e.g. Anna Nagar"]');
  await page.keyboard.type('Anna', { delay: 30 });
  await page.waitForTimeout(500);
  ok('area filter narrows to Anitha', await page.evaluate(() => document.querySelectorAll('.cmp-r').length === 1 && /Anitha/.test(document.querySelector('.cmp-r').textContent)));
  ok('…and the area box kept its caret through the redraw', await page.evaluate(() => document.activeElement && document.activeElement.placeholder === 'e.g. Anna Nagar' && document.activeElement.value === 'Anna'));
  await page.fill('.cmp-filters input[placeholder="e.g. Anna Nagar"]', '');
  await page.waitForTimeout(500);
  await clickText(page, '.cmp-chip', 'Everyone');
  await page.fill('.cmp-aiq input', 'buyers who found the price too high');
  await clickText(page, '.cmp-aiq .tsk-btn', 'Choose');
  await page.waitForFunction(() => /AI picked/.test(document.getElementById('campaignsView').textContent), null, { timeout: 5000 });
  rows = await rowsText(page);
  ok('AI picks Anitha, with the reason shown', rows.length === 1 && /Anitha.*Said the price was too high/.test(rows[0].t), rows);
  await clickText(page, '.tsk-btn', 'Clear AI picks');
  await clickText(page, '.cmp-chip', 'Visited in the last 7 days');
  await page.fill('.cmp-manual', '99418 80088, Thiru, MADA0001\n12345, bad line\n98400 11111, Same as Ravi');
  await clickText(page, '.tsk-btn', 'Add to the list');
  rows = await rowsText(page);
  ok('typed-in contact added with its property', rows.some(r => /Thiru.*added by hand/.test(r.t) && r.on), rows.map(r => r.t.slice(0, 40)));
  ok('…a typed-in number already on a lead is that lead (one row, the lead’s own name)', !rows.some(r => /Same as Ravi/.test(r.t)) && rows.filter(r => /Ravi Kumar/.test(r.t) && /added by hand/.test(r.t) && r.on).length === 1, rows.map(r => r.t.slice(0, 60)));
  ok('…and the count says so: added, in the CRM, without a number', /2 added \(1 already in the CRM.*1 without a valid number/.test(await text(page, '.cmp-addnote')), await text(page, '.cmp-addnote'));
  await page.locator('.cmp-r', { hasText: 'Anitha' }).locator('input[type=checkbox]').uncheck();
  await page.waitForTimeout(150);
  const onCount = await page.evaluate(() => document.querySelectorAll('.cmp-r.on').length);
  ok('unticking takes Anitha out', onCount === 3, onCount);
  await shot(page, 'who-laptop');
  await clickText(page, '.cmp-wnav .tsk-btn', 'Review & send');
  ok('review: 3 recipients, 1 added by hand', /Recipients3 \(2 added by hand\)/.test(await text(page, '.cmp-dl')), await text(page, '.cmp-dl'));
  ok('review: the cost, estimated from the Utility rate and called approximate', /Estimated cost≈ ₹0\.36 approximate — 3 × ₹0\.12 Utility rate/.test(await text(page, '.cmp-dl')), await text(page, '.cmp-dl'));
  ok('…a small send is not warned about', !/big send/.test(await text(page, '#campaignsView')));
  ok('…but “with us today” sent the day after a visit is', /written to be sent on the day of the visit — 3 of 3 did not visit today/.test(await text(page, '.cmp-alert.warn')), await text(page, '.cmp-alert.warn'));
  ok('review: preview reads as the lead will', /Thank you for visiting/.test(await text(page, '.cmp-grid2 .cmp-card:nth-child(2)')));
  await shot(page, 'review-laptop');

  // Test
  const before = sendsTo(srv).length;
  await clickText(page, '.tsk-btn', 'Send a test to');
  await page.waitForTimeout(400);
  const tests = sendsTo(srv).slice(before);
  ok('test goes to +91 99418 80088 only', tests.length === 1 && tests[0].body.lead_contact === '919941880088', tests.map(t => t.body.lead_contact));
  // CSV
  const [dl] = await Promise.all([page.waitForEvent('download'), clickText(page, '.tsk-btn', 'Download CSV')]);
  const csv = readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '');
  ok('CSV in TailorTalk’s format', csv.split('\r\n')[0] === 'contact,name,property_name,property_code' && csv.split('\r\n').filter(Boolean).length === 4, csv);
  ok('…with Prakash’s hand-filled code', /919840033333,Prakash,Radiance Solitaire,MADA0001/.test(csv));
  await page.waitForTimeout(300);
  ok('CSV recorded as a campaign, nothing sent', srv.db._list('campaigns').length === 2 && sendsTo(srv).length === before + 1);
  // Send
  await clickText(page, '.cmp-sopt.main .tsk-btn', 'Send to 3');
  ok('send asks for the count', await page.isDisabled('#cmpGo'));
  await page.fill('#cmpConfirmN', '2');
  ok('…a wrong count keeps it off', await page.isDisabled('#cmpGo'));
  await page.fill('#cmpConfirmN', '3');
  await click(page, '#cmpGo');
  await page.waitForFunction(() => /See the campaign/.test(document.body.textContent), null, { timeout: 10000 });
  const sends = sendsTo(srv).slice(before + 1);
  ok('3 messages sent, one per person', sends.length === 3 && new Set(sends.map(s => s.body.lead_contact)).size === 3, sends.map(s => s.body.lead_contact));
  ok('…with named params', sends.every(s => s.body.template_params && s.body.template_params.property_code));
  ok('…Anitha (unticked) not sent', !sends.some(s => s.body.lead_contact === '919840022222'));
  await clickText(page, '.tsk-btn', 'See the campaign');
  await page.waitForFunction(() => /Delivery last checked/.test(document.getElementById('campaignsView').textContent), null, { timeout: 8000 });
  const det = await text(page, '#campaignsView');
  ok('campaign page: delivery refreshed by itself', /Replied/.test(det) && /Read/.test(det), det.slice(0, 300));
  ok('campaign page: estimated cost', /≈ ₹0\.36\s*Estimated cost\s*3 × ₹0\.12, approximate/.test(det), det.match(/≈[^a-z]*Estimated cost[^a-z]*/));
  await shot(page, 'detail-laptop');
  await clickText(page, '.cmp-tab', 'Campaigns');
  await page.evaluate(() => PinCampaigns.closeCampaign());
  ok('history lists the sent campaign, the CSV one and last week’s', await page.evaluate(() => document.querySelectorAll('.cmp-crow').length === 3));
  ok('…the CSV one says so', /in the CSV for TailorTalk Broadcast/.test(await text(page, '#campaignsView')));

  // Failure + retry: Meena (tomorrow) fails at TailorTalk.
  await page.evaluate(() => PinCampaigns.preset('visit_feedback'));
  await page.waitForTimeout(200);
  await page.evaluate(() => PinCampaigns.quick('tomorrow'));
  await page.waitForTimeout(200);
  await page.evaluate(() => PinCampaigns.step(4));
  await page.waitForTimeout(200);
  await clickText(page, '.cmp-sopt.main .tsk-btn', 'Send to 1');
  await page.fill('#cmpConfirmN', '1');
  await click(page, '#cmpGo');
  await page.waitForFunction(() => /See the campaign/.test(document.body.textContent), null, { timeout: 8000 });
  await clickText(page, '.tsk-btn', 'See the campaign');
  await page.waitForTimeout(600);
  ok('a failure shows its reason', /undeliverable/.test(await text(page, '#campaignsView')));
  await clickText(page, '.tsk-btn', 'Retry the failed');
  ok('retry loads only the failed contact', await page.evaluate(() => document.querySelectorAll('.cmp-r').length === 1 && /Meena/.test(document.querySelector('.cmp-r').textContent)));

  // ── Quiet hours: the server's clock says 11 PM ──
  srv.forceQuiet = true;
  await page.evaluate(() => PinCampaigns.preset('visit_feedback'));
  await page.waitForTimeout(200);
  await page.evaluate(() => PinCampaigns.step(4));
  await page.waitForTimeout(200);
  const q0 = sendsTo(srv).length;
  await clickText(page, '.tsk-btn', 'Send a test to');
  await page.waitForFunction(() => /It is quiet hours/.test((document.querySelector('.cmp-modal') || {}).textContent || ''), null, { timeout: 5000 });
  ok('quiet hours: a test is refused by the server and the page asks', sendsTo(srv).length === q0 && /9 PM – 9 AM/.test(await text(page, '.cmp-modal')), await text(page, '.cmp-modal'));
  await shot(page, 'quiet-laptop');
  await clickText(page, '.cmp-modal .tsk-btn', 'Send anyway');
  await page.waitForTimeout(400);
  ok('…“Send anyway” sends it, saying so to the server', sendsTo(srv).length === q0 + 1 && srv.ops.some(o => o.op === 'test-send' && o.allowQuietHours === true));
  const nOn = await page.evaluate(() => document.querySelectorAll('.cmp-sopt.main').length && Number((document.querySelector('.cmp-sopt.main .tsk-btn').textContent.match(/\d+/) || [0])[0]));
  await clickText(page, '.cmp-sopt.main .tsk-btn', 'Send to');
  await page.fill('#cmpConfirmN', String(nOn));
  await click(page, '#cmpGo');
  await page.waitForFunction(() => /It is quiet hours/.test((document.querySelector('.cmp-modal') || {}).textContent || ''), null, { timeout: 5000 });
  ok('a send in quiet hours is refused before anything goes', sendsTo(srv).length === q0 + 1 && /people are waiting|person is waiting/.test(await text(page, '.cmp-modal')));
  await clickText(page, '.cmp-modal .tsk-btn', 'Cancel');
  await page.waitForFunction(() => /Send the \d+ waiting/.test(document.getElementById('campaignsView').textContent), null, { timeout: 5000 });
  ok('…Cancel keeps the campaign, everyone waiting', sendsTo(srv).length === q0 + 1);
  await clickText(page, '.tsk-btn', 'waiting');
  await page.waitForFunction(() => /It is quiet hours/.test((document.querySelector('.cmp-modal') || {}).textContent || ''), null, { timeout: 5000 });
  await clickText(page, '.cmp-modal .tsk-btn', 'Send anyway');
  await page.waitForFunction(() => /See the campaign/.test(document.body.textContent), null, { timeout: 8000 });
  ok('…and “Send anyway” from the campaign sends them all', sendsTo(srv).length === q0 + 1 + nOn && srv.ops.some(o => o.op === 'send' && o.allowQuietHours === true), [sendsTo(srv).length, q0, nOn]);
  await clickText(page, '.tsk-btn', 'See the campaign');
  srv.forceQuiet = false;

  // ── A campaign’s replies and what it led to ──
  await page.evaluate(() => PinCampaigns.openCampaign('seed_fb'));
  await page.waitForFunction(() => /What it led to/.test(document.getElementById('campaignsView').textContent), null, { timeout: 5000 });
  const sd = await text(page, '#campaignsView');
  ok('detail: each reply’s words and meaning', /“Can you call me tomorrow\?”\s*Asked for a call/.test(sd) && /“STOP”\s*Asked not to be messaged/.test(sd), sd.slice(0, 500));
  const out = await text(page, '.cmp-outcome');
  ok('what it led to: 2 replied, 1 visit booked, 1 asked not to be messaged, of the 3 it reached', /of the 3 CRM leads it reached/.test(out) && /Replied\s*2/.test(out) && /Site visit booked\s*1/.test(out) && /Asked not to be messaged\s*1/.test(out) && /Won\s*0/.test(out), out);
  ok('…naming who moved on', /Moved on since: Rita Reply \(Visit planned\)/.test(out), out);
  await clickText(page, '.cmp-chip', 'Replied');
  ok('the Replied filter shows only the two who replied', await page.evaluate(() => document.querySelectorAll('#campaignsView .cmp-r').length === 2));
  ok('no sideways scroll on the detail', (await overflow(page)) === 0);
  await shot(page, 'outcome-laptop');

  // ── Who gets it: the new filters and saved lists ──
  await page.evaluate(() => { PinCampaigns.startWizard(); PinCampaigns.pickTemplate('post_visit_feedback'); PinCampaigns.step(3); });
  await page.waitForTimeout(200);
  const names = () => page.evaluate(() => [...document.querySelectorAll('#campaignsView .cmp-r .cmp-rname')].map(e => e.textContent.replace(/[×\s]+$/, '').trim()).sort());
  await clickText(page, '.cmp-stagef .cmp-chip', 'Negotiating');
  await clickText(page, '.cmp-stagef .cmp-chip', 'Won');
  ok('several stages at once: Negotiating + Won', JSON.stringify(await names()) === '["Nikhil Negotiating","Wasim Won"]', await names());
  ok('…the chips say they are on', await page.evaluate(() => document.querySelectorAll('.cmp-stagef .cmp-chip[aria-pressed="true"]').length === 2));
  await clickText(page, '.cmp-link', 'Clear 1 filter');
  await pickFilter(page, 'Lead agent', 'swami@threepin.in');
  ok('lead agent: Swami’s leads', JSON.stringify(await names()) === '["Olivia Options","~ Ravi Kumar 🙂"]', await names());
  await page.evaluate(() => PinCampaigns.clearFilters());
  await page.waitForTimeout(100);
  await pickFilter(page, 'On hold', 'due');
  ok('on hold, revisit due: Harish', JSON.stringify(await names()) === '["Harish Hold"]', await names());
  await page.evaluate(() => PinCampaigns.clearFilters());
  await page.waitForTimeout(100);
  await pickFilter(page, 'Ad or post', 'Anna Nagar 3BHK reel');
  ok('the ad that brought them: Suresh and Olivia', JSON.stringify(await names()) === '["Olivia Options","Suresh"]', await names());
  await page.evaluate(() => PinCampaigns.clearFilters());
  await page.waitForTimeout(100);
  rows = await rowsText(page);
  ok('a lead who replied STOP is held back for it', rows.some(r => /Omar Optout.*Asked not to be messaged/.test(r.t) && !r.on));
  await pickFilter(page, 'Lost reason', 'budget');
  ok('lost reason: Lakshmi', JSON.stringify(await names()) === '["Lakshmi Lost"]', await names());
  await clickText(page, '.cmp-saved .cmp-link', 'Save this list');
  ok('save a list: asks for its name', await page.evaluate(() => document.activeElement && document.activeElement.id === 'cmpListName'));
  await page.fill('#cmpListName', 'Lost over budget');
  await clickText(page, '.cmp-modal .tsk-btn', 'Save');
  await page.waitForTimeout(300);
  const lists = (await srv.handle({ op: 'settings' })).settings.lists || [];
  ok('…saved on the server with the filters', lists.length === 1 && lists[0].name === 'Lost over budget' && lists[0].f && lists[0].f.lost === 'budget', lists);
  ok('…and offered as a chip', /Lost over budget/.test(await text(page, '.cmp-saved')));
  await page.evaluate(() => PinCampaigns.clearFilters());
  await page.waitForTimeout(100);
  ok('cleared: everyone again', (await rowsText(page)).length > 5);
  await clickText(page, '.cmp-saved .cmp-chip', 'Lost over budget');
  ok('loading the saved list brings back its filters', JSON.stringify(await names()) === '["Lakshmi Lost"]' && (await page.locator('.cmp-filters label', { hasText: 'Lost reason' }).locator('select').inputValue()) === 'budget');
  await shot(page, 'filters-laptop');
  await page.locator('.cmp-saved .cmp-x').first().click();
  await page.waitForTimeout(300);
  ok('deleting a saved list', ((await srv.handle({ op: 'settings' })).settings.lists || []).length === 0 && !/Lost over budget/.test(await text(page, '.cmp-saved')));

  // Dashboard numbers after sending: the tiles add up what the server holds.
  await clickText(page, '.cmp-tab', 'Dashboard');
  await page.waitForTimeout(400);
  const month = (await srv.handle({ op: 'list' })).campaigns.filter(c => c.createdAt >= Date.now() - 30 * DAY);
  const sum = k => month.reduce((a, c) => a + ((c.counts && c.counts[k]) || 0), 0);
  const k = (await text(page, '.cmp-kpis')).replace(/\s/g, '');
  ok('dashboard counts the messages sent and the failure', k.includes(sum('sent') + 'Messagessent' + sum('failed') + 'failed'), [k, sum('sent'), sum('failed')]);
  ok('…the headline is positive replies (not read), with what one cost', /\d+%Positivereplies\d+positive·\d+repl/.test(k) && /Costperpositivereply/.test(k), k);
  // Settings: rates and quiet hours.
  await clickText(page, '.cmp-tab', 'Settings');
  ok('settings show the test number', /\+91 99418 80088/.test(await page.inputValue('#cmpSetTest')));
  ok('…the opted-out number', /98400 66666/.test(await page.inputValue('#cmpSetOpt')));
  ok('…the rates and quiet hours', (await page.inputValue('#cmpSetMkt')) === '0.79' && (await page.inputValue('#cmpSetUtil')) === '0.12' && (await page.inputValue('#cmpSetQs')) === '21' && (await page.inputValue('#cmpSetQe')) === '9');
  ok('…and the dialog has the focus', await page.evaluate(() => !!document.activeElement.closest('.cmp-modal')));
  await page.fill('#cmpSetGap', '10');
  await page.fill('#cmpSetMkt', '1.1');
  await page.selectOption('#cmpSetQs', '22');
  await clickText(page, '.cmp-mfoot .tsk-btn', 'Save');
  await page.waitForTimeout(300);
  const st = (await srv.handle({ op: 'settings' })).settings;
  ok('settings saved on the server', st.marketingGapDays === 10 && st.marketingRate === 1.1 && st.quietStart === 22, st);
  await clickText(page, '.cmp-tab', 'Settings');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok('Esc closes settings', await page.evaluate(() => !document.querySelector('.cmp-modal')));

  // A big send is warned about: 200+ people.
  await page.evaluate(() => PinCampaigns.preset('sold_out', 'ANR003'));
  await page.waitForTimeout(200);
  await page.fill('.cmp-manual', Array.from({ length: 205 }, (_, i) => `98450${String(10000 + i)}, Buyer ${i}`).join('\n'));
  await clickText(page, '.tsk-btn', 'Add to the list');
  await page.evaluate(() => PinCampaigns.step(4));
  await page.waitForTimeout(200);
  const warn = await text(page, '.cmp-alert.warn');
  ok('a send to 200+ people is flagged above the summary, with its cost', /big send: 20\d people, about ₹2\d\d/.test(warn), warn);
  ok('…costed at the new Marketing rate', /× ₹1\.10 Marketing rate/.test(await text(page, '.cmp-dl')), await text(page, '.cmp-dl'));
  await shot(page, 'bigsend-laptop');
  await ctx.close();
}

// ═══ 3. The fix round: sending once, each lead's brochure, honest errors, holds, CSV, Back ═══
{
  console.log('\nFix round — safety, data, navigation, keyboard');
  const toAt = (page, tpl, step = 3) => page.evaluate(([t, s]) => { PinCampaigns.startWizard(); PinCampaigns.pickTemplate(t); PinCampaigns.step(s); }, [tpl, step]);
  const toastText = page => page.evaluate(() => [...document.querySelectorAll('[class*=toast], #toast')].map(e => e.textContent).join(' | '));
  const creates = srv => srv.ops.filter(o => o.op === 'create');
  const focusIs = page => page.evaluate(() => { const a = document.activeElement; return a ? (a.id || a.className || a.tagName) : ''; });

  // ── Send once: a double click, then Enter in the "Type N" box ──
  {
    const srv = server(); srv.delay = 40;
    const { page, ctx } = await openPage(browser, { width: 1440, height: 900 }, 'light', { srv });
    await toAt(page, 'site_visit_unavailable_update');
    await page.evaluate(() => { PinCampaigns.quick('visited'); PinCampaigns.step(4); });
    await page.waitForTimeout(200);
    const n = await page.evaluate(() => Number(document.querySelector('.cmp-sopt.main .tsk-btn').textContent.match(/\d+/)[0]));
    await page.locator('.cmp-sopt.main .tsk-btn').click();
    await page.fill('#cmpConfirmN', String(n));
    await page.locator('#cmpGo').dblclick();
    await page.waitForFunction(() => /See the campaign/.test(document.body.textContent), null, { timeout: 15000 });
    ok('double-clicking “Send now” makes ONE campaign and one message each', creates(srv).length === 1 && sendsTo(srv).length === n && new Set(sendsTo(srv).map(s => s.body.lead_contact)).size === n, [creates(srv).length, sendsTo(srv).map(s => s.body.lead_contact)]);
    ok('…and the create carries a request id for the server to remember', /^[\w-]{8,}$/.test(creates(srv)[0].requestId || ''), creates(srv)[0].requestId);
    // The same campaign sent again with the same id (a retry after a timeout) is the same campaign.
    const again = await srv.handle({ ...creates(srv)[0] });
    ok('…the server answers a repeat of that id with the same campaign', again.duplicate === true, again);
    await page.locator('.tsk-btn', { hasText: 'See the campaign' }).click();
    await page.waitForTimeout(500);
    ok('the campaign has its own address (#cmp/<id>)', /#cmp\//.test(page.url()), page.url());
    await toAt(page, 'site_visit_unavailable_update');
    await page.evaluate(() => { PinCampaigns.quick('visited'); PinCampaigns.step(4); });
    await page.waitForTimeout(200);
    await page.locator('.cmp-sopt.main .tsk-btn').click();
    ok('the confirm box has the focus', (await focusIs(page)) === 'cmpConfirmN');
    await page.keyboard.type(String(n));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /See the campaign/.test(document.body.textContent), null, { timeout: 15000 });
    ok('Enter in the “Type N” box sends, once', creates(srv).length === 2, creates(srv).length);
    await page.locator('.tsk-btn', { hasText: 'See the campaign' }).click();
    await page.waitForTimeout(300);
    // Send a test, Download CSV: twice as fast as a person can press.
    srv.delay = 150;
    await toAt(page, 'site_visit_unavailable_update');
    await page.evaluate(() => { PinCampaigns.quick('visited'); PinCampaigns.step(4); });
    await page.waitForTimeout(200);
    const t0 = sendsTo(srv).length;
    await page.locator('.tsk-btn', { hasText: 'Send a test to' }).dblclick();
    const busy = await page.evaluate(() => { const b = [...document.querySelectorAll('.cmp-sopt .tsk-btn')].find(x => /test/i.test(x.textContent)); return b && b.disabled && /Sending the test/.test(b.textContent); });
    await page.waitForTimeout(800);
    ok('double-clicking “Send a test” sends one test, the button off meanwhile', sendsTo(srv).length - t0 === 1 && busy, [sendsTo(srv).length - t0, busy]);
    ok('…with a request id', srv.ops.filter(o => o.op === 'test-send').every(o => o.requestId));
    const c0 = creates(srv).length, dls = [];
    page.on('download', d => dls.push(d.suggestedFilename()));
    await page.locator('.tsk-btn', { hasText: 'Download CSV' }).dblclick();
    await page.waitForTimeout(900);
    ok('double-clicking “Download CSV” downloads and records it once', dls.length === 1 && creates(srv).length - c0 === 1, [dls, creates(srv).length - c0]);
    // Step 4: the name can still be changed, and the test is the person shown.
    await page.fill('#cmpName4', 'Renamed on review');
    await page.evaluate(() => PinCampaigns.preview(1));
    await page.waitForTimeout(150);
    const shownName = await page.evaluate(() => document.querySelector('#cmpPrevH').textContent);
    const t1 = sendsTo(srv).length;
    await page.locator('.tsk-btn', { hasText: 'Send a test to' }).click();
    await page.waitForTimeout(500);
    const test = sendsTo(srv)[t1];
    ok('“Send a test” sends the message of the person in the preview', test && shownName.includes(test.body.template_params.name || test.body.template_params.customer_name || '@@'), [shownName, test && test.body.template_params]);
    await page.locator('.cmp-sopt.main .tsk-btn').click();
    await page.fill('#cmpConfirmN', String(n));
    await page.click('#cmpGo');
    await page.waitForFunction(() => /See the campaign/.test(document.body.textContent), null, { timeout: 15000 });
    ok('the campaign name edited on the review is the one saved', creates(srv).slice(-1)[0].name === 'Renamed on review', creates(srv).slice(-1)[0].name);
    await page.locator('.tsk-btn', { hasText: 'See the campaign' }).click();
    await ctx.close();
  }

  // ── A gateway timeout is not a success ──
  {
    const srv = server();
    const { page, ctx } = await openPage(browser, { width: 1440, height: 900 }, 'light', { srv });
    await toAt(page, 'site_visit_unavailable_update');
    await page.evaluate(() => { PinCampaigns.quick('visited'); PinCampaigns.step(4); });
    await page.waitForTimeout(200);
    const n = await page.evaluate(() => Number(document.querySelector('.cmp-sopt.main .tsk-btn').textContent.match(/\d+/)[0]));
    srv.fail = { op: 'create', status: 504, doIt: true };
    await page.locator('.cmp-sopt.main .tsk-btn').click();
    await page.fill('#cmpConfirmN', String(n));
    await page.click('#cmpGo');
    await page.waitForTimeout(800);
    const tt = await toastText(page);
    ok('a 504 (an HTML page) says the server took too long — not “Sent”', /server took too long — open the campaign to see what went/.test(tt) && !/See the campaign/.test(await text(page, 'body')), tt);
    ok('…and opens the list of campaigns to look', await page.evaluate(() => currentView === 'cmp-history'));
    ok('…nothing was sent behind it', sendsTo(srv).length === 0);
    await ctx.close();
  }

  // ── Quiet hours starting mid-send; an offer at night ──
  {
    const srv = server();
    let batches = 0;
    srv.quietFn = b => { if (b.op === 'send') { batches++; return batches > 1; } return false; };
    const { page, ctx } = await openPage(browser, { width: 1440, height: 900 }, 'light', { srv });
    await toAt(page, 'site_visit_unavailable_update');
    await page.evaluate(() => PinCampaigns.wiz('onlyManual', true));
    await page.fill('.cmp-manual', Array.from({ length: 20 }, (_, i) => `98450${40000 + i}, Buyer ${i}`).join('\n'));
    await page.locator('.tsk-btn', { hasText: 'Add to the list' }).click();
    await page.evaluate(() => PinCampaigns.step(4));
    await page.waitForTimeout(200);
    await page.locator('.cmp-sopt.main .tsk-btn').click();
    await page.fill('#cmpConfirmN', '20');
    await page.click('#cmpGo');
    await page.waitForFunction(() => /quiet hours/i.test((document.querySelector('.cmp-modal') || {}).textContent || ''), null, { timeout: 10000 });
    const m = await text(page, '.cmp-modal');
    ok('quiet hours mid-send gives the real count: “8 sent, 12 waiting”', /8 sent, 12 waiting/.test(m) && !/Nothing has been sent/.test(m), m);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    // An offer at 11 PM: the server refuses and nobody may override it.
    srv.quietFn = () => true;
    await toAt(page, 'property_requirement_followup');
    await page.evaluate(() => PinCampaigns.wiz('onlyManual', true));
    await page.fill('.cmp-manual', '98450 50001, Offer One');
    await page.locator('.tsk-btn', { hasText: 'Add to the list' }).click();
    await page.evaluate(() => PinCampaigns.step(4));
    await page.waitForTimeout(200);
    await page.locator('.cmp-sopt.main .tsk-btn').click();
    await page.fill('#cmpConfirmN', '1');
    await page.click('#cmpGo');
    await page.waitForFunction(() => /Offers go out only/i.test((document.querySelector('.cmp-modal') || {}).textContent || ''), null, { timeout: 10000 });
    const mk = await text(page, '.cmp-modal');
    ok('a Marketing send at night: “Offers go out only 10 AM–8 PM”, and no “Send anyway”', /Offers go out only 10 AM–8 PM/.test(mk) && await page.locator('.cmp-modal .tsk-btn', { hasText: 'Send anyway' }).count() === 0, mk);
    ok('…nothing sent', sendsTo(srv).length === 8);
    await shot(page, 'offer-at-night');
    await clickText(page, '.cmp-modal .tsk-btn', 'Keep them waiting');
    await page.waitForTimeout(500);
    ok('…“Keep them waiting” opens the campaign with them waiting', /Send the 1 waiting/.test(await text(page, '#campaignsView')));
    // Stop: says what it is doing.
    srv.quietFn = null; srv.delay = 120;
    await toAt(page, 'site_visit_unavailable_update');
    await page.evaluate(() => PinCampaigns.wiz('onlyManual', true));
    await page.fill('.cmp-manual', Array.from({ length: 30 }, (_, i) => `98451${40000 + i}, Buyer ${i}`).join('\n'));
    await page.locator('.tsk-btn', { hasText: 'Add to the list' }).click();
    await page.evaluate(() => PinCampaigns.step(4));
    await page.waitForTimeout(200);
    await page.locator('.cmp-sopt.main .tsk-btn').click();
    await page.fill('#cmpConfirmN', '30');
    await page.click('#cmpGo');
    await page.waitForTimeout(400);
    await page.locator('.cmp-modal .tsk-btn', { hasText: 'Stop' }).click();
    ok('Stop says “Stopping after the current few…” at once', /Stopping after the current few/.test(await text(page, '.cmp-modal')) && await page.isDisabled('.cmp-modal .cmp-mfoot .tsk-btn'));
    await page.waitForFunction(() => /Stopped/.test((document.querySelector('.cmp-modal') || {}).textContent || ''), null, { timeout: 15000 });
    await page.locator('.tsk-btn', { hasText: 'See the campaign' }).click();
    await ctx.close();
  }

  // ── Each lead's own brochure ──
  {
    const srv = server();
    const { page, ctx } = await openPage(browser, { width: 1440, height: 900 }, 'light', { srv });
    await toAt(page, 'brochure_share_v1', 2);
    const s2 = await text(page, '#campaignsView');
    ok('brochure, each lead’s own: no link to paste — each gets their property’s file', !(await page.$('#cmpMedia')) && /brochure of their own property/.test(s2), s2.slice(0, 200));
    ok('…and step 2 shows the message with live values', await page.$('.cmp-livebox .cmp-bubble') !== null);
    await page.evaluate(() => { PinCampaigns.step(3); PinCampaigns.quick('interested'); });
    await page.waitForTimeout(200);
    const rows = await rowsText(page);
    ok('…a lead whose property has no brochure is held: “No brochure for this property”', rows.some(r => /Ravi Kumar.*No brochure for this property/.test(r.t) && !r.on), rows.map(r => r.t.slice(0, 80)));
    ok('…a lead whose property has one is in', rows.some(r => /Suresh/.test(r.t) && r.on));
    await page.evaluate(() => PinCampaigns.step(4));
    await page.waitForTimeout(200);
    ok('…the preview names that person’s file (ANR003.pdf)', /ANR003\.pdf/.test(await text(page, '.cmp-grid2 .cmp-card:nth-child(2)')), await text(page, '.cmp-grid2 .cmp-card:nth-child(2)'));
    const n = await page.evaluate(() => Number(document.querySelector('.cmp-sopt.main .tsk-btn').textContent.match(/\d+/)[0]));
    await page.locator('.cmp-sopt.main .tsk-btn').click();
    await page.fill('#cmpConfirmN', String(n));
    await page.click('#cmpGo');
    await page.waitForFunction(() => /See the campaign/.test(document.body.textContent), null, { timeout: 10000 });
    const sent = sendsTo(srv);
    ok('…each message carries its own property’s brochure', sent.length === n && sent.every(s => /drive\.google\.com\/uc\?export=download&id=1AbCdEfGhIjKlMnOp/.test(s.body.header_media_url || '')), sent.map(s => s.body.header_media_url));
    const cr = creates(srv)[0];
    ok('…and the page asks for it named by the code', cr.recipients.every(r => r.headerMediaName === 'ANR003.pdf') && cr.headerMediaUrl === null, cr.recipients.map(r => r.headerMediaName));
    await page.locator('.tsk-btn', { hasText: 'See the campaign' }).click();
    // One property for everyone: the single link, named by its code.
    await toAt(page, 'brochure_share_v1', 2);
    await page.evaluate(() => { PinCampaigns.wiz('propertyMode', 'one'); });
    await page.waitForTimeout(400);
    await page.evaluate(() => PinCampaigns.wiz('propertyId', 'ANR003'));
    await page.waitForTimeout(400);
    ok('one property: picking it fills its brochure', /1AbCdEfGhIjKlMnOp/.test(await page.inputValue('#cmpMedia')));
    await page.evaluate(() => { PinCampaigns.step(3); PinCampaigns.quick('interested'); PinCampaigns.step(4); });
    await page.waitForTimeout(200);
    const t0 = sendsTo(srv).length;
    await page.locator('.tsk-btn', { hasText: 'Send a test to' }).click();
    await page.waitForTimeout(500);
    ok('…a test carries the file and its name', sendsTo(srv)[t0] && /1AbCdEfGhIjKlMnOp/.test(sendsTo(srv)[t0].body.header_media_url) && srv.ops.filter(o => o.op === 'test-send').slice(-1)[0].headerMediaName === 'ANR003.pdf', srv.ops.filter(o => o.op === 'test-send').slice(-1)[0]);
    await ctx.close();
  }

  // ── Numbered variables, a typed number that is a lead, every hold ──
  {
    const srv = server();
    const { page, ctx } = await openPage(browser, { width: 1440, height: 900 }, 'light', { srv });
    await toAt(page, 'visit_reminder_positional', 2);
    const maps = await page.evaluate(() => [...document.querySelectorAll('.cmp-map')].map(m => m.querySelector('code').textContent + '=' + m.querySelector('select').value));
    ok('numbered variables are read from the words around them: {{1}} name, {{2}} property, {{3}} date', JSON.stringify(maps) === '["{{1}}=lead_name","{{2}}=property","{{3}}=visit_date"]', maps);
    ok('…each labelled with those words', /visit to \{\{2\}\} on/.test(await text(page, '.cmp-maps')), await text(page, '.cmp-maps'));
    ok('…never “does not mention a property” when it does', !/does not mention a property/.test(await text(page, '#campaignsView')));
    ok('…the source’s hint is shown', /property’s name from the inventory/.test(await text(page, '.cmp-maps')));
    await shot(page, 'positional-step2');
    // A Marketing template: numbers typed in that are CRM leads are those leads, with their holds.
    await toAt(page, 'property_requirement_followup');
    await page.evaluate(() => PinCampaigns.quick('tomorrow'));
    await page.fill('.cmp-manual', '98400 18018, Nikhil again\n98400 10101, Recently again\n98400 13013, Omar again\n98450 60001, Brand New');
    await page.locator('.tsk-btn', { hasText: 'Add to the list' }).click();
    await page.waitForTimeout(200);
    const rows = await rowsText(page);
    ok('a typed number of a Negotiating lead is that lead, held for it', rows.some(r => /Nikhil Negotiating.*added by hand.*Negotiating — no Marketing messages/.test(r.t) && !r.on), rows.map(r => r.t.slice(0, 100)));
    ok('…of a lead messaged recently, held for it', rows.some(r => /Recently Messaged.*added by hand.*Messaged in the last 7 days/.test(r.t) && !r.on));
    ok('…of a lead who said STOP, held for it', rows.some(r => /Omar Optout.*Asked not to be messaged/.test(r.t) && !r.on));
    ok('…a new number stays a contact typed in', rows.some(r => /Brand New.*added by hand/.test(r.t) && r.on));
    await page.evaluate(() => PinCampaigns.step(4));
    await page.locator('.cmp-sopt.main .tsk-btn').click();
    const cr0 = creates(srv).length;
    await page.evaluate(() => PinCampaigns.closeModal());
    // The lead page flips Suresh to "no offers" — the page knows before the snapshot does.
    await page.evaluate(() => { const o = window.crmLeadOptOut; window.crmLeadOptOut = id => id === 'L5' ? { all: false, marketing: true } : o(id); });
    await toAt(page, 'property_requirement_followup');
    await page.evaluate(() => PinCampaigns.quick('soldout'));
    await page.waitForTimeout(200);
    ok('a lead just switched to “no offers” is held from a Marketing template: “Asked to stop offers”', (await rowsText(page)).some(r => /Suresh.*Asked to stop offers/.test(r.t) && !r.on), (await rowsText(page)).map(r => r.t.slice(0, 90)));
    await toAt(page, 'site_visit_unavailable_update');
    await page.evaluate(() => PinCampaigns.quick('soldout'));
    await page.waitForTimeout(200);
    ok('…but not from a Utility one', (await rowsText(page)).some(r => /Suresh/.test(r.t) && r.on));
    await ctx.close();
  }

  // ── CSV in: quotes, headers, duplicates; this tool’s own CSV back in ──
  {
    const { page, ctx } = await openPage(browser, { width: 1440, height: 900 }, 'light');
    await toAt(page, 'post_visit_feedback');
    await page.evaluate(() => PinCampaigns.wiz('onlyManual', true));
    const up = async (name, body) => { await page.evaluate(() => PinCampaigns.clearManual()); await page.setInputFiles('#campaignsView label.tsk-btn input[type=file]', { name, mimeType: 'text/csv', buffer: Buffer.from(body) }); await page.waitForTimeout(400); return { rows: await rowsText(page), note: await text(page, '.cmp-addnote') }; };
    let r = await up('quoted.csv', '﻿\n\nName,Mobile,Property Code\r\n"Kumar, Ravi","+91 98400 70003",VLCA002\r\n"Sharma ""Raj""",98400-70004,MADA0001\r\n');
    ok('CSV: header after blank lines, columns by name, “Kumar, Ravi” one name, escaped quotes', r.rows.some(x => /Kumar, Ravi.*\+91 98400 70003.*VLCA002/.test(x.t)) && r.rows.some(x => /Sharma "Raj".*MADA0001/.test(x.t)), r.rows.map(x => x.t.slice(0, 70)));
    r = await up('dupes.csv', 'contact,name\n9840070005,Dup One\n+919840070005,Dup Two\n09840070005,Dup Three\n12345,Short\n0091 98400 70007,Zero zero\n+91 098400 70008,Plus zero\n9.18E+11,Excel\n');
    ok('CSV: “N added · N duplicates skipped · N without a valid number”', /^3 added · 2 duplicates skipped · 2 without a valid number$/.test(r.note), r.note);
    r = await up('semi.csv', 'phone;name;code\n9840070011;Semi;anr003\n');
    ok('CSV: semicolons, and the code read case-blind', r.rows.some(x => /Semi.*ANR003/.test(x.t)), r.rows.map(x => x.t.slice(0, 60)));
    await up('again.csv', 'contact,name\n9840070099,Again\n');
    r = await up('again.csv', 'contact,name\n9840070099,Again\n');
    ok('CSV: the same file picked twice loads twice', r.rows.length === 1, r.rows.length);
    // This tool's own results CSV goes back in.
    const own = 'contact,name,status,reply,meaning,error,sent at\r\n919840070031,"Kumar, Anand",sent,"Yes, call me",Asked for a call,,"5 Nov 2026, 11:00 am"\r\n919840070032,Meera,failed,,,undeliverable,\r\n';
    r = await up('own.csv', own);
    ok('CSV: this tool’s own report goes back in, two contacts', r.rows.length === 2 && r.rows.some(x => /Kumar, Anand/.test(x.t)), r.rows.map(x => x.t.slice(0, 60)));
    ok('“Upload CSV” is a button to a screen reader', await page.evaluate(() => { const l = [...document.querySelectorAll('label.tsk-btn')].find(x => /Upload CSV/.test(x.textContent)); return l && l.getAttribute('role') === 'button' && l.tabIndex === 0; }));
    await ctx.close();
  }

  // ── Retry the failed: leads as leads, never the ones WhatsApp says not to retry ──
  {
    const srv = server();
    await srv.db.collection('campaigns').doc('fails').set({ ...SEED_FB, name: 'Failing one', createdAt: NOW - DAY, template: 'site_visit_unavailable_update', vars: [], mapping: {},
      recipients: {
        L4: { contact: '919840044444', name: 'Meena', values: {}, status: 'failed', manual: false, error: '(#131026) Message undeliverable', errorCode: '131026', sentAt: NOW - DAY },
        L2: { contact: '919840022222', name: 'Anitha', values: {}, status: 'failed', manual: false, error: '(#131050) User stopped marketing messages', sentAt: NOW - DAY },
        L5: { contact: '919840055555', name: 'Suresh', values: {}, status: 'failed', manual: false, error: 'rate', errorCode: '131049', sentAt: NOW - DAY },
        m_919845099001: { contact: '919845099001', name: 'Typed', values: {}, status: 'failed', manual: true, error: 'undeliverable', sentAt: NOW - DAY },
        m_919840013013: { contact: '919840013013', name: 'Omar by number', values: {}, status: 'failed', manual: true, error: 'undeliverable', sentAt: NOW - DAY },
        L1: { contact: '919840011111', name: 'Ravi', values: {}, status: 'sending', uncertain: true, manual: false, error: 'TailorTalk did not answer — check before resending', sentAt: NOW - DAY }
      },
      counts: { total: 6, ready: 0, sending: 1, sent: 0, delivered: 0, read: 0, replied: 0, failed: 5, cancelled: 0, exported: 0 } });
    const { page, ctx } = await openPage(browser, { width: 1440, height: 900 }, 'light', { srv });
    await page.evaluate(() => PinCampaigns.openCampaign('fails'));
    await page.waitForFunction(() => /Failing one/.test(document.getElementById('campaignsView').textContent), null, { timeout: 5000 });
    await page.waitForTimeout(300);
    ok('a send nobody heard back from has its own chip: Unknown 1', /Unknown\s*1/.test(await text(page, '.cmp-chips')), await text(page, '.cmp-chips'));
    await clickText(page, '.cmp-chip', 'Unknown');
    await clickText(page, '.cmp-resolve .tsk-btn', 'Mark as sent');
    await page.waitForTimeout(500);
    ok('…“Mark as sent” settles it on the server', srv.ops.some(o => o.op === 'resolve' && o.key === 'L1' && o.status === 'sent') && (srv.db._get('campaigns/fails').recipients.L1 || {}).status === 'sent', srv.db._get('campaigns/fails').recipients.L1);
    const dl = [];
    page.on('download', d => dl.push(d));
    await clickText(page, '.tsk-btn', 'Results CSV');
    await clickText(page, '.tsk-btn', 'TailorTalk upload CSV');
    await page.waitForTimeout(600);
    const csvs = await Promise.all(dl.map(async d => readFileSync(await d.path(), 'utf8').replace(/^﻿/, '')));
    ok('detail: a results report (contact, name, status, reply, error, sent at)', /^contact,name,status,reply,meaning,error,sent at\r\n/.test(csvs[0] || '') && /919840044444,Meena,failed,,,\(#131026\) Message undeliverable/.test(csvs[0] || ''), (csvs[0] || '').slice(0, 300));
    ok('…and a separate TailorTalk upload CSV', /^contact\r\n/.test(csvs[1] || '') && dl[1] && /tailortalk/.test(dl[1].suggestedFilename()), [csvs[1], dl[1] && dl[1].suggestedFilename()]);
    await clickText(page, '.tsk-btn', 'Retry the failed');
    const rows = await rowsText(page);
    ok('retry: Meena as the CRM lead, the typed number as typed — not 131050 / 131049', rows.length === 3 && rows.some(r => /Meena/.test(r.t) && !/added by hand/.test(r.t)) && rows.some(r => /Typed/.test(r.t)) && !rows.some(r => /Anitha|Suresh/.test(r.t)), rows.map(r => r.t.slice(0, 60)));
    ok('…a typed number that is a lead who said STOP is that lead, still held', rows.some(r => /Omar Optout.*Asked not to be messaged/.test(r.t) && !r.on), rows.map(r => r.t.slice(0, 80)));
    ok('…says what it left out', /Not retried: 1 stopped Marketing messages · 1 WhatsApp asks to wait a week/.test(await toastText(page)), await toastText(page));
    await page.evaluate(() => PinCampaigns.step(4));
    await page.locator('.cmp-sopt.main .tsk-btn').click();
    await page.fill('#cmpConfirmN', '2');
    await page.click('#cmpGo');
    await page.waitForFunction(() => /See the campaign/.test(document.body.textContent), null, { timeout: 10000 });
    const retry = creates(srv).slice(-1)[0];
    ok('…the retry keeps the lead link (leadId)', retry.recipients.some(r => r.leadId === 'L4') && retry.recipients.some(r => r.leadId === null && r.contact === '919845099001'), retry.recipients);
    await ctx.close();
  }

  // ── A big campaign: 700 people on the detail; more than 1,000 in the wizard ──
  {
    const srv = server();
    const rec = {};
    for (let i = 0; i < 700; i++) rec['m_9198451' + String(10000 + i)] = { contact: '9198451' + String(10000 + i), name: 'Person ' + i, values: {}, status: 'read', manual: true, sentAt: NOW - 3600000 };
    await srv.db.collection('campaigns').doc('big').set({ ...SEED_FB, name: 'Big one', recipients: rec, createdAt: NOW - 3600000, statusCheckedAt: NOW, counts: { total: 700, sent: 700, delivered: 700, read: 700, replied: 0, failed: 0, ready: 0, sending: 0, cancelled: 0, exported: 0 } });
    const { page, ctx } = await openPage(browser, { width: 1440, height: 900 }, 'light', { srv });
    await page.evaluate(() => PinCampaigns.openCampaign('big'));
    await page.waitForFunction(() => document.querySelectorAll('#campaignsView .cmp-r').length > 0, null, { timeout: 8000 });
    ok('700 on a campaign: 500 shown, “500 of 700 shown”', await page.evaluate(() => document.querySelectorAll('#campaignsView .cmp-r').length === 500) && /500 of 700 shown/.test(await text(page, '.cmp-more')));
    await clickText(page, '.cmp-more .tsk-btn', 'Show 200 more');
    ok('…“Show more” brings the rest', await page.evaluate(() => document.querySelectorAll('#campaignsView .cmp-r').length === 700));
    await toAt(page, 'site_visit_unavailable_update');
    await page.evaluate(() => PinCampaigns.wiz('onlyManual', true));
    await page.fill('.cmp-manual', Array.from({ length: 1001 }, (_, i) => `9${String(845200000 + i)}, P${i}`).join('\n'));
    await page.locator('.tsk-btn', { hasText: 'Add to the list' }).click();
    await page.waitForTimeout(400);
    ok('more than 1,000: “Review & send” and step 4 are off', await page.isDisabled('.cmp-wnav .tsk-btn.primary') && await page.evaluate(() => document.querySelectorAll('.cmp-stepper button')[3].disabled));
    await clickText(page, '.cmp-wnav .cmp-link', 'Send to the first 1,000');
    ok('…“Send to the first 1,000” ticks exactly 1,000', /^1000 will get it$/.test(await text(page, '#cmpWillGet')) && !(await page.isDisabled('.cmp-wnav .tsk-btn.primary')), await text(page, '#cmpWillGet'));
    await ctx.close();
  }

  // ── Settings: the field that is wrong, lines that are not numbers, the list as loaded ──
  {
    const srv = server();
    const { page, ctx } = await openPage(browser, { width: 1440, height: 900 }, 'light', { srv });
    await page.focus('.cmp-gear'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
    await page.fill('#cmpSetTest', '12345');
    await clickText(page, '.cmp-mfoot .tsk-btn', 'Save');
    ok('a bad test number is marked on its field, the dialog stays', await page.evaluate(() => { const e = document.getElementById('cmpSetTest'); return e && e.getAttribute('aria-invalid') === 'true' && /not a WhatsApp number/.test(document.getElementById('cmpErr_test').textContent) && document.activeElement === e; }));
    await page.fill('#cmpSetTest', '+91 99418 80088');
    await page.fill('#cmpSetUtil', '');
    await clickText(page, '.cmp-mfoot .tsk-btn', 'Save');
    ok('an empty rate is refused on its field (not saved as ₹0)', await page.evaluate(() => document.getElementById('cmpSetUtil').getAttribute('aria-invalid') === 'true') && (await srv.handle({ op: 'settings' })).settings.utilityRate === 0.12);
    await page.fill('#cmpSetUtil', '0.12');
    await page.selectOption('#cmpSetQs', '9');
    ok('From = Until is warned about at once', /same hour — that would switch quiet hours off/.test(await text(page, '.cmp-modal')));
    await page.selectOption('#cmpSetQs', '21');
    // A STOP reply lands while the dialog is open; then a line that is not a number is saved.
    await srv.handle({ op: 'settings', save: true, addOptOut: '9840088881' });
    await page.fill('#cmpSetOpt', '98400 66666\nabc\n98400 77777');
    await clickText(page, '.cmp-mfoot .tsk-btn', 'Save');
    await page.waitForTimeout(400);
    const st = (await srv.handle({ op: 'settings' })).settings;
    ok('saved with the list as loaded (optOutWas), so the STOP that came in meanwhile is kept', srv.ops.filter(o => o.op === 'settings' && o.save).slice(-1)[0].optOutWas.length === 1 && st.optOut.includes('919840088881') && st.optOut.includes('919840077777'), st.optOut);
    ok('…the line that is not a number is named, the dialog left open', /left out: abc/.test(await text(page, '.cmp-modal')), await text(page, '.cmp-modal'));
    // The server's own field refusal is shown on its field.
    await page.evaluate(() => { PinCampaigns.setField('mkt', '60'); });
    await page.evaluate(() => PinCampaigns.saveSettings());
    await page.waitForTimeout(200);
    ok('the client refuses ₹60 on the Marketing field', await page.evaluate(() => document.getElementById('cmpSetMkt').getAttribute('aria-invalid') === 'true'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    ok('Esc closes settings and the focus goes back to the gear', await page.evaluate(() => !document.querySelector('.cmp-modal') && document.activeElement && document.activeElement.classList.contains('cmp-gear')));
    await ctx.close();
  }

  // ── Back, reload, dialogs, focus ──
  {
    const { page, ctx, srv } = await openPage(browser, { width: 1440, height: 900 }, 'light');
    const h0 = await page.evaluate(() => history.length);
    await clickText(page, '.cmp-tab', 'Templates');
    await clickText(page, '.cmp-tab', 'Campaigns');
    ok('each screen is a history entry with its own address', (await page.evaluate(() => history.length)) - h0 === 2 && /#cmp-history$/.test(page.url()), [await page.evaluate(() => history.length) - h0, page.url()]);
    await page.goBack(); await page.waitForTimeout(300);
    ok('Back returns to Templates', await page.evaluate(() => currentView === 'cmp-templates'));
    await page.goBack(); await page.waitForTimeout(300);
    ok('…and again to the dashboard', await page.evaluate(() => currentView === 'campaigns'));
    await page.goForward(); await page.waitForTimeout(300);
    ok('Forward works too', await page.evaluate(() => currentView === 'cmp-templates'));
    // The wizard: a step each, kept through a reload.
    await clickText(page, '.cmp-tab', 'New campaign');
    await page.locator('.cmp-tcard.pick', { hasText: 'post_visit_feedback' }).click();
    await page.locator('.cmp-wnav .tsk-btn.primary').focus(); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
    ok('“Next” puts the focus on the step’s heading', (await focusIs(page)) === 'cmpStepH' && /Step 2 of 4/.test(await text(page, '#cmpStepH')));
    await page.evaluate(() => PinCampaigns.step(3)); await page.waitForTimeout(200);
    await page.evaluate(() => PinCampaigns.quick('visited')); await page.waitForTimeout(200);
    // Edit a value, Tab: the next box has the focus, the row is redrawn in place.
    const v0 = page.locator('.cmp-r', { hasText: 'Anitha' }).locator('.cmp-rvals input').first();
    await v0.click(); await v0.fill('Anitha Madam');
    await page.keyboard.press('Tab'); await page.waitForTimeout(250);
    ok('a value edited, then Tab: focus on the next box of that row', await page.evaluate(() => { const a = document.activeElement; return a && a.dataset && a.dataset.rv === 'property_name' && /Anitha/.test(a.closest('.cmp-r').textContent); }), await focusIs(page));
    // Ticked by keyboard: the focus stays on the box.
    await page.locator('.cmp-r', { hasText: 'Anitha' }).locator('input[type=checkbox]').focus();
    await page.keyboard.press('Space'); await page.waitForTimeout(200);
    ok('a tick by keyboard keeps the focus on its box', await page.evaluate(() => document.activeElement && document.activeElement.type === 'checkbox' && /Anitha/.test(document.activeElement.closest('.cmp-r').textContent)));
    ok('the wizard step has its address', /#cmp-new\/3$/.test(page.url()), page.url());
    await page.reload();
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
    await page.waitForFunction(() => document.getElementById('cmpWillGet'), null, { timeout: 10000 });
    ok('a reload comes back to step 3 of the same campaign, the edit kept', await page.evaluate(() => currentView === 'cmp-new' && /Step 3 of 4/.test(document.getElementById('cmpStepH').textContent) && [...document.querySelectorAll('.cmp-rvals input')].some(i => i.value === 'Anitha Madam')));
    await page.goBack(); await page.waitForTimeout(300);
    ok('Back from step 3 is step 2', /Step 2 of 4/.test(await text(page, '#cmpStepH')));
    // A dialog: Back closes it, Tab stays inside it, the opener gets the focus back.
    await page.focus('.cmp-gear'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
    for (let i = 0; i < 20; i++) await page.keyboard.press('Tab');
    ok('Tab stays inside the dialog', await page.evaluate(() => !!document.activeElement.closest('.cmp-mbox')));
    await page.goBack(); await page.waitForTimeout(400);
    ok('the phone’s Back closes the dialog, the screen stays', await page.evaluate(() => !document.querySelector('.cmp-modal') && currentView === 'cmp-new'), page.url());
    ok('…and the focus is back on the button that opened it', await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('cmp-gear')));
    // A campaign's own address, reloaded.
    await page.evaluate(() => PinCampaigns.openCampaign('seed_fb'));
    await page.waitForFunction(() => /What it led to/.test(document.getElementById('campaignsView').textContent), null, { timeout: 5000 });
    await page.reload();
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
    await page.waitForFunction(() => /What it led to/.test((document.getElementById('campaignsView') || {}).textContent || ''), null, { timeout: 10000 }).catch(() => {});
    ok('#cmp/<id> reloaded opens that campaign', /Feedback — last week/.test(await text(page, '#campaignsView')), page.url());
    ok('the campaign shows positive replies and what one cost', /Positive replies/.test(await text(page, '.cmp-kpis')) && /Cost per positive reply/.test(await text(page, '.cmp-kpis')), await text(page, '.cmp-kpis'));
    // The editor asks before throwing typing away.
    await page.evaluate(() => PinCampaigns.newTemplate()); await page.waitForTimeout(200);
    await page.fill('#cmpBody', 'Something typed');
    page.__dialogs.length = 0;
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    ok('closing an edited template asks first', page.__dialogs.some(m => /Discard your changes/.test(m)), page.__dialogs);
    // Leaving Campaigns: the address stops naming it.
    await page.evaluate(() => toggleView('kanban')); await page.waitForTimeout(300);
    ok('leaving Campaigns clears its address', !/#cmp|#campaigns/.test(page.url()), page.url());
    await ctx.close();
  }

  // ── Copy & open TailorTalk with the clipboard refused ──
  {
    const srv = server();
    await srv.handle({ op: 'save-template', name: 'draft_one_v1', body: 'Hi {{name}}, thank you for your enquiry with us. We will call you shortly.', header: '', footer: '- 3PIN Realty', buttons: [], category: 'UTILITY' });
    const { page, ctx } = await openPage(browser, { width: 1440, height: 900 }, 'light', { srv, clipboard: false });
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true }); });
    await page.evaluate(() => PinCampaigns.go('cmp-templates')); await page.waitForTimeout(300);
    ok('template filter chips say which is on (aria-pressed)', await page.evaluate(() => [...document.querySelectorAll('.cmp-fbar2 .cmp-chip')].every(c => c.getAttribute('aria-pressed') === String(c.classList.contains('on')))));
    await page.locator('.cmp-tcard', { hasText: 'draft_one_v1' }).locator('.tsk-btn', { hasText: 'Copy & open' }).click(); await page.waitForTimeout(400);
    const m = await page.evaluate(() => { const d = document.querySelector('.cmp-modal'); return d && { role: d.getAttribute('role'), labelled: !!document.getElementById(d.getAttribute('aria-labelledby') || '-'), x: d.querySelector('.cmp-x').getAttribute('aria-label'), focus: !!document.activeElement.closest('.cmp-modal') }; });
    ok('clipboard refused: a real dialog (role, title, labelled ×, focus inside)', m && m.role === 'dialog' && m.labelled && m.x === 'Close' && m.focus, m);
    ok('…not marked submitted yet', !srv.ops.some(o => o.op === 'mark-submitted'));
    await clickText(page, '.cmp-modal .tsk-btn', 'submitted it in TailorTalk');
    await page.waitForTimeout(500);
    ok('…marked once the person says it is in', srv.ops.some(o => o.op === 'mark-submitted' && o.name === 'draft_one_v1'));
    await ctx.close();
  }

  // ── Journeys: free in the chat, a call list, campaign.journey ──
  {
    const leads = JSON.parse(JSON.stringify(LEADS));
    // Meena (visit tomorrow) wrote to us an hour ago: her reminder is free in the chat.
    leads.find(l => l.id === 'L4').tt.lastMessageAt = NOW - 3600000;
    const srv = server();
    const { page, ctx } = await openPage(browser, { width: 1440, height: 900 }, 'light', { srv, leads });
    const rm = card(page, 'visit tomorrow');
    const rmt = await rm.textContent();
    ok('a lead who wrote in the last 24 h: “Free now — reply in chat”, a WhatsApp link — no paid send', /Free now — reply in chat/.test(rmt) && await rm.locator('a[href="https://wa.me/919840044444"]').count() === 1 && await rm.locator('.tsk-btn', { hasText: 'Review & send' }).count() === 0, rmt);
    const fb = card(page, 'no feedback asked');
    await fb.locator('.tsk-btn', { hasText: 'Review & send' }).click();
    await page.waitForTimeout(300);
    await page.evaluate(() => PinCampaigns.step(4)); await page.waitForTimeout(200);
    const n = await page.evaluate(() => Number(document.querySelector('.cmp-sopt.main .tsk-btn').textContent.match(/\d+/)[0]));
    await page.locator('.cmp-sopt.main .tsk-btn').click();
    await page.fill('#cmpConfirmN', String(n));
    await page.click('#cmpGo');
    await page.waitForFunction(() => /See the campaign/.test(document.body.textContent), null, { timeout: 10000 });
    ok('a campaign from a journey records which journey (campaign.journey)', creates(srv)[0].journey === 'visit_feedback', creates(srv)[0].journey);
    await page.locator('.tsk-btn', { hasText: 'See the campaign' }).click();
    await ctx.close();
  }

  // ── Phone: the filters fold away, the count and “Review & send” stay in reach ──
  for (const scheme of ['light', 'dark']) {
    const { page, ctx } = await openPage(browser, { width: 390, height: 844 }, scheme);
    await toAt(page, 'post_visit_feedback');
    await page.waitForTimeout(200);
    ok(`phone ${scheme}: step 3 filters folded behind “Filters”`, await page.evaluate(() => { const d = document.querySelector('.cmp-fdet'); return d && !d.open && /Filters/.test(d.querySelector('summary').textContent); }));
    const foot = await page.evaluate(() => { const w = document.querySelector('.cmp-wnav.sticky'); const r = w.getBoundingClientRect(); return { pos: getComputedStyle(w).position, inView: r.bottom <= innerHeight + 1 && r.top < innerHeight, text: w.textContent }; });
    ok(`phone ${scheme}: a sticky footer “N will get it · Review & send” in view`, foot.pos === 'sticky' && foot.inView && /will get it/.test(foot.text) && /Review & send/.test(foot.text), foot);
    ok(`phone ${scheme}: step 3 no sideways scroll`, (await overflow(page)) === 0, await overflow(page));
    await page.screenshot({ path: join(OUT, 'campaign-step3-sticky-' + scheme + '.png') });
    await page.evaluate(() => PinCampaigns.step(2)); await page.waitForTimeout(200);
    ok(`phone ${scheme}: step 2 no sideways scroll`, (await overflow(page)) === 0, await overflow(page));
    // The property dropdown wears the search box (it never did: the select was marked before
    // attach(), which then skipped it) and lists the inventory.
    ok(`phone ${scheme}: step 2 has the property search box over the inventory`, await page.evaluate(() =>
      !!document.getElementById('cmpPropSelSearch') && document.getElementById('cmpPropSel').options.length > 1));
    await shot(page, 'step2-phone-' + scheme);
    await page.evaluate(() => PinCampaigns.openSettings()); await page.waitForTimeout(200);
    await page.fill('#cmpSetTest', '1'); await clickText(page, '.cmp-mfoot .tsk-btn', 'Save');
    ok(`phone ${scheme}: a field error fits`, (await overflow(page)) === 0);
    await page.screenshot({ path: join(OUT, 'campaign-settings-error-' + scheme + '.png') });
    await ctx.close();
  }
}

// ═══ 2. Phone, light and dark; laptop dark ═══
for (const [vp, scheme, name] of [[{ width: 390, height: 844 }, 'light', 'phone'], [{ width: 390, height: 844 }, 'dark', 'phone-dark'], [{ width: 1440, height: 900 }, 'dark', 'laptop-dark']]) {
  console.log('\n' + name);
  const phone = vp.width < 500;
  const { page, ctx } = await openPage(browser, vp, scheme);
  ok(name + ': dashboard no sideways scroll', (await overflow(page)) === 0, await overflow(page));
  const grid = await page.evaluate(() => { const g = document.querySelector('#campaignsView .cmp-kpis'); return { n: g.children.length, cols: getComputedStyle(g).gridTemplateColumns.split(' ').length }; });
  ok(name + ': the KPI tiles fill their rows (no tile left alone)', grid.n % grid.cols === 0, grid);
  const tabs = await page.evaluate(() => [...document.querySelectorAll('#campaignsView .cmp-tab')].map(t => Math.round(t.getBoundingClientRect().right)));
  ok(name + ': every tab in view, none cut off', tabs.every(r => r <= vp.width - 8), tabs);
  if (phone) ok(name + ': the CRM’s “+ Add lead” button is not over the Campaigns screen', await page.evaluate(() => getComputedStyle(document.querySelector('.mobile-fab')).display === 'none'));
  for (const sel of ['.cmp-tab.on', '.cmp-tab:not(.on)', '.cmp-kpi span', '.cmp-kpi small', '.cmp-need b', '.cmp-need > div > span', '.cmp-res', '.cmp-muted', '.cmp-note', '.cmp-warn', '.cmp-cat', '.cmp-pill.s-ok', '.cmp-pill.s-bad']) {
    const c = await contrastOf(page, '#campaignsView ' + sel);
    ok(`${name}: ${sel} text contrast ≥ 4.5`, c === null || c >= 4.5, c);
  }
  await shot(page, 'dashboard-' + name);
  for (const [tab, label] of [['cmp-templates', 'templates'], ['cmp-new', 'new'], ['cmp-history', 'history']]) {
    await page.evaluate(v => PinCampaigns.go(v), tab);
    await page.waitForTimeout(300);
    ok(`${name}: ${label} no sideways scroll`, (await overflow(page)) === 0, await overflow(page));
  }
  await shot(page, 'history-' + name);
  await page.evaluate(() => PinCampaigns.openReplies());
  await page.waitForTimeout(200);
  ok(name + ': replies dialog fits', (await overflow(page)) === 0);
  await page.screenshot({ path: join(OUT, 'campaign-replies-' + name + '.png') });
  await page.evaluate(() => PinCampaigns.closeModal());
  await page.evaluate(() => PinCampaigns.preset('sold_out', 'ANR003'));
  await page.waitForTimeout(300);
  await page.evaluate(() => PinCampaigns.quick('soldout'));
  await page.waitForTimeout(200);
  ok(name + ': step 3 no sideways scroll', (await overflow(page)) === 0, await overflow(page));
  await shot(page, 'who-' + name);
  await page.evaluate(() => PinCampaigns.step(4));
  await page.waitForTimeout(200);
  ok(name + ': review no sideways scroll', (await overflow(page)) === 0, await overflow(page));
  await shot(page, 'review-' + name);
  await page.evaluate(() => PinCampaigns.openCampaign('seed_fb'));
  await page.waitForFunction(() => /What it led to/.test(document.getElementById('campaignsView').textContent), null, { timeout: 5000 });
  ok(name + ': campaign detail no sideways scroll', (await overflow(page)) === 0, await overflow(page));
  const grid2 = await page.evaluate(() => { const g = document.querySelector('#campaignsView .cmp-kpis'); return { n: g.children.length, cols: getComputedStyle(g).gridTemplateColumns.split(' ').length }; });
  ok(name + ': the campaign’s tiles fill their rows too', grid2.n % grid2.cols === 0, grid2);
  for (const sel of ['.cmp-act.a-call', '.cmp-act.a-optout', '.cmp-quote', '.cmp-fl']) {
    const c = await contrastOf(page, '#campaignsView ' + sel);
    ok(`${name}: ${sel} text contrast ≥ 4.5`, c === null || c >= 4.5, c);
  }
  await shot(page, 'outcome-' + name);
  await page.evaluate(() => PinCampaigns.openSettings());
  await page.waitForTimeout(200);
  ok(name + ': settings fit', (await overflow(page)) === 0);
  await page.screenshot({ path: join(OUT, 'campaign-settings-' + name + '.png') });
  await page.evaluate(() => PinCampaigns.closeModal());
  await page.evaluate(() => PinCampaigns.newTemplate());
  await page.waitForTimeout(200);
  ok(name + ': editor fits', (await overflow(page)) === 0, await overflow(page));
  await shot(page, 'editor-' + name);
  const c = await page.evaluate(() => { const b = document.querySelector('.cmp-bubble'); if (!b) return null; const s = getComputedStyle(b); return [s.color, s.backgroundColor]; });
  ok(name + ': the WhatsApp bubble has readable text', c && c[0] !== c[1], c);
  await ctx.close();
}

await browser.close();
console.log('');
if (errors.length) { console.log(errors.length + ' problem(s):'); errors.forEach(e => console.log('  - ' + e)); process.exit(1); }
console.log('All good. Screenshots in tests/out/campaign-*.png');
