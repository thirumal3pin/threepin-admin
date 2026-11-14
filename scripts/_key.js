// Where this computer's Firebase service-account key is. Every admin script uses this, so a new key
// (a fresh one generated in Firebase console → Service accounts) works without editing scripts:
//   FIREBASE_SERVICE_ACCOUNT_PATH, if set; otherwise the first api/*firebase-adminsdk*.json.
// The key file is gitignored and vercelignored — it never leaves the machine it was saved on.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export function serviceAccountPath() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) return process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const api = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');
  const f = readdirSync(api).find(n => /firebase-adminsdk.*\.json$/.test(n));
  if (!f) throw new Error('No Firebase key found: put one in api/ (Firebase console → Project settings → Service accounts → Generate new private key) or set FIREBASE_SERVICE_ACCOUNT_PATH.');
  return join(api, f);
}

export function serviceAccount() {
  return JSON.parse(readFileSync(serviceAccountPath(), 'utf8'));
}
