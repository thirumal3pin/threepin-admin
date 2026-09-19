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

import { stageKeyOf, stageKindOf, stageDef } from './pipeline.js';

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
  const add = (k, severity, label, detail = null, at = null) => out.push({ key: k, severity, label, detail, at });

  const tt = lead.tt || null;
  const ai = lead.ai || null;
  const touched = lead.updatedAt || 0;
  const since = Math.max(touched, (tt && tt.attentionFrom) || 0);
  const business = isBusinessLead(lead);

  // Follow-ups the team set apply to every lead, including vendors.
  const fuOverdue = !closed && lead.followUpAt && lead.followUpAt < now;

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
  const visit = ai && ai.visit;

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

// "Needs action" = anything medium or above. Low items are hints.
export function needsAction(lead, ctx) {
  return computeAttention(lead, ctx).some(a => SEVERITY_RANK[a.severity] >= SEVERITY_RANK.medium);
}
