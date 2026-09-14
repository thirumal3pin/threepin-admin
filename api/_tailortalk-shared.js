// TailorTalk → CRM: the pure half of the sync.
//
// Everything here turns ONE TailorTalk webhook envelope plus what the CRM already holds into
// the writes to make — no Firestore, no clock, no network — so tests/tailortalk.test.mjs can
// run it against the real sample payload. api/_tailortalk-sync.js does the reads and writes.
//
// The owner's rule: a lead shows TailorTalk's LATEST state, not its first message. Every
// payload TailorTalk sends is the whole lead object, so each one is applied as a full refresh
// of the TailorTalk-owned fields. A payload older than the last one applied (a late retry) is
// not allowed to roll them back.
//
// Who owns what on a lead:
//   tt.*                     TailorTalk only. The CRM page never writes it (firebase-sync.js
//                            strips it from every save).
//   name, propertyInterest,  Shared. TailorTalk keeps them current until someone in the CRM
//   budget, enquiryType      edits one; ttHold[field] = true from then on, and TailorTalk's
//                            newer value is shown beside it instead of overwriting it.
//   everything else          The team's (stage, follow-up, notes, details sent, …). TailorTalk
//                            only fills a follow-up when a booking arrives and none is set.

import { createHash } from 'node:crypto';

export const FOLLOW_FIELDS = ['name', 'propertyInterest', 'budget', 'enquiryType'];

// The AI-written lead profile fields configured on the 3 PIN agent. Any other custom attribute
// TailorTalk sends lands in `extra`, so adding one in TailorTalk needs no code change here.
export const PROFILE_FIELDS = [
  'requirement_details', 'budget_and_finance', 'preferred_location', 'intent_and_who',
  'properties_discussed', 'objections_and_blockers', 'stage_and_next_action',
  'activity_so_far', 'chat_summary', 'remarks', 'flag_details'
];

// Fields with a fixed meaning in TailorTalk's lead object. Not treated as custom attributes.
const KNOWN_KEYS = new Set([
  ...PROFILE_FIELDS,
  'lead_name', 'lead_contact', 'lead_status', 'category', 'is_converted', 'converted_at',
  'total_followups', 'last_message_seen', 'lead_lock_status', 'escalated', 'escalated_to',
  'escalation_id', 'flagged', 'integration', 'lead_source', 'metadata', 'owner', 'profile_pic',
  'id', 'ad_data', 'created_at', 'chat_history', 'joined', 'last_message_time'
]);

// Custom-trigger webhooks. TailorTalk's Custom event carries no name of its own, so each one is
// a separate webhook whose URL ends in &signal=<key>. A signal stays "open" on the lead until
// someone on the team does anything to it (lead.updatedAt moves past the signal) — see
// TT_SIGNALS in crm-assets/app.js, which carries the same keys, labels and actions.
//
// The keys are a contract: automations and reports will be written against them, so a key is
// never renamed — add a new one instead. `quoteFrom: 'reply'` records the AI's latest reply as
// the evidence (the promise is in what 3 PIN said, not in what the lead said).
export const SIGNAL_DEFS = {
  team_promise:   { label: 'Team promised the lead something', icon: '🤝', quoteFrom: 'reply' },
  needs_human:    { label: 'Needs a person now',               icon: '🙋' },
  site_visit:     { label: 'Site visit asked or agreed',       icon: '📅' },
  ready_to_close: { label: 'Negotiating or ready to book',     icon: '💰' },
  no_match:       { label: 'Nothing matched what they want',   icon: '🔍', quoteFrom: 'reply' },
  owner_listing:  { label: 'Owner wants to sell or rent out',  icon: '🏷️' },
  revisit_later:  { label: 'Postponed — come back later',      icon: '⏰' },
  lost_deal:      { label: 'Stopped looking',                  icon: '💤' },
  loan_help:      { label: 'Needs a home loan',                icon: '🏦' },
  shared_listing: { label: 'Asked about a specific post or listing', icon: '🔗' },
  ai_quality:     { label: 'AI answer disputed or stuck',      icon: '⚠️' },
  // The first set, still understood if a webhook with these keys exists.
  wants_contact:   { label: 'Wants a call or visit',       icon: '🙋' },
  details_request: { label: 'Asked for property details',  icon: '📨' },
  seller_lead:     { label: 'Owner wants to sell or list', icon: '🏷️' },
  lost_signal:     { label: 'Might be lost',               icon: '💤' }
};
export const SIGNALS = Object.fromEntries(Object.entries(SIGNAL_DEFS).map(([k, v]) => [k, v.label]));
const OWNER_SIGNALS = new Set(['owner_listing', 'seller_lead']);

// Any lowercase key is accepted (a new custom webhook needs no deploy to start recording); only
// the keys above get their own label and behaviour.
export function normaliseSignal(s) {
  const v = String(s || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,31}$/.test(v) ? v : null;
}

const STATUS_LABELS = { cold: 'Cold', warm: 'Warm', hot: 'Hot', dead: 'Dead', converted: 'Converted', open: 'Open', resolved: 'Resolved' };
const SOURCE_LABELS = { whatsapp_ad: 'WhatsApp ad', whatsapp_dm: 'WhatsApp', instagram_dm: 'Instagram', instagram_ad: 'Instagram ad', web_chat: 'Website chat' };

// Firestore caps a document at 1 MiB. The conversation lives in one document so opening a
// lead costs one read; past this size the oldest messages are dropped (and flagged).
export const CHAT_BYTES_CAP = 600000;

// ─── small helpers ──────────────────────────────────────────────────────────

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const EMPTYISH = /^(null|none|nil|n\/?a|na|nothing|unknown|not (yet )?(mentioned|specified|provided|available|shared|known|discussed)|-+|—)\.?$/i;

// A trimmed string, or null for blanks and the placeholders an AI writes when it knows nothing.
export function clean(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return null;
  const s = String(v).trim();
  if (!s || EMPTYISH.test(s)) return null;
  return s;
}

// Readable text for fields TailorTalk may send as a string OR an object (owner, escalated_to).
export function textOf(v) {
  if (v && typeof v === 'object') {
    return clean(v.name) || clean(v.email) || clean(v.title) || clean(v.team) || clean(v.id);
  }
  return clean(v);
}

// The headline of an AI profile field. The agent writes "3.3 Cr (earlier: 2.5 Cr). Budget is
// firm." — the CRM's Budget column wants "3.3 Cr". Cut at the first bracket, semicolon or
// sentence break. Not a sentence break: a decimal point ("3.3"), an initial ("T. Nagar",
// "K.K. Nagar") or a common abbreviation ("Rs. 80 L", "Approx. 1 Cr").
const SENTENCE_BREAK = /\s\(|;\s|(?<!\b[A-Za-z])(?<!\b(?:Rs|INR|Approx|approx|Apx|apx|No|St|Dr|Mr|Mrs|Ms|Sq|sq|Ft|ft|Nr|nr|Opp|opp|Ph|Ext|ext))\.\s+(?=[A-Z0-9₹])|\s[—–]\s|\n/;
export function shortValue(v, max = 60) {
  let s = clean(v);
  if (!s) return null;
  const cut = s.search(SENTENCE_BREAK);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/[\s.,;:]+$/, '').trim();
  if (!s) return null;
  if (s.length > max) {
    const sp = s.lastIndexOf(' ', max - 1);
    s = s.slice(0, sp > max * 0.5 ? sp : max - 1).replace(/[\s.,;:]+$/, '') + '…';
  }
  return s;
}

export function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// Same canonical form as phoneKey() in crm-assets/app.js and normPhone() in dashboardMetrics.js,
// so a TailorTalk lead and a hand-typed lead on the same number are recognised as one person.
export function phoneKey(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1);
  return digits;
}

// lead_contact is a phone number on WhatsApp, a username on Instagram, and whatever the
// visitor typed on web chat.
export function contactParts(contact) {
  const s = clean(contact);
  if (!s) return { phone: '', phoneKey: '', email: '', handle: '' };
  if (/^\+?[\d\s()-]{8,}$/.test(s) && !/\*/.test(s)) return { phone: s, phoneKey: phoneKey(s), email: '', handle: '' };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { phone: '', phoneKey: '', email: s, handle: '' };
  return { phone: '', phoneKey: '', email: '', handle: s.replace(/^@/, '') };
}

// CRM channel keys match CHANNEL_META in app.js and CHANNEL_LABELS in dashboardMetrics.js.
export function channelFor(integration, leadSource) {
  const s = `${integration || ''} ${leadSource || ''}`.toLowerCase();
  if (s.includes('whatsapp')) return 'whatsapp';
  if (s.includes('insta')) return 'instagram';
  if (/web|site|widget/.test(s)) return 'website';
  return '';
}

// "Buy, residential, for himself…" → Property Enquiry; "Sell, owner of a 2 BHK…" → Seller
// Listing. Only the first clause is read, and only types the tenant actually has are returned.
export function enquiryTypeFor(intent, enquiryTypes) {
  const s = clean(intent);
  if (!s) return null;
  const head = s.split(/[,.;(\n]/)[0];
  const has = t => (enquiryTypes || []).find(x => String(x).toLowerCase() === t.toLowerCase()) || null;
  if (/\b(sell|selling|seller|list|listing|owner|landlord|rent(ing)? out|lease out|let out)\b/i.test(head)) return has('Seller Listing');
  if (/\b(buy|buying|buyer|purchase|purchasing|rent|renting|tenant|lease|invest|investing|investment)\b/i.test(head)) return has('Property Enquiry');
  return null;
}

export const statusLabel = s => STATUS_LABELS[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
export const sourceLabel = s => SOURCE_LABELS[s] || (s ? String(s).replace(/_/g, ' ') : '');

export function fmtIST(ms) {
  return new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// A Firestore-safe, stable document id for a lead TailorTalk created.
export function ttLeadDocId(tenantId, ttId) {
  const safe = String(ttId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  return `tt_${tenantId}_${safe}`;
}

// ─── conversation ───────────────────────────────────────────────────────────

// A message has no guaranteed id (message_id is null for AI turns), so its identity is its
// role, time and text. The same message arriving in every later payload hashes the same. Time
// is taken to the second: the webhook and get_leads may write the same moment with different
// fractions ("…:28.710093" vs "…:28"), and that must not store the message twice.
export function chatKey(m) {
  return createHash('sha1').update(`${m.role}|${Math.floor((m.at || 0) / 1000)}|${m.content}`).digest('hex').slice(0, 16);
}

export function normaliseChat(history) {
  if (!Array.isArray(history)) return [];
  return history.map((m, i) => {
    const out = {
      role: String((m && m.role) || 'user'),
      content: m && m.content != null ? String(m.content) : '',
      at: toMs(m && m.time) || 0,
      i
    };
    if (m && m.email) out.email = String(m.email);
    if (m && m.metadata && typeof m.metadata === 'object') {
      const meta = JSON.stringify(m.metadata);
      if (meta.length <= 2000) out.meta = m.metadata;
    }
    out.k = chatKey(out);
    return out;
  });
}

// Existing ∪ incoming, de-duplicated, oldest first. Appending (rather than replacing with the
// newest payload's history) keeps the record whole even if TailorTalk ever sends a partial one.
export function mergeChat(existing, incoming) {
  const byKey = new Map();
  (existing || []).forEach((m, i) => { if (m && m.k) byKey.set(m.k, { ...m, i: m.i ?? i }); });
  (incoming || []).forEach(m => { if (m && m.k && !byKey.has(m.k)) byKey.set(m.k, m); });
  let chat = Array.from(byKey.values()).sort((a, b) => (a.at - b.at) || ((a.i || 0) - (b.i || 0)));
  let truncated = false;
  let bytes = JSON.stringify(chat).length;
  while (chat.length > 1 && bytes > CHAT_BYTES_CAP) {
    bytes -= JSON.stringify(chat[0]).length + 1;
    chat = chat.slice(1);
    truncated = true;
  }
  return { chat, truncated };
}

// TailorTalk writes "<No response from agent>" (metadata.type no_response) when the AI chose not
// to answer — the lead's message is waiting for a person. It is not a reply.
export function isNoReplyMarker(m) {
  return !!m && ((m.meta && m.meta.type === 'no_response') || /^<no response from agent>$/i.test(String(m.content || '').trim()));
}

function lastAt(chat, roles) {
  let t = null;
  for (const m of chat) if (roles.includes(m.role) && !isNoReplyMarker(m) && m.at && (t === null || m.at > t)) t = m.at;
  return t;
}

// When the conversation currently ends on a message the AI left for the team: the time of that
// marker, else null. The team closes it by acting on the lead (see ttNeedsAttention in app.js).
function awaitingTeamSince(chat) {
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (isNoReplyMarker(m)) return m.at || null;
    if (m.role === 'assistant' || m.role === 'human_agent') return null;
  }
  return null;
}

const quoteOf = s => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > 140 ? t.slice(0, 139) + '…' : t; };

// The CRM category for leads that are not buyers or sellers. TailorTalk marks those with a
// category other than "sales" (3 PIN's agent: vendor pitch, collaboration, influencer).
export const BUSINESS_ENQUIRY_TYPE = 'Vendor / Collaboration';
export const isBusinessCategory = c => !!c && String(c).toLowerCase() !== 'sales';

// The AI rewrites the same fact with different punctuation and spacing between updates
// ("T Nagar" / "T.Nagar"). That is not a change, and must not be logged or written as one.
export const sameText = (a, b) => String(a || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === String(b || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// ─── the plan ───────────────────────────────────────────────────────────────

/**
 * Works out every write one webhook implies.
 *
 * @param {object}  o
 * @param {object}  o.envelope       the parsed webhook body
 * @param {?object} o.lead           the CRM lead this conversation belongs to, or null (new)
 * @param {?object} o.state          that lead's tailortalk/state document, or null
 * @param {string}  o.leadId         the lead's document id (existing or to be created)
 * @param {string}  o.tenantId
 * @param {Array}   o.stages         pipeline stages, first one is where new leads land
 * @param {Array}   o.enquiryTypes   the tenant's enquiry types
 * @param {number}  o.now
 * @param {?string} o.signal         the custom-trigger webhook this came through (see SIGNALS)
 * @returns {{ isNew, stale, leadWrite, stateWrite, history: Array, notes: Array, signalEvent: ?object }}
 */
export function planUpdate({ envelope, lead, state, leadId, tenantId, stages, enquiryTypes, now, signal = null }) {
  const d = (envelope && envelope.data) || {};
  const occurredAt = toMs(envelope && envelope.occurred_at) || now;
  const prevTt = (lead && lead.tt) || null;
  const isNew = !lead;
  const firstLink = !isNew && !prevTt;

  const history = [];
  const notes = [];
  // `at` backdates an entry to when it happened (first message); omitted = when it was recorded.
  const hist = (type, text, at = null) => history.push(at ? { type, text, at } : { type, text });
  // A pull (import, daily sync, "Sync TailorTalk") rather than a live webhook.
  const pulled = !!(envelope && envelope.webhook_trigger === 'sync');

  // Conversation, bookings and payments only ever grow, so even a stale payload contributes.
  const incomingChat = normaliseChat(d.chat_history);
  const { chat, truncated } = mergeChat(state && state.chat, incomingChat);

  // ── One person, one lead ──
  // The same number can reach TailorTalk as two conversations (WhatsApp and website chat).
  // Both belong to this lead: their messages merge into one conversation, and every id is
  // kept in tt.ids so either finds the lead. A live webhook carries no id at all — the lead is
  // found by phone and the id it already has is kept (a "contact_" placeholder is replaced as
  // soon as a real id is seen).
  const incomingId = String(d.id || '');
  const isPlaceholder = id => String(id || '').startsWith('contact_');
  const prevIds = prevTt ? (prevTt.ids || (prevTt.id ? [prevTt.id] : [])) : [];
  const ids = Array.from(new Set([...prevIds, incomingId].filter(Boolean)));
  const switched = !!(prevTt && prevTt.id && incomingId && prevTt.id !== incomingId && !isPlaceholder(prevTt.id) && !isPlaceholder(incomingId));
  const newConversation = switched && !prevIds.includes(incomingId);

  let stale = !!(prevTt && prevTt.lastEventAt && occurredAt < prevTt.lastEventAt);
  // Of two conversations with one person, the one they wrote in most recently describes them
  // now; the other still adds its messages but does not overwrite the lead.
  const incomingLastMsg = Math.max(toMs(d.last_message_time) || 0, lastAt(incomingChat, ['user']) || 0);
  if (!stale && switched && incomingLastMsg < ((prevTt && prevTt.lastMessageAt) || 0)) stale = true;

  const parts = contactParts(d.lead_contact);
  const integration = clean(d.integration);
  const leadSource = clean(d.lead_source);
  const ad = d.ad_data && typeof d.ad_data === 'object' ? d.ad_data : null;

  const sellerType = (enquiryTypes || []).find(t => String(t).toLowerCase() === 'seller listing') || null;
  const ttValues = {
    name: clean(d.lead_name),
    propertyInterest: shortValue(d.preferred_location),
    budget: shortValue(d.budget_and_finance, 40),
    // Vendors and collaborations get their own category; the seller webhook is an explicit
    // answer to "is this an owner?", so it outranks the guess from intent_and_who.
    enquiryType: (isBusinessCategory(d.category) && (enquiryTypes || []).includes(BUSINESS_ENQUIRY_TYPE) && BUSINESS_ENQUIRY_TYPE)
      || (OWNER_SIGNALS.has(signal) && sellerType)
      || enquiryTypeFor(d.intent_and_who, enquiryTypes)
  };

  // ── Custom-trigger signal ──
  // One entry per signal key: when it first fired since the team last touched the lead, the
  // latest time it fired, how often, and the words at that moment — the lead's latest message
  // and 3 PIN's latest reply. `signalEvent` is the same moment for the append-only event log
  // that automations read (ttSignalEvents); a retry of an event already recorded yields none.
  const signals = { ...((prevTt && prevTt.signals) || {}) };
  let signalEvent = null;
  if (signal) {
    const prev = signals[signal];
    const def = SIGNAL_DEFS[signal] || null;
    const cut = s => (s ? (s.length > 200 ? s.slice(0, 199) + '…' : s) : null);
    const lastUser = [...chat].reverse().find(m => m.role === 'user' && m.content);
    const lastReply = [...chat].reverse().find(m => (m.role === 'assistant' || m.role === 'human_agent') && m.content && !isNoReplyMarker(m));
    const quote = cut(lastUser && lastUser.content);
    const reply = cut(lastReply && lastReply.content);
    const shown = def && def.quoteFrom === 'reply' ? reply : quote;
    const handledAt = (lead && lead.updatedAt) || 0;
    if (prev && occurredAt <= (prev.lastAt || prev.at)) {
      // A retry of an event already recorded — nothing new happened.
    } else if (prev && prev.at > handledAt) {
      // Still open: the same moment again. Keep when it started, refresh the words.
      signals[signal] = { ...prev, lastAt: occurredAt, quote: quote || prev.quote || null, reply: reply || prev.reply || null, count: (prev.count || 1) + 1 };
      signalEvent = { signal, at: occurredAt, quote, reply, repeat: true };
    } else {
      signals[signal] = { at: occurredAt, lastAt: occurredAt, quote, reply, count: 1 };
      signalEvent = { signal, at: occurredAt, quote, reply, repeat: false };
      const label = def ? def.label : `Custom trigger “${signal}”`;
      hist('tailortalk', `${def ? def.icon : '🔔'} <b>${escapeHtml(label)}</b>${shown ? ' — “' + escapeHtml(shown) + '”' : ''}`);
    }
  }

  const status = clean(d.lead_status) ? clean(d.lead_status).toLowerCase() : null;

  // ── What needs a person, and since when ──
  // "Needs attention" in the CRM counts an escalation, flag, open signal or message left for the
  // team only if it is newer than both the team's last touch (updatedAt) and attentionFrom.
  // A lead first seen through a pull (the import) starts attentionFrom 48 h back: an escalation
  // from weeks ago is history, a message left for the team yesterday still needs someone.
  const firstSight = !prevTt;
  const attentionFrom = firstSight
    ? (pulled ? now - 48 * 3600000 : null)
    : (prevTt.attentionFrom ?? null);
  // When a flag switched on: kept while it stays on; unknown (null) when it was already on the
  // first time a pull saw the lead; otherwise when this event says it happened.
  const switchedOnAt = (on, prevOn, prevAt) => {
    if (!on) return null;
    if (!firstSight && prevOn) return prevAt ?? null;
    if (firstSight && pulled) return null;
    return occurredAt;
  };

  const freshTt = {
    id: incomingId,
    ids,
    contact: clean(d.lead_contact),
    handle: parts.handle || null,
    integration,
    leadSource,
    category: clean(d.category),
    status,
    statusAt: prevTt && prevTt.status === status ? (prevTt.statusAt || occurredAt) : occurredAt,
    converted: d.is_converted === true,
    convertedAt: toMs(d.converted_at),
    locked: d.lead_lock_status === true,
    escalated: d.escalated === true,
    escalatedAt: switchedOnAt(d.escalated === true, prevTt && prevTt.escalated, prevTt && prevTt.escalatedAt),
    escalatedTo: textOf(d.escalated_to),
    flagged: d.flagged === true,
    flaggedAt: switchedOnAt(d.flagged === true, prevTt && prevTt.flagged, prevTt && prevTt.flaggedAt),
    flagDetails: shortValue(d.flag_details, 120),
    awaitingTeamAt: awaitingTeamSince(chat),
    attentionFrom,
    followups: Number(d.total_followups) || 0,
    lastSeen: d.last_message_seen === true,
    owner: textOf(d.owner),
    adId: ad ? clean(ad.id) : null,
    adTitle: ad ? clean(ad.title) : null,
    adUrl: ad ? clean(ad.source_url) : null,
    stage: shortValue(d.stage_and_next_action, 40),
    values: ttValues,
    // Webhooks send created_at; get_leads sends joined.
    createdAt: toMs(d.created_at) || toMs(d.joined),
    lastMessageAt: Math.max(lastAt(chat, ['user']) || 0, (prevTt && prevTt.lastMessageAt) || 0, toMs(d.last_message_time) || 0) || null,
    lastReplyAt: lastAt(chat, ['assistant', 'human_agent']),
    lastEventAt: occurredAt,
    lastTrigger: clean(envelope && envelope.webhook_trigger),
    signals,
    syncedAt: now
  };

  // A late retry keeps the newer snapshot; it may still move lastMessageAt forward, and a
  // signal it carries still happened.
  const tt = stale
    ? { ...prevTt, ids, signals, lastMessageAt: Math.max(prevTt.lastMessageAt || 0, freshTt.lastMessageAt || 0) || null, syncedAt: now }
    : freshTt;

  const leadWrite = { tt };

  // What the CRM records when it first meets a conversation: where it began (dated to the
  // message itself) and a snapshot of where it stands. The day-by-day activity is drawn on the
  // lead page from the stored conversation, so it costs no writes and never falls out of step.
  const realChat = chat.filter(m => !isNoReplyMarker(m));
  const firstMsg = realChat[0] || null;
  const origin = [sourceLabel(leadSource), freshTt.adTitle].filter(Boolean).join(' · ');
  const channelName = { whatsapp: 'WhatsApp', instagram: 'Instagram', website: 'website chat' }[channelFor(integration, leadSource)] || '';
  const firstEntry = () => {
    if (!firstMsg) return null;
    const who = firstMsg.role === 'user' ? `💬 First message${channelName ? ' on ' + channelName : ''}` : '📣 3 PIN messaged first';
    return `${who}${origin ? ' (' + escapeHtml(origin) + ')' : ''}${firstMsg.content ? ' — “' + escapeHtml(quoteOf(firstMsg.content)) + '”' : ''}`;
  };
  const snapshotEntry = verb => {
    const fromLead = realChat.filter(m => m.role === 'user').length;
    const span = realChat.length > 1 ? `, ${fmtIST(realChat[0].at)} – ${fmtIST(realChat[realChat.length - 1].at)}` : '';
    const bits = [
      statusLabel(status) || null,
      d.escalated === true ? 'escalated' : null,
      d.lead_lock_status === true ? 'AI paused' : null,
      d.flagged === true ? 'flagged' : null,
      realChat.length ? `${realChat.length} message${realChat.length === 1 ? '' : 's'} (${fromLead} from the lead)${span}` : null,
      freshTt.followups ? `${freshTt.followups} AI follow-up${freshTt.followups === 1 ? '' : 's'}` : null
    ].filter(Boolean).map(escapeHtml);
    const next = clean(d.stage_and_next_action);
    return `📥 ${verb} from <b>TailorTalk</b>${bits.length ? ' — ' + bits.join(' · ') : ''}${next ? '<br>Next: ' + escapeHtml(quoteOf(next)) : ''}`;
  };

  if (isNew) {
    const createdAt = freshTt.createdAt || occurredAt;
    Object.assign(leadWrite, {
      id: leadId,
      tenantId,
      name: ttValues.name || parts.phone || (parts.handle ? '@' + parts.handle : '') || parts.email || 'TailorTalk lead',
      phone: parts.phone,
      phoneKey: parts.phoneKey,
      email: parts.email,
      channel: channelFor(integration, leadSource),
      enquiryType: ttValues.enquiryType || '',
      propertyInterest: ttValues.propertyInterest || '',
      budget: ttValues.budget || '',
      source: 'tailortalk',
      stageId: (stages && stages[0] && stages[0].id) || 'new',
      detailsSent: false,
      contactAt: createdAt,
      followUpAt: null,
      createdAt,
      updatedAt: createdAt,
      createdBy: 'TailorTalk',
      updatedBy: null,
      lastActionType: 'created',
      noteCount: 0,
      lastNote: null,
      ttHold: {}
    });
    const first = firstEntry();
    hist('created', first || `Lead added from <b>TailorTalk</b>${origin ? ' (' + escapeHtml(origin) + ')' : ''}`, (firstMsg && firstMsg.at) || createdAt);
    hist('tailortalk', snapshotEntry('Added to the CRM'));
  } else if (firstLink) {
    // An existing lead the team typed in, now matched to a TailorTalk chat by phone number.
    // Blanks get filled; whatever the team already wrote is theirs and stays.
    const hold = { ...(lead.ttHold || {}) };
    for (const f of FOLLOW_FIELDS) {
      const have = clean(lead[f]);
      if (have) hold[f] = true;
      else if (ttValues[f]) leadWrite[f] = ttValues[f];
    }
    leadWrite.ttHold = hold;
    if (!clean(lead.phone) && parts.phone) leadWrite.phone = parts.phone;
    if (!clean(lead.email) && parts.email) leadWrite.email = parts.email;
    if (!clean(lead.channel)) { const ch = channelFor(integration, leadSource); if (ch) leadWrite.channel = ch; }
    if (firstMsg) hist('tailortalk', firstEntry(), firstMsg.at);
    hist('tailortalk', snapshotEntry('Linked to a conversation'));
  } else if (!stale) {
    const hold = lead.ttHold || {};
    const LABEL = { name: 'Name', propertyInterest: 'Property / Locality', budget: 'Budget', enquiryType: 'Enquiry type' };
    for (const f of FOLLOW_FIELDS) {
      const next = ttValues[f];
      if (!next) continue;
      if (!hold[f]) {
        if (!sameText(next, lead[f])) {
          leadWrite[f] = next;
          hist('tailortalk', `${LABEL[f]} changed from <b>${escapeHtml(lead[f] || '—')}</b> to <b>${escapeHtml(next)}</b> (TailorTalk)`);
        }
      } else {
        const prevSaid = prevTt.values ? prevTt.values[f] : null;
        if (!sameText(next, lead[f]) && !sameText(next, prevSaid)) {
          hist('tailortalk', `TailorTalk now says ${LABEL[f].toLowerCase()} is <b>${escapeHtml(next)}</b> — kept <b>${escapeHtml(lead[f] || '—')}</b> because it was edited here`);
        }
      }
    }
  }

  if (!isNew && lead.phone && !lead.phoneKey) leadWrite.phoneKey = phoneKey(lead.phone);
  if (!isNew && !lead.phone && parts.phone && !leadWrite.phone) { leadWrite.phone = parts.phone; }
  if (leadWrite.phone && !leadWrite.phoneKey) leadWrite.phoneKey = phoneKey(leadWrite.phone);

  // A second conversation joining this lead is said once; its status is not a "change" from
  // the other conversation's, so the diff below is skipped for that event.
  if (newConversation) {
    const where = channelName || sourceLabel(leadSource) || 'another channel';
    hist('tailortalk', `💬 Also chatting on <b>${escapeHtml(where)}</b> — a second TailorTalk conversation with the same number, merged into this lead`);
  }

  // What changed in TailorTalk's own view of the lead. Skipped on creation (the "added"
  // entry says it), on a stale payload (it would describe going backwards) and when the
  // update comes from the lead's other conversation.
  if (prevTt && !stale && !switched) {
    if (status && prevTt.status !== status) {
      hist('tailortalk', prevTt.status
        ? `TailorTalk status changed from <b>${escapeHtml(statusLabel(prevTt.status))}</b> to <b>${escapeHtml(statusLabel(status))}</b>`
        : `TailorTalk status set to <b>${escapeHtml(statusLabel(status))}</b>`);
    }
    if (freshTt.converted && !prevTt.converted) hist('tailortalk', 'Marked <b>converted</b> in TailorTalk');
    if (freshTt.locked !== !!prevTt.locked) {
      hist('tailortalk', freshTt.locked ? 'AI paused — a team member has taken over the chat in TailorTalk' : 'AI is replying again in TailorTalk');
    }
    if (freshTt.escalated !== !!prevTt.escalated) {
      hist('tailortalk', freshTt.escalated
        ? `Escalated in TailorTalk${freshTt.escalatedTo ? ' to <b>' + escapeHtml(freshTt.escalatedTo) + '</b>' : ''}`
        : 'Escalation cleared in TailorTalk');
    }
    if (freshTt.flagged !== !!prevTt.flagged) {
      hist('tailortalk', freshTt.flagged
        ? `Flagged in TailorTalk${freshTt.flagDetails ? ': <b>' + escapeHtml(freshTt.flagDetails) + '</b>' : ''}`
        : 'Flag cleared in TailorTalk');
    }
    if (freshTt.stage && !sameText(freshTt.stage, prevTt.stage)) {
      hist('tailortalk', prevTt.stage
        ? `TailorTalk stage: <b>${escapeHtml(prevTt.stage)}</b> → <b>${escapeHtml(freshTt.stage)}</b>`
        : `TailorTalk stage: <b>${escapeHtml(freshTt.stage)}</b>`);
    }
    if (freshTt.owner && freshTt.owner !== prevTt.owner) {
      hist('tailortalk', `TailorTalk owner is now <b>${escapeHtml(freshTt.owner)}</b>`);
    }
  }

  // Bookings and payments: new ids only, whatever the payload's age.
  const metadata = Array.isArray(d.metadata) ? d.metadata : [];
  const bookings = [...((state && state.bookings) || [])];
  const payments = [...((state && state.payments) || [])];
  const seenBooking = new Set(bookings.map(b => b.id));
  const seenPayment = new Set(payments.map(p => p.id));
  let followUpAt = !isNew && lead.followUpAt ? lead.followUpAt : null;

  for (const m of metadata) {
    if (!m || typeof m !== 'object') continue;
    if (m.type === 'booking') {
      const id = clean(m.booking_id) || `${m.start_time}|${m.summary}`;
      if (seenBooking.has(id)) continue;
      seenBooking.add(id);
      const start = toMs(m.start_time);
      const b = {
        id, start, minutes: Number(m.duration_minutes) || null,
        summary: clean(m.summary), description: clean(m.description),
        link: clean(m.meeting_link), bookedAt: toMs(m.booked_at)
      };
      bookings.push(b);
      const what = b.summary || 'Booking';
      // Recorded once, in the history. (Not also as a note — the same fact twice is noise; the
      // meeting link lives with the booking in the TailorTalk section.)
      hist('tailortalk', `Booked through TailorTalk: <b>${escapeHtml(what)}</b>${start ? ' on <b>' + escapeHtml(fmtIST(start)) + '</b>' : ''}`);
      // A booked visit is the next time someone must act, unless the team already has a
      // follow-up that is still ahead of now.
      if (start && start > now && (!followUpAt || followUpAt < now)) {
        followUpAt = start;
        leadWrite.followUpAt = start;
        hist('followup', `Next follow-up set for <b>${escapeHtml(fmtIST(start))}</b> (TailorTalk booking)`);
      }
    } else if (m.type === 'razorpay_payment') {
      const id = clean(m.payment_id) || `${m.order_id}|${m.authorized_at}`;
      if (seenPayment.has(id)) continue;
      seenPayment.add(id);
      // Razorpay reports amounts in the currency's smallest unit (paise for INR).
      const amount = Number(m.amount);
      const major = Number.isFinite(amount) ? amount / 100 : null;
      const p = { id, orderId: clean(m.order_id), amount: major, currency: clean(m.currency) || 'INR', at: toMs(m.authorized_at) };
      payments.push(p);
      const shown = major === null ? 'a payment' : `${p.currency === 'INR' ? '₹' : p.currency + ' '}${major.toLocaleString('en-IN')}`;
      hist('tailortalk', `Payment authorised through TailorTalk: <b>${escapeHtml(shown)}</b> (${escapeHtml(id)})`);
    }
  }

  const profile = {};
  for (const k of PROFILE_FIELDS) profile[k] = clean(d[k]);
  const extra = {};
  for (const [k, v] of Object.entries(d)) {
    if (KNOWN_KEYS.has(k)) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
      const c = typeof v === 'string' ? clean(v) : v;
      if (c !== null && c !== undefined) extra[k] = c;
    }
  }
  // Each fact is stored once: status, flags, ad and escalation live on the lead's `tt`; the long
  // profile text, bookings, payments and conversation live here. No raw copy of the payload —
  // every field of it is already in one of the two places (unknown attributes in `extra`).
  const stateWrite = stale && state
    ? { ...state, chat, chatTruncated: !!(state.chatTruncated || truncated), bookings, payments, updatedAt: now }
    : {
        tenantId,
        leadId,
        ttId: String(d.id || ''),
        profile,
        extra,
        profilePic: clean(d.profile_pic),
        bookings,
        payments,
        chat,
        chatTruncated: !!((state && state.chatTruncated) || truncated),
        lastEventAt: occurredAt,
        updatedAt: now
      };

  if (signalEvent) {
    // What the lead looked like at that moment — the context an automation or a report needs
    // ("closing signals from Warm leads") without re-reading the lead.
    signalEvent.status = tt.status || null;
    signalEvent.stageId = (lead && lead.stageId) || leadWrite.stageId || null;
  }
  return { isNew, stale, leadWrite, stateWrite, history, notes, signalEvent };
}

// TailorTalk's "Sample payload" and "Test Webhook" send a made-up lead. It proves the URL works
// and must never become a real lead on the board.
export function isTestEnvelope(envelope) {
  const d = (envelope && envelope.data) || {};
  return (envelope && envelope.webhook_trigger === 'sample_trigger') || /^dummy_/.test(String(d.id || ''));
}
