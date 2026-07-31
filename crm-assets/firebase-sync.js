import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, getDoc, getDocs, writeBatch, query, where
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

const DEFAULT_ENQUIRY_TYPES = ['Property Enquiry', 'Seller Listing', 'General'];

// Every tenant's data lives under this id — resolved once per session from
// the `tenantId` custom claim set at provisioning time (scripts/create-tenant.js).
// A user with no claim yet (not fully onboarded) gets no data access at all.
let currentTenantId = null;
let subscribed = false;

function pipelineRef(tenantId){ return doc(db, 'pipelines', tenantId); }
function whatsappBotRef(tenantId){ return doc(db, 'botConfigs', tenantId); }
function leadsSeededRef(tenantId){ return doc(db, 'leadsSeededFlags', tenantId); }
function settingsRef(tenantId){ return doc(db, 'settings', tenantId); }

async function seedPipelineIfEmpty(tenantId){
  const snap = await getDoc(pipelineRef(tenantId));
  if(snap.exists()) return;
  await setDoc(pipelineRef(tenantId), { stages: DEFAULT_STAGES });
}

async function seedSettingsIfEmpty(tenantId){
  const snap = await getDoc(settingsRef(tenantId));
  if(snap.exists()) return;
  await setDoc(settingsRef(tenantId), { enquiryTypes: DEFAULT_ENQUIRY_TYPES });
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
    seedSampleLeadsIfEmpty(tenantId).catch(e => console.error('Sample leads seed error:', e)),
    seedSettingsIfEmpty(tenantId).catch(e => console.error('Settings seed error:', e))
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

      onSnapshot(settingsRef(tenantId), (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        if (window.applyEnquiryTypesSnapshot) window.applyEnquiryTypesSnapshot(data.enquiryTypes || DEFAULT_ENQUIRY_TYPES);
        if (window.applyPropertiesSnapshot) window.applyPropertiesSnapshot(data.properties || []);
        if (window.applyDigestSettingsSnapshot) {
          window.applyDigestSettingsSnapshot({
            enabled: !!data.followupDigestEnabled,
            recipients: data.followupDigestRecipients || [],
            emailEnabled: !!data.followupDigestEmailEnabled,
            emails: data.followupDigestEmails || []
          });
        }
        if (window.applyDashboardEmailSettingsSnapshot) {
          window.applyDashboardEmailSettingsSnapshot({
            enabled: !!data.dashboardEmailEnabled,
            // null (key never set) vs [] (saved once, deliberately emptied) are
            // distinct — the client uses null to decide whether to default this
            // list from the Follow-up Digest's recipients on first-ever open.
            recipients: Array.isArray(data.dashboardEmailRecipients) ? data.dashboardEmailRecipients : null
          });
        }
      }, (err) => console.error('Firestore settings sync error:', err));
    });
}

window.crmFirebase = {
  // Notes + history live in per-lead subcollections now (see saveNote /
  // saveHistory below), so they are stripped from the parent write: the lead
  // doc stays small and constant-size, so a note-add never rewrites a growing
  // document and the board listener never streams note/history bodies.
  saveLead: (lead) => {
    const { notes, history, ...rest } = lead;
    return setDoc(doc(db, 'leads', lead.id), { ...rest, tenantId: currentTenantId }).catch(e => console.error('Firestore save lead error:', e));
  },
  deleteLead: (id) => deleteDoc(doc(db, 'leads', id)).catch(e => console.error('Firestore delete lead error:', e)),

  // ── Notes / history subcollections ──
  getLeadNotes: (leadId) => getDocs(collection(db, 'leads', leadId, 'notes'))
    .then(s => s.docs.map(d => d.data()))
    .catch(e => { console.error('Firestore get notes error:', e); return []; }),
  getLeadHistory: (leadId) => getDocs(collection(db, 'leads', leadId, 'history'))
    .then(s => s.docs.map(d => d.data()))
    .catch(e => { console.error('Firestore get history error:', e); return []; }),
  saveNote: (leadId, note) => setDoc(doc(db, 'leads', leadId, 'notes', note.id), note).catch(e => console.error('Firestore save note error:', e)),
  deleteNoteDoc: (leadId, noteId) => deleteDoc(doc(db, 'leads', leadId, 'notes', noteId)).catch(e => console.error('Firestore delete note error:', e)),
  saveHistory: (leadId, event) => setDoc(doc(db, 'leads', leadId, 'history', event.id), event).catch(e => console.error('Firestore save history error:', e)),

  savePipeline: (stages) => setDoc(pipelineRef(currentTenantId), { stages }).catch(e => console.error('Firestore save pipeline error:', e)),
  getBotConfig: async () => {
    if (!currentTenantId) return null;
    const snap = await getDoc(whatsappBotRef(currentTenantId));
    return snap.exists() ? snap.data() : null;
  },
  saveBotConfig: (config) => setDoc(whatsappBotRef(currentTenantId), config, { merge: true }).catch(e => console.error('Firestore save bot config error:', e)),
  saveEnquiryTypes: (enquiryTypes) => setDoc(settingsRef(currentTenantId), { enquiryTypes }, { merge: true }).catch(e => console.error('Firestore save enquiry types error:', e)),
  // The curated property list behind the Add Lead combobox. Leads already in
  // the CRM contribute their properties client-side; this doc is what makes a
  // brand-new property selectable before its first lead exists.
  saveProperties: (properties) => setDoc(settingsRef(currentTenantId), { properties }, { merge: true }).catch(e => console.error('Firestore save properties error:', e)),
  saveFollowupDigestSettings: (enabled, recipients, emailEnabled, emails) => setDoc(settingsRef(currentTenantId), {
    followupDigestEnabled: enabled,
    followupDigestRecipients: recipients,
    followupDigestEmailEnabled: emailEnabled,
    followupDigestEmails: emails
  }, { merge: true }).catch(e => console.error('Firestore save digest settings error:', e)),
  saveDashboardEmailSettings: (enabled, recipients) => setDoc(settingsRef(currentTenantId), {
    dashboardEmailEnabled: enabled,
    dashboardEmailRecipients: recipients
  }, { merge: true }).catch(e => console.error('Firestore save dashboard email settings error:', e))
};

window.crmAuth = {
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  logout: () => signOut(auth),
  getIdToken: () => auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null),
  getTenantId: () => currentTenantId
};

onAuthStateChanged(auth, async (user) => {
  if(user){
    // Force-refresh (the `true` argument) so a tenantId claim set AFTER this
    // browser's last sign-in — e.g. right after scripts/create-tenant.js or
    // scripts/migrate-existing-tenant.js ran — is picked up immediately,
    // instead of silently reusing a cached token that predates the claim.
    const tokenResult = await user.getIdTokenResult(true);
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
