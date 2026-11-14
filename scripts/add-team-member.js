// Adds a new login for an EXISTING business — unlike create-tenant.js (which
// mints a brand-new tenantId for a separate business), this attaches the new
// user to a tenantId that already exists, so they see the exact same leads,
// properties, bot config, and connected WhatsApp number as everyone else on
// that tenant, in BOTH crm.html and dashboard.html (same accounts, same
// pathway — dashboard.html has no separate login system anymore).
//
// If the email already has a Firebase Auth account (e.g. someone created it
// by hand in the Firebase Console before running this), this does NOT create
// a duplicate or touch their password — it just attaches the tenantId claim
// to the existing account.
//
// Usage:
//   node scripts/add-team-member.js --email teammate@3pin.in --tenantId t_3pinrealty [--password somepass] [--role member] [--access admin|agent]
//
// --access sets the agent-layer role claim (firestore.rules, "Who is asking"): admin, agent, or
// leave it out for a team member who works exactly as before. Admins can also do all of this from
// team.html (Team & access) without a script.
//
// Your business's tenantId is t_3pinrealty (see docs/SOP.md).
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { serviceAccount as readKey } from './_key.js';
import { randomBytes } from 'node:crypto';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email || !args.tenantId) {
    console.error('Usage: node scripts/add-team-member.js --email teammate@example.com --tenantId t_3pinrealty [--password somepass] [--role member]');
    process.exit(1);
  }

  if (args.access && !['admin', 'agent'].includes(args.access)) {
    console.error('--access must be admin or agent (leave it out for a team member as before)');
    process.exit(1);
  }
  initializeApp({ credential: cert(readKey()) });

  const auth = getAuth();
  const db = getFirestore();

  // Confirm the tenant actually exists before attaching someone to it —
  // catches a typo'd tenantId early instead of silently creating an orphan.
  const botCfgSnap = await db.collection('botConfigs').doc(args.tenantId).get();
  if (!botCfgSnap.exists) {
    console.error(`No tenant found with tenantId "${args.tenantId}" (no botConfigs/${args.tenantId} doc). Check docs/SOP.md for the right tenantId, or use create-tenant.js if this is meant to be a new, separate business.`);
    process.exit(1);
  }

  let userRecord;
  let createdPassword = null;
  try {
    userRecord = await auth.getUserByEmail(args.email);
    console.log(`Found an existing Firebase Auth account for ${args.email} — attaching the tenantId claim to it (not creating a new account, not touching their password).`);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    createdPassword = args.password || randomBytes(9).toString('base64url');
    userRecord = await auth.createUser({ email: args.email, password: createdPassword, emailVerified: true });
  }
  // The team's own address, confirmed: a first "Continue with Google" with the same email then ADDS
  // Google to this account. Unconfirmed, Firebase would remove the password on that first Google
  // sign-in instead.
  if (!userRecord.emailVerified) userRecord = await auth.updateUser(userRecord.uid, { emailVerified: true });

  // MERGE the claims: replacing them would wipe a role set earlier (admin/agent).
  const claims = { ...(userRecord.customClaims || {}), tenantId: args.tenantId };
  if (args.access) claims.role = args.access;
  await auth.setCustomUserClaims(userRecord.uid, claims);

  await db.collection('users').doc(userRecord.uid).set({
    tenantId: args.tenantId,
    email: args.email,
    role: args.role || 'member',
    ...(args.access ? { access: args.access } : {}),
    createdAt: Date.now()
  }, { merge: true });

  console.log('Team member ready:');
  console.log('  tenantId:', args.tenantId);
  console.log('  uid:     ', userRecord.uid);
  console.log('  email:   ', args.email);
  if (claims.role) console.log('  access:  ', claims.role);
  if (createdPassword) console.log('  password:', createdPassword, '(share this securely — it is not stored anywhere)');
  console.log('\nThey can log in at crm.html AND dashboard.html right away (same account, same tenant) and will see the same leads/properties/bot config/WhatsApp connection as everyone else on this tenant.');
}

main().catch(e => {
  console.error('add-team-member failed:', e);
  process.exit(1);
});
