// How hard is lead automation leaning on Claude?
//
//   node scripts/check-lead-ai.mjs
//
// Reads aiState/{tenant} (one Firestore read) and prints today's Claude reads against the daily cap,
// the current minute's use, and the busiest minute ever seen — each as a share of the account's
// Haiku 4.x limits. The code holds every minute under 50% of each limit (api/_lead-automation.js);
// this shows how close it has come.

import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { CLAUDE_LIMITS, CLAUDE_SHARE, CLAUDE_DAILY_CAP } from '../api/_lead-automation.js';

const TENANT = process.env.TENANT || 't_3pinrealty';
initializeApp({ credential: cert(JSON.parse(readFileSync(new URL('../api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', import.meta.url), 'utf8'))) });
const db = getFirestore();
const [st, settings] = await Promise.all([db.collection('aiState').doc(TENANT).get(), db.collection('settings').doc(TENANT).get()]);
const a = st.exists ? st.data() : {};
const model = ((settings.data() || {}).leadAutomation || {}).model;
const pct = (v, k) => `${(v || 0).toLocaleString()} / ${CLAUDE_LIMITS[k].toLocaleString()} (${(100 * (v || 0) / CLAUDE_LIMITS[k]).toFixed(3)}%)`;
const istDay = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

console.log(`Model: ${model}`);
console.log(`Today (${istDay} IST): ${a.claudeDay === istDay ? a.claudeRuns || 0 : 0} of ${CLAUDE_DAILY_CAP} Claude reads`);
const nowMin = Math.floor(Date.now() / 60000);
const cur = a.claudeMin === nowMin ? a.claudeMinUse || {} : {};
console.log(`This minute: requests ${pct(cur.requests, 'requests')}, input ${pct(cur.inputTokens, 'inputTokens')}, output ${pct(cur.outputTokens, 'outputTokens')}`);
if (a.claudePeak) {
  const p = a.claudePeak;
  console.log(`Busiest minute: ${(100 * p.share).toFixed(3)}% of the limit at ${new Date(p.at).toISOString()} — requests ${p.requests}, input ${p.inputTokens}, output ${p.outputTokens}`);
  console.log(p.share < CLAUDE_SHARE ? `OK: always under the ${100 * CLAUDE_SHARE}% ceiling.` : `OVER the ${100 * CLAUDE_SHARE}% ceiling — investigate.`);
} else console.log('No Claude minute recorded yet.');
process.exit(0);
