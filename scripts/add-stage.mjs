// Adds any column present in STAGE_DEFS but missing from a tenant's live
// pipeline, in the right order. Leads are never touched — this only writes
// pipelines/{tenant}.stages.
//
// Deliberately NOT migrate-pipeline.mjs: that script is a one-off rework which
// also closes stale hand-entered leads. Re-running it to add a column would
// re-apply those closures.
//
//   node scripts/add-stage.mjs                  dry run
//   node scripts/add-stage.mjs --apply          write
//   node scripts/add-stage.mjs --tenant=t_x     another tenant

import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { STAGE_DEFS } from '../crm-assets/pipeline.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const TENANT = (args.find(a => a.startsWith('--tenant=')) || '--tenant=t_3pinrealty').split('=')[1];

initializeApp({ credential: cert(JSON.parse(readFileSync('api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', 'utf8'))) });
const db = getFirestore();

const ref = db.collection('pipelines').doc(TENANT);
const live = ((await ref.get()).data() || {}).stages || [];
if (!live.length) { console.error(`No pipeline for ${TENANT}. Run migrate-pipeline.mjs first.`); process.exit(1); }

const byKey = new Map(live.map(s => [s.key, s]));
const missing = STAGE_DEFS.filter(d => !byKey.has(d.key));
// Anything the tenant added by hand keeps its place at the end.
const custom = live.filter(s => !STAGE_DEFS.some(d => d.key === s.key));

console.log(`tenant   : ${TENANT}`);
console.log(`live now : ${live.map(s => s.name).join(' · ')}`);
if (!missing.length) { console.log('\nNothing missing — the pipeline already has every defined column.'); process.exit(0); }
console.log(`\nto add   : ${missing.map(d => `${d.name} (${d.key})`).join(', ')}`);

// Rebuild in STAGE_DEFS order, keeping every existing id so no lead's stageId
// is orphaned, then the custom columns after.
const next = [
  ...STAGE_DEFS.map((d, i) => {
    const kept = byKey.get(d.key);
    return kept
      ? { ...kept, key: d.key, kind: d.kind, order: i }
      : { id: d.key, key: d.key, kind: d.kind, name: d.name, color: d.color, order: i };
  }),
  ...custom.map((s, i) => ({ ...s, order: STAGE_DEFS.length + i })),
];

console.log(`after    : ${next.map(s => s.name).join(' · ')}`);
const movedIds = live.filter(s => { const n = next.find(x => x.id === s.id); return n && n.order !== s.order; });
console.log(`\nre-ordered (ids unchanged, no lead moves): ${movedIds.length}`);

if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); process.exit(0); }
await ref.set({ stages: next }, { merge: true });
console.log('\nWritten. Every lead keeps the column it was in.');
process.exit(0);
