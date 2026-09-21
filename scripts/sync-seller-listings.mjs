// ═══════ SELLER LEADS → PROPERTY LISTINGS, server-side ═══════
//
// The same reconcile the Property & Media board runs live, done here with the
// Admin SDK so it does not depend on anyone having the page open. Use it to
// backfill the first time, and on a schedule afterwards as the safety net.
//
//   node scripts/sync-seller-listings.mjs --dry-run     # show what would change
//   node scripts/sync-seller-listings.mjs               # apply it
//
// It imports track-assets/seller-sync.js — the SAME module the browser uses —
// so the two can never drift into producing different documents. Everything
// about which fields each side owns is documented there, not here.
//
// Idempotent by construction: a lead that already has a listing is only
// patched where the CRM's value differs, and a lead marked listingSkipped is
// left alone, so running it twice changes nothing the second time.

import fs from 'node:fs';
import path from 'node:path';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { planSync, wantsListing, isSellerLead } from '../track-assets/seller-sync.js';
import { defaultStages } from '../track-assets/track-pipeline.js';

const DRY = process.argv.includes('--dry-run');
const SA_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH
  || path.join(import.meta.dirname, '..', 'api', 'pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json');
const TENANT = process.env.TENANT_ID || 't_3pinrealty';

if (!getApps().length) initializeApp({ credential: cert(JSON.parse(fs.readFileSync(SA_PATH, 'utf8'))) });
const db = getFirestore();

console.log(`--- seller → listing sync ${DRY ? '(dry run)' : ''} ${new Date().toISOString()} ---`);
console.log(`tenant: ${TENANT}`);

// The board's columns. Seeded here if the page has never been opened, so a
// backfill on a fresh tenant does not silently do nothing.
const pipeRef = db.collection('trackPipelines').doc(TENANT);
let pipeSnap = await pipeRef.get();
if (!pipeSnap.exists) {
  if (DRY) {
    console.log('trackPipelines: would seed the default columns');
  } else {
    await pipeRef.set({ stages: defaultStages() });
    console.log('trackPipelines: seeded the default columns');
    pipeSnap = await pipeRef.get();
  }
}
const stages = (pipeSnap.exists ? (pipeSnap.data().stages || []) : defaultStages())
  .slice().sort((a, b) => (a.order || 0) - (b.order || 0));
if (!stages.length) { console.error('No columns on the board — aborting.'); process.exit(1); }

const [leadsSnap, listingsSnap] = await Promise.all([
  db.collection('leads').where('tenantId', '==', TENANT).get(),
  db.collection('listings').where('tenantId', '==', TENANT).get()
]);
const leads = leadsSnap.docs.map(d => ({ ...d.data(), id: d.id }));
const listings = listingsSnap.docs.map(d => ({ ...d.data(), id: d.id }));

const sellers = leads.filter(isSellerLead);
const eligible = leads.filter(wantsListing);
console.log(`leads: ${leads.length} · sellers: ${sellers.length} · eligible for a card: ${eligible.length} · listings now: ${listings.length}`);

const now = Date.now();
const plan = planSync(leads, listings, stages[0], now, 'sync-script');
console.log(`\nplan: create ${plan.create.length} · patch ${plan.updateListings.length} listing(s) · patch ${plan.updateLeads.length} lead(s)`);

for (const { lead, listing } of plan.create) {
  console.log(`  + ${listing.id}  ${listing.title || '(untitled)'}  ← lead ${lead.name || lead.id}`);
}
for (const { id, patch, lead } of plan.updateListings) {
  console.log(`  ~ ${id}  ${JSON.stringify(patch)}  ← lead ${lead.name || lead.id}`);
}

if (DRY) { console.log('\nDry run — nothing written.'); process.exit(0); }
if (!plan.create.length && !plan.updateListings.length && !plan.updateLeads.length) {
  console.log('\nAlready in step — nothing to write.');
  process.exit(0);
}

// Batched, so a partial failure cannot leave half a reconcile applied. 500 is
// Firestore's own per-batch ceiling; history entries are written alongside.
let batch = db.batch(), ops = 0, written = 0;
const flush = async () => { if (ops) { await batch.commit(); written += ops; batch = db.batch(); ops = 0; } };
const add = fn => { fn(batch); ops++; return ops >= 450 ? flush() : Promise.resolve(); };

for (const { lead, listing } of plan.create) {
  await add(b => b.set(db.collection('listings').doc(listing.id), { ...listing, tenantId: TENANT }));
  await add(b => b.set(db.collection('listings').doc(listing.id).collection('history').doc('h' + now.toString(36) + Math.random().toString(36).slice(2, 6)), {
    type: 'created', at: now, by: 'sync',
    text: `Created automatically from the CRM seller lead <b>${String(lead.name || lead.id).replace(/[&<>]/g, '')}</b>`
  }));
}
for (const { id, patch } of plan.updateListings) {
  await add(b => b.set(db.collection('listings').doc(id), { ...patch, updatedAt: now }, { merge: true }));
}
for (const { id, patch } of plan.updateLeads) {
  await add(b => b.set(db.collection('leads').doc(id), patch, { merge: true }));
}
await flush();

console.log(`\nwrote ${written} document(s).`);
process.exit(0);
