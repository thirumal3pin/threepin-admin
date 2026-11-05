// ═══════ STAGE JOURNEYS — who is due which WhatsApp message ═══════
//
//   node tests/journeys.test.mjs
//
// crm-assets/journeys.js: every journey's rule, the two rules every journey keeps (no one who asked
// not to be messaged; no Marketing to a lead Negotiating or Won), what counts as an open campaign
// reply, and what a campaign led to — plus the cost and quiet-hours helpers in campaignModel.js.
// The match engine is a stand-in here (match-engine.js is a browser script); the page test
// (tests/campaign-preview.mjs) runs the real one.

import * as J from '../crm-assets/journeys.js';
import * as C from '../crm-assets/campaignModel.js';
import { STAGE_DEFS } from '../crm-assets/pipeline.js';

let passed = 0, failed = 0;
const check = (label, cond, detail) => { if (cond) passed++; else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); } };
const section = s => console.log('\n── ' + s);
console.log('3 PIN Realty — stage journeys');

const DAY = 86400000;
// Wednesday 5 Nov 2026, 11:00 IST.
const NOW = Date.UTC(2026, 10, 5, 5, 30);
const STAGES = STAGE_DEFS.map(d => ({ id: 's_' + d.key, key: d.key, kind: d.kind, name: d.name }));
const sid = k => 's_' + k;
const tomorrowAt = h => J.istDayStart(NOW) + DAY + h * 3600000;
let n = 0;
const lead = (o = {}) => ({ id: 'L' + (++n), name: 'Lead ' + n, phone: '98400' + String(10000 + n).slice(-5), stageId: sid('new'), createdAt: NOW - 60 * DAY, updatedAt: NOW - 10 * DAY, ...o });
const run = (leads, extra = {}) => J.dueJourneys({ leads, stages: STAGES, campaigns: [], inventory: [], now: NOW, ...extra });
const one = (list, type) => list.find(j => j.type === type);
const ids = j => (j ? j.leadIds : []);

section('helpers');
check('IST day starts at 00:00 IST (18:30 UTC the day before)', J.istDayStart(NOW) === Date.UTC(2026, 10, 4, 18, 30));
check('propertyAddedAt: createdAt, else the id’s timestamp, else 0',
  J.propertyAddedAt({ createdAt: 5 }) === 5 && J.propertyAddedAt({ id: 'p1762300000000' }) === 1762300000000 && J.propertyAddedAt({ id: 'ANR003' }) === 0);
check('leadHasProperty by code, any case, or by the visit', J.leadHasProperty({ propertyCodes: ['anr003'] }, { id: 'x', propertyCode: 'ANR003' })
  && J.leadHasProperty({ siteVisitAt: 1, siteVisitProperty: 'VLCA002' }, { id: 'VLCA002' }) && !J.leadHasProperty({ propertyCodes: ['MADA1'] }, { id: 'ANR003' }));

section('replies waiting for a person');
check('a reply after the last touch is open', J.replyIsOpen({ updatedAt: 10, campaignReply: { at: 20, action: 'call' } }));
check('…until somebody touches the lead', !J.replyIsOpen({ updatedAt: 30, campaignReply: { at: 20, action: 'call' } }));
check('…or TailorTalk marks attention handled', !J.replyIsOpen({ updatedAt: 10, tt: { attentionFrom: 25 }, campaignReply: { at: 20, action: 'visit' } }));
check('a STOP needs nobody', !J.replyIsOpen({ updatedAt: 10, campaignReply: { at: 20, action: 'optout' } }));
check('no reply, nothing open', !J.replyIsOpen({ updatedAt: 10 }));

check('replies that need nobody: a thanks or confirm, “not this one”, a STOP, a “no more offers”',
  ['ack', 'not_this', 'optout', 'marketing_optout'].every(a => !J.replyIsOpen({ updatedAt: 10, campaignReply: { at: 20, action: a } })));
check('replies that need a person: a referral, a seller, a loan, a key not known yet',
  ['referral', 'seller', 'loan', 'zzz'].every(a => J.replyIsOpen({ updatedAt: 10, campaignReply: { at: 20, action: a } })));

const H = 3600000;
const DAY0 = J.istDayStart(NOW); // today 00:00 IST; NOW is 11:00 IST

section('1. missed visit — open an hour after its time, the same day');
{
  const v = (at, o = {}) => lead({ stageId: sid('visit_pending'), siteVisitAt: at, siteVisitStatus: 'scheduled', siteVisitSetAt: NOW - 3 * DAY, ...o });
  const a = v(NOW - 2 * H);
  const b = v(NOW - 30 * 60000);
  const c = v(NOW - 2 * H, { siteVisitStatus: 'done' });
  const d = v(NOW - 2 * H, { siteVisitStatus: 'cancelled' });
  const e = v(NOW - 20 * H); // yesterday
  const f = v(NOW - 2 * H, { updatedAt: NOW - H });
  const g = v(NOW - 2 * H);
  const h = v(NOW - 2 * H, { stageId: sid('lost') });
  const campaigns = [{ id: 'ns', purpose: 'no_show', createdAt: NOW - 30 * 60000, leadIds: [g.id] }];
  const j = one(run([a, b, c, d, e, f, g, h], { campaigns }), 'no_show');
  check('only the open visit 1+ hour past, today, untouched since, not already sent, not lost', JSON.stringify(ids(j)) === JSON.stringify([a.id]), ids(j));
  check('its own purpose and journey key, Utility', j && j.purpose === 'no_show' && j.journey === 'no_show' && j.category === 'UTILITY' && j.action === 'send');
  check('exactly one hour after is due', ids(one(run([v(NOW - H)]), 'no_show')).length === 1);
}

section('2. visit today — 2 to 3 hours ahead, not confirmed');
{
  const v = (at, o = {}) => lead({ stageId: sid('visit_pending'), siteVisitAt: at, siteVisitStatus: 'scheduled', siteVisitSetAt: NOW - 2 * DAY, ...o });
  const a = v(NOW + 2.5 * H);
  const b = v(NOW + H);
  const c = v(NOW + 4 * H);
  const d = v(NOW + 2.5 * H, { siteVisitConfirmedAt: NOW - DAY });       // confirmed this time
  const e = v(NOW + 2.5 * H, { siteVisitConfirmedAt: NOW - 3 * DAY });   // confirmed an earlier time
  const f = v(NOW + 2.5 * H);
  const g = v(NOW + 2.5 * H);
  const k = v(NOW + 2.5 * H, { siteVisitStatus: 'cancelled' });
  const campaigns = [{ id: 'r1', purpose: 'visit_reminder', createdAt: DAY0 + H, leadIds: [f.id] },
    { id: 'r0', purpose: 'visit_reminder', journey: 'visit_reminder', createdAt: NOW - 20 * H, leadIds: [g.id] }];
  const j = one(run([a, b, c, d, e, f, g, k], { campaigns }), 'visit_today');
  check('2–3 h ahead, unconfirmed (a confirm of the old time does not count), not reminded today; yesterday’s reminder does not count',
    JSON.stringify(ids(j)) === JSON.stringify([a.id, e.id, g.id]), ids(j));
  check('sent with the reminder template', j && j.purpose === 'visit_reminder' && j.journey === 'visit_today');
  check('exactly 2 h and exactly 3 h are both in', ids(one(run([v(NOW + 2 * H), v(NOW + 3 * H)]), 'visit_today')).length === 2);
}

section('3. visit reminder — visit tomorrow, not yet reminded, 10 AM–7 PM');
{
  const a = lead({ stageId: sid('visit_pending'), siteVisitAt: tomorrowAt(16), siteVisitStatus: 'scheduled', siteVisitSetAt: NOW - 2 * DAY });
  const b = lead({ stageId: sid('visit_pending'), siteVisitAt: tomorrowAt(10), siteVisitStatus: 'scheduled', siteVisitSetAt: NOW - 2 * DAY });
  const c = lead({ stageId: sid('visit_pending'), siteVisitAt: tomorrowAt(11), siteVisitStatus: 'cancelled' });
  const d = lead({ stageId: sid('visit_pending'), siteVisitAt: NOW + 3 * DAY, siteVisitStatus: 'scheduled' });
  // Reminded, but the visit was moved after the reminder: remind again.
  const e = lead({ stageId: sid('visit_pending'), siteVisitAt: tomorrowAt(12), siteVisitStatus: 'scheduled', siteVisitSetAt: NOW - 3600000 });
  const campaigns = [{ id: 'c1', purpose: 'visit_reminder', createdAt: NOW - DAY, leadIds: [b.id, e.id] }];
  const j = one(run([a, b, c, d, e], { campaigns }), 'visit_reminder');
  check('tomorrow’s open visits not yet reminded', JSON.stringify(ids(j)) === JSON.stringify([a.id, e.id]), ids(j));
  check('…labelled with the count', j && j.label === '2 visits tomorrow' && j.purpose === 'visit_reminder' && j.quick === 'journey');
  check('…with its send window', j && j.window && j.window.from === 10 && j.window.to === 19 && /10 AM and 7 PM/.test(j.note));
  const late = lead({ stageId: sid('visit_pending'), siteVisitAt: J.istDayStart(NOW) + 2 * DAY - 60000, siteVisitStatus: 'scheduled' });
  check('11:59 PM IST tomorrow is still tomorrow', ids(one(run([late]), 'visit_reminder')).includes(late.id));
  const free = lead({ stageId: sid('visit_pending'), siteVisitAt: tomorrowAt(11), siteVisitStatus: 'scheduled', tt: { lastMessageAt: NOW - 2 * H } });
  const jf = one(run([a, free]), 'visit_reminder');
  check('a Utility card keeps the lead who wrote today, flagged free now', jf && jf.leadIds.includes(free.id) && jf.freeNow === true && JSON.stringify(jf.freeNowIds) === JSON.stringify([free.id]), jf);
  check('…and a card with no such lead says so', j && j.freeNow === false && j.freeNowIds.length === 0);
}

section('4. visit feedback — 2 h after the visit until the end of the next day');
{
  const v = (at, o = {}) => lead({ stageId: sid('visit_done'), siteVisitAt: at, siteVisitStatus: 'done', siteVisitSetAt: at + H, updatedAt: at + H, ...o });
  const a = v(NOW - 3 * H);
  const b = v(NOW - 3 * H, { lastCampaignAt: NOW - H });
  const c = v(NOW - H);                                     // too soon
  const d = v(DAY0 - 9 * H);                                // yesterday 3 PM
  const e = v(DAY0 - DAY - 9 * H);                          // the day before yesterday
  const f = v(NOW - 3 * H, { stageId: sid('lost') });
  const g = v(NOW - 3 * H, { stageId: sid('negotiation') });
  const h = v(NOW - 3 * H, { lastNote: { text: 'Liked it', createdAt: NOW - 90 * 60000 } });
  const i = v(NOW - 3 * H, { siteVisitSetAt: NOW - 2.5 * H, updatedAt: NOW - 30 * 60000 }); // touched after marking done
  const k = v(NOW - 3 * H, { tt: { lastMessageAt: NOW - H } });                              // wrote since
  const m = v(NOW - 3 * H, { tt: { lastMessageAt: NOW - 20 * H } });                        // wrote before the visit
  const q = v(NOW - 3 * H);
  const campaigns = [{ id: 'c1', purpose: 'other', createdAt: NOW - H, leadIds: [q.id] }];
  const j = one(run([a, b, c, d, e, f, g, h, i, k, m, q], { campaigns }), 'visit_feedback');
  check('visits 2+ h ago today or yesterday; not lost/Negotiating; no note, touch, message from them or campaign since',
    JSON.stringify(ids(j)) === JSON.stringify([a.id, d.id, m.id]), ids(j));
  check('marking the visit done is not “being in touch”', ids(j).includes(a.id));
  check('a lead who wrote within 24 h stays, flagged free now', j && JSON.stringify(j.freeNowIds) === JSON.stringify([m.id]));
  check('copy', j && j.label === '3 visits today or yesterday with no feedback asked', j && j.label);
  const edge = v(DAY0 - DAY + 10 * H);  // yesterday 10 AM, NOW is still within the next day
  const gone = v(DAY0 - DAY - H);        // 11 PM the day before yesterday
  check('the window closes at midnight after the next day', ids(one(run([edge, gone]), 'visit_feedback')).join() === edge.id);
}

section('5. sold out — only the leads who were really about it; Negotiating / Visit planned get a call');
{
  const P = { id: 'ANR003', propertyCode: 'ANR003', name: 'Sunrise Residency', soldOut: true };
  const a = lead({ propertyCodes: ['ANR003'] });                                                                     // first link
  const b = lead({ propertyCodes: ['MADA1'], siteVisitAt: NOW - DAY, siteVisitStatus: 'done', siteVisitProperty: 'ANR003' }); // visited
  const c = lead({ propertyCodes: ['ANR003'], stageId: sid('won') });
  const d = lead({ propertyCodes: ['ANR003'] });                                                                     // told
  const e = lead({ propertyCodes: ['MADA1', 'ANR003'] });                                                            // only in passing
  const f = lead({ tt: { adTitle: 'Sunrise Residency – 3 BHK, Anna Nagar' } });                                       // came from its ad
  const g = lead({ tt: { values: { propertyInterest: 'anr003 please' } } });                                          // asked about it by code
  const h = lead({ stageId: sid('negotiation'), propertyCodes: ['MADA1', 'ANR003'] });
  const i = lead({ stageId: sid('visit_pending'), siteVisitAt: NOW + DAY, siteVisitStatus: 'scheduled', siteVisitProperty: 'ANR003' });
  const k = lead({ tt: { adTitle: 'ANR0031 Garden View' } });                                                         // a different code
  const free = lead({ propertyCodes: ['ANR003'], tt: { lastMessageAt: NOW - H } });
  const neg2 = lead({ stageId: sid('negotiation'), propertyCodes: ['ZZZ9'] });                                      // not about it at all
  const campaigns = [{ id: 'c1', purpose: 'sold_out', propertyMode: 'one', propertyId: 'ANR003', createdAt: NOW - DAY, leadIds: [d.id] }];
  const list = run([a, b, c, d, e, f, g, h, i, k, free, neg2], { campaigns, inventory: [P] });
  const j = one(list, 'sold_out'), call = one(list, 'call');
  check('first link, visited, its ad, asked about it — not Won, not told, not a passing link, not a look-alike code',
    JSON.stringify(ids(j)) === JSON.stringify([a.id, b.id, f.id, g.id]), ids(j));
  check('Marketing now: the lead who wrote today is held, with the server’s why', j && j.category === 'MARKETING'
    && j.held.some(x => x.id === free.id && x.why === 'inside free 24-h window — reply in chat'), j && j.held);
  check('one card per property, keyed by it', j && j.key === 'sold_out:ANR003' && j.propertyId === 'ANR003' && j.journey === 'sold_out');
  check('copy names the property and the visits', j && j.label === 'ANR003 · Sunrise Residency is sold out' && j.why === '4 interested leads not yet told · 1 visited', j && j.why);
  check('Negotiating or with a visit planned there → “Call these first”', JSON.stringify(ids(call)) === JSON.stringify([h.id, i.id]), ids(call));
  check('…a call card: no template, no category', call && call.action === 'call' && call.purpose === null && call.category === null
    && call.journey === 'sold_out_call' && call.key === 'call:ANR003' && /^Call these first/.test(call.label));
  check('…listed before the message card', list.indexOf(call) < list.indexOf(j));
  check('interestIn says how', J.interestIn(a, P) === 'first' && J.interestIn(b, P) === 'visited' && J.interestIn(i, P) === 'planned'
    && J.interestIn(f, P) === 'enquiry' && J.interestIn(e, P) === '' && J.interestIn(k, P) === '');
}

section('6. feedback nudge — once, 48 h to 7 days after the ask, no reply');
{
  const ask = { id: 'fb', purpose: 'visit_feedback', createdAt: NOW - 3 * DAY };
  const a = lead({ stageId: sid('visit_done') });
  const b = lead({ stageId: sid('visit_done'), campaignReply: { campaignId: 'fb', at: NOW - 2 * DAY, action: 'feedback' } });
  const c = lead({ stageId: sid('visit_done'), tt: { lastMessageAt: NOW - 2 * DAY } });
  const d = lead({ stageId: sid('negotiation') });
  const e = lead({ stageId: sid('visit_done'), campaignLog: [{ id: 'fb', status: 'replied' }] });
  const f = lead({ stageId: sid('visit_done') });
  const g = lead({ stageId: sid('visit_done') });
  const campaigns = [{ ...ask, leadIds: [a.id, b.id, c.id, d.id, e.id, f.id] }, { id: 'later', purpose: 'feedback_nudge', createdAt: NOW - DAY, leadIds: [f.id] },
    { id: 'fresh', purpose: 'visit_feedback', createdAt: NOW - 30 * H, leadIds: [g.id] }];
  const j = one(run([a, b, c, d, e, f, g], { campaigns }), 'feedback_nudge');
  check('only the one with no reply, no message from them, not nudged yet, still before Negotiating, asked 48+ h ago', JSON.stringify(ids(j)) === JSON.stringify([a.id]), ids(j));
  check('uses its own purpose', j && j.purpose === 'feedback_nudge' && j.category === 'UTILITY');
  const at48 = lead({ stageId: sid('visit_done') });
  check('exactly 48 h after the ask is due', !!one(run([at48], { campaigns: [{ id: 'x', purpose: 'visit_feedback', createdAt: NOW - 48 * H, leadIds: [at48.id] }] }), 'feedback_nudge'));
  const old = lead({ stageId: sid('visit_done') });
  check('a feedback ask older than 7 days is let go', !one(run([old], { campaigns: [{ id: 'o', purpose: 'visit_feedback', createdAt: NOW - 8 * DAY, leadIds: [old.id] }] }), 'feedback_nudge'));
  const byJourney = lead({ stageId: sid('visit_done') });
  check('an ask recorded by its journey key counts too', !!one(run([byJourney], { campaigns: [{ id: 'jj', purpose: 'other', journey: 'visit_feedback', createdAt: NOW - 3 * DAY, leadIds: [byJourney.id] }] }), 'feedback_nudge'));
}

section('7. options follow-up — Marketing, 48 h to 30 days in "Options sent"');
{
  const a = lead({ stageId: sid('options'), stageChangedAt: NOW - 5 * DAY });
  const b = lead({ stageId: sid('options'), stageChangedAt: NOW - DAY });
  const c = lead({ stageId: sid('options'), stageChangedAt: NOW - 5 * DAY, tt: { lastMessageAt: NOW - 2 * DAY } });
  const d = lead({ stageId: sid('options'), stageChangedAt: NOW - 5 * DAY, lastCampaignAt: NOW - 2 * DAY });
  const e = lead({ stageId: sid('options'), stageChangedAt: NOW - 40 * DAY });
  const f = lead({ stageId: sid('options'), reached: { options: NOW - 6 * DAY } });
  const g = lead({ stageId: sid('options'), stageChangedAt: NOW - 50 * H });
  const j = one(run([a, b, c, d, e, f, g]), 'options_followup');
  check('48 h+, no reply, no campaign, not stale; the milestone date stands in for stageChangedAt', JSON.stringify(ids(j)) === JSON.stringify([a.id, f.id, g.id]), ids(j));
  check('Marketing by default', j && j.category === 'MARKETING');
  // The Marketing rules, as the server applies them.
  const base = { stageId: sid('options'), stageChangedAt: NOW - 5 * DAY };
  const noOffers = lead({ ...base, waMarketingOptOut: true });
  const listed = lead({ ...base, phone: '9840077777' });
  const recent = lead({ ...base, lastMarketingAt: NOW - 6 * DAY, lastCampaignAt: NOW - 6 * DAY });
  const twoNo = lead({ ...base, marketingUnanswered: 2, lastMarketingAt: NOW - 20 * DAY });
  const twoOld = lead({ ...base, marketingUnanswered: 2, lastMarketingAt: NOW - 70 * DAY });
  const free = lead({ ...base, tt: { lastMessageAt: NOW - 30 * 60000 } });
  const r = one(run([noOffers, listed, recent, twoNo, twoOld, free], { marketingOptOut: ['+91 98400 77777'] }), 'options_followup');
  check('Marketing rules: no offers (lead or list), messaged in the gap, two unanswered in 60 days (and one who wrote is out by the rule itself)',
    JSON.stringify(ids(r)) === JSON.stringify([twoOld.id]), ids(r));
  const why = Object.fromEntries((r ? r.held : []).map(x => [x.id, x.why]));
  check('…each held with the server’s why', why[noOffers.id] === 'no offers' && why[listed.id] === 'no offers' && why[recent.id] === 'messaged recently'
    && why[twoNo.id] === 'two offers unanswered' && !why[free.id], why);
  check('the gap comes from the settings', ids(one(run([recent], { settings: { marketingGapDays: 3 } }), 'options_followup')).includes(recent.id)
    && ids(one(run([recent], { gapDays: 0 }), 'options_followup')).includes(recent.id));
  check('a Marketing card with everyone held is no card', !one(run([noOffers]), 'options_followup'));
  check('a Utility options template keeps the Marketing rules out', ids(one(run([noOffers], { categoryFor: () => 'UTILITY' }), 'options_followup')).includes(noOffers.id));
}

section('8. on-hold revisit — holdUntil has come; says why they paused');
{
  const a = lead({ stageId: sid('on_hold'), holdUntil: NOW - DAY, holdReason: 'postponed' });
  const b = lead({ stageId: sid('on_hold'), holdUntil: NOW + DAY });
  const c = lead({ stageId: sid('on_hold'), holdUntil: NOW - 2 * DAY, lastCampaignAt: NOW - DAY });
  const d = lead({ stageId: sid('on_hold') });
  const e = lead({ stageId: sid('on_hold'), holdUntil: NOW - 3 * DAY, holdReason: 'budget' });
  const f = lead({ stageId: sid('on_hold'), holdUntil: NOW - 3 * DAY, holdReason: 'postponed' });
  const j = one(run([a, b, c, d, e, f]), 'hold_revisit');
  check('due, and not messaged since the date', JSON.stringify(ids(j)) === JSON.stringify([a.id, e.id, f.id]), ids(j));
  check('sent with the search check-in, Marketing', j && j.purpose === 'search_checkin' && j.category === 'MARKETING');
  check('the card says why they paused, counted', j && /Postponed by the lead \(2\)/.test(j.why) && /Budget not ready \(1\)/.test(j.why), j && j.why);
  check('…and each lead’s reason', j && j.reasons[a.id] === 'Postponed by the lead' && j.reasons[e.id] === 'Budget not ready');
  check('one lead: the reason alone', /· Postponed by the lead$/.test(one(run([a]), 'hold_revisit').why));
}

section('9 & 10. new listing → matched buyers; lost → re-engage');
{
  const NEW = { id: 'p' + (NOW - 3 * DAY), propertyCode: 'MADA0009', name: 'Radiance Phase 2', createdAt: NOW - 3 * DAY };
  const OLD = { id: 'OLD1', propertyCode: 'OLD1', name: 'Old Listing', createdAt: NOW - 40 * DAY };
  const SOLD = { id: 'S1', propertyCode: 'S1', name: 'Sold New', createdAt: NOW - DAY, soldOut: true };
  const buyer = lead({ budget: '90 L', fit: 88 });
  const weak = lead({ budget: '20 L', fit: 40 });
  const neg = lead({ stageId: sid('negotiation'), fit: 95 });
  const linked = lead({ fit: 90, propertyCodes: ['MADA0009'] });
  const told = lead({ fit: 90 });
  const lostBudget = lead({ stageId: sid('lost'), lostReason: 'budget', fit: 80 });
  const lostOther = lead({ stageId: sid('lost'), lostReason: 'unreachable', fit: 99 });
  const lostMessaged = lead({ stageId: sid('lost'), lostReason: 'no_match', fit: 80, lastCampaignAt: NOW - DAY });
  const match = (l, p) => (p.id === NEW.id || p.id === OLD.id || p.id === SOLD.id ? l.fit : null);
  const campaigns = [{ id: 'nl', purpose: 'new_listing', propertyId: NEW.id, createdAt: NOW - 20 * DAY, leadIds: [told.id] }];
  const all = [buyer, weak, neg, linked, told, lostBudget, lostOther, lostMessaged];
  const list = run(all, { inventory: [NEW, OLD, SOLD], match, campaigns });
  const nl = one(list, 'new_listing');
  check('a good match (70%+) among open buyers; not Negotiating; not already linked or told', JSON.stringify(ids(nl)) === JSON.stringify([buyer.id]), ids(nl));
  check('only listings added in the last 14 days and still for sale', list.filter(j => j.type === 'new_listing').length === 1 && nl.propertyId === NEW.id);
  check('copy names the listing', nl && nl.label === 'New listing MADA0009 · Radiance Phase 2' && /1 open buyer matches it well/.test(nl.why), nl && nl.why);
  const lr = one(list, 'lost_reengage');
  check('lost over budget / nothing suitable, matched, not messaged since the listing came in; unreachable with no date is not', JSON.stringify(ids(lr)) === JSON.stringify([lostBudget.id]), ids(lr));
  check('…says which listing', lr && /MADA0009 came in since/.test(lr.why), lr && lr.why);
  check('no match engine on the page → no new-listing card (never a guess)', !one(run(all, { inventory: [NEW] }), 'new_listing') && !one(run(all, { inventory: [NEW] }), 'lost_reengage'));
  check('a match engine that throws is a non-match', !one(run([buyer], { inventory: [NEW], match: () => { throw new Error('x'); } }), 'new_listing'));

  // The new-listing guards.
  const P = { id: 'NL1', propertyCode: 'NL1', name: 'Lake View', location: 'Velachery Main Road', startingPrice: '₹1.05 Cr', createdAt: NOW - 2 * DAY };
  const Q = { id: 'NL2', propertyCode: 'NL2', name: 'Hill Crest', location: 'Velachery', startingPrice: '₹95 L', createdAt: NOW - DAY };
  const m2 = () => 90;
  const ok = lead({ budget: '1 Cr', ai: { want: { areas: ['Velachery'] } } });
  const over = lead({ budget: '90 L' });                                   // ₹1.05 Cr is more than 10% over
  const away = lead({ ai: { want: { areas: ['Anna Nagar'] } } });         // wants elsewhere
  const visitSoon = lead({ siteVisitAt: NOW + DAY, siteVisitStatus: 'scheduled' });
  const talking = lead({ tt: { lastMessageAt: NOW - 30 * H } });
  const fresh = lead({ createdAt: NOW - 2 * DAY });
  const recentNl = lead({});
  const oldNl = lead({});
  const camps = [{ id: 'n1', purpose: 'new_listing', propertyId: 'X', createdAt: NOW - 10 * DAY, leadIds: [recentNl.id] },
    { id: 'n2', purpose: 'other', journey: 'new_listing', propertyId: 'Y', createdAt: NOW - 20 * DAY, leadIds: [oldNl.id] }];
  const L2 = run([ok, over, away, visitSoon, talking, fresh, recentNl, oldNl], { inventory: [P, Q], match: m2, campaigns: camps, gapDays: 0 });
  const cards = L2.filter(j => j.type === 'new_listing');
  const everyone = cards.flatMap(j => j.leadIds);
  const nl2 = cards.find(j => j.propertyId === 'NL2');
  check('budget within 10%, a wanted area, no visit coming, not talking, not brand new, no new-listing in 14 days',
    JSON.stringify([...everyone].sort()) === JSON.stringify([ok.id, over.id, oldNl.id].sort()), everyone);
  check('a lead over budget for one listing still fits the cheaper one', nl2 && nl2.leadIds.includes(over.id), cards.map(j => [j.propertyId, j.leadIds]));
  check('…and never the dearer one', !cards.some(j => j.propertyId === 'NL1' && j.leadIds.includes(over.id)));
  check('one new-listing card per lead, however many listings fit', everyone.length === new Set(everyone).size);
  const just = lead({ budget: '96 L' });  // ₹1.05 Cr is within 10% of ₹96 L
  const onlyP = one(run([over, just], { inventory: [P], match: m2 }), 'new_listing');
  check('the 10% edge: ₹96 L fits ₹1.05 Cr, ₹90 L does not', JSON.stringify(ids(onlyP)) === JSON.stringify([just.id]), ids(onlyP));
  const aiBudget = lead({ ai: { want: { budget_max: 9000000, budget_unit: 'total' } } });
  check('the AI’s budget counts when nothing is typed', !one(run([aiBudget], { inventory: [P], match: m2 }), 'new_listing'));
  check('area and budget unknown → not a reason to leave out', everyone.includes(oldNl.id));
}

section('10. lost → re-engage: unreachable at 60–90 days; stop after two unanswered');
{
  const un = (days, o = {}) => lead({ stageId: sid('lost'), lostReason: 'unreachable', stageChangedAt: NOW - days * DAY, ...o });
  const a = un(70), b = un(40), c = un(100), d = un(75, { lastCampaignAt: NOW - 10 * DAY });
  const j = one(run([a, b, c, d], { gapDays: 0 }), 'lost_reengage');
  check('unreachable lost 60–90 days ago, not messaged since — no match engine needed', JSON.stringify(ids(j)) === JSON.stringify([a.id]), ids(j));
  check('…the card says so', j && /1 unreachable 2–3 months ago/.test(j.why) && j.purpose === 'reengage', j && j.why);
  const NEW = { id: 'NN', propertyCode: 'NN', name: 'New One', createdAt: NOW - 2 * DAY };
  const e = lead({ stageId: sid('lost'), lostReason: 'budget' });
  const f = lead({ stageId: sid('lost'), lostReason: 'budget' });
  const g = lead({ stageId: sid('lost'), lostReason: 'budget', tt: { lastMessageAt: NOW - 25 * DAY } });
  const camps = [
    { id: 'r1', purpose: 'reengage', createdAt: NOW - 40 * DAY, leadIds: [e.id, f.id, g.id] },
    { id: 'r2', purpose: 'reengage', journey: 'lost_reengage', createdAt: NOW - 30 * DAY, leadIds: [e.id, g.id] }];
  const r = one(run([e, f, g], { inventory: [NEW], match: () => 90, campaigns: camps, gapDays: 0 }), 'lost_reengage');
  check('two re-engage messages unanswered → stop; one, or an answer after them → go on', JSON.stringify(ids(r)) === JSON.stringify([f.id, g.id]), ids(r));
}

section('11. won → review or referral, 7–21 days after');
{
  const a = lead({ stageId: sid('won'), reached: { won: NOW - 10 * DAY } });
  const b = lead({ stageId: sid('won'), stageChangedAt: NOW - 15 * DAY });
  const c = lead({ stageId: sid('won'), reached: { won: NOW - 3 * DAY } });
  const d = lead({ stageId: sid('won'), reached: { won: NOW - 30 * DAY } });
  const e = lead({ stageId: sid('won'), reached: { won: NOW - 12 * DAY } });
  const f = lead({ stageId: sid('won'), reached: { won: NOW - 12 * DAY }, tt: { lastMessageAt: NOW - H } });
  const j = one(run([a, b, c, d, e, f], { campaigns: [{ id: 'r', purpose: 'referral', createdAt: NOW - 2 * DAY, leadIds: [e.id] }] }), 'referral');
  check('won 7–21 days ago, never asked, not inside the free window', JSON.stringify(ids(j)) === JSON.stringify([a.id, b.id]), ids(j));
  check('Marketing — the one Marketing message a Won lead may get', j && j.category === 'MARKETING' && j.purpose === 'referral' && !j.held.some(x => x.why === 'in negotiation/won'));
  check('a Utility referral template works the same', ids(one(run([a, b], { categoryFor: p => (p === 'referral' ? 'UTILITY' : '') }), 'referral')).length === 2);
  check('the boundaries: 7 and 21 days are in', ids(one(run([lead({ stageId: sid('won'), reached: { won: NOW - 7 * DAY } }), lead({ stageId: sid('won'), reached: { won: NOW - 21 * DAY } })]), 'referral')).length === 2);
}

section('every journey: opted out, no number, dead in TailorTalk');
{
  const base = { stageId: sid('visit_done'), siteVisitAt: NOW - 3 * H, siteVisitStatus: 'done' };
  const ok1 = lead(base);
  const opted = lead({ ...base, waOptOut: true });
  const listed = lead({ ...base, phone: '9840099999' });
  const nonum = lead({ ...base, phone: '', tt: { contact: 'insta_handle' } });
  const dead = lead({ ...base, tt: { status: 'dead' } });
  const landline = lead({ ...base, phone: '044 2345 6789' });
  const j = one(run([ok1, opted, listed, nonum, dead, landline], { optOut: ['+91 98400 99999'] }), 'visit_feedback');
  check('only the reachable one (a landline is no WhatsApp number)', JSON.stringify(ids(j)) === JSON.stringify([ok1.id]), ids(j));
  check('nothing due → no card at all', run([opted]).length === 0);
  const mOpt = lead({ ...base, waMarketingOptOut: true });
  check('“no offers” keeps the Utility feedback ask…', ids(one(run([mOpt]), 'visit_feedback')).includes(mOpt.id));
  check('…but not a Marketing one', !one(run([mOpt], { categoryFor: () => 'MARKETING' }), 'visit_feedback'));
  // The page's own reading of opt-outs (window.crmLeadOptOut), passed in as optOutOf.
  const p1 = lead(base), p2 = lead(base), p3 = lead(base);
  const optOutOf = l => (l.id === p1.id ? { all: true } : l.id === p2.id ? { marketing: true } : null);
  check('optOutOf: `all` keeps a lead out of every journey', JSON.stringify(ids(one(run([p1, p2, p3], { optOutOf }), 'visit_feedback'))) === JSON.stringify([p2.id, p3.id]));
  const mk = one(run([p1, p2, p3], { optOutOf, categoryFor: () => 'MARKETING' }), 'visit_feedback');
  check('optOutOf: `marketing` only out of Marketing ones, held as “no offers”', JSON.stringify(ids(mk)) === JSON.stringify([p3.id]) && mk.held.some(x => x.id === p2.id && x.why === 'no offers'), mk);
  check('optOutOf that throws is “not opted out”', ids(one(run([p3], { optOutOf: () => { throw new Error('x'); } }), 'visit_feedback')).includes(p3.id));
}

section('order and shape');
{
  const list = run([
    lead({ stageId: sid('won'), reached: { won: NOW - 10 * DAY } }),
    lead({ stageId: sid('visit_pending'), siteVisitAt: tomorrowAt(10), siteVisitStatus: 'scheduled' }),
    lead({ stageId: sid('on_hold'), holdUntil: NOW - DAY }),
    lead({ stageId: sid('visit_pending'), siteVisitAt: NOW - 2 * H, siteVisitStatus: 'scheduled' })
  ]);
  check('time-critical first', JSON.stringify(list.map(j => j.type)) === '["no_show","visit_reminder","hold_revisit","referral"]', list.map(j => j.type));
  check('every card carries its journey key, category and free-window fields', list.every(j => j.journey && j.category && Array.isArray(j.freeNowIds) && Array.isArray(j.held) && j.action === 'send'));
  check('every journey that sends has a starter for its purpose', J.JOURNEYS.filter(j => j.purpose).every(j => C.STARTERS.some(s => s.purpose === j.purpose)), J.JOURNEYS.filter(j => j.purpose && !C.STARTERS.some(s => s.purpose === j.purpose)));
  check('journey keys are unique', new Set(J.JOURNEYS.map(j => j.journey)).size === J.JOURNEYS.length);
  check('no price-drop journey: the inventory keeps no earlier price', !J.JOURNEYS.some(j => j.purpose === 'price_drop'));
}

section('what a campaign led to');
{
  const T0 = NOW - 10 * DAY;
  const moved = lead({ stageId: sid('visit_done'), reached: { new: T0 - 20 * DAY, visit_pending: T0 + DAY, visit_done: T0 + 3 * DAY } });
  const won = lead({ stageId: sid('won'), stageChangedAt: T0 + 5 * DAY, reached: { new: T0 - 9 * DAY, negotiation: T0 - 2 * DAY } });
  const already = lead({ stageId: sid('visit_done'), reached: { visit_done: T0 - DAY } });
  const booked = lead({ stageId: sid('options'), siteVisitAt: NOW + DAY, siteVisitStatus: 'scheduled', siteVisitSetAt: T0 + 2 * DAY });
  const noDates = lead({ stageId: sid('negotiation'), stageChangedAt: T0 - DAY });
  const optedOut = lead({ waOptOut: true, waOptOutAt: T0 + 3600000 });
  const all = [moved, won, already, booked, noDates, optedOut];
  const o = J.outcomeFor(all.map(l => l.id).concat(['gone']), T0, all, STAGES);
  check('reached counts every lead id, even one since deleted', o.reached === 7);
  check('visit planned or further: moved, won', o.visit_pending === 2, o);
  check('visited: moved, won', o.visit_done === 2);
  check('negotiating: won only (the one already Negotiating before does not count)', o.negotiation === 1 && o.won === 1, o);
  check('visits booked after: moved, won, the one booked without moving', o.visits === 3, o);
  check('opted out after the campaign', o.optedOut === 1);
  check('per lead, the step reached', o.leads[moved.id] === 'visit_done' && o.leads[won.id] === 'won' && !o.leads[already.id]);
  const camp = { createdAt: T0, recipients: { [moved.id]: { status: 'replied' }, [won.id]: { status: 'read' }, [already.id]: { status: 'failed' }, m_9198: { status: 'sent', manual: true } } };
  const co = J.campaignOutcome(camp, all, STAGES);
  check('a campaign counts only those its message reached (not failed, not typed-in)', co.reached === 2 && co.won === 1 && co.replied === 1, co);
}

section('cost and quiet hours (campaignModel.js)');
{
  const m = C.estimateCost(100, 'MARKETING', {});
  check('Marketing at the default ₹0.79', m.total === 79 && m.rate === 0.79 && !m.warn);
  check('Utility at the settings’ rate', C.estimateCost(10, 'UTILITY', { utilityRate: 0.2 }).total === 2);
  check('warns above ₹500', C.estimateCost(700, 'MARKETING', {}).warn);
  check('warns above 200 people even when cheap', C.estimateCost(201, 'UTILITY', {}).warn && !C.estimateCost(200, 'UTILITY', {}).warn);
  check('rupees: paise for small, whole for big', C.rupees(23.7) === '₹23.70' && C.rupees(1234.4) === '₹1,234' && C.rupees(2) === '₹2');
  const ist = (h, m = 0) => Date.UTC(2026, 10, 5, h, m) - 5.5 * 3600000;
  check('9 PM IST is quiet, 8:59 PM is not', C.inQuietHours(ist(21), 21, 9) && !C.inQuietHours(ist(20, 59), 21, 9));
  check('8:59 AM is quiet, 9 AM is not', C.inQuietHours(ist(8, 59), 21, 9) && !C.inQuietHours(ist(9), 21, 9));
  check('defaults when the settings have none', C.inQuietHours(ist(23)) && !C.inQuietHours(ist(12)));
  check('a same-day window works too', C.inQuietHours(ist(14), 13, 15) && !C.inQuietHours(ist(16), 13, 15));
  check('hour labels', C.hourLabel(21) === '9 PM' && C.hourLabel(9) === '9 AM' && C.hourLabel(0) === '12 midnight');
  check('reply meanings', C.replyMeaning('visit') === 'Wants a site visit' && C.replyMeaning('zzz') === 'Replied');
  check('every journey’s starter passes WhatsApp’s rules with no warning',
    J.JOURNEYS.filter(j => j.purpose).every(j => { const s = C.STARTERS.find(x => x.purpose === j.purpose); const r = C.lintTemplate(s); return s && r.ok && !r.warnings.length; }));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
