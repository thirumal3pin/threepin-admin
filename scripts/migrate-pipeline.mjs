// Reworks a tenant's pipeline into the keyed milestone columns (crm-assets/pipeline.js) and places
// every lead. Dry run by default — prints what it would do; --apply writes it.
//
//   node scripts/migrate-pipeline.mjs                 dry run
//   node scripts/migrate-pipeline.mjs --apply         write
//
// What it writes:
//   pipelines/{tenant}.stages     the 8 columns; stage ids that already meant a milestone are kept
//   leads that sat in a removed column ("Contacted", "General", "Missed Calls", "Spam") are placed
//     by what their record says (planPipelineMigration), with a history line saying why
//   hand-entered leads untouched since before --stale-before (default 1 Aug 2026 IST) that are
//     still open (owner's decision, 14 Sep 2026): early ones (New, Options sent) → Lost, reason
//     "Unreachable"; ones that reached a visit or negotiation → On hold, so a person decides.
//     Their follow-up date is cleared so they stop showing as overdue
//   settings/{tenant}.leadAutomation = { enabled: false, model } unless already set
//
// Leads TailorTalk is talking to are not closed here — the AI places them from their chats.

import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { planPipelineMigration, stageKindOf, stageKeyOf, stageForKey } from '../crm-assets/pipeline.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const TENANT = (args.find(a => a.startsWith('--tenant=')) || '--tenant=t_3pinrealty').split('=')[1];
const STALE_BEFORE = Date.parse((args.find(a => a.startsWith('--stale-before=')) || '--stale-before=2026-08-01T00:00:00+05:30').split('=')[1]);
const MODEL = 'gemini-3.5-flash-lite';

const sa = JSON.parse(readFileSync('api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const now = Date.now();

const pipeRef = db.collection('pipelines').doc(TENANT);
const oldStages = ((await pipeRef.get()).data() || {}).stages || [];
const leadsSnap = await db.collection('leads').where('tenantId', '==', TENANT).get();
const leads = leadsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

const plan = planPipelineMigration(oldStages, leads);
const byId = new Map(plan.moves.map(m => [m.id, m]));
const stageName = id => (plan.stages.find(s => s.id === id) || oldStages.find(s => s.id === id) || { name: id }).name;
const lostId = stageForKey(plan.stages, 'lost').id;
const holdId = stageForKey(plan.stages, 'on_hold').id;
const EARLY = new Set(['new', 'options']);

// Hand-entered, still open after placement, untouched since before the cutoff → Lost (unreachable).
const stale = [];
for (const l of leads) {
  if (l.tt && l.tt.id) continue;
  if (l.enquiryType === 'Vendor / Collaboration') continue;
  const placedStageId = byId.has(l.id) ? byId.get(l.id).toStageId : l.stageId;
  const kind = stageKindOf(plan.stages.find(s => s.id === placedStageId));
  if (kind !== 'open') continue; // re-running must not park or close a lead twice
  if ((l.updatedAt || l.createdAt || 0) >= STALE_BEFORE) continue;
  const key = stageKeyOf(plan.stages.find(s => s.id === placedStageId));
  stale.push({ lead: l, fromStageId: placedStageId, to: EARLY.has(key) ? 'lost' : 'on_hold' });
}

console.log(`tenant ${TENANT} · ${leads.length} leads · ${APPLY ? 'APPLYING' : 'dry run'}`);
console.log('\ncolumns:', plan.stages.map(s => `${s.name} [${s.key}]`).join(' → '));
console.log('removed columns:', plan.removed.map(r => r.name).join(', ') || 'none');
const moveSummary = {};
plan.moves.forEach(m => { const k = `${m.fromName} → ${stageName(m.toStageId)}${m.lostReason ? ' (' + m.lostReason + ')' : ''}`; moveSummary[k] = (moveSummary[k] || 0) + 1; });
console.log('\nplacement moves:', JSON.stringify(moveSummary, null, 1));
const staleSummary = {};
stale.forEach(s => { const k = `${stageName(s.fromStageId)} → ${s.to === 'lost' ? 'Lost (unreachable)' : 'On hold'}`; staleSummary[k] = (staleSummary[k] || 0) + 1; });
console.log(`\nuntouched since before ${new Date(STALE_BEFORE).toISOString().slice(0, 10)}: ${stale.length} — lost ${stale.filter(s => s.to === 'lost').length}, on hold ${stale.filter(s => s.to === 'on_hold').length}`, JSON.stringify(staleSummary, null, 1));
console.log(`…of which with an overdue follow-up: ${stale.filter(s => s.lead.followUpAt && s.lead.followUpAt < now).length}`);

if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.'); process.exit(0); }

// ── Write ──
await pipeRef.set({ stages: plan.stages, reworkedAt: now }, { merge: true });

let batch = db.batch(), pending = 0, written = 0;
const flush = async () => { if (pending) { await batch.commit(); written += pending; batch = db.batch(); pending = 0; } };
const queue = async (fn) => { fn(batch); pending++; if (pending >= 350) await flush(); };
let hSeq = 0;
const hid = () => `h${now}rw${(hSeq++).toString(36)}`;

const staleIds = new Set(stale.map(s => s.lead.id));
for (const m of plan.moves) {
  if (staleIds.has(m.id)) continue; // closed below, with one combined history line
  const ref = db.collection('leads').doc(m.id);
  const patch = {};
  if (m.toStageId !== m.fromStageId) Object.assign(patch, { stageId: m.toStageId, prevStageId: m.fromStageId, stageChangedBy: 'migration' });
  if (m.lostReason) patch.lostReason = m.lostReason;
  if (m.toKey === 'options') patch.detailsSent = true;
  await queue(b => b.update(ref, patch));
  if (m.toStageId !== m.fromStageId) {
    const id = hid();
    await queue(b => b.set(ref.collection('history').doc(id), { id, type: 'stage', text: `Stage changed from <b>${m.fromName}</b> to <b>${stageName(m.toStageId)}</b> in the pipeline rework — ${m.reason}`, at: now, by: 'CRM rework' }));
  }
}
for (const s of stale) {
  const ref = db.collection('leads').doc(s.lead.id);
  const from = byId.has(s.lead.id) ? byId.get(s.lead.id).fromName : stageName(s.lead.stageId);
  const since = new Date(s.lead.updatedAt || s.lead.createdAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
  const base = { prevStageId: s.lead.stageId || null, stageChangedBy: 'migration', followUpAt: null };
  if (s.to === 'lost') {
    await queue(b => b.update(ref, { ...base, stageId: lostId, lostReason: 'unreachable' }));
  } else {
    await queue(b => b.update(ref, { ...base, stageId: holdId, holdReason: 'other', holdUntil: null }));
  }
  const id = hid();
  const text = s.to === 'lost'
    ? `Stage changed from <b>${from}</b> to <b>Lost</b> (Unreachable) in the pipeline rework — untouched since ${since}`
    : `Stage changed from <b>${from}</b> to <b>On hold</b> in the pipeline rework — reached ${stageName(s.fromStageId)} but untouched since ${since}; review and re-open or close`;
  await queue(b => b.set(ref.collection('history').doc(id), { id, type: 'stage', text, at: now, by: 'CRM rework' }));
}
await flush();

const settingsRef = db.collection('settings').doc(TENANT);
const settings = (await settingsRef.get()).data() || {};
if (!settings.leadAutomation) await settingsRef.set({ leadAutomation: { enabled: false, model: MODEL } }, { merge: true });

console.log(`\nwritten: pipeline + ${written} lead/history writes`);
