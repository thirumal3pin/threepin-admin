// Shows the difference between the Firestore rules deployed RIGHT NOW and firestore.rules in
// the repo. Read-only — it changes nothing. Run it before every rules deploy, because the
// rules are deployed by hand and the file in the repo is not necessarily what is live.
//
//   node scripts/rules-diff.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getSecurityRules } from 'firebase-admin/security-rules';

const sa = JSON.parse(readFileSync('api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', 'utf8'));
initializeApp({ credential: cert(sa) });

const live = await getSecurityRules().getFirestoreRuleset();
const liveSrc = live.source.map(f => f.content).join('\n');
const repoSrc = readFileSync('firestore.rules', 'utf8');

const out = process.argv[2];
if (out) writeFileSync(out, liveSrc);

console.log(`live ruleset: ${live.name}`);
console.log(`created:      ${live.createTime}`);
console.log(`live:  ${liveSrc.split('\n').length} lines, ${liveSrc.length} chars`);
console.log(`repo:  ${repoSrc.split('\n').length} lines, ${repoSrc.length} chars`);
console.log(liveSrc.trim() === repoSrc.trim() ? 'IDENTICAL' : 'DIFFERENT');
