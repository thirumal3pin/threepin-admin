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
// The documents a listing is checked for (Settings → Configurations can change the list). A checklist
// only: it is shown on the card and never holds a card back or raises an alert.
export const DEFAULT_DOCS = Object.freeze(['Sale deed / title', 'Parent documents', 'Encumbrance certificate (EC)',
  'Patta', 'Approved plan', 'Property tax receipt', 'Owner ID & PAN']);
export const DOC_STATUSES = [['', '—'], ['have', 'Have it'], ['applied', 'Applied for'], ['missing', 'Missing'], ['na', 'Not needed']];
// What kind of listing it is: shown on the card, it gates nothing (yet).
export const LISTING_TYPES = [['', 'Not set'], ['normal', 'Normal'], ['exclusive', 'Exclusive'], ['collab', 'Collab']];
export const DELIVER_DEFAULTS = [['before', 'The day before the post'], ['same', 'The day of the post'], ['none', 'No default — type it each time']];

export const DEFAULTS = Object.freeze({
  editors: [],              // people for whom the Editor view opens first (anyone can open it)
  voiceBy: '',              // who makes the voice-overs: every V/O asked for is theirs (Daily task, boards)
  voiceByEmail: '',         // …and their email, from the team: how the CRM's Daily task knows them
  deliverDefault: 'before', // an edit planned without a delivery date: the day before the post
  dueSoonDays: 2,           // a deadline this many days away is flagged "soon"
  seriesAutoDetect: true,   // a pasted plan line that says "series" becomes a series
  seriesBoardCard: true,    // a new series gets its card on the board
  targetDays: {},           // stage key → days before a card counts as late (missing = the stage's own)
  tags: [],                 // tags offered to everyone, besides the starting four and those in use
  docItems: DEFAULT_DOCS,   // the documents checklist on every card (an empty list hides it)
  shootCalendar: false      // a booked shoot goes on the team calendar, the shooter invited (sends invitations: off until switched on)
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
    voiceBy: str(c.voiceBy).slice(0, 60),
    voiceByEmail: str(c.voiceByEmail).toLowerCase().slice(0, 120),
    deliverDefault: DELIVER_DEFAULTS.some(([k]) => k === c.deliverDefault) ? c.deliverDefault : DEFAULTS.deliverDefault,
    dueSoonDays: int(c.dueSoonDays, 0, 14, DEFAULTS.dueSoonDays),
    seriesAutoDetect: c.seriesAutoDetect !== false,
    seriesBoardCard: c.seriesBoardCard !== false,
    targetDays,
    tags: names(c.tags).map(t => t.slice(0, 32)),
    // Never saved: the starting list. Saved (even empty): exactly that.
    docItems: Array.isArray(c.docItems) ? names(c.docItems) : DEFAULT_DOCS.slice(),
    shootCalendar: c.shootCalendar === true
  };
}

// A document's key on the card (x.docs[key]): its name, plainly — renaming an item starts it afresh.
export const docKey = name => str(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
export const docStatus = (x, name) => {
  const v = x && x.docs && x.docs[docKey(name)];
  return DOC_STATUSES.some(([k]) => k && k === v) ? v : '';
};
// How far the checklist is: in hand (or not needed) out of the items — for the section's heading.
export function docProgress(x, cfg) {
  const items = normalizeConfig(cfg).docItems;
  const st = items.map(n => docStatus(x, n));
  return { total: items.length, done: st.filter(s => s === 'have' || s === 'na').length,
    missing: st.filter(s => s === 'missing').length, applied: st.filter(s => s === 'applied').length };
}
export const listingTypeOf = x => (LISTING_TYPES.some(([k]) => k && k === (x && x.listingType)) ? x.listingType : '');

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
