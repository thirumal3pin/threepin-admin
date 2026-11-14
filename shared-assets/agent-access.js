/* ═══════ WHO MAY SEE WHAT — the agent layer's rules, as pure functions ═══════
 *
 * The server (api/_agent-work.js) builds every agent's copy of the properties and their matching
 * leads from these, decides who may approve a request, and whether a grant is still running. The
 * pages use the same functions to draw the same answers (My Day, Properties, Messages), and the
 * tests check them without a database.
 *
 * A property's agents: `assignedAgent` is the PRIMARY agent (one email, set by an admin), and
 * `secondaryAgents` the co-agents (any number, added as collaborations are approved). The older
 * single `secondaryAgent` field is still read, and kept equal to the first co-agent, so every
 * screen written before the agent layer goes on showing the right names.
 *
 * Grants (grants/{id}) open one property — or one lead — to one agent:
 *   { kind: 'property' | 'lead', targetId, agentEmail, active, expiresAt (ms | null),
 *     includeContact, contactExpiresAt (ms | null), … }
 * Details run until expiresAt (null = no limit). The owner's number is a separate tier: shown only
 * while includeContact is on and its own timer runs, and never beyond the details timer.
 */

import { effectiveConfig, projectProperty, PROPERTY_FIELDS } from './agent-config.js';

export const lc = s => String(s == null ? '' : s).trim().toLowerCase();
const uniq = list => [...new Set(list.filter(Boolean))];
const isEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''));

// A key safe in a Firestore field path (thread unread counts, read marks): the email with every
// character that is not a letter or digit turned into _.
export const emailKey = e => lc(e).replace(/[^a-z0-9]/g, '_');

// ── A property's agents ──
export function primaryOf(p) {
  const a = p && p.assignedAgent;
  return lc(Array.isArray(a) ? a[0] : a) || '';
}
export function coAgentsOf(p) {
  if (!p) return [];
  const list = Array.isArray(p.secondaryAgents) ? p.secondaryAgents : [];
  const primary = primaryOf(p);
  return uniq([...list, p.secondaryAgent].map(lc)).filter(e => e !== primary && isEmail(e));
}
export function agentsOf(p) {
  return uniq([primaryOf(p), ...coAgentsOf(p)]);
}
// 'primary' | 'co' | null
export function roleOn(p, email) {
  const me = lc(email);
  if (!me) return null;
  if (primaryOf(p) === me) return 'primary';
  return coAgentsOf(p).includes(me) ? 'co' : null;
}
// How a lead names a property: its code (propertyCode, else the document id).
export const codeOf = p => String((p && (p.propertyCode || p.id)) || '');

// What an assignment writes on the property: the primary, the co-agents, and the old single field
// kept as the first co-agent. Emails cleaned, the primary never also a co-agent.
export function assignmentPatch(primary, coAgents) {
  const p = lc(primary);
  const co = uniq((coAgents || []).map(lc)).filter(e => e !== p && isEmail(e));
  return { assignedAgent: p || null, secondaryAgents: co, secondaryAgent: co[0] || null };
}

// Still on the market. Sold or let properties, and ones taken off ("inactive", "withdrawn"), are
// not offered to other agents' clients.
const GONE = /\b(sold|let out|rented|leased out|withdrawn|inactive|on hold|not available|unavailable|closed)\b/i;
export function isActiveProperty(p) {
  if (!p || p.soldOut === true) return false;
  return !GONE.test(String(p.availability || ''));
}

// ── Grants ──
const num = v => (typeof v === 'number' && isFinite(v) ? v : (v && typeof v.toMillis === 'function' ? v.toMillis() : null));
export function grantLive(g, now = Date.now()) {
  if (!g || g.active !== true) return false;
  const until = num(g.expiresAt);
  return until == null || until > now;
}
export function contactLive(g, now = Date.now()) {
  if (!grantLive(g, now) || g.includeContact !== true) return false;
  const until = num(g.contactExpiresAt);
  return until == null || until > now;
}
// The first moment anything in these grants stops (details or the owner's number), else null.
export function nextExpiry(grants, now = Date.now()) {
  let next = null;
  (grants || []).forEach(g => {
    if (!grantLive(g, now)) return;
    [num(g.expiresAt), contactLive(g, now) ? num(g.contactExpiresAt) : null].forEach(t => {
      if (t != null && t > now && (next == null || t < next)) next = t;
    });
  });
  return next;
}
export const grantId = (tenantId, kind, targetId, email) => `${tenantId}__${kind === 'lead' ? 'l' : 'p'}__${String(targetId).replace(/\//g, '_')}__${emailKey(email)}`;

// ── Requests ──
// Who may decide a request. Admins always may (they are passed in); on a property, its primary agent,
// or every agent on it when the setting says so; on a lead, the lead's own agent(s). The requester
// never decides their own request.
export function approversFor({ kind, property, lead, approvers = 'primary', admins = [], requester }) {
  const out = [...(admins || [])].map(lc);
  if (approvers !== 'admins') {
    if (kind === 'lead' && lead) {
      out.push(lc(lead.assignedAgent));
      if (approvers === 'all') out.push(lc(lead.secondaryAgent));
    } else if (property) {
      out.push(primaryOf(property));
      if (approvers === 'all') out.push(...coAgentsOf(property));
    }
  }
  const me = lc(requester);
  return uniq(out).filter(e => isEmail(e) && e !== me);
}

export const REQUEST_STATUS = ['pending', 'approved', 'rejected', 'cancelled', 'expired'];

// A timer chosen on the approve sheet, as the moment it ends (null = no limit). days / hours, or an
// exact time `until` (ms) that must be in the future and within a year.
export function timerEnd({ days, hours, until } = {}, now = Date.now()) {
  if (until != null) {
    const t = Number(until);
    if (!isFinite(t) || t <= now || t > now + 366 * 86400000) return undefined;
    return t;
  }
  if (days != null) { const d = Number(days); return d > 0 && d <= 366 ? now + d * 86400000 : undefined; }
  if (hours != null) { const h = Number(hours); return h > 0 && h <= 24 * 366 ? now + h * 3600000 : undefined; }
  return null;
}

// ── The agent's copy of the inventory ──
// Every property the agent may see, each with only the fields their settings allow:
//   own      primary or co-agent: the "own" fields
//   granted  an approved request still running: the "granted" fields, plus the owner's name and
//            number while that tier runs
//   summary  any other active property: the "other properties" fields
// Inactive properties appear only to their own agents (and to a running grant).
export function buildPropertyView({ properties, grants, cfg, email, now = Date.now() }) {
  const me = lc(email);
  const live = (grants || []).filter(g => g.kind === 'property' && lc(g.agentEmail) === me && grantLive(g, now));
  const byTarget = new Map(live.map(g => [String(g.targetId), g]));
  const out = [];
  (properties || []).forEach(p => {
    const role = roleOn(p, me);
    const g = byTarget.get(String(p.id));
    let access, fields;
    if (role) { access = role === 'primary' ? 'own' : 'co'; fields = cfg.ownPropertyFields; }
    else if (g) { access = 'granted'; fields = contactLive(g, now) ? [...cfg.grantedPropertyFields, 'contact'] : cfg.grantedPropertyFields; }
    else if (isActiveProperty(p)) { access = 'summary'; fields = cfg.otherPropertyFields; }
    else return;
    const row = projectProperty(p, fields);
    row._access = access;
    row._code = codeOf(p);
    row._active = isActiveProperty(p);
    // The primary agent's name travels for the "who to ask" line only when the settings show it.
    if (g && access === 'granted') row._grant = { id: g.id || null, until: num(g.expiresAt), contactUntil: contactLive(g, now) ? num(g.contactExpiresAt) : null, requestId: g.requestId || null };
    out.push(row);
  });
  // Mine first, then shared with me, then the rest; by title within each.
  const rank = { own: 0, co: 0, granted: 1, summary: 2 };
  out.sort((a, b) => rank[a._access] - rank[b._access] || String(a.name || '').localeCompare(String(b.name || '')));
  return out;
}

// ── Leads ──
// The agents a lead belongs to through its properties: the agents of every property it enquired
// about (propertyCodes), and of the property a visit is booked on.
export function propertyAgentsOfLead(lead, agentsByCode) {
  const codes = uniq([...(Array.isArray(lead && lead.propertyCodes) ? lead.propertyCodes : []), lead && lead.siteVisitProperty].map(c => String(c || '')));
  const out = [];
  codes.forEach(c => { (agentsByCode.get(c) || []).forEach(e => out.push(e)); });
  return uniq(out);
}
// Everyone who reaches a lead through the agent layer (stored on the lead as agentAccess, which the
// rules read): its properties' agents, and agents holding a running grant on it. The lead's own
// agents (assignedAgent, secondaryAgent) reach it through those fields and are not repeated.
export function leadAccessFor(lead, agentsByCode, leadGrants, now = Date.now()) {
  const own = new Set([lc(lead && lead.assignedAgent), lc(lead && lead.secondaryAgent)]);
  const out = propertyAgentsOfLead(lead, agentsByCode);
  (leadGrants || []).forEach(g => { if (g.kind === 'lead' && String(g.targetId) === String(lead.id) && grantLive(g, now)) out.push(lc(g.agentEmail)); });
  return uniq(out).filter(e => !own.has(e)).sort();
}
export function agentsByCodeOf(properties) {
  const m = new Map();
  (properties || []).forEach(p => {
    const a = agentsOf(p);
    if (!a.length) return;
    [codeOf(p), String(p.id)].forEach(c => { if (c) m.set(c, uniq([...(m.get(c) || []), ...a])); });
  });
  return m;
}
export function leadVisibleTo(lead, email) {
  const me = lc(email);
  if (!me || !lead) return false;
  return lc(lead.assignedAgent) === me || lc(lead.secondaryAgent) === me
    || (Array.isArray(lead.agentAccess) && lead.agentAccess.map(lc).includes(me));
}

// What a matching lead shows an agent who does not work it: the requirement and an AI summary with
// names and numbers taken out (and more only if the settings say so).
const PHONE_IN_TEXT = /(?:\+?91[\s.-]*|\b0)?(?:[6-9]\d{2}[\s.-]?\d{3}[\s.-]?\d{4}|[6-9]\d{4}[\s.-]?\d{5}|4\d[\s.-]?\d{4}[\s.-]?\d{4})\b/g;
const EMAIL_IN_TEXT = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
export function scrubText(text, names) {
  let s = String(text || '').replace(PHONE_IN_TEXT, '•••').replace(EMAIL_IN_TEXT, '•••');
  (names || []).forEach(n => {
    String(n || '').split(/\s+/).filter(w => w.length >= 3).forEach(w => {
      s = s.replace(new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), 'the client');
    });
  });
  return s.replace(/(the client\s+){2,}/gi, 'the client ').trim();
}
export function requirementOf(lead) {
  const tt = (lead && lead.tt) || {};
  const parts = [lead && lead.propertyInterest, lead && lead.budget && ('Budget ' + lead.budget), tt.preferred_location, tt.requirement_details]
    .map(x => String(x || '').trim()).filter(Boolean);
  return uniq(parts).join(' · ').slice(0, 400);
}
export function matchCard(lead, fields, extra) {
  const want = new Set(fields || []);
  const names = [lead && lead.name];
  const out = { ...(extra || {}) };
  if (want.has('requirement')) out.requirement = scrubText(requirementOf(lead), names);
  if (want.has('aiSummary')) out.aiSummary = scrubText(lead && lead.aiSummary, names).slice(0, 900);
  if (want.has('name')) out.name = String((lead && lead.name) || '');
  if (want.has('stage')) out.stage = String((lead && lead.stageId) || '');
  if (want.has('source')) out.source = String((lead && (lead.source || lead.channel)) || '');
  if (want.has('phone')) out.phone = String((lead && lead.phone) || '');
  return out;
}

export { effectiveConfig, PROPERTY_FIELDS };
