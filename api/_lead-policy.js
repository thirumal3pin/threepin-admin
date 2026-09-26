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
//     Only the lead's own words close or park a lead, and never while the team still owes them.
//   • What the AI moved and a person undid is not repeated until the lead says something new.
//   • The team's due step becomes the follow-up — unless someone already has an earlier one
//     STILL AHEAD. A follow-up whose hour has gone by is missed, not earlier, so fresh words
//     from the lead re-date it: "I'm in Kerala till the 5th" moves the call to the 5th.
//   • Vendors, collaborations and unknown custom columns are never touched.
//   • Nothing here touches updatedAt: that field means "a person last worked this lead".

import { stageKeyOf, stageKindOf, stageForKey, stageDef, hasKeyedPipeline, reachedUpdate, LADDER, LOST_REASONS, HOLD_REASONS } from '../crm-assets/pipeline.js';
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
 * @param {Array}  [o.enquiryTypes]  the tenant's configured enquiry types (for the Seller Listing
 *                                    re-tag below); omitted or missing "Seller Listing" skips it
 * @returns {{ patch: object, history: Array<{type,text}>, moved: ?{from,to}, suggested: ?string, followUp: ?number, skipped: ?string }}
 */
export function decideLeadChanges({ lead, verdict, stages, now, run = {}, enquiryTypes = [] }) {
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

  // ── Seller/owner leads are revenue, and the enquiryType TailorTalk sets from one line of its
  // own "intent_and_who" summary (enquiryTypeFor() in _tailortalk-shared.js) misses real phrasing
  // that never says "sell", "list" or "rent out" literally — "put my house up for rent", "want to
  // give it out" — because that function reads only the first clause with a keyword regex. The
  // verdict above read the WHOLE conversation, so when it is confident this is an owner and the
  // record has not already caught up, correct it here too — same rule TailorTalk's own sync
  // already follows: never touch it once a person in the CRM has set it themselves (ttHold).
  const sellerType = (enquiryTypes || []).find(t => String(t).toLowerCase() === 'seller listing') || null;
  const aiSaysSeller = verdict.intent === 'sell' || verdict.intent === 'rent_out';
  const alreadySeller = String(lead.enquiryType || '').trim().toLowerCase() === 'seller listing';
  const enquiryTypeHeld = !!(lead.ttHold && lead.ttHold.enquiryType);
  if (sellerType && aiSaysSeller && !alreadySeller && !enquiryTypeHeld) {
    patch.enquiryType = sellerType;
    history.push({ type: 'field', text: `🤖 Marked as a <b>${esc(sellerType)}</b> — ${esc(verdict.evidence)}` });
  }

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
  // lastLeadMsg, NOT lastAnyMsg. For a chat lead that is the lead's own
  // messages; for a hand-typed lead it is the team's notes, which are the only
  // evidence there is. The difference matters: a coordinator who sets the
  // column and writes "visited, need the feedback" a minute later was, with
  // lastAnyMsg, producing "new evidence" that unlocked overriding the column
  // they had just chosen. The team's own words are never grounds to overrule
  // the team — only the lead saying something new is.
  const newEvidenceSincePerson = lastLeadMsg > decidedByPersonAt;
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
  } else if (target === 'sourcing') {
    // Not on the ladder, so the forward/backward test below would read it as a
    // step backwards from anywhere. It is neither: it is a live lead the team
    // owes a property to, and the lead does not have to agree to it the way
    // they must for On hold. Requiring next_owner "team" is what keeps it from
    // becoming a place to file leads nobody wants to work.
    if (conf === 'high' && verdict.next.owner === 'team') moveTo = 'sourcing';
    else suggest('not certain there is nothing to show');
  } else if (target === 'on_hold') {
    // "We have no match yet, the team will look" is the team's work, not the lead's pause.
    if (verdict.next.owner === 'team') suggest('the team still owes this lead something');
    else if (conf === 'high' && (curKey !== 'lost')) moveTo = 'on_hold';
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

  // A tenant whose pipeline has not gained a newly defined column yet must not
  // crash the run: there is no id to write, so it becomes a suggestion until
  // the column exists.
  if (moveTo && !stageForKey(stages, moveTo)) {
    suggest('this board has no such column yet');
    moveTo = null;
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
    Object.assign(patch, reachedUpdate(lead, moveTo, now) || {});
    if (moveTo === 'lost') patch.lostReason = verdict.lostReason;
    if (moveTo === 'on_hold') { patch.holdReason = verdict.holdReason; patch.holdUntil = verdict.holdUntil || null; }
    if (curKey === 'on_hold' && moveTo !== 'on_hold') { patch.holdUntil = null; patch.holdReason = null; }
    if (curKey === 'lost' && moveTo !== 'lost') patch.lostReason = null;
    // Reaching Options or beyond means details were shared — keep the team's toggle in step.
    // send_details is the exception: it is the column for details we have NOT
    // sent, so reaching it must never tick "details sent".
    if (LADDER.indexOf(moveTo) >= 1 && moveTo !== 'won' && moveTo !== 'send_details' && lead.detailsSent !== true) patch.detailsSent = true;
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
      // Same rule as the column above: a note the team wrote itself does not
      // make the team's own follow-up stale.
      const personStillCurrent = setByPerson && personSetAt >= lastLeadMsg;
      // "We are already chasing them sooner" only holds while that time is still ahead of us.
      // A follow-up whose hour has passed is not an earlier plan, it is a missed one — and we
      // are only in here because the lead has just said something that changes when to ring.
      // Without the `existing > now`, a lead who postpones stays pinned to the date they have
      // just moved: "I'm travelling to Kerala, back by the 5th" parked the lead until the 5th
      // and left the follow-up a week overdue, still noted as a site visit he had cancelled.
      // TailorTalk's own sync has always taken the future date over a passed one
      // (_tailortalk-shared.js, `!followUpAt || followUpAt < now`); this is that rule.
      const earlierAlready = existing && existing > now && existing <= pick.at + 30 * MIN;
      const same = existing && Math.abs(existing - pick.at) < 15 * MIN;
      if (!same && !earlierAlready && !personStillCurrent) {
        Object.assign(patch, { followUpAt: pick.at, followUpBy: 'ai', followUpSetAt: now, followUpNote: pick.note });
        result.followUp = pick.at;
        // When it displaces a follow-up that was already missed, say so: a lead leaving the
        // overdue queue should be explained on the lead's own timeline, not just disappear.
        const was = existing && existing <= now ? ` (was ${esc(fmtIst(existing))}, missed)` : '';
        history.push({ type: 'followup', text: `🤖 Follow-up set for <b>${esc(fmtIst(pick.at))}</b>${was} — ${esc(pick.note)}` });
      }
    }
  }

  return result;
}
