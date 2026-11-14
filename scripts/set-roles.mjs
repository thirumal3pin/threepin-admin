// Sets agent-layer roles (the `role` custom claim, firestore.rules "Who is asking") from this list.
// Day one (14 Nov 2026): the four admins the owner named. Agents are added from team.html once
// their part of the system is live — or here with --agent.
//
//   node scripts/set-roles.mjs                     dry run: shows each login, its role now and next
//   node scripts/set-roles.mjs --apply             sets the admins below
//   node scripts/set-roles.mjs --apply --agent rameez@threepin.in
//
// Claims are MERGED (the tenantId claim stays). Only roles are added here — nobody is demoted by
// this script; demote from team.html, which guards against leaving the team with no admin.
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { serviceAccount } from './_key.js';

const TENANT = 't_3pinrealty';
const ADMINS = ['thirumal@threepin.in', 'swami@threepin.in', 'pradeep@threepin.in', 'admin@threepin.in'];

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const agentArg = argv.includes('--agent') ? argv[argv.indexOf('--agent') + 1] : null;
const plan = new Map(ADMINS.map(e => [e, 'admin']));
if (agentArg) plan.set(agentArg.toLowerCase(), 'agent');

initializeApp({ credential: cert(serviceAccount()) });
const auth = getAuth();
const db = getFirestore();

let bad = 0;
for (const [email, role] of plan) {
  let u;
  try { u = await auth.getUserByEmail(email); } catch (e) {
    console.log(`${email.padEnd(26)} NO LOGIN — create it first (team.html → Add a person, or scripts/add-team-member.js)`);
    bad++;
    continue;
  }
  const claims = u.customClaims || {};
  if (claims.tenantId !== TENANT) {
    console.log(`${email.padEnd(26)} not on ${TENANT} (tenant: ${claims.tenantId || 'none'}) — skipped`);
    bad++;
    continue;
  }
  const now = claims.role || 'none';
  console.log(`${email.padEnd(26)} ${now.padEnd(6)} → ${role}${now === role ? '  (already)' : ''}`);
  if (!apply || now === role) continue;
  await auth.setCustomUserClaims(u.uid, { ...claims, role });
  await db.collection('users').doc(u.uid).set({ tenantId: TENANT, email, access: role, accessSetBy: 'scripts/set-roles.mjs', accessSetAt: Date.now() }, { merge: true });
  await db.collection('accessLog').add({ tenantId: TENANT, by: 'scripts/set-roles.mjs', at: Date.now(), action: 'set-role', uid: u.uid, email, from: now, to: role });
}
console.log(apply ? '\nDone. Each person picks the role up on their next page load (or within the hour).' : '\nDry run — nothing changed. Add --apply to set these.');
process.exit(bad && apply ? 1 : 0);
