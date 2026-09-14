// Links existing leads to inventory properties by the codes they already mention: the AI's visit
// property, TailorTalk's "properties discussed", and the lead's property / locality field — the
// same sources and rules live automation uses (crm-assets/propertyLinks.js). Only adds links;
// never re-adds one a person removed. Dry run by default; --apply writes.
//
//   node scripts/backfill-property-links.mjs [--apply] [--tenant=t_3pinrealty]

import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { codesIn, linksToAdd } from '../crm-assets/propertyLinks.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const TENANT = (args.find(a => a.startsWith('--tenant=')) || '--tenant=t_3pinrealty').split('=')[1];

initializeApp({ credential: cert(JSON.parse(readFileSync('api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', 'utf8'))) });
const db = getFirestore();

const known = new Set((await db.collection('properties').where('tenantId', '==', TENANT).select().get()).docs.map(d => d.id));
const leads = (await db.collection('leads').where('tenantId', '==', TENANT).get()).docs.map(d => ({ id: d.id, ...d.data() }));
let linkedLeads = 0, links = 0;
const byProperty = {};
let batch = db.batch(), pending = 0;
for (const l of leads) {
  let profile = '';
  if (l.tt && l.tt.id) {
    const st = (await db.collection('leads').doc(l.id).collection('tailortalk').doc('state').get()).data() || {};
    profile = (st.profile && st.profile.properties_discussed) || '';
  }
  const add = linksToAdd(l, codesIn(l.ai && l.ai.visit && l.ai.visit.property, profile, l.propertyInterest), known);
  if (!add.length) continue;
  linkedLeads++; links += add.length;
  add.forEach(c => { byProperty[c] = (byProperty[c] || 0) + 1; });
  if (APPLY) {
    batch.update(db.collection('leads').doc(l.id), { propertyCodes: [...(l.propertyCodes || []), ...add] });
    if (++pending >= 400) { await batch.commit(); batch = db.batch(); pending = 0; }
  }
}
if (APPLY && pending) await batch.commit();
const top = Object.entries(byProperty).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => `${c} ${n}`).join(', ');
console.log(`${known.size} properties · ${leads.length} leads · ${linkedLeads} get ${links} links · most asked: ${top}`);
console.log(APPLY ? 'applied' : 'dry run — re-run with --apply');
