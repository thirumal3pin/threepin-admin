import Anthropic from '@anthropic-ai/sdk';
import { getDb, verifyCrmUser } from './_bot-shared.js';
import { LEAD_SUMMARY_MODEL, LEAD_SUMMARY_MAX_TOKENS, buildLeadSummarySystemPrompt, buildLeadSummaryUserPrompt } from './_lead-summary-shared.js';

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

// One-time (but safe to re-run) bulk generation for a tenant's existing
// leads that don't have an AI summary yet — triggered from the CRM's
// "⚙️ Backfill AI Summaries" menu item, the same verifyCrmUser + per-tenant
// scoping as every other admin action in this file's sibling endpoints.
// Skips leads that already have `aiSummary` unless `force` is passed, and
// runs leads strictly one Claude call at a time (never batched) so nothing
// from one lead's prompt can bleed into another's.
const MAX_LEADS_PER_RUN = 300;

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

  const db = getDb();
  const pipelineSnap = await db.collection('pipelines').doc(user.tenantId).get();
  const stages = pipelineSnap.exists ? (pipelineSnap.data().stages || []) : [];
  const stageName = stageId => (stages.find(s => s.id === stageId) || {}).name || '';

  const leadsSnap = await db.collection('leads').where('tenantId', '==', user.tenantId).get();
  const docs = leadsSnap.docs.filter(d => force || !d.data().aiSummary).slice(0, MAX_LEADS_PER_RUN);

  let generated = 0, failed = 0;
  const errors = [];
  for (const doc of docs) {
    const lead = doc.data();
    try {
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

  return new Response(JSON.stringify({
    ok: true,
    totalLeads: leadsSnap.size,
    attempted: docs.length,
    skipped: leadsSnap.size - docs.length,
    generated,
    failed,
    errors
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
