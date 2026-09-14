// Lead intent and stage — the AI half of lead automation.
//
// Builds the case file for ONE lead (CRM record, team notes, TailorTalk's profile, the recent
// conversation), asks Claude for a verdict in a strict JSON schema, and validates it. It decides
// nothing about the CRM itself: api/_lead-policy.js turns the verdict into moves, follow-ups and
// suggestions with human-style guardrails. The Claude client is passed in, so tests run offline.

import { createHash } from 'node:crypto';
import { STAGE_DEFS, LADDER, LOST_REASONS, HOLD_REASONS, stageKeyOf, stageDef } from '../crm-assets/pipeline.js';

// Live: Google's Gemini 3.5 Flash-Lite (the owner's choice — the lowest-cost tier; it read the
// test lead correctly in ~1.5 s). Pinned to a version so a Google-side alias change cannot shift
// behaviour silently. settings/{tenant}.leadAutomation.model overrides; any "claude-…" model id
// runs on Claude instead (Claude Haiku 4.5 was used for testing).
export const LEAD_AI_MODEL = process.env.LEAD_AI_MODEL || 'gemini-3.5-flash-lite';
export const LEAD_AI_VERSION = 1;

const HOUR = 3600000;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 600;
// The assistant's replies are mostly property listings — half of every case file. Their opening
// lines and the property codes carry the evidence; the bullet points do not.
const MAX_AI_MESSAGE_CHARS = 280;
const MAX_FIELD_CHARS = 500;
const PROPERTY_CODE = /\b[A-Z]{2,5}\d{3,4}\b/g;

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
  'You are the sales coordinator at 3 PIN Realty, a Chennai real-estate brokerage. Buyers and tenants chat with 3 PIN\'s AI assistant (WhatsApp, Instagram, web); owners write in to sell or rent out. From the evidence only, decide the lead\'s real stage, who owes the next step, and the visit, hold and loss details.',
  '',
  'STAGES (exactly one):',
  '- new: requirement unclear, or nothing specific shared yet.',
  '- options: 3 PIN shared a specific property, brochure, location, photos or price and the lead is evaluating (questions about it stay here).',
  '- visit_pending: the lead asked for or agreed to a visit (a plain "yes" counts, even with no date), or a time is proposed or fixed — and nothing says it happened.',
  '- visit_done: someone says the visit happened (visited, saw it, a "site visit done" note, feedback on it).',
  '- negotiation: price or terms for a specific property — best price, discount, counter-offer, token or advance, deposit, agreement, documents (patta, EC, approvals, RERA). A first "what is the price?" is not negotiation.',
  '- won: token or advance paid, agreement signed, registered, tenant moving in, or an owner signed the listing.',
  '- on_hold: the LEAD paused — later, after a date or event, or budget or loan not ready. If 3 PIN is still searching for an active lead, keep its milestone with next_owner "team" and next_kind "find_property"; use on_hold with no_match only if the lead agreed to wait.',
  '- lost: the LEAD stopped — not interested, bought or rented elsewhere, chose someone else, asked for no contact — or spam, a wrong number, a vendor, agent or job seeker. NOT lost: anger or doubt because 3 PIN was slow or missed a callback (keep the milestone, next_owner "team", urgency high), or a property that missed the budget or location.',
  '- Owners (sell, rent_out): new while sharing details, photos or price; visit_pending once an inspection is asked for or agreed; negotiation on commission or listing terms; won when the listing is signed.',
  '',
  'JUDGING:',
  '- Place the lead at the FURTHEST milestone reached (options → visit asked or agreed → visited → price or token → done); stages can be skipped.',
  '- The newest evidence wins (a cancelled visit, revived interest). A newer team note overrides the chat. A CRM stage set by a person is evidence — leave it only for something clearly newer; a stage set by the AI or the CRM rework is not evidence, judge from the conversation.',
  '- Offered is not agreed: "Would you like to visit?" needs the lead\'s yes.',
  '- confidence: high = stated explicitly; medium = inferred; low = weak or mixed signals.',
  '- visit_status matches the stage: requested (no fixed time), scheduled (time fixed), done.',
  '- "3 PIN AI" is the assistant, "3 PIN team" a person; "AI did not reply" means a lead message waits for a person.',
  '',
  'NEXT STEP — next_owner is the first rule that applies:',
  '1. 3 PIN promised something not yet delivered (callback, details, photos, brochure, options, owner check, visit confirmation) → "team".',
  '2. The lead\'s latest message is unanswered, needs a person, or asks for a call → "team".',
  '3. Visited and no feedback recorded → "team", next_kind "collect_feedback".',
  '4. Visit asked for or agreed without a fixed time → "team", "confirm_visit" ("nudge" if the lead will come back with a date).',
  '5. 3 PIN delivered everything and awaits the lead\'s reply or decision → "lead".',
  '6. Nothing pending → "none".',
  '- next_action: one short imperative naming the property code when known, e.g. "Call to confirm Sat 12:30 PM visit to ANRL001"; null when "none".',
  '- next_due, visit_at, hold_until: only when stated or clearly implied ("tomorrow morning" → 10:00, "end of September" → the 30th at 10:00), resolved against that message\'s timestamp, ISO 8601 with +05:30; otherwise null. visit_property: the code or a short name.',
  '- lost_reason only when lost, hold_reason only when on_hold; otherwise null.',
  '- urgency: high if eager, frustrated or kept waiting by 3 PIN; low for idle browsing.',
  '- evidence: a quote or paraphrase with its date, at most 160 characters. status_line: at most 80 characters for the board, e.g. "Agreed to see TNAG0001 Sat; team to confirm time".',
  '',
  'Answer only with the JSON object.'
].join('\n');

// ── The case file ──────────────────────────────────────────────────────────

// Phone numbers and email addresses never help judge a lead, so they never leave the CRM: every
// piece of text in the case file (and the verdict) passes through clip(), which masks them.
const PHONE = /(?<![\w₹])(?:\+?91[\s-]?)?(?:[6-9]\d{4}[\s-]?\d{5}|0?44[\s-]?\d{4}[\s-]?\d{4})(?!\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
export const redact = s => String(s == null ? '' : s).replace(EMAIL, '[email]').replace(PHONE, '[phone]');
const clip = (s, n) => { const t = redact(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// "Dr Kiruthika Raman" → "Dr Kiruthika", "Rajesh Kumar" → "Rajesh": enough to say who to call.
const shortName = name => { const w = String(name || '').trim().split(/\s+/); return (/^(dr|mr|mrs|ms|miss)\.?$/i.test(w[0]) ? w.slice(0, 2) : w.slice(0, 1)).join(' '); };

export function fmtIstLong(ms) {
  return new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function speaker(m, leadName) {
  if (m.role === 'user') return `Lead${leadName ? ' (' + clip(shortName(leadName), 40) + ')' : ''}`;
  if (m.role === 'human_agent') return `3 PIN team${m.email ? ' (' + String(m.email).split('@')[0] + ')' : ''}`;
  return '3 PIN AI';
}

function messageText(m) {
  if (m.role === 'user' || m.role === 'human_agent') return clip(m.content, MAX_MESSAGE_CHARS);
  const text = clip(m.content, MAX_AI_MESSAGE_CHARS);
  if (!text.endsWith('…')) return text;
  const shown = new Set(text.match(PROPERTY_CODE) || []);
  const more = [...new Set(String(m.content).match(PROPERTY_CODE) || [])].filter(c => !shown.has(c));
  return more.length ? `${text} [also: ${more.slice(0, 8).join(', ')}]` : text;
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
  lines.push(`Name: ${clip(shortName(lead.name) || 'Unknown', 40)}`);
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

  const chat = ((state && state.chat) || []).filter(m => m && (m.content || (m.meta && m.meta.type)));
  const profile = (state && state.profile) || {};
  // "Activity so far" retells the chat; it only adds anything when older messages are cut off.
  const prof = PROFILE_LABELS.filter(([k]) => profile[k] && !(k === 'activity_so_far' && chat.length <= MAX_MESSAGES));
  if (prof.length) {
    lines.push('', 'TAILORTALK PROFILE (written by TailorTalk\'s AI; can lag the chat):');
    prof.forEach(([k, label]) => lines.push(`${label}: ${clip(profile[k], MAX_FIELD_CHARS)}`));
  }

  const bookings = (state && state.bookings) || [];
  if (bookings.length) {
    lines.push('', 'BOOKINGS:');
    bookings.forEach(b => lines.push(`- ${clip(b.summary || 'Booking', 80)}${b.start ? ' at ' + fmtIstLong(b.start) : ''}`));
  }

  if (chat.length) {
    const shown = chat.slice(-MAX_MESSAGES);
    lines.push('', `CONVERSATION (${shown.length === chat.length ? 'all' : 'last ' + shown.length + ' of ' + chat.length} messages, oldest first, IST):`);
    for (const m of shown) {
      const noReply = (m.meta && m.meta.type === 'no_response') || /^<no response from agent>$/i.test(String(m.content || '').trim());
      const when = m.at ? fmtIstLong(m.at) : 'time unknown';
      lines.push(noReply ? `[${when}] (AI did not reply — left for the team)` : `[${when}] ${speaker(m, lead.name)}: ${messageText(m)}`);
    }
  } else {
    lines.push('', 'CONVERSATION: none recorded — judge from the CRM record and notes.');
  }

  return lines.join('\n');
}

// What a verdict depends on — the conversation, notes, bookings, TailorTalk's profile and the
// lead's own details — and not what the automation writes itself (stage, follow-up, details sent)
// or the clock. The same key as the last successful read means nothing new has been said, so
// asking again would pay for the same answer. The prompt, schema and model are part of the key:
// changing any of them makes every lead readable again.
const PROMPT_KEY = createHash('sha256').update(`${LEAD_AI_VERSION}\n${LEAD_AI_SYSTEM}\n${JSON.stringify(LEAD_AI_SCHEMA)}`).digest('hex').slice(0, 12);

export function evidenceKey({ lead, state, notes, model }) {
  const tt = lead.tt || {};
  const profile = (state && state.profile) || {};
  const src = JSON.stringify([
    PROMPT_KEY, model || '',
    [lead.name, lead.enquiryType, lead.propertyInterest, lead.budget, lead.channel, tt.status, !!tt.locked, !!tt.escalated, !!tt.converted],
    (notes || []).filter(n => n && n.text).map(n => [n.createdAt || 0, n.text]).sort((a, b) => a[0] - b[0]).slice(-8),
    PROFILE_LABELS.map(([k]) => profile[k] || ''),
    ((state && state.bookings) || []).map(b => [b.summary || '', b.start || 0]),
    ((state && state.chat) || []).slice(-MAX_MESSAGES).map(m => [m.at || 0, m.role || '', m.content || '', (m.meta && m.meta.type) || ''])
  ]);
  return createHash('sha256').update(src).digest('base64url').slice(0, 24);
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
  // The stage must agree with the visit the model itself described: a lead who asked for or
  // agreed to a visit has at least a visit planned, one who visited has at least visited.
  const rung = LADDER.indexOf(v.stage);
  if (rung >= 0 && rung < LADDER.indexOf('visit_pending') && ['requested', 'scheduled'].includes(v.visit.status)) v.stage = 'visit_pending';
  if (rung >= 0 && rung < LADDER.indexOf('visit_done') && v.visit.status === 'done') v.stage = 'visit_done';
  if (v.stage === 'visit_pending' && v.visit.status === 'none') v.visit.status = 'requested';
  // After a visit someone has to ask how it went — a small model often leaves that out.
  if (v.stage === 'visit_done' && v.next.owner === 'none') {
    v.next = { owner: 'team', action: `Call for feedback on the visit${v.visit.property ? ' to ' + v.visit.property : ''}`, kind: 'collect_feedback', dueAt: null };
  }
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
// Google's retry hint on a 429 ("retryDelay": "37s"), if it sent one.
function retryDelayMs(body) {
  const info = ((body.error && body.error.details) || []).find(d => /RetryInfo/.test(d['@type'] || ''));
  const secs = info && parseFloat(String(info.retryDelay || ''));
  return Number.isFinite(secs) ? Math.ceil(secs * 1000) : null;
}

// Google's guidance (ai.google.dev/gemini-api/docs/troubleshooting): retry 408, 429 and 5xx with
// exponential backoff and jitter, a capped number of times; never 400 or 403.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

// The request body, identical for every lead except the case file. Per the Gemini 3.5 guide:
//   • no temperature/topP/topK — deprecated for 3.5 models; below 1.0 they can loop. Determinism
//     comes from the system instruction's explicit rules and the strict schema instead.
//   • thinkingLevel "minimal" — Flash-Lite's default, stated so a default change cannot quietly
//     add billed thinking tokens to a classification that does not need them.
//   • maxOutputTokens caps thinking + answer; a verdict is ~200 tokens, so 2048 only matters for a
//     runaway answer, which comes back as MAX_TOKENS and is treated as a failed read.
export function geminiRequest(caseFile) {
  return {
    systemInstruction: { parts: [{ text: LEAD_AI_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: caseFile }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: LEAD_AI_SCHEMA,
      thinkingConfig: { thinkingLevel: 'minimal' },
      maxOutputTokens: 2048
    }
  };
}

async function classifyWithGemini({ model, caseFile, now, apiKey = process.env.GEMINI_API_KEY, fetchImpl = fetch, sleepImpl = sleepMs, retries = 2, maxWaitMs = 8000, random = Math.random }) {
  if (!apiKey) return { ok: false, error: 'GEMINI_API_KEY is not set', model };
  const payload = JSON.stringify(geminiRequest(caseFile));
  const request = () => fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: payload
  });
  let res, body;
  for (let attempt = 0; ; attempt++) {
    res = await request();
    body = await res.json().catch(() => ({}));
    if (res.ok || !RETRYABLE.has(res.status)) break;
    const hinted = retryDelayMs(body);
    // Out of retries, or Google asks for a longer wait than one request can afford: hand the lead
    // back to the queue instead of recording a failure.
    if (attempt >= retries || (hinted && hinted > maxWaitMs)) {
      return { ok: false, error: res.status === 429 ? 'rate limited' : `Gemini unavailable (${res.status})`, retryable: true, retryAfterMs: hinted || 60000, model };
    }
    await sleepImpl(hinted || Math.round(1000 * 2 ** attempt * (0.75 + random() / 2)));
  }
  if (!res.ok) {
    const err = new Error(`Gemini answered ${res.status}: ${String((body.error && body.error.message) || '').slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const m = body.usageMetadata || {};
  // Thinking is billed as output; it is also kept apart so the log shows whether "minimal" holds.
  const usage = { input_tokens: m.promptTokenCount || 0, output_tokens: (m.candidatesTokenCount || 0) + (m.thoughtsTokenCount || 0), thinking_tokens: m.thoughtsTokenCount || 0, cache_read_input_tokens: m.cachedContentTokenCount || 0 };
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
