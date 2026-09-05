import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { rowToProperty, assertHeadersMapped } from '../api/_inventory-shared.js';

// Runs locally (via launchd, not on Vercel) so it has real, unrestricted
// network access — unlike the Cowork task that generates these brochures,
// which runs in a sandboxed environment that can't reach admin.threepin.in
// (a personal Claude account has no Admin Settings panel to allowlist it).
//
// Driven by the Queue sheet, not the local folder — the Queue sheet is the
// single source of truth for "is this property actually ready and not yet
// really emailed":
//   1. Row's Status (col E) must be "Done" — Cowork finished generating it.
//   2. Row's "Brochure Emailed" (col F, written ONLY by this script) must
//      be blank — Cowork's own "Done" can be reached via its Gmail-draft
//      fallback too, which is not a real send, so col E alone is not proof
//      of delivery. Col F is this script's own separate, unambiguous record.
// Properties with no Queue row at all (older ones from before this flow
// existed) are never touched — they simply never appear in this iteration.
//
// For each matching row: find the property's local folder + PDF, upload it
// into the SAME Drive folder referenced by the Queue row's photo-folder
// link (col C) so the brochure sits alongside the photos, send the real
// email via admin.threepin.in, then write col F so it's never re-sent.
//
// Env vars required (put in a local .env file the launchd job sources —
// never commit real values):
//   WEBHOOK_SHARED_SECRET       — same secret set on Vercel
//   GOOGLE_SERVICE_ACCOUNT_JSON_PATH — path to the service account key file
//                                       (defaults to the one already in api/)
//   GOOGLE_IMPERSONATE_EMAIL    — defaults to thirumal@threepin.in

const BROCHURE_FOLDER = '/Users/swaminathannagarajan/Downloads/Product brochure ';
const QUEUE_SHEET_ID = '1MlepLxnA1-OzHHYd-8S1YKRPCk3Cvz8g1md3eWthsY4';
const QUEUE_TAB = "'Form Responses 1'";
const INVENTORY_SHEET_ID = '1X53_F-S9ezL70Dy2c7a6DG06ljD7bGCb3HauysPMZ8I';
const BROCHURE_API = 'https://admin.threepin.in/api/brochure';
const SCHEDULER_NAME = 'deliver-brochures (Mac launchd, every 30 min)';
const ALERT_RECIPIENTS = 'thirumal@threepin.in,swami@threepin.in,pradeep@threepin.in';
// Remembers which failures have already been emailed. Without this the
// scheduler would send the same alert 48 times a day for one stuck property
// — the NAVI0005/VGN000x skip repeated every 30 minutes for over a day.
const ALERT_STATE_PATH = path.join(import.meta.dirname, '..', '.deliver-brochures-alerts.json');
// Re-alert on a still-unresolved failure only this often, so a problem that
// is genuinely being ignored resurfaces without becoming noise.
const ALERT_REPEAT_AFTER_MS = 24 * 60 * 60 * 1000;
// No hardcoded column letters here on purpose — the Inventory sheet has
// already been reorganized once (46 cols -> 36, which silently moved
// Brochure_Link from AR to AH and had this script writing links into empty
// space for weeks with no error). Column position is resolved by header
// text at the start of every run instead — see resolveInventoryColumns().
const INVENTORY_PROPERTY_ID_HEADER = 'Property_ID';
const INVENTORY_BROCHURE_LINK_HEADER = 'Brochure_Link';

// The Queue sheet's columns were hardcoded as A-F here, and that broke the
// same way the Inventory sheet did: a new "Internal TEAM Instructions and
// Notes" column was inserted at E, pushing Status E->F and Brochure Emailed
// F->G. The read then tested the (always blank) notes column for "Done", so
// every run found zero candidates, and the write-back to a literal "F"
// pointed at Status - one fixed read away from overwriting it. Resolve by
// header text instead, exactly like resolveInventoryColumns() below.
//
// These are Google Form question texts, not short database-style headers:
// they are long, contain parenthetical examples, and carry stray double and
// trailing spaces. So match on a normalized, stable PREFIX rather than the
// full string - except Status, which is matched exactly so it cannot collide
// with a future "Construction Status"-type column.
const QUEUE_COLUMNS = {
  idTitle:       { match: 'property id',                 mode: 'prefix', required: true },
  photosLink:    { match: 'google drive photo folder',   mode: 'prefix', required: true },
  detailsText:   { match: 'property details',            mode: 'prefix', required: false },
  internalNotes: { match: 'internal team instructions',  mode: 'prefix', required: false },
  status:        { match: 'status',                      mode: 'exact',  required: true },
  emailed:       { match: 'brochure emailed',            mode: 'prefix', required: true }
};
const normalizeHeader = h => String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
const DASHBOARD_TENANT_ID = 't_3pinrealty'; // dashboard.html / crm.html tenant, confirmed against live Firestore data

const SA_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH
  || path.join(import.meta.dirname, '..', 'api', 'pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json');
const IMPERSONATE = process.env.GOOGLE_IMPERSONATE_EMAIL || 'thirumal@threepin.in';

// Firestore Admin SDK — separate from the Drive/Sheets OAuth token below,
// same service account file, but this one uses it directly as admin
// credentials (bypasses firestore.rules entirely) rather than a delegated
// user token, exactly like api/_bot-shared.js's getDb().
function getFirestoreDb() {
  if (!getApps().length) {
    const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

// The dashboard's status filter recognizes exactly these two strings — any
// other value drops a property out of BOTH filter buttons, making it
// invisible on the grid without any visible error. A stage description the
// source uses ("Pre-Launch", "Demolition stage", ...) is kept verbatim in
// constructionStage instead of being discarded.
const STATUS_READY = 'Ready to Move';
const STATUS_UNDER_CONSTRUCTION = 'Under Construction';

function normalizeStatus(data) {
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
function setIfPresent(target, key, value) {
  if (value !== undefined && value !== null && value !== '') target[key] = value;
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
// "Under Construction" on the next edit. That dashboard-side bug is fixed
// separately; this stops the pipeline from planting the stale fields that
// trigger it.
//
function isBlank(v) {
  return v === undefined || v === null || v === '';
}

// `existing` is the property's current Firestore doc (or null if this is a
// brand-new property).
//
// Two writers touch this collection: this script (Queue sheet + local
// brochure JSON, every 30 min) and scripts/sync-inventory.js (the Inventory
// sheet, run separately). They overlap on every property that's in both
// places, and on every descriptive field — name, type, status, possession,
// startingPrice, sqftRange, and more. Whichever ran last used to win, so a
// brochure re-delivery could silently revert a correction made in the
// Inventory sheet (the same class of bug as the readyToMove/status one
// below, one level up — see docs/mac-scheduler-handoff.md, Problem 3).
//
// The fix: the Inventory sheet owns descriptive fields once a property
// exists. This script only ever WRITES a descriptive field for a brand-new
// property (so a card is never blank while waiting for the next Inventory
// sync) or to fill one still blank on an existing doc. It never overwrites
// a descriptive field that's already set — that's the sync's job, and it
// doesn't matter which of the two ran most recently. Delivery artifacts
// (brochureLink/photosLink/detailsText) and audit fields are this script's
// own, always written regardless.
function mapToDashboardProperty(data, existing) {
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
  setDescriptive('sheetNotes', data.notes);

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

async function upsertDashboardProperty(propertyId, propertyJson, driveFileUrl, photosLink, detailsText) {
  const db = getFirestoreDb();
  const ref = db.collection('properties').doc(propertyId);
  // Read first so createdAt survives a re-delivery (e.g. a brochure
  // correction re-running this script) instead of jumping back to "just
  // added" on the dashboard's Recently Added sort every single time.
  const existingSnap = await ref.get();
  const existing = existingSnap.exists ? existingSnap.data() : null;

  const mapped = mapToDashboardProperty({
    ...propertyJson,
    brochureLink: driveFileUrl,
    // Queue row's own col C (photo folder) / col D (pasted details) —
    // saved onto the property doc so the dashboard's Photos/Share-Details
    // buttons have something to show without a second sheet read.
    photosLink: photosLink || '',
    detailsText: detailsText || ''
  }, existing);
  // The dashboard's own client code (savePModal in app.js) always bakes an
  // explicit `id` field into the document data, matching the doc path —
  // firebase-sync.js's onSnapshot listener reads that field, not Firestore's
  // real doc.id, so leaving it out here made every card silently unclickable
  // (openDetail's lookup against the real `id` never matched).
  mapped.id = propertyId;
  await ref.set(mapped, { merge: true });
}
const SECRET = process.env.WEBHOOK_SHARED_SECRET;

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(scopes) {
  const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const signInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email,
    sub: IMPERSONATE,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signInput);
  signer.end();
  const signature = signer.sign(sa.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${signInput}.${signature}` })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Google token exchange failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function sheetsGet(token, sheetId, range) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets read failed (${range}): ${JSON.stringify(data)}`);
  return data.values || [];
}

async function sheetsUpdateCell(token, sheetId, a1, value) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(a1)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[value]] })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets write failed (${a1}): ${JSON.stringify(data)}`);
}

async function sheetsAppendRow(token, sheetId, tabName, row) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`'${tabName}'!A:A`)}:append?valueInputOption=RAW`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets append failed (${tabName}): ${JSON.stringify(data)}`);
}

// Creates the "Delivery Log" tab in the Inventory spreadsheet the first
// time this script ever runs, so every run afterwards (including "nothing
// to deliver" runs) has a permanent, team-visible record — not just a text
// file that only exists on this one Mac.
const LOG_TAB = 'Delivery Log';
let logSheetEnsured = false;
async function ensureDeliveryLogSheet(token) {
  if (logSheetEnsured) return;
  const meta = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${INVENTORY_SHEET_ID}?fields=sheets.properties.title`, {
    headers: { Authorization: `Bearer ${token}` }
  }).then(r => r.json());
  const exists = (meta.sheets || []).some(s => s.properties.title === LOG_TAB);
  if (!exists) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${INVENTORY_SHEET_ID}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: LOG_TAB } } }] })
    });
    await sheetsAppendRow(token, INVENTORY_SHEET_ID, LOG_TAB, ['Timestamp', 'Property ID', 'Result', 'Detail']);
  }
  logSheetEnsured = true;
}
async function logDelivery(token, propertyId, result, detail) {
  try {
    await ensureDeliveryLogSheet(token);
    await sheetsAppendRow(token, INVENTORY_SHEET_ID, LOG_TAB, [new Date().toISOString(), propertyId || '', result, detail || '']);
  } catch (e) {
    console.error('logDelivery failed (non-fatal):', e.message || e);
  }
}

function columnLetter(zeroBasedIndex) {
  return zeroBasedIndex < 26
    ? String.fromCharCode(65 + zeroBasedIndex)
    : String.fromCharCode(64 + Math.floor(zeroBasedIndex / 26)) + String.fromCharCode(65 + (zeroBasedIndex % 26));
}

// Reads the Inventory header row once per run and resolves both columns by
// their header text rather than a hardcoded letter — a future reorg then
// either keeps working automatically or fails loudly (skip + warn below),
// instead of silently writing into whatever that letter now points at.
let resolvedInventoryColumns = null;
async function resolveInventoryColumns(token) {
  if (resolvedInventoryColumns) return resolvedInventoryColumns;
  const [headerRow] = await sheetsGet(token, INVENTORY_SHEET_ID, 'Inventory!A1:BZ1');
  const findColumn = header => {
    const idx = (headerRow || []).findIndex(h => String(h || '').trim() === header);
    return idx === -1 ? null : columnLetter(idx);
  };
  resolvedInventoryColumns = {
    propertyId: findColumn(INVENTORY_PROPERTY_ID_HEADER),
    brochureLink: findColumn(INVENTORY_BROCHURE_LINK_HEADER),
  };
  return resolvedInventoryColumns;
}

// Resolves every Queue column to a 0-based index by header text. Returns null
// for an optional column that is not there; throws if a required one is
// missing, because guessing at that point is how the last outage happened.
function resolveQueueColumns(headerRow) {
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

// -- Internal notes: Queue sheet -> the property's Internal Notes tab --
// Stored in the properties/{id}/internalNotes SUBcollection, which is why
// neither the Inventory sync nor the dashboard's "Sync from Sheet" button can
// reach it - both write only the property document.
//
// The sheet's cell maps to exactly ONE entry, at the fixed document id below,
// so re-running this can never duplicate it. Ownership follows the same
// never-clobber rule as everything else here: the entry is refreshed from the
// sheet only while it is still the sheet's copy. The moment someone edits it
// in the dashboard, app.js rewrites its `source` to 'manual' and this stops
// touching it - the team's wording wins over the form's.
const QUEUE_NOTE_DOC_ID = 'queue-sheet';

async function upsertInternalNoteFromQueue(propertyId, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { changed: false, reason: 'blank in sheet' };

  const db = getFirestoreDb();
  // Never create a note for a property that does not exist - an internalNotes
  // subcollection under a missing parent would be invisible in the dashboard
  // and unreachable by firestore.rules, which scopes it by the PARENT's
  // tenantId.
  const propRef = db.collection('properties').doc(propertyId);
  if (!(await propRef.get()).exists) return { changed: false, reason: 'no property document' };

  const noteRef = propRef.collection('internalNotes').doc(QUEUE_NOTE_DOC_ID);
  const snap = await noteRef.get();
  const existing = snap.exists ? snap.data() : null;

  if (existing && existing.source !== 'queue-sheet') return { changed: false, reason: 'edited in dashboard - left alone' };
  if (existing && String(existing.text || '') === trimmed) return { changed: false, reason: 'unchanged' };

  await noteRef.set({
    id: QUEUE_NOTE_DOC_ID,
    text: trimmed,
    source: 'queue-sheet',
    author: 'Queue sheet',
    createdAt: (existing && existing.createdAt) || Date.now(),
    updatedAt: Date.now()
  }, { merge: true });
  return { changed: true, reason: existing ? 'updated' : 'created' };
}

// Runs over EVERY Queue row each cycle, not just the ones being delivered: a
// row is delivered once, but its internal instructions get edited long
// afterwards, and those edits still need to reach the tab.
async function syncInternalNotesFromQueue(rows, cols) {
  if (cols.internalNotes === null) {
    console.warn('[WARN] Queue sheet has no "Internal TEAM Instructions" column - skipping internal notes sync');
    return;
  }
  let created = 0, updated = 0, skipped = 0, failed = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const propertyId = String(row[cols.idTitle] || '').split(' - ')[0].trim();
    const text = row[cols.internalNotes];
    if (!propertyId || !String(text || '').trim()) continue;
    try {
      const r = await upsertInternalNoteFromQueue(propertyId, text);
      if (r.changed) { r.reason === 'created' ? created++ : updated++; }
      else skipped++;
    } catch (e) {
      failed++;
      console.error(`[ERROR] internal notes ${propertyId}: ${e.message || e}`);
    }
  }
  console.log(`Internal notes: ${created} created, ${updated} updated, ${skipped} unchanged/protected, ${failed} failed.`);
}

function extractFolderId(driveUrl) {
  const m = String(driveUrl || '').match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Finds the local property folder/PDF/JSON for a given Property ID by
// matching the folder name prefix (folders are named "<PropertyID> <title>"
// or "<PropertyID> - <title>", per the Cowork task's own naming convention).
// The PDF is the deliverable; the JSON only supplies the metadata used for
// the email subject/body and the dashboard card. Requiring BOTH used to mean
// a brochure sat undelivered forever whenever the generation step wrote the
// PDF but not the JSON — which is exactly what happened to NAVI0005 and
// VGN0001-0003 on 2026-09-03 (their run summary claimed all eight properties
// had a *_property.json; only the first four actually did). Nothing errored,
// the scheduler just logged "No local folder/PDF found" every 30 minutes for
// a day and the properties never reached the dashboard at all.
//
// So a missing JSON is now a degraded case, not a blocking one: the folder
// is returned with data:null and deliverRow() rebuilds the metadata from the
// Inventory sheet row instead (see inventoryFallbackData). Only a missing
// PDF is genuinely undeliverable.
function findLocalBrochure(propertyId) {
  for (const entry of fs.readdirSync(BROCHURE_FOLDER, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(propertyId)) continue;
    const dir = path.join(BROCHURE_FOLDER, entry.name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }

    const jsonFile = files.find(f => f.endsWith('_property.json'));
    let data = null;
    let jsonPath = null;
    if (jsonFile) {
      jsonPath = path.join(dir, jsonFile);
      try {
        data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch (e) {
        // A corrupt JSON is the same situation as an absent one — fall back
        // rather than crash the whole run on one bad file.
        console.warn(`[WARN] ${propertyId}: ${path.basename(jsonPath)} is unreadable (${e.message}) — falling back to the Inventory sheet`);
        data = null;
      }
    }

    const pdfName = data && data.brochureLink && !/^https?:\/\//i.test(data.brochureLink)
      ? data.brochureLink
      : files.find(f => f.toLowerCase().endsWith('.pdf'));
    if (!pdfName) continue;
    const pdfPath = path.join(dir, pdfName);
    if (!fs.existsSync(pdfPath)) continue;
    return { dir, jsonPath, data, pdfPath };
  }
  return null;
}

// Rebuilds the delivery metadata from the Inventory sheet when the local
// *_property.json is missing or unreadable. rowToProperty() is the same
// mapping scripts/sync-inventory.js uses, so the fallback and the sync agree
// field for field rather than being a second, drifting interpretation.
// mapToDashboardProperty() already reads both naming schemes (data.type as
// well as data.propertyType, data.possession as well as data.possessionDate),
// so its output drops straight in.
let inventoryRowsCache = null;
async function getInventoryRows(token) {
  if (!inventoryRowsCache) {
    const rows = await sheetsGet(token, INVENTORY_SHEET_ID, 'Inventory!A1:AZ1000');
    const headers = rows[0] || [];
    const problems = assertHeadersMapped(headers);
    if (problems.length) {
      // Loud, because this is the failure mode that hid eleven unmapped
      // columns for weeks: an unmapped header silently becomes sheetExtras.
      console.warn(`[WARN] Inventory sheet header problems:\n  - ${problems.join('\n  - ')}`);
    }
    inventoryRowsCache = { headers, rows: rows.slice(1), problems };
  }
  return inventoryRowsCache;
}

async function inventoryFallbackData(token, propertyId) {
  const { headers, rows } = await getInventoryRows(token);
  const row = rows.find(r => String(r[0] || '').trim() === propertyId);
  if (!row) return null;
  return rowToProperty(headers, row);
}

// ── Failure alerting ──────────────────────────────────────────────────────
// A skipped or failed delivery used to be visible only in a log file on this
// Mac, which is why four properties sat undelivered for a day without anyone
// knowing. Every failure now emails the same people who receive the
// brochures, naming the scheduler, the reason, and what it means in practice.

function readAlertState() {
  try { return JSON.parse(fs.readFileSync(ALERT_STATE_PATH, 'utf8')); } catch { return {}; }
}

function writeAlertState(state) {
  try {
    fs.writeFileSync(ALERT_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn(`[WARN] could not persist alert state (${e.message}) — alerts may repeat`);
  }
}

// key identifies the failure (property id, or '(run-level)'); reason is
// matched too, so a property whose failure CHANGES alerts again immediately
// rather than hiding behind the previous one.
async function sendAlert(key, reason, impact) {
  const state = readAlertState();
  const prev = state[key];
  const now = Date.now();
  if (prev && prev.reason === reason && (now - prev.sentAt) < ALERT_REPEAT_AFTER_MS) {
    console.log(`[ALERT suppressed] ${key}: already reported ${Math.round((now - prev.sentAt) / 60000)} min ago`);
    return;
  }

  try {
    const res = await fetch(BROCHURE_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alert: true,
        scheduler: SCHEDULER_NAME,
        property_id: key === '(run-level)' ? '' : key,
        reason,
        impact,
        to: ALERT_RECIPIENTS
      })
    }).then(r => r.json());

    if (res.success) {
      state[key] = { reason, sentAt: now };
      writeAlertState(state);
      console.log(`[ALERT sent] ${key}: ${reason}`);
    } else {
      // Deliberately not recorded as sent, so the next run tries again.
      console.error(`[ALERT FAILED] ${key}: could not email the alert — ${res.error}`);
    }
  } catch (e) {
    console.error(`[ALERT FAILED] ${key}: ${e.message || e}`);
  }
}

// Clears a property's remembered failure once it succeeds, so a future
// failure of the same kind alerts immediately instead of being suppressed.
function clearAlert(key) {
  const state = readAlertState();
  if (state[key]) {
    delete state[key];
    writeAlertState(state);
  }
}

async function deliverRow(sheetsToken, rowIndex, row, cols) {
  const propertyId = String(row[cols.idTitle] || '').split(' - ')[0].trim();
  if (!propertyId) return { propertyId: '(blank)', ok: false, error: 'Could not parse Property ID from column B' };

  const driveFolderId = extractFolderId(row[cols.photosLink]);
  if (!driveFolderId) return { propertyId, ok: false, error: 'No Drive folder link in column C' };

  const local = findLocalBrochure(propertyId);
  if (!local) return { propertyId, ok: false, error: 'No local folder/PDF found on this Mac yet' };

  // No usable local JSON — rebuild the metadata from the Inventory sheet so
  // the delivery still goes out with a real title, price and dashboard card.
  let metadataSource = 'local JSON';
  if (!local.data) {
    const fallback = await inventoryFallbackData(sheetsToken, propertyId);
    if (!fallback) {
      return {
        propertyId, ok: false,
        error: `No ${propertyId}_property.json in "${path.basename(local.dir)}" and no Inventory sheet row for ${propertyId} — cannot build the email or the dashboard card`
      };
    }
    local.data = fallback;
    metadataSource = 'Inventory sheet (local JSON missing)';
    console.log(`[INFO] ${propertyId}: no local *_property.json — using the Inventory sheet row instead`);
  }

  const init = await fetch(BROCHURE_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ property_id: propertyId, drive_folder_id: driveFolderId, filename: `${propertyId}_brochure.pdf` })
  }).then(r => r.json());
  if (!init.success) return { propertyId, ok: false, error: `init: ${init.error}` };

  const pdfBytes = fs.readFileSync(local.pdfPath);
  const putRes = await fetch(init.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    body: pdfBytes
  }).then(r => r.json());
  if (!putRes.id) return { propertyId, ok: false, error: `drive put: ${JSON.stringify(putRes)}` };

  const data = local.data;
  // `type`/`startingPrice` are the Inventory sheet's names for what the
  // brochure JSON calls `propertyType`/`price` — read both, so a fallback
  // delivery gets a real subject line and price instead of "undefined".
  const title = data.name
    || `${data.config || ''} ${data.propertyType || data.type || ''} — ${data.location || ''}`.trim();
  const priceValue = data.priceInCr || data.price || data.startingPrice;
  const priceLine = priceValue ? ` Price: ${priceValue}.` : '';
  const finish = await fetch(BROCHURE_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      property_id: propertyId,
      property_title: title,
      drive_file_id: putRes.id,
      to: 'thirumal@threepin.in,swami@threepin.in,pradeep@threepin.in',
      subject: `Brochure ready: ${propertyId} — ${title}`,
      body_text: `${title}.${priceLine} Auto-generated and delivered by the 3PIN brochure pipeline.`
    })
  }).then(r => r.json());
  if (!finish.success) return { propertyId, ok: false, error: `finish: ${finish.error}` };

  // The one write that actually prevents a duplicate send on the next run —
  // do this even if the local JSON / Inventory writes below fail somehow.
  await sheetsUpdateCell(sheetsToken, QUEUE_SHEET_ID, `${QUEUE_TAB}!${columnLetter(cols.emailed)}${rowIndex + 1}`,
    `Yes - ${new Date().toISOString()} - ${finish.drive_file_url}`);

  data.brochureLink = finish.drive_file_url;
  // In fallback mode there was no JSON to update, so write the reconstructed
  // metadata to the canonical filename. The folder ends up in the same shape
  // the generation step should have left it in, and the next run reads it
  // locally instead of hitting the sheet again.
  const jsonOutPath = local.jsonPath || path.join(local.dir, `${propertyId}_property.json`);
  try {
    fs.writeFileSync(jsonOutPath, JSON.stringify(data, null, 2));
  } catch (e) {
    // Never fail a delivery that already went out over a local bookkeeping
    // write — the email and Drive upload are the parts that matter.
    console.warn(`[WARN] ${propertyId}: could not write ${path.basename(jsonOutPath)} (${e.message})`);
  }

  let inventoryRowUpdated = false;
  let inventoryWarning = null;
  const invCols = await resolveInventoryColumns(sheetsToken);
  const missingHeaders = [
    !invCols.propertyId && INVENTORY_PROPERTY_ID_HEADER,
    !invCols.brochureLink && INVENTORY_BROCHURE_LINK_HEADER,
  ].filter(Boolean);
  if (missingHeaders.length) {
    // Never fall back to a hardcoded letter here — writing the link into the
    // wrong column (silently, since the Sheets API doesn't complain) is
    // worse than not writing it at all. The Drive upload and email above
    // already succeeded, so the property isn't lost, just not cross-linked
    // in the Inventory sheet until someone fixes the header.
    inventoryWarning = `Inventory sheet header(s) not found: ${missingHeaders.join(', ')} — skipped Inventory update`;
    console.warn(`[WARN] ${propertyId}: ${inventoryWarning}`);
  } else {
    const invRows = await sheetsGet(sheetsToken, INVENTORY_SHEET_ID, `Inventory!${invCols.propertyId}:${invCols.propertyId}`);
    const invRowIndex = invRows.findIndex(r => String(r[0] || '').trim() === propertyId);
    if (invRowIndex !== -1) {
      await sheetsUpdateCell(sheetsToken, INVENTORY_SHEET_ID, `Inventory!${invCols.brochureLink}${invRowIndex + 1}`, finish.drive_file_url);
      inventoryRowUpdated = true;
    }
  }

  let dashboardAdded = false;
  let dashboardError = null;
  try {
    await upsertDashboardProperty(propertyId, data, finish.drive_file_url,
      row[cols.photosLink], cols.detailsText === null ? '' : row[cols.detailsText]);
    dashboardAdded = true;
    // Import this row's internal notes now that the property document
    // exists. syncInternalNotesFromQueue() already ran at the top of this
    // run, but it had to skip a brand-new property because its document was
    // only created on the line above — without this the notes would not
    // appear until the next run, half an hour later. It cannot move to after
    // the delivery loop instead, because that loop is skipped entirely on a
    // no-candidates run, which is most of them. Same upsert, so it stays
    // idempotent and still defers to anything edited in the dashboard.
    if (cols.internalNotes !== null) {
      try {
        await upsertInternalNoteFromQueue(propertyId, row[cols.internalNotes]);
      } catch (e) {
        console.error(`[WARN] ${propertyId}: internal notes import failed: ${e.message || e}`);
      }
    }
  } catch (e) {
    dashboardError = String(e.message || e);
  }

  return {
    propertyId, ok: true, drive_file_url: finish.drive_file_url,
    inventoryRowUpdated, inventoryWarning, dashboardAdded, dashboardError,
    metadataSource
  };
}

async function main() {
  console.log(`--- run started ${new Date().toISOString()} ---`);
  if (!SECRET) {
    console.error('WEBHOOK_SHARED_SECRET is not set in the environment. Aborting.');
    process.exit(1);
  }

  const sheetsToken = await getAccessToken(['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']);
  // A:Z rather than A:F - the sheet has already grown past F once, and a
  // narrow read would silently truncate the very columns we now resolve.
  const rows = await sheetsGet(sheetsToken, QUEUE_SHEET_ID, `${QUEUE_TAB}!A:Z`);

  let cols;
  try {
    cols = resolveQueueColumns(rows[0] || []);
  } catch (e) {
    console.error(`[FATAL] ${e.message}`);
    await logDelivery(sheetsToken, '', 'Error', String(e.message || e));
    await sendAlert('(run-level)', String(e.message || e),
      'The scheduler cannot tell which Queue column is which, so nothing was delivered this run.');
    process.exit(1);
  }
  console.log(`Queue columns resolved: ${Object.entries(cols)
    .map(([k, i]) => `${k}=${i === null ? '(absent)' : columnLetter(i)}`).join(' ')}`);

  // Independent of delivery: internal instructions get edited long after a row
  // is delivered, and those edits still have to reach the dashboard.
  await syncInternalNotesFromQueue(rows, cols);

  const candidates = [];
  for (let i = 1; i < rows.length; i++) { // skip header row
    const row = rows[i];
    const status = row[cols.status];
    const alreadyEmailed = row[cols.emailed];
    if (status === 'Done' && !alreadyEmailed) candidates.push({ rowIndex: i, row });
  }

  if (!candidates.length) {
    console.log('No rows ready for delivery (Status=Done and not yet emailed).');
    await logDelivery(sheetsToken, '', 'No candidates', 'Nothing marked Done and unemailed this run');
    return;
  }
  console.log(`Found ${candidates.length} row(s) ready for delivery.`);

  for (const { rowIndex, row } of candidates) {
    try {
      const result = await deliverRow(sheetsToken, rowIndex, row, cols);
      if (result.ok) {
        const dashboardNote = result.dashboardAdded ? 'dashboard: added' : `dashboard: FAILED (${result.dashboardError})`;
        const inventoryNote = result.inventoryWarning || `inventory row updated: ${result.inventoryRowUpdated}`;
        console.log(`[OK] ${result.propertyId} -> ${result.drive_file_url} (${inventoryNote}, ${dashboardNote}, metadata: ${result.metadataSource})`);
        await logDelivery(sheetsToken, result.propertyId, 'Delivered',
          `${result.drive_file_url} | ${inventoryNote} | ${dashboardNote} | metadata: ${result.metadataSource}`);

        // The brochure went out, but the dashboard card is what the team
        // actually works from — a silent failure here leaves a delivered
        // property invisible on admin.threepin.in.
        if (result.dashboardAdded) {
          clearAlert(result.propertyId);
        } else {
          await sendAlert(result.propertyId,
            `Brochure delivered, but writing the dashboard listing failed: ${result.dashboardError}`,
            `${result.propertyId} was emailed and uploaded to Drive (${result.drive_file_url}), but it will NOT appear on the admin.threepin.in dashboard until this is fixed. The Queue row is already marked delivered, so the scheduler will not retry it on its own.`);
        }
      } else {
        console.log(`[SKIP] ${result.propertyId}: ${result.error}`);
        await logDelivery(sheetsToken, result.propertyId, 'Skipped', result.error);
        await sendAlert(result.propertyId, result.error,
          `${result.propertyId} is marked Done in the Queue sheet but its brochure has NOT been emailed, NOT uploaded to Drive, and it does NOT appear on the admin.threepin.in dashboard. The scheduler will retry every 30 minutes, but it cannot resolve this on its own.`);
      }
    } catch (e) {
      console.error(`[ERROR] row ${rowIndex + 1}: ${e.message || e}`);
      await sendAlert(String(row[cols.idTitle] || `row ${rowIndex + 1}`).split(' - ')[0].trim() || `row ${rowIndex + 1}`,
        `Unexpected error during delivery: ${e.message || e}`,
        `This property's brochure was not delivered. Depending on where the error occurred it may have been partially processed (uploaded to Drive but not emailed, or emailed but not listed on the dashboard) — worth checking before re-running.`);
      await logDelivery(sheetsToken, row[cols.idTitle] || `row ${rowIndex + 1}`, 'Error', String(e.message || e));
    }
  }
}

// A run-level throw (most often Google Sheets answering 503 UNAVAILABLE,
// which happened repeatedly on 2026-09-03) used to surface as nothing but an
// unhandled rejection stack in a local log file. The next run recovers on its
// own, so a single 503 is genuinely transient — but a persistent one would
// have stopped every delivery indefinitely with no signal at all, so it is
// alerted like any other failure. sendAlert's de-duplication keeps an
// intermittent 503 from emailing on every run.
main().catch(async (e) => {
  const message = String(e && e.message || e);
  console.error(`[FATAL] run aborted: ${message}`);
  const transient = /\b(503|UNAVAILABLE|500|502|504|ECONNRESET|ETIMEDOUT)\b/i.test(message);
  await sendAlert('(run-level)',
    `The scheduler run aborted before finishing: ${message}`,
    transient
      ? 'No brochure was delivered on this run. This looks like a transient Google API error, and the next run in 30 minutes will usually recover on its own — but if this alert keeps arriving, deliveries are stalled and need looking at.'
      : 'No brochure was delivered on this run, and every pending property stays undelivered until this is resolved. The scheduler will keep retrying every 30 minutes.');
  process.exit(1);
});
