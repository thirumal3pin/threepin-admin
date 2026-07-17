import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, getDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCO5782HKI_ka5zx0tSBzohlvNB5rY_ZF0",
  authDomain: "pin-realty.firebaseapp.com",
  projectId: "pin-realty",
  storageBucket: "pin-realty.firebasestorage.app",
  messagingSenderId: "570586680667",
  appId: "1:570586680667:web:859a61bf99fe1824725e7e"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const propertiesCol = collection(db, 'properties');

async function seedIfEmpty(){
  const seededRef = doc(db, 'meta', 'seeded');
  const seededSnap = await getDoc(seededRef);
  if(seededSnap.exists()) return;
  const batch = writeBatch(db);
  (window.__sampleData || []).forEach(p => batch.set(doc(db, 'properties', p.id), p));
  batch.set(seededRef, { done: true, at: Date.now() });
  await batch.commit();
}

window.dashboardFirebase = {
  saveProperty: (data) => setDoc(doc(db, 'properties', data.id), data).catch(e => console.error('Firestore save error:', e)),
  deleteProperty: (id) => deleteDoc(doc(db, 'properties', id)).catch(e => console.error('Firestore delete error:', e))
};

seedIfEmpty()
  .catch(e => console.error('Firestore seed error:', e))
  .finally(() => {
    onSnapshot(propertiesCol, (snapshot) => {
      const list = snapshot.docs.map(d => d.data());
      if (window.applyPropertiesSnapshot) window.applyPropertiesSnapshot(list);
    }, (err) => console.error('Firestore sync error:', err));
  });
