// Re-dates follow-ups that were left behind when a lead postponed.
// Dry run by default; --apply writes.
//
//   node scripts/repair-missed-followups.mjs [--apply] [--tenant=t_3pinrealty] [--cache=.leads-cache.json]
//
// api/_lead-policy.js used to treat ANY existing follow-up as "we are already
// chasing them sooner", including one whose hour had already gone by. So a
// lead who wrote "I am travelling to Kerala. Will be back by the 5 th." was
// parked On hold until the 5th correctly — and left with a follow-up a week
// overdue, still noted as the site visit they had just cancelled.
//
// The policy is fixed. But it only re-runs when a lead sends a message, and a
// lead who has told us they are away is exactly the one who will not. This
// walks the leads already in that state and moves each follow-up onto the
// revisit date the CRM had itself worked out and was already displaying on
// the lead — so there is no judgement in it, and no date invented here.
//
// A lead qualifies only when all three hold:
//   · holdUntil is in the future — it is parked, and parked until a known day;
//   · holdReason is set — holdUntil and holdReason are written together with
//     the On hold move and cleared together on the way out, so the pair is
//     what "parked" means, and this needs no pipeline read to establish it;
//   · followUpAt is in the past — the chase was missed, not merely earlier.
//
// --cache reads the leads from a local JSON pull instead of Firestore. This
// tenant runs close to its daily read quota, and a dry run should not cost
// 500 reads to tell you about one lead.

import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const TENANT = (args.find(a => a.startsWith('--tenant=')) || '--tenant=t_3pinrealty').split('=')[1];
const CACHE = (args.find(a => a.startsWith('--cache=')) || '').split('=')[1] || null;

const NOTE = 'Revisit — the lead asked to be contacted around now';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = ms => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

initializeApp({ credential: cert(JSON.parse(readFileSync('api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', 'utf8'))) });
const db = getFirestore();
const now = Date.now();

const leads = CACHE
  ? JSON.parse(readFileSync(CACHE, 'utf8')).filter(l => l.tenantId === TENANT)
  : (await db.collection('leads').where('tenantId', '==', TENANT).get()).docs.map(d => ({ id: d.id, ...d.data() }));

const stuck = leads.filter(l => l.holdUntil > now && l.holdReason && l.followUpAt && l.followUpAt < now);

console.log(`${leads.length} leads${CACHE ? ' (from ' + CACHE + ')' : ''} — ${stuck.length} parked with a follow-up already missed`);
for (const l of stuck) {
  console.log('');
  console.log(`  ${l.name || l.id}`);
  console.log(`    follow-up  ${fmt(l.followUpAt)}   ->   ${fmt(l.holdUntil)}`);
  console.log(`    note       ${l.followUpNote || '—'}`);
  console.log(`               ->   ${NOTE}`);
  if (!APPLY) continue;
  const ref = db.collection('leads').doc(l.id);
  const hid = 'h' + now.toString(36) + Math.random().toString(36).slice(2, 7);
  const batch = db.batch();
  batch.update(ref, { followUpAt: l.holdUntil, followUpBy: 'ai', followUpSetAt: now, followUpNote: NOTE });
  batch.set(ref.collection('history').doc(hid), {
    id: hid, type: 'followup', at: now, by: 'AI',
    text: `🤖 Follow-up set for <b>${esc(fmt(l.holdUntil))}</b> (was ${esc(fmt(l.followUpAt))}, missed) — ${esc(NOTE)}`
  });
  await batch.commit();
  console.log('    written');
}
console.log('');
console.log(APPLY ? `applied to ${stuck.length}` : 'dry run — re-run with --apply to write');
