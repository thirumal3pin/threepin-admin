// ═══════ PROPERTY & MEDIA TRACK — FIRESTORE SYNC ═══════
//
// Mirrors crm-assets/firebase-sync.js in shape and in contract: it never
// imports the app, it hands data over through `window.applyXSnapshot(...)`
// globals, and every write goes through one `window.trackFirebase` object
// with `tenantId` stamped on and `{ merge: true }` set.
//
// Firebase is initialised with getApps()[0] when it already exists, so this
// module can sit on a page beside another sync module without a second app.
//
// Three live subscriptions:
//   listings/                    where tenantId == ours   → the board's cards
//   trackPipelines/{tenantId}    the board's own columns
//   leads/                       where tenantId == ours   → seller leads, for
//                                mapping a listing to the owner who called in
//
// The `properties` collection (the inventory) is read ONCE on demand rather
// than watched: it is large, it changes on a sheet sync rather than by the
// minute, and the board only needs it to resolve a Property_ID the user picks.

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, getDoc, getDocs, query, where
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

  async deleteListing(id){
    if(!currentTenantId) throw new Error('No tenant');
    await deleteDoc(doc(db, 'listings', id));
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
        photosLink: p.photosLink || '', brochureLink: p.brochureLink || '', soldOut: !!p.soldOut
      };
    });
  },

  // Timeline entries live in a subcollection, like a lead's history, so the
  // card document stays small no matter how long a listing runs.
  async getListingHistory(id){
    const snap = await getDocs(collection(db, 'listings', id, 'history'));
    return snap.docs.map(d => d.data()).sort((a, b) => (b.at || 0) - (a.at || 0));
  },
  async saveHistory(listingId, entry){
    await setDoc(doc(db, 'listings', listingId, 'history', entry.id), entry);
  }
};

window.trackAuth = {
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  logout: () => signOut(auth),
  getTenantId: () => currentTenantId
};

onAuthStateChanged(auth, async user => {
  if(user){
    try {
      const token = await user.getIdTokenResult(true);
      currentTenantId = token.claims.tenantId || null;
    } catch(e){
      console.error('Could not read the tenant claim:', e);
      currentTenantId = null;
    }
    if(currentTenantId) subscribeToData(currentTenantId);
  } else {
    currentTenantId = null;
  }
  if(window.onTrackAuthChange) window.onTrackAuthChange(user, currentTenantId);
});
