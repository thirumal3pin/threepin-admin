// ═══════ AN AGENT'S LISTINGS — their properties from "owner said yes" to Live ═══════
//
// The same pipeline the office runs on the Shoot & Media board (listings + trackPipelines,
// track-assets/track-pipeline.js), for the properties an agent brings in and looks after:
//   New listing → Details & docs → Shoot scheduled → Shoot done → Media ready →
//   Sent for approval → Approved → Live — marketing        (+ Sold / Rented, On hold, Dropped)
// An agent cannot read `listings` (firestore.rules); everything comes through here, checked.
//
// WHOSE LISTING IS IT
//   · Before it is in the inventory: the agent who created it (agentEmail).
//   · Once it is (propertyCode → a property): the property's agents — the primary agent works it in
//     full, a co-agent sees it and moves it forward, but only the primary (or the office) pauses,
//     drops or closes it, or changes what the inventory says (title, price, area…). A property with no
//     primary yet (its brochure row reached the sheet first) is still its creator's.
//   · A listing made for an existing property belongs to that property's primary agent.
// THE GATE
//   · Agents move their cards anywhere except into Approved. An admin (confirmed email) approves —
//     only from Sent for approval — or sends it back to Details & docs with a note.
//   · Live: once approved (also later, after a pause), or a property already in the inventory and
//     open to everyone. Sold / Rented only from Approved or Live (or an inventory property).
//   · Approving a listing not in the inventory adds the property (its agent the primary), hidden from
//     other agents (listingHidden) until the listing goes Live. A property the sheet sync creates from
//     a brochure's Inventory row gets the same treatment (claimReservedCreates, api/sync-inventory.js).
// AFTER APPROVAL the property is the one truth: the card shows the property's title, price, area…,
// and the primary agent's changes to them go to the property, with a "Changes to apply" entry so
// the office copies them to the inventory sheet.
// SWITCH: agentConfigs → actions.listings (Team & access → What agents see). Off = no menu entry,
// every action refused for agents; the office board is unaffected.
//
// Actions (POST /api/agent):
//   listings          → { stages, listings, canAdd }
//   listing-history   { id } → the card's timeline
//   listing-save      { id?, propertyId?, fields } create, or change the details
//   listing-stage     { id, key, reason?, note?, availability?, shootAt? } move a card
//   listing-brochure  { id, description? } ask for the brochure (the office's own Google Form)
//   listing-live      { id } the office board moved it to Live: open its property (staff)
//   listing-decide    { id, decision: 'approve' | 'return', note }      (admins)
//   listing-queue     → the listings waiting for approval                (admins)
// Reads: a few per call — the pipeline (1), the agent's properties (2 queries), their listings
// (1–2 queries). The whole inventory only when a new property code is worked out, or a new listing
// is checked for duplicates.
import { randomBytes } from 'node:crypto';
import * as AA from '../shared-assets/agent-access.js';
import { effectiveConfig } from '../shared-assets/agent-config.js';
import * as P from '../track-assets/track-pipeline.js';
import { formBody, FORM_ACTION, isUrl, codeKey, CODE_RE } from '../track-assets/brochure-flow.js';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const lc = AA.lc;
const str = v => (v == null ? '' : String(v)).replace(/[<>]/g, '').trim();
const now = () => Date.now();
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// What may be typed on a card. INVENTORY fields are the property's once it is in the inventory.
const FIELDS = {
  title: 200, location: 300, config: 40, askingPrice: 60, propType: 60, deal: 10, sqft: 40, uds: 40,
  sellerName: 80, sellerPhone: 20, photosLink: 400, remarks: 2000, description: 4000,
};
// listing field → property field
const INVENTORY = { title: 'name', location: 'location', config: 'config', askingPrice: 'startingPrice', propType: 'type', photosLink: 'photosLink', sqft: 'sqftRange', uds: 'uds', deal: 'dealType' };
const SELLER = ['sellerName', 'sellerPhone'];
const DEALS = ['sale', 'rent'];
const MEDIA = ['photos', 'video', 'floorPlan'];
const LABELS = { title: 'title', location: 'area', config: 'BHK', askingPrice: 'price', propType: 'type', deal: 'sale or rent', sqft: 'size', uds: 'UDS',
  sellerName: 'owner’s name', sellerPhone: 'owner’s number', photosLink: 'photos link', remarks: 'notes', description: 'write-up', shootAt: 'shoot date',
  media: 'media in hand', ownerInformed: 'owner agreed', ownerApproved: 'owner approved the photos' };

// The server helpers it shares with the rest of the agent layer, handed in by api/_agent-work.js
// (not imported, so the two modules do not load each other).
let H = null;
export const useHelpers = h => { H = h; };

// ── The pipeline ──
async function stagesOf(db, tenantId) {
  const s = await db.collection('trackPipelines').doc(tenantId).get();
  let stages = s.exists && Array.isArray(s.data().stages) && s.data().stages.length ? s.data().stages : P.defaultStages();
  // A board without the approval columns yet gains them, as the board does on load; a tenant that
  // never opened Shoot & Media gets the default board saved, as the board seeds it.
  const a = P.addNewColumns(stages);
  if (a.changed || !s.exists) { stages = a.stages; await db.collection('trackPipelines').doc(tenantId).set({ stages }, { merge: true }).catch(() => {}); }
  return stages.slice().sort((x, y) => (x.order || 0) - (y.order || 0));
}
const keyOfId = (stages, id) => P.stageKeyOf(stages.find(s => s.id === id)) || null;
const stageOfKey = (stages, key) => P.stageForKey(stages, key);

// ── Whose is what ──
async function ownProperties(db, tenantId, me) {
  const col = db.collection('properties');
  const [a, b] = await Promise.all([
    col.where('tenantId', '==', tenantId).where('assignedAgent', '==', me).get(),
    col.where('tenantId', '==', tenantId).where('secondaryAgents', 'array-contains', me).get(),
  ]);
  const m = new Map();
  [...a.docs, ...b.docs].forEach(d => m.set(d.id, { ...d.data(), id: d.id }));
  return [...m.values()].filter(p => AA.roleOn(p, me));
}
async function myListings(db, tenantId, me, props) {
  const col = db.collection('listings');
  const by = new Map();
  (await col.where('tenantId', '==', tenantId).where('agentEmail', '==', me).get()).docs.forEach(d => by.set(d.id, { ...d.data(), id: d.id }));
  // Listings of a property of theirs (by code; "in" takes 30 at a time).
  const codes = [...new Set(props.map(p => AA.codeOf(p)).filter(Boolean))];
  for (let i = 0; i < codes.length; i += 30) {
    (await col.where('tenantId', '==', tenantId).where('propertyCode', 'in', codes.slice(i, i + 30)).get()).docs.forEach(d => by.set(d.id, { ...d.data(), id: d.id }));
  }
  return [...by.values()].filter(x => x.kind !== 'series');
}
async function propertyByCode(db, tenantId, code) {
  if (!code) return null;
  const byId = await H.getProperty(db, tenantId, String(code));
  if (byId) return byId;
  const q = await db.collection('properties').where('tenantId', '==', tenantId).where('propertyCode', '==', String(code)).limit(1).get();
  return q.empty ? null : { ...q.docs[0].data(), id: q.docs[0].id };
}
// 'primary' (works it in full) | 'co' (sees it, moves it forward) | null — for an agent; staff: 'office'.
export function listingRole(x, prop, me, isAgent = true) {
  if (!isAgent) return 'office';
  if (prop) {
    const r = AA.roleOn(prop, me);
    if (r) return r;
    // Its brochure row reached the sheet before anyone was given the property: still its creator's.
    return !AA.primaryOf(prop) && lc(x.agentEmail) === me ? 'primary' : null;
  }
  return lc(x.agentEmail) === me ? 'primary' : null;
}
async function roleFor(db, user, x) {
  if (!x || x.tenantId !== user.tenantId) return { role: null, prop: null };
  const prop = x.propertyCode ? await propertyByCode(db, user.tenantId, x.propertyCode) : null;
  return { role: listingRole(x, prop, lc(user.email), user.role === 'agent'), prop };
}
async function gate(db, user) {
  if (user.role !== 'agent') return null;
  const cfg = effectiveConfig(await H.loadConfig(db, user.tenantId), lc(user.email));
  if (!cfg.tabs.includes('properties')) return json({ ok: false, error: 'Properties is not part of your access' }, 403);
  if (cfg.actions && cfg.actions.listings === false) return json({ ok: false, error: 'My listings is switched off for agents — ask an admin' }, 403);
  return cfg;
}

// ── What a card shows ──
function brochureOf(x, prop) {
  if (isUrl(x.brochureLink) || (prop && isUrl(prop.brochureLink))) return { state: 'created', link: isUrl(x.brochureLink) ? x.brochureLink : prop.brochureLink };
  if (x.brochure && x.brochure.requestedAt) return { state: 'requested', at: x.brochure.requestedAt, code: x.brochure.code || '' };
  return { state: 'none' };
}
// The listing's facts, with the property's where it is in the inventory (the property is the truth).
function factsOf(x, prop) {
  const f = {};
  for (const [lk, pk] of Object.entries(INVENTORY)) f[lk] = (prop && prop[pk] != null && prop[pk] !== '' ? String(prop[pk]) : '') || x[lk] || '';
  if (prop && !f.location) f.location = prop.zone || '';
  return f;
}
function cardOf(x, stages, prop, { role = 'primary', showContact = true } = {}) {
  const media = x.media || {};
  return {
    id: x.id, virtual: false, ...factsOf(x, prop),
    propertyCode: x.propertyCode || '', propertyId: prop ? prop.id : null,
    draftCode: (!x.propertyCode && x.brochure && x.brochure.code) || '',
    sellerName: showContact ? x.sellerName || '' : '', sellerPhone: showContact ? x.sellerPhone || '' : '', contactHidden: !showContact,
    remarks: x.remarks || '', description: x.description || '',
    stageKey: keyOfId(stages, x.stageId) || 'new_listing', stageChangedAt: x.stageChangedAt || x.createdAt || 0,
    createdAt: x.createdAt || 0, updatedAt: x.updatedAt || 0, updatedBy: x.updatedBy || '',
    shootAt: x.shootAt || null, shootDoneAt: x.shootDoneAt || null,
    media: { photos: !!media.photos, video: !!media.video, floorPlan: !!media.floorPlan },
    ownerInformed: !!x.ownerInformed, ownerApproved: !!x.ownerApproved,
    brochure: brochureOf(x, prop),
    approval: x.adminApproval ? { sentAt: x.adminApproval.sentAt || 0, note: x.adminApproval.note || '', decision: x.adminApproval.decision || null, decidedAt: x.adminApproval.decidedAt || 0, decidedByName: x.adminApproval.decidedByName || '' } : null,
    holdReason: x.holdReason || '', dropReason: x.dropReason || '',
    approvedOnce: wasApproved(x),
    role, inInventory: !!prop, byOffice: !x.agentEmail || x.source === 'office', agentName: x.agentName || '',
    hidden: !!(prop && prop.listingHidden),
    possibleDuplicate: Array.isArray(x.duplicateOf) && x.duplicateOf.length > 0,
    lastEvent: x.lastEvent ? { text: safeHtml(x.lastEvent.text).slice(0, 300), at: x.lastEvent.at || 0 } : null,
  };
}
// One of the agent's properties with no listing on any board: a card in Live (or Sold, On hold).
function virtualOf(p, me) {
  const sold = p.soldOut === true || /\b(sold|let out|rented)\b/i.test(String(p.availability || ''));
  const gone = !p.listingHidden && !AA.isActiveProperty(p);
  return {
    id: 'p:' + p.id, virtual: true, propertyId: p.id, propertyCode: AA.codeOf(p), ...factsOf({}, p),
    stageKey: sold ? 'closed' : gone ? 'on_hold' : 'live', stageChangedAt: p.createdAt || 0, createdAt: p.createdAt || 0,
    media: {}, brochure: isUrl(p.brochureLink) ? { state: 'created', link: p.brochureLink } : { state: 'none' }, approval: null,
    role: me ? (AA.roleOn(p, me) || 'co') : 'office', inInventory: true, byOffice: true, hidden: !!p.listingHidden,
  };
}
const isAgentListing = x => !!(x && x.agentEmail && x.source !== 'office');
// An admin approved this listing once (a pause since does not undo it).
export const wasApproved = x => !!(x && ((x.adminApproval && x.adminApproval.decision === 'approved') || (x.reached && x.reached.approved)));
const contactOk = (cfg, user, x) => user.role !== 'agent' || lc(x.agentEmail) === lc(user.email) || ((cfg && cfg.ownPropertyFields) || []).includes('contact');

// ── listings ──
async function listings(db, user) {
  const cfg = await gate(db, user);
  if (cfg instanceof Response) return cfg;
  const me = lc(user.email);
  const [stages, props] = await Promise.all([stagesOf(db, user.tenantId), ownProperties(db, user.tenantId, me)]);
  const byCode = new Map(props.map(p => [codeKey(AA.codeOf(p)), p]));
  const all = await myListings(db, user.tenantId, me, props);
  const cards = [];
  const linked = new Set();
  for (const x of all) {
    const prop = x.propertyCode ? (byCode.get(codeKey(x.propertyCode)) || await propertyByCode(db, user.tenantId, x.propertyCode)) : null;
    const role = listingRole(x, prop, me, user.role === 'agent');
    if (!role) continue;   // the property moved to someone else
    if (x.propertyCode) linked.add(codeKey(x.propertyCode));
    if (x.brochure && x.brochure.code) linked.add(codeKey(x.brochure.code));
    // Live but its property still hidden (a step that failed half-way): put right here.
    if (prop && prop.listingHidden && keyOfId(stages, x.stageId) === 'live' && (wasApproved(x) || !isAgentListing(x))) {
      await db.collection('properties').doc(prop.id).update({ listingHidden: false, wentLiveAt: now() }).catch(() => {});
      prop.listingHidden = false;
    }
    const card = cardOf(x, stages, prop, { role, showContact: contactOk(cfg, user, x) });
    // Not linked yet but its brochure code is already a property (the sheet got there first): say
    // whether that property is still out of other agents' sight.
    if (!prop && x.brochure && x.brochure.code) {
      const waiting = await propertyByCode(db, user.tenantId, x.brochure.code);
      if (waiting && waiting.listingId === x.id) card.hidden = !!waiting.listingHidden;
    }
    cards.push(card);
  }
  // A property with no listing gets a card of its own — not one that is waiting on its listing's
  // approval (hidden), which would be a way round it.
  props.filter(p => !linked.has(codeKey(AA.codeOf(p))) && !p.listingHidden).forEach(p => cards.push(virtualOf(p, me)));
  return json({
    ok: true,
    stages: stages.map(s => ({ id: s.id, key: P.stageKeyOf(s), name: s.name, color: s.color, kind: P.stageKindOf(s) || s.kind || 'open',
      rule: (P.stageDef(P.stageKeyOf(s)) || {}).rule || '', targetDays: (P.stageDef(P.stageKeyOf(s)) || {}).targetDays || null })).filter(s => s.key),
    listings: cards,
    isAgent: user.role === 'agent',
    canAdd: user.role === 'agent' && !!(cfg && cfg.actions && cfg.actions.addProperties),
    canEditInventory: user.role !== 'agent' || !!(cfg && cfg.actions && cfg.actions.editOwnProperties),
    holdReasons: P.HOLD_REASONS, dropReasons: P.DROP_REASONS,
  });
}

async function loadListing(db, user, id) {
  if (!id || typeof id !== 'string' || id.includes('/')) return null;
  const s = await db.collection('listings').doc(id).get();
  if (!s.exists || s.data().tenantId !== user.tenantId) return null;
  return { ...s.data(), id: s.id };
}
async function addHistory(db, x, type, text, by) {
  const at = now();
  const id = 'h' + at + randomBytes(3).toString('hex');
  await db.collection('listings').doc(x.id).collection('history').doc(id).set({ id, type, text: String(text).slice(0, 1000), at, by: lc(by) });
  await db.collection('listings').doc(x.id).update({ lastEvent: { type, text: String(text).slice(0, 300), at, by: lc(by) } }).catch(() => {});
}
// Timeline lines are written as HTML (the board's own entries too): only <b> survives on the way out.
export const safeHtml = t => String(t || '').slice(0, 1000).replace(/<(?!\/?b>)[^>]*>?/gi, '').replace(/<(\/?)b>/gi, '<$1b>');
async function listingHistory(db, user, body) {
  const g = await gate(db, user);
  if (g instanceof Response) return g;
  const x = await loadListing(db, user, body && body.id);
  if (!x || !(await roleFor(db, user, x)).role) return json({ ok: false, error: 'No such listing' }, 404);
  const s = await db.collection('listings').doc(x.id).collection('history').limit(100).get();
  const items = s.docs.map(d => d.data()).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 60)
    .map(h => ({ type: h.type || '', text: safeHtml(h.text), at: h.at || 0, by: h.by || '' }));
  return json({ ok: true, items });
}

// The details typed on a card, cleaned. Returns { patch } or { error }.
function cleanFields(f) {
  const patch = {};
  for (const [k, max] of Object.entries(FIELDS)) {
    if (!f || f[k] === undefined) continue;
    patch[k] = str(f[k]).slice(0, max);
  }
  if (patch.deal && !DEALS.includes(patch.deal)) return { error: 'Sale or rent' };
  if (patch.photosLink && !/^https:\/\/\S+$/i.test(patch.photosLink)) return { error: 'The photos link must start with https://' };
  if (patch.sellerPhone && patch.sellerPhone.replace(/\D/g, '').length < 10) return { error: 'The owner’s number needs at least 10 digits' };
  if (f && f.shootAt !== undefined) {
    if (f.shootAt === null || f.shootAt === '') patch.shootAt = null;
    else { const t = Number(f.shootAt); if (!isFinite(t) || t < now() - 366 * 86400000 || t > now() + 366 * 86400000) return { error: 'Pick a shoot date within a year' }; patch.shootAt = t; }
  }
  if (f && f.media && typeof f.media === 'object') patch.media = Object.fromEntries(MEDIA.map(k => [k, f.media[k] === true]));
  if (f && typeof f.ownerInformed === 'boolean') patch.ownerInformed = f.ownerInformed;
  if (f && typeof f.ownerApproved === 'boolean') patch.ownerApproved = f.ownerApproved;
  return { patch };
}
// Owners list with several brokers: the same owner's number, or the same title in the same area,
// may already be with us. Returns codes/titles (for the admin), never whose.
// The inventory's codes, names and owner numbers, and the listings', read once per warm server for
// 5 minutes: a duplicate check or a new code no longer reads every property each time (free plan).
const snapCache = new Map();
async function inventorySnapshot(db, tenantId, fresh = false) {
  const c = snapCache.get(tenantId);
  if (!fresh && c && now() - c.at < 300000) return c;
  const [ps, ls, rs] = await Promise.all([
    db.collection('properties').where('tenantId', '==', tenantId).select('name', 'contactNumber', 'location', 'zone', 'propertyCode').get(),
    db.collection('listings').where('tenantId', '==', tenantId).select('title', 'sellerPhone', 'location', 'propertyCode', 'brochure').get(),
    db.collection('listingCodes').where('tenantId', '==', tenantId).select('listingId').get(),
  ]);
  const v = { at: now(), props: ps.docs.map(d => ({ id: d.id, ...d.data() })), listings: ls.docs.map(d => ({ id: d.id, ...d.data() })), reserved: rs.docs.map(d => d.id) };
  snapCache.set(tenantId, v);
  return v;
}
export const __clearSnapCache = () => snapCache.clear();   // tests
async function duplicatesOf(db, tenantId, f, selfId) {
  const digits = v => String(v || '').replace(/\D/g, '').slice(-10);
  const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const phone = digits(f.sellerPhone);
  const title = norm(f.title), area = norm(f.location);
  if (phone.length < 10 && !title) return [];
  const snap = await inventorySnapshot(db, tenantId);
  // Same area: the property's zone, or its address naming the area.
  const sameArea = (zone, loc) => !area || norm(zone) === area || norm(loc).includes(area) || (norm(zone) && area.includes(norm(zone)));
  const out = [];
  snap.props.forEach(p => { if ((phone.length === 10 && digits(p.contactNumber) === phone) || (title && norm(p.name) === title && sameArea(p.zone, p.location))) out.push(p.propertyCode || p.id); });
  snap.listings.forEach(x => { if (x.id === selfId) return; if ((phone.length === 10 && digits(x.sellerPhone) === phone) || (title && norm(x.title) === title && sameArea(x.location, x.location))) out.push(x.propertyCode || 'listing:' + String(x.title || '').slice(0, 60)); });
  return [...new Set(out)].slice(0, 5);
}
// A property change the office copies to the inventory sheet ("Changes to apply"), as the
// dashboard's own edits record it.
async function logChange(db, user, prop, field, label, from, to) {
  const t = now();
  const id = 'c' + t.toString(36) + randomBytes(3).toString('hex');
  await db.collection('propertyChanges').doc(id).set({
    id, tenantId: user.tenantId, propertyId: prop.id, propertyCode: prop.propertyCode || prop.id, propertyName: prop.name || '',
    propertyLocation: prop.location || '', propertyType: prop.type || '', field, label, from: String(from || ''), to: String(to || ''),
    kind: 'update', at: t, by: lc(user.email), appliedToSheet: false,
  }).catch(e => console.error('listing change log:', e.message));
}

// ── listing-save ──
async function listingSave(db, user, body, internal = {}) {
  const cfg = await gate(db, user);
  if (cfg instanceof Response) return cfg;
  const me = lc(user.email);
  const c = cleanFields((body && body.fields) || {});
  if (c.error) return json({ ok: false, error: c.error }, 400);
  const team = await H.teamOf(db, user.tenantId);
  const stages = await stagesOf(db, user.tenantId);
  const t = now();
  // ── An existing card ──
  if (body && body.id) {
    const x = await loadListing(db, user, body.id);
    const { role, prop } = await roleFor(db, user, x);
    if (!x || !role) return json({ ok: false, error: 'No such listing' }, 404);
    if (user.role === 'agent' && x.decidingAt && now() - x.decidingAt < 120000) return json({ ok: false, error: 'An admin is deciding it right now — try again in a moment' }, 409);
    const patch = { ...c.patch };
    // The owner's contact: only where they may see it (a blank they were shown is never saved).
    if (!contactOk(cfg, user, x)) SELLER.forEach(k => delete patch[k]);
    const facts = factsOf(x, prop);
    const differs = (k, v) => k === 'media' ? MEDIA.some(m => !!v[m] !== !!(x.media && x.media[m])) : JSON.stringify(v ?? '') !== JSON.stringify((k in INVENTORY ? facts[k] : x[k]) ?? '');
    const changed = Object.keys(patch).filter(k => differs(k, patch[k]));
    if (!changed.length) return json({ ok: true, id: x.id, unchanged: true });
    if (changed.includes('title') && !patch.title) return json({ ok: false, error: 'Give it a title' }, 400);
    const inv = changed.filter(k => k in INVENTORY);
    const blanked = prop ? inv.filter(k => ['location', 'askingPrice', 'config'].includes(k) && !patch[k]) : [];
    if (blanked.length) return json({ ok: false, error: 'The inventory needs ' + blanked.map(k => 'the ' + LABELS[k]).join(' and ') + ' — change it rather than clearing it' }, 400);
    if (prop && inv.length) {
      // In the inventory: what it says there is the primary agent's (with "edit their properties")
      // or the office's to change — and the office copies it to the sheet.
      if (role === 'co') return json({ ok: false, error: 'Only its primary agent changes ' + inv.map(k => LABELS[k]).join(', ') }, 403);
      if (role === 'primary' && !(cfg.actions && cfg.actions.editOwnProperties)) return json({ ok: false, error: 'Changing ' + inv.map(k => LABELS[k]).join(', ') + ' isn’t part of your access — ask an admin' }, 403);
      const pp = { updatedAt: t, updatedBy: me };
      inv.forEach(k => { pp[INVENTORY[k]] = patch[k]; });
      await db.collection('properties').doc(prop.id).update(pp);
      for (const k of inv.filter(k => k !== 'deal')) await logChange(db, user, prop, INVENTORY[k], LABELS[k][0].toUpperCase() + LABELS[k].slice(1), facts[k], patch[k]);
      // Others see the new price or title on their next copy.
      await H.markDirty(db, user.tenantId, AA.agentsOf(prop)).catch(() => {});
    }
    // Media ticks merge into the board's own (drone, tour… stay as they are).
    const write = Object.fromEntries(changed.map(k => [k, k === 'media' ? { ...(x.media || {}), ...patch.media } : patch[k]]));
    await db.collection('listings').doc(x.id).update({ ...write, updatedAt: t, updatedBy: me });
    await addHistory(db, x, 'field', 'Details edited: ' + esc(changed.map(k => LABELS[k] || k).join(', ')) + (prop && inv.length ? ' — the inventory too' : ''), me);
    return json({ ok: true, id: x.id, inventory: !!(prop && inv.length) });
  }
  // ── A new card — for a property they sourced, or for one of theirs already in the inventory ──
  if (user.role === 'agent' && !cfg.actions.addProperties && !(body && body.propertyId)) return json({ ok: false, error: 'Adding properties isn’t part of your access — ask an admin' }, 403);
  if (!(body && body.propertyId) && !(await H.throttle(db, user, 'listing-new', 10, 3600000))) return json({ ok: false, error: 'Too many at once — try again in a while' }, 429);
  let prop = null;
  if (body && body.propertyId) {
    const props = user.role === 'agent' ? await ownProperties(db, user.tenantId, me) : null;
    prop = props ? props.find(p => p.id === String(body.propertyId)) : await H.getProperty(db, user.tenantId, String(body.propertyId));
    if (!prop) return json({ ok: false, error: 'That property isn’t one of yours' }, 403);
    if (prop.listingHidden) return json({ ok: false, error: 'This property is waiting for its listing to be approved' }, 409);
    const code = AA.codeOf(prop);
    const taken = await db.collection('listings').where('tenantId', '==', user.tenantId).where('propertyCode', '==', code).limit(1).get();
    if (!taken.empty) return json({ ok: true, id: taken.docs[0].id, existing: true });
  }
  const title = c.patch.title || (prop && prop.name) || '';
  if (!title) return json({ ok: false, error: 'Give it a title' }, 400);
  // Where it starts: a new property at New listing; one already in the inventory where its state
  // says (Live, Sold, On hold — worked out here, never taken from the request).
  const start = prop ? (stageOfKey(stages, internal.startKey || virtualOf(prop).stageKey) || stageOfKey(stages, 'live')) : stages.find(s => P.stageKeyOf(s) === 'new_listing') || stages[0];
  const id = 'lst_' + t.toString(36) + randomBytes(3).toString('hex');
  const startKey = P.stageKeyOf(start) || 'new_listing';
  // An inventory property's listing is its primary agent's, whoever made the first move.
  const owner = prop ? (AA.primaryOf(prop) || me) : me;
  const doc = {
    id, tenantId: user.tenantId, ...c.patch, title,
    ...(prop ? { propertyCode: AA.codeOf(prop), ...Object.fromEntries(Object.entries(factsOf(c.patch, prop)).filter(([, v]) => v)) } : {}),
    agentEmail: owner, agentName: H.nameIn(team, owner), source: user.role === 'agent' ? 'agent' : 'office',
    stageId: start.id, stageChangedAt: t, stageChangedBy: me, reached: P.LADDER.includes(startKey) ? { [startKey]: t } : {},
    media: c.patch.media || {}, ownerInformed: !!c.patch.ownerInformed, ownerApproved: !!c.patch.ownerApproved,
    createdAt: t, createdBy: me, updatedAt: t, updatedBy: me,
  };
  const dupes = prop ? [] : await duplicatesOf(db, user.tenantId, doc, id);
  if (dupes.length) doc.duplicateOf = dupes;
  await db.collection('listings').doc(id).set(doc);
  const cached = snapCache.get(user.tenantId);
  if (cached) cached.listings.push({ id, title: doc.title, sellerPhone: doc.sellerPhone || '', location: doc.location || '', propertyCode: doc.propertyCode || '', brochure: null });
  await addHistory(db, doc, 'created', prop ? `Listing made for <b>${esc(AA.codeOf(prop))}</b> by ${esc(H.nameIn(team, me))}` : `Listing created by ${esc(H.nameIn(team, me))}${dupes.length ? ' — the same owner or title may already be with us' : ''}`, me);
  return json({ ok: true, id, possibleDuplicate: dupes.length > 0 });
}

// ── listing-stage ──
// What must be on a card before it is sent for an admin's approval (its facts, with the property's).
export function approvalGaps(x) {
  const miss = [];
  if (!str(x.title)) miss.push('a title');
  if (!str(x.location)) miss.push('the area');
  if (!str(x.config) && !str(x.propType)) miss.push('the BHK or type');
  if (!str(x.deal)) miss.push('sale or rent');
  if (!str(x.askingPrice)) miss.push('the price');
  if (!str(x.photosLink)) miss.push('the photos link');
  return miss;
}
// What an agent may NOT do with a move (the office may do anything but approve). Returns the reason, or ''.
//   approvedBefore: an admin approved this listing once (a pause since does not undo that)
//   inInventoryOpen: its property is in the inventory and open to everyone (not hidden)
export function agentMoveRefusal({ fromKey, toKey, role, approvedBefore, inInventoryOpen }) {
  if (toKey === 'approved') return 'An admin approves it — send it for approval instead';
  if (role === 'co' && ['on_hold', 'dropped', 'closed'].includes(toKey)) return 'Only its primary agent can pause, drop or close it';
  if (toKey === 'live' && fromKey !== 'approved' && !approvedBefore && !inInventoryOpen) return 'It goes Live once an admin has approved it';
  if (toKey === 'closed' && !['approved', 'live'].includes(fromKey) && !approvedBefore && !inInventoryOpen) return 'Only an approved listing can be marked sold or rented';
  return '';
}
async function listingStage(db, user, body) {
  const cfg = await gate(db, user);
  if (cfg instanceof Response) return cfg;
  const me = lc(user.email);
  const stages = await stagesOf(db, user.tenantId);
  const to = stageOfKey(stages, String((body && body.key) || ''));
  if (!to) return json({ ok: false, error: 'No such stage' }, 400);
  const toKey = P.stageKeyOf(to);
  let x = null;
  // A virtual card (one of their properties with no listing yet): its first move makes the listing.
  if (body && /^p:/.test(String(body.id || ''))) {
    const pid = String(body.id).slice(2);
    const mine = user.role === 'agent' ? (await ownProperties(db, user.tenantId, me)).find(p => p.id === pid) : await H.getProperty(db, user.tenantId, pid);
    if (!mine) return json({ ok: false, error: 'That property isn’t one of yours' }, 403);
    if (user.role === 'agent' && AA.roleOn(mine, me) === 'co' && ['on_hold', 'dropped', 'closed'].includes(toKey)) return json({ ok: false, error: 'Only its primary agent can pause, drop or close it' }, 403);
    const made = await listingSave(db, user, { propertyId: pid, fields: {} }, { startKey: virtualOf(mine).stageKey });
    const j = await made.clone().json();
    if (!j.ok) return made;
    x = await loadListing(db, user, j.id);
  } else x = await loadListing(db, user, body && body.id);
  const { role, prop } = await roleFor(db, user, x);
  if (!x || !role) return json({ ok: false, error: 'No such listing' }, 404);
  const fromKey = keyOfId(stages, x.stageId);
  // A shoot date given with the move (the "When is the shoot?" sheet).
  const shoot = body && body.shootAt != null ? cleanFields({ shootAt: body.shootAt }) : null;
  if (shoot && shoot.error) return json({ ok: false, error: shoot.error }, 400);
  if (fromKey === toKey && !(shoot && shoot.patch.shootAt !== undefined)) return json({ ok: true, id: x.id, unchanged: true });
  if (user.role === 'agent' && x.decidingAt && now() - x.decidingAt < 120000) return json({ ok: false, error: 'An admin is deciding it right now — try again in a moment' }, 409);
  const approvedBefore = wasApproved(x);
  const inInventoryOpen = !!(prop && !prop.listingHidden);
  if (user.role === 'agent') {
    const why = agentMoveRefusal({ fromKey, toKey, role, approvedBefore, inInventoryOpen });
    if (why) return json({ ok: false, error: why }, 403);
  }
  // The office's own way through (an admin dragging into Approved) is the decision itself.
  if (toKey === 'approved') return decide(db, user, x, stages, 'approve', String((body && body.note) || ''));
  const t = now();
  const patch = { updatedAt: t, updatedBy: me };
  if (fromKey !== toKey) Object.assign(patch, { prevStageId: x.stageId, stageId: to.id, stageChangedAt: t, stageChangedBy: me });
  if (shoot) patch.shootAt = shoot.patch.shootAt;
  const r = P.reachedUpdate(x, toKey, t);
  if (r) Object.assign(patch, r);
  let extra = '';
  if (toKey === 'on_hold' || toKey === 'dropped') {
    const reasons = toKey === 'on_hold' ? P.HOLD_REASONS : P.DROP_REASONS;
    const reason = String((body && body.reason) || '');
    if (!reasons[reason]) return json({ ok: false, error: 'Pick a reason' }, 400);
    patch[toKey === 'on_hold' ? 'holdReason' : 'dropReason'] = reason;
    extra = ' — ' + reasons[reason];
  } else if (fromKey === 'on_hold' || fromKey === 'dropped') { patch.holdReason = null; patch.dropReason = null; }
  if (toKey === 'for_approval') {
    const gaps = approvalGaps(factsOf(x, prop));
    if (gaps.length) return json({ ok: false, error: 'Before it goes for approval, add ' + gaps.join(', '), gaps }, 400);
    patch.adminApproval = { sentAt: t, sentBy: me, note: str((body && body.note) || '').slice(0, 500), decision: null };
  }
  if (toKey === 'shoot_done' && !x.shootDoneAt) patch.shootDoneAt = t;
  // Sold / Rented takes the property off the market first — refused there, nothing moves.
  if (toKey === 'closed' && prop && !/\b(sold|let out)\b/i.test(String(prop.availability || ''))) {
    const v = String((body && body.availability) || '') === 'Let out' ? 'Let out' : 'Sold';
    const res = user.role === 'agent' ? await H.setAvailability(db, user, { id: prop.id, availability: v }) : null;
    if (res && !res.ok) return res;
    if (!res) {
      await db.collection('properties').doc(prop.id).update({ availability: v, soldOut: true, updatedAt: t, updatedBy: me });
      await logChange(db, user, prop, 'availability', 'Availability', prop.availability || '', v);
    }
  }
  // Live: a property added at approval opens to the other agents — before the card moves, so a
  // failure leaves nothing half-done.
  if (toKey === 'live' && prop && prop.listingHidden) {
    await db.collection('properties').doc(prop.id).update({ listingHidden: false, wentLiveAt: t, updatedAt: t, updatedBy: me });
    await H.markDirty(db, user.tenantId, AA.agentsOf(prop)).catch(() => {});
  }
  await db.collection('listings').doc(x.id).update(patch);
  const team = await H.teamOf(db, user.tenantId);
  if (fromKey !== toKey) await addHistory(db, x, 'stage', `Moved to <b>${esc(to.name)}</b>${esc(extra)} by ${esc(H.nameIn(team, me))}${patch.adminApproval && patch.adminApproval.note ? ': “' + esc(patch.adminApproval.note) + '”' : ''}`, me);
  if (shoot) await addHistory(db, x, 'field', shoot.patch.shootAt ? 'Shoot booked by ' + esc(H.nameIn(team, me)) : 'Shoot date cleared', me);
  return json({ ok: true, id: x.id, stageKey: toKey });
}

// ── A new property code: the area's first four letters and the next free number (VANA0001) ──
export function nextCode(area, taken) {
  const letters = String(area || '').toUpperCase().replace(/[^A-Z]/g, '');
  const base = (letters + 'PROP').slice(0, 4);
  const used = new Set([...taken].map(codeKey));
  for (let n = 1; n < 10000; n++) { const c = base + String(n).padStart(4, '0'); if (!used.has(c)) return c; }
  return base + Date.now().toString(36).toUpperCase();
}
async function takenCodes(db, tenantId) {
  // A code is reserved with create(), so a slightly old snapshot only means a retry with the next one.
  // Fresh here (a few reads; rare): a code the office asked for minutes ago must count as taken.
  const snap = await inventorySnapshot(db, tenantId, true);
  const taken = new Set();
  snap.props.forEach(p => { taken.add(p.id); if (p.propertyCode) taken.add(p.propertyCode); });
  snap.listings.forEach(x => { if (x.propertyCode) taken.add(x.propertyCode); if (x.brochure && x.brochure.code) taken.add(x.brochure.code); });
  snap.reserved.forEach(c => taken.add(c));
  return taken;
}
// A code is RESERVED (listingCodes/{code}, created once — two requests at the same moment cannot both
// get it, and an id another business's property already uses is skipped). A listing that already
// reserved one gets that one back. Server-only collection; no browser reads or writes it.
// Returns { code, fresh } (fresh: reserved just now).
async function reserveCode(db, tenantId, area, listingId) {
  const mine = await db.collection('listingCodes').where('tenantId', '==', tenantId).where('listingId', '==', listingId).limit(1).get();
  if (!mine.empty && !(await db.collection('properties').doc(mine.docs[0].id).get()).exists) return { code: mine.docs[0].id, fresh: false };
  const taken = await takenCodes(db, tenantId);
  for (let i = 0; i < 25; i++) {
    const code = nextCode(area, taken);
    taken.add(code);
    if ((await db.collection('properties').doc(code).get()).exists) continue;
    try {
      await db.collection('listingCodes').doc(code).create({ tenantId, listingId, at: Date.now() });
      const c = snapCache.get(tenantId); if (c) c.reserved.push(code);
      return { code, fresh: true };
    }
    catch (e) { /* someone got it first — the next one */ }
  }
  throw new Error('Could not find a free property code — try again');
}

// ── listing-brochure ──
async function listingBrochure(db, user, body) {
  const cfg = await gate(db, user);
  if (cfg instanceof Response) return cfg;
  const me = lc(user.email);
  const x = await loadListing(db, user, body && body.id);
  const { role, prop } = await roleFor(db, user, x);
  if (!x || !role) return json({ ok: false, error: 'No such listing' }, 404);
  if (x.brochure && x.brochure.requestedAt && now() - x.brochure.requestedAt < 6 * 3600000) return json({ ok: false, error: 'Already asked for — the office is on it' }, 409);
  const facts = factsOf(x, prop);
  const description = str((body && body.description) || x.description || '').slice(0, 4000);
  const miss = [];
  if (!str(facts.title)) miss.push('a title');
  if (!str(facts.photosLink)) miss.push('the photos link');
  if (!description) miss.push('the write-up (what goes in the brochure)');
  if (miss.length) return json({ ok: false, error: 'Add ' + miss.join(', ') + ' first', gaps: miss }, 400);
  if (!(await H.throttle(db, user, 'brochure', 6, 3600000))) return json({ ok: false, error: 'Too many at once — try again in an hour' }, 429);
  let code = x.propertyCode || (x.brochure && x.brochure.code) || '', fresh = false;
  if (!code) ({ code, fresh } = await reserveCode(db, user.tenantId, facts.location || facts.title, x.id));
  const team = await H.teamOf(db, user.tenantId);
  const who = H.nameIn(team, me);
  const internal = `Asked for by ${who} (agent) from My listings.` + (x.sellerName ? ` Owner: ${x.sellerName}` : '') + (x.sellerPhone ? ` ${x.sellerPhone}` : '');
  const form = formBody({ ...x, ...facts, propertyCode: x.propertyCode || '', brochure: { ...(x.brochure || {}), code }, description, internalNotes: internal });
  let sent = false;
  try {
    const r = await (H.fetch || fetch)(FORM_ACTION, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    sent = r.ok || r.status === 302 || r.status === 0;
  } catch (e) { console.error('brochure form:', e.message); }
  if (!sent) {
    if (fresh) await db.collection('listingCodes').doc(code).delete().catch(() => {});   // not used: free again
    return json({ ok: false, error: 'The brochure request didn’t go through — try again in a minute' }, 502);
  }
  const t = now();
  await db.collection('listings').doc(x.id).update({ brochure: { ...(x.brochure || {}), code, requestedAt: t, requestedCode: code, requestedBy: me }, description, updatedAt: t, updatedBy: me });
  await addHistory(db, x, 'field', `Brochure asked for (code <b>${esc(code)}</b>) by ${esc(who)}`, me);
  return json({ ok: true, code });
}

// ── listing-decide (admins) ──
async function listingDecide(db, user, body) {
  const x = await loadListing(db, user, body && body.id);
  if (!x) return json({ ok: false, error: 'No such listing' }, 404);
  const stages = await stagesOf(db, user.tenantId);
  const decision = body && body.decision === 'approve' ? 'approve' : body && body.decision === 'return' ? 'return' : null;
  if (!decision) return json({ ok: false, error: 'Approve or send back' }, 400);
  return decide(db, user, x, stages, decision, String((body && body.note) || ''));
}
async function decide(db, user, x0, stages, decision, rawNote) {
  // Admins approve (the owner's rule: "admin approves before Live") — not agents, and not full-access
  // staff dragging a card on the board; an admin login whose email is not confirmed cannot act.
  if (!(user.role === 'admin' && user.email_verified === true)) return json({ ok: false, error: 'An admin approves — ask one of them' }, 403);
  const me = lc(user.email);
  const note = str(rawNote).slice(0, 500);
  const toApproved = stageOfKey(stages, 'approved'), back = stageOfKey(stages, 'details');
  if (!toApproved || !back) return json({ ok: false, error: 'This board has no Approved or Details & docs column — add it in Shoot & Media → Manage stages' }, 409);
  if (decision === 'return' && !note) return json({ ok: false, error: 'Say what to fix — the agent sees it' }, 400);
  // First decision wins: claimed in a transaction, so My Day and a drag on the board at the same
  // moment cannot both run it. An agent's listing is decided from Sent for approval only.
  const ref = db.collection('listings').doc(x0.id);
  const t = now();
  let x;
  try {
    x = await db.runTransaction(async tr => {
      const s = await tr.get(ref);
      if (!s.exists) throw Object.assign(new Error('No such listing'), { http: 404 });
      const cur = { ...s.data(), id: s.id };
      const k = keyOfId(stages, cur.stageId);
      const deciding = cur.decidingAt && t - cur.decidingAt < 120000;
      if (deciding) throw Object.assign(new Error('Someone is deciding this one right now'), { http: 409 });
      if (['approved', 'live', 'closed'].includes(k)) throw Object.assign(new Error('Already ' + ((stages.find(st => st.id === cur.stageId) || {}).name || k)), { http: 409 });
      if (isAgentListing(cur) && k !== 'for_approval') throw Object.assign(new Error(decision === 'approve' ? 'It hasn’t been sent for approval' : 'It isn’t waiting for approval'), { http: 409 });
      tr.update(ref, { decidingAt: t });
      return cur;
    });
  } catch (e) { if (e.http) return json({ ok: false, error: e.message }, e.http); throw e; }
  const team = await H.teamOf(db, user.tenantId);
  const by = H.nameIn(team, me);
  if (decision === 'return') {
    await ref.update({ prevStageId: x.stageId, stageId: back.id, stageChangedAt: t, stageChangedBy: me, updatedAt: t, updatedBy: me,
      decidingAt: null, adminApproval: { ...(x.adminApproval || {}), decision: 'returned', decidedAt: t, decidedBy: me, decidedByName: by, note } });
    await addHistory(db, x, 'stage', `Sent back to <b>${esc(back.name)}</b> by ${esc(by)}: “${esc(note)}”`, me);
    return json({ ok: true, id: x.id, stageKey: 'details' });
  }
  try {
    const agent = lc(x.agentEmail);
    // Approved. Its property: already made for it (a retry), its own code's (the brochure row reached
    // the sheet first — then it becomes this agent's, hidden till Live), or a new one.
    let prop = x.propertyCode ? await propertyByCode(db, user.tenantId, x.propertyCode) : null;
    if (!prop) {
      const q = await db.collection('properties').where('tenantId', '==', user.tenantId).where('listingId', '==', x.id).limit(1).get();
      if (!q.empty) prop = { ...q.docs[0].data(), id: q.docs[0].id };
    }
    const code = x.propertyCode || (x.brochure && x.brochure.code) || '';
    if (!prop && code) {
      const found = await propertyByCode(db, user.tenantId, code);
      const free = found && (found.listingId === x.id || (!found.listingId && (!AA.primaryOf(found) || AA.primaryOf(found) === agent)));
      const otherListing = found && (await db.collection('listings').where('tenantId', '==', user.tenantId).where('propertyCode', '==', AA.codeOf(found)).get()).docs.some(d => d.id !== x.id);
      if (free && !otherListing) {
        const claim = { listingId: x.id, updatedAt: t, updatedBy: me, ...(found.wentLiveAt ? {} : { listingHidden: true }) };
        if (agent && !AA.primaryOf(found)) Object.assign(claim, AA.assignmentPatch(agent, AA.coAgentsOf(found)), { agentsSetAt: t, agentsSetBy: me });
        if (x.deal && !found.dealType) claim.dealType = x.deal;
        await db.collection('properties').doc(found.id).update(claim);
        if (claim.listingHidden && !found.listingHidden && H.rebuildAgents) await H.rebuildAgents(db, user.tenantId, null).catch(e => console.error('rebuild after hide:', e.message));
        prop = { ...found, ...claim };
      }
    }
    let created = false;
    const patch = {};
    if (!prop) {
      // Its own reserved code if nothing sits there yet; otherwise a freshly reserved one.
      let id = code && CODE_RE.test(codeKey(code)) ? codeKey(code) : '';
      if (id) {
        const r = await db.collection('listingCodes').doc(id).get();
        if ((r.exists && r.data().listingId !== x.id) || (await db.collection('properties').doc(id).get()).exists) id = '';
      }
      if (!id) id = (await reserveCode(db, user.tenantId, x.location || x.title, x.id)).code;
      const doc = {
        id, propertyCode: id, tenantId: user.tenantId, name: x.title || '', location: x.location || '', zone: x.location || '', config: x.config || '',
        startingPrice: x.askingPrice || '', type: x.propType || '', dealType: x.deal || '', sqftRange: x.sqft || '', uds: x.uds || '', photosLink: x.photosLink || '',
        contactName: x.sellerName || '', contactNumber: x.sellerPhone || '', highlights: x.description || '',
        ...(agent ? AA.assignmentPatch(agent, []) : {}), agentsSetAt: t, agentsSetBy: me,
        availability: 'Available', listingHidden: true, source: isAgentListing(x) ? 'agent' : 'office', listingId: x.id, createdAt: t, createdBy: agent || me,
      };
      Object.keys(doc).forEach(k => { if (doc[k] === '') delete doc[k]; });
      // create(), never set(): a property already at that id (anyone's) is never overwritten.
      try { await db.collection('properties').doc(id).create(doc); }
      catch (e) { throw Object.assign(new Error('The code ' + id + ' was just taken — approve again to get a new one'), { http: 409 }); }
      if (x.remarks) await db.collection('properties').doc(id).collection('notes').doc('n' + t).set({ id: 'n' + t, text: x.remarks, kind: 'note', eventDate: '', createdAt: t, author: agent || me });
      const changeId = 'c' + t.toString(36) + randomBytes(3).toString('hex');
      await db.collection('propertyChanges').doc(changeId).set({
        id: changeId, tenantId: user.tenantId, propertyId: id, propertyCode: id, propertyName: x.title || '', propertyLocation: x.location || '', propertyType: x.propType || '',
        field: '(property)', label: 'New property added (listing approved' + (x.agentName ? ', sourced by ' + x.agentName : '') + ')', from: '',
        to: `${x.title || ''} — ${x.location || ''}`, kind: 'create', at: t, by: me, appliedToSheet: false,
      }).catch(e => console.error('listing approved change log:', e.message));
      if (agent) await db.collection('assignmentLog').add({ tenantId: user.tenantId, propertyId: id, propertyName: x.title || '', at: t, by: me,
        from: { primary: null, co: [] }, to: { primary: agent, co: [] }, why: 'Listing approved' }).catch(() => {});
      prop = doc;
      created = true;
    }
    if (!x.propertyCode) patch.propertyCode = AA.codeOf(prop);
    Object.assign(patch, { prevStageId: x.stageId, stageId: toApproved.id, stageChangedAt: t, stageChangedBy: me, updatedAt: t, updatedBy: me,
      decidingAt: null, adminApproval: { ...(x.adminApproval || {}), decision: 'approved', decidedAt: t, decidedBy: me, decidedByName: by, note } });
    const r = P.reachedUpdate(x, 'approved', t);
    if (r) Object.assign(patch, r);
    await ref.update(patch);
    await addHistory(db, x, 'stage', `Approved by ${esc(by)}${created ? ` — added to the inventory as <b>${esc(prop.propertyCode)}</b>` : ''}${note ? ': “' + esc(note) + '”' : ''}`, me);
    if (agent) await H.markDirty(db, user.tenantId, [agent]).catch(() => {});
    return json({ ok: true, id: x.id, stageKey: 'approved', propertyCode: AA.codeOf(prop), created });
  } catch (e) {
    await ref.update({ decidingAt: null }).catch(() => {});
    if (e.http) return json({ ok: false, error: e.message }, e.http);
    throw e;
  }
}

// ── listing-live (staff on the Shoot & Media board): a card moved to Live there opens its
// property to the other agents, as an agent's own Mark Live does. Only when the card IS in Live.
async function listingLive(db, user, body) {
  if (user.role === 'agent') return json({ ok: false, error: 'For the office' }, 403);
  const x = await loadListing(db, user, body && body.id);
  if (!x || !x.propertyCode) return json({ ok: false, error: 'No such listing' }, 404);
  const stages = await stagesOf(db, user.tenantId);
  if (keyOfId(stages, x.stageId) !== 'live') return json({ ok: false, error: 'It is not in Live' }, 409);
  if (isAgentListing(x) && !wasApproved(x)) return json({ ok: false, error: 'An agent’s listing goes Live once an admin has approved it' }, 409);
  const prop = await propertyByCode(db, user.tenantId, x.propertyCode);
  if (!prop || !prop.listingHidden) return json({ ok: true, changed: false });
  await db.collection('properties').doc(prop.id).update({ listingHidden: false, wentLiveAt: now(), updatedAt: now(), updatedBy: lc(user.email) });
  await H.markDirty(db, user.tenantId, AA.agentsOf(prop)).catch(() => {});
  return json({ ok: true, changed: true });
}

// ── listing-queue (admins): what waits for a decision ──
async function listingQueue(db, user) {
  const stages = await stagesOf(db, user.tenantId);
  const st = stageOfKey(stages, 'for_approval');
  if (!st) return json({ ok: true, listings: [] });
  const q = await db.collection('listings').where('tenantId', '==', user.tenantId).where('stageId', '==', st.id).get();
  const list = q.docs.map(d => ({ ...d.data(), id: d.id })).sort((a, b) => ((a.adminApproval && a.adminApproval.sentAt) || 0) - ((b.adminApproval && b.adminApproval.sentAt) || 0))
    .map(x => ({ id: x.id, title: x.title || '', location: x.location || '', config: x.config || '', askingPrice: x.askingPrice || '', deal: x.deal || '', propertyCode: x.propertyCode || '',
      photosLink: x.photosLink || '', agentEmail: x.agentEmail || '', agentName: x.agentName || '', sentAt: (x.adminApproval && x.adminApproval.sentAt) || x.stageChangedAt || 0,
      note: (x.adminApproval && x.adminApproval.note) || '', brochure: brochureOf(x, null).state, duplicateOf: Array.isArray(x.duplicateOf) ? x.duplicateOf : [],
      ownerInformed: !!x.ownerInformed, ownerApproved: !!x.ownerApproved }));
  return json({ ok: true, listings: list });
}

// ── The sheet sync creating a property whose code a listing reserved (its brochure's Inventory row
// reached the sheet before the listing was approved): that listing's agent becomes its primary
// agent, and it stays out of other agents' sight until the listing goes Live. Called by
// api/sync-inventory.js on the properties it is about to create. Mutates `writes`.
export async function claimReservedCreates(db, tenantId, writes, existing) {
  const creates = (writes || []).filter(p => p && p.id && !(existing && existing.has(p.id)));
  if (!creates.length) return 0;
  const refs = creates.map(p => db.collection('listingCodes').doc(codeKey(p.id) || String(p.id)));
  const stages = await stagesOf(db, tenantId);
  const snaps = await db.getAll(...refs);
  let n = 0;
  for (let i = 0; i < creates.length; i++) {
    const s = snaps[i];
    if (!s.exists || s.data().tenantId !== tenantId) continue;
    const ls = await db.collection('listings').doc(String(s.data().listingId)).get();
    if (!ls.exists || ls.data().tenantId !== tenantId) continue;
    const x = ls.data();
    const p = creates[i];
    p.listingId = ls.id;
    // Hidden until its listing goes Live — not one already Live, dropped or sold (nothing to wait for).
    if (!['live', 'dropped', 'closed'].includes(keyOfId(stages, x.stageId))) p.listingHidden = true;
    const agent = lc(x.agentEmail);
    if (agent && x.source !== 'office' && !AA.primaryOf(p)) Object.assign(p, AA.assignmentPatch(agent, []));
    if (x.deal && !p.dealType) p.dealType = x.deal;
    n++;
  }
  return n;
}

export const LISTING_ACTIONS = {
  listings, 'listing-history': listingHistory, 'listing-live': listingLive, 'listing-save': listingSave, 'listing-stage': listingStage, 'listing-brochure': listingBrochure,
};
export const LISTING_ADMIN = { 'listing-decide': listingDecide, 'listing-queue': listingQueue };
