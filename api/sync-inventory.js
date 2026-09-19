import { getDb, verifyCrmUser } from './_bot-shared.js';
import {
  getSheetsToken, readInventoryRows, readQueueFill, planSync, unmappedHeaders,
  commitWrites, loadExistingProperties, loadPendingProtections, TENANT_ID
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
  // Apply a chosen subset instead of the whole plan. The dashboard sends the
  // ids the person actually approved, so a sheet sync stops being one
  // all-or-nothing button: you can take the three properties you have checked
  // and leave the rest pending until you have looked at them.
  const only = Array.isArray(body.only)
    ? new Set(body.only.map(x => String(x)).filter(Boolean))
    : null;
  if(only && !only.size) return json({ error: 'No properties were selected.' }, 400);

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if(!raw) return json({ error: 'Server is missing FIREBASE_SERVICE_ACCOUNT_JSON.' }, 500);

  let sa;
  try { sa = JSON.parse(raw); }
  catch { return json({ error: 'Server credential is malformed.' }, 500); }

  try {
    const sheetsToken = await getSheetsToken(sa);
    const rows = await readInventoryRows(sheetsToken);
    const queueFill = await readQueueFill(sheetsToken);
    const headers = rows[0] || [];
    const db = getDb();
    const existing = await loadExistingProperties(db);
    const protections = await loadPendingProtections(db);
    const plan = planSync(rows, existing, null, queueFill, protections);

    const summary = {
      dryRun,
      sheetRows: Math.max(rows.length - 1, 0),
      sheetColumns: headers.length,
      unmappedHeaders: unmappedHeaders(headers),
      created: plan.creates.length,
      updated: plan.updates.length,
      unchanged: plan.unchanged,
      untouched: plan.orphans.length,
      // Dashboard edits kept because they're still pending in the Changes
      // worklist — shown in the preview so "why didn't my sheet value come
      // through" is answered on screen instead of looking like a sync bug.
      protectedFields: plan.protectedFields.slice(0, 80),
      skippedDeleted: plan.skippedDeleted,
      // The preview used to stop at 60 properties and 8 fields each, silently —
      // so on a big sheet run "pull all the changes" simply did not. The caps
      // are now high enough to cover a whole inventory, and whatever they do
      // elide is reported rather than hidden, so the count on screen can never
      // disagree with what Apply would write.
      changes: [...plan.creates.map(c => ({ id:c.id, name:c.name, kind:'create', fields:[] })),
                ...plan.updates.map(u => ({
                  id: u.id, name: u.name, kind: 'update',
                  fields: u.changes.slice(0, 40).map(c => ({ field:c.field, from:c.from, to:c.to })),
                  moreFields: Math.max(u.changes.length - 40, 0)
                }))].slice(0, 400),
      changesTotal: plan.creates.length + plan.updates.length
    };

    if(dryRun || !plan.writes.length) return json({ ok: true, ...summary });

    // Narrow the plan to the approved ids. Done after planning, never before,
    // so the diff every property is judged on is identical whether it is
    // applied now or later — a subset apply is the same write the full run
    // would have made, not a differently-computed one.
    if(only){
      plan.writes = plan.writes.filter(p => only.has(p.id));
      plan.staleExtras = plan.staleExtras.filter(st => only.has(st.id));
      if(!plan.writes.length){
        return json({ error: 'Those properties have nothing left to change — the sheet may have moved on. Re-run the preview.' }, 409);
      }
    }

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

    await commitWrites(db, plan.writes, plan.staleExtras);
    return json({ ok: true, ...summary, written: plan.writes.length,
                  appliedIds: plan.writes.map(p => p.id),
                  backupId: before.length ? runId : null });
  } catch (e) {
    console.error('sync-inventory failed:', e);
    return json({ error: 'Sync failed. ' + String(e.message || e).slice(0, 300) }, 500);
  }
}
