// Publishes firestore.rules to the live project through the Firebase Rules API — no Firebase CLI
// or `firebase login` needed, only this computer's service-account key (scripts/_key.js).
//
//   node scripts/deploy-rules.mjs                  dry run: is the live ruleset the same as the file?
//   node scripts/deploy-rules.mjs --apply          publish firestore.rules
//   node scripts/deploy-rules.mjs --rollback <projects/pin-realty/rulesets/…>   put an earlier one back
//
// Google compiles the rules before accepting them, so a syntax error is refused, never published.
// Run the emulator tests first (cd tests/rules && npm test). Every publish prints the ruleset it
// replaced, which is what --rollback takes.
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { serviceAccount } from './_key.js';

const PROJECT = 'pin-realty';
const RELEASE = `projects/${PROJECT}/releases/cloud.firestore`;
const API = 'https://firebaserules.googleapis.com/v1/';

const key = serviceAccount();
const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/firebase'] });
const call = async (method, path, data) => (await jwt.request({ method, url: API + path, data })).data;

const argv = process.argv.slice(2);
const live = await call('GET', RELEASE);
const liveSrc = (await call('GET', live.rulesetName)).source.files[0].content;
console.log('live ruleset :', live.rulesetName, '(published ' + live.updateTime + ')');

async function release(rulesetName) {
  await call('PATCH', RELEASE, { release: { name: RELEASE, rulesetName } });
  console.log('now live     :', rulesetName);
  console.log('to undo      : node scripts/deploy-rules.mjs --rollback ' + live.rulesetName);
}

if (argv[0] === '--rollback') {
  if (!argv[1]) { console.error('Which ruleset? e.g. projects/pin-realty/rulesets/…'); process.exit(1); }
  await release(argv[1]);
  process.exit(0);
}

const src = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
const norm = s => s.replace(/[ \t]+$/gm, '').trim();
if (norm(src) === norm(liveSrc)) { console.log('firestore.rules is already live. Nothing to do.'); process.exit(0); }
console.log(`firestore.rules differs from live (${liveSrc.split('\n').length} → ${src.split('\n').length} lines).`);
if (!argv.includes('--apply')) { console.log('Dry run — add --apply to publish.'); process.exit(0); }

const rs = await call('POST', `projects/${PROJECT}/rulesets`, { source: { files: [{ name: 'firestore.rules', content: src }] } });
console.log('compiled     :', rs.name);
await release(rs.name);
