// ═══════════════════════════════════════════════════════════════════════
// PROPERTY & MEDIA TRACK — what each column MEANS, separate from its name.
//
// Pure, dependency-free ES module, mirroring crm-assets/pipeline.js exactly:
// one definition shared by the board, the rail and anything server-side that
// comes later, so nothing can disagree about what "Shoot done" means.
//
// The stages below are the documented 3 PIN new-listing pipeline
// (3PIN_Listing_Pipeline_Workflow.md) split at its real seam:
//
//   • The first four columns are the HUMAN half the automation cannot do —
//     getting the write-up out of the owner, booking a photographer, showing
//     up, uploading what was shot. Nothing in the repo tracked any of this;
//     a listing simply sat in someone's head until a Queue row appeared.
//   • The brochure is the AUTOMATED half that already exists (the Queue sheet
//     row, the brochure PDF, the Inventory row, scripts/deliver-brochures.js
//     emailing it). It is a step inside a listing — its panel, a signal on the
//     tile — not a column; "Media ready" is where everything, brochure
//     included, has come together.
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
  { key: 'shoot_done', name: 'Shoot done', kind: 'open', color: '#6D28D9', step: 3, targetDays: 2,
    rule: 'Photos taken — upload them, then generate the brochure from the listing' },
  // The brochure is a step inside a listing (its panel, a signal on the tile, a board filter),
  // not a column of its own — see RETIRED_KEYS below.
  // Everything the shoot was for is in hand. A listing moves here by itself from Shoot done once
  // the brief, the photos upload, the voice-over, the "Shoot for" cuts and the brochure are all done.
  { key: 'media_ready', name: 'Media ready', kind: 'open', color: '#BE185D', step: 4, targetDays: 3,
    rule: 'Media, photos, voice-over and brochure all done — ready to go live' },
  { key: 'live', name: 'Live — marketing', kind: 'open', color: '#15803D', step: 5, targetDays: 30,
    rule: 'Listed and being shown to buyers' },
  { key: 'closed', name: 'Sold / Rented', kind: 'won', color: '#166534', step: 6,
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
export const LADDER = ['new_listing', 'details', 'shoot_scheduled', 'shoot_done', 'media_ready', 'live', 'closed'];

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
  'media ready': 'media_ready',
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

// Columns renamed since a board was first saved. A board keeps the names it was created with
// (they live in trackPipelines/{tenant}), so an old default name is replaced on load — but only
// while it is still the old default; a name someone chose by hand is left alone.
export const RENAMED = { shoot_done: { from: ['Shot'], to: 'Shoot done' } };
export function renameOldDefaults(stages) {
  let changed = false;
  const out = (stages || []).map(s => {
    const r = RENAMED[stageKeyOf(s)];
    if (r && r.from.includes(String(s.name || '').trim())) { changed = true; return { ...s, name: r.to }; }
    return s;
  });
  return { stages: out, changed };
}

// Columns retired since a board was first saved. A board still carrying them has them removed on
// load, and their listings moved back to Shoot done (the brochure shows on the tile instead).
export const RETIRED_KEYS = ['brochure_queued', 'brochure_ready'];
const RETIRED_NAMES = ['brochure queued', 'queued', 'brochure ready'];
export function retireColumns(stages) {
  const retired = (stages || []).filter(s => RETIRED_KEYS.includes(s.key) || (!s.key && RETIRED_NAMES.includes(norm(s.name))));
  if (!retired.length) return { stages: stages || [], retiredIds: [] };
  const ids = new Set(retired.map(s => s.id));
  const kept = (stages || []).filter(s => !ids.has(s.id))
    .sort((a, b) => (a.order || 0) - (b.order || 0)).map((s, i) => ({ ...s, order: i }));
  return { stages: kept, retiredIds: [...ids] };
}

// Columns added since a board was first saved. A board without one gains it on load, placed right
// after its anchor column, with a fresh id — no listing points at it yet, so nothing else changes.
export const ADDED = [{ key: 'media_ready', after: 'shoot_done' }];
export function addNewColumns(stages) {
  let out = (stages || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  let changed = false;
  for (const { key, after } of ADDED) {
    if (stageForKey(out, key)) continue;
    const anchor = stageForKey(out, after);
    if (!anchor) continue;   // a board too different to place it on is left alone
    const d = DEF_BY_KEY[key];
    const ids = new Set(out.map(s => s.id));
    let id = key; for (let n = 2; ids.has(id); n++) id = `${key}_${n}`;
    const at = out.indexOf(anchor) + 1;
    out = [...out.slice(0, at), { id, key, kind: d.kind, name: d.name, color: d.color }, ...out.slice(at)];
    changed = true;
  }
  return { stages: changed ? out.map((s, i) => ({ ...s, order: i })) : (stages || []), changed };
}

// The default board, used to seed a tenant that has never opened this page.
export function defaultStages() {
  return STAGE_DEFS.map((d, i) => ({ id: d.key, key: d.key, kind: d.kind, name: d.name, color: d.color, order: i }));
}
