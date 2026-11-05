// ═══════════════════════════════════════════════════════════════════════
// STAGE JOURNEYS — the next WhatsApp message each lead is due, suggested, never sent by itself.
//
// Pure ES module (bridged onto window.crmJourneys in crm.html, tested by tests/journeys.test.mjs).
// Given the CRM's leads, its pipeline, the campaigns already sent and the inventory, it answers one
// question for the Campaigns dashboard: "who is due which message today?" Each answer is a card
// with the leads it covers and the template purpose that fits; a person opens it in the campaign
// wizard, looks, and presses Send. Nothing here sends, and nothing is stored — the list is worked
// out again from the records every time, so it can never drift from them.
//
// "Suggest mode" on purpose: a message about a visit that was moved an hour ago, or to a lead an
// agent is on the phone with, does more harm than the one it saves. The rules below are written to
// leave someone out when in doubt — the wizard can always add them back.
//
// The timings follow a marketing review (Nov 2026): a reminder the day before and a nudge on the
// day if unconfirmed; a no-show noticed within the hour; feedback asked the same day while the
// visit is fresh, nudged once at 48 hours; options followed up at 48 hours; a buyer thanked a
// week or two after the sale, while it still feels like news.
//
// Rules every journey keeps:
//   · a lead who asked not to be messaged (lead.waOptOut, or their number on the settings' list),
//     a lead with no WhatsApp number and one marked dead in TailorTalk are never in one;
//   · a Marketing journey applies the server's own Marketing rules (holdWhy in campaignModel.js):
//     no one who asked for no offers, was offered something in the last `gapDays`, left two
//     offers unanswered, is Negotiating or Won (the referral ask excepted), or wrote to us in the
//     last 24 hours — that last one is free to answer in the chat, and a paid template is waste;
//   · a Utility journey keeps the lead who wrote in the last 24 hours, but says so (freeNowIds),
//     so the page can offer "Free now — reply in chat" instead.
//
// Matching new listings to buyers needs the match engine (shared-assets/match-engine.js), a
// classic script with its own globals. It is passed in as `match(lead, property) → percent | null`
// so this file stays pure and its tests need no browser.
//
// No price-drop journey: the inventory keeps only today's startingPrice (no earlier price or
// price history on a property row — see getInventory in firebase-sync.js), so a drop cannot be
// told from a correction. The price_drop template stays in the library for a person to send.
// ═══════════════════════════════════════════════════════════════════════

import { stageKeyOf, stageKindOf, visitOf, visitIsOpen, LADDER, HOLD_REASONS, LOST_REASONS } from './pipeline.js';
import { waNumber, STARTERS, holdWhy, inFreeWindow, leadRequirement, parseRupees, replyNeedsPerson } from './campaignModel.js';

const DAY = 86400000;
const HOUR = 3600000;
const IST_OFFSET = 5.5 * HOUR;

// Start of the India day that holds `t` — "tomorrow" is the team's tomorrow, wherever this runs.
export function istDayStart(t) { return Math.floor((t + IST_OFFSET) / DAY) * DAY - IST_OFFSET; }

// The journeys, in the order the dashboard shows them: what is time-critical first. `journey` is
// what a campaign made from the card records as campaign.journey; `purpose` picks its template
// (none for a card that asks for a phone call).
export const JOURNEYS = [
  { type: 'no_show', journey: 'no_show', purpose: 'no_show', title: 'Missed visit — offer another time' },
  { type: 'visit_today', journey: 'visit_today', purpose: 'visit_reminder', title: 'Visit today — not confirmed' },
  { type: 'visit_reminder', journey: 'visit_reminder', purpose: 'visit_reminder', title: 'Visit reminder' },
  { type: 'visit_feedback', journey: 'visit_feedback', purpose: 'visit_feedback', title: 'Visit feedback' },
  { type: 'call', journey: 'sold_out_call', purpose: null, title: 'Call these first' },
  { type: 'sold_out', journey: 'sold_out', purpose: 'sold_out', title: 'Sold out — tell interested leads' },
  { type: 'feedback_nudge', journey: 'feedback_nudge', purpose: 'feedback_nudge', title: 'Feedback nudge' },
  { type: 'options_followup', journey: 'options_followup', purpose: 'options_followup', title: 'Options follow-up' },
  { type: 'hold_revisit', journey: 'hold_revisit', purpose: 'search_checkin', title: 'On hold — check back' },
  { type: 'new_listing', journey: 'new_listing', purpose: 'new_listing', title: 'New listing for matched buyers' },
  { type: 'lost_reengage', journey: 'lost_reengage', purpose: 'reengage', title: 'Win back a lost lead' },
  { type: 'referral', journey: 'referral', purpose: 'referral', title: 'Review or referral' }
];

// The tunables, named so the tests and the card copy say the same thing.
export const RULES = {
  reminderSendFrom: 10,      // the day-before reminder goes between 10 AM…
  reminderSendTo: 19,        // …and 7 PM, India time
  todayFromHours: 2,         // on the day, an unconfirmed visit this many hours ahead…
  todayToHours: 3,           // …up to this many gets one more reminder
  noShowAfterHours: 1,       // a visit still open this long after its time, the same day, is a no-show
  feedbackAfterHours: 2,     // feedback is asked this long after the visit, until the end of the next day
  nudgeAfterHours: 48,       // feedback unanswered this long gets one nudge…
  nudgeWithinDays: 7,        // …unless it was asked longer ago than this
  optionsAfterHours: 48,     // options sent this long ago with no word back
  optionsWithinDays: 30,     // older than this is a re-engage, not a follow-up
  freshListingDays: 14,      // a listing this new counts as "new"
  goodMatch: 70,             // the match engine's "Worth a call"
  newListingQuietHours: 48,  // a buyer who wrote this recently is in a conversation — no broadcast
  newListingMinAgeDays: 3,   // a lead this new is still being worked by hand
  newListingEveryDays: 14,   // at most one new-listing message per lead in this long
  budgetSlack: 0.10,         // a listing up to 10% over their budget still fits
  unreachableFromDays: 60,   // lost as unreachable between these two ages: try once more
  unreachableToDays: 90,
  reengageUnanswered: 2,     // re-engage messages left unanswered before we stop
  referralFromDays: 7,       // won between these two ages: still news, settled enough to ask
  referralToDays: 21,
  gapDays: 7,                // the settings' marketingGapDays when none is given
  maxPropertyCards: 3        // new-listing cards (sold-out shows up to 6)
};

const LOST_FOR_REENGAGE = ['budget', 'no_match'];

// When a property was added: its createdAt, else the time baked into an id like 'p1730…' (the
// dashboard's own rule — see insertValue in dashboard-assets/app.js), else unknown (0).
export function propertyAddedAt(p) {
  if (!p) return 0;
  if (p.createdAt) return Number(p.createdAt) || 0;
  const m = /^p(\d{12,})$/.exec(String(p.id || ''));
  return m ? Number(m[1]) : 0;
}

const upper = s => String(s || '').trim().toUpperCase();
const contactOf = l => waNumber((l && (l.phone || (l.tt && l.tt.contact))) || '');
const keysOf = p => new Set([upper(p.id), upper(p.propertyCode)].filter(Boolean));

// A campaign reply is open — needs a person — until somebody on the team touches the lead after it.
// The same rule leadAttention.js uses for TailorTalk's signals: every CRM action moves
// lead.updatedAt, and neither TailorTalk nor the campaign server ever does. A thanks, a confirm,
// a "not this one" or a STOP needs nobody. One rule: campaignModel's replyNeedsPerson.
export function replyIsOpen(lead) {
  return !!lead && replyNeedsPerson(lead.campaignReply, lead);
}

// Is this lead linked to this property — by its id or code, or as the property of their visit?
export function leadHasProperty(lead, p) {
  if (!lead || !p) return false;
  const keys = keysOf(p);
  if ((lead.propertyCodes || []).some(c => keys.has(upper(c)))) return true;
  const v = visitOf(lead);
  return !!(v.property && keys.has(upper(v.property)));
}

// Does this text name the property — its code as a word, or its full name?
function mentions(text, p) {
  const t = upper(text);
  if (!t) return false;
  const code = upper(p.propertyCode || p.id);
  if (code && new RegExp('(^|[^A-Z0-9])' + code.replace(/[^A-Z0-9]/g, m => '\\' + m) + '([^A-Z0-9]|$)').test(t)) return true;
  const name = upper(p.name);
  return name.length >= 5 && t.includes(name);
}

/**
 * Was this lead really about this property — the one a sold-out notice is for? Linking a lead to
 * a property in passing (one of five sent as options) is not interest; these are:
 *   visited it · has a visit planned there · it is the FIRST property linked to them ·
 *   their enquiry named it (the ad they came from, or the property they asked about).
 * @returns {'visited'|'planned'|'first'|'enquiry'|''}
 */
export function interestIn(lead, p) {
  if (!lead || !p) return '';
  const keys = keysOf(p);
  const v = visitOf(lead);
  if (v.property && keys.has(upper(v.property))) {
    if (v.status === 'done') return 'visited';
    if (visitIsOpen(v)) return 'planned';
  }
  if (keys.has(upper((lead.propertyCodes || [])[0]))) return 'first';
  const tt = lead.tt || {};
  if (mentions(tt.adTitle, p) || mentions(tt.values && tt.values.propertyInterest, p) || mentions(lead.propertyInterest, p)) return 'enquiry';
  return '';
}

// "Velachery" in "Velachery Main Road, Chennai" — or the other way round.
function areaMatches(location, areas) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const loc = norm(location);
  if (!loc) return true;
  return areas.some(a => { const x = norm(a); return x.length >= 3 && (loc.includes(x) || x.includes(loc)); });
}

// The leads the campaigns reached, by lead id → the campaigns, newest first.
function campaignsByLead(campaigns) {
  const out = new Map();
  for (const c of [...(campaigns || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))) {
    for (const id of c.leadIds || []) {
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(c);
    }
  }
  return out;
}
const isKind = (c, ...names) => names.includes(c.journey) || names.includes(c.purpose);

/**
 * The journeys due now.
 *
 * @param {object} input
 *   leads, stages, campaigns (op 'list' rows: { id, purpose, journey?, propertyId, propertyMode,
 *   createdAt, leadIds }), inventory, now,
 *   match?           (lead, property) → match percent, or null when they do not match at all
 *   optOutOf?        (lead) → { all, marketing } — the page's reading of the lead's opt-outs
 *                    (window.crmLeadOptOut); `all` keeps the lead out of every journey,
 *                    `marketing` out of Marketing ones (held as 'no offers')
 *   optOut?          numbers on the settings' "never message" list
 *   marketingOptOut? numbers on the settings' "no offers" list
 *   gapDays?         the settings' marketingGapDays (default 7)
 *   settings?        the campaign settings — optOut / marketingOptOut / marketingGapDays are read
 *                    from it when not given on their own
 *   categoryFor?     purpose → 'MARKETING' | 'UTILITY', the category of the template that would be
 *                    used (default: the starter library's)
 * @returns {Array<{ key, type, journey, action: 'send'|'call', label, why, purpose, category,
 *   quick: 'journey', leadIds, count, freeNow, freeNowIds, held, propertyId?, window?, reasons? }>}
 *   `journey` is what campaign.journey records. `action: 'call'` cards (type 'call') carry no
 *   purpose or template: the leads are to be phoned. `freeNowIds` are the leads of a Utility card
 *   who wrote in the last 24 hours (freeNow: any). `held` lists the leads a Marketing card left
 *   out, with the server's code for why ({ id, why }). `window` { from, to } is the hour range
 *   (IST) the card's message should go in.
 */
export function dueJourneys(input = {}) {
  const now = input.now || Date.now();
  const stages = input.stages || [];
  const settings = input.settings || {};
  const inventory = (input.inventory || []).filter(Boolean);
  const optOut = new Set([...(input.optOut || settings.optOut || [])].map(waNumber).filter(Boolean));
  const marketingOptOut = new Set([...(input.marketingOptOut || settings.marketingOptOut || [])].map(waNumber).filter(Boolean));
  const gapRaw = input.gapDays != null ? input.gapDays : settings.marketingGapDays;
  const gapDays = gapRaw != null && Number.isFinite(Number(gapRaw)) ? Number(gapRaw) : RULES.gapDays;
  const byLead = campaignsByLead(input.campaigns);
  const starterCat = p => (STARTERS.find(s => s.purpose === p) || {}).category || 'UTILITY';
  const categoryFor = p => (input.categoryFor && input.categoryFor(p)) || starterCat(p);
  const match = typeof input.match === 'function' ? input.match : null;
  // The page's own reading of a lead's opt-outs (window.crmLeadOptOut) when it has one:
  // { all, marketing }. A throw or nothing is "not opted out" — the lead's fields still count.
  const optOutOf = l => { try { return (typeof input.optOutOf === 'function' && input.optOutOf(l)) || {}; } catch (e) { return {}; } };

  const stageOf = l => stages.find(s => s.id === (l && l.stageId)) || null;
  const keyOf = l => stageKeyOf(stageOf(l));
  const kindOf = l => stageKindOf(stageOf(l));
  const campaignsOf = l => byLead.get(l.id) || [];
  // A campaign reached them after `t` — by the campaigns list, or the lead's own record of one.
  const messagedSince = (l, t) => (l.lastCampaignAt || 0) > t || campaignsOf(l).some(c => (c.createdAt || 0) > t);
  const sentSince = (l, t, ...kinds) => campaignsOf(l).some(c => (c.createdAt || 0) > t && isKind(c, ...kinds));
  const wroteSince = (l, t) => ((l.tt && l.tt.lastMessageAt) || 0) > t;
  // Somebody on the team did something on the lead after `t` (a visit marked done at `setAt` is
  // the record of the visit, not a conversation after it).
  const personActedAfter = (l, t, setAt) => (l.updatedAt || 0) > Math.max(t, setAt || 0) + 2 * 60000
    || ((l.lastNote && l.lastNote.createdAt) || 0) > t;

  // Everyone a message could reach at all.
  const reachable = (input.leads || []).filter(l => {
    if (!l || !l.id || l.waOptOut || optOutOf(l).all) return false;
    const c = contactOf(l);
    if (!c || optOut.has(c)) return false;
    return !(l.tt && l.tt.status === 'dead');
  });
  const marketingWhy = (l, purpose) => (optOutOf(l).marketing ? { code: 'no offers', text: 'Asked for no more offers' } : null) || holdWhy(l, contactOf(l), { marketing: true, optOut, marketingOptOut, gapDays, now, stageKey: keyOf, purpose });

  const out = [];
  const push = (type, leadsIn, label, why, extra) => {
    const def = JOURNEYS.find(j => j.type === type);
    const category = def.purpose ? categoryFor(def.purpose) : null;
    let list = leadsIn;
    const held = [];
    if (category === 'MARKETING') {
      list = leadsIn.filter(l => { const w = marketingWhy(l, def.purpose); if (w) held.push({ id: l.id, why: w.code }); return !w; });
    }
    if (!list.length) return;
    const n = list.length;
    const freeNowIds = category === 'MARKETING' ? [] : list.filter(l => inFreeWindow(l, now)).map(l => l.id);
    out.push({
      key: type + (extra && extra.propertyId ? ':' + extra.propertyId : ''), type, journey: def.journey,
      action: def.purpose ? 'send' : 'call', purpose: def.purpose, category,
      quick: 'journey', leadIds: list.map(l => l.id), count: n, freeNow: freeNowIds.length > 0, freeNowIds, held,
      label: typeof label === 'function' ? label(n) : label, why: typeof why === 'function' ? why(n, list) : why,
      ...(extra || {})
    });
  };
  const s = n => (n === 1 ? '' : 's');
  const dayStart = istDayStart(now);
  const confirmedFor = (l, v) => (l.siteVisitConfirmedAt || 0) > (v.setAt || 0);

  // 1. Missed visit: still open an hour after its time, the same day. Not if a person has touched
  //    the lead since the visit time (they know), or it was already sent for this visit.
  {
    const list = reachable.filter(l => {
      const v = visitOf(l);
      if (!visitIsOpen(v) || kindOf(l) === 'lost' || istDayStart(v.at) !== dayStart) return false;
      if (now < v.at + RULES.noShowAfterHours * HOUR) return false;
      if ((l.updatedAt || 0) > v.at) return false;
      return !sentSince(l, v.at, 'no_show');
    });
    push('no_show', list, n => `${n} missed today’s visit`, 'Their visit time passed an hour ago and it is not marked done — offer another time');
  }

  // 2. Visit today in 2–3 hours, not confirmed, and not reminded today.
  {
    const list = reachable.filter(l => {
      const v = visitOf(l);
      if (!visitIsOpen(v) || kindOf(l) === 'lost' || istDayStart(v.at) !== dayStart) return false;
      if (v.at < now + RULES.todayFromHours * HOUR || v.at > now + RULES.todayToHours * HOUR) return false;
      if (confirmedFor(l, v)) return false;
      return !sentSince(l, Math.max(dayStart, v.setAt || 0), 'visit_today', 'visit_reminder', 'visit_confirmed');
    });
    push('visit_today', list, n => `${n} visit${s(n)} in the next 3 hours, not confirmed`, 'One more reminder with the time and who will meet them');
  }

  // 3. Visit tomorrow, not yet reminded. A reminder sent before the visit was last moved does not
  //    count — they were reminded of the old time. Sent the day before, 10 AM – 7 PM.
  {
    const t0 = dayStart + DAY, t1 = t0 + DAY;
    const list = reachable.filter(l => {
      const v = visitOf(l);
      if (!visitIsOpen(v) || v.at < t0 || v.at >= t1 || kindOf(l) === 'lost') return false;
      const from = v.setAt || v.at - 3 * DAY;
      return !sentSince(l, from, 'visit_reminder', 'visit_confirmed', 'visit_today');
    });
    push('visit_reminder', list, n => `${n} visit${s(n)} tomorrow`, 'Send each one the reminder with their time — not reminded yet',
      { window: { from: RULES.reminderSendFrom, to: RULES.reminderSendTo }, note: 'Send between 10 AM and 7 PM' });
  }

  // 4. Visited today (2+ hours ago) or yesterday: ask how it was while it is fresh. Not when the
  //    team has already been in touch since the visit (a note, any change after marking it done),
  //    they have written to us since, or a campaign has gone since; not once Negotiating.
  {
    const list = reachable.filter(l => {
      const v = visitOf(l), k = kindOf(l);
      if (v.status !== 'done' || !v.at) return false;
      if (now < v.at + RULES.feedbackAfterHours * HOUR || now >= istDayStart(v.at) + 2 * DAY) return false;
      if (k === 'lost' || k === 'won' || keyOf(l) === 'negotiation') return false;
      return !personActedAfter(l, v.at, v.setAt) && !wroteSince(l, v.at) && !messagedSince(l, v.at);
    });
    push('visit_feedback', list, n => `${n} visit${s(n)} today or yesterday with no feedback asked`, 'Ask each one how the property was — while it is fresh');
  }

  // 5. A property gone sold out (one card per property): the leads who were really about it and
  //    have not been told. Those Negotiating or with a visit planned there get a phone call, not
  //    a broadcast — their card comes first.
  {
    const cards = [];
    for (const p of inventory.filter(x => x.soldOut)) {
      const told = l => campaignsOf(l).some(c => c.propertyId === p.id || (isKind(c, 'sold_out') && c.propertyMode === 'own'));
      const call = [], send = [];
      for (const l of reachable) {
        const k = keyOf(l);
        if (kindOf(l) === 'won' || told(l)) continue;
        const why = interestIn(l, p);
        if ((k === 'negotiation' || k === 'visit_pending') && (why || leadHasProperty(l, p))) call.push(l);
        else if (why) send.push(l);
      }
      if (call.length || send.length) cards.push([p, call, send]);
    }
    const name = p => `${p.propertyCode ? p.propertyCode + ' · ' : ''}${p.name || p.location || 'A property'}`;
    cards.sort((a, b) => (b[1].length + b[2].length) - (a[1].length + a[2].length)).slice(0, 6).forEach(([p, call, send]) => {
      if (call.length) {
        push('call', call, `Call these first — ${name(p)} is sold out`,
          n => `${n} lead${s(n)} Negotiating or with a visit planned there — tell them yourself and offer what is close`,
          { propertyId: p.id, about: 'sold_out' });
      }
      if (send.length) {
        push('sold_out', send, `${name(p)} is sold out`, (n, list) => {
          const visited = list.filter(l => interestIn(l, p) === 'visited').length;
          return `${n} interested lead${s(n)} not yet told` + (visited ? ` · ${visited} visited` : '');
        },
          { propertyId: p.id });
      }
    });
  }

  // 6. Feedback asked 48 hours – 7 days ago, no reply and nothing sent since: one gentle nudge.
  //    Leads who have since moved to Negotiating, Won, Lost or On hold are past the question.
  {
    const list = reachable.filter(l => {
      if (['negotiation', 'won', 'lost', 'on_hold'].includes(keyOf(l))) return false;
      const asked = campaignsOf(l).find(c => isKind(c, 'visit_feedback'));
      if (!asked) return false;
      const t = asked.createdAt || 0;
      if (t > now - RULES.nudgeAfterHours * HOUR || t < now - RULES.nudgeWithinDays * DAY) return false;
      const r = l.campaignReply;
      if (r && (r.campaignId === asked.id || (r.at || 0) >= t)) return false;
      if ((l.campaignLog || []).some(e => e && e.id === asked.id && e.status === 'replied')) return false;
      if (wroteSince(l, t)) return false;
      return !campaignsOf(l).some(c => (c.createdAt || 0) > t);
    });
    push('feedback_nudge', list, n => `${n} didn’t answer the feedback request`, 'Asked 2+ days ago with no reply — one gentle nudge');
  }

  // 7. In "Options sent" for 48 hours – 30 days, and neither a word from them nor a campaign since.
  {
    const list = reachable.filter(l => {
      if (keyOf(l) !== 'options') return false;
      const since = l.stageChangedAt || (l.reached && l.reached.options) || l.createdAt || 0;
      if (!since || since > now - RULES.optionsAfterHours * HOUR || since < now - RULES.optionsWithinDays * DAY) return false;
      return !wroteSince(l, since) && !messagedSince(l, since);
    });
    push('options_followup', list, n => `${n} sent options 2+ days ago, no reply`, 'Ask whether any of them suit — or offer a visit');
  }

  // 8. On hold, and the date they asked us to come back has come. The card says why they paused.
  {
    const list = reachable.filter(l => kindOf(l) === 'hold' && l.holdUntil && l.holdUntil <= now && !messagedSince(l, l.holdUntil));
    const reasonOf = l => HOLD_REASONS[l.holdReason] || (l.holdReason ? String(l.holdReason) : 'No reason noted');
    const reasons = Object.fromEntries(list.map(l => [l.id, reasonOf(l)]));
    push('hold_revisit', list, n => `${n} on hold — time to check back`, (n, kept) => {
      const counts = new Map();
      kept.forEach(l => counts.set(reasonOf(l), (counts.get(reasonOf(l)) || 0) + 1));
      return 'The date they asked us to wait until has come · ' + [...counts].map(([r, c]) => (kept.length > 1 ? `${r} (${c})` : r)).join(', ');
    }, { reasons });
  }

  // New listings: added in the last 14 days and still for sale.
  const fresh = inventory.filter(p => !p.soldOut && propertyAddedAt(p) >= now - RULES.freshListingDays * DAY && propertyAddedAt(p) <= now)
    .sort((a, b) => propertyAddedAt(b) - propertyAddedAt(a));
  const pct = (l, p) => { try { const v = match(l, p); return typeof v === 'number' ? v : -1; } catch (e) { return -1; } };

  // 9. A new listing for open buyers it fits: a good match (70%+), within 10% of their budget and
  //    in an area they want (each when known). Not someone already linked to it or told; not one
  //    with a visit coming up, in a conversation (wrote in 48 hours), or newer than 3 days; and at
  //    most one new-listing message per lead per 14 days — so a lead fits at most one card.
  if (match && fresh.length) {
    const open = reachable.filter(l => {
      if (kindOf(l) !== 'open' || visitIsOpen(visitOf(l))) return false;
      if (wroteSince(l, now - RULES.newListingQuietHours * HOUR)) return false;
      if (l.createdAt && l.createdAt > now - RULES.newListingMinAgeDays * DAY) return false;
      return !sentSince(l, now - RULES.newListingEveryDays * DAY, 'new_listing');
    });
    const fits = (l, p) => {
      const req = leadRequirement(l);
      const price = parseRupees(p.startingPrice, 'min');
      if (req.budgetMax && price && price > req.budgetMax * (1 + RULES.budgetSlack)) return false;
      return !req.areas.length || !p.location || areaMatches(p.location, req.areas);
    };
    const cards = [];
    for (const p of fresh) {
      const list = open.filter(l => !leadHasProperty(l, p) && !campaignsOf(l).some(c => c.propertyId === p.id) && pct(l, p) >= RULES.goodMatch && fits(l, p));
      if (list.length) cards.push([p, list]);
    }
    const used = new Set();
    cards.sort((a, b) => b[1].length - a[1].length).map(([p, list]) => {
      const mine = list.filter(l => !used.has(l.id));
      mine.forEach(l => used.add(l.id));
      return [p, mine];
    }).filter(([, list]) => list.length).slice(0, RULES.maxPropertyCards).forEach(([p, list]) => {
      push('new_listing', list, `New listing ${p.propertyCode ? p.propertyCode + ' · ' : ''}${p.name || p.location || ''}`.trim(),
        n => `${n} open buyer${s(n)} ${n === 1 ? 'matches' : 'match'} it well — not told yet`, { propertyId: p.id });
    });
  }

  // 10. Win back a lost lead: lost over budget or "nothing suitable" and a listing that fits them
  //     has come in since (not messaged since it arrived); or lost as unreachable 60–90 days ago
  //     (not messaged since). Never after two re-engage messages they did not answer.
  {
    const names = new Set();
    let unreachable = 0;
    const lastAnswer = l => Math.max((l.tt && l.tt.lastMessageAt) || 0, (l.campaignReply && l.campaignReply.at) || 0);
    const gaveUp = l => campaignsOf(l).filter(c => isKind(c, 'reengage', 'lost_reengage') && (c.createdAt || 0) > lastAnswer(l)).length >= RULES.reengageUnanswered;
    const list = reachable.filter(l => {
      if (kindOf(l) !== 'lost' || gaveUp(l)) return false;
      if (LOST_FOR_REENGAGE.includes(l.lostReason)) {
        if (!match || !fresh.length) return false;
        const hit = fresh.find(p => pct(l, p) >= RULES.goodMatch);
        if (!hit || messagedSince(l, propertyAddedAt(hit))) return false;
        names.add(hit.propertyCode || hit.name || hit.id);
        return true;
      }
      if (l.lostReason === 'unreachable') {
        const lostAt = l.lostAt || l.stageChangedAt || 0;
        if (!lostAt || lostAt > now - RULES.unreachableFromDays * DAY || lostAt < now - RULES.unreachableToDays * DAY) return false;
        if (messagedSince(l, lostAt)) return false;
        unreachable++;
        return true;
      }
      return false;
    });
    push('lost_reengage', list, n => `${n} lost lead${s(n)} worth one more try`, () => [
      names.size ? `Lost over budget or nothing suitable — ${[...names].slice(0, 3).join(', ')} came in since` : '',
      unreachable ? `${unreachable} ${LOST_REASONS.unreachable.toLowerCase()} 2–3 months ago` : ''
    ].filter(Boolean).join(' · '));
  }

  // 11. Won 7–21 days ago and never asked for a review or referral. Marketing, but the one
  //     Marketing message a Won lead may get.
  {
    const list = reachable.filter(l => {
      if (kindOf(l) !== 'won') return false;
      const wonAt = (l.reached && l.reached.won) || l.stageChangedAt || 0;
      if (!wonAt || wonAt > now - RULES.referralFromDays * DAY || wonAt < now - RULES.referralToDays * DAY) return false;
      return !campaignsOf(l).some(c => isKind(c, 'referral'));
    });
    push('referral', list, n => `${n} bought in the last 3 weeks — ask for a review or referral`, 'Still fresh news for them; a happy buyer is the best introduction');
  }

  return out;
}

// ─── what a campaign led to ────────────────────────────────────────────

const OUTCOME_KEYS = ['visit_pending', 'visit_done', 'negotiation', 'won'];

// How far one lead moved on after `t`: the furthest ladder step reached after it (from the lead's
// milestone dates, or its current column when it moved there after `t`), against the furthest it
// had reached by then. Returns the step index moved to, or -1 when it did not move forward.
export function progressAfter(lead, stages, t) {
  if (!lead) return -1;
  const reached = lead.reached || {};
  let before = -1, after = -1;
  LADDER.forEach((k, i) => {
    const at = reached[k];
    if (!at) return;
    if (at <= t) before = Math.max(before, i);
    else after = Math.max(after, i);
  });
  const stage = (stages || []).find(s => s.id === lead.stageId);
  const cur = LADDER.indexOf(stageKeyOf(stage));
  if (cur >= 0 && (lead.stageChangedAt || 0) > t) after = Math.max(after, cur);
  else if (cur >= 0 && !Object.keys(reached).length) before = Math.max(before, cur);
  return after > before ? after : -1;
}

/**
 * What happened, after `since`, to the leads a campaign reached.
 * @returns {{ reached, replied, optedOut, visits, visit_pending, visit_done, negotiation, won, leads }}
 *   visit_pending … won count leads that got AT LEAST that far after the campaign; `visits` counts
 *   leads with a site visit booked after it (or that moved to Visit planned or beyond).
 */
export function outcomeFor(leadIds, since, leads, stages) {
  const byId = new Map((leads || []).map(l => [l.id, l]));
  const res = { reached: 0, replied: 0, optedOut: 0, visits: 0, visit_pending: 0, visit_done: 0, negotiation: 0, won: 0, leads: {} };
  for (const id of new Set(leadIds || [])) {
    const l = byId.get(id);
    res.reached++;
    if (!l) continue;
    if (l.waOptOut && (l.waOptOutAt || 0) > since) res.optedOut++;
    const step = progressAfter(l, stages, since);
    OUTCOME_KEYS.forEach(k => { if (step >= LADDER.indexOf(k)) res[k]++; });
    const v = visitOf(l);
    const booked = !!(v.at && v.status !== 'cancelled' && (v.setAt || 0) > since);
    if (booked || step >= LADDER.indexOf('visit_pending')) res.visits++;
    if (step >= 0) res.leads[id] = LADDER[step];
  }
  return res;
}

// The same, for one campaign document: only the people a message actually reached count.
export function campaignOutcome(campaign, leads, stages) {
  const rec = (campaign && campaign.recipients) || {};
  const ids = Object.entries(rec).filter(([, r]) => r && !r.manual && ['sent', 'delivered', 'read', 'replied'].includes(r.status)).map(([k]) => k);
  const res = outcomeFor(ids, (campaign && campaign.createdAt) || 0, leads, stages);
  res.replied = Object.values(rec).filter(r => r && r.status === 'replied').length;
  return res;
}
