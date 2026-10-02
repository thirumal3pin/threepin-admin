// Which AI places leads: Gemini or Claude Haiku.
//
//   node scripts/set-lead-ai.mjs            say which one is on
//   node scripts/set-lead-ai.mjs claude     Claude Haiku 4.5 (LEAD_AI_ANTHROPIC_API_KEY on Vercel)
//   node scripts/set-lead-ai.mjs gemini     Gemini 3.5 Flash-Lite (GEMINI_API_KEY on Vercel)
//
// Both stay wired in the code; this flips settings/{tenant}.leadAutomation.model, which every
// webhook, refresh and nightly sync reads, so the change takes effect on the next read with no
// deploy. Claude here is always Haiku: api/_lead-ai.js refuses to send a larger model.
//
// One Firestore read and at most one write.

import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const TENANT = process.env.TENANT || 't_3pinrealty';
const MODELS = { claude: 'claude-haiku-4-5', gemini: 'gemini-3.5-flash-lite' };
const want = (process.argv[2] || '').toLowerCase();
if (want && !MODELS[want]) { console.error('Say "claude" or "gemini".'); process.exit(1); }

const key = JSON.parse(readFileSync(new URL('../api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', import.meta.url), 'utf8'));
initializeApp({ credential: cert(key) });
const ref = getFirestore().collection('settings').doc(TENANT);
const cur = ((await ref.get()).data() || {}).leadAutomation || {};
console.log(`Now: ${cur.model || '(default) gemini-3.5-flash-lite'}, automation ${cur.enabled ? 'on' : 'off'}`);
if (want) {
  if (cur.model === MODELS[want]) console.log('Already set — nothing changed.');
  else {
    await ref.set({ leadAutomation: { model: MODELS[want], changedBy: 'set-lead-ai', changedAt: Date.now() } }, { merge: true });
    console.log(`Switched to ${MODELS[want]}.`);
  }
}
process.exit(0);
