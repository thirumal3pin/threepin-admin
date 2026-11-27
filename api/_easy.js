import Anthropic from '@anthropic-ai/sdk';
import { getDb, verifyCrmUser } from './_bot-shared.js';
import { writeLead, readLeads } from './_lead-views.js';
import { computeAttention, SEVERITY_RANK, isBusinessLead } from '../crm-assets/leadAttention.js';
import { stageKindOf, visitOf, VISIT_STATUS } from '../crm-assets/pipeline.js';
import * as TM from '../shared-assets/task-model.js';
import * as ED from './_easy-data.js';
import * as AA from '../shared-assets/agent-access.js';
// The matching API's own search (api/_match.js): Eåsy's matching answers are the Match page's.
import { runSearch, loadAll as loadMatchData, viewerOf, structureText } from './_match.js';
import { workPost } from './_agent-work.js';
// The CRM's match engine, the same file the match panels run (plain scripts that attach to globalThis).
import '../dashboard-assets/search-engine.js';
import '../shared-assets/chennai-geo.js';
import '../shared-assets/area-model.js';
import '../shared-assets/match-engine.js';
import { relabel } from './_usage.js';

const PinMatch = globalThis.PinMatch;

// ═══════════════════════════════════════════════════════════════════════
// Eåsy by 3 PIN — the CRM's assistant, built to the MVP in the Eåsy Requirements Document (v2).
//
// Plug-and-play: everything Eåsy is lives in api/_easy*.js and crm-assets/easy.*. It is reached
// through api/bot-test-message.js (?op=easy — the Hobby plan's 12-function cap) and switched off
// by EASY_DISABLED=1, which makes the page hide its button.
//
// What it may do on its own: read, and save drafts. It never sends to a lead or a seller — a
// draft opens in the agent's own WhatsApp (wa.me) and the agent answers "Sent?" (MVP-08).
// Anything that changes a record is a pending change the agent confirms with Yes; nothing is
// written to a lead or property before that, and every applied change leaves an audit entry.
//
// Collections it owns (server-only, the Admin SDK): easyDrafts, easyChanges, easyGaps, easyAudit.
// ═══════════════════════════════════════════════════════════════════════

// Haiku only, by the owner's choice (27 Oct 2026): fast and cheap for a chat box. Haiku has no
// server-side refusal fallback, so a request never moves to another model.
export const EASY_MODEL = 'claude-haiku-5-5';
const MAX_TURNS = 8;          // tool rounds per question
const MAX_HISTORY = 12;       // past messages the page may send back
const MAX_ROWS = 25;
const MAX_DRAFT = 1000;       // a wa.me link stays reliable under this (Part C, C3)
const C = { drafts: 'easyDrafts', changes: 'easyChanges', gaps: 'easyGaps', audit: 'easyAudit', meter: 'easyMeter', config: 'easyConfig' };

// ── The daily read budget ─────────────────────────────────────────────────
// Eåsy may not use more than this many Firestore reads a day for a tenant (EASY_DAILY_READS
// overrides). Past it, the background work stops and questions are told when it comes back; the
// agent's own Send / Yes still go through. The count is kept in easyMeter/{tenant}_{day}, the day
// being Google's quota day (US Pacific), and is what Eåsy actually read (metered below).
export const EASY_DAILY_READS = () => Number(process.env.EASY_DAILY_READS) || 8000;
const PT = 'America/Los_Angeles';
export const quotaDay = now => new Date(now).toLocaleDateString('en-CA', { timeZone: PT });
// When Google's quota day next starts, in Indian time ("12:30 pm") — midnight Pacific, DST and all.
export function resetTimeIST(now) {
  const today = quotaDay(now);
  for (let h = 0; h < 48; h++) {
    const t = Math.floor(now / 3600e3) * 3600e3 + h * 3600e3;
    if (quotaDay(t) !== today && quotaDay(t - 3600e3) === today) {
      return new Date(t).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
    }
  }
  return 'midnight US time';
}
export const isQuotaError = e => !!e && (e.code === 8 || e.code === 'resource-exhausted' || /RESOURCE_EXHAUSTED|quota/i.test(String(e.message || '')));
const quotaAnswer = now => [{ quota: true, error: `The database has reached its free daily limit, so the admin site is paused until about ${resetTimeIST(now)} today (Google resets it at midnight US time). Nothing is lost.` }, 503];

// Counts every document Eåsy reads, in one place: the database handed to the handler is this
// wrapper. Anything given back to Firestore (a batch, a transaction, getAll) is unwrapped first.
function metered(db, counter) {
  const raw = new WeakMap();
  const un = x => (x && raw.get(x)) || x;
  const wrapRef = (target, kind) => {
    const p = new Proxy(target, { get(t, k) {
      const v = t[k];
      if (typeof v !== 'function') return v;
      if (k === 'get') return async (...a) => {
        const r = await v.apply(t, a);
        counter.n += kind === 'doc' ? 1 : Math.max(1, (r.docs || []).length);
        return r;
      };
      if (kind === 'doc' && k === 'collection') return (...a) => wrapRef(v.apply(t, a), 'query');
      if (kind === 'query' && ['where', 'orderBy', 'limit', 'select', 'startAfter', 'limitToLast'].includes(k)) return (...a) => wrapRef(v.apply(t, a), 'query');
      if (kind === 'query' && k === 'doc') return (...a) => wrapRef(v.apply(t, a), 'doc');
      return v.bind(t);
    } });
    raw.set(p, target);
    return p;
  };
  const wrapWriter = w => new Proxy(w, { get(t, k) {
    const v = t[k];
    if (typeof v !== 'function') return v;
    if (k === 'get') return async (...a) => { const out = await v.apply(t, a.map(un)); counter.n += out && out.docs ? Math.max(1, out.docs.length) : 1; return out; };
    if (k === 'getAll') return async (...a) => { const out = await v.apply(t, a.map(un)); counter.n += out.length; return out; };
    return (...a) => { const out = v.apply(t, a.map(un)); return out === t ? p2(out) : out; };
  } });
  const p2 = w => wrapWriter(w);
  return new Proxy(db, { get(t, k) {
    const v = t[k];
    if (typeof v !== 'function') return v;
    if (k === 'collection') return (...a) => wrapRef(v.apply(t, a), 'query');
    if (k === 'getAll') return async (...refs) => { const out = await v.apply(t, refs.map(un)); counter.n += refs.length; return out; };
    if (k === 'batch') return (...a) => wrapWriter(v.apply(t, a));
    if (k === 'runTransaction') return (fn, ...a) => v.call(t, tx => fn(wrapWriter(tx)), ...a);
    return v.bind(t);
  } });
}

let _anthropic;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}
// The tests and the local dev server hand in a stand-in model (tests/easy.test.mjs, scripts/easy-dev.mjs).
export function setEasyClient(client) { _anthropic = client; }

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const istNow = now => new Date(now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
const { lc, istDate, codeKey } = ED;
export const easyEnabled = () => !/^(1|true|yes)$/i.test(String(process.env.EASY_DISABLED || ''));

// wa.me wants digits with the country code — bare 10-digit numbers are Indian (as the digest does).
export function waDigits(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  else if (d.length === 11 && d.startsWith('0')) d = '91' + d.slice(1);
  return d.length >= 11 && d.length <= 15 ? d : null;
}

// A record cut down to what answers questions: short strings, numbers, no big nested blobs.
function compact(obj, keep) {
  const out = {};
  for (const k of keep) {
    const v = obj[k];
    if (v == null || v === '') continue;
    if (typeof v === 'string') out[k] = v.length > 300 ? v.slice(0, 300) + '…' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.every(x => typeof x !== 'object')) out[k] = v.slice(0, 10);
  }
  return out;
}

const LEAD_FIELDS = ['name', 'phone', 'email', 'source', 'enquiryType', 'budget', 'propertyInterest', 'requirement', 'location',
  'preferredLocation', 'config', 'bhk', 'aiSummary'];
const PROPERTY_FIELDS = ['propertyCode', 'name', 'type', 'saleType', 'status', 'listingStatus', 'zone', 'location', 'config', 'availability', 'startingPrice',
  'pricePerSqft', 'sqftRange', 'carpetArea', 'facing', 'floorNo', 'furnishing', 'parking', 'approval', 'possession', 'propertyAge',
  'highlights', 'nearbyLandmark', 'connectivity', 'builder', 'contactName'];

const codeOf = p => p.propertyCode || p.id;
const matches = (row, words) => { const hay = JSON.stringify(row).toLowerCase(); return words.every(w => hay.includes(w)); };
const wordsOf = q => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
const obj = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const S = d => ({ type: 'string', description: d });

const TOOLS = [
  { name: 'my_day', description: "The signed-in agent's plan for today (MVP-10): site visits at their times, then escalations, hot leads, overdue and due follow-ups, tasks, leads going cold, seller-detail chases and unconfirmed messages, each placed in a 30-minute slot. Use for \"what is my day\", \"plan my day\", \"who do I follow up today\", \"what should I do next\".", input_schema: obj({}) },
  { name: 'search_leads', description: 'Find leads by any words — name, phone, area, budget, configuration, source, stage name. Every word must match. Empty query lists the most recently touched. For "who went cold" use cold_days: 7 — that gives the deals that went quiet 7–21 days ago, most important first; older silent leads are left out on purpose. Use a bigger number only when the agent names a longer gap ("silent for a month" → 30).', input_schema: obj({ query: S('Words to match, e.g. "velachery 3bhk" or "shiva"'), cold_days: { type: 'integer', description: '7 for "going cold"; more only when the agent names a longer gap' } }) },
  { name: 'lead_summary', description: "One lead in full (MVP-07): requirement, stage, last contact, the latest chat messages, the team's notes, the site visit, the next planned step and the best-matching properties. Use for \"summary of Shiva\" and before drafting to that lead. Needs the lead id from search_leads.", input_schema: obj({ id: S('Lead id') }, ['id']) },
  { name: 'search_properties', description: 'Find properties by any words — area, configuration ("2 BHK"), project name, property code, facing. Every word must match.', input_schema: obj({ query: S('Words to match, e.g. "anna nagar 3 bhk"') }) },
  { name: 'property_summary', description: "One property in full (MVP-06): facts, price, status, how complete it is and what is missing (MVP-03), the site visits so far, the brochure link and the owner's name. Takes the property code (e.g. ANN001) or id.", input_schema: obj({ code: S('Property code or id') }, ['code']) },
  { name: 'match_buyers', description: "Leads who fit a property (MVP-05), scored by the CRM's own match engine — the same as the match panel. Strong matches and near matches separately, each with reasons. Only when asked.", input_schema: obj({ code: S('Property code or id') }, ['code']) },
  { name: 'draft_message', description: "Save a WhatsApp message for the agent to send from their own phone (MVP-08). The page shows it with a Send button that opens the agent's WhatsApp with the text filled in. Use this for EVERY message meant for a lead or a property owner — one call per person — never write the message in your reply. to=lead needs lead_id; to=owner needs the property code.", input_schema: obj({ to: { type: 'string', enum: ['lead', 'owner'] }, lead_id: S('Lead id, for to=lead'), code: S('Property code, for to=owner'), text: S('The message, under 1000 characters, in the language the person uses') }, ['to', 'text']) },
  { name: 'ask_owner_for_missing', description: 'MVP-03: draft a message to the property owner asking for the missing details, and track each one as asked. fields are labels from property_summary.missing (e.g. "photos", "map pin"). Shows a Send button like draft_message.', input_schema: obj({ code: S('Property code'), fields: { type: 'array', items: { type: 'string' } }, text: S('The message to the owner, polite, in their language') }, ['code', 'fields', 'text']) },
  { name: 'propose_property_add', description: 'MVP-01: prepare a new property from what the agent said (e.g. "Add a 2BHK in Velachery, 72 lakhs, owner Rajan 98400 12345"). Nothing is saved until the agent taps Yes on the card; it then gets the next free code for its area and is saved as a draft listing. Fill only what was said.', input_schema: obj({ fields: { type: 'object', description: 'Any of: name, type, config, location, startingPrice, sqftRange, facing, floorNo, furnishing, contactName, contactNumber, highlights, nearbyLandmark, availability', additionalProperties: { type: 'string' } } }, ['fields']) },
  { name: 'propose_property_update', description: 'MVP-02: prepare a change to an existing property ("ANN001 price is now 1.3 Cr", "VEL007 is on hold"). The card reads the change back (old → new) and it is applied only after Yes. Put on-hold / sold / available in availability.', input_schema: obj({ code: S('Property code or id'), changes: { type: 'object', description: 'Field → new value. Fields: ' + Object.keys(ED.PROPERTY_EDITABLE).join(', '), additionalProperties: { type: 'string' } } }, ['code', 'changes']) },
  { name: 'propose_note', description: 'MVP-15 / MVP-09: prepare a note from what the agent said or typed after a call — about a lead, a property, or both ("Priya liked ANN001 but wants a covered car park"). It goes on the lead (and as feedback on the property), and can set the lead\'s next follow-up. Applied only after Yes. Resolve the lead and property first; if unsure which, ask instead of calling this.', input_schema: obj({ lead_id: S('Lead id, if the note is about a lead'), code: S('Property code, if it is about a property'), text: S('The note, cleaned up, in the agent\'s words'), property_feedback: S('What to log on the property, if different from text'), follow_up_at: S('Next follow-up as an ISO date-time with +05:30, only if the agent gave one'), call: { type: 'boolean', description: 'true when these are notes after a phone call' } }, ['text']) },
  { name: 'brochure', description: "MVP-04: the property's brochure link if it has one. If it has none, says so (new brochures are made by the existing brochure pipeline). To send it to a lead, follow with draft_message including the link.", input_schema: obj({ code: S('Property code or id') }, ['code']) },
  { name: 'seller_summaries', description: "MVP-14: this week's site-visit summary for each property that had visits, drafted as a message to its owner with a Send button. Use for \"seller summaries\", \"weekly owner update\".", input_schema: obj({ code: S('Only this property (optional)') }) },
  { name: 'team_overview', description: "MVP-16, for the admin: each agent's day — visits today, follow-ups due, messages drafted / opened / confirmed sent this week, pending changes, open seller-detail asks. Refused for non-admins.", input_schema: obj({}) },
  { name: 'find_properties', description: 'Properties for a requirement — scored by the match engine across EVERYTHING we hold: onboarded inventory AND stock not yet onboarded (Shoot board cards at any stage, CRM seller leads not yet processed, agent submissions). Give either the requirement in words ("2 grounds land for JV in Chennai", "3 BHK Anna Nagar or Kilpauk ~3 Cr, not Mogappair") or a lead_id (uses that client\'s saved requirements; req_index picks one when they have several). Each result says its source and status (e.g. "Shoot board · More details pending") — never call an un-onboarded one a listing.', input_schema: obj({ requirement: S('The requirement in the words used'), lead_id: S('A client lead id instead of words'), req_index: { type: 'integer', description: 'Which of the client\'s requirements (0 = main)' } }) },
  { name: 'find_clients', description: 'Clients (buyers / tenants) who fit a property — use for "who wants this?", "any buyers for a 3 BHK in Anna Nagar at 3 Cr?", and BEFORE taking a property from a seller ("is there demand?"). Give a property code, or describe the property in words (type, BHK, place, size, price, sale/rent/JV). Results carry score, reasons, budget difference and the next step. A result with access "restricted" belongs to another agent or the office: say so and offer request_access with its ref — never guess their details.', input_schema: obj({ code: S('Property code or id, if it is in the inventory'), description: S('The property in words, if it is not') }) },
  { name: 'unonboarded_demand', description: 'Seller enquiries and Shoot board properties NOT yet onboarded that already have matching buyers — best first, with how many buyers and strong matches each. scope "shoot" limits it to properties at the shoot stages. Use for "which seller leads should we onboard first", "shoot-stage properties with buyers".', input_schema: obj({ scope: { type: 'string', enum: ['unprocessed', 'shoot'] } }) },
  { name: 'structure_requirement', description: 'Read a requirement (typed text, or a client\'s whole record by lead_id) into structured fields with the AI — several requirements if they have more than one — and prepare it as a card the agent reviews; it is saved on the lead (beside, never over, the CRM fields, with history) only after Yes. Use when asked to "update / structure / save the requirement" for a client.', input_schema: obj({ lead_id: S('The client lead id'), text: S('The requirement in words, if given now') }, ['lead_id']) },
  { name: 'request_access', description: 'For an agent: ask for the details of a matching client held by another agent or the office (a find_clients result with access "restricted" carries a ref). Prepared as a card; sent to the approvers after Yes.', input_schema: obj({ ref: S('The ref from a restricted result'), reason: S('One line: which property or client it is for'), property_code: S('The agent\'s own property it is for, if any') }, ['ref']) }
];

const SYSTEM = `You are Eåsy by 3 PIN (spoken "easy"), the assistant inside 3 PIN Realty's CRM in Chennai. The people asking are 3 PIN's own team: agents and the admin. Agents often ask while on a call with a client, so be quick and to the point.

Answer only from what your tools return. If the tools do not have it, say the record doesn't hold that detail; never guess a name, number, price or date. When a name matches more than one lead or property, ask one short question listing the options instead of picking one. Read dates in Indian time: "Saturday 11" is the coming Saturday at 11:00, "tomorrow 2" is 14:00.

You read, you draft, and you prepare changes. You never send anything and never change a record yourself:
- Any message for a lead or a property owner goes through draft_message (or ask_owner_for_missing), one per person, never as text in your reply. Then say in one line what you drafted.
- Adding or changing a property, and saving a note, go through the propose_ tools; the agent confirms on the card. Say what you prepared in one line; do not ask "shall I?" — the card asks.
Write drafts the way a polite Chennai agent writes on WhatsApp, in Tamil if the person writes in Tamil. Never put an owner's phone number in a message to a lead, and never share a property's exact address with a lead — area and landmark only.

Be precise and brief. For "who to follow up", "what should I do" and similar, give only the few that matter most right now — at most 5 to 8, most important first, one short line each with the reason — and say how many lower-priority ones you left out rather than listing them. Old, inactive leads are not worth mentioning unless a follow-up on them is actually due. Never paste a long list; offer "say 'show more' for the rest".

Keep answers short and scannable: a line or two, then a short list if needed. Use ₹ and Indian number style (L, Cr). When you name a lead, add its id in this exact form so the page can link it: [lead:THE_ID].

Matching (find_properties, find_clients, unonboarded_demand): the score, reasons and gaps come from the match engine — repeat them, never add reasons of your own or change a percentage. Say each property's source and status as given ("on the Shoot board, more details pending", "a seller lead not yet processed") and that seller-provided details are not yet verified. Lead with the 3–5 best; mention what is "not known yet" when it matters. A restricted result belongs to another agent or the office — say so and offer request_access; never reveal or guess their name or number. For the full list with filters, point them to the Match page.`;

// ── Reading, cheaply ──────────────────────────────────────────────────────
// Firestore bills a read per document, and the free plan stops every page at 50K a day (it did,
// 28 Oct 2026, when each open page asked for reminders every minute and each ask read every lead
// and property). So: leads come from the lead views (~1 read per 20 leads, as the CRM reads
// them), and a warm function keeps what it read for a short while — leads 1 minute, the
// pipeline and the inventory 10 minutes. A change Eåsy makes clears the cache it touched.
const HOUR_MS = 60 * 60 * 1000;
const TTL = { leads: 60 * 1000, stages: 10 * 60 * 1000, props: 10 * 60 * 1000, config: 60 * 1000, team: 10 * 60 * 1000 };
const cache = new Map();          // `${what}:${tenant}` → { at, p }
function cached(what, tenant, load) {
  const k = what + ':' + tenant, hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL[what]) return hit.p;
  const p = load().catch(e => { cache.delete(k); throw e; });
  cache.set(k, { at: Date.now(), p });
  return p;
}
export const forget = (what, tenant) => { for (const k of [...cache.keys()]) if ((!what || k.startsWith(what + ':')) && (!tenant || k.endsWith(':' + tenant))) cache.delete(k); };
const loadLeads = (db, T) => cached('leads', T, () => readLeads(db, T));
// The admin's on/off switch (easyConfig/{tenant}.on) and who the admins are (taskConfigs managers).
// Off until an admin turns it on — from the CRM's ⋮ menu, or ⏻ in the panel.
const isOn = cfg => !!cfg && cfg.on === true;
const loadConfig = (db, T) => cached('config', T, () => db.collection(C.config).doc(T).get().then(s => (s.exists ? s.data() : {})));
const loadTeam = (db, T) => cached('team', T, () => db.collection('taskConfigs').doc(T).get().then(s => (s.exists ? s.data() : null)));
const loadStages = (db, T) => cached('stages', T, () => db.collection('pipelines').doc(T).get().then(s => (s.exists ? s.data().stages : null) || []));
const loadProps = (db, T) => cached('props', T, () => db.collection('properties').where('tenantId', '==', T).get().then(s => s.docs.map(d => ({ ...d.data(), id: d.id }))));

// ── The tools ─────────────────────────────────────────────────────────────

function makeTools(db, user, now, out, scope) {
  let leadsP, stagesP, propsP, cfgP, viewerP;
  const T = user.tenantId;
  const isAgent = user.role === 'agent';
  const me = lc(user.email);
  const stages = () => stagesP || (stagesP = loadStages(db, T));
  // An agent's Eåsy sees what the agent layer lets them see: their own leads (and any granted to
  // them), every property through its access level. Staff see everything, as before.
  const viewer = () => viewerP || (viewerP = scope ? Promise.resolve(scope) : viewerOf(db, user));
  const leads = () => leadsP || (leadsP = isAgent
    ? Promise.all([loadLeads(db, T), viewer()]).then(([ls, v]) => ls.filter(l => AA.leadVisibleTo(l, me) || (v.grants || []).some(g => g.kind === 'lead' && String(g.targetId) === String(l.id) && lc(g.agentEmail) === me && AA.grantLive(g, now))))
    : loadLeads(db, T));
  const props = () => propsP || (propsP = loadProps(db, T));
  // How much of a property this person may see: 'full' for staff and the agent's own / co / granted
  // ones, 'summary' (the admin's chosen fields, no owner) for the rest.
  async function accessTo(p) {
    if (!isAgent || !p) return 'full';
    if (AA.roleOn(p, me)) return 'full';
    const v = await viewer();
    if ((v.grants || []).some(g => g.kind === 'property' && String(g.targetId) === String(p.id) && lc(g.agentEmail) === me && AA.grantLive(g, now))) return 'full';
    return AA.isActiveProperty(p) ? 'summary' : 'none';
  }
  async function shaped(p) {
    const a = await accessTo(p);
    if (a === 'full') return propertyRow(p);
    if (a === 'none') return null;
    const v = await viewer();
    const allowed = new Set((v.cfg && v.cfg.otherPropertyFields) || ['name', 'location', 'config', 'type']);
    const row = propertyRow(p);
    const outRow = { id: row.id, code: row.code, access: 'summary', note: 'Another agent\'s property — request access for its full details' };
    for (const [k, val] of Object.entries(row)) if (allowed.has(k) || (k === 'price' && (allowed.has('price') || allowed.has('startingPrice')))) outRow[k] = val;
    delete outRow.contactName;
    return outRow;
  }
  const matchData = () => loadMatchData(db, T);
  const MATCH_ROW = r => ({
    name: r.name, code: r.code || null, source: r.sourceLabel, status: r.status, verified: r.verified, trust: r.trustLabel,
    match: r.pct + '%', band: r.band && r.band.label, confidence: r.confidence, price: r.price || null, location: r.location || null, size: r.area || null,
    why: (r.for || []).slice(0, 3).map(f => f.why), against: (r.against || []).slice(0, 2).map(f => f.why), notKnownYet: (r.unknown || []).slice(0, 2).map(u => u.why),
    budget: r.budget ? r.budget.text : null, next: r.next, open: r.link && r.link.type !== 'restricted' ? `${r.link.type}:${r.link.id}` : null, access: r.access
  });
  const CLIENT_ROW = r => r.access === 'restricted'
    ? { access: 'restricted', ref: r.ref, who: r.ownerName || 'another agent / the office', requirement: r.requirement || null, match: r.pct + '%', band: r.band && r.band.label, why: (r.for || []).slice(0, 2).map(f => f.why) }
    : { id: r.leadId, name: r.name, match: r.pct + '%', band: r.band && r.band.label, confidence: r.confidence, stage: r.stage, budget: r.budget || null,
      wants: [r.config, (r.types || []).join('/'), r.locations.length ? 'in ' + r.locations.join(', ') : '', r.dealLabel].filter(Boolean).join(' '),
      why: (r.for || []).slice(0, 2).map(f => f.why), against: (r.against || []).slice(0, 1).map(f => f.why), budgetDiff: r.budgetDiff ? r.budgetDiff.text : null,
      lastContact: istDate(r.lastTouch), owner: r.ownerName || r.owner || null, next: r.next, ...(r.reqCount > 1 ? { requirement: '#' + (r.reqIndex + 1) + ' of ' + r.reqCount } : {}) };
  const config = () => cfgP || (cfgP = db.collection('taskConfigs').doc(T).get().then(s => (s.exists ? s.data() : null)));
  const own = (coll) => db.collection(coll).where('tenantId', '==', T).get().then(s => s.docs.map(d => ({ ...d.data(), id: d.id })));
  const kindOf = (l, st) => stageKindOf(st.find(x => x.id === l.stageId) || null);

  async function findProperty(code) {
    const list = await props();
    return list.find(p => codeKey(p.propertyCode) === codeKey(code)) || list.find(p => lc(p.id) === lc(code)) || null;
  }
  const notesOf = (ref, n = 8) => ref.collection('notes').orderBy('createdAt', 'desc').limit(n).get()
    .then(s => s.docs.map(d => d.data())).catch(() => []);

  function leadRow(l, st) {
    const stage = st.find(s => s.id === l.stageId);
    const top = computeAttention(l, { stages: st, now })[0];
    const v = visitOf(l);
    return {
      id: l.id, ...compact(l, LEAD_FIELDS),
      stage: stage ? stage.name : null,
      heat: l.tt && l.tt.status ? l.tt.status : null,
      followUpAt: istDate(l.followUpAt),
      lastContact: istDate((l.tt && l.tt.lastMessageAt) || l.updatedAt),
      siteVisit: v.at ? `${VISIT_STATUS[v.status] || v.status} · ${istDate(v.at)}${v.property ? ' · ' + v.property : ''}` : null,
      needs: top ? `${top.label}${top.detail ? ' (' + top.detail + ')' : ''}` : null,
      teamNext: l.ai && l.ai.next && l.ai.next.action ? l.ai.next.action : null
    };
  }
  function propertyRow(p) {
    const prof = PinMatch.propertyProfile(p);
    return { id: p.id, code: codeOf(p), ...compact(p, PROPERTY_FIELDS), price: PinMatch.priceLabel(prof) || p.startingPrice || null };
  }

  // A draft for the agent's own WhatsApp; the phone always comes from the record, never the model.
  async function saveDraft({ to, leadId, property, text, extra = {} }) {
    text = String(text || '').trim();
    if (!text) return { error: 'Empty message' };
    if (text.length > MAX_DRAFT) {
      // Cut at a sentence end where there is one (Part C, C8).
      const cut = text.slice(0, MAX_DRAFT);
      const end = Math.max(cut.lastIndexOf('. ') + 1, cut.lastIndexOf('\n'));
      text = (end > MAX_DRAFT / 2 ? cut.slice(0, end) : cut).trim();
    }
    let toName, phone, about;
    if (to === 'lead') {
      const snap = await db.collection('leads').doc(String(leadId || '')).get();
      if (!snap.exists || snap.data().tenantId !== T) return { error: 'No such lead' };
      toName = snap.data().name || 'the lead'; phone = snap.data().phone; about = { type: 'lead', id: snap.id };
    } else {
      if (!property) return { error: 'No such property' };
      toName = property.contactName || 'the owner'; phone = property.contactNumber; about = { type: 'property', id: property.id, code: codeOf(property) };
    }
    const digits = waDigits(phone);
    if (!digits) return { error: `${toName} has no usable phone number on the record` };
    const ref = db.collection(C.drafts).doc();
    await ref.set({ tenantId: T, by: lc(user.email), to, toName, phone: digits, about, text, status: 'draft', createdAt: Date.now(), ...extra });
    out.drafts.push({ id: ref.id, to, toName, phone: digits, text, about });
    return { saved: true, draftId: ref.id, to: toName, shownWithSendButton: true };
  }

  // A change the agent confirms on a card; nothing touches the record until then.
  async function propose(kind, payload, title, lines) {
    const ref = db.collection(C.changes).doc();
    await ref.set({ tenantId: T, by: lc(user.email), kind, payload, title, lines, status: 'pending', createdAt: Date.now() });
    out.changes.push({ id: ref.id, kind, title, lines });
    return { prepared: true, changeId: ref.id, shownAsCardWithYesNo: true, readBack: lines };
  }

  return {
    async my_day() {
      const [ls, st, tasks, gaps, drafts] = await Promise.all([leads(), stages(), own('tasks'), own(C.gaps), own(C.drafts)]);
      const plan = ED.buildDayPlan({ leads: ls, stages: st, tasks, gaps, drafts, email: user.email, now });
      out.plan = plan;
      return { you: user.email, plan: plan.map(p => ({ time: p.time, priority: p.priority, title: p.title, detail: p.detail || null, leadId: p.leadId || null })),
        lowerPriorityNotListed: plan.more || 0 };
    },

    async search_leads({ query, cold_days } = {}) {
      const [ls, st] = await Promise.all([leads(), stages()]);
      if (cold_days) {
        // Going cold: open leads that were moving and went quiet recently — not every old record.
        // Most valuable first (the deal furthest along, hot, then the most recently quiet).
        const quiet = l => now - (l.updatedAt || 0);
        const rows = ls.filter(l => !['won', 'lost', 'hold'].includes(kindOf(l, st)) && !isBusinessLead(l)
            && quiet(l) >= cold_days * 86400000 && quiet(l) <= (cold_days <= 14 ? 21 : Math.ceil(cold_days * 1.5)) * 86400000
            && (ED.leadWeight(l, st) >= 2 || ED.isHot(l)))
          .sort((a, b) => ED.leadWeight(b, st) - ED.leadWeight(a, st) || (ED.isHot(b) - ED.isHot(a)) || quiet(a) - quiet(b))
          .map(l => leadRow(l, st)).filter(r => matches(r, wordsOf(query)));
        return { total: rows.length, leads: rows.slice(0, 10), note: 'Recently gone quiet and worth a follow-up, most important first. Older inactive leads are left out on purpose.' };
      }
      const rows = [...ls].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map(l => leadRow(l, st)).filter(r => matches(r, wordsOf(query)));
      return { total: rows.length, leads: rows.slice(0, MAX_ROWS) };
    },

    async lead_summary({ id }) {
      const ref = db.collection('leads').doc(String(id || ''));
      const snap = await ref.get();
      if (!snap.exists || snap.data().tenantId !== T) return { error: 'No such lead' };
      const lead = { ...snap.data(), id: snap.id };
      if (isAgent && !(await leads()).some(l => l.id === lead.id)) return { error: 'That lead is not yours — it belongs to another agent or the office' };
      const [st, list, notes, chat] = await Promise.all([
        stages(), props(), notesOf(ref),
        ref.collection('tailortalk').doc('state').get()
          .then(s => ((s.exists && s.data().chat) || []).filter(m => m && m.content).slice(-6)
            .map(m => ({ from: m.role === 'user' ? 'lead' : m.role === 'human_agent' ? 'team' : 'bot', text: String(m.meta && m.meta.type === 'reply' && m.meta.user_message ? m.meta.user_message : m.content).slice(0, 400) })))
          .catch(() => [])
      ]);
      void list;
      // Across everything we hold — onboarded or not — as the Match page shows it.
      const found = await runSearch({ db, user, body: { mode: 'properties', leadId: lead.id, limit: 3, filters: { minPct: 55 } }, viewer: await viewer(), data: await matchData() }).catch(() => ({ rows: [] }));
      const best = (found.rows || []).map(MATCH_ROW);
      return { ...leadRow(lead, st), latestChat: chat, notes: notes.map(n => ({ at: istDate(n.createdAt), by: n.by || n.author || null, text: String(n.text || '').slice(0, 500) })), matchedProperties: best };
    },

    async search_properties({ query } = {}) {
      const list = await props();
      const rows = (await Promise.all(list.filter(p => matches(propertyRow(p), wordsOf(query))).map(shaped))).filter(Boolean);
      if (rows.length || !String(query || '').trim()) return { total: rows.length, properties: rows.slice(0, MAX_ROWS) };
      // No property contains those words — read them as a requirement instead ("3bhk anna nagr 2 cr").
      const found = await runSearch({ db, user, body: { mode: 'properties', text: query, limit: 8, filters: { minPct: 55 } }, viewer: await viewer(), data: await matchData() });
      return { total: found.total || 0, readAsRequirement: true, properties: (found.rows || []).map(MATCH_ROW) };
    },

    async property_summary({ code }) {
      const p = await findProperty(code);
      if (!p) return { error: `No property ${code}` };
      const acc = await accessTo(p);
      if (acc === 'none') return { error: `No property ${code}` };
      if (acc === 'summary') return { ...(await shaped(p)), howToGetMore: 'request access to this property in the Properties page' };
      const [ls, st, gaps] = await Promise.all([leads(), stages(), own(C.gaps)]);
      const visits = ls.map(l => ({ l, v: visitOf(l) }))
        .filter(x => x.v.at && ED.findPropertyFor(x.v.property, [p]))
        .sort((a, b) => b.v.at - a.v.at)
        .map(x => ({ lead: x.l.name || x.l.id, leadId: x.l.id, at: istDate(x.v.at), status: VISIT_STATUS[x.v.status] || x.v.status, stage: (st.find(s => s.id === x.l.stageId) || {}).name || null }));
      const c = ED.completeness(p);
      const asked = gaps.filter(g => g.propertyId === p.id && g.status === 'asked').map(g => `${g.label} (asked ${istDate(g.askedAt)})`);
      return { ...propertyRow(p), ownerName: p.contactName || null, brochure: p.brochureLink || null, completeness: c.pct + '%', missing: c.missing, alreadyAskedOwner: asked, siteVisits: visits };
    },

    async match_buyers({ code }) {
      const p = await findProperty(code);
      if (!p) return { error: `No property ${code}` };
      if ((await accessTo(p)) === 'none') return { error: `No property ${code}` };
      const found = await runSearch({ db, user, body: { mode: 'clients', propertyId: p.id, limit: 25, filters: { minPct: 55 } }, viewer: await viewer(), data: await matchData() });
      const all = found.rows || [];
      return { property: await shaped(p), total: found.total || 0, matches: all.filter(r => r.pct >= 70).slice(0, 15).map(CLIENT_ROW), nearMatches: all.filter(r => r.pct < 70).slice(0, 10).map(CLIENT_ROW) };
    },

    async draft_message({ to, lead_id, code, text }) {
      if (isAgent && to === 'lead' && !(await leads()).some(l => l.id === String(lead_id || ''))) return { error: 'That lead is not yours' };
      const prop = to === 'owner' ? await findProperty(code) : null;
      if (isAgent && to === 'owner' && !(prop && AA.roleOn(prop, me))) return { error: 'Only the property\'s own agents can message its owner' };
      return saveDraft({ to, leadId: lead_id, property: prop, text });
    },

    async ask_owner_for_missing({ code, fields, text }) {
      const p = await findProperty(code);
      if (!p) return { error: `No property ${code}` };
      if (isAgent && !AA.roleOn(p, me)) return { error: 'Only the property\'s own agents can ask its owner' };
      const labels = (fields || []).map(String).filter(Boolean);
      if (!labels.length) return { error: 'Say which details to ask for' };
      const r = await saveDraft({ to: 'owner', property: p, text, extra: { gaps: labels } });
      if (r.error) return r;
      const at = Date.now();
      const b = db.batch();
      for (const label of labels) {
        b.set(db.collection(C.gaps).doc(), { tenantId: T, propertyId: p.id, code: codeOf(p), label, status: 'asked', askedAt: at, askedBy: lc(user.email), draftId: r.draftId });
      }
      await b.commit();
      return { ...r, tracking: labels };
    },

    async propose_property_add({ fields }) {
      if (isAgent) return { error: 'Agents add properties from My listings (they go to the office for approval) — not from Eåsy' };
      const f = {};
      for (const [k, v] of Object.entries(fields || {})) if (ED.PROPERTY_EDITABLE[k] && String(v).trim()) f[k] = String(v).trim();
      if (!f.location) return { error: 'Need at least the locality to add a property' };
      const list = await props();
      const code = ED.nextCode(f.location, list);
      const c = ED.completeness(f);
      const lines = [`Code: ${code} (draft listing)`, ...Object.entries(f).map(([k, v]) => `${ED.PROPERTY_EDITABLE[k]}: ${v}`), c.missing.length ? `Still missing: ${c.missing.join(', ')}` : 'All mandatory details present'];
      return propose('property_add', { code, fields: f }, `Add property ${code}?`, lines);
    },

    async propose_property_update({ code, changes }) {
      if (isAgent) return { error: 'Property changes go through the office — tell them, or use My listings for your own submissions' };
      const p = await findProperty(code);
      if (!p) return { error: `No property ${code}` };
      const ch = {};
      for (const [k, v] of Object.entries(changes || {})) if (ED.PROPERTY_EDITABLE[k] && String(v).trim() && String(v).trim() !== String(p[k] || '')) ch[k] = String(v).trim();
      if (!Object.keys(ch).length) return { error: 'Nothing to change — the record already says that, or the field cannot be edited here' };
      const lines = Object.entries(ch).map(([k, v]) => `${ED.PROPERTY_EDITABLE[k]}: ${p[k] || '—'} → ${v}`);
      return propose('property_update', { propertyId: p.id, code: codeOf(p), changes: ch }, `Change ${codeOf(p)}?`, lines);
    },

    async propose_note({ lead_id, code, text, property_feedback, follow_up_at, call }) {
      text = String(text || '').trim();
      if (!text) return { error: 'Empty note' };
      let lead = null, p = null;
      if (lead_id) {
        if (isAgent && !(await leads()).some(l => l.id === String(lead_id))) return { error: 'That lead is not yours' };
        const snap = await db.collection('leads').doc(String(lead_id)).get();
        if (!snap.exists || snap.data().tenantId !== T) return { error: 'No such lead' };
        lead = { id: snap.id, name: snap.data().name || 'lead' };
      }
      if (code) { p = await findProperty(code); if (!p) return { error: `No property ${code}` }; if (isAgent && !AA.roleOn(p, me)) return { error: 'Feedback goes on your own properties only' }; }
      if (!lead && !p) return { error: 'Say which lead or property the note is about' };
      let fu = null;
      if (follow_up_at) {
        fu = Date.parse(follow_up_at);
        if (!Number.isFinite(fu)) return { error: 'Could not read the follow-up date' };
        if (fu < now - 60000) return { error: `${istDate(fu)} is in the past — ask the agent for the date again` };
      }
      const lines = [
        lead ? `Note on ${lead.name}: ${text}` : null,
        p ? `Feedback on ${codeOf(p)}: ${property_feedback || text}` : null,
        fu ? `Next follow-up: ${istDate(fu)}` : null
      ].filter(Boolean);
      return propose('note', { leadId: lead && lead.id, propertyId: p && p.id, code: p && codeOf(p), text, propertyText: property_feedback || text, followUpAt: fu, call: !!call },
        call ? `Save the call notes${lead ? ' for ' + lead.name : ''}?` : 'Save this note?', lines);
    },

    async brochure({ code }) {
      const p = await findProperty(code);
      if (!p) return { error: `No property ${code}` };
      if ((await accessTo(p)) !== 'full') return { error: `${code} is another agent's property — request access to share its brochure` };
      // Brochure_Link may list several files, comma-separated: a link for each, the brochure first.
      const urls = String(p.brochureLink || '').split(/[\s,]+/).filter(u => /^https?:\/\//i.test(u));
      if (urls.length) {
        urls.forEach((url, i) => out.links.push({ label: `${i ? 'File ' + (i + 1) : 'Brochure'} — ${codeOf(p)}`, url }));
        return { code: codeOf(p), brochure: urls[0], otherFiles: urls.slice(1), shownAsLink: true };
      }
      return { code: codeOf(p), brochure: null, note: 'No brochure on this property yet. New brochures come from the brochure pipeline; the photos link and highlights should be filled first.', missing: ED.completeness(p).missing };
    },

    async seller_summaries({ code } = {}) {
      if (isAgent) return { error: 'Weekly owner summaries are sent by the office' };
      const [ls, list] = await Promise.all([leads(), props()]);
      const want = code ? await findProperty(code) : null;
      if (code && !want) return { error: `No property ${code}` };
      const notesByLead = {};
      await Promise.all(ls.filter(l => visitOf(l).at).map(async l => { notesByLead[l.id] = await notesOf(db.collection('leads').doc(l.id), 10); }));
      let rows = ED.sellerSummaries({ leads: ls, properties: want ? [want] : list, notesByLead, now });
      const made = [];
      for (const r of rows) {
        const p = list.find(x => x.id === r.propertyId);
        const d = await saveDraft({ to: 'owner', property: p, text: r.text, extra: { kind: 'seller_summary' } });
        made.push({ code: r.code, owner: r.owner, visits: r.visits, drafted: !d.error, problem: d.error || null });
      }
      return { week: 'this week (Mon–today)', properties: made, none: made.length ? null : 'No property had a site visit this week, so there is nothing to send.' };
    },

    async find_properties({ requirement, lead_id, req_index } = {}) {
      const body = lead_id ? { mode: 'properties', leadId: lead_id, reqIndex: req_index } : { mode: 'smart', text: requirement };
      if (!lead_id && !String(requirement || '').trim()) return { error: 'Say the requirement, or which client' };
      const found = await runSearch({ db, user, body: { ...body, limit: 10, filters: { minPct: 50 } }, viewer: await viewer(), data: await matchData() });
      if (found.error) return { error: found.error };
      if (found.mode === 'clients') return { note: 'That reads as a search for clients — use find_clients' };
      const reading = found.reading ? (found.reading.chips || (found.reading.requirements && found.reading.requirements[found.reading.requirements.length > 1 && req_index != null ? req_index : 0] || {}).chips || []).map(c => `${c.label}: ${c.value}${c.note ? ' (' + c.note + ')' : ''}`) : [];
      const missing = found.reading && (found.reading.missing || (found.reading.requirements && found.reading.requirements[0] && found.reading.requirements[0].missing)) || [];
      return { understood: reading, notStated: missing, total: found.total, bySource: found.counts || {}, results: (found.rows || []).slice(0, 8).map(MATCH_ROW),
        ...(found.reading && found.reading.requirements && found.reading.requirements.length > 1 ? { theyHaveRequirements: found.reading.requirements.map(r => '#' + (r.index + 1) + ': ' + (r.text || r.chips.map(c => c.value).join(', '))) } : {}) };
    },

    async find_clients({ code, description } = {}) {
      let body;
      if (code) {
        const p = await findProperty(code);
        if (p) body = { mode: 'clients', propertyId: p.id };
        else return { error: `No property ${code} in the inventory — describe it instead` };
      } else if (String(description || '').trim()) body = { mode: 'clients', text: description };
      else return { error: 'Give the property code, or describe the property' };
      const found = await runSearch({ db, user, body: { ...body, limit: 25, filters: { minPct: 50 } }, viewer: await viewer(), data: await matchData() });
      if (found.error) return { error: found.error };
      const rows = found.rows || [];
      return { property: found.about || null, total: found.total, strong: rows.filter(r => r.pct >= 80).length, clients: rows.slice(0, 12).map(CLIENT_ROW),
        restrictedNote: rows.some(r => r.access === 'restricted') ? 'Some matching clients belong to other agents or the office — offer request_access with their ref.' : undefined };
    },

    async unonboarded_demand({ scope: sc } = {}) {
      const sc2 = sc === 'shoot' ? 'shoot' : 'unprocessed';
      const found = await runSearch({ db, user, body: { mode: 'demand', scope: sc2, limit: 12 }, viewer: await viewer(), data: await matchData() });
      const rows = found.rows || [];
      return { scope: sc2, total: (rows || []).length, properties: (rows || []).map(x => ({ property: x.property.name, source: x.property.sourceLabel, status: x.property.status, price: x.property.price || null, location: x.property.location || null,
        buyers: x.buyers, strong: x.strong, top: x.top.map(t => `${t.name} ${t.pct}%`), open: x.property.link && x.property.link.type !== 'restricted' ? `${x.property.link.type}:${x.property.link.id}` : null })) };
    },

    async structure_requirement({ lead_id, text } = {}) {
      const ls = await leads();
      const lead = ls.find(l => l.id === String(lead_id || ''));
      if (!lead) return { error: isAgent ? 'That lead is not yours' : 'No such lead' };
      const r = text ? await structureText(text) : await structureText([lead.propertyInterest, lead.budget, lead.tt && lead.tt.profile && lead.tt.profile.requirement_details, lead.tt && lead.tt.latestAsk, lead.lastNote && lead.lastNote.text].filter(Boolean).join('\n'));
      const items = r.ok && r.items.length ? r.items : PinMatch.requirementProfiles(lead, {}).map(globalThis.PinSources.itemFromProfile).map(globalThis.PinSources.cleanItem).filter(Boolean);
      if (!items.length) return { error: 'Nothing to read a requirement from yet' };
      const lines = items.map((it, i) => `#${i + 1}${it.status !== 'active' ? ' (' + it.status + ')' : ''}: ${PinMatch.reqSentence(it)}${it.uncertain && it.uncertain.length ? ' — check: ' + it.uncertain.join(', ') : ''}`);
      if (!r.ok) lines.push('(The AI was not available — this is the built-in reading.)');
      return propose('requirement', { leadId: lead.id, items, model: r.model || null }, `Save ${lead.name || 'this client'}'s requirement${items.length > 1 ? 's' : ''}?`, lines);
    },

    async request_access({ ref, reason, property_code } = {}) {
      if (!isAgent) return { error: 'Staff already see every client' };
      if (!ref) return { error: 'Which client? Use the ref from find_clients' };
      let propertyId = null;
      if (property_code) { const p = await findProperty(property_code); if (p && AA.roleOn(p, me)) propertyId = p.id; }
      return propose('access_request', { ref: String(ref).slice(0, 200), reason: String(reason || '').slice(0, 300), propertyId }, 'Ask for this client\'s details?', [`Request: a matching client's details${property_code ? ' for ' + property_code : ''}`, reason ? `Reason: ${reason}` : 'The approvers will see your request in Messages']);
    },

    async team_overview() {
      const cfg = await config();
      if (!TM.isManager(cfg, user.email)) return { error: 'Only the admin can see the team overview' };
      const [ls, st, tasks, drafts, changes, gaps] = await Promise.all([leads(), stages(), own('tasks'), own(C.drafts), own(C.changes), own(C.gaps)]);
      const weekAgo = now - 7 * 86400000;
      const team = new Set([...TM.managersOf(cfg), ...(cfg && Array.isArray(cfg.team) ? cfg.team : []), ...drafts.map(d => d.by), ...changes.map(c => c.by)].map(lc).filter(Boolean));
      const rows = [...team].map(email => {
        const plan = ED.buildDayPlan({ leads: ls, stages: st, tasks, gaps, drafts, email, now });
        const mine = drafts.filter(d => d.by === email && d.createdAt >= weekAgo);
        return {
          agent: email,
          visitsToday: plan.filter(p => p.kind === 'visit').length,
          followUpsToday: plan.filter(p => p.kind === 'follow_up').length,
          escalations: plan.filter(p => p.kind === 'escalation').length,
          messagesThisWeek: { drafted: mine.length, opened: mine.filter(d => d.status === 'opened').length, sent: mine.filter(d => d.status === 'sent').length },
          pendingChanges: changes.filter(c => c.by === email && c.status === 'pending').length
        };
      });
      return { agents: rows, openSellerAsks: gaps.filter(g => g.status === 'asked').map(g => `${g.code}: ${g.label}`) };
    }
  };
}

// ── Applying a confirmed change ──────────────────────────────────────────

async function audit(db, user, action, entity, before, after) {
  await db.collection(C.audit).doc().set({ tenantId: user.tenantId, at: Date.now(), actor: lc(user.email), action, entity, before: before || null, after: after || null, source: 'easy' });
}

async function applyChange(db, user, change) {
  const T = user.tenantId, now = Date.now(), who = lc(user.email);
  const p = change.payload || {};
  if (change.kind === 'property_add') {
    forget('props', T);
    const list = await loadProps(db, T);
    if (list.some(x => codeKey(x.propertyCode) === codeKey(p.code))) return { error: `${p.code} already exists — ask again to get the next free code` };
    const data = { ...p.fields, tenantId: T, propertyCode: p.code, listingStatus: 'draft', addedBy: who, addedVia: 'easy', createdAt: now, updatedAt: now, updatedBy: who };
    await db.collection('properties').doc(p.code).set(data);
    await audit(db, user, 'property_add', { type: 'property', id: p.code }, null, data);
    return { done: `Added ${p.code} as a draft listing` };
  }
  if (change.kind === 'property_update') {
    const ref = db.collection('properties').doc(p.propertyId);
    const snap = await ref.get();
    if (!snap.exists || snap.data().tenantId !== T) return { error: 'That property is gone' };
    const before = Object.fromEntries(Object.keys(p.changes).map(k => [k, snap.data()[k] == null ? null : snap.data()[k]]));
    await ref.set({ ...p.changes, updatedAt: now, updatedBy: who }, { merge: true });
    await audit(db, user, 'property_update', { type: 'property', id: p.propertyId }, before, p.changes);
    return { done: `Updated ${p.code}` };
  }
  if (change.kind === 'requirement') {
    const ref = db.collection('leads').doc(String(p.leadId || ''));
    const snap = await ref.get();
    if (!snap.exists || snap.data().tenantId !== T) return { error: 'That lead is gone' };
    const items = (p.items || []).map(globalThis.PinSources.cleanItem).filter(Boolean);
    const lead = snap.data();
    if (user.role === 'agent' && !AA.leadVisibleTo(lead, who)) return { error: 'That lead is not yours' };
    const rev = ((lead.reqs && lead.reqs.rev) || 0) + 1;
    const reqs = items.length ? { items, src: 'reviewed', at: now, by: who, rev, fp: PinMatch.reqFingerprint(lead), aiModel: p.model || null } : null;
    await writeLead(db, T, ref, { reqs }, 'update');
    await ref.collection('reqRevisions').doc('r' + String(rev).padStart(4, '0') + '_' + now).set({ at: now, by: who, src: 'reviewed', via: 'easy', rev, items, was: (lead.reqs && lead.reqs.items) || null });
    await audit(db, user, 'requirement', { type: 'lead', id: snap.id }, lead.reqs || null, reqs);
    return { done: `Saved ${items.length} requirement${items.length === 1 ? '' : 's'} for ${lead.name || 'the client'}` };
  }
  if (change.kind === 'access_request') {
    const res = await workPost(user, 'request', { kind: 'lead', ref: p.ref, reason: p.reason || '', propertyId: p.propertyId || undefined }, false);
    const j = await res.json().catch(() => ({}));
    if (!j.ok) return { error: j.error || 'The request could not be sent' };
    return { done: 'Request sent — you will see the answer in Messages' };
  }
  if (change.kind === 'note') {
    const done = [];
    if (p.leadId) {
      const ref = db.collection('leads').doc(p.leadId);
      const snap = await ref.get();
      if (!snap.exists || snap.data().tenantId !== T) return { error: 'That lead is gone' };
      const id = 'n' + now;
      await ref.collection('notes').doc(id).set({ id, text: (p.call ? '📞 Call notes: ' : '') + p.text, createdAt: now, by: who, source: 'easy' });
      // A note is the team touching the lead (it clears "needs a person"), as a note typed in the CRM does.
      await writeLead(db, T, ref, { updatedAt: now, ...(p.followUpAt ? { followUpAt: p.followUpAt } : {}) }, 'update');
      done.push(`note on ${snap.data().name || 'the lead'}`);
      if (p.followUpAt) done.push(`follow-up ${istDate(p.followUpAt)}`);
    }
    if (p.propertyId) {
      const id = 'n' + now + 'e';
      await db.collection('properties').doc(p.propertyId).collection('notes').doc(id)
        .set({ id, text: p.propertyText, kind: 'note', eventDate: '', createdAt: now, author: who, source: 'easy', leadId: p.leadId || null });
      done.push(`feedback on ${p.code}`);
    }
    await audit(db, user, p.call ? 'call_notes' : 'note', { type: p.leadId ? 'lead' : 'property', id: p.leadId || p.propertyId }, null, p);
    return { done: 'Saved ' + done.join(', ') };
  }
  return { error: 'Unknown change' };
}

// ── Requests ──────────────────────────────────────────────────────────────

// The page sends the conversation as plain text turns; only the last few are kept.
function cleanHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role, content: m.text.slice(0, 4000) }));
}

async function owned(db, user, coll, id) {
  const ref = db.collection(coll).doc(String(id || ''));
  const snap = await ref.get();
  return snap.exists && snap.data().tenantId === user.tenantId ? { ref, data: snap.data() } : null;
}

/**
 * One Eåsy request, given the database, the signed-in user and the body. Returns [object, status].
 * Within the day's read budget, it runs (counted); past it, Eåsy rests. A database that has run out
 * of its quota is said so plainly, with the time it comes back.
 */
export async function easyHandle({ db, user, body, now = Date.now() }) {
  body = body || {};
  // On or off for the whole team — the admin's switch (no deploy), off until an admin turns it on.
  // Off: nothing else runs, and the page shows no button; an admin turns it on from the ⋮ menu.
  let cfg, admin;
  try { [cfg, admin] = await Promise.all([loadConfig(db, user.tenantId), loadTeam(db, user.tenantId).then(t => TM.isManager(t, user.email))]); }
  catch (e) { if (isQuotaError(e)) return quotaAnswer(now); throw e; }
  if (body.action === 'switch') {
    if (!admin) return [{ error: 'Only an admin can switch Eåsy on or off' }, 403];
    const off = !body.on;
    await db.collection(C.config).doc(user.tenantId).set({ on: !off, off, by: lc(user.email), at: now }, { merge: true });
    forget('config', user.tenantId);
    return [{ ok: true, off, admin }, 200];
  }
  if (body.action === 'ping') return [{ enabled: isOn(cfg), off: !isOn(cfg), admin }, 200];
  if (!isOn(cfg)) return [{ disabled: true, off: true, error: 'Eåsy is switched off by the admin' }, 503];
  const day = quotaDay(now);
  const meterRef = db.collection(C.meter).doc(`${user.tenantId}_${day}`);
  let used = 0;
  try { const m = await meterRef.get(); used = m.exists ? Number(m.data().reads) || 0 : 0; }
  catch (e) { if (isQuotaError(e)) return quotaAnswer(now); throw e; }
  const cap = EASY_DAILY_READS();
  if (used >= cap && !['draft', 'confirm'].includes(body.action)) {
    const back = resetTimeIST(now);
    if (body.action === 'schedule') return [{ schedule: [], at: now, paused: true }, 200];
    if (body.action === 'reminders') return [{ reminders: [], at: now, paused: true }, 200];
    if (body.action === 'leads') return [{ leads: [], paused: true }, 200];
    return [{ paused: true, drafts: [], changes: [], links: [], plan: null,
      reply: `I've used today's share of database reads, so I'm resting to keep the CRM running for everyone. I'll be back after ${back}. Everything else in the CRM works as usual.` }, 200];
  }
  const counter = { n: 1 };          // the meter read itself
  let res;
  try { res = await handle({ db: metered(db, counter), user, body, now }); }
  catch (e) { if (isQuotaError(e)) return quotaAnswer(now); throw e; }
  // One write a request; a lost update under a race only makes the count a little low.
  await meterRef.set({ tenantId: user.tenantId, day, reads: used + counter.n, updatedAt: now }, { merge: true }).catch(() => {});
  return res;
}

async function handle({ db, user, body, now }) {

  // The Log call picker on pages other than the CRM (which has every lead on the page already).
  if (body.action === 'leads') {
    let ls = await loadLeads(db, user.tenantId);
    if (user.role === 'agent') ls = ls.filter(l => AA.leadVisibleTo(l, user.email));
    return [{ leads: ls.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 200).map(l => ({ id: l.id, name: l.name || null, phone: l.phone || null, updatedAt: l.updatedAt || 0 })) }, 200];
  }

  // "Sent?" — the agent's answer after Send opened their WhatsApp (MVP-08). Eåsy can't see the send.
  if (body.action === 'draft') {
    const d = await owned(db, user, C.drafts, body.draftId);
    if (!d) return [{ error: 'No such draft' }, 404];
    const status = ['sent', 'opened'].includes(body.status) ? body.status : 'discarded';
    const patch = { status, [status + 'At']: Date.now() };
    if (typeof body.text === 'string' && body.text.trim()) patch.text = body.text.trim().slice(0, MAX_DRAFT);
    await d.ref.set(patch, { merge: true });
    if (status === 'sent' && d.data.gaps) {
      // The owner was asked: the gaps stay "asked" — sent is when the clock for the 7-day chase starts.
      const gs = await db.collection(C.gaps).where('draftId', '==', d.ref.id).get();
      await Promise.all(gs.docs.map(g => g.ref.set({ askedAt: Date.now() }, { merge: true })));
    }
    return [{ ok: true, status }, 200];
  }

  // Yes / No on a prepared change.
  if (body.action === 'confirm') {
    const c = await owned(db, user, C.changes, body.changeId);
    if (!c) return [{ error: 'No such change' }, 404];
    if (c.data.status !== 'pending') return [{ error: `Already ${c.data.status}` }, 409];
    if (lc(c.data.by) !== lc(user.email)) return [{ error: 'Only the person who asked can confirm this' }, 403];
    if (!body.yes) { await c.ref.set({ status: 'declined', decidedAt: Date.now() }, { merge: true }); return [{ ok: true, status: 'declined' }, 200]; }
    const r = await applyChange(db, user, c.data);
    forget(null, user.tenantId);    // what it changed is read fresh next time
    await c.ref.set({ status: r.error ? 'failed' : 'applied', decidedAt: Date.now(), result: r.error || r.done }, { merge: true });
    return [r.error ? { error: r.error } : { ok: true, status: 'applied', done: r.done }, r.error ? 409 : 200];
  }

  // Reminders the page polls for (MVP-11 visit, MVP-12 follow-up, MVP-13 gist).
  // The hours ahead (MVP-11/12/13): the page asks a few times a day and times each reminder itself.
  // 'reminders' — what is due right now — is the older page's every-minute ask, kept cheap for it.
  if (body.action === 'schedule' || body.action === 'reminders') {
    const T = user.tenantId;
    const horizon = 16 * HOUR_MS;
    const [ls, st, ps] = await Promise.all([
      loadLeads(db, T), loadStages(db, T),
      // Only the properties of visits coming up (the reminder and the gist name them): one read
      // each — by document id, else by code — not the whole inventory.
      loadLeads(db, T).then(async ls => {
        const refs = [...new Set(ls.map(l => visitOf(l)).filter(v => v.at && v.property && v.at > now - HOUR_MS && v.at < now + horizon).map(v => String(v.property)))];
        const found = await Promise.all(refs.slice(0, 10).map(async ref => {
          try {
            const byId = await db.collection('properties').doc(ref).get();
            if (byId.exists && byId.data().tenantId === T) return { ...byId.data(), id: byId.id };
            const q = await db.collection('properties').where('tenantId', '==', T).where('propertyCode', '==', ref.toUpperCase().replace(/\s+/g, '')).limit(1).get();
            return q.docs[0] ? { ...q.docs[0].data(), id: q.docs[0].id } : null;
          } catch (e) { return null; }      // the reminder still goes, without the property's facts
        }));
        return found.filter(Boolean);
      })
    ]);
    const mine = user.role === 'agent' ? ls.filter(l => AA.leadVisibleTo(l, user.email)) : ls;
    const all = ED.scheduleFor({ leads: mine, stages: st, properties: ps, email: user.email, now, horizonMs: horizon });
    const list = body.action === 'schedule' ? all : ED.dueNow(all, now);
    // The gist carries the lead's last notes (two reads per visit — a handful a day).
    await Promise.all(list.filter(r => r.kind === 'gist').map(async r => {
      const notes = await db.collection('leads').doc(r.leadId).collection('notes').orderBy('createdAt', 'desc').limit(2).get().then(s => s.docs.map(d => d.data())).catch(() => []);
      r.gist.lead.lastNotes = notes.map(n => n.text);
    }));
    return [body.action === 'schedule' ? { schedule: list, at: now } : { reminders: list, at: now }, 200];
  }

  const messages = cleanHistory(body.history);
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') return [{ error: 'Ask something first' }, 400];

  const out = { drafts: [], changes: [], links: [], plan: null };
  const tools = makeTools(db, user, now, out);
  const done = reply => [{ reply, drafts: out.drafts, changes: out.changes, links: out.links, plan: out.plan }, 200];
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await getAnthropic().messages.create({
        model: EASY_MODEL,
        max_tokens: 8000,
        output_config: { effort: 'low' },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }, { type: 'text', text: `Now: ${istNow(now)} (IST). Asked by ${user.email}.` + (user.role === 'agent' ? ' This person is an AGENT: the tools already show only their own leads and properties in full; everything else comes back as a summary or a restricted match. Never try to work around that — offer request_access instead.' : '') + (body.voice
          ? ' This question was spoken and your answer will be read aloud: start with one or two short sentences that make sense heard, in the language of the question (Tamil if it was Tamil). Speech recognition may have misheard a name or number — if one does not match a record, ask instead of guessing.'
          : '') }],
        tools: TOOLS,
        messages
      });
      if (response.stop_reason === 'refusal') return done("I can't help with that one.");
      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason !== 'tool_use') {
        const reply = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
        return done(reply || (out.drafts.length || out.changes.length ? 'Ready — check the card below.' : 'I could not find an answer to that.'));
      }
      const results = await Promise.all(response.content.filter(b => b.type === 'tool_use').map(async b => {
        try {
          const fn = tools[b.name];
          if (!fn) throw new Error('Unknown tool');
          return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(await fn(b.input || {})) };
        } catch (e) {
          if (isQuotaError(e)) throw e;
          console.error('easy: tool failed', b.name, e);
          return { type: 'tool_result', tool_use_id: b.id, content: 'That lookup failed: ' + (e.message || 'error'), is_error: true };
        }
      }));
      messages.push({ role: 'user', content: results });
    }
    return done('That took too many steps — try asking it in a simpler way.');
  } catch (e) {
    if (isQuotaError(e)) throw e;
    console.error('easy: failed', e);
    const status = e instanceof Anthropic.RateLimitError ? 429 : 502;
    return [{ error: status === 429 ? 'Eåsy is busy — try again in a minute' : 'Eåsy could not answer just now' }, status];
  }
}

export async function easyPost(request) {
  if (!easyEnabled()) return json({ disabled: true, error: 'Eåsy is switched off' }, 503);
  // Agents too (Nov 2026): every tool scopes itself to what the agent layer lets them see — their own
  // leads, other properties as summaries, other agents' clients only as requestable matches.
  const user = await verifyCrmUser(request, { allowAgent: true });
  if (!user || !user.tenantId) return json({ error: 'Unauthorized' }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  relabel('easy:' + (body && body.action || 'ask'));
  const [o, status] = await easyHandle({ db: getDb(), user, body });
  return json(o, status);
}
