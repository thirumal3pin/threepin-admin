// Lead intent and stage — the AI half of lead automation.
//
// Builds the case file for ONE lead (CRM record, team notes, TailorTalk's profile, the recent
// conversation), asks Claude for a verdict in a strict JSON schema, and validates it. It decides
// nothing about the CRM itself: api/_lead-policy.js turns the verdict into moves, follow-ups and
// suggestions with human-style guardrails. The Claude client is passed in, so tests run offline.

import { STAGE_DEFS, LOST_REASONS, HOLD_REASONS, stageKeyOf, stageDef } from '../crm-assets/pipeline.js';

// Live: Google's Gemini 3.5 Flash-Lite (the owner's choice — the lowest-cost tier; it read the
// test lead correctly in ~1.5 s). Pinned to a version so a Google-side alias change cannot shift
// behaviour silently. settings/{tenant}.leadAutomation.model overrides; any "claude-…" model id
// runs on Claude instead (Claude Haiku 4.5 was used for testing).
export const LEAD_AI_MODEL = process.env.LEAD_AI_MODEL || 'gemini-3.5-flash-lite';
export const LEAD_AI_VERSION = 1;

const HOUR = 3600000;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 600;
const MAX_FIELD_CHARS = 1200;

const STAGES = STAGE_DEFS.map(d => d.key);
const NEXT_KINDS = ['call', 'send_details', 'confirm_visit', 'attend_visit', 'collect_feedback', 'negotiate', 'paperwork', 'find_property', 'nudge', 'other', 'none'];
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });

export const LEAD_AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'stage', 'confidence', 'evidence', 'next_owner', 'next_action', 'next_kind', 'next_due',
    'visit_status', 'visit_at', 'visit_property', 'hold_reason', 'hold_until', 'lost_reason', 'urgency', 'status_line'],
  properties: {
    intent: { type: 'string', enum: ['buy', 'rent', 'sell', 'rent_out', 'invest', 'vendor', 'unclear'] },
    stage: { type: 'string', enum: STAGES },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'string' },
    next_owner: { type: 'string', enum: ['team', 'lead', 'none'] },
    next_action: nullable({ type: 'string' }),
    next_kind: { type: 'string', enum: NEXT_KINDS },
    next_due: nullable({ type: 'string' }),
    visit_status: { type: 'string', enum: ['none', 'requested', 'scheduled', 'done', 'cancelled'] },
    visit_at: nullable({ type: 'string' }),
    visit_property: nullable({ type: 'string' }),
    hold_reason: nullable({ type: 'string', enum: Object.keys(HOLD_REASONS) }),
    hold_until: nullable({ type: 'string' }),
    lost_reason: nullable({ type: 'string', enum: Object.keys(LOST_REASONS) }),
    urgency: { type: 'string', enum: ['high', 'normal', 'low'] },
    status_line: { type: 'string' }
  }
};

export const LEAD_AI_SYSTEM = [
  'You are the sales coordinator at 3 PIN Realty, a real-estate brokerage in Chennai. Buyers and tenants chat with 3 PIN\'s AI assistant on WhatsApp, Instagram and the website; property owners also write in to sell or rent out. The team follows up by phone, WhatsApp and site visits.',
  '',
  'Read one lead\'s record the way an experienced coordinator would and decide, from evidence only: the pipeline stage the lead is really in, who owes the next step and what it is, and the site-visit, hold and loss details.',
  '',
  'STAGES — choose exactly one:',
  '- new: enquiry received; the requirement is unclear or nothing specific has been shared with them yet.',
  '- options: 3 PIN has shared at least one specific property, brochure, location, photos or price, and the lead is evaluating. Questions about a shared property keep the lead here.',
  '- visit_pending: the lead asked to see a property, agreed to a visit, or a visit date/time is proposed or fixed — and nothing says it has happened. An owner asking 3 PIN to come and see their property counts too.',
  '- visit_done: someone says the visit happened ("visited", "saw the flat", a team note "site visit done", feedback about the visit).',
  '- negotiation: the lead is discussing price or terms for a specific property — best or final price, discount, a counter-offer, token/advance/booking amount, deposit, agreement, or documents such as patta, EC, approvals, RERA. A first "what is the price?" is NOT negotiation.',
  '- won: the deal is done — token or advance paid and confirmed, agreement signed, registration done, tenant moving in, or an owner signed the listing.',
  '- on_hold: still interested but paused — postponed to a later time or condition, waiting for 3 PIN to find a matching property, or the budget is not ready.',
  '- lost: stopped — not interested, bought or rented elsewhere, chose someone else, asked for no more contact, not a genuine enquiry (spam, wrong number), or a vendor, agent or job seeker rather than a customer.',
  '',
  'HOW TO JUDGE:',
  '- Place the lead at the FURTHEST milestone the evidence shows, like ticking boxes in order: options sent? visit asked for or agreed? visited? talking price or token? deal done?',
  '- The most recent evidence wins. A later message overrides an earlier one (a cancelled visit, interest revived after a pause).',
  '- Something offered is not something agreed: "Would you like to visit?" is not visit_pending until the lead asks or agrees.',
  '- A lead can skip stages — for example straight to negotiation.',
  '- A newer team note overrides the chat. The CRM stage the team chose is evidence too; move away from it only when the conversation clearly shows something newer.',
  '- When evidence is thin or contradictory, lower the confidence instead of guessing. high = an explicit, recent statement; medium = strongly implied; low = weak or mixed signals.',
  '- "3 PIN AI" is the assistant; "3 PIN team" is a human; "AI did not reply" means a lead message is waiting for a person.',
  '',
  'NEXT STEP:',
  '- next_owner is "team" when 3 PIN promised something (to call, send details or photos, confirm or arrange a visit, check with the owner, find options), when the lead asked something only a person can answer, when a lead message is still unanswered, or when a visit or meeting needs confirming. It is "lead" when 3 PIN is waiting for the lead\'s reply or decision. It is "none" when nothing is pending.',
  '- next_action: one short imperative line a team member can act on, naming the property code when known, e.g. "Call to confirm Saturday 12:30 PM visit to ANRL001". Null when next_owner is "none".',
  '- next_due: when that step is due, only if the conversation states or clearly implies a time ("call me at 5", "tomorrow morning" → 10:00). Resolve relative dates against the timestamp of the message that said it. ISO 8601 with +05:30. Null when no time is implied.',
  '- visit_at: the proposed or agreed visit date and time, same rules. visit_property: the property code or a short name.',
  '- hold_until: the date the lead said to come back ("end of September" → the 30th at 10:00). Null if none.',
  '- lost_reason when the stage is lost; hold_reason when the stage is on_hold; otherwise null.',
  '- urgency: high when the lead wants to act soon, is frustrated, or has been waiting on 3 PIN; low for idle browsing.',
  '- evidence: a short quote or paraphrase that proves the stage, with its date.',
  '- status_line: one line of at most 90 characters a manager reads on the board, e.g. "Agreed to see TNAG0001 on Sat; team to confirm the time".',
  '',
  'Answer only with the JSON object.'
].join('\n');

// ── The case file ──────────────────────────────────────────────────────────

const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export function fmtIstLong(ms) {
  return new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function speaker(m, leadName) {
  if (m.role === 'user') return `Lead${leadName ? ' (' + leadName.split(' ')[0] + ')' : ''}`;
  if (m.role === 'human_agent') return `3 PIN team${m.email ? ' (' + String(m.email).split('@')[0] + ')' : ''}`;
  return '3 PIN AI';
}

const PROFILE_LABELS = [
  ['requirement_details', 'Requirement'], ['budget_and_finance', 'Budget and finance'], ['preferred_location', 'Preferred location'],
  ['intent_and_who', 'Intent and who'], ['properties_discussed', 'Properties discussed'], ['objections_and_blockers', 'Objections and blockers'],
  ['stage_and_next_action', 'Stage and next action (TailorTalk\'s own AI)'], ['activity_so_far', 'Activity so far'], ['remarks', 'Remarks']
];

/**
 * @param {object} o { lead, state, notes, stages, now }
 *   state — leads/{id}/tailortalk/state (profile, chat, bookings) or null
 *   notes — the lead's team notes, any order
 */
export function buildCaseFile({ lead, state, notes, stages, now }) {
  const lines = [];
  const stage = (stages || []).find(s => s.id === lead.stageId);
  const stageName = stage ? stage.name : 'Unknown';
  const by = lead.stageChangedBy === 'ai' ? 'the AI' : lead.stageChangedBy === 'migration' ? 'the CRM rework' : (lead.stageChangedBy || lead.updatedBy || 'the team');
  const tt = lead.tt || {};

  lines.push(`Now: ${fmtIstLong(now)} IST`);
  lines.push('');
  lines.push('LEAD');
  lines.push(`Name: ${clip(lead.name || 'Unknown', 60)}`);
  lines.push(`Channel: ${lead.channel || tt.integration || 'unknown'}${tt.leadSource ? ' · source: ' + tt.leadSource : ''}${tt.adTitle ? ' · ad: ' + clip(tt.adTitle, 60) : ''}`);
  lines.push(`Enquiry type in CRM: ${lead.enquiryType || '—'} · Property/locality: ${clip(lead.propertyInterest || '—', 80)} · Budget: ${clip(lead.budget || '—', 40)}`);
  lines.push(`CRM stage now: ${stageName}${lead.stageChangedAt ? ` (since ${fmtIstLong(lead.stageChangedAt)}, set by ${String(by).split('@')[0]})` : ''}`);
  if (lead.lostReason) lines.push(`Recorded loss reason: ${LOST_REASONS[lead.lostReason] || lead.lostReason}`);
  if (lead.holdUntil) lines.push(`On hold until: ${fmtIstLong(lead.holdUntil)}`);
  lines.push(`Follow-up in CRM: ${lead.followUpAt ? fmtIstLong(lead.followUpAt) : 'none'} · Details sent by team: ${lead.detailsSent === true ? 'yes' : 'no'}`);
  if (lead.tt) lines.push(`TailorTalk status: ${tt.status || '—'} · AI paused: ${tt.locked ? 'yes' : 'no'} · Escalated: ${tt.escalated ? 'yes' : 'no'} · Converted: ${tt.converted ? 'yes' : 'no'}`);

  const teamNotes = (notes || []).filter(n => n && n.text).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(-8);
  if (teamNotes.length) {
    lines.push('', 'TEAM NOTES (oldest first):');
    teamNotes.forEach(n => lines.push(`- [${fmtIstLong(n.createdAt || 0)}${n.by ? ' · ' + String(n.by).split('@')[0] : ''}] ${clip(n.text, 400)}`));
  }

  const profile = (state && state.profile) || {};
  const prof = PROFILE_LABELS.filter(([k]) => profile[k]);
  if (prof.length) {
    lines.push('', 'TAILORTALK PROFILE (written by TailorTalk\'s AI; can lag the chat):');
    prof.forEach(([k, label]) => lines.push(`${label}: ${clip(profile[k], MAX_FIELD_CHARS)}`));
  }

  const bookings = (state && state.bookings) || [];
  if (bookings.length) {
    lines.push('', 'BOOKINGS:');
    bookings.forEach(b => lines.push(`- ${clip(b.summary || 'Booking', 80)}${b.start ? ' at ' + fmtIstLong(b.start) : ''}`));
  }

  const chat = ((state && state.chat) || []).filter(m => m && (m.content || (m.meta && m.meta.type)));
  if (chat.length) {
    const shown = chat.slice(-MAX_MESSAGES);
    lines.push('', `CONVERSATION (${shown.length === chat.length ? 'all' : 'last ' + shown.length + ' of ' + chat.length} messages, oldest first, IST):`);
    for (const m of shown) {
      const noReply = (m.meta && m.meta.type === 'no_response') || /^<no response from agent>$/i.test(String(m.content || '').trim());
      const when = m.at ? fmtIstLong(m.at) : 'time unknown';
      lines.push(noReply ? `[${when}] (AI did not reply — left for the team)` : `[${when}] ${speaker(m, lead.name)}: ${clip(m.content, MAX_MESSAGE_CHARS)}`);
    }
  } else {
    lines.push('', 'CONVERSATION: none recorded — judge from the CRM record and notes.');
  }

  return lines.join('\n');
}

// ── Validation ─────────────────────────────────────────────────────────────

function parseWhen(value, now) {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  // A date years away is a misread, not a plan.
  if (t < now - 60 * 24 * HOUR || t > now + 400 * 24 * HOUR) return null;
  return t;
}
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

export function normaliseVerdict(raw, now) {
  if (!raw || typeof raw !== 'object') return null;
  const stage = oneOf(raw.stage, STAGES, null);
  if (!stage) return null;
  const owner = oneOf(raw.next_owner, ['team', 'lead', 'none'], 'none');
  const action = owner === 'none' ? null : (clip(raw.next_action, 120) || null);
  const v = {
    intent: oneOf(raw.intent, ['buy', 'rent', 'sell', 'rent_out', 'invest', 'vendor', 'unclear'], 'unclear'),
    stage,
    confidence: oneOf(raw.confidence, ['high', 'medium', 'low'], 'low'),
    evidence: clip(raw.evidence, 240),
    next: {
      owner: action ? owner : 'none',
      action,
      kind: oneOf(raw.next_kind, NEXT_KINDS, 'other'),
      dueAt: action ? parseWhen(raw.next_due, now) : null
    },
    visit: {
      status: oneOf(raw.visit_status, ['none', 'requested', 'scheduled', 'done', 'cancelled'], 'none'),
      at: parseWhen(raw.visit_at, now),
      property: clip(raw.visit_property, 60) || null
    },
    holdReason: stage === 'on_hold' ? oneOf(raw.hold_reason, Object.keys(HOLD_REASONS), 'other') : null,
    holdUntil: stage === 'on_hold' ? parseWhen(raw.hold_until, now) : null,
    lostReason: stage === 'lost' ? oneOf(raw.lost_reason, Object.keys(LOST_REASONS), 'other') : null,
    urgency: oneOf(raw.urgency, ['high', 'normal', 'low'], 'normal'),
    line: clip(raw.status_line, 100)
  };
  return v;
}

// ── The call ───────────────────────────────────────────────────────────────

function firstText(message) {
  const block = (message.content || []).find(b => b.type === 'text');
  return block ? block.text : '';
}

/**
 * @param {object} o { client, model, caseFile, now }
 * @returns {Promise<{ ok: true, verdict, usage, model } | { ok: false, error, usage?, model }>}
 */
// Haiku 4.5 and Sonnet 4.5 reject the effort setting; only the newest models take server-side
// refusal fallbacks.
const takesEffort = model => !/claude-(haiku-4-5|sonnet-4-5)/.test(model);
const takesFallbacks = model => /^claude-(opus-5|fable-5-1)/.test(model);

// Gemini: generateContent with a JSON-schema response, over plain HTTPS (no SDK). The key goes in
// a header, never the URL, so it cannot land in a log line.
async function classifyWithGemini({ model, caseFile, now, apiKey = process.env.GEMINI_API_KEY, fetchImpl = fetch }) {
  if (!apiKey) return { ok: false, error: 'GEMINI_API_KEY is not set', model };
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: LEAD_AI_SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: caseFile }] }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: LEAD_AI_SCHEMA, temperature: 0.1, maxOutputTokens: 4000 }
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Gemini answered ${res.status}: ${String((body.error && body.error.message) || '').slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const m = body.usageMetadata || {};
  const usage = { input_tokens: m.promptTokenCount || 0, output_tokens: (m.candidatesTokenCount || 0) + (m.thoughtsTokenCount || 0), cache_read_input_tokens: m.cachedContentTokenCount || 0 };
  const cand = (body.candidates || [])[0];
  if (!cand) return { ok: false, error: body.promptFeedback && body.promptFeedback.blockReason ? 'refused' : 'no answer', usage, model };
  if (['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(cand.finishReason)) return { ok: false, error: 'refused', usage, model };
  if (cand.finishReason === 'MAX_TOKENS') return { ok: false, error: 'cut off', usage, model };
  const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
  let raw;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: 'unreadable answer', usage, model }; }
  const verdict = normaliseVerdict(raw, now);
  if (!verdict) return { ok: false, error: 'answer failed validation', usage, model };
  return { ok: true, verdict, usage, model: body.modelVersion || model };
}

export async function classifyLead({ client, model = LEAD_AI_MODEL, caseFile, now = Date.now(), gemini = {} }) {
  if (/^gemini-/.test(model)) return classifyWithGemini({ model, caseFile, now, ...gemini });
  const base = {
    model,
    max_tokens: 4000,
    system: LEAD_AI_SYSTEM,
    messages: [{ role: 'user', content: caseFile }],
    output_config: { ...(takesEffort(model) ? { effort: 'low' } : {}), format: { type: 'json_schema', schema: LEAD_AI_SCHEMA } }
  };
  let message;
  if (takesFallbacks(model)) {
    try {
      // If Claude declines (it should not for a sales chat), the API retries on a fallback model
      // inside the same call rather than leaving the lead unclassified.
      message = await client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    } catch (e) {
      if (e && e.status === 400) message = await client.messages.create(base);
      else throw e;
    }
  } else {
    message = await client.messages.create(base);
  }
  const usage = message.usage || null;
  if (message.stop_reason === 'refusal') return { ok: false, error: 'refused', usage, model: message.model || model };
  if (message.stop_reason === 'max_tokens') return { ok: false, error: 'cut off', usage, model: message.model || model };
  let raw;
  try { raw = JSON.parse(firstText(message)); } catch { return { ok: false, error: 'unreadable answer', usage, model: message.model || model }; }
  const verdict = normaliseVerdict(raw, now);
  if (!verdict) return { ok: false, error: 'answer failed validation', usage, model: message.model || model };
  return { ok: true, verdict, usage, model: message.model || model };
}

export { stageKeyOf, stageDef };
