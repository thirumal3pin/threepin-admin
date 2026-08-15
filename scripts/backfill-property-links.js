// One-off backfill: deliver-brochures.js (the 30-min scheduler) only started
// saving photosLink/detailsText/brochureLink onto dashboard property docs
// going forward — this fills in the same three fields for every Queue-sheet
// row that was already delivered before that change shipped, so the
// dashboard's Photos/Brochure/Share-Details buttons work for older listings
// too, not just new ones.
//
// Reads the same Queue sheet as deliver-brochures.js (Form Responses 1,
// cols A:F), and for every row that already has all three — a photos
// folder link (col C), pasted details (col D), and a recorded brochure
// delivery (col F starts with "Yes" and contains a Drive URL) — merges
// { photosLink, detailsText, brochureLink } onto that property's existing
// Firestore doc. Rows missing any of the three are skipped (nothing to
// backfill). Properties with no matching Firestore doc are skipped too —
// this only enriches docs that already exist, it never creates new ones.
//
// Usage:
//   node scripts/backfill-property-links.js
//
// Safe to re-run: idempotent, always just overwrites the same three fields
// with whatever the sheet currently says.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const QUEUE_SHEET_ID = '1MlepLxnA1-OzHHYd-8S1YKRPCk3Cvz8g1md3eWthsY4';
const QUEUE_TAB = "'Form Responses 1'";

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

async function main() {
  console.log(`--- backfill started ${new Date().toISOString()} ---`);
  const db = getFirestoreDb();
  // Must match the exact scopes domain-wide-delegated to this service
  // account in Workspace admin (see deliver-brochures.js) — narrower scopes
  // like spreadsheets.readonly aren't separately authorized and 400 with
  // "unauthorized_client" even though they're a subset.
  const sheetsToken = await getAccessToken(['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']);
  const rows = await sheetsGet(sheetsToken, QUEUE_SHEET_ID, `${QUEUE_TAB}!A:F`);

  let updated = 0, skippedIncomplete = 0, skippedNoDoc = 0, errors = 0;

  for (let i = 1; i < rows.length; i++) { // skip header row
    const row = rows[i];
    const propertyId = String(row[1] || '').split(' - ')[0].trim();
    const photosLink = String(row[2] || '').trim();
    const detailsText = String(row[3] || '').trim();
    const emailedCol = String(row[5] || '').trim();
    const urlMatch = emailedCol.match(/https:\/\/\S+/);
    const brochureLink = /^Yes/i.test(emailedCol) && urlMatch ? urlMatch[0] : '';

    if (!propertyId || !photosLink || !detailsText || !brochureLink) {
      skippedIncomplete++;
      continue;
    }

    try {
      const ref = db.collection('properties').doc(propertyId);
      const snap = await ref.get();
      if (!snap.exists) {
        console.log(`[SKIP] ${propertyId}: no matching Firestore doc`);
        skippedNoDoc++;
        continue;
      }
      await ref.set({ photosLink, detailsText, brochureLink }, { merge: true });
      console.log(`[OK] ${propertyId}: photosLink/detailsText/brochureLink backfilled`);
      updated++;
    } catch (e) {
      console.error(`[ERROR] ${propertyId}: ${e.message || e}`);
      errors++;
    }
  }

  console.log(`\nDone. Updated ${updated}, skipped (incomplete row) ${skippedIncomplete}, skipped (no Firestore doc) ${skippedNoDoc}, errors ${errors}.`);
}

main().catch(e => {
  console.error('backfill-property-links failed:', e);
  process.exit(1);
});
