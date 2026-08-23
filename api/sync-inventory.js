import { getDb, verifyCrmUser } from './_bot-shared.js';
import {
  getSheetsToken, readInventoryRows, planSync, unmappedHeaders,
  commitWrites, loadExistingProperties, TENANT_ID
} from './_inventory-shared.js';

// Powers the dashboard's "Sync from Sheet" button. Same mapping logic as
// scripts/sync-inventory.js — both import api/_inventory-shared.js, so the
// button and the scheduled run can never disagree about what a column means.
//
// POST with a Firebase ID token. Body: { dryRun?: boolean }.
// A dry run reports what would change and writes nothing, which is what the
// dashboard requests first so the user can see the diff before committing.

function json(body, status = 200){
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function POST(request){
  const user = await verifyCrmUser(request);
  if(!user || !user.tenantId) return json({ error: 'Unauthorized' }, 401);

  // The inventory sheet belongs to 3 PIN Realty specifically. Another tenant
  // holding a valid token must not be able to pull this sheet into their own
  // properties — so this is scoped to the owning tenant, not just "signed in".
  if(user.tenantId !== TENANT_ID) return json({ error: 'This sheet is not available for your account.' }, 403);

  let body = {};
  try { body = await request.json(); } catch { /* empty body means apply */ }
  const dryRun = body.dryRun === true;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if(!raw) return json({ error: 'Server is missing FIREBASE_SERVICE_ACCOUNT_JSON.' }, 500);

  let sa;
  try { sa = JSON.parse(raw); }
  catch { return json({ error: 'Server credential is malformed.' }, 500); }

  try {
    const rows = await readInventoryRows(await getSheetsToken(sa));
    const headers = rows[0] || [];
    const db = getDb();
    const existing = await loadExistingProperties(db);
    const plan = planSync(rows, existing);

    const summary = {
      dryRun,
      sheetRows: Math.max(rows.length - 1, 0),
      sheetColumns: headers.length,
      unmappedHeaders: unmappedHeaders(headers),
      created: plan.creates.length,
      updated: plan.updates.length,
      unchanged: plan.unchanged,
      untouched: plan.orphans.length,
      // Enough detail for the dashboard to show what actually moved, capped
      // so a first-run diff of hundreds of fields can't bloat the response.
      changes: [...plan.creates.map(c => ({ id:c.id, name:c.name, kind:'create', fields:[] })),
                ...plan.updates.map(u => ({
                  id: u.id, name: u.name, kind: 'update',
                  fields: u.changes.slice(0, 8).map(c => ({ field:c.field, from:c.from, to:c.to })),
                  moreFields: Math.max(u.changes.length - 8, 0)
                }))].slice(0, 60)
    };

    if(dryRun || !plan.writes.length) return json({ ok: true, ...summary });

    // Vercel's filesystem is ephemeral, so the CLI's file backup is no use
    // here. The prior state of every property this run modifies goes into
    // Firestore instead, giving the button the same recoverability the
    // command line has. Server-only: no client rule grants access to it.
    const runId = `sync-${new Date().toISOString().replace(/[:.]/g,'-')}`;
    const before = plan.writes
      .filter(p => existing.has(p.id))
      .map(p => ({ id: p.id, data: existing.get(p.id) }));
    if(before.length){
      await db.collection('syncBackups').doc(runId).set({
        takenAt: new Date().toISOString(),
        tenantId: TENANT_ID,
        triggeredBy: user.email || user.uid || '',
        note: 'Pre-sync snapshot of every property this run modified. Newly created properties are absent by design.',
        properties: before
      });
    }

    await commitWrites(db, plan.writes);
    return json({ ok: true, ...summary, written: plan.writes.length, backupId: before.length ? runId : null });
  } catch (e) {
    console.error('sync-inventory failed:', e);
    return json({ error: 'Sync failed. ' + String(e.message || e).slice(0, 300) }, 500);
  }
}
