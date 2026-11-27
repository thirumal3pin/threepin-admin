import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, getDoc, getDocs, writeBatch, query, where, deleteField,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, terminate, clearIndexedDbPersistence, waitForPendingWrites
} from "../shared-assets/fs-metered.js";
import { leadViews } from '../shared-assets/lead-views-client.js';
import { canWorkLead } from '../shared-assets/agent-access.js';
import { diffPaths, applyPaths } from '../shared-assets/lead-views.js';
import { isUntouchedCard } from '../track-assets/seller-sync.js';
import * as TaskModel from '../shared-assets/task-model.js';
// The board's own rule for "a card nobody worked on" (crm-assets/app.js markNotSeller).
window.isUntouchedCard = isUntouchedCard;
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import { quietWhenAway } from '../shared-assets/quiet-when-away.js';

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
// A page nobody is looking at stops reading (shared-assets/quiet-when-away.js — the quota).
quietWhenAway(db);
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
let currentRole = '';     // the agent-layer role claim: '' (full access), 'admin' or 'agent'
// Reads filtered by tenant wait for the sign-in to say which tenant. Asked before that (the
// Campaigns screen asks for the inventory as the page loads), a query on a null tenant matches
// nothing, and the CRM kept that empty property list for the rest of the session.
let tenantWaiters = [];
const whenTenant = () => currentTenantId ? Promise.resolve(currentTenantId) : new Promise(r => tenantWaiters.push(r));
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
  if (currentRole === 'agent') { subscribeAsAgent(tenantId); return; }
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

// ═══════ AGENT MODE (the agent layer) ═══════
// An agent's CRM shows only their leads: assigned to them, as the secondary agent, or reached
// through the agent layer (agentAccess — enquiries on their properties, a lead approved for them).
// Those are the three queries firestore.rules allow an agent; the packed lead views are not theirs
// to read. Every change they make goes to the server (/api/agent), which checks each field and keeps
// the lead views in step for everyone else. The team settings come from the server too, without the
// rest of settings/{tenant}.
async function agentApi(action, body){
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  const r = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ action, ...body }) });
  let j = {};
  try { j = await r.json(); } catch (e) { j = {}; }
  if (!r.ok || j.ok === false) { const err = new Error(j.error || ('HTTP ' + r.status)); err.status = r.status; err.body = j; throw err; }
  return j;
}
function agentRefused(what){
  if (window.showToast) window.showToast(what || 'Not part of your access — ask an admin');
  return Promise.resolve();
}
// What an agent's CRM leaves out: the team's settings menus, the AI bot, Eåsy (it reads the whole
// tenant), deleting a lead and choosing a lead's agent. The server refuses all of it anyway; this
// only spares them buttons that would say no.
function agentChrome(){
  if (document.getElementById('agentModeCss')) return;
  document.documentElement.classList.add('agent-mode');
  const st = document.createElement('style');
  st.id = 'agentModeCss';
  st.textContent = ['openStageManager', 'openDigestManager', 'openDashboardEmailManager', 'openBotEditor', 'runBackfillSummaries', 'runTailorTalkSync', 'deleteLead']
    .map(f => `.agent-mode [onclick^="${f}"]`).join(',') + ',.agent-mode #autoBtn,.agent-mode #easyBtn,.agent-mode .easy-fab,.agent-mode .easy-panel{display:none!important}'
    + '.agent-mode #dpAgents select{pointer-events:none;appearance:none;-webkit-appearance:none;border-style:solid;background-image:none}'
    + '.agent-mode .agent-only-note{display:block}';
  document.head.appendChild(st);
  // Download only when the admin allows it (agent settings → Download or copy their lists).
  const exportBtn = () => document.querySelector('[onclick^="openExportModal"]');
  const apply = a => { const b = exportBtn(); if (b && a && a.config && a.config.actions) b.style.display = a.config.actions.exportOwn ? '' : 'none'; };
  if (window.PinAccess) apply(window.PinAccess);
  document.addEventListener('pin-access', e => apply(e.detail));
}
// Which of an agent's leads they can only read: canWorkLead (shared-assets/agent-access.js), the
// server's own test — their own leads and the enquiries on their properties (even ones the office
// holds) are theirs to work; a lead opened to them by an approved request is theirs to read.
const readOnlyIds = new Set();
// A lead another agent's request approval opened to this agent: until when (0 = no limit).
const sharedUntil = new Map();
const canWork = (l, me) => canWorkLead(l, me);
function subscribeAsAgent(tenantId){
  agentChrome();
  const me = signedInEmail();
  const parts = { a: [], b: [], c: [], g: [] };
  // g: the leads opened by approved requests have arrived too (a ?lead= link to one must not give up
  // before they are in).
  const fromServer = { a: false, b: false, c: false, g: false };
  const push = () => {
    const by = new Map();
    [...parts.a, ...parts.b, ...parts.c, ...parts.g].forEach(l => by.set(l.id, l));
    const list = [...by.values()];
    readOnlyIds.clear();
    list.forEach(l => { if (!canWork(l, me)) readOnlyIds.add(l.id); });
    savedAs = new Map(list.map(l => { const j = JSON.stringify(l); savedFor.set(l, j); delivered.add(l.id); return [l.id, j]; }));
    if (window.applyLeadsSnapshot) window.applyLeadsSnapshot(list, fromServer.a && fromServer.b && fromServer.c && fromServer.g, null);
  };
  [['a', where('assignedAgent', '==', me)], ['b', where('secondaryAgent', '==', me)], ['c', where('agentAccess', 'array-contains', me)]].forEach(([k, w]) => {
    onSnapshot(query(leadsCol, where('tenantId', '==', tenantId), w), snap => {
      parts[k] = snap.docs.map(d => ({ ...d.data(), id: d.id }));
      if (!snap.metadata.fromCache) fromServer[k] = true;
      push();
    }, err => console.error('Firestore agent leads (' + k + ') error:', err));
  });
  // Leads opened to the agent by an approved request: one document each, while its grant runs (the
  // rules check the grant on every read). Read-only.
  const grantLeads = new Map();   // leadId → unsubscribe
  const grantTimers = new Map();  // leadId → the timer that closes it when its grant runs out
  const grantArrived = new Set();
  let grantsLive = false;
  const grantsReady = () => { fromServer.g = grantsLive && [...grantLeads.keys()].every(id => grantArrived.has(id)); };
  onSnapshot(query(collection(db, 'grants'), where('tenantId', '==', tenantId), where('agentEmail', '==', me), where('kind', '==', 'lead'), where('active', '==', true)), snap => {
    const now = Date.now();
    if (!snap.metadata.fromCache) grantsLive = true;
    const live = snap.docs.map(d => d.data()).filter(g => !g.expiresAt || g.expiresAt > now);
    const want = new Set(live.map(g => String(g.targetId)));
    sharedUntil.clear(); live.forEach(g => sharedUntil.set(String(g.targetId), g.expiresAt || 0));
    // Each one leaves the page the minute its timer ends (the server switches it off too).
    live.forEach(g => { if (g.expiresAt && !grantTimers.has(String(g.targetId))) grantTimers.set(String(g.targetId), setTimeout(() => {
      const id = String(g.targetId); grantTimers.delete(id);
      const un = grantLeads.get(id); if (un) un(); grantLeads.delete(id); grantArrived.delete(id);
      parts.g = parts.g.filter(l => l.id !== id); push();
    }, Math.min(g.expiresAt - now + 500, 2147000000))); });
    for (const [id, un] of grantLeads) if (!want.has(id)) { un(); grantLeads.delete(id); grantArrived.delete(id); parts.g = parts.g.filter(l => l.id !== id); }
    want.forEach(id => {
      if (grantLeads.has(id)) return;
      grantLeads.set(id, onSnapshot(doc(db, 'leads', id), s => {
        parts.g = parts.g.filter(l => l.id !== id);
        if (s.exists()) parts.g.push({ ...s.data(), id: s.id });
        grantArrived.add(id); grantsReady();
        push();
      }, () => { parts.g = parts.g.filter(l => l.id !== id); grantArrived.add(id); grantsReady(); push(); }));
    });
    grantsReady();
    push();
  }, err => { console.error('Firestore agent grants error:', err); grantsLive = true; grantsReady(); push(); });
  onSnapshot(pipelineRef(tenantId), (snap) => {
    if (snap.exists() && window.applyPipelineSnapshot) window.applyPipelineSnapshot(snap.data().stages || []);
  }, (err) => console.error('Firestore pipeline sync error:', err));
  agentApi('crm-boot').then(d => {
    if (window.applyEnquiryTypesSnapshot) window.applyEnquiryTypesSnapshot(d.enquiryTypes || DEFAULT_ENQUIRY_TYPES);
    if (window.applyTeamSnapshot) window.applyTeamSnapshot(d.team || {});
    if (window.applyTtWorkspaceSnapshot) window.applyTtWorkspaceSnapshot(d.tailortalkWorkspace || null);
    if (window.applyDefaultLeadAgent) window.applyDefaultLeadAgent(me);
    if (window.applyViewsSnapshot) window.applyViewsSnapshot({});
    if (window.applyAutomationSettingsSnapshot) window.applyAutomationSettingsSnapshot({});
  }).catch(e => console.error('CRM settings for an agent:', e));
}
// A save from an agent's page: the changed fields (or the whole new lead) to the server.
function agentSaveLead(lead, data){
  const was = savedFor.get(lead) || savedAs.get(lead.id);
  if ((was || delivered.has(lead.id)) && readOnlyIds.has(lead.id)) {
    // Read only: the page's change is put back as the server has it, and said once.
    if (was) { const base = JSON.parse(was); Object.keys(lead).forEach(k => { if (!(k in base) && k !== 'notes' && k !== 'history') delete lead[k]; }); Object.assign(lead, base); }
    if (window.showToast) window.showToast('🔒 Read only — this lead is with another agent. Use “Message team” to talk to them.');
    if (typeof window.refreshAll === 'function') window.refreshAll();
    return Promise.resolve();
  }
  if (was || delivered.has(lead.id)) {
    const base = was ? JSON.parse(was) : {};
    const pairs = diffPaths(writable(base), data).filter(([seg]) => seg[0] !== 'tenantId');
    if (!pairs.length) return Promise.resolve();
    const now = JSON.stringify(applyPaths(base, pairs));
    savedFor.set(lead, now); savedAs.set(lead.id, now);
    return agentApi('lead-save', { id: lead.id, pairs }).then(r => {
      // Fields an agent may not change (the number, who the lead belongs to): said, not swallowed.
      if (r && r.refused && r.refused.length && window.showToast) {
        window.showToast(r.refused.includes('phone') ? '⚠ A phone number is changed by an admin — the rest is saved' : '⚠ Some of this is not yours to change — the rest is saved');
      }
    }).catch(e => {
      // Not saved: the page's copy is put back as the server has it, so the next save sends this
      // change again instead of believing it went.
      savedFor.set(lead, was || JSON.stringify(base)); savedAs.set(lead.id, was || JSON.stringify(base));
      if (e && e.body && e.body.readOnly && window.showToast) { window.showToast('⚠ ' + e.message); return; }
      saveFailed('save lead', e);
    });
  }
  // A new lead: the server checks the number against the whole team first.
  return agentApi('lead-add', { lead: { ...data, id: lead.id } }).then(r => {
    savedAs.set(lead.id, JSON.stringify({ ...lead, ...data })); delivered.add(lead.id);
    return r;
  }).catch(e => {
    if (window.agentLeadRefused) window.agentLeadRefused(lead.id, e.message, e.body || {});
    else if (window.showToast) window.showToast('⚠ ' + e.message);
    // Never settles: whatever the page meant to do once the lead was saved (its first note, its
    // history line) must not run for a lead that was not added.
    return new Promise(() => {});
  });
}
const agentPatch = (leadId, patch) => agentApi('lead-save', { id: leadId, data: patch }).catch(e => saveFailed('save lead', e));
// The agent's own copy of the properties, for the CRM's pickers and matching: what their settings
// let them see, never the whole inventory.
async function agentInventory(){
  const tid = await whenTenant();
  await agentApi('view').catch(() => {});
  const s = await getDoc(doc(db, 'agentViews', tid + '__' + auth.currentUser.uid));
  const props = s.exists() ? (s.data().props || []) : [];
  return props.map(p => ({ ...p, propertyCode: p.propertyCode || p._code || p.id, name: p.name || '', location: p.location || p.zone || '', config: p.config || '', startingPrice: p.startingPrice || '', soldOut: !!p.soldOut }));
}
const isAgentMode = () => currentRole === 'agent';

// ═══════ TASKS (shared-assets/task-model.js holds the rules) ═══════
// The configuration first (who manages, who sees whose), then the tasks this person may see: a
// manager every task of the tenant, anyone else the tasks whose visibleTo carries their key —
// exactly the two shapes of query the Firestore rules allow. A change in the configuration
// (someone made a manager, or let see another's tasks) re-opens the right query.
let tasksUnsub = null, tasksMode = null, taskCfgWatched = false, taskCfg = null;
function signedInEmail(){ return (auth.currentUser && auth.currentUser.email || '').toLowerCase(); }
function watchTasksQuery(mode){
  if(mode === tasksMode && tasksUnsub) return;
  if(tasksUnsub){ try { tasksUnsub(); } catch (e) {} tasksUnsub = null; }
  tasksMode = mode;
  const me = signedInEmail();
  if(!me || !currentTenantId) return;
  // An agent may read only the tasks assigned to them (firestore.rules), so theirs is that query.
  const q = mode === 'all'
    ? query(collection(db, 'tasks'), where('tenantId', '==', currentTenantId))
    : currentRole === 'agent'
      ? query(collection(db, 'tasks'), where('tenantId', '==', currentTenantId), where('assignees', 'array-contains', me))
      : query(collection(db, 'tasks'), where('visibleTo', 'array-contains', TaskModel.visKey(currentTenantId, me)));
  tasksUnsub = onSnapshot(q, snap => {
    if (window.applyTasksSnapshot) window.applyTasksSnapshot(snap.docs.map(d => ({ ...d.data(), id: d.id })), mode, null, snap.metadata.fromCache);
  }, err => {
    // Not a manager after all (the configuration says otherwise on the server): the person's own.
    if (mode === 'all' && err && err.code === 'permission-denied') { tasksUnsub = null; watchTasksQuery('mine'); return; }
    console.error('Firestore tasks sync error:', err);
    if (window.applyTasksSnapshot) window.applyTasksSnapshot(null, mode, err);
  });
}
function watchTasks(){
  if(taskCfgWatched || !currentTenantId) return;
  taskCfgWatched = true;
  onSnapshot(doc(db, 'taskConfigs', currentTenantId), snap => {
    taskCfg = snap.exists() ? snap.data() : null;
    if (window.applyTaskConfig) window.applyTaskConfig(taskCfg);
    watchTasksQuery(TaskModel.isManager(taskCfg, signedInEmail()) ? 'all' : 'mine');
  }, err => {
    console.error('Firestore task configuration sync error:', err);
    if (window.applyTaskConfig) window.applyTaskConfig(null);
    watchTasksQuery('mine');
  });
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
  // An agent's login (their own copy of the properties, requests through the server).
  isAgent: () => isAgentMode(),
  agentAction: (action, body) => agentApi(action, body),
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
    if (isAgentMode()) return agentSaveLead(lead, data);
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
  setLeadAgents: (leadId, patch) => isAgentMode() ? agentRefused('Only admins choose a lead’s agent') : views.save(currentTenantId, doc(db, 'leads', leadId), patch, 'update'),
  // "Not a seller": the lead's own fields, and its Property & Media card when that card is still
  // the empty one made automatically. A card someone has worked on is never deleted from here.
  setLeadFields: (leadId, patch) => isAgentMode() ? agentPatch(leadId, patch) : views.save(currentTenantId, doc(db, 'leads', leadId), patch, 'update'),
  getListing: (id) => getDoc(doc(db, 'listings', id)).then(s => (s.exists() ? { id: s.id, ...s.data() } : null)),
  watchTrackTasks: () => isAgentMode() ? undefined : watchTrackTasks(),
  deleteListing: (id) => deleteDoc(doc(db, 'listings', id)),
  releaseLeadField: (leadId, field, value) => {
    const patch = { [field]: value, ['ttHold.' + field]: false };
    if (isAgentMode()) return agentPatch(leadId, patch);
    return views.save(currentTenantId, doc(db, 'leads', leadId), patch, 'update')
      .catch(e => { console.error('Firestore release field error:', e); throw e; });
  },
  // Dotted paths only ('ai.suggestion', 'ai.dismissed.visit_pending', 'ai.lastMove') — the rest of
  // the AI's verdict is left exactly as the server wrote it.
  updateLeadAi: (leadId, fields) => {
    const safe = Object.fromEntries(Object.entries(fields).filter(([k]) => /^ai\.[A-Za-z_.]+$/.test(k)));
    if (!Object.keys(safe).length) return Promise.resolve();
    if (isAgentMode()) return agentPatch(leadId, safe);
    return views.save(currentTenantId, doc(db, 'leads', leadId), safe, 'update')
      .catch(e => console.error('Firestore AI field update error:', e));
  },
  saveAutomationSettings: ({ enabled }) => isAgentMode() ? agentRefused() : setDoc(settingsRef(currentTenantId), { leadAutomation: { enabled: !!enabled } }, { merge: true })
    .catch(e => console.error('Firestore save automation settings error:', e)),
  // Saved team views: settings.views.{id}. One dotted path per view, so two people saving
  // different views at the same moment never overwrite each other.
  saveView: (view) => isAgentMode() ? Promise.reject(new Error('Saved views are for the team')) : updateDoc(settingsRef(currentTenantId), { ['views.' + view.id]: view })
    .catch(e => { console.error('Firestore save view error:', e); throw e; }),
  deleteView: (id) => isAgentMode() ? Promise.reject(new Error('Saved views are for the team')) : updateDoc(settingsRef(currentTenantId), { ['views.' + id]: deleteField() })
    .catch(e => { console.error('Firestore delete view error:', e); throw e; }),
  // The inventory (properties collection) — read once, on first use, not kept live. The WHOLE
  // record: the visit invitation takes the seller's name and number from it, and the buyer
  // matching reads type, BHK, furnishing, facing, possession and more. It was trimmed to seven
  // fields, so invitations went out without the seller and matching worked half-blind. A failed
  // read is passed on (not turned into an empty list) so the pickers can say so.
  getInventory: () => isAgentMode() ? agentInventory().catch(e => { console.error('Agent inventory read error:', e); throw e; }) : whenTenant().then(tid => getDocs(query(collection(db, 'properties'), where('tenantId', '==', tid))))
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
  deleteLead: (id) => isAgentMode() ? agentRefused('Ask an admin to delete a lead') : views.save(currentTenantId, doc(db, 'leads', id), null, 'delete').catch(e => saveFailed('delete lead', e)),
  // Opening a lead re-checks its row in the views against the lead itself, in a transaction (1 read),
  // and puts the row right if anything ever made them differ — without waiting for the daily rebuild.
  // shown: the lead as this page has it. → 'same' · 'healed' · 'removed' · 'skipped' · 'failed'
  healLead: (id, shown) => isAgentMode() ? Promise.resolve('skipped') : views.heal(currentTenantId, id, shown),

  // ── Notes / history subcollections ──
  // since: only what was added after then (a lead opened again) — else all of it.
  getLeadNotes: (leadId, since) => getDocs(since ? query(collection(db, 'leads', leadId, 'notes'), where('createdAt', '>', since)) : collection(db, 'leads', leadId, 'notes'))
    // A failed read is passed on, never turned into "no notes": the page would show (and count) none.
    .then(s => s.docs.map(d => d.data()))
    .catch(e => { console.error('Firestore get notes error:', e); throw e; }),
  getLeadHistory: (leadId, since) => getDocs(since ? query(collection(db, 'leads', leadId, 'history'), where('at', '>', since)) : collection(db, 'leads', leadId, 'history'))
    .then(s => s.docs.map(d => d.data()))
    .catch(e => { console.error('Firestore get history error:', e); throw e; }),
  saveNote: (leadId, note) => isAgentMode() ? (readOnlyIds.has(leadId) ? Promise.resolve() : agentApi('lead-note', { id: leadId, note }).catch(e => saveFailed('save note', e))) : setDoc(doc(db, 'leads', leadId, 'notes', note.id), note).catch(e => saveFailed('save note', e)),
  deleteNoteDoc: (leadId, noteId) => isAgentMode() ? (readOnlyIds.has(leadId) ? Promise.resolve() : agentApi('lead-note-delete', { id: leadId, noteId }).catch(e => saveFailed('delete note', e))) : deleteDoc(doc(db, 'leads', leadId, 'notes', noteId)).catch(e => saveFailed('delete note', e)),
  saveHistory: (leadId, event) => isAgentMode() ? (readOnlyIds.has(leadId) ? Promise.resolve() : agentApi('lead-history', { id: leadId, event }).catch(e => saveFailed('save history', e))) : setDoc(doc(db, 'leads', leadId, 'history', event.id), event).catch(e => saveFailed('save history', e)),

  savePipeline: (stages) => isAgentMode() ? agentRefused() : setDoc(pipelineRef(currentTenantId), { stages }).catch(e => console.error('Firestore save pipeline error:', e)),
  getBotConfig: async () => {
    if (!currentTenantId || isAgentMode()) return null;
    const snap = await getDoc(whatsappBotRef(currentTenantId));
    return snap.exists() ? snap.data() : null;
  },
  saveBotConfig: (config) => isAgentMode() ? agentRefused() : setDoc(whatsappBotRef(currentTenantId), config, { merge: true }),
  saveEnquiryTypes: (enquiryTypes) => isAgentMode() ? agentRefused() : setDoc(settingsRef(currentTenantId), { enquiryTypes }, { merge: true }).catch(e => console.error('Firestore save enquiry types error:', e)),
  // The curated property list behind the Add Lead combobox. Leads already in
  // the CRM contribute their properties client-side; this doc is what makes a
  // brand-new property selectable before its first lead exists.
  saveProperties: (properties) => isAgentMode() ? Promise.resolve() : setDoc(settingsRef(currentTenantId), { properties }, { merge: true }).catch(e => console.error('Firestore save properties error:', e)),
  saveFollowupDigestSettings: (enabled, recipients, emailEnabled, emails) => isAgentMode() ? agentRefused() : setDoc(settingsRef(currentTenantId), {
    followupDigestEnabled: enabled,
    followupDigestRecipients: recipients,
    followupDigestEmailEnabled: emailEnabled,
    followupDigestEmails: emails
  }, { merge: true }).catch(e => console.error('Firestore save digest settings error:', e)),
  saveDashboardEmailSettings: (enabled, recipients) => isAgentMode() ? agentRefused() : setDoc(settingsRef(currentTenantId), {
    dashboardEmailEnabled: enabled,
    dashboardEmailRecipients: recipients
  }, { merge: true }).catch(e => console.error('Firestore save dashboard email settings error:', e))
};

// Tasks: a new task is written whole; a change writes only the fields that changed, so a person a
// task is assigned to never "touches" the fields the rules keep for the managers.
window.crmTasks = {
  create: (task) => setDoc(doc(db, 'tasks', task.id), { ...task, tenantId: currentTenantId }),
  update: (id, patch) => updateDoc(doc(db, 'tasks', id), { ...patch, tenantId: currentTenantId }),
  remove: (id) => deleteDoc(doc(db, 'tasks', id)),
  // The emails go from the server, which re-reads the task and decides who gets one; this only says
  // what happened. Never throws: a task that saved is saved, whether or not the email went.
  notify: async (id, event, extra) => {
    try {
      const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
      if (!token) return { ok: false, error: 'not signed in' };
      const res = await fetch('/api/followup-digest?action=task', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, event, ...(extra || {}) })
      });
      return res.ok ? await res.json() : { ok: false, error: 'HTTP ' + res.status };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  },
  config: () => taskCfg,
  tenantId: () => currentTenantId
};

// Daily task: when this person opened each row (crm-assets/today.js). One small document per person,
// apart from the leads, so opening a row never rewrites a lead or wakes the board. Read once, written
// whole — the page merges what it read before it writes. Until the todayOpens rule is live the read
// and the write are refused, and the page keeps the record on the device alone.
const todayOpensRef = () => (auth.currentUser && currentTenantId) ? doc(db, 'todayOpens', currentTenantId + '__' + auth.currentUser.uid) : null;
window.crmTodayOpens = {
  load: async () => {
    const ref = todayOpensRef();
    if (!ref) return null;
    const snap = await getDoc(ref);
    return snap.exists() ? (snap.data().opens || {}) : {};
  },
  save: (opens) => {
    const ref = todayOpensRef();
    if (!ref) return Promise.resolve();
    return setDoc(ref, { tenantId: currentTenantId, email: auth.currentUser.email || '', opens, updatedAt: Date.now() });
  }
};

window.crmAuth = {
  login: (email, password) => signInWithEmailAndPassword(auth, email, password),
  logout: () => signOutAndForget(auth),
  getIdToken: () => auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null),
  getTenantId: () => currentTenantId,
  getRole: () => currentRole
};
window.crmFirebase.isReadOnly = id => isAgentMode() && readOnlyIds.has(id);
// Shared with this agent by an approved request (read only): { until } (0 = no limit), else null.
window.crmFirebase.sharedLead = id => (isAgentMode() && readOnlyIds.has(id) && sharedUntil.has(String(id)) ? { until: sharedUntil.get(String(id)) } : null);

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
    currentRole = (tokenResult && tokenResult.claims.role) || '';
    if (!currentTenantId) {
      console.error('This account has no tenantId claim yet — contact support to finish onboarding.');
    } else {
      subscribeToData(currentTenantId);
      watchTasks();
      tenantWaiters.splice(0).forEach(r => r(currentTenantId));
    }
  } else {
    currentTenantId = null;
    subscribed = false;
  }
  if (window.onCrmAuthChange) window.onCrmAuthChange(user);
});
