// Local dev only: api/_bot-shared.js as the API handlers see it under scripts/easy-dev.mjs (a module
// hook swaps it in). Everything is the real module except the two things that would reach the live
// project: the database is the dev server's in-memory Firestore, and sign-in is the dev token.
export * from '../../api/_bot-shared.js?real';
import { T } from '../../tests/fixtures/easy-seed.mjs';

export function getDb() {
  if (!globalThis.__devDb) throw new Error('dev database not ready');
  return globalThis.__devDb;
}

export async function verifyCrmUser(request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const m = token.match(/^dev:(.+@.+)$/);
  return m ? { email: m[1].toLowerCase(), email_verified: true, uid: m[1], tenantId: T } : null;
}

// Never email from a dev machine.
export async function sendEmail(to, subject) { console.log(`  [dev] email not sent → ${to}: ${subject}`); return { ok: true, dev: true }; }
