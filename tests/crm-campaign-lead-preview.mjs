// ═══════ A CAMPAIGN REPLY, FROM THE LEAD'S SIDE ═══════
//
//   node tests/crm-campaign-lead-preview.mjs
//
// The Campaigns screen sends; this is what comes back. A lead who answers a WhatsApp campaign
// has to reach a person — in the bell, on Daily task, on the card and on the lead page — and
// stop reaching them the moment somebody acts on the lead. A lead who asked not to be messaged
// has to say so everywhere a person might be about to message them.
//
// The real CRM page with firebase-sync.js stubbed (as in crm-today-preview.mjs) and the server's
// op 'optout' answered by a stand-in route that records what the page asked for. Laptop and
// phone, light and dark. Screenshots land in tests/out/campaign-lead-*.png.

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPipelineMigration } from '../crm-assets/pipeline.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'tests/out');
mkdirSync(OUT, { recursive: true });
const T = 't_3pinrealty';
const STAGES = planPipelineMigration([{ id: 'new', name: 'New' }, { id: 'site_visit', name: 'Site Visit' }], []).stages;
const sid = k => STAGES.find(s => s.key === k).id;
const NOW = Date.now();
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const ME = 'thirumal@threepin.in';

const SOLD = { campaignId: 'cmp_sold', campaignName: 'Sold out — ANR003', template: 'sold_out_similar' };
const LEADS = [
  // Asked for a call twenty minutes ago. The reply set the follow-up, so it must not ALSO be a
  // second row under Calls due.
  { id: 'C1', tenantId: T, name: 'Kavya Raman', phone: '9840011111', stageId: sid('options'), assignedAgent: ME,
    createdAt: NOW - 30 * DAY, updatedAt: NOW - 2 * DAY, propertyInterest: '3 BHK Anna Nagar', budget: '3 Cr',
    followUpAt: NOW - 20 * MIN, followUpBy: 'campaign', followUpSetAt: NOW - 20 * MIN, followUpNote: 'Asked for a call — Sold out — ANR003',
    campaignReply: { ...SOLD, text: 'Request a Call', action: 'call', at: NOW - 20 * MIN },
    lastCampaignAt: NOW - 3 * HOUR, lastCampaignName: SOLD.campaignName, lastCampaignId: SOLD.campaignId,
    campaignLog: [
      { id: 'cmp_sold', name: SOLD.campaignName, template: SOLD.template, at: NOW - 3 * HOUR, status: 'replied', reply: 'Request a Call', replyAt: NOW - 20 * MIN, action: 'call' },
      { id: 'cmp_launch', name: 'New launch — Madhavaram', template: 'new_launch_v2', at: NOW - 9 * DAY, status: 'sent' },
      { id: 'cmp_diwali', name: 'Diwali offers', template: 'festive_offer', at: NOW - 16 * DAY, status: 'failed' }
    ] },
  // Feedback on a visit, two hours ago.
  { id: 'C2', tenantId: T, name: 'Ravi Kumar', phone: '9840022222', stageId: sid('visit_done'),
    createdAt: NOW - 20 * DAY, updatedAt: NOW - DAY,
    campaignReply: { campaignId: 'cmp_fb', campaignName: 'Visit feedback — 3 Nov', template: 'visit_feedback', text: 'Liked it', action: 'feedback', at: NOW - 2 * HOUR },
    campaignLog: [{ id: 'cmp_fb', name: 'Visit feedback — 3 Nov', template: 'visit_feedback', at: NOW - 5 * HOUR, status: 'replied', reply: 'Liked it', replyAt: NOW - 2 * HOUR, action: 'feedback' }] },
  // Replied STOP. Something to know, not a call to make.
  { id: 'C3', tenantId: T, name: 'Opted Person', phone: '9840033333', stageId: sid('new'),
    createdAt: NOW - 40 * DAY, updatedAt: NOW - 10 * DAY,
    waOptOut: true, waOptOutAt: NOW - 4 * HOUR, waOptOutReason: 'replied stop',
    campaignReply: { ...SOLD, text: 'STOP', action: 'optout', at: NOW - 4 * HOUR },
    campaignLog: [{ id: 'cmp_sold', name: SOLD.campaignName, template: SOLD.template, at: NOW - 5 * HOUR, status: 'replied', reply: 'STOP', replyAt: NOW - 4 * HOUR, action: 'optout' }] },
  // Replied, and somebody has worked the lead since: closed everywhere.
  { id: 'C4', tenantId: T, name: 'Handled Hari', phone: '9840044444', stageId: sid('options'),
    createdAt: NOW - 40 * DAY, updatedAt: NOW - HOUR, updatedBy: 'swami@threepin.in',
    campaignReply: { ...SOLD, text: 'Share similar options', action: 'options', at: NOW - 5 * HOUR },
    campaignLog: [{ id: 'cmp_sold', name: SOLD.campaignName, template: SOLD.template, at: NOW - 6 * HOUR, status: 'replied', reply: 'Share similar options', replyAt: NOW - 5 * HOUR, action: 'options' }] },
  // Never in a campaign.
  { id: 'C5', tenantId: T, name: 'Plain Priya', phone: '9840055555', stageId: sid('new'), createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY },
  // Kept out by a person, on a call.
  { id: 'C6', tenantId: T, name: 'Suma Iyer', phone: '9840066666', stageId: sid('new'), createdAt: NOW - 8 * DAY, updatedAt: NOW - 2 * DAY,
    waOptOut: true, waOptOutAt: NOW - 2 * DAY, waOptOutReason: 'set by swami@threepin.in' },
  // The newer actions (fix round): a referral, an owner who wants to sell, a loan question.
  { id: 'C7', tenantId: T, name: 'Referral Raghu', phone: '9840077777', stageId: sid('won'), createdAt: NOW - 90 * DAY, updatedAt: NOW - 9 * DAY,
    campaignReply: { campaignId: 'cmp_ref', campaignName: 'Refer a friend', template: 'referral_ask', text: 'Refer someone', action: 'referral', at: NOW - 30 * MIN },
    campaignLog: [{ id: 'cmp_ref', name: 'Refer a friend', template: 'referral_ask', at: NOW - 2 * HOUR, status: 'replied', reply: 'Refer someone', replyAt: NOW - 30 * MIN, action: 'referral' }] },
  { id: 'C8', tenantId: T, name: 'Seller Selvi', phone: '9840088888', stageId: sid('lost'), createdAt: NOW - 60 * DAY, updatedAt: NOW - 9 * DAY,
    campaignReply: { ...SOLD, text: 'I want to sell my flat', action: 'seller', at: NOW - 40 * MIN },
    campaignLog: [{ id: 'cmp_sold', name: SOLD.campaignName, template: SOLD.template, at: NOW - 3 * HOUR, status: 'replied', reply: 'I want to sell my flat', replyAt: NOW - 40 * MIN, action: 'seller' }] },
  { id: 'C9', tenantId: T, name: 'Loan Lakshmi', phone: '9840099999', stageId: sid('options'), createdAt: NOW - 12 * DAY, updatedAt: NOW - 3 * DAY,
    campaignReply: { ...SOLD, text: 'Can you help with loan?', action: 'loan', at: NOW - 50 * MIN },
    campaignLog: [{ id: 'cmp_sold', name: SOLD.campaignName, template: SOLD.template, at: NOW - 3 * HOUR, status: 'replied', reply: 'Can you help with loan?', replyAt: NOW - 50 * MIN, action: 'loan' }] },
  // "Call me after 6": the call is due at the time they named — not late, not urgent, until then.
  { id: 'C10', tenantId: T, name: 'Later Lata', phone: '9840010101', stageId: sid('options'), createdAt: NOW - 12 * DAY, updatedAt: NOW - 3 * DAY,
    followUpAt: NOW + 3 * HOUR, followUpBy: 'campaign', followUpSetAt: NOW - 10 * MIN, followUpNote: 'Asked for a call — Sold out — ANR003',
    campaignReply: { ...SOLD, text: 'call me after 6', action: 'call', at: NOW - 10 * MIN, followUpAt: NOW + 3 * HOUR },
    campaignLog: [{ id: 'cmp_sold', name: SOLD.campaignName, template: SOLD.template, at: NOW - 3 * HOUR, status: 'replied', reply: 'call me after 6', replyAt: NOW - 10 * MIN, action: 'call' }] },
  // "Not this one" — still a buyer, just not for that property. A line to know, nothing to do.
  { id: 'C11', tenantId: T, name: 'Naveen Not-this', phone: '9840012121', stageId: sid('options'), createdAt: NOW - 12 * DAY, updatedAt: NOW - 3 * DAY,
    campaignReply: { ...SOLD, text: 'vendam', action: 'not_this', at: NOW - 70 * MIN, code: 'ANR003' },
    campaignLog: [{ id: 'cmp_sold', name: SOLD.campaignName, template: SOLD.template, at: NOW - 3 * HOUR, status: 'replied', reply: 'vendam', replyAt: NOW - 70 * MIN, action: 'not_this' }] },
  // "Stop offers": no Marketing from now on; visit reminders still go.
  { id: 'C12', tenantId: T, name: 'Meena No-offers', phone: '9840013131', stageId: sid('options'), createdAt: NOW - 12 * DAY, updatedAt: NOW - 3 * DAY,
    waMarketingOptOut: true, waMarketingOptOutAt: NOW - 80 * MIN, waMarketingOptOutReason: 'replied stop offers',
    campaignReply: { ...SOLD, text: 'Stop offers', action: 'marketing_optout', at: NOW - 80 * MIN },
    campaignLog: [{ id: 'cmp_sold', name: SOLD.campaignName, template: SOLD.template, at: NOW - 3 * HOUR, status: 'replied', reply: 'Stop offers', replyAt: NOW - 80 * MIN, action: 'marketing_optout' }] },
  // "Confirmed" to tomorrow's visit reminder: nothing to do — but the visit says it is confirmed.
  { id: 'C13', tenantId: T, name: 'Arun Confirmed', phone: '9840014141', stageId: sid('visit_pending'), createdAt: NOW - 12 * DAY, updatedAt: NOW - 3 * DAY,
    siteVisitAt: NOW + DAY, siteVisitStatus: 'scheduled', siteVisitProperty: 'ANR007', siteVisitSetAt: NOW - 3 * DAY, siteVisitConfirmedAt: NOW - 15 * MIN,
    campaignReply: { campaignId: 'cmp_rem', campaignName: 'Visit reminder — tomorrow', template: 'visit_reminder_v1', text: 'Confirmed', action: 'ack', at: NOW - 15 * MIN },
    campaignLog: [{ id: 'cmp_rem', name: 'Visit reminder — tomorrow', template: 'visit_reminder_v1', at: NOW - HOUR, status: 'replied', reply: 'Confirmed', replyAt: NOW - 15 * MIN, action: 'ack' }] },
  // In Negotiating, "found a property" most likely means OURS.
  { id: 'C14', tenantId: T, name: 'Bala Booked', phone: '9840015151', stageId: sid('negotiation'), createdAt: NOW - 30 * DAY, updatedAt: NOW - 2 * DAY,
    campaignReply: { ...SOLD, text: 'Already booked a flat', action: 'found', at: NOW - 90 * MIN },
    campaignLog: [{ id: 'cmp_sold', name: SOLD.campaignName, template: SOLD.template, at: NOW - 3 * HOUR, status: 'replied', reply: 'Already booked a flat', replyAt: NOW - 90 * MIN, action: 'found' }] }
];

const STUB = `
window.crmFirebase = {
  saveLead: async () => {}, deleteLead: async () => {}, getLeadNotes: async () => [], getLeadHistory: async () => [],
  saveNote: async () => {}, deleteNoteDoc: async () => {}, saveHistory: async () => {}, savePipeline: async () => {},
  getBotConfig: async () => null, saveBotConfig: async () => {}, saveEnquiryTypes: async () => {},
  saveProperties: async () => {}, saveFollowupDigestSettings: async () => {}, saveDashboardEmailSettings: async () => {},
  releaseLeadField: async () => {}, getLeadTailorTalk: async () => null, updateLeadAi: async () => {},
  saveAutomationSettings: async () => {}, saveView: async () => {}, deleteView: async () => {},
  getInventory: async () => []
};
window.crmTodayOpens = { load: async () => ({}), save: async () => {} };
window.crmAuth = { login: async () => {}, logout: async () => {}, getIdToken: async () => 'x', getTenantId: () => '${T}' };
window.onCrmAuthChange({ email: '${ME}' });
window.applyPipelineSnapshot(${JSON.stringify(STAGES)});
window.applyEnquiryTypesSnapshot(['Property Enquiry']);
window.applyAutomationSettingsSnapshot({ enabled: false });
if (window.applyViewsSnapshot) window.applyViewsSnapshot({});
window.applyTeamSnapshot({ thirumal: { email: '${ME}' }, swami: { email: 'swami@threepin.in' } });
window.__LEADS = ${JSON.stringify(LEADS)};
window.applyLeadsSnapshot(JSON.parse(JSON.stringify(window.__LEADS)));
window.__ready = true;
`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const errors = [];
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (detail !== undefined ? ' — ' + detail : '')); errors.push(label); }
};
const wait = ms => new Promise(r => setTimeout(r, ms));

// ── The rule book itself (crm-assets/leadAttention.js), as the morning digest reads it ──
{
  const A = await import('../crm-assets/leadAttention.js');
  const att = (l, now = NOW) => A.computeAttention(l, { stages: STAGES, now });
  const c1 = LEADS.find(l => l.id === 'C1');
  const top = att(c1)[0];
  console.log('');
  console.log('leadAttention.js');
  ok('digest: an open call request is the lead\'s top item, high', top && top.key === 'campaign_reply' && top.severity === 'high'
    && top.label === 'Asked for a call after “Sold out — ANR003”' && top.detail === '“Request a Call”', JSON.stringify(top));
  ok('...and the follow-up it set is not listed again as overdue', !att(c1).some(a => a.key === 'followup_overdue'), JSON.stringify(att(c1).map(a => a.key)));
  ok('...a person touching the lead closes it', !att({ ...c1, updatedAt: NOW }).some(a => a.key === 'campaign_reply'));
  ok('...and then the follow-up is plain overdue again', att({ ...c1, updatedAt: NOW }).some(a => a.key === 'followup_overdue'));
  ok('...a follow-up a PERSON set is still its own item', att({ ...c1, followUpBy: 'swami@threepin.in' }).some(a => a.key === 'followup_overdue'));
  const opt = att(LEADS.find(l => l.id === 'C3')).find(a => a.key === 'campaign_reply');
  ok('an opt-out is informational: medium, not a call', opt && opt.severity === 'medium' && opt.label === 'Wants to stop WhatsApp messages', JSON.stringify(opt));
  const lost = att({ ...c1, stageId: sid('lost'), followUpAt: null, campaignReply: { ...c1.campaignReply, action: 'options', text: 'Share similar options' } });
  ok('a Lost lead answering a re-engagement campaign still reaches a person', lost.some(a => a.key === 'campaign_reply' && /Wants options or details/.test(a.label)), JSON.stringify(lost));
  ok('an action the page does not know reads as a plain reply', att({ ...c1, campaignReply: { ...c1.campaignReply, action: 'zzz', text: 'hmm' } })[0].label === 'Replied to “Sold out — ANR003”');
  const labels = ['call', 'visit', 'options', 'feedback', 'not_now', 'found', 'reschedule', 'optout', 'other']
    .map(k => A.campaignReplyMeta(k).label({ campaignName: 'Visit feedback — 3 Nov', template: 'visit_feedback', text: 'Liked it' }));
  ok('every action has its own plain-English line', new Set(labels).size === labels.length && labels.includes('Replied “Liked it” to visit feedback'), JSON.stringify(labels));

  // ── The fix round's actions ──
  const with_ = (action, extra = {}, lead = c1) => att({ ...lead, followUpAt: null, followUpBy: null, campaignReply: { ...lead.campaignReply, action, ...extra } });
  const item = (action, extra, lead) => with_(action, extra, lead).find(a => a.key === 'campaign_reply');
  ok('"ok" / "thanks" / a visit confirmed: no item at all', !item('ack') && !A.openCampaignReply({ ...c1, campaignReply: { ...c1.campaignReply, action: 'ack' } }));
  const nt = item('not_this', { code: 'ANR003' });
  ok('"not this one": medium, info, "Not interested in … — noted"', nt && nt.severity === 'medium' && nt.info === true && nt.label === 'Not interested in “ANR003” — noted', JSON.stringify(nt));
  ok('...without a code it names the campaign', item('not_this').label === 'Not interested in “Sold out — ANR003” — noted', item('not_this').label);
  const mo = item('marketing_optout');
  ok('"stop offers": info, says visit messages still go', mo && mo.info === true && mo.severity === 'medium' && mo.label === 'Asked to stop offers (visit messages still OK)', JSON.stringify(mo));
  ok('an opt-out is info too', item('optout').info === true && item('optout').label === 'Wants to stop WhatsApp messages');
  ok('a referral: high, "get the name & number"', item('referral').severity === 'high' && item('referral').label === 'Wants to refer someone — get the name & number' && !item('referral').info, JSON.stringify(item('referral')));
  ok('an owner: high, "Wants to sell/list a property"', item('seller').severity === 'high' && item('seller').label === 'Wants to sell/list a property');
  ok('a loan: high, "Needs home-loan help"', item('loan').severity === 'high' && item('loan').label === 'Needs home-loan help');
  ok('an unknown action: a plain reply, needing a person', item('brand_new_thing').label === 'Replied to “Sold out — ANR003”' && item('brand_new_thing').severity === 'high' && !item('brand_new_thing').info);
  const neg = LEADS.find(l => l.id === 'C14');
  ok('"found" in Negotiating: "Says they booked — check if it was with us"', item('found', {}, neg).label === 'Says they booked — check if it was with us', item('found', {}, neg).label);
  ok('...and in Won', item('found', {}, { ...neg, stageId: sid('won') }).label === 'Says they booked — check if it was with us');
  ok('...elsewhere it is still "found a property"', /Says they found a property/.test(item('found').label) && !/mark Lost/.test(item('found').label), item('found').label);
  ok('...the history meaning follows the stage', A.campaignReplyMeta('found', { stageKey: 'negotiation' }).means === 'Says they booked' && A.campaignReplyMeta('found').means === 'Says they found a property');
  const metaLabels = ['referral', 'seller', 'loan', 'not_this', 'marketing_optout', 'ack'].map(k => A.campaignReplyMeta(k).means);
  ok('every new action has its own meaning for the history', new Set(metaLabels).size === metaLabels.length && metaLabels.every(Boolean), JSON.stringify(metaLabels));

  // ── ONE rule for "needs a person" ──
  ok('REPLY_NO_PERSON is exactly ack, optout, marketing_optout, not_this', JSON.stringify([...A.REPLY_NO_PERSON].sort()) === JSON.stringify(['ack', 'marketing_optout', 'not_this', 'optout']), JSON.stringify(A.REPLY_NO_PERSON));
  const needs = k => A.replyNeedsPerson({ ...c1, campaignReply: { ...c1.campaignReply, action: k } });
  ok('replyNeedsPerson: call, visit, options, feedback, not_now, found, reschedule, referral, seller, loan, other, unknown',
    ['call', 'visit', 'options', 'feedback', 'not_now', 'found', 'reschedule', 'referral', 'seller', 'loan', 'other', 'zzz'].every(needs));
  ok('...never ack, optout, marketing_optout, not_this', !['ack', 'optout', 'marketing_optout', 'not_this'].some(needs));
  ok('...and never once a person has acted on the lead', !A.replyNeedsPerson({ ...c1, updatedAt: NOW }));
  const infoOnly = { ...LEADS.find(l => l.id === 'C11'), updatedAt: NOW - 3 * DAY };
  ok('needsAction: a lead whose only item is "not this one" does not need action', !A.needsAction(infoOnly, { stages: STAGES, now: NOW }), JSON.stringify(att(infoOnly)));
  ok('...an opt-out reply does not hide a late follow-up', att({ ...LEADS.find(l => l.id === 'C3'), followUpAt: NOW - HOUR, followUpBy: 'campaign' }).some(a => a.key === 'followup_overdue'));

  // ── A time they named ──
  const lata = LEADS.find(l => l.id === 'C10');
  const la = att(lata).find(a => a.key === 'campaign_reply');
  ok('"call me after 6": the item says "Call at …" and is not urgent until then', la && la.severity === 'medium' && /^Call at .+ · “call me after 6”$/.test(la.detail) && la.at === lata.campaignReply.followUpAt, JSON.stringify(la));
  ok('...and the follow-up it set is not overdue', !att(lata).some(a => a.key === 'followup_overdue'));
  ok('...once the time has come, it is a plain high item again', att(lata, NOW + 4 * HOUR).find(a => a.key === 'campaign_reply').severity === 'high');
  ok('...replyCallAt is the time while it is ahead, null after', A.replyCallAt(lata.campaignReply, NOW) === lata.campaignReply.followUpAt && A.replyCallAt(lata.campaignReply, NOW + 4 * HOUR) === null);
  const at11 = Date.UTC(2026, 10, 5, 6, 0);   // Thu 5 Nov 2026, 11:30 AM in India
  ok('callAtText, in India time: "6 PM today"', A.callAtText(Date.UTC(2026, 10, 5, 12, 30), at11) === '6 PM today', A.callAtText(Date.UTC(2026, 10, 5, 12, 30), at11));
  ok('...: "10:30 AM tomorrow"', A.callAtText(Date.UTC(2026, 10, 6, 5, 0), at11) === '10:30 AM tomorrow', A.callAtText(Date.UTC(2026, 10, 6, 5, 0), at11));
  ok('...: "Sat 5 Dec, 10 AM" a month out', A.callAtText(Date.UTC(2026, 11, 5, 4, 30), at11) === 'Sat 5 Dec, 10 AM', A.callAtText(Date.UTC(2026, 11, 5, 4, 30), at11));
}

const browser = await chromium.launch();
const RUNS = [
  { viewport: { width: 1440, height: 900 }, scheme: 'light', name: 'laptop-light' },
  { viewport: { width: 1440, height: 900 }, scheme: 'dark', name: 'laptop-dark' },
  { viewport: { width: 390, height: 844 }, scheme: 'light', name: 'phone-light' },
  { viewport: { width: 390, height: 844 }, scheme: 'dark', name: 'phone-dark' }
];
for (const run of RUNS) {
  console.log('');
  console.log(run.name);
  const tag = run.name + ':';
  const ctx = await browser.newContext({ viewport: run.viewport, colorScheme: run.scheme });
  const page = await ctx.newPage();
  const optoutCalls = [];
  // You looked at Kavya's reply on Daily task two days ago — well, a reply that was there then.
  await page.addInitScript(([k, t]) => {
    try { localStorage.setItem('pinTodayOpens:thirumal@threepin.in', JSON.stringify({ [k]: [t] })); } catch (e) { /* no storage */ }
  }, ['reply:C2:' + (NOW - 2 * HOUR), NOW - 50 * MIN]);
  page.on('pageerror', e => errors.push(`${tag} pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource|net::ERR/.test(m.text())) return;
    errors.push(`${tag} console: ${m.text()}`);
  });
  page.on('dialog', d => { page.__lastDialog = d.message(); d.dismiss(); });
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'crm.local') return route.abort();
    if (u.pathname === '/crm-assets/firebase-sync.js') return route.fulfill({ contentType: 'text/javascript', body: STUB });
    if (u.pathname.startsWith('/api/')) {
      const body = JSON.parse(route.request().postData() || '{}');
      if (u.searchParams.get('action') === 'campaign' && body.op === 'optout') {
        optoutCalls.push({ body, auth: route.request().headers().authorization || '' });
        return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
      }
      return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    }
    const f = join(ROOT, decodeURIComponent(u.pathname));
    if (!existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: TYPES[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
  });
  await page.goto('http://crm.local/crm.html');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  await page.evaluate(() => toggleView('kanban'));
  await wait(400);

  // ── THE BELL ──
  const bell = await page.evaluate(async () => {
    toggleAlerts();
    await new Promise(r => setTimeout(r, 200));
    const menu = document.getElementById('bellMenu');
    const read = b => b.textContent.replace(/\s+/g, ' ').trim();
    const items = [...menu.querySelectorAll('.bell-item')].map(read);
    const groups = [...menu.querySelectorAll('.bell-grp')].map(g => ({ head: read(g.querySelector('.bell-head')), items: [...g.querySelectorAll('.bell-item')].map(read) }));
    const count = document.getElementById('bellCount').textContent;
    // The same leads with their info replies taken away: the badge must not move.
    const list = JSON.parse(JSON.stringify(window.__LEADS));
    for (const l of list) if (['C3', 'C11', 'C12', 'C13'].includes(l.id)) delete l.campaignReply;
    window.applyLeadsSnapshot(list);
    const without = document.getElementById('bellCount').textContent;
    window.applyLeadsSnapshot(JSON.parse(JSON.stringify(window.__LEADS)));
    return { items, groups, count, without, back: document.getElementById('bellCount').textContent };
  });
  const bellHas = re => bell.items.some(t => re.test(t));
  const needGrp = bell.groups.find(g => /need a person|needs a person/.test(g.head)) || { items: [] };
  const knowGrp = bell.groups.find(g => /Good to know/.test(g.head)) || { items: [] };
  ok('bell: an open call request, in plain words', bellHas(/Asked for a call after “Sold out — ANR003”.*Kavya Raman.*Request a Call/), JSON.stringify(bell.items));
  ok('bell: feedback reads as feedback, with what they said', bellHas(/Replied “Liked it” to visit feedback.*Ravi Kumar/), JSON.stringify(bell.items));
  ok('bell: a referral, an owner, a loan — each in its own words', bellHas(/Wants to refer someone — get the name & number.*Referral Raghu/) && bellHas(/Wants to sell\/list a property.*Seller Selvi/) && bellHas(/Needs home-loan help.*Loan Lakshmi/), JSON.stringify(bell.items));
  ok('bell: "call me after 6" says when', bellHas(/Asked for a call after.*Later Lata.*Call at .*(today|tomorrow)/), JSON.stringify(bell.items.filter(t => /Lata/.test(t))));
  ok('bell: an opt-out, "stop offers" and "not this one" are there to be known — under "Good to know"',
    knowGrp.items.some(t => /Wants to stop WhatsApp messages.*Opted Person.*STOP/.test(t)) && knowGrp.items.some(t => /Asked to stop offers \(visit messages still OK\).*Meena/.test(t))
    && knowGrp.items.some(t => /Not interested in “ANR003” — noted.*Naveen/.test(t)), JSON.stringify(bell.groups));
  ok('...and not among the leads that need a person', !needGrp.items.some(t => /Opted Person|Meena|Naveen/.test(t)), JSON.stringify(needGrp.items));
  ok('...nor in the badge: it does not move when they go', bell.count === bell.without && bell.back === bell.count, `${bell.count} / ${bell.without} / ${bell.back}`);
  ok('bell: an "ok" / visit confirmed is not there at all', !bellHas(/Arun Confirmed.*Confirmed|Said OK/), JSON.stringify(bell.items.filter(t => /Arun/.test(t))));
  ok('bell: "found" in Negotiating reads "Says they booked"', bellHas(/Says they booked — check if it was with us.*Bala Booked/), JSON.stringify(bell.items.filter(t => /Bala/.test(t))));
  ok('bell: a reply somebody already acted on is not', !bellHas(/Handled Hari/), JSON.stringify(bell.items));
  ok('bell: the follow-up the reply set is not a second item', bell.items.filter(t => /Kavya Raman/.test(t)).length === 1, JSON.stringify(bell.items));
  await page.screenshot({ path: join(OUT, `campaign-lead-bell-${run.name}.png`) });
  await page.evaluate(() => closeAlerts());

  // ── THE CARDS ──
  const cards = await page.evaluate(() => {
    const card = id => { const c = document.querySelector(`.lcard[data-lead="${id}"]`); return c ? c.textContent.replace(/\s+/g, ' ').trim() : ''; };
    const red = document.querySelector('.lcard[data-lead="C1"]');
    return { c1: card('C1'), c3: card('C3'), c4: card('C4'), c5: card('C5'), c6: card('C6'), c9: card('C9'), c11: card('C11'), c12: card('C12'),
      c10Red: !!(document.querySelector('.lcard[data-lead="C10"].is-overdue')),
      c10Overdue: FOCUS_FILTERS.find(f => f.key === 'overdue').test(leads.find(l => l.id === 'C10')),
      c11Action: FOCUS_FILTERS.find(f => f.key === 'action').test(leads.find(l => l.id === 'C11')),
      c1Red: !!(red && red.classList.contains('is-overdue')),
      inOverdue: FOCUS_FILTERS.find(f => f.key === 'overdue').test(leads.find(l => l.id === 'C1')),
      c3Red: !!(document.querySelector('.lcard[data-lead="C3"].is-overdue')) };
  });
  ok('card: the call it asked for, past its time, is red and in the Overdue filter like any late follow-up', cards.c1Red && cards.inOverdue && !cards.c3Red, JSON.stringify({ c1Red: cards.c1Red, inOverdue: cards.inOverdue, c3Red: cards.c3Red }));
  ok('card: an open reply carries a chip', /↩ Asked for a call/.test(cards.c1), cards.c1);
  ok('card: ...and says the step once, not twice', (cards.c1.match(/Asked for a call/g) || []).length === 2, cards.c1);
  ok('card: opted out by reply says "No WhatsApp msgs"', /No WhatsApp msgs/.test(cards.c3), cards.c3);
  ok('card: opted out by a person says it too', /No WhatsApp msgs/.test(cards.c6), cards.c6);
  ok('card: a closed reply and a plain lead carry neither', !/↩|No WhatsApp msgs/.test(cards.c4 + cards.c5), cards.c4 + ' | ' + cards.c5);
  ok('card: "stop offers" says "No offers", not "No WhatsApp msgs"', /🔕 No offers/.test(cards.c12) && !/No WhatsApp msgs/.test(cards.c12), cards.c12);
  ok('card: a loan question carries a reply chip; "not this one" does not', /↩ Needs home-loan help/.test(cards.c9) && !/↩/.test(cards.c11), cards.c9 + ' | ' + cards.c11);
  ok('card: "call me after 6" is not red before six, nor in the Overdue filter', !cards.c10Red && !cards.c10Overdue);
  ok('"not this one" alone does not put a lead in "Needs action"', !cards.c11Action);
  const boardOverflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
  ok('board: the page does not scroll sideways', boardOverflow === 0, boardOverflow + 'px');
  await page.evaluate(() => { const c = document.querySelector('.lcard[data-lead="C1"]'); if (c) c.scrollIntoView({ block: 'center', inline: 'center' }); });
  await page.screenshot({ path: join(OUT, `campaign-lead-board-${run.name}.png`) });

  // ── THE LIST ──
  await page.evaluate(() => toggleView('list'));
  await wait(300);
  const list = await page.evaluate(() => {
    const row = name => [...document.querySelectorAll('.list-view tbody tr')].find(r => r.textContent.includes(name));
    const r1 = row('Kavya Raman'), r6 = row('Suma Iyer');
    return { c1: r1 ? r1.querySelector('td.lv-name').textContent : '', c6: r6 ? r6.querySelector('td.lv-name').textContent : '' };
  });
  ok('list: the name carries the same chips', /Asked for a call/.test(list.c1) && /No WhatsApp msgs/.test(list.c6), JSON.stringify(list));
  if (run.name === 'laptop-light') await page.screenshot({ path: join(OUT, `campaign-lead-list-${run.name}.png`) });

  // ── DAILY TASK ──
  await page.evaluate(() => toggleView('today'));
  await wait(500);
  const day = await page.evaluate(() => {
    const sec = [...document.querySelectorAll('#todayView .td-sec')].find(s => /Replied to campaigns/.test(s.textContent));
    const all = sec ? [...sec.querySelectorAll('details.td-row')] : [];
    const rows = sec ? [...sec.querySelectorAll(':scope > details.td-row')] : [];
    const known = sec ? [...sec.querySelectorAll('.td-known details.td-row')] : [];
    const read = r => r.textContent.replace(/\s+/g, ' ').trim();
    const find = re => all.find(r => re.test(r.textContent));
    const actsOf = r => r ? [...r.querySelectorAll('.td-acts .td-act')].map(b => b.textContent.trim()) : [];
    const lata = find(/Later Lata/), raghu = find(/Referral Raghu/), selvi = find(/Seller Selvi/), lak = find(/Loan Lakshmi/), bala = find(/Bala Booked/), naveen = find(/Naveen/), meena = find(/Meena/);
    [lata, raghu, selvi, lak, bala, naveen, meena].forEach(r => { if (r) r.open = true; });
    const calls = [...document.querySelectorAll('#todayView .td-sec')].find(s => /Calls due/.test(s.textContent));
    const kavya = rows.find(r => /Kavya/.test(r.textContent));
    if (kavya) kavya.open = true;
    const opted = all.find(r => /Opted Person/.test(r.textContent));
    if (opted) opted.open = true;
    return {
      there: !!sec, n: rows.length, order: rows.map(r => (r.querySelector('.td-who') || {}).textContent || ''),
      known: known.map(r => (r.querySelector('.td-who') || {}).textContent || ''), knownHead: sec && sec.querySelector('.td-known-h') ? sec.querySelector('.td-known-h').textContent : '',
      count: sec && sec.querySelector('.td-n') ? sec.querySelector('.td-n').textContent : '',
      lata: lata ? read(lata) : '', lataTime: lata ? lata.querySelector('.td-time').textContent : '', lataLate: !!(lata && lata.classList.contains('is-late')),
      raghu: raghu ? read(raghu) : '', selvi: selvi ? read(selvi) : '', lak: lak ? read(lak) : '', bala: bala ? read(bala) : '',
      naveen: naveen ? read(naveen) : '', naveenActs: actsOf(naveen), meena: meena ? read(meena) : '', meenaActs: actsOf(meena), raghuActs: actsOf(raghu),
      arun: !!find(/Arun Confirmed/),
      kavya: kavya ? read(kavya) : '', kavyaActs: kavya ? [...kavya.querySelectorAll('.td-acts .td-act')].map(b => b.textContent.trim()) : [],
      kavyaMine: !!(kavya && kavya.classList.contains('is-mine')),
      opted: opted ? read(opted) : '', optedActs: opted ? [...opted.querySelectorAll('.td-acts .td-act')].map(b => b.textContent.trim()) : [],
      seen: (rows.find(r => /Ravi Kumar/.test(r.textContent)) || { querySelector: () => null }).querySelector('summary .td-seen'),
      ravi: read(rows.find(r => /Ravi Kumar/.test(r.textContent)) || document.createElement('i')),
      kavyaInCalls: !!(calls && /Kavya/.test(calls.textContent)),
      sub: document.querySelector('#todayView .td-sub').textContent,
      sort: !!(sec && sec.querySelector('.td-sort select')),
      overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth)
    };
  });
  ok('Daily task: a "Replied to campaigns" section', day.there);
  ok('...listing the seven replies that need a person, not the handled one', day.n === 7 && day.count === '7' && !day.order.some(t => /Hari/.test(t)), JSON.stringify(day.order));
  ok('...yours first, then newest first, then the ones with a time they named',
    ['Kavya', 'Raghu', 'Selvi', 'Lakshmi', 'Bala', 'Ravi', 'Lata'].every((n, i) => new RegExp(n).test(day.order[i] || '')), JSON.stringify(day.order));
  ok('...the opt-out, "stop offers" and "not this one" listed under, uncounted, as "nothing to do"',
    /Just so you know/.test(day.knownHead) && day.known.length === 3 && /Naveen/.test(day.known[0]) && /Meena/.test(day.known[1]) && /Opted/.test(day.known[2]), JSON.stringify(day.known));
  ok('...an "ok" / visit confirmed never appears', !day.arun);
  ok('...a referral: get the friend\'s name & number', /Wants to refer someone — get the name & number/.test(day.raghu) && /Next step\s*Call and get their friend’s name & number/.test(day.raghu) && day.raghuActs.includes('📞 Call'), day.raghu.slice(0, 300));
  ok('...an owner: wants to sell or list', /Wants to sell\/list a property/.test(day.selvi) && /Next step\s*Call about their property/.test(day.selvi), day.selvi.slice(0, 300));
  ok('...a loan: home-loan help', /Needs home-loan help/.test(day.lak) && /Next step\s*Call and talk them through the home loan/.test(day.lak), day.lak.slice(0, 300));
  ok('..."found" in Negotiating: check if it was with us', /Says they booked — check if it was with us/.test(day.bala) && /Next step\s*Call — find out whether it was with us/.test(day.bala), day.bala.slice(0, 300));
  ok('..."call me after 6": "Call at …" with the time it named, and not late', /Call at \d{1,2}(:\d\d)? (AM|PM) (today|tomorrow)/.test(day.lata) && !day.lataLate && /Next step\s*Call them — at /.test(day.lata), day.lata.slice(0, 300) + ' / ' + day.lataTime);
  ok('..."not this one": noted, no call, says other offers still go', day.naveenActs.includes('✓ Noted') && !day.naveenActs.some(a => /Call/.test(a)) && /Not interested in “ANR003” — noted/.test(day.naveen) && /other offers still go/.test(day.naveen), day.naveen.slice(0, 300));
  ok('..."stop offers": noted, says visit messages still go', day.meenaActs.includes('✓ Noted') && /Asked to stop offers \(visit messages still OK\)/.test(day.meena) && /visit messages still go/.test(day.meena), day.meena.slice(0, 300));
  ok('...each with what they said', /Request a Call/.test(day.kavya) && /Liked it/.test(day.ravi), day.kavya.slice(0, 160));
  ok('...the campaign, and the next step', /Sold out — ANR003/.test(day.kavya) && /Next step\s*Call them/.test(day.kavya), day.kavya);
  ok('...open the lead, call, WhatsApp, log it, handled', ['Open lead', '📞 Call', '💬 WhatsApp', '✓ Log call', '✓ Handled'].every(a => day.kavyaActs.includes(a)), JSON.stringify(day.kavyaActs));
  ok('...marked yours when you are its agent', day.kavyaMine);
  ok('...an opt-out is noted, not called', day.optedActs.includes('✓ Noted') && !day.optedActs.some(a => /Call/.test(a)), JSON.stringify(day.optedActs));
  ok('...and says there is nothing to do', /campaigns leave them out/.test(day.opted), day.opted);
  ok('...the row you opened says when', /opened 5\dm ago/.test(day.ravi), day.ravi.slice(0, 140));
  ok('...it has the sort box every section has', day.sort);
  ok('...counted in the summary line — only the ones that need a person', /7 campaign replies/.test(day.sub), day.sub);
  ok('...and the follow-up the reply set is not a second row under Calls due', !day.kavyaInCalls);
  ok('Daily task: no sideways scroll', day.overflowX === 0, day.overflowX + 'px');
  const spans = await page.evaluate(async () => {
    PinToday.setSpan('month');
    await new Promise(r => setTimeout(r, 100));
    const sec = [...document.querySelectorAll('#todayView .td-sec')].find(s => /Replied to campaigns/.test(s.textContent));
    const n = sec ? sec.querySelectorAll(':scope > details.td-row').length : -1;
    PinToday.setSort('replies', 'old');
    const first = sec ? ([...document.querySelectorAll('#todayView .td-sec')].find(s => /Replied to campaigns/.test(s.textContent)).querySelector('.td-who') || {}).textContent : '';
    PinToday.setSort('replies', 'default');
    PinToday.setSpan('day');
    return { n, first };
  });
  ok('...the month view lists the same replies', spans.n === 7, String(spans.n));
  ok('...and "Most overdue first" puts the oldest reply first', /Ravi/.test(spans.first || ''), spans.first);
  await page.evaluate(() => {
    const sec = [...document.querySelectorAll('#todayView .td-sec')].find(s => /Replied to campaigns/.test(s.textContent));
    const k = sec && [...sec.querySelectorAll('details.td-row')].find(r => /Kavya/.test(r.textContent));
    if (k) { k.open = true; sec.scrollIntoView({ block: 'start' }); }
  });
  await wait(150);
  await page.screenshot({ path: join(OUT, `campaign-lead-today-${run.name}.png`) });
  // The rows below: "call me after 6", and the lines only to know.
  await page.evaluate(() => {
    const sec = [...document.querySelectorAll('#todayView .td-sec')].find(s => /Replied to campaigns/.test(s.textContent));
    const rows = sec ? [...sec.querySelectorAll('details.td-row')] : [];
    rows.forEach(r => { r.open = /Later Lata|Meena/.test(r.textContent); });
    const lata = rows.find(r => /Later Lata/.test(r.textContent));
    if (lata) lata.scrollIntoView({ block: 'start' });
  });
  await wait(150);
  await page.screenshot({ path: join(OUT, `campaign-lead-today-later-${run.name}.png`) });

  // ── THE LEAD PAGE ──
  await page.evaluate(() => openDetail('C1'));
  await wait(400);
  const lp = await page.evaluate(() => {
    const sec = document.getElementById('dpCmpSec');
    const rows = sec ? [...sec.querySelectorAll('.cmpl-row')] : [];
    const stand = [...document.querySelectorAll('#dpStand .st-item')].find(x => /Asked for a call after/.test(x.textContent));
    const sw = sec && sec.querySelector('.cmpl-switch[data-scope="all"] input');
    const mk = sec && sec.querySelector('.cmpl-switch[data-scope="marketing"] input');
    const body = document.querySelector('#dp .dp-body');
    return {
      shown: !!(sec && !sec.hidden), title: sec ? (sec.querySelector('.sec-title') || {}).textContent : '',
      rows: rows.map(r => r.textContent.replace(/\s+/g, ' ').trim()),
      chips: rows.map(r => (r.querySelector('.cmpl-st') || {}).textContent),
      openRow: rows.findIndex(r => r.classList.contains('open')),
      link: !!(rows[0] && rows[0].querySelector('button.cmpl-name')),
      checked: sw ? sw.checked : null, mkChecked: mk ? mk.checked : null,
      switches: sec ? [...sec.querySelectorAll('.cmpl-switch')].map(x => x.textContent.replace(/\s+/g, ' ').trim()) : [],
      standActs: stand ? [...stand.querySelectorAll('.tt-btn')].map(b => b.textContent.trim()) : [],
      standText: stand ? stand.textContent.replace(/\s+/g, ' ').trim() : '',
      overflow: body ? body.scrollWidth - body.clientWidth : -1,
      pageOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth)
    };
  });
  ok('lead page: a "WhatsApp campaigns" section', lp.shown && /WhatsApp campaigns/.test(lp.title), lp.title);
  ok('...every campaign it was in, newest first', lp.rows.length === 3 && /Sold out/.test(lp.rows[0]) && /Diwali/.test(lp.rows[2]), JSON.stringify(lp.rows));
  ok('...each with its template and when', /sold_out_similar/.test(lp.rows[0]) && /new_launch_v2/.test(lp.rows[1]) && /ago/.test(lp.rows[1]), JSON.stringify(lp.rows));
  ok('...sent, failed or replied', JSON.stringify(lp.chips) === JSON.stringify(['Replied', 'Sent', 'Failed']), JSON.stringify(lp.chips));
  ok('...the reply and what it means', /“?Request a Call”?/.test(lp.rows[0]) && /Asked for a call/.test(lp.rows[0]) && /needs a person/.test(lp.rows[0]), lp.rows[0]);
  ok('...the open reply is marked', lp.openRow === 0, String(lp.openRow));
  ok('...the campaign name opens the campaign', lp.link);
  ok('...two switches: "No offers (Marketing)" and "No WhatsApp messages at all"', lp.switches.length === 2 && /No offers \(Marketing\)/.test(lp.switches[0]) && /visit messages still go/.test(lp.switches[0])
    && /No WhatsApp messages at all/.test(lp.switches[1]), JSON.stringify(lp.switches));
  ok('...both off for a lead who has not opted out', lp.checked === false && lp.mkChecked === false, `${lp.checked} / ${lp.mkChecked}`);
  ok('lead page: "Where this lead stands" offers Call, WhatsApp, Log follow-up, Handled',
    ['📞 Call', '💬 WhatsApp', 'Log follow-up', 'Handled'].every(a => lp.standActs.includes(a)), JSON.stringify(lp.standActs));
  ok('...with the reply quoted', /“Request a Call”/.test(lp.standText), lp.standText);
  ok('lead page: nothing scrolls sideways', lp.overflow <= 0 && lp.pageOverflow === 0, `${lp.overflow}px / ${lp.pageOverflow}px`);
  await page.evaluate(() => { const s = document.getElementById('dpCmpSec'); if (s) s.scrollIntoView({ block: 'start' }); });
  await wait(150);
  await page.screenshot({ path: join(OUT, `campaign-lead-page-${run.name}.png`) });

  // The switches: ask the server (with the scope), show the answer at once — on the card and to
  // window.crmLeadOptOut, which the Campaigns wizard reads — and keep it until the lead catches up.
  const MK = '#dpCmpSec .cmpl-switch[data-scope="marketing"] input', ALL = '#dpCmpSec .cmpl-switch[data-scope="all"] input';
  const settled = () => page.waitForFunction(() => { const i = document.querySelector('#dpCmpSec .cmpl-switch[data-scope="all"] input'); return i && !i.disabled; });
  const swState = () => page.evaluate(() => {
    const sec = document.getElementById('dpCmpSec');
    // The card as the board draws it now (the board itself is behind the lead page).
    const card = document.createElement('div');
    card.innerHTML = leadCardHtml(leads.find(l => l.id === 'C1'));
    const q = s => sec.querySelector(`.cmpl-switch[data-scope="${s}"] input`);
    return { mk: q('marketing').checked, mkDisabled: q('marketing').disabled, all: q('all').checked, text: sec.textContent.replace(/\s+/g, ' '),
      card: card.textContent.replace(/\s+/g, ' '), look: window.crmLeadOptOut('C1') };
  });
  await page.click(MK);
  await settled();
  const s1 = await swState();
  ok('switch "No offers": calls op "optout" with scope "marketing" for this lead', optoutCalls.length === 1 && optoutCalls[0].body.leadId === 'C1' && optoutCalls[0].body.on === true
    && optoutCalls[0].body.scope === 'marketing' && /^Bearer /.test(optoutCalls[0].auth), JSON.stringify(optoutCalls));
  ok('...and shows it on at once, saying who and when — and that visit messages still go', s1.mk && !s1.all && /No offers\./.test(s1.text) && /Set by .* just now/.test(s1.text) && /Visit reminders and feedback messages still go/.test(s1.text), s1.text.slice(0, 300));
  ok('...on the card at once', /🔕 No offers/.test(s1.card), s1.card.slice(0, 200));
  ok('...and to window.crmLeadOptOut (the Campaigns wizard)', s1.look.marketing === true && s1.look.all === false, JSON.stringify(s1.look));
  await page.click(ALL);
  await settled();
  const s2 = await swState();
  ok('switch "No WhatsApp messages at all": op "optout" with scope "all"', optoutCalls.length === 2 && optoutCalls[1].body.on === true && optoutCalls[1].body.scope === 'all', JSON.stringify(optoutCalls.map(c => c.body)));
  ok('...on at once; "No offers" shows on and rests, covered by it', s2.all && s2.mk && s2.mkDisabled && /Covered by/.test(s2.text) && /Not messaged on WhatsApp/.test(s2.text) && /Set by .* just now/.test(s2.text), s2.text.slice(0, 300));
  ok('...the card says "No WhatsApp msgs", and crmLeadOptOut says both', /No WhatsApp msgs/.test(s2.card) && s2.look.all && s2.look.marketing, JSON.stringify(s2.look));
  // A snapshot from BEFORE the server's write (some other change on another lead) must not undo it.
  const stale = await page.evaluate(async () => {
    const list = JSON.parse(JSON.stringify(window.__LEADS));
    list.find(l => l.id === 'C5').name = 'Plain Priya R';
    window.applyLeadsSnapshot(list);
    await new Promise(r => setTimeout(r, 150));
    const sec = document.getElementById('dpCmpSec');
    const card = document.createElement('div');
    card.innerHTML = leadCardHtml(leads.find(l => l.id === 'C1'));
    return { all: sec.querySelector('.cmpl-switch[data-scope="all"] input').checked, look: window.crmLeadOptOut('C1'), card: card.textContent };
  });
  ok('...an older snapshot arriving meanwhile does not switch it back anywhere', stale.all && stale.look.all && stale.look.marketing && /No WhatsApp msgs/.test(stale.card), JSON.stringify(stale.look));
  const caught = await page.evaluate(async () => {
    const list = JSON.parse(JSON.stringify(window.__LEADS));
    const c1 = list.find(l => l.id === 'C1');
    Object.assign(c1, { waOptOut: true, waOptOutAt: Date.now(), waOptOutReason: 'set by thirumal@threepin.in',
      waMarketingOptOut: true, waMarketingOptOutAt: Date.now(), waMarketingOptOutReason: 'set by thirumal@threepin.in' });
    window.__LEADS = list;
    window.applyLeadsSnapshot(JSON.parse(JSON.stringify(list)));
    await new Promise(r => setTimeout(r, 200));
    const sec = document.getElementById('dpCmpSec');
    return { checked: sec.querySelector('.cmpl-switch[data-scope="all"] input').checked, text: sec.textContent.replace(/\s+/g, ' ') };
  });
  ok('...still on once the lead carries it, from the server this time', caught.checked && /Set by Thirumal/i.test(caught.text), caught.text.slice(0, 200));
  if (run.name === 'laptop-light' || run.name === 'phone-light') {
    await page.evaluate(() => { const s = document.getElementById('dpCmpSec'); if (s) s.scrollIntoView({ block: 'start' }); });
    await wait(120);
    await page.screenshot({ path: join(OUT, `campaign-lead-switches-${run.name}.png`) });
  }
  await page.click(ALL);
  await settled();
  ok('...and off again: op "optout" with on:false, scope "all"', optoutCalls.length === 3 && optoutCalls[2].body.on === false && optoutCalls[2].body.scope === 'all', JSON.stringify(optoutCalls.map(c => c.body)));
  const s3 = await swState();
  ok('...which leaves "No offers" on, and switchable again', !s3.all && s3.mk && !s3.mkDisabled && s3.look.all === false && s3.look.marketing === true, JSON.stringify(s3));
  // Put C1 back as it was for the rest of the run.
  await page.evaluate(() => { window.__LEADS = window.__LEADS.map(l => l.id !== 'C1' ? l : { ...l, waOptOut: false, waOptOutAt: null, waOptOutReason: null, waMarketingOptOut: false, waMarketingOptOutAt: null, waMarketingOptOutReason: null }); window.applyLeadsSnapshot(JSON.parse(JSON.stringify(window.__LEADS))); });
  await wait(150);

  // Someone who wrote STOP is not put back by a slip of the thumb.
  await page.evaluate(() => openDetail('C3'));
  await wait(250);
  const before = optoutCalls.length;
  await page.click(ALL);
  await wait(250);
  const c3 = await page.evaluate(() => {
    const sec = document.getElementById('dpCmpSec');
    return { checked: sec.querySelector('.cmpl-switch[data-scope="all"] input').checked, banner: (sec.querySelector('.cmpl-optout') || {}).textContent || '',
      stand: [...document.querySelectorAll('#dpStand .st-item')].map(x => x.textContent.replace(/\s+/g, ' ').trim()).find(t => /stop WhatsApp/.test(t)) || '',
      standActs: ([...document.querySelectorAll('#dpStand .st-item')].find(x => /stop WhatsApp/.test(x.textContent)) || document.createElement('i')).querySelectorAll('.tt-btn').length };
  });
  ok('opt-out by reply: the page says so, and why', /Not messaged on WhatsApp/.test(c3.banner) && /replied asking to stop/i.test(c3.banner), c3.banner);
  ok('...turning it off asks first, and Cancel leaves it on', /replied asking not to be messaged/.test(page.__lastDialog || '') && c3.checked && optoutCalls.length === before, `${page.__lastDialog} / ${c3.checked}`);
  ok('..."Where this lead stands" only asks to note it', /campaigns leave them out/.test(c3.stand) && c3.standActs === 1, c3.stand + ' / ' + c3.standActs);
  if (run.name.startsWith('phone')) {
    await page.evaluate(() => { const s = document.getElementById('dpCmpSec'); if (s) s.scrollIntoView({ block: 'start' }); });
    await wait(120);
    await page.screenshot({ path: join(OUT, `campaign-lead-optout-${run.name}.png`) });
  }

  // "Stop offers" by reply: the No-offers banner, the switch on, and turning it off asks first.
  await page.evaluate(() => openDetail('C12'));
  await wait(250);
  page.__lastDialog = '';
  const before12 = optoutCalls.length;
  await page.click(MK);
  await wait(250);
  const c12 = await page.evaluate(() => {
    const sec = document.getElementById('dpCmpSec');
    const q = s => sec.querySelector(`.cmpl-switch[data-scope="${s}"] input`);
    const st = [...document.querySelectorAll('#dpStand .st-item')].find(x => /stop offers/.test(x.textContent));
    return { mk: q('marketing').checked, all: q('all').checked, banner: (sec.querySelector('.cmpl-optout') || {}).textContent || '',
      rows: [...sec.querySelectorAll('.cmpl-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
      stand: st ? st.textContent.replace(/\s+/g, ' ').trim() : '', standActs: st ? [...st.querySelectorAll('.tt-btn')].map(b => b.textContent.trim()) : [] };
  });
  ok('"stop offers" by reply: "No offers" banner, says visit messages still go, and why', /No offers\./.test(c12.banner) && /replied asking to stop offers/i.test(c12.banner) && /Visit reminders and feedback messages still go/.test(c12.banner), c12.banner);
  ok('..."No offers" on, "no messages at all" off', c12.mk && !c12.all);
  ok('...turning it off asks first, and Cancel leaves it on', /asked for no offers/.test(page.__lastDialog || '') && c12.mk && optoutCalls.length === before12, `${page.__lastDialog} / ${c12.mk}`);
  ok('...the history row says what it meant, not yet noted', /Stop offers/.test(c12.rows[0] || '') && /Asked to stop offers/.test(c12.rows[0] || '') && /not noted yet/.test(c12.rows[0] || ''), c12.rows[0]);
  ok('..."Where this lead stands" only asks to note it', c12.standActs.length === 1 && c12.standActs[0] === 'Noted' && /visit reminders and feedback still go/.test(c12.stand), JSON.stringify(c12));

  // The new actions in the lead's campaign history.
  const histOf = async id => {
    await page.evaluate(i => openDetail(i), id);
    await wait(200);
    return page.evaluate(() => {
      const sec = document.getElementById('dpCmpSec');
      return { rows: [...sec.querySelectorAll('.cmpl-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()), sec: sec.textContent.replace(/\s+/g, ' '),
        visit: (document.getElementById('dpVisit') || { textContent: '' }).textContent.replace(/\s+/g, ' '),
        overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth) };
    });
  };
  const h7 = await histOf('C7'), h8 = await histOf('C8'), h9 = await histOf('C9'), h11 = await histOf('C11'), h14 = await histOf('C14'), h10 = await histOf('C10');
  ok('history: a referral, an owner, a loan, each with its meaning and "needs a person"',
    /Wants to refer someone.*needs a person/.test(h7.rows[0]) && /Wants to sell or list a property.*needs a person/.test(h8.rows[0]) && /Needs home-loan help.*needs a person/.test(h9.rows[0]),
    JSON.stringify([h7.rows[0], h8.rows[0], h9.rows[0]]));
  ok('history: "not this one" — noted, not a person', /Not interested in this one/.test(h11.rows[0]) && /not noted yet/.test(h11.rows[0]) && !/needs a person/.test(h11.rows[0]), h11.rows[0]);
  ok('history: "found" in Negotiating reads "Says they booked"', /Says they booked/.test(h14.rows[0]) && !/found a property/.test(h14.rows[0]), h14.rows[0]);
  ok('history: "call me after 6" says when to call', /needs a person · call at \d{1,2}(:\d\d)? (AM|PM) (today|tomorrow)/.test(h10.rows[0]), h10.rows[0]);
  const h13 = await histOf('C13');
  ok('a visit confirmed on WhatsApp: "Confirmed the visit by WhatsApp · <day>" on the lead page', /Confirmed the visit by WhatsApp · \w{3}, \d{1,2} \w{3}|Confirmed the visit by WhatsApp · \w{3} \d{1,2} \w{3}/.test(h13.sec), h13.sec.slice(0, 260));
  ok('...and on the visit itself', /Confirmed the visit by WhatsApp/.test(h13.visit), h13.visit);
  ok('...its history row reads "Confirmed the visit", nothing open', /Confirmed the visit/.test(h13.rows[0]) && !/needs a person|not noted yet/.test(h13.rows[0]), h13.rows[0]);
  ok('...and a confirmation from before the visit was moved does not count', await page.evaluate(() => {
    const l = { ...leads.find(x => x.id === 'C13') };
    l.siteVisitSetAt = Date.now();   // booked again after the "Confirmed"
    return !/Confirmed the visit/.test(visitRowHtml(l));
  }));
  ok('lead pages: nothing scrolls sideways', [h7, h8, h9, h10, h11, h13, h14].every(h => h.overflow === 0));
  await page.evaluate(() => { const s = document.getElementById('dpVisitSec'); if (s) s.scrollIntoView({ block: 'start' }); });
  await wait(120);
  if (run.name === 'laptop-dark' || run.name === 'phone-dark') await page.screenshot({ path: join(OUT, `campaign-lead-confirmed-${run.name}.png`) });

  // A person kept them out, and a lead never in a campaign gets only the switch.
  await page.evaluate(() => openDetail('C6'));
  await wait(200);
  const c6 = await page.evaluate(() => (document.querySelector('#dpCmpSec .cmpl-optout') || {}).textContent || '');
  ok('opt-out by a person: says who', /Set by Swami/.test(c6), c6);
  await page.evaluate(() => openDetail('C5'));
  await wait(200);
  const c5 = await page.evaluate(() => {
    const sec = document.getElementById('dpCmpSec');
    return { shown: !sec.hidden, title: !!sec.querySelector('.sec-title'), rows: sec.querySelectorAll('.cmpl-row').length,
      sw: sec.querySelectorAll('.cmpl-switch input').length, h: Math.round(sec.getBoundingClientRect().height) };
  });
  ok('no campaigns: only the switches, compact', c5.shown && !c5.title && c5.rows === 0 && c5.sw === 2 && c5.h < (run.name.startsWith('phone') ? 150 : 90), JSON.stringify(c5));
  if (run.name === 'laptop-light' || run.name === 'phone-dark') {
    await page.evaluate(() => { const s = document.getElementById('dpCmpSec'); if (s) s.scrollIntoView({ block: 'center' }); });
    await wait(120);
    await page.screenshot({ path: join(OUT, `campaign-lead-compact-${run.name}.png`) });
  }

  // The link: to the campaign, on the Campaigns screen.
  await page.evaluate(() => openDetail('C1'));
  await wait(200);
  const linked = await page.evaluate(async () => {
    window.PinCampaigns.openCampaign = id => { window.__openedCampaign = id; };
    document.querySelector('#dpCmpSec button.cmpl-name').click();
    await new Promise(r => setTimeout(r, 200));
    return { id: window.__openedCampaign, view: currentView, dpOpen: document.getElementById('dp').classList.contains('open') };
  });
  ok('the campaign name opens that campaign on the Campaigns screen', linked.id === 'cmp_sold' && linked.view === 'cmp-history' && !linked.dpOpen, JSON.stringify(linked));

  // ── A PERSON ACTS, AND IT CLOSES ──
  await page.evaluate(() => { toggleView('kanban'); openDetail('C1'); });
  await wait(250);
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('#dpStand .st-item')].find(x => /Asked for a call after/.test(x.textContent));
    [...item.querySelectorAll('.tt-btn')].find(b => b.textContent.trim() === 'Handled').click();
  });
  await wait(250);
  const after = await page.evaluate(async () => {
    closeDetail();
    toggleAlerts();
    await new Promise(r => setTimeout(r, 150));
    const items = [...document.getElementById('bellMenu').querySelectorAll('.bell-item')].map(b => b.textContent.replace(/\s+/g, ' ').trim());
    closeAlerts();
    toggleView('today');
    await new Promise(r => setTimeout(r, 200));
    const sec = [...document.querySelectorAll('#todayView .td-sec')].find(s => /Replied to campaigns/.test(s.textContent));
    const card = () => { toggleView('kanban'); const c = document.querySelector('.lcard[data-lead="C1"]'); return c ? c.textContent : ''; };
    const calls = [...document.querySelectorAll('#todayView .td-sec')].find(s => /Calls due/.test(s.textContent));
    return { bell: items, today: sec ? [...sec.querySelectorAll('.td-who')].map(x => x.textContent) : [],
      calls: calls ? [...calls.querySelectorAll('.td-row')].map(x => x.textContent.replace(/\s+/g, ' ').trim()) : [], card: card() };
  });
  ok('after "Handled": the reply is gone from the bell', !after.bell.some(t => /Asked for a call after.*Kavya/.test(t)) && after.bell.some(t => /Ravi Kumar/.test(t)), JSON.stringify(after.bell));
  ok('...gone from "Replied to campaigns"', !after.today.some(t => /Kavya/.test(t)) && after.today.length === 6 + 3, JSON.stringify(after.today));
  // Noting the reply is not making the call: the follow-up it set is still owed until it is logged.
  ok('...while the call it asked for is still due, once, under Calls due',
    after.calls.filter(t => /Kavya/.test(t)).length === 1 && after.calls.some(t => /Asked for a call — Sold out/.test(t))
    && after.bell.filter(t => /Kavya/.test(t)).length === 1, JSON.stringify(after.calls.filter(t => /Kavya/.test(t))));
  ok('...and its chip leaves the card', !/↩/.test(after.card), after.card.replace(/\s+/g, ' ').slice(0, 200));

  await ctx.close();
}
await browser.close();
console.log('');
console.log('─'.repeat(64));
if (errors.length) { console.log(errors.length + ' problem(s):'); errors.forEach(e => console.log('  · ' + e)); process.exit(1); }
console.log('All good.');
