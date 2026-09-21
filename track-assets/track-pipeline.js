// ═══════════════════════════════════════════════════════════════════════
// PROPERTY & MEDIA TRACK — what each column MEANS, separate from its name.
//
// Pure, dependency-free ES module, mirroring crm-assets/pipeline.js exactly:
// one definition shared by the board, the rail and anything server-side that
// comes later, so nothing can disagree about what "Shot" means.
//
// The stages below are the documented 3 PIN new-listing pipeline
// (3PIN_Listing_Pipeline_Workflow.md) split at its real seam:
//
//   • The first four columns are the HUMAN half the automation cannot do —
//     getting the write-up out of the owner, booking a photographer, showing
//     up, uploading what was shot. Nothing in the repo tracked any of this;
//     a listing simply sat in someone's head until a Queue row appeared.
//   • "Brochure queued" onward is the AUTOMATED half that already exists:
//     the Queue sheet row (Status blank → Processing → Done), the brochure
//     PDF, the Inventory row, and scripts/deliver-brochures.js emailing it.
//     Those columns mirror state the pipeline already produces rather than
//     asking anyone to re-key it.
//
// A listing sits in the FURTHEST milestone it has reached, exactly like a
// lead on the CRM board.
// ═══════════════════════════════════════════════════════════════════════

export const STAGE_DEFS = [
  { key: 'new_listing', name: 'New listing', kind: 'open', color: '#1D4ED8', step: 0, targetDays: 2,
    rule: 'Owner is on board — nothing collected yet' },
  { key: 'details', name: 'Details & docs', kind: 'open', color: '#0891B2', step: 1, targetDays: 3,
    rule: 'Chasing the write-up, price and papers from the owner' },
  { key: 'shoot_scheduled', name: 'Shoot scheduled', kind: 'open', color: '#7C3AED', step: 2, targetDays: 5,
    rule: 'Date fixed and the owner knows we are coming' },
  { key: 'shoot_done', name: 'Shot', kind: 'open', color: '#6D28D9', step: 3, targetDays: 2,
    rule: 'Photos taken — upload them to the Drive folder' },
  { key: 'brochure_queued', name: 'Brochure queued', kind: 'open', color: '#B45309', step: 4, targetDays: 1,
    rule: 'Queue row submitted — the pipeline builds it from here' },
  { key: 'brochure_ready', name: 'Brochure ready', kind: 'open', color: '#0E7490', step: 5, targetDays: 2,
    rule: 'PDF built and the Inventory row written' },
  { key: 'live', name: 'Live — marketing', kind: 'open', color: '#15803D', step: 6, targetDays: 30,
    rule: 'Listed and being shown to buyers' },
  { key: 'closed', name: 'Sold / Rented', kind: 'won', color: '#166534', step: 7,
    rule: 'Deal done on this property' },
  { key: 'on_hold', name: 'On hold', kind: 'hold', color: '#64748B', step: null,
    rule: 'Owner paused it — the reason is kept' },
  { key: 'dropped', name: 'Dropped', kind: 'lost', color: '#B91C1C', step: null,
    rule: 'Not listing it after all — the reason is kept' }
];

export const STAGE_KEYS = STAGE_DEFS.map(d => d.key);
const DEF_BY_KEY = Object.fromEntries(STAGE_DEFS.map(d => [d.key, d]));

// The forward path a listing walks. On hold and Dropped sit beside it: neither
// is progress.
export const LADDER = ['new_listing', 'details', 'shoot_scheduled', 'shoot_done',
  'brochure_queued', 'brochure_ready', 'live', 'closed'];

// A dropped listing is worth as much as a lost lead — the reason is the whole
// value of the record, so it is asked for rather than assumed.
export const DROP_REASONS = {
  listed_elsewhere: 'Listed with someone else',
  price_unrealistic: 'Owner’s price is unrealistic',
  not_ready: 'Not actually ready to sell',
  papers: 'Title or approval problem',
  unreachable: 'Owner stopped responding',
  duplicate: 'Duplicate of another listing',
  other: 'Other'
};

export const HOLD_REASONS = {
  owner_postponed: 'Owner postponed',
  tenant_occupied: 'Tenant still in the property',
  papers_pending: 'Waiting on papers',
  other: 'Other'
};

const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Stages saved before keys existed, or renamed by hand in Manage Stages, are
// still recognised by their name — same safety net pipeline.js keeps.
const LEGACY_NAMES = {
  'new listing': 'new_listing', 'new': 'new_listing',
  'details': 'details', 'details & docs': 'details', 'details and docs': 'details',
  'shoot scheduled': 'shoot_scheduled', 'scheduled': 'shoot_scheduled',
  'shot': 'shoot_done', 'shoot done': 'shoot_done',
  'brochure queued': 'brochure_queued', 'queued': 'brochure_queued',
  'brochure ready': 'brochure_ready',
  'live': 'live', 'live — marketing': 'live', 'live - marketing': 'live', 'marketing': 'live',
  'sold / rented': 'closed', 'sold': 'closed', 'rented': 'closed', 'closed': 'closed',
  'on hold': 'on_hold',
  'dropped': 'dropped', 'lost': 'dropped'
};

export function legacyKeyOf(name) {
  return LEGACY_NAMES[norm(name)] || null;
}

export function stageKeyOf(stage) {
  if (!stage) return null;
  if (stage.key && DEF_BY_KEY[stage.key]) return stage.key;
  return legacyKeyOf(stage.name);
}

export function stageKindOf(stage) {
  const key = stageKeyOf(stage);
  if (key) return DEF_BY_KEY[key].kind;
  return null;
}

export function stageDef(key) { return DEF_BY_KEY[key] || null; }

export function stageForKey(stages, key) {
  const list = stages || [];
  return list.find(s => s.key === key) || list.find(s => stageKeyOf(s) === key) || null;
}

// The columns that must exist for the board to be workable. Deliberately not
// "every key in STAGE_DEFS" — a column added here later must not break a
// tenant whose board has not gained it yet (the same rule pipeline.js follows).
const CORE_KEYS = ['new_listing', 'details', 'shoot_scheduled', 'shoot_done', 'live', 'closed'];
export function hasKeyedPipeline(stages) {
  return CORE_KEYS.every(k => !!stageForKey(stages, k));
}

export function ladderIndex(key) { return LADDER.indexOf(key); }

// ── Milestones ──
// listing.reached = { new_listing: <ts>, details: <ts>, … } — first entry only,
// so "how long from owner yes to live" is answerable later.
export function reachedUpdate(listing, key, at) {
  if (!key || !LADDER.includes(key)) return null;
  const reached = (listing && listing.reached) || {};
  if (reached[key]) return null;
  return { [`reached.${key}`]: at };
}

export function furthestStep(listing, stages) {
  const key = stageKeyOf((stages || []).find(s => s.id === (listing && listing.stageId)));
  return key ? ladderIndex(key) : -1;
}

// How long this listing has sat where it is, against the stage's own target.
// The board turns the chip amber past target and red at double it — a listing
// parked in "Shoot scheduled" for a fortnight is the thing worth seeing.
export function stageAge(listing, stages, now) {
  const since = (listing && (listing.stageChangedAt || listing.createdAt)) || now;
  const days = Math.floor((now - since) / 86400000);
  const def = stageDef(stageKeyOf((stages || []).find(s => s.id === (listing && listing.stageId))));
  const target = def && def.targetDays ? def.targetDays : null;
  return { days, since, target, over: !!(target && days > target), farOver: !!(target && days > target * 2) };
}

// The default board, used to seed a tenant that has never opened this page.
export function defaultStages() {
  return STAGE_DEFS.map((d, i) => ({ id: d.key, key: d.key, kind: d.kind, name: d.name, color: d.color, order: i }));
}
