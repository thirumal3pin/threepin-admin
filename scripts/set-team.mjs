// Sets the team who can be @mentioned in the CRM: settings/{tenant}.team, replaced as a whole.
// The list below is the owner's (14 Sep 2026). Edit it and re-run to change the team.
//
//   node scripts/set-team.mjs [--tenant=t_3pinrealty]

import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { teamKey } from '../crm-assets/mentions.js';

const TEAM = ['sales@threepin.in', 'admin@threepin.in', 'swami@threepin.in', 'pradeep@threepin.in', 'thirumal@threepin.in'];
const TENANT = (process.argv.find(a => a.startsWith('--tenant=')) || '--tenant=t_3pinrealty').split('=')[1];

initializeApp({ credential: cert(JSON.parse(readFileSync('api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', 'utf8'))) });
const db = getFirestore();
const ref = db.collection('settings').doc(TENANT);
await ref.update({ team: Object.fromEntries(TEAM.map(email => [teamKey(email), { email }])) });
console.log('team:', Object.values((await ref.get()).data().team).map(m => m.email).join(', '));
