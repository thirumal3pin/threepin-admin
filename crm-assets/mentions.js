// ═══════════════════════════════════════════════════════════════════════
// @MENTIONS — pulling a teammate into a lead from a note.
//
// Pure, dependency-free ES module shared by the CRM page (bridged onto window.crmMentions in
// crm.html) and the morning digest (api/followup-digest.js).
//
//   settings/{tenant}.team.{teamKey}   { email } — the team, as the owner set it (only these people
//                                      can be mentioned)
//   note.mentions                      emails mentioned in that note
//   lead.mentions.{teamKey}            { email, by, at, noteId, text, doneAt } — the latest
//                                      mention of each person on the lead
//
// A person is written as @ + the part of their email before the "@" (name@company.com →
// @name). A mention stays open until they press Done or do anything on the lead afterwards.
// ═══════════════════════════════════════════════════════════════════════

export const teamKey = email => String(email || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_');
export const handleOf = email => String(email || '').trim().toLowerCase().split('@')[0];

// "first.last@company.com" → "First Last"
export function displayName(email) {
  return handleOf(email).split(/[._-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || String(email || '');
}

const MENTION = /(^|[^\w@])@([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)/gi;

// The roster emails a text mentions, in order, without the writer themselves.
export function mentionedEmails(text, roster, selfEmail) {
  const byHandle = new Map((roster || []).map(e => [handleOf(e), String(e).toLowerCase()]));
  const self = String(selfEmail || '').toLowerCase();
  const out = [];
  for (const m of String(text || '').matchAll(MENTION)) {
    const email = byHandle.get(m[2].toLowerCase());
    if (email && email !== self && !out.includes(email)) out.push(email);
  }
  return out;
}

// The open mention of `email` on a lead, or null.
export function openMentionFor(lead, email) {
  if (!lead || !email) return null;
  const m = lead.mentions && lead.mentions[teamKey(email)];
  if (!m || m.doneAt) return null;
  // Anything the mentioned person did on the lead afterwards answers it.
  if (String(lead.updatedBy || '').toLowerCase() === String(email).toLowerCase() && (lead.updatedAt || 0) > (m.at || 0)) return null;
  return m;
}

export function openMentionsFor(leads, email) {
  return (leads || []).map(lead => ({ lead, mention: openMentionFor(lead, email) })).filter(x => x.mention)
    .sort((a, b) => (b.mention.at || 0) - (a.mention.at || 0));
}
