// Eåsy's arithmetic — the day plan, reminders, the pre-visit gist, seller summaries, property codes
// and completeness. Pure: records in, plain objects out, no database, no model, no clock of its
// own (every function takes `now`). api/_easy.js reads the records and calls these; the tests
// (tests/easy.test.mjs) call them directly.
//
// Numbers and rules are the Eåsy Requirements Document (v2), Part C — the section is named on each.

import { computeAttention, isBusinessLead, SEVERITY_RANK } from '../crm-assets/leadAttention.js';
import { stageKindOf, stageKeyOf, visitOf, visitIsOpen } from '../crm-assets/pipeline.js';
import * as TM from '../shared-assets/task-model.js';

const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const IST = 5.5 * HOUR;

export const lc = s => String(s == null ? '' : s).trim().toLowerCase();
export const istDay = ts => TM.istDay(ts);
export const istTime = ts => new Date(ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
export const istDate = ts => ts ? new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : null;
// ms at hh:mm IST on the IST day of `now`
export const istAt = (now, h, m = 0) => Math.floor((now + IST) / DAY) * DAY - IST + h * HOUR + m * MIN;

// ── Who a record belongs to ───────────────────────────────────────────────

// A visit is the agent's when they are on its invitation; a visit with nobody on it is everyone's.
export function visitIsMine(lead, email) {
  const agents = Array.isArray(lead.siteVisitAgents) ? lead.siteVisitAgents.map(lc) : [];
  return !agents.length || agents.includes(lc(email));
}

const isClosed = (lead, stages) => ['won', 'lost'].includes(stageKindOf((stages || []).find(s => s.id === lead.stageId) || null));

// ── Properties (MVP-01, MVP-03) ─────────────────────────────────────────

// MVP-03's mandatory list. Photos are a Drive folder link here, so "has photos" is the link being set.
export const MANDATORY = [
  ['contactName', 'owner name'], ['contactNumber', 'owner phone'], ['location', 'locality'],
  ['type', 'type'], ['config', 'configuration'], ['startingPrice', 'price or rent'], ['photosLink', 'photos']
];
export function completeness(p) {
  const missing = MANDATORY.filter(([k]) => !String((p && p[k]) || '').trim());
  return { pct: Math.round((MANDATORY.length - missing.length) / MANDATORY.length * 100), missing: missing.map(([, l]) => l), missingKeys: missing.map(([k]) => k) };
}

export const codeKey = c => lc(c).replace(/[\s-]/g, '');
// "Velachery, Chennai" → "VEL"; the next free number for that prefix → "VEL008" (Part C, C1 conventions).
export function nextCode(location, properties) {
  const word = String(location || '').split(',')[0].replace(/[^a-z]/gi, '').toUpperCase();
  const prefix = (word + 'XXX').slice(0, 3);
  let max = 0;
  for (const p of properties || []) {
    const m = String(p.propertyCode || '').toUpperCase().replace(/[\s-]/g, '').match(/^([A-Z]{3})(\d+)$/);
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  return prefix + String(max + 1).padStart(3, '0');
}

// The property fields Eåsy may set, with the label it reads back (MVP-01, MVP-02).
export const PROPERTY_EDITABLE = {
  name: 'title', type: 'type', config: 'configuration', location: 'locality', startingPrice: 'price',
  pricePerSqft: 'rate per sq ft', sqftRange: 'built-up area', carpetArea: 'carpet area', facing: 'facing',
  floorNo: 'floor', furnishing: 'furnishing', parking: 'parking', availability: 'availability',
  status: 'construction status', possession: 'possession', contactName: 'owner name', contactNumber: 'owner phone',
  photosLink: 'photos link', mapLink: 'map pin', brochureLink: 'brochure link', highlights: 'highlights',
  nearbyLandmark: 'landmark', approval: 'approval'
};

// ── The day plan (MVP-10) ───────────────────────────────────────────────

// Part C, C5 MVP-10: escalation, fixed visit, hot, deadline, due, normal.
export const PRIORITY = { escalation: 0, fixed: 1, hot: 2, deadline: 3, due: 4, normal: 5 };
export const MAX_PLAN = 12;                 // items besides the visits; the rest is a count
const MAX_ESCALATIONS = 5;
const MAX_COLD = 5;
const FOLLOW_UP_FRESH = 14 * DAY;           // an overdue follow-up older than this is stale unless the deal is live

// How far along a lead is — what makes it worth a person's time today. -1: parked (on hold).
const STAGE_WEIGHT = { negotiation: 5, visit_done: 4, visit_pending: 4, send_details: 3, options: 2, sourcing: 1, new: 1, on_hold: -1 };
export const isHot = l => !!(l && l.tt && /hot/i.test(String(l.tt.status || '')));
const isWarm = l => !!(l && l.tt && /warm/i.test(String(l.tt.status || '')));
export function leadWeight(lead, stages) {
  const key = stageKeyOf((stages || []).find(s => s.id === lead.stageId) || null);
  return key in STAGE_WEIGHT ? STAGE_WEIGHT[key] : 1;
}
const SLOT = 30 * MIN;
const VISIT_BLOCK = 90 * MIN;       // the visit and the travel around it (proposed)

/**
 * Today's plan for one agent: every visit at its own time, and everything else placed in 30-minute
 * slots between working hours, most important first, around the visits.
 *   leads, tasks, gaps, drafts: records; stages: the pipeline; email: the agent; now: ms
 */
export function buildDayPlan({ leads = [], stages = [], tasks = [], gaps = [], drafts = [], email, now, workFrom = 9, workTo = 18 }) {
  const today = istDay(now);
  const endOfDay = istAt(now, 23, 59);
  const items = [];
  const seen = new Set();
  const push = it => { if (it.leadId && seen.has(it.kind + it.leadId)) return; if (it.leadId) seen.add(it.kind + it.leadId); items.push(it); };

  for (const l of leads) {
    if (isBusinessLead(l)) continue;
    const v = visitOf(l);
    if (v.at && v.status !== 'cancelled' && v.status !== 'done' && istDay(v.at) === today && visitIsMine(l, email)) {
      push({ kind: 'visit', priority: 'fixed', at: v.at, leadId: l.id, title: `Site visit — ${l.name || 'lead'}${v.property ? ' at ' + v.property : ''}`, property: v.property || null });
    }
  }
  // Only what matters now. A live deal or a hot lead always counts; an old lead only when a
  // follow-up is genuinely due (owner's rule, 28 Oct 2026) — not every record with a stale date.
  const weight = l => leadWeight(l, stages);
  const quiet = l => now - (l.updatedAt || 0);
  const live = l => weight(l) >= 3 || isHot(l);
  let cold = 0, esc = 0;
  for (const l of [...leads].sort((a, b) => weight(b) - weight(a) || quiet(a) - quiet(b))) {
    if (isClosed(l, stages) || isBusinessLead(l) || weight(l) < 0) continue;
    const top = computeAttention(l, { stages, now })[0];
    // An escalation is critical AND current: raised in the last 7 days, or on a live deal.
    if (top && top.severity === 'critical' && esc < MAX_ESCALATIONS && (live(l) || now - (top.at || now) <= 7 * DAY)) {
      esc++;
      push({ kind: 'escalation', priority: 'escalation', leadId: l.id, weight: weight(l), title: `${l.name || 'Lead'}: ${top.label}`, detail: top.detail || null });
    }
  }
  for (const l of leads) {
    if (isClosed(l, stages) || isBusinessLead(l) || weight(l) < 0) continue;
    const hot = isHot(l);
    const fu = l.followUpAt;
    if (fu && fu <= endOfDay && (fu >= now - FOLLOW_UP_FRESH || live(l))) {
      push({ kind: 'follow_up', priority: hot ? 'hot' : fu < istAt(now, 0) ? 'deadline' : 'due', leadId: l.id, weight: weight(l),
        title: `Follow up ${l.name || 'lead'}`, detail: fu < now ? 'was due ' + istDate(fu) : 'due ' + istTime(fu) });
    } else if (hot && quiet(l) > DAY && quiet(l) < 30 * DAY) {
      push({ kind: 'follow_up', priority: 'hot', leadId: l.id, weight: weight(l), title: `Call ${l.name || 'lead'} — hot lead`, detail: 'no team contact for a day' });
    }
  }
  // MVP-12, going cold: went quiet 7–21 days ago and was actually moving. The few that matter most.
  const cooling = leads.filter(l => !isClosed(l, stages) && !isBusinessLead(l) && !seen.has('follow_up' + l.id)
    && quiet(l) >= 7 * DAY && quiet(l) <= 21 * DAY && (weight(l) >= 2 || isHot(l) || isWarm(l)))
    .sort((a, b) => weight(b) - weight(a) || quiet(a) - quiet(b));
  for (const l of cooling) {
    if (cold++ >= MAX_COLD) break;
    push({ kind: 'follow_up', priority: 'normal', leadId: l.id, weight: weight(l), title: `Follow up ${l.name || 'lead'} — going cold`, detail: `no contact for ${Math.floor(quiet(l) / DAY)} days` });
  }
  for (const t of TM.morningListFor(tasks, now)[lc(email)] || []) {
    items.push({ kind: 'task', priority: TM.dueBucket(t, now) === 'overdue' ? 'deadline' : 'due', taskId: t.id, title: t.title, detail: t.link && t.link.label || null });
  }
  for (const g of gaps) {
    if (g.status === 'asked' && now - (g.askedAt || 0) >= 7 * DAY) items.push({ kind: 'property_gap', priority: 'normal', code: g.code, title: `Chase ${g.code}: ${g.label || g.field}`, detail: `asked ${Math.floor((now - g.askedAt) / DAY)} days ago` });
  }
  for (const d of drafts) {
    if (d.status === 'opened' && lc(d.by) === lc(email)) items.push({ kind: 'message', priority: 'due', draftId: d.id, title: `Did the message to ${d.toName} go?`, detail: 'tap Sent once it is sent' });
  }

  // Visits hold their time; everything else fills the free 30-minute slots, most important first —
  // within a priority, the deal furthest along — and only the top of the list (the rest is counted).
  const fixed = items.filter(i => i.kind === 'visit').sort((a, b) => a.at - b.at);
  const ranked = items.filter(i => i.kind !== 'visit').sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || (b.weight || 0) - (a.weight || 0));
  const rest = ranked.slice(0, MAX_PLAN);
  const more = ranked.length - rest.length;
  const busy = fixed.map(v => [v.at - 30 * MIN, v.at + VISIT_BLOCK]);
  const start = Math.max(istAt(now, workFrom), Math.ceil(now / SLOT) * SLOT);
  const stop = istAt(now, workTo);
  let t = start;
  for (const it of rest) {
    while (t < stop && busy.some(([a, b]) => t < b && t + SLOT > a)) t += SLOT;
    if (t >= stop) { it.slot = null; continue; }
    it.slot = t; t += SLOT;
  }
  for (const v of fixed) v.slot = v.at;
  const plan = [...fixed, ...rest].sort((a, b) => (a.slot == null) - (b.slot == null) || (a.slot || 0) - (b.slot || 0) || PRIORITY[a.priority] - PRIORITY[b.priority]);
  return Object.assign(plan.map(it => ({ ...it, time: it.slot ? istTime(it.slot) : 'later today' })), { more });
}

// ── Reminders (MVP-11, MVP-12, MVP-13) ─────────────────────────────────

/**
 * What should pop up for this agent right now. Each reminder has a stable key so the page shows it
 * once (the page keeps the keys it has shown). `windowMs` is how far back a missed one still shows.
 */
export function remindersDue({ leads = [], stages = [], properties = [], email, now, windowMs = 15 * MIN }) {
  const out = [];
  for (const l of leads) {
    const v = visitOf(l);
    if (visitIsOpen(v) && visitIsMine(l, email)) {
      const p = findPropertyFor(v.property, properties);
      // MVP-11: two hours before.
      const r2 = v.at - 2 * HOUR;
      if (now >= r2 && now < v.at && now - r2 < 2 * HOUR) {
        out.push({ key: `visit2h:${l.id}:${v.at}`, kind: 'visit', leadId: l.id, at: v.at,
          title: `Site visit at ${istTime(v.at)} — ${l.name || 'lead'}`,
          body: [p ? `${p.propertyCode || ''} ${p.name || ''}`.trim() : v.property, p && p.mapLink ? 'Map: ' + p.mapLink : null].filter(Boolean).join(' · ') });
      }
      // MVP-13: the gist, ten minutes before.
      const g = v.at - 10 * MIN;
      if (now >= g && now < v.at + 30 * MIN) out.push({ key: `gist:${l.id}:${v.at}`, kind: 'gist', leadId: l.id, at: v.at, title: `In 10 minutes: ${l.name || 'lead'}`, gist: visitGist(l, p) });
    }
    // MVP-12: a follow-up at its time.
    if (l.followUpAt && now >= l.followUpAt && now - l.followUpAt < windowMs && !isClosed(l, stages)) {
      out.push({ key: `fu:${l.id}:${l.followUpAt}`, kind: 'follow_up', leadId: l.id, at: l.followUpAt, title: `Follow up ${l.name || 'lead'} now`, body: l.propertyInterest || '' });
    }
  }
  return out;
}

export function findPropertyFor(ref, properties) {
  if (!ref) return null;
  const k = codeKey(ref);
  return (properties || []).find(p => codeKey(p.propertyCode) === k || lc(p.id) === lc(ref))
    || (properties || []).find(p => p.name && lc(ref).includes(lc(p.name)))
    || null;
}

// MVP-13: one card — the lead, the property, the last feedback, the pin, the owner.
export function visitGist(lead, property, notes = []) {
  const p = property || {};
  return {
    lead: { name: lead.name || null, phone: lead.phone || null, wants: [lead.propertyInterest, lead.budget && 'budget ' + lead.budget].filter(Boolean).join(' · ') || null,
      lastNotes: (notes || []).slice(0, 2).map(n => n.text) },
    property: property ? { code: p.propertyCode || p.id, name: p.name || null, config: p.config || null, price: p.startingPrice || null, facing: p.facing || null, map: p.mapLink || null } : null,
    owner: property ? { name: p.contactName || null, phone: p.contactNumber || null } : null
  };
}

// ── Seller weekly summary (MVP-14) ─────────────────────────────────────

// Each property with at least one visit this week (Mon–Sun, IST): the visits and what was said.
export function sellerSummaries({ leads = [], properties = [], notesByLead = {}, now }) {
  const dow = (new Date(now + IST).getUTCDay() + 6) % 7;     // Monday = 0
  const weekStart = istAt(now, 0) - dow * DAY;
  const byProp = new Map();
  for (const l of leads) {
    const v = visitOf(l);
    if (!v.at || v.at < weekStart || v.at > now || v.status === 'cancelled') continue;
    const p = findPropertyFor(v.property, properties);
    if (!p) continue;
    if (!byProp.has(p.id)) byProp.set(p.id, { property: p, visits: [] });
    const code = codeKey(p.propertyCode);
    const said = (notesByLead[l.id] || []).filter(n => n.createdAt >= weekStart && (!code || codeKey(n.text).includes(code) || v.status === 'done')).map(n => n.text);
    byProp.get(p.id).visits.push({ at: v.at, done: v.status === 'done', feedback: said.slice(0, 2) });
  }
  return [...byProp.values()].map(({ property: p, visits }) => {
    const done = visits.filter(v => v.done).length;
    const lines = visits.flatMap(v => v.feedback).slice(0, 4);
    const text = `Hello ${p.contactName || ''}, this is your weekly update from 3 PIN for ${p.name || p.propertyCode}. `
      + `This week we had ${visits.length} site visit${visits.length === 1 ? '' : 's'}${done !== visits.length ? ` (${done} completed)` : ''}.`
      + (lines.length ? ` What buyers said: ${lines.map(s => '"' + s.replace(/\s+/g, ' ').slice(0, 120) + '"').join('; ')}.` : '')
      + ' We will keep you posted. Thank you!';
    return { code: p.propertyCode || p.id, propertyId: p.id, owner: p.contactName || null, ownerPhone: p.contactNumber || null, visits: visits.length, text };
  });
}
