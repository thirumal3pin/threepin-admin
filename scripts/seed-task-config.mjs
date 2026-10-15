// Creates taskConfigs/{tenantId} — who assigns tasks and who sees whose — once, for a tenant that has
// none. The Firestore rules let no page create it (only a manager may change it afterwards, in
// Settings → Configurations → Tasks), so this is how the first managers are set. It never touches
// a configuration that already exists.
//
//   node scripts/seed-task-config.mjs [--tenantId t_3pinrealty] [--managers a@x.in,b@x.in]
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { DEFAULT_MANAGERS } from '../shared-assets/task-model.js';

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const tenantId = arg('tenantId') || 't_3pinrealty';
const managers = (arg('managers') ? arg('managers').split(',') : DEFAULT_MANAGERS).map(e => e.trim().toLowerCase()).filter(Boolean);

const sa = JSON.parse(readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || new URL('../api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', import.meta.url), 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

const ref = db.collection('taskConfigs').doc(tenantId);
const snap = await ref.get();
if (snap.exists) {
  console.log(`taskConfigs/${tenantId} already exists — left as it is:`, JSON.stringify(snap.data()));
  process.exit(0);
}
if (!(await db.collection('botConfigs').doc(tenantId).get()).exists) {
  console.error(`No tenant "${tenantId}" (no botConfigs/${tenantId}). Nothing written.`);
  process.exit(1);
}
await ref.create({ tenantId, managers, viewers: {}, updatedAt: Date.now(), updatedBy: 'seed-task-config' });
console.log(`taskConfigs/${tenantId} created. Managers: ${managers.join(', ')}. Nobody sees anyone else's tasks yet.`);
