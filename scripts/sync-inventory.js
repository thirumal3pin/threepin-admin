// Syncs the Inventory master sheet into the dashboard's `properties`
// collection. This is the read path that makes the sheet the single source of
// truth — it does NOT depend on the Mac's brochure scheduler, and can run
// anywhere the service account key is available.
//
// Usage:
//   node scripts/sync-inventory.js                      # dry run — prints the diff, writes nothing
//   node scripts/sync-inventory.js --apply              # writes to Firestore
//   node scripts/sync-inventory.js --apply --id NGMA001 # a single property
//   node scripts/sync-inventory.js --restore <file>     # undo, from a backup
//
// All the mapping logic lives in api/_inventory-shared.js, shared with the
// dashboard's "Sync from Sheet" button so the two can never disagree about
// what a column means.
//
// SAFETY RULES, all deliberate:
//   1. The sheet is never written to. Read-only scope, no exceptions.
//   2. A property with no matching sheet row is NEVER touched — not updated,
//      not flagged, not deleted. That protects the older listings that carry
//      random codes and were never entered into the sheet.
//   3. Dashboard-owned fields (soldOut, interestLevel) are never written, so a
//      re-run cannot un-sell a property or wipe a lead rating.
//   4. Writes use { merge: true }, so pipeline-written fields (brochureLink,
//      photosLink, detailsText) survive untouched.
//   5. Nothing is ever deleted, and --apply always snapshots first.

import fs from 'node:fs';
import path from 'node:path';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  getSheetsToken, readInventoryRows, readQueueFill, planSync, unmappedHeaders,
  commitWrites, loadExistingProperties, TENANT_ID
} from '../api/_inventory-shared.js';

const SA_PATH = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  || path.join(import.meta.dirname, '..', 'api', 'pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json');

const APPLY = process.argv.includes('--apply');
const ONLY_ID = (() => { const i = process.argv.indexOf('--id'); return i > -1 ? process.argv[i + 1] : null; })();

function getDb(){
  if(!getApps().length) initializeApp({ credential: cert(JSON.parse(fs.readFileSync(SA_PATH,'utf8'))) });
  return getFirestore();
}

const trunc = (s, n = 40) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// Puts back exactly what a pre-sync backup recorded. Only touches the
// properties named in that file — anything else is left alone.
async function restore(file){
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const db = getDb();
  console.log(`restoring ${snap.properties.length} propert${snap.properties.length===1?'y':'ies'} from ${snap.takenAt}\n`);
  for(let i = 0; i < snap.properties.length; i += 400){
    const batch = db.batch();
    snap.properties.slice(i, i + 400).forEach(({ id, data }) =>
      batch.set(db.collection('properties').doc(id), data));
    await batch.commit();
  }
  console.log('✓ Restore complete.');
}

async function main(){
  const ri = process.argv.indexOf('--restore');
  if(ri > -1){
    const f = process.argv[ri + 1];
    if(!f || !fs.existsSync(f)){ console.error('Pass an existing backup file: --restore <file>'); process.exit(1); }
    return restore(f);
  }
  if(!fs.existsSync(SA_PATH)){
    console.error(`Service account key not found at:\n  ${SA_PATH}\nSet FIREBASE_SERVICE_ACCOUNT_PATH or place the key there.`);
    process.exit(1);
  }
  console.log(APPLY ? '── APPLY MODE — changes will be written ──\n'
                    : '── DRY RUN — nothing will be written. Re-run with --apply to commit. ──\n');

  const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
  const sheetsToken = await getSheetsToken(sa);
  const rows = await readInventoryRows(sheetsToken);
  const queueFill = await readQueueFill(sheetsToken);
  const headers = rows[0] || [];
  console.log(`sheet: ${rows.length - 1} rows, ${headers.length} columns`);
  const unmapped = unmappedHeaders(headers);
  if(unmapped.length) console.log(`unmapped → sheetExtras: ${unmapped.join(', ')}`);
  console.log();

  const db = getDb();
  const existing = await loadExistingProperties(db);
  console.log(`firestore: ${existing.size} properties for ${TENANT_ID}\n`);

  const plan = planSync(rows, existing, ONLY_ID, queueFill);

  plan.creates.forEach(c => console.log(`  + CREATE ${c.id.padEnd(10)} ${trunc(c.name, 46)}`));
  plan.updates.forEach(u => {
    console.log(`  ~ UPDATE ${u.id.padEnd(10)} ${trunc(u.name, 46)}`);
    u.changes.slice(0, 6).forEach(c =>
      console.log(`      ${c.field.padEnd(18)} ${trunc(c.from, 28)}  →  ${trunc(c.to, 28)}`));
    if(u.changes.length > 6) console.log(`      …and ${u.changes.length - 6} more field(s)`);
  });

  console.log(`\n── summary ──`);
  console.log(`  create   : ${plan.creates.length}`);
  console.log(`  update   : ${plan.updates.length}`);
  console.log(`  unchanged: ${plan.unchanged}`);
  console.log(`  untouched (no sheet row): ${plan.orphans.length}`);
  if(plan.orphans.length){
    console.log(`    ${plan.orphans.slice(0,12).map(id=>{
      const p = existing.get(id) || {};
      return `${id}${p.name ? ' ('+trunc(p.name,24)+')' : ''}`;
    }).join('\n    ')}`);
    if(plan.orphans.length > 12) console.log(`    …and ${plan.orphans.length - 12} more`);
  }

  if(!APPLY){
    console.log(`\nDry run complete — nothing written. Re-run with --apply to commit.`);
    return;
  }
  if(!plan.writes.length){ console.log('\nNothing to write.'); return; }

  // Snapshot every property this run will modify, BEFORE the first write.
  // The dashboard's change log only records edits made by a person, so
  // without this a sync would overwrite existing values with no way back.
  const backupDir = path.join(import.meta.dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `properties-before-sync-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  const backup = plan.writes.filter(p => existing.has(p.id)).map(p => ({ id: p.id, data: existing.get(p.id) }));
  fs.writeFileSync(backupFile, JSON.stringify({
    takenAt: new Date().toISOString(),
    tenantId: TENANT_ID,
    note: 'Pre-sync snapshot of every property this run modified. Newly created properties are absent by design — they had no prior state.',
    properties: backup
  }, null, 2));
  console.log(`\nbackup: ${backup.length} existing propert${backup.length===1?'y':'ies'} snapshotted to`);
  console.log(`        ${backupFile}`);

  // On a 30-minute schedule these would accumulate indefinitely, so keep only
  // the most recent 40. Runs with no changes never reach this point.
  fs.readdirSync(backupDir)
    .filter(f => f.startsWith('properties-before-sync'))
    .sort().reverse().slice(40)
    .forEach(f => { try { fs.unlinkSync(path.join(backupDir, f)); } catch {} });

  await commitWrites(db, plan.writes);
  console.log(`\n✓ Wrote ${plan.writes.length} propert${plan.writes.length === 1 ? 'y' : 'ies'}. ${plan.orphans.length} left untouched.`);
}

main().catch(e => { console.error('sync-inventory failed:', e); process.exit(1); });
