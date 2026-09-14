// Fills lead.reached (first time each milestone column was entered) for leads that existed before
// milestone dates were recorded. Dry run by default; --apply writes.
//
//   node scripts/backfill-milestones.mjs [--apply] [--tenant=t_3pinrealty]
//
// Sources, oldest first: the lead's creation (it entered New), then every stage line in its
// history ("Stage changed from <b>A</b> to <b>B</b>…", "🤖 Moved from <b>A</b> to <b>B</b>…"),
// with old column names read through the pipeline's legacy names; last, the column it is in now
// (dated by stageChangedAt) if no line recorded it. Existing dates are never overwritten.

import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { LADDER, stageKeyOf, legacyKeyOf } from '../crm-assets/pipeline.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const TENANT = (args.find(a => a.startsWith('--tenant=')) || '--tenant=t_3pinrealty').split('=')[1];

initializeApp({ credential: cert(JSON.parse(readFileSync('api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', 'utf8'))) });
const db = getFirestore();

const stages = ((await db.collection('pipelines').doc(TENANT).get()).data() || {}).stages || [];
const keyOfName = name => {
  const s = stages.find(x => x.name === name);
  return (s && stageKeyOf(s)) || legacyKeyOf(name) || null;
};
const STAGE_LINE = /(?:Stage changed|Moved) from <b>([^<]*)<\/b> to <b>([^<]*)<\/b>/;

const leads = (await db.collection('leads').where('tenantId', '==', TENANT).get()).docs.map(d => ({ id: d.id, ...d.data() }));
let changed = 0, fields = 0;
const tally = {};
let batch = db.batch(), pending = 0;

for (const l of leads) {
  const existing = l.reached || {};
  const found = {};
  const note = (key, at) => { if (LADDER.includes(key) && at && !existing[key] && (!found[key] || at < found[key])) found[key] = at; };

  note('new', l.createdAt);
  const history = (await db.collection('leads').doc(l.id).collection('history').where('type', '==', 'stage').get()).docs.map(d => d.data());
  history.sort((a, b) => (a.at || 0) - (b.at || 0));
  for (const h of history) {
    const m = STAGE_LINE.exec(h.text || '');
    // The column it left was reached no later than this line; the column it entered, at it.
    if (m) { note(keyOfName(m[1]), h.at); note(keyOfName(m[2]), h.at); }
  }
  const current = stageKeyOf(stages.find(s => s.id === l.stageId));
  if (current && !existing[current] && !found[current]) note(current, l.stageChangedAt || l.createdAt);

  const keys = Object.keys(found);
  if (!keys.length) continue;
  changed++; fields += keys.length;
  keys.forEach(k => { tally[k] = (tally[k] || 0) + 1; });
  if (APPLY) {
    batch.update(db.collection('leads').doc(l.id), Object.fromEntries(keys.map(k => [`reached.${k}`, found[k]])));
    if (++pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
  }
}
if (APPLY && pending) await batch.commit();
console.log(`${leads.length} leads · ${changed} get milestone dates (${fields} fields) · by milestone ${JSON.stringify(tally)}`);
console.log(APPLY ? 'applied' : 'dry run — re-run with --apply');
