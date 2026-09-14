// Lead automation — reads a lead, asks the AI where it stands, applies the policy, keeps a log.
//
//   runLeadAutomation   one lead, now (a queue drain, "Re-check", backfill)
//   queue / claim / finish  a per-lead debounce: a burst of chat messages is read once, after
//                           the burst, not once per message
//   drainQueue          reads whatever has gone quiet — run by every webhook, every CRM refresh
//                       and the nightly sync, so no single trigger has to wait around
//
// Requests are only made when they can change something: an unchanged lead (same evidence key
// as the last read), a closed lead nobody has written to, and anything while the model is rate
// limited are all skipped without calling the model.
//
// Every run is written to leads/{id}/aiRuns/{runId}: what it read (sizes), what it concluded,
// what it changed, what it cost. Like a workflow run history — nothing the AI does is silent.
// Takes `db` and the Claude client as arguments, so tests run on the in-memory Firestore.

import { buildCaseFile, classifyLead, evidenceKey, LEAD_AI_MODEL } from './_lead-ai.js';
import { decideLeadChanges } from './_lead-policy.js';
import { isBusinessLead } from '../crm-assets/leadAttention.js';
import { stageKindOf } from '../crm-assets/pipeline.js';

// A chat is read once it has been quiet for QUIET_MS — WhatsApp comes in bursts, and one read after
// the burst sees everything — but never later than MAX_WAIT_MS after its first unread message, so a
// long, busy conversation is still read while it is going on.
export const QUIET_MS = 2 * 60000;
export const MAX_WAIT_MS = 10 * 60000;

export async function automationSettings(db, tenantId) {
  const snap = await db.collection('settings').doc(tenantId).get();
  const s = (snap.exists && snap.data().leadAutomation) || {};
  return { enabled: s.enabled === true, model: s.model || LEAD_AI_MODEL };
}

let runSeq = 0;
function runId(now) { runSeq = (runSeq + 1) % 1e6; return `r${now}${runSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
let histSeq = 0;
function historyId(now) { histSeq = (histSeq + 1) % 1e6; return `h${now}ai${histSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

// While the model is rate limited, nobody asks it anything: aiState/{tenant}.blockedUntil is
// shared by every function instance, so a webhook burst does not turn into a burst of 429s.
const aiStateRef = (db, tenantId) => db.collection('aiState').doc(tenantId);

/**
 * @param {object} db
 * @param {string} tenantId
 * @param {string} leadId
 * @param {object} o { client, model, now, apply = true, trigger, force = false }
 *   force — read even when nothing new has been said (a person pressed Re-check, or a preview)
 * @returns summary { leadId, ok, skipped?, error?, retry?, verdict?, moved?, suggested?, followUp?, usage? }
 */
export async function runLeadAutomation(db, tenantId, leadId, { client, model = LEAD_AI_MODEL, now = Date.now(), apply = true, trigger = 'manual', force = false, gemini } = {}) {
  const ref = db.collection('leads').doc(leadId);
  const [leadSnap, stateSnap, notesSnap, pipeSnap, aiStateSnap] = await Promise.all([
    ref.get(),
    ref.collection('tailortalk').doc('state').get(),
    ref.collection('notes').get(),
    db.collection('pipelines').doc(tenantId).get(),
    aiStateRef(db, tenantId).get()
  ]);
  if (!leadSnap.exists) return { leadId, ok: false, skipped: 'no such lead' };
  const lead = leadSnap.data();
  if (lead.tenantId !== tenantId) return { leadId, ok: false, skipped: 'other tenant' };
  if (isBusinessLead(lead)) return { leadId, ok: true, skipped: 'vendor or collaboration' };

  const state = stateSnap.exists ? stateSnap.data() : null;
  const notes = notesSnap.docs.map(d => d.data()).filter(n => n.by !== 'TailorTalk');
  const chatLen = state && Array.isArray(state.chat) ? state.chat.length : 0;
  if (!chatLen && !notes.length) return { leadId, ok: true, skipped: 'nothing to read' };
  const stages = pipeSnap.exists ? (pipeSnap.data().stages || []) : [];

  // ── Requests that would not change anything are not made ──
  const inputKey = evidenceKey({ lead, state, notes, model });
  const prev = lead.ai || {};
  if (!force && prev.inputKey === inputKey && !prev.error) return { leadId, ok: true, skipped: 'nothing new since the last read' };
  const current = stages.find(s => s.id === lead.stageId);
  if (!force && current && stageKindOf(current) !== 'open') {
    // Won, Lost or On hold: only the lead writing again can change that.
    const lastLeadWord = lead.tt ? (lead.tt.lastMessageAt || 0) : ((lead.lastNote && lead.lastNote.createdAt) || 0);
    if (lastLeadWord <= (lead.stageChangedAt || 0)) return { leadId, ok: true, skipped: 'closed or parked, and the lead has not written since' };
  }
  const blockedUntil = (aiStateSnap.exists && aiStateSnap.data().blockedUntil) || 0;
  if (blockedUntil > now) return { leadId, ok: false, error: 'rate limited', retry: true, retryAfterMs: blockedUntil - now };

  const caseFile = buildCaseFile({ lead, state, notes, stages, now });
  let answer;
  try {
    answer = await classifyLead({ client, model, caseFile, now, gemini });
  } catch (e) {
    answer = { ok: false, error: String((e && e.message) || e).slice(0, 300), model };
  }

  const rid = runId(now);
  const runRecord = {
    id: rid, at: now, trigger, model: answer.model || model,
    input: { chars: caseFile.length, messages: chatLen, notes: notes.length },
    usage: answer.usage ? { input: answer.usage.input_tokens || 0, output: answer.usage.output_tokens || 0, thinking: answer.usage.thinking_tokens || 0, cacheRead: answer.usage.cache_read_input_tokens || 0 } : null
  };

  // A rate limit is not the lead's failure: nothing is recorded on it, the caller re-queues it,
  // and every instance holds off until Google's wait is over.
  if (!answer.ok && answer.retryable) {
    const wait = Math.min(Math.max(answer.retryAfterMs || 60000, 15000), 30 * 60000);
    await aiStateRef(db, tenantId).set({ blockedUntil: now + wait, lastLimitAt: now, lastLimitError: answer.error }, { merge: true });
    return { leadId, ok: false, error: answer.error, retry: true, retryAfterMs: wait };
  }
  if (!answer.ok) {
    if (apply) {
      await ref.update({ 'ai.error': answer.error, 'ai.errorAt': now });
      await ref.collection('aiRuns').doc(rid).set({ ...runRecord, ok: false, error: answer.error });
    }
    return { leadId, ok: false, error: answer.error, usage: runRecord.usage };
  }

  const verdict = answer.verdict;
  if (!apply) {
    const d = decideLeadChanges({ lead, verdict, stages, now, run: { model: runRecord.model, chatLen } });
    const { ai, ...fields } = d.patch;
    return { leadId, ok: true, preview: true, verdict, moved: d.moved, suggested: d.suggested, followUp: d.followUp, skipped: d.skipped, fields, history: d.history.map(h => h.text), usage: runRecord.usage };
  }

  // Decide again against the lead as it is at write time: a person may have moved it while the
  // AI was reading, and the policy must respect that choice.
  const summary = await db.runTransaction(async t => {
    const fresh = await t.get(ref);
    if (!fresh.exists) return { leadId, ok: false, skipped: 'deleted while reading' };
    const current = fresh.data();
    const d = decideLeadChanges({ lead: current, verdict, stages, now, run: { model: runRecord.model, chatLen } });
    const patch = { ...d.patch, ai: { ...d.patch.ai, error: null, errorAt: null, inputKey } };
    t.update(ref, patch);
    d.history.forEach((h, i) => {
      const id = historyId(now + i);
      t.set(ref.collection('history').doc(id), { id, type: h.type, text: h.text, at: now + i, by: 'AI' });
    });
    t.set(ref.collection('aiRuns').doc(rid), {
      ...runRecord, ok: true,
      verdict: { stage: verdict.stage, confidence: verdict.confidence, intent: verdict.intent, evidence: verdict.evidence, next: verdict.next, visit: verdict.visit, line: verdict.line },
      moved: d.moved, suggested: d.suggested, followUp: d.followUp, skipped: d.skipped
    });
    return { leadId, ok: true, verdict, moved: d.moved, suggested: d.suggested, followUp: d.followUp, skipped: d.skipped, usage: runRecord.usage };
  });
  return summary;
}

// ── Debounce queue: aiQueue/{leadId} = { tenantId, dueAt, claimedDueAt } ───

export async function queueLeadAutomation(db, tenantId, leadId, { now = Date.now(), quietMs = QUIET_MS, maxWaitMs = MAX_WAIT_MS } = {}) {
  const ref = db.collection('aiQueue').doc(leadId);
  return db.runTransaction(async t => {
    const snap = await t.get(ref);
    const q = snap.exists ? snap.data() : null;
    // A run already under way covers everything before it; the wait restarts from this message.
    const waitingSince = q && q.firstQueuedAt && q.claimedDueAt !== q.dueAt ? q.firstQueuedAt : now;
    const dueAt = Math.max(now, Math.min(now + quietMs, waitingSince + maxWaitMs));
    t.set(ref, { tenantId, leadId, dueAt, firstQueuedAt: waitingSince, claimedDueAt: null }, { merge: true });
    return dueAt;
  });
}

// Claims the run if the lead has been quiet until its due time and nobody else took it.
export async function claimQueued(db, leadId, now = Date.now()) {
  const ref = db.collection('aiQueue').doc(leadId);
  return db.runTransaction(async t => {
    const snap = await t.get(ref);
    if (!snap.exists) return null;
    const q = snap.data();
    if (q.dueAt > now || q.claimedDueAt === q.dueAt) return null;
    t.set(ref, { claimedDueAt: q.dueAt }, { merge: true });
    return q.dueAt;
  });
}

// Clears the queue entry unless a newer message re-queued the lead while it was being read.
// With retryAt (the AI was rate limited) the entry stays, due again at that time.
export async function finishQueued(db, leadId, claimedDueAt, { retryAt = null } = {}) {
  const ref = db.collection('aiQueue').doc(leadId);
  await db.runTransaction(async t => {
    const snap = await t.get(ref);
    if (!snap.exists || snap.data().dueAt !== claimedDueAt) return;
    if (retryAt) t.set(ref, { dueAt: retryAt, claimedDueAt: null, retries: (snap.data().retries || 0) + 1 }, { merge: true });
    else t.delete(ref);
  });
}

export const retryAtFor = (result, now = Date.now()) =>
  result && result.retry ? now + Math.min(Math.max(result.retryAfterMs || 0, 2 * 60000), 30 * 60000) : null;

// Runs whatever is due, oldest first, within a time budget. Leftovers stay queued.
export async function drainQueue(db, tenantId, { client, model, now = Date.now(), budgetMs = 40000, maxRuns = Infinity, trigger = 'queue', gemini } = {}) {
  const started = Date.now();
  const [snap, aiState] = await Promise.all([
    db.collection('aiQueue').where('tenantId', '==', tenantId).get(),
    aiStateRef(db, tenantId).get()
  ]);
  const due = snap.docs.map(d => d.data()).filter(q => q.dueAt <= now && q.claimedDueAt !== q.dueAt).sort((a, b) => a.dueAt - b.dueAt);
  const blockedUntil = (aiState.exists && aiState.data().blockedUntil) || 0;
  if (blockedUntil > now) return { due: due.length, ran: 0, results: [], rateLimited: true };
  const results = [];
  for (const q of due) {
    if (Date.now() - started > budgetMs || results.length >= maxRuns) break;
    const claimed = await claimQueued(db, q.leadId, Math.max(now, Date.now()));
    if (!claimed) continue;
    let r;
    try {
      r = await runLeadAutomation(db, tenantId, q.leadId, { client, model, trigger, gemini });
    } catch (e) {
      r = { leadId: q.leadId, ok: false, error: String((e && e.message) || e).slice(0, 200) };
    } finally {
      await finishQueued(db, q.leadId, claimed, { retryAt: retryAtFor(r) });
    }
    results.push(r);
    if (r.retry) break; // the model is rate limited — the rest stay queued for the next drain
  }
  return { due: due.length, ran: results.length, results, rateLimited: results.some(r => r.retry) };
}
