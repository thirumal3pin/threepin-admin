// One-off migration: backfills tenantId onto existing `properties` docs so
// dashboard.html's new Firebase Auth + tenant-scoped Firestore rules (see
// firestore.rules) don't lock out data that predates the multi-tenant model.
// All existing properties belong to the original 3 PIN Realty tenant.
//
// Run this BEFORE deploying the updated firestore.rules, otherwise every
// existing property doc fails the new tenantId-scoped rules until backfilled.
//
// Usage:
//   node scripts/migrate-properties-tenant.js
//
// Safe to re-run: idempotent, only touches docs missing/mismatched tenantId.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

const TENANT_ID = 't_3pinrealty';

async function main() {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    new URL('../api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', import.meta.url);
  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
  initializeApp({ credential: cert(serviceAccount) });

  const db = getFirestore();

  const propsSnap = await db.collection('properties').get();
  let updated = 0;
  const batch = db.batch();
  propsSnap.forEach(doc => {
    if (doc.data().tenantId !== TENANT_ID) {
      batch.set(doc.ref, { tenantId: TENANT_ID }, { merge: true });
      updated++;
    }
  });
  if (updated) await batch.commit();
  console.log(`Backfilled tenantId on ${updated} of ${propsSnap.size} existing properties.`);

  await db.collection('propertiesSeededFlags').doc(TENANT_ID).set({ done: true, at: Date.now() }, { merge: true });
  console.log('Marked propertiesSeededFlags/' + TENANT_ID + " so dashboard.html's sample-data seed step won't refire.");

  console.log('\nMigration complete. properties are now scoped to tenantId =', TENANT_ID);
}

main().catch(e => {
  console.error('migrate-properties-tenant failed:', e);
  process.exit(1);
});
