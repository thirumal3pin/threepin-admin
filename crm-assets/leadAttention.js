// ═══════════════════════════════════════════════════════════════════════
// WHAT NEEDS A PERSON — one rule book for the board, the action queue and
// the daily digest.
//
// Pure ES module (bridged onto window.leadAttention in crm.html, imported by
// api/followup-digest.js). Given a lead and the pipeline, returns every
// reason someone should act on it, most urgent first. Nothing is stored:
// the list is recomputed from the lead record each time, so it can never
// drift from the lead.
//
// How "handled" works everywhere: a reason is open only while nobody on the
// team has touched the lead since the reason appeared. Every CRM action
// (note, stage, follow-up, edit, "Handled") moves lead.updatedAt; TailorTalk
// and the AI never move it.
// ═══════════════════════════════════════════════════════════════════════

import { stageKeyOf, stageKindOf, stageDef, visitOf } from './pipeline.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const IST_OFFSET = 5.5 * HOUR;

export const SEVERITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 };

// Labels for custom-trigger signals; the CRM page passes richer ones.
const DEFAULT_SIGNAL_LABELS = {
  moment: 'Key moment in the chat',
  team_promise: 'Team promised the lead something',
  needs_human: 'Needs a person now',
  site_visit: 'Site visit asked or agreed',
  ready_to_close: 'Ready to negotiate or book',
  no_match: 'Nothing matched what they want',
  owner_listing: 'Owner wants to sell or rent out',
  revisit_later: 'Asked to come back later',
  lost_deal: 'Says they stopped looking',
  loan_help: 'Needs a home loan',
  shared_listing: 'Asked about a specific listing',
  ai_quality: 'AI answer disputed',
  wants_contact: 'Wants a call or visit',
  details_request: 'Asked for property details',
  seller_lead: 'Owner wants to sell or list',
  lost_signal: 'Might be lost'
};

export function isBusinessLead(lead) {
  return !!(lead && lead.tt && lead.tt.id && lead.tt.category && String(lead.tt.category).toLowerCase() !== 'sales')
    || (lead && lead.enquiryType === 'Vendor / Collaboration');
}

const isTtLead = l => !!(l && l.tt && l.tt.id);

function endOfIstDay(now) {
  return Math.floor((now + IST_OFFSET) / DAY) * DAY - IST_OFFSET + DAY - 1;
}

function ago(ms) {
  const h = Math.round(ms / HOUR);
  if (h < 1) return 'under an hour';
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${Math.round(ms / DAY)} days`;
}

// The team's next step is "open" from when the AI last changed it until the
// team next touches the lead.
export function teamOwes(lead) {
  const next = lead && lead.ai && lead.ai.next;
  if (!next || next.owner !== 'team' || !next.action) return null;
  if ((lead.updatedAt || 0) > (next.setAt || 0)) return null;
  return next;
}

// ── A reply to a WhatsApp campaign ──
// The server (api/_campaign-loop.js) reads the reply, files it under one of these actions and
// keeps the newest on lead.campaignReply. Open by exactly the rule above: it happened after the
// team last touched the lead (and after the import's look-back), and the server never moves
// updatedAt when it writes campaign fields — so the first person to act on the lead closes it.
//   label    what the bell, the board and the digest say, given the campaign's name in quotes
//   means    the short form, for the lead's campaign history
//   next     the step to take, for Daily task
//   severity "not now" has its own follow-up a month out — it stays off the "do it today" pile
//   info     something to KNOW, not a job: shown, but never counted as "needs a person" (an
//            opt-out, "stop offers", "not this one"). The server has already acted on all three.
//   aside    for an info line, what has already happened, in a few words
//   silent   "ok", "thanks", a visit confirmed — recorded in the history, never an item at all
const CR_ACTIONS = {
  call:       { means: 'Asked for a call',            next: 'Call them',                                      label: c => `Asked for a call after ${c}` },
  visit:      { means: 'Wants a site visit',          next: 'Call to fix a time for the visit',               label: c => `Wants a site visit after ${c}` },
  options:    { means: 'Wants options or details',    next: 'Send matching options or the details',           label: c => `Wants options or details after ${c}` },
  feedback:   { means: 'Gave feedback',               next: 'Read it and reply — call if it needs one',        label: (c, r) => `Replied ${quote(r.text, 40)} to ${/feedback/i.test(`${r.template || ''} ${r.campaignName || ''}`) ? 'visit feedback' : c}` },
  not_now:    { means: 'Said not now',                next: 'Nothing today — a follow-up is set for later',    label: c => `Said not now to ${c}`, severity: 'medium' },
  found:      { means: 'Says they found a property',  next: 'Confirm, then mark the lead Lost',                label: c => `Says they found a property — replied to ${c}` },
  reschedule: { means: 'Wants to reschedule the visit', next: 'Agree a new time for the visit',               label: () => 'Wants to reschedule the site visit' },
  referral:   { means: 'Wants to refer someone',      next: 'Call and get their friend’s name & number',       label: () => 'Wants to refer someone — get the name & number' },
  seller:     { means: 'Wants to sell or list a property', next: 'Call about their property — where, what, the price they want', label: () => 'Wants to sell/list a property' },
  loan:       { means: 'Needs home-loan help',        next: 'Call and talk them through the home loan',        label: () => 'Needs home-loan help' },
  not_this:   { means: 'Not interested in this one',  next: 'Nothing to do — other offers still go to them',   label: (c, r) => `Not interested in ${r.property || r.code ? quote(r.property || r.code, 48) : c} — noted`,
                severity: 'medium', info: true, aside: 'other offers still go to them' },
  marketing_optout: { means: 'Asked to stop offers',  next: 'Nothing to do — no more offers; visit messages still go', label: () => 'Asked to stop offers (visit messages still OK)',
                severity: 'medium', info: true, aside: 'no more offers — visit reminders and feedback still go' },
  optout:     { means: 'Asked to stop messages',      next: 'Nothing to do — campaigns leave them out from now on', label: () => 'Wants to stop WhatsApp messages',
                severity: 'medium', info: true, aside: 'campaigns leave them out from now on' },
  ack:        { means: 'Said OK / thanks',            next: 'Nothing to do',                                   label: c => `Said OK to ${c}`, severity: 'low', info: true, silent: true },
  other:      { means: 'Replied',                     next: 'Read the reply and answer it',                    label: c => `Replied to ${c}` }
};
// A lead in Negotiating or Won who says they "found a property" has most likely found OURS.
const FOUND_BOOKED = { means: 'Says they booked', next: 'Call — find out whether it was with us', label: () => 'Says they booked — check if it was with us' };

/** The reply actions that never need a person — counted nowhere as "needs a person". The Campaigns
 *  dashboard (campaignModel.js) uses this same set, so the bell, Daily task and it agree. */
export const REPLY_NO_PERSON = ['ack', 'optout', 'marketing_optout', 'not_this'];

function quote(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return '“' + (t.length > max ? t.slice(0, max - 1) + '…' : t) + '”';
}

/**
 * The meaning of a campaign reply action: { key, means, next, severity, info, silent, aside, label(reply) }.
 * `ctx.stageKey` (the lead's column) changes what "found a property" means.
 */
export function campaignReplyMeta(action, ctx = {}) {
  const key = CR_ACTIONS[action] ? action : 'other';
  const a = key === 'found' && ['negotiation', 'won'].includes(ctx && ctx.stageKey) ? { ...CR_ACTIONS.found, ...FOUND_BOOKED } : CR_ACTIONS[key];
  return {
    key, means: a.means, next: a.next, severity: a.severity || 'high',
    info: !!a.info, silent: !!a.silent, aside: a.aside || '',
    label: r => a.label(quote((r && (r.campaignName || r.template)) || 'a campaign', 48), r || {})
  };
}

/** lead.campaignReply while it still needs a person (or noting), else null. An "ok"/"thanks" never does. */
export function openCampaignReply(lead) {
  const r = lead && lead.campaignReply;
  if (!r || !r.at || r.action === 'ack') return null;
  const since = Math.max(lead.updatedAt || 0, (lead.tt && lead.tt.attentionFrom) || 0);
  return r.at > since ? r : null;
}

/** THE rule for "this campaign reply needs a person": open, and not one of REPLY_NO_PERSON. The
 *  bell, Daily task and the board count with it; the Campaigns dashboard uses the same set. */
export function replyNeedsPerson(lead) {
  const r = openCampaignReply(lead);
  return !!r && !REPLY_NO_PERSON.includes(r.action);
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A time the reply named ("after 6", "tomorrow morning") — reply.followUpAt — while it is still ahead. */
export function replyCallAt(reply, now = Date.now()) {
  const t = reply && Number(reply.followUpAt);
  return t && isFinite(t) && t > now ? t : null;
}
/** "6 PM today", "10:30 AM tomorrow", "Sat 5 Dec, 10 AM" — in India time, wherever this runs. */
export function callAtText(ts, now = Date.now()) {
  const d = new Date(ts + IST_OFFSET);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const t = `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
  const days = Math.floor((ts + IST_OFFSET) / DAY) - Math.floor((now + IST_OFFSET) / DAY);
  if (days === 0) return `${t} today`;
  if (days === 1) return `${t} tomorrow`;
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}, ${t}`;
}

/**
 * @param {object} lead
 * @param {object} ctx  { stages, now, signalLabel?: (key) => string }
 * @returns {Array<{key, severity, label, detail, at}>} most urgent first
 */
export function computeAttention(lead, ctx = {}) {
  if (!lead) return [];
  const now = ctx.now || Date.now();
  const stages = ctx.stages || [];
  const stage = stages.find(s => s.id === lead.stageId) || null;
  const key = stageKeyOf(stage);
  const kind = stageKindOf(stage);
  const closed = kind === 'won' || kind === 'lost';
  const out = [];
  const add = (k, severity, label, detail = null, at = null) => { const it = { key: k, severity, label, detail, at }; out.push(it); return it; };

  const tt = lead.tt || null;
  const ai = lead.ai || null;
  const touched = lead.updatedAt || 0;
  const since = Math.max(touched, (tt && tt.attentionFrom) || 0);
  const business = isBusinessLead(lead);

  // A campaign reply asks for a person whatever column the lead is in — a Lost lead answering
  // "share similar options" is exactly what a re-engagement campaign is sent for.
  // A time they named ("call me after 6") is when the call is due: until then the item says
  // "Call at 6 PM today" and is not urgent. "OK" / "thanks" is no item at all; an opt-out or
  // "not this one" is a line to know (info), never counted as needing a person.
  const reply = openCampaignReply(lead);
  const replyNeeds = !!reply && !REPLY_NO_PERSON.includes(reply.action);
  if (reply) {
    const m = campaignReplyMeta(reply.action, { stageKey: key });
    const callAt = replyCallAt(reply, now);
    const said = reply.text ? quote(reply.text, 120) : null;
    if (!m.silent) {
      const item = add('campaign_reply', callAt && m.severity === 'high' ? 'medium' : m.severity, m.label(reply),
        callAt ? `Call at ${callAtText(callAt, now)}${said ? ' · ' + said : ''}` : said, callAt || reply.at);
      if (m.info) item.info = true;
    }
  }

  // Follow-ups the team set apply to every lead, including vendors. One the reply itself set
  // ("Asked for a call — …", due now) is that same job, said already by the line above.
  const fuOverdue = !closed && lead.followUpAt && lead.followUpAt < now
    && !(replyNeeds && lead.followUpBy === 'campaign');

  if (business) {
    if (fuOverdue) add('followup_overdue', 'high', 'Follow-up overdue', `was due ${ago(now - lead.followUpAt)} ago`, lead.followUpAt);
    return sortAttention(out);
  }

  // ── The team's promised next step ──
  const owes = closed ? null : teamOwes(lead);
  if (owes) {
    const due = owes.dueAt || null;
    if (due && due < now) add('promise_overdue', 'critical', `Overdue: ${owes.action}`, `was due ${ago(now - due)} ago`, due);
    else add('team_owes', due && due - now < 3 * HOUR ? 'high' : 'medium', `To do: ${owes.action}`, null, due);
  }

  // WhatsApp only allows a free-form reply within 24 h of the lead's last message.
  if (owes && tt && tt.integration === 'whatsapp' && tt.lastMessageAt) {
    const left = tt.lastMessageAt + DAY - now;
    if (left > 0 && left < 3 * HOUR) add('window_closing', 'critical', 'WhatsApp reply window closes soon', `${ago(left)} left to reply without a template`, tt.lastMessageAt + DAY);
  }

  if (fuOverdue && !(owes && owes.dueAt && Math.abs(owes.dueAt - lead.followUpAt) < HOUR)) {
    add('followup_overdue', 'high', 'Follow-up overdue', `was due ${ago(now - lead.followUpAt)} ago`, lead.followUpAt);
  }

  if (tt && !closed) {
    if (tt.awaitingTeamAt && tt.awaitingTeamAt > since) add('waiting_for_team', 'high', 'Lead is waiting — the AI did not reply', `since ${ago(now - tt.awaitingTeamAt)}`, tt.awaitingTeamAt);
    if (tt.escalated && tt.escalatedAt && tt.escalatedAt > since) add('escalated', 'high', `Escalated in TailorTalk${tt.escalatedTo ? ' to ' + tt.escalatedTo : ''}`, null, tt.escalatedAt);
    if (tt.flagged && tt.flaggedAt && tt.flaggedAt > since) add('flagged', 'high', `Flagged${tt.flagDetails ? ': ' + tt.flagDetails : ''}`, null, tt.flaggedAt);
    for (const [sigKey, s] of Object.entries(tt.signals || {})) {
      if (s && s.at > since) {
        const label = (ctx.signalLabel && ctx.signalLabel(sigKey)) || DEFAULT_SIGNAL_LABELS[sigKey] || sigKey;
        add(`signal:${sigKey}`, 'high', label, s.quote || s.reply || null, s.at);
      }
    }
  }

  // ── Stage-specific checks, the way a sales manager reviews a board ──
  const inStageSince = lead.stageChangedAt || lead.createdAt || 0;
  const lastActivity = Math.max(touched, (tt && tt.lastMessageAt) || 0, (tt && tt.lastReplyAt) || 0, lead.stageChangedAt || 0);
  // The visit is the lead's own field now, not a corner of the AI's verdict, so a date an
  // agent fixed by hand raises these the same as one the AI read out of the chat.
  const visit = visitOf(lead);

  // An agent who cannot make the visit is the office's problem, not theirs: it
  // needs somebody else sent, or the client told. Google will not ring anyone
  // about it, so the refusal surfaces here, where the board, the action queue
  // and the daily digest all read from.
  const declined = (Array.isArray(lead.siteVisitReplies) ? lead.siteVisitReplies : [])
    .filter(r => r && r.status === 'declined')
    .map(r => ({ who: String(r.email || '').split('@')[0], why: r.reason || '' }));
  if (declined.length && visit.at && visit.at > now - HOUR && visit.status !== 'cancelled') {
    // The reason belongs in the line itself. "Pradeep turned it down" makes
    // somebody go and ask why; "Pradeep turned it down: in Tambaram until four"
    // tells them whether to send another agent or move the whole visit.
    const said = declined.map(d => d.who + (d.why ? ': ' + d.why : '')).join(' · ');
    add('visit_declined', 'high',
      declined.length === 1 ? 'Agent cannot make the site visit' : 'Agents cannot make the site visit',
      said + (declined.some(d => d.why) ? '' : ' — send somebody else or move it'), visit.at);
  }

  if (key === 'visit_pending') {
    if (visit && visit.at && visit.at < now - 3 * HOUR && touched < visit.at) {
      add('visit_outcome', 'high', 'Did the site visit happen?', `it was set for ${ago(now - visit.at)} ago — record the outcome`, visit.at);
    } else if (!(visit && visit.at) && now - inStageSince > DAY && !owes) {
      add('visit_unscheduled', 'medium', 'Fix a time for the site visit', `pending for ${ago(now - inStageSince)}`, inStageSince);
    }
  }
  // The column exists to make "they asked, we have not sent it" visible. A day
  // is generous for sending a location or a floor plan.
  if (key === 'send_details' && now - inStageSince > DAY && !owes) {
    add('details_owed', 'high', 'Send the details they asked for', `waiting ${ago(now - inStageSince)}`, inStageSince);
  }
  // A lead parked here is waiting on US. Three days is the point at which we
  // either have something or owe them an honest word.
  if (key === 'sourcing' && now - inStageSince > 3 * DAY) {
    add('sourcing_stale', 'high', 'Still nothing to show — source it or tell them',
      `looking for ${ago(now - inStageSince)}`, inStageSince);
  }
  if (key === 'visit_done' && now - inStageSince > 2 * DAY && now - lastActivity > 2 * DAY && !owes) {
    add('feedback_due', 'medium', 'Get feedback on the visit', `nothing for ${ago(now - lastActivity)}`, lastActivity);
  }
  if (key === 'negotiation' && now - lastActivity > 3 * DAY) {
    add('negotiation_stalled', 'medium', 'Negotiation has gone quiet', `nothing for ${ago(now - lastActivity)}`, lastActivity);
  }
  if (key === 'on_hold' && lead.holdUntil && lead.holdUntil <= endOfIstDay(now) && touched < lead.holdUntil) {
    add('hold_due', 'medium', lead.holdUntil < now - DAY ? 'Revisit is overdue' : 'Revisit today', null, lead.holdUntil);
  }

  if (!closed && key !== 'on_hold') {
    const nextOwner = ai && ai.next && ai.next.owner;
    if (tt && nextOwner === 'lead' && ['options', 'send_details', 'visit_pending', 'visit_done', 'negotiation'].includes(key)
        && tt.lastMessageAt && now - tt.lastMessageAt > 3 * DAY && (tt.lastReplyAt || 0) > tt.lastMessageAt && touched < now - 3 * DAY) {
      add('lead_silent', 'low', 'No reply from the lead — nudge', `silent for ${ago(now - tt.lastMessageAt)}`, tt.lastMessageAt);
    }
    if (!tt && now - touched > 21 * DAY && !(lead.followUpAt && lead.followUpAt > now)) {
      add('stale', 'low', 'Untouched — review or close', `last worked ${ago(now - touched)} ago`, touched);
    }
  }

  if (ai && ai.suggestion && ai.suggestion.stage && ai.suggestion.stage !== key) {
    const def = stageDef(ai.suggestion.stage);
    add('ai_suggestion', 'low', `AI suggests: ${def ? def.name : ai.suggestion.stage}`, ai.suggestion.evidence || null, ai.suggestion.at || null);
  }

  return sortAttention(out);
}

function sortAttention(list) {
  return list.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || ((a.at || Infinity) - (b.at || Infinity)));
}

export function topAttention(lead, ctx) {
  return computeAttention(lead, ctx)[0] || null;
}

// "Needs action" = anything medium or above. Low items are hints; info items (an opt-out, "not
// this one") are things to know, not to do.
export function needsAction(lead, ctx) {
  return computeAttention(lead, ctx).some(a => !a.info && SEVERITY_RANK[a.severity] >= SEVERITY_RANK.medium);
}
