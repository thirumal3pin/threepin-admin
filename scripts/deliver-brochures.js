import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

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
const INVENTORY_BROCHURE_LINK_COL = 'AR'; // 44th of 46 columns, see the Cowork task spec
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

// Maps the brochure pipeline's property JSON (propertyId/propertyType/price/
// priceInCr/readyToMove/builtupArea/...) onto dashboard.html's own schema —
// the same mapping dashboard-assets/app.js's normalizeProperty() does
// client-side for pasted JSON, mirrored here since this runs server-side.
function mapToDashboardProperty(data) {
  const type = data.propertyType || data.type || 'Property';
  const builder = data.builder || 'Individual Owner';
  let startingPrice;
  if (data.price) startingPrice = data.price;
  else if (data.priceInCr) startingPrice = `₹${data.priceInCr} Cr`;
  else startingPrice = data.startingPrice || 'Price on Request';
  let status;
  if (data.readyToMove !== undefined || data.newOrResale !== undefined) {
    status = (data.readyToMove === 'Yes' || data.newOrResale === 'Resale') ? 'Ready to Move' : 'Under Construction';
  } else {
    status = data.status || 'Under Construction';
  }
  const possession = data.possessionDate || data.possession || 'Contact for details';
  const sqftRange = data.builtupArea || data.superBuiltupArea || data.carpetArea || data.sqftRange || '';
  return {
    ...data,
    propertyCode: data.propertyCode || data.propertyId || '',
    type, builder, startingPrice, status, possession, sqftRange,
    tenantId: DASHBOARD_TENANT_ID,
    soldOut: false
  };
}

async function upsertDashboardProperty(propertyId, propertyJson, driveFileUrl) {
  const db = getFirestoreDb();
  const mapped = mapToDashboardProperty({ ...propertyJson, brochureLink: driveFileUrl });
  await db.collection('properties').doc(propertyId).set(mapped, { merge: true });
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

function extractFolderId(driveUrl) {
  const m = String(driveUrl || '').match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Finds the local property folder/PDF/JSON for a given Property ID by
// matching the folder name prefix (folders are named "<PropertyID> <title>"
// or "<PropertyID> - <title>", per the Cowork task's own naming convention).
function findLocalBrochure(propertyId) {
  for (const entry of fs.readdirSync(BROCHURE_FOLDER, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(propertyId)) continue;
    const dir = path.join(BROCHURE_FOLDER, entry.name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    const jsonFile = files.find(f => f.endsWith('_property.json'));
    if (!jsonFile) continue;
    const jsonPath = path.join(dir, jsonFile);
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const pdfName = data.brochureLink && !/^https?:\/\//i.test(data.brochureLink)
      ? data.brochureLink
      : files.find(f => f.toLowerCase().endsWith('.pdf'));
    if (!pdfName) continue;
    const pdfPath = path.join(dir, pdfName);
    if (!fs.existsSync(pdfPath)) continue;
    return { dir, jsonPath, data, pdfPath };
  }
  return null;
}

async function deliverRow(sheetsToken, rowIndex, row) {
  const propertyId = String(row[1] || '').split(' - ')[0].trim();
  if (!propertyId) return { propertyId: '(blank)', ok: false, error: 'Could not parse Property ID from column B' };

  const driveFolderId = extractFolderId(row[2]);
  if (!driveFolderId) return { propertyId, ok: false, error: 'No Drive folder link in column C' };

  const local = findLocalBrochure(propertyId);
  if (!local) return { propertyId, ok: false, error: 'No local folder/PDF found on this Mac yet' };

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
  const title = data.name || `${data.config || ''} ${data.propertyType || ''} — ${data.location || ''}`.trim();
  const priceLine = data.priceInCr || data.price ? ` Price: ${data.priceInCr || data.price}.` : '';
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
  await sheetsUpdateCell(sheetsToken, QUEUE_SHEET_ID, `${QUEUE_TAB}!F${rowIndex + 1}`,
    `Yes - ${new Date().toISOString()} - ${finish.drive_file_url}`);

  data.brochureLink = finish.drive_file_url;
  fs.writeFileSync(local.jsonPath, JSON.stringify(data, null, 2));

  const invRows = await sheetsGet(sheetsToken, INVENTORY_SHEET_ID, 'Inventory!A:A');
  const invRowIndex = invRows.findIndex(r => String(r[0] || '').trim() === propertyId);
  if (invRowIndex !== -1) {
    await sheetsUpdateCell(sheetsToken, INVENTORY_SHEET_ID, `Inventory!${INVENTORY_BROCHURE_LINK_COL}${invRowIndex + 1}`, finish.drive_file_url);
  }

  let dashboardAdded = false;
  let dashboardError = null;
  try {
    await upsertDashboardProperty(propertyId, data, finish.drive_file_url);
    dashboardAdded = true;
  } catch (e) {
    dashboardError = String(e.message || e);
  }

  return {
    propertyId, ok: true, drive_file_url: finish.drive_file_url,
    inventoryRowUpdated: invRowIndex !== -1, dashboardAdded, dashboardError
  };
}

async function main() {
  console.log(`--- run started ${new Date().toISOString()} ---`);
  if (!SECRET) {
    console.error('WEBHOOK_SHARED_SECRET is not set in the environment. Aborting.');
    process.exit(1);
  }

  const sheetsToken = await getAccessToken(['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']);
  const rows = await sheetsGet(sheetsToken, QUEUE_SHEET_ID, `${QUEUE_TAB}!A:F`);

  const candidates = [];
  for (let i = 1; i < rows.length; i++) { // skip header row
    const row = rows[i];
    const status = row[4];
    const alreadyEmailed = row[5];
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
      const result = await deliverRow(sheetsToken, rowIndex, row);
      if (result.ok) {
        const dashboardNote = result.dashboardAdded ? 'dashboard: added' : `dashboard: FAILED (${result.dashboardError})`;
        console.log(`[OK] ${result.propertyId} -> ${result.drive_file_url} (inventory row updated: ${result.inventoryRowUpdated}, ${dashboardNote})`);
        await logDelivery(sheetsToken, result.propertyId, 'Delivered',
          `${result.drive_file_url} | ${dashboardNote}`);
      } else {
        console.log(`[SKIP] ${result.propertyId}: ${result.error}`);
        await logDelivery(sheetsToken, result.propertyId, 'Skipped', result.error);
      }
    } catch (e) {
      console.error(`[ERROR] row ${rowIndex + 1}: ${e.message || e}`);
      await logDelivery(sheetsToken, row[1] || `row ${rowIndex + 1}`, 'Error', String(e.message || e));
    }
  }
}

main();
