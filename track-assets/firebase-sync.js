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
//   settings/{tenantId}          the team, for "Shoot assigned to"; trackConfig, this page's settings
//   leads/                       where tenantId == ours   → seller leads, for
//                                mapping a listing to the owner who called in
//
// The `properties` collection (the inventory) is read ONCE on demand rather
// than watched: it is large, it changes on a sheet sync rather than by the
// minute, and the board only needs it to resolve a Property_ID the user picks.

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, deleteField, writeBatch, onSnapshot, getDoc, getDocs, query, where,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, terminate, clearIndexedDbPersistence, waitForPendingWrites
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import { leadViews } from '../shared-assets/lead-views-client.js';
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
// A local copy (IndexedDB) of what this page has read, shared by its tabs: the page draws at once
// from it, and a reload (or another tab) pays only for what changed. Where the browser cannot keep
// one (a private window, blocked storage) Firestore keeps it in memory, as before.
let db, persistent = true;
try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (e) { db = getFirestore(app); persistent = false; }
// Every lead from a few view documents instead of one read per lead (shared-assets/lead-views.js).
const views = leadViews(db);
// Signing out removes the local copy — nothing stays on a shared computer.
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
  seedPipelineIfEmpty(tenantId).catch(e => console.error('Track pipeline seed failed:', e));
  // The listeners start at once (this browser's local copy first, then the server) — they used to
  // wait for the seed read above, a server round trip before the board showed anything. The seed
  // only writes for a brand-new account, and the column listener picks that up.
  // includeMetadataChanges: told also when the local copy is confirmed by the server (nothing else
  // changed) — the board's automatic writers wait for that. A save's own echo is skipped.
  let listingsLive = null;
  onSnapshot(query(collection(db, 'listings'), where('tenantId', '==', tenantId)), { includeMetadataChanges: true },
    snap => {
      const live = !snap.metadata.fromCache;
      if (live === listingsLive && !snap.docChanges().length) return;
      listingsLive = live;
      if(window.applyListingsSnapshot) window.applyListingsSnapshot(snap.docs.map(d => d.data()), live);
    },
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
    snap => {
      if(window.applyTrackTeamSnapshot) window.applyTrackTeamSnapshot((snap.data() && snap.data().team) || {});
      // Settings → Configurations on this page (editors, deadlines, series, stage targets, tags).
      if(window.applyTrackConfigSnapshot) window.applyTrackConfigSnapshot((snap.data() && snap.data().trackConfig) || {});
    },
    err => console.error('Firestore team sync error:', err));

  // The leads, so a listing can name the owner who actually called in — every lead (which ones are
  // sellers is a client-side rule, see isSellerLead), from the lead views: a read per ~20 leads.
  views.watch(tenantId, (list, fromServer) => { if(window.applyTrackLeadsSnapshot) window.applyTrackLeadsSnapshot(list, fromServer); },
    err => console.error('Firestore leads sync error:', err));
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
  // Settings → Configurations. Each setting is replaced whole (a removed editor or stage target must
  // go), never the rest of the settings document; a tenant with no settings yet gets one.
  // keys: only those settings are written (trackConfig.<key>), so two people changing different
  // settings at once never overwrite each other.
  async saveTrackConfig(cfg, keys){
    if(!currentTenantId) throw new Error('No tenant');
    const ref = doc(db, 'settings', currentTenantId);
    const patch = keys && keys.length ? Object.fromEntries(keys.map(k => ['trackConfig.' + k, cfg[k]])) : { trackConfig: cfg };
    try { await updateDoc(ref, patch); }
    catch(e){ if(e && e.code === 'not-found') await setDoc(ref, { trackConfig: cfg }, { merge: true }); else throw e; }
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
    const allowed = ['listingId', 'propertyCodes', 'listingSkipped', 'listingCode'];
    const safe = {};
    for(const k of allowed) if(k in patch) safe[k] = patch[k];
    if(!Object.keys(safe).length) return;
    // An update, not a merge: a lead deleted in the CRM meanwhile is never brought back as a
    // fragment holding only these three fields.
    await views.save(currentTenantId, doc(db, 'leads', leadId), safe, 'update');
  },

  // A seller lead made from the board, when the property's owner is not in the CRM yet: the shape the
  // CRM's own Add Lead writes, already linked to this card, in the CRM's first column (its "new").
  async createLead(lead, historyEvent){
    if(!currentTenantId) throw new Error('No tenant');
    const p = await getDoc(doc(db, 'pipelines', currentTenantId)).catch(() => null);
    const stages = (p && p.exists() && p.data().stages) || [];
    const st = stages.find(s => s.key === 'new') || stages[0] || null;
    const out = { ...lead, tenantId: currentTenantId, stageId: st ? st.id : null };
    await views.save(currentTenantId, doc(db, 'leads', lead.id), out, 'replace');
    if(historyEvent) await setDoc(doc(db, 'leads', lead.id, 'history', historyEvent.id), historyEvent).catch(() => {});
    return out;
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
    return snap.docs.map(invRow);
  },
  // The inventory, live: read once, then only the properties that change (a brochure delivered,
  // a code added) — so every check that needs it is free, and a delivery shows within seconds.
  watchInventory(onList, onError){
    // Not signed in yet: said as a failure (after this returns), so the caller tries again later.
    if(!currentTenantId) { setTimeout(() => { if(onError) onError(new Error('not signed in yet')); }, 0); return () => {}; }
    // includeMetadataChanges: told when the saved copy is confirmed by the server (fromServer); a
    // confirmation with nothing new is passed on only once.
    let wasLive = null;
    return onSnapshot(query(collection(db, 'properties'), where('tenantId', '==', currentTenantId)), { includeMetadataChanges: true },
      snap => {
        const live = !snap.metadata.fromCache;
        if (live === wasLive && !snap.docChanges().length) return;
        wasLive = live;
        onList(snap.docs.map(invRow), live);
      }, onError);
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

// A dashboard property as this page uses it.
function invRow(d) {
  const p = d.data();
  return {
    id: d.id, propertyCode: p.propertyCode || d.id, name: p.name || '', location: p.location || '',
    config: p.config || '', startingPrice: p.startingPrice || '', type: p.type || '',
    photosLink: p.photosLink || '', brochureLink: p.brochureLink || '', detailsText: p.detailsText || '', soldOut: !!p.soldOut
  };
}

window.trackAuth = {
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  logout: () => signOutAndForget(auth),
  getTenantId: () => currentTenantId,
  getIdToken: () => auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null)
};

onAuthStateChanged(auth, async user => {
  if(user){
    // The token this browser already holds first: it carries the tenant claim, so the board starts
    // loading at once instead of after a round trip to Google on every open. Only a token WITHOUT
    // the claim is refreshed before going on (a claim set after this browser's last sign-in).
    try { currentTenantId = (await user.getIdTokenResult(false)).claims.tenantId || null; } catch(e) { currentTenantId = null; }
    if(!currentTenantId){
      try { currentTenantId = (await user.getIdTokenResult(true)).claims.tenantId || null; }
      catch(e){ console.error('Could not refresh the sign-in:', e); }
    } else {
      // A claim changed since (a tenant moved): checked in the background; the page reloads onto it.
      const held = currentTenantId;
      user.getIdTokenResult(true).then(r => {
        if(r && r.claims.tenantId !== held) location.reload();
      }).catch(() => {});
    }
    if(currentTenantId) subscribeToData(currentTenantId);
  } else {
    currentTenantId = null;
  }
  if(window.onTrackAuthChange) window.onTrackAuthChange(user, currentTenantId);
});
