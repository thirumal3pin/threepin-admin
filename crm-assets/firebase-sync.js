import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, getDoc, getDocs, writeBatch, query, where, deleteField,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, terminate, clearIndexedDbPersistence, waitForPendingWrites
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import { leadViews } from '../shared-assets/lead-views-client.js';
import { diffPaths, applyPaths } from '../shared-assets/lead-views.js';
import { isUntouchedCard } from '../track-assets/seller-sync.js';
// The board's own rule for "a card nobody worked on" (crm-assets/app.js markNotSeller).
window.isUntouchedCard = isUntouchedCard;
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
// A local copy (IndexedDB) of what this page has read, shared by its tabs: the page draws at once
// from it, and a reload (or another tab) pays only for what changed. Where the browser cannot keep
// one (a private window, blocked storage) Firestore keeps it in memory, as before.
let db, persistent = true;
try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (e) { db = getFirestore(app); persistent = false; }
// Every lead from a few view documents instead of one read per lead (shared-assets/lead-views.js).
const views = leadViews(db);
// Signing out removes the local copy — nothing of the CRM stays on a shared computer.
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
  // The listeners start at once — from this browser's local copy, then the server. They used to
  // wait for the three first-time seeds below: three server round trips before a single lead
  // showed (and, on a weak phone signal, much longer). The seeds only ever write for a brand-new
  // account, and the listeners pick up whatever they write.
  Promise.all([
    seedPipelineIfEmpty(tenantId).catch(e => console.error('Pipeline seed error:', e)),
    seedSampleLeadsIfEmpty(tenantId).catch(e => console.error('Sample leads seed error:', e)),
    seedSettingsIfEmpty(tenantId).catch(e => console.error('Settings seed error:', e))
  ]);
  // Every lead, live — from the lead views (a read per ~20 leads), or the leads themselves
  // until the views are built. fromServer: false while it is still this browser's local copy.
  views.watch(tenantId, (list, fromServer, info) => {
    // Each lead as it arrived, before the page touches it: a save sends only what differs —
    // against the very object being saved when it came from a snapshot (a screen that held it
    // across a wait compares with what IT was given, not with a newer copy).
    savedAs = new Map(list.map(l => { const j = JSON.stringify(l); savedFor.set(l, j); delivered.add(l.id); return [l.id, j]; }));
    if (window.applyLeadsSnapshot) window.applyLeadsSnapshot(list, fromServer, info);
  },
    err => console.error('Firestore leads sync error:', err));

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
    if (window.applyAutomationSettingsSnapshot) window.applyAutomationSettingsSnapshot(data.leadAutomation || {});
    if (window.applyViewsSnapshot) window.applyViewsSnapshot(data.views || {});
    if (window.applyTeamSnapshot) window.applyTeamSnapshot(data.team || {});
    // Shoot & Media's configuration — Daily task reads who makes the voice-overs.
    if (window.applyTrackTaskConfig) window.applyTrackTaskConfig(data.trackConfig || {});
    if (window.applyDefaultLeadAgent) window.applyDefaultLeadAgent(data.defaultLeadAgent || null);
    // The slug in TailorTalk's own dashboard URL
    // (dashboard.tailortalk.ai/<workspace>/leads). TailorTalk does not send
    // it with a lead, so it is configuration rather than data.
    if (window.applyTtWorkspaceSnapshot) window.applyTtWorkspaceSnapshot(data.tailortalkWorkspace || null);
  }, (err) => console.error('Firestore settings sync error:', err));
}

// Shoot & Media's cards and stages, read only, for Daily task's voice-overs (track-assets/voiceover.js).
// Watched from the first time Daily task is opened — not on every CRM page — and never written here.
let trackTasksWatched = false;
function watchTrackTasks(){
  if(trackTasksWatched || !currentTenantId) return;
  trackTasksWatched = true;
  onSnapshot(query(collection(db, 'listings'), where('tenantId', '==', currentTenantId)), (snap) => {
    if (window.applyTrackTaskListings) window.applyTrackTaskListings(snap.docs.map(d => ({ ...d.data(), id: d.id })));
  }, (err) => console.error('Firestore listings (Daily task) sync error:', err));
  onSnapshot(doc(db, 'trackPipelines', currentTenantId), (snap) => {
    if (window.applyTrackTaskStages) window.applyTrackTaskStages((snap.exists() && snap.data().stages) || []);
  }, (err) => console.error('Firestore track stages (Daily task) sync error:', err));
}

// The lead fields TailorTalk keeps current until someone edits them here (see
// api/_tailortalk-shared.js FOLLOW_FIELDS — the two lists must match).
const TT_FOLLOW_FIELDS = ['name', 'propertyInterest', 'budget', 'enquiryType'];
// Every lead as the last snapshot delivered it (JSON), the baseline a save is compared against —
// per lead id, and per lead object (WeakMap: the copy each object was handed). Updated as soon as a
// save is sent, so the next save compares with what was just saved.
let savedAs = new Map();
const savedFor = new WeakMap();
// Every lead id this page has ever been given. A save of one of these is an update, never a create:
// a lead deleted elsewhere meanwhile is refused, not brought back.
const delivered = new Set();
// What saveLead may write of a lead: never the server-owned parts (see saveLead).
function writable(lead) {
  const { notes, history, tt, ttState, ai, calendarEventId, calendarEventOwner, ...rest } = lead;
  if (tt) TT_FOLLOW_FIELDS.forEach(f => { if (!(lead.ttHold && lead.ttHold[f])) delete rest[f]; });
  return rest;
}

// A write that does not go through must not look as if it did: the page has already updated and
// often said "saved". On a quota-exhausted day every write fails. One warning per few seconds.
let lastSaveWarn = 0;
function saveFailed(what, e){
  console.error('Firestore ' + what + ' error:', e);
  if(Date.now() - lastSaveWarn < 5000 || !window.showToast) return;
  lastSaveWarn = Date.now();
  const why = e && e.code === 'resource-exhausted' ? "the database's limit for today is reached" : 'check your connection';
  window.showToast('⚠ Not saved — ' + why + '. Try again.');
}
window.crmFirebase = {
  // Notes + history live in per-lead subcollections now (see saveNote /
  // saveHistory below), so they are stripped from the parent write: the lead
  // doc stays small and constant-size, so a note-add never rewrites a growing
  // document and the board listener never streams note/history bodies.
  //
  // TailorTalk writes the same document from the server (api/tailortalk.js),
  // so this save must never carry a stale copy of what it wrote: `tt` is
  // stripped, a shared field is only sent once the team has taken it over
  // (ttHold), and the write merges instead of replacing the whole document.
  // `ai` is the lead automation's verdict (api/_lead-automation.js) — server-owned the same way;
  // the page changes only its suggestion/undo bookkeeping, through updateLeadAi().
  saveLead: (lead) => {
    // calendarEventId / calendarEventOwner are the server's (api/tailortalk.js books the visit): a page
    // re-sending its older copy would point the lead at an event that was replaced.
    const rest = writable(lead);
    if ('phone' in rest && typeof window.phoneKey === 'function') rest.phoneKey = window.phoneKey(rest.phone);
    const data = { ...rest, tenantId: currentTenantId };
    const ref = doc(db, 'leads', lead.id);
    // A lead the page received: only the fields this save changed, as an update — never the rest
    // of the page's copy (which may be older than what is saved), and never re-creating a lead
    // someone deleted meanwhile. A new lead: written whole. With its row in the lead views,
    // together (shared-assets/lead-views-client.js).
    const was = savedFor.get(lead) || savedAs.get(lead.id);
    let save;
    if (was || delivered.has(lead.id)) {
      const base = was ? JSON.parse(was) : {};
      const pairs = diffPaths(writable(base), data);
      const now = JSON.stringify(applyPaths(base, pairs));
      savedFor.set(lead, now); savedAs.set(lead.id, now);
      save = views.save(currentTenantId, ref, pairs, 'paths');
    } else {
      const now = JSON.stringify({ ...lead, ...data });
      savedFor.set(lead, now); savedAs.set(lead.id, now); delivered.add(lead.id);
      save = views.save(currentTenantId, ref, data, 'merge');
    }
    return save.catch(e => saveFailed('save lead', e));
  },
  // "Use TailorTalk's value": writes the value AND hands the field back to TailorTalk in one
  // update — saveLead() would drop the field again because it is no longer held.
  // Lead agent (and a secondary). Only these keys, so nothing else on the lead is rewritten.
  setLeadAgents: (leadId, patch) => views.save(currentTenantId, doc(db, 'leads', leadId), patch, 'update'),
  // "Not a seller": the lead's own fields, and its Property & Media card when that card is still
  // the empty one made automatically. A card someone has worked on is never deleted from here.
  setLeadFields: (leadId, patch) => views.save(currentTenantId, doc(db, 'leads', leadId), patch, 'update'),
  getListing: (id) => getDoc(doc(db, 'listings', id)).then(s => (s.exists() ? { id: s.id, ...s.data() } : null)),
  watchTrackTasks: () => watchTrackTasks(),
  deleteListing: (id) => deleteDoc(doc(db, 'listings', id)),
  releaseLeadField: (leadId, field, value) => {
    const patch = { [field]: value, ['ttHold.' + field]: false };
    return views.save(currentTenantId, doc(db, 'leads', leadId), patch, 'update')
      .catch(e => { console.error('Firestore release field error:', e); throw e; });
  },
  // Dotted paths only ('ai.suggestion', 'ai.dismissed.visit_pending', 'ai.lastMove') — the rest of
  // the AI's verdict is left exactly as the server wrote it.
  updateLeadAi: (leadId, fields) => {
    const safe = Object.fromEntries(Object.entries(fields).filter(([k]) => /^ai\.[A-Za-z_.]+$/.test(k)));
    if (!Object.keys(safe).length) return Promise.resolve();
    return views.save(currentTenantId, doc(db, 'leads', leadId), safe, 'update')
      .catch(e => console.error('Firestore AI field update error:', e));
  },
  saveAutomationSettings: ({ enabled }) => setDoc(settingsRef(currentTenantId), { leadAutomation: { enabled: !!enabled } }, { merge: true })
    .catch(e => console.error('Firestore save automation settings error:', e)),
  // Saved team views: settings.views.{id}. One dotted path per view, so two people saving
  // different views at the same moment never overwrite each other.
  saveView: (view) => updateDoc(settingsRef(currentTenantId), { ['views.' + view.id]: view })
    .catch(e => { console.error('Firestore save view error:', e); throw e; }),
  deleteView: (id) => updateDoc(settingsRef(currentTenantId), { ['views.' + id]: deleteField() })
    .catch(e => { console.error('Firestore delete view error:', e); throw e; }),
  // The inventory (properties collection) — read once, on first use, not kept live. The WHOLE
  // record: the visit invitation takes the seller's name and number from it, and the buyer
  // matching reads type, BHK, furnishing, facing, possession and more. It was trimmed to seven
  // fields, so invitations went out without the seller and matching worked half-blind. A failed
  // read is passed on (not turned into an empty list) so the pickers can say so.
  getInventory: () => getDocs(query(collection(db, 'properties'), where('tenantId', '==', currentTenantId)))
    .then(s => s.docs.map(d => { const p = d.data(); return { ...p, id: d.id, propertyCode: p.propertyCode || d.id, name: p.name || '', location: p.location || p.zone || '', config: p.config || '', startingPrice: p.startingPrice || '', soldOut: !!p.soldOut }; }))
    .catch(e => { console.error('Firestore inventory read error:', e); throw e; }),
  // TailorTalk's AI profile + conversation for one lead (one document, loaded on open).
  getLeadTailorTalk: (leadId) => getDoc(doc(db, 'leads', leadId, 'tailortalk', 'state'))
    .then(s => (s.exists() ? s.data() : null)),

  // Live subscription to one lead's conversation, held only while that lead is
  // open. getLeadTailorTalk above is a one-shot read that the CRM only repeated
  // when tt.lastEventAt changed on the parent lead — so anything that wrote the
  // chat without bumping that field (and the daily sync, which writes messages
  // in bulk) left the pane showing a stale conversation until the lead was
  // reopened. A listener sees the write itself, whatever caused it.
  // Returns its own unsubscribe.
  watchLeadTailorTalk: (leadId, cb) => onSnapshot(
    doc(db, 'leads', leadId, 'tailortalk', 'state'),
    s => cb(s.exists() ? s.data() : null, null),
    e => { console.error('Firestore watch tailortalk error:', e); cb(null, e); }
  ),
  deleteLead: (id) => views.save(currentTenantId, doc(db, 'leads', id), null, 'delete').catch(e => saveFailed('delete lead', e)),
  // Opening a lead re-checks its row in the views against the lead itself, in a transaction (1 read),
  // and puts the row right if anything ever made them differ — without waiting for the daily rebuild.
  // shown: the lead as this page has it. → 'same' · 'healed' · 'removed' · 'skipped' · 'failed'
  healLead: (id, shown) => views.heal(currentTenantId, id, shown),

  // ── Notes / history subcollections ──
  // since: only what was added after then (a lead opened again) — else all of it.
  getLeadNotes: (leadId, since) => getDocs(since ? query(collection(db, 'leads', leadId, 'notes'), where('createdAt', '>', since)) : collection(db, 'leads', leadId, 'notes'))
    // A failed read is passed on, never turned into "no notes": the page would show (and count) none.
    .then(s => s.docs.map(d => d.data()))
    .catch(e => { console.error('Firestore get notes error:', e); throw e; }),
  getLeadHistory: (leadId, since) => getDocs(since ? query(collection(db, 'leads', leadId, 'history'), where('at', '>', since)) : collection(db, 'leads', leadId, 'history'))
    .then(s => s.docs.map(d => d.data()))
    .catch(e => { console.error('Firestore get history error:', e); throw e; }),
  saveNote: (leadId, note) => setDoc(doc(db, 'leads', leadId, 'notes', note.id), note).catch(e => saveFailed('save note', e)),
  deleteNoteDoc: (leadId, noteId) => deleteDoc(doc(db, 'leads', leadId, 'notes', noteId)).catch(e => saveFailed('delete note', e)),
  saveHistory: (leadId, event) => setDoc(doc(db, 'leads', leadId, 'history', event.id), event).catch(e => saveFailed('save history', e)),

  savePipeline: (stages) => setDoc(pipelineRef(currentTenantId), { stages }).catch(e => console.error('Firestore save pipeline error:', e)),
  getBotConfig: async () => {
    if (!currentTenantId) return null;
    const snap = await getDoc(whatsappBotRef(currentTenantId));
    return snap.exists() ? snap.data() : null;
  },
  saveBotConfig: (config) => setDoc(whatsappBotRef(currentTenantId), config, { merge: true }),
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
  logout: () => signOutAndForget(auth),
  getIdToken: () => auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null),
  getTenantId: () => currentTenantId
};

onAuthStateChanged(auth, async (user) => {
  if(user){
    // The token this browser already holds first: it carries the tenant claim, so the data starts
    // loading at once instead of after a round trip to Google on every page open (on a phone,
    // a second or more before anything showed). Only a token WITHOUT the claim is refreshed before
    // going on — a claim set after this browser's last sign-in (scripts/create-tenant.js,
    // scripts/migrate-existing-tenant.js) is then picked up immediately, as before.
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
    } else {
      subscribeToData(currentTenantId);
    }
  } else {
    currentTenantId = null;
    subscribed = false;
  }
  if (window.onCrmAuthChange) window.onCrmAuthChange(user);
});
