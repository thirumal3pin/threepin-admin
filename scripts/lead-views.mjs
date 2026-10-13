// Lead views — build, check, switch (shared-assets/lead-views.js says what they are).
//
//   node scripts/lead-views.mjs verify [tenant]   READ-ONLY: every lead against its row (reads every
//                                                 lead once + the views); says what differs
//   node scripts/lead-views.mjs build  [tenant]   (re)builds the views from the leads — the same
//                                                 rebuild the 9 AM digest runs every day
//   node scripts/lead-views.mjs off    [tenant]   every page reads the leads directly again, at once
//   node scripts/lead-views.mjs on     [tenant]   rebuilds, then back to the views
//   node scripts/lead-views.mjs exempt            once per project: no automatic indexes on the rows
//                                                 (nothing queries inside them; without this a busy
//                                                 document could reach Firestore's 40,000 index
//                                                 entries and refuse writes). Prints the status after.
//
// tenant defaults to t_3pinrealty.

import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import * as LV from '../shared-assets/lead-views.js';
import { rebuildLeadViews, viewMeta } from '../api/_lead-views.js';

const [op = 'verify', tenant = 't_3pinrealty'] = process.argv.slice(2);
const sa = JSON.parse(readFileSync('api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const metaRef = db.collection(LV.VIEWS).doc(LV.metaId(tenant));
const sortKeys = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, k) => (o[k] = sortKeys(v[k]), o), {}) : Array.isArray(v) ? v.map(sortKeys) : v);
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const readLeadsDirect = async () => (await db.collection('leads').where('tenantId', '==', tenant).get()).docs.map(d => ({ ...d.data(), id: d.id }));

if (op === 'build') {
  const readAt = Date.now();
  const leads = await readLeadsDirect();
  const r = await rebuildLeadViews(db, tenant, leads, readAt);
  console.log(`built: ${r.count} leads in ${r.shards} view documents (version ${r.version}; ${r.written} written${r.switched ? '; switched to the new set' : ''}${r.prepared ? '; a larger set prepared — in use after the next rebuild' : ''})`);
  console.log(`a page now opens with ${r.shards + 1} reads instead of ${r.count}.`);
} else if (op === 'exempt') {
  const { access_token } = await cert(sa).getAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/(default)/collectionGroups/${LV.VIEWS}/fields/rows`;
  const r = await fetch(url + '?updateMask=indexConfig', { method: 'PATCH', headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ indexConfig: { indexes: [] } }) });
  console.log('exemption requested:', r.status, (await r.text()).slice(0, 300));
  const g = await fetch(url, { headers: { Authorization: 'Bearer ' + access_token } });
  console.log('field now:', (await g.text()).slice(0, 400));
} else if (op === 'off' || op === 'on') {
  // On again: rebuilt first, so nothing written straight to the leads while off is missing.
  if (op === 'on') { const readAt = Date.now(); await rebuildLeadViews(db, tenant, await readLeadsDirect(), readAt); }
  await metaRef.set({ off: op === 'off' }, { merge: true });
  console.log(op === 'off' ? 'views OFF — every page reads the leads directly (live, within seconds)' : 'views ON');
} else {
  const meta = await viewMeta(db, tenant, true);
  if (!meta) { console.log('no views built for', tenant); process.exit(1); }
  const leads = await readLeadsDirect();
  const snaps = await db.getAll(...Array.from({ length: meta.shards }, (_, i) => db.collection(LV.VIEWS).doc(LV.shardId(tenant, meta.version, i))));
  const rows = new Map(LV.rowsToLeads(snaps.map(s => (s.exists ? s.data() : { rows: {} }))).map(l => [l.id, l]));
  const sizes = snaps.map(s => (s.exists ? Buffer.byteLength(JSON.stringify(s.data())) : 0));
  let missing = 0, differs = 0, extra = 0;
  for (const l of leads) {
    const row = rows.get(l.id);
    if (!row) { missing++; if (missing <= 5) console.log('  missing row:', l.id); continue; }
    if (!same(LV.rowOf(l), LV.rowOf(row))) { differs++; if (differs <= 5) console.log('  differs:', l.id); }
  }
  const ids = new Set(leads.map(l => l.id));
  for (const id of rows.keys()) if (!ids.has(id)) { extra++; if (extra <= 5) console.log('  row of a deleted lead:', id); }
  console.log(`${leads.length} leads · ${rows.size} rows in ${meta.shards} documents (version ${meta.version})`);
  console.log(`document sizes: ${sizes.map(b => Math.round(b / 1024) + ' KB').join(', ')} (limit 1024 KB)`);
  console.log(missing || differs || extra ? `NOT IN STEP: ${missing} missing, ${differs} differ, ${extra} extra` : 'IN STEP: every row equals its lead');
  process.exit(missing || differs || extra ? 2 : 0);
}
