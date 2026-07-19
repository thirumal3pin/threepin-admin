// Admin-run script to provision a new tenant (customer) account.
//
// Usage:
//   node scripts/create-tenant.js --email owner@customer.com --business "Customer Business Name"
//
// Creates the Firebase Auth user (prints a temporary password if you don't
// pass --password), writes users/{uid}, seeds botConfigs/{tenantId} from the
// generic DEFAULT_BOT_CONFIG template, and sets the tenantId custom claim
// that every api/*.js endpoint and Firestore Security Rule relies on for
// tenant isolation.
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DEFAULT_BOT_CONFIG } from '../api/_bot-shared.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email || !args.business) {
    console.error('Usage: node scripts/create-tenant.js --email owner@customer.com --business "Customer Business Name" [--password somepass]');
    process.exit(1);
  }

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    new URL('../api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', import.meta.url);
  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
  initializeApp({ credential: cert(serviceAccount) });

  const auth = getAuth();
  const db = getFirestore();

  const password = args.password || randomBytes(9).toString('base64url');
  const tenantId = 't_' + slugify(args.business) + '_' + Date.now().toString(36);

  const userRecord = await auth.createUser({ email: args.email, password });
  await auth.setCustomUserClaims(userRecord.uid, { tenantId });

  await db.collection('users').doc(userRecord.uid).set({
    tenantId,
    email: args.email,
    businessName: args.business,
    role: 'owner',
    createdAt: Date.now()
  });

  await db.collection('botConfigs').doc(tenantId).set({
    ...DEFAULT_BOT_CONFIG,
    waPhoneNumberId: '',
    waPhoneNumber: '',
    waVerifiedName: '',
    waQualityRating: '',
    waConnectedAt: null
  });
  await db.collection('knowledgeConfigs').doc(tenantId).set({ sources: [], updatedAt: Date.now() });

  console.log('Tenant created:');
  console.log('  tenantId:', tenantId);
  console.log('  uid:     ', userRecord.uid);
  console.log('  email:   ', args.email);
  if (!args.password) console.log('  password:', password, '(share this with the customer securely — it is not stored anywhere)');
  console.log('\nThey can log in at crm.html with this email/password right away.');
}

main().catch(e => {
  console.error('create-tenant failed:', e);
  process.exit(1);
});
