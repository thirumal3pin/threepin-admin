// Shared by scripts/deliver-brochures.js and scripts/replace-brochure.js.
//
// Both scripts turn a Cowork-generated brochure JSON into a dashboard
// property doc, and both read the Queue sheet. Kept in one place for the
// same reason api/_inventory-shared.js exists: two copies of a mapping
// drift, and two writers disagreeing about which field means what (or which
// column is which) is how this pipeline breaks. Concretely, this file exists
// because replace-brochure.js had its own private copies of both and they
// had already drifted — a hardcoded Queue column letter (col F) that the
// header-shift fix in deliver-brochures.js never propagated to, which would
// have overwritten Status with a Drive link; and a `{...data}` spread that
// reintroduced the eight dead alt-schema field names the dashboard mapping
// deliberately excludes.

export function columnLetter(zeroBasedIndex) {
  return zeroBasedIndex < 26
    ? String.fromCharCode(65 + zeroBasedIndex)
    : String.fromCharCode(64 + Math.floor(zeroBasedIndex / 26)) + String.fromCharCode(65 + (zeroBasedIndex % 26));
}

export const normalizeHeader = h => String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');

// The Queue sheet's Google Form question texts are long, contain
// parenthetical examples, and carry stray double/trailing spaces — matched
// on a normalized, stable PREFIX rather than the full string, except
// Status, matched exactly so it cannot collide with a future
// "Construction Status"-type column.
export const QUEUE_COLUMNS = {
  idTitle:       { match: 'property id',                 mode: 'prefix', required: true },
  photosLink:    { match: 'google drive photo folder',   mode: 'prefix', required: true },
  detailsText:   { match: 'property details',            mode: 'prefix', required: false },
  internalNotes: { match: 'internal team instructions',  mode: 'prefix', required: false },
  status:        { match: 'status',                      mode: 'exact',  required: true },
  emailed:       { match: 'brochure emailed',            mode: 'prefix', required: true }
};

// Resolves every Queue column to a 0-based index by header text. Returns
// null for an optional column that is not there; throws if a required one
// is missing, because guessing at that point is how the header-shift outage
// happened in the first place.
export function resolveQueueColumns(headerRow) {
  const norm = (headerRow || []).map(normalizeHeader);
  const cols = {};
  const missing = [];
  for (const [key, spec] of Object.entries(QUEUE_COLUMNS)) {
    const idx = norm.findIndex(h => spec.mode === 'exact' ? h === spec.match : h.startsWith(spec.match));
    if (idx === -1) {
      cols[key] = null;
      if (spec.required) missing.push(`${key} (expected header ${spec.mode} "${spec.match}")`);
    } else {
      cols[key] = idx;
    }
  }
  if (missing.length) {
    throw new Error(
      `Queue sheet header(s) not found: ${missing.join('; ')}. ` +
      `Headers present: ${norm.filter(Boolean).map(h => JSON.stringify(h)).join(', ')}. ` +
      `Refusing to run rather than act on the wrong columns.`
    );
  }
  return cols;
}

// Finds a column by its exact header text. Returns the column letter, or
// null if not present — callers decide whether that's fatal.
export function findColumnByHeader(headerRow, headerText) {
  const idx = (headerRow || []).findIndex(h => String(h || '').trim() === headerText);
  return idx === -1 ? null : columnLetter(idx);
}

export const DASHBOARD_TENANT_ID = 't_3pinrealty'; // dashboard.html / crm.html tenant, confirmed against live Firestore data

// The dashboard's status filter recognizes exactly these two strings — any
// other value drops a property out of BOTH filter buttons, making it
// invisible on the grid without any visible error. A stage description the
// source uses ("Pre-Launch", "Demolition stage", ...) is kept verbatim in
// constructionStage instead of being discarded.
export const STATUS_READY = 'Ready to Move';
export const STATUS_UNDER_CONSTRUCTION = 'Under Construction';

export function normalizeStatus(data) {
  if (data.readyToMove === 'Yes' || data.newOrResale === 'Resale') {
    return { status: STATUS_READY };
  }
  const raw = String(data.status || '').trim();
  if (raw === STATUS_READY) return { status: STATUS_READY };
  if (!raw || raw === STATUS_UNDER_CONSTRUCTION) return { status: STATUS_UNDER_CONSTRUCTION };
  return { status: STATUS_UNDER_CONSTRUCTION, constructionStage: raw };
}

// Only assigns the key when the value is present — Firestore merge writes an
// empty string or null right over whatever real value was already there, so
// "not stated in this delivery" must mean "leave it alone", not "blank it".
export function setIfPresent(target, key, value) {
  if (value !== undefined && value !== null && value !== '') target[key] = value;
}

export function isBlank(v) {
  return v === undefined || v === null || v === '';
}

// Maps the brochure pipeline's property JSON onto dashboard.html's actual
// schema (see the PMODAL_FIELDS list in dashboard-assets/app.js for what the
// dashboard's own Add/Edit form edits — that list is the ground truth for
// "canonical", not this pipeline's convenience). Built key by key rather
// than spreading `data`: a spread let every dead source field name
// (propertyId, propertyType, price, priceInCr, readyToMove, newOrResale,
// possessionDate, builtupArea) ride along forever, and dashboard-assets/
// app.js's normalizeProperty() re-derives `status` from the leftover
// readyToMove/newOrResale on every manual save — so a user switching a
// property to "Ready to Move" in the UI got silently reverted back to
// "Under Construction" on the next edit.
//
// `existing` is the property's current Firestore doc (or null if this is a
// brand-new property). Two writers touch this collection: deliver-
// brochures.js (Queue sheet + local brochure JSON, every 30 min) and
// scripts/sync-inventory.js (the Inventory sheet, run separately). They
// overlap on every property that's in both places, and on every descriptive
// field — name, type, status, possession, startingPrice, sqftRange, and
// more. Whichever ran last used to win, so a brochure re-delivery could
// silently revert a correction made in the Inventory sheet.
//
// The fix: the Inventory sheet owns descriptive fields once a property
// exists. This only ever WRITES a descriptive field for a brand-new
// property (so a card is never blank while waiting for the next Inventory
// sync) or to fill one still blank on an existing doc. It never overwrites
// a descriptive field that's already set — that's the sync's job.
// Delivery artifacts (brochureLink/photosLink/detailsText) and audit fields
// are this pipeline's own, always written regardless.
export function mapToDashboardProperty(data, existing) {
  const out = {};
  const setDescriptive = existing
    ? (key, value) => { if (isBlank(existing[key])) setIfPresent(out, key, value); }
    : (key, value) => setIfPresent(out, key, value);

  // Identity — system-owned, always written
  const propertyId = data.propertyId || data.propertyCode || (existing && existing.propertyCode) || '';
  out.propertyCode = propertyId;
  out.tenantId = DASHBOARD_TENANT_ID;

  // Basic info
  setDescriptive('name', data.name);
  setDescriptive('builder', data.builder || 'Individual Owner');
  setDescriptive('location', data.location);
  setDescriptive('type', data.propertyType || data.type);
  setDescriptive('config', data.config);

  // Status / sale info
  const { status, constructionStage } = normalizeStatus(data);
  setDescriptive('status', status);
  if (constructionStage !== undefined) setDescriptive('constructionStage', constructionStage);
  setDescriptive('saleType', data.newOrResale);
  setDescriptive('propertyAge', data.ageOfProperty);
  setDescriptive('possession', data.possessionDate || data.possession || 'Contact for details');

  // Pricing
  let startingPrice;
  if (data.startingPrice) startingPrice = data.startingPrice;
  else if (data.price) startingPrice = data.price;
  else if (data.priceInCr) startingPrice = `₹${data.priceInCr} Cr`;
  else startingPrice = 'Price on Request';
  setDescriptive('startingPrice', startingPrice);
  setDescriptive('pricePerSqft', data.pricePerSqft);

  // Specs — sqftRange falls back through built-up -> super built-up -> carpet,
  // same priority order the old code used, just without keeping the raw
  // builtupArea name around afterwards.
  setDescriptive('sqftRange', data.sqftRange || data.builtupArea || data.superBuiltupArea || data.carpetArea);
  setDescriptive('superBuiltupArea', data.superBuiltupArea);
  setDescriptive('carpetArea', data.carpetArea);
  setDescriptive('uds', data.uds);
  setDescriptive('totalUnits', data.totalUnits);
  setDescriptive('totalLandArea', data.totalLandArea);
  setDescriptive('totalTowers', data.totalTowers);
  setDescriptive('totalFloors', data.totalFloors);
  setDescriptive('floorNo', data.floorNo);
  setDescriptive('facing', data.facing);
  setDescriptive('bathrooms', data.bathrooms);
  setDescriptive('parking', data.parking);
  setDescriptive('parkingType', data.parkingType);
  setDescriptive('furnishing', data.furnishing);
  setDescriptive('cornerUnit', data.cornerUnit);
  setDescriptive('vastu', data.vastu);
  setDescriptive('powerBackup', data.ebGenerator);
  setDescriptive('approval', data.approval);

  // Description
  setDescriptive('highlights', data.highlights);
  setDescriptive('amenities', data.amenities);
  setDescriptive('nearbyLandmark', data.nearbyLandmark);
  setDescriptive('connectivity', data.connectivity);
  setDescriptive('contactName', data.contactName);
  setDescriptive('contactNumber', data.contactNumber);
  // data.notes is deliberately NOT mapped to sheetNotes — it is Cowork's own
  // generation-QA log (guessed fields, privacy/blurring pass, photo
  // ordering), not the Inventory sheet's Tier-A "Notes" column. Routed
  // instead into the property's Internal Notes tab — see
  // upsertCoworkGenerationNote() in deliver-brochures.js.

  // Everything else the source JSON carries with no canonical field above —
  // same descriptive-tier ownership, so fill in only when the existing doc
  // has none at all rather than merging key by key (a partial overwrite of
  // a bag-of-extras is more confusing than helpful).
  const extras = {};
  setIfPresent(extras, 'Nearby', data.nearby);
  setIfPresent(extras, 'Main Door Facing', data.mainDoorFacing);
  setIfPresent(extras, 'Plot Size', data.plotSize);
  setIfPresent(extras, 'Maintenance', data.maintenance);
  setIfPresent(extras, 'Negotiable', data.negotiable);
  setIfPresent(extras, 'GST Applicable', data.gstApplicable);
  setIfPresent(extras, 'Registration Extra', data.registrationExtra);
  setIfPresent(extras, 'Loan Eligible', data.loanEligible);
  setIfPresent(extras, 'Site Visit Status', data.siteVisitStatus);
  if (Object.keys(extras).length && (!existing || isBlank(existing.sheetExtras))) out.sheetExtras = extras;

  // Delivery artifacts — this pipeline owns these outright, always written
  // regardless of what else exists on the doc.
  setIfPresent(out, 'brochureLink', data.brochureLink);
  setIfPresent(out, 'photosLink', data.photosLink);
  setIfPresent(out, 'detailsText', data.detailsText);

  // Deliberately NOT written, even though the source JSON may carry them:
  //   - soldOut, interestLevel — dashboard-owned; writing either would
  //     un-sell a property or wipe a lead rating on the next scheduler run.
  //   - availability — Inventory sheet's own column.

  // Audit
  out.createdAt = (existing && existing.createdAt) || Date.now();
  out.updatedAt = Date.now();
  out.source = 'pipeline';

  return out;
}
