/* ═══════ AGENT ROLE SETTINGS — what an agent may see ═══════
 *
 * Three kinds of people sign in:
 *   admin  — Thirumal, Swami, Pradeep and admin@: everything, plus assigning properties, approving
 *            requests and these settings (custom claim role = 'admin').
 *   agent  — sees only what this file's settings allow (custom claim role = 'agent').
 *   (none) — everyone else on the team, exactly as before the agent layer existed.
 *
 * The settings live in agentConfigs/{tenant}: written by an admin on team.html, read by the pages
 * and by the server (which builds each agent's property and lead copies from them). Everything is
 * optional in the stored document: a missing setting means the default below, so an empty or
 * missing document gives the defaults of the 14 Nov 2026 brief.
 *
 * `overrides` holds per-agent changes keyed by lower-case email; effectiveConfig(cfg, email) merges
 * the agent's override over the shared settings, setting by setting (a list replaces a list).
 *
 * An ES module: the pages import it, and so do the server (api/_agent.js) and the tests.
 */
// Tabs an agent can be given. `ready: false` = not built for agents yet: shown in the settings as
// "coming", never switched on, so a tick there can never promise something that does not exist.
var TABS = [
  { id: 'myday', label: 'My Day', note: 'Approvals, site visits and follow-ups for today', ready: false },
  { id: 'properties', label: 'Properties', note: 'Their own properties in full; others as a summary', ready: true },
  { id: 'crm', label: 'CRM', note: 'Their own leads only', ready: true },
  { id: 'tasks', label: 'Tasks & Daily task', note: 'Tasks assigned to them', ready: true },
  { id: 'ads', label: 'Meta Ads Leads', note: 'Ad leads (scope below)', ready: true },
  { id: 'campaigns', label: 'WhatsApp Campaigns', note: 'Campaigns (scope below)', ready: true },
  { id: 'messages', label: 'Messages', note: 'Team chat and request threads', ready: false },
  { id: 'calendar', label: 'Team calendar', note: 'Everyone’s free and busy times', ready: false },
  { id: 'shoots', label: 'Shoot & Media', note: 'Not available to agents', ready: false },
  { id: 'finance', label: 'Finance', note: 'Not available to agents', ready: false },
];

// What a property can show, in groups an admin can tick. `fields` are the property document's
// keys (old spellings included); `sub` are its subcollections. Nothing outside these lists ever
// reaches an agent: the server copies field by field from this table.
var PROPERTY_FIELDS = [
  { id: 'title', label: 'Title', fields: ['name'] },
  { id: 'config', label: 'Configuration (BHK)', fields: ['config'] },
  { id: 'budget', label: 'Budget / price', fields: ['startingPrice', 'price', 'priceInCr', 'pricePerSqft'] },
  { id: 'type', label: 'Type and sale / rent', fields: ['type', 'propertyType', 'saleType', 'dealType', 'listingFor'] },
  { id: 'code', label: 'Property code', fields: ['propertyCode', 'propertyId'] },
  { id: 'area', label: 'Area (zone)', fields: ['zone'] },
  { id: 'address', label: 'Address, landmark and map pin', fields: ['location', 'nearby', 'nearbyLandmark', 'connectivity', 'mapLink', 'geo'] },
  { id: 'size', label: 'Size (sq. ft., UDS, land)', fields: ['sqftRange', 'superBuiltupArea', 'carpetArea', 'builtupArea', 'plotSize', 'uds', 'totalLandArea'] },
  { id: 'specs', label: 'Specs (facing, floor, parking…)', fields: ['facing', 'mainDoorFacing', 'floorNo', 'totalFloors', 'bathrooms', 'parking', 'parkingType', 'furnishing', 'cornerUnit', 'vastu', 'powerBackup', 'ebGenerator', 'maintenance', 'totalUnits', 'totalTowers'] },
  { id: 'status', label: 'Status and possession', fields: ['status', 'constructionStage', 'possession', 'possessionDate', 'propertyAge', 'availability', 'soldOut', 'readyToMove', 'newOrResale', 'approval'] },
  { id: 'builder', label: 'Builder', fields: ['builder'] },
  { id: 'highlights', label: 'Highlights and amenities', fields: ['highlights', 'amenities'] },
  { id: 'media', label: 'Photos, brochure and share text', fields: ['photosLink', 'brochureLink', 'detailsText'] },
  { id: 'notes', label: 'Notes and events', fields: ['sheetNotes'], sub: ['notes'] },
  { id: 'internal', label: 'Internal team notes', sub: ['internalNotes'] },
  { id: 'sheet', label: 'Other sheet columns', fields: ['sheetExtras'] },
  { id: 'agents', label: 'Who the agents are', fields: ['assignedAgent', 'secondaryAgents', 'secondaryAgent'] },
  { id: 'contact', label: 'Owner / seller contact', fields: ['contactName', 'contactNumber'] },
];

// What a lead can show to an agent who is not working it (a "matching lead" on their property).
var LEAD_FIELDS = [
  { id: 'requirement', label: 'Requirement (looking for, budget, area)' },
  { id: 'aiSummary', label: 'AI summary' },
  { id: 'name', label: 'Name' },
  { id: 'stage', label: 'Stage' },
  { id: 'source', label: 'Source' },
  { id: 'phone', label: 'Phone number', note: 'Normally only after approval' },
];

var SCOPES = ['own', 'all'];          // Ads / Campaigns: only their properties, or everything
var DETAIL_TIMERS = [null, 1, 3, 7];  // days; null = no limit
var CONTACT_TIMERS = [2, 24, 72];     // hours

function ids(list) { return list.map(function (x) { return x.id; }); }
function readyTabs() { return TABS.filter(function (t) { return t.ready; }).map(function (t) { return t.id; }); }

var DEFAULTS = {
  tabs: ['properties', 'crm', 'tasks', 'ads', 'campaigns'],
  otherPropertyFields: ['title', 'config', 'budget'],
  ownPropertyFields: ids(PROPERTY_FIELDS),
  grantedPropertyFields: ids(PROPERTY_FIELDS).filter(function (id) { return id !== 'contact'; }),
  matchingLeadFields: ['requirement', 'aiSummary'],
  adsScope: 'own',
  campaignsScope: 'own',
  approvals: {
    agentsApprove: true,          // a property's primary and secondary agents can approve requests on it
    detailsDays: null,            // default details timer on the approve sheet (null = no limit)
    shareContact: false,          // "Share owner contact" starts OFF
    contactHours: 24,             // contact timer offered first when it is switched on
  },
};

var KEYS = Object.keys(DEFAULTS);

function clone(v) { return JSON.parse(JSON.stringify(v)); }

// Keep only known ids, in catalogue order, without repeats.
function pick(list, allowed) {
  if (!Array.isArray(list)) return null;
  var want = {};
  list.forEach(function (x) { want[String(x)] = true; });
  return allowed.filter(function (id) { return want[id]; });
}

function cleanApprovals(a, base) {
  var out = clone(base);
  if (!a || typeof a !== 'object') return out;
  if (typeof a.agentsApprove === 'boolean') out.agentsApprove = a.agentsApprove;
  if (a.detailsDays === null || DETAIL_TIMERS.indexOf(a.detailsDays) >= 0) out.detailsDays = a.detailsDays;
  if (typeof a.shareContact === 'boolean') out.shareContact = a.shareContact;
  if (CONTACT_TIMERS.indexOf(a.contactHours) >= 0) out.contactHours = a.contactHours;
  return out;
}

// One layer of settings (the shared one, or an agent's override) laid over `base`.
function layer(base, src) {
  var out = clone(base);
  if (!src || typeof src !== 'object') return out;
  var t = pick(src.tabs, readyTabs()); if (t) out.tabs = t;
  var pf = ids(PROPERTY_FIELDS);
  ['otherPropertyFields', 'ownPropertyFields', 'grantedPropertyFields'].forEach(function (k) {
    var v = pick(src[k], pf); if (v) out[k] = v;
  });
  var lf = pick(src.matchingLeadFields, ids(LEAD_FIELDS)); if (lf) out.matchingLeadFields = lf;
  if (SCOPES.indexOf(src.adsScope) >= 0) out.adsScope = src.adsScope;
  if (SCOPES.indexOf(src.campaignsScope) >= 0) out.campaignsScope = src.campaignsScope;
  out.approvals = cleanApprovals(src.approvals, out.approvals);
  return out;
}

// The settings for everyone (no email) or for one agent (their override applied).
function effectiveConfig(stored, email) {
  var shared = layer(DEFAULTS, stored);
  var key = String(email || '').trim().toLowerCase();
  var ov = stored && stored.overrides && key ? stored.overrides[key] : null;
  return ov ? layer(shared, ov) : shared;
}

// What may be written to agentConfigs/{tenant}: known settings only, cleaned, plus overrides.
function normalizeConfig(input, tenantId) {
  var src = input || {};
  var out = layer(DEFAULTS, src);
  var overrides = {};
  if (src.overrides && typeof src.overrides === 'object') {
    Object.keys(src.overrides).forEach(function (email) {
      var key = String(email).trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(key)) return;
      var ov = src.overrides[email] || {};
      // An override stores only what differs; cleaning it against the shared settings keeps
      // its lists valid without filling in everything else.
      var cleaned = {};
      var full = layer(out, ov);
      KEYS.forEach(function (k) { if (k in ov) cleaned[k] = full[k]; });
      if (Object.keys(cleaned).length) overrides[key] = cleaned;
    });
  }
  out.overrides = overrides;
  if (tenantId) out.tenantId = tenantId;
  return out;
}

// Copy only the allowed field groups of a property. `id` always travels: it is how a request or a
// grant names the property, and it reveals nothing. Owner contact inside sheetExtras is dropped
// unless 'contact' is allowed, whatever 'sheet' says.
function projectProperty(p, allowed) {
  var want = {};
  (allowed || []).forEach(function (id) { want[id] = true; });
  var out = { id: p.id };
  PROPERTY_FIELDS.forEach(function (g) {
    if (!want[g.id] || !g.fields) return;
    g.fields.forEach(function (f) { if (p[f] !== undefined) out[f] = clone(p[f]); });
  });
  if (out.sheetExtras && !want.contact) {
    var se = {};
    Object.keys(out.sheetExtras).forEach(function (k) {
      if (!/owner|contact|phone|mobile|seller/i.test(k)) se[k] = out.sheetExtras[k];
    });
    out.sheetExtras = se;
  }
  return out;
}

// The subcollections the allowed groups open (notes, internalNotes).
function propertySubs(allowed) {
  var want = {};
  (allowed || []).forEach(function (id) { want[id] = true; });
  var subs = [];
  PROPERTY_FIELDS.forEach(function (g) { if (want[g.id] && g.sub) subs = subs.concat(g.sub); });
  return subs;
}

export {
  TABS, PROPERTY_FIELDS, LEAD_FIELDS, SCOPES, DETAIL_TIMERS, CONTACT_TIMERS, DEFAULTS,
  effectiveConfig, normalizeConfig, projectProperty, propertySubs,
};
