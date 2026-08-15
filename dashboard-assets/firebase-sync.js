import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, getDoc, writeBatch, query, where
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCO5782HKI_ka5zx0tSBzohlvNB5rY_ZF0",
  authDomain: "pin-realty.firebaseapp.com",
  projectId: "pin-realty",
  storageBucket: "pin-realty.firebasestorage.app",
  messagingSenderId: "570586680667",
  appId: "1:570586680667:web:859a61bf99fe1824725e7e"
};

// Same Firebase project + Auth as crm.html — log in here with the same
// email/password. See crm-assets/firebase-sync.js for the CRM's mirror of
// this pattern.
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const propertiesCol = collection(db, 'properties');

// Every tenant's properties live under this id — resolved once per session
// from the `tenantId` custom claim set at provisioning time
// (scripts/create-tenant.js / scripts/migrate-existing-tenant.js). A user
// with no claim yet gets no data access at all.
let currentTenantId = null;
let subscribed = false;

function propertiesSeededRef(tenantId){ return doc(db, 'propertiesSeededFlags', tenantId); }

async function seedPropertiesIfEmpty(tenantId){
  const seededRef = propertiesSeededRef(tenantId);
  const seededSnap = await getDoc(seededRef);
  if(seededSnap.exists()) return;
  const batch = writeBatch(db);
  (window.__sampleData || []).forEach(p => batch.set(doc(db, 'properties', p.id), { ...p, tenantId }));
  batch.set(seededRef, { done: true, at: Date.now() });
  await batch.commit();
}

function subscribeToProperties(tenantId){
  if(subscribed) return;
  subscribed = true;
  seedPropertiesIfEmpty(tenantId)
    .catch(e => console.error('Firestore seed error:', e))
    .finally(() => {
      const propertiesQuery = query(propertiesCol, where('tenantId', '==', tenantId));
      onSnapshot(propertiesQuery, (snapshot) => {
        // d.id (the actual Firestore doc path) is the real identity — trust
        // it over whatever's in the data blob. Writers that never baked an
        // `id` field into the document itself (any server-side upsert that
        // doesn't go through savePModal's convention) left it undefined,
        // which silently broke every click-to-open on those cards: the
        // onclick handler stringifies undefined into the literal text
        // "undefined", which never matches the real `undefined` id when
        // openDetail does its lookup, so it fails with no visible error.
        const list = snapshot.docs.map(d => ({ ...d.data(), id: d.id }));
        if (window.applyPropertiesSnapshot) window.applyPropertiesSnapshot(list);
      }, (err) => console.error('Firestore sync error:', err));
    });
}

window.dashboardFirebase = {
  saveProperty: (data) => setDoc(doc(db, 'properties', data.id), { ...data, tenantId: currentTenantId })
    .catch(e => { console.error('Firestore save error:', e); throw e; }),
  deleteProperty: (id) => deleteDoc(doc(db, 'properties', id))
    .catch(e => { console.error('Firestore delete error:', e); throw e; })
};

window.dashboardAuth = {
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  logout: () => signOut(auth),
  getTenantId: () => currentTenantId
};

onAuthStateChanged(auth, async (user) => {
  if(user){
    // Force-refresh so a tenantId claim set AFTER this browser's last
    // sign-in is picked up immediately instead of reusing a stale token.
    const tokenResult = await user.getIdTokenResult(true);
    currentTenantId = tokenResult.claims.tenantId || null;
    if (!currentTenantId) {
      console.error('This account has no tenantId claim yet — contact support to finish onboarding.');
    } else {
      subscribeToProperties(currentTenantId);
    }
  } else {
    currentTenantId = null;
    subscribed = false;
  }
  if (window.onDashboardAuthChange) window.onDashboardAuthChange(user);
});
