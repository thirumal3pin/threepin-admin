// ═══════════════════════════════════════════════════════════════════════
// SHOOT & MEDIA — the admin's configuration, in one place.
//
// Pure, dependency-free ES module. Kept in settings/{tenant}.trackConfig (the same settings document
// the CRM keeps the team in, so no new collection and no rules change), edited on Settings →
// Configurations, read by the board, the Editor view and the Posting tab. Every field has a default,
// so a tenant that never opened Settings behaves exactly as before.
// ═══════════════════════════════════════════════════════════════════════

// The stages whose "late" threshold the admin can set, with the days they come with.
export const TARGET_STAGES = [
  ['new_listing', 'New listing', 2], ['details', 'Details & docs', 3], ['shoot_scheduled', 'Shoot scheduled', 5],
  ['shoot_done', 'Shoot done', 2], ['media_ready', 'Media ready', 3], ['live', 'Live — marketing', 30]
];
export const DELIVER_DEFAULTS = [['before', 'The day before the post'], ['same', 'The day of the post'], ['none', 'No default — type it each time']];

export const DEFAULTS = Object.freeze({
  editors: [],              // people for whom the Editor view opens first (anyone can open it)
  deliverDefault: 'before', // an edit planned without a delivery date: the day before the post
  dueSoonDays: 2,           // a deadline this many days away is flagged "soon"
  seriesAutoDetect: true,   // a pasted plan line that says "series" becomes a series
  seriesBoardCard: true,    // a new series gets its card on the board
  targetDays: {},           // stage key → days before a card counts as late (missing = the stage's own)
  tags: []                  // tags offered to everyone, besides the starting four and those in use
});

const str = v => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());
const names = list => {
  const out = [], seen = new Set();
  for (const n of Array.isArray(list) ? list : []) { const v = str(n).slice(0, 60); if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); } }
  return out;
};
const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };

export function normalizeConfig(c) {
  c = c && typeof c === 'object' ? c : {};
  const targetDays = {};
  for (const [k] of TARGET_STAGES) { const n = int(c.targetDays && c.targetDays[k], 1, 365, 0); if (n) targetDays[k] = n; }
  return {
    editors: names(c.editors),
    deliverDefault: DELIVER_DEFAULTS.some(([k]) => k === c.deliverDefault) ? c.deliverDefault : DEFAULTS.deliverDefault,
    dueSoonDays: int(c.dueSoonDays, 0, 14, DEFAULTS.dueSoonDays),
    seriesAutoDetect: c.seriesAutoDetect !== false,
    seriesBoardCard: c.seriesBoardCard !== false,
    targetDays,
    tags: names(c.tags).map(t => t.slice(0, 32))
  };
}

const same = (a, b) => str(a).toLowerCase() === str(b).toLowerCase() && !!str(a);
export const isEditor = (cfg, name) => normalizeConfig(cfg).editors.some(e => same(e, name));

// The delivery date to offer for an edit, from the post's time.
export function defaultDelivery(cfg, postAt) {
  if (!postAt) return 0;
  const d = new Date(postAt); d.setHours(0, 0, 0, 0);
  const mode = normalizeConfig(cfg).deliverDefault;
  if (mode === 'none') return 0;
  if (mode === 'before') d.setDate(d.getDate() - 1);
  return d.getTime();
}
