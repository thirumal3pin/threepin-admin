// Does Claude Haiku read leads the way Gemini did?
//
//   node scripts/compare-lead-ai.mjs --n=12 --out=<file.json>
//
// Takes the leads Gemini most recently placed, re-reads each with Claude Haiku as a PREVIEW
// (apply: false — nothing is written to the lead), and compares the two verdicts field by field.
// Costs one Haiku call per lead (~$0.006 each) and roughly ten Firestore reads per lead. The
// result is saved to --out; run it again only if you mean to spend again.
//
// Needs LEAD_AI_ANTHROPIC_API_KEY in the environment or in .env.lead-ai.local.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import Anthropic from '@anthropic-ai/sdk';
import { runLeadAutomation } from '../api/_lead-automation.js';

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const N = Math.min(Number(arg('n', 12)), 30);
const OUT = arg('out', null);
if (!OUT) { console.error('--out=<file.json> is required, so a run is never repeated by accident'); process.exit(1); }
if (existsSync(OUT)) { console.error(`${OUT} exists — delete it to spend again`); process.exit(1); }

const envFile = new URL('../.env.lead-ai.local', import.meta.url);
const apiKey = process.env.LEAD_AI_ANTHROPIC_API_KEY
  || (existsSync(envFile) ? (readFileSync(envFile, 'utf8').match(/^LEAD_AI_ANTHROPIC_API_KEY=(.+)$/m) || [])[1] : '');
if (!apiKey) { console.error('LEAD_AI_ANTHROPIC_API_KEY is not set'); process.exit(1); }

const TENANT = process.env.TENANT || 't_3pinrealty';
const key = JSON.parse(readFileSync(new URL('../api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', import.meta.url), 'utf8'));
initializeApp({ credential: cert(key) });
const db = getFirestore();
const client = new Anthropic({ apiKey: apiKey.trim() });

// The leads Gemini read most recently, with the verdict it gave.
const snap = await db.collection('leads').orderBy('ai.lastMove.at', 'desc').limit(N * 2).get();
const picked = [];
for (const d of snap.docs) {
  if (picked.length >= N) break;
  if (d.data().tenantId !== TENANT) continue;
  const runs = await d.ref.collection('aiRuns').orderBy('at', 'desc').limit(3).get();
  const g = runs.docs.map(r => r.data()).find(r => r.ok && /gemini/.test(r.model || '') && r.verdict);
  if (g) picked.push({ id: d.id, name: d.data().name || '', gemini: g });
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const rows = [];
let tokensIn = 0, tokensOut = 0;
for (const p of picked) {
  const r = await runLeadAutomation(db, TENANT, p.id, { client, model: 'claude-haiku-4-5', apply: false, force: true, trigger: 'compare' });
  if (r.usage) { tokensIn += r.usage.input || 0; tokensOut += r.usage.output || 0; }
  const g = p.gemini.verdict, h = r.verdict || {};
  const row = {
    lead: p.id, name: p.name,
    sameChat: (p.gemini.input || {}).messages,
    ok: !!r.ok, error: r.error || null,
    gemini: { stage: g.stage, intent: g.intent, owner: g.next && g.next.owner, visit: g.visit && g.visit.status, line: g.line },
    haiku: r.ok ? { stage: h.stage, intent: h.intent, owner: h.next && h.next.owner, visit: h.visit && h.visit.status, line: h.line, moved: r.moved && r.moved.to } : null
  };
  row.match = r.ok ? {
    stage: same(row.gemini.stage, row.haiku.stage), intent: same(row.gemini.intent, row.haiku.intent),
    owner: same(row.gemini.owner, row.haiku.owner), visit: same(row.gemini.visit, row.haiku.visit)
  } : null;
  rows.push(row);
  console.log(`${p.name.padEnd(22).slice(0, 22)} gemini ${String(g.stage).padEnd(13)} haiku ${String(r.ok ? h.stage : 'ERR ' + r.error).padEnd(13)} ${row.match ? Object.entries(row.match).filter(([, v]) => !v).map(([k]) => k + '≠').join(' ') || 'all match' : ''}`);
}
const okRows = rows.filter(r => r.ok);
const rate = k => okRows.length ? Math.round(100 * okRows.filter(r => r.match[k]).length / okRows.length) : 0;
const summary = { leads: rows.length, answered: okRows.length, agree: { stage: rate('stage'), intent: rate('intent'), owner: rate('owner'), visit: rate('visit') },
  tokens: { in: tokensIn, out: tokensOut }, costUsd: +((tokensIn * 1 + tokensOut * 5) / 1e6).toFixed(4) };
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), summary, rows }, null, 2));
console.log('\n' + JSON.stringify(summary));
process.exit(0);
