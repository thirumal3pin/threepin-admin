import Anthropic from '@anthropic-ai/sdk';
import { LEAD_SUMMARY_MODEL } from './_lead-summary-shared.js';

// AI usage for the Dashboard is intentionally narrow: this is the ONLY place
// it touches lead data, and it never computes a number — every count/total/
// grouping in the Dashboard comes from crm-assets/dashboardMetrics.js (pure
// JS, verified against real data). This helper exists solely because "why
// did this lead go cold" is a genuine judgment call over free-text notes
// that regex can't do reliably — everything else stays deterministic.
//
// Guardrails, by design:
// - ONE batched call for the whole day's dead-moved leads, never per-lead.
// - Only {id, note excerpt} is sent — no name/phone/email/any other PII.
// - Strict JSON-only output, capped phrase length, "Not specified" fallback
//   instead of ever inventing a reason not present in the note.
// - Static instructions are cache_control-tagged (cheap to repeat daily).
// - Any failure (timeout, bad JSON, API error) returns an empty map — the
//   caller always has a non-AI fallback (the raw note text) and never blocks.
const MAX_ITEMS = 25;
const MAX_NOTE_CHARS = 200;
const REASON_MAX_TOKENS = 400;

const REASON_SYSTEM_PROMPT = [
  'You summarize why a real-estate CRM lead was marked "Not interested" or "Spam", using ONLY the note text given for that lead.',
  'For each item, output a single short reason phrase, 3-8 words, no trailing punctuation (e.g. "Budget mismatch", "Chose another property", "Stopped responding").',
  'Use ONLY information stated or clearly implied in that lead\'s own note. Never invent a reason, never borrow a reason from a different item.',
  'If the note gives no discernible reason, output exactly: Not specified',
  'Never include a name, phone number, or any personal detail in the reason.',
  'Respond with strict JSON only — an array of {"id": "<given id>", "reason": "<phrase>"}, one entry per item given, same order. No prose, no markdown fences, no explanation.'
].join('\n');

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

function truncate(s, max) {
  s = String(s || '').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// items: [{ id, note }] — caller is responsible for only passing today's
// dead-moved leads (a small, bounded set) and for not including PII in `note`
// beyond whatever free text the agent already typed.
export async function summarizeDeadReasons(items) {
  const clean = (items || [])
    .filter(i => i && i.id)
    .slice(0, MAX_ITEMS)
    .map(i => ({ id: String(i.id), note: truncate(i.note, MAX_NOTE_CHARS) }));
  if (!clean.length) return new Map();

  try {
    const res = await getAnthropic().messages.create({
      model: LEAD_SUMMARY_MODEL,
      max_tokens: REASON_MAX_TOKENS,
      system: [{ type: 'text', text: REASON_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(clean.map(c => ({ id: c.id, note: c.note || '(no note)' }))) }]
    });
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(jsonText);
    const map = new Map();
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (row && row.id != null) map.set(String(row.id), truncate(row.reason || 'Not specified', 80));
      }
    }
    return map;
  } catch (e) {
    console.error('summarizeDeadReasons failed (non-fatal, caller falls back to raw notes):', e);
    return new Map();
  }
}
