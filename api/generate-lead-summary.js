import Anthropic from '@anthropic-ai/sdk';
import { getDb, verifyCrmUser } from './_bot-shared.js';
import { LEAD_SUMMARY_MODEL, LEAD_SUMMARY_MAX_TOKENS, buildLeadSummarySystemPrompt, buildLeadSummaryUserPrompt } from './_lead-summary-shared.js';

// Lazy so a missing ANTHROPIC_API_KEY doesn't crash module load — only an
// actual generation attempt should fail.
let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

// Triggered by the client (debounced, see scheduleSummaryRegeneration in
// app.js) after any lead save — stage change, note, follow-up edit, field
// edit, details-sent toggle. Regenerates that one lead's AI summary from its
// own details/notes/history only (see _lead-summary-shared.js guardrails).
//
// A failure here must never take down anything else: on error we patch only
// aiSummaryError, leaving the last successful aiSummary exactly as it was —
// the UI shows the stale summary plus a small "couldn't refresh" notice.
export async function POST(request) {
  const user = await verifyCrmUser(request);
  if (!user || !user.tenantId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Bad request' }), { status: 400 });
  }
  const leadId = body && body.leadId;
  if (!leadId) {
    return new Response(JSON.stringify({ error: 'Missing leadId' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const db = getDb();
  const leadRef = db.collection('leads').doc(leadId);
  const snap = await leadRef.get();
  if (!snap.exists || snap.data().tenantId !== user.tenantId) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  const lead = snap.data();

  // Notes + history live in subcollections now — load them so the summary
  // prompt still sees the full context.
  try {
    const [notesSnap, historySnap] = await Promise.all([
      leadRef.collection('notes').get(),
      leadRef.collection('history').get()
    ]);
    lead.notes = notesSnap.docs.map(d => d.data());
    lead.history = historySnap.docs.map(d => d.data());
  } catch (e) {
    console.error('generate-lead-summary: subcollection load failed:', e);
  }

  let stageName = '';
  try {
    const pipelineSnap = await db.collection('pipelines').doc(user.tenantId).get();
    const stage = (pipelineSnap.exists ? (pipelineSnap.data().stages || []) : []).find(s => s.id === lead.stageId);
    stageName = stage ? stage.name : '';
  } catch (e) {
    console.error('generate-lead-summary: stage lookup failed:', e);
  }

  try {
    const response = await getAnthropic().messages.create({
      model: LEAD_SUMMARY_MODEL,
      max_tokens: LEAD_SUMMARY_MAX_TOKENS,
      system: buildLeadSummarySystemPrompt(),
      messages: [{ role: 'user', content: buildLeadSummaryUserPrompt(lead, stageName) }]
    });
    const summary = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    await leadRef.update({ aiSummary: summary, aiSummaryAt: Date.now(), aiSummaryError: null });
    return new Response(JSON.stringify({ ok: true, summary }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('generate-lead-summary error:', e);
    await leadRef.update({ aiSummaryError: String((e && e.message) || e), aiSummaryErrorAt: Date.now() }).catch(() => {});
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
