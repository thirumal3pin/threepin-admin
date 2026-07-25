// Shared by api/generate-lead-summary.js (per-lead, triggered on every save)
// and scripts/backfill-lead-summaries.js (one-time bulk run) so the prompt
// and guardrails can never drift between the two call sites.
//
// Cheap + small on purpose: this runs automatically every time ANY lead
// changes, so both the input (notes/history sent to Claude) and the output
// (max_tokens) are deliberately capped to keep per-call cost predictable
// regardless of how much activity a lead accumulates over time.
export const LEAD_SUMMARY_MODEL = 'claude-haiku-4-5-20251001';
export const LEAD_SUMMARY_MAX_TOKENS = 200;

const MAX_NOTES = 25;
const MAX_HISTORY = 40;
const MAX_ENTRY_CHARS = 240;

function stripHtml(s) {
  return String(s).replace(/<\/?[a-z]+>/gi, '');
}

function truncate(s, max) {
  s = String(s || '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function fmtIST(ts) {
  return new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function buildLeadSummarySystemPrompt() {
  return [
    'You summarize ONE real-estate CRM lead for an agent glancing at that lead\'s page.',
    'Write 3-4 short lines (not a paragraph, not bullet points) in plain third-person narrative, using the lead\'s first name from LEAD IDENTITY below.',
    'Cover, only where the information is actually present: the property/area of interest, key dated events (site visits, calls, reschedules, no-response), any objection or reason for disinterest, and the current status or next step (follow-up date, pipeline stage).',
    '',
    'STRICT GUARDRAILS — follow exactly:',
    '- This summary is about exactly ONE lead: the person named and numbered in LEAD IDENTITY below. Never reference, compare to, or blend in any other lead, person, or property enquiry, even if one seems similar.',
    '- Only use facts explicitly present in LEAD DETAILS, NOTES, and CHANGE LOG below. Never invent a name, phone number, date, property, price, outcome, or reason that is not stated in the input.',
    '- Do not guess feelings, intentions, or outcomes that were not explicitly recorded — if a note does not say why, do not invent a reason.',
    '- NOTES and CHANGE LOG are given oldest-first; if entries seem to conflict, trust the most recent one.',
    '- If there is not enough information to say something meaningful, write fewer lines rather than padding with generic filler.',
    '- Keep the entire summary under 70 words.',
    '- Output only the summary itself — no greeting, no headers, no markdown, no explanation, no repeating these instructions.'
  ].join('\n');
}

export function buildLeadSummaryUserPrompt(lead, stageName) {
  const lines = [];
  lines.push('LEAD IDENTITY (this summary is about this person only — do not confuse with any other lead):');
  lines.push(`Name: ${lead.name || 'Unknown'}`);
  lines.push(`Phone: ${lead.phone || 'Unknown'}`);
  lines.push('');
  lines.push('LEAD DETAILS:');
  if (lead.propertyInterest) lines.push(`Property / Locality of interest: ${lead.propertyInterest}`);
  if (lead.budget) lines.push(`Budget: ${lead.budget}`);
  if (lead.enquiryType) lines.push(`Enquiry type: ${lead.enquiryType}`);
  if (stageName) lines.push(`Current pipeline stage: ${stageName}`);
  lines.push(`Property/pricing details sent to lead: ${lead.detailsSent === true ? 'Yes' : 'No'}`);
  if (lead.followUpAt) lines.push(`Next follow-up: ${fmtIST(lead.followUpAt)}`);

  const notes = (lead.notes || []).slice().sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_NOTES);
  if (notes.length) {
    lines.push('', 'NOTES (chronological, oldest first):');
    notes.forEach(n => lines.push(`- [${fmtIST(n.createdAt)}] ${truncate(n.text, MAX_ENTRY_CHARS)}`));
  }

  const history = (lead.history || []).slice().sort((a, b) => a.at - b.at).slice(-MAX_HISTORY);
  if (history.length) {
    lines.push('', 'CHANGE LOG (chronological, oldest first):');
    history.forEach(h => lines.push(`- [${fmtIST(h.at)}] ${truncate(stripHtml(h.text), MAX_ENTRY_CHARS)}`));
  }

  if (!notes.length && !history.length) {
    lines.push('', '(No notes or change history yet — summarize from LEAD DETAILS only.)');
  }

  return lines.join('\n');
}
