/* ═══════ WHAT AGENTS SEE — the agent role settings ═══════
 *
 * Three kinds of people sign in:
 *   admin  — Thirumal, Swami, Pradeep and admin@: everything, plus deciding who sees what
 *            (custom claim role = 'admin').
 *   agent  — sees only what these settings allow (custom claim role = 'agent').
 *   (none) — "full access (staff)": everyone else on the team, exactly as before the agent layer.
 *
 * The settings live in agentConfigs/{tenant}: written by an admin on team.html ("What agents see"),
 * read by the server, which builds each agent's property and lead copies from them and hands each
 * agent only their own effective settings. Everything is optional in the stored document: a missing
 * setting means the default below. Defaults: the owner's brief of 14 Nov 2026 and his answers the
 * same day (co-agents see what the primary sees; approvals by the primary agent or an admin; a
 * richer summary of other agents' properties with no street; agents may add leads, edit notes and
 * availability on their own properties, submit properties for approval, export what they can see
 * and send campaigns to their own leads).
 *
 * `overrides` holds per-agent changes keyed by lower-case email; effectiveConfig(cfg, email) lays
 * the agent's override over the common settings, setting by setting (a list replaces a list).
 *
 * `live` on each section says whether it already changes anything. Since phases 2–6 (Nov 2026)
 * every section does: the menu, the property and lead copies, the actions and the approvals.
 *
 * An ES module: the pages import it, and so do the server (api/_agent.js) and the tests.
 */

// Menu tabs. status: 'ready' = can be given to agents; 'later' = not built for agents yet;
// 'never' = not for agents (shown only so nobody wonders where it went).
const TABS = [
  { id: 'properties', label: 'Properties', note: 'Their properties in full; others as a summary', status: 'ready' },
  { id: 'crm', label: 'CRM', note: 'Their own leads only', status: 'ready' },
  { id: 'tasks', label: 'Tasks & Daily task', note: 'Tasks assigned to them', status: 'ready' },
  { id: 'ads', label: 'Meta Ads Leads', note: 'Ad leads (which ones: below)', status: 'ready' },
  { id: 'campaigns', label: 'WhatsApp Campaigns', note: 'Campaigns (which ones: below)', status: 'ready' },
  { id: 'myday', label: 'My Day', note: 'Approvals, site visits and follow-ups for today — their home page', status: 'ready' },
  { id: 'messages', label: 'Messages', note: 'Team chat, and a thread for every request', status: 'ready' },
  { id: 'calendar', label: 'Team calendar', status: 'later' },
  { id: 'shoots', label: 'Shoot & Media', status: 'never' },
  { id: 'finance', label: 'Finance', status: 'never' },
];

// What a property can show, in groups an admin can tick. `fields` are the property document's keys
// (old spellings included); `sub` are its subcollections. Nothing outside these lists ever reaches
// an agent: the server copies field by field from this table. `risk` marks what gives away the
// owner or the exact place, so the settings page can warn before it is ticked.
const PROPERTY_FIELDS = [
  { id: 'title', label: 'Title', fields: ['name'] },
  { id: 'config', label: 'BHK / configuration', fields: ['config'] },
  { id: 'budget', label: 'Budget / price', fields: ['startingPrice', 'price', 'priceInCr', 'pricePerSqft'] },
  { id: 'type', label: 'Type, and sale or rent', fields: ['type', 'propertyType', 'saleType', 'dealType', 'listingFor'] },
  { id: 'locality', label: 'Locality (e.g. Anna Nagar)', fields: ['zone'] },
  { id: 'availability', label: 'Availability (available, booked, sold)', fields: ['availability', 'soldOut'] },
  { id: 'primaryAgent', label: 'Primary agent’s name', fields: ['assignedAgent'] },
  { id: 'code', label: 'Property code', fields: ['propertyCode', 'propertyId'] },
  { id: 'address', label: 'Street address, landmark and map pin', fields: ['location', 'nearby', 'nearbyLandmark', 'connectivity', 'mapLink', 'geo'], risk: 'shows exactly where it is' },
  { id: 'size', label: 'Size (sq. ft., UDS, land)', fields: ['sqftRange', 'superBuiltupArea', 'carpetArea', 'builtupArea', 'plotSize', 'uds', 'totalLandArea'] },
  { id: 'specs', label: 'Specs (facing, floor, parking…)', fields: ['facing', 'mainDoorFacing', 'floorNo', 'totalFloors', 'bathrooms', 'parking', 'parkingType', 'furnishing', 'cornerUnit', 'vastu', 'powerBackup', 'ebGenerator', 'maintenance', 'totalUnits', 'totalTowers'] },
  { id: 'possession', label: 'Construction stage and possession', fields: ['status', 'constructionStage', 'possession', 'possessionDate', 'propertyAge', 'readyToMove', 'newOrResale', 'approval'] },
  { id: 'builder', label: 'Builder', fields: ['builder'] },
  { id: 'highlights', label: 'Highlights and amenities', fields: ['highlights', 'amenities'] },
  { id: 'media', label: 'Photos, brochure and WhatsApp share message', fields: ['photosLink', 'brochureLink', 'detailsText'] },
  { id: 'notes', label: 'Property notes and history', fields: ['sheetNotes'], sub: ['notes'], risk: 'may mention the owner or the address (phone numbers are hidden)' },
  { id: 'internal', label: 'Office-only notes', sub: ['internalNotes'], risk: 'may hold the owner’s lowest price' },
  { id: 'sheet', label: 'Extra columns from the property sheet', fields: ['sheetExtras'], risk: 'may contain anything' },
  { id: 'coAgents', label: 'Co-agents’ names', fields: ['secondaryAgents', 'secondaryAgent'] },
  { id: 'contact', label: 'Owner’s name and phone', fields: ['contactName', 'contactNumber'], risk: 'owner’s phone number' },
];

// Ids renamed since the first version, so a saved setting keeps its meaning.
const FIELD_ALIASES = { area: ['locality'], status: ['availability', 'possession'], agents: ['primaryAgent', 'coAgents'] };

// What a lead can show to an agent who is not working it (a "matching lead" on their property).
const LEAD_FIELDS = [
  { id: 'requirement', label: 'What they are looking for (type, budget, area)' },
  { id: 'aiSummary', label: 'AI summary (names and numbers removed)' },
  { id: 'name', label: 'Name' },
  { id: 'stage', label: 'Lead stage (new, visit done…)' },
  { id: 'source', label: 'Where the lead came from' },
  { id: 'phone', label: 'Phone number', risk: 'agents get buyers’ numbers without asking' },
];

// What an agent may DO. Each is on or off; the server and rules enforce them as their screens ship.
const ACTIONS = [
  { id: 'addLeads', label: 'Add leads', note: 'If the number is already with the team, they’re told so, not whose lead it is' },
  { id: 'editOwnProperties', label: 'Edit notes and availability on their properties', note: 'Price and owner details stay with admins' },
  { id: 'addProperties', label: 'Add properties they source', note: 'An admin approves before it appears' },
  { id: 'exportOwn', label: 'Download or copy their lists', note: 'Only what they can see' },
  { id: 'sendCampaigns', label: 'Send WhatsApp campaigns to their leads', note: 'From the company number' },
];

const SCOPES = ['own', 'all'];                 // Ads / Campaigns: only their properties, or every one
const APPROVERS = [
  { id: 'primary', label: 'The property’s primary agent, or an admin' },
  { id: 'all', label: 'Any agent on the property (primary or co-agent), or an admin' },
  { id: 'admins', label: 'Admins only' },
];
const DETAIL_TIMERS = [null, 1, 3, 7];         // days; null = no limit
const CONTACT_TIMERS = [2, 24, 72];            // hours

// Which sections change anything yet (see the note at the top).
const LIVE = { tabs: true, fields: true, actions: true, scopes: true, approvals: true };

function ids(list) { return list.map(x => x.id); }
const readyTabs = () => TABS.filter(t => t.status === 'ready').map(t => t.id);

const DEFAULTS = {
  tabs: ['myday', 'properties', 'crm', 'tasks', 'ads', 'campaigns', 'messages'],
  otherPropertyFields: ['title', 'config', 'budget', 'type', 'locality', 'availability', 'primaryAgent'],
  ownPropertyFields: ids(PROPERTY_FIELDS),          // primary and co-agents alike
  // Shared through an approved request: everything except the owner's number (the approver decides
  // that), the office-only notes and the sheet's extra columns — those can hold the owner's lowest
  // price, which a collaborating agent's side of the table must not see by default.
  grantedPropertyFields: ids(PROPERTY_FIELDS).filter(id => !['contact', 'internal', 'sheet'].includes(id)),
  matchingLeadFields: ['requirement', 'aiSummary'],
  adsScope: 'own',
  campaignsScope: 'own',
  actions: { addLeads: true, editOwnProperties: true, addProperties: true, exportOwn: true, sendCampaigns: true },
  approvals: {
    approvers: 'primary',       // who may approve a request on a property
    detailsDays: null,          // default details timer on the approve sheet (null = no limit)
    shareContact: false,        // "Share owner’s number" starts OFF
    contactHours: 24,           // the owner’s-number timer offered first when it is switched on
  },
};

const KEYS = Object.keys(DEFAULTS);

const clone = v => JSON.parse(JSON.stringify(v));

// Keep only known ids (old ids translated), in catalogue order, without repeats.
function pick(list, allowed, aliases) {
  if (!Array.isArray(list)) return null;
  const want = {};
  list.forEach(x => {
    const k = String(x);
    (aliases && aliases[k] ? aliases[k] : [k]).forEach(a => { want[a] = true; });
  });
  return allowed.filter(id => want[id]);
}

function cleanApprovals(a, base) {
  const out = clone(base);
  if (!a || typeof a !== 'object') return out;
  if (APPROVERS.some(x => x.id === a.approvers)) out.approvers = a.approvers;
  else if (typeof a.agentsApprove === 'boolean') out.approvers = a.agentsApprove ? 'all' : 'admins';   // first version
  if (a.detailsDays === null || DETAIL_TIMERS.indexOf(a.detailsDays) >= 0) out.detailsDays = a.detailsDays;
  if (typeof a.shareContact === 'boolean') out.shareContact = a.shareContact;
  if (CONTACT_TIMERS.indexOf(a.contactHours) >= 0) out.contactHours = a.contactHours;
  return out;
}

function cleanActions(a, base) {
  const out = clone(base);
  if (!a || typeof a !== 'object') return out;
  ACTIONS.forEach(x => { if (typeof a[x.id] === 'boolean') out[x.id] = a[x.id]; });
  return out;
}

// One layer of settings (the common one, or an agent's override) laid over `base`.
function layer(base, src) {
  const out = clone(base);
  if (!src || typeof src !== 'object') return out;
  const t = pick(src.tabs, readyTabs()); if (t) out.tabs = t;
  const pf = ids(PROPERTY_FIELDS);
  ['otherPropertyFields', 'ownPropertyFields', 'grantedPropertyFields'].forEach(k => {
    const v = pick(src[k], pf, FIELD_ALIASES); if (v) out[k] = v;
  });
  out.grantedPropertyFields = out.grantedPropertyFields.filter(id => id !== 'contact');   // the approver decides that
  const lf = pick(src.matchingLeadFields, ids(LEAD_FIELDS)); if (lf) out.matchingLeadFields = lf;
  if (SCOPES.indexOf(src.adsScope) >= 0) out.adsScope = src.adsScope;
  if (SCOPES.indexOf(src.campaignsScope) >= 0) out.campaignsScope = src.campaignsScope;
  out.actions = cleanActions(src.actions, out.actions);
  out.approvals = cleanApprovals(src.approvals, out.approvals);
  return out;
}

// The settings for everyone (no email) or for one agent (their override applied).
function effectiveConfig(stored, email) {
  const shared = layer(DEFAULTS, stored);
  const key = String(email || '').trim().toLowerCase();
  const ov = stored && stored.overrides && key ? stored.overrides[key] : null;
  return ov ? layer(shared, ov) : shared;
}

// What may be written to agentConfigs/{tenant}: known settings only, cleaned, plus overrides.
function normalizeConfig(input, tenantId) {
  const src = input || {};
  const out = layer(DEFAULTS, src);
  const overrides = {};
  if (src.overrides && typeof src.overrides === 'object') {
    Object.keys(src.overrides).forEach(email => {
      const key = String(email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(key)) return;
      const ov = src.overrides[email] || {};
      // An override stores only what differs; cleaning it against the common settings keeps its
      // lists valid without filling in everything else.
      const cleaned = {};
      const full = layer(out, ov);
      KEYS.forEach(k => { if (k in ov) cleaned[k] = full[k]; });
      if (Object.keys(cleaned).length) overrides[key] = cleaned;
    });
  }
  out.overrides = overrides;
  if (tenantId) out.tenantId = tenantId;
  return out;
}

// Phone numbers written into free text (a note, a share message, a title): any ten digits with spaces,
// dots or dashes between them, with or without +91 / 0 — mobiles and landlines like 044-2345 6789.
// A phone number however it is written: ten digits with up to six spaces, dots, dashes (- – —),
// slashes, brackets or underscores between them, with or without +91 / 0 — "98400 12345",
// "98400 - 12345", "98400–12345", "98400_12345", "044-2345 6789". Never commas (lists, prices), and not
// a date and time ("15-11-2026 10:30": a run that runs into a time is left alone).
const PHONE_RE = /(?<!\w)(?:\+?91[\s.\-\/()_\p{Pd}]{0,6}|0)?(?:\d[\s.\-\/()_\p{Pd}]{0,6}){9}\d(?!\w|:\d)/gu;
function maskPhones(v) {
  if (typeof v === 'string') return v.replace(PHONE_RE, '••••• •••••');
  if (Array.isArray(v)) return v.map(maskPhones);
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).forEach(k => { o[k] = maskPhones(v[k]); });
    return o;
  }
  return v;
}

const CONTACT_COLUMN = /owner|contact|phone|mobile|\bmob|\bph\b|cell|seller|landlord|whats\s*app|number|\bno\b/i;

// Copy only the allowed field groups of a property. `id` always travels: it is how a request or a
// grant names the property, and it reveals nothing. Unless the owner's contact is allowed, sheet
// columns that look like contacts are dropped and any phone number typed into text is masked.
function projectProperty(p, allowed) {
  const want = {};
  (allowed || []).forEach(id => { want[id] = true; });
  let out = { id: p.id };
  PROPERTY_FIELDS.forEach(g => {
    if (!want[g.id] || !g.fields) return;
    g.fields.forEach(f => { if (p[f] !== undefined) out[f] = clone(p[f]); });
  });
  if (!want.contact) {
    if (out.sheetExtras) {
      const se = {};
      Object.keys(out.sheetExtras).forEach(k => { if (!CONTACT_COLUMN.test(k)) se[k] = out.sheetExtras[k]; });
      out.sheetExtras = se;
    }
    const id = out.id;
    out = maskPhones(out);
    out.id = id;
  }
  return out;
}

// The subcollections the allowed groups open (notes, internalNotes).
function propertySubs(allowed) {
  const want = {};
  (allowed || []).forEach(id => { want[id] = true; });
  let subs = [];
  PROPERTY_FIELDS.forEach(g => { if (want[g.id] && g.sub) subs = subs.concat(g.sub); });
  return subs;
}

export {
  TABS, PROPERTY_FIELDS, LEAD_FIELDS, ACTIONS, SCOPES, APPROVERS, DETAIL_TIMERS, CONTACT_TIMERS, LIVE, DEFAULTS,
  effectiveConfig, normalizeConfig, projectProperty, propertySubs, maskPhones,
};
