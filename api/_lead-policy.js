// Lead automation policy — what the CRM does with the AI's verdict.
//
// Pure: lead + verdict + pipeline + now → the fields to write and the history to log. The rules
// are the ones a careful sales coordinator follows:
//
//   • Move forward on clear evidence; never backwards on its own (a lead who asks a question
//     after a visit has still visited). Backward = a suggestion.
//   • Never declare a deal Won — that is always a person's call (a suggestion).
//   • A column a person chose stands until the lead says something new after that choice.
//   • Lost and On hold need a stated reason; a lead who writes again after either is re-opened.
//     Only the lead's own words close a lead, and never while the team still owes them a reply.
//   • What the AI moved and a person undid is not repeated until the lead says something new.
//   • The team's due step becomes the follow-up — unless a person already has an earlier one.
//   • Vendors, collaborations and unknown custom columns are never touched.
//   • Nothing here touches updatedAt: that field means "a person last worked this lead".

import { stageKeyOf, stageKindOf, stageForKey, stageDef, hasKeyedPipeline, LADDER, LOST_REASONS, HOLD_REASONS } from '../crm-assets/pipeline.js';
import { isBusinessLead } from '../crm-assets/leadAttention.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const IST_OFFSET = 5.5 * HOUR;

// Only what the lead said themselves closes a lead on its own. "Not a fit", budget and no-match
// are judgement calls, so they stay suggestions.
const AUTO_LOST = new Set(['not_interested', 'bought_elsewhere', 'spam']);
const URGENT_KINDS = new Set(['call', 'send_details', 'confirm_visit', 'negotiate', 'paperwork']);

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtIst = ms => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const sameText = (a, b) => String(a || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === String(b || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Working hours for a default due time: 9:30 AM – 7:30 PM IST, every day (brokers work weekends).
export function withinWorkingHours(ms) {
  const istMinutes = Math.floor(((ms + IST_OFFSET) % DAY) / MIN);
  const open = 9 * 60 + 30, close = 19 * 60 + 30;
  if (istMinutes < open) return ms + (open - istMinutes) * MIN;
  if (istMinutes > close) return ms + (DAY / MIN - istMinutes + open) * MIN;
  return ms;
}

function defaultDue(kind, now) {
  if (URGENT_KINDS.has(kind)) return withinWorkingHours(now + 2 * HOUR);
  if (kind === 'find_property' || kind === 'collect_feedback') return withinWorkingHours(now + DAY);
  if (kind === 'nudge') return withinWorkingHours(now + 2 * DAY);
  return withinWorkingHours(now + 4 * HOUR);
}

const humanSetter = by => !!by && by !== 'ai' && by !== 'migration' && by !== 'TailorTalk';

/**
 * @param {object} o
 * @param {object} o.lead     the lead as stored (with tt / ai if present)
 * @param {object} o.verdict  normaliseVerdict() output
 * @param {Array}  o.stages   pipeline stages
 * @param {number} o.now
 * @param {object} [o.run]    { model, chatLen } recorded with the verdict
 * @returns {{ patch: object, history: Array<{type,text}>, moved: ?{from,to}, suggested: ?string, followUp: ?number, skipped: ?string }}
 */
export function decideLeadChanges({ lead, verdict, stages, now, run = {} }) {
  const prevAi = lead.ai || {};
  const history = [];
  const patch = {};
  const result = { patch, history, moved: null, suggested: null, followUp: null, skipped: null };

  // ── The verdict itself, always recorded ──
  const prevNext = prevAi.next || null;
  const sameStep = prevNext && prevNext.owner === verdict.next.owner
    && (sameText(prevNext.action, verdict.next.action) || (prevNext.kind === verdict.next.kind && prevNext.dueAt === verdict.next.dueAt));
  const ai = {
    v: 1,
    at: now,
    model: run.model || null,
    chatLen: run.chatLen ?? null,
    intent: verdict.intent,
    stage: verdict.stage,
    confidence: verdict.confidence,
    evidence: verdict.evidence,
    line: verdict.line,
    urgency: verdict.urgency,
    // setAt stays put while the step is the same one, so a person who already acted on it
    // (updatedAt > setAt) is not asked again just because the AI re-read the same chat.
    next: verdict.next.owner === 'none' ? null : { ...verdict.next, setAt: sameStep ? (prevNext.setAt || now) : now },
    visit: verdict.visit.status === 'none' && !verdict.visit.at ? null : verdict.visit,
    holdReason: verdict.holdReason,
    holdUntil: verdict.holdUntil,
    lostReason: verdict.lostReason,
    suggestion: prevAi.suggestion || null,
    lastMove: prevAi.lastMove || null,
    dismissed: prevAi.dismissed || {}
  };
  patch.ai = ai;

  if (isBusinessLead(lead)) { ai.suggestion = null; result.skipped = 'vendor or collaboration'; return result; }
  if (!hasKeyedPipeline(stages)) { result.skipped = 'pipeline not reworked yet'; return result; }

  const current = (stages || []).find(s => s.id === lead.stageId) || null;
  const curKey = stageKeyOf(current) || (current ? null : 'new');
  const curKind = current ? stageKindOf(current) : 'open';
  const target = verdict.stage;
  const conf = verdict.confidence;
  const tt = lead.tt || {};

  // For a lead typed in by hand there is no chat — the team's latest note is the newest evidence.
  const lastNoteAt = (lead.lastNote && lead.lastNote.createdAt) || 0;
  const lastLeadMsg = Math.max(tt.lastMessageAt || 0, lead.tt ? 0 : lastNoteAt);
  const lastAnyMsg = Math.max(lastLeadMsg, tt.lastReplyAt || 0, lastNoteAt);
  const decidedByPersonAt = humanSetter(lead.stageChangedBy) ? (lead.stageChangedAt || 0)
    : (!lead.stageChangedBy && lead.stageChangedAt && humanSetter(lead.updatedBy) ? lead.stageChangedAt : 0);
  const newEvidenceSincePerson = lastAnyMsg > decidedByPersonAt;
  const dismissedAt = (ai.dismissed || {})[target] || 0;
  const dismissedNoNews = dismissedAt && dismissedAt >= lastLeadMsg;

  const suggest = why => {
    if (conf === 'low' || dismissedNoNews || target === curKey) return;
    ai.suggestion = { stage: target, confidence: conf, evidence: verdict.evidence, why, at: now };
    result.suggested = target;
  };

  let moveTo = null;
  if (!curKey) {
    suggest('custom column');
  } else if (target === curKey) {
    if (ai.suggestion && ai.suggestion.stage === curKey) ai.suggestion = null;
  } else if (curKind === 'won') {
    suggest('the deal is marked won');
  } else if (!newEvidenceSincePerson) {
    suggest('a person chose this column after the last message');
  } else if (dismissedNoNews) {
    // A person undid or dismissed this before and nothing new has been said.
  } else if (target === 'won') {
    suggest('only a person marks a deal won');
  } else if (target === 'lost') {
    // A lead the team still owes something is never closed: that loss would be our own failure.
    if (verdict.next.owner === 'team') suggest('the team still owes this lead a reply');
    else if (conf === 'high' && AUTO_LOST.has(verdict.lostReason)) moveTo = 'lost';
    else suggest('loss not certain');
  } else if (target === 'on_hold') {
    if (conf === 'high' && (curKey !== 'lost')) moveTo = 'on_hold';
    else suggest('pause not certain');
  } else if (curKey === 'on_hold' || curKey === 'lost') {
    // Re-open only when the lead has written since it was parked.
    const cameBack = lastLeadMsg > (lead.stageChangedAt || 0);
    if (cameBack && conf !== 'low') moveTo = target;
    else suggest('no new message since it was parked');
  } else {
    const from = LADDER.indexOf(curKey);
    const to = LADDER.indexOf(target);
    if (to > from) {
      if (conf === 'high' || (conf === 'medium' && to - from === 1)) moveTo = target;
      else suggest('evidence not strong enough to skip ahead');
    } else {
      if (conf === 'high') suggest('moving back is a person\'s call');
    }
  }

  if (moveTo) {
    const toStage = stageForKey(stages, moveTo);
    const fromName = current ? current.name : 'no column';
    Object.assign(patch, {
      stageId: toStage.id,
      prevStageId: lead.stageId || null,
      stageChangedAt: now,
      stageChangedBy: 'ai'
    });
    if (moveTo === 'lost') patch.lostReason = verdict.lostReason;
    if (moveTo === 'on_hold') { patch.holdReason = verdict.holdReason; patch.holdUntil = verdict.holdUntil || null; }
    if (curKey === 'on_hold' && moveTo !== 'on_hold') { patch.holdUntil = null; patch.holdReason = null; }
    if (curKey === 'lost' && moveTo !== 'lost') patch.lostReason = null;
    // Reaching Options or beyond means details were shared — keep the team's toggle in step.
    if (LADDER.indexOf(moveTo) >= 1 && moveTo !== 'won' && lead.detailsSent !== true) patch.detailsSent = true;
    ai.lastMove = { from: curKey, fromStageId: lead.stageId || null, to: moveTo, at: now, evidence: verdict.evidence };
    ai.suggestion = null;
    result.moved = { from: curKey, to: moveTo };
    const reason = moveTo === 'lost' ? ` (${LOST_REASONS[verdict.lostReason] || verdict.lostReason})`
      : moveTo === 'on_hold' ? ` (${HOLD_REASONS[verdict.holdReason] || 'paused'}${verdict.holdUntil ? ', until ' + fmtIst(verdict.holdUntil) : ''})` : '';
    history.push({ type: 'stage', text: `🤖 Moved from <b>${esc(fromName)}</b> to <b>${esc(toStage.name)}</b>${esc(reason)} — ${esc(verdict.evidence)}` });
  }

  // ── The follow-up ──
  const finalKey = moveTo || curKey;
  const finalKind = finalKey ? stageDef(finalKey) && stageDef(finalKey).kind : curKind;
  if (finalKind !== 'won' && finalKind !== 'lost') {
    const candidates = [];
    if (ai.next && ai.next.owner === 'team') {
      const due = ai.next.dueAt || defaultDue(ai.next.kind, now);
      candidates.push({ at: due, note: ai.next.action });
    }
    if (ai.visit && ai.visit.at && ['requested', 'scheduled'].includes(ai.visit.status) && ai.visit.at > now + 30 * MIN) {
      candidates.push({ at: Math.max(ai.visit.at - 2 * HOUR, now + 15 * MIN), note: `Confirm the site visit${ai.visit.property ? ' to ' + ai.visit.property : ''} at ${fmtIst(ai.visit.at)}` });
    }
    if (finalKey === 'on_hold' && (patch.holdUntil || lead.holdUntil)) {
      candidates.push({ at: patch.holdUntil || lead.holdUntil, note: 'Revisit — the lead asked to be contacted around now' });
    }
    // Stale times (a "call at 5" from last week) are not a plan any more.
    const usable = candidates.filter(c => c.at && c.at > now - DAY).sort((a, b) => a.at - b.at);
    const pick = usable[0];
    if (pick) {
      const existing = lead.followUpAt || null;
      const setByPerson = humanSetter(lead.followUpBy) || (!lead.followUpBy && !!existing);
      const personSetAt = lead.followUpSetAt || lead.updatedAt || 0;
      const personStillCurrent = setByPerson && personSetAt >= lastAnyMsg;
      const earlierAlready = existing && existing <= pick.at + 30 * MIN;
      const same = existing && Math.abs(existing - pick.at) < 15 * MIN;
      if (!same && !earlierAlready && !personStillCurrent) {
        Object.assign(patch, { followUpAt: pick.at, followUpBy: 'ai', followUpSetAt: now, followUpNote: pick.note });
        result.followUp = pick.at;
        history.push({ type: 'followup', text: `🤖 Follow-up set for <b>${esc(fmtIst(pick.at))}</b> — ${esc(pick.note)}` });
      }
    }
  }

  return result;
}
