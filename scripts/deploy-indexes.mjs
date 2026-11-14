// Creates the composite indexes listed in firestore.indexes.json on the live project, through the
// Firestore Admin API — no Firebase CLI needed, only this computer's service-account key (_key.js).
//
//   node scripts/deploy-indexes.mjs            dry run: which listed indexes are missing live?
//   node scripts/deploy-indexes.mjs --apply    create the missing ones (Google builds them in the
//                                              background; a query needing one fails until it is READY)
//
// Only adds: an index that exists live but is not in the file is left alone (never deleted here).
// The indexes today: Messages' conversation lists, newest first and capped (shared-assets/access.js,
// messages-assets/messages.js), so a page never re-reads a person's whole conversation history.
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { serviceAccount } from './_key.js';

const PROJECT = 'pin-realty';
const API = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/collectionGroups/`;
const key = serviceAccount();
const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/datastore'] });
const call = async (method, url, data) => (await jwt.request({ method, url, data })).data;
const apply = process.argv.includes('--apply');

const want = JSON.parse(readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8')).indexes;
const sig = fields => fields.filter(f => f.fieldPath !== '__name__').map(f => f.fieldPath + ':' + (f.order || f.arrayConfig)).join(',');
let missing = 0;
for (const ix of want) {
  const live = (await call('GET', API + ix.collectionGroup + '/indexes')).indexes || [];
  const found = live.find(l => l.queryScope === ix.queryScope && sig(l.fields) === sig(ix.fields));
  const label = `${ix.collectionGroup} (${sig(ix.fields)})`;
  if (found) { console.log('live    ', label, '—', found.state); continue; }
  missing++;
  if (!apply) { console.log('MISSING ', label); continue; }
  const op = await call('POST', API + ix.collectionGroup + '/indexes', { queryScope: ix.queryScope, fields: ix.fields });
  console.log('creating', label, '—', op.name || 'requested');
}
if (!apply && missing) console.log('Dry run — add --apply to create the missing indexes.');
if (!missing) console.log('Every listed index is live.');
