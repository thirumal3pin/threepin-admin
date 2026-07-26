import Anthropic from '@anthropic-ai/sdk';
import { FieldPath } from 'firebase-admin/firestore';
import { getDb, verifyCrmUser } from './_bot-shared.js';
import { LEAD_SUMMARY_MODEL, LEAD_SUMMARY_MAX_TOKENS, buildLeadSummarySystemPrompt, buildLeadSummaryUserPrompt } from './_lead-summary-shared.js';

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

// Give the function the full serverless budget — even so we only ever do a
// SMALL number of Claude calls per HTTP request (see CHUNK), because a few
// hundred sequential ~1-2s calls in one request would blow past any function
// time limit and time out mid-run. Instead the client calls this repeatedly,
// walking a document-id cursor until `done` (see runBackfillSummaries in
// crm-assets/app.js).
export const maxDuration = 60;
const CHUNK = 5;

// Still one Claude call at a time (never a single batched prompt) so nothing
// from one lead's prompt can bleed into another's.
export async function POST(request) {
  const user = await verifyCrmUser(request);
  if (!user || !user.tenantId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let body = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }
  const force = !!body.force;
  const afterId = typeof body.cursor === 'string' && body.cursor ? body.cursor : null;

  const db = getDb();
  const pipelineSnap = await db.collection('pipelines').doc(user.tenantId).get();
  const stages = pipelineSnap.exists ? (pipelineSnap.data().stages || []) : [];
  const stageName = stageId => (stages.find(s => s.id === stageId) || {}).name || '';

  // Walk leads in document-id order so the client can resume exactly where it
  // left off via `cursor`, regardless of how many chunks it takes.
  let query = db.collection('leads').where('tenantId', '==', user.tenantId).orderBy(FieldPath.documentId());
  if (afterId) query = query.startAfter(afterId);
  const snap = await query.get();

  const pending = snap.docs.filter(d => force || !d.data().aiSummary);
  const batch = pending.slice(0, CHUNK);

  let generated = 0, failed = 0;
  const errors = [];
  for (const doc of batch) {
    const lead = doc.data();
    try {
      // Notes + history are in subcollections now — load them for the prompt.
      const [notesSnap, historySnap] = await Promise.all([
        doc.ref.collection('notes').get(),
        doc.ref.collection('history').get()
      ]);
      lead.notes = notesSnap.docs.map(d => d.data());
      lead.history = historySnap.docs.map(d => d.data());
      const response = await getAnthropic().messages.create({
        model: LEAD_SUMMARY_MODEL,
        max_tokens: LEAD_SUMMARY_MAX_TOKENS,
        system: buildLeadSummarySystemPrompt(),
        messages: [{ role: 'user', content: buildLeadSummaryUserPrompt(lead, stageName(lead.stageId)) }]
      });
      const summary = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      await doc.ref.update({ aiSummary: summary, aiSummaryAt: Date.now(), aiSummaryError: null });
      generated++;
    } catch (e) {
      failed++;
      errors.push({ leadId: doc.id, name: lead.name || '', error: String((e && e.message) || e) });
      await doc.ref.update({ aiSummaryError: String((e && e.message) || e), aiSummaryErrorAt: Date.now() }).catch(() => {});
    }
  }

  // Cursor = last lead we advanced past this chunk. When nothing was left to
  // process after the cursor, we're done.
  const lastProcessed = batch.length ? batch[batch.length - 1].id : (snap.docs.length ? snap.docs[snap.docs.length - 1].id : afterId);
  const remaining = pending.length - batch.length;

  return new Response(JSON.stringify({
    ok: true,
    generated,
    failed,
    remaining,
    done: remaining <= 0,
    cursor: lastProcessed,
    errors
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
