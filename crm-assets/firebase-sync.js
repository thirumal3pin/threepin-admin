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

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const leadsCol = collection(db, 'leads');

const DEFAULT_STAGES = [
  { id: 'new', name: 'New', color: '#1D4ED8' },
  { id: 'contacted', name: 'Contacted', color: '#B45309' },
  { id: 'site_visit', name: 'Site Visit', color: '#6D28D9' },
  { id: 'negotiation', name: 'Negotiation', color: '#B45309' },
  { id: 'closed_won', name: 'Closed Won', color: '#15803D' },
  { id: 'closed_lost', name: 'Closed Lost', color: '#B91C1C' }
];

// Every tenant's data lives under this id — resolved once per session from
// the `tenantId` custom claim set at provisioning time (scripts/create-tenant.js).
// A user with no claim yet (not fully onboarded) gets no data access at all.
let currentTenantId = null;
let subscribed = false;

function pipelineRef(tenantId){ return doc(db, 'pipelines', tenantId); }
function whatsappBotRef(tenantId){ return doc(db, 'botConfigs', tenantId); }
function leadsSeededRef(tenantId){ return doc(db, 'leadsSeededFlags', tenantId); }

async function seedPipelineIfEmpty(tenantId){
  const snap = await getDoc(pipelineRef(tenantId));
  if(snap.exists()) return;
  await setDoc(pipelineRef(tenantId), { stages: DEFAULT_STAGES });
}

async function seedSampleLeadsIfEmpty(tenantId){
  const snap = await getDoc(leadsSeededRef(tenantId));
  if(snap.exists()) return;
  const sampleLeads = window.__sampleLeads || [];
  if(sampleLeads.length){
    const batch = writeBatch(db);
    sampleLeads.forEach(l => batch.set(doc(db, 'leads', `${tenantId}_${l.id}`), { ...l, id: `${tenantId}_${l.id}`, tenantId }));
    batch.set(leadsSeededRef(tenantId), { done: true, at: Date.now() });
    await batch.commit();
  }
}

function subscribeToData(tenantId){
  if(subscribed) return;
  subscribed = true;
  Promise.all([
    seedPipelineIfEmpty(tenantId).catch(e => console.error('Pipeline seed error:', e)),
    seedSampleLeadsIfEmpty(tenantId).catch(e => console.error('Sample leads seed error:', e))
  ])
    .finally(() => {
      const leadsQuery = query(leadsCol, where('tenantId', '==', tenantId));
      onSnapshot(leadsQuery, (snapshot) => {
        const list = snapshot.docs.map(d => d.data());
        if (window.applyLeadsSnapshot) window.applyLeadsSnapshot(list);
      }, (err) => console.error('Firestore leads sync error:', err));

      onSnapshot(pipelineRef(tenantId), (snap) => {
        if (snap.exists() && window.applyPipelineSnapshot) {
          window.applyPipelineSnapshot(snap.data().stages || []);
        }
      }, (err) => console.error('Firestore pipeline sync error:', err));
    });
}

window.crmFirebase = {
  saveLead: (lead) => setDoc(doc(db, 'leads', lead.id), { ...lead, tenantId: currentTenantId }).catch(e => console.error('Firestore save lead error:', e)),
  deleteLead: (id) => deleteDoc(doc(db, 'leads', id)).catch(e => console.error('Firestore delete lead error:', e)),
  savePipeline: (stages) => setDoc(pipelineRef(currentTenantId), { stages }).catch(e => console.error('Firestore save pipeline error:', e)),
  getBotConfig: async () => {
    if (!currentTenantId) return null;
    const snap = await getDoc(whatsappBotRef(currentTenantId));
    return snap.exists() ? snap.data() : null;
  },
  saveBotConfig: (config) => setDoc(whatsappBotRef(currentTenantId), config, { merge: true }).catch(e => console.error('Firestore save bot config error:', e))
};

window.crmAuth = {
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  logout: () => signOut(auth),
  getIdToken: () => auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null),
  getTenantId: () => currentTenantId
};

onAuthStateChanged(auth, async (user) => {
  if(user){
    // Force-refresh once so a just-provisioned tenantId claim is picked up
    // even if this is the very first sign-in after account creation.
    const tokenResult = await user.getIdTokenResult();
    currentTenantId = tokenResult.claims.tenantId || null;
    if (!currentTenantId) {
      console.error('This account has no tenantId claim yet — contact support to finish onboarding.');
    } else {
      subscribeToData(currentTenantId);
    }
  } else {
    currentTenantId = null;
    subscribed = false;
  }
  if (window.onCrmAuthChange) window.onCrmAuthChange(user);
});
