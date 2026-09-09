// Releases firestore.rules from the repo as the live Firestore ruleset, through the Admin
// SDK — the same thing `firebase deploy --only firestore:rules` does, without the CLI.
//
// It REFUSES to run unless it can show you the diff first: the rules are the security model
// of a live financial database, and the file in the repo is not necessarily what is live.
// Run scripts/rules-diff.mjs, read the diff, then run this. If the live ruleset has changed
// since you looked (someone edited in the Console), this stops rather than clobbering it.
//
//   node scripts/rules-deploy.mjs <ruleset-name-from-rules-diff>

import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getSecurityRules } from 'firebase-admin/security-rules';

const expectLive = process.argv[2];
if (!expectLive) {
  console.error('Usage: node scripts/rules-deploy.mjs <live ruleset name shown by rules-diff.mjs>');
  process.exit(2);
}

const sa = JSON.parse(readFileSync('api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const rules = getSecurityRules();

const live = await rules.getFirestoreRuleset();
if (live.name !== expectLive) {
  console.error(`Live ruleset is ${live.name}, not ${expectLive} — it changed since you diffed. Re-run rules-diff.mjs and look again.`);
  process.exit(1);
}

const source = readFileSync('firestore.rules', 'utf8');
const released = await rules.releaseFirestoreRulesetFromSource(source);
console.log(`released ${released.name}`);
console.log(`created  ${released.createTime}`);
console.log(`replaced ${live.name}`);
