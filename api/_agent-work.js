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
//   view               my copy, rebuilt when it is older than 30 minutes, the settings changed, a
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
// per agent while they use the site, at most every 30 minutes.
import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from './_bot-shared.js';
import { writeLead, readLeads } from './_lead-views.js';
import * as AA from '../shared-assets/agent-access.js';
import { effectiveConfig, maskPhones, projectProperty } from '../shared-assets/agent-config.js';
import '../dashboard-assets/search-engine.js';
import '../shared-assets/chennai-geo.js';
import '../shared-assets/area-model.js';
import '../shared-assets/match-engine.js';

const PinMatch = globalThis.PinMatch;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const lc = AA.lc;
// An agent's copy is rebuilt when it is older than this (or at once after an assignment, a decision
// or a revoke): ~230 reads a rebuild on the free plan's 50K a day.
const STALE_MS = 30 * 60 * 1000;
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
    // The name an admin set (users/{uid}); never the account's own displayName — anyone can change
    // their own, and a name must never let one teammate pass for another.
    name: nameOf[u.uid] || lc(u.email).split('@')[0],
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
// (a TailorTalk lead's id carries the client's phone number). The reference is the id encrypted with
// a server-only key (AES-256-GCM, its nonce derived from tenant + id so a lead always gets the same
// reference): the server opens it again without reading every lead, and nobody else can.
function refSecret() {
  if (process.env.AGENT_REF_SECRET) return process.env.AGENT_REF_SECRET;
  try { const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}'); if (sa.private_key) return createHash('sha256').update(sa.private_key).digest('hex'); } catch { /* below */ }
  return 'pin-agent-ref-dev';
}
const refKey = () => createHash('sha256').update('agent-ref|' + refSecret()).digest();
export function leadRef(tenantId, leadId) {
  const key = refKey();
  const iv = createHmac('sha256', key).update(tenantId + '|' + leadId).digest().subarray(0, 12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(leadId), 'utf8'), c.final()]);
  return 'm' + Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url');
}
export const REF_RE = /^m[A-Za-z0-9_-]{40,400}$/;
export function leadIdOfRef(tenantId, ref) {
  if (!REF_RE.test(String(ref || ''))) return null;
  try {
    const b = Buffer.from(String(ref).slice(1), 'base64url');
    const iv = b.subarray(0, 12), tag = b.subarray(b.length - 16), ct = b.subarray(12, b.length - 16);
    const d = createDecipheriv('aes-256-gcm', refKey(), iv);
    d.setAuthTag(tag);
    const id = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    // The nonce is bound to the tenant: a reference made for another business does not open here.
    const want = createHmac('sha256', refKey()).update(tenantId + '|' + id).digest().subarray(0, 12);
    return want.equals(iv) ? id : null;
  } catch { return null; }
}

// ── An agent's copy ──
const viewId = (tenantId, uid) => `${tenantId}__${uid}`;

// Who reaches which lead through the agent layer, written on the lead (agentAccess) where it
// changed. The rules let an agent read a lead whose assignedAgent, secondaryAgent or agentAccess
// names them; reassigning a property moves its enquiries with it here.
export async function syncLeadAccess(db, tenantId, { properties, leads, grants, team }) {
  const byCode = AA.agentsByCodeOf(properties);
  const leadGrants = (grants || []).filter(g => g.kind === 'lead');
  // Another agent's client never reaches anyone through a property (a visit, a link): only through
  // an approved request — the promise that a client stays with the agent who brought them.
  const agentEmails = new Set((team || []).filter(u => u.role === 'agent').map(u => u.email));
  let changed = 0;
  const now = Date.now();
  for (const l of leads) {
    const want = AA.leadAccessFor(l, byCode, leadGrants, now, agentEmails);
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

function matchesFor({ tenantId, email, view, properties, leads, cfg, requested, grants }) {
  const fields = cfg.matchingLeadFields || [];
  if (!fields.length || !PinMatch) return [];
  const mineIds = new Set(view.filter(p => p._access === 'own' || p._access === 'co').map(p => String(p.id)));
  if (!mineIds.size) return [];
  const granted = new Set((grants || []).filter(g => g.kind === 'lead' && lc(g.agentEmail) === email && AA.grantLive(g)).map(g => String(g.targetId)));
  const others = leads.filter(l => !AA.leadVisibleTo(l, email) && !granted.has(String(l.id)));
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
  // Without the Properties tab an agent gets no property copy at all (the menu is not the only gate).
  const view = cfg.tabs.includes('properties') ? AA.buildPropertyView({ properties: ctx.properties, grants: ctx.grants, cfg, email: agent.email, now }) : [];
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
  const refusedProps = {};
  // Several requests for one lead (asked, cancelled, asked again): what shows is the most telling —
  // waiting before approved before not approved — and the newest within each.
  const RANK = { pending: 4, approved: 3, rejected: 2, expired: 1, cancelled: 0 };
  reqs.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).forEach(r => {
    if (r.kind === 'lead') { const was = requested.get(r.targetRef); if (!was || (RANK[r.status] || 0) >= (RANK[was] || 0)) requested.set(r.targetRef, r.status); }
    if (r.kind === 'property' && r.status === 'pending') pendingProps[r.targetId] = r.id;
    if (r.kind === 'property' && (r.need || 'details') === 'details') {
      if (r.status === 'rejected') refusedProps[r.targetId] = { note: r.note || '', by: r.decidedByName || '', at: r.decidedAt || 0 };
      else if (r.status === 'pending' || r.status === 'approved') delete refusedProps[r.targetId];
    }
  });
  view.forEach(p => {
    if (pendingProps[p.id]) p._pending = pendingProps[p.id];
    else if (p._access === 'summary' && refusedProps[p.id]) p._refused = refusedProps[p.id];
  });
  const matches = matchesFor({ tenantId, email: agent.email, view, properties: ctx.properties, leads: ctx.leads, cfg, requested, grants: ctx.grants });
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
  // Nobody touched is an agent (an admin moving a property between staff): nothing to rebuild. The
  // enquiries' agentAccess is put right on the next agent's rebuild, and only agents read it.
  if (emails) {
    const team = await teamOf(db, tenantId);
    const agents = new Set(team.filter(u => u.role === 'agent').map(u => u.email));
    if (!emails.map(lc).some(e => agents.has(e))) return 0;
  }
  const ctx = await loadContext(db, tenantId);
  await syncLeadAccess(db, tenantId, ctx);
  const want = emails ? new Set(emails.map(lc)) : null;
  const agents = ctx.team.filter(u => u.role === 'agent' && (!want || want.has(u.email)));
  for (const a of agents) await writeView(db, tenantId, a, ctx);
  return agents.length;
}

// Ask for these agents' copies to be rebuilt the next time they open a page (an agent who GAINED
// something: cheap, one write each). Losing access is rebuilt at once instead (rebuildAgents), so a
// copy that still shows it is never left readable.
export async function markDirty(db, tenantId, emails) {
  const team = await teamOf(db, tenantId);
  const want = new Set((emails || []).map(lc));
  const agents = team.filter(u => u.role === 'agent' && want.has(u.email));
  await Promise.all(agents.map(a => db.collection('agentViews').doc(viewId(tenantId, a.uid)).update({ builtAt: 0 }).catch(() => {})));
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
  // Asked for by hand (Refresh) on a copy that is not otherwise due: at most a few an hour.
  const due = !v || now - (v.builtAt || 0) > STALE_MS || (v.expiresAt || 0) <= now || (v.cfgAt || 0) !== ((cfg && cfg.updatedAt) || 0);
  if (!due && !(await throttle(db, user, 'view-force', 6, 3600000))) return json({ ok: true, builtAt: v.builtAt, fresh: false, throttled: true });
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
    if (g.exists && lc(g.data().agentEmail) === me && AA.grantLive(g.data())) { access = 'granted'; grant = g.data(); fields = AA.contactLive(grant) ? [...cfg.grantedPropertyFields, 'contact'] : cfg.grantedPropertyFields; }
    else if (AA.isActiveProperty(p)) { access = 'summary'; fields = cfg.otherPropertyFields; }
  }
  return { p, access, fields, cfg, grant };
}

async function propertyNotes(db, user, body) {
  const a = await accessTo(db, user, body && body.id);
  if (a.error) return a.error;
  if (user.role === 'agent' && !a.cfg.tabs.includes('properties')) return json({ ok: false, error: 'Properties is not part of your access' }, 403);
  if (user.role === 'agent' && !(await throttle(db, user, 'notes', 120, 3600000))) return json({ ok: false, error: 'Too many at once — try again in a while' }, 429);
  if (!a.access || (a.fields && !a.fields.includes('notes'))) return json({ ok: false, error: 'Notes are not part of your access to this property' }, 403);
  const s = await db.collection('properties').doc(a.p.id).collection('notes').limit(200).get();
  const hideNumbers = !!a.fields && !a.fields.includes('contact');
  const tidy = list => list.map(n => (hideNumbers ? maskPhones(n) : n)).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0)).slice(0, 100);
  const notes = tidy(s.docs.map(d => d.data()));
  // Office-only notes, when "What agents see" includes them for this kind of access.
  let internal = [];
  if (!a.fields || a.fields.includes('internal')) {
    const i = await db.collection('properties').doc(a.p.id).collection('internalNotes').limit(100).get();
    internal = tidy(i.docs.map(d => d.data()));
  }
  return json({ ok: true, notes, internal });
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
  // The change log the dashboard's "Changes to apply" shows (same shape as its own entries,
  // dashboard-assets/app.js recordChanges), so someone copies it to the inventory sheet — the next
  // "Sync from sheet" would otherwise put the old value back.
  const changeId = 'c' + now.toString(36) + randomBytes(3).toString('hex');
  await db.collection('propertyChanges').doc(changeId).set({
    id: changeId, tenantId: user.tenantId, propertyId: a.p.id, propertyCode: a.p.propertyCode || '', propertyName: a.p.name || '',
    propertyLocation: a.p.location || '', propertyType: a.p.type || '', field: 'availability', label: 'Availability',
    from: a.p.availability || '', to: value, kind: 'update', at: now, by: lc(user.email), appliedToSheet: false,
  }).catch(e => console.error('availability change log:', e.message));
  await markDirty(db, user.tenantId, AA.agentsOf(a.p)).catch(() => {});
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
  SUBMIT_FIELDS.forEach(k => { if (f[k] != null) fields[k] = String(f[k]).replace(/[<>]/g, '').trim().slice(0, k === 'notes' ? MAX_TEXT : 300); });
  if (!fields.name) return json({ ok: false, error: 'Give the property a title' }, 400);
  if (fields.photosLink && !/^https:\/\/\S+$/i.test(fields.photosLink)) return json({ ok: false, error: 'The photos link must start with https://' }, 400);
  if (fields.contactNumber && String(fields.contactNumber).replace(/\D/g, '').length < 10) return json({ ok: false, error: 'The owner’s number needs at least 10 digits' }, 400);
  if (!(await throttle(db, user, 'submit', 10, 3600000))) return json({ ok: false, error: 'Too many properties at once — try again in an hour' }, 429);
  // Owners often list with several brokers: the same owner's number, or the same title in the same
  // locality, may already be in the inventory. The agent is told it may be a duplicate (never which
  // one, or whose); the admin sees which.
  const digits = v => String(v || '').replace(/\D/g, '').slice(-10);
  const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const phone = digits(fields.contactNumber);
  const existing = await loadProperties(db, user.tenantId);
  const dupes = existing.filter(p => (phone.length === 10 && digits(p.contactNumber) === phone)
    || (norm(fields.name) && norm(p.name) === norm(fields.name) && (!fields.zone || norm(p.zone) === norm(fields.zone)))).map(p => p.id).slice(0, 5);
  const team = await teamOf(db, user.tenantId);
  const ref = await db.collection('propertySubmissions').add({
    tenantId: user.tenantId, byUid: user.uid, byEmail: me, byName: nameIn(team, me), fields,
    status: 'pending', createdAt: Date.now(), duplicateOf: dupes,
  });
  return json({ ok: true, id: ref.id, possibleDuplicate: dupes.length > 0 });
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
    // "Changes to apply": a new property for the inventory sheet, as the dashboard's own Add writes it
    // (otherwise the next "Sync from sheet" would not know it and the sheet would never have it).
    const changeId = 'c' + now.toString(36) + randomBytes(3).toString('hex');
    await db.collection('propertyChanges').doc(changeId).set({
      id: changeId, tenantId: user.tenantId, propertyId, propertyCode: propertyId, propertyName: f.name || '', propertyLocation: f.location || '',
      propertyType: f.type || '', field: '(property)', label: 'New property added (sourced by ' + (sub.byName || sub.byEmail) + ')', from: '',
      to: `${f.name || ''} — ${f.location || f.zone || ''}`, kind: 'create', at: now, by: lc(user.email), appliedToSheet: false,
    }).catch(e => console.error('submission change log:', e.message));
    await db.collection('assignmentLog').add({ tenantId: user.tenantId, propertyId, propertyName: f.name || '', at: now, by: lc(user.email),
      from: { primary: null, co: [] }, to: { primary: sub.byEmail, co: [] }, why: 'Added by the agent, approved' });
  }
  await ref.update({ status: decision, decidedBy: lc(user.email), decidedAt: Date.now(), note, propertyId });
  if (propertyId) await markDirty(db, user.tenantId, [sub.byEmail]).catch(() => {});
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
  // Someone who has since become one of its agents sees it as an agent: their old grant is moot.
  const agentsNow = new Set(AA.agentsOf(p));
  const grants = g.docs.map(d => ({ ...d.data(), id: d.id })).map(x => ({ id: x.id, agentEmail: x.agentEmail, agentName: x.agentName, grantedBy: x.grantedBy,
    grantedByName: x.grantedByName, grantedAt: x.grantedAt, expiresAt: x.expiresAt, contactExpiresAt: x.contactExpiresAt,
    live: AA.grantLive(x, now) && !agentsNow.has(lc(x.agentEmail)), contactLive: AA.contactLive(x, now), revokedAt: x.revokedAt || null })).sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0));
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
  // Anyone with an active login — and anyone already on the property (a login switched off since
  // must not block changing the others).
  const known = new Set([...team.filter(u => u.active).map(u => u.email), ...AA.agentsOf(p)]);
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
  // Whoever lost the property loses it now (their copy is rebuilt at once); whoever gained it gets it
  // the next time they open a page — so assigning many properties in a row costs one rebuild each,
  // not one per click.
  await refreshApprovers(db, user.tenantId, { propertyId: p.id }).catch(e => console.error('approvers after assign:', e.message));
  const was = [before.primary, ...before.co].filter(Boolean), is = [after.primary, ...after.co].filter(Boolean);
  const lost = was.filter(e => !is.includes(e)), gained = is.filter(e => !was.includes(e));
  if (lost.length) await rebuildAgents(db, user.tenantId, lost).catch(e => console.error('rebuild after assign:', e.message));
  if (gained.length) await markDirty(db, user.tenantId, gained).catch(() => {});
  return json({ ok: true, ...patch });
}

// ── Leads an agent works ──
// What a page may never change on a lead through here: who it belongs to, the server's own fields,
// its identity, its number and opt-outs (a changed number would dodge the team's duplicate check and
// the campaign opt-out list — an admin corrects a number). The board's AI suggestion bookkeeping
// (ai.suggestion / ai.dismissed / ai.lastMove) is allowed; the rest of ai is the server's.
const LEAD_LOCKED = new Set(['tenantId', 'id', 'assignedAgent', 'secondaryAgent', 'agentsSetAt', 'agentsSetBy', 'agentAccess',
  'tt', 'ttState', 'calendarEventId', 'calendarEventOwner', 'phone', 'phoneKey', 'createdAt', 'createdBy', 'notes', 'history',
  'aiSummary', 'aiSummaryAt', 'aiSummaryError', 'listingId', 'waOptOut', 'waMarketingOptOut',
  'campaignLog', 'campaignReply']);
const SEG = /^[A-Za-z0-9_\-]{1,80}$/;
// Text from an agent can never become markup on a colleague's screen: angle brackets are dropped
// from every string they write (the pages escape what they show, too — this is the second lock).
export function plainText(v) {
  if (typeof v === 'string') return v.replace(/[<>]/g, '');
  if (Array.isArray(v)) return v.map(plainText);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = plainText(x); return o; }
  return v;
}
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
    // "Who did it" is always the person asking (followUpBy, siteVisitBy, stageChangedBy…): a visit
    // can never be booked into a colleague's calendar under their name.
    let value = seg.length === 1 && /By$/.test(top) && v ? me : plainText(v === undefined ? null : v);
    // An @mention is always from the person writing it (never "Thirumal mentioned you").
    if (top === 'mentions' && value && typeof value === 'object') {
      if (seg.length === 1) value = Object.fromEntries(Object.entries(value).map(([k, x]) => [k, x && typeof x === 'object' ? { ...x, by: me } : x]));
      else if (seg.length === 2) value = { ...value, by: me };
    }
    if (top === 'mentions' && seg.length === 3 && seg[2] === 'by') value = me;
    patch[seg.join('.')] = value;
  }
  if (Object.keys(patch).length) { patch.updatedAt = Date.now(); patch.updatedBy = me; }
  return { patch, refused };
}

// A running grant (an approved request) for this agent on a lead — read-only access, checked on the
// grant itself (the rules do the same), so it ends the minute its timer does or it is taken back.
async function liveLeadGrant(db, user, leadId) {
  const me = lc(user.email);
  const g = await db.collection('grants').doc(AA.grantId(user.tenantId, 'lead', leadId, me)).get();
  return g.exists && lc(g.data().agentEmail) === me && AA.grantLive(g.data()) ? g.data() : null;
}

// The lead, if this person may see it — and, with { work: true }, may change it. A lead an agent
// cannot see answers exactly like one that does not exist (no way to test whether a number is a lead).
async function leadFor(db, user, id, { work = false } = {}) {
  const missing = { error: json({ ok: false, error: 'No such lead' }, 404) };
  if (!id || typeof id !== 'string' || id.includes('/')) return missing;
  const ref = db.collection('leads').doc(id);
  const s = await ref.get();
  if (!s.exists || s.data().tenantId !== user.tenantId) return missing;
  const lead = { ...s.data(), id: s.id };
  if (user.role === 'agent') {
    const visible = AA.leadVisibleTo(lead, user.email) || !!(await liveLeadGrant(db, user, lead.id));
    if (!visible) return missing;
    if (work && !AA.canWorkLead(lead, user.email)) return { error: json({ ok: false, readOnly: true, error: 'You can read this lead, but it is with another agent — ask them or an admin to change it' }, 403) };
  }
  return { ref, lead };
}

async function leadSave(db, user, body) {
  if (body && body.mode === 'delete') return json({ ok: false, error: 'Ask an admin to delete a lead' }, 403);
  const { error, ref, lead } = await leadFor(db, user, body && body.id, { work: true });
  if (error) return error;
  const me = lc(user.email);
  const { patch, refused } = leadPatchFrom(body || {}, me);
  // Which properties an enquiry is about decides which agents reach it: on a lead that is not their
  // own (an unassigned enquiry on their property), an agent cannot change that.
  // Visit replies are written by the server from Google (who accepted, who declined); from an agent's
  // page only the fresh "still to answer" list a new booking makes — never a colleague's answer.
  if (user.role === 'agent' && 'siteVisitReplies' in patch) {
    const v = patch.siteVisitReplies;
    if (!(Array.isArray(v) && v.every(e => e && typeof e === 'object' && e.status === 'needsAction'))) delete patch.siteVisitReplies;
  }
  const ownLead = lc(lead.assignedAgent) === me || lc(lead.secondaryAgent) === me;
  if (user.role === 'agent' && !ownLead) Object.keys(patch).filter(k => k.split('.')[0] === 'propertyCodes' || k.split('.')[0] === 'unlinkedPropertyIds').forEach(k => { delete patch[k]; refused.push(k); });
  if (!Object.keys(patch).filter(k => k !== 'updatedAt' && k !== 'updatedBy').length) return json({ ok: true, unchanged: true, refused });
  await writeLead(db, user.tenantId, ref, patch, 'update');
  // A visit on someone else's property, marked done or called off from the lead: its agents hear.
  const after = { ...lead };
  Object.entries(patch).forEach(([k, v]) => { if (!k.includes('.')) after[k] = v; });
  await visitAlert(db, user, lead, after).catch(e => console.error('visit alert:', e.message));
  return json({ ok: true, refused });
}

const NOTE_KEYS = ['id', 'text', 'createdAt', 'by', 'kind', 'pinned', 'editedAt', 'mentions'];
const ID_RE = /^[A-Za-z0-9_\-]{1,60}$/;
async function leadNote(db, user, body) {
  // Notes feed the lead's AI reading: only on a lead the agent works, never on one they only read.
  const { error, ref } = await leadFor(db, user, body && body.id, { work: true });
  if (error) return error;
  const n = (body && body.note) || {};
  const note = {};
  NOTE_KEYS.forEach(k => { if (n[k] !== undefined) note[k] = plainText(n[k]); });
  if (!note.id || !ID_RE.test(String(note.id))) return json({ ok: false, error: 'Bad note' }, 400);
  note.text = String(note.text || '').slice(0, 8000);
  note.by = lc(user.email);
  const existing = await ref.collection('notes').doc(note.id).get();
  if (existing.exists && lc(existing.data().by) !== note.by) return json({ ok: false, error: 'Only whoever wrote a note can change it' }, 403);
  note.createdAt = existing.exists ? (existing.data().createdAt || Date.now()) : Date.now();
  if (existing.exists) note.editedAt = Date.now();
  await ref.collection('notes').doc(note.id).set(note);
  return json({ ok: true });
}
async function leadNoteDelete(db, user, body) {
  const { error, ref } = await leadFor(db, user, body && body.id, { work: true });
  if (error) return error;
  const id = String((body && body.noteId) || '');
  if (!ID_RE.test(id)) return json({ ok: false, error: 'Bad note' }, 400);
  const s = await ref.collection('notes').doc(id).get();
  if (s.exists && lc(s.data().by) !== lc(user.email)) return json({ ok: false, error: 'Only whoever wrote a note can delete it' }, 403);
  if (s.exists) await ref.collection('notes').doc(id).delete();
  return json({ ok: true });
}
// A history line is shown as HTML on the lead (bold names and values): from an agent, everything is
// escaped except <b></b>, its id is new (never another line's), and its time is the server's.
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export const historyHtml = t => esc(String(t || '').slice(0, 2000)).replace(/&lt;(\/?)b&gt;/g, '<$1b>');
async function leadHistory(db, user, body) {
  const { error, ref } = await leadFor(db, user, body && body.id, { work: true });
  if (error) return error;
  const e = (body && body.event) || {};
  if (!e.id || !ID_RE.test(String(e.id))) return json({ ok: false, error: 'Bad event' }, 400);
  const me = lc(user.email);
  const doc = ref.collection('history').doc(String(e.id));
  const existing = await doc.get();
  if (existing.exists && lc(existing.data().by) !== me) return json({ ok: false, error: 'That history line is someone else’s' }, 403);
  const event = { id: String(e.id), type: String(e.type || 'note').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'note', text: historyHtml(e.text), at: Date.now(), by: me };
  await doc.set(event);
  return json({ ok: true });
}

const LEAD_NEW_FIELDS = ['channel', 'name', 'phone', 'email', 'enquiryType', 'propertyInterest', 'budget', 'propertyCodes', 'source', 'stageId',
  'detailsSent', 'contactAt', 'followUpAt', 'followUpNote', 'lastActionType', 'reached', 'noteCount', 'lastNote'];
const keyOfPhone = raw => { const d = String(raw || '').replace(/\D/g, ''); return !d ? '' : d.length === 10 ? '91' + d : d.length === 11 && d[0] === '0' ? '91' + d.slice(1) : d; };
async function leadAdd(db, user, body) {
  const me = lc(user.email);
  const cfg = effectiveConfig(await loadConfig(db, user.tenantId), me);
  if (user.role === 'agent' && !cfg.actions.addLeads) return json({ ok: false, error: 'Adding leads is not part of your access' }, 403);
  const src = (body && body.lead) || {};
  const id = String(src.id || '');
  if (!/^lead_\d{10,16}$/.test(id)) return json({ ok: false, error: 'Bad lead' }, 400);
  const key = keyOfPhone(src.phone);
  if (!key || key.length < 10) return json({ ok: false, error: 'Enter the client’s phone number' }, 400);
  if (!(await throttle(db, user, 'lead-add', 40, 3600000))) return json({ ok: false, error: 'Too many new leads at once — try again in a while' }, 429);
  // The whole team's leads, not only the agent's: a number already with someone is not added twice.
  // Who has it is not said — that would hand over another agent's client. One indexed lookup (every
  // lead carries phoneKey); the lead views only if that lookup cannot run.
  let dup = null;
  try {
    const q = await db.collection('leads').where('tenantId', '==', user.tenantId).where('phoneKey', '==', key).limit(1).get();
    dup = q.empty ? null : { ...q.docs[0].data(), id: q.docs[0].id };
  } catch (e) {
    dup = (await readLeads(db, user.tenantId)).find(l => keyOfPhone(l.phone) === key) || null;
  }
  if (dup) {
    const mine = AA.leadVisibleTo(dup, me);
    return json({ ok: false, duplicate: true, mine, leadId: mine ? dup.id : null,
      error: mine ? 'You already have this client as a lead' : 'This number is already with the team. Ask an admin if this client should be yours.' }, 409);
  }
  const ref = db.collection('leads').doc(id);
  if ((await ref.get()).exists) return json({ ok: false, error: 'That lead already exists' }, 409);
  const now = Date.now();
  const lead = { id, tenantId: user.tenantId };
  LEAD_NEW_FIELDS.forEach(k => { if (src[k] !== undefined) lead[k] = plainText(src[k]); });
  if (lead.propertyCodes && !Array.isArray(lead.propertyCodes)) delete lead.propertyCodes;
  Object.assign(lead, { phoneKey: key, assignedAgent: me, secondaryAgent: null, agentsSetAt: now, agentsSetBy: me,
    createdAt: now, updatedAt: now, createdBy: me, updatedBy: me, source: lead.source || 'manual' });
  await writeLead(db, user.tenantId, ref, lead, 'merge');
  return json({ ok: true, id });
}

// ── Rate limits ──
// The free plan's 50K reads a day are the whole team's: a script hammering an expensive action must
// not take the site down for everyone. At most `limit` calls of one kind per person per window.
// One read and one write per call; if it cannot check (a burst of calls at once), it refuses.
export async function throttle(db, user, kind, limit, windowMs) {
  const ref = db.collection('agentThrottle').doc(`${user.tenantId}__${user.uid}`);
  for (let attempt = 0; attempt < 3; attempt++) try {
    return await db.runTransaction(async t => {
      const s = await t.get(ref);
      const now = Date.now();
      const list = ((s.exists && s.data()[kind]) || []).filter(x => now - x < windowMs);
      if (list.length >= limit) return false;
      list.push(now);
      t.set(ref, { [kind]: list.slice(-limit) }, { merge: true });
      return true;
    });
  } catch (e) { /* contention: try again */ }
  // Could not check (many calls at once): refused, so a burst cannot slip past the limit.
  return false;
}

// ── Requests, approvals and grants ──
// key: what makes two threads the same one (default: what they are about + who is in them).
async function threadFor(db, tenantId, { type, linkedId, title, members, by, team, key }) {
  const mem = [...new Set(members.map(lc).filter(Boolean))].sort();
  const id = `${tenantId}__${type}__${createHash('sha1').update((key != null ? String(key) : String(linkedId || '')) + '|' + mem.join(',')).digest('hex').slice(0, 16)}`;
  const ref = db.collection('threads').doc(id);
  const s = await ref.get();
  if (s.exists) return { id, ref, created: false, data: s.data() };
  const now = Date.now();
  const names = {};
  mem.forEach(e => { names[AA.emailKey(e)] = nameIn(team, e); });
  const data = { tenantId, title: plainText(String(title || '')).slice(0, 120), type, linkedId: linkedId || null, members: mem, names,
    createdBy: lc(by), createdAt: now, lastAt: now, lastText: '', lastBy: null, reads: {} };
  await ref.set(data);
  return { id, ref, created: true, data };
}
// A line in a thread written by the system ("Approved by Swami"). Unread is worked out by each page
// (the last message is newer than their read mark), so nobody writes anyone else's counter.
// readBy: whoever caused it has read it already (their own request, their own decision).
export async function systemMessage(db, threadRef, members, text, extra, readBy) {
  const now = Date.now();
  const b = db.batch();
  b.set(threadRef.collection('messages').doc(), { kind: 'system', text: String(text).slice(0, 1000), at: now, by: null, ...(extra || {}) });
  b.update(threadRef, { lastAt: now, lastText: String(text).slice(0, 140), lastBy: null, ...(readBy ? { ['reads.' + AA.emailKey(readBy)]: now + 1 } : {}) });
  await b.commit();
}
async function systemLineFor(db, threadId, text, extra, readBy) {
  if (!threadId) return;
  const th = db.collection('threads').doc(threadId);
  const ts = await th.get();
  if (ts.exists) await systemMessage(db, th, ts.data().members || [], text, extra, readBy).catch(() => {});
}
// Change one agent's copy in place (cheap: one read, one write) for what only touches their own
// requests — the "asked" marks — instead of rebuilding it.
async function patchView(db, tenantId, uid, fn) {
  const ref = db.collection('agentViews').doc(viewId(tenantId, uid));
  try {
    await db.runTransaction(async t => {
      const s = await t.get(ref);
      if (!s.exists) return;
      const d = s.data();
      if (fn(d) !== false) t.update(ref, { props: d.props || [], matches: d.matches || [] });
    });
  } catch (e) { /* the next rebuild puts it right */ }
}
const markAsked = (r, value) => d => {
  if (r.kind === 'property') (d.props || []).forEach(p => { if (String(p.id) === String(r.targetId)) { if (value) p._pending = value; else delete p._pending; } });
  else (d.matches || []).forEach(m => { if (m.ref === r.targetRef) m.requested = value; });
};
// Who may decide a request NOW: worked out from the property (or lead) as it is at the moment of
// deciding, not when the agent asked — a primary agent replaced since cannot approve any more, the
// new one can. Admins always may.
async function currentApprovers(db, t, r, cfgDoc, admins) {
  const cfg = effectiveConfig(cfgDoc, r.requesterEmail);
  if (r.kind === 'lead') {
    const ps = await t.get(db.collection('requestPrivate').doc(r._id));
    const leadId = ps.exists ? ps.data().leadId : null;
    const ls = leadId ? await t.get(db.collection('leads').doc(leadId)) : null;
    const lead = ls && ls.exists ? { ...ls.data(), id: ls.id } : null;
    return { lead, leadId, approvers: AA.approversFor({ kind: 'lead', lead, approvers: cfg.approvals.approvers, admins, requester: r.requesterEmail }), cfg };
  }
  const pr = await t.get(db.collection('properties').doc(r.targetId));
  const property = pr.exists ? { ...pr.data(), id: pr.id } : null;
  return { property, approvers: AA.approversFor({ kind: 'property', property, approvers: cfg.approvals.approvers, admins, requester: r.requesterEmail }), cfg };
}
const NEEDS = ['details', 'time', 'number'];

async function request(db, user, body) {
  const me = lc(user.email);
  const kind = body && body.kind === 'lead' ? 'lead' : 'property';
  let need = NEEDS.includes(body && body.need) ? body.need : 'details';
  const reason = plainText(String((body && body.reason) || '')).trim().slice(0, 500);
  const visitAt = Number(body && body.visitAt) || null;
  if (user.role === 'agent' && !(await throttle(db, user, 'request', 20, 3600000))) return json({ ok: false, error: 'Too many requests in an hour — try again later' }, 429);
  const team = await teamOf(db, user.tenantId);
  const cfg = effectiveConfig(await loadConfig(db, user.tenantId), me);
  const admins = adminsOf(team);
  let title, approvers, targetId, targetCode = null, targetRef = null, privateLead = null;
  if (kind === 'property') {
    if (user.role === 'agent' && !cfg.tabs.includes('properties')) return json({ ok: false, error: 'Properties is not part of your access' }, 403);
    const p = await getProperty(db, user.tenantId, body.targetId);
    const gs = p ? await db.collection('grants').doc(AA.grantId(user.tenantId, 'property', p.id, me)).get() : null;
    const grant = gs && gs.exists && lc(gs.data().agentEmail) === me ? gs.data() : null;
    const live = AA.grantLive(grant);
    // A property they cannot see at all answers like one that does not exist.
    if (!p || (!AA.isActiveProperty(p) && !live && !AA.roleOn(p, me))) return json({ ok: false, error: 'No such property' }, 404);
    if (AA.roleOn(p, me)) return json({ ok: false, error: 'This is already your property' }, 400);
    if (!live) need = 'details';
    else if (need === 'details') return json({ ok: false, error: 'You already have this property’s details — ask for more time or for the owner’s number instead' }, 400);
    else if (need === 'number' && AA.contactLive(grant)) return json({ ok: false, error: 'You already have the owner’s number' }, 400);
    targetId = p.id; title = p.name || p.id; targetCode = p.propertyCode || p.id;   // shown to everyone on the request
    approvers = AA.approversFor({ kind, property: p, approvers: cfg.approvals.approvers, admins, requester: me });
  } else {
    // A matching lead, named by its reference — opened again here, never sent by id.
    need = 'details';
    const ref = String(body.ref || '');
    const leadId = leadIdOfRef(user.tenantId, ref);
    const ls = leadId ? await db.collection('leads').doc(leadId).get() : null;
    if (!ls || !ls.exists || ls.data().tenantId !== user.tenantId) return json({ ok: false, error: 'That lead is no longer there' }, 404);
    const lead = { ...ls.data(), id: ls.id };
    if (AA.leadVisibleTo(lead, me)) return json({ ok: false, error: 'This lead is already yours' }, 400);
    if (await liveLeadGrant(db, user, lead.id)) return json({ ok: false, error: 'You already have this lead’s details' }, 400);
    targetId = ref; targetRef = ref; privateLead = { leadId: lead.id, leadName: lead.name || '' };
    title = 'Lead: ' + (AA.requirementOf(lead) ? AA.scrubText(AA.requirementOf(lead), [lead.name]).slice(0, 60) : 'matching buyer');
    approvers = AA.approversFor({ kind, lead, approvers: cfg.approvals.approvers, admins, requester: me });
  }
  if (!approvers.length) return json({ ok: false, error: 'Nobody can approve this yet — ask an admin' }, 400);
  const open = await db.collection('accessRequests').where('tenantId', '==', user.tenantId).where('requesterEmail', '==', me)
    .where('targetId', '==', targetId).where('status', '==', 'pending').limit(1).get();
  if (!open.empty) return json({ ok: false, error: 'You already asked — it is waiting for a decision', id: open.docs[0].id }, 409);
  // The client this is for: one of the agent's own leads. Only the first name travels — the lead's id
  // can carry the client's number, and the approver must not get it.
  let clientName = '';
  if (body.clientLeadId) {
    const c = await leadFor(db, user, String(body.clientLeadId), { work: true });
    if (c.error) return json({ ok: false, error: 'Pick one of your own leads as the client' }, 400);
    clientName = String(c.lead.name || '').trim().split(/\s+/)[0].slice(0, 40);
  }
  const now = Date.now();
  const reqRef = db.collection('accessRequests').doc();
  const what = need === 'time' ? 'more time on ' + title : need === 'number' ? 'the owner’s number for ' + title : kind === 'lead' ? 'this lead’s details' : 'the details of ' + title;
  const thread = await threadFor(db, user.tenantId, { type: 'access_request', linkedId: reqRef.id,
    title: `${need === 'time' ? 'More time' : need === 'number' ? 'Owner’s number' : 'Access'}: ${title.slice(0, 60)}${clientName ? ' · for ' + clientName : ''}`, members: [me, ...approvers], by: me, team });
  const req = {
    tenantId: user.tenantId, kind, need, targetId, targetCode, targetRef, title,
    requesterUid: user.uid, requesterEmail: me, requesterName: nameIn(team, me),
    clientName, reason, visitAt,
    approvers, status: 'pending', createdAt: now, threadId: thread.id,
    history: [{ at: now, by: me, what: 'asked', note: reason || null }],
  };
  const b = db.batch();
  b.set(reqRef, req);
  if (privateLead) b.set(db.collection('requestPrivate').doc(reqRef.id), { tenantId: user.tenantId, approvers, ...privateLead });
  await b.commit();
  await systemMessage(db, thread.ref, thread.data.members, `${req.requesterName} asked for ${what}${clientName ? ' for their client ' + clientName : ''}${reason ? ': “' + reason + '”' : ''}`, { requestId: reqRef.id }, me);
  if (user.role === 'agent') await patchView(db, user.tenantId, user.uid, markAsked(req, kind === 'lead' ? 'pending' : reqRef.id));
  return json({ ok: true, id: reqRef.id, threadId: thread.id });
}

const fmtWhen = t => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).replace(/\b(am|pm)\b/g, m => m.toUpperCase());

async function decide(db, user, body) {
  const me = lc(user.email);
  const ref = db.collection('accessRequests').doc(String((body && body.id) || '_'));
  const decision = body && body.decision === 'approve' ? 'approved' : body && body.decision === 'reject' ? 'rejected' : null;
  if (!decision) return json({ ok: false, error: 'Approve or reject' }, 400);
  const note = plainText(String(body.note || '')).trim().slice(0, 500);
  if (decision === 'rejected' && !note) return json({ ok: false, error: 'Say why — the agent sees it' }, 400);
  const team = await teamOf(db, user.tenantId);
  const admins = adminsOf(team);
  const cfgDoc = await loadConfig(db, user.tenantId);
  const isAdmin = user.role === 'admin' && user.email_verified === true;
  const now = Date.now();
  const coAgent = body.coAgent === true;
  let result;
  try {
    result = await db.runTransaction(async t => {
      const s = await t.get(ref);
      if (!s.exists || s.data().tenantId !== user.tenantId) throw Object.assign(new Error('No such request'), { http: 404 });
      const r = { ...s.data(), _id: s.id };
      // First decision wins: whoever is second sees who decided, and when.
      const lastNote = ((r.history || []).slice(-1)[0] || {}).note;
      if (r.status !== 'pending') throw Object.assign(new Error(r.status === 'cancelled' ? (lastNote === 'access taken back' ? 'Their access was taken back, so this request was closed' : 'The agent cancelled this request') : r.status === 'expired' ? 'This request expired — the agent can ask again' : `Already ${r.status} by ${r.decidedByName || r.decidedBy}`), { http: 409, request: r });
      if (r.requesterEmail === me) throw Object.assign(new Error('You cannot decide your own request'), { http: 403 });
      const cur = await currentApprovers(db, t, r, cfgDoc, admins);
      if (!isAdmin && !cur.approvers.includes(me)) throw Object.assign(new Error('You can’t decide this request — the property (or lead) is no longer yours'), { http: 403 });
      const need = NEEDS.includes(r.need) ? r.need : 'details';
      const patch = { status: decision, decidedBy: me, decidedByName: nameIn(team, me), decidedAt: now, note,
        approvers: cur.approvers, history: FieldValue.arrayUnion({ at: now, by: me, what: decision, note: note || null }) };
      if (decision === 'approved') {
        // Timers: the details (none = no limit) and, separately, the owner's number — which always has
        // one (the settings' default when the sheet sent none).
        const expiresAt = AA.timerEnd({ days: body.days, until: body.until }, now);
        const shareContact = r.kind === 'property' && (need === 'number' || body.shareContact === true);
        const contactUntil = shareContact ? AA.timerEnd(body.contactUntil != null ? { until: body.contactUntil } : { hours: body.hours != null ? body.hours : cur.cfg.approvals.contactHours }, now) : null;
        if (expiresAt === undefined || contactUntil === undefined) throw Object.assign(new Error('Pick a timer from the list, or a time in the future'), { http: 400 });
        if (r.kind === 'lead' && !cur.lead) throw Object.assign(new Error('That lead is no longer there'), { http: 404 });
        if (r.kind === 'property' && !cur.property) throw Object.assign(new Error('That property is no longer there'), { http: 404 });
        const property = cur.property;
        if (coAgent && r.kind === 'property' && need === 'details') {
          // Making them a co-agent is for the property's primary agent or an admin.
          if (!(isAdmin || AA.primaryOf(property) === me)) throw Object.assign(new Error('Only the primary agent or an admin can add a co-agent'), { http: 403 });
          const co = [...AA.coAgentsOf(property), r.requesterEmail];
          const ap = AA.assignmentPatch(AA.primaryOf(property), co);
          t.update(db.collection('properties').doc(property.id), { ...ap, agentsSetAt: now, agentsSetBy: me });
          t.set(db.collection('assignmentLog').doc(), { tenantId: user.tenantId, propertyId: property.id, propertyName: property.name || '', at: now, by: me,
            from: { primary: AA.primaryOf(property) || null, co: AA.coAgentsOf(property) }, to: { primary: ap.assignedAgent, co: ap.secondaryAgents },
            why: 'Collaboration approved (request ' + ref.id + ')' });
          patch.terms = { coAgent: true };
        } else {
          const targetId = r.kind === 'lead' ? cur.leadId : r.targetId;
          const grantRef = db.collection('grants').doc(AA.grantId(user.tenantId, r.kind, targetId, r.requesterEmail));
          const gs = await t.get(grantRef);
          const old = gs.exists && lc(gs.data().agentEmail) === r.requesterEmail ? gs.data() : null;
          const histLine = { at: now, by: me, what: need === 'time' ? 'extended' : need === 'number' ? 'number-shared' : 'granted', requestId: ref.id };
          // More time or the owner's number only add to access that is still running: access that ran
          // out or was taken back meanwhile is never brought back by them (the agent asks again).
          if (need !== 'details' && !(old && AA.grantLive(old, now))) {
            t.update(ref, { status: 'expired', decidedAt: now, decidedBy: me, history: FieldValue.arrayUnion({ at: now, by: me, what: 'expired', note: 'access had ended' }) });
            throw Object.assign(new Error('Their access to this property has ended (or was taken back) — they need to ask for the details again'), { http: 409, commit: true });
          }
          if (old && AA.grantLive(old) && need === 'time') {
            t.update(grantRef, { expiresAt: expiresAt == null ? null : expiresAt, history: FieldValue.arrayUnion(histLine) });
            patch.terms = { until: expiresAt == null ? null : expiresAt, contact: AA.contactLive(old), contactUntil: old.contactExpiresAt || null, extended: true };
          } else if (old && AA.grantLive(old) && need === 'number') {
            t.update(grantRef, { includeContact: true, contactExpiresAt: contactUntil, history: FieldValue.arrayUnion(histLine) });
            patch.terms = { until: old.expiresAt || null, contact: true, contactUntil };
          } else {
            const grant = { tenantId: user.tenantId, kind: r.kind, targetId, targetRef: r.targetRef || null, title: r.title, agentUid: r.requesterUid, agentEmail: r.requesterEmail,
              agentName: r.requesterName, requestId: ref.id, grantedBy: me, grantedByName: nameIn(team, me), grantedAt: now, active: true,
              expiresAt: expiresAt == null ? null : expiresAt, includeContact: shareContact, contactExpiresAt: shareContact ? contactUntil : null,
              revokedBy: null, revokedAt: null, revokeReason: null,
              history: [...((old && old.history) || []), histLine].slice(-50) };
            t.set(grantRef, grant);
            patch.terms = { until: grant.expiresAt, contact: grant.includeContact, contactUntil: grant.contactExpiresAt };
          }
          patch.grantId = grantRef.id;
        }
      }
      t.update(ref, patch);
      return { r, patch, need };
    });
  } catch (e) {
    if (e.http) {
      if (e.commit) await ref.update({ status: 'expired', decidedAt: now, decidedBy: me, history: FieldValue.arrayUnion({ at: now, by: me, what: 'expired', note: 'access had ended' }) }).catch(() => {});
      return json({ ok: false, error: e.message, current: e.request ? e.request.status : undefined }, e.http);
    }
    throw e;
  }
  const { r, patch, need } = result;
  const who = nameIn(team, me);
  let line;
  if (decision === 'rejected') line = `Rejected by ${who}: “${note}”`;
  else if (patch.terms && patch.terms.coAgent) line = `Approved by ${who} — ${r.requesterName} is now a co-agent on ${r.title}`;
  else if (need === 'time') line = `More time approved by ${who} — details ${patch.terms.until ? 'until ' + fmtWhen(patch.terms.until) : 'with no time limit'}` + (note ? `. “${note}”` : '');
  else if (need === 'number') line = `Owner’s number shared by ${who} until ${fmtWhen(patch.terms.contactUntil)}` + (note ? `. “${note}”` : '');
  else line = `Approved by ${who} — details ${patch.terms.until ? 'until ' + fmtWhen(patch.terms.until) : 'with no time limit'}`
    + (patch.terms.contact ? `; owner’s number until ${fmtWhen(patch.terms.contactUntil)}` : '') + (note ? `. “${note}”` : '');
  await systemLineFor(db, r.threadId, line, { requestId: ref.id }, me);
  // Approved: their copy is rebuilt now, so it opens at once. Rejected: only the "asked" mark changes.
  if (decision === 'approved') await rebuildAgents(db, user.tenantId, [r.requesterEmail]).catch(e => console.error('rebuild after decide:', e.message));
  else await patchView(db, user.tenantId, r.requesterUid, d => {
    markAsked(r, r.kind === 'lead' ? 'rejected' : null)(d);
    // The locked card says so at once (not after the next rebuild).
    if (r.kind === 'property' && (r.need || 'details') === 'details') (d.props || []).forEach(p => { if (String(p.id) === String(r.targetId) && p._access === 'summary') p._refused = { note, by: who, at: Date.now() }; });
  });
  return json({ ok: true, status: decision, grantId: patch.grantId || null });
}

async function cancel(db, user, body) {
  const me = lc(user.email);
  const ref = db.collection('accessRequests').doc(String((body && body.id) || '_'));
  let r;
  try {
    r = await db.runTransaction(async t => {
      const s = await t.get(ref);
      if (!s.exists || s.data().tenantId !== user.tenantId) throw Object.assign(new Error('No such request'), { http: 404 });
      const x = s.data();
      if (x.requesterEmail !== me) throw Object.assign(new Error('Only whoever asked can cancel'), { http: 403 });
      if (x.status !== 'pending') throw Object.assign(new Error('Already ' + x.status), { http: 409 });
      t.update(ref, { status: 'cancelled', decidedAt: Date.now(), decidedBy: me, history: FieldValue.arrayUnion({ at: Date.now(), by: me, what: 'cancelled' }) });
      return x;
    });
  } catch (e) { if (e.http) return json({ ok: false, error: e.message }, e.http); throw e; }
  await systemLineFor(db, r.threadId, `${r.requesterName} cancelled the request`, null, me);
  await patchView(db, user.tenantId, user.uid, markAsked(r, r.kind === 'lead' ? 'cancelled' : null));
  return json({ ok: true });
}

// Take back, hide the owner's number, or extend — admins (on the dashboard, in Requests). The
// request it came from says so too, so nobody reads "approved" on access that was taken back.
async function grantChange(db, user, body, what) {
  const ref = db.collection('grants').doc(String((body && body.grantId) || '_'));
  const s = await ref.get();
  if (!s.exists || s.data().tenantId !== user.tenantId) return json({ ok: false, error: 'No such access' }, 404);
  const g = s.data();
  const me = lc(user.email);
  const now = Date.now();
  const team = await teamOf(db, user.tenantId);
  // Who may end, narrow or extend it: an admin; the property's primary agent (or the lead's agent);
  // whoever approved it may end or narrow it too — an approval given in one tap can be taken back.
  const isAdmin = user.role === 'admin' && user.email_verified === true;
  if (!isAdmin) {
    let owner = false;
    if (g.kind === 'property') { const p = await getProperty(db, user.tenantId, g.targetId); owner = !!p && AA.primaryOf(p) === me; }
    else { const ls = await db.collection('leads').doc(String(g.targetId)).get(); owner = ls.exists && lc(ls.data().assignedAgent) === me; }
    const allowed = owner || (what !== 'extend' && lc(g.grantedBy) === me);
    if (!allowed) return json({ ok: false, error: 'Only an admin, the property’s primary agent or whoever approved it can change this' }, 403);
  }
  let line, reqPatch;
  if (what === 'revoke') {
    if (!g.active) return json({ ok: true, unchanged: true });
    const reason = plainText(String(body.reason || '')).trim().slice(0, 300);
    await ref.update({ active: false, revokedBy: me, revokedAt: now, revokeReason: reason || null, history: FieldValue.arrayUnion({ at: now, by: me, what: 'revoked', note: reason || null }) });
    line = `${nameIn(team, me)} took back access to ${g.title}${reason ? ': “' + reason + '”' : ''}`;
    // Their waiting asks for more time or the number on it end with it.
    const open = await db.collection('accessRequests').where('tenantId', '==', user.tenantId).where('requesterEmail', '==', lc(g.agentEmail))
      .where('status', '==', 'pending').get().catch(() => null);
    if (open) for (const d of open.docs) {
      const r = d.data();
      if (r.need === 'time' || r.need === 'number') {
        const target = g.kind === 'lead' ? r.targetRef : r.targetId;
        if (String(target) === String(g.kind === 'lead' ? g.targetRef : g.targetId)) await d.ref.update({ status: 'cancelled', decidedAt: now, decidedBy: me, history: FieldValue.arrayUnion({ at: now, by: me, what: 'cancelled', note: 'access taken back' }) });
      }
    }
    reqPatch = { grantState: 'revoked', grantChangedAt: now, grantChangedBy: me, grantChangedByName: nameIn(team, me) };
  } else if (what === 'hide') {
    if (!g.includeContact) return json({ ok: true, unchanged: true });
    await ref.update({ includeContact: false, contactExpiresAt: null, history: FieldValue.arrayUnion({ at: now, by: me, what: 'contact-hidden' }) });
    line = `${nameIn(team, me)} hid the owner’s number on ${g.title}`;
    reqPatch = { 'terms.contact': false, 'terms.contactUntil': null, grantState: 'contact-hidden', grantChangedAt: now, grantChangedBy: me, grantChangedByName: nameIn(team, me) };
  } else {
    if (!AA.grantLive(g, now)) return json({ ok: false, error: 'This access has already ended — they can ask again' }, 409);
    const until = AA.timerEnd({ days: body.days, until: body.until }, now);
    if (until === undefined) return json({ ok: false, error: 'Pick how long' }, 400);
    await ref.update({ expiresAt: until == null ? null : until, history: FieldValue.arrayUnion({ at: now, by: me, what: 'extended' }) });
    line = `${nameIn(team, me)} extended access to ${g.title} — ${until ? 'until ' + fmtWhen(until) : 'with no time limit'}`;
    reqPatch = { 'terms.until': until == null ? null : until, grantChangedAt: now, grantChangedBy: me, grantChangedByName: nameIn(team, me) };
  }
  if (g.requestId) {
    const rr = db.collection('accessRequests').doc(g.requestId);
    const r = await rr.get();
    if (r.exists) {
      await rr.update({ ...reqPatch, history: FieldValue.arrayUnion({ at: now, by: me, what: what === 'revoke' ? 'revoked' : what === 'hide' ? 'contact-hidden' : 'extended' }) }).catch(() => {});
      await systemLineFor(db, r.data().threadId, line, null, me);
    }
  }
  await rebuildAgents(db, user.tenantId, [g.agentEmail]).catch(e => console.error('rebuild after grant change:', e.message));
  return json({ ok: true });
}

// Waiting requests follow the property (or lead) as it is now: after a reassignment the new primary
// agent can see and decide them, the old one stops seeing them. The request, its private part and its
// conversation all get the new list.
export async function refreshApprovers(db, tenantId, { propertyId = null } = {}) {
  let q = db.collection('accessRequests').where('tenantId', '==', tenantId).where('status', '==', 'pending');
  if (propertyId) q = q.where('targetId', '==', propertyId);
  const pend = await q.get();
  if (pend.empty) return 0;
  const [team, cfgDoc] = await Promise.all([teamOf(db, tenantId), loadConfig(db, tenantId)]);
  const admins = adminsOf(team);
  let changed = 0;
  for (const d of pend.docs) {
    const r = { ...d.data(), _id: d.id };
    const cur = await db.runTransaction(t => currentApprovers(db, t, r, cfgDoc, admins));
    const next = [...cur.approvers].sort(), prev = [...(r.approvers || [])].sort();
    if (JSON.stringify(next) === JSON.stringify(prev)) continue;
    await d.ref.update({ approvers: next });
    if (r.kind === 'lead') await db.collection('requestPrivate').doc(d.id).update({ approvers: next }).catch(() => {});
    if (r.threadId) {
      const names = {};
      next.forEach(e => { names['names.' + AA.emailKey(e)] = nameIn(team, e); });
      await db.collection('threads').doc(r.threadId).update({ members: [...new Set([r.requesterEmail, ...next])].sort(), ...names }).catch(() => {});
    }
    changed++;
  }
  return changed;
}

// The daily tidy-up (api/followup-digest.js's morning run calls it): access whose timer ran out is
// switched off for good (the rules and copies already stop at the time; this keeps the lists honest
// and drops expired leads from agentAccess), and a request nobody decided in a week expires — the
// agent can ask again.
export async function sweepExpired(db, tenantId, { requestDays = 7 } = {}) {
  const now = Date.now();
  let changed = 0;
  const grants = await loadGrants(db, tenantId);
  for (const g of grants) {
    if (g.expiresAt && g.expiresAt <= now) {
      await db.collection('grants').doc(g.id).update({ active: false, history: FieldValue.arrayUnion({ at: now, by: 'system', what: 'expired' }) });
      if (g.requestId) await db.collection('accessRequests').doc(g.requestId).update({ grantState: 'expired', grantChangedAt: now }).catch(() => {});
      changed++;
    } else if (g.includeContact && g.contactExpiresAt && g.contactExpiresAt <= now) {
      await db.collection('grants').doc(g.id).update({ includeContact: false, history: FieldValue.arrayUnion({ at: now, by: 'system', what: 'contact-expired' }) });
      changed++;
    }
  }
  const pend = await db.collection('accessRequests').where('tenantId', '==', tenantId).where('status', '==', 'pending').get();
  for (const d of pend.docs) {
    const r = d.data();
    if ((r.createdAt || 0) > now - requestDays * 86400000) continue;
    await d.ref.update({ status: 'expired', decidedAt: now, decidedBy: 'system', history: FieldValue.arrayUnion({ at: now, by: 'system', what: 'expired' }) });
    await systemLineFor(db, r.threadId, `Nobody decided in ${requestDays} days, so this request expired. ${r.requesterName} can ask again.`);
    changed++;
  }
  // A lead handed to another agent in the CRM moves its waiting requests to them too.
  changed += await refreshApprovers(db, tenantId).catch(() => 0);
  if (changed) await rebuildAgents(db, tenantId, null).catch(e => console.error('rebuild after sweep:', e.message));
  return changed;
}

// ── Messages ──
async function threadOpen(db, user, body) {
  const me = lc(user.email);
  const type = ['property', 'lead', 'general'].includes(body && body.type) ? body.type : null;
  if (!type) return json({ ok: false, error: 'Bad thread' }, 400);
  if (user.role === 'agent') {
    const cfg = effectiveConfig(await loadConfig(db, user.tenantId), me);
    if (!cfg.tabs.includes('messages')) return json({ ok: false, error: 'Messages is not part of your access' }, 403);
    if (!(await throttle(db, user, 'thread', 30, 3600000))) return json({ ok: false, error: 'Too many new conversations — try again later' }, 429);
  }
  const team = await teamOf(db, user.tenantId);
  const active = new Set(team.filter(u => u.active).map(u => u.email));
  let members = (Array.isArray(body.members) ? body.members : []).map(lc).filter(e => active.has(e) && e !== me);
  let linkedId = null, title = plainText(String(body.title || '')).trim().slice(0, 120), key;
  // Nobody else on it (the person asking is its only agent): the admins.
  const orAdmins = list => { const l = list.filter(e => e !== me && active.has(e)); return l.length ? l : adminsOf(team).filter(e => e !== me); };
  if (type === 'property') {
    const a = await accessTo(db, user, body.linkedId);
    if (a.error || !a.access) return json({ ok: false, error: 'No such property' }, 404);
    linkedId = a.p.id;
    if (!members.length) members = orAdmins(AA.agentsOf(a.p));
    if (!title) title = String(a.p.name || a.p.id).slice(0, 100);
  } else if (type === 'lead') {
    const c = await leadFor(db, user, String(body.linkedId || ''));
    if (c.error) return c.error;
    linkedId = c.lead.id;
    if (!members.length) members = orAdmins([c.lead.assignedAgent, c.lead.secondaryAgent].map(lc));
    if (!title) title = 'Lead: ' + plainText(String(c.lead.name || 'client')).slice(0, 80);
  } else {
    key = 'general|' + title.toLowerCase();
  }
  if (!title) return json({ ok: false, error: 'Give the conversation a title' }, 400);
  members = [...new Set([me, ...members])];
  if (members.length < 2) return json({ ok: false, error: 'Pick at least one person' }, 400);
  if (members.length > 20) return json({ ok: false, error: 'At most 20 people' }, 400);
  const th = await threadFor(db, user.tenantId, { type, linkedId, title, members, by: me, team, key });
  return json({ ok: true, id: th.id, created: th.created });
}

// A property as a lead names it: its code, its document id, or — a visit booked on a property with no
// code is saved under its title — its name.
async function propertyByCode(db, tenantId, code) {
  const c = String(code || '').trim();
  if (!c) return null;
  const q = await db.collection('properties').where('tenantId', '==', tenantId).where('propertyCode', '==', c).limit(1).get();
  if (!q.empty) return { ...q.docs[0].data(), id: q.docs[0].id };
  const byId = await getProperty(db, tenantId, c);
  if (byId) return byId;
  const n = await db.collection('properties').where('tenantId', '==', tenantId).where('name', '==', c).limit(5).get();
  if (n.empty) return null;
  if (n.size === 1) return { ...n.docs[0].data(), id: n.docs[0].id };
  // The same title on two listings (an old uncoded copy and the coded one): the one without a code is
  // the one a visit saved under its title points at; never a guess between two that both have agents.
  const rows = n.docs.map(d => ({ ...d.data(), id: d.id }));
  const uncoded = rows.filter(p => !p.propertyCode);
  if (uncoded.length === 1) return uncoded[0];
  const withAgents = rows.filter(p => AA.agentsOf(p).length);
  return withAgents.length === 1 ? withAgents[0] : null;
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
  const p = await propertyByCode(db, user.tenantId, code);
  if (!p) return null;
  const me = lc(user.email);
  // Told: the property's agents who do not work this lead themselves.
  const to = AA.agentsOf(p).filter(e => e !== me && !AA.canWorkLead(after, e));
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
    if (ts.exists) await systemMessage(db, th, ts.data().members || [], `${nameIn(team, me)} ${words}${when ? ' — ' + when : ''} (client: ${first})`, null, me).catch(() => {});
  }
  return id;
}

// The property a site-visit invitation is written from, as this booker may see it: exactly the fields
// their access gives them (no street for a summary, no owner's number without that tier) — the
// invitation lands in their own calendar, so it must not tell them more than their screens do.
export async function visitPropertyFor(db, user, code) {
  if (user.role !== 'agent') return undefined;
  // Always an object for an agent (empty when there is nothing to say): the booking then never looks
  // a property up itself, unprojected.
  if (!code) return {};
  const p = await propertyByCode(db, user.tenantId, code);
  if (!p) return {};
  const a = await accessTo(db, user, p.id);
  if (a.error || !a.access) return { name: p.name || '', propertyCode: p.propertyCode || p.id };
  if (!a.fields) return p;
  return { ...projectProperty(p, a.fields), propertyCode: p.propertyCode || p.id };
}

const AGENT_ACTIONS = {
  view, directory, 'crm-boot': crmBoot,
  'property-notes': propertyNotes, 'property-note': propertyNote, 'property-availability': propertyAvailability, 'property-submit': propertySubmit,
  'lead-save': leadSave, 'lead-note': leadNote, 'lead-note-delete': leadNoteDelete, 'lead-history': leadHistory, 'lead-add': leadAdd,
  request, decide, cancel, 'thread-open': threadOpen,
  // Staff and admins (each refuses agents itself): the dashboard's agents panel.
  assign, 'property-access': propertyAccess,
  // Admins, the property's primary agent, or whoever approved it (grantChange checks).
  revoke: (db, u, b) => grantChange(db, u, b, 'revoke'), 'hide-contact': (db, u, b) => grantChange(db, u, b, 'hide'),
  'grant-extend': (db, u, b) => grantChange(db, u, b, 'extend'),
};
const ADMIN_WORK = {
  'submission-decide': submissionDecide,
  rebuild: async (db, u, b) => json({ ok: true, rebuilt: await rebuildAgents(db, u.tenantId, b && b.email ? [b.email] : null) }),
};
// Actions only agents need (their own copy); everyone else on the team reads the real data.
const AGENT_ONLY = new Set(['view', 'crm-boot']);

export const isWorkAction = a => Object.prototype.hasOwnProperty.call(AGENT_ACTIONS, a) || Object.prototype.hasOwnProperty.call(ADMIN_WORK, a);
export const isAdminWork = a => Object.prototype.hasOwnProperty.call(ADMIN_WORK, a);

// Grants whose timer has run out are switched off (active:false) whenever anyone uses the agent layer —
// at most every 10 minutes per warm server. The rules already refuse a new read at the time; this
// write is what makes Firestore close a screen that had the lead open (it re-checks the rules when the
// grant changes, not when the clock passes), so access ends within minutes, not at the morning tidy-up.
const expiredSweptAt = new Map();
export const __resetExpiredSweep = () => expiredSweptAt.clear();   // tests only
export async function switchOffExpired(db, tenantId) {
  const last = expiredSweptAt.get(tenantId) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return 0;
  expiredSweptAt.set(tenantId, Date.now());
  const now = Date.now();
  let n = 0;
  for (const g of await loadGrants(db, tenantId)) {
    if (g.expiresAt && g.expiresAt <= now) {
      await db.collection('grants').doc(g.id).update({ active: false, history: FieldValue.arrayUnion({ at: now, by: 'system', what: 'expired' }) }).catch(() => {});
      if (g.requestId) await db.collection('accessRequests').doc(g.requestId).update({ grantState: 'expired', grantChangedAt: now }).catch(() => {});
      n++;
    } else if (g.includeContact && g.contactExpiresAt && g.contactExpiresAt <= now) {
      await db.collection('grants').doc(g.id).update({ includeContact: false, history: FieldValue.arrayUnion({ at: now, by: 'system', what: 'contact-expired' }) }).catch(() => {});
      n++;
    }
  }
  return n;
}

export async function workPost(user, action, body, isAdmin) {
  const db = getDb();
  if (!user.email) return json({ ok: false, error: 'Your login has no email' }, 403);
  await switchOffExpired(db, user.tenantId).catch(e => console.error('switch off expired grants:', e.message));
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
// The leads an agent may send campaigns to: the ones they WORK (their own, or an enquiry on their
// property nobody has been given) — never one they can only read.
async function agentLeadIds(db, user) {
  const me = lc(user.email);
  const col = db.collection('leads');
  const fields = ['assignedAgent', 'secondaryAgent', 'agentAccess', 'phone', 'name', 'tt'];
  const qs = await Promise.all([
    col.where('tenantId', '==', user.tenantId).where('assignedAgent', '==', me).select(...fields).get(),
    col.where('tenantId', '==', user.tenantId).where('secondaryAgent', '==', me).select(...fields).get(),
    col.where('tenantId', '==', user.tenantId).where('agentAccess', 'array-contains', me).select(...fields).get(),
  ]);
  const out = new Map();
  qs.forEach(q => q.docs.forEach(d => { if (AA.canWorkLead(d.data(), me)) out.set(d.id, d.data()); }));
  return out;
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
    // To the number on the lead, always — read here from the lead itself: a typed number or name
    // never travels with an agent's send.
    body.recipients = list.map(r => {
      const l = mine.get(String(r.leadId)) || {};
      return { leadId: String(r.leadId), contact: String(l.phone || (l.tt && l.tt.contact) || ''), name: plainText(String(l.name || '')),
        ...(r.values && typeof r.values === 'object' ? { values: plainText(r.values) } : {}), ...(r.mediaUrl ? { mediaUrl: String(r.mediaUrl) } : {}) };
    });
    if (body.audience) body.audience = plainText(body.audience);
    if (body.name) body.name = plainText(body.name);
  }
  if (op === 'optout') {
    if (!mine.has(String(body.leadId || ''))) return { refuse: 'Not your lead' };
    // An agent can stop messages to a client, never start them again (that is for the team).
    if (body.on !== true) return { refuse: 'Only an admin can turn messages back on for a client' };
  }
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
      if (op === 'settings') {
        // Quiet hours, gaps and rates only: the opt-out lists (every client's number) and the test
        // number stay with the team.
        const st = r.settings || {};
        return { ok: true, settings: { quietStart: st.quietStart, quietEnd: st.quietEnd, marketingGapDays: st.marketingGapDays, marketingRate: st.marketingRate,
          utilityRate: st.utilityRate, optOut: [], marketingOptOut: [], lists: [], testNumber: '' }, lists: [], quietNow: r.quietNow, marketingHours: r.marketingHours, marketingNow: r.marketingNow, metaReady: false };
      }
      return r;
    },
  };
}
