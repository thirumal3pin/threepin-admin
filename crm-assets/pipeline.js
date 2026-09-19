// ═══════════════════════════════════════════════════════════════════════
// SALES PIPELINE — what each column MEANS, separate from what it is called.
//
// Pure, dependency-free ES module shared by the CRM page (bridged onto
// window.crmPipeline in crm.html), the dashboard metrics (imported by
// dashboardMetrics.js, which api/dashboard-summary.js also imports) and the
// server-side lead automation (api/_lead-policy.js). One definition, so the
// board, the dashboard, the daily email and the AI can never disagree about
// what "Site visit pending" is.
//
// A stage document in pipelines/{tenantId}.stages carries `key` (one of the
// keys below) and `kind`. Names and colours stay editable in Manage Stages;
// the key is what automation and reports rely on. Stages saved before keys
// existed are recognised by their name (legacyKeyOf).
// ═══════════════════════════════════════════════════════════════════════

// One column per milestone. A lead sits in the FURTHEST milestone it has reached — so placing a
// lead is a string of yes/no questions: sent options? asked to visit? visited? talking price?
// done? Each column's `rule` is that question, shown under the column name on the board.
// `targetDays` is how long a lead should normally sit in an open column before it moves on; the
// board's days-in-stage chip turns amber past it.
export const STAGE_DEFS = [
  { key: 'new',           name: 'New',           kind: 'open', color: '#1D4ED8', step: 0, targetDays: 2,
    rule: 'Nothing specific sent yet' },
  { key: 'options',       name: 'Options sent',  kind: 'open', color: '#0891B2', step: 1, targetDays: 7,
    rule: 'Sent a property, details or location — they are weighing it up' },
  { key: 'send_details',  name: 'Send more details', kind: 'open', color: '#0E7490', step: 2, targetDays: 2,
    rule: 'They asked for something we have not sent yet' },
  { key: 'visit_pending', name: 'Visit planned', kind: 'open', color: '#6D28D9', step: 3, targetDays: 5,
    rule: 'Visit asked for or agreed — not done yet' },
  { key: 'visit_done',    name: 'Visited',       kind: 'open', color: '#7C3AED', step: 4, targetDays: 4,
    rule: 'They have seen the property' },
  { key: 'negotiation',   name: 'Negotiating',   kind: 'open', color: '#B45309', step: 5, targetDays: 14,
    rule: 'Talking price, token or documents' },
  { key: 'won',           name: 'Won',           kind: 'won',  color: '#15803D', step: 6,
    rule: 'Token paid, signed or rented' },
  { key: 'on_hold',       name: 'On hold',       kind: 'hold', color: '#64748B', step: null,
    rule: 'Interested, but paused for now' },
  { key: 'lost',          name: 'Lost',          kind: 'lost', color: '#B91C1C', step: null,
    rule: 'Stopped — the reason is kept' }
];

export const STAGE_KEYS = STAGE_DEFS.map(d => d.key);
const DEF_BY_KEY = Object.fromEntries(STAGE_DEFS.map(d => [d.key, d]));

// The forward path a lead walks. On hold and Lost sit beside it.
export const LADDER = ['new', 'options', 'send_details', 'visit_pending', 'visit_done', 'negotiation', 'won'];

export const LOST_REASONS = {
  not_interested: 'Not interested',
  bought_elsewhere: 'Bought or rented elsewhere',
  budget: 'Budget does not match',
  no_match: 'Nothing suitable available',
  unreachable: 'Unreachable',
  spam: 'Spam or wrong number',
  not_a_fit: 'Not a customer (vendor, agent, job)',
  other: 'Other'
};

export const HOLD_REASONS = {
  postponed: 'Postponed by the lead',
  no_match: 'Waiting for a matching property',
  budget: 'Budget not ready',
  other: 'Other'
};

const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Names the pipeline used before keys existed. PRIMARY names become the keyed
// stage itself; MERGED names are columns that were never really stages
// ("General" is an enquiry type, "Missed Calls" a call outcome, "Spam" a loss
// reason) — their leads are placed by planPipelineMigration.
const PRIMARY_NAMES = {
  new: ['new', 'new enquiry', 'new lead', 'new leads'],
  options: ['options sent', 'options shared', 'details shared', 'details sent'],
  visit_pending: ['visit planned', 'site visit', 'site visit pending', 'visit pending'],
  visit_done: ['visited', 'site visit done', 'visit done'],
  negotiation: ['negotiating', 'negotiation', 'in negotiation'],
  won: ['closed', 'won', 'closed won', 'deal closed'],
  on_hold: ['on hold', 'hold', 'nurture'],
  lost: ['lost', 'not interested', 'closed lost']
};
const MERGED_NAMES = {
  contacted: 'new', general: 'new', 'missed calls': 'new', 'missed call': 'new', spam: 'lost', junk: 'lost'
};

export function legacyKeyOf(name) {
  const n = norm(name);
  for (const [key, names] of Object.entries(PRIMARY_NAMES)) if (names.includes(n)) return key;
  return null;
}

export function stageKeyOf(stage) {
  if (!stage) return null;
  if (stage.key && DEF_BY_KEY[stage.key]) return stage.key;
  return legacyKeyOf(stage.name);
}

// 'open' | 'won' | 'hold' | 'lost' | null (a custom column the pipeline does not know)
export function stageKindOf(stage) {
  const key = stageKeyOf(stage);
  if (key) return DEF_BY_KEY[key].kind;
  if (stage && ['spam', 'junk'].includes(norm(stage.name))) return 'lost';
  return null;
}

export function stageDef(key) { return DEF_BY_KEY[key] || null; }

export function stageForKey(stages, key) {
  const list = Array.isArray(stages) ? stages : [];
  return list.find(s => s.key === key) || list.find(s => stageKeyOf(s) === key) || null;
}

// Automation only runs on a pipeline where every key has its column.
// The columns the rework established. The question this answers is "has this
// board been reworked into keyed milestones?", NOT "does it have every column
// defined today" — those are different questions, and conflating them meant
// that adding a column to STAGE_DEFS silently stopped the automation for every
// tenant until their pipeline document caught up. A newly defined column that
// has not reached a tenant yet is handled where it matters: decideLeadChanges
// suggests instead of moving while the column does not exist.
const CORE_KEYS = ['new', 'options', 'visit_pending', 'visit_done', 'negotiation', 'won', 'on_hold', 'lost'];
export function hasKeyedPipeline(stages) {
  const list = Array.isArray(stages) ? stages : [];
  return CORE_KEYS.every(k => list.some(s => s.key === k));
}

export function ladderIndex(key) { return LADDER.indexOf(key); }

// ── Milestone dates ───────────────────────────────────────────────────────
//
// lead.reached = { new, options, visit_pending, visit_done, negotiation, won } — the first time the
// lead ENTERED each milestone column (ms). Written on every move (the board, bulk actions, the AI)
// and never overwritten, so a lead that goes back and forward keeps its first date. A milestone
// that was skipped has no date; the funnel counts it as passed because a later one was reached.

const DAY_MS = 86400000;

// The fields to write when a lead enters `key` — or null when there is nothing new to record.
export function reachedUpdate(lead, key, at) {
  if (!LADDER.includes(key)) return null;
  const reached = (lead && lead.reached) || {};
  return reached[key] ? null : { [`reached.${key}`]: at };
}

// The furthest ladder step the lead has ever reached (0 = New … 5 = Won), from its milestone dates
// and its current column — so leads from before milestone dates existed still count.
export function furthestStep(lead, stages) {
  const reached = (lead && lead.reached) || {};
  let best = -1;
  LADDER.forEach((k, i) => { if (reached[k]) best = Math.max(best, i); });
  const stage = (Array.isArray(stages) ? stages : []).find(s => s.id === (lead && lead.stageId));
  const current = LADDER.indexOf(stageKeyOf(stage));
  return Math.max(best, current, 0);
}

// Whole days in the current column, and whether that is past the column's target.
export function stageAge(lead, stages, now = Date.now()) {
  const stage = (Array.isArray(stages) ? stages : []).find(s => s.id === (lead && lead.stageId));
  const def = stageDef(stageKeyOf(stage));
  const since = (lead && (lead.stageChangedAt || lead.createdAt)) || null;
  if (!since || !def) return null;
  const days = Math.max(0, Math.floor((now - since) / DAY_MS));
  const target = def.kind === 'open' ? def.targetDays : null;
  return { days, since, target, over: target != null && days > target, farOver: target != null && days > 2 * target };
}

// ── Migration: an old pipeline and its leads → the keyed pipeline ─────────
//
// Pure. Returns what to write; scripts/migrate-pipeline.mjs writes it.
// Stage ids that already mean a key are kept (so history, dashboards and
// every lead in them stay valid); missing keys get new columns; merged
// columns are removed and their leads placed by what the lead record says.
// Columns this file does not recognise are kept, after Lost, untouched.

const SAYS_VISITED = /\b(visited|visit (is )?(done|completed|over)|saw the (site|property|flat|house|villa)|after (the )?visit|site visit done)\b/i;
const SAYS_VISIT = /\b(site visit|visit|coming (to|for)|view the|see the (site|property|flat|house|villa))\b/i;
const SAYS_SHARED = /\b(details? (sent|shared)|sent (the )?details|brochure|location (sent|shared)|sent (the )?location|floor ?plan|shared (the )?(details|location|photos|video))\b/i;

export function planPipelineMigration(stages, leads) {
  const oldStages = Array.isArray(stages) ? stages : [];
  const byKey = {};
  const merged = {};   // old stage id → { key, name }
  const custom = [];
  for (const s of oldStages) {
    const key = s.key && DEF_BY_KEY[s.key] ? s.key : legacyKeyOf(s.name);
    if (key && !byKey[key]) { byKey[key] = s; continue; }
    const into = MERGED_NAMES[norm(s.name)] || (key ? key : null);
    if (into) merged[s.id] = { key: into, name: s.name };
    else custom.push(s);
  }

  const newStages = STAGE_DEFS.map((d, i) => {
    const kept = byKey[d.key];
    return {
      id: kept ? kept.id : (d.key === 'options' ? 'options_shared' : d.key),
      key: d.key,
      kind: d.kind,
      name: d.name,
      color: d.color,
      order: i
    };
  });
  custom.forEach((s, i) => newStages.push({ ...s, order: STAGE_DEFS.length + i }));

  const idForKey = key => newStages.find(s => s.key === key).id;
  const keptIds = new Set(newStages.map(s => s.id));
  const oldById = new Map(oldStages.map(s => [s.id, s]));

  const moves = [];
  for (const l of Array.isArray(leads) ? leads : []) {
    const note = (l.lastNote && l.lastNote.text) || '';
    const from = oldById.get(l.stageId);
    const fromName = from ? from.name : (l.stageId || '(none)');
    let to = null, reason = null, lostReason;

    if (merged[l.stageId]) {
      const m = merged[l.stageId];
      const n = norm(m.name);
      if (n === 'spam' || n === 'junk') { to = 'lost'; lostReason = 'spam'; reason = `"${m.name}" is now a loss reason`; }
      else if (n === 'contacted') {
        if (SAYS_VISITED.test(note)) { to = 'visit_done'; reason = 'the latest note says the visit happened'; }
        else if (SAYS_VISIT.test(note)) { to = 'visit_pending'; reason = 'the latest note mentions a site visit'; }
        else if (l.detailsSent === true || SAYS_SHARED.test(note)) { to = 'options'; reason = 'details were already sent'; }
        else { to = 'new'; reason = '"Contacted" is now shown by the next step, not a column'; }
      } else { to = m.key; reason = `"${m.name}" was not a stage`; }
    } else if (from && stageKeyOf(from) === 'visit_pending' && SAYS_VISITED.test(note)) {
      to = 'visit_done'; reason = 'the latest note says the visit happened';
    } else if (from && stageKeyOf(from) === 'lost' && !l.lostReason) {
      lostReason = 'not_interested';
    } else if (!from || !keptIds.has(l.stageId)) {
      to = 'new'; reason = 'its column no longer exists';
    }

    if (to && idForKey(to) !== l.stageId) {
      moves.push({ id: l.id, fromStageId: l.stageId || null, fromName, toStageId: idForKey(to), toKey: to, reason, ...(lostReason ? { lostReason } : {}) });
    } else if (lostReason) {
      moves.push({ id: l.id, fromStageId: l.stageId, fromName, toStageId: l.stageId, toKey: 'lost', reason: null, lostReason });
    }
  }

  const removed = oldStages.filter(s => !keptIds.has(s.id)).map(s => ({ id: s.id, name: s.name }));
  return { stages: newStages, moves, removed };
}
