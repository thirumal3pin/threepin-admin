// Moves each Property & Media listing's old free-text "Remarks" into its Notes log, as one note
// written by Thirumal at the time this runs (the owner's instruction). The remark is then cleared,
// so it is not shown twice. A note lives in listings/{id}/history with type 'note', the same place
// the board writes new ones.
//
//   node scripts/migrate-listing-remarks.mjs            dry run
//   node scripts/migrate-listing-remarks.mjs --apply    write

import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--apply');
const TENANT = 't_3pinrealty';
const BY = 'thirumal@threepin.in';

initializeApp({ credential: cert(JSON.parse(readFileSync('api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', 'utf8'))) });
const db = getFirestore();

const snap = await db.collection('listings').where('tenantId', '==', TENANT).get();
const todo = snap.docs.filter(d => String(d.data().remarks || '').trim());
console.log(`${snap.size} listings, ${todo.length} with remarks`);
for (const d of todo) console.log(`  ${d.id}  ${(d.data().title || '').slice(0, 30).padEnd(30)}  "${String(d.data().remarks).trim().slice(0, 70)}"`);
if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); process.exit(0); }

const now = Date.now();
let i = 0;
for (const d of todo) {
  const x = d.data();
  const text = String(x.remarks).trim();
  const id = 'n' + now.toString(36) + (i++).toString(36);
  const batch = db.batch();
  batch.set(d.ref.collection('history').doc(id), { id, type: 'note', text, at: now, by: BY, from: 'remarks' });
  batch.update(d.ref, {
    remarks: '',
    lastNote: (x.lastNote && x.lastNote.at > now) ? x.lastNote : { text, by: BY, at: now },
    noteCount: (x.noteCount || 0) + 1
  });
  await batch.commit();
}
console.log(`\nMoved ${todo.length} remark(s) into notes.`);
process.exit(0);
