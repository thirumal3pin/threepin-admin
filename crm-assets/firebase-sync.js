import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, getDoc, writeBatch
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
const pipelineRef = doc(db, 'config', 'pipeline');
const leadsSeededRef = doc(db, 'config', 'leadsSeeded');

const DEFAULT_STAGES = [
  { id: 'new', name: 'New', color: '#1D4ED8' },
  { id: 'contacted', name: 'Contacted', color: '#B45309' },
  { id: 'site_visit', name: 'Site Visit', color: '#6D28D9' },
  { id: 'negotiation', name: 'Negotiation', color: '#B45309' },
  { id: 'closed_won', name: 'Closed Won', color: '#15803D' },
  { id: 'closed_lost', name: 'Closed Lost', color: '#B91C1C' }
];

let subscribed = false;

async function seedPipelineIfEmpty(){
  const snap = await getDoc(pipelineRef);
  if(snap.exists()) return;
  await setDoc(pipelineRef, { stages: DEFAULT_STAGES });
}

async function seedSampleLeadsIfEmpty(){
  const snap = await getDoc(leadsSeededRef);
  if(snap.exists()) return;
  const sampleLeads = window.__sampleLeads || [];
  if(sampleLeads.length){
    const batch = writeBatch(db);
    sampleLeads.forEach(l => batch.set(doc(db, 'leads', l.id), l));
    batch.set(leadsSeededRef, { done: true, at: Date.now() });
    await batch.commit();
  }
}

function subscribeToData(){
  if(subscribed) return;
  subscribed = true;
  Promise.all([
    seedPipelineIfEmpty().catch(e => console.error('Pipeline seed error:', e)),
    seedSampleLeadsIfEmpty().catch(e => console.error('Sample leads seed error:', e))
  ])
    .finally(() => {
      onSnapshot(leadsCol, (snapshot) => {
        const list = snapshot.docs.map(d => d.data());
        if (window.applyLeadsSnapshot) window.applyLeadsSnapshot(list);
      }, (err) => console.error('Firestore leads sync error:', err));

      onSnapshot(pipelineRef, (snap) => {
        if (snap.exists() && window.applyPipelineSnapshot) {
          window.applyPipelineSnapshot(snap.data().stages || []);
        }
      }, (err) => console.error('Firestore pipeline sync error:', err));
    });
}

window.crmFirebase = {
  saveLead: (lead) => setDoc(doc(db, 'leads', lead.id), lead).catch(e => console.error('Firestore save lead error:', e)),
  deleteLead: (id) => deleteDoc(doc(db, 'leads', id)).catch(e => console.error('Firestore delete lead error:', e)),
  savePipeline: (stages) => setDoc(pipelineRef, { stages }).catch(e => console.error('Firestore save pipeline error:', e))
};

window.crmAuth = {
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  logout: () => signOut(auth)
};

onAuthStateChanged(auth, (user) => {
  if(user) subscribeToData();
  if (window.onCrmAuthChange) window.onCrmAuthChange(user);
});
