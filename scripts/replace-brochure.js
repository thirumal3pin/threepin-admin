// One-off correction tool: for when a brochure PDF was already delivered
// but then needs a fix (typo, wrong figure, etc.) and Cowork regenerated it
// locally under the corrected folder name. Unlike deliver-brochures.js this
// does NOT call the admin.threepin.in brochure API (that endpoint always
// sends a team email as part of finishing an upload) — a correction isn't
// a new listing, so nobody should get re-notified just because a typo got
// fixed. This only touches Drive + the two sheets + the dashboard's own
// Firestore doc, silently.
//
// What it does for <propertyId>:
//   1. Finds the local folder (BROCHURE_FOLDER, matches by name prefix
//      exactly like deliver-brochures.js's findLocalBrochure).
//   2. Trashes (not permanently deletes — recoverable for 30 days) the
//      OLD brochure file in Drive, using the brochureLink currently on the
//      Firestore doc as the source of truth for which file that is.
//   3. Uploads the new PDF into the same Drive photos folder (col C of the
//      Queue sheet row), makes it public, same as the normal pipeline.
//   4. Overwrites Queue sheet col F and Inventory sheet col AR with the
//      new link.
//   5. Merges the corrected property JSON (name/location/highlights/etc,
//      whatever Cowork regenerated) plus the new brochureLink onto the
//      Firestore doc, so the dashboard reflects the fix everywhere, not
//      just in the PDF.
//
// Usage:
//   node scripts/replace-brochure.js VLCA002
//
// Requires the same env as deliver-brochures.js (WEBHOOK_SHARED_SECRET not
// needed here since we never call the brochure API; only Google service
// account access, defaulted from api/).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const BROCHURE_FOLDER = '/Users/swaminathannagarajan/Downloads/Product brochure ';
const QUEUE_SHEET_ID = '1MlepLxnA1-OzHHYd-8S1YKRPCk3Cvz8g1md3eWthsY4';
const QUEUE_TAB = "'Form Responses 1'";
const INVENTORY_SHEET_ID = '1X53_F-S9ezL70Dy2c7a6DG06ljD7bGCb3HauysPMZ8I';
const INVENTORY_BROCHURE_LINK_COL = 'AH'; // Brochure_Link — Inventory sheet was revised down to 36 cols (A-AJ); this used to be AR under the old 46-col layout
const INVENTORY_BROCHURE_LINK_HEADER = 'Brochure_Link';

const SA_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH
  || path.join(import.meta.dirname, '..', 'api', 'pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json');
const IMPERSONATE = process.env.GOOGLE_IMPERSONATE_EMAIL || 'thirumal@threepin.in';

function getFirestoreDb() {
  if (!getApps().length) {
    const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(impersonate) {
  const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  if (impersonate) claims.sub = IMPERSONATE;
  const signInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
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

// Same impersonated-first, bare-service-account-fallback pattern as
// deliver-brochures.js — a Drive folder/file not visible to the
// impersonated Workspace user is often still reachable by the bare
// service account if it was shared directly with that address.
async function withDriveFallback(fn) {
  try {
    return await fn(await getAccessToken(true));
  } catch (e) {
    if (e.status !== 404 && e.status !== 403) throw e;
    return await fn(await getAccessToken(false));
  }
}

function extractFolderId(driveUrl) {
  const m = String(driveUrl || '').match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}
function extractFileId(driveUrl) {
  const m = String(driveUrl || '').match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function findLocalBrochure(propertyId) {
  for (const entry of fs.readdirSync(BROCHURE_FOLDER, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(propertyId)) continue;
    const dir = path.join(BROCHURE_FOLDER, entry.name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    const jsonFile = files.find(f => f.endsWith('_property.json'));
    const pdfFiles = files.filter(f => f.toLowerCase().endsWith('.pdf'));
    if (!jsonFile || !pdfFiles.length) continue;
    // A folder can hold more than one PDF (an old delivered brochure plus a
    // freshly regenerated one) — pick whichever was written most recently.
    const pdfFile = pdfFiles
      .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].f;
    const jsonPath = path.join(dir, jsonFile);
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return { dir, jsonPath, data, pdfPath: path.join(dir, pdfFile) };
  }
  return null;
}

async function trashDriveFile(fileId) {
  await withDriveFallback(async token => {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true })
    });
    if (!res.ok) {
      const err = new Error(`trash failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
  });
}

async function uploadPdf(folderId, filename, pdfBytes) {
  return withDriveFallback(async token => {
    const initRes = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: (() => {
          const form = new FormData();
          form.append('metadata', new Blob([JSON.stringify({ name: filename, parents: [folderId] })], { type: 'application/json' }));
          form.append('file', new Blob([pdfBytes], { type: 'application/pdf' }));
          return form;
        })()
      }
    );
    const data = await initRes.json();
    if (!initRes.ok) {
      const err = new Error(`upload failed: ${JSON.stringify(data)}`);
      err.status = initRes.status;
      throw err;
    }
    await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' })
    });
    return data.id;
  });
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
    { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [[value]] }) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets write failed (${a1}): ${JSON.stringify(data)}`);
}

// Mirrors deliver-brochures.js's own mapping so a correction lands on the
// dashboard the same shape a normal delivery would.
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
    type, builder, startingPrice, status, possession, sqftRange
  };
}

async function main() {
  const propertyId = process.argv[2];
  if (!propertyId) {
    console.error('Usage: node scripts/replace-brochure.js <PROPERTY_ID>');
    process.exit(1);
  }

  const db = getFirestoreDb();
  const docRef = db.collection('properties').doc(propertyId);
  const snap = await docRef.get();
  if (!snap.exists) throw new Error(`No Firestore doc for ${propertyId} — nothing to correct`);
  const existing = snap.data();

  const local = findLocalBrochure(propertyId);
  if (!local) throw new Error(`No local folder+PDF found under "${BROCHURE_FOLDER}" for ${propertyId}`);
  console.log(`Local brochure: ${local.pdfPath}`);

  const oldFileId = extractFileId(existing.brochureLink);
  if (oldFileId) {
    console.log(`Trashing old Drive file ${oldFileId} (brochureLink: ${existing.brochureLink})`);
    try {
      await trashDriveFile(oldFileId);
    } catch (e) {
      if (e.status !== 404) throw e;
      console.log('Old Drive file was already gone (404) — skipping trash, uploading fresh.');
    }
  } else {
    console.log('No existing brochureLink on the Firestore doc — nothing to trash, uploading fresh.');
  }

  const sheetsToken = await getAccessToken(true);
  const queueRows = await sheetsGet(sheetsToken, QUEUE_SHEET_ID, `${QUEUE_TAB}!A:F`);
  const queueIdx = queueRows.findIndex(r => String(r[1] || '').split(' - ')[0].trim() === propertyId);
  if (queueIdx === -1) throw new Error(`No Queue sheet row found for ${propertyId}`);
  const queueRow = queueRows[queueIdx];
  const folderId = extractFolderId(queueRow[2]);
  if (!folderId) throw new Error(`Queue row col C has no Drive folder link for ${propertyId}`);

  const pdfBytes = fs.readFileSync(local.pdfPath);
  const newFileId = await uploadPdf(folderId, `${propertyId}_brochure.pdf`, pdfBytes);
  const newUrl = `https://drive.google.com/file/d/${newFileId}/view`;
  console.log(`Uploaded new brochure: ${newUrl}`);

  await sheetsUpdateCell(sheetsToken, QUEUE_SHEET_ID, `${QUEUE_TAB}!F${queueIdx + 1}`,
    `Yes - ${new Date().toISOString()} - ${newUrl} (corrected)`);
  console.log(`Queue sheet col F row ${queueIdx + 1} updated.`);

  const invRows = await sheetsGet(sheetsToken, INVENTORY_SHEET_ID, 'Inventory!A:A');
  const invIdx = invRows.findIndex(r => String(r[0] || '').trim() === propertyId);
  if (invIdx !== -1) {
    // The Sheets API writes to whatever column you name — it won't complain
    // if the sheet's been reorganized and that column now holds something
    // else. Confirm the header before writing, so a future column shuffle
    // fails loudly here instead of silently clobbering the wrong field.
    const [headerRow] = await sheetsGet(sheetsToken, INVENTORY_SHEET_ID, `Inventory!${INVENTORY_BROCHURE_LINK_COL}1`);
    const actualHeader = headerRow && headerRow[0];
    if (actualHeader !== INVENTORY_BROCHURE_LINK_HEADER) {
      throw new Error(
        `Inventory sheet column ${INVENTORY_BROCHURE_LINK_COL} is now "${actualHeader}", not "${INVENTORY_BROCHURE_LINK_HEADER}" — ` +
        `the sheet has been reorganized again. Update INVENTORY_BROCHURE_LINK_COL in this file before retrying.`
      );
    }
    await sheetsUpdateCell(sheetsToken, INVENTORY_SHEET_ID, `Inventory!${INVENTORY_BROCHURE_LINK_COL}${invIdx + 1}`, newUrl);
    console.log(`Inventory sheet col ${INVENTORY_BROCHURE_LINK_COL} row ${invIdx + 1} updated.`);
  } else {
    console.log('No Inventory sheet row found — skipped.');
  }

  const mapped = mapToDashboardProperty({
    ...local.data,
    brochureLink: newUrl,
    photosLink: queueRow[2] || existing.photosLink || '',
    detailsText: queueRow[3] || existing.detailsText || ''
  });
  mapped.id = propertyId;
  await docRef.set(mapped, { merge: true });
  console.log(`Firestore properties/${propertyId} updated (name, location, brochureLink, etc.).`);

  local.data.brochureLink = newUrl;
  fs.writeFileSync(local.jsonPath, JSON.stringify(local.data, null, 2));

  console.log('\nDone. No email was sent — this was a silent correction.');
}

main().catch(e => {
  console.error('replace-brochure failed:', e);
  process.exit(1);
});
