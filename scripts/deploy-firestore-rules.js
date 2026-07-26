// Deploys the repo's firestore.rules to the live Firebase project via the
// Admin SDK's securityRules API — no `firebase` CLI / interactive login
// needed, just the same service account used by the other scripts.
//
// firestore.rules is NOT deployed automatically on git push (see docs/SOP.md
// / User manual/README.md §14) — this is the only thing that actually makes
// rule changes in the repo take effect on the live project.
//
// Usage:
//   node scripts/deploy-firestore-rules.js
import { initializeApp, cert } from 'firebase-admin/app';
import { getSecurityRules } from 'firebase-admin/security-rules';
import { readFileSync } from 'node:fs';

async function main() {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    new URL('../api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', import.meta.url);
  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
  initializeApp({ credential: cert(serviceAccount) });

  const rulesSource = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const ruleset = await getSecurityRules().releaseFirestoreRulesetFromSource(rulesSource);
  console.log('Deployed firestore.rules to the live project.');
  console.log('  ruleset name:', ruleset.name);
  console.log('  created at:  ', ruleset.createTime);
}

main().catch(e => {
  console.error('deploy-firestore-rules failed:', e);
  process.exit(1);
});
