// ═══════ THE AGENT LAYER — the work (phases 2–6) ═══════
//
// Reached through POST /api/agent (api/_agent.js routes every action not about logins here).
// Everything an agent sees of properties and of other people's leads is built HERE, from the admin's
// settings (shared-assets/agent-config.js) and the rules in shared-assets/agent-access.js, and
// written to the agent's own copy, agentViews/{tenant}__{uid} — the only property data an agent can
// read (firestore.rules). Every change an agent makes to a property or a lead comes through here
// too, so it is checked against what they may touch, and the lead views stay in step.
//
// Agent actions (role agent; admins and full-access staff may call most of them too)
//   view               my copy, rebuilt when it is older than 10 minutes, the settings changed, a
//                      grant ran out — or force (at most once a minute)
//   directory          the team: name, email, role (for Messages and "who to ask")
//   crm-boot           what the CRM needs of the team settings, without the rest of settings/{tid}
//   property-notes     { id } the notes of a property I may see in full (and my settings show notes)
//   property-note      { id, text } add a note to my own property            (editOwnProperties)
//   property-availability { id, availability }  on my own property            (editOwnProperties)
//   property-submit    { fields } a property I sourced, for an admin to approve (addProperties)
//   lead-save          { id, mode, pairs | data } a change to a lead I work
//   lead-note          { id, note } · lead-note-delete { id, noteId } · lead-history { id, event }
//   lead-add           { lead } a new lead (duplicate check across the whole team) (addLeads)
//   request            { kind: 'property' | 'lead', targetId | ref, clientLeadId, reason, visitAt }
//   decide             { id, decision: 'approve' | 'reject', days | until, shareContact, hours |
//                        contactUntil, coAgent, note } — first decision wins (transaction)
//   cancel             { id } my own pending request
//   thread-open        { type, linkedId, title, members } open (or make) a Messages thread
// Staff and admin actions (refused to agents)
//   assign             { propertyId, primary, coAgents } one primary, any number of co-agents
//   property-access    { id } who else has this property's details, requests, agent history
// Admin actions
//   revoke             { grantId, reason } · hide-contact { grantId }
//   submission-decide  { id, decision, note }
//   rebuild            { email? } rebuild one agent's copy, or every agent's
//
// Reads are kept low (the project is on Firebase's free plan): a rebuild reads the properties
// (~160) and the leads through the lead views (~75 documents), and runs at most every 10 minutes
// per agent while they use the site.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from './_bot-shared.js';
import { writeLead, readLeads } from './_lead-views.js';
import * as AA from '../shared-assets/agent-access.js';
import { effectiveConfig, maskPhones } from '../shared-assets/agent-config.js';
import '../dashboard-assets/search-engine.js';
import '../shared-assets/chennai-geo.js';
import '../shared-assets/area-model.js';
import '../shared-assets/match-engine.js';

const PinMatch = globalThis.PinMatch;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const lc = AA.lc;
const STALE_MS = 10 * 60 * 1000;
const FORCE_MS = 60 * 1000;
const VIEW_TTL = 7 * 86400000;     // a copy nobody rebuilt for a week stops opening (rules)
const MAX_TEXT = 2000;

// ── Who is on the team (Auth + users/{uid} names), cached a minute per warm server ──
const teamCache = new Map();
let teamSource = null;   // tests only: the team without Firebase Auth
export const __setTeamSource = fn => { teamSource = fn; teamCache.clear(); };
export async function teamOf(db, tenantId, fresh = false) {
  if (teamSource) return teamSource(tenantId);
  const c = teamCache.get(tenantId);
  if (!fresh && c && Date.now() - c.at < 60000) return c.list;
  const auth = getAuth();
  const all = [];
  let token;
  do { const page = await auth.listUsers(1000, token); all.push(...page.users); token = page.pageToken; } while (token);
  const mine = all.filter(u => (u.customClaims || {}).tenantId === tenantId && u.email);
  const profiles = mine.length ? await db.getAll(...mine.map(u => db.collection('users').doc(u.uid))) : [];
  const nameOf = {};
  profiles.forEach(d => { if (d.exists) nameOf[d.id] = d.data().name || ''; });
  const list = mine.map(u => ({
    uid: u.uid, email: lc(u.email), role: (u.customClaims || {}).role || 'none',
    active: !u.disabled, verified: !!u.emailVerified,
    name: nameOf[u.uid] || u.displayName || lc(u.email).split('@')[0],
  }));
  teamCache.set(tenantId, { at: Date.now(), list });
  return list;
}
export const adminsOf = team => team.filter(u => u.role === 'admin' && u.active && u.verified).map(u => u.email);
const nameIn = (team, email) => { const u = team.find(x => x.email === lc(email)); return u ? u.name : (lc(email).split('@')[0] || ''); };

async function loadConfig(db, tenantId) {
  const s = await db.collection('agentConfigs').doc(tenantId).get();
  return s.exists ? s.data() : null;
}
async function loadProperties(db, tenantId) {
  const q = await db.collection('properties').where('tenantId', '==', tenantId).get();
  return q.docs.map(d => ({ ...d.data(), id: d.id }));
}
async function loadGrants(db, tenantId) {
  const q = await db.collection('grants').where('tenantId', '==', tenantId).where('active', '==', true).get();
  return q.docs.map(d => ({ ...d.data(), id: d.id }));
}
async function getProperty(db, tenantId, id) {
  if (!id || typeof id !== 'string' || id.includes('/')) return null;
  const s = await db.collection('properties').doc(id).get();
  if (!s.exists || s.data().tenantId !== tenantId) return null;
  return { ...s.data(), id: s.id };
}

// A matching lead is named to an agent who does not work it by an opaque reference, never its id
// (a TailorTalk lead's id carries the client's phone number). Keyed with a server-only secret.
function refSecret() {
  if (process.env.AGENT_REF_SECRET) return process.env.AGENT_REF_SECRET;
  try { const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}'); if (sa.private_key) return createHash('sha256').update(sa.private_key).digest('hex'); } catch { /* below */ }
  return 'pin-agent-ref-dev';
}
export const leadRef = (tenantId, leadId) => 'm' + createHmac('sha256', refSecret()).update(tenantId + '|' + leadId).digest('hex').slice(0, 20);

// ── An agent's copy ──
const viewId = (tenantId, uid) => `${tenantId}__${uid}`;

// Who reaches which lead through the agent layer, written on the lead (agentAccess) where it
// changed. The rules let an agent read a lead whose assignedAgent, secondaryAgent or agentAccess
// names them; reassigning a property moves its enquiries with it here.
export async function syncLeadAccess(db, tenantId, { properties, leads, grants }) {
  const byCode = AA.agentsByCodeOf(properties);
  const leadGrants = (grants || []).filter(g => g.kind === 'lead');
  let changed = 0;
  for (const l of leads) {
    const want = AA.leadAccessFor(l, byCode, leadGrants);
    const have = (Array.isArray(l.agentAccess) ? l.agentAccess : []).map(lc).sort();
    if (JSON.stringify(want) === JSON.stringify(have)) continue;
    try {
      await writeLead(db, tenantId, db.collection('leads').doc(l.id), { agentAccess: want }, 'update');
      l.agentAccess = want;
      changed++;
    } catch (e) { console.error('agent access: lead ' + l.id + ' not updated:', e.message); }
  }
  return changed;
}

function matchesFor({ tenantId, email, view, properties, leads, cfg, requested }) {
  const fields = cfg.matchingLeadFields || [];
  if (!fields.length || !PinMatch) return [];
  const mineIds = new Set(view.filter(p => p._access === 'own' || p._access === 'co').map(p => String(p.id)));
  if (!mineIds.size) return [];
  const others = leads.filter(l => !AA.leadVisibleTo(l, email));
  const out = [];
  const seen = new Set();
  properties.filter(p => mineIds.has(String(p.id))).forEach(p => {
    let found = [];
    try { found = PinMatch.buyersFor(p, others, { inventory: properties, minPct: 60, limit: 8 }); } catch (e) { found = []; }
    found.forEach(m => {
      const ref = leadRef(tenantId, m.lead.id);
      const key = ref + '|' + p.id;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(AA.matchCard(m.lead, fields, {
        ref, propertyId: String(p.id), pct: Math.round(m.pct || 0),
        band: (PinMatch.band(m.pct, false) || {}).label || '',
        requested: requested.get(ref) || null,
      }));
    });
  });
  return out.slice(0, 60);
}

// Rebuild one agent's copy from data already loaded (ctx) and write it.
async function writeView(db, tenantId, agent, ctx) {
  const now = Date.now();
  const cfg = effectiveConfig(ctx.cfg, agent.email);
  const view = AA.buildPropertyView({ properties: ctx.properties, grants: ctx.grants, cfg, email: agent.email, now });
  // The primary agent's name, where the settings show it, as a name (never only an email).
  const showPrimary = (fields) => (fields || []).includes('primaryAgent');
  view.forEach(p => {
    const f = p._access === 'summary' ? cfg.otherPropertyFields : p._access === 'granted' ? cfg.grantedPropertyFields : cfg.ownPropertyFields;
    if (showPrimary(f) && p.assignedAgent) p._primaryName = nameIn(ctx.team, p.assignedAgent);
    if ((f || []).includes('coAgents')) p._coNames = AA.coAgentsOf(p).map(e => nameIn(ctx.team, e));
  });
  const reqs = await db.collection('accessRequests').where('tenantId', '==', tenantId).where('requesterEmail', '==', agent.email).get();
  const requested = new Map();
  const pendingProps = {};
  reqs.docs.forEach(d => {
    const r = d.data();
    if (r.kind === 'lead') requested.set(r.targetRef, r.status);
    if (r.kind === 'property' && r.status === 'pending') pendingProps[r.targetId] = d.id;
  });
  view.forEach(p => { if (pendingProps[p.id]) p._pending = pendingProps[p.id]; });
  const matches = matchesFor({ tenantId, email: agent.email, view, properties: ctx.properties, leads: ctx.leads, cfg, requested });
  const mine = ctx.grants.filter(g => lc(g.agentEmail) === agent.email);
  const next = AA.nextExpiry(mine, now);
  const doc = {
    tenantId, uid: agent.uid, email: agent.email, builtAt: now,
    expiresAt: Math.min(next || Infinity, now + VIEW_TTL),
    cfgAt: (ctx.cfg && ctx.cfg.updatedAt) || 0,
    props: view, matches,
    counts: { own: view.filter(p => p._access === 'own' || p._access === 'co').length, granted: view.filter(p => p._access === 'granted').length, summary: view.filter(p => p._access === 'summary').length },
  };
  // A Firestore document holds 1 MiB. Should one agent's copy outgrow that, the long texts of the
  // summary rows go first (they carry none by default).
  let size = Buffer.byteLength(JSON.stringify(doc));
  if (size > 950000) {
    doc.props = doc.props.map(p => (p._access === 'summary' ? { id: p.id, name: p.name, config: p.config, startingPrice: p.startingPrice, zone: p.zone, _access: p._access, _code: p._code } : p));
    size = Buffer.byteLength(JSON.stringify(doc));
    if (size > 950000) { doc.props = doc.props.filter(p => p._access !== 'summary'); doc.trimmed = true; }
  }
  await db.collection('agentViews').doc(viewId(tenantId, agent.uid)).set(doc);
  return doc;
}

async function loadContext(db, tenantId) {
  const [cfg, properties, grants, leads, team] = await Promise.all([
    loadConfig(db, tenantId), loadProperties(db, tenantId), loadGrants(db, tenantId), readLeads(db, tenantId), teamOf(db, tenantId),
  ]);
  return { cfg, properties, grants, leads, team };
}

// Rebuild the copies of the agents named (emails), or of every agent, after the data they are built
// from changed (an assignment, a decision, a revoke). The lead access is put right first.
export async function rebuildAgents(db, tenantId, emails) {
  const ctx = await loadContext(db, tenantId);
  await syncLeadAccess(db, tenantId, ctx);
  const want = emails ? new Set(emails.map(lc)) : null;
  const agents = ctx.team.filter(u => u.role === 'agent' && (!want || want.has(u.email)));
  for (const a of agents) await writeView(db, tenantId, a, ctx);
  return agents.length;
}

async function view(db, user, body) {
  const ref = db.collection('agentViews').doc(viewId(user.tenantId, user.uid));
  const [snap, cfg] = await Promise.all([ref.get(), loadConfig(db, user.tenantId)]);
  const now = Date.now();
  const v = snap.exists ? snap.data() : null;
  const stale = !v || now - (v.builtAt || 0) > STALE_MS || (v.expiresAt || 0) <= now
    || (v.cfgAt || 0) !== ((cfg && cfg.updatedAt) || 0)
    || (body && body.force === true && now - (v.builtAt || 0) > FORCE_MS);
  if (!stale) return json({ ok: true, builtAt: v.builtAt, fresh: false });
  const ctx = await loadContext(db, user.tenantId);
  ctx.cfg = cfg;
  await syncLeadAccess(db, user.tenantId, ctx);
  const doc = await writeView(db, user.tenantId, { uid: user.uid, email: lc(user.email) }, ctx);
  return json({ ok: true, builtAt: doc.builtAt, fresh: true });
}

async function directory(db, user) {
  const team = await teamOf(db, user.tenantId);
  return json({ ok: true, people: team.filter(u => u.active).map(u => ({ email: u.email, name: u.name, role: u.role })).sort((a, b) => a.name.localeCompare(b.name)) });
}

async function crmBoot(db, user) {
  const s = await db.collection('settings').doc(user.tenantId).get();
  const d = s.exists ? s.data() : {};
  return json({ ok: true, team: d.team || {}, enquiryTypes: d.enquiryTypes || null, tailortalkWorkspace: d.tailortalkWorkspace || null });
}

// ── Properties: what the agent may see and touch ──
async function accessTo(db, user, propertyId) {
  const p = await getProperty(db, user.tenantId, propertyId);
  if (!p) return { error: json({ ok: false, error: 'No such property' }, 404) };
  const me = lc(user.email);
  const cfgDoc = await loadConfig(db, user.tenantId);
  const cfg = effectiveConfig(cfgDoc, me);
  const role = AA.roleOn(p, me);
  let fields = null, access = null, grant = null;
  if (user.role !== 'agent') { access = 'staff'; fields = null; }
  else if (role) { access = role === 'primary' ? 'own' : 'co'; fields = cfg.ownPropertyFields; }
  else {
    const g = await db.collection('grants').doc(AA.grantId(user.tenantId, 'property', p.id, me)).get();
    if (g.exists && AA.grantLive(g.data())) { access = 'granted'; grant = g.data(); fields = AA.contactLive(grant) ? [...cfg.grantedPropertyFields, 'contact'] : cfg.grantedPropertyFields; }
    else if (AA.isActiveProperty(p)) { access = 'summary'; fields = cfg.otherPropertyFields; }
  }
  return { p, access, fields, cfg, grant };
}

async function propertyNotes(db, user, body) {
  const a = await accessTo(db, user, body && body.id);
  if (a.error) return a.error;
  if (!a.access || (a.fields && !a.fields.includes('notes'))) return json({ ok: false, error: 'Notes are not part of your access to this property' }, 403);
  const s = await db.collection('properties').doc(a.p.id).collection('notes').limit(200).get();
  const hideNumbers = !!a.fields && !a.fields.includes('contact');
  const notes = s.docs.map(d => d.data()).map(n => (hideNumbers ? maskPhones(n) : n))
    .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0)).slice(0, 100);
  return json({ ok: true, notes });
}

const OWN = new Set(['own', 'co']);
async function propertyNote(db, user, body) {
  const a = await accessTo(db, user, body && body.id);
  if (a.error) return a.error;
  if (user.role === 'agent' && (!OWN.has(a.access) || !a.cfg.actions.editOwnProperties)) return json({ ok: false, error: 'You can add notes only on your own properties' }, 403);
  const text = String((body && body.text) || '').trim().slice(0, MAX_TEXT);
  if (!text) return json({ ok: false, error: 'Write the note first' }, 400);
  const now = Date.now();
  const entry = { id: 'n' + now + randomBytes(2).toString('hex'), text, kind: 'note', eventDate: '', createdAt: now, author: lc(user.email) };
  await db.collection('properties').doc(a.p.id).collection('notes').doc(entry.id).set(entry);
  return json({ ok: true, note: entry });
}

const AVAILABILITY = ['Available', 'On hold', 'Booked', 'Sold', 'Let out'];
async function propertyAvailability(db, user, body) {
  const a = await accessTo(db, user, body && body.id);
  if (a.error) return a.error;
  if (user.role === 'agent' && (!OWN.has(a.access) || !a.cfg.actions.editOwnProperties)) return json({ ok: false, error: 'You can change availability only on your own properties' }, 403);
  const value = String((body && body.availability) || '');
  if (!AVAILABILITY.includes(value)) return json({ ok: false, error: 'Pick one: ' + AVAILABILITY.join(', ') }, 400);
  const now = Date.now();
  const patch = { availability: value, soldOut: value === 'Sold' || value === 'Let out', updatedAt: now, updatedBy: lc(user.email) };
  await db.collection('properties').doc(a.p.id).update(patch);
  await db.collection('properties').doc(a.p.id).collection('notes').doc('n' + now + 'av').set({
    id: 'n' + now + 'av', text: `Availability set to ${value}`, kind: 'note', eventDate: '', createdAt: now, author: lc(user.email),
  });
  // The change log the dashboard's "Changes to apply" shows, so the sheet is updated too.
  await db.collection('propertyChanges').add({ tenantId: user.tenantId, propertyId: a.p.id, propertyName: a.p.name || '', field: 'availability',
    from: a.p.availability || '', to: value, kind: 'edit', at: now, by: lc(user.email), appliedToSheet: false }).catch(() => {});
  await rebuildAgents(db, user.tenantId, AA.agentsOf(a.p)).catch(e => console.error('rebuild after availability:', e.message));
  return json({ ok: true, availability: value });
}

const SUBMIT_FIELDS = ['name', 'config', 'startingPrice', 'type', 'zone', 'location', 'contactName', 'contactNumber', 'notes', 'photosLink'];
async function propertySubmit(db, user, body) {
  const me = lc(user.email);
  if (user.role === 'agent') {
    const cfg = effectiveConfig(await loadConfig(db, user.tenantId), me);
    if (!cfg.actions.addProperties) return json({ ok: false, error: 'Adding properties is not part of your access' }, 403);
  }
  const f = (body && body.fields) || {};
  const fields = {};
  SUBMIT_FIELDS.forEach(k => { if (f[k] != null) fields[k] = String(f[k]).trim().slice(0, k === 'notes' ? MAX_TEXT : 300); });
  if (!fields.name) return json({ ok: false, error: 'Give the property a title' }, 400);
  const team = await teamOf(db, user.tenantId);
  const ref = await db.collection('propertySubmissions').add({
    tenantId: user.tenantId, byUid: user.uid, byEmail: me, byName: nameIn(team, me), fields,
    status: 'pending', createdAt: Date.now(),
  });
  return json({ ok: true, id: ref.id });
}

async function submissionDecide(db, user, body) {
  const ref = db.collection('propertySubmissions').doc(String((body && body.id) || '_'));
  const s = await ref.get();
  if (!s.exists || s.data().tenantId !== user.tenantId) return json({ ok: false, error: 'No such submission' }, 404);
  const sub = s.data();
  if (sub.status !== 'pending') return json({ ok: false, error: 'Already ' + sub.status }, 409);
  const decision = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : null;
  if (!decision) return json({ ok: false, error: 'Approve or reject' }, 400);
  const note = String(body.note || '').trim().slice(0, 500);
  if (decision === 'rejected' && !note) return json({ ok: false, error: 'Say why, for the agent' }, 400);
  let propertyId = null;
  if (decision === 'approved') {
    const now = Date.now();
    propertyId = 'AG' + now.toString(36).toUpperCase();
    const f = sub.fields || {};
    const { notes, ...rest } = f;
    await db.collection('properties').doc(propertyId).set({
      ...rest, id: propertyId, propertyCode: propertyId, tenantId: user.tenantId,
      ...AA.assignmentPatch(sub.byEmail, []), agentsSetAt: now, agentsSetBy: lc(user.email),
      availability: 'Available', source: 'agent', createdAt: now, createdBy: sub.byEmail,
    });
    if (notes) await db.collection('properties').doc(propertyId).collection('notes').doc('n' + now).set({ id: 'n' + now, text: notes, kind: 'note', eventDate: '', createdAt: now, author: sub.byEmail });
    await db.collection('assignmentLog').add({ tenantId: user.tenantId, propertyId, propertyName: f.name || '', at: now, by: lc(user.email),
      from: { primary: null, co: [] }, to: { primary: sub.byEmail, co: [] }, why: 'Added by the agent, approved' });
  }
  await ref.update({ status: decision, decidedBy: lc(user.email), decidedAt: Date.now(), note, propertyId });
  if (propertyId) await rebuildAgents(db, user.tenantId, [sub.byEmail]).catch(() => {});
  return json({ ok: true, status: decision, propertyId });
}

// ── One property's access, for the dashboard (staff and admins) ──
async function propertyAccess(db, user, body) {
  if (user.role === 'agent') return json({ ok: false, error: 'Not part of your access' }, 403);
  const p = await getProperty(db, user.tenantId, body && body.id);
  if (!p) return json({ ok: false, error: 'No such property' }, 404);
  const now = Date.now();
  const [g, r, l] = await Promise.all([
    db.collection('grants').where('tenantId', '==', user.tenantId).where('kind', '==', 'property').where('targetId', '==', p.id).get(),
    db.collection('accessRequests').where('tenantId', '==', user.tenantId).where('targetId', '==', p.id).get(),
    db.collection('assignmentLog').where('tenantId', '==', user.tenantId).where('propertyId', '==', p.id).get(),
  ]);
  const grants = g.docs.map(d => ({ ...d.data(), id: d.id })).map(x => ({ id: x.id, agentEmail: x.agentEmail, agentName: x.agentName, grantedBy: x.grantedBy,
    grantedByName: x.grantedByName, grantedAt: x.grantedAt, expiresAt: x.expiresAt, contactExpiresAt: x.contactExpiresAt,
    live: AA.grantLive(x, now), contactLive: AA.contactLive(x, now), revokedAt: x.revokedAt || null })).sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0));
  const requests = r.docs.map(d => ({ id: d.id, status: d.data().status, requesterName: d.data().requesterName, reason: d.data().reason || '', createdAt: d.data().createdAt }))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 20);
  const log = l.docs.map(d => d.data()).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 20);
  return json({ ok: true, grants, requests, log });
}

// ── Assignment (admins, and full-access staff as before the agent layer) ──
async function assign(db, user, body) {
  if (user.role === 'agent') return json({ ok: false, error: 'Only admins assign agents' }, 403);
  const p = await getProperty(db, user.tenantId, body && body.propertyId);
  if (!p) return json({ ok: false, error: 'No such property' }, 404);
  const team = await teamOf(db, user.tenantId);
  const known = new Set(team.filter(u => u.active).map(u => u.email));
  const primary = lc(body.primary);
  const co = Array.isArray(body.coAgents) ? body.coAgents.map(lc) : [];
  const unknown = [primary, ...co].filter(e => e && !known.has(e));
  if (unknown.length) return json({ ok: false, error: 'Not on the team: ' + unknown.join(', ') }, 400);
  if (!primary && co.length) return json({ ok: false, error: 'Pick the primary agent first' }, 400);
  const patch = AA.assignmentPatch(primary, co);
  const before = { primary: AA.primaryOf(p) || null, co: AA.coAgentsOf(p) };
  const after = { primary: patch.assignedAgent, co: patch.secondaryAgents };
  if (JSON.stringify(before) === JSON.stringify(after)) return json({ ok: true, unchanged: true, ...patch });
  const now = Date.now();
  await db.collection('properties').doc(p.id).update({ ...patch, agentsSetAt: now, agentsSetBy: lc(user.email) });
  await db.collection('assignmentLog').add({ tenantId: user.tenantId, propertyId: p.id, propertyName: p.name || '', at: now, by: lc(user.email), from: before, to: after,
    why: String(body.why || '').slice(0, 300) || null });
  const touched = [...new Set([before.primary, ...before.co, after.primary, ...after.co].filter(Boolean))];
  await rebuildAgents(db, user.tenantId, touched).catch(e => console.error('rebuild after assign:', e.message));
  return json({ ok: true, ...patch });
}

// ── Leads an agent works ──
// What a page may never change on a lead through here: who it belongs to, the server's own fields,
// its identity. (The board's AI suggestion bookkeeping, ai.suggestion / ai.dismissed / ai.lastMove,
// is allowed — the rest of ai is the server's.)
const LEAD_LOCKED = new Set(['tenantId', 'id', 'assignedAgent', 'secondaryAgent', 'agentsSetAt', 'agentsSetBy', 'agentAccess',
  'tt', 'ttState', 'calendarEventId', 'calendarEventOwner', 'phoneKey', 'createdAt', 'createdBy', 'notes', 'history',
  'aiSummary', 'aiSummaryAt', 'aiSummaryError', 'siteVisitReplies', 'listingId']);
const SEG = /^[A-Za-z0-9_\-]{1,80}$/;
export function leadPatchFrom(body, me) {
  let entries = [];
  if (Array.isArray(body.pairs)) entries = body.pairs.filter(x => Array.isArray(x) && Array.isArray(x[0])).map(([seg, v]) => [seg.map(String), v]);
  else if (body.data && typeof body.data === 'object') entries = Object.entries(body.data).map(([k, v]) => [k.split('.'), v]);
  const patch = {};
  const refused = [];
  for (const [seg, v] of entries) {
    if (!seg.length || !seg.every(s => SEG.test(s))) { refused.push(seg.join('.')); continue; }
    const top = seg[0];
    if (top === 'ai') { if (!['suggestion', 'dismissed', 'lastMove'].includes(seg[1])) { refused.push(seg.join('.')); continue; } }
    else if (LEAD_LOCKED.has(top)) { refused.push(seg.join('.')); continue; }
    if (v !== null && typeof v === 'object' && JSON.stringify(v).length > 20000) { refused.push(seg.join('.')); continue; }
    patch[seg.join('.')] = v === undefined ? null : v;
  }
  if (Object.keys(patch).length) { patch.updatedAt = Date.now(); patch.updatedBy = me; }
  if ('phone' in patch) {
    const d = String(patch.phone || '').replace(/\D/g, '');
    patch.phoneKey = !d ? '' : d.length === 10 ? '91' + d : d.length === 11 && d[0] === '0' ? '91' + d.slice(1) : d;
  }
  return { patch, refused };
}

async function leadFor(db, user, id) {
  if (!id || typeof id !== 'string' || id.includes('/')) return { error: json({ ok: false, error: 'No such lead' }, 404) };
  const ref = db.collection('leads').doc(id);
  const s = await ref.get();
  if (!s.exists || s.data().tenantId !== user.tenantId) return { error: json({ ok: false, error: 'No such lead' }, 404) };
  const lead = { ...s.data(), id: s.id };
  if (user.role === 'agent' && !AA.leadVisibleTo(lead, user.email)) return { error: json({ ok: false, error: 'This lead is not one of yours' }, 403) };
  return { ref, lead };
}

async function leadSave(db, user, body) {
  if (body && body.mode === 'delete') return json({ ok: false, error: 'Ask an admin to delete a lead' }, 403);
  const { error, ref, lead } = await leadFor(db, user, body && body.id);
  if (error) return error;
  const me = lc(user.email);
  const { patch, refused } = leadPatchFrom(body || {}, me);
  if (!Object.keys(patch).length) return json({ ok: true, unchanged: true, refused });
  await writeLead(db, user.tenantId, ref, patch, 'update');
  // A visit on someone else's property, marked done or called off from the lead: its agents hear.
  const after = { ...lead };
  Object.entries(patch).forEach(([k, v]) => { if (!k.includes('.')) after[k] = v; });
  await visitAlert(db, user, lead, after).catch(e => console.error('visit alert:', e.message));
  return json({ ok: true, refused });
}

const NOTE_KEYS = ['id', 'text', 'createdAt', 'by', 'kind', 'pinned', 'editedAt', 'mentions'];
async function leadNote(db, user, body) {
  const { error, ref } = await leadFor(db, user, body && body.id);
  if (error) return error;
  const n = (body && body.note) || {};
  const note = {};
  NOTE_KEYS.forEach(k => { if (n[k] !== undefined) note[k] = n[k]; });
  if (!note.id || !/^[A-Za-z0-9_\-]{1,60}$/.test(String(note.id))) return json({ ok: false, error: 'Bad note' }, 400);
  note.text = String(note.text || '').slice(0, 8000);
  note.by = lc(user.email);
  const existing = await ref.collection('notes').doc(note.id).get();
  if (existing.exists && lc(existing.data().by) !== note.by) return json({ ok: false, error: 'Only whoever wrote a note can change it' }, 403);
  await ref.collection('notes').doc(note.id).set(note);
  return json({ ok: true });
}
async function leadNoteDelete(db, user, body) {
  const { error, ref } = await leadFor(db, user, body && body.id);
  if (error) return error;
  const id = String((body && body.noteId) || '');
  if (!/^[A-Za-z0-9_\-]{1,60}$/.test(id)) return json({ ok: false, error: 'Bad note' }, 400);
  const s = await ref.collection('notes').doc(id).get();
  if (s.exists && lc(s.data().by) !== lc(user.email)) return json({ ok: false, error: 'Only whoever wrote a note can delete it' }, 403);
  if (s.exists) await ref.collection('notes').doc(id).delete();
  return json({ ok: true });
}
async function leadHistory(db, user, body) {
  const { error, ref } = await leadFor(db, user, body && body.id);
  if (error) return error;
  const e = (body && body.event) || {};
  if (!e.id || !/^[A-Za-z0-9_\-]{1,60}$/.test(String(e.id))) return json({ ok: false, error: 'Bad event' }, 400);
  const event = { id: String(e.id), type: String(e.type || 'note').slice(0, 40), text: String(e.text || '').slice(0, 2000), at: Number(e.at) || Date.now(), by: lc(user.email) };
  await ref.collection('history').doc(event.id).set(event);
  return json({ ok: true });
}

const LEAD_NEW_FIELDS = ['channel', 'name', 'phone', 'email', 'enquiryType', 'propertyInterest', 'budget', 'propertyCodes', 'source', 'stageId',
  'detailsSent', 'contactAt', 'followUpAt', 'followUpNote', 'lastActionType', 'reached', 'noteCount', 'lastNote'];
async function leadAdd(db, user, body) {
  const me = lc(user.email);
  const cfg = effectiveConfig(await loadConfig(db, user.tenantId), me);
  if (user.role === 'agent' && !cfg.actions.addLeads) return json({ ok: false, error: 'Adding leads is not part of your access' }, 403);
  const src = (body && body.lead) || {};
  const id = String(src.id || '');
  if (!/^lead_\d{10,16}$/.test(id)) return json({ ok: false, error: 'Bad lead' }, 400);
  const d = String(src.phone || '').replace(/\D/g, '');
  const key = !d ? '' : d.length === 10 ? '91' + d : d.length === 11 && d[0] === '0' ? '91' + d.slice(1) : d;
  if (!key || key.length < 10) return json({ ok: false, error: 'Enter the client’s phone number' }, 400);
  // The whole team's leads, not only the agent's: a number already with someone is not added twice.
  // Who has it is not said — that would hand over another agent's client.
  const leads = await readLeads(db, user.tenantId);
  const dup = leads.find(l => {
    const ld = String(l.phone || '').replace(/\D/g, '');
    const lk = !ld ? '' : ld.length === 10 ? '91' + ld : ld.length === 11 && ld[0] === '0' ? '91' + ld.slice(1) : ld;
    return lk && lk === key;
  });
  if (dup) {
    const mine = AA.leadVisibleTo(dup, me);
    return json({ ok: false, duplicate: true, mine, leadId: mine ? dup.id : null,
      error: mine ? 'You already have this client as a lead' : 'This number is already with the team. Ask an admin if this client should be yours.' }, 409);
  }
  const ref = db.collection('leads').doc(id);
  if ((await ref.get()).exists) return json({ ok: false, error: 'That lead already exists' }, 409);
  const now = Date.now();
  const lead = { id, tenantId: user.tenantId };
  LEAD_NEW_FIELDS.forEach(k => { if (src[k] !== undefined) lead[k] = src[k]; });
  if (lead.propertyCodes && !Array.isArray(lead.propertyCodes)) delete lead.propertyCodes;
  Object.assign(lead, { phoneKey: key, assignedAgent: me, secondaryAgent: null, agentsSetAt: now, agentsSetBy: me,
    createdAt: now, updatedAt: now, createdBy: me, updatedBy: me, source: lead.source || 'manual' });
  await writeLead(db, user.tenantId, ref, lead, 'merge');
  return json({ ok: true, id });
}

// ── Requests, approvals and grants ──
async function threadFor(db, tenantId, { type, linkedId, title, members, by, team }) {
  const mem = [...new Set(members.map(lc).filter(Boolean))].sort();
  const id = `${tenantId}__${type}__${createHash('sha1').update(String(linkedId || '') + '|' + mem.join(',')).digest('hex').slice(0, 16)}`;
  const ref = db.collection('threads').doc(id);
  const s = await ref.get();
  if (s.exists) return { id, ref, created: false, data: s.data() };
  const now = Date.now();
  const names = {};
  mem.forEach(e => { names[AA.emailKey(e)] = nameIn(team, e); });
  const data = { tenantId, title: String(title || '').slice(0, 120), type, linkedId: linkedId || null, members: mem, names,
    createdBy: lc(by), createdAt: now, lastAt: now, lastText: '', lastBy: null, unread: {}, reads: {} };
  await ref.set(data);
  return { id, ref, created: true, data };
}
// A line in a thread written by the system ("Approved by Swami"), counted unread for everyone.
export async function systemMessage(db, threadRef, members, text, extra) {
  const now = Date.now();
  const unread = {};
  members.forEach(e => { unread['unread.' + AA.emailKey(e)] = FieldValue.increment(1); });
  const b = db.batch();
  b.set(threadRef.collection('messages').doc(), { kind: 'system', text: String(text).slice(0, 1000), at: now, by: null, ...(extra || {}) });
  b.update(threadRef, { lastAt: now, lastText: String(text).slice(0, 140), lastBy: null, ...unread });
  await b.commit();
}

async function request(db, user, body) {
  const me = lc(user.email);
  const kind = body && body.kind === 'lead' ? 'lead' : 'property';
  const reason = String((body && body.reason) || '').trim().slice(0, 500);
  const visitAt = Number(body && body.visitAt) || null;
  const team = await teamOf(db, user.tenantId);
  const cfg = effectiveConfig(await loadConfig(db, user.tenantId), me);
  const admins = adminsOf(team);
  let target, title, approvers, targetId, targetRef = null, privateLead = null;
  if (kind === 'property') {
    const p = await getProperty(db, user.tenantId, body.targetId);
    if (!p) return json({ ok: false, error: 'No such property' }, 404);
    if (AA.roleOn(p, me)) return json({ ok: false, error: 'This is already your property' }, 400);
    if (!AA.isActiveProperty(p)) return json({ ok: false, error: 'This property is no longer on the market' }, 400);
    const g = await db.collection('grants').doc(AA.grantId(user.tenantId, 'property', p.id, me)).get();
    if (g.exists && AA.grantLive(g.data())) return json({ ok: false, error: 'You already have this property’s details' }, 400);
    target = p; targetId = p.id; title = p.name || p.id;
    approvers = AA.approversFor({ kind, property: p, approvers: cfg.approvals.approvers, admins, requester: me });
  } else {
    // A matching lead, named by its reference: found again among the leads, never sent by id.
    const ref = String(body.ref || '');
    if (!/^m[0-9a-f]{20}$/.test(ref)) return json({ ok: false, error: 'No such lead' }, 404);
    const leads = await readLeads(db, user.tenantId);
    const lead = leads.find(l => leadRef(user.tenantId, l.id) === ref);
    if (!lead) return json({ ok: false, error: 'That lead is no longer there' }, 404);
    if (AA.leadVisibleTo(lead, me)) return json({ ok: false, error: 'This lead is already yours' }, 400);
    target = lead; targetId = ref; targetRef = ref; privateLead = { leadId: lead.id, leadName: lead.name || '' };
    title = 'Lead: ' + (AA.requirementOf(lead) ? AA.scrubText(AA.requirementOf(lead), [lead.name]).slice(0, 60) : 'matching buyer');
    approvers = AA.approversFor({ kind, lead, approvers: cfg.approvals.approvers, admins, requester: me });
  }
  if (!approvers.length) return json({ ok: false, error: 'Nobody can approve this yet — ask an admin' }, 400);
  const open = await db.collection('accessRequests').where('tenantId', '==', user.tenantId).where('requesterEmail', '==', me)
    .where('targetId', '==', targetId).where('status', '==', 'pending').limit(1).get();
  if (!open.empty) return json({ ok: false, error: 'You already asked — it is waiting for a decision', id: open.docs[0].id }, 409);
  // The client this is for: one of the agent's own leads (a name only travels).
  let clientName = '';
  if (body.clientLeadId) {
    const c = await leadFor(db, user, String(body.clientLeadId));
    if (c.error) return json({ ok: false, error: 'Pick one of your own leads as the client' }, 400);
    clientName = String(c.lead.name || '').slice(0, 60);
  }
  const now = Date.now();
  const reqRef = db.collection('accessRequests').doc();
  const thread = await threadFor(db, user.tenantId, { type: 'access_request', linkedId: reqRef.id,
    title: `Access: ${title.slice(0, 60)}${clientName ? ' · for ' + clientName : ''}`, members: [me, ...approvers], by: me, team });
  const req = {
    tenantId: user.tenantId, kind, targetId, targetRef, title,
    requesterUid: user.uid, requesterEmail: me, requesterName: nameIn(team, me),
    clientLeadId: body.clientLeadId ? String(body.clientLeadId) : null, clientName, reason, visitAt,
    approvers, status: 'pending', createdAt: now, threadId: thread.id,
    history: [{ at: now, by: me, what: 'asked', note: reason || null }],
  };
  const b = db.batch();
  b.set(reqRef, req);
  if (privateLead) b.set(db.collection('requestPrivate').doc(reqRef.id), { tenantId: user.tenantId, approvers, ...privateLead });
  await b.commit();
  await systemMessage(db, thread.ref, thread.data.members.filter(e => e !== me),
    `${req.requesterName} asked for ${kind === 'lead' ? 'this lead’s details' : 'the details of ' + title}${clientName ? ' for their client ' + clientName : ''}${reason ? ': “' + reason + '”' : ''}`,
    { requestId: reqRef.id });
  await rebuildAgents(db, user.tenantId, [me]).catch(() => {});
  return json({ ok: true, id: reqRef.id, threadId: thread.id });
}

async function decide(db, user, body) {
  const me = lc(user.email);
  const ref = db.collection('accessRequests').doc(String((body && body.id) || '_'));
  const decision = body && body.decision === 'approve' ? 'approved' : body && body.decision === 'reject' ? 'rejected' : null;
  if (!decision) return json({ ok: false, error: 'Approve or reject' }, 400);
  const note = String(body.note || '').trim().slice(0, 500);
  if (decision === 'rejected' && !note) return json({ ok: false, error: 'Say why — the agent sees it' }, 400);
  const team = await teamOf(db, user.tenantId);
  const isAdmin = user.role === 'admin' && user.email_verified === true;
  const now = Date.now();
  const expiresAt = AA.timerEnd({ days: body.days, until: body.until }, now);
  const shareContact = body.shareContact === true;
  const contactUntil = shareContact ? AA.timerEnd({ hours: body.hours, until: body.contactUntil }, now) : null;
  if (expiresAt === undefined || contactUntil === undefined) return json({ ok: false, error: 'Pick a timer from the list, or a time in the future' }, 400);
  const coAgent = body.coAgent === true;
  let result;
  try {
    result = await db.runTransaction(async t => {
      const s = await t.get(ref);
      if (!s.exists || s.data().tenantId !== user.tenantId) throw Object.assign(new Error('No such request'), { http: 404 });
      const r = s.data();
      // First decision wins: whoever is second sees who decided, and when.
      if (r.status !== 'pending') throw Object.assign(new Error(r.status === 'cancelled' ? 'The agent cancelled this request' : `Already ${r.status} by ${r.decidedByName || r.decidedBy}`), { http: 409, request: r });
      if (!isAdmin && !(r.approvers || []).includes(me)) throw Object.assign(new Error('You are not an approver of this request'), { http: 403 });
      if (r.requesterEmail === me) throw Object.assign(new Error('You cannot decide your own request'), { http: 403 });
      const patch = { status: decision, decidedBy: me, decidedByName: nameIn(team, me), decidedAt: now, note,
        history: FieldValue.arrayUnion({ at: now, by: me, what: decision, note: note || null }) };
      let grantRef = null, grant = null, leadId = null, property = null;
      if (decision === 'approved') {
        if (r.kind === 'lead') {
          const ps = await t.get(db.collection('requestPrivate').doc(ref.id));
          leadId = ps.exists ? ps.data().leadId : null;
          if (!leadId) throw Object.assign(new Error('That lead is no longer there'), { http: 404 });
        } else {
          const pr = await t.get(db.collection('properties').doc(r.targetId));
          if (!pr.exists) throw Object.assign(new Error('That property is no longer there'), { http: 404 });
          property = { ...pr.data(), id: pr.id };
        }
        // Making them a co-agent is for the property's primary agent or an admin.
        if (coAgent && r.kind === 'property' && !(isAdmin || AA.primaryOf(property) === me)) throw Object.assign(new Error('Only the primary agent or an admin can add a co-agent'), { http: 403 });
        if (coAgent && r.kind === 'property') {
          const co = [...AA.coAgentsOf(property), r.requesterEmail];
          t.update(db.collection('properties').doc(property.id), { ...AA.assignmentPatch(AA.primaryOf(property), co), agentsSetAt: now, agentsSetBy: me });
          t.set(db.collection('assignmentLog').doc(), { tenantId: user.tenantId, propertyId: property.id, propertyName: property.name || '', at: now, by: me,
            from: { primary: AA.primaryOf(property) || null, co: AA.coAgentsOf(property) }, to: { primary: AA.primaryOf(property) || null, co: AA.assignmentPatch(AA.primaryOf(property), co).secondaryAgents },
            why: 'Collaboration approved (request ' + ref.id + ')' });
          patch.terms = { coAgent: true };
        } else {
          const targetId = r.kind === 'lead' ? leadId : r.targetId;
          grantRef = db.collection('grants').doc(AA.grantId(user.tenantId, r.kind, targetId, r.requesterEmail));
          grant = { tenantId: user.tenantId, kind: r.kind, targetId, targetRef: r.targetRef || null, title: r.title, agentUid: r.requesterUid, agentEmail: r.requesterEmail,
            agentName: r.requesterName, requestId: ref.id, grantedBy: me, grantedByName: nameIn(team, me), grantedAt: now, active: true,
            expiresAt: expiresAt == null ? null : expiresAt,
            includeContact: r.kind === 'property' && shareContact, contactExpiresAt: r.kind === 'property' && shareContact ? (contactUntil == null ? null : contactUntil) : null,
            revokedBy: null, revokedAt: null, revokeReason: null,
            history: [{ at: now, by: me, what: 'granted' }] };
          t.set(grantRef, grant);
          patch.grantId = grantRef.id;
          patch.terms = { until: grant.expiresAt, contact: grant.includeContact, contactUntil: grant.contactExpiresAt };
        }
      }
      t.update(ref, patch);
      return { r, patch, grant };
    });
  } catch (e) {
    if (e.http) return json({ ok: false, error: e.message, current: e.request ? e.request.status : undefined }, e.http);
    throw e;
  }
  const { r, patch } = result;
  const who = nameIn(team, me);
  const fmt = t => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  let line;
  if (decision === 'rejected') line = `Rejected by ${who}: “${note}”`;
  else if (patch.terms && patch.terms.coAgent) line = `Approved by ${who} — ${r.requesterName} is now a co-agent on ${r.title}`;
  else line = `Approved by ${who} — details ${patch.terms.until ? 'until ' + fmt(patch.terms.until) : 'with no time limit'}`
    + (patch.terms.contact ? `; owner’s number ${patch.terms.contactUntil ? 'until ' + fmt(patch.terms.contactUntil) : 'shared'}` : '') + (note ? `. “${note}”` : '');
  if (r.threadId) {
    const th = db.collection('threads').doc(r.threadId);
    const ts = await th.get();
    if (ts.exists) await systemMessage(db, th, ts.data().members.filter(e => e !== me), line, { requestId: ref.id }).catch(() => {});
  }
  await rebuildAgents(db, user.tenantId, [r.requesterEmail]).catch(e => console.error('rebuild after decide:', e.message));
  return json({ ok: true, status: decision, grantId: patch.grantId || null });
}

async function cancel(db, user, body) {
  const me = lc(user.email);
  const ref = db.collection('accessRequests').doc(String((body && body.id) || '_'));
  try {
    await db.runTransaction(async t => {
      const s = await t.get(ref);
      if (!s.exists || s.data().tenantId !== user.tenantId) throw Object.assign(new Error('No such request'), { http: 404 });
      const r = s.data();
      if (r.requesterEmail !== me) throw Object.assign(new Error('Only whoever asked can cancel'), { http: 403 });
      if (r.status !== 'pending') throw Object.assign(new Error('Already ' + r.status), { http: 409 });
      t.update(ref, { status: 'cancelled', decidedAt: Date.now(), decidedBy: me, history: FieldValue.arrayUnion({ at: Date.now(), by: me, what: 'cancelled' }) });
    });
  } catch (e) { if (e.http) return json({ ok: false, error: e.message }, e.http); throw e; }
  const s = await ref.get();
  const r = s.data();
  if (r.threadId) {
    const th = db.collection('threads').doc(r.threadId);
    const ts = await th.get();
    if (ts.exists) await systemMessage(db, th, ts.data().members.filter(e => e !== me), `${r.requesterName} cancelled the request`).catch(() => {});
  }
  await rebuildAgents(db, user.tenantId, [me]).catch(() => {});
  return json({ ok: true });
}

async function grantChange(db, user, body, what) {
  const ref = db.collection('grants').doc(String((body && body.grantId) || '_'));
  const s = await ref.get();
  if (!s.exists || s.data().tenantId !== user.tenantId) return json({ ok: false, error: 'No such access' }, 404);
  const g = s.data();
  const me = lc(user.email);
  const now = Date.now();
  if (what === 'revoke') {
    if (!g.active) return json({ ok: true, unchanged: true });
    const reason = String(body.reason || '').trim().slice(0, 300);
    await ref.update({ active: false, revokedBy: me, revokedAt: now, revokeReason: reason || null, history: FieldValue.arrayUnion({ at: now, by: me, what: 'revoked', note: reason || null }) });
  } else {
    if (!g.includeContact) return json({ ok: true, unchanged: true });
    await ref.update({ includeContact: false, contactExpiresAt: null, history: FieldValue.arrayUnion({ at: now, by: me, what: 'contact-hidden' }) });
  }
  const team = await teamOf(db, user.tenantId);
  if (g.requestId) {
    const r = await db.collection('accessRequests').doc(g.requestId).get();
    if (r.exists && r.data().threadId) {
      const th = db.collection('threads').doc(r.data().threadId);
      const ts = await th.get();
      if (ts.exists) await systemMessage(db, th, ts.data().members.filter(e => e !== me),
        what === 'revoke' ? `${nameIn(team, me)} took back access to ${g.title}` : `${nameIn(team, me)} hid the owner’s number on ${g.title}`).catch(() => {});
    }
  }
  await rebuildAgents(db, user.tenantId, [g.agentEmail]).catch(e => console.error('rebuild after grant change:', e.message));
  return json({ ok: true });
}

// ── Messages ──
async function threadOpen(db, user, body) {
  const me = lc(user.email);
  const type = ['property', 'lead', 'general'].includes(body && body.type) ? body.type : null;
  if (!type) return json({ ok: false, error: 'Bad thread' }, 400);
  const team = await teamOf(db, user.tenantId);
  const active = new Set(team.filter(u => u.active).map(u => u.email));
  let members = (Array.isArray(body.members) ? body.members : []).map(lc).filter(e => active.has(e));
  let linkedId = null, title = String(body.title || '').trim().slice(0, 120);
  if (type === 'property') {
    const p = await getProperty(db, user.tenantId, body.linkedId);
    if (!p) return json({ ok: false, error: 'No such property' }, 404);
    linkedId = p.id;
    if (!members.length) members = AA.agentsOf(p).length ? AA.agentsOf(p) : adminsOf(team);
    if (!title) title = String(p.name || p.id).slice(0, 100);
  } else if (type === 'lead') {
    const c = await leadFor(db, user, String(body.linkedId || ''));
    if (c.error) return c.error;
    linkedId = c.lead.id;
    if (!members.length) members = [c.lead.assignedAgent, c.lead.secondaryAgent].map(lc).filter(e => active.has(e));
    if (!members.length) members = adminsOf(team);
    if (!title) title = 'Lead: ' + String(c.lead.name || 'client').slice(0, 80);
  }
  if (!title) return json({ ok: false, error: 'Give the conversation a title' }, 400);
  members = [...new Set([me, ...members])];
  if (members.length < 2) return json({ ok: false, error: 'Pick at least one person' }, 400);
  if (members.length > 20) return json({ ok: false, error: 'At most 20 people' }, 400);
  const th = await threadFor(db, user.tenantId, { type, linkedId, title, members, by: me, team });
  return json({ ok: true, id: th.id, created: th.created });
}

// ── Site visits on someone else's property (phase 5) ──
// When a visit is booked, moved, called off or done for a lead on a property the booker is not an
// agent of, that property's agents are told: the property, the time, who booked it and the client's
// first name — never the client's number (the client stays with the agent who brought them).
export async function visitAlert(db, user, before, after) {
  const code = String((after && after.siteVisitProperty) || (before && before.siteVisitProperty) || '');
  if (!code) return null;
  const b = { at: before && before.siteVisitAt || null, status: before && before.siteVisitStatus || null };
  const a = { at: after && after.siteVisitAt || null, status: after && after.siteVisitStatus || null };
  let kind = null;
  if (a.status === 'cancelled' && b.status !== 'cancelled') kind = 'cancelled';
  else if (a.status === 'done' && b.status !== 'done') kind = 'done';
  else if (a.at && !b.at) kind = 'booked';
  else if (a.at && b.at && a.at !== b.at) kind = 'moved';
  else if (a.at && (b.status === 'cancelled' || b.status === 'done') && a.status !== b.status) kind = 'booked';
  // The page often saves the visit before asking for the invitation, so the lead read here may
  // already hold it: the visit as it stands then says what happened. Each visit time is announced
  // once (the alert is created only if it is not there yet), whichever of the two calls is first.
  else if (a.at && (!a.status || a.status === 'scheduled' || a.status === 'requested')) kind = 'booked';
  if (!kind) return null;
  const q = await db.collection('properties').where('tenantId', '==', user.tenantId).where('propertyCode', '==', code).limit(1).get();
  let p = q.empty ? null : { ...q.docs[0].data(), id: q.docs[0].id };
  if (!p) p = await getProperty(db, user.tenantId, code);
  if (!p) return null;
  const me = lc(user.email);
  const to = AA.agentsOf(p).filter(e => e !== me && !AA.leadVisibleTo(after, e));
  if (!to.length) return null;
  const team = await teamOf(db, user.tenantId);
  const first = String((after && after.name) || '').trim().split(/\s+/)[0] || 'a client';
  const slot = kind === 'booked' || kind === 'moved' ? 'visit' : kind;
  const id = `${user.tenantId}__${String(after.id).replace(/\//g, '_')}__${slot}__${a.at || b.at || 0}`;
  try {
    await db.collection('visitAlerts').doc(id).create({
      tenantId: user.tenantId, to, propertyId: p.id, propertyTitle: p.name || p.id, kind, at: a.at || b.at || null,
      byEmail: me, byName: nameIn(team, me), clientName: first, createdAt: Date.now(),
    });
  } catch (e) {
    if (e.code === 6 || /already exists/i.test(String(e.message))) return null;   // told already
    throw e;
  }
  // And a line in the request's thread, when this visit came through one.
  const r = await db.collection('accessRequests').where('tenantId', '==', user.tenantId).where('requesterEmail', '==', me)
    .where('targetId', '==', p.id).limit(5).get().catch(() => null);
  const withThread = r && r.docs.map(d => d.data()).filter(x => x.threadId).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))[0];
  if (withThread) {
    const th = db.collection('threads').doc(withThread.threadId);
    const ts = await th.get();
    const when = (a.at || b.at) ? new Date(a.at || b.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    const words = { booked: 'booked a site visit', moved: 'moved the site visit', cancelled: 'called off the site visit', done: 'marked the site visit done' }[kind];
    if (ts.exists) await systemMessage(db, th, ts.data().members.filter(e => e !== me), `${nameIn(team, me)} ${words}${when ? ' — ' + when : ''} (client: ${first})`).catch(() => {});
  }
  return id;
}

// The property a site-visit invitation is written from, as this booker may see it: an agent who has
// no right to the owner's number gets an invitation without it.
export async function visitPropertyFor(db, user, code) {
  if (user.role !== 'agent' || !code) return undefined;
  const q = await db.collection('properties').where('tenantId', '==', user.tenantId).where('propertyCode', '==', String(code)).limit(1).get();
  let p = q.empty ? null : { ...q.docs[0].data(), id: q.docs[0].id };
  if (!p) p = await getProperty(db, user.tenantId, String(code));
  if (!p) return null;
  const me = lc(user.email);
  if (AA.roleOn(p, me)) return p;
  const g = await db.collection('grants').doc(AA.grantId(user.tenantId, 'property', p.id, me)).get();
  if (g.exists && AA.contactLive(g.data())) return p;
  const { contactName, contactNumber, sheetExtras, ...rest } = p;
  return rest;
}

const AGENT_ACTIONS = {
  view, directory, 'crm-boot': crmBoot,
  'property-notes': propertyNotes, 'property-note': propertyNote, 'property-availability': propertyAvailability, 'property-submit': propertySubmit,
  'lead-save': leadSave, 'lead-note': leadNote, 'lead-note-delete': leadNoteDelete, 'lead-history': leadHistory, 'lead-add': leadAdd,
  request, decide, cancel, 'thread-open': threadOpen,
  // Staff and admins (each refuses agents itself): the dashboard's agents panel.
  assign, 'property-access': propertyAccess,
};
const ADMIN_WORK = {
  revoke: (db, u, b) => grantChange(db, u, b, 'revoke'), 'hide-contact': (db, u, b) => grantChange(db, u, b, 'hide'),
  'submission-decide': submissionDecide,
  rebuild: async (db, u, b) => json({ ok: true, rebuilt: await rebuildAgents(db, u.tenantId, b && b.email ? [b.email] : null) }),
};
// Actions only agents need (their own copy); everyone else on the team reads the real data.
const AGENT_ONLY = new Set(['view', 'crm-boot']);

export const isWorkAction = a => Object.prototype.hasOwnProperty.call(AGENT_ACTIONS, a) || Object.prototype.hasOwnProperty.call(ADMIN_WORK, a);
export const isAdminWork = a => Object.prototype.hasOwnProperty.call(ADMIN_WORK, a);

export async function workPost(user, action, body, isAdmin) {
  const db = getDb();
  if (!user.email) return json({ ok: false, error: 'Your login has no email' }, 403);
  if (isAdminWork(action)) {
    if (!isAdmin) return json({ ok: false, error: 'Admins only' }, 403);
    return ADMIN_WORK[action](db, user, body);
  }
  if (AGENT_ONLY.has(action) && user.role !== 'agent') return json({ ok: false, error: 'For agents only' }, 400);
  return AGENT_ACTIONS[action](db, user, body);
}

// ── WhatsApp Campaigns for agents (api/tailortalk.js asks this before running an agent's op) ──
// View: the campaigns they created ("own"), or every campaign ("all") — in both, only their own
// leads appear in it. Send (when the admin allows it): to their own leads only, never to a typed
// number, never a template change. Returns { refuse } or { filter(result) }.
const CAMPAIGN_VIEW = new Set(['list', 'get', 'settings', 'templates', 'status']);
const CAMPAIGN_SEND = new Set(['create', 'send', 'cancel', 'optout', 'ai-audience']);
async function agentLeadIds(db, user) {
  const me = lc(user.email);
  const col = db.collection('leads');
  const qs = await Promise.all([
    col.where('tenantId', '==', user.tenantId).where('assignedAgent', '==', me).select().get(),
    col.where('tenantId', '==', user.tenantId).where('secondaryAgent', '==', me).select().get(),
    col.where('tenantId', '==', user.tenantId).where('agentAccess', 'array-contains', me).select().get(),
  ]);
  return new Set(qs.flatMap(q => q.docs.map(d => d.id)));
}
export async function agentCampaignGate(db, user, body) {
  const op = String((body && body.op) || '');
  const me = lc(user.email);
  const cfg = effectiveConfig(await loadConfig(db, user.tenantId), me);
  if (!cfg.tabs.includes('campaigns')) return { refuse: 'WhatsApp Campaigns is not part of your access' };
  if (!CAMPAIGN_VIEW.has(op) && !CAMPAIGN_SEND.has(op)) return { refuse: 'Templates and the campaign setup are for the team' };
  if (CAMPAIGN_SEND.has(op) && !cfg.actions.sendCampaigns) return { refuse: 'Sending campaigns is not part of your access' };
  if (op === 'settings' && body.save) return { refuse: 'Campaign settings are for the team' };
  const mine = await agentLeadIds(db, user);
  const ownCampaign = async id => {
    const s = await db.collection('campaigns').doc(String(id || '-')).get();
    return s.exists && s.data().tenantId === user.tenantId && (cfg.campaignsScope === 'all' || lc(s.data().createdBy) === me) ? s.data() : null;
  };
  if (op === 'create') {
    const list = Array.isArray(body.recipients) ? body.recipients : [];
    const bad = list.filter(r => !r || !mine.has(String(r.leadId || '')));
    if (bad.length) return { refuse: `Campaigns go to your own leads only — ${bad.length} of these are not yours` };
  }
  if (op === 'optout' && !mine.has(String(body.leadId || ''))) return { refuse: 'Not your lead' };
  if (op === 'ai-audience' && Array.isArray(body.leads) && body.leads.some(l => l && l.id && !mine.has(String(l.id)))) return { refuse: 'Only your own leads' };
  if (['get', 'status', 'send', 'cancel'].includes(op)) {
    const c = await ownCampaign(body.id);
    if (!c) return { refuse: 'Campaign not found' };
    if (['send', 'cancel'].includes(op) && lc(c.createdBy) !== me) return { refuse: 'Only whoever created a campaign sends or stops it' };
  }
  const keepMine = rec => Object.fromEntries(Object.entries(rec || {}).filter(([k, r]) => !r.manual && mine.has(k)));
  return {
    filter: r => {
      if (!r || r.ok === false) return r;
      if (op === 'list') {
        const campaigns = (r.campaigns || []).filter(c => cfg.campaignsScope === 'all' || lc(c.createdBy) === me)
          .map(c => ({ ...c, leadIds: (c.leadIds || []).filter(id => mine.has(id)) }));
        return { ...r, campaigns };
      }
      if (op === 'get' && r.campaign) return { ...r, campaign: { ...r.campaign, recipients: keepMine(r.campaign.recipients) } };
      if (op === 'settings') return { ok: true, settings: { ...r.settings, lists: [] }, lists: [], quietNow: r.quietNow, marketingHours: r.marketingHours, marketingNow: r.marketingNow, metaReady: false };
      return r;
    },
  };
}
