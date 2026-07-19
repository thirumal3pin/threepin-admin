// One-off migration: brings the original single-tenant 3 PIN Realty business
// into the new multi-tenant data model as the first tenant. Purely additive —
// it copies data into the new tenant-scoped collections/paths and backfills a
// tenantId field on existing leads; it does NOT delete or modify the legacy
// config/whatsappBot, config/knowledge, or config/pipeline docs, so anything
// not yet migrated to be tenant-aware (e.g. api/meta-webhook.js's Lead Ads
// pipeline lookup) keeps working exactly as before.
//
// Safe to re-run: every write here is idempotent (same tenantId, merge where
// it matters).
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

const TENANT_ID = 't_3pinrealty';
const EXISTING_OWNER_EMAILS = ['3pinrentals@gmail.com', 'thirumal@threepin.in'];

async function main() {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    new URL('../api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', import.meta.url);
  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
  initializeApp({ credential: cert(serviceAccount) });

  const auth = getAuth();
  const db = getFirestore();

  // 1. Set the tenantId claim + users/{uid} record for the existing CRM logins.
  for (const email of EXISTING_OWNER_EMAILS) {
    const user = await auth.getUserByEmail(email);
    await auth.setCustomUserClaims(user.uid, { tenantId: TENANT_ID });
    await db.collection('users').doc(user.uid).set({
      tenantId: TENANT_ID,
      email,
      businessName: '3 PIN Realty',
      role: 'owner',
      createdAt: Date.now()
    }, { merge: true });
    console.log('Set tenantId claim for', email, '->', user.uid);
  }

  // 2. Copy config/whatsappBot -> botConfigs/{tenantId} (bot persona + WA connection metadata).
  const botCfgSnap = await db.collection('config').doc('whatsappBot').get();
  if (botCfgSnap.exists) {
    await db.collection('botConfigs').doc(TENANT_ID).set(botCfgSnap.data(), { merge: true });
    console.log('Copied config/whatsappBot -> botConfigs/' + TENANT_ID);
  }

  // 3. Copy config/knowledge -> knowledgeConfigs/{tenantId} (empty if it never existed).
  const knowledgeSnap = await db.collection('config').doc('knowledge').get();
  await db.collection('knowledgeConfigs').doc(TENANT_ID).set(
    knowledgeSnap.exists ? knowledgeSnap.data() : { sources: [], updatedAt: Date.now() },
    { merge: true }
  );
  console.log('Wrote knowledgeConfigs/' + TENANT_ID);

  // 4. Copy config/pipeline -> pipelines/{tenantId} (CRM stage definitions).
  const pipelineSnap = await db.collection('config').doc('pipeline').get();
  if (pipelineSnap.exists) {
    await db.collection('pipelines').doc(TENANT_ID).set(pipelineSnap.data(), { merge: true });
    console.log('Copied config/pipeline -> pipelines/' + TENANT_ID);
  }

  // 5. If a WhatsApp number was already connected, register it in the waNumbers routing table.
  const phoneNumberId = botCfgSnap.exists ? botCfgSnap.data().waPhoneNumberId : null;
  if (phoneNumberId) {
    await db.collection('waNumbers').doc(phoneNumberId).set({
      tenantId: TENANT_ID,
      wabaId: null,
      connectedAt: Date.now()
    }, { merge: true });
    console.log('Registered existing WhatsApp number', phoneNumberId, '-> tenant', TENANT_ID);
  } else {
    console.log('No WhatsApp number currently connected — nothing to register in waNumbers.');
  }

  // 6. Backfill tenantId onto existing leads (additive field, doc IDs unchanged).
  const leadsSnap = await db.collection('leads').get();
  let updated = 0;
  const batch = db.batch();
  leadsSnap.forEach(doc => {
    if (doc.data().tenantId !== TENANT_ID) {
      batch.set(doc.ref, { tenantId: TENANT_ID }, { merge: true });
      updated++;
    }
  });
  if (updated) await batch.commit();
  console.log(`Backfilled tenantId on ${updated} of ${leadsSnap.size} existing leads.`);

  console.log('\nMigration complete. tenantId =', TENANT_ID);
}

main().catch(e => {
  console.error('migrate-existing-tenant failed:', e);
  process.exit(1);
});
