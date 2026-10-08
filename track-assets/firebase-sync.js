// ═══════ PROPERTY & MEDIA TRACK — FIRESTORE SYNC ═══════
//
// Mirrors crm-assets/firebase-sync.js in shape and in contract: it never
// imports the app, it hands data over through `window.applyXSnapshot(...)`
// globals, and every write goes through one `window.trackFirebase` object
// with `tenantId` stamped on — `{ merge: true }` for whole documents, and an
// update of only the changed fields for an existing posting row.
//
// Firebase is initialised with getApps()[0] when it already exists, so this
// module can sit on a page beside another sync module without a second app.
//
// Five live subscriptions:
//   listings/                    where tenantId == ours   → the board's cards
//   trackPipelines/{tenantId}    the board's own columns
//   postTracker/                 where tenantId == ours   → the Posting tab
//   settings/{tenantId}          the team, for "Shoot assigned to"
//   leads/                       where tenantId == ours   → seller leads, for
//                                mapping a listing to the owner who called in
//
// The `properties` collection (the inventory) is read ONCE on demand rather
// than watched: it is large, it changes on a sheet sync rather than by the
// minute, and the board only needs it to resolve a Property_ID the user picks.

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, deleteField, writeBatch, onSnapshot, getDoc, getDocs, query, where
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import { defaultStages } from './track-pipeline.js';

const firebaseConfig = {
  apiKey: "AIzaSyCO5782HKI_ka5zx0tSBzohlvNB5rY_ZF0",
  authDomain: "pin-realty.firebaseapp.com",
  projectId: "pin-realty",
  storageBucket: "pin-realty.firebasestorage.app",
  messagingSenderId: "570586680667",
  appId: "1:570586680667:web:859a61bf99fe1824725e7e"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

let currentTenantId = null;
let subscribed = false;

function pipelineRef(tenantId){ return doc(db, 'trackPipelines', tenantId); }

// The update for a posting row: only the given field paths, plus who changed it and when.
function postingPatch(t, paths){
  const patch = { updatedAt: t.updatedAt || Date.now(), updatedBy: t.updatedBy || '', tenantId: currentTenantId };
  for(const path of paths){
    let v = t;
    for(const p of path.split('.')) v = v == null ? undefined : v[p];
    patch[path] = v === undefined ? deleteField() : v;
  }
  return patch;
}

async function seedPipelineIfEmpty(tenantId){
  const snap = await getDoc(pipelineRef(tenantId));
  if(snap.exists()) return;
  await setDoc(pipelineRef(tenantId), { stages: defaultStages() });
}

function subscribeToData(tenantId){
  if(subscribed) return;
  subscribed = true;
  seedPipelineIfEmpty(tenantId).catch(e => console.error('Track pipeline seed failed:', e)).finally(() => {
    onSnapshot(query(collection(db, 'listings'), where('tenantId', '==', tenantId)),
      snap => { if(window.applyListingsSnapshot) window.applyListingsSnapshot(snap.docs.map(d => d.data())); },
      err => console.error('Firestore listings sync error:', err));

    onSnapshot(pipelineRef(tenantId),
      snap => { if(window.applyTrackPipelineSnapshot) window.applyTrackPipelineSnapshot((snap.data() && snap.data().stages) || []); },
      err => console.error('Firestore track pipeline sync error:', err));

    // Posting tracker: one doc per property, what has been posted where.
    onSnapshot(query(collection(db, 'postTracker'), where('tenantId', '==', tenantId)),
      snap => { if(window.applyPostingSnapshot) window.applyPostingSnapshot(snap.docs.map(d => ({ ...d.data(), id: d.id }))); },
      err => console.error('Firestore postTracker sync error:', err));

    // The team (settings/{tenant}.team, set by the owner in the CRM), for "Shoot assigned to".
    onSnapshot(doc(db, 'settings', tenantId),
      snap => { if(window.applyTrackTeamSnapshot) window.applyTrackTeamSnapshot((snap.data() && snap.data().team) || {}); },
      err => console.error('Firestore team sync error:', err));

    // Seller leads, so a listing can name the owner who actually called in.
    // The whole lead set is watched rather than only sellers: which leads
    // count as sellers is a client-side rule (enquiryType OR the AI's intent
    // — see isSellerLead in crm-assets/app.js), and Firestore cannot express
    // that OR in one query.
    onSnapshot(query(collection(db, 'leads'), where('tenantId', '==', tenantId)),
      snap => { if(window.applyTrackLeadsSnapshot) window.applyTrackLeadsSnapshot(snap.docs.map(d => d.data())); },
      err => console.error('Firestore leads sync error:', err));
  });
}

window.trackFirebase = {
  // One write choke point, exactly like saveLead: strips the fields the board
  // derives for display but never owns, and always re-stamps tenantId so a
  // document can never drift out of its tenant.
  async saveListing(listing){
    if(!currentTenantId) throw new Error('No tenant');
    const { notes, history, lead, property, ...rest } = listing;
    await setDoc(doc(db, 'listings', listing.id), { ...rest, tenantId: currentTenantId }, { merge: true });
  },

  // Posting tracker writes. A new row is written whole; an existing one is sent `paths` — only
  // the fields that change touched ('note', 'channels.igReel', …) — so two people editing
  // different fields of one row never overwrite each other. A path whose value is gone is deleted.
  async savePosting(t, paths){
    if(!currentTenantId) throw new Error('No tenant');
    const ref = doc(db, 'postTracker', t.id);
    if(!paths) return setDoc(ref, { ...t, tenantId: currentTenantId }, { merge: true });
    await updateDoc(ref, postingPatch(t, paths));
  },
  // Many rows in one go (Add schedule, Paste week plan): writes = [{ t, paths? }], same meaning
  // as savePosting. Sent as batches, so it lands (or fails) as a whole, and is reported once.
  async savePostings(writes){
    if(!currentTenantId) throw new Error('No tenant');
    const list = (writes || []).filter(w => w && w.t && w.t.id);
    for(let i = 0; i < list.length; i += 450){
      const batch = writeBatch(db);
      for(const { t, paths } of list.slice(i, i + 450)){
        const ref = doc(db, 'postTracker', t.id);
        if(paths) batch.update(ref, postingPatch(t, paths));
        else batch.set(ref, { ...t, tenantId: currentTenantId }, { merge: true });
      }
      await batch.commit();
    }
  },
  async deletePosting(id){
    if(!currentTenantId) throw new Error('No tenant');
    await deleteDoc(doc(db, 'postTracker', id));
  },

  async deleteListing(id){
    if(!currentTenantId) throw new Error('No tenant');
    await deleteDoc(doc(db, 'listings', id));
  },

  // The ONLY write this page makes to a lead, and deliberately a narrow one:
  // the link back to its listing, the property code once mapped, and the
  // skip tombstone. Everything else on a lead belongs to the CRM. Whitelisted
  // by field name so a future bug here cannot reach the rest of the document.
  async patchLead(leadId, patch){
    if(!currentTenantId) throw new Error('No tenant');
    const allowed = ['listingId', 'propertyCodes', 'listingSkipped'];
    const safe = {};
    for(const k of allowed) if(k in patch) safe[k] = patch[k];
    if(!Object.keys(safe).length) return;
    await setDoc(doc(db, 'leads', leadId), safe, { merge: true });
  },

  async savePipeline(stages){
    if(!currentTenantId) throw new Error('No tenant');
    await setDoc(pipelineRef(currentTenantId), { stages });
  },

  // The inventory, read once and cached by the caller. Projected down to what
  // the property picker shows — the board never needs the full document.
  async getInventory(){
    if(!currentTenantId) return [];
    const snap = await getDocs(query(collection(db, 'properties'), where('tenantId', '==', currentTenantId)));
    return snap.docs.map(d => {
      const p = d.data();
      return {
        id: d.id, propertyCode: p.propertyCode || d.id, name: p.name || '', location: p.location || '',
        config: p.config || '', startingPrice: p.startingPrice || '', type: p.type || '',
        photosLink: p.photosLink || '', brochureLink: p.brochureLink || '', detailsText: p.detailsText || '', soldOut: !!p.soldOut
      };
    });
  },

  // A dashboard property's internal notes (properties/{id}/internalNotes), joined oldest first —
  // read once when a listing is linked to that property, so the brochure panel starts filled.
  // firestore.rules scopes this subcollection by the parent property's tenant, as the dashboard does.
  async getPropertyInternalNotes(propId){
    if(!currentTenantId || !propId) return '';
    const snap = await getDocs(collection(db, 'properties', String(propId), 'internalNotes'));
    return snap.docs.map(d => d.data()).filter(n => n && String(n.text || '').trim())
      .sort((a, b) => (a.createdAt || a.at || 0) - (b.createdAt || b.at || 0))
      .map(n => String(n.text).trim()).join('\n\n');
  },

  // Timeline entries live in a subcollection, like a lead's history, so the
  // card document stays small no matter how long a listing runs.
  async getListingHistory(id){
    const snap = await getDocs(collection(db, 'listings', id, 'history'));
    return snap.docs.map(d => d.data()).sort((a, b) => (b.at || 0) - (a.at || 0));
  },
  async saveHistory(listingId, entry){
    await setDoc(doc(db, 'listings', listingId, 'history', entry.id), entry);
  },
  // Notes are timeline entries of type 'note' (the rules already cover this subcollection),
  // so deleting one is deleting its entry.
  async deleteHistory(listingId, entryId){
    await deleteDoc(doc(db, 'listings', listingId, 'history', entryId));
  }
};

window.trackAuth = {
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  logout: () => signOut(auth),
  getTenantId: () => currentTenantId,
  getIdToken: () => auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null)
};

onAuthStateChanged(auth, async user => {
  if(user){
    try {
      const token = await user.getIdTokenResult(true);
      currentTenantId = token.claims.tenantId || null;
    } catch(e){
      console.error('Could not refresh the sign-in; using the cached one:', e);
      try { currentTenantId = (await user.getIdTokenResult(false)).claims.tenantId || null; } catch(e2) { currentTenantId = null; }
    }
    if(currentTenantId) subscribeToData(currentTenantId);
  } else {
    currentTenantId = null;
  }
  if(window.onTrackAuthChange) window.onTrackAuthChange(user, currentTenantId);
});
