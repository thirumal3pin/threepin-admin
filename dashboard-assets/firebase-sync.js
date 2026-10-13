import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, getDoc, getDocs, writeBatch, query, where,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, terminate, clearIndexedDbPersistence, waitForPendingWrites
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import { leadViews } from '../shared-assets/lead-views-client.js';
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
// A local copy (IndexedDB) of what this page has read, shared by its tabs: a reload pays only for
// what changed. In memory where the browser cannot keep one.
let db, persistent = true;
// property.html (one property, opened cold from a link, often on a phone) keeps no local copy:
// opening one would only slow its first paint.
try { db = window.__pinPageMode === 'single' ? getFirestore(app) : initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); if (window.__pinPageMode === 'single') persistent = false; }
catch (e) { db = getFirestore(app); persistent = false; }
const views = leadViews(db);
async function signOutAndForget(auth) {
  // A save still on its way goes first (up to 5 s): clearing the local copy would drop it. Not
  // through by then (offline): ask — signing out now would lose those changes.
  const flushed = await Promise.race([waitForPendingWrites(db).then(() => true, () => false), new Promise(r => setTimeout(() => r(false), 5000))]);
  if (!flushed && !confirm('Some changes have not reached the server yet (no connection?). Sign out anyway and lose them? Cancel stays signed in until they are saved.')) return;
  await signOut(auth);
  try { await terminate(db); await clearIndexedDbPersistence(db); }
  catch (e) {
    // Another tab of the admin still open keeps the copy in use: say so, rather than leave it silently.
    if (persistent) alert('Signed out. Close the other admin tabs too, so this computer keeps no copy of the data.');
  }
  location.reload();
}
const auth = getAuth(app);
const propertiesCol = collection(db, 'properties');

// Every tenant's properties live under this id — resolved once per session
// from the `tenantId` custom claim set at provisioning time
// (scripts/create-tenant.js / scripts/migrate-existing-tenant.js). A user
// with no claim yet gets no data access at all.
let currentTenantId = null;
let subscribed = false;
let propsSeenLive = false, propsShown = false;   // the server's list of properties has arrived / anything drawn yet
const singleMode = window.__pinPageMode === 'single';   // property.html: no saved copy, nothing to wait for

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
    .catch(e => console.error('Firestore seed error:', e));
  // The listener starts at once (this device's saved copy first, then the server) — it used to wait
  // for the seed read, a server round trip before a single property showed. The seed only writes
  // for a brand-new account, and the listener picks that up.
  const propertiesQuery = query(propertiesCol, where('tenantId', '==', tenantId));
  // includeMetadataChanges: told also when this device's saved copy is confirmed by the server, so
  // saves can wait for that (see saveProperty).
  onSnapshot(propertiesQuery, { includeMetadataChanges: true }, (snapshot) => {
    const live = !snapshot.metadata.fromCache;
    // Nothing new to draw (a save confirmed, a connection blip): only the server's first word counts.
    if (!snapshot.docChanges().length && propsShown && (!live || propsSeenLive)) return;
    if (live) propsSeenLive = true;
    propsShown = true;
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
}

// property.html sets window.__pinPageMode='single' (in a plain inline script,
// which runs before this deferred module) to say "I only need ONE property".
// That page then skips the whole-collection listener below and opens a
// single-doc listener instead — one document read instead of the entire
// inventory, which is what makes a shared link open fast.
const pageMode = window.__pinPageMode || 'list';

window.dashboardFirebase = {
  // merge:true is deliberate and load-bearing. The dashboard form only knows
  // about PROPERTY_FIELDS, but the document also carries fields written by
  // the brochure pipeline (brochureLink, photosLink, detailsText, source
  // sheet columns...). A plain setDoc would delete every one of those the
  // first time anyone pressed Save from a tab whose data predated them.
  // Clearing a field in the form still works — that writes an explicit ''.
  // A save writes the whole property. Made from this device's saved copy before the server's list is
  // in, it would put that (possibly hours-old) copy back over a Sync from Sheet or a colleague's edit —
  // so until then only a partial save (opts.partial: just the fields given) goes through.
  isLive: () => propsSeenLive || singleMode,
  saveProperty: (data, opts) => {
    if (!propsSeenLive && !(opts && opts.partial) && !singleMode) {
      const e = new Error('Still connecting — try again in a moment'); e.code = 'not-live';
      return Promise.reject(e);
    }
    return setDoc(doc(db, 'properties', data.id), { ...data, tenantId: currentTenantId }, { merge: true })
      .catch(e => { console.error('Firestore save error:', e); throw e; });
  },
  deleteProperty: (id) => deleteDoc(doc(db, 'properties', id))
    .catch(e => { console.error('Firestore delete error:', e); throw e; }),
  // Live single-property subscription, used by property.html. Costs the same
  // as a one-shot read but keeps the standalone page as up-to-date as the
  // dashboard grid — an edit made elsewhere shows up here without a refresh.
  // Returns an unsubscribe.
  subscribeToProperty: (id, onData, onError) => onSnapshot(
    doc(db, 'properties', id),
    snap => onData(snap.exists() ? { ...snap.data(), id: snap.id } : null),
    err => { console.error('Firestore property sync error:', err); if (onError) onError(err); }
  ),

  // ── Leads, for the Matches tab ──
  //
  // The mirror image of getInventory() in crm-assets/firebase-sync.js: that
  // page holds leads and reads properties once; this one holds properties and
  // reads leads once. Both exist so the two halves of a match can be scored
  // on one screen.
  //
  // A one-shot getDocs, NOT an onSnapshot. The grid already keeps a live
  // listener on every property document; a second live listener on every lead
  // would double the page's standing read cost to keep a panel fresh that is
  // only open for a few seconds at a time. The caller caches the result for
  // the session (see loadLeads in app.js) — so opening ten properties in a
  // row costs one read of the lead collection, not ten.
  //
  // firestore.rules already allows this: `leads` is readable by any signed-in
  // user of the owning tenant, and dashboard.html shares the CRM's Firebase
  // Auth and tenantId model. No rules change is needed.
  // The team, for picking a property's agent — the same settings.team list the CRM uses.
  getTeam: async () => {
    const s = await getDoc(doc(db, 'settings', currentTenantId));
    return Object.values((s.exists() && s.data().team) || {}).map(m => m && m.email).filter(Boolean).map(e => String(e).trim().toLowerCase());
  },
  // A property's agent (and a secondary). Only these keys, merged, so the sheet-owned fields and
  // the change log are untouched — an agent is the team's to set, not the sheet's.
  setPropertyAgents: (id, patch) => setDoc(doc(db, 'properties', id), { ...patch, tenantId: currentTenantId }, { merge: true }),
  // Every lead, once — from the lead views (a read per ~20 leads), or the leads until they are built.
  getLeads: () => views.readAll(currentTenantId)
    .catch(e => { console.error('Firestore leads read error:', e); return []; }),

  // ── Notes / events subcollection ──
  // Kept OUT of the property document on purpose, mirroring the CRM's
  // per-lead notes subcollection (crm-assets/firebase-sync.js): the grid's
  // onSnapshot listener streams every property doc continuously, so putting
  // a growing note history inline would re-send the whole log on every
  // unrelated edit. Loaded on demand when a detail panel opens instead.
  getPropertyNotes: (propId) => getDocs(collection(db, 'properties', propId, 'notes'))
    .then(s => s.docs.map(d => ({ ...d.data(), id: d.id })))
    .catch(e => { console.error('Firestore get notes error:', e); throw e; }),
  savePropertyNote: (propId, note) =>
    setDoc(doc(db, 'properties', propId, 'notes', note.id), note)
      .catch(e => { console.error('Firestore save note error:', e); throw e; }),
  deletePropertyNote: (propId, noteId) =>
    deleteDoc(doc(db, 'properties', propId, 'notes', noteId))
      .catch(e => { console.error('Firestore delete note error:', e); throw e; }),

  // ── Internal notes & instructions subcollection ──
  // Team-only pointers and paragraphs (owner's number, negotiation floor,
  // access instructions...). Kept in its own subcollection rather than on
  // the property document for the same reason as notes above — the grid
  // streams every property doc continuously — and, more importantly, so it
  // is structurally impossible for the Inventory sync or the "Sync from
  // Sheet" button to touch it: both write only to the property document.
  // It is also never rendered by property.html, which is the link customers
  // get sent.
  getInternalNotes: (propId) => getDocs(collection(db, 'properties', propId, 'internalNotes'))
    .then(s => s.docs.map(d => ({ ...d.data(), id: d.id })))
    .catch(e => { console.error('Firestore get internal notes error:', e); throw e; }),
  saveInternalNote: (propId, note) =>
    setDoc(doc(db, 'properties', propId, 'internalNotes', note.id), note, { merge: true })
      .catch(e => { console.error('Firestore save internal note error:', e); throw e; }),
  deleteInternalNote: (propId, noteId) =>
    deleteDoc(doc(db, 'properties', propId, 'internalNotes', noteId))
      .catch(e => { console.error('Firestore delete internal note error:', e); throw e; }),

  // ── Change log ──
  // A flat, tenant-scoped collection rather than a per-property subcollection,
  // because the whole point of it is the cross-property date-wise view: "what
  // changed anywhere since I last updated the sheet". Sorting happens client
  // side so this needs no composite index to deploy.
  saveChanges: (entries) => {
    const batch = writeBatch(db);
    entries.forEach(c => batch.set(doc(db, 'propertyChanges', c.id), { ...c, tenantId: currentTenantId }));
    return batch.commit().catch(e => { console.error('Firestore save changes error:', e); throw e; });
  },
  getChanges: () => getDocs(query(collection(db, 'propertyChanges'), where('tenantId', '==', currentTenantId)))
    .then(s => s.docs.map(d => ({ ...d.data(), id: d.id })))
    .catch(e => { console.error('Firestore get changes error:', e); throw e; }),
  // The property's marketing, read only when someone opens that block (a handful of reads, never on
  // a page load): its Shoot & Media card(s) and where each stands, and its posts with their links.
  propertyMarketing: async (id, code) => {
    const keys = [...new Set([id, code, String(code || '').toUpperCase()].filter(Boolean).map(String))].slice(0, 10);
    const T = currentTenantId;
    const [cards, rowsByCode, rowsById, pipe] = await Promise.all([
      getDocs(query(collection(db, 'listings'), where('tenantId', '==', T), where('propertyCode', 'in', keys))),
      getDocs(query(collection(db, 'postTracker'), where('tenantId', '==', T), where('propertyCode', 'in', keys))),
      getDocs(query(collection(db, 'postTracker'), where('tenantId', '==', T), where('propertyId', '==', String(id)))),
      getDoc(doc(db, 'trackPipelines', T)).catch(() => null)
    ]);
    const stages = (pipe && pipe.exists() && pipe.data().stages) || [];
    const rows = new Map();
    [...rowsByCode.docs, ...rowsById.docs].forEach(d => rows.set(d.id, { id: d.id, ...d.data() }));
    return {
      cards: cards.docs.map(d => {
        const x = d.data(), st = stages.find(s => s.id === x.stageId);
        return { id: d.id, title: x.title || '', stage: (st && st.name) || '', shootAt: x.shootAt || null, shootDoneAt: x.shootDoneAt || null,
          leadId: x.leadId || null, listingType: x.listingType || '' };
      }),
      posts: [...rows.values()]
    };
  },
  // Who still points at a property, asked only when someone is about to delete it (a few reads,
  // never on a page load): board cards mapped to it, and leads linked to it by id or by code.
  propertyUsage: async (id, code) => {
    const keys = [...new Set([id, code, String(code || '').toUpperCase()].filter(Boolean).map(String))].slice(0, 10);
    const [cards, leads] = await Promise.all([
      getDocs(query(collection(db, 'listings'), where('tenantId', '==', currentTenantId), where('propertyCode', 'in', keys))),
      Promise.all(keys.map(k => getDocs(query(collection(db, 'leads'), where('tenantId', '==', currentTenantId), where('propertyCodes', 'array-contains', k)))))
    ]);
    const leadIds = new Set();
    leads.forEach(s => s.docs.forEach(d => leadIds.add(d.id)));
    return { cards: cards.docs.map(d => d.data().title || d.id), leads: leadIds.size };
  },
  setChangeApplied: (changeId, applied) =>
    setDoc(doc(db, 'propertyChanges', changeId), { appliedToSheet: !!applied }, { merge: true })
      .catch(e => { console.error('Firestore change-applied error:', e); throw e; })
};

window.dashboardAuth = {
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  logout: () => signOutAndForget(auth),
  getTenantId: () => currentTenantId,
  getUserEmail: () => (auth.currentUser && auth.currentUser.email) || '',
  // Bearer token for calls to api/*, which verify it server-side rather than
  // trusting anything the page claims about who is signed in.
  getIdToken: () => auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null)
};

onAuthStateChanged(auth, async (user) => {
  if(user){
    // The token this browser already holds first: it carries the tenant claim, so the data starts
    // loading at once instead of after a round trip to Google on every open. Only a token WITHOUT
    // the claim is refreshed before going on (a claim set after this browser's last sign-in).
    let tokenResult = null;
    try { tokenResult = await user.getIdTokenResult(false); } catch (e) { tokenResult = null; }
    if (!(tokenResult && tokenResult.claims.tenantId)) {
      try { tokenResult = await user.getIdTokenResult(true); }
      catch (e) { console.error('Could not refresh the sign-in:', e); }
    } else {
      // A claim changed since (a tenant moved): the fresh token, checked in the background, reloads
      // the page onto the right tenant. Nothing waits for it.
      const held = tokenResult.claims.tenantId;
      user.getIdTokenResult(true).then(r => {
        if (r && r.claims.tenantId !== held) location.reload();
      }).catch(() => {});
    }
    currentTenantId = (tokenResult && tokenResult.claims.tenantId) || null;
    if (!currentTenantId) {
      console.error('This account has no tenantId claim yet — contact support to finish onboarding.');
      // The single-property page otherwise sits on its skeleton for ever.
      if (pageMode === 'single' && window.onPinTenantMissing) window.onPinTenantMissing();
    } else if (pageMode === 'single') {
      // Single-property page: it loads its own doc, no collection listener.
      if (window.onPinTenantReady) window.onPinTenantReady(currentTenantId);
    } else {
      subscribeToProperties(currentTenantId);
    }
  } else {
    currentTenantId = null;
    subscribed = false;
  }
  if (window.onDashboardAuthChange) window.onDashboardAuthChange(user);
});
