// Additive, idempotent migration: copies each lead's inline notes[] and
// history[] arrays into leads/{id}/notes/{noteId} and leads/{id}/history/{eventId}
// subcollections, and denormalizes noteCount + lastNote onto the parent for the
// board / follow-ups view.
//
// SAFETY: purely additive. It does NOT delete the original notes[]/history[]
// arrays on the parent doc — those stay as an in-place backup until the new
// client code (which reads/writes the subcollections) has been verified. Because
// each note/history entry keeps its own id as the subcollection doc id, this is
// idempotent: safe to run before AND after the deploy to sweep up anything a
// team member added during the cutover window, with no duplicates.
//
// Usage:  node scripts/migrate-notes-history-subcollections.js
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

function noteId(n, i) { return String(n.id || ('n' + (n.createdAt || i))); }
function histId(h, i) { return String(h.id || ('h' + (h.at || i))); }

async function main() {
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    new URL('../api/pin-realty-firebase-adminsdk-fbsvc-e72a22d2f8.json', import.meta.url);
  initializeApp({ credential: cert(JSON.parse(readFileSync(serviceAccountPath, 'utf8'))) });
  const db = getFirestore();

  const leadsSnap = await db.collection('leads').get();
  let leadsTouched = 0, notesCopied = 0, histCopied = 0;

  for (const leadDoc of leadsSnap.docs) {
    const data = leadDoc.data();
    const notes = Array.isArray(data.notes) ? data.notes : [];
    const history = Array.isArray(data.history) ? data.history : [];

    const batch = db.batch();

    notes.forEach((n, i) => {
      const id = noteId(n, i);
      batch.set(leadDoc.ref.collection('notes').doc(id), {
        id, text: n.text || '', createdAt: n.createdAt || Date.now(), by: n.by || null
      });
      notesCopied++;
    });

    history.forEach((h, i) => {
      const id = histId(h, i);
      batch.set(leadDoc.ref.collection('history').doc(id), {
        id, type: h.type || 'field', text: h.text || '', at: h.at || Date.now(), by: h.by || null
      });
      histCopied++;
    });

    // Denormalized fields the board / follow-ups read without loading arrays.
    const sortedNotes = notes.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const last = sortedNotes[sortedNotes.length - 1] || null;
    batch.set(leadDoc.ref, {
      noteCount: notes.length,
      lastNote: last ? { text: last.text || '', createdAt: last.createdAt || 0, by: last.by || null } : null
    }, { merge: true });

    await batch.commit();
    leadsTouched++;
  }

  console.log(`Migrated ${leadsTouched} leads: ${notesCopied} notes, ${histCopied} history events into subcollections.`);
  console.log('Original notes[]/history[] arrays left untouched on the parent docs (backup).');
}

main().catch(e => { console.error('migrate-notes-history-subcollections failed:', e); process.exit(1); });
